## 扩展阅读：如何跟踪新创建的线程

### 实现目标

前面演示调试器操作时，为了简化多线程调试的挑战，有些测试场景我们使用了单线程程序来进行演示。但是真实场景下，我们的程序往往是多线程程序。

我们的调试器必须具备多线程调试的能力，这里有几类场景需要特别强调下：

- 父子进程，在调试器实现过程中，跟踪父子进程和跟踪进程内的线程，实现技术上差别不大。
  因为这是一款面向go调试器的书籍，所以我们只专注多线程调试。多进程调试我们会点一下，但是不会专门开一节来介绍。
- 线程的创建时机问题，可能是在我们attach之前创建出来的，也可能是我们attach之后线程通过clone又新创建出来的。
  - 对于进程已经创建的线程，我们需要具备枚举并且发起跟踪、切换不同线程跟踪的能力；
  - 对于进程调试期间新创建的线程，我们需要具备即时感知线程创建，并提示用户选择跟踪哪个线程的能力，方便用户对感兴趣的事件进行观察。

本节我们就先看下如何跟踪新创建的线程，并获取新线程的tid并发起跟踪，下一节我们看下如何枚举已经创建的线程并选择性跟踪指定线程。

### 基础知识

newosproc创建一个新的线程（newproc创建一个新的goroutine)，是通过 `clone` 系统调用来完成的，

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

上述clone函数定义的实现，在amd64架构中是这样实现的，clone函数实现 see go/src/runtime/sys_linux_amd64.s:

```go
 // int32 clone(int32 flags, void *stk, M *mp, G *gp, void (*fn)(void));
TEXT runtime·clone(SB),NOSPLIT,$0
	MOVL	flags+0(FP), DI 	// 准备系统调用参数
	MOVQ	stk+8(FP), SI
	...

	// Copy mp, gp, fn off parent stack for use by child.
	// Careful: Linux system call clobbers CX and R11.
	MOVQ	mp+16(FP), R13
	MOVQ	gp+24(FP), R9
	MOVQ	fn+32(FP), R12
	...

	MOVL	$SYS_clone, AX 		// clone系统调用号
	syscall				// 执行系统调用

	// In parent, return.
	CMPQ	AX, $0
	JEQ	3(PC)
	MOVL	AX, ret+40(FP)		// 父进程，返回clone出的新线程的tid
	RET

	// In child, on new stack.
	MOVQ	SI, SP

	// If g or m are nil, skip Go-related setup.
	CMPQ	R13, $0    // m
	JEQ	nog2
	CMPQ	R9, $0    // g
	JEQ	nog2

	// Initialize m->procid to Linux tid
	MOVL	$SYS_gettid, AX
	SYSCALL
	MOVQ	AX, m_procid(R13)

	// In child, set up new stack
	get_tls(CX)
	MOVQ	R13, g_m(R9)
	MOVQ	R9, g(CX)
	MOVQ	R9, R14 // set g register
	CALL	runtime·stackcheck(SB)

nog2:
	// Call fn. This is the PC of an ABI0 function.
	CALL	R12			// 新线程，初始化相关的gmp调度，开始执行线程函数mstart，
					// clone参数中有个 abi.FuncPCABI0(mstart)
	...
```

由此可知，其实只要tracee执行系统调用clone时，内核给我们一个通知就可以了，比如通过 `ptrace(PTRACE_SYSCALL, pid, ...)` ，这样tracee执行系统调用clone时，在enter syscall clone、exit syscall clone的位置会停下来，方便我们做点调试方面的工作，我们就可以读取此时RAX寄存器的值来判断当前系统调用号是不是 `__NR_clone` ，如果是，那说明执行了系统调用clone，我们就可以借此判断创建了一个新的线程。同样的可以在exit syscall的时候用类似的办法去获取新线程的tid信息。

通过这个办法可以感知到tracee创建了新线程，这是一个办法，但是这个办法 `ptrace(PTRACE_SYSCALL, pid, ...)` 过于通用了，你还要懂点ABI调用惯例（比如寄存器分配来传来系统调用号、返回值信息），使用起来就没有那么方便。

还是有一个办法，就是在执行 `ptrace(PTRACE_ATTACH, pid, ...)` 的时候传递选项 `PTRACE_O_TRACECLONE` ，这个操作是专门为跟踪clone系统调用而设置的，而且事后可以通过

1、tracer：run `ptrace(PTRACE_ATTACH, pid, NULL, PTRACE_O_TRACECLONE)`
   该操作将使得tracee执行clone系统调用时，内核会给tracer发送一个SIGTRAP信号，通知有clone系统调用发生，新线程或者新进程被创建出来了

2、tracer：需要主动去感知这个事件的发生，有两个办法：
    - 通过信号处理函数去感知这个信号的发生；
    - 通过waitpid()去感知到tracee的运行状态发生了改变，并通过waitpid返回的status来判断是否是PTRACE_EVENT_CLONE事件
      see: `man 2 ptrace` 中关于选项 PTRACE_O_TRACECLONE 的说明。

3、tracer如果确定了是clone导致的以后，可以进一步通过 `newpid = ptrace(PTRACE_GETEVENTMSG, pid, ...)` 拿到新线程的pid信息。

4、拿到线程pid之后就可以去干其他事，比如默认会自动将新线程纳入跟踪，我们可以选择放行新线程，或者观察、控制新线程

> ps: 可能会偶尔混用pid、tid信息，对于线程，其实就是一个clone出来的LWP（轻量级进程，light weight process），但是当我想描述一个线程的ID时，应该用tid这个术语，而不是pid这个术语。但是因为某些函数调用参数的原因，我可能偶尔会写成一样的pid，比如attach一个线程的时候，传递的参数应该是tid，而非这个线程的pid，它俩的值也是不一样的。
>
> - 这个线程所属的进程pid，这样获取 `getpid()`
> - 这个线程的线程tid（或者表述成对应的lwp的pid），通过这样获取 `syscall(SYS_gettid)`

第二种方法更容易理解和维护，设计实现时我们将采用第二种方法。但是由于第一种方法也非常有潜力，比如我们希望在调试时跟踪任意系统调用，我们就可以通过类似方法来实现，后面扩展阅读部分，我们也会单独一节对此进行进一步的介绍。

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
