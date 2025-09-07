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

### 思考：退出前清理所有断点？

有些tracee是调试器自动编译并运行的新进程，或者运行一个编译好的二进制程序创建的进程，也有的是通过attach到一个已经在运行的进程。我们只考虑最后这种情景，这种情况下，一般调试器退出时，可能还需要保持这个程序继续运行。

前一小节我们提到了如果tracer退出前不主动清理断点，那么将会给tracee造成比较坏的影响，尤其是tracee还需要继续运行的话。那怎么办呢？其实也简单，我们可以给我们前面介绍的debugsession加一个能力，加一个atexit的功能，即当调试器准备退出时，我们的调试会话也会随之销毁，我们可以在销毁时执行一些用户创建会话时指定的函数，这里面就包含清理断点的函数。

ps：如果你了解c库函数atexit的话，对这个功能你一定不会感到陌生。

将来我们可以这样启动调试会话，注意通过AtExit注册了一个退出前的回调函数cleanup：

```go
session := debug.NewDebugSession().AtExit(Cleanup)
session.Start()

func (s *DebugSession) AtExit(fn func()) *DebugSession {
    s.defers = append(s.defers, fn)
    return s
}
```

启动调试方法中，会将注册的cleanup函数作为defer函数执行：

```go
func (s *DebugSession) Start() {
    s.liner.SetCompleter(completer)
    s.liner.SetTabCompletionStyle(liner.TabPrints)

    defer func() {
        for idx := len(s.defers) - 1; idx >= 0; idx-- {
            s.defers[idx]()
        }
    }()
    ...
}
```

这里的cleanup函数就是遍历并删除所有断点的操作，与这里的clearall命令实现无异。当调试会话销毁后，tracer再调用ptrace detach操作结束对tracee的调试跟踪，完美退出！

### 本节小结

本节主要探讨了调试器中`clearall`命令的实现，核心内容包括：**批量断点清理机制**；**ptrace系统调用的断点恢复操作**；**调试会话退出前的资源清理策略**。本节内容为读者学习后续的断点执行控制（step、continue）打下了基础。

本节核心要点包括：

- `clearall`命令通过遍历全局断点映射，使用`PtracePokeData`恢复原始指令字节，实现所有断点的批量清理
- 相比`clear`命令的单个删除，`clearall`提供了更高效的断点管理方式，适合调试过程中需要快速重置断点状态的场景
- 提出了调试会话退出前的资源清理机制，需要合理利用go defer机制来实现AtExit，通过`AtExit`回调函数确保tracee进程在调试器退出后能正常运行

掌握了断点的添加、删除和清理后，接下来我们将学习如何让程序在断点处停下来，实现真正的断点调试功能。
