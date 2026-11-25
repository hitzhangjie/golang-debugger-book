## bt：CFI 栈回溯

### 实现目标

`backtrace`（别名 `bt`）打印当前线程的调用栈：序号、函数名、源码位置、PC，一行一帧。回溯要回答两个问题：**上一帧在哪**（返回地址、上一帧的栈顶），**什么时候停**（栈底）。godbgv2 的答案全部来自调试信息：用 `.debug_frame` 的 CFI 规则算出每帧的 CFA，再按 go 调用约定到 `CFA-8` 取返回地址。

范围先说清楚：godbgv2 只有"看栈"这一半——`frame` 是桩（打印 `TODO(ch9.2.34)` 后正常退出），`up`/`down` 没有对应命令，`deferred` 也没有，所以所有命令都只作用于当前帧。

### 基础知识

#### CFA 与 CFI

CFA（Canonical Frame Address）是 DWARF 给每帧定义的基准地址（DWARF v4 §6.4）：帧内的局部变量、被调用者保存的寄存器都可以用"CFA + 偏移"描述。CFI（Call Frame Information）就是"在某个 PC 上 CFA 等于哪个寄存器加多少"的规则表，存在 `.debug_frame` 里（原理见 [8.5.3 调用栈帧信息](../../8-dwarf/5-other/3-callframe-info.md)）。

结构是两级：CIE 描述公共信息与初始规则，FDE 描述一个函数的地址区间和逐指令的规则变化。`_fixtures/loop` 的 CIE（`readelf --debug-dump=frames`，节选）给出初始规则：

```text
00000000 0000000000000010 ffffffff CIE
  Code alignment factor: 1
  Data alignment factor: -4
  Return address column: 16

  DW_CFA_def_cfa: r7 (rsp) ofs 8
  DW_CFA_offset_extended: r16 (rip) at cfa-8
```

`DW_CFA_def_cfa: r7 ofs 8` 表示 CFA = rsp+8；`DW_CFA_offset_extended: r16 at cfa-8` 表示返回地址（列号 16 即 rip）保存在 CFA-8。`main.main` 的 FDE 在此基础上按 PC 调整偏移（同一份输出的节选）：

```text
0001f00c ... FDE cie=00000000 pc=00000000004b3940..00000000004b3a6a
  DW_CFA_def_cfa_offset_sf: -504
  DW_CFA_advance_loc: 16 to 00000000004b3950
  DW_CFA_def_cfa_offset_sf: -496
  DW_CFA_advance_loc: 10 to 00000000004b395a
  DW_CFA_def_cfa_offset_sf: -360
```

这三个数要换算：`def_cfa_offset_sf` 的操作数是 SLEB、再乘 `data alignment factor`（-4），而 readelf 把操作数当无符号再乘，于是印成 -504 / -496 / -360。除以 -4 还原成 126 / 124 / 90，按 SLEB 解读是 -2 / -4 / -38，再乘 -4 才是真实偏移 +8 / +16 / +152——分别对应函数入口、`push %rbp` 之后、`sub $0x88,%rsp` 之后。`main.main` 的帧只有 0x88 字节，看到 2016 这种量级的偏移就该警惕。

#### go 的调用约定与"上一帧"

go 在 amd64 上用 ABIInternal（go1.17+）：参数与返回值走寄存器，栈上只放溢出和局部变量。对回溯来说关键只有三条：`CALL` 把返回地址压栈，所以函数**入口**处 `rsp` 指向返回地址、`CFA = rsp+8`；序言（`push %rbp; mov %rsp,%rbp; sub $N,%rsp`）之后 CFA 固定为"入口 rsp+8"，即**调用者调用点的 rsp 等于被调者的 CFA**；返回地址在 `CFA-8`，上一帧的 `rsp` 就是本帧的 `CFA`。

于是回溯是一个循环：`CFA = 规则(pc, rsp)` → `RA = *(CFA-8)` → `(pc, rsp) = (RA, CFA)`。既不需要帧指针，也不用扫描栈去猜"哪个值像返回地址"。

#### 断点命中时的 PC 要减 1

软件断点把目标指令首字节换成 `int3`（0xcc）。命中时 CPU 已经执行完 `int3`，PC 停在**断点地址 + 1**：`break main.go:16` 落在 0x4b3971，停下时却显示 `(pc: 0x4b3972)`。CFI 描述的是"某条指令执行之后"的规则，`int3` 吃掉了断点处那条指令，此刻寄存器状态其实对应"断点地址处"的状态；直接按 0x4b3972 查规则，可能拿到下一条语句的 CFA（函数入口附近会差 8 字节，把主调帧的数据当成返回地址）。godbgv2 的处理是：**查 CFI 用 `pc-1`，显示仍用真实 PC**（`effectivePC`，`pkg/proc/backtrace.go:75`）。

### 代码实现

链路（每一步后面是文件:行）：

```text
godbg> bt
 └─ cmd/debug/backtrace.go:27                                命令层：Client.Backtrace + 打印
     └─ pkg/service/api/client.go:145 → pkg/service/debugger/debugger.go:431   契约 → 门面（深度 32）
         └─ pkg/proc/backtrace.go:30                         Target.Backtrace：逐帧循环
             ├─ pkg/proc/funcs.go:157                        FuncForPC(pc)
             ├─ pkg/proc/backtrace.go:86 → pkg/proc/variables.go:183 → pkg/dwarf/frame.go:57   CFA 规则
             └─ pkg/proc/variables.go:345                    readUint(CFA-8)
```

命令层只负责打印（`cmd/debug/backtrace.go:27`，省略了错误处理）：

```go
frames, err := Client.Backtrace()
for i, f := range frames {
    loc := ""
    if f.File != "" {
        loc = fmt.Sprintf(" %s:%d", f.File, f.Line)
    }
    fmt.Printf("%d: %s()%s (pc: %#x)\n", i, f.Function, loc, f.PC)
}
```

门面 `Debugger.Backtrace`（`debugger.go:431`）调 `d.t.Backtrace(32)`，把 `proc.Frame` 转成契约的 `api.Frame{PC, Function, File, Line}`（`pkg/service/api/types.go:112`），文件行号由 `PCToLine(f.PC)` 补齐；CFA 不在契约里，只是回溯的中间量。

#### 逐帧循环

核心只有十几行（`pkg/proc/backtrace.go:43`）：

```go
pc := regs.PC()
rsp := regs.Rsp

frames := []*Frame{}
for i := 0; i < maxDepth; i++ {
    fn, err := t.bi.FuncForPC(pc)
    if err != nil {
        break
    }
    // CFI 查询用 effectivePC（断点命中时按断点地址查询，
    // 见 effectivePC，ch9.2.39 排查结论）；帧显示保留真实 pc
    cfa, err := t.cfaForPCRSP(t.effectivePC(pc), rsp)
    if err != nil {
        break
    }
    frames = append(frames, &Frame{PC: pc, Fn: fn, CFA: cfa})

    // 调用者的返回地址保存在 CFA-8（go 调用约定）
    ra, err := t.readUint(cfa - 8)
    if err != nil || ra == 0 {
        break
    }
    pc, rsp = ra, cfa
}
```

四个退出条件对应四种"到栈底了"：`FuncForPC` 失败（PC 落在函数表之外，相邻函数之间的填充不属于任何函数）、`cfaForPCRSP` 失败（没有 FDE 覆盖该 PC）、`ra == 0`（go 的栈底哨兵，`runtime.goexit` 之上没有调用者）、以及到达 32 帧上限。

只有 `rsp` 参与 CFA 计算，是因为回溯上一帧时其他寄存器都是被调者保存的、尚未恢复：`cfaForPCRSP`（`backtrace.go:86`）只是把 `rsp` 塞进寄存器表再调 `cfaForPC`。`cfaForPC`（`variables.go:183`）查表后代入寄存器：规则是"寄存器+偏移"就返回 `base+offset`，是表达式形式（`DW_CFA_def_cfa_expression`）就用 `OpContext` 求值。表由 `BinaryInfo.FrameTable()`（`pkg/proc/bininfo.go:45`）解析一次并缓存（`sync.Once`），`.debug_frame` 交给 `dwarf.ParseFrame(data, 8)`；`pkg/dwarf/frame.go` 把每个 FDE 的指令流跑一遍状态机（`cfiState.run`，`frame.go:232`），只在 CFA 规则变化时记一行"地址 → 规则"，于是 `CFAForPC`（`frame.go:57`）退化为"找到覆盖 PC 的 FDE，取 `loc <= pc` 的最近一行"。

### 执行测试

断在 `loop` 的循环体后执行 `bt`（与 `backtrace` 等价；路径前缀、启动与线程状态行已省略）：

```bash
$ ./godbg exec _fixtures/loop
godbg> break main.go:16
breakpoint 1 added at 0x4b3971 (…/examples/debuggee/loop/main.go:16)
godbg> continue
> …/examples/debuggee/loop/main.go:16 (pc: 0x4b3972)
godbg> bt
0: main.main() …/examples/debuggee/loop/main.go:16 (pc: 0x4b3972)
1: runtime.main() …/src/runtime/proc.go:293 (pc: 0x440827)
2: runtime.goexit() …/src/runtime/asm_amd64.s:1701 (pc: 0x476ae1)
backtrace: 3 frame(s)
```

三帧正好对上 go 程序的启动链：`runtime.goexit` → `runtime.main` → `main.main`。把中间量打出来可以验证 `RA = *(CFA-8)`（以下是一次运行的实测，栈地址每次运行都不同）：

```bash
godbg> pregs
Rsp         0xc0000c0ee0
godbg> pmem 0xc0000c0ee0 --size 8 --count 20   # 只摘录第 3 行
0xc0000c0f60:   0x000000c000004380   0x000000c0000c0fd0   0x0000000000440827   0x000000c0000ba000
```

断点地址是 0x4b3971、停下时 PC=0x4b3972，所以 `effectivePC` 回退到 0x4b3971 查 FDE；`main.main` 在该 PC 上的规则是 `CFA = rsp+152`，即 `0xc0000c0ee0 + 0x98 = 0xc0000c0f78`，`CFA-8 = 0xc0000c0f70`——正是上表第 3 行第 3 个字 `0x440827`，等于 `bt` 第 1 帧的 PC。同一个 CFA 也是 9.2.33 里 `i` 的定位基准：`CFA-104 = 0xc0000c0f10` 处的值是 0，与 `print i` 一致。

冒烟脚本把上面的输出固化成了断言：`bash scripts/smoke.sh ch9.2.34` 打印 `smoke: running testdata/script/ch9.2.34.txt`，以 `smoke: all passed` 结束。

### 本节小结

`bt` 的实现可以概括成五步：读当前调试上下文的寄存器得 `pc`、`rsp`；断点命中时用 `pc-1` 查 CFI（显示仍用真实 PC）；在 `.debug_frame` 找到覆盖该 PC 的 FDE、取最近的 CFA 规则，代入寄存器得本帧 CFA；读 `*(CFA-8)` 得返回地址，`(pc, rsp) = (RA, CFA)`，回到第一步；返回地址为 0、PC 出函数表、或满 32 帧时结束。整套机制不依赖帧指针，也不扫描栈，代价是必须有一份可用的 `.debug_frame`。

未实现的部分（`docs/FEATURE-MATRIX.md` §5、§10.3）：`frame` 是桩，`up`/`down`、`deferred` 没有命令，所以 `bt` 只能看栈、不能切帧，`print` 也只能看当前帧的局部变量。还有一个已知的别名冲突：`cmd/debug/bt.go` 里的 `bt` 桩与 `backtrace` 的 `bt` 别名重名。命令注册顺序由文件名决定，`backtrace.go` 在 `bt.go` 之前，cobra 匹配 name 或 alias 时取首个命中，于是 `bt` 实际走 `backtrace`、桩不可达——能用，但依赖注册顺序，属于已知问题（§11①）。

`bt` 的副产品是 CFA：9.2.39 的 `stepout` 就是取本帧 `CFA-8` 的返回地址再设临时断点；9.2.33 的变量求值则用同一个 CFA 作为 `DW_OP_call_frame_cfa` 的输入。两条链路在这里收口。
