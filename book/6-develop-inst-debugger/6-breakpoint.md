## 调试命令：`break` 添加断点

6.5 节实现了 `disass`，我们能在调试会话里看到目标程序的一条条指令以及它们的地址了。有了"指令在哪儿"这个前提，本节就可以实现指令级调试最核心的操作：断点。

断点的分类、`int 3` 的工作原理、软件断点与硬件断点的区别，4.2.3《断点与执行控制》已经讲过，这里不再重复。本节实现的是其中最基础也最常用的一种：**软件动态断点**。它是断点能力的地基，掌握了它，step、next、continue 这些执行控制命令才有地方落脚；再往后结合 DWARF 实现符号级断点，就能对一行源码、一个函数、一个分支下断点了。

本节配套代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.6`，`git diff ch6.5 ch6.6` 可以看到这一节改了什么。

### 实现目标：`godbg> break <address>` 添加断点

本节实现 `break <address>`，`b`、`breakpoint` 是它的别名：

```bash
godbg> break 0x4749e0        # 在指令地址 0x4749e0 处添加断点
godbg> b 0x4749e0            # 别名，效果相同
godbg> breakpoint 0x4749e0   # 别名，效果相同
```

`<address>` 是一个指令地址，可以用 `disass` 反汇编得到，也可以从 `readelf`、`objdump` 这类工具的输出里拿。地址字符串的解析直接复用 6.5 节 `cmd/debug/address.go` 里的 `parseAddress`：`0x` 前缀按十六进制、`0` 前缀按八进制、其余按十进制。

添加成功后输出断点编号和地址：

```bash
godbg> break 0x4749e0
breakpoint 1 added at 0x4749e0
```

这里有几点约定：

- 断点编号从 1 开始、单调递增。编号是断点的标识：6.7 节 `breakpoints` 按编号列出断点，6.8 节 `clear -n <id>` 按编号移除断点，都离不开它；
- 同一个地址重复添加不会创建新断点，直接返回已经存在的那个：编号不变，目标进程内存也不会被重复 patch。这个"按地址去重"是后面 clear、continue 不会重复处理同一个断点的前提；
- 每添加一个断点，调试器要记下：断点地址、该地址处原有的指令首字节、断点编号和启用状态。少了哪一样，后面都还原不回去。

添加断点还有一个必须一起处理的副作用：断点处内存里的首字节已经变成 `0xCC`，此时 `disass` 读出来的是 `int3`，指令边界也被破坏了——从下一个字节开始解码，会得到完全不同的指令。所以本节除了 `break`，还要给 `disass` 补上 `--clearall`：反汇编时在数据副本里把断点字节还原成原始指令，让展示结果不受断点影响，用法是 `godbg> disass 0x4749e0 --clearall`。

关于 locspec：本节只支持"指令地址"这一种 locspec。`break "源文件:行号"`、`break "函数名"` 这类源码位置断点，要先借助 DWARF 把源码位置换算成指令地址，属于符号级调试器的能力，我们在 9.2.21~9.2.24 节实现；locspec 的格式定义见 [9.2.19 locspec 解析与地址转换](../9-develop-sym-debugger/2-核心调试逻辑/19-how_locspec_works.md)。

### 基础知识

#### 断点本质：把指令首字节 patch 成 int3

x86 是变长指令编码，为了提升解码效率、支持更多操作类型，一条指令的操作码、操作数占用的字节数可能相同也可能不同。`int 3` 是一条完整的一字节指令，机器码就是 `0xCC`，处理器取到它、执行完，就会停下来等待 tracer 的处理，这正是"断点"要的效果。

所以软件断点的添加过程就是一次指令 patch：

```text
断点添加之前：
addr:  0x?? 0x1 0x2 0x3 0x4

断点添加之后：
addr:  0xcc 0x1 0x2 0x3 0x4   | orig: <addr, 0x??>
```

为什么只覆盖指令的**第一字节**、不能覆盖其他字节？原因还是变长编码：如果写的不是第一字节，处理器执行时可能把一条合法的多字节操作码改成非法的操作码，直接产生异常；也可能这个 `0xCC` 被当成操作数的一部分吃掉，断点根本不会触发；如果一条指令本就只有一个字节，把断点写到第二个字节上，执行到断点地址时先执行的是原来那条一字节指令，断点会晚一条指令才命中，停下的位置就不对了。这个"只改首字节"的约束，也意味着断点地址必须落在一条指令的起始位置上——本节代码不检查这一点，`break` 给什么地址就 patch 什么地址，调用者要自己保证地址来自 `disass` 这类可靠来源。

指令 patch 不只调试器在用：gomonkey 这类 mock 测试框架要靠它替换函数入口，软件逆向、破解领域也大量使用 `0xCC` 断点来断在关键分支上。

#### 添加断点的三个动作

结合上一节的 ptrace 能力，在指令地址 `addr` 处添加一个软件断点需要三步：

1. **读取并保存原始字节**：用 `PTRACE_PEEKTEXT` 读出 `addr` 处的 1 字节，记到断点的 `Orig` 字段。它是将来还原断点的唯一依据；
2. **原地写入 `0xCC`**：用 `PTRACE_POKETEXT` 把 `addr` 处的 1 字节改成 `0xCC`。Linux 不区分 text、data 地址空间，PEEK/POKE 的 TEXT、DATA 版本效果相同；
3. **登记断点信息**：编号、地址、原始字节、启用状态，分别写进按地址、按编号组织的两张索引里。

第 2 步之后，目标进程的内存就已经被改变了；如果此时调试器异常退出、断点没有还原，tracee 再执行到那里就会收到一个 SIGTRAP 而莫名其妙地停下。所以添加断点从一开始就要把"怎么还原"记清楚，这也是第 1 步不能省的原因。

#### 为什么需要两张索引

`DebuggedProcess` 里给断点准备了两张 map：

- `map[uintptr]*Breakpoint`：按地址索引。重复添加同一个地址时用它判重；`disass --clearall` 还原窗口内的 `0xCC` 时，也靠"地址 → 断点"找到原始字节；
- `map[uint64]*Breakpoint`：按编号索引。编号是用户操作的句柄，6.8 节 `clear -n <id>` 按编号删除断点就走这张表；continue（6.12）判断当前停在哪个断点、还原哪条指令，靠的是地址索引。

如果只存一份断点切片，按地址判重、按编号查找都要遍历，断点一多就慢了；两张 map 把这两类高频查询都压到 O(1)。6.7 节 `breakpoints` 列出断点时，再把 map 里的断点收集成切片、按编号排序输出。

#### 命中断点之后：还原要 PC-1

软件断点命中时，CPU 执行的是 `0xCC`，这是一条完整的一字节指令。执行完之后 PC 指向的是断点地址的下一条指令，也就是：

```text
当前停止在断点处：
addr:  0xcc 0x1 0x2 0x3 0x4   | orig: <addr, 0x??>
PC = addr + 1
```

这带来两个后续必须处理的点：

- `continue`（6.12 节）恢复执行前，要把内存里的 `0xCC` 换回 `Orig`，再把 PC 从 `addr+1` 拨回 `addr`，否则原指令永远执行不到；
- `disass`（6.5 节）只是读内存、不控制执行，**不需要**改目标进程内存，只要把读出来的数据副本里被 patch 的字节还原即可。6.5 节末尾讲的"无参 disass 要关注 PC-1"，本节就用 `--clearall` 兑现。

### 在 godbgv2 中实现

前面几节搭好的分层这次仍然不用动：命令层新增 `break` 子命令，`api.Client` 补上添加断点、还原断点反汇编两个方法，`debugger` 门面转发，`pkg/target` 真正去 PEEK/POKE 内存并维护断点索引。相对 ch6.5，这一节的调用链是：

```text
godbg> break <address>
    cmd/debug/break.go            RunE：校验 1 个参数；parseAddress 解析地址；
                                  调 Client.AddBreakpoint，打印断点编号与地址
    pkg/service/api               Client 接口：新增 AddBreakpoint、DisassembleWithBreakpointCleared；
                                  Breakpoint 值类型
    pkg/service/debugger          门面，检查 dbp 非空后转给目标层
    pkg/target                    process.go：DebuggedProcess 增加按地址、按编号两张断点索引
                                  breakpoint.go：AddBreakpoint，PEEK 原字节、POKE 0xCC、登记断点
                                  disassemble.go：DisassembleWithBreakpointCleared，在数据副本里还原 0xCC
```

命令层后面仍然是 `Client`，`main` 里把它装配成 `debugger.New()`，这个约定没有变。下面按命令层、服务层、目标层分别看。

#### 命令层

`cmd/debug/break.go` 的完整代码如下：

```go
package debug

import (
	"errors"
	"fmt"

	"github.com/spf13/cobra"
)

var breakCmd = &cobra.Command{
	Use:     "break <address>",
	Short:   "在指定地址添加断点",
	Long:    `在指定地址添加断点。当前只支持指令地址，源码位置断点将在 ch9.2.22 支持。`,
	Aliases: []string{"b", "breakpoint"},
	Annotations: map[string]string{
		cmdGroupAnnotation: cmdGroupBreakpoints,
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		if len(args) != 1 {
			return errors.New("usage: break <address>")
		}

		addr, err := parseAddress(args[0])
		if err != nil {
			return err
		}

		bp, err := Client.AddBreakpoint(addr)
		if err != nil {
			return err
		}
		fmt.Printf("breakpoint %d added at %#x\n", bp.ID, bp.Addr)
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(breakCmd)
}
```

几个要点：

- `Use` 是 `break <address>`，`Aliases` 注册了 `b`、`breakpoint`；`Annotations` 把命令归到断点分组，`help` 按分组展示时，断点相关命令排在最前面（命令分组在 5.7 节搭骨架时介绍过）；
- `len(args) != 1` 时返回 `usage: break <address>`：没给地址、多给了参数都走这个分支；
- 地址解析复用 6.5 节的 `parseAddress`，`0x` 十六进制、十进制、`0` 八进制都支持，解析失败返回 `invalid address: ...`；
- 真正的添加动作不在命令层：`Client.AddBreakpoint(addr)` 拿到的是已经添加完成后的 `*api.Breakpoint` 快照，命令层只负责按 `breakpoint %d added at %#x` 打印编号和地址。后端不打印、前端只展示，与 `disass` 的约定一致。

错误处理也体现了这条分层约定：参数个数不对、地址解析失败由命令层返回错误；PEEK/POKE 失败由目标层返回错误，命令层原样上抛，最终由 cobra 统一打印 `Error: ...`。例如：

```bash
godbg> break 0xZZZ
Error: invalid address: strconv.ParseUint: parsing "0xZZZ": invalid syntax

godbg> break 0x1
Error: peek text, pid: 12345, 0 bytes, error: input/output error
```

后者是地址没有映射到进程内存时 PEEK 失败的结果（pid 为示例值，实际是当前 tracee 的 pid），错误里带上 pid、读取字节数和底层错误，方便定位问题。

#### 服务层

断点信息用 `api.Breakpoint` 表示，定义在 `pkg/service/api/types.go`：

```go
// Breakpoint 断点信息
type Breakpoint struct {
	ID      uint64 // 断点编号（单调递增，从 1 开始）
	Addr    uint64 // 断点地址
	Pos     string // 源码位置（指令级调试暂不支持，ch9.2.22 支持）
	Orig    byte   // 断点处原始指令的首字节
	Enabled bool   // 断点是否启用
}
```

这是一个纯值类型：`Addr` 用 `uint64` 而不是 `uintptr`。服务层（`api.Client`）只暴露平台无关、可序列化的值类型，`uintptr` 到 `uint64` 的转换收在门面和目标层这一侧；第 9 章引入 headless RPC 后，这些类型要直接序列化传输，`uintptr` 是不能跨进程传的。

`api.Client` 增加了两个方法（这里省略了接口文件头部的注释和 `Kind`、`State` 的定义）：

```go
type Client interface {
	// Launch 启动并跟踪一个进程，返回被调试进程 pid
	Launch(kind Kind, cmd string, args ...string) (int, error)
	// State 返回当前调试会话状态
	State() (*State, error)
	// CurrentPC 返回被调试进程当前停止位置的 PC（指令指针）。
	//
	// tracee 处于停止状态时，它就是"当前停下位置"：无参 disass 等
	// 以当前位置为起点的命令据此确定起点。
	CurrentPC() (uint64, error)
	// Kill 终止被调试进程
	Kill() error
	// Attach 跟踪一个正在运行的进程
	Attach(pid int) error
	// Detach 结束调试，分离被调试进程
	Detach() error
	// Disassemble 反汇编地址 addr 处的指令，返回 max 条
	Disassemble(addr, max uint64, syntax string) ([]AsmInstruction, error)
	// DisassembleWithBreakpointCleared 反汇编时临时还原地址范围内的断点，
	// 使输出展示原始指令
	DisassembleWithBreakpointCleared(addr, max uint64, syntax string) ([]AsmInstruction, error)
	// AddBreakpoint 在地址 addr 处添加断点
	AddBreakpoint(addr uint64) (*Breakpoint, error)
}
```

`AddBreakpoint` 返回 `*Breakpoint` 而不是只返回 error，因为命令层要打印编号和地址；`DisassembleWithBreakpointCleared` 与 `Disassemble` 并列，把"要不要还原断点"变成接口上的一个明确选择，而不是让后端自己猜。

`pkg/service/debugger` 门面做参数类型转换、转发和空指针检查（同一个文件里还有 Launch、Attach、Disassemble 等方法，本节不涉及，这里省略）：

```go
// DisassembleWithBreakpointCleared 反汇编时临时还原地址范围内的断点，
// 使输出展示原始指令
func (d *Debugger) DisassembleWithBreakpointCleared(addr, max uint64, syntax string) ([]api.AsmInstruction, error) {
	if d.dbp == nil {
		return nil, fmt.Errorf("no debugged process")
	}
	return d.dbp.DisassembleWithBreakpointCleared(addr, max, syntax)
}

// AddBreakpoint 在地址 addr 处添加断点
func (d *Debugger) AddBreakpoint(addr uint64) (*api.Breakpoint, error) {
	if d.dbp == nil {
		return nil, fmt.Errorf("no debugged process")
	}
	return d.dbp.AddBreakpoint(uintptr(addr))
}
```

`AddBreakpoint` 里 `uint64` 转 `uintptr`、返回值再转回 `api.Breakpoint`，平台相关的转换都收在门面和目标层这一侧。文件末尾的 `var _ api.Client = (*Debugger)(nil)` 在编译期保证门面没有漏掉接口方法。

#### 目标层：断点索引

`pkg/target/process.go` 给 `DebuggedProcess` 加了两张断点索引：

```go
// DebuggedProcess 被调试进程信息
type DebuggedProcess struct {
	Process *os.Process // 进程信息

	Command string   // 进程启动命令，方便重启调试
	Args    []string // 进程启动参数，方便重启调试
	Kind    Kind     // 发起调试的类型

	Breakpoints     map[uintptr]*Breakpoint // 已添加的断点，k=addr
	BreakpointsByID map[uint64]*Breakpoint  // 已添加的断点，k=id

	once   *sync.Once
	reqCh  chan ptraceRequest // ptrace 请求统一发送到这里，由专门协程处理
	doneCh chan int           // 通知需要停止调试
}
```

两个构造函数都可以往断点表里写，所以 `NewDebuggedProcess`（exec/debug 启动）和 `AttachTargetProcess`（attach 已有进程）里都要初始化：

```go
	p = &DebuggedProcess{
		Process:         nil,
		Command:         "",
		Args:            nil,
		Kind:            ATTACH,
		Breakpoints:     map[uintptr]*Breakpoint{},
		BreakpointsByID: map[uint64]*Breakpoint{},
		// ...
	}
```

#### 目标层：AddBreakpoint

断点本身的数据结构和添加逻辑放在新文件 `pkg/target/breakpoint.go` 里：

```go
// Breakpoint 断点信息
type Breakpoint struct {
	ID      uint64  // 断点编号（单调递增，从 1 开始）
	Addr    uintptr // 断点地址
	Pos     string  // 源码位置（指令级调试暂不支持，ch9.2.22 支持）
	Orig    byte    // 断点处原始指令的首字节
	Enabled bool    // 断点是否启用
}

// bpSeqNo 断点编号序列
var bpSeqNo uint64

// newBreakPoint 在指令地址addr处创建一个断点
func newBreakPoint(addr uintptr, orig byte, location string) *Breakpoint {
	bpSeqNo++
	return &Breakpoint{
		ID:      bpSeqNo,
		Addr:    addr,
		Pos:     location,
		Orig:    orig,
		Enabled: true,
	}
}
```

`bpSeqNo` 是个包级变量，没有加锁：调试命令在会话里是逐条串行执行的，同一时刻只有一个命令在改断点表，因此不需要并发保护；`newBreakPoint` 返回的断点默认 `Enabled` 为 true，这个字段是给后续"启用/禁用断点"这类精细化管理预留的（9.2.21 节）。

添加断点的主体是 `AddBreakpoint`：

```go
// AddBreakpoint 在地址addr处添加断点，返回新创建的断点。
//
// 软件断点的原理：将断点地址处指令的首字节保存到 Orig，然后原地替换为
// int3（0xCC）。被调试进程执行到该指令时触发 SIGTRAP 而暂停。
// 同时维护 addr、ID 两张索引，便于按地址查重、按编号查找。
func (p *DebuggedProcess) AddBreakpoint(addr uintptr) (*api.Breakpoint, error) {
	var (
		breakpoint *Breakpoint
		err        error
		n          int
	)

	// 该地址处已有断点，直接返回
	if bp, ok := p.Breakpoints[addr]; ok {
		return toAPIBreakpoint(bp), nil
	}

	err = p.ExecPtrace(func() error {
		pid := p.Process.Pid

		// 读取并保存断点处的原始指令首字节
		orig := [1]byte{}
		n, err = syscall.PtracePeekText(pid, addr, orig[:])
		if err != nil || n != 1 {
			return fmt.Errorf("peek text, pid: %d, %d bytes, error: %v", pid, n, err)
		}

		breakpoint = newBreakPoint(addr, orig[0], "-")
		p.Breakpoints[addr] = breakpoint
		p.BreakpointsByID[breakpoint.ID] = breakpoint

		// 将断点处的指令首字节替换为 int3
		n, err = syscall.PtracePokeText(pid, addr, []byte{0xCC})
		if err != nil || n != 1 {
			// 写入失败时回滚断点记录
			delete(p.Breakpoints, addr)
			delete(p.BreakpointsByID, breakpoint.ID)
			return fmt.Errorf("poke text, pid:%d, %d bytes, error: %v", pid, n, err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return toAPIBreakpoint(breakpoint), nil
}

// ...（ListBreakpoints 与 Breakpoints 排序接口略，见下文说明）
// toAPIBreakpoint 将内部断点对象转换为 api 层契约类型
func toAPIBreakpoint(bp *Breakpoint) *api.Breakpoint {
	return &api.Breakpoint{
		ID:      bp.ID,
		Addr:    uint64(bp.Addr),
		Pos:     bp.Pos,
		Orig:    bp.Orig,
		Enabled: bp.Enabled,
	}
}
```

逐段说明：

- 先查 `p.Breakpoints[addr]`，命中就直接把已有断点转成 `*api.Breakpoint` 返回。这就是"重复添加同一地址不会新建断点"的落点，编号保持不变；
- PEEK、POKE 都包在 `ExecPtrace` 里执行。6.1 节讲过 ptrace limit：跟踪关系建立后，所有 ptrace 请求必须来自同一个 tracer 线程，`ExecPtrace` 保证串行、不跨线程；
- PEEK 拿到原始首字节后立刻 `newBreakPoint` 并登记两张索引，再写 `0xCC`。注意顺序：先登记、后 POKE，POKE 失败时把两条索引都删掉回滚，保证内存与断点表的一致性——不会出现内存里 patch 了、断点表里却没有记录，导致将来无法还原的情况；
- 读取失败（地址未映射、权限不足等）和写入失败都会带上 pid、实际字节数、底层错误返回，方便排查；
- 返回前用 `toAPIBreakpoint` 把内部 `*Breakpoint` 转成 `*api.Breakpoint`，内部结构不暴露给client侧。

还有 `Breakpoints` 切片、`Len/Less/Swap` 排序接口和 `ListBreakpoints`，以及 `pkg/target/breakpoint_test.go` 中"编号单调递增""按 ID 排序"的相关逻辑。它们服务的是 6.7 节"列出断点"：`map` 遍历无序，要按编号输出就得先收集成切片再排序。这部分代码在本节跟随文件一起落位，6.7 节再展开。

#### 反汇编配合：`--clearall` 还原断点

断点一 add，`disass` 读到的首字节就是 `0xCC`，输出会变成 `int3` 且指令错位。6.5 节末尾把这件事留到了本节，现在补上。命令层给 `disass` 增加一个 `--clearall` 选项：

```go
var disassCmd = &cobra.Command{
	Use:     "disass [address]",
    ...
	RunE: func(cmd *cobra.Command, args []string) error {
        ...
		clearall, _ := cmd.Flags().GetBool("clearall")

		var insts []api.AsmInstruction
		if clearall {
			insts, err = Client.DisassembleWithBreakpointCleared(addr, max, syntax)
		} else {
			insts, err = Client.Disassemble(addr, max, syntax)
		}
		if err != nil {
			return err
		}
        ...
    }
}

func init() {
	debugRootCmd.AddCommand(disassCmd)
    ...
	disassCmd.Flags().Bool("clearall", false, "反汇编时排除已有断点的影响")
}
```

不带 `--clearall` 时仍然是 6.5 节的行为：读到什么解什么，断点处显示 `int3`；带了才走还原逻辑。目标层的 `pkg/target/disassemble.go` 增加的方法如下：

```go
// DisassembleWithBreakpointCleared 智能反汇编：临时还原内存区域内的所有
// 断点指令后再反汇编，使输出与原始指令一致。
//
// 添加断点后（ch6.6），断点处的指令首字节已被替换为 0xCC，直接反汇编会
// 看到 int3。本方法在读取到的数据副本上还原这些字节，不影响进程内存。
func (p *DebuggedProcess) DisassembleWithBreakpointCleared(addr, max uint64, syntax string) ([]api.AsmInstruction, error) {
	// 读取足够的内存数据用于反汇编
	dat := make([]byte, 1024)
	n, err := p.peekMemory(uintptr(addr-1), dat)
	if err != nil || n == 0 {
		return nil, fmt.Errorf("peek text error: %v, bytes: %d", err, n)
	}

	// 目标地址处恰是断点，则还原其原始指令并从目标地址开始
	if dat[0] == 0xcc {
		bp, ok := p.Breakpoints[uintptr(addr-1)]
		if ok {
			dat[0] = bp.Orig
			addr--
		} else {
			dat = dat[1:]
			n--
		}
	} else {
		dat = dat[1:]
		n--
	}
	p.restoreOrigInstructionAtBp(addr, dat[:n])

	// 在恢复后的数据上进行反汇编
	return p.disassembleData(addr, dat[:n], max, syntax)
}

// restoreOrigInstructionAtBp 将数据中属于调试器断点的 0xCC 还原为原始指令
func (p *DebuggedProcess) restoreOrigInstructionAtBp(startAddr uint64, data []byte) {
	for i := 0; i < len(data); i++ {
		if data[i] != 0xcc {
			continue
		}
		// 检查这个 0xcc 是否是调试器添加的断点
		addr := uintptr(startAddr + uint64(i))
		bp, exists := p.Breakpoints[addr]
		if !exists {
			continue
		}
		// 恢复断点处原指令数据
		data[i] = bp.Orig
	}
}
```

这段代码要结合实际场景看：

- 读取窗口从 `addr-1` 开始，而不是从 `addr` 开始，为的是先看一眼"`addr` 前一个字节是不是断点"。这正是 6.5 节讲的：命中断点后 PC = 断点地址 + 1，此时无参 `disass` 的起点是 PC，如果 PC-1 处有断点，真正要反汇编的起点是 PC-1；
- `dat[0] == 0xcc` 且 `p.Breakpoints[addr-1]` 存在时（代码注释里说的"目标地址"就是这个 `addr-1`），把 `dat[0]` 还原成 `Orig`、`addr--`，于是反汇编从断点地址开始。这样停在断点上时，不指定address的disass操作也能看到原始指令；
- 如果 `addr` 前一个字节不是断点，或没有登记过，说明addr-1处不是断点指令，那么把多读的那 1 字节丢掉，起点仍然是 `addr`；
- `restoreOrigInstructionAtBp` 扫描读到的数据窗口（`dat[:n]`，最多 1024 字节），遇到 `0xCC` 就去断点表里按地址查：登记过断点才还原，没登记过就保留——目标程序里本来就有大量 `int3` 填充，不能把那些也改掉；
- 所有还原都只发生在 `peekMemory` 读出来的**数据副本**上，不会 POKE 回目标进程。反汇编是只读操作，目标进程内存里的 `0xCC` 必须保留，`continue` 还要靠它命中。

### 运行效果

在 godbgv2 仓库里切到这一节，把调试器和 fixture 都构建出来：

```bash
git checkout ch6.6
make build
make fixtures
```

`make build` 产出 `./godbg`，`make fixtures` 把 `examples/debuggee` 下的示例程序编到 `_fixtures/`，编译时带 `-gcflags "all=-N -l"`，不做优化、不做内联。本节仍然用 `_fixtures/loop` 做目标程序，`readelf -h _fixtures/loop` 可以看到它的入口地址是 `0x478120`；`objdump -d _fixtures/loop --start-address=0x478120` 可以看到入口处的指令：

```bash
$ objdump -d _fixtures/loop --start-address=0x478120
  478120:	e9 bb c8 ff ff       	jmpq   4749e0 <_rt0_amd64>
  478125:	cc                   	int3
  478126:	cc                   	int3
  ...
```

入口是一条跳转到 `_rt0_amd64` 的 jmp，后面是 `int3` 填充。`0x4749e0` 就是 `_rt0_amd64` 的地址，下面我们会在入口和这个地址上各下一个断点来观察效果。

启动调试会话，先看看添加断点之前的反汇编，然后添加断点、再反汇编：

```bash
$ ./godbg exec _fixtures/loop
process 1833408 launched, stopped by SIGTRAP
godbg> disass 0x478120 -n 3
0x478120:	e9 bb c8 ff ff	jmpq 0xffffffffffffc8c4
0x478125:	cc	int3
0x478126:	cc	int3
godbg> break 0x478120
breakpoint 1 added at 0x478120
godbg> disass 0x478120 -n 3
0x478120:	cc	int3
0x478121:	bb c8 ff ff cc	mov $-0x33000038,%ebx
0x478126:	cc	int3
godbg> break 0x4749e0
breakpoint 2 added at 0x4749e0
godbg> disass 0x4749e0 -n 4
0x4749e0:	cc	int3
0x4749e1:	8b 3c 24	mov (%rsp),%edi
0x4749e4:	48 8d 74 24 08	lea 0x8(%rsp),%rsi
0x4749e9:	e9 12 00 00 00	jmpq 0x1b
godbg> b 0x478120
breakpoint 1 added at 0x478120
godbg> disass 0x478120 -n 3 --clearall
0x478120:	e9 bb c8 ff ff	jmpq 0xffffffffffffc8c4
0x478125:	cc	int3
0x478126:	cc	int3
godbg> disass 0x4749e0 -n 4 --clearall
0x4749e0:	48 8b 3c 24	mov (%rsp),%rdi
0x4749e4:	48 8d 74 24 08	lea 0x8(%rsp),%rsi
0x4749e9:	e9 12 00 00 00	jmpq 0x1b
0x4749ee:	cc	int3
godbg> exit
tracee is run by tracer, kill it
```

观察一下这段输出：

- 添加断点之前，`0x478120` 处是 `e9 bb c8 ff ff`，即 5 字节的 jmp；添加断点后首字节变成 `cc`，反汇编的第一条成了 `int3`，这直接证明了 `break` 已经把目标进程内存 patch 了；
- patch 之后从 `0x478121` 开始的解码被破坏：`bb c8 ff ff` 本来是入口 jmp 的 4 字节相对偏移（rel32），现在 `bb` 被当成 mov 的操作码、`c8 ff ff cc` 被当成 32 位立即数，连同填充字节 `cc` 一起解成 `mov $-0x33000038,%ebx`，下一条指令的起点也挪到了 `0x478126`。这说明断点必须落在指令的起始地址上，否则反汇编、执行都会乱套；
- 第二个断点下在 `0x4749e0`（`_rt0_amd64`）后，从 `0x4749e1` 开始解码：`8b 3c 24` 少了 REX 前缀，`mov (%rsp),%rdi` 变成了 `mov (%rsp),%edi`；后面几条恰好又恢复了字节对齐，所以只有第一条呈现异常。这个例子也说明，断点导致的错位不一定整段都乱，光看某几条指令未必能发现，必须结合断点表还原；
- `--clearall` 之后两条反汇编都恢复成了原始指令：`0x478120` 回到 5 字节 jmp，`0x4749e0` 回到带 REX 前缀的 `mov (%rsp),%rdi`，且 `0x4749ee` 处真正的 `int3` 填充保留了下来（它没有登记为断点）；
- 重复执行 `b 0x478120` 时输出 `breakpoint 1 added at 0x478120`，编号仍然是 1：按地址去重生效，没有产生第二个断点。输出文案和首次添加一样，是当前实现的观感问题，读者通过编号就能判断是不是新建的；
- `jmpq` 后面的目标地址看起来不像正常地址，是 6.5 节 ps 里解释过的 `x86asm.PCRel` 用法问题，不影响指令地址和机器码的展示，这里不再重复。

本节的冒烟脚本 `testdata/script/ch6.6.txt` 把上面的关键行为固化了下来：

```text
# ch6.6 smoke: 添加断点，并验证断点对反汇编的影响与还原
# 入口地址 0x478120 取自 readelf -h _fixtures/loop（固定工具链构建，地址固定）
break 0x478120
=breakpoint 1 added at 0x478120
# 断点已替换指令首字节，反汇编将看到 int3
disass 0x478120
=int3
# --clearall 还原断点影响后，输出原始指令
disass 0x478120 --clearall
=0x478120:.*e9
```

`=` 开头的行是冒烟测试的断言：先断言断点添加成功，再断言默认反汇编能看到 `int3`，最后在 `--clearall` 之后断言该行是原始指令 `e9`。按 6.4 节的约定，断言只核对"最近一条 godbg 命令"的输出：回放器在执行每条命令前打印 `godbg> `，smoke.sh 按这个回显标记把会话输出切成逐命令片段，前面命令已经打印的文本不参与后面的断言。所以最后一条核对的就是 `disass 0x478120 --clearall` 自己的输出，不会被前面不带 `--clearall` 的 `disass` 污染。

断言模式用 `=0x478120:.*e9` 而不是只写 `=0x478120:`，是为了真正区分两种状态：断点生效时该行是 `0x478120: cc int3`，还原后才是 `0x478120: e9 bb c8 ff ff ...`；只断言地址前缀的话，即使还原失败也照样匹配。把这条断言挪到不带 `--clearall` 的 `disass` 后面，冒烟测试就会失败，正好说明它校验的是"还原"这一行为。

运行：

```bash
$ make smoke S=ch6.6
smoke: running testdata/script/ch6.6.txt
smoke: all passed
```

（`make smoke` 会先构建 godbg 和 fixtures，这里的输出省略了构建日志。）会话退出时仍然走 6.4 节注册的清理逻辑，exec 启动的 tracee 被 kill，终端上会看到 `tracee is run by tracer, kill it`。

### 更多相关内容

**静态断点。** 除了调试器动态 patch，也可以在程序里静态地下断点：Go 的 `runtime.Breakpoint()` 在 x86-64 上就是一条 `INT 3` 指令，在 Go 汇编（`.s`）或 C 内联汇编里写 `INT $3` 效果一样。这类断点的生命周期是整个程序设计期间，实现简单，但位置固定、无法按调试需要增删，一般用于"我记得这里要停一下"的硬编码调试场景。本节实现的是动态断点，两者共用 `0xCC` 这一套机制。

**硬件断点。** x86-64 提供 DR0~DR3 四个调试地址寄存器，DR7 控制它们的使能、断点类型（执行/写/读写）和长度。通过 `ptrace(PTRACE_POKEUSER, ...)` 把地址写进 DR0~DR3、把控制字写进 DR7，就能让处理器在命中地址时停住。硬件断点不需要修改目标进程内存、不要求地址落在指令边界上，还能监听内存访问（watchpoint）；代价是数量有限（最多 4 个），而且调试寄存器属于线程上下文，多线程程序里要逐个线程设置。软件断点实现简单、数量不受限，是调试器最常用的方案，硬件断点一般留给 watchpoint 这类软件断点做不到的场景。

**指令 patch 的其他用途。** 把函数入口首字节替换成跳转或其他指令，可以用来做函数 mock（gomonkey 等测试框架）、性能插桩、软件逆向分析中的代码改写。这些场景和断点用的是同一类技术：先保存原始字节，再 patch，最后负责还原。

**当前实现的边界。** 本节只处理主线程（`p.Process.Pid`）的断点，多线程程序里每个线程的断点需要分别管理，6.17.5 节扩展"多线程断点"时再补齐；`break` 只接受指令地址，符号级断点要等第 9 章；断点创建后目前都是启用状态，还没有禁用/启用、条件断点、临时断点这些能力，它们属于符号级调试器的内容，9.2.21、9.2.23、9.2.24 节再展开。

### 本节小结

本节实现了指令级调试的断点添加命令 `break`：

- `break <address>` 支持 `0x` 十六进制、十进制、`0` 八进制地址（复用 `parseAddress`），`b`、`breakpoint` 是别名；源码位置断点留到 9.2.21~9.2.24 节；
- 软件断点的原理是把指令首字节 patch 成 `int 3`（`0xCC`）：先 PEEK 保存原始字节到 `Orig`，再 POKE 写入 `0xCC`，同时登记断点信息；POKE 失败会回滚断点表，保证内存与记录一致；
- `DebuggedProcess` 增加按地址、按编号两张断点索引：地址索引负责重复添加时的 O(1) 判重、`--clearall` 的按地址还原，以及 `continue`（6.12）命中后还原指令；编号索引供 `clear -n <id>`（6.8）使用；编号从 1 开始单调递增；
- `api.Client` 增加 `AddBreakpoint`、`DisassembleWithBreakpointCleared`，`api.Breakpoint` 作为服务层值类型（`Addr` 用 `uint64`，平台相关的 `uintptr` 转换由门面和目标层完成）；`debugger` 门面做类型转换、转发与空指针检查；
- `disass --clearall` 兑现了 6.5 节留下的"断点位置反汇编"：从 `addr-1` 读窗口、识别 `addr-1` 处是否为断点并回退起点、在数据副本里按断点表还原窗口内的 `0xCC`，不修改目标进程内存；不带的 `disass` 仍按原始内存内容反汇编；
- 用 `_fixtures/loop` 实际验证了 patch 效果、指令错位、`--clearall` 还原、按地址去重，并固化成冒烟脚本 `testdata/script/ch6.6.txt`（`make smoke S=ch6.6` 通过）。

下一节实现 `breakpoints` 命令，把已添加的断点按编号列出来；再往后是 `clear` 移除断点、`continue` 运行到断点。断点的"增、查、删、命中"闭环就完整了。

### 参考文献

1. ptrace(2) - Linux manual page, https://man7.org/linux/man-pages/man2/ptrace.2.html
2. INT3/INT n - Intel 64 and IA-32 Architectures Software Developer's Manual, https://www.felixcloutier.com/x86/intn:into:int3:int1
3. gomonkey - monkey patch library for Go, https://github.com/agiledragon/gomonkey
