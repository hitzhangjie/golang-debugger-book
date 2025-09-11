## 启动调试：`attach` 跟踪运行中进程

### 实现目标：`godbg attach <pid>`

如果进程已经在运行了，要对其进行调试需要先通过attach操作跟踪进程，待其停止执行后，再执行查看修改数据、控制程序执行的操作。常见的调试器如dlv、gdb等都支持传递pid参数来对运行中的进程进行跟踪调试。

本节我们将实现程序 `godbg attach <pid>` 子命令。

本节示例代码中，godbg将attach到目标进程，此时目标进程会暂停执行。然后我们让godbg休眠几秒钟（我们假定这几秒钟内执行了一些调试动作，如添加断点、执行到断点、查看变量等，然后调试完后结束调试），再detach目标进程，目标进程会恢复执行。

### 基础知识

#### tracee

首先要进一步明确tracee的概念，虽然我们看上去是对进程进行调试，实际上调试器内部工作时，是对一个一个的线程进行调试。

tracee，指的是被调试的线程，而不是进程。对于一个多线程程序而言，调试期间可能要跟踪部分或者全部线程，没有被跟踪的线程将会继续执行，而被跟踪的线程则受调试器控制。甚至同一个被调试进程中的不同线程，可以由不同的tracer来控制。

注意，这里有几个点需要提前跟大家明确下：

- 同一个线程只允许被一个调试器跟踪调试，如果希望启动多个独立的调试器实例对目标线程进行跟踪，操作系统会检测到该线程已经被某个调试器进程跟踪调试中，会拒绝其他调试器实例的ptrace请求。

- 在前后端分离式调试器架构下，也就是说只允许1个debugger backend实例attach被调试线程，但是我们可以启动多个debugger frontend来同时进行并发调试，这部分在第9章允许
multiclient访问debugger backend时会介绍。

- 为了方便调试期间观察各个线程的状态，调试器通常会采用All-stop Mode，即默认跟踪进程中的所有线程。要运行所有线程都运行，要停止所有线程都停止。这种方式更方便调试人员调试。

#### tracer

tracer，指的是向tracee发送调试控制命令的调试器进程，准确地说，也是线程。

有时会使用术语ptrace link，实际上是指tracer通过ptrace系统调用（如PTRACE_ATTACH）成功跟踪了tracee，此后tracer就可以向tracee发送各种调试命令。需要注意的是，建立跟踪关系后，tracee期望后续所有的ptrace请求都来自同一个tracer线程，否则会被内核拒绝或行为未定义。因此，调试器（debugger backend）实现时要注意，attach后后续对该tracee的所有ptrace操作都要在主动建立该ptrace link的tracer线程中发起。

这也意味着，同一个线程只允许被同一个调试器（debugger backend）实例跟踪调试。关于这点，我们可以通过如下操作对此进行验证。

#### ptrace attach

实际上ptrace_link是一个linux内核函数，顾名思义，它指的就是tracer attach到tracee后建立了跟踪关系。ptrace link一旦建立后，tracee就只允许接收来自link另一端的tracer的ptrace请求。关于这点，我们可以验证下。

**1）验证1：多个调试器实例attach同一个线程**

shell 1中先启动一个预先写好的go程序，它执行for循环：

```bash
$ ./goforloop
```

shell 2中通过godbg attach到该goforloop进程，attach成功：

```bash
$ godbg attach `pidof goforloop`
```

shell 3中通过godbg再次attach到该goforloop进程，attach报权限失败：

```bash
$ godbg attach `pidof goforloop`
Error: process 31060 attached error: operation not permitted
```

**2) 验证2：attach成功后通过其他线程发送ptrace请求**

这样也是不被允许的，读者如果感兴趣，可以自行注释掉godbg中的 `runtime.LockOSThread()` 调用，然后重编godbg进行调试活动，执行期间就会收到相关的权限报错信息 No Such Process。

**内核中执行ptrace操作时，内核会进行这样的校验**:

file: ./kernel/ptrace.c

```c
SYSCALL_DEFINE4(ptrace, long, request, long, pid, unsigned long, addr,
        unsigned long, data)
{
    ...
    ret = ptrace_check_attach(child, request == PTRACE_KILL ||
                  request == PTRACE_INTERRUPT);
    if (ret < 0)
        goto out_put_task_struct;
    ...
out_put_task_struct:
    put_task_struct(child);
}

static int ptrace_check_attach(struct task_struct *child, bool ignore_state)
{
    int ret = -ESRCH;   // no such process
    ...
    if (child->ptrace && child->parent == current) {
        WARN_ON(child->state == __TASK_TRACED);
        /*
         * child->sighand can't be NULL, release_task()
         * does ptrace_unlink() before __exit_signal().
         */
        if (ignore_state || ptrace_freeze_traced(child))
            ret = 0;
    }
    ...
    return ret
}
```

如果后续ptrace请求来自非ptrace link建立时的tracer，那么ptrace_check_attach操作就会返回错误码 `-ESRCH`。

#### ptrace limits

我们的调试器示例是基于Linux平台编写的，调试能力依赖于Linux ptrace。

通常，如果调试器也是多线程程序，就要注意ptrace的约束，当tracer、tracee建立了跟踪关系后，tracee（被跟踪线程）后续接收到的多个调试命令应该来自同一个tracer（跟踪线程），意味着调试器实现时要将发送调试命令给tracee的task (goroutine) 绑定到tracer对应的特定线程上。

所以，在我们参考dlv等调试器的实现时会发现，发送调试命令的goroutine通常会调用 `runtime.LockOSThread()` 来绑定一个线程，后续ptrace请求均通过这个goroutine、这个thread来发送。

> runtime.LockOSThread()，该函数的作用是将调用该函数的goroutine绑定到该操作系统线程上，意味着该操作系统线程只会用来执行该goroutine上的操作，除非该goroutine调用了runtime.UnLockOSThread()解除这种绑定关系，否则该线程不会用来调度其他goroutine。调用这个函数的goroutine也只能在当前线程上执行，不会被调度器迁移到其他线程。
>
> 如果这个goroutine执行结束后退出，绑定的这个线程M也会被销毁。这是当前go runtime设计实现中，除了进程退出时销毁线程之外的唯一一个线程M被创建出来后又销毁的情况。换言之，如果你的程序执行太多阻塞系统调用创建大量线程后，这些线程是不会被运行时主动销毁的。
>
> ok，我们来看下这个runtime.LockOSThread()的文档注释，see:
>
> ```go
> package runtime // import "runtime"
>
> func LockOSThread()
>     LockOSThread wires the calling goroutine to its current operating system
>     thread. The calling goroutine will always execute in that thread, and no
>     other goroutine will execute in it, until the calling goroutine has made as
>     many calls to UnlockOSThread as to LockOSThread. If the calling goroutine
>     exits without unlocking the thread, the thread will be terminated.
>
>     All init functions are run on the startup thread. Calling LockOSThread from
>     an init function will cause the main function to be invoked on that thread.
>
>     A goroutine should call LockOSThread before calling OS services or non-Go
>     library functions that depend on per-thread state.
> ```

调用了该函数之后，就可以满足tracee对tracer的要求：一旦tracer通过ptrace_attach了某个tracee，后续发送到该tracee的ptrace请求必须来自同一个tracer (tracee、tracer具体指的都是线程)。否则会遇到错误 `-ESRCH (No Such Process)`。

#### wait & ptrace r/w

当我们调用了attach之后，attach返回时，tracee有可能还没有停下来，这个时候需要通过wait方法来等待tracee停下来，并获取tracee的状态信息。

此时我们不光可以使用ptrace的其他内存读写操作、寄存器读写操作等来读取tracee的信息，比如读写内存变量值、读写寄存器信息，甚至一些更加高级的用法，比如显示当前tracee的函数调用栈。

#### ptrace detach

当结束调试时，可以通过detach操作，让tracee恢复执行。

### 代码实现

src详见：golang-debugger-lessons/2_process_attach。


下面是man手册关于ptrace操作attach、detach的说明，下面要用到：

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

当我们通过 `ptrace(PTRACE_ATTACH, pid, ...)` 操作去跟踪一个指定的线程时，内核会给这个目标线程发送一个信号SIGSTOP。

当执行SIGSTOP的信号处理时，内核会执行如下关键操作：

```c
do_signal_stop
    set_special_state(TASK_STOPPED);                    // 暂停tracee执行
    do_notify_parent_cldstop(current, false, notify);   // 通知ptracer tracee已经停止
        __group_send_sig_info(SIGCHLD, &info, parent);  // 给ptracer进程发送SIGCHLD，任意线程都可以处理
        __wake_up_parent(tsk, parent);                  // 唤醒ptracer进程中任意调用了wait4(tracee，)阻塞的线程
```

file: main.go

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

const (
    usage = "Usage: go run main.go exec <path/to/prog>"

    cmdExec   = "exec"
    cmdAttach = "attach"
)

func main() {
    // issue: https://github.com/golang/go/issues/7699
    //
    // 为什么syscall.PtraceDetach, detach error: no such process?
    // 因为ptrace请求应该来自相同的tracer线程，
    // 
    // ps: 如果恰好不是，可能需要对tracee的状态显示进行更复杂的处理，需要考虑信号？
    // 目前看系统调用传递的参数是这样。
    runtime.LockOSThread()

    if len(os.Args) < 3 {
        fmt.Fprintf(os.Stderr, "%s\n\n", usage)
        os.Exit(1)
    }
    cmd := os.Args[1]

    switch cmd {
    case cmdExec:
        prog := os.Args[2]

        // run prog
        progCmd := exec.Command(prog)
        buf, err := progCmd.CombinedOutput()

        fmt.Fprintf(os.Stdout, "tracee pid: %d\n", progCmd.Process.Pid)

        if err != nil {
            fmt.Fprintf(os.Stderr, "%s exec error: %v, \n\n%s\n\n", err, string(buf))
            os.Exit(1)
        }
        fmt.Fprintf(os.Stdout, "%s\n", string(buf))

    case cmdAttach:
        pid, err := strconv.ParseInt(os.Args[2], 10, 64)
        if err != nil {
            fmt.Fprintf(os.Stderr, "%s invalid pid\n\n", os.Args[2])
            os.Exit(1)
        }

        // check pid
        if !checkPid(int(pid)) {
            fmt.Fprintf(os.Stderr, "process %d not existed\n\n", pid)
            os.Exit(1)
        }

        // attach
        err = syscall.PtraceAttach(int(pid))
        if err != nil {
            fmt.Fprintf(os.Stderr, "process %d attach error: %v\n\n", pid, err)
            os.Exit(1)
        }
        fmt.Fprintf(os.Stdout, "process %d attach succ\n\n", pid)

        // wait
        var (
            status syscall.WaitStatus
            rusage syscall.Rusage
        )
        _, err = syscall.Wait4(int(pid), &status, syscall.WSTOPPED, &rusage)
        if err != nil {
            fmt.Fprintf(os.Stderr, "process %d wait error: %v\n\n", pid, err)
            os.Exit(1)
        }
        fmt.Fprintf(os.Stdout, "process %d wait succ, status:%v, rusage:%v\n\n", pid, status, rusage)

        // detach
        fmt.Printf("we're doing some debugging...\n")
        time.Sleep(time.Second * 10)

        // MUST: call runtime.LockOSThread() first
        err = syscall.PtraceDetach(int(pid))
        if err != nil {
            fmt.Fprintf(os.Stderr, "process %d detach error: %v\n\n", pid, err)
            os.Exit(1)
        }
        fmt.Fprintf(os.Stdout, "process %d detach succ\n\n", pid)

    default:
        fmt.Fprintf(os.Stderr, "%s unknown cmd\n\n", cmd)
        os.Exit(1)
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

这里的程序逻辑也比较简单：

1. 程序运行时，首先检查命令行参数，  
    - `godbg attach <pid>`，至少有3个参数，如果参数数量不对，直接报错退出；
    - 接下来校验第2个参数，如果是无效的subcmd，也直接报错退出；
    - 如果是attach，那么pid参数应该是个整数，如果不是也直接退出；
2. 参数正常情况下，开始校验pid进程是否存在，存在则开始尝试attach到tracee，建立ptrace link；
3. attach之后，tracee并不一定立即就会停下来，需要wait来获取其状态变化情况；
4. 等tracee停下来之后，我们休眠10s钟，假定此时自己正在执行些调试操作；
5. 10s钟之后调试结束，tracer尝试detach tracee，解除ptrace link，让tracee继续恢复执行。

>我们在Linux平台上实现时，需要考虑Linux平台本身的问题，具体包括：
>- 检查pid是否对应着一个有效的进程，通常会通过 `exec.FindProcess(pid)`来检查，但是在Unix平台下，这个函数总是返回OK，所以是行不通的。因此我们借助了 `kill -s 0 pid`这一比较经典的做法来检查pid合法性。
>- tracer、tracee进行detach操作的时候，我们是用了ptrace系统调用，这个也和平台有关系，如Linux平台下的man手册有说明，必须确保一个tracee的所有的ptrace requests来自相同的tracer线程，实现时就需要注意这点。

### 代码测试

下面是一个测试示例，帮助大家进一步理解attach、detach的作用。

我们先在bash启动一个命令，让其一直运行，然后获取其pid，并让godbg attach将其挂住，观察程序的暂停、恢复执行。

比如，我们在bash里面先执行以下命令，它会每隔1秒打印一下当前的pid：

```bash
$ while [ 1 -eq 1 ]; do t=`date`; echo "$t pid: $$"; sleep 1; done

Sat Nov 14 14:29:04 UTC 2020 pid: 1311
Sat Nov 14 14:29:06 UTC 2020 pid: 1311
Sat Nov 14 14:29:07 UTC 2020 pid: 1311
Sat Nov 14 14:29:08 UTC 2020 pid: 1311
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

process 1311 attach succ

process 1311 wait succ, status:4991, rusage:{{12 607026} {4 42304} 43580 0 0 0 375739 348 0 68224 35656 0 0 0 29245 153787}

we're doing some debugging...           ==> 这里sleep 10s
```

执行完上述命令后，回来看shell命令的输出情况，可见其被挂起了，等了10s之后又继续恢复执行，说明detach之后又可以继续执行。

```
Sat Nov 14 14:29:04 UTC 2020 pid: 1311
Sat Nov 14 14:29:06 UTC 2020 pid: 1311
Sat Nov 14 14:29:07 UTC 2020 pid: 1311
Sat Nov 14 14:29:08 UTC 2020 pid: 1311
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
Sat Nov 14 14:29:29 UTC 2020 pid: 1311
^C
```

然后我们再看下我们调试器的输出，可见其attach、暂停、detach逻辑，都是正常的。

```bash
$ go run main.go attach 1311

process 1311 attach succ

process 1311 wait succ, status:4991, rusage:{{12 607026} {4 42304} 43580 0 0 0 375739 348 0 68224 35656 0 0 0 29245 153787}

we're doing some debugging...
process 1311 detach succ
```

### 问题探讨

为了让读者能快速掌握核心调试原理，示例里我们有意简化了示例，示例中被调试进程是一个单线程程序，如果是一个多线程程序结果会不会不一样呢？会!

#### 问题：多线程程序attach后仍在运行？

假如我使用下面的go程序做为被调试程序，结果发现执行了 `godbg attach <pid>`之后程序还在执行，这是为什么呢？

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

解释这个事情，有几个事实需要阐明：
1. go程序天然是多线程程序，sysmon、gc等等都可能会用到独立线程，我们执行 `attach <pid>` 只是跟踪了进程中的主线程，其他的线程仍然是没有被调踪的，是可以继续执行的。
2. go运行时采用GMP调度机制，同一个goroutine在生命周期能可能会在多个thread上先后执行一部分代码逻辑，比如某个goroutine执行阻塞系统调用后，会创建出新的线程，如果系统调用返回后，goroutine也要恢复执行，此时有可能会去找之前的thread，但是根据调度负载情况、原先M、原先P空闲情况，非常有可能这个goroutine会在另一个thread中继续执行，而该thread没有被调试器跟踪，依然可以继续执行。
3. 具体到我们示例中，ptrace指定的pid到底是主线程pid，main.main是main goroutine的入口函数，但是main goroutine却不一定在main thread中执行。

附录《go runtime: go程序启动流程》中对go程序的启动流程做了分析，可以帮读者朋友打消这里runtime.main、main.main 在 main goroutine、main thread 中执行细节的一些疑虑。**go程序中函数main.main是由main goroutine来执行的，但是main goroutine并没有和main thread存在任何默认的绑定关系**。所以认为main.main一定运行在pid对应的主线程上是错误的（联想GMP调度机制，main goroutine一开始就不一定运行在主线程上，而且也没有上述提及的runtime.LockOSThread()会一直保证运行在特定线程上）！

在Linux下，线程其实是通过轻量级进程（LWP）来实现的，这里的ptrace参数pid实际上是主线程对应的LWP的pid。只对这个pid进行ptrace attach操作，作用是，这个pid对应的线程会被跟踪，但是进程中的其他线程并没有被跟踪，它们仍然可以继续执行。这就是为什么我们自己写个go程序验证下attach功能，会发现被调试程序仍然在不停输出，因为tracer并没有在main.main内部设置断点，执行该函数main.main的main goroutine可能由其他未被跟踪的线程执行。

#### 问题：go进程中线程是如何创建出来的？

一个多线程程序，程序可以通过执行 “**系统调用clone+选项CLONE_THREAD**” 来创建新线程，新线程的pid `os.Getpid()` 和 从属的进程拥有相同的pid。

对于go语言，go运行时在初始化时、后续执行期间需要创建新线程时，会通过 `runtime.newosproc` -> `clone+cloneFlags` 来创建线程：

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

>ps: 关于clone选项的更多作用，您可以通过查看man手册 `man 2 clone`来了解。

#### 问题：想确保执行main.main的线程停下来？

在不考虑main.main->forloop位置设断点的情况下，如果只是想让所有线程在attach时都能尽快停下来，需要采用All-stop Mode。

调试器需要在attach主线程成功后，枚举进程包含的所有线程，并对它们逐一进行ptrace attach操作。Linux下可以列出 `/proc/<pid>/task` 下的所有线程的pid (LWP的pid，而非进程内线程编号tid)。

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

对进程内每个线程逐个执行ptrace attach，所有线程也就都停下来了。All-stop Mode很重要，这里也算是提前了解下。

>调试活动通常是带有目的性的调试，而不是漫无目的地闲逛，这样调试效率才会高。调试很重要的一点就是，在可疑代码处先提前设置好断点，执行到此位置的线程自然会停下来。如果没有提前设置好断点，可疑位置代码已经执行过了，就只能重新开始调试会话了。对于多线程程序，为了方便观察多个线程的运行情况甚至是线程间的交互情况，通常这些线程要么全部运行要么全部停止。

#### 问题：如何判断进程是否是多线程程序？

如何判断目标进程是否是多线程程序呢？有两种简单的办法帮助判断。

- `top -H -p pid`

  `-H`选项将列出进程pid下的线程列表，以下进程5293下有4个线程，Linux下线程是通过轻量级进程实现的，PID列为5293的轻量级进程为主线程。

  ```bash
  $ top -H -p 5293
  ........
  PID USER      PR  NI    VIRT    RES    SHR S %CPU %MEM     TIME+ COMMAND                                                     
   5293 root      20   0  702968   1268    968 S  0.0  0.0   0:00.04 loop                                                        
   5294 root      20   0  702968   1268    968 S  0.0  0.0   0:00.08 loop                                                        
   5295 root      20   0  702968   1268    968 S  0.0  0.0   0:00.03 loop                                                        
   5296 root      20   0  702968   1268    968 S  0.0  0.0   0:00.03 loop
  ```

  top展示信息中列S表示进程状态，常见的取值及含义如下：

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

  Linux下/proc是一个虚拟文件系统，它里面包含了系统运行时的各种状态信息，以下命令可以查看到进程5293下的线程。和top展示的结果是一样的。

#### 问题：syscall.Wait4的参数说明

Linux系统有多个等待进程状态改变的系统调用，它们有一些使用、功能上的细微差别，我们这里使用syscall.Wait4刚好对应着Linux系统调用wait4，详细的使用说明可以参考man手册。

man手册说明中强相关的部分，如下所示：

man 2 wait4

> **Name**
>
> *wait3, wait4 - wait for process to change state, BSD style*
>
> **SYNOPSIS**
>
> pid_t wait3(int *wstatus, int options,
> struct rusage *rusage);
>
> pid_t wait4(pid_t pid, int *wstatus, int options,
> struct rusage *rusage);
>
> **Description**
>
> **These functions are obsolete; use waitpid(2) or waitid(2) in new programs.**
>
> The wait3() and wait4() system calls are similar to waitpid(2), but additionally return resource usage information about the child in the structure pointed to by rusage.

man 2 waitpid

> **Name**
>
> wait, waitpid, waitid - wait for process to change state
>
> **SYNOPSIS**
>
> pid_t wait(int *wstatus);
>
> pid_t waitpid(pid_t pid, int *wstatus, int options);
>
> int waitid(idtype_t idtype, id_t id, siginfo_t*infop, int options);
> /* This is the glibc and POSIX interface; see
> NOTES for information on the raw system call. */
>
> **SYNOPSIS**
>
> All  of  these  system calls are used to wait for state changes in a child of the calling process, and obtain information about the child whose state has changed.  A state change is considered to be: the child terminated;
> the child was stopped by a signal; or the child was resumed by a signal.  In the case of a terminated child, performing a wait allows the system to release the resources associated with the child; if a wait  is  not  per‐
> formed, then the terminated child remains in a "zombie" state (see NOTES below).
>
> If  a  child  has already changed state, then these calls return immediately.  Otherwise, they block until either a child changes state or a signal handler interrupts the call (assuming that system calls are not automati‐
> cally restarted using the SA_RESTART flag of sigaction(2)).  In the remainder of this page, a child whose state has changed and which has not yet been waited upon by one of these system calls is termed waitable.
>
> wait() and waitpid()
> The wait() system call suspends execution of the calling process until one of its children terminates.  The call wait(&wstatus) is equivalent to:
>
> waitpid(-1, &wstatus, 0);
>
> The waitpid() system call suspends execution of the calling process until a child specified by pid argument has changed state.  By default, waitpid() waits only for terminated children, but this behavior is modifiable via
> the options argument, as described below.
>
> The value of pid can be:
>
> - \<-1: meaning wait for any child process whose process group ID is equal to the absolute value of pid.
> - -1: meaning wait for any child process.
> - 0: meaning wait for any child process whose process group ID is equal to that of the calling process.
> - \>0: meaning wait for the child whose process ID is equal to the value of pid.
>
> The value of options is an OR of zero or more of the following constants:
>
> - WNOHANG: ... blabla
> - WUNTRACED: ... blabla
> - WCONTINUED: ... blabla
>
> (For Linux-only options, see below.)
>
> - WIFSTOPPED: returns true if the child process was stopped by delivery of a signal; this is possible only if the call was done using WUNTRACED or when the child is being traced (see ptrace(2)).
> - ... blabla

### 本节小结

attach操作是调试器进行调试的第一步。本节不仅介绍了如何attach到目标进程，还详细阐述了ptrace link的概念及其限制，并从内核层面分析了这些限制的原因。同时，我们还讨论了Go语言作为原生多线程程序，如何借助All-stop Mode实现对多个线程的同步跟踪与观察。

针对attach目标进程后，main.main中的循环依然在执行的现象，我们结合Go的协程编程模型，深入讲解了其多线程调度机制，并结合Go的启动流程，解释了初学者常见的GMP调度疑惑（例如main.main不一定运行在主线程上）。此外，我们还介绍了如何枚举进程中的线程列表并实现All-stop Mode，以及如何判断一个进程是否为多线程程序。

通过这些内容，我们梳理并解答了调试器实现过程中一些基础但至关重要的问题，为后续深入理解调试器的实现原理打下了坚实的基础。
