## 动态断点

### 实现目标：清空断点

`clearall`命令的功能是为了快速移除所有断点，而不用通过 `clear -n <breakNo>`逐个删除断点，适合添加了很多断点想快速清理的场景。

### 代码实现

`clearall`的实现逻辑，和 `clear`逻辑差不多，相比较之下处理逻辑更简单点。

> clearall  操作实现比较简单，我们没有在 [hitzhangjie/golang-debug-lessons](https://github.com/hitzhangjie/golang-debug-lessons) 中单独提供示例目录，而是在 [hitzhangjie/godbg](https://github.com/hitzhangjie/godbg) 中进行了实现，读者可以查看 godbg 的源码。
>
> TODO 代码示例可以优化一下, see: https://github.com/hitzhangjie/golang-debugger-book/issues/15

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
