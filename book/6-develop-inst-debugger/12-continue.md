## 执行控制：`continue` 运行到下个断点

### 实现目标：continue运行到下个断点

假定当前tracee处于被调试跟踪、暂停执行状态，如果要运行到下个断点处，应该如何做呢？detach之后，被跟踪的tracee会自动恢复执行，但我们肯定要继续跟踪。

操作系统提供了 `ptrace(PTRACE_CONT,...)` 操作，允许我们恢复tracee执行，此时的tracee仍然被tracer跟踪。当tracee运行到下个断点处时，执行0xCC触发3号中断#BP，内核生成SIGTRAP给tracee，进入信号处理逻辑，暂停tracee并唤醒tracer。

在执行恢复操作前，需要检查当前 `PC-1` 地址处是否是我们添加的断点，如果是则需要将其替换为原始指令数据，并回退PC (PC=PC-1)，确保tracee能够正确执行后续指令。

### 代码实现

continue命令的执行流程如下：

1. 检查当前PC-1处数据是否为0xCC，如果是则说明该处是被patch的断点指令
2. 将断点位置的数据还原为原始指令，并将PC回退1
3. 执行 `ptrace(PTRACE_CONT, ...)` 操作请求操作系统恢复tracee执行
4. 通过 `syscall.Wait4(...)` 等待tracee停下来
5. 当tracee运行到断点处时，会重新触发int3中断，tracer被唤醒后获取寄存器信息

注意：当前PC值是执行了0xCC指令之后的地址值，因此 PC=断点地址+1。

**file: cmd/debug/continue.go**

```go
package debug

import (
	"fmt"
	"syscall"

	"github.com/spf13/cobra"
)

var continueCmd = &cobra.Command{
	Use:   "continue",
	Short: "运行到下个断点",
	Annotations: map[string]string{
		cmdGroupKey: cmdGroupCtrlFlow,
	},
	Aliases: []string{"c"},
	RunE: func(cmd *cobra.Command, args []string) error {
		fmt.Println("continue")

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

		err = syscall.PtraceCont(TraceePID, 0)
		if err != nil {
			return fmt.Errorf("single step error: %v", err)
		}

		// 发起了对tracee执行控制的ptrace请求后，要调用syscall.Wait等待并获取tracee状态变化
		var wstatus syscall.WaitStatus
		var rusage syscall.Rusage
		_, err = syscall.Wait4(TraceePID, &wstatus, syscall.WSTOPPED, &rusage)
		if err != nil {
			return fmt.Errorf("wait error: %v", err)
		}

		// display current pc
		regs = syscall.PtraceRegs{}
		err = syscall.PtraceGetRegs(TraceePID, &regs)
		if err != nil {
			return fmt.Errorf("get regs error: %v", err)
		}
		fmt.Printf("continue ok, current PC: %#x\n", regs.PC())
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(continueCmd)
}
```

上述代码基于cmd/debug/step.go修改实现，详见源文件cmd/debug/continue.go。

> 注：上述代码来自 [hitzhangjie/godbg](https://github.com/hitzhangjie/godbg) 项目。另外在 [hitzhangjie/golang-debuger-lessons](https://github.com/hitzhangjie/golang-debugger-lessons) /12_continue 下提供了独立的continue执行示例，可单独测试修改。

### 代码测试

测试步骤如下：

1. 启动一个进程，获取其pid
2. 通过 `godbg attach <pid>` 对目标进程进行调试
3. 调试会话就绪后，输入 `dis`（disass命令的别名）进行反汇编
4. 选择合适的指令地址添加断点
5. 执行continue命令运行到断点

注意：添加断点时要考虑代码执行时的分支控制逻辑，确保断点位于实际的执行路径上，否则可能无法验证continue运行到断点的功能。

为了验证运行到下个断点，我多次运行dis、step，直到发现有一段指令可以连续执行，中间没有什么跳转操作，如下图所示：

```bash
godbg> dis
...
godbg> dis
...
godbg> dis
0x42e2e0 cmp $-0x4,%eax                 ; 从这条语句开始执行
0x42e2e3 jne 0x24c
0x42e2e9 mov 0x20(%rsp),%eax
0x42e2ed test %eax,%eax                 ; 首字节被覆盖成0xCC，PC=0x42e2ed+1
0x42e2ef jle 0xffffffffffffffbe
0x42e2f1 movq $0x0,0x660(%rsp)
0x42e2fd mov 0x648(%rsp),%rbp
0x42e305 add $0x650,%rsp
0x42e30c retq
0x42e30d movq $0x0,0x30(%rsp)
godbg> 
```

然后我们尝试break添加断点、continue运行到断点：

```bash
godbg> b 0x42e2ed
break 0x42e2ed
添加断点成功
godbg> c
continue
continue ok, current PC: 0x42e2ee
```

我们在第4条指令 `0x42e2ed test %eax,%eax` 处添加断点，然后执行 `c`（continue的别名）运行到断点处。运行结果显示当前PC值为0x42e2ee=0x42e2ed+1，这是因为被调试进程在执行了0x42e2ed处的0xCC断点指令后才停下来，完全符合预期。

### 更多相关内容

continue命令对于符号级调试器至关重要。在源代码向汇编指令的转换过程中，一条源代码语句可能对应多条机器指令。当我们需要：

- 逐语句执行
- 进入、退出函数（函数有prologue、epilogue）
- 进入、退出循环体

实现上述源码级调试功能时，必须借助对源码及指令的理解，在正确的地址处设置断点，然后配合continue命令来实现。

我们将在符号级调试器一章中更详细地研究这些内容。

### 本节小结

本节主要探讨了调试器中continue命令的实现原理和具体实现，核心内容包括：通过`ptrace(PTRACE_CONT,...)`恢复tracee执行，并等待其运行到下一个断点或者执行结束；在恢复执行前需要检查并还原断点处的原始指令数据，同时调整PC寄存器值，以确保指令解码正常；使用`syscall.Wait4`等待tracee在断点处停止并获取其状态变化。本节重点强调了断点恢复机制的重要性——必须将0xCC断点指令还原为原始指令并回退PC，确保tracee能够正确执行后续指令。

这些底层机制为符号级调试器提供了基础支撑，使得调试器能够实现逐语句执行、函数进入退出等高级调试功能。本节内容为读者理解调试器的执行控制机制和后续学习符号级调试器打下了坚实的技术基础。

