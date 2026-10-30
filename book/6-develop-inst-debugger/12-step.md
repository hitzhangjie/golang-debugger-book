## 执行控制：逐指令执行

### 实现目标：`godbg> step` 逐指令执行

在实现了反汇编以及添加移除断点功能后，我们将开始进一步探索如何控制调试进程的执行，如step逐指令执行、continue运行到断点位置，在后面符号级调试器开发章节，我们还会实现next逐语句执行。

本节我们先实现 `step`命令来支持逐指令执行。

### 代码实现

逐指令执行，通过执行 `ptrace(PTRACE_SINGLESTEP,...)` 操作即可由内核代为完成。但是在上述操作执行之前，step命令还有些特殊因素要考虑方能正常执行。

此时的PC值有可能是越过了一个断点之后的地址，比如：

1. 一条经过指令patch后的多字节指令，首字节处修改为了0xCC，当前寄存器PC值实际上是该多字节指令的第二个字节的地址，而非首字节的地址。如果对PC值不做修改，处理器执行的时候从第二字节开始解码会解码失败，无法执行指令；
2. 一条单字节指令，如果我们直接decode下一个地址处的指令，还会漏掉断点处原来的一字节指令；

为了保证step正常执行，在 `ptrace(PTRACE_SINGLESTEP,...)` 之前，先检查 `PC-1` 处是否为我们添加的断点：不是断点就直接单步；是断点则先还原该处的原始指令，再把 PC 回退到 `PC-1`，单步执行完原指令后重新把断点加回去。

**file：cmd/debug/step.go**

```go
package debug

import (
	"fmt"

	"github.com/hitzhangjie/godbgv2/pkg/service/api"
	"github.com/spf13/cobra"
)

var stepCmd = &cobra.Command{
	Use:     "step",
	Short:   "执行一条指令",
	Aliases: []string{"s"},
	Annotations: map[string]string{
		cmdGroupAnnotation: cmdGroupCtrlFlow,
	},
	RunE: func(cmd *cobra.Command, args []string) (err error) {

		defer func() {
			if err != nil {
				return
			}
			// 展示步进后的当前 PC
			regs, err := Client.ReadRegs()
			if err != nil {
				fmt.Printf("get regs error: %v\n", err)
				return
			}
			fmt.Printf("single step ok, current PC: %#x\n", regs.PC())
		}()

		// 读取当前 PC
		regs, err := Client.ReadRegs()
		if err != nil {
			return fmt.Errorf("get regs error: %v", err)
		}

		// PC-1 处不是断点：直接单步执行
		addr := regs.PC() - 1
		if err := Client.RestoreInstruction(addr); err != nil {
			if err == api.ErrBreakpointNotExisted {
				if err := Client.Step(); err != nil {
					return fmt.Errorf("single step error: %v", err)
				}
				return nil
			}
			// 调试器内部错误
			return fmt.Errorf("clear breakpoint err: %v", err)
		}

		// PC-1 处是断点：还原断点指令 → 回退 PC → 单步 → 重新添加断点
		defer Client.AddBreakpoint(addr)

		regs.SetPC(addr)
		if err = Client.WriteRegs(regs); err != nil {
			return fmt.Errorf("write regs error: %v", err)
		}

		if err := Client.Step(); err != nil {
			return fmt.Errorf("single step error: %v", err)
		}
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(stepCmd)
}
```

命令层统一经 `api.Client` 调用底层能力：`RestoreInstruction(addr)` 在 `addr` 处没有断点时返回 `api.ErrBreakpointNotExisted`，命令层据此区分“PC-1 不是断点”和“调试器内部错误”；`ReadRegs`、`WriteRegs` 负责读写寄存器，`api.Registers` 提供 `PC()`、`SetPC()` 读写指令指针。`Client.Step()` 由 `debugger` 门面转发到 `pkg/target` 的 `SingleStep`，由它发起 `ptrace(PTRACE_SINGLESTEP,...)` 并等待 tracee 状态变化：

**file：pkg/target/step.go**

```go
package target

import (
	"fmt"
	"syscall"
)

// SingleStep 让指定线程执行一条机器指令。
//
// MUST: 当发起了某些对 tracee 执行控制的 ptrace request 之后，要调用
// syscall.Wait 等待并获取 tracee 状态变化。
func (p *DebuggedProcess) SingleStep(pid int) (*syscall.WaitStatus, error) {
	err := p.ExecPtrace(func() error {
		return syscall.PtraceSingleStep(pid)
	})
	if err != nil {
		return nil, err
	}

	var (
		wstatus syscall.WaitStatus
		rusage  syscall.Rusage
	)
	_, err = syscall.Wait4(pid, &wstatus, syscall.WALL, &rusage)
	if err != nil {
		return nil, fmt.Errorf("wait error: %v", err)
	}

	return &wstatus, nil
}
```

以上就是step命令及相关底层实现的代码，但这并不是一个十分友好的实现：

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

> ps：上述代码取自 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.12`。为了让正文聚焦在 step 的流程上，这里只展开了命令层和单步执行的底层实现；寄存器读写、`api.Client` 接口和 `debugger` 门面的改动属于配套的支撑代码。

### 代码测试

测试对象是 godbgv2 自带的 `_fixtures/loop`，它每秒打印一次 pid 和循环计数，程序入口固定为 `0x478120`（Makefile 固定了构建所用的 Go 工具链版本）。切到本节代码并构建：

```bash
$ git checkout ch6.12
$ make build
$ make fixtures
```

先用 `exec` 启动 target，停在入口时连续执行 `step`：

```bash
$ ./godbg exec _fixtures/loop
process 2249900 launched, stopped by SIGTRAP
godbg> step
single step ok, current PC: 0x4749e0
godbg> step
single step ok, current PC: 0x4749e4
godbg> step
single step ok, current PC: 0x4749e9
godbg> exit
tracee is run by tracer, kill it
```

启动后 PC 停在程序入口 `0x478120`，入口第一条指令是一条跳转指令，执行后 PC 变成 `0x4749e0`（`_rt0_amd64`）；之后每执行一条指令，PC 依次推进到 `0x4749e4`、`0x4749e9`。这条路径上 `PC-1` 都不是断点，`step` 直接调用 `PTRACE_SINGLESTEP` 单步执行。

再看 `PC-1` 恰好是断点的情况。重新启动 target，在入口地址下断点，然后连续 `step`：

```bash
$ ./godbg exec _fixtures/loop
process 2249926 launched, stopped by SIGTRAP
godbg> break 0x478120
breakpoint 1 added at 0x478120
godbg> step
single step ok, current PC: 0x478121
godbg> step
single step ok, current PC: 0x4749e0
godbg> step
single step ok, current PC: 0x4749e4
```

第一次 `step` 时 PC 还是 `0x478120`，`PC-1` 不是断点，于是直接单步；但入口首字节已经被断点改写成 `0xCC`，所以实际执行的是 `int3`，PC 前进到 `0x478121`。

第二次 `step` 时 `PC-1=0x478120` 命中断点，`step` 先还原原始指令、把 PC 回退到 `0x478120`，再单步执行原来的跳转指令，PC 落到 `0x4749e0`，最后重新把断点加回去。第三次 `step` 与前面的普通步进相同，PC 推进到 `0x4749e4`。

不禁要问，执行系统调用 `ptrace(PTRACE_SINGLESTEP,...)` 时，内核是如何实现逐指令执行的？只执行一条机器指令后立即停下来，有点奇妙！

### 更多相关内容：SINGLESTEP

内核是如何处理PTRACE_SINGLESTEP请求的呢？SINGLESTEP确实比较特殊，在man(2)手册里面并没有找到太多有价值的信息：

```bash
$ man 2 ptrace
------------------------------------------------------------------

NAME
       ptrace - process trace

SYNOPSIS
       #include <sys/ptrace.h>
       long ptrace(enum __ptrace_request request, pid_t pid,
                   void *addr, void *data);
Description
    ...
    PTRACE_SINGLESTEP stops
        [Details of these kinds of stops are yet to be documented.]
```

man(2)手册里面没有太多有价值的相关信息，查看内核源码以及Intel开发手册之后，可以了解到这方面的细节。

1. SINGLESTEP调试在Intel平台上是借助了处理器自身硬件特性来实现的，参考《Intel® 64 and IA-32 Architectures Software Developer's Manual Volume 1: Basic Architecture》，Intel架构处理器是有一个标识寄存器EFLAGS，当通过内核将标志寄存器的TF标志置为1时，处理器会自动进入单步执行模式，清0退出单步执行模式。

   > **System Flags and IOPL Field**
   >
   > The system flags and IOPL field in the **EFLAGS** register control operating-system or executive operations. **They should not be modified by application programs.** The functions of the system flags are as follows:
   >
   > **TF (bit 8) Trap flag** — Set to enable single-step mode for debugging; clear to disable single-step mode.
   >
2. 我们执行系统调用 `syscall.PtraceSingleStep(...)` 时，实际上是 `ptrace(PTRACE_SINGLESTEP, pid...)` ，此时内核会将被跟踪的tracee的task_struct中的寄存器部分的flags设置为flags |= TRAP，然后调度tracee执行。
3. 调度器执行tracee时会先将其进程控制块task_struct中的硬件上下文信息还原到处理器寄存器中，然后再执行对应tracee的指令。此时处理器发现EFLAGS.TF=1，进入单步执行模式。处理器执行单条指令，执行完成后处理器会自动生成一个陷阱中断，然后重置该标志位。这里的陷阱中断是type-1中断 (中断1是调试异常#DB，中断3是断点异常#BP)。

   > **Single-step interrupt**
   > When a system is instructed to single-step, it will execute one instruction and then stop.
   > ...
   > The Intel 8086 trap flag and type-1 interrupt response make it quite easy to implement a single-step feature in an 8086-based system. If the trap flag is set, the 8086 will automatically do a type-1 interrupt after each instruction executes. When the 8086 does a type-1 interrupt, ...
   > The trap flag is reset when the 8086 does a type-1 interrupt, so the single-step mode will be disabled during the interrupt-service procedure.
   >
4. 内核中断服务程序负责处理这个中断(中断1，#DB异常），会像处理中断3#BP异常时那样，给tracee发送SIGTRAP，信号处理时进而会暂停tracee调度，然后通过SIGCHLD、__wake_up_parent唤醒tracer，以这种方式通知调试器tracer，“嘿，tracee已经单步执行了一条指令，并且已经停下来等待接收后续调试命令了”。

ps：这就是Intel平台下单步执行的一些细节信息，读者如果对其他硬件平台感兴趣，也可以自行了解下它们是如何设计实现来解决单步调试问题的。

### 本节小结

本节主要探讨了调试器中step逐指令执行功能的实现原理与具体实现，核心内容包括：通过ptrace(PTRACE_SINGLESTEP)系统调用实现单步执行；处理断点恢复的特殊情况，确保PC值正确性；理解Intel平台下基于EFLAGS.TF标志位的硬件单步执行机制。

本节内容为读者深入理解调试器执行控制机制以及后续实现continue、next等高级调试命令奠定了重要基础。
