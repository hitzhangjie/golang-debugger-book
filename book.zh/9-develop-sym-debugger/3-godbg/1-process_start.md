启动进程，没什么特殊的，和之前指令级调试的时候没什么不同。

只是说为了方便，我们可以增加一些新命令，比如：

-   godbg exec，执行可执行程序并调试
-   godbg attach，attach到运行中的进程

-   TODO：godbg debug，调试当前go module，这里可能涉及到一个自动编译过程

    涉及到一些编译选项注意一下：`go build -gcflags "all=-N -l"`。



任务优先级：低
