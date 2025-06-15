## 扩展阅读：如何跟踪已经创建的线程

### 实现目标：跟踪已经创建的线程

被调试进程是多线程程序，在我们准备开始调试时，这些线程就已经被创建并在运行了。我们执行调试器 attach 操作时，也不会枚举所有线程然后手动去 attach 每个线程，为了方便我们只会去手动 attach 进程，然后希望程序侧能帮我们处理进程内非主线程以外其他线程的 attach 操作。

以dlv为例，不一定 `dlv attach <pid>` 之后就立即枚举所有线程然后逐个attach，但是要具备这个能力，比如当调试人员希望跟踪某个特定线程时，我们能够方便地执行这个操作，比如 `dlv>threads` 查看线程列表后，可以继续 `dlv> thread <n>` 来指名道姓地跟踪特定线程。

Go程序天然是多线程程序，而且是提供给开发者的是goroutine并发接口，并不是thread并发相关的接口，所以即使dlv有这个能力，也不一定经常会用到thread相关的调试命令，因为gmp调度模型的存在，你也不确定同一个thread上执行的到底是啥，它执行的goroutine会切换来切换去。反倒是 `dlv> goroutines` 和 `dlv> goroutine <n>` 使用频率更高。

anyway，我们必须说明的是，我们还是希望能了解多线程调试的相关底层细节，你可能将来会为其他语言开发调试器，对吧？并不一定是go语言，如果那种语言是面向thread的并发，那这些知识的实用性价值还是存在的。

### 基础知识

我们如何获取进程内所有线程呢？我们执行 `top -H -p <pid>` 可以列出指定进程内所有线程信息，可以解析拿到所有线程id。但是Linux /proc 虚拟文件系统提供了更方便的方式。其实只要遍历 `/proc/<pid>/task` 下的所有目录名即可。Linux内核会在上述目录下维护线程对应的任务信息，每个目录的名字是一个线程LWP的pid，每个目录内容包含了这个任务的一些信息。

举个例子，我们看下pid=1的进程的一些信息：

```bash
root🦀 ~ $ ls /proc/1/task/1/
arch_status  clear_refs  environ  io         mounts     oom_score_adj  sched         stack    uid_map
attr         cmdline     exe      limits     net        pagemap        schedstat     stat     wchan
auxv         comm        fd       maps       ns         personality    setgroups     statm
cgroup       cpuset      fdinfo   mem        oom_adj    projid_map     smaps         status
children     cwd         gid_map  mountinfo  oom_score  root           smaps_rollup  syscall
```

/proc 虚拟文件系统是内核提供的一个与内核交互的接口，可以读可以写，这并不是什么野路子，而是非常地道的方法，相比如top、vmstat、cgroup等等常见工具也是通过访问 /proc 来达成相关功能。
OK，对我们这个调试器而言，目前我们只需要直到：

- 要枚举进程的所有线程，我们就遍历 `/proc/<pid>/task` 下的目录；
- 要读取其完整的指令数据时，我们就读取目录下的 exe 文件；
- 要读取其启动参数数据，方便重启被调试进程、重启调试时，我们就读取目录下的 cmdline 文件；

OK，其他的当前我们可以先不关注。

### 设计实现

这部分实现代码，详见 [hitzhangjie/golang-debugger-lessons](https://github.com/hitzhangjie/golang-debugger-lessons) / 21_trace_old_threads。

首先为了测试方便，我们先准备一个testdata/fork_noquit.c的测试程序，跟前一小节的testdata/fork.c类似，它会创建线程并且打印pid、tid信息，不同的是，这里的线程永远不会退出，主要目的是给我们调试留下更充足的时间，避免因为线程退出导致后续跟踪线程失败。

```c
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <pthread.h>

pid_t gettid(void);

void *threadfunc(void *arg) {
    printf("process: %d, thread: %u\n", getpid(), syscall(SYS_gettid));
    while (1) {
        sleep(1);
    }
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
    while(1) {
        sleep(1);
    }
}

```

这个程序可以这样编译 `gcc -o fork_noquit fork_noquit.c -lpthread`，然后运行 `./fork_noquit` 观察其输出。

然后我们再来看看调试器部分的代码逻辑，这里主要是为了演示如何待调试进程中已经创建的线程，以及如何去跟踪它们，如何从跟踪这个线程切换为跟踪另一个线程。
程序核心逻辑如下：

- 我们执行 `./21_trace_old_threads $(pidof fork_noquit)`，此时会检查进程是否存在
- 然后回枚举进程中已创建的线程，方式就是通过读取 /proc 下的信息，然后输出所有线程id
- 然后提示用户输入一个希望跟踪的目标线程id，输入后开始跟踪这个线程，
- 当跟踪一个线程时，如果此前有正在跟踪的线程，需要先停止跟踪旧线程，然后再继续跟踪新线程

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

	fmt.Fprintf(os.Stdout, "===step1===: check target process existed or not\n")
	// pid
	pid, err := strconv.Atoi(os.Args[1])
	if err != nil {
		panic(err)
	}

	if !checkPid(int(pid)) {
		fmt.Fprintf(os.Stderr, "process %d not existed\n\n", pid)
		os.Exit(1)
	}

	// enumerate all threads
	fmt.Fprintf(os.Stdout, "===step2===: enumerate created threads by reading /proc\n")

	// read dir entries of /proc/<pid>/task/
	threads, err := readThreadIDs(pid)
	if err != nil {
		panic(err)
	}
	fmt.Fprintf(os.Stdout, "threads: %v\n", threads)

	// prompt user which thread to attach
	var last int64

	// attach thread <n>, or switch thread to another one thread <m>
	for {
		fmt.Fprintf(os.Stdout, "===step3===: supposing running `dlv> thread <n>` here\n")
		var target int64
		n, err := fmt.Fscanf(os.Stdin, "%d\n", &target)
		if n == 0 || err != nil || target <= 0 {
			panic("invalid input, thread id should > 0")
		}

		if last > 0 {
			if err := syscall.PtraceDetach(int(last)); err != nil {
				fmt.Fprintf(os.Stderr, "switch from thread %d to thread %d error: %v\n", last, target, err)
				os.Exit(1)
			}
			fmt.Fprintf(os.Stderr, "switch from thread %d thread %d\n", last, target)
		}

		// attach
		err = syscall.PtraceAttach(int(target))
		if err != nil {
			fmt.Fprintf(os.Stderr, "thread %d attach error: %v\n\n", target, err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stdout, "process %d attach succ\n\n", target)

		// check target process stopped or not
		var status syscall.WaitStatus
		var rusage syscall.Rusage
		_, err = syscall.Wait4(int(target), &status, 0, &rusage)
		if err != nil {
			fmt.Fprintf(os.Stderr, "process %d wait error: %v\n\n", target, err)
			os.Exit(1)
		}
		if !status.Stopped() {
			fmt.Fprintf(os.Stderr, "process %d not stopped\n\n", target)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stdout, "process %d stopped\n\n", target)

		regs := syscall.PtraceRegs{}
		if err := syscall.PtraceGetRegs(int(target), &regs); err != nil {
			fmt.Fprintf(os.Stderr, "get regs fail: %v\n", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stdout, "tracee stopped at %0x\n", regs.PC())

		last = target
		time.Sleep(time.Second)
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

// reads all thread IDs associated with a given process ID.
func readThreadIDs(pid int) ([]int, error) {
	dir := fmt.Sprintf("/proc/%d/task", pid)
	files, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	var threads []int
	for _, file := range files {
		tid, err := strconv.Atoi(file.Name())
		if err != nil { // Ensure that it's a valid positive integer
			continue
		}
		threads = append(threads, tid)
	}
	return threads, nil
}
```

### 代码测试

1、先看看testdata/fork_noquit.c，这个程序每隔一段时间就创建一个pthread线程出来

主线程、其他线程创建出来后都会打印该线程对应的pid、tid（这里的tid就是对应的lwp的pid）

> ps: fork_noquit.c 和 fork.c 的区别就是每个线程都会不停sleep(1) 永远不会退出，这么做的目的就是我们跑这个测试用时比较久，让线程不退出可以避免我们输入线程id执行attach thread 或者 switch thread1 to thread2 时出现线程已退出导致失败的情况。

下面执行该程序等待被调试器调试：

```bash
zhangjie🦀 testdata(master) $ ./fork_noquit
process: 12368, thread: 12368
process: 12368, thread: 12369
process: 12368, thread: 12527
process: 12368, thread: 12599
process: 12368, thread: 12661
...
```

2、我们同时观察 ./21_trace_old_threads `<上述fork_noquit程序进程pid>` 的执行情况

```bash
zhangjie🦀 21_trace_old_threads(master) $ ./21_trace_old_threads 12368
===step1===: check target process existed or not

===step2===: enumerate created threads by reading /proc
threads: [12368 12369 12527 12599 12661 12725 12798 12864 12934 13004 13075]    <= created thread IDs

===step3===: supposing running `dlv> thread <n>` here
12369
process 12369 attach succ                                                       <= prompt user input and attach thread
process 12369 stopped
tracee stopped at 7f06c29cf098

===step3===: supposing running `dlv> thread <n>` here
12527
switch from thread 12369 thread 12527
process 12527 attach succ                                                       <= prompt user input and switch thread
process 12527 stopped
tracee stopped at 7f06c29cf098

===step3===: supposing running `dlv> thread <n>` here

```

3、上面我们先后输入了两个线程id，第一次输入的12369，第二次输入的时12527，我们分别看下这两次输入时线程状态变化如何

最开始没有输入时，线程状态都是 S，表示Sleep，因为线程一直在做 `while(1) {sleep(1);}` 这个操作，处于sleep状态很好理解。

```bash
$ top -H -p 12368

top - 00:54:17 up 8 days,  2:10,  2 users,  load average: 0.02, 0.06, 0.08
Threads:   7 total,   0 running,   7 sleeping,   0 stopped,   0 zombie
%Cpu(s):  0.1 us,  0.1 sy,  0.0 ni, 99.8 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
MiB Mem :  31964.6 total,  26011.4 free,   4052.5 used,   1900.7 buff/cache
MiB Swap:   8192.0 total,   8192.0 free,      0.0 used.  27333.2 avail Mem

  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
12368 zhangjie  20   0   55804    888    800 S   0.0   0.0   0:00.00 fork_noquit
12369 zhangjie  20   0   55804    888    800 S   0.0   0.0   0:00.00 fork_noquit
12527 zhangjie  20   0   55804    888    800 S   0.0   0.0   0:00.00 fork_noquit
12599 zhangjie  20   0   55804    888    800 S   0.0   0.0   0:00.00 fork_noquit
12661 zhangjie  20   0   55804    888    800 S   0.0   0.0   0:00.00 fork_noquit
12725 zhangjie  20   0   55804    888    800 S   0.0   0.0   0:00.00 fork_noquit
12798 zhangjie  20   0   55804    888    800 S   0.0   0.0   0:00.00 fork_noquit
...
```

在我们输入了12369后，线程12369的状态从 S 变成了 t，表示线程现在正在被调试器调试（traced状态）

```bash
12369 zhangjie  20   0   88588    888    800 t   0.0   0.0   0:00.00 fork_noquit
```

在我们继续输入了12527之后，调试行为从跟踪线程12369变为跟踪12527,，我们看到线程12369重新从t切换为S，而12527从S切换为t

```bash
12369 zhangjie  20   0   88588    888    800 S   0.0   0.0   0:00.00 fork_noquit
12527 zhangjie  20   0   88588    888    800 t   0.0   0.0   0:00.00 fork_noquit
```

OK，ctrl+c杀死 ./21_trace_old_threads 进程，然后我们继续观察线程的状态，会自动从t变为S，因为内核会负责善后，即在tracer退出后，将所有的tracee恢复执行。

### 引申一下

大家在进行多线程调试时，有可能会只跟踪一个线程，也可能会同时跟踪多个线程，最终实现形式取决于调试器的交互设计，比如命令行形式的调试器因为界面交互的原因往往更倾向于跟踪一个线程，但是有些图形化界面的IDE可能会倾向于提供同时跟踪多个线程的能力（以前使用Eclipse调试Java多线程程序时就经常这么玩）。我们这里演示了这个能力该如何实现，读者对于如何实现同时跟踪多个线程应该也能自己实现了。
