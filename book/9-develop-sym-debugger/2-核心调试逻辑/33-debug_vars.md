## print（一）：变量定位与取值

### 实现目标

`print` 是调试器里最常用的命令。godbgv2 的 `print` 接受一个名字，把它变成一行可读的结果：`godbg> print i` → `i = 0 (int)`。从输入到输出，要回答三个问题：

1. **变量在哪**：同一时刻可能有多个同名 DIE，先确定当前 PC 所在函数里的哪一个，再读它的位置描述 `DW_AT_location`；
2. **地址怎么算**：位置描述是一段 `DW_OP` 字节码，要在栈机上执行，输入是当前线程的寄存器值与当前帧的 CFA；
3. **内存怎么解释**：拿到地址后，按 `DW_AT_type` 解析出的类型决定读几个字节、怎么渲染。

本节只讲这条"名字 → 地址 → 值"的链路；`print arr[1]`、`print pt.X`、`print len(s)` 这类表达式能力放在 9.2.36（print 二）。还要先澄清一件事：godbgv2 **没有 `args` / `locals` / `vars` 命令**，看变量只能逐个 `print`；gdb 的 `ptype` 在这里叫 `ptypes`，是桩；`whatis` 没有对应命令。本章早期稿件以 tinydbg 为参照，代码路径现已统一到 godbgv2。

### 基础知识

#### 变量 DIE：名字、类型、位置

DWARF 里一个局部变量是一个 `DW_TAG_variable` 条目，三个属性决定了本节全部的活：`DW_AT_name`、`DW_AT_type`（类型 DIE 的引用）、`DW_AT_location`（位置描述）。编码细节见 [8.4.1 DIE描述数据和类型](../../8-dwarf/4-die/1-desc-data-type.md) 与 [8.4.2 位置数据](../../8-dwarf/4-die/2-desc-locations.md)。

以 `_fixtures/loop`（go1.24.13，`-N -l`）为例，`main.main` 的局部变量长这样（`readelf --debug-dump=info`，节选）：

```text
<1><369f>: DW_TAG_subprogram
    DW_AT_name        : main.main
    DW_AT_frame_base  : 1 byte block: 9c   (DW_OP_call_frame_cfa)
 <2><36d0>: DW_TAG_lexical_block
    DW_AT_ranges      : 0x420
 <3><36d5>: DW_TAG_variable
    DW_AT_name        : i
    DW_AT_location    : 3 byte block: 91 98 7f   (DW_OP_fbreg: -104)
```

两处细节值得记住：`i` 声明在 `for` 循环里，是 **lexical_block 的子级**而不是 subprogram 的直接子级；它没有绝对地址，位置写成"帧基址 − 104"，帧基址由 `DW_AT_frame_base` 给出——go 给的是 `DW_OP_call_frame_cfa`，即"用本帧的 CFA"。

**位置的两种形式。** class exprloc 是一段内联的 `DW_OP` 表达式；class loclistptr 是 `.debug_loc` 中的偏移，指向一组"地址区间 → 表达式"的记录，变量在寄存器与栈之间搬家时靠它描述。同一个二进制里两种都会出现：`-N -l` 的用户代码基本是 `DW_OP_fbreg` 的 exprloc，runtime 里大量参数用位置列表（如 `sync.(*Map).Load` 的 `m`：`DW_AT_location: 0x0 (location list)`）。

#### DW_OP 栈机与帧基址约定

位置表达式在一个栈机上执行（DWARF v4 §2.6）：操作码从字节流读入，操作数从栈上取、结果压回。`pkg/dwarf/op.go` 实现了教学版需要的子集：`DW_OP_addr` / `const*` / `lit*` 压常量；`DW_OP_reg*` / `breg*` 取寄存器值（`breg7` 即 `rsp+off`）；`DW_OP_fbreg` 取帧基址加偏移；`DW_OP_call_frame_cfa` 取当前帧 CFA；`DW_OP_deref` 弹出地址读 8 字节压回；`plus` / `plus_uconst` / `minus` 等做栈上运算。

`DW_OP_fbreg` 的帧基址从哪来？DWARF 让调试器先求值 `DW_AT_frame_base`。godbgv2 沿用 ch8.4.2 的讲义约定：把求值结果放进寄存器表的保留槽 `Regs[0x7fffffff]`，`DW_OP_fbreg` 只从这个槽取值（`pkg/dwarf/op.go:332`）。go 的 `DW_AT_frame_base` 恒为 `DW_OP_call_frame_cfa`，于是这条链最终落在"本帧 CFA"上——CFA 来自 `.debug_frame` 的 CFI 规则，是 9.2.34 的主题。

### 代码实现

整条链路（每一步后面是文件:行）：

```text
godbg> print i
 └─ cmd/debug/print.go:33                                            客户端：Client.PrintVariable + 格式化
     └─ pkg/service/api/client.go:143 → pkg/service/debugger/debugger.go:414   契约 → 门面：PrintVariable
         └─ pkg/proc/variables.go:400 → pkg/proc/eval.go:49 → :631             EvalExpression → Eval → variableLookup
             └─ pkg/proc/variables.go:52 → :69 / :226                          EvalVariable → 定位 + 取值
```

客户端只做两件事：调契约、格式化（`cmd/debug/print.go:33` 的 `v, err := Client.PrintVariable(args[0])`，随后 `fmt.Printf("%s = %s (%s)\n", v.Name, v.Value, v.Type)`）。契约 `PrintVariable(name string) (*Variable, error)` 把结果收敛成四个字段（`pkg/service/api/types.go:104`）：`Name`、`Addr`（求值出的变量地址）、`Type`（类型名）、`Value`（渲染后的值）。门面（`debugger.go:414`）负责把 `proc.Variable` 翻译成这四个字段：

```go
v, err := d.t.EvalExpression(name)
if err != nil {
    return nil, err
}
return &api.Variable{
    Name:  v.Name,
    Addr:  v.Addr,
    Type:  v.Type.String(),
    Value: v.String(),
}, nil
```

从 ch9.2.36 起，门面统一走 `EvalExpression`。对裸标识符，它内部经 `variableLookup` 落到 `EvalVariable`，本节讲的定位链路就在这一层；基本类型的值来自 `Variable.Value`，复合类型的渲染结果来自 `Variable.Str`，`Addr` 则原样带进契约。

#### 找 DIE：先当前函数，再全局

`EvalVariableAddr` 先确定"在哪找"：读当前调试上下文的寄存器（选中线程优先，其次选中 goroutine，否则当前事件线程），取 PC；断点命中时 PC 停在 `int3` 之后，查询要用 `effectivePC` 回退一个字节（`variables.go:81`，9.2.34 细说）。然后按 PC 反查函数（`t.bi.FuncForPC(pc)`），再调 `reader.FindVariable(fn.Name, name)`（`variables.go:98`）。

`FindVariable`（`pkg/dwarf/reader.go:70`）先按名字找到 `DW_TAG_subprogram`，再从它的偏移开始深度优先遍历整棵子树，返回第一个 `DW_AT_name` 匹配的 `DW_TAG_variable`。**它不按 lexical_block 的地址范围过滤**，这个取舍在"能力边界"里再提。局部变量找不到时退到全局变量：带包前缀的名字（`runtime.allgs`）用 `FindGlobalVariable`，不带前缀的用 `FindGlobalVariableInPC` 限定到 PC 所在的编译单元，避免不同包的同名全局变量撞车（`variables.go:104`）。

#### 位置 → 地址

类型先解析：`reader.TypeOfEntry(entry)` 顺着 `DW_AT_type` 构建教学类型模型（`BasicType` / `PointerType` / `StructType` / `ArrayType`）。然后处理位置描述（`variables.go:120`，省略了错误处理）：

```go
switch v := entry.Val(stddwarf.AttrLocation).(type) {
case []byte: // class exprloc
    expr = v
case int64: // class loclistptr：偏移指向 .debug_loc 中的位置列表
    locs, err := godbgdwarf.ParseLoclist(data, 8)
    e := locs.EntryFor(pc)
    expr = e.Expr
}
```

`ParseLoclist`（`pkg/dwarf/loclist.go:45`）按 DWARF v4 §7.7.3 解析 `.debug_loc`：每条记录是"起止地址 + 表达式长度 + 表达式"，以两个 0 地址结束；某条记录的起始地址全 1 表示**基址选择**，之后各条记录里的地址是相对该基址的偏移（go 链接器用这种写法省掉 8 字节绝对地址）。`EntryFor` 只是线性找覆盖 `pc` 的区间。

接着准备运行时上下文。CFA 由 `cfaForPC` 查 `.debug_frame` 得到（`variables.go:183`）；寄存器表把 `syscall.PtraceRegs` 映射为 DWARF 编号（x86-64：`rax`=0、`rbp`=6、`rsp`=7、`rip`=16，`variables.go:372`）；帧基址求值后写进保留槽 `Regs[0x7fffffff]`：

```go
fbCtx := &godbgdwarf.OpContext{Regs: dregs, Mem: t.readTargetMemory, CFA: cfa}
if fb, err := fbCtx.Eval(fbExpr); err == nil {
    dregs[0x7fffffff] = fb
}
```

最后执行位置表达式：`ctx := &godbgdwarf.OpContext{Regs: dregs, Mem: t.readTargetMemory, CFA: cfa}`，`addr, err := ctx.Eval(expr)`（`variables.go:168`）。对 `i` 来说就是 `DW_OP_fbreg(-104)` → `CFA - 104`。

#### 地址 → 值

`fillVariableValue`（`variables.go:226`）按类型分派：

- 基本类型与指针：按 `ByteSize` 读内存、小端拼成 `Value`；渲染时 `String()`（`variables.go:19`）按 `DW_ATE_boolean` / `DW_ATE_signed` 输出 `true`/`false` 或有符号十进制，其余按无符号十进制；
- `string`：Go 的 string 在 DWARF 里是结构体 `{str *uint8; len int}`，读指针与长度，再读 `len` 字节并 `strconv.Quote`；
- 切片 `[]T`：结构体 `{array *T; len int; cap int}`，读指针与 `len` 后逐元素渲染成 `[10 20 30]`；
- 结构体与数组：按 `DW_AT_data_member_location` 的偏移逐字段/逐元素递归渲染，得到 `{X: 1, Y: 2}`。string 与切片在 DWARF 里没有专门的 tag，都走 `*StructType` 分支、靠类型名（`string`、`[]` 前缀）区分。

### 执行测试

先断在 `loop` 的循环体（`main.go:16`），`print` 两个局部变量（路径前缀 `/home/.../godbgv2` 已省略）：

```bash
$ ./godbg exec _fixtures/loop
process 1906573 launched, stopped by SIGTRAP
godbg> break main.go:16
breakpoint 1 added at 0x4b3971 (…/examples/debuggee/loop/main.go:16)
godbg> continue
thread 1906573 status: stopped: trace/breakpoint trap
> …/examples/debuggee/loop/main.go:16 (pc: 0x4b3972)
godbg> print i
i = 0 (int)
godbg> print pid
pid = 1906573 (int)
```

（`continue` 之后省略了 `stop all threads now` / `continue ok` 两行常规提示。）

换 `_fixtures/vars` 看复合类型，断在 `main.go:28`：`print arr` → `arr = [10 20 30] ([]int)`，`print s` → `s = "hello" (string)`，`print pt` → `pt = {X: 1, Y: 2} (main.Point)`。`pt` 的 `{X: 1, Y: 2}` 正是 `main.Point` 两个字段按 `DW_AT_data_member_location` 偏移读出来的。这两组输出都由冒烟脚本固化成断言：`bash scripts/smoke.sh ch9.2.33` 打印 `smoke: running testdata/script/ch9.2.33.txt` 后以 `smoke: all passed` 结束。

想验证"地址算对了没有"，可以把中间量打出来（以下是一次运行的实测，栈地址每次运行都不同）：`i` 的位置是 `CFA-104`，`pregs` 读出 `Rsp = 0xc0000c0ee0`，按 `.debug_frame` 的规则得 `CFA = rsp+152 = 0xc0000c0f78`，于是 `i` 在 `0xc0000c0f10`；同一时刻用 `pmem` 读这段栈，`0xc0000c0f10` 处是 0，与 `print i` 的 0 一致。CFA 是怎么来的，见下一节。

### 本节小结

`print` 的变量定位链路可以概括成四步：由 PC 反查函数，在函数的 DIE 子树里找到同名 `DW_TAG_variable`（找不到再查全局变量）；解析 `DW_AT_type` 得到类型模型；取 `DW_AT_location`（exprloc 或 loclist），在寄存器 + CFA + 帧基址构成的上下文里跑 `DW_OP` 栈机，得到地址；按类型读内存并渲染，`Name` / `Addr` / `Type` / `Value` 经契约返回给客户端。

能力边界（读代码时容易踩到的）：

- **作用域**：`FindVariable` 只按名字取 DIE 序遍历到的第一个同名变量，不按 lexical_block 的范围过滤；有 shadowing 时可能读到外层那个变量的槽位；
- **类型模型**：只覆盖 `base_type` / `pointer_type` / `struct_type` / `array_type` / `typedef`，map、interface、chan、func 等会得到 `unsupported type tag`；数组与切片的元素必须是基本类型（`array/slice of composite type not supported`）；
- **复合类型渲染**：指针字段只打印地址，不展开指向的对象（那要 `print *ptr`，见 9.2.36）；位置表达式若只含 `DW_OP_reg*`（变量还在寄存器里），教学版只把结果记进 `Pieces` 而不入栈，最终报 `expression produced no result`；
- **只有当前帧**：`frame` 未实现（9.2.34），不能切帧，也就看不到其他帧的局部变量。

延伸：类型信息其实已经算出来了，缺的只是接出去——gdb `ptype` 的对应物在 godbgv2 里是 `ptypes`，目前是桩（`cmd/debug/ptypes.go:16` 打印 `TODO(ch9.2.36)` 后正常退出），`whatis` 没有对应命令。把 `DW_AT_type` 解析出的类型模型直接打印出来（`*main.Point`、`[]int`）是这块最自然的下一步。
