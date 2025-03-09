## 扩展阅读：Go汇编器简介

### 1. Plan9项目和Go语言的关系

Plan9是Bell实验室的一个研究性质的分布式操作系统，Go语言早期核心开发人员多来自这个项目组，他们将设计实现Plan9过程中的一些经验带到了Go语言中来，特别是a.out文件格式、plan9汇编、工具链这块。

see: https://man.cat-v.org/plan_9/6/a.out，比如：

- 汇编器输出后的目标文件格式、运行时会依赖的symtab+pclntab；
- 采用的汇编语言、伪寄存器(fp,sb,sp,pc)；

  - `FP`: Frame pointer: arguments and locals.
  - `PC`: Program counter: jumps and branches.
  - `SB`: Static base pointer: global symbols.
  - `SP`: Stack pointer: the highest address within the local stack frame.

  in Go, all user-defined symbols are written as offsets to the pseudo-registers `FP` (arguments and locals) and `SB` (globals).

### 2. Plan9 和其它OS不一样之处

Plan9本身是一个实验操作系统，它也有些设计实现上不同寻常操作系统的地方：

- 一切皆文件，包括对网络套接字甚至对远程计算机的操作，API都是通过一套编程接口，比Unix、Linux操作系统设计的还要绝；
- 有点奇葩的工具链命名，
  - 2c,3c,4c...8c，这些都是编译器，将.c源码编译为plan9汇编文件；
  - 2a,3a,4a...8a，这些都是汇编器，将.s源码汇编为目标文件；
    ps: object file, 翻译为目标文件好，还是对象文件好，@gemini表示翻译为目标文件好，ok! 目标程序的一部分。
  - 2l,3l,4l...8l，这些都是加载器，将可执行文件加载前会完成常规linker要做的符号解析、重定位的操作，然后再加载到内存中；
    ps：没有专门的linker，plan9的loader存在一部分常规linker的功能，well，ok!
- 汇编指令是一种semi-abstract instrution set，并不严格对应特定平台上的指令操作，比如MOV操作，指令选择阶段，会选择不同平台特定的机器指令，这点plan9和go都是这样的；

> **Plan9 loaders**: 关于Plan9 loader 2l,3l,..8l的疑问，为什么没有专门的linker？Plan9 loaders是不是具备常规linker的功能？
> 在 Plan 9 操作系统中，“加载器”（例如 Intel 386 的 `8l`）所扮演的角色与传统意义上的“链接器”有很大程度的重叠。

关于Plan9 loaders的功能说明：

* **编译器与加载器：**
  * Plan 9 的编译器（如 `8c`）生成目标文件。
  * 然后，加载器获取这些目标文件并生成最终的可执行文件。
* **加载器的功能：**
  * Plan 9 的加载器不仅仅是执行典型的运行时“加载”操作。它还执行关键的链接任务，包括：
    * **符号解析：** 解析不同目标文件和库之间的引用。
    * **机器码生成：**在plan9中，加载器才是真正生成最终机器码的程序。
    * **指令选择：**选择最有效的机器指令。
    * **分支折叠和指令调度：**优化可执行文件。
    * **库链接：**自动链接必要的库。
* **关键区别：**
  * 一个显著的区别是，Plan 9 加载器处理了大部分最终机器码的生成，而在许多其他系统中，这部分工作是在编译过程的早期完成的。这意味着plan9编译器产生的是一种抽象的汇编，而加载器将其转换为最终的机器码。
* **本质上：**
  * Plan 9 加载器的功能不仅仅是加载，它还包含了核心的链接职责。

### 3. Plan9和Go汇编器异同点

要充分掌握Go汇编，就得了解它的前身及它自己的演进，也就是说了解Plan9汇编器，以及Go中特殊的地方。

- [a manual for plan9 assembler, rob pike](https://doc.cat-v.org/plan_9/4th_edition/papers/asm)
- [a quick guide to Go&#39;s assembler](https://go.dev/doc/asm)

后续有机会，可以在我的博客里总结下Go汇编器的使用，本电子书中我们就不过多展开了，我们这里只介绍下Go汇编器的主要工作即可，我们不会考虑调试期间对Go汇编进行特殊支持 …… 这不在我们计划中，除非我们有大把时间。

### 参考文献

- plan9 a.out目标文件格式, https://man.cat-v.org/plan_9/6/a.out
- plan9 assemblers, https://man.cat-v.org/plan_9/1/2a
- plan9 compilers, https://man.cat-v.org/plan_9/1/2c
- plan9 loaders, https://man.cat-v.org/plan_9/1/2l
- plan9 used compilers, https://doc.cat-v.org/bell_labs/new_c_compilers/new_c_compiler.pdf

  > “ *This paper describes yet another series of C compilers. These compilers were developed over the last several years and are now in use on Plan 9. These compilers are experimental in nature and were developed to try out new ideas. Some of the ideas were good and some not so good.* ”
  >
- how to use plan9 c compiler, rob pike, https://doc.cat-v.org/plan_9/4th_edition/papers/comp
- a manual for plan9 assembler, rob pike, https://doc.cat-v.org/plan_9/4th_edition/papers/asm
- a quick guide to Go's assembler, https://go.dev/doc/asm
