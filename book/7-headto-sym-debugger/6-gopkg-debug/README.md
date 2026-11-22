## go标准库：debug/elf 与 debug/gosym

### 简要回顾

前面我们介绍了 ELF 文件头、段头表（program header table）、节头表（section header table）、常见节（sections）的结构和作用，也介绍了符号、符号表（`.symtab`）、字符串表（`.strtab`）的结构和作用。在此基础上，我们没有向困难的链接、重定位、加载细节低头，系统性地梳理了链接、重定位、加载器的细节。

我坚信介绍清楚这些信息，加深大家的认识，将有助于我们开发调试器过程中少走些弯路。至此，相信读者朋友们对 ELF 文件没有很多畏惧心理了。我们讲这么多，一方面是为了解决大家的疑虑、加深认识，另一方面也是为了建立大家对二进制分析、调试器开发的信心。而且相比之下，我更看重信心的建立，我们如同披挂上阵的战士，信心满满，即将出征。

### 回到 Go 语言

我们是基于 Go 语言开发一款面向 Go 程序的调试器，在介绍了很多系统原理、技术细节之后，最终要回到如何通过 Go 语言来落地的问题上。

首当其冲的就是如何解析 ELF 文件：ELF 文件头、段头表、节头表，以及一些常见 section 中数据的解析。Go 标准库提供了一些工具，帮我们简化上述任务。`debug/*` 下有几个包：

- `debug/elf`：ELF 文件的读取、解析，提供了方法来根据名称定位 section；
- `debug/gosym`：`.gosymtab` 符号表、`.gopclntab` 行号表的解析。设计上 `.gopclntab` 中通过 pcsp 记录了 pc 值对应的栈帧大小，所以很容易定位返回地址，可进一步确定 caller，重复该过程可跟踪 goroutine 调用栈信息，如 panic 时打印的 stacktrace 信息；
- `debug/dwarf`：DWARF 数据的读取、解析。这个包我们放到第8章再讲，因为它需要先理解 DWARF 的数据模型，否则就只能照抄 API，出了问题也不知道从哪里查。

> `debug` 下几个与 ELF 无关的 package：
>
> - macOS 可执行程序、目标文件的格式并不是 Unix/Linux 比较通用的 ELF 格式，它使用的是 macho 格式，package `debug/macho` 用来解析 macho 格式；
> - Windows 可执行程序、目标文件的格式有采用 PE 这种格式，`debug/pe` 用来解析 PE 格式；
> - plan9obj 这种格式比较特殊，它源于 plan9 分布式操作系统项目，`debug/plan9obj` 用来解析 plan9obj 格式。
>
> 需要说明的是，在 Linux 下，Go 最终输出的文件格式虽然是 ELF，但是中途生成的目标文件 `*.o` 却不是 ELF，而是借鉴了 plan9obj 的格式，但也有一些变化。如果读者想查看 Go 输出的目标文件格式，可以在这里找到其定义以及解析相关的 package 实现 [cmd/internal/goobj/objfile.go](https://github.com/golang/go/blob/f5978a09589badb927d3aa96998fc785524cae02/src/cmd/internal/goobj/objfile.go#L33)。由于该 package 位于 internal 目录下，只允许在 `cmd/` 下的 package 引用；如果要正确读取 Go 生成的 `*.o` 目标文件格式，需要自己写工具。

### 本章怎么安排

接下来两小节，我们分别看 `debug/elf` 和 `debug/gosym` 的使用，了解它们对开发符号级调试器提供了哪些帮助。`debug/dwarf` 留到第8章，等我们讲完 DWARF 的 DIE、行号表、CFI 之后，再回来用它读真正的调试信息，那时候你会知道每个 API 背后对应的是哪一块标准。

参考内容：

1. How to Fool Analysis Tools, https://tuanlinh.gitbook.io/ctf/golang-function-name-obfuscation-how-to-fool-analysis-tools
2. Go 1.2 Runtime Symbol Information, Russ Cox, https://docs.google.com/document/d/1lyPIbmsYbXnpNj57a261hgOYVpNRcgydurVQIyZOz_o/pub
3. Some notes on the structure of Go Binaries, https://utcc.utoronto.ca/~cks/space/blog/programming/GoBinaryStructureNotes
4. Building a better Go Linker, Austin Clements, https://docs.google.com/document/d/1D13QhciikbdLtaI67U6Ble5d_1nsI4befEd6_k1z91U/view
5. Time for Some Function Recovery, https://www.mdeditor.tw/pl/2DRS/zh-hk
