## DWARF解析

介绍下[go-delve/delve](https://github.com/go-delve/delve)中的DWARF解析相关的代码，这里简单介绍下相关package的作用和使用方法，在后续小节中将有更详细的使用。

这里的介绍采用的delve源码版本为：commit cba1a524。您可以检出delve的源码的对应版本，来进一步深入了解，我们先跟随作者的节奏来快速了解。

### 目录结构

我们先看下delve中DWARF相关的代码，这部分代码位于项目目录下的pkg/dwarf目录下，根据描述的DWARF信息的不同、用途的不同又细分为了几个不同的package。

我们用tree命令来先试下pkg/dwarf这个包下的目录及文件列表：

```go
${path-to-delve}/pkg/dwarf/
├── dwarfbuilder
│   ├── builder.go
│   ├── info.go
│   └── loc.go
├── frame
│   ├── entries.go
│   ├── entries_test.go
│   ├── expression_constants.go
│   ├── parser.go
│   ├── parser_test.go
│   ├── table.go
│   └── testdata
│       └── frame
├── godwarf
│   ├── addr.go
│   ├── sections.go
│   ├── tree.go
│   ├── tree_test.go
│   └── type.go
├── line
│   ├── _testdata
│   │   └── debug.grafana.debug.gz
│   ├── line_parser.go
│   ├── line_parser_test.go
│   ├── parse_util.go
│   ├── state_machine.go
│   └── state_machine_test.go
├── loclist
│   ├── dwarf2_loclist.go
│   ├── dwarf5_loclist.go
│   └── loclist5_test.go
├── op
│   ├── op.go
│   ├── op_test.go
│   ├── opcodes.go
│   ├── opcodes.table
│   └── regs.go
├── reader
│   ├── reader.go
│   └── variables.go
├── regnum
│   ├── amd64.go
│   ├── arm64.go
│   └── i386.go
└── util
    ├── buf.go
    ├── util.go
    └── util_test.go

11 directories, 37 files
```

### 功能说明

对上述package的具体功能进行简单陈述：

| package      | 作用及用途                                                   |
| ------------ | ------------------------------------------------------------ |
| dwarfbuilder | 实现了一个Builder，通过该Builder可以方便地生成不同代码结构对应的DWARF调试信息，如New()返回一个Builder并初始设置DWARF信息的header字段，然后通过返回的builder增加编译单元、数据类型、变量、函数等等。<br>可以说，这个Builder为快速为源码生成对应的调试信息提供了很大遍历。但是这个package对于实现调试器而言应该是没多大用处的，但是对于验证go编译工具链如何生成调试信息很有帮助。一旦能认识到go编译工具链是如何生成DWARF调试信息的，我们就可以进一步了解到该如何去解析、应用对应的调试信息。<br>这个package的作用更多地是用于学习、验证DWARF调试信息生成和应用的。 |
| frame        | .[z]debug_frame中的信息可以帮助构建CFI (Canonical Frame Information)，指定任意指令地址，我们便可以借助CFI计算出当前的调用栈。<br>DWARF信息中的编译单元可能压缩了多个go源文件，每个编译单元都以CIE (Common Information Entry) 开始，然后接下来是一系列的FDE (Frame Description Entry)。<br>这里定义了类型CommonInformationEntry、FrameDescriptionEntry用来分别表示CIE、FDE。FDE里面引用CIE，CIE中包含了初始指令序列，FDE中包含了自己的指令序列，结合CIE、FDE可以构建出完整的CFI表。<br>为了方便判断某个指令地址是否在某个FDE范围内，类型FrameDescriptionEntry中定义了方法Cover，还提供了Begin、End来给出该FDE的范围，此外它还定义了方法EstablishFrame通过状态机执行CIE、FDE中的指令序列来按需构建CFI表的全部或者一部分，方便我们计算CFA (Canonical Frame Address) ，有了它可以进一步计算出被调函数的返回地址。<br>有了这个返回地址，它实际是个指令地址，我们就可以计算出对应的源码位置（如文件名、行号、函数名）。将这个返回地址继续作为指令地址去迭代处理，我们就可以计算出完整的调用栈。<br><br>**注意：FDE中的begin、end描述的是创建、销毁栈帧及其存在期间的指令序列instructions的地址范围，详见DWARF v4 standard。**<br>此外还定义了类型FrameDescriptionEntries，它实际上是一个FDE的slice，只是增加了一些帮助函数，比如FDEForPC用于通过指令地址查询包含它的FDE。<br>每个函数都有一个FDE，每个函数的每条指令都是按照定义时的顺序来安排虚拟的内存地址的，不存在一个函数的FDE的指令范围会包括另一个函数的FDE的指令范围的情况）。 |
| godwarf      | 这个包提供了一些基础的功能，addr.go中提供了DWARF v5中新增的.[z]debug_addr的解析能力。<br>sections.go中提供了读取不同文件格式中调试信息的功能，如GetDebugSectionElf能从指定elf文件中读取指定调试section的数据，并且根据section数据是否压缩自动解压缩处理。<br>tree.go提供了读取DIE构成的Tree的能力，一个编译单元如果不连续的话在Tree.Ranges中就存在多个地址范围，当判断一个编译单元的地址范围是否包含指定指令地址时就需要遍历Tree.Ranges进行检查，Tree.ContainsPC方法简化了这个操作。Tree.Type方法还支持读取当前TreeNode对应的类型信息。<br>type.go中定义了对应go数据类型的一些类型，包括基本数据类型BasicType以及基于组合扩展的CharType、UcharType、IntType等，也包括一些组合类型如StructType、SliceType、StringType等，还有其他一些类型。这些类型都是以DIE的形式存储在.[z]debug_info中的。tree.go中提供了一个非常重要的函数ReadType，它能从DWARF数据中读取定义在指定偏移量处的类型信息，并在对应类型中通过reflect.Kind来建立与go数据类型的对应关系，以后就可以很方便地利用go的reflect包来创建变量并赋值。 |
| line         | 符号级调试很重要的一点是能够在指令地址与源文件名:行号之间进行转换，比如添加给语句添加断点的时候要转化成对指令地址的指令patch，或者停在某个断点处时应该显示出当前停在的源代码位置。行号表就是用来实现这个转换的，行号表被编码为一个字节码指令流，存储在.[z]debug_line中。<br>每个编译单元都有一个行号表，不同的编译单元的行号表数据最终会被linker合并在一起。每个行号表都有固定的结构以供解析，如header字段，然后后面跟着具体数据。<br>line_parser.go中提供了方法ParseAll来解析.[z]debug_line中的所有编译单元的行号表，对应类型DebugLines表示，每个编译单元对应的行号对应类型DebugLineInfo。DebugLineInfo中很重要的一个字段就是指令序列，这个指令序列也是交给一个行号表状态机去执行的，状态机实现定义在state_machine.go中，状态机执行后就能构建出完整的行号表。<br>有了完整的行号表，我们就可以根据pc去查表来找到对应的源码行。 |
| loclist      | 描述对象在内存中的位置可以用位置表达式，也可以用位置列表。如果在对象生命周期中对象的位置可能发生变化，那么就需要一个位置列表来描述。再者，如果一个对象在内存中的存储不是一个连续的段，而是多个不相邻的段合并起来，那这种也需要用位置列表来描述。<br>在DWARF v2~v4中，位置列表信息存储在.[z]debug_loc中，在DWARF v5中，则存储在.[z]debug_loclist中。loclist包分别针对旧版本（DWARF v2~v4）、新版本（DWARF v5）中的位置列表予以了支持。<br>这个包中定义了Dwarf2Reader、Dwarf5Reader分别用来从旧版本、新版本的位置列表原始数据中读取位置列表。 |
| op           | 先看op.go，DWARF中前面讲述地址表达式的运算时，提到了地址运算是通过执行一个基于栈操作的程序指令列表来完成的。程序指令都是1字节码指令，这里的字节码在当前package中均有定义，其需要的操作数就在栈中，每个字节码指令都有一个对应的函数stackfn，该函数执行时会对栈中的数据进行操作，取操作数并将运算结果重新入栈。最终栈顶元素即结果。<br>opcodes.go中定义了一系列操作码、操作码到名字映射、操作码对应操作数数量。<br>registers.go定义了DWARF关心的寄存器列表的信息DwarfRegisters，还提供了一些遍历的方法，如返回指定编号对应的的寄存器信息DwarfRegister、返回当前PC/SP/BP寄存器的值。 |
| reader       | 该包定义了类型Reader，它内嵌了go标准库中的dwarf.Reader来从.[z]debug_info中读取DIE信息，每个DIE在DWARF中被组织成一棵树的形式，每个DIE对应一个dwarf.Entry，它包括了此前提及的Tag以及[]Field（Field中记录了Attr信息），此外还记录了DIE的Offset、是否包含孩子DIE。<br>这里的Reader，还定义了一些其他函数如Seek、SeekToEntry、AddrFor、SeekToType、NextType、SeekToTypeNamed、FindEntryNamed、InstructionsForEntryNamed、InstructionsForEntry、NextMemberVariable、NextPackageVariable、NextCompileUnit。<br>该包还定义了类型Variable，其中嵌入了描述一个变量的DIE构成的树godwarf.Tree。它还提供了函数Variables用来从指定DIE树中提取包含的变量列表。 |
| regnum       | 定义了寄存器编号与寄存器名称的映射关系，提供了函数快速双向查询。 |
| util         | 该包定义了一个DWARF数据读取的buffer实现，从中可以方便读取DWARF编码的一些数据，如Uint8、Varint、Uint、Int等。<br>该包还定义了一些导出函数来方便从buf中读取ULEB128、SLEB128、string、DWARF数据长度&版本等，或者编码ULEB128、SLEB128、Uint等到writer。 |

### 本节小结

本小节简要列举了go-delve/delve中的DWARF相关的package pkg/dwarf，并针对这个package下的各个子包的功能作用、大致工作原理进行了简要的陈述。

由于手写一个完整且健壮的DWARF解析库，是要求必须要精通DWARF调试信息标准的，而且还要了解go编译器、链接器在从DWARF v4演变到DWARF v5的过程中所做的各种调整。这里从头实现一个类似go-delve/delve中package pkg/dwarf的库的话工作量会比较大。

我们是出于学习目的，为了尽可能精确地、完整地介绍符号级调试器方方面面知识点的同时，也希望手把手教大家开发的过程也不至于很枯燥，所以决定不打算从头手写DWARF解析库，而是复用go-delve/delve中DWARF解析库（会适当裁剪无关代码）并介绍大致的实现过程。在接下来的小节中我们将展示如何引用它并一步步实现我们的符号级调试器。
