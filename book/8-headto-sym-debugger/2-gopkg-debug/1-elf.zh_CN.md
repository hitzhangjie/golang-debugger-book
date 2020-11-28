## 符号级调试基础

### pkg debug/elf

标准库提供了package`debug/elf`来读取、解析elf文件数据，相关的数据类型及其之间的依赖关系，如下图所示：

![image-20201128125408007](assets/image-20201128125408007.png)

 简单讲，elf.File中包含了我们可以从elf文件中获取的所有信息，为了方便使用，标准库又提供了其他package `debug/gosym`来解析符号信息、行号表信息，还提供了`debug/dwarf`来解析调试信息等。

参考内容：

1. How to Fool Analysis Tools, https://tuanlinh.gitbook.io/ctf/golang-function-name-obfuscation-how-to-fool-analysis-tools

2. Go 1.2 Runtime Symbol Information, Russ Cox, https://docs.google.com/document/d/1lyPIbmsYbXnpNj57a261hgOYVpNRcgydurVQIyZOz_o/pub

3. Some notes on the structure of Go Binaries, https://utcc.utoronto.ca/~cks/space/blog/programming/GoBinaryStructureNotes

4. Buiding a better Go Linker, Austin Clements, https://docs.google.com/document/d/1D13QhciikbdLtaI67U6Ble5d_1nsI4befEd6_k1z91U/view


5.  Time for Some Function Recovery, https://www.mdeditor.tw/pl/2DRS/zh-hk