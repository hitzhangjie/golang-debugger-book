## Breakpoint - part3: 条件断点

part2 讲完了"添加断点 → 继续执行 → 命中停下"，但"命中就停"对循环体里的断点几乎没用：每轮都停。条件断点把"停不停"从断点的**位置**转移到断点自身携带的一个布尔表达式上。本节看两条命令（`break ... if`、`condition`）、一次判定（`EvalCondition`）和一处最容易误读的计数（`hit`）。

### 实现目标

会话里两种写法，外加一条查看命令：

```text
godbg> break main.go:16 if i == 2
breakpoint 1 added at 0x4b3971 (…/debuggee/loop/main.go:16), cond "i == 2"
godbg> condition 1                      # 省略表达式：清除条件
breakpoint 1 condition cleared
```

要达到三件事：**创建时带条件**（`break <locspec> if <cond>`，`if` 之后整段都是条件）；**事后增删改**（`condition <id> [<expr>]`，空即清除）；**命中后按条件决定停不停**（不满足就自动越过、继续跑，下一轮再判；满足才停下，`breakpoints` 显示条件与命中次数）。

链路只有两条：

```text
创建：break … if c → Client.CreateBreakpoint(loc, c, name) → Target.CreateBreakpointByLoc → bp.Cond = c
判定：Continue → StopInfo → checkAutoResume → findBreakpointAt(PC-1) → Client.EvalCondition
      → Target.EvalCondition（要求 DW_ATE_boolean）
      不满足 → passOverStop（还原→PC-1→单步→重打补丁）→ 再 Continue；满足 → 停在断点处
```

关键在最后两步：**判定不在后端自动完成**。后端照常返回停止事件，前端的 `continue` 命令自己问一句"该停吗"，再决定是否续跑。

### 基础知识

#### 条件断点 = 普通断点 + 一个字符串

物理层没有"条件断点"这种东西：地址上仍是 `0xCC`，命中仍是一次 `SIGTRAP`。区别全在逻辑层——`proc.Breakpoint` 多一个 `Cond string`（`pkg/proc/breakpoints.go:55`），命中后拿它求值。

#### 谁来判：后端判 vs 前端判

delve 把条件挂在 breaklet 上，命中时由后端回调判定，`continue` 只返回"真停"。godbgv2 选了另一条路：后端保持"照实汇报停止"，前端不信"停了"，再求值一次。好处是 `Continue` 语义单一、`EvalCondition` 成为一条可复用的独立 RPC（`print` 走的是同一个求值器）；代价是每次"假命中"多一次往返，且自动续跑逻辑落在客户端——换个 RPC 客户端，条件断点就退化成普通断点。

#### bool 在 DWARF 里长什么样

DWARF v4 没有独立的 bool DIE，按 §5.1 约定以基础类型加 `DW_ATE_boolean` 编码表示。所以 `EvalCondition` 判的不是"值是否为 0/1"，而是"类型是不是布尔"：`1 == 1` 的结果带 `boolType`（`eval.go:43`），`1 + 1` 的结果带整型，直接报错，而不是被当成"非零即真"。

#### `hit: N` 不是 delve 的 HitCond

`Breakpoint.HitCount`（`breakpoints.go:57`）是"这个断点停住过多少次"，在服务端 `Continue` 返回时累加（`debugger.go:332-339`）。它不是 delve 里 `HitCond`/`HitCondPerG` 那种"命中多少次才停"的上限与 per-goroutine 计数——godbgv2 没有 `-hitcount`/`-per-g-hitcount`。最要紧的差别是顺序：**先计数、后求值**，条件不满足、被自动越过的命中同样 +1。

### 代码实现

#### 创建时带条件：`break ... if`

`cmd/debug/break.go:38-46`（省略 `args[1] != "if"` 的 usage 检查）：`if` 之后的整段 join 成条件，所以 `if i == 2 && i < 5` 不需要引号。

```go
loc := args[0]
cond := ""
if len(args) > 1 {
	cond = strings.Join(args[2:], " ")   // if 之后的整段都是条件
}
```

cond 经 `Client.CreateBreakpoint(spec, cond, name)` 下到 `CreateBreakpointByLoc`，在 `bp.Cond = cond`（`location.go:126`）处落到逻辑断点上；成功后 `break.go:77-79` 把 `, cond "…"` 回显出来。

#### 设置/清除：`condition`

`cmd/debug/condition.go:31-55`：`args[0]` 用 `strconv.ParseUint` 转编号，因此**只认数字**（命名断点也得记编号）；`args[1:]` join 成表达式，空串即清除。下行 `Client.SetBreakpointCondition` → `Debugger.SetBreakpointCondition`（`debugger.go:152`）→ `Target.SetBreakpointCondition`（`breakpoints.go:218`），做的只是给 `bp.Cond` 赋值或清空：不动物理断点，也不动已有计数。

#### 命中后的判定与自动续跑

`cmd/debug/continue.go:116-147` 是本节的核心（省略错误返回）：

```go
bp := findBreakpointAt(stop.PID)
if bp == nil { return false, nil }
if bp.Cond != "" {
	ok, err := Client.EvalCondition(bp.Cond)
	if err != nil { return false, /* condition %q eval error */ }
	if !ok {
		fmt.Printf("breakpoint %d condition %q not satisfied, auto continue\n", bp.ID, bp.Cond)
		if err := passOverStop(); err != nil { return false, err }
		return true, nil
	}
}
```

`findBreakpointAt`（`continue.go:160`）读线程寄存器，按 `PC-1` 在断点表里找——`int3` 已执行，PC 指向下一条指令。找不到就说明不是断点引起的停止（比如收到 SIGINT），不归条件断点管。`passOverStop` 复用 part2 的四步：还原指令 → 回退 PC → 单步 → 重打补丁；越过后 `continueRun` 的 `for` 循环再调一次 `Continue`。

求值本身在 `pkg/proc/eval.go:616`：

```go
func (t *Target) EvalCondition(expr string) (bool, error) {
	v, err := Eval(expr, t.conditionLookup, t.readTargetMemorySize)
	...
	bt, ok := v.Type.(*dwarf.BasicType)
	if !ok || bt.Encoding != dwarf.DW_ATE_boolean {
		return false, fmt.Errorf("condition %q is not a boolean expression", expr)
	}
	return v.Uint != 0, nil
}
```

标识符怎么变成变量的值？`conditionLookup`（`eval.go:644`）比 `print` 多一道限制：只放行 `BasicType`，复合类型直接报 `not supported in condition`。求值用的寄存器与内存上下文由 `Registers()` 给出（`pkg/proc/goroutines.go:288`），优先级是：`thread` 选中的线程 > `goroutine` 选中的 goroutine（挂起时用 `g.sched` 合成）> 当前事件线程。也就是说条件是对**当前调试上下文**求值，未必是命中的那个线程。

#### 命中计数

`Debugger.Continue`（`debugger.go:324-341`）在 `Continue` 返回后立刻查"停止线程是否停在断点上"，是则 `NoteBreakpointHit(addr)` → `bp.HitCount++`（`breakpoints.go:231-235`）。`breakpoints` 命令只在 `HitCount > 0` 时追加 `, hit:N`（`cmd/debug/breakpoints.go:34`）。

### 执行测试

调试目标是 `_fixtures/loop`（`-N -l` 构建，非 PIE），`main.go:16` 为循环体的 `fmt.Printf`，落在 `0x4b3971`；源码绝对路径前缀以 `…` 省略。这里刻意用循环体而非函数入口，理由见 9.2.21。

条件在第三轮才成立，前两轮自动越过：

```text
godbg> break main.go:16 if i == 2
breakpoint 1 added at 0x4b3971 (…/debuggee/loop/main.go:16), cond "i == 2"
godbg> continue
pid: 2101, loop: 0
pid: 2101, loop: 1
breakpoint 1 condition "i == 2" not satisfied, auto continue
thread 2101 stopped at breakpoint 0x4b3971
restored breakpoint at 0x4b3971
breakpoint 1 condition "i == 2" not satisfied, auto continue
thread 2101 stopped at breakpoint 0x4b3971
restored breakpoint at 0x4b3971
thread 2101 status: stopped: trace/breakpoint trap
> …/debuggee/loop/main.go:16 (pc: 0x4b3972)
godbg> breakpoints
breakpoint[1] addr:0x4b3971, loc:…/debuggee/loop/main.go:16, cond:"i == 2", hit:3
```

（`pid: … loop: N` 是被调试进程自己打印的；`stop all threads now`/`continue ok` 之类收尾行从略。）两条 `not satisfied` 对应 i=0、i=1，i=2 时停下；`hit:3` 正是三次停止，其中两次被条件过滤——这就是"先计数、后求值"的直接证据。`condition 1` 清除后计数保留，`breakpoints` 只剩 `..., hit:3`（不再有 `cond:`）。

恒假条件则永不满足，`not satisfied, auto continue` 会一直重复，只能靠外部信号或另一个断点收尾——smoke 脚本用 SIGINT，自定义脚本里再放一条 `break main.go:17` 也能让 `continue` 返回。

边界同样是实测出来的——错误发生在**命中求值时**，不在设条件时，因为 `condition` 只存字符串、不做检查：

```text
godbg> break main.go:16 if 5
Error: breakpoint 1 condition "5" eval error: condition "5" is not a boolean expression
godbg> break main.go:28 if pt.X == 1        # 换 _fixtures/vars
Error: breakpoint 1 condition "pt.X == 1" eval error: variable "pt" has composite type main.Point, not supported in condition (教学版能力边界)
```

自动化兜底：`./scripts/smoke.sh ch9.2.23` 输出 `smoke: running testdata/script/ch9.2.23.txt` 后以 `smoke: all passed` 结束（覆盖 `break … if`、`hit:1`、`condition 1 1 == 2`、`not satisfied, auto continue`、SIGINT 收尾与清条件）；`go test ./pkg/proc -run TestEvalCondition` 用表驱动覆盖 `1 == 1`、`1 == 2`、`1 + 1`（报错）、`i == 5` 等用例。

### 本节小结

条件断点没有新增任何物理机制：`Cond` 是逻辑断点上的字符串，`EvalCondition` 是求值器的一个布尔出口，真正的新逻辑只有 `checkAutoResume` 里那几行"不满足就 `passOverStop` 再 `continue`"。这让后端保持简单、求值器可复用，代价是自动续跑属于客户端行为（其他 RPC 客户端拿到的是原始停止），并且 `hit` 会包含被条件过滤掉的命中。表达式边界也很硬：只有基础类型之间的比较与逻辑运算，字符串、map、切片一律报错——这是求值器（9.2.18）的教学子集在条件场景下的直接投影。
