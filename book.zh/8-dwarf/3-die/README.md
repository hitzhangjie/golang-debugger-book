## DIE简要介绍

### 内容简介

DWARF使用一系列的调试信息条目（DIE, Debugging Information Entry）来对源程序中的各种程序构造进行描述。描述不同的程序构造，有的可能需要一个调试信息条目（DIE）就够了，有的则可能需要一组调试信息条目（DIEs）才可以。

每个DIE，都包含一个标签（tag）以及一系列的属性（attributes）：

- tag指明了当前调试信息条目描述的程序构造属于哪种类型，如类型、变量、函数、编译单元等；
- attribute定义了具体的属性、特征，如函数的名字、参数的类型、返回值的类型、函数的地址等;
- DIE可能有兄弟节点（sibling DIEs，由attribute DW_ATTR_type引用），也可能有子节点（Children，如编译单元中包含了一系列函数定义，每个函数定义又包括了入参、出参）；

调试信息条目存储在.debug_info中，DIE可以描述类型、变量、函数、编译单元等等不同的程序构造。DWARF v4中曾经提出将类型相关的描述存储在.debug_types中，初衷是为了避免不同编译单元中存在重复的类型定义，导致linker合并存储到.debug_info时出现重复的DIE信息，解法是每个类型写入独立的section，然后由linker合并、去重后写入.debug_types。即使不写入.debug_types，这也是可以做到的，DWARF v5中已经将类型相关的描述合并入.debug_info，废弃了.debug_types。

see: DWARFv5 Page8:

```
1.4 Changes from Version 4 to Version 5
The following is a list of the major changes made to the DWARF Debugging
13 Information Format since Version 4 was published. The list is not meant to be
14 exhaustive.
15 • Eliminate the .debug_types section introduced in DWARF Version 4 and
16 move its contents into the .debug_info section.
   ...
```

调试信息数据其实是比较大的，如果不经过压缩处理会导致二进制尺寸显著增加。一般会要求编译工具链生成调试信息时进行压缩处理，压缩后的调试信息将存储在：1）目标文件中的".zdebug_"前缀的section中，如未压缩的调试信息条目对应section是.debug_info，那么压缩后将存储在.zdebug_info中；2）也可能仍然存储在".debug_"前缀的section中，但是对应的section的Compressed标记设置为true，并且设置对应的压缩算法，如zlib或者zstd。3）此外，也有些平台上，工具链会将上述调试信息存储在独立的文件或者目录中，如macOS上会写入到对应的 `.dSYM/*` 文件夹中，调试器读取时需要注意这点。

本文简要介绍了DIE的构成，以及存储位置，接下来我们将详细介绍下DIE支持的所有Tags、Attributes以及它们可以描述的程序构造有哪些。

### 参考文献

1. DWARF, https://en.wikipedia.org/wiki/DWARF
2. DWARFv1, https://dwarfstd.org/doc/dwarf_1_1_0.pdf
3. DWARFv2, https://dwarfstd.org/doc/dwarf-2.0.0.pdf
4. DWARFv3, https://dwarfstd.org/doc/Dwarf3.pdf
5. DWARFv4, https://dwarfstd.org/doc/DWARF4.pdf
