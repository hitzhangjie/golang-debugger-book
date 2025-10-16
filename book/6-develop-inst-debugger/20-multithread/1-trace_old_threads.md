## 调试多线程程序 - 跟踪已创建线程

### 实现目标：跟踪已经创建的线程

在我们准备开始调试时，有些线程就已经被创建并在运行了，如何枚举并跟踪进程中已有的线程呢？以dlv为例，`dlv attach <pid>` 之后会立即枚举并跟踪所有线程，包括已经存在的线程，以及将来可能创建的线程。

除了跟踪所有线程，dlv调试器还提供切换线程上下文的能力。比如当调试人员希望查看某个特定线程的状态时，可以通过 `dlv>threads` 查看线程列表，然后使用 `dlv> thread <n>` 来切换到特定线程的上下文，这样后续的寄存器查看、变量打印等命令就会显示该线程上下文下的值。另外，dlv也提供了查看goroutines列表并切换goroutine上下文的能力。

Go程序天然是多线程程序，而且是提供给开发者的并发控制能力是goroutine粒度的，而非线程粒度的。因为Go语言GMP调度的关系，进程中创建的goroutines会被运行时调度到多个线程上执行，即使是同一个goroutine也可能在多个线程上执行。这给后续面向Go程序的断点管理、执行控制机制也带来了一些挑战，对Go运行时理解不够深入，调试器对Go中线程、协程的执行控制就很难做到位，是不可能开发出达到应用水准的调试器的。

>ps: 比如我们在两个地址处addr1、addr2分别设置了断点，但是从某个线程命中addr1处断点停下后，我们显示执行continue，再到某个线程执行到addr2处断点停下，你希望哪个线程停在地址addr2出呢？任意一个线程，当前跟踪的线程，还是当前线程正在执行的goroutine？如何实现直接决定了调试体验、调试效率。

OK，收回来，本节我们先聚焦如何跟踪进程中已经创建的所有线程。

### 基础知识

要跟踪进程中已经创建的线程，我们首先要能够获取进程内所有线程，然后才能逐个跟踪。那如何获取进程内所有线程呢？

熟悉Linux系统的同学，很自然会想到执行 `top -H -p <pid>` 可以列出指定进程内所有线程信息，但是top输出信息繁杂，通过解析top输出拿到所有线程id的方式并不太方便。Linux虚拟文件系统 `/proc` 提供了更方便的方式，只要遍历 `/proc/<pid>/task` 下的所有目录名即可。Linux内核会在上述目录下维护线程对应的任务信息，每个目录的名字是一个线程LWP的pid，每个目录内容包含了这个任务的一些信息。

举个例子，我们看下pid=1的进程的一些信息：

```bash
root🦀 ~ $ ls /proc/1/task/1/
arch_status  clear_refs  environ  io         mounts     oom_score_adj  sched         stack    uid_map
attr         cmdline     exe      limits     net        pagemap        schedstat     stat     wchan
auxv         comm        fd       maps       ns         personality    setgroups     statm
cgroup       cpuset      fdinfo   mem        oom_adj    projid_map     smaps         status
children     cwd         gid_map  mountinfo  oom_score  root           smaps_rollup  syscall
```

虚拟文件系统 `/proc` 是内核提供的一个程序与内核交互的接口，可以读可以写，这并不是什么野路子，而是非常地道的方法，相比如top、vmstat、cgroup等等常见工具也是通过访问 /proc 来达成相关功能。

OK，对我们这个调试器而言，目前我们只需要知道：

- 要枚举进程的所有线程，我们就遍历 `/proc/<pid>/task` 下的目录；
- 要读取其完整的指令数据时，我们就读取目录下的 exe 文件；
- 要读取其启动参数数据，方便重启被调试进程、重启调试时，我们就读取目录下的 cmdline 文件；

ps：OK，这个目录 `/proc/<pid>/task` 下还有很多其他目录和文件，我们可以先不关注。

当我们拿到了进程内所有线程id列表之后，就可以逐个跟踪这些线程了，前面我们讲过如何跟踪单个线程，现在的工作量只是for循环遍历这些线程id，然后逐个跟踪而已。

### 设计实现

#### 准备测试程序

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

#### 调试器逻辑实现

这部分实现代码，详见 [hitzhangjie/golang-debugger-lessons](https://github.com/hitzhangjie/golang-debugger-lessons) / 21_trace_old_threads。

然后我们再来看看调试器部分的代码逻辑，这里主要是为了演示如何待调试进程中已经创建的线程，以及如何去跟踪它们，如何从跟踪这个线程切换为跟踪另一个线程。
程序核心逻辑如下：

- 我们执行 `./21_trace_old_threads $(pidof fork_noquit)`，此时会检查进程是否存在
- 然后回枚举进程中已创建的线程，方式就是通过读取 /proc 下的信息，然后输出所有线程id
- 然后提示用户输入一个希望跟踪的目标线程id，输入后开始跟踪这个线程，
  ps：如果已经有一个调试器实例在跟踪目标进程了，需要先停止，然后再重新启动调试器实例跟踪目标进程 （否则，内核会返回权限错误）。

file: 21_trace_old_threads/main.go

```go
package main

import (
    "fmt"
    "os"
    "os/exec"
    "runtime"
    "strconv"
    "syscall"
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

    // check pid is valid process's id
    pid, err := strconv.Atoi(os.Args[1])
    if err != nil {
        panic(err)
    }
    if !checkPid(int(pid)) {
        fmt.Fprintf(os.Stderr, "process %d not existed\n\n", pid)
        os.Exit(1)
    }

    fmt.Fprintf(os.Stdout, "===step2===: enumerate created threads by reading /proc\n")

    // enumerate all threads by reading /proc/<pid>/task/
    threads, err := readThreadIDs(pid)
    if err != nil {
        panic(err)
    }
    fmt.Fprintf(os.Stdout, "threads: %v\n", threads)

    fmt.Fprintf(os.Stdout, "===step3===: attach to all threads for tracing\n")

    // attach to all threads for tracing
    attachedThreads := make(map[int]bool)
    for _, tid := range threads {
        err := syscall.PtraceAttach(tid)
        if err != nil {
            fmt.Fprintf(os.Stderr, "thread %d attach error: %v\n", tid, err)
            continue
        }
        attachedThreads[tid] = true
        fmt.Fprintf(os.Stdout, "thread %d attached successfully\n", tid)
    }

    fmt.Fprintf(os.Stdout, "attached to %d threads total\n\n", len(attachedThreads))

    // wait for all attached threads to stop
    fmt.Fprintf(os.Stdout, "===step4===: wait for all threads to stop\n")
    for tid := range attachedThreads {
        var status syscall.WaitStatus
        var rusage syscall.Rusage
        _, err := syscall.Wait4(tid, &status, 0, &rusage)
        if err != nil {
            fmt.Fprintf(os.Stderr, "thread %d wait error: %v\n", tid, err)
            continue
        }
        if !status.Stopped() {
            fmt.Fprintf(os.Stderr, "thread %d not stopped\n", tid)
            continue
        }
        fmt.Fprintf(os.Stdout, "thread %d stopped\n", tid)
    }

    // show current state of all traced threads
    fmt.Fprintf(os.Stdout, "\n===step5===: show current state of all traced threads\n")
    for tid := range attachedThreads {
        regs := syscall.PtraceRegs{}
        if err := syscall.PtraceGetRegs(tid, &regs); err != nil {
            fmt.Fprintf(os.Stderr, "thread %d get regs fail: %v\n", tid, err)
            continue
        }
        fmt.Fprintf(os.Stdout, "thread %d stopped at %0x\n", tid, regs.PC())
    }

    fmt.Fprintf(os.Stdout, "\nAll threads are now being traced. Use Ctrl+C to exit.\n")
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

1、先看看testdata/fork_noquit.c，这个程序每隔一段时间就创建一个pthread线程出来。主线程、其他线程创建出来后都会打印该线程对应的pid、tid（这里的tid就是对应的lwp的pid）。

> ps: fork_noquit.c 和 fork.c 的区别就是每个线程都会不停sleep(1) 永远不会退出，这么做的目的就是我们跑这个测试用时比较久，让线程不退出可以避免我们输入线程id执行attach thread 或者 switch thread1 to thread2 时出现线程已退出导致失败的情况。

下面执行该程序等待被调试器调试：

```bash
zhangjie🦀 testdata(master) $ ./fork_noquit
process: 136593, thread: 136593
process: 136593, thread: 136594
process: 136593, thread: 137919
process: 136593, thread: 139891
process: 136593, thread: 140428
...
```

2、此时我们检查上述测试程序的线程运行情况，可以看到线程状态都是 S，表示Sleep，因为线程一直在做 `while(1) {sleep(1);}` 这个操作，处于sleep状态很好理解。

```bash
$ top -H -p `pidof fork_noquit`

top - 20:25:47 up 1 day,  5:20,  3 users,  load average: 0.29, 0.50, 0.62
Threads:  11 total,   0 running,  11 sleeping,   0 stopped,   0 zombie
...

    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND         
 136593 root      20   0   90680   1104   1000 S   0.0   0.0   0:00.00 fork_noquit     
 136594 root      20   0   90680   1104   1000 S   0.0   0.0   0:00.00 fork_noquit     
 137919 root      20   0   90680   1104   1000 S   0.0   0.0   0:00.00 fork_noquit     
 139891 root      20   0   90680   1104   1000 S   0.0   0.0   0:00.00 fork_noquit     
 140428 root      20   0   90680   1104   1000 S   0.0   0.0   0:00.00 fork_noquit     
 140765 root      20   0   90680   1104   1000 S   0.0   0.0   0:00.00 fork_noquit     
 141267 root      20   0   90680   1104   1000 S   0.0   0.0   0:00.00 fork_noquit     
 141548 root      20   0   90680   1104   1000 S   0.0   0.0   0:00.00 fork_noquit     
 141801 root      20   0   90680   1104   1000 S   0.0   0.0   0:00.00 fork_noquit     
 143438 root      20   0   90680   1104   1000 S   0.0   0.0   0:00.00 fork_noquit     
 144174 root      20   0   90680   1104   1000 S   0.0   0.0   0:00.00 fork_noquit 
...
```

3、现在我们执行 ./21_trace_old_threads `pidof fork_noquit` 来跟踪fork_noquit程序内创建的所有线程。可以看到，上述测试输出了fork_noquit程序内已经创建的线程pid列表，然后逐一attach跟踪这些线程，并输出了每个线程当前暂停的地址。

```bash
zhangjie🦀 21_trace_old_threads(master) $ ./21_trace_old_threads `pidof fork_noquit`
===step1===: check target process existed or not

===step2===: enumerate created threads by reading /proc
threads: [136593 136594 137919 139891 140428 140765 141267 141548 141801 143438 144174]

===step3===: attach to all threads for tracing
thread 136593 attached successfully
thread 136594 attached successfully
thread 137919 attached successfully
thread 139891 attached successfully
thread 140428 attached successfully
...
attached to 11 threads total

===step4===: wait for all threads to stop
thread 136593 stopped
thread 136594 stopped
thread 144174 stopped
thread 140765 stopped
thread 141267 stopped
...

===step5===: show current state of all traced threads
thread 141801 stopped at 7f85f5783098
thread 143438 stopped at 7f85f5783098
thread 137919 stopped at 7f85f5783098
thread 139891 stopped at 7f85f5783098
thread 140428 stopped at 7f85f5783098
...

All threads are now being traced. Use Ctrl+C to exit.
```

4、现在我们继续运行 `top -H -p $(pidof fork_noquit` 来观察线程状态变化。可以看到进程内所有线程的状态从 S 变成了 t，表示线程现在正在被调试器调试（traced状态）。

```bash
$ top -H -p `pidof fork_noquit`

top - 20:30:40 up 1 day,  5:18,  3 users,  load average: 0.34, 0.56, 0.65
Threads:  11 total,   0 running,   0 sleeping,  11 stopped,   0 zombie
...

    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND         
 136593 root      20   0   90680   1104   1000 t   0.0   0.0   0:00.00 fork_noquit     
 136594 root      20   0   90680   1104   1000 t   0.0   0.0   0:00.00 fork_noquit     
 137919 root      20   0   90680   1104   1000 t   0.0   0.0   0:00.00 fork_noquit     
 139891 root      20   0   90680   1104   1000 t   0.0   0.0   0:00.00 fork_noquit     
 140428 root      20   0   90680   1104   1000 t   0.0   0.0   0:00.00 fork_noquit     
 140765 root      20   0   90680   1104   1000 t   0.0   0.0   0:00.00 fork_noquit     
 141267 root      20   0   90680   1104   1000 t   0.0   0.0   0:00.00 fork_noquit     
 141548 root      20   0   90680   1104   1000 t   0.0   0.0   0:00.00 fork_noquit     
 141801 root      20   0   90680   1104   1000 t   0.0   0.0   0:00.00 fork_noquit     
 143438 root      20   0   90680   1104   1000 t   0.0   0.0   0:00.00 fork_noquit     
 144174 root      20   0   90680   1104   1000 t   0.0   0.0   0:00.00 fork_noquit  
```

5、最后ctrl+c杀死 ./21_trace_old_threads 进程，然后我们继续观察线程的状态，会发现从t变为S。此时调试程序21_trace_old_threads结束前并没有显示detach，但是内核会帮忙做些善后的工作，即让tracer跟踪的tracee恢复执行。

### 本节小结

本节主要探讨了调试多线程程序时如何跟踪已经创建的线程这一核心问题。通过分析Linux系统提供的 `/proc` 虚拟文件系统接口，我们掌握了枚举进程中所有线程的方法：遍历 `/proc/<pid>/task` 目录下的所有子目录名即可获取所有线程ID。在此基础上，我们实现了完整的线程跟踪机制，包括进程存在性检查、线程枚举、批量attach跟踪、等待线程停止以及显示线程状态等关键步骤。

本节的核心要点包括：利用 `/proc/<pid>/task` 目录枚举进程内所有线程；通过 `syscall.PtraceAttach` 批量跟踪多个线程；使用 `syscall.Wait4` 等待所有被跟踪线程停止；通过 `syscall.PtraceGetRegs` 获取线程寄存器状态。通过实际测试验证，我们成功实现了对多线程程序的完整跟踪，所有线程状态从Sleep变为Traced，证明了实现的正确性。本节内容为读者理解多线程调试的核心机制提供了实践基础，为后续学习更复杂的调试功能做好了准备。下一节我们将探讨如何自动跟踪进程内后续新创建的线程。

ps: Go程序的GMP调度机制使得线程与goroutine的映射关系更加复杂，这为面向Go程序的调试器开发带来了额外的挑战。这部分内容我们将在第九章符号级调试器开发部分进一步探讨。

