## list：源码上下文展示

### 实现目标

`list` 把"当前停在哪一行"翻译成一段可读源码。断点命中后先 `list` 看上下文，比直接读汇编轻松：

```text
godbg> list
Showing /home/.../loop/main.go:16 (PC: 0x4b3972)
     13:	func main() {
     14:		pid := os.Getpid()
     15:		for i := 0; ; i++ {
=>   16:			fmt.Printf("pid: %d, loop: %d\n", pid, i)
     17:			time.Sleep(time.Second)
     18:		}
```

本节完成三件事：无参按当前调试上下文 PC 定位；有参把 locspec 的每种写法接到同一套展示逻辑；把"后端返回数据、前端负责格式"的分工落到契约上；契约分层见 [9.1.3 Service层设计](../1-架构设计/3-Service层设计.md)。

范围要和 [9.2.20 反汇编](20-debug_disassemble.md) 分清：9.2.20 讲行号表本身（`PCToLine`/`LineToPC` 的底层），本节讲命令层——怎么取 PC、怎么把 locspec 变成地址、窗口取多大、输出长什么样。godbgv2 的交互约定对齐 delve：无参按当前 PC、上下各 5 行、`=>` 标注当前行；这条已记入 `godbgv2/docs/CLEANROOM.md` 借鉴清单第 4 条。

### 基础知识

#### 无参：当前调试上下文

"当前 PC"不一定是"当前事件线程的 PC"。godbgv2 用 `Target.Registers()` 统一取寄存器，优先级是：`thread <id>` 选中的线程 > `goroutine <id>` 选中的 goroutine（挂起的 g 用 `g.sched` 合成，运行中的 g 经 `g.m` 找线程读真实寄存器）> 当前事件线程。本节写作时线程/goroutine 选择命令还没实现（9.2.40、9.2.41），实际总落到最后一条；但 `list` 已通过 `Target.Registers()` 接好这层抽象。

#### 有参：locspec 的写法

`list [loc]` 只接受 0 或 1 个参数。参数交给 `locspec.Parse`，支持五种形式：

| 写法 | 含义 | `FindLocation` 的落点 |
|---|---|---|
| `main.main` | 函数名 | `FindFunction`，取函数入口地址 |
| `main.go:16` | 文件:行号 | `LineToPC`，取该行第一条指令地址 |
| `*0x4b3940` | 绝对地址 | 直接使用该地址 |
| `+1` / `-1` | 相对当前行偏移 | 当前 PC → 当前行 → 偏移行 → `LineToPC` |
| `/main\..*/` | 函数名正则 | 遍历 `ListFunctions`，返回全部匹配入口 |

两点注意。第一，[9.2.19 locspec](19-how_locspec_works.md) 提到的 `func:line` 在 godbgv2 没有落地：`locspec.Parse` 只把最后一个冒号前的内容当**文件**，`main.main:16` 会被当成文件 `main.main`，报 `no address`。第二，`+0` 不能重新显示当前行：`Offset` 是 0，`FindLocation` 的 `case ls.Offset != 0` 不成立，最后掉进函数名分支，报 `function "" not found`。

#### 展示窗口与格式

后端固定 `listContextLines = 5`，返回 `line-5` 到 `line+5` 的源码，首尾按文件边界钳制。这个默认值对齐 delve 的 `source-list-line-count`，但 godbgv2 没有把它做成配置项，也没有 `list -5/+5` 参数。

返回的行号不是从 1 开始的数组下标，而是真实行号 `StartLine`。前端打印第 `i` 行时用 `StartLine+i`。箭头只在 `Current=true` 且该行等于 `Line` 时打印；`list main.main`、`list file:16` 这类显式定位返回 `Current=false`，即使定位到的正是当前行也不标箭头。

#### `list` 与 `disass` 的分工

两者都从"当前位置"出发，但看的东西不同：`list` 打开源文件，依赖 DWARF 行号表给出的路径，文件被移动/删掉就读不到；`disass` 读目标进程机器码，无参从当前 PC 开始，参数是地址，不经过源码文件。排查"源码对不上"时通常先 `list` 看行号，再 `disass` 看该行对应的指令。

### 代码实现

整条链路：

```text
godbg> list [loc]
 └─ cmd/debug/list.go:40                         客户端：Client.ListSource(loc)
     └─ pkg/service/api/client.go:150            契约
         └─ pkg/service/debugger/debugger.go:458 门面：定位 PC、取窗口
             ├─ pkg/proc/goroutines.go:300       Target.Registers()（无参时）
             ├─ pkg/proc/location.go:19          FindLocation(loc)（有参时）
             ├─ pkg/proc/funcs.go:178            BinaryInfo.PCToLine(pc)
             └─ pkg/proc/source.go:16            SourceLines(file, line, 5)
```

#### 命令层

`cmd/debug/list.go` 只做参数校验和输出：

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

命令名 `list`，别名 `ls`、`l`，分组 `cmdGroupSource`。`%4d` 就是行号宽度的来源。

#### 契约

`api.Client` 只增加一个方法（`pkg/service/api/client.go:150`），返回值是纯数据（`pkg/service/api/types.go:142`）：

```go
type ListSourceResult struct {
    File      string   // 源码文件
    PC        uint64   // 定位所用地址
    Line      int      // 目标行
    StartLine int      // Lines[0] 对应的行号
    Lines     []string // 源码行（上下各 5 行）
    Current   bool     // Line 是否为当前调试位置
}
```

`ListSource(loc string)` 的 `loc` 为空时按当前调试上下文（选中线程 > 选中 goroutine > 当前事件线程）的 PC 定位并标注当前行，否则按 locspec 解析。`Lines` 不带行号，行号由 `StartLine` 推导；`Current` 只表示"这是当前行"。

#### 门面：定位 PC

`Debugger.ListSource`（`debugger.go:458`）先定 PC，再换行号，再取窗口（省略错误处理）：

```go
if loc == "" {
    regs, err := d.t.Registers()
    pc, current = regs.PC(), true
} else {
    addrs, err := d.t.FindLocation(loc)
    if len(addrs) > 1 {
        return nil, fmt.Errorf("location %q is ambiguous: %s", loc, msg)
    }
    pc = addrs[0]
}

file, line, err := d.t.BinaryInfo().PCToLine(pc)
if file == "" {
    return nil, fmt.Errorf("no source file for pc %#x", pc)
}
if line < 1 {
    line, current = 1, false
}
start, lines, err := d.t.SourceLines(file, line, listContextLines)
```

三个容易忽略的点：多匹配直接报错（只列前 3 个函数名），不替用户选第一个；`PCToLine` 成功但 `file` 为空时报 `no source file`；`line < 1` 兜底成"从文件首行展示、不标箭头"，但空文件会先被上一条拦住，实际很少走到。

#### `FindLocation`：五种 locspec

`pkg/proc/location.go:19` 按字段判断，把 locspec 变成地址列表（省略错误处理）：

```go
switch {
case ls.Addr != 0 || (len(ls.Raw) > 0 && ls.Raw[0] == '*'):
    return []uint64{ls.Addr}, nil
case ls.Pattern != "":
    // 正则匹配 ListFunctions，返回全部入口
case ls.File != "":
    addr, _ := t.LineToPC(ls.File, ls.Line)
    return []uint64{addr}, nil
case ls.Offset != 0:
    pc, _ := t.currentPC()
    file, line, _ := t.bi.PCToLine(pc)
    addr, _ := t.LineToPC(file, line+ls.Offset)
    return []uint64{addr}, nil
default:
    fn, err := t.FindFunction(ls.FuncName)
    return []uint64{fn.Entry}, nil
}
```

`+0` 落进 `default` 就是前面的 `function "" not found`；负偏移还会先被 cobra 当成 flag，必须写 `list -- -1`，否则报 `unknown shorthand flag: '1' in -1`。相对偏移分支用的是 `currentPC()`（当前线程），不走 `Target.Registers()`，所以选中 goroutine 后 `list +1` 仍按事件线程算——这是实现里尚未统一的小口子。

#### `SourceLines`：切窗口

`pkg/proc/source.go:16` 只做文本切片：按换行符切成行、丢掉末尾换行产生的空行，再取 `line±context` 的子串；`start` 钳到 1、`end` 钳到文件末尾，`start` 超过文件行数时返回空结果。

`context` 传 5，窗口长度随文件头尾变化：断在第 1 行时只有后 5 行，断在末尾时只有前 5 行。目标行远超文件末尾时返回空结果，前端只打印 `Showing ...` 一行。

### 执行测试

断在 `_fixtures/loop` 的循环体（`main.go:16`），看无参和两种有参定位（路径前缀已缩短，输出为节选）：

```text
godbg> list
Showing /home/.../loop/main.go:16 (PC: 0x4b3972)
     13:	func main() {
     14:		pid := os.Getpid()
     15:		for i := 0; ; i++ {
=>   16:			fmt.Printf("pid: %d, loop: %d\n", pid, i)
     17:			time.Sleep(time.Second)
     18:		}
godbg> list main.main
Showing /home/.../loop/main.go:13 (PC: 0x4b3940)
     13:	func main() {
godbg> list +1
Showing /home/.../loop/main.go:17 (PC: 0x4b3a47)
     15:		for i := 0; ; i++ {
     16:			fmt.Printf("pid: %d, loop: %d\n", pid, i)
     17:			time.Sleep(time.Second)
     18:		}
```

无参的 `Current=true`，第 16 行有 `=>`；`list main.main` 定位到函数入口（声明行 13），没有箭头；`list +1` 从当前行 16 到 17，也没有箭头。几个失败分支：

```text
godbg> list +0
Error: function "" not found
godbg> list -1
Error: unknown shorthand flag: '1' in -1
godbg> list examples/debuggee/loop/main.go:18
Error: no address for /home/.../loop/main.go:18
godbg> list /main.*/
Error: location "/main.*/" is ambiguous: runtime.main, runtime.main.func2, runtime.main.func1 (and 1 more)
godbg> list *0x1
Error: no source file for pc 0x1
```

第 18 行是 `}`，行号表里没有对应指令，所以 `LineToPC` 找不到地址——"文件里存在这一行"和"这一行有指令"是两回事。正则例子同时匹配到 `runtime.main` 和 `main.main`，`list` 不会替用户挑。其中无参和两种有参定位由 `testdata/script/ch9.2.35.txt` 固化：脚本断在 `main.main` 后依次执行 `list`、`list main.main`、`list examples/debuggee/loop/main.go:15`，并断言有/无 `=>`。

### 本节小结

`list` 可以概括成四步：确定 PC（无参用 `Target.Registers()`，有参用 `FindLocation`）→ `PCToLine` 得到文件与行号 → `SourceLines` 按 ±5 切窗口 → 契约返回 `File/PC/Line/StartLine/Lines/Current`，客户端加箭头和行号宽度。

边界与已知取舍：窗口固定为 5 行，没有 delve 的配置项和分页；locspec 正则多匹配直接报 ambiguous，需要用户写得更精确；`+0` 不可用，负偏移要加 `--`，`+N` 暂不跟随选中的 goroutine；源码路径直接来自行号表，文件移动或跨机调试时 `os.ReadFile` 会失败（9.3.105 的 substitute-path 问题）；无行号信息时兜底从文件首行展示、不标箭头，PC 连文件都查不到时报 `no source file`。
