## 动态断点

### 实现目标：列出断点

前一节中我们实现了动态断点的添加，为了能够支持移除断点，我们必须为断点提供一些描述信息，比如断点编号，这样用户可以借助断点编号来移除断点。

比如依次添加了3个断点，每个断点依次编号为 `1、2、3`，当用户希望移除断点2时，可以通过执行命令 `clear -n 2`来移除。

当然添加的断点数量多了之后，我们很难记得清楚自己添加了多少个断点，每个断点对应的指令地址是什么，添加顺序（编号）是什么，所以我们还必须提供一个列出已添加断点的功能，如执行 `breakpoints`会列出所有已添加断点。

展示样式大致如下所示，至少要显示断点编号，对应指令地址，以及源码位置。

```bash
godbg> breakpoints
breakpoint[1] 0x4000001 main.go:10
breakpoint[2] 0x5000001 hello.go:20
breakpoint[3] 0x5000101 world.go:30
```

### 代码实现

#### 微调代码：新增断点时记录编号及位置

我们需要对前一节添加断点的部分代码进行适当修改，在添加断点时能够同时记录断点的编号、指令地址、源码位置（源码位置我们先用空串表示）。

**file: cmd/debug/break.go**

```go
package debug

var breakCmd = &cobra.Command{
	RunE: func(cmd *cobra.Command, args []string) error {
		...
		breakpoint, err := target.NewBreakpoint(addr, orig[0], "")
		if err != nil {
			return fmt.Errorf("add breakpoint error: %v", err)
		}
		breakpoints[addr] = &breakpoint
    ...
	},
}

func init() {
	debugRootCmd.AddCommand(breakCmd)
}
```

**file: target/breakpoint.go**

```go
func NewBreakpoint(addr uintptr, orig byte, location string) (Breakpoint, error) {
	b := Breakpoint{
		ID:       seqNo.Add(1),
		Addr:     addr,
		Orig:     orig,
		Location: location,
	}
	return b, nil
}
```

#### 新增命令：breakpoints显示断点列表

我们新增一个调试命令breakpoints，用名词复数形式来隐含表示查询所有断点的意思。实现逻辑就比较简单，我们遍历所有已添加的断点，逐个输出断点信息即可。

> `breakpoints` 操作实现比较简单，我们没有在 [hitzhangjie/golang-debug-lessons](https://github.com/hitzhangjie/golang-debug-lessons) 中单独提供示例目录，而是在 [hitzhangjie/godbg](https://github.com/hitzhangjie/godbg) 中进行了实现，读者可以查看 godbg 的源码。
> TODO 代码示例可以优化一下, see: https://github.com/hitzhangjie/golang-debugger-book/issues/15

**file: cmd/debug/breakpoints.go**

```go
package debug

import (
	"fmt"
	"sort"

	"godbg/target"

	"github.com/spf13/cobra"
)

var breaksCmd = &cobra.Command{
	Use:     "breaks",
	Short:   "列出所有断点",
	Long:    "列出所有断点",
	Aliases: []string{"bs", "breakpoints"},
	Annotations: map[string]string{
		cmdGroupKey: cmdGroupBreakpoints,
	},
	RunE: func(cmd *cobra.Command, args []string) error {

		bs := target.Breakpoints{}
		for _, b := range breakpoints {
			bs = append(bs, *b)
		}
		sort.Sort(bs)

		for _, b := range bs {
			fmt.Printf("breakpoint[%d] %#x %s\n", b.ID, b.Addr, b.Location)
		}
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(breaksCmd)
}
```

新增断点记录在一个 `map[uintptr]*breakpoint`结构中，这里用map主要是考虑到后续插入、删除、查询的场景，有助于提升查询效率，比如重复执行 `break main.go:10`多次，首先将main.go:10转成指令地址，然后查询此map结构，可以以O(1)的时间复杂度来判断此断点是否已经存在。

上述map的key是断点的指令地址，value是断点描述信息struct，如果我们直接通过for-range来遍历map的kv然后输出其信息，那断点展示的顺序不一定就是按照断点编号。

为了能够保证断点展示的顺序能够按照编号有序展示，我们需要对断点切片Breakpoints实现 `sort.Interface{}`接口，允许其通过编号进行排序。

**file: target/breakpoint.go**

```go
package target

import (
	"go.uber.org/atomic"
)

var (
  // 断点编号
	seqNo = atomic.NewUint64(0)
)

// Breakpoint 断点
type Breakpoint struct {
	ID       uint64
	Addr     uintptr
	Orig     byte
	Location string
}

// Breakpoints 断点切片，实现了排序接口
type Breakpoints []Breakpoint

func (b Breakpoints) Len() int {
	return len(b)
}

func (b Breakpoints) Less(i, j int) bool {
	if b[i].ID <= b[j].ID {
		return true
	}
	return false
}

func (b Breakpoints) Swap(i, j int) {
	b[i], b[j] = b[j], b[i]
}
```

这样，我们既可以通过 `sort.Sort(bs)`对现有断点按照编号进行排序，然后再遍历输出断点信息即可。

基于命令行的调试器，实际调试经历来看，查看断点列表、新增断点、删除断点，相对来说也是比较频繁的。存储所有断点信息使用map和slice相比，新增、删除、查询都更方便，编码也方便 :)

### 代码测试

我们先运行一个测试程序，查看其pid，然后通过 `godbg attach <pid>`对目标进程进行调试，当调试会话准备好之后，我们通过 `disass`反汇编查看其汇编指令列表以及指令地址，然后通过 `break <locspec>`来添加多个断点，并通过 `breakpoints`or `breaks`来显示已添加的断点列表。

```bash
godbg> disass
...
0x4653a6 INT 0x3                                          ; add breakpoint here
0x4653a7 MOV [RSP+Reg(0)+0x40], AL
0x4653ab MOV RCX, RSP                                     ; add breakpoint here
0x4653ae INT 0x3
0x4653af AND [RAX-0x7d], CL
0x4653b2 Prefix(0xc4) Prefix(0x28) Prefix(0xc3) INT 0x3
0x4653b6 MOV EAX, [RSP+Reg(0)+0x30]
0x4653ba ADD RAX, 0x8
0x4653be INT 0x3
0x4653bf MOV [RSP+Reg(0)], EAX
0x4653c2 REX.W Op(0)
...
godbg> b 0x4653a6
break 0x4653a6
添加断点成功
godbg> b 0x4653ab
break 0x4653ab
添加断点成功
godbg> breakpoints
breakpoint[1] 0x4653a6 
breakpoint[2] 0x4653ab 
godbg> 
```

我们可以看到添加了断点之后，breakpoints命令正常显示了断点列表。

```bash
godbg> breakpoints
breakpoint[1] 0x4653a6 
breakpoint[2] 0x4653ab 
```

这里的编号1、2将用来作为断点标识用以移除断点，我们将在clear命令中描述这点。

> ps: 和上一小节类似，目前添加断点 `break <locspec>`，列出断点 `breakpoints`，locspec的形式目前仅支持内存地址的形式，还不支持源码位置。我们将在后续实现符号级调试器时解决此问题。
