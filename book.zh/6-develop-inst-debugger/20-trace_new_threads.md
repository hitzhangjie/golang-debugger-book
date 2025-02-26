## 扩展阅读：如何跟踪新创建的线程

### 关键操作

1、tracer：run `ptrace(PTRACE_ATTACH, pid, NULL, PTRACE_O_TRACECLONE)`
   该操作将使得tracee执行clone系统调用时，内核会给tracer发送一个SIGTRAP信号，通知有clone系统调用发生，新线程或者新进程被创建出来了
2、tracer：需要主动去感知这个事件的发生，有两个办法：
    - 通过信号处理函数去感知这个信号的发生；
    - 通过waitpid()去感知到tracee的运行状态发生了改变，并通过waitpid返回的status来判断是否是PTRACE_EVENT_CLONE事件
      see: `man 2 ptrace` 中关于选项 PTRACE_O_TRACECLONE 的说明。
3、tracer如果确定了是clone导致的以后，可以拿到deliver这个信号的其他信息，如新线程的pid

4、拿到线程pid之后就可以去干其他事，比如默认会自动将新线程纳入跟踪，我们可以选择放行新线程，或者观察、控制新线程

### 设计实现

这部分实现代码，详见 [hitzhangjie/golang-debugger-lessons](https://github.com/hitzhangjie/golang-debugger-lessons) / 20_trace_new_threads。

首先为了后面测试方便，我们先用C语言来实现一个多线程程序，程序逻辑很简单，就是每隔一段时间就创建个新线程，线程函数就是打印当前线程的pid，以及线程lwp的pid。

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

		// 获取子线程对应的lwp的pid
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

### 引申一下

至此，测试方法介绍完了，我们可以引申下，在我们这个测试的基础上我们可以提示用户，你想跟踪当前线程呢，还是想跟踪新线程呢？类似地这个在gdb调试多进程、多线程程序时时非常有用的，联想下gdb中的 `set follow-fork-mode` ，我们可以选择 parent、child、ask 中的一种，并且允许在调试期间在上述选项之间进行切换，如果我们提前规划好了，fork后要跟踪当前线程还是子线程（or进程），这个功能特性就非常的有用。

dlv里面提供了一种不同的做法，它是通过threads来切换被调试的线程的，实际上go也不会暴漏线程变成api给开发者，大家大多数时候应该也用不到去显示跟踪clone新建线程后新线程的执行情况，所以应该极少像gdb set follow-fork-mode调试模式一样去使用。我们这里只是引申一下。
