## 目标进程 IO 重定向的设计（godbgv2 未实现）

> **状态**：godbgv2 未实现（❌）。本节为扩展阅读，设计思路可迁移，代码不并入本仓。
> 能力状态以 `godbgv2/docs/FEATURE-MATRIX.md` 为准。

### 为什么需要关心目标进程的 IO

调试时控制被调试进程的输入输出流，是三类很实在的诉求：

1. **交互式程序**：目标需要用户输入（REPL、确认提示、逐条命令），而调试器自己的界面已经占着这个终端。
2. **测试与自动化**：把输入喂进文件、把输出抓到文件，才可能在 CI 里断言程序行为。
3. **调试界面与目标界面分离**：目标程序的 `printf` 与调试器提示符打在同一个终端上，输出会互相穿插，读不下去。

delve 对这三条诉求的回应是 `--tty` 与 `-r` 两个开关。**godbgv2 没有实现这两者**：`godbg exec --help` 里没有 `--tty`，也没有 `-r`。本节因此不谈"godbgv2 怎么用"，只谈"如果要实现，该在哪一层改、几个开关各自的语义边界在哪里"。

### godbgv2 现状：目标进程直接继承调试器的标准流

`pkg/target/process.go` 的 `launchCommand`（`process.go:271`）在启动 tracee 时只做两件事：

```go
progCmd.Stdin = os.Stdin
progCmd.Stdout = os.Stdout
progCmd.Stderr = os.Stderr

progCmd.SysProcAttr = &syscall.SysProcAttr{
	Ptrace:     true, // implies PTRACE_TRACEME
	Setpgid:    true,
	Foreground: false,
}
```

（`process.go:281-289`，原文照录。）

三处细节决定了现状的边界：

- `os.Stdin` / `os.Stdout` / `os.Stderr` 是**调试器进程**的 fd 0/1/2。tracee 经 fork/exec 直接继承它们，godbgv2 不打开任何新文件，也不创建 pty。
- `Setpgid: true` 把 tracee 放进一个新进程组，`Foreground: false` 表示不把这个组设为控制终端的前台组。
- `LaunchOptions` 目前只有 `DisableASLR` 一个字段（`process.go:36`），没有任何与 IO 相关的配置项。

由此有三条已知边界。

**其一，本地模式下 tracee 与 REPL 抢同一个 fd 0。** 调试器的交互界面（`cmd/debug/shell.go`，liner）从 fd 0 读按键，tracee 的 `os.Stdin` 也是同一个 fd 0。目标是交互式程序时，两边从同一个输入源取数据：谁的读操作先到，数据就归谁；两个读者共享同一个文件偏移，谁也拿不回被对方"吃掉"的行。

**其二，按 `SysProcAttr` 的组合推断，tracee 读终端还会被 SIGTTIN 挂起。** tracee 处于后台进程组，读控制终端时内核会发 `SIGTTIN` 让它停下；godbgv2 既没有把终端前台组让给它（`Foreground: false`），也没有为它设置控制终端（不设 `Setctty`）。所以交互式程序在 godbg 下更常见的表现不是"读到错误的输入"，而是"一读就停住"。这一条是从代码推断出的边界，不是本节实测的输出。

**其三，headless 模式下输出留在服务端。** `--headless` 时 tracee 由服务端进程启动，继承的是**服务端**的 fd 1/2。客户端 `godbg connect` 在另一个终端里，看到的是 RPC 的调试界面，看不到 tracee 的 `printf`；客户端和服务端不在一台机器上时更是如此。

这三点合起来是一个明确的范围取舍：godbgv2 面向"让程序停在断点处，看状态、看调用栈、看变量"，而不是"把程序跑完、对比输出"。IO 重定向属于后一类需求，所以本节只作设计讨论。

### 如果实现，可以采用两种设计（delve 的做法）

delve 用两个互相独立的开关覆盖这两类需求，并且不允许同时使用 —— 同时给出 `-r` 与 `--tty` 时直接报错 `Can not use -r and --tty together`（`cmd/dlv/cmds/commands.go:1113-1116`）。下面分别说明。

#### 设计一：把目标接到另一个 TTY（`--tty`）

`--tty` 只注册在 `dlv debug` 与 `dlv exec` 上（`cmd/dlv/cmds/commands.go:270`、`:303`），值是一个**已存在的终端设备路径**，通常是另一对 pty 的一端：

```bash
dlv debug --tty /dev/pts/23
```

delve 的实现很短（`pkg/proc/native/proc_unix.go:13-30`）：

```go
func attachProcessToTTY(process *exec.Cmd, tty string) (*os.File, error) {
	f, err := os.OpenFile(tty, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	if !isatty.IsTerminal(f.Fd()) {
		f.Close()
		return nil, fmt.Errorf("%s is not a terminal", f.Name())
	}
	process.Stdin = f
	process.Stdout = f
	process.Stderr = f
	process.SysProcAttr.Setpgid = false
	process.SysProcAttr.Setsid = true
	process.SysProcAttr.Setctty = true

	return f, nil
}
```

（原文照录，仅去掉空行。）

四个要点值得注意：

1. **必须是终端。** `isatty` 检查挡住"把 `--tty` 当文件重定向用"的误用：目标要的是一个能读写的 tty，不是一个普通文件。
2. **`Setpgid` 要让位。** `Setsid` 新建会话，与"加入/新建进程组"的语义冲突，所以先把 `Setpgid` 置 false。godbgv2 现在恰好是 `Setpgid: true`，加 `--tty` 就必须在这一处做分支，不能只改三行赋值。
3. **`Setctty` 让这个 tty 成为控制终端。** Go 的 `SysProcAttr.Ctty` 指子进程里的描述符号；此处三个 fd 都指向该 tty，`Ctty` 取默认值 0 即可（delve 也没有显式设置）。
4. **父进程保留这个 `*os.File`，只为收尾时关掉它。** delve 把它存进 `dbp.ctty`（`pkg/proc/native/proc_linux.go:114`），它不参与调试器与目标的通信，唯一用途是在进程收尾时 `Close`（字段声明在 `pkg/proc/native/proc.go:38`，关闭在 `:429-430`）。打开的设备节点总得有个归属，这属于资源所有权问题，不是功能。

godbgv2 若要实现，改动点是 `launchCommand` 里的三行赋值与 `SysProcAttr` 组合，再加一个 `LaunchOptions.TTY` 字段；上层 `cmd/exec.go`、`cmd/debug.go` 各加一个 flag。

#### 设计二：把目标的标准流重定向到文件（`-r`）

`-r` 是 delve 的根级持久开关（`cmd/dlv/cmds/commands.go:166`），语义见 `dlv help redirect`：

```text
		-r [source:]destination
```

`source` 取 `stdin` / `stdout` / `stderr` 之一，省略即表示 `stdin`；`destination` 是文件路径，分隔符是**冒号**。`-r` 是**可重复的字符串数组**，每个标准流各写一次：

```bash
dlv exec ./demo -r stdin:input.txt -r stdout:output.txt -r stderr:err.txt
```

两种常见写错法值得先记住：

- 写成 `-r stdin=input.txt`：`parseRedirects` 只认 `stdin:` / `stdout:` / `stderr:` 前缀（带冒号），匹配不上就走"省略 source"的分支，于是**整个 `stdin=input.txt` 被当成 stdin 的文件名**。这个错误要到启动目标进程时才以"打不开文件"的形式暴露出来。
- 写成 `-r stdin=input.txt,stdout=output.txt`（逗号串联）：既踩上面的坑，又凭空造出一个带逗号的文件名。delve 不切逗号，也没有"一条规则里写多个流"的形式。

`-r` 的实现思路与 `--tty` 同构，只是把 tty 换成普通文件：

```go
// 示意：形状取自 delve 的 openRedirects（pkg/proc/native/proc.go:440），
// godbgv2 未实现、未编译验证
func openRedirects(stdinPath, stdoutPath, stderrPath string) (stdin, stdout, stderr *os.File, closefn func(), err error) {
	var toclose []*os.File
	closefn = func() {
		for _, f := range toclose {
			f.Close()
		}
	}
	if stdinPath != "" {
		if stdin, err = os.Open(stdinPath); err != nil {
			return
		}
		toclose = append(toclose, stdin)
	}
	if stdoutPath != "" {
		if stdout, err = os.Create(stdoutPath); err != nil {
			return
		}
		toclose = append(toclose, stdout)
	}
	if stderrPath != "" {
		if stderr, err = os.Create(stderrPath); err != nil {
			return
		}
		toclose = append(toclose, stderr)
	}
	return
}
```

（示意代码。注意 `os.Create` 意味着每次启动都会截断目标文件，想保留多次运行的输出得自己换成 `O_APPEND`；真实实现还要处理"没有重定向时回落到 `os.Stdin`/`os.Stdout`/`os.Stderr`"的分支 —— delve 用一个 `foreground` 参数控制 stdin 的回落。）

两个容易踩的细节：

- **父进程的副本要在 `Start` 之后关掉。** 子进程已经继承自己的 fd 副本，父进程再握着一份只会推迟数据落盘（写文件时 `tail -f` 看到的内容滞后），退出时也不干净。delve 的做法是让 `openRedirects` 返回一个 `closefn`（`pkg/proc/native/proc.go:440`），在 `process.Start()` 之后立刻调用它（`pkg/proc/native/proc_linux.go:73`、`:124`）。
- **重定向时机绑定在"启动"上。** `-r` 只在启动（以及 `restart`）时生效，程序跑起来之后改是无效的；所以 delve 让 `restart` 也能带新的 `-r`（`dlv help redirect` 的原话是 "File redirects can also be changed using the 'restart' command."）。godbgv2 没有 `restart`，这条配套能力也就无从谈起。

#### 两种设计对比

| | `--tty`（重定向到另一个终端） | `-r`（重定向到文件） |
|---|---|---|
| 适合 | 真交互式程序：REPL、依赖终端语义的程序 | 非交互程序、批量输入、输出断言 |
| 输入 | 从另一个终端实时键入 | 一次性从文件读，读完即 EOF |
| 输出 | 实时出现在另一个终端 | 落在文件里，可 diff、可归档 |
| 与调试器界面 | 彻底分开：目标在 pts/X，REPL 留在原终端 | 不与 REPL 抢输出，但输入输出都不可交互 |
| 自动化友好度 | 低：需要 socat/tmux 编排 | 高：脚本准备输入、断言输出 |
| godbgv2 现状 | ❌ 无 `--tty` | ❌ 无 `-r` |

### 使用示例（示意）

下面命令都是 **delve** 的用法，godbgv2 没有这些开关；列出来是为了说明设计意图，同时给读者一个可以拿去对照的形态。所有程序输出块都标注为示意，不是 godbgv2 的运行记录。

#### 交互式程序：`--tty` + socat

先准备一个反复读 stdin 的 demo：

```go
// tty_demo.go
package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

func main() {
	fmt.Println("TTY Demo Program")
	fmt.Println("Type something and press Enter (type 'quit' to exit):")

	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("> ")
		if !scanner.Scan() {
			break
		}
		input := scanner.Text()
		if strings.ToLower(input) == "quit" {
			fmt.Println("Goodbye!")
			break
		}
		fmt.Printf("You typed: %s\n", input)
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "Error reading input: %v\n", err)
		os.Exit(1)
	}
}
```

用 socat 造一对 pty：

```bash
socat -d -d pty,raw,echo=0 pty,raw,echo=0
```

记下输出里的两个 `/dev/pts/N`（例如 `/dev/pts/23` 与 `/dev/pts/24`），把一端交给调试器，自己在另一端操作：

```bash
# 终端 1：调试器；目标程序的标准流接到 /dev/pts/23
dlv debug --tty /dev/pts/23

# 终端 2：接管 pty 的另一端，与目标程序对话
socat - /dev/pts/24
```

终端 2 里看到的会话（**示意**）：

```text
TTY Demo Program
Type something and press Enter (type 'quit' to exit):
> hello
You typed: hello
> quit
Goodbye!
```

要点在这里：此刻 `dlv` 的 REPL 仍在终端 1 等你敲 `continue` / `next`，目标程序的 IO 全在终端 2。这才是 `--tty` 的价值 —— 不是"把输出搬走"，而是"让目标拥有一个属于自己的终端"。

#### 非交互程序：`-r` + 输入文件

```bash
cat > input.txt <<'EOF'
hello
world
quit
EOF

dlv exec ./demo -r stdin:input.txt -r stdout:output.txt -r stderr:output.txt
```

调试期间在另一个终端 `tail -f output.txt` 观察（**示意**）：

```text
TTY Demo Program
Type something and press Enter (type 'quit' to exit):
> hello
You typed: hello
> world
You typed: world
> quit
Goodbye!
```

#### 在 godbgv2 里今天只能这样

不改代码的前提下，能做的只有 shell 层重定向 —— 因为 tracee 继承的就是 `godbg` 自己的 fd：

```bash
godbg exec ./demo < input.txt > output.txt 2>&1
```

它解决"输出留存"，却解决不了输入：REPL 与 tracee 仍共享同一个 fd 0，文件偏移只有一个，两边都会往前走。而且 liner 在非终端输入下能否正常进入交互，本书未经实测（**示意**，不要当作可用配方）。所以这条只是临时手段，不能当成机制。

### 如果给 godbgv2 补上这个能力

按前面的分析，落地清单大致如下（本期不做，列出来是为了说明工作量并不在"加两个 flag"）：

1. **CLI 层**：`cmd/exec.go`、`cmd/debug.go` 加 `--tty`；`-r` 可以只做在启动类子命令上，不必照 delve 做成根级持久开关 —— 对 `attach` 而言它本就没有意义（见第 4 条）。
2. **target 层**：`pkg/target/process.go` 的 `launchCommand` 接收重定向参数，按"tty / 文件 / 继承"三选一设置 `progCmd.Std*` 与 `SysProcAttr`；`LaunchOptions` 需要新字段，注意它当前只有 `DisableASLR`。
3. **生命周期**：`Start` 之后关闭父进程副本；`Kill` / `Detach` / 会话退出时保证 fd 全部释放；将来若实现 `restart`，二次启动要重新解析并打开重定向目标。
4. **边界**：`attach` 的进程早已打开自己的 fd，启动期替换对它不生效；真要支持只能做"调试器代管读写"，那是另一件事，不要和启动期重定向混为一谈。
5. **测试**：这类能力最容易靠"输出文件内容"断言 —— 用 `--init` 回放固定命令序列，比对输出文件。注意 godbgv2 的桩命令是"静默成功"（FEATURE-MATRIX §11 ②），断言要同时检查退出码和文件内容，不能只看退出码。

### 本节小结

目标进程的 IO 重定向在 delve 里由 `--tty` 与 `-r` 两个开关承担，实现本身并不复杂：打开目标文件、三行 `cmd.Std*` 赋值、一组 `SysProcAttr` 开关；难的是它属于"启动期的决定"，tracee 一旦跑起来就只能靠 `restart` 重来。

**godbgv2 没有这个能力**：tracee 直接继承调试器的 `os.Std*`，交互式程序会与 REPL 抢 stdin，headless 模式下 tracee 的输出落在服务端而客户端看不到。这是当前的范围取舍，不是实现疏漏。本节的价值在于把设计讲清楚 —— 真到要动手那天，知道该改 `launchCommand` 的几行、`SysProcAttr` 的哪几项，以及为什么 `Setpgid` 与 `Setsid` 不能同时留着。
