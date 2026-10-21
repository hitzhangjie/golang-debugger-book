## 启动调试：启动进程

第 5 章我们已经把调试器骨架搭起来了，对应 godbgv2 的 tag `ch5.4`。`godbg exec <prog>` 这条命令也挂上了，不过 `Run` 里面还是一句 TODO，打印完就进入调试会话，目标程序并没有真正跑起来。

本节我们就来把这个 TODO 填上。配套代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.1`，`git checkout ch6.1` 就是这一节完成时的代码，`git diff ch5.4 ch6.1` 能看到相对骨架多了什么。后面的示例都在这一个工程里，顺着骨架往下看就行。

### 实现目标：`godbg exec <prog>` 启动新进程

调试器要开始调试，首先得确定调试谁。目标可能是一个正在运行的进程，也可能是一个 core 文件。core 文件是进程结束前留下来的内存和硬件上下文，调试器可以借它看崩溃前的调用栈，但是进程已经结束了，没法再控制它往下执行。对运行中的进程能做的操作，其实覆盖了对 core 文件能做的操作，比如还可以控制程序怎么往下走。所以本章先看运行中的进程。core 文件怎么构成、怎么生成、怎么调试，我们放到符号级调试部分再讲。

进程要进入调试，常见有这么几种情况：

- 目标程序 `<prog>` 已经构建好，但是还没运行：我们需要把它启动起来并跟踪，如 `dlv exec <prog>`、`gdb <prog>`；
- 目标程序还没构建，要先编译再运行：编译时得带上调试需要的选项，关掉内联和优化。`dlv debug`、`dlv test` 会自动加上 `-gcflags="all=-N -l"`；
- 目标程序已经在跑，pid 也知道了：直接按 pid 跟踪，如 `dlv attach <pid>`、`gdb <pid>`。

OK，我们先做第一种。`godbg exec <prog>` 负责把这个已经构建好的程序启动起来，让它在开始执行用户代码之前停住，然后进入第 5 章已经搭好的调试会话。`<prog>` 可以是可执行文件的路径，也可以是 `$PATH` 里能搜到的程序名。第二种情况对应后面的 `godbg debug`，第三种是下一节的 `godbg attach <pid>`。

### os/exec 包介绍

在 shell 里，只要敲一个程序路径或者程序名，就能把程序跑起来。stdout、stderr 上能看到它的输出，`$?` 则是进程的返回值。那么在 Go 里怎么做同样的事呢？标准库的 `os/exec` 包就可以，指定程序路径或程序名来启动进程，并拿到输出和执行结果。

先用 `exec.Command(...)` 准备一个 `exec.Cmd`。注意，`Cmd` 一旦调用过 `Start` 或 `Run`，就不能再复用了。真正启动的时候，按需要有几种写法，下面先把要用到的方法放在一起。

```go
// Command 的 name 可以是可执行文件路径，也可以是 PATH 中能搜到的程序名
func Command(name string, arg ...string) *Cmd

// Run 启动并等到进程结束
func (c *Cmd) Run() error

// Start 只负责启动，不等进程结束，要和 Wait 配对
func (c *Cmd) Start() error

// Wait 等到进程结束，取回退出码，并释放相关资源
func (c *Cmd) Wait() error

// Output 收集 stdout；CombinedOutput 把 stdout 和 stderr 合到一起
func (c *Cmd) Output() ([]byte, error)
func (c *Cmd) CombinedOutput() ([]byte, error)
```

准备好 `Cmd` 之后，可以这样用：

- 方法 1：`err := cmd.Start()` 把程序拉起来，再 `err := cmd.Wait()` 等到它结束；
- 方法 2：`err := cmd.Run()`，等价于上面的 `Start` 加 `Wait`，一次做到程序结束；
- 方法 3: 方法 1、方法 2 如果还想收集 stdout、stderr，可以在启动前把 `cmd.Stdout`、`cmd.Stderr` 指到一块 `bytes.Buffer`。觉得这样有点麻烦的话，可以用 `buf, err := cmd.CombinedOutput()`，启动并等到结束，`buf` 里就是 stdout 和 stderr 合在一起的输出。`Output` 则只收集 stdout。

还有一种情况，只有 `Start` 能照顾到：我们并不想一直等到进程结束。`Start` 返回之后进程还在跑，而且启动前可以改 `Cmd` 上的字段，比如把标准输入输出接到当前终端，或者设置 `SysProcAttr`。调试器后面用的就是这种。

不过在那之前，我们先用最少的代码把“启动一个程序、拿到输出”跑通，看看 exec 到底要做哪些事。

### 极简 demo

下面我们写一个很小的程序，把上面的用法串起来。它接收 `exec <prog>`，用 `CombinedOutput` 启动程序并等到结束，再把 stdout、stderr 打印出来。参数检查、创建 `Cmd`、启动、等待、打印，暂时都放在一个 `main` 里。这还不是调试器，只是先把 exec 要做的事情看清楚。

```go
package main

import (
	"fmt"
	"os"
	"os/exec"
)

const (
	usage = "Usage: ./godbg exec <path/to/prog>"

	cmdExec = "exec"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "%s\n\n", usage)
		os.Exit(1)
	}
	cmd := os.Args[1]

	switch cmd {
	case cmdExec:
		prog := os.Args[2]
		progCmd := exec.Command(prog)
		buf, err := progCmd.CombinedOutput()
		if err != nil {
			fmt.Fprintf(os.Stderr, "exec error: %v\n\n%s\n", err, buf)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stdout, "%s\n", buf)
	default:
		fmt.Fprintf(os.Stderr, "%s unknown cmd\n\n", cmd)
		os.Exit(1)
	}
}
```

这里的程序逻辑比较简单：

- 运行时先看命令行参数。`godbg exec <prog>` 至少要有 3 个参数，数量不对就报错退出；
- 再看第 2 个参数，`os.Args[1]` 不是 `exec`，也直接退出；
- 参数正常的话，第 3 个参数 `os.Args[2]` 就是程序路径或程序名。我们准备一个 `exec.Cmd`，启动并取回运行结果。

把这段代码存成 `main.go`，在所在目录执行：

```bash
go run main.go exec ls
```

程序会正常执行 `ls`，当前目录下的文件名打印出来。目标进程跑完了，输出和结果我们也拿到了。但是，调试会话、断点这些，这里都还没有。

这个例子够用来熟悉 `os/exec`，但是拿它当调试器还不行。进程一下子就跑完了，我们来不及做任何调试动作。调试器希望进程停在起点等我们，所以后面不会再用 `CombinedOutput` 一直等到退出，而是改成 `Start`，并在启动前设上 `SysProcAttr.Ptrace`。另外，这些逻辑也不能一直堆在一个 `main` 里，得放回第 5 章那个骨架中去。

### 在 godbgv2 中实现

接下来我们就做这件事：把上面的逻辑搬进前面搭好调试器骨架的 godbgv2。tag `ch6.1` 相对骨架 `ch5.4`，调试会话没动，`PostRun` 里还是 `NewDebugSession().Start()`，变的是程序怎么被拉起来。

极简 demo 里写在一起的那几步，在这里拆开了：

- 参数检查交给 cobra。`exec <prog>` 在骨架里已经注册好，我们把对应的 `execCmd` 的 `Run` 方法换成 `RunE`，`RunE` 更适合对参数进行检查，参数不对就返回错误；
- 参数检查OK后再进入 `Run` 方法执行真正的启动程序的逻辑，并实现跟踪逻辑；
  - `cmd` 也不直接去调 `os/exec`。它通过 `api.Client.Launch` 把请求交给服务层，服务层再转到目标层。至于这个接口背后到底是谁，由 `main` 在启动时装上。在我们这里，是由 `Debugger` 实现 `api.Client` 接口方法 `api.Client.Launch`。
  - `exec.Command(...)` 挪到目标层的 `Debugger.Launch(...)->DebuggedProcess.launchCommand(...)`。这里改用 `Start`，启动前设置 `SysProcAttr.Ptrace`，启动后再等到 `SIGTRAP`，这样进程启动后会立即停下来；
  - 命令层不再把程序输出收进缓冲区，只打印被调试进程的 pid。程序自己的打印仍然出现在当前终端；
- `Run` 执行OK再进入 `PostRun` 进入已经搭好的调试会话；

所以相对 tag `ch5.4`，这一节新增的主要就是下面这条调用链。

```text
godbg exec <prog>
    cmd/exec.go                         RunE：校验参数，调用 Client.Launch
    pkg/service/api                     Client 接口，cmd 只认这个接口
    pkg/service/debugger                门面，把请求转给目标层
    pkg/target                          exec.Command + PTRACE_TRACEME，等待 SIGTRAP
    cmd/debug                           PostRun 进入已有的调试会话
```

Package `main` 负责装配。Package `cmd` 不直接 import `pkg/target`，也不直接 import `pkg/service/debugger`，而是通过 `api.Client` 来对接后端实现，比如在指令级调试部分这里的实现就是 `debugger.Debugger`，它直接操作目标进程。

到第 9 章后，我们会让调试器实现 headless 模式，暴漏一个调试用的service层，`api.Client` 通过 service层对接不同后端实现。这个改动过程中，命令层基本保持不变，相当于只换了 `var Client api.Client` 的实现。这个约定写在 godbgv2 的 `docs/ARCH-RULES.md` 里。

现在，godbgv2骨架里多出来了服务层和目标层，Package `pkg/service` 和 `pkg/target`：

```text
godbgv2
├── main.go                          装配 Client
├── cmd
│   ├── client.go                    UI 层看到的 Client 变量
│   ├── exec.go                      填上启动逻辑
│   └── debug/                       调试会话，本节未改
├── pkg/service
│   ├── api/client.go                Client 接口
│   └── debugger/debugger.go         门面
├── pkg/target
│   ├── process.go                   启动并等待 SIGTRAP
│   ├── ptrace_linux.go              ptrace 固定在同一个 OS 线程上执行
│   ├── procfs.go                    读 /proc/pid/stat，判断进程是否已成僵尸
│   └── process_test.go
└── examples/debuggee/loop.go        本节用来试手的目标程序
```

#### 命令层

`cmd/exec.go` 里，骨架原来的 `Run` 换成了 `RunE`。参数校验有误时返回错误，cobra 会把错误打到 stderr，进程以非零状态退出。参数没问题，就把程序路径交给 `Client.Launch`。这个调用返回时，进程已经因为 exec 产生的 `SIGTRAP` 停住了，我们把 pid 打印出来。

```go
RunE: func(cmd *cobra.Command, args []string) error {
    if len(args) != 1 {
        return errors.New("参数错误")
    }

    // 启动并跟踪被调试进程，等待其因 exec 产生的 SIGTRAP 而停止
    pid, err := Client.Launch(api.KindExec, args[0])
    if err != nil {
        return err
    }
    fmt.Printf("process %d launched, stopped by SIGTRAP\n", pid)
    return nil
},
PostRun: func(cmd *cobra.Command, args []string) {
    // TODO(ch6.10): 退出会话时清理被调试进程
    debug.CurrentSession = debug.NewDebugSession()
    debug.CurrentSession.Start()
},
```

`Client` 定义在 `cmd/client.go`，类型是 `api.Client`。命令层之后都通过它和后端打交道。

#### 装配

`main` 在调用 `cmd.Execute()` 之前，先把具体实现注进去：

```go
func main() {
    go processSignals()

    cmd.Client = debugger.New()
    cmd.Execute()
}
```

`processSignals` 放在单独的 goroutine 里处理信号。Go 运行时用 `SIGURG` 做异步抢占，这个信号我们暂时直接忽略。`SIGTERM`、`SIGINT`、`SIGQUIT` 目前先让进程退出。退出前还原断点、detach，或者结束被调试进程，留到 6.10 节再做。

`api.Client` 在这一节只有一个方法。后面几节会陆续补上 attach、读写内存这些操作，会陆续有点改动。到第 9 章时，这里的完整接口才能定下来。

```go
type Client interface {
    // Launch 启动并跟踪一个进程，返回被调试进程 pid
    Launch(kind Kind, cmd string, args ...string) (int, error)
}
```

`pkg/service/debugger` 是第 6 章对这个接口的实现。它自己不打印任何内容，只把请求转给目标层，并记住当前正在调试的 `DebuggedProcess`：

```go
func (d *Debugger) Launch(kind api.Kind, cmd string, args ...string) (int, error) {
    dbp, err := target.NewDebuggedProcess(cmd, args, target.Kind(kind))
    if err != nil {
        return 0, err
    }
    d.dbp = dbp
    return dbp.Process.Pid, nil
}
```

`api.Kind` 和 `target.Kind` 是两套枚举，取值顺序一样，都是 debug、exec、attach。接口上只传值，目标层自己的类型不会漏到 `cmd` 里。

#### 目标层：启动并停住

`NewDebuggedProcess` 先把进程描述准备好，再通过 `ExecPtrace` 去真正启动。如果启动失败，就把处理 ptrace 的那个协程停掉，免得留下一个空转的 goroutine。

```go
func NewDebuggedProcess(cmd string, args []string, kind Kind) (*DebuggedProcess, error) {
    var (
        dbp DebuggedProcess
        err error
    )
    dbp = DebuggedProcess{
        Command: cmd,
        Args:    args,
        Kind:    kind,
        once:    &sync.Once{},
        reqCh:   make(chan ptraceRequest, 16),
        doneCh:  make(chan int),
    }
    defer func() {
        if err != nil {
            dbp.StopPtrace()
        }
    }()

    err = dbp.ExecPtrace(func() error {
        dbp.Process, err = dbp.launchCommand(cmd, args...)
        if err != nil {
            return err
        }
        return nil
    })
    if err != nil {
        return nil, err
    }
    return &dbp, nil
}
```

`launchCommand` 才是 `os/exec` 真正上场的地方。标准输入输出接到调试器所在的终端，被调试程序的打印还能出现在当前会话里。`SysProcAttr.Ptrace` 设为 true，子进程会在 exec 之前执行 `ptrace(PTRACE_TRACEME)`。exec 一旦成功，它就会收到 `SIGTRAP` 并暂停，等调试器下一步指令。`Setpgid` 让子进程单独使用自己的进程组，`Foreground` 保持 false，不把它放到终端前台，这样 Ctrl+C 仍然是交给调试器的。

环境变量先继承当前环境，再追加 `GODEBUG=asyncpreemptoff=1`，把 Go 运行时的异步抢占关掉。不然被调试进程里的抢占信号，会和调试器插入的信号搅在一起。

```go
func (p *DebuggedProcess) launchCommand(execName string, args ...string) (*os.Process, error) {
    progCmd := exec.Command(execName, args...)
    progCmd.Stdin = os.Stdin
    progCmd.Stdout = os.Stdout
    progCmd.Stderr = os.Stderr

    progCmd.SysProcAttr = &syscall.SysProcAttr{
        Ptrace:     true, // implies PTRACE_TRACEME
        Setpgid:    true,
        Foreground: false,
    }
    progCmd.Env = os.Environ()
    progCmd.Env = append(progCmd.Env, "GODEBUG=asyncpreemptoff=1")

    err := progCmd.Start()
    if err != nil {
        return nil, err
    }
    p.Process = progCmd.Process

    _, status, err := p.wait(progCmd.Process.Pid, syscall.WSTOPPED)
    if err != nil {
        return nil, err
    }
    if !status.Stopped() || status.StopSignal() != syscall.SIGTRAP {
        return nil, fmt.Errorf("unexpected status: %v", status)
    }
    return progCmd.Process, nil
}
```

`Start` 返回的时候，子进程多半还没停稳。所以紧接着用 `wait`，内部是 `wait4`，等到 `WSTOPPED`，并核对停止信号是不是 `SIGTRAP`。对不上，就当这次启动失败。

`wait` 里对线程组 leader 做了点特殊处理。leader 已经退出、却还留着僵尸子线程时，直接 `wait4` 会永远阻塞。这里改成带 `WNOHANG` 的轮询，同时读 `/proc/<pid>/stat`，看它是不是已经变成僵尸。刚 exec 完就停住的场景里，这个分支通常走不到，写在这里是为了后面跟踪多线程时，同一套等待逻辑还能接着用。

还有一个 Go 运行时带来的约束，这里先提一下。ptrace 一旦建立跟踪关系，后面的请求必须从同一个 OS 线程发出，内核才认。goroutine 和 OS 线程并没有绑定关系，所以不能在随便哪个 goroutine 里直接调 `syscall.Ptrace*`。`ExecPtrace` 第一次被调用时会拉起一个协程，用 `runtime.LockOSThread` 把它钉在一个线程上，所有 ptrace 请求都进 `reqCh`，由这个线程串行执行。`launchCommand` 包在 `ExecPtrace` 里，就是为了从这一步开始，跟踪关系就落在这个线程上。下一节去 attach 一个已经在跑的进程时，走的还是这条路。

内核里 `PTRACE_TRACEME` 和 exec 到底怎么配合，为什么“先把程序跑起来再 attach”会错过开头，我们读完这一节的调用链后再展开。这里先记住 Go 这边的结果就好：`Launch` 返回时，目标进程已经在了，并且停在 exec 成功的那一下。

### 运行效果

在 godbgv2 仓库里切到这一节，把调试器和目标程序都构建出来：

```bash
git checkout ch6.1
make build
make fixtures
```

`make fixtures` 会把 `examples/debuggee/loop.go` 编到 `_fixtures/loop`。这个程序每秒打印一次自己的 pid 和计数值，方便我们看它到底有没有跑起来。编译时带了 `-gcflags "all=-N -l"`，和后面调试 Go 程序时的要求是一致的。

```bash
$ ./godbg exec _fixtures/loop
process 208201 launched, stopped by SIGTRAP
godbg>
```

pid 每次运行都不一样。看到这行输出时，loop 还没开始打印，它停在 exec 之后。提示符 `godbg>` 就是骨架里那个调试会话。断点、单步这些命令这一节还没做，在会话里执行的话，看到的仍是带章节号的 TODO。

输入 `exit` 可以结束会话。这一版退出时还不会清理被调试进程。调试器自己退出之后，内核会把跟踪关系解开，loop 就从停下的地方继续跑，终端上会开始出现 `pid: ...`。试完记得把这个 pid 停掉。退出前的清理，我们放到 6.10 节。

### 本节小结

本节主要探讨了如何启动一个待调试的进程，核心内容包括：用一段极简代码看清 `os/exec` 要做的事，也就是解析 `exec <prog>`、启动程序并取回输出；把这套逻辑搬进 tag `ch5.4` 的调试器骨架，改用 `Start` 和 `SysProcAttr.Ptrace`，让进程在 exec 成功时停在 `SIGTRAP`；命令层只调用 `api.Client.Launch`，由 `main` 装配实现，再转到 `pkg/target` 完成真正的启动和等待。

本节内容为读者学习下一节的 attach，以及后面在这个已经停住的进程上做断点、单步和查看寄存器打下了基础。
