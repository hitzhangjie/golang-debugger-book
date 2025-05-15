## 描述数据和类型

大多数编程语言都提供了对数据类型的描述，包括内置的基本数据类型和创建新数据类型的方法。 DWARF旨在支持所有编程语言，因此它抽象出了一种描述所有语言特性的解决方案。

DWARF根据机器硬件抽象出几种基本类型（数值类型），其他类型定义为基本类型的集合或组合。

### 基本类型

**DW_TAG_base_type，此tag可以用来描述多种基本类型，包括：二进制整数，压缩（packed）整数，地址，字符，定点数和浮点数。** 浮点数的编码格式（例如IEEE-754）由硬件决定。

DWARF v1和其他调试信息格式，都假定编译器和调试器需要对基本类型的大小有共同的了解，例如int是8位，16位还是32位。

对于不同的硬件平台和编程语言，现实中存在这样的事实：

- 相同语言在不同硬件平台上，数据类型相同的情况下，其尺寸可能也不同。一个int类型在16位处理器上可能是16位，而在32位处理器上可能是32位；
- 不同语言在相同的硬件平台上，数据类型相同的情况下，其尺寸也可能不同，如go语言int在64位处理器上为64位，而在C语言中为32位。

那么问题来了，如何将基本类型灵活地映射为不同的bitsize？ DWARF v2解决了此问题，它提供了一种低级映射方案，可以实现“**简单数据类型**”和“**目标计算机硬件上的实现**”之间的灵活映射。

**这里举几个例子来说明下:**

Figure 2a 定义类型 int 在32位处理器上是4字节有符号数, 图 2b 定义类型 int 在16位处理器上是2字节有符号数。

![img](assets/clip_image003.png)

图 3 定义类型word是16位有符号数值，但该类型实际占用4字节，但只有高位2个字节被使用，低位2个字节全部为0。

![img](assets/clip_image004.png)

> 注：上图示例取自DWARF v2，DWARF v4中已经废弃了DW_AT_bit_offset，而是用DW_AT_data_bit_offset代替。在DWARF v2、v3中该属性DW_AT_bit_offset用来表示big endian机器上的位字段，对little endian机器无用有点浪费。

### 复合类型

DWARF支持通过组合或者链接其他基本数据类型来定义新的数据类型。

Figure 5中，定义了一个变量px，其类型通过DW_AT_type=<2>引用另一个编号为<2>的DIE。

编号为<2>这个DIE的TAG为DW_TAG_pointer_type，说明它是一个指针类型，该DIE内部又通过Attribute DW_AT_type=<3>引用另一个描述数据类型的编号为<3>的DIE，<3>这个DIE的TAG为DW_TAG_base_type，表示它是一个基本数据类型，具体为4字节有符号整数。

这样，一连串分析下来，最终我们可以确定变量px是一个指向4字节位宽的指针，这个指针指向int整数，该int整数为4字节有符号整数。

![img](assets/clip_image005.png)

其他数据类型也可以通过链接多个DIE（DW_TAG…+DW_AT_type…）来定义一个新的数据类型，例如可以在DW_TAG_pointer_type基础上定义引用类型。

### 数组

**DW_TAG_array_type，结合一些相关attributes共同来描述数组。**

数组对应的DIE，该DIE包含了这样的一些属性来描述数组元素：

- **DW_AT_ordering**：描述数组是按照“**行主序**”还是按照“**列主序**”存储，如Fortran是按照列主序存储，C和C++是按照行主序存储。如果未指定该属性值，则使用DW_AT_language指定编程语言的默认数组排列规则；

- **DW_AT_type**：描述数组中各个元素的类型信息；

- **DW_AT_byte_stride/DW_AT_bit_stride**：如果数组中每个元素的实际大小和分配的空间大小不同的话，可以通过这两个属性来说明；

- **数组的索引值范围**，DIE中也需要通过指定最小、最大索引值来给出一个有效的索引值区间。这样DWARF就可以既能够描述C风格的数组（用0作为数组起始索引），也能够描述Pascal和Ada的数组（其数组最小索引值、最大索引值是可以变化的）。

  数组维度一般是通过换一个TAG为**DW_TAG_subrange_type**或者**DW_TAG_enumeration_type**的DIE来描述。

- 其他；

通过上述这些属性以及描述数组维度相关的DIE，来共同明确描述一个数组。

### Struct, Classe, Union, and Interface

大多数编程语言都允许通过组合多种不同的数据类型来定义一个新的数据类型，DWARF中也需要支持对这种能力的描述。
DWARF中分别使用如下TAG来描述上述几种类型（每种TAG有各自的一套Attributes）：

- **DW_TAG_structure_type**，描述结构体struct；
- **DW_TAG_class_type**，描述类class；
- **DW_TAG_union_type**，描述联合union；
- **DW_TAG_interface_type**，描述interface；

struct允许组合多个不同类型的成员。C语言中联合union也允许这样做，但是不同的成员共享相同的存储空间。C++ struct相比C语言又增加了一些特性，允许添加一些成员函数。C++中class和Java中interface在某种程度上是非常相似的程序实体。

不同语言一般都有相似的组合数据类型，只是取的名字可能不同，比如C++中叫class和class members（类和类成员），在Pascal中叫Record和Fields（记录和字段）。DWARF抽象这些描述时也要选个合适的名字，DWARF中采用了C++中的术语。

描述class的DIE是描述该class members的DIEs的父级DIE，每个class都有一个名字和可能的属性（成员）。如果class实例的大小在编译时可以确定，描述class的DIE就会多一个属性DW_AT_byte_size。class及class member的描述与基本数据类型描述的方式并没有太大的不同，可能会增加一些其他的描述信息，如class member的访问修饰符。

C\C++中也支持结构体位字段，即struct中多个成员可以共享同一个字节，只是不同的成员可以使用位数不同的相邻的比特。需要通过多个属性来描述，DW_AT_byte_size描述结构体实际占用多少个字节，属性DW_AT_bit_offset和DW_AT_bit_size描述位字段实际占用哪些比特，从第几个bit开始存储，一共占用多少个比特。

由于这几种类型所描述程序构造的差异，肯定要为其定义对应的一些Attributes才能精确地描述这些程序构造。由于篇幅原因，就不一一列举这些TAG各自的Attributes了。

> 感兴趣的话，您可以参考DWARF v4的 $5.5章节来详细了解。

### 变量

**DW_TAG_variable，用来描述变量**，前面我们有展示一个指针变量的例子。

变量通常非常简单。变量有名称，即变量名。变量名代指存储变量值的内存（或寄存器）。 变量的类型描述了包含的值及其是否可以修改的修饰（例如const）。

对变量进行区分的两个要素是变量的**存储位置**和**作用域**。

- 一个变量可以被存储在全局数据区（.data section）、栈、堆或者寄存器中；
- 变量的作用域，描述了它在程序中什么时候是可见的，某种程度上，变量作用域是由其声明时的位置确定的。DWARF中通过三元组（文件名，行号，列号）对变量声明位置进行描述；

> 前面讲过ELF文件符号表时，一个变量也有对应的符号。
>
> - 符号中有个name字段，它指向字符串表.strtab的某个位置，通过它能获取到变量的“标识符（变量名）”；
> - 符号中还有个value字段，它记录了变量在内存中的内存地址，结合这个符号中记录的变量的数据类型，就可以获取到变量值；
>
> DWARF中DW_TAG_variable和符号表中的符号，有异曲同工之妙。当我们在调试器中通过`p <varnae>`打印变量值时，就需要用到这个变量的TAG及Attributes来获取其值。

### 位置信息

DWARF提供了一种非常通用的机制描述如何确定变量的数据位置，就是通过属性**DW_AT_location**，该属性允许指定一个操作序列，来告知调试器如何确定数据的位置。

下面是一个示例，展示DW_AT_location如何辅助定位变量数据的地址：

![img](assets/clip_image006.png)

图 7描述了，变量b定义在寄存器中，变量c存储在栈上，变量a存储在固定地址（.data section中）。

调试信息必须为调试器提供一种方法，使其能够查找程序变量的位置、确定动态数组和字符串的范围，以及能找到函数栈帧的基地址或函数返回地址的方法。 此外，为了满足最新的计算机体系结构和优化技术的需求，调试信息必须能够描述对象的位置，还需要注意的是，该对象的位置可能会在对象的生命周期内发生变化（如Java GC时会在内存中迁移对象）。

通过location来描述程序中某个对象的位置信息，位置描述可以分为两类：

- **位置表达式（Location expressions）**，是与语言无关的寻址规则表示形式，它是由一些基本构建块、操作序列组合而成的任意复杂度的寻址规则。 只要对象的生命周期是静态的（static）或与拥有它的词法块相同，并且在整个生命周期内都不会移动，它们就足以描述任何对象的位置。
- **位置列表（Location lists）**，用于描述生命周期有限的对象或在整个生命周期内可能会更改位置的对象。

#### 位置表达式

位置表达式由零个或多个位置操作组成。 如果没有位置运算表达式，则表示该对象在源代码中存在，但是在目标代码中不存在，可能是由于编译器优化给优化掉了。

位置操作可以划分为两种类型，寄存器名，地址操作，下面分别介绍。

##### 寄存器名

寄存器名称始终单独出现，并指示所引用的对象包含在特定寄存器中。

请注意，寄存器号是DWARF中特定的数字到给定体系结构的实际寄存器的映射。`DW_OP_reg${n} (0<=n<=31)` 操作编码了32个寄存器, 该对象地址在寄存器n中. `DW_OP_regx` 操作有一个无符号LEB128编码的操作数，该操作数代表寄存器号。

##### 地址操作

地址操作是存储器地址计算规则。 所有位置操作都被编码为操作码流，每个操作码后跟零个或多个操作数。 操作数的数量由操作码决定。

每个寻址操作都表示**栈架构机器上的后缀操作**。

- 栈上每个元素，是一个目标机器上的地址的值；
- 执行位置表达式之后，栈顶元素的值就是计算结果（对象的地址，或者数组长度，或者字符串长度）。

对于结构体成员地址的计算，在执行位置表达式之前，需要先将包含该成员的结构体的起始地址push到栈上。

**位置表达式中的地址计算方式，主要包括如下几种：**

1. **寄存器寻址**  

   寄存器寻址方式， 计算目标寄存器中的值与指定偏移量的和，结果push到栈上：

   -   DW_OP_fbreg \$offset, 计算栈基址寄存器 (rbp)中的值 与 偏移量 $offset的和；

   - DW_OP_breg\${n} \${offset}, 计算编号n的寄存器中的值 与 偏移量$offset（LEB128编码）的和；
   - DW_OP_bregx \${n} \${offset}, 计算编号n（LEB128编码）的寄存器中的值 与 偏移量 $offset（LEB128编码）的和；

2. **栈操作**

   以下操作执行后都会push一个值到addressing stack上：

   - DW_OP_lit\${n} (0<=n<=31), 编码一个无符号字面量值\${n}；
   - DW_OP_addr, 编码一个与目标机器匹配的机器地址；
   - DW_OP_const1u/1s/2u/2s/4u/4s/8u/8s, 编码一个1/2/4/8 字节 无符号 or 有符号整数；
   - DW_OP_constu/s, 编码一个 LEB128 无符号 or 有符号整数.

   以下操作会操作location stack，栈顶索引值为0：

   - DW_OP_dup, duplicates the top stack entry and pushes.
   - DW_OP_drop, pops the value at the top of stack.
   - DW_OP_pick, picks the stack entry specified by 1-byte ${index} and pushes.
   - DW_OP_over, duplicate the stack entry with index 2 and pushes.
   - DW_OP_swap, swap two stack entries, which are specified by two operands.
   - DW_OP_rot, rotate the top 3 stack entries.
   - DW_OP_deref, pops the value at the top of stack as address and retrieves data from that address, then pushes the data whose size is the size of address on target machine.
   - DW_OP_deref_size, similar to DW_OP_deref, plus when retrieveing data from address, bytes that’ll be read is specified by 1-byte operand, the read data will be zero-extended to match the size of address on target machine.
   - DW_OP_xderef & DW_OP_xderef_size, similar to DW_OP_deref, plus extended dereference mechanism. When dereferencing, the top stack entry is popped as address, the second top stack entry is popped as an address space identifier. Do some calculation to get the address and retrieve data from it, then push the data to the stack.

3. **算术和逻辑运算**

   DW_OP_abs, DW_OP_and, DW_OP_div, DW_OP_minus, DW_OP_mod, DW_OP_mul, DW_OP_neg, DW_OP_not, DW_OP_or, DW_OP_plus, DW_OP_plus_uconst, DW_OP_shl, DW_OP_shr, DW_OP_shra, DW_OP_xor, 这些操作工作方式类似，都是从栈里面pop操作数然后计算，并将结果push到栈上。

4. **控制流操作**

   以下操作提供对位置表达式流程的简单控制：

   - 关系运算符，这六个运算符分别弹出顶部的两个堆栈元素，并将顶部的第一个与第二个条目进行比较，如果结果为true，则push值1；如果结果为false，则push值0；
   - DW_OP_skip，无条件分支，其操作数是一个2字节常量，表示要从当前位置表达式跳过的位置表达式的字节数，从2字节常量之后开始；
   - DW_OP_bra，条件分支，此操作从栈上pop一个元素，如果弹出的值不为零，则跳过一些字节以跳转到位置表达式。 要跳过的字节数由其操作数指定，该操作数是一个2字节的常量，表示从当前定位表达式开始要跳过的位置表达式的字节数（从2字节常量开始）；
   
5. **特殊操作**

   DWARF v2中有两种特殊的操作（DWARF v4中是否有新增，暂时先不关注）：

   - DW_OP_piece, 许多编译器将单个变量存储在一组寄存器中，或者部分存储在寄存器中，部分存储在内存中。 DW_OP_piece提供了一种描述特定地址位置所指向变量的哪一部分、该部分有多大的方式；
   - DW_OP_nop, 它是一个占位符，它对位置堆栈或其任何值都没有影响；

##### 操作示例

上面提到的寻址操作都是些常规描述，下面是一些示例。

- 栈操作示例

![img](assets/clip_image007.png)

- 位置表达式示例

  以下是一些有关如何使用位置运算来形成位置表达式的示例。

​					![img](assets/clip_image008.png)


#### 位置列表

如果一个对象的位置在其生命周期内可能会发生改变，就可以使用位置列表代替位置表达式来描述其位置。位置列表包含在单独的目标文件部分 **.debug_loc** 中。

一个对象的位置列表的位置，是由.debug_loc中该对象位置列表的起始字节相对于.debug_loc起始位置的偏移量来指示的。

位置列表中的每一项包括:

- 起始地址，相对于引用此位置列表的编译单元的基址，它标记该位置有效的地址范围的起始位置；
- 结束地址，它还是相对于引用此位置列表的编译单元的基址而言的，它标记了该位置有效的地址范围的结尾；
- 一个位置表达式，它描述对象在起始地址和结束地址指定的范围内的位置；

位置列表以一个特殊的list entry标识列表的结束，该list entry中的起始地址、结束地址都是0，并且没有位置描述。

>DWARF v5会将.debug_loc和.debug_ranges替换为.debug_loclists和.debug_rnglists，从而实现更紧凑的数据表示，并消除重定位。

### 了解更多

- Types of Declarations, 请参考 DWARF v2 章节3.2.2.1 和 章节3.2.2.2；
- Accessibility of Declarations, 有些语言提供了对对象或者其他实体的访问控制，可以通过指定属性 DW_AT_accessibility 来实现, 可取值 DW_ACCESS_public, DW_ACCESS_private, DW_ACCESS_protected；
- Visualbility of Declarations, 指定声明的可见性，声明是否在其它模块中可见，还是只在当前声明模块中可见，可以通过指定属性 attribute DW_AT_visualbility 来实现, 可取值 DW_VIS_local, DW_VIS_exported, DW_VIS_qualified；
- Virtuality of Declarations, C++提供了虚函数、纯虚函数支持，可以通过指定属性 DW_AT_virtuality 来实现, 可取值 DW_VIRTUALITY_none, DW_VIRTUALITY_virtual, DW_VIRTUALITY_pure_virtual；
- Artificial Entries, 编译器可能希望为那些不是在程序源码中声明的对象或类型添加调试信息条目，举个例子，C++中类成员函数（非静态成员），每个形式参数都有一个形参描述条目，此外还需要多加一个描述隐式传递的this指针；
- Declaration coordinates, 每个描述对象、模块、函数或者类型的DIE（调试信息条目）都会有下面几个属性 DW_AT_decl_file、DW_AT_decl_line、DW_AT_decl_column，这几个属性描述了声明在源文件中出现的位置；

