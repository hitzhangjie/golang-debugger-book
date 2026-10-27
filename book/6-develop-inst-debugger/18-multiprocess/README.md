## 调试多进程程序

前面 6.17 节讨论的都是单个进程内的多线程：枚举已有线程、跟踪新线程、all-stop 挂起与恢复。但真实世界里的程序并不总是老老实实待在一个进程里：

- shell 管道 `cmd1 | cmd2 | cmd3` 会创建三个进程，它们通过 stdin/stdout 的重定向串在一起；
- protoc 编译器会去 `$PATH` 里搜索 `protoc-gen-go` 并把它启动起来，通过 stdin/stdout 传递代码生成请求；
- 服务端程序经常 fork 出 worker 进程，或者 exec 自己换一份镜像；
- 容器里的 init 进程还要负责收割一堆子进程。

把这些场景放到调试器面前，问题可以归结为两个：

- **跟不跟**：子进程出现时，调试器要不要把它纳入跟踪？跟父进程还是子进程？只跟命令行匹配的那个，还是全都跟？
- **怎么停**：一个进程命中断点、收到信号或用户中断时，要不要把其他进程也一起停下来？continue/step 时又恢复哪些进程？

本节不再实现代码。跟踪多进程和跟踪多线程在内核层面本来就用同一套机制，godbgv2 在 6.17 节已经把 `PTRACE_O_TRACECLONE` 这条链路讲透了。我们换个角度，看看 gdb、lldb、dlv 这些成熟调试器分别是怎么处理多进程的，了解它们的取舍即可。

### 内核对多进程跟踪的支持

Linux 下创建进程主要有三条路：

| 系统调用 | 行为 | 典型场景 |
| --- | --- | --- |
| `fork` | 复制父进程地址空间，父子各自执行 | 传统 Unix 服务端 |
| `vfork` | 子进程共享父进程地址空间，父进程阻塞到子进程 exec/exit | fork+exec 的优化路径 |
| `clone` | 通用入口，按 flags 决定共享哪些资源 | 线程、容器、Go 的 `os/exec` |

三者的边界没有想象中那么清晰。`pthread_create` 底层是 `clone(CLONE_VM|CLONE_THREAD|...)`，创建出来的是线程；glibc 的 `fork` 底层也是 `clone(SIGCHLD)`；Go 的 `os/exec` 则使用 `clone(CLONE_VFORK|CLONE_VM)` 实现 vfork 语义，避免复制整个地址空间，再在子进程里 `execve`。所以内核眼里大家都是 `task_struct`，区别只在共享了哪些资源。

ptrace 为这些"生新任务"的时刻准备了一组选项：

| ptrace 选项 | 上报的事件 | 触发时机 |
| --- | --- | --- |
| `PTRACE_O_TRACEFORK` | `PTRACE_EVENT_FORK` | `fork(2)` 创建子进程 |
| `PTRACE_O_TRACEVFORK` | `PTRACE_EVENT_VFORK` | `vfork(2)` / `clone(CLONE_VFORK)` |
| `PTRACE_O_TRACECLONE` | `PTRACE_EVENT_CLONE` | `clone(2)` 创建线程（或进程） |
| `PTRACE_O_TRACEEXEC` | `PTRACE_EVENT_EXEC` | `execve(2)` 替换进程镜像 |

设置选项之后，新任务会被内核自动纳入同一个 tracer 的跟踪，并在创建（或 exec）处停下来；tracer 通过 `waitpid` 收到带 `SIGTRAP` 的状态，用 `PTRACE_GETEVENTMSG` 取出新任务的 tid/pid。接下来的选择无非两个：继续跟踪它，或者 `PTRACE_DETACH` 放它自己跑。

`TRACECLONE`、`TRACEFORK`、`TRACEVFORK` 的分工，由 clone 的 flags 和退出信号决定：带 `CLONE_VFORK` 的调用在设置了 `TRACEVFORK` 时上报 `PTRACE_EVENT_VFORK`；退出信号为 `SIGCHLD` 的调用在设置了 `TRACEFORK` 时上报 `PTRACE_EVENT_FORK`；其余情况才归 `TRACECLONE`。同一个 clone 系统调用既能创建线程也能创建进程，内核正是靠这些标志来区分"这是不是一个新的执行实体"。

### GDB：inferior + follow-fork-mode + schedule-multiple

GDB 的方案最完整，核心概念是 **inferior（下级）**：一个被调试的执行实体，拥有自己的地址空间、线程列表和 pid。一个 GDB 会话可以同时管理多个 inferior。

与多进程调试直接相关的选项有这几个：

- `set follow-fork-mode parent|child`（默认 `parent`）：fork/vfork 之后跟谁。
- `set detach-on-fork on|off`（默认 `on`）：不跟的那一方怎么办。`on` 表示直接放行；`off` 表示两个都留着，被放弃的进程停在原地成为一个独立 inferior，之后可以 `info inferiors` 查看、`inferior N` 切过去继续调试。
- `set follow-exec-mode same|new`（默认 `same`）：exec 之后是在原 inferior 里换镜像（`same`），还是新建一个 inferior（`new`）。`new` 的好处是原来的程序镜像还保留着，可以 `run` 重新启动；`same` 则更贴近"进程只是换了身衣服"的直觉。
- `set schedule-multiple on|off`（默认 `off`）：6.17 节挂起策略里提到的设置项。执行 continue/next/step 时，是只恢复当前进程的线程，还是恢复所有进程的线程。`off` 时要调试另一个进程，得先 `inferior N` 切过去。

这套组合基本覆盖了多进程调试的常见诉求。比如用 GDB 调 protoc 的插件：`set follow-fork-mode child` 之后，父进程 protoc 被放行，子进程被跟踪着 exec 成 protoc-gen-go，就可以在插件代码里下断点。如果希望父子都留着，再加 `set detach-on-fork off`；如果只想在 fork 处停下看一眼、不改变跟随策略，还可以用 `catch fork`、`catch exec` 这类 catchpoint。如果你对 protoc 的插件机制本身感兴趣，可以阅读 [Protoc及其插件工作原理](https://www.hitzhangjie.pro/blog/2017-05-23-protoc%E5%8F%8A%E6%8F%92%E4%BB%B6%E5%B7%A5%E4%BD%9C%E5%8E%9F%E7%90%86%E5%88%86%E6%9E%90%E7%B2%BE%E5%8D%8E%E7%89%88/)。

### LLDB：follow-fork-mode + 多 target

LLDB 的模型比 GDB 简单：

- `settings set target.process.follow-fork-mode parent|child`（默认 `parent`）：fork/vfork 之后跟哪一方。
- `settings set target.process.stop-on-exec true|false`（默认 `true`）：exec 之后是否停下来。

LLDB 没有 `detach-on-fork` 这样的开关，`follow-fork-mode` 只决定跟随哪一方，被放弃的一方不会作为可切换的进程留在当前调试会话里。它也没有 inferior 抽象，一个 target 对应一个进程；多进程调试靠创建多个 target 来管理（`target create`、`target list`、`target select`），每个 target 各自持有一个进程。

因此 LLDB 更适合"我明确知道要跟哪一支"的场景。要在父子进程之间来回切换、同时观察，GDB 的 inferior 体验会更顺一些。

### Delve：follow-exec + TargetGroup

Delve 的思路又不一样，因为它服务的是 Go 程序。

Go 运行时是多线程的，直接 fork 只会复制调用 fork 的那个线程；子进程里其他线程、运行时状态、锁都可能不一致，所以 Go 代码里几乎不会直接 fork。创建进程基本都走 `os/exec`，底层是 `clone(CLONE_VFORK|CLONE_VM)` + `execve`。Delve 针对这个现实做了取舍：

- 只实现 follow-exec，不实现 follow-fork：`target follow-exec [-on [regex]] [-off]`，默认关闭。开启后，被调试进程 exec 出来的子进程会被自动跟踪；可选的 regex 用来按命令行筛选，只跟感兴趣的子进程。
- 实现上，Delve 在 `PTRACE_O_TRACECLONE` 之外增加了 `PTRACE_O_TRACEVFORK` 和 `PTRACE_O_TRACEEXEC`，但没有 `PTRACE_O_TRACEFORK`——因为 Go 的 `os/exec` 走的是 vfork 语义。收到 `PTRACE_EVENT_VFORK` 时，它先把子进程当成一个普通线程收进线程列表；等 `PTRACE_EVENT_EXEC` 到来，再把它拆出去，创建新的 `Target`。
- 多个进程由 `TargetGroup` 管理：`target list` 列出当前跟踪的进程，`target switch <pid>` 切换当前进程。逻辑断点是 group 级别共享的，新建 target 时会自动把断点下好；continue、step 这类执行命令作用于当前选中的 target。
- 如果 follow-exec 关着，或者子进程的命令行不匹配 regex，Delve 会直接 detach，让它自己跑。

这套能力对 Go 开发者其实够用：绝大多数"多进程"场景都是 exec 型的（protoc 插件、git hook、调用外部命令），真正 fork 之后不 exec 的 Go 程序非常少见。

### 三种策略的对比

| | 默认跟随 | 能否同时保留多个进程 | 多进程执行控制 | 设计取向 |
| --- | --- | --- | --- | --- |
| GDB | 父进程 | 可以，`detach-on-fork off` + inferior | `schedule-multiple`、non-stop | 功能最全，概念也最多 |
| LLDB | 父进程 | 多个 target，但 fork 时只保留跟随的一方 | 切换 target | 简单直接 |
| Delve | 不跟（follow-exec 默认关） | 可以，`TargetGroup` + `target list/switch` | 切换当前 target | 只为 Go 的 exec 场景服务 |

从这张表也能看出三种典型的设计取向：GDB 把"调试多个执行实体"当成一等公民，抽象出 inferior，选项多、控制细；LLDB 把进程挂在 target 下，够用就好；Delve 则根据 Go 程序的实际情况砍掉了 fork 跟踪，只保留真正会遇到的 exec 场景。

对于我们在 godbgv2 里实现的调试器来说，6.17 节已经有 `Threads` 列表和 all-stop continue，要扩展到多进程，技术上大体上是把"线程列表"换成"进程列表 + 每个进程的线程列表"，再决定要不要增加 `PTRACE_O_TRACEFORK`/`TRACEVFORK`/`TRACEEXEC`。真正花时间的是调试体验上的取舍：跟谁、停谁、怎么在多个进程之间切换视图。这也是本节只介绍策略、不继续堆代码的原因。

### 本节小结

本节从 Linux 的 fork/vfork/clone 出发，说明了跟踪多进程和跟踪多线程在内核层面共用同一套 ptrace 事件机制，然后分别介绍了三种主流调试器的策略：

- GDB 以 inferior 为单位管理多个进程，通过 `follow-fork-mode`、`detach-on-fork`、`follow-exec-mode` 决定跟谁、留谁，通过 `schedule-multiple` 控制恢复范围；
- LLDB 以 target 为单位管理进程，只有 `follow-fork-mode` 和 `stop-on-exec` 两个关键选项，跟随策略上二选一；
- Delve 面向 Go 程序的实际情况，只支持 follow-exec，用 `PTRACE_O_TRACEVFORK` + `PTRACE_O_TRACEEXEC` 跟踪 `os/exec` 出来的子进程，用 `TargetGroup` 管理多个 target。

多进程调试没有唯一正确的答案，关键在于调试器面向的语言、平台和用户习惯。了解这些取舍，比照着某一家实现抄一遍更有价值。
