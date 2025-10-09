## 启动调试：启动进程

### 实现目标：`godbg exec <prog>` 启动新进程

调试器执行调试，首先得确定要调试的目标。它可能是一个进程实例，或者是一个core文件。为了便利性，调试器也可以代为执行编译操作，如 `dlv debug [main module] | [test package]`，会自动对main module或者test package进行编译构建。

我们先关注如何对一个运行中的进程进行调试，这是本章指令级调试部分的重点。core文件是为进程生成的运行时内核转储文件，包含了进程结束前的内存、硬件上下文信息。调试器可以分析core文件来了解当时的进程执行情况，如程序crash之前的调用栈信息。对运行中的进程可以执行的调试操作，覆盖了对core文件能执行的操作。所以本章优先介绍对运行中的进程进行调试，对core文件的调试支持（包括core文件构成、生成、调试）我们将在符号级调试部分再进行介绍。

调试一个进程，主要有以下几种情况：

- 如果目标程序 `<prog>`已构建好，但是没有运行：我们需要启动程序并跟踪进程，如 `dlv exec <prog>`、`gdb <prog>`；
- 如果目标程序还没有进行构建，要先构建然后运行：我们需要传递相关的编译选项，确保生成必要的调试信息、关闭编译优化，如 `dlv debug`、`dlv test`；
  dlv自动构建时会自动传递 `-gcflags="all=-N -l"`选项来禁用编译构建过程中的内联、优化，以保证构建产物满足调试器调试需要。
- 如果目标程序已经运行，且已经确认了进程pid：我们需要通过进程pid来跟踪进程，如 `dlv attach <pid>`、`gdb <pid>`；

OK，我们先介绍第一种情况，启动构建好的程序并执行调试。

本节呢，我们先介绍如何启动一个目标程序，得到一个运行中的进程，等待程序执行结束，并获取运行结果。下一节我们再介绍如何启动并跟踪进程执行。

### 基础知识

我们一步步实现指令级调试器godbg，首先为它添加第一个调试命令 `godbg exec <prog>`：

- exec命令接收参数prog、启动程序prog并获取其执行结果；
- prog参数为可执行程序的文件路径，或者一个可执行程序的名字，这个名字在 `$PATH` 搜索路径中可以搜索到。

在SHELL中只要键入可执行程序路径或者程序名就可以启动程序，在stdout、stderr获取程序运行时输出，并可以通过 `$?` 获取进程返回值。那么在Go编程中应该如何实现这些操作呢？Go标准库提供了 `os/exec` 包，允许指定程序路径、程序名来启动进程，并获取输出信息、执行结果。

通过 `cmd = exec.Command(...)`方法我们可以创建一个 `exec.Cmd` 实例：

- 之后则可以通过 `err := cmd.Start()`方法来启动程序，继续执行 `err := cmd.Wait() 可以`等待进程结束，然后可以再获取结果；
- 如果希望启动程序并一直等待到进程执行结束，也可以通过 `err := cmd.Run()` 来代替上述 `err := cmd.Start() + err := cmd.Wait()`；
- 如果希望获取进程执行期间输出到stdout、stderr的信息，可以在启动前修改 `cmd.Stdout`、`cmd.Stderr` 指向一个bytes.Buffer收集起来；

如果您感觉上述操作比较复杂，想寻求更简化的操作实现，别急真的有：

- 如果希望启动程序并等待执行结束，同时能获取stdout、stderr输出信息，可以通过 `buf, err := Cmd.CombineOutput()` 来完成。

其中err表示进程启动、执行期间是否出错，buf中记录了执行期间输出到stdout、stderr的信息：

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

下面基于go标准库 `os/exec` package来演示如何启动程序创建进程实例。示例代码详见：golang-debugger-lessons/1_process_start。

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
  - `godbg exec <prog>`，`os.Args` 至少有3个参数，如果参数数量不对，直接报错退出；
  - 接下来校验第2个参数，如果  `os.Args[1]` 不是exec，也直接报错退出；
- 参数正常情况下，第3个参数 `os.Args[2]` 应该是一个程序路径或者程序名，我们准备一个exec.Cmd对象，然后启动并获取运行结果；

### 代码测试

执行以下命令先完成程序构建，然后执行程序进行测试：

```bash
1_start-process $ GO111MODULE=off go build -o godbg main.go

./godbg exec <prog>
```

后续随着功能越来越多，我们会分包分文件管理，此时就需要对整个module进行go build再测试，或者直接go install之后再测试。当前示例代码只有一个简单的源文件，`go run main.go` 就可以快速测试，如在目录golang-debugger-lessons/1_start-process下执行 `GO111MODULE=off go run main.go exec ls` 。

```bash
1_start-process $ GO111MODULE=off go run main.go exec ls
tracee pid: 270
main.go
README.md
```

godbg正常执行了命令ls并显示出了当前目录下的文件 `main.go README.md` ，目标进程ls被正常执行了，并且我们成功获得了ls的执行结果。

### 本节小结

本节我们学习了如何通过 Go 代码启动并执行一个外部进程，掌握了使用 `exec.Command` 创建和运行子进程的方法，并能够捕获其输出和错误信息。通过简单的命令行参数解析，实现了 `godbg exec <prog>` 的基本功能，为后续实现调试器的进程控制和调试功能打下了基础。建议读者动手实践，熟悉进程启动和参数校验的流程，为后续章节的深入学习做好准备。
