## 发展历史

DWARF调试信息标准，主要是面向开发者的，用以指导如何生成、如何消费调试信息，具体就是编译器、链接器开发者需要参考DWARF标准来生成调试信息，而调试器开发者需要参考DWARF来消费调试信息。我们先不妨了解下DWARF调试信息标准的发展史。

DWARF 并不是最早的调试信息格式。在它之前，stabs、COFF、OMF、IEEE-695 等格式各自解决过一部分问题，也都没能成为跨平台的标准；这段前史见附录 12.16。下面只梳理 DWARF 自身的版本演进。

### DWARF v0 (1988)

DWARF调试信息标准的发展，离不开DWARF调试信息标准委员会的大力支持。DWARF调试信息标准委员会最初成立于1988年，本来是Unix International，Inc.的编程语言特殊兴趣小组（PLSIG），其初衷是为了促进Unix System V Release 4（SVR4）的发展。1988年，Bell实验室设计了DWARF调试信息格式用于SVR4。后面PLSIG起草了DWARF标准的v1版本，DWARF调试信息格式从此开始了真正的标准化之路。

### DWARF v1 (1992/10)

PLSIG起草了DWARF标准的v1版本，该标准与AT&T的SVR4编译器和调试器当时使用的DWARF调试格式兼容。1992年10月，DWARF v1.1.0发布，作为一个新生儿，该版本问题较多，难以被认可、接受。

### DWARF v2 (1993/07)

1993年7月，DWARF v2.0.0发布。

DWARF v1版本中，生成的调试信息占存储空间很大，DWARF v2版本中增加了多种编码格式对数据进行压缩。DWARF v2 和v1相比，有一定改进，但因为DWARF v2与v1不兼容，业内人士认为其问题较多，还算不上成熟。

DWARF v2依然没有立即获得广泛的接纳，一方面因为DWARF仍是个新生儿，另一方面与Unix International宣布解散有关。委员会没有收到或处理任何行业评论，也没有发布最终标准。后来，委员会邮件列表由OpenGroup（以前称为XOpen）托管。

那时候Sun公司决定采用ELF作为Solaris平台上的文件格式，DWARF本来是为ELF设计的调试信息格式，但Sun并没有将DWARF作为首选调试信息格式，而是继续使用Stabs（stabs in elf）。那时候Linux也是一样的做法，这种情况一直持续到20世纪90年代才发生改变。

### DWARF v3 (2005/12)

DWARF委员会于1999年10月进行了重组，并在接下来的几年中解决DWARF v2中存在的问题，并添加一些新功能。 在2003年中，该委员会成为Free Standards Group （自由标准组，FSG）的工作组，该组织是为促进开放标准而成立的行业联盟。 经过行业审查和评论后，DWARF v3于2005年12月发布。

该版本增加了对Java、C++ namespace、Fortran 90等的支持，也增加了一些针对编译器、链接器的优化技术。例如调用帧信息（Call Frame Information，CFI）用 CIE（Common Information Entry）的 return_address_register 字段指明返回地址保存在哪个寄存器里，该字段用无符号 LEB128 编码，能有效压缩小整数占用的空间。

### DWARF v4 (2010/06)

DWARF委员会于2007年2月从FSG（Free Standards Group）退出，当时FSG与Open Source Development Labs合并组建了Linux Foundation，该基金会更侧重于推广Linux。 自那时以来，DWARF委员会一直处于独立的状态。

DWARF委员会的意见是，从DWARF v2或v3迁移到更高版本应该是简单易行的。 在DWARF v4中，几乎所有DWARF v2和v3的关键设计都保持不变。

2010年，DWARF委员会发布了DWARF v4，该版本的焦点围绕在改善数据压缩、更好地描述编译器优化后代码、增加对C++新特性的描述支持等。

### DWARF v5 (2017/02)

DWARF 委员会始终对“有源码级调试和调试格式经验、有兴趣推动或扩展 DWARF”的编译器和调试器开发者保持开放态度。

2017年，DWARF v5发布，该版本在很多方面都做了改善、提升，包括更好的数据压缩、调试信息与可执行程序的分离、对macro和源文件的更好的描述、更快速的符号搜索、对编译器优化后代码的更好描述，以及其他功能、性能上的提升。

DWARF 也是 Go 语言工具链使用的调试信息格式。Go 早期生成的是 DWARF v2（go1.8 及更早），从 go1.9 起改用 v4，此后再没变过，一直用到 go1.24。

把时间线摊开看，v4 的“在位”时间相当长：标准 2010 年 6 月发布，v5 虽然 2017 年 2 月就发布了，但 GCC 直到 11（2021 年）、Clang 直到 14（2022 年）才把默认版本切到 v5，之前默认产出的都是 v4；Go 则一直用到 go1.24。也就是说，v4 作为“默认生成”的版本前后撑了十年以上，是 DWARF 历史上生命周期最长、存量二进制里最常见的一版，这也是本书以它作基线的原因之一。

go1.25（2025 年 8 月）起，Go 编译器和链接器默认生成 DWARF v5（darwin/ios、aix 例外，仍保持 v4），可以用 GOEXPERIMENT=nodwarf5 回退到 v4，go1.26 继续沿用这一策略——本书初稿动笔时 Go 还停在 go1.12，如今已经走到 go1.26，跨度可见一斑。本书第一版按 go1.24 + DWARF v4 来写：第 8、9 章的读取层、示例和工具输出都以 v4 为准；v5 在 section 组织（新增 .debug_addr，用 .debug_rnglists/.debug_loclists 取代 .debug_ranges/.debug_loc）和数据编码上都有变化，读取层要相应调整，这部分留待后续版本再补。用 go1.25 及之后工具链的读者，可以对照附录 12.6 的版本矩阵确认自己产物的版本。

### DWARF v6 working draft (2023/12)

DWARF v4 在存量二进制里仍然是最常见的一版，但新工具链已经普遍切到 v5；与此同时，DWARF v6 也在路上了。委员会从 2023 年 6 月起把 v6 的工作草案公开出来（快照链接见 dwarfstd.org 首页），不过它目前仍处在草案阶段、随时可能变化，本书先不介绍。

### 参考文献

1. DWARF, https://en.wikipedia.org/wiki/DWARF
2. DWARFv1, https://dwarfstd.org/doc/dwarf_1_1_0.pdf
3. DWARFv2, https://dwarfstd.org/doc/dwarf-2.0.0.pdf
4. DWARFv3, https://dwarfstd.org/doc/Dwarf3.pdf
5. DWARFv4, https://dwarfstd.org/doc/DWARF4.pdf
6. DWARFv5, https://dwarfstd.org/doc/DWARF5.pdf
7. DWARFv6 draft, https://dwarfstd.org/languages-v6.html
8. Introduction to the DWARF Debugging Format, https://dwarfstd.org/doc/Debugging-using-DWARF-2012.pdf
