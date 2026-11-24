## step：指令级单步

第 6 章 6.12 已经用 `ptrace(PTRACE_SINGLESTEP, ...)` 实现了逐指令执行。到符号级调试器，`step` 的实现没有变，仍是"执行一条机器指令"；变的是使用者对它的预期——看到源码之后，很容易以为 `step` 会按行推进。本节把这个边界讲清楚。

### 实现目标

`godbg> step`（别名 `s`）的目标是：让当前选中的线程执行一条机器指令后重新停下，并打印步进后的 PC。

在 godbgv2 里 `step` 始终是指令级操作：没有源码行语义，也不判断这条指令属于哪一行。源码级单步（行级 `next`、进入函数的 `stepin`）是另一类实现，前者见 9.2.28，后者尚未实现。

### 基础知识

单步依赖 CPU 的陷阱标志。`PTRACE_SINGLESTEP` 让内核在恢复 tracee 时把 `EFLAGS.TF` 置位；处理器每执行完一条指令就产生 #DB 异常，内核据此向 tracee 投递 `SIGTRAP` 并唤醒 tracer。所以"执行一条指令就停"是硬件与内核协作的结果，调试器只负责发起请求和等待。

`step` 只对"当前线程"单步：`api.Client.Step(tid)` 的 tid 来自 `Client.CurrentThread()`，`pkg/target/step.go` 的 `SingleStep(pid)` 也只对这一个 tid 调用 `PtraceSingleStep` 并 `Wait4` 它。其余线程在 all-stop 语义下本来就是停止状态，不会被带着跑。这正是 `step` 与 `continue` 的区别：continue 恢复全部线程，step 只让一条线程动一条指令，动完仍然是全体停止。

还有一个交互细节：断点处的 PC 是断点地址加 1，如果直接对这样的 PC 单步，处理器会从 `int3` 的下一个字节开始解码，指令流就错位了。因此 `step` 在单步之前必须先检查 `PC-1` 是否为本调试器设的断点。

### 代码实现

`cmd/debug/step.go` 的流程是"先处理断点，再单步"（节选）：

```go
// 读取当前 PC
regs, err := Client.ReadRegs(tid)
addr := regs.PC() - 1
// PC-1 处不是断点：直接单步执行
if err := Client.RestoreInstruction(addr); err != nil {
    if err == api.ErrBreakpointNotExisted {
        if err := Client.Step(tid); err != nil { ... }
        return nil
    }
    return fmt.Errorf("clear breakpoint err: %v", err)
}
// PC-1 处是断点：还原断点指令 → 回退 PC → 单步 → 重新添加断点
defer Client.AddBreakpoint(addr)

regs.SetPC(addr)
if err = Client.WriteRegs(tid, regs); err != nil { ... }
if err := Client.Step(tid); err != nil { ... }
```

`RestoreInstruction(addr)` 在 `addr` 处没有断点时返回 `api.ErrBreakpointNotExisted`，命令层用它区分"PC-1 不是断点"与"调试器内部错误"。断点分支里先还原原始指令，把 PC 回退到断点地址，单步执行这条原指令，最后用 `defer` 把断点加回去——`defer` 在函数返回时执行，所以重新打补丁发生在 `RunE` 结束前、下一条命令开始前，顺序上是安全的。

`Client.Step(tid)` 经 `debugger.Debugger.Step` 转发到 `pkg/target/step.go`：

```go
func (p *DebuggedProcess) SingleStep(pid int) (*syscall.WaitStatus, error) {
    err := p.ExecPtrace(func() error {
        return syscall.PtraceSingleStep(pid)
    })
    if err != nil {
        return nil, err
    }
    var (
        wstatus syscall.WaitStatus
        rusage  syscall.Rusage
    )
    _, err = syscall.Wait4(pid, &wstatus, syscall.WALL, &rusage)
    ...
}
```

单步之后，命令层用一个 `defer` 读取寄存器并打印 `single step ok, current PC: %#x`。注意它只打印 PC，**没有调用 `printLocation`**——continue（9.2.27）与 stepout（9.2.39）都会展示源码位置，step 不会。这是符号级会话里 `step` 的展示缺口：想知道这条 PC 对应哪一行、哪条指令，还要自己执行 `list` 或 `disass`。

### 执行测试

仍用 `_fixtures/loop`。循环体首行 `main.go:16` 从 `0x4b3971` 开始，该行对应多条指令（本节输出为批量回放所得，`init.txt` 为脚本占位名）：

```bash
$ ./godbg exec _fixtures/loop --init init.txt
process 1907902 launched, stopped by SIGTRAP
godbg> break main.go:16
breakpoint 1 added at 0x4b3971 (<src>/main.go:16)
godbg> continue
thread 1907902 status: stopped: trace/breakpoint trap
> <src>/main.go:16 (pc: 0x4b3972)
stop all threads now
continue ok
godbg> step
single step ok, current PC: 0x4b3977
godbg> step
single step ok, current PC: 0x4b397d
godbg> step
single step ok, current PC: 0x4b3982
```

第一次 `step` 时 PC 是 `0x4b3972`，`PC-1 = 0x4b3971` 正是断点：先还原原指令、把 PC 回退到 `0x4b3971`，单步执行这条 6 字节指令后 PC 变成 `0x4b3977`。后两次 `step` 的 `PC-1` 都不是断点，直接单步，PC 依次推进到 `0x4b397d`、`0x4b3982`。对照 `go tool objdump` 可以看到，`0x4b3971`、`0x4b3977`、`0x4b397d`、`0x4b3982` 这几条指令的源码行号都是 `main.go:16`。也就是说，连续三次 `step` 都停在同一行源码内——这就是"指令级"与"源码级"最直观的差别。

### 本节小结

`step` 在 godbgv2 中是指令级单步：`PTRACE_SINGLESTEP` 让当前线程只执行一条机器指令，其余线程保持停止；单步前要按 `PC-1` 判断并越过断点，单步后打印 PC。它不计算源码行，也不展示源码位置，因此不能当作行级 `stepin` 使用。源码级单步要依靠行号表和隐式断点：行级"下一行"见 9.2.28（`next` 目前是桩），"进入被调函数"的 `stepin` 尚未实现。理解这条边界，才不会被"step 看起来只走了一行"的巧合误导——那只是编译器恰好把一行生成了一条指令。
