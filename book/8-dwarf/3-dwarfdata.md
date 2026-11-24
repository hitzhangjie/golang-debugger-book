## DWARF数据分类

DWARF (Debugging With Attributed Record Formats) 使用一系列数据结构来存储调试信息，这些信息允许调试器提供源代码级别的调试体验。核心概念是 **调试信息条目 (DIE, Debugging Information Entry)**，以及支持这些条目的关键表结构。

### DWARF DIEs

#### Tags & Attributes

DWARF 使用 **调试信息条目 (DIE, Debugging Information Entry)** 来表示程序中的各种构造，例如变量、常量、类型、函数、编译单元等。每个 DIE 由 tag 和一组属性构成：

- **Tag:** 一个标识符（例如 `DW_TAG_variable`、`DW_TAG_pointer_type`、`DW_TAG_subprogram`），指明这个 DIE 描述的是哪一类程序构造，也就是 DIE 的类别（DWARF 标准中称为 class；不少资料也把这里的“类别”称作“类型”，注意不要和数据类型混淆）。标准按 tag 分别描述各类 DIE 的语义，并列出通常适用的属性；不同 tag 的 DIE，适用的属性集合通常不同。但这些属性列表只是参考性的（标准一般并不强制某条 DIE 必须带哪些属性），生产者可以只给出其中一部分，也可以附带标准未列出的属性——一条 DIE 实际带哪些属性，最终由缩写表决定。因此更准确的说法是：tag 说明 DIE 的类别，tag 与属性一起才构成一条 DIE 的完整含义。
- **Attributes:** 一组“属性名 + 属性值”的键值对，用来补充 DIE 的具体信息。属性名是 `DW_AT_*` 形式的枚举，例如变量的 DIE 通常带 `DW_AT_name`（变量名）、`DW_AT_type`（所属类型）、`DW_AT_location`（位置）。属性名只说明“表示什么”，属性值的编码形式（`DW_FORM_*`）同样重要：同一个属性在不同 DWARF 版本或不同编译器下可能选用不同的 form（定长整数、LEB128、字符串表偏移等），解析时不能根据属性名猜宽度。一条 DIE 出现哪些属性、各用什么 form，由所属编译单元的缩写表（abbreviation table）声明，必须以缩写表为准（详见 8.4.4）。

#### DIEs之间的关系

- **Children:** 一个 DIE 可以包含子 DIE，用层级结构描述复杂的程序构造。例如编译单元中包含定义的函数，函数又包含参数、返回值和局部变量。同一编译单元的 DIE 树在 `.debug_info` 中按前序（prefix order）扁平存储：父 DIE 的属性之后紧跟着它的第一个子 DIE；只有缩写表声明为“有子节点”的 DIE 才带子节点列表，列表以一条 null entry（缩写码为 0，既没有 tag 也没有属性）结束。
- **Siblings:** 同一个父 DIE 下的子 DIE 互为兄弟，在存储上依次相邻。兄弟关系由存储次序决定，不是通过属性建立的。DIE 还可以通过属性值引用其他 DIE：例如变量 DIE 的 `DW_AT_type` 指向描述其类型的 DIE，这类引用可以指向同一编译单元内的 DIE，也可以跨编译单元（`DW_FORM_ref_addr`）。`DW_AT_sibling` 是另一种特殊属性，它给出下一个兄弟 DIE 的偏移，生产者可以借此让消费者跳过当前 DIE 的整棵子树；它只是遍历加速手段，不改变树的结构。

在一个编译单元内，父子/兄弟关系构成一棵树；如果把这些属性引用也算上，DIE 之间就是一个有向图，而且可能存在环——例如 `struct S { struct S *next; }` 中，结构体 DIE 的成员指向指针类型 DIE，指针类型 DIE 又通过 `DW_AT_type` 指回该结构体 DIE。所以“DIE 树”只是在父子关系这个维度上成立。DWARF 用前序扁平存储来表示这棵树，引用用偏移表示，并配合缩写表等编码手段来控制体积（见 8.4.4）。

#### DIEs的分类

从使用者的角度，可以按 DIE 描述的对象大致归类（标准本身是按 tag 逐个定义各类 DIE 语义的）：

- 描述数据和数据类型：基本类型（`DW_TAG_base_type`），数组、结构体、类、联合、指针、接口等复合类型（`DW_TAG_array_type`、`DW_TAG_structure_type`、`DW_TAG_class_type`、`DW_TAG_union_type`、`DW_TAG_pointer_type`、`DW_TAG_interface_type`），typedef 等类型别名（`DW_TAG_typedef`），以及变量（`DW_TAG_variable`）、常量（`DW_TAG_constant`）等。变量的位置由 `DW_AT_location` 属性给出（没有该属性、或属性值为空时，说明变量在目标代码中没有可计算的位置，常见于被优化掉或只有声明的情况），属性值是一个位置描述：对象在生命周期内位置固定时，通常用一个位置表达式（location expression）描述；位置会变化（或只在部分地址区间存在）时，则用位置列表（location list）。位置表达式和位置列表都是 `DW_AT_location` 的取值形式，不是一类 DIE。
- 描述函数和可执行代码：函数（`DW_TAG_subprogram`）、形式参数（`DW_TAG_formal_parameter`）、词法块（`DW_TAG_lexical_block`）等。

此外还有用于组织作用域和层级的 DIE，例如编译单元（`DW_TAG_compile_unit`）、模块（`DW_TAG_module`）、命名空间（`DW_TAG_namespace`）、导入单元（`DW_TAG_imported_unit`）等。它们本身不描述数据或代码，更像容器；编译单元 DIE 是一个编译单元内所有 DIE 的根，并通过 `DW_AT_stmt_list` 关联到本单元的行号表。

### 重要表结构数据

除了 DIE 树，符号级调试器最常用的还有两类辅助数据：行号表 (Line Number Table) 和调用帧信息 (CFI, Call Frame Information)。

1. **行号表 (Line Number Table):** 建立机器指令地址和源文件位置（file:line:col）之间的映射。每一行记录包含指令地址、文件（文件表中的索引）、行号、列号，以及 `is_stmt`、`basic_block`、`end_sequence`、`prologue_end`、`epilogue_begin` 等标志。调试器据此把当前 PC 反查成源码位置（“执行到哪一行”），也可以反过来按 `file:line` 找到地址下断点；行号表是按地址组织的，按 `file:line` 反查需要调试器扫描或预先建立索引。

   其中几个标志对调试器尤其重要：

   - `prologue_end` / `epilogue_begin`（DWARF v3 引入）：标记函数序言结束、函数后记（epilogue）开始的位置。调试器据此把函数入口断点设在序言之后，避免在栈帧尚未建立时就中断；`epilogue_begin` 则用于设置函数退出断点。行号表只记录源码位置与指令地址的对应，不包含调用边，不能用来绘制 callgraph。
   - `is_stmt`：标记“推荐的断点位置”，通常对应一条语句的起始指令。但一行源码可能对应多条指令，也可能出现多条记录（例如同一行有多个语句，或优化后同一行的代码被拆分到多个位置）；调试器应优先选择带 `is_stmt` 的记录，而不是无条件取该行的第一条指令。

2. **调用帧信息 (CFI, Call Frame Information):** 描述“在某个指令地址处，如何计算当前帧的 CFA（Canonical Frame Address，规范帧地址）、以及如何恢复各个寄存器（包括返回地址）”，从而支持调试器从当前寄存器现场逐帧虚拟展开调用栈。CFI 给出的是一组按地址区间生效的规则（rule），不是运行时寄存器值的快照：例如 CFA 由某个寄存器加偏移算出，返回地址、被调用者保存（callee-saved）寄存器分别位于 CFA 附近的哪个位置，或者存放在哪个寄存器里。调试器把 PC 代入规则，就能恢复调用者的栈指针 SP、帧指针 FP 和返回地址，展开到任意一层栈帧。CFI 通常存放在 `.debug_frame` 中，由 CIE（Common Information Entry）和若干 FDE（Frame Description Entry）组成（详见 8.5.3）。

行号表和 CFI 都没有按“一条指令一行”直接存储，而是编码成状态机可执行的字节码程序（行号表程序、CFI 指令序列）。相邻记录的字段大多相同，用增量编码和操作码可以显著压缩体积；调试器也可以按编译单元或函数按需展开，不必预先解析整张表。加载这些编码数据后，交给对应的状态机执行，得到的是行号矩阵或在指定地址处生效的展开规则。

### 其他DWARF数据

除此之外，DWARF 还有一批辅助数据：加速查询用的 `.debug_aranges`、`.debug_pubnames`/`.debug_pubtypes`（DWARF v5 起用 `.debug_names` 取代后两者），宏信息 `.debug_macro`/`.debug_macinfo`，字符串表 `.debug_str`，以及范围列表 `.debug_ranges`/`.debug_rnglists`、位置列表 `.debug_loc`/`.debug_loclists` 等。它们大多为 DIE 数据提供间接引用（字符串、范围、位置），或者是可选的查询加速结构，详见 8.5。

### 本节小结

本节把 DWARF 数据按用途分成几类：DIE 树描述程序的静态结构（类型、变量、函数、作用域），行号表把机器指令映射回源码位置，CFI 描述运行时的栈帧布局与寄存器恢复规则；此外还有加速查询、宏、字符串表等辅助数据。接下来，我们将先介绍 DIE 如何描述不同的程序构造。

### 参考文献

1. DWARF, https://en.wikipedia.org/wiki/DWARF
2. DWARFv1, https://dwarfstd.org/doc/dwarf_1_1_0.pdf
3. DWARFv2, https://dwarfstd.org/doc/dwarf-2.0.0.pdf
4. DWARFv3, https://dwarfstd.org/doc/Dwarf3.pdf
5. DWARFv4, https://dwarfstd.org/doc/DWARF4.pdf
6. DWARFv5, https://dwarfstd.org/doc/DWARF5.pdf
7. DWARFv6 draft, https://dwarfstd.org/languages-v6.html
8. Introduction to the DWARF Debugging Format, https://dwarfstd.org/doc/Debugging-using-DWARF-2012.pdf
