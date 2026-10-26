## 线程执行控制 - 挂起策略

### 实现目标：理解并实现 all-stop 挂起策略

线程执行控制，指的是调试器会通过continue、step、breakpoint等命令来控制进程内线程的执行，前面我们介绍了这些命令的底层原理以及实现方式。但是这些对于多线程程序来说，还远远不够，我们还需要考虑多线程程序的特殊性，线程与线程之间的交互、调试人员对不同线程的观察等等，这就涉及到线程的挂起策略。

挂起策略（Suspend Policy），有时也叫 **Stop Mode** 或者 **Suspend Mode**。它描述的是当某个线程触发断点/异常/停止请求时，调试器应该暂停哪些线程，以及后续继续执行时，如何恢复这些线程的执行，属于线程执行控制（Thread Execution Control）的一部分。

本节我们来了解下在主流调试器中，有哪些挂起策略，以及是如何实现的。最后我们会以 godbgv2 的 ch6.20.3 为例，看看 all-stop 策略在代码中如何落地。

### 基础知识

#### 调试器的挂起策略

在多线程程序调试中，当程序执行遇到断点(breakpoint)、观察点(watchpoint)、捕获到信号(signal)或被用户手动中断时(如ctrl+c)，调试器需要暂停（Suspend）程序的执行。**挂起策略（Suspend Policy）** 定义了当程序中的某个线程被暂停时，其他线程应该如何处理的行为规则。是只暂停当前发生事件的线程，还是暂停整个进程中的所有线程。而当恢复执行(continue)、步进(step, next等)时，是只恢复当前选中的线程，还是进程内的所有线程。这是两个维度，一个是暂停的维度，一个是恢复的维度。

这个策略至关重要，因为它直接影响了调试过程中的程序状态可见性、可预测性和用户调试体验。

主流的挂起策略主要有两种：

1. **全系统挂起 (All-Stop)**: 当一个线程停止时，调试器会尝试暂停整个被调试程序中的所有线程。
2. **单线程挂起 (Non-Stop / One-Stop)**: 当一个线程停止时，只有该线程会被暂停，其他线程继续运行。

#### 主流调试器的挂起策略

##### GDB (GNU Debugger)

**GDB** 传统上采用的是**全系统挂起 (All-Stop)** 策略。

* **默认行为：** 当 GDB 调试的程序中任何一个线程命中断点或接收到信号时，整个进程（包括所有线程）都会被暂停。
* **优点：** 状态是“冻结”的，这使得检查全局变量、内存状态和线程间的交互更加容易和稳定，避免了其他线程在检查时修改数据，从而简化了调试的复杂性。
* **缺点：** 在调试高度并发或有严格时序要求的程序时，暂停所有线程可能会改变程序的实时行为，甚至导致死锁或其他与“暂停”相关的非真实错误。

虽然 GDB 默认是全系统挂起，但它也提供了控制单个或部分线程执行的能力（例如使用 `thread apply all <command>` ，如暂停后对特定线程使用 `continue` / `step` / `next`）。

OK，这里不妨展开介绍下GDB中与挂起策略相关的几个选项设置。

**设置1：set non-stop on/off (默认值off)**：本文主要探讨的挂起策略，同一个进程内的所有线程，是否所有线程要停全停，要恢复全恢复。

- off：也就是all-stop mode，如果有断点、watchpoint、收到信号、用户中断等操作，暂停进程内所有线程。当执行continue,next,step等操作时恢复所有线程执行。
- on：此时就是non-stop mode，命中断点、watchpoint、收到信号、用户中断操作，仅暂停发生事件的线程。当执行continue,next,step操作时仅恢复当前选中线程。

**设置2：set schedule-multiple on/off (默认值off)**：如果考虑多进程的情况，还有一个设置项，用来控制是否恢复所有进程内的线程执行。

- off: 当执行continue,next,step操作时只恢复当前进程内的线程执行；
- on: 当执行continue,next,step操作时恢复所有进程内的线程执行；

多进程调试中如何跟踪子进程、如何在多个进程之间暂停和恢复，6.21 节还会展开介绍。这里可以被恢复的线程集合，进一步可以由`scheduler-locking`选项来控制。

**设置3：set scheduler-locking on/off/step/replay (默认值off)**：决定在程序运行、单步或继续时，GDB 是否会把其他线程“锁定”（即暂停），只让当前选中的线程执行。这对定位线程间交互、排查竞争、实现确定性重放都非常重要。

- on: **始终锁定**：所有线程都被暂停，只有当前选中的线程在运行，相当于永远是单线程执行
- off: **默认行为**：不锁定，所有线程按正常调度器运行。
- step: **仅在单步（step/next 等）时锁定**：当前线程执行一步后，暂停其它线程。
- replay: **为确定性重放做准备**：GDB 记录线程调度，并在 replay 时严格复现。

**为什么需要 scheduler-locking？**
non-stop、schedule-multiple都很好理解，我们介绍下scheduler-locking。默认情况下，GDB 只会把你暂停的线程停下来，其他线程仍然按操作系统调度器的规则继续执行。

这会导致：

- 单步调试时可能会切到别的线程，导致你走了你不想走的代码路径。
- 设置断点时，任何线程都可能触发，导致“偶发性”调试流程中断。
- 有些竞态条件在你“锁定”调试时可能根本不会出现。

`scheduler-locking` 给我们一个可控的调试模式，让我们决定 **是否需要把调度器锁定**，从而让调试行为更可预测。GDB record/replay特性是不依赖Mozilla rr的，但是由于是指令级记录，性能开销比rr大。GDB也可以通过gdb serial协议访问rr来进行录制重放。

##### LLDB

**LLDB** 旨在提供更现代和灵活的调试体验，其行为与 GDB 类似，也默认采用**全系统挂起 (All-Stop)** 策略。

* **默认行为：** 类似于 GDB，当程序因断点或其他事件停止时，**整个进程**会被暂停。
* **灵活性：** 尽管默认是全系统挂起，但 LLDB 提供了更细致的线程控制。例如，在进程停止后，理论上可以通过 LLDB 的 API（如 Python 脚本）来控制哪些线程继续运行，哪些保持暂停（如 `thread continue <LIST OF THREADS TO CONTINUE>`，尽管命令行中不常直接使用，但其核心功能在于对线程状态的精细管理）。这种能力在某些场景下可以模拟出“部分挂起”的效果。

简而言之，对于 GDB 和 LLDB 而言，为了维护调试时状态的一致性和简便性，**默认和主流的挂起策略都是全系统挂起**。

##### Delve

**Delve** 是专门为 Go 语言设计的调试器，它考虑了 Go 语言独特的并发模型（Goroutine）。

* **基于进程挂起：** Delve 在底层操作上，与传统的调试器一样，当进程被调试中断（如命中硬断点）时，**整个进程**会被操作系统挂起。这是操作系统的限制，也是所有调试器在进行底层操作时必须面对的。
* **Goroutine 抽象与全系统挂起：** 由于 Go 的并发基于 **Goroutine**（轻量级用户态线程），而非重量级操作系统线程，Delve 必须在 Go 运行时（Runtime）层面进行协调。当一个 Goroutine 命中断点时，Delve 会暂停整个 Go 程序（即进程），从而暂停所有 Goroutine 的执行。
* **关注 Goroutine：** Delve 的核心在于对 Goroutine 的抽象和管理。当程序停止时，你可以检查任何 Goroutine 的堆栈、变量状态，并且可以切换到不同的 Goroutine 上下文进行操作。
* **跟踪行为：** Delve 在附着（Attach）到一个正在运行的 Go 进程时，通常会**立即暂停**该进程，以便设置断点或进行初始化检查。但 Delve 社区曾讨论并实现了 `--continue` 或类似选项，允许在附着后立即恢复执行，以避免长时间暂停生产环境服务，使其更适合设置**跟踪点（Tracepoint）** 而非硬断点。

因此，**Delve 的挂起策略本质上是全进程挂起**，但它通过对 Go 运行时和 Goroutine 的深度感知，提供了面向 Goroutine 的调试体验。但是Delve并没有像GDB scheduler-locking那样对线程调度进行干预那样对goroutine调度进行干预，它就是所有线程、协程全停全起的一个跟踪方式，然后当命中断点、信号、用户中断等之类事件时，它会显示到底是哪个goroutine命中了哪个断点导致的这次暂停。

```bash
$ dlv debug main.go
     ...
     3:	import "time"
     4:
=>   5:	func main() {
     6:		for {
     7:			go func() {
     8:				println("hello")
     9:				println("world")
    10:			}()
    11:			time.Sleep(time.Second)
    12:		}
    13:	}
(dlv) b 8
Breakpoint 2 set at 0x100df9ac8 for main.main.func1() ./main.go:8
(dlv) b 9
Breakpoint 3 set at 0x100df9ae0 for main.main.func1() ./main.go:9
(dlv) b 11
Breakpoint 4 set at 0x100df9a8c for main.main() ./main.go:11

(dlv) c
> [Breakpoint 4] main.main() ./main.go:11 (hits goroutine(1):1 total:1) (PC: 0x100df9a8c)
     6:		for {
     7:			go func() {
     8:				println("hello")
     9:				println("world")
    10:			}()
=>  11:			time.Sleep(time.Second)
    12:		}
    13:	}
(dlv) c
> [Breakpoint 2] main.main.func1() ./main.go:8 (hits goroutine(2):1 total:1) (PC: 0x100df9ac8)
     3:	import "time"
     4:
     5:	func main() {
     6:		for {
     7:			go func() {
=>   8:				println("hello")
     9:				println("world")
    10:			}()
    11:			time.Sleep(time.Second)
    12:		}
    13:	}
(dlv) c
hello
> [Breakpoint 3] main.main.func1() ./main.go:9 (hits goroutine(2):1 total:1) (PC: 0x100df9ae0)
> [Breakpoint 4] main.main() ./main.go:11 (hits goroutine(1):2 total:2) (PC: 0x100df9a8c)
     6:		for {
     7:			go func() {
     8:				println("hello")
     9:				println("world")
    10:			}()
=>  11:			time.Sleep(time.Second)
    12:		}
    13:	}
(dlv) c
world
> [Breakpoint 2] main.main.func1() ./main.go:8 (hits goroutine(33):1 total:2) (PC: 0x100df9ac8)
     3:	import "time"
     4:
     5:	func main() {
     6:		for {
     7:			go func() {
=>   8:				println("hello")
     9:				println("world")
    10:			}()
    11:			time.Sleep(time.Second)
    12:		}
    13:	}
```

从上面调试示例可以看出，continue后命中断点的goroutine会显示goroutine编号，以及命中的断点位置，当前PC值。值得注意的是，有时候continue后有1个goroutine命中了断点导致所有goroutine全停下来，有时候则有不止1个goroutine命中断点。但实际上Delve在处理1个线程的断点命中事件时，当收到任意1个线程的断点命中事件后，会立即暂停所有线程的执行（通过SIGSTOP通知运行中线程停下来）。

### 代码实现

godbgv2 在 ch6.20.3 中实现 all-stop 挂起策略。核心改动有两处：`Continue` 从“只恢复主线程”改为“恢复全部线程、等待任意线程停止、再挂起其余线程”；新增 `suspendOtherThreads` 负责向其余线程投递 SIGSTOP。

**file：pkg/target/suspend.go**

```go
package target

import (
	"fmt"
	"syscall"
)

// suspendOtherThreads 挂起除 wpid 外的全部线程（all-stop 挂起策略）。
//
// 实现方式：向目标线程投递 SIGSTOP 使其进入停止状态（SIGSTOP 对线程组
// 全体生效），再等待其停止事件。
//
// 注意：这里不使用 PTRACE_SINGLESTEP——对阻塞在系统调用（如 futex）
// 中的线程，单步陷阱可能迟迟无法触发，导致挂起流程阻塞。
func (p *DebuggedProcess) suspendOtherThreads(wpid int) error {
	for tid := range p.Threads {
		if tid == wpid {
			continue
		}
		if err := syscall.Tgkill(p.Process.Pid, tid, syscall.SIGSTOP); err != nil && err != syscall.ESRCH {
			return fmt.Errorf("tgkill thread %d err: %v", tid, err)
		}
		// 等待该线程进入停止状态；若已退出则从线程列表移除
		if _, status, err := p.waitFast(tid); err == nil && status.Exited() {
			delete(p.Threads, tid)
		}
	}
	return nil
}
```

`syscall.Tgkill(p.Process.Pid, tid, syscall.SIGSTOP)` 向指定线程投递 SIGSTOP。这里选择 SIGSTOP 而不是 `PTRACE_SINGLESTEP`：如果线程正阻塞在 futex 等系统调用中，单步陷阱可能迟迟无法触发，挂起流程就会卡住；SIGSTOP 则会让线程在系统调用返回或下一条用户指令执行前停下来。

`Continue` 的整体流程如下：

**file：pkg/target/continue.go**（片段）

```go
// Continue 恢复全部线程执行，等待任意线程停止，然后挂起其余线程
// （all-stop 挂起策略），返回停止原因。
//
// 线程克隆事件（PTRACE_EVENT_CLONE）是内部事件：读取并跟踪新线程后
// 让克隆者继续执行，继续等待真正的停止事件。
func (p *DebuggedProcess) Continue() (*api.StopInfo, error) {
	// 恢复全部线程执行
	for _, thread := range p.Threads {
		err := p.ExecPtrace(func() error {
			err := syscall.PtraceCont(thread.Tid, 0)
			if err == syscall.ESRCH {
				return nil
			}
			return err
		})
		if err != nil {
			return nil, fmt.Errorf("ptrace cont thread %d err: %v", thread.Tid, err)
		}
	}

	// 等待任意线程停止
	for {
		wpid, status, err := p.waitAny(syscall.WSTOPPED)
		if err != nil {
			return nil, fmt.Errorf("wait error: %v", err)
		}
		if status == nil {
			// 目标进程已退出（zombie）
			return &api.StopInfo{PID: wpid, Reason: "exited"}, nil
		}

		if status.Stopped() && status.TrapCause() == syscall.PTRACE_EVENT_CLONE {
			// 内部事件：新线程已被内核自动跟踪（PTRACE_O_TRACECLONE），
			// 读取其 tid、加入线程列表，并消费其初始 SIGSTOP
			newTid, err := p.getEventMessage(wpid)
			if err != nil {
				return nil, fmt.Errorf("get event msg error: %v", err)
			}
			if _, err := p.addThread(newTid, false); err != nil {
				return nil, fmt.Errorf("add thread error: %v", err)
			}
			if _, status, err := p.waitFast(newTid); err == nil && status.Exited() {
				delete(p.Threads, newTid)
			}
			// 让克隆者继续执行，等待真正的停止事件
			if err := p.ExecPtrace(func() error {
				err := syscall.PtraceCont(wpid, 0)
				if err == syscall.ESRCH {
					return nil
				}
				return err
			}); err != nil {
				return nil, fmt.Errorf("ptrace cont thread %d err: %v", wpid, err)
			}
			continue
		}

		// 真正的停止事件：挂起其余线程（all-stop）
		if err := p.suspendOtherThreads(wpid); err != nil {
			return nil, err
		}

		// 记录当前线程及其停止原因
		p.currentThread = p.Threads[wpid]
		if p.currentThread != nil {
			p.currentThread.stopReason = descStatus(status)
		}

		return &api.StopInfo{PID: wpid, Reason: descStatus(status)}, nil
	}
}
```

这段代码有几个关键点：

1. **恢复全部线程**：`Continue` 不再只对主线程 `PTRACE_CONT`，而是遍历 `Threads` 对每个线程都恢复执行。否则其他线程一直处于停止状态，线程间的同步逻辑（加解锁、信号量等）可能根本无法推进。
2. **克隆事件内部化**：`PTRACE_EVENT_CLONE` 不再作为停止原因返回给用户，而是读取新线程 tid、加入线程列表、消费它的初始 SIGSTOP，然后让克隆者继续执行，继续 `waitAny` 等待真正的停止事件。
3. **真正的停止事件**：任意线程因断点、信号或用户中断停下来后，调用 `suspendOtherThreads(wpid)` 向其他线程投递 SIGSTOP，并等待它们停止。这就是 all-stop。
4. **记录当前线程**：`currentThread` 指向本次停下来的线程，`stopReason` 记录停止原因，为 ch6.20.4 起 `pregs`、`step` 等按线程工作的命令做准备。

注意第 2 点中的顺序：ch6.20.3 是先 `waitFast(newTid)` 消费新线程的初始 SIGSTOP，再恢复克隆者。新线程的初始 SIGSTOP 只有在克隆者恢复执行后才进入可等待状态，所以这个顺序会在 ch6.20.4 被调整为“先恢复克隆者、再消费新线程的初始 SIGSTOP”。

为了保存当前线程和停止原因，`DebuggedProcess` 和 `Thread` 分别增加了字段：

**file：pkg/target/process.go**（片段）

```go
	Threads         map[int]*Thread         // 已跟踪的线程列表，k=tid
	currentThread   *Thread                 // 最近一次停止的线程（ch6.20.3）
```

**file：pkg/target/thread.go**（片段）

```go
type Thread struct {
	Tid     int              // thread ID
	Process *DebuggedProcess // process this thread belongs to

	stopReason string // 该线程最近一次停止的原因（ch6.20.3）
}
```

命令层只需要在 `continue` 成功后补一句提示：

**file：cmd/debug/continue.go**（片段）

```go
		fmt.Printf("thread %d status: %s\n", stop.PID, stop.Reason)
		// all-stop 挂起策略：其余线程已被挂起
		fmt.Println("stop all threads now")
		return nil
```

> ps：上述代码取自 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.20.3`。本节新增 `suspendOtherThreads`、`currentThread`/`stopReason` 以及 `Continue` 的 all-stop 流程；`waitAny`、`addThread`、`getEventMessage` 是 ch6.20.1、ch6.20.2 已有的配套实现。

### 代码测试

测试目标是 `_fixtures/loop2`。切换到本节代码并构建：

```bash
$ git checkout ch6.20.3
$ make build
$ make fixtures
```

先在一个终端启动测试程序：

```bash
$ ./_fixtures/loop2
pid: 2326705
pid: 2326705, main: 0
pid: 2326705, goroutine: 0
...
```

在另一个终端 attach 它：

```bash
$ ./godbg attach 2326705
process 2326705 attached, stopped by SIGSTOP
thread 2326705 attached
thread 2326707 attached
thread 2326708 attached
thread 2326709 attached
thread 2326710 attached
godbg> continue
```

此时 `continue` 会恢复全部线程，调试器停在 `waitAny` 等待任意线程停止。再开一个终端向进程投递 SIGINT：

```bash
$ kill -INT 2326705
```

回到调试器，可以看到：

```bash
thread 2326705 status: stopped: interrupt
stop all threads now
godbg> exit
tracee is an attached process, leave it running
```

某个线程因 SIGINT 停下来后，`Continue` 通过 `suspendOtherThreads` 向其余线程投递 SIGSTOP，并逐个等待它们停止；命令层随后打印 `stop all threads now`。这就是 all-stop：一个线程停下来，整个进程的线程都停下来，调试人员看到的是一个冻结的、一致的程序状态。

> ps：tid、线程数量和寄存器值每次运行都可能不同；上面的输出是某次真实运行的结果。attach 后 `continue`、再在另一个终端发送 SIGINT 的操作顺序很重要——如果在 attach 完成前就发送 SIGINT，停止事件可能在 attach 阶段的 `wait` 中被消费掉。

### 本节小结

本节主要探讨了调试器在多线程程序中的挂起策略（Suspend Policy），核心内容包括：**全系统挂起**和**单线程挂起**两种主流策略。我们还介绍了主流调试器GDB、LLDB、Delve中的做法。GDB通过默认全系统挂起，但提供了`non-stop`、`scheduler-locking`、`schedule-multiple`等选项提供细粒度控制；LLDB默认采用全系统挂起但支持更细粒度的线程管理；Delve也是默认全系统挂起，但通过其对Go语言GMP调度模型的深度理解和支持，适配了面向goroutine级别并发的调试，我们可以自由在不同goroutine上下文之间进行切换、查看状态、恢复goroutine执行，方便Go开发者进行调试。

在 godbgv2 的 ch6.20.3 中，all-stop 策略落在了 `Continue` 和 `suspendOtherThreads` 上：`Continue` 恢复全部被跟踪线程，等待任意线程停止；克隆事件作为内部事件被消费；真正的停止事件到来后，向其余线程投递 SIGSTOP 并等待它们停下来，同时用 `currentThread`、`stopReason` 记录本次停止的线程和原因。

重点需要理解的是，主流调试器都默认采用全系统挂起策略，这确保了调试时程序状态的稳定性和可预测性。尽管这种做法并不完美，大部分时候都是我们希望的，但在某些场景下我们需要更细粒度的控制，比如GDB、LLDB那样。调试器的发展演进也需要时间，我们期待后续的调试器能够提供更细粒度的控制，更方便我们进行调试。

本节内容为后续学习多线程 continue、断点处理等高级调试技术奠定了重要基础。
