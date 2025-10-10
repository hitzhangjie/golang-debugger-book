## 线程执行控制 - 挂起策略

线程执行控制，指的是调试器会通过continue、step、breakpoint等命令来控制进程内线程的执行，前面我们介绍了这些命令的底层原理以及实现方式。但是这些对于多线程程序来说，还远远不够，我们还需要考虑多线程程序的特殊性，线程与线程之间的交互、调试人员对不同线程的观察等等，这就涉及到线程的挂起策略。

挂起策略（Suspend Policy），有时也叫 **Stop Mode** 或者 **Suspend Mode**。它描述的是当某个线程触发断点/异常/停止请求时，调试器应该暂停哪些线程，以及后续继续执行时，如何恢复这些线程的执行，属于线程执行控制（Thread Execution Control）的一部分。

本节我们来了解下在主流调试器中，有哪些挂起策略，以及是如何实现的。

### 何为挂起策略

在多线程调试器中，**Suspend Policy** 描述了 **“当某个线程触发断点/异常/停止请求时，调试器应该暂停哪些线程”** 的行为。
常见的两种策略：

| 策略 | 意义 | 对应的调试器命令 / 选项 |
|------|------|------------------------|
| **suspend-all**（全挂起） | 当任一线程 hit breakpoint，**所有**线程全部暂停；`continue` 时需要显式地把 *所有* 线程一起恢复。
| LLDB: `settings set target.suspend-policy all`  <br>GDB: `set scheduler-locking on`  <br>VS: “Suspend execution” → “All”
|
| **suspend-one**（单挂起） | 只有**触发断点的线程**被暂停；其它线程继续运行。`continue` 时默认只恢复触发断点的线程（或可用
`thread continue` 指定恢复单线程）。 | LLDB: `settings set target.suspend-policy one` <br>GDB: `set scheduler-locking step` (仅步
进时会暂停该线程) <br>VS: “Suspend execution” → “Just this thread” |

> **注意**：不同调试器的实现细节不同，但核心概念一致——**Suspend Policy**。

---

### 断点的挂起属性（Breakpoint‑Suspend Attribute）

在很多调试器里，单个断点本身也可以携带挂起属性：

| 断点属性 | 说明 | 例子 |
|----------|------|------|
| `suspend: true/false` | 是否在该断点处暂停（默认为 true） | GDB: `break *0x401000 suspend off` |
| `suspend: all/one` | 触发时采用的挂起策略（覆盖全局策略） | LLDB: `breakpoint set --file foo.c --line 42 --suspend one` |

> **全局** Suspend Policy 可以通过调试器的设置（如 LLDB 的 `target.suspend-policy`）一次性配置；**局部** 挂起属性则允许对单个断点
做更细粒度的控制。

---

### “全部恢复” vs “单线程恢复”

- **全部恢复**（`continue`）：在全挂起模式下，`continue` 会一次性恢复所有线程；在单挂起模式下，`continue` 仍会恢复**当前被暂停的
线程**，其它线程已在断点前继续运行，保持不变。
- **单线程恢复**（`thread continue` 或 `cont <thread-id>`）：显式指定恢复哪一个线程。该操作与 Suspend Policy 无关——不管是全挂起
还是单挂起，只要线程已被暂停，都可以通过该命令恢复。

---

### 调试协议层面的表述

在 GDB 的 Remote Serial Protocol（RSP）和 LLDB 的 Debug Adapter Protocol（DAP）里，这一概念被编码为 **`suspend-hint`** 或
**`stop-mode`**：

| 协议 | 字段 / 关键词 | 含义 |
|------|----------------|------|
| RSP  | `stop-sig` / `sig` | 触发的信号（与暂停无关） |
| DAP  | `stopOnEntry`, `stopOnTermination`, `stopOnLoad`, `stopMode` | `stopMode: "all" | "single"` |

这些字段在协议层面完成了与调试器实现层面的桥接。

---

### 本节小结

本节我们介绍了挂起策略（Suspend Policy）的概念，以及在主流调试器中是如何实现的。

- **核心术语**：**Suspend Policy（挂起策略）** 或 **Stop Mode**。
- **典型取值**：`all`（所有线程挂起）、`one`（仅挂起触发线程）。
- **调试器实现**：
  - LLDB：`settings set target.suspend-policy {all,one}`
  - GDB：`set scheduler-locking {on,off,step}`（`on` 对应全挂起）
  - VS：Breakpoints 属性 → “Suspend execution” → “All” / “Just this thread”

在调试多线程程序时，了解并适当配置 **Suspend Policy** 可以让你在断点停下时更精确地掌控线程的执行，既能保持全局可视性，也能在需要时保持其他线程的活跃。

接下来我们来看下在godbg中，该如何实现挂起策略，而且考虑go语言的GMP调度模型，以及M在其中所扮演的角色。
