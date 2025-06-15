## Core (Part1): ELF核心转储文件剖析

可执行与可链接格式(ELF) 🧝 用于编译输出(`.o`文件)、可执行文件、共享库和核心转储文件。前几种用途在[System V ABI规范](http://www.sco.com/developers/devspecs/gabi41.pdf)和[工具接口标准(TIS) ELF规范](http://refspecs.linuxbase.org/elf/elf.pdf)中都有详细说明，但关于ELF格式在核心转储中的使用似乎没有太多文档。

我们接下来要介绍 `tinydbg core [executable] [corefile]` 对core文件进行调试，在这之前我们必须先了解下Core文件的事实上的规范，要记录些什么，按什么格式记录，如何兼容不同的调试器。理解了Core文件内容如何生成，也就理解了调试器读取Core文件时应该如何读取，才能重建问题现场。

这篇文章 [Anatomy of an ELF core file](https://www.gabriel.urdhr.fr/2015/05/29/core-file/) 中对Core文件的事实上的规范进行了梳理、总结，以下是摘录在这篇文章中的一些关于Core文件的说明。

ps: 本小节已经假定您已经阅读并理解了ELF文件的构成，这部分内容我们在第7章进行了介绍。另外，如果您想速览ELF文件相关内容给，也可以参考这篇文章 [knowledge about ELF files](https://www.gabriel.urdhr.fr/2015/09/28/elf-file-format/)，介绍也非常详实。

OK，我们先创建一个core dump文件作为示例，方便结合着来介绍。

```bash
    pid=$(pgrep xchat)
    gcore $pid
    readelf -a core.$pid
```

### ELF header

Core文件中ELF头部没有什么特别之处。`e_type=ET_CORE` 标记表明这是一个core文件：

```bash
    ELF Header:
      Magic:   7f 45 4c 46 02 01 01 00 00 00 00 00 00 00 00 00
      Class:                             ELF64
      Data:                              2's complement, little endian
      Version:                           1 (current)
      OS/ABI:                            UNIX - System V
      ABI Version:                       0
      Type:                              CORE (Core file)
      Machine:                           Advanced Micro Devices X86-64
      Version:                           0x1
      Entry point address:               0x0
      Start of program headers:          64 (bytes into file)
      Start of section headers:          57666560 (bytes into file)
      Flags:                             0x0
      Size of this header:               64 (bytes)
      Size of program headers:           56 (bytes)
      Number of program headers:         344
      Size of section headers:           64 (bytes)
      Number of section headers:         346
      Section header string table index: 345
```

### Program headers

Core文件中的段头表和可执行程序中的段头表，在某些字段含义上是有变化的，接下来会介绍。

```bash
    Program Headers:
      Type           Offset             VirtAddr           PhysAddr
                     FileSiz            MemSiz              Flags  Align
      NOTE           0x0000000000004b80 0x0000000000000000 0x0000000000000000
                     0x0000000000009064 0x0000000000000000  R      1
      LOAD           0x000000000000dbe4 0x0000000000400000 0x0000000000000000
                     0x0000000000000000 0x000000000009d000  R E    1
      LOAD           0x000000000000dbe4 0x000000000069c000 0x0000000000000000
                     0x0000000000004000 0x0000000000004000  RW     1
      LOAD           0x0000000000011be4 0x00000000006a0000 0x0000000000000000
                     0x0000000000004000 0x0000000000004000  RW     1
      LOAD           0x0000000000015be4 0x0000000001872000 0x0000000000000000
                     0x0000000000ed4000 0x0000000000ed4000  RW     1
      LOAD           0x0000000000ee9be4 0x00007f248c000000 0x0000000000000000
                     0x0000000000021000 0x0000000000021000  RW     1
      LOAD           0x0000000000f0abe4 0x00007f2490885000 0x0000000000000000
                     0x000000000001c000 0x000000000001c000  R      1
      LOAD           0x0000000000f26be4 0x00007f24908a1000 0x0000000000000000
                     0x000000000001c000 0x000000000001c000  R      1
      LOAD           0x0000000000f42be4 0x00007f24908bd000 0x0000000000000000
                     0x00000000005f3000 0x00000000005f3000  R      1
      LOAD           0x0000000001535be4 0x00007f2490eb0000 0x0000000000000000
                     0x0000000000000000 0x0000000000002000  R E    1
      LOAD           0x0000000001535be4 0x00007f24910b1000 0x0000000000000000
                     0x0000000000001000 0x0000000000001000  R      1
      LOAD           0x0000000001536be4 0x00007f24910b2000 0x0000000000000000
                     0x0000000000001000 0x0000000000001000  RW     1
      LOAD           0x0000000001537be4 0x00007f24910b3000 0x0000000000000000
                     0x0000000000060000 0x0000000000060000  RW     1
      LOAD           0x0000000001597be4 0x00007f2491114000 0x0000000000000000
                     0x0000000000800000 0x0000000000800000  RW     1
      LOAD           0x0000000001d97be4 0x00007f2491914000 0x0000000000000000
                     0x0000000000000000 0x00000000001a8000  R E    1
      LOAD           0x0000000001d97be4 0x00007f2491cbc000 0x0000000000000000
                     0x000000000000e000 0x000000000000e000  R      1
      LOAD           0x0000000001da5be4 0x00007f2491cca000 0x0000000000000000
                     0x0000000000003000 0x0000000000003000  RW     1
      LOAD           0x0000000001da8be4 0x00007f2491ccd000 0x0000000000000000
                     0x0000000000001000 0x0000000000001000  RW     1
      LOAD           0x0000000001da9be4 0x00007f2491cd1000 0x0000000000000000
                     0x0000000000008000 0x0000000000008000  R      1
      LOAD           0x0000000001db1be4 0x00007f2491cd9000 0x0000000000000000
                     0x000000000001c000 0x000000000001c000  R      1
    [...]
```

程序头中的`PT_LOAD`条目描述了进程的虚拟内存区域(VMAs):

* `VirtAddr` 是VMA的起始虚拟地址；
* `MemSiz` 是VMA在虚拟地址空间中的大小；
* `Flags` 是这个VMA的权限(读、写、执行)；
* `Offset` 是对应数据在core dump文件中的偏移量。这 **不是** 在原始映射文件中的偏移量。
* `FileSiz` 是在这个core文件中对应数据的大小。与源文件内容相同的 “**只读文件**” 映射VMA不会在core文件中重复。它们的`FileSiz`为0,我们需要查看原始文件才能获得内容；
* Non-Anonymous VMA关联的文件的名称和在该文件中的偏移量不在这里描述,而是在`PT_NOTE`段中描述(其内容将在后面介绍)。

由于这些是VMAs (vm_area)，它们都按页边界对齐。

我们可以用 `cat /proc/$pid/maps` 进行比较，会发现相同的信息:

```bash
    00400000-0049d000 r-xp 00000000 08:11 789936          /usr/bin/xchat
    0069c000-006a0000 rw-p 0009c000 08:11 789936          /usr/bin/xchat
    006a0000-006a4000 rw-p 00000000 00:00 0
    01872000-02746000 rw-p 00000000 00:00 0               [heap]
    7f248c000000-7f248c021000 rw-p 00000000 00:00 0
    7f248c021000-7f2490000000 ---p 00000000 00:00 0
    7f2490885000-7f24908a1000 r--p 00000000 08:11 1442232 /usr/share/icons/gnome/icon-theme.cache
    7f24908a1000-7f24908bd000 r--p 00000000 08:11 1442232 /usr/share/icons/gnome/icon-theme.cache
    7f24908bd000-7f2490eb0000 r--p 00000000 08:11 1313585 /usr/share/fonts/opentype/ipafont-gothic/ipag.ttf
    7f2490eb0000-7f2490eb2000 r-xp 00000000 08:11 1195904 /usr/lib/x86_64-linux-gnu/gconv/CP1252.so
    7f2490eb2000-7f24910b1000 ---p 00002000 08:11 1195904 /usr/lib/x86_64-linux-gnu/gconv/CP1252.so
    7f24910b1000-7f24910b2000 r--p 00001000 08:11 1195904 /usr/lib/x86_64-linux-gnu/gconv/CP1252.so
    7f24910b2000-7f24910b3000 rw-p 00002000 08:11 1195904 /usr/lib/x86_64-linux-gnu/gconv/CP1252.so
    7f24910b3000-7f2491113000 rw-s 00000000 00:04 1409039 /SYSV00000000 (deleted)
    7f2491113000-7f2491114000 ---p 00000000 00:00 0
    7f2491114000-7f2491914000 rw-p 00000000 00:00 0      [stack:1957]
    [...]
```

core dump中的前三个 `PT_LOAD` 条目映射到`xchat`ELF文件的VMAs:

* `00400000-0049d000`, 对应只读可执行段的VMA;
* `0069c000-006a0000`, 对应读写段已初始化部分的VMA;
* `006a0000-006a4000`, 读写段中不在`xchat` ELF文件中的部分(零初始化的`.bss`段)。

我们可以将其与`xchat`程序的程序头进行比较:

```bash
    Program Headers:
      Type           Offset             VirtAddr           PhysAddr
                     FileSiz            MemSiz              Flags  Align
      PHDR           0x0000000000000040 0x0000000000400040 0x0000000000400040
                     0x00000000000001c0 0x00000000000001c0  R E    8
      INTERP         0x0000000000000200 0x0000000000400200 0x0000000000400200
                     0x000000000000001c 0x000000000000001c  R      1
          [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]
      LOAD           0x0000000000000000 0x0000000000400000 0x0000000000400000
                     0x000000000009c4b4 0x000000000009c4b4  R E    200000
      LOAD           0x000000000009c4b8 0x000000000069c4b8 0x000000000069c4b8
                     0x0000000000002bc9 0x0000000000007920  RW     200000
      DYNAMIC        0x000000000009c4d0 0x000000000069c4d0 0x000000000069c4d0
                     0x0000000000000360 0x0000000000000360  RW     8
      NOTE           0x000000000000021c 0x000000000040021c 0x000000000040021c
                     0x0000000000000044 0x0000000000000044  R      4
      GNU_EH_FRAME   0x0000000000086518 0x0000000000486518 0x0000000000486518
                     0x0000000000002e64 0x0000000000002e64  R      4
      GNU_STACK      0x0000000000000000 0x0000000000000000 0x0000000000000000
                     0x0000000000000000 0x0000000000000000  RW     10

     Section to Segment mapping:
      Segment Sections...
       00
       01     .interp
       02     .interp .note.ABI-tag .note.gnu.build-id .gnu.hash .dynsym .dynstr .gnu.version .gnu.version_d .gnu.version_r .rela.dyn .rela.plt .init .plt .text .fini .rodata .eh_frame_hdr .eh_frame
       03     .init_array .fini_array .jcr .dynamic .got .got.plt .data .bss
       04     .dynamic
       05     .note.ABI-tag .note.gnu.build-id
       06     .eh_frame_hdr
       07
```

### Sections

ELF核心转储文件通常不会包含节头表。Linux内核在生成核心转储文件时不会生成节头表。GDB会生成与程序头表信息相同的节头表:

* `SHT_NOBITS` 类型的节在核心文件中不存在,但会引用其他已存在文件的部分内容;
* `SHT_PROGBITS` 类型的节存在于核心文件中;
* `SHT_NOTE` 类型的节头表映射到`PT_NOTE`程序头表。

```bash
    Section Headers:
      [Nr] Name              Type             Address           Offset
           Size              EntSize          Flags  Link  Info  Align
      [ 0]                   NULL             0000000000000000  00000000
           0000000000000000  0000000000000000           0     0     0
      [ 1] note0             NOTE             0000000000000000  00004b80
           0000000000009064  0000000000000000   A       0     0     1
      [ 2] load              NOBITS           0000000000400000  0000dbe4
           000000000009d000  0000000000000000  AX       0     0     1
      [ 3] load              PROGBITS         000000000069c000  0000dbe4
           0000000000004000  0000000000000000  WA       0     0     1
      [ 4] load              PROGBITS         00000000006a0000  00011be4
           0000000000004000  0000000000000000  WA       0     0     1
      [ 5] load              PROGBITS         0000000001872000  00015be4
           0000000000ed4000  0000000000000000  WA       0     0     1
      [ 6] load              PROGBITS         00007f248c000000  00ee9be4
           0000000000021000  0000000000000000  WA       0     0     1
      [ 7] load              PROGBITS         00007f2490885000  00f0abe4
           000000000001c000  0000000000000000   A       0     0     1
      [ 8] load              PROGBITS         00007f24908a1000  00f26be4
           000000000001c000  0000000000000000   A       0     0     1
      [ 9] load              PROGBITS         00007f24908bd000  00f42be4
           00000000005f3000  0000000000000000   A       0     0     1
      [10] load              NOBITS           00007f2490eb0000  01535be4
           0000000000002000  0000000000000000  AX       0     0     1
      [11] load              PROGBITS         00007f24910b1000  01535be4
           0000000000001000  0000000000000000   A       0     0     1
      [12] load              PROGBITS         00007f24910b2000  01536be4
           0000000000001000  0000000000000000  WA       0     0     1
      [13] load              PROGBITS         00007f24910b3000  01537be4
           0000000000060000  0000000000000000  WA       0     0     1
    [...]
      [345] .shstrtab         STRTAB           0000000000000000  036febe4
           0000000000000016  0000000000000000           0     0     1
    Key to Flags:
      W (write), A (alloc), X (execute), M (merge), S (strings), l (large)
      I (info), L (link order), G (group), T (TLS), E (exclude), x (unknown)
      O (extra OS processing required) o (OS specific), p (processor specific
```

注意，tinydbg中也不生成这里的节头表，只生成程序头表，因为借鉴相关的实现的时候，也是参考了Linux内核中的部分实现逻辑，而Linux内核生成Core文件时不生成sections。

### Notes

`PT_NOTE` 程序头记录了额外的信息，比如不同线程的CPU寄存器内容、与每个VMA关联的映射的文件等。它由这一系列的 [PT_NOTE entries](http://refspecs.linuxbase.org/elf/elf.pdf#page=42)组成,这些条目是[`ElfW(Nhdr)`](https://github.com/lattera/glibc/blob/895ef79e04a953cac1493863bcae29ad85657ee1/include/link.h#L351)结构(即`Elf32_Nhdr`或`Elf64_Nhdr`):

* 发起者名称;
* 发起者特定的ID(4字节值);
* 二进制内容。

```bash
    typedef struct elf32_note {
      Elf32_Word    n_namesz;       /* Name size */
      Elf32_Word    n_descsz;       /* Content size */
      Elf32_Word    n_type;         /* Content type */
    } Elf32_Nhdr;

    typedef struct elf64_note {
      Elf64_Word n_namesz;  /* Name size */
      Elf64_Word n_descsz;  /* Content size */
      Elf64_Word n_type;    /* Content type */
    } Elf64_Nhdr;
```

这些是notes中的内容:

```bash
    Displaying notes found at file offset 0x00004b80 with length 0x00009064:
      Owner                 Data size       Description
      CORE                 0x00000088       NT_PRPSINFO (prpsinfo structure)

      CORE                 0x00000150       NT_PRSTATUS (prstatus structure)
      CORE                 0x00000200       NT_FPREGSET (floating point registers)
      LINUX                0x00000440       NT_X86_XSTATE (x86 XSAVE extended state)
      CORE                 0x00000080       NT_SIGINFO (siginfo_t data)

      CORE                 0x00000150       NT_PRSTATUS (prstatus structure)
      CORE                 0x00000200       NT_FPREGSET (floating point registers)
      LINUX                0x00000440       NT_X86_XSTATE (x86 XSAVE extended state)
      CORE                 0x00000080       NT_SIGINFO (siginfo_t data)

      CORE                 0x00000150       NT_PRSTATUS (prstatus structure)
      CORE                 0x00000200       NT_FPREGSET (floating point registers)
      LINUX                0x00000440       NT_X86_XSTATE (x86 XSAVE extended state)
      CORE                 0x00000080       NT_SIGINFO (siginfo_t data)

      CORE                 0x00000150       NT_PRSTATUS (prstatus structure)
      CORE                 0x00000200       NT_FPREGSET (floating point registers)
      LINUX                0x00000440       NT_X86_XSTATE (x86 XSAVE extended state)
      CORE                 0x00000080       NT_SIGINFO (siginfo_t data)

      CORE                 0x00000130       NT_AUXV (auxiliary vector)
      CORE                 0x00006cee       NT_FILE (mapped files)
```

大多数数据结构（如`prpsinfo`、`prstatus`等）都定义在C语言头文件中（比如`linux/elfcore.h`）。

#### 通用进程信息

`CORE/NT_PRPSINFO` 条目定义了通用的进程信息,如进程状态、UID、GID、文件名和(部分)参数。

`CORE/NT_AUXV` 条目描述了[AUXV辅助向量](https://refspecs.linuxfoundation.org/LSB_1.3.0/IA64/spec/auxiliaryvector.html)。

#### 线程信息

每个线程都有以下条目:

* `CORE/NT_PRSTATUS` (PID、PPID、通用寄存器内容等);
* `CORE/NT_FPREGSET` (浮点寄存器内容);
* `CORE/NT_X86_STATE`;
* `CORE/SIGINFO`。

对于多线程进程,有两种处理方式:

* 要么将所有线程信息放在同一个 `PT_NOTE` 中,此时消费者必须猜测每个条目属于哪个线程(实践中,一个 `NT_PRSTATUS` 定义了一个新线程);
* 要么将每个线程放在单独的 `PT_NOTE` 中。

参见 [LLDB 源代码](https://github.com/llvm-mirror/lldb/blob/f7adf4b988da7bd5e13c99af60b6f030eb1beefe/source/Plugins/Process/elf-core/ProcessElfCore.cpp#L465) 中的说明:

> 如果一个 core 文件包含多个线程上下文,则有两种数据形式
>
> 1. 每个线程上下文(2个或更多NOTE条目)包含在其自己的段(PT_NOTE)中
> 2. 所有线程上下文存储在单个段(PT_NOTE)中。这种情况稍微复杂一些,因为在解析时我们必须找到新线程的起始位置。当前实现在找到 NT_PRSTATUS 或 NT_PRPSINFO NOTE 条目时标记新线程的开始。

在我们的 `tinydbg> dump [output]` 生成core文件时，是将多线程信息放在一个PT_NOTE中进行处理的。

#### 文件关联

`CORE/NT_FILE` 条目描述了虚拟内存区域(VMA)和文件之间的关联关系。每个非匿名VMA都有一个条目，包含:

* VMA在虚拟地址空间中的位置(起始地址、结束地址);
* VMA在文件中的偏移量(页偏移);
* 关联的文件名。

```bash
        Page size: 1
                     Start                 End         Page Offset
        0x0000000000400000  0x000000000049d000  0x0000000000000000
            /usr/bin/xchat
        0x000000000069c000  0x00000000006a0000  0x000000000009c000
            /usr/bin/xchat
        0x00007f2490885000  0x00007f24908a1000  0x0000000000000000
            /usr/share/icons/gnome/icon-theme.cache
        0x00007f24908a1000  0x00007f24908bd000  0x0000000000000000
            /usr/share/icons/gnome/icon-theme.cache
        0x00007f24908bd000  0x00007f2490eb0000  0x0000000000000000
            /usr/share/fonts/opentype/ipafont-gothic/ipag.ttf
        0x00007f2490eb0000  0x00007f2490eb2000  0x0000000000000000
            /usr/lib/x86_64-linux-gnu/gconv/CP1252.so
        0x00007f2490eb2000  0x00007f24910b1000  0x0000000000002000
            /usr/lib/x86_64-linux-gnu/gconv/CP1252.so
        0x00007f24910b1000  0x00007f24910b2000  0x0000000000001000
            /usr/lib/x86_64-linux-gnu/gconv/CP1252.so
        0x00007f24910b2000  0x00007f24910b3000  0x0000000000002000
            /usr/lib/x86_64-linux-gnu/gconv/CP1252.so
        0x00007f24910b3000  0x00007f2491113000  0x0000000000000000
            /SYSV00000000 (deleted)
        0x00007f2491914000  0x00007f2491abc000  0x0000000000000000
            /usr/lib/x86_64-linux-gnu/libtcl8.6.so
        0x00007f2491abc000  0x00007f2491cbc000  0x00000000001a8000
            /usr/lib/x86_64-linux-gnu/libtcl8.6.so
        0x00007f2491cbc000  0x00007f2491cca000  0x00000000001a8000
            /usr/lib/x86_64-linux-gnu/libtcl8.6.so
        0x00007f2491cca000  0x00007f2491ccd000  0x00000000001b6000
            /usr/lib/x86_64-linux-gnu/libtcl8.6.so
        0x00007f2491cd1000  0x00007f2491cd9000  0x0000000000000000
            /usr/share/icons/hicolor/icon-theme.cache
        0x00007f2491cd9000  0x00007f2491cf5000  0x0000000000000000
            /usr/share/icons/oxygen/icon-theme.cache
        0x00007f2491cf5000  0x00007f2491d11000  0x0000000000000000
            /usr/share/icons/oxygen/icon-theme.cache
        0x00007f2491d11000  0x00007f2491d1d000  0x0000000000000000
            /usr/lib/xchat/plugins/tcl.so
    [...]
```

据我所知(从binutils的`readelf`源码中了解到)，`CORE/NT_FILE`条目的格式如下:

1. NT_FILE这样的映射条目的数量(32位或64位);
2. pagesize (GDB将其设为1而不是实际页大小,32位或64位);
3. 每个映射条目的格式:
  1. 起始地址
  2. 结束地址
  3. 文件偏移量
4. 按顺序排列的每个路径字符串(以null结尾)。

#### 其他信息

自定义的调试工具也可以生成一些定制化的信息，比如可以读取环境变量信息，读取 `/proc/<pid>/cmdline` 读取进程相关的启动参数，执行 `go version -m /proc/<pid>/exe`，记录下其中的go buildid、vcs.branch、vcs.version，以及go编译器版本。将这些信息记录下来，这在拿到core文件进行离线分析时，这些信息也有助于确定找到匹配的构建产物、构建环境、代码版本，也有助于排查问题。

### 本文小结

本文介绍了Linux系统中core dump文件的大致信息构成，并对core dump生成实践也进行了介绍，比如Linux内核、gdb、lldb调试器的做法，在了解了这些之后，我们可以开始介绍我们的tinydbg的调试会话命令 `tinydbg> dump [output]` 以及对core文件调试命令 `tinydbg core [executable] [core]` 了，继续吧。

### 参考文献
* [Anatomy of an ELF core file](https://www.gabriel.urdhr.fr/2015/05/29/core-file/)
* [A brief look into core dumps](https://uhlo.blogspot.com/2012/05/brief-look-into-core-dumps.html)
* [linux/fs/binfmt_elf.c](https://elixir.bootlin.com/linux/v4.20.17/source/fs/binfmt_elf.c)
* [The ELF file format](https://www.gabriel.urdhr.fr/2015/09/28/elf-file-format/)