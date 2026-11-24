## stepout：执行到当前函数返回

`bt` 能把调用栈打出来，`continue` 能跑到下一个断点，但还缺一个常用动作：停在 `main.compute()` 里，想回到调用它的 `main.main` 那条语句。`stepout` 把这个动作自动化——它用调试信息算出当前帧的返回地址（return address，RA），在 RA 上设一个临时断点，再让程序继续跑。

### 实现目标

`godbg> stepout`（别名 `so`、`finish`）执行到当前函数返回，停在调用者的调用点，并按 `continue` 的格式报告停止：

- 找到"当前函数返回之后会落在哪"。不能靠源码行号猜（同一行可能对应多条语句），也不能靠扫描栈找"看起来像地址"的值；答案在 `.debug_frame` 的 CFI 规则里。
- 让程序停在那个地址。不能单步执行完整个函数体：函数里可能有循环、阻塞系统调用，指令数不可控。做法是临时断点加 `continue`。
- 停住之后收拾现场。临时断点要撤掉，PC 要回退到 RA，否则下一条命令看到的是断点地址加 1，源码位置也会偏。

范围先说清楚：`stepout` 只作用于当前事件线程的当前帧。`frame` 是 9.2.34 留下的桩（`cmd/debug/frame.go` 只打印 `TODO(ch9.2.34)`），`up`/`down` 没有对应命令，因此不存在"先切到外层帧再 stepout"。

还有一个已知问题：`finish` 这个别名被同名桩遮蔽。`cmd/debug/finish.go` 先注册了一个 `Use: "finish"` 的桩，只打印 `TODO(ch9.2.39)`；cobra 匹配命令名与别名是单遍的，先命中谁就是谁，所以 `finish` 走不到 `stepout`。`so` 不受影响。这是真实实现状态，`docs/FEATURE-MATRIX.md` §11① 记录了它。

### 基础知识

#### 返回地址在 CFA-8

go 在 amd64 上使用 ABIInternal（go1.17+）：`CALL` 指令把返回地址压栈，所以函数**入口**处 `rsp` 指向 RA、`CFA = rsp+8`；序言（`push %rbp; mov %rsp,%rbp; sub $N,%rsp`）会移动 `rsp`，但 CFI 规则随 PC 调整，CFA 始终等于"调用者在调用点处的 `rsp`"。于是无论当前执行到函数里的哪一条指令，返回地址都在 `CFA-8`。

这就是 `stepout` 和 `bt` 共用 CFA/CFI 逻辑的原因：`pkg/proc/backtrace.go` 的 `ReturnAddress()` 不自己读 `[rsp]`，而是调用 `Backtrace(1)` 拿到当前帧的 CFA。停在函数中间时，`rsp` 指向的是局部变量区，直接读栈顶只会读到临时数据。

#### 为什么是"临时断点 + continue"

把 RA 当成目标地址后，停下来的手段有三种，只有一种可用。单步执行直到 `RET`：函数体里可能有循环，单步要执行的指令数不可控，还可能被阻塞系统调用拖住。扫描栈猜返回地址：go 的栈布局与编译优化不保证一致的帧指针链，猜错就会在垃圾地址上设断点。在 RA 上下一个 `int3` 再 `continue`：CPU 自己把函数执行完，`RET` 之后取调用者的第一条指令之前，正好命中 RA 处的断点——函数已经返回、调用者的状态还没改变，这就是"执行到当前函数返回"的准确时刻。

#### 命中 `int3` 后 PC 要减 1

软件断点把目标地址处的指令首字节替换为 `0xCC`。命中时 CPU 执行的是 `int3`，原指令并没有执行；内核记录的 PC 是断点地址加 1。CFI 的一行规则覆盖一个地址区间，描述的是"走到该地址、尚未执行该地址那条指令"时的栈状态；既然原指令没执行，查询 CFI 就该用断点地址 `pc-1`，而不是 `pc`。

`effectivePC` 负责这个换算：`pc-1` 处有断点就返回 `pc-1`，否则原样返回。`Backtrace` 用它查 CFA，帧里仍保留真实 PC 供显示；`printLocation` 则先用真实 PC 查 `PCToLine`，失败后再用 `pc-1` 重试。

#### 步进类断点

临时断点是命令执行期间临时创建的，必须能和其他断点共存；godbgv2 用 `BreakpointKind` 位集区分来源：`UserBreakpoint`、`NextBreakpoint`、`StepBreakpoint`、`TracepointBreakpoint`、`WatchBreakpoint`。其中 `NextBreakpoint | StepBreakpoint` 组成 `steppingMask`，表示"命令执行期间隐式创建、允许与其他断点重叠"的步进类断点；`canOverlap` 用它判断。`SetStepBreakpoint` 复用 `StepBreakpoint` 这一位，`createBreakpoint` 发现地址上已有物理断点时，只追加一个 `Breaklet` 记录逻辑归属，物理 `int3` 仍然只有一份。

### 代码实现

链路（冒号后是文件行号）：

```text
godbg> stepout
 └─ cmd/debug/stepout.go:28                       命令层：Client.StepOut + 打印状态/位置
     └─ pkg/service/api/client.go:114 → pkg/service/debugger/debugger.go:540   契约 → 门面
         └─ pkg/proc/backtrace.go:121             Target.StepOut：越过断点 → 取 RA → 设临时断点 → continue
             ├─ pkg/proc/backtrace.go:151         passOverCurrentBreakpoint
             ├─ pkg/proc/backtrace.go:96          ReturnAddress → Backtrace(1)
             ├─ pkg/proc/backtrace.go:109         SetStepBreakpoint(ra)
             └─ pkg/target/breakpoint.go:96       ClearBreakpoint（含 PC 回退）
```

#### 1. 命令层

`cmd/debug/stepout.go:15` 定义命令：`Use` 是 `stepout`，`Aliases` 是 `[]string{"so", "finish"}`，`Long` 说明"在返回地址处设置步进类临时断点后 continue"的语义。`RunE` 与 `continue` 的输出对齐（`stepout.go:28`，节选）：

```go
	RunE: func(cmd *cobra.Command, args []string) error {
		stop, err := Client.StepOut()
		if err != nil {
			return err
		}
		fmt.Printf("thread %d status: %s\n", stop.PID, stop.Reason)
		printLocation(stop.PID)
		fmt.Println("stop all threads now")
		return nil
	},
```

`Client.StepOut()` 只返回停止信息（`api.StopInfo` 的 `PID`、`Reason`），没有额外的帧或位置；位置由 `printLocation` 用停止线程的 PC 现查（`cmd/debug/location.go:9`，先 `pc` 后 `pc-1`）。这与 9.2.22 中 `continue` 的展示逻辑是同一套。

#### 2. `finish` 为什么用不了

`cmd/debug/finish.go:9` 是一个尚未实现的桩：命令名 `Use: "finish"`，`Run` 里只有注释 `TODO(ch9.2.39): stepout——执行直到当前函数返回` 和一行 `fmt.Println("TODO(ch9.2.39): finish 尚未实现")`（`finish.go:17`）。

cobra v1.10.2 的 `Find` 在 `c.commands` 上单遍匹配，命令名与别名同条件、取首个命中；`c.commands` 的顺序由 `init()` 注册顺序决定，而 godbgv2 的 `init()` 按文件名排列——`finish.go` 排在 `stepout.go` 之前。所以 `finish` 命中桩，`stepout` 的 `finish` 别名永远不会被看到。修复方式只有两种：删除桩，或让桩的 `Run` 转调 `StepOut`；书稿按现状记录，不掩盖这个缺陷。

#### 3. 契约与门面

接口在 `pkg/service/api/client.go:113` 声明：

```go
	// StepOut 执行到当前函数返回（ch9.2.39）
	StepOut() (*StopInfo, error)
```

门面 `Debugger.StepOut`（`pkg/service/debugger/debugger.go:540`）只判空后转调 `d.t.StepOut()`，真正的编排在 `proc` 层。这种"命令层薄、编排在符号层"的分层与 `bt`、`continue` 一致。

#### 4. `Target.StepOut`：越过断点、取 RA、设临时断点、继续

函数主体（`pkg/proc/backtrace.go:121`，节选；收尾见下）：

```go
func (t *Target) StepOut() (*api.StopInfo, error) {
	if err := t.passOverCurrentBreakpoint(); err != nil {
		return nil, err
	}
	ra, err := t.ReturnAddress()
	if err != nil {
		return nil, err
	}
	bp, err := t.SetStepBreakpoint(ra)
	if err != nil {
		return nil, err
	}
	stop, err := t.dbp.Continue()
	if err != nil {
		return nil, err
	}
```

停住之后还有一段收尾：`ThreadStoppedAtBreakpoint()` 返回"线程 → 断点地址"的映射（`pkg/target/breakpoint.go:167`，内部按 `pc-1` 判断），只有当前线程停的正是 RA 时才调 `t.ClearBreakpoint(bp.ID)`；停在别处（用户断点、watchpoint、信号）时临时断点保留，命令只把这次停止报告给用户。

第一步 `passOverCurrentBreakpoint`（`backtrace.go:151`）处理"当前就停在某个断点上"的情况。断点命中时 `int3` 已经吃掉了断点处的原指令，直接继续会跳过它；正确的顺序是回退 PC、还原原指令、单步执行这一条、再把断点打回去（节选）：

```go
	if _, ok := t.dbp.Breakpoints[uintptr(pc-1)]; !ok {
		return nil
	}
	bpAddr := uintptr(pc - 1)
	regs.SetPC(pc - 1)
	if err := t.dbp.WriteRegister(tid, regs); err != nil {
		return err
	}
	if _, err := t.dbp.RestoreInstruction(bpAddr); err != nil {
		return err
	}
	if _, err := t.dbp.SingleStep(tid); err != nil {
		return err
	}
	if _, err := t.dbp.AddBreakpoint(bpAddr); err != nil {
		return err
	}
```

#### 5. `ReturnAddress` 与 `effectivePC`

`ReturnAddress`（`backtrace.go:96`）完全复用 `bt` 的逐帧逻辑，只是限制深度为 1：

```go
func (t *Target) ReturnAddress() (uint64, error) {
	frames, err := t.Backtrace(1)
	if err != nil {
		return 0, err
	}
	if len(frames) == 0 {
		return 0, fmt.Errorf("no frame")
	}
	return t.readUint(frames[0].CFA - 8)
}
```

`readUint` 在 `pkg/proc/variables.go:330`，通过目标层的 `ReadMemory` 读 8 字节小端值。`Backtrace` 内部查 CFI 时用 `effectivePC`（`backtrace.go:78`）：

```go
func (t *Target) effectivePC(pc uint64) uint64 {
	if _, ok := t.dbp.Breakpoints[uintptr(pc-1)]; ok {
		return pc - 1
	}
	return pc
}
```

为什么必须减 1：断点命中时原指令没执行，寄存器状态对应"断点地址"；而 CFI 行按"执行到某地址之前"的状态描述该地址。以 `main.compute` 的入口 `0x4b1da0`（`push %rbp`）为例，若按 `0x4b1da1` 查，规则已经是 `push` 之后的（CFA 比入口处高 8 字节）；按 `0x4b1da0` 查才对得上尚未执行 `push` 的寄存器状态。`Backtrace` 把 `effectivePC(pc)` 传给 `cfaForPCRSP`（`backtrace.go:55`），但 `Frame.PC` 仍保存真实 PC，显示不受影响。

#### 6. 清除临时断点：PC 回退发生在 target 层

`proc` 层的 `ClearBreakpoint`（`pkg/proc/breakpoints.go:157`）先摘除逻辑断点与 `Breaklet`；地址上已无其他重叠断点时，再转调目标层的 `ClearBreakpoint(phys.ID)`。PC 回退就在目标层（`pkg/target/breakpoint.go:96`）：

```go
	if err := p.rewindThreadsAtBreakpoint(bp.Addr); err != nil {
		return nil, err
	}
	if _, err := p.RestoreInstruction(bp.Addr); err != nil {
		return nil, err
	}
```

`rewindThreadsAtBreakpoint`（`pkg/target/breakpoint.go:117`）遍历停在该地址的线程，把 `PC-1` 写回寄存器。顺序不能反：必须**先**回退 PC，**再**还原指令——`RestoreInstruction` 会把断点从索引里摘掉，之后就找不到"停在断点处的线程"了。返回地址处的 `int3` 被命中时 PC 是 `RA+1`，回退后才回到 RA，因此最终打印的位置是调用点而不是调用点加 1。

#### 7. 一处实测到的时序冲突

`effectivePC` 的前提是"断点处指令还没执行"。但 `StepOut` 是**先** `passOverCurrentBreakpoint` 执行了那条指令，**再**调 `ReturnAddress()`；如果断点恰好落在函数入口，而首条指令又移动了 `rsp`（`main.compute` 的入口正是 `push %rbp`），`effectivePC` 仍回退到入口地址查 CFI，寄存器却已是 `push` 之后的状态：CFA 少算 8 字节，`CFA-8` 取到的是刚压栈的旧 `rbp`，不是返回地址。

实测：在 `main.compute` 入口（`main.go:31`，`0x4b1da0`）停下后直接 `stepout`，目标会跑完一轮循环、再次停在 `main.compute` 入口，而不是调用点。冒烟脚本在 `stepout` 之前先 `clear 1`，恰好绕开了这条路径。修复思路是越过断点时保存一份原始寄存器快照，或用 `pc-1` 配原始 `rsp` 查 CFI；本书按现状记录这个边角。

### 执行测试

测试对象是 `examples/debuggee/vars`：`main.main` 在 `main.go:25` 调用 `compute()`，`compute` 的函数体在 `main.go:32`（`x := arr[0] + pt.X`）。先停在函数体里，再 `stepout` 回调用点。路径前缀统一省略为 `…/`：

```bash
$ ./godbg exec _fixtures/vars
process 2172813 launched, stopped by SIGTRAP
godbg> break main.go:32
breakpoint 1 added at 0x4b1db1 (…/examples/debuggee/vars/main.go:32)
godbg> continue
thread 2172813 status: stopped: trace/breakpoint trap
> …/examples/debuggee/vars/main.go:32 (pc: 0x4b1db2)
stop all threads now
continue ok
godbg> bt
0: main.compute() …/examples/debuggee/vars/main.go:32 (pc: 0x4b1db2)
1: main.main() …/examples/debuggee/vars/main.go:25 (pc: 0x4b1b85)
2: runtime.main() …/src/runtime/proc.go:293 (pc: 0x440827)
3: runtime.goexit() …/src/runtime/asm_amd64.s:1701 (pc: 0x4768a1)
backtrace: 4 frame(s)
godbg> finish
TODO(ch9.2.39): finish 尚未实现
godbg> so
thread 2172813 status: stopped: trace/breakpoint trap
> …/examples/debuggee/vars/main.go:25 (pc: 0x4b1b85)
stop all threads now
godbg> bt
0: main.main() …/examples/debuggee/vars/main.go:25 (pc: 0x4b1b85)
1: runtime.main() …/src/runtime/proc.go:293 (pc: 0x440827)
2: runtime.goexit() …/src/runtime/asm_amd64.s:1701 (pc: 0x4768a1)
backtrace: 3 frame(s)
```

几个可核对的事实：

- `bt` 已经给出答案：frame 0 是 `main.compute`，frame 1 的 PC `0x4b1b85` 就是 `call main.compute`（`0x4b1b80`，5 字节）之后的那条指令，即 RA。`so` 之后停在同一个地址。
- 临时断点命中时 PC 是 `0x4b1b86`（RA+1，`int3` 已执行）；`ClearBreakpoint` 的 `rewindThreadsAtBreakpoint` 把它回退到 `0x4b1b85`，所以输出是 `(pc: 0x4b1b85)`，`printLocation` 解析到 `main.go:25`。
- `finish` 打印桩的 TODO，`so` 才真正执行；这就是别名遮蔽在用户侧的样子。
- 回到调用者后 `bt` 只剩 3 帧，`main.compute` 已从栈上消失，说明"返回"确实发生了。

本序列已固化为冒烟脚本：`bash scripts/smoke.sh ch9.2.39` 以 `smoke: all passed` 结束（脚本先 `break main.compute`、`clear 1`，再 `stepout`，断言停在 `main.go:25`、`pc: 0x4b1b8[56]`）。脚本里的 `clear 1` 不只是清理断点，也绕开了代码实现第 7 小节说的入口时序冲突。

> 说明：以上输出按 9.2.39 时的 `_fixtures/vars` 实测；仓库当前的 `vars` 又为 9.2.40/9.2.42 追加了 `spinner`、`add` 等函数，`main.go` 的行号整体后移（Println 行 25→30，`compute` 函数体 32→40），冒烟脚本的断言也随之更新。

### 本节小结

`stepout` 把"执行到当前函数返回"拆成四个动作：从 CFI 算出的 CFA 取 `CFA-8` 处的返回地址（与 `bt` 共用同一套逻辑）；在 RA 上设一个步进类临时断点；`continue` 让 CPU 把函数执行完，函数返回时命中 RA 的 `int3`；确认停点是否就是 RA，是则清除临时断点并回退 PC，否则保留断点并如实报告这次停止。为了在断点命中后取到正确的 CFA，CFI 查询要用 `pc-1`（`effectivePC`），显示仍用真实 PC。

边界与已知问题：

- 只支持当前帧、当前事件线程；`frame` 是桩，`up`/`down` 不存在，无法从外层帧发起 stepout。
- 当前 PC 必须有 `.debug_frame` 覆盖；汇编、cgo 等没有 FDE 的帧会让 `ReturnAddress` 失败。
- 函数尾部的 `defer` 会照常执行（只要最终通过 `RET` 返回，stepout 仍成立）；但 panic/`runtime.Goexit` 展开不经过当前帧的 `RET`，无限循环或阻塞调用也会让命令一直等——没有超时，临时断点还可能被后续某个同样返回到 RA 的调用误触发。
- 停在别处时临时断点会留在断点表里，后续可能意外命中；命令只报告停止，不提示"临时断点保留"。
- 入口断点叠加首条指令改变 `rsp` 时，`effectivePC` 与"已越过断点"的时序冲突会让 RA 取错（见代码实现第 7 小节）。
- `finish` 别名被桩遮蔽，属于 `FEATURE-MATRIX §11①` 的已知问题，只能用 `so`/`stepout`。

下一步的 `call` 会复用这里的两块基础设施：目标层"读寄存器—写寄存器—继续"的执行控制，以及符号层的函数查找与 `.debug_frame`/CFA 查询。
