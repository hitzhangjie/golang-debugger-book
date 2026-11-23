## 文件地址、链接地址与运行时地址

在调试器里说“地址”时，至少要区分三个东西：

| 名称 | 通常在哪里看到 | 是否随进程而变 |
| --- | --- | --- |
| 文件偏移（file offset） | `readelf -S` 的 `Off` 列、`readelf -l` 的 `Offset` 列 | 否 |
| 链接地址（link-time VMA） | `readelf -l` 的 `VirtAddr`、`nm` 的符号值、DWARF 的 `DW_AT_low_pc` | 否 |
| 运行时地址（runtime VA） | `/proc/<pid>/maps`、寄存器 `PC`、`x/i $pc` 的结果 | 是 |

编译器、链接器生成符号表和 DWARF 时，写入的是**链接地址**；调试器在进程里读到的 `PC`、栈上的返回地址，是**运行时地址**。对非 PIE 的 `ET_EXEC`，两者通常相等；对 PIE（`ET_DYN`）和共享库，两者之间差一个**装载偏置（load bias）**：

```text
运行时地址 = 链接地址 + load_bias
```

这个偏置由内核和动态链接器在装载时决定，每次运行都可能不同。调试器如果不知道它，就会把断点下到错误的地址，把行号表查到错误的位置，把调用栈展开成一片乱码。

### 为什么调试器绕不开它

我们前面实现的指令级调试器只认地址：`break *0x4b85af`。到了符号级调试，用户输入的是 `break main.main`、`break main.go:19`，调试器要先把这些符号换成地址，再去 patch 指令。这一步如果漏掉 load bias，会出现几种很典型的症状：

- **断点打不上**：把 `int3` 写到链接地址上，但那个地址在进程里根本没有映射，`ptrace(PTRACE_POKETEXT)` 直接失败；或者它恰好落在别的映射里，程序跑飞。
- **断点永不命中**：写到了错误的页，进程照常执行，调试器却一直等不到 `SIGTRAP`。
- **源码位置错乱**：DWARF 行号表里的 `DW_LNE_set_address` 记录的是链接地址，而当前 `PC` 是运行时地址，查表自然查不到，或者查到相邻函数上。
- **调用栈展开失败**：`.debug_frame` 的 FDE 用链接地址描述指令范围，栈上的返回地址是运行时地址，`FDEForPC` 找不到对应的 FDE，`bt` 只能打印一层。
- **全局变量读错**：DWARF 的 `DW_OP_addr` 里放的是全局变量的链接地址，直接拿它读内存，读到的可能是别的对象。

所以，load bias 不是“链接器知识”，而是调试器地址转换层的核心状态。第 9 章里 `BinaryInfo.StaticBase`、`DwarfRegisters.StaticBase` 这些字段，承载的就是它。

### 主程序：用 AT_ENTRY 算

对主程序，最省事、最可靠的办法是读进程的辅助向量（auxiliary vector）里的 `AT_ENTRY`，再和 ELF 文件头里的 `e_entry` 相减：

```text
load_bias = AT_ENTRY - e_entry
```

`AT_ENTRY` 是内核实际转入的入口地址（运行时地址），`e_entry` 是链接时写进 ELF 文件头的入口地址（链接地址），两者相减就是装载偏置。对非 PIE 的 `ET_EXEC`，这两个值相等，偏置为 0；对 PIE，偏置就是内核选定的装载基址。

Linux 上可以通过 `/proc/<pid>/auxv` 读到辅助向量，它是若干组 `(type, value)` 的二进制对，`AT_ENTRY` 的类型值是 9。调试器 attach 之后读一次即可；如果是 `exec` 启动的进程，也可以在 `exec` 停住后读。

`AT_PHDR`（类型值 3）也可以用来交叉验证。`AT_PHDR` 是程序头表在进程里的地址，程序头表的链接地址可以由第一个 `PT_LOAD` 的 `p_vaddr`、`p_offset` 和 ELF 头的 `e_phoff` 算出来：

```text
phdr_link_addr = p_vaddr + (e_phoff - p_offset)   // 对包含程序头表的那个 PT_LOAD
load_bias      = AT_PHDR - phdr_link_addr
```

对常见的 PIE，第一个 `PT_LOAD` 满足 `p_offset = 0`、`p_vaddr = 0`，于是 `phdr_link_addr = e_phoff`，`load_bias = AT_PHDR - e_phoff`。这两个结果应该一致；不一致通常说明读错了段，或者程序在运行中被 `dlopen` 之类的操作改变了映射，值得停下来查一查。

### 共享库：link_map 或 /proc/pid/maps

共享库不是主程序的一部分，`AT_ENTRY` 只描述主程序。要拿共享库的 load bias，有两条路：

1. **走动态链接器的 `link_map`**。`DT_DEBUG` 指向 `r_debug`，`r_debug.r_map` 是一条 `link_map` 链表，每个节点描述一个已装载的 ELF 对象，`l_addr` 就是该对象的装载偏置，`l_name` 是路径。glibc 还提供了 `dl_iterate_phdr()`，回调里的 `dlpi_addr` 也是同一个偏置，但调试器通常不方便在 tracee 里调用它，直接读 `link_map` 更常见。
2. **解析 `/proc/<pid>/maps`**。每个映射行给出地址范围、权限、文件偏移和路径。把同一个文件的映射按文件偏移排序，找到第一个 `offset = 0` 的映射；如果该对象第一个 `PT_LOAD` 的 `p_vaddr = 0`，这个映射的起始地址就是 load bias。更一般地，`映射起始地址 = load_bias + page_align_down(p_vaddr)`，需要按页对齐反推。

`link_map` 的好处是精确，坏处是要理解动态链接器的数据结构；`maps` 的好处是简单、对静态链接和 core 也适用，坏处是要处理页对齐和多个映射。实际调试器里两者常常互为补充：主程序用 `AT_ENTRY`，共享库优先 `link_map`，拿不到时退回 `maps`。

### core 文件与分离调试信息

core 文件里的 `PT_LOAD` 记录的是**运行时地址**，而可执行文件、分离的 `.debug` 文件里记录的是**链接地址**。用 core 调试时，load bias 仍然要算，只是 `AT_ENTRY` 不一定还在：可以从 core 的映射里找到可执行文件的第一个 `PT_LOAD`，再和 ELF 文件的 `p_vaddr` 对齐反推；也可以把 core 和可执行文件的段按大小、权限、文件偏移做匹配。

分离调试信息（`.gnu_debuglink`、`/usr/lib/debug/.build-id/...`）只是把 DWARF 从主文件里搬到了另一个文件，地址仍然是链接地址，load bias 仍然取自**运行时装载的那个二进制**，不能从 `.debug` 文件自己算。这一点在调试发行版 strip 过的程序时特别容易踩坑。

### 在调试器里怎么用

把 load bias 记在“模块”这一层，而不是散落在各个命令里：

- 每个被装载的 ELF 对象（主程序、共享库、插件）记录 `{path, link_addr_range, load_bias}`；
- 所有“符号 → 地址”的查询，先用符号表/DWARF 得到链接地址，再加 `load_bias` 得到运行时地址；
- 所有“运行时地址 → 源码/函数/栈帧”的查询，先减 `load_bias` 得到链接地址，再查行号表、DIE、FDE；
- 断点、单步、`list`、`bt`、`p` 全部走这一层，不要在命令实现里各自加加减减；
- `exec`、`attach`、`dlopen`、`core` 四种场景都要能更新这张模块表。

第 9 章实现 `BinaryInfo` 时，我们会把这张表落下来；`StaticBase` 就是主程序的 load bias，`DwarfRegisters.StaticBase` 则用于执行 `DW_OP_addr` 这类需要把链接地址转成运行时地址的表达式。

### 小结

文件地址、链接地址、运行时地址是三套坐标系。符号表和 DWARF 活在链接地址里，进程活在运行时地址里，调试器的符号层就是两者之间的换算层。load bias 是这套换算里最容易被忽略、又最容易让“断点打不上、源码对不上、栈展开不了”的元凶。把这一节看懂，后面第 8 章的 DWARF 地址、第 9 章的断点和栈展开，才不会变成一堆魔法数字。

> ps：本节只讨论 Linux/ELF 的常见情形。静态 PIE、`-Ttext-segment` 指定非零基址、以及某些嵌入式加载器会让“`ET_EXEC` 偏置为 0”不再成立，但“运行时地址 = 链接地址 + 偏置”这个关系始终成立，遇到时按同样的方法算即可。
