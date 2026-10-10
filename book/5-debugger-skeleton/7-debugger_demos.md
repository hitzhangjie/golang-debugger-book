## 功能演示和实现效果

结合前面的思考，我们初步实现了一个调试器的雏形 `godbg`，它大致包含了我们需要的交互能力。后面我们将在此基础上一步步实现指令级调试器、符号级调试器。

先看下godbg的执行效果，然后大致介绍下源码的组织方式，方便读者了解讲解的功能点对应代码的哪一部分，后续新增章节的内容、源码就很容易对应上了。这一版骨架对应配套工程 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch5.4`，`git checkout ch5.4` 即可得到本节的代码。

### 运行效果

#### 调试器帮助信息

`godbg help`用于展示启动调试器时的使用帮助信息。可以看到它有几个子命令：`exec`、`attach`、`debug`、`core` 分别对应不同的启动方式，`version` 用来区分 godbgv2 和旧的同名二进制，`help` 用来查看 godbg 及上述命令的使用帮助。

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

#### 调试器调试会话界面

`exec`、`attach`、`debug`、`core` 在各自的准备工作做完之后，都会进入同一个交互式调试会话。提示符是“**godbg>**”，调试命令都在这里输入。

会话启动后，终端上只有这个提示符。输入补全使用 [liner](https://github.com/peterh/liner)，按键习惯和 bash 接近：按下 Tab，先把已输入的内容补到各个候选项的公共前缀；再按一次 Tab，候选项打印在提示符下方。输入 `cl` 时，第一次 Tab 会补成 `clear`，再按一次就能看到 `clear` 和 `clearall`。什么都不输入、只敲回车，会把上一条命令再执行一遍。

cobra-prompt 那种弹出候选列表的效果，5.4 节已经配了截图。本节骨架（tag `ch5.4`）采用的是 liner，这里不再重复那几张图。

#### 会话中显示帮助信息

调试器调试会话中支持多个调试命令，各调试命令的功能是什么，又如何使用呢？

在调试器内部运行帮助命令“**godbg> help**”，就可以列出调试器已经支持的所有命令及其功能说明，并且对这些命令按照功能进行了归类。断点相关的 break、breakpoints、clear、clearall 放在“**[breaks]**”下面，源码相关的 list、disass 放在“**[source]**”下面，执行控制相关的 continue、next、step、finish 放在“**[execute]**”下面，查看信息的 bt、frame、pmem、pregs、ptypes 放在“**[info]**”下面，其余命令放在“**[other]**”。

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

`other` 组末尾的 `completion`、`help` 是 cobra 挂到会话根命令上的内置命令。如果想详细了解某一个调试命令如何使用，可以运行“**godbg> help `cmd`**”，如查看 break 命令：

```bash
godbg> help break
添加断点

break <locspec>
  -h, --help   help for break
```

#### 会话中执行调试命令

这里以显示源码信息为例，来演示如何在调试会话中执行调试动作。调试会话中执行“**godbg> list main.go**”：

```bash
godbg> list main.go
TODO(ch9.2.35): list 尚未实现
```

输出的是一行占位说明，源码本身还不会打印出来。别急，目前这还只是一个调试器的雏形，架子已经搭好了。接下来的章节，我们将一步步实现这里的各个命令，先做指令级调试器，再做符号级调试器。`list` 真正按行号表展示源码，要到第 9 章。

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

#### 源码解析：命令管理逻辑

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

调试会话在 `cmd/debug/shell.go`。读入用 liner，命令分发仍交给 cobra：liner 拿到一行输入，`SetArgs` 之后调用 `debugRootCmd.Execute()`。

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

本节主要探讨了调试器雏形 godbg 的运行效果和骨架代码，核心内容包括：`godbg help` 展示的启动命令；以 `godbg>` 为提示符、用 liner 做命令补全的调试会话；按分组展示的 `help`，以及尚未实现的调试命令桩。配套代码在 godbgv2 的 tag `ch5.4`。本节内容为读者学习后续的指令级调试、符号级调试打下了骨架上的基础。
