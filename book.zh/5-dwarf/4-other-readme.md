我们在5.3节中提到了通过DIE描述变量、数据类型、可执行代码（例如函数和编译单元等）。除了这些内容以外，DWARF调试信息中还有几种非常重要的信息需要描述，符号级调试器非常依赖这些数据。

这些数据包括：

- 加速访问（Accelerated Access）

  调试器经常需要根据符号名、类型名、指令地址，快速定位到对应的源代码行。

  比较笨的办法是遍历所有的DIEs，检查查询关键字符号名、类型名与DIEs描述的是否匹配，或者检查指令地址与对应的DIEs所表示的地址范围是否有包含关系，是个办法，但是效率实在太低了。

  DWARF为了加速查询，在DWARF信息生成的时候允许编译器额外创建3张表用来加速查询，加速符号名查询的.debug_pubnames (查询对象或函数）、加速类型名查询的.debug_pubtypes（查询类型）、加速指令地址查询的.debug_aranges。

- 行号表（Line Number Table）

  DWARF行号表，包含了可执行程序机器指令的内存地址和对应的源代码行之间的映射关系。

- 宏信息（Macro Information）

  大多数调试器很难显示和调试具有宏的代码。 用户看到带有宏的原始源文件，而代码则对应于宏展开后的东西。

  DWARF调试信息中包含了对程序中定义的宏的描述。这是非常基本的信息，但是调试器可以使用它来显示宏的值或将宏翻译成相应的源语言。

- 调用栈信息（Call Frame Information）

  每个处理器都有一种特定的方式来决定“**如何传递参数和返回值**”，这是由“**处理器的ABI（应用程序二进制接口）**”定义的。

  DWARF中的调用栈信息（Call Frame Information，简称CFI）为调试器提供了如下信息，函数是如何被调用的，如何找到函数参数，如何找到调用函数（caller）的栈帧信息。 调试器借助CFI可以展开调用栈、查找上一个函数、确定当前函数的被调用位置以及传递的参数值。

- 变长数据（Variable Length Data）

  在整个DWARF调试信息表示中，整数值使用的非常广泛，从数据段中的偏移量，到数组长度、结构体大小，等等。 由于大多数整数的实际值可能比较小，只用几位就可以表示，这意味着整数值的高位bits很多由零组成。

  DWARF定义了一种可变长度的整数，称为**Little Endian Base 128**（带符号整数为LEB128或无符号整数为ULEB128），LEB128可以压缩占用的字节来表示整数值，对于小整数值比较多的情况下，无疑会节省存储空间。

  关于LEB128的内容，可以参考Wiki: https://en.wikipedia.org/wiki/LEB128。

- 压缩DWARF数据（Shrinking DWARF data）

  与DWARF v1相比，DWARF新版本使用的编码方案大大减少了调试信息的大小。 但不幸的是，编译器生成的许多程序的调试信息仍然可能很大，通常大于可执行代码和数据。

  DWARF提供了进一步减少调试数据大小的方法。 这里，我们暂时先不详细展开。

- ELF文件格式Sections

  虽然DWARF的定义使其可以与任何目标文件格式一起使用，但最经常与ELF一起使用。

  DWARF调试信息根据描述对象的不同，在最终存储的时候也进行了归类、存储到不同的地方。以ELF文件格式为例，DWARF调试信息被存储到了不同的section中，section名称均以前缀'.debug_'开头，例如，.debug_frame包含调用栈信息，.debug_info包含核心DWARF数据（如DIE描述的变量、可执行代码等），.debug_types包含定义的类型，.debug_line包含行号表程序（字节码指令，由行号表状态机执行以生成完整行号表）。