在第5章《调试器概貌》一节中，我们已经对调试器的功能性、非功能性需求和大致的技术方案进行了阐述，那当前小节内容是否有点重复了呢？第6章紧跟第5章讲述的指令级调试器的设计实现，为了平滑地过渡到这一章，第5章中的功能性需求、非功能性需求我们是有所保留的、没有罗列出来的，技术方案当然也就没有详细阐述。

本小节中作为符号级调试器开发的前置小节，正好给了我们一个契机重新分析下调试器的功能性需求、非功能性需求，以及大致的技术方案。

### 功能性需求

go符号级调试器的功能性需求，大家联想下常见调试器的使用经历，这个是比较直观的：

#### 需要支持多种调试对象类型

| 命令         | 描述                           |
| ------------ | ------------------------------ |
| godbg debug  | 调试当前go main module         |
| godbg test   | 调试当前go package中的测试函数 |
| godbg attach | 调试一个正在运行中的process    |
| godbg exec   | 启动并调试指定的go executable  |
| godbg core   | 启动并调试指定的coredump       |

  ps： 对调试当前go module、go package中测试函数的，允许自定义编译选项

#### 需要支持多种调试模式

| 命令                       | 模式                                            |
| -------------------------- | ----------------------------------------------- |
| godbg <...>                | 正常调试模式                                    |
| godbg debug --headless     | 类似gdbserver的headless模式                     |
| godbg dap                  | 支持调试器适配协议DAP，以方便与VSCode等进行集成 |
| godbg tracepoint           | 支持tracepoint能方便观察程序执行命中的函数      |
| godbg <...> --disable-aslr | 禁用ASLR地址随机化                              |

#### 需要支持显示版本号信息

方便根据版本号排查特定版本引入的问题。

#### 需要支持多种调试会话中的调试命令

**1 Running the program**

| 命令             | 别名 | 描述                                                         |
| ---------------- | ---- | :----------------------------------------------------------- |
| call             | -    | Resumes process, injecting a function call (EXPERIMENTAL!!!) |
| continue         | c    | Run until breakpoint or program termination.                 |
| next             | n    | Step over to next source line.                               |
| rebuild          | -    | Rebuild the target executable and restarts it. It does not work if the executable was not built by delve. |
| restart          | r    | Restart process.                                             |
| step             | s    | Single step through program.                                 |
| step-instruction | si   | Single step a single cpu instruction.                        |
| stepout          | so   | Step out of the current function.                            |
| rr相关           |      | rr相关的命令，如rnext, rstep...                              |

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

| 命令     | 别名 | 描述                                                         |
| -------- | ---- | ------------------------------------------------------------ |
| deferred |      | Executes command in the context of a deferred call.          |
| down     |      | Move the current frame down.                                 |
| frame    |      | Set the current frame, or execute command on a different frame. |
| stack    | bt   | Print stack trace.                                           |
| up       |      | Move the current frame up.                                   |

**6 Other commands**

| 命令        | 别名     | 描述                                                |
| ----------- | -------- | --------------------------------------------------- |
| config      |          | Changes configuration parameters.                   |
| disassemble | disass   | Disassembler.                                       |
| dump        |          | Creates a core dump from the current process state  |
| edit        | ed       | Open where you are in $DELVE_EDITOR or $EDITOR      |
| exit        | quit / q | Exit the debugger.                                  |
| funcs       |          | Print list of functions.                            |
| help        | h        | Prints the help message.                            |
| libraries   |          | List loaded dynamic libraries                       |
| list        | ls / l   | Show source code.                                   |
| source      |          | Executes a file containing a list of delve commands |
| sources     |          | Print list of source files.                         |
| types       |          | Print list of types.                                |
| ptype       |          | Print type info of specific datatype.               |

大家都有使用过调试器，上面列出的调试命令至少有一部分是比较熟悉的。上述调试能力大致是一个现代go符号级调试器所要支持的功能全集，可以达到工程上的应用要求了。如果读者有使用过go-delve/delve，你会发现上面的功能基本上全是go-delve/delve的调试命令？没错，我这里就是罗列了go-delve/delve的调试命令，额外增加了一个受gdb启发的ptype打印类型详情的命令。

> 写这本书的初衷是为了解释如何开发一款符号级调试器，而非为了写一个新的调试器，考虑到调试功能完整度、相关知识的覆盖度、工程的复杂度、个人时间有限等诸多因素，我最终采用了一种非常“开源”的方式，借鉴并裁剪了go-delve/delve中的代码，保留核心功能，删减与linux/amd64无关架构扩展代码，将rr （record and play）、dap（debugger adapter protocol）迁移至额外的阅读章节（可能放在附录页、扩展阅读）中进行介绍。
>
> 这样作者可以保证在2022年让这本书完成初稿，以尽快与读者以电子书形式见面（纸质的也会考虑）。

### 非功能性需求

做一个产品需要注重用户体验，做一个调试器也一样，需要站在开发者角度考虑如何让开发者用的方便、调试的顺利。

对于一个调试器而言，因为我们会在各种任务间穿插切换，要灵活运行调试命令是必要的。但是一个基于命令行实现的调试器，要想实现命令的输入并不是一件轻松的事情。

#### 调试器的易用性

**1 调试命令众多，需要降低记忆、使用成本**

-   首先调试器有很多调试命令，如何记忆这些命令是有一定的学习成本的，而基于命令行的调试器会比基于GUI的调试器学习曲线更陡；
-   基于命令行的调试器需考虑调试命令输入效率的问题，比如输入命令以及对应的参数。GUI调试器在源码某行处添加一个断点通常是很简单的事情，鼠标点一下即可，但基于命令行的调试器则需要用户显示提供一个源码位置，如"break main.go:15"，或者"break main.main"；
-   调试器诸多调试命令，需要考虑自动补全命令、自动补全参数，如果支持别名，将会是一个不错的选项。调试器还需要记忆上次刚使用过的调试命令，以方便重复使用，例如频繁地逐语句执行命令序列 <next, next, next>，可以通过命令序列 <next, enter, enter> 代替，回车键默认使用上次的命令，这样对用户来说更方便；
-   每一个命令、命令参数都应该有明确的help信息，用户可以通过`help cmd`来方便地查看命令cmd是做什么的，包含哪些选项、各个选项是做什么的。

**2 命令行调试器，需要能同时显示多个观测值**

-   基于命令行的调试器，其UI基于终端的文本模式进行显示，而非图形模式，这意味着它不能像GUI界面一样非常灵活方便地展示多种信息，如同时显示源码、断点、变量、寄存器、调用栈信息等；
-   但是调试器也需要提供类似的能力，这样用户执行一条调试命令（如next、step）后能观测到多个变量、寄存器的状态。且在这个过程中，用户应该是不需要手动操作的。且多个观测变量、寄存器值的刷新动作耗时要短，要和执行next、step的耗时趋近。

#### 调试器的扩展性

**1 命令、选项的扩展要有良好简洁的支持**

-   调试器有多种启动方式，对应多个启动命令，如`godbg exec <prog>`、`godbg debug <module>`、`godbg attach <pid>`、`godbg core <coredump>`，各自有不同的参数。此外调试器也有多种交互式的调试命令，如`break <locspec>`、`break <locspec> cond <expression>`等，各自也有不同的参数。如何可扩展地管理这些命令及其选项是需要仔细考虑的；
-   命令的选项，尽量遵循GNU/POSIX选项风格，这更符合大家的使用习惯，且选项在可以消除歧义的情况下尽量同时支持长选项、短选项，给开发输入时提供更多的便利；

**2 调试器应满足个性化定义以满足不同调试习惯**

-   好的产品塑造用户习惯，但是更好的习惯应该只有用户自己知道，一个可配置化的调试器是比较合适的，如允许用户自定义命令的别名信息，等等；

**3 跨平台、支持不同调试后端、支持与IDE集成**

-   调试器本身，可能需要考虑未来的应用情况，其是否具备足够的适应性以在各种应用场景中使用，如能否在GoLand、VSCode等IDE中使用，或者可能的远程调试场景等。这些也对调试器本身的软件架构设计提出了要求；
-   应该考虑将来扩展到darwin/windows以及powerpc、i386等不同的系统、平台上，在软件设计时应提供必要的抽象设计，将抽象、实现分离；
-   调试器实现不是万能的，存在这样的场景我们需要借助其他调试器实现，来完成某种功能，原因可能是我们的实现不支持被调试程序所在的系统、平台，或者其他调试器实现方法更优，举个例子，Mozillar rr（record and replay），记录重放的实现比较复杂，gdb、lldb、dlv的逆向调试基本上都是在rr基础上构建的。这就要求调试器要实现前后端分离式架构，而且后端部分接口与实现要分离，满足可替换，如能轻松地从dlv切换成Mozillar rr；

#### 调试器的健壮性

- 调试器本身是依赖于一些操作系统能力的支持的，如Linux ptrace系统调用的支持，该系统调用的使用是有些约束条件的，比如ptrace_attach之后的tracee后续接收到的ptrace requests必须来自同一个tracer。还有syscall.Wait系统调用时Linux平台的一些特殊情况…这类情况有不少，调试器应该考虑到这些情况做兼容处理；
- go调试器也依赖go编译工具链生成的一些调试信息，不同的go版本编译出的产物数据类型表示上、信号处理方面会有差异，调试器实现时应该考虑到这些情况做必要的处理，尽可能做到健壮。比如可以限制当前支持的go工具链版本，如果编译产物对应的go版本不匹配就放弃调试；

非功能性需求很多，我们从易用性，到命令管理的可维护性，到选型的规范性，到如何扩展到不同的操作系统、硬件平台、调试器后端实现，自身的健壮性等方面进行了描述。除了调试功能本身，这也是影响一个调试器能否被大家接受的很重要的因素。

### 本节小结

本节对go符号级调试器的功能型需求、非功能性需求进行了详细的一个分析，这个就是我们的一个目标了，后面我们要带着这些目标去一步步设计实现我们的符号级调试器。