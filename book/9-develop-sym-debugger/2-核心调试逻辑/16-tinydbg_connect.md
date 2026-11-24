## Connect

### 实现目标: `godbg connect <addr>`

本节介绍 `godbg connect` 与它的另一半——headless 服务端模式。先把两个角色分清，本节后面的内容都建立在这个区分上：

- **`connect <addr>` 是客户端命令**：新建一个 RPC 客户端，连上已经在运行的调试服务端，然后进入交互式会话；
- **`--headless` 是服务端模式，不是一条独立命令**：它是根命令的持久 flag（`cmd/root.go:43`），挂在 `exec`/`attach`/`debug` 上，让这些命令建立好 target 之后**不进 REPL**，转而监听网络、只做 RPC 服务端。

```bash
$ godbg help connect
连接 headless 调试服务端（ch9.2.16）

Usage:
  godbg connect <addr> [flags]

Flags:
  -h, --help   help for connect

Global Flags:
      --headless            headless 模式：作为调试服务端运行（ch9.2.16）
      --init string         startup script file to replay (batch mode)
      --listen string       headless 模式的监听地址（ch9.2.16） (default "127.0.0.1:0")
```

输出有删节：`Global Flags` 里另有 `--log`/`--log-output`/`-v` 三行。`Flags:` 段只有 `-h`，说明 connect 没有自己的选项——`--listen` 给服务端用、`--init` 给会话回放用，二者都来自根命令，出现在这里只是因为持久 flag 会被所有子命令继承。connect 之后能用哪些命令？就是 9.2 节其余小节介绍的那批 `cmd/debug` 命令，一条都不新增：换掉的只是 `api.Client` 的实现，这就是本节要讲清的全部内容。

### 基础知识

#### 三个角色、三种装配

godbg 只有一套前端代码（`cmd/`）和一套后端代码（`pkg/service/debugger`），中间隔着 `pkg/service/api.Client` 接口。谁来把它们连起来，由 `main.go` 和 `pkg/service/wire.go` 决定：

| 模式 | 装配入口 | 传输介质 | 服务端在哪 |
|---|---|---|---|
| 本地（默认） | `service.WireLocal(dbg)`（`wire.go:15`） | `net.Pipe` + `listenerPipe` | 同一进程 |
| headless 服务端 | `cmd.ServeHeadless`（`main.go:43`） | `net.Listen("tcp", ...)` | 同一进程，但对外服务 |
| 远程客户端 | `service.WireRemote(addr)`（`wire.go:28`） | `rpc.Dial("tcp", addr)` | 另一个进程 |

三者共用同一套 `rpc2.Server` / `rpc2.Client`、同一个服务名、同一批消息结构，**本地与远程的差别只有底层那个 `net.Conn`**——这是本节最该记住的一句话。本地模式看起来绕：同一个进程里为什么不直接调 `*debugger.Debugger`？因为 `rpc2.Server` 只认 `net.Conn`，`rpc.Server.Accept` 只认 `net.Listener`。`listenerpipe.go` 用一个 `net.Pipe()`（返回两条内存直接对接的 `net.Conn`）加一个容量为 1 的 channel 造出"监听器+连接"这对东西，让本地模式原样复用远程模式的代码；也正因容量为 1，本地只能连接一次，正好对应"一进程一客户端"。

#### 本地链路与远程链路的对照

```text
本地: cmd/debug ─► api.Client ─► rpc2.Client ─► net.Pipe ⇄ listenerPipe ─► rpc2.Server ─► debugger.Debugger
远程: 进程B(connect) ─► api.Client ─► rpc2.Client ─► tcp conn ─► 进程A(headless) 的 rpc2.Server ─► 同一个 debugger.Debugger
```

#### net/rpc 的几条约定

1. 方法签名必须是 `func (t *T) Method(args *Args, reply *Reply) error`：两个参数都是指针、都必须是导出结构体（gob 只编解码导出字段），返回值只有 error；
2. 注册名决定调用名：`RegisterName("Debugger", ...)` 加方法 `Continue`，客户端写的就是字符串 `"Debugger.Continue"`；
3. 编解码是 gob，不是文本协议：请求头（`ServiceMethod`、`Seq`）与请求体各 gob 编码一次，响应同理。

由此推出第 4 条不太直观的约定：**net/rpc 回传 error 时只带消息、不带类型**。服务端把 `err.Error()` 那串字符串塞进响应，客户端拿到的是 `rpc.ServerError`（`type ServerError string`）。而 `cmd/debug/step.go:47` 与 `continue.go:64` 是拿 `err == api.ErrBreakpointNotExisted` 判等的，不处理的话这个判等跨 RPC 之后永远为 false——step/continue 会把"PC-1 处不是断点"这种正常情况当成调试器内部错误。这就是 `rpc2/client.go:238` 里 `translateErr` 存在的理由：

```go
func translateErr(err error) error {
	if err != nil && err.Error() == api.ErrBreakpointNotExisted.Error() {
		return api.ErrBreakpointNotExisted
	}
	return err
}
```

`RestoreInstruction`、`ClearBreakpoint`、`ToggleBreakpoint`、`SetBreakpointCondition`、`SetVariable`、`ListSource` 六个方法都过一遍 `translateErr`，因为服务端 `pkg/target/breakpoint.go:142` 等处会把 `api.ErrBreakpointNotExisted` 原样返回。

#### 为什么本地也要绕一圈 RPC

`docs/ARCH-RULES.md` 的铁律 1–4 就是为这一节写的：后端只搬数据不打印、只传可序列化结构、快照语义、`cmd/` 只依赖 `pkg/service/api`。这些约束把前后端彻底解耦，代价是本地多一次 gob 编解码和一次内存拷贝。第 9.2.16 节要把调试器切到 headless 架构，兑现方式就是"本地模式也走进程内 RPC"：切换时 `cmd/` 一行都不用改，只换 `api.Client` 的具体实现。

> 实现说明：本节上一版以 tinydbg（delve 分支）为参考实现，那套 connect 链路与本节描述的 godbgv2 装配并非同一套；本节按 godbgv2 现状重写，凡与代码不符处一律以代码为准。

### 代码实现

#### 1. 根命令 flag 与 main 注入

`cmd/root.go:43-44` 注册两个持久 flag：`--headless`（默认 false）与 `--listen`（默认 `127.0.0.1:0`）。默认值有讲究：只监听回环地址、端口交给内核分配，启动后把实际地址打印出来，免得手动规划端口。`main.go:43-51` 把服务端装配注入 `cmd` 层（`main` 内的一段，缩进照原文保留）：

```go
	cmd.ServeHeadless = func(listenAddr string) error {
		ln, err := net.Listen("tcp", listenAddr)
		if err != nil {
			return err
		}
		fmt.Printf("godbg headless server listening on %s\n", ln.Addr())
		rpc2.NewServer(dbg).Accept(ln)
		return nil
	}
```

这里的 `dbg` 就是 `main` 开头 `debugger.New()` 建的那个实例：**headless 并不新建后端，它把本进程已有的 Debugger 暴露到网络上**，这一点直接决定了后文的"多客户端共享单例"。另外 `Accept(ln)` 是阻塞调用，headless 进程就停在这一行。

#### 2. 触发点：startDebugSession

`cmd/session.go:21-27` 是唯一的分叉点：`startDebugSession` 先读 `--headless`，为真就取 `--listen` 调 `ServeHeadless` 并 `return`，为假才启动本地 REPL。而它是 `exec`（`exec.go:43`）、`attach`（`attach.go:49`）、`debug`（`debug.go:73`）、`connect`（`connect.go:29`）四条命令的 `PostRun`。由此有两个推论：

- **headless 必须先有 target**：`exec` 的 `RunE` 已经成功 `Client.Launch(...)`，才轮到 `PostRun` 起监听；所以 `godbg --headless` 单独跑不会起服务端——根命令没有 `Run`，只会打印 help；
- headless 分支 `return` 掉，本地 REPL 不启动，进程从此是纯服务端。

#### 3. 装配：wire.go

`pkg/service/wire.go` 全文只有两个函数（下段删去注释与 import）：

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

func WireRemote(addr string) (api.Client, error) {
	cli, err := rpc.Dial("tcp", addr)
	if err != nil {
		return nil, err
	}
	return rpc2.NewClientFrom(cli), nil
}
```

两个函数的返回值都是 `api.Client`，调用方拿到的类型完全一样，区别只在中间那层：本地 `net.Pipe`，远程 `tcp`。`WireLocal` 里 `go server.Accept(ln)` 必须开 goroutine，否则 `Accept` 会把 `main` 堵死；`WireRemote` 不需要 goroutine，因为它没有本地服务端。

#### 4. 服务端：RegisterName 与 Accept

```go
func NewServer(dbg *debugger.Debugger) *rpc.Server {
	s := rpc.NewServer()
	if err := s.RegisterName("Debugger", &serverImpl{dbg: dbg}); err != nil {
		panic(err)
	}
	return s
}
```

`serverImpl` 的每个方法都是一层薄壳（`rpc2/server.go:323-623`）：例如 `RestoreInstruction` 就是一行 `return s.dbg.RestoreInstruction(args.Addr)`。消息对在同一个文件里成组声明：`ContinueArgs struct{}` 与 `ContinueReply struct{ Stop *api.StopInfo }`、`ReadRegsArgs struct{ Tid int }` 与 `ReadRegsReply struct{ Regs *api.Registers }`——`api.Client` 的多参数多返回值，到这里被摊平成"一个 Args 加一个 Reply"。

`rpc.Server.Accept(ln)` 每接受一个连接就 `go ServeConn(conn)`，所以**连接可以有很多条**；但所有连接共用注册时那一个 `serverImpl`，也就共用同一个 `dbg`。这就是"没有多客户端语义"的根因。

#### 5. 客户端：Dial、Call 与 connect 命令

`rpc2.Client` 只是 `*rpc.Client` 的包装（`client.go:13-28`），`NewClientFrom` 就是 `&Client{c: c}`；每个契约方法对应一次 `Call`：

```go
func (c *Client) Continue() (*api.StopInfo, error) {
	var reply ContinueReply
	err := c.c.Call("Debugger.Continue", &ContinueArgs{}, &reply)
	return reply.Stop, err
}
```

`Call` 是同步阻塞的：gob 编码请求、写连接、等响应、解码到 `reply`，服务端处理完才返回。所以 `continue` 看起来"卡住"，不是前端在算，而是在等远端的下一次停止事件。还有一点：`rpc.Dial` 里没有协议握手，它只是 `net.Dial("tcp", addr)` 再包一层 `NewClient`，所以 `connected to ...` 只证明 TCP 通了，不证明对面是 RPC 服务端；地址写错或端口没人监听则在 dial 阶段就失败。

`cmd/connect.go:11-31` 是客户端侧的全部代码（节选，删去 `Long` 与 import/init）：

```go
var connectCmd = &cobra.Command{
	Use:   "connect <addr>",
	Short: "连接 headless 调试服务端",
	RunE: func(cmd *cobra.Command, args []string) error {
		if len(args) != 1 {
			return fmt.Errorf("usage: connect <addr>")
		}
		client, err := service.WireRemote(args[0])
		if err != nil {
			return err
		}
		Client = client
		fmt.Printf("connected to %s\n", args[0])
		return nil
	},
	PostRun: func(cmd *cobra.Command, args []string) {
		startDebugSession(cmd)
	},
}
```

两个细节：参数校验用 `len(args) != 1`，而 cobra 在 `RunE` 返回错误后不执行 `PostRun`，所以参数缺失时不会误入会话；`Client = client` 换掉的是 `cmd` 包的包级变量，之后 `cmd/debug` 下所有命令自动改走远程——**cmd 层一行都没改**，这就是架构铁律的验收点。会话也在 `PostRun` 里才启动：连接成功才开会话。

### 执行测试

ch9.2.16 没有配套的 smoke 脚本（`docs/FEATURE-MATRIX.md` §11⑤）。下面是本机实跑摘录：服务端与客户端各一个进程，客户端命令用 `--init` 回放（回放输出同样带 `godbg> ` 前缀）；环境为 linux/amd64、go1.24.13，二进制名做了归一化，被调试程序用 `-gcflags="all=-N -l"` 编译，pid 与断点地址会随环境和二进制变化：

```bash
# 终端 A：先建立 target，再以服务端模式监听
$ go build -o godbg . && ./godbg exec ./dbg924 --headless --listen 127.0.0.1:41234
process 1876662 launched, stopped by SIGTRAP
godbg headless server listening on 127.0.0.1:41234
```

```bash
# 终端 B：连接并调试（下面几行由 --init 回放产生）
$ ./godbg connect 127.0.0.1:41234
connected to 127.0.0.1:41234
godbg> break main.main
breakpoint 1 added at 0x4b1b20
godbg> continue
thread 1876662 status: stopped: trace/breakpoint trap
stop all threads now
continue ok
godbg> exit
tracee is run by tracer, kill it
```

`exit` 那一行值得留意：connect 会话退出时同样走 `AtExit` 注册的 `Cleanup`，而 `Cleanup` 里全是 `Client.*` 调用，所以它作用在**远端**——本例 Kind 为 exec，远端 tracee 被 kill；若是 attach 则改为 detach。服务端进程本身不受影响，仍停在自己的 `Accept` 里。

会话继承根命令的 `--init`，可脚本化验证，也方便观察"单例共享"：

```bash
$ ./godbg connect 127.0.0.1:41234 --init init.txt    # init.txt 内容：breakpoints / exit
connected to 127.0.0.1:41234
godbg> breakpoints
no breakpoints
godbg> exit
tracee is run by tracer, kill it
```

第二个客户端看到 `no breakpoints`：上一条客户端退出时在远端 `ClearAll` 掉了断点，两条连接看到的是同一个 `Debugger` 的同一份状态。失败路径同样直接：

```bash
$ ./godbg connect 127.0.0.1:45871        # 端口无人监听
Error: dial tcp 127.0.0.1:45871: connect: connection refused
$ ./godbg connect unix:/tmp/godbg.sock    # 不支持 unix domain socket
Error: dial tcp: lookup tcp//tmp/godbg.sock: unknown port
$ ./godbg connect                         # 缺少参数
Error: usage: connect <addr>
```

### 本节小结

本节讲了两件事：connect 是客户端，headless 是服务端模式，二者之间是一条 `net.Conn`。

- **装配位置决定形态**：本地是 `WireLocal` 用 `net.Pipe` + `listenerPipe` 造出进程内链路，headless 是 `net.Listen("tcp", ...)` 造出真实链路，connect 是 `rpc.Dial("tcp", addr)` 接上去；三者之上跑的是同一套 `rpc2.Server`/`rpc2.Client`，所以"本地/远程"不是两套代码，而是同一套代码的两种装配；
- **RPC 细节**：`rpc.NewServer()` + `RegisterName("Debugger", &serverImpl{})` 决定方法名，`Accept`/`ServeConn` 负责分发，gob 负责编解码；服务端 error 只有消息能过网，`translateErr` 把 `api.ErrBreakpointNotExisted` 还原成哨兵，契约里的 `==` 判等才成立；
- **headless 不是命令**：它只是根命令的持久 flag，由 `exec`/`attach`/`debug` 的 `PostRun` 触发，因此必须先有 target。

能力边界（当前实现明确不做的部分）：

| 边界 | 具体表现 |
|---|---|
| 只支持 TCP | 服务端 `net.Listen("tcp", ...)`、客户端 `rpc.Dial("tcp", addr)`；`unix:` 前缀会被当成非法 TCP 地址 |
| 无多客户端语义 | `Accept` 能为多条连接各开一个 `ServeConn`，但全部共享同一个 `debugger.Debugger` 单例，没有 `--accept-multiclient`，一条连接上的 `ClearAll`/`Kill` 会直接影响其他连接 |
| 不能远程 launch/attach | 协议层有 `Debugger.Launch`/`Debugger.Attach`，但 connect 的会话只挂载 `cmd/debug` 的交互命令，没有把它们暴露成前端命令；target 只能在服务端进程启动时建立 |
| 无 DAP | 只有本节描述的这套自研 RPC，DAP 在 9.2.00 的 ps 段已声明为范围决策 |

后续若要做多客户端，要解决的不是"能不能接多条连接"（`Accept` 本来就支持），而是"一条连接上的调试动作如何不干扰另一条"——会话隔离、状态所有权，以及谁来收尾被调试进程。
