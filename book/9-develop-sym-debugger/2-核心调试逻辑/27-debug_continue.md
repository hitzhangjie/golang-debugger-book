## continue：运行到下一个断点

第 6 章 6.13 已经用 `ptrace(PTRACE_CONT, ...)` 实现了指令级的 continue。到了符号级调试器，continue 的底层动作没有变，但"停在哪里"从"某个地址"变成了"某个源码位置"，还要处理多线程的 all-stop、命中后的 PC 回退与断点重装。

> ps：本书早期稿件曾以 tinydbg 为示例，自本节起统一以 godbgv2 项目的 `godbg` 二进制为准。

### 实现目标

`godbg> continue`（别名 `c`）的目标是：从当前停止位置恢复目标进程执行，直到下一次需要用户观察的事件发生——命中用户断点、命中硬件监视点、进程退出，或者收到需要上抛的信号。

符号级会话给 continue 增加了三点要求：

- 停止后要能展示源码位置（`file:line`），而不只是 `stopped: trace/breakpoint trap`；
- 命中断点后再次 `continue` 时，要先越过断点处的 `int3`，否则断点地址处的原指令永远不会被执行；
- Go 程序是多线程的，continue 必须遵循 all-stop 语义：恢复时全部线程一起跑，任一线程停下后其余线程也要停下。

源码级单步（`next`）不在 continue 的职责内：continue 只负责"跑到下一个停止"，不负责计算"下一行停在哪里"，后者见 9.2.28。

### 基础知识

软件断点把目标地址处的指令首字节替换为 `0xCC`（`int3`）。执行到该地址时 CPU 触发 #BP 异常，内核向 tracee 投递 `SIGTRAP` 并暂停它，tracer 的 `wait4` 随之返回。此时寄存器里的 PC 已经是断点地址加 1，而不是断点地址本身——这是 continue 里所有 PC 修正的来源。

多线程是真正的难点。Go 运行时会在调试期间不断创建线程（GC worker、sysmon 等），如果只恢复主线程，其余线程仍停着，目标进程很容易卡死。godbgv2 采用 all-stop：`Continue` 先恢复全部线程，等任一事件停止后，再用 `SIGSTOP` 把其余线程逐个挂起。挂起不用 `PTRACE_SINGLESTEP`——对阻塞在 futex 里的线程，单步陷阱可能迟迟不触发，会把整个挂起流程拖住（`pkg/target/suspend.go` 的注释记录了这一点）。

挂起用的 `tgkill(SIGSTOP)` 会带来一个新问题：调试器自己发的 `SIGSTOP` 与外部投递的 `SIGSTOP`、内核给新线程的初始 `SIGSTOP` 混在同一个等待队列里。continue 必须能区分它们，否则要么吞掉用户真正关心的停止事件，要么把自身的挂起信号当成程序异常上抛。

### 代码实现

#### 1. 命令层：先越过断点，再继续

`cmd/debug/continue.go` 的 `RunE` 只做两段编排（节选）：

```go
// 检查是否有线程停在断点处（多线程，ch6.18.5）
bpStoppedThreads, err := Client.ThreadsStoppedAtBreakpoint()
if err != nil {
    return fmt.Errorf("check thread breakpoints error: %v", err)
}
// 有线程停在断点处：先越过断点
if len(bpStoppedThreads) > 0 {
    if err := passOverBreakpoints(bpStoppedThreads); err != nil {
        return err
    }
}
// 恢复所有线程执行
if err := continueRun(); err != nil {
    return err
}
```

`passOverBreakpoints` 对每个停在断点处的线程依次做四步：`ReadRegs` 读出寄存器并把 PC 回退到 `PC-1`，`WriteRegs` 写回；用 `RestoreInstruction(bpAddr)` 还原该地址的原始指令（同一个断点地址只还原一次，因为多个线程可能停在同一处）；`Client.Step(tid)` 单步执行这条原指令；最后用 `Client.AddBreakpoint(bpAddr)` 立即把断点打回去。

`continueRun` 则是一个循环：调用 `Client.Continue()`；若停在条件断点且条件不满足、或停在跟踪点上，就再越过一次继续跑（`checkAutoResume`，对应 9.2.23 与 9.2.25）；否则打印停止原因、用 `printLocation` 展示源码位置，并输出 `stop all threads now`。

#### 2. target 层：all-stop 与信号判别

`pkg/target/continue.go` 的 `Continue` 先对 `p.Threads` 里的每个线程发起 `PTRACE_CONT`（对已退出线程容忍 `ESRCH`），再用 `waitAny` 等待任意线程停止。中间会滤掉若干"内部事件"：`PTRACE_EVENT_CLONE` 读取新线程 tid、加入线程表、恢复克隆者并消费新线程的初始 `SIGSTOP`；`PTRACE_EVENT_EXEC` 直接放行；`PTRACE_EVENT_FORK`/`VFORK` 则挂起其余线程后作为停止原因上报。

真正决定"这是不是一次该上报的停止"的，是对停止信号的 siginfo 判别。`Continue` 调用 `stopSiginfo`，经 `PTRACE_GETSIGINFO` 读取 `si_pid` 与 `si_code`，再分三种情况处理：`SIGURG` 是 Go 运行时用于异步抢占的信号，必须原样转发（`resumeSig` 传给下一次 `PTRACE_CONT`）；`si_pid` 是调试器自身且 `si_code == SI_TKILL` 的 `SIGSTOP` 来自 `suspendOtherThreads`，`si_pid == 0` 的来自内核，两者都丢弃；其余（如外部 `kill -STOP`）才算真实停止事件。命中硬件监视点时另有 `TriggeredWatchpoint` 分支（9.2.26）。

滤完内部事件后，`suspendOtherThreads(wpid)` 挂起其余线程，记录当前线程与 `descStatus(status)`，返回 `api.StopInfo`。注意 `Continue` 本身不修改 PC：命中后 PC 仍是断点地址加 1，修正发生在下一条执行控制命令的开头。

#### 3. 命中之后：PC-1 修正与断点重装

`ThreadsStoppedAtBreakpoint` 按 `PC-1` 是否落在断点表里判断"线程停在断点处"，`printLocation` 先按 PC、再按 `PC-1` 查询 `PCToLine`，两者都体现了"int3 已执行"这一事实。

断点重装还有一层容易忽略的细节：`Client.RestoreInstruction` 只摘除 target 层的物理断点记录，`proc` 层的逻辑断点仍然保留；随后的 `Client.AddBreakpoint` 走 `pkg/proc/breakpoints.go` 的 `createBreakpoint`，发现逻辑断点还在，就只重建物理补丁、复用原逻辑编号。因此名称、条件、命中计数不会因为一次"还原→重装"而丢失。

### 执行测试

测试对象是 `_fixtures/loop`，用固定工具链构建（`-N -l`，非 PIE），`main.main` 在 `0x4b3940`，循环体首行 `main.go:16` 在 `0x4b3971`。下面用 `--init` 批量回放（`init.txt` 为脚本占位名），输出与交互模式一致；源码绝对路径前缀用 `<src>/` 代替：

```bash
$ ./godbg exec _fixtures/loop --init init.txt
process 1907320 launched, stopped by SIGTRAP
godbg> break main.go:16
breakpoint 1 added at 0x4b3971 (<src>/main.go:16)
godbg> continue
thread 1907320 status: stopped: trace/breakpoint trap
> <src>/main.go:16 (pc: 0x4b3972)
stop all threads now
continue ok
godbg> continue
pid: 1907320, loop: 0
thread 1907320 stopped at breakpoint 0x4b3971
restored breakpoint at 0x4b3971
thread 1907320 status: stopped: trace/breakpoint trap
> <src>/main.go:16 (pc: 0x4b3972)
stop all threads now
continue ok
```

第一次 continue 从程序入口直接跑到循环体 `0x4b3971`，命中 `int3` 后停住：输出 `stopped: trace/breakpoint trap`，`printLocation` 展示 `main.go:16`，`pc: 0x4b3972` 正是断点地址加 1。

第二次 continue 的处理顺序很关键：先打印 `stopped at breakpoint 0x4b3971`（说明该线程 PC-1 命中），再 `restored breakpoint`（单步越过后断点已重新装上），然后才真正继续。目标程序打印 `loop: 0` 后回到循环体，再次命中同一个断点。若第三次 continue，会重复同样的过程，这说明断点确实在恢复执行前写回了。

本例只有 4 个线程（`main.main` 所在线程加 3 个 runtime 线程）。对全部线程执行 `threads` 可以看到：命中时只有一个线程带 `*` 标记停在 `main.main`，其余线程分别停在 `runtime.usleep`、`runtime.futex`，它们是被 `suspendOtherThreads` 挂起的——这就是 all-stop 的可观察形态。

### 本节小结

continue 在符号级调试器里并不是"恢复执行"一个动作，而是三件事的组合：命令层负责在继续之前越过当前断点（PC 回退、还原指令、单步、重装断点），并把条件断点/跟踪点的自动续跑串起来；target 层负责 all-stop 恢复、用 siginfo 区分自身 `SIGSTOP` 与外部信号、转发 `SIGURG`，并在任意线程停止后挂起其余线程；停止之后再由上层把地址翻译成源码位置。

`next` 尚未实现，continue 只提供"跑到下一个停止"这个原语，源码级单步要在这个原语之上另行计算停点，见 9.2.28。
