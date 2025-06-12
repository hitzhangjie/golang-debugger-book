## 核心调试命令

在第5章《调试器概貌》我们分析了下调试器的功能性需求、非功能性需求、大致的实现方案，第6章紧跟着介绍了指令级调试器的设计实现，第7章介绍了与调试器写作紧密相关的ELF文件格式、编译器、链接器、加载器的工作原理以及调试信息的生成，第8章专门介绍了调试信息对源程序数据和指令、进程运行时视图的描述。9.1开头对现代调试器的整体架构进行了介绍，本节就是要重点介绍每个调试功能的实现了。

在开始前，我们再次重申下调试器的功能性需求、非功能性需求，以及大致的技术方案。对于列出的完整的功能列表，由于篇幅和时间限制，我们没法做到全部实现、逐一介绍，因此我们会特别说明各个功能会实现到什么程度。由于我们的demo tinydbg是在 `go-delve/devle` 上裁剪、修改而来，所以我们可以直接标注清楚每个功能点我们做到了什么程度、相比delve的变化，方便大家了解。

### 支持多种调试对象

| 命令         | 描述                           | 对象类型        | 是否实现 | dlv是否实现 |
| ------------ | ------------------------------ | --------------- | -------- | ----------- |
| godbg attach | 调试一个正在运行中的process    | process         | Y        | Y           |
| godbg exec   | 启动并调试指定的go executable  | executable      | Y        | Y           |
| godbg debug  | 调试当前go main module         | go main package | Y        | Y           |
| godbg test   | 调试当前go package中的测试函数 | go test package | N        | Y           |
| godbg core   | 启动并调试指定的coredump       | coredump        | Y        | Y           |

> ps：为什么不支持 `godbg test` ？
>
> go语言有原生的单元测试框架，`go test` 大家对此应该不陌生，对于测试包的调试，我们可以这样做：`go test -c -ldflags 'all=-N -l'` 然后再 `godbg exec ./xxxx.test`，但是如果能够一条命令 `godbg test` 搞定上述构建、运行测试的操作，会便利一点。
>
> 尽管如此，但这个并不涉及增量的核心调试逻辑，只是一个编译构建、启动测试的优化，为了让tinydbg更加精简、节省介绍篇幅，我们移除了原来dlv的实现逻辑。

### 支持多种调试模式

| 命令                               | 模式                                                   | 是否实现 | dlv是否实现           |
| ---------------------------------- | ------------------------------------------------------ | -------- | --------------------- |
| godbg debug/exec/attach            | 本地调试模式                                           | Y        | Y                     |
| godbg debug/exec/attach --headless | 启动调试服务器，允许调试客户端远程连接 (JSON-RPC)      | Y        | Y                     |
| godbg connect                      | 启动调试客户端，连接远程调试服务器                     | Y        | Y                     |
| godbg dap                          | 启动调试服务器，且支持DAP协议，允许VSCode等通过DAP集成 | N        | Y                     |
| godbg tracepoint                   | 跟踪程序执行的函数                                     | bp-based | bp-based + ebpf-based |
| godbg <...> --disable-aslr         | 禁用ASLR地址随机化                                     | N        | Y                     |
| godbg --backend=gdb/lldb/rr        | 使用其他调试器实现代替native实现                       | N        | Y                     |

> ps: 描述下这里的裁剪逻辑？
>
> 1. 为什么去掉 `godbg dap` 支持？
>
>    - 也是以--headless模式启动调试器服务端，只是协议编解码逻辑不是使用JSON-RPC，而是使用DAP；
>    - 尽管DAP是VSCode等IDE与调试器进行集成的一个流行的协议，但是它并不是调试器核心逻辑，我们知道它的用途即可；
> 2. 为什么去掉 `godbg tracepoint` 的ebpf-based实现？
>
>    - ebpf-based tracing这部分细节非常多，介绍Linux ebpf子系统、ebpf程序编写会花非常多篇幅；
>    - breakpoint-based tracing在内容上更紧凑，也可以实现tracing能力，尽管它性能比较差；
>    - 我们在扩展阅读部分提到了 ebpf-based tracing工具 [go-ftrace] 的设计实现，读者可以在这里了解更多；
> 3. 为什么去掉对禁用ASLR的支持？
>
>    - 这个之前我们介绍过ASLR是什么；
>    - 大家了解它对程序加载、程序调试（特别是保存会话并进行自动化调试）的影响即可。
> 4. 为什么去掉 `godbg --backend` 的实现？
>
>    - 支持不同backend实现涉及到gdbserial支持，以及与gdb、mozillar rr对接，代码量大、介绍起来篇幅大；
>    - 支持lldb和支持gdb类似，而且我们对dlv项目已经裁剪到只支持linux/amd64，保留macOS lldb支持没意义；
>    - 先让大家掌握linux/amd64下的native backend实现，才是本书重点，我们会在扩展部分介绍如何进行这方面的扩展；
>
> 通过这里的部分裁剪，我们保留了符号级调试器的核心设计实现，而且篇幅也不会拉的很长，比较适合读者朋友学习。

### 支持常见调试操作

#### Running the program

| 命令             | 别名 | 描述                                                         | 是否实现 | dlv是否实现 |
| ---------------- | ---- | :----------------------------------------------------------- | -------- | ----------- |
| call             | -    | Resumes process, injecting a function call.                  | Y        | Y           |
| continue         | c    | Run until breakpoint or program termination.                 | Y        | Y           |
| next             | n    | Step over to next source line.                               | Y        | Y           |
| restart          | r    | Restart process.                                             | Y        | Y           |
| step             | s    | Single step through program.                                 | Y        | Y           |
| step-instruction | si   | Single step a single cpu instruction.                        | Y        | Y           |
| stepout          | so   | Step out of the current function.                            | Y        | Y           |
| rewind           |      | Run backwards until breakpoint or start of recorded history. | N        | Y           |
| checkpoints      |      | Print out info for existing checkpoints.                     | N        | Y           |
| rev              |      | 类似gdb rnext, rstep...改变next、step、continue的direction   | N        | Y           |

> ps: 描述下这里不支持 rewind、checkpoints、rev 操作的原因？
>
> mozilla rr，使得一次录制后就可以稳定重放调试过程、确定性地进行调试，方便我们定位到故障源头，移除它的原因主要有：
>
> 1) 尽管在此基础上构建起确定性调试很美好，但是设计实现也会让调试器本身变得很复杂；
>    - 通过gdbserial与rr通信；
>    - 必要时与rr进行交互改变程序执行方向；
>    - 代码实现上要补充大量正向执行、反向执行的控制逻辑；
> 2) rev改变程序执行方向的操作（影响命令next/step的方向），以及continue的反向版本rewind，这些功能的实现依赖rr backend；
> 3) checkpoints的功能实现也依赖rr；
>
> 我们会在扩展阅读部分介绍 mozilla rr 的录制、重放原理，以及如何集成它，但是我们不会在 demo tinydbg 中保留这部分实现逻辑。

#### Manipulating breakpoints

| 命令        | 别名 | 描述                                         | 是否实现 | dlv是否实现 |
| ----------- | ---- | -------------------------------------------- | -------- | ----------- |
| break       | b    | Sets a breakpoint.                           | Y        | Y           |
| breakpoints | bp   | Print out info for active breakpoints.       | Y        | Y           |
| clear       |      | Deletes breakpoint.                          | Y        | Y           |
| clearall    |      | Deletes multiple breakpoints.                | Y        | Y           |
| condition   | cond | Set breakpoint condition.                    | Y        | Y           |
| on          |      | Executes a command when a breakpoint is hit. | Y        | Y           |
| toggle      |      | Toggles on or off a breakpoint.              | Y        | Y           |
| trace       | t    | Set tracepoint.                              | Y        | Y           |

这些断点相关的操作，是比较常用的核心调试命令，这些操作的实现都会予以保留、介绍。

#### Viewing program variables and memory

| 命令       | 别名 | 描述                                             | 是否实现 | dlv是否实现 |
| ---------- | ---- | ------------------------------------------------ | -------- | ----------- |
| args       |      | Print function arguments.                        | Y        | Y           |
| display    |      | Disassembler.                                    | Y        | Y           |
| examinemem | x    | Examine raw memory at the given address.         | Y        | Y           |
| locals     |      | Print local variables.                           | Y        | Y           |
| print      | p    | Evaluate an expression.                          | Y        | Y           |
| regs       |      | Print contents of CPU registers.                 | Y        | Y           |
| set        |      | Changes the value of a variable.                 | Y        | Y           |
| vars       |      | Print package variables.                         | Y        | Y           |
| whatis     |      | Prints type of an expression.                    | Y        | Y           |
| ptype      |      | Print type details, including fields and methods | Y        | N           |

这些读写寄存器、读写内存、查看实参、查看局部变量、打印变量、查看表达式类型、查看类型细节相关的操作，是调试过程中比较常用的核心调试命令，这些操作的实现我们也会予以保留、介绍。值得一提的是，gdb中的调试操作ptype可以打印一个变量的类型细节信息，dlv中的类似操作是whatis，但是whatis只能打印类型的字段信息，不能打印出类型上定义的方法集，这样的话就不是很方便。

所以我们希望支持一个新的调试命令ptype，这个过程中也可以让读者朋友们活学活用DWARF来进行调试器的功能扩展。

#### Listing and switching between threads and goroutines

| 命令       | 别名 | 描述                                    | 是否实现 | dlv是否实现 |
| ---------- | ---- | --------------------------------------- | -------- | ----------- |
| goroutine  | gr   | Shows or changes current goroutine      | Y        | Y           |
| goroutines | grs  | List program goroutines.                | Y        | Y           |
| thread     | tr   | Switch to the specified thread.         | Y        | Y           |
| threads    |      | Print out info for every traced thread. | Y        | Y           |

不同编程语言提供的并发编程接口也不同，如C、C++、Java、Rust等提供了面向线程的并发编程接口，而Go不同它提供的是面向协程goroutine的并发编程接口。但是软件调试在支持保护模式的操作系统上，调试的实现本质上是利用了内核提供的能力，比如Linux下基于ptrace操作实现对进程指令、数据的读写控制，实现对进程调度的控制、状态获取等等。Go比较特殊的是它实现了一个面向goroutine的调度系统，俗称GMP调度。P这个虚拟处理器资源上的任务队列（待调度执行的G），最终是由M执行的。G的调度由Go运行时GMP调度器调度，线程M的调度则由内核调度器控制，而调试器就是通过ptrace系统调用来影响内核对目标调试线程的调度，从而实现调试。

所以，对于Go调试器，为了更灵活地控制，需要知道当前有哪些线程 `threads`、有哪些协程 `goroutines`，以及在此基础上实现线程切换 `thread n`、协程切换 `goroutine m`。

#### Viewing the call stack and selecting frames

| 命令     | 别名 | 描述                                                            | 是否实现 | dlv是否实现 |
| -------- | ---- | --------------------------------------------------------------- | -------- | ----------- |
| stack    | bt   | Print stack trace.                                              | Y        | Y           |
| frame    |      | Set the current frame, or execute command on a different frame. | Y        | Y           |
| up       |      | Move the current frame up.                                      | Y        | Y           |
| down     |      | Move the current frame down.                                    | Y        | Y           |
| deferred |      | Executes command in the context of a deferred call.             | Y        | Y           |

这部分是跟调用栈相关的操作，bt查看调用栈、frame选择栈帧查看栈帧内的参数、变量状态，up、down方便我们在调用栈中移动，本质上和frame操作一样。deferred比较特殊，是面向Go语言defer函数的特别支持，我们一个函数可以有多个defer函数调用，`defer <n>` 可以方便对第n个defer函数添加断点，并且能够在执行到该处时执行特定的命令，如打印locals。

这些对于Go语言来说是比较常用的核心调试命令，我们均保留并予以介绍。

#### Source Code commands

| 命令        | 别名   | 描述                          | 是否实现 | dlv是否实现 |
| ----------- | ------ | ----------------------------- | -------- | ----------- |
| list        | ls / l | Show source code.             | Y        | Y           |
| disassemble | disass | Disassembler.                 | Y        | Y           |
| types       |        | Print list of types.          | Y        | Y           |
| funcs       |        | Print list of functions.      | Y        | Y           |
| libraries   |        | List loaded dynamic libraries | Y        | Y           |

这部分是跟源代码相关的操作，如查看源码、反汇编源码、查看类型列表、函数列表，以及源码依赖的共享库列表。这部分中list、disassemble是比较常用的操作，是我们重点介绍的对象。types、funcs在我们介绍通过DWARF可以获取什么的用例演示时已经介绍过了。

#### Automatically Debugging

| 命令    | 别名 | 描述                                                | 是否实现               | dlv是否实现                                 |
| ------- | ---- | --------------------------------------------------- | ---------------------- | ------------------------------------------- |
| source  |      | Executes a file containing a list of delve commands | script of dlv commands | script of dlv commands + script of starlark |
| sources |      | Print list of source files.                         | Y                      | Y                                           |

自动化调试过程中，我们会写好一些调试命令，然后调试会话中source后执行，这个用的可能不多，但是在特定场景下还是有点用处的，我们也需要简单介绍下。

> ps: 为什么移除了source对starlark脚本的支持？
>
> 1) 自动化调试可以通过编写了dlv commands的普通脚本来执行，这样也拥有了一定的自动化测试能力；
> 2) 但是1）中方法没有starlark语言脚本灵活，starlark语言类似于python语言，starlark脚本中可以通过starlark binding代码直接调用debugger的内置调试操作。
> 3) 在2）基础上配合starlark的可编程能力对调试命令的输入、输出的处理，可以玩出更多花样，有更多的可探索的自动化调试空间；
>
> 我们会介绍Go语言程序中如何集成starlark，但是因为这个功能还不算是特别核心的调试能力，不过在demo tinydbg中，我们保留了两个分支：
>
> - 分支tinydbg：移除了linux/amd64无关代码，移除了backend gdb、lldb、mozilla rr代码，移除了record&replay、reverse debugging代码，移除了dap代码，……，但是保留了starlark实现，并且在examples目录中提供了一个starlark自动化测试的demo `starlark_demo`。如果您对此感兴趣，可以执行相关的测试；
> - 分支tinydbg_minimal：在tinydbg分支裁剪现状的基础上，更加激进地进行了裁剪、重构，使得它的功能实现更向本章要介绍的内容靠拢 …… 一切从简，也包括删了starlark脚本支持；
>
> 您可以按需选择上述分支进行学习、测试，请知悉。

#### Other commands

| 命令    | 别名     | 描述                                               | 是否实现 | dlv是否实现 |
| ------- | -------- | -------------------------------------------------- | -------- | ----------- |
| config  |          | Changes configuration parameters.                  | Y        | Y           |
| dump    |          | Creates a core dump from the current process state | Y        | Y           |
| edit    | ed       | Open where you are in$DELVE_EDITOR or $EDITOR    | Y        | Y           |
| rebuild | -        | Rebuild the target executable and restarts it.     | Y        | Y           |
| exit    | quit / q | Exit the debugger.                                 | Y        | Y           |
| help    | h        | Prints the help message.                           | Y        | Y           |

这些调试命令涉及到自定义配置、生成核心转储、查看或者修改源码、修改后重新编译，以及查看帮助、退出操作。这里的dump是我们要介绍的，它和core命令息息相关，一个生成、一个读取并调试。edit、rebuild有点亮点，解决了调试时发现问题后切换编辑器窗口编辑修改、再次调试的不便。exit、help就比较常规了。

上述调试命令能力大致是一个现代go符号级调试器所要支持的功能全集，可以达到工程上的应用要求了。如果读者有使用过go-delve/delve，你会发现上面的功能基本上全是go-delve/delve的调试命令？没错，我这里就是罗列了go-delve/delve的调试命令，额外增加了一个受gdb启发的ptype打印类型详情的命令。

> 写这本书的初衷是为了解释如何开发一款符号级调试器，而非为了写一个新的调试器，考虑到调试功能完整度、相关知识的覆盖度、工程的复杂度、个人时间有限等诸多因素，我最终采用了一种非常“开源”的方式，借鉴并裁剪了go-delve/delve中的代码，保留核心功能，删减与linux/amd64无关架构扩展代码，将rr （record and play）、dap（debugger adapter protocol）迁移至额外的阅读章节（可能放在附录页、扩展阅读）中进行介绍。
>
> 这样作者可以保证在2022年让这本书完成初稿，以尽快与读者以电子书形式见面（纸质的也会考虑）。

### 还需要注意什么

做一个产品需要注重用户体验，做一个调试器也一样，需要站在开发者角度考虑如何让开发者用的方便、调试的顺利。我们梳理了这么多需要支持的调试命令，正是关注产品体验的体现。

我们提供了很多的调试命令，功能上是够用的。但是一个基于命令行实现的调试器，调试命令越丰富反而可能更像是负担，因为实现命令输入并不是一件轻松的事情。

我们要特别注意以下几点：

- 简化命令行输入，尤其是需要连续多次输入的情况；
- 方便查看命令帮助，相关的命令合理分组，编写精简有用的帮助信息；
- 方便观测多个变量，如执行期间观察、命中断点时观察、或者执行到某个defer函数时观察；
- 保证健壮性，调试期间调试器崩溃、导致进程崩溃、发现DWARF数据、Go AST不兼容等等，导致无法顺利完成调试，应尽早发现并抛出问题，避免浪费开发者宝贵的时间。

#### 调试器的易用性

**1 调试命令众多，需要降低记忆、使用成本**

- 首先调试器有很多调试命令，如何记忆这些命令是有一定的学习成本的，而基于命令行的调试器会比基于GUI的调试器学习曲线更陡；
- 基于命令行的调试器需考虑调试命令输入效率的问题，比如输入命令以及对应的参数。GUI调试器在源码某行处添加一个断点通常是很简单的事情，鼠标点一下即可，但基于命令行的调试器则需要用户显示提供一个源码位置，如"break main.go:15"，或者"break main.main"；
- 调试器诸多调试命令，需要考虑自动补全命令、自动补全参数，如果支持别名，将会是一个不错的选项。调试器还需要记忆上次刚使用过的调试命令，以方便重复使用，例如频繁地逐语句执行命令序列 <next, next, next>，可以通过命令序列 <next, enter, enter> 代替，回车键默认使用上次的命令，这样对用户来说更方便；
- 每一个命令、命令参数都应该有明确的help信息，用户可以通过 `help cmd`来方便地查看命令cmd是做什么的，包含哪些选项、各个选项是做什么的。

**2 命令行调试器，需要能同时显示多个观测值**

- 基于命令行的调试器，其UI基于终端的文本模式进行显示，而非图形模式，这意味着它不能像GUI界面一样非常灵活方便地展示多种信息，如同时显示源码、断点、变量、寄存器、调用栈信息等；
- 但是调试器也需要提供类似的能力，这样用户执行一条调试命令（如next、step）后能观测到多个变量、寄存器的状态。且在这个过程中，用户应该是不需要手动操作的。且多个观测变量、寄存器值的刷新动作耗时要短，要和执行next、step的耗时趋近。

#### 调试器的扩展性

**1 命令、选项的扩展要有良好简洁的支持**

- 调试器有多种启动方式，对应多个启动命令，如 `godbg exec <prog>`、`godbg debug <module>`、`godbg attach <pid>`、`godbg core <coredump>`，各自有不同的参数。此外调试器也有多种交互式的调试命令，如 `break <locspec>`、`break <locspec> cond <expression>`等，各自也有不同的参数。如何可扩展地管理这些命令及其选项是需要仔细考虑的；
- 命令的选项，尽量遵循GNU/POSIX选项风格，这更符合大家的使用习惯，且选项在可以消除歧义的情况下尽量同时支持长选项、短选项，给开发输入时提供更多的便利；

**2 调试器应满足个性化定义以满足不同调试习惯**

- 好的产品塑造用户习惯，但是更好的习惯应该只有用户自己知道，一个可配置化的调试器是比较合适的，如允许用户自定义命令的别名信息，等等；

**3 跨平台、支持不同调试后端、支持与IDE集成**

- 调试器本身，可能需要考虑未来的应用情况，其是否具备足够的适应性以在各种应用场景中使用，如能否在GoLand、VSCode等IDE中使用，或者可能的远程调试场景等。这些也对调试器本身的软件架构设计提出了要求；
- 应该考虑将来扩展到darwin/windows以及powerpc、i386等不同的系统、平台上，在软件设计时应提供必要的抽象设计，将抽象、实现分离；
- 调试器实现不是万能的，存在这样的场景我们需要借助其他调试器实现，来完成某种功能，原因可能是我们的实现不支持被调试程序所在的系统、平台，或者其他调试器实现方法更优，举个例子，Mozillar rr（record and replay），记录重放的实现比较复杂，gdb、lldb、dlv的逆向调试基本上都是在rr基础上构建的。这就要求调试器要实现前后端分离式架构，而且后端部分接口与实现要分离，满足可替换，如能轻松地从dlv切换成Mozillar rr；

#### 调试器的健壮性

- 调试器本身是依赖于一些操作系统能力的支持的，如Linux ptrace系统调用的支持，该系统调用的使用是有些约束条件的，比如ptrace_attach之后的tracee后续接收到的ptrace requests必须来自同一个tracer。还有syscall.Wait系统调用时Linux平台的一些特殊情况…这类情况有不少，调试器应该考虑到这些情况做兼容处理；
- go调试器也依赖go编译工具链生成的一些调试信息，不同的go版本编译出的产物数据类型表示上、信号处理方面会有差异，调试器实现时应该考虑到这些情况做必要的处理，尽可能做到健壮。比如可以限制当前支持的go工具链版本，如果编译产物对应的go版本不匹配就放弃调试；

非功能性需求很多，我们从易用性，到命令管理的可维护性，到选型的规范性，到如何扩展到不同的操作系统、硬件平台、调试器后端实现，自身的健壮性等方面进行了描述。除了调试功能本身，这也是影响一个调试器能否被大家接受的很重要的因素。

### 本节小结

本节实际上是对接下来的go符号级调试器demo tinydbg的功能型需求、非功能性需求进行了详细的一个分析，这个就是我们的一个目标了。OK，接下来我们进入这些调试命令的设计实现部分，Let's Go !!!
