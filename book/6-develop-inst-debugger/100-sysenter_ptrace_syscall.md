汇编sysenter：进入系统调用，类似int 80h
sysenter是用汇编实现的，内部会调用函数do_SYSENTER_32：https://sourcegraph.com/github.com/torvalds/linux@9c87c9f41245baa3fc4716cf39141439cf405b01/-/blob/arch/x86/entry/entry_32.S#L952

```asm
.Lsysenter_flags_fixed:

	movl	%esp, %eax
	call	do_SYSENTER_32          <==== 看这里！
	testl	%eax, %eax
	jz	.Lsyscall_32_done

	STACKLEAK_ERASE

	/* Opportunistic SYSEXIT */

	/*
	 * Setup entry stack - we keep the pointer in %eax and do the
	 * switch after almost all user-state is restored.
	 */

	/* Load entry stack pointer and allocate frame for eflags/eax */
	movl	PER_CPU_VAR(cpu_tss_rw + TSS_sp0), %eax
	subl	$(2*4), %eax
  ...
```

filename：./arch/x86/entry/common.c，函数do_SYSENTER_32

```c
194 /* Returns 0 to return using IRET or 1 to return using SYSEXIT/SYSRETL. */
195    __visible noinstr long do_SYSENTER_32(struct pt_regs *regs)
|
| 196 {
|  197 ¦   /* SYSENTER loses RSP, but the vDSO saved it in RBP. */
|  198 ¦   regs->sp = regs->bp;
|  199 
|  200 ¦   /* SYSENTER clobbers EFLAGS.IF.  Assume it was set in usermode. */
|  201 ¦   regs->flags |= X86_EFLAGS_IF;
|  202 
|  203 ¦   return do_fast_syscall_32(regs);                                                                                                                                                                                                                                     
|  204 }
```

内部调用了do_fast_syscall_32(regs)，它内部又调用了__do_fast_syscall_32(regs)，
这个函数内部调用了几个函数，从用户模式切换到内核模式，然后再从内核模式退回到用户模式

```
syscall_enter_from_user_mode_prepare
syscall_enter_from_user_mode_work
syscall_exit_to_user_mode

syscall_enter_from_user_mode_work -> __syscall_enter_from_user_work -> syscall_trace_enter
```

看下这个函数syscall_trace_enter:
```c

    44 static long syscall_trace_enter(struct pt_regs *regs, long syscall,
    45 ¦   ¦   ¦   ¦   unsigned long ti_work)
-   46 {
|   47 ¦   long ret = 0;
|   48 
|   49 ¦   /* Handle ptrace */
|-  50 ¦   if (ti_work & (_TIF_SYSCALL_TRACE | _TIF_SYSCALL_EMU)) {                                                                                                                                                                                                             
||  51 ¦   ¦   ret = arch_syscall_enter_tracehook(regs);
||  52 ¦   ¦   if (ret || (ti_work & _TIF_SYSCALL_EMU))
||  53 ¦   ¦   ¦   return -1L;
||  54 ¦   }
|   55 
|   56 ¦   /* Do seccomp after ptrace, to catch any tracer changes. */
|-  57 ¦   if (ti_work & _TIF_SECCOMP) {
||  58 ¦   ¦   ret = __secure_computing(NULL);
||  59 ¦   ¦   if (ret == -1L)
||  60 ¦   ¦   ¦   return ret;
||  61 ¦   }
|   62 
|   63 ¦   /* Either of the above might have changed the syscall number */
|   64 ¦   syscall = syscall_get_nr(current, regs);
|   65 
|   66 ¦   if (unlikely(ti_work & _TIF_SYSCALL_TRACEPOINT))
|   67 ¦   ¦   trace_sys_enter(regs, syscall);
|   68 
|   69 ¦   syscall_enter_audit(regs, syscall);
|   70 
|   71 ¦   return ret ? : syscall;
|   72 }
```

这里有检测_TIF_SYSCALL_TRACE这个标志位，这个标志位的设置就是ptrace(PTRACE_SYSCALL, ...)请求设置的，
这个请求标志位是在这里设置的：kernel/ptrace.c : ptrace_request函数中，

```c
case PTRACE_SYSCALL:
case PTRACE_CONT:
       return ptrace_resume(child, request, data)
```



ptrace_resume函数内部会判断ptrace request，发现是PTRACE_SYSCALL，就调用以下方法设置该标志位。

```c
set_tsk_thread_flag(child, TIF_SYSCALL_TRACE)
```



好，下面我们再看下这个ptrace_report_syscall函数如何上报系统调用信息的：

```c
-   54 /*
|   55  * ptrace report for syscall entry and exit looks identical.
|   56  */
    57 static inline int ptrace_report_syscall(struct pt_regs *regs,
    58 ¦   ¦   ¦   ¦   ¦   unsigned long message)
-   59 {
|   60 ¦   int ptrace = current->ptrace;
|   61 
|   62 ¦   if (!(ptrace & PT_PTRACED))
|   63 ¦   ¦   return 0;
|   64 
|   65 ¦   current->ptrace_message = message;
|   66 ¦   ptrace_notify(SIGTRAP | ((ptrace & PT_TRACESYSGOOD) ? 0x80 : 0));                                                                                                                                                                                                    
|   67 
|-  68 ¦   /*
||  69 ¦    * this isn't the same as continuing with a signal, but it will do
||  70 ¦    * for normal use.  strace only continues with a signal if the
||  71 ¦    * stopping signal is not SIGTRAP.  -brl
||  72 ¦    */
|-  73 ¦   if (current->exit_code) {
||  74 ¦   ¦   send_sig(current->exit_code, current, 1);
||  75 ¦   ¦   current->exit_code = 0;
||  76 ¦   }
|   77 
|   78 ¦   current->ptrace_message = 0;
|   79 ¦   return fatal_signal_pending(current);
|   80 }

```

也就是说进行系统调用的时候会走到这个函数来，这个函数会进行ptrace报告，给被跟踪进程发送一个SIGTRAP信号，被跟踪进程停下来，此时tracer就可以检查系统调用被中断时保存的上下文信息，通过这个上下文信息就可以知道被跟踪进程系统调用的名称及参数信息。