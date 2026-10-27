## 线程执行控制 - continue

### 实现目标：多线程环境下的continue命令

前面我们已经介绍了如何跟踪进程中的已有线程，以及后续执行期间会新创建的线程。在对进程内所有已有、未来创建的线程获得了可以全部跟踪的能力之后，我们又介绍了主流调试器的线程挂起策略，如GDB、LLDB、Delve。本节我们将更进一步，介绍 All-stop Mode 下 continue 命令应该如何实现。因为主流调试器GDB、LLDB默认都是All-stop Mode，而且Delve这么多年了也支持All-stop Mode，说明这才是大多数情况下的调试诉求。

OK，现在我们开始介绍 All-stop Mode 下 continue 命令的实现，我们需要特别注意以下两种情景。

**情景1**：有的线程是因为命中断点停止，这类情况恢复逻辑稍微复杂点，大致的处理步骤如下：

    1. 恢复这些线程时需要恢复断点处patched之前的指令
    2. 然后PC--
    3. 然后SINGLESTEP执行到patched之前的指令
    4. 然后重设断点
    5. 最后PTRACE_CONT恢复执行；

**情景2**：有的线程是因为收到信号SIGSTOP停止（如因其他线程命中断点，All-stop Mode下会通过SIGSTOP通知所有线程暂停），通过PTRACE_CONT恢复执行；

OK，其实检查下线程当前PC-1处是不是0xCC，并且在PC-1处是一个用户添加的断点，如果是就按照情景1进行处理，否则就按照情景2进行处理。进程层面维护好所有内部包含的线程，遍历线程列表分别进行上述处理即可。

### 代码实现

和单线程版本相比，多线程 continue 要回答两个新问题：

1. 哪些线程正停在断点处？不能只看当前线程，因为 all-stop 下可能有多个线程分别停在同一个或不同的断点处。
2. 恢复执行时如何既处理这些断点，又保证所有线程都被放行？

godbgv2 把这两个问题分别放在 target 层的 `ThreadStoppedAtBreakpoint` 和 `Continue` 中，命令层负责把两者串起来。

#### 命令层：先处理所有停在断点处的线程

**file：cmd/debug/continue.go**

```go
package debug

import (
	"fmt"
	"os"

	"github.com/hitzhangjie/godbgv2/pkg/service/api"
	"github.com/spf13/cobra"
)

var continueCmd = &cobra.Command{
	Use:     "continue",
	Short:   "运行到下一个断点处",
	Aliases: []string{"c"},
	Annotations: map[string]string{
		cmdGroupAnnotation: cmdGroupCtrlFlow,
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		// 检查是否有线程停在断点处
		bpStoppedThreads, err := Client.ThreadsStoppedAtBreakpoint()
		if err != nil {
			return fmt.Errorf("check thread breakpoints error: %v", err)
		}

		// 没有线程停在断点处：直接恢复执行
		if len(bpStoppedThreads) == 0 {
			return continueRun()
		}

		// 有线程停在断点处（多线程，ch6.17.4）：
		// 对每个这样的线程：还原断点 → 回退 PC → 单步越过 → 恢复断点
		bpCleared := make(map[uint64]struct{})
		for tid, bpAddr := range bpStoppedThreads {
			fmt.Printf("thread %d stopped at breakpoint %#x\n", tid, bpAddr)

			// 回退该线程的 PC
			regs, err := Client.ReadRegs(tid)
			if err != nil {
				return fmt.Errorf("read register for thread %d: %v", tid, err)
			}
			regs.SetPC(regs.PC() - 1)
			if err = Client.WriteRegs(tid, regs); err != nil {
				return fmt.Errorf("write register for thread %d: %v", tid, err)
			}

			// 断点只需还原一次（多线程可能停在同一个断点）
			if _, cleared := bpCleared[bpAddr]; !cleared {
				if err := Client.RestoreInstruction(bpAddr); err != nil && err != api.ErrBreakpointNotExisted {
					return fmt.Errorf("clear breakpoint at %#x error: %v", bpAddr, err)
				}
				bpCleared[bpAddr] = struct{}{}
			}

			// 单步越过断点处指令
			if err := Client.Step(tid); err != nil {
				return fmt.Errorf("single step for thread %d: %v", tid, err)
			}

			// 恢复断点
			if _, err := Client.AddBreakpoint(bpAddr); err != nil {
				fmt.Fprintf(os.Stderr, "warning: failed to restore breakpoint at %#x: %v\n", bpAddr, err)
			} else {
				fmt.Printf("restored breakpoint at %#x\n", bpAddr)
			}
		}

		// 恢复所有线程执行
		if err := continueRun(); err != nil {
			return err
		}
		fmt.Println("continue ok")
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(continueCmd)
}

// continueRun 恢复所有线程执行，并打印停止信息
func continueRun() error {
	stop, err := Client.Continue()
	if err != nil {
		return fmt.Errorf("continue error: %v", err)
	}
	fmt.Printf("thread %d status: %s\n", stop.PID, stop.Reason)
	// all-stop 挂起策略：其余线程已被挂起
	fmt.Println("stop all threads now")
	return nil
}
```

流程很直接：

1. 先调用 `Client.ThreadsStoppedAtBreakpoint()` 拿到 `map[tid]断点地址`；
2. 没有线程停在断点处，直接走 `continueRun()`；
3. 有线程停在断点处，就逐个处理：读取该线程寄存器、`PC--`、写回；用 `bpCleared` 记录已经还原过的地址，避免对同一地址重复调用 `RestoreInstruction`；然后让该线程单步越过原指令；最后重新添加断点；
4. 所有断点线程处理完后，统一 `continueRun()` 恢复全部线程。

注意第 3 步中的 `Client.Step(tid)` 是**按线程**单步的。all-stop 下其他线程都处于停止状态，因此单步一个线程不会受到其他线程干扰；这也要求 `ReadRegs`、`WriteRegs`、`Step` 都能接收 tid，而不是像单线程版本那样默认操作主线程。

另外，上面的源码注释把步骤概括为“还原断点 → 回退 PC → 单步越过 → 恢复断点”，而代码中的实际顺序是先回退 PC，再按地址去重还原指令。顺序不能反：还原指令会删除断点索引，之后再想判断哪些线程停在断点处就查不到了。这一点在下一节移除断点时还会再展开。

#### service 层：把“当前线程”和“断点线程集合”暴露给命令层

`api.Client` 接口相应增加了两个方法，并把寄存器、单步操作改为按 tid 进行：

**file：pkg/service/api/client.go**（片段）

```go
	// ReadRegs 读取线程 tid 的寄存器
	ReadRegs(tid int) (*Registers, error)
	// WriteRegs 写回线程 tid 的寄存器
	WriteRegs(tid int, regs *Registers) error
	// RestoreInstruction 还原地址 addr 处断点的原始指令（不移除断点记录）
	RestoreInstruction(addr uint64) error
	// Step 线程 tid 单指令步进
	Step(tid int) error
	// CurrentThread 返回当前线程的 tid
	CurrentThread() (int, error)
	// ThreadsStoppedAtBreakpoint 返回停在断点处的线程（tid→断点地址）
	ThreadsStoppedAtBreakpoint() (map[int]uint64, error)
```

debugger 门面负责把 target 层的内部类型转换成 api 层的值类型：

**file：pkg/service/debugger/debugger.go**（片段）

```go
// CurrentThread 返回当前线程的 tid
func (d *Debugger) CurrentThread() (int, error) {
	if d.dbp == nil {
		return 0, fmt.Errorf("no debugged process")
	}
	return d.dbp.CurrentThreadTid()
}

// ThreadsStoppedAtBreakpoint 返回停在断点处的线程（tid→断点地址）
func (d *Debugger) ThreadsStoppedAtBreakpoint() (map[int]uint64, error) {
	if d.dbp == nil {
		return nil, fmt.Errorf("no debugged process")
	}
	m, err := d.dbp.ThreadStoppedAtBreakpoint()
	if err != nil {
		return nil, err
	}
	out := map[int]uint64{}
	for tid, addr := range m {
		out[tid] = uint64(addr)
	}
	return out, nil
}
```

#### target 层：找出所有停在断点处的线程

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

每个被跟踪线程都读一次寄存器。断点指令 `int3` 执行后 PC 指向断点地址的下一条指令，所以要看 `PC-1` 处是否在断点表中；线程可能刚好退出，`ESRCH` 直接跳过。

#### target 层：恢复全部线程并处理克隆事件

**file：pkg/target/continue.go**（片段）

```go
package target

import (
	"fmt"
	"strconv"
	"syscall"

	"github.com/hitzhangjie/godbgv2/pkg/service/api"
)

// Continue 恢复全部线程执行，等待任意线程停止，然后挂起其余线程
// （all-stop 挂起策略），返回停止原因。
//
// 线程克隆事件（PTRACE_EVENT_CLONE）是内部事件：读取并跟踪新线程后
// 让克隆者继续执行，继续等待真正的停止事件。
func (p *DebuggedProcess) Continue() (*api.StopInfo, error) {
	// 恢复全部线程执行
	for _, thread := range p.Threads {
		err := p.ExecPtrace(func() error {
			err := syscall.PtraceCont(thread.Tid, 0)
			if err == syscall.ESRCH {
				return nil
			}
			return err
		})
		if err != nil {
			return nil, fmt.Errorf("ptrace cont thread %d err: %v", thread.Tid, err)
		}
	}

	// 等待任意线程停止
	for {
		wpid, status, err := p.waitAny(syscall.WSTOPPED)
		if err != nil {
			return nil, fmt.Errorf("wait error: %v", err)
		}
		if status == nil {
			// 目标进程已退出（zombie）
			return &api.StopInfo{PID: wpid, Reason: "exited"}, nil
		}

		if status.Stopped() && status.TrapCause() == syscall.PTRACE_EVENT_CLONE {
			// 内部事件：新线程已被内核自动跟踪（PTRACE_O_TRACECLONE），
			// 读取其 tid 并加入线程列表。
			//
			// 注意顺序：必须先恢复克隆者继续执行——新线程的初始
			// SIGSTOP 在克隆者被恢复后才进入可等待状态——然后再
			// 消费新线程的初始 SIGSTOP。
			newTid, err := p.getEventMessage(wpid)
			if err != nil {
				return nil, fmt.Errorf("get event msg error: %v", err)
			}
			if _, err := p.addThread(newTid, false); err != nil {
				return nil, fmt.Errorf("add thread error: %v", err)
			}
			if err := p.ExecPtrace(func() error {
				err := syscall.PtraceCont(wpid, 0)
				if err == syscall.ESRCH {
					return nil
				}
				return err
			}); err != nil {
				return nil, fmt.Errorf("ptrace cont thread %d err: %v", wpid, err)
			}
			if _, status, err := p.waitFast(newTid); err == nil && status.Exited() {
				delete(p.Threads, newTid)
			}
			continue
		}

		// 真正的停止事件：挂起其余线程（all-stop）
		if err := p.suspendOtherThreads(wpid); err != nil {
			return nil, err
		}

		// 记录当前线程及其停止原因
		p.currentThread = p.Threads[wpid]
		if p.currentThread != nil {
			p.currentThread.stopReason = descStatus(status)
		}

		return &api.StopInfo{PID: wpid, Reason: descStatus(status)}, nil
	}
}
```

与 ch6.17.3 相比，这一版最重要的修正是克隆事件里的**恢复顺序**。ch6.17.3 在 `addThread` 之后先 `waitFast(newTid)` 消费新线程的初始 SIGSTOP，再继续克隆者；但新线程的初始 SIGSTOP 只有在克隆者被恢复执行后才进入可等待状态，先等就会卡住。ch6.17.4 改为：

1. `getEventMessage(wpid)` 读出 newTid；
2. `addThread(newTid, false)` 加入线程列表；
3. 先 `PTRACE_CONT` 恢复克隆者 wpid；
4. 再 `waitFast(newTid)` 消费新线程的初始 SIGSTOP；
5. `continue` 回到循环，继续等待真正的停止事件。

真正停止事件的处理与上一节相同：`suspendOtherThreads(wpid)` 挂起其余线程，记录 `currentThread` 和 `stopReason`，然后返回 `StopInfo`。

#### 当前线程

`pregs`、`step`、`set reg` 等命令需要知道“当前线程”是谁。目标层新增 `CurrentThreadTid`，并在启动/attach 时把当前线程初始化为线程组 leader：

**file：pkg/target/thread.go**（片段）

```go
// CurrentThreadTid 返回当前线程的 tid
func (p *DebuggedProcess) CurrentThreadTid() (int, error) {
	if p.currentThread == nil {
		return 0, fmt.Errorf("no current thread")
	}
	return p.currentThread.Tid, nil
}
```

**file：pkg/target/process.go**（片段）

```go
	// 将主线程加入线程列表（此时被调试进程因 exec 停止，只有主线程）
	if _, err := dbp.addThread(dbp.Process.Pid, false); err != nil {
		return nil, err
	}
	// 当前线程默认为主线程（ch6.17.4 起多线程调试命令依赖它）
	dbp.currentThread = dbp.Threads[dbp.Process.Pid]
	return &dbp, nil
```

后续每次 `Continue` 真正停下来时，`currentThread` 会被更新为本次停下来的线程。于是一个典型的交互过程是：`continue` 停在线程 T，`pregs`/`step` 操作 T；再 `continue` 停在另一个线程，这些命令的上下文也随之切换。

> ps：上述代码取自 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.17.4`。本节新增多线程断点线程的枚举与逐线程恢复、`CurrentThread`/`ThreadsStoppedAtBreakpoint` 接口、以及克隆事件恢复顺序的修正；`suspendOtherThreads`、`waitAny` 等是 ch6.17.2、ch6.17.3 已有的配套实现。

### 代码测试

测试目标仍是 `_fixtures/loop2`。切换到本节代码并构建：

```bash
$ git checkout ch6.17.4
$ make build
$ make fixtures
```

在程序入口 `0x478120` 和 Go 运行时入口 `_rt0_amd64`（`0x4749e0`）各下一个断点。入口处只有一条跳转指令：

```bash
$ objdump -d _fixtures/loop2 --start-address=0x478120 --stop-address=0x478125
0000000000478120 <_rt0_amd64_linux>:
  478120:	e9 bb c8 ff ff       	jmpq   4749e0 <_rt0_amd64>
```

然后启动调试会话，连续执行两次 `continue`：

```bash
$ ./godbg exec _fixtures/loop2
process 2329964 launched, stopped by SIGTRAP
godbg> break 0x478120
breakpoint 1 added at 0x478120
godbg> break 0x4749e0
breakpoint 2 added at 0x4749e0
godbg> continue
thread 2329964 status: stopped: trace/breakpoint trap
stop all threads now
godbg> continue
thread 2329964 stopped at breakpoint 0x478120
restored breakpoint at 0x478120
thread 2329964 status: stopped: trace/breakpoint trap
stop all threads now
continue ok
godbg> pregs
Register    Value
Rip         0x4749e1
Rsp         0x7fff61ef0300
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

第一次 `continue` 从程序入口开始执行，命中 `0x478120` 处的断点，输出 `stopped: trace/breakpoint trap` 并执行 all-stop。

第二次 `continue` 时，`ThreadsStoppedAtBreakpoint` 发现主线程的 `PC-1 == 0x478120`，命令层于是：

1. 把该线程 PC 回退到 `0x478120`；
2. 还原 `0x478120` 处的原始跳转指令；
3. 对该线程单步执行这条 `jmpq 4749e0`；
4. 重新加上 `0x478120` 处的断点；
5. 恢复全部线程执行。

单步时 CPU 跳到 `0x4749e0`，而那里有第二个断点，于是再次命中，PC 停在 `0x4749e1`。最后的 `pregs` 输出 `Rip 0x4749e1`，正好是断点地址 `0x4749e0` 加 1，验证了“命中断点后 PC 指向断点指令的下一条指令”这一事实。

> ps：上面是某次真实运行的结果。线程 tid、栈地址每次运行都会变化；代码段地址由固定工具链和 `-gcflags "all=-N -l"` 构建决定，因此 `0x478120`、`0x4749e0` 是可复现的。

### 思考：多个线程停在同一个断点时

上面的实现用 `bpCleared` 避免了同一地址的重复还原，但循环内每处理完一个线程都会立即 `AddBreakpoint(bpAddr)`。如果确实有两个线程停在同一个断点地址，第一个线程处理完后断点已经被重新写回，第二个线程单步时就会再次执行 `0xCC` 触发 `int3`，从而没有真正执行断点处的原始指令，恢复执行时也就跳过了这条指令。

all-stop 下通常只有一个线程正好停在断点处，其他线程是被 SIGSTOP 挂起的，所以这个边界在常见调试流程中不容易碰到。但如果要严格支持“多个线程同时停在同一断点”，更稳妥的做法是：遍历期间只还原一次、先让所有停在同址的线程各自单步越过，等这批线程都处理完再统一 `AddBreakpoint`。这也是后续完善多线程断点管理时可以继续打磨的点。

### 本节小结

本节主要探讨了多线程环境下continue命令的实现机制，核心内容包括：通过 `ThreadsStoppedAtBreakpoint` 枚举所有停在断点处的线程；对每个这样的线程执行 PC 回退、断点还原、按线程单步、断点重设，最后通过 `Continue` 恢复全部线程；`Continue` 在等待过程中把克隆事件当作内部事件消费，并在真正的停止事件到来后挂起其余线程（all-stop）。同时我们修正了克隆事件中恢复克隆者与消费新线程初始 SIGSTOP 的先后顺序。

与单线程 continue 相比，多线程版本的关键在于“遍历线程列表”而不是只操作主线程，以及“当前线程”概念的引入：`pregs`、`step`、`set reg` 等命令都通过 `CurrentThread` 获取 tid，再针对该线程读写寄存器和单步。本节内容为后续处理多线程断点移除、以及更复杂的执行控制功能打下了基础。
