## Breakpoint - part2: 添加断点+执行到断点

前一小节从原理上梳理了断点管理的层次：用户视角的**逻辑断点**、指令地址上的**物理断点**，以及同一地址叠加多个逻辑断点时用来记账的 `Breaklet`。这一节开始落地：`break` 如何把一行输入变成一个真正的 `0xCC` 补丁；`continue` 又如何让进程跑到断点、停下来，并在下一次 `continue` 时正确地越过它继续跑。

先把范围讲清楚。godbgv2 是**单进程、all-stop** 的调试器：一次只跟踪一个 tracee（没有进程组，也就没有「断点向新进程传播」这回事），任一时刻要么全部线程都在跑、要么全部线程都被挂起。软件断点的补丁机制、多线程 `continue` 与挂起策略在第 6 章已经讲过（见 [6.18.4 线程执行控制 continue](../../6-develop-inst-debugger/18-multithread/4-continue.md)），本节关注符号级调试带来的增量：**位置描述（locspec）**、**命名断点**、**断点条件**，以及符号化地展示「停在源码哪一行」。

### 实现目标: 添加+执行到断点

`break` 的完整形态：

```
break [--name|-n name] <locspec> [if <condition>]
```

`--name|-n name` 给断点起名（断点多了以后，「断点 3」远不如一个有意义的名字好用）；`<locspec>` 是位置描述，函数名、`file:line`、`*addr`、`+N`/`-N`、`/regexp/` 都支持，解析见 [9.2.19](./19-how_locspec_works.md)；`if <condition>` 在创建时带上激活条件，条件的判定在 [9.2.23](./23-debug_breakpoint_part3.md) 展开。

本节要打通这条链路：

1. 命令层把 `name`、`locspec`、`condition` 拆开，一次 RPC 交给服务端；
2. 服务端校验名字，把 locspec 解析成**一组**地址，每个地址建一条逻辑断点；
3. 逻辑断点落到物理层：保存原指令首字节、写入 `0xCC`；
4. `continue` 恢复全部线程；命中断点后符号化地展示位置，再次 `continue` 时先越过断点再继续。

能力边界一开始就摆出来（口径与 godbgv2 仓库的 `docs/FEATURE-MATRIX.md` §2/§3 一致）：

| 能力 | godbgv2 | 说明 |
|---|---|---|
| 命名断点 | ✅ | `-n/--name`；纯数字与重名被拒绝 |
| 多地址 locspec | ✅ | `/re/` 命中多个函数时，每个地址一条逻辑断点 |
| 条件断点 | ✅ | 条件存在逻辑断点上，**判定在命令层**（9.2.23） |
| 断点传播 | ❌ | 单进程；`int3` 是进程内存补丁，天然对所有线程生效 |
| suspended 断点 | ❌ | locspec 解析失败即失败，不保留「待激活」断点 |
| follow-exec | ❌ | 不做多进程跟踪 |
| `on <bp> <cmd>` | ❌ | 命中后自动执行命令未实现 |
| `next` 隐式断点 | 🅿️ | `next` 目前是桩（9.2.28） |

ps：9.2.22～9.2.26 的分工是：本节 `break` 与 `continue`；9.2.23 条件断点；9.2.24 `breakpoints`/`clear`/`clearall`/`toggle`；9.2.25 `trace` 与 9.2.26 `watch` 两类特殊断点。

### 代码实现: `breakpoint`

#### 命令层：把一行输入拆成三件事

**file：cmd/debug/break.go**

```go
	RunE: func(cmd *cobra.Command, args []string) error {
		name, err := cmd.Flags().GetString("name")
		if err != nil {
			return err
		}

		// 解析 "locspec [if <condition>]"：cond 为 if 之后的全部内容
		loc := args[0]
		cond := ""
		if len(args) > 1 {
			if args[1] != "if" {
				return errors.New("usage: break [--name|-n name] <locspec> [if <condition>]")
			}
			cond = strings.Join(args[2:], " ")
		}

		// 纯指令地址：走第6章的按地址添加路径（保持输出兼容）。
		// 若指定了名称或条件，转入 locspec 路径（*addr 形式）统一处理。
		if addr, err := parseAddress(loc); err == nil && name == "" && cond == "" {
			bp, err := Client.AddBreakpoint(addr)
			...
			fmt.Printf("breakpoint %d added at %#x\n", bp.ID, bp.Addr)
			return nil
		}

		spec := loc
		if addr, err := parseAddress(loc); err == nil {
			spec = fmt.Sprintf("*%#x", addr)
		}

		bps, err := Client.CreateBreakpoint(spec, cond, name)
		... // 逐条打印 id、地址、源码位置、名字、条件
	},
```

三个细节：

1. **条件的解析只认 `if`**。cobra 把 `break main.go:16 if i == 3` 拆成 `args = ["main.go:16", "if", "i", "==", "3"]`，所以 `args[1]` 必须是 `if`，其余 join 成表达式原文。代价是 `break main.go:16 i==3` 会被当成用法错误，而不是去「猜」用户意图。
2. **纯地址走老路径**。`parseAddress` 只是 `strconv.ParseUint(locStr, 0, 64)`；`break 0x4b3940` 命中它就直接 `Client.AddBreakpoint(addr)`，输出保持 `breakpoint N added at 0x...`，不带源码位置。
3. **带 `-n` 或 `if` 时地址也绕到 locspec 路径**：`break -n entry 0x4b3940` 会先格式化成 `*0x4b3940`，再和函数名、`file:line` 一样走 `CreateBreakpoint`。因为名字和条件挂在**逻辑断点**上，只收地址的 `AddBreakpoint` 表达不了。

#### RPC：三参数的单入口

**file：pkg/service/api/client.go**

```go
	// CreateBreakpoint 按位置描述（locspec）创建断点；cond 为激活条件
	// （ch9.2.23 起生效），name 为断点名称（可空，ch9.2.22）。
	// locspec 可解析出多个地址时返回多条。
	CreateBreakpoint(loc, cond, name string) ([]Breakpoint, error)
```

**file：pkg/service/rpc2/client.go**、**server.go** 只是 `net/rpc` 的包装，服务端一行转发：

```go
// client
func (c *Client) CreateBreakpoint(loc, cond, name string) ([]api.Breakpoint, error) {
	var reply CreateBreakpointReply
	err := c.c.Call("Debugger.CreateBreakpoint", &CreateBreakpointArgs{Loc: loc, Cond: cond, Name: name}, &reply)
	return reply.Bps, err
}

// server
func (s *serverImpl) CreateBreakpoint(args *CreateBreakpointArgs, reply *CreateBreakpointReply) error {
	bps, err := s.dbg.CreateBreakpoint(args.Loc, args.Cond, args.Name)
	reply.Bps = bps
	return err
}
```

`CreateBreakpointArgs` 就是 `{Loc, Cond, Name}` 三个 `string`，`CreateBreakpointReply` 是 `{Bps []api.Breakpoint}`——三个字符串进去、一个切片出来，没有「创建模板」结构体。这一点值得强调，因为它是「服务端解析 locspec」的直接后果：命令层只转发字符串，不必先在客户端把 locspec 变成一组地址再逐个下发。

#### 服务层：校验名字、解析位置、逐地址建断点

`Debugger` 的转发只有一行（`d.t.CreateBreakpointByLoc(loc, cond, name)`），真正的活在 `proc` 与 `target` 两层：

**file：pkg/proc/location.go**

```go
func (t *Target) CreateBreakpointByLoc(loc, cond, name string) ([]*Breakpoint, error) {
	if err := t.validateBreakpointName(name); err != nil {
		return nil, err
	}

	addrs, err := t.FindLocation(loc)
	if err != nil {
		return nil, err
	}

	// 命名断点只能对应一个位置：多个位置共用一名会使"按名引用"
	// 产生歧义，直接拒绝。
	if name != "" && len(addrs) > 1 {
		return nil, fmt.Errorf("breakpoint name %q cannot be used for %d locations", name, len(addrs))
	}

	bps := []*Breakpoint{}
	for _, addr := range addrs {
		bp, err := t.createBreakpoint(addr, loc, UserBreakpoint)
		if err != nil {
			// 部分成功：回滚已创建的断点
			for _, created := range bps {
				_, _ = t.ClearBreakpoint(created.ID)
			}
			return nil, err
		}
		bp.Name = name
		bp.Cond = cond
		bps = append(bps, bp)
	}
	return bps, nil
}
```

名字校验在 `validateBreakpointName`：空名字合法；纯数字拒绝（`isAllDigits`）；与其他断点重名拒绝。`CreateBreakpointByLoc` 另外拒绝「命名断点对应多个地址」。这些规则各有理由：纯数字名字和断点编号长得一样，`clear`/`toggle` 按编号办事时会分不清；重名会让「按名引用」失去意义；命名断点若对应多个地址，同一个名字指哪一条没有答案。实际效果（真实输出，cobra 随后打印的用法提示略）：

```
godbg> break -n 123 main.main
Error: breakpoint name "123" cannot be all digits

godbg> break -n mainbp main.main
godbg> break -n mainbp main.go:16
Error: breakpoint with name "mainbp" already exists

godbg> break -n dup /main./
Error: breakpoint name "dup" cannot be used for 3 locations
```

`FindLocation` 把 locspec 变成地址列表，五种写法对应五条分支：`*addr` 直接返回、`/re/` 遍历函数表返回**全部**匹配函数的入口、`file:line` 走行号表反向查询、`+N`/`-N` 换算成相邻行、其余按函数名查入口。所以「一个 locspec 对应多条逻辑断点」只发生在正则分支：

```
godbg> break /main./
breakpoint 1 added at 0x440980 (.../src/runtime/proc.go:205)
breakpoint 2 added at 0x46d1e0 (.../src/runtime/proc.go:172)
breakpoint 3 added at 0x4b3940 (.../examples/debuggee/loop/main.go:13)
```

#### 逻辑断点：多地址、同址复用与重叠

`createBreakpoint` 是「一个地址一条逻辑断点」的地方，要处理三种情况（**file：pkg/proc/breakpoints.go**）：

```go
func (t *Target) createBreakpoint(addr uint64, loc string, kind BreakpointKind) (*Breakpoint, error) {
	// 该地址已有物理断点：按重叠策略处理
	if _, ok := t.dbp.Breakpoints[uintptr(addr)]; ok {
		if canOverlap(kind) {
			... // 步进类断点：只追加 Breaklet，复用物理断点
		}
		// 用户断点：复用既有逻辑断点
		if bp := t.breakpointByAddr(addr); bp != nil {
			return bp, nil
		}
	}
	// 物理断点已被还原、逻辑断点仍在（continue 越过断点的客户端流程）
	if bp := t.breakpointByAddr(addr); bp != nil {
		if _, err := t.dbp.AddBreakpoint(uintptr(addr)); err != nil {
			return nil, err
		}
		return bp, nil
	}
	// 创建物理断点（int3 补丁），再登记逻辑记录与 Breaklet
	phys, err := t.dbp.AddBreakpoint(uintptr(addr))
	...
	bp := &Breakpoint{ID: phys.ID, Loc: loc, Addr: addr, File: file, Line: line, Kind: kind, Enabled: true}
	t.bps = append(t.bps, bp)
	t.breaklets[addr] = append(t.breaklets[addr], &Breaklet{Kind: kind, LogicalID: bp.ID})
	return bp, nil
}
```

三条分支对应三种现实：同一地址重复 `break` 直接复用既有逻辑断点（编号不变，`break main.main` 连按两次只有一条）；步进类断点允许与用户断点共存，物理指令只补一次、逻辑记录各留一条；物理断点被还原而逻辑断点还在，是 `continue` 越过断点留下的中间状态，必须重建物理断点并复用原逻辑断点，否则会出现「编号不断递增的重复断点」。

> ps：同址复用有一个容易踩的副作用。`CreateBreakpointByLoc` 在 `createBreakpoint` 返回之后才写 `bp.Name = name`、`bp.Cond = cond`，而复用返回的是**已有**逻辑断点，这两个字段会被本次请求的值覆盖。实测：先 `break -n b1 main.main`，再 `break main.main`，编号仍是 1，但名字被清空。要改条件请用 9.2.23 的 `condition`，不要靠再 `break` 一次。

#### 物理断点：写 `0xCC` 与保存 `Orig`

到 `target` 层，断点收敛成一个朴素的 `Breakpoint`（`ID`/`Addr`/`Pos`/`Orig`/`Enabled`）：

**file：pkg/target/breakpoint.go**

```go
func (p *DebuggedProcess) AddBreakpoint(addr uintptr) (*api.Breakpoint, error) {
	// 该地址处已有断点，直接返回
	if bp, ok := p.Breakpoints[addr]; ok {
		return toAPIBreakpoint(bp), nil
	}
	err = p.ExecPtrace(func() error {
		pid := p.Process.Pid
		// 读取并保存断点处的原始指令首字节
		orig := [1]byte{}
		n, err = syscall.PtracePeekText(pid, addr, orig[:])
		...
		breakpoint = newBreakPoint(addr, orig[0], "-")
		p.Breakpoints[addr] = breakpoint
		p.BreakpointsByID[breakpoint.ID] = breakpoint
		// 将断点处的指令首字节替换为 int3
		n, err = syscall.PtracePokeText(pid, addr, []byte{0xCC})
		...
	})
	...
}
```

物理层只做三件事：`PtracePeekText` 读出并保存首字节（`Orig`）、`PtracePokeText` 写入 `0xCC`、同时维护 `Breakpoints`（按地址）与 `BreakpointsByID`（按编号）两张索引；编号由包级 `bpSeqNo` 单调递增分配。

这里有个必须讲清的编号关系：**逻辑断点的 `ID` 初次创建时取自物理断点的 `ID`**（`ID: phys.ID`），但物理断点在「越过断点」流程里会被还原并重建，重建后编号会变，逻辑编号不变。所以 `ClearBreakpoint` 不能拿逻辑编号查物理断点，必须按地址查——源码注释写得很明确：物理断点被 continue 越过断点后还原、重建时编号会更新，而逻辑编号保持不变。

「线程是否停在断点处」的判定也在物理层，判据是 `PC-1`：

```go
		// 检查 PC-1 位置是否有断点
		pc := regs.PC()
		if bp, exists := p.Breakpoints[uintptr(pc-1)]; exists {
			threadStoppedAtBP[tid] = bp.Addr
		}
```

原因很直接：`0xCC` 被执行后，内核报告的 PC 已经指向**下一条**指令，断点地址是 `PC-1`。这个「+1」在本节后半程反复出现——判断停在哪条断点、展示源码位置、回退 PC，用的都是它。

### 代码实现: continue

#### 命令层：先越过断点，再恢复执行

`continue` 的入口先调 `Client.ThreadsStoppedAtBreakpoint()`：有线程停在断点处就先 `passOverBreakpoints` 越过，再 `continueRun` 恢复执行，最后打印 `continue ok`。越过断点的逻辑在 `passOverBreakpoints`（**file：cmd/debug/continue.go**）：

```go
func passOverBreakpoints(bpStoppedThreads map[int]uint64) error {
	bpCleared := make(map[uint64]struct{})
	for tid, bpAddr := range bpStoppedThreads {
		fmt.Printf("thread %d stopped at breakpoint %#x\n", tid, bpAddr)

		// 回退该线程的 PC
		regs, err := Client.ReadRegs(tid)
		...
		regs.SetPC(regs.PC() - 1)
		if err = Client.WriteRegs(tid, regs); err != nil { ... }

		// 断点只需还原一次（多线程可能停在同一个断点）
		if _, cleared := bpCleared[bpAddr]; !cleared {
			if err := Client.RestoreInstruction(bpAddr); err != nil && err != api.ErrBreakpointNotExisted {
				return fmt.Errorf("clear breakpoint at %#x error: %v", bpAddr, err)
			}
			bpCleared[bpAddr] = struct{}{}
		}

		// 单步越过断点处指令
		if err := Client.Step(tid); err != nil { ... }

		// 恢复断点
		if _, err := Client.AddBreakpoint(bpAddr); err != nil {
			fmt.Fprintf(os.Stderr, "warning: failed to restore breakpoint at %#x: %v\n", bpAddr, err)
		} else {
			fmt.Printf("restored breakpoint at %#x\n", bpAddr)
		}
	}
	return nil
}
```

四个动作的顺序有讲究，而且**代码的实际顺序与注释措辞不同**（注释写「还原断点 → 回退 PC」，代码是先回退）：

1. **先回退 PC**（`regs.SetPC(regs.PC()-1)`）：不先回退，单步就会从断点指令的下一条开始，等于跳过一条指令；
2. **再还原指令**（`RestoreInstruction`）：把 `Orig` 写回去，让断点处恢复成一条正常指令；
3. **单步**（`Client.Step(tid)`）：`PTRACE_SINGLESTEP` 执行这一条指令；
4. **重新打补丁**（`Client.AddBreakpoint(bpAddr)`）：让后续命中继续有效。

回退 PC 必须早于还原指令，因为「哪些线程停在断点处」是按 `PC-1` 与 `Breakpoints` 索引匹配的，而 `RestoreInstruction` 会把该地址从索引里摘掉，之后再想找这些线程就找不到了。同一地址被多个线程命中时，`bpCleared` 保证只还原一次。另外 `RestoreInstruction` 可能返回 `api.ErrBreakpointNotExisted`（该地址的物理断点已被清理），这里显式容忍；`rpc2.Client` 的 `translateErr` 会把服务端的错误文本翻译回这个哨兵，否则跨 RPC 的同一性判断不成立。

真实运行输出（两个断点、两次 `continue`）：

```
godbg> break main.main
breakpoint 1 added at 0x4b3940 (.../examples/debuggee/loop/main.go:13)
godbg> break main.go:16
breakpoint 2 added at 0x4b3971 (.../examples/debuggee/loop/main.go:16)
godbg> continue
thread 2012209 status: stopped: trace/breakpoint trap
> .../examples/debuggee/loop/main.go:13 (pc: 0x4b3941)
stop all threads now
continue ok
godbg> continue
thread 2012209 stopped at breakpoint 0x4b3940
restored breakpoint at 0x4b3940
thread 2012209 status: stopped: trace/breakpoint trap
> .../examples/debuggee/loop/main.go:16 (pc: 0x4b3972)
stop all threads now
continue ok
```

注意 `pc: 0x4b3941` 与 `pc: 0x4b3972`：停下来时 PC 都是断点地址 +1，而展示的源码行来自 `printLocation`（**file：cmd/debug/location.go**）——先用 `PC` 查 `PCToLine`、失败再用 `PC-1` 查，成功则打印 `> file:line (pc: ...)`。

#### 目标层：All-stop 与内部事件判别

命令层的 `Client.Continue()` 落到 `DebuggedProcess.Continue`，骨架是「全部放行 → 等待任意线程停止 → 挂起其余线程」（**file：pkg/target/continue.go**）：

```go
func (p *DebuggedProcess) Continue() (*api.StopInfo, error) {
	// 恢复全部线程执行
	for _, thread := range p.Threads {
		err := p.ExecPtrace(func() error {
			err := syscall.PtraceCont(thread.Tid, 0)
			if err == syscall.ESRCH { return nil } // 线程已退出
			return err
		})
		...
	}
	// 等待任意线程停止
	for {
		wpid, status, err := p.waitAny(syscall.WSTOPPED)
		...
		if status.Stopped() && status.TrapCause() == syscall.PTRACE_EVENT_CLONE {
			... // 内部事件：跟踪新线程后继续等待
			continue
		}
		...
	}
}
```

`waitAny` 用 `wait4(-1, ..., WNOHANG|WALL)` 轮询，返回的可能是**真正的停止**，也可能是内核抛给调试器的**内部事件**。内部事件不能在用户面前「停住」，必须就地消费：

- `PTRACE_EVENT_CLONE`：新线程创建。顺序是「读事件消息拿到新 tid → 加入线程表 → **先恢复克隆者** → 非阻塞消费新线程的初始 `SIGSTOP` → 设置 ptrace 选项 → 恢复新线程」。注释记录了两个排查结论：先恢复克隆者，是因为新线程的初始停止在克隆者恢复后才进入可等待状态；消费初始停止用 `waitFastNoBlock` 而非阻塞 `wait`，是因为停止事件与 `CLONE` 事件到达顺序不固定，阻塞等待会把整个 `continue` 挂死。
- `PTRACE_EVENT_EXEC` 表示 `exec` 成功，继续放行；`PTRACE_EVENT_FORK`/`VFORK` 则按 `follow-fork-mode=parent` 挂起其余线程后把事件报告给用户，子进程虽被内核跟踪，但调试器暂不管理它。

真正麻烦的是**信号造成的停止**。Go 运行时会在运行期间投递 `SIGURG`（异步抢占），调试器自己的 `suspendOtherThreads` 又会用 `tgkill(SIGSTOP)` 挂起线程；如果把这些都当成「用户可见的停止」，`continue` 就会莫名其妙地停在与断点无关的位置。判别办法是读 siginfo：

```go
		sig := status.StopSignal()
		forward, discard := false, false
		switch sig {
		case syscall.SIGURG:
			forward = true // 转发给运行时处理
		case syscall.SIGSTOP, syscall.SIGCONT:
			sender, code := p.stopSiginfo(wpid)
			if (sender == int32(os.Getpid()) && code == siTKill) || sender == 0 {
				discard = true // 调试器自身挂起 / 内核发起：丢弃
			}
		}
		if forward || discard { ... continue }
```

规则收成一张表：

| 停止信号 | `siginfo` 特征 | 处理 | 理由 |
|---|---|---|---|
| `SIGURG` | 任意 | **转发**（`PtraceCont(wpid, sig)`） | Go 运行时异步抢占，交给运行时自己处理 |
| `SIGSTOP`/`SIGCONT` | `si_pid == getpid()` 且 `si_code == SI_TKILL` | **丢弃** | `suspendOtherThreads` 用 `tgkill` 挂起，投递者是调试器自己 |
| `SIGSTOP`/`SIGCONT` | `si_pid == 0` | **丢弃** | 内核发起，例如 clone 后新线程的初始停止 |
| 其余 | — | **上抛** | 外部投递的停止（如另一个终端 `kill -STOP`），是真实事件 |

`siginfo` 用 `PTRACE_GETSIGINFO` 读原始结构（**file：pkg/target/ptrace_linux.go** 的 `stopSiginfo`），按 linux/amd64 的 `siginfo_t` 布局取 `si_code`（偏移 8）与 `_kill._pid`（偏移 16）；读取失败返回 `(-1, -1)`，按「外部信号」处理——宁可上抛，不可吞事件。挂起其余线程则用 `tgkill(SIGSTOP)` 加短轮询（**file：pkg/target/suspend.go**），而不是 `PTRACE_SINGLESTEP` 或阻塞 `wait`：阻塞在 futex 里的线程单步陷阱可能迟迟不来；已经停止的线程也不会再产生停止事件。

#### 停止之后：命中计数与自动续跑

停下来的那一刻，服务端做一次记账：`Debugger.Continue` 拿到 `StopInfo` 后用 `ThreadStoppedAtBreakpoint` 判断停止线程是否停在逻辑断点上，是则 `NoteBreakpointHit` 累加命中计数；`breakpoints` 里的 `hit:N` 即来自这里。

命令层则在一个循环里决定「这次停止要不要给用户看」（**file：cmd/debug/continue.go**）：

```go
func continueRun() error {
	for {
		stop, err := Client.Continue()
		if err != nil {
			return fmt.Errorf("continue error: %v", err)
		}
		// 自动恢复执行的断点（条件不满足 / 跟踪点，见 9.2.23、9.2.25）
		resume, err := checkAutoResume(stop)
		if err != nil { return err }
		if resume { continue }

		fmt.Printf("thread %d status: %s\n", stop.PID, stop.Reason)
		printLocation(stop.PID)
		fmt.Println("stop all threads now")
		return nil
	}
}
```

`checkAutoResume` 先用 `findBreakpointAt(stop.PID)` 找到停在哪条逻辑断点（按 `PC-1` 匹配 `ListBreakpoints`），然后：断点带条件就调 `Client.EvalCondition(bp.Cond)`，结果为假则 `passOverStop()` 越过断点、返回 `true` 让循环继续跑；断点是跟踪点（`bp.Tracepoint`）则打印一行命中信息后同样越过、继续。真实输出：

```
breakpoint 1 condition "1 == 2" not satisfied, auto continue
```

> ps：条件判定放在**命令层**而不是后端，是架构上的有意选择。后端（`debugger`/`proc`）只提供 `EvalCondition` 这一个原子 RPC，自己不打印、不决定「要不要继续」；「条件不满足就自动续跑」是前端的策略。代价很直接：换一个前端（比如 headless 模式的另一个客户端）就得自己实现同样的循环，否则拿到的是原始停止事件。至于在 target 层用 breaklet 回调判定这条路——godbgv2 的 `Breaklet` 根本没有回调字段，只有 `Kind`/`LogicalID`/`Cond` 三个字段。

### 执行测试

先准备固件与二进制（固定工具链构建，地址可复现）：

```bash
$ git checkout ch9.2.22
$ make build
$ make fixtures
```

本节 smoke 脚本 `testdata/script/ch9.2.22.txt` 很短，但覆盖了「按位置描述加断点 → 执行到断点 → 展示源码位置」的全链路：

```
break -n mainbp main.main
=breakpoint [0-9]+ added at 0x4b3940 \(.*main\.go:13\), name "mainbp"
breakpoints
=breakpoint\[1\] addr:0x4b3940, loc:.*main\.go:13, name:mainbp
continue
=thread [0-9]+ status: stopped: trace/breakpoint trap
=> .*main\.go:13 \(pc: 0x4b3941\)
```

```bash
$ ./scripts/smoke.sh ch9.2.22
smoke: running testdata/script/ch9.2.22.txt
smoke: all passed
```

交互式跑一遍，观察命名断点与命中计数：

```bash
$ ./godbg exec _fixtures/loop
process 2012209 launched, stopped by SIGTRAP
godbg> break -n mainbp main.main
breakpoint 1 added at 0x4b3940 (.../examples/debuggee/loop/main.go:13), name "mainbp"
godbg> breakpoints
breakpoint[1] addr:0x4b3940, loc:.../examples/debuggee/loop/main.go:13, name:mainbp
godbg> continue
thread 2012209 status: stopped: trace/breakpoint trap
> .../examples/debuggee/loop/main.go:13 (pc: 0x4b3941)
godbg> breakpoints
breakpoint[1] addr:0x4b3940, loc:.../examples/debuggee/loop/main.go:13, name:mainbp, hit:1
```

再验证条件断点与自动续跑（条件本身的完整行为见 9.2.23）：

```bash
godbg> break main.go:16 if 1 == 2
breakpoint 2 added at 0x4b3971 (.../examples/debuggee/loop/main.go:16), cond "1 == 2"
godbg> break main.go:17
breakpoint 3 added at 0x4b3a47 (.../examples/debuggee/loop/main.go:17)
godbg> continue
pid: 2016233, loop: 0
breakpoint 2 condition "1 == 2" not satisfied, auto continue
thread 2016233 stopped at breakpoint 0x4b3971
restored breakpoint at 0x4b3971
thread 2016233 status: stopped: trace/breakpoint trap
```

上例中调试目标自身的 stdout 与调试器输出交错，行序以终端为准；自动续跑之后停在循环体下一行（`main.go:17`）的断点上。

> ps：以上都是真实运行输出，只把仓库绝对路径缩写成 `...`。线程 tid 每次运行都变；代码地址由固定工具链（`GOTOOLCHAIN=go1.24.13`）与 `-gcflags "all=-N -l"` 构建决定，`0x4b3940`（`main.main`）与 `0x4b3971`（`main.go:16`）据此可复现。

### 本节小结

本节把 `break` 与 `continue` 两条命令从命令层一路穿到 ptrace：

- `break` 在命令层只做三件事——拆出 `name`/`locspec`/`cond`、判断纯地址捷径、发一条 `CreateBreakpoint(loc, cond, name)`。服务端 `CreateBreakpointByLoc` 校验名字、用 `FindLocation` 得到一组地址、每个地址建一条逻辑断点（命名断点多地址直接拒绝，部分失败回滚）；`createBreakpoint` 处理同址复用与重叠；`AddBreakpoint` 保存 `Orig`、写 `0xCC`。
- `continue` 在命令层先处理停在断点处的线程（回退 PC → 还原 → 单步 → 重打补丁），再进 `continueRun` 循环；目标层 `Continue` 恢复全部线程、把 `CLONE`/`EXEC`/`FORK` 当内部事件消费、用 `siginfo` 把「运行时的 SIGURG」「调试器自己投递的 SIGSTOP」「内核发起的初始停止」与「真实停止事件」区分开，最后 `suspendOtherThreads` 完成 all-stop。

对照 9.2.21 的模型，本节落地了其中两层：`proc.Breakpoint`（逻辑，带名字/条件/命中计数）与 `target.Breakpoint`（物理，带 `Orig`）；`Breaklet` 目前只用于步进类断点的重叠记账，没有回调、也没有条件字段的语义。

#### 对照：delve 做过而 godbgv2 不做的部分

把本节涉及的能力与另一套实现并列一下，避免读者按 delve 的心智模型理解 godbgv2：

| 方面 | delve | godbgv2 |
|---|---|---|
| 逻辑断点归属 | 进程组 `TargetGroup`，跨进程共享 | 单进程 `Target.bps` |
| 新建断点入口 | `CreateBreakpoint` + `CreateBreakpointWithExpr` 双入口 | `CreateBreakpoint(loc, cond, name)` 单入口 |
| 断点传播 | `addTarget` 回放逻辑断点、`follow-exec` 过滤 | 无，也不需要 |
| suspended 断点 | 支持 | 不支持 |
| `continue` 返回 | `Command` + 状态 channel，流式 | 一次 `Continue` 返回一个 `StopInfo` |
| 条件判定位置 | target 层 breaklet 回调 | 命令层 `EvalCondition` + 自动续跑 |

本书早期版本用 tinydbg（delve 的教学裁剪版）讲解这一组小节；godbgv2 是净室实现，两者没有代码派生关系，这张表只用来标定边界。下一节（9.2.23）把「条件」这一列展开：条件的存储、`condition` 命令、`EvalCondition` 的能力边界，以及命中计数为什么包含「被条件过滤掉」的那次命中。
