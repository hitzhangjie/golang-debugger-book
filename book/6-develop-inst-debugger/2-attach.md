## 启动调试：跟踪运行中进程

6.1 节实现的 `godbg exec <prog>` 面向的是还没跑起来的程序：先把程序启动起来，再用 PTRACE_TRACEME 让它在 exec 的那一刻停住。但很多时候目标程序已经在跑了，比如线上服务、别人机器上的进程，此时不可能重新启动它，只能按 pid 跟踪，这就是本节要实现的 `godbg attach <pid>`。

tracee、tracer、ptrace link、wait 这些核心概念，6.1 节已经介绍过了，本节直接用起来。attach 和 exec 建立跟踪关系的方式不同（PTRACE_ATTACH vs PTRACE_TRACEME），我们要重点关注的是这个差异，以及 attach 特有的几个问题：attach 失败的常见原因、attach 多线程程序为什么"停不下来"。

本节配套代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.2`，`git diff ch6.1 ch6.2` 可以看到这一节在 exec 的基础上多了什么。

### 实现目标：`godbg attach <pid>` 跟踪运行中进程

如果进程已经在运行了，要对其进行调试需要先通过 attach 操作跟踪进程，待其停止执行后，再执行查看修改数据、控制程序执行的操作。常见的调试器如 dlv、gdb 等都支持传递 pid 参数来对运行中的进程进行跟踪调试。

本节我们将实现程序 `godbg attach <pid>` 子命令：attach 到目标进程，此时目标进程会暂停执行，等它停稳后进入 5.7 节搭好的调试会话。会话结束后调试器退出，内核会解除跟踪关系，目标进程恢复执行。本节还会在 attach 成功后把目标进程的启动命令和参数从 `/proc` 里读回来存好，为后续 restart 调试做准备；调试器退出前显式 detach、还原断点、结束被调试进程这些清理动作，从 6.4 节开始统一处理（信号退出场景在 6.10 节补齐）。

### 基础知识

#### PTRACE_ATTACH / PTRACE_DETACH

当我们通过 `ptrace(PTRACE_ATTACH, pid, ...)` 操作去跟踪一个指定的线程时，内核会给这个目标线程发送一个信号 SIGSTOP。

当执行 SIGSTOP 的信号处理时，内核会执行如下关键操作，效果就是让 tracee 停下来，并且通知 tracer：

```c
do_signal_stop
    set_special_state(TASK_STOPPED);                    // 暂停tracee执行
    do_notify_parent_cldstop(current, false, notify);   // 通知ptracer tracee已经停止
        __group_send_sig_info(SIGCHLD, &info, parent);  // 给ptracer进程发送SIGCHLD，任意线程都可以处理
        __wake_up_parent(tsk, parent);                  // 唤醒ptracer进程中任意调用了wait4(tracee，)阻塞的线程
```

可以看到，attach 建立跟踪关系时 tracee 收到的停止信号是 SIGSTOP，而不是 exec 场景下的 SIGTRAP。tracer 侧等待 tracee 停下来的方式是一样的：wait4 + WSTOPPED。

下面是 man 手册关于 ptrace 操作 attach、detach 的说明，大家可以详细了解下：

> **PTRACE_ATTACH**
> Attach to the process specified in pid, making it a tracee of
> the calling process.  The tracee is sent a SIGSTOP, but will
> not necessarily have stopped by the completion of this call;
>
> use waitpid(2) to wait for the tracee to stop.  See the "At‐
> taching and detaching" subsection for additional information.
>
> **PTRACE_DETACH**
> Restart the stopped tracee as for PTRACE_CONT, but first de‐
> tach from it.  Under Linux, a tracee can be detached in this
> way regardless of which method was used to initiate tracing.

> ps: 除了 `PTRACE_ATTACH`，内核还提供了 `PTRACE_SEIZE`（Linux 3.4+）来建立跟踪关系：SEIZE attach 之后不会向 tracee 发送 SIGSTOP，tracee 也不会立即停止，调试器需要时再通过 `PTRACE_INTERRUPT` 让其停下来，从而规避了 ATTACH 注入 SIGSTOP 引入的一些竞态问题（如信号合并丢失、stray EINTR、group-stop 状态 attach 等），详见附录 12.5《PTRACE_ATTACH 的竞态问题与 PTRACE_SEIZE》。strace 等工具优先使用 PTRACE_SEIZE；dlv 在 attach 时仍然使用 PTRACE_ATTACH（see: pkg/proc/native/ptrace_linux.go），本书示例同样使用 PTRACE_ATTACH，实现上更直观简单。
> 
> 另外，在 Start 进程后立即 attach 的场景下，可能会遇到一个特殊情况：第一次 wait 等到的不是 SIGSTOP，而是 SIGTRAP（si_code=SI_USER）。这是因为 attach 恰好发生在子进程 execve 的窗口内，内核会投递一个 post-exec SIGTRAP。关于这个现象的详细分析、排查过程和正确处理方式，请参阅附录 12.9《案例：Start 后立刻 Attach 先等到 SIGTRAP》。

#### attach 失败常见原因

**验证1：多个调试器实例 attach 同一个线程**

前面说过，同一个线程只允许被一个调试器（debugger backend）实例跟踪调试。我们可以通过如下操作对此进行验证。

shell 1 中先启动一个预先写好的 go 程序，它执行 for 循环：

```bash
$ ./goforloop
```

shell 2 中通过 godbg attach 到该 goforloop 进程，attach 成功：

```bash
$ godbg attach `pidof goforloop`
```

shell 3 中通过 godbg 再次 attach 到该 goforloop 进程，attach 报权限失败：

```bash
$ godbg attach `pidof goforloop`
Error: process 31060 attached error: operation not permitted
```

验证1中第二个调试器实例 attach 失败，报错 operation not permitted，是因为目标线程已经与第一个调试器实例建立了 ptrace link，内核拒绝了重复 attach。除此之外，还有几类常见的场景也会导致 attach 失败并返回 `EPERM (operation not permitted)`：

1. **凭据检查（credential check）不通过**：内核在建立跟踪关系前，会通过 `ptrace_may_access()` 对 tracer 进行凭据检查，tracer 进程的 real uid、real gid 必须与 tracee 进程的 real/effective/saved uid、gid 相匹配，或者 tracer 进程（在 tracee 所在 user namespace 中）具备 `CAP_SYS_PTRACE` capability。因此，普通用户无法 attach 其他用户的进程，也无法 attach root 用户进程；
2. **tracee 处于 nondumpable 状态**：如果 tracee 进程曾经通过 exec 执行过 suid 程序（提权之后又降权），或者主动调用过 `prctl(PR_SET_DUMPABLE, 0)`，该进程会变为 nondumpable 状态。此时即使凭据检查通过，也必须具备 `CAP_SYS_PTRACE` 才能 attach；
3. **LSM（Linux Security Module）安全检查不通过**：内核在完成上述检查后，还会调用 LSM hook（如 `security_ptrace_access_check`）做进一步检查。最常见的是 Ubuntu、Debian、Fedora 等发行版默认启用的 Yama LSM，它通过 `/proc/sys/kernel/yama/ptrace_scope` 来限制 attach 行为，取值及含义如下：
   - 0：不额外限制，凭据检查通过即可 attach（传统行为）；
   - 1：限制模式（发行版默认值），只允许 tracer 是 tracee 的祖先进程（如父进程调试子进程），或者 tracee 通过 `prctl(PR_SET_PTRACER, ...)` 显式声明允许的 tracer，或者 tracer 具备 `CAP_SYS_PTRACE`；
   - 2：管理限制模式，只允许具备 `CAP_SYS_PTRACE` 的进程执行 attach；
   - 3：禁止模式，任何 attach 都会被拒绝（该值一经设置无法再修改）。

因此，如果读者在练习 `godbg attach <pid>` 时遇到 operation not permitted 的报错，可以依次排查：目标线程是否已被其他调试器跟踪、当前用户是否具备目标进程的 uid/gid 权限、目标进程是否处于 dumpable 状态、Yama `ptrace_scope` 的取值是否限制了 attach。

> ps: 如果是 Yama 限制导致 attach 失败，可以临时放开限制：`echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope`，或者以 root 身份调试，或者由目标进程调用 `prctl(PR_SET_PTRACER, PR_SET_PTRACER_ANY)` 声明允许被任意进程调试。而 `godbg exec <prog>` 之所以不会遇到 Yama 限制，是因为它走的是 `PTRACE_TRACEME` 流程，tracee 是 tracer 的子进程，天然满足 `ptrace_scope=1` 的祖先关系要求。

### 代码实现

godbgv2 在 ch6.1 的基础上新增了 attach 的调用链：

```text
godbg attach <pid>
    cmd/attach.go                      RunE：校验参数，调用 Client.Attach
    pkg/service/api                    新增 Client.Attach/Detach
    pkg/service/debugger               门面，把请求转给目标层
    pkg/target                         PtraceAttach + wait4，等待 SIGSTOP
    cmd/debug                          PostRun 进入已有的调试会话
```

#### 命令层

`cmd/attach.go` 和 6.1 节的 `cmd/exec.go` 结构一致：`RunE` 校验 pid 参数，然后调用 `Client.Attach`。这个调用返回时，目标进程已经因为 attach 产生的 SIGSTOP 停住了，我们把 pid 打印出来，`PostRun` 进入调试会话。

```go
RunE: func(cmd *cobra.Command, args []string) error {

    if len(args) != 1 {
        return errors.New("参数错误")
    }
    pid, err := strconv.Atoi(args[0])
    if err != nil {
        return fmt.Errorf("invalid pid %q: %v", args[0], err)
    }

    // attach 到运行中的进程，等待其因 SIGSTOP 而停止
    if err := Client.Attach(pid); err != nil {
        return err
    }
    fmt.Printf("process %d attached, stopped by SIGSTOP\n", pid)
    return nil
},
PostRun: func(cmd *cobra.Command, args []string) {
    // TODO(ch6.4): 退出会话时清理被调试进程
    debug.CurrentSession = debug.NewDebugSession()
    debug.CurrentSession.Start()
},
```

`api.Client` 接口也相应扩展，补上了 attach、detach 两个方法：

```go
type Client interface {
    // Launch 启动并跟踪一个进程，返回被调试进程 pid
    Launch(kind Kind, cmd string, args ...string) (int, error)
    // Attach 跟踪一个正在运行的进程
    Attach(pid int) error
    // Detach 结束调试，分离被调试进程
    Detach() error
}
```

#### 服务层

`pkg/service/debugger` 门面把请求转给目标层，并记住当前正在调试的 `DebuggedProcess`：

```go
// Attach 跟踪一个正在运行的进程，等待其因 SIGSTOP 而停止
func (d *Debugger) Attach(pid int) error {
    dbp, err := target.AttachTargetProcess(pid)
    if err != nil {
        return err
    }
    d.dbp = dbp
    return nil
}

// Detach 结束调试，分离被调试进程
func (d *Debugger) Detach() error {
    if d.dbp == nil {
        return fmt.Errorf("no debugged process")
    }
    return d.dbp.Detach()
}
```

#### 目标层

`AttachTargetProcess` 先构造进程描述，然后通过 `attach` 去真正跟踪：

```go
func AttachTargetProcess(pid int) (p *DebuggedProcess, err error) {
    p = &DebuggedProcess{
        Process: nil,
        Command: "",
        Args:    nil,
        Kind:    ATTACH,

        once:   &sync.Once{},
        reqCh:  make(chan ptraceRequest, 16),
        doneCh: make(chan int),
    }

    if p.Process, err = os.FindProcess(pid); err != nil {
        return nil, err
    }

    // attach to running process
    if err := p.attach(pid); err != nil {
        return nil, err
    }

    // 读取 /proc/pid/comm、/proc/pid/cmdline，便于后续支持重启调试
    if err := p.initialize(); err != nil {
        return nil, err
    }

    // TODO(ch6.17.1): attach 到该进程的其他线程
    return p, nil
}
```

`attach` 里三件事：校验 pid、ptrace attach、wait 等停稳。

- `checkPid` 校验 pid 是否对应一个有效的进程。注意不能依赖 `os.FindProcess`：在 Unix 平台下，这个函数总是返回 OK，即使进程不存在。所以这里借助 `kill -s 0 pid` 这个经典做法来检查 pid 合法性；
- `syscall.PtraceAttach(pid)` 和 6.1 节一样包在 `ExecPtrace` 里执行，保证 ptrace 请求由同一个 OS 线程发出，后续对这个 tracee 的所有 ptrace 请求也都走这条路；
- `wait` 等待 tracee 停稳，并核对停止信号是 SIGSTOP，而不是 exec 场景下的 SIGTRAP。对不上就当 attach 失败。

```go
// attach 通过 ptrace 跟踪进程 pid，等待其因 SIGSTOP 而停止
func (p *DebuggedProcess) attach(pid int) error {

    // check tracee pid
    if !checkPid(pid) {
        return fmt.Errorf("process %d not existed", pid)
    }

    // attach
    err := p.ExecPtrace(func() error { return syscall.PtraceAttach(pid) })
    if err != nil {
        return fmt.Errorf("process %d attached error: %v", pid, err)
    }

    // wait
    _, status, err := p.wait(pid, syscall.WSTOPPED)
    if err != nil {
        return fmt.Errorf("process %d waited error: %v", pid, err)
    }
    if !status.Stopped() || status.StopSignal() != syscall.SIGSTOP {
        return fmt.Errorf("unexpected status: %v", status)
    }
    return nil
}
```

detach 与之对应，解除跟踪关系并让 tracee 恢复执行：

```go
// Detach 分离被调试进程，使其恢复运行
// （当前只分离主线程，ch6.17.1 起遍历全部线程）
func (p *DebuggedProcess) Detach() error {

    // check tracee pid
    if !checkPid(p.Process.Pid) {
        return fmt.Errorf("process %d not existed", p.Process.Pid)
    }

    return p.ExecPtrace(func() error {
        return syscall.PtraceDetach(p.Process.Pid)
    })
}
```

> ps: tracer 退出时，即使没有显式 detach，内核也会解除跟踪关系，让 tracee 恢复执行。所以本节调试会话退出后目标进程还能继续跑；显式的 detach、断点还原和进程善后从 6.4 节开始统一实现。

#### 目标层：读取启动命令与参数（initialize）

attach 是"半路接手"一个进程：调试器看到它时它已经跑起来了，不知道它是怎么启动的。不知道启动命令和参数，后续想支持 restart（重新发起调试）时就没法把进程再拉起来。exec/debug 启动的进程，命令和参数是启动调试器时指定的，天然就知道；attach 的进程只能从内核的 `/proc` 接口里读回来。

所以 `AttachTargetProcess` 在 attach 成功后调用 `p.initialize()`，读取 `/proc/pid/comm`、`/proc/pid/cmdline` 填充 `DebuggedProcess.Command/Args`：

```go
// initialize 初始化被调试进程的启动命令与参数
func (p *DebuggedProcess) initialize() error {
    var err error

    // initialize the command and arguments, after then, we could support
    // restart command.
    if p.Command, err = readProcComm(p.Process.Pid); err != nil {
        return err
    }
    if p.Args, err = readProcCommArgs(p.Process.Pid); err != nil {
        return err
    }
    return nil
}
```

`readProcComm`、`readProcCommArgs` 的实现放在 `pkg/target/procfs.go`（6.1 节的 status 函数也在这里）：

```go
// readProcComm 读取 /proc/pid/comm 获取进程的启动命令
func readProcComm(pid int) (string, error) {
    comm, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
    if err == nil {
        // removes newline character
        comm = bytes.TrimSuffix(comm, []byte("\n"))
    }

    if comm == nil || len(comm) <= 0 {
        // /proc/pid/comm 读取失败时，从 /proc/pid/stat 中解析
        stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
        if err != nil {
            return "", fmt.Errorf("could not read proc stat: %v", err)
        }
        expr := fmt.Sprintf("%d\\s*\\((.*)\\)", pid)
        rexp, err := regexp.Compile(expr)
        if err != nil {
            return "", fmt.Errorf("regexp compile error: %v", err)
        }
        match := rexp.FindSubmatch(stat)
        if match == nil {
            return "", fmt.Errorf("no match found using regexp '%s' in /proc/%d/stat", expr, pid)
        }
        comm = match[1]
    }

    cmdStr := strings.ReplaceAll(string(comm), "%", "%%")
    return cmdStr, nil
}

// readProcCommArgs 读取 /proc/pid/cmdline 获取进程的启动参数
func readProcCommArgs(pid int) ([]string, error) {
    dat, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
    if err != nil {
        return nil, err
    }
    args := strings.Split(string(dat), string([]byte{0}))[1:]
    return args, nil
}
```

几个细节：

- `/proc/pid/comm` 是内核侧 task_struct.comm 的投影，最多 15 字节加一个 `\0`，读出来要 trim 掉换行；读不到时从 `/proc/pid/stat` 里按 `pid (comm)` 的格式解析兜底；
- `/proc/pid/cmdline` 是 NUL 分隔的完整命令行，第 0 项是程序路径（argv[0]），后面的才是参数，所以 Args 取 `[1:]`；
- `comm` 里的 `%` 被替换成 `%%`，避免这个字符串之后被当格式串使用时出问题。

配套的 `pkg/target/procfs_test.go` 用 pid 1（init/systemd）验证了这两个函数：comm 非空、args 返回合法 slice。

> ps: 这段能力原计划放 ch6.3，后来按"每节只做本节的事"重新归位：attach 的启动信息记录属于 attach 本身，放在本节讲；exec/debug 启动的进程本来就知道启动命令与参数，不需要从 `/proc` 读。Command/Args 目前还只是记录下来，restart 调试命令留待后续章节实现。



### 代码测试

我们先在bash启动一个命令，这个命令的执行效果是每隔1s打印下当前进程的pid，然后我们执行 `godbg attach <pid>` 来跟踪该进程。

```bash
$ while [ 1 -eq 1 ]; do t=`date`; echo "$t pid: $$"; sleep 1; done

Sat Nov 14 14:29:09 UTC 2020 pid: 1311
Sat Nov 14 14:29:10 UTC 2020 pid: 1311
Sat Nov 14 14:29:11 UTC 2020 pid: 1311
Sat Nov 14 14:29:12 UTC 2020 pid: 1311
Sat Nov 14 14:29:13 UTC 2020 pid: 1311
Sat Nov 14 14:29:14 UTC 2020 pid: 1311  ==> 14s
^C
```

然后我们执行命令：

```bash
$ go run main.go attach 1311

process 1311 attached, stopped by SIGSTOP
thread 1311 attached
godbg>
```

观察：
- 执行完上述命令后，回来看shell命令的输出情况，可见其被挂起了；
- 等了10s之后我们执行exit命令，让调试器退出，此时会执行detach操作，tracee恢复执行，继续每隔1s输出pid信息；

```
Sat Nov 14 14:29:09 UTC 2020 pid: 1311
Sat Nov 14 14:29:10 UTC 2020 pid: 1311
Sat Nov 14 14:29:11 UTC 2020 pid: 1311
Sat Nov 14 14:29:12 UTC 2020 pid: 1311
Sat Nov 14 14:29:13 UTC 2020 pid: 1311
Sat Nov 14 14:29:14 UTC 2020 pid: 1311  ==> at 14s, attached and stopped

Sat Nov 14 14:29:24 UTC 2020 pid: 1311  ==> at 24s, detached and continued
Sat Nov 14 14:29:25 UTC 2020 pid: 1311
Sat Nov 14 14:29:26 UTC 2020 pid: 1311
Sat Nov 14 14:29:27 UTC 2020 pid: 1311
Sat Nov 14 14:29:28 UTC 2020 pid: 1311
^C
```

### 问题探讨

为了让读者能快速掌握核心调试原理，示例里我们有意识地使用了单线程的进程。如果是一个多线程程序结果会不会不一样呢？会！

#### 问题：多线程程序 attach 后仍在运行？

假如我使用下面的 go 程序做为被调试程序，结果发现执行了 `godbg attach <pid>` 之后程序还在执行，这是为什么呢？

```go
import (
    "fmt"
    "time"
    "os"
)
func main() {
    for  {
        time.Sleep(time.Second)
        fmt.Println("pid:", os.Getpid())
    }
}
```

有几个 go 语言相关的细节需要先说明：

1. go 程序天然是多线程程序，sysmon、gc 等等都可能会用到独立线程，我们执行 `attach <pid>` 只是跟踪了进程中的主线程，其他的线程仍然是没有被跟踪的，是可以继续执行的。
2. go 运行时采用 GMP 调度机制，同一个 goroutine 在生命周期能可能会在多个 thread 上先后执行一部分代码逻辑，比如某个 goroutine 执行阻塞系统调用后，会创建出新的线程，如果系统调用返回后，goroutine 也要恢复执行，此时有可能会去找之前的 thread，但是根据调度负载情况、原先 M、原先 P 空闲情况，非常有可能这个 goroutine 会在另一个 thread 中继续执行，而该 thread 没有被调试器跟踪，依然可以继续执行。
3. 具体到我们示例中，ptrace 指定的 pid 是主线程 pid，而 main.main 是 main goroutine 的入口函数，但是 main goroutine 却不一定总是在主线程中执行。

附录《go runtime: go 程序启动流程》中对 go 程序的启动流程做了分析，可以帮读者朋友打消这里 runtime.main、main.main 在 main goroutine、main thread 中执行细节的一些疑虑。**go 程序中函数 main.main 是由 main goroutine 来执行的，但是 main goroutine 并没有和 main thread 存在调度上的绑定关系**。实际上执行main.main之前，main goroutine就解绑了和main thread的调度绑定关系。所以认为 main.main 一定运行在进程主线程上是错误的（联想 GMP 调度机制，main goroutine 一开始就不一定运行在主线程上，而且也没有上述提及的 runtime.LockOSThread() 会一直保证运行在特定线程上）！

在 Linux 下，线程其实是通过轻量级进程（LWP）来实现的，这里的 ptrace 参数 pid 实际上是主线程对应的 LWP 的 pid。只对这个 pid 进行 ptrace attach 操作，作用是，这个 pid 对应的线程会被跟踪，但是进程中的其他线程并没有被跟踪，它们仍然可以继续执行。这就是为什么我们自己写个 go 程序验证下 attach 功能，会发现被调试程序仍然在不停输出，因为 tracer 并没有在 main.main 内部设置断点，执行该函数 main.main 的 main goroutine 可能由其他未被跟踪的线程执行。

#### 问题：go 进程中线程是如何创建出来的？

一个多线程程序，程序可以通过执行 "**系统调用 clone+选项 CLONE_THREAD**" 来创建新线程，新线程的 pid `os.Getpid()` 和从属的进程拥有相同的 pid。

对于 go 语言，go 运行时在初始化时、后续执行期间需要创建新线程时，会通过 `runtime.newosproc` -> `clone+cloneFlags` 来创建线程：

```go
cloneFlags = _CLONE_VM | /* share memory */
  _CLONE_FS | /* share cwd, etc */
  _CLONE_FILES | /* share fd table */
  _CLONE_SIGHAND | /* share sig handler table */
  _CLONE_SYSVSEM | /* share SysV semaphore undo lists (see issue #20763) */
  _CLONE_THREAD /* revisit - okay for now */

func newosproc(mp *m) {
    stk := unsafe.Pointer(mp.g0.stack.hi)
    ...
    ret := retryOnEAGAIN(func() int32 {
        r := clone(cloneFlags, stk, unsafe.Pointer(mp), unsafe.Pointer(mp.g0), unsafe.Pointer(abi.FuncPCABI0(mstart)))
        // clone returns positive TID, negative errno.
        // We don't care about the TID.
        if r >= 0 {
            return 0
        }
        return -r
    })
    ...
}
```

> ps: 关于 clone 选项的更多作用，您可以通过查看 man 手册 `man 2 clone` 来了解。

#### 问题：想确保执行 main.main 的线程停下来？

在不考虑 main.main->forloop 位置设断点的情况下，如果只是想让所有线程在 attach 时都能尽快停下来，需要采用 All-stop Mode。

调试器需要在 attach 主线程成功后，枚举进程包含的所有线程，并对它们逐一进行 ptrace attach 操作。Linux 下可以列出 `/proc/<pid>/task` 下的所有线程的 pid（LWP 的 pid，而非进程内线程编号 tid）。

```go
func (p *DebuggedProcess) loadThreadList() ([]int, error) {
    threadIDs := []int{}

    tids, _ := filepath.Glob(fmt.Sprintf("/proc/%d/task/*", p.Process.Pid))
    for _, tidpath := range tids {
        tidstr := filepath.Base(tidpath)
        tid, err := strconv.Atoi(tidstr)
        if err != nil {
            return nil, err
        }
        threadIDs = append(threadIDs, tid)
    }
    return threadIDs, nil
}
```

对进程内每个线程逐个执行 ptrace attach，所有线程也就都停下来了。All-stop Mode 很重要，这里也算是提前了解下。godbgv2 中这个能力在 6.17.1 节"跟踪已创建线程"中实现。

> 调试活动通常是带有目的性的调试，而不是漫无目的地闲逛，这样调试效率才会高。调试很重要的一点就是，在可疑代码处先提前设置好断点，执行到此位置的线程自然会停下来。如果没有提前设置好断点，可疑位置代码已经执行过了，就只能重新开始调试会话了。对于多线程程序，为了方便观察多个线程的运行情况甚至是线程间的交互情况，通常这些线程要么全部运行要么全部停止。

#### 问题：如何判断进程是否是多线程程序？

如何判断目标进程是否是多线程程序呢？有两种简单的办法帮助判断。

- `top -H -p pid`

  `-H` 选项将列出进程 pid 下的线程列表，以下进程 5293 下有 4 个线程，Linux 下线程是通过轻量级进程实现的，PID 列为 5293 的轻量级进程为主线程。

  ```bash
  $ top -H -p 5293
  ........
  PID USER      PR  NI    VIRT    RES    SHR S %CPU %MEM     TIME+ COMMAND
   5293 root      20   0  702968   1268    968 S  0.0  0.0   0:00.04 loop
   5294 root      20   0  702968   1268    968 S  0.0  0.0   0:00.08 loop
   5295 root      20   0  702968   1268    968 S  0.0  0.0   0:00.03 loop
   5296 root      20   0  702968   1268    968 S  0.0  0.0   0:00.03 loop
  ```

  top 展示信息中列 S 表示进程状态，常见的取值及含义如下：

  ```bash
  'D' = uninterruptible sleep
  'R' = running
  'S' = sleeping
  'T' = traced or stopped
  'Z' = zombie
  ```

  通过状态 **'T'** 可以识别多线程程序中哪些线程正在被调试跟踪。
- `ls /proc/<pid>/task`

  ```bash
  $ ls /proc/5293/task/

  5293/ 5294/ 5295/ 5296/
  ```

  Linux 下 /proc 是一个虚拟文件系统，它里面包含了系统运行时的各种状态信息，以下命令可以查看到进程 5293 下的线程。和 top 展示的结果是一样的。

### 本节小结

attach 操作是调试器调试运行中进程的第一步。本节在 6.1 节的跟踪基础上，实现了 `godbg attach <pid>`：

- 对比了两种建立跟踪关系的方式：exec 走 PTRACE_TRACEME（tracee 因 SIGTRAP 停在 exec 处），attach 走 PTRACE_ATTACH（内核注入 SIGSTOP，tracee 因 SIGSTOP 停住），tracer 侧等待停稳的方式都是 wait4 + WSTOPPED；
- 分析了 attach 失败的常见原因：目标线程已被其他调试器跟踪、凭据检查不通过、tracee 处于 nondumpable 状态、Yama LSM 的 ptrace_scope 限制；
- 在 godbgv2 中实现了命令层、服务层、目标层的完整调用链，并补充了对应的单元测试；
- attach 成功后用 initialize 读取 `/proc/pid/comm`、`/proc/pid/cmdline`，把目标进程的启动命令与参数记录到 `DebuggedProcess.Command/Args`，为后续 restart 调试做准备（exec/debug 的场景天然已知，不需要读 /proc）；
- 结合 Go 的协程编程模型，解释了 attach 多线程程序后"停不下来"的现象：attach 只跟踪了主线程，执行 main.main 的 main goroutine 并不绑定在主线程上，其他线程仍在运行；要解决这个问题需要 All-stop Mode，枚举 `/proc/<pid>/task` 逐个 attach，这部分在 6.17.1 节实现。

通过这些内容，我们梳理并解答了 attach 实现过程中一些基础但至关重要的问题，为后续深入理解调试器的实现原理打下了坚实的基础。
