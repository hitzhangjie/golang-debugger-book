## set：修改变量

### 实现目标

`print` 回答"这个表达式现在等于多少"，`set` 回答"把它改成多少"。godbgv2 的 `set` 是教学版：只支持基本类型，但支持 `pt.X`、`arr[1]`、`*ptr` 这些 lvalue 写法。

```text
godbg> print pt.X
pt.X = 1 (int)
godbg> set pt.X 100
set pt.X = 100
godbg> print pt.X
pt.X = 100 (int)
godbg> set arr[1] 99
set arr[1] = 99
godbg> print arr
arr = [10 99 30] ([]int)
```

本节按"参数解析 → lvalue 判定 → 按类型写内存 → 能力边界"的顺序展开。

### 基础知识

#### lvalue 与 `Value.Addr`

[9.2.36 print（二）](36-debug_print.md) 的求值结果 `Value` 有三个字段：`Uint`、`Type`、`Addr`。`set` 只关心 `Addr`：

- 裸变量 `i`：`Addr` 是 [9.2.33](33-debug_vars.md) 位置表达式算出的变量地址；
- 字段 `pt.X`：`Addr = pt.Addr + X 的 ByteOffset`；
- 下标 `arr[1]`：`Addr = 数组基址 + 元素大小`；
- 解引用 `*ptr`：`Addr` 是指针指向对象的地址；
- 常量、算术结果、比较结果：`Addr = 0`。

`Addr != 0` 就是"可寻址"，也就是 lvalue。`set` 的第一道检查就是它，第二道检查是类型必须是 `BasicType`。

#### 类型大小与字节序

`Target.SetVariable` 从 `Value.Type` 取 `ByteSize`，分配同样长度的缓冲区，把 `uint64` 参数按小端逐字节填进去。linux/amd64 是小端，所以 `set pt.X 100` 写到 `pt.X` 的 8 个字节是 `64 00 00 00 00 00 00 00`。写入长度完全由 DWARF 的 `DW_AT_byte_size` 决定，不是固定 8 字节；如果类型是 `int32`，只会写 4 字节。

`set` 命令行只接受无符号整数，`strconv.ParseUint(args[1], 0, 64)` 的第二个参数是 0，所以十进制、`0x` 十六进制、`0` 八进制、`0b` 二进制都可以。负数和浮点数会被 `ParseUint` 拒绝；`set pt.X -1` 还会先被 cobra 当成 flag，报 `unknown shorthand flag: '1' in -1`，连 `ParseUint` 都到不了。

#### `set` 与 `setmem`/`pmem` 的分工

godbgv2 把"按变量改"和"按地址改"拆成了两个命令：`set <expr> <value>` 按表达式定位、写 `Type.ByteSize` 字节，依赖求值器和 DWARF 类型；`setmem <addr> <value>` 按原始地址写固定 1 字节；`pmem <addr>` 按原始地址读，支持 `--count/--fmt/--size`。

`set` 适合"我知道变量名/字段名，按语义改"；`setmem` 适合"我知道地址，按原始字节改"；`pmem` 用来验证内存布局。`set *ptr 55` 其实是两者之间的写法：先用表达式把 `ptr` 解引用成 `int` 的 lvalue，再按 `int` 的大小写。

### 代码实现

整条链路：

```text
godbg> set pt.X 100
 └─ cmd/debug/set.go:36                            客户端：Client.SetVariable(expr, value)
     └─ pkg/service/api/client.go:152              契约
         └─ pkg/service/debugger/debugger.go:527   门面：SetVariable
             └─ pkg/proc/variables.go:428          Target.SetVariable
                 ├─ pkg/proc/eval.go:49            Eval：表达式 → Value
                 └─ pkg/proc/eval.go:323           & 取地址 / lvalue 判定
```

#### 命令层

`cmd/debug/set.go` 负责参数个数、数值解析和成功提示（省略参数个数检查）：

```go
value, err := strconv.ParseUint(args[1], 0, 64)
if err != nil { return fmt.Errorf("invalid value %q", args[1]) }
if err := Client.SetVariable(args[0], value); err != nil { return err }
fmt.Printf("set %s = %d\n", args[0], value)
```

命令名 `set`，没有别名，分组 `cmdGroupInfo`。输出里的 `set pt.X = 100` 是客户端在调用成功后打印的确认，不是从目标进程读回来的值；要确认是否真的写进去，必须再 `print` 一次。

#### 契约与门面

`api.Client` 增加一个方法（`pkg/service/api/client.go:152`）：

```go
// SetVariable 求值表达式并写入新值（ch9.2.37；教学版限基本类型）
SetVariable(expr string, value uint64) error
```

门面只做空指针保护，然后转给符号层（`debugger.go:527`）：

```go
func (d *Debugger) SetVariable(expr string, value uint64) error {
    if d.t == nil {
        return fmt.Errorf("no debugged process")
    }
    return d.t.SetVariable(expr, value)
}
```

#### 定位可寻址对象

`Target.SetVariable`（`variables.go:428`）的第一段和 `EvalExpression` 一样，复用 [9.2.36](36-debug_print.md) 的求值器（省略错误返回格式）：

```go
v, err := Eval(expr, t.variableLookup, t.readTargetMemorySize)
if err != nil { return err }
if v.Addr == 0 { return fmt.Errorf("expression %q is not addressable (lvalue required)", expr) }
bt, ok := v.Type.(*godbgdwarf.BasicType)
if !ok { return fmt.Errorf("set of composite type %s not supported (教学版能力边界)", v.Type) }
```

`v.Addr == 0` 拦掉常量、算术结果和纯指针值；`*BasicType` 拦掉结构体、数组、切片、string 和指针。注意顺序：先判地址，再判类型，所以 `set &pt.X 5` 报的是 `not addressable`（`&pt.X` 的 `Addr` 是 0，只有 `Uint` 里存了地址），而不是 `composite type *int`；`set ptr 0` 则是 `set of composite type *int not supported`。

#### `&` 取地址

取地址是 9.2.37 才补上的。解析器把 `&pt.X` 建成 `unaryNode{op: "&"}`（`addrNode` 分支实际不可达），求值分支在 `eval.go:323`：

```go
case "&":
    if oper.Addr == 0 {
        return nil, fmt.Errorf("cannot take address of non-addressable expression")
    }
    return &Value{Uint: oper.Addr, Type: &dwarf.PointerType{Type: oper.Type}}, nil
```

它把操作数的 `Addr` 放进新值的 `Uint`，类型包一层 `*T`，但**不设置新值自己的 `Addr`**。所以：

- `print &pt.X` 能打印地址，类型是 `*int`；
- `set &pt.X 5` 不能赋值，因为 `&pt.X` 本身不是 lvalue；
- `print *&pt.X` / `set *&pt.X 7` 可以，解引用又把指针值变成了 `Addr = 指针值` 的 `int` lvalue。

这就是"取地址—解引用往返"：`&` 把地址放进 `Uint`，`*` 从 `Uint` 取地址并重新设置 `Addr`。

#### 写内存

类型检查通过后，`SetVariable` 按 `ByteSize` 组缓冲区并写内存：

```go
buf := make([]byte, bt.ByteSize)
for i := range buf { buf[i] = byte(value >> (8 * i)) }
if err := t.dbp.WriteMemory(uintptr(v.Addr), buf); err != nil {
    return fmt.Errorf("write %q at %#x: %v", expr, v.Addr, err)
}
```

这里直接调 `Process.WriteMemory`（ptrace 的 `POKEDATA`），不经过断点还原、不检查目标地址是否落在代码段，也没有写后校验。教学版把复杂度留给了"定位"这一步。

### 执行测试

断在 `_fixtures/vars` 的 `main.go:28`，先改字段，再改切片元素：

```text
godbg> print pt.X
pt.X = 1 (int)
godbg> set pt.X 100
set pt.X = 100
godbg> print pt.X
pt.X = 100 (int)
godbg> set arr[1] 99
set arr[1] = 99
godbg> print arr
arr = [10 99 30] ([]int)
```

`arr[1]` 的 lvalue 来自切片头：先读数据指针，再加 `1*8`，写 8 字节。把 `set arr[1] 20` 再执行一次，`print arr` 会回到 `[10 20 30]`。

`_fixtures/vars` 没有局部变量 `i`，要看局部变量得换 `_fixtures/loop`（断在 `main.go:16`）：

```text
godbg> print i
i = 0 (int)
godbg> set i 42
set i = 42
godbg> print i
i = 42 (int)
```

取地址与解引用往返：

```text
godbg> print &pt.X
&pt.X = 0x566420 (*int)
godbg> set *&pt.X 7
set *&pt.X = 7
godbg> print pt.X
pt.X = 7 (int)
godbg> set *ptr 55
set *ptr = 55
godbg> print *ptr
*ptr = 55 (int)
```

`&pt.X` 的地址每次构建可能不同；`*&pt.X` 和 `*ptr` 都能写，说明解引用产生的是真正的 lvalue，而 `&pt.X` 只是"装着地址的指针值"。

失败分支：

| 命令 | 实际输出 |
|---|---|
| `set pt 5` | `Error: set of composite type main.Point not supported (教学版能力边界)` |
| `set ptr 0` | `Error: set of composite type *int not supported (教学版能力边界)` |
| `set s 1` | `Error: set of composite type string not supported (教学版能力边界)` |
| `set 1 5` | `Error: expression "1" is not addressable (lvalue required)` |
| `set &pt.X 5` | `Error: expression "&pt.X" is not addressable (lvalue required)` |
| `set s[0] 65` | `Error: expression "s[0]" is not addressable (lvalue required)` |
| `set pt.X abc` | `Error: invalid value "abc"` |
| `set pt.X -1` | `Error: unknown shorthand flag: '1' in -1` |

`set s[0] 65` 失败不是越界，而是 string 下标在求值器里返回的是字节值、没有 `Addr`；字符串不可写。`set &pt.X 5` 失败是因为 `&` 的结果不可寻址，不是 `*int` 不支持写。

这些用例由 `testdata/script/ch9.2.37.txt` 固化：脚本覆盖 `set pt.X 42`、`set arr[1] 99`、`print &pt.X` 和 `print *&pt.X`。

### 本节小结

`set` 的实现可以概括成三步：用 9.2.36 的求值器把表达式变成 `Value`；检查 `Value.Addr != 0` 且类型是 `BasicType`；按 `Type.ByteSize` 把小端字节写进 `Value.Addr`。

能力边界：

- **只支持基本类型**：结构体、数组、切片、string、指针都不能整体赋值；字段/下标/解引用可以，因为求值器把它们拆成了基本类型 lvalue；
- **值只支持无符号整数**：`ParseUint` 不接受负数、浮点、字符串；字符串赋值需要另一套解析；
- **`&` 的结果不是 lvalue**：`set &pt.X` 失败，`set *&pt.X` 成功；指针整体赋值也不支持（`set ptr 0` 报 composite type）；
- **string 不可写**：`print s[0]` 可读，`set s[0]` 不可写；
- **没有写后校验**：`set` 打印的是命令行参数，是否生效要靠 `print`/`pmem` 再确认；写代码段、写只读页、跨页边界都没有额外保护，失败时由 `WriteMemory` 返回错误；
- **与 `setmem` 分工**：按变量语义改用 `set`，按原始地址/字节改用 `setmem`，读原始内存用 `pmem`。
