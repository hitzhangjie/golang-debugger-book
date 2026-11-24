## godbg> funcs `<regexp>`

`funcs` 是"函数目录"命令：给一个正则，列出符号表里名字匹配的函数，每行 `函数名 入口地址`，最后报告命中个数。它不设断点、不改变目标进程状态，纯粹读符号层；也因此它只能在调试会话里用——`godbg funcs` 顶层没有这个子命令，会报 `unknown command "funcs"`。

### 实现目标

`godbg> help funcs` 只有一行描述（`列出名称匹配正则的函数`）、用法 `funcs <regexp>`，加上 cobra 自动生成的 `-h`。要交付的能力只有四条：

1. 参数恰好一个，按 Go 正则编译；编译失败当场报错（`invalid regexp ...`），而不是静默返回空结果。
2. 向调试后端要**函数全集**，自己在前端过滤——契约 `ListFunctions()` 没有任何参数。
3. 命中行打印 `name 0xentry`；声明位置 `(file:line)` 只在后端填了 `DeclFile` 时才追加。
4. 末尾报告 `matched N function(s)`；0 条命中是正常结果，不是错误。

别名 `fn`。它和 `trace` 共用同一份函数全集，但过滤发生的位置不同：`funcs` 在客户端过滤，`trace` 把正则交给后端（`pkg/proc/trace.go:17`），后面"谁在共用这份函数表"一节会把三处调用摆在一起看。

（历史注：本书早期草稿把 `funcs` 写成了"可按调用关系递归展开"的命令，那是 tinydbg 的形态——请求参数里带跟踪深度、后端反汇编找 `CALL` 按层展开。godbgv2 没有这段代码：`ListFunctions()` 不接受参数，命令也不解析跟踪深度；缺口见"能力边界"。）

### 基础知识

#### 函数来自 DWARF 的 subprogram DIE

依据 DWARF v4 §3.3.1，Go 编译器为每个函数生成一个 `DW_TAG_subprogram` DIE，关键属性正好对应 `proc.Function` 的五个字段：

| DWARF 属性 | 含义 | `Function` 字段 |
|---|---|---|
| `DW_AT_name` | 符号全名（包路径 + 接收者） | `Name` |
| `DW_AT_low_pc` | 入口地址 | `Entry` |
| `DW_AT_high_pc` | 结束地址（绝对地址，或相对 `low_pc` 的偏移） | `End` |
| `DW_AT_decl_file` | 声明文件在所在 CU 行号表文件表中的编号 | `DeclFile` |
| `DW_AT_decl_line` | 声明行号 | `DeclLine` |

名字是**符号全名**：实测输出里既有 `main.main`，也有 `internal/abi.(*RegArgs).IntRegArgAddr` 这种带包路径和接收者的形式，还有 `runtime.main.func1` 这种闭包名。所以正则匹配的是符号名，不是源码里的短名——想只匹配 main 包要写 `^main\.`。

`DW_AT_high_pc` 有两种编码：DWARF4 写绝对地址（go1.24 及更早的默认输出），DWARF5 写相对 `low_pc` 的偏移（go1.25+）。解析时两者都要认，`EntryRange` 负责这件事（`pkg/dwarf/reader.go:275`），见后文。

#### DIE 树按编译单元组织

DWARF 不是一张平铺的符号表，而是一片树：每个编译单元（CU，`DW_TAG_compile_unit`）是一棵树的根，函数、变量、类型都是它的后代 DIE。Go 的 CU 名就是包路径——`readelf --debug-dump=info _fixtures/loop` 能看到 58 个 CU，名字是 `unicode`、`sync`、`internal/abi`、`main`、`fmt`……（`internal/cpu` 出现两次，同一个包生成多个 CU 也正常）。

因此"列出全部函数"只能这样实现：遍历所有 CU，各自 `Seek` 到 CU 起始偏移，在这棵子树里深度优先找 `DW_TAG_subprogram`。不能只读文件开头的一段，也没有全局索引可用——Go 链接器不生成 `.debug_aranges`（`pkg/dwarf/section.go` 里有解析器，但对 Go 产物是空转）。

#### 契约：一次全量快照，过滤在调用方

`api.Client` 上的方法只有一行（`pkg/service/api/client.go:137`）：

```go
// ListFunctions 返回全部函数（按入口地址升序）
ListFunctions() ([]Function, error)
```

没有 filter、没有 limit、没有排序方向。这个决定推出三件事：

- 后端一次返回**全部**函数，`_fixtures/loop` 是 2744 条；
- 过滤、排版、取前 N 条，全是调用方的事；
- 后端只保证一条不变量：按 `Entry` 升序——`FuncForPC` 的二分查找依赖它。

为什么不用 `.gosymtab`/`.gopclntab`？go1.25 起链接器不再生成 `.gosymtab`，而 `.gopclntab` 只覆盖 Go 代码、不含类型与声明位置。godbgv2 统一走 DWARF，取舍写在 `pkg/proc/funcs.go:22-32` 的注释里。

### 代码实现

一条 `funcs main\.` 的完整路径：

```text
funcsCmd.RunE（cmd/debug/funcs.go:27）
  -> api.Client.ListFunctions()（pkg/service/api/client.go:137）
  -> rpc2.(*Client).ListFunctions（pkg/service/rpc2/client.go:318）
  -> service/debugger.(*Debugger).ListFunctions（pkg/service/debugger/debugger.go:365）
  -> proc.(*Target).ListFunctions（pkg/proc/target.go:46）
  -> proc.(*BinaryInfo).Functions（pkg/proc/funcs.go:131）
```

#### 命令层：编译正则、过滤、打印

`cmd/debug/funcs.go:27-55` 就是全部逻辑：

```go
RunE: func(cmd *cobra.Command, args []string) error {
	if len(args) != 1 {
		return errors.New("usage: funcs <regexp>")
	}

	re, err := regexp.Compile(args[0])
	if err != nil {
		return fmt.Errorf("invalid regexp %q: %v", args[0], err)
	}

	fns, err := Client.ListFunctions()
	if err != nil {
		return err
	}

	count := 0
	for _, fn := range fns {
		if !re.MatchString(fn.Name) {
			continue
		}
		info := fmt.Sprintf("%s %#x", fn.Name, fn.Entry)
		if fn.DeclFile != "" {
			info += fmt.Sprintf(" (%s:%d)", fn.DeclFile, fn.DeclLine)
		}
		fmt.Println(info)
		count++
	}
	fmt.Printf("matched %d function(s)\n", count)
	return nil
}
```

几个容易看漏的点：

- 正则**不锚定**，也不做词边界：`main.*` 会命中 `runtime.main`（前面有 `runtime.` 不碍事），实测 4 条；要精确匹配就自己写 `^main\.main$`。
- `funcs` **不剥斜杠**：`funcs /main\.main/` 把斜杠当字面量，命中 0 条。`trace` 是在命令层自己剥掉两端斜杠（`cmd/debug/trace.go:31`），`break` 走 locspec 解析；`funcs` 两者都没有。
- 只有匹配到才打印，`count` 是命中数而非函数总数；0 条只回 `matched 0 function(s)`，返回 nil，不报错。
- `DeclFile` 分支存在，但后端批量路径不填它——实际输出只有两列。这不是笔误，下面"声明位置"一节会解释为什么。

`Client` 是会话级的 `api.Client` 变量（`cmd/debug/shell.go:54`），进入会话时由 `cmd/session.go:30` 赋值；命令层不关心对端是本地还是远端。

#### 契约类型：`api.Function`

```go
// Function 函数信息（ch9.2.01）
type Function struct {
	Name     string // 函数名
	Entry    uint64 // 入口地址
	End      uint64 // 结束地址
	DeclFile string // 声明所在源文件
	DeclLine int    // 声明所在行号
}
```

定义在 `pkg/service/api/types.go:58`。`proc` 包里有一套同名字段的结构（`pkg/proc/funcs.go:13`），服务层逐字段搬运成 `api.Function`（`pkg/service/debugger/debugger.go:375`），不做任何裁剪或补全。`End` 在契约里，但 `funcs` 不用它——打印只要名和入口。`ListFunctions` 在 `d.t == nil`（会话里还没有被调试进程）时返回 `no debugged process`（`debugger.go:366`）。

rpc2 的请求体是空结构、响应体只有一个切片（`pkg/service/rpc2/server.go:302-305`）：

```go
type ListFunctionsArgs struct{}

type ListFunctionsReply struct{ Fns []api.Function }
```

从线格式上也能看出"没有过滤参数"：正则从来没出现在请求里。

#### 后端：`Target.ListFunctions` → `BinaryInfo.Functions`

`Target.ListFunctions` 只把 `[]Function` 逐个取址成 `[]*Function`（`pkg/proc/target.go:46`），不复制、不排序、不过滤。真正的活在 `BinaryInfo.Functions`（`pkg/proc/funcs.go:131`）：

```go
func (bi *BinaryInfo) Functions() ([]Function, error) {
	bi.funcsOnce.Do(func() {
		d, err := bi.DWARF()
		if err != nil {
			bi.funcsErr = err
			return
		}
		entries, err := godbgdwarf.NewReader(d).Subprograms()
		if err != nil {
			bi.funcsErr = err
			return
		}

		fns := []Function{}
		for _, e := range entries {
			if fn, ok := functionFromEntry(e); ok {
				fns = append(fns, *fn)
			}
		}
		sort.Slice(fns, func(i, j int) bool { return fns[i].Entry < fns[j].Entry })
		bi.funcs = fns
	})
	return bi.funcs, bi.funcsErr
}
```

三个决定都在这里：

- **缓存**：`funcsOnce` + `funcs` + `funcsErr`（`pkg/proc/bininfo.go:31`）。DWARF 只解析一次，之后 `funcs`、`trace`、`break /re/` 共用同一份切片，生命周期等于 `BinaryInfo`。
- **过滤**：`functionFromEntry` 只收有地址范围的 DIE（`pkg/proc/funcs.go:54`）：

```go
func functionFromEntry(e *stddwarf.Entry) (*Function, bool) {
	name, _ := e.Val(stddwarf.AttrName).(string)
	entry, end, ok := godbgdwarf.EntryRange(e)
	if !ok {
		return nil, false
	}
	return &Function{Name: name, Entry: entry, End: end}, true
}
```

  没有 `DW_AT_low_pc` 的 DIE（纯声明、或被内联后不单独生成代码的函数）直接丢掉。"函数总数"因此可能小于 subprogram DIE 总数，但这不是漏函数。
- **排序**：按入口地址升序，不是按名字。所以 `funcs` 的输出是地址序（`internal/abi.(*RegArgs).IntRegArgAddr 0x401000` 排在 `main.main 0x4b3940` 前面），这也是 `FuncForPC` 能二分的前提。

注意这里**没有**填 `DeclFile`/`DeclLine`——结构体有这两个字段，批量路径不解析。原因下一节讲。

#### DWARF 侧：`Subprograms` 与 `EntryRange`

`Subprograms` 按 CU 逐棵树遍历（`pkg/dwarf/reader.go:98`）：

```go
func (r *Reader) Subprograms() ([]*stddwarf.Entry, error) {
	fns := []*stddwarf.Entry{}
	cus, err := r.CompileUnits()
	if err != nil {
		return nil, err
	}
	for _, cu := range cus {
		reader := r.d.Reader()
		reader.Seek(cu.Offset)
		if err := walkEntry(reader, false, func(e *stddwarf.Entry) bool {
			if e.Tag == stddwarf.TagSubprogram {
				fns = append(fns, e)
			}
			return false
		}); err != nil {
			return nil, err
		}
	}
	return fns, nil
}
```

`walkEntry` 深度优先遍历，靠 DIE 树里 `Tag == 0` 的空条目判断子树结束；深度回到起点就停，不会串到下一个 CU（`pkg/dwarf/reader.go:290`）。每个 CU 单独 `Seek`，是"按包遍历"的具体形态。

`EntryRange` 兼容两种 `high_pc`（`pkg/dwarf/reader.go:275`）：

```go
func EntryRange(e *stddwarf.Entry) (start, end uint64, ok bool) {
	low, ok := e.Val(stddwarf.AttrLowpc).(uint64)
	if !ok {
		return 0, 0, false
	}
	switch v := e.Val(stddwarf.AttrHighpc).(type) {
	case uint64:
		return low, v, true
	case int64:
		return low, low + uint64(v), true
	}
	return 0, 0, false
}
```

`DW_AT_high_pc` 解成 `uint64` 就是绝对地址，解成 `int64` 就是偏移——类型分支即语义分支，不需要额外判断 DWARF 版本或属性的表单类别（class）。

#### 声明位置：`fillDecl` 与文件表下标

`DeclFile`/`DeclLine` 只在**按名查找**时填：`FindFunction` 解析完 DIE 后调 `fillDecl`（`pkg/proc/funcs.go:49`）。批量路径不调，于是：

- `funcs` 的 `(file:line)` 后缀不会出现——那个打印分支永远不触发；
- `list` 展示的源码位置（9.2.35）也不来自 `Function.DeclFile`，而是 `PCToLine`（`.debug_line` 的地址→行号映射）。

为什么不在批量路径里填？因为 `fillDecl` 的实现是"按名字再找一遍 DIE"（`pkg/proc/funcs.go:67`），核心就这几行（`cuForEntry`、`LineReader` 的错误分支从略）：

```go
declFileIdx, _ := entry.Val(stddwarf.AttrDeclFile).(int64)
declLine, _ := entry.Val(stddwarf.AttrDeclLine).(int64)
fn.DeclLine = int(declLine)

cu, err := bi.cuForEntry(entry.Offset) // 扫一遍 CU 找归属
lr, err := d.LineReader(cu)
files := lr.Files()
if int(declFileIdx) >= 0 && int(declFileIdx) < len(files) {
	fn.DeclFile = files[declFileIdx].Name
}
```

`cuForEntry`（`funcs.go:102`）要扫一遍 CU 找归属，`FindFunction` 又要扫一遍 DIE 树；对一个函数而言是常量级开销，对 2744 个函数就是平方级。真要补上，正确做法是在 `Subprograms` 遍历时顺手记住每个 DIE 所属 CU（CU 已知，文件表可缓存），但这段代码目前没有。

下标约定是这里最容易写错的地方：`DW_AT_decl_file` 的值就是所在 CU 行号表文件表的编号，`LineReader.Files()` 返回的切片按同一套编号可索引，**不做 ±1 换算**。实测 `_fixtures/loop`：

```text
CU "main": main.main decl_file=2 decl_line=13
len(Files)=7
FILES[0] = <nil>
FILES[1] = "<autogenerated>"
FILES[2] = ".../examples/debuggee/loop/main.go"
FILES[3] = ".../src/os/exec.go"
```

`decl_file=2` 取到 `FILES[2]`，正是 `loop/main.go`；`decl_line=13` 正是 `func main() {` 那一行（`examples/debuggee/loop/main.go:13`）。同一件事在单测里有断言（`pkg/proc/target_test.go:41`）：

```text
target_test.go:41: main.main declared at .../examples/debuggee/loop/main.go:13, entry 0x4b3940
```

顺带一个如实记录：`fillDecl` 的注释写的是"0 号条目为 `<autogenerated>`、源文件从 1 号开始"，而实测（go1.24.13 产物，经 Go 标准库 `debug/dwarf` 读取）0 号在 `Files()` 里是 `nil`、1 号才是 `<autogenerated>`、2 号起是源文件。两种说法指向同一条操作规则（直接下标、不要 ±1），但照注释推算偏移量就会错位一格——代码是对的，注释的编号示例不准。

#### 函数表缓存与 `FuncForPC`

`FuncForPC` 是这份切片的第二个用途：把 PC 反查成函数。调用栈回溯每帧（`pkg/proc/backtrace.go:45`）、`print` 读变量（`variables.go:83`）、`goroutines` 反查入口（`goroutines.go:280`）都会调它，所以它必须是对数级而不是线性扫（`pkg/proc/funcs.go:157`）：

```go
i := sort.Search(len(fns), func(i int) bool { return fns[i].Entry > pc })
for i--; i >= 0; i-- {
	if pc < fns[i].End {
		return &fns[i], nil
	}
}
return nil, fmt.Errorf("no function at %#x", pc)
```

`sort.Search` 定位到第一条 `Entry > pc` 的记录，退一条开始向前试：`pc < End` 才算命中。为什么要"向前扫"而不是只试一条？

- 同名函数可能有多个 subprogram DIE（包装与实现、跨 CU 的重复），入口相同的记录相邻，`End` 不覆盖 `pc` 的要跳过；
- 相邻函数之间存在填充（对齐、`int3` 区），落在填充里的 PC 不属于任何函数，继续往前才可能找到真正覆盖它的那个；
- 栈回溯拿到的返回地址落在 `CALL` 之后，属于调用者函数内部，`entry+1` 这种"函数中间地址"必须命中——`pkg/proc/funcs_test.go:49` 断言的就是这一点。

#### 谁在共用这份函数表

| 调用方 | 位置 | 过滤发生在 |
|---|---|---|
| `funcs` | `cmd/debug/funcs.go:37` | 客户端，`regexp.MatchString` |
| `trace` | `pkg/proc/trace.go:23` | 后端，`SetTracepoints` 内编译正则 |
| locspec `/re/`（`break /re/`、`list /re/`） | `pkg/proc/location.go:34` | 后端，`FindLocation` |
| `FuncForPC` | `pkg/proc/backtrace.go:45` 等 | 不按名字过滤，按地址命中 |

三处（不含 `FuncForPC`）都踩在同一份 `BinaryInfo.Functions()` 缓存上，但**过滤点不同**：`trace` 和 `break /re/` 把正则交给后端，后端遍历全量列表自己匹配，然后直接设点或返回地址；`funcs` 把全量列表拉回客户端再匹配。这不是随意选择：`trace`/`break` 的产出是地址，后端本来就要函数对象；`funcs` 的产出是文本，前端过滤可以少一次"后端为纯展示而做的遍历"。

`trace` 不经过 `funcs` 命令，`funcs` 也不调用 `trace`：两者只在"都调 `ListFunctions()`"这一点上相交。`funcs` 输出再多也不会顺手设点，`trace` 也不打印函数清单。

#### 能力边界

- **只有函数**：`cmd/debug/` 里没有 `types`、`sources` 之类的命令；`funcs` 列的是 `DW_TAG_subprogram` DIE，不含类型、源文件、变量。
- **没有调用图**：没有 `--follow`/深度参数，`ListFunctions()` 无参数。想按调用关系展开得自己反汇编找 `CALL`（第 8 章 `disass` 的机制），godbgv2 没有做，本书也不打算做。
- **无内联信息**：`DW_TAG_inlined_subroutine` 不参与列表；被内联的函数若仍有独立 subprogram DIE 会照常出现，但列表不告诉你它在何处被内联。
- **全量搬运**：`funcs main\.` 也会把 2744 条记录搬回前端，再丢掉 2741 条。交互式命令无所谓（人输入一次、等几十毫秒），但不适合"高频轮询函数表"。
- **顺序固定**：只按入口地址升序，没有 `--sort name`；REPL 里没有管道，想按名字看要自己另找工具。
- **声明位置为空**：如上，批量路径不填 `DeclFile`/`DeclLine`，所以 `funcs` 看不到声明位置。这是当前实现的现状，不是设计目标。

### 执行测试

调试目标是 `_fixtures/loop`（`make fixtures` 产出：固定工具链 go1.24.13、`-N -l`、非 PIE，`main.main` 入口固定在 `0x4b3940`）。

先看未锚定正则的"误伤"：`main.*` 不只命中 main 包，`runtime.main` 一族也被捞进来：

```text
godbg> funcs main.*
runtime.main 0x4405e0
runtime.main.func2 0x440980
runtime.main.func1 0x46d1e0
main.main 0x4b3940
matched 4 function(s)
godbg> funcs ^main\.
main.main 0x4b3940
matched 1 function(s)
```

`runtime.gopark` 同理：`runtime.goparkunlock` 含子串也被命中，加锚定才是唯一一条：

```text
godbg> funcs runtime.gopark
runtime.goparkunlock 0x440c60
runtime.gopark 0x470b00
matched 2 function(s)
godbg> funcs ^runtime\.gopark$
runtime.gopark 0x470b00
matched 1 function(s)
```

斜杠形式不认（`godbg> funcs /main\.main/` 只回 `matched 0 function(s)`）；零匹配不报错，只有参数个数、正则编译出错才报错（cobra 的 Usage 段从略）：

```text
godbg> funcs nomatchxyz
matched 0 function(s)
godbg> funcs [
Error: invalid regexp "[": error parsing regexp: missing closing ]: `[`
godbg> funcs
Error: usage: funcs <regexp>
```

再确认全量：`funcs .` 匹配一切，交互模式输出 2744 行、末尾 `matched 2744 function(s)`；这个数与 `readelf --debug-dump=info _fixtures/loop | grep -c DW_TAG_subprogram` 的 2744 一致，说明批量路径确实是"一个带地址的 subprogram DIE 一条记录"，没去重、也没漏。

一个批量回放的坑：`--init` 模式下**不要**用 `funcs .`。回放器为了支持 `@capture`，把每条命令的 stdout 临时换成 `os.Pipe()`，命令返回后才读走（`cmd/debug/shell.go:256`）；`funcs .` 的输出约 100 KB，超过管道缓冲（64 KiB）后写端阻塞，回放器又在等命令返回——互相等死，只能靠 `timeout` 收场。交互模式没有这层管道，2744 行正常刷出。冒烟脚本因此只用带锚定的正则。

`testdata/script/ch9.2.32.txt` 把这条链路固化成两条断言：一条精确到入口地址，一条只要求命中数非零（命中数随工具链浮动，用 `[0-9]+` 放宽）：

```text
# ch9.2.32 smoke: funcs 按正则列出函数（裸正则，与 delve 一致）
# _fixtures/loop 以固定工具链构建（-N -l），main.main 入口地址固定
funcs main\.main
=main\.main 0x4b3940
=matched 1 function\(s\)
funcs main\.
=main\.main 0x4b3940
=matched [0-9]+ function\(s\)
```

跑一遍：

```bash
$ ./scripts/smoke.sh ch9.2.32
smoke: running testdata/script/ch9.2.32.txt
smoke: all passed
```

### 本节小结

`funcs` 是全书最"薄"的符号层命令：后端 `BinaryInfo.Functions()` 把 58 个 CU 里的 2744 个 `DW_TAG_subprogram` DIE 扫一遍、只留带地址范围的、按入口地址排好，用 `sync.Once` 缓存成一份切片；命令层调一次 `ListFunctions()` 拿回整份快照，在客户端用正则过滤，逐行打印 `name 0xentry`，最后报命中数。契约里 `Function` 的五个字段只有前两个被它用到——`End` 留给按地址反查，`DeclFile`/`DeclLine` 留给按名查找，这正好解释了为什么 `funcs` 的输出没有 `file:line`。

能力边界一并记在这里：只列函数，没有类型/源文件清单；没有调用图，也没有内联展开；过滤一律在前端，后端只保证"全量、按入口升序"。要按调用关系观察，用 `trace`（后端过滤设点）或 `disass`（第 8 章）自己走，别指望 `funcs`。
