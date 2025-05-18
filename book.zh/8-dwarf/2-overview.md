## DWARF内容概览

### 内容概览

大多数现代编程语言都采用块结构：每个实体（例如，类定义或函数）都包含在另一个实体中。一个 C 程序中的每个文件可能包含多个数据定义、多个变量定义和多个函数。在每个 C 函数中，可能有几个数据定义，再后面跟着可执行的语句列表。一个语句可能是一个复合语句，复合语句又可以包含数据定义和更简单的可执行语句。这创建了词法作用域，名称仅在定义它的作用域内可见。要在一个程序中找到特定符号的定义，首先在当前作用域中查找，然后在连续的封闭作用域中查找，直到找到该符号。在不同的作用域中，同一个名称可能有多个定义。编译器自然地将程序在内部表示为一棵树。

DWARF 遵循这种模型，它的调试信息条目（DIE) 本身也是块结构的。每个描述条目都包含在一个父级的描述条目中，并且可以包含子描述条目。一个节点也可能会包含1个或者多个兄弟描述条目。所以说，程序的 DWARF DIE数据也是一个树状结构，类似于编译器工作期间构建的语法树，其中每个节点都可以有子节点或兄弟节点。这些节点可以代表类型、变量或函数。

DWARF DIE可以以统一的方式进行扩展（比如扩展DIE的Tags、Attributes），以便调试器可以识别并忽略扩展，即使它可能不理解其含义。但这比大多数其他调试格式遇到不认识的数据时直接报致命错误要好多了。DWARF 的设计宗旨也是为了通过扩展来支持更多编程语言、更多特性，并且不受限于特定的架构、大小端限制。

除了上述DIE数据（.debug_info）以外，DWARF数据中还有一类数据也很重要，如行号表（.debug_line）、调用栈信息表 (.debug_frame)、宏信息 (.debug_macro)、加速访问表信息 (.debug_pubnames, .debug_pubtype,.debug_pubranges)等等。由于篇幅原因，难以在一个章节里面覆盖DWARF调试信息标准的所有细节，要知道单单DWARF v4内容就有325 pages。要更加深入细致地了解这部分内容，就需要阅读DWARF调试信息标准了。

虽然 DWARF 最初是设计出来用于 ELF 文件格式，但它在设计上支持扩展到其他文件格式。总的来说，现在DWARF是最广泛使用的调试信息格式，这得益于其标准化、完整性和持续演进。它不仅被主流编程语言采用，还在不断改进以适应新的需求。虽然存在其他调试信息格式，但DWARF凭借其优势成为了事实上的标准。

### 参考文献

1. DWARF, https://en.wikipedia.org/wiki/DWARF
2. DWARFv1, https://dwarfstd.org/doc/dwarf_1_1_0.pdf
3. DWARFv2, https://dwarfstd.org/doc/dwarf-2.0.0.pdf
4. DWARFv3, https://dwarfstd.org/doc/Dwarf3.pdf
5. DWARFv4, https://dwarfstd.org/doc/DWARF4.pdf
6. DWARFv5, https://dwarfstd.org/doc/DWARF5.pdf
7. DWARFv6 draft, https://dwarfstd.org/languages-v6.html
8. Introduction to the DWARF Debugging Format, https://dwarfstd.org/doc/Debugging-using-DWARF-2012.pdf
