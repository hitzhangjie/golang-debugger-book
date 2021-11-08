## 启动&Attach进程

### 实现目标：启动进程并attach

#### 思考：如何让进程刚启动就停止？

前面小节介绍了通过`exec.Command(prog, args...)`来启动一个进程，也介绍了通过ptrace系统调用attach一个运行中的进程。读者是否有疑问，这样启动调试的方式能满足调试要求吗？

当尝试attach一个运行中的进程时，进程正在执行的指令可能早已经越过了我们关心的位置。比如，我们想调试追踪下golang程序在执行main.main之前的初始化步骤，但是通过先启动程序再attach的方式无疑太滞后了，main.main可能早已经开始执行，甚至程序都已经执行结束了。

考虑到这，不禁要思索在“启动进程”小节的实现方式有没有问题。我们如何让进程在启动之后立即停下来等待调试呢？如果做不到这点，就很难做到高效的调试。

#### 内核：启动进程时内核做了什么？

启动一个指定的进程归根究底是fork+exec的组合：
```go
cmd := exec.Command(prog, args...)
cmd.Run()
```

- cmd.Run()首先通过`fork`创建一个子进程；
- 然后子进程再通过`execve`函数加载目标程序、运行；

但是如果只是这样的话，程序会立即执行，可能根本不会给我们预留调试的机会，甚至我们都来不及attach到进程添加断点，程序就执行结束了。

我们需要在cmd对应的目标程序指令在开始执行之前就立即停下来！要做到这一点，就要依靠ptrace操作`PTRACE_TRACEME`。

#### 内核：PTRACE_TRACEME到底做了什么？

先使用c语言写个程序来简单说明下这一过程，在这之后我们还要看些内核代码，加深对PTRACE_TRACEME操作以及进程启动过程的理解，这些代码是c语言实现的，这个简短的示例使用c语言实现也是为了让读者提前联想一下c语言的语法。

```c
#include <sys/ptrace.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <linux/user.h>   /* For constants ORIG_EAX etc */
int main()
{   pid_t child;
    long orig_eax;
    child = fork();
    if(child == 0) {
        ptrace(PTRACE_TRACEME, 0, NULL, NULL);
        execl("/bin/ls", "ls", NULL);
    }
    else {
        wait(NULL);
        orig_eax = ptrace(PTRACE_PEEKUSER, child, 4 * ORIG_EAX, gg);
        printf("The child made a system call %ld\n", orig_eax);
        ptrace(PTRACE_CONT, child, NULL, NULL);
    }
    return 0;
}
```

上述示例中，首先进程执行一次fork，fork返回值为0表示当前是子进程，子进程中执行一次`ptrace(PTRACE_TRACEME,...)`操作，让内核代为做点事情。

我们再来看下内核到底做了什么，下面是ptrace的定义，代码中省略了无关部分，如果ptrace request为PTRACE_TRACEME，内核将更新当前进程`task_struct* current`的调试信息标记位`current->ptrace = PT_PTRACED`。

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

#### 内核：PTRACE_TRACEME对execve影响？

c语言库函数中，常见的exec族函数包括execl、execlp、execle、execv、execvp、execvpe，这些都是由系统调用execve实现的。

系统调用execve的代码执行路径大致包括：

```c
-> sys_execve
 |-> do_execve
   |-> do_execveat_common
```

函数do_execveat_common的代码执行路径大致包括下面列出这些，其作用是将当前进程的代码段、数据段、初始化&未初始化数据用新加载的程序替换掉，然后执行新程序。

```c
-> retval = bprm_mm_init(bprm);
 |-> retval = prepare_binprm(bprm);
   |-> retval = copy_strings_kernel(1, &bprm->filename, bprm);
     |-> retval = copy_strings(bprm->envc, envp, bprm);
       |-> retval = exec_binprm(bprm);
         |-> retval = copy_strings(bprm->argc, argv, bprm);
```

这里牵扯到的代码量比较多，我们重点关注一下上述过程中`exec_binprm(bprm)`，这里包含了执行新程序的部分逻辑。

**file: fs/exec.c**

```c
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

这里`exec_binprm(bprm)`内部调用了`ptrace_event(PTRACE_EVENT_EXEC, message)`，后者将对进程ptrace状态进行检查，一旦发现进程ptrace标记位设置了PT_PTRACED，内核将给进程发送一个SIGTRAP信号，由此转入SIGTRAP的信号处理逻辑。

**file: include/linux/ptrace.h**

```c
/**
 * ptrace_event - possibly stop for a ptrace event notification
 * @event:	%PTRACE_EVENT_* value to report
 * @message:	value for %PTRACE_GETEVENTMSG to return
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
```

在Linux下面，SIGTRAP信号将使得进程暂停执行，并向父进程通知自身的状态变化，父进程通过wait系统调用来获取子进程状态的变化信息。

父进程也可通过`ptrace(PTRACE_COND, pid, ...)`操作来恢复子进程执行，使其继续执行execve加载的新程序。

#### Put it Together

现在，我们结合上述示例，再来回顾一下整个过程、理顺一下。

首先，父进程调用fork、子进程创建成功之后是处于就绪态的，是可以运行的。然后，子进程先执行`ptrace(PTRACE_TRACEME, ...)`告诉内核“**当前进程希望在后续execve执行新程序时停下来，等待父进程的ptrace操作，所以请通知我在合适的时候停下来**”。子进程再执行execve加载新程序，重新初始化进程执行所需要的代码段、数据段等等。

重新初始化完成之前内核会将进程状态调整为“**UnInterruptible Wait**”阻止其被调度、响应外部信号，完成之后，再将其调整为“**Interruptible Wait**”，即可以被信号唤醒，意味着如果有信号到达，则允许进程对信号进行处理。

接下来，如果该进程没有特殊的ptrace标记位，子进程状态将被更新为可运行等待下次调度。当内核发现这个子进程ptrace标记位为PT_PTRACED时，则会执行这样的逻辑：内核给这个子进程发送了一个**SIGTRAP**信号，该信号将被追加到进程的pending信号队列中，并尝试唤醒该进程，当内核任务调度器调度到该进程时，发现其有pending信号到达，将执行SIGTRAP的信号处理逻辑，只不过SIGTRAP比较特殊是内核代为处理。

**SIGTRAP信号处理具体做什么呢？**它会暂停目标进程的执行，并向父进程通知自己的状态变化，此时父进程通过系统调用wait就可以获取到子进程状态变化的情况。一旦父进程tracer发现子进程tracee已经停下来，就可以发起后续的ptrace操作，如读写内存数据。

### 代码实现

类似c语言fork+exec的方式，go标准库提供了一个ForkExec函数实现，以此可以用go重写上述c语言示例。但是，go标准库提供了另一种更简洁的方式。

我们首先通过`cmd := exec.Command(prog, args...)`获取一个cmd对象，在`cmd.Start()`启动进程前打开进程标记位`cmd.SysProcAttr.Ptrace=true`，然后再`cmd.Start()`启动进程，最后调用`Wait`函数来等待子进程（因为SIGTRAP）停下来并获取子进程的状态。

在这之后，父进程便可以继续做些调试相关的工作了，如读写内存等。

这里的示例代码，是在以前示例代码基础上修改得来，修改后代码如下：

```go
package cmd

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"godbg/cmd/debug"

	"github.com/spf13/cobra"
)

var pid int

// execCmd represents the exec command
var execCmd = &cobra.Command{
	Use:   "exec <prog>",
	Short: "调试可执行程序",
	Long:  `调试可执行程序`,
	RunE: func(cmd *cobra.Command, args []string) error {
		fmt.Printf("exec %s\n", strings.Join(args, ""))

		if len(args) != 1 {
			return errors.New("参数错误")
		}

		// start process but don't wait it finished
		progCmd := exec.Command(args[0])
		progCmd.Stdin = os.Stdin
		progCmd.Stdout = os.Stdout
		progCmd.Stderr = os.Stderr
		progCmd.SysProcAttr = &syscall.SysProcAttr{
			Ptrace: true,
		}

		err := progCmd.Start()
		if err != nil {
			return err
		}

		// wait target process stopped
		pid = progCmd.Process.Pid

		var (
			status syscall.WaitStatus
			rusage syscall.Rusage
		)
		_, err = syscall.Wait4(pid, &status, syscall.WALL, &rusage)
		if err != nil {
			return err
		}
		fmt.Printf("process %d stopped:%v\n", pid, status.Stopped())

		return nil
	},
	PostRunE: func(cmd *cobra.Command, args []string) error {
		debug.NewDebugShell().Run()
		// let target process continue
		return syscall.PtraceCont(pid, 0) 
	},
}

func init() {
	rootCmd.AddCommand(execCmd)
}
```

### 代码测试

下面我们针对调整后的代码进行测试：

```bash
$ cd golang-debugger/lessons/0_godbg/godbg && go install -v
$
$ godbg exec ls
exec ls
process 2479 stopped:true
godbg> exit
cmd  go.mod  go.sum  LICENSE  main.go  syms  target
```

首先，我们进入示例代码目录编译安装godbg，然后运行`godbg exec ls`，意图对PATH中可执行程序`ls`进行调试。

godbg将启动ls进程，并通过PTRACE_TRACEME让内核把ls进程停下（通过SIGTRAP），可以看到调试器输出`process 2479 stopped:true`，表示被调试进程pid是2479已经停止执行了。

并且还启动了一个调试回话，终端命令提示符应变成了`godbg> `，表示调试会话正在等待用户输入调试命令，我们除了`exit`命令还没有实现其他的调试命令，我们输入`exit`退出调试会话。

> NOTE：关于调试会话
>
> 这里的调试会话，不过是个允许用户输入调试命令的黑窗口，用户所有的输入都会转交给cobra生成的debugRootCmd处理，debugRootCmd下包含了很多的subcmd，比如breakpoint、list、continue、step等调试命令。
>
> 在写这篇文档时，我们还是基于cobraprompt来管理调试会话命令及输入补全的，将上述debugRootCmd交给cobraprompt管理后，当我们输入一些信息后，prompt就会处理我们的输入并交给debugRootCmd注册的同名命令进行处理。
>
> 如我们输入了exit，则会调用debugRootCmd中注册的exitCmd进行处理。exitCmd只是执行os.Exit(0)让进程退出，在退出之前内核会自动做些清理操作，如正在被其跟踪的tracee会被内核执行ptrace(PTRACE_COND,...)解除跟踪，让tracee恢复执行。

当我们退出调试会话时，会通过`ptrace(PTRACE_COND,...)`操作来恢复被调试进程继续执行，也就是ls正常执行列出目录下文件的命令，我们也看到了它输出了当前目录下的文件信息`cmd go.mod go.sum LICENSE main.go syms target`。

`godbg exec <prog>`命令现在一切正常了！

> NOTE: 示例中在execCmd.PostRunE中显示调用了`ptrace(PTRACE_COND,...)`，其实是没有必要的，原因在介绍调试会话时以提及，内核会代为处理接触tracee的跟踪状态。
>
> 其实，如果tracee如果是我们显示启动的，那么在调试器退出时应该kill掉该进程（或者允许选择kill进程或让其继续执行），而不应该默认让其继续执行。

> FIXME：本文第一版撰写时间偏早，示例代码与调试器示例最新代码已不一致，但对读者朋友们学习影响并不大，不要因此而受影响，有时间我会尽快更新。

### 参考内容

- Playing with ptrace, Part I, Pradeep Padala, https://www.linuxjournal.com/article/6100
- Playing with ptrace, Part II, Pradeep Padala, https://www.linuxjournal.com/article/6210
- Understanding Linux Execve System Call, Wenbo Shen, https://wenboshen.org/posts/2016-09-15-kernel-execve.html

