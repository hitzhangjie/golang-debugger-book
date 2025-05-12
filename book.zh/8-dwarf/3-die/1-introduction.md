## DIE详细介绍

每个调试信息条目（DIE）都由一个tag以及一系列attributes构成。

- tag指明了该DIE描述的程序构造的类型，如编译单元、函数、函数参数及返回值、变量、常量、数据类型等；
- attributes定义了该DIE的一些具体特征，如变量的名字DW_ATTR_name、变量所属的数据类型DW_ATTR_type；

从DWARF v1到v5，随着DWARF调试信息的完善，以及高级语言进一步抽象、进化，为了更好更高效地对它们进行描述，DWARF标准中的Tag枚举值、Attribute枚举值也在慢慢增加。以Tag枚举值为例，DWARF v1中定义了33个Tag枚举值，v2增加到了47个，v3增加到了57个，v4增加到了60个，最新的v5增加到了68个。Attributes当然也存在类似的扩展、数量增加的情况。

篇幅原因，我们先拿DWARF v2中的Tag、Attributes进行展示，让大家有个直观认识后，再与当前go编译工具链使用最多的DWARF v4、v5内容进行对齐。以免必要的内容还未介绍到位，大家就已经淹没在了不同版本的细节变迁中。

### DIE Tags

Tag，其枚举值以DW_TAG开头，它指明了DIE描述的程序构造所属的类型，下面表格中整理了DWARF v2中定义的Tag枚举值，各个Tag的具体含义则可以参考DWARF标准进行了解。

![img](assets/clip_image001.png)

### DIE Attributes

Attribute，其枚举值以DW_AT开头，它进一步补充了DIE要描述的程序构造的信息。

**一个attribute可能有各种类型的值**，如常量（如函数名称）、变量（如函数的开始地址）、对另一个DIE的引用（如函数返回值对应的类型DIE）等等。

假如有一些attributes的类型确定了，也要了解的是，它的取值类别可能有多种表示方式。如某些属性值包含了某种常量类型的数据，但是，常量数据也有多种表示形式（如固定为1、2、4、8字节长度的数据，或者可变长度的数据）。

属性的任何类型实例的特定表示，都与属性名称一起被编码，以方便更好地理解、解释DIE的含义。

下表列出了DWARF v2中定义的attributes：

![img](assets/clip_image002.png)

attribute取值可以划分为如下几种类型：

1. **Address**, 引用被描述程序的地址空间的某个位置；
2. **Block**, 未被解释的任意数量的字节数据块；
3. **Constant**, 1、2、4、8字节未被解释的数据，或者以LEB128形式编码的数据；
4. **Flag**, 指示属性存在与否的小常数；
5. **lineptr**, 引用存储着行号信息的DWARF section中的某个位置；
6. **loclistptr**, 引用存储着位置列表的DWARF section中的某个位置，某些对象的内存地址在其生命周期内会发生移动，需要通过位置列表来进行描述；
7. **macptr**, 引用存储着macro信息的DWARF section中的某个位置；
8. **rangelistptr**, 引用存储着非相邻地址区间信息的DWARF section中的某个位置；
9. **Reference**, 引用某个描述program的DIE；

   根据被引用DIE所在的编译单元与引用发生的编译单元是否相同，可以划分为两种类型的references：

   - 第一种引用，被引用的DIE所在的编译单元与当前编译单元是同一个，通过相对于该编译单元起始位置的偏移量来引用该DIE；
   - 第二种引用，被引用的DIE所在的编译单元可以在任意编译单元中，不一定与当前编译单元相同，通过被引用DIE的偏移量来引用该DIE；
10. **String**, 以'\0'结尾的字符序列，字符串可能会在DIE中直接表示，也可能通过一个独立的字符串表中的偏移量（索引）来引用。

### DIEs分类

根据描述信息的不同，可以将所有的DIEs划分为两大类：

1. 描述 **数据 和 类型** 的；
2. 描述 **函数 和 可执行代码** 的；

> 一个DIE可以有父、兄弟、孩子DIEs，DWARF调试信息可以被构造成一棵树，树中每个节点都是一个DIE，多个DIE组合在一起共同描述编程语言中具体的一个程序构造（如描述一个函数的定义）。如果考虑源码中所有的关系的话，那所有的DIEs形成的就是一个森林。

在后面的章节，我们会介绍DIEs的不同类型，然后再深入了解DWARF的其他知识。

### 大道至简

看到作者提到DWARF已经经历了这么多个版本，并且每个新版本较之旧版本都在不断扩展，大家心里难免有些抓毛，“我能掌握吗？”。

1）大家觉得理解 **“反射（reflection）**”困难吗？反射和这里的DWARF其实有异曲同工之妙。借助反射我们可以在程序运行时，动态理解对象的类型信息，有了类型信息我们也可以动态构建对象、修改对象属性信息。反射技术中使用到的类型信息就是程序运行时的对象的一些跟类型相关的元数据信息，这里的元数据信息的设计和组织面向这一种语言专属的设计。

2）大家觉得理解go runtime的 **.gopclntab** 困难吗？可能大家没有看过相关的实现细节，尽管我们多次提到了go runtime依赖它实现了运行时的调用栈跟踪。这里的.gopclntab也是针对go语言专属的设计。

相比较之下，而DWARF则是面向当前甚至将来所有的高级语言设计的一种描述语言，它也描述了程序的类型定义、对象的类型信息，借助它我们也可以知道内存中某个对象的类型信息，也可以据此构造对象、修改对象，只要我们愿意。行号表、调用栈信息表，也需要针对所有高级语言进行描述，而不能仅仅面向一种语言。当然了，DWARF是面向调试领域的，所以它生成的内容不会在程序执行时加载到内存。

所以，我这么给大家类比一下之后，大家觉得还困难吗？大道至简，道理是相通的，能够不拘泥于形式的灵活运用来解决问题，是我们应该向大师们学习的。

> ps: 为了方便大家学习，我编写了一个DIE可视化工具 [hitzhangjie/dwarfviewer](https://github.com/hitzhangjie/dwarfviewer)。借助此工具，您可以方便地查看ELF文件.debug_info中的DIE信息，包括DIE Tag、Attributes以及Children DIEs、Sibling DIEs。您可以写些简单的代码片段，如包含一个函数，或者一个类型，然后使用此工具对生成的DWARF信息进行对比，以加深理解。

### 参考文献

1. DWARF, https://en.wikipedia.org/wiki/DWARF
2. DWARFv1, https://dwarfstd.org/doc/dwarf_1_1_0.pdf
3. DWARFv2, https://dwarfstd.org/doc/dwarf-2.0.0.pdf
4. DWARFv3, https://dwarfstd.org/doc/Dwarf3.pdf
5. DWARFv4, https://dwarfstd.org/doc/DWARF4.pdf
6. dwarfviewer, https://github.com/hitzhangjie/dwarfviewer
