## DWARF解析及应用

前面我们系统性介绍了DWARF调试信息标准的方方面面，它是什么，由谁生成，它如何描述不同的数据、类型、函数，如何描述指令地址与源码位置的映射关系，如何展开调用栈，以及具体的设计实现，等等，可以说我们对DWARF的那些高屋建瓴的设计，已经有了一定的认识。

接下来就要准备实践阶段了，在进入下一章开始开发之前，我们先了解下当前go的主流调试器go-delve/delve中对DWARF数据的读写支持，然后我们写几个测试用例验证下DWARF可以帮助我们获取到哪些信息。

### DWARF解析

介绍下[go-delve/delve](https://github.com/go-delve/delve)中的DWARF解析相关的代码，这里简单介绍下相关package的作用和使用方法，在后续小节中将有更详细的使用。

这里的介绍采用的delve源码版本为：commit cba1a524。您可以检出delve的源码的对应版本，来进一步深入了解，我们先跟随作者的节奏来快速了解。

#### 目录结构

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

#### 功能说明

对上述package的具体功能进行简单陈述：

| package      | 作用及用途                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| dwarfbuilder | 实现了一个Builder，通过该Builder可以方便地生成不同代码结构对应的DWARF调试信息，如New()返回一个Builder并初始设置DWARF信息的header字段，然后通过返回的builder增加编译单元、数据类型、变量、函数等等。`<br>`可以说，这个Builder为快速为源码生成对应的调试信息提供了很大遍历。但是这个package对于实现调试器而言应该是没多大用处的，但是对于验证go编译工具链如何生成调试信息很有帮助。一旦能认识到go编译工具链是如何生成DWARF调试信息的，我们就可以进一步了解到该如何去解析、应用对应的调试信息。`<br>`这个package的作用更多地是用于学习、验证DWARF调试信息生成和应用的。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| frame        | .[z]debug_frame中的信息可以帮助构建CFI (Canonical Frame Information)，指定任意指令地址，我们便可以借助CFI计算出当前的调用栈。`<br>`DWARF信息中的编译单元可能压缩了多个go源文件，每个编译单元都以CIE (Common Information Entry) 开始，然后接下来是一系列的FDE (Frame Description Entry)。`<br>`这里定义了类型CommonInformationEntry、FrameDescriptionEntry用来分别表示CIE、FDE。FDE里面引用CIE，CIE中包含了初始指令序列，FDE中包含了自己的指令序列，结合CIE、FDE可以构建出完整的CFI表。`<br>`为了方便判断某个指令地址是否在某个FDE范围内，类型FrameDescriptionEntry中定义了方法Cover，还提供了Begin、End来给出该FDE的范围，此外它还定义了方法EstablishFrame通过状态机执行CIE、FDE中的指令序列来按需构建CFI表的全部或者一部分，方便我们计算CFA (Canonical Frame Address) ，有了它可以进一步计算出被调函数的返回地址。`<br>`有了这个返回地址，它实际是个指令地址，我们就可以计算出对应的源码位置（如文件名、行号、函数名）。将这个返回地址继续作为指令地址去迭代处理，我们就可以计算出完整的调用栈。`<br><br>`**注意：FDE中的begin、end描述的是创建、销毁栈帧及其存在期间的指令序列instructions的地址范围，详见DWARF v4 standard。**`<br>`此外还定义了类型FrameDescriptionEntries，它实际上是一个FDE的slice，只是增加了一些帮助函数，比如FDEForPC用于通过指令地址查询包含它的FDE。`<br>`每个函数都有一个FDE，每个函数的每条指令都是按照定义时的顺序来安排虚拟的内存地址的，不存在一个函数的FDE的指令范围会包括另一个函数的FDE的指令范围的情况）。 |
| godwarf      | 这个包提供了一些基础的功能，addr.go中提供了DWARF v5中新增的.[z]debug_addr的解析能力。`<br>`sections.go中提供了读取不同文件格式中调试信息的功能，如GetDebugSectionElf能从指定elf文件中读取指定调试section的数据，并且根据section数据是否压缩自动解压缩处理。`<br>`tree.go提供了读取DIE构成的Tree的能力，一个编译单元如果不连续的话在Tree.Ranges中就存在多个地址范围，当判断一个编译单元的地址范围是否包含指定指令地址时就需要遍历Tree.Ranges进行检查，Tree.ContainsPC方法简化了这个操作。Tree.Type方法还支持读取当前TreeNode对应的类型信息。`<br>`type.go中定义了对应go数据类型的一些类型，包括基本数据类型BasicType以及基于组合扩展的CharType、UcharType、IntType等，也包括一些组合类型如StructType、SliceType、StringType等，还有其他一些类型。这些类型都是以DIE的形式存储在.[z]debug_info中的。tree.go中提供了一个非常重要的函数ReadType，它能从DWARF数据中读取定义在指定偏移量处的类型信息，并在对应类型中通过reflect.Kind来建立与go数据类型的对应关系，以后就可以很方便地利用go的reflect包来创建变量并赋值。                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| line         | 符号级调试很重要的一点是能够在指令地址与源文件名:行号之间进行转换，比如添加给语句添加断点的时候要转化成对指令地址的指令patch，或者停在某个断点处时应该显示出当前停在的源代码位置。行号表就是用来实现这个转换的，行号表被编码为一个字节码指令流，存储在.[z]debug_line中。`<br>`每个编译单元都有一个行号表，不同的编译单元的行号表数据最终会被linker合并在一起。每个行号表都有固定的结构以供解析，如header字段，然后后面跟着具体数据。`<br>`line_parser.go中提供了方法ParseAll来解析.[z]debug_line中的所有编译单元的行号表，对应类型DebugLines表示，每个编译单元对应的行号对应类型DebugLineInfo。DebugLineInfo中很重要的一个字段就是指令序列，这个指令序列也是交给一个行号表状态机去执行的，状态机实现定义在state_machine.go中，状态机执行后就能构建出完整的行号表。`<br>`有了完整的行号表，我们就可以根据pc去查表来找到对应的源码行。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| loclist      | 描述对象在内存中的位置可以用位置表达式，也可以用位置列表。如果在对象生命周期中对象的位置可能发生变化，那么就需要一个位置列表来描述。再者，如果一个对象在内存中的存储不是一个连续的段，而是多个不相邻的段合并起来，那这种也需要用位置列表来描述。`<br>`在DWARF v2~v4中，位置列表信息存储在.[z]debug_loc中，在DWARF v5中，则存储在.[z]debug_loclist中。loclist包分别针对旧版本（DWARF v2~v4）、新版本（DWARF v5）中的位置列表予以了支持。`<br>`这个包中定义了Dwarf2Reader、Dwarf5Reader分别用来从旧版本、新版本的位置列表原始数据中读取位置列表。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| op           | 先看op.go，DWARF中前面讲述地址表达式的运算时，提到了地址运算是通过执行一个基于栈操作的程序指令列表来完成的。程序指令都是1字节码指令，这里的字节码在当前package中均有定义，其需要的操作数就在栈中，每个字节码指令都有一个对应的函数stackfn，该函数执行时会对栈中的数据进行操作，取操作数并将运算结果重新入栈。最终栈顶元素即结果。`<br>`opcodes.go中定义了一系列操作码、操作码到名字映射、操作码对应操作数数量。`<br>`registers.go定义了DWARF关心的寄存器列表的信息DwarfRegisters，还提供了一些遍历的方法，如返回指定编号对应的的寄存器信息DwarfRegister、返回当前PC/SP/BP寄存器的值。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| reader       | 该包定义了类型Reader，它内嵌了go标准库中的dwarf.Reader来从.[z]debug_info中读取DIE信息，每个DIE在DWARF中被组织成一棵树的形式，每个DIE对应一个dwarf.Entry，它包括了此前提及的Tag以及[]Field（Field中记录了Attr信息），此外还记录了DIE的Offset、是否包含孩子DIE。`<br>`这里的Reader，还定义了一些其他函数如Seek、SeekToEntry、AddrFor、SeekToType、NextType、SeekToTypeNamed、FindEntryNamed、InstructionsForEntryNamed、InstructionsForEntry、NextMemberVariable、NextPackageVariable、NextCompileUnit。`<br>`该包还定义了类型Variable，其中嵌入了描述一个变量的DIE构成的树godwarf.Tree。它还提供了函数Variables用来从指定DIE树中提取包含的变量列表。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| regnum       | 定义了寄存器编号与寄存器名称的映射关系，提供了函数快速双向查询。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| leb128       | 实现了几个工具函数：从一个sleb128编码的reader中读取一个int64；从一个uleb128编码的reader中读取一个uint64；对一个int64按sleb128编码后写入writer；对一个uint64按uleb128编码后写入writer。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| dwarf        | 实现了几个工具函数：从DWARF数据中读取基本信息（长度、dwarf64、dwarf版本、字节序），读取包含的编译单元列表及对应的版本信息，从buffer中读取DWARF string，从buffer中按指定字节序读取Uint16、Uint32、Uint64，按指定字节序编码一个Uint32、Uint64并写入buffer。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

`github.com/go-delve/delve/pkg/dwarf`，沉淀了delve对DWARF数据读写操作的支持。手写一个完备的DWARF解析库，要精通DWARF调试信息标准，还要了解go编译工具链在从DWARF v4演变到DWARF v5的过程中所做的各种调整，工作量还是很大的。为了避免大家学习过程过于枯燥，我们不会再手写一个新的DWARF支持库，而是复用go-delve/delve中的实现（可能会适当裁剪，并在必要时进行强调）。

### DWARF应用

本小节相关代码您可以从这里获取：https://github.com/hitzhangjie/codemaster/tree/master/dwarf/test。

#### ELF读取DWARF

ELF文件中读取DWARF相关的调试section，并打印section名称及数据量大小：

```go
func Test_ElfReadDWARF(t *testing.T) {
	f, err := elf.Open("fixtures/elf_read_dwarf")
	assert.Nil(t, err)

	sections := []string{
		"abbrev",
		"line",
		"frame",
		"pubnames",
		"pubtypes",
		//"gdb_script",
		"info",
		"loc",
		"ranges",
	}

	for _, s := range sections {
		b, err := godwarf.GetDebugSection(f, s)
		assert.Nil(t, err)
		t.Logf(".[z]debug_%s data size: %d", s, len(b))
	}
}
```

fixtures/elf_read_dwarf由以下源程序编译而来：

```go
package main

import "fmt"

func main() {
        fmt.Println("vim-go")
}
```

`go test -v`运行结果如下：

```bash
$ go test -v

=== RUN   Test_ElfReadDWARF
    dwarf_test.go:31: .[z]debug_abbrev data size: 486
    dwarf_test.go:31: .[z]debug_line data size: 193346
    dwarf_test.go:31: .[z]debug_frame data size: 96452
    dwarf_test.go:31: .[z]debug_pubnames data size: 13169
    dwarf_test.go:31: .[z]debug_pubtypes data size: 54135
    dwarf_test.go:31: .[z]debug_info data size: 450082
    dwarf_test.go:31: .[z]debug_loc data size: 316132
    dwarf_test.go:31: .[z]debug_ranges data size: 76144
--- PASS: Test_ElfReadDWARF (0.01s)
PASS
ok      github.com/hitzhangjie/codemaster/dwarf/test    0.015s

```

#### 读取类型定义

仍以上面的elf_read_dwarf为例，读取其中定义的所有类型：

```go
func Test_DWARFReadTypes(t *testing.T) {
	f, err := elf.Open("fixtures/elf_read_dwarf")
	assert.Nil(t, err)

	dat, err := f.DWARF()
	assert.Nil(t, err)

	rd := reader.New(dat)

	for {
		e, err := rd.NextType()
		if err != nil {
			break
		}
		if e == nil {
			break
		}
		t.Logf("read type: %s", e.Val(dwarf.AttrName))
	}
}
```

`go test -run Test_DWARFReadTypes -v`运行结果如下：

```
$ go test -run Test_DWARFReadTypes -v

=== RUN   Test_DWARFReadTypes
    dwarf_test.go:54: read type: <unspecified>
    dwarf_test.go:54: read type: unsafe.Pointer
    dwarf_test.go:54: read type: uintptr
    dwarf_test.go:54: read type: runtime._type
    dwarf_test.go:54: read type: runtime._type
    dwarf_test.go:54: read type: uint32
    dwarf_test.go:54: read type: runtime.tflag
    dwarf_test.go:54: read type: uint8
    dwarf_test.go:54: read type: func(unsafe.Pointer, unsafe.Pointer) bool
    dwarf_test.go:54: read type: func(unsafe.Pointer, unsafe.Pointer) bool
    dwarf_test.go:54: read type: bool
    dwarf_test.go:54: read type: *bool
    dwarf_test.go:54: read type: *uint8
    dwarf_test.go:54: read type: runtime.nameOff
    dwarf_test.go:54: read type: runtime.typeOff
    ...
    dwarf_test.go:54: read type: waitq<int>
    dwarf_test.go:54: read type: *sudog<int>
    dwarf_test.go:54: read type: hchan<int>
    dwarf_test.go:54: read type: *hchan<int>
--- PASS: Test_DWARFReadTypes (0.06s)
PASS
ok      github.com/hitzhangjie/codemaster/dwarf/test    0.067s
```

这里，我们没有显示类型具体定义在哪个源文件中，如果想获取所处源文件的话，需要结合编译单元对应的DIE来完成。

我们在elf_read_dwarf.go中加一个自定义类型 `type Student struct{}`，然后编译。接着我们重新修改下测试代码：

```go
func Test_DWARFReadTypes2(t *testing.T) {
	f, err := elf.Open("fixtures/elf_read_dwarf")
	assert.Nil(t, err)

	dat, err := f.DWARF()
	assert.Nil(t, err)

	var cuName string
	var rd = reader.New(dat)
	for {
		entry, err := rd.Next()
		if err != nil {
			break
		}
		if entry == nil {
			break
		}

		switch entry.Tag {
		case dwarf.TagCompileUnit:
			cuName = entry.Val(dwarf.AttrName).(string)
			t.Logf("- CompilationUnit[%s]", cuName)
		case dwarf.TagArrayType,
			dwarf.TagBaseType,
			dwarf.TagClassType,
			dwarf.TagStructType,
			dwarf.TagUnionType,
			dwarf.TagConstType,
			dwarf.TagVolatileType,
			dwarf.TagRestrictType,
			dwarf.TagEnumerationType,
			dwarf.TagPointerType,
			dwarf.TagSubroutineType,
			dwarf.TagTypedef,
			dwarf.TagUnspecifiedType:
			t.Logf("  cu[%s] define [%s]", cuName, entry.Val(dwarf.AttrName))
		}
	}
}
```

`go test -run Test_DWARFReadTypes2`运行结果如下：

```bash
$ go test -run Test_DWARFReadTypes2
    dwarf_test.go:80: - CompilationUnit[sync]
    dwarf_test.go:80: - CompilationUnit[internal/cpu]
    dwarf_test.go:80: - CompilationUnit[runtime/internal/sys]
    dwarf_test.go:80: - CompilationUnit[fmt]
    dwarf_test.go:80: - CompilationUnit[runtime/internal/atomic]
    ...
    dwarf_test.go:94:   cu[runtime] define [fmt.Stringer]
    dwarf_test.go:94:   cu[runtime] define [main.Student]
    dwarf_test.go:94:   cu[runtime] define [[]strconv.leftCheat]
    ...
```

可以看到输出结果中显示编译单元runtime中定义了类型main.Student，奇怪了为什么是编译单元runtime中而非main，源码中命名是main.Student定义在package main中的。这里的编译单元可能会合并多个go源文件对应的目标文件，因此这个问题也就好理解了。

我们现在还可以按照类型名定位对应的类型DIE：

```go
func Test_DWARFReadTypes3(t *testing.T) {
	f, err := elf.Open("fixtures/elf_read_dwarf")
	assert.Nil(t, err)

	dat, err := f.DWARF()
	assert.Nil(t, err)

	var rd = reader.New(dat)

	entry, err := rd.SeekToTypeNamed("main.Student")
	assert.Nil(t, err)
	fmt.Println(entry)
}
```

`go test -v -run Test_DWARFReadTypes3`运行测试结果如下：

```bash
go test -run Test_DWARFReadTypes3 -v

=== RUN   Test_DWARFReadTypes3
&{275081 StructType true [{Name main.Student ClassString} {ByteSize 0 ClassConstant} {Attr(10496) 25 ClassConstant} {Attr(10500) 59904 ClassAddress}]}
--- PASS: Test_DWARFReadTypes3 (0.02s)
PASS
ok      github.com/hitzhangjie/codemaster/dwarf/test    0.020s
```

这里的类型信息如何理解呢？这就需要结合前面讲过的DWARF如何描述数据类型相关的知识点慢慢进行理解了。不用担心，后面我们仍然会遇到这里的知识点，到时候会再次结合相关知识点来描述。

#### 读取变量

现在读取变量定义对我们来说也不是什么难事了，我们来看个示例：

```go
package main

import "fmt"

type Student struct{}

func main() {
    s := Student{}
    fmt.Println(s)
}
```

现在我们尝试获取上述main中的变量s的信息：

```go
func Test_DWARFReadVariable(t *testing.T) {
	f, err := elf.Open("fixtures/elf_read_dwarf")
	assert.Nil(t, err)

	dat, err := f.DWARF()
	assert.Nil(t, err)

	var rd = reader.New(dat)
	for {
		entry, err := rd.Next()
		if err != nil {
			break
		}
		if entry == nil {
			break
		}
		// 只查看变量
		if entry.Tag != dwarf.TagVariable {
			continue
		}
		// 只查看变量名为s的变量
		if entry.Val(dwarf.AttrName) != "s" {
			continue
		}
		// 通过offset限制，只查看main.main中定义的变量名为s的变量
        // 这里的0x432b9是结合`objdump --dwarf=info`中的结果来硬编码的
		if entry.Val(dwarf.AttrType).(dwarf.Offset) != dwarf.Offset(0x432b9) {
			continue
		}

		// 查看变量s的DIE
		fmt.Println("found the variable[s]")
		fmt.Println("DIE variable:", entry)

		// 查看变量s对应的类型的DIE
		ee, err := rd.SeekToType(entry, true, true)
		assert.Nil(t, err)
		fmt.Println("DIE type:", ee)

		// 查看变量s对应的地址 [lowpc, highpc, instruction]
		fmt.Println("location:", entry.Val(dwarf.AttrLocation))
  
		// 最后在手动校验下main.Student的类型与上面看到的变量的类型是否一致
		// 应该满足：main.Student DIE的位置 == 变量的类型的位置偏移量
		typeEntry, err := rd.SeekToTypeNamed("main.Student")
		assert.Nil(t, err)
		assert.Equal(t, typeEntry.Val(dwarf.AttrType), variableTypeEntry.Offset)
		break
	}
}
```

上面我们查看了变量的DIE、对应类型的DIE、该变量的内存地址，运行 `go test -run Test_DWARFReadVariable -v`查看运行结果：

```bash
$ go test -run Test_DWARFReadVariable -v

=== RUN   Test_DWARFReadVariable
found the variable[s]
DIE variable: &{324895 Variable false [{Name s ClassString} {DeclLine 11 ClassConstant} {Type 275129 ClassReference} {Location [145 168 127] ClassExprLoc}]}
DIE type: &{275081 StructType true [{Name main.Student ClassString} {ByteSize 24 ClassConstant} {Attr(10496) 25 ClassConstant} {Attr(10500) 74624 ClassAddress}]}
location: [145 168 127]
--- PASS: Test_DWARFReadVariable (0.02s)
PASS
ok      github.com/hitzhangjie/codemaster/dwarf/test    0.023s

```

注意，在上述测试用例的尾部，我们还校验了变量 `s:=main.Student{}`的类型定义的位置偏移量与类型 `main.Student`的定义位置进行了校验。

#### 读取函数定义

现在读取下程序中的函数、方法、匿名函数的定义：

```go
func Test_DWARFReadFunc(t *testing.T) {
	f, err := elf.Open("fixtures/elf_read_dwarf")
	assert.Nil(t, err)

	dat, err := f.DWARF()
	assert.Nil(t, err)

	rd := reader.New(dat)
	for {
		die, err := rd.Next()
		if err != nil {
			break
		}
		if die == nil {
			break
		}
		if die.Tag == dwarf.TagSubprogram {
			fmt.Println(die)
		}
	}
}
```

运行命令 `go test -v -run Test_DWARFReadFunc`进行测试，我们看到输出了程序中定义的一些函数，也包括我们main package中的函数main.main。

```bash
$ go test -v -run Test_DWARFReadFunc

=== RUN   Test_DWARFReadFunc
&{73 Subprogram true [{Name sync.newEntry ClassString} {Lowpc 4725024 ClassAddress} {Highpc 4725221 ClassAddress} {FrameBase [156] ClassExprLoc} {DeclFile 3 ClassConstant} {External true ClassFlag}]}
&{149 Subprogram true [{Name sync.(*Map).Load ClassString} {Lowpc 4725248 ClassAddress} {Highpc 4726474 ClassAddress} {FrameBase [156] ClassExprLoc} {DeclFile 3 ClassConstant} {External true ClassFlag}]}
&{272 Subprogram true [{Name sync.(*entry).load ClassString} {Lowpc 4726496 ClassAddress} {Highpc 4726652 ClassAddress} {FrameBase [156] ClassExprLoc} {DeclFile 3 ClassConstant} {External true ClassFlag}]}
&{368 Subprogram true [{Name sync.(*Map).Store ClassString} {Lowpc 4726656 ClassAddress} {Highpc 4728377 ClassAddress} {FrameBase [156] ClassExprLoc} {DeclFile 3 ClassConstant} {External true ClassFlag}]}
...
&{324861 Subprogram true [{Name main.main ClassString} {Lowpc 4949568 ClassAddress} {Highpc 4949836 ClassAddress} {FrameBase [156] ClassExprLoc} {DeclFile 2 ClassConstant} {External true ClassFlag}]}
...
&{450220 Subprogram true [{Name reflect.methodValueCall ClassString} {Lowpc 4856000 ClassAddress} {Highpc 4856091 ClassAddress} {FrameBase [156] ClassExprLoc} {DeclFile 1 ClassConstant} {External true ClassFlag}]}
--- PASS: Test_DWARFReadFunc (41.67s)
PASS
ok      github.com/hitzhangjie/codemaster/dwarf/test    41.679s
```

go程序中除了上述tag为DW_TAG_subprogram的DIE与函数有关，DW_TAG_subroutine_type、DW_TAG_inlined_subroutine_type、DW_TAG_inlined_subroutine也与之有关，后面有机会再展开介绍。

#### 读取行号表信息

现在尝试读取程序中的行号表信息：

```go
func Test_DWARFReadLineNoTable(t *testing.T) {
	f, err := elf.Open("fixtures/elf_read_dwarf")
	assert.Nil(t, err)

	dat, err := godwarf.GetDebugSection(f, "line")
	assert.Nil(t, err)

	lineToPCs := map[int][]uint64{10: nil, 12: nil, 13: nil, 14: nil, 15: nil}

	debuglines := line.ParseAll(dat, nil, nil, 0, true, 8)
	fmt.Println(len(debuglines))
	for _, line := range debuglines {
		//fmt.Printf("idx-%d\tinst:%v\n", line.Instructions)
		line.AllPCsForFileLines("/root/dwarftest/dwarf/test/fixtures/elf_read_dwarf.go", lineToPCs)
	}

	for line, pcs := range lineToPCs {
		fmt.Printf("lineNo:[elf_read_dwarf.go:%d] -> PC:%#x\n", line, pcs)
	}
}
```

我们首先读取测试程序fixtures/elf_read_dwarf这个文件，然后从中提取.[z]debug_line section，然后调用 `line.ParseAll(...)`来解析.[z]debug_line中的数据，这个函数只是解析行号表序言然后将行号表字节码指令读取出来，并没有真正执行字节码指令来构建行号表。

什么时候构建行号表呢？当我们按需进行查询时，line.DebugLines内部就会通过内部的状态机来执行字节码指令，完成这张虚拟的行号表的构建。

在上述测试文件 `fixtures/elf_read_dwarf`对应的go源文件为：

```go
1:package main
2:
3:import "fmt"
4:
5:type Student struct {
6:    Name string
7:    Age  int
8:}
9:
10:type Print func(s string, vals ...interface{})
11:
12:func main() {
13:    s := Student{}
14:    fmt.Println(s)
15:}
```

我们取上述源文件中的第10、12、13、14、15行还用来查询其对应的指令的PC值，`line.AllPCsForFileLines`将协助完成这项操作，并将结果存储到传入的map中。然后我们将这个map打印出来。

运行测试命令 `go test -run Test_DWARFReadLineNoTable -v`，运行结果如下：

```bash
$ go test -run Test_DWARFReadLineNoTable -v

=== RUN   Test_DWARFReadLineNoTable
41
lineNo:[elf_read_dwarf.go:12] -> PC:[0x4b8640 0x4b8658 0x4b8742]
lineNo:[elf_read_dwarf.go:13] -> PC:[0x4b866f]
lineNo:[elf_read_dwarf.go:14] -> PC:[0x4b8680 0x4b86c0]
lineNo:[elf_read_dwarf.go:15] -> PC:[0x4b8729]
lineNo:[elf_read_dwarf.go:10] -> PC:[]
--- PASS: Test_DWARFReadLineNoTable (0.00s)
PASS

Process finished with the exit code 0
```

我们可以看到源码中的lineno被映射到了对应的PC slice，因为有的源码语句可能对应着多条机器指令，指令地址当然也就有多个，这个很好理解，先不深究。可是按我们之前理解的行号表设计，每个行号处，只保留一个指令地址就可以了，为什么这里会有多个指令地址呢？

我们先看下 `elf_read_dwarf.go:12`，这一行对应着3条指令的PC值，为什么呢？我们先反汇编看下这几条指令地址处是什么。

运行 `objdump -dS fixtures/elf_read_dwarf`，并在里面检索上述几个地址，图中已用符号>标注）。

```bash
func main() {
> 4b8640:       64 48 8b 0c 25 f8 ff    mov    %fs:0xfffffffffffffff8,%rcx
  4b8647:       ff ff 
  4b8649:       48 8d 44 24 e8          lea    -0x18(%rsp),%rax
  4b864e:       48 3b 41 10             cmp    0x10(%rcx),%rax
  4b8652:       0f 86 ea 00 00 00       jbe    4b8742 <main.main+0x102>
> 4b8658:       48 81 ec 98 00 00 00    sub    $0x98,%rsp
  4b865f:       48 89 ac 24 90 00 00    mov    %rbp,0x90(%rsp)
  4b8666:       00 
  4b8667:       48 8d ac 24 90 00 00    lea    0x90(%rsp),%rbp
  4b866e:       00 
        s := Student{}
  4b866f:       0f 57 c0                xorps  %xmm0,%xmm0
  4b8672:       0f 11 44 24 48          movups %xmm0,0x48(%rsp)
  4b8677:       48 c7 44 24 58 00 00    movq   $0x0,0x58(%rsp)
  4b867e:       00 00 
        fmt.Println(s)
  4b8680:       0f 57 c0                xorps  %xmm0,%xmm0
  ...
  ...
  4b873e:       66 90                   xchg   %ax,%ax
  4b8740:       eb ac                   jmp    4b86ee <main.main+0xae>
func main() {
> 4b8742:       e8 b9 36 fb ff          callq  46be00 <runtime.morestack_noctxt>
  4b8747:       e9 f4 fe ff ff          jmpq   4b8640 <main.main>
  4b874c:       cc                      int3   
  4b874d:       cc                      int3 
```

这几条指令地址处确实比较特殊：

- 0x4b8640，该地址是函数的入口地址；
- 0x4b8742，该地址对应的是runtime.morestack_noctxt的位置，对go协程栈有过了解的都清楚，该函数会检查是否需要将当前函数的栈帧扩容；
- 0x4b8658，该地址则是在按需扩容栈帧后的分配栈帧动作；

虽然这几个地址比较特殊，看上去也比较重要，但是为什么会关联3个PC值还是让人费解，我们继续看下elf_read_dwarf.go:14，并检索对应的指令位置（图中已用符号>标注）。

```bash
        fmt.Println(s)
> 4b8680:       0f 57 c0                xorps  %xmm0,%xmm0
  4b8683:       0f 11 44 24 78          movups %xmm0,0x78(%rsp)
  4b8688:       48 c7 84 24 88 00 00    movq   $0x0,0x88(%rsp)
  4b868f:       00 00 00 00 00 
  4b8694:       0f 57 c0                xorps  %xmm0,%xmm0
  4b8697:       0f 11 44 24 38          movups %xmm0,0x38(%rsp)
  4b869c:       48 8d 44 24 38          lea    0x38(%rsp),%rax
  4b86a1:       48 89 44 24 30          mov    %rax,0x30(%rsp)
  4b86a6:       48 8d 05 d3 2c 01 00    lea    0x12cd3(%rip),%rax        # 4cb380 <type.*+0x12380>
  4b86ad:       48 89 04 24             mov    %rax,(%rsp)
  4b86b1:       48 8d 44 24 78          lea    0x78(%rsp),%rax
  4b86b6:       48 89 44 24 08          mov    %rax,0x8(%rsp)
  4b86bb:       0f 1f 44 00 00          nopl   0x0(%rax,%rax,1)
> 4b86c0:       e8 3b 27 f5 ff          callq  40ae00 <runtime.convT2E>
  4b86c5:       48 8b 44 24 30          mov    0x30(%rsp),%rax
  4b86ca:       84 00                   test   %al,(%rax)

```

一起来看下这两条指令地址有什么特殊的：

- 0x4b8680，该地址处的指令很明显是准备调用函数fmt.Println(s)前的一些准备动作，具体做什么也不用关心无非是准备参数、返回值这些；
- 0x4b86c0，该地址处的指令很明显是准备调用运行时函数runtime.convT2E，应该是将string变量s转换成eface，然后再交给后续的fmt.Println去打印；

这么分析下来，一个lineno对应多个PC的情况下也没什么大问题，我们可以使用其中的任何一个作为断点来设置，这么想似乎也没什么不对，那为什么要有多个PC值呢？

- 这是bug吗？应该不是，我认为这是go编译器、链接器有意这样生成的。
- 为什么这样生成呢？首先可以肯定的是，`line.AllPCsForFileLines`已经是根据行号表字节码指令运算出来的lineno到PC slice的映射关系了，算出来的结果也绝不是全量存储lineno对应的所有PC值。在此基础上考虑为什么会有多个PC。假设我们想对程序分析地更透彻一点，除了用户程序还可能包含go runtime等各种细节，如runtime.convT2E、runtime.morestack_noctxt，如果编译器、链接器指导生成的DWARF中包含了这样的字节码指令，有意让同一个lineno对应多个PC，我认为只可能是为了方便更精细化的调试，允许调试器不仅调试用户代码，也允许调试go runtime本身。

关于行号表的读取和说明就先到这，我们后续用到的时候会进一步展开。

#### 读取CFI表信息

接下来读取CFI（Call Frame Information）信息表：

```go
func Test_DWARFReadCFITable(t *testing.T) {
	f, err := elf.Open("fixtures/elf_read_dwarf")
	assert.Nil(t, err)

	// 解析.[z]debug_frame中CFI信息表
	dat, err := godwarf.GetDebugSection(f, "frame")
	assert.Nil(t, err)
	fdes, err := frame.Parse(dat, binary.LittleEndian, 0, 8, 0)
	assert.Nil(t, err)
	assert.NotEmpty(t, fdes)

	//for idx, fde := range fdes {
	//	fmt.Printf("fde[%d], begin:%#x, end:%#x\n", idx, fde.Begin(), fde.End())
	//}

	for _, fde := range fdes {
		if !fde.Cover(0x4b8640) {
			continue
		}
		fmt.Printf("address 0x4b8640 is covered in FDE[%#x,%#x]\n", fde.Begin(), fde.End())
		fc := fde.EstablishFrame(0x4b8640)
		fmt.Printf("retAddReg: %s\n", regnum.AMD64ToName(fc.RetAddrReg))
		switch fc.CFA.Rule {
		case frame.RuleCFA:
			fmt.Printf("cfa: rule:RuleCFA, CFA=(%s)+%#x\n", regnum.ARM64ToName(fc.CFA.Reg), fc.CFA.Offset)
		default:
		}
	}
}
```

我们首先读取elf文件中的.[z]debug_frame section，然后利用 `frame.Parse(...)`方法完成CFI信息表的解析，解析后的数据存储在类型为 `FrameDescriptionEntries`的变量fdes中，这个类型其实是 `type FrameDescriptionEntries []*FrameDescriptionEntry`，只不过在这个类型上增加了一些方便易用的方法，如比较常用的 `FDEForPC(pc)`用来返回FDE指令地址范围包含pc的那个FDE。

我们可以遍历fdes将每个fde的指令地址范围打印出来。

在读取行号表信息时，我们了解到0x4b8640这个地址为main.main的入口地址，我们不妨拿这条指令来进一步做下测试。我们遍历所有的FDE来检查到底哪个FDE的指令地址范围包含main.main入口指令0x4b8640。

> ps: 其实这里的遍历+fde.Cover(pc)可以通过通过fdes.FDEForPC代替，这里只是为了演示FrameDescriptionEntry提供了Cover方法。

当找到的时候，我们就检查要计算当前pc 0x4b8640对应的CFA（Canonical Frame Address）。估计对CFA的概念又不太清晰了，再解释下CFA的概念：

> **DWARFv5 Call Frame Information L8:L12**:
>
> An area of memory that is allocated on a stack called a “call frame.” The call frame is identiﬁed by an address on the stack. We refer to this address as the Canonical Frame Address or CFA. Typically, the CFA is deﬁned to be the value of the stack pointer at the call site in the previous frame (which may be different from its value on entry to the current frame).

有了这个CFA我们就可以找到当前pc对应的栈帧以及caller的栈帧，以及caller的caller的栈帧……每个函数调用对应的栈帧中都有返回地址，返回地址实际为指令地址，借助行号表我们又可以将指令地址映射为源码中的文件名和行号，这样就可以很直观地显示当前pc的调用栈信息。

当然，CFI信息表提供的不光是CFA的计算，它还记录了指令执行过程中对其他寄存器的影响，因此还可以显示不同栈帧中时寄存器的值。通过在不同栈帧中游走，还可以看到栈帧中定义的局部变量的值。

关于CFI的使用我们就先简单介绍到这，后面实现符号级调试时再进一步解释。

### 本节小结

本小节我们介绍了 `github.com/go-delve/delve/pkg/dwarf` 的一些DWARF支持，然后使用这些包编写了一些测试用例，分别测试了读取数据类型定义、读取变量、读取函数定义、读取行号表、读取调用栈信息表，通过编写这些测试用例，我们加深了对DWARF解析以及应用的理解。
