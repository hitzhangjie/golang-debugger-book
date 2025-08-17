## Trace

### 实现目标

trace命令用于对go进程中的特定函数调用进行跟踪，适合性能分析、异常检测和安全审计等场景。

本节介绍 `trace` 命令的实现，它能够对某个package下的函数名匹配regexp的函数进行跟踪，并且支持对函数体内fanout出去的函数调用自动进行跟踪。在某些场景下希望检查特定函数是否有被执行、执行代码路径如何以及执行耗时如何，trace命令就会非常有用。

```bash
$ tinydbg help trace
Trace program execution.

The trace sub command will set a tracepoint on every function matching the
provided regular expression and output information when tracepoint is hit.  This
is useful if you do not want to begin an entire debug session, but merely want
to know what functions your process is executing.

The output of the trace sub command is printed to stderr, so if you would like to
only see the output of the trace operations you can redirect stdout.

Usage:
  tinydbg trace <regexp> [flags]

Flags:
  -e, --exec string        Binary file to exec and trace.
      --follow-calls int   Trace all children of the function to the required depth.
  -h, --help               help for trace
  -p, --pid int            Pid to attach to.
  -s, --stack int          Show stack trace with given depth.
      --timestamp          Show timestamp in the output.

Global Flags:
      --disable-aslr           Disables address space randomization
      --log                    Enable debugging server logging.
      --log-dest string        Writes logs to the specified file or file descriptor (see 'dlv help log').
      --log-output string      Comma separated list of components that should produce debug output (see 'dlv help log')
  -r, --redirect stringArray   Specifies redirect rules for target process (see 'dlv help redirect')
      --wd string              Working directory for running the program.
```

和dlv相比，我们移除了对package、源文件进行构建并测试的功能，仅保留核心功能逻辑，下面介绍下仍支持的选项：

- --pid，跟踪已经在运行的进程，不能搭配--disable-aslr使用
- --exec，启动并跟踪一个可执行程序，可配合--disable-aslr使用
- --follow-calls，跟踪函数调用时限制函数体fanout函数调用的深度
- --stack，trace命令在regexp匹配的各个函数名的入口地址、返回地址都设置了断点，每次执行到这里时，打印堆栈

### 基础知识

对函数调用进行跟踪，有两种实现思路:

- breakpoint-based：通过ptrace系统调用跟踪进程后，在目的函数地址处添加断点，恢复执行，等到命中断点后ptracer可读取函数参数信息、计算调用栈信息--stack，也可以在函数返回地址处添加断点，这样就可以函数进入、从函数返回时的时间戳来计算函数执行耗时--timestamp。
- ebpf-based：通过编写在要跟踪的函数地址处添加uprobe，在程序执行到此位置时，触发已经加载的ebpf程序，ebpf程序中收集事件信息，如函数参数信息，用户态程序接收事件并进一步完成统计，如输出调用栈--stack、输出函数执行耗时--timestamp。

这两种方案都有一个共同的问题需要解决，那就是：
1、先通过DWARF调试信息计算出定义了哪些函数，指定的正则表达式将与定义的函数列表进行匹配，匹配到的函数将被作为顶层函数追踪；
2、其次是分析函数调用栈，这个都需要通过执行到的pc来反推当前调用栈，这个和调试命令 `bt` 实现方案一致，要借助于 Call Frame Information;
3、再者要分析目标函数的函数体内的函数调用并通过 `--follow-calls=<depth>`控制调用深度，分析有哪些函数调用要借助对源码的AST分析；

OK，trace调试命令，对于前后端分离式的调试器架构，前后端交互流程如下：

1. 用户在前端输入 `tinydbg trace <regexp> [flags]` 命令。
2. 调试器后端初始化，如启动executable，或者通过ptrace操作attach目标进程，并等待进程停止；
3. 调试器前端初始化，初始化client，RPC获取函数定义列表，通过正则筛选匹配的函数，然后：
   - 如果是基于断点的方案，需要对每个函数的入口地址、返回地址添加断点；
   - 如果是基于ebpf的方案，需要对每个函数的入口地址、返回地址添加uprobes，并关联对应的ebpf事件信息收集、统计程序；
4. 
5. 调试器前端初始化调试会话，如果是基于断点实现，需要执行ptrace、wait程序暂停、设置好断点后，continue让程序恢复执行，并通过RPC从调试器后端不断请求、接受最新的函数跟踪数据，并打印出来显示给用户；
6. 调试器前端ctrl+c结束时通过RPC通知调试器后端结束对目标进程的跟踪操作，如移除断点 or 移除uprobes、卸载ebpf程序；

由于trace的结果数据是源源不断的，理论上更合理的设计应该是上面这样的。但是考虑到tinydbg前后端交互缺少对流式调用的支持，而且执行trace操作时是不需要执行交互式的调试命令的，所以可以直接让调试器后端来输出结果。OK，这样的话，尽管我们还是前后端分离式架构，但具体来说是仅工作在通过net.Pipe通信这种模式下，不支持指定--headless模式下通过net.TCPConn或者net.UnixConn来进行网络通信

### 代码实现

下面看下关键的函数执行流程，篇幅原因注意我们只保留了breakpoint-based实现方案，ebpf-based方案我们在 “3-高级功能扩展” 中进行介绍。

#### 前后端准备阶段

```bash
main.go:main.main
    \--> cmds.New(false).Execute()
            \--> traceCommand.Run()
                    \--> traceCmd(...)
                            // serverside
                            \--> server := rpccommon.NewServer(...)
                            \--> err := server.Run()
                                    \--> s.debugger, err = debugger.New(&config, s.config.ProcessArgs)
                                    \--> forloop
                                            \--> c, err := s.listener.Accept()
                                            \--> go s.serveConnection(c)
                                                    \--> only `continue` will be received, let the ptracee continue
                                                    \--> forloop with wait4(pid, ....)
                                                            \--> print func info, including name, args, address, ...
                            // clientside
                            \--> client := rpc2.NewClientFromConn(clientConn)
                            \--> funcs, err := client.ListFunctions(regexp, traceFollowCalls)
                            \--> for range funcs
                                    \--> client.CreateBreakpoint(...), create bp at func entry
                                    \--> client.CreateBreakpoint(...), create bp at func return
                            \--> cmds := debug.NewDebugCommands(client)
                            \--> err = cmds.Call("continue", t)
```

下面看下traceCmd源码：

```go
func traceCmd(cmd *cobra.Command, args []string, conf *config.Config) int {
    status := func() int {
        ...
        var regexp string
        var processArgs []string

        dbgArgs, targetArgs := splitArgs(cmd, args)
        ...

        // Make a local in-memory connection that client and server use to communicate
        listener, clientConn := service.ListenerPipe()
        ...

        client := rpc2.NewClientFromConn(clientConn)
        ...

        funcs, err := client.ListFunctions(regexp, traceFollowCalls)
        if err != nil {
            fmt.Fprintln(os.Stderr, err)
            return 1
        }
        success := false
        for i := range funcs {
            // Fall back to breakpoint based tracing if we get an error.
            var stackdepth int
            // Default size of stackdepth to trace function calls and descendants=20
            stackdepth = traceStackDepth
            if traceFollowCalls > 0 && stackdepth == 0 {
                stackdepth = 20
            }
            _, err = client.CreateBreakpoint(&api.Breakpoint{
                FunctionName:     funcs[i],
                Tracepoint:       true,
                Line:             -1,
                Stacktrace:       stackdepth,
                LoadArgs:         &debug.ShortLoadConfig,
                TraceFollowCalls: traceFollowCalls,
                RootFuncName:     regexp,
            })

            ...
            // create breakpoint at the return address
            addrs, err := client.FunctionReturnLocations(funcs[i])
            if err != nil {
                fmt.Fprintf(os.Stderr, "unable to set tracepoint on function %s: %#v\n", funcs[i], err)
                continue
            }
            for i := range addrs {
                _, err = client.CreateBreakpoint(&api.Breakpoint{
                    Addr:             addrs[i],
                    TraceReturn:      true,
                    Stacktrace:       stackdepth,
                    Line:             -1,
                    LoadArgs:         &debug.ShortLoadConfig,
                    TraceFollowCalls: traceFollowCalls,
                    RootFuncName:     regexp,
                })
                ...
            }
        }
        ...

        // set terminal to non-interactive
        cmds := debug.NewDebugCommands(client)
        cfg := &config.Config{
            TraceShowTimestamp: traceShowTimestamp,
        }
        t := debug.New(client, cfg)
        t.SetTraceNonInteractive()
        t.RedirectTo(os.Stderr)
        defer t.Close()

        // resume ptracee
        err = cmds.Call("continue", t)
        if err != nil {
            fmt.Fprintln(os.Stderr, err)
            if !strings.Contains(err.Error(), "exited") {
                return 1
            }
        }
        return 0
    }()
    return status
}
```

关于client.ListFunctions(...)的工作过程，我们在how_listfunctions_work小节进行了详细介绍，感兴趣的读者可以先阅读相关小节了解下。这里我们先不过多介绍。

#### 函数跟踪结果输出

在breakpoint-based方案下，当ptracee命中断点时，ptracer会执行什么操作呢？执行什么操作，与对该断点的一些“修饰”有关。


在函数入口处添加断点的RPC操作如下：

```go
_, err = client.CreateBreakpoint(&api.Breakpoint{
	FunctionName:     funcs[i],
	Tracepoint:       true,
	Line:             -1,
	Stacktrace:       stackdepth,
	LoadArgs:         &debug.ShortLoadConfig,
	TraceFollowCalls: traceFollowCalls,
	RootFuncName:     regexp,
})
```

在函数返回地址处添加断点的RPC操作如下：

```go
_, err = client.CreateBreakpoint(&api.Breakpoint{
	Addr:             addrs[i],
	TraceReturn:      true,
	Stacktrace:       stackdepth,
	Line:             -1,
	LoadArgs:         &debug.ShortLoadConfig,
	TraceFollowCalls: traceFollowCalls,
	RootFuncName:     regexp,
})
```

注意这两个RPC请求参数的不同：
- 在函数入口添加断点，指定的是函数名；而在返回地址处添加断点，却需要指定地址，而且这个地址还不止一个，同一个函数会在多处被调用，返回地址自然不止一个；
- Tracepoint=true, TraceReturn=true，这是和常规断点的不同之处，在tracee命中断点暂停，ptracer根据当前pc-1处断点的这俩标识就可以确定是停在函数入口，还是函数返回地址处
  - 获取参数：如果是函数入口，就可以根据go函数传参规则，以及DWARF、AST信息，来获取内存数据、参数在target中的类型和源码类型，并进行必要转换；
  - 计算耗时：如果是函数入口，就可以记录当前进入时间戳ts1，如果是出口就可以记录退出时间戳ts2，ts2-ts1进而就可以计算出耗时信息；

大致如此，在介绍到断点相关细节时，我们会进行进一步介绍，这里先不过多展开，读者先了解核心逻辑即可。

### 本节小结

trace适合性能分析、异常检测和安全审计等场景，是非常有用的一种调试方法。但是需要注意一下breakpoint-based方案对性能的影响，如果考虑对性能影响最小，应该考虑ebpf-based方案。另外，有些读者也发现trace命令并不能将函数参数给完整打印出来（类似print vars）那样，这是很好理解的，因为这里考虑了对性能的影响。如果要将完整参数打印出来，包括跟踪参数内部的指针解引用，这将会包括非常多的类型解析、内存数据读取操作，程序暂停时间会很明显。

所以trace仅仅支持字符串类型的参数打印，关于这个不能打印参数的问题，也有网友在go-delve/delve讨论区进行了讨论，see: [Can dlv trace print the value of the arguments passed to a function?](https://github.com/go-delve/delve/issues/3586) 。

根据我的实践经验、心得，我认为即使trace当前不能打印参数，trace命令也仍然很有用。

> see: https://github.com/go-delve/delve/issues/3586#issuecomment-2911771133，翻译过来
>
> 即使trace命令当前不能打印参数，trace命令也仍然很有用，比如，我们想做一些服务负载测试:
>
> 1) 通常情况下，微服务框架报告的RPC耗时已经足够了，但有时候还不够。
>    - 耗时可能通过time.Duration指标或者Tracing span中的time.Duration来报告
>    - 或者记录在日志文件中
>      但是为了避免压力，报告和日志记录逻辑可能都被禁用了。
>      或者opentelemetry后端不太好用,无法很好地可视化跟踪和span。
> 2) 可能我们知道特定RPC处理有瓶颈，比如某个函数调用(不是对callee的RPC调用)，
>    但我们不想手动使用golang runtime/trace包创建span，所以性能分析也帮不上忙。
> 3) 最糟糕的是，我们知道有瓶颈，但不知道是哪个函数调用导致的。
>    而且我们不想修改代码来添加日志。
>    可能CI/CD系统太耗时了，我们不想等它就绪...可能我们要重复多次。
>    ...
>    好吧，我需要一个跟踪工具来报告调用了哪些函数以及耗时多少。而且跟踪不应该给目标进程增加明显的时间开销。在这种情况下，我们不关心是否打印参数。另请参阅:[hitzhangjie/go-ftrace](https://github.com/hitzhangjie/go-ftrace)和[jschwinger233/gofuncgraph](https://github.com/jschwinger233/gofuncgraph)，它们使用基于ebpf的解决方案，就像 `dlv trace`一样。
>
> - 如果我们不想影响性能，应该使用基于ebpf的解决方案。我们仍然可以打印参数，但有限制，比如我们不解引用结构体字段以避免更多的PTRACE_PEEKDATA...
> - 如果我们不关心性能影响，可以使用基于断点的解决方案，并添加一些代码来详细打印参数。
>   但正如aarzilli提到的，`trace <id>`和 `on <id> print <args>`可以做到这一点。

OK，关于trace我们就先介绍到这里，