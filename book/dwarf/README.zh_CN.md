DWARF 是一种广泛使用的标准调试信息格式，最初DWARF的设计初衷是配合ELF格式使用，不过DWARF与具体的文件格式是没有依赖关系的。DWARF这个词是中世纪幻想小说中的用语，DWARF也没有什么官方的含义，后来提出 'Debugging With Attributed Record Formats' 这个术语来作为DWARF的另一种定义。

DWARF使用DIE（Debugging Information Entry）来描述变量、数据类型、代码等，DIE包含标签和若干属性。

DWARF也定义了一些关键的数据结构，如行号表（Line Number Table)、调用栈信息（Call Frame Information）等，有了这些关键数据结构之后，开发者就可以在源代码语句级别添加动态断点，`bt`可以显示完整的调用栈信息，也可以使用`frame N`来选择感兴趣的栈帧查看。

在DWARF标准中可以了解到很多精巧的设计，如果你对调试器、调试原理等感兴趣，就请继续关注、阅读吧。

