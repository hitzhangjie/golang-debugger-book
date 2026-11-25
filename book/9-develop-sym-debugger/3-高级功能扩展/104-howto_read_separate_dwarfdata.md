## 扩展阅读：分离式 DWARF 数据的查找机制（godbgv2 未实现）

> **状态**：godbgv2 未实现（❌）。本节为扩展阅读，设计思路可迁移，代码不并入本仓。
> 能力状态以 `godbgv2/docs/FEATURE-MATRIX.md` 为准。

### 概述

DWARF（Debugging With Attributed Record Formats）是一种广泛使用的调试数据格式，它提供了关于程序结构、变量和执行流程的详细信息。在Linux/AMD64平台上，调试信息通常直接嵌入在ELF文件本身中，但在某些平台和构建配置中，DWARF数据可能会被单独存储。

本节讨论的是后一种情况，但重点不是“怎么解析 DWARF”——那是第 7、8 章的事——而是**调试器怎么先找到那份 DWARF**：主二进制里留给调试器的线索有哪些（`.gnu_debuglink`、`.note.gnu.build-id`），调试文件按什么规则命名和摆放，查找顺序如何，以及 `.dwo`/`.dwp` 为什么不属于同一套机制。

最后一节交代 godbgv2 的现状：目前它只认内嵌在 ELF 里的 `.debug_*` 节，上面这些机制**一个都没有实现**，属于 `godbgv2/docs/FEATURE-MATRIX.md` §7 标记的 ❌。

### Linux/amd64 平台：内嵌是常态

在Linux/AMD64系统上，调试信息通常直接存储在ELF（Executable and Linkable Format）文件中。这是最常见和最直接的方法，其中：

1. 调试信息在构建过程中被编译到二进制文件中
2. DWARF数据存储在ELF文件的特殊节中（例如：`.debug_info`、`.debug_line`、`.debug_abbrev`）
3. 调试器可以直接访问这些信息，无需定位单独的文件

这种方法对于Linux/AMD64上的大多数开发场景来说既简单又高效：调试器打开一个文件就够了，不用维护“二进制 ↔ 调试文件”的对应关系。

不过“内嵌是默认”不等于“内嵌是必然”。发行版为了控制体积、也为了避免把源码路径、变量名这些信息随程序一起分发，普遍会在打包时把调试信息剥出来单独发布；`strip` 也是发布流程里常见的最后一步。所以一个调试器只要面向真实环境（而不是只面向自己 `make` 出来的二进制），迟早要处理分离调试文件。

### 为什么 stripped 二进制需要分离的调试文件

`strip` 做的事很直接：把 `.debug_info`、`.debug_line`、`.debug_abbrev`、`.debug_str` 等节从 ELF 里删掉（`--strip-debug` 只删调试节，`--strip-all` 连符号表一起删）。删完之后：

1. 反汇编还能看，但看不出函数名，也看不出哪条指令对应哪个源文件哪一行；
2. 变量名、类型、栈帧信息全部消失，`bt` 退化成地址列表，`print x` 无从谈起；
3. go 程序还能靠 `.gopclntab` 拿到一部分函数名与行号，但变量、类型、结构体布局依然没有。

于是只有两条路：要么保留调试信息（二进制变大，而且会把构建机的源码路径带进发布件）；要么把调试信息存到另一个文件，并在主二进制里留下“去哪找、找哪个”的线索。后者就是**分离调试文件**（separate debug info）。

常见场景包括：

1. **发行版包**：Linux 发行版通常把调试信息剥出来，放进独立的 `-dbgsym`/`debuginfo` 包里；
2. **构建系统配置**：某些构建系统被配置为生成单独的调试文件，以减小主二进制文件的大小；
3. **发布与留档分离**：对外发布 stripped 二进制，调试信息留在构建产物仓库或符号服务器上，线上出问题时再取回来；
4. **体积敏感的场景**：容器镜像、嵌入式目标，主程序越大越吃亏。

在本节实测的小程序里（go1.26.7，`func main` 空循环），默认构建的可执行文件约 1.8MB，`objcopy --only-keep-debug` 拆出的调试文件约 0.6MB，strip 后的主程序约 1.2MB——调试信息约占三分之一，量级并不小。

### 分离调试文件的命名与位置

**命名约定**：

- `binary.debug`：GNU 生态最常见，`objcopy` 的用法习惯，本节示例都用它；
- `binary.dbg`：部分工具链/平台的叫法；
- `binary.dwo`：**不属于这一类**，它是 split-DWARF 的产物，见后文。

**位置约定**（调试器会去找的地方）：

1. 与可执行文件**同目录**；
2. 与可执行文件同目录的 **`.debug/` 子目录**；
3. 专用调试目录树，按可执行文件的**绝对路径镜像**：`/usr/bin/program` → `/usr/lib/debug/usr/bin/program.debug`；
4. **build-id 布局**：`/usr/lib/debug/.build-id/ab/cdef....debug`，把文件名换成内容摘要。

第 3 种就是常说的“镜像路径”：调试目录是这个文件系统的一个影子根。第 4 种完全不依赖文件名，后文会讲。

### 主二进制里的两条线索

#### `.gnu_debuglink`：文件名 + CRC32

`objcopy --add-gnu-debuglink=<debug file>` 会往主二进制里写入一个 `.gnu_debuglink` 节，内容只有两样东西：

1. 调试文件的**文件名**（注意：只有 basename，不含目录路径），以 `\0` 结尾，并补齐到 4 字节边界；
2. 紧随其后的 4 字节 **CRC32**（IEEE 802.3 多项式，小端），算的是整个调试文件。

文件名不含路径，所以调试文件必须落在前面列的“约定位置”里，随便塞到别处是找不到的；CRC32 则是给“同名但版本不同”兜底的——调试器和二进制必须来自同一次构建，CRC 不匹配的候选文件要丢弃。delve 找到候选文件后就是用 `crc32.ChecksumIEEE` 重算一遍再比对（`pkg/proc/bininfo.go` 的 `openSeparateDebugInfo`）。

实测（本机 Oracle Linux 8.5，binutils 2.30）：

```text
$ objcopy --only-keep-debug app app.debug
$ strip --strip-debug --strip-unneeded app
$ objcopy --add-gnu-debuglink=app.debug app

$ readelf -x .gnu_debuglink app

Hex dump of section '.gnu_debuglink':
  0x00000000 6170702e 64656275 67000000 1b2a3b00 app.debug....*;.
```

前 12 字节是文件名 `app.debug`（9 字节）+ 一个 `\0` + 2 字节填充；最后 4 字节 `1b 2a 3b 00` 按小端读作 `0x003b2a1b`，正好等于对 `app.debug` 整文件算出的 CRC32（IEEE），可以自己用 Go 的 `crc32.ChecksumIEEE` 核对。

#### `.note.gnu.build-id`：构建指纹，拼出固定路径

`.note.gnu.build-id` 是链接器写入 ELF 的构建指纹（默认 SHA-1，20 字节）。查找方式和文件名无关：把 build-id 的十六进制串拆成“前 2 位 / 其余部分”，拼成

```text
/usr/lib/debug/.build-id/<前2位>/<其余>.debug
```

好处是**内容寻址**：不同程序、不同版本天然不会撞名，也不需要调试文件与主程序同名。发行版更愿意用这种布局（例如 Debian 的 `-dbgsym` 包就装在这个位置）。

一个常见的误解是“只有 C/C++ 程序才有 build-id”。实测 go1.26.7 的默认构建就带这个节：`readelf -x .note.gnu.build-id` 能看到 `GNU` owner 的 note，`file` 会显示 `BuildID[sha1]=...`。所以 go 程序同样可以先按 build-id 去找调试文件——当然，这取决于工具链版本，读者可以用同样的命令自查。

#### 两者的关系

- `.note.gnu.build-id` 是“内容 → 路径”，不需要校验，路径里就带着内容摘要；
- `.gnu_debuglink` 是“文件名 → 路径 + CRC 校验”，多一步校验，但允许调试文件叫任意名字（只要和节里记录的一致）。

GDB 两套都支持，顺序是先 build-id、再 debuglink；delve 的实现也是这个顺序，只是把两套之外还保留了几个历史遗留的兜底路径。

### 查找顺序：以 GDB 的约定为准

对每个需要符号的 ELF，调试器大致按下面的顺序找它的分离调试文件：

1. **build-id**：在“调试目录”列表里找 `<dir>/.build-id/xx/yyy.debug`；
2. **debuglink**：先在可执行文件同目录找 `<debuglink 里的文件名>`，再找 `同目录/.debug/<该文件名>`，最后在每个调试目录里按“可执行文件目录的镜像路径 + 文件名”找；
3. 找到后**校验 CRC32**，不匹配就当作没找到；
4. 仍然找不到，且系统配置了 debuginfod，就按 build-id 远程下载（见后文）。

这里的“调试目录”通常指 `/usr/lib/debug`，可以由 gdb 的 `set debug-file-directory` 指定，也可以由调试器自己的配置项追加。delve 的实现在 `openSeparateDebugInfo`（`pkg/proc/bininfo.go:1574`），它的目录列表来自配置项 `debug-info-directories`，默认值是 `["/usr/lib/debug/.build-id"]`（`pkg/config/config.go:264`）。

> **口径提醒**：`debug-info-directories` 是 **delve 的配置项**，不是 godbgv2 的——godbgv2 连 `pkg/config` 都不存在。本节与 9.3.107 的配置清单都按“delve 的口径”叙述，不代表本仓支持这些配置。

### split-DWARF：`.dwo` / `.dwp` 不是同一机制

这两个后缀经常和 `.debug` 一起出现在“分离调试信息”的讨论里，但它们解决的是另一个问题：

1. **`.dwo`**：编译期由 `-gsplit-dwarf`（gcc/clang）产生，把每个编译单元的 DIE 拆到独立文件，主二进制里只留一个“骨架”编译单元（skeleton CU），用 `DW_AT_GNU_dwo_name`（DWARF4 的 GNU 扩展）或 `DW_AT_dwo_name`（DWARF5）指向 `.dwo` 文件，`DW_AT_comp_dir` 给出目录。目的是减少链接期内存、便于并行/增量编译。
2. **`.dwp`**：把多个 `.dwo` 打包成一个文件（`dwp` 工具），DWARF5 用 `.debug_cu_index`/`.debug_tu_index` 做索引，避免调试器按 `.dwo` 一个个打开。
3. **区别**：分离调试文件（`.debug`）解决的是“主二进制里根本没有调试信息，要去别处找”；split-DWARF 解决的是“调试信息被拆成了多份、怎么组织”。前者的线索是 `.gnu_debuglink`/build-id，后者的线索是骨架 CU 里的文件名字段。

go 工具链没有 `-gsplit-dwarf` 这类选项，不产生 `.dwo`；所以对本书的目标（go 程序、linux/amd64）来说，`.dwo`/`.dwp` 更像背景知识，真正要处理的是 `.debug` + build-id/debuglink。

### debuginfod：按 build-id 远程取

debuginfod 是 elfutils 提供的一个 HTTP 服务：客户端把 build-id 报上去，服务端返回对应的 debuginfo、可执行文件或源码。典型用法是发行版维护一个公共实例，用户设置 `DEBUGINFOD_URLS` 后，gdb 在本地找不到调试文件时自动去下载。

- 客户端工具是 `debuginfod-find`，带本地缓存（`~/.cache/debuginfod_client`）；
- delve 是通过调用 `debuginfod-find` 子进程实现的（`pkg/proc/debuginfod/debuginfod.go`），本地找不到时最后再试这一步；
- 对调试器的意义：本机没装 `-dbgsym` 包也能拿到符号；代价是网络依赖、缓存管理和“同一次调试结果不可复现”的风险。

### godbgv2 现状：未实现（❌）

godbgv2 目前只解析**目标 ELF 自带**的 `.debug_*` 节：

- 调试信息只从目标 ELF 里取：`BinaryInfo.DWARF()` 直接返回 `elf.File.DWARF()`，行号表来自 `elf.File.Section(".debug_line")`（`pkg/proc/bininfo.go`）；`pkg/dwarf/` 只负责解析这些已经拿到的节数据，没有第二个文件的概念；
- `pkg/proc/funcs.go:24` 的注释写得很直白：“假定二进制保留了 DWARF sections”；
- `cmd/debug.go:48` 用 `-compressdwarf=false` 构建调试目标，就是为了让这些节保持可读；
- 代码里没有 `.gnu_debuglink` 解析、没有 `.note.gnu.build-id` 查找、没有 `/usr/lib/debug` 搜索、没有 debuginfod、没有 `.dwp`。`godbgv2/docs/FEATURE-MATRIX.md` §7 把“分离 DWARF / debuginfod”记为 ❌，§10.3 把它列进“真空白”。

实测（godbg v0.8.0）：把一个 go 程序 strip 掉、并按上一节的办法加上 `.gnu_debuglink`，再执行 `godbg exec`，只摘录相关行：

```text
godbg> bt
backtrace: 0 frame(s)
godbg> list
Error: section .debug_line not found
```

同一个程序不 strip 时，`bt` 能正常回溯。注意：把 `app.debug` 放在同目录也不会有帮助——godbgv2 里没有读 `.gnu_debuglink` 的代码，这个文件不会被打开。

**如果要做，需要补什么**：

1. **节解析**：读 `.gnu_debuglink`（文件名 + CRC32）与 `.note.gnu.build-id`；
2. **路径策略**：同目录、`.debug/`、镜像路径、build-id 布局，以及一个可配置的“调试目录”列表；
3. **配置载体**：上面这个列表需要配置系统承载，而 godbgv2 只有 cobra flag（见 9.3.107）；
4. **双文件合并**：分离文件里只有调试节，代码节和地址仍在主二进制里。delve 的做法是保留两个 `elf.File` 句柄——`dwarfFile` 读调试节、`elfFile` 提供代码地址（`pkg/proc/bininfo.go:1738-1793`），godbgv2 的 `BinaryInfo` 现在只有一个 `elf.File`，这一步比“找文件”更难；
5. **测试夹具**：用 `objcopy` 造出 stripped + debuglink 的 ELF 与对应的 `.debug`，断言“只有调试文件时 `bt`/`list` 仍可用”；
6. **错误信息**：至少在“二进制被 strip 且找不到调试文件”时给出可操作的提示，而不是现在这句 `section .debug_line not found`。

### 结论

1. 对 linux/amd64 上的本地开发，内嵌 DWARF 足够用，不必为“分离”做任何事；
2. 一旦面对发行版二进制、容器镜像或体积敏感的分发物，就绕不开 `.gnu_debuglink`、`.note.gnu.build-id` 和调试目录这套约定；
3. `.dwo`/`.dwp` 是 split-DWARF，和分离调试文件不是一回事，别混着讲；
4. godbgv2 目前只支持内嵌调试信息，本节内容属于扩展阅读；它也是 9.3.107 配置系统、105 路径映射之外，又一个“知道原理、但没有实现”的典型例子。

### 参考

1. [GDB: Separate Debug Files](https://sourceware.org/gdb/onlinedocs/gdb/Separate-Debug-Files.html)
2. [GNU Binutils: objcopy（`--only-keep-debug`、`--add-gnu-debuglink`）](https://sourceware.org/binutils/docs/binutils/objcopy.html)
3. [DWARF5 标准（split-DWARF 与 `.dwo`）](https://dwarfstd.org/doc/DWARF5.pdf)
4. delve 的实现：`pkg/proc/bininfo.go` 的 `openSeparateDebugInfo`、`pkg/config/config.go` 的 `DebugInfoDirectories`、`pkg/proc/debuginfod/debuginfod.go`
5. godbgv2 的能力矩阵：`godbgv2/docs/FEATURE-MATRIX.md`（§7 符号与 DWARF、§10.3 真空白）
