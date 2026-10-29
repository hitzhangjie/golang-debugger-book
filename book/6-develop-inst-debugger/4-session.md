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

指定 `--init` 后，会话进入批量模式（batch mode）：逐行读脚本、逐条执行调试命令，全部回放完自动退出。为什么要退出，因为这里的回放主要是配合冒烟测试，所以回放调试命令并输出结果后就执行结束，冒烟测试过程再判断执行结果是否符合预期。冒烟测试主要依赖驱动冒烟测试的脚本 godbgv2/scripts/smoke.sh，以及各条冒烟案例对应的脚本 testdata/script/*.txt。关于冒烟案例如何编写、整体的冒烟测试机制如何设计，本节稍后会讲到，细节以 godbgv2 的 [docs/SMOKE-HARNESS.md](https://github.com/hitzhangjie/godbgv2/blob/master/docs/SMOKE-HARNESS.md) 为准。

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
// '#' 为注释；以 '!' 或 '=' 开头的行是冒烟测试的宿主指令
// （shell 与断言，由 scripts/smoke.sh 处理），会话回放时跳过。
// 会话前指令与 @capture 的分工见本节冒烟设计，不在这里展开。
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
- 以 `!` 或 `=` 开头的行是冒烟脚本的宿主指令，这段回放不执行。`!=` 也以 `!` 开头，因此不会被当成调试命令；smoke 在宿主侧把 `!=` 认成反向断言，把其余的 `!` 认成 shell。`@` 开头的指令，大部分都是 smoke.sh 侧的指令，除了 `@capture` 这条特殊的会话内指令，该指令主要用于会话内才能动态获取的数据，方便动态生成下条调试命令；
- 其余行按空格切成命令与参数，交给 `s.execute` 执行；每行回显成 `godbg> ...`，方便对照输出；
- `exit` 等命令执行后会把 `s.stopped` 置位（`Stop` 里置位），回放提前结束。

### 冒烟测试：整体方案设计

冒烟测试机制，是为了能确保在书籍内容、代码频繁修改过程中，书中的示例和 godbgv2 的设计实现、实际运行效果能始终保持一致，或者说能尽早暴露不符合预期的修改。不管是作者本地修改，还是 CI 过程中，都会先跑相同的冒烟测试机制，通过后才能将最新修改合入。

冒烟测试机制（smoke harness）的实现，核心主要包括：

- 冒烟用例，godbgv2/testdata/script/*.txt，每个章节的示例代码变更都会新增对应的冒烟用例，用例文件中包含了输入调试命令和期望的结果输出；
- 回放器，godbgv2 通过 `--init` 来指定要读取的冒烟用例，支持在会话内回放冒烟用例的调试命令，并给出输出结果；
- 驱动器，godbgv2/scripts/smoke.sh，它定义了冒烟用例中可用的命令，包括起进程、延迟执行、发起调试、校验输出等。冒烟测试通过 smoke.sh + 冒烟用例发起，由回放器回放调试命令拿到输出，由 smoke.sh 再判断输出是否符合预期。

本书将在这一节一次性介绍清楚冒烟测试机制的设计实现，后续章节对应代码中仅需增加冒烟测试用例文件即可。

#### 冒烟测试用例：指令集合

下面这些是已经定稿的全集。后面的章节只是选用，不再发明新的一类。

- 调试命令：和交互会话里敲的一样，由回放器执行；
- `#`：注释。smoke 和回放都忽略；
- `!`：宿主 shell。只由 `scripts/smoke.sh` 执行，回放跳过。需要在会话外看一眼进程、文件或环境时用它；
- `=` 与 `!=`：断言，只由 smoke 核对。它们绑定最近一条 godbg 命令的输出：`=` 要求匹配，`!=` 要求不匹配。前面命令已经打出来的文本不参加这一条断言。`!=` 开头的行是反向断言，其余以 `!` 开头的行才是宿主 shell；
- `@spawn`、`@attach`、`@exec`：会话开始前，由 smoke 把调试器和被调试进程对上，选择调试器以哪种入口接进去；
- `@delay`：会话开始前的等待，由 smoke 处理启动时序；
- `@skip-if`：条件成立时，smoke 跳过整条用例，回放不会把它当成调试命令；
- `@set`：会话开始前的设置，由 smoke 在拉起 godbg 之前写入。此时还没有调试命令可以替换；
- `@capture`：会话内。回放器替换进后续调试命令，smoke 替换进断言。

`@set` 在会话前，`@capture` 在会话内。前者准备的是这次运行的环境，后者留下的是会话已经跑起来之后、输出里出现的值。参数、替换记号和条件的写法都在 SMOKE-HARNESS.md 里，这里不展开。

#### 冒烟测试用例：示例文件

6.4 节对应的冒烟用例是 `testdata/script/ch6.4.txt`，内容如下：

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

这条用例先回放 `help`，并用 `=` 断言输出里会出现交互命令的总标题，以及 `[breaks]`、`[execute]`、`[info]` 这几个命令分组；接着回放 `exit`，结束这次调试会话；最后再断言退出时的善后日志 `tracee is run by tracer, kill it`，也就是 exec 启动的 tracee 会在会话结束时被杀掉。用例不长，它守住的是「调试会话可以按脚本回放，并且退出时会按 Kind 做善后」。

后续各个章节只要涉及示例代码，一般都会新增一份对应的冒烟测试用例文件。冒烟驱动器 `scripts/smoke.sh` 和会话内的回放器，必需的代码在本节已经基本完全实现；后面主要是增加用例文件，而不是再改这一套机制。

### 运行效果

ch6.4 的冒烟脚本只用了上面那套约定里最小的一块：注释、调试命令，以及对最近一条命令输出的 `=` 断言。`@spawn`、`@capture` 这些留给后面确实需要换启动方式或捕获中间结果的小节，类别已经在本节定好了。脚本内容是回放 help、断言输出、回放 exit：

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

`make smoke` 会先构建调试器与 fixtures，再驱动 `scripts/smoke.sh`：调试命令经 `--init` 回放，`=` 按最近一条 godbg 命令的输出核对。本地和 CI 走的是同一套脚本。全部通过。

### 本节小结

本节主要探讨了调试会话的脚本回放、冒烟测试机制，以及调试结束时的退出前清理机制，本节内容为后面各节调试命令的设计实现打下了可重复验证的基础。

至此，6.1~6.4 覆盖了发起调试的三种方式（exec/attach/debug）、调试会话的脚本化回放、基础的会话退出善后，以及全书共用的冒烟测试设计。从 6.5 节开始，我们进入调试会话内部，逐个实现真正的调试命令，第一个是 `disass` 反汇编；对应该节的冒烟脚本会跟着示例一起出现，harness 不再另讲。
