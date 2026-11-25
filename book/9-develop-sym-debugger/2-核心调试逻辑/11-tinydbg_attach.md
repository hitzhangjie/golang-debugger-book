## Attach

### 实现目标：`godbg attach <pid>`

`godbg attach <pid>` 跟踪一个已经在运行的进程：等它的全部线程停下来之后进入调试会话；会话结束时不杀它，而是解除跟踪、让它继续跑。

第 6.2 节已经用同一条命令讲过 `PTRACE_ATTACH`/`SIGSTOP` 的内核路径。本节在符号级调试器里重讲这条命令，关注三件事：命令层的一次 `Client.Attach` 为什么是真正的 RPC；目标层为了"停稳"和"停全"做了什么；attach 拿到 pid 之后符号层怎么建立（`runtime.firstmoduledata` 的解析是 tag `ch9.2.11` 的真正增量）。

命令形态只有一个位置参数和一个本地选项：

```bash
$ godbg attach --help
Usage:
  godbg attach <pid> [--waitfor] [flags]

Flags:
  -h, --help      help for attach
      --waitfor   等待目标进程出现后再跟踪（ch9.2.12）

Global Flags:
      --headless            headless 模式：作为调试服务端运行（ch9.2.16）
      --init string         startup script file to replay (batch mode)
      --listen string       headless 模式的监听地址（ch9.2.16） (default "127.0.0.1:0")
      --log                 enable debug logging
      --log-output string   write logs to file instead of stderr
  -v, --verbose             show verbose info
```

这张表里有几点值得先记住：

- `<pid>` 是唯一的位置参数。不存在第二个可执行文件参数——目标已经在跑，符号文件路径来自 `/proc/<pid>/exe`。
- `--waitfor` 是布尔开关，等的是"这个 pid 对应的进程出现"，不是进程名前缀；轮询间隔写死在代码里（100ms），没有时长、间隔选项。它也不解除"必须给 pid"的约束。
- 没有"attach 之后立即恢复执行"的开关，也没有多客户端并发的开关——`main` 里只有一个门面实例、一条 RPC 管道。
- `--init`、`--headless`、`--listen`、`--log`、`--log-output`、`-v` 是根命令的持久选项，所有进程级命令共用。

历史口径交代一句：本书早期版本这一节以 tinydbg（delve 的裁剪版）为示范，命令与代码路径都来自那个实现；本节起统一按 `godbgv2` 的现行代码描述。分工上，ptrace 细节与 attach 失败原因在 6.2 和附录 12.5，"Start 后立刻 Attach 先等到 SIGTRAP"在附录 12.9，线程自动跟踪在 6.18.1–6.18.3，`--waitfor` 的等待策略在 9.2.12，RPC 装配与 headless 在 9.2.16，会话循环在 9.2.01。

### 基础知识

#### attach 与 exec：两种建立跟踪关系的方式

差别不止是系统调用不同，而是"tracee 是谁的"这个根本问题：

| | `godbg exec` / `godbg debug` | `godbg attach <pid>` |
| --- | --- | --- |
| tracee 来源 | 调试器 `fork`+`exec` 创建 | 已经独立运行，调试器半路接手 |
| 建立跟踪 | 子进程 `PTRACE_TRACEME`，exec 时停住 | `PTRACE_ATTACH`，内核投递 `SIGSTOP` |
| 首次停止信号 | `SIGTRAP`（exec 事件） | `SIGSTOP`（attach 事件） |
| 首次停止位置 | 程序入口（实测停在 `_rt0_amd64_linux`） | 各线程当前所在位置（实测多在 `runtime.futex`） |
| 符号从哪里来 | 启动命令里的二进制 | `/proc/<pid>/exe` |
| 会话结束善后 | `kill` 掉 tracee | `detach`，让 tracee 继续运行 |

最后一行是本节反复强调的语义差别：exec/debug 的 tracee 是调试器创建的，杀掉它是"清理自己的产物"；attach 的 tracee 本来就属于别人，调试器只是临时接管，退出时必须解开 ptrace link，否则等于把别人的进程弄停了。`cmd/debug/exit.go` 的 `Cleanup` 就是按这个区别分支的。

#### 一次 attach 的完整时序

第 6.2 节的时序图描述"命令 → `PTRACE_ATTACH` → 会话"，本节换成符号级调试器的分层视角，把 RPC 边界和符号层都画出来：

```text
$ godbg attach 12345
        │
        ▼
main.main                                  进程启动时的一次性装配
  ├─ debugger.New()                        后端门面（此刻还没有目标进程）
  ├─ service.WireLocal(dbg)                net.Pipe 上的进程内 RPC
  │    ├─ rpc2.NewServer(dbg) + go Accept  ← 服务端协程
  │    └─ rpc.NewClient(cli) → rpc2.Client → cmd.Client
  └─ cmd.Execute() → attachCmd.RunE
        │  ① 解析 pid  ② --waitfor 时轮询 Kill(pid, 0)
        ▼
Client.Attach(pid)                         api.Client 契约方法（一次 RPC）
        │   ── net.Pipe（本地）/ TCP（headless），gob 编解码 ──
        ▼
rpc2.Client.Attach → "Debugger.Attach"
        ▼
rpc2.serverImpl.Attach → debugger.Debugger.Attach
        ▼
target.AttachTargetProcess(pid)
  ├─ checkPid + PTRACE_ATTACH
  ├─ 循环 wait，直到等到 attach 产生的 SIGSTOP
  ├─ 读 /proc/<pid>/{comm,cmdline}
  └─ 枚举 /proc/<pid>/task/*，逐个 PTRACE_ATTACH（all-stop）
        ▼
proc.NewTarget(dbp)                        符号层
  ├─ NewBinaryInfo("/proc/<pid>/exe")      ELF + 惰性 DWARF
  └─ （按需）ModuleData() → runtime.firstmoduledata / runtime.moduledata
        ▼
reply.Tids → attachCmd 打印 → PostRun → startDebugSession → godbg>
```

被 RPC 这一步切开的两半，正好对应"命令层只看 `api.Client`"和"服务层只看 `debugger.Debugger`"这两条架构约束。

#### 为什么 wait 要循环

`PTRACE_ATTACH` 的 man 手册有一句关键的话：tracee 会被投递 `SIGSTOP`，但**不保证** `ptrace` 调用返回时它已经停下来，tracer 必须自己 `wait`。"attach 之后 wait 一次、检查是不是 SIGSTOP"多数情况能跑，但有一种情况会翻车：如果 attach 恰好落在目标进程 execve 的窗口里，内核会先投递一个 post-exec 的 `SIGTRAP`（`si_code=SI_USER`），第一次 `wait` 等到的是它而不是 `SIGSTOP`。godbgv2 现在不赌"第一次就是 SIGSTOP"，而是循环等到真正的 attach `SIGSTOP`；中途等到的其他信号用 `PTRACE_CONT`（signal 参数传 0）丢掉，既不放行整个进程，也不让该信号按默认动作杀掉 tracee。完整排查过程在附录 12.9，对应提交是 `5a97db3`（PR #3）。

#### 线程：一次 `PTRACE_ATTACH` 只能停一个线程

Linux 的线程是轻量级进程（LWP），`ptrace(PTRACE_ATTACH, pid)` 里的 pid 指向线程组里的某一个 LWP。只 attach 主线程，其余线程照跑——这正是第 6.2 节"多线程程序 attach 后还在输出"的原因：执行 `main.main` 的 main goroutine 并不绑定在主线程上。要做到 all-stop，必须先枚举 `/proc/<pid>/task/` 下的全部 tid 逐个 `PTRACE_ATTACH`，再给每个线程设置 `PTRACE_O_TRACECLONE` 等选项，否则 attach 之后新创建的线程不会进入管控范围（前者见 6.18.1，后者见 6.18.2，内核机制见附录 12.2）。

#### 符号层：attach 只给得出一个 pid

exec/debug 的符号来源是明确的：命令行写着要调试哪个二进制。attach 只有 pid，所以符号层只能从 `/proc/<pid>/exe` 打开目标程序，再读它的 ELF 与 DWARF。由此有两个必须写清的边界：

- attach 成功不等于符号可用。对 strip 过的、非 Go 的程序（比如 `/bin/sleep`）也能 attach、也能让它停下来，但 `threads` 只能打印每个线程的 PC，没有函数名和源码行——ELF 里没有 DWARF。
- 符号层里的地址是链接时地址。默认构建的非 PIE Go 程序（`text` 从 `0x401000` 起）链接时地址就是运行时地址；PIE 目标还需要叠加加载基址，而这一版 `NewBinaryInfo` 里的 `staticBase` 只是假定值（`0x555555554000`），加载基址的确定见 7.5 与附录 12.8。因此本节实验都用 `make fixtures` 产出的默认非 PIE 目标。

### 代码实现

#### 装配：`main` 先建 RPC，再执行命令

attach 命令本身不负责装配。`main` 在 `cmd.Execute()` 之前就把门面和管道准备好，并把客户端注入 `cmd` 包（`main.go`）：

```go
func main() {
	go processSignals()

	// ch9.2.16：本地模式也经进程内 RPC 与服务端通信——
	// 前后端分离的架构边界在传输层，而非进程边界
	dbg := debugger.New()
	client, err := service.WireLocal(dbg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "wire local: %v\n", err)
		os.Exit(1)
	}
	cmd.Client = client

	// 另外注入 cmd.ServeHeadless：headless 模式的服务端装配（见 ch9.2.16）
	cmd.Execute()
}
```

三个注入点各解决一件事：`cmd.Client = client` 把 `api.Client` 的实现交给命令层（`cmd/client.go` 里只有一个 `var Client api.Client`）；`cmd.ServeHeadless` 让 `cmd` 不必 import 服务端包就能在 `--headless` 分支起服务；`debugger.New()` 创建的门面此刻还没有目标进程，目标进程要等 `Attach` 或 `Launch` 之后才有。

`WireLocal` 只有十行，它把"监听/连接"这对动作在进程内用 `net.Pipe` 模拟出来（`pkg/service/wire.go`）：

```go
func WireLocal(dbg *debugger.Debugger) (api.Client, error) {
	ln, cli, err := NewListenerPipe()
	if err != nil {
		return nil, err
	}
	server := rpc2.NewServer(dbg)
	go server.Accept(ln)
	return rpc2.NewClientFrom(rpc.NewClient(cli)), nil
}
```

`NewListenerPipe` 用 `net.Pipe()` 造一对同步连接，再包一个只能 `Accept` 一次的 `listenerPipe`：服务端协程从 `ln` 接受那条唯一连接，客户端拿 `cli` 建 `rpc.Client`。所以 `cmd.Client` 从一开始就是 RPC 客户端，attach 只是这条管道上的第一个用户。

#### 命令层：`attachCmd`

`cmd/attach.go` 一共 62 行，命令定义、`RunE`、`PostRun`、`init` 与 `processExists` 都在里面：

```go
var attachCmd = &cobra.Command{
	Use:   "attach <pid> [--waitfor]",
	Short: "跟踪正在运行的进程",
	Long:  `跟踪正在运行的进程（--waitfor：等待目标进程出现后再跟踪）`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if len(args) != 1 {
			return errors.New("参数错误")
		}
		pid, err := strconv.Atoi(args[0])
		if err != nil {
			return fmt.Errorf("invalid pid %q: %v", args[0], err)
		}

		// --waitfor：目标进程可能尚未启动，轮询等待其出现（ch9.2.12）
		if waitfor, _ := cmd.Flags().GetBool("waitfor"); waitfor {
			fmt.Printf("waiting for process %d to appear...\n", pid)
			for !processExists(pid) {
				time.Sleep(100 * time.Millisecond)
			}
		}

		// attach 到运行中的进程及其全部线程，等待其因 SIGSTOP 而停止
		tids, err := Client.Attach(pid)
		if err != nil {
			return err
		}
		fmt.Printf("process %d attached, stopped by SIGSTOP\n", pid)
		for _, tid := range tids {
			fmt.Printf("thread %d attached\n", tid)
		}
		return nil
	},
	PostRun: func(cmd *cobra.Command, args []string) {
		// 会话退出（含 --init 批量回放结束）时统一善后，见 session.go
		startDebugSession(cmd)
	},
}
```

几个细节：参数校验写在 `RunE` 里而不是 `Args` 字段里，所以错误信息是中文的"参数错误"；`processExists` 是 `syscall.Kill(pid, 0) == nil`（信号 0 不投递，只做存在性与权限检查）。`Client.Attach(pid)` 返回 `[]int`——**全部**被跟踪到的线程 id，签名从早期版本的 `error` 变成 `([]int, error)`，就是 6.18.1 all-stop 改造的结果。`PostRun` 只在 `RunE` 返回 nil 之后执行，attach 失败不会进会话。

#### 一次 RPC 往返

契约方法只有一个签名（`pkg/service/api/client.go`）：`Attach(pid int) ([]int, error)`——返回的是全部被跟踪到的线程 id。如果在这一版的 `pkg/service/rpc2/client.go` 里搜索 `Attach`，会看到它是实实在在的 RPC 调用：

```go
// Attach 跟踪一个正在运行的进程
func (c *Client) Attach(pid int) ([]int, error) {
	var reply AttachReply
	err := c.c.Call("Debugger.Attach", &AttachArgs{Pid: pid}, &reply)
	return reply.Tids, err
}
```

服务端由 `rpc2.NewServer` 用 `RegisterName("Debugger", &serverImpl{dbg: dbg})` 注册，`net/rpc` 靠反射分派；方法是标准形状——两个指针参数、返回一个 `error`：

```go
// Attach 跟踪一个正在运行的进程
func (s *serverImpl) Attach(args *AttachArgs, reply *AttachReply) error {
	tids, err := s.dbg.Attach(args.Pid)
	reply.Tids = tids
	return err
}
```

门面把请求转给目标层，并在成功后把 `proc.Target` 记下来，后续所有符号级命令都通过它访问 tracee（`pkg/service/debugger/debugger.go`）：

```go
// Attach 跟踪一个正在运行的进程，返回跟踪到的全部线程 id
func (d *Debugger) Attach(pid int) ([]int, error) {
	dbp, err := target.AttachTargetProcess(pid)
	if err != nil {
		return nil, err
	}
	d.t, err = proc.NewTarget(dbp)
	if err != nil {
		return nil, err
	}

	tids := []int{}
	for tid := range dbp.Threads {
		tids = append(tids, tid)
	}
	sort.Ints(tids)
	return tids, nil
}
```

注意这里的两步：`AttachTargetProcess` 只负责"把进程停下来"，`proc.NewTarget` 才建立符号层。两者都成功，`Attach` 才算成功——这正是符号级调试器与指令级调试器对 attach 的不同要求。

于是可以正面回答那个容易被写错的问题：**attach 涉及 RPC**。本地模式下它是 `net.Pipe` 上的一次 `net/rpc` 调用，headless 模式下是 TCP 上的一次调用，编码、方法名、消息对完全相同。早期书稿"attach 不涉及 RPC、不要去 client 里找 Attach"的结论是错的，那反映的是另一个实现（服务端在启动时按配置 attach 好）。在 `godbgv2` 里，`Client.Attach` 就是这条链路的起点。

#### 目标层：`PTRACE_ATTACH` 与循环等待 SIGSTOP

目标层先构造 `DebuggedProcess`（`Kind` 记为 `ATTACH`，这张"身份证"决定退出时 detach 还是 kill），再依次 attach、读 `/proc`、枚举线程（`pkg/target/process.go`）：

```go
// AttachTargetProcess attach 到一个正在运行的进程及其全部线程。
func AttachTargetProcess(pid int) (p *DebuggedProcess, err error) {
	p = &DebuggedProcess{/* 省略：映射与 ptrace 请求通道的初始化 */ Kind: ATTACH}

	if p.Process, err = os.FindProcess(pid); err != nil {
		return nil, err
	}
	// attach 成功后读 /proc/pid/{comm,cmdline}，再枚举其余线程
	if err := p.attach(pid); err != nil {
		return nil, err
	}
	if err := p.initialize(); err != nil {
		return nil, err
	}
	if err := p.updateThreadList(); err != nil {
		return nil, err
	}
	p.currentThread = p.Threads[p.Process.Pid]
	return p, nil
}
```

`os.FindProcess` 在 Unix 上永远成功，真正的存在性校验在 `attach` 里用 `checkPid`（`kill -s 0`）做。接着是本节最该逐行读的函数：

```go
func (p *DebuggedProcess) attach(pid int) error {
	// 省略：checkPid 校验；PTRACE_ATTACH 经 ExecPtrace 在固定 tracer 线程上发出
	err := p.ExecPtrace(func() error { return syscall.PtraceAttach(pid) })
	if err != nil {
		return fmt.Errorf("process %d attached error: %v", pid, err)
	}

	// 循环 wait 直到收到 attach 产生的 SIGSTOP
	for {
		_, status, err := p.wait(pid, syscall.WSTOPPED)
		if err != nil {
			return fmt.Errorf("process %d waited error: %v", pid, err)
		}
		if !status.Stopped() {
			return fmt.Errorf("unexpected non-stopped status: %#x", uint32(*status))
		}
		sig := status.StopSignal()
		if sig == syscall.SIGSTOP {
			break // 收到 attach SIGSTOP，完成
		}
		// 收到其他信号（如 post-exec SIGTRAP），用 PTRACE_CONT(signal=0) 丢弃
		if err := p.ExecPtrace(func() error {
			return syscall.PtraceCont(pid, 0)
		}); err != nil {
			return fmt.Errorf("process %d continue after signal %v error: %v", pid, sig, err)
		}
	}
	return nil
}
```

三点解释：`ExecPtrace` 把每个 ptrace 请求送到一个 `runtime.LockOSThread` 的协程里执行，因为 ptrace 要求"同一个 tracer 线程"，而 goroutine 会被调度到不同 OS 线程上；`PTRACE_CONT(pid, 0)` 的第二个参数是"投递给 tracee 的信号"，传 0 表示不投递，这样丢掉的是"这个停止事件"而不是"这个信号"，tracee 继续跑直到 attach 的 `SIGSTOP` 到来；循环没有超时，理论上如果 tracee 一直收到别的信号这里会一直转，实践里 `SIGSTOP` 紧跟 `PTRACE_ATTACH`，写调试器时该把"没有超时的等待"标出来。`p.wait` 也值得一提：当 `p.Process` 就是目标进程时，它用 `WNOHANG` 轮询并顺手检查僵尸状态，避免"leader 已退出但留下僵尸子线程"时 `wait4` 永久阻塞（`pkg/target/ptrace_linux.go`）。

#### 目标层：读 `/proc` 与枚举全部线程

attach 是半路接手，调试器不知道进程是怎么启动的，所以 `initialize` 把启动命令与参数从 `/proc` 读回来，填进 `Command`/`Args`，为将来的 restart 留好数据（`pkg/target/procfs.go`）：`readProcComm` 读 `/proc/<pid>/comm`，读不到时用 `/proc/<pid>/stat` 的 `pid (comm)` 格式正则兜底；`readProcCommArgs` 读 `/proc/<pid>/cmdline`，按 NUL 切分后丢掉第 0 项（argv[0]）。

真正让"全部线程停下来"的是 `updateThreadList`：

```go
func (p *DebuggedProcess) updateThreadList() error {
	tids, err := p.loadThreadList() // filepath.Glob("/proc/<pid>/task/*")
	if err != nil {
		return fmt.Errorf("load threads err: %v", err)
	}
	for _, tid := range tids {
		// 主线程已被 attach，其余线程逐个 attach
		_, err := p.addThread(tid, tid != p.Process.Pid)
		if err != nil {
			return fmt.Errorf("add thread err: %v", err)
		}
	}
	return nil
}
```

`addThread(tid, true)` 里做了三件事：`PTRACE_ATTACH`、`waitFast` 等到该线程停止、`setPtraceOptions` 装跟踪选项。两个"坑"被显式容忍：`EPERM` 不算错误——线程可能已被 `PTRACE_O_TRACECLONE` 自动跟踪，再 attach 一次会返回 `EPERM`，若真没权限，后面的 wait 或读写会暴露出来；`setPtraceOptions` 遇到 `ESRCH` 会先 `waitFast` 消费一次停止事件再重试一次。选项是四个 TRACE 位（`TRACECLONE`/`TRACEFORK`/`TRACEVFORK`/`TRACEEXEC`），必须在线程进入常规停止状态之后设置——对处于组停止中的新克隆线程设置会失败。设置完这些选项，attach 之后新 clone 的线程、fork 的子进程、exec 事件都会作为事件报给 tracer，后续 `continue` 才不会"跟丢"。

到这里目标层的工作完成：主线程与其余已有线程全部停在 `SIGSTOP` 上，每个线程都装好了跟踪选项，`currentThread` 默认指向主线程；`Attach` 返回的 `tids` 就是这张表的键，按升序排好。

#### 符号层：`proc.NewTarget`

`proc.Target` 是"ptrace 引擎 + 符号层"的组合（`pkg/proc/target.go`）：

```go
// NewTarget 创建符号级调试目标：解析 /proc/<pid>/exe 的符号信息
func NewTarget(dbp *target.DebuggedProcess) (*Target, error) {
	bi, err := NewBinaryInfo(fmt.Sprintf("/proc/%d/exe", dbp.Process.Pid))
	if err != nil {
		return nil, err
	}
	return &Target{dbp: dbp, bi: bi, breaklets: map[uint64][]*Breaklet{}}, nil
}
```

`NewBinaryInfo` 打开 ELF 并按文件类型决定静态基址：`ET_EXEC`（非 PIE）为 0，段按 `p_vaddr` 原样加载；`ET_DYN`（PIE/共享库）取假定基址 `staticBasePIE`，其它类型直接报错（`pkg/proc/bininfo.go`）。DWARF 是惰性的：`BinaryInfo.DWARF()` 按需解析，函数表、行号表、`.debug_frame` 各自用 `sync.Once` 缓存。所以 attach 本身很快——它只打开了 ELF，真正的 DWARF 解析发生在第一次 `threads`、`bt`、`print` 时。

`/proc/<pid>/exe` 这个入口有两个现实约束：它要求 tracer 对 tracee 有读权限（同 uid 或 `CAP_SYS_PTRACE`），否则 `elf.Open` 直接失败；如果目标程序的二进制在磁盘上被替换或删除，`exe` 会指向新文件或带 `(deleted)` 的路径，符号可能对不上。这两点不是 bug，是 attach 这种方式固有的不确定性。

#### 符号层：`runtime.firstmoduledata`

Go 程序没有 `.rela` 重定位节（第 7.4 节讲过），运行时靠自举完成重定位，靠的就是 `runtime.moduledata` 这份自描述：它记录 `.text` 范围、`pclntab`、类型元数据区、`itab` 表等。调试器要定位"运行时的数据在哪里"，最稳的入口就是全局变量 `runtime.firstmoduledata`。`Target.ModuleData()` 的关键步骤是（`pkg/proc/moduledata.go`，对重复字段作省略）：

```go
func (t *Target) ModuleData() (*ModuleData, error) {
	d, err := t.bi.DWARF()
	if err != nil {
		return nil, err
	}
	reader := dwarf.NewReader(d)

	// ① 查找全局变量 runtime.firstmoduledata 的地址
	entry, err := reader.FindGlobalVariable("runtime.firstmoduledata")
	if err != nil {
		return nil, err
	}
	addr, err := t.variableAddress(entry) // DW_AT_location → OpContext.Eval
	if err != nil {
		return nil, err
	}

	// ② 解析 runtime.moduledata 的字段偏移（自研类型模型）
	modType, err := t.bi.FindType("runtime.moduledata")
	if err != nil {
		return nil, err
	}
	st, ok := modType.(*dwarf.StructType)
	if !ok {
		return nil, fmt.Errorf("expect runtime.moduledata as struct, got %T", modType)
	}
	fieldOffset := func(name string) (int64, error) { /* 省略：遍历 st.Fields 按名字返回 ByteOffset */ }
	offText, err := fieldOffset("text")
	// 省略：etext、types、etypes 用同样的方式取偏移

	// ③ 按"地址+偏移"读字段值
	readU64 := func(off int64) (uint64, error) {
		buf := make([]byte, 8)
		if n, err := t.dbp.ReadMemory(uintptr(addr)+uintptr(off), buf); err != nil || n != 8 {
			return 0, fmt.Errorf("read moduledata field at %#x: %v", uintptr(addr)+uintptr(off), err)
		}
		return leUint64(buf), nil
	}
	text, err := readU64(offText)
	// 省略：etext、types、etypes 的读取

	return &ModuleData{Text: text, TextSize: etext - text, Types: types, ETypes: etypes}, nil
}
```

**第一步：找到全局变量。** `FindGlobalVariable` 是 tag `ch9.2.11` 新增的（`pkg/dwarf/reader.go`）：它遍历各编译单元，在 CU 子树里用 `walkEntry` 找名为 `runtime.firstmoduledata` 的 `DW_TAG_variable`。不能复用"找局部变量"的逻辑——局部变量的 DIE 挂在 `subprogram` 下面，全局变量挂在编译单元下面，搜索起点和匹配范围都不一样。

**第二步：求址。** DIE 只描述"变量在哪"，具体位置写在 `DW_AT_location` 的位置表达式里。全局变量的表达式通常是 `DW_OP_addr <addr>`，`variableAddress` 用自研栈机 `OpContext.Eval` 求出地址；对默认非 PIE 目标，它就是运行时地址，可以直接拿去读内存。

**第三步：字段偏移从 DWARF 来，不硬编码。** 拿到 `runtime.firstmoduledata` 的地址之后，要读的是 `runtime.moduledata` 里哪几个字节？答案不能写死。结构体开头排着 `pcHeader`、`funcnametab`、`cutab`、`filetab`、`pctab`、`pclntable`、`ftab` 等一长串字段，`text` 根本不在开头。用 `readelf` 或一段只依赖标准库 `debug/dwarf` 的小程序可以复核本节所用 fixture 的真实布局：

| 字段 | 字节偏移 | 含义 |
| --- | --- | --- |
| `text` | 176 | 代码段起始 |
| `etext` | 184 | 代码段结束 |
| `types` | 296 | 类型元数据区起始 |
| `etypes` | 304 | 类型元数据区结束 |
| `next` | 576 | 下一个模块（链表） |
| （结构体） | 大小 584 | —— |

这些数字是 go1.24.13 编译这个 fixture 时的布局，换一个 Go 版本就可能变。所以代码走"`FindType("runtime.moduledata")` → `StructType.Fields` 里按名字找 `ByteOffset`"这条路；`fieldOffset` 找不到字段时返回错误，而不是悄悄用 0 偏移读一个错值。

**第四步：读内存。** `readU64` 用 `DebuggedProcess.ReadMemory`（内部是 `PTRACE_PEEKDATA` 或 `/proc/<pid>/mem`）按"地址+偏移"读 8 字节，小端拼成 `uint64`。`ModuleData{Text, TextSize: etext - text, Types, ETypes}` 就是把"代码段范围"和"类型元数据范围"交给上层。

**类型环检测：为什么非有不可。** `runtime.moduledata` 的最后一个字段是 `next *moduledata`——模块链表的自引用。解析结构体时要逐个解析成员类型，而解析 `next` 的类型 `*runtime.moduledata` 又回到 `runtime.moduledata` 本身：

```text
Typedef "runtime.moduledata" → StructType "runtime.moduledata"
    → PointerType "*runtime.moduledata" → Typedef "runtime.moduledata" …（环）
```

没有防护的递归会一直转下去。tag `ch9.2.11` 给 `TypeFromDIE` 加了"当前解析路径"的 `seen` 集合（`pkg/dwarf/type.go`）：

```go
// typeFromDIE 带环检测的类型解析
func (r *Reader) typeFromDIE(entry *stddwarf.Entry, seen map[stddwarf.Offset]bool) (Type, error) {
	if seen[entry.Offset] {
		return nil, fmt.Errorf("cyclic type reference at %#x (%v)", uint64(entry.Offset), entry.Tag)
	}
	// 标记当前解析路径（回溯时删除——同类型被多个兄弟字段
	// 引用是合法的，只有同一路径上的重复才是环）
	seen[entry.Offset] = true
	defer delete(seen, entry.Offset)
	...
```

"进入时标记、返回时删除"是关键：同一个类型被多个兄弟字段引用是合法的（比如两个字段都是 `*runtime._type`），只有"沿着当前路径又走回自己"才是环。环一旦被识别，结构体解析会把那个字段跳过（`typeOfAttr` 报错后 `continue`），其余字段照常解析——所以 `runtime.moduledata` 的 `Fields` 里没有 `next`，但 `text`/`types` 这些真正需要的字段都在，`ModuleData` 依然能工作。

同一个提交还修了结构体字段的枚举方式：旧实现用 `walkEntry` 深度优先遍历，会把内嵌结构体的成员也当成外层结构体的字段（偏移自然全错）；新实现只取直接子级，每读一个成员就 `SkipChildren`，数组的 `DW_TAG_subrange_type` 同理。这两处合起来，才能保证 `runtime.moduledata` 的字段名与偏移一一对上——这正是 `ModuleData` 能在不同 Go 版本上工作的原因。

**这条能力现在被谁用。** `ModuleData()` 目前只有 `pkg/proc/moduledata_test.go` 在调用，命令行里没有一条命令直接打印它；但它引入的两块基础设施已经在后面生效：`FindGlobalVariable` 被 9.2.33 的变量求值（`pkg/proc/variables.go` 查全局变量）和 9.2.100 的 goroutine 列表（`runtime.allgs`）复用，`TypeFromDIE` 的环检测与直接子级遍历则被所有结构体类型的解析共用。本节把它放在 attach 之后讲，不是因为它"被 attach 命令调用"，而是因为 **attach 是符号层第一个必须回答"符号从哪来"的入口**，而 `runtime.firstmoduledata` 是符号层里第一个自己描述自己的结构。

#### 会话与退出：detach 还是 kill

`PostRun` 把控制权交给 `cmd/session.go` 的 `startDebugSession`：`--headless` 时只起服务端、不进会话（attach 到的目标仍在服务端手里，等远程客户端来连，见 9.2.16）；给了 `--init` 时进入批量回放；否则进入 `liner` 交互循环。无论哪条，都会先执行 `debug.Client = Client`，再用 `debug.NewDebugSession().AtExit(debug.Cleanup)` 建会话并 `Start()`——`AtExit` 挂的正是 `Cleanup`，这是 attach 的 tracee 不被误杀的关键。

`Cleanup` 先 `Client.ClearAll()` 还原全部断点，再按 `st.Kind` 分支（`cmd/debug/exit.go`）：`KindDebug`/`KindExec` 走 `Client.Kill()`；`KindAttach` 打印 "tracee is an attached process, leave it running" 并调 `Client.Detach()`。`Kind` 是 `AttachTargetProcess` 构造进程描述时写下的 `ATTACH`，经 `Debugger.State()` 原样送到命令层。attach 分支调 `Detach`，由目标层逐个线程 `PTRACE_DETACH`（`pkg/target/process.go`）：

```go
func (p *DebuggedProcess) Detach() error {
	// checkPid 校验；先分离非 leader 线程，最后分离线程组 leader
	tids := []int{}
	for tid := range p.Threads {
		if tid != p.Process.Pid {
			tids = append(tids, tid)
		}
	}
	tids = append(tids, p.Process.Pid)
	for _, tid := range tids {
		err := p.ExecPtrace(func() error { return syscall.PtraceDetach(tid) })
		if err != nil {
			return fmt.Errorf("thread %d detached error: %v", tid, err)
		}
	}
	return nil
}
```

先分离普通线程、最后分离 leader，避免 leader 先恢复执行后把组内其他线程从调试器手里"带走"。`PTRACE_DETACH` 会让线程从停止状态恢复，所以会话结束后目标进程继续它原来的工作。还有一条退出路径：`main.processSignals` 收到 `SIGTERM`/`SIGINT`/`SIGQUIT` 时会先调 `debug.Cleanup()` 再 `os.Exit(1)`（`main.go`），这条路径不经过会话的 `AtExit`，所以必须显式清理——否则 Ctrl+C 之后可能把别人的进程留在停止状态。

### 执行测试

先构建调试器与目标（`make` 目标见 `Makefile`）。fixtures 用 `-gcflags "all=-N -l"`（关闭优化与内联）和 `-ldflags=-compressdwarf=false`（不压缩 DWARF）构建，函数与行号信息完整，方便观察：

```bash
$ make build          # 产出 ./godbg
$ make fixtures       # 产出 _fixtures/loop、_fixtures/loop2 等调试目标
```

`loop2` 是常驻的多线程目标（主协程每 3s、子协程每 1s 打印一次 pid）。放到后台跑起来，再 attach：

```bash
$ ./_fixtures/loop2 &
[1] 1958813
pid: 1958813
pid: 1958813, main: 0

$ godbg attach 1958813
process 1958813 attached, stopped by SIGSTOP
thread 1958813 attached
thread 1958815 attached
thread 1958816 attached
thread 1958817 attached
thread 1958818 attached
godbg>
```

一次 attach 打印了五行 `thread ... attached`：`loop2` 启动后 Go 运行时已经创建了后台线程（sysmon、GC worker 等），`updateThreadList` 把它们全部纳入管控。此时在另一个 shell 里看 `ps -o stat -p 1958813`，状态是 `t`（traced/stopped），目标进程的输出也停了。

进入会话后符号层立即被用上——`threads` 与 `bt` 都会解析 PC 对应的函数与源码位置（输出里的源码路径是工具链源码，这里用 `$GOROOT` 简写，线程列表省略了中间三行）：

```text
godbg> threads
* Thread 1958813 at 0x4788a3 runtime.futex $GOROOT/src/runtime/sys_linux_amd64.s:558
  Thread 1958815 at 0x4788a3 runtime.futex $GOROOT/src/runtime/sys_linux_amd64.s:558
  Thread 1958818 at 0x40acee internal/runtime/syscall.Syscall6 $GOROOT/src/internal/runtime/syscall/asm_linux_amd64.s:36
godbg> bt
0: runtime.futex() $GOROOT/src/runtime/sys_linux_amd64.s:558 (pc: 0x4788a3)
1: runtime.futexsleep() $GOROOT/src/runtime/os_linux.go:75 (pc: 0x43a290)
...
9: runtime.newproc() <autogenerated>:1 (pc: 0x4793bf)
backtrace: 10 frame(s)
godbg> exit
tracee is an attached process, leave it running
```

`exit` 之后那行是 `Cleanup` 的 attach 分支。验证 detach 真的让进程复活：`ps -o stat -p 1958813` 显示 `S`（从 traced/stopped 回到可休眠），目标进程也继续打印输出。

attach 的对象不一定是 Go 程序。对 `sleep` 这种没有 DWARF 的目标，attach 同样成功，但符号层只能给出 PC（下面用 `<pid>` 占位）：

```bash
$ sleep 300 &
$ godbg attach <pid>
process <pid> attached, stopped by SIGSTOP
thread <pid> attached
godbg> threads
* Thread <pid> at 0x7fb8b4f08068
godbg> exit
tracee is an attached process, leave it running
```

这一组对比正好说明"attach 是 ptrace 层的能力，符号是 ELF/DWARF 层的能力"，两者不绑定。

`--waitfor` 的两个分支可以分别观察。目标进程已存在时，它打印一行等待提示后立即继续；目标进程尚未出现时，它每 100ms 探测一次，一直等下去（用 `timeout` 观察它确实停在等待里）：

```bash
$ godbg attach <pid> --waitfor
waiting for process <pid> to appear...
process <pid> attached, stopped by SIGSTOP

$ timeout 2 godbg attach 999998 --waitfor
waiting for process 999998 to appear...
$ echo $?
124
```

错误路径也都走 RPC 回到命令层，由 cobra 打印：

```bash
$ godbg attach 999999
Error: process 999999 not existed
$ godbg attach abc
Error: invalid pid "abc": strconv.Atoi: parsing "abc": invalid syntax
```

符号层的单测放在 `pkg/proc/moduledata_test.go`。它启动 fixture、建 `proc.Target`、调 `ModuleData`，并用一条"语义真理"做断言：`main.main` 的入口必须落在 `[text, etext)` 里：

```bash
$ go test ./pkg/proc -run TestModuleData -v
=== RUN   TestModuleData
    moduledata_test.go:34: moduledata: text=0x401000 size=0xb2ab0 types=0x4b4000..0x4ea639
--- PASS: TestModuleData (0.26s)
PASS
ok  	github.com/hitzhangjie/godbgv2/pkg/proc	0.259s
```

这个测试走的是 `NewDebuggedProcess`（exec 启动），attach 路径的符号层是否一样？一样：attach 之后 `proc.NewTarget` 打开的是同一个二进制的 `/proc/<pid>/exe`，`ModuleData` 的解析与 target 怎么来的无关。用一段临时程序（`AttachTargetProcess` → `proc.NewTarget` → `ModuleData`，不入仓库）对运行中的 fixture 实测，输出与上表一致：`attached pid=..., threads=5`、`moduledata: text=0x401000 size=0xb2ab0 types=0x4b4000..0x4ea639`。

attach 的多线程场景已有冒烟脚本 `testdata/script/ch6.18.1.txt`（`@spawn _fixtures/loop2` + `@attach`，断言 `process ... attached, stopped by SIGSTOP` 与 `thread ... attached`）。`ch9.2.11` 这一节本身还没有专属脚本，上面的命令就是可复现的最小验证。

### 本节小结

这一节把 `godbg attach <pid>` 从命令行走到了符号层，要点可以归纳为四句：

1. **命令形态很小，语义很强。** 只有一个 pid 和一个 `--waitfor` 开关；不给第二个位置参数，不提供"attach 后立即继续"、可配置等待时长/间隔、多客户端。`--waitfor` 等的是"这个 pid 出现"，不是进程名。
2. **attach 是一次真正的 RPC。** `attachCmd.RunE` 调 `Client.Attach`，经 `rpc2` 的 `"Debugger.Attach"`、`debugger.Debugger.Attach`，最后落到 `target.AttachTargetProcess`；本地模式走 `WireLocal` 建好的 `net.Pipe`，headless 模式走 TCP，两条路径共用同一套消息对与实现。早期"attach 不涉及 RPC"的结论已被这一版代码推翻。
3. **"停稳"和"停全"是目标层的两件脏活。** `PTRACE_ATTACH` 之后循环 `wait` 直到 attach 产生的 `SIGSTOP`（中途信号用 `PTRACE_CONT(sig=0)` 丢弃），再枚举 `/proc/<pid>/task/*` 逐个 attach，并给每个线程装上 `TRACECLONE`/`TRACEFORK`/`TRACEVFORK`/`TRACEEXEC` 选项。
4. **attach 的真正增量在符号层。** `proc.NewTarget` 从 `/proc/<pid>/exe` 建 ELF/DWARF；`runtime.firstmoduledata` 的解析（全局变量查找、`DW_AT_location` 求址、字段偏移取自 DWARF、类型环检测）是 tag `ch9.2.11` 提交的内容，也是后续变量求值与 goroutine 列表的地基。

退出时 `Kind` 决定善后方式：exec/debug 的 tracee 是调试器创建的，`kill`；attach 的 tracee 原本独立运行，`detach` 让它继续。这条区别看似只是分支里的一行 `if`，却是"临时接管别人的进程"这件事在语义上的全部分量。
