## 软件动态断点：`clearall` 移除全部断点

### 实现目标：清空断点

`clearall`命令的功能是为了快速移除所有断点，而不用通过 `clear -n <breakNo>`逐个删除断点，适合添加了很多断点想快速清理的场景。

### 代码实现

`clearall`的实现逻辑，和 `clear`逻辑差不多，相比较之下处理逻辑更简单点。

> clearall  操作实现比较简单，我们没有在 [hitzhangjie/golang-debug-lessons](https://github.com/hitzhangjie/golang-debug-lessons) 中单独提供示例目录，而是在 [hitzhangjie/godbg](https://github.com/hitzhangjie/godbg) 中进行了实现，读者可以查看 godbg 的源码。
>
> TODO 代码示例可以优化一下, see: [issue #15](https://github.com/hitzhangjie/golang-debugger-book/issues/15)

**file: cmd/debug/clearall.go**

```go
package debug

import (
    "fmt"
    "syscall"

    "godbg/target"

    "github.com/spf13/cobra"
)

var clearallCmd = &cobra.Command{
    Use:   "clearall <n>",
    Short: "清除所有的断点",
    Long:  `清除所有的断点`,
    Annotations: map[string]string{
        cmdGroupKey: cmdGroupBreakpoints,
    },
    RunE: func(cmd *cobra.Command, args []string) error {
        fmt.Println("clearall")

        for _, brk := range breakpoints {
            n, err := syscall.PtracePokeData(TraceePID, brk.Addr, []byte{brk.Orig})
            if err != nil || n != 1 {
                return fmt.Errorf("清空断点失败: %v", err)
            }
        }

        breakpoints = map[uintptr]*target.Breakpoint{}

        ...

        fmt.Println("清空断点成功")
        return nil
    },
}

func init() {
    debugRootCmd.AddCommand(clearallCmd)
}
```

### 代码测试

首先运行一个待调试程序，获取其pid，然后通过 `godbg attach <pid>`调试目标进程，首先通过命令 `disass`显示汇编指令列表，然后执行 `b <locspec>`命令添加几个断点。

```bash
godbg> b 0x4653af
break 0x4653af
添加断点成功
godbg> b 0x4653b6
break 0x4653b6
添加断点成功
godbg> b 0x4653c2
break 0x4653c2
添加断点成功
```

这里我们执行了3次断点添加操作，`breakpoints`可以看到添加的断点列表：

```bash
godbg> breakpoints
breakpoint[1] 0x4653af 
breakpoint[2] 0x4653b6 
breakpoint[3] 0x4653c2 
```

然后我们执行 `clearall`清空所有断点：

```bash
godbg> clearall
clearall 
清空断点成功
```

接下来再次执行 `breakpoints`查看剩余的断点：

```bash
godbg> bs
godbg> 
```

现在已经没有剩余断点了，我们的添加、清空断点的功能是正常的。

OK ，截止到现在，我们已经实现了添加断点、列出断点、删除指定断点、清空断点的功能，但是我们还没有演示过断点的效果（执行到断点处停下来）。接下来我们就将实现step（执行1条指令）、continue（运行到断点处）操作。

### 思考：仅还原指令数据就可以吗？

与clear命令类似，清理断点只还原指令数据仅仅算完成了第一步，还需要将停在这些断点处的线程的pc--。clearall由于是移除所有断点，受影响的线程数量比clear移除单个断点影响的线程数量要更多，所以更要注意处理。否则很可能clearall执行一次，后续就没法进行调试了，因为各个线程执行时的机器指令CPU已经无法正常译码了。

godbg中修改后的clearall命令实现，如下所示，您也可以查看 [hitzhangjie/godbg]：

```go
var clearallCmd = &cobra.Command{
	Use:   "clearall",
	Short: "清除所有的断点",
	Long:  `清除所有的断点`,
	Annotations: map[string]string{
		cmdGroupAnnotation: cmdGroupBreakpoints,
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		//fmt.Println("clearall")
		if err := target.DBPProcess.ClearAll(); err != nil {
			return fmt.Errorf("清除断点失败: %v", err)
		}

		fmt.Println("清空断点成功")
		return nil
	},
}

// ClearAll 删除所有已添加的断点
func (p *DebuggedProcess) ClearAll() error {
	// 首先检查所有线程是否停在断点处
	stopped, err := p.ThreadStoppedAtBreakpoint()
	if err != nil {
		return fmt.Errorf("check thread breakpoints error: %v", err)
	}

	for _, bp := range p.Breakpoints {
		if _, err := p.RestoreInstruction(bp.Addr); err != nil {
			return fmt.Errorf("clear breakpoint at %#x error: %v", bp.Addr, err)
		}
	}

	// 如果有线程停在断点处，需要先处理这些线程
	// 回退所有停在断点的线程的PC
	for tid := range stopped {
		regs, err := p.ReadRegister(tid)
		if err != nil {
			return fmt.Errorf("read register for thread %d: %v", tid, err)
		}

		// 回退PC到断点指令之前
		regs.SetPC(regs.PC() - 1)
		if err = p.WriteRegister(tid, regs); err != nil {
			return fmt.Errorf("write register for thread %d: %v", tid, err)
		}
	}

	return nil
}
```

### 思考：如果tracer退出前不清理断点？

思考一个问题，tracer添加、移除断点都是通过ptrace系统调用对进程指令进行patch，那么如果tracer退出前不主动清除过去添加过的断点会怎样？我们将在[调试器退出前的断点清理机制](./10-clearall-atexit.md)这一节中进行详细介绍。

### 本节小结

本节主要探讨了调试器中`clearall`命令的实现，核心内容包括：**批量断点清理机制**；**ptrace系统调用的断点恢复操作**。本节内容为读者学习后续的断点执行控制（step、continue）打下了基础。

本节核心要点包括：

- `clearall`命令通过遍历全局断点映射，使用`PtracePokeData`恢复原始指令字节，实现所有断点的批量清理
- 相比`clear`命令的单个删除，`clearall`提供了更高效的断点管理方式，适合调试过程中需要快速重置断点状态的场景

掌握了断点的添加、删除和清理后，接下来我们将学习如何让程序在断点处停下来，实现真正的断点调试功能。
