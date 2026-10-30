## 修改进程状态：修改内存数据

### 实现目标：`godbg> setmem <addr> <value>` 修改内存数据

添加、移除断点过程中其实也是对内存数据做修改，只不过断点操作修改的是指令数据，而我们这里强调的是对数据做修改。

指令级调试器对内存数据做修改，其实没有符号级调试器直接通过变量名来修改容易，对调试人员的要求比较高。因为如果不知道什么数据在内存什么位置，是什么类型，占多少字节，就不好修改。符号级调试器就简单多了，直接通过变量名就可以修改，比如 `set var = value`，但底层用到的系统调用仍然是 `ptrace(PTRACE_POKEDATA,...)`。

OK，我们先还是先介绍如何修改任意指定地址处的内存数据，然后在 godbg 中实现此setmem命令：`setmem <addr> <value>`。

### 基础知识

`ptrace(PTRACE_POKEDATA,...)` 把一段数据写进被调试进程指定地址处。它和 `PTRACE_PEEKDATA` 一样以内核字长（amd64 下是 8 字节）为单位搬运数据：Go 的 `syscall.PtracePokeData` 对中间部分逐字写入，对首尾不是字长整数倍的部分，则先读出原来的字、替换目标字节后再整体写回，保证相邻字节不被破坏，最后返回实际写入的字节数。

有两点值得留意：

- ptrace 的读写由内核代劳，走的是强制访问（FOLL_FORCE），即使目标页面在进程页表里是只读的（如 `.text`、`.rodata`）也能写入——软件断点就是把 `0xCC` 写进 `.text` 的；
- 写多字节数据时要考虑字节序，这一点在 pmem 小节已经讨论过。本命令一次只写一个字节，暂时绕开了字节序问题。

### 代码实现

godbgv2 中 setmem 命令的形式是 `setmem <addr> <value>`，地址和值都支持带 `0x` 前缀的十六进制写法和十进制写法（`strconv.ParseUint(..., 0, 64)` 会自动识别），当前一次写入 1 字节。

**file：cmd/debug/set_mem.go**

```go
package debug

import (
	"errors"
	"fmt"
	"strconv"

	"github.com/spf13/cobra"
)

var setMemCmd = &cobra.Command{
	Use:   "setmem <addr> <value>",
	Short: "设置指定内存位置的值",
	Annotations: map[string]string{
		cmdGroupAnnotation: cmdGroupInfo,
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		// 检查参数数量
		if len(args) != 2 {
			return errors.New("usage: setmem <addr> <value>")
		}

		// 解析地址参数
		addrStr := args[0]
		addr, err := strconv.ParseUint(addrStr, 0, 64)
		if err != nil {
			return fmt.Errorf("invalid address format: %s", addrStr)
		}

		// 解析值参数（当前支持写入 1 字节）
		valueStr := args[1]
		value, err := strconv.ParseUint(valueStr, 0, 64)
		if err != nil {
			return fmt.Errorf("invalid value format: %s", valueStr)
		}

		// 写入新值
		newData := []byte{byte(value)}
		if err := Client.WriteMemory(addr, newData); err != nil {
			return fmt.Errorf("failed to write memory at address 0x%x: %v", addr, err)
		}

		fmt.Printf("setmem ok, addr: %#x, value: %#x\n", addr, newData[0])
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(setMemCmd)
}
```

`RunE` 里依次做三件事：检查参数个数、解析地址和值、调用 `Client.WriteMemory` 写内存。值先被截断成 `byte(value)`，再包成单字节切片传下去；写成功后打印实际写入的地址和值，方便和随后的 `pmem` 输出对照。

和 pmem 一样，命令层不直接碰 ptrace，而是通过 `api.Client` 接口新增的方法：

**file：pkg/service/api/client.go**（片段）

```go
	// WriteMemory 向地址 addr 处写入数据 data
	WriteMemory(addr uint64, data []byte) error
```

**file：pkg/service/debugger/debugger.go**（片段）

```go
// WriteMemory 向地址 addr 处写入数据 data
func (d *Debugger) WriteMemory(addr uint64, data []byte) error {
	if d.dbp == nil {
		return fmt.Errorf("no debugged process")
	}
	return d.dbp.WriteMemory(uintptr(addr), data)
}
```

target 层的实现就是一次 `PTRACE_POKEDATA`：

**file：pkg/target/memory.go**（片段）

```go
// WriteMemory 设置内存地址addr处的值为value
func (p *DebuggedProcess) WriteMemory(addr uintptr, value []byte) error {
	return p.ExecPtrace(func() error {
		// 使用 PtracePokeData 写入内存数据
		n, err := syscall.PtracePokeData(p.Process.Pid, addr, value)
		if err != nil {
			return err
		}
		if n != len(value) {
			return fmt.Errorf("expected to write %d bytes, but wrote %d bytes", len(value), n)
		}
		return nil
	})
}
```

和读内存时一样，写操作也通过 `ExecPtrace` 锁定 OS 线程执行。`PtracePokeData` 返回实际写入的字节数，写不满就返回错误——这比“系统调用没报错就等于写成功”更稳妥。

> ps：上述代码取自 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.16`。`ReadMemory` / `WriteMemory` 这一对方法都在 `pkg/target/memory.go` 里，命令层、门面、target 三层的写法与 pmem 小节保持一致。

### 代码测试

测试目标还是 godbgv2 自带的 `_fixtures/loop`。它每秒打印一次 pid 和循环计数，循环计数变量在源码里叫 `i`，打印时标为 `loop`。切到本节代码并构建：

```bash
$ git checkout ch6.16
$ make build
$ make fixtures
```

#### 测试：找到要修改的变量

要改数据，先得知道数据在哪里。用反汇编看 `main.main` 里和计数变量相关的两条指令：

```bash
$ ./godbg exec _fixtures/loop
process 2296358 launched, stopped by SIGTRAP
godbg> disass 0x4b3964 --max 1
0x4b3964:	48 c7 44 24 30 00 00 00 00	movq $0x0,0x30(%rsp)
godbg> disass 0x4b3a53 --max 1
0x4b3a53:	48 ff 44 24 30	incq 0x30(%rsp)
```

第一条是 `i := 0` 的初始化，第二条是循环末尾的 `i++`，两条指令都作用在 `0x30(%rsp)` 上，所以循环计数变量就存放在当前栈帧的 `Rsp+0x30` 处。

#### 测试：修改变量并观察程序行为

在循环体起点 `0x4b3971` 下断点，把程序跑起来，再用 pregs 拿到当前的 Rsp：

```bash
godbg> break 0x4b3971
breakpoint 1 added at 0x4b3971
godbg> continue
thread 2296358 status: stopped: trace/breakpoint trap
godbg> pregs
Register    Value
Rip         0x4b3972
Rsp         0xc0000c2ee0
Rbp         0xc0000c2f68
Rax         0x230a26
...
```

此时 `Rsp=0xc0000c2ee0`，计数变量的地址就是 `0xc0000c2ee0 + 0x30 = 0xc0000c2f10`。这个地址取决于你的机器和运行时布局，以你实际看到的 Rsp 为准。

先读一下这个地址，再把它改成 123（`0x7b`）：

```bash
godbg> pmem 0xc0000c2f10 --count 1 --size 8
read 8 bytes ok:
0xc0000c2f10:   0x0000000000000000   
godbg> setmem 0xc0000c2f10 0x7b
setmem ok, addr: 0xc0000c2f10, value: 0x7b
godbg> pmem 0xc0000c2f10 --count 1 --size 8
read 8 bytes ok:
0xc0000c2f10:   0x000000000000007b   
```

第一次读出来是 0，因为循环刚刚开始；`setmem` 写入 `0x7b` 之后，同样的 8 个字节被解析成 `0x7b`。setmem 只改了最低的那个字节，其余 7 个字节仍然是 0，所以计数变量从 0 变成了 123。

恢复执行，看看计数变量被改之后程序的表现：

```bash
godbg> continue
stopped at breakpoint 0x4b3971
pid: 2296358, loop: 123
thread 2296358 status: stopped: trace/breakpoint trap
godbg> continue
stopped at breakpoint 0x4b3971
pid: 2296358, loop: 124
thread 2296358 status: stopped: trace/breakpoint trap
godbg> exit
tracee is run by tracer, kill it
```

程序本来应该打印 `loop: 0`，现在直接打印了 `loop: 123`，下一轮再自增成 124。这说明写入确实落在了 `i` 所在的内存上，程序读到的就是修改后的值——修改内存数据能直接改变程序的执行行为。

### 本节小结

本文我们实现了指令级调试器修改任意内存地址处的数据的功能：命令层解析地址和值，通过 `Client.WriteMemory` 调用到 target 层的 `ptrace(PTRACE_POKEDATA,...)`；测试中先用反汇编定位变量在栈帧中的偏移，再用 pregs 取到栈顶地址，最后用 setmem 修改计数变量，从程序输出确认修改生效。

这个功能非常重要，我们都知道修改内存数据对于调试修改程序执行行为的重要性。了解了这里的实现技术后，我们将在实现符号级调试时继续实现对变量值的修改，对于实用高级语言进行开发的开发者来说，调整变量值是一个非常重要的观察程序执行行为的功能。

下一节我们将继续查看下如何修改寄存器的值，这在某些调试场景下也是很重要的。
