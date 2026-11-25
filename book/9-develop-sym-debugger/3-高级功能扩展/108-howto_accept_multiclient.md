## 多客户端调试的设计与 godbgv2 改造点（未实现）

> **状态**：godbgv2 未实现（❌）。本节为扩展阅读，设计思路可迁移，代码不并入本仓。
> 能力状态以 `godbgv2/docs/FEATURE-MATRIX.md` 为准。

### 为什么需要多客户端调试

社区讨论 [Extend Delve backend RPC API to be able to make a Delve REPL front-end console in a IDE](https://github.com/go-delve/delve/issues/383) 时，有人反馈：调试会话进行中，第二个客户端（`dlv connect`）连上来会失败，报错是 "An existing connection was forcibly closed by the remote host."（书稿早期版本记录的报错原文）。delve 的维护者为此加了 `--accept-multiclient` 选项。

这个选项本身的代码量很小，但它对应的场景很实在：

1. 用 `godbg exec ./binary --headless --listen 127.0.0.1:4567` 起一个调试服务端，或者 `godbg attach <pid>` 跟踪一个已经在跑、启动参数不易重现的进程；
2. 换个终端 `godbg connect 127.0.0.1:4567` 开始调试；
3. 同时开着命令行和 IDE、编辑器插件，各用各的长处；
4. 调不动的时候叫同事一起看同一个会话；
5. 这一轮调试结束，但不想让被调试进程跟着结束，留着下一轮接着用。

这五条都指向同一件事：后端要能接受多个客户端连接，并且这些客户端面对的是同一个被调试进程。

**godbgv2 当前没有这个能力**：没有 `--accept-multiclient` 这个开关。delve 有；下面先讲清 delve 的两种模式，再讲 godbgv2 要改成什么样才谈得上支持。

### 单客户端 vs 多客户端（delve 的两种 headless 模式）

delve 的 `--accept-multiclient` 是根级持久开关（`cmd/dlv/cmds/commands.go:153`），只有和 `--headless` 同时用才有意义：

1. **单客户端模式**（`--headless`，不带 `--accept-multiclient`）
   - 服务器只接受一条连接；
   - 这条连接断开后，服务器收到 `DisconnectChan` 信号，调用 `server.Stop()`，进而 `Detach(kill)`：由调试器创建的进程被结束；
   - 适合一次性的调试会话。

2. **多客户端模式**（`--headless --accept-multiclient`）
   - 服务器持续 accept，每条连接各起一个 goroutine 服务；
   - 客户端可以独立连接、断开；
   - 所有客户端共享同一个 `debugger.Debugger`（断点、线程选择、进程状态都是同一份）；
   - 被调试进程一直活着，直到显式 `Detach` 或服务器退出。

两种模式的差别全部落在"接完一条连接之后，是 break 还是继续循环"，以及"客户端断开时，要不要把整个服务器收掉"。

实现上就是那个 `for` 循环（摘自 delve `service/rpccommon/server.go:135-161`，省略了连接鉴权与 DAP/JSON-RPC 分发）：

```go
go func() {
	defer s.listener.Close()
	for {
		c, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.stopChan:
				// We were supposed to exit, do nothing and return
				return
			default:
				panic(err)
			}
		}

		go s.serveConnectionDemux(c)
		if !s.config.AcceptMulti {
			break
		}
	}
}()
```

两个容易忽略的配套：

- 客户端断开时的处理也分叉。非 `AcceptMulti` 时，连接断开就把 `DisconnectChan` 关掉（`service/rpccommon/server.go:203-204`），主流程据此 `server.Stop()`；`AcceptMulti` 时只有显式 `Detach` 才关这个 channel（同文件 `:278-280`）。
- `--continue` 需要 `--accept-multiclient`（`commands.go:1085-1086`）；非 headless 模式下给出 `--accept-multiclient` 会被忽略并打印 `Warning accept-multi: ignored`（`commands.go:1091-1096`）—— 因为普通模式下终端客户端一退出，服务器就被 `Stop` 了，留着 accept 循环没有意义。

### godbgv2 现状：能连上多条连接，但只有一个会话

先看装配（节选，`main.go:34-51`）：

```go
dbg := debugger.New()
client, err := service.WireLocal(dbg)
...
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

关键点有三：

1. **整个进程只有一个 `*debugger.Debugger`**（`dbg`），本地模式和 headless 模式共用同一个实例。
2. **RPC 服务端只包了这一个实例**：`NewServer(dbg)` 注册的 `serverImpl{dbg: dbg}` 是单例（`pkg/service/rpc2/server.go:322-334`），每条连接调用的都是它。
3. **`Debugger` 里只有一个 `*proc.Target`**（`pkg/service/debugger/debugger.go:19-21`），而 `proc.Target` 只持有 `dbp`/`bi`/`bps`/`breaklets`/`selThread`/`selGoroutine` 这些**裸字段，没有锁**（`pkg/proc/target.go:11-20`）。

另外要澄清一个容易误读的点：`rpc2.NewServer(dbg).Accept(ln)` 调用的是标准库 `net/rpc` 的 `Server.Accept`，它是**无限循环**，每来一条连接就 `go ServeConn(conn)`，不会因为第一条连接建立而停下。也就是说，godbgv2 的 headless 服务端并不会拒绝第二条连接 —— 传输层本来就是多连接的。

**但这不等于支持多客户端调试。** 那些连接拿到的是同一个会话的多个句柄：

| 维度 | godbgv2 现状 |
|---|---|
| 传输层接受多条连接 | 有：`net/rpc.Server.Accept` 是无限循环 |
| 会话隔离 | 无：所有连接共用一个 `Debugger` / 一个 `proc.Target` |
| 断点与选择状态 | 无：全局唯一，A 的 `thread 3` 会改掉 B 看到的线程视图 |
| 并发安全 | 无：`proc.Target` 无锁，两条连接并发发 `continue` / `thread` 是数据竞争 |
| 生命周期 | 无：任一连接 `exit` 都会 `ClearAll` + `Kill`，见下文 |
| `--accept-multiclient` 开关 | 无 |

所以现状更接近"单客户端模式"，而且是**没有断开即停**语义的单客户端模式：客户端执行 `exit` 之后服务端继续 accept，但被调试进程已经被客户端那一次 `Cleanup` 杀掉了；如果是连接被强行掐断，杀进程这一步根本不会发生 —— 服务端和 tracee 一起留在原地，而"该由谁收尾"没有答案。

### 改造点

要把 godbgv2 做到"多客户端可调试"，核心不是 accept 循环 —— 那个已经在跑 —— 而是三件语义上的事。

#### 1. 从单例 `debugger.Debugger` 到连接级会话

目标结构是把"共享的调试目标"与"每连接的视图"分开（**示意**，godbgv2 尚未实现）：

```go
// 示意：共享一份目标，每连接一份会话视图
type Session struct {
	dbg *debugger.Debugger // 共享：一个 target、一套断点
	mu  sync.Mutex         // 串行化本连接发出的命令

	// 私有：这台客户端"看"的是哪根线程、哪个 goroutine
	selThread    *proc.Thread
	selGoroutine *proc.Goroutine

	owner bool // 是否是"启动该进程"的那条连接
	gen   uint64 // 最后一次看到的目标状态版本
}
```

三个配套改动：

- `selThread` / `selGoroutine` 现在住在 `proc.Target` 里（`target.go:18-19`），必须挪到会话层（或按连接维护视图），否则 A 的切换会污染 B。断点表 `bps` 相反：断点属于被调试进程，应当共享 —— 但需要给每个断点记一个创建者，见第 3 点。
- `rpc2.NewServer(dbg)` 要改成"每连接一个 `serverImpl`，各自持有 `Session`"。这里有个 `net/rpc` 的硬约束：接收者方法拿不到连接身份，所以"按连接分会话"只能在**每条连接上各起一个 `rpc.Server`** —— 自己写 accept 循环，`rpc2.NewServer(session).ServeConn(conn)`，放弃 `net/rpc.Server.Accept` 这个帮助函数（它把同一个 `server` 复用到所有连接上）。另一条路是把 session id 塞进每个请求参数，侵入面更大、也更易错。
- 命令要在**跨连接**的层面上串行化。`net/rpc` 为每个请求起一个 goroutine，两个客户端同时 `continue` 会在同一个 `proc.Target` 上并发执行；`Session.mu` 只能保证本连接内部不并发，管不到别的连接。串行化点必须落在共享的 `debugger.Debugger` 上（一把大锁，或一条命令队列），再配一个 `gen` 版本号：目标状态被别的连接改过之后，本连接手里的 PC / 栈帧可能已经过期，至少要让 `bt`、`frame` 之类能判出"你看到的已经旧了"。

#### 2. 谁负责收尾被调试进程

现状的收尾发生在**客户端**：`cmd/session.go:32` 给会话挂了 `AtExit(debug.Cleanup)`，而 `debug.Cleanup`（`cmd/debug/exit.go:34-66`）会先 `ClearAll`，再按 `State().Kind` 决定 `Kill`（`debug` / `exec`）还是 `Detach`（`attach`）。

单客户端模型下这是对的：退出调试器 = 结束会话。多客户端模型下它立刻失效 —— **任何**一条连接执行 `exit`，都会把别人正在用的进程杀掉。更麻烦的是 headless 模式下这条连接可能只是来 `bt` 一下的旁观者。

改造方向：

- **所有权归创建者。** `Launch` 的那条连接是 owner，只有它（或服务端的显式指令）有权 `Kill`；其余连接 `exit` 只关闭自己的会话，不发 `Kill` / `ClearAll`。
- **收尾下沉到服务端。** 客户端退出不再直接决定进程命运；由 server 按"还有没有 owner 会话"来判断，全部结束后再统一 kill/detach。
- **headless 服务端要有自己的 finalizer。** 现在 `main.go:57-72` 的 `processSignals` 在收到 SIGTERM/SIGINT 时调 `debug.Cleanup()`，那套逻辑服务于本地模式；headless 时它同样能跑，但缺"所有客户端都走完后"这个触发点。
- **保留"断开但不杀"的表达。** delve 用 `quit -c` 表示"断开连接前让目标继续跑"（`pkg/terminal/command.go:400-404`）。godbgv2 若要支持多客户端，也得有一个等价物，否则"我只是断开一下"和"结束整个调试会话"无法区分。

#### 3. 一条连接的 `ClearAll` / `Kill` 会影响其他连接

这不是推测，是现在就能顺着调用链读出来的：

```text
客户端 exit
  → CurrentSession.Stop()
  → AtExit → debug.Cleanup()            (cmd/session.go:32)
  → Client.ClearAll()                   (cmd/debug/exit.go:40)
  → serverImpl.ClearAll                 (pkg/service/rpc2/server.go:458-460)
  → dbg.ClearAll()                      (pkg/service/debugger/debugger.go:145-150)
  → d.t.ClearAll()                      ← 单例 target 的断点表
```

`Kill` 同理，一路到底就是 `syscall.Kill(pid, SIGKILL)`（`pkg/target/process.go:252-257`）。在单连接场景里这只是"退出时清理"，在多连接场景里就是"把别人的调试现场拆了"。

可选治理方案，从最小改动排起：

| 方案 | 做法 | 代价 |
|---|---|---|
| A. 权限门 | 非 owner 连接调用 `Kill` / `ClearAll` / `Detach` 直接返回错误，要另加一个强制参数才放行 | 改动最小，语义最直白 |
| B. 归属标签 | 断点记 creator session id，`ClearAll` 只清自己的；`Kill` 仍只允许 owner | 要动 `Breakpoint` 结构与所有断点列表的输出格式 |
| C. 单写者令牌 | 同时只有一条连接持有"控制权"，其余只读；控制权可显式转让 | 语义最接近"协作调试"，但要加状态机与 UI 反馈 |

起步建议选 **A + owner 概念**：先把"谁能杀、谁能清"定下来，再谈 B。C 属于锦上添花，且很容易做成半吊子（没收权成功的读操作会看到不一致状态）。

### 注意事项

这些是 delve 侧已经暴露出来的边界，godbgv2 若照此实现也会遇到：

1. **API 非重入。** 多客户端并不等于可以并发调用：客户端之间需要协调，避免两个 `continue` 同时打进去。delve 用调试器层的一把锁（`service/debugger/debugger.go:69` 的 `targetMutex`）串行化对目标的访问，而不是让 API 变成可重入。
2. **模式限制。** `--accept-multiclient` 只在 headless 下成立；非 headless 给这个开关会被忽略（delve 会打 warning）。
3. **断开语义要显式。** 默认断开就结束会话，保留进程需要额外表达（delve 是 `quit -c`）。
4. **安全。** accept 多个连接意味着同一台机器上的其他用户也能连。delve 默认开启 `--only-same-user`（配置项 `CheckLocalConnUser`，`cmd/dlv/cmds/commands.go:163`），只允许同用户连接；godbgv2 只做 `net.Listen("tcp", listenAddr)`，没有任何鉴权。真要做多客户端，鉴权不是可选项。

### 本节小结

`--accept-multiclient` 在 delve 里只是"accept 循环别 break"这一行判断，但它背后是一整套会话语义：谁拥有目标进程、谁有权结束它、共享状态怎么串行化、断开的含义是什么。

**godbgv2 目前没有多客户端支持**：所有连接共享同一个 `debugger.Debugger` 单例，`proc.Target` 的断点与线程选择是全局的，而且没有任何并发保护；客户端一 `exit` 就会把服务端持有的 tracee 杀掉。把它补上需要三件事 —— 连接级会话、进程收尾的所有权、`Kill`/`ClearAll` 的越权约束 —— 这三件都不是加一个 flag 能解决的，所以本节定位为设计说明：思路可以迁移，代码不并入本仓。
