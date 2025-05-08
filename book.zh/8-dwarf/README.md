![DWARF Logo](assets/dwarf_logo.gif)

**DWARF** 是一种广泛使用的调试信息格式。最初设计用于配合 ELF 格式，但它与具体文件格式并不绑定。“DWARF” 一词源于中世纪幻想小说，本身没有官方含义。后来，人们提出了“**Debugging With Attributed Record Formats**”作为 DWARF 调试信息的另一种定义。

DWARF 使用 **DIE (Debugging Information Entry)** 来描述变量、数据类型和代码。每个 DIE 包含 **标签 (Tag)** 和 **一系列属性 (Attributes)**。

DWARF 还定义了关键数据结构，如 **行号表 (Line Number Table)** 和 **调用栈信息 (Call Frame Information)**。这些结构使得开发者能够在源码级别动态添加断点、显示当前 PC 对应的源码位置、显示完整的调用栈信息，并查看调用栈中指定栈帧的信息。

DWARF 标准包含许多精妙的设计。如果你对高级语言的符号级调试感兴趣，强烈建议学习本章内容。
