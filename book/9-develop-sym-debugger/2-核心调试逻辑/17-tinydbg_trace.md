## Trace：跟踪点后端

### 实现目标

`trace` 用来回答一个问题：某个函数到底被调用了没有、什么时候被调用。在 godbgv2 里它不是一个独立的顶层命令，而是调试会话里的一条断点族命令——顶层根本没有 `trace`：

```text
$ godbg help trace
Unknown help topic [`trace`]
```

顶层 `godbg` 的子命令只有 `attach/connect/core/debug/exec` 这一族（外加 `completion`/`help`/`version`）；`trace` 注册在会话内的根命令 `debugRootCmd` 上（`cmd/debug/trace.go:48-50`），必须先 `godbg exec`/`attach`/`debug` 进入会话才能用。会话内 `help trace` 只列出 `trace <regexp>` 和一个 `-h`，没有别的 flag；命令只接受一个位置参数（匹配函数名的正则），别名 `t`。

> 历史说明：本书初版这一节写的是 tinydbg 的顶层 `trace` 命令——自带启动/附加参数、逐函数 fanout、返回地址断点、耗时与栈打印。godbgv2 没有沿用这套设计。

本节只讲后端：正则如何变成跟踪点（`pkg/proc/trace.go`），以及命中跟踪点后进程为什么不停下来（`cmd/debug/continue.go`）。命令形态、输出格式与使用取舍放在 9.2.25。

### 基础知识

跟踪点（tracepoint）本质上是断点：在函数入口把指令首字节改成 `int3`（0xCC），执行到那里时进程收到 SIGTRAP 停下。和用户断点的唯一区别是"停下之后怎么办"：

- 用户断点：停下来，把控制权交回命令行，等用户决定 `next`/`step`/`continue`；
- 跟踪点：打印一行"谁被调用了"，然后立刻恢复执行，用户几乎感觉不到中断。

所以实现一条跟踪点只需要三样东西：一份函数清单、一个筛选条件、一套"命中后自动越过"的机制。前两样属于后端，第三样横跨服务层与命令层。godbgv2 的链路如下（括号内是本节要讲的函数）：

```text
cmd/debug/trace.go  trace <regexp>
  └─ api.Client.Trace(pattern)                     契约：pkg/service/api/client.go
       └─ rpc2.Client.Trace → Debugger.Trace        RPC 与服务层
            └─ proc.Target.SetTracepoints(pattern)  后端：pkg/proc/trace.go
                 ├─ regexp.Compile + ListFunctions  候选函数全集
                 └─ createBreakpoint(fn.Entry, fn.Name, TracepointBreakpoint)

命中：Client.Continue() → StopInfo → checkAutoResume(stop)
      发现 bp.Tracepoint 后打印 "> <函数名>() <源码位置> (tracepoint)"，
      再 passOverStop() 还原指令 → PC-- → 单步 → 恢复断点
```

函数清单来自符号层：`ListFunctions` 遍历 DWARF 的 `DW_TAG_subprogram`，得到每个函数的 `Name/Entry/End`，按入口地址升序缓存在 `BinaryInfo` 上（`pkg/proc/funcs.go`，详见 9.2.32/9.2.100）。其中 `Entry` 就是 `DW_AT_low_pc`，这解释了为什么跟踪点只落在函数入口——"一个函数一条符号记录"能表达的只有这个地址。

返回点和参数不是一条记录能表达的：同一个函数有很多调用点，返回地址因此有很多个；参数和返回值要先按 ABI 找到寄存器或栈槽，再按类型解析。做这两件事需要完整的表达式求值栈，代价远超"打印一行"。godbgv2 选择只做最便宜的那件事。

### 代码实现

#### 命令层到后端：一条 RPC 完成批量设置

**file：cmd/debug/trace.go:26-45（节选）**

```go
pattern := args[0]
if strings.HasPrefix(pattern, "/") && strings.HasSuffix(pattern, "/") && len(pattern) > 1 {
    pattern = pattern[1 : len(pattern)-1] // 兼容 locspec 的 /regexp/ 定界符
}

tps, err := Client.Trace(pattern) // 一次 RPC 拿回全部跟踪点
if err != nil {
    return err
}
for _, tp := range tps {
    fmt.Printf("tracepoint %d set at %s (%#x)\n", tp.ID, tp.Name, tp.Addr)
}
```

命令层没有"循环建断点"的逻辑：正则原样交给后端，拿回结果集再逐条打印。契约是 `Trace(pattern string) ([]Tracepoint, error)`（`pkg/service/api/client.go:104`），结果元素只有三个标量：`Name`（函数名）、`Addr`（函数入口地址）、`ID`（对应断点编号）。RPC 一层只做转接：`rpc2.Client.Trace` 调 `"Debugger.Trace"`，`serverImpl.Trace` 直接转给 `Debugger.Trace`（`pkg/service/rpc2/client.go:176`、`server.go:480`）。十个匹配函数也只走一次 RPC，而不是前端为每个函数各发一次 `CreateBreakpoint`。

#### 服务层：内部类型转契约类型

**file：pkg/service/debugger/debugger.go:177（省略 d.t == nil 的判空）**

```go
func (d *Debugger) Trace(pattern string) ([]api.Tracepoint, error) {
	tps, err := d.t.SetTracepoints(pattern)
	if err != nil {
		return nil, err
	}
	out := make([]api.Tracepoint, len(tps))
	for i, tp := range tps {
		out[i] = api.Tracepoint{Name: tp.Fn.Name, Addr: tp.Bp.Addr, ID: tp.Bp.ID}
	}
	return out, nil
}
```

后端的 `*proc.Tracepoint` 绑定的是 `*Function` 与 `*Breakpoint` 两个内部对象，服务层在这里"翻译"成三个标量，把符号层与断点层挡在契约之外。

#### 后端核心：SetTracepoints

**file：pkg/proc/trace.go**（tag `ch9.2.17` 引入的后端，`kind` 参数由 9.2.25 补齐）

```go
// Tracepoint 跟踪点（ch9.2.17）：命中时打印位置后自动恢复执行，
// 与断点的区别是不中断用户流程
type Tracepoint struct {
	Fn *Function
	Bp *Breakpoint
}

// SetTracepoints 为名称匹配 pattern（正则）的函数批量设置跟踪点
// （ch9.2.17 后端）。
func (t *Target) SetTracepoints(pattern string) ([]*Tracepoint, error) {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, fmt.Errorf("invalid trace pattern %q: %v", pattern, err)
	}

	fns, err := t.ListFunctions()
	if err != nil {
		return nil, err
	}

	tps := []*Tracepoint{}
	for _, fn := range fns {
		if !re.MatchString(fn.Name) {
			continue
		}
		// 跟踪点以 TracepointBreakpoint 类型创建：命中处理时据此
		// 区分普通断点（打印位置后自动恢复，ch9.2.25）
		bp, err := t.createBreakpoint(fn.Entry, fn.Name, TracepointBreakpoint)
		if err != nil {
			return nil, fmt.Errorf("set tracepoint at %s: %v", fn.Name, err)
		}
		tps = append(tps, &Tracepoint{Fn: fn, Bp: bp})
	}
	if len(tps) == 0 {
		return nil, fmt.Errorf("no function matches %q", pattern)
	}
	return tps, nil
}
```

上面是当前 HEAD 的版本：`createBreakpoint` 比 tag 时多了一个 `kind` 参数。tag `ch9.2.17` 落地时这一行还是 `bp, err := t.CreateBreakpoint(fn.Entry, fn.Name)`——那时 `Breakpoint` 结构里连 `Kind` 字段都还没有，跟踪点与普通断点无从区分；类型位和命中后的自动续跑都是 9.2.25 补上的。

几个要点：

1. `ListFunctions()` 是**无参**的（`pkg/proc/target.go:46`），返回全部函数；正则过滤在后端做。这和 `funcs` 命令"后端给全量、前端过滤"正好相反（9.2.32），是有意的取舍：trace 本来就要为每个匹配项建断点，往返次数比传输量更值钱。
2. 匹配对象是 DWARF 里的完整函数名（`main.main`、`runtime.main.func1`），`MatchString` **不锚定**：`trace main` 会同时命中 `main.main` 和 `runtime.main` 一族（实测 4 个）。要精确匹配必须自己写 `^main\.main$`。
3. 每个匹配函数只建一个断点，地址是 `fn.Entry`，位置描述 `loc` 直接取函数名——所以命中时打印出来的是函数名而不是源码行。
4. 断点类型是 `TracepointBreakpoint`（`pkg/proc/breakpoints.go:18`），它是位集 `BreakpointKind` 的一位，记录"这条断点是谁创建的"，命中处理完全依赖这一位。
5. 一个都没匹配上时返回 `no function matches "<pattern>"`，而不是静默成功；正则非法时在 `regexp.Compile` 就报错。也没有数量上限：正则宽到包级，就会给成千上万个函数各打一个 `int3`。

#### 命中恢复：Tracepoint 布尔量与自动续跑

`int3` 命中后进程停下，`Continue` 返回 `StopInfo`。命令层判断"这次停是不是跟踪点"的依据是契约里的一个布尔字段：

**file：pkg/service/debugger/debugger.go:226**

```go
Tracepoint: bp.Kind&proc.TracepointBreakpoint != 0,
```

**file：cmd/debug/continue.go:116（省略条件断点分支）**

```go
func checkAutoResume(stop *api.StopInfo) (bool, error) {
	bp := findBreakpointAt(stop.PID)
	if bp == nil {
		return false, nil
	}

	// 跟踪点（ch9.2.25）：打印命中信息后总是自动继续
	if bp.Tracepoint {
		fmt.Printf("> %s() %s (tracepoint)\n", bp.Loc, bp.Pos)
		if err := passOverStop(); err != nil {
			return false, err
		}
		return true, nil
	}

	return false, nil
}
```

`findBreakpointAt` 读寄存器后用 `PC-1` 反查逻辑断点（int3 执行后 PC 已指向下一条指令），与 target 层 `ThreadStoppedAtBreakpoint` 的判定口径一致。打印用的是 `bp.Loc`（trace 传入的函数名）与 `bp.Pos`（`PCToLine` 算出的 `文件:行号`）。

越过断点复用 `continue` 的既有流程 `passOverBreakpoints`：还原原始指令 → PC 回退 1 → 单步执行那条被覆盖的指令 → 重新打上 `int3`。每一步都是独立的 RPC，由客户端编排——后端并没有"命中跟踪点"这个原子操作，只有断点原语。

`continueRun` 的循环因此长这样：`Continue` → `checkAutoResume` 为真就接着 `Continue`，直到遇到真正的用户断点、条件满足的断点或其他停止事件。跟踪点命中时打出的 `thread N stopped at breakpoint 0x…`、`restored breakpoint at 0x…` 两行就是 `passOverStop` 越点时打印的，属于调试器自身的噪音。

#### 跟踪点撞上用户断点时

`createBreakpoint` 的判重规则是：地址上已有物理断点、且新类型**不能重叠**时，直接复用既有逻辑断点（`pkg/proc/breakpoints.go:71-98`）。而 `canOverlap` 只放行 `NextBreakpoint|StepBreakpoint` 这类步进临时断点（同文件 `:31-33`），`TracepointBreakpoint` 不在其中。于是先 `break main.main` 再 `trace /main.main/`：

```text
godbg> break main.main
breakpoint 1 added at 0x4b3940 (…/debuggee/loop/main.go:13)
godbg> trace /main.main/
tracepoint 1 set at main.main (0x4b3940)
godbg> breakpoints
breakpoint[1] addr:0x4b3940, loc:…/debuggee/loop/main.go:13
```

`trace` 报告"设置成功"，但断点记录里没有 `, tracepoint` 后缀，命中时也不会自动续跑——它复用了既有用户断点，逻辑语义以先创建者为准。物理指令只有一处，这是重叠策略的必然结果；想要跟踪语义，就别在同一地址上再放用户断点。

### 执行测试

用仓库自带的调试目标 `_fixtures/loop`（每秒打印一次计数）实跑，`--init` 脚本里依次是下面这些命令。先看正则匹配多个函数的效果：

```text
$ ./godbg exec _fixtures/loop --init trace.txt
process 1964766 launched, stopped by SIGTRAP
godbg> trace main.*
tracepoint 1 set at runtime.main (0x4405e0)
tracepoint 2 set at runtime.main.func2 (0x440980)
tracepoint 3 set at runtime.main.func1 (0x46d1e0)
tracepoint 4 set at main.main (0x4b3940)
godbg> breakpoints
breakpoint[1] addr:0x4405e0, loc:…/runtime/proc.go:147, tracepoint
breakpoint[4] addr:0x4b3940, loc:…/debuggee/loop/main.go:13, tracepoint
```

上面只列了第 1、4 条，2、3 两条同样带 `, tracepoint`。`main.*` 顺带命中了 `runtime.main` 一族，可见匹配的是完整函数名、且不带锚定。再看命中（换一个只设 `main.main` 的会话，便于观察单次命中）：

```text
godbg> trace /main.main/
tracepoint 1 set at main.main (0x4b3940)
godbg> continue
> main.main() …/debuggee/loop/main.go:13 (tracepoint)
thread 1964725 stopped at breakpoint 0x4b3940
restored breakpoint at 0x4b3940
thread 1964725 status: stopped: interrupt
> …/runtime/sys_linux_amd64.s:558 (pc: 0x4788a3)
stop all threads now
continue ok
```

（输出里省略了被调试进程自己打印的 `pid: … loop: N`。）关键在最后几行的顺序：命中跟踪点后 `continue` **没有返回**，程序继续在自己的循环里跑，直到外部 SIGINT 才停下并打印 `status: stopped: interrupt`。这验证了"打印后自动续跑"；紧跟命中行的 `stopped at breakpoint`/`restored breakpoint` 是 `passOverStop` 越点时的输出，不是新的断点。

手敲 `continue` 需要 Ctrl+C 收尾，仓库的 smoke 脚本把这一步自动化了（`testdata/script/ch9.2.25.txt`）：

```bash
$ ./scripts/smoke.sh ch9.2.25
smoke: running testdata/script/ch9.2.25.txt
smoke: all passed
```

脚本断言：`trace /main.main/` 输出 `tracepoint <id> set at main.main (0x4b3940)`；`breakpoints` 行尾带 `tracepoint`；`continue` 命中后打印 `> main.main() … main.go:13 (tracepoint)`；最后外部 SIGINT 让线程停在 `stopped: interrupt`。错误分支也实测过（cobra 的 Usage 段省略）：`trace /NoSuchFunctionZZZ/` 返回 `Error: no function matches "NoSuchFunctionZZZ"`。

### 本节小结

godbgv2 的 trace 后端只有一个不到 50 行的文件，却把"符号 → 断点 → 自动续跑"这条链路串完了：`SetTracepoints` 把正则变成一批 `int3`，`TracepointBreakpoint` 这一位让命中处可以被识别，`checkAutoResume` 让进程透明地继续。跟踪点不是后端的一个独立概念，它只是断点的一个 kind。

能力边界（命令形态与输出细节见 9.2.25）：

| 能力 | godbgv2 |
|---|---|
| 入口跟踪点 | 有：`trace <regexp>` 批量设置，别名 `t` |
| 函数返回点 / 耗时统计 | 无：只有入口，`FunctionReturnLocations` 之类不存在 |
| 参数 / 返回值打印 | 无：`api.Breakpoint` 只有 `Tracepoint bool`，连字符串参数也不打 |
| `--follow-calls`（fanout 深度） | 无：没有调用关系分析，正则只匹配函数名 |
| `--stack`（命中时打印调用栈） | 无：没有帧展开 |
| eBPF / uprobe | 无：未实现 |
| 自带目标（启动/附加参数） | 无：必须先在会话内 |

在"做多少"这件事上，delve 的顶层 `dlv trace <regexp>` 给出了另一个极端：它支持 `-e/--exec`、`-p/--pid` 自带目标，`--follow-calls` 按深度展开函数体里的调用，`-s/--stack` 打印调用栈，`--timestamp` 用入口/返回两个断点的时间差算耗时，另外还有实验性的 `--ebpf`。这些能力各自都要一整套配套（AST 或反汇编分析、CFI 栈展开、ABI 与类型解析），godbgv2 一件都没做——这是有意收窄，不是欠债。读者在 9.2.25 看到命令为什么这么"素"时，答案就在这里。

最后是一个实践提醒：正则要写窄。`SetTracepoints` 对每个匹配函数都创建一个断点，没有数量上限；在我们的测试环境里，`trace ^fmt\.`（57 个函数）约 0.2 秒完成，而 `trace ^runtime\.`（该二进制里 1893 个函数）长时间不返回。跟踪点适合钉住少数几个热点函数，不适合当包级过滤器用。
