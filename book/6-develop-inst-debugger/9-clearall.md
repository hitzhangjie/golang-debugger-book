## 调试命令：`clearall` 清空全部断点

6.8 节实现了 `clear -n <id>`，按编号移除一个断点。一次只删一个，清理少量断点够用；如果调试过程中陆续下了十几个断点，再逐个执行 `clear` 就有些繁琐，而且很容易漏掉某个编号。本节实现 `clearall`，一条命令清空全部断点。

`clearall` 没有引入新的底层机制。6.8 节已经把"按地址还原原始指令、摘除断点索引"抽成了 `RestoreInstruction`，`clearall` 要做的只是对断点表里的每一项都调用一次。所以本节的重点不在 ptrace，而在命令层、服务层、目标层怎么把这个批量操作串起来，以及批量处理时有哪些边界。

本节配套代码在 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.9`，`git diff ch6.8 ch6.9` 可以看到这一节改了什么：命令层把 `clearall` 的占位实现补全，`api.Client` 和 `debugger` 门面各补一个 `ClearAll` 方法，目标层新增 `ClearAll`。

### 实现目标：`godbg> clearall` 清空全部断点

`clearall` 不带参数，执行后清空当前所有断点：

```bash
godbg> clearall
清空断点成功
```

清空后再执行 `breakpoints`，列表为空：

```bash
godbg> clearall
清空断点成功
godbg> breakpoints
no breakpoints
```

这里有几点约定：

- `clearall` 不接受断点编号，也不提供"清空一部分"的选项。要精确删除某个断点用 6.8 节的 `clear -n <id>`，要全部清掉才用 `clearall`；
- 当前没有断点时执行 `clearall`，同样输出 `清空断点成功`。没有东西可清不算错误，命令是幂等的；
- 命令只输出一句结果，不逐条打印被清掉的断点。想看清理前有哪些断点，用 `breakpoints` 查；清理后再查一次，列表变空就是结果；
- 清空不会重置断点编号。编号由目标层的 `bpSeqNo` 单调递增分配，`clearall` 只是把断点表清掉，计数器不动。清空后再添加断点，拿到的仍然是下一个编号，而不是从 1 重新开始；
- 任何一个断点还原失败，`clearall` 都会返回错误，命令层打印成 `清空断点失败: ...`。此时已经处理过的断点保持已清理，尚未处理的还留在表里，具体边界见本节的设计要点。

### 设计要点：批量复用单次还原

#### `clearall` 只是循环调用 `RestoreInstruction`

6.8 节把移除断点拆成了两层：`ClearBreakpoint` 按编号查断点，`RestoreInstruction` 按地址还原指令并摘除索引。`clearall` 不需要编号，它直接遍历按地址索引的断点表：

```text
for 每个断点 bp in Breakpoints：
    RestoreInstruction(bp.Addr)
        → PTRACE_POKEDATA 写回 Orig
        → 从 Breakpoints、BreakpointsByID 中删除
```

这样拆分的好处是单次还原的逻辑只有一份。`clear`、`clearall`、以后 `continue` 命中后重新布置断点，用的都是同一个 `RestoreInstruction`，不会出现某个入口漏删索引、或者 POKE 与删索引顺序写反的情况。

#### 边遍历边删除是安全的

断点表 `p.Breakpoints` 是 map，`RestoreInstruction` 会从里面删除当前正在遍历的项。Go 允许在 `range` 一个 map 的过程中删除元素：已经遍历到的元素被删除，不影响后续元素继续被遍历。这里删的正是当前这一项，所以不会漏掉其他断点，也不需要先把 map 拷贝成切片再遍历。

反过来说，遍历顺序是不确定的。但每个断点的还原互相独立，先清哪个、后清哪个没有区别，所以无需排序。

#### 失败时不是一次全有或全无

`ClearAll` 遇到第一个错误就返回。已经成功还原的断点保持已清理状态，尚未处理的断点原样留在表里。也就是说，`clearall` 是一个"尽力而为"的批处理，不是事务：

- 对单个断点而言，`RestoreInstruction` 内部仍然是原子的——POKE 成功后才删索引，失败就都不变；
- 对整个批次而言，中途失败会留下"部分断点已清、部分还在"的状态，用户可以重新执行 `clearall`，把剩余的断点再清一遍。

在本节的调试流程里，目标进程刚在 exec 或 attach 后停住，内存地址有效、ptrace 跟踪关系正常，基本不会触发还原失败。真正需要担心的是进程已经退出或跟踪关系断开，这种情况下报错比静默成功更合适。

#### 本节边界：仍然没有回退线程 PC

和 6.8 节一样，本节只还原指令、摘除索引，没有处理"某个线程正停在断点处"的情况。线程执行过 `0xCC` 后 PC 指向断点地址的下一条指令，如果不回退 PC 就恢复执行，CPU 会从原指令的中间字节开始译码。

godbgv2 在 `ClearAll` 的注释里把这件事留到了多线程调试：

```go
// 注意：如果有线程停在断点处，还需回退这些线程的 PC（PC-1），
// 这部分在多线程调试（ch6.20.5）中实现。
```

`clearall` 一次性影响所有断点，受影响的线程数量可能比 `clear` 更多，所以这个限制更值得留意。不过本节还没有实现 `continue`，目标进程停在启动位置，不会主动跑到断点上；等 `continue`（6.12）可用之后，再清空断点就可能碰上停在断点处的线程，最终由 6.20.5 节统一处理。

### 在 godbgv2 中实现

相对 ch6.8，这一节的调用链是：

```text
godbg> clearall
    cmd/debug/clearall.go         RunE：调 Client.ClearAll；成功打印"清空断点成功"
    pkg/service/api               Client 接口：新增 ClearAll() error
    pkg/service/debugger          门面，检查 dbp 非空后转给目标层
    pkg/target                    breakpoint.go：ClearAll 遍历断点表，
                                  逐个调用 RestoreInstruction
```

下面按命令层、服务层、目标层分别看。

#### 命令层

`cmd/debug/clearall.go` 在 6.7 节时还是一个占位命令，`Run` 里只有一句 `TODO(ch6.9): 还原全部断点指令并清空索引`。本节把它补全，完整代码如下：

```go
package debug

import (
	"fmt"

	"github.com/spf13/cobra"
)

var clearallCmd = &cobra.Command{
	Use:   "clearall",
	Short: "清空全部断点",
	Long:  `清空全部断点，并还原所有断点处的原始指令`,
	Annotations: map[string]string{
		cmdGroupAnnotation: cmdGroupBreakpoints,
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := Client.ClearAll(); err != nil {
			return fmt.Errorf("清空断点失败: %v", err)
		}

		fmt.Println("清空断点成功")
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(clearallCmd)
}
```

几个要点：

- `RunE` 而不是 `Run`：`Client.ClearAll` 可能返回错误（没有正在调试的进程、ptrace 还原失败），`RunE` 让错误能一路抛给 cobra，最终打印成 `Error: ...`。6.8 节 `clear` 也是同样的写法；
- 不注册任何 flag，`Use` 就是 `clearall`。这个命令没有参数，也就没有参数解析和校验的负担；
- 错误统一包一层 `清空断点失败`，把后端返回的原始错误保留在冒号后面，用户既知道是哪个操作失败，也能看到底层原因；
- `Annotations` 把命令归到断点分组，`help` 按分组展示时，`break`、`breakpoints`、`clear`、`clearall` 排在一起（命令分组在 5.7 节搭骨架时介绍过）；
- 命令层不遍历断点、不碰 ptrace，只调用一次 `Client.ClearAll()` 并打印结果。后端负责做什么、做多少，前端不关心，这是 `docs/ARCH-RULES.md` 里定下的分层约定。

#### 服务层

`pkg/service/api/client.go` 给 `Client` 接口增加了一个方法（这里只列断点相关部分）：

```go
type Client interface {
	// ...（Launch、State、Disassemble、AddBreakpoint、ListBreakpoints 等，此处省略）
	// ClearBreakpoint 移除指定编号的断点
	ClearBreakpoint(id uint64) (*Breakpoint, error)
	// ClearAll 移除全部断点
	ClearAll() error
}
```

`ClearAll` 只返回 `error`，不像 `ClearBreakpoint` 那样返回被删断点的快照：

- 批量清空时，用户关心的是"清干净了没有"，而不是每个断点的编号和地址。清理前想确认有哪些断点，用 `breakpoints` 查即可；
- 不返回切片也避免了服务层为批量结果定义额外的值类型。等第 9 章引入 headless RPC，错误信息直接跨进程返回，签名不用改。

`pkg/service/debugger/debugger.go` 里的门面方法：

```go
// ClearAll 移除全部断点
func (d *Debugger) ClearAll() error {
	if d.dbp == nil {
		return fmt.Errorf("no debugged process")
	}
	return d.dbp.ClearAll()
}
```

门面仍然只做一件事：检查 `d.dbp` 是否为空，非空就转给目标层。`d.dbp == nil` 说明当前没有 exec/attach 任何进程，此时返回 `no debugged process` 比让后面的空指针 panic 更友好。文件末尾的 `var _ api.Client = (*Debugger)(nil)` 在编译期保证门面没有漏掉接口方法。

#### 目标层：遍历断点表逐个还原

`pkg/target/breakpoint.go` 新增了一个 `ClearAll` 方法：

```go
// ClearAll 删除所有已添加的断点。
//
// 注意：如果有线程停在断点处，还需回退这些线程的 PC（PC-1），
// 这部分在多线程调试（ch6.20.5）中实现。
func (p *DebuggedProcess) ClearAll() error {
	for _, bp := range p.Breakpoints {
		if _, err := p.RestoreInstruction(bp.Addr); err != nil {
			return fmt.Errorf("clear breakpoint at %#x error: %v", bp.Addr, err)
		}
	}
	return nil
}
```

逐段说明：

- 遍历的是 `p.Breakpoints`，也就是按地址索引的断点表。这里不需要按编号查找，因为 `clearall` 不面向某一个断点；
- 每一项都交给 `RestoreInstruction(bp.Addr)`。该方法会重新按地址查一次断点、POKE 回 `Orig`、再同时删除 `Breakpoints` 和 `BreakpointsByID`，单次还原的完整逻辑仍然只在 6.8 节那一处；
- 返回值被丢弃：`clearall` 不需要告诉上层"删掉的是哪个断点"，只要知道这一项成功了即可；
- 失败时错误信息带上断点地址（`clear breakpoint at %#x error`），因为批量操作没有编号上下文，地址是定位问题最直接的线索；
- 出错立即返回，不再继续处理后面的断点。这样调用方拿到错误时，能确定失败点之后还有断点没清，重新执行 `clearall` 即可继续。

### 运行效果

在 godbgv2 仓库里切到这一节，把调试器和 fixture 都构建出来：

```bash
git checkout ch6.9
make build
make fixtures
```

仍然用 `_fixtures/loop` 做目标程序，入口地址是 `0x478120`，`_rt0_amd64` 的地址是 `0x4749e0`（`readelf -h _fixtures/loop` 和 `objdump -d` 可以看到）。启动调试会话，添加两个断点，列出，然后清空：

```bash
$ ./godbg exec _fixtures/loop
process 2221680 launched, stopped by SIGTRAP
godbg> break 0x478120
breakpoint 1 added at 0x478120
godbg> break 0x4749e0
breakpoint 2 added at 0x4749e0
godbg> breakpoints
breakpoint[1] addr:0x478120, loc:-
breakpoint[2] addr:0x4749e0, loc:-
godbg> clearall
清空断点成功
godbg> breakpoints
no breakpoints
godbg> exit
tracee is run by tracer, kill it
```

观察一下这段输出：

- `clearall` 不带参数，一次把编号 1、2 两个断点都清掉了；
- 再执行 `breakpoints`，输出 `no breakpoints`，说明两张索引里的记录都已经摘除；
- 命令输出只有一句 `清空断点成功`，没有逐条罗列断点。清理前 `breakpoints` 的输出和清理后的空列表一起看，就能确认清掉的是哪些。

只看列表还不够：断点从表里消失，不代表目标进程内存里的 `0xCC` 已经换回去了。用 `disass` 在添加、清空前后各看一次 `0x478120`：

```bash
$ ./godbg exec _fixtures/loop
process 2221179 launched, stopped by SIGTRAP
godbg> disass 0x478120 -n 1
0x478120:	e9 bb c8 ff ff	jmpq 0xffffffffffffc8c4
godbg> break 0x478120
breakpoint 1 added at 0x478120
godbg> disass 0x478120 -n 1
0x478120:	cc	int3
godbg> clearall
清空断点成功
godbg> disass 0x478120 -n 1
0x478120:	e9 bb c8 ff ff	jmpq 0xffffffffffffc8c4
godbg> breakpoints
no breakpoints
godbg> exit
tracee is run by tracer, kill it
```

这段对比很直观：

- 添加断点前，`0x478120` 处是一条 5 字节的 `jmp` 指令，首字节 `e9`；
- 添加断点后首字节变成 `cc`，反汇编成 `int3`；
- `clearall` 之后，`e9` 回来了，指令恢复成完整的 `jmpq`。反汇编读的是目标进程当前内存，所以这说明 `ClearAll` 确实把原始字节写回去了，而不只是删了断点表里的一行；
- 如果只检查 `breakpoints`，是看不到这一层的。

会话退出时仍然走 6.4 节注册的清理逻辑，exec 启动的 tracee 被 kill，终端上会看到 `tracee is run by tracer, kill it`。

### 更多相关内容

**`clear` 与 `clearall` 的分工。** 两者共用 `RestoreInstruction`：`clear` 先按编号查到断点，再按地址还原；`clearall` 跳过编号查找，直接遍历断点表。一个面向精确删除，一个面向批量清理，底层动作完全相同。

**清空断点与退出前清理。** 本节实现的是用户主动清空。调试器异常退出时，目标进程内存里的 `0xCC` 不会自动消失，所以 6.10 节会在退出前再调用一次 `clearall`，把残留断点还原掉。两者用的是同一个 `ClearAll`，区别只在触发时机。

**停在断点处的线程。** 和 6.8 节一样，本节没有回退线程 PC。`clearall` 影响的范围更大，6.20.5 节实现多线程断点时会统一处理：先找出停在断点处的线程，还原指令后再把它们的 PC 减一。

**GDB 与 Delve。** GDB 的 `delete` 不带参数时删除全部断点，Delve 的 `clearall` 语义与本节一致。它们同样会在删除时处理停在断点处的线程，godbgv2 把这部分放在 6.20.5 节。

### 本节小结

本节实现了 `clearall` 命令，一条命令清空全部断点。它补上了断点管理中批量清理这一环，和 6.8 节的 `clear` 一起，单个删除与批量清空都有了入口。

到这里，断点的添加、查看、移除、清空都已经完成。下一节先讨论调试器退出前为什么必须清理断点，再往后实现 `step` 和 `continue`，让程序真正运行到断点处停下来。

### 参考文献

1. ptrace(2) - Linux manual page, https://man7.org/linux/man-pages/man2/ptrace.2.html
2. INT3/INT n - Intel 64 and IA-32 Architectures Software Developer's Manual, https://www.felixcloutier.com/x86/intn:into:int3:int1
3. GDB - Breakpoints, Watchpoints, and Catchpoints, https://sourceware.org/gdb/current/onlinedocs/gdb.html/Breakpoints.html
4. Delve - breakpoints and clear commands, https://github.com/go-delve/delve/tree/master/Documentation/cli
