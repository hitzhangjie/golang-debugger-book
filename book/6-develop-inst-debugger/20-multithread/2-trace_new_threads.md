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

进程下的线程共享进程打开的某些资源，通过上述cloneFlags也可以看出一点端倪。操作系统设计上，进程是资源分配单位，线程则是最小的调度单位。以Linux为例，不管是进程还是线程，它们都由对应的task_struct结构来描述，并作为sched_entity在内核任务调度器中进行调度。ps: 关于Linux下的任务调度，感兴趣您可以阅读我的博客 [Linux内核](https://www.hitzhangjie.pro/categories/linux%E5%86%85%E6%A0%B8/) 任务调度相关内容。

上述clone函数在amd64架构下的实现，详见 see go/src/runtime/sys_linux_amd64.s:

```go
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

| 触发情况                             | 消息是否被清除 | 说明                           |
| ------------------------------------ | -------------- | ------------------------------ |
| `PTRACE_CONT` 或 `PTRACE_DETACH` | **是**   | 子进程继续执行，内核清空缓冲区 |
| 再次出现 `PTRACE_EVENT`            | **是**   | 新事件写入时覆盖旧消息         |
| 进程退出                             | **是**   | 进程结束，内核销毁结构         |
| `PTRACE_GETEVENTMSG`               | **否**   | 只读取，不清空                 |

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

### 设计实现

#### 准备多线程测试程序

首先为了后面测试方便，我们先用C语言来实现一个多线程程序，程序逻辑很简单，就是每隔一段时间就创建个新线程，线程函数就是打印当前线程的pid，以及线程LWP的pid。

```c
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <pthread.h>

pid_t gettid(void);

void *threadfunc(void *arg) {
    printf("process: %d, thread: %u\n", getpid(), syscall(SYS_gettid));
    sleep(1);
}

int main() {
    printf("process: %d, thread: %u\n", getpid(), syscall(SYS_gettid));

    pthread_t tid;
    for (int i = 0; i < 100; i++)
    {
        if (i % 10 == 0) {
            int ret = pthread_create(&tid, NULL, threadfunc, NULL);
            if (ret != 0) {
                printf("pthread_create error: %d\n", ret);
                exit(-1);
            }
        }
        sleep(1);
    }
    sleep(15);
}

```

这个程序可以这样编译 `gcc -o fork fork.c -lpthread`，然后运行 `./fork` 进行测试，可以看看没有被调试跟踪的时候是个什么运行效果。

#### 调试器跟踪新线程创建

然后我们再来看调试器部分的代码逻辑，这里主要是为了演示tracer（debugger）如何对多线程程序中新创建的线程进行感知，并能自动追踪。

这部分实现代码，详见 [hitzhangjie/golang-debugger-lessons/20_trace_new_threads](https://github.com/hitzhangjie/golang-debugger-lessons/tree/master/20_trace_new_threads)。

```go
package main

import (
    "fmt"
    "os"
    "os/exec"
    "runtime"
    "strconv"
    "syscall"
    "time"
)

var usage = `Usage:
    go run main.go <pid>

    args:
    - pid: specify the pid of process to attach
`

func main() {
    runtime.LockOSThread()

    if len(os.Args) != 2 {
        fmt.Println(usage)
        os.Exit(1)
    }

    // pid
    pid, err := strconv.Atoi(os.Args[1])
    if err != nil {
        panic(err)
    }

    if !checkPid(int(pid)) {
        fmt.Fprintf(os.Stderr, "process %d not existed\n\n", pid)
        os.Exit(1)
    }

    // step1: supposing running dlv attach here
    fmt.Fprintf(os.Stdout, "===step1===: supposing running `dlv attach pid` here\n")

    // attach
    err = syscall.PtraceAttach(int(pid))
    if err != nil {
        fmt.Fprintf(os.Stderr, "process %d attach error: %v\n\n", pid, err)
        os.Exit(1)
    }
    fmt.Fprintf(os.Stdout, "process %d attach succ\n\n", pid)

    // check target process stopped or not
    var status syscall.WaitStatus
    var rusage syscall.Rusage
    _, err = syscall.Wait4(int(pid), &status, 0, &rusage)
    if err != nil {
        fmt.Fprintf(os.Stderr, "process %d wait error: %v\n\n", pid, err)
        os.Exit(1)
    }
    if !status.Stopped() {
        fmt.Fprintf(os.Stderr, "process %d not stopped\n\n", pid)
        os.Exit(1)
    }
    fmt.Fprintf(os.Stdout, "process %d stopped\n\n", pid)

    regs := syscall.PtraceRegs{}
    if err := syscall.PtraceGetRegs(int(pid), &regs); err != nil {
        fmt.Fprintf(os.Stderr, "get regs fail: %v\n", err)
        os.Exit(1)
    }
    fmt.Fprintf(os.Stdout, "tracee stopped at %0x\n", regs.PC())

    // step2: setup to trace all new threads creation events
    time.Sleep(time.Second * 2)

    //opts := syscall.PTRACE_O_TRACEFORK | syscall.PTRACE_O_TRACEVFORK | syscall.PTRACE_O_TRACECLONE
    opts := syscall.PTRACE_O_TRACECLONE
    if err := syscall.PtraceSetOptions(int(pid), opts); err != nil {
        fmt.Fprintf(os.Stderr, "set options fail: %v\n", err)
        os.Exit(1)
    }

    for {
        // 放行主线程，因为每次主线程都会因为命中clone就停下来
        if err := syscall.PtraceCont(int(pid), 0); err != nil {
            fmt.Fprintf(os.Stderr, "cont fail: %v\n", err)
            os.Exit(1)
        }

        // 检查主线程状态，检查如果status是clone事件，则继续获取clone出的线程的lwp pid
        var status syscall.WaitStatus
        rusage := syscall.Rusage{}
        _, err := syscall.Wait4(pid, &status, syscall.WSTOPPED|syscall.WCLONE, &rusage)
        if err != nil {
            fmt.Fprintf(os.Stderr, "wait4 fail: %v\n", err)
            break
        }
        // 检查下状态信息是否是clone事件 (see `man 2 ptrace` 关于选项PTRACE_O_TRACECLONE的说明部分)
        isclone := status>>8 == (syscall.WaitStatus(syscall.SIGTRAP) | syscall.WaitStatus(syscall.PTRACE_EVENT_CLONE<<8))
        fmt.Fprintf(os.Stdout, "tracee stopped, tracee pid:%d, status: %s, trapcause is clone: %v\n",
            pid,
            status.StopSignal().String(),
            isclone)

        // 获取子线程对应的LWP的pid
        msg, err := syscall.PtraceGetEventMsg(int(pid))
        if err != nil {
            fmt.Fprintf(os.Stderr, "get event msg fail: %v\n", err)
            break
        }
        fmt.Fprintf(os.Stdout, "eventmsg: new thread lwp pid: %d\n", msg)

        // 放行子线程继续执行
        _ = syscall.PtraceDetach(int(msg))

        time.Sleep(time.Second * 2)
    }

}

// checkPid check whether pid is valid process's id
//
// On Unix systems, os.FindProcess always succeeds and returns a Process for
// the given pid, regardless of whether the process exists.
func checkPid(pid int) bool {
    out, err := exec.Command("kill", "-s", "0", strconv.Itoa(pid)).CombinedOutput()
    if err != nil {
        panic(err)
    }

    // output error message, means pid is invalid
    if string(out) != "" {
        return false
    }

    return true
}

```

### 代码测试

1、先看看testdata/fork.c，这个程序每隔一段时间就创建一个pthread线程出来

主线程、其他线程创建出来后都会打印该线程对应的pid、tid（这里的tid就是对应的lwp的pid）

```bash
zhangjie🦀 testdata(master) $ ./fork 
process: 35573, thread: 35573
process: 35573, thread: 35574
process: 35573, thread: 35716
process: 35573, thread: 35853
process: 35573, thread: 35944
process: 35573, thread: 36086
process: 35573, thread: 36192
process: 35573, thread: 36295
process: 35573, thread: 36398
...
```

2、我们同时观察 `./20_trace_new_threads $(pidof fork)` 的执行情况

```bash
zhangjie🦀 20_trace_new_threads(master) $ ./20_trace_new_threads 35573
===step1===: supposing running `dlv attach pid` here
process 35573 attach succ

process 35573 stopped
tracee stopped at 7f318346f098

tracee stopped, tracee pid:35573, status: trace/breakpoint trap, trapcause is clone: true
eventmsg: new thread lwp pid: 35716
tracee stopped, tracee pid:35573, status: trace/breakpoint trap, trapcause is clone: true
eventmsg: new thread lwp pid: 35853
tracee stopped, tracee pid:35573, status: trace/breakpoint trap, trapcause is clone: true
eventmsg: new thread lwp pid: 35944
tracee stopped, tracee pid:35573, status: trace/breakpoint trap, trapcause is clone: true
eventmsg: new thread lwp pid: 35944
tracee stopped, tracee pid:35573, status: trace/breakpoint trap, trapcause is clone: true
eventmsg: new thread lwp pid: 35944
tracee stopped, tracee pid:35573, status: trace/breakpoint trap1, trapcause is clone: true
eventmsg: new thread lwp pid: 36086
tracee stopped, tracee pid:35573, status: trace/breakpoint trap, trapcause is clone: true
eventmsg: new thread lwp pid: 36192
tracee stopped, tracee pid:35573, status: trace/breakpoint trap, trapcause is clone: true
eventmsg: new thread lwp pid: 36295
tracee stopped, tracee pid:35573, status: trace/breakpoint trap, trapcause is clone: true
eventmsg: new thread lwp pid: 36398
..
```

3、20_trace_new_threads 每隔一段时间都会打印一个event msg: `<new thread LWP pid>`

结论就是，我们通过显示设置PtraceSetOptions(pid, syscall.PTRACE_O_TRACECLONE)后，恢复tracee执行，这样tracee执行起来后，当执行到clone系统调用时，就会触发一个TRAP，内核会给tracer发送一个SIGTRAP来通知tracee运行状态变化。然后tracer就可以检查对应的status数据，来判断是否是对应的clone事件。

如果是clone事件，我们可以继续通过syscall.PtraceGetEventMsg(...)来获取新clone出来的线程的LWP的pid。

检查是不是clone事件呢，参考 `man 2 ptrace` 手册对选项PTRACE_O_TRACECLONE的介绍部分，有解释clone状况下的status值如何编码。

4、另外设置了选项PTRACE_O_TRACECLONE之后，新线程会自动被trace，所以新线程也会被暂停执行，此时如果希望新线程恢复执行，我们需要显示将其syscall.PtraceDetach或者执行syscall.PtraceContinue操作来让新线程恢复执行。

### 思考：线程上下文切换特性支持

#### Go语言GMP调度的特殊性

不同于C\C++多线程编程操作时面向线程的，线程函数即业务逻辑，而在go语言中，并不是这样。对于go语言而言，线程有着特殊的意义。go提供的是面向协程goroutine级别的并发，比如chan sendrecv、mutex加解锁等等。由于GMP调度设计的原因，实际上我们也很难知道某个特定的goroutine会在哪个thread上执行，同一个goroutine的完整代码逻辑实际上也不一定会固定在同一个thread上执行 …… 调试go程序时，我们可能极少有诉求去跟踪某个特定的线程的执行情况。

#### 什么时候需要在线程间切换

dlv实际上是提供了 `threads` 和 `thread` 调试命令，来允许调试人员查看当前存在的线程以及在它们之间进行切换。那什么调试情景下我需要用到这个线程切换能力呢？

现在主流调试器对于进程内线程管理，基本上都是采用Stop-all、Start-all Mode（原因就是方便观察、避免线程间同步逻辑异常），所以当我们提到线程间切换的时候，其实指的是将当前调试器命令执行时的上下文（context），切换为目标线程的上下文（context），比如执行命令pregs时就是打了当前线程的硬件上下文信息，而不是其他被跟踪的线程的硬件上下文信息。

如果调试的线程执行的是cgo代码（这部分代码逻辑不会像goroutine逻辑那样会在线程间迁移），如果调试的goroutine执行了runtime.LockOSThread()，如果需要查看go运行时的底层逻辑，比如GMP调度，或者需要调试看下不同线程的线程可见性问题 …… 确实还是会有些场景需要用到线程上下文切换能力的支持。

### 思考：需要自动切换到新线程吗

在调试多进程程序时，当执行 `fork` 创建子进程后，调试人员希望能选择跟踪父进程还是子进程。

举个例子，比如我们要跟踪 `protoc` 编译器的插件实现 `protoc-gen-go`，protocolbuffers编译器protoc及其非内置支持语言的工具支持是通过插件机制来完成的，protoc编译器负责读取并解析 `*.proto` 文件，并生成一个代码生成请求发送给插件，方式就是在 `$PATH` 中搜索 `protoc-gen-go` 并启动它，然后通过stdin, stdout来传递请求并获取结果。如果你对此感兴趣，可以阅读 [Protoc及其插件工作原理](https://www.hitzhangjie.pro/blog/2017-05-23-protoc%E5%8F%8A%E6%8F%92%E4%BB%B6%E5%B7%A5%E4%BD%9C%E5%8E%9F%E7%90%86%E5%88%86%E6%9E%90%E7%B2%BE%E5%8D%8E%E7%89%88/)。

如果我们用gdb对protoc进行调试（protoc编译器是用C++写的)，并且希望对插件实现protoc-gen-go进行调试，就可以通过gdb中的 `set follow-fork-mode childk` 来选择跟踪子进程。这个功能是非常方便的，你不需要担心子进程执行过快越过想调试的代码部分。如果你不知道这个调试特性，可能会在子进程初始化逻辑中设置一个forloop然后attach后再跳出forloop才能对感兴趣的代码进行调试。

OK，那对于多线程程序而言，我们跟踪到一个新线程时，是否需要允许用户选择，你需要切换到某个线程上下文去吗？意义应该不大。首先Go主要是面向goroutine级别的并发控制操作，调试时切换线程作用不大。即使前面提到确实有些场景需要线程切换支持，我们也可以手动执行命令 `thread <n>` 来切换，所以没有必要支持自动跟踪并切换到新线程的特性。

### 思考：dlv是否支持多进程调试

前面提到gdb支持对子进程进行自动跟踪，其实dlv也支持类似的调试模式：`target follow-exec [-on [regex]] | [-off]`

```bash
(dlv) help target
Manages child process debugging.

    target follow-exec [-on [regex]] [-off]

Enables or disables follow exec mode. When follow exec mode Delve will automatically attach to new child processes executed by the target process. An optional regular expression can be passed to 'target follow-exec', only child processes with a command line matching the regular expression will be followed.
    ...

```

当通过exec.Command启动一个子进程时，如果您希望跟踪子进程，则可以通过上述 `target follow-exec` 操作来实现，并且还允许你通过正则的形式来对子进程名进行匹配检查，匹配则自动跟踪子进程。

### 本节小结

本节主要探讨了调试器如何感知和跟踪新创建线程的技术实现，核心内容包括：通过 `PTRACE_O_TRACECLONE` 选项让内核自动跟踪clone系统调用；利用 `waitpid()` 和 `PTRACE_EVENT_CLONE` 事件机制感知新线程创建；通过 `PtraceGetEventMsg()` 获取新线程的LWP ID并将其纳入调试器管理。本节还深入分析了Linux内核中线程与进程的本质区别，以及Go语言GMP调度模型对线程调试的特殊影响，为读者理解多线程、多进程调试的底层机制提供了重要基础。
