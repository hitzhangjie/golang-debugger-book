#### 基于ELF协作

可以肯定的是，链接器和加载器之间不是完全孤立的，它们之间也是一种协作关系。

- 静态链接，静态加载。链接器/usr/bin/ld使用静态库(.a)链接，加载器是内核本身；

- 静态加载，动态链接。链接器/usr/bin/ld使用动态库(.so)链接，加载器是二进制解释器，如在debian9上是/lib64/ld-linux-x86-64.so.2（该路径现在对应的是/lib/x86_64-linux-gnu/ld-2.24.so），这个解释器对应so文件的加载由内核完成，可执行程序本身也由内核完成；

- 静态链接，动态加载。linux上没有使用；

- 动态链接，动态加载。加载器是通过libdl库进行dlopen进行加载，链接器的工作分散在libdl和用户程序中，如dlopen加载库，dlsym解析库就涉及到动态链接。

注意到当链接器使用静态链接或动态链接时，加载器的执行逻辑有所变化。静态链接时内核自己来加载可执行程序和库，动态链接时则将库的加载动作交给二进制解释器来代为处理。

那内核是如何来识别这种差异的呢？这里的桥梁就是ELF文件中的信息，它表明了某些某些库信息在链接时是使用了何种链接方式，内核据此作出不同处理。

#### 工作原理

静态链接、动态链接对生成的ELF文件有什么影响？

Linux内核在执行可执行程序时，如何读取ELF文件信息来决定采用何种方式处理的？



TODO：补充这部分内容



### 参考文献

1. What are the executable ELF files respectively for static linker, dynamic linker, loader and dynamic loader, Roel Van de Paar, https://www.youtube.com/watch?v=yzI-78zy4HQ

2. Computer System: A Programmer's Perspective, Randal E.Bryant, David R. O'Hallaron, p450-p479

   深入理解计算机系统, 龚奕利 雷迎春 译, p450-p479