## DWARF内容概览

### 内容概览

大多数现代编程语言都采用块结构：每个实体（例如，类定义或函数）都包含在另一个实体中。一个 C 程序中的每个文件可能包含多个数据定义、多个变量定义和多个函数。在每个 C 函数中，可能有几个数据定义，再后面跟着可执行的语句列表。一个语句可能是一个复合语句，复合语句又可以包含数据定义和更简单的可执行语句。这创建了词法作用域，名称仅在定义它的作用域内可见。要在一个程序中找到特定符号的定义，首先在当前作用域中查找，然后在连续的封闭作用域中查找，直到找到该符号。在不同的作用域中，同一个名称可能有多个定义。编译器自然地将程序在内部表示为一棵树。
 
DWARF 遵循这种模型，它本身也是块结构的。DWARF 中的每个描述实体（除了描述源文件的顶级条目）都包含在一个父级的描述条目中，并且可以包含子描述实体。一个节点也可能会包含1个或者多个兄弟实体。程序的 DWARF 描述是一个树状结构，类似于编译器工作期间构建的语法树，其中每个节点都可以有子节点或兄弟节点。这些节点可以代表类型、变量或函数。

DWARF这里的树状结构，这是一种紧凑的格式，仅提供描述程序某个方面所需的信息。该格式可以以统一的方式进行扩展，以便调试器可以识别并忽略扩展，即使它可能不理解其含义。（这比大多数其他调试格式的情况要好得多，在这些格式中，调试器在尝试读取未识别的数据时会发生致命错误）。DWARF 的设计也旨在可以扩展以描述几乎任何编程语言，而不仅仅是描述一种语言或一种语言的版本，并且不受限于特定的架构、大小端限制。
 
虽然 DWARF 最初是设计用于 ELF 文件格式，但它与文件格式无关，而且它已经被用于其他文件格式。

### 参考文献

1. DWARF, https://en.wikipedia.org/wiki/DWARF
2. DWARFv1, https://dwarfstd.org/doc/dwarf_1_1_0.pdf
3. DWARFv2, https://dwarfstd.org/doc/dwarf-2.0.0.pdf
4. DWARFv3, https://dwarfstd.org/doc/Dwarf3.pdf
5. DWARFv4, https://dwarfstd.org/doc/DWARF4.pdf
6. DWARFv5, https://dwarfstd.org/doc/DWARF5.pdf
7. DWARFv6 draft, https://dwarfstd.org/languages-v6.html
8. Introduction to the DWARF Debugging Format, https://dwarfstd.org/doc/Debugging-using-DWARF-2012.pdf
