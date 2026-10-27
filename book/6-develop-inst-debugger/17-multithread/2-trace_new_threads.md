## 调试多线程程序 - 跟踪新创建线程

### 实现目标：感知新线程创建并跟踪

进程执行过程中有可能会创建新线程，尤其是像Go程序这样，为了充分利用多核CPU资源，会自动创建新线程来执行goroutine。当某些goroutine执行阻塞型系统调用导致线程阻塞时，Go运行时为了维持GMP调度的正常运转还会创建新的线程来执行goroutines。在Go进程初始化时，也会创建专门的线程来执行sysmon任务，轮询netpoller、timer、强制GC等任务 …… OK，Go语言虽然是面向goroutine的并发控制，本质上还是依赖线程，依赖操作系统对线程的调度控制能力，然后才是GMP中work-stealing的方式线程执行goroutine的逻辑。

说这么多，只是为了强调Go进程执行过程中，可能会随时创建一些新线程出来。作为调试器，我们需要具备感知新线程创建、主动跟踪的能力。我们需要了解线程是什么，Linux是如何创建线程的，Go运行时是如何创建线程的，有那些系统层面的支持能够方便我们感知新线程创建了，并对新线程的执行进行即时的跟踪控制。本节我们就来看看如何实现这个目标。

### 基础知识

#### 线程是如何创建的

newosproc创建一个新的线程（newproc创建一个新的goroutine)，是通过 `clone` 系统调用来完成的，注意看cloneFlags以及clone操作实现。

```go
// clone创建线程时的克隆参数
const (
    cloneFlags = _CLONE_VM | /* share memory */
        _CLONE_FS | /* share cwd, etc */
        _CLONE_FILES | /* share fd table */
        _CLONE_SIGHAND | /* share sig handler table */
        _CLONE_SYSVSEM | /* share SysV semaphore undo lists (see issue #20763) */
        _CLONE_THREAD /* revisit - okay for now */
)

// 创建一个新的线程
func newosproc(mp *m) {
    stk := unsafe.Pointer(mp.g0.stack.hi)
    /*
     * note: strace gets confused if we use CLONE_PTRACE here.
     */
    if false {
        print("newosproc stk=", stk, " m=", mp, " g=", mp.g0, " clone=", abi.FuncPCABI0(clone), " id=", mp.id, " ostk=", &mp, "\n")
    }

    // Disable signals during clone, so that the new thread starts
    // with signals disabled. It will enable them in minit.
    var oset sigset
    sigprocmask(_SIG_SETMASK, &sigset_all, &oset)
    ret := clone(cloneFlags, stk, unsafe.Pointer(mp), unsafe.Pointer(mp.g0), unsafe.Pointer(abi.FuncPCABI0(mstart)))
    sigprocmask(_SIG_SETMASK, &oset, nil)

    if ret < 0 {
        print("runtime: failed to create new OS thread (have ", mcount(), " already; errno=", -ret, ")\n")
        if ret == -_EAGAIN {
            println("runtime: may need to increase max user processes (ulimit -u)")
        }
        throw("newosproc")
    }
}

//go:noescape
func clone(flags int32, stk, mp, gp, fn unsafe.Pointer) int32
```

进程下的线程，共享进程打开的某些资源，通过上述cloneFlags也可以看出一点端倪。操作系统设计上，进程是资源分配单位，线程则是最小的调度单位。以Linux为例，不管是进程还是线程，它们都由对应的task_struct结构来描述，并作为sched_entity在内核任务调度器中进行调度。ps: 关于Linux下的任务调度，感兴趣您可以阅读我的博客 [Linux内核](https://www.hitzhangjie.pro/categories/linux%E5%86%85%E6%A0%B8/) 任务调度相关内容。

上述clone函数在amd64架构下的实现，详见 go/src/runtime/sys_linux_amd64.s:

```asm
 // int32 clone(int32 flags, void *stk, M *mp, G *gp, void (*fn)(void));
TEXT runtime·clone(SB),NOSPLIT,$0
    MOVL    flags+0(FP), DI     // 准备系统调用参数
    MOVQ    stk+8(FP), SI
    ...

    // Copy mp, gp, fn off parent stack for use by child.
    // Careful: Linux system call clobbers CX and R11.
    MOVQ    mp+16(FP), R13
    MOVQ    gp+24(FP), R9
    MOVQ    fn+32(FP), R12
    ...

    MOVL    $SYS_clone, AX   // clone系统调用号
    syscall                  // 执行系统调用

    // In parent, return.
    CMPQ    AX, $0
    JEQ     3(PC)
    MOVL    AX, ret+40(FP)   // 父进程，返回clone出的新线程的tid
    RET

    // In child, on new stack.
    MOVQ    SI, SP

    // If g or m are nil, skip Go-related setup.
    CMPQ    R13, $0          // m
    JEQ     nog2
    CMPQ    R9, $0           // g
    JEQ     nog2

    // Initialize m->procid to Linux tid
    MOVL    $SYS_gettid, AX
    SYSCALL
    MOVQ    AX, m_procid(R13)

    // In child, set up new stack
    get_tls(CX)
    MOVQ    R13, g_m(R9)
    MOVQ    R9, g(CX)
    MOVQ    R9, R14          // set g register
    CALL    runtime·stackcheck(SB)

nog2:
    // Call fn. This is the PC of an ABI0 function.
    CALL    R12              // 新线程，初始化相关的gmp调度，开始执行线程函数mstart，
                             // clone参数中有个 abi.FuncPCABI0(mstart)
    ...
```

由此可知，其实只要tracee执行系统调用clone时，内核给我们一个通知就可以了。

#### 向内核注册clone跟踪动作

**方法1**：通过 `syscall.PtraceSyscall(pid, signal)` 检查有无clone被调用事件

这样tracee执行系统调用clone时，在enter syscall clone、exit syscall clone的位置会停下来，方便我们做点调试方面的工作，我们就可以读取此时RAX寄存器的值来判断当前系统调用号是不是 `__NR_clone` ，如果是，那说明执行了系统调用clone，我们就可以借此判断创建了一个新的线程。同样的可以在exit syscall的时候用类似的办法去获取新线程的tid信息。

通过这个办法可以感知到tracee创建了新线程，这是一个办法，但是这个办法 `syscall.PtraceSyscall(pid, signal)` 过于通用了，你还要懂点ABI调用惯例（比如通过寄存器分配来传递系统调用号、返回值信息），使用起来就没有那么方便。

**方法2**：通过 `syscall.PtraceSetOptions(pid, opts)` 指定 `PTRACE_O_TRACECLONE` 让内核自动跟踪clone

执行这个操作，需要先attach tracee之后，比如attach运行中的进程执行 `syscall.PtraceAttach(pid)` ，或者 `exec.Cmd.Ptrace=true` 指定execve时执行PTRACE_TRACEME操作。在这之后，就可以显示通过 `syscall.PtraceSetOptions(pid, opts)` 传递选项 `PTRACE_O_TRACECLONE` ，这个操作是专门为跟踪clone系统调用而设置的。

对于跟踪新线程、新进程创建而言，第二种方法更聚焦、更有针对性，容易理解和维护，设计实现时我们将采用第二种方法。在调试时跟踪任意系统调用时，就需要使用第一种方法了，后面扩展阅读部分，我们也会单独一节对此进行进一步的介绍。

#### 接收内核通知的clone调用事件

在执行完上述设置之后，tracee在执行clone操作时，tracer便会收到通知。

1. tracee执行clone系统调用时，内核会给tracee发送一个SIGTRAP信号，内核会暂停tracee执行，并通知tracer。
2. tracer需要主动去感知这个事件的发生，有两个办法：

**方法1**： 通过SIGCHLD信号去感知这个事件的发生

内核会发送信号SIGCHLD给tracer，并通过si_status==SIGTRAP来说明是调试引起的。想进一步获取是因为哪个系统调用导致的，则可以通过 `syscall.PtraceGetRegs` 来从寄存器中获取系统调用编号，通过与clone系统调用编号比较即可判断当前tracee是否执行的是clone操作。si_pid字段则包含了新创建的线程pid，也就是新线程的tid。

```c
siginfo_t {
        int      si_signo;     /* Signal number */
        int      si_errno;     /* An errno value */
        int      si_code;      /* Signal code */
        int      si_trapno;    /* Trap number that caused
                                      hardware-generated signal
                                      (unused on most architectures) */
        pid_t    si_pid;       /* Sending process ID */
        uid_t    si_uid;       /* Real user ID of sending process */
        int      si_status;    /* Exit value or signal */
        ...
}
 
SIGCHLD fills in si_pid, si_uid, si_status, si_utime, and
    si_stime, providing information about the child.  The si_pid
    field is the process ID of the child; si_uid is the child's
    real user ID.  The si_status field contains the exit status of
    the child (if si_code is CLD_EXITED), or the signal number that
    caused the process to change state.   
```

**方法2**：通过waitpid()去感知这个事件的发生

通过waitpid()是更常用的感知tracee的运行状态发生了改变的方法，执行clone系统调用的线程完成该操作后会暂停，waitpid会在status字段中记录发生了PTRACE_EVENT_CLONE事件，这样tracer就可以判断出是tracee执行clone系统调用导致的。然后就可以借助 `newpid, syscall.PtraceGetEventMsg(pid)`来获取新线程的pid信息。

see: `man 2 ptrace` 中关于选项 PTRACE_O_TRACECLONE 的说明

```bash
PTRACE_O_TRACECLONE (since Linux 2.5.46)
    Stop the tracee at the next clone(2) and automatically start tracing the newly cloned process, which will start with a SIGSTOP, or PTRACE_EVENT_STOP if PTRACE_SEIZE was used.  A  waitpid(2)
    by the tracer will return a status value such that

    status>>8 == (SIGTRAP | (PTRACE_EVENT_CLONE<<8))

    The PID of the new process can be retrieved with PTRACE_GETEVENTMSG.

    This  option  may not catch clone(2) calls in all cases.  If the tracee calls clone(2) with the CLONE_VFORK flag, PTRACE_EVENT_VFORK will be delivered instead if PTRACE_O_TRACEVFORK is set;
    otherwise if the tracee calls clone(2) with the exit signal set to SIGCHLD, PTRACE_EVENT_FORK will be delivered if PTRACE_O_TRACEFORK is set.
```

tracer如果确定了是clone导致的以后，可以进一步通过 `newpid, _ = syscall.PtraceGetEventMsg(pid)` 拿到新线程的pid信息。

3、拿到线程pid之后就可以将新线程纳入跟踪，我们可以选择放行新线程，或者暂停新线程、读写数据、观察并控制执行。

#### 关于syscall.PtraceGetEventMsg的说明

如果我们使用ptrace的PTRACE_GETEVENTMSG操作来获取新创建线程的tid，应该注意些什么呢？

- 这个event会存多久，
- 这个event什么时候会被清空，
- 当检测到一个新线程创建时需要理解执行该操作吗？
- 可以wait到N(N>1)个线程创建后，再执行该操作吗？

这几个问题促使我们思考event的生成、存储、清空机制，这里我们进行了一个简单的总结：

| 触发情况                         | 消息是否被清除 | 说明                           |
| -------------------------------- | -------------- | ------------------------------ |
| `PTRACE_CONT` 或 `PTRACE_DETACH` | **是**         | 子进程继续执行，内核清空缓冲区 |
| 再次出现 `PTRACE_EVENT`          | **是**         | 新事件写入时覆盖旧消息         |
| 进程退出                         | **是**         | 进程结束，内核销毁结构         |
| `PTRACE_GETEVENTMSG`             | **否**         | 只读取，不清空                 |

> **最佳实践**：
>
> 1. **在每次 `waitpid()` 返回 `SIGTRAP|0x80`（即 ptrace 事件）后立即读取事件消息**。
> 2. **随后立即发 `PTRACE_CONT`**，完成一轮“事件‑读取‑继续”循环。
> 3. 这样既能拿到所有事件消息，又能避免消息被后续事件或 `CONT` 覆盖。

这样设计，ptrace 调试过程才能顺利、准确地捕获所有 `PTRACE_EVENT` 的信息

#### 关于线程tid、pid的说明

当我们提tid的时候，其实是想说线程ID，当提pid的时候是想提线程所属进程的pid。但是有些系统调用似乎却不是这样的惯例，比如ptrace系统调用 `ptrace(pid, ...)` 尽管它的操作对象是线程，但是却用了pid这样的命名，为什么呢？这要从内核设计实现来说起。

在 Linux 内核里，**所有的可调度实体都是 `task_struct`**。“进程”并不是一种独立的结构，而是 **一组共享相同内存（`mm_struct`）的线程** 的集合——这组线程被称为 **线程组（thread group）**。

- **线程组的首个成员（线程组首领）** 的 `pid` 与 `tgid` 相等，我们习惯叫法是 “主线程"；
- **其它成员**（即主线程以外的“线程”）的 `pid` 与 `tgid` 不相等，它们的 `tgid` 与组首领的 `pid` 相同。

不管是进程还是线程，它们都由各自的task_struct来表示，它们共享的内存区域则由task_struct->mm_struct来表示，其他共享的信息则通过task_struct->thread_group来描述。因为线程是通过clone时指定一些特殊的共享选项来创建出来的，task_struct中的很多信息共享自主线程，是比较轻量的，所以也经常称之为LWP（轻量级进程，Light Weight Process)。`/proc/processID/task/threadID`，threadID其实就是每个线程对应的task_struct->pid，而进程processID就是线程对应的task_struct->tgid。

系统调用里面有些函数参数定义为pid，这种一般指的是各个线程的task_struct->pid这个概念，比如ptrace系统调用。但是也有些系统调用或者库函数命名上容易让人产生歧义：

- getpid，获取调用方所属的进程的pid，也就是线程所属进程的进程pid，或者说线程的tgid；
- gettid，获取线程的pid（线程对应的task_struct->pid）；

有时候文中会混用pid、tid概念，请读者朋友根据语境区分我们指的是线程所属进程的pid，还是线程自身的pid。

### 代码实现

godbgv2 在 ch6.17.2 中把“跟踪新线程”拆成三个动作：注册 `PTRACE_O_TRACECLONE`、等待任意线程停止、从克隆事件中取出新线程 tid 并加入线程列表。

#### 注册 PTRACE_O_TRACECLONE

exec 启动路径在 `launchCommand` 之后立即设置选项：

**file：pkg/target/process.go**（片段）

```go
	err = dbp.ExecPtrace(func() error {
		// start and trace
		dbp.Process, err = dbp.launchCommand(cmd, args...)
		if err != nil {
			return err
		}

		// 自动跟踪新创建的线程（ch6.17.2）
		return syscall.PtraceSetOptions(dbp.Process.Pid, syscall.PTRACE_O_TRACECLONE)
	})
```

attach 路径则在 `addThread` 里为每个已跟踪线程设置同样的选项：

**file：pkg/target/thread.go**（片段）

```go
func (p *DebuggedProcess) addThread(tid int, attach bool) (*Thread, error) {
    ...
	// 自动跟踪该线程后续 clone 出的新线程（ch6.17.2）：
	// 设置 PTRACE_O_TRACECLONE 后，内核会在 clone 时停止克隆者
	// 并自动跟踪新线程（新线程以 SIGSTOP 开始）。
	err := p.ExecPtrace(func() error {
		return syscall.PtraceSetOptions(tid, syscall.PTRACE_O_TRACECLONE)
	})
	if err == syscall.ESRCH {
		// 线程可能恰在此时退出，等待其停止事件后重试一次
		if _, _, err := p.waitFast(tid); err != nil {
			return nil, fmt.Errorf("error while waiting after adding thread: %d %s", tid, err)
		}
		err := p.ExecPtrace(func() error {
			return syscall.PtraceSetOptions(tid, syscall.PTRACE_O_TRACECLONE)
		})
		if err == syscall.ESRCH {
			return nil, err
		}
		if err != nil {
			return nil, fmt.Errorf("could not set options for new traced thread %d %s", tid, err)
		}
	}
    ...
}
```

`PTRACE_O_TRACECLONE` 是“一次设置、持续生效”的选项：设置之后，该线程每次执行 clone 创建新线程时，内核都会在 clone 返回处让克隆者停下，并自动把新线程纳入跟踪。因此 exec 路径只需要在启动时对主线程设置一次，attach 路径则要对枚举出来的每个线程分别设置。

新线程被内核自动跟踪后，会以一个初始 SIGSTOP 开始。调试器不能假设只等待主线程就够，否则这个 SIGSTOP 会一直挂在等待队列里，后续 `wait` 会先把它取出来。

#### 等待任意线程停止

**file：pkg/target/ptrace_linux.go**（片段）

```go
// waitAny 等待任意被跟踪线程进入停止状态。
//
// 线程组 leader 已退出但留下僵尸子线程时，直接 wait4 会永远阻塞，
// 因此以 WNOHANG 轮询，直到 wait4 成功或发现 leader 已成僵尸。
func (p *DebuggedProcess) waitAny(options int) (int, *syscall.WaitStatus, error) {
	var s syscall.WaitStatus
	for {
		wpid, err := syscall.Wait4(-1, &s, syscall.WNOHANG|syscall.WALL|options, nil)
		if err != nil {
			return 0, nil, err
		}
		if wpid != 0 {
			return wpid, &s, nil
		}
		if status(p.Process.Pid, p.Command) == statusZombie {
			return p.Process.Pid, nil, nil
		}
		time.Sleep(200 * time.Millisecond)
	}
}
```

`waitAny` 的第一个参数是 `-1`，表示等待任意被跟踪线程，而不是像以前那样只等待主线程 pid。它用 `WNOHANG` 轮询而不是阻塞式 `wait4`，是因为线程组 leader 退出后可能留下僵尸子线程，直接阻塞会永远等不到。

#### 从克隆事件中取出新线程

**file：pkg/target/continue.go**（片段）

```go
// Continue 恢复被调试进程执行，等待其停止，返回停止原因。
//
// ch6.17.2 起：若停止事件是线程克隆事件（PTRACE_EVENT_CLONE），
// 读取新线程 tid 并自动跟踪之，然后报告该事件。
// （all-stop 挂起策略将在 ch6.17.3 中实现）
func (p *DebuggedProcess) Continue() (*api.StopInfo, error) {
	pid := p.Process.Pid

	err := p.ExecPtrace(func() error {
		err := syscall.PtraceCont(pid, 0)
		if err == syscall.ESRCH {
			return nil
		}
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("ptrace cont thread %d err: %v", pid, err)
	}

	// 等待任意被跟踪线程停止
	wpid, status, err := p.waitAny(syscall.WSTOPPED)
	if err != nil {
		return nil, fmt.Errorf("wait error: %v", err)
	}
	if status == nil {
		// 目标进程已退出（zombie）
		return &api.StopInfo{PID: wpid, Reason: "exited"}, nil
	}

	// 克隆事件：新线程已被内核自动跟踪，读取其 tid 并加入线程列表
	if status.Stopped() && status.TrapCause() == syscall.PTRACE_EVENT_CLONE {
		newTid, err := p.getEventMessage(wpid)
		if err != nil {
			return nil, fmt.Errorf("get event msg error: %v", err)
		}
		if _, err := p.addThread(newTid, false); err != nil {
			return nil, fmt.Errorf("add thread error: %v", err)
		}
		return &api.StopInfo{
			PID:    wpid,
			Reason: fmt.Sprintf("PTRACE_EVENT_CLONE: new thread %d", newTid),
		}, nil
	}

	return &api.StopInfo{PID: wpid, Reason: descStatus(status)}, nil
}

// getEventMessage 读取线程tid最近一次 ptrace 事件附带的消息
func (p *DebuggedProcess) getEventMessage(tid int) (int, error) {
	var msg uint
	err := p.ExecPtrace(func() error {
		var err error
		msg, err = syscall.PtraceGetEventMsg(tid)
		return err
	})
	return int(msg), err
}
```

`waitAny` 返回后，`Continue` 先用 `status.TrapCause()` 判断这是否是 `PTRACE_EVENT_CLONE`。如果是，就立刻用 `PtraceGetEventMsg` 读取事件附带的消息——也就是新线程的 tid——并调用 `addThread(newTid, false)` 把它加入线程列表。这里传 `false`，是因为内核已经自动跟踪了新线程，不需要再次 `PTRACE_ATTACH`。

注意，此时返回给上层的 `StopInfo` 理由是 `PTRACE_EVENT_CLONE: new thread <tid>`，而不是普通的 `stopped: ...`。ch6.17.2 只做到“感知并跟踪新线程”，还没有实现 all-stop 挂起策略，所以这时新线程自身的初始 SIGSTOP 仍可能在下一次 `waitAny` 时被当作普通停止事件报告出来；ch6.17.3 会把克隆事件当作内部事件消费掉，继续等待真正的停止事件。

> ps：上述代码取自 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.17.2`。本节新增的是 `PTRACE_O_TRACECLONE` 的注册、`waitAny` 和克隆事件处理；命令层的 `continue`、`addThread` 的线程列表管理沿用 ch6.17.1 已有实现，`getEventMessage` 是对 `PTRACE_GETEVENTMSG` 的简单封装。

### 代码测试

测试目标仍是 godbgv2 自带的 `_fixtures/loop2`。它的主协程和子协程会持续运行，Go 运行时在启动过程中会创建新的 OS 线程，正好可以用来观察克隆事件。

切换到本节代码并构建：

```bash
$ git checkout ch6.17.2
$ make build
$ make fixtures
```

用 `godbg exec` 启动调试会话，然后执行一次 `continue`：

```bash
$ ./godbg exec _fixtures/loop2
process 2369083 launched, stopped by SIGTRAP
godbg> continue
thread 2369083 status: PTRACE_EVENT_CLONE: new thread 2369086
godbg> pregs
Register    Value
Rip         0x478912
Rsp         0x7fffe9a9f190
Rbp         0x7fffe9a9f1c8
Rax         0xffffffffffffffda
Rbx         0x569338
...
godbg> exit
tracee is run by tracer, kill it
```

进程被 `exec` 启动后先因 SIGTRAP 停在入口处。`continue` 恢复主线程执行，Go 运行时初始化时调用 clone 创建新线程，内核在克隆事件处停下克隆者，并把新线程 2369086 纳入跟踪。`waitAny` 等到这个事件后，`Continue` 读出事件消息中的 tid，把它加入 `Threads`，然后把 `PTRACE_EVENT_CLONE: new thread 2369086` 报告给命令层。

此时 `pregs` 打印的是当前线程（主线程 2369083）的寄存器快照。`Rip 0x478912` 位于 `runtime.clone` 中 `syscall` 指令的返回处，`OrigRax 0x38` 是 clone 的系统调用号，说明主线程正停在发起 clone 的运行时代码中。

> ps：每次运行创建线程的时机、tid 和栈地址都会不同，有时第二次 `continue` 看到的是另一个克隆事件，有时看到的是新线程的初始 SIGSTOP（输出形如 `thread <tid> status: stopped: stopped (signal)`）。前者说明克隆事件被正确识别，后者说明 ch6.17.2 尚未消费新线程的初始停止事件，这正是下一节 all-stop 挂起策略要解决的问题。

### 思考：线程上下文切换特性支持

#### Go语言GMP调度的特殊性

不同于C\C++多线程编程操作时面向线程的，线程函数即业务逻辑，而在go语言中，并不是这样。对于go语言而言，线程有着特殊的意义。go提供的是面向协程goroutine级别的并发，比如chan sendrecv、mutex加解锁等等。由于GMP调度设计的原因，实际上我们也很难知道某个特定的goroutine会在哪个thread上执行，同一个goroutine的完整代码逻辑实际上也不一定会固定在同一个thread上执行 …… 调试go程序时，我们可能极少有诉求去跟踪某个特定的线程的执行情况。

#### 什么时候需要在线程间切换

dlv实际上是提供了 `threads` 和 `thread` 调试命令，来允许调试人员查看当前存在的线程以及在它们之间进行切换。那什么调试情景下我需要用到这个线程切换能力呢？

现在主流调试器对于进程内线程管理，基本上都是采用Stop-all、Start-all Mode（原因就是方便观察、避免线程间同步逻辑异常），所以当我们提到线程间切换的时候，其实指的是将当前调试器命令执行时的上下文（context），切换为目标线程的上下文（context），比如执行命令pregs时打印的就是当前线程的硬件上下文信息，而不是其他被跟踪的线程的硬件上下文信息。

如果调试的线程执行的是cgo代码（这部分代码逻辑不会像goroutine逻辑那样会在线程间迁移），如果调试的goroutine执行了runtime.LockOSThread()，如果需要查看go运行时的底层逻辑，比如GMP调度，或者需要调试看下不同线程的线程可见性问题 …… 确实还是会有些场景需要用到线程上下文切换能力的支持。

### 思考：需要自动切换到新线程吗

那么，对于多线程程序而言，我们跟踪到一个新线程时，是否需要允许用户选择，你需要切换到某个线程上下文去吗？意义应该不大。首先Go主要是面向goroutine级别的并发控制操作，调试时切换线程作用不大。即使前面提到确实有些场景需要线程切换支持，我们也可以手动执行命令 `thread <n>` 来切换，所以没有必要支持自动跟踪并切换到新线程的特性。

### 本节小结

本节主要探讨了调试器如何感知和跟踪新创建线程的技术实现，核心内容包括：通过 `PTRACE_O_TRACECLONE` 选项让内核自动跟踪clone系统调用；利用 `waitAny()` 等待任意被跟踪线程停止，并通过 `PTRACE_EVENT_CLONE` 事件机制感知新线程创建；通过 `PtraceGetEventMsg()` 获取新线程的LWP ID，再以 `addThread(newTid, false)` 将其纳入调试器管理。本节还分析了Linux内核中线程与进程的本质区别，以及Go语言GMP调度模型对线程调试的特殊影响。至于fork/exec出来的新进程该如何跟踪，以及gdb、lldb、dlv各自的多进程调试策略，将在 6.18 节继续介绍。
