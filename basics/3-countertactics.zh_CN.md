## 4.3 反调试技术

只要付出足够的时间和精力，可以说任何程序都可以进行被逆向。 调试器使得恶意工程师理解程序逻辑更加方便了，这里的应对战术，其实是为了增加点软件逆向的难度，使恶意工程师越痛苦越好以阻止或者延缓他们弄清程序的正确工作方式。

鉴于此，我们可以采取一些步骤，这将使恶意工程师很难通过调试器窥视您的程序。

### 4.3.1 系统调用

#### 4.3.1.1 Windows
某些操作系统提供了一个特殊调用，该系统调用将指示当前进程是否在调试器的调试模式下执行。 例如，Windows KERNEL32.DLL导出一个名为`IsDebuggerPresent()`的函数。 您可以将此调用包装在诸如chk()之类的函数中。

![img](assets/clip_image002-3995693.png)

![img](assets/clip_image003-3995693.png)

该技术的窍门是程序启动后立即调用chk()。 这将增加在调试器遇到第一个断点之前chk代码被执行的可能性。

![img](assets/clip_image004-3995693.png)

如果观测到调试器正在调试当前进程，则可以强制程序运行异常、诡异，让正在调试的人懵逼。 调试器是个独特的工具，因为它使用户可以从中立的角度来观察程序。 通过插入类似chk的代码，可以迫使用户进入一个扭曲的量子宇宙，在该宇宙中，精心构造的诡异行为、输出可以有效保护您的程序，避免或者延缓被逆向。

#### 4.3.1.2 Linux

在Linux下，也有类似的方式，通常可以借助”`/proc/self/status`“中的”`TracerPid`“属性来判断是否有调试器正在调试当前进程。下面是一个Linux下检查当前进程是否在被调试器调试的示例。

> 下面是个示例，展示下在Linux上如何检查当前进程是否正在被调试：
>
> ```go
> package main
> 
> import "fmt"
> import "os"
> 
> func main() {
> 
>      fmt.Println("vim-go, pid: %d", os.Getpid())
> }
> ```
>
> ```bash
> $ dlv debug main.go
> dlv> b main.main
> dlv> c
> dlv> n
> dlv> n
> dlv> vim-go, pid: 746
> ```
>
> ```bash
> >cat /proc/746/status | grep TracePid
> TracePid: 688
> > cat /proc/688/cmdline
> dlv debug main.go
> ```
>
> 现在我们可以判断出当前进程正在被pid=688的调试器进程调试，并且该调试器是dlv。

#### 4.3.1.x 其他平台

略。

### 4.3.2 移除调试信息

使调试更加困难的一种简单方法是从交付程序中删除调试信息。 可以通过剥离调试信息（使用GNU的strip实用工具之类的工具）或通过设置开发工具来生成发行版本来完成。

一些商业软件公司更喜欢剥离调试信息并接受相关的性能影响，因为它允许销售工程师执行现场诊断。 当销售工程师进行内部咨询时，他们需要做的就是插入调试信息并启动调试器。

gcc编译器使用选项”**-g**“在其生成的目标代码中插入调试信息。 不指定该选项，则不输出任何符号信息。

如果尝试使用gdb调试它，gdb将提示找不到任何调试符号，将使调试人员很难看明白程序的状态、工作方式。

![img](assets/clip_image005-3995693.png)

缺少调试符号并不能阻止所有人，一些反编译器可以获取机器代码并将其重铸为高级源代码。 好消息是这些工具倾向于生成难以阅读和使用任意命名约定的代码。 

### 4.3.3 代码加盐

如果内存占用不是大问题，并且您不介意对性能造成轻微影响，则阻止调试器的一种方法是定期在代码中添加不必要的语句。 可以这么说，这使得尝试进行逆向工程的人更容易迷失。

这样，即使您在程序中附带了调试符号，也很难弄清正在发生的事情（尤其是如果您认为每个语句都有合法目的）。

这样，我们就相对安全了。

### 4.3.4 混合内存模型

There’re robust debuggers, like SoftICE, that can gracefully make the jump between user mode and kernel mode. However, not many debuggers can make the jump between two different memory models. Windows in particular is guilty of allowing this kind of abomination to occur. On Windows, this phenomenon is generally known as thunking, and it allows 16-bit code and 32-bit code to fraternize.

有一些强大的调试器，例如SoftICE，可以在用户模式和内核模式之间轻松切换。 但是，很少有调试器可以在两个不同的内存模型之间进行跳转。 比较特殊地，Windows下就允许发生这种行为。 在Windows上，这种现象通常称为“thunking”，它允许16位代码和32位代码进行混合。

以下描述了Windows中使用的改进技术：

![img](assets/clip_image006.png)
