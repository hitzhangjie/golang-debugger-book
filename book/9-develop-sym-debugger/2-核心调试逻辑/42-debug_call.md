## call：调试期函数调用

`print` 能在停止状态下查看变量，但有些值只有让目标程序自己算一遍才拿得到：`compute()` 在当前全局变量下的返回值、`add(1, 2)` 有没有溢出、某个辅助函数会走到哪条分支。`call` 就是让调试器在暂停的进程里临时执行一次函数调用，再把返回值打印出来。

### 实现目标

`godbg> call <func>(<args...>)`，例如 `call add(1, 2)`，输出 `> main.add(1, 2) = 3`。教学版的约定：

- 实参只支持整型字面量（可带负号、`0x` 十六进制），最多 9 个；第 10 个起需要走栈传参，没有实现。
- 函数名可省略包名：先按原名查符号，失败再补 `main.` 前缀重试一次。
- 只支持具名函数，不支持方法、闭包；返回值只取第一个整型（ABIInternal 的 RAX）。
- 调用在当前事件线程上执行。调用期间若命中用户断点，命令中止并恢复调用前的寄存器现场。
- 不做参数类型校验：实参一律按 `int64` 写进整型参数寄存器，被调函数若期望浮点或复合类型，会读到错误的值。

与 `print` 的分工要先说清楚：9.2.36 的表达式求值**明确不支持函数调用**（`pkg/proc/eval.go` 的能力清单），`call` 不是求值器的扩展，而是执行控制命令——它改变目标线程的 RIP/RSP 并让它真的跑起来，和 `continue`、`step` 同组。

### 基础知识

#### 在停止的进程里"调用"意味着什么

调试器停下来时，被调试进程的所有线程都在 ptrace 的停止状态，没有任何代码在执行。要"调用"一个函数，必须借一个真实线程：把实参放到被调函数能读到的地方，把 RIP 指向函数入口，然后让它跑；跑完之后还得让调试器重新拿到控制权。正常调用靠 `CALL` 指令压入返回地址，这里没有 `CALL`，只能手工合成一个调用帧。

#### GDB dummy frame 与 magic 返回地址

GDB 的 `call` 用 **dummy frame**：在目标栈上伪造一个调用帧，返回地址写成一个永远不该被执行的哨兵。被调函数执行 `RET` 时弹出这个地址，取指立刻出错，调试器由此判断"函数返回了"。godbgv2 采用同一思路——`docs/CLEANROOM.md` 把 `pkg/proc/call.go` 的"合成栈帧调试期调用"归因为 GDB dummy frame（不是 delve 的做法）。

哨兵取 `0xdead`（`pkg/proc/call.go:116`）：

```go
const callReturnMagic = 0xdead
```

它小于默认的 `mmap_min_addr`（本机 `/proc/sys/vm/mmap_min_addr` 为 65536），处于用户态无法映射的区域，任何取指都会触发 SIGSEGV；GDB 常用 0 作哨兵，这里换成更容易在日志里认出的魔数。注意这是一个环境假设：如果系统把 `mmap_min_addr` 设为 0，并且恰好有人映射了 `0xdead`，哨兵就不再可靠。

合成帧的构造在 `pkg/proc/call.go:69`：

```go
	// 合成栈帧：16 字节对齐的调用点下方压入 magic 返回地址。
	// 对齐后 RSP%16==8，与真实 CALL 指令执行后的一致。
	sp := (saved.Rsp &^ 0xf) - 8
	if err := t.writeUint(sp, callReturnMagic); err != nil {
		return "", 0, fmt.Errorf("call %s: write return address: %v", name, err)
	}
```

`Rsp &^ 0xf` 把栈指针向下对齐到 16 字节，再减 8，于是 `sp%16==8`；真实 `CALL` 把 8 字节返回地址压到 16 字节对齐的栈顶后，入口 `rsp` 也满足这个余数。被调函数的序言会继续在自己的栈帧上压栈，`RET` 时恰好弹出 `[sp]` 里的 `0xdead`。

#### SIGSEGV 为什么不会打到运行时

被调试进程执行到 `0xdead` 时，CPU 取指触发页错误，内核把线程停在 signal-delivery-stop，通过 `wait4` 通知 tracer；此时信号还**没有**投递给进程。`Continue`（`pkg/target/continue.go:17`）只对 SIGURG、SIGSTOP、SIGCONT 做特殊区分，SIGSEGV 落到最后的"真正的停止事件"分支（`continue.go:211`），被记录成 `stopped: segmentation fault` 后返回。

关键在于 tracer 从不调用 `PtraceCont(pid, SIGSEGV)`：信号被抑制，go 运行时的信号处理器没有机会执行。随后 `Call` 把 RIP/RSP 改回调用前的位置，故障指令也不会被重试。作为反证，如果 SIGSEGV 真的进了进程，go 会打印 `unexpected fault address 0xdead` 并以 fatal error 退出；实测中程序继续正常运行。

#### ABIInternal 的整型参数寄存器

go1.17+ 在 amd64 上使用 ABIInternal：前 9 个整型参数依次占用 RAX、RBX、RCX、RDI、RSI、R8、R9、R10、R11，第 10 个起走栈；第一个整型返回值放在 RAX。9 个就是寄存器能覆盖的上限，因此 `call` 的参数上限是 9。

浮点参数走 XMM 寄存器；`string` 要两个寄存器（指针加长度），切片要三个（指针、长度、容量），结构体可能被拆到多个寄存器或栈上。教学版不实现类型布局，所以只接受整型字面量，并把每个参数按 `uint64` 原样写入对应寄存器；参数个数对、但函数签名不是整型时，行为和直接乱传寄存器一样不可预期。

### 代码实现

链路（冒号后是文件行号）：

```text
godbg> call add(1, 2)
 └─ cmd/debug/call.go:48                    命令层：拼接参数 → Client.Call → 打印结果
     └─ pkg/service/api/client.go:132 → pkg/service/debugger/debugger.go:684   契约 → 门面
         └─ pkg/proc/call.go:33             Target.Call：保存现场 → 合成栈帧 → 写寄存器 → continue → 读 RAX → 恢复
             ├─ pkg/target/registers_amd64.go:10/22   ReadRegister / WriteRegister
             ├─ pkg/target/memory.go:30                WriteMemory（写 magic 返回地址）
             └─ pkg/target/continue.go:17              Continue（SIGSEGV 在此被拦截）
```

#### 1. 命令层

`cmd/debug/call.go:39` 先把 shell 按空格切开的参数重新拼成一行（`call add(1, 2)` 的行内空格会被保留），交给 `parseCall` 解析，再调 `Client.Call(name, callArgs)`。`parseCall` 用一条正则把"函数名 + 括号内实参"分开（`call.go:68`），实参按 `ParseInt(tok, 0, 64)` 解析，因此 `-5`、`0x10` 都合法；空括号和省略括号（`call compute`）等价于无参调用：

```go
	args := []int64{}
	if strings.TrimSpace(argstr) != "" {
		for _, tok := range strings.Split(argstr, ",") {
			tok = strings.TrimSpace(tok)
			v, err := strconv.ParseInt(tok, 0, 64)
			if err != nil {
				return "", nil, fmt.Errorf("call: invalid argument %q (integer expected)", tok)
			}
			args = append(args, v)
		}
	}
	return name, args, nil
```

打印前把 `int64` 实参重新格式化成十进制，所以 `call add(0x10, 2)` 显示为 `> main.add(16, 2) = 18`——回显的是解析后的值，不是原始输入。

#### 2. 契约、门面与结果类型

接口在 `pkg/service/api/client.go:132`：`Call(name string, args []int64) (*CallResult, error)`。`CallResult` 只有两个字段（`pkg/service/api/types.go:151`）：`Name` 是解析出的完整函数名，`Value` 是整型返回值。门面 `Debugger.Call`（`pkg/service/debugger/debugger.go:684`）判空后转调 `d.t.Call`，再把 `(name, ret)` 包成 `api.CallResult`；命令层负责拼接和打印，不参与寄存器与栈的操作。

#### 3. 保存现场与符号解析

参数个数检查之后，`Target.Call` 先做符号解析（`pkg/proc/call.go:38`，节选）：

```go
	// 符号解析：精确名优先，未限定包名补 main 前缀重试
	fn, err := t.bi.FindFunction(name)
	if err != nil {
		if fn2, err2 := t.bi.FindFunction("main." + name); err2 == nil {
			fn, err = fn2, nil
		}
	}
	if err != nil {
		return "", 0, fmt.Errorf("call %s: %v", name, err)
	}
```

`FindFunction` 经 gosym 的函数表查找，再从 DWARF 补声明位置（9.2.32）。先按原名查、失败才补 `main.` 前缀，因此直接写 `runtime.GC` 能用，而 `add` 这类短名会落进重试分支。随后取当前事件线程、读出完整 `syscall.PtraceRegs` 作为 `saved`（`call.go:50`）。从这之后的所有错误路径都走同一个 `fail` 闭包（`call.go:60`），它把 `saved` 写回线程再返回错误，保证"调用失败也不会把线程留在半截状态"。

#### 4. 合成栈帧与寄存器传参

写 magic、改 RIP/RSP、填参数寄存器（`call.go:67`）：

```go
	// 合成栈帧：16 字节对齐的调用点下方压入 magic 返回地址。
	// 对齐后 RSP%16==8，与真实 CALL 指令执行后的一致。
	sp := (saved.Rsp &^ 0xf) - 8
	if err := t.writeUint(sp, callReturnMagic); err != nil {
		return "", 0, fmt.Errorf("call %s: write return address: %v", name, err)
	}

	// 修改寄存器：RIP→函数入口，RSP→合成栈帧，实参按
	// ABIInternal 约定写入寄存器
	regs := *saved
	regs.Rip = fn.Entry
	regs.Rsp = sp
	for i, a := range args {
		setABIArgReg(&regs, i, uint64(a))
	}
	if err := t.dbp.WriteRegister(tid, &regs); err != nil {
		return fail(fmt.Errorf("call %s: write registers: %v", name, err))
	}
```

`regs := *saved` 是值拷贝，`saved` 保持调用前的快照不变；`WriteRegister` 一次写回整套寄存器，避免逐项写之间的中间状态。`setABIArgReg`（`call.go:124`）按 `abiInternalArgRegs` 的顺序 switch 到 `Rax`、`Rbx`、`Rcx`、`Rdi`、`Rsi`、`R8`、`R9`、`R10`、`R11`；`writeUint`（`call.go:148`）把 8 字节小端值经目标层的 `WriteMemory` 写到 `sp`。`abiInternalArgRegs` 是"最多 9 个"这个限制的唯一来源（`call.go:121`）：

```go
var abiInternalArgRegs = [...]string{"RAX", "RBX", "RCX", "RDI", "RSI", "R8", "R9", "R10", "R11"}
```

#### 5. continue、识别返回、恢复现场

写好寄存器后，让线程跑（`call.go:87`）：

```go
	// 恢复执行，等待函数返回（magic 地址 SIGSEGV）或其他停止
	stop, err := t.dbp.Continue()
	if err != nil {
		return fail(err)
	}
	stopRegs, err := t.dbp.ReadRegister(stop.PID)
	if err != nil {
		return fail(fmt.Errorf("call %s: read stop registers: %v", name, err))
	}

	// 停在 magic 返回地址：调用完成，RAX 中是返回值
	if stopRegs.PC() != callReturnMagic {
		return fail(fmt.Errorf("call %s aborted: thread %d stopped at %#x (%s)",
			name, stop.PID, stopRegs.PC(), stop.Reason))
	}
	ret := int64(stopRegs.Rax)

	// 恢复调用前的寄存器现场
	if err := t.dbp.WriteRegister(tid, saved); err != nil {
		return "", 0, fmt.Errorf("call %s: restore registers: %v", name, err)
	}
	return fn.Name, ret, nil
```

判断"调用完成"的唯一依据是停止线程的 PC 等于 `0xdead`。如果停在别处，说明调用没走完（命中了用户断点、收到信号、进程退出等），`fail` 恢复现场并把停止地址和原因拼进错误。实测在 `main.add` 下断点后执行 `call add(1, 2)`，得到 `Error: call add aborted: thread ... stopped at 0x4b1e21 (stopped: trace/breakpoint trap)`——`0x4b1e21` 正是 `main.add` 入口 `0x4b1e20` 被 `int3` 命中后的 PC；命令失败但线程回到了调用点。

### 执行测试

测试对象仍是 `examples/debuggee/vars`：`main.add` 的声明在 `main.go:55`、函数体是 `return a + b`；`main.compute` 的声明在 `main.go:39`、函数体是 `arr[0] + pt.X`。`main.main` 的循环头在 `main.go:28`，`Println` 在 `main.go:30`；`main.go:33` 的空白赋值调用保证 `add` 不被链接器丢弃。路径前缀省略为 `…/`：

```bash
$ ./godbg exec _fixtures/vars
process 2172838 launched, stopped by SIGTRAP
godbg> break main.go:28
breakpoint 1 added at 0x4b1b86 (…/examples/debuggee/vars/main.go:28)
godbg> continue
thread 2172838 status: stopped: trace/breakpoint trap
> …/examples/debuggee/vars/main.go:28 (pc: 0x4b1b87)
stop all threads now
continue ok
godbg> call add(1, 2)
> main.add(1, 2) = 3
godbg> call add(-5, 8)
> main.add(-5, 8) = 3
godbg> call compute()
> main.compute() = 11
godbg> bt
0: main.main() …/examples/debuggee/vars/main.go:28 (pc: 0x4b1b87)
1: runtime.main() …/src/runtime/proc.go:293 (pc: 0x440827)
2: runtime.goexit() …/src/runtime/asm_amd64.s:1701 (pc: 0x4768a1)
backtrace: 3 frame(s)
godbg> break main.go:30
breakpoint 2 added at 0x4b1b88 (…/examples/debuggee/vars/main.go:30)
godbg> continue
thread 2172838 stopped at breakpoint 0x4b1b86
restored breakpoint at 0x4b1b86
thread 2172838 status: stopped: trace/breakpoint trap
> …/examples/debuggee/vars/main.go:30 (pc: 0x4b1b89)
stop all threads now
continue ok
```

三个调用都能对上 `main.add` 的实现：它的反汇编在 `0x4b1e3a` 是 `add %rbx,%rax`，即第一个参数（RAX）加第二个参数（RBX），结果留在 RAX。`call add(1, 2)` 得 3；`call add(-5, 8)` 把 `-5` 的 int64 补码写进 RAX，也得 3；`compute()` 返回 11 是因为 `arr[0]` 为 10、`pt.X` 为 1——它读的是目标进程当前内存里的全局变量，不是调试器侧的模拟值。

寄存器现场确实恢复了。同一次实验里在三次调用前后各执行一次 `pregs`，摘录几项：

| 寄存器 | 调用前 | 三个 `call` 之后 |
|---|---|---|
| RIP | 0x4b1b87 | 0x4b1b87 |
| RSP | 0xc000186ea0 | 0xc000186ea0 |
| RAX | 0xc000004380 | 0xc000004380 |
| RBX | 0x571760 | 0x571760 |
| R12 | 0x7ffdd73f2ec0 | 0x7ffdd73f2ec0 |

RAX 里的 `0xc000004380` 是调用前就有的原有值，不是某次调用的返回值；它能原样保留，说明保存/恢复覆盖了整套通用寄存器，而不只是 RIP/RSP。之后 `break main.go:30` 再 `continue` 能正常停到 `Println` 行，也说明 SIGSEGV 没有把进程打死、`0xdead` 的栈槽没有破坏主流程。

本序列已固化为冒烟脚本：`bash scripts/smoke.sh ch9.2.42` 以 `smoke: all passed` 结束（脚本断言三次调用的输出、`bt` 的 frame 0，以及最后停在 `main.go:30`）。

### 本节小结

`call` 的完整链条是五步：保存当前事件线程的整套寄存器；在当前 `rsp` 向下对齐再减 8 的位置写入 magic 返回地址 `0xdead`，合成一个假的调用帧；按 ABIInternal 把整型实参写进 9 个参数寄存器，令 RIP 指向函数入口；`continue` 让函数真正执行，`RET` 跳到 `0xdead` 触发 SIGSEGV，被 ptrace 拦截、不投递给运行时；确认停止 PC 是 `0xdead` 后读 RAX 得返回值，再写回保存的寄存器。它借的是 GDB dummy frame 的思路（`CLEANROOM.md` 已归因），不是 delve 的实现。

边界与已知限制：

- 实参只支持整型字面量、最多 9 个；浮点、字符串、切片、结构体参数都不支持，且不做函数签名校验，传错类型的结果不可预期。
- 只支持具名函数：方法没有接收者可用，闭包缺少上下文；被内联或死代码消除的函数在符号表里找不到。
- 返回值只取第一个整型（RAX）；多返回值、浮点/复合返回值不读，输出也不做类型转换。
- 调用只走当前事件线程；挂起的 goroutine 不能直接执行代码，要先切到运行它的线程（9.2.40/9.2.41 的选择在这里不起作用，`Call` 只认 `CurrentThreadTid`）。
- 被调函数不能触碰调度器：阻塞（channel、mutex、sleep）或创建 goroutine 会让当前 g 离开线程，合成帧不再成立；栈增长（morestack）会复制并改写栈，合成的返回地址槽随之失效；panic 未 recover 会直接终止进程。
- 调用期间不设超时，函数不返回时命令一直等；调用期间命中用户断点会中止并恢复寄存器（见上文实测），但被调函数已经产生的内存副作用不会撤销。
- magic 地址依赖 `mmap_min_addr` 的默认值；`0xdead` 若被映射，哨兵失效。

`call` 也是 9.2 执行控制部分的收尾：`continue` 提供"跑起来"，`step`/`stepout` 提供"停在哪"，`call` 则在暂停的进程里借一段时间执行用户指定的代码，然后原样退回。三者的共同底座是 9.2.31 的寄存器读写与 9.2.34 的栈/CFA 认知。
