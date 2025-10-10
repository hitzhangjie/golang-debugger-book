## 调试多线程程序 - 跟踪新创建线程

### 实现目标

前面演示调试器操作时，为了简化多线程调试的挑战，有些测试场景我们使用了单线程程序来进行演示。但是真实场景下，我们的程序往往是多线程程序。

我们的调试器必须具备多线程调试的能力，这里有几类场景需要特别强调下：

- 父子进程，在调试器实现过程中，跟踪父子进程和跟踪进程内的线程，实现技术上差别不大。
  因为这是一款面向go调试器的书籍，所以我们只专注多线程调试。多进程调试我们会点一下，但是不会专门开一节来介绍。
- 线程的创建时机问题，可能是在我们attach之前创建出来的，也可能是我们attach之后线程通过clone又新创建出来的。
  - 对于进程已经创建的线程，我们需要具备枚举并且发起跟踪、切换不同线程跟踪的能力；
  - 对于进程调试期间新创建的线程，我们需要具备即时感知线程创建，并提示用户选择跟踪哪个线程的能力，方便用户对感兴趣的事件进行观察。

本节我们就先看下如何跟踪新创建的线程，并获取新线程的tid并发起跟踪，下一节我们看下如何枚举已经创建的线程并选择性跟踪指定线程。

ps: 篇幅原因，godbg中对多线程调试的调试器支持代码这里不做展示，您可以查看 [hitzhangjie/godbg](https://github.com/hitzhangjie/godbg) 源码进行了解。

### 基础知识

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

   - 通过SIGCHLD信号去感知这个事件的发生，内核会发送信号SIGCHLD给tracer，并通过si_status字段说明是调试动作导致的SIGTRAP引起。而如果想进一步获取是因为哪个系统调用导致的，则可以通过 `syscall.PtraceGetRegs` 来从寄存器中获取系统调用编号，再与clone的系统调用编号进行比较。

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

   - 通过waitpid()去感知到tracee的运行状态发生了改变，并通过waitpid返回的status来判断是否是PTRACE_EVENT_CLONE事件。

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

3、tracer如果确定了是clone导致的以后，可以进一步通过 `newpid, _ = syscall.PtraceGetEventMsg(pid)` 拿到新线程的pid信息。

4、拿到线程pid之后就可以将新线程纳入跟踪，我们可以选择放行新线程，或者暂停新线程、读写数据、观察并控制执行。

> ps: 关于个别线程tid、pid这两个术语的混用说明
>
> 会偶尔混用pid、tid信息，对于线程，Linux下其实是LWP（轻量级进程，Light Weight Process），进程通过执行clone创建出来的LWP。但是当我想描述一个线程的ID时，应该用tid这个术语，而不是pid这个术语。但是因为某些函数调用参数命名为pid且适用于线程id的原因，我可能偶尔会用pid来表示线程的tid，比如attach一个线程的时候，传递的参数应该是tid，而非这个线程所属进程的pid（如果不是主线程，线程tid和pid值也是不一样的)。
>
> - 这个线程所属的进程pid，这样获取 `getpid()`
> - 这个线程的线程tid（或者表述成对应的LWP的pid），通过这样获取 `syscall(SYS_gettid)`

### 设计实现

#### 准备多线程测试程序

这部分实现代码，详见 [hitzhangjie/golang-debugger-lessons/20_trace_new_threads](https://github.com/hitzhangjie/golang-debugger-lessons/tree/master/20_trace_new_threads)。

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

然后我们再来看调试器部分的代码逻辑，这里主要是为了演示tracer（debugger）如何对多线程程序中新创建的线程进行感知，并能自动追踪，必要时还可以实现类似 gdb `set follow-fork-mode=child/parent/ask` 的调试效果呢。

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

    opts := syscall.PTRACE_O_TRACEFORK | syscall.PTRACE_O_TRACEVFORK | syscall.PTRACE_O_TRACECLONE
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

```
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

2、我们同时观察 ./20_trace_new_threads `<上述fork程序进程pid> 的执行情况`

```
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

检查是不是clone事件呢，参考 man 2 ptrace手册对选项PTRACE_O_TRACECLONE的介绍部分，有解释clone状况下的status值如何编码。

4、另外设置了选项PTRACE_O_TRACECLONE之后，新线程会自动被trace，所以新线程也会被暂停执行，此时如果希望新线程恢复执行，我们需要显示将其syscall.PtraceDetach或者执行syscall.PtraceContinue操作来让新线程恢复执行。

### 思考一下：如果更友好地调试多进程程序

至此，测试方法介绍完了，我们可以引申下，在我们这个测试的基础上我们可以提示用户，你想跟踪当前线程呢，还是想跟踪新线程呢？其实也是可以做到的，不过对于go语言而言，可能意义不大，下面我们会探讨。

在调试多进程程序时非常有用的，调试人员希望能有一种控制能力，当执行 `fork` 后能选择自动跟踪父进程还是子进程。联想下gdb中的 `set follow-fork-mode` ，我们可以选择 parent、child、ask 中的一种，并且允许在调试期间在上述选项之间进行切换，如果我们调试时需要跟踪子进程去调试，这个功能特性就非常的有用。

比如我们要跟踪 `protoc` 编译器的插件实现 `protoc-gen-go`，protocolbuffers编译器protoc及其非内置支持语言的工具支持是通过插件机制来完成的，protoc编译器负责读取并解析 `*.proto` 文件，并生成一个代码生成请求发送给插件，方式就是在 `$PATH` 中搜索 `protoc-gen-go` 并启动它，然后通过stdin, stdout来传递请求并获取结果。如果你对此感兴趣，可以阅读 [Protoc及其插件工作原理](https://www.hitzhangjie.pro/blog/2017-05-23-protoc%E5%8F%8A%E6%8F%92%E4%BB%B6%E5%B7%A5%E4%BD%9C%E5%8E%9F%E7%90%86%E5%88%86%E6%9E%90%E7%B2%BE%E5%8D%8E%E7%89%88/)。

### 思考一下：dlv是否支持多进程调试呢

dlv也支持类似的调试模式：`target follow-exec [-on [regex]] | [-off]`

```bash
(dlv) help target
Manages child process debugging.

    target follow-exec [-on [regex]] [-off]

Enables or disables follow exec mode. When follow exec mode Delve will automatically attach to new child processes executed by the target process. An optional regular expression can be passed to 'target follow-exec', only child processes with a command line matching the regular expression will be followed.
    ...

```

当通过exec.Command启动一个子进程时，如果您希望跟踪子进程，则可以通过上述 `target follow-exec` 操作来实现，并且还允许你通过正则的形式来对子进程名进行匹配检查，匹配则自动跟踪子进程。

### 思考一下：如果要在线程之间进行切换呢

#### 所有线程都已经纳入跟踪

dlv `target follow-exec` 支持自动跟踪子进程调试，但是却不支持自动跟踪并切换到新创建的线程。既然都可以跟踪子进程了，其实也是可以跟踪新创建的线程的。

其实，对于多线程程序调试，比较友好的就是 Stop-all Mode，就是所有线程要么都停止，要么都运行，以避免一些正常的线程间同步无法正常执行，以及方便调试人员观察，这个我们之前就提过了。所以，对于进程内的线程，不管是attach时已经创建出来的线程，还是attach后新创建的线程，这些线程都会纳入我们调试器的管理范畴。

#### Go语言GMP调度的特殊性

不同于C\C++多线程编程操作时面向线程的，线程函数即业务逻辑，而在go语言中，并不是这样。对于go语言而言，线程有着特殊的意义。go提供的是面向协程goroutine级别的并发，比如chan sendrecv、mutex加解锁等等。由于GMP调度设计的原因，实际上我们也很难知道某个特定的goroutine会在哪个thread上执行，同一个goroutine的完整代码逻辑实际上也不一定会固定在同一个thread上执行 …… 调试go程序时，我们可能极少有诉求去跟踪某个特定的线程的执行情况。

#### 什么时候需要在线程间切换

dlv实际上是提供了 `threads` 和 `thread` 调试命令，来允许调试人员查看当前存在的线程以及在它们之间进行切换。那什么调试情景下我需要用到这个线程切换能力呢？

现在主流调试器对于进程内线程管理，基本上都是采用Stop-all、Start-all Mode（原因就是方便观察、避免线程间同步逻辑异常），所以当我们提到线程间切换的时候，其实指的是将当前调试器命令执行时的上下文（context），切换为目标线程的上下文（context），当我们执行命令pregs时那么就是切换到的线程的执行上下文信息。

如果调试的线程执行的是cgo代码（这部分代码逻辑不会像goroutine逻辑那样会在线程间迁移），如果调试的goroutine执行了runtime.LockOSThread()，如果需要查看go运行时的底层逻辑，比如GMP调度 …… 那确实还是会用到这部分能力的。

### 本节小结

本节深入探讨了调试器跟踪新创建线程的核心技术实现，重点阐述了三个关键技术点：通过 `PTRACE_O_TRACECLONE` 选项让内核自动跟踪clone系统调用；利用 `waitpid()` 和 `PTRACE_EVENT_CLONE` 事件机制感知新线程创建；通过 `PtraceGetEventMsg()` 获取新线程的LWP ID并将其纳入调试器管理。此外，本节还分析了多进程跟踪与多线程跟踪的实现差异，以及Go语言GMP调度模型对线程调试的特殊影响。这些内容为读者构建了完整的多线程调试知识体系奠定了坚实基础。


