## 符号和符号表

### 符号相关sections

在ELF文件一节中，我们有介绍过ELF文件中常见的一些sections及其作用，本节我们重点讲述符号相关的sections，包括：

- 符号相关的符号表（.symtab）、字符串表（.strtab）；
- 考虑动态链接库的话，还有动态符号表（.dynsym）、动态字符串表（.dynstr）。

.symtab、.strtab与.dynsym、.dynstr的作用是近似的，都是为了解决链接的问题。前者是解决静态链接问题，后者是解决动态链接问题。

我们提到，符号表记录了程序中全局函数、全局变量、局部非静态变量与链接器符号解析、重定位相关的信息。我们还提到，这里提及的符号与我们常提起的调试符号（如gcc -g生成）并非同一个东西。

> 当然了，符号表中可能也会包含一些调试用的符号，下面介绍符号类型时会提及Type N表示调试符号。符号表中符号，也会引用字符串表中定义的字符串。调试相关的.[z]debug_* sections也会引用字符串表中定义的字符串。

虽然多次提及理解ELF中的符号&符号表与开发符号级调试并无直接关系，但让读者明确ELF中符号和符号表的用途、符号解析、重定位、加载的过程，有助于进一步加深大家的认识。而符号级调试相关的.[z]debug_* sections中也确实和符号&符号表有一定关系。

如若只介绍符号级调试相关的内容，而对符号&符号表用途、符号解析、重定位、加载过程浅尝辄止，读者最终还是会产生这样的疑虑：

- .[z]debug_* sections到底与其他sections有何联系？
- 编译器、链接器为什么生成这些sections？
- 这些sections后续到底是如何协调linker、loader、debugger工作的？
- 其他问题；

所以，为了尽可能扫清大家后续可能会有的这些疑虑，以及实现最初的初衷“让大家认识到那些高屋建瓴的标准、设计是如何协调compiler、linker、loader、debugger工作的”，后续还是要介绍下这部分内容。

### 什么是符号&符号表

假如我们编写如下代码，其中的包名main、函数名main.main、导入的外部包名fmt、引用的外部函数fmt.Println，这些都属于符号的范畴。

**file: main.go**

```go
package main

import "fmt"

func main() {
	fmt.Println("vim-go")
}
```

> “vim-go”算不算符号？其本身是一个只读数据，存储在.rodata section中，其本身算不上符号，但可以被符号引用，比如 `var s = "vim-go"`则变量s有对应的符号，其符号名称为s，变量值引用自.rodata中的vim-go。
>
> ps：可以通过 `readelf --hex-dump .rodata | grep vim-go`来验证。
>
> 上述示例中其实会生成一个临时变量，该临时变量的值为"vim_go"，要想查看符号依赖图，可以通过 `go tool link --dumpdep main.o | grep main.main`验证，或者 `go build -ldflags "--dumpdep" main.go | grep main.main` 也可以。
>
> ```bash
> $ go build -ldflags "--dumpdep" main.go 2>&1 | grep main.main
>
> runtime.main_main·f -> main.main
> main.main -> main..stmp_0
> main.main -> go.itab.*os.File,io.Writer
> main.main -> fmt.Fprintln
> main.main -> gclocals·8658ec02c587fb17d31955e2d572c2ff
> main.main -> main.main.stkobj
> main..stmp_0 -> go.string."vim-go"
> main.main.stkobj -> type.[1]interface {}
> ```
>
> 可以看到生成了一个临时变量main..stmp_0，它引用了go.string."vim-go"，并作为fmt.Println的参数。

.symtab section，存储了符号表，其实这就是符号数组，其中每个元素都是一个符号，我们来看下每个符号的具体定义：

```c
typedef struct {
    int name;		// string table offset，引用.strtab中字符串
    int value;		// section offset, or VM address
    int size;		// object size in bytes
    char type:4;	// data, func, section, or src file name (4 bits)
    char binding:4;	// local or global (4 bits)
    char reserved;	// unused
    char section;	// section header index, ABS, UNDEF or COMMON
} Elf_Symbol;
```

- name是字符串表中的字节偏移量，指向以null结尾的字符串对应的字符名；
- value是符号的地址，对于可重定位的模块来说，value是距离定义该符号的所在目标文件section起始位置的偏移量，对于可执行文件来说，该值是一个绝对运行时地址；
- size是符号对应的数据对象的大小（单位字节），如符号对应的int变量的字节数；
- type通常要么表示是数据，要么是函数，还可以是section或源文件名；
- binding字段表示符号是本地的，还是全局的；
- section，每个符号都和目标文件的某个section关联，该字段是一个section header table的表索引。

  有3个特殊的伪节（pseudo section），它们在节头表中是没有条目的：

  - ABS代表不该被重定位的符号；
  - UNDEF代表未定义的符号，也就是只在本模块中引用但是不在本模块定义的符号；
  - COMMON表示还未被分配位置的未初始化的数据块，此时value会给出对齐要求，size给出大小；

### 如何读取符号&符号表

go标准库中对ELF32 Symbol的定义如下，go没有位字段，定义上有些许差别，理解即可：

```go
// ELF32 Symbol.
type Sym32 struct {
	Name  uint32
	Value uint32
	Size  uint32
    	Info  uint8	// type:4+binding:4
	Other uint8	// reserved
	Shndx uint16	// section
}
```

关于如何读取符号表，可以参考go源码实现：https://sourcegraph.com/github.com/golang/go/-/blob/src/debug/elf/file.go?L489:16。

关于符号表，每个可重定位模块都有一张自己的符号表：

- *.o文件，会存在.symtab表；
- *.a文件，它是个归档文件，其中可能包含多个\*.o文件信息，并且每个\*.o文件都有独立的.symtab表，静态链接的时候会拿对应的\*.o文件出来进行链接；
- *.so文件，会存在.dynsym表，所有\*.o文件信息都被保存在一起了，只有一个.dynsym符号表，动态链接更加节省存储，但是相比静态链接，动态链接要复杂些，要注意提高链接效率；
- 其他可重定位文件，就不继续展开了；

现在go工具链已经支持读取符号表，推荐大家优先使用go工具链。Linux binutils也提供了一些类似工具，但是对于go程序而言，有点特殊之处：

- 如果是编译链接完成的可执行程序，通过readelf -s、nm、objdump都可以；
- 但是如果是go目标文件，由于go是自定义的目标文件格式，则只能借助go tool nm、go tool objdump来查看。

接下来我们来展开了解下如何使用此类工具，以及掌握如何理解输出的信息。

### 快速查看符号&符号表

我们仍以以下实例代码为例，来介绍下如何快速查看符号&符号表信息：

**file: main.go**

```go
package main

import "fmt"

func main() {
	fmt.Println("vim-go")
}
```

`go build -o main main.go`编译成完整程序，然后可通过readelf、nm、objdump等分析程序main包含的符号列表，虽然我们的示例代码很简单，但是由于go运行时非常庞大，会引入非常多的符号。

我们可以考虑只编译main.go这一个编译单元，`go tool compile main.go`会输出一个文件main.o，这里的main.o是一个可重定位目标文件，但是其文件格式却不能被readelf、nm分析，因为它是go自己设计的一种对象文件格式，在[proposal: build a better linker](https://docs.google.com/document/d/1D13QhciikbdLtaI67U6Ble5d_1nsI4befEd6_k1z91U/view)种有提及，要分析main.o只能通过go官方提供的工具。

可以通过 `go tool nm`来查看main.o中定义的符号信息：

```bash
$ go tool compile main.go
$ go tool nm main.o

         U 
         U ""..stmp_0
    1477 ? %22%22..inittask
    1497 R %22%22..stmp_0
    13ed T %22%22.main
    14a7 R %22%22.main.stkobj
         U fmt..inittask
         U fmt.Fprintln
    17af R gclocals·33cdeccccebe80329f1fdbee7f5874cb
    17a6 R gclocals·d4dc2f11db048877dbc0f60a22b4adb3
    17b7 R gclocals·f207267fbf96a0178e8758c6e3e0ce28
    1585 ? go.cuinfo.packagename.
         U go.info.[]interface {}
         U go.info.error
    1589 ? go.info.fmt.Println$abstract
         U go.info.int
    1778 R go.itab.*os.File,io.Writer
    1798 R go.itablink.*os.File,io.Writer
    15b3 R go.string."vim-go"
         U os.(*File).Write
    156b T os.(*File).close
         U os.(*file).close
         U os.Stdout
	....
```

`go tool nm`和Linux下binutils提供的nm，虽然支持的对象文件格式不同，但是其输出格式还是相同的，查看man手册，我们了解到：

- 第一列，symbol value，表示定义符号处的虚拟地址（如变量名对应的变量地址）；
- 第二列，symbol type，用小写字母表示局部符号，大写则为全局符号（uvw例外）；

  运行命令 `man nm`查看nm输出信息：

  ```bash
  "A" The symbol's value is absolute, and will not be changed by further linking.

  "B"
  "b" The symbol is in the uninitialized data section (known as BSS).

  "C" The symbol is common.  Common symbols are uninitialized data.  When linking, multiple common symbols may appear with the same name.  If the symbol is defined anywhere, the common symbols are treated as undefined references.

  "D"
  "d" The symbol is in the initialized data section.

  "G"
  "g" The symbol is in an initialized data section for small objects.  Some object file formats permit more efficient access to small data objects, such as a global int variable as opposed to a large global array.

  "i" For PE format files this indicates that the symbol is in a section specific to the implementation of DLLs.  For ELF format files this indicates that the symbol is an indirect function.  This is a GNU extension to the standard set of ELF symbol types.  It indicates a symbol which if referenced by a relocation does not evaluate to its address, but instead must be invoked at runtime.  The runtime execution will then return the value to be used in the relocation.

  "I" The symbol is an indirect reference to another symbol.

  "N" The symbol is a debugging symbol.

  "p" The symbols is in a stack unwind section.

  "R"
  "r" The symbol is in a read only data section.

  "S"
  "s" The symbol is in an uninitialized data section for small objects.

  "T"
  "t" The symbol is in the text (code) section.

  "U" The symbol is undefined.

  "u" The symbol is a unique global symbol.  This is a GNU extension to the standard set of ELF symbol bindings.  For such a symbol the dynamic linker will make sure that in the entire process there is just one symbol with this name and type in use.

  "V"
  "v" The symbol is a weak object.  When a weak defined symbol is linked with a normal defined symbol, the normal defined symbol is used with no error.  When a weak undefined symbol is linked and the symbol is not defined, the value of the weak symbol becomes zero with no error.  On some systems, uppercase indicates that a default value has been specified.

  "W"
  "w" The symbol is a weak symbol that has not been specifically tagged as a weak object symbol.  When a weak defined symbol is linked with a normal defined symbol, the normal defined symbol is used with no error.  When a weak undefined symbol is linked and the symbol is not defined, the value of the symbol is determined in a system-specific manner without error.  On some systems, uppercase indicates that a default value has been specified.

  "-" The symbol is a stabs symbol in an a.out object file.  In this case, the next values printed are the stabs other field, the stabs desc field, and the stab type.  Stabs symbols are used to hold debugging information.

  "?" The symbol type is unknown, or object file format specific.
  ```
- 第三列，symbol name，符号名，对应字符串是存储在字符串表中，由符号表引用；

我们回头再看下我们的示例来加深下理解，OK，让我们关注下main函数本身，我们注意到nm输出显示符号 `%22%22.main`是定义在虚地址 `0x13ed`处，并且表示它是一个.text section中定义的符号，那只有一种可能要么是package main，要么是func main.main，其实是main.main。

```bash
$ go tool nm main.o

         U 
         U ""..stmp_0
    1477 ? %22%22..inittask
    1497 R %22%22..stmp_0
    13ed T %22%22.main
    14a7 R %22%22.main.stkobj
         U fmt..inittask
         U fmt.Fprintln
    ....
```

我们可以通过 `go tool objdump -S main.o`反汇编main.o查看虚地址处对应的信息来求证，我们注意到虚地址 `0x13ed`处恰为func main.main的入口地址。

```bash
$ go tool objdump -S main.o
TEXT %22%22.main(SB) gofile../root/debugger101/testdata/xxxx/main.go
func main() {
  0x13ed		64488b0c2500000000	MOVQ FS:0, CX		[5:9]R_TLS_LE
  0x13f6		483b6110		CMPQ 0x10(CX), SP
  0x13fa		7671			JBE 0x146d
  0x13fc		4883ec58		SUBQ $0x58, SP
  0x1400		48896c2450		MOVQ BP, 0x50(SP)
  0x1405		488d6c2450		LEAQ 0x50(SP), BP
	fmt.Println("vim-go")
  0x140a		0f57c0			XORPS X0, X0
  0x140d		0f11442440		MOVUPS X0, 0x40(SP)
  0x1412		488d0500000000		LEAQ 0(IP), AX		[3:7]R_PCREL:type.string
  ......
```

另外我们也注意到示例中有很多符号类型是 `U`，这些符号都是在当前模块main.o中未定义的符号，这些符号是定义在其他模块中的，将来需要链接器来解析这些符号并完成重定位。

之前我们提到，可重定位文件中，存在一些.rel.text、.rel.data sections来实现重定位，但我们也提到了，go目标文件是自定义的，它参考了plan9目标文件格式（当然现在又调整了 `go tool link --go115newobj`），Linux binutils提供的readelf工具是无法读取的，go提供了工具objdump来查看。

```bash
$ go tool objdump main.o | grep R_
  main.go:5     0x13ed  64488b0c2500000000  MOVQ FS:0, CX  [5:9]R_TLS_LE
  main.go:6     0x1412  488d0500000000      LEAQ 0(IP), AX  [3:7]R_PCREL:type.string
  main.go:6     0x141e  488d0500000000      LEAQ 0(IP), AX  [3:7]R_PCREL:""..stmp_0
  print.go:274  0x142a  488b0500000000      MOVQ 0(IP), AX  [3:7]R_PCREL:os.Stdout
  print.go:274  0x1431  488d0d00000000      LEAQ 0(IP), CX  [3:7]R_PCREL:go.itab.*os.File,io.Writer
  print.go:274  0x145d  e800000000          CALL 0x1462  [1:5]R_CALL:fmt.Fprintln
  main.go:5     0x146d  e800000000          CALL 0x1472  [1:5]R_CALL:runtime.morestack_noctxt
  gofile..<autogenerated>:1  0x1580  e900000000  JMP 0x1585  [1:5]R_CALL:os.(*file).close
```

我们使用 `grep R_`来过滤objdump的输出，现在我们看到的这些操作指令，其中都涉及了一些需要进行重定位的符号，比如类型定义type.string，比如全局变量os.Stdout，比如全局函数fmt.Fprintln、os.(*file).close。

这些符号将在后续 `go tool link`时进行解析并完成重定位，最终构建出一个完全链接的可执行程序，可以尝试运行 `go tool link main.o`，会生成一个a.out文件，这就是链接完全的可执行程序了。

```bash
$ go tool link main.o
$ ls
./a.out main.o main.go
$ ./a.out
vim-go
```

最后需要注意的是，纯go程序是静态链接的，所以最终构建出的可执行程序中是不存在需要动态符号解析的symbol或section的。但如果是cgo编译的，还是会的。

```
$ ldd -r test1 // 这是一个简单的纯go程序
        not a dynamic executable

$ ldd -r test2 // 这是一个引用了共享库的cgo构建的go程序
ldd -r seasonsvr
        linux-vdso.so.1 (0x00007fff35dec000)
        /$LIB/libonion.so => /lib64/libonion.so (0x00007f7c6f744000)
        libresolv.so.2 => /lib64/libresolv.so.2 (0x00007f7c6f308000)
        libpthread.so.0 => /lib64/libpthread.so.0 (0x00007f7c6f0e8000)
        libc.so.6 => /lib64/libc.so.6 (0x00007f7c6ed12000)
        libdl.so.2 => /lib64/libdl.so.2 (0x00007f7c6eb0e000)
        /lib64/ld-linux-x86-64.so.2 (0x00007f7c6f520000)
```

而对c程序且使用了共享库的，构建出的可执行程序中存在一些这样的符号或section，在后续loader加载程序时会调用动态链接器（如ld-linux）来完成动态符号解析。

### 本节小结

前面我们结合go测试程序详细介绍了：

- 什么是符号&符号表；
- 如何读取符号&符号表；
- 如何快速查看目标文件中的符号&符号表；
- 如何完成链接生成可执行程序；

至此，相信大家已经对符号&符号表有了比较清晰的认识，我们可以继续后续内容了。

### 参考内容

1. Go: Package objabi, https://golang.org/pkg/cmd/internal/objabi/
2. Go: Object File & Relocations, Vincent Blanchon, https://medium.com/a-journey-with-go/go-object-file-relocations-804438ec379b
3. Golang Internals, Part 3: The Linker, Object Files, and Relocations, https://www.altoros.com/blog/golang-internals-part-3-the-linker-object-files-and-relocations/
4. Computer System: A Programmer's Perspective, Randal E.Bryant, David R. O'Hallaron, p450-p479

   深入理解计算机系统, 龚奕利 雷迎春 译, p450-p479
5. Linker and Libraries Guide, Object File Format, File Format, Symbol Table, https://docs.oracle.com/cd/E19683-01/816-1386/chapter6-79797/index.html
6. Linking, https://slideplayer.com/slide/9505663/
