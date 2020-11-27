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

ELF文件中符号表信息一般会存储在`.symtab` section中，go程序有点特殊在go1.2及之前的版本有一个特殊的.gosymtab，其中存储了接近plan9风格的符号表结构信息，但是在go1.3之后，.gosymtab不再包含任何符号信息。

还注意到，ELF文件中行号表信息，如果是DWARF调试信息格式的话，一般会存储在debug_line或者.zdebug_line中，go程序又有点特殊，它存在一个名为`.gopclntab`的section，其中保存了go程序的行号表信息。

那么，go为什么不适用.debug/.zdebug前缀的sections呢？为什么要独立添加一个.gosymtab、.gopclntab呢？这几个section有什么区别呢？

我们很确定的是.debug/.zdebug前缀开头的sections中包含的是调试信息，是给调试器等使用的，.gosymtab、.gopclntab则是给go运行时使用的。go程序执行时，其运行时部分会加载.gosymtab、.gopclntab的数据到进程内存中，用来执行栈跟踪（stack tracebacks），比如runtime.Callers，.symtab、.debug/.zdebug sections并没有被加载到内存中，它是由外部调试器来读取并加载的，如gdb、delve。

可能会有疑问，为什么go程序不直接利用.symtab、.debug/.zdebug sections呢，这几个sections中的数据结合起来也足以实现栈跟踪？

目前我了解到的是，DWARF数据的解析、使用应该会更复杂一点，go开发者在尝试plan9的工作时就已经有了类似pclntab的经验，早期go程序也沿用了这种经验，并且早期pclntab的存储结构与plan9下程序的pclntab很接近，但是现在已经差别很大了，可以参考 [Go 1.2 Runtime Symbol Information](https://docs.google.com/document/d/1lyPIbmsYbXnpNj57a261hgOYVpNRcgydurVQIyZOz_o/pub)。

> TODO ps: 另外提一下，cgo程序中，似乎是没有.gosymtab、.gopclntab的。

通过package `debug/gosym`可以构建出pcln table，通过其方法PcToLine、LineToPc等，可以帮助我们快速查询指令地址与源文件中位置的关系，也可以通过它来进一步分析调用栈，如程序panic时我们希望打印调用栈来定位出错的位置。

我理解，对调用栈信息的支持才是.gosymtab、.gopclntab所主要解决的问题，go1.3之后调用栈数据应该是完全由.gopclntab支持了，所以.gosymtab也就为空了。所以它和调试器需要的.debug/.zdebug_frame有着本质区别，后者不但可以追踪调用栈信息，也可以追踪每一个栈帧中的寄存器数据的变化，其数据编码、解析、运算逻辑也更加复杂。

现在我们应该清楚package debug/gosym以及对应.gosymtab、.gopclntab sections的用途了，也应该清楚与.symtab以及调试相关的.debug/.zdebug_这些sections的区别了。 

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



参考内容：

1. How to Fool Analysis Tools,

   https://tuanlinh.gitbook.io/ctf/golang-function-name-obfuscation-how-to-fool-analysis-tools

2. Go 1.2 Runtime Symbol Information, Russ Cox,

   https://docs.google.com/document/d/1lyPIbmsYbXnpNj57a261hgOYVpNRcgydurVQIyZOz_o/pub

3. Some notes on the structure of Go Binaries,

   https://utcc.utoronto.ca/~cks/space/blog/programming/GoBinaryStructureNotes

4. Buiding a better Go Linker, Austin Clements,

   https://docs.google.com/document/d/1D13QhciikbdLtaI67U6Ble5d_1nsI4befEd6_k1z91U/view

