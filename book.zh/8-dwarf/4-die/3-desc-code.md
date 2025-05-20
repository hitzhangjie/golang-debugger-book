## 描述可执行代码

前面介绍了DIE如何描述数据和类型的，也了解了如何对数据位置进行描述，这个小节继续看下如何描述可执行代码。这部分我们主要介绍下对函数和编译单元的描述。

### 描述函数

不同编程语言、开发者对函数的叫法也不完全一致，带返回值的函数（function)和不带返回值的例程（subroutine)，我们将其视作同一个事物的两个不同变体，DWARF中使用DW_TAG_subprogram来描述它们。该DIE具有一个名称，一个三元组表示的源代码中的位置(DW_AT_decl_file, DW_AT_del_line:)，还有一个指示该子程序是否在外部（编译单元）可见的属性(DW_AT_external)。

> 在不同的编程语言中，函数有不同的术语表示，如routine, subroutine, subprogram, function, method or procedure，参考：https://en.wikipedia.org/wiki/Subroutine。这里不深究细节上的差异，明白DW_AT_subprogram是用来描述函数的就可以。

#### 函数地址范围

函数DIE具有属性 `DW_AT_low_pc`、`DW_AT_high_pc`，以给出函数占用的内存地址空间的上下界。 在某些情况下，函数的内存地址可能是连续的，也可能不是连续的。如果不连续，则会有一个内存范围列表。一般DW_AT_low_pc的值为函数入口点地址，除非明确指定了另一个地址。

#### 函数返回值类型

函数的返回值类型由属性 `DW_AT_type` 描述。 如果没有返回值，则此属性不存在。如果在此函数的相同范围内定义了返回类型，则返回类型DIE将作为此函数DIE的兄弟DIE。

> ps: 实际上用Go进行测试，会发现Go编译工具链并没有使用DW_AT_type来作为返回值类型，因为Go支持多返回值，仅靠这一个属性是不够的。所以Go中采用了其他的解决方案，下面会介绍到。

#### 函数形参列表

函数可能具有零个或多个形式参数，这些参数由DIE `DW_TAG_formal_parameter` 描述，这些形参DIE的位置被安排在函数DIE之后，并且各形参DIE的顺序按照形参列表中出现的顺序，尽管参数类型的DIE可能会散布。 通常，这些形式参数存储在寄存器中。

#### 函数局部变量

函数主体可能包含局部变量，这些变量由DIE `DW_TAG_variables` 在形参DIE之后列出。通常这些局部变量在栈中分配。

#### 词法块

大多数编程语言都支持词法块，函数中可能有一些词法块，可以用DIE `DW_TAG_lexcical_block` 来描述。 词法块也可以包含变量和词法块DIE。

#### 示例说明

下面是一个描述C语言函数的示例，可以看到有个名字为strndup的类型为DW_TAG_subprogram的 `DIE <5>`，这个就是DIE是描述函数strndup的DIE；这个C函数的返回值类型由DW_AT_type属性最终确定为*char，1个4字节的指针；继续看下去我们看到了两个形参s、n各自对应的类型为DW_TAG_formal_parameter的DIEs，其中s最终由属性可以确定是const char *类型，而n是unsigned int类型，s、n在内存中的位置分别为fbreg+0，fbreg+4的位置。

<img alt="dwarf_desc_code" src="assets/clip_image009.png" width="480px" />

生成的DWARF调试信息如下所示：

<img alt="dwarf_4_func" src="assets/clip_image010.png" width="480px"/>

该示例取自DWARF v4中章节5.3.3.1.1~5.3.3.1.6，这个示例并不复杂，作者也已经对关键信息做了高亮，结合前面讲的内容，读者理解起来应该也不困难。如果您确实没看懂，可以看下DWARF v4中相关章节的详细描述。

### 编译单元

大多数程序包含多个源文件。 在生成程序时，每个源文件都被视为一个独立的编译单元，并被编译为独立的*.o文件（例如C），然后链接器会将这些目标文件、系统特定的启动代码、系统库链接在一起以生成完整的可执行程序 。

> 注：go中就不是每个源文件作为一个编译单元，而是将package作为一个编译单元。

DWARF中采用了C语言中的术语“编译单元（compilation unit）”作为DIE的名称 `DW_TAG_compilation_unit`。 DIE包含有关编译的常规信息，包括源文件对应的目录和文件名、使用的编程语言、DWARF信息的生产者，以及有助于定位行号和宏信息的偏移量等等。

如果编译单元占用了连续的内存（即，它会被装入一个连续的内存区域），那么该单元的低内存地址和高内存地址将有值，即属性：低地址DW_AT_low_pc，高地址DW_AT_high_pc。 这有助于调试器更轻松地确定特定地址处的指令是由哪个编译单元生成的。如果编译单元占用的内存不连续，则编译器和链接器将提供代码占用的内存地址列表。

每个编译单元都由一个“**公共信息条目CIE（Common Information Entry）**”表示，编译单元中除了CIE以外，还包含了一系列的**帧描述条目FDE（Frame Description Entrie）**。

### Go多值返回

最后，关于Go的一点特殊说明，在描述返回值类型时，Go并不是使用属性DW_AT_type。

下图展示的是C语言中采取的方式，C语言编译器采取了这里DWARF标准推荐的方式，如**形参列表通过DW_TAG_former_parameter来说明，返回值类型通过DW_AT_type来说明，如果没有返回值则无此属性**。

<img alt="dwarf_desc_func" src="assets/dwarf-c.png" width="640px" />

但是，Go语言和C相比有特殊之处，**Go需要****要支持多值返回**，所以仅用DW_AT_type无法对返回值列表充分描述。我们可以写测试程序验证，golang v1.15中并没有使用DWARF规范中推荐的DW_AT_type来说明返回值类型。golang中对返回值的表示，和参数列表中参数一样，仍然是通过DW_TAG_formal_parameter来描述的，但是会通过属性DW_AT_variable_parameter来区分参数属于形参列表或返回值列表，为0(false)表示是形参，为1(true)表示是返回值。

### 本节小结

本节介绍了DWARF如何对可执行代码相关的程序构造进行描述，如函数、编译单元等，最后指出了Go语言函数支持多值返回时这里的返回值描述的特殊之处。读到这里，相信读者已经对DWARF如何描述可执行程序有了更深入的认识。
