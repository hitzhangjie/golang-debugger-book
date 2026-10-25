## 调试命令：`breakpoints` 列出断点

6.6 节实现了 `break`：把目标指令的首字节 patch 成 `0xCC`，同时把断点登记进按地址、按编号两张索引。断点加进去了，但用户还看不见——加了几个、编号是几、地址是多少，只能靠记忆。而编号恰恰是后面移除断点的句柄，所以必须有一个命令把断点表读出来展示。本节实现 `breakpoints`。

6.6 节末尾，`cmd/debug/breakpoints.go` 里其实已经留了一个占位命令，`Run` 里只有一句 `TODO(ch6.7): breakpoints 尚未实现`。本节把它填上，并把 `api.Client`、`debugger` 门面、目标层串成完整的调用链。

本节配套代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.7`，`git diff ch6.6 ch6.7` 可以看到这一节改了什么：三个代码文件（命令层、`api.Client`、门面）。目标层的 `ListBreakpoints`、`Breakpoints` 排序接口在 6.6 节已经随 `pkg/target/breakpoint.go` 一起实现，本节主要是把它们集成到一起。

### 实现目标：`godbg> breakpoints` 列出断点

命令名用复数形式，隐含"列出全部断点"的意思，`bp`、`bs` 是它的别名：

```bash
godbg> breakpoints
godbg> bp            # 别名，效果相同
godbg> bs            # 别名，效果相同
```

输出每条断点的编号、指令地址和源码位置：

```bash
godbg> breakpoints
breakpoint[1] addr:0x478120, loc:-
breakpoint[2] addr:0x4749e0, loc:-
```

没有断点时明确输出 `no breakpoints`，而不是打一片空白：

```bash
godbg> breakpoints
no breakpoints
```

这里有几点约定：

- 按断点编号升序输出。编号从 1 开始单调递增，是用户操作断点的句柄：本节用它查看断点，6.8 节 `clear -n <id>` 用它移除断点；
- 每条断点给出编号、地址、源码位置三项。地址用 `0x` 前缀的十六进制，和 `break <address>` 的输入格式一致；
- 源码位置 `loc` 目前固定是 `-`。指令级调试还没有 DWARF 符号信息，拿不到 `file:line`；等 9.2.22 节实现源码位置断点后，这里会显示真实的源码位置；
- 列出断点只读后端内存里的断点表，不访问目标进程、不执行 ptrace，因此它不会改变断点状态，也不会影响目标进程的执行。

### 设计要点：按编号输出

断点存在 `map[uintptr]*Breakpoint`、`map[uint64]*Breakpoint` 两张表里，map 的遍历顺序不确定，不能直接遍历输出。列出的过程是：收集成切片、按编号排序、再逐条输出。

按编号而不是地址排序，是因为编号是用户操作的句柄：它对应添加顺序，也是 6.8 节 `clear -n <id>` 的参数。排序放在目标层，`api.Client.ListBreakpoints` 的注释把"按编号升序"写成接口契约，命令层和 headless 客户端都依赖这个保证，不需要各自再排一遍。

### 在 godbgv2 中实现

相对 ch6.6，这一节的调用链是：

```text
godbg> breakpoints
    cmd/debug/breakpoints.go      RunE：调 Client.ListBreakpoints；空列表打印 no breakpoints；
                                  否则逐条打印编号、地址、源码位置
    pkg/service/api               Client 接口：新增 ListBreakpoints，返回 []Breakpoint 值快照
    pkg/service/debugger          门面，检查 dbp 非空后转给目标层
    pkg/target                    breakpoint.go：ListBreakpoints 收集 map 断点、按 ID 排序、
                                  转成 api.Breakpoint 切片返回
```

命令层后面仍然是 `Client`，`main` 里把它装配成 `debugger.New()`，这个约定没有变。下面按命令层、服务层、目标层分别看。

#### 命令层

`cmd/debug/breakpoints.go` 的完整代码如下，相对 6.6 节的占位版本，`Run` 换成了 `RunE`，`Short` 从"列出断点"改成"列出全部断点"，别名增加了 `bs`：

```go
package debug

import (
	"fmt"

	"github.com/spf13/cobra"
)

var breakpointsCmd = &cobra.Command{
	Use:     "breakpoints",
	Short:   "列出全部断点",
	Aliases: []string{"bp", "bs"},
	Annotations: map[string]string{
		cmdGroupAnnotation: cmdGroupBreakpoints,
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		bps, err := Client.ListBreakpoints()
		if err != nil {
			return err
		}
		if len(bps) == 0 {
			fmt.Println("no breakpoints")
			return nil
		}
		// 断点已按编号升序排列（issue #15）
		for _, b := range bps {
			fmt.Printf("breakpoint[%d] addr:%#x, loc:%s\n", b.ID, b.Addr, b.Pos)
		}
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(breakpointsCmd)
}
```

几个要点：

- `RunE` 而不是 `Run`：`Client.ListBreakpoints` 可能返回错误（比如门面发现没有正在调试的进程），`RunE` 让错误能一路抛给 cobra，最终打印成 `Error: ...`。6.6 节 `break` 也是同样的写法；
- `Aliases` 注册了 `bp`、`bs`。`bp` 是 breakpoint 的常见缩写，`bs` 是 breakpoints 缩写；`Annotations` 把命令归到断点分组，`help` 按分组展示时断点相关命令排在一起（命令分组在 5.7 节搭骨架时介绍过）；
- `len(bps) == 0` 单独处理，输出 `no breakpoints`。后端返回的是空切片而不是 `nil`，命令层用长度判断即可，不需要关心底层 map 的状态；
- 输出格式 `breakpoint[%d] addr:%#x, loc:%s`：`%#x` 自动补 `0x` 前缀，和用户输入地址的格式保持一致；`loc` 当前是 `-`，是给源码位置预留的字段；
- 命令层只负责展示，不打印任何调试器内部状态。后端只返回数据、前端决定怎么显示，这是 `docs/ARCH-RULES.md` 里定下的分层约定。

#### 服务层

`pkg/service/api/client.go` 给 `Client` 接口增加了一个方法（这里只列断点相关部分）：

```go
type Client interface {
	// ...（Launch、State、Disassemble、AddBreakpoint 等，此处省略）
	// AddBreakpoint 在地址 addr 处添加断点
	AddBreakpoint(addr uint64) (*Breakpoint, error)
	// ListBreakpoints 按编号升序返回全部断点
	ListBreakpoints() ([]Breakpoint, error)
}
```

返回值是 `[]Breakpoint` 值切片，不是 `[]*Breakpoint`：

- `Breakpoint` 是服务层的纯值类型（6.6 节定义在 `pkg/service/api/types.go`），字段都是 `uint64`、`string`、`byte` 这类可序列化的类型，不包含内部指针；
- 第 9 章引入 headless RPC 后，这个返回值要直接跨进程传输，值切片可以直接序列化；如果返回内部 `*target.Breakpoint`，既暴露了目标层实现，也没法跨进程传；
- 加 `error` 返回值是为了和接口里其他方法保持一致的签名形态。当前本地门面只在"没有正在调试的进程"时返回错误，等第 9 章换成 RPC 客户端，网络、服务端错误也会从这个位置返回，命令层不用跟着改签名。

`pkg/service/debugger/debugger.go` 里的门面方法：

```go
// ListBreakpoints 按编号升序返回全部断点
func (d *Debugger) ListBreakpoints() ([]api.Breakpoint, error) {
	if d.dbp == nil {
		return nil, fmt.Errorf("no debugged process")
	}
	return d.dbp.ListBreakpoints(), nil
}
```

门面做的事情很薄：检查 `d.dbp` 是否为空，然后把请求转给目标层。`d.dbp == nil` 说明当前没有 exec/attach 任何进程，此时返回 `no debugged process` 比让后面的空指针 panic 更友好。文件末尾的 `var _ api.Client = (*Debugger)(nil)` 在编译期保证门面没有漏掉接口方法。

#### 目标层：收集、排序、转快照

排序和收集都在 `pkg/target/breakpoint.go` 里，相关代码如下：

```go
// Breakpoints 按 ID 排序的断点列表
type Breakpoints []*Breakpoint

// Len 返回长度
func (b Breakpoints) Len() int { return len(b) }

// Less 比较 b[i]、b[j] 的 ID
func (b Breakpoints) Less(i, j int) bool { return b[i].ID < b[j].ID }

// Swap 交换 b[i]、b[j]
func (b Breakpoints) Swap(i, j int) { b[i], b[j] = b[j], b[i] }

// ListBreakpoints 按 ID 排序返回全部断点
func (p *DebuggedProcess) ListBreakpoints() []api.Breakpoint {
	bs := Breakpoints{}
	for _, b := range p.Breakpoints {
		bs = append(bs, b)
	}
	sort.Sort(bs)

	apiBps := []api.Breakpoint{}
	for _, b := range bs {
		apiBps = append(apiBps, *toAPIBreakpoint(b))
	}
	return apiBps
}
```

这段代码很直白：遍历 map 收集断点，`sort.Sort` 按编号升序，最后把内部断点转成 `api.Breakpoint` 值快照返回（值拷贝的原因见上面服务层）。

### 运行效果

在 godbgv2 仓库里切到这一节，把调试器和 fixture 都构建出来：

```bash
git checkout ch6.7
make build
make fixtures
```

仍然用 6.6 节的 `_fixtures/loop` 做目标程序，入口地址是 `0x478120`，`_rt0_amd64` 的地址是 `0x4749e0`（`readelf -h _fixtures/loop` 和 `objdump -d` 可以看到）。启动调试会话，添加两个断点，然后列出：

```bash
$ ./godbg exec _fixtures/loop
process 1947396 launched, stopped by SIGTRAP
godbg> break 0x478120
breakpoint 1 added at 0x478120
godbg> break 0x4749e0
breakpoint 2 added at 0x4749e0
godbg> breakpoints
breakpoint[1] addr:0x478120, loc:-
breakpoint[2] addr:0x4749e0, loc:-
godbg> b 0x478120
breakpoint 1 added at 0x478120
godbg> breakpoints
breakpoint[1] addr:0x478120, loc:-
breakpoint[2] addr:0x4749e0, loc:-
godbg> exit
tracee is run by tracer, kill it
```

观察一下这段输出：

- 两个断点按添加顺序拿到编号 1、2，`breakpoints` 按编号升序把它们列出来。底层虽然是从 map 收集的，但经过排序后输出是确定的；
- 每行只展示编号、地址和源码位置，没有展示 `Orig`、`Enabled` 这些内部字段。`Orig` 是还原指令用的内部数据，对用户没有意义；`Enabled` 目前永远是 true，等支持启用/禁用断点后再展示；
- `loc` 显示为 `-`，表示当前还没有源码位置信息。这不是省略，而是符号级调试能力尚未接入时的占位；
- 重复执行 `b 0x478120`，输出仍然是 `breakpoint 1 added at 0x478120`，列表里也只有两条记录：6.6 节的按地址去重生效了，没有产生编号为 3 的新断点。输出文案和首次添加一样，是 6.6 节提过的观感问题，通过列表能确认断点数量没有变化；
- 没有断点时执行 `breakpoints`，输出 `no breakpoints`：

```bash
$ ./godbg exec _fixtures/loop
process 1947469 launched, stopped by SIGTRAP
godbg> breakpoints
no breakpoints
godbg> exit
tracee is run by tracer, kill it
```

### 更多相关内容

**输出格式还会继续演进。** 当前只输出编号、地址、源码位置。符号级调试接入 DWARF 后，`loc` 会变成 `file:line`；如果后续支持断点启用/禁用、条件断点、命中次数，`api.Breakpoint` 里相应字段会补上，命令层的格式串也会跟着扩展。GDB 的 `info breakpoints` 会列出 Num、Type、Disp、Enb、Address、What，Delve 的 `breakpoints` 会显示断点编号/名称、启用状态、位置和命中次数，可以看作这个列表未来可能长成的样子。godbgv2 在指令级调试阶段只保留最小必要信息。

**编号不复用。** `bpSeqNo` 只增不减，删除断点后旧编号不会分配给新断点。这样用户手里的编号始终指向同一个断点，不会因为删掉再添加而误操作；代价是编号可能出现空洞，`breakpoints` 输出里看到不连续的编号是正常的。

### 本节小结

本节实现了 `breakpoints` 命令：把已添加的断点按编号升序列出，支持 `bp`、`bs` 别名，空列表输出 `no breakpoints`。排序由目标层的 `ListBreakpoints` 保证，命令层只负责展示。

有了编号和列表，用户就能确认自己加了哪些断点、每个断点的编号是多少。下一节实现 `clear -n <id>`，按编号移除断点；再往后是 `continue`，让程序运行到断点处。断点的"增、查、删、命中"闭环就完整了。

### 参考文献

1. Package sort - Go standard library, https://pkg.go.dev/sort
2. Cobra - A Commander for modern Go CLI interactions, https://cobra.dev/
3. GDB - Breakpoints, Watchpoints, and Catchpoints, https://sourceware.org/gdb/current/onlinedocs/gdb.html/Breakpoints.html
