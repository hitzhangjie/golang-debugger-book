## 扩展阅读：dlv 为什么从 .symtab 读取 TLS 符号

7.3 节提到：dlv 的符号级调试主路径是 DWARF，但加载 ELF 时仍会读取 .symtab，其中一项用途是取 `runtime.tlsg`（x86-64）或 `runtime.tls_g`（arm64），用来计算 g 指针相对于线程 TLS 的偏移。

这看起来有点矛盾：DWARF 连变量、类型、行号都有，为什么算一个 TLS 偏移还要回头查符号表？本附录把这件事拆开讲。

### g 指针为什么在 TLS 里

g 是 Go 的“当前 goroutine”指针，每个线程各有一个。调试器 attach 到某个线程后，要读该线程的 g，就得先知道它存在哪里。

- 纯 Go、内部链接：Go runtime 自己约定 g 的位置。linux/amd64 上是 `%fs-8`，386 上是 `-4(tls)`，不需要任何符号；
- cgo/外部链接：TLS 布局由 libc 和外部链接器决定，Go 不能再假设固定偏移，只能请链接器在 TLS 块里放一个符号，运行时再按符号算偏移。

x86-64 上这个符号叫 `runtime.tlsg`，arm64 上叫 `runtime.tls_g`。它们都是链接期才确定的信息，而不是 Go 源码里的变量。

### 符号的值就是偏移量

（go1.24.6、linux/amd64、cgo 程序实测；示例里的 C 函数只用于触发外部链接）

先用 C 代码触发外部链接，构建出的可执行文件里可以看到：

```bash
$ readelf -sW app | grep tlsg
  1840: 0000000000000000     8 TLS     LOCAL  DEFAULT   22 runtime.tlsg
```

`runtime.tlsg` 是 `.tbss` 里的 TLS 符号，`Value` 是它在 TLS 段内的偏移；这个例子里它正好是第一个槽位，所以是 0。光有符号还不够，还要结合 TLS 段头：

```bash
$ readelf -lW app | grep TLS
  TLS            0x0f9de8 0x00000000006f9de8 0x00000000006f9de8 0x000000 0x000008 R   0x8
```

这里要用到的是 `Vaddr`、`Memsz`、`Align` 三个字段。x86-64 的线程指针 FS 指向 TLS 块的**末尾**，TLS 变量在它的负方向；把按 `Vaddr/Align` 对齐后的段大小减掉，再加上符号在段内的偏移，就是 g 的偏移（delve 里的 `memsz` 就是这个对齐后的值）：

```
gStructOffset = -memsz + tlsg.Value = -8 + 0 = -8
```

arm64 的约定不同：TPIDR_EL0 指向 TCB，TCB 占两个指针，所以 Go 链接器在应用 TLS 重定位时要补上这 16 字节：

```go
// src/cmd/link/internal/arm64/asm.go
// The TCB is two pointers. This is not documented anywhere, but is
// de facto part of the ABI.
v := ldr.SymValue(rs) + int64(2*target.Arch.PtrSize)
```

delve 的 `setGStructOffsetElf` 分别镜像这两套约定（[bininfo.go:1936](https://github.com/hitzhangjie/delve/blob/50b8d4189fc63defeb362dc7b0f2b767363e8b3e/pkg/proc/bininfo.go#L1936-L1992)）：x86-64 走 `-memsz + tlsg.Value`（`memsz` 已按 `Vaddr/Align` 对齐），arm64 走 `tlsg.Value + 2*ptrSize + 对齐修正`。符号找不到时，它退回架构默认值（x86-64 是 `-ptrSize`，arm64 是 `2*ptrSize`）；所以把 .symtab strip 掉，不是完全不能调试，而是 cgo 程序的 TLS 偏移可能算错。反过来，纯 Go 构建的程序里通常根本没有 `PT_TLS`，delve 直接用默认值。

### 为什么 DWARF 和 .gopclntab 里没有

先说结论：**不是 DWARF 格式表达不了**。DWARF 有 `DW_OP_form_tls_address`，GCC/Clang 给 C/C++ 的 `__thread` 变量就是这么描述“TLS 基址 + 偏移”的。问题在于 Go 的 DWARF 生产链里根本没有这个符号的输入。

Go 的 DWARF 不是编译器直接写 section，而是分两段生成：

1. 编译器为 Go 源码级全局变量生成 `SDWARFVAR` 符号（[dumpGlobal](https://github.com/golang/go/blob/go1.24.6/src/cmd/compile/internal/gc/obj.go#L145-L161) → [DwarfGlobal](https://github.com/golang/go/blob/go1.24.6/src/cmd/internal/obj/dwarf.go#L401-L414)），把 DIE 内容写进去，再通过 aux 挂到对应的数据符号上；
2. 链接器的 `dwarf.go` 遍历数据符号，用 `GetVarDwarfAuxSym` 取出编译器挂好的 DIE，汇总编码成 `.debug_info`。

`runtime.tlsg`/`runtime.tls_g` 在这条链路的每一步都过不了：

| 链接器的条件                                          | runtime.tlsg / runtime.tls_g                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| 是 Go 源码级全局变量（编译器才会调用 `dumpGlobal`） | 不是，来自汇编 `GLOBL ... TLSBSS`                               |
| 有 Go 类型（`SymGoType != 0`）                      | 没有                                                              |
| 不是 file-local 符号                                  | 是 local，链接器明确跳过 “local symbols in assembler src files” |
| 有编译器生成的 varDIE                                 | 没有                                                              |

有个细节值得注意：链接器的数据符号遍历**是包含 `STLSBSS` 的**（[dwarf.go:1970](https://github.com/golang/go/blob/go1.24.6/src/cmd/link/internal/ld/dwarf.go#L1954-L2008)）——TLS 符号并没有被类型过滤掉，而是死在后面的“没有 Go 类型 / 没有 varDIE”两步。链接器只负责汇总和编码编译器给出的 DIE，不会凭空造一个。

`.gopclntab` 更不用提：它只描述函数和行号，不描述变量，也不描述 TLS 符号。

所以这个偏移只存在于 ELF 层：`.symtab` 里的符号值，加上 `PT_TLS` 段头。delve 中这么实现纯粹是因为没有别的获取来源。

### 顺带：strip 掉 .symtab 后，反汇编还有函数名吗

这个问题经常和上面那个一起出现。dlv 反汇编取名字的顺序（[symLookup](https://github.com/hitzhangjie/delve/blob/50b8d4189fc63defeb362dc7b0f2b767363e8b3e/pkg/proc/bininfo.go#L3158-L3175)）是：

1. `PCToFunc`：Go 函数表。正常二进制来自 DWARF；DWARF 也被 strip 时，由 `.gopclntab` 填充；
2. 不是 Go 函数，才查 `.symtab` 里的 `STT_FUNC` 符号（[loadSymbolName](https://github.com/hitzhangjie/delve/blob/50b8d4189fc63defeb362dc7b0f2b767363e8b3e/pkg/proc/bininfo.go#L1848-L1860)）；
3. 再退回 DWARF 描述的包级变量。

所以 strip 掉 `.symtab` 后，Go 函数在反汇编里仍然有名字；丢的是 DWARF / `.gopclntab` 覆盖不到的、原本就只在.symtab中存在的符号，典型的是 cgo 里的 C 函数：

```bash
$ readelf -sW app | grep ' hi$'
  1901: 000000000046b800    12 FUNC    LOCAL  DEFAULT   14 hi
```

`hi` 在 `.symtab` 里有名字，但 C 代码编译时没带 `-g`，DWARF 里没有它。strip 之后反汇编到这个地址，就只能显示地址了。

### 小结

| 问题                  | 答案                                                         |
| --------------------- | ------------------------------------------------------------ |
| TLS 偏移从哪里来      | 链接器布局 TLS 段时写进 ELF 符号的 `st_value`              |
| 为什么不用 DWARF      | Go 只为源级全局变量生成 `SDWARFVAR`，汇编 TLS 符号没有 DIE |
| 为什么不用 .gopclntab | 它只描述函数和行号                                           |
| strip 后还能调试吗    | Go 函数名仍有 DWARF/.gopclntab 兜底；TLS 偏移退回架构默认值  |
