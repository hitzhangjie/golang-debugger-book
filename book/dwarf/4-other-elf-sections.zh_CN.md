### 5.4.6 ELF Sections

虽然DWARF的定义方式使其可以与任何目标文件格式一起使用，但最经常与ELF一起使用。

DWARF调试信息根据描述对象的不同，在最终存储的时候也进行了归类、存储到不同的section。section名称均以前缀'.debug_’开头。为了提升效率，对DWARF数据的大多数引用都是通过相对于当前编译单元的偏移量来引用的，而不是重复存储或者遍历之类的低效操作。这避免了重定位调试数据的开销，使程序加载和调试速度都得以提升。

常见的ELF sections及其存储的内容如下:

1. .debug_abbrev, 存储.debug_info中使用的缩写信息；
2. .debug_arranges, 存储一个加速访问的查询表，通过内存地址查询对应编译单元信息；
3. .debug_frame, 存储调用栈帧信息；
4. .debug_info, 存储核心DWARF数据，包含了描述变量、代码等的DIEs；
5. .debug_line, 存储行号表程序 (程序指令由行号表状态机执行，执行后构建出完整的行号表)
6. .debug_loc, 存储location描述信息；
7. .debug_macinfo, 存储宏相关描述信息；
8. .debug_pubnames, 存储一个加速访问的查询表，通过名称查询全局对象和函数；
9. .debug_pubtypes, 存储一个加速访问的查询表，通过名称查询全局类型；
10. .debug_ranges, 存储DIEs中引用的address ranges；
11. .debug_str, 存储.debug_info中引用的字符串表，也是通过偏移量来引用；
12. .debug_types, 存储描述数据类型相关的DIEs；

