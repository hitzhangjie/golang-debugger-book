## 启动调试：构建并启动调试（debug）

前两节实现的 `godbg exec <prog>`、`godbg attach <pid>` 都要求目标程序已经构建好：exec 直接启动现成的二进制，attach 直接跟踪运行中的进程。但调试往往发生在开发过程中，此时源码可能还没编译，或者改动后还没重新编译。每次调试前手动执行 go build 再 exec，未免太麻烦，而且容易忘记带上调试需要的编译选项。调试器应该替我们完成这件事：构建、启动、跟踪一气呵成，这就是 `godbg debug` 要做的。

本节配套代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.3`，`git diff ch6.2 ch6.3` 能看到这一节在 attach 的基础上多了什么。

### 实现目标：`godbg debug [directory|file]` 构建并调试 go 程序

`godbg debug` 接收目录或源码文件作为参数（缺省为当前目录），先编译构建出二进制，再按 6.1 节的方式启动并跟踪，进入调试会话；会话结束后删除构建产物。

构建时有两个和调试强相关的选项：

- `-gcflags=all=-N -l`：`-N` 关闭优化，`-l` 关闭内联。优化和内联会打乱源码与机器指令之间的对应关系，断点、单步、查看变量都会受影响，调试期间一般都要关掉。dlv debug 也会自动加上这个选项；
- `-ldflags=-compressdwarf=false`：关闭 DWARF 调试信息的压缩。DWARF 是调试器做源码级调试的数据来源（第 7、8 章），godbg 假定二进制保留了未压缩的 DWARF 数据，方便后续解析。

构建产物名约定为 `__debug_bin__`（与 delve 同名），放在当前目录，会话结束即删除，不污染工作区。

go build 背后发生的事情（编译器、链接器如何协同工作），7.1 节"Go构建内幕"会详细展开，这里先专注调试命令本身。

### 代码实现

`godbg debug` 的调用链，前半段是 go build，后半段复用 6.1 节的 Launch：

```text
godbg debug [directory|file]
    cmd/debug.go                       RunE：go build -gcflags=all=-N -l -o __debug_bin__
                                       → Client.Launch(KindDebug, ./__debug_bin__)
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
    Use:   "debug [directory|file]",
    Short: "构建并调试 go 程序",
    Long:  `构建并调试 go 程序`,
    RunE: func(cmd *cobra.Command, args []string) error {

        // 构建待调试程序：禁用优化与内联，方便调试
        cmdName := []string{"."}
        if len(args) != 0 {
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

        // 启动并跟踪构建出的二进制
        // TODO(ch6.4): 支持向被调试程序传递参数（-- 之后）
        pid, err := Client.Launch(api.KindDebug, "./"+BuildExecName)
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
        // TODO(ch6.10): 退出会话时清理被调试进程
        debug.CurrentSession = debug.NewDebugSession()
        debug.CurrentSession.Start()
    },
}
```

几个要点：

- 参数缺省时取 `"."`，否则用传入的目录或文件，作为 go build 的构建目标；
- 构建阶段直接复用 `os/exec`：`go build -gcflags=all=-N -l -ldflags=-compressdwarf=false -o __debug_bin__`。构建失败时把 go 工具链的 stderr 打出来，返回错误；
- 构建成功后调用 `Client.Launch`，Kind 传 `KindDebug`，与 exec 的 `KindExec`、attach 的 `KindAttach` 区分。从这里开始就和 6.1 节的 exec 完全一样了：启动、跟踪、等 SIGTRAP；
- `PostRun` 里先 `defer os.RemoveAll(BuildExecName)`，会话结束后删除构建产物，然后进入调试会话。6.4 节会把各启动命令的 PostRun 统一收进 startDebugSession。

代码里的 TODO(ch6.4) 还留了一件事：支持 `--` 之后向被调试程序传递参数。它标记的是 ch6.4 的计划，实际 ch6.4 落地的是 --init 脚本回放，参数透传留待后续章节，本节先不管。

#### 目标层：initialize 读取启动命令与参数

ch6.2 里 `AttachTargetProcess` 留了个 TODO(ch6.3)，本节把它填上：attach 成功后调用 `p.initialize()` 读取 `/proc/pid/comm`、`/proc/pid/cmdline`，得到被调试进程的启动命令和参数，存进 `DebuggedProcess.Command/Args`：

```go
func AttachTargetProcess(pid int) (p *DebuggedProcess, err error) {
	...
	// 读取 /proc/pid/comm、/proc/pid/cmdline，便于后续支持重启调试
    if err := p.initialize(); err != nil {
        return nil, err
    }
	// TODO(ch6.20.1): attach 到该进程的其他线程
	return p, nil
}

// initialize 初始化被调试进程的启动命令与参数
func (p *DebuggedProcess) initialize() error {
    var err error

    // initialize the command and arguments, after then, we could support
    // restart command.
    if p.Command, err = readProcComm(p.Process.Pid); err != nil {
        return err
    }
    if p.Args, err = readProcCommArgs(p.Process.Pid); err != nil {
        return err
    }
    return nil
}
```

这有什么用呢？考虑 restart 命令。一轮调试结束（比如断点位置设错了，错过了关键代码），想重新发起调试，就得知道目标进程最初是怎么启动的。

- exec/debug 启动的进程，命令和参数是启动调试器的时候指定的，天然知道这里的参数信息；
- attach 的进程则是"半路接手"，只能从内核的 /proc 接口里读回来。

#### procfs.go

`readProcComm`、`readProcCommArgs` 的实现放在 `pkg/target/procfs.go`（6.1 节的 status 函数也在这里）：

```go
// readProcComm 读取 /proc/pid/comm 获取进程的启动命令
func readProcComm(pid int) (string, error) {
    comm, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
    if err == nil {
        // removes newline character
        comm = bytes.TrimSuffix(comm, []byte("\n"))
    }

    if comm == nil || len(comm) <= 0 {
        // /proc/pid/comm 读取失败时，从 /proc/pid/stat 中解析
        stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
        if err != nil {
            return "", fmt.Errorf("could not read proc stat: %v", err)
        }
        expr := fmt.Sprintf("%d\\s*\\((.*)\\)", pid)
        rexp, err := regexp.Compile(expr)
        if err != nil {
            return "", fmt.Errorf("regexp compile error: %v", err)
        }
        match := rexp.FindSubmatch(stat)
        if match == nil {
            return "", fmt.Errorf("no match found using regexp '%s' in /proc/%d/stat", expr, pid)
        }
        comm = match[1]
    }

    cmdStr := strings.ReplaceAll(string(comm), "%", "%%")
    return cmdStr, nil
}

// readProcCommArgs 读取 /proc/pid/cmdline 获取进程的启动参数
func readProcCommArgs(pid int) ([]string, error) {
    dat, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
    if err != nil {
        return nil, err
    }
    args := strings.Split(string(dat), string([]byte{0}))[1:]
    return args, nil
}
```

几个细节：

- `/proc/pid/comm` 是内核侧 task_struct.comm 的投影，最多 15 字节加一个 `\0`，读出来要 trim 掉换行；读不到时从 `/proc/pid/stat` 里按 `pid (comm)` 的格式解析兜底；
- `/proc/pid/cmdline` 是 NUL 分隔的完整命令行，第 0 项是程序路径（argv[0]），后面的才是参数，所以 Args 取 `[1:]`；
- `comm` 里的 `%` 被替换成 `%%`，避免这个字符串之后被当格式串使用时出问题。

配套的 `pkg/target/procfs_test.go` 用 pid 1（init/systemd）验证了这两个函数：comm 非空、args 返回合法 slice。

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
- 退出阶段：输入 `exit`，会话结束，PostRun 里的 defer 删除 `__debug_bin__`，`ls` 确认当前目录没有残留。

对比一下两种方式：`godbg exec _fixtures/loop` 调试的是现成二进制，`godbg debug ./examples/debuggee/` 是现编译现调。开发过程中 debug 更贴近工作流，而 exec 适合调试已经发布、不想重新编译的程序。

### 本节小结

本节实现了 `godbg debug [directory|file]`，补齐了发起调试的第二种方式：

- debug 面向尚未构建的程序：先 go build（带上 `-gcflags=all=-N -l` 关闭优化与内联、`-ldflags=-compressdwarf=false` 关闭 DWARF 压缩），再复用 6.1 节的 Launch 流程启动并跟踪，会话结束后删除构建产物；
- 构建产物约定为 `__debug_bin__`，与 delve 的约定一致；
- 顺带补上了 ch6.2 的 TODO：attach 成功后 initialize 读取 `/proc/pid/comm`、`/proc/pid/cmdline`，为后续支持 restart 命令准备启动命令与参数。

至此，`godbg exec`（启动已构建程序并跟踪）、`godbg attach`（跟踪运行中进程）、`godbg debug`（构建并调试）三种发起调试的方式都齐了。6.4 节我们给调试会话加一个批量回放能力，用 `--init <file>` 一键重放调试命令脚本。
