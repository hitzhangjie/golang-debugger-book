## 控制进程执行

### 实现目标：step逐指令执行

在实现了反汇编以及添加移除断点功能后，我们将开始进一步探索如何控制调试进程的执行，如step逐指令执行、continue运行到断点位置，在后面符号级调试器开发章节，我们还会实现next逐语句执行。

本节我们先实现 `step`命令来支持逐指令执行。

### 代码实现

逐指令执行，通过执行 `ptrace(PTRACE_SINGLESTEP,...)` 操作即可由内核代为完成。但是在上述操作执行之前，step命令还有些特殊因素要考虑方能正常执行。

此时的PC值有可能是越过了一个断点之后的地址，比如：

1. 一条经过指令patch后的多字节指令，首字节处修改为了0xCC，当前寄存器PC值实际上是该多字节指令的第二个字节的地址，而非首字节的地址。如果对PC值不做修改，处理器执行的时候从第二字节开始解码会解码失败，无法执行指令；
2. 一条单字节指令，如果我们直接decode下一个地址处的指令，还会漏掉断点处原来的一字节指令；

为了保证step正常执行，在 `ptrace(PTRACE_SINGLESTEP,...) ` 之前，需要首先通过 `ptrace(PTRACE_PEEKTEXT,...)` 去读取 `PC-1` 地址处的数据，如果是0xCC，则表明此处为一个断点，需要将添加断点前的原始数据还原、PC=PC-1，然后再继续执行。

**file：cmd/debug/step.go**

```go
package debug

import (
	"fmt"
	"syscall"

	"github.com/spf13/cobra"
)

var stepCmd = &cobra.Command{
	Use:   "step",
	Short: "执行一条指令",
	Annotations: map[string]string{
		cmdGroupKey: cmdGroupCtrlFlow,
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		fmt.Println("step")

		// 读取PC值
		regs := syscall.PtraceRegs{}
		err := syscall.PtraceGetRegs(TraceePID, &regs)
		if err != nil {
			return fmt.Errorf("get regs error: %v", err)
		}

		buf := make([]byte, 1)
		n, err := syscall.PtracePeekText(TraceePID, uintptr(regs.PC()-1), buf)
		if err != nil || n != 1 {
			return fmt.Errorf("peek text error: %v, bytes: %d", err, n)
		}

		// read a breakpoint
		if buf[0] == 0xCC {
			regs.SetPC(regs.PC() - 1)
			// TODO refactor breakpoint.Disable()/Enable() methods
			orig := breakpoints[uintptr(regs.PC())].Orig
			n, err := syscall.PtracePokeText(TraceePID, uintptr(regs.PC()), []byte{orig})
			if err != nil || n != 1 {
				return fmt.Errorf("poke text error: %v, bytes: %d", err, n)
			}
		}

		err = syscall.PtraceSingleStep(TraceePID)
		if err != nil {
			return fmt.Errorf("single step error: %v", err)
		}

		// MUST: 当发起了某些对tracee执行控制的ptrace request之后，要调用syscall.Wait等待并获取tracee状态变化
		var wstatus syscall.WaitStatus
		var rusage syscall.Rusage
		_, err = syscall.Wait4(TraceePID, &wstatus, syscall.WALL, &rusage)
		if err != nil {
			return fmt.Errorf("wait error: %v", err)
		}

		// display current pc
		regs = syscall.PtraceRegs{}
		err = syscall.PtraceGetRegs(TraceePID, &regs)
		if err != nil {
			return fmt.Errorf("get regs error: %v", err)
		}
		fmt.Printf("single step ok, current PC: %#x\n", regs.PC())
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(stepCmd)
}

```

以上就是step命令的实现代码，但这并不是一个十分友好的实现：

- 它确实实现了逐指令执行，完成了本节目标；
- 每逐指令执行之后，它还能打印当前寄存器PC值，方便我们确定下条待执行指令地址；

美中不足的是，没有将当前待执行指令的前后指令打印出来，并通过箭头指示下条待执行指令，一种更好的交互可能是这样：

```
godbg> step

=> 地址1 汇编指令1
   地址2 汇编指令2
   地址3 汇编指令3
   ...
```

这里会影响到调试体验，我们将在后续过程中予以完善。

> ps：上述代码是 [hitzhangjie/godbg](https://github.com/hitzhangjie/godbg) 中的实现，我们重点介绍了step的实现。另外在 [hitzhangjie/golang-debuger-lessons](https://github.com/hitzhangjie/golang-debugger-lessons) /10_step 下，我们也提供了一个step执行的示例，只有一个源文件，与其他demo互不影响，您也可以按照你的想法修改测试下，不用担心改坏整个 godbg的问题。

### 代码测试

启动一个程序，获取其进程pid，然后执行 `godbg attach <pid>`对进程进行调试，等调试会话就绪之后，我们输入 `disass`反汇编看下当前指令地址之后的汇编指令有哪些。

```bash
godbg> disass
0x40ab47 movb $0x0,0x115(%rdx)
0x40ab4e mov 0x18(%rsp),%rcx
0x40ab53 mov 0x38(%rsp),%rdx
0x40ab58 mov (%rdx),%ebx
0x40ab5a test %ebx,%ebx
0x40ab5c jne 0x4c
0x40ab5e mov 0x30(%rax),%rbx
0x40ab62 movb $0x1,0x115(%rbx)
0x40ab69 mov %rdx,(%rsp)
0x40ab6d movl $0x0,0x8(%rsp)
```

然后尝试执行 `step` 命令，观察输出情况。

```bash
godbg> step
step
single step ok, current PC: 0x40ab4e
godbg> step
step
single step ok, current PC: 0x40ab53
godbg> step
step
single step ok, current PC: 0x40ab58
godbg> 
```

我们执行了step指令3次，step每次执行一条指令之后，会输出执行指令后的PC值，依次是0x40ab4e、0x40ab53、0x40ab58，依次是下条指令的首地址。

不禁要问，执行系统调用 `ptrace(PTRACE_SINGLESTEP,...)` 时，内核是如何实现逐指令执行的？显然它没有采用指令patch的方式（如果也是指令patch的方式，上述step命令输出的PC值应该是在当前显示的值基础上分别+1）。

### 更多相关内容：SINGLESTEP

那内核是如何处理PTRACE_SINGLESTEP请求的呢？SINGLESTEP确实比较特殊，在man(2)手册里面并没有找到太多有价值的信息：

```bash
   PTRACE_SINGLESTEP stops
       [Details of these kinds of stops are yet to be documented.]
```

man(2)手册里面没有太多有价值的相关信息，查看内核源码以及Intel开发手册之后，可以了解到这方面的细节。

1. SINGLESTEP调试在Intel平台上部分借助了处理器自身硬件特性来实现的，参考《Intel® 64 and IA-32 Architectures Software Developer's Manual Volume 1: Basic Architecture》，Intel架构处理器是有一个标识寄存器EFLAGS，当通过内核将标志寄存器的TF标志置为1时，处理器会自动进入单步执行模式，清0退出单步执行模式。

   > **System Flags and IOPL Field**
   >
   > The system flags and IOPL field in the **EFLAGS** register control operating-system or executive operations. **They should not be modified by application programs.** The functions of the system flags are as follows:
   >
   > **TF (bit 8) Trap flag** — Set to enable single-step mode for debugging; clear to disable single-step mode.
   >
2. 我们执行系统调用 `syscall.PtraceSingleStep(...)` 时，实际上是 `ptrace(PTRACE_SINGLESTEP, pid...)` ，此时内核会将被跟踪的tracee的task_struct中的寄存器部分的flags设置为flags |= TRAP，然后调度tracee执行。
3. 调度器执行tracee时会先将其进程控制块task_struct中的硬件上下文信息还原到处理器寄存器中，然后再执行对应tracee的指令。此时处理器发现EFLAGS.TF=1，执行指令的时候就会先清空该标志位，然后执行单条指令，执行完成后处理器会自动生成一个陷阱中断，不需要软件层面模拟。

   > **Single-step interrupt**
   > When a system is instructed to single-step, it will execute one instruction and then stop.
   > ...
   > The Intel 8086 trap flag and type-1 interrupt response make it quite easy to implement a single-step feature in an 8086-based system. If the trap flag is set, the 8086 will automatically do a type-1 interrupt after each instruction executes. When the 8086 does a type-1 interrupt, ...
   > The trap flag is reset when the 8086 does a type-1 interrupt, so the single-step mode will be disabled during the interrupt-service procedure.
   >
4. 内核中断服务程序负责处理这个TRAP，其实就是继续暂停tracee调度（此时也会保存下硬件上下文信息），然后内核会给tracer发送SIGTRAP信号，以这种方式通知调试器tracer你跟踪的tracee已经单步执行了一条指令后停下来等待接收后续调试命令了。

这就是Intel平台下单步执行的一些细节信息，读者如果对其他硬件平台感兴趣，也可以自行了解下它们是如何设计实现来解决单步调试问题的。
