## Breakpoint - part4: 查询、清理与开关断点

[9.2.22](./22-debug_breakpoint_part2.md) 把「下断点 → 继续执行 → 命中停下 → 再继续越过」这条链路从命令层一直讲到了 `ptrace`：`break` 把 locspec 解析成地址、在地址上写 `0xCC`，`continue` 负责恢复线程并符号化地展示命中位置。断点建起来之后还剩三件事：**看**（有哪些断点、各命中几次、哪个被关了）、**删**（删一个或全删）、**开关**（临时让断点失效但保留它）。本节讲这四条命令：`breakpoints`、`clear`、`clearall`、`toggle`。

范围先如实交代。`toggle` 是 tag `ch9.2.24` 的增量：`git show ch9.2.24 --stat` 的代码增量集中在 `cmd/debug/toggle.go`、`pkg/proc/breakpoints.go` 里的 `ToggleBreakpoint`、`api.Client` 契约与门面转发，另加冒烟脚本 `testdata/script/ch9.2.24.txt`；`breakpoints`/`clear`/`clearall` 的命令层早在 [6.8 `breakpoints`](../../6-develop-inst-debugger/8-breakpoints.md)、[6.9 `clear`](../../6-develop-inst-debugger/9-clear.md)、[6.10 `clearall`](../../6-develop-inst-debugger/10-clearall.md) 就实现了。所以本节不重写这三条命令，只做符号级接线与语义补充，补第 6 章讲不到的两件事（`break`/`continue` 全链路不重复，见 9.2.22）：

后端换成符号级的**逻辑断点表**以后，同样三条命令的调用链与语义变化；清理、开关断点时，逻辑记录、物理补丁、线程 PC 三者如何配合。

物理层的「还原指令 + 回退 PC」在 [6.18.5 断点移除](../../6-develop-inst-debugger/18-multithread/5-breakpoint.md) 已从头拆过，本节只引用结论，不再重讲 `ptrace`；`break` 的创建与 `continue` 的命中判定见 [9.2.22](./22-debug_breakpoint_part2.md)，条件见 [9.2.23](./23-debug_breakpoint_part3.md)。本节代码路径相对 godbgv2 仓库根目录；代码块为控制篇幅删去了与主线无关的语句。

### 实现目标

四条命令的形态：

| 命令 | 形态 | 语义 |
|---|---|---|
| `breakpoints` | `breakpoints`（别名 `bp`、`bs`） | 按编号列出全部**逻辑断点** |
| `clear` | `clear -n <id>` | 删掉一条断点：逻辑记录 + 地址上的物理补丁 |
| `clearall` | `clearall` | 删掉全部断点 |
| `toggle` | `toggle <id>` | 翻转启用状态：关掉补丁但**保留**逻辑记录 |

命令层只依赖 `api.Client` 接口；背后是 `debugger.Debugger` 门面（`pkg/service/debugger/debugger.go:695` 有编译期断言 `var _ api.Client = (*Debugger)(nil)`），门面持有 `t *proc.Target`（`debugger.go:19-21`），逻辑断点表就是 `Target.bps`、重叠登记在 `Target.breaklets`（`pkg/proc/target.go:15-16`）。四条链路是：

```text
breakpoints：Client.ListBreakpoints → Debugger.ListBreakpoints → Target.Breakpoints → toAPIBreakpoint
clear：      Client.ClearBreakpoint(id) → Debugger.ClearBreakpoint → Target.ClearBreakpoint
             → DebuggedProcess.ClearBreakpoint（回退 PC → 还原指令）
clearall：   Client.ClearAll → Debugger.ClearAll → Target.ClearAll
             → DebuggedProcess.ClearAll（记录停在断点处的线程 → 逐个还原 → 回退 PC）→ 清空逻辑表
toggle：     Client.ToggleBreakpoint(id) → Debugger.ToggleBreakpoint → Target.ToggleBreakpoint
             → 关闭：DebuggedProcess.ClearBreakpoint；开启：DebuggedProcess.AddBreakpoint
```

断点编号由 `pkg/target/breakpoint.go:21` 的包级 `bpSeqNo` 分配：`newBreakPoint` 里 `bpSeqNo++` 后赋给物理断点，逻辑断点建点时复用同一编号。编号从 1 开始、只增不减，`clear`/`clearall` 都不回收，下一次 `break` 拿到更大的号。

要特别记住：**逻辑编号与物理编号不是永远相等**。`continue` 越过断点时会「还原 → 回退 → 单步 → 重打补丁」（9.2.22），重打由 `AddBreakpoint` 分配新的物理编号，逻辑记录原地不动。于是物理层出现「同一个地址、新的物理 ID」，这是 `clear` 实现里一个必须绕开的坑。四条命令对三个层次的影响可以并排看：

| 操作 | 逻辑记录 `t.bps` | 物理补丁 `dbp.Breakpoints` | 线程 PC 回退 | 编号 |
|---|---|---|---|---|
| `clear` | 删除该条 | 地址上无重叠断点时还原 | 物理层做 | 记录删除，号段不复用 |
| `clearall` | 全部清空 | 全部还原 | 物理层统一做 | 记录全删，号段不复用 |
| `toggle` 关 | 保留，`Enabled=false` | 还原 | 物理层做 | 不变 |
| `toggle` 开 | 保留，`Enabled=true` | 重建（新物理编号） | 不需要 | 不变 |

一句话概括本节的四个不变量：`breakpoints` 只读逻辑表；`clear` 是「逻辑 + 物理」的成对删除；`clearall` 是成对删除的批量版本，顺序不能反；`toggle` 只动物理补丁、逻辑记录始终保留。

### 代码实现: `breakpoints`

**file：cmd/debug/breakpoints.go:26-43（RunE 内的循环片段）**

```go
// bps, err := Client.ListBreakpoints()；错误与空表分支从略
// 断点已按编号升序排列（issue #15）
for _, b := range bps {
	info := fmt.Sprintf("breakpoint[%d] addr:%#x, loc:%s", b.ID, b.Addr, b.Pos)
	if b.Name != "" {
		info += fmt.Sprintf(", name:%s", b.Name)
	}
	if b.Cond != "" {
		info += fmt.Sprintf(", cond:%q", b.Cond)
	}
	if b.HitCount > 0 {
		info += fmt.Sprintf(", hit:%d", b.HitCount)
	}
	if !b.Enabled {
		info += ", disabled"
	}
	if b.Tracepoint {
		info += ", tracepoint"
	}
	fmt.Println(info)
}
```

输出一行一个断点，字段顺序固定为「编号、地址、位置、可选字段」。几个容易看漏的细节：

- `loc:` 打印的不是创建时写的 locspec 原文（那在 `api.Breakpoint.Loc`，这条命令没输出），而是 `Pos`。`Pos` 由门面 `toAPIBreakpoint` 用 `PCToLine` 的结果拼成，所以是**绝对路径 + 行号**，例如 `.../examples/debuggee/loop/main.go:13`；建点时 `PCToLine` 失败则 `File` 为空、`Pos` 也为空，这一行会以 `loc:` 结尾。
- `name:` 不加引号，`cond:` 用 `%q` 加引号，`hit:` 只在计数大于 0 时出现，`disabled` 只在 `Enabled=false` 时出现，`tracepoint` 是 `Kind` 里带 `TracepointBreakpoint` 的标记（9.2.25）。
- 空列表不是静默成功，而是明确打印 `no breakpoints`。

排序与编号。命令层注释说「已按编号升序排列」，但这段代码自身没有排序动作；顺序来自 `Target.Breakpoints()` 对 `t.bps` 的追加顺序，而编号由 `bpSeqNo` 单调递增，创建顺序与编号顺序一致。真正显式 `sort.Sort` 的是物理层的 `DebuggedProcess.ListBreakpoints()`（`pkg/target/breakpoint.go:225-238`），但命令走的不是它——物理视图没有 `name/cond/hit/disabled` 这些用户语义。**同一套「列出断点」在两层各有一个方法，返回类型也不同**（`[]*proc.Breakpoint` 与 `[]api.Breakpoint`），读的是逻辑表才能看到开关状态。

门面 `toAPIBreakpoint`（`pkg/service/debugger/debugger.go:215-232`）把逻辑断点原样搬成契约类型：`ID/Addr/Name/Loc/File/Line/Cond/HitCount/Enabled` 直接复制，`Tracepoint` 由 `bp.Kind&proc.TracepointBreakpoint != 0` 算出，`Pos` 则单独拼：

```go
if bp.File != "" {
	out.Pos = fmt.Sprintf("%s:%d", bp.File, bp.Line)
}
```

跑起来看一次带全部可选字段的输出：

```text
godbg> break -n mainbp main.main if 1 == 1
breakpoint 1 added at 0x4b3940 (.../loop/main.go:13), name "mainbp", cond "1 == 1"
godbg> continue
thread 2061492 status: stopped: trace/breakpoint trap
> .../loop/main.go:13 (pc: 0x4b3941)
godbg> toggle 1
breakpoint 1 disabled
godbg> breakpoints
breakpoint[1] addr:0x4b3940, loc:.../loop/main.go:13, name:mainbp, cond:"1 == 1", hit:1, disabled
```

`hit:1` 来自 9.2.23：`Debugger.Continue` 返回后，如果停止线程的 `PC-1` 落在某个逻辑断点上，就调 `Target.NoteBreakpointHit` 累加一次（`debugger.go:323-341`）。`breakpoints` 只是把这几个字段按固定顺序拼出来，不做任何计算。

### 代码实现: `clear` 与 `clearall`

`clear` 的完整形态是 `clear -n <id>`，编号通过 **flag** 传，不是位置参数（**file：cmd/debug/clear.go:16-29**）：

```go
id, err := cmd.Flags().GetUint64("n") // flag 读取的错误分支从略
bp, err := Client.ClearBreakpoint(id)
if err != nil {
	return fmt.Errorf("移除断点失败: %v", err)
}
fmt.Printf("breakpoint %d at %#x cleared\n", bp.ID, bp.Addr)
```

flag 定义在 `cmd/debug/clear.go:35`：`clearCmd.Flags().Uint64P("n", "n", 1, "断点编号")`。两个后果必须讲清楚：

- 按 delve 的习惯写 `clear 2`，位置参数会被 cobra 原样收下、但 `RunE` 根本不读，实际清除的是 `-n` 的默认值 **1**。这不是理论推演，实测 `clear 2` 在只有两条断点时清掉了 1 号，留下 2 号。`Use: "clear -n <id>"` 是唯一的正确写法。
- `-n` 默认值是 1，所以裸执行 `clear` 等于 `clear -n 1`。断点 1 已不存在时得到 `移除断点失败: breakpoint 1 not found`，而不是「用法错误」。

真正的删除分两跳。第一跳在符号层，`Target.ClearBreakpoint` 负责逻辑记录与重叠判断（**file：pkg/proc/breakpoints.go:155-183**）：

```go
func (t *Target) ClearBreakpoint(id uint64) (*Breakpoint, error) {
	bp := t.breakpointByID(id)
	if bp == nil {
		return nil, fmt.Errorf("breakpoint %d not found", id)
	}

	// 摘除逻辑记录与 Breaklet
	t.bps = removeBreakpoint(t.bps, bp)
	t.breaklets[bp.Addr] = removeBreaklet(t.breaklets[bp.Addr], id)

	// 该地址处仍有其他重叠断点：保留物理断点
	if len(t.breaklets[bp.Addr]) > 0 {
		return bp, nil
	}

	// 按地址清除物理断点：重打补丁会换物理 ID，不能按逻辑编号查。
	phys, ok := t.dbp.Breakpoints[uintptr(bp.Addr)]
	if !ok {
		return bp, nil
	}
	if _, err := t.dbp.ClearBreakpoint(phys.ID); err != nil {
		return nil, fmt.Errorf("clear breakpoint %d: %v", id, err)
	}
	return bp, nil
}
```

三步值得逐条看：

1. **先摘逻辑记录与 Breaklet**。`removeBreakpoint` 保持其余断点的相对顺序，`removeBreaklet` 只摘归属该逻辑编号的单元。
2. **地址上还有别的重叠单元就不动物理断点**。物理指令只有一份 `0xCC`，别的逻辑断点还靠它命中；这与 9.2.21 的 Breaklet 模型一致。
3. **物理断点按地址找，不按逻辑编号找**。原因就是前面说的「重打补丁换物理 ID」；代码注释写得很直白：`continue` 越过断点后物理编号会变，逻辑编号不变。若按逻辑 ID 查 `BreakpointsByID`，大概率查不到，物理补丁就漏还原了。若地址上已经没有物理断点（例如断点早已被 `toggle` 关掉），`ok=false` 直接返回，逻辑记录照样删掉——实测「先 `toggle 1` 再 `clear -n 1`」输出 `cleared`，随后 `breakpoints` 为空。

第二跳在物理层，`DebuggedProcess.ClearBreakpoint` 做「回退 PC → 还原指令」（**file：pkg/target/breakpoint.go:96-114**）：

```go
func (p *DebuggedProcess) ClearBreakpoint(id uint64) (*api.Breakpoint, error) {
	bp, ok := p.BreakpointsByID[id]
	if !ok {
		return nil, api.ErrBreakpointNotExisted
	}
	// 必须先回退 PC、再还原指令：还原会摘除断点索引
	if err := p.rewindThreadsAtBreakpoint(bp.Addr); err != nil {
		return nil, err
	}
	if _, err := p.RestoreInstruction(bp.Addr); err != nil {
		return nil, err
	}
	return toAPIBreakpoint(bp), nil
}
```

`rewindThreadsAtBreakpoint` 先调 `ThreadStoppedAtBreakpoint` 扫全部线程，凡 `PC-1 == bp.Addr` 的线程都 `SetPC(PC-1)` 写回寄存器；`RestoreInstruction` 再把 `Orig` 写回指令首字节并从两张物理索引里删除。顺序不能反：还原会删索引，之后再想找「谁停在断点上」就找不到了。实测顺序验证：在 `main.main`（`0x4b3940`）命中后 `clear -n 1`，再 `continue`，进程从 `0x4b3940` 重新执行而不是滑到 `0x4b3941`，最终正常命中 `main.go:16` 的 2 号断点（见「执行测试」）。

`clearall` 是同一件事的批量版。命令层只是调用 `Client.ClearAll()` 并打印一行 `清空断点成功`（**file：cmd/debug/clearall.go:16-23**）。符号层 `Target.ClearAll` 先让物理层批量还原，成功后清空两个容器：

```go
func (t *Target) ClearAll() error {
	if err := t.dbp.ClearAll(); err != nil {
		return err
	}
	t.bps = nil
	t.breaklets = map[uint64][]*Breaklet{}
	return nil
}
```

物理层 `DebuggedProcess.ClearAll`（**file：pkg/target/breakpoint.go:196-223**）的关键仍是顺序，而且比单条删除更严格：先 `ThreadStoppedAtBreakpoint()` 快照，再 `for _, bp := range p.Breakpoints { RestoreInstruction(bp.Addr) }` 逐个还原，最后 `for tid := range stopped` 读寄存器、`SetPC(PC-1)`、写回。

它先把 `tid→断点地址` 的映射**快照**下来，再逐个还原，最后按快照统一回退。单条删除可以「回退一个、还原一个」，批量删除不行：第一个 `RestoreInstruction` 就会删掉索引，后面的线程再查 `ThreadStoppedAtBreakpoint` 已经查不全。`Target.ClearAll` 在物理层成功后把 `t.bps` 置空、`breaklets` 重置，**包括处于 disabled 的逻辑断点**；disabled 断点没有物理补丁，物理层对它是空操作。

边界：`clearall` 失败没有回滚——物理层中途报错时，已还原的补丁不会恢复、逻辑表也还没清空，会留下「逻辑记录还在、部分断点已失效」的中间态；`clear` 只认 `-n` 给出的编号，`clearall` 不读取任何参数；按名字或位置批量清理不支持。

### 代码实现: `toggle`

`toggle` 是 `ch9.2.24` 唯一新增的命令，形态是 `toggle <breakpoint>`，编号走**位置参数**，与 `clear` 的 flag 形态相反。命令层（**file：cmd/debug/toggle.go:28-63**）：

```go
id, err := strconv.ParseUint(args[0], 10, 64) // 参数个数校验从略
if err != nil {
	return fmt.Errorf("invalid breakpoint id %q", args[0])
}

bps, err := Client.ListBreakpoints() // 错误分支从略
var target *api.Breakpoint
for i := range bps {
	if bps[i].ID == id {
		target = &bps[i]
		break
	}
}
if target == nil {
	return fmt.Errorf("breakpoint %d not found", id)
}

if err := Client.ToggleBreakpoint(id); err != nil {
	return err
}

if target.Enabled {
	fmt.Printf("breakpoint %d disabled\n", id)
} else {
	fmt.Printf("breakpoint %d enabled\n", id)
}
```

这里多了一次 `ListBreakpoints`，不是为了校验存在性（后端 `ToggleBreakpoint` 自己会查），而是为了拿到**翻转前**的 `Enabled` 来决定输出措辞——`api.Client.ToggleBreakpoint` 只返回 `error`，不返回新状态。所以它先列表、记下目标状态、再翻转；若两次调用之间状态被别的操作改掉，提示语可能与实际相反，单会话交互下不会发生。

后端 `Target.ToggleBreakpoint` 只有两条路径（**file：pkg/proc/breakpoints.go:237-263**）：

```go
if bp.Enabled {
	// 关闭：还原物理断点
	if phys, ok := t.dbp.Breakpoints[uintptr(bp.Addr)]; ok {
		if _, err := t.dbp.ClearBreakpoint(phys.ID); err != nil {
			return fmt.Errorf("disable breakpoint %d: %v", id, err)
		}
	}
	bp.Enabled = false
	return nil
}

// 开启：重建物理断点
if _, err := t.dbp.AddBreakpoint(uintptr(bp.Addr)); err != nil {
	return fmt.Errorf("enable breakpoint %d: %v", id, err)
}
bp.Enabled = true
return nil
```

关：按地址取物理断点，调 `DebuggedProcess.ClearBreakpoint`。这一步复用单条删除的物理实现，所以**回退 PC 是物理层顺带完成的**——线程若正停在断点上，`PC` 会先减 1 再还原 `0xCC`，恢复执行时不会跳过原指令。逻辑记录不删，只把 `Enabled` 置 false；`breakpoints` 因而仍列出它，多一个 `disabled`。

开：物理层通常已经没有该地址的补丁（关闭时被还原），`AddBreakpoint(addr)` 重新读原指令首字节、写 `0xCC`，并分配新的物理编号（`bpSeqNo` 又加了一次）；逻辑编号、名字、条件、命中计数全部保留——`toggle` 与 `clear` 的区别正在这里：前者是「暂时失效」，后者是「永久移除」。

完整回放见「执行测试」。关掉 1 号后 `continue` 没有在 `main.main` 入口停下，而是直达 2 号断点，说明物理 `0xCC` 确实被还原、断点不再命中；重新开启后 `disabled` 消失，2 号的 `hit:1` 也证明命中计数与开关状态互不干扰。另一个实测更能说明 PC 回退：线程停在 `main.main` 断点上（`pc: 0x4b3941`）时 `toggle 1` 关闭再打开，`continue` 会再次命中同一断点，`hit` 从 1 变成 2——若关闭时没有回退 PC，恢复执行会从 `0x4b3941` 开始，跳过入口指令。

**已知缺口：`toggle` 不清理重叠 Breaklet。** 关闭路径只做「按地址取物理断点 → 还原」，没有像 `Target.ClearBreakpoint` 那样检查 `len(t.breaklets[bp.Addr]) > 0`。如果该地址上还存在别的逻辑断点（共用同一个物理补丁，9.2.21 用 Breaklet 登记），`toggle` 会把共享的 `0xCC` 一并还原，而那些逻辑断点仍是 `Enabled=true`。`breakpoints` 会显示它们可用，实际却不会命中。用户断点之间不允许重叠、重复 `break` 会复用同一逻辑断点，所以纯手动场景不容易踩到；但模型上这是一个明确的不一致，目前未修。本节如实标出，不把 `toggle` 说成 `clear` 的完整替代。

### 执行测试

测试目标是用固定工具链构建的 `_fixtures/loop`（`GOTOOLCHAIN=go1.24.13`，`-gcflags "all=-N -l"`），因此 `main.main` 入口固定为 `0x4b3940`（`main.go:13`）、循环体 `fmt.Printf` 固定为 `0x4b3971`（`main.go:16`）；线程 tid 每次运行都变，不影响结论。以 `--init` 批量回放，命令与输出都来自真实运行（仓库绝对路径缩写成 `...`；为节省篇幅省略了 `stop all threads now`/`continue ok` 两行 all-stop 日志）。

先测 `toggle` 的完整生命周期：

```text
$ ./godbg exec _fixtures/loop --init /tmp/toggle924.txt
godbg> break main.main
breakpoint 1 added at 0x4b3940 (.../examples/debuggee/loop/main.go:13)
godbg> break main.go:16
breakpoint 2 added at 0x4b3971 (.../examples/debuggee/loop/main.go:16)
godbg> toggle 1
breakpoint 1 disabled
godbg> breakpoints
breakpoint[1] addr:0x4b3940, loc:.../loop/main.go:13, disabled
breakpoint[2] addr:0x4b3971, loc:.../loop/main.go:16
godbg> continue
thread 2046537 status: stopped: trace/breakpoint trap
> .../loop/main.go:16 (pc: 0x4b3972)
godbg> toggle 1
breakpoint 1 enabled
godbg> breakpoints
breakpoint[1] addr:0x4b3940, loc:.../loop/main.go:13
breakpoint[2] addr:0x4b3971, loc:.../loop/main.go:16, hit:1
```

另起一次会话测 `clear` 的 PC 回退与 `clearall`（两条 `break` 命令同上，从略）：先在 `main.main` 命中（`pc: 0x4b3941`，即断点地址 +1），原地 `clear -n 1`，再 `continue`；若 PC 没回退，进程会从 `0x4b3941` 继续、跳过入口指令，但实际仍正常走到 `main.go:16`。

```text
godbg> continue
thread 2046891 status: stopped: trace/breakpoint trap
> .../loop/main.go:13 (pc: 0x4b3941)
godbg> clear -n 1
breakpoint 1 at 0x4b3940 cleared
godbg> breakpoints
breakpoint[2] addr:0x4b3971, loc:.../loop/main.go:16
godbg> continue
thread 2046891 status: stopped: trace/breakpoint trap
> .../loop/main.go:16 (pc: 0x4b3972)
godbg> clear -n 2
breakpoint 2 at 0x4b3971 cleared
godbg> breakpoints
no breakpoints
godbg> clearall
清空断点成功
godbg> breakpoints
no breakpoints
```

错误路径也跑一遍（三段取自不同会话，只摘错误首行）。`clear -n` 与 `toggle` 都对不存在的编号报错；`clear 2` 则暴露 flag/位置参数的差异：

```text
godbg> clear -n 9
Error: 移除断点失败: breakpoint 9 not found
godbg> toggle 9
Error: breakpoint 9 not found
godbg> clear 2
breakpoint 1 at 0x4b3940 cleared
```

最后一行不是笔误：`clear` 只读 `-n`，位置参数 `2` 被忽略，默认值 1 生效。这条命令的 `Use` 行因此写成 `clear -n <id>`，读者照抄才不会误删。

回归用仓库的冒烟脚本 `testdata/script/ch9.2.24.txt` 覆盖。脚本内容是：`break main.main`、`break main.go:16`、`toggle 1`（断言 `breakpoint 1 disabled`）、`breakpoints`（断言 1 号带 `disabled`、2 号仍在列表）、`continue`（断言停在 `main.go:16`）、`toggle 1`（断言 `enabled`）、`breakpoints`（断言 1 号不再有 `disabled`）。实跑结果：

```text
$ bash scripts/smoke.sh ch9.2.24
smoke: running testdata/script/ch9.2.24.txt
smoke: all passed
```

`clear`/`clearall` 的回归在 [6.9](../../6-develop-inst-debugger/9-clear.md)/[6.10](../../6-develop-inst-debugger/10-clearall.md) 的脚本 `ch6.9.txt`、`ch6.10.txt` 里，`bash scripts/smoke.sh ch6.8 ch6.9 ch6.10` 同样 `all passed`；`ch9.2.24` 的提交没有改动这两条命令的代码，它们的冒烟结果不受影响。

### 本节小结

本节把断点的「后半生」补完了：

- `breakpoints` 读的是逻辑断点表：编号来自 `bpSeqNo`（只增不减），顺序由追加顺序保证；输出字段由 `toAPIBreakpoint` 拼装，`loc` 实际是 `PCToLine` 得到的 `file:line`，`hit`/`disabled`/`tracepoint` 都是条件追加。
- `clear` 是两跳删除：符号层摘逻辑记录与 Breaklet、地址上无重叠才物理还原；物理断点必须**按地址**查，因为重打补丁会换物理 ID；物理层先回退停在断点上的线程 PC、再还原指令，顺序不能反。
- `clearall` 把上面的流程批量化：物理层先快照停在断点处的线程，再逐个还原，最后统一 `PC-1`；符号层最后清空 `bps` 与 `breaklets`（含 disabled 记录）。失败无回滚是它的边界。
- `toggle` 只翻转 `Enabled`：关闭时借物理层 `ClearBreakpoint` 还原补丁并回退 PC，逻辑记录保留；开启时 `AddBreakpoint` 重建 `0xCC`，编号、名字、条件、命中计数都不变。`breakpoints` 的 `disabled` 就是它的状态出口；不清理重叠 Breaklet 是已知缺口。

范围收束：`clear`/`toggle` 只认编号，`clearall` 不读取参数，都不支持按名字/位置批量处理；没有 `on`，也不做多进程。下一节 [9.2.25 `trace`](./25-debug_trace.md) 会看到另一种「命中后不打断用户」的断点变体。
