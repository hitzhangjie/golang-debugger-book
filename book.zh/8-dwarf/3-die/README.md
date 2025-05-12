## DIE简要介绍

### 内容简介

DWARF使用一系列的调试信息条目（DIEs）来对源程序进行描述，对于源程序中的某个程序构造进行描述，有的可能需要一个调试信息条目（DIE）就够了，有的则可能需要一组调试信息条目（DIEs）共同描述才可以。

每个调试信息条目都包含一个标签（tag）以及一系列的属性（attributes）：

- tag指明了当前调试信息条目描述的程序构造属于哪种类型，如类型、变量、函数、编译单元等；
- attribute定义了调试信息条目的一些特征，如函数的返回值类型是int类型;
- DIE可能有兄弟节点（sibling DIEs，由attribute DW_ATTR_type引用），也可能有子节点（Children，如编译单元中函数，函数的参数等）；

调试信息条目存储在.debug_info和.debug_types中，前者描述变量、代码等，后者多是描述一些类型定义。.debug_types设计初衷是为了避免不同编译单元中存在重复的类型定义相关的DIE信息，所以会考虑将每个类型的定义信息生成到独立section中，然后最后由linker将这些类型定义信息合并、去重后生成到.debug_types中。在DWARFv5中，已经将.debug_types合并入.debug_info中。

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

如果编译器对调试信息进行了压缩，压缩后的调试信息将存储在：1）目标文件中的".zdebug_"前缀的section中，如未压缩的调试信息条目对应section是.debug_info，那么压缩后将存储在.zdebug_info中；2）也可能仍然存储在".debug_"前缀的section中，但是对应的section的Compressed标记设置为true，并且设置对应的压缩算法，如zlib或者zstd。

本文简要介绍了DIE的相关信息，接下来来详细了解下DIE。

### 参考文献

1. DWARF, https://en.wikipedia.org/wiki/DWARF
2. DWARFv1, https://dwarfstd.org/doc/dwarf_1_1_0.pdf
3. DWARFv2, https://dwarfstd.org/doc/dwarf-2.0.0.pdf
4. DWARFv3, https://dwarfstd.org/doc/Dwarf3.pdf
5. DWARFv4, https://dwarfstd.org/doc/DWARF4.pdf
