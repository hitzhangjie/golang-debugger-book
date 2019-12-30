## 5.2 DWARF数据结构

DWARF使用数据结构调试信息条目Debugging Information Entry（DIE）来表示每一个变量、数据类型、函数等。

- 每个DIE都包含一个tag（如DW_TAG_variable，DW_TAG_pointer_type，DW_TAG_subprogram等）以及一系列的attributes。
- 每个DIE还可以包含child DIEs，这个完整的树结构共同描述一个变量、数据类型等实体。
- DIE中的每个attribute可以引用另一个DIE，例如一个描述变量的DIE，它会包含一个属性DW_AT_type来指向一个描述变量数据类型的DIE。

符号级调试器需要两张非常大的表，一个是行号表Line Number Table，一个是调用栈信息表Call Frame Information Table。

1. **行号表（The Line Number Table）**, 它将程序代码段指令地址映射为源文件中的地址，如文件名+行号，当然如果指定了源文件中的位置，也可以将其映射为程序代码段指令地址。这个表还有其他更细的用途，甚至指出哪些指令是函数序言（prologues）或函数结尾（epilogues）部分的指令。
2. **调用栈信息表（Call Frame Information Table）**, 它允许调试器定位调用栈上的特定栈帧。

这两张表会占用非常大的存储空间，为了节省存储空间，DWARF专门设计了状态机和字节码指令，将上述两张表的冗

余数据进行适当剔除后，将剩下的数据进一步通过字节码指令进行编码，这样两张表的空间占用就显著减小了。

当调试器加载了上述表数据后，希望构建出这两张表，该如何操作呢？前面提过了这里的数据都是字节码指令，只要交给对应的状态机执行，状态机执行字节码指令完成表的构建。

> 关于这两张表的更多内容，在后文会进一步描述。

