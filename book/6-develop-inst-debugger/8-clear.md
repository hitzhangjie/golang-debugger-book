## 动态断点

### 设计目标：移除断点

前面介绍了如何添加断点、显示断点列表，现在我们来看看如何移除断点。

移除断点与新增断点，都是需要借助ptrace来实现。回想下新增断点首先通过PTRACEPEEKDATA/PTRACEPOKEDATA来实现对指令数据的备份、覆写，移除断点的逻辑有点相反，先将原来备份的指令数据覆写回断点对应的指令地址处，然后，从已添加断点集合中移除即可。

> ps: 在Linux下PTRACE_PEEKTEXT/PTRACE_PEEKDATA，以及PTRACE_POKETEXT/PTRACE_POKEDATA并没有什么不同，所以执行ptrace操作的时候，ptrace request可以任选一个。
>
> 为了可读性，读写指令时倾向于PTRACE_PEEKTEXT/PTRACE_POKETEXT，读写数据时则倾向于PTRACE_PEEKDATA/PTRACE_POKEDATA。

### 代码实现

首先解析断点编号参数 `-n <breakNo>`，并从已添加断点集合中查询，是否有编号为n的断点存在，如果没有则 `<breakNo>` 为无效参数。

如果断点确实存在，则执行ptrace(PTRACE_POKEDATA,...)将原来备份的1字节指令数据覆写回原指令地址，即消除了断点。然后，再从已添加断点集合中删除这个断点。

clear 操作实现比较简单，在 [hitzhangjie/godbg](https://github.com/hitzhangjie/godbg) 中进行了实现，读者可以查看 godbg 的源码。但是我们也强调过了，上述repo提供的是一个功能相对完备的调试器，代码量会比较大。因此我们也在 [hitzhangjie/golang-debugger-lessons](https://github.com/hitzhangjie/golang-debugger-lessons))/8_clear 提供了测试用例，测试用例中演示了break、breakpoints、continue、clear这几个断点相关操作。

```go
package debug

import (
    "errors"
    "fmt"
    "strings"
    "syscall"

    "godbg/target"

    "github.com/spf13/cobra"
)

var clearCmd = &cobra.Command{
    Use:   "clear <n>",
    Short: "清除指定编号的断点",
    Long:  `清除指定编号的断点`,
    Annotations: map[string]string{
        cmdGroupKey: cmdGroupBreakpoints,
    },
    RunE: func(cmd *cobra.Command, args []string) error {
        fmt.Printf("clear %s\n", strings.Join(args, " "))

        id, err := cmd.Flags().GetUint64("n")
        if err != nil {
            return err
        }

        // 查找断点
        var brk *target.Breakpoint
        for _, b := range breakpoints {
            if b.ID != id {
                continue
            }
            brk = b
            break
        }

        if brk == nil {
            return errors.New("断点不存在")
        }

        // 移除断点
        n, err := syscall.PtracePokeData(TraceePID, brk.Addr, []byte{brk.Orig})
        if err != nil || n != 1 {
            return fmt.Errorf("移除断点失败: %v", err)
        }
        delete(breakpoints, brk.Addr)

        fmt.Println("移除断点成功")
        return nil
    },
}

func init() {
    debugRootCmd.AddCommand(clearCmd)

    clearCmd.Flags().Uint64P("n", "n", 1, "断点编号")
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

然后我们执行 `clear -n 2`移除第2个断点：

```bash
godbg> clear -n 2
clear 
移除断点成功
```

接下来再次执行 `breakpoints`查看剩余的断点：

```bash
godbg> bs
breakpoint[1] 0x4653af 
breakpoint[3] 0x4653c2
```

现在断点2已经被移除了，我们的添加、移除断点的功能是正常的。

### 思考：如果tracer退出前不清理断点?

思考一个问题，tracer添加、移除断点都是通过ptrace系统调用显示对进程指令进行patch，那么如果tracer退出前不显示清除过去添加过的断点会怎样？

我们尝试运行一个shell操作来模拟tracee：

```bash
$ while [ 1 -eq 1 ]; do t=`date`; echo "$t pid: $$"; sleep 1; done

Sun Sep  7 15:22:23 CST 2025 pid: 416728
Sun Sep  7 15:22:24 CST 2025 pid: 416728
Sun Sep  7 15:22:25 CST 2025 pid: 416728
Sun Sep  7 15:22:26 CST 2025 pid: 416728
```

然后咱们执行godbg调试跟踪跟进程：

```bash
godbg attach 416728
```

回头发现刚才的shell操作不再执行输出操作了：

```bash
$ while [ 1 -eq 1 ]; do t=`date`; echo "$t pid: $$"; sleep 1; done

Sun Sep  7 15:22:23 CST 2025 pid: 416728
Sun Sep  7 15:22:24 CST 2025 pid: 416728
Sun Sep  7 15:22:25 CST 2025 pid: 416728
Sun Sep  7 15:22:26 CST 2025 pid: 416728
Sun Sep  7 15:22:27 CST 2025 pid: 416728 <= godbg attach 416728, after traced, tracee paused
                                         <= OK, press enter enter enter to create some space here,
                                            so we can watch the output again when we run `continue`.

```


现在我们回到godbg调试会话中执行continue操作，然后会观察到tracee开始重新输出信息：

```bash
$ while [ 1 -eq 1 ]; do t=`date`; echo "$t pid: $$"; sleep 1; done

Sun Sep  7 15:22:23 CST 2025 pid: 416728
Sun Sep  7 15:22:24 CST 2025 pid: 416728
Sun Sep  7 15:22:25 CST 2025 pid: 416728
Sun Sep  7 15:22:26 CST 2025 pid: 416728
Sun Sep  7 15:22:27 CST 2025 pid: 416728
                                        
                                        
Sun Sep  7 15:23:19 CST 2025 pid: 416728 <= after we run `continue`, we see the output again.
```

现在我们回到godbg调试会话中执行exit操作，此时会执行ptrace detach操作，tracee会恢复执行。但是我们知道，多字节指令被patch后是不完整的，如果调试器退出前没有显示恢复该多字节指令数据，那么后续tracee执行到这个指令时应该会遇到指令解码错误。但是在遇到这个错误之前，它一定会先执行断点指令0xCC，然后会触发SIGTRAP信号。

SIGTRAP本来就是为了软件调试设计的，此时没有tracer会发生什么呢？没有tracer的情况下，内核的默认行为是杀死该tracee，也就是下面我们看到的，tracee退出了，错误码是 5 (0x00000005)。

```bash
Sun Sep  7 15:22:23 CST 2025 pid: 416728
Sun Sep  7 15:22:24 CST 2025 pid: 416728
Sun Sep  7 15:22:25 CST 2025 pid: 416728
Sun Sep  7 15:22:26 CST 2025 pid: 416728
Sun Sep  7 15:22:27 CST 2025 pid: 416728 
                                         

Sun Sep  7 15:23:19 CST 2025 pid: 416728

[process exited with code 5 (0x00000005)] <= tracee exited with error
You can now close this terminal with Ctrl+D, or press Enter to restart.
```

所以，调试器在退出之前务必要清理掉之前创建过的所有断点，否则会给tracee后续运行造成非常不良的影响。

### 本节小结

本节主要探讨了调试器中动态断点的移除功能实现，核心内容包括断点移除与添加的对称性、ptrace系统调用的反向操作，以及删除断点时的断点编号验证、断点查找、指令恢复和断点集合清理步骤。ptrace操作PTRACE_PEEKTEXT/PTRACE_POKETEXT用于指令操作，PTRACE_PEEKDATA/PTRACE_POKEDATA用于数据操作，但实际功能相同。对于添加的断点，在调试器退出时，如果希望进程继续运行则应该主动清理掉这些断点。

本节内容完善了调试器断点管理的核心功能，与前面的断点添加、断点列表显示功能共同构成了完整的断点操作体系，为读者理解调试器内部机制提供了重要的实践基础。通过本节的学习，读者可以掌握断点移除的底层实现原理，为后续学习更复杂的调试器功能（如条件断点、断点修改等）奠定了技术基础。

