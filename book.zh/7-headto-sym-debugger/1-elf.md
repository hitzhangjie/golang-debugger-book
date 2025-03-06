## 符号级调试基础：ELF文件

### ELF文件结构

ELF ([Executable and Linkable Format](https://en.wikipedia.org/wiki/Executable_and_Linkable_Format))，可执行可链接格式，是Unix、Linux环境下一种十分常见的文件格式，它可用于可执行程序、目标文件、共享库、core文件等。

ELF文件，其构成如下图所示，其内容包括文件头 (ELF Header)，剩余数据包括段头表 (Program Header Table)、节头表 (Section Header Table)、Sections，Sections位于段头表和节头表之间，并被它们引用。

![img](assets/elf.png)

- ELF文件头 (ELF FIle Header)，其描述了当前ELF文件的类型（可执行程序、可重定位文件、动态链接文件、core文件等）、32位/64位寻址、ABI、ISA、程序入口地址、Program Header Table起始地址及元素大小、Section Header Table起始地址及元素大小，等等；
- 段头表 (Program Header Table)，定义了程序的执行时视图，描述了如何创建程序的进程映像。每个表项定义了一个“段 (segment)” ，每个段引用了0、1或多个sections，段有类型，如PT_LOAD表示该段引用的sections需要被加载到内存。段头表主要是为了指导加载器进行加载；

  > .text section隶属于一个Type=PT_LOAD的段，意味着会被加载到内存；并且该段的权限为RE（Read+Execute），意味着指令部分加载到内存后，进程对这部分区域的访问权限为“读+可执行”。加载器 (loader /lib64/ld-linux-x86-64.so) 应按照段定义好的虚拟地址范围、权限，将引用的sections加载到进程地址空间中指定位置，并在GDT、LDT中设置好读、写、执行权限。
  >
- 节头表 (Section Header Table)，定义了程序的链接时视图，描述了二进制可执行文件中包含的每个section的位置、大小、类型、链接顺序，等等，主要目的是为了指导链接器进行链接；

  > 因为每个编译单元都有一个目标文件(\*.o)，每个目标文件都是一个ELF文件，都包含了这个编译单元拥有的sections。链接器是将所有目标文件以及其他库文件的sections进行合并（如将每个编译单元的.text合并到一起），然后将引用的符号解析成正确的偏移量或者地址。
  >
- Sections，ELF文件中的sections数据，夹在段头表、节头表之间，并且被段头表、节头表引用。

  > 不同程序中包含的sections数量是不固定的：
  >
  > - 有些编程语言会有特殊的sections来支持对应的语言运行时层面的功能，如go .gopclntab, gosymtab；
  > - 程序采用静态链接、动态链接生成的sections也会不同，如动态链接往往会生成.got, .plt, .rel.text。
  >

### ELF段头表

段头表 (Program Header Table)，可以理解为程序执行的视图（executable point of view），主要用来指导loader如何加载。

从可执行程序角度来看，进程运行时需要了解如何将程序中不同部分，加载到进程虚拟内存地址空间中的不同区域。

Linux下进程地址空间的内存布局，大家并不陌生，如data段、text段，每个段包含的信息其实是由段头表预先定义好的，包括在虚拟内存空间中的位置，以及段中应该包含哪些sections数据。

> 注意：
>
> - 内存地址空间中的内存布局，代码所在区域我们常称为代码段（code segment, CS寄存器来寻址）or 文本段（text segment），数据段我们也常称为数据段（data segment，DS寄存器来寻址）。
> - 内存布局中的术语text segment、data segment，不是ELF文件中的.text section和.data section，注意区分。
>
> 下面的段头表定义给出了一个这样的示例，text segment其实包含了.text section以及其他sections，data segment其实也包含了.data section以外的其他sections。
>
> ```bash
> // text segment，段索引02，可以看到包含了.text等其他sections
> LOAD        0x0000000000000000 0x0000000000400000 0x0000000000400000
>             0x0000000000000a70 0x0000000000000a70  R E    0x200000
>
> // data segment，段索引03，可以看到包含了.data等其他sections
> LOAD        0x0000000000000df0 0x0000000000600df0 0x0000000000600df0
>             0x000000000000025c 0x0000000000000260  RW     0x200000
>
> 02     .interp .note.ABI-tag .note.gnu.build-id .gnu.hash .dynsym .dynstr .gnu.version .gnu.version_r .rela.dyn .rela.plt .init .plt .text .fini .rodata
> 03     .init_array .fini_array .dynamic .got .got.plt .data .bss
> ```

下面这个示例，则展示了测试程序 golang-debugger-lessons/testdata/loop2 的完整段头表定义，运行 `readelf -l`查看其段头表，共有7个表项，每个段定义包含了类型、在虚拟内存中的地址、读写执行权限，以及引用的sections。通过 `Section to Segment mapping: Segment Sections...`部分可以看到，最终组织好的：

- text segment（编号02的segment其Flags为R+E，表示可读可执行，这就是text segment）包含了如下sections `.text .note.go.buildid`;
- rodata segment (编号03的segment其Flags为R，表示只读，就是rodata segment) 包含了 `.rodata .typelink .itablink .gosymtab .gopclntab` 这些go运行时需要的数据；
- data segment (编号04的segment其Flags为RW，表示可读可写，就是data segment) 包含了 `.data .bss` 等这些可读写的数据；

```bash
$ readelf -l testdata/loop2

Elf file type is EXEC (Executable file)
Entry point 0x475a80
There are 6 program headers, starting at offset 64

Program Headers:
  Type           Offset             VirtAddr           PhysAddr
                 FileSiz            MemSiz              Flags  Align
  PHDR           0x0000000000000040 0x0000000000400040 0x0000000000400040
                 0x0000000000000150 0x0000000000000150  R      0x1000
  NOTE           0x0000000000000f9c 0x0000000000400f9c 0x0000000000400f9c
                 0x0000000000000064 0x0000000000000064  R      0x4
  LOAD           0x0000000000000000 0x0000000000400000 0x0000000000400000
                 0x00000000000af317 0x00000000000af317  R E    0x1000
  LOAD           0x00000000000b0000 0x00000000004b0000 0x00000000004b0000
                 0x00000000000a6e70 0x00000000000a6e70  R      0x1000
  LOAD           0x0000000000157000 0x0000000000557000 0x0000000000557000
                 0x000000000000a520 0x000000000002e0c0  RW     0x1000
  GNU_STACK      0x0000000000000000 0x0000000000000000 0x0000000000000000
                 0x0000000000000000 0x0000000000000000  RW     0x8

 Section to Segment mapping:
  Segment Sections...
   00
   01     .note.go.buildid
   02     .text .note.go.buildid
   03     .rodata .typelink .itablink .gosymtab .gopclntab
   04     .go.buildinfo .noptrdata .data .bss .noptrbss
   05
   06 
```

本章稍后的章节，会继续介绍ELF段头表信息如何指导loader加载程序数据到内存，以构建进程映像。

### ELF节头表

每个编译单元生成的目标文件（ELF格式），将代码和数据划分成不同sections，如指令在.text、只读数据在.rodata、可读写数据在.data、其他vendor自定义sections，等等，实现了对不同数据的合理组织。

在此基础上，节头表 (Section Header Table)，定义了程序的链接视图（the linkable point of view），用来指导linker如何对多个编译单元中的sections进行链接（合并相同sections、符号解析、重定位）。

> - 以C语言为例：每个编译单元编译过程中生成的*.o目标文件也是一个ELF文件，里面包含了当前文件的section信息，最终链接器将所有*.o文件的相同sections合并在一起，所以说它是用来指导链接器连接的一个视图。see：https://stackoverflow.com/a/51165896
> - 再以Go语言为例，在 [how &#34;go build&#34; works](./0-how-go-build-works.md) 小节里，我们也提及了go tool compile会将go源码文件对应的目标文件归档到静态库文件_pkg_.a，然后go tool pack将go tool asm汇编源文件生成的目标文件 file.o 最终追加到这个_pkg_.a，最终go tool link将这个_pkg_.a与其他运行时、标准库代码链接到一起，形成一个可执行程序。这个过程中对不同目标文件中的sections的处理也是大同小异的。

OK，以测试程序golang-debugger-lessons/testdata/loop2测试程序为例，我们来看下其链接器角度的视图，可以看到其包含了25个sections，每个section都有类型、偏移量、大小、链接顺序、对齐等信息，用以指导链接器完成链接操作。

```bash
$ readelf -S testdata/loop2 
There are 25 section headers, starting at offset 0x1c8:

Section Headers:
  [Nr] Name              Type             Address           Offset
       Size              EntSize          Flags  Link  Info  Align
  [ 0]                   NULL             0000000000000000  00000000
       0000000000000000  0000000000000000           0     0     0
  [ 1] .text             PROGBITS         0000000000401000  00001000
       0000000000098294  0000000000000000  AX       0     0     32
  [ 2] .rodata           PROGBITS         000000000049a000  0009a000
       00000000000440c7  0000000000000000   A       0     0     32
       .............................................................
  [ 4] .typelink         PROGBITS         00000000004de2a0  000de2a0
       0000000000000734  0000000000000000   A       0     0     32
  [ 5] .itablink         PROGBITS         00000000004de9d8  000de9d8
       0000000000000050  0000000000000000   A       0     0     8
  [ 6] .gosymtab         PROGBITS         00000000004dea28  000dea28
       0000000000000000  0000000000000000   A       0     0     1
  [ 7] .gopclntab        PROGBITS         00000000004dea40  000dea40
       000000000005fe86  0000000000000000   A       0     0     32
       .............................................................
  [10] .data             PROGBITS         000000000054d4e0  0014d4e0
       0000000000007410  0000000000000000  WA       0     0     32
       .............................................................
  [14] .zdebug_line      PROGBITS         0000000000588119  00155119
       000000000001cc0d  0000000000000000           0     0     1
  [15] .zdebug_frame     PROGBITS         00000000005a4d26  00171d26
       00000000000062e9  0000000000000000           0     0     1
       .............................................................
  [22] .note.go.buildid  NOTE             0000000000400f9c  00000f9c
       0000000000000064  0000000000000000   A       0     0     4
  [23] .symtab           SYMTAB           0000000000000000  001d0000
       0000000000011370  0000000000000018          24   422     8
  [24] .strtab           STRTAB           0000000000000000  001e1370
       00000000000109fb  0000000000000000           0     0     1
Key to Flags:
  W (write), A (alloc), X (execute), M (merge), S (strings), I (info),
  L (link order), O (extra OS processing required), G (group), T (TLS),
  C (compressed), x (unknown), o (OS specific), E (exclude),
  l (large), p (processor specific)
```



现在我们来尝试回答几个读者朋友可能的疑问：

**section与segments隶属关系？**

一个section属于多少个segments，这个由Program Headers定义，以前面示例做参考，go程序中.note.go.buildid就属于两个段，段索引分别为01、02，但是.data就只属于一个段，段索引02。

**section是否会被加载到内存中？**

一个section中数据最终会不会被mmap到进程地址空间，也是由引用它的Program Header的类型决定的，如果Program Header类型为LOAD类型，则会被mmap到进程地址空间，反之则不会。

仍以前面示例做参考，我们发现.gosymtab、.gopclntab所属的段（段索引值 03）是LOAD类型，表示其数据会被加载到内存，这是因为go runtime依赖这些信息来计算stacktrace。

而.note.go.buildid所属的段（段索引 01）为NOTE类型，只看这个段的话，section .note.go.buildid不会被加载到内存，但是注意到.note.go.buildid还被下面这个段索引为02、PT_TYPE=LOAD的段引用，那这个section最终就会被加载到内存中。

一般情况下，.note.* 这种sections就是给一些外部工具读取使用的，一般不会被加载到内存中，除非go设计者希望能从进程内存中直接读取到这部分信息。

**vendor自定义sections举例？**

以go语言为例，方便 `go tool buildid <prog>`提取buildid信息，这个其实就是存储在.note.go.buildid section中的。

来验证下，首先通过 `go tool buildid`来提取buildid信息：

```bash
$ go tool buildid testdata/loop
_Iq-Pc8WKArkKz99o-e6/6mQTe-5rece47rT9tQco/8IOigl4fPBb3ZSKYst1T/QZmo-_A8O3Ec6NVYEn_1
```

接下来通过 `readelf --string-dump=.note.go.buildid <prog>`直接读取ELF文件中的数据：

```bash
$ readelf --string-dump=.note.go.buildid testdata/loop
String dump of section '.note.go.buildid':
  [     4]  S
  [     c]  Go
  [    10]  _Iq-Pc8WKArkKz99o-e6/6mQTe-5rece47rT9tQco/8IOigl4fPBb3ZSKYst1T/QZmo-_A8O3Ec6NVYEn_1
```

结果发现buildid数据是一致的，证实了我们上述判断。

本章稍后的章节，会介绍ELF节头表信息如何指导链接器执行链接操作。

### ELF Sections

ELF文件会包含很多的sections，前面给出的测试实例中就包含了25个sections。

我们先来了解一些常见的sections的作用，为后续加深对linkers、loaders、debgguers工作原理的认识提前做点准备。

- .text: 编译好的程序指令；
- .rodata: 只读数据，如程序中的常量字符串；
- .data：已经初始化的全局变量；
- .bss：未经初始化的全局变量，在ELF文件中只是个占位符，不占用实际空间；
- .symtab：符号表，每个可重定位文件都有一个符号表，存放程序中定义的全局函数和全局变量的信息，注意它不包含局部变量信息，局部非静态变量由栈来管理，它们对链接器符号解析、重定位没有帮助。**也要注意，.symtab和DWARF调试符号无关**；

  > ps: .symtab、DWARF都提供了“符号”一类的信息，使用.symtab可以更快速进行符号信息查询，但是DWARF提供了更详细的符号信息。调试器（比如gdb）会同时使用二者，一方面可以兼顾效率，另一方面也可以对不包含DWARF调试信息的程序调试进行兼容。
  >
- .debug_*: 调试信息，调试器读取该信息以支持符号级调试（如gcc -g生成）；
- .strtab：字符串表，包括.symtab和.[z]debug_*节符号的字符串值，以及section名；
- .rel.text：一个.text section中位置的列表，当链接器尝试把这个目标文件和其他文件链接时，需要修改这些位置的值，调用外部函数或者引用外部全局变量的，这部分的链接是通过符号进行的，需要对这些符号进行解析、重定位成正确的访问地址。
- .rel.data：引用的一些全局变量的重定位信息，和.rel.text有些类似；

当然除了列出的这些，还有很多其他sections，ELF也允许vendor自定义sections，以支持一些期望的功能，如go语言就添加了.gosymtab、.gopclntab、.note.build.id来支持go运行时、go工具链的一些操作。

我们来简单介绍下如何查看sections中的内容：

- 查看sections列表 `readelf -S <prog>`

  ```bash
  $ readelf -S testdata/loop2 
  There are 25 section headers, starting at offset 0x1c8:

  Section Headers:
    [Nr] Name              Type             Address           Offset
         Size              EntSize          Flags  Link  Info  Align
    [ 0]                   NULL             0000000000000000  00000000
         0000000000000000  0000000000000000           0     0     0
    [ 1] .text             PROGBITS         0000000000401000  00001000
         0000000000098294  0000000000000000  AX       0     0     32
    [ 2] .rodata           PROGBITS         000000000049a000  0009a000
         00000000000440c7  0000000000000000   A       0     0     32
    ...
  ```
- 查看指定section数据 `readelf --string-dump`

  ```bash
  $ readelf --string-dump=.note.go.buildid loop

  String dump of section '.note.go.buildid':
    [     4]  S
    [     c]  Go
    [    10]  z3BnMb0ZcNprbNCHGFUE/tKoFiTkxKf0367OgPv1m/xoZJRttC9Gcwqc67tiDf/1NjCWH3otcISEg7g8lG7
  ```
- 查看指定section数据 `readelf --hex-dump`

  ```bash
  $ readelf --hex-dump=.note.go.buildid loop

  Hex dump of section '.note.go.buildid':
    0x00400f9c 04000000 53000000 04000000 476f0000 ....S.......Go..
    0x00400fac 7a33426e 4d62305a 634e7072 624e4348 z3BnMb0ZcNprbNCH
    0x00400fbc 47465545 2f744b6f 4669546b 784b6630 GFUE/tKoFiTkxKf0
    0x00400fcc 3336374f 67507631 6d2f786f 5a4a5274 367OgPv1m/xoZJRt
    0x00400fdc 74433947 63777163 36377469 44662f31 tC9Gcwqc67tiDf/1
    0x00400fec 4e6a4357 48336f74 63495345 67376738 NjCWH3otcISEg7g8
    0x00400ffc 6c473700                            lG7.
  ```
- 其他，如 `readelf [--relocated-dump | --debug-dump]`，可以按需选用。

本节ELF内容就先介绍到，在此基础上，接下来的几个小节，我们将依次介绍linker、loader、debugger的工作原理。

### 遗留问题

.note.go.build为何会被加载呢？

在阅读了go源码以后，初步判断是pprof需要。pprof生成profile信息中，希望能够包含被分析的进程的buildid信息，但是这里是GNU buildid，而非go builid，详见：

```
// newProfileBuilder returns a new profileBuilder.
// CPU profiling data obtained from the runtime can be added
// by calling b.addCPUData, and then the eventual profile
// can be obtained by calling b.finish.
func newProfileBuilder(w io.Writer) *profileBuilder {
	zw, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
	b := &profileBuilder{
		w:         w,
		zw:        zw,
		start:     time.Now(),
		strings:   []string{""},
		stringMap: map[string]int{"": 0},
		locs:      map[uintptr]locInfo{},
		funcs:     map[string]int{},
	}
	b.readMapping()
	return b
}

// readMapping reads /proc/self/maps and writes mappings to b.pb.
// It saves the address ranges of the mappings in b.mem for use
// when emitting locations.
func (b *profileBuilder) readMapping() {
	data, _ := os.ReadFile("/proc/self/maps")
	parseProcSelfMaps(data, b.addMapping)
	...
}

func parseProcSelfMaps(data []byte, addMapping func(lo, hi, offset uint64, file, buildID string)) {
	// $ cat /proc/self/maps
	// 00400000-0040b000 r-xp 00000000 fc:01 787766                             /bin/cat
	// 0060a000-0060b000 r--p 0000a000 fc:01 787766                             /bin/cat
	// 0060b000-0060c000 rw-p 0000b000 fc:01 787766                             /bin/cat
	// 014ab000-014cc000 rw-p 00000000 00:00 0                                  [heap]
	// 7f7d76af8000-7f7d7797c000 r--p 00000000 fc:01 1318064                    /usr/lib/locale/locale-archive
	// 7f7d7797c000-7f7d77b36000 r-xp 00000000 fc:01 1180226                    /lib/x86_64-linux-gnu/libc-2.19.so
	// 7f7d77b36000-7f7d77d36000 ---p 001ba000 fc:01 1180226                    /lib/x86_64-linux-gnu/libc-2.19.so
	// 7f7d77d36000-7f7d77d3a000 r--p 001ba000 fc:01 1180226                    /lib/x86_64-linux-gnu/libc-2.19.so
	// 7f7d77d3a000-7f7d77d3c000 rw-p 001be000 fc:01 1180226                    /lib/x86_64-linux-gnu/libc-2.19.so
	// 7f7d77d3c000-7f7d77d41000 rw-p 00000000 00:00 0
	// 7f7d77d41000-7f7d77d64000 r-xp 00000000 fc:01 1180217                    /lib/x86_64-linux-gnu/ld-2.19.so
	// 7f7d77f3f000-7f7d77f42000 rw-p 00000000 00:00 0
	// 7f7d77f61000-7f7d77f63000 rw-p 00000000 00:00 0
	// 7f7d77f63000-7f7d77f64000 r--p 00022000 fc:01 1180217                    /lib/x86_64-linux-gnu/ld-2.19.so
	// 7f7d77f64000-7f7d77f65000 rw-p 00023000 fc:01 1180217                    /lib/x86_64-linux-gnu/ld-2.19.so
	// 7f7d77f65000-7f7d77f66000 rw-p 00000000 00:00 0
	// 7ffc342a2000-7ffc342c3000 rw-p 00000000 00:00 0                          [stack]
	// 7ffc34343000-7ffc34345000 r-xp 00000000 00:00 0                          [vdso]
	// ffffffffff600000-ffffffffff601000 r-xp 00000000 00:00 0                  [vsyscall]

	...

	for len(data) > 0 {
		...
		buildID, _ := elfBuildID(file)
		addMapping(lo, hi, offset, file, buildID)
	}
}

// elfBuildID returns the GNU build ID of the named ELF binary,
// without introducing a dependency on debug/elf and its dependencies.
func elfBuildID(file string) (string, error) {
    ...
}
```

在这个基础上：

```
$ cat main.go
package main

import (
	"log"
	"os"
	"runtime/pprof"
)

func main() {
	f, err := os.Create("profile.pb.gz")
	if err != nil {
		log.Fatal(err)
	}
	pprof.StartCPUProfile(f)
	defer pprof.StopCPUProfile()
	var i int64
	for i = 0; i < (1 << 33); i++ {
	}
}
```

```bash
$ go build -ldflags "-B gobuildid" main.go

$ file main
main: ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, BuildID[sha1]=f4b5d514bc46fad9417898216b23910ae874a85d, with debug_info, not stripped

$ readelf -n main

Displaying notes found in: .note.gnu.build-id
  Owner                Data size 	Description
  GNU                  0x00000014	NT_GNU_BUILD_ID (unique build ID bitstring)
    Build ID: f4b5d514bc46fad9417898216b23910ae874a85d

Displaying notes found in: .note.go.buildid
  Owner                Data size 	Description
  Go                   0x00000053	GO BUILDID
   description data: 45 72 5a 36 6f 30 30 37 79 53 35 48 4c 67 41 7a 51 66 6e 52 2f 42 5a 53 51 58 54 4b 49 35 53 61 61 4f 4d 6e 65 49 36 63 56 2f 52 37 41 42 44 38 68 6c 34 6c 6b 65 79 44 66 7a 35 35 69 4d 2f 73 58 6a 56 4b 38 6d 52 58 79 35 4d 79 41 73 46 46 52 6d 74

$ ./main

$ pprof -raw profile.pb.gz | grep -A10 Mappings
Mappings
1: 0x400000/0x4ac000/0x0 /tmp/main f4b5d514bc46fad9417898216b23910ae874a85d [FN]
```

很可能是这里的工具写的不完善，只有显示加了 `-ldflags "-B gobuildid"` 后，才生成了GNU buildID，profile信息里才包含了这个buildid信息。如果不加这个选项，最后生成的profile信息里也是没有的。
我推测是，go设计者希望我们未指定打开GNU buildID时，就默认填充go buildid，所以才会将.text和.note.go.builid一同加载到text segment，但是可能是开发者写的解析buildID的函数只支持GNU buildID、不支持go buildID，所以最终没有生成到profile信息中。

```
$ go build main.go

$ file main
main: ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, Go BuildID=llrn1go725_F2vCvvETz/OITeRu6kDScHG6FVjdK8/R7ABD8hl4lkeyDfz55iM/uoTostDrfB5kdwhy6UpG, with debug_info, not stripped

$ readelf -n main

Displaying notes found in: .note.go.buildid
  Owner                Data size 	Description
  Go                   0x00000053	GO BUILDID
   description data: 6c 6c 72 6e 31 67 6f 37 32 35 5f 46 32 76 43 76 76 45 54 7a 2f 4f 49 54 65 52 75 36 6b 44 53 63 48 47 36 46 56 6a 64 4b 38 2f 52 37 41 42 44 38 68 6c 34 6c 6b 65 79 44 66 7a 35 35 69 4d 2f 75 6f 54 6f 73 74 44 72 66 42 35 6b 64 77 68 79 36 55 70 47

$ ./main

$ pprof -raw profile.pb.gz | grep -A10 Mappings
Mappings
1: 0x400000/0x4ac000/0x0 /tmp/main  [FN]
```

我推测就是一个go开发者pprof工具实现上的BUG，see also: 
- https://github.com/golang/go/issues/68652.
- 指定了-B gobuildid后，会从go buildid生成一个GNU buildid，https://go-review.googlesource.com/c/go/+/511475

TODO Weired, https://github.com/golang/go/issues/68186.

### 参考文献

1. Executable and Linkable Format, https://en.wikipedia.org/wiki/Executable_and_Linkable_Format
2. How to Fool Analysis Tools, https://tuanlinh.gitbook.io/ctf/golang-function-name-obfuscation-how-to-fool-analysis-tools
3. Go 1.2 Runtime Symbol Information, Russ Cox, https://docs.google.com/document/d/1lyPIbmsYbXnpNj57a261hgOYVpNRcgydurVQIyZOz_o/pub
4. Some notes on the structure of Go Binaries, https://utcc.utoronto.ca/~cks/space/blog/programming/GoBinaryStructureNotes
5. Buiding a better Go Linker, Austin Clements, https://docs.google.com/document/d/1D13QhciikbdLtaI67U6Ble5d_1nsI4befEd6_k1z91U/view
6. Time for Some Function Recovery, https://www.mdeditor.tw/pl/2DRS/zh-hk
7. Computer System: A Programmer's Perspective, Randal E.Bryant, David R. O'Hallaron, p450-p479

   深入理解计算机系统, 龚奕利 雷迎春 译, p450-p479
8. Learning Linux Binary Analysis, Ryan O'Neill, p14-15, p18-19

   Linux二进制分析, 棣琦 译, p14-15, p18-19
