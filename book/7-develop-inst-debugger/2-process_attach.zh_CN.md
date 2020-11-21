## Attach进程 

### 实现目标：`godbg attach -p <pid>`

有时待进程已经在运行了，如果要对其进行调试需要将进程挂住(attach)，让其停下来等待调试器对其进行控制。

常见的调试器如dlv、gdb等都支持通过参数 `-p pid` 的形式来传递目标进程号来对运行重的进程进行调试。

我们将实现程序godbg，它支持exec子命令，支持接收参数 `-p pid`，如果目标进程存在，godb将attach到目标进程，此时目标进程会暂停执行。然后我们让godbg休眠几秒钟，再detach目标进程，目标进程会恢复执行。这里休眠的几秒钟，可以演变成一系列的调试操作，如设置断点、检查进程寄存器、检查内存等等。

### 基础知识

首先要进一步明确tracee的概念，虽然我们看上去是对进程进行调试，实际上调试器内部工作时，是对一个一个的线程进行调试。

tracee，指的是被调试的线程，而不是进程，对于一个多线程程序而言，可能要将部分或者全部的线程作为tracee以方便调试，没有被traced的线程将会继续执行，而被traced的线程则受调试器控制。甚至同一个被调试进程中的不同线程，可以由不同的tracer来控制。

tracer，指的是向tracee发送调试控制命令的调试进程，准确地说，也是线程。

一旦tracer和tracee建立了联系之后，tracer就可以给tracee发送各种调试命令。通常，如果调试器也是多线程程序，通常要考虑将发送调试命令给特定tracee的task绑定到特定线程上，因为从tracee角度而言，它认为调试命令应该来自同一个tracer（同一个线程）。所以，在我们参考dlv等调试器的实现时会发现，发送调试命令的goroutine通常会调用`runtime.LockOSThread()`来绑定一个线程，专门用来向attached tracee发送调试指令（也就是各种ptrace操作）。

>runtime.LockOSThread()，被绑定的线程只会用来执行调用该函数的goroutine，除非该goroutine调用了runtime.UnLockOSThread()解除这种绑定关系，否则该线程不会用来调度其他goroutine。

当我们调用了attach之后，attach返回时，tracee有可能还没有停下来，这个时候需要通过wait方法来等tracee停下来，并获取tracee的状态信息。当结束调试时，可以通过detach操作，让tracee恢复执行。

>PTRACE_ATTACH  
    Attach to the process specified in pid, making it a tracee of
    the calling process.  The tracee is sent a SIGSTOP, but will
    not necessarily have stopped by the completion of this call;
    use waitpid(2) to wait for the tracee to stop.  See the "At‐
    taching and detaching" subsection for additional information.
>
>PTRACE_DETACH  
    Restart the stopped tracee as for PTRACE_CONT, but first de‐
    tach from it.  Under Linux, a tracee can be detached in this
    way regardless of which method was used to initiate tracing.

### 代码实现

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
    - 接下来校验第2个参数，如果是不支持的subcmd，也直接报错退出；
    - 如果是attach，那么pid参数应该是这个整数，如果不是也直接退出；
- 参数正常情况下，开始尝试attach到tracee；
- attach之后，tracee并不一定立即就会停下来，需要wait来获取其状态变化情况；
- 等tracee停下来之后，我们休眠10s钟，仿佛自己正在干些调试操作一样；
- 10s钟之后，tracer尝试detach tracee，让tracee继续恢复执行。

我们在Linux平台上实现时，需要考虑Linux平台本身的问题，具体包括：
- 通过pid是否对应着一个有效的进程，通常会通过`exec.FindProcess(pid)`来检查，但是在Unix平台下，这个函数总是返回OK，所以是行不通的。因此我们借助了`kill -s 0 pid`这一比较经典的做法来检查pid合法性。
- tracer、tracee进行detach操作的时候，我们是用了ptrace系统调用，这个也和平台有关系，如Linux平台下的man手册就直接点出了在设计上可能存在一点问题，因此开发人员在进行处理时，就需要注意一下，如确保一个tracee的所有的ptrace requests来自相同的tracer线程。

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
Sat Nov 14 14:29:14 UTC 2020 pid: 1311  ==> 14s attached and stopped

Sat Nov 14 14:29:24 UTC 2020 pid: 1311  ==> 24s detached and continued
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

### 更多相关内容

有读者可能会自己开发一个go程序作为被调试程序，期间可能会遇到多线程给调试带来的一些困惑，这里也提一下。

假如我使用下面的go程序做为被调试程序：

```go
import (
    "fmt"
    "time"
    "os"
)
func main() {
    {
        time.Sleep(time.Second)
        fmt.Println("pid:", os.Getpid())
    }
}
```

结果发现执行了`godbg attach <pid>`之后程序还在执行，这是为什么呢？

因为go程序天然是多线程程序，sysmon、gc等等都可能会用到独立线程，我们attach时只是简单的attach了pid对应进程的某一个线程，那到底是哪一个线程呢？主线程？听我慢慢道来。

当tracer发送`ptrace(PTRACE_ATTACH,...)`给被调试进程时，内核会生成一个SIGTRAP信号发送给被调试进程，被调试进程如果是多线程程序的话，内核就要选择一个线程来处理这个信号，感兴趣可查看内核源码：[kernel/signal.c:complete_signal](https://sourcegraph.com/github.com/torvalds/linux@27bba9c532a8d21050b94224ffd310ad0058c353/-/blob/kernel/signal.c#L990)。

实际接收信号的线程与发送ptrace请求来的线程二者之间建立ptrace link，它们的角色分别为tracee、tracer，后续tracee期望收到的所有ptrace请求都来自这个tracer。

被调试进程中的其他线程，如果有，仍然是可以运行的，这就是为什么我们某些读者发现有时候被调试程序仍然在不停输出。

如果想让被调试进程停止执行，有两个办法可以做到：

- 方法1，调试器枚举被调试进程下所有的线程，逐个attach；
- 方法2，被测试程序启动到时候通过变量GOMAXPROCS=1限制最大并发执行线程数；

我们将在后续过程中进一步完善attach命令，使其也能胜任多线程环境下的调试工作。