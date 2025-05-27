函数，符号级调试器里面能拿函数干什么呢，这个可能临时没什么用，反汇编当前函数？



radare2里面有个常用命令pdf：print disassemble function，打印当前函数的反汇编信息，支持这个功能还是可以的，但是一个函数内包含的指令可能比较多，可能需要考虑pager less或者pager more一类的支持。



TODO 任务优先级：低