# DWARF解析及应用

介绍下[go-delve/delve](https://github.com/go-delve/delve)中的DWARF解析相关的代码，这里简单介绍下相关package的作用和使用方法，在后续小节中将有更详细的使用。

这里的介绍采用的delve源码版本为：commit cba1a524。您可以检出delve的源码的对应版本，来进一步深入了解，我们先跟随作者的节奏来快速了解。

## 目录结构&说明

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

简单说下上述package的作用：

| package      | 作用及用途                                                   |
| ------------ | ------------------------------------------------------------ |
| dwarfbuilder | 实现了一个Builder，通过该Builder可以方便地生成不同代码结构对应的DWARF调试信息，如New()返回一个Builder并初始设置DWARF信息的header字段，然后通过返回的builder增加编译单元、数据类型、变量、函数等等。<br>可以说，这个Builder为快速为源码生成对应的调试信息提供了很大遍历。但是这个package对于实现调试器而言应该是没多大用处的，但是对于验证go编译工具链如何生成调试信息很有帮助。一旦能认识到go编译工具链是如何生成DWARF调试信息的，我们就可以进一步了解到该如何去解析、应用对应的调试信息。<br>这个package的作用更多地是用于学习、验证DWARF调试信息生成和应用的。 |
| frame        | .[z]debug_frame中的信息可以帮助构建CFI (Canonical Frame Information)，指定任意指令地址，我们便可以借助CFI计算出当前的调用栈。<br>DWARF信息中的编译单元可能压缩了多个go源文件，每个编译单元都以CIE (Common Information Entry) 开始，然后接下来是一系列的FDE (Frame Description Entry)。<br>这里定义了类型CommonInformationEntry、FrameDescriptionEntry用来分别表示CIE、FDE。FDE里面引用CIE，CIE中包含了初始指令序列，FDE中包含了自己的指令序列，结合CIE、FDE可以构建出完整的CFI表。<br>为了方便判断某个指令地址是否在某个FDE范围内，类型FrameDescriptionEntry中定义了方法Cover，还提供了Begin、End来给出该FDE的范围，此外它还定义了方法EstablishFrame通过状态机执行CIE、FDE中的指令序列来按需构建CFI表的全部或者一部分，方便我们计算CFA (Canonical Frame Address) ，有了它可以进一步计算出被调函数的返回地址。<br>有了这个返回地址，它实际是个指令地址，我们就可以计算出对应的源码位置（如文件名、行号、函数名）。将这个返回地址继续作为指令地址去迭代处理，我们就可以计算出完整的调用栈。<br><br>**注意：FDE中的begin、end描述的是创建、销毁栈帧及其存在期间的指令序列instructions的地址范围，详见DWARF v4 standard。**<br>此外还定义了类型FrameDescriptionEntries，它实际上是一个FDE的slice，只是增加了一些帮助函数，比如FDEForPC用于通过指令地址查询包含它的FDE。<br>每个函数都有一个FDE，每个函数的每条指令都是按照定义时的顺序来安排虚拟的内存地址的，不存在一个函数的FDE的指令范围会包括另一个函数的FDE的指令范围的情况）。 |
| godwarf      |                                                              |
| line         |                                                              |
| loclist      |                                                              |
| op           | 先看op.go，DWARF中前面讲述地址表达式的运算时，提到了地址运算是通过执行一个基于栈操作的程序指令列表来完成的。程序指令都是1字节码指令，这里的字节码在当前package中均有定义，其需要的操作数就在栈中，每个字节码指令都有一个对应的函数stackfn，该函数执行时会对栈中的数据进行操作，取操作数并将运算结果重新入栈。最终栈顶元素即结果。<br>opcodes.go中定义了一系列操作码、操作码到名字映射、操作码对应操作数数量。<br>registers.go定义了DWARF关心的寄存器列表的信息DwarfRegisters，还提供了一些遍历的方法，如返回指定编号对应的的寄存器信息DwarfRegister、返回当前PC/SP/BP寄存器的值。 |
| reader       | 1、定义了Reader，它内嵌了go标准库中的dwarf.Reader来从.[z]debug_info中读取DIE信息，每个DIE在DWARF中被组织成一棵树的形式，每个DIE对应一个dwarf.Entry，它包括了此前提及的Tag以及[]Field（Field中记录了Attr信息），此外还记录了DIE的Offset、是否包含孩子DIE。<br>这里的Reader，还定义了一些其他函数如Seek、SeekToEntry、AddrFor、SeekToType、NextType、SeekToTypeNamed、FindEntryNamed、InstructionsForEntryNamed、InstructionsForEntry、NextMemberVariable、NextPackageVariable、NextCompileUnit。<br>2、定义了Variable，其中嵌入了描述一个变量的DIE构成的树godwarf.Tree。它还提供了函数Variables用来从指定DIE树中提取包含的变量列表。 |
| regnum       | 定义了寄存器编号与寄存器名称的映射关系，提供了函数快速双向查询。 |
| util         |                                                              |

