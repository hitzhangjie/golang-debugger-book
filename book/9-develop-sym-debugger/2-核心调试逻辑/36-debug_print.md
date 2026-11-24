## print（二）：表达式求值

### 实现目标

[9.2.33 print（一）](33-debug_vars.md) 讲的是 `print i` 这类**裸标识符**怎样走完"变量 DIE → 位置表达式 → 内存 → 类型"的定位链路。本节往前一步：`print` 的参数不再只是一个名字，而是一个表达式。

```text
godbg> print arr[1]+arr[2]
arr[1]+arr[2] = 50 (int)
godbg> print pt.X+pt.Y
pt.X+pt.Y = 3 (int)
```

[9.2.18 表达式计算](18-how_evalexpr_works.md) 已经讲过词法分析和 Pratt 解析，本节不重复 tokenizer，只回答四个问题：

1. `print` 命令怎样把表达式交给求值器，结果又怎样变成一行输出；
2. 求值器的教学子集支持哪些写法，哪些写法会明确报错；
3. 字段、下标、解引用这些复合类型怎样按地址读值；
4. `Value.Addr` 为什么是 [9.2.37 set](37-debug_set.md) 的地基。

### 基础知识

#### `print` 的输入与输出

`print` 只收一个参数，别名 `p`，声明是 `print <name>`，但这个 `name` 实际是表达式字符串：

```go
v, err := Client.PrintVariable(args[0])
...
fmt.Printf("%s = %s (%s)\n", v.Name, v.Value, v.Type)
```

输出分三段：左边是用户输入的原文（`v.Name` 由后端原样带回），中间是渲染后的值，括号里是类型名。`arr[1]` 和 `arr` 走同一个命令，区别只在参数能不能被求值器解析。

#### 支持哪些表达式

`pkg/proc/eval.go:11-18` 的注释列了设计意图：标识符、字段、下标、解引用、取地址、算术、比较、逻辑、类型转换、`len`/`cap`；**明确不支持**函数调用、复合字面量、map/channel 操作、方法调用。注释和实现有两处偏差：类型转换没有求值分支（`int(` 被当成函数调用），取地址在 ch9.2.36 快照上也还没接上（9.2.37 补，当前 master 已可用）。按代码实际行为：

| 类别 | 写法 | 9.2.36 的行为 |
|---|---|---|
| 标识符 | `arr`、`pt`、`ptr` | 走 9.2.33 的变量定位链路 |
| 字段选择 | `pt.X`、`pt.Y` | 按 `DW_AT_data_member_location` 的偏移取字段 |
| 下标 | `arr[1]`、`s[0]` | 数组/切片/字符串，带越界检查 |
| 解引用 | `*ptr` | 指针指向的基本类型可读 |
| 算术 | `arr[1]+arr[2]` | 只按 `Uint` 位模式算，没有类型提升和符号处理 |
| 比较/逻辑 | `1<2`、`arr[1]==20` | 结果是 `bool`，可以正常打印 |
| `len` / `cap` | `len(arr)`、`cap(arr)`、`len(s)` | 数组的 `len` 是元素个数；切片读头部；`cap(string)` 不支持 |
| 取地址 | `&pt.X` | 随 9.2.37 的 lvalue 判定落地；当前 master 输出 `0x... (*int)`，ch9.2.36 快照上报 `taking address requires lvalue (ch9.2.37)` |
| 类型转换 | `int(i)`、`int(arr[0])` | 不支持；`int(` 被当成函数调用 |
| 函数/方法调用 | `s.String()` | 不支持，解析阶段就报 `unexpected token "("` |
| 复合字面量 | `Point{X:1}` | 不支持，报 `unexpected token "{"` |
| 切片表达式 | `arr[1:2]` | 不支持，报 `missing ]` |
| map/channel、接口断言 | `m[k]`、`x.(int)` | 类型模型不支持 map/chan，断言没有语法 |

还有一个反直觉的边界：**纯字面量算术也不能打印**。`print 1+2` 的结果是 `Value{Uint: 3, Type: nil}`，`EvalExpression` 看到类型既不是 `BasicType` 也不是 `PointerType`，会把它当复合类型、要求有地址，最后报 `expression "1+2" is not addressable`。算术只有在至少一个操作数带类型（例如 `arr[1]+2`）时才有类型可渲染。

#### `Value`：值、类型、地址

求值器的中间结果只有三个字段（`pkg/proc/eval.go:29`）：

```go
type Value struct {
    Uint uint64      // 基本类型/指针的位模式
    Type dwarf.Type  // DWARF 类型模型
    Addr uint64      // 可寻址对象的地址；不可寻址时为 0
}
```

`Uint` 按位看值，不区分有符号/无符号；符号解释留到渲染阶段（`Variable.String` 按 `DW_ATE_signed` 做符号扩展）。`Type` 决定读几个字节、怎么渲染。`Addr` 是本节和下一节的分水岭：裸变量的 `Addr` 来自 9.2.33 的位置表达式求值，字段的 `Addr = obj.Addr + ByteOffset`，下标的 `Addr = 基址 + i*元素大小`，解引用的 `Addr = 指针的值`，常量/算术结果/比较结果的 `Addr = 0`。只要 `Addr != 0`，这个表达式就是 lvalue，可以被 `&` 取地址、被 `set` 赋值。

#### 类型模型与渲染

`pkg/dwarf/type.go` 的类型模型见 [9.1.4 后端符号层设计](../1-架构设计/4-后端符号层设计.md)，只实现了四种类型：`BasicType`（`Name`/`ByteSize`/`Encoding`，对应 `DW_TAG_base_type`）、`PointerType`（`Type`/`ByteSize`）、`StructType`（`Fields []StructField`，字段有 `Name`/`Type`/`ByteOffset`）、`ArrayType`（`Type`/`Count`/`ByteSize`）。

string 和切片在 DWARF 里都是结构体：`string = {str *uint8; len int}`，`[]T = {array *T; len int; cap int}`，所以它们走 `StructType` 分支，靠类型名（`string`、`[]` 前缀）区分。map、channel、interface、func 没有对应的 `Type` 实现，变量定位阶段就会报 `unsupported type tag`。

渲染分两条路：基本类型和指针直接来自 `Value.Uint`；结构体、数组、string、切片需要 `Value.Addr`，交给 9.2.33 的 `fillVariableValue` 按地址读内存再格式化。

### 代码实现

整条链路：

```text
godbg> print arr[1]+arr[2]
 └─ cmd/debug/print.go:33                          客户端：Client.PrintVariable
     └─ pkg/service/api/client.go:143              契约
         └─ pkg/service/debugger/debugger.go:414   门面：PrintVariable
             └─ pkg/proc/variables.go:400          EvalExpression：求值 + 渲染
                 └─ pkg/proc/eval.go:49            Eval：解析 + evalNode
                     ├─ :304 ident                 → variableLookup → EvalVariable
                     ├─ :365 fieldNode             → 字段偏移 + readMemoryValue
                     ├─ :387 indexNode             → evalIndex
                     └─ :390 callNode              → 只认 len/cap
```

#### 命令层与契约

`cmd/debug/print.go` 只做参数个数检查和输出格式化，真正的求值在后端：

```go
v, err := Client.PrintVariable(args[0])
if err != nil {
    return err
}
fmt.Printf("%s = %s (%s)\n", v.Name, v.Value, v.Type)
```

契约仍是 `PrintVariable(name string) (*Variable, error)`（`pkg/service/api/client.go:143`），`Variable` 的四个字段（`pkg/service/api/types.go:105`）是 `Name`、`Addr`、`Type`、`Value`。门面 `Debugger.PrintVariable`（`debugger.go:414`）把 `proc.Variable` 翻译成契约：

```go
v, err := d.t.EvalExpression(name)
...
return &api.Variable{
    Name:  v.Name,
    Addr:  v.Addr,
    Type:  v.Type.String(),
    Value: v.String(),
}, nil
```

`Name` 是 `EvalExpression` 里的 `expr` 原文，所以 `print arr[1]+arr[2]` 的左边原样显示，不会被规范化。

#### `EvalExpression`：求值之后的两种渲染

`pkg/proc/variables.go:400` 是表达式能力的汇合点：先 `Eval(...)`，基本类型/指针直接用 `v.Uint`，复合类型要求 `v.Addr != 0` 再交给 `fillVariableValue`（核心分支，省略错误处理与基本类型分支）：

```go
v, err := Eval(expr, t.variableLookup, t.readTargetMemorySize)
out := &Variable{Name: expr, Type: v.Type, Addr: v.Addr}
if v.Addr == 0 {
    return nil, fmt.Errorf("expression %q is not addressable", expr)
}
```
三个输入缺一不可：`lookup` 把标识符变成 `Value`（9.2.33 的定位链路），`mem` 负责解引用/字段/下标读内存，`Eval` 负责语法和运算。`readTargetMemorySize` 是对 `Process.ReadMemory` 的薄包装，因为 `MemReader` 的签名要 `(addr uint64, size int64)`。

基本类型和指针走第一条分支：值直接在 `Uint` 里。结构体、数组、string、切片走第二条：用 `Addr` 调 `fillVariableValue`，和 9.2.33 渲染裸变量时是同一个函数。`Addr == 0` 的复合类型无法渲染，报 `not addressable`，这也是 `print 1+2` 失败的原因。

#### `Eval` 与 AST

`Eval` 本身很短（`eval.go:49`）：`p := &parser{src: expr, lookup: lookup}`，`p.parse()` 得到 AST，再交给 `evalNode(ast, lookup, mem)`。解析器是手写的 tokenizer + Pratt，节点包括 `identNode`、`intNode`、`unaryNode`、`binaryNode`、`derefNode`、`addrNode`、`indexNode`、`fieldNode`、`callNode`。`parseExpr` 先处理前缀（整数、标识符、`-`/`!`/`&`、`*`、括号），再循环处理后缀（`.` 字段、`[` 下标），最后按优先级处理中缀。

标识符后面一出现 `(`，解析器就构造 `callNode`，不区分内置函数和类型转换。求值阶段只给 `len`、`cap` 放行，其余都返回 `function calls not supported (教学版能力边界)`。
所以 `print int(arr[0])` 报的是"函数调用不支持"，而不是"类型转换不支持"——`int` 被当成了一个函数名。

标识符则走 `variableLookup`：它调用 9.2.33 的 `EvalVariable`，把返回的 `Variable` 压成 `&Value{Uint: v.Value, Type: v.Type, Addr: v.Addr}`。复合类型的 `Str` 在这里被丢掉，因为后续运算只需要位模式和地址；渲染留到 `EvalExpression`。这也解释了为什么 `print pt` 能显示 `{X: 1, Y: 2}`：`pt` 的 `Value` 是结构体 + 地址，`EvalExpression` 走复合分支重新按地址渲染一遍。

#### 解引用、字段、下标

三个分支的套路一致：先求子表达式，检查类型，再算地址读内存。解引用要求 `oper.Type` 是 `*dwarf.PointerType`，然后 `readMemoryValue(oper.Uint, pt.Type, mem)`；字段选择要求是 `StructType`，按 `f.ByteOffset` 加偏移；下标见下。字段分支的核心（省略错误处理）：

```go
case fieldNode:
    obj, _ := evalNode(node.obj, lookup, mem)
    st := obj.Type.(*dwarf.StructType)
    for _, f := range st.Fields {
        if f.Name == node.field && obj.Addr != 0 {
            return readMemoryValue(obj.Addr+uint64(f.ByteOffset), f.Type, mem)
        }
    }
```
`readMemoryValue`（`eval.go:405`）是所有"按地址取值"的公共出口：先建 `Value{Type: typ, Addr: addr}`，基本类型和指针再读 `typ.Size()` 字节、小端拼进 `Uint`；结构体和数组只记 `Addr`，留给渲染层。`Addr` 在两种情况下都设置，所以 `pt.X`、`arr[1]`、`*ptr` 天然是 lvalue。

下标分支（`evalIndex`，`eval.go:426`）按三种类型分派：数组用 `addr + idx*元素大小` 并检查 `idx < Count`；切片从头部偏移 0 读数据指针、偏移 8 读长度，检查 `idx < len`；string 从头部读指针和长度，取第 `idx` 个字节，返回 `uint8`。切片只检查 `len` 不检查 `cap`，因为 `s[i]` 只要求 `i < len(s)`；字符串下标得到的是字节值，`print s[0]` 是 `104` 而不是 `'h'`。

`len`/`cap`（`evalLenCap`，`eval.go:494`）也按类型分派：数组的 `len` 是 `Count`，固定数组的 `cap` 被拒绝；切片偏移 8 读 `len`、偏移 16 读 `cap`；string 只有 `len`，所以 `print cap(s)` 报 `cap of string not supported`。

#### 复合类型怎么渲染

`fillVariableValue`（`variables.go:226`）是 9.2.33 的实现，本节直接复用：string 读指针和长度后 `strconv.Quote`；切片读 `{ptr,len,cap}` 后逐元素渲染；结构体按字段偏移递归；数组按元素大小逐项渲染。元素类型只支持基本类型，否则报 `array/slice of composite type not supported`。

`Variable.String`（`variables.go:19`）负责最后一步：`Str` 非空直接返回（string/切片/结构体都走这里）；bool 输出 `true`/`false`；有符号整型按 `ByteSize` 做符号扩展；其余按无符号十进制；指针落到最后的 `%#x`。所以结构体里的指针字段只显示地址，不会展开指向的对象。

### 执行测试

断在 `_fixtures/vars` 的 `main.go:28`（全局变量都已初始化），连续打印各类表达式：

```text
godbg> print arr
arr = [10 20 30] ([]int)
godbg> print arr[1]+arr[2]
arr[1]+arr[2] = 50 (int)
godbg> print pt.X+pt.Y
pt.X+pt.Y = 3 (int)
godbg> print pt
pt = {X: 1, Y: 2} (main.Point)
godbg> print *ptr
*ptr = 10 (int)
godbg> print ptr
ptr = 0x566550 (*int)
godbg> print len(arr)
len(arr) = 3 (int)
godbg> print s[0]
s[0] = 104 (uint8)
```

`arr[1]+arr[2]` 能算，是因为两个操作数都是 `int`，结果类型取左操作数；`pt` 的 `{X: 1, Y: 2}` 是 `fillVariableValue` 按字段偏移读出来的；`ptr` 只显示地址 `0x566550`（每次构建可能不同），要看指向的值必须写 `*ptr`。

把边界写法集中跑一遍，得到的是这些结果（地址每次构建可能不同）：

| 表达式 | 实际输出 |
|---|---|
| `print &pt.X` | 当前 master：`&pt.X = 0x566420 (*int)`；ch9.2.36 快照：`Error: taking address requires lvalue (ch9.2.37)` |
| `print int(i)` | `Error: function calls not supported (教学版能力边界)` |
| `print 1+2` | `Error: expression "1+2" is not addressable` |
| `print arr[1:2]` | `Error: missing ]` |
| `print arr[3]` | `Error: index 3 out of range [0:3]` |
| `print pt.Z` | `Error: field "Z" not found in main.Point` |
| `print Point{X:1}` | `Error: unexpected token "{"` |
| `print s.String()` | `Error: unexpected token "("` |
| `print cap(s)` | `Error: cap of string not supported (教学版能力边界)` |

`&pt.X` 是本节和下一节的接缝：9.2.36 只把"哪些表达式能求值"补齐，取地址需要 lvalue 判定，放在 9.2.37 和 `set` 一起做；所以 ch9.2.36 快照上报错，当前 master 已能输出地址。其余错误分别落在解析阶段（切片、复合字面量、方法调用）、类型检查阶段（字段、解引用）、越界检查阶段和渲染阶段。上表其余用例由 `testdata/script/ch9.2.36.txt` 固化，覆盖 `arr`、`arr[1]`、`s`、`len(s)`、`pt.X`、`*ptr`、`pt` 七条断言；`&pt.X` 的往返由 ch9.2.37 的脚本覆盖。

### 本节小结

`print` 的表达式能力可以概括成三层：解析层把输入变成 AST（标识符、字面量、字段、下标、解引用、一元/二元运算、`len`/`cap`）；求值层用 `lookup` 找变量、用 `mem` 读内存，得到 `Value{Uint, Type, Addr}`；渲染层对基本类型/指针直接用 `Uint`，对复合类型用 `Addr` 交给 `fillVariableValue`。

能力边界：**作用域/shadowing 简化**，`FindVariable` 只按名字深度优先取第一个 `DW_TAG_variable`，不按 lexical_block 的地址范围过滤，内层同名变量可能读到外层槽位（9.2.18 讨论过，9.2.33 选择了简化）；**复合类型元素限基本类型**，数组/切片元素必须是 `BasicType`；**指针字段只打印地址**，要看指向对象得自己写 `*field`；**没有函数调用/方法调用/类型转换/复合字面量/map/channel/接口断言/切片表达式**；**纯字面量算术不可打印**（`1+2` 报 `not addressable`，`1<2` 例外，因为比较显式返回 `bool`）；**比较按 `Uint` 位模式做**，负数会失真，符号语义只在渲染阶段处理。

下一节 `set` 只做一件事：把这里求出的 `Value.Addr` 当作 lvalue 地址，按 `Type.ByteSize` 写入新值。
