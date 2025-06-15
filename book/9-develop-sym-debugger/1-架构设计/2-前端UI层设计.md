## 前端UI层设计

<img alt="arch" src="assets/debugger-arch.png" width="700px" />

联想下调试器的整体架构设计，前后端分离式架构中，前端部分主要包括两部分：

- UI层为用户提供调试相关的界面交互逻辑；
- Service层完成与调试器后端实现的通信，完成对被调试进程的各种控制；

前端、后端的Service层设计统一在《Service层设计》小节进行描述。本节来介绍下前端UI层的详细设计，以及相关的技术点。

### 图形化调试界面

对于图形化的调试界面，包括：

- 将终端从文本模式调整为图形模式，以可视化的方式进行调试，这类支持库包括 ncurses 等；
- 使用图形库设计实现的图形化调试界面，如 gdlv 基于 nuklear图形库实现；
- 在IDE中实现调试插件，如VSCode中自带的或者第三方的调试插件，使用JS或者TS实现调试界面；

图形化调试界面的内容不在我们的详细讨论范围内，我们只是罗列下，这是一个可以扩展的方向。

图形化界面调试，相比于终端中文本模式的命令行界面调试，有着非常大的优势，它可以一次性展示更多内容。命令行调试界面要支持的操作，图形化界面下肯定要都应该支持，但是图形化界面可以同时展示的东西更多，理论上UI层的设计上也会需要更细腻。

### 命令行调试界面

我们本章要实现的Go调试器，最终形态是一个在终端文本模式下的命令行调试器，以文本模式的形式与用户交互，获取用户输入的调试命令，转换成对应的调试动作执行，并将结果以文本模式的形式显示出来。

> 终端可以工作在文本模式，或者图形模式下，我们这里采用文本模式。其实主流的命令行调试器gdb、lldb、dlv等都是工作在终端文本模式下。

命令行调试相比图形化调试有其独特的优缺点：

**优势：**

1. 跨平台一致性：文本模式调试界面在不同操作系统上表现一致，不需要为不同平台开发特定的图形界面
2. 资源占用少：不需要加载图形库，对系统资源要求更低
3. 远程调试友好：在远程服务器或容器环境中，文本模式更容易通过SSH等远程连接使用
4. 可脚本化：命令行操作更容易被脚本化，便于自动化调试流程
5. 学习曲线统一：一旦掌握命令行调试，可以快速适应不同的命令行调试工具

**劣势：**

1. 信息展示受限：一次只能展示有限的信息，需要频繁切换视图
2. 命令记忆负担：需要开发者熟记各种调试命令及其参数
3. 操作效率：输入命令通常比点击图形界面按钮更耗时
4. 可视化效果差：难以直观地展示复杂的数据结构或调用关系
5. 新手友好度低：对初学者来说，命令行界面可能显得不够直观和友好

### 调试命令支持

go符号级调试器的功能性需求，大家联想下常见调试器的使用经历，这个是比较直观的：

#### 启动调试支持多种调试对象类型

| 命令                   | 描述                                                                  |
| ---------------------- | --------------------------------------------------------------------- |
| godbg attach           | 调试一个正在运行中的process                                           |
| godbg exec             | 启动并调试指定的go executable                                         |
| godbg test             | 调试当前go package中的测试函数                                        |
| godbg debug            | 调试当前go main module                                                |
| godbg debug --headless | 类似gdbserver的headless模式                                           |
| godbg dap              | 启动一个headless模式的服务，接收DAP协议请求，以方便与VSCode等进行集成 |
| godbg core             | 启动并调试指定的coredump                                              |
| godbg tracepoint       | 支持tracepoint能方便观察程序执行命中的函数                            |

#### 调试会话支持多种调试命令

**1 Running the program**

| 命令             | 别名 | 描述                                                                                                      |
| ---------------- | ---- | :-------------------------------------------------------------------------------------------------------- |
| call             | -    | Resumes process, injecting a function call (EXPERIMENTAL!!!)                                              |
| continue         | c    | Run until breakpoint or program termination.                                                              |
| next             | n    | Step over to next source line.                                                                            |
| rebuild          | -    | Rebuild the target executable and restarts it. It does not work if the executable was not built by delve. |
| restart          | r    | Restart process.                                                                                          |
| step             | s    | Single step through program.                                                                              |
| step-instruction | si   | Single step a single cpu instruction.                                                                     |
| stepout          | so   | Step out of the current function.                                                                         |
| rr相关           |      | rr相关的命令，如rnext, rstep...                                                                           |

**2 Manipulating breakpoints**

| 命令        | 别名 | 描述                                         |
| ----------- | ---- | -------------------------------------------- |
| break       | b    | Sets a breakpoint.                           |
| breakpoints | bp   | Print out info for active breakpoints.       |
| clear       |      | Deletes breakpoint.                          |
| clearall    |      | Deletes multiple breakpoints.                |
| condition   | cond | Set breakpoint condition.                    |
| on          |      | Executes a command when a breakpoint is hit. |
| toggle      |      | Toggles on or off a breakpoint.              |
| trace       | t    | Set tracepoint.                              |

**3 Viewing program variables and memory**

| 命令       | 别名 | 描述                                     |
| ---------- | ---- | ---------------------------------------- |
| args       |      | Print function arguments.                |
| display    |      | Disassembler.                            |
| examinemem | x    | Examine raw memory at the given address. |
| locals     |      | Print local variables.                   |
| print      | p    | Evaluate an expression.                  |
| regs       |      | Print contents of CPU registers.         |
| set        |      | Changes the value of a variable.         |
| vars       |      | Print package variables.                 |
| whatis     |      | Prints type of an expression.            |

**4 Listing and switching between threads and goroutines**

| 命令       | 别名 | 描述                                    |
| ---------- | ---- | --------------------------------------- |
| goroutine  | gr   | Shows or changes current goroutine      |
| goroutines | grs  | List program goroutines.                |
| thread     | tr   | Switch to the specified thread.         |
| threads    |      | Print out info for every traced thread. |

**5 Viewing the call stack and selecting frames**

| 命令     | 别名 | 描述                                                            |
| -------- | ---- | --------------------------------------------------------------- |
| deferred |      | Executes command in the context of a deferred call.             |
| down     |      | Move the current frame down.                                    |
| frame    |      | Set the current frame, or execute command on a different frame. |
| stack    | bt   | Print stack trace.                                              |
| up       |      | Move the current frame up.                                      |

**6 Other commands**

| 命令        | 别名     | 描述                                                   |
| ----------- | -------- | ------------------------------------------------------ |
| config      |          | Changes configuration parameters.                      |
| disassemble | disass   | Disassembler.                                          |
| dump        |          | Creates a core dump from the current process state     |
| edit        | ed       | Open where you are in `$DELVE_EDITOR` or `$EDITOR` |
| exit        | quit / q | Exit the debugger.                                     |
| funcs       |          | Print list of functions.                               |
| help        | h        | Prints the help message.                               |
| libraries   |          | List loaded dynamic libraries                          |
| list        | ls / l   | Show source code.                                      |
| source      |          | Executes a file containing a list of delve commands    |
| sources     |          | Print list of source files.                            |
| types       |          | Print list of types.                                   |
| ptype       |          | Print type info of specific datatype.                  |

使用过Go调试器 `go-delve/delve` 的读者，对上述列出的调试命令应该不陌生，我们基本上是罗列了 `go-delve/delve` 中支持的调试命令，额外增加了一个受gdb启发的 `ptype` 打印类型详情的命令。

> dlv支持 `whatis <expr>` 来查看expr对应的类型信息，但是如果我们定义了一个类型、类型上定义了一些成员、方法，whatis只能输出类型名，而不能输出成员、方法，这个很不方便。
>
> 而gdb `ptype` 就支持，下面是个gdb的示例，我们将在后面的实现阶段，实现和 gdb ptype 一样的效果。
>
> ```bash
> (gdb) ptype student1
> type = class Student {
>   private:
>     std::__cxx11::string name;
>     int age;
>
>   public:
>     Student(std::__cxx11::string, int);
>     std::__cxx11::string String(void) const;
> }
> ```

写这本书的初衷是为了解释如何开发一款符号级调试器，而非为了写而写，更不是为了超越dlv。考虑到调试功能完整度、相关知识的覆盖度、工程的复杂度、个人时间有限等诸多因素，我们将fork go-delve/delve实现，并进行适当的裁剪，保留核心设计、删减与linux/amd64无关架构扩展代码、删减dap实现、删减对接不同调试器backend gdb、lldb、rr的扩展，这些代码中被移除但是又有必要介绍的内容，将其迁移至扩展阅读部分介绍。

### 调试命令管理

需要支持的调试功能众多，我们前面做需求分析时对需要支持的调试命令进行了整理，并将它们按照调试动作的类型进行了分组。

这些要支持的调试命令，根据使用的阶段可以分成两类。一类属于如何发起调试，一类属于在调试会话中如何读写、控制被调试进程状态。这样的话，我们在进行命令管理的时候就要注意区分为两组不同的命令。

#### 方式1：统一由cobra管理

在进行指令级调试器设计实现时，我们采用cobra命令行框架来组织命令。首先我们注册了两个发起调试的命令：`godbg exec`和 `godbg attach`。

```go
rootCmd.AddCommand(execCmd)
rootCmd.AddCommand(attachCmd)
```

当调试器正常attach到被调试进程后，我们会紧接着启动一个调试会话DebugSession，其实这个DebugSession内部能运行的所有调试命令，也是由cobra命令行框架管理的，每个调试会话内部都有一个 `root *cobra.Command`，我们在这个root上注册了一系列调试命令。

```go
// DebugSession 调试会话
type DebugSession struct {
	root   *cobra.Command
    ...
}

debugRootCmd.AddCommand(breakCmd)
debugRootCmd.AddCommand(clearCmd)
...
debugrootCmd.AddCommand(nextCmd)
```

启动调试的命令、调试会话中的调试命令，这些命令我们都是用cobra来管理的，只不过分了两级来管理，这种设计方式更优雅简单。

#### 方式2：cobra+自定义管理逻辑

是接下来我们要换一种实现思路，启动调试的命令attach、exec等还是采用cobra管理，调试会话中的调试命令将用自己编写的命令组织逻辑来管理。为什么要这么做呢？

- 需要允许用户自定义调试命令的别名，而不仅仅是 `cobra.Command.Aliases`中指定的这些，而cobra也没有提供可配置的方式来自由添加别名；
- cobra框架中各个命令对应的处理函数只有cmd、flags、args参数，但是调试过程中我们需要维护一点状态相关的信息，并且需要将这些信息传递给调试命令的处理函数，当然是以参数的形式，而cobra框架中命令对应的处理函数的列表是无法传递额外参数的，而这些也不适合通过共享变量的形式来维护；
- 除了要实现的这些功能，最终也希望能提供额外的扩展能力，我们可以为调试器嵌入starlark脚本引擎、注册新调试命令的函数，这样开发人员可以自定义starlark函数作为调试器的新的调试命令，这样来扩充调试器功能。要实现这些这就要求调试器实现能够对子命令的管理逻辑细节100%可控制，而cobra作为一个命令行管理框架存在一些限制；

因此，在接下来的符号级调试器实现中，调试会话中的调试命令是通过重写的命令管理逻辑来完成的，而非像之前那样由cobra管理（调试器 go-delve/delve 也是这么做的)。

### 用户交互设计

这里与用户的交互，主要涉及到用户的输入、调试器的输出两部分。

#### 用户输入

当执行attach或exec启动调试之后，会启动一个调试会话，其实就是一个可以输入调试命令、展示调试结果的命令行窗口：

- 用户可以在stdin输入调试命令及其参数，然后等待调试器执行对应的调试动作（如读写内存），然后等待调试器结果，结果会输出到stdout；
- 用户可以输入 `help`命令查看当前调试器支持哪些调试命令，这些命令将按照所属的分组进行汇总显示，如断点相关、运行暂停相关、数据读写相关、goroutine相关、stack等分组；
- 用户也可以输入 `help subcmd`来显示某个特定命令的详细帮助信息，此时会显示subcmd的各个参数的帮助信息；
- 用户可以输入调试命令的别名，而非完整的命令名，以简化命令输入；
- 用户可以直接键入回车键Enter，来重复执行上一次输入的调试命令，这在执行next、step时将非常有用；
- 为了方便用户输入过去输入过的调试命令，我们还可以记录用户输入过的命令，并允许用户通过方向键up/down来选择过去输入过的命令，并且还可以允许自动补全，以简化命令输入；
- 当用户向结束调试时，可以通过ctrl+c或者exit、quit等命令结束调试；

用户的输入动作都是非常简单的在stdin上的行输入，在调试会话启动后，我们就可以启动一个for-loop来不停地读取stdin上的行输入，当读取到一个完整的行之后，我们就将输入信息进行解析，解析成命令、及参数，这里的命令也可能是别名。然后查找所有的命令中哪个命令的别名与用户输入相同，一旦找到该命令，则执行命令关联的处理函数，完成调试动作。

关于这里的输入逻辑，接下来将使用[peterh/liner](https://github.com/peterh/liner)这个第三方库来方便地管理用户输入、执行输入处理、记录历史输入、输入自动补全等功能。

#### 调试器输出

调试器的输出信息，包括执行日志，以及调试命令的结果。这两类信息，我们的调试器实现中都是将其输出到stdout，以简化实现复杂度。

- 本地调试时，调试器前端、后端的日志都是输出到stdout的，调试结果首先是由backend发送给frontend，frontend做些数据转换之后就输出到stdout显示出来。所以本地调试时，日志、调试结果都可以在stdout中查看到；
- 远程调试时（或者是同一个机器也是起了前端、后端两个进程时），调试器前端、后端的日志各自输出也均输出到stdout，如果是在两个不同的终端中运行，那么日志输出到对应的终端中。对于调试结果则由backend发送给frontend，最终由frontend显示在其对应的终端中。
- 对于frontend、backend对应的日志如果不关心，可以通过日志级别将其关闭，或者通过选项--log指定个日志文件让其将日志信息输出到指定日志文件中。

  > ps：支持--log选项，这么设计并不一定最终这么实现，我们为了赶进度，做了些简化，只允许调试日志、结果输出到stdout，但是会给予一定的日志级别控制。
  >
- 个别输出信息可能需要颜色高亮，如执行 `l main.go:10`这样来查看源代码时，我们希望能根据源代码中不同的关键字、语句、注释、字符串、当前执行到的源码行等能像IDE中那样有个不同颜色的高亮显示，这样对于用户而言无意是更加友好的。这就意味着我们需要对源代码进行必要的AST分析统计出有哪些词素需要高亮显示。

#### 输入输出重定向

对于被调试进程而言，它可能需要从stdin读取输入，向stdout、stderr输出信息，但是调试器进程本身也存在类似的需要。

这样就产生了读写冲突，问题来了：

- 当用户在stdin输入时，究竟是将输入内容给调试器呢，还是给被调试进程呢？
- 当在stdout、stderr有输出时，输出信息时来自调试器呢，还是来自被调试进程呢？

为了解决这个问题，我们需要为被调试进程提供输入、输出重定向的能力，比如 `godbg exec ./main -r stdin:/path-to/fin -r stdout:/path-to/fout -r stderr:/path-to/ferr` 。

调试期间，当希望观察被调试进程要读取什么数据、是否在等待数据输入、是否读取成功时，就可以通过 `tail -f /path-to/fout /path-to/ferr` 来观察，通过 `echo data >> /path-to/fin` 来输入。

### 本节总结

本节简要介绍了调试器前端UI层的一些设计，包括命令行调试界面、调试命令管理、用户交互管理，在后面的实现部分我们将进一步结合源码来展开。
