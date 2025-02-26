## 控制进程执行

### 实现目标：continue运行到下个断点

运行到下个断点处，就是让tracee正常执行后续指令，直到命中并执行完下一个被0xCC patch的指令后触发int3中断，然后内核中断服务将tracee暂停执行。

具体怎么实现呢？操作系统提供了 `ptrace(PTRACE_COND,...)` 操作，允许我们直接运行到下个断点处。但是在执行上述调用前，同样要检查下当前 `PC-1 `地址处的数据是否为 `0xCC`，如果是则需要将其替换为原始指令数据。

### 代码实现

continue命令执行时，首先检查当前PC-1处数据是否为0xCC，如果是则说明PC-1处是一个被patch的指令（可能是单字节指令，也可能是多字节指令）。需要将断点位置的数据，还原回patched之前的原始数据。然后将 PC=PC-1，再执行 `ptrace(PTRACE_COND, ...)` 操作请求操作系统恢复tracee执行，让tracee运行到断点处停下来。运行到断点处后又会重新触发int3中断停下来，然后tracee状态变化又会通知到tracer。

最后，我们tracer通过 `syscall.Wait4(...)` 等待tracee停下来，然后再检查下其寄存器信息，这里我们先只获取PC值。注意当前PC值是执行了0xCC指令之后的地址值，因此 PC=断点地址+1。

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
		fmt.Printf("continue ok, current PC: %#x\n", regs.PC())
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(continueCmd)
}
```

在cmd/debug/step.go的基础上简单修改下就可以实现continue操作，详见源文件cmd/debug/continue.go。

> ps：上述代码是 [hitzhangjie/godbg](https://github.com/hitzhangjie/godbg) 中的实现，我们重点介绍了step的实现。另外在 [hitzhangjie/golang-debuger-lessons](https://github.com/hitzhangjie/golang-debugger-lessons) /11_continue 下，我们也提供了一个continue执行的示例，只有一个源文件，与其他demo互不影响，您也可以按照你的想法修改测试下，不用担心改坏整个 godbg的问题。

### 代码测试

首先启动一个进程，获取其pid，然后通过 `godbg attach <pid>`对目标进程进行调试，等调试会话就绪后，我们输入 `dis`（dis是disass命令的别名）进行反汇编。

要验证continue命令的功能，首先要dis反汇编查看指令地址，然后再break添加断点，然后再continue运行到断点。

需要注意的是，添加断点时要简单看下汇编指令的含义，因为考虑到代码执行时的分支控制逻辑，我们添加的断点并不一定在代码实际的执行路径上，所以可能不能验证continue运行到断点的功能（但是仍然可以验证运行到进程执行结束）。

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

我们在第4条指令 `0x42e2ed test %eax,%eax`处添加断点，断点添加成功后，我们执行 `c`(c是continue的别名）来运行到断点处。运行到断点之后，输出当前的PC值，前面有分析过，PC=0x42e2ee=0x42e2ed+1，因为被调试进程是在执行了0x42e2ed处的指令 `0xCC`才停下来的，完全符合预期。

### 更多相关内容

continue命令有多重要？相当重要，特别是对于符号级调试器而言。

源代码向汇编指令的转换过程中，一条源代码语句可能对应着多条机器指令，当我们：

- 逐语句执行时；
- 进入、退出一个函数时（函数有prologue、epilogue）；
- 进入、退出一个循环体时；
- 等等；

要实现上述源码级调试就必须要借助对源码及指令的理解，恰到好处的在正确的地址处设置断点，然后配合continue来实现。

我们将在符号级调试器一章中更详细地研究这些内容。
