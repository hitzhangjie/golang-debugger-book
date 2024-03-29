DWARF使用一系列的调试信息条目（DIEs）来对源程序进行描述，对于源程序中的某个程序构造进行描述，有的可能需要一个调试信息条目（DIE）就够了，有的则可能需要一组调试信息条目（DIEs）共同描述才可以。

每个调试信息条目都包含一个标签（tag）以及一系列的属性（attributes）：

- tag指明了当前调试信息条目描述的程序构造属于哪种类型，如类型、变量、函数、编译单元等；
- attribute定义了调试信息条目的一些特征，如函数的返回值类型是int类型;

调试信息条目存储在.debug_info和.debug_types中，后者多是描述一些类型定义，前者描述变量、代码等。

> 注：关于DWARF数据压缩
>
> 如果编译器对调试信息进行了压缩，压缩后的调试信息将存储在目标文件中的".zdebug_"前缀的section中，如未压缩的调试信息条目对应section是.debug_info，那么压缩后将存储在.zdebug_info中。

> 注：关于DWARF版本更新
>
> DWARF标准也在不断演进，在DWARF v5中，已经将.debug_types合并入.debug_info当中。当然go工具链目前还未完全按DWARF v5来实现。
