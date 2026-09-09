## 扩展阅读：PTRACE_ATTACH的竞态问题与PTRACE_SEIZE

### 背景

本书第6.2节"跟踪进程"中，我们使用 `ptrace(PTRACE_ATTACH, pid, ...)` 来attach目标线程：内核向tracee注入一个SIGSTOP信号，tracee停下来之后，tracer再通过waitpid感知停止事件。这个"隐式注入SIGSTOP"的设计引入了一些竞态问题，man ptrace手册甚至将其中一个场景明确称为设计缺陷（design bug）：

> "a ptrace attach and a concurrently delivered SIGSTOP may race and the concurrent SIGSTOP may be lost"

内核从Linux 3.4开始提供了 `PTRACE_SEIZE`，attach时不再发送SIGSTOP，从根源上规避了这些问题。本节先描述这些竞态问题，再说明SEIZE是如何解决的。

### ATTACH引入的竞态问题

#### 问题1：SIGSTOP与外部信号合并丢失

attach注入的SIGSTOP，可能恰好与一个外部并发发送的SIGSTOP合并成同一次停止，waitpid只报告一次stop。调试器以为这是"attach的SIGSTOP"，在PTRACE_CONT时将其suppress掉（signal参数传0），结果外部那个SIGSTOP也被一起吞掉了：进程恢复执行，好像从来没有被停止过。

举例：某个监控脚本刚执行了 `kill -STOP <pid>` 想暂停进程，几乎同一时刻调试器attach了上来，调试器continue之后进程继续运行，监控侧就"丢失"了一次暂停。

真实调试器对此的补救做法，是所谓的"信号重注入协议"：停止后不盲目继续，而是将看到的信号重新注入（reinject）给tracee，直到看到SIGSTOP为止，再suppress掉SIGSTOP本身：

> "The usual practice is to reinject these signals until SIGSTOP is seen, then suppress SIGSTOP injection."

但这只是补救，要求调试器区分哪些停止是attach造成的、哪些是外部信号造成的，实现复杂且容易出错。本书示例为了聚焦核心调试原理，简化了这部分处理；dlv等真实调试器则实现了完整的信号重注入逻辑。

#### 问题2：stray EINTR

ATTACH注入的SIGSTOP会打断tracee正在执行的系统调用。调试器等待tracee停止后，通过PTRACE_CONT恢复执行并suppress掉SIGSTOP，此时被打断的系统调用会以 -1/EINTR 返回，而不是正常完成：

> "Since attaching sends SIGSTOP and the tracer usually suppresses it, this may cause a stray EINTR return from the currently executing system call in the tracee."

举例：tracee是一个服务器进程，正阻塞在 `read()` / `select()` 上等待socket数据，attach这一下就会让该系统调用提前返回EINTR。如果程序没有正确处理EINTR（真实世界中大量程序处理不当），attach本身就会改变程序行为，这与"调试器只观察不干预"的预期是冲突的。

#### 问题3：attach处于group-stop状态的tracee

如果tracee已经处于group-stop状态（比如在终端里按Ctrl-Z挂起了一个程序），再对其执行ATTACH：

1. tracee本来就停着，ATTACH的SIGSTOP不会再产生一次独立的停止；
2. waitpid报上来的stop是group-stop信号（`WSTOPSIG`返回SIGTSTP等），而不是SIGSTOP——调试器若不加以区分，会把这次停止误当成"attach成功"；
3. 调试器随后PTRACE_CONT恢复执行，man手册指出，从group-stop用PTRACE_CONT恢复会"effectively ignores the stopping signal and the tracee runs"，即进程直接逃出了Ctrl-Z的挂起状态，在后台继续运行，而shell还认为它是Stopped，出现输出与shell提示符交错等诡异现象（比如gdb遇到这种情况时会提示"Program received signal SIGTSTP"并询问用户如何处理，而不是盲目continue）；
4. 反过来，如果调试器不继续，后续的SIGCONT通知也不会经过tracer，同样麻烦。

### SEIZE如何解决这些问题

`PTRACE_SEIZE` 与ATTACH最大的区别在于：attach之后不会向tracee发送SIGSTOP，tracee也不会立即停止，调试器需要时再通过 `PTRACE_INTERRUPT`（Linux 3.4+）让其停下来。

- **没有隐式SIGSTOP**：问题1（信号合并丢失）、问题2（stray EINTR）从根源上消除——attach不会打断系统调用，也不存在被误吞的外部SIGSTOP；
- **停止事件来源清晰**：通过PTRACE_INTERRUPT产生的停止以 `PTRACE_EVENT_STOP` 上报（`status>>16 == PTRACE_EVENT_STOP`，`WSTOPSIG`返回SIGTRAP），与信号投递产生的停止（signal-delivery-stop）可以明确区分，调试器无需猜测"这次停止是谁造成的"；
- **group-stop场景可控**：seize的tracee处于group-stop时，同样以PTRACE_EVENT_STOP上报，且`WSTOPSIG`给出停止信号；调试器可以使用 `PTRACE_LISTEN` 让tracee保持"不执行但也不逃出group-stop"的状态，等待SIGCONT事件后再做决定，而不是被迫在"继续执行"和"错过SIGCONT通知"之间二选一。

因此，如果需要在attach后停止tracee，优先使用SEIZE + PTRACE_INTERRUPT的组合。strace等工具就优先使用PTRACE_SEIZE。当然，SEIZE要求Linux 3.4+，且INTERRUPT、LISTEN等配套命令只对seize的tracee生效，dlv等调试器出于历史兼容等原因仍然使用PTRACE_ATTACH，并配合完整的信号重注入协议来规避上述问题。

### 参考

- [man 2 ptrace](https://man7.org/linux/man-pages/man2/ptrace.2.html)，"Attaching and detaching"小节
