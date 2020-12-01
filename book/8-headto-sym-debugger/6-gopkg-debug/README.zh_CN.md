## 符号级调试基础

### go标准库

go标准库package `debug/*`，专门用来读取、解析go编译工具链生成的符号信息：

-   `debug/elf`支持ELF文件的读取、解析，提供了方法来根据名称定位section；

-   `debug/gosym`支持.gosymtab符号表、.gopclntab行号表的解析。设计上.gopclntab中通过pcsp记录了pc值对应的栈帧大小，所以很容易定位返回地址，可进一步确定caller，重复该过程可跟踪goroutine调用栈信息，如panic时打印的stacktrace信息；
-   `debug/dwarf`DWARF数据的读取、解析，数据压缩(.debug\_*)、不压缩(.zdebug_）两种格式均支持；

下面介绍下上述package的使用，了解它们对开发符号级调试器提供了哪些帮助。



参考内容：

1. How to Fool Analysis Tools, https://tuanlinh.gitbook.io/ctf/golang-function-name-obfuscation-how-to-fool-analysis-tools

2. Go 1.2 Runtime Symbol Information, Russ Cox, https://docs.google.com/document/d/1lyPIbmsYbXnpNj57a261hgOYVpNRcgydurVQIyZOz_o/pub

3. Some notes on the structure of Go Binaries, https://utcc.utoronto.ca/~cks/space/blog/programming/GoBinaryStructureNotes

4. Buiding a better Go Linker, Austin Clements, https://docs.google.com/document/d/1D13QhciikbdLtaI67U6Ble5d_1nsI4befEd6_k1z91U/view


5.  Time for Some Function Recovery, https://www.mdeditor.tw/pl/2DRS/zh-hk