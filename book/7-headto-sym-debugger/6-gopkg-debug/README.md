## go标准库 : debug/*

### 简要回顾

前面我们介绍了ELF文件头、段头表（program header table）、节头表（section header table）、常见的节（sections）的结构和作用，我们也介绍了符号、符号表（.symtab）、字符串表（.strtab）的结构和作用。在此基础上，我们没有向困难的链接、重定位、加载细节低头，旁征博引、参考了众多技术资料，为大家系统性地梳理了链接、重定位、加载器的细节。

我坚信介绍清楚这些信息，加深大家的认识，将有助于我们开发调试器过程中少走些弯路。

至此，相信读者朋友们对ELF文件没有很多畏惧心理了。我们讲这么多，一方面是为了解决大家的疑虑、加深认识，另一方面也是为了建立大家对二进制分析、调试器开发的信心。而且相比之下，我更看重信心的建立，我们如同披挂上阵的战士，信心满满，即将出征。

### go标准库

我们是基于go语言开发一款面向go程序的调试器，在我们介绍了很多系统原理、技术细节、其他语言示例之后，我们最终将回到如何通过go语言来落地的问题上。

首当其冲的就是如何解析ELF文件的问题，包括如何解析ELF文件头，ELF中的段头表、节头表，以及一些常见section中数据的解析，如.debug\_\* sections中的调试信息。

go标准库中提供了一些类似的工具，帮我们简化上述任务，下面就来看下。

go标准库package `debug/*`，专门用来读取、解析go编译工具链生成的ELF文件信息：

-   `debug/elf`支持ELF文件的读取、解析，提供了方法来根据名称定位section；
-   `debug/gosym`支持.gosymtab符号表、.gopclntab行号表的解析。设计上.gopclntab中通过pcsp记录了pc值对应的栈帧大小，所以很容易定位返回地址，可进一步确定caller，重复该过程可跟踪goroutine调用栈信息，如panic时打印的stacktrace信息；
-   `debug/dwarf`DWARF数据的读取、解析，数据压缩(.debug\_*)、不压缩(.zdebug_）两种格式均支持；

>   `debug`下几个与ELF无关的package说明：
>
>   -   macOS可执行程序、目标文件的格式并不是Unix/Linux比较通用的ELF格式，它使用的是macho格式，package `debug/macho` 是用来解析macho格式的；
>   -   windows可执行程序、目标文件的格式有采用pe这种格式，`debug/pe`是用来解析pe格式；
>   -   plan9obj这种格式比较特殊，它源于plan9分布式操作系统项目，`debug/plan9obj`用来解析这种plan9obj这种格式；
>
>   需要说明的是，在Linux下，go最终输出的文件格式虽然是ELF格式，但是在中途生成的目标文件*.o却不是采用的ELF格式，而是借鉴了plan9obj的格式，但是也有些变化。如果读者想查看go输出的目标文件格式，可以在这里找到其定义以及解析相关的package实现 "[cmd/internal/goobj/objfile.go](https://sourcegraph.com/github.com/golang/go@f5978a09589badb927d3aa96998fc785524cae02/-/blob/src/cmd/internal/goobj/objfile.go#L33)"。
>   但是由于该package为internal目录下，只允许在cmd/下的package引用，如果要正确读取go生成的\*.o目标文件格式的话，需要自己写工具。github上有类似项目可供借鉴，see [hitzhangjie/codemaster/debug](https://github.com/hitzhangjie/codemaster/tree/master/debug)。

接下来各个小节，我们将介绍下上述package的使用，了解它们对开发符号级调试器提供了哪些帮助。



参考内容：

1. How to Fool Analysis Tools, https://tuanlinh.gitbook.io/ctf/golang-function-name-obfuscation-how-to-fool-analysis-tools

2. Go 1.2 Runtime Symbol Information, Russ Cox, https://docs.google.com/document/d/1lyPIbmsYbXnpNj57a261hgOYVpNRcgydurVQIyZOz_o/pub

3. Some notes on the structure of Go Binaries, https://utcc.utoronto.ca/~cks/space/blog/programming/GoBinaryStructureNotes

4. Buiding a better Go Linker, Austin Clements, https://docs.google.com/document/d/1D13QhciikbdLtaI67U6Ble5d_1nsI4befEd6_k1z91U/view


5.  Time for Some Function Recovery, https://www.mdeditor.tw/pl/2DRS/zh-hk