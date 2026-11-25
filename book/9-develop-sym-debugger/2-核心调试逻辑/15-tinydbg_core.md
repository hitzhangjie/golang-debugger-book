## Core：调试 Core 文件

### 实现目标: `godbg core <corefile> <executable>`

core 文件是进程在某一时刻的内存快照：寄存器、栈、堆、全局变量、地址空间映射都在里面。程序因为段错误、abort 或其它致命信号退出后，现场已经没了，core 是事后复盘的唯一依据。`gcore <pid>` 还能在不杀死进程的情况下主动转储，所以 core 也不只用于崩溃分析。

调试器读 core 的目的，是把这份快照还原成“可查看”的现场：用 core 里的寄存器和内存恢复调用栈、变量，再用可执行文件里的 DWARF 把地址翻译成函数名、文件名、行号。因此 core 调试需要两样东西——core 文件提供数据，可执行文件提供符号。`godbg core <corefile> <executable>` 的两个参数就是这两样，**core 文件在前、可执行文件在后**。这一点和 dlv 的 `dlv core <executable> <corefile>` 相反；本节按 godbgv2 的 `cmd/core.go` 写，读者不要照 dlv 的顺序传参。

把话说在前面：**godbgv2 的 core 调试目前只完成了后端解析，命令还没有接线**。`pkg/proc/core` 已经能打开 ELF core、校验 `ET_CORE`、按 `PT_LOAD` 建内存镜像、从 `PT_NOTE` 取 pid 和线程 tid；`cmd/core.go` 的 `RunE` 却直接返回“尚未实现”，退出码 1。因此本节的重点不是演示一条可用的 core 调试命令，而是回答三个问题：

1. core 里有什么，为什么它能恢复崩溃现场；
2. `pkg/proc/core` 已经解析到什么程度，哪些还是空白；
3. 把 core 接进调试会话还差什么，为什么不是“只差一行接线”。

### 基础知识

#### core 文件是什么

core 是 ELF 格式的进程快照，ELF 头里的 `e_type` 是 `ET_CORE`。它不是可执行文件，不能被运行；它保存的是进程某个时刻的**虚拟地址空间内容**和**各线程的机器状态**，外加一些描述性元数据。调试器读 core 时，相当于把当时的内存和寄存器“摆回原位”，然后借助可执行文件的 DWARF 做符号化。

这里要注意“快照”二字：core 里没有被调试进程，只有它的数据。没有调度器、没有系统调用、没有下一条指令。所有需要让程序继续跑的操作，在 core 上都没有意义。

#### ELF core 的三个部分

内核生成的 core 通常只写程序头表、不写节头表；调试器消费的是 program header，不是 section header。按用途可以把 core 分成三块：

| 部分 | 作用 | 关键点 |
|---|---|---|
| ELF 头 + 程序头表 | 标识这是 core，并描述各段的位置 | `e_type = ET_CORE`；程序头表是读取入口 |
| `PT_LOAD` | 内存镜像：每个 VMA 对应一段数据 | `Vaddr` 是运行时虚拟地址；`Offset` 是数据在 **core 文件内**的偏移；`FileSiz` 是实际写出的字节数；`MemSiz` 是 VMA 大小 |
| `PT_NOTE` | 线程、进程、文件映射等元数据 | note 条目按 `namesz/descsz/type` 组织；core 的 note 名通常是 `CORE`，扩展状态可能用 `LINUX` |

`PT_LOAD` 的 `FileSiz` 和 `MemSiz` 经常不相等。只读的文件映射（可执行文件正文、共享库代码页）通常不会重复写进 core，此时 `FileSiz = 0`；`.bss`、零页这类区域只记 `MemSiz`，文件里没有对应数据。因此读 core 时不能把 `MemSiz` 当成文件长度，也不能假定 `Offset` 是原文件里的偏移——原文件偏移记录在 `NT_FILE` 里。

`PT_NOTE` 的每个 note 由 12 字节头（`namesz`、`descsz`、`type`）、4 字节对齐的 name、4 字节对齐的 desc 组成。core 里常见这几类：

| note | 内容 | godbgv2 的解析情况 |
|---|---|---|
| `NT_PRSTATUS`（1） | 每线程一条，含通用寄存器、`pr_pid`、信号状态等 | 只取 `pr_pid`（desc 偏移 32），寄存器没有解析 |
| `NT_PRPSINFO`（3） | 进程信息，含 pid、可执行文件名、启动参数 | 只取 pid（desc 偏移 24） |
| `NT_FILE`（4） | 非匿名 VMA 与文件的映射关系 | 只定义了常量 `ntFile = 4`，没有解析分支 |
| `NT_FPREGSET`、`NT_X86_XSTATE`、`NT_SIGINFO`、`NT_AUXV` | 浮点/扩展寄存器、信号信息、辅助向量 | 未解析 |

`NT_FILE` 的内容依次是：映射条目数 `count`、页大小 `page_size`、`count` 组 `(start, end, file_ofs)`，最后是 `count` 个 NUL 分隔的文件名。它只描述“哪个 VMA 来自哪个文件的哪一段”，本身不含内存数据。它的价值在于：当只读文件映射没有转储（`FileSiz = 0`）时，调试器可以按文件名和偏移回到可执行文件或共享库里读数据。godbgv2 目前没有走这条回退路径，后文会看到影响。

各字段的完整布局、`readelf` 输出示例，以及内核 `fill_files_note` 的行为，见附录 [12.17 扩展阅读：ELF 核心转储文件剖析](../../12-appendix/93-anatomy-of-elf-core-file.md)，这里不重复。

#### 为什么 core 能恢复崩溃现场

恢复现场靠三样东西：

1. **寄存器**：`RIP` 指向崩溃时停下的指令，`RSP` 指向栈顶，`RBP` 和被调用者保存寄存器串起调用链；
2. **内存**：栈上的返回地址、函数参数、局部变量，堆上的对象，数据段里的全局变量；
3. **映射**：某个地址属于哪个 VMA、是匿名内存还是文件映射、权限如何。

有了可执行文件的 DWARF，`RIP` 可以映射到函数和行号；`RSP`/`RBP` 配合 `.debug_frame` 的 CFI 规则可以逐帧回溯；变量的 `DW_AT_location` 可以告诉调试器“这个变量在某个寄存器里，或者在 `CFA-16` 的内存里”。这套机制和调试活进程时完全一样，区别只在数据来源：活进程从 ptrace 读，core 从文件读。

#### core 从哪来，godbgv2 为什么不生成

Linux 内核在进程收到某些信号时会生成 core，常见触发信号是 `SIGSEGV`、`SIGABRT`、`SIGFPE`、`SIGILL`、`SIGBUS`、`SIGQUIT`。是否生成、生成到哪里由两个东西决定：

```bash
# 当前 shell 的 core 大小限制，0 表示不生成
ulimit -c

# 放开限制，并指定 core 的命名格式
ulimit -c unlimited
echo '/tmp/core-%e-%p-%t' > /proc/sys/kernel/core_pattern
```

`gcore <pid>` 走的是另一条路：attach 到目标进程，读 `/proc/<pid>/maps`、内存和寄存器，再按 ELF core 格式写文件。转储期间目标进程是暂停的，所以线上服务要先摘流量。

godbgv2 不生成 core：`cmd/debug` 下没有 `dump` 命令，`pkg/target` 里也没有写 ELF core 的代码。仓库里唯一带 `CoreDump` 字样的地方是 `pkg/target/continue.go:248` 的 `status.CoreDump()`，它只是把 wait status 描述成字符串，和“写 core”没有关系。所以本节的 core 文件要么由内核生成，要么由 `gcore` 之类的工具生成，godbg 只负责读。

### 代码实现

core 相关代码分两块：`cmd/core.go` 是命令层，目前是桩；`pkg/proc/core` 是解析后端，已经实现并有单元测试。先看命令，再看后端，最后看两者之间缺的那座桥。

> 说明：本节上一版以 tinydbg（delve 的裁剪版）为参考实现，那套 core 生成与加载链路在 godbgv2 中并不存在；本节按 godbgv2 的实际代码重写，凡与旧稿冲突处，以代码为准。

#### 1. 命令层：一个返回错误的 `RunE`

`cmd/core.go` 全文只有 22 行：

```go
package cmd

import (
	"errors"

	"github.com/spf13/cobra"
)

// coreCmd 调试 core 转储文件
var coreCmd = &cobra.Command{
	Use:   "core <corefile> <executable>",
	Short: "调试 core 转储文件",
	Long:  `调试 core 转储文件`,
	RunE: func(cmd *cobra.Command, args []string) error {
		// TODO(ch9.2.15): 解析 ELF core 文件（PT_LOAD/PT_NOTE）
		return errors.New("core 调试尚未实现，将在 ch9.2.15 中完成")
	},
}

func init() {
	rootCmd.AddCommand(coreCmd)
}
```

`Use` 明确定义了参数顺序：core 文件在前、可执行文件在后。`RunE` 里只有一行 TODO 和一行 `return errors.New(...)`：不校验参数个数，不打开文件，也不碰 `cmd.Client`。所以 core 文件存不存在、可执行文件对不对，结果完全一样。

这个桩和 `frame`、`next` 那类“`Run` + `fmt.Println("TODO")`”的静默桩不同：它用 `RunE` 返回错误。cobra 收到错误后先打印 `Error: ...` 和 usage，`cmd/root.go:31-35` 的 `Execute` 再把错误打印一遍并 `os.Exit(1)`。终端上会看到同一句错误出现两次，退出码是 1，脚本能靠退出码发现失败。`--help` 不经过 `RunE`，照常打印帮助并返回 0。

命令层没有调用任何服务方法。真要接线，这里至少要做三件事：解析两个参数、调用一个新的“打开 core”服务方法、在 `PostRun` 里进入调试会话。`cmd/session.go:15-19` 的注释已经把 core 列进了“进程级命令”，但 `cmd/core.go` 并没有 `PostRun`，会话层现在等不到 core 的 target。

#### 2. 后端入口：`core.OpenCore(corefile)`

`pkg/proc/core/core.go:31-58` 是后端入口：

```go
// OpenCore 解析 ELF core 文件
func OpenCore(path string) (*CoreFile, error) {
	f, err := elf.Open(path)
	if err != nil {
		return nil, err
	}
	if f.Type != elf.ET_CORE {
		f.Close()
		return nil, fmt.Errorf("%s is not a core file (type %v)", path, f.Type)
	}

	c := &CoreFile{f: f}
	for _, prog := range f.Progs {
		if prog.Type == elf.PT_LOAD {
			c.loads = append(c.loads, prog)
		}
		if prog.Type == elf.PT_NOTE {
			if err := c.parseNotes(prog); err != nil {
				f.Close()
				return nil, err
			}
		}
	}
	if len(c.loads) == 0 {
		f.Close()
		return nil, fmt.Errorf("core file has no PT_LOAD segments")
	}
	return c, nil
}
```

四步：`elf.Open` 打开文件；检查 `Type` 必须是 `ET_CORE`，否则返回“不是 core 文件”；遍历 program header，收集 `PT_LOAD`、解析 `PT_NOTE`；一个 `PT_LOAD` 都没有就报错。所有错误路径都会 `f.Close()`，成功时由调用方负责 `Close()`。

`CoreFile` 只保存四样东西：底层的 `*elf.File`、`PT_LOAD` 列表、线程摘要、pid。它没有可执行文件路径、没有 `BinaryInfo`、没有 `Target`。`OpenCore` 的参数也只有 core 文件：命令行里的第二个参数 `<executable>` 目前完全没被使用，后端不打开它，也不校验它是否与 core 匹配。

更直接的一点：仓库里没有任何非测试代码 import `pkg/proc/core`（`git grep 'proc/core'` 为空）。后端是“孤岛”，只有它自己的单元测试在调用。

#### 3. 内存镜像：`ReadMemory`

`pkg/proc/core/core.go:70-81` 是唯一的内存读取入口：

```go
// ReadMemory 从 core 的内存镜像读取数据（按 PT_LOAD 段映射）
func (c *CoreFile) ReadMemory(addr uint64, size int) ([]byte, error) {
	for _, prog := range c.loads {
		if addr >= prog.Vaddr && addr+uint64(size) <= prog.Vaddr+prog.Memsz {
			buf := make([]byte, size)
			if _, err := prog.ReadAt(buf, int64(addr-prog.Vaddr)); err != nil {
				return nil, err
			}
			return buf, nil
		}
	}
	return nil, fmt.Errorf("address %#x not mapped in core", addr)
}
```

逻辑很直白：线性扫描 `loads`，找到第一个满足 `addr >= Vaddr && addr+size <= Vaddr+Memsz` 的段，然后从 `prog` 里读 `addr-Vaddr` 处的内容。`prog` 是 `debug/elf` 的 `*elf.Prog`，它的 `ReadAt` 范围是 core 文件里的 `FileSiz` 字节。

这段代码有三个边界，读 core 时会真实遇到：

1. **不能跨段**。一次读必须完整落在一个 `PT_LOAD` 内。跨段会直接返回 `address %#x not mapped in core`；即使起始地址在段内、只是读取越过了段尾，错误也是这一句，看起来像“整段都不存在”。
2. **范围检查用 `Memsz`，实际数据只有 `FileSiz`**。落在 `[Vaddr+FileSiz, Vaddr+Memsz)` 的读取会失败——`.bss` 尾部、被内核省略的只读页都属于这种情况；`FileSiz = 0` 的段整段都读不到。
3. **不回退可执行文件**。即使命令行给了 exe，`ReadMemory` 也不会去 exe 的 `PT_LOAD` 里找数据。`NT_FILE` 没解析，后端也没有打开 exe，所以只读代码页一旦没被转储，这里就是空白。

对“静态查看”来说，前两条是待补的能力，第三条是设计缺口。调试活进程时，代码页在内存里，ptrace 随时能读；core 里没有就是没有，必须靠外部文件补。

#### 4. `PT_NOTE`：线程、pid 与缺席的寄存器

`pkg/proc/core/core.go:95-131` 解析 note 字节流：

```go
// parseNoteBytes 解析 PT_NOTE 段数据（独立函数，便于单元测试）
func parseNoteBytes(data []byte) (threads []ThreadState, pid int32) {
	for len(data) >= 12 {
		// note 头：namesz(u32) descsz(u32) type(u32) name(4 对齐) desc(4 对齐)
		namesz := binary.LittleEndian.Uint32(data[0:])
		descsz := binary.LittleEndian.Uint32(data[4:])
		ntype := binary.LittleEndian.Uint32(data[8:])

		nameOff := 12
		descOff := nameOff + int((namesz+3)&^3)
		total := descOff + int((descsz+3)&^3)
		if total > len(data) {
			return threads, pid // 截断的 note：忽略余下数据
		}

		// namesz 包含结尾 NUL，比较时剔除
		name := strings.TrimRight(string(data[nameOff:nameOff+int(namesz)]), "\x00")
		if name == "CORE" {
			desc := data[descOff : descOff+int(descsz)]
			switch ntype {
			case ntPrStatus:
				// elf_prstatus：pr_pid 位于偏移 32 处（x86_64 约定）
				if len(desc) >= 36 {
					threads = append(threads, ThreadState{
						TID: int32(binary.LittleEndian.Uint32(desc[32:])),
					})
				}
			case ntPrPsInfo:
				// elf_prpsinfo：pr_pid 位于偏移 24 处
				if len(desc) >= 28 {
					pid = int32(binary.LittleEndian.Uint32(desc[24:]))
				}
			}
		}
		data = data[total:]
	}
	return threads, pid
}
```

解析顺序是：先读 12 字节 note 头，再按 4 字节对齐跳过 name 和 desc，最后推进到下一个 note。只有 name 为 `CORE` 的 note 才进入 `switch`；`LINUX` 的扩展状态 note（例如 `NT_X86_XSTATE`）即使存在也不会被处理。

关键在 `switch` 的两个分支：

- `NT_PRSTATUS` 的 desc 是 `elf_prstatus`，本来包含完整的通用寄存器（`pr_reg`）、信号信息和 `pr_pid`。代码只从偏移 32 取了 `pr_pid`，`ThreadState` 里也只有 `TID` 一个字段；`CoreFile` 没有 `Registers` 方法。也就是说，**寄存器数据在 core 文件里，但后端没有把它读出来**。
- `NT_PRPSINFO` 只从偏移 24 取了 pid。可执行文件名、启动参数都没有解析。

`NT_FILE` 的情况最典型：常量 `ntFile = 4` 在第 14 行定义了，但 `switch` 里没有对应分支。文件名、文件内偏移都没读，`NT_FILE` 在 godbgv2 里目前只是一个“占位常量”。此外，`parseNoteBytes` 遇到截断的 note 会直接返回已解析的部分，不报错；如果 core 有多个 `PT_NOTE` 段，`parseNotes` 每段都执行 `c.threads, c.pid = parseNoteBytes(data)`，后一段会覆盖前一段的结果（内核生成的 core 通常只有一个 `PT_NOTE`，所以现在没有暴露）。

偏移 32 和 24 是 linux/amd64 的布局，godbgv2 也只支持 linux/amd64。换架构时这两个硬编码偏移和 `elf_prstatus`/`elf_prpsinfo` 的布局都要跟着改。

#### 5. 从 `CoreFile` 到调试会话：为什么不是“只差接线”

这是整节最容易被低估的部分。`pkg/proc/core` 产出的是一个独立的 `CoreFile`，而调试会话用的是 `proc.Target`。两者之间不是少一个函数调用，而是少一层抽象。

先看 `pkg/proc/target.go:11-20` 的 `Target`：

```go
type Target struct {
	dbp *target.DebuggedProcess
	bi  *BinaryInfo

	bps          []*Breakpoint
	breaklets    map[uint64][]*Breaklet
	selGoroutine *Goroutine
	selThread    *Thread
}
```

`dbp` 是具体的 `*target.DebuggedProcess`，不是接口。`NewTarget` 的第一件事是按 pid 找符号文件：

```go
// NewTarget 创建符号级调试目标：解析 /proc/<pid>/exe 的符号信息
func NewTarget(dbp *target.DebuggedProcess) (*Target, error) {
	bi, err := NewBinaryInfo(fmt.Sprintf("/proc/%d/exe", dbp.Process.Pid))
	if err != nil {
		return nil, err
	}
	return &Target{
		dbp:       dbp,
		bi:        bi,
		breaklets: map[uint64][]*Breaklet{},
	}, nil
}
```

这条路径默认目标是活进程：有 pid、有 `/proc/<pid>/exe`。core 两样都没有——core 里记录的 pid 是崩溃进程的 pid，不是当前进程，也没有对应的 `/proc` 项；符号文件只能从命令行第二个参数显式传。`target.DebuggedProcess` 同样装不下 core：它有 `Process *os.Process`、`Threads map[int]*Thread`、`reqCh`/`doneCh` 这些 ptrace 请求通道，创建入口只有 `NewDebuggedProcess`（launch）和 `AttachTargetProcess`（attach），core 两者都不是。

再看调用面。`pkg/proc` 里对 `t.dbp`（以及 `Thread` 里转存的 `th.dbp`）的引用一共 **56 处**，分布如下：

| 文件 | 引用数 |
|---|---:|
| `pkg/proc/backtrace.go` | 11 |
| `pkg/proc/variables.go` | 9 |
| `pkg/proc/breakpoints.go` | 9 |
| `pkg/proc/goroutines.go` | 9 |
| `pkg/proc/call.go` | 8 |
| `pkg/proc/threads.go` | 6 |
| `pkg/proc/location.go` | 2 |
| `pkg/proc/moduledata.go` | 1 |
| `pkg/proc/target.go` | 1 |
| **合计** | **56** |

其中 48 处是 `t.dbp.xxx` 形式的方法调用，另有 1 处 `th.dbp.ReadRegister`，其余 7 处是判空或把 `dbp` 转存进 `Thread`。被调用的能力包括 `ReadMemory`、`ReadRegister`、`WriteRegister`、`Continue`、`SingleStep`、`CurrentThreadTid`、`Breakpoints`/`Threads` 字段等。要让 core 复用符号层（`FindFunction`、`Backtrace`、`EvalExpression`），第一步是把这些能力抽成接口：内存读取、寄存器读取、线程列表、断点操作；core 提供只读实现，活进程提供 ptrace 实现。然后 56 处调用点改成走接口——这不是一行改动，而是一次贯穿 `pkg/proc` 的重构。

服务层同样没有入口。`api.Client` 没有打开 core 的方法，`rpc2` 没有对应消息，`debugger.Debugger` 只有 `Launch` 和 `Attach` 两条创建 target 的路径；`cmd/core.go` 也没有调用 `Client`。真要接线，至少穿过这些层：

| 层 | 现状 | core 需要补什么 |
|---|---|---|
| `cmd/core.go` | `RunE` 直接返回错误 | 解析参数、调用新服务方法、`PostRun` 启动会话 |
| `pkg/service/api` | `Client` 无 core 方法 | 新增“打开 core”的契约 |
| `pkg/service/rpc2` | 无 core 消息 | 请求/响应结构与 handler |
| `pkg/service/debugger` | 只有 `Launch`/`Attach` | `OpenCore`：解析 core、建符号层、建 core target |
| `pkg/proc` | `Target` 持有具体 `dbp` | 抽 backend 接口，增加 core 实现 |
| `pkg/proc/core` | 无寄存器、`NT_FILE` 未解析 | 补寄存器、可选的文件映射回退 |

还有几个容易漏的点：

- `api.Kind` 只有 `KindDebug`/`KindExec`/`KindAttach` 三种，`cmd/debug/exit.go:50-66` 的 `Cleanup` 没有 core 分支；`debugger.State()` 直接读 `dbp.Process.Pid`，core 目标会在这些地方空指针或走错分支。core 会话结束时该做的是关闭文件，不是 kill/detach。
- `BinaryInfo` 会记录 `staticBase`，但 `FuncForPC`/`PCToLine` 直接拿 pc 和 DWARF 里的链接地址比较，没有做减法。非 PIE 的 Go 程序两者一致；PIE 程序被内核随机加载后，core 里的运行时地址需要先按实际加载基址换算。Go 默认非 PIE，所以示例程序上这个坑不出现，但不能当成不存在。
- `ReadMemory` 只能读 core 的 `PT_LOAD`。一旦要读只读代码页，还得靠 `NT_FILE` + 可执行文件，或者在生成 core 时把这段也转储。

所以“只差接线”只在“后端能解析出 pid 和线程数”这个意义上成立。要跑通一条 `bt`，至少还差寄存器解析、backend 抽象、服务入口、地址换算。更准确的说法是：**解析后端已就绪，调试能力尚未接线，中间隔着一层目标抽象。**

### 执行测试

先看命令的现状。构建后直接执行：

```bash
$ go build -o godbg .
$ ./godbg core /tmp/no-such.core /tmp/no-such.exe
Error: core 调试尚未实现，将在 ch9.2.15 中完成
Usage:
  godbg core <corefile> <executable> [flags]

Flags:
  -h, --help   help for core

Global Flags:
      --headless            headless 模式：作为调试服务端运行（ch9.2.16）
      --init string         startup script file to replay (batch mode)
      --listen string       headless 模式的监听地址（ch9.2.16） (default "127.0.0.1:0")
      --log                 enable debug logging
      --log-output string   write logs to file instead of stderr
  -v, --verbose             show verbose info

core 调试尚未实现，将在 ch9.2.15 中完成
$ echo $?
1
```

这些输出全部走 stderr，stdout 为空。第一段 `Error:` 加 usage 是 cobra 打印的，最后重复的一行来自 `cmd/root.go:31-35` 的 `Execute`；`os.Exit(1)` 保证脚本能识别失败。core 文件不存在、可执行文件不存在，结果都一样——桩根本不会去打开它们。`--help` 走另一条路径：正常打印 `Usage: godbg core <corefile> <executable> [flags]`，不经过 `RunE`，退出码 0。

后端的行为由 `pkg/proc/core` 的单元测试覆盖：

```bash
$ go test ./pkg/proc/core -v -count=1
=== RUN   TestOpenCore
    core_test.go:33: no core file generated (core_pattern may redirect it)
--- SKIP: TestOpenCore (0.01s)
=== RUN   TestParseNoteBytes
--- PASS: TestParseNoteBytes (0.00s)
PASS
ok  	github.com/hitzhangjie/godbgv2/pkg/proc/core	0.008s
```

`TestParseNoteBytes` 不依赖环境：它构造一段合成的 note 字节流——一条 `NT_PRPSINFO`（pid 4242）加两条 `NT_PRSTATUS`（tid 4242、4243）——断言解析出的 pid 和两个 tid。这验证的是 note 头、4 字节对齐和偏移 24/32 的取法。

`TestOpenCore` 是真实 core 测试：先把 `RLIMIT_CORE` 的软限制抬高（本机初始 `ulimit -c` 为 0），让 `/bin/sh -c "kill -SEGV $$"` 在临时目录里崩溃，再 `filepath.Glob(filepath.Join(dir, "core*"))` 找 core；找不到就 `t.Skipf`，不强行失败。找到后断言 pid 为正、至少有一个线程，并尝试 `ReadMemory(0x400000, 16)`，失败只打日志不判错。本机 `core_pattern` 是 `/var/cores/core.%e...`，core 被内核写到 `/var/cores`，临时目录里没有，于是 Skip；这不是解析失败，而是测试对环境的诚实处理。

为确认 Skip 不等于解析失败，笔者把测试实际写到 `/var/cores` 的那份 core 交给 `core.OpenCore`：pid 正常、线程数为 1，和 `TestOpenCore` 的断言一致。这说明 `PT_LOAD`/`PT_NOTE` 的基本读取是通的。

但命令层没有接线，以上测试都无法通过 `godbg core` 触发。core 会话能做什么、不能做什么，目前没有可执行样例可测。

### 本节小结

本节讲的是“后端已就绪、命令未接线”的 core 调试：

- **后端**：`core.OpenCore(corefile)` 校验 `ET_CORE`、收集 `PT_LOAD`、解析 `PT_NOTE`；`ReadMemory` 按 `PT_LOAD` 的 `Vaddr`/`Memsz` 找段，用 `prog.ReadAt` 读 `FileSiz` 范围内的数据；`parseNoteBytes` 从 `NT_PRSTATUS` 取 `pr_pid`、从 `NT_PRPSINFO` 取 pid。寄存器、`NT_FILE` 都还没解析。
- **命令**：`godbg core <corefile> <executable>` 的参数顺序是 core 在前、exe 在后；`cmd/core.go` 的 `RunE` 返回“尚未实现”，退出码 1。它不是静默成功，也不会打开任何文件。
- **接线成本**：`proc.Target` 直接持有 `*target.DebuggedProcess`，`pkg/proc` 有 56 处 `t.dbp`/`th.dbp` 引用；`NewTarget` 走 `/proc/<pid>/exe`，core 没有 pid；`api.Client`/`rpc2`/`debugger` 都没有 core 入口。要复用符号层，先抽 backend 接口，再补服务链路和寄存器解析。
- **生成侧**：godbgv2 没有 `dump` 命令，也不生成 core；core 由内核在致命信号时生成，或由 `gcore` 主动转储。
- **能力边界**：core 是静态快照，不能 `continue`、`next`、`step`；即使接线，也只能做静态查看。`bt` 依赖寄存器，`frame` 目前是桩，`locals`/`args` 命令还不存在——这些都要等 core 目标真正接上以后才有意义。

一句话：现在的 `pkg/proc/core` 是一个合格的“core 文件读取器”，还不是一个“core 调试器”；`godbg core` 是一个诚实的桩。下一步不是改一行 `RunE`，而是先把目标层从 `ptrace` 解耦出来。
