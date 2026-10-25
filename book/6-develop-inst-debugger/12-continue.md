## 执行控制：运行到下个断点

### 实现目标：`godbg> continue` 运行到下个断点

假定当前tracee处于被调试跟踪、暂停执行状态，如果要运行到下个断点处，应该如何做呢？detach之后，被跟踪的tracee会自动恢复执行，但我们肯定要继续跟踪。

操作系统提供了 `ptrace(PTRACE_CONT,...)` 操作，允许我们恢复tracee执行，此时的tracee仍然被tracer跟踪。当tracee运行到下个断点处时，执行0xCC触发3号中断#BP，内核生成SIGTRAP给tracee，进入信号处理逻辑，暂停tracee并唤醒tracer。

在执行恢复操作前，需要检查当前 `PC-1` 地址处是否是我们添加的断点，如果是则需要将其替换为原始指令数据、回退PC (PC=PC-1)、单步越过这条原指令，并立即重新添加断点，确保tracee能够正确执行后续指令。

### 代码实现

continue命令的执行流程如下：

1. 读取当前PC
2. 检查 `PC-1` 处是否为本调试器添加的断点：如果是，则还原该处的原始指令、把PC回退到断点地址、单步执行这条原指令，并立即重新添加断点
3. 执行 `ptrace(PTRACE_CONT, ...)` 操作请求操作系统恢复tracee执行
4. 通过 `syscall.Wait4(...)` 等待tracee停下来，得到停止原因
5. 当tracee运行到下个断点处时，会重新触发int3中断，tracer被唤醒后获取停止的线程和原因

注意：命中断点时PC值是执行了0xCC指令之后的地址值，因此 PC=断点地址+1。

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
		// 读取当前 PC
		regs, err := Client.ReadRegs()
		if err != nil {
			return fmt.Errorf("get regs error: %v", err)
		}

		// 若当前线程停在断点处（PC-1 为断点地址）：
		// 还原断点指令 → 回退 PC → 单步越过 → 立即恢复断点，然后继续执行
		addr := regs.PC() - 1
		if err := Client.RestoreInstruction(addr); err == nil {
			fmt.Printf("stopped at breakpoint %#x\n", addr)

			regs.SetPC(addr)
			if err := Client.WriteRegs(regs); err != nil {
				restoreBreakpoint(addr)
				return fmt.Errorf("write regs error: %v", err)
			}
			if err := Client.Step(); err != nil {
				restoreBreakpoint(addr)
				return fmt.Errorf("single step error: %v", err)
			}

			// 单步已越过断点指令，立即恢复断点；之后 continue 再次
			// 执行到该地址时才能正常命中。
			restoreBreakpoint(addr)
		} else if err != api.ErrBreakpointNotExisted {
			return fmt.Errorf("restore instruction error: %v", err)
		}

		// 恢复执行，直到进程因断点等事件而停止
		stop, err := Client.Continue()
		if err != nil {
			return fmt.Errorf("continue error: %v", err)
		}
		fmt.Printf("thread %d status: %s\n", stop.PID, stop.Reason)
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(continueCmd)
}

// restoreBreakpoint 写回断点指令。失败只告警，不中断当前命令。
func restoreBreakpoint(addr uint64) {
	if _, err := Client.AddBreakpoint(addr); err != nil {
		fmt.Fprintf(os.Stderr, "warning: failed to restore breakpoint at %#x: %v\n", addr, err)
	}
}
```

命令层和 `step` 一样通过 `api.Client` 操作当前线程：先处理 `PC-1` 处的断点，再调用 `Client.Continue()` 恢复执行。`Continue` 返回 `api.StopInfo`，其中只有两个字段：`PID` 是停下来的线程/进程 id，`Reason` 是停止原因（如 `stopped: trace/breakpoint trap`）。

这里的关键是**单步越过断点后立即恢复断点**：`restoreBreakpoint(addr)` 必须在 `Client.Step()` 返回后、`Client.Continue()` 之前调用，不能推迟到命令返回时。断点如果SingleStep越过后不立即加回，后续的 `Continue()`，如果 tracee 在循环中再次执行到同一地址，就会因为断点不存在而无法停下。底层 `pkg/target` 的 `Continue` 负责发起 `ptrace(PTRACE_CONT,...)`、等待停止并描述 `WaitStatus`：

**file：pkg/target/continue.go**

```go
package target

import (
	"fmt"
	"strconv"
	"syscall"

	"github.com/hitzhangjie/godbgv2/pkg/service/api"
)

// Continue 恢复被调试进程执行，等待其停止，返回停止原因。
//
// 当前只跟踪主线程（ch6.20 起扩展为多线程的 all-stop 模式）。
func (p *DebuggedProcess) Continue() (*api.StopInfo, error) {
	pid := p.Process.Pid

	err := p.ExecPtrace(func() error {
		err := syscall.PtraceCont(pid, 0)
		if err == syscall.ESRCH {
			return nil
		}
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("ptrace cont thread %d err: %v", pid, err)
	}

	// wait stopped
	wpid, status, err := p.wait(pid, syscall.WSTOPPED)
	if err != nil {
		return nil, fmt.Errorf("wait error: %v", err)
	}
	if status == nil {
		// 目标进程已退出（zombie）
		return &api.StopInfo{PID: wpid, Reason: "exited"}, nil
	}
	return &api.StopInfo{PID: wpid, Reason: descStatus(status)}, nil
}

// descStatus 将 wait 返回的状态描述为可读字符串
func descStatus(status *syscall.WaitStatus) string {
	switch {
	case status.Continued():
		return "continued"
	case status.Exited():
		return "exited: " + strconv.Itoa(status.ExitStatus())
	case status.Signaled():
		return "signaled: " + status.Signal().String()
	case status.Stopped():
		return "stopped: " + status.StopSignal().String()
	case status.CoreDump():
		return "coredump"
	default:
		return strconv.Itoa(int(*status))
	}
}
```

> ps：上述代码取自 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.12`。为了让正文聚焦在 continue 的流程上，这里只展开了命令层和恢复执行的底层实现；`api.Client` 接口、`api.StopInfo` 类型和 `debugger` 门面的改动属于配套的支撑代码。

### 代码测试

测试对象是 godbgv2 自带的 `_fixtures/loop`，它每秒打印一次 pid 和循环计数。`main.main` 的循环体从 `0x4b3971` 开始，每轮都会执行。切到本节代码并构建：

```bash
$ git checkout ch6.12
$ make build
$ make fixtures
```

只在循环体起点下一个断点，然后连续执行三次 `continue`：

```bash
$ ./godbg exec _fixtures/loop
process 2266348 launched, stopped by SIGTRAP
godbg> break 0x4b3971
breakpoint 1 added at 0x4b3971
godbg> continue
thread 2266348 status: stopped: trace/breakpoint trap
godbg> continue
stopped at breakpoint 0x4b3971
pid: 2266348, loop: 0
thread 2266348 status: stopped: trace/breakpoint trap
godbg> continue
stopped at breakpoint 0x4b3971
pid: 2266348, loop: 1
thread 2266348 status: stopped: trace/breakpoint trap
godbg> exit
tracee is run by tracer, kill it
```

第一次 `continue` 从程序入口 `0x478120` 一直运行到循环体起点 `0x4b3971`，命中 int3 后停下；此时 PC=0x4b3972=0x4b3971+1，输出中的 `stopped: trace/breakpoint trap` 就是命中断点后收到的 SIGTRAP。

第二次 `continue` 时 `PC-1=0x4b3971` 正好是断点，命令层先还原原始指令、把 PC 回退到 `0x4b3971`，再单步执行这条原指令越过断点，然后立即恢复断点并恢复执行。target 打印完 `loop: 0` 后回到循环体起点，再次命中同一个断点。

第三次 `continue` 重复同样的过程：越过 `0x4b3971` 处的断点、立即恢复、继续执行，target 打印 `loop: 1` 后再次命中该断点。连续多次 `continue` 都能停在同一地址，说明断点在恢复执行前已经写回。

### 思考：这样的实现是完备的吗？

我们只考虑了1个tracee线程的情况，而go程序是多线程程序，如果我们要对一个go进程进行调试，那么必须对多线程调试进行支持。否则我们只continue一个线程，而其他线程都处于stopped状态，那么这个线程可能无法正常与其他线程同步状态，可能根本就无法进行调试了。我们前面提到过类似的设计，这些tracee线程要么都停止、要么都运行，这样方便我们调试。

所以当我们执行continue命令时，需要特别注意对多线程调试的支持。godbgv2 在 ch6.12 的实现只对主线程发起 `PTRACE_CONT`，多线程的 all-stop 模式留到 ch6.20 实现。

### 更多相关内容

continue命令对于符号级调试器至关重要。在源代码向汇编指令的转换过程中，一条源代码语句可能对应多条机器指令。当我们需要：

- 逐语句执行
- 进入、退出函数（函数有prologue、epilogue）
- 进入、退出循环体

实现上述源码级调试功能时，必须借助对源码及指令的理解，在正确的地址处设置断点，然后配合continue命令来实现。

我们将在符号级调试器一章中更详细地研究这些内容。

### 本节小结

本节主要探讨了调试器中continue命令的实现原理和具体实现，核心内容包括：通过 `ptrace(PTRACE_CONT,...)`恢复tracee执行，并等待其运行到下一个断点或者执行结束；在恢复执行前需要检查并还原断点处的原始指令数据、调整PC寄存器值并单步越过原指令，越过之后立即恢复断点，以确保指令解码正常、后续执行到同一地址仍能命中；使用 `syscall.Wait4`等待tracee在断点处停止并获取其状态变化。本节重点强调了断点恢复机制的重要性——必须将0xCC断点指令还原为原始指令并回退PC，确保tracee能够正确执行后续指令。

这些底层机制为符号级调试器提供了基础支撑，使得调试器能够实现逐语句执行、函数进入退出等高级调试功能。本节内容为读者理解调试器的执行控制机制和后续学习符号级调试器打下了坚实的技术基础。
