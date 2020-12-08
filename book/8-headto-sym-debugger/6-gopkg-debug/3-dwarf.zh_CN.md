## pkg debug/dwarf 应用

### 数据类型及关系

标准库提供了package `debug/dwarf` 来读取go工具链为外部调试器生成的一些DWARF数据，如.debug_info、.debug_line等等。

注意go生成DWARF调试信息时，可能会考虑减少go binary尺寸，所以会对DWARF信息进行压缩后，再存储到不同的section中，比如开启压缩前，描述types、variables、function定义的未压缩的.debug_info数据，开启压缩压缩后的数据将被保存到.zdebug_info中，其他几个调试用section类似。在读取调试信息需要注意一下。

package debug/dwarf中的相关重要数据结构，如下图所示：

![image-20201206022523363](assets/image-20201206022523363.png)

当我们打开了一个elf.File之后，便可以读取DWARF数据，当我们调用elf.File.Data()时便可以返回读取、解析后的DWARF数据，接下来便是在此基础上进一步读取DWARF中的各类信息，以及与对源码的理解结合起来。

### 常用操作及示例

#### 读取DWARF数据

读取DWARF数据之前，首先要打开elf文件，然后再读取DWARF相关的多个sections并解析，索性后面两步操作go标准库已经帮我们实现了，并且考虑了DWARF数据压缩、解压缩的问题。

下面的程序打开一个elf文件并返回解析后的DWARF数据：

```go
import (
    "debug/elf"
     "fmt"
)
func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run main.go <prog>")
		os.Exit(1)
	}
	prog := os.Args[1]

	// open elf
	file, err := elf.Open(prog)
	if err != nil {
		panic(err)
	}
    
    // dwarf调试信息遍历
	dw, err := file.DWARF()
	if err != nil {
		panic(err)
	}
    fmt.Println("read dwarf ok")
}
```

运行测试go run main.go ../testdata/loop2`，程序只是简单地打印一行读取成功的信息，在此基础上我们将实现DWARF数据中各类信息的读取。

#### 读取编译单元信息

当我们从elf文件拿到DWARF数据dwarf.Data之后，我们就可以从dwarf.Data中读取各种类型的数据。在读取之前要理解DWARF数据的组织，以及go标准库实现的一点内容。

工程中可能包含了多个源文件，每个源文件是一个编译单元，一个目标文件中可能包含了多个编译单元。生成调试信息时每一个目标文件对应一个tag类型为DW_TAG_compile_unit的DIE。该DIE的childrens又包含了其他丰富的信息，如函数、函数中的变量等，这些信息都是通过DWARF DIE来表述的。

> go编译单元是如何产生的，go tool compile *.go，依赖的源文件也会被一同编译成同一个目标文件，而不是每个源文件一个目标文件。因为c、c++允许通过extern来声明外部定义的变量，然后在当前文件中使用，每个文件是可以独立编译成一个目标文件的，这点上go有些差异。

`rd := dwarf.Data.Reader()`会返回一个reader对象，通过`rd.Next()`将能够遍历编译单元中及其包含	的所有类型、变量、函数等对应的DIE列表。

下面我们先尝试遍历所有的编译单元信息。

```go
package main

import (
	"debug/dwarf"
	"debug/elf"
	"fmt"
	"os"
	"text/tabwriter"
)

func main() {
    ...
    dw, err := file.DWARF()
    ...
    
    err = iterateComplilationUnit(dw)
	if err != nil {
		fmt.Println(err)
	}
}

func iterateComplilationUnit(dw *dwarf.Data) error {
	rd := dw.Reader()

	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 3, ' ', 0)
	fmt.Fprintf(tw, "No.\tTag\tName\tLanguage\tStmtList\tLowPC\tRanges\tOthers\n")
	defer tw.Flush()

	for idx := 0; ; idx++ {
		entry, err := rd.Next()
		if err != nil {
			return fmt.Errorf("iterate entry error: %v", err)
		}
		if entry == nil {
			fmt.Println("iterate entry finished")
			return nil
		}
		if entry.Tag != dwarf.TagCompileUnit {
			continue
		}
		fmt.Fprintf(tw, "%d\t%s\t%v\t%v\t%v\t%v\t%v\n",
			idx,
			entry.Tag.String(), entry.Field[0].Val,
			entry.Field[1].Val, entry.Field[2].Val,
			entry.Field[3].Val, entry.Field[4].Val, )
	}
}
```

执行测试`go run main.go ../testdata/loop2`，程序输出了如下信息：

```bash
$ go run main.go ../testdata/loop2

Tag           Name                      Language   StmtList   LowPC     Ranges   Others
CompileUnit   sync                      22         0          4724928   0
CompileUnit   internal/cpu              22         3626       4198400   32
CompileUnit   internal/cpu              22         4715       4201888   80
CompileUnit   runtime/internal/sys      22         4846       4202336   112
CompileUnit   fmt                       22         5513       4906048   144
CompileUnit   runtime/internal/atomic   22         14330      4202560   176
CompileUnit   strconv                   22         160219     4653184   944
...........   .......                   ..         ......     .......   ...
CompileUnit   syscall                   22         167358     4883104   992
CompileUnit   internal/oserror          22         170142     4882624   1040
CompileUnit   io                        22         170356     4881888   1072
CompileUnit   internal/fmtsort          22         170746     4873280   1104
CompileUnit   sort                      22         171968     4870400   1136
CompileUnit   unicode/utf8              22         172957     4676128   1168
CompileUnit   reflect                   22         174048     4767616   1200
CompileUnit   sync/atomic               22         194816     4658240   1248
CompileUnit   sync/atomic               22         195127     4658976   1280
CompileUnit   unicode                   22         195267     4742624   1312
CompileUnit   runtime                   22         195635     4631616   1344
CompileUnit   reflect                   22         195725     4855840   1376
```

#### 读取函数定义

DIE描述代码，前面提到了编译单元是tag为DW_TAG_compile_unit的DIE来描述的，读取完该DIE之后，可继续读取编译单元中的函数定义，即tag为DW_TAG_subprogram的一系列DIE。读取了每个函数的同时，函数内部又包含一些局部变量定义等，即tag为DW_TAG_variable的一系列DIE。

它们之间的关系，大致如下所示：

```bash
  DW_TAG_compile_unit
    ...
    DW_TAG_subprogram
      ...
      DW_TAG_variable
        DW_AT_name: "a"
        DW_AT_type: (signature) 0xd681845c 21a14576
        DW_AT_location: ...
    ...
```

这里我们以读取main.main为例，演示下如何读取编译单元中的函数、变量信息。

**main.go**

```go
package main

import (
	"debug/dwarf"
	"debug/elf"
	"fmt"
	"os"
)

func main() {
    ...
	dw, err := file.DWARF()
	...
    
	err = parseDebugInfo(dw)
	if err != nil {
		fmt.Println(err)
	}
}

// Variable 函数局部变量信息
type Variable struct {
	Name string
}

// Function 函数信息，包括函数名、定义的源文件、包含的变量
type Function struct {
	Name      string
	DeclFile  string
	Variables []*Variable
}

// CompileUnit 编译单元，包括一系列源文件、函数定义
type CompileUnit struct {
	Source []string
	Funcs  []*Function
}

var compileUnits = []*CompileUnit{}

func parseDebugInfo(dw *dwarf.Data) error {
	rd := dw.Reader()

	var curCompileUnit *CompileUnit
	var curFunction *Function

	for idx := 0; ; idx++ {
		entry, err := rd.Next()
		if err != nil {
			return fmt.Errorf("iterate entry error: %v", err)
		}
		if entry == nil {
			return nil
		}

		if entry.Tag == dwarf.TagCompileUnit {
			lrd, err := dw.LineReader(entry)
			if err != nil {
				return err
			}

			cu := &CompileUnit{}
			curCompileUnit = cu

			for _, v := range lrd.Files() {
				if v == nil {
					continue
				}
				cu.Source = append(cu.Source, v.Name)
			}
			compileUnits = append(compileUnits, cu)
		}

		if entry.Tag == dwarf.TagSubprogram {
			fn := &Function{
				Name:     entry.Val(dwarf.AttrName).(string),
				DeclFile: curCompileUnit.Source[entry.Val(dwarf.AttrDeclFile).(int64)-1],
			}
			curFunction = fn
			curCompileUnit.Funcs = append(curCompileUnit.Funcs, fn)

            // 如果是main.main函数，打印一下entry，方便我们印证
			if fn.Name == "main.main" {
				printEntry(entry)
				fmt.Printf("main.main is defined in %s\n", fn.DeclFile)
			}
		}

		if entry.Tag == dwarf.TagVariable {
			variable := &Variable{
				Name: entry.Val(dwarf.AttrName).(string),
			}
			curFunction.Variables = append(curFunction.Variables, variable)
            // 如果当前变量定义在main.main中，打印一下entry，方便我们印证
			if curFunction.Name == "main.main" {
				printEntry(entry)
			}
		}
	}
	return nil
}

// 打印每个DIE的详细信息，调试使用，方便我们根据具体结构编写代码
func printEntry(entry *dwarf.Entry) {
	fmt.Println("children:", entry.Children)
	fmt.Println("offset:", entry.Offset)
	fmt.Println("tag:", entry.Tag.String())
	for _, f := range entry.Field {
		fmt.Println("attr:", f.Attr, f.Val, f.Class)
	}
}
```

在执行测试之前，我们也说一下用来测试的源程序，注意我们在main.main中定义了一个变量pid。

**testdata/loop2.go**

```go
     1  package main
     2  
     3  import "fmt"
     4  import "os"
     5  import "time"
     6  
     7  func init() {
		....
    14  }
    15  func main() {
    16      pid := os.Getpid()
    17      for {
    18          fmt.Println("main.main pid:", pid)
    19          time.Sleep(time.Second * 3)
    20      }
    21  }

```

执行测试`go run main.go ../testdata/loop2`，程序输出如下信息：

```bash
$ go run main.go ../testdata/loop2 
children: true
offset: 324423
tag: Subprogram
attr: Name main.main ClassString
attr: Lowpc 4949376 ClassAddress
attr: Highpc 4949656 ClassAddress
attr: FrameBase [156] ClassExprLoc
attr: DeclFile 2 ClassConstant
attr: External true ClassFlag

main.main is defined in /root/debugger101/testdata/loop2.go

children: false
offset: 324457
tag: Variable
attr: Name pid ClassString
attr: DeclLine 16 ClassConstant
attr: Type 221723 ClassReference
attr: Location [145 160 127] ClassExprLoc
```

上面程序中打印了main.main对应的subprogram的详细信息，并展示了main.main是定义在testdata/loop2.go这个源文件中（行信息依赖行表，稍后介绍），还展示了main.main中定义的局部变量pid。

遍历编译单元CompileUnit，并从中编译单元中依次读取各个函数Subprogram，以及函数中的一系列变量Variable的过程，大致可以由上述示例所覆盖。当然我们还要提取更多信息，比如函数定义在源文件中的行号信息、变量在源文件中的行号、列号信息等等。

#### 读取行号表信息



#### 读取调用栈信息

#### 读取符号信息表

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

### 

参考内容：

1. How to Fool Analysis Tools, https://tuanlinh.gitbook.io/ctf/golang-function-name-obfuscation-how-to-fool-analysis-tools

2. Go 1.2 Runtime Symbol Information, Russ Cox, https://docs.google.com/document/d/1lyPIbmsYbXnpNj57a261hgOYVpNRcgydurVQIyZOz_o/pub

3. Some notes on the structure of Go Binaries, https://utcc.utoronto.ca/~cks/space/blog/programming/GoBinaryStructureNotes

4. Buiding a better Go Linker, Austin Clements, https://docs.google.com/document/d/1D13QhciikbdLtaI67U6Ble5d_1nsI4befEd6_k1z91U/view


5.  Time for Some Function Recovery, https://www.mdeditor.tw/pl/2DRS/zh-hk