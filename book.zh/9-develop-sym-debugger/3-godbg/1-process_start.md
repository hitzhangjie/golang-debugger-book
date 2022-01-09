启动进程，没什么特殊的，和之前指令级调试的时候没什么不同。

只是说为了方便，我们可以增加一些新命令，比如：

-   godbg exec，执行可执行程序并调试
-   godbg attach，attach到运行中的进程

-   TODO：godbg debug，调试当前go module，这里可能涉及到一个自动编译过程

    涉及到一些编译选项注意一下：`go build -gcflags "all=-N -l"`。



任务优先级：低



修复了一个bug，attach pid时:

- 先ptrace attach到这个进程（线程）
- 然后proc读取其exec文件路径，并通过symbol.Analyze完成DWARF信息的加载解析，这个后面建议重写，没有调用栈信息表、行号表等，直接使用go-delve/delve中的dwarf package重写
- proc读取comm信息，这里记录下当时启动时的命令、proc读取cmdline，这里记录下命令行参数信息。记录命令行及其参数，是为了方便后面支持restart
- 再然后更新线程列表
  - proc下读取所有线程id，
  - 对上述所有线程全部ptrace attach，这之后意味着进程下的所有线程都被ptrace跟踪了呀，都不能跑了呀。符合预期否？符合，就是不希望它跑嘛。
  - 并且为每个线程都设置了一个选项PTRACE_O_TRACECLONE选项，什么意思呢，就是说从这个线程创建出来的所有新线程都将被ptrace自动跟踪，内核负责处理这个事情。



还有问题：

- 首先明确main.main是由main goroutine来执行的，但是main goroutine并一定有main thread来调度，这将有助于明确为什么我们已经attach了pid，但是main goroutine依然在执行的问题。

- 如何让线程停下来，这就涉及到多线程调试的问题了，我们需要attach所有已经创建的线程，还要attach所有后续新创建的线程。
- 
