## 调试多线程程序 - 跟踪已创建线程

### 实现目标：枚举并跟踪已创建的线程

在我们准备开始调试时，有些线程就已经被创建并在运行了，如何枚举并跟踪进程中已有的线程呢？以dlv为例，`dlv attach <pid>` 之后会立即枚举并跟踪所有线程，包括已经存在的线程，以及将来可能创建的线程。

除了跟踪所有线程，dlv调试器还提供切换线程上下文的能力。比如当调试人员希望查看某个特定线程的状态时，可以通过 `dlv>threads` 查看线程列表，然后使用 `dlv> thread <n>` 来切换到特定线程的上下文，这样后续的寄存器查看、变量打印等命令就会显示该线程上下文下的值。另外，dlv也提供了查看goroutines列表并切换goroutine上下文的能力。

Go程序天然是多线程程序，并且提供给开发者的是面向goroutine的并发控制能力，而非面向线程的。Go语言GMP调度设计使得进程中创建的goroutines会被运行时调度到多个线程上执行，即使是同一个goroutine也可能在多个线程上执行。这给后续面向Go程序的断点管理、执行控制机制也带来了一些挑战。

本节我们先聚焦如何跟踪进程中已经创建的所有线程。

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

### 代码实现

在 godbgv2 中，“attach 一个进程”并不只是 attach 它的主线程（线程组 leader），而是把该进程当时已有的全部线程都纳入跟踪。这条链路由命令层、service 门面和 target 层三部分组成。

#### 命令层：`attach` 返回并打印全部线程

**file：cmd/attach.go**

```go
package cmd

import (
	"errors"
	"fmt"
	"strconv"

	"github.com/spf13/cobra"
)

// attachCmd 跟踪正在运行的进程
var attachCmd = &cobra.Command{
	Use:   "attach <pid>",
	Short: "跟踪正在运行的进程",
	Long:  `跟踪正在运行的进程`,
	RunE: func(cmd *cobra.Command, args []string) error {

		if len(args) != 1 {
			return errors.New("参数错误")
		}
		pid, err := strconv.Atoi(args[0])
		if err != nil {
			return fmt.Errorf("invalid pid %q: %v", args[0], err)
		}

		// attach 到运行中的进程及其全部线程，等待其因 SIGSTOP 而停止
		tids, err := Client.Attach(pid)
		if err != nil {
			return err
		}
		fmt.Printf("process %d attached, stopped by SIGSTOP\n", pid)
		for _, tid := range tids {
			fmt.Printf("thread %d attached\n", tid)
		}
		return nil
	},
	PostRun: func(cmd *cobra.Command, args []string) {
		// 会话退出（含 --init 批量回放结束）时统一善后，见 session.go
		startDebugSession(cmd)
	},
}

func init() {
	rootCmd.AddCommand(attachCmd)
}
```

`Client.Attach` 的返回值从原来的 `error` 改成了 `([]int, error)`：target 层枚举并 attach 完所有线程后，把线程 id 列表一路返回给命令层，命令层再逐行打印出来。

#### service 层：门面把线程列表交回 UI

**file：pkg/service/debugger/debugger.go**（片段）

```go
// Attach 跟踪一个正在运行的进程，返回跟踪到的全部线程 id
func (d *Debugger) Attach(pid int) ([]int, error) {
	dbp, err := target.AttachTargetProcess(pid)
	if err != nil {
		return nil, err
	}
	d.dbp = dbp

	tids := []int{}
	for tid := range dbp.Threads {
		tids = append(tids, tid)
	}
	sort.Ints(tids)
	return tids, nil
}
```

门面只做两件事：调用 target 层的 `AttachTargetProcess`，再把 `DebuggedProcess.Threads` 中的 tid 收集起来排序返回。`api.Client` 接口中的 `Attach(pid int) ([]int, error)` 也同步调整，命令层只依赖接口，不关心线程是怎么枚举出来的。

#### target 层：枚举并跟踪全部线程

**file：pkg/target/thread.go**

```go
package target

import (
	"fmt"
	"path/filepath"
	"strconv"
	"syscall"
)

// Thread 线程信息
type Thread struct {
	Tid     int              // thread ID
	Process *DebuggedProcess // process this thread belongs to
}

// addThread 将线程tid加入线程列表。
//
// attach=true 表示该线程尚未被跟踪，需要先 attach 再等待其停止；
// attach=false 表示该线程已被跟踪（如 TRACEME 的主线程、
// 或 ch6.20.2 起经 PTRACE_O_TRACECLONE 自动跟踪的新线程）。
func (p *DebuggedProcess) addThread(tid int, attach bool) (*Thread, error) {
	if thread, ok := p.Threads[tid]; ok {
		return thread, nil
	}

	if attach {
		err := p.ExecPtrace(func() error { return syscall.PtraceAttach(tid) })
		if err != nil && err != syscall.EPERM {
			// Do not return err if err == EPERM, we may already be
			// tracing this thread due to PTRACE_O_TRACECLONE
			// (ch6.20.2). We will surely blow up later if we truly
			// don't have permissions.
			return nil, fmt.Errorf("could not attach to new thread %d %s", tid, err)
		}
		pid, status, err := p.waitFast(tid)
		if err != nil {
			return nil, fmt.Errorf("wait fast err: %v", err)
		}
		if status.Exited() {
			return nil, fmt.Errorf("thread already exited %d", pid)
		}
	}

	p.Threads[tid] = &Thread{
		Tid:     tid,
		Process: p,
	}
	return p.Threads[tid], nil
}

// waitFast 等待指定线程进入停止状态（阻塞式）
func (p *DebuggedProcess) waitFast(pid int) (int, *syscall.WaitStatus, error) {
	var s syscall.WaitStatus
	wpid, err := syscall.Wait4(pid, &s, syscall.WALL, nil)
	return wpid, &s, err
}

// loadThreadList 通过 /proc/pid/task 读取进程的线程列表
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

// updateThreadList 将 /proc/pid/task 下的全部线程加入线程列表。
//
// 主线程已被跟踪（TRACEME 或 attach），其余线程需要逐个 attach。
func (p *DebuggedProcess) updateThreadList() error {
	tids, err := p.loadThreadList()
	if err != nil {
		return fmt.Errorf("load threads err: %v", err)
	}

	for _, tid := range tids {
		_, err := p.addThread(tid, tid != p.Process.Pid)
		if err != nil {
			return fmt.Errorf("add thread err: %v", err)
		}
	}
	return nil
}
```

`loadThreadList` 用 `filepath.Glob` 展开 `/proc/<pid>/task/*`，每个目录名就是一个线程的 LWP id。`updateThreadList` 对列表中的每个 tid 调用 `addThread`：主线程传 `attach=false`（它已经被 TRACEME 或 attach 跟踪），其余线程传 `attach=true`，先 `PTRACE_ATTACH` 再 `waitFast` 等它停下来。

`addThread` 对 `EPERM` 的容忍是给下一节准备的：设置 `PTRACE_O_TRACECLONE` 后，新线程会被内核自动跟踪，此时再去 attach 它就会得到 `EPERM`，这不是真正的错误。

attach 流程在 target 层的入口如下：

**file：pkg/target/process.go**（片段）

```go
// AttachTargetProcess attach 到一个正在运行的进程及其全部线程。
func AttachTargetProcess(pid int) (p *DebuggedProcess, err error) {
	p = &DebuggedProcess{
		Process:         nil,
		Command:         "",
		Args:            nil,
		Kind:            ATTACH,
		Threads:         map[int]*Thread{},
		Breakpoints:     map[uintptr]*Breakpoint{},
		BreakpointsByID: map[uint64]*Breakpoint{},

		once:   &sync.Once{},
		reqCh:  make(chan ptraceRequest, 16),
		doneCh: make(chan int),
	}

	if p.Process, err = os.FindProcess(pid); err != nil {
		return nil, err
	}

	// attach to running process
	if err := p.attach(pid); err != nil {
		return nil, err
	}

	// 读取 /proc/pid/comm、/proc/pid/cmdline，便于后续支持重启调试
	if err := p.initialize(); err != nil {
		return nil, err
	}

	// attach 到该进程的其他线程（ch6.20.1）
	if err := p.updateThreadList(); err != nil {
		return nil, err
	}
	return p, nil
}
```

`p.attach(pid)` 先 attach 主线程并等待它因 SIGSTOP 停止，然后 `updateThreadList` 再枚举并 attach 其余线程。`DebuggedProcess.Threads` 这个 map 就是调试器维护的“已跟踪线程列表”，后续 continue、断点处理都要遍历它。

有 attach 就有 detach，多线程下的 detach 也有顺序要求：

**file：pkg/target/process.go**（片段）

```go
// Detach 分离被调试进程的全部线程，使其恢复运行。
//
// 注意：先分离非 leader 线程，最后分离线程组 leader——
// 避免 leader 先恢复执行导致组内其他线程失去控制。
func (p *DebuggedProcess) Detach() error {

	// check tracee pid
	if !checkPid(p.Process.Pid) {
		return fmt.Errorf("process %d not existed", p.Process.Pid)
	}

	tids := []int{}
	for tid := range p.Threads {
		if tid != p.Process.Pid {
			tids = append(tids, tid)
		}
	}
	// leader 最后分离
	tids = append(tids, p.Process.Pid)

	for _, tid := range tids {
		err := p.ExecPtrace(func() error {
			return syscall.PtraceDetach(tid)
		})
		if err != nil {
			return fmt.Errorf("thread %d detached error: %v", tid, err)
		}
	}
	return nil
}
```

如果先 detach 线程组 leader，leader 会立即恢复执行，并可能继续创建或操作其他线程，调试器就失去了对组内其他线程的控制。因此这里先 detach 普通线程，最后再 detach leader。

> ps：上述代码取自 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.20.1`。其中 `Thread`、`addThread`、`updateThreadList` 等是本节新增的多线程跟踪基础，`Detach` 的多线程处理也在本节完成；`ExecPtrace`、`waitFast` 的底层实现沿用前几节已有的 target 层设施。

### 代码测试

测试目标是 godbgv2 自带的 `_fixtures/loop2`。它启动后打印进程 pid，然后主协程每 3 秒、子协程每 1 秒各打印一次，Go 运行时会在启动过程中创建多个 OS 线程。

**file：examples/debuggee/loop2/main.go**

```go
// loop2 是一个多线程的调试目标程序：子协程每 1s、主协程每 3s 打印一次。
//
// 它是第6.20节多线程调试的调试对象：`make fixtures` 会将其构建到
// _fixtures/，attach 后可观察到多个 OS 线程（第6.20.1节的 smoke
// 脚本即以此方式使用它）。
package main

import (
	"fmt"
	"os"
	"time"
)

func main() {
	pid := os.Getpid()
	fmt.Printf("pid: %d\n", pid)

	go func() {
		for i := 0; ; i++ {
			fmt.Printf("pid: %d, goroutine: %d\n", pid, i)
			time.Sleep(time.Second)
		}
	}()

	for i := 0; ; i++ {
		fmt.Printf("pid: %d, main: %d\n", pid, i)
		time.Sleep(3 * time.Second)
	}
}
```

切换到本节代码并构建：

```bash
$ git checkout ch6.20.1
$ make build
$ make fixtures
```

先在一个终端启动测试程序，再在另一个终端观察它的线程：

```bash
$ ./_fixtures/loop2
pid: 2331079
pid: 2331079, main: 0
pid: 2331079, goroutine: 0
pid: 2331079, goroutine: 1
...
```

```bash
$ ls /proc/2331079/task
2331079  2331082  2331083  2331084  2331085
```

`/proc/<pid>/task` 下每个目录都是一个线程，其中 `2331079` 是主线程（线程组 leader），其余是 Go 运行时创建的线程。

现在 attach 这个进程：

```bash
$ ./godbg attach 2331079
process 2331079 attached, stopped by SIGSTOP
thread 2331079 attached
thread 2331082 attached
thread 2331083 attached
thread 2331084 attached
thread 2331085 attached
godbg> exit
tracee is an attached process, leave it running
```

`/proc/<pid>/task` 中的每个 tid 都出现在 attach 输出里，说明调试器已经枚举并跟踪了进程当时已有的全部线程。`pregs` 读取的是当前线程的寄存器，本节的实现暂时以主线程为当前线程。

> ps：线程数量、tid 和寄存器值每次运行都可能不同，上面是某次真实运行的结果。`attach` 输出会包含 attach 前 `/proc/<pid>/task` 中观察到的全部线程；两次观察之间如果进程创建或退出了线程，集合可能略有不同。

### 本节小结

本节主要探讨了调试多线程程序时如何跟踪已经创建的线程这一核心问题。通过分析Linux系统提供的 `/proc` 虚拟文件系统接口，我们掌握了枚举进程中所有线程的方法：遍历 `/proc/<pid>/task` 目录下的所有子目录名即可获取所有线程ID。在此基础上，godbgv2 在 target 层用 `Threads` 维护已跟踪线程列表：`loadThreadList` 枚举线程、`updateThreadList` 逐个 `addThread`、attach 主线程之外的其他线程；命令层 `attach` 则把线程列表打印出来。`Detach` 也相应改为遍历所有线程，并让线程组 leader 最后分离。

通过实际测试验证，attach 一个正在运行的多线程 Go 程序后，`/proc/<pid>/task` 中的所有线程都被纳入跟踪。本节内容为后续学习更复杂的多线程执行控制做好了准备。下一节我们将探讨如何自动跟踪进程内后续新创建的线程。

ps: Go程序的GMP调度机制使得线程与goroutine的映射关系更加复杂，这为面向Go程序的调试器开发带来了额外的挑战。这部分内容我们将在第九章符号级调试器开发部分进一步探讨。
