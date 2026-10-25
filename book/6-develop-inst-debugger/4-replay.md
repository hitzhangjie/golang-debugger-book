## 调试会话：--init 脚本回放

6.1~6.3 节，我们已经学会了三种发起调试的方式：exec 启动并跟踪现成的二进制，attach 跟踪运行中的进程，debug 现编译现调试。它们做完准备工作后，都会进入同一个交互式调试会话——这个会话在 5.7 节搭骨架时已经介绍过（liner 读输入、cobra 分发命令、按分组展示 help），这里不再重复。

但交互式输入在有些场景下并不好用：命令一多，逐条手敲又慢又容易出错；自动化测试、冒烟测试没法靠人肉输入；复盘某个调试过程时，希望把步骤存成脚本一键回放。gdb 有 `-x/--command` 选项，dlv 支持 starlark 脚本，godbg 对应的能力就是本节实现的 `--init <file>`：启动调试会话时，把文件里的调试命令逐条回放一遍。

本节配套代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.4`，`git diff ch6.3 ch6.4` 可以看到这一节改了什么。

### 实现目标：`--init <file>` 启动时回放调试脚本

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

本节把它们统一收进 `startDebugSession`：读 `--init`，创建会话，设置了脚本就回放，没设置就交互。四个启动命令的 PostRun 都改为调用它：

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

    debug.CurrentSession = debug.NewDebugSession()
    if initFile != "" {
        debug.CurrentSession.SetInitFile(initFile)
    }
    debug.CurrentSession.Start()
}
```

以 exec 为例，PostRun 从原来的两行缩成一行 `startDebugSession(cmd)`；debug 的 PostRun 保留删除构建产物的 defer，会话启动也换成同一个函数。

#### 会话回放引擎：cmd/debug/shell.go

`cmd/debug/shell.go` 的改动有四处：

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

    // ...（原有的交互式主循环不变）
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

        s.root.SetArgs(strings.Split(line, " "))
        if err := s.root.Execute(); err != nil {
            return err
        }
        if s.stopped {
            return nil
        }
    }
    return scanner.Err()
}
```

要点：

- 空行、`#` 注释行跳过；
- `!` 与 `=` 是冒烟测试脚本的宿主指令，由 scripts/smoke.sh 解析执行（`!` 是 shell 命令，`=` 是输出断言），godbg 回放时跳过；
- 其余行按空格切成命令与参数，交给 `s.root.Execute()` 执行，执行路径和交互模式完全一致；每行回显成 `godbg> ...`，方便对照输出；
- `exit` 等命令执行后会把 `s.stopped` 置位（`Stop` 里置位），回放提前结束。

#### 单元测试

`cmd/debug/shell_test.go` 补了两个测试：`TestHelpMessageByGroups` 验证帮助信息按分组展示、组内按命令名排序（这是 5.7 节演示过的 help 输出）；`TestReplayInitFile` 写一个含注释、help、exit 的临时脚本，验证会话能逐条回放，并在回放 exit 后停止：

```go
func TestReplayInitFile(t *testing.T) {
    file := filepath.Join(t.TempDir(), "init.txt")
    if err := os.WriteFile(file, []byte("# comment\nhelp\nexit\n"), 0644); err != nil {
        t.Fatalf("write init file error: %v", err)
    }

    s := NewDebugSession().SetInitFile(file)
    // exit 命令经由全局 CurrentSession 结束会话，测试中需要先装配
    CurrentSession = s
    s.Start()

    if !s.stopped {
        t.Errorf("session should be stopped after replaying 'exit'")
    }
}
```

### 运行效果

ch6.4 的冒烟脚本内容很简单：回放 help、断言输出、回放 exit：

```text
# ch6.4 smoke: 验证调试会话可脚本化回放（--init 批量模式）
help
=godbg interactive debugging commands
=- \[breaks\]
=- \[execute\]
=- \[info\]
exit
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

- [breaks]
  ...（分组展示，与 5.7 节一致）
godbg> exit
```

每条回放的命令都带 `godbg>` 前缀回显，与交互模式下的观感一致；help 的输出和 5.7 节演示的一致；exit 之后会话结束，调试器退出。

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
- 回放模式支撑了 godbgv2 的冒烟测试机制（docs/SMOKE-HARNESS.md），书中的示例命令自此可以固化、自动验证。

至此，6.1~6.4 覆盖了发起调试的三种方式（exec/attach/debug）和调试会话的脚本化回放。从 6.5 节开始，我们进入调试会话内部，逐个实现真正的调试命令，第一个是 `disass` 反汇编。
