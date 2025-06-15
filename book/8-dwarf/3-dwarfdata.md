## DWARF数据分类

DWARF (Debugging With Attributed Record Formats) 使用一系列数据结构来存储调试信息，这些信息允许调试器提供源代码级别的调试体验。核心概念是 **调试信息条目 (DIE, Debugging Information Entry)**，以及支持这些条目的关键表结构。

### DWARF DIEs

#### Tags & Attributes

DWARF 使用 **调试信息条目 (DIE, Debugging Information Entry)** 来表示程序中的各种构造，例如变量、常量、类型、函数、编译单元等。每个 DIE 包含以下关键元素：

- **Tag:** 一个标识符（例如 `DW_TAG_variable`，`DW_TAG_pointer_type`，`DW_TAG_subprogram`），指示DIE代表的程序构造的类型。 这些tag定义了DIE的语义。
- **Attributes:** 键值对，提供关于DIE的额外信息。例如，一个变量的DIE可能会有 `name`（变量名）, `type` (变量类型), `location` (变量在内存中的位置) 等属性。

#### DIEs之间的关系

- **Children:** DIE可以包含其他DIE作为其子节点。这些子节点构成了树形的层级结构，用于描述复杂的程序构造。 例如，一个编译单元中包含了定义的函数，而每一个函数又包含了函数参数、返回值以及其局部变量。Children DIEs在存储上紧跟在parent DIE之后，读取Children DIEs直到遇到一个null DIE对象表示结束。
- **Siblings**: DIE之间的引用还可以通过属性实现。例如，一个描述变量的DIE需要有属性指明其数据类型，即属性 `DW_AT_type`，它指向1个描述数据类型的DIE。这种层级关系允许DWARF描述复杂的类型和作用域结构。

DIEs之间建立了Children、Siblings这两个不同维度上的引用关系，实际上形成了一个巨大的树，为了减少存储时的存储占用，也设计了一些编码方式来应对。

#### DIEs的分类

根据DIEs描述数据类型的不同，大致可以分为：描述数据和数据类型的，描述函数和可执行代码的。

- 描述数据和数据类型：比如描述基本类型、组合类型，比如描述array、struct、class、union 和 interface 类型，比如描述 variable，比如描述变量所在的位置信息的位置表达式；
- 描述函数和可执行代码：比如描述函数 subprogram，比如描述编译单元 compilation unit；

### 重要表结构数据

为了支持源代码级别的调试，符号级调试器需要两张重要的表：行号表 (Line Number Table) 和调用栈信息表 (Call Frame Information)。

1. **行号表 (Line Number Table):** 建立了程序代码指令地址和源文件位置（file:line:col）之间的映射关系，它通常包含源文件名称、行号、列号、以及对应的指令地址。通过这里的映射表，允许调试器调试期间将当前执行到的位置（PC）转换为源代码中的位置进行显示；调试器参照此表可以将源码位置转换为内存指令地址，并在指令地址处添加断点，使我们可以用源文件位置添加断点。|

   行号表中记录了如下细节信息，使我们可以做更多事情:

   - 对一个函数，指示函数序言 (prologue) 和函数结尾 (epilogue) 的指令，可以据此绘制函数的callgraph。
   - 对一行源码，可能包含一个或多个表达式、语句，对应多条指令，它能指示第一条指令的位置，以在准确位置添加断点。
2. **调用栈信息表 (Call Frame Information):**  允许调试器根据指令地址确定其在调用栈上的栈帧。这对于跟踪函数调用和理解程序的执行流程至关重要。它记录了执行时指令地址PC，与当前的 "栈指针SP" 和 "帧指针FP" 的值，以及返回地址。

为了减小上述表的存储占用，DWARF 使用状态机和字节码指令来编码这些表。这些指令指示状态机如何处理行号信息和栈帧信息，从而避免了冗余数据的存储。调试器加载这些编码后的数据，并将其交给状态机执行，状态机的输出结果就是调试器所需要的表。这种编码方式显著减少了调试信息的大小，使得DWARF能够在各种平台上使用。

### 其他DWARF数据

除此之外，DWARF中还有些其他数据，比如加速查询用的数据（Accelerated Access）、宏信息（Macro Information)等。

### 本文小结

本文简单介绍了DWARF调试信息中我们打交道最多的几类数据，DIE是对不同程序构造的描述，而行号表、调用栈信息表则是对程序执行时静态视图、动态视图的一种体现，还有些其他用途的DWARF数据。OK，接下来，将先介绍如何使用DIE对不同程序构造进行描述。

### 参考文献

1. DWARF, https://en.wikipedia.org/wiki/DWARF
2. DWARFv1, https://dwarfstd.org/doc/dwarf_1_1_0.pdf
3. DWARFv2, https://dwarfstd.org/doc/dwarf-2.0.0.pdf
4. DWARFv3, https://dwarfstd.org/doc/Dwarf3.pdf
5. DWARFv4, https://dwarfstd.org/doc/DWARF4.pdf
6. DWARFv5, https://dwarfstd.org/doc/DWARF5.pdf
7. DWARFv6 draft, https://dwarfstd.org/languages-v6.html
8. Introduction to the DWARF Debugging Format, https://dwarfstd.org/doc/Debugging-using-DWARF-2012.pdf
