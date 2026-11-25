## 从 locspec 到源码：LineToPC 与源码列表

本节由 tag `ch9.2.20`（commit `b605fcf`）追溯。这个提交只动了两个文件、63 行：`pkg/dwarf/line.go` 增加 `LineToPC`（+12），`pkg/proc/source.go` 新增行号表获取、`LineToPC` 封装与源码读取（+51）。**反汇编相关代码一行未改**——`disass` 命令、`pkg/target/disassemble.go`、`x86asm` 解码都是第 6 章 6.6 的交付物。

所以本节不写反汇编器，而写它旁边那条更基础、也更容易被忽略的链路：**源码位置 ↔ 指令地址**。一条是正向的 `PCToLine`（地址 → 文件:行号），第 8 章解析行号表时已经具备；另一条是本节新增的反向 `LineToPC`（文件:行号 → 地址）。有了这一对，`list [loc]` 才能把 `main.go:16` 这样的输入变成一条可下断点、可展示的地址，并把该行上下各 5 行源码连同 `=>` 标注一起还给前端。文件名沿用 `20-debug_disassemble.md` 只是历史原因，不随标题改；旧稿以 tinydbg 的 `disassemble` 为主角，本版按 tag 的实际交付物重新定主题。

### 实现目标

`list`（别名 `ls`、`l`）显示某个位置附近的源码：

| 输入 | 示例 | 定位方式 |
|---|---|---|
| 无参数 | `list` | 当前调试上下文的 PC → `PCToLine` |
| 文件:行号 | `list main.go:16` | `LineToPC` 反查 |
| 相对偏移 | `list +1` / `list -- -2` | 当前行 ± N 后再 `LineToPC` |
| 函数名 | `list main.main` | 函数入口地址 |
| 绝对地址 | `list *0x4b3971` | 原样使用 |
| 正则 | `list /main/` | 多命中时报歧义 |

要交付的东西可以拆成三块：

1. **反查**：给定 `file:line`，在 `.debug_line` 的行记录里找到地址（`dwarf.LineTable.LineToPC`）；
2. **取值**：按行号窗口把源码文件切片，返回首行行号与行文本（`proc.Target.SourceLines`）；
3. **串联**：`list` 命令 → `api.Client.ListSource` → `Debugger.ListSource`，把 PC、行号、窗口与"是否当前行"组装成 `ListSourceResult`。

溯源补一句：tag 的交付物就是**行号表反查**与**源码列表**。提交里这两个函数分别叫 `LineToPC` 和 `SourceList(fn *Function)`（按函数把整个源文件读成 `[]string`），提交信息也是 `LineToPC 与源码列表 SourceList`；当前代码里它已演进为按行窗口切片的 `SourceLines(file, line, context)`，`LineTable` 也从 `proc` 层直接读节改成了 `BinaryInfo` 缓存。下文以当前代码为准。

#### 反汇编命令在 6.6，本节不重复

需要先划清界限：godbgv2 的 `disass` 是一个**只认地址**的简单命令（`cmd/debug/disass.go:11-14`，别名 `dis`、`disassemble`），实跑的 help 如下：

```text
godbg> help disass
反汇编机器指令（缺省从当前停止位置开始）

disass [address]
      --clearall        反汇编时排除已有断点的影响
  -h, --help            help for disass
  -n, --max uint        反汇编指令数量 (default 10)
  -s, --syntax string   反汇编指令语法，支持：go, gnu, intel (default "gnu")
```

与 dlv 的 `disassemble [-a <start> <end>] [-l <locspec>]` 不同，godbgv2 既没有地址区间 `-a`，也不接受 locspec：无参时取 `Client.CurrentPC()`，有参时经 `disassStartAddress` 调 `parseAddress`（`disass.go:51-67`），所以 `disass main.main` 的结果是：

```text
godbg> disass main.main
Error: parse address err: invalid address: strconv.ParseUint: parsing "main.main": invalid syntax
```

反汇编的解码、语法风格、断点字节还原与 `disass` 命令本体都在 [6.6 反汇编](../../6-develop-inst-debugger/6-disassemble.md)。本节只在需要说明"地址拿去干什么"时提到它。

### 基础知识

#### 行号表：地址 → 文件:行号

`.debug_line` 按编译单元存一组行号程序，执行后得到"地址 → 文件、行号"的记录。godbgv2 把每条记录压成三字段（`pkg/dwarf/line.go:22-26`）：

```go
type LineEntry struct {
	File    string // 源文件
	Line    int    // 行号
	Address uint64 // 对应的机器地址
}
```

解析完所有单元后按地址升序排序（`line.go:124`），正向查询就退化成一次倒序扫描（`line.go:34-41`）：

```go
// LineForPC 返回地址 pc 对应的源码位置（取 <= pc 的最近一行）
func (lt *LineTable) LineForPC(pc uint64) (file string, line int, err error) {
	for i := len(lt.rows) - 1; i >= 0; i-- {
		if lt.rows[i].Address <= pc {
			return lt.rows[i].File, lt.rows[i].Line, nil
		}
	}
	return "", 0, fmt.Errorf("no line entry for pc %#x", pc)
}
```

取"`<= pc` 的最近一行"而不是"相等的一行"，是因为一条源码行通常对应多条指令，PC 停在其中任意一条上都应归到同一行；断点命中时 PC 还会比断点地址大 1（`int3` 已被执行），正靠这个"最近且不超过"的语义才落回原行。

这层映射是**多对一**的：同一个 `file:line` 可以有多条记录。`loop/main.go` 的行表里，第 16 行就有 `0x4b3971`、`0x4b3977` 两个地址（`readelf --debug-dump=decodedline _fixtures/loop`）。这正是反向查询必须先回答"多个地址取哪个"的原因。

#### 反查不是正向的逆

正向是函数，反向就得在多值里挑一个。`LineToPC` 的约定是**返回行表中的第一条命中**（`pkg/dwarf/line.go:50-57`）：

```go
// LineToPC 返回文件 file 行号 line 对应的首个地址（ch9.2.20）。
// 文件匹配采用后缀匹配（行号表中的路径可能带编译目录前缀）。
func (lt *LineTable) LineToPC(file string, line int) (uint64, error) {
	for _, row := range lt.rows {
		if row.Line == line && strings.HasSuffix(row.File, file) {
			return row.Address, nil
		}
	}
	return 0, fmt.Errorf("no address for %s:%d", file, line)
}
```

三个决定都藏在这 7 行里：

- **全表线性扫描**：没有建 `map[file:line][]addr` 索引。行记录动辄数万条，而 `list`/`break` 是交互命令，一次线性扫描（毫秒级）比维护索引更划算，也避免了索引与行表两份数据不一致；
- **后缀匹配**：行记录里的 `File` 是"编译目录 + 文件名"（`emitRow` 用 `directories[didx] + "/" + name` 拼出来），用户很少愿意敲全路径，于是 `main.go:16` 用 `HasSuffix` 匹配 `…/examples/debuggee/loop/main.go`。代价是误命中：`list in.go:16` 同样成立，因为 `main.go` 以 `in.go` 结尾；
- **第一条即返回**：由于 `rows` 已按地址升序，第一条就是该行**地址最低**的记录，通常也是语句的起点。对 `break` 来说这是对的；对"我已经停在这里"的语义则不够——这正是后端不用反查结果判断"当前行"的原因。

于是两者只满足一个方向的不等式：`PCToLine(pc)` 得到 `file:line` 后再 `LineToPC`，地址只会 `<= pc`；反过来，`LineToPC` 只给出该行第一份副本的地址，其余副本（泛型实例化、内联展开、同一源文件被多个编译单元引用）永远轮不到。

#### 只有语句行，且不带 prologue 信息

行号程序的状态机为每条指令维护 `is_stmt`、`prologue_end`、`discriminator` 等寄存器，但 `emitRow` 只把 `is_stmt` 为真的状态写成行记录，第一句就是 `if !p.isStmt { return }`（`pkg/dwarf/line.go:629-632`）。`prologueEnd` 在 `DW_LNS_set_prologue_end` 时置位（`line.go:612-613`），随后被丢弃——`LineEntry` 里没有这个字段。带来的直接后果：

- 注释行、空行、部分右花括号在行号表里没有记录，`LineToPC` 找不到地址：`loop/main.go` 的行表只有 13–17 行，`}` 所在的 18、19 行没有记录，所以从第 16 行 `+2` 会报 `no address for …/main.go:18`。这类行可能压根没被行号程序生成，也可能生成后因 `is_stmt` 为假被 `emitRow` 丢弃，两种都会让该行查不到；
- 没有"跳过序言"的能力：`break main.main` 落在函数入口 `0x4b3940`，对应第 13 行（`func main() {` 的声明行），而不是第一条可执行语句。delve 用 `prologue_end` 把函数断点前移到序言之后，godbgv2 没有这一步；Go 的函数入口是栈检查、没有帧指针序言，教学版停在这里仍然可用，但与 dlv 的落点不同。

另外，同一地址若产生多行记录，`emitRow` 保留最后一条（`line.go:656-660`）：一条指令对应多行语句时以最后一条为准，避免同一地址出现互相矛盾的行号。

### 代码实现

从敲下 `list` 到打印源码，链路如下（每一步后面是文件:行）：

```text
godbg> list main.go:16
 └─ cmd/debug/list.go:40                                  Client.ListSource(loc)
     └─ pkg/service/api/client.go:150 → pkg/service/debugger/debugger.go:458   ListSource
         ├─ loc==""   → d.t.Registers().PC()             debugger.go:468-473
         ├─ loc!=""   → d.t.FindLocation(loc)            pkg/proc/location.go:19
         │                └─ file:line / +N → t.LineToPC pkg/proc/source.go:47 → pkg/dwarf/line.go:50
         ├─ PCToLine(pc)                                 pkg/proc/funcs.go:178 → line.go:34
         └─ t.SourceLines(file, line, 5)                 pkg/proc/source.go:16
```

#### 命令层：只负责打印

`cmd/debug/list.go` 不解析 locspec，也不读文件，只把 `loc` 原样交给后端，再按下标还原行号（`list.go:40-52`）：

```go
res, err := Client.ListSource(loc)
if err != nil {
	return err
}
fmt.Printf("Showing %s:%d (PC: %#x)\n", res.File, res.Line, res.PC)
for i, text := range res.Lines {
	ln := res.StartLine + i
	if res.Current && ln == res.Line {
		fmt.Printf("=> %4d:\t%s\n", ln, text)
	} else {
		fmt.Printf("   %4d:\t%s\n", ln, text)
	}
}
```

注意 `ln := res.StartLine + i`：后端返回的是行文本数组，首行行号单独给出。这样切片可以越界钳制（下文 `list` 只显示 11–19 行），前端仍能打印真实行号，不需要知道文件总行数。

#### 契约：`ListSourceResult`

前后端之间只传这份快照（`pkg/service/api/types.go:142-149`）：

```go
type ListSourceResult struct {
	File      string   // 源码文件
	PC        uint64   // 定位所用地址
	Line      int      // 目标行（当前 PC 行或 locspec 解析到的行）
	StartLine int      // Lines[0] 对应的行号
	Lines     []string // 源码行（Line 上下各 5 行）
	Current   bool     // Line 是否为当前调试位置
}
```

六个字段各司其职：`PC` 让前端能显示地址（`Showing … (PC: 0x4b3971)`），`StartLine`/`Lines` 负责窗口，`Current` 决定是否加箭头。`Current` 是**后端**判断的，前端不看"PC 是否等于行首地址"。

#### 门面：`Debugger.ListSource`

门面负责三件事：定位 PC、把 PC 转成文件行、取窗口（`pkg/service/debugger/debugger.go:458-520`）。定位部分：`loc` 为空时读 `d.t.Registers().PC()` 并把 `current` 置真；否则交给 `d.t.FindLocation(loc)`，返回多个地址时不猜，直接报歧义并列出前 3 个函数名。

无参形态读的是 `Target.Registers()`，它按"选中线程 > 选中 goroutine > 当前事件线程"的顺序取寄存器（`pkg/proc/goroutines.go:300`）。两种形态在拿到 PC 后汇合：

```go
file, line, err := d.t.BinaryInfo().PCToLine(pc)
if err != nil {
	return nil, err
}
if file == "" {
	return nil, fmt.Errorf("no source file for pc %#x", pc)
}
// 无行号信息（line<1）：从文件首行展示但不标注箭头
if line < 1 {
	line, current = 1, false
}
start, lines, err := d.t.SourceLines(file, line, listContextLines)
```

`listContextLines` 就是 5（`debugger.go:524`），与 dlv 的 `source-list-line-count` 默认值一致。`line < 1` 是防御分支：`LineForPC` 正常至少返回 1，真拿到 0 时从第 1 行开始且不标箭头，避免负数下标。

`FindLocation` 里与本节相关的只有两个分支（`pkg/proc/location.go:49-70`）：

```go
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
```

`file:line` 分支是纯反查；`+N/-N` 分支是"读当前 PC → 正向查行 → 行号加偏移 → 再反查"，一个来回。locspec 的字符串解析（`pkg/locspec.Parse`）与其余分支见 [9.2.19](19-how_locspec_works.md)，这里不重复。

`Target.LineToPC` 本身只是薄封装，解析与缓存都在 `BinaryInfo` 上（`pkg/proc/source.go:42-53`）：

```go
func (t *Target) LineToPC(file string, line int) (uint64, error) {
	lt, err := t.LineTable()
	if err != nil {
		return 0, err
	}
	return lt.LineToPC(file, line)
}
```

`BinaryInfo.LineTable` 用 `sync.Once` 缓存解析结果（`pkg/proc/bininfo.go:37-41`、`:122`）：读 `.debug_line` 节、`SHF_COMPRESSED` 时先解压、再 `ParseLine(data, 8)`。tag 提交当时的 `LineTable` 直接写在 `proc` 层且没有缓存；现在这一步收进了 `BinaryInfo`，`list`、`break`、`bt` 共用同一份行表。

#### 源码窗口：`SourceLines`

拿到 `file:line` 之后，取窗口的逻辑只有二十来行（`pkg/proc/source.go:16-38`，文档注释略）：

```go
func (t *Target) SourceLines(file string, line, context int) (start int, lines []string, err error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return 0, nil, err
	}
	all := strings.Split(string(data), "\n")
	if len(all) > 0 && all[len(all)-1] == "" {
		all = all[:len(all)-1]
	}

	start = line - context
	if start < 1 {
		start = 1
	}
	if start > len(all) {
		return 0, nil, nil
	}
	end := line + context
	if end > len(all) {
		end = len(all)
	}
	return start, all[start-1 : end], nil
}
```

四个细节：

1. **按行文本切片，不按字节**：`strings.Split` 后丢弃末尾换行产生的空元素，行号与编辑器一致；
2. **窗口钳制**：`start` 不小于 1、`end` 不超过总行数。`list` 停在 16 行时窗口是 11–19，不是 11–21，因为文件只有 19 行；
3. **目标行越界返回空**：`start > len(all)` 时返回 `(0, nil, nil)`，`list` 只打印 `Showing` 头、没有正文。这通常意味着二进制与源码不同步（行号表来自旧编译），而不是文件读失败——后者在 `os.ReadFile` 处报错；
4. **文件路径来自行号表**：编译期记录的绝对路径被 `os.ReadFile` 直接使用，源码被移动或删除时报 `no such file or directory`，godbgv2 没有 dlv 的 `substitute-path` 映射。

`SourceLines` 向上返回 `start` 与 `lines` 两个值，而不是把它们塞进一个结构体：`lines[i]` 的行号恒等于 `start+i`，前端只需一个整数就能补齐所有行号。

#### `=>` 只属于"当前行"

`Current` 在两种情况下为假：有参定位（`FindLocation` 的任意分支），以及 `line < 1` 的兜底。所以同样是第 16 行，两种问法结果不同：

```text
godbg> list
Showing …/loop/main.go:16 (PC: 0x4b3972)
=>   16:			fmt.Printf("pid: %d, loop: %d\n", pid, i)

godbg> list main.go:16
Showing …/loop/main.go:16 (PC: 0x4b3971)
     16:			fmt.Printf("pid: %d, loop: %d\n", pid, i)
```

地址差 1 的原因在断点：`break main.go:16` 把 `0x4b3971` 的首字节换成 `int3`，命中后 PC 停在 `0x4b3972`。无参 `list` 用真实 PC 走 `PCToLine(0x4b3972)`，落回第 16 行并标箭头；`list main.go:16` 用反查得到 `0x4b3971`，语义是"查看这一行"，不是"我正在这一行"，于是不标箭头。若反查结果也拿来判"当前行"，断点命中时反而会判错。

### 执行测试

调试对象是 `_fixtures/loop`（源码 `examples/debuggee/loop/main.go`，go1.24.13 构建，`main.main` 入口 `0x4b3940`）。用 `--init` 批量回放，脚本内容如下：

```text
break main.go:16
continue
list
list main.go:16
list +1
list -- -2
list main.main
list *0x4b3971
exit
```

启动与线程状态行、路径前缀省略后，输出为：

```text
godbg> break main.go:16
breakpoint 1 added at 0x4b3971 (…/loop/main.go:16)
godbg> continue
> …/loop/main.go:16 (pc: 0x4b3972)
godbg> list
Showing …/loop/main.go:16 (PC: 0x4b3972)
     11:	)
     12:
     13:	func main() {
     14:		pid := os.Getpid()
     15:		for i := 0; ; i++ {
=>   16:			fmt.Printf("pid: %d, loop: %d\n", pid, i)
     17:			time.Sleep(time.Second)
     18:		}
     19:	}
```

其余写法的首行如下，正文与上例同源、窗口不同：

```text
godbg> list main.go:16
Showing …/loop/main.go:16 (PC: 0x4b3971)
godbg> list +1
Showing …/loop/main.go:17 (PC: 0x4b3a47)
godbg> list -- -2
Showing …/loop/main.go:14 (PC: 0x4b395a)
godbg> list main.main
Showing …/loop/main.go:13 (PC: 0x4b3940)
godbg> list *0x4b3971
Showing …/loop/main.go:16 (PC: 0x4b3971)
godbg> list in.go:16
Showing …/loop/main.go:16 (PC: 0x4b3971)
```

这些地址都能在行表里对上：第 13 行 `0x4b3940`、第 14 行 `0x4b395a`、第 15 行 `0x4b3964`、第 16 行 `0x4b3971`、第 17 行 `0x4b3a47`。`list in.go:16` 是后缀误命中的现场——文件参数写的是 `in.go`，反查却命中了 `main.go` 的记录。

错误用例必须一条命令一个脚本：回放遇到第一条报错即中止，后续命令不会执行。实跑得到：

```text
godbg> list +2
Error: no address for …/loop/main.go:18
godbg> list +0
Error: function "" not found
godbg> list -2
Error: unknown shorthand flag: '2' in -2
godbg> list main
Error: function "main" not found
godbg> list /main/
Error: location "/main/" is ambiguous: runtime.main, runtime.main.func2, runtime.main.func1 (and 1 more)
```

五条错误分别对应五种边界：`+2` 落到没有行记录的第 18 行；`+0` 因 `ls.Offset != 0` 不成立、掉进函数名分支；`-2` 被 cobra 当成 flag（要写成 `list -- -2`）；`list main` 少了包名（locspec 的函数名是全名 `main.main`）；`/main/` 命中多个函数，`ListSource` 拒绝在多地址上猜一个，列出前 3 个候选。

行表本身也能直接看：`readelf --debug-dump=decodedline _fixtures/loop` 显示 `main.go` 只有 13–17 行有记录，第 16 行有 `0x4b3971`、`0x4b3977` 两个地址。

切片逻辑的边界由单元测试固化（`pkg/proc/source_test.go`，六种窗口加缺失文件，输出有省略）：

```text
$ go test ./pkg/proc -run TestSourceLines -v
--- PASS: TestSourceLines (0.00s)
    --- PASS: TestSourceLines/mid (0.00s)
    ...
--- PASS: TestSourceLinesMissingFile (0.00s)
PASS
ok  	github.com/hitzhangjie/godbgv2/pkg/proc	0.003s
```

`godbgv2` 没有 `ch9.2.20` 的冒烟脚本（`testdata/script/` 下没有对应文件）：本节的交付物是行表反查与源码切片，端到端行为已由上面的回放覆盖，纯切片逻辑用单测断言更直接。

### 本节小结

`list` 的实现可以概括成五步：解析 locspec；`file:line` 直接反查、`+N/-N` 先用当前 PC 查行再加偏移；`LineToPC` 线性扫描按地址排序的行表，用"行号相等 + 文件后缀"取第一条命中；`PCToLine` 把地址换回文件行；`SourceLines` 按 ±5 行切片并钳制边界；最后 `ListSource` 用 `Current` 告诉前端要不要画 `=>`。

这条链路里最值得记住的是这些映射都不是双射：行号表是地址到行的多对一，反查只能返回地址最低的第一条；`PCToLine` 取"`<= pc` 的最近一行"，断点命中时靠它落回原行；`LineEntry` 只有 `File`/`Line`/`Address`，`is_stmt` 在解析阶段已被过滤，`prologue_end` 被丢弃，所以注释行、空行没有地址，函数断点也不会像 dlv 那样跳过序言。

边界清单（都是命令行上会直接撞到的行为）：`+0` 因 `Offset != 0` 不成立而不可用；`-N` 必须写成 `-- -N`；`file` 参数是后缀匹配，`in.go` 会命中 `main.go`；`/regexp/` 多命中时 `list` 报歧义（`break` 则会为每个地址建断点）；`+N` 用 `currentPC`（当前 OS 线程），无参 `list` 用选择感知的 `Target.Registers()`，选中 goroutine 时两者可能不同源；源码路径不做替换，文件移动即报错。

前向关系：locspec 的解析与地址转换在 [9.2.19](19-how_locspec_works.md)；行号表的解析（`ParseLine`、`is_stmt`、同址去重）在第 8 章 [行号表](../../8-dwarf/5-other/2-lineno-table.md)；地址到手之后的解码与打印在 [6.6 反汇编](../../6-develop-inst-debugger/6-disassemble.md)。本节把"源码位置"与"指令地址"接上，`list` 和后续的 `break` 才有共同的地基。
