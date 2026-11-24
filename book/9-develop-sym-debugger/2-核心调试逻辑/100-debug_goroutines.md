## goroutines：列举全部 goroutine

Go 程序一启动，已经有一串 goroutine 在跑：`runtime.main`、`forcegchelper`、`gcenable` 的两个包装、`runfinq`，再加上用户自己起的。要按协程调试，第一步是把它们列出来：每个 g 的 goid、当前调度状态、入口函数。`goroutines`（别名 `grs`）就干这一件事。

难点不在打印，在"从哪里读"。`g` 是运行时的私有结构，调试器没有它的源码可执行，只有 DWARF。godbgv2 的做法分两步：先用 DWARF 全局变量定位 `runtime.allgs`（`[]*g` 的切片头），再按 `runtime.g` 的 DWARF 结构体字段偏移逐个读 `goid` / `atomicstatus` / `startpc`。偏移全部来自调试信息，不硬编码——这是本节的主线。

分工先说清楚：本节只"列出"，不"选择"。选中某个 g 之后 `bt` / `print` 怎么改用它的寄存器上下文，是 9.2.40 的事；线程视角是 9.2.41 的事。

### 实现目标

`godbg> goroutines` 无参数、无过滤，一条命令列出 `allgs` 里的全部 g，每条一行（`_fixtures/vars`，go1.24.13）：

```text
godbg> goroutines
* goroutine 1: [_Grunning] runtime.main()
  goroutine 2: [_Gwaiting] runtime.forcegchelper()
  …
total 6 goroutine(s)
```

行首 `*` 标"当前线程正在运行的 goroutine"（9.2.40 的 `CurrentGoroutine`），末行 `total` 是条数；三列依次是 goid、调度状态、入口函数名。

契约里一条记录有五个字段（`pkg/service/api/types.go:121`）：`ID`（goid）、`Status`（状态名）、`Entry`（startpc，入口地址）、`Function`（`Entry` 反查出的函数名）、`Current`。命令层只打印 goid、状态、函数名，`Entry` 留在契约里没有印——**想看当前 PC / 源码位置，要用 9.2.40 的 `bt` 或 9.2.41 的 `threads`**。`goroutines` 给的是"入口"，不是"现在跑到哪"，这个区别在调试挂起 goroutine 时尤其要记住。

两个限制先交代：一是**全量列出**，没有系统 goroutine 过滤（delve 的 `hideSystemGoroutines` / `goroutineFilters` 这类机制 godbgv2 没有），所以运行时自己的 `forcegchelper`、`gcenable.gowrap1` 都在列表里；二是**不区分死活**，`_Gdead` 的 g 也可能出现（见下文状态名与实测）。整条链路依赖 DWARF，调试信息被裁剪时连断点都设不了，`goroutines` 自然也无从谈起。

### 基础知识

#### 三样东西：allgs、g 的字段、函数表

**`allgs` 是全部 g 指针的切片**，在 `runtime/proc.go:635` 声明，运行时的注释写得很直白：`allgs contains all Gs ever created (including dead Gs), and thus never shrinks`，访问由 `allglock` 或 STW 保护。"包含死 g、永不收缩"解释了后面两个现象：为什么 `goroutines` 会列出已经退出的 goroutine，为什么死亡 g 的槽位会被新 goroutine 复用（`g` 结构体从 `gFree` 链表回收，`newproc1` 复用时**不会**再调 `allgadd`）。

**切片头在 DWARF 里是一个结构体**（go 不给切片单独的类型 tag），`_fixtures/vars` 的 DIE 长这样（`readelf --debug-dump=info`，节选）：

```text
<1><6f5be>: DW_TAG_structure_type
    DW_AT_name        : []*runtime.g
    DW_AT_byte_size   : 24
 <2> DW_TAG_member  DW_AT_name: array  DW_AT_data_member_location: 0   type: **runtime.g
 <2> DW_TAG_member  DW_AT_name: len    DW_AT_data_member_location: 8
 <2> DW_TAG_member  DW_AT_name: cap    DW_AT_data_member_location: 16
```

`array` 字段的类型是"指向元素的指针"，而元素本身又是 `*g`，所以在类型模型里要剥**两层**指针才落到 `runtime.g` 结构体——`goroutineLayout` 正是这么做的。

**g 的三个字段各管什么**：

- `goid`：`uint64`，进程内唯一、单调递增（但有跳号，见下文）；
- `atomicstatus`：调度状态，类型是 `atomic.Uint32`，取值 `_Gidle`/`_Grunnable`/`_Grunning`/…；
- `startpc`：创建这个 g 时 `go` 语句指定的函数入口地址（`uintptr`）。它**不随执行变化**，只能回答"这个 g 从哪个函数开始跑"。

**函数名是反查出来的**。`Debugger.Goroutines` 对每条记录调 `d.t.FuncForPC(g.Entry)`（`pkg/service/debugger/debugger.go:565`）。`FuncForPC` 不查 `.gopclntab`，而是在 DWARF 的全部 `DW_TAG_subprogram` 地址区间里二分（`pkg/proc/funcs.go:157`）：按入口地址排序后，`sort.Search` 找到第一条 `Entry > pc` 的记录再往前找覆盖区间。这也是"入口函数名偶尔是编译器生成的包装"（如 `gcenable.gowrap1`）的原因——`startpc` 指向哪个函数，就印哪个名字。

#### 为什么字段偏移必须来自 DWARF

`runtime.g` 是运行时内部结构，字段随版本增删、重排。把同一段"打印 `ByteOffset`"的小工具跑在四个版本上（各版本用 `-N -l` 构建最小程序），实测：

| 字段 | go1.24.13 | go1.25.8 | go1.26.2 | go1.27.3 |
|---|---|---|---|---|
| `sizeof(runtime.g)` | 440 | 440 | 456 | 456 |
| `goid` | 160 | 152 | 152 | 152 |
| `atomicstatus` | 152 | 144 | 144 | 144 |
| `startpc` | 304 | 296 | 304 | 304 |

（`_fixtures/vars` 用 go1.24.13 构建，与第一列一致。）go1.24 → go1.25 之间 `goid` 前移 8 字节、`startpc` 前移 8 字节；go1.25 → go1.26 之间 `startpc` 又回到 304。任何一处写死 160 / 304，换一个工具链就是"读错字段、打印垃圾甚至读崩"。所以 `goroutineLayout` 只做一件事：从 DWARF 里把偏移解析出来，缓存进 `goroutineFields`。

#### goid 为什么跳号，为什么不能用地址当 ID

`goid` 不是简单的自增计数器：每个 P 会一次预取一批（`_GoidCacheBatch = 16`，`runtime/proc.go:728`），再从 `p.goidcache` 里逐个发（`runtime/proc.go:5170`）。P 被销毁时没用完的号就浪费了，于是出现 2 → 17 → 33 这种"每跳 15"的空洞；实测同一程序两次运行分别是 `1, 2, 17, 18, 33, 34` 与 `1, 2, 3, 4, 5, 6`。所以 goid 只能当标识，不能当下标、不能当"第几个 goroutine"。

那为什么不干脆用 `g` 的地址当 ID？因为地址会被复用：goroutine 退出后 `g` 结构体被 `gfput` 挂回 `gFree`，下一个 goroutine 经 `gfget` 复用同一块内存——地址相同、goroutine 不同。`proc.Goroutine` 的 `addr` 字段因此只做内部使用（注释写明"不出现在契约中"），对外一律用 `goid`；需要稳定选择时，`SelectGoroutine` 还支持按入口函数名选（9.2.40）。

### 代码实现

整条链路（每步后面是文件:行）：

```text
godbg> goroutines
 └─ cmd/debug/goroutines.go:27                                  命令层：Client.Goroutines + 打印
     └─ pkg/service/api/client.go:122
         → pkg/service/debugger/debugger.go:549                契约 → 门面
         ├─ pkg/proc/goroutines.go:212                          Target.Goroutines
         │   └─ :155                                           allGoroutines：定位 allgs、遍历
         │       ├─ pkg/proc/variables.go:69                   EvalVariableAddr("runtime.allgs")
         │       ├─ pkg/proc/variables.go:345                  readUint：逐字段读内存
         │       └─ pkg/proc/goroutines.go:68                  goroutineLayout：解析 g 的 DWARF 布局
         ├─ pkg/proc/goroutines.go:222                          CurrentGoroutine：当前线程的 g（9.2.40）
         └─ pkg/proc/funcs.go:157                              FuncForPC：startpc → 函数名
```

#### 命令层

`cmd/debug/goroutines.go` 只负责取数与排版（`RunE`，省略错误处理）：

```go
gs, err := Client.Goroutines()
if err != nil {
    return err
}
for _, g := range gs {
    marker := " "
    if g.Current {
        marker = "*"
    }
    fmt.Printf("%s goroutine %d: [%s] %s()\n", marker, g.ID, g.Status, g.Function)
}
fmt.Printf("total %d goroutine(s)\n", len(gs))
```

#### 门面：补状态名、函数名与"当前"标记

`Debugger.Goroutines`（`debugger.go:549`）把符号层结果翻译成契约类型，顺手补三样：

```go
cur, _ := d.t.CurrentGoroutine()          // 失败不致命：cur 为 nil 时只是没有 * 标记
out := make([]api.Goroutine, len(gs))
for i, g := range gs {
    out[i] = api.Goroutine{ID: g.ID, Status: g.StatusName(), Entry: g.Entry}
    if fn, err := d.t.FuncForPC(g.Entry); err == nil {
        out[i].Function = fn.Name         // startpc → 函数名
    }
    if cur != nil && cur.ID == g.ID {
        out[i].Current = true
    }
}
```

注意 `CurrentGoroutine` 的误差被刻意忽略：它要读 TLS（9.2.40），读不到时列表照样输出，只是少了 `*`。

#### 定位 allgs 并遍历

`allGoroutines`（`pkg/proc/goroutines.go:155`）是本节的核心，逻辑只有"求地址 → 读切片头 → 循环读元素 → 循环读字段"（省略类型断言与错误检查）：

```go
addr, _, err := t.EvalVariableAddr("runtime.allgs")   // 全局变量 DIE → DW_OP_addr → 地址
ptr, err := t.readUint(addr)                          // slice.array
length, err := t.readUint(addr + 8)                   // slice.len
f, err := t.goroutineLayout()                         // g 的字段偏移（DWARF）

gs := []*Goroutine{}
for i := uint64(0); i < length; i++ {
    gaddr, err := t.readUint(ptr + i*8)               // allgs[i]
    if gaddr == 0 {
        continue
    }
    g := &Goroutine{addr: gaddr}
    if v, err := t.readUint(gaddr + f.goidOff); err == nil {
        g.ID = int64(v)
    }
    if v, err := t.readUint(gaddr + f.statusOff); err == nil {
        g.Status = uint32(v)
    }
    if v, err := t.readUint(gaddr + f.startpcOff); err == nil {
        g.Entry = v
    }
    gs = append(gs, g)
}
```

几个实现细节值得点出来：

- 切片头只从 DWARF 借了"元素类型"，`array`/`len` 的偏移直接用了 `+0`/`+8`，`cap`（`+16`）根本没读——go 的切片布局稳定，真正的版本风险在 `g` 内部，那里全部走 DWARF；
- 每个字段都读 8 字节再截断：`goid`/`startpc` 是 8 字节，`atomicstatus` 只有 4 字节，`readUint` 多读的 4 字节是相邻的 `stackLock`，取低 32 位不影响结果；
- 单个字段读失败只跳过该字段（`if err == nil`），不 fail 整条命令；只有读元素指针失败才整体报错；`gaddr == 0` 直接跳过——遍历期间 `allgs` 理论上可能追加，防御性判断。

#### 解析 g 的布局

`goroutineLayout`（`pkg/proc/goroutines.go:68`）是"从调试信息推导偏移"的那一半，节选（省略类型断言的 `ok` 检查）：

```go
reader := godbgdwarf.NewReader(d)
entry, err := reader.FindGlobalVariable("runtime.allgs")
typ, err := reader.TypeOfEntry(entry)
st, _ := typ.(*godbgdwarf.StructType)                    // []*g 的切片头
gType, _ := st.Fields[0].Type.(*godbgdwarf.PointerType)  // **g
gType2, _ := gType.Type.(*godbgdwarf.PointerType)        // *g
gStruct, _ := gType2.Type.(*godbgdwarf.StructType)       // runtime.g

f.goidOff, err = gFieldOffset(gStruct, "goid")
f.statusOff, err = gFieldOffset(gStruct, "atomicstatus")
f.startpcOff, err = gFieldOffset(gStruct, "startpc")
f.schedOff, err = gFieldOffset(gStruct, "sched")         // 9.2.40 用
```

`gFieldOffset` / `findField`（同文件 `:356`、`:364`）在 `StructType.Fields` 里按名字取 `ByteOffset`，找不到时报 `field g.%s not found in DWARF type info`。这里有一条设计约束，函数注释写得很直白：**`goroutineLayout` 必须走纯 DWARF 路径，不能经 `EvalVariableAddr`**。因为 `EvalVariableAddr` 第一件事是 `t.Registers()`（`variables.go:75`），而选中 goroutine 时 `Registers()` 会调 `threadOfGoroutine`（9.2.40），后者又要调 `goroutineLayout`——绕回来就是无限递归。把"解析类型"与"读内存/读寄存器"分开，环就断开了。

#### 全局变量怎么找

`EvalVariableAddr`（`variables.go:69`）对 `runtime.allgs` 的处理分两步：先按当前函数找局部变量，找不到再看名字里有没有 `.`。带包前缀的名字走 `FindGlobalVariable`（`pkg/dwarf/reader.go:144`），它遍历全部编译单元、取 `DW_AT_name` 完全相等的 `DW_TAG_variable`，再对 `DW_AT_location` 里的 `DW_OP_addr` 求值得到地址；不带前缀的名字走 `FindGlobalVariableInPC`，用 `.debug_ranges` 把查找限定在 PC 所在的编译单元，避免不同包的同名全局变量撞车。

同一套"全局变量 DIE + `DW_OP_addr` + DWARF 字段偏移"的手法，在 `pkg/proc/moduledata.go:26` 解析 `runtime.firstmoduledata` 时已经用过——`allgs` 只是把"读字段"换成了"读切片再读 g"。代价是查一个全局变量的地址却要先读寄存器、算 PC、求 CFA：复用了通用变量定位路径，省掉了一条专用查询。

#### 状态名：一张需要维护的表

状态码到名字的映射是写死的（`pkg/proc/goroutines.go:28`）：

```go
var goroutineStatus = map[uint32]string{
    0: "_Gidle", 1: "_Grunnable", 2: "_Grunning", 3: "_Gsyscall",
    4: "_Gwaiting", 5: "_Gdead", 6: "_Genqueue", 7: "_Gcopystack",
}
```

问题在于现代 go 的编号已经不是这样。go1.24 的 `runtime/runtime2.go` 里是 `5 _Gmoribund_unused`、`6 _Gdead`、`7 _Genqueue_unused`、`8 _Gcopystack`、`9 _Gpreempted`，另有 `_Gscan = 0x1000` 与状态按位或（如 `0x1004` 即 `_Gscan|_Gwaiting`）。后果实测可见：状态 6（`_Gdead`）会被印成 `_Genqueue`；8、9 以及 GC 扫描中的组合状态会落到 `StatusName` 的兜底分支，印成 `status(8)`、`status(4098)` 这种形式。这是"偏移能自适应、枚举名却不能"的典型不一致——读代码时别把 `_Genqueue` 当真的入队状态。

### 执行测试

断在 `_fixtures/vars` 的 `main.go:28`（spinner 已在跑），执行 `goroutines`：

```bash
$ ./godbg exec _fixtures/vars
process 2078844 launched, stopped by SIGTRAP
godbg> break main.go:28
breakpoint 1 added at 0x4b1b86 (…/examples/debuggee/vars/main.go:28)
godbg> continue
thread 2078844 status: stopped: trace/breakpoint trap
> …/examples/debuggee/vars/main.go:28 (pc: 0x4b1b87)
godbg> goroutines
* goroutine 1: [_Grunning] runtime.main()
  goroutine 2: [_Gwaiting] runtime.forcegchelper()
  …
  goroutine 34: [_Grunning] main.spinner()
total 6 goroutine(s)
```

读这张表要注意三件事：

1. **有两条 `_Grunning`**。事件线程停在断点上，但 spinner 所在的那个 M 是被 all-stop 强行停住的，它的 g 状态还停在 `_Grunning`。所以"all-stop 时只有一个 g 在跑"是错觉：只要进程有多个 M 在跑 Go 代码，就会看到多个 `_Grunning`（这一点直接影响 9.2.40 的兜底逻辑）；
2. **goid 有洞**。2 → 17 → 18 → 33 → 34，正是 P 批量预取 goid 的结果；换一次运行会变成 1,2,3,4,5,6，条数相同、号不同——脚本不能按号写死；
3. **系统 goroutine 全在**。`forcegchelper`、`gcenable.gowrap1/2`、`runfinq` 一个都没过滤，这就是"没有 `hideSystemGoroutines`"的直接表现。

**死 goroutine 会出现，而且状态名是错的。** 另建一个最小程序：`main` 里 `go work()`，`work` 立刻返回，`main` 睡 100ms 后在断点处停下。此时 `work` 的 g 已经走完 `goexit` → `gdestroy`，状态是 `_Gdead`(6)，但列表里印的是 `goroutine 20: [_Genqueue] main.work()`——原因就是上面那张映射表把 6 当成 `_Genqueue`。这同时证明"不区分死活"：`allgs` 收录所有创建过的 g，命令原样列出。

**换工具链也成立。** 用 go1.25.8 另建一个只有 `go func(){ select{} }()` 的最小程序（该版本字段偏移已变，见基础知识表），`godbg` 同样能列出 4 条：`* goroutine 1: [_Grunning] runtime.main()`、`goroutine 2: [_Grunnable] runtime.forcegchelper()` 以及两个 `gcenable` 包装。同一份代码、两套布局都读对了——这就是"不硬编码"的实测含义。对应冒烟脚本 `testdata/script/ch9.2.38.txt` 用 `_fixtures/vars` 断言 `runtime.main`、`forcegchelper` 与 `total` 三行，`./scripts/smoke.sh ch9.2.38` 输出 `smoke: all passed`。

### 本节小结

`goroutines` 的链路可以概括成四步：用 `EvalVariableAddr("runtime.allgs")` 找到全局切片头；读 `array`/`len`，按 8 字节元素逐个取出 `*g`；用 `goroutineLayout` 从 DWARF 解析出的字段偏移读 `goid`、`atomicstatus`、`startpc`；把 `startpc` 经 `FuncForPC` 反查成函数名，补上"是否当前"后交给契约。打印格式只有一行文本，真正的工作量在"布局从哪来"。

能力边界与已知问题：

- **无过滤**：系统 goroutine、`_Gdead` 的 g 都列，delve 那套 `hideSystemGoroutines`/`goroutineFilters` 没有对应实现；
- **状态名不可靠**：`goroutineStatus` 表沿用旧编号，现代 go 的 6/7/8/9 与 `_Gscan` 组合位都会错标或落到 `status(N)`；偏移能自适应版本，这张表不能；
- **入口 ≠ 当前位置**：`startpc` 是 g 的入口函数，列表里不打印当前 PC；当前执行点要看 `bt`/`threads`（9.2.40、9.2.41）；
- **并发只在 all-stop 下安全**：`allgs` 由 `allglock` 或 STW 保护，追加时可能换新数组；godbgv2 直接读切片头（先 `array` 后 `len`），靠的是"命令执行时全部线程已停"。若将来支持 non-stop，这种读法会读到"旧数组 + 新长度"，需要改成运行时自己的 `allglen`→`allgptr` 顺序，或先停住再读；
- **依赖 DWARF**：没有调试信息时连断点都设不了（`decoding dwarf section info ... too short`），`goroutines` 不是例外；
- **goid 不是身份的全部**：进程内唯一但跨运行会变、还会跳号；`g` 地址会随 `gFree` 复用而变化——需要稳定选择时用入口函数名（`goroutine <funcname>`，9.2.40）。
