## 调试会话：脚本回放与清理善后

6.1~6.3 节，我们已经学会了三种发起调试的方式：exec 启动并跟踪现成的二进制，attach 跟踪运行中的进程，debug 现编译现调试。它们做完准备工作后，都会进入同一个交互式调试会话——这个会话在 5.7 节搭骨架时已经介绍过（liner 读输入、cobra 分发命令、按分组展示 help），这里不再重复。

但交互式输入在有些场景下并不好用：命令一多，逐条手敲又慢又容易出错；自动化测试、冒烟测试没法靠人肉输入；复盘某个调试过程时，希望把步骤存成脚本一键回放。gdb 有 `-x/--command` 选项，dlv 支持 starlark 脚本，godbg 对应的能力就是本节实现的 `--init <file>`：启动调试会话时，把文件里的调试命令逐条回放一遍。

本节配套代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.4`，`git diff ch6.3 ch6.4` 可以看到这一节改了什么。

### 实现目标：`--init <file>` 启动时回放调试脚本，会话退出时统一善后

`--init` 是 rootCmd 上的持久选项（persistent flag），exec、attach、debug、core 都支持：

```bash
./godbg exec _fixtures/loop --init ./testdata/script/ch6.4.txt
./godbg attach <pid> --init ./init.txt
./godbg debug ./examples/debuggee/ --init ./init.txt
```

指定 `--init` 后，会话不再是交互模式，而是批量模式（batch mode）：逐行读脚本、逐条执行，全部回放完自动退出。脚本里每一行是一条调试命令，`#` 开头的行为注释。

回放模式还有个重要用途：支撑 godbgv2 的冒烟测试机制（scripts/smoke.sh + testdata/script 下的用例），书里每个小节的示例命令都可以用脚本固化下来、自动验证输出（`make smoke S=ch6.4`），保证书里写的命令和代码的真实行为一致。这套机制的完整说明见 godbgv2 的 docs/SMOKE-HARNESS.md，本节只介绍 godbg 侧的回放引擎。

### 代码实现

#### rootCmd 增加 --init 选项

`cmd/root.go` 里给 rootCmd 挂上持久选项，这样所有启动命令（及其子命令）都能识别 `--init`：

```go
func init() {
    rootCmd.PersistentFlags().BoolP("verbose", "v", false, "show verbose info")
    rootCmd.PersistentFlags().String("init", "", "startup script file to replay (batch mode)")
    rootCmd.AddCommand(versionCmd)
}
```

#### 统一的会话装配：cmd/session.go

ch6.3 之前，exec/attach/debug/core 的 PostRun 里各自写着两行：

```go
debug.CurrentSession = debug.NewDebugSession()
debug.CurrentSession.Start()
```

本节把它们统一收进 `startDebugSession`：读 `--init`，创建会话并注册退出善后（下一小节展开），设置了脚本就回放，没设置就交互。四个启动命令的 PostRun 都改为调用它：

```go
package cmd

import (
    "github.com/hitzhangjie/godbgv2/cmd/debug"
    "github.com/spf13/cobra"
)

// startDebugSession 装配并启动交互式调试会话。
//
// 各进程级命令（exec/attach/debug/core）在成功建立起调试会话后
// 统一经由本函数进入交互模式；指定 --init 脚本时进入批量回放模式。
func startDebugSession(cmd *cobra.Command) {
    initFile, _ := cmd.Flags().GetString("init")

    debug.Client = Client
    // 会话退出（含 --init 批量回放结束）时，按调试发起方式统一善后：
    // exec/debug 启动的进程杀掉，attach 的进程 detach。
    debug.CurrentSession = debug.NewDebugSession().AtExit(func() {
        debug.Cleanup(Client)
    })
    if initFile != "" {
        debug.CurrentSession.SetInitFile(initFile)
    }
    debug.CurrentSession.Start()
}
```

以 exec 为例，PostRun 从原来的两行缩成一行 `startDebugSession(cmd)`；debug 的 PostRun 保留删除构建产物的 defer，会话启动也换成同一个函数。

#### 会话退出善后：按 Kind 杀进程或 detach

会话能回放了，还有一个 6.1 节遗留的问题要一起收掉：调试器退出时，被调试进程怎么办？

- exec/debug 启动的 tracee 是调试器创建的，调试器退出后如果不管它，内核会解除跟踪关系让它继续跑（6.1 节"运行效果"里见过 loop 跑起来）。通常我们期望调试结束时把这类 tracee 一起终止；
- attach 跟踪的是原本就在运行的用户进程，调试器退出时必须 detach，把控制权还给用户，绝不能把它杀掉。

两种处理方式取决于调试发起方式。为了让交互模式 `exit`、`--init` 批量回放结束、以及后续信号退出都能走到同一套清理逻辑，godbgv2 用 `DebugSession.AtExit` 注册清理函数（AtExit 在 5.7 节搭骨架时已经写好）。

先给 `api.Client` 补两个方法：`State` 返回当前会话状态（pid + Kind），`Kill` 终止 tracee：

```go
// State 当前调试会话状态
type State struct {
    PID  int  // 被调试进程 pid
    Kind Kind // 调试发起类型
}

type Client interface {
    Launch(kind Kind, cmd string, args ...string) (int, error)
    // State 返回当前调试会话状态
    State() (*State, error)
    // Kill 终止被调试进程
    Kill() error
    Attach(pid int) error
    Detach() error
}
```

目标层加 `Kill`（SIGKILL 对处于 ptrace 停止状态的进程同样生效，不需要先 detach）：

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

门面层把 `State`/`Kill` 转给目标层（略，见 `pkg/service/debugger/debugger.go`）。然后是清理函数 `Cleanup`，按 Kind 分派：

```go
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

`startDebugSession` 把它注册进会话的 AtExit（见上面那段代码）。`exit` 命令只负责 `CurrentSession.Stop()`，真正的清理由 AtExit 在 `Start` 返回时执行；批量模式回放结束、`Start` 返回时同样会走到这里，所以 `--init` 回放结束也会自动善后。

6.10 节会在此基础上继续扩展：退出前先 `ClearAll` 还原所有断点（本节还没有断点命令），并把信号退出（SIGINT/SIGTERM）也纳入清理。

#### 会话回放引擎：cmd/debug/shell.go

`cmd/debug/shell.go` 的改动有五处：

1. `DebugSession` 增加两个字段：`initFile`（启动脚本路径）、`stopped`（会话是否已请求结束）：

```go
type DebugSession struct {
    liner  *liner.State
    last   string

    initFile string // 会话启动时要回放的脚本文件（非交互模式）
    stopped  bool   // 会话是否已请求结束

    defers []func()
}
```

2. `SetInitFile` 链式设置脚本路径：

```go
// SetInitFile 设置会话启动时要回放的脚本文件（非交互模式）
func (s *DebugSession) SetInitFile(file string) *DebugSession {
    s.initFile = file
    return s
}
```

3. `Start` 里如果 initFile 非空，先回放脚本，回放完 `liner.Close()` 退出，不再进入读输入的主循环：

```go
func (s *DebugSession) Start() {
    s.liner.SetCompleter(completer)
    s.liner.SetTabCompletionStyle(liner.TabPrints)

    defer func() {
        for idx := len(s.defers) - 1; idx >= 0; idx-- {
            s.defers[idx]()
        }
    }()

    // 回放 init 脚本，回放结束后退出会话
    if s.initFile != "" {
        if err := s.replay(s.initFile); err != nil {
            fmt.Fprintf(os.Stderr, "replay init file %s error: %v\n", s.initFile, err)
        }
        s.liner.Close()
        return
    }

    // ...（读输入的主循环不变，执行命令统一走 s.execute(txt)）
}
```

4. `replay` 逐行处理脚本：

```go
// replay 逐行回放脚本中的调试命令：
// '#' 为注释；'!' 与 '=' 是冒烟测试脚本的宿主指令（由
// scripts/smoke.sh 处理），会话回放时跳过。
func (s *DebugSession) replay(file string) error {
    f, err := os.Open(file)
    if err != nil {
        return err
    }
    defer f.Close()

    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        line := strings.TrimSpace(scanner.Text())
        if line == "" ||
            strings.HasPrefix(line, "#") ||
            strings.HasPrefix(line, "!") ||
            strings.HasPrefix(line, "=") {
            continue
        }

        fmt.Printf("godbg> %s\n", line)

        if err := s.execute(line); err != nil {
            return err
        }
        if s.stopped {
            return nil
        }
    }
    return scanner.Err()
}
```

5. 抽出 `execute` 统一执行命令，并在执行后复位 flag 状态：

```go
// execute 执行一行调试命令，并在执行后复位命令的 flag 状态。
//
// REPL 始终复用同一棵 cobra 命令树，pflag 在多次 Parse 之间不会把上一次
// 设置过的 flag 恢复为默认值：本次命令行里没出现的 flag 会保留上一行的
// 值。统一在 execute 里复位，交互模式和 --init 回放才能保证每条命令都从
// 默认 flag 状态开始执行。
func (s *DebugSession) execute(line string) error {
    s.root.SetArgs(strings.Split(line, " "))
    cmd, err := s.root.ExecuteC()
    if cmd != nil {
        resetFlags(cmd)
    }
    return err
}

// resetFlags 把本次执行改过的 flag 恢复为默认值。
// ExecuteC 内部的 ParseFlags 已经合并继承的 persistent flag，因此 VisitAll
// 能同时覆盖本地 flag 和父命令继承下来的 flag。
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

`Start` 和 `replay` 原本各自重复 `SetArgs + Execute`，这里收敛成 `execute`，并在每条命令执行后把它改过的 flag 复位。核心目的只有一个：同一个调试会话里，上一条命令解析出的命令的选项值不会残留到下一次命令执行。复位只作用于 REPL 内部的 `debugRootCmd` 命令树。

要点：

- 回放脚本里的空行、`#` 注释行跳过；
- `!` 与 `=` 是冒烟测试脚本的宿主指令，由 scripts/smoke.sh 解析执行（`!` 是 shell 命令，`=` 是输出断言），godbg 回放时跳过；
- 其余行按空格切成命令与参数，交给 `s.execute` 执行；每行回显成 `godbg> ...`，方便对照输出；
- `exit` 等命令执行后会把 `s.stopped` 置位（`Stop` 里置位），回放提前结束。

### 运行效果

ch6.4 的冒烟脚本内容很简单：回放 help、断言输出、回放 exit：

```text
# ch6.4 smoke: 验证调试会话可脚本化回放（--init 批量模式），退出时善后
help
=godbg interactive debugging commands
=\[breaks\]
=\[execute\]
=\[info\]
exit
# 会话退出（含批量回放结束）时按 Kind 善后：exec 启动的 tracee 被 kill
=tracee is run by tracer, kill it
```

手工执行一遍：

```bash
git checkout ch6.4
make build
make fixtures
./godbg exec _fixtures/loop --init ./testdata/script/ch6.4.txt
process 31674 launched, stopped by SIGTRAP
godbg> help
godbg interactive debugging commands

help [command]
  -h, --help   help for help

[breaks]
  ...（分组展示，与 5.7 节一致）
godbg> exit
tracee is run by tracer, kill it
```

每条回放的命令都带 `godbg>` 前缀回显，与交互模式下的观感一致；help 的输出和 5.7 节演示的一致；exit 之后会话结束，AtExit 注册的 `Cleanup` 运行，输出 `tracee is run by tracer, kill it`，exec 启动的 tracee 被终止。如果入口换成 attach，这里就会变成 detach，目标进程继续运行。

用冒烟测试跑一遍：

```bash
make smoke S=ch6.4
smoke: running testdata/script/ch6.4.txt
smoke: all passed
```

`make smoke` 会先构建调试器与 fixtures，再驱动 `scripts/smoke.sh` 用 `--init` 回放脚本并逐条核对输出，全部通过。

### 本节小结

本节给调试会话加上了脚本化回放能力：

- 新增 `--init <file>` 持久选项，exec/attach/debug/core 都支持，指定后会话进入批量模式：逐行回放脚本后自动退出；
- 把四个启动命令 PostRun 里重复的会话装配统一收进 `cmd/session.go` 的 startDebugSession；
- 会话回放引擎与交互模式共用同一条命令执行路径，`#` 注释、`!`/`=` 宿主指令由脚本与 smoke.sh 协作处理；
- 命令统一经 `DebugSession.execute` 执行，每次执行后复位本次改过的 flag，避免上一行的 `-n` 等选项残留到下一行；
- 回放模式支撑了 godbgv2 的冒烟测试机制（docs/SMOKE-HARNESS.md），书中的示例命令自此可以固化、自动验证；
- 会话退出善后：`startDebugSession` 通过 `AtExit` 注册 `Cleanup`，按调试发起方式决定 kill（exec/debug）还是 detach（attach）；`api.Client` 增加 `State`/`Kill`，目标层增加 `Kill`。交互模式 `exit` 与 `--init` 批量回放结束都会触发同一套清理，冒烟脚本里可以直接断言这段输出。

至此，6.1~6.4 覆盖了发起调试的三种方式（exec/attach/debug）、调试会话的脚本化回放，以及基础的会话退出善后。从 6.5 节开始，我们进入调试会话内部，逐个实现真正的调试命令，第一个是 `disass` 反汇编。
