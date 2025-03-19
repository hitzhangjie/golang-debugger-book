## 符号表和符号

在 "认识ELF文件" 一节中，我们有介绍过ELF文件中常见的一些section及其作用，本节我们重点讲述符号表及符号。

#### 符号表

1）.strtab和.shstrtab 存储的是字符串信息，.shstrtab和.strtab 首尾各有1-byte '\0'，其他数据就是 '\0' 结尾的c_string。区别只是，.strtab可以用来存储符号、节的名字，而.shstrtab仅存储节的名字。

2）.symtab 存储的是符号表，符号表包含了定位、重定位程序符号定义与引用所需的信息。如果存在一个PT_TYPE=load的段引用了该section，那么这个section的属性将包含SHF_ALLOC flag，如果没有，就不包含该flag，该flag指示需要分配内存给该section数据。

关于符号表，每个可重定位模块都有一张自己的符号表：

- \*.o文件，包含一个符号表.symtab；
- \*.a文件，它是个归档文件，其中可能包含多个\*.o文件，并且每个\*.o文件在归档文件中都保留了其自身的符号表(.symtab)。静态链接的时候会拿对应的\*.o文件出来进行链接，并把符号表进行合并；
- \*.so文件，包含动态符号表.dynsym，所有合并入这个\*.so文件的\*.o文件的符号表信息合并成了这个.dynsym，\*.so文件中不像静态库那样还存在独立的\*.o文件了。链接器将这些\*.o文件合成\*.so文件时，Merging, Not Inclusion；
- 其他可重定位文件，就不继续展开了；

3）symbol: .symtab中的每一个表项都描述了一个符号（symbol），符号的名字最终记录在.strtab中，符号除了有名字还有哪些属性信息呢？

#### 符号

符号表记录了程序中全局函数和全局变量的相关信息，并且包含了链接器符号解析及重定位所需的数据。局部非静态变量通常不会被包含在符号表中。局部变量的作用域仅限于其定义的函数或块内，它们不需要全局可见性，因此没有必要将这些信息保存在符号表中。

ELF 符号表主要记录的是具有外部作用范围的对象，包括：

- 全局函数
- 全局变量
- 静态全局变量和静态函数（尽管它们仅对文件或编译单元可见）
- 以及其他需要跨文件或模块访问的符号

我们这里所说的符号，和我们所说的符号级调试这里的符号，并不能划等号：1）符号级调试中的符号，强调的是利用源码中函数名、变量名、分支控制逻辑等有别于指令级调试的交互方式。2）本文讲的符号表中的符号，它主要是为了方便链接器进行符号解析和重定位而记录的。但是它记录的这些符号信息也确实会被某些调试器使用，如gdb，尽管它不是为了符号级调试而设计的。3）DWARF调试信息标准，专门用于对不同编程语言中各种各样的程序构造进行描述，以实现符号级调试。

ELF符号表与符号级调试并无直接关系，实际上dlv就完全没有使用.symtab，不过gdb有使用。为了让读者明确ELF符号表用途，我们还是介绍下符号解析、重定位、加载的过程，有助于进一步加深对整个工具链的认识。我们的学习过程不应该是快餐式的，而应该是脚踏实地的。ELF文件格式为什么这么定，为什么包含这些节和段，为什么要生成这些符号表，要解决什么问题，gdb是如何使用它们的，为什么gdb还需要DWARF……多问几个为什么，最后轮到DWARF上场时，我们必然会理解的更加深刻。

还记得我们的初衷吗，“让大家认识到那些高屋建瓴的设计是如何协调compiler、linker、loader、debugger工作的”，我们还是要介绍下这部分内容。

#### 符号定义

下面是 `man 5 elf` 中列出的32位和64位版本符号对应的类型定义，它们成员相同，仅仅是字段列表定义顺序有所不同。

```c
typedef struct {
    uint32_t      st_name;
    Elf32_Addr    st_value;
    uint32_t      st_size;
    unsigned char st_info;
    unsigned char st_other;
    uint16_t      st_shndx;
} Elf32_Sym;

typedef struct {
    uint32_t      st_name;
    unsigned char st_info;
    unsigned char st_other;
    uint16_t      st_shndx;
    Elf64_Addr    st_value;
    uint64_t      st_size;
} Elf64_Sym;
```

下面来详细了解下各个字段的作用：

- st_name: 符号的名称，是一个字符串表的索引值。非0表示在.strtab中的索引值；为0则表示该符号没有名字（.strtab[0]=='\0')
- st_value: 符号的值，对可重定位模块，value是相对定义该符号的位置的偏移量；对于可执行文件来说，该值是一个虚拟内存地址；
- st_size: 符号指向的对象大小，如果大小未知或者无需指定大小就为0。如符号对应的int变量的字节数；
- st_info: 符号的类型和绑定属性(binding attributes)
  - STT_NOTYPE: 未指定类型
  - STT_OBJECT: 该符号关联的是一个数据对象
  - STT_FUNC: 该符号关联的是一个函数
  - STT_SECTION: 该符号关联的是一个section
  - STT_FILE: 该符号关联的是一个目标文件对应的原文件名
  - STT_LOPROC, STT_HIPROC： 范围[STT_LOPROC, STT_HIPROC]预留给处理器相关的机制
  - STB_LOCAL：符号可见性仅限于当前编译单元（目标文件）内部，多个编译单元中可以存在多个相同的符号名但是为STT_LOCAL类型的符号
  - STB_GLOBAL：全局符号对于所有的编译单元（目标文件）可见，一个编译单元中定义的全局符号，可以在另一个编译单元中引用
  - STB_WEAK: 弱符号，模拟全局符号，但是它的定义拥有更低的优先级
  - STB_LOPROC, STB_HIPROC：范围[STB_LOPROC, STB_HIPROC]预留给处理器相关的机制
  - STT_TLS: 该符号关联的是TLS变量
- st_other: 定义了符号的可见性 (visibility)
  - STV_DEFAULT: 默认可见性规则；全局符号和弱符号对其他模块可见；本地模块中的引用，可以解析为其他模块中的定义；
  - STV_INTERNAL: 处理器特定的隐藏类型；
  - STV_HIDDEN: 符号对其他模块不可见；本地模块中的引用，只能解析为当前模块中的符号；
- st_shndx: 每个符号都是定义在某个section中的，比如变量名、函数名、常量名等，这里表示其从属的section header在节头表中的索引；


### 生成符号表

### 读取符号表

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

现在go工具链已经支持读取符号表，推荐大家优先使用go工具链。Linux binutils也提供了一些类似工具，但是对于go程序而言，有点特殊之处：

- 如果是编译链接完成的可执行程序，通过readelf -s、nm、objdump都可以；
- 但是如果是go目标文件，由于go是自定义的目标文件格式，则只能借助go tool nm、go tool objdump来查看。

接下来我们来展开了解下如何使用此类工具，以及掌握理解输出的信息 …… oh，在演示之前还得先继续介绍下符号。

### 工具演示

大家看完了符号的类型定义后，肯定产生了很多联想，“变量名对应的symbol应该是什么样”，“函数名对应的symbol应该是什么样”，“常量名呢……”，OK，我们接下来就会结合具体示例，给大家展示下程序中的不同程序构造对应的符号是什么样子的。

##### readelf -S `prog`

##### 查看符号的依赖图

代码示例如下，其中的包名main、函数名main.main、导入的外部包名fmt、引用的外部函数fmt.Println，这些都属于符号的范畴。

**file: main.go**

```go
package main

import "fmt"

func main() {
	fmt.Println("vim-go")
}
```

> “vim-go”算不算符号？其本身是一个只读数据，存储在.rodata section中，其本身算不上符号，但可以被符号引用，比如定义一个全局变量 `var s = "vim-go"` 则变量s有对应的符号，其符号名称为s，变量值引用自.rodata中的vim-go。
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

##### 查看符号表&符号

示例代码如下，来介绍下如何快速查看符号&符号表信息：

**file: main.go**

```go
package main

import "fmt"

func main() {
	fmt.Println("vim-go")
}
```

`go build -o main main.go`编译成完整程序，然后可通过readelf、nm、objdump等分析程序main包含的符号列表，虽然我们的示例代码很简单，但是由于go运行时非常庞大，会引入非常多的符号。

我们可以考虑只编译main.go这一个编译单元，`go tool compile main.go`会输出一个文件main.o，这里的main.o是一个可重定位目标文件，但是其文件格式却不能被readelf、nm分析，因为它是go自己设计的一种对象文件格式，在 [proposal: build a better linker](https://docs.google.com/document/d/1D13QhciikbdLtaI67U6Ble5d_1nsI4befEd6_k1z91U/view) 种有提及，要分析main.o只能通过go官方提供的工具。

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
- 第三列，symbol name，符号名在字符串表中索引，对应字符串是存储在字符串表中；

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

> ps: plan9中汇编指令R_PCREL, R_CALL，表示这里需要进行重定位，后面会介绍。

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
7. proposal: build a better linker, https://docs.google.com/document/d/1D13QhciikbdLtaI67U6Ble5d_1nsI4befEd6_k1z91U/view
