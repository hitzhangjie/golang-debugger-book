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

### 设计实现

这部分代码，您可以参考 [hitzhangjie/godbg](https://github.com/hitzhangjie/godbg/blob/9f6daf9831eaaa2b5eafc5bb2ff361bddfaf7098/cmd/debug/continue.go) 中的continue命令实现。

```go
package debug

import (
    "fmt"
    "os"

    "github.com/hitzhangjie/godbg/pkg/target"
    "github.com/spf13/cobra"
)

var continueCmd = &cobra.Command{
    Use:   "continue",
    Short: "运行到下个断点",
    Annotations: map[string]string{
        cmdGroupAnnotation: cmdGroupCtrlFlow,
    },
    Aliases: []string{"c"},
    RunE: func(cmd *cobra.Command, args []string) (err error) {
        dbp := target.DBPProcess

        // 获取当前停在断点处的线程
        bpStoppedThreads, err := dbp.ThreadStoppedAtBreakpoint()
        if err != nil {
            return fmt.Errorf("check thread breakpoints error: %v", err)
        }

        // 如果没有线程停在断点处，直接继续执行即可
        if len(bpStoppedThreads) == 0 {
            return dbp.Continue()
        }

        // 有线程停在断点处，恢复断点，rewind线程pc，singlestep后恢复断点
        bpCleared := make(map[uintptr]struct{})
        for tid, bpAddr := range bpStoppedThreads {
            fmt.Printf("Thread %d stopped at breakpoint %#x\n", tid, bpAddr)

            // - rewind线程pc
            regs, err := dbp.ReadRegister(tid)
            if err != nil {
                return fmt.Errorf("read register for thread %d: %v", tid, err)
            }
            regs.SetPC(regs.PC() - 1)
            if err = dbp.WriteRegister(tid, regs); err != nil {
                return fmt.Errorf("write register for thread %d: %v", tid, err)
            }

            // - 还原指令数据
            if _, cleared := bpCleared[bpAddr]; !cleared {
                _, err := dbp.RestoreInstruction(bpAddr)
                if err != nil && err != target.ErrBreakpointNotExisted {
                    return fmt.Errorf("clear breakpoint at %#x error: %v", bpAddr, err)
                }
                bpCleared[bpAddr] = struct{}{}
            }

            // - singlestep后，要恢复断点
            _, err = dbp.SingleStep(tid)
            if err != nil {
                return fmt.Errorf("single step for thread %d: %v", tid, err)
            }

            // - 重设断点
            if _, err := dbp.AddBreakpoint(bpAddr); err != nil {
                fmt.Fprintf(os.Stderr, "warning: failed to restore breakpoint at %#x: %v\n", bpAddr, err)
            } else {
                fmt.Printf("restored breakpoint at %#x\n", bpAddr)
            }
        }

        // 注意，这里是恢复所有tracee执行
        if err = dbp.Continue(); err != nil {
            return fmt.Errorf("continue error: %v", err)
        }
        fmt.Println("continue ok")

        return nil
    },
}

func init() {
    debugRootCmd.AddCommand(continueCmd)
}
```

上面逻辑比较清晰，首先找到所有因为断点暂停的线程列表，然后尝试恢复断点处指令，PC--，SINGLESTEP，重设断点，最后恢复所有tracee执行。接下来重点看下这里dbp.Continue()的实现。

```go
func (p *DebuggedProcess) Continue() error {
    // continue each thread
    for _, thread := range p.Threads {
        err := p.ExecPtrace(func() error {
            err := syscall.PtraceCont(thread.Tid, 0)
            if err == syscall.ESRCH {
                fmt.Fprintf(os.Stderr, "warn: thread %d exited\n", thread.Tid)
                return nil
            }
            return err
        })
        if err != nil {
            return fmt.Errorf("ptrace cont thread %d err: %v", thread.Tid, err)
        }
        fmt.Printf("thread %d continued succ\n", thread.Tid)
    }

    // wait any thread stopped
    wpid, status, err := p.wait(p.Process.Pid, syscall.WSTOPPED)
    if err != nil {
        return fmt.Errorf("wait error: %v", err)
    }
    fmt.Printf("thread %d status: %v\n", wpid, descStatus(status))
    fmt.Printf("stop all threads now\n")

    // if any thread stopped, then stop all threads again
    for _, thread := range p.Threads {
        if thread.Tid == wpid {
            continue
        }
        // 这里我们使用的是SINGLESTEP让线程执行一条指令后停下来，其实可以使用SIGSTOP代替，
        // delve中使用的是SIGSTOP的方式, see: `syscall.Tgkill(tgid, tid, syscall.SIGSTOP)`.
        //
        // 实际上ptrace singlestep的方式可以让线程更加快速地停下来，tgkill发送SIGSTOP的方式和SINGLESTEP有区别:
        // - SINGLESTEP方式会让线程执行一条指令后停下来；
        // - SIGSTOP方式，如果tracee当前在执行系统调用，会在系统调用返回后暂停；如果在用户态模式，会在执行下条用户指令前暂停；
        err := p.ExecPtrace(func() error { return syscall.PtraceSingleStep(thread.Tid) })
        if err != nil {
            if err == syscall.ESRCH {
                fmt.Fprintf(os.Stderr, "warn: thread %d exited\n", thread.Tid)
                continue
            }
            fmt.Fprintf(os.Stderr, "ptrace stop thread %d err: %v", thread.Tid, err)
        } else {
            fmt.Printf("thread %d stopped succ\n", thread.Tid)
        }
        go func() {
            _, status, err := p.wait(thread.Tid, syscall.WSTOPPED)
            if err != nil {
                fmt.Fprintf(os.Stderr, "wait error: %v", err)
            }
            fmt.Printf("thread %d status: %v\n", thread.Tid, descStatus(status))
        }()
    }
    return nil
}
```

这里的逻辑也比较清晰，首先恢复所有tracee执行，然后等待任意一个线程停止，如果任意一个线程停止，则停止所有线程，停止时我们有两种方式：

- `syscall.PtraceSingleStep(tid, signal)` 方式让线程执行一条指令后停下来；
- `syscall.tgkill(tgid, tid, SIGSTOP)` 方式，如果tracee当前在执行系统调用，会在系统调用返回后暂停；如果在用户态模式，会在执行下条用户指令前暂停；

### 测试验证

测试demo略，您可以自己写一个golang测试程序，并使用调试器godbg进行验证。

### 本节小结

本节主要探讨了多线程环境下continue命令的实现机制，核心内容包括：区分两种线程停止情景（断点停止和信号停止）并采用不同的恢复策略；通过PC回退、指令恢复、单步执行、断点重设、恢复执行的完整流程处理断点停止的线程；使用PTRACE_CONT恢复所有线程执行。并通过wait、All-stop Mode实现命中断点、收到信号后的暂停逻辑。暂停线程时我们也提及了两种可能的方式及其区别（ptrace SINGLESTEP和tgkill SIGSTOP）。

本节内容为读者理解调试器在多线程环境下的执行控制机制提供了重要的实践指导，为后续学习更复杂的调试功能奠定了基础。

