## 扩展阅读：调试信息格式演进——从 stabs 到 DWARF

> 一句话：DWARF 不是第一种调试信息格式，也不是一出现就赢了。它赢在把“程序结构”而不只是“符号和行号”作为描述对象，并且用可扩展、与架构无关的方式标准化下来。

### 为什么会有这么多格式

CPU 只认识指令、寄存器和内存。调试信息是编译器和链接器额外写进目标文件的一份“旁注”，供调试器在源码和机器之间做翻译。写什么、写多细、放在哪，取决于三个条件：编译器、链接器和调试器是否出自同一家、对象文件格式能否装下这些数据、有没有人把它标准化。早期的工具链在这三件事上各自为政，于是几乎每种平台都长出了自己的格式。

### 一条粗略的时间线

| 时间 | 格式 | 主要载体/平台 | 结局 |
| --- | --- | --- | --- |
| 1980 年代 | stabs | a.out；后来的 ELF（`.stab`/`.stabstr`） | Unix 世界广泛使用，后被 DWARF 取代；GCC 13 停止生成 |
| 1981 | OMF | CP/M、DOS、OS/2；Intel 8086 | 只提供名称、行号等最基础信息 |
| 1980 年代（System V） | COFF | Unix System V；XCOFF、ECOFF 等变体 | 调试信息能力有限，常搭配 stabs；SVR4 转向 ELF |
| 1985 | CodeView | MS-DOS/Windows；PE-COFF | 微软私有格式，随 PDB 延续至今 |
| 1990 | IEEE-695 | 嵌入式工具链 | 成为 IEEE 标准，但使用范围很小 |
| 1992 起 | DWARF v1–v5 | ELF 及其他对象格式 | 成为事实标准；v6 草案仍在推进 |

### stabs：借用符号表的调试信息

“stabs” 是 symbol table strings 的缩写：它最初不新增调试 section，而是把调试信息编码成特殊格式的字符串，塞进符号表。a.out 没有为调试信息预留位置，这既是 stabs 的起点，也是它的限制——它必须借用符号表，解析规则靠约定，而不是一份独立的标准文档。

stabs 最初很简单，后来 Sun 和 GCC 各自加扩展，GCC 甚至要逆向 Sun 的扩展才能兼容。结果是：能表达的东西越来越多（类型、作用域、行号、宏），变体也越来越多，文档却长期匮乏。它没有正式标准，却因为 GCC、BSD、Solaris 的广泛使用而活了很久；Linux 和 Solaris 都出现过 stabs-in-ELF。直到 DWARF 成熟，GCC 才逐步转向 DWARF：GCC 12 将 stabs 标记为废弃，GCC 13（2023 年 4 月）移除了 `-gstabs`/`-gxcoff`。

### COFF：名字叫 Common，调试信息却不 common

COFF（Common Object File Format）是 AT&T 在 Unix System V 中引入的对象文件格式，用来替代能力不足的 a.out；System V Release 3 使用的就是它，之后的 XCOFF（IBM RS/6000）、ECOFF（MIPS、Alpha）都是它的变体。COFF 的主要进步是支持任意命名 section，调试信息因此可以作为独立 section 存放，也可以容纳 stabs 这类外部格式。

但 COFF 自带的调试信息很有限：符号名、地址和行号，缺少对头文件、复杂类型和作用域的描述，设计上也不可扩展。现实中的实现大多会超出原规范、各自加扩展，这也让“Common”名不副实。SVR4 最终用 ELF 取代了 COFF；COFF 在 Unix 世界退居二线，但它的 Windows 分支以 PE-COFF 的形式活了下来。

### PE-COFF 与 CodeView：Windows 的私有路线

Windows NT 和 Windows 95 起，PE-COFF 成为 Windows 平台的主流对象和可执行文件格式。PE-COFF 可以携带 COFF 调试数据，也可以携带微软自己的 CodeView（CV）格式。CodeView 最早在 1985 年出现，随后随 Microsoft C 4.0 提供；CV4 规范的修订版标注于 1995 年 12 月。再往后，调试信息更多被拆到独立的 PDB 文件里，PE 中只留一个指向 PDB 的调试目录。

这条路线的问题不在技术能力，而在开放性：格式由微软控制，文档长期不完整，非微软工具链要实现 CodeView/PDB 读写，往往得靠逆向和社区整理。LLVM 的 CodeView/PDB 支持就是这么一点点补出来的。

### OMF：DOS 时代的最小支持

OMF（Object Module Format）由 Intel 在 1981 年为 8086 定义（Relocatable Object Module Format，v4.0），是 CP/M、DOS、OS/2 以及一些嵌入式系统的对象文件格式；DOS 用户熟悉的 `.OBJ` 就是它。OMF 定义了调试器可用的公共名称和行号信息，也能嵌入 Microsoft CV、IBM PM 或 AIX 格式的调试数据，但它对调试的支持停留在最基础的一层：没有完整的类型系统，也没有跨模块的统一描述。16 位平台退场后，OMF 也跟着退出主流。

### IEEE-695：标准有了，生态没跟上

IEEE-695 由 Microtec Research 和 HP 在 1980 年代末为嵌入式环境联合开发，1990 年成为 IEEE 标准，全称是 “IEEE Standard for Microprocessor Universal Format for Object Modules”（简称 MUFOM）。它采用块结构，能更好地反映源码的组织方式，设计上几乎适配任何机器架构。

但它更像一份“被标准化了的专有格式”：Microtec 为支持 C++ 和优化代码做的扩展没有完整记录，也没有并入后续标准；IEEE 标准本身长期未更新。结果是标准存在、实现很少，使用范围限于少数小型处理器。它说明了一件事：有标准不等于有生态。

### 它们共同的问题

把上面几种格式放在一起看，问题高度相似：

1. **标准缺位，或者有标准也没有生态**：要么没有标准，要么标准只管对象文件、不管调试信息，或者像 IEEE-695 那样标准存在但实现寥寥；格式变体和扩展各自为政。
2. **与对象文件格式强耦合**：调试信息怎么存，取决于 a.out/COFF/OMF 能提供什么；换平台就要重做。
3. **表达能力不足**：大多只描述符号名、地址和行号，缺少类型、作用域、内联和优化后代码的映射。
4. **私有扩展、文档缺失**：厂商扩展不公开，后来的工具链只能逆向。
5. **工具链各自为政**：编译器、链接器、调试器往往来自同一家，对象格式也随之绑定，迁移成本高，生态难以复用。

### DWARF 为什么胜出

DWARF 最早由 Bell Labs 为 System V 的 sdb 调试器开发，1992 年由 PLSIG 标准化为 DWARF v1。它的设计正好对着上面几条：

- **描述程序结构，而不只是符号**：DIE 树用 Tag/Attribute 描述编译单元、类型、变量、函数和作用域，能表达嵌套作用域和复杂类型；行号表负责源码位置，CFI 负责栈帧展开。
- **可扩展**：新的 Tag、Attribute、Form 可以加进标准，旧解析器遇到不认识的条目可以跳过，不会直接失败。
- **与对象格式、架构、语言解耦**：最初为 ELF/SVR4 设计，但数据模型不依赖 ELF；也不绑定某一种处理器或语言。
- **标准化**：DWARF 委员会维护版本化规范，工具链有共同的目标。
- **生态正循环**：GCC、Clang、Go 等编译器生成 DWARF，GDB、LLDB、Delve 等调试器消费 DWARF。

DWARF 官方 FAQ 对“DWARF 比 stabs 强在哪”有一段很直接的回答：DWARF 是块结构、可扩展的程序描述，能描述不连续作用域、栈结构和栈展开；而 stabs 依赖预定义的符号和类型定义，表达能力受限，也不容易扩展。这段话基本概括了前面那些格式被取代的原因。

当然，DWARF 也不是没有代价：调试信息体积大、优化后代码的映射复杂、不同版本和扩展之间存在兼容性问题。这些正是第8章后续要处理的内容。

### 小结

- DWARF 之前，stabs、COFF、PE-COFF/CodeView、OMF、IEEE-695 各自解决过一部分问题，但都没能同时做到标准化、跨平台和足够强的表达能力。
- 它们的共同短板是：标准缺位或没有生态、与对象文件格式耦合、描述能力停留在符号和行号、私有扩展与文档缺失。
- DWARF 用 DIE 树描述程序结构，用行号表和 CFI 描述源码位置与栈帧，并以可扩展、与架构/语言无关的方式标准化，最终成为事实标准。

第8章不要求读者记住这些历史格式的细节；知道“DWARF 之前有哪些尝试、它们共同卡在哪、DWARF 为什么能成为事实标准”就够了。后面各节只围绕写一个 Go 符号级调试器需要用到的 DWARF 子集展开。

### 参考文献

1. Michael Eager, Introduction to the DWARF Debugging Format, 2012, https://dwarfstd.org/doc/Debugging-using-DWARF-2012.pdf
2. DWARF FAQ, https://dwarfstd.org/faq.html
3. stabs, Wikipedia, https://en.wikipedia.org/wiki/Stabs
4. COFF, Wikipedia, https://en.wikipedia.org/wiki/COFF
5. Object Module Format (Intel), Wikipedia, https://en.wikipedia.org/wiki/Intel_Object_Module_Format
6. IEEE 695-1990, IEEE Xplore, https://ieeexplore.ieee.org/document/159333
7. CodeView, WinWorld, https://winworldpc.com/product/codeview/2x
8. GCC 13 changes, https://gcc.gnu.org/gcc-13/changes.html
9. DWARF specifications, https://dwarfstd.org/doc/
