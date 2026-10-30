## 结束调试时断点清理

6.4 节实现 `Cleanup` 时，调试器里还没有支持断点，所以在结束调试时我们只做了被调试进程层面的清理善后：exec、debug 启动的 tracee 杀掉，attach 跟踪的则 detach。6.7~6.10 节我们支持了软件动态断点——`break` 会把目标地址处指令的首字节 patch 成 `0xCC`（int3）。如果我们结束调试时，调试器退出前没有完成指令还原的操作，那么这个断点就会残留在 tracee 里。

本节我们要补上结束调试时断点清理这个能力。

### 问题背景：断点残留的危害

exec、debug 启动的 tracee 退出时直接杀掉，进程没了那么自然也就没有断点残留的影响了，也不存在什么危害了。除非我们允许用户选择detach让这两类主动启动的进程也能继续运行。对于attach的进程，往往结束调试时，我们需要detach，当然也可以让用户选择是否kill掉这个进程。

> 这里"杀掉就没残留"有个隐含前提：断点只落在 tracee 的进程私有内存里。同一个二进制程序的多个实例，对其中一个实例下断点，其他实例、磁盘上的二进制都看不到这次 patch，这是加载和写入两层机制共同保证的：
>
> - **共享加载**：同一个二进制的多个实例，`.text` 段是 file-backed 映射——内核把可执行文件读进 page cache，各进程以只读的 `MAP_PRIVATE`（私有映射）共享同一批物理页；
> - **强制写**：ptrace 的 `PTRACE_POKETEXT` 走 `access_process_vm`（get_user_pages 带 `FOLL_FORCE`），能绕过只读保护把 `0xCC` 写进目标进程；
> - **写时复制**：尽管绕过了保护位，COW 语义依然生效——写入只读的 file-backed 页必然触发 copy-on-write，目标进程拿到一份自己的匿名私有页，`0xCC` 落在这份副本上。值得强调的是，file-backed 的 `MAP_PRIVATE` 页即使只有一个映射者，写时也必然 COW，不能写穿到 page cache，否则会弄脏磁盘上的文件内容；
> - **随进程销毁**：杀掉 tracee 后，私有副本页随进程一起回收。磁盘文件、page cache 原页都没被动过，之后新启动的实例读到的仍是原始指令。
>
> 唯一的例外是 fork：子进程会继承父进程 COW 后的私有页。如果父进程存在断点，子进程通过父进程fork而来，调试器只杀掉父进程、子进程存活，断点就仍留在子进程里，这留到 6.19 节多进程调试时再展开。

如果我们选择detach让被调试进程继续执行，如果tracee中存在断点，一旦执行到残留的断点：

1. **指令不完整**：断点只替换了多字节指令的首字节，tracee 执行到这里拿到的是残缺指令；
2. **触发 SIGTRAP**：`int3` 会触发 SIGTRAP；
3. **进程终止**：tracer 已经 detach，SIGTRAP 没有接收者。默认动作是终止进程并产生 core dump；Go 程序更特殊，runtime 自己接管了 SIGTRAP，把它当成运行时崩溃，打印 goroutine 栈后退出。

"代码测试"里的场景一就是第 3 点的完整演示。

本节配套代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.11`，`git diff ch6.10 ch6.11` 可以看到这一节的改动。核心只有一处：`Cleanup` 在按 Kind 善后之前先调用 `Client.ClearAll()` 还原全部断点，其他调整可以忽略不计。

### 实现目标：退出前自动还原断点

一句话：无论正常退出（`exit`、`--init` 批量回放结束）还是信号退出（SIGINT/SIGTERM/SIGQUIT），退出前都先还原全部断点，再做 6.4 节的进程善后。

### 代码实现

`ClearAll` 在 6.10 节已经实现（`api.Client`、`debugger` 门面、目标层各有一份），AtExit 机制是 5.7 节搭骨架、6.4 节已经用上的。本节只做接线，代码实现就两块：`Cleanup` 补一步还原断点，信号退出路径补上清理。

#### Cleanup 补一步：先还原断点，再处理进程

`Cleanup` 在原有 Kind 分派之前新增一步 `ClearAll`：

```go
// Cleanup 清理调试会话：还原全部断点，并按调试发起方式对被调试进程
// 善后处理——
//
//   - debug/exec: 被调试进程由调试器创建，杀掉；
//   - attach:     被调试进程原本独立运行，分离使其继续运行。
//
// 构建产物的删除由 cmd 层的 debug 命令自行处理（会话结束后移除）。
func Cleanup() {
	if Client == nil {
		return
	}

	// 还原全部断点
	if err := Client.ClearAll(); err != nil {
		fmt.Fprintf(os.Stderr, "clearall failed err: %v\n", err)
	}

	st, err := Client.State()
	if err != nil {
		fmt.Fprintf(os.Stderr, "get state error: %v\n", err)
		return
	}

	switch st.Kind {
	    // 同 6.4 节：debug/exec 分支 Kill，attach 分支 Detach
        ...
	}
}
```


注意：**先还原断点，再处理进程**，顺序不能反：attach 场景如果先 `Detach`，tracee 恢复运行后可能撞上残留断点，得到的就是场景一的后果

`ClearAll` 目前只还原指令字节，不回退停在断点处线程的 PC，这留到 6.18.5 处理。本节场景里 tracee 停在启动位置或 attach 后的 SIGSTOP，没有线程停在断点上，不受影响。

#### 信号退出路径：补上 ch6.10 留下的 TODO

会话正常退出（`exit` 命令、`--init` 回放结束）都从 `Start` 返回，AtExit 注册的 `Cleanup` 自动执行，这条路径 6.4 节已经打通。本节只在注册处把闭包换成函数引用：

```go
// cmd/session.go, startDebugSession
debug.CurrentSession = debug.NewDebugSession().AtExit(debug.Cleanup)
```

没打通的是信号退出。6.4 节 `main.go` 的 `processSignals` 收到 SIGTERM/SIGINT/SIGQUIT 时留了个 TODO，直接 `os.Exit(1)`——`Start` 里的 defer 覆盖不到 `os.Exit`，AtExit 注册的清理不会执行。本节把 TODO 补上：

```go
case syscall.SIGTERM, syscall.SIGINT, syscall.SIGQUIT:
	// 清理被调试进程后退出：还原断点，并按 Kind 决定 kill 或 detach。
	// 注意：此处直接 os.Exit，不会触发会话的 AtExit 清理，
	// 因此需要显式调用 Cleanup。
	debug.Cleanup()
	os.Exit(1)
```

`signal.Notify` 接管 SIGINT 后进程不会按默认动作退出，信号被转到 `processSignals` 的 channel，这里就是清理被调试进程的最后机会。SIGURG 是 Go runtime 的异步抢占信号，必须忽略。

### 代码测试

本节的冒烟脚本 `testdata/script/ch6.11.txt` 覆盖 exec 场景：下断点、`exit`，断言输出 `tracee is run by tracer, kill it`（`make smoke S=ch6.11` 通过）。它验证"退出时清理正常执行"，但验证不了断点确实被还原——后者要看 attach 场景里 tracee 能否继续运行，即场景三。

测试目标仍是 `_fixtures/loop`。入口地址 `0x478120` 只在程序启动时执行一次，attach 上去之后不会再命中；循环体从 `0x4b3971`（`main.main+0x31`）开始，每轮都会执行。所以 exec 场景的断点下在 `0x478120`，attach 场景下在 `0x4b3971`。

attach 示例把 target 作为 godbg 的子进程启动后再 attach，满足 Linux Yama `ptrace_scope=1` 下"tracer 必须是 tracee 的祖先"的限制。如果运行环境已经放开 ptrace 限制，也可以直接在另一个终端执行 `godbg attach <pid>`。

#### 场景一：不还原断点的后果

先看反例。ch6.10 的退出逻辑只 detach、不还原断点。切到那一节构建，attach 到运行中的 `loop`，在循环体上下断点后退出：

```bash
$ git checkout ch6.10
$ make build && make fixtures
$ bash -c './_fixtures/loop > /tmp/loop.out 2>&1 & exec ./godbg attach $!'
process 2231841 attached, stopped by SIGSTOP
godbg> break 0x4b3971
breakpoint 1 added at 0x4b3971
godbg> exit
tracee is an attached process, leave it running
```

调试器退出后，target 继续运行，一秒之内走到 `0x4b3971`，执行那里残留的 `0xCC`：

```bash
$ cat /tmp/loop.out
pid: 2231841, loop: 0
SIGTRAP: trace trap
PC=0x4b3972 m=0 sigcode=128

goroutine 1 gp=0xc000002380 m=0 mp=0x5736a0 [running]:
main.main()
	/tmp/godbgv2-ch6.10/examples/debuggee/loop.go:16 +0x32 fp=0xc0000c2f78 sp=0xc0000c2ee0 pc=0x4b3972
...
[process exited]
```

两个细节：

- `PC=0x4b3972` 是断点地址的下一条指令。`int3` 执行后 PC 已经后移，而 ch6.10 既没有还原指令，也没有回退 PC；
- tracer 已经 detach，SIGTRAP 没有接收者。Go runtime 接管了 SIGTRAP，当成运行时崩溃，打印 goroutine 栈后终止进程。没有接管 SIGTRAP 的程序则由内核按默认动作终止并产生 core dump。

这就是退出前必须清理断点的原因。

#### 场景二：exec 启动，还原并杀掉

回到 ch6.11，用 `exec` 启动 target，下断点后退出：

```bash
$ git checkout ch6.11
$ make build && make fixtures
$ ./godbg exec _fixtures/loop
process 2232027 launched, stopped by SIGTRAP
godbg> break 0x478120
breakpoint 1 added at 0x478120
godbg> exit
tracee is run by tracer, kill it
```

`Cleanup` 先 `ClearAll` 把 `0x478120` 处的原始字节写回，再按 `KindExec` 杀掉 tracee——这也是冒烟脚本 ch6.11.txt 覆盖的路径。`godbg debug` 启动的走 `KindDebug` 分支，处理相同，会话结束后 `PostRun` 还会删除构建产物。

#### 场景三：attach 运行中的进程，还原并 detach

同样的 target，这次 attach，断点下在每轮都会执行的循环体地址：

```bash
$ bash -c './_fixtures/loop > /tmp/loop.out 2>&1 & exec ./godbg attach $!'
process 2232045 attached, stopped by SIGSTOP
godbg> break 0x4b3971
breakpoint 1 added at 0x4b3971
godbg> exit
tracee is an attached process, leave it running
```

退出后查看 target 的输出：

```bash
$ tail -f /tmp/loop.out
pid: 2232045, loop: 0
pid: 2232045, loop: 1
pid: 2232045, loop: 2
pid: 2232045, loop: 3
pid: 2232045, loop: 4
```

`loop: 0`、`loop: 1` 是 attach 之前打印的，`loop: 2` 之后是 `exit` 之后的输出。计数继续增长，说明两件事都成立：

- `0x4b3971` 处的 `0xCC` 已经换回原指令，target 再次执行到这里不会触发 SIGTRAP；
- target 已经脱离 ptrace，可以独立运行。

如果 `Cleanup` 只 detach 不还原断点，得到的就是场景一的结果。

#### 场景四：Ctrl+C 信号退出

`processSignals` 收到 SIGTERM/SIGINT/SIGQUIT 后显式调用 `Cleanup()`，再 `os.Exit(1)`。会话期间按 Ctrl+C：

```bash
$ ./godbg exec _fixtures/loop
process 2232434 launched, stopped by SIGTRAP
godbg> break 0x478120
breakpoint 1 added at 0x478120
godbg> ^C
tracee is run by tracer, kill it
```

信号路径不走 `Start` 的 defer，必须显式清理。否则 attach 场景下调试器直接 `os.Exit(1)`，断点残留在 target 里，下次命中断点就是场景一的结果。

### 本节小结

断点通过 patch 指令字节实现，attach 场景退出前不还原，tracee 会在下次执行到断点处崩溃：Go 程序由 runtime 接管 SIGTRAP 打印栈后退出，其他程序由内核按默认动作终止。本节在 6.4 节 `Cleanup` 的基础上补上 `ClearAll` 一步——先还原断点，再按 Kind 杀进程或 detach——并把信号退出路径的 TODO 补成显式 `Cleanup()`，两条退出路径行为一致。`ClearAll` 目前只还原指令字节，停在断点处线程的 PC 回退留到 6.18.5。

下一节开始实现执行控制命令：`step` 逐指令执行。
