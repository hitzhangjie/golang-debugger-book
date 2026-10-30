## 冒烟测试机制的设计与实现

上一节把调试会话退出时的清理善后补齐了。至此，6.1~6.4 节已经能把调试器"架起来"：启动、attach、编译并调试目标，进入调试会话，退出时按调试发起方式善后。但从这一节开始，书里要大量出现具体的调试命令和运行输出，怎么保证书中的示例、godbgv2 的设计实现、实际运行效果三者始终一致？

交互式输入在自动化场景下并不好用：命令一多，逐条手敲又慢又容易出错；回归测试、冒烟测试没法靠人肉输入；复盘某个调试过程时，希望把步骤存成脚本一键回放。gdb 有 `-x/--command` 选项，dlv 支持 starlark 脚本，godbg 对应的能力是 `--init <file>`：启动调试会话时，把文件里的调试命令逐条回放一遍。回放本身不是目的，它是为冒烟测试服务的：驱动器给会话喂脚本，会话输出结果，驱动器再核对结果是否符合预期。

本节配套代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.5`，`git diff ch6.4 ch6.5` 可以看到这一节改了什么。

### 实现目标：`--init` 回放 + `smoke.sh` 驱动，一次建成完整的冒烟测试机制

冒烟测试机制（smoke harness）的目标很直接：在书籍内容、代码频繁修改的过程中，尽早暴露"书中示例、godbgv2 实现、实际输出"不一致的修改。作者本地修改和 CI 都跑同一套机制，通过后才合入。

这套机制由三部分组成：

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| 冒烟用例 | `testdata/script/*.txt` | 输入调试命令与期望输出，一个书稿小节一个脚本 |
| 回放引擎 | `godbg --init <file>` | 在调试会话内逐行执行用例中的调试命令，打印输出 |
| 驱动器 | `scripts/smoke.sh` | 准备环境、启动会话、按片段切分输出、逐条核对断言 |

`--init` 是 rootCmd 上的持久选项，exec、attach、debug、core 都支持：

```bash
./godbg exec _fixtures/loop --init ./testdata/script/ch6.5.txt
./godbg attach <pid> --init ./init.txt
./godbg debug ./examples/debuggee/ --init ./init.txt
```

指定 `--init` 后，会话进入批量模式（batch mode）：逐行读脚本、逐条执行调试命令，全部回放完自动退出。回放结束和交互式 `exit` 一样，会走到 6.4 节注册的 `Cleanup`，按 Kind 做退出善后。

本节一次性讲清冒烟测试机制的设计实现，后续章节只需要增加对应的 `testdata/script/*.txt` 用例文件，不再重复发明这套机制。

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

#### 会话装配：把 --init 接进 startDebugSession

6.4 节的 `startDebugSession` 只负责注册退出善后，本节在里面读取 `--init`，有脚本就交给会话回放：

```go
func startDebugSession(cmd *cobra.Command) {
	initFile, _ := cmd.Flags().GetString("init")

	// 会话退出（含 --init 批量回放结束）时，按调试发起方式统一善后：
	// exec/debug 启动的进程杀掉，attach 的进程 detach。
	debug.CurrentSession = debug.NewDebugSession().AtExit(func() {
		debug.Cleanup(Client)
	})
	if initFile != "" {
		debug.CurrentSession.SetInitFile(initFile)
	}
	debug.CurrentSession.Start()
}
```

#### 回放引擎：cmd/debug/shell.go

`DebugSession` 增加两个字段：`initFile`（启动脚本路径）、`stopped`（会话是否已请求结束）：

```go
type DebugSession struct {
	done   chan bool
	prefix string
	root   *cobra.Command
	liner  *liner.State
	last   string

	initFile string // 会话启动时要回放的脚本文件（非交互模式）
	stopped  bool   // 会话是否已请求结束

	defers []func()
}
```

`SetInitFile` 链式设置脚本路径。`Start` 里如果 `initFile` 非空，先回放脚本并直接返回，不再进入读输入的主循环。配合这处改动，`NewDebugSession` 不再在构造时就创建 liner，而是等真正进入交互模式再创建：

```go
// Start 启动交互式会话，读取用户输入并分发到对应调试命令。
// 如果设置了 init 脚本，则逐行回放脚本内容后退出（批量模式，
// 供脚本化调试与冒烟测试使用）。
func (s *DebugSession) Start() {
	defer func() {
		for idx := len(s.defers) - 1; idx >= 0; idx-- {
			s.defers[idx]()
		}
	}()

	// 回放 init 脚本，回放结束后退出会话。
	//
	// 批量模式不创建 liner：liner.Close 会无条件对 stdin 做 tcsetattr
	// 恢复终端模式，而冒烟测试用 `timeout 30 ./godbg ...` 启动会话——
	// GNU timeout 默认把子进程放进新的进程组，godbg 于是是终端的后台
	// 进程组；后台进程组对终端做 tcsetattr 会被内核以 SIGTTOU 停止
	// （进程状态 T），timeout 到点后发的 SIGTERM 只能 pending，而
	// timeout 不带 -k 时会一直等待子进程退出，整个 make smoke 永久挂起。
	// 批量模式从不读写终端，不需要恢复任何终端模式。
	if s.initFile != "" {
		if err := s.replay(s.initFile); err != nil {
			fmt.Fprintf(os.Stderr, "replay init file %s error: %v\n", s.initFile, err)
		}
		return
	}

	s.liner = liner.NewLiner()
	s.liner.SetCompleter(completer)
	s.liner.SetTabCompletionStyle(liner.TabPrints)
	defer s.liner.Close()

	for {
		// ...（读输入的主循环不变，执行命令统一走 s.execute(txt)）
	}
}
```

为什么要绕开 liner？`liner.Close()` 会无条件对 stdin 做 `tcsetattr` 恢复终端模式。手动在终端里运行 godbg 时，进程处于前台进程组，这个调用合法；但冒烟测试用 `timeout ./godbg ...` 启动会话时，GNU timeout 默认把子命令放进新的进程组，godbg 于是成了终端的后台进程组——后台进程组对终端做 `tcsetattr`，内核会投递 SIGTTOU，把整个进程停住（状态 T）。timeout 到点后发的 SIGTERM 对已停止的进程只能保持 pending，而 timeout 不带 `-k` 时会一直等待子进程退出，最终表现为 `make smoke` 永久挂起而不是报错。批量模式从不读写终端，本来就不需要恢复终端模式；不创建 liner 是比"忽略 SIGTTOU"更干净的修法。

`replay` 逐行处理脚本：

```go
// replay 逐行回放脚本中的调试命令：
// '#' 为注释；'!'、'=' 与 '@spawn/@delay/@set/...' 是冒烟测试脚本的
// 宿主指令（由 scripts/smoke.sh 处理），会话回放时跳过；
// '@capture <var> <re>' 由回放器自身处理：从上一
// 命令的输出中提取正则的第一个捕获组存入 $<var>，后续命令行
// 中的 $<var> 在执行前替换——线程 id 等只存在于本次会话输出
// 中的值（跨会话无意义）可经此在同一会话内传递。
func (s *DebugSession) replay(file string) error {
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()

	caps := map[string]string{}
	var lastOut []byte // 上一命令的输出（@capture 的来源）

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" ||
			strings.HasPrefix(line, "#") ||
			strings.HasPrefix(line, "!") ||
			strings.HasPrefix(line, "=") {
			continue
		}
		if strings.HasPrefix(line, "@") {
			if strings.HasPrefix(line, "@capture ") {
				rest := strings.TrimSpace(line[len("@capture "):])
				fields := strings.SplitN(rest, " ", 2)
				if len(fields) != 2 {
					return fmt.Errorf("@capture: usage: @capture <var> <regexp>")
				}
				pat := strings.Trim(fields[1], "'")
				re, err := regexp.Compile(pat)
				if err != nil {
					return fmt.Errorf("@capture: invalid regexp %q: %v", pat, err)
				}
				m := re.FindSubmatch(lastOut)
				if len(m) < 2 {
					return fmt.Errorf("@capture %s: no match for %q in last command output", fields[0], pat)
				}
				caps[fields[0]] = string(m[1])
			}
			continue
		}

		// $<var> 替换（@capture 提取的值）
		for name, val := range caps {
			line = strings.ReplaceAll(line, "$"+name, val)
		}

		fmt.Printf("godbg> %s\n", line)

		// 捕获本命令输出供 @capture 使用：临时重定向 os.Stdout
		// 到管道，执行后先读全缓冲再回写真实 stdout（命令输出
		// 量小，管道缓冲足够，不会死锁）
		r, w, err := os.Pipe()
		if err != nil {
			return err
		}
		old := os.Stdout
		os.Stdout = w
		err = s.execute(line)
		w.Close()
		os.Stdout = old
		out, _ := io.ReadAll(r)
		r.Close()
		if len(out) > 0 {
			os.Stdout.Write(out)
		}
		lastOut = out
		if err != nil {
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

- 回放脚本里的空行、`#` 注释行跳过；
- 以 `!` 或 `=` 开头的行是冒烟脚本的宿主指令，这段回放不执行。`!=` 也以 `!` 开头，因此不会被当成调试命令；smoke 在宿主侧把 `!=` 认成反向断言，把其余的 `!` 认成 shell。其余 `@` 开头的指令（`@spawn`、`@delay`、`@skip-if`、`@set` 等）同样交给 smoke.sh，回放时跳过；
- `@capture` 例外，由回放器自己处理：从上一命令的输出里用正则取出第一个捕获组，存进 `$<var>`，后续命令行在执行前替换。为了拿到"上一命令的输出"，回放器执行命令时把 `os.Stdout` 临时重定向到管道，执行完读出全部输出、回写终端，同时留给下一条 `@capture` 使用；线程 id 这类只存在于本次会话输出里的值，靠它在同一会话内传递；
- 其余行按空格切成命令与参数，交给 `s.execute` 执行；每行回显成 `godbg> ...`，方便对照输出；
- `exit` 等命令执行后会把 `s.stopped` 置位（`Stop` 里置位），回放提前结束。

`replay` 和交互模式一样，都通过 `s.execute` 执行命令。`execute`/`resetFlags` 是 5.7 节调试会话骨架里就有的命令执行逻辑（每条命令执行后复位 flag，避免选项跨命令残留），本节直接复用，不再展开。

> ps：上述代码取自 hitzhangjie/godbgv2 的 tag `ch6.5`。`--init`、回放器是本节新增；`execute`/`resetFlags` 在 5.7 节已经具备，`AtExit`、`Cleanup` 是 6.4 节已有的实现。

#### 冒烟驱动器：scripts/smoke.sh 与用例 DSL

回放器只负责在会话内执行调试命令。用例里还需要表达"怎么启动调试器""会话开始前先做什么""输出应该匹配什么"，这些由驱动器 `scripts/smoke.sh` 处理。用例脚本是一份迷你 DSL：

- 调试命令：和交互会话里敲的一样，由回放器执行；
- `#`：注释。smoke 和回放都忽略；
- `!`：宿主 shell。只由 `scripts/smoke.sh` 执行，回放跳过。需要在会话外看一眼进程、文件或环境时用它；
- `=` 与 `!=`：断言，只由 smoke 核对。它们绑定最近一条 godbg 命令的输出：`=` 要求匹配，`!=` 要求不匹配。前面命令已经打出来的文本不参加这一条断言。`!=` 开头的行是反向断言，其余以 `!` 开头的行才是宿主 shell；
- `@spawn`、`@attach`、`@exec`：会话开始前，由 smoke 把调试器和被调试进程对上，选择调试器以哪种入口接进去；
- `@delay <secs> <cmd>`：会话进行中的延迟执行。smoke 在会话开始前把命令挂到后台，计时 `<secs>` 秒后再执行，用来在调试会话进行到某个时刻投递信号、改文件等；回放不会把它当成调试命令；
- `@skip-if <cmd>`：能力探测。smoke 在会话开始前执行 `<cmd>`，退出码为 0 时跳过当前用例并视为通过（例如当前内核不支持硬件监视点），回放不会把它当成调试命令；
- `@set`：会话开始前的设置，由 smoke 在拉起 godbg 之前写入。此时还没有调试命令可以替换；
- `@capture`：会话内。回放器替换进后续调试命令，smoke 替换进断言。

`@set` 在会话前，`@capture` 在会话内。前者准备的是这次运行的环境，后者留下的是会话已经跑起来之后、输出里出现的值。参数、替换记号和条件的写法都在 godbgv2 的 [docs/SMOKE-HARNESS.md](https://github.com/hitzhangjie/godbgv2/blob/master/docs/SMOKE-HARNESS.md) 里，这里不展开。

驱动器对每个脚本分三个阶段：

1. **会话前**：扫描 `@spawn/@attach/@exec` 确定启动方式；执行 `!` 宿主命令；调度 `@delay`；执行 `@skip-if` 探测；执行 `@set`；
2. **会话中**：`timeout -k 5 30 ./godbg exec ... --init <runfile>`，把输出捕获到文件；
3. **会话后**：按回显标记 `godbg> ` 把输出切成逐命令片段，再走查脚本，`=`/`!=` 断言作用于"最近一条 godbg 命令"的片段，`@capture` 提取捕获组并代入后续断言。

Makefile 里提供了统一入口：

```make
# make smoke              run every smoke script under testdata/script/
# make smoke S=ch6.5      run one section's smoke script
# (harness 机制详见 docs/SMOKE-HARNESS.md)
smoke: build fixtures
	bash scripts/smoke.sh $(if $(S),$(S),)
```

本节对应的冒烟用例是 `testdata/script/ch6.5.txt`：

```text
# ch6.5 smoke: 验证调试会话可脚本化回放（--init 批量模式），退出时善后
help
=godbg interactive debugging commands
=\[breaks\]
=\[execute\]
=\[info\]
exit
# 会话退出（含批量回放结束）时按 Kind 善后：exec 启动的 tracee 被 kill
=tracee is run by tracer, kill it
```

这条用例先回放 `help`，并用 `=` 断言输出里会出现交互命令的总标题，以及 `[breaks]`、`[execute]`、`[info]` 这几个命令分组；接着回放 `exit`，结束这次调试会话；最后再断言退出时的善后日志 `tracee is run by tracer, kill it`，也就是 exec 启动的 tracee 会在会话结束时被杀掉。用例不长，它守住的是「调试会话可以按脚本回放，并且退出时会按 Kind 做善后」。

### 运行效果

先确认代码版本并构建：

```bash
git checkout ch6.5
make build
make fixtures
```

用 `--init` 回放本节用例：

```bash
$ ./godbg exec _fixtures/loop --init ./testdata/script/ch6.5.txt
process 287677 launched, stopped by SIGTRAP
godbg> help
godbg interactive debugging commands

help [command]
  -h, --help   help for help

[breaks]
  ...（分组展示，与 5.7 节一致）
godbg> exit
tracee is run by tracer, kill it
```

每条回放的命令都带 `godbg>` 前缀回显，与交互模式下的观感一致；help 的输出和 5.7 节演示的一致；exit 之后会话结束，`AtExit` 注册的 `Cleanup` 运行，输出 `tracee is run by tracer, kill it`，exec 启动的 tracee 被终止。

用冒烟测试跑一遍：

```bash
$ make smoke S=ch6.5
smoke: running testdata/script/ch6.5.txt
smoke: all passed
```

`make smoke` 会先构建调试器与 fixtures，再驱动 `scripts/smoke.sh`：调试命令经 `--init` 回放，`=` 按最近一条 godbg 命令的输出核对。本地和 CI 走的是同一套脚本。

后续各个章节只要涉及示例代码，一般都会新增一份对应的冒烟测试用例文件。冒烟驱动器 `scripts/smoke.sh` 和会话内的回放器，必需的代码在本节已经基本完全实现；后面主要是增加用例文件，而不是再改这一套机制。

### 本节小结

本节实现了调试会话的脚本回放（`--init`）和完整的冒烟测试机制：用例脚本表达输入与期望输出，回放器在会话内执行命令，驱动器在会话外核对断言。这套机制为后面每一节的示例提供了可重复验证的基础；6.4 节实现的退出善后也被复用到了批量回放结束的路径上。

从 6.6 节开始，我们进入调试会话内部，逐个实现真正的调试命令，第一个是 `disass` 反汇编；对应该节的冒烟脚本会跟着示例一起出现，harness 不再另讲。
