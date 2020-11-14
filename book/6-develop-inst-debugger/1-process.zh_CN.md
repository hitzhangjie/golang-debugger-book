## 启动进程 

### 实现目标：`godbg exec <prog>`

调试器执行调试，首先得确定要调试的目标。通常目标可能是一个进程实例，或者是一个core文件。

我们先关注如何调试一个进程，core文件只是进程的一个快照，调试器只能查看当时的栈帧情况。对进程进行调试涉及到的方方面面基本覆盖了对core文件进行调试的内容，所以我们先将重点放在对进程调试上。

调试一个进程，主要有以下几种情况：
- 如果进程还未存在，我们需要启动指定进程，如dlv、gdb等指定程序名启动调试时会启动进程；
- 如果进程已经存在，我们需要通过进程pid来挂住进程，如dlv、gdb等通过-p指定pid对运行进程调试；

为了方便开发、调试，调试器可能也包含了编译构建的任务，如保证构建产物中包含调试信息、避免过优化对调试的不利影响等。通常这些操作需要传递特殊的选项给编译器、连接器，对开发者而言并不是一件很友好的事情。考虑到这点，go调试器dlv在执行`dlv debug`命令时，会自动传递`-gcflags="all=-N -l"`选项信息来禁止内联、优化等，来保证生成符合调试需求的构建产物。

下面先介绍下第一种情况，指定程序路径，启动程序创建进程。

我们将实现程序godbg，它支持exec子命令，支持接收参数prog，godbg将启动程序prog并获取其执行结果。

>prog代表一个可执行程序，它可能是一个指向可执行程序的路径，也可能是一个在PATH路径中可以搜索到的可执行程序的名称。


### 基础知识

go标准库提供了对应的函数来完成启动程序创建进程的任务，我们先了解下相关的函数。

通过`exec.Command(...)`方法我们可以创建一个Cmd实例，之后则可以通过`Cmd.Start()`方法来启动程序，如果希望等待程序执行结束并获取执行结果，也可以通过`Cmd.Run()`方法启动程序，然后通过`Cmd.CombineOutput()`来获取程序在stdout、stderr上的输出结果。当然通过`Cmd.Start()`启动进程，之后通过`Cmd.Wait()`等待进程结束再获取结果也是可以的。


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

// WAait 等待cmd执行结束，该方法必须与Start()方法配合使用，返回值error表示执行中遇到错误
//
// Wait等待程序执行结束并获得程序的退出码（也就是返回值，os.Exit(?)将值返回给操作系统），
// 并释放对应的资源(主要是id资源，联想下PCB)
func (c *Cmd) Wait() error
```

### 代码实现

file: main.go

```go
package main

import (
	"fmt"
	"os"
	"os/exec"
)

const (
	usage = "Usage: go run main.go exec <path/to/prog>"

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
- 参数正常情况下，第3个参数应该是一个程序路径或者可执行程序文件名，我们创建一个exec.Cmd对象，然后启动并获取运行结果；

### 代码测试

您可以自己编译构建，完成相关测试。

```bash
go build -o godbg main.go

./godbg exec <prog>
```

ps: 当然也可以考虑将godbg拷贝到PATH路径下进行测试。

现在的程序逻辑单文件就可以完成，相对来说还比较简单，也可以 `go run main.go exec <prog>` 进行测试，如 `go run main.go exec ls`。
