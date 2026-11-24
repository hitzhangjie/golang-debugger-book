## 支持表达式计算

### 实现目标：理解并实现表达式求值器

调试会话里最常用的操作之一，就是让调试器算点什么：

```bash
godbg> print a+b
a+b = 300 (int)
godbg> break main.go:10 if a > 25
breakpoint 1 added at 0x4bcbdc (...), cond "a > 25"
```

`print` 要算出一个值并打印，`break ... if` 与 `condition` 要算出一个布尔值决定是否停下。它们背后是同一个组件——表达式求值器。本节把它拆开讲清楚：

1. 表达式字符串如何被切成 token、解析成 AST；
2. AST 如何递归求值，标识符如何变成变量、内存如何被读取；
3. 结果如何从后端回到前端；
4. 当前实现的能力边界与作用域简化。

求值器实现在 `pkg/proc/eval.go`，前端入口是 `cmd/debug/print.go`，条件求值入口在 `cmd/debug/continue.go`。后端的求值入口是 `proc.Eval(expr, lookup, mem)`；`whatis`（`ptypes`）目前仍是桩，求值请用 `print`。

### 基础知识

#### 中缀表达式与栈求值

学《数据结构与算法》时做过“中缀转后缀”：`a+b*c` 的中缀写法要靠优先级和括号确定顺序；转成后缀 `a b c * +` 后，顺序完全由位置决定，用一个操作数栈从左到右算即可——遇操作数入栈，遇运算符弹出两个操作数、算完再入栈，栈顶就是结果。

`a+b` 就是“入栈 a、入栈 b、执行加法”。表达式求值的本质是“确定运算顺序，再按顺序取操作数算结果”；区别只在于顺序是编译成一串指令，还是由树的形状直接表达。

#### 词法、语法、语义

编译原理的三个阶段在这里一一对应：

- **词法分析**：字符流 → token（标识符、整数、运算符、括号、点）；
- **语法分析**：token 序列 → AST，同时处理优先级与结合性；
- **语义分析与求值**：遍历 AST，确定每个节点的类型与值。

错误也按这三层体现：`a+` 是语法错误（缺右操作数），`foo(1)` 语法合法但语义不支持（能力边界），`x` 在 DWARF 里找不到定义是语义错误。

#### 操作数从哪来

求值绕不开：表达式里的 `a` 到底是哪个 `a`？

```go
func main() {
	var a string = "helloworld"
	{
		var a int = 200
		_ = a
	}
}
```

同名变量在嵌套作用域里可以有多份定义，类型甚至不同。DWARF 用 DIE 描述：`DW_TAG_variable` 给出名字、类型（`DW_AT_type`）和位置（`DW_AT_location`）；`DW_TAG_lexical_block` 用 `[DW_AT_low_pc, DW_AT_high_pc]` 圈定地址范围。严格做法是用当前 PC 判断落在哪个 block，从最内层往外找，第一个命中的才是正确定义。

godbg 当前没有做这一层过滤，取的是函数子树里第一个同名 DIE。后果见后文“作用域与 shadowing”，这里先记住结论：**这是明确简化，不是已支持能力**。

#### AST Explorer

对 AST 没有直观感受的话，可以用 [AST Explorer](https://astexplorer.net/) 写几个 Go 表达式看右侧的树。`a + b*c` 会解析成“加法节点，左操作数 `Ident(a)`，右操作数 `BinaryExpr(*)`”，乘法节点下再挂 `Ident(b)`、`Ident(c)`。godbg 不用 Go 标准库的 AST，而是自建节点，但树形与此一致——理解这棵树，就理解了后面的递归代码。

#### 三种实现路线

表达式求值在 delve 里演进过两版，godbgv2 是第三种：

- **2015 年第一版（递归）**：解析成 AST 后用一个大 `switch` 递归求值。直观，但分支多、维护成本高。
- **2023 年第二版（栈机器）**：把 AST 编译成一串操作指令，用操作数栈顺序执行。求值过程线性、易扩展，代价是多一层编译和一套指令定义。
- **godbgv2（第三种：手写 Pratt + 解释执行）**：自己写 tokenizer 与 Pratt 解析器，产出只有 9 种节点的自建 AST，再递归解释。没有编译阶段、没有操作数栈，也没有把寄存器/内存/帧信息封进一个大上下文对象——需要什么由调用方通过两个回调注入。

delve 的教学裁剪版（tinydbg）属于前两版的复刻，godbgv2 是净室重写，三者代码没有派生关系；后面看到的函数名不能往 delve 上套。

### 代码实现

#### 能力边界

godbg 的求值器是“教学子集”。下表按当前代码逐条核对，✅ 项本机实跑验证，❌ 项给出实测错误：

| 能力 | 支持 | 说明 |
|---|---|---|
| 十进制整数字面量 | ✅ | 只识别 `0-9` 连续串；`0x10`、`1.5`、`true`、字符串都不是字面量 |
| 标识符 | ✅ | 经 `EvalLookup` 回调解析为值与类型 |
| 字段选择 `x.f` | ✅ | 按 `StructType.Fields[].ByteOffset` 定位 |
| 下标 `x[i]` | ✅ | 数组、切片、字符串，带边界检查 |
| 解引用 `*p` | ✅ | 要求操作数类型是 `*dwarf.PointerType` |
| 取地址 `&x` | ✅ | 要求可寻址（`Value.Addr != 0`） |
| 算术 `+ - * / %`、括号、一元负号 | ✅ | 除零报错；`/`、`%` 为整数运算；负号按 `^x+1` |
| 比较 `== != < <= > >=` | ✅ | 结果为 `bool` |
| 逻辑与、或、非 | ✅ | 结果为 `bool`；与/或不短路，两边都求值 |
| `len` / `cap` | ✅ | 数组、切片、字符串；数组的 `cap` 明确报错 |
| 函数调用 | ❌ | 除 `len`/`cap` 外一律报 `function calls not supported` |
| 类型转换 `int(x)` | ❌ | 被当函数调用拒绝，实测同一错误 |
| 切片表达式 `s[lo:hi]` | ❌ | 解析阶段报 `missing ]`，`:` 不是合法运算符 |
| map / channel 操作 | ❌ | 类型模型只有基础类型、指针、结构体、数组 |
| 复合字面量、方法调用、接口断言 | ❌ | 解析器没有对应节点 |
| `complex` / `imag` / `real` | ❌ | 无复数类型，函数调用本身也不支持 |
| 位运算（按位与/或/异或/移位） | ❌ | 优先级表里没有这些二元运算符 |
| 赋值、逗号表达式 | ❌ | 求值器只读；赋值由单独的 `set` 命令实现 |

> `pkg/proc/eval.go` 顶部注释和 `docs/FEATURE-MATRIX.md` §4 都把“类型转换”写成支持能力，但实现中 `int(x)` 会走函数调用分支被拒。本节以代码与实跑为准，把类型转换归入不支持。

#### 整体结构：tokenizer → AST → 解释执行

与“解析 → 编译 → 栈机器”的两段式不同，godbg 是三段式：

```text
expr string
   │
   ▼
parser.next()       词法（eval.go:86）
   │
   ▼
parseExpr(minPrec)  语法：前缀递归下降 + 中缀优先级爬升（eval.go:187）
   │
   ▼
astNode             自建节点（eval.go:142）
   │
   ▼
evalNode(ast)       语义：递归解释（eval.go:299）
   │
   ▼
proc.Value{Uint, Type, Addr}
```

四层职责分明：词法只切分，语法只组装，`evalNode` 只按节点类型求值，符号解析与内存读取完全在回调里。因此求值器不依赖 ptrace、寄存器或 DWARF 树遍历，单元测试里用假内存和假 lookup 就能跑。

#### step1：手写词法分析

`parser.next()` 每次从剩余字符串头部取一个 token：先跳过空白，再按首字符分派——数字读连续数字串，字母/下划线读标识符，括号、点、方括号各成一个 token，其余走“操作符最长匹配”：

```go
func (p *parser) next() {
	p.src = strings.TrimSpace(p.src)
	c := p.src[0]
	switch {
	case c >= '0' && c <= '9':
		// 读连续数字串 → tokInt
	case c == '(':
		p.tok = token{tokLParen, "("}
	// ')' '[' ']' '.' 同理
	default:
		// 操作符最长匹配，双字符优先
		ops := []string{"==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "&", "!"}
		// ...
	}
}
```

（节选，完整实现见 `pkg/proc/eval.go:86-138`）

双字符运算符排在单字符前面，所以 `<=` 不会被切成 `<` 和 `=`；数字分支只吃 `0-9`，负数由一元负号处理，十六进制、浮点、字符/字符串都不在词法范围内。

#### step2：Pratt 解析与自建 AST

AST 只有 9 种节点，全是小结构体：

```go
type astNode interface{}

type identNode struct{ name string }
type intNode struct{ v uint64 }
type unaryNode struct{ op string; oper astNode }
type binaryNode struct{ op string; lhs, rhs astNode }
type derefNode struct{ oper astNode } // *
type addrNode struct{ oper astNode }  // &
type indexNode struct{ arr, idx astNode }
type fieldNode struct{ obj astNode; field string }
type callNode struct{ name string; args []astNode }
```

（字段展开写法见 `pkg/proc/eval.go:142-164`，此处为排版紧凑合并了一行）

解析采用 Pratt 风格（优先级爬升）：`parseExpr(minPrec)` 先解析前缀/原子，再循环处理中缀运算符，遇到优先级低于 `minPrec` 的就返回。优先级表就是全部规则：

```go
var precedence = map[string]int{
	"||": 1, "&&": 2,
	"==": 3, "!=": 3, "<": 3, "<=": 3, ">": 3, ">=": 3,
	"+": 4, "-": 4,
	"*": 5, "/": 5, "%": 5,
}
```

（`pkg/proc/eval.go:180-185`）

中缀循环是标准的左结合写法：取出运算符，查表得 `prec`，若 `prec < minPrec` 退出；否则消费运算符，用 `parseExpr(prec+1)` 解析右操作数，组装 `binaryNode`。一元运算符不在表里——`-`、`!`、`&` 在 `tokOp` 分支直接递归 `parseExpr(6)`（6 高于所有二元），`*` 单独走 `derefNode`。原子之后、中缀之前还有一个后缀循环处理 `.` 与 `[`：`a.b` 得 `fieldNode`，`a[i]` 得 `indexNode`，方括号里递归 `parseExpr(0)`，所以 `arr[i+1]` 也合法。

三个容易踩的细节：

1. **后缀比一元更紧**：一元分支用 `parseExpr(6)` 解析操作数，而后缀在 `parseExpr` 内部先处理。所以 `*p.X` 是 `*(p.X)`，解引用后再取字段必须写 `(*p).X`——单元测试正是这么写的。
2. **`[` 里只认一个表达式**：`s[0:1]` 在 `parseExpr(0)` 里读到 `:`（切成 `tokOp`），优先级表没有它，返回后期待 `]` 却看到 `:`，于是报 `missing ]`。切片表达式不是“求值不支持”，而是根本没进文法。
3. **标识符后跟 `(` 一律当函数调用**：`int(x)` 因此变成 `callNode{name:"int"}`，到求值阶段才被拒绝。没有类型转换节点，也就没有实现。

#### step3：求值上下文：两个回调 + 一个结果类型

godbg 没有把“当前 PC、寄存器、内存、帧基址”打包成上下文对象。`Eval` 只接收三个参数：表达式、一个“名字 → 值”的回调、一个“地址/长度 → 字节”的回调。

```go
type Value struct {
	Uint uint64
	Type dwarf.Type
	Addr uint64
}

type MemReader func(addr uint64, size int64) ([]byte, error)
type EvalLookup func(name string) (*Value, error)

func Eval(expr string, lookup EvalLookup, mem MemReader) (*Value, error) {
	p := &parser{src: expr, lookup: lookup}
	ast, err := p.parse()
	if err != nil {
		return nil, err
	}
	return evalNode(ast, lookup, mem)
}
```

（节选，注释与完整定义见 `pkg/proc/eval.go:24-56`）

这三个类型把求值器与调试器解耦了：求值器不知道变量在栈上还是寄存器里，也不知道 DWARF 树长什么样——`lookup` 返回 `Uint`/`Type`/`Addr` 就够；也不关心内存是 `process_vm_readv` 还是 `PTRACE_PEEKDATA`——`mem` 只承诺“读 addr 开始的 size 字节”。结果统一是 `Value`，后续渲染再按 `Type` 与 `Addr` 决定怎么取值。

布尔类型在 DWARF 里没有独立 DIE，按约定用 `DW_ATE_boolean` 编码的基础类型表示，godbg 为此定义了包级 `boolType`（`eval.go:43`）。比较与逻辑运算的结果都挂在它上面——这也是 `EvalCondition` 判断“是不是布尔表达式”的依据。

#### step4：evalNode 递归解释

`evalNode` 是按节点类型分派的 `switch`，每个分支递归求子节点，再按语义组合：

```go
func evalNode(n astNode, lookup EvalLookup, mem MemReader) (*Value, error) {
	switch node := n.(type) {
	case intNode:
		return &Value{Uint: node.v}, nil
	case identNode:
		if lookup == nil {
			return nil, fmt.Errorf("identifier %q: no lookup provided", node.name)
		}
		return lookup(node.name)
	}
}
```

（节选，完整实现见 `pkg/proc/eval.go:299-399`）

各分支语义：

| 节点 | 求值方式 |
|---|---|
| `intNode` | 构造 `Value{Uint: v}`，无类型（类型由参与运算的变量决定） |
| `identNode` | 调 `lookup(name)`；未注入时报错，变量不存在由回调用 `variable "x": …` 包装 |
| `unaryNode` `-` | `^x + 1`（二补码取负），保留操作数类型 |
| `unaryNode` `!` | `Uint == 0` 得 1，否则 0，类型 `bool` |
| `unaryNode` `&` | 要求 `Addr != 0`，返回 `Addr` 并构造 `*T` |
| `derefNode` | 操作数必须是 `*T`，读 `oper.Uint` 处的 `T` 值 |
| `fieldNode` | 操作数必须是结构体，按字段 `ByteOffset` 读 `obj.Addr+offset` |
| `indexNode` | 数组按元素大小算地址；切片/字符串先读头再算；带边界检查 |
| `callNode` | 只接受 `len`/`cap`，其余报能力边界错误 |
| `binaryNode` | 递归左右，交给 `evalBinary` 按运算符计算 |

解引用与字段读取都落到 `readMemoryValue(addr, typ, mem)`：基本类型和指针把内存字节拼成 `Uint`；复合类型不立即读，只记 `Addr`，等渲染时再按类型读（`eval.go:405-421`）。这解释了为什么 `print pt` 能打印整个结构体，而 `print pt.X` 只打印一个整数。

下标由 `evalIndex` 处理（`eval.go:426-490`）：数组用 `arr.Addr + idx*elem.Size()` 并检查 `Count`；切片先读头部偏移 0 的 `array` 指针、偏移 8 的 `len`，再按元素大小定位；字符串读偏移 0 的指针和偏移 8 的长度，返回一个 `uint8`。`len`/`cap` 由 `evalLenCap` 处理（`eval.go:494-530`）：数组取 `Count`（`cap` 报错），切片按头部偏移 8/16 读 `len`/`cap`，字符串只读偏移 8 的 `len`（`cap` 报错）。注意这里用固定偏移而不是 DWARF 字段偏移——对 Go 运行时成立，但把“只支持 Go 的切片/字符串布局”写死进了实现。

二元运算由 `evalBinary` 完成（`eval.go:549-610`）：两个操作数都按 `uint64` 取出，算术结果沿用左操作数类型，比较/逻辑结果固定是 `bool`，除零与未知运算符报错。它没有任何类型检查与类型提升，带符号语义（负数大小比较、窄整型溢出）并未建模——这是又一处教学简化。

#### step5：结果如何变成前端可读的变量

`print` 最终落到 `Target.EvalExpression`（`pkg/proc/variables.go:400-422`）：

```go
func (t *Target) EvalExpression(expr string) (*Variable, error) {
	v, err := Eval(expr, t.variableLookup, t.readTargetMemorySize)
	if err != nil {
		return nil, err
	}
	out := &Variable{Name: expr, Type: v.Type, Addr: v.Addr}
	switch v.Type.(type) {
	case *godbgdwarf.BasicType, *godbgdwarf.PointerType:
		out.Value = v.Uint
		return out, nil
	}
	if v.Addr == 0 {
		return nil, fmt.Errorf("expression %q is not addressable", expr)
	}
	// 复合类型：按地址与类型读取渲染
	if err := t.fillVariableValue(out, v.Addr, v.Type); err != nil {
		return nil, err
	}
	return out, nil
}
```

（节选）

这一步把 `proc.Value` 转成 `proc.Variable`：基本类型和指针直接拿 `Uint`；复合类型必须可寻址，再按地址与类型渲染成字符串。`t.variableLookup` 是 `EvalLookup` 的实现（`eval.go:631-637`），复用变量定位链路拿到值与类型；`t.readTargetMemorySize` 是 `MemReader` 的实现（`variables.go:213-223`），内部是一次 `ReadMemory`。

再往上，`debugger.PrintVariable` 把结果压成协议对象（`debugger.go:414-428`）：

```go
return &api.Variable{
	Name:  v.Name,
	Addr:  v.Addr,
	Type:  v.Type.String(),
	Value: v.String(),
}, nil
```

`api.Variable` 只有 `Name/Addr/Type/Value` 四个字段（`pkg/service/api/types.go:105-109`），都是前端能直接显示的内容。前端 `cmd/debug/print.go` 拿到后只做一件事：

```go
v, err := Client.PrintVariable(args[0])
if err != nil {
	return err
}
fmt.Printf("%s = %s (%s)\n", v.Name, v.Value, v.Type)
```

（节选，`cmd/debug/print.go:28-39`）

注意 `print` 要求 `len(args) == 1`，所以表达式里不能有空格：写 `print a+b`，不要写 `print a + b`（后者被当成三个参数）。`print a<b` 可以，`print a < b` 会报用法错误；带空格的比较适合写在 `break ... if` 或 `condition` 里，那两条命令会把剩余参数重新拼成表达式。

#### print 与 condition 的两条调用链

`print` 是“求值并显示”，`condition` 是“求值并判定”，两者在前端就分开了：

```text
print <expr>
  cmd/debug/print.go → api.Client.PrintVariable
    → rpc2.(*Client).PrintVariable             rpc2/client.go:190
    → serverImpl.PrintVariable                 rpc2/server.go:494
    → debugger.PrintVariable                   debugger.go:414
    → proc.(*Target).EvalExpression            variables.go:400
    → proc.Eval(expr, lookup, mem)             eval.go:49
```

条件断点分两步。设置时，`break ... if` 或 `condition <id> <expr>` 只把条件字符串存进断点（`proc.Breakpoint.Cond`，`breakpoints.go:55`；`SetBreakpointCondition` 见 `breakpoints.go:216-224`），后端并不解释它。命中之后由前端决定是否继续：`checkAutoResume`（`cmd/debug/continue.go:116-147`）调用 `Client.EvalCondition(bp.Cond)`，条件为假就打印 `not satisfied, auto continue` 并越过断点，为真才停留。

`EvalCondition` 走另一条 RPC，最终到达 `Target.EvalCondition`（`eval.go:616-626`）：

```go
func (t *Target) EvalCondition(expr string) (bool, error) {
	v, err := Eval(expr, t.conditionLookup, t.readTargetMemorySize)
	if err != nil {
		return false, err
	}
	bt, ok := v.Type.(*dwarf.BasicType)
	if !ok || bt.Encoding != dwarf.DW_ATE_boolean {
		return false, fmt.Errorf("condition %q is not a boolean expression", expr)
	}
	return v.Uint != 0, nil
}
```

两条链的区别不只是入口：`conditionLookup` 比 `variableLookup` 更严格，要求标识符本身是基础类型（`eval.go:644-653`）。所以 `print pt.X==1` 能用（走 `variableLookup`，结构体字段可读），`break ... if pt.X == 1` 却会报 `variable "pt" has composite type main.Point, not supported in condition`。条件表达式只能用整型/布尔变量与常量做比较——这是刻意的保守设计，不是 bug。

#### 作用域与 shadowing：当前实现的简化

回到基础知识里的问题：表达式里的 `a` 到底是哪个 `a`？

标识符解析的最后一跳是 `EvalVariableAddr`（`pkg/proc/variables.go:69-98`）：先用当前 PC 经 `t.bi.FuncForPC(pc)` 找到当前函数，再调 `reader.FindVariable(fn.Name, name)` 在函数里按名字找变量；`FindVariable`（`pkg/dwarf/reader.go:70-92`）定位到 `DW_TAG_subprogram` 后，对整棵子树做一次先序遍历，返回第一个名字匹配的 `DW_TAG_variable`：

```go
	reader.Seek(fn.Offset)
	var found *stddwarf.Entry
	if err := walkEntry(reader, false, func(e *stddwarf.Entry) bool {
		if e.Tag == stddwarf.TagVariable && e.Val(stddwarf.AttrName) == varName {
			found = e
			return true
		}
		return false
	}); err != nil {
		return nil, err
	}
	return found, nil
}
```

（节选）

整段逻辑里没有 PC 参与：不判断 DIE 属于哪个 `lexical_block`，不比较 `[low_pc, high_pc]` 是否包含当前 PC，也没有“内层优先、外层被 shadow”的排序。后果很直接：**只要外层先被遍历到，内层同名变量就会被忽略**。

本机实测。调试对象：

```go
1  package main
2
3  import "fmt"
4
5  func main() {
6      var a int = 100
7      var b int = 200
8      {
9          a := 300
10         _ = a
11     }
12     fmt.Println(a + b)
13 }
```

在 `main.go:9` 停下（内层 `a` 已进入作用域，按源码语义 `a` 应为 300）：

```text
godbg> break main.go:9
breakpoint 1 added at 0x4bcbc4 (/tmp/evaldemo/main.go:9)
godbg> continue
thread 1937542 status: stopped: trace/breakpoint trap
> /tmp/evaldemo/main.go:9 (pc: 0x4bcbc5)
godbg> print a
a = 100 (int)
godbg> print a+b
a+b = 300 (int)
```

`a` 取到外层定义（100），`a+b` 因此是 300 而不是 500。同一程序在 `main.go:12`（内层 block 已结束）求值才是对的（`a+b = 300 (int)`），这也是简单演示往往“看起来没问题”的原因——只有同名变量在嵌套作用域同时存在时，缺口才暴露。

> **当前实现的简化**：godbg 尚未按 PC 过滤 `lexical_block`，`FindVariable` 取的是 subprogram 子树里第一个同名 DIE。因此：
>
> - 内层同名变量可能取到外层定义（如上例）；
> - 若 DIE 顺序是内层在前，外层作用域也可能取到内层定义；
> - 变量可能“提前可见”或“失效后仍可见”，读到栈上残留值，结果不可预测。
>
> 正确做法：以当前 PC 为输入，筛选 `ContainsPC(pc)` 的 subprogram/lexical_block，收集同名定义，按嵌套深度与声明位置排序，取最内层那个，并把外层标记为 shadowed。delve 的 `variablesInternal` 就是这么做的。这条链路补齐前，本书不把 shadowing 当作已支持能力。

还有两个同源简化：`&x` 用 `Addr == 0` 判断“不可寻址”，而地址 0 本身合法，二者不可区分；`len`/`cap` 按“结构体名以 `[]` 开头或等于 `string`”猜布局，对普通结构体调 `len` 会按偏移 8 读出一个字段值（实测 `len(pt)` 得到 2，即 `pt.Y`），不会报错。

#### 以 `a+b` 走一遍

仍以上面的程序为例，在 `main.go:12` 停下后执行 `print a+b`，实测输出就是 `a+b = 300 (int)`。一次求值的完整路径：

1. **前端**：`printCmd.RunE` 收到 `"a+b"`，调 `Client.PrintVariable("a+b")`，经 net/rpc（gob）到后端。
2. **入口**：`Debugger.PrintVariable` → `Target.EvalExpression`，用 `t.variableLookup` 与 `t.readTargetMemorySize` 调 `proc.Eval`。
3. **词法 + 语法**：`next()` 产出 `tokIdent("a")`、`tokOp("+")`、`tokIdent("b")`、`tokEOF`；`parseExpr(0)` 解析 `a`，中缀循环看到 `+`（优先级 4 ≥ 0），递归 `parseExpr(5)` 解析 `b`，组装 `binaryNode{"+", a, b}`。
4. **求值 + 渲染**：`evalNode` 命中 `binaryNode`，递归求左：`identNode` 调 `lookup("a")`，经 `FuncForPC`、`FindVariable` 找到 DIE，位置表达式算出地址并读 8 字节得 100；右操作数同理得 200；`evalBinary("+", 100, 200)` 返回 `Value{Uint:300, Type:int}`。`EvalExpression` 把 `Uint` 填进 `Variable`，`Debugger.PrintVariable` 转成 `api.Variable{Name:"a+b", Type:"int", Value:"300"}`，前端 `fmt.Printf` 输出。

第 4 步的“位置表达式求值”不在本节范围内——那是变量定位链路（9.2.33 小节）的内容；本节只关心求值器如何调用 `lookup`，以及拿到 `Value` 之后怎么算。

#### 如果你想细致掌握

想把每个分支跟一遍，最有效的方法仍是“用调试器调试调试器”：用 dlv 跟踪 godbg 自身（示意，本节未在本机实跑），在 `proc.Eval`、`proc.(*parser).parseExpr`、`proc.evalNode`、`proc.evalBinary` 上下断点，然后在 godbg 会话里执行 `print a+b`，单步进入。另有一个更轻量的办法：用 `--init` 批量回放脚本（本节的实测输出都是这么得到的），每条命令的输出都会打印，适合对照验证，也适合写进回归脚本。

### 执行测试

**单元测试**。求值器不依赖真实进程，`pkg/proc/eval_test.go` 用假 `lookup` 与假内存覆盖主要分支。本机实跑：

```text
$ go test ./pkg/proc -run "TestEval" -v
--- PASS: TestEvalArith (0.00s)
--- PASS: TestEvalIdent (0.00s)
--- PASS: TestEvalCompare (0.00s)
--- PASS: TestEvalUnsupported (0.00s)
--- PASS: TestEvalCondition (0.00s)
--- PASS: TestEvalMemoryExpr (0.00s)
PASS
ok  	github.com/hitzhangjie/godbgv2/pkg/proc	0.001s
```

几个用例值得对照代码看：`TestEvalArith` 覆盖优先级、括号与一元负号（`1+2*3=7`、`-1+3=2`）；`TestEvalIdent` 验证 `lookup` 注入（`i+j=42`）；`TestEvalCompare` 验证比较/逻辑结果类型（`1<2`、`1==1 && 2==2`、`!0`）；`TestEvalUnsupported` 守住能力边界（`foo(1)` 必须报错）；`TestEvalCondition` 验证条件入口校验（`1+1` 报“不是布尔表达式”）；`TestEvalMemoryExpr` 用 `map[uint64]byte` 模拟内存，覆盖 `pt.X`、`(*p).X`、`sl[1]`、`len(sl)`、`cap(sl)` 与越界报错。

**实跑 `print`**。在 `godbgv2/_fixtures/vars` 上断到 `main.go:28` 后依次执行（实测）：

```text
godbg> print arr[1]+arr[2]
arr[1]+arr[2] = 50 (int)
godbg> print pt.X+pt.Y
pt.X+pt.Y = 3 (int)
godbg> print *ptr
*ptr = 10 (int)
godbg> print &pt.X
&pt.X = 0x566420 (*int)
godbg> print len(arr)
len(arr) = 3 (int)
godbg> print pt.X==1
pt.X==1 = true (bool)
```

**实跑 `condition`**。裁剪后的输出（略去重复的 `not satisfied` 行）：

```text
godbg> break main.go:9 if a > 25
breakpoint 1 added at 0x4bcbdc (/tmp/evaldemo/cond/main.go:9), cond "a > 25"
godbg> continue
breakpoint 1 condition "a > 25" not satisfied, auto continue
...（前几次命中条件不满足，自动越过，略）
thread 1938869 status: stopped: trace/breakpoint trap
> /tmp/evaldemo/cond/main.go:9 (pc: 0x4bcbdd)
godbg> print a
a = 30 (int)
```

**边界实测**。以下输入都应报错，可用于确认自己理解的能力边界：

```text
godbg> print int(arr[0])
Error: function calls not supported (教学版能力边界)
godbg> print s[0:1]
Error: missing ]
godbg> break main.go:28 if pt.X == 1
Error: breakpoint 1 condition "pt.X == 1" eval error:
       variable "pt" has composite type main.Point, not supported in condition (教学版能力边界)
```

### 本节小结

本节介绍了 godbg 的表达式求值器：

- 结构是“手写 tokenizer → Pratt 解析器 → 自建 AST → 递归解释”，没有编译阶段与操作数栈；
- 上下文只有两个注入回调：`EvalLookup` 负责“名字 → 值/类型/地址”，`MemReader` 负责“地址 → 字节”，求值器本身不碰寄存器、ptrace 与 DWARF 树；
- 结果是 `proc.Value{Uint, Type, Addr}`，基本类型直接取值、复合类型按地址渲染，最终压成 `api.Variable` 回前端；
- 能力边界明确：支持标识符、字段、下标、解引用、取址、算术、比较、逻辑、`len`/`cap`；不支持函数调用（`len`/`cap` 除外）、类型转换、切片表达式、map/channel、方法调用、接口断言、`complex`/`imag`/`real`；
- 作用域处理是当前最大的简化：`FindVariable` 取函数子树里第一个同名 DIE，不看 PC 与 `lexical_block`，嵌套作用域下可能取错变量。

后续小节会补齐求值器的两端：变量定位链路（9.2.33）让 `lookup` 真正从 DWARF 与栈帧里算出地址，内存表达式与 `set`（9.2.36/9.2.37）把可寻址对象写回；条件断点的完整流程在 9.2.23 展开。

### 参考文献

1. 后缀表达式, https://en.wikipedia.org/wiki/Reverse_Polish_notation
2. Go 语言规范·运算符优先级, https://go.dev/ref/spec#Operator_precedence
3. AST Explorer, https://astexplorer.net/
4. dwarfviewer, https://github.com/hitzhangjie/dwarfviewer
