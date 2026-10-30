## 启动调试：构建并启动调试（debug）

前两节实现的 `godbg exec <prog>`、`godbg attach <pid>` 都要求目标程序已经构建好：exec 直接启动现成的二进制，attach 直接跟踪运行中的进程。但调试往往发生在开发过程中，此时源码可能还没编译，或者改动后还没重新编译。每次调试前手动执行 go build 再 exec，未免太麻烦，而且容易忘记带上调试需要的编译选项。调试器应该替我们完成这件事：构建、启动、跟踪一气呵成，这就是 `godbg debug` 要做的。

本节配套代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.3`，`git diff ch6.2 ch6.3` 能看到这一节相对 attach 多了什么：只改了 `cmd/debug.go` 一个文件。

### 实现目标：`godbg debug [directory|file] [-- args...]` 构建并调试 go 程序

`godbg debug` 接收目录或源码文件作为参数（缺省为当前目录），先编译构建出二进制，再按 6.1 节的方式启动并跟踪，进入调试会话；会话结束后删除构建产物。

与 6.1 节的 `godbg exec` 一样，godbg 自身选项写在 `--` 之前，`--` 之后的位置参数原样传给被调试程序。区别在于 debug 还有一个"位置参数"：`--` 之前的第一个位置参数是 go build 的构建目标。所以命令行形如 `godbg debug [directory|file] [-- args...]`。

构建时有两个和调试强相关的选项：

- `-gcflags=all=-N -l`：`-N` 关闭优化，`-l` 关闭内联。优化和内联会打乱源码与机器指令之间的对应关系，断点、单步、查看变量都会受影响，调试期间一般都要关掉。dlv debug 也会自动加上这个选项；
- `-ldflags=-compressdwarf=false`：关闭 DWARF 调试信息的压缩。DWARF 是调试器做源码级调试的数据来源（第 7、8 章），godbg 假定二进制保留了未压缩的 DWARF 数据，方便后续解析。

构建产物名约定为 `__debug_bin__`（与 delve 同名），放在当前目录，会话结束即删除，不污染工作区。

go build 背后发生的事情（编译器、链接器如何协同工作），7.1 节"Go构建内幕"会详细展开，这里先专注调试命令本身。

### 代码实现

`godbg debug` 的调用链，前半段是 go build，后半段复用 6.1 节的 Launch；`--` 之后的参数也一并透传：

```text
godbg debug [directory|file] [-- args...]
    cmd/debug.go                       RunE：go build -gcflags=all=-N -l -o __debug_bin__
                                       用 ArgsLenAtDash 拆分构建目标与程序参数
                                       → Client.Launch(KindDebug, ./__debug_bin__, traceeArgs...)
    pkg/service/debugger               Launch → target.NewDebuggedProcess（同 6.1）
    pkg/target                         启动并跟踪，等待 SIGTRAP（同 6.1）
    cmd/debug                           PostRun：删除 __debug_bin__，进入调试会话
```

#### cmd/debug.go

`cmd/debug.go` 骨架里还是一句 TODO，这一节把它换成真正的构建 + 启动 + 跟踪：

```go
// BuildExecName 调试命令构建出的二进制文件名
const BuildExecName = "__debug_bin__"

// debugCmd 构建并调试 go 程序
var debugCmd = &cobra.Command{
    Use:   "debug [directory|file] [-- args...]",
    Short: "构建并调试 go 程序",
    Long: `构建并调试 go 程序

与 godbg exec 一样，godbg 自身的选项要写在 -- 之前，-- 之后的参数会
原样传递给被调试程序；-- 之前的第一个位置参数是 go build 的构建目标
（目录或源码文件），缺省为当前目录：

  godbg debug ./examples/debuggee/ -- -name value

若被调试程序不需要以破折号开头的参数，也可以省略 --，此时位置参数
仍全部按构建目标处理（与 go build 一致）：

  godbg debug ./examples/debuggee/ arg1 arg2

需要同时指定构建目标和程序参数时，请使用 -- 分隔。`,
    RunE: func(cmd *cobra.Command, args []string) error {

        // 构建待调试程序：禁用优化与内联，方便调试。
        // -- 之前的位置参数是构建目标，-- 之后的是被调试程序的参数。
        cmdName := []string{"."}
        var traceeArgs []string
        if dash := cmd.ArgsLenAtDash(); dash >= 0 {
            if dash > 0 {
                cmdName = args[:dash]
            }
            traceeArgs = args[dash:]
        } else if len(args) != 0 {
            cmdName = args
        }

        cmdArgs := []string{"build", "-gcflags=all=-N -l", "-ldflags=-compressdwarf=false", "-o", BuildExecName}
        cmdArgs = append(cmdArgs, cmdName...)
        buildCmd := exec.Command("go", cmdArgs...)

        if buf, err := buildCmd.CombinedOutput(); err != nil {
            fmt.Fprintf(os.Stderr, "build error: %v\n", err)
            fmt.Fprintf(os.Stderr, "\terrmsg: %s\n", string(buf))
            return err
        }

        // 启动并跟踪构建出的二进制（-- 之后的参数传递给被调试程序）
        pid, err := Client.Launch(api.KindDebug, "./"+BuildExecName, traceeArgs...)
        if err != nil {
            os.RemoveAll(BuildExecName)
            return err
        }
        fmt.Printf("process %d launched, stopped by SIGTRAP\n", pid)
        return nil
    },
    PostRun: func(cmd *cobra.Command, args []string) {
        // 会话结束后删除构建产物
        defer os.RemoveAll(BuildExecName)
        // TODO(ch6.4): 退出会话时清理被调试进程
        debug.CurrentSession = debug.NewDebugSession()
        debug.CurrentSession.Start()
    },
}
```

几个要点：

- 参数缺省时取 `"."`；`--` 之前的位置参数都作为 go build 的构建目标（可以多个，和 `go build` 一致），缺省为当前目录；
- `--` 之后的参数收集到 `traceeArgs`，原样交给 `Client.Launch`，与 exec 的传参约定一致；
- 构建阶段直接复用 `os/exec`：`go build -gcflags=all=-N -l -ldflags=-compressdwarf=false -o __debug_bin__`。构建失败时把 go 工具链的 stderr 打出来，返回错误；
- 构建成功后调用 `Client.Launch`，Kind 传 `KindDebug`，与 exec 的 `KindExec`、attach 的 `KindAttach` 区分。从这里开始就和 6.1 节的 exec 完全一样了：启动、跟踪、等 SIGTRAP；
- `PostRun` 里先 `defer os.RemoveAll(BuildExecName)`，会话结束后删除构建产物，然后进入调试会话。6.4 节会把各启动命令的 PostRun 统一收进 startDebugSession。

#### 位置参数怎么分：构建目标还是程序参数？

debug 和 exec 不一样：exec 的第一个位置参数一定是程序路径，剩下的都是程序参数；debug 的第一个位置参数是 go build 的构建目标，后面既可能是更多的构建目标，也可能是程序参数，只看位置分不清。所以这里用 cobra 的 `cmd.ArgsLenAtDash()` 按 `--` 切分：

```go
cmdName := []string{"."}
var traceeArgs []string
if dash := cmd.ArgsLenAtDash(); dash >= 0 {
    if dash > 0 {
        cmdName = args[:dash]
    }
    traceeArgs = args[dash:]
} else if len(args) != 0 {
    cmdName = args
}
```

- `godbg debug ./examples/debuggee/ -- -test.v`：构建 `./examples/debuggee/`，tracee 收到 `-test.v`；
- `godbg debug ./examples/debuggee/`：只构建，没有程序参数；
- `godbg debug ./examples/debuggee/ ./cmd/tool`：没有 `--`，两个位置参数都按构建目标处理（与 `go build` 一致）；
- `godbg debug -- -flag`：`--` 之前没有位置参数，构建目标取缺省 `"."`。

注意不要把"第一个位置参数是构建目标、其余是程序参数"这种按位置硬拆的方式写进去：那样多个构建目标时，第二个会被悄悄当成程序参数，和 `go build` 的行为不一致。delve 的做法也是按 `--` 切分（`splitArgs` + `ArgsLenAtDash`）。

> ps: attach 成功后读取 `/proc/pid/comm`、`/proc/pid/cmdline` 记录启动命令与参数（initialize）的内容，放在 6.2 节 attach 中讲，它不属于 debug 命令：exec/debug 启动的进程，命令和参数在启动调试器时天然就知道。

### 代码测试

在 godbgv2 仓库里切到这一节，把调试器构建出来：

```bash
git checkout ch6.3
make build
```

用 debug 调试 `examples/debuggee/loop.go`：

```bash
$ ./godbg debug ./examples/debuggee/
process 31493 launched, stopped by SIGTRAP
godbg>
```

- 构建阶段：go build 的输出来自 go 工具链，构建成功后进入启动跟踪流程，输出 `process 31493 launched, stopped by SIGTRAP`，与 6.1 节 exec 的输出一致；
- 会话阶段：与 exec/attach 无异，`godbg>` 提示符，help 可以列出调试命令（5.7 节介绍过）；
- 退出阶段：输入 `exit`，会话结束，PostRun 里的 defer 删除 `__debug_bin__`，`ls` 确认当前目录没有残留。注意这一版退出时还不会清理 tracee，6.4 节补上退出善后。

参数透传与 exec 共用同一套 `Client.Launch` 链路，`./godbg debug --help` 可以看到 `Usage: godbg debug [directory|file] [-- args...]`。本节还没有 continue 命令（6.13 节实现），会话里没法让 tracee 跑起来观察它拿到的 `os.Args`；等 continue 可用之后，就能在程序输出里看到 `--` 之后传进去的参数。

对比一下两种方式：`godbg exec _fixtures/loop` 调试的是现成二进制，`godbg debug ./examples/debuggee/` 是现编译现调。开发过程中 debug 更贴近工作流，而 exec 适合调试已经发布、不想重新编译的程序。

### 本节小结

本节实现了 `godbg debug [directory|file] [-- args...]`，补齐了发起调试的第三种方式：

- debug 面向尚未构建的程序：先 go build（带上 `-gcflags=all=-N -l` 关闭优化与内联、`-ldflags=-compressdwarf=false` 关闭 DWARF 压缩），再复用 6.1 节的 Launch 流程启动并跟踪，会话结束后删除构建产物；
- 构建产物约定为 `__debug_bin__`，与 delve 的约定一致；
- 位置参数按 `--` 切分：`--` 之前是 go build 构建目标，`--` 之后透传给被调试程序，用 `ArgsLenAtDash` 实现，与 exec 的传参约定一致；
- attach 的启动信息记录属于 6.2 节，本节不再重复。

至此，`godbg exec`（启动已构建程序并跟踪）、`godbg attach`（跟踪运行中进程）、`godbg debug`（构建并调试）三种发起调试的方式都齐了。6.4 节先补上会话退出时的进程善后，6.5 节再给调试会话加一个批量回放能力，用 `--init <file>` 一键重放调试命令脚本，并把它建成完整的冒烟测试机制。
