## 动态断点

### 实现目标：添加断点

断点按照其“**生命周期**”进行分类，可以分为“**静态断点**”和“**动态断点**”。

- 静态断点的生命周期是整个程序执行期间，一般是通过执行指令 `int 0x3h`来强制插入 `0xCC`充当断点，其实现简单，在编码时就可以安插断点，但是不灵活；
- 动态断点的生成、移除，是通过运行时指令patch，其生命周期是与调试活动中的操作相关的，其最大的特点就是灵活，一般是只能借由调试器来生成。

不管是静态断点还是动态断点，其原理是类似的，都是通过一字节指令 `0xCC`来实现暂停任务执行的操作，处理器执行完 `0xCC`之后会暂停当前任务执行。

> ps：我们在章节4.2中有提到 `int 0x3h`（编码后指令0xCC)是如何工作的，如果读者忘了其工作原理，可自行查阅相关章节。

断点按照“**实现方式**”的不同，也可以细分为“**软件断点**”和“**硬件断点**”。

- 硬件断点一般是借助硬件特有的调试端口来实现，如将感兴趣的指令地址写入调试端口（寄存器），当PC命中时就会触发停止tracee执行的操作，并通知tracer；
- 软件断点是相对于硬件断点而言的，如果断点实现是不借助于硬件调试端口的话，一般都可以归为软件断点。

我们先只关注软件断点，并且只关注动态断点。断点的添加、移除是调试过程的基石，在我们掌握了在特定地址处添加、移除断点之后，我们可以研究下断点的应用，如step、next、continue等。

在熟练掌握了这些操作之后，我们将在后续章节结合DWARF来实现符号级断点，那时将允许你对一行语句、函数、分支控制添加、移除断点，断点的价值就进一步凸显出来了。

### 代码实现

我们使用 `break`命令来添加断点，可以简单缩写成 `b`，使用方式如下：

```bash
# 注意<locspec>的写法
break <locspec>
```

locspec表示一个代码中的位置，可以是指令地址，也可以是一个源文件中的位置。如果是后者，我们需要查询行号表先将源码中的位置转换成指令地址。有了指令地址之后，我们就可以对该地址处的指令数据进行patch以达到添加、移除断点的目的。

本章节，我们先只考虑locspec为指令地址的情况。

> locspec支持的格式，直接关系到添加断点的效率。delve中定义了一系列的locspec格式，感兴趣可以参考dlv中的实现：https://sourcegraph.com/github.com/go-delve/delve@master/-/blob/pkg/locspec/locations.go

现在来看下我们的实现代码：

```go
package debug

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"syscall"

	"github.com/spf13/cobra"
)

var breakCmd = &cobra.Command{
	Use:   "break <locspec>",
	Short: "在源码中添加断点",
	Long: `在源码中添加断点，源码位置可以通过locspec格式指定。

当前支持的locspec格式，包括两种:
- 指令地址
- [文件名:]行号
- [文件名:]函数名`,
	Aliases: []string{"b", "breakpoint"},
	Annotations: map[string]string{
		cmdGroupKey: cmdGroupBreakpoints,
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		fmt.Printf("break %s\n", strings.Join(args, " "))

		if len(args) != 1 {
			return errors.New("参数错误")
		}

		locStr := args[0]
		addr, err := strconv.ParseUint(locStr, 0, 64)
		if err != nil {
			return fmt.Errorf("invalid locspec: %v", err)
		}

    // 记录地址addr处的原始1字节数据
		orig := [1]byte{}
		n, err := syscall.PtracePeekData(TraceePID, uintptr(addr), orig[:])
		if err != nil || n != 1 {
			return fmt.Errorf("peek text, %d bytes, error: %v", n, err)
		}
		breakpointsOrigDat[uintptr(addr)] = orig[0]

    // 将addr出的一字节数据覆写为0xCC
		n, err = syscall.PtracePokeText(TraceePID, uintptr(addr), []byte{0xCC})
		if err != nil || n != 1 {
			return fmt.Errorf("poke text, %d bytes, error: %v", n, err)
		}
		fmt.Printf("添加断点成功\n")
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(breakCmd)
}
```

这里的实现逻辑并不复杂，我们来看下。

首先假定用户输入的是一个指令地址，这个地址可以通过disass查看反汇编时获得。我们先尝试将这个指令地址字符串转换成uint64数值，如果失败则认为这是一个非法的地址。

如果地址有效，则尝试通过系统调用 `syscall.PtracePeekData(pid, addr, buf)`来尝试读取指令地址处开始的一字节数据，这个数据是汇编指令编码后的第1字节的数据，我们需要将其暂存起来，然后再通过 `syscall.PtracePokeData(pid, addr, buf)`写入指令 `0xCC`。

等我们准备结束调试会话时，或者显示执行 `clear`清除断点时，需要将数据这里的0xCC还原为原始数据。

ps: Linux下，PEEKDATA、PEEKTEXT、POKEDATA、POKETEXT效果是一样的, see `man 2 ptrace` :

```bash
$ man 2 ptrace

PTRACE_PEEKTEXT, PTRACE_PEEKDATA
    Read  a  word  at  the address addr in the tracee's memory, returning the word as the result of the ptrace() call.  
    Linux does not have separate text and data address spaces, so these two requests are currently equivalent.  (data is ignored; but see NOTES.)

PTRACE_POKETEXT, PTRACE_POKEDATA
    Copy the word data to the address addr in the tracee's memory.  As for PTRACE_PEEKTEXT and PTRACE_PEEKDATA, these two requests are currently equivalent.
```

### 代码测试

下面来测试一下，首先我们启动一个测试程序，获取其pid，这个程序最好一直死循环不退出，方便我们测试。

然后我们先执行 `godbg attach <pid>`准备开始调试，调试会话启动后，我们执行disass反汇编命令查看汇编指令对应的指令地址。

```bash
godbg attach 479
process 479 attached succ
process 479 stopped: true
godbg> 
godbg> disass
.............
0x465326 MOV [RSP+Reg(0)+0x8], RSI
0x46532b MOV [RSP+Reg(0)+0x10], RBX
0x465330 CALL .-400789
0x465335 MOVZX ECX, [RSP+Reg(0)+0x18]
0x46533a MOV RAX, [RSP+Reg(0)+0x38]
0x46533f MOV RDX, [RSP+Reg(0)+0x30]
.............
godbg> 
```

随机选择一条汇编指令的地址，在调试会话中输入 `break <address>`，我们看到提示断点添加成功了。

```bash
godbg> b 0x46532b
break 0x46532b
添加断点成功
godbg>
godbg> exit
```

最后执行exit退出调试。

这里我们只展示了断点的添加逻辑，断点的移除逻辑，其实实现过程非常相似，我们将在clear命令的实现时再介绍。另外有网友可能有疑问，这里怎么没演示下添加断点后tracee暂停执行的效果呢？因为现在还不到时候。我们添加断点功能，还停留在指令级调试功能（只实现了 `break "指令地址"` ），我们还没有实现符号级调试器在指定源码位置添加断点的操作（ `break "源文件:行号"` 或者 `break "函数名" `），如果要演示在tracee在特定源码位置停下来的操作，我们得先借助其他手段获取源码位置对应的指令地址，然后再回填到我们的 `break "指令地址"` 操作中。即便我们做了这个事情，我们还需要 `continue` 操作先支持完才能让tracee运行到断点处，才能体现出读者想要的tracee暂停执行的效果。

读者先知道原因就好了，我们这里先快速介绍如何实现break（添加断点）、clear（移除断点）功能之后，我们再来看step（单步执行指令）、next（单步执行语句）、continue（执行到断点位置）等控制执行流程的调试命令如何实现。在在所有必要前置工作准备妥当后，我们会提供一个完整的demo来演示断点功能。
