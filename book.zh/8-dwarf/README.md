**DWARF** 是一种广泛使用的标准调试信息格式，最初DWARF的设计初衷是配合ELF格式使用，不过DWARF与具体的文件格式是没有依赖关系的。DWARF这个词是中世纪幻想小说中的用语，也没有什么官方含义，后来才提出 “**Debugging With Attributed Record Formats**” 这个术语来作为DWARF的另一种定义。

DWARF使用**DIE（Debugging Information Entry）**来描述变量、数据类型、代码等，DIE中包含了**标签（Tag）**和**一系列属性（Attributes）**。

DWARF还定义了一些关键的数据结构，如**行号表（Line Number Table)**、**调用栈信息（Call Frame Information）**等，有了这些关键数据结构之后，开发者就可以在源码级别动态添加断点、显示完整的调用栈信息、查看调用栈中指定栈帧的信息。

在DWARF标准中可以了解到很多精妙绝伦的设计，如果你对调试原理感兴趣，就一定不要错过本章节内容。

