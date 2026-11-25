## Breakpoint part1: 断点精细化管理

### 前言

断点是调试器最核心的能力之一。在介绍指令级调试器时，我们已经拆解过它的底层机制：断点处的指令首字节被替换为 `0xCC`（`int3`），进程执行到这里触发 `#BP` 异常，内核把异常翻译成 `SIGTRAP` 并唤醒阻塞在 `wait4` 上的 tracer。如果印象已经模糊，建议先翻回 [第6章 动态断点](../../6-develop-inst-debugger/7-breakpoint.md) 快速回顾。

前面几节补齐了三块前置知识：locspec（9.2.19）把函数名、`file:line`、`*addr`、`+N/-N`、`/regexp/` 解析成指令地址（`pkg/proc/location.go:19`）；表达式求值（9.2.18）让条件断点在命中后决定停还是继续；行号表正反向查询（9.2.20）提供 `PCToLine` 与 `LineToPC`。

本节回答一个更上层的问题：**从"在 `main.go:16` 设一个断点"到"在 `0x4b3971` 处写入一个 `0xCC`"，中间隔着哪些概念？** 答案分三层：逻辑断点（用户视角）、物理断点（指令补丁）、Breaklet（同一地址上的重叠登记）。然后讨论软件断点与硬件断点的分工，以及"一个线程停下，其他线程怎么办"。

先交代边界。godbgv2 是**单进程、all-stop** 的调试器：没有多进程跟踪、没有断点传播、没有 follow-exec、没有 suspended 断点，Breaklet 也没有回调。本节早期版本以 tinydbg（delve 的裁剪版）为参考、按 delve 的多进程模型讲述；这一版按 godbgv2 的真实代码重写，delve 侧的能力只在最后列成范围对照，避免读者把"别的调试器有"误读成"godbgv2 有"。本节代码路径均相对 godbgv2 仓库根目录；代码片段为控制篇幅做了删节，只保留与主线相关的语句，标注的文件与行号可用于对照完整实现。

### 定点停车的艺术

坐地铁时，列车车门总能与站台精准对齐，靠的是"定点停车"。调试器做的是同一件事：把线程停在你指定的位置，而不是"大概附近"。

locspec 能描述位置，但对源码位置而言，一行源码可能对应多个表达式、多条语句，编译后就是多条机器指令。**这一行该在哪条指令上下断点？** 答案来自 DWARF 行号表的关键设计 `is_stmt` 标记：哪些地址适合作为语句边界，编译器生成指令时已经确定，并写进 `.debug_line`。调试器不必自己分析控制流，照抄编译器的判断即可——这就是"定点停车"的车位线。

godbgv2 有一个容易被忽略的细节：**筛选发生在 DWARF 解析阶段，而不是断点解析阶段**。`LineEntry` 只有三个字段（`pkg/dwarf/line.go:21`）：

```go
type LineEntry struct {
	File    string // 源文件
	Line    int    // 行号
	Address uint64 // 对应的机器地址
}
```

`is_stmt` 是行号程序状态机的私有寄存器，`emitRow` 在产出行记录时直接丢弃非语句行（`pkg/dwarf/line.go:628`）；等 `FindLocation` 或 `LineToPC` 看到 `Rows()` 时，表里已经只剩语句行。一个常见的说法是"解析 locspec 时用 `is_stmt` 筛选候选地址"，这个动作在 godbgv2 里确实发生了，只是提前到了解析器内部；代价是 `LineEntry` 不再暴露这个字段，查询侧无法二次判断。

定点停车的另一半是"选哪一条"。`LineToPC` 的做法很朴素（`pkg/dwarf/line.go:50`）：全表线性扫描、文件按后缀匹配、**返回第一条命中的行记录**。这解释了实测中 `break main.go:16` 为何落在 `0x4b3971`——它是行号表里第一条 `Line==16` 且文件名后缀匹配的记录。朴素也意味着边界：同一个 `file:line` 若在多处出现（泛型实例化、函数内联都会造成复制），只会给第一个地址下断点，其余副本漏掉。这个问题放到"逻辑断点 vs 物理断点"一节展开。

#### 在函数入口下断点：Go 的栈扩容

函数入口是定点停车最容易翻车的地方。Go 的 goroutine 栈按需增长，编译器会在每个函数序言插入栈检查；栈不够时跳去 `runtime.morestack_noctxt`，扩容、拷栈、调整栈指针，然后**跳回函数入口重新执行**。于是一段平常的序言藏着两条路径：

```nasm
; main.main 序言的一般形状（go build -gcflags 'all=-N -l'，地址随构建而变）
cmp  rsp, qword [r14+0x10]   ; 栈还剩多少？g 结构里存着栈边界
jbe  <morestack 入口>         ; 不够 → 扩容后跳回本函数入口重来
push rbp
mov  rbp, rsp
sub  rsp, 0x28               ; 序言结束，下面是第一条源码语句
```

如果断点打在首指令 `cmp` 上，会发生两件事：**命中两次的假象**——第一次命中后调试器越过断点继续执行，栈不够就扩容，扩容完跳回入口又命中一次，用户看到"同一个函数被调用了两次"，其实只有一次；**停在了不该停的地方**——用户在函数名上下断点，预期是"进入函数体的第一条语句"，实际停在栈检查上，此时帧基址和局部变量区都还没建立。

行号表恰好把这个位置标成合法停点：`cmp` 和 `sub rsp` 之后的第一条指令，在两个不同地址上共享函数的第一行，且都带 `is_stmt`。编译器只是说"这两处都可以作为函数第一行的停点"，调试器需要选后一个。

godbgv2 目前**没有做这个选择**。`Function.Entry` 来自 DIE 的 `DW_AT_low_pc`（经 `EntryRange` 处理，`pkg/proc/funcs.go:54`），`break main.main` 直接停在这条栈检查指令上：

```text
godbg> break main.main
breakpoint 1 added at 0x4b3940 (main.go:13)
godbg> continue
thread 2101 status: stopped: trace/breakpoint trap
> main.go:13 (pc: 0x4b3941)
```

该输出可在 `testdata/script/ch9.2.22.txt` 与 `ch9.2.24.txt` 复现（`_fixtures/loop` 以 `-N -l` 构建；输出中的源码路径前缀从略）。**"在函数入口停"本身对入口断点可以接受**——首次进入就停下，符合"进入这个函数"的直觉；真正会错的是两种场景：栈扩容后重入导致的重复命中，以及用行号断点表达"执行到函数体第一句"时停在序言内部。规避方式很直接：用序言之后的源码行下断点，如 `break main.go:14`。

修复的口子已经留好：`DW_LNS_set_prologue_end` 已被解析（`pkg/dwarf/line.go:612`），但只写进状态机的私有字段 `prologueEnd`，既没有落进 `LineEntry`，也没有任何代码读取。要让"序言跳过"生效，需要把它暴露到行记录上，并在 `FindLocation` 选地址时取 `prologue_end` 之后的第一条语句行。godbgv2 没有在 `morestack` 处埋"栈扩容哨兵"断点，也没有任何 prologue-end 判断——这是需要如实说明的已知缺口，而不是已实现的行为。

### 隐式断点操作

用户执行 `break` 显式创建断点，另一些命令会隐式创建；区别在于"谁需要它"和"什么时候撤掉"。`step` 是**指令级**单步：`cmd/debug/step.go` 调 `Client.Step`，底层是 `PtraceSingleStep`（`pkg/target/step.go:12`），不需要断点。`next` 是**源码行级**单步：调试器先算"下一行"落在哪，在那里临时埋一个断点，再 continue——这正是隐式断点的典型用法。

但在 godbgv2 里 `next` 是个桩：`cmd/debug/next.go:17` 只打印 `TODO(ch9.2.28): next 尚未实现`，既不计算下一行，也不设断点。因此 `NextBreakpoint` 虽然定义了，却**没有任何生产者**。真正在生产中使用隐式断点的是 `stepout`（`pkg/proc/backtrace.go:118`）：按 Go 调用约定，返回地址保存在被调函数的 `CFA-8` 处；取到后在那里设一个步进类临时断点，continue 过去，停在返回地址时再清掉，对应代码如下（节选）：

```go
ra, err := t.ReturnAddress()       // 返回地址 = CFA-8
bp, err := t.SetStepBreakpoint(ra) // 生成 StepBreakpoint
stop, err := t.dbp.Continue()
// bp 用于停点判定，命中返回地址后清除，见 :137-142
```

不管显式还是隐式，最终都要经过 `createBreakpoint` → `dbp.AddBreakpoint` 落到一个 `0xCC` 补丁，差别只在 `Kind` 与生命周期。

#### 隐式断点的分类：5 种 Kind

隐式断点和用户断点可能落在同一地址，调试器必须能区分"这个断点是谁要的、为什么"，否则无法决定命中优先级和清理时机。godbgv2 用位集表达类型（`pkg/proc/breakpoints.go:12`）：

```go
type BreakpointKind uint16

const (
	UserBreakpoint       BreakpointKind = 1 << iota // break 命令创建
	NextBreakpoint                                  // next 命令隐式创建（预留）
	StepBreakpoint                                  // step 命令隐式创建（stepout 在用）
	TracepointBreakpoint                            // trace 命令创建的跟踪点
	WatchBreakpoint                                 // watch 命令创建的监视点（预留）

	steppingMask = NextBreakpoint | StepBreakpoint // 步进类：允许与其他断点重叠
)
```

只有 5 种，与使用现状一一对应：

| Kind | 值 | 生产者 | 现状 |
| --- | --- | --- | --- |
| `UserBreakpoint` | `1<<0` | `break` → `CreateBreakpointByLoc` | 在用 |
| `NextBreakpoint` | `1<<1` | 无 | 预留（`next` 是桩） |
| `StepBreakpoint` | `1<<2` | `stepout` 的 `SetStepBreakpoint` | 在用 |
| `TracepointBreakpoint` | `1<<3` | `trace` 的 `SetTracepoints`（`pkg/proc/trace.go:35`） | 在用 |
| `WatchBreakpoint` | `1<<4` | 无 | 预留（`watch` 走硬件寄存器路径） |

用位集而不是枚举，是为了表达"同时属于多类"的组合。判断"能不能重叠"只做一次位与（`pkg/proc/breakpoints.go:31`）：`kind&steppingMask != 0`。`breakpoints_test.go:36` 的单测给出判定表：`User`、`Tracepoint`、`Watch` 不可重叠，`Next`、`Step` 可以，`Next|User` 这种组合也算"可以"。

### 逻辑断点 vs 物理断点

用户说的是"源码位置"，机器认的是"指令地址"，中间隔着编译器的优化。最典型的是泛型：`func Add[T ~int|~int64](a, b T) T` 被 `Add(1, 2)` 和 `Add(int64(1), int64(2))` 使用后，会为每种类型各实例化一份，同一个源码行对应两个地址。内联同理：小函数被内联到多个调用点，函数体内的同一行指令被复制多份。

用户当然不想给每个副本单独下断点，所以需要两层抽象：**逻辑断点**是用户看到的那条记录，带编号、名称、位置描述、条件、命中计数；**物理断点**是真正写进目标进程内存的一个 `0xCC` 补丁，按指令地址索引。两层分别落在 `pkg/proc` 与 `pkg/target`：

```go
// pkg/proc/breakpoints.go:48 —— 逻辑断点
type Breakpoint struct {
	ID       uint64
	Name     string
	Loc      string // locspec 原文
	Addr     uint64 // 解析后的指令地址（单地址）
	File     string
	Line     int
	Cond     string
	Kind     BreakpointKind
	HitCount uint64
	Enabled  bool
}

// pkg/target/breakpoint.go:11 —— 物理断点
type Breakpoint struct {
	ID      uint64
	Addr    uintptr
	Pos     string
	Orig    byte // 原指令首字节
	Enabled bool
}
```

**这里必须纠正一个常见直觉。** 很多材料（包括 delve 的设计）讲的是"1 个逻辑断点 → N 个物理断点"，因为一个源码位置可能对应多个地址。godbgv2 正好相反：`Breakpoint.Addr` 是单个 `uint64`，**一个逻辑断点只对应一个物理断点**；多地址被上移到创建阶段——locspec 解析出几个地址，就建几条逻辑断点（地址处已有断点时复用），每条各带一个物理断点。

创建入口在 `pkg/proc/location.go:99`：先 `FindLocation`，命名断点若命中多个地址直接拒绝，然后逐地址 `createBreakpoint`，任一失败就回滚已创建的：

```go
addrs, err := t.FindLocation(loc)
// 命名断点只能对应一个位置：多地址共名会让"按名引用"产生歧义
if name != "" && len(addrs) > 1 {
	return nil, fmt.Errorf("breakpoint name %q cannot be used for %d locations", name, len(addrs))
}
bps := []*Breakpoint{}
for _, addr := range addrs {
	bp, err := t.createBreakpoint(addr, loc, UserBreakpoint)
	if err != nil {
		for _, created := range bps { _, _ = t.ClearBreakpoint(created.ID) } // 回滚
		return nil, err
	}
	bp.Name = name
	bp.Cond = cond
	bps = append(bps, bp)
}
```

实际会返回多个地址的 locspec 只有 `/regexp/`：它遍历 `ListFunctions`，把每个匹配函数的入口都收进来（`pkg/proc/location.go:29`）；函数名、`file:line`、`*addr`、`+N/-N` 都是一个地址。所以"多条逻辑断点"最常见的来源是 `break /main\./` 这种批量下断点。

这也解释了 godbgv2 为什么不做"1:N"：位置解析层本身就是"一个 locspec → 一组地址"，每个地址独立成一条逻辑断点即可，不需要让一条逻辑断点持有多个物理地址。代价是泛型实例化、内联造成的"同一源码行多副本"没有覆盖——`LineToPC` 只返回第一条，其余副本没有断点。原理上需要"同一逻辑断点挂多个物理断点"，godbgv2 没有走到那一步。

还有一处编号陷阱：逻辑断点的 `ID` 在创建时取自物理断点（`ID: phys.ID`），但**物理断点被还原后重建时编号会变，逻辑断点编号不变**——"越过断点"的流程（还原指令 → 回退 PC → 单步 → 重新打补丁）会把物理断点整条摘掉再新建。因此清理逻辑断点时不能拿逻辑编号查物理表，只能按地址查（`pkg/proc/breakpoints.go:172`：`phys, ok := t.dbp.Breakpoints[uintptr(bp.Addr)]`）。

### 断点重叠管理：Breaklet

现在考虑：`stepout` 的返回地址，恰好是用户已经下过断点的位置，会怎样？

物理层面只能有一个 `0xCC`——同一个地址不能补两次。但语义上有两个请求：用户断点要求停下并保持；`stepout` 的临时断点要求停下、然后被清理。合并成一条逻辑断点，`stepout` 收尾时会连用户断点一起删；各建一条，又需要记录"这个地址上的补丁是两条断点共用的"。`Breaklet` 就是这本登记簿（`pkg/proc/breakpoints.go:38`）：

```go
type Breaklet struct {
	Kind      BreakpointKind // 该逻辑断点的创建来源
	LogicalID uint64         // 归属的逻辑断点编号
	Cond      string         // 激活条件（字段预留）
}
```

`Target.breaklets` 是 `map[uint64][]*Breaklet`（`pkg/proc/target.go:16`），键是地址。创建断点时先看该地址有没有物理断点（`pkg/proc/breakpoints.go:71`，节选）：

```go
if _, ok := t.dbp.Breakpoints[uintptr(addr)]; ok {
	if canOverlap(kind) {
		existing := t.breakpointByAddr(addr)
		// 步进类断点：只登记重叠单元，复用物理断点
		t.breaklets[addr] = append(t.breaklets[addr],
			&Breaklet{Kind: kind, LogicalID: existing.ID})
		return &Breakpoint{ID: existing.ID, Addr: addr, Kind: kind, Enabled: true}, nil
	}
	// 用户断点：复用既有逻辑断点（重复 break 同一位置是合法的）
	if bp := t.breakpointByAddr(addr); bp != nil {
		return bp, nil
	}
}
```

清理时对称：先摘逻辑记录与 Breaklet，只有该地址的 Breaklet 全部摘完，才还原物理补丁（`pkg/proc/breakpoints.go:157`）。这就是"物理指令只 patch 一次、逻辑请求各留一条"。

但 godbgv2 的重叠只做了一半，另一半需要如实说明：

- **没有回调，也没有 per-breaklet 条件。** `Breaklet.Cond` 是从未赋值的预留字段；真正的条件存在逻辑断点的 `Breakpoint.Cond` 上（字符串），命中后由客户端调 `Client.EvalCondition` 求值，不满足就自动继续（`cmd/debug/continue.go:116`、`pkg/service/debugger/debugger.go:323`）。判定时按 `PC-1` 找到的是该地址上的**第一条逻辑断点**（`cmd/debug/continue.go:160`），不会遍历重叠的多个 Breaklet 分别判断。
- **重叠分支复用已有逻辑断点编号，不新增逻辑断点。** `LogicalID` 直接取 `existing.ID`，返回的 `Breakpoint` 也没有加入 `t.bps`。因此 `stepout` 收尾时按这个编号调 `ClearBreakpoint`，摘除的是同址既有断点的逻辑记录与全部 Breaklet。当临时断点与用户断点真的重叠时，"只清理自己那一份"并没有做到。
- `ToggleBreakpoint` 只翻逻辑断点的 `Enabled` 并还原/重建物理补丁（`pkg/proc/breakpoints.go:240`），不检查同址是否还有其他重叠单元。

合起来说明：Breaklet 解决了"同一地址只有一个补丁"的**登记**问题，没有解决"多个请求各自判定、各自清理"的**仲裁**问题。delve 用 `callback func(...) (bool, error)` 补的正是后半件事；godbgv2 没有 callback，也没有 `on <bp> <cmd>` 这类命中后执行动作的机制。

### 软件断点 vs 硬件断点

#### 软件断点：改写一条指令

x86 的断点指令是 `0xCC`（`int3`），执行到它时 CPU 产生 `#BP` 异常（向量 3），内核捕获后向 tracee 投递 `SIGTRAP` 并唤醒 tracer。`pkg/target` 的 `(*DebuggedProcess).AddBreakpoint` 就是"读—存—改"三步（`pkg/target/breakpoint.go:52`）：

```go
if bp, ok := p.Breakpoints[addr]; ok {
	return toAPIBreakpoint(bp), nil // 该地址已有断点
}
orig := [1]byte{}
n, err = syscall.PtracePeekText(pid, addr, orig[:]) // 读原首字节
breakpoint = newBreakPoint(addr, orig[0], "-")
p.Breakpoints[addr] = breakpoint
n, err = syscall.PtracePokeText(pid, addr, []byte{0xCC}) // 改写为 int3
```

`int3` 是陷阱类异常：CPU 执行完它之后，**压栈的返回地址指向断点地址 +1**。所以线程停下时 `PC` 是 `addr+1`，整个调试器到处都要记住这个 `+1`：判断"线程停在哪个断点"要查 `PC-1`（`pkg/target/breakpoint.go:186`）；展示源码位置时先按 `PC` 查行号、失败再按 `PC-1`（`cmd/debug/location.go:16`）；清理断点时要先把停在断点上的线程 `PC` 减 1，否则恢复执行会跳过被 `0xCC` 覆盖的指令。清理顺序在代码里写得很清楚（`pkg/target/breakpoint.go:96`）：**先回退线程 PC，再还原指令**——因为还原会摘掉断点索引，之后再找"停在断点处的线程"就找不到了。

"越过断点"是这套机制的日常用法：用户 `continue` 时线程正停在断点上，必须先处理掉，否则恢复执行会立刻再次触发。顺序是四步——回退 PC、还原指令、单步执行一条指令、重新打补丁（`cmd/debug/continue.go:47`）：

```go
regs.SetPC(regs.PC() - 1) // 回退 PC
Client.WriteRegs(tid, regs)

if _, cleared := bpCleared[bpAddr]; !cleared {
	Client.RestoreInstruction(bpAddr) // 还原首字节（多线程去重）
	bpCleared[bpAddr] = struct{}{}
}
Client.Step(tid)             // 单步越过这条指令
Client.AddBreakpoint(bpAddr) // 重新打补丁
```

多线程下"还原只需一次"（`bpCleared` 去重），但"回退 PC"和"单步"必须逐线程做，因为可能多个线程都停在同一个断点上。

#### 硬件断点：调试寄存器

x86 提供 4 个调试地址寄存器 `DR0-DR3`、1 个状态寄存器 `DR6`、1 个控制寄存器 `DR7`。设置执行断点或数据监视点时，把地址写进某个空闲的 `DR0-DR3`，再在 `DR7` 里配置槽位：`L0-L3`（局部使能，位 0/2/4/6）、`R/W0-R/W3`（位 16/20/24/28，`00` 执行、`01` 写、`11` 读写）、`LEN0-LEN3`（位 18/22/26/30，监视长度）。命中后 `DR6` 的 `B0-B3` 置位，指明是哪个槽位触发，**读完必须清零**，否则恢复执行会立刻再次触发。

访问方式很特殊：调试寄存器属于内核保存的线程上下文，`ptrace` 没有专门请求，只能用 `PTRACE_PEEKUSER/POKEUSER` 读写 `struct user` 里的 `u_debugreg`。godbgv2 在 `pkg/target/hwbreakpoint.go:31` 硬编码偏移 `848`（常量 `debugRegOffset`），并自己声明了两个请求码（`:26`）：`ptracePeekUser = 3`、`ptracePokeUser = 6`。

`SetWatchpoint` 分配槽位后，对**每个被跟踪线程**都写一遍 DR 与 DR7（调试寄存器是线程级状态），DR7 在当前值上按位或，避免覆盖其他槽位（`pkg/target/hwbreakpoint.go:65`，节选）：

```go
slot, ok := p.freeWatchSlot()
if !ok {
	return nil, fmt.Errorf("no free debug register (DR0-DR3 all in use)")
}
dr7, err := p.currentDR7()           // 读当前 DR7
dr7 |= 1 << (slot * 2)               // 局部使能 Ln
dr7 |= uint64(mode) << (16 + slot*4) // R/Wn
dr7 |= 0b11 << (18 + slot*4)         // LENn
for _, thread := range p.Threads {
	p.setDebugRegister(thread.Tid, slot, uint64(addr))
	p.setDebugRegister(thread.Tid, 7, dr7)
}
```

`LENn` 固定写 `0b11`；按 Intel SDM 的编码（`00`=1、`01`=2、`10`=8、`11`=4 字节），这里监视的是 4 字节（源码注释写作"8 字节"，与编码表不符，读者以编码表为准）。对 `watch -w` 关心的"这个地址被写了"来说，4 字节粒度已经够用。

godbgv2 把执行断点（`R/W=00`）留给软件断点，硬件断点只用于 `watch`：`WatchMode` 里定义了 `WatchExecute`，但命令层只开放 `write`/`read`/`readwrite`（`pkg/service/debugger/debugger.go:198`）。x86 没有真正的"只读数据"监视，`read` 按 `readwrite` 处理。命中路径也不同：`watch` 不经过 `0xCC`，而是 `Continue` 收到 `SIGTRAP` 后读 `DR6` 判断是不是监视点（`pkg/target/continue.go:197`、`pkg/target/hwbreakpoint.go:113`）。调试寄存器还依赖内核支持：WSL2 对 `PTRACE_POKEUSER` 写 `u_debugreg` 返回 `EIO`，godbgv2 会翻译成"hardware watchpoint not supported by kernel"（`pkg/target/hwbreakpoint.go:86`）。

| 维度 | 软件断点 | 硬件断点 |
| --- | --- | --- |
| 实现 | 指令首字节改写为 `0xCC` | 调试寄存器 `DR0-DR3` |
| 触发 | `#BP`（向量 3） | `#DB`（向量 1） |
| 数量 | 不受限 | 最多 4 个 |
| 能否监视数据 | 不能 | 能（写、读写） |
| 副作用 | 改写目标进程内存 | 不改内存，改线程上下文 |
| godbgv2 中的用途 | `break`、`trace` | `watch` |

### 多进程+多线程调试

对调试器而言，被跟踪对象始终是**线程**。Linux 的线程是轻量级进程（LWP），`getpid()` 返回进程 ID，`syscall(SYS_gettid)` 返回线程 ID；`ptrace` 的 `pid` 参数指的其实是 LWP 的 pid，`/proc/<pid>/task/` 下每一项就是一个线程。

godbgv2 只跟踪一个进程，但线程数量动态变化：进程启动后 Go 运行时会创建 GC worker、sysmon 等线程；调试器用 `PTRACE_O_TRACECLONE` 自动跟踪 clone 出来的新线程，收到 `PTRACE_EVENT_CLONE` 时把新 tid 加入 `DebuggedProcess.Threads`（`pkg/target/continue.go:43`、`pkg/target/thread.go:65`）。这是内部事件，处理完要让克隆者继续跑，不能当成用户可见的停止上报。

#### 为什么是 all-stop

某个线程命中断点后，调试器可以只停这个线程（non-stop），也可以停掉整个进程（all-stop）。godbgv2 只有 all-stop，这也是 gdb、lldb、delve 的默认行为。理由有三条：

1. **状态一致**。用户停下来想看"那一瞬间"的完整状态；其他线程若继续跑，可能改内存、改变量、释放资源，看到的数据下一秒就失效。
2. **避免调试引入的竞态**。让其他线程继续跑会制造只在调试时出现的竞态，或掩盖正在找的那个竞态。
3. **单步可控**。单步时用户预期"只有当前线程走了一步"，其他线程后台自由执行会让全局状态面目全非。

#### tgkill(SIGSTOP) 挂起策略

`Continue` 的流程是：`PtraceCont` 恢复全部线程，`waitAny` 等任意线程停止，再 `suspendOtherThreads` 挂起其余线程（`pkg/target/continue.go:17`、`:212`）：

```go
for _, thread := range p.Threads { // 恢复全部线程
	p.ExecPtrace(func() error { return syscall.PtraceCont(thread.Tid, 0) })
}
if err := p.suspendOtherThreads(wpid); err != nil { // all-stop
	return nil, err
}
```

挂起用 `tgkill(SIGSTOP)` 而不是 `PTRACE_SINGLESTEP`（`pkg/target/suspend.go:19`，节选）：

```go
syscall.Tgkill(p.Process.Pid, tid, syscall.SIGSTOP)
// 短轮询消费停止事件；已停止的线程无事件可消费，稍后直接返回
for i := 0; i < 50; i++ {
	_, _, err := p.waitFastNoBlock(tid)
	time.Sleep(10 * time.Millisecond)
}
```

这两个选择都是踩坑之后定下来的：阻塞在 `futex` 里的线程可能迟迟不触发单步陷阱，用 `PTRACE_SINGLESTEP` 挂起会卡住整个流程；已经停止的线程不再产生事件，阻塞式 `wait4` 会永久挂起。

挂起带来一个副作用：调试器自己发出的 `SIGSTOP` 也会作为停止事件回到 `Continue` 的等待循环。如果把它当成"程序停了"上报，用户会看到莫名其妙的停止。所以 `Continue` 必须读 `siginfo`，按 `(si_pid, si_code)` 区分信号来源（`pkg/target/continue.go:162`，节选）：

```go
switch sig {
case syscall.SIGURG:
	forward = true // go 运行时异步抢占，原样转发
case syscall.SIGSTOP, syscall.SIGCONT:
	sender, code := p.stopSiginfo(wpid)
	if (sender == int32(os.Getpid()) && code == siTKill) || sender == 0 {
		discard = true // 自己挂起的 / 内核发起的初始停止
	}
}
```

命中 `forward` 或 `discard` 时，调试器用 `PtraceCont(wpid, resumeSig)` 让线程继续，然后 `continue` 回到等待循环。四类情形：`SIGURG`（Go 运行时抢占）转发给运行时；`SIGSTOP/SIGCONT` 且发送者是调试器自身（`SI_TKILL`，`siTKill = -6`）丢弃；`si_pid == 0`（内核发起的初始停止，如 clone 后新线程的 `SIGSTOP`）丢弃；其余信号（如外部 `kill -INT`）作为真实停止上报。最后一条 smoke 可验：`ch9.2.23.txt` 用外部 `SIGINT` 打断一个条件不满足、正在自动续跑的进程，调试器正确报告 `stopped: interrupt`。

#### 断点为什么不需要"传播"

多进程调试器里，"父进程的断点要不要在子进程生效"是个真问题，需要断点表复制和 follow-exec 策略。godbgv2 没有这个问题：只有一个进程；`0xCC` 写进**进程地址空间**的代码页，同进程所有线程共享同一份代码，物理断点天然对所有线程生效，新 clone 的线程也自动生效。所以既不需要"按线程维护断点表"，也不需要"新线程继承断点"。断点表因此挂在 `Target`（进程级）而不是 `Thread` 上，`Threads` 只用于执行控制和寄存器读写。

至于 non-stop 模式，godbgv2 没有实现，也没有 `set non-stop` 之类的开关。代价是调试并发程序时粒度较粗；但对教学实现来说，它把"线程状态一致性"这个最容易出错的维度一次性消掉了。

### delve 做过、godbgv2 没做：范围决策

前面反复提到"delve 有、这里没有"。集中列一张表，明确这是**范围决策**，不是"待办清单"，更不是"已实现"：

| 能力 | delve | godbgv2 | 说明 |
| --- | --- | --- | --- |
| 多进程跟踪 | 支持 | ❌ | 只 exec/attach 一个进程 |
| 断点传播 / follow-exec | 支持 | ❌ | 单进程，int3 天然覆盖所有线程 |
| suspended 断点 | 支持 | ❌ | 无"断点暂时不生效、稍后恢复"的机制 |
| Breaklet 回调 / `on <bp> <cmd>` | 支持 | ❌ | Breaklet 只记 `Kind`/`LogicalID` |
| 命中次数条件（`-hitcount`） | 支持 | ❌ | 有计数展示，无按次数触发 |
| trace 返回点 | 支持 | ❌ | 只在函数入口设跟踪点 |
| 序言结束跳过 | 支持 | ❌ | 见"栈扩容"一节 |
| 源码级 `next` / `stepin` | 支持 | 🅿️ / ❌ | `next` 是桩，无 `stepin`；`step` 是指令级 |
| non-stop 模式 | 支持 | ❌ | 只有 all-stop |

godbgv2 关心的是把"单进程、断点语义正确、多线程能 all-stop"这条主线走通：逻辑/物理两层、5 种 Kind、Breaklet 登记、`0xCC` 补丁与 PC 回退、硬件 watch、all-stop 挂起。这些在后面的小节里逐个命令展开：9.2.22 讲 `break` 与 `continue` 的完整链路，9.2.23 讲条件与命中计数，9.2.24 讲 `breakpoints`/`clear`/`toggle`，9.2.25 与 9.2.26 分别讲 `trace` 和 `watch`。

### Put it Together

把上面的概念叠起来，godbgv2 的断点体系是三层：

```text
Target（pkg/proc，一个被调试进程）
├── bps []*Breakpoint                     逻辑断点：Loc/File/Line/Cond/Kind/HitCount/Enabled
├── breaklets map[uint64][]*Breaklet      地址 → 重叠单元（Kind/LogicalID）
└── dbp *target.DebuggedProcess
    ├── Breakpoints map[uintptr]*Breakpoint     物理断点：Addr/Orig（0xCC 补丁）
    ├── BreakpointsByID map[uint64]*Breakpoint  物理断点按编号索引
    └── Threads map[int]*Thread                 线程集合（all-stop 范围）
```

一条 `break main.go:16` 的路径：

```text
cmd/debug/break.go:65   Client.CreateBreakpoint("main.go:16", "", "")
  → debugger.CreateBreakpoint          （pkg/service/debugger/debugger.go:103）
  → proc.Target.CreateBreakpointByLoc  （pkg/proc/location.go:99）
  → FindLocation → LineToPC             （返回 0x4b3971）
  → createBreakpoint                    （建立逻辑断点 + Breaklet）
  → dbp.AddBreakpoint                   （PeekText 存 Orig，PokeText 写 0xCC）
```

一次命中的路径：

```text
int3 → #BP → SIGTRAP → wait4 返回
  → Continue 挂起其余线程，返回 StopInfo{PID, Reason}
  → debugger.Continue 按 PC-1 找到逻辑断点，HitCount++
  → cmd/debug/continue.go：findBreakpointAt(PC-1) → checkAutoResume
      ├─ 条件不满足 → 越过断点，自动 continue
      ├─ 跟踪点     → 打印位置，自动 continue
      └─ 普通断点   → printLocation(PC, PC-1) 后停下
```

三层各管一件事：逻辑断点管"用户要什么"，物理断点管"机器怎么停"，Breaklet 管"同一地址上都有谁在要"。命令层只经 `api.Client` 访问后端，不碰 DWARF、不碰 ptrace——这也是 9.2.16 之后各节一直遵守的分层。

一处实测细节值得记住：`break main.go:16` 命中后展示的位置是 `main.go:16`、`pc: 0x4b3972`，`pc` 比断点地址大 1。这就是 `int3` 留下的痕迹，也是整节反复强调 `PC-1` 的原因。

### 本节小结

本节围绕 godbgv2 的真实实现，梳理了断点从"源码位置"落到"指令补丁"的三层模型：

- **定点停车**依赖 DWARF 的 `is_stmt`；godbgv2 在行号表解析阶段就丢弃非语句行，`LineToPC` 取第一条匹配地址。函数入口断点会停在栈检查指令上，因为 `Function.Entry` 就是 `DW_AT_low_pc`，而 prologue-end 信息被解析后丢弃——这是已知缺口，规避方式是改用序言之后的源码行。
- **隐式断点**目前只有一个真实生产者：`stepout` 在 `CFA-8` 返回地址处设 `StepBreakpoint`。`next` 仍是桩，`NextBreakpoint` 只有定义。5 种 `BreakpointKind` 用位集表达，`steppingMask` 决定哪些类型允许重叠。
- **逻辑断点与物理断点**是 1:1，不是 1:N：多地址被上移到创建阶段，`/regexp/` 命中几个函数就建几条逻辑断点。物理断点重建后编号会变，清理只能按地址查。
- **Breaklet** 登记同一地址上的重叠请求，保证物理补丁只打一次；但没有 callback、没有 per-breaklet 条件、重叠清理也不彻底，这些是范围边界。
- **软件断点**改写 `0xCC`，命中时 `PC=地址+1`，越过断点要回退 PC 并走"还原→单步→重打"；**硬件断点**用 `DR0-DR3/DR6/DR7`，godbgv2 只用于 `watch`，最多 4 个且依赖内核支持。
- **多线程**只有 all-stop：`tgkill(SIGSTOP)` 挂起其余线程，再用 `siginfo` 把"自己挂起的停止"与"外部信号"区分开。单进程 + 共享代码页意味着断点不需要传播。

下一节（9.2.22）沿着 `break` 与 `continue` 的命令链路，把本节的三层模型落到具体代码：断点怎么创建、执行到断点后怎么越过、停下来的位置怎么展示。
