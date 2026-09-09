打印变量，以print name为例，这里首先需要检查所有的DIE，找到name对应的DIE，然后找到对应的Type DIE，然后再结合name变量值在内存中的地址，结合这里的Type DIE的描述信息来读取并理解内存中的数据。这样就完成了变量name数据的读取显示。



我们优先实现几个类型的变量的读取。

-   string，当前已实现
-   int，TODO
-   []int，TODO
-   struct{}，TODO



我们还想添加一个gdb中的非常有用的调试命令ptype，比如ptype name，name其实是一个变量名，这个时候会打印出name这个变量的类型，如果name是string则显示stringheader的详细信息，而不只是显示string，这样对大家学习更友好一点。

当然也可以print name的时候显示为：string: "zhangjie"，表示name是string类型，value是"zhangjie"，而ptype name的时候则显示stringheader的信息。



TODO 任务优先级：高



