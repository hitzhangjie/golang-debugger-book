需要新增加一个调试命令backtrack|bt，这个命令将打印当前函数所处的调用栈信息。前面简单介绍过如何读取.[z]debug_frame信息并用来查看指定pc对应的FDE，以及当下的CFA计算计算规则等，要实现这个bt特性，只需要了解下go程序调用栈的组织方式解决。

我们习惯上称之为Call Convention，只要了解了go函数传递参数、返回值的方式，存储返回地址的方式，存储caller base frame pointer的方式，解决这个问题就非常简单。



TODO 任务优先级：高