## 调试命令：`clear -n <id>` 移除断点

6.6 节实现了 `break`：把断点地址处的指令首字节 patch 成 `0xCC`，并把断点登记进按地址、按编号两张索引；6.7 节实现了 `breakpoints`：按编号升序列出已添加的断点。断点能加、能看，接下来就要能删——断点下错了位置、或者某个位置已经不再关心，都需要把它摘掉。

摘掉断点不只是从列表里删一行。目标进程内存里那个 `0xCC` 必须换回原来的指令，否则进程之后执行到那里会收到一个没有对应断点的 SIGTRAP。所以移除断点和添加断点是一对严格的反向操作：添加时"保存原始字节、写入 `0xCC`、登记断点"，移除时"按编号找到断点、把原始字节写回去、摘除登记"。6.6 节保存的 `Orig` 字段，就是为这一刻准备的。

本节配套代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.8`，`git diff ch6.7 ch6.8` 可以看到这一节改了什么：命令层把 `clear` 子命令的占位实现补全，`api.Client` 和 `debugger` 门面各补一个方法，目标层新增 `ClearBreakpoint`、`RestoreInstruction` 以及"断点不存在"错误。

### 实现目标：`godbg> clear -n <id>` 移除断点

`clear` 按编号移除一个断点，编号通过 `-n` 指定：

```bash
godbg> clear -n 1           # 移除编号为 1 的断点
```

移除成功后输出断点编号和地址，便于确认删掉的是哪一个：

```bash
godbg> clear -n 1
breakpoint 1 at 0x478120 cleared
```

这里有几点约定：

- 编号就是 `breakpoints` 输出里的 `breakpoint[1]` 中的数字。编号是用户操作断点的句柄，6.7 节用它列出断点，本节用它移除断点；
- `-n` 是 `uint64` 类型的 flag，默认值为 1。也就是说 `clear` 不带参数等价于 `clear -n 1`，会直接移除编号 1 的断点。为了避免误删，实际操作时应当始终显式写上 `-n <id>`；
- 一次只移除一个断点。想一次清空全部断点用 6.9 节的 `clearall`；
- 编号不存在时明确报错，而不是静默成功：

  ```bash
  godbg> clear -n 9
  Error: 移除断点失败: breakpoint not existed
  ```
- 删除后的编号不会回收。编号由包级变量 `bpSeqNo` 单调递增分配，删掉断点 1 后再添加新断点，新断点拿到的是下一个编号，而不是 1。

### 设计要点：按编号查、按地址还原

#### 两次查找：编号 → 地址 → 断点

移除断点的第一步是找到它。用户给的是编号，而还原指令需要地址，所以要走两次索引：

```text
BreakpointsByID[id]  →  *Breakpoint（拿到 Addr、Orig）
Breakpoints[addr]    →  *Breakpoint（RestoreInstruction 内部再确认一次）
```

两张 map 都是 O(1) 查找，不需要遍历断点集合。6.6 节建立这两张索引时已经说明了分工：按编号索引服务用户视角的增删查，按地址索引服务内存操作和去重。这里正好把两者串起来。

`ClearBreakpoint` 在拿到 `bp` 之后调用 `RestoreInstruction(bp.Addr)`，而不是自己直接 POKE。多一层调用的原因是"按地址还原指令"本身是一个独立的原子动作：6.9 节 `clearall` 要逐个断点还原，6.12 节 `continue` 命中断点后也要先还原指令、单步越过、再重新加上断点。把这部分抽成 `RestoreInstruction`，三处共用同一套逻辑，不会出现某一处漏删索引、或者还原顺序写反。

#### 还原顺序：先 POKE，后摘索引

`RestoreInstruction` 的顺序是：先 `PTRACE_POKEDATA` 把 `Orig` 写回断点地址，成功后再删除两张索引里的记录。顺序不能反：

- 如果先删索引、再 POKE，一旦 POKE 失败（地址失效、进程已退出等），断点记录已经没了，`Orig` 也找不回来，目标进程内存里的 `0xCC` 就永远留在那里；
- 先 POKE、成功后再删，失败时两张索引原封不动，`Orig` 还在，用户可以重试 `clear`，或者先排查目标进程状态。

两次 `delete` 都放在 `ExecPtrace` 的闭包里、POKE 成功之后执行，任何一步出错都会提前 return，不会出现"内存还原了但索引还在"或"索引删了但内存没还原"的中间状态。

#### `PTRACE_POKETEXT` 还是 `PTRACE_POKEDATA`

本节代码用的是 `syscall.PtracePokeData`，6.6 节添加断点用的是 `PtracePeekText`、`PtracePokeText`。在 Linux 上，`PTRACE_PEEKTEXT`/`PTRACE_PEEKDATA` 以及 `PTRACE_POKETEXT`/`PTRACE_POKEDATA` 的行为并没有区别：x86-64 不区分指令和数据地址空间，两套请求最终都落到同一片内存上，可以混用。6.6 节添加断点时读写的都是指令，所以用 TEXT；本节还原时写成 DATA，只是习惯上的分类，把这里换成 POKETEXT 结果完全相同，读者不必纠结。

#### 本节边界：只还原指令，没有回退线程 PC

本节只做了"还原指令 + 摘除索引"，没有处理一种特殊情况：某个线程已经停在了要删除的断点处。此时该线程执行过 `0xCC`，PC 指向断点地址的下一条指令（`PC = addr + 1`）。如果只还原指令、不回退 PC，之后恢复该线程执行时，CPU 会从完整指令的第二个字节开始译码，得到一条完全不同的指令，轻则行为异常，重则直接崩溃。

godbgv2 在 `ClearBreakpoint` 的注释里明确把这件事留到了后面：

```go
// 注意：如果某个线程恰好停在断点处（PC=断点地址+1），还需回退该线程
// 的 PC，这部分在多线程调试（ch6.20.5）中实现。
```

在本节的调试流程里，目标进程通常刚在 exec 或 attach 后停住，还没有执行到任何断点，所以不会触发这种情况；但 `continue`（6.12）让程序跑到断点之后，再执行 `clear` 就可能碰上。6.20 节实现多线程断点时会遍历线程列表，对停在断点处的线程做 PC 回退（6.20.5 节）。本节先把单线程、非命中状态下的移除做对，把限制写在注释里。

### 在 godbgv2 中实现

相对 ch6.7，这一节的调用链是：

```text
godbg> clear -n <id>
    cmd/debug/clear.go            RunE：读 -n flag；调 Client.ClearBreakpoint；
                                  打印编号与地址
    pkg/service/api               Client 接口：新增 ClearBreakpoint(id)，返回被删断点的值快照
    pkg/service/debugger          门面，检查 dbp 非空后转给目标层
    pkg/target                    breakpoint.go：ClearBreakpoint 按编号查找；
                                  RestoreInstruction 还原指令、摘除两张索引
```

下面按命令层、服务层、目标层分别看。

#### 命令层

`cmd/debug/clear.go` 在 6.7 节时还是一个占位命令，`Run` 里只有一句 `TODO(ch6.8): clear 尚未实现`。本节把它补全，完整代码如下：

```go
package debug

import (
	"fmt"

	"github.com/spf13/cobra"
)

var clearCmd = &cobra.Command{
	Use:   "clear -n <id>",
	Short: "移除指定编号的断点",
	Long:  `移除指定编号的断点，并还原断点处的原始指令`,
	Annotations: map[string]string{
		cmdGroupAnnotation: cmdGroupBreakpoints,
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		id, err := cmd.Flags().GetUint64("n")
		if err != nil {
			return err
		}

		bp, err := Client.ClearBreakpoint(id)
		if err != nil {
			return fmt.Errorf("移除断点失败: %v", err)
		}

		fmt.Printf("breakpoint %d at %#x cleared\n", bp.ID, bp.Addr)
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(clearCmd)

	clearCmd.Flags().Uint64P("n", "n", 1, "断点编号")
}
```

几个要点：

- `RunE` 而不是 `Run`：`ClearBreakpoint` 可能返回错误（断点不存在、ptrace 失败、没有正在调试的进程），`RunE` 让错误能一路抛给 cobra，最终打印成 `Error: ...`。6.6 节 `break`、6.7 节 `breakpoints` 也是同样的写法；
- `Annotations` 把命令归到断点分组，`help` 按分组展示时，`break`、`breakpoints`、`clear` 排在一起（命令分组在 5.7 节搭骨架时介绍过）；
- 命令层不做查找，也不碰 ptrace：`Client.ClearBreakpoint(id)` 返回被删除断点的 `*api.Breakpoint` 快照，命令层只按 `breakpoint %d at %#x cleared` 打印编号和地址。后端不打印、前端只展示，与前面几个命令一致；
- `Uint64P("n", "n", 1, ...)` 注册了长选项 `--n` 和短选项 `-n`，类型是 `uint64`，默认值 1。非法值（比如 `clear -n abc`）在 cobra 解析 flag 阶段就会报 `invalid argument "abc" for "-n, --n" flag`，`GetUint64` 的错误分支基本走不到；保留它只是为了让取值路径完整。

#### 服务层

`pkg/service/api/client.go` 给 `Client` 接口增加了一个方法（这里只列断点相关部分）：

```go
type Client interface {
	// ...（Launch、State、Disassemble、AddBreakpoint、ListBreakpoints 等，此处省略）
	// AddBreakpoint 在地址 addr 处添加断点
	AddBreakpoint(addr uint64) (*Breakpoint, error)
	// ListBreakpoints 按编号升序返回全部断点
	ListBreakpoints() ([]Breakpoint, error)
	// ClearBreakpoint 移除指定编号的断点
	ClearBreakpoint(id uint64) (*Breakpoint, error)
}
```

返回值是 `*Breakpoint` 而不是只返回 `error`，因为命令层要打印"删掉的是哪个断点"。返回的是断点信息的值快照，内部记录已经从索引里摘除了，但这份快照本身仍然有效：

- `Breakpoint` 是服务层的纯值类型（6.6 节定义在 `pkg/service/api/types.go`），字段都是 `uint64`、`string`、`byte` 这类可序列化的类型；
- 第 9 章引入 headless RPC 后，这个返回值要跨进程传输，值快照可以直接序列化；如果返回内部 `*target.Breakpoint`，既暴露目标层实现，也没法跨进程传。

`pkg/service/debugger/debugger.go` 里的门面方法：

```go
// ClearBreakpoint 移除指定编号的断点
func (d *Debugger) ClearBreakpoint(id uint64) (*api.Breakpoint, error) {
	if d.dbp == nil {
		return nil, fmt.Errorf("no debugged process")
	}
	return d.dbp.ClearBreakpoint(id)
}
```

门面做的事情很薄：检查 `d.dbp` 是否为空，然后把请求转给目标层。`d.dbp == nil` 说明当前没有 exec/attach 任何进程，此时返回 `no debugged process` 比让后面的空指针 panic 更友好。文件末尾的 `var _ api.Client = (*Debugger)(nil)` 在编译期保证门面没有漏掉接口方法。

#### 目标层：按编号查、按地址还原

`pkg/target/breakpoint.go` 新增了一个错误值和两个方法：

```go
var (
	// ErrBreakpointNotExisted 断点不存在
	ErrBreakpointNotExisted = fmt.Errorf("breakpoint not existed")
)

// ClearBreakpoint 移除指定编号的断点：还原断点处的原始指令，
// 并摘除断点索引。
//
// 注意：如果某个线程恰好停在断点处（PC=断点地址+1），还需回退该线程
// 的 PC，这部分在多线程调试（ch6.20.5）中实现。
func (p *DebuggedProcess) ClearBreakpoint(id uint64) (*api.Breakpoint, error) {
	bp, ok := p.BreakpointsByID[id]
	if !ok {
		return nil, ErrBreakpointNotExisted
	}

	if _, err := p.RestoreInstruction(bp.Addr); err != nil {
		return nil, err
	}
	return toAPIBreakpoint(bp), nil
}

// RestoreInstruction 移除断点：还原指令数据，并从断点索引中移除
func (p *DebuggedProcess) RestoreInstruction(addr uintptr) (*Breakpoint, error) {
	bp, ok := p.Breakpoints[addr]
	if !ok {
		return nil, ErrBreakpointNotExisted
	}

	pid := p.Process.Pid

	err := p.ExecPtrace(func() error {
		n, err := syscall.PtracePokeData(pid, bp.Addr, []byte{bp.Orig})
		if err != nil || n != 1 {
			return fmt.Errorf("ptrace poke data err: %v", err)
		}
		delete(p.Breakpoints, bp.Addr)
		delete(p.BreakpointsByID, bp.ID)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return bp, nil
}
```

逐段说明：

- `ClearBreakpoint` 先用 `BreakpointsByID[id]` 按编号找断点，找不到就返回 `ErrBreakpointNotExisted`。这是"编号不存在"报错的来源；
- 找到后交给 `RestoreInstruction(bp.Addr)`，由它完成真正的还原和摘除。返回值被丢弃，是因为调用方已经拿着 `bp`，只需要知道成功与否；
- `RestoreInstruction` 再按地址查一次 `Breakpoints[addr]`。这不是多余：地址索引才是"这个地址上到底有没有断点"的权威判断，将来 `continue`、`clearall` 都会直接按地址调它。两张索引理论上是一致的——6.6 节添加断点时一起写、这里一起删——真出现不一致时，按地址查不到就按"断点不存在"处理，不会去做一次没有依据的内存写；
- POKE 的字节数固定为 1，写的是 `bp.Orig`。`n != 1` 也当作失败处理：ptrace 的 POKE 正常只返回 1，返回其他值说明这次写入没有按预期完成；
- POKE 和两次 `delete` 都在 `ExecPtrace` 的闭包里。6.1 节讲过 ptrace limit：跟踪关系建立后，所有 ptrace 请求必须来自同一个 tracer 线程，`ExecPtrace` 保证串行、不跨线程；
- 删除时同时清掉 `BreakpointsByID[bp.ID]` 和 `Breakpoints[bp.Addr]`，避免留下"按编号还能查到、按地址已经查不到"的幽灵记录；
- 返回 `bp`（内部断点对象），由 `ClearBreakpoint` 转成 `*api.Breakpoint` 快照。内部结构不暴露给 client 侧。

### 运行效果

在 godbgv2 仓库里切到这一节，把调试器和 fixture 都构建出来：

```bash
git checkout ch6.8
make build
make fixtures
```

`make build` 产出 `./godbg`，`make fixtures` 把 `examples/debuggee` 下的示例程序编到 `_fixtures/`，编译时带 `-gcflags "all=-N -l"`，不做优化、不做内联。仍然用 `_fixtures/loop` 做目标程序，入口地址是 `0x478120`，`_rt0_amd64` 的地址是 `0x4749e0`（`readelf -h _fixtures/loop` 和 `objdump -d` 可以看到）。启动调试会话，添加两个断点，列出，然后移除编号 1 的断点：

```bash
$ ./godbg exec _fixtures/loop
process 2206561 launched, stopped by SIGTRAP
godbg> break 0x478120
breakpoint 1 added at 0x478120
godbg> break 0x4749e0
breakpoint 2 added at 0x4749e0
godbg> breakpoints
breakpoint[1] addr:0x478120, loc:-
breakpoint[2] addr:0x4749e0, loc:-
godbg> clear -n 1
breakpoint 1 at 0x478120 cleared
godbg> breakpoints
breakpoint[2] addr:0x4749e0, loc:-
godbg> exit
tracee is run by tracer, kill it
```

观察一下这段输出：

- `clear -n 1` 按编号找到了 `0x478120` 处的断点，输出里的编号和地址与 `breakpoints` 中编号 1 那条一致；
- 再次执行 `breakpoints`，只剩编号 2 的断点，说明 `ClearBreakpoint` 已经把它从两张索引里摘掉了。编号 2 保持不变，也说明删除不会影响其他断点的编号；
- 输出文案 `breakpoint %d at %#x cleared` 用的是断点自身的 `ID`、`Addr`，而不是用户输入；用户输入的是编号，展示的是"哪个断点被删了"，两者对得上。

只看列表还不够：断点从列表里消失，不代表目标进程内存里的 `0xCC` 已经换回去了。用 `disass` 在移除前后各看一次 `0x4749e0`：

```bash
$ ./godbg exec _fixtures/loop
process 2207188 launched, stopped by SIGTRAP
godbg> break 0x4749e0
breakpoint 1 added at 0x4749e0
godbg> disass 0x4749e0 -n 2
0x4749e0:	cc	int3
0x4749e1:	8b 3c 24	mov (%rsp),%edi
godbg> clear -n 1
breakpoint 1 at 0x4749e0 cleared
godbg> disass 0x4749e0 -n 2
0x4749e0:	48 8b 3c 24	mov (%rsp),%rdi
0x4749e4:	48 8d 74 24 08	lea 0x8(%rsp),%rsi
godbg> exit
tracee is run by tracer, kill it
```

这段对比很直观：

- 添加断点后，`0x4749e0` 的首字节是 `cc`，反汇编成 `int3`，从 `0x4749e1` 开始解码还把 REX 前缀 `48` 丢掉了，`mov (%rsp),%rdi` 变成了 `mov (%rsp),%edi`；
- `clear -n 1` 之后，首字节 `48` 回来了，指令恢复成完整的 `mov (%rsp),%rdi`，下一条也从正确的 `0x4749e4` 开始。这说明 `RestoreInstruction` 确实把 `Orig` 写回了目标进程内存，而不只是删了断点表里的一行；
- 反汇编读的是目标进程当前内存，所以这个对比能直接证明还原生效。如果只检查 `breakpoints`，是看不到这一层的。

会话退出时仍然走 6.4 节注册的清理逻辑，exec 启动的 tracee 被 kill，终端上会看到 `tracee is run by tracer, kill it`。

### 更多相关内容

**`clear` 与 `clearall`。** 两者共用 `RestoreInstruction`：下一节的 `clearall` 只是遍历断点集合逐个调用，`continue` 命中断点后的"还原—单步—重设"也复用它。

**断点表与内存的一致性。** 添加时先登记索引再 POKE、失败回滚，移除时先 POKE 再删索引、失败保留，避免索引与目标进程内存脱节。`Orig` 只存在调试器内存里，调试器异常退出时目标进程的 `0xCC` 没人还原，所以 6.10 节会在 `exit` 前调用 `clearall`。

**GDB 与 Delve。** GDB 的 `delete <num>`、Delve 的 `clear <id>`/`clearall` 语义与本节一致。它们删除断点时还会回退停在断点处的线程 PC，godbgv2 把这部分放在 6.20.5 节实现。

### 本节小结

本节实现了 `clear -n <id>`：按编号找到断点，把该地址处原有的指令字节写回目标进程，并从断点索引中摘除。它是 6.6 节添加断点的逆操作；停在断点处的线程 PC 回退留到 6.20.5 节处理。

下一节实现 `clearall`，一次清空所有断点；再往后是 `step`、`continue`，其中 `continue` 让程序真正运行到断点处。断点的"增、查、删、命中"闭环到这里只差最后一步。

### 参考文献

1. ptrace(2) - Linux manual page, https://man7.org/linux/man-pages/man2/ptrace.2.html
2. INT3/INT n - Intel 64 and IA-32 Architectures Software Developer's Manual, https://www.felixcloutier.com/x86/intn:into:int3:int1
3. GDB - Breakpoints, Watchpoints, and Catchpoints, https://sourceware.org/gdb/current/onlinedocs/gdb.html/Breakpoints.html
4. Delve - breakpoints and clear commands, https://github.com/go-delve/delve/tree/master/Documentation/cli
