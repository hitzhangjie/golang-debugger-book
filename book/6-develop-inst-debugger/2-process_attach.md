## Attach进程

### 实现目标：`godbg attach -p <pid>`

如果进程已经在运行了，如果要对其进行调试需要将进程挂住(attach)，让其停下来等待调试器对其进行控制。

常见的调试器如dlv、gdb等都支持通过参数 `-p pid` 的形式来传递目标进程号来对运行中的进程进行调试。

我们将实现程序godbg，它支持子命令 ``attach -p <pid>``，如果目标进程存在，godbg将attach到目标进程，此时目标进程会暂停执行。然后我们让godbg休眠几秒钟，再detach目标进程，目标进程会恢复执行。

> ps: 这里休眠的几秒钟，用户可以先将其假想成一系列的调试操作，如设置断点、检查进程寄存器、检查内存等等，后面小节中我们将支持这些能力。

### 基础知识

#### tracee

首先要进一步明确tracee的概念，虽然我们看上去是对进程进行调试，实际上调试器内部工作时，是对一个一个的线程进行调试。

tracee，指的是被调试的线程，而不是进程。对于一个多线程程序而言，可能要跟踪（trace）部分或者全部的线程以方便调试，没有被跟踪的线程将会继续执行，而被跟踪的线程则受调试器控制。甚至同一个被调试进程中的不同线程，可以由不同的tracer来控制。

#### tracer

tracer，指的是向tracee发送调试控制命令的调试器进程，准确地说，也是线程。

一旦tracer和tracee建立了联系之后，tracer就可以给tracee发送各种调试命令。

#### ptrace

我们的调试器示例是基于Linux平台编写的，调试能力依赖于Linux ptrace。

通常，如果调试器也是多线程程序，就要注意ptrace的约束，当tracer、tracee建立了跟踪关系后，tracee（被跟踪线程）后续接收到的多个调试命令应该来自同一个tracer（跟踪线程），意味着调试器实现时要将发送调试命令给tracee的task绑定到特定线程上。更具体地讲，这里的task可以是goroutine。

所以，在我们参考dlv等调试器的实现时会发现，发送调试命令的goroutine通常会调用 `runtime.LockOSThread()`来绑定一个线程，专门用来向attached tracee发送调试指令（也就是各种ptrace操作）。

> runtime.LockOSThread()，该函数的作用是将调用该函数的goroutine绑定到该操作系统线程上，意味着该操作系统线程只会用来执行该goroutine上的操作，除非该goroutine调用了runtime.UnLockOSThread()解除这种绑定关系，否则该线程不会用来调度其他goroutine。调用这个函数的goroutine也只能在当前线程上执行，不会被调度器迁移到其他线程。see:
>
> ```
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
>
> 调用了该函数之后，就可以满足tracee对tracer的要求：一旦tracer通过ptrace_attach了某个tracee，后续发送到该tracee的ptrace请求必须来自同一个tracer，tracee、tracer具体指的都是线程。

当我们调用了attach之后，attach返回时，tracee有可能还没有停下来，这个时候需要通过wait方法来等待tracee停下来，并获取tracee的状态信息。当结束调试时，可以通过detach操作，让tracee恢复执行。

> 下面是man手册关于ptrace操作attach、detach的说明，下面要用到：

    **PTRACE_ATTACH**
    *Attach to the process specified in pid, making it a tracee of*
    *the calling process.  The tracee is sent a SIGSTOP, but will*
    *not necessarily have stopped by the completion of this call;*

> *use waitpid(2) to wait for the tracee to stop.  See the "At‐*
> *taching and detaching" subsection for additional information.*

    **PTRACE_DETACH**
    *Restart the stopped tracee as for PTRACE_CONT, but first de‐*
    *tach from it.  Under Linux, a tracee can be detached in this*
    *way regardless of which method was used to initiate tracing.*

### 代码实现

**src详见：golang-debugger-lessons/2_process_attach**

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

- 程序运行时，首先检查命令行参数，
  - `godbg attach <pid>`，至少有3个参数，如果参数数量不对，直接报错退出；
  - 接下来校验第2个参数，如果是无效的subcmd，也直接报错退出；
  - 如果是attach，那么pid参数应该是个整数，如果不是也直接退出；
- 参数正常情况下，开始尝试attach到tracee；
- attach之后，tracee并不一定立即就会停下来，需要wait来获取其状态变化情况；
- 等tracee停下来之后，我们休眠10s钟，仿佛自己正在干些调试操作一样；
- 10s钟之后，tracer尝试detach tracee，让tracee继续恢复执行。

我们在Linux平台上实现时，需要考虑Linux平台本身的问题，具体包括：

- 检查pid是否对应着一个有效的进程，通常会通过 `exec.FindProcess(pid)`来检查，但是在Unix平台下，这个函数总是返回OK，所以是行不通的。因此我们借助了 `kill -s 0 pid`这一比较经典的做法来检查pid合法性。
- tracer、tracee进行detach操作的时候，我们是用了ptrace系统调用，这个也和平台有关系，如Linux平台下的man手册有说明，必须确保一个tracee的所有的ptrace requests来自相同的tracer线程，实现时就需要注意这点。

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

为了让读者能快速掌握核心调试原理，示例里我们有意简化了示例，如被调试进程是一个单线程程序，如果是一个多线程程序结果会不会不一样呢？会，而且我们要做一些特殊的处理。我们在这里进一步讨论下。

#### 问题：多线程程序attach后仍在运行？

有读者可能会自己开发一个go程序作为被调试程序，期间可能会遇到多线程给调试带来的一些困惑，这里也提一下。

假如我使用下面的go程序做为被调试程序：

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

结果发现执行了 `godbg attach <pid>`之后程序还在执行，这是为什么呢？

因为go程序天然是多线程程序，sysmon、gc等等都可能会用到独立线程，我们attach时只是简单的attach了pid对应进程的某一个线程，其他的线程仍然是没有被调试跟踪的，是可以正常执行的。

那我们ptrace时指定了pid到底attach了哪一个线程呢？**这个pid对应的线程难道不是执行main.main的线程吗？先回答读者问题：没错，还真不一定是！**

**go程序中函数main.main是由main goroutine来执行的，但是main goroutine并没有和main thread存在任何默认的绑定关系**。所以认为main.main一定运行在pid对应的线程之上是错误的！

> ps：附录《go runtime: go程序启动流程》中对go程序的启动流程做了分析，可以帮读者朋友打消这里main.main、main goroutine、main thread的一些疑虑。

在Linux下，线程其实是通过轻量级进程（LWP）来实现的，这里的ptrace参数pid实际上是线程对应的LWP的进程id。只对进程pid进行ptrace attach操作，结果是将只有这个进程pid对应的线程会被调试跟踪。

**在调试场景中，tracee指的是一个线程，而非一个进程包含的所有线程**，尽管我们有时候为了描述方便，在术语上会选择倾向于使用进程。

> 一个多线程的进程，其实是可以理解成一个包含了多个线程的线程组，线程组中的线程在创建的时候都通过系统调用clone+参数CLONE_THREAD来创建，来保证所有新创建的线程拥有相同的pid，类似clone+CLONE_PARENT使得克隆出的所有子进程都有相同的父进程id一样。
>
> golang里面通过clone系统调用以及如下选项来创建线程：
>
> ```go
>
> cloneFlags = _CLONE_VM | /* share memory */
> 	_CLONE_FS | /* share cwd, etc */
> 	_CLONE_FILES | /* share fd table */
> 	_CLONE_SIGHAND | /* share sig handler table */
> 	_CLONE_SYSVSEM | /* share SysV semaphore undo lists (see issue #20763) */
> 	_CLONE_THREAD /* revisit - okay for now */
> ```
>
> 关于clone选项的更多作用，您可以通过查看man手册 `man 2 clone`来了解。

pid标识的线程（或LWP）与发送ptrace请求的线程（或LWP）二者之间建立ptrace link，它们的角色分别为tracee、tracer，后续tracee期望收到的所有ptrace请求都来自这个tracer。因为这个原因，天然就是多线程的go程序就需要保证实际发送ptrace请求的goroutine必须执行在同一个线程上。

被调试进程中如果有其他线程，仍然是可以运行的，这就是为什么我们某些读者发现有时候被调试程序仍然在不停输出，因为tracer并没有在main.main内部设置断点，执行该函数的main goroutine可能由其他未被trace的线程执行，所以仍然可以看到程序不停输出。

#### 问题：想让执行main.main的线程停下来？

如果想让被调试进程停止执行，调试器需要枚举进程中包含的线程并对它们逐一进行ptrace attach操作。具体到Linux，可以列出 `/proc/<pid>/task`下的所有线程（或LWP）的pid，逐个执行ptrace attach。

我们将在后续过程中进一步完善attach命令，使其也能胜任多线程环境下的调试工作。

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
