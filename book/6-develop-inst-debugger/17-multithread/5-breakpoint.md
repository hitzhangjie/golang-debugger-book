## 线程执行控制 - 断点移除

### 实现目标：多线程环境下移除断点时回退线程 PC

前面几节我们完成了多线程的跟踪、all-stop 挂起策略和多线程 continue。这一节补上多线程断点管理里容易被忽略的一环：**移除断点时，如何处理正停在该断点处的线程**。

在单线程调试器里，`clear`、`clearall` 只需要把断点处的 `0xCC` 还原成原始指令即可。但在多线程 + all-stop 的场景下，某个线程可能正停在这个断点上：它的 PC 已经越过了 `int3`，指向断点地址的下一条指令。此时如果只还原指令、不调整 PC，该线程恢复执行后就会从断点地址之后继续，**跳过**原本应该执行的那条指令。

因此，多线程版本的 `clear`/`clearall` 需要先找出所有停在目标断点处的线程，把它们的 PC 回退到断点地址，再还原断点指令。

### 基础知识

#### 软件断点命中后 PC 停在哪里

软件断点的实现方式是把断点地址处指令的首字节替换成 `int3`（`0xCC`）。CPU 执行到这条指令时触发 3 号中断，内核生成 SIGTRAP，调试器被唤醒。

`int3` 是一条单字节指令，执行它时 CPU 已经把 PC 推进到下一条指令。因此调试器看到的寄存器状态是：

```text
PC = 断点地址 + 1
```

调试器判断“线程是否停在断点处”时，检查的就是 `PC-1` 处是否存在断点。

#### 为什么移除断点时要回退 PC

假设断点地址 `addr` 处的原始指令是 `I`，被替换成了 `0xCC`。线程命中后停在 `addr+1`。此时如果直接移除断点（把 `addr` 处还原成 `I`）并恢复执行，线程会从 `addr+1` 继续，`I` 就被跳过了：

```text
正常执行：  addr: I          → addr+n: 下一条指令
命中后跳过： addr: 0xCC(I)    → PC=addr+1 → 从 addr+1 继续，I 未执行
正确恢复：  PC 回退到 addr   → 执行 I    → 继续
```

所以移除断点的正确顺序是：**先回退停在断点处的线程 PC，再还原断点处的原始指令**。

#### 为什么顺序不能反过来

回退 PC 需要知道“哪些线程停在断点处”，而 `ThreadStoppedAtBreakpoint` 是根据断点表来判断的。`RestoreInstruction` 在还原指令的同时会把断点从 `Breakpoints`、`BreakpointsByID` 两张索引中删除；一旦先还原指令，断点表里就查不到这个地址了，再想找出停在它上面的线程就无从下手。

因此 `ClearBreakpoint` 必须把“回退 PC”放在“还原指令”之前。`ClearAll` 则要先把所有停在断点处的线程收集起来，再统一还原所有断点，最后回退这些线程的 PC。

### 代码实现

#### ClearBreakpoint：先回退 PC，再还原指令

**file：pkg/target/breakpoint.go**（片段）

```go
// ClearBreakpoint 移除指定编号的断点：还原断点处的原始指令、摘除索引，
// 并回退停在断点处的线程 PC（ch6.17.5）。
func (p *DebuggedProcess) ClearBreakpoint(id uint64) (*api.Breakpoint, error) {
	bp, ok := p.BreakpointsByID[id]
	if !ok {
		return nil, api.ErrBreakpointNotExisted
	}

	// 先回退停在断点处的线程（PC-1），否则这些线程恢复执行时会
	// 从断点指令之后继续，跳过一条指令。
	// 注意顺序：必须早于还原指令——断点索引会在还原时被摘除，
	// 届时将无法再找到停在断点处的线程。
	if err := p.rewindThreadsAtBreakpoint(bp.Addr); err != nil {
		return nil, err
	}

	if _, err := p.RestoreInstruction(bp.Addr); err != nil {
		return nil, err
	}
	return toAPIBreakpoint(bp), nil
}

// rewindThreadsAtBreakpoint 回退停在断点addr处的线程 PC
func (p *DebuggedProcess) rewindThreadsAtBreakpoint(addr uintptr) error {
	bpStoppedThreads, err := p.ThreadStoppedAtBreakpoint()
	if err != nil {
		return fmt.Errorf("检查线程停在断点处失败: %v", err)
	}
	for tid, bpAddr := range bpStoppedThreads {
		if bpAddr != addr {
			continue
		}
		regs, err := p.ReadRegister(tid)
		if err != nil {
			return fmt.Errorf("读取寄存器失败: %v", err)
		}
		regs.SetPC(regs.PC() - 1)
		if err = p.WriteRegister(tid, regs); err != nil {
			return fmt.Errorf("写入寄存器失败: %v", err)
		}
	}
	return nil
}
```

`rewindThreadsAtBreakpoint` 只回退停在 `addr` 这个断点上的线程；停在其他断点上的线程留给对应的 `ClearBreakpoint` 处理。每个线程读一次寄存器、`PC--`、写回，不需要单步，因为断点马上就会被还原，线程恢复执行时会从断点地址重新执行原始指令。

#### ThreadStoppedAtBreakpoint：找出停在断点处的线程

**file：pkg/target/breakpoint.go**（片段）

```go
// ThreadStoppedAtBreakpoint 检查所有线程是否停在断点处，
// 返回 tid→断点地址 的映射。
//
// 断点指令（int3）已执行时 PC 指向断点地址+1，因此检查 PC-1 处
// 是否存在断点。
func (p *DebuggedProcess) ThreadStoppedAtBreakpoint() (map[int]uintptr, error) {
	threadStoppedAtBP := make(map[int]uintptr)

	if len(p.Threads) == 0 {
		return threadStoppedAtBP, nil
	}

	for tid, thread := range p.Threads {
		regs, err := p.ReadRegister(thread.Tid)
		if err != nil {
			// 线程可能已经退出，跳过
			if err == syscall.ESRCH {
				continue
			}
			return nil, fmt.Errorf("read register for thread %d: %v", tid, err)
		}

		// 检查 PC-1 位置是否有断点
		pc := regs.PC()
		if bp, exists := p.Breakpoints[uintptr(pc-1)]; exists {
			threadStoppedAtBP[tid] = bp.Addr
		}
	}

	return threadStoppedAtBP, nil
}
```

这个函数在 ch6.17.4 的 continue 中已经出现过，本节复用它来完成 clear 的 PC 回退。注意 `ESRCH` 的处理：如果线程在遍历过程中退出，读寄存器会失败，跳过即可，不应让整个 `clear` 失败。

#### ClearAll：先收集，再还原，最后回退

**file：pkg/target/breakpoint.go**（片段）

```go
// ClearAll 删除所有已添加的断点，并回退所有停在断点处的线程 PC
// （ch6.17.5）。
func (p *DebuggedProcess) ClearAll() error {
	// 首先检查所有线程是否停在断点处（必须先于还原指令，
	// 断点索引会在还原时被摘除）
	stopped, err := p.ThreadStoppedAtBreakpoint()
	if err != nil {
		return fmt.Errorf("check thread breakpoints error: %v", err)
	}

	for _, bp := range p.Breakpoints {
		if _, err := p.RestoreInstruction(bp.Addr); err != nil {
			return fmt.Errorf("clear breakpoint at %#x error: %v", bp.Addr, err)
		}
	}

	// 回退所有停在断点处的线程 PC
	for tid := range stopped {
		regs, err := p.ReadRegister(tid)
		if err != nil {
			return fmt.Errorf("read register for thread %d: %v", tid, err)
		}
		regs.SetPC(regs.PC() - 1)
		if err = p.WriteRegister(tid, regs); err != nil {
			return fmt.Errorf("write register for thread %d: %v", tid, err)
		}
	}

	return nil
}
```

`ClearAll` 的顺序更严格：

1. 先调用 `ThreadStoppedAtBreakpoint` 把“哪些线程停在哪个断点”完整记录下来；
2. 遍历所有断点，逐个 `RestoreInstruction`；
3. 最后按第 1 步的记录回退这些线程的 PC。

如果把第 3 步放在第 2 步中间，或者每次还原一个断点就回退对应线程，都会因为断点索引已被删除而查不到线程。先收集、后还原、再回退，才能保证多断点、多线程同时存在时也不漏回退。

> ps：上述代码取自 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.17.5`。本节新增 `ClearBreakpoint` 的 PC 回退、`rewindThreadsAtBreakpoint` 和 `ClearAll` 的“收集—还原—回退”流程；`ThreadStoppedAtBreakpoint` 是 ch6.17.4 已有的实现。

### 代码测试

测试目标仍是 `_fixtures/loop2`。切换到本节代码并构建：

```bash
$ git checkout ch6.17.5
$ make build
$ make fixtures
```

在程序入口 `0x478120` 下断点，`continue` 命中后先看一次寄存器，再 `clear` 移除断点，然后再看一次寄存器：

```bash
$ ./godbg exec _fixtures/loop2
process 2330442 launched, stopped by SIGTRAP
godbg> break 0x478120
breakpoint 1 added at 0x478120
godbg> continue
thread 2330442 status: stopped: trace/breakpoint trap
stop all threads now
godbg> pregs
Register    Value
Rip         0x478121
Rsp         0x7ffcb3901d70
Rbp         0x0
Rax         0x0
Rbx         0x0
Rcx         0x0
Rdx         0x0
Rsi         0x0
Rdi         0x0
R8          0x0
R9          0x0
R10         0x0
R11         0x0
R12         0x0
R13         0x0
R14         0x0
R15         0x0
EFlags      0x202
Cs          0x33
Ss          0x2b
Ds          0x0
Es          0x0
Fs          0x0
Gs          0x0
FsBase      0x0
GsBase      0x0
OrigRax     0xffffffffffffffff
godbg> clear -n 1
breakpoint 1 at 0x478120 cleared
godbg> pregs
Register    Value
Rip         0x478120
Rsp         0x7ffcb3901d70
Rbp         0x0
Rax         0x0
Rbx         0x0
Rcx         0x0
Rdx         0x0
Rsi         0x0
Rdi         0x0
R8          0x0
R9          0x0
R10         0x0
R11         0x0
R12         0x0
R13         0x0
R14         0x0
R15         0x0
EFlags      0x202
Cs          0x33
Ss          0x2b
Ds          0x0
Es          0x0
Fs          0x0
Gs          0x0
FsBase      0x0
GsBase      0x0
OrigRax     0xffffffffffffffff
godbg> exit
tracee is run by tracer, kill it
```

第一次 `pregs` 显示 `Rip 0x478121`：线程执行了 `0x478120` 处的 `int3`，PC 已经推进到下一条指令。执行 `clear -n 1` 后，`ClearBreakpoint` 先通过 `ThreadStoppedAtBreakpoint` 发现主线程停在 `0x478120`，把它的 PC 回退到 `0x478120`，然后还原原始指令、摘除断点索引。

第二次 `pregs` 显示 `Rip 0x478120`，说明 PC 已经回退。如果此时继续执行，CPU 会从 `0x478120` 重新执行被断点替换掉的原始跳转指令，不会跳过它。

`clearall` 的行为也可以用同样方式验证，它会把所有停在断点处的线程 PC 都回退：

```bash
godbg> clearall
清空断点成功
godbg> pregs
Register    Value
Rip         0x478120
...
```

> ps：上面是某次真实运行的结果。`0x478120` 是固定工具链下 `_fixtures/loop2` 的入口地址，`readelf -h _fixtures/loop2` 的 Entry point 也是它；栈地址和 tid 每次运行都会变化。

### 本节小结

本节讨论了多线程环境下移除断点时的 PC 回退问题。软件断点命中后 PC 指向断点地址的下一条指令；如果移除断点时不回退 PC，线程恢复执行就会跳过断点处的原始指令。godbgv2 在 ch6.17.5 中把这一逻辑放进 target 层：`ClearBreakpoint` 先调用 `rewindThreadsAtBreakpoint` 回退停在目标断点上的线程 PC，再 `RestoreInstruction`；`ClearAll` 则先收集所有停在断点处的线程，再还原全部断点，最后统一回退 PC。

这里最关键的是顺序：回退 PC 依赖断点索引来识别线程，而还原指令会删除索引，所以必须“先回退/先收集，后还原”。再结合前一节的 `ThreadStoppedAtBreakpoint` 和 all-stop continue，调试器在多线程下就能一致地处理断点的命中、恢复和移除，也为后续更复杂的断点管理功能打下了基础。
