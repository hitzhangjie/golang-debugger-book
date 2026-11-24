## goroutine 逻辑切换与多线程调试

标题里有两件事，先划清边界。多线程跟踪（跟踪已创建/新建线程、all-stop 挂起策略、多线程 continue 与断点）在第 6 章 [6.18 调试多线程程序](../../6-develop-inst-debugger/18-multithread/README.md) 已完整实现，自动跟踪 clone 出来的线程见 [12.2 自动跟踪新线程](../../12-appendix/2-auto-trace-cloned-threads.md)，本节不重复。本节讲另一半：知道当前线程在跑哪个 goroutine、按 goid 或入口函数把它"选中"，让 `bt` / `print` / `list` 改用它的寄存器上下文。线程视角的 `threads` / `thread` 是 9.2.41。

"逻辑切换"要理解准确：godbgv2 不改变被调试进程的调度，也不会让某个 goroutine 真的跑起来，只改变调试器读取寄存器时"以谁为准"。所以选中一个挂起的 g 之后，你能看到它的调用栈，但 `continue` 仍然是恢复所有线程（all-stop）。

### 实现目标

命令只有 `goroutine`（别名 `gr`），两种用法：

```text
godbg> goroutine                 显示当前线程正在运行的 goroutine
current goroutine: 1 [_Grunning] runtime.main()

godbg> goroutine 2               按 goid 选中（逻辑切换）
switched to goroutine 2 [_Gwaiting] runtime.forcegchelper()

godbg> goroutine main.spinner    按入口函数名选中
switched to goroutine 34 [_Grunning] main.spinner()
```

选中之后，`bt`、`print`、`list` 改用该 goroutine 的寄存器上下文；`pregs` 仍打印当前线程的寄存器（它走 `ReadRegs(tid)`），`threads` 仍然列线程。选择器接受 goid 或入口函数名，后者更可靠——goid 会跳号、跨运行还会变（9.2.38）。

复位要小心：**没有 `goroutine -r`**。实测输入 `goroutine -r` 得到 `Error: unknown shorthand flag: 'r' in -r`。能复位的是线程选择 `thread -r`（输出 `reset to goroutine view`），但它只清 `selThread`；被选中的 goroutine（`selGoroutine`）**没有**对应的清除命令，只能重新选一个或结束会话。这条限制在 `pkg/proc/target.go:18` 能直接看到：`selGoroutine` 只有赋值、没有复位。

### 基础知识

#### g 在 TLS 里的固定槽位

每个线程的 `g` 指针放在 TLS 里。linux/amd64 上 go 运行时由 `runtime.settls` 设置 FS 基址（`runtime/sys_linux_amd64.s:642`）：`DI` 是 g 的地址，`ADDQ $8, DI`（注释 `ELF wants to use -8(FS)`）之后写进 `ARCH_SET_FS`，于是 `fs_base - 8` 正好是 g 指针所在槽位（`#define g(r) 0(r)(TLS*1)`，`go_tls.h`）。

读取有两条路径。`pregs` 的 `FsBase` 来自 `PTRACE_GETREGS`（`ReadRegs` → `RegsFromPtrace`，`pkg/target/registers_amd64.go:39`）；goroutine 定位不走整份寄存器快照，而是 `FSBase(tid)`（`pkg/target/ptrace_linux.go:162`）——用 `PTRACE_PEEKUSER` 读 user 区偏移 168 的 8 字节，那里正是 `struct user_regs_struct` 的 `fs_base`。代码注释说"fs_base 不在 PTRACE_GETREGS 的返回范围内"，这与 Go 的 `syscall.PtraceRegs` 实际字段（含 `Fs_base`）不符，但 PEEKUSER 路径本身是对的，读到的是同一个值。

#### g.sched：挂起时的寄存器快照

挂起的 g 没有线程可读，寄存器保存在 `g.sched`（类型 `runtime.gobuf`）里。`gobuf` 的关键字段是 `sp`、`pc`、`bp`，偏移同样来自 DWARF（go1.24 实测 `sp=0`、`pc=8`、`bp=48`；go1.25 起 `bp` 移到 40）。保存发生在 `mcall` 切到 g0 栈的时候（`gosave` 把 sp/pc/bp 写进 `g.sched`），恢复时由 `gogo` 读回。所以对挂起的 g，`sched.pc` 是"恢复后要执行的那条指令"——通常是 `mcall` 的返回地址，而不是 `gopark` 的调用点，`bt` 的 frame 0 会落在这个返回地址对应的源码行（实测 `runtime.gopark` 的收尾 `proc.go:436`）。合成寄存器上下文只需要三个值：`&syscall.PtraceRegs{Rip: g.pc, Rsp: g.sp, Rbp: g.bp}`——CFI 只需要 rip/rsp，帧指针只参与 DWARF 表达式，够 `bt` 用。

#### 运行中的 g：g.m → m.procid

运行中的 g 有线程，但调试器怎么知道是哪个线程？经 `g.m` 找到它所在的 M，再读 `m.procid`——运行时在 `minit` 里用 `getg().m.procid = uint64(gettid())`（`runtime/os_linux.go:404`，源码注释写着 "useful in debuggers"）写入，值就是 Linux 的 tid，和 `threads` 里列出的 tid 是同一个数。拿到 tid 后 `ReadRegister(tid)` 读到的就是该 g 的真实寄存器。

`procid` 不可用时还有一条兜底：遍历全部被跟踪线程，逐个读 `fs_base-8` 槽位的 g 指针与目标 `g` 的地址比对（TLS 路线）。两条路都失败时（比如 g 正被异步抢占、M 上此刻在跑 g0），才退回 `g.sched` 的近似值。

#### 两个选择状态与优先级

`Target` 上有两个选择状态（`pkg/proc/target.go:18`、`:19`）：`selGoroutine` 与 `selThread`。`Registers()` 的优先级是**线程 > goroutine > 当前事件线程**：`selThread` 非空直接读该线程寄存器；否则若 `selGoroutine` 非空，先 `threadOfGoroutine` 找线程读真实寄存器，找不到再用 `g.sched` 合成；都没选时读当前事件线程的寄存器。

这条语义与 delve 一致（`docs/CLEANROOM.md` 的"goroutine/thread 逻辑切换"条目已归因：选中后重定向寄存器上下文、线程选择优先）。它带来两个使用上的坑：先 `thread <tid>` 再 `goroutine <id>`，`bt` 仍走线程，因为 `SelectGoroutine` 不清 `selThread`；而 `thread -r` 之后 `selGoroutine` 还在，视角回到先前选中的 g。

### 代码实现

链路（每步后面是文件:行）：

```text
godbg> goroutine <sel>
 └─ cmd/debug/goroutine.go:31                                  命令层：Client.SwitchGoroutine
     └─ pkg/service/api/client.go:127 → pkg/service/debugger/debugger.go:592   契约 → 门面
         └─ pkg/proc/goroutines.go:261                         SelectGoroutine：按 goid/函数名选中
             └─ :155                                           allGoroutines：重新读一遍 allgs

godbg> bt
 └─ pkg/service/debugger/debugger.go:431 → pkg/proc/backtrace.go:30
     └─ pkg/proc/goroutines.go:300                              Registers：按选择状态取寄存器
         ├─ :329                                                threadOfGoroutine：g.m→m.procid / TLS
         └─ :222                                                CurrentGoroutine：fs_base-8 定位当前 g
```

#### 命令层

`cmd/debug/goroutine.go`（`RunE`，省略错误处理）：

```go
if len(args) == 0 {
    g, err := Client.CurrentGoroutine()
    fmt.Printf("current goroutine: %d [%s] %s()\n", g.ID, g.Status, g.Function)
    return nil
}
g, err := Client.SwitchGoroutine(args[0])
if err != nil {
    return err
}
fmt.Printf("switched to goroutine %d [%s] %s()\n", g.ID, g.Status, g.Function)
```

无参路径走 `CurrentGoroutine`（当前线程的 g，不改变选择），带参路径走 `SwitchGoroutine`（改变选择）。

#### 按 goid 或入口函数选中

`SelectGoroutine`（`pkg/proc/goroutines.go:261`）先重新读 allgs，再匹配（省略错误处理）：

```go
gs, err := t.allGoroutines()
if id, err := strconv.ParseInt(sel, 10, 64); err == nil {
    for _, g := range gs {
        if g.ID == id {
            t.selGoroutine = g
            return g, nil
        }
    }
    return nil, fmt.Errorf("goroutine %d not found", id)
}
for _, g := range gs {
    if fn, err := t.bi.FuncForPC(g.Entry); err == nil && fn.Name == sel {
        t.selGoroutine = g
        return g, nil
    }
}
return nil, fmt.Errorf("goroutine %q not found", sel)
```

两个细节：函数名匹配用的是 `startpc` 反查出来的入口函数，不是"当前所在函数"；同名入口（比如起了多个 `go worker()`）只会选中 allgs 里第一个匹配的，想选"第 N 个 worker"做不到。另外 `SelectGoroutine` 把那一刻的 `*Goroutine` 存进选择状态，g 之后若退出并复用，选中的仍是旧记录——这是它不如"选 goid"稳的地方。

#### 选中的 g 怎么变成寄存器

`Registers()`（`pkg/proc/goroutines.go:300`）是全部命令的公共入口，按上一节的优先级分派：

```go
if t.selThread != nil {
    return t.dbp.ReadRegister(t.selThread.Tid)
}
if t.selGoroutine != nil {
    if tid, ok := t.threadOfGoroutine(t.selGoroutine); ok {
        return t.dbp.ReadRegister(tid)
    }
    if t.selGoroutine.pc != 0 {
        return &syscall.PtraceRegs{
            Rip: t.selGoroutine.pc,
            Rsp: t.selGoroutine.sp,
            Rbp: t.selGoroutine.bp,
        }, nil
    }
}
```

（省略最后的默认分支：读当前事件线程。）为什么"先找线程、再退 sched"？因为运行中的 g 的 `sched` 是上一次被换下时留下的旧值，拿它合成会得到过期上下文；而挂起的 g 的 `m` 字段已被 `dropg` 清空，`threadOfGoroutine` 找不到线程，自然落到 `sched`。顺序本身就区分了两种状态。

#### 运行中的 g：procid 主路径 + TLS 兜底

`threadOfGoroutine`（`pkg/proc/goroutines.go:329`）先走 DWARF 路线：读 `g.m`，再读 `m.procid`，`procid` 必须是已跟踪的 tid：

```go
if f, err := t.goroutineLayout(); err == nil && f.mOff != 0 {
    if maddr, err := t.readUint(g.addr + f.mOff); err == nil && maddr != 0 {
        if procid, err := t.readUint(maddr + f.procidOff); err == nil && procid != 0 {
            if _, ok := t.dbp.Threads[int(procid)]; ok {
                return int(procid), true
            }
        }
    }
}
```

`mOff` / `procidOff` 来自 `goroutineLayout` 对 `runtime.g` 与 `runtime.m` 的 DWARF 解析（`m` 字段本身可能包多层指针，代码逐层剥）。procid 不可用时，才会遍历线程读 `fs_base-8` 做比对（TLS 路线）。

#### 当前 g：TLS 精确定位，状态兜底

`CurrentGoroutine`（`pkg/proc/goroutines.go:222`）先取当前线程 tid 与 `FSBase`，依次尝试 `fsbase-8` 和 `fsbase` 两个槽位，读出的 g 指针必须能在 allgs 里找到——这样才算"精确"：

```go
if fsbase, err := t.dbp.FSBase(tid); err == nil {
    for _, cand := range []uint64{fsbase - 8, fsbase} {
        if gaddr, err := t.readUint(cand); err == nil {
            for _, g := range gs {
                if g.addr == gaddr {
                    return g, nil
                }
            }
        }
    }
}
```

（`tid` 与 `gs` 来自前面的 `CurrentThreadTid` 与 `allGoroutines`。）TLS 读不到时，兜底是"取 allgs 里第一个状态为 2（`_Grunning`）的 g"。实测这个假设在多 M 场景下不成立：9.2.38 的 `goroutines` 输出里同时有两条 `_Grunning`（`runtime.main` 与 `main.spinner`），兜底可能挑错。所以 TLS 那条路才是"精确定位"，状态匹配只是近似。

### 执行测试

断在 `_fixtures/vars` 的 `main.go:28`。运行一（pid 2090917）：无参显示与"选中挂起的 runtime goroutine"。

```bash
$ ./godbg exec _fixtures/vars
process 2090917 launched, stopped by SIGTRAP
godbg> break main.go:28
breakpoint 1 added at 0x4b1b86 (…/examples/debuggee/vars/main.go:28)
godbg> continue
thread 2090917 status: stopped: trace/breakpoint trap
godbg> goroutine
current goroutine: 1 [_Grunning] runtime.main()
godbg> goroutine 2
switched to goroutine 2 [_Gwaiting] runtime.forcegchelper()
godbg> bt
0: runtime.gopark() …/src/runtime/proc.go:436 (pc: 0x470b11)
1: runtime.goparkunlock() …/src/runtime/proc.go:442 (pc: 0x440c85)
2: runtime.forcegchelper() …/src/runtime/proc.go:350 (pc: 0x440b75)
3: runtime.goexit() …/src/runtime/asm_amd64.s:1701 (pc: 0x4768a1)
backtrace: 4 frame(s)
```

`forcegchelper` 是 `_Gwaiting`，没有线程可读，栈完全来自 `g.sched` 合成的 rip/rsp；frame 0 停在哪一行、frame 1 是谁，都由 `sched.pc` 与 CFI 推出来。此时 `list` 也跟着切到 `proc.go:436`，`print arr` 则会报错：`variable "arr": variable "arr" has no location at pc 0x470b11`——变量定位用的是选中上下文的 PC（`EvalVariableAddr`→`Registers`），PC 落在 runtime 的编译单元，找不到 `main.arr` 的位置。切回 `goroutine 1` 再 `print arr`，恢复 `arr = [10 20 30] ([]int)`。

运行二（pid 2078844，goid 分配与运行一不同，spinner 这次是 34）：选中运行中的 goroutine，并用 `threads` 对照。

```bash
godbg> goroutine main.spinner
switched to goroutine 34 [_Grunning] main.spinner()
godbg> bt
0: main.spinner() …/examples/debuggee/vars/main.go:47 (pc: 0x4b1e06)
1: runtime.goexit() …/src/runtime/asm_amd64.s:1701 (pc: 0x4768a1)
backtrace: 2 frame(s)
godbg> threads
* Thread 2078844 at 0x4b1b87 main.main …/vars/main.go:28
  Thread 2078859 at 0x478097 runtime.usleep …/sys_linux_amd64.s:135
  Thread 2078860 at 0x4b1e06 main.spinner …/vars/main.go:47
  Thread 2078861 at 0x478663 runtime.futex …/sys_linux_amd64.s:558
```

`bt` 的 frame 0 是 `0x4b1e06`，`threads` 里 spinner 所在线程（2078860）也停在 `0x4b1e06`——两条命令对上了，说明 `g.m→m.procid` 找线程、读真实寄存器这条路是通的。另两条线程展示了 goroutine 视角的盲区：`runtime.usleep` 上跑的是 sysmon（它在独立 M 上循环，没有 g 形态），`runtime.futex` 是空闲 M 在等待调度；这两个位置在 `goroutines` 列表里找不到对应项。这类活动要靠 `threads`/`thread`（9.2.41）观察，机制见 6.18 与 12.2。

运行三（pid 2121311，这一次 goid 是 1～6）：选中态与"当前"是两回事。

```bash
godbg> goroutine main.spinner
switched to goroutine 6 [_Grunning] main.spinner()
godbg> goroutines
* goroutine 1: [_Grunning] runtime.main()
  goroutine 2: [_Gwaiting] runtime.forcegchelper()
  …
  goroutine 6: [_Grunning] main.spinner()
total 6 goroutine(s)
godbg> goroutine
current goroutine: 1 [_Grunning] runtime.main()
```

`*` 标的是事件线程正在跑的 g（1），不是选中的 6；`goroutine` 无参也只报当前线程的 g。选中态没有出现在任何列表里，这是当前实现的一个可见性缺口。

最后是复位，两个操作各跑一次：

```bash
godbg> goroutine -r
Error: unknown shorthand flag: 'r' in -r
godbg> thread -r
reset to goroutine view
```

### 本节小结

`goroutine` 的链路是"定位 → 选择 → 换上下文"：无参时用 `fs_base-8` 读当前线程的 g（失败退回 `_Grunning` 状态匹配）；带参时用 goid 或 `startpc` 反查的函数名在 allgs 里选中；之后 `bt`/`print`/`list` 经 `Registers()` 取寄存器——线程选择优先，其次选中 goroutine（运行中的经 `g.m→m.procid` 读真实寄存器，挂起的用 `g.sched` 合成），最后才是事件线程。

边界与已知问题：

- **只能读，不能切执行权**：逻辑切换只改调试器视角，`continue`/`step` 不按 goroutine 调度；要"让某个 g 恢复执行"得修改目标线程寄存器与调度状态，godbgv2 没有做。`cmd/debug/goroutine.go` 帮助里"运行在其他 M 上的 goroutine 需切换当前线程，教学版暂未实现"说的是这件事——跨 M 读寄存器已经实现（实测 spinner），跨 M 切执行没有；
- **没有 `goroutine -r`**：`selGoroutine` 无法清除；`thread -r` 只清 `selThread`，goroutine 选中态保留；
- **抢占窗口会近似**：g 正被异步抢占、M 上跑的是 g0 时，procid 仍指该线程但读到的是 g0 的寄存器；代码的兜底是用 `g.sched` 近似，`bt` 可能得到过期的一帧；
- **同名入口只选第一个**：多个 goroutine 共用一个入口函数时无法指定具体哪一个；
- **变量求值跟着上下文走**：选中 runtime 的 g 之后 `print` 用户包的全局变量会失败（PC 不在该编译单元），要先切回用户 goroutine；
- **状态名与过滤的旧账**：状态表沿用旧编号（9.2.38），`goroutines` 无过滤；`goroutine` 选中挂起的 g 后 `bt` 的帧数可能因停止点不同而在 1～2 帧间波动，属正常现象。
