## trace

trace，在指定位置设置 tracepoint，本质上还是断点，命中后并打印相关位置信息，然后恢复执行；它适合回答"这个函数有没有被调用、调用了多少次"，不适合"想在函数里停下来看看变量"。

### 实现目标

`trace` 是**会话内**命令——先 `exec`/`attach` 进调试会话，再设点；不是 `godbg trace` 那样的顶层子命令，也没有 `--pid`/`--exec`/`--follow-calls`/`--timestamp` 这些选项（那是早期 tinydbg 里顶层 trace 子命令的形态）。会话里 `help trace` 能看到它有多"薄"：

```text
godbg> help trace
为匹配正则的函数设置跟踪点

trace <regexp>
  -h, --help   help for trace
```

要做到四件事：唯一参数是正则，匹配**函数全名**，兼容 locspec 的 `/re/` 写法（两端斜杠会被剥掉）；别名 `t`；一次为多个函数设点并逐个回显编号与地址；零匹配、正则非法都当场报错，而不是静默设了 0 个点。

与 9.2.17 的分工：那节讲后端 `SetTracepoints` 如何把正则变成一批 `TracepointBreakpoint`、命中后 `checkAutoResume`/`passOverStop` 如何恢复执行；本节只讲命令形态、输出与使用取舍。

### 基础知识

跟踪点有两条实现路线：

- **断点式**：在目标函数入口写 `int3`，命中后打印、再越过续跑。可移植性强（复用整条断点链路），但每次命中都要停一次进程、走一次 RPC。
- **uprobe/eBPF**：把探针挂到用户态地址，事件在内核侧收集。开销小，但依赖内核能力，移植性差。

godbgv2 只有断点式，而且"跟踪点"不是一个独立对象：它就是一条 `Kind = TracepointBreakpoint` 的逻辑断点（`pkg/proc/breakpoints.go:18`）。由此推出三个直接后果：`breakpoints` 会列出它、`clear`/`toggle` 同样对它生效、它和普通断点共用同一张地址表（同址时按重叠策略处理）。也正因为复用断点，命中时能拿到的只有"函数入口 + 源码位置"，没有参数、没有返回值，也没有返回点。

### 代码实现

#### 命令层

`cmd/debug/trace.go` 很短，四件事全在里面：

```go
pattern := args[0]
if strings.HasPrefix(pattern, "/") && strings.HasSuffix(pattern, "/") && len(pattern) > 1 {
	pattern = pattern[1 : len(pattern)-1]
}

tps, err := Client.Trace(pattern)
if err != nil {
	return err
}
for _, tp := range tps {
	fmt.Printf("tracepoint %d set at %s (%#x)\n", tp.ID, tp.Name, tp.Addr)
}
```

`Use: "trace <regexp>"`、`Aliases: []string{"t"}`（`trace.go:15-22`）；参数个数必须为 1（`trace.go:27-29`）；只注册了 cobra 自动加的 `-h`。输出一行一个跟踪点：编号、函数名、入口地址。

#### 服务层：转成契约类型

`api.Client.Trace(pattern) ([]Tracepoint, error)`（`pkg/service/api/client.go:104`）→ `Debugger.Trace`（`debugger.go:177`）：先调 `d.t.SetTracepoints(pattern)`，再把返回的 `[]*proc.Tracepoint`（`Fn` + `Bp`）逐个转成 `api.Tracepoint{Name: tp.Fn.Name, Addr: tp.Bp.Addr, ID: tp.Bp.ID}`。`api.Tracepoint`（`pkg/service/api/types.go:91`）只有 `Name`/`Addr`/`ID` 三个字段——命令层需要的信息就这么多，函数对象与逻辑断点指针都留在后端。后端本体 `Target.SetTracepoints`（`pkg/proc/trace.go:17`）做的是 `regexp.Compile` → `ListFunctions` → 名称匹配 → `createBreakpoint(fn.Entry, fn.Name, TracepointBreakpoint)`，零匹配返回 `no function matches %q`，细节见 9.2.17。

#### 命中时的输出

命中处理在 `cmd/debug/continue.go:137-144`：

```go
if bp.Tracepoint {
	fmt.Printf("> %s() %s (tracepoint)\n", bp.Loc, bp.Pos)
	if err := passOverStop(); err != nil {
		return false, err
	}
	return true, nil
}
```

`bp.Loc` 是设点时写进逻辑断点的 locspec（这里是函数名），`bp.Pos` 是 `file:line`。`Tracepoint` 这个布尔量由 `toAPIBreakpoint` 从 kind 位推出来（`debugger.go:226`）：`bp.Kind&proc.TracepointBreakpoint != 0`。`checkAutoResume` 返回 true 后 `continueRun` 接着 `Continue`，用户看到的效果就是"程序没停"。

#### 同址撞上普通断点

先 `break` 再 `trace`（都在 `main.main` 入口 `0x4b3940`）：

```text
godbg> break main.main
breakpoint 1 added at 0x4b3940 (…/debuggee/loop/main.go:13)
godbg> trace /main.main/
tracepoint 1 set at main.main (0x4b3940)
godbg> breakpoints
breakpoint[1] addr:0x4b3940, loc:…/debuggee/loop/main.go:13
```

`trace` 报告"设置成功"，编号也没变，但断点记录里**没有** `, tracepoint`，命中时也不会续跑——它复用了既有逻辑断点，语义以先创建者为准。反过来先 `trace` 再 `break`，结论相反：断点带着 `, tracepoint`，命中即续跑，`break` 等于没生效。根因在 `createBreakpoint`：地址已有物理断点时直接复用逻辑断点，而 `canOverlap` 只放行步进类断点，`TracepointBreakpoint` 不在其中（`breakpoints.go:31-33`）。

### 执行测试

调试目标是 `_fixtures/loop`（`-N -l` 构建，非 PIE），源码绝对路径前缀以 `…` 省略。

正则批量匹配——`main.*` 没有锚定，把 `runtime.main` 一族也捞了进来：

```text
godbg> trace main.*
tracepoint 1 set at runtime.main (0x4405e0)
tracepoint 2 set at runtime.main.func2 (0x440980)
tracepoint 3 set at runtime.main.func1 (0x46d1e0)
tracepoint 4 set at main.main (0x4b3940)
godbg> breakpoints
breakpoint[1] addr:0x4405e0, loc:…/src/runtime/proc.go:147, tracepoint
breakpoint[2] addr:0x440980, loc:…/src/runtime/proc.go:205, tracepoint
breakpoint[3] addr:0x46d1e0, loc:…/src/runtime/proc.go:172, tracepoint
breakpoint[4] addr:0x4b3940, loc:…/debuggee/loop/main.go:13, tracepoint
```

想窄就加锚定（`^main\.`）或直接写函数名。再看命中：先让程序停在循环体，跟踪一个每轮都被调用的函数，然后 `continue`——命中跟踪点不会返回，一路跑到下一个普通断点才停：

```text
godbg> break main.go:16
breakpoint 1 added at 0x4b3971 (…/debuggee/loop/main.go:16)
godbg> continue
thread 2107 status: stopped: trace/breakpoint trap
> …/debuggee/loop/main.go:16 (pc: 0x4b3972)
godbg> trace /time\.Sleep/
tracepoint 2 set at time.Sleep (0x473380)
godbg> continue
thread 2107 stopped at breakpoint 0x4b3971
restored breakpoint at 0x4b3971
> time.Sleep() …/src/runtime/time.go:305 (tracepoint)
thread 2107 stopped at breakpoint 0x473380
restored breakpoint at 0x473380
thread 2107 status: stopped: trace/breakpoint trap
> …/debuggee/loop/main.go:16 (pc: 0x4b3972)
```

（`stop all threads now`/`continue ok` 之类收尾行从略。）三件事同屏可见：`> … (tracepoint)` 是命中行；紧跟的 `stopped at breakpoint`/`restored breakpoint` 是 `passOverStop` 越点时打的噪音，不是新的停止；最后停的是 `main.go:16` 的普通断点，说明跟踪点没拦住程序。

一个如实记录的细节：跟踪点落在函数入口，而 Go 函数入口是栈检查指令，栈需要扩容时会跳回入口重来，于是**同一次调用可能打印两行**（9.2.21 讨论过这个"同一函数执行两次的假象"）。实测同一次 `time.Sleep` 调用，三次运行分别打印 1、2、2 行，`hit` 计数与打印行数一致。读 trace 输出时按"命中事件"理解，别当严格的调用次数。

smoke 脚本把这条链路固化了（设点、`breakpoints` 标记、命中打印、SIGINT 收尾）：

```bash
$ ./scripts/smoke.sh ch9.2.25
smoke: running testdata/script/ch9.2.25.txt
smoke: all passed
```

错误分支也实测过（cobra 的 Usage 段省略）：`trace nosuchfunc` → `Error: no function matches "nosuchfunc"`；`trace /[/` → `Error: invalid trace pattern "["` 开头的正则编译错误。

### 本节小结

`trace` 的正则只是"批量设断点"的语法糖，跟踪点也不是新对象，而是 `TracepointBreakpoint` 这一位 kind；命令层做的全部工作就是剥掉 `/re/` 的斜杠、把参数交给后端、把返回的三元组逐行打印。真正让它"跟踪"而不是"调试"的，是命中后 `checkAutoResume` 里那次 `passOverStop` 加续跑——它是 9.2.23 条件断点自动续跑框架的第二个使用者。取舍也就清楚了：观测调用发生用 `trace`，要停在函数里查变量用 `break`；两者不要放在同一地址上。
