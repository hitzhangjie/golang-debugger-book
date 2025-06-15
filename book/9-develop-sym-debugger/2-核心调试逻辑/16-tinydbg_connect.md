## Connect

### 实现目标: `tinydbg connect <addr>`

在远程调试模式下，connect命令用来连接一个调试器后端，完成网络通信层的初始化，然后初始化一个前端调试会话，开发者即可交互式地进行调试了。

```bash
$ tinydbg help connect
Connect to a running headless debug server with a terminal client. Prefix with 'unix:' to use a unix domain socket.

Usage:
  tinydbg connect <addr> [flags]

Flags:
  -h, --help   help for connect

Global Flags:
      --init string         Init file, executed by the terminal client.
      --log                 Enable debugging server logging.
      --log-dest string     Writes logs to the specified file or file descriptor (see 'dlv help log').
      --log-output string   Comma separated list of components that should produce debug output (see 'dlv help log')
```

### 基础知识

相比attach、exec、debug (or test)、core这几个调试命令，connect是彻彻底底的为远程调试准备的。既然是远程调试，就涉及到调试器前端、后端独立运行。

调试器后端运行，可以通过attach、exec、debug（or test）、core，并配合参数 `--headless` 参数就可以启动一个调试器后端，它等待调试前端通过TCPConn或UnixConn以JSON RPC或者DAP RPC的形式进行通信。在我们的demo tinydbg中，我们只支持JSON-RPC进行通信。关于DAP (Debugger Adapater Protocol)，我们在 "3-高级功能扩展" 小节进行介绍。

调试器后端运行时，允许通过参数 `-l | --listen` 来指定一个监听地址：

```bash
-l, --listen string                    Debugging server listen address. Prefix with 'unix:' to use a unix domain socket. (default "127.0.0.1:0")
```

- default：127.0.0.1:0，port没有指定的情况下，会自动分配一个port，调试器进程会打印出监听地址，以方便调试器前端连接；
  与VSCode集成后为了更方便地进行调试，就需要前后端能够就监听地址达成一致，以方便VSCode调试器前端连接；
- 指定具体的 IP:PORT，如果提前规划好了使用某个IP:PORT用于RPC通信，也可以指定IP:PORT；
- 指定 unix:/path-to/socket，也可以使用Unix Domain Socket进行通信；

如果考虑到VSCode远程开发、容器开发以及WebIDE远程开发，那我们还得掰扯掰扯VSCode的C/S分离式架构，以及插件运行方式（extensionKind，在UI/Local Extension Host、Remote/Workspace Extension Host、或二者均可）。如果咱们有时间的话，就分享下这些内容，以及VSCode（C/S）、VSCode调试器插件（local/remote extension host）、调试器前后端（C/S）它们之间是如何进行交互的。

OK，先言归正传，我们先介绍下connect命令的代码实现。

### 代码实现

前面调试器会话小节，我们提到过connect的大致实现方式，这里再简单回顾一遍吧，建立调试会话的代码路径是：

```bash
main.go:main.main
    \--> cmds.New(false).Execute()
            \--> connectCommand.Run()
                    \--> connectCmd(...)
                            \--> connect(addr, nil, conf)
                                    \--> conn := netDial(addr)
                                            \--> if isTCPAddress, conn, _ := net.Dial("tcp", addr) 
                                            \--> if isUnixAddress, conn, _ := net.Dial("unix", addr)
                                    \--> client := rpc2.NewClientFromConn(conn)
                                    \--> session := debug.New(client, conf)
                                    \--> session.Run()
                                            \--> forloop
                                                    \--> read input
                                                    \--> parse debugcmd flags args
                                                    \--> session.client.Call('RPCServer.'+method, req, rsp)
                                                            \--> json-rpc over tcpconn or unixconn
                                                    \--> update UI based on rsp
```

执行connect命令，大致会经历上述代码路径，connect会根据传递的参数addr来确定是一个tcp监听地址，还是一个unix domain socket，然后建立对应的连接。一旦连接建立了，就可以初始化rpcclient。然后初始化一个调试会话，调试会话运行起来后就是一个类似repl的forloop，读取输入，解析命令、参数、选项，然后执行。只不过这里的执行，需要与调试器服务器交互，而且几乎所有的调试命令都如此。调试器会话与调试器服务器之间通过建立的通信链路完成请求发送、响应接受。然后根据响应，调试器前端更新显示，如显示变量值、指令列表、打印类型详情、显示当前程序执行到的指令地址及源码位置，等等。

调试器会话初始化、网络通信层的初始化过程，以及后续调试器前端与调试器后端的详细交互过程，我们都已经在调试会话小节已经详细介绍了，这里就不再赘述了。

值得一提的是，调试器后端启动调试时如果指定了 `--accept-multiclient` 那么才允许调试器后端执行期间接受多个入客户端连接请求：
- 客户端1正在调试，此时客户端2来连接；
- 客户端2已经结束调试，并且已经与调试服务器分离，但是没有杀死进程实例，此时客户端来连接；

这两种情况，如果想允许客户端2来连接，都需要在启动调试器后端时显示指定上述选项 `--accept-multiclient`。那么为什么不默认启用选项 `--accept-multiclient` 呢？

对于常见的 `tinydbg debug ...` 操作来说，因为程序是我们自动构建出来的，也是自己启动的进程，所以调试完后默认预期是这个进程已经被调试利用完了，没有继续存在的必要了，所以会提示调试人员是否需要自动kill该进程，绝大多数情况下，大家会点“是”。这才是绝大多数情况。而对于前一次调试完了，后面又发起一次调试，但是这种情况下，说明一时半会确定不了问题，需要多次调试跟踪，此时在有明确诉求的情况下，直接加选项 `--accept-multicilent` 后启动即可。另外，如果我们加了这个选项，在我们调试期间，如果真的有人连接进来了，它执行的一些调试动作可能会影响到我们。但是，允许多个客户端同时登录也增加了一定的灵活性，如这样可能允许多人联合调试、联合定位异常。

### 执行测试

略

### 本节小结

本节介绍了connect命令的实现，它允许调试器前端连接到独立运行的调试器后端进程。我们详细讲解了连接建立的过程、调试会话的初始化，以及多客户端连接支持的相关考虑。这为理解分布式调试场景下调试器的工作方式提供了基础。
