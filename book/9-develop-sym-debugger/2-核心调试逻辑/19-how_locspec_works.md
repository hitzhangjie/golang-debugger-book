## locspec解析与地址转换

符号级调试器与指令级调试器最直观的差别，是添加断点、查看源码这些操作都可以用字符串而不是裸地址来描述位置：`break main.main`、`break main.go:16`、`list +2`。这类字符串在 godbgv2 里叫 locspec（location spec，位置描述符）。

本节跟踪一条 locspec 的完整链路：前端把字符串原样交给后端，`pkg/locspec.Parse` 把它拆成扁平的 `LocSpec`，`proc.Target.FindLocation` 再用一个 switch 按字段落到符号层与行号表，换出指令地址。早先的版本按 tinydbg 的写法组织，为每种位置描述定义类型、各自实现查找方法；godbgv2 是净室实现，解析和转换分别集中在一个函数和一段 switch 里，下文一律以 godbgv2 代码为准。

### 实现目标

godbgv2 通过 locspec 支持以下位置写法（`cmd/debug/break.go:14-23` 的 help 文本、`docs/FEATURE-MATRIX.md` §3 第一行）：

| 写法 | 示例 | godbgv2 |
|---|---|---|
| 函数名（含包名） | `break main.main` | ✅ 精确全名 |
| 文件:行号 | `break main.go:16` | ✅ 前缀可省，仅语句行 |
| 绝对地址 | `break *0x4b3971` | ✅ 数值 |
| 相对偏移 | `break +2` / `break -- -2` | ⚠️ 需已有停止位置，`+0` 不可用 |
| 正则 | `break /main\./` | ✅ 可命中多个地址 |
| `func:line` | `break main.main:16` | ❌ |
| 裸行号 / 裸文件名 | `break 20` / `break main.go` | ❌ 前者被前端当成十进制地址，后者落到函数名分支 |
| `*<表达式>` | `break *ptr` | ❌ 只接受数值 |

对应的文法是原稿文法的真子集：

```text
loc ::= <funcname> | <file>:<line> | *<addr> | (+|-)<N> | /<regexp>/
```

两条约束决定了代码为什么这么短：**解析不接触目标进程**（`Parse` 只看字符串，输入输出都是纯数据，可被单元测试完整覆盖，`pkg/locspec/locspec_test.go`）；**转换才需要目标进程**（函数名查 DWARF、`file:line` 查行号表、`+N` 读寄存器，都只有在 `proc.Target` 上做得到，所以落在 `FindLocation`）。

### 基础知识

**locspec 是"两次转换"。** 第一次是字符串 → 字段：`"main.go:16"` 变成 `File="main.go"`、`Line=16`，只需要字符串处理。第二次是字段 → 地址：函数名要查 `.debug_info` 里的 `DW_TAG_subprogram`（`DW_AT_low_pc` 是入口、`DW_AT_high_pc` 是范围，`pkg/proc/funcs.go:34-61`），`file:line` 要查 `.debug_line` 行号表。两套数据没有交集，godbgv2 也就把这两次转换切成两个函数，边界正好是"要不要目标进程"。

**行号表只有语句行。** `lineProgram.emitRow` 在 `!p.isStmt` 时直接返回（`pkg/dwarf/line.go:628`），所以 `LineTable` 里没有注释行、空行、右花括号这些"不可下断点"的行。直接后果是：给这些行下断点会得到 `no address for ...`，而不是一个"不太合适"的地址。这相当于把 dlv 的 `includeNonExecutableLines` 选项在解析阶段就固化成了"不包含"。

### 代码实现

#### 1. 调用链：前端只交出字符串

```text
cmd/debug/break.go   break <loc> [if <cond>] [-n <name>]
      │  Client.CreateBreakpoint(loc, cond, name)
      │     └─ net/rpc: Debugger.CreateBreakpoint{Loc,Cond,Name}
      ▼
service/debugger.Debugger.CreateBreakpoint        (debugger.go:103)
      │  Target.CreateBreakpointByLoc(loc, cond, name)
      ▼
proc.Target.FindLocation(loc) ──────────────► []uint64
      │  locspec.Parse → switch 分支
      ▼
proc.Target.createBreakpoint(addr, loc) × N       (breakpoints.go:71)
```

`cmd/debug/break.go` 里真正和 locspec 相关的只有几行，其余是 cobra 的参数整理：

```go
spec := loc
if addr, err := parseAddress(loc); err == nil {
	spec = fmt.Sprintf("*%#x", addr)
}

// 位置描述（locspec）：可能解析出多个地址（如正则匹配）
bps, err := Client.CreateBreakpoint(spec, cond, name)
```

这段代码之前还有一条"纯指令地址"的快捷路径：`parseAddress(loc)` 成功且没带 `if`/`-n` 时直接走 `Client.AddBreakpoint`。两个容易踩的坑由此而来。其一，`parseAddress`（`cmd/debug/address.go:12`，`strconv.ParseUint(..., 0, 64)`）先跑，`break 20` 匹配成功，于是走 `AddBreakpoint(0x14)`，**根本到不了 locspec**。其二，`parseAddress` 成功但带了 `if`/`-n` 时字符串被改写成 `*0x...` 再交给 locspec，所以 `break 20 if x>0` 里的 `20` 依然是地址而不是行号。

`api.Client` 侧只有两个入口与 locspec 有关：`CreateBreakpoint(loc, cond, name) ([]Breakpoint, error)`（`pkg/service/api/client.go:88`）和 `ListSource(loc) (*ListSourceResult, error)`（`pkg/service/api/client.go:150`）。`FindLocation` **不是** RPC，它是 `proc.Target` 上的方法，两个入口在服务端汇合到它：`Debugger.CreateBreakpoint` 经 `CreateBreakpointByLoc` 调用（`debugger.go:107`），`Debugger.ListSource` 直接调用（`debugger.go:475`）。顺带澄清一处容易想当然的地方：`disass` 并**不**接受 locspec——`disassStartAddress` 无参时取 `Client.CurrentPC()`，有参时只调 `parseAddress`（`cmd/debug/disass.go:53-67`），所以 `disass main.main` 会报 `parse address err`，这与 dlv 的 `disassemble -l` 不同。

#### 2. 解析：Parse 只做字符串切分

`LocSpec` 是一个扁平结构，六个字段分别对应五种写法（`pkg/locspec/locspec.go:11-20`）：

| 输入 | `FuncName` | `File` | `Line` | `Addr` | `Offset` | `Pattern` |
|---|---|---|---|---|---|---|
| `main.main` | `main.main` | | 0 | 0 | 0 | |
| `main.go:16` | | `main.go` | 16 | 0 | 0 | |
| `*0x4b3971` | | | 0 | `0x4b3971` | 0 | |
| `+2` / `-2` | | | 0 | 0 | `2` / `-2` | |
| `/main\./` | | | 0 | 0 | 0 | `main\.` |

`Parse` 的分支顺序就是语法优先级（`locspec.go:31-83`）：

```go
func Parse(raw string) (*LocSpec, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("empty locspec")
	}
	ls := &LocSpec{Raw: raw}

	// 以 / 开头但未以 / 结尾：非法的正则描述符
	if strings.HasPrefix(raw, "/") != strings.HasSuffix(raw, "/") {
		return nil, fmt.Errorf("unterminated regexp locspec %q", raw)
	}

	switch {
	case strings.HasPrefix(raw, "*"):
		addr, err := strconv.ParseUint(raw[1:], 0, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid address locspec %q", raw)
		}
		ls.Addr = addr
	case strings.HasPrefix(raw, "+") || strings.HasPrefix(raw, "-"):
		off, err := strconv.Atoi(raw)
		if err != nil {
			return nil, fmt.Errorf("invalid offset locspec %q", raw)
		}
		ls.Offset = off
	case strings.HasPrefix(raw, "/") && strings.HasSuffix(raw, "/") && len(raw) > 1:
		pattern := raw[1 : len(raw)-1]
		if _, err := regexp.Compile(pattern); err != nil {
			return nil, fmt.Errorf("invalid regexp locspec %q", raw)
		}
		ls.Pattern = pattern
	case strings.Contains(raw, ":"):
		idx := strings.LastIndex(raw, ":")
		file, lineStr := raw[:idx], raw[idx+1:]
		line, err := strconv.Atoi(lineStr)
		if err != nil || file == "" || line <= 0 {
			return nil, fmt.Errorf("invalid file:line locspec %q", raw)
		}
		ls.File, ls.Line = file, line
	default:
		ls.FuncName = raw
	}
	return ls, nil
}
```

三处细节值得记住：

- **`/` 的前后缀检查在 switch 之前。** 这一条同时起着"正则必须成对"和"绝对路径不可用"两个作用。前者的报错是 `unterminated regexp locspec "/main\\./10"`；后者意味着 `/home/zhangjie/.../main.go:16` 会被判成未闭合正则——绝对路径的 `file:line` 目前无法使用，只能写相对路径或路径后缀。
- **`:` 用 `LastIndex` 切。** 于是 `main.main:16` 被切成 `File="main.main"`、`Line=16`，下一步的行号表查询必然失败。这是 `func:line` 不支持的根因：解析层并不认识"冒号左边可能是函数名"。
- **报错都带原串。** 解析层给出的是 `empty locspec`、`unterminated regexp locspec`、`invalid address/offset/regexp locspec`、`invalid file:line locspec` 这几种消息，都带 `%q`，所以前端 `Error:` 后面的内容能直接告诉用户"哪一段没被接受"。

#### 3. 转换：FindLocation 的一个 switch

```go
func (t *Target) FindLocation(loc string) ([]uint64, error) {
	ls, err := locspec.Parse(loc)
	if err != nil {
		return nil, err
	}

	switch {
	case ls.Addr != 0 || (len(ls.Raw) > 0 && ls.Raw[0] == '*'):
		return []uint64{ls.Addr}, nil

	case ls.Pattern != "":
		re, err := regexp.Compile(ls.Pattern)
		if err != nil {
			return nil, fmt.Errorf("invalid regexp %q: %v", ls.Pattern, err)
		}
		fns, err := t.ListFunctions()
		if err != nil {
			return nil, err
		}
		addrs := []uint64{}
		for _, fn := range fns {
			if re.MatchString(fn.Name) {
				addrs = append(addrs, fn.Entry)
			}
		}
		if len(addrs) == 0 {
			return nil, fmt.Errorf("no function matches %q", ls.Pattern)
		}
		return addrs, nil

	case ls.File != "":
		addr, err := t.LineToPC(ls.File, ls.Line)
		if err != nil {
			return nil, err
		}
		return []uint64{addr}, nil

	case ls.Offset != 0:
		// 当前 PC → 当前行 → 偏移行 → 地址
		pc, err := t.currentPC()
		if err != nil {
			return nil, err
		}
		file, line, err := t.bi.PCToLine(pc)
		if err != nil {
			return nil, fmt.Errorf("cannot resolve current line: %v", err)
		}
		addr, err := t.LineToPC(file, line+ls.Offset)
		if err != nil {
			return nil, err
		}
		return []uint64{addr}, nil

	default:
		fn, err := t.FindFunction(ls.FuncName)
		if err != nil {
			return nil, err
		}
		return []uint64{fn.Entry}, nil
	}
}
```

五个分支对应五种能力，逐一说明它们依赖什么：

- **`*addr`**：只做一次数值判断，直接返回。`Addr != 0 || Raw[0]=='*'` 这个条件是为了让 `*0x0` 也能进这一支（`Raw` 判断兜底），否则地址 0 会被当成"没解析出地址"。
- **`/regexp/`**：遍历 `ListFunctions()`（DWARF 全部 `DW_TAG_subprogram`，`pkg/proc/target.go:46`）做 `MatchString`，命中即取其 `Entry`。**这是唯一会返回多个地址的分支**，也是断点层"一条命令多条断点"的来源。
- **`file:line`**：`LineToPC` 线性扫描行号表，返回**第一条**满足 `row.Line == line && strings.HasSuffix(row.File, file)` 的记录（`pkg/dwarf/line.go:50-57`）。不做路径映射、不校验地址是否落在某个函数范围内、不返回多个地址。
- **`+N`/`-N`**：`currentPC()` 读当前线程寄存器（`location.go:82-92`）→ `PCToLine` 得到当前 `file:line` → `LineToPC(file, line+N)`。纯往返，没有范围检查。
- **default（函数名）**：`FindFunction` 精确匹配 `DW_AT_name`，返回 `Entry`（`pkg/proc/funcs.go:35-51`）。它只返回一个地址——`FindFunction` 取第一个同名 DIE，所以"同名函数多地址"在 godbgv2 不存在，多地址只可能来自 `/regexp/`。

#### 4. 逐形式的语法与边界

**4.1 函数名**：`main.main`、`runtime.main`、`loop.(*T).Run` 这类**完整的 DWARF 名称**可用。匹配是 `e.Val(stddwarf.AttrName) == name`（`pkg/dwarf/reader.go:54`）——全等，没有后缀匹配、没有"候选唯一则接受"的消歧。所以 `break main`、`break loop` 都是 `Error: function "main" not found`。这一点与书稿早先写的"用后缀也可以"相反，读者不要照旧稿试。

`break main.main` 落在 `DW_AT_low_pc`，即函数第一条指令。`loop` fixture 里它是 `0x4b3940`（`main.go:13`），反汇编出来是 `lea -0x10(%rsp),%r12`，也就是 Go 的栈检查序言。为什么会停在序言而不是第一条"用户语句"、有什么影响，见 9.2.21；这里只需记住：函数名 locspec 不做序言跳过。

**4.2 `file:line`**：冒号左边是文件（后缀匹配），右边是行号（`>0`）。两种写法都可用：`main.go:16` 与 `loop/main.go:16`。三个边界：

- **后缀匹配会误命中。** `LineToPC` 用 `HasSuffix`，`break in.go:16` 会匹配到 `main.go:16`（`main.go` 以 `in.go` 结尾），实跑确实停在 `0x4b3971`。文件名写得越短，越容易撞上。
- **绝对路径不可用**：以 `/` 开头会被 `Parse` 的预检判成未闭合正则（见 4.6）。
- **只认语句行**：`break main.go:11`（`main.go` 里是右花括号 `)`）报 `no address for .../main.go:11`。注意这个报错发生在 `LineToPC` 里，措辞是 `no address for`，与解析层的 `invalid ... locspec` 可区分。

**4.3 `*addr`**：`strconv.ParseUint(raw[1:], 0, 64)`，所以 `*0x4b3971`、`*4929905`（同一个地址的十进制写法）、`*0` 都按 Go 的 `base=0` 约定解析。`break 0x4b3971` 不带 `*` 时走前端 `parseAddress` 的快捷路径，效果相同但用的是另一个 RPC（`AddBreakpoint`）。

`*<表达式>` 不支持：`break *main.main` 报 `Error: invalid address locspec "*main.main"`。老稿里"`*` 后面是一个表达式，用 `EvalExpression` 求出地址"的写法在 godbgv2 尚未接线——9.2.18 的求值器目前只服务于 `print`/`condition`。

**4.4 `+N` / `-N`**：语义是"当前停止位置所在源码行 ± N 行"。它成立的前提是**已经停下来过**：进程刚 exec 时的 PC 在 `runtime/rt0_linux_amd64.s:8`，此时 `break +2` 会去查 `rt0_linux_amd64.s:10` 并报 `no address`——不是偏移算错，而是起始位置本身就没有可用的源码行。停在 `main.go:13` 之后 `break +2` 就正常了：解析到 `main.go:15`、地址 `0x4b3964`，`list +2` 显示的也是同一行同一地址。

四个已知边界：

1. **`+0` 不可用（缺陷）。** 分支条件是 `ls.Offset != 0`（`location.go:56`），`+0` 解出的 `Offset` 就是 0，于是掉进 `default` 当函数名查，报 `Error: function "" not found`。修复只需把条件改成同时看 `Raw[0]`，但这属于代码改动，本节只如实记录缺口。
2. **`-N` 会被 cobra 当成 flag。** `break -2` 的报错是 `unknown shorthand flag: '2' in -2`；要写成 `break -- -2` 才能进 locspec。这一点在 help 里没有提示。
3. **不校验范围。** `line+offset` 越界或跨到别的函数，都只是把新行号丢给行号表：`+100` 得到 `no address for .../main.go:113`，跨函数时则可能悄悄落到另一个函数的某行上。
4. **只看当前线程。** `currentPC` 读的是 `CurrentThreadTid` 的寄存器，**不理会** `thread`/`goroutine` 选择。而 `list` 不带参数时走 `Registers()`（`pkg/proc/goroutines.go:300`），是尊重选择的。两者在"选了别的 goroutine"时会对不上。

**4.5 `/regexp/`**：`re.MatchString(fn.Name)` 不锚定，`/main/` 会命中所有名字含 `main` 的函数。多命中时 `FindLocation` 返回多个地址，**不报歧义**——`break` 会为每个地址建一条逻辑断点：

```text
godbg> break /main\./
breakpoint 1 added at 0x440980 (.../runtime/proc.go:205)
breakpoint 2 added at 0x46d1e0 (.../runtime/proc.go:172)
breakpoint 3 added at 0x4b3940 (.../loop/main.go:13)
```

三个命中分别是 `runtime.main.func2`、`runtime.main.func1` 与 `main.main`（本节输出块里仓库与工具链的绝对路径前缀统一写成 `...`，实跑输出为完整路径）。没有命中时报 `Error: no function matches "nomatch"`（注意引号里是去掉 `/` 之后的正则原文）。

`list` 的处理相反：它只需要一个位置，所以多地址会拼成歧义错误并列出候选（`debugger.go:479-492`），实跑 `list /main\./` 得到 `Error: location "/main\\./" is ambiguous: runtime.main.func2, runtime.main.func1, main.main`。

候选超过三个时只列前三个并追加 `(and N more)`。另外，命名断点不能对应多个地址，会在断点层被拒：`break -n multi /main\./` → `breakpoint name "multi" cannot be used for 3 locations`。

**4.6 不支持的写法**，以及它们各自的报错——这些报错就是"当前实现不认这个语法"的证据：

| 输入 | 报错 | 原因 |
|---|---|---|
| `main.main:16` | `no address for main.main:16` | 被切成 `File="main.main"`，行号表查不到 |
| `16` | `list` 报 `function "16" not found`，`break` 报 `peek text, pid: …, 0 bytes, error: input/output error` | `list` 落到函数名分支；`break` 被前端当十进制地址 0x14 |
| `main.go` | `function "main.go" not found` | 落到函数名分支 |
| `*main.main` | `invalid address locspec "*main.main"` | 只接受数值 |
| `/abs/path/main.go:16` | `unterminated regexp locspec "…"` | 以 `/` 开头、不以 `/` 结尾 |
| `/main\./10` | `unterminated regexp locspec "/main\\./10"` | 正则后不能跟行偏移 |
| `main.go:0` | `invalid file:line locspec "main.go:0"` | 行号必须 `>0` |
| `/ma(in/` | `invalid regexp locspec "/ma(in/"` | 正则编译失败 |

#### 5. 多匹配如何落到断点

`FindLocation` 只负责"字符串 → 地址列表"，把它变成断点的是 `CreateBreakpointByLoc`（`pkg/proc/location.go:99-130`，与 `cmd/debug/break.go` 同属 ch9.2.22 的交付物）：

```go
func (t *Target) CreateBreakpointByLoc(loc, cond, name string) ([]*Breakpoint, error) {
	if err := t.validateBreakpointName(name); err != nil {
		return nil, err
	}
	addrs, err := t.FindLocation(loc)
	if err != nil {
		return nil, err
	}
	// 命名断点只能对应一个位置：多个位置共用一名会使"按名引用"产生歧义
	if name != "" && len(addrs) > 1 {
		return nil, fmt.Errorf("breakpoint name %q cannot be used for %d locations", name, len(addrs))
	}
	bps := []*Breakpoint{}
	for _, addr := range addrs {
		bp, err := t.createBreakpoint(addr, loc, UserBreakpoint)
		if err != nil {
			for _, created := range bps {
				_, _ = t.ClearBreakpoint(created.ID)
			}
			return nil, err
		}
		bp.Name = name
		bp.Cond = cond
		bps = append(bps, bp)
	}
	return bps, nil
}
```

三个要点：

1. **顺序是"先校验名字、再解析位置"。** 所以 `break -n 123 main.main` 报的是名字错误（`cannot be all digits`，见 `validateBreakpointName`），而不是位置错误；名字重复同理。
2. **N 个地址 = N 条逻辑断点。** godbgv2 的 `Breakpoint.Addr` 是单地址，没有"一条逻辑断点挂多个物理断点"的模型，所以正则多命中就是"多建几条"。中途失败会逐条回滚已建的断点，不会留下半套。
3. **同址复用。** `createBreakpoint` 发现该地址已有用户断点时，直接返回既有逻辑断点（`breakpoints.go:84-86`），所以重复 `break` 同一位置不会产生新编号：`break main.go:16` 之后（或之前）再 `break *0x4b3971`，打印的始终是同一个编号，`breakpoints` 里也仍只有一条。

同址复用有一个副作用值得记下来：`CreateBreakpointByLoc` 在拿到复用的 `bp` 之后仍会执行 `bp.Name = name`、`bp.Cond = cond`。于是 `break -n alpha main.main` 之后再 `break -n beta main.main`，不会报重名，而是把**同一条**断点改名成 `beta`——实跑 `breakpoints` 只显示 `name:beta`。若期望"命名断点必须唯一"，这里与直觉不符。

### 执行测试

下面的输出都是实跑结果。调试对象是 `_fixtures/loop`（源文件 `examples/debuggee/loop/main.go`，用固定工具链 `-gcflags "all=-N -l"` 构建，因此 `main.main` 入口固定为 `0x4b3940`、循环体在 `0x4b3971`）。驱动方式是批量回放：

```bash
$ ./godbg exec _fixtures/loop --init init.txt
```

先验证两种最常用的写法。`init.txt` 内容为 `break main.main`、`break main.go:16`：

```text
godbg> break main.main
breakpoint 1 added at 0x4b3940 (/home/zhangjie/debugger101/godbgv2/examples/debuggee/loop/main.go:13)
godbg> break main.go:16
breakpoint 2 added at 0x4b3971 (/home/zhangjie/debugger101/godbgv2/examples/debuggee/loop/main.go:16)
```

再验证相对偏移：先停在 `main.main`，再 `break +2`、`list +2`：

```text
godbg> break main.main
breakpoint 1 added at 0x4b3940 (.../loop/main.go:13)
godbg> continue
thread 1939700 status: stopped: trace/breakpoint trap
> .../loop/main.go:13 (pc: 0x4b3941)
stop all threads now
continue ok
godbg> break +2
breakpoint 2 added at 0x4b3964 (.../loop/main.go:15)
godbg> list +2
Showing .../loop/main.go:15 (PC: 0x4b3964)
```

`break +2` 与 `list +2` 得到同一个地址，说明两条命令确实共用 `FindLocation`；`(pc: 0x4b3941)` 是断点命中后回退到 `int3` 之前的位置，第 9.2.22 节解释过。

正则多命中的会话前面已贴（4.5 节），此处不重复。错误用例必须**一条命令一个脚本**：`--init` 回放遇到第一条报错即中止，后续命令不会执行。实跑得到的错误消息汇总如下（`pid` 与长路径做了省略）：

```text
godbg> break main.main:16      Error: no address for main.main:16
godbg> break +0                Error: function "" not found
godbg> break main              Error: function "main" not found
godbg> break main.go           Error: function "main.go" not found
godbg> break -2                Error: unknown shorthand flag: '2' in -2
godbg> break -- -2             Error: no address for .../loop/main.go:11
godbg> break /nomatch/         Error: no function matches "nomatch"
godbg> break -n multi /main\./ Error: breakpoint name "multi" cannot be used for 3 locations
godbg> break -n 123 main.main  Error: breakpoint name "123" cannot be all digits
godbg> break main.go:0         Error: invalid file:line locspec "main.go:0"
```

最后是纯字符串解析的单元测试——这层不需要启动调试会话，所以能穷举边界：

```bash
$ go test ./pkg/locspec/ -v -run TestParse
=== RUN   TestParse
--- PASS: TestParse (0.00s)
=== RUN   TestParseInvalid
--- PASS: TestParseInvalid (0.00s)
PASS
ok  	github.com/hitzhangjie/godbgv2/pkg/locspec	0.001s
```

`TestParse` 覆盖六种写法的字段映射，`TestParseInvalid` 覆盖 `""`、`main.go:`、`main.go:0`、`*xyz`、`/unclosed` 五种非法输入（`pkg/locspec/locspec_test.go:6-36`）。godbgv2 没有 `ch9.2.19` 的冒烟脚本：本节的交付物是一个纯函数，用单元测试断言比回放会话更直接；端到端的行为由 `ch9.2.22` 的脚本覆盖。

### 本节小结

locspec 把"位置"从地址提升成字符串，代价是必须有一条可靠的转换链。godbgv2 把它拆成两段：`pkg/locspec.Parse` 只做字符串切分，产出一个扁平 `LocSpec`（`FuncName`/`File`/`Line`/`Addr`/`Offset`/`Pattern`）；`proc.Target.FindLocation` 用一个 switch 把每种字段落到符号层与行号表上，其中函数名查 DWARF 的 `DW_TAG_subprogram`、`file:line` 查 `.debug_line` 反查首个匹配行、`+N` 走"读寄存器 → `PCToLine` → `LineToPC`"的往返、`/regexp/` 是唯一会返回多个地址的分支。多地址向上传递后，断点层为每个地址建一条逻辑断点（同址则复用），`list` 则把它当歧义并列出候选。

能力边界同样重要：`func:line`、裸行号、裸文件名、`*<expr>`、绝对路径的 `file:line` 都不支持；`+0` 因 `Offset != 0` 的判断不可用；`-N` 需要 `--` 才能绕过 cobra；行号表只含语句行，注释行与空行没有地址。这些不是"实现细节"，而是读者在命令行上会直接撞到的行为，写进本节比留到 issue 里更有用。

### 参考文献

1. DWARF Debugging Information Format v4, §6.2 Line Number Information, https://dwarfstd.org/doc/DWARF4.pdf；godbgv2 能力口径 `docs/FEATURE-MATRIX.md` §3 断点体系
