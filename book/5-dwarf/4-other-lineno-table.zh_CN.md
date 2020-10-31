### 5.4.1 行号表（Line Number Table）

#### 5.4.1.1 介绍

符号级调试器，需要知道如何将源文件中的位置与可执行对象、共享对象中的机器指令地址进行关联。 这样的关联将使调试用户可以根据源代码中的位置（源文件名+行号）指定机器指令地址（如在源码行设置断点）。调试器还可以使用此信息将当前机器指令地址转换为源文件中的位置，也可以用来控制tracee进程逐条指令执行或者逐条语句执行。

为编译单元生成的“**行号表（行号信息）**”存储在目标文件的 **.debug_line **section中，并由.debug_info节中的相应编译单元DIEs（请参阅DWARF v4中的3.1.1节）引用。

DWARF行号表，包含了可执行程序机器指令的内存地址和在源代码中的位置之间的映射关系。

#### 5.4.1.2 存储结构

**行号表长什么样子呢？可以简单地将其理解成一个矩阵**，会包含如下几列数据：

- 指令地址
- 源文件名
- 源文件中行号
- 源文件中列号
- 是否是源码语句的第一条指令
- 是否是源码词法块的第一条指令
- 其他

其中一列包含指令地址，另几列是源码位置三元组（文件、行号、列号），另两列表示当前指令是否是源码语句、词法块的第一条指令。 设置源代码行的断点时，查询该表以定位到源代码行对应的第一条指令地址，并设置断点。 当程序在执行过程中出现故障时，查询当前指令地址对应的相关的源代码行，并进行分析。

#### 5.4.1.3 数据压缩

**如我们所想象的那样，如果每条指令在表中都用一行存储，那么该行号表将会巨大无比。如何压缩呢？**

- 每条源码语句可能对应着多条机器指令，实际上**只需存储第一条指令**即可，其他的都不需要存储；
- 进一步考虑将行号表数据转换为更精简的**字节码指令序列**来表示，省在哪里？相邻两机器指令之间如果某些列值相同，就可以省去对该列的操作；对于行号、列号之类的，两条指令之间行号、列号数值相差多少，存储增量也比存实际值要占用更小的存储；等等。

DWARF将行号表编码为“**行号表程序的指令序列**”。 这里的指令序列，由**一个简单的有穷状态机**解释、执行，执行指令的过程就是创建完整行号表的过程。通过上述方法，行号表（行号信息）就被有效压缩了。

#### 5.4.1.4 相关设计

##### 5.4.1.4.1 定义

在描述行表信息（行号表）时，有如下几个术语：

- 状态机（state machine），是一个假想的机器，行号表被转换成字节码指令序列，这个状态机执行这个指令序列，构建出行号表这个行号信息矩阵；
- 行号程序（line number program），字节编码的行号信息指令序列，它代表了一个编译单元的行号信息矩阵；
- 基本块（basic block），指令序列，其中只有第一条指令可以成为分支目标，只有最后一条指令可以转移控制。 过程调用被定义为从基本块退出。
- 序列（sequence），一系列连续的目标机器指令。 一个编译单元可能会产生多个序列（也就是说，并不能假定编译单元中的所有指令都是连续的）。

##### 5.4.1.4.2 状态机寄存器

行号（表）信息状态机，有如下几个寄存器：

- address，程序计数器（PC）的值，存的是编译器生成的机器指令地址；

- op_index，一个无符号整数表示的操作对应的索引，通过索引来引用操作数组中的某个具体操作。

  address和op_index结合起来，构成一个操作指针（operation pointer）可引用指令序列中任一个独立操作；

- file、line、column：源文件位置三元组，文件名、行号、列号；

- is_stmt，一个bool值，当前指令是否作为一个建议的断点位置（比如statement的第一条指令）；

- basic_block，一个bool值，当前指令是否是一个词法块的开始；

- end_sequence，一个布尔值，指示当前地址是目标机器指令序列结束后的第一个字节的地址。 end_sequence终止一系列行； 因此，同一行中的其他信息没有意义；

- prologue_end，一个布尔值，指示当前地址是一个应该暂停执行的位置，如果是函数入口断点的话；

- epiloguge_begin，一个布尔值，指示当前地址是一个应该暂停执行的位置，如果是函数退出断点的话；

- isa，一个无符号整数，指示当前指令适用的指令集体系结构；

- discriminator，一个无符号整数，标识当前指令所属的块。其值由DWARF生产者（编译器）任意分配
  ，主要用于区分可能与同一源文件、行、列相关联的多个块（比如block嵌套）。 对于给定的源位置，仅存在一个块的情况下，其值应为零。

在行号程序（指令序列）一开始时，状态机寄存器的状态如下所示：

![image-20191222182516621](assets/image-20191222182516621.png)

##### 5.4.1.4.3 行号程序指令

行号（表）信息中，状态机指令主要可以分为三类：

- special opcodes，这类指令都是ubyte表示的操作码，没有操作数，行号（表）程序中的指令，绝大部分都是这类；
- standard opcodes，这类指令有一个ubyte表示的操作码，后面跟着0个或者多个LEB128编码的操作数。其实操作码确定了，有多少个操作数、各个操作数的含义也就确定了，但是行号（表）程序头中仍然指明了各个操作码的操作数数量；
- extended opcodes，这类指令是多字节操作码，（不错哦，联想其《组成原理》中的处理器变长操作码设计），第一个字节是0，后面的字节是LEB128编码的无符号整数，表示该指令包含的字节数（不含第一个字节的0），剩下的字节是指令数据本身（其中第一个字节是一个ubyte表示的扩展操作码）。

##### 5.4.1.4.4 行号程序头

行号信息的最佳编码在一定程度上取决于目标机器的体系结构。 行号程序头提供了供消费者（调试器）在解码特定编译单元的行号程序指令时使用的信息，还提供了在其余行号程序中使用的信息。

每个编译单元的行号程序均以一个header开头，header包含如下字段：

- unit_length（initial length），这个编译单元的行号信息的字节数量，当前字段不计算在内；

- version（uhalf），版本号，特定于行号信息的版本号，与DWARF版本号没有关系；

- header_length，该字段之后到行号程序起始处第一字节的字节偏移量。在32位DWARF格式中，这是一个4字节无符号整数，64位DWARF格式中，这是一个8字节无符号整数；

- minimum_instruction_length（ubyte），目标机器指令占用的最小字节数量，更改address、op_index寄存器的行号程序操作码，在计算中会使用该字段和maximum_operations_per_instruction；

- maximum_operations_per_instruction（ubyte），一条指令中可以编码的最大单个操作数，更改address、op_index寄存器的行号程序操作码，在计算中会使用该字段和minimum_instruction_length；

- default_is_stmt（ubyte），用语设置状态机寄存器is_stmt的初始值；

  A simple approach to building line number information when machine instructions are emitted in an order corresponding to the source program is to set default_is_stmt to “true” and to not change the value of the is_stmt register within the line number program. One matrix entry is produced for each line that has code generated for it. The effect is that every entry in the matrix recommends the beginning of each represented line as a breakpoint location. This is the traditional practice for unoptimized code.

  A more sophisticated approach might involve multiple entries in the matrix for a line number; in this case, at least one entry (often but not necessarily only one) specifies a recommended breakpoint location for the line number. DW_LNS_negate_stmt opcodes in the line number program control which matrix entries constitute such a recommendation and default_is_stmt might be either “true” or “false”. This approach might be used as part of support for debugging optimized code.

  源码语句对应的多条机器指令，至少有一条default_is_stmt=true，以充当推荐的断点位置。

- line_base（sbyte），该参数映像special opcodes的含义，见下文；

- line_range （sbyte），该参数映像special opcodes的含义，见下文；

- opcode_base（ubyte），第一个特殊操作码的操作码值，正常情况下该值比标准操作码值大1。

  如果设置的该值小于标准操作码值的最大值，那么在当前编译单元中，大于opcode_base的标准操作码值在行号表中是不被使用的，会被看做特殊操作码；如果设置的该值比标准操作码值大，那么标准操作码最大值到opcode_base值之间的部分可以留给第三方扩展用。

- standard_opcode_lengths（array of ubyte），该数组指明了每个标准操作码对应的LEB128操作数的数量。

- include_directories（sequence of path names），编译单元中可能包含了其他文件，该字段指定了文件搜索路径；

- file_names（sequence of file entries），该编译单元对应的行号表（行号信息）可能不止由当前源文件以及包含文件共同构建出来的，该字段包含了相关文件的文件名；

##### 5.4.1.4.5 行(号)表程序

如前所述，行号程序的目标是建立一个表示一个编译单元的矩阵，该编译单元可能已生成目标机器指令的多个序列。 在一个序列中，地址（操作指针）可能只会增加（在流水线调度或其他优化的情况下，行号可能会减少）。

行号程序由特殊操作码、标准操作码和扩展操作码组成。 在这里，我们仅描述特殊操作码。 如果您对标准操作码或扩展操作码感兴趣，请参阅DWARF v4标准的章节6.2.5.2和6.2.5.3。

每个ubyte特殊操作码，其操作对状态机状态的影响可以归为下面几点：

 1. 向行寄存器line添加一个有符号数。
 2. 增加address和op_index寄存器的值来修改operation pointer。
 3. 使用状态机寄存器的当前值在矩阵上添加一行。
 4. 将basic_block寄存器设置为“ false”。
 5. 将prologue_end寄存器设置为“ false”。
 6. 将epilogue_begin寄存器设置为“ false”。
 7. 将鉴别器discriminator寄存器设置为0。

所有特殊操作码都做同样的七件事，不同之处仅在于它们添加到寄存器line，address和op_index的值不同。

根据需要添加到寄存器line、address和op_index的数量选择特殊操作码值。特殊操作码的最大行增量，是行号程序header中的line_base字段的值加上line_range字段的值减去1（line_base+line_range-1）。 如果所需的行增量大于最大行增量，则必须使用标准操作码代替特殊操作码。 operation advance，表示向前移动操作指针时要跳过的操作数。

**“特殊操作码”计算公式如下**：

```
opcode = (desired line increment - line_base) + (line_range * operation advance) + opcode_base
```

如果结果操作码大于255，则必须改用标准操作码。

当*maximum_operations_per_instruction*为1时，*operation advance*就是地址增量除以*minimum_instruction_length*。

**要解码特殊操作码**，要从操作码本身中减去opcode_base以提供调整后的操作码。*operation advance*是调整后的操作码除以*line_range*的结果。new address和 new op_index值由下式给出：

```
adjusted opcode = opcode – opcode_base 
operation advance = adjusted opcode / line_range

new address = address + 
			minimum_instruction_length *
			((op_index + operation advance)/maximum_operations_per_instruction) 

new op_index = (op_index + operation advance) % maximum_operations_per_instruction
```

当*maximum_operations_per_instruction*字段为1时，*op_index*始终为0，这些计算将简化为DWARF版本v3中为地址提供的计算。 line increment的数值是line_base加上以调整后操作码除以line_range的模的和。 就是：

```
line increment = line_base + (adjusted opcode % line_range)
```

例如，当**假设opcode_base为13，line_base为-3，line_range为12，minimum_instruction_length为1，maximum_operations_per_instruction为1** ，下表中列出了当前假设下，当源码行相差[-3,8]范围内时、指令地址相差[0,20]时计算得到的特殊操作码值。

<img src="assets/image-20191225005529000.png" alt="image-20191225005529000" style="zoom:50%;" />

#### 5.4.1.5 示例

请考虑图60中的简单源文件和Intel 8086处理器的最终机器代码。

<img src="assets/image-20191225013035603.png" alt="image-20191225013035603" style="zoom:46%;" />

现在，让我们逐步构建“行号表程序”。 实际上，我们需要先将源代码编译为汇编代码，然后计算每个连续语句的指令地址和行号的增量，根据指令地址增量operation advance以及行号增量line increment，来计算操作码，这些操作码构成一个sequence，术语行号程序的一个部分。

例如, `2: main()` and `4: printf`, 这两条源语句各自第一条指令的地址的增量为 `0x23c-0x239=3`, 两条源语句的行号增量为 `4-2=2`. 然后我们可以通过函数 `Special(lineIncr,operationAdvance)` 来计算对应的特殊操作码，即 `Special(2, 3)`。

<img src="assets/image-20191225014107123.png" alt="image-20191225014107123" style="zoom:46%;" />

回想一下上面提及的特殊操作码的计算公式：

 `opcode = (desired line increment - line_base) + (line_range * operation advance) + opcode_base`

假设行号程序头包括以下内容（以下不需要的头字段未显示）：

<img src="assets/image-20191225015459672.png" alt="image-20191225015459672" style="zoom:16%;" />

然后代入上述计算公式，Special(2, 3)的计算如下:

```
opcode = (2 - 1) + (15 * 3) + 10 = 56 = 0x38
```

这样就计算得到了构建行号表从`2: main()`到`4: printf`对应的行所需要的特殊操作码0x38。然后逐一处理所有相邻的源语句，就得到了如下行号表程序：

<img src="assets/image-20191225015400111.png" alt="image-20191225015400111" style="zoom: 25%;" />

如果要构建完整的行号表，需要先读取行号表，然后行号表状态机对操作码进行解码，并计算得到相邻源码语句间的行增量（line increment）和指令地址增量（operation advance），并在行号表矩阵中插入新的一行，据此就可以构建出完整的行号表矩阵了。