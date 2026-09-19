## 调试命令管理

对于一个命令行调试器，涉及到多种启动调试的命令，在调试会话中也需要多种多样的调试命令，这些调试命令驱动着一个高效的调试过程，直到我们定位到问题源头。比如启动调试就要支持多种方式，`godbg <exec|attach|core|trace> ...`，在调试会话中也涉及到大量调试命令，如 `break, condition, continue, next, step, stepin, stepout, finish, bt, args, locals` 等等，如何对这些调试命令进行有效地管理和扩展是一个挑战。

### spf13/cobra

go标准库支持flags，方便对命令行选项进行解析，但是和我们想要的能力比起来，还是差点意思。所以社区里也成长起一些非常优秀的命令行开发支持项目，比如 [spf13/cobra](https://github.com/spf13/cobra)，它是一个基于golang的开源的命令行程序开发框架，它具有如下特点：

- 支持快速添加command；
- 支持为指定command添加subcommand；
- 支持为command指定必要参数；
- 支持为command添加POSIX风格的参数解析；
- 支持command、subcommand、参数的help信息的分组汇总展示；
- 支持为command、subcommand、参数生成shell自动补全脚本；
- 等等；

可以说，cobra是一个非常优秀的命令行程序开发框架，在很多知名开源项目中得以应用，如kubernetes、hugo、github-cli gh，等等。

### 命令分组

使用cobra对调试命令进行管理，将给我们带来很大的便利。对于`godbg exec <proc>`、`godbg attach <pid>`类似的命令及选项管理，cobra绰绰有余，使用默认的设置就可以提供很好的支持。

调试器除了上述“启动调试”相关的命令以外，也有很多“调试会话”中使用的调试命令，如断点相关的，调用栈相关的，查看源码、变量、寄存器等相关的。为了方便调试会话中中查看调试命令的帮助信息，对这些调试命令进行必要的分组是非常有必要的 (调试人员如果不能借助分组快速找到急需的调试命令，就会打断需要高度集中注意力的调试活动)。

比如：

- break、condition、clear、toggle、on，这几个与增删激活断点以及命中后处理强相关，可以将它们归类到分组“**[breakpoint]**”；
- print、display、args、locals、funcs、types、list，这几个与查看变量、参数、函数、类型、源码强相关，可以将它们归类到分组“**[show]**”；
- backtrace、frame，这几个与查看调用栈、切换调用栈强相关，可以将它们归类到分组“**[frames]**”；
- restart、continue、stepin、stepout、finish、next，这几个与运行强相关，可以将它们归类到分组“**[run]**”。
- ...
- 其他调试命令及分组；

cobra为每个命令提供了一个属性cobra.Command.Annotations，它是一个map类型，可以为每个命令添加一些kv属性信息，然后基于此可以对其进行一些分组等自定义的操作：

```go
breakCmd.Annotation["group"] = "breakpoint"
clearCmd.Annotation["group"] = "breakpoint"
printCmd.Annotation["group"] = "show"
frameCmd.Annotation["group"] = "frames"
```

上面我们对几个命令根据功能进行了分组，假如我们用debugRootCmd表示最顶层的命令，那么我们可以自定义debugRootCmd的Use方法，方法内部我们遍历所有的子命令，并根据它们的属性Annotation["group"]进行分组后，再显示帮助信息。

查看帮助信息时将得到如下分组后的展示样式（而非默认列表样式），更便利、更有条理：

```bash
[breakpoint]
break : break <locspec>，添加断点
clear : clear <n>，清除断点

[show]
print : print <variable>，显示变量信息

[frames]
frame : frame <n>，选择对应的栈帧
```

综上不管是调试器启动时的命令，还是调试会话中需要交互式键入的调试命令，都可以安心地使用cobra来完成，cobra能很好地满足我们的开发需求。

### 本节小结

本节介绍了如何借助spf13/cobra来管理调试器的命令。不管是调试器启动时使用的命令（如`godbg exec`、`godbg attach`），还是调试会话中交互式键入的调试命令（如break、clear、print、frame等），cobra都能很好地满足命令及选项管理的需求。此外，借助cobra.Command.Annotations属性，我们还可以对调试命令按功能进行分组，在帮助信息中分组展示，方便调试人员快速检索到急需的命令，减少对调试注意力的干扰。

有了命令管理的基础，还需要考虑如何降低用户输入命令的成本。下一节我们将探讨调试器输入自动补全的方案设计。
