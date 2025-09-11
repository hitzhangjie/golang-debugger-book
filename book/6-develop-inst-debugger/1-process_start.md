## 启动调试：`exec` 启动新进程

### 实现目标：`godbg exec <prog>`

调试器执行调试，首先得确定要调试的目标。它可能是一个进程实例，或者是一个core文件。为了便利性，调试器也可以代为执行编译操作，如dlv debug的目标可以是一个 `main module` or `test package`。

>我们先关注如何调试一个进程，core文件只是进程的一个内核转储文件，调试器只能查看当时的栈帧情况。对进程进行调试涉及到的方方面面基本覆盖了对core文件进行调试的内容，所以本章我们先将重点放在对进程进行调试上，对core文件的调试支持我们在符号级调试章节再介绍。

调试一个进程，主要有以下几种情况：

- 如果目标进程还不存在，我们需要启动程序并跟踪进程，如 `dlv exec <prog>`、`gdb <prog>`；
- 如果目标进程已经存在，我们需要通过进程pid来跟踪进程，如 `dlv attach <pid>`、`gdb <pid>`；

为了方便开发、调试，调试器可能也包含了编译构建的任务，如保证构建产物中包含调试信息、禁止编译优化等。通常这些操作需要传递特殊的选项给编译器、链接器，对开发者而言并不是一件很友好的事情。考虑到这点，go调试器dlv在执行 `dlv debug`、`dlv test` 命令时，会自动传递 `-gcflags="all=-N -l"`选项来禁用编译构建过程中的内联、优化，以保证构建产物满足调试器调试需要。

下面先介绍下第一种情况，指定程序路径，启动程序创建进程。

我们将实现程序godbg，它支持exec子命令，支持接收参数prog，godbg将启动程序prog并获取其执行结果。

> prog代表一个可执行程序，它可能是一个指向可执行程序的路径，也可能是一个在PATH路径中可以搜索到的可执行程序的名称。

### 基础知识

go标准库提供了os/exec包，允许指定程序名来启动进程。先介绍下如何通过go标准库启动程序创建进程。

通过 `cmd = exec.Command(...)`方法我们可以创建一个Cmd实例：

- 之后则可以通过 `cmd.Start()`方法来启动程序，如果希望获取结果则通过 `cmd.Wait()`等待进程结束再获取结果；
- 如果希望启动程序并等待执行结束，也可以通过 `cmd.Run()`，命令输出的stdout、stderr信息可通过修改cmd.Stdout、cmd.Stderr为一个bytes.Buffer来收集；
- 如果希望启动程序并等待执行结束，同时能获取stdout、stderr输出信息，也可以通过 `buf, err := Cmd.CombineOutput()`来完成。

```go
package exec // import "os/exec"

// Command 该方法接收可执行程序名称或者路径，arg是传递给可执行程序的参数信息，
// 该函数返回一个Cmd对象，通过它来启动程序、获取程序执行结果等，注意参数name
// 可以是一个可执行程序的路径，也可以是一个PATH中可以搜索到的可执行程序名
func Command(name string, arg ...string) *Cmd

// Cmd 通过Cmd来执行程序、获取程序执行结果等等，Cmd一旦调用Start、Run等方法之
// 后就不能再复用了
type Cmd struct {
    ...
}

// CombinedOutput 返回程序执行时输出到stdout、stderr的信息
func (c *Cmd) CombinedOutput() ([]byte, error)

// Output 返回程序执行时输出到stdout的信息，返回值列表中的error表示执行中遇到错误
func (c *Cmd) Output() ([]byte, error)

// Run 启动程序并且等待程序执行结束，返回值列表中的error表示执行中遇到错误
func (c *Cmd) Run() error

// Start 启动程序，但是不等待程序执行结束，返回值列表中的error表示执行中遇到错误
func (c *Cmd) Start() error

...

// Wait 等待cmd执行结束，该方法必须与Start()方法配合使用，返回值error表示执行中遇到错误
//
// Wait等待程序执行结束并获得程序的退出码（也就是返回值，os.Exit(?)将值返回给操作系统进而被父进程获取），
// 并释放对应的资源(比如id资源，联想下PCB)
func (c *Cmd) Wait() error
```

### 代码实现

**src详见：golang-debugger-lessons/1_process_start**

下面基于go标准库 `os/exec` package来演示如何启动程序创建进程实例。

file: main.go

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
            fmt.Fprintf(os.Stderr, "%s exec error: %v, \n\n%s\n\n", err, string(buf))
            os.Exit(1)
        }
        fmt.Fprintf(os.Stdout, "%s\n", string(buf))
    default:
        fmt.Fprintf(os.Stderr, "%s unknown cmd\n\n", cmd)
        os.Exit(1)
    }
}
```

这里的程序逻辑比较简单：

- 程序运行时，首先检查命令行参数，
  - `godbg exec <prog>`，至少有3个参数，如果参数数量不对，直接报错退出；
  - 接下来校验第2个参数，如果不是exec，也直接报错退出；
- 参数正常情况下，第3个参数应该是一个程序路径或者可执行程序文件名，我们创建一个exec.Command对象，然后启动并获取运行结果；

### 代码测试

您可以自己编译构建，完成相关测试。

```bash
1_start-process $ GO111MODULE=off go build -o godbg main.go

./godbg exec <prog>
```

> ps: 当然也可以考虑将godbg拷贝到PATH路径下或者go install之后再进行测试。

现在的程序逻辑单文件就可以完成，因此 `go run main.go`就可以快速测试，如在目录golang-debugger-lessons/1_start-process下执行 `GO111MODULE=off go run main.go exec ls` 进行测试。

```bash
1_start-process $ GO111MODULE=off go run main.go exec ls
tracee pid: 270
main.go
README.md
```

godbg正常执行了命令ls并显示出了当前目录下的文件，后面我们将用正常的go程序作为被调试进程，本小节掌握如何启动进程即可。

> ps：关于测试环境，建议读者尽量使用与作者一致或相近的环境，以便顺利完成测试。最初我为 godbg 工程提供了 `devcontainer.json` 配置文件，并配套了一个 Linux 开发镜像构建Dockerfile，搭配的 Go 版本相对较早为 Go 1.19，但可以通过所有示例的测试。如果你对容器操作或 VSCode 容器开发模式比较熟悉，可以直接使用该配置进行开发和测试。
>
> 当然，你也可以选择使用更高版本的 Go 进行测试，例如 Go 1.24。作者已经在 Go 1.24 环境下对所有示例代码进行了完整测试，均能正常运行，建议有条件的同学优先使用较新的 Go 版本。

### 本节小结

本节我们学习了如何通过 Go 代码启动并执行一个外部进程，掌握了使用 `exec.Command` 创建和运行子进程的方法，并能够捕获其输出和错误信息。通过简单的命令行参数解析，实现了 `godbg exec <prog>` 的基本功能，为后续实现调试器的进程控制和调试功能打下了基础。建议读者动手实践，熟悉进程启动和参数校验的流程，为后续章节的深入学习做好准备。

