## threads / thread：线程级调试

[9.2.40 goroutine 逻辑切换与多线程调试](100-multi-threads.md) 讲的是"当前线程在跑哪个 goroutine、怎样按 goid 选中它"。本节把另一半补上：线程本身也应当是一个可以直接观察、直接选中的对象。`threads` 列出调试器跟踪到的全部 OS 线程及各自的停止位置，`thread <id>` 把后续的寄存器读取切到某个线程，`thread -r` 复位。两个命令一读一写，合计不到 130 行，但它们是观察 goroutine 视角盲区的唯一入口。

线程的创建、挂起与恢复在执行控制层面已经由第 6 章 [6.18 调试多线程程序](../../6-develop-inst-debugger/18-multithread/README.md) 完成（clone 事件的自动跟踪见 [12.2 自动跟踪新线程](../../12-appendix/2-auto-trace-cloned-threads.md)）。本节不重复那些机制，只讨论"看线程"和"选线程"。

### 实现目标

```text
godbg> threads
* Thread 2155525 at 0x4b1b87 main.main …/examples/debuggee/vars/main.go:28
  Thread 2155531 at 0x478097 runtime.usleep …/src/runtime/sys_linux_amd64.s:135
  Thread 2155532 at 0x478663 runtime.futex …/src/runtime/sys_linux_amd64.s:558
  Thread 2155533 at 0x4b1e06 main.spinner …/examples/debuggee/vars/main.go:47
godbg> thread 2155531
switched to thread 2155531 at 0x478097 runtime.usleep
godbg> thread -r
reset to goroutine view
```

`threads` 的输出每行是一个线程：`Thread <tid> at <pc> <函数> <文件>:<行>`，行首 `*` 标记**当前事件线程**（最近一次停下来、引发本次停止的那个线程）。它除了按 tid 升序排列之外不做任何过滤——运行时线程、用户线程、空闲的 M 全在列表里。

`thread`（别名 `tr`）的参数是 Linux 的线程 id（tid），不是列表序号。主线程的 tid 等于进程 pid，其余线程的 tid 由内核分配、每次运行都不同，所以脚本里不能写死，要像本节测试那样先 `threads` 再取。`thread` 没有参数补全，也没有按名字选线程的写法。

`thread -r` 复位线程选择："恢复 goroutine 视角"——更准确地说，是让后续读取重新按 [9.2.40](100-multi-threads.md) 的规则走：`selGoroutine` 还在就用它，没有就回落到当前事件线程。复位本身幂等，没有选中线程时执行也打印 `reset to goroutine view`。

选中线程改变的是**读取上下文**：`bt`、无参 `list`、`print` 改用该线程的寄存器与栈。它不改变执行控制——`continue`/`stepout` 仍恢复全部线程，`step` 仍只推进事件线程，且都以事件线程为默认对象；也不改变 `*` 的含义。这一点在代码实现里能看到明确的分界。

### 基础知识

#### goroutine 视角补不齐的三类场景

goroutine 是 Go 的并发单位，但它总要挂在某个 OS 线程（M）上跑。`goroutines` 读的是 `runtime.allgs`，列出来的是 g 而不是线程；跑 g0 的 M 没有对应的 g，因此不会出现在列表里。下面三类活动没有对应的 g：

- **sysmon**：运行时监控线程在独立的 M 上循环，跑在 g0 上，`allgs` 里没有它的条目。本节实测的 2155531 停在 `runtime.usleep`，`bt` 给出 `usleep → sysmon → mstart1 → mstart0 → mstart → clone` 六帧，这条链在 `goroutines` 列表里一项都找不到。
- **syscall 阻塞点**：goroutine 进入系统调用后处于 `_Gsyscall`，它的用户栈停在 `syscall.Syscall` 一类包装上；真正卡住的地方（`futex`、`epoll_wait`）在线程的 PC 上。想知道"到底谁堵住了"，得看线程。
- **cgo 调用**：执行期间 CPU 在 C 栈上，goroutine 的 Go 栈只留下调用点。线程视角至少能看到线程停在哪条指令；C 帧能否符号化取决于二进制里有没有对应的调试信息，godbgv2 不额外承诺。

除此之外，g0/m0 栈、信号处理、运行时为新 M 准备的 `mstart` 也都在线程视角下才可见。线程视角不是"更底层所以更好"：它不显示 goid、不显示调度状态，也不能按 goroutine 切换上下文，两者是互补关系。

#### 线程表从哪里来

目标层的 `DebuggedProcess.Threads` 是一个 `map[int]*Thread`（`pkg/target/process.go:24`），键是 tid，值记录 tid、所属进程和最近一次停止原因。会话建立时表里只保证有主线程：exec 路径由 `PTRACE_O_TRACECLONE` 把后续 clone 出的线程逐个送进 `addThread`；attach 路径额外用 `/proc/<pid>/task` 枚举已有线程（`pkg/target/thread.go` 的 `updateThreadList`），主线程之外的线程先 `PTRACE_ATTACH` 再等它停下。两条路最终落到同一个线程表。

`currentThread` 是最近一次停止的线程（`process.go:25`），`*` 就是拿它比对出来的。调试器处于 all-stop：任何命令执行时全部线程都停在断点或信号处，因此任意线程的寄存器都能安全读取——`proc.Thread.Registers` 的注释专门交代了这个前提。

#### 两个选择状态与优先级

`Target` 上并存两个选择状态：`selGoroutine`（9.2.40）与 `selThread`（本节，`pkg/proc/target.go:18`、`:19`）。`Registers()` 的优先级是**线程 > goroutine > 当前事件线程**：

1. `selThread` 非空：直接 `ReadRegister(selThread.Tid)`；
2. 否则 `selGoroutine` 非空：运行中的 g 经 `g.m→m.procid` 找线程读真实寄存器，挂起的 g 用 `g.sched` 合成；
3. 都没选：读当前事件线程。

这条语义与 delve 一致：选中后重定向寄存器上下文，线程选择优先于 goroutine 选择；`godbgv2/docs/CLEANROOM.md` 的"goroutine/thread 逻辑切换"条目已归因。两个使用上的坑随之而来：先 `thread <tid>` 再 `goroutine <id>`，`bt` 仍走线程（`SelectGoroutine` 不清 `selThread`）；而 `thread -r` 之后 `selGoroutine` 还在，视角回到先前选中的 g，而不是事件线程。

还有一个可见性缺口：`*` 标的是事件线程，不是选中的线程。选中 2155531 之后再次 `threads`，`*` 仍在 2155525，列表里没有任何"当前选中"的标记。

### 代码实现

```text
godbg> threads
 └─ cmd/debug/threads.go:31                             命令层：遍历 Client.Threads()
     └─ pkg/service/api/client.go:51 → pkg/service/debugger/debugger.go:611   契约 → 门面
         └─ pkg/proc/threads.go:32                        Target.Threads：按 tid 升序
             └─ pkg/proc/threads.go:27                    Thread.Registers：ReadRegister

godbg> thread <id>
 └─ cmd/debug/thread.go:38                               命令层：Client.SwitchThread
     └─ pkg/service/api/client.go:55 → pkg/service/debugger/debugger.go:645   契约 → 门面
         └─ pkg/proc/threads.go:55                        SelectThread：校验 tid 后写 selThread

godbg> thread -r
 └─ cmd/debug/thread.go:39                               Client.SwitchThread(-1)
     └─ pkg/service/debugger/debugger.go:649              tid<0：ResetThread
         └─ pkg/proc/threads.go:65                        selThread = nil
```

#### 命令层

`threads` 只做格式化（`cmd/debug/threads.go:31`，省略错误处理）：

```go
ths, err := Client.Threads()
for _, th := range ths {
    marker := " "
    if th.Current {
        marker = "*"
    }
    if th.Function != "" {
        fmt.Printf("%s Thread %d at %#x %s %s:%d\n",
            marker, th.Tid, th.PC, th.Function, th.File, th.Line)
    } else {
        fmt.Printf("%s Thread %d at %#x\n", marker, th.Tid, th.PC)
    }
}
```

函数名或源码位置解析失败时退化成只打 tid 和 PC，不会因为一个线程查不到符号就丢掉整张表。`Aliases: []string{"threads"}` 是自别名，没有实际作用（已知问题，见后文）。

`thread` 手动解析参数（`cmd/debug/thread.go:34` 起，省略错误处理）：

```go
// -r 是复位子命令形态而非 flag，故 DisableFlagParsing
if len(args) == 1 && args[0] == "-r" {
    if _, err := Client.SwitchThread(-1); err != nil {
        return err
    }
    fmt.Println("reset to goroutine view")
    return nil
}
if len(args) != 1 {
    return fmt.Errorf("usage: thread <id> | thread -r")
}
tid, err := strconv.Atoi(args[0])
if err != nil {
    return fmt.Errorf("invalid thread id %q", args[0])
}
th, err := Client.SwitchThread(tid)
if err != nil {
    return err
}
fmt.Printf("switched to thread %d at %#x %s\n", th.Tid, th.PC, th.Function)
```

`DisableFlagParsing: true` 是为了让 `-r` 作为普通参数传进来，而不是被 pflag 当成未知 flag。代价是 `thread -h` 也会走 `Atoi("-h")` 报错，查帮助要用 `help thread`。

#### api 契约与 debugger 门面

契约在 `pkg/service/api/client.go:50`：

```go
// Threads 返回跟踪到的全部线程（tid、停止位置）（ch9.2.41）
Threads() ([]Thread, error)
// SwitchThread 切换调试上下文到线程 tid（ch9.2.41）；tid<0 复位
SwitchThread(tid int) (*Thread, error)
```

复位没有单独的方法，用 `tid < 0` 编码，因为命令行只有一个 `thread` 命令、`-r` 是它的参数形态；到 RPC 层则变成 `Debugger.SwitchThread` 消息里的 `Tid: -1`（`pkg/service/rpc2/server.go:279`）。返回类型 `api.Thread` 有 `Tid/PC/Function/File/Line/Current` 六个字段（`pkg/service/api/types.go` 的 `Thread`）。

门面 `Debugger.Threads`（`debugger.go:611`）先取 `CurrentThread` 作为基准，再逐个读寄存器：`PC` 取 `regs.Rip`，`Function` 用 `FuncForPC(regs.Rip)` 反查，`File/Line` 用 `PCToLine(regs.Rip)` 解析，`Current` 由 `th.Tid == cur.Tid` 得出。注意列表里的 PC 是**真实 RIP**：断点命中时它是断点地址 + 1（本例 0x4b1b87），不是断点地址 0x4b1b86；`PCToLine` 对 +1 的 PC 仍能落回同一行。

`SwitchThread`（`debugger.go:645`）分两段：`tid < 0` 调 `ResetThread()` 并返回 `nil`；否则先 `SelectThread(tid)` 把选择写进 proc 层，再从线程表里找到该 tid、读寄存器、组装 `api.Thread` 返回。若 `SelectThread` 校验失败，返回 `thread <tid> not found`；若选择已写入但读寄存器失败，命令报错而选择状态保留——这是一个小的不一致，正常 all-stop 下不会遇到。

传输层不特殊：本地会话也走进程内 RPC（9.2.16），所以 `threads`/`thread` 和别的命令一样经过 `Debugger.Threads`/`Debugger.SwitchThread` 两个 RPC 方法，而不是命令层直接摸 proc 层。

#### proc 层：线程视图与选择

符号层的 `Thread` 只有两个字段（`pkg/proc/threads.go:18`）：tid 和指向目标层 `DebuggedProcess` 的指针。`Registers()` 转手调用 `dbp.ReadRegister(tid)`，不缓存。`Target.Threads()` 从目标层的 map 里取出全部 tid，排序后包成 `[]*Thread`（`threads.go:32`）；`CurrentThread()` 取 `CurrentThreadTid()` 包一个 `Thread`（`:42`）；`SelectThread` 先查 `t.dbp.Threads[tid]` 是否存在，存在才写 `selThread`（`:55`）；`ResetThread` 只做 `selThread = nil`（`:65`）。

`Target.Registers()` 里新增的只有最前面三行（`pkg/proc/goroutines.go:300`）：

```go
func (t *Target) Registers() (*syscall.PtraceRegs, error) {
    if t.selThread != nil {
        return t.dbp.ReadRegister(t.selThread.Tid)
    }
    // 其次是 selGoroutine（9.2.40），最后回落到事件线程
```

#### 选择状态影响谁

走 `Registers()` 的命令都跟着线程选择走：`Backtrace` 用它取起始 PC/RSP（`pkg/proc/backtrace.go:35`），变量求值的 `EvalVariableAddr` 用它定位局部变量（`pkg/proc/variables.go:75`），`list` 无参时也用它（`debugger.ListSource`）。不走它的是两类：`pregs` 固定读 `CurrentThread()` 再 `ReadRegs(tid)`（`cmd/debug/pregs.go:20`），`step`/`continue` 等执行控制也按事件线程的 tid 操作。所以"选线程"只换观察视角，不换驱动对象——这与 9.2.40 对 goroutine 选择的定性是同一句话。

### 执行测试

测试对象是 `_fixtures/vars`，断在 `main.go:28`。启动、断点命中与 continue 的回显与前几节相同，下面从 `threads` 开始；源码与模块路径前缀统一用 `…/` 代替：

```bash
godbg> threads
* Thread 2155525 at 0x4b1b87 main.main …/examples/debuggee/vars/main.go:28
  Thread 2155531 at 0x478097 runtime.usleep …/src/runtime/sys_linux_amd64.s:135
  Thread 2155532 at 0x478663 runtime.futex …/src/runtime/sys_linux_amd64.s:558
  Thread 2155533 at 0x4b1e06 main.spinner …/examples/debuggee/vars/main.go:47
godbg> thread 2155531
switched to thread 2155531 at 0x478097 runtime.usleep
godbg> bt
0: runtime.usleep() …/src/runtime/sys_linux_amd64.s:135 (pc: 0x478097)
1: runtime.sysmon() …/src/runtime/proc.go:6168 (pc: 0x44c0b7)
2: runtime.mstart1() …/src/runtime/proc.go:1887 (pc: 0x443bcd)
3: runtime.mstart0() …/src/runtime/proc.go:1843 (pc: 0x443b05)
4: runtime.mstart() …/src/runtime/asm_amd64.s:396 (pc: 0x474965)
5: runtime.clone() …/src/runtime/sys_linux_amd64.s:621 (pc: 0x47870f)
backtrace: 6 frame(s)
```

这四行 `threads` 正好覆盖三类角色：2155525 是事件线程（主线程，停在断点），2155533 跑着用户 goroutine `main.spinner`，2155531/2155532 是运行时线程（sysmon 与空闲 M）。选中 2155531 后 `bt` 给出完整的 sysmon 调用链——`goroutines` 里没有这个"goroutine"，因为它跑在 g0 上。这就是线程视角的第一个用途。

第二个用途是通过选择验证优先级。先在 goroutine 视角选中挂起的 2 号，再切到主线程，再复位：

```bash
godbg> goroutine 2
switched to goroutine 2 [_Gwaiting] runtime.forcegchelper()
godbg> bt
0: runtime.gopark() …/src/runtime/proc.go:436 (pc: 0x470b11)
1: runtime.goparkunlock() …/src/runtime/proc.go:442 (pc: 0x440c85)
…
backtrace: 4 frame(s)
godbg> thread 2155525
switched to thread 2155525 at 0x4b1b87 main.main
godbg> bt
0: main.main() …/examples/debuggee/vars/main.go:28 (pc: 0x4b1b87)
1: runtime.main() …/src/runtime/proc.go:293 (pc: 0x440827)
…
backtrace: 3 frame(s)
godbg> thread -r
reset to goroutine view
godbg> bt
0: runtime.gopark() …/src/runtime/proc.go:436 (pc: 0x470b11)
…
backtrace: 4 frame(s)
```

`goroutine 2` 之后 `bt` 走的是 `g.sched` 合成的栈（`gopark` 收尾）；`thread 2155525` 之后即使 goroutine 选中态还在，`bt` 也切到主线程的真实寄存器——线程优先；`thread -r` 清掉 `selThread`，`bt` 又回到 2 号 goroutine，说明 `selGoroutine` 确实被保留了。三次 `bt` 的 frame 0 分别是三个不同的上下文，这是选择语义最直接的证据。

复位后再看一次列表，`*` 仍然只标事件线程（`* Thread 2155525 at 0x4b1b87 main.main …`），选中态在 `threads` 里没有可见标记。

`pregs` 也不跟随选择：选中 2155531 后它的 `Rip` 仍是 `0x4b1b87`（事件线程），而 `bt` 的 frame 0 是 `0x478097`。这不是本节引入的规则，而是 `pregs` 走 `CurrentThread + ReadRegs` 的既有实现，读代码时别把两者混为一谈。

最后是错误分支：

```bash
godbg> thread 999999
Error: thread 999999 not found
godbg> thread abc
Error: invalid thread id "abc"
godbg> thread
Error: usage: thread <id> | thread -r
```

三种错误分别来自 `SelectThread` 的存在性校验、`strconv.Atoi` 和参数个数检查；cobra 随后还会打印一段 Usage，上面省略。`thread 999999` 不会破坏会话，交互模式下可以继续输入。

这套行为由 `testdata/script/ch9.2.41.txt` 固化：脚本用 `@capture TID` 从 `threads` 输出里取第一个非当前线程，切过去后断言 `bt` 的 frame 0，再选 `goroutine 1` 并 `thread -r`，断言 frame 0 回到 `main.main`。

### 本节小结

线程级调试只有两个动作：**看**（`threads`）和**选**（`thread <id>` / `thread -r`）。看的时候，门面逐线程读 RIP、反查函数与源码行，`*` 标事件线程；选的时候，proc 层把 tid 存进 `selThread`，`Registers()` 的最前面三行让后续 `bt`/`list`/`print` 改用该线程的寄存器。选择语义是线程 > goroutine > 事件线程，与 delve 一致（CLEANROOM 已归因）。

边界与已知问题：

- **只有看和选，没有过滤与批量操作**：`threads` 无条件列出全部被跟踪线程，没有"隐藏运行时线程"的选项；也没有跨线程批量执行命令、批量设断点之类的写法。线程级断点本来就不是按线程生效的——软件断点改的是代码段，任何线程执行到都会命中。
- **tid 不是序号，且会变**：主线程 tid 等于 pid，其余由内核分配；同一次运行里稳定，跨运行不可假设。脚本应像 `testdata/script/ch9.2.41.txt` 那样用 `@capture` 现取。
- **选中不改变执行权**：`continue`/`stepout` 仍恢复全部线程，`step` 仍只推进事件线程；它们都以事件线程为默认对象，选中线程只影响读上下文。`pregs` 是例外，它固定读事件线程。
- **`thread -r` 只清 `selThread`**：`selGoroutine` 保留，所以复位后可能回到先前选中的 goroutine，而不是事件线程；反向不成立——`goroutine <id>` 不清 `selThread`，选完 goroutine 后 `bt` 仍可能走线程。
- **选中态不可见**：`threads` 的 `*` 只标事件线程，没有"当前选中"标记；唯一的确认手段是 `bt` 的 frame 0 或 `thread` 的回显。
- **线程表是快照**：`Target.Threads()` 返回的是目标层线程表里的条目，已退出但尚未清理的 tid 可能仍在；门面读寄存器失败时跳过该条（`debugger.go:624`），因此列表条数不保证等于 `/proc/<pid>/task` 的实时数目。
- **cgo 只保证看得到停点**：线程视角能显示 CPU 停在哪个 PC，但 C 帧的符号化依赖调试信息，godbgv2 不做额外保证；跨 M 运行中的 goroutine 仍未实现，这条边界见 9.2.40。
- **两个已知的实现瑕疵**：`threads` 的 `Aliases: []string{"threads"}` 是自别名（`cmd/debug/threads.go:27`）；`thread -r` 在"没有选中任何 goroutine"时也打印 `reset to goroutine view`，措辞比实际语义宽——此时回落的其实是事件线程。
