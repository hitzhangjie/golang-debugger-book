## 案例：Start 后立刻 Attach 先等到 SIGTRAP（SI_USER）

### 问题背景

在开发调试器时,我们经常需要启动一个进程并立即对其进行跟踪。一个典型的场景是:通过 `exec.Command("sleep", "5").Start()` 启动目标进程,然后立即执行 `PTRACE_ATTACH` 建立跟踪关系。按照常规理解,`PTRACE_ATTACH` 会向 tracee 注入一个 SIGSTOP 信号,调试器通过 `wait` 应该首先等到这个 SIGSTOP 引起的停止事件。

然而在 godbgv2 项目的 CI 测试中,我们遇到了一个令人困惑的现象:第一次 `wait` 返回的停止信号经常不是预期的 SIGSTOP,而是 SIGTRAP。通过 `PTRACE_GETSIGINFO` 读取信号详情,发现 `si_signo=5`(SIGTRAP)、`si_code=0`(SI_USER)、`si_pid` 等于 tracee 自身的 pid。更奇怪的是,这个问题在本地环境中往往不易复现,因为启动进程和执行 attach 之间存在一些隐式延迟,测试往往能通过;但在 CI 环境中,由于调度更快、延迟更小,问题就暴露出来了。

这个现象引发了一系列疑问:**为什么会先收到 SIGTRAP 而不是 SIGSTOP?** 这个 SIGTRAP 从何而来?调试器应该如何正确处理这种情况?本文将详细记录这次问题的排查过程、走过的弯路、最终的根本原因,以及相关概念的澄清。

### 现象描述

#### CI 测试场景

测试代码的基本流程如下:

```go
cmd := exec.Command("sleep", "5")
cmd.Start()
pid := cmd.Process.Pid
syscall.PtraceAttach(pid)
var ws syscall.WaitStatus
syscall.Wait4(pid, &ws, syscall.WSTOPPED, nil)
```

在 CI 环境中,这段代码经常遇到以下情况:

1. **第一次 `wait` 返回的 waitstatus 是 `0x57f`**,解析后对应 SIGTRAP(signal 5),而不是预期的 SIGSTOP(signal 19,waitstatus 应为 `0x137f`)
2. **通过 `PTRACE_GETSIGINFO` 查询信号详情**:
   - `si_signo = 5` (SIGTRAP)
   - `si_code = 0` (SI_USER,表示信号来自用户空间)
   - `si_pid` = tracee 的 pid(进程向自己发送信号?)

#### 本地复现的困难

在本地环境中尝试复现时,往往会得到"正常"的结果:第一次 `wait` 就等到 SIGSTOP。这是因为在 `Start()` 和 `PtraceAttach()` 之间,即使代码紧挨着写,实际执行时也存在一些微小的延迟(调度延迟、goroutine 切换等),足以让子进程完成 fork + execve 的过程,进入正常的运行状态。此时 attach 注入的 SIGSTOP 就能"正常"地成为第一个信号。

为了验证这个假设,我们在测试代码中添加了不同长度的延迟:

```go
cmd.Start()
time.Sleep(delay)
syscall.PtraceAttach(pid)
```

测试结果证实了竞态窗口的存在:

- `delay = 0ms`:几乎 100% 概率先看到 SIGTRAP
- `delay ≥ 1ms`:几乎 100% 概率先看到 SIGSTOP

这说明竞态窗口非常短暂,就在子进程刚刚 fork/exec 完成的附近。

### 排查过程:走过的弯路

#### 弯路一:怀疑 ExecPtrace 的影响

godbgv2 中为了保证同一个 tracee 的所有 ptrace 操作都由同一个 OS 线程发起,使用了 `ExecPtrace` 函数,它会创建一个固定的 goroutine 并通过 `runtime.LockOSThread()` 绑定到特定的 OS 线程上。最初怀疑是这个机制引入了额外的延迟或者某种竞态,导致信号顺序异常。

为了验证这个假设,我们编写了对比测试:一组测试直接调用 `syscall.PtraceAttach`,另一组通过 `ExecPtrace` 调用。结果显示:**两种方式都会遇到同样的 SIGTRAP 问题**。这说明问题与 `ExecPtrace` 的实现无关,而是 ptrace 机制本身的行为。

#### 弯路二:误以为"裸 ATTACH 总是先收到 SIGSTOP"

为了更好地理解问题,我们编写了最简化的 C 语言和 Go 语言测试程序:

```c
// 最小 C 复现
pid_t pid = fork();
if (pid == 0) {
    execl("/bin/sleep", "sleep", "5", NULL);
}
ptrace(PTRACE_ATTACH, pid, NULL, NULL);
waitpid(pid, &status, 0);
```

```go
// 最小 Go 复现  
cmd := exec.Command("sleep", "5")
cmd.Start()
syscall.PtraceAttach(cmd.Process.Pid)
syscall.Wait4(cmd.Process.Pid, &ws, 0, nil)
```

令人意外的是,这些最简化的测试在本地环境中**总是**等到 SIGSTOP。这让我们一度认为"单纯的 fork + attach 不会有问题",**问题一定出在调试器代码的某个环节**。

但这个结论是错误的!问题在于,即使是最简化的测试,sleep 这个程序本身的启动也需要一定时间(动态链接、初始化等),足以让它完全走出 exec 的关键窗口。sleep 程序"躲过"了竞态窗口,并不代表竞态不存在——这是一个**重要的误导**。

#### 弯路三:试图通过"接受 SIGTRAP"来修复测试

既然 CI 中经常遇到 SIGTRAP,一个看似合理的想法是:修改测试代码,让它既接受 SIGSTOP,也接受 SIGTRAP 作为 attach 成功的标志。这样 CI 就能通过了。

```go
// 错误的"修复"方式
sig := ws.StopSignal()
if sig != syscall.SIGSTOP && sig != syscall.SIGTRAP {
    return fmt.Errorf("unexpected stop signal: %v", sig)
}
```

这个改动确实能让测试通过,但它掩盖了真正的问题:**没有理解为什么会出现 SIGTRAP,也没有在实际调试器代码中正确处理这个信号**。如果生产代码沿用同样的逻辑,可能会在某些场景下出现错误的行为。因此,这个 PR 最终被关闭,转而去寻找真正的根本原因。

#### 弯路四:试图通过"固定延迟"来规避问题

另一个想法是:既然延迟 1ms 能稳定复现 SIGSTOP,那么在测试和生产代码中都加上这个延迟,不就解决了吗?

```go
cmd.Start()
time.Sleep(1 * time.Millisecond)  // "躲过"竞态窗口
syscall.PtraceAttach(pid)
```

这个做法同样是**掩耳盗铃**:

1. 延迟是一个 magic number,没有理论依据保证在所有环境、所有程序中都足够
2. 它人为降低了调试器的响应速度,没有必要
3. 它不是协议的一部分,其他调试器和 strace 等工具也没有这样做

更重要的是,**它仍然没有回答根本问题**:这个 SIGTRAP 到底是什么?调试器应该如何正确处理?

### 根本原因:execve under ptrace 的 SIGTRAP

经过查阅 man 手册和多方资料,终于找到了问题的真正原因。答案其实就写在 `man 2 ptrace` 的文档中,只是之前阅读时没有注意到相关章节。

#### PTRACE_ATTACH 并不保证 SIGSTOP 先到

`man 2 ptrace` 的 "Attaching and detaching" 小节明确指出:

> "Attaching sends SIGSTOP to this thread. If you want the tracee to stop, you must wait for the arrival of the SIGSTOP. **However, there is no guarantee that the tracee will be in signal-delivery-stop for SIGSTOP when you wait4 for it.** The tracee might be already in a signal-delivery-stop by the time of the ATTACH or it might enter a signal-delivery-stop for a different signal during the tiny window between ATTACH and your wait."

关键信息:**`PTRACE_ATTACH` 会排队一个 SIGSTOP,但不保证 `wait` 时第一个看到的就是它。** 在 attach 的瞬间,tracee 可能已经处于某个信号的投递停止(signal-delivery-stop),或者在 attach 和 wait 之间的极短窗口内收到了其他信号。

手册进一步建议:

> "After attaching, the tracer must wait for the tracee to stop. The **usual practice** is to **reinject** these signals until SIGSTOP is seen, then suppress SIGSTOP injection. This is done by **restarting the tracee** with PTRACE_CONT with signal = the signal that caused the current stop, repeating until you see SIGSTOP."

也就是说,正确的做法是**循环等待**:如果看到的不是 SIGSTOP,就通过 `PTRACE_CONT` 将该信号回注(reinject)给 tracee,让它继续运行,然后再次 `wait`,直到看到 SIGSTOP 为止,最后把 SIGSTOP suppress 掉(使用 `PTRACE_CONT(..., 0)`)。

但这还不是我们遇到的 SIGTRAP 的直接解释。真正的关键在于下一个章节。

#### execve under ptrace:post-exec SIGTRAP

`man 2 ptrace` 的 "Execve under ptrace" 小节解释了另一个重要机制:

> "When one thread in a **multithreaded process** calls execve(2), the kernel **destroys all other threads** in the process, and resets the PID of the execing thread to the thread group ID (process ID). (Or, to put things another way, when a multithreaded process does an execve, at completion of the call it appears as though the execve occurred in the thread group leader, regardless of which thread did the execve.) **This resetting of the PID is not performed if any of the threads were being traced.**"

> "The execve system call, when invoked by a thread that is being traced, **causes a SIGTRAP to be sent to the traced process.** As usual, this signal will be delivered only after the next ptrace restart operation."

更关键的是关于 `PTRACE_GETSIGINFO` 的说明:

> "For this SIGTRAP, fetching **siginfo\_t** by **PTRACE\_GETSIGINFO** returns **si\_code** set to **0 (SI\_USER)**."

**这正是我们在 CI 中看到的现象!** 当一个进程在**已经被 attach**(PT_PTRACED 标志已设置)的状态下完成 execve 时,内核会在 exec 返回用户空间之前向该进程投递一个 **SIGTRAP 信号**,并且这个 SIGTRAP 的 `si_code` 就是 **SI_USER(0)**。

#### 为什么我们会"在 exec 窗口内 attach"?

在 Go 语言中,`exec.Command(...).Start()` 的实现涉及 fork 和 exec 两个步骤:

1. `fork()` 创建子进程
2. 子进程执行一系列准备工作(设置文件描述符、工作目录、环境变量等)
3. 子进程调用 `execve` 替换自身为目标程序

`Start()` 方法返回时,子进程已经被创建,但**不一定已经完成 execve**。在 CI 等高速环境中,父进程(调试器)拿到子进程 pid 并立即执行 `PTRACE_ATTACH` 时,子进程很可能还在 execve 的执行过程中,或者刚刚完成 execve 但还未真正开始执行目标程序的代码。

这样,就出现了关键的时序:

1. 子进程正在执行 execve(或刚执行完)
2. 父进程执行 `PTRACE_ATTACH`,设置 PT_PTRACED 标志,排队 SIGSTOP
3. 子进程在带着 PT_PTRACED 标志的状态下完成 exec 返回
4. 内核检测到"exec under ptrace without PTRACE_O_TRACEEXEC",投递 post-exec SIGTRAP
5. **SIGTRAP 和 SIGSTOP 几乎同时在 pending 队列中,但 SIGTRAP 先被 dequeue,形成 signal-delivery-stop**
6. 调试器的 `wait` 返回,看到的是 SIGTRAP stop,而不是 SIGSTOP stop

#### 为什么不是所有程序都容易复现?

sleep、cat 等简单程序在 execve 之后还需要进行动态链接、初始化等工作,通常会在 execve 完成后的很短时间内变为"正常运行"状态。如果 attach 稍有延迟(本地环境、带 sleep 的测试等),往往会错过这个 exec 窗口,此时 post-exec SIGTRAP 已经不会产生,attach 注入的 SIGSTOP 就成为第一个信号。

但在 CI 环境中,由于调度更快、延迟更小,attach 恰好发生在 exec 窗口内的概率大大增加,问题就暴露出来了。

### 核心概念澄清

在分析和讨论这个问题的过程中,有几个 ptrace 相关的核心概念容易被误解,有必要在此澄清。

#### 什么是 signal-delivery-stop?

**signal-delivery-stop** 是 ptrace 机制中的一种停止状态。它的含义是:**tracee 因为即将投递(deliver)某个信号而停止执行,等待 tracer 的裁决。**

这里的"stop"是中心语,指的是 tracee 进入 TASK_TRACED 状态,不再继续执行;而"signal-delivery"是修饰语,说明这次 stop 的**原因**是"有信号要投递"。

容易产生的误解:

1. ❌ "signal-delivery-stop 是信号投递失败":错误。信号已经被 dequeue,正准备投递给进程,只是 ptrace 机制拦截了这个投递动作,让 tracer 有机会检查和干预。
2. ❌ "signal-delivery-stop 是暂停了投递动作本身":不准确。更准确的理解是,tracee **因为**即将执行信号投递而停止,把控制权交给 tracer。
3. ✅ **正确理解**:signal-delivery-stop 是 **tracee 的一种停止状态**,原因是有信号即将被投递。tracer 可以查看这个信号(`PTRACE_GETSIGINFO`),然后决定是让信号真正投递给 tracee(`PTRACE_CONT` with signal number),还是抑制这个信号(`PTRACE_CONT` with 0),或者修改信号内容。

与 signal-delivery-stop 并列的还有其他几种停止状态:

- **syscall-stop**:tracee 因为进入或退出系统调用而停止(由 `PTRACE_O_TRACESYSGOOD` 等选项控制)
- **group-stop**:tracee 因为收到停止信号(SIGSTOP、SIGTSTP 等)进入 group-stop 状态
- **PTRACE_EVENT stop**:tracee 因为某个 ptrace event 而停止(如 `PTRACE_EVENT_EXEC`、`PTRACE_EVENT_FORK` 等)

命名规律都是:`{原因}-stop`,中心语是"stop",修饰语说明原因。

#### PTRACE_CONT 的 data 参数:回注 vs 抑制

`PTRACE_CONT` 的函数签名是:

```c
long ptrace(PTRACE_CONT, pid_t pid, void *addr, void *data);
```

其中 `data` 参数指定了**如何处理当前 signal-delivery-stop 对应的信号**:

- **data = 0**:抑制(suppress)这个信号,tracee 恢复执行,但不会收到该信号
- **data = signo**:将信号 signo 真正投递(deliver)给 tracee,tracee 恢复执行后会执行该信号的处理逻辑(signal handler 或默认动作)

这里常见的误解是:**是否需要对所有信号都"回注"(reinject)?**

答案是:**只对应该被 tracee 接收的信号进行回注。** 并不是每个信号都需要 `PTRACE_CONT(pid, signo)` 传回去。

具体到我们遇到的场景:

1. **post-exec SIGTRAP(SI_USER)**:这是内核出于兼容性和历史原因产生的信号,**不应该**被投递给 tracee。如果使用 `PTRACE_CONT(pid, SIGTRAP)` 回注,而 tracee 没有为 SIGTRAP 安装 handler,默认动作是**终止进程**。sleep 等程序没有 SIGTRAP handler,会直接被杀死!因此,正确的做法是 `PTRACE_CONT(pid, 0)` 抑制掉这个 SIGTRAP。

2. **attach 注入的 SIGSTOP**:这个 SIGSTOP 也是 attach 机制产生的副作用,不是目标程序自己应该接收的信号,同样应该 `PTRACE_CONT(pid, 0)` 抑制掉。

3. **外部发送的信号**:如果是用户或其他进程向 tracee 发送的信号(比如 `kill -USR1 <pid>`),调试器通常应该 `PTRACE_CONT(pid, SIGUSR1)` 回注,让 tracee 正常处理。

man 手册中提到的"reinject these signals until SIGSTOP is seen"中的"these signals",指的是 **attach 之前或 attach 瞬间已经存在的、本应被 tracee 接收的信号**,而不是所有 signal-delivery-stop 都要回注。

#### ATTACH 的 SIGSTOP 不会被中间的 stop 消费掉

另一个需要明确的点:**`PTRACE_ATTACH` 排队的 SIGSTOP 不会因为中间处理了其他 signal-delivery-stop 而消失。**

在我们的场景中:

1. attach 排队 SIGSTOP
2. 内核投递 post-exec SIGTRAP,形成 signal-delivery-stop
3. 调试器 `wait` 看到 SIGTRAP stop,执行 `PTRACE_CONT(pid, 0)` 抑制 SIGTRAP
4. tracee 恢复执行,但**SIGSTOP 仍然在 pending 队列中**
5. 调试器再次 `wait`,这次会看到 SIGSTOP stop

换句话说,处理 SIGTRAP 的 `PTRACE_CONT` 只是在"这次 stop"的层面决定了 SIGTRAP 被抑制,SIGSTOP 并没有受到影响,它会在下一次形成 signal-delivery-stop。

这是 ptrace 信号处理的重要机制:**每次 signal-delivery-stop 对应一个信号,PTRACE_CONT 的 data 参数只决定这个信号的命运,不影响其他 pending 信号。**

#### 信号的优先级?

有人可能会问:为什么 SIGTRAP 比 SIGSTOP"先到"?是不是 SIGTRAP 的优先级更高?

答案是:**Linux 的标准信号没有严格的优先级概念。** 当多个信号同时 pending 时,内核按照一定的顺序 dequeue,但这个顺序不是"优先级",而是由 pending 位图的扫描顺序、信号的产生时机等因素共同决定的。

在我们的场景中,post-exec SIGTRAP 和 attach SIGSTOP 几乎同时进入 pending 状态,SIGTRAP 常常先被 dequeue,因此先形成 signal-delivery-stop。但这**不是**因为 SIGTRAP"优先级高于"SIGSTOP,而是 dequeue 时机和内核实现的结果。

在其他场景下,信号的到达顺序可能完全不同。因此,**调试器不应该假设信号的到达顺序**,而应该采用循环等待的方式,处理任何可能先到的信号,直到看到预期的 SIGSTOP。

### 正确的处理方式

基于以上分析,我们可以总结出调试器在 attach 后等待 tracee 停稳的正确做法:

#### 方案一:循环等待 SIGSTOP

按照 man 手册的建议,实现一个 wait 循环:

```go
func attachAndWaitForSigstop(pid int) error {
    if err := syscall.PtraceAttach(pid); err != nil {
        return err
    }
    
    for {
        var ws syscall.WaitStatus
        _, err := syscall.Wait4(pid, &ws, syscall.WSTOPPED, nil)
        if err != nil {
            return err
        }
        
        if !ws.Stopped() {
            return fmt.Errorf("unexpected status: %v", ws)
        }
        
        sig := ws.StopSignal()
        
        if sig == syscall.SIGSTOP {
            // 看到 SIGSTOP,抑制它,attach 完成
            return syscall.PtraceCont(pid, 0)
        }
        
        // 看到其他信号(如 post-exec SIGTRAP),抑制它,继续等待
        // 注意:对于 post-exec SIGTRAP,必须抑制(传 0),否则会杀死进程!
        if err := syscall.PtraceCont(pid, 0); err != nil {
            return err
        }
    }
}
```

这个方案的优点是:

1. 符合 man 手册的建议,处理逻辑清晰
2. 能够正确处理 attach 瞬间的各种竞态情况
3. 对于 post-exec SIGTRAP,通过传 0 抑制,避免杀死进程

注意事项:

- 对于本应被 tracee 接收的信号(如外部发送的 SIGUSR1),循环中应该 `PtraceCont(pid, int(sig))` 回注,而不是一律传 0。但对于 post-exec SIGTRAP 和 attach SIGSTOP 本身,应该抑制。
- 循环的终止条件是看到 SIGSTOP,然后抑制它并返回。此时 tracee 处于停止状态,调试器可以继续进行后续操作(设置断点、读取内存等)。

#### 方案二:使用 PTRACE_SEIZE + PTRACE_INTERRUPT

如附录 12.5 所述,`PTRACE_SEIZE`(Linux 3.4+)从根源上规避了 `PTRACE_ATTACH` 注入 SIGSTOP 引入的各种竞态问题。

使用 SEIZE 的流程:

```go
func seizeAndStop(pid int) error {
    // SEIZE 不会发送 SIGSTOP,tracee 不会立即停止
    if err := syscall.PtraceSeize(pid); err != nil {
        return err
    }
    
    // 需要停止时,发送 INTERRUPT
    if err := syscall.PtraceInterrupt(pid); err != nil {
        return err
    }
    
    // 等待 PTRACE_EVENT_STOP
    var ws syscall.WaitStatus
    _, err := syscall.Wait4(pid, &ws, syscall.WSTOPPED, nil)
    if err != nil {
        return err
    }
    
    // 验证是 PTRACE_EVENT_STOP
    if ws>>16 != syscall.PTRACE_EVENT_STOP {
        return fmt.Errorf("unexpected event: %v", ws>>16)
    }
    
    return nil
}
```

SEIZE 的优点:

1. **没有隐式 SIGSTOP**:不存在 SIGSTOP 与其他信号合并丢失、stray EINTR 等问题
2. **停止事件来源清晰**:`PTRACE_INTERRUPT` 产生的停止以 `PTRACE_EVENT_STOP` 上报,与 signal-delivery-stop 可以明确区分
3. **group-stop 场景可控**:可以使用 `PTRACE_LISTEN` 让 tracee 保持"不执行但也不逃出 group-stop"的状态

因此,如果目标环境支持(Linux 3.4+),优先使用 SEIZE + INTERRUPT 的组合。strace 等工具优先使用 `PTRACE_SEIZE`。

#### 方案三:在已 attach 的场景下使用 PTRACE_O_TRACEEXEC

如果调试器已经通过 `PTRACE_TRACEME` 或其他方式 attach 了进程,并且预期该进程会执行 exec,可以设置 `PTRACE_O_TRACEEXEC` 选项:

```go
syscall.PtraceSetOptions(pid, syscall.PTRACE_O_TRACEEXEC)
```

设置此选项后,tracee 执行 execve 时会产生 `PTRACE_EVENT_EXEC` 事件,而不是普通的 SIGTRAP。调试器可以通过检查 `ws>>16 == PTRACE_EVENT_EXEC` 来识别这个事件,并进行相应处理。

这个方案适用于 `PTRACE_TRACEME` 或已经建立跟踪关系的场景,对于本文讨论的"先 Start 再 attach"的场景,由于 attach 本身就发生在 exec 窗口内,来不及设置 `PTRACE_O_TRACEEXEC`,所以不适用。但在其他调试场景中(如 `godbg exec`),这是一个很有用的选项。

### 与附录 12.5 的关系

本文与附录 12.5《ptrace attach 的竞态问题》讨论的是相关但不同的问题:

**附录 12.5** 讨论的是 `PTRACE_ATTACH` 注入 SIGSTOP 本身引入的几类经典竞态问题:

1. **SIGSTOP 与外部信号合并丢失**:attach 的 SIGSTOP 与并发的外部 SIGSTOP 合并成一次 stop,调试器抑制时可能把外部信号也一起吞掉
2. **stray EINTR**:SIGSTOP 打断正在执行的系统调用,系统调用返回 EINTR
3. **attach 处于 group-stop 状态的 tracee**:tracee 已经处于 group-stop,attach 的 SIGSTOP 不会产生独立的 stop,调试器可能误判

这些问题的根源是 **`PTRACE_ATTACH` 隐式注入 SIGSTOP** 这个设计,解决方案是使用 `PTRACE_SEIZE`,它不注入 SIGSTOP,需要停止时再通过 `PTRACE_INTERRUPT` 显式请求。

**本文(附录 12.9)** 讨论的是一个更具体的场景:**在进程 Start 后立即 attach,遇到 post-exec SIGTRAP(SI_USER) 先于 SIGSTOP 到达**。这个问题的根源是:

1. `Start()` 返回时子进程可能仍在 exec 窗口内
2. attach 在 exec 窗口内完成,tracee 带着 PT_PTRACED 标志完成 exec
3. 内核投递 post-exec SIGTRAP(历史兼容机制)
4. SIGTRAP 和 SIGSTOP 同时 pending,SIGTRAP 先被 dequeue

这个问题虽然也涉及 attach,但**更关键的是 execve under ptrace 的行为**。解决方案是:

1. 实现 wait 循环,处理任何先到的信号,直到 SIGSTOP;对 post-exec SIGTRAP 必须抑制(传 0),否则会杀死进程
2. 或者使用 `PTRACE_SEIZE` + `PTRACE_INTERRUPT`,从根源上规避 SIGSTOP 的各种问题
3. 如果是已建立跟踪关系的场景,可以提前设置 `PTRACE_O_TRACEEXEC`,让 exec 产生 `PTRACE_EVENT_EXEC` 而不是 SIGTRAP

**两者的关系**:

- 12.5 是对 `PTRACE_ATTACH` 机制本身的深入分析,介绍了它的设计缺陷和 `PTRACE_SEIZE` 的解决思路,是**通用性的知识**
- 12.9(本文)是一个**具体的案例研究**,展示了在 Start + attach 这个特定场景下遇到的 post-exec SIGTRAP 问题,排查过程、概念澄清和解决方案
- 12.9 中推荐的"使用 SEIZE"方案,其理论基础在 12.5 中有详细阐述
- 读者应该**先阅读 12.5 了解 attach 的通用问题,再阅读 12.9 了解这个具体案例**

### 参考资料

1. **man 2 ptrace** - Linux Programmer's Manual  
   https://man7.org/linux/man-pages/man2/ptrace.2.html  
   特别是 "Attaching and detaching" 和 "Execve under ptrace" 两个小节

2. **man 2 execve** - Linux Programmer's Manual  
   https://man7.org/linux/man-pages/man2/execve.2.html

3. **strace README-linux-ptrace** - strace 项目对 Linux ptrace 机制的详细文档  
   https://github.com/strace/strace/blob/master/doc/README-linux-ptrace

4. **strace-devel mailing list: "SIGTRAP on execve with PTRACE_ATTACH"** - 关于 attach 后来不及设置 PTRACE_O_TRACEEXEC 时的 post-exec SIGTRAP 的讨论  
   https://lists.strace.io/pipermail/strace-devel/2010-March/001347.html

### 本节小结

本节通过一个真实的调试器开发案例,详细记录了 **Start 后立即 attach 先等到 SIGTRAP(SI_USER)** 这一现象的完整排查过程。主要内容包括:

1. **现象描述**:在 CI 环境中,`Start()` 后立即 `PTRACE_ATTACH`,第一次 `wait` 经常等到 SIGTRAP(si_code=0)而不是预期的 SIGSTOP;本地难以复现是因为隐式延迟让子进程走出了竞态窗口。

2. **走过的弯路**:怀疑 ExecPtrace、误以为"裸 attach 总是 SIGSTOP"、试图通过"接受 SIGTRAP"或"固定延迟"来修复——这些都没有触及问题本质。

3. **根本原因**:两个关键机制的组合:
   - `PTRACE_ATTACH` 会排队 SIGSTOP,但**不保证第一次 wait 就是 SIGSTOP**,并发信号可以先到
   - **execve under ptrace**:进程在已被 attach(PT_PTRACED)且未设置 PTRACE_O_TRACEEXEC 时完成 exec,内核投递 **post-exec SIGTRAP,si_code=SI_USER**
   - `Start()` 返回时子进程常仍在 exec 窗口,立即 attach 就会遇到上述情况,SIGTRAP 和 SIGSTOP 同时 pending,SIGTRAP 先被 dequeue

4. **概念澄清**:
   - **signal-delivery-stop**:tracee **因为即将投递某信号而停止**,不是"投递失败",中心语是 stop
   - **PTRACE_CONT 的 data 参数**:0 表示抑制,signo 表示回注;不是所有信号都要回注,post-exec SIGTRAP 必须抑制(否则杀进程),attach SIGSTOP 也应抑制
   - **ATTACH 的 SIGSTOP 不会被消费掉**:处理中间的 SIGTRAP 不影响 SIGSTOP,它会在下次形成 signal-delivery-stop
   - **信号没有严格的优先级**:SIGTRAP 先到是 dequeue 时机的结果,不是"优先级高"

5. **正确的处理方式**:
   - **wait 循环**:非 SIGSTOP 时用 `PTRACE_CONT(pid, 0)` 抑制(对本应到达的信号应回注),直到 SIGSTOP 再抑制
   - **PTRACE_SEIZE + INTERRUPT**(推荐):无隐式 SIGSTOP,用 INTERRUPT 显式停止,产生 PTRACE_EVENT_STOP
   - **PTRACE_O_TRACEEXEC**:已建立跟踪关系时可用,让 exec 产生 PTRACE_EVENT_EXEC 而非 SIGTRAP

6. **与附录 12.5 的关系**:12.5 讲 attach 的通用竞态问题和 SEIZE 解决方案,是基础;本文(12.9)是 Start+attach 场景下 post-exec SIGTRAP 的具体案例,展示排查过程和概念澄清,是应用。

通过本文的分析,读者应该理解:调试器在 attach 后不能假设第一次 wait 必然是 SIGSTOP,必须实现循环等待或使用 SEIZE;对于 post-exec SIGTRAP 这类机制产生的信号,必须抑制而非回注,否则会导致目标进程被杀死。这些都是开发健壮调试器的重要知识。关于 attach 的更多通用问题,请参阅第 6.2 节"跟踪运行中进程"和附录 12.5"ptrace attach 的竞态问题"。
