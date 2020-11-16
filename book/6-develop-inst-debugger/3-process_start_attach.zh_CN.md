## 启动&Attach进程

### 实现目标：启动进程并attach

#### 思考：如何让进程刚启动就停止？

前面我们介绍了如何通过`exec.Command(prog, args...)`启动一个进程，也介绍了如何通过ptrace系统调用attach到一个运行中的进程。

一个运行中的进程被attached时，其正在运行的指令可能已经越过了我们的位置。比如，我们想通过调试追踪下golang程序在执行main.main之前的初始化步骤，但是通过先启动程序再attach的方式无疑就太滞后了，main.main可能早已经开始执行，甚至程序都已经执行结束了。

考虑到这，不禁要思索在“启动进程”小节的实现方式有没有问题。我们如何让进程在启动之后立即停下来等待被调试器调试呢？如果做不到这点，就很难做到理想的调试。

#### 内核：启动进程时内核做了什么？

启动一个指定的进程归根究底是fork+exec的组合：
```go
cmd := exec.Command(prog, args...)
cmd.Run()
```

- cmd.Run()首先通过fork创建一个子进程；
- 然后子进程再通过execve函数加载目标程序、运行；

但是如果只是这样的话，程序会立即执行，可能根本不会给我们预留调试的机会，甚至我们都来不及attach到进程添加断点，程序就执行结束了。

我们需要在cmd对应的目标程序指令在开始执行之前就立即停下来！要做到这一点，就要依靠ptrace操作PTRACE_TRACEME。

#### 内核：PTRACE_TRACEME到底做了什么？

先使用c语言写个程序来简单说明下这一过程，为什么用c，因为接下来我们要看些内核代码，加深对PTRACE_TRACEME操作以及进程启动过程的理解，当然这些代码也是c语言实现的。

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
        orig_eax = ptrace(PTRACE_PEEKUSER, child, 4 * ORIG_EAX, NULL);
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
sys_execve
do_execve
do_execveat_common
```

函数do_execveat_common代码执行路径的主体部分大致包括，其作用是将当前进程的代码段、数据段、初始化未初始化数据通通用新加载的程序替换掉，然后执行新程序。

```c
retval = bprm_mm_init(bprm);
retval = prepare_binprm(bprm);
retval = copy_strings_kernel(1, &bprm->filename, bprm);
retval = copy_strings(bprm->envc, envp, bprm);
retval = exec_binprm(bprm);
retval = copy_strings(bprm->argc, argv, bprm);
```

这里牵扯到的代码量比较多，我们重点关注一下上述过程中`exec_binprm(bprm)`，这是执行程序的部分逻辑。

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

这里`exec_binprm(bprm)`内部调用了`ptrace_event(event, message)`，后者将对进程ptrace状态进行检查，一旦发现进程ptrace标记位设置了PT_PTRACED，内核将给进程发送一个SIGTRAP信号，由此转入SIGTRAP的信号处理逻辑。

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

父进程也可通过`ptrace(PTRACE_COND, pid, ...)`操作可以恢复子进程执行，使其执行execve加载的新程序。

> ps: 其实子进程内部先执行ptrace(PTRACE_TRACEME, ...)，再执行execve，其实是已经加载完新程序完成初始化了，但是并没有被内核放置在就绪队列中，内核只是给这个子进程发送了一个SIGTRAP信号，然后尝试唤醒该子进程，唤醒成功也就是放入就绪队列，等子进程被调度器选中并执行时，它将首先对pending的信号进行处理。
>
> 对于SIGTRAP信号而言，也就是它要停下来并向父进程通知自己的状态变化。此时父进程通过wait就可以获取到子进程状态变化的情况。

### 代码实现

go标准库里面只有一个ForkExec函数可用，并不能直接写fork+exec的方式，但是呢，go标准库提供了另一种用起来更加友好的思路。

我们首先通过`cmd := exec.Command(prog, args...)`获取一个cmd对象，接着通过cmd对象获取进程Process结构体，然后修改其内部状态为ptrace即可。这样之后再启动子进程。

比如通过`cmd.Run()`，然后一定要调用`Wait`函数来获取子进程的执行状态变化，就是停下来的事件，父进程收到之后，可以先做一些调试工作。

ps：这里的示例代码，我们将在golang-debugger-lessons中提供。

### 参考内容：

- Playing with ptrace, Part I, Pradeep Padala, https://www.linuxjournal.com/article/6100
- Playing with ptrace, Part II, Pradeep Padala, https://www.linuxjournal.com/article/6210
- Understanding Linux Execve System Call, Wenbo Shen, https://wenboshen.org/posts/2016-09-15-kernel-execve.html

