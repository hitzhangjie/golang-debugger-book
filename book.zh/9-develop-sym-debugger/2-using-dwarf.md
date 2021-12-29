## DWARF应用

前一小节我们介绍了go-delve/delve中pkg/dwarf下的各个包的作用，本节我们来了解下具体如何应用。

### ELF读取DWARF

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



### 读取类型定义

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

我们在elf_read_dwarf.go中加一个自定义类型`type Student struct{}`，然后编译。接着我们重新修改下测试代码：

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

### 读取变量

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

上面我们查看了变量的DIE、对应类型的DIE、该变量的内存地址，运行`go test -run Test_DWARFReadVariable -v`查看运行结果：

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

注意，在上述测试用例的尾部，我们还校验了变量`s:=main.Student{}`的类型定义的位置偏移量与类型`main.Student`的定义位置进行了校验。

### 读取函数定义

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

运行命令`go test -v -run Test_DWARFReadFunc`进行测试，我们看到输出了程序中定义的一些函数，也包括我们main package中的函数main.main。

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

### 读取行号表信息

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

我们首先读取测试程序fixtures/elf_read_dwarf这个文件，然后从中提取.[z]debug_line section，然后调用`line.ParseAll(...)`来解析.[z]debug_line中的数据，这个函数只是解析行号表序言然后将行号表字节码指令读取出来，并没有真正执行字节码指令来构建行号表。

什么时候构建行号表呢？当我们按需进行查询时，line.DebugLines内部就会通过内部的状态机来执行字节码指令，完成这张虚拟的行号表的构建。

在上述测试文件`fixtures/elf_read_dwarf`对应的go源文件为：

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

运行测试命令`go test -run Test_DWARFReadLineNoTable -v`，运行结果如下：

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

我们先看下`elf_read_dwarf.go:12`，这一行对应着3条指令的PC值，为什么呢？我们先反汇编看下这几条指令地址处是什么。

运行`objdump -dS fixtures/elf_read_dwarf`，并在里面检索上述几个地址，图中已用符号>标注）。

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

### 读取CFI表信息

TODO

### 本节小结

TODO



### 参考内容

1. go语言中不同数据类型对应的DWARF DIE Tag：https://sourcegraph.com/github.com/golang/go/-/blob/src/cmd/internal/dwarf/dwarf.go?L418
2. 
