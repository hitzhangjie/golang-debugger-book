## 符号级调试基础

符号级调试，依赖于编译器、连接器生成的调试信息。

调试信息在不同的文件格式中，有不同的存储方式。这些调试信息又有多种类型，如描述数据类型、变量、函数定义的，或者描述符号表、行号表、调用栈信息表的，等等。

此外，不同的编程语言也会有自己的取舍，一方面兼容现有二进制工具生成必要sections的同时，可能也会生成一些额外的sections方便自己的工具链进行处理。

对于go语言来说，虽然其在版本迭代过程中，符号信息的生成出现了一些比较多的变化，如.gosymtab在go1.2+之后官方突然去掉了，导致没法查询本地变量信息等，或者一些相关的行号表解析的方法被废弃了。这些都带来了一些不便。

好的一点是go标准库提供了debug/*，专门用来帮助go开发人员解决这些问题。它们不仅支持ELF文件的读取解析，也支持符号表、行号表、调用栈信息表以及其他DWARF数据的读取、解析。

下面我们拉看下go标准库提供了哪些工具可以辅助我们进行符号级调试器开发。

### debug/elf

ELF (Executable and Linkable Format)，可执行链接嵌入格式，是Unix、Linux环境下一种十分常见的文件格式，它可以用于可执行程序、目标代码、共享库甚至核心转储文件等。

ELF文件格式如下所示，它包含了ELF头、Program Header Table、Section Header Table，还有其他字段，等等。

![img](assets/clip_image001.png)

 对ELF文件通常包含两种类型的视图：

- 一种是对开发人员说的，代码、数据等等的分组视图，比如通过sections来获取视图；
- 一种是对linker来说的，将多个program header table中的元素有组织地结合起来形成一个完整的可执行程序；

标准库提供了package`debug/elf`来读取、解析elf文件数据，相关的数据类型及其之间的依赖关系，如下图所示：

![img](assets/clip_image002.png)

 简单讲，elf.File中包含了我们可以从elf文件中获取的所有信息，为了方便使用，标准库又提供了其他package `debug/gosym`来解析符号信息、行号表信息，还提供了`debug/dwarf`来解析调试信息等。

### debug/gosym

debug/gosym, this package provides a way to build Symbol Table and LineTable, etc.

 

1)    pclintab.go, it builds the line table *gosym.LineTable*, which handles LineToPC, PCToLine, etc.

2)    symtab.go, it builds the symbol table *gosym.Table*, which handles LookupSym, LookupFunc, SymByAddr, etc. Through the lookuped symbol, we can also retrieve some important information, such as retrieving line table from a Func.

 

### debug/dwarf

Dwarf v2 aims to solve how to represent the debugging information of all programming languages, there’s too much to introduce it. Dwarf debugging information may be generated and stored into many debug sections, but in package debug/dwarf, only the following debug sections are handled:

1)    .debug_abbrev

2)    .debug_info

3)    .debug_str

4)    .debug_line

5)    .debug_ranges

6)    .debug_types

 

1)    const.go, it defines the constansts defined in Dwarf, including constants for tags, attributes, operation, etc.

2)    entry.go, it defines a DIE parser, type *dwarf.Entry* abstracts a DIE entry including 3 important members, Tag(uint32), Field{Attr,Val,Class}, Children(bool).

It defines a DIE Reader for traversing the .debug_info which is constructed as a DIE tree via:

```go
f, e := elf.Open(elf)
dbg, e := f.DWARF()
r := dbg.Reader()

for {
	entry, err := r.Next()

	if err != nil || entry == nil {
		break
	}

	//do something with this DIE*
	//…
}
```

3)    line.go, each single compilation unit has a .debug_line section, it contains a sequence of LineEntry structures. In line.go, a LineReader is defined for reading this sequence of LineEntry structures.

`func (d \*dwarf.Data) LineReader(cu \*Entry) (\*LineReader, error)`, the argument must be a DIE entry with tag TagCompileUnit, i.e., we can only get the LineReader from the DIE of compilation unit.

```go
f, e := elf.Open(elf)
dbg, e := f.DWARF()
r := dbg.Reader()

for {
	entry, _ := r.Next()
	if err != nil || entry == nil {
		break;
	}

	// read the line table of this DIE

	lr, _ := dbg.LineReader(entry)
	if lr != nil {
		le := dwarf.LineEntry{}
		for {
			e := lr.Next(&le)
			if e == io.EOF {
				break;
			}
		}
	}
}
```

4)    type.go, Dwarf type information structures.

5)    typeunit.go, parse the type units stored in a Dwarf v4 .debug_types section, each type unit defines a single primary type and an 8-byte signature. Other sections may then use formRefSig8 to refer to the type.

6)    unit.go, Dwarf debug info is split into a sequence of compilation units, each unit has its own abbreviation table and address size.
