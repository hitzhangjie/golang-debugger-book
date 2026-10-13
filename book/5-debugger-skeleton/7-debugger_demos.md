## 功能演示和实现效果

结合前面的思考，我们初步实现了一个调试器的雏形 [godbg](https://github.com/hitzhangjie/godbgv2)，它大致包含了我们需要的交互能力。后面我们将在此基础上一步步实现指令级调试器、符号级调试器。

先看下godbg的执行效果，然后大致介绍下源码的组织方式，方便读者了解讲解的功能点对应代码的哪一部分，后续新增章节的内容、源码就很容易对应上了。这一版骨架对应配套工程 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch5.4`，`git checkout ch5.4` 即可得到本节的代码，在项目目录下执行 `make install` 即可安装 godbg 到 GOPATH/bin。

### 运行效果

#### 启动调试器 & help信息

`godbg help` 可以查看启动调试器的不同方式，对应着子命令 `exec`、`attach`、`debug`、`core`，当前我们只搭建了调试器的架子，还没有真正完全实现上述几个子命令。`help` 可以查看子命令的使用帮助信息，`version` 显示该调试器的版本。

```bash
$ godbg help
godbg 是一个以学习为目的、从零编写的 go 调试器，
它随《Go 调试器开发指北》(golang-debugger-book) 的章节逐步演进：
- 第6章: 指令级调试 (exec/attach/debug)
- 第9章: 符号级调试 (headless/connect)

Usage:
  godbg [command]

Available Commands:
  attach      跟踪正在运行的进程
  completion  Generate the autocompletion script for the specified shell
  core        调试 core 转储文件
  debug       构建并调试 go 程序
  exec        调试可执行程序
  help        Help about any command
  version     打印版本信息

Flags:
  -h, --help      help for godbg
  -v, --verbose   show verbose info

Use "godbg [command] --help" for more information about a command.
```

#### 进入调试会话 & help信息

`exec`、`attach`、`debug`、`core` 在各自的准备工作做完之后，都会进入同一个交互式调试会话。提示符是“**godbg>**”，在这里可以输入各种调试命令，对目标程序进行执行控制，或者查看信息。

这几个调试命令暂未完全实现，现阶段执行它们会直接进入调试会话，如执行 `godbg exec $(which godbg)`：

```bash
$ godbg exec $(which godbg)
TODO(ch6.1): 启动并跟踪被调试进程
godbg> 
```

现在进入了调试器会话界面，我们可以在提示符 `godbg>` 之后继续输入调试命令。

这里我们输入并执行help，可以列出准备支持的部分调试命令及使用说明。注意，这些命令按照功能进行了不同的分类。

>断点相关的 break、breakpoints、clear、clearall 放在“**[breaks]**”下面，源码相关的 list、disass 放在“**[source]**”下面，执行控制相关的 continue、next、step、finish 放在“**[execute]**”下面，查看信息的 bt、frame、pmem、pregs、ptypes 放在“**[info]**”下面，其余命令放在“**[other]**”。`other` 组末尾的 `completion`、`help` 是 cobra 挂到会话根命令上的内置命令。

```bash
godbg> help
godbg interactive debugging commands

help [command]
  -h, --help   help for help

- [breaks]
  break           :添加断点
  breakpoints     :列出断点
  clear           :移除断点
  clearall        :清空全部断点

- [source]
  disass          :反汇编指定地址的机器指令
  list            :列出源码

- [execute]
  continue        :运行到下一个断点处
  finish          :执行直到当前函数返回
  next            :单步执行（跳过函数调用）
  step            :单指令步进执行

- [info]
  bt              :查看调用栈
  frame           :切换当前栈帧
  pmem            :查看内存数据
  pregs           :查看寄存器数据
  ptypes          :查看变量类型

- [other]
  display         :每停一次打印一次表达式
  exit            :结束调试会话
  set             :修改变量值
  completion      :Generate the autocompletion script for the specified shell
  help            :Help about any command
```

如果想详细了解某一个调试命令如何使用，可以运行“**godbg> help `cmd`**”，如查看 break 命令：

```bash
godbg> help break
添加断点

break <locspec>
  -h, --help   help for break
```

#### 调试会话输入补全

输入补全使用 [liner](https://github.com/peterh/liner)，按键习惯和 bash 接近：按下 Tab，先把已输入的内容补到各个候选项的公共前缀；再按一次 Tab，候选项打印在提示符下方。输入 `cl` 时，第一次 Tab 会补成 `clear`，再按一次就能看到 `clear` 和 `clearall`。什么都不输入、只敲回车，会把上一条命令再执行一遍。

```bash
godbg> cl<tab>      ---
godbg> clear        <-|

godbg> clear<tab>   ---
godbg>                |
clear clearall      <-|
```

#### 调试会话执行命令

这里以显示源码信息为例，来演示如何在调试会话中执行调试动作。调试会话中执行“**godbg> list main.go**”：

```bash
godbg> list main.go
TODO(ch9.2.35): list 尚未实现
```

由于所有调试命令都还未完全实现，所以这里还不会打印源码内容。目前这还只是一个调试器的雏形，架子已经搭好了。

接下来的章节，我们将一步步实现这里的各个命令，先做指令级调试器，再做符号级调试器。`list` 真正按断点地址展示源码，要在介绍完DWARF行号信息表之后，准确地说要在第 9 章才会实现。

### 代码实现

该调试器骨架的代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch5.4`，现在大致看下实现。

#### 目录结构

godbgv2 在这一版的源码目录如下，为了节省篇幅省略了部分命令文件：

```bash
godbgv2                       : 项目根目录
├── main.go                   ：程序入口 main.main
├── cmd                       ：进程级启动命令
│   ├── root.go               : rootCmd，挂上 exec、attach、debug、core、version
│   ├── exec.go
│   ├── attach.go
│   ├── debug.go
│   ├── core.go
│   └── debug                 ：调试会话中可使用的调试命令
│       ├── shell.go          : 调试会话，以及按分组展示的 help
│       ├── break.go
│       ├── breakpoints.go
│       ├── clear.go
│       ├── clearall.go
│       ├── list.go
│       ├── disass.go
│       └── ...
├── go.mod
└── go.sum
```

这一版还只有命令层。各个调试命令都注册好了，函数体里是带章节号的 TODO。符号层、目标层要到后面的章节才加进来。后面讲解某个调试命令时，先到 `cmd/debug/` 下找同名文件即可。

#### 源码解析：调试器启动命令管理

熟悉 cobra 的话，看完 `main.go` 就知道命令是交给 cobra 管的。

```go
package main

import "github.com/hitzhangjie/godbgv2/cmd"

func main() {
	cmd.Execute()
}
```

直接运行 `godbg` 时，cobra 打印前面看到的帮助信息。进入调试会话要走子命令。`exec`、`attach`、`debug`、`core` 分别对应 `cmd/exec.go`、`cmd/attach.go`、`cmd/debug.go`、`cmd/core.go`，它们都挂在 `cmd/root.go` 的 `rootCmd` 上。

```go
var rootCmd = &cobra.Command{
	Use:   "godbg",
	Short: "godbg 是一个面向 go 语言的调试器",
	Long: `godbg 是一个以学习为目的、从零编写的 go 调试器，
它随《Go 调试器开发指北》(golang-debugger-book) 的章节逐步演进：
- 第6章: 指令级调试 (exec/attach/debug)
- 第9章: 符号级调试 (headless/connect)`,
}
```

`godbg exec <prog>` 走 `execCmd`。`Run` 里处理“启动并跟踪进程”，这一节还是 TODO；`PostRun` 里创建调试会话并 `Start()`。`attach`、`debug`、`core` 也是同样的收尾。

```go
var execCmd = &cobra.Command{
	Use:   "exec <prog>",
	Short: "调试可执行程序",
	Long:  `调试可执行程序`,
	Run: func(cmd *cobra.Command, args []string) {
		// TODO(ch6.1): 启动并跟踪被调试进程 (ptrace TRACEME)
		fmt.Println("TODO(ch6.1): 启动并跟踪被调试进程")
	},
	PostRun: func(cmd *cobra.Command, args []string) {
		debug.CurrentSession = debug.NewDebugSession()
		debug.CurrentSession.Start()
	},
}

func init() {
	rootCmd.AddCommand(execCmd)
}
```

进程侧的准备工作做完，就进入调试会话，后面的调试命令都在会话里输入。

#### 源码解析：调试会话调试命令管理

调试会话在 `cmd/debug/shell.go`。读入用 liner，命令分发仍交给 cobra：liner 拿到一行输入，`s.root.SetArgs(args) -> s.root.Execute()`，命令参数解析及执行交给了 `debugRootCmd.Execute()`。

>相当于启动调试器的命令的参数及解析、，命令派遣归rootCmd管，而调试会话中的调试命令的这部分工作归debugRootCmd管。

```go
const prefix = "godbg> "

func NewDebugSession() *DebugSession {
	// 此处省略：把 HelpFunc 设成按分组打印命令
	return &DebugSession{
		done:   make(chan bool),
		prefix: prefix,
		root:   debugRootCmd,
		liner:  liner.NewLiner(),
	}
}

func (s *DebugSession) Start() {
	s.liner.SetCompleter(completer)
	s.liner.SetTabCompletionStyle(liner.TabPrints)

	for {
		select {
		case <-s.done:
			s.liner.Close()
			return
		default:
		}

		txt, err := s.liner.Prompt(s.prefix)
		if err != nil {
			panic(err)
		}

		txt = strings.TrimSpace(txt)
		if len(txt) != 0 {
			s.last = txt
			s.liner.AppendHistory(txt)
		} else {
			txt = s.last
		}

		s.root.SetArgs(strings.Split(txt, " "))
		s.root.Execute()
	}
}
```

`TabPrints` 就是 bash 那种补全：候选项打印在提示符下方。空行会改去执行 `s.last`，所以只敲回车等于重复上一条命令。`completer` 只补命令名和别名。

```go
func completer(line string) []string {
	cmds := []string{}
	for _, c := range debugRootCmd.Commands() {
		if strings.HasPrefix(c.Use, line) {
			cmds = append(cmds, strings.Split(c.Use, " ")[0])
		}
		for _, alias := range c.Aliases {
			if strings.HasPrefix(alias, line) {
				cmds = append(cmds, alias)
			}
		}
	}
	return cmds
}
```

命令通过 annotation 归到分组，`help` 时按组打印。`list` 在 source 组，别名是 `ls` 和 `l`。这一版的 completer 只处理命令名和别名；按源文件名补全参数，是 5.4 节里 cobra-prompt 演示过的能力，当前骨架里暂时没有采用。

```go
var listCmd = &cobra.Command{
	Use:     "list [locspec]",
	Short:   "列出源码",
	Aliases: []string{"ls", "l"},
	Annotations: map[string]string{
		cmdGroupAnnotation: cmdGroupSource,
	},
	Run: func(cmd *cobra.Command, args []string) {
		// TODO(ch9.2.35): 基于行号表展示源码
		fmt.Println("TODO(ch9.2.35): list 尚未实现")
	},
}
```

调试会话中运行 `list main.go`：

```bash
godbg> list main.go
TODO(ch9.2.35): list 尚未实现
```

命令已经能执行，只是还停在占位输出上。后面的章节会把这些 TODO 换成真正的调试动作。

现在，我们大致介绍了 godbg 的一个相对完整的骨架，相信读者朋友们已经跃跃欲试想进入下一步的开发了 :) 。

### 本节小结

至此，本章从需求、架构到实施方案，收进了一个能运行的 godbg 雏形里。我们演示了godbg如何启动调试，以及调试会话中调试命令的组织方式，还展示了命令及选项如何唤出帮助信息。然后，我们结合 godbgv2 的 tag `ch5.4`，演示了截止到目前项目源代码的组织方式，包括项目结构、程序入口、启动命令管理、调试会话命令管理，我们特别介绍了调试会话的设计及实现，包括对不同调试命令进行分组展示、支持liner输入补全、支持cobra对不同子命令进行管理、参数解析、执行派遣。

godbg tag `ch5.4`，这是我们提供给读者的一个可运行的调试器骨架，其中很多命令还是未实现状态。接下来我们将逐渐实现、丰富这些调试命令，并推进到更现代的调试器架构。第6章实现指令级调试器，完成进程的启动与跟踪、断点、单步，以及内存和寄存器的查看与修改，并支持多线程、多进程调试。第7章补齐走向符号级调试的基础，介绍 ELF、编译与链接，以及调试信息如何生成、存放。第8章剖析 DWARF，说明它如何描述源码、类型、变量和调用栈。第9章实现符号级调试器，支持源码级断点、单步，以及变量、栈帧和 goroutine 的查看，并把前后端分离落成可远程调试、可接入 IDE 的形态。第10章进行一些调试相关的高级话题和讨论。
