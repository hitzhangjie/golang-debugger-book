## watchpoint

watch 监视某个内存地址的读、写访问：程序访问这块内存时停下来，把控制权交回调试器。它和断点不是一套机制——断点替换指令首字节（`0xCC`），watch 用 CPU 的调试寄存器（Debug Registers），是名副其实的"硬件断点"。

godbgv2 的 `watch` 只接受**地址**，不接表达式或变量名：`watch [-r|-w|-rw] <addr>`。本节从命令层往下走一遍 `cmd` → `api` → `target`，讲清 DR0-DR3/DR6/DR7 的用法、命中检测，以及这套实现的边界。

### 实现目标 `watch [-r|-w|-rw] <addr>`

会话内的真实输出：

```text
godbg> help watch
设置硬件监视点

watch [-r|-w|-rw] <addr>
  -h, --help   help for watch
  -r, --r      读取时停止
      --rw     读取或写入时停止（默认）
  -w, --w      写入时停止
```

参数只有一个，且必须能被 `strconv.ParseUint` 解析成地址（十进制、`0x`、`0` 前缀，`cmd/debug/address.go:12`）。写 `watch -w main.counter` 只会得到 `invalid address: ...`：变量名到地址的解析依赖 ch9.2.33 的 DWARF 变量定位链路，`cmd/debug/watch.go:12-13` 的注释写明了这个约定。x86 的数据断点只有"写"和"读写"两种。RWn=`0b10` 是 I/O 端口访问，不是内存读；硬件没有"只读内存"这一档，所以 `-r` 被降级成 `readwrite`（`pkg/service/debugger/debugger.go:198-206`）。

能力边界先摆在这里，后文逐条展开：只接受地址（没有表达式、变量名）；DR7 的 LENn 写死 `0b11`（4 字节窗口），没有 size 参数；不支持只读监视，`-r` 按 `-rw` 处理；最多 4 个（DR0-DR3），第 5 个报 `no free debug register`；栈变量无特殊处理，栈扩容后静默失效；没有列出/清除命令，`breakpoints` 也不列监视点；部分受限内核拒绝写调试寄存器（EIO），见"执行测试"。

### 基础知识

#### 1. 硬件断点与调试寄存器

x86_64 给每个线程 8 个调试寄存器，其中 4 个能装地址：

- **DR0-DR3**：监视地址，一个槽位一个地址；
- **DR7**：配置寄存器，逐槽位指定触发条件（RWn）和监视长度（LENn），并逐槽位使能；
- **DR6**：状态寄存器，命中后由 CPU 置位 B0-B3，告诉调试器是哪个槽位命中的。

DR7 的字段分布（n = 0..3）：L0-L3 在 bit 0/2/4/6（局部使能，每槽一位），G0-G3 在 bit 1/3/5/7（全局使能，调试器一般不用），RW0-RW3 在 bit 16+4n、17+4n，LEN0-LEN3 在 bit 18+4n、19+4n。

两段编码要记准，后文判断"窗口多大"全靠它：

- RWn：`00` 执行、`01` 写、`11` 读写、`10` I/O 端口；LENn：`00` 1 字节、`01` 2 字节、**`10` 8 字节**、`11` 4 字节。

注意 LENn 的 `0b10` 才是 8 字节，`0b11` 是 4 字节——顺序不按大小排，这是最容易写错的一处。

还有两个和"停在哪"有关的事实。其一，DR6 是状态不是配置，判断完**必须清零**，否则恢复执行后会立刻再次触发同一个命中，程序再也跑不动。其二，数据断点产生的是 #DB，属于 **trap**：触发访问的那条指令已经执行完，PC 指向它的下一条指令，所以停下来时内存里已经是新值。这和断点命中时"PC 停在 `0xCC` 之后、要回退 1 字节"正好相反。

#### 2. 监视点与断点的分工

监视点盯"数据被谁动过"，断点盯"执行到哪"：前者靠调试寄存器，零运行时开销但硬件只给 4 个；后者靠 `0xCC` 替换指令，数量不受限但每次执行到都要陷入一次。两者的触发条件（内存访问 vs 指令执行）和精度（固定窗口 vs 精确地址）也因此不同。

在 godbgv2 里两者完全独立：监视点不进逻辑断点表，没有编号、没有条件、没有命中计数，不参与 `breakpoints`/`clear`/`clearall`。

#### 3. 为什么监视栈变量会失效

Go 的 goroutine 栈按需增长：空间不够时 runtime 分配更大的栈，把旧栈内容整块复制过去（`runtime.copystack`），再让 goroutine 在新栈上继续。这对硬件监视点是双重打击：

1. **读监视会被运行时污染**——复制过程要读整块旧栈，这不是程序逻辑里的读，命中毫无意义；
2. **地址会搬家**——监视点绑定的是绝对地址，栈搬走后原地址不再被访问，监视点从此静默失效：不报错，也不再命中。

delve 的裁剪版 tinydbg 曾为此加过一层补偿：在 `runtime.copystack` 的返回地址下哨兵断点，命中时按 goroutine 新的栈顶重算监视地址。godbgv2 没有这层处理——`SetWatchpoint` 收到的就是一个地址，它既不知道这个地址是否落在栈上，也不会跟着栈搬家。实用建议是监视**全局变量或堆上变量**，地址在进程生命周期内不变；栈变量要等变量定位（ch9.2.33）与栈修正一起做。

#### 4. 调试寄存器怎么读写

Linux 下调试寄存器不在通用寄存器集合里，只能走 ptrace 的 user 区域：

```go
// pkg/target/hwbreakpoint.go:26-32
const (
	ptracePeekUser = 3   // PTRACE_PEEKUSER
	ptracePokeUser = 6   // PTRACE_POKEUSER
)

const debugRegOffset = 848 // struct user 中 u_debugreg 的偏移
```

`3`/`6` 是 `PTRACE_PEEKUSER`/`PTRACE_POKEUSER` 的请求码，不是 `0x4203`（SETSIGINFO）那类扩展；Go 的 `syscall` 包没有导出这两个常量，只能用 `syscall.Syscall6(syscall.SYS_PTRACE, ...)` 直接发。偏移 848 来自 `struct user` 布局：`u_debugreg[8]` 紧跟在 32 字节的 `u_comm` 之后，第 n 个寄存器的地址是 `debugRegOffset + n*8`。

调试寄存器是**线程级**状态，不是进程级：设置时逐个线程写（`SetWatchpoint` 遍历 `p.Threads`），检查命中时只能看当前停止线程的 DR6。

### 代码实现

#### 1. 命令层：`cmd/debug/watch.go`

```go
	RunE: func(cmd *cobra.Command, args []string) error {
		if len(args) != 1 {
			return errors.New("usage: watch [-r|-w|-rw] <addr>")
		}

		mode := "readwrite"
		r, _ := cmd.Flags().GetBool("r")
		w, _ := cmd.Flags().GetBool("w")
		rw, _ := cmd.Flags().GetBool("rw")
		switch {
		case rw:
			mode = "readwrite"
		case w:
			mode = "write"
		case r:
			mode = "read"
		}

		addr, err := parseAddress(args[0])   // 失败 → invalid address
		...
		wp, err := Client.Watch(addr, mode)
		...
		fmt.Printf("watchpoint %d set at %#x (%s)\n", wp.Slot, wp.Addr, wp.Mode)
		return nil
	},
```

命令层只做三件事：校验参数个数、把 flag 折成三种模式字符串、把地址交给 `Client.Watch`。三个 flag 的优先级是 `rw` > `w` > `r`，所以同时给 `-r -w` 时结果是 `write`。`-r` 在这里仍拼出 `"read"`，降级发生在下一层——命令层不替后端决定"能不能只读"。

#### 2. 服务层：`pkg/service/debugger/debugger.go`

```go
	var m target.WatchMode
	switch mode {
	case "write":
		m = target.WatchWrite
	case "read", "readwrite":
		// x86 不支持只读监视，read 按 readwrite 处理
		m = target.WatchReadWrite
	default:
		return nil, fmt.Errorf("invalid watch mode %q (want write/read/readwrite)", mode)
	}
	wp, err := d.t.DebuggedProcess().SetWatchpoint(uintptr(addr), m)
	...
	return &api.Watchpoint{Slot: wp.Slot, Addr: uint64(wp.Addr), Mode: wp.Mode.String()}, nil
```

两点值得记。字符串到 `target.WatchMode` 的映射只发生在服务端，`api.Watchpoint.Mode` 回传的是 `WatchMode.String()`，所以用户只可能看到 `write`/`readwrite`/`execute`，**永远看不到 `read`**——这正是 `-r` 被降级的可观察证据。另一头，watch 完全绕开 `proc.Target` 的逻辑断点层：不经 `CreateBreakpoint`，不分配断点编号，也不进 `Target.bps`；所以 `breakpoints` 列不出监视点，`clearall` 也清不掉它。

#### 3. 目标层：设置监视点

```go
func (p *DebuggedProcess) SetWatchpoint(addr uintptr, mode WatchMode) (*Watchpoint, error) {
	slot, ok := p.freeWatchSlot()
	if !ok {
		return nil, fmt.Errorf("no free debug register (DR0-DR3 all in use)")
	}

	// DR7 是全部槽位共享的控制寄存器：基于当前值修改对应槽位字段，
	// 直接覆盖会破坏其余监视点
	dr7, err := p.currentDR7()
	...
	dr7 |= 1 << (slot * 2)                // 局部使能 Ln
	dr7 |= uint64(mode) << (16 + slot*4)  // RWn
	dr7 |= 0b11 << (18 + slot*4)          // LENn：8 字节

	for _, thread := range p.Threads {
		// 先写地址 DRn，再写控制字 DR7（错误处理省略）
		if err := p.setDebugRegister(thread.Tid, slot, uint64(addr)); err != nil {
			// ...
		}
		if err := p.setDebugRegister(thread.Tid, 7, dr7); err != nil {
			// ...
		}
	}
	return &Watchpoint{Slot: slot, Addr: addr, Mode: mode}, nil
}
```

五步：`freeWatchSlot()` 读 DR7 看 L0-L3 哪一位是 0（`hwbreakpoint.go:150-162`），全满就报 `no free debug register`——判空槽只看使能位、不看槽位里残留的地址，所以清掉的槽位不会被回收；`currentDR7()` 从任一已跟踪线程读 DR7，因为配置对所有线程一致（`:165-170`）；在位图上置 Ln、填 RWn、填 LENn，必须"读-改-写"，否则会抹掉别的监视点；逐线程 `PTRACE_POKEUSER` 写 DRn 和 DR7，内核拒绝时把 `EIO` 翻译成 `hardware watchpoint not supported by kernel`；最后返回 `Watchpoint{Slot, Addr, Mode}` 供回显。

`dr7 |= 0b11 << (18 + slot*4)` 这一行是本节最需要留意的：源码注释写"LENn：8 字节"，但按 Intel 的编码 `0b11` 是 **4 字节**（8 字节要写 `0b10`）。这决定了实际监视窗口的大小，后文用实验确认窗口是 4 字节。准确的说法是：**godbgv2 固定写一个 4 字节窗口，注释里的"8 字节"是错的**。

#### 4. 目标层：命中检测

```go
func (p *DebuggedProcess) TriggeredWatchpoint(tid int) (*Watchpoint, error) {
	dr6, err := p.getDebugRegister(tid, 6)
	...
	dr6 &= 0xf // 只关心 B0-B3
	if dr6 == 0 {
		return nil, nil
	}
	slot := 0
	for dr6&1 == 0 { // 最低置位位 = 命中槽位
		dr6 >>= 1
		slot++
	}
	wp := &Watchpoint{Slot: slot}

	// 从 DR7 中还原读写类型，从 DRn 中还原地址
	dr7, err := p.getDebugRegister(tid, 7)
	...
	wp.Mode = WatchMode((dr7 >> (16 + slot*4)) & 0x3)
	addr, err := p.getDebugRegister(tid, slot)
	...
	wp.Addr = uintptr(addr)

	// 命中后清零 DR6：否则线程恢复执行后会立即再次触发
	if err := p.setDebugRegister(tid, 6, 0); err != nil {
		return nil, fmt.Errorf("clear DR6: %v", err)
	}
	return wp, nil
}
```

四个实现选择：

- 只取 `dr6 & 0xf`：B0-B3 之外还有 BS/BT 等位（单步、任务切换），那些不是数据断点命中，不能当命中处理。
- 用"最低置位位"定位槽位：多个槽位同时命中时只报编号最小的那个，其余信息丢弃——这是简化，x86 上同一条指令触发两个监视点本就少见。
- 命中信息是**反查**出来的，不是记下来的：模式读 DR7 的 RWn，地址读 DRn；监视点不需要额外的表，DR 本身是唯一事实来源。清 DR6 必须在返回前做。`triggered` 状态留在 DR6 里，下一次 `PTRACE_CONT` 会立刻再抛一个 SIGTRAP，形成"一恢复就停"的死循环。

#### 5. Continue：把命中变成停止原因

`Continue` 在判断完内部事件（clone/exec/fork、自己发的 SIGSTOP、SIGURG 转发）之后，才检查硬件监视点：

```go
		// 硬件监视点命中（ch9.2.26）：SIGTRAP 且 DR6 记录了命中，
		// 报告监视点触发（DR6 已在 TriggeredWatchpoint 中清零）
		if status.Stopped() && status.StopSignal() == syscall.SIGTRAP {
			if wp, err := p.TriggeredWatchpoint(wpid); err == nil && wp != nil {
				if err := p.suspendOtherThreads(wpid); err != nil {
					return nil, err
				}
				reason := fmt.Sprintf("watchpoint %d triggered at %#x (%s)", wp.Slot, wp.Addr, wp.Mode)
				p.currentThread = p.Threads[wpid]
				...
				return &api.StopInfo{PID: wpid, Reason: reason}, nil
			}
		}
```

顺序很关键：普通断点命中也是 SIGTRAP，所以这里不能只看信号，必须再看 DR6——`TriggeredWatchpoint` 返回 `nil` 就说明是别的 SIGTRAP，落到后面的通用停止路径。命中后照例 `suspendOtherThreads`（all-stop），把停止原因拼成一行塞进 `StopInfo.Reason`，客户端原样打印成 `thread 2045697 status: watchpoint 0 triggered at 0x5933d0 (write)`。信号只是入口，DR6 才说明是谁命中。

### 执行测试

调试对象是 `examples/debuggee/watch/main.go`：全局变量 `var counter int`，主循环每轮 `counter++` 后打印并睡 1 秒。`make fixtures` 把它构建到 `_fixtures/watch`，是非 PIE 的 ET_EXEC，`go tool nm` 给出的就是运行时地址。

先用 `go tool nm _fixtures/watch | awk '$NF=="main.counter"'` 取地址（本机 `0x5933d0`，不同机器不保证相同），然后：

```text
godbg> watch -w 0x5933d0
watchpoint 0 set at 0x5933d0 (write)
godbg> continue
thread 2045697 status: watchpoint 0 triggered at 0x5933d0 (write)
> /home/zhangjie/debugger101/godbgv2/examples/debuggee/watch/main.go:20 (pc: 0x4b391d)
stop all threads now
continue ok
```

三件事可以读出来：槽位是 `0`、模式是 `write`，与 `-w` 一致；停止位置是 **main.go:20** 而不是 `counter++` 所在的 19 行，因为 #DB 是 trap，写指令已经执行完；此刻内存里已是新值：

```text
godbg> pmem 0x5933d0 --count 8
read 32 bytes ok:
0x5933d0:   0x00000001   0x00000000   0xee431469   0x0000c81f   0x00000000   0x00000000   0x00000000   0x00000000
```

前两个 4 字节字就是 `counter` 的低、高半部，等于 1——第一轮 `counter++` 已经落盘。监视点停的是"写完之后"，不是"写之前"；想抓写入前的旧值只能靠条件断点或自己记录。

连续 `continue`，可以看到 DR6 确实被清：

```text
godbg> continue
thread 2052544 status: watchpoint 0 triggered at 0x5933d0 (write)
godbg> continue
counter: 1
thread 2052544 status: watchpoint 0 triggered at 0x5933d0 (write)
godbg> continue
counter: 2
thread 2052544 status: watchpoint 0 triggered at 0x5933d0 (write)
```

中间的 `counter: N` 是程序在上一次命中后继续跑到 `fmt.Printf` 的输出（为省篇幅，省略了每次的源码位置行与 all-stop 提示）。如果 DR6 没清，第二次 `continue` 会立刻在同一位置再停一次，永远看不到 `counter: 1`。

模式与 flag 的实测：

```text
godbg> watch -r 0x5933d0        → watchpoint 0 set at 0x5933d0 (readwrite)
godbg> watch --rw 0x5933d0      → watchpoint 0 set at 0x5933d0 (readwrite)
godbg> watch -rw 0x5933d0       → watchpoint 0 set at 0x5933d0 (write)      ← 注意
```

`-r` 降级成 `readwrite` 符合预期；`-rw` 却变成了 `write`。原因是 flag 注册方式：`-r`、`-w` 用 `BoolP` 注册了短名，`rw` 只注册了长名（`watch.go:67-69`）。pflag 把 `-rw` 当成"组合短名"拆成 `-r -w` 两个都置位，而 switch 里 `w` 先于 `r` 判断，于是落到 `write`。要显式读写监视，写 `--rw` 或不给 flag。

边界情况的真实输出：

```text
godbg> watch -w 0x5933d8      → watchpoint 1 set at 0x5933d8 (write)
godbg> watch -w 0x5933e0      → watchpoint 2 set at 0x5933e0 (write)
godbg> watch -w 0x5933e8      → watchpoint 3 set at 0x5933e8 (write)
godbg> watch -w 0x5933f0      → Error: no free debug register (DR0-DR3 all in use)

godbg> watch -w main.counter  → Error: invalid address: strconv.ParseUint: parsing "main.counter": invalid syntax

godbg> watch -w 0x5933d4      → watchpoint 0 set at 0x5933d4 (write)
godbg> watch -w 0x5933d1      → Error: set DR7 for thread 0: invalid argument
```

后两行值得解释。非对齐地址在写 DR7 时被内核以 `EINVAL` 拒绝；能通过的是 4 字节对齐地址，奇数地址和 2 字节对齐地址都不行。内核按 LEN 校验对齐，而这里 LEN 是 `0b11`——又一次印证窗口是 4 字节而不是 8 字节。（错误信息里的 `thread 0` 实际是槽位号：`hwbreakpoint.go:95` 的 `Errorf` 传错了变量。）

窗口长度还可以直接测：编译一个只写 `p.B`、从不写 `p.A` 的程序（`struct{ A, B int32 }`，`B` 在 `A` 之后 4 字节），对 `p.A` 的地址设写监视：

```text
godbg> watch -w 0x5a5df8          （p.A 的地址）
watchpoint 0 set at 0x5a5df8 (write)
godbg> continue
B=1
...                               （10 秒内一次都没命中，timeout 收场）

# 对照：watch 在 p.B（p+4）上
godbg> watch -w 0x5a5dfc
godbg> continue
thread 2061737 status: watchpoint 0 triggered at 0x5a5dfc (write)
```

若窗口是 8 字节，`p.B` 的写入落在 `[p, p+7]` 里，第一组也应当命中；实测不命中，窗口只覆盖 4 字节。所以"LEN 固定 8 字节"只在注释里成立，运行时是 4 字节——监视 `int64` 变量时，后半个字（`counter` 的高 4 字节）其实在窗口外。

最后是最容易被忽略的一层：**部分受限内核（含某些 WSL2 版本）不支持写调试寄存器**。代码已把这种拒绝翻译成可读错误：

```go
			if errors.Is(err, syscall.EIO) {
				return nil, fmt.Errorf("hardware watchpoint not supported by kernel: %w", err)
			}
```

用例里用 `@skip-if` 探测这种内核，探测命中就跳过并记为通过（`testdata/script/ch9.2.26.txt`）：

```text
@skip-if bash -c 'tmp=$(mktemp); printf "watch -w 0x0\n" > "$tmp"; timeout 10 ./godbg exec _fixtures/watch --init "$tmp" </dev/null 2>&1 | grep -q "hardware watchpoint not supported"; rc=$?; rm -f "$tmp"; exit $rc'
@set ADDR go tool nm _fixtures/watch | awk '$NF=="main.counter" {printf "0x%s", $1; exit}'
@exec _fixtures/watch
watch -w $ADDR
=watchpoint [0-9]+ set at $ADDR \(write\)
continue
=thread [0-9]+ status: watchpoint 0 triggered at $ADDR \(write\)
```

`@skip-if` 的语义是"命令退出码为 0 则跳过本用例并视为通过"，所以探测脚本刻意去 grep 那句 EIO 文案；`@set` 现场解析地址而不写死，是因为不同机器的链接地址不同。跑一次：

```text
$ bash scripts/smoke.sh ch9.2.26
smoke: running testdata/script/ch9.2.26.txt
smoke: @set ADDR=0x5933d0
smoke: all passed
```

本次实测环境是 WSL2（内核 `6.6.123.2-microsoft-standard-WSL2+`），写调试寄存器被接受，用例没有走 `@skip-if` 分支，`watch` 全链路可用。也就是说"WSL2 一定 EIO"并不成立：能否使用取决于内核版本，老一些的 WSL2 内核会拒绝，CI 的真内核（ubuntu-24.04）则一直完整验证。书里的结论应当写成"可能不可用，用 `@skip-if` 探测"，而不是"必然不可用"。

### 本节小结

watch 是独立于断点表的一条调试路径：地址直接进 DR0-DR3，触发条件进 DR7，命中记录在 DR6，`Continue` 只负责把 DR6 翻译成一句停止原因。

- **硬件 vs 软件**：监视点零运行时开销、硬件限 4 个；断点靠 `0xCC`、数量不受限但每次执行都要陷入。前者盯"数据被谁动过"，后者盯"执行到哪"，在 godbgv2 里两者互不感知。
- **命中时机**：#DB 是 trap，停下来时写已生效，PC 在下一条指令；这是读 `pmem` 时最容易误判的一点。
- **边界要如实写**：只收地址、没有表达式；LENn 写死 `0b11`，实测窗口 4 字节（源码注释写 8 字节，与 Intel 编码不符）；`-r` 在 x86 上只能降级成 `-rw`；`-rw` 这个写法会被 pflag 拆成 `-r -w` 而落到 `write`，要用 `--rw`；无清单、无清除命令；栈变量在栈扩容后会静默失效。
- **尚未解决的部分**：栈地址修正、按类型选择窗口长度，以及监视点设置之后新建线程的 DR 补设（`SetWatchpoint` 只遍历当时已存在的线程）。当前可用的场景是"监视全局变量或堆上对象，且接受 4 字节窗口"。
