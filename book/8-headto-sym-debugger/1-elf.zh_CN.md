## 符号级调试基础

### 理解ELF文件

ELF ([Executable and Linkable Format](https://en.wikipedia.org/wiki/Executable_and_Linkable_Format))，可执行链接嵌入格式，是Unix、Linux环境下一种十分常见的文件格式，它可以用于可执行程序、目标代码、共享库甚至核心转储文件等。

ELF文件格式如下所示，它包含了ELF头、Program Header Table、Section Header Table，以及其他字段，关于ELF文件的更详细信息，您可以查看Wikipedia上文档。

![img](assets/clip_image001.png)

ELF文件中的Program Header和Section Header，其实是定义了两种不同类型的视图：

-   从可执行程序角度（executable point of view）来看，进程运行时需要了解如何将程序中不同部分，加载到进程虚拟内存地址空间中的不同区域，这就是段（segments）的概念。

    以测试程序golang-debugger-lessons/testdata/loop2测试程序为例，我们来看下其可执行程序视角的视图，我们可以看到其包含7个program headers，可以看到每个program header在虚拟内存中组织的地址，最下方还显示了每个program header包含的sections。

    ```bash
    $ readelf -l testdata/loop2
    
    Elf file type is EXEC (Executable file)
    Entry point 0x4647a0
    There are 7 program headers, starting at offset 64
    
    Program Headers:
      Type           Offset             VirtAddr           PhysAddr
                     FileSiz            MemSiz              Flags  Align
      PHDR           0x0000000000000040 0x0000000000400040 0x0000000000400040
                     0x0000000000000188 0x0000000000000188  R      1000
      NOTE           0x0000000000000f9c 0x0000000000400f9c 0x0000000000400f9c
                     0x0000000000000064 0x0000000000000064  R      4
      LOAD           0x0000000000000000 0x0000000000400000 0x0000000000400000
                     0x0000000000099294 0x0000000000099294  R E    1000
      LOAD           0x000000000009a000 0x000000000049a000 0x000000000049a000
                     0x00000000000a48c6 0x00000000000a48c6  R      1000
      LOAD           0x000000000013f000 0x000000000053f000 0x000000000053f000
                     0x0000000000015900 0x0000000000048088  RW     1000
      GNU_STACK      0x0000000000000000 0x0000000000000000 0x0000000000000000
                     0x0000000000000000 0x0000000000000000  RW     8
      LOOS+5041580   0x0000000000000000 0x0000000000000000 0x0000000000000000
                     0x0000000000000000 0x0000000000000000         8
    
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

- 从链接器工作角度（the linkable point of view）来看，程序将代码、数据划分成不同的sections，如指令在.text、只读数据在.rodata等。程序中的每个section属于一个或多个segments（也可能不属于），每个section在程序运行时会（也可能不会）被mmap到进程地址空间。

    以测试程序golang-debugger-lessons/testdata/loop2测试程序为例，我们来看下其链接器角度的视图，可以看到其包含了25个sections，每个section都有类型、偏移量、大小、链接顺序、对齐等信息，用以指导链接器完成链接操作。

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
      [ 3] .shstrtab         STRTAB           0000000000000000  000de0e0
           00000000000001bc  0000000000000000           0     0     1
      [ 4] .typelink         PROGBITS         00000000004de2a0  000de2a0
           0000000000000734  0000000000000000   A       0     0     32
      [ 5] .itablink         PROGBITS         00000000004de9d8  000de9d8
           0000000000000050  0000000000000000   A       0     0     8
      [ 6] .gosymtab         PROGBITS         00000000004dea28  000dea28
           0000000000000000  0000000000000000   A       0     0     1
      [ 7] .gopclntab        PROGBITS         00000000004dea40  000dea40
           000000000005fe86  0000000000000000   A       0     0     32
      [ 8] .go.buildinfo     PROGBITS         000000000053f000  0013f000
           0000000000000020  0000000000000000  WA       0     0     16
      [ 9] .noptrdata        PROGBITS         000000000053f020  0013f020
           000000000000e4c0  0000000000000000  WA       0     0     32
      [10] .data             PROGBITS         000000000054d4e0  0014d4e0
           0000000000007410  0000000000000000  WA       0     0     32
      [11] .bss              NOBITS           0000000000554900  00154900
           000000000002ff30  0000000000000000  WA       0     0     32
      [12] .noptrbss         NOBITS           0000000000584840  00184840
           0000000000002848  0000000000000000  WA       0     0     32
      [13] .zdebug_abbrev    PROGBITS         0000000000588000  00155000
           0000000000000119  0000000000000000           0     0     1
      [14] .zdebug_line      PROGBITS         0000000000588119  00155119
           000000000001cc0d  0000000000000000           0     0     1
      [15] .zdebug_frame     PROGBITS         00000000005a4d26  00171d26
           00000000000062e9  0000000000000000           0     0     1
      [16] .zdebug_pubnames  PROGBITS         00000000005ab00f  0017800f
           0000000000001497  0000000000000000           0     0     1
      [17] .zdebug_pubtypes  PROGBITS         00000000005ac4a6  001794a6
           00000000000034ea  0000000000000000           0     0     1
      [18] .debug_gdb_script PROGBITS         00000000005af990  0017c990
           000000000000002c  0000000000000000           0     0     1
      [19] .zdebug_info      PROGBITS         00000000005af9bc  0017c9bc
           0000000000033818  0000000000000000           0     0     1
      [20] .zdebug_loc       PROGBITS         00000000005e31d4  001b01d4
           0000000000016969  0000000000000000           0     0     1
      [21] .zdebug_ranges    PROGBITS         00000000005f9b3d  001c6b3d
           0000000000008cdc  0000000000000000           0     0     1
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




标准库提供了package`debug/elf`来读取、解析elf文件数据，相关的数据类型及其之间的依赖关系，如下图所示：

![img](assets/clip_image002.png)

 简单讲，elf.File中包含了我们可以从elf文件中获取的所有信息，为了方便使用，标准库又提供了其他package `debug/gosym`来解析符号信息、行号表信息，还提供了`debug/dwarf`来解析调试信息等。

#### 

参考内容：

1. How to Fool Analysis Tools, https://tuanlinh.gitbook.io/ctf/golang-function-name-obfuscation-how-to-fool-analysis-tools

2. Go 1.2 Runtime Symbol Information, Russ Cox, https://docs.google.com/document/d/1lyPIbmsYbXnpNj57a261hgOYVpNRcgydurVQIyZOz_o/pub

3. Some notes on the structure of Go Binaries, https://utcc.utoronto.ca/~cks/space/blog/programming/GoBinaryStructureNotes

4. Buiding a better Go Linker, Austin Clements, https://docs.google.com/document/d/1D13QhciikbdLtaI67U6Ble5d_1nsI4befEd6_k1z91U/view


5.  Time for Some Function Recovery, https://www.mdeditor.tw/pl/2DRS/zh-hk