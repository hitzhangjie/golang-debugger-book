## 软件动态断点：退出前清理机制

### 问题背景：断点残留的危害

在调试器开发过程中，我们通过ptrace系统调用对目标进程的指令进行动态修改来实现动态软件断点。具体来说，断点的添加是通过将目标地址的指令字节替换为0xCC（int3指令）来实现的，同时需要备份原始指令字节以便后续恢复。

调试器与tracee的关系存在多种场景：

- 通过 `debug` 编译构建并启动构建好的程序；
- 通过 `exec` 启动已经构建好的程序；
- 通过 `attach`跟踪正在运行中的进程。

对于前两种情况，调试器退出时通常会主动终止tracee；而对于 `attach`场景，调试器退出后时一般会倾向于恢复tracee的执行。

然而，如果调试器在退出前没有主动清理这些动态添加的断点，将会给被调试进程造成严重的不良影响：

1. **指令不完整**：多字节指令被patch后变成不完整的指令序列
2. **SIGTRAP信号**：当tracee执行到断点位置时，会触发SIGTRAP信号
3. **进程终止**：SIGTRAP的默认动作是终止进程并产生core dump。Go程序更特殊一些：runtime自己接管了SIGTRAP，在没有tracer的情况下会把`int3`当成运行时崩溃，打印goroutine栈后退出

我们必须足够重视这个问题，需要实现一个类似C语言atexit的机制，在调试器退出前自动清理所有断点。

本节配套代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.10`，`git diff ch6.9 ch6.10` 可以看到这一节的改动。其中 `api.Client` 方法顺序调整、`State` 从 `client.go` 搬到 `types.go`、门面方法重新排序属于代码整理，本节只展开与退出清理直接相关的实现。

### 实现目标：自动断点清理

为了避免上述问题，我们需要在调试器退出前自动清理所有已添加的断点。这要求我们：

1. **跟踪所有断点**：维护一个全局的断点集合，记录所有已添加的断点信息
2. **自动清理机制**：在调试会话结束时，自动遍历并清理所有断点
3. **优雅退出**：确保tracee进程在调试器退出后能够继续正常运行

### 代码实现

我们通过实现一个类似C语言 `atexit`的机制来实现自动断点清理。改动集中在四处：会话的 `AtExit` 机制、`Cleanup` 的善后逻辑、会话启动时的注册，以及信号退出路径上的显式调用。

#### 1. DebugSession结构体扩展

```go
type DebugSession struct {
	// ... 其他字段
	defers []func()
}

// AtExit 注册退出会话时要执行的清理函数（后注册先执行）
func (s *DebugSession) AtExit(fn func()) *DebugSession {
	s.defers = append(s.defers, fn)
	return s
}
```

#### 2. 启动方法中的defer机制

```go
func (s *DebugSession) Start() {
	s.liner.SetCompleter(completer)
	s.liner.SetTabCompletionStyle(liner.TabPrints)

	defer func() {
		for idx := len(s.defers) - 1; idx >= 0; idx-- {
			s.defers[idx]()
		}
	}()

	// ... 其他启动逻辑
}
```

`Start` 是会话的主循环，`exit` 命令只负责调用 `Stop()` 让循环返回，真正的清理由这个 `defer` 完成。`--init` 脚本回放结束时同样从 `Start` 返回，所以批量模式也会清理。按 `defers` 逆序执行，与 C 语言 `atexit` 的“后注册先执行”一致。

`defer` 能覆盖正常返回和 panic 展开，但覆盖不了 `os.Exit`。信号处理恰好走的是 `os.Exit` 路径，这也是后面要单独处理信号的原因。

#### 3. 断点清理函数

`Cleanup` 放在 `cmd/debug/exit.go`，完整实现如下：

```go
// Cleanup 清理调试会话：还原全部断点，并按调试发起方式对被调试进程
// 善后处理——
//
//   - debug/exec: 被调试进程由调试器创建，杀掉；
//   - attach:     被调试进程原本独立运行，分离使其继续运行。
//
// 构建产物的删除由 cmd 层的 debug 命令自行处理（会话结束后移除）。
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

这段实现的关键点有三处：

- **通过 `api.Client` 操作后端**：`ClearAll`、`State`、`Kill`、`Detach` 都走接口，`cmd/debug` 不直接依赖 `pkg/target`，既符合分层约定，也让 `main.go` 的信号处理可以直接调用 `Cleanup`；
- **先还原断点，再处理进程**：顺序不能反，先 detach 可能让 target 撞上残留断点。之后按 Kind 善后——debug/exec 直接 `Kill`（SIGKILL 对处于 ptrace 停止状态的进程同样有效，不必先 detach），只有 attach 才 `Detach`；
- **入口先做防护**：`Client == nil` 或 `State()` 出错都直接返回，避免在没有调试进程时访问空指针。

旧实现里的 `fallthrough` 会让 debug 分支把同一个进程 kill 两次；构建产物 `__debug_bin__` 的删除也移到了 `cmd/debug.go` 的 `PostRun`，`Cleanup` 只负责断点和进程。

需要说明的是，ch6.10 的 `ClearAll` 只还原指令字节，还没有回退停在断点处线程的 PC（留到 6.17.5）。本节场景中 target 停在启动位置或 attach 后的 SIGSTOP，没有线程停在断点上，不受影响。

#### 4. 调试会话的创建和使用

会话启动时把 `Cleanup` 注册进去。`cmd/session.go` 的 `startDebugSession` 是所有进程级命令（exec/attach/debug/core）进入交互模式的统一入口：

```go
debug.Client = Client
// 会话退出（含 --init 批量回放结束）时，统一清理被调试进程
debug.CurrentSession = debug.NewDebugSession().AtExit(debug.Cleanup)
if initFile != "" {
	debug.CurrentSession.SetInitFile(initFile)
}
debug.CurrentSession.Start()
```

`exit` 命令本身不清理，只结束循环：

```go
Run: func(cmd *cobra.Command, args []string) {
	// 退出前清理在 Cleanup 中完成（会话退出时经 AtExit 调用）
	CurrentSession.Stop()
},
```

`Stop` 关闭 `done` channel，`Start` 的 `select` 看到后返回，注册的 `defers` 才依次执行。把清理放在会话层而不是 `exit` 命令里，`--init` 回放结束、以及将来其他结束会话的路径都能复用同一套逻辑。

#### 5. 信号退出路径

`Start` 的 `defer` 有一个覆盖不到的场景：进程收到 `SIGTERM`、`SIGINT`、`SIGQUIT`。`main.go` 的信号处理直接用 `os.Exit` 结束进程，不会等 `Start` 返回，因此必须显式调用一次 `Cleanup`：

```go
func processSignals() {
	ch := make(chan os.Signal, 16)
	signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT, syscall.SIGQUIT, syscall.SIGURG)

	for sig := range ch {
		switch sig {
		case syscall.SIGURG:
			// go 运行时异步抢占信号，忽略
		case syscall.SIGTERM, syscall.SIGINT, syscall.SIGQUIT:
			// 清理被调试进程后退出：还原断点，并按 Kind 决定 kill 或 detach。
			// 注意：此处直接 os.Exit，不会触发会话的 AtExit 清理，
			// 因此需要显式调用 Cleanup。
			debug.Cleanup()
			os.Exit(1)
		}
	}
}
```

`signal.Notify` 收到 `SIGINT` 后不会让进程按默认动作退出，信号被转到 `processSignals` 的 channel，所以这里是清理被调试进程的最后机会。清理完成后再 `os.Exit(1)`，`SIGURG` 则是 Go runtime 的异步抢占信号，必须忽略。

### 测试用例

测试对象是 godbgv2 自带的 `_fixtures/loop`。它每秒打印一次 pid 和循环计数，正好用来观察调试器退出后 target 是否还在运行：

```go
func main() {
	pid := os.Getpid()
	for i := 0; ; i++ {
		fmt.Printf("pid: %d, loop: %d\n", pid, i)
		time.Sleep(time.Second)
	}
}
```

切到本节代码并构建：

```bash
$ git checkout ch6.10
$ make build
$ make fixtures
$ go tool nm _fixtures/loop | grep ' main.main$'
  4b3940 T main.main
```

`main.main` 的循环体从 `0x4b3971`（`main.main+0x31`）开始，每轮都会执行，适合作为 attach 场景的断点地址。入口地址 `0x478120` 只在程序启动时执行一次，attach 上去以后不会再命中，所以下文的 attach 示例用 `0x4b3971`，exec 示例用 `0x478120`。

attach 示例把 target 作为 godbg 的子进程启动后再 attach，满足 Linux Yama `ptrace_scope=1` 下“tracer 必须是 tracee 的祖先”的限制。如果运行环境已经放开了 ptrace 限制，也可以直接在另一个终端执行 `godbg attach <pid>`。

#### 场景一：不还原断点的后果

先看反例。godbgv2 在 ch6.9 的退出逻辑只做 detach，不还原断点。切到那一节构建，attach 到运行中的 `loop`，在循环体上添加断点后退出：

```bash
$ git checkout ch6.9
$ make build && make fixtures
$ bash -c './_fixtures/loop > /tmp/loop.out 2>&1 & exec ./godbg attach $!'
process 2231841 attached, stopped by SIGSTOP
godbg> break 0x4b3971
breakpoint 1 added at 0x4b3971
godbg> exit
tracee is an attached process, leave it running
```

调试器退出后，target 继续运行，一秒之内就会走到 `0x4b3971`，执行那里残留的 `0xCC`：

```bash
$ cat /tmp/loop.out
pid: 2231841, loop: 0
SIGTRAP: trace trap
PC=0x4b3972 m=0 sigcode=128

goroutine 1 gp=0xc000002380 m=0 mp=0x5736a0 [running]:
main.main()
	/tmp/godbgv2-ch6.9/examples/debuggee/loop.go:16 +0x32 fp=0xc0000c2f78 sp=0xc0000c2ee0 pc=0x4b3972
...
[process exited]
```

两个细节值得注意：

- `PC=0x4b3972` 正好是断点地址 `0x4b3971` 的下一条指令。`int3` 执行后 PC 已经后移，而 ch6.9 既没有还原指令，也没有回退 PC；
- 此时 tracer 已经 detach，SIGTRAP 没有接收者。Go runtime 接管了 SIGTRAP，把它当成运行时崩溃，打印 goroutine 栈后终止进程。如果是没有接管 SIGTRAP 的程序，内核会按默认动作直接终止它并产生 core dump。

这就是退出前必须清理断点的原因。

#### 场景二：exec 启动，退出时还原并杀掉

回到 ch6.10，用 `exec` 启动 target，在入口地址添加断点后退出：

```bash
$ git checkout ch6.10
$ make build && make fixtures
$ ./godbg exec _fixtures/loop
process 2232027 launched, stopped by SIGTRAP
godbg> break 0x478120
breakpoint 1 added at 0x478120
godbg> exit
tracee is run by tracer, kill it
```

`exit` 只调用 `Stop()`，真正的清理发生在 `Start` 的 `defer` 中：`Cleanup` 先调用 `Client.ClearAll()`，把 `0x478120` 处的原始字节写回；再由 `State()` 读到 `KindExec`，调用 `Client.Kill()` 发送 SIGKILL。进程是调试器创建的，杀掉即可，不需要先 detach。

`godbg debug` 启动的 target 走 `KindDebug` 分支，处理方式相同；会话结束后 `cmd/debug.go` 的 `PostRun` 还会删除构建出的 `__debug_bin__`。

#### 场景三：attach 运行中的进程，退出时还原并 detach

同样的 target，这次以 attach 方式调试，并在每轮都会执行的循环体地址上下断点：

```bash
$ bash -c './_fixtures/loop > /tmp/loop.out 2>&1 & exec ./godbg attach $!'
process 2232045 attached, stopped by SIGSTOP
godbg> break 0x4b3971
breakpoint 1 added at 0x4b3971
godbg> exit
tracee is an attached process, leave it running
```

退出后查看 target 的输出：

```bash
$ tail -f /tmp/loop.out
pid: 2232045, loop: 0
pid: 2232045, loop: 1
pid: 2232045, loop: 2
pid: 2232045, loop: 3
pid: 2232045, loop: 4
```

`loop: 0`、`loop: 1` 是 attach 之前打印的，`loop: 2` 之后是 `exit` 之后的输出。计数继续增长，说明两件事都成立：

- `0x4b3971` 处的 `0xCC` 已经换回原指令，target 再次执行到这里不会触发 SIGTRAP；
- target 已经脱离 ptrace，可以在没有 tracer 的情况下独立运行。

如果这里的 `Cleanup` 只 detach 不还原断点，就会得到场景一的结果。

#### 场景四：Ctrl+C 退出

`processSignals` 收到 `SIGTERM`、`SIGINT`、`SIGQUIT` 后直接调用 `Cleanup()`，再 `os.Exit(1)`。在会话期间按 Ctrl+C：

```bash
$ ./godbg exec _fixtures/loop
process 2232434 launched, stopped by SIGTRAP
godbg> break 0x478120
breakpoint 1 added at 0x478120
godbg> ^C
tracee is run by tracer, kill it
```

信号路径 `processSignals` 里显式清理，否则如果是kind attach，调试器直接 `os.Exit(1)` 会让断点残留留在 target 里，如果下次命中断点会导致场景一的结果。

### 本节小结

本节主要探讨了调试器退出前断点清理机制的重要性与实现方法，核心内容包括：**断点残留的危害性分析**；**SIGTRAP信号导致的进程终止问题**；**AtExit机制的实现原理**；**自动断点清理的代码实现**。

本节核心要点包括：

- 断点通过ptrace修改指令字节实现，如果不清理会导致多字节指令不完整，执行时触发SIGTRAP信号
- 没有tracer接收SIGTRAP时，Go runtime会打印崩溃栈后退出，其他程序则由内核按默认动作终止
- 通过实现类似C语言atexit的机制，在调试会话退出前自动清理所有断点，确保tracee进程能够继续正常运行
- ch6.10 的 `ClearAll` 只还原指令字节，尚未回退停在断点处线程的 PC，这部分留到 6.17.5 处理

本节内容为调试器的健壮性设计提供了重要保障，确保调试器在各种退出场景下都能正确清理资源，为读者理解调试器的生命周期管理和资源清理机制奠定了实践基础。通过本节的学习，读者可以掌握调试器开发中资源管理的最佳实践，为后续开发更复杂的调试器功能提供了重要的设计参考。
