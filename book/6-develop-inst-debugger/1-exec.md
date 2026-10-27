## 启动调试：启动并跟踪进程

第 5 章我们已经把调试器骨架搭起来了，对应 godbgv2 的 tag `ch5.4`。`godbg exec <prog>` 这条命令也挂上了，不过 `Run` 里面还是一句 TODO，打印完就进入调试会话，目标程序并没有真正跑起来。

本节我们就来把这个 TODO 填上。配套代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.1`，`git checkout ch6.1` 就是这一节完成时的代码，`git diff ch5.4 ch6.1` 能看到相对骨架多了什么。后面的示例都在这一个工程里，顺着骨架往下看就行。

### 实现目标：`godbg exec <prog> [args...]` 启动并跟踪新进程

调试器要开始调试，首先得确定调试谁。目标可能是一个正在运行的进程，也可能是一个 core 文件。core 文件是进程结束前留下来的内存和硬件上下文，调试器可以借它看崩溃前的调用栈，但是进程已经结束了，没法再控制它往下执行。对运行中的进程能做的操作，其实覆盖了对 core 文件能做的操作，比如还可以控制程序怎么往下走。所以本章先看运行中的进程。core 文件怎么构成、怎么生成、怎么调试，我们放到符号级调试部分再讲。

进程要进入调试，常见有这么几种情况：

- 目标程序 `<prog>` 已经构建好，但是还没运行：我们需要把它启动起来并跟踪，如 `dlv exec <prog>`、`gdb <prog>`；
- 目标程序已经在跑，pid 也知道了：直接按 pid 跟踪，如 `dlv attach <pid>`、`gdb <pid>`。
- 目标程序还没构建，要先编译再运行：编译时得带上调试需要的选项，关掉内联和优化。`dlv debug`、`dlv test` 会自动加上 `-gcflags="all=-N -l"`；

OK，我们先做第一种。`godbg exec <prog> [args...]` 要做的事情其实是两件：先把已经构建好的程序启动起来，再立即跟踪它，让它在开始执行用户代码之前停住，然后进入第 5 章已经搭好的调试会话。`<prog>` 可以是可执行文件的路径，也可以是 `$PATH` 里能搜到的程序名。第2种是 6.2 节的 `godbg attach <pid>`，第3种情况对应 6.3 节的 `godbg debug`。

为什么"启动"还要配上"跟踪"呢？如果只是把进程跑起来，进程一下子就执行完了，我们来不及做任何调试动作。调试器希望进程停在起点等我们，这就需要跟踪（trace）能力：调试器进程（tracer）与被调试进程（tracee）之间先建立跟踪关系，tracee 在启动的那一刻被内核强制停住并通知 tracer，tracer 才能抓住时机介入。本节先介绍怎么用 `os/exec` 启动进程，再介绍跟踪是怎么建立的，最后在 godbgv2 中实现。

### 启动进程：os/exec 包

在 shell 里，只要敲一个程序路径或者程序名，就能把程序跑起来。stdout、stderr 上能看到它的输出，`$?` 则是进程的返回值。那么在 Go 里怎么做同样的事呢？标准库的 `os/exec` 包就可以，指定程序路径或程序名来启动进程，并拿到输出和执行结果。

先用 `exec.Command(...)` 准备一个 `exec.Cmd`。注意，`Cmd` 一旦调用过 `Start` 或 `Run`，就不能再复用了。真正启动的时候，按需要有几种写法，下面先把要用到的方法放在一起。

```go
// Command 的 name 可以是可执行文件路径，也可以是 PATH 中能搜到的程序名
func Command(name string, arg ...string) *Cmd

// Run 启动并等到进程结束
func (c *Cmd) Run() error

// Start 只负责启动，不等进程结束，要和 Wait 配对
func (c *Cmd) Start() error

// Wait 等到进程结束，取回退出码，并释放相关资源
func (c *Cmd) Wait() error

// Output 收集 stdout；CombinedOutput 把 stdout 和 stderr 合到一起
func (c *Cmd) Output() ([]byte, error)
func (c *Cmd) CombinedOutput() ([]byte, error)
```

准备好 `Cmd` 之后，可以这样用：

- 方法 1：`err := cmd.Start()` 把程序拉起来，再 `err := cmd.Wait()` 等到它结束；
- 方法 2：`err := cmd.Run()`，等价于上面的 `Start` 加 `Wait`，一次做到程序结束；
- 方法 3: 方法 1、方法 2 如果还想收集 stdout、stderr，可以在启动前把 `cmd.Stdout`、`cmd.Stderr` 指到一块 `bytes.Buffer`。觉得这样有点麻烦的话，可以用 `buf, err := cmd.CombinedOutput()`，启动并等到结束，`buf` 里就是 stdout 和 stderr 合在一起的输出。`Output` 则只收集 stdout。

还有一种情况，只有 `Start` 能照顾到：我们并不想一直等到进程结束。`Start` 返回之后进程还在跑，而且启动前可以改 `Cmd` 上的字段，比如把标准输入输出接到当前终端，或者设置 `SysProcAttr`。调试器后面用的就是这种。

不过在那之前，我们先用最少的代码把"启动一个程序、拿到输出"跑通，看看 exec 到底要做哪些事。

#### 示例代码：启动程序并获取输出

下面我们写一个简单程序，介绍下如何启动一个程序并获取它的输出，后面调试器实现中我们会编写类似的代码逻辑。

```go
package main

import (
	"fmt"
	"os"
	"os/exec"
)

const (
	usage = "Usage: ./godbg exec <path/to/prog>"

	cmdExec = "exec"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "%s\n\n", usage)
		os.Exit(1)
	}
	cmd := os.Args[1]

	switch cmd {
	case cmdExec:
		prog := os.Args[2]
		progCmd := exec.Command(prog)
		buf, err := progCmd.CombinedOutput()
		if err != nil {
			fmt.Fprintf(os.Stderr, "exec error: %v\n\n%s\n", err, buf)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stdout, "%s\n", buf)
	default:
		fmt.Fprintf(os.Stderr, "%s unknown cmd\n\n", cmd)
		os.Exit(1)
	}
}
```

这里的程序逻辑比较简单：

- 运行时先看命令行参数。`godbg exec <prog>` 至少要有 3 个参数，数量不对就报错退出；
- 再看第 2 个参数，`os.Args[1]` 不是 `exec`，也直接退出；
- 参数正常的话，第 3 个参数 `os.Args[2]` 就是程序路径或程序名。我们准备一个 `exec.Cmd`，启动并取回运行结果。

把这段代码存成 `main.go`，在所在目录执行：

```bash
go run main.go exec ls
```

程序会正常执行 `ls`，当前目录下的文件名打印出来。目标进程跑完了，输出和结果我们也拿到了。但是，调试会话、断点这些，这里都还没有。

#### 示例代码：思考我们遗漏了什么

需要注意的是，这里被拉起来的进程 `ls` 一下子就跑完了，我们来不及做任何调试动作。调试器希望进程停在起点等我们，所以后面不会再用 `CombinedOutput` 一直等到退出，而是改成 `Start`，并在启动前设上 `SysProcAttr.Ptrace`。在那之前，先搞清楚"跟踪"到底是怎么一回事。

### 跟踪进程：tracee、tracer 与 ptrace

在调试器领域里，tracee、tracer 是非常基础的概念，Linux 上系统调用 ptrace 负责建立起二者之间的联系（ptrace link）。

#### tracee

首先要明确 tracee 的概念，虽然我们看上去是对进程进行调试，实际上调试器内部工作时，是对一个一个的线程进行调试。

tracee，指的是被调试的线程，而不是进程。对于一个多线程程序而言，调试期间可能要跟踪部分或者全部线程，没有被跟踪的线程将会继续执行，而被跟踪的线程则受调试器控制。甚至同一个被调试进程中的不同线程，可以由不同的 tracer 来控制。

**这里还有几个比较特殊的注意事项，可以提前明确下：**

- 同一个线程只允许被一个调试器跟踪调试，如果希望启动多个独立的调试器实例对目标线程进行跟踪，操作系统会检测到该线程已经被某个调试器进程跟踪调试中，会拒绝其他调试器实例的 ptrace 请求。
- 在前后端分离式调试器架构下，也就是说只允许 1 个 debugger backend 实例 attach 被调试线程，但是我们可以启动多个 debugger frontend 来同时进行并发调试，这部分在第 9 章允许 multiclient 访问 debugger backend 时会介绍。
- 为了方便调试期间观察各个线程的状态，调试器通常会采用 All-stop Mode，即默认跟踪进程中的所有线程。要运行所有线程都运行，要停止所有线程都停止。这种方式更方便调试人员调试。

#### tracer

tracer，指的是向 tracee 发送调试控制命令的调试器进程，准确地说，也是线程。

有时会使用术语 ptrace link，实际上是指 tracer 通过 ptrace 系统调用（如 `PTRACE_TRACEME`、`PTRACE_ATTACH`）成功跟踪了 tracee，此后 tracer 就可以向 tracee 发送各种调试命令。需要注意的是，建立跟踪关系后，tracee 期望后续所有的 ptrace 请求都来自同一个 tracer 线程，否则会被内核拒绝。这也意味着，同一个线程只允许被同一个调试器（debugger backend）实例跟踪调试。

调试器（debugger backend）实现时要注意，建立 ptrace link 后，后续对该 tracee 的所有 ptrace 操作都要在主动建立该 ptrace link 的 tracer 线程中发起。特别是Go语言这种只暴漏了goroutine级别并发控制的语言，需要控制创建ptrace link的goroutine绑定一个固定的线程上，并且由该goroutine负责ptrace请求的发送。

#### ptrace limit：请求必须来自同一个 tracer 线程

我们的调试器示例是基于 Linux 平台编写的，调试能力依赖于 Linux ptrace。

通常，如果调试器也是多线程程序，就要注意 ptrace 的约束：当 tracer、tracee 建立了跟踪关系后，tracee（被跟踪线程）后续接收到的多个调试命令应该来自同一个 tracer（跟踪线程），意味着调试器实现时要将发送调试命令给 tracee 的 task（goroutine）绑定到 tracer 对应的特定线程上。

所以，发送调试命令的 goroutine 要调用 `runtime.LockOSThread()` 来绑定一个线程，后续 ptrace 请求均通过执行这个goroutine的线程来发送。

> runtime.LockOSThread()，该函数的作用是将调用该函数的 goroutine 绑定到该操作系统线程上，意味着该操作系统线程只会用来执行该 goroutine 上的操作，除非该 goroutine 调用了 runtime.UnLockOSThread() 解除这种绑定关系，否则该线程不会用来调度其他 goroutine。调用这个函数的 goroutine 也只能在当前线程上执行，不会被调度器迁移到其他线程。
>
> 如果这个 goroutine 执行结束后退出，绑定的这个线程 M 也会被销毁。这是当前 go runtime 设计实现中，除了进程退出时销毁线程之外的唯一一个线程 M 被创建出来后又销毁的情况。换言之，如果你的程序执行太多阻塞系统调用创建大量线程后，这些线程是不会被运行时主动销毁的。
>
> ok，我们来看下这个 runtime.LockOSThread() 的文档注释，see:
>
> ```go
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

调用了该函数之后，就可以满足 tracee 对 tracer 的要求：一旦 tracer 通过 ptrace 跟踪了某个 tracee，后续发送到该 tracee 的 ptrace 请求必须来自同一个 tracer（tracee、tracer 具体指的都是线程）。否则会遇到错误 `-ESRCH (No Such Process)`。

**内核中执行 ptrace 操作时，内核会进行这样的校验**:

file: ./kernel/ptrace.c

```c
SYSCALL_DEFINE4(ptrace, long, request, long, pid, unsigned long, addr,
        unsigned long, data)
{
    ...
    ret = ptrace_check_attach(child, request == PTRACE_KILL ||
                  request == PTRACE_INTERRUPT);
    if (ret < 0)
        goto out_put_task_struct;
    ...
out_put_task_struct:
    put_task_struct(child);
}

static int ptrace_check_attach(struct task_struct *child, bool ignore_state)
{
    int ret = -ESRCH;   // no such process
    ...
    if (child->ptrace && child->parent == current) {
        WARN_ON(child->state == __TASK_TRACED);
        /*
         * child->sighand can't be NULL, release_task()
         * does ptrace_unlink() before __exit_signal().
         */
        if (ignore_state || ptrace_freeze_traced(child))
            ret = 0;
    }
    ...
    return ret
}
```

如果后续 ptrace 请求来自非 ptrace link 建立时的 tracer 线程，那么 `ptrace_check_attach` 操作就会返回错误码 `-ESRCH`。OK，支持大家应该理解了 ptrace limit 是怎么来的了，这是内核中固有的一种设计约束，不允许多个tracer对一个tracee进行调试。试想，如果多个tracer同时对tracee进行了相互冲突的控制操作，那对调试体验影响是会比较大的，当然这么设计的原因并不仅此一条，状态同步与控制冲突、信号处理的排他性、内核数据结构的简化、安全与权限模型这几方面也有诉求。

#### wait：等待 tracee 停下来

tracer 发出 ptrace 请求之后，tracee 并不会立刻停下来：`PTRACE_TRACEME` 要等到 exec 发生的那一刻，`PTRACE_ATTACH` 则是内核先给 tracee 注入一个 SIGSTOP。所以 tracer 的下一步动作总是 wait——阻塞等待 tracee 进入停止状态，并取回它的状态信息。

Linux 下等待子进程状态变化的系统调用有 wait、waitpid、waitid、wait3、wait4 等。godbg 使用 wait4（Go 的 `syscall.Wait4`）：它可以等待指定 pid，可以带选项（如 `WSTOPPED`，表示等待被信号停止的事件，而不是默认只等进程退出），还可以顺带取回资源使用统计 rusage。

wait4 返回之后，通过 WaitStatus 就能知道 tracee 为什么停下来：

- `status.Stopped()`：tracee 是因为信号而停止；
- `status.StopSignal()`：让它停下来的信号是哪个。`PTRACE_TRACEME`+exec 场景下通知到tracer的信号是 SIGTRAP，attach 场景下应该是 SIGSTOP。对不上，就说明这次启动/跟踪失败了。

>现代调试器的优化（PTRACE_O_TRACEEXEC）：
>- 如果你在 ptrace 中设置了 PTRACE_O_TRACEEXEC 选项，内核在 exec 发生时将不再向进程发送裸的 SIGTRAP，而是产生一个专用的 ptrace 事件：PTRACE_EVENT_EXEC。
>- 现代调试器（如 GDB、LLDB）通常会开启这个选项，以便更稳妥地识别 exec 事件，避免与普通的断点 SIGTRAP 混淆。

tracee 停下来之后，tracer 就可以用 ptrace 的其他操作读写它的信息了，比如读写内存、读写寄存器（对应后面的 6.13 节 pmem、6.14 节 pregs），甚至一些更高级的用法，比如显示当前 tracee 的函数调用栈。

当结束调试时，可以通过 ptrace detach 操作，让 tracee 恢复执行。即使不显示 detach，tracer 退出时操作系统也会代为解除跟踪关系，tracee 同样可以恢复执行。

>注意：tracee 通知调试器从 wait4 阻塞状态唤醒，而调用 wait4 的线程不一定是建立 ptrace link 的 tracer 线程。也就是说，wait4 不受 "ptrace请求来自同一个tracer线程" 这个约束的限制，调试器进程中任意线程调用 wait4 阻塞等待 tracee 状态变化，都能被内核唤醒。

### 内核：PTRACE_TRACEME 如何在 exec 时把进程停住

前面讲了 tracee、tracer 的概念和 ptrace 的约束，那么"进程刚启动就停下来"这件事，内核是怎么做到的？这部分会涉及一些内核代码，如果暂时消化不了，知道个大概也不影响继续后面的实现。等对调试器的整体结构更熟悉了，再回过头来细看也不迟。

#### 思考：如何让进程刚启动就停止？

像我们前面这样通过 os/exec 包创建一个特定程序的 exec.Cmd 示例，然后调用 `exec.Cmd.CombinedOutput()/Run()/Start()` 的方式，进程一下子就执行结束了，或者越过了我们关心的程序位置了，我们不一定有机会去跟踪感兴趣的程序位置。下一节，我们还会尝试 attach 一个已经运行中的进程，其实也存在相同的问题。

不禁要思索：如果要做到高效的调试，就得能够让进程在启动之后立即停下来等待调试。怎么才能做到这点呢？

#### 内核：启动进程时内核做了什么？

启动一个指定的进程归根究底是 fork+exec 的组合：

```go
cmd := exec.Command(prog, args...)
cmd.Run()
```

- cmd.Run() 首先通过 `fork` 创建一个子进程；
- 然后子进程再通过 `execve` 函数加载目标程序、运行；

但是，如果只是这样的话，程序会立即执行，可能根本不会给我们预留调试的机会，甚至我们都来不及 attach 到进程添加断点，程序就执行结束了。

我们需要在 cmd 对应的目标程序指令开始执行之前就立即停下来！要做到这一点，就要依靠 ptrace 操作 `PTRACE_TRACEME`。

#### 内核：PTRACE_TRACEME 到底做了什么？

先使用 c 语言写个程序来简单说明下这一过程，为什么不用 go 语言示例呢？因为 go 运行时和标准库做了太多工作，此处使用 c 语言示例能用最少的篇幅展示关键步骤。在这之后我们还要介绍内核对 PTRACE_TRACEME 操作和 exec 操作的处理流程，加深理解，让大家知其然知其所以然。OK，看下这里的示例。

```c
#include <sys/ptrace.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

// see /usr/include/sys/user.sh `struct user_regs_struct`
define ORIG_EAX_FIELD = 11
define ORIG_EAX_ALIGN = 8 // 8 for x86_64, 4 for x86

int main()
{   pid_t child;
    long orig_eax;
    child = fork();
    if(child == 0) {
        ptrace(PTRACE_TRACEME, 0, NULL, NULL);
        execl("/bin/ls", "~", NULL);
    }
    else {
        wait(NULL);
        orig_eax = ptrace(PTRACE_PEEKUSER, child, (void *)(ORIG_EAX_FIELD * ORIG_EAX_ALIGN), (void *)NULL);
        printf("The child made a system call %ld\n", orig_eax);
        ptrace(PTRACE_CONT, child, NULL, NULL);
    }
    return 0;
}
```

上述示例中，首先父进程执行一次 fork，fork 返回值为 0 表示当前是子进程，子进程中执行一次 `ptrace(PTRACE_TRACEME,...)` 操作，下面是 ptrace 的定义，代码中省略了无关部分。当 ptrace request 为 PTRACE_TRACEME，内核将更新当前进程 `task_struct* current` 的标记位 `current->ptrace = PT_PTRACED`。而该标记位将直接影响 exec 族函数的执行行为，exec 族函数执行时会检查该标记位并做出相应处理。

**file: /kernel/ptrace.c**

```c
// ptrace系统调用实现
SYSCALL_DEFINE4(ptrace, long, request, long, pid, unsigned long, addr,
        unsigned long, data)
{
    ...

    if (request == PTRACE_TRACEME) {
        ret = ptrace_traceme();
        ...
        goto out;
    }
    ...

 out:
    return ret;
}

/**
 * ptrace_traceme是对ptrace(PTRACE_PTRACEME,...)的一个简易包装函数，
 * 它执行检查并设置进程标识位PT_PTRACED.
 */
static int ptrace_traceme(void)
{
    ...
    /* Are we already being traced? */
    if (!current->ptrace) {
        ...
        if (!ret && !(current->real_parent->flags & PF_EXITING)) {
            current->ptrace = PT_PTRACED;
            ...
        }
    }
    ...
    return ret;
}
```

#### 内核：PTRACE_TRACEME 对 execve 的影响？

c 语言库函数中，常见的 exec 族函数包括 execl、execlp、execle、execv、execvp、execvpe，这些都是由系统调用 execve 实现的。

系统调用 execve 的代码执行路径大致包括：

```c
-> sys_execve
 |-> do_execve
   |-> do_execveat_common
```

函数 do_execveat_common 的作用是，将当前进程的代码段、数据段（初始化&未初始化数据）用新加载的程序替换掉，然后执行新程序。

```c
-> retval = bprm_mm_init(bprm);
 |-> retval = prepare_binprm(bprm);
   |-> retval = copy_strings_kernel(1, &bprm->filename, bprm);
     |-> retval = copy_strings(bprm->envc, envp, bprm);
       |-> retval = exec_binprm(bprm);
         |-> retval = copy_strings(bprm->argc, argv, bprm);
```

这里我们重点关注一下上述过程中 `exec_binprm(bprm)`，这里包含了执行新程序的逻辑。

**file: fs/exec.c**

```c
#define PTRACE_EVENT_EXEC   4

static int exec_binprm(struct linux_binprm *bprm)
{
    pid_t old_pid, old_vpid;
    int ret;

    /* Need to fetch pid before load_binary changes it */
    old_pid = current->pid;
    rcu_read_lock();
    old_vpid = task_pid_nr_ns(current, task_active_pid_ns(current->parent));
    rcu_read_unlock();

    ret = search_binary_handler(bprm);
    if (ret >= 0) {
        audit_bprm(bprm);
        trace_sched_process_exec(current, old_pid, bprm);
        ptrace_event(PTRACE_EVENT_EXEC, old_vpid);
        proc_exec_connector(current);
    }

    return ret;
}
```

这里 `exec_binprm(bprm)` 内部调用了 `ptrace_event(PTRACE_EVENT_EXEC, message)`，后者将对进程 current->ptrace 状态进行检查，并执行处理。

有两种可能的处理路径：

- 如果发现当前 tracee 上被 tracer 设置了标记 `current->ptrace & PT_EVENT_FLAG(event)`，此时就会执行 `ptrace_notify((event<<8)|SIGTRAP)` 来给 tracee 发送一个信号 SIGTRAP；
- 或者发现 event==PTRACE_EVENT_EXEC，并且进程 `current->ptrace & (PT_TRACED|PT_SEIZED) == PT_TRACED`，内核将给进程发送一个 SIGTRAP 信号；

**file: include/linux/ptrace.h**

```c
#define PTRACE_EVENT_EXEC   4

#define PT_OPT_FLAG_SHIFT   3
#define PT_EVENT_FLAG(event)    (1 << (PT_OPT_FLAG_SHIFT + (event))) // 1<<7

/**
 * ptrace_event - possibly stop for a ptrace event notification
 * @event:  %PTRACE_EVENT_* value to report
 * @message:    value for %PTRACE_GETEVENTMSG to return
 *
 * Check whether @event is enabled and, if so, report @event and @message
 * to the ptrace parent.
 *
 * Called without locks.
 */
static inline void ptrace_event(int event, unsigned long message)
{
    if (unlikely(ptrace_event_enabled(current, event))) {
        current->ptrace_message = message;
        ptrace_notify((event << 8) | SIGTRAP);
    } else if (event == PTRACE_EVENT_EXEC) {
        /* legacy EXEC report via SIGTRAP */
        if ((current->ptrace & (PT_PTRACED|PT_SEIZED)) == PT_PTRACED)
            send_sig(SIGTRAP, current, 0);
    }
}

/**
 * ptrace_event_enabled - test whether a ptrace event is enabled
 * @task: ptracee of interest
 * @event: %PTRACE_EVENT_* to test
 *
 * Test whether @event is enabled for ptracee @task.
 *
 * Returns %true if @event is enabled, %false otherwise.
 */
static inline bool ptrace_event_enabled(struct task_struct *task, int event)
{
    return task->ptrace & PT_EVENT_FLAG(event);
}
```

在 Linux 下面，SIGTRAP 信号处理函数将使得进程暂停执行，并向父进程通知自身的状态变化，然后父进程通过 wait 系统调用来获取子进程状态的变化信息。ptrace_event 中这两个分支都可以实现对 tracee 通知 SIGTRAP 的目的。结合我们的上述示例，子进程执行 `ptrace(PTRACE_TRACEME, ...)` 操作，然后再执行 execve 替换掉代码段和数据段内容，最终实际上是通过第 2 个分支 `send_sig(SIGTRAP, current, 0)` 来发送 SIGTRAP 信号给 tracee。

我们先看这两个分支分别在什么时候命中：

- 第 1 个分支什么时候会命中？被调试进程已经存在了，tracer 先 ptrace attach，然后再调用 `ptrace(PTRACE_SETOPTIONS, ...)` 来设置 PTRACE_EVENT_EXEC，目的是跟踪进程后续 exec 的行为；
- 第 2 个分支什么时候会命中？这是对调试器常用ptrace操作 PTRACEME 的处理，tracer 主动启动被调试程序，先 fork 出子进程，然后子进程执行 `ptrace(PTRACE_TRACEME, ...)`，目的是让被调试进程启动后立即被跟踪；

> ps: 第 1 个分支在调试器跟踪一个已运行进程、且要感知它后续 exec 行为时才会用到；跟踪进程新建线程的 PTRACE_O_TRACECLONE 也是类似的机制，在 6.17.2 节会介绍。

#### 内核：SIGTRAP 的处理与 tracer 的唤醒

这里得先介绍一点关于信号的预备知识，Linux 中信号分为同步信号和异步信号：

- 同步信号是指令执行时就同步生成的，表示发生了严重事件，通常是不能耽搁处理的，也不建议捕获后自定义信号处理函数，比如 SIGSEGV、SIGTRAP 等，因为处理不当可能问题更大。
- 异步信号，这个是程序执行期间由外部操作生成的，如 Ctrl+C 生成的 SIGINT、SIGTERM、SIGQUIT 等，这类信号的处理等到程序执行系统调用返回用户态前处理即可，是可以捕获并自定义信号处理函数的；

ps: 但是 go 运行时有捕获部分 SIGSEGV 将其转为 panic 进行处理。

Linux 定义的同步信号主要有下面几个，其中就有我们关心的 SIGTRAP：

```c
#define SYNCHRONOUS_MASK                                     \
    (sigmask(SIGSEGV) | sigmask(SIGBUS) | sigmask(SIGILL) |  \
     sigmask(SIGTRAP) | sigmask(SIGFPE) | sigmask(SIGSYS))
```

信号发送实际上就是在进程 task_struct 的信号相关队列里进行记录，它是发送给这个进程的，而不是特定的某个线程。进程中的任何一个线程在执行系统调用返回用户态前都有机会取走接收到的信号并处理。内核中的信号处理逻辑，专门会检查当前进程有没有设置 ptraced 状态，有就会优先执行对应的调试相关的特殊处理逻辑，比如暂停 tracee 执行并通知唤醒 tracer。

下面来看看进一步的细节，这个在命中断点时，处理流程也是近似的。当前 tracee 线程是在执行系统调用 execve 哦，执行期间发现有 task_struct->ptraced=true 标识，然后内核为其生成了一个 SIGTRAP 信号，当 tracee 线程从系统调用返回用户程序之前，会有一个契机执行一遍信号处理。其实，就是一个 get_signal、handle_signal 的过程。对于 SIGTRAP 比较特殊，它是同步信号，会被优先出队并进行处理，并且会停止当前 tracee 调度，并通知唤醒 tracer。

```bash
arch_do_signal_or_restart(struct pt_regs *regs, bool has_signal)
|-> get_signal
|   |   // 同步信号优先出队进行处理，比如SIGTRAP
|   |-> signr = dequeue_synchronous_signal(&ksig->info);
|   |
|   |   // 如果是ptrace SIGTRAP，那么立即去执行处理，
|   |   // - 先暂停tracee执行，
|   |   // - 再通知tracer
|   |-> if (unlikely(current->ptrace) && signr != SIGKILL)
|   |     signr = ptrace_signal(signr, &ksig->info);
|   |     |-> ptrace_stop(signr, CLD_TRAPPED, 0, info);
|   |     |   |   // 设置一个不可调度状态
|   |     |   |-> set_special_state(TASK_TRACED);
|   |     |   |   // 通知tracer
|   |     |   |-> do_notify_parent_cldstop(current, true, why)
|   |     |   |      kernel_siginfo, info.si_signo=SIGCHLD, info.si_code = CLD_STOPPED
|   |     |   |      __group_send_sig_info(SIGCHLD, &info, parent);
|   |     |   |      __wake_up_parent(tsk, parent);
|   |     |   |   // 禁用抢占，不允许被调度
|   |     |   |-> freezable_schedule()
|   |-> else 
|   |     如果是其他普通信号，且sig_handler != IGN，则转handle_signal执行
|
|-> handle_signal(struct ksignal *ksig, struct pt_regs *regs)
|   |   // 设置signal handler执行需要的栈帧
|   |-> failed = setup_rt_frame(ksig, oldset, regs)
|   |   // 切换上下文，执行对应的signal handler
|   |-> fpu__clear_user_states(fpu) // enter signal handler
|   |   // 执行信号处理函数结束
|   |-> signal_setup_done(failed, ksig, stepping);
```

OK，SIGTRAP信号处理以及对tracer的唤醒，大致就是这样一个流程。

#### tracer 从 wait4 中被唤醒

那么 tracer（或者父进程）wait4 的实现，是怎么实现的呢？我们这里也进行了一个精简版的总结：

1. 简单来说，就是 tracer 或者父进程将自己加入一个等待子进程状态改变的等待队列中，然后将自己设置为可中断等待状态"INTERRUPTIBLE"，意思就是可以被信号唤醒，如 SIGCHLD 信号。
2. 然后 tracer 就调用一次进程调度，让出 CPU 去等待了，直到 tracee 因为 PTRACE_TRACEME 停下来，给 tracer 发信号通知 SIGCHLD or __wake_up_parent，此时 tracer 被唤醒。
3. tracer 此时会将自己从可中断等待状态"INTERRUPTIBLE"切换为"RUNNING"状态，从等待 tracee 状态改变的等待队列中移除，然后等待被 scheduler 调度。
4. 当 tracer 被 scheduler 调度到之后，它就可以继续执行后续处理了。

最终，tracer 从 syscall.Wait4 系统调用阻塞状态中唤醒，从 wait4 返回，就可以继续执行后续的其他 ptrace 操作了。

```bash
|-> wait4
      |-> kernel_wait4
            |-> do_wait
```

下面来详细看看：

```c
SYSCALL_DEFINE4(wait4, pid_t, upid, int __user *, stat_addr,
        int, options, struct rusage __user *, ru)
{
    struct rusage r;
    long err = kernel_wait4(upid, stat_addr, options, ru ? &r : NULL);

    if (err > 0) {
        if (ru && copy_to_user(ru, &r, sizeof(struct rusage)))
            return -EFAULT;
    }
    return err;
}

long kernel_wait4(pid_t upid, int __user *stat_addr, int options,
          struct rusage *ru)
{
    ...
    ret = do_wait(&wo);
    ...
}

static long do_wait(struct wait_opts *wo)
{
    ...

    // 将当前线程加入到进程共享的等待队列中 (注意这个current->signal是进程专属字段，所有线程共享)
    add_wait_queue(&current->signal->wait_chldexit, &wo->child_wait);

    do {
        // 将当前线程设置为可中断等待状态
        set_current_state(TASK_INTERRUPTIBLE);
        ...
        // 执行一轮调度，当前线程让出CPU进入等待
        schedule();
    } while (1);

    // 等到被唤醒并重新调度
    __set_current_state(TASK_RUNNING);
    remove_wait_queue(&current->signal->wait_chldexit, &wo->child_wait);
    return retval;
}
```

什么时候被唤醒呢？当 tracee 状态发生变化时，通过 do_notify_parent_cldstop 通知：

```c
static void do_notify_parent_cldstop(struct task_struct *tsk, bool for_ptracer, int why)
{
    ...
    // 仅考虑for_ptracer==true的情景，此时信号是发送给ptracer所属调试器进程的，
    // 调试器进程中不同的线程在处理信号时，它们的行为是有差异的：
    // - 如果是untraced线程，可以处理信号；
    // - 如果是traced线程，会进入signal-deliver-sigstop，暂停该线程执行，并将该线程收到的信号告知给这个线程的调试器
    //   这个线程的调试器则可以通过PTRACE_RESTART操作的同时inject signal给tracee（此时可以更换成别的信号）;
    //
    // 这个信号不一定总是生成，不一定能够唤醒ptracer进程上wait4阻塞调用！
    __group_send_sig_info(SIGCHLD, &info, parent);

    // 唤醒ptracer线程，之前ptracer因为wait4调用阻塞，这个函数是最靠谱的，它直接唤醒parent上等待tsk状态变化的所有线程
    __wake_up_parent(tsk, parent);
}

void __wake_up_parent(struct task_struct *p, struct task_struct *parent)
{
    // 唤醒ptracer所属进程上正在通过wait4等待当前tracee状态改变的所有线程
    // parent->signal是进程专属字段，所有线程共享
    __wake_up_sync_key(&parent->signal->wait_chldexit,
               TASK_INTERRUPTIBLE, p);
}
```

OK，以上提了下阻塞和唤醒的内核中的交互式过程。

tracer 也可通过 `ptrace(PTRACE_CONT, pid, ...)` 操作来恢复 tracee 执行。

#### Put it Together

现在，我们结合上述示例，再来回顾一下整个过程、理顺一下。

首先，父进程调用 fork、子进程创建成功之后是处于就绪态的，是可以运行的。然后，子进程先执行 `ptrace(PTRACE_TRACEME, ...)` 告诉内核"**当前进程希望在后续 execve 执行新程序时停下来，等待父进程的 ptrace 操作，所以请通知我在合适的时候停下来**"。子进程执行 execve 加载新程序，重新初始化进程执行所需要的代码段、数据段等等。

重新初始化完成之前内核会将进程状态调整为"**UnInterruptible Wait**"阻止其被调度、响应外部信号，完成之后，再将其调整为"**Interruptible Wait**"，即可以被信号唤醒，意味着如果有信号到达，则允许进程对信号进行处理。

接下来，如果该进程没有特殊的 ptrace 状态，子进程状态将被更新为可运行等待下次调度。当内核发现这个子进程 ptrace 标记位为 PT_PTRACED 时，则会执行这样的逻辑：内核给这个子进程发送了一个 **SIGTRAP** 信号，该信号将被追加到进程的 pending 信号队列中，当内核任务调度器调度到该进程，该进程执行系统调用返回用户态之前，发现其有 SIGTRAP 信号到达，将执行 SIGTRAP 的信号处理逻辑，只不过 SIGTRAP 比较特殊，作为一种同步信号会在进程从内核态返回用户态时立即被处理。

**SIGTRAP 信号处理具体做什么呢？**它会暂停目标进程的执行，并按条件发送 SIGCHLD 信号向父进程通知自己的状态变化，最后会有 __wake_up_parent 做兜底唤醒父进程。注意，在 PTRACE_TRACEME 的场景下，子进程调用 `ptrace(PTRACE_TRACEME, ...)` 后，父进程需要通过系统调用 wait 等待 tracee 停下来并获取进程状态。tracer 调用 wait 会将 tracer 状态变为 "**Interruptible Wait**"，当前 tracer 会被加入 tracee 进程状态变化的等待队列里。直到前面讲的内核处理 tracee 的 SIGTRAP 信号后将其停下来，然后发送 SIGCHLD 信号或 __wake_up_parent 将 tracer 唤醒。

>ps: 发送 SIGCHLD 信号唤醒 tracer 的方式不可靠，因为 tracer 进程有可能屏蔽该信号，所以最后才加入 __wake_up_parent(...) 这种方式作为兜底。

此时，tracer 被唤醒，wait 就可以返回子进程 tracee 的当前状态。tracer 发现子进程 tracee 已经停下来（并且是因为 SIGTRAP 停下来），就可以发起后续调试命令对应的 ptrace 操作，如读写内存数据。

#### Go 标准库中的实现

类似 c 语言 fork+exec 的方式，go 标准库提供了 ForkExec 函数实现，以此可以用 go 重写上述 c 语言示例。但是，go 标准库提供了另一种更简洁的方式。

我们首先通过 `cmd := exec.Command(prog, args...)` 获取一个 cmd 对象，在 `cmd.Start()` 启动进程前打开进程标记位 `cmd.SysProcAttr.Ptrace=true`，然后再 `cmd.Start()` 启动进程，最后调用 `Wait` 函数来等待子进程（因为 SIGTRAP）停下来并获取子进程的状态。

其实这里通过设置进程启动选项 Ptrace=true 的方式，到了标准库代码后，启动时也是类似我们 c 中处理的方式：先 fork 一个子进程，然后子进程设置 PRACEME，然后再 execve。

```go
func forkAndExecInChild1(argv0 *byte, argv, envv []*byte, chroot, dir *byte, attr *ProcAttr, sys *SysProcAttr, pipe int) (pid uintptr, pidfd int32, err1 Errno, mapPipe [2]int, locked bool) {
    // set clone flags
    flags = sys.Cloneflags
    if sys.Cloneflags&CLONE_NEWUSER == 0 && sys.Unshareflags&CLONE_NEWUSER == 0 {
        flags |= CLONE_VFORK | CLONE_VM
    }
    ...

    // clone child process
    if clone3 != nil {
        pid, err1 = rawVforkSyscall(_SYS_clone3, uintptr(unsafe.Pointer(clone3)), unsafe.Sizeof(*clone3), 0)
    } else {
        pid, err1 = rawVforkSyscall(SYS_CLONE, flags, 0, uintptr(unsafe.Pointer(&pidfd)))
    }
    ...

    // Enable tracing if requested.
    // Do this right before exec so that we don't unnecessarily trace the runtime
    // setting up after the fork. See issue #21428.
    if sys.Ptrace {
        _, _, err1 = RawSyscall(SYS_PTRACE, uintptr(PTRACE_TRACEME), 0, 0)
        ...
    }

    // Time to exec.
    _, _, err1 = RawSyscall(SYS_EXECVE,
        uintptr(unsafe.Pointer(argv0)),
        uintptr(unsafe.Pointer(&argv[0])),
        uintptr(unsafe.Pointer(&envv[0])))
    ...
```

所以接下来在 godbgv2 中的实现，只要在 `cmd.Start()` 之前设置 `SysProcAttr.Ptrace=true`，就自动获得了"启动后立即停住"的效果，再配合一次 wait 就能确认 tracee 已经因 SIGTRAP 停稳。

### 在 godbgv2 中实现

接下来我们就做这件事：把上面的逻辑搬进前面搭好调试器骨架的 godbgv2。tag `ch6.1` 相对骨架 `ch5.4`，调试会话没动，`PostRun` 里还是 `NewDebugSession().Start()`，变的是程序怎么被拉起来。

极简 demo 里写在一起的那几步，在这里拆开了：

- 参数检查交给 cobra。`exec <prog> [args...]` 在骨架里已经注册好，我们把对应的 `execCmd` 的 `Run` 方法换成 `RunE`，`RunE` 更适合对参数进行检查，参数不对就返回错误；
- 参数检查OK后再进入 `Run` 方法执行真正的启动程序的逻辑，并实现跟踪逻辑。`--` 之后的参数要原样传给被调试程序，具体在后面的"向被调试程序传递参数"一小节展开；
  - `cmd` 也不直接去调 `os/exec`。它通过 `api.Client.Launch` 把请求交给服务层，服务层再转到目标层。至于这个接口背后到底是谁，由 `main` 在启动时装上。在我们这里，是由 `Debugger` 实现 `api.Client` 接口方法 `api.Client.Launch`。
  - `exec.Command(...)` 挪到目标层的 `Debugger.Launch(...)->DebuggedProcess.launchCommand(...)`。这里改用 `Start`，启动前设置 `SysProcAttr.Ptrace`，启动后再等到 `SIGTRAP`，这样进程启动后会立即停下来——这就是前面"内核：PTRACE_TRACEME 如何在 exec 时把进程停住"一节讲的机制在 Go 里的落点；
  - 命令层不再把程序输出收进缓冲区，只打印被调试进程的 pid。程序自己的打印仍然出现在当前终端；
- `Run` 执行OK再进入 `PostRun` 进入已经搭好的调试会话；

所以相对 tag `ch5.4`，这一节新增的主要就是下面这条调用链。

```text
godbg exec <prog> [args...]
    cmd/exec.go                         RunE：校验参数，调用 Client.Launch（args[1:] 透传）
    pkg/service/api                     Client 接口，cmd 只认这个接口
    pkg/service/debugger                门面，把请求转给目标层
    pkg/target                          exec.Command + PTRACE_TRACEME，等待 SIGTRAP
    cmd/debug                           PostRun 进入已有的调试会话
```

Package `main` 负责装配。Package `cmd` 不直接 import `pkg/target`，也不直接 import `pkg/service/debugger`，而是通过 `api.Client` 来对接后端实现，比如在指令级调试部分这里的实现就是 `debugger.Debugger`，它直接操作目标进程。

到第 9 章后，我们会让调试器实现 headless 模式，暴漏一个调试用的service层，`api.Client` 通过 service层对接不同后端实现。这个改动过程中，命令层基本保持不变，相当于只换了 `var Client api.Client` 的实现。这个约定写在 godbgv2 的 `docs/ARCH-RULES.md` 里。

现在，godbgv2骨架里多出来了服务层和目标层，Package `pkg/service` 和 `pkg/target`：

```text
godbgv2
├── main.go                          装配 Client
├── cmd
│   ├── client.go                    UI 层看到的 Client 变量
│   ├── exec.go                      填上启动逻辑
│   └── debug/                       调试会话，本节未改
├── pkg/service
│   ├── api/client.go                Client 接口
│   └── debugger/debugger.go         门面
├── pkg/target
│   ├── process.go                   启动并等待 SIGTRAP
│   ├── ptrace_linux.go              ptrace 固定在同一个 OS 线程上执行
│   ├── procfs.go                    读 /proc/pid/stat，判断进程是否已成僵尸
│   └── process_test.go
└── examples/debuggee/loop.go        本节用来试手的目标程序
```

#### 命令层

`cmd/exec.go` 里，骨架原来的 `Run` 换成了 `RunE`。参数校验有误时返回错误，cobra 会把错误打到 stderr，进程以非零状态退出。参数没问题，就把程序路径和其余参数交给 `Client.Launch`（`args[1:]` 原样透传）。这个调用返回时，进程已经因为 exec 产生的 `SIGTRAP` 停住了，我们把 pid 打印出来。

```go
// execCmd 调试可执行程序
var execCmd = &cobra.Command{
    Use:   "exec <prog> [args...]",
    Short: "调试可执行程序",
    Long: `调试可执行程序

godbg 自身的选项要写在 -- 之前，-- 之后的参数会原样传递给被调试程序：

  godbg exec ./prog -- -name value

若被调试程序不需要以破折号开头的参数，也可以省略 --：

  godbg exec ./prog arg1 arg2`,
    RunE: func(cmd *cobra.Command, args []string) error {
        if len(args) < 1 {
            return errors.New("参数错误")
        }

        // 启动并跟踪被调试进程（剩余参数原样传递给被调试程序），
        // 等待其因 exec 产生的 SIGTRAP 而停止
        pid, err := Client.Launch(api.KindExec, args[0], args[1:]...)
        if err != nil {
            return err
        }
        fmt.Printf("process %d launched, stopped by SIGTRAP\n", pid)
        return nil
    },
    PostRun: func(cmd *cobra.Command, args []string) {
        // TODO(ch6.4): 退出会话时清理被调试进程
        debug.CurrentSession = debug.NewDebugSession()
        debug.CurrentSession.Start()
    },
}
```

`Client` 定义在 `cmd/client.go`，类型是 `api.Client`。命令层之后都通过它和后端打交道。

#### 向被调试程序传递参数

`godbg exec` 支持把参数传给被调试程序。`api.Client.Launch` 从 ch6.1 起就是变参（`args ...string`），命令层把 `args[1:]` 交给它，再经由 debugger 门面、目标层一路传到 `exec.Command`，实现上并没有额外的工作。

真正的坑在命令行解析：cobra/pflag 默认会把 `-` 开头的参数当成 godbg 自己的选项。比如 `godbg exec ./prog -v` 只会打开 godbg 的 verbose，tracee 收不到 `-v`；碰到不认识的选项则直接报错。因此 godbg 约定与 dlv 一致：**godbg 自身的选项写在 `--` 之前，`--` 之后的参数原样传给被调试程序**。例如：

```bash
$ ./godbg exec /bin/echo -- hello godbg
process 208202 launched, stopped by SIGTRAP
godbg> exit
hello godbg
```

这一版会话退出时还不会清理 tracee，所以 `exit` 之后内核解除跟踪关系，echo 才恢复执行、把参数打印出来——这个"退出后 tracee 继续跑"的现象，正好对应 6.4 节要补的退出善后。

#### 装配

`main` 在调用 `cmd.Execute()` 之前，先把具体实现注进去：

```go
func main() {
    go processSignals()

    cmd.Client = debugger.New()
    cmd.Execute()
}
```

`processSignals` 放在单独的 goroutine 里处理信号。Go 运行时用 `SIGURG` 做异步抢占，这个信号我们暂时直接忽略。`SIGTERM`、`SIGINT`、`SIGQUIT` 目前先让进程退出。被调试进程与断点的退出善后从 6.4 节开始统一处理（信号退出场景的清理在 6.10 节补齐）。

`api.Client` 在这一节只有一个方法。后面几节会陆续补上 attach、读写内存这些操作，会陆续有点改动。到第 9 章时，这里的完整接口才能定下来。

```go
type Client interface {
    // Launch 启动并跟踪一个进程，返回被调试进程 pid
    Launch(kind Kind, cmd string, args ...string) (int, error)
}
```

`pkg/service/debugger` 是第 6 章对这个接口的实现。它自己不打印任何内容，只把请求转给目标层，并记住当前正在调试的 `DebuggedProcess`：

```go
func (d *Debugger) Launch(kind api.Kind, cmd string, args ...string) (int, error) {
    dbp, err := target.NewDebuggedProcess(cmd, args, target.Kind(kind))
    if err != nil {
        return 0, err
    }
    d.dbp = dbp
    return dbp.Process.Pid, nil
}
```

`api.Kind` 和 `target.Kind` 是两套枚举，取值顺序一样，都是 debug、exec、attach。接口上只传值，目标层自己的类型不会漏到 `cmd` 里。

#### 目标层：启动并停住

`NewDebuggedProcess` 先把进程描述准备好，再通过 `ExecPtrace` 去真正启动。如果启动失败，就把处理 ptrace 的那个协程停掉，免得留下一个空转的 goroutine。

```go
func NewDebuggedProcess(cmd string, args []string, kind Kind) (*DebuggedProcess, error) {
    var (
        dbp DebuggedProcess
        err error
    )
    dbp = DebuggedProcess{
        Command: cmd,
        Args:    args,
        Kind:    kind,
        once:    &sync.Once{},
        reqCh:   make(chan ptraceRequest, 16),
        doneCh:  make(chan int),
    }
    defer func() {
        if err != nil {
            dbp.StopPtrace()
        }
    }()

    err = dbp.ExecPtrace(func() error {
        dbp.Process, err = dbp.launchCommand(cmd, args...)
        if err != nil {
            return err
        }
        return nil
    })
    if err != nil {
        return nil, err
    }
    return &dbp, nil
}
```

`launchCommand` 才是 `os/exec` 真正上场的地方。标准输入输出接到调试器所在的终端，被调试程序的打印还能出现在当前会话里。`SysProcAttr.Ptrace` 设为 true，子进程会在 exec 之前执行 `ptrace(PTRACE_TRACEME)`。exec 一旦成功，它就会收到 `SIGTRAP` 并暂停，等调试器下一步指令。`Setpgid` 让子进程单独使用自己的进程组，`Foreground` 保持 false，不把它放到终端前台，这样 Ctrl+C 仍然是交给调试器的。

环境变量先继承当前环境，再追加 `GODEBUG=asyncpreemptoff=1`，把 Go 运行时的异步抢占关掉。不然被调试进程里的抢占信号，会和调试器插入的信号搅在一起。

```go
func (p *DebuggedProcess) launchCommand(execName string, args ...string) (*os.Process, error) {
    progCmd := exec.Command(execName, args...)
    progCmd.Stdin = os.Stdin
    progCmd.Stdout = os.Stdout
    progCmd.Stderr = os.Stderr

    progCmd.SysProcAttr = &syscall.SysProcAttr{
        Ptrace:     true, // implies PTRACE_TRACEME
        Setpgid:    true,
        Foreground: false,
    }
    progCmd.Env = os.Environ()
    progCmd.Env = append(progCmd.Env, "GODEBUG=asyncpreemptoff=1")

    err := progCmd.Start()
    if err != nil {
        return nil, err
    }
    p.Process = progCmd.Process

    _, status, err := p.wait(progCmd.Process.Pid, syscall.WSTOPPED)
    if err != nil {
        return nil, err
    }
    if !status.Stopped() || status.StopSignal() != syscall.SIGTRAP {
        return nil, fmt.Errorf("unexpected status: %v", status)
    }
    return progCmd.Process, nil
}
```

`Start` 返回的时候，子进程多半还没停稳。所以紧接着用 `wait`，内部是 `wait4`，等到 `WSTOPPED`，并核对停止信号是不是 `SIGTRAP`。对不上，就当这次启动失败。这和前面内核流程分析里讲的一致：tracee 因 exec 被发送 SIGTRAP，停下来之后唤醒阻塞在 wait4 上的 tracer。

`wait` 里对线程组 leader 做了点特殊处理。leader 已经退出、却还留着僵尸子线程时，直接 `wait4` 会永远阻塞。这里改成带 `WNOHANG` 的轮询，同时读 `/proc/<pid>/stat`，看它是不是已经变成僵尸。刚 exec 完就停住的场景里，这个分支通常走不到，写在这里是为了后面跟踪多线程时，同一套等待逻辑还能接着用。

还有一个 Go 运行时带来的约束，前面"ptrace limit"里已经提过：ptrace 一旦建立跟踪关系，后面的请求必须从同一个线程发出，内核才认。goroutine 和 OS 线程并没有绑定关系，所以不能在随便哪个 goroutine 里直接调 `syscall.Ptrace*`。`ExecPtrace` 第一次被调用时会拉起一个协程，用 `runtime.LockOSThread` 把它钉在一个线程上，所有 ptrace 请求都进 `reqCh`，由这个线程串行执行。`launchCommand` 包在 `ExecPtrace` 里，就是为了从这一步开始，跟踪关系就落在这个线程上。6.2 节去 attach 一个已经在跑的进程时，走的还是这条路。

```go
func (p *DebuggedProcess) ExecPtrace(fn func() error) error {

    p.once.Do(func() {
        go func() {
            // ensure all ptrace requests goes via the same tracer (thread)
            runtime.LockOSThread()
            defer runtime.UnlockOSThread()

            for {
                select {
                case req := <-p.reqCh:
                    req.errCh <- req.fn()
                case <-p.doneCh:
                    return
                }
            }
        }()
    })

    req := ptraceRequest{
        fn:    fn,
        errCh: make(chan error),
    }
    p.reqCh <- req
    return <-req.errCh
}
```

### 运行效果

在 godbgv2 仓库里切到这一节，把调试器和目标程序都构建出来：

```bash
git checkout ch6.1
make build
make fixtures
```

`make fixtures` 会把 `examples/debuggee/loop.go` 编到 `_fixtures/loop`。这个程序每秒打印一次自己的 pid 和计数值，方便我们看它到底有没有跑起来。编译时带了 `-gcflags "all=-N -l"`，和后面调试 Go 程序时的要求是一致的。

```bash
$ ./godbg exec _fixtures/loop
process 208201 launched, stopped by SIGTRAP
godbg>
```

pid 每次运行都不一样。看到这行输出时，loop 还没开始打印，它停在 exec 之后。提示符 `godbg>` 就是骨架里那个调试会话。断点、单步这些命令这一节还没做，在会话里执行的话，看到的仍是带章节号的 TODO。

输入 `exit` 可以结束会话。这一版退出时还不会清理被调试进程。调试器自己退出之后，内核会把跟踪关系解开，loop 就从停下的地方继续跑，终端上会开始出现 `pid: ...`。试完记得把这个 pid 停掉。退出前的清理，6.4 节会统一补上。

> ps: loop 是单 goroutine 程序，启动后停在 exec 处时还没有别的线程。Go 程序运行起来之后，运行时还会创建 sysmon、GC 等线程，如何自动跟踪这些新建线程，见 6.17 节"调试多线程程序"。

### 本节小结

本节完成了调试器第一个真正意义上的调试动作：启动并跟踪一个进程。核心内容包括：

- 用一段极简代码看清 `os/exec` 要做的事，也就是解析 `exec <prog>`、启动程序并取回输出；
- 介绍了跟踪的核心概念：tracee 是被调试的线程，tracer 是发送调试命令的调试器线程，ptrace link 一旦建立，后续所有 ptrace 请求都必须来自同一个 tracer 线程，Go 里要靠 `runtime.LockOSThread` 来满足；
- 从内核代码出发，理清了 PTRACE_TRACEME 和 exec 的配合：子进程标记 PT_PTRACED 后，exec 成功那一刻内核给它发送同步信号 SIGTRAP，tracee 进入 TASK_TRACED 停止态，再通过 SIGCHLD/__wake_up_parent 唤醒阻塞在 wait4 上的 tracer；
- 把这套逻辑搬进 tag `ch5.4` 的调试器骨架：命令层只调用 `api.Client.Launch`，由 `main` 装配实现，再转到 `pkg/target` 完成 `SysProcAttr.Ptrace=true` 的启动和等待 SIGTRAP；
- 支持 `godbg exec <prog> [args...]`：`--` 之后参数原样透传给被调试程序，`--` 之前仍由 godbg 解析；

本节内容为读者学习 6.2 节的 attach，以及后面在这个已经停住的进程上做断点、单步和查看寄存器打下了基础。
