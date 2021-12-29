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

TODO

### 读取CFI表信息

TODO

### 本节小结

TODO



### 参考内容

1. go语言中不同数据类型对应的DWARF DIE Tag：https://sourcegraph.com/github.com/golang/go/-/blob/src/cmd/internal/dwarf/dwarf.go?L418
2. 
