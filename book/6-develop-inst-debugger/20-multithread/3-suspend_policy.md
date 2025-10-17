## 线程执行控制 - 挂起策略

线程执行控制，指的是调试器会通过continue、step、breakpoint等命令来控制进程内线程的执行，前面我们介绍了这些命令的底层原理以及实现方式。但是这些对于多线程程序来说，还远远不够，我们还需要考虑多线程程序的特殊性，线程与线程之间的交互、调试人员对不同线程的观察等等，这就涉及到线程的挂起策略。

挂起策略（Suspend Policy），有时也叫 **Stop Mode** 或者 **Suspend Mode**。它描述的是当某个线程触发断点/异常/停止请求时，调试器应该暂停哪些线程，以及后续继续执行时，如何恢复这些线程的执行，属于线程执行控制（Thread Execution Control）的一部分。

本节我们来了解下在主流调试器中，有哪些挂起策略，以及是如何实现的。

## 多线程调试 - 挂起策略及主流实现

### 调试器的挂起策略

在多线程或多进程的程序调试中，当程序执行遇到断点(breakpoint)、观察点(watchpoint)、捕获到信号(signal)或被用户手动中断时(如ctrl+c)，调试器需要暂停（Suspend）程序的执行。**挂起策略（Suspend Policy）** 定义了当程序中的某个线程被暂停时，其他线程或进程应该如何处理的行为规则。是只暂停当前发生事件的线程，还是暂停整个进程中的所有线程。而当恢复执行(continue)、步进(step, next等)时，是只恢复当前选中的线程，还是进程内的所有线程。这是两个维度，一个是暂停的维度，一个是恢复的维度。

前面提的是单进程多线程调试的范畴，我们还可以延伸到多进程程序调试的范畴，比如调试器在调试进程P1时，发现进程P1创建了子进程P2，后续命中断点、观察点、捕获到信号、收到用户中断操作时，我们希望有能力按需地对单个进程或者所有进程暂停执行的能力，以及在后续收到continue、step、next等恢复执行的命令时也能按需地控制恢复单个进程内的线程或者所有进程内的线程的执行能力。

这个策略至关重要，因为它直接影响了调试过程中的程序状态可见性、可预测性和用户调试体验。

主流的挂起策略主要有两种：

1. **全系统挂起 (All-Stop / Process-Stop)**: 当一个线程/进程停止时，调试器会尝试暂停整个被调试程序中的所有线程/进程。
2. **单线程挂起 (One-Stop / Thread-Stop)**: 当一个线程停止时，只有该线程会被暂停，其他线程继续运行。
   或者叫做 **Non-Stop Mode**，意思是除了对当前选中线程、进程进行控制，其他线程、进程不做任何控制，任其自由执行。

### 主流调试器的挂起策略

#### GDB (GNU Debugger)

**GDB** 传统上采用的是**全系统挂起 (All-Stop)** 策略。

* **默认行为：** 当 GDB 调试的程序中任何一个线程命中断点或接收到信号时，整个进程（包括所有线程）都会被暂停。
* **优点：** 状态是“冻结”的，这使得检查全局变量、内存状态和线程间的交互更加容易和稳定，避免了其他线程在检查时修改数据，从而简化了调试的复杂性。
* **缺点：** 在调试高度并发或有严格时序要求的程序时，暂停所有线程可能会改变程序的实时行为，甚至导致死锁或其他与“暂停”相关的非真实错误。

虽然 GDB 默认是全系统挂起，但它也提供了控制单个或部分线程执行的能力（例如使用 `thread apply all <command>` ，如暂停后对特定线程使用 `continue` / `step` / `next`）。

OK，这里不妨展开介绍下GDB中与挂起策略相关的几个选项设置。

**设置1：set non-stop on/off (默认值off)**：本文主要的探讨的挂起策略，同一个进程内的所有线程，是否所有线程要停全停，要恢复全恢复。

- off：也就是all-stop mode，如果有断点、watchpoint、收到信号、用户中断等操作，暂停进程内所有线程。当执行continue,next,stop等操作时恢所有线程执行。
- on：此时就是non-stop mode，命中断点、watchpoint、收到信号、用户中断操作，仅暂停发生事件的线程。当执行continue,next,step操作时仅恢复当前选中线程。

**设置2：set schedule_multiple on/off (默认值off)**：如果是多进程程序，是否恢复所有进程内的线程的执行。

- off: 只暂停当前选中线程，其他线程继续执行。
- on: 暂停所有线程，当执行continue,next,step操作时恢复所有线程执行。

**设置3：set scheduler_locking on/off/step/replay (默认值off)**：决定在程序运行、单步或继续时，GDB 是否会把其他线程“锁定”（即暂停），只让当前选中的线程执行。这对定位线程间交互、排查竞争、实现确定性重放都非常重要。

- on: **始终锁定**：所有线程都被暂停，只有当前选中的线程在运行，相当于永远是单线程执行
- off: **默认行为**：不锁定，所有线程按正常调度器运行。
- step: **仅在单步（step/next 等）时锁定**：当前线程执行一步后，暂停其它线程。
- replay: **为确定性重放做准备**：GDB 记录线程调度，并在 replay 时严格复现。

**为什么需要 scheduler_locking？**
non-stop、schedule_multiple都很好理解，我们介绍下scheduler_locking。默认情况下，GDB 只会把你暂停的线程停下来，其他线程仍然按操作系统调度器的规则继续执行。

这会导致：

- 单步调试时可能会切到别的线程，导致你走了你不想走的代码路径。
- 设置断点时，任何线程都可能触发，导致“偶发性”中断。
- 有些竞态条件在你“锁定”调试时可能根本不会出现。

`scheduler-locking` 给我们一个可控的调试模式，让我们决定 **是否需要把调度器锁定**，从而让调试行为更可预测。GDB record/replay特性是不依赖Mozilla rr的，但是由于是指令级记录，性能上损耗比较大。GDB也可以通过gdb serial协议访问rr来进行录制重放。

#### LLDB

**LLDB** 旨在提供更现代和灵活的调试体验，其行为与 GDB 类似，也默认采用**全系统挂起 (All-Stop)** 策略。

* **默认行为：** 类似于 GDB，当程序因断点或其他事件停止时，**整个进程**会被暂停。
* **灵活性：** 尽管默认是全系统挂起，但 LLDB 提供了更细致的线程控制。例如，在进程停止后，理论上可以通过 LLDB 的 API（如 Python 脚本）来控制哪些线程继续运行，哪些保持暂停（如 `thread continue <LIST OF THREADS TO CONTINUE>`，尽管命令行中不常直接使用，但其核心功能在于对线程状态的精细管理）。这种能力在某些场景下可以模拟出“部分挂起”的效果。

简而言之，对于 GDB 和 LLDB 而言，为了维护调试时状态的一致性和简便性，**默认和主流的挂起策略都是全系统挂起**。

#### Delve

**Delve** 是专门为 Go 语言设计的调试器，它考虑了 Go 语言独特的并发模型（Goroutine）。

* **基于进程挂起：** Delve 在底层操作上，与传统的调试器一样，当进程被调试中断（如命中硬断点）时，**整个进程**会被操作系统挂起。这是操作系统的限制，也是所有调试器在进行底层操作时必须面对的。
* **Goroutine 抽象与全系统挂起：** 由于 Go 的并发基于 **Goroutine**（轻量级用户态线程），而非重量级操作系统线程，Delve 必须在 Go 运行时（Runtime）层面进行协调。当一个 Goroutine 命中断点时，Delve 会暂停整个 Go 程序（即进程），从而暂停所有 Goroutine 的执行。
* **关注 Goroutine：** Delve 的核心在于对 Goroutine 的抽象和管理。当程序停止时，你可以检查任何 Goroutine 的堆栈、变量状态，并且可以切换到不同的 Goroutine 上下文进行操作。
* **跟踪行为：** Delve 在附着（Attach）到一个正在运行的 Go 进程时，通常会**立即暂停**该进程，以便设置断点或进行初始化检查。但 Delve 社区曾讨论并实现了 `--continue` 或类似选项，允许在附着后立即恢复执行，以避免长时间暂停生产环境服务，使其更适合设置**跟踪点（Tracepoint）** 而非硬断点。

因此，**Delve 的挂起策略本质上是全进程挂起**，但它通过对 Go 运行时和 Goroutine 的深度感知，提供了面向 Goroutine 的调试体验。但是Delve并没有像GDB scheduler_locking那样对线程调度进行干预那样对goroutine调度进行干预，它就是所有线程、协程全停全起的一个跟踪方式，然后当命中断点、信号、用户中断等之类事件时，它会显示到底是哪个goroutine命中了哪个断点导致的这次暂停。

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
**(dlv) b 8**
Breakpoint 2 set at 0x100df9ac8 for main.main.func1() ./main.go:8
**(dlv) b 9**
Breakpoint 3 set at 0x100df9ae0 for main.main.func1() ./main.go:9
**(dlv) b 11**
Breakpoint 4 set at 0x100df9a8c for main.main() ./main.go:11

**(dlv) c**
> [Breakpoint 4] main.main() ./main.go:11 **(hits goroutine(1)**:1 total:1) (PC: 0x100df9a8c)
     6:		for {
     7:			go func() {
     8:				println("hello")
     9:				println("world")
    10:			}()
=>  11:			time.Sleep(time.Second)
    12:		}
    13:	}
**(dlv) c**
> [Breakpoint 2] main.main.func1() ./main.go:8 **(hits goroutine(2)**:1 total:1) (PC: 0x100df9ac8)
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
**(dlv) c**
hello
> [Breakpoint 3] main.main.func1() ./main.go:9 **(hits goroutine(2)**:1 total:1) (PC: 0x100df9ae0)
> [Breakpoint 4] main.main() ./main.go:11 **(hits goroutine(1)**:2 total:2) (PC: 0x100df9a8c)
     6:		for {
     7:			go func() {
     8:				println("hello")
     9:				println("world")
    10:			}()
=>  11:			time.Sleep(time.Second)
    12:		}
    13:	}
**(dlv) c**
world
> [Breakpoint 2] main.main.func1() ./main.go:8 **(hits goroutine(33):1 total:2) (PC: 0x100df9ac8)
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

从上面调试示例可以看出，continue后命中断点的goroutine会显示器goroutine编号，以及命中的断点位置，当前PC值。指的关注的是，有时候continue后有1个goroutine命中了断点导致所有goroutine全停下来，有时候则有不止1个goroutine命中断点。但实际上Delve在处理1个线程的断点命中事件时，当收到任意1个线程的断点命中事件后，会立即暂停所有线程的执行（通过SIGSTOP通知运行中线程停下来）。

### 本节小结

本节主要探讨了调试器在多线程程序中的挂起策略（Suspend Policy），核心内容包括：**全系统挂起**和**单线程挂起**两种主流策略。我们还介绍了主流调试器GDB、LLDB、Delve中的做法。GDB通过默认全系统挂起，但提供了`non-stop`、`schedule_multiple`、`scheduler_locking`等选项提供细粒度控制；LLDB默认采用全系统挂起但支持更细粒度的线程管理；Delve也是默认全系统挂起，但通过其对Go语言GMP调度模型的深度理解和支持，适配了面向goroutine级别并发的调试，我们可以自由在不同goroutine上下文之间进行切换、查看状态、恢复goroutine执行，方便Go开发者进行调试。

重点需要理解的是，主流调试器都默认采用全系统挂起策略，这确保了调试时程序状态的稳定性和可预测性。尽管这种做法并不完美，大部分时候都是我们希望的，但在某些场景下我们需要更细粒度的控制，比如GDB、LLDB那样。调试器的发展演进也需要时间，我们期待后续的调试器能够提供更细粒度的控制，更方便我们进行调试。

本节内容为后续学习多线程调试的复杂性以及后续学习线程状态管理、断点处理等高级调试技术奠定了重要基础。
