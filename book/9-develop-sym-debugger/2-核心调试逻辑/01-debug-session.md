## Debug Session

### 实现目标

在命令行敲下 `godbg exec ./prog`（或 `attach`、`debug`、`connect`）之后，调试器进程里其实做了两件互相独立的事：先把"要调试谁"确定下来——启动一个进程并跟踪它，或者 attach 到一个已经在跑的进程；然后进入一个循环，读一行命令、执行、打印结果、再读下一行。后者就是调试会话（debug session），也就是我们从第5章起一直在用的 `godbg> ` 提示符。

本节要回答三个问题：

1. 会话是怎么装配起来的——谁创建后端（`debugger.Debugger`）、谁把客户端注入给命令层、本地模式与 headless 模式到底差在哪儿；
2. 一行命令是怎么被分发的——`liner` 读入字符串、`cobra` 找到命令、命令的 `RunE` 调到 `api.Client` 的某个方法上；
3. 这一次方法调用如何跨过 RPC 边界、在后端被执行、再把结果原路带回来。

先把结论摆出来：能进入会话的四个进程级命令（attach、exec、debug、connect）最终都收敛到 `cmd/session.go` 的 `startDebugSession`，差别只在"进入会话之前，后端手上有没有目标进程"：

| 命令 | 进入会话前做了什么 | 会话入口 |
| --- | --- | --- |
| `godbg attach <pid>` | `Client.Attach(pid)`，跟踪运行中进程及其全部线程 | `PostRun` → `startDebugSession` |
| `godbg exec <prog>` | `Client.Launch(api.KindExec, prog, args, opts)` | 同上 |
| `godbg debug [dir\|file]` | 先 `go build`，再 `Client.Launch(api.KindDebug, "./"+BuildExecName, …)` | 同上 |
| `godbg connect <addr>` | `service.WireRemote(addr)`，不创建目标进程 | 同上 |
| `godbg core <core> <exe>` | 仍是桩：`cmd/core.go` 直接返回"core 调试尚未实现" | — |

因此真正能走到会话的入口是 attach、exec、debug、connect 四条（core 待第 9.2.15 节补齐）。

需要说明的是：本书早期版本的这一节以 tinydbg（delve 的裁剪版）为示范，新版统一改成 `godbgv2`，后文所有代码、调用链与结论都以 `godbgv2` 为准。

本节与相邻小节有明确分工，避免重复：目标进程的启动与跟踪细节在 9.2.11（attach）、9.2.13（exec）、9.2.14（debug）里讲；`break` 命令背后的 locspec 解析与断点管理在 9.2.19、9.2.21、9.2.22 里讲；`funcs` 的符号层实现见 9.2.32 与 9.2.100。本节只讲"会话本身"：装配、分发、一次 RPC 往返，以及 headless 模式在装配上的差异（服务端部分留给 9.2.16）。

### 基础知识

前几章我们一直用"前后端分离"来描述调试器：前端负责命令解析与结果展示，后端负责真正操作 tracee。`godbgv2` 对这句话有一个更严格的落地方式——**前后端分离的边界在传输层，而不在进程边界**（`main.go` 的注释原话）。也就是说，即使本地调试、即使前后端在同一个进程里，命令也不是"直接调用后端对象"，而要走一次完整的 RPC 请求-响应：客户端把方法名和参数编码成字节，服务端解码、执行、把结果编码成字节送回来。

为什么本地也要绕这一圈？因为这样做换来了四件事：

1. 命令层的代码只依赖 `api.Client` 契约，不依赖 `debugger.Debugger`，所以"本地进程内"与"远程 headless"可以共用同一套命令实现；
2. 切换到 headless 模式时，`cmd/` 目录一行都不用改——差异全部收敛到 `main.go` 的装配处；
3. 契约的约束是硬性的：`docs/ARCH-RULES.md` 的铁律 1（后端不打印）、铁律 2（只传值/可序列化结构）、铁律 3（一次性返回快照、不做流式）、铁律 4（`cmd/` 的 import 白名单）——它们共同保证"换一个 `api.Client` 实现"这件事是可行的；
4. 代价是一次进程内序列化，用 `net.Pipe` 时收发是同步的，但相对 ptrace 系统调用的开销可以忽略。

会话的整个生命周期可以画成下图。上半部分是进程启动时的一次性装配，下半部分才是每敲一行命令重复发生的事：

```
[进程启动，一次性装配]
main.main
 ├─ debugger.New()                        后端门面（此刻还没有目标进程）
 ├─ service.WireLocal(dbg)                本地模式：进程内 RPC
 │   ├─ NewListenerPipe()                 net.Pipe() → (srv, cli)
 │   ├─ go rpc2.NewServer(dbg).Accept(ln)
 │   └─ rpc.NewClient(cli) → rpc2.Client ──► cmd.Client（api.Client 契约）
 ├─ cmd.ServeHeadless = func(listen)      只有 --headless 分支才会用到
 └─ cmd.Execute() → rootCmd.Execute()
      ├─ RunE:    attach/exec/debug/connect ──► Client.Attach / Launch / …（也是 RPC）
      └─ PostRun: startDebugSession(cmd)
            ├─ --headless → ServeHeadless(listen)：只当服务端，不开会话
            └─ 否则     → debug.Client = Client
                          CurrentSession = NewDebugSession().AtExit(Cleanup)
                          CurrentSession.Start()
```

注意两个容易看漏的点：

- `WireLocal` 发生在 `cmd.Execute()` **之前**。也就是说，本地模式下"连接"是进程启动时就建好的，而不是像早期实现那样"等 attach 成功后再建"。`attach` 命令自己发的那次 `Client.Attach(pid)` 同样是一次 RPC，走的就是这条已经建好的管道。
- headless 模式并不是"另一套代码"，它只是把 `WireLocal` 的 `net.Pipe` 换成 `net.Listen("tcp", …)` 并把 `Accept` 交给 `net/rpc` 的服务端循环。客户端一侧则由 `godbg connect` 用 `service.WireRemote(addr)` 建连，然后同样进入 `startDebugSession`。

前后端之间传递的东西是两类结构体：**请求参数对**与**响应消息对**。`api.Client` 有 41 个方法，每个方法在 `pkg/service/rpc2` 里都有对应的 `XxxArgs` / `XxxReply`（个别方法复用同形状的响应结构），服务端方法的形式固定为 `func (s *serverImpl) Xxx(args *XxxArgs, reply *XxxReply) error`。这三个要素（方法名、请求结构、响应结构）就是 `net/rpc` 需要的全部信息：

- 传输协议是标准库 `net/rpc` 的默认编码，即 `encoding/gob`；
- 调用是全同步的：`Call` 一直阻塞到收到响应，没有回调、没有事件通道；
- 跨连接的请求/响应靠 `Request.Seq`（序号）配对，客户端用 `map[seq]*Call` 记录在途请求。

`api.Client` 的三条设计原则（`pkg/service/api/client.go` 的包注释）正是为这种传输准备的：**只搬数据不打印**（后端返回数据快照，格式化由 UI 层做）、**只传值/可序列化结构**（便于 gob 编码）、**请求-响应快照语义**（不做流式/迭代器）。

本地与 headless 两种模式的差异，汇总成一张表就清楚了：

| 维度 | 本地模式（默认） | headless 模式 |
| --- | --- | --- |
| 服务端装配点 | `main.main` → `service.WireLocal` | `main.main` 注入的 `cmd.ServeHeadless` |
| 客户端装配点 | 同一次 `WireLocal` | `godbg connect` → `service.WireRemote` |
| 监听器 | `NewListenerPipe`（`net.Pipe`） | `net.Listen("tcp", listen)` |
| 连接建立时机 | 进程启动时 | 客户端执行 `connect` 时 `rpc.Dial` |
| 命令发往哪里 | 同进程内的服务端协程 | 另一个进程的服务端 |
| 编码 | gob | gob |

### 代码实现

#### 装配：main 把服务端接进前端

`main` 函数只有 20 多行，但它是整个架构的装配点（`main.go`）：

```go
func main() {
	go processSignals()

	// ch9.2.16：本地模式也经进程内 RPC 与服务端通信——
	// 前后端分离的架构边界在传输层，而非进程边界
	dbg := debugger.New()
	client, err := service.WireLocal(dbg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "wire local: %v\n", err)
		os.Exit(1)
	}
	cmd.Client = client

	// headless 模式的服务端装配（由会话层触发）
	cmd.ServeHeadless = func(listenAddr string) error {
		ln, err := net.Listen("tcp", listenAddr)
		if err != nil {
			return err
		}
		fmt.Printf("godbg headless server listening on %s\n", ln.Addr())
		rpc2.NewServer(dbg).Accept(ln)
		return nil
	}

	cmd.Execute()
}
```

这段代码里有三个"注入点"，各自解决一个问题：

- `cmd.Client = client`：把 `api.Client` 的具体实现交给 `cmd` 包。`cmd/client.go` 里只有一个包级变量 `var Client api.Client`，没有构造函数、没有单例，谁装配谁负责；
- `cmd.ServeHeadless`：headless 的服务端要用 `rpc2.NewServer` 和 `net.Listen`，而铁律 4 禁止 `cmd/` import `pkg/service/rpc2` 与 `pkg/service/debugger`，所以 `cmd` 只声明一个函数变量，由 `main` 把实现填进去；
- `debugger.New()`：先创建门面实例，再把它交给 RPC 服务端。门面是"后端"的入口，但创建时它还没有目标进程——目标进程是后续 `Launch` / `Attach` 才产生的。

`WireLocal` 本身只有 10 行（`pkg/service/wire.go`）：

```go
func WireLocal(dbg *debugger.Debugger) (api.Client, error) {
	ln, cli, err := NewListenerPipe()
	if err != nil {
		return nil, err
	}

	server := rpc2.NewServer(dbg)
	go server.Accept(ln)

	return rpc2.NewClientFrom(rpc.NewClient(cli)), nil
}
```

它做的三件事，正好对应"一次装配"的三步：拿到一对已经连好的管道、在服务端协程里跑 `Accept`、用管道另一端创建 `rpc.Client` 并包装成实现了 41 个方法的 `rpc2.Client`。管道来自 `pkg/service/listenerpipe.go`：

```go
func NewListenerPipe() (net.Listener, net.Conn, error) {
	srv, cli := net.Pipe()
	l := &listenerPipe{
		ch:   make(chan net.Conn, 1),
		once: make(chan struct{}),
	}
	l.ch <- srv
	return l, cli, nil
}
```

`listenerPipe` 是一个"只有一条连接"的 `net.Listener`：`Accept` 从带缓冲的 channel 里取那唯一一条连接，取完就阻塞；`Addr()` 返回占位地址 `pipeAddr`（`Network()` 与 `String()` 都是 `"pipe"`）。这里不需要地址，因为客户端根本不用拨号——它拿到的 `cli` 就是管道的另一端。

headless 分支的唯一区别是 `main.go` 里的那个闭包：`net.Listen` 拿到 TCP 监听器，`rpc2.NewServer(dbg).Accept(ln)` 阻塞地服务所有入连接。这一段值得留到 9.2.16 展开，本节只需要知道它复用了同一个 `dbg` 门面、同一套 `serverImpl` 方法与同一份消息对。

#### 入口命令：先建目标，再开会话

`cmd/` 下的进程级命令都遵循同一个模式：`RunE` 负责建立目标（或连接），`PostRun` 负责进入会话。以 attach 为例（`cmd/attach.go`）：

```go
RunE: func(cmd *cobra.Command, args []string) error {
	if len(args) != 1 {
		return errors.New("参数错误")
	}
	pid, err := strconv.Atoi(args[0])
	if err != nil {
		return fmt.Errorf("invalid pid %q: %v", args[0], err)
	}

	// attach 到运行中的进程及其全部线程，等待其因 SIGSTOP 而停止
	tids, err := Client.Attach(pid)
	if err != nil {
		return err
	}
	fmt.Printf("process %d attached, stopped by SIGSTOP\n", pid)
	for _, tid := range tids {
		fmt.Printf("thread %d attached\n", tid)
	}
	return nil
},
PostRun: func(cmd *cobra.Command, args []string) {
	startDebugSession(cmd)
},
```

exec 与 debug 只换了 `Launch` 的参数：exec 用 `Client.Launch(api.KindExec, args[0], args[1:], opts)`；debug 先 `go build -gcflags=all=-N -l -ldflags=-compressdwarf=false -o __debug_bin__`，再 `Client.Launch(api.KindDebug, "./"+BuildExecName, traceeArgs, opts)`。connect 则根本不碰目标进程，只在 `RunE` 里把 `Client` 换成远程客户端：

```go
client, err := service.WireRemote(args[0])
if err != nil {
	return err
}
Client = client
```

于是四条命令的处理链可以并排写出来，格式一致、只是中间那一跳不同：

```bash
godbg attach <pid>
  main.go:main.main
    \--> cmd.Execute()                         rootCmd.Execute()
          \--> attachCmd.RunE                  cmd/attach.go
                \--> Client.Attach(pid)        rpc2.Client.Attach → Debugger.Attach（RPC）
                      \--> debugger.Debugger.Attach
                            \--> target.AttachTargetProcess(pid) → proc.NewTarget(dbp)
          \--> attachCmd.PostRun → startDebugSession(cmd)

godbg exec <prog>
  …--> execCmd.RunE --> Client.Launch(api.KindExec,…) --> debugger.Launch --> target.NewDebuggedProcess
  …--> PostRun → startDebugSession

godbg debug [dir|file]
  …--> debugCmd.RunE --> go build --> Client.Launch(api.KindDebug,…)
  …--> PostRun → startDebugSession（退出后删除 __debug_bin__）

godbg connect <addr>
  …--> connectCmd.RunE --> service.WireRemote(addr) --> Client = client
  …--> PostRun → startDebugSession
```

四条链在 `startDebugSession` 处汇合。这个函数只有十几行，却包含了会话的全部三种去向（`cmd/session.go`）：

```go
func startDebugSession(cmd *cobra.Command) {
	if headless, _ := cmd.Flags().GetBool("headless"); headless {
		listen, _ := cmd.Flags().GetString("listen")
		if err := ServeHeadless(listen); err != nil {
			fmt.Fprintf(os.Stderr, "headless serve error: %v\n", err)
		}
		return
	}
	initFile, _ := cmd.Flags().GetString("init")

	debug.Client = Client
	// 会话退出（含 --init 批量回放结束）时，统一清理被调试进程
	debug.CurrentSession = debug.NewDebugSession().AtExit(debug.Cleanup)
	if initFile != "" {
		debug.CurrentSession.SetInitFile(initFile)
	}
	debug.CurrentSession.Start()
}
```

三个去向分别是：

1. **headless**：只当服务端，阻塞在 `ServeHeadless` 里，不创建会话——此时用户应该另开一个终端执行 `godbg connect`；
2. **批量回放**：带 `--init <file>` 时创建会话但走 `replay`，脚本执行完就退出，供脚本化调试与冒烟测试使用；
3. **交互**：默认情况，`Start()` 里创建 `liner` 进入 REPL。

`debug.Client = Client` 这一行也值得解释：`cmd` 与 `cmd/debug` 是两个包，命令实现里用的是 `debug.Client`（`cmd/debug/shell.go` 的包级变量），而装配发生在 `cmd` 包。两边都只认 `api.Client` 这个契约类型，所以注入是安全的；`cmd` 包也不需要知道具体实现是 `rpc2.Client`。

会话退出时要善后，善后动作注册在 `AtExit` 上，实现是 `debug.Cleanup`（`cmd/debug/exit.go`）：

```go
func Cleanup() {
	if Client == nil {
		return
	}

	// 还原全部断点
	if err := Client.ClearAll(); err != nil {
		fmt.Fprintf(os.Stderr, "clearall failed err: %v\n", err)
	}

	st, err := Client.State()
	if err != nil {
		fmt.Fprintf(os.Stderr, "get state error: %v\n", err)
		return
	}

	switch st.Kind {
	case api.KindDebug:
		fmt.Println("tracee is built and run by tracer, remove binary and kill it")
		if err := Client.Kill(); err != nil {
			fmt.Fprintf(os.Stderr, "kill tracee: %d, err: %v\n", st.PID, err)
		}
	case api.KindExec:
		fmt.Println("tracee is run by tracer, kill it")
		if err := Client.Kill(); err != nil {
			fmt.Fprintf(os.Stderr, "kill tracee: %d, err: %v\n", st.PID, err)
		}
	case api.KindAttach:
		fmt.Println("tracee is an attached process, leave it running")
		if err := Client.Detach(); err != nil {
			fmt.Fprintf(os.Stderr, "detach tracee: %d, err: %v\n", st.PID, err)
		}
	}
}
```

这里体现了"谁创建、谁负责"的语义：`debug`/`exec` 的目标进程是调试器自己启动的，调试结束就 `Kill`；`attach` 的目标进程本来就在跑，调试结束只能 `Detach` 让它继续运行。清理动作也是 RPC 调用，也就是说会话退出的最后一步仍然是跨传输层的往返。

#### 会话循环：liner、cobra 与 flag 复位

会话对象是 `cmd/debug/shell.go` 里的 `DebugSession`：

```go
type DebugSession struct {
	done   chan bool
	prefix string
	root   *cobra.Command
	liner  *liner.State
	last   string

	initFile string // 会话启动时要回放的脚本文件（非交互模式）
	stopped  bool   // 会话是否已请求结束

	defers []func()
}
```

它持有的不是 `api.Client`，而是一棵 `*cobra.Command` 命令树——会话里的调试命令仍然用 cobra 管理。`NewDebugSession` 做三件事：注册自定义的 help 函数（`godbg> help` 打印分组后的命令表）、把注册表里的命令挂到根命令上、初始化字段。这里的注册表（`cmd/debug/def.go` 的 `commandDefs`/`installCommands`）目前还是空表，各命令仍以 `init()` + `debugRootCmd.AddCommand` 的方式挂载，注册表是为后续统一挂载预留的入口。

`Start` 是会话的主函数，逻辑分成"回放"和"交互"两条路：

```go
func (s *DebugSession) Start() {
	defer func() {
		for idx := len(s.defers) - 1; idx >= 0; idx-- {
			s.defers[idx]()
		}
	}()

	// 回放 init 脚本，回放结束后退出会话。
	//
	// 批量模式不创建 liner：liner.Close 会无条件对 stdin 做 tcsetattr
	// 恢复终端模式，而冒烟测试用 `timeout 30 ./godbg ...` 启动会话——
	// GNU timeout 默认把子进程放进新的进程组，godbg 于是是终端的后台
	// 进程组；后台进程组对终端做 tcsetattr 会被内核以 SIGTTOU 停止……
	if s.initFile != "" {
		if err := s.replay(s.initFile); err != nil {
			fmt.Fprintf(os.Stderr, "replay init file %s error: %v\n", s.initFile, err)
		}
		return
	}

	s.liner = liner.NewLiner()
	s.liner.SetCompleter(completer)
	s.liner.SetTabCompletionStyle(liner.TabPrints)
	defer s.liner.Close()

	for {
		select {
		case <-s.done:
			return
		default:
		}

		txt, err := s.liner.Prompt(s.prefix)
		if err != nil {
			panic(err)
		}

		txt = strings.TrimSpace(txt)
		if len(txt) != 0 {
			s.last = txt
			s.liner.AppendHistory(txt)
		} else {
			txt = s.last
		}

		_ = s.execute(txt)
	}
}
```

第一段 `defer` 是"退出栈"：注册的清理函数按后进先出执行，`AtExit(debug.Cleanup)` 注册的那个就在其中。

第二段是批量回放。**`liner` 只在交互模式下创建**，这不是随手写的优化，而是踩过一个很隐蔽的坑：`liner.Close()` 会无条件对 stdin 做 `tcsetattr`，把终端模式恢复回来；而冒烟测试用 `timeout 30 ./godbg …` 启动会话，GNU `timeout` 默认把子进程放进新的进程组，`godbg` 于是成了终端的后台进程组，后台进程组调用 `tcsetattr` 会被内核用 `SIGTTOU` 停住（进程状态变为 `T`）。此时 `timeout` 到点发的 `SIGTERM` 只能 pending，不带 `-k` 的 `timeout` 又会一直等子进程退出——整个 `make smoke` 就永久挂住了。批量模式从头到尾不读写终端，也就不需要恢复任何终端模式，所以干脆不创建 `liner`。

第三段是交互循环。几个细节：`select` 先检查 `done`，让 `exit` 命令有机会在下一轮循环开始前退出；空行（含纯空白）复用 `last`，实现"回车重复上一条命令"；`AppendHistory` 只写内存，godbgv2 不读写任何历史文件。

循环体里真正的分发逻辑在 `execute` 里，只有 8 行，却解决了 cobra 在 REPL 场景下的一个真问题：

```go
func (s *DebugSession) execute(line string) error {
	s.root.SetArgs(strings.Split(line, " "))
	cmd, err := s.root.ExecuteC()
	if cmd != nil {
		resetFlags(cmd)
	}
	return err
}

// resetFlags 把本次执行改过的 flag 恢复为默认值。
func resetFlags(cmd *cobra.Command) {
	cmd.Flags().VisitAll(func(f *pflag.Flag) {
		if !f.Changed {
			return
		}
		_ = f.Value.Set(f.DefValue)
		f.Changed = false
	})
}
```

两个要点：

- `SetArgs` + `ExecuteC` 让"一行文本"变成"一次 cobra 命令执行"，`ExecuteC` 返回实际执行的那条子命令，供后面复位 flag 用。注意参数是按空格 `strings.Split` 切开的（不是 shell 词法），因此调试命令的参数里不能带引号/转义的空白——这是这一版实现的已知边界；
- `resetFlags` 是必须的。REPL 从头到尾复用同一棵命令树，而 pflag 在多次 `Parse` 之间**不会**把上一行设置过的 flag 恢复成默认值：本次命令行里没出现的 flag 会保留上一行的值。比如先执行 `break -n foo main.main`，再执行 `break main.main`，如果不复位，第二条命令会莫名其妙带上 `-n foo`。统一在 `execute` 里复位，交互模式和 `--init` 回放才能保证每条命令都从默认状态开始。`cmd/debug/shell_test.go` 里的 `TestExecuteResetsFlags` 就是这条规则的回归测试（`demo -n 3` 之后执行裸 `demo`，期望 `n` 回到默认值 10）。

批量模式走的是另一个入口 `replay`，它不经过 cobra 之外的任何东西，只是逐行喂给 `execute`（下面是节选，省略了 `@capture` 的正则提取与输出重定向的细节）：

```go
scanner := bufio.NewScanner(f)
for scanner.Scan() {
	line := strings.TrimSpace(scanner.Text())
	if line == "" || strings.HasPrefix(line, "#") ||
		strings.HasPrefix(line, "!") || strings.HasPrefix(line, "=") {
		continue                       // 注释与冒烟测试的宿主指令
	}
	if strings.HasPrefix(line, "@") {
		// 只有 @capture 由回放器自己处理：从上一命令输出里按正则
		// 提取第一个捕获组存入 $<var>，供后续命令行做变量替换
		continue
	}

	fmt.Printf("godbg> %s\n", line)
	err = s.execute(line)              // 输出被临时重定向到管道，供 @capture 读取
	if err != nil {
		return err
	}
	if s.stopped {                     // 脚本里执行了 exit
		return nil
	}
}
```

`@capture` 与 `$var` 替换是为冒烟测试准备的：线程 id 这类只在当次会话输出里出现的值，没法写死在脚本里，只能先捕获、再在后面几行里替换。这一段属于测试基础设施，读者了解用途即可。

会话的退出有两条路。正常退出是 `exit` 命令（`cmd/debug/exit.go`）：`CurrentSession.Stop()` 设置 `stopped = true` 并 `close(s.done)`，交互循环在下一轮开头看到 `done` 关闭就 `return`，随后 `defer` 里的退出栈依次执行 `debug.Cleanup`，最后 `Start` 返回、`startDebugSession` 返回、命令结束。异常退出是 `main.go` 里的 `processSignals`：收到 `SIGTERM`/`SIGINT`/`SIGQUIT` 时直接调 `debug.Cleanup()` 再 `os.Exit(1)`，不走 `AtExit`，所以那里显式补了一次清理。

还有一个必须如实写出来的已知问题：**在交互模式下按 Ctrl+C 或 Ctrl+D，当前会 panic**。`liner.Prompt` 在这两种按键下并不返回一个"取消"标记，而是返回错误（分别为 `liner.ErrPromptAborted` 与 `io.EOF`），而 `Start` 对任何 `Prompt` 错误都是 `panic(err)`。由于 panic 会触发栈展开，`defer` 里的 `liner.Close` 与退出栈仍会执行，目标进程不会变成孤儿；但用户体验是打印一整段 panic 栈、以非零状态退出，而不是"优雅地结束会话"。这是 `cmd/debug/shell.go` 目前真实的缺陷，修复方式（把错误分支改成 `s.Stop()` 或直接 `return`）留给后续小节，本节不做美化。

#### 一次完整的 RPC 往返：break main.main

现在把镜头对准一行命令。假设目标进程已经停在入口处，我们在提示符下输入：

```
godbg> break main.main
```

这一次输入要经过十步才能变成界面上的一行输出：

```
 ① liner.Prompt("godbg> ") 读到 "break main.main"
 ② DebugSession.execute: SetArgs(strings.Split(line," ")) + ExecuteC()
 ③ breakCmd.RunE: parseAddress("main.main") 失败 ⇒ spec = "main.main"
 ④ Client.CreateBreakpoint(spec, cond="", name="")        ← api.Client 契约
 ⑤ rpc2.Client: c.c.Call("Debugger.CreateBreakpoint",
                         &CreateBreakpointArgs{...}, &reply)
 ⑥ net/rpc Client.Call → Go → send：gob 编码 Request{Seq,ServiceMethod} + Args
      传输介质：net.Pipe()（本地） / TCP（--headless + connect）
 ⑦ rpc.Server.serveCodec：gob 解码 → 按 ServiceMethod 反射调用对应方法
 ⑧ serverImpl.CreateBreakpoint(args, reply) → debugger.Debugger.CreateBreakpoint
 ⑨ proc.Target.CreateBreakpointByLoc → target.AddBreakpoint：PTRACE_PEEKTEXT/POKETEXT(0xCC)
 ⑩ 回程：gob 编码 Reply{Bps} + Response{Seq, Error:""} → ④ 拿到 reply.Bps
```

**第 ③ 步：命令层把文本变成一次契约调用。** `break` 命令的 `RunE`（`cmd/debug/break.go`）先尝试按纯地址解析，`main.main` 不是一个地址，于是进入 locspec 分支：

```go
spec := loc
if addr, err := parseAddress(loc); err == nil {
	spec = fmt.Sprintf("*%#x", addr)
}

// 位置描述（locspec）：可能解析出多个地址（如正则匹配）
bps, err := Client.CreateBreakpoint(spec, cond, name)
if err != nil {
	return err
}
for _, bp := range bps {
	info := fmt.Sprintf("breakpoint %d added at %#x", bp.ID, bp.Addr)
	if bp.Pos != "" {
		info += fmt.Sprintf(" (%s)", bp.Pos)
	}
	if bp.Name != "" {
		info += fmt.Sprintf(", name %q", bp.Name)
	}
	if cond != "" {
		info += fmt.Sprintf(", cond %q", cond)
	}
	fmt.Println(info)
}
```

注意这里没有"检查当前有没有目标进程"之类的判断，也没有任何格式化之外的后端职责——命令层拿到 `[]api.Breakpoint`，只负责打印。

**第 ④⑤ 步：契约方法变成 RPC 消息。** `Client` 在命令层是接口，实际类型是 `rpc2.Client`，方法体就是一次 `Call`（`pkg/service/rpc2/client.go`）：

```go
func (c *Client) CreateBreakpoint(loc, cond, name string) ([]api.Breakpoint, error) {
	var reply CreateBreakpointReply
	err := c.c.Call("Debugger.CreateBreakpoint", &CreateBreakpointArgs{Loc: loc, Cond: cond, Name: name}, &reply)
	return reply.Bps, err
}
```

`c.c` 是标准库的 `*rpc.Client`。注意这里没有再包一层 `call` 辅助方法：每个契约方法都直接调 `c.c.Call`，方法名字符串与消息对写在一起，读的时候不用来回跳。方法名 `"Debugger.CreateBreakpoint"` 中的 `Debugger` 就是服务端注册时用的名字（`RegisterName("Debugger", …)`），后半段是 Go 方法名。所有请求/响应结构体都定义在 `pkg/service/rpc2/server.go` 的前半部分，和契约方法一一对应：

```go
// CreateBreakpointArgs/CreateBreakpointReply 对应
// api.Client.CreateBreakpoint（ch9.2.22）
type CreateBreakpointArgs struct {
	Loc  string
	Cond string
	Name string
}

// CreateBreakpointReply 创建的断点（locspec 可解析出多个地址）
type CreateBreakpointReply struct{ Bps []api.Breakpoint }
```

**第 ⑥ 步：标准库把消息写进连接。** 这一步不在 `godbgv2` 里，在 `$GOROOT/src/net/rpc` 里，但值得知道它做了什么：

```go
// $GOROOT/src/net/rpc/client.go（标准库，非本书代码）
func (client *Client) Call(serviceMethod string, args any, reply any) error {
	call := <-client.Go(serviceMethod, args, reply, make(chan *Call, 1)).Done
	return call.Error
}
```

`Go` 分配一个递增的 `Seq`，把 `*Call{ServiceMethod, Args, Reply, Done}` 存进 `client.pending[seq]`，然后 `send` 用 gob 编码 `Request{Seq, ServiceMethod}` 和请求体，写到连接上；后台的 `input()` 协程不断读 `Response`，按 `Response.Seq` 从 `pending` 里找回对应的 `*Call`，gob 解码响应体到 `call.Reply`，最后 `call.Done <- call`。`Call` 因此是同步的：它只是在等自己的 `Done`。和早期实现不同，这里的编解码器是 gob 而不是 JSON，没有自研的方法表，也没有异步回调——服务端方法是被 `net/rpc` 反射调用的，不需要手工注册。

**第 ⑦⑧ 步：服务端解码并调用。** 服务端对象是 `serverImpl`，它只包一个门面指针；`NewServer` 把它注册成 `Debugger` 服务：

```go
type serverImpl struct {
	dbg *debugger.Debugger
}

func NewServer(dbg *debugger.Debugger) *rpc.Server {
	s := rpc.NewServer()
	if err := s.RegisterName("Debugger", &serverImpl{dbg: dbg}); err != nil {
		panic(err)
	}
	return s
}

func (s *serverImpl) CreateBreakpoint(args *CreateBreakpointArgs, reply *CreateBreakpointReply) error {
	bps, err := s.dbg.CreateBreakpoint(args.Loc, args.Cond, args.Name)
	reply.Bps = bps
	return err
}
```

能被 `net/rpc` 注册的方法要满足几条约定：方法名可导出（首字母大写）、恰好两个参数且都是指针、第二个参数充当响应、返回值只有一个 `error`。请求是否成功，就看这个 `error`；响应内容直接写进 `reply`——这也是为什么 `serverImpl` 的每个方法都长成一个样子：转调门面、填 reply、返回 err。

**第 ⑧⑨ 步：门面与目标层真正干活。** 门面（`pkg/service/debugger/debugger.go`）做三件事：检查有没有目标进程、把 locspec 交给 `proc.Target`、把内部断点类型翻译成契约类型：

```go
func (d *Debugger) CreateBreakpoint(loc, cond, name string) ([]api.Breakpoint, error) {
	if d.t == nil {
		return nil, fmt.Errorf("no debugged process")
	}
	bps, err := d.t.CreateBreakpointByLoc(loc, cond, name)
	if err != nil {
		return nil, err
	}
	out := make([]api.Breakpoint, len(bps))
	for i, bp := range bps {
		out[i] = toAPIBreakpoint(bp)
	}
	return out, nil
}
```

`proc.Target.CreateBreakpointByLoc`（`pkg/proc/location.go`）负责 locspec 到地址的解析与多地址处理：先校验断点名字（不能是纯数字、不能重名），再 `FindLocation` 把 `main.main` 解析成函数入口地址，然后对每个地址建一条逻辑断点；多个地址中的任意一个失败，就回滚已经建好的：

```go
addrs, err := t.FindLocation(loc)
if err != nil {
	return nil, err
}
if name != "" && len(addrs) > 1 {
	return nil, fmt.Errorf("breakpoint name %q cannot be used for %d locations", name, len(addrs))
}

bps := []*Breakpoint{}
for _, addr := range addrs {
	bp, err := t.createBreakpoint(addr, loc, UserBreakpoint)
	if err != nil {
		for _, created := range bps {
			_, _ = t.ClearBreakpoint(created.ID)
		}
		return nil, err
	}
	bp.Name = name
	bp.Cond = cond
	bps = append(bps, bp)
}
```

`FindLocation` 内部按 `locspec.Parse` 的结果分支：`funcname` 走 `FindFunction` 拿入口地址、`file:line` 走行号表反查、`/regexp/` 匹配多个函数、`*addr`/`+N`/`-N` 各有对应路径。`main.main` 属于第一种。

最后一层是目标层写断点指令（`pkg/target/breakpoint.go`）：`PTRACE_PEEKTEXT` 读出断点处的原始首字节存进 `Orig`，`PTRACE_POKETEXT` 把它替换成 `0xCC`（`int3`），同时在 `Breakpoints[addr]` 与 `BreakpointsByID[id]` 两张索引里登记。到这里，内核里的 tracee 内存被真的改掉了——**这是本次调用链上唯一一处改动 tracee 的操作**，前面所有环节都只是搬运。

**第 ⑩ 步：回程。** `serverImpl` 把 `[]api.Breakpoint` 填进 `reply`，`net/rpc` 用 gob 编码 `Response{Seq, Error:""}` 与响应体写回连接；客户端 `input()` 协程按 `Seq` 找到 `*Call`、解码到 `reply`、唤醒 `Call`；`rpc2.Client.CreateBreakpoint` 返回 `reply.Bps`；`breakCmd.RunE` 逐条打印 `breakpoint 1 added at 0x… (main.go:12)`。一次完整的往返到此结束，会话循环回到 `liner.Prompt`。

**错误路径同样要过一遍 RPC，而且会丢掉错误身份。** 假设某个流程对没有物理断点的地址调用 `Client.RestoreInstruction(addr)`（`step` 越过断点时就会这么做）：服务端 `target.DebuggedProcess.RestoreInstruction` 找不到地址对应的断点，返回 `api.ErrBreakpointNotExisted`；`net/rpc` 跨进程只能传字符串，于是客户端收到的是一个 `rpc.ServerError("breakpoint not existed")`——内容对、类型错，`err == api.ErrBreakpointNotExisted` 直接不成立，`cmd/debug/step.go` 里那句

```go
if err := Client.RestoreInstruction(addr); err != nil {
	if err == api.ErrBreakpointNotExisted {
		// PC-1 处不是断点，直接单步
```

的分支就永远走不到。解决办法是客户端按消息还原哨兵（`pkg/service/rpc2/client.go`）：

```go
// translateErr 将服务端错误还原为契约哨兵错误。
//
// net/rpc 跨进程传输错误时只保留错误消息、不保留错误同一性，
// 客户端按消息还原哨兵，保证 api.Client 契约在 RPC 模式下依然成立
// （cmd/ 层对哨兵的判等——如 step/continue 对
// api.ErrBreakpointNotExisted 的 == 比较——依赖这一点）。
func translateErr(err error) error {
	if err != nil && err.Error() == api.ErrBreakpointNotExisted.Error() {
		return api.ErrBreakpointNotExisted
	}
	return err
}
```

这个话题还有一个诚实的补充：`translateErr` 只包裹了少数几个方法——`ClearBreakpoint`、`SetBreakpointCondition`、`ToggleBreakpoint`、`ListSource`、`SetVariable`、`RestoreInstruction`；像 `CreateBreakpoint`、`Continue`、`ReadRegs` 这样的方法没有包裹，错误只以字符串形态透传。原因很实际：只有 `cmd/` 层真的用 `==` 判等哨兵的地方，才需要还原；而漏掉一处，就会出现"本地模式走得到、RPC 模式走不到"的分支。

**同一往返的另一副面孔：`funcs main.*`。** 这条命令的链路比 `break` 短得多，但形状不同，正好用来理解"快照语义"：`funcsCmd.RunE` 只做一次 `Client.ListFunctions()`，拿回全部函数（`[]api.Function`，按入口地址升序），然后在客户端用正则过滤、打印：

```go
fns, err := Client.ListFunctions()
if err != nil {
	return err
}
for _, fn := range fns {
	if !re.MatchString(fn.Name) {
		continue
	}
	info := fmt.Sprintf("%s %#x", fn.Name, fn.Entry)
	if fn.DeclFile != "" {
		info += fmt.Sprintf(" (%s:%d)", fn.DeclFile, fn.DeclLine)
	}
	fmt.Println(info)
}
```

对应的 RPC 是 `Debugger.ListFunctions`，请求体是空的 `ListFunctionsArgs{}`，响应体是 `ListFunctionsReply{Fns []api.Function}`。这里没有分页、没有迭代器、没有"先返回前 100 个再拉下一页"的流式接口——一次调用返回完整快照，过滤放在客户端。这正是铁律 3 的直观体现，也是 `ListFunctions` 被当作 9.2.01 这一节（"api 增加符号层能力入口"）代表方法的原因。

把这几次调用整理成一张对照表，`api.Client` 的一个方法如何落到 RPC 就一目了然：

| 契约方法 | RPC 方法名 | 请求结构 | 响应结构 |
| --- | --- | --- | --- |
| `CreateBreakpoint(loc, cond, name)` | `Debugger.CreateBreakpoint` | `CreateBreakpointArgs{Loc, Cond, Name}` | `CreateBreakpointReply{Bps []api.Breakpoint}` |
| `ListFunctions()` | `Debugger.ListFunctions` | `ListFunctionsArgs{}` | `ListFunctionsReply{Fns []api.Function}` |
| `RestoreInstruction(addr)` | `Debugger.RestoreInstruction` | `RestoreInstructionArgs{Addr}` | `RestoreInstructionReply{}` |
| `Continue()` | `Debugger.Continue` | `ContinueArgs{}` | `ContinueReply{Stop *api.StopInfo}` |

`Continue` 这一行值得多看一眼：它是全同步的——服务端 `debugger.Continue` 一直等到 tracee 停下来才返回 `*api.StopInfo`，客户端的 `Call` 也就一直阻塞。所以这一版没有"状态变化事件推给前端"的机制，前端也不需要处理"正在运行"的中间态。

#### 能力边界：这一版没有的东西

把 godbgv2 与 delve 对照，能更清楚地划定本节的边界。以下能力在 godbgv2 里**不存在**，读代码时不要去找：

- **没有 JSON-RPC**。传输层就是标准库 `net/rpc` 的默认 gob 编码，没有 JSON 编解码、没有自研的请求/响应封装，也没有手写的方法分派表；服务端方法是 `net/rpc` 反射调用的。
- **没有 `cmd/dlv` 那样的 `cmds` 包**。delve 用 `DebugCommands` + `callContext` + `cmdfunc` 自己管理会话内命令，理由是 cobra 的 `Run(fset, args)` 签名表达不了命令对 client、frame 的依赖。godbgv2 反过来：仍然用 cobra 管理调试命令，依赖通过包级 `Client` 注入（`cmd/debug/shell.go` 的 `var Client api.Client`），代价是要自己处理 flag 复位这类问题（见 `resetFlags`）。两条路线各有取舍，但不要用前者的模型去套后者的代码。
- **没有 `TargetGroup`**。`debugger.Debugger` 只有一个 `t *proc.Target` 字段，一次会话只对应一个目标进程；不支持多进程/多目标切换。
- **没有流式状态 channel**。`Continue()`、`StepOut()` 都是"阻塞到停止再返回快照"，没有把停止事件、输出、断点命中推给前端的通道，也没有异步回调。
- **没有多客户端**。代码里没有 `--accept-multiclient` 之类的开关，没有客户端注册表，也没有会话隔离。`net/rpc` 的 `Server.Accept` 确实会为每个入连接起一个协程服务，但所有连接共享同一个 `debugger.Debugger`，因此不能当作"多人联合调试"特性来用。
- **没有 DAP**。没有 `godbg dap`，也没有任何 DAP 编解码；VSCode 集成不在这一版的范围内。

除此之外，还有一些"小一号"的边界，写在这里免得读者试了半天找不到：`core` 命令是桩（`cmd/core.go` 直接返回错误）；没有 `--allow-non-terminal-interactive`、`--redirect` 这类 dlv 选项；没有 `restart` 命令（目标层保留了 `Command`/`Args` 字段，只是命令层还没实现）；补全器只补命令名与别名，不补函数名、变量名（第5.4节讨论的补全能力只落地了一部分）；命令历史只存在内存里、不落盘；命令参数按空格切分，不支持引号。

### 本节小结

这一节我们拆开了 godbgv2 的调试会话，要点可以归纳成三句话：

1. **装配在 `main`，会话在 `cmd`。** `main.main` 用 `debugger.New()` + `service.WireLocal(dbg)` 建好进程内 RPC，把 `api.Client` 注入 `cmd.Client`；四个命令在 `RunE` 里建立目标进程（或远程连接），在 `PostRun` 里统一汇入 `cmd/session.go` 的 `startDebugSession`。
2. **会话本身只是一个循环加一棵命令树。** `DebugSession.Start` 分流出 `--init` 批量回放与交互 REPL（后者才创建 `liner`，以避免 `SIGTTOU`），每行输入经 `SetArgs` + `ExecuteC` 分发到具体命令的 `RunE`，`resetFlags` 负责让 pflag 回到默认状态；`exit` → `Stop` → 退出栈 → `debug.Cleanup` 是正常的收尾路径，而 Ctrl+C/Ctrl+D 目前会 panic，属于待修的已知问题。
3. **每条命令都是一次完整 RPC 往返。** `break main.main` 依次经过 locspec 解析、`Client.CreateBreakpoint`、`rpc.Client.Call`、gob 编解码、`serverImpl`、`debugger` 门面、`proc.Target`、`target` 的 `PTRACE_POKETEXT`，再把 `[]api.Breakpoint` 原路带回；本地模式与 headless 模式的差别只在传输介质，协议、消息对、服务端方法完全共用。

理解了这条主线和它的边界，再去看 9.2.11 起的各个命令实现，就会发现它们都只是在"命令层的一次调用"与"目标层的一次 ptrace"之间填充中间层——而会话循环、装配方式、RPC 往返这三件事，本节已经讲完了。
