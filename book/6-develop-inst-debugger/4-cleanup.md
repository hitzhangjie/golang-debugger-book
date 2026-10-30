## 结束调试时进程清理

6.1~6.3 节，我们已经学会了三种发起调试的方式：exec 启动并跟踪现成的二进制，attach 跟踪运行中的进程，debug 现编译现调试。它们做完准备工作后，都会进入同一个交互式调试会话——这个会话在 5.7 节搭骨架时已经介绍过（liner 读输入、cobra 分发命令、按分组展示 help），这里不再重复。

交互式会话里输入 `exit` 就能结束调试，但调试器退出之后，被调试进程怎么办？这个问题在 6.1 节就留下了 `TODO`，三种启动方式对应的答案并不相同。本节把它收掉，作为几种启动方式之后紧跟着的一个完善动作。

本节配套代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.4`，`git diff ch6.3 ch6.4` 可以看到这一节改了什么。

### 实现目标：会话退出时按调试发起方式清理善后

先看调试器退出时内核会做什么：

- exec/debug 启动的 tracee 是调试器创建的。调试器退出后如果不管它，内核会解除跟踪关系让它继续跑（6.1 节"运行效果"里见过 loop 跑起来）。通常我们期望调试结束时把这类 tracee 一起终止；
- attach 跟踪的是原本就在运行的用户进程。调试器退出时必须 detach，把控制权还给用户，绝不能把它杀掉。

所以清理动作必须区分调试发起方式，也就是会话建立时记录的 `Kind`：

| Kind | 发起方式 | 退出时 |
| --- | --- | --- |
| `KindExec` | `godbg exec` | kill tracee |
| `KindDebug` | `godbg debug` | kill tracee，并删除构建产物 |
| `KindAttach` | `godbg attach` | detach tracee，让它继续运行 |

为了让交互模式 `exit`、以及后续的信号退出、批量回放结束都能走到同一套清理逻辑，godbgv2 用 `DebugSession.AtExit` 注册清理函数（`AtExit` 在 5.7 节搭骨架时已经写好），并把四个启动命令的 `PostRun` 统一收进 `startDebugSession`。

### 代码实现

#### 统一的会话装配：cmd/session.go

ch6.3 之前，exec/attach/debug/core 的 `PostRun` 里各自写着两行：

```go
debug.CurrentSession = debug.NewDebugSession()
debug.CurrentSession.Start()
```

本节把它们统一收进 `startDebugSession`：创建会话，注册退出善后，然后启动。四个启动命令的 `PostRun` 都改为调用它：

```go
package cmd

import (
	"github.com/hitzhangjie/godbgv2/cmd/debug"
	"github.com/spf13/cobra"
)

// startDebugSession 装配并启动交互式调试会话。
//
// 各进程级命令（exec/attach/debug/core）在成功建立起调试会话后
// 统一经由本函数进入交互模式。
func startDebugSession(cmd *cobra.Command) {
	// 会话退出时，按调试发起方式统一善后：
	// exec/debug 启动的进程杀掉，attach 的进程 detach。
	debug.CurrentSession = debug.NewDebugSession().AtExit(func() {
		debug.Cleanup(Client)
	})
	debug.CurrentSession.Start()
}
```

以 exec 为例，`PostRun` 从原来的两行缩成一行：

```go
	PostRun: func(cmd *cobra.Command, args []string) {
		// 会话退出时统一善后，见 session.go
		startDebugSession(cmd)
	},
```

debug 命令的 `PostRun` 保留删除构建产物的 `defer`，会话启动也换成同一个函数；attach、core 同理。

> ps：上述代码取自 hitzhangjie/godbgv2 的 tag `ch6.4`，其中 `startDebugSession` 是本节新增，四个 `PostRun` 的改动只涉及会话装配。

#### 会话退出善后：按 Kind 杀进程或 detach

要让 `Cleanup` 知道当前会话的 pid 和 Kind，先给 `api.Client` 补两个方法：`State` 返回当前会话状态，`Kill` 终止 tracee：

```go
// State 当前调试会话状态
type State struct {
	PID  int  // 被调试进程 pid
	Kind Kind // 调试发起类型
}

// Client 是前端与后端交互的唯一入口。
//
// 第6章它由进程内的 debugger 门面（pkg/service/debugger）实现；
// 第9.2.16节引入 headless RPC 后，本地模式切换为进程内 RPC 客户端，
// cmd/ 下的代码无需任何改动。接口方法随章节推进逐步补充，
// 第9.1.3节（Service 层设计）冻结完整接口。
type Client interface {
	// Launch 启动并跟踪一个进程，返回被调试进程 pid
	Launch(kind Kind, cmd string, args ...string) (int, error)
	// State 返回当前调试会话状态
	State() (*State, error)
	// Kill 终止被调试进程
	Kill() error
	// Attach 跟踪一个正在运行的进程
	Attach(pid int) error
	// Detach 结束调试，分离被调试进程
	Detach() error
}
```

`debugger` 门面把 `State`/`Kill` 转给目标层（完整代码见 `pkg/service/debugger/debugger.go`）。目标层新增 `Kill`：SIGKILL 对处于 ptrace 停止状态的进程同样生效，不需要先 detach：

```go
// Kill 终止被调试进程。
//
// SIGKILL 对处于 ptrace 停止状态的进程同样生效，无需先 detach。
func (p *DebuggedProcess) Kill() error {
	if !checkPid(p.Process.Pid) {
		return fmt.Errorf("process %d not existed", p.Process.Pid)
	}
	return syscall.Kill(p.Process.Pid, syscall.SIGKILL)
}
```

最后是清理函数 `Cleanup`，按 Kind 分派：

```go
// Cleanup 按调试发起方式对被调试进程善后处理——
//
//   - debug/exec: 被调试进程由调试器创建，杀掉；
//   - attach:     被调试进程原本独立运行，分离使其继续运行。
//
// 构建产物的删除由 cmd 层的 debug 命令自行处理（会话结束后移除）。
func Cleanup(client api.Client) {
	if client == nil {
		return
	}

	st, err := client.State()
	if err != nil {
		return
	}

	switch st.Kind {
	case api.KindDebug:
		fmt.Println("tracee is built and run by tracer, remove binary and kill it")
		if err := client.Kill(); err != nil {
			fmt.Fprintf(os.Stderr, "kill tracee: %d, err: %v\n", st.PID, err)
		}
	case api.KindExec:
		fmt.Println("tracee is run by tracer, kill it")
		if err := client.Kill(); err != nil {
			fmt.Fprintf(os.Stderr, "kill tracee: %d, err: %v\n", st.PID, err)
		}
	case api.KindAttach:
		fmt.Println("tracee is an attached process, leave it running")
		if err := client.Detach(); err != nil {
			fmt.Fprintf(os.Stderr, "detach tracee: %d, err: %v\n", st.PID, err)
		}
	}
}
```

`startDebugSession` 把它注册进会话的 `AtExit`（见上面那段代码）。`exit` 命令只负责 `CurrentSession.Stop()`，真正的清理由 `AtExit` 在 `Start` 返回时执行：

```go
	Run: func(cmd *cobra.Command, args []string) {
		// 退出前清理在 Cleanup 中完成（会话退出时经 AtExit 调用）
		CurrentSession.Stop()
	},
```

> ps：上述代码取自 hitzhangjie/godbgv2 的 tag `ch6.4`。`State`/`Kill` 是本节新增的契约与目标层能力，`Cleanup` 放在 `cmd/debug/exit.go`，与 `exit` 命令相邻。

要点：

- `Cleanup` 只依赖 `api.Client`，不关心底层是本地门面还是后续的 RPC 客户端；
- attach 场景调用 `Detach` 而不是 `Kill`，这是"绝不能杀掉用户进程"的直接体现；
- debug 场景的构建产物不归 `Cleanup` 管，仍由 `debug` 命令自己的 `defer os.RemoveAll(BuildExecName)` 删除；
- 批量回放结束、信号退出等路径，只要最终都经过 `DebugSession.Start` 返回，就能自动走到 `AtExit` 注册的清理逻辑。

### 运行效果

先确认代码版本并构建：

```bash
git checkout ch6.4
make build
make fixtures
```

exec 启动的 tracee 由调试器创建，退出时被终止：

```bash
$ ./godbg exec _fixtures/loop
process 223108 launched, stopped by SIGTRAP
godbg> exit
tracee is run by tracer, kill it
```

`exit` 之后会话结束，`AtExit` 注册的 `Cleanup` 运行，exec 启动的 tracee 被 SIGKILL 终止。

attach 跟踪的是用户进程，退出时只 detach：

```bash
$ ./_fixtures/loop > /tmp/loop.out 2>&1 &
$ echo $!
287585
$ ./godbg attach 287585
process 287585 attached, stopped by SIGSTOP
godbg> exit
tracee is an attached process, leave it running
$ kill -0 287585 && echo alive
alive
```

这里输出的是 `leave it running`，而且 detach 之后目标进程仍然存活，可以被其他工具继续 attach，或者由用户自己结束。

debug 启动的 tracee 同样被终止，构建产物也一并删除：

```bash
$ ./godbg debug ./examples/debuggee/
process 223341 launched, stopped by SIGTRAP
godbg> exit
tracee is built and run by tracer, remove binary and kill it
$ ls __debug_bin__
ls: cannot access '__debug_bin__': No such file or directory
```

`__debug_bin__` 由 `debug` 命令的 `PostRun` 在会话结束后删除；tracee 则由 `Cleanup` 按 `KindDebug` 终止。两条清理路径各管各的，互不越界。

### 本节小结

本节把三种启动方式退出时的善后统一了起来：exec/debug 启动的 tracee 杀掉，attach 的 tracee detach；调试器不退出跟踪关系、不误杀用户进程。清理只在 `startDebugSession` 一处注册，`exit`、后续的信号退出、批量回放结束都会复用同一套逻辑。

第 6.11 节会在此基础上继续扩展：退出前先 `ClearAll` 还原所有断点（本节还没有断点命令），并把信号退出（SIGINT/SIGTERM）也纳入清理。下一节 6.5 先给调试会话加上脚本回放与完整的冒烟测试机制，为后面每一节的示例提供可重复验证的手段。
