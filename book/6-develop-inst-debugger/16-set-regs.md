## 修改进程状态：修改寄存器数据

### 实现目标：`godbg> setreg <reg> <value>` 修改寄存器数据

我们已经展示过如何读取并且修改寄存器数据了，比如continue命令执行时，如果当前PC-1处是软件断点0xCC，我们需要重置断点并且设置寄存器PC=PC-1。

和当时设置PC=PC-1相同，我们这里用到的寄存器修改方法仍然是通过 `ptrace(PTRACE_SETREGS,...)`。所不同的是本小节要实现一个通用的寄存器修改命令 `setreg <registerName> <value>` 。

当高级语言代码被构建完成后就变成了一系列的机器指令，机器指令的操作数可以是立即数、内存地址、寄存器编号。我们在使用符号级调试器的时候，有时候会改变变量值（迭代变量、函数参数、函数返回值等等）来控制程序执行逻辑。其实在指令级调试时，也是有这样的需求去修改内存中的数据、寄存器中的数据，所以我们需要有修改内存命令setmem、修改寄存器命令setreg命令。

ps: 当然从易用性角度来说，可以使用一个set命令来实现setmem、setreg、setvar，但是我们是为了教学目的，所以每个操作最好相对独立，这样逻辑清晰简单、篇幅也更简短。

### 代码实现

godbg中的实现也非常简单，接收用户输入的寄存器名args[0]、要设置的值args[1]，然后通过 `Client.ReadRegs()` 拿到所有寄存器的值，用反射找到代表对应寄存器名的字段（如 `regs.Rax`）并修改字段值，最后将修改后的寄存器数据通过 `Client.WriteRegs()` 写回。

**file：cmd/debug/set_reg.go**

```go
package debug

import (
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"

	"github.com/hitzhangjie/godbgv2/pkg/service/api"
	"github.com/spf13/cobra"
)

var setRegCmd = &cobra.Command{
	Use:   "setreg <reg> <value>",
	Short: "设置寄存器值",
	Annotations: map[string]string{
		cmdGroupAnnotation: cmdGroupInfo,
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		// 检查参数数量
		if len(args) != 2 {
			return errors.New("usage: setreg <reg> <value>")
		}

		regName := strings.ToLower(args[0])
		valueStr := args[1]

		// 解析值参数
		value, err := strconv.ParseUint(valueStr, 0, 64)
		if err != nil {
			return fmt.Errorf("invalid value format: %s", valueStr)
		}

		// 读取当前寄存器状态
		regs, err := Client.ReadRegs()
		if err != nil {
			return fmt.Errorf("failed to read registers: %v", err)
		}

		// 按名称（忽略大小写）修改寄存器值并写回
		if err := setRegField(regs, regName, value); err != nil {
			return err
		}
		if err := Client.WriteRegs(regs); err != nil {
			return fmt.Errorf("failed to write register %s: %v", regName, err)
		}

		fmt.Printf("setreg ok, %s: %#x\n", regName, value)
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(setRegCmd)
}

// setRegField 通过反射按名称（忽略大小写）设置寄存器值
func setRegField(regs *api.Registers, name string, value uint64) error {
	rv := reflect.ValueOf(regs).Elem()
	rt := rv.Type()

	for i := 0; i < rv.NumField(); i++ {
		fieldName := strings.ToLower(rt.Field(i).Name)
		if fieldName == name {
			rv.Field(i).SetUint(value)
			return nil
		}
	}
	return fmt.Errorf("invalid register name: %s", name)
}
```

为什么用反射？`api.Registers` 有 27 个字段，如果写成 `switch regName { case "rax": ...; case "rbx": ... }`，会有近 30 个分支，而且每增删一个字段都要同步改一遍。反射版本只依赖字段名：`setRegField` 把结构体字段名转成小写后与用户输入比较，命中就 `SetUint`，没命中就报 `invalid register name`。

写回的调用链和读寄存器是对称的：命令层的 `Client.WriteRegs(regs)` 先由 `debugger.Debugger` 门面转发到 target 层，`RegsToPtrace` 就是在门面这一层被调用的：

**file：pkg/service/debugger/debugger.go**（片段）

```go
// WriteRegs 写回当前线程的寄存器
func (d *Debugger) WriteRegs(regs *api.Registers) error {
	if d.dbp == nil {
		return fmt.Errorf("no debugged process")
	}
	return d.dbp.WriteRegister(d.dbp.Process.Pid, target.RegsToPtrace(regs))
}
```

再往下，target 层执行的是一次 `PTRACE_SETREGS`：

**file：pkg/target/registers_amd64.go**（片段）

```go
// WriteRegister 设置指定线程/进程的寄存器数据
func (p *DebuggedProcess) WriteRegister(pid int, regs *syscall.PtraceRegs) error {
	err := p.ExecPtrace(func() error {
		return syscall.PtraceSetRegs(pid, regs)
	})
	return err
}
```

注意这里的操作顺序是“读—改—写”，而不是只写一个字段。因为 `PTRACE_SETREGS` 会整体覆盖内核里的 `user_regs_struct`，所以必须先把完整快照读出来、只改目标字段、再整体写回，没被修改的寄存器才能保持原值。`RegsToPtrace` 就是这次写回的“翻译层”，它把 `api.Registers` 转换回内核期望的结构，字段必须一个不漏：

**file：pkg/target/registers_amd64.go**（片段）

```go
// RegsToPtrace 将 api 层契约类型转换为内核期望的寄存器数据。
//
// 注意：PTRACE_SETREGS 会完整写入 user_regs_struct 的全部字段，
// 若段寄存器/段基址等字段被清零，内核会拒绝写入（EIO），
// 因此 api.Registers 必须完整建模这些字段。
func RegsToPtrace(regs *api.Registers) *syscall.PtraceRegs {
	return &syscall.PtraceRegs{
		R15: regs.R15, R14: regs.R14, R13: regs.R13, R12: regs.R12,
		Rbp: regs.Rbp, Rbx: regs.Rbx, R11: regs.R11, R10: regs.R10,
		R9: regs.R9, R8: regs.R8,
		Rax: regs.Rax, Rcx: regs.Rcx, Rdx: regs.Rdx,
		Rsi: regs.Rsi, Rdi: regs.Rdi,
		Orig_rax: regs.OrigRax,
		Rip:      regs.Rip, Cs: regs.Cs, Eflags: regs.EFlags,
		Rsp: regs.Rsp, Ss: regs.Ss,
		Fs_base: regs.FsBase, Gs_base: regs.GsBase,
		Ds: regs.Ds, Es: regs.Es, Fs: regs.Fs, Gs: regs.Gs,
	}
}
```

上面这段注释说的是一个很容易踩的坑：`PTRACE_SETREGS` 不是“只改你关心的那几个寄存器”，而是把 `user_regs_struct` 整个写进内核。段寄存器、段基址这些字段如果被清零，内核会直接返回 `EIO`，写回就失败了。

> ps：上述代码取自 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.16`。与读取寄存器类似，`PTRACE_SETREGS` 也是x86架构特有的ptrace请求，对应的架构无关新接口是 `PTRACE_SETREGSET`（Linux 2.6.30+）。Go标准库 `syscall.PtraceSetRegs` 底层即PTRACE_SETREGS，仅在amd64/386等平台提供。`Client.ReadRegs` / `Client.WriteRegs` 在 step、continue 小节已经就位，本节新增的是命令层和反射查找。

### 代码测试

测试目标还是 `_fixtures/loop`。它每秒打印一次 pid 和循环计数，pid 来自 `os.Getpid()` 的返回值。切到本节代码并构建：

```bash
$ git checkout ch6.16
$ make build
$ make fixtures
```

#### 测试：修改寄存器值并查看

先看 `main.main` 开头取 pid 的几行汇编。`0x4b395a` 处的 call 调用 `os.Getpid`，返回值按 ABI 约定放在 rax 里，紧接着 `0x4b395f` 把它存到 `0x28(%rsp)`，也就是源码里的 `pid` 变量：

```bash
$ ./godbg exec _fixtures/loop
process 2296794 launched, stopped by SIGTRAP
godbg> disass 0x4b395f --max 1
0x4b395f:	48 89 44 24 28	mov %rax,0x28(%rsp)
```

我们在 `0x4b395f` 和循环体起点 `0x4b3971` 各下一个断点，然后继续执行：

```bash
godbg> break 0x4b395f
breakpoint 1 added at 0x4b395f
godbg> break 0x4b3971
breakpoint 2 added at 0x4b3971
godbg> continue
thread 2296794 status: stopped: trace/breakpoint trap
godbg> pregs
Register    Value
Rip         0x4b3960
Rsp         0xc0000c2ee0
Rbp         0xc0000c2f68
Rax         0x230bda
...
```

停在 `0x4b395f` 时 `Rip=0x4b3960`（断点地址+1），`Rax=0x230bda` 就是 `os.Getpid()` 的返回值，换算成十进制是 2296794，和启动时打印的 `process 2296794 launched` 一致。

现在把 rax 改成 `0x5555`，再用 pregs 确认：

```bash
godbg> setreg rax 0x5555
setreg ok, rax: 0x5555
godbg> pregs
Register    Value
Rip         0x4b3960
Rsp         0xc0000c2ee0
Rbp         0xc0000c2f68
Rax         0x5555
...
```

`setreg` 执行成功，`Rax` 从 `0x230bda` 变成了 `0x5555`，其余寄存器（Rip、Rsp、Rbp 等）保持不变，说明“读—改—写”的流程是正确的。

#### 测试：篡改返回值影响程序行为

接着恢复执行。断点还在，所以每次停在循环体起点时，程序都会打印上一轮的结果：

```bash
godbg> continue
stopped at breakpoint 0x4b395f
thread 2296794 status: stopped: trace/breakpoint trap
godbg> continue
stopped at breakpoint 0x4b3971
pid: 21845, loop: 0
thread 2296794 status: stopped: trace/breakpoint trap
godbg> continue
stopped at breakpoint 0x4b3971
pid: 21845, loop: 1
thread 2296794 status: stopped: trace/breakpoint trap
godbg> exit
tracee is run by tracer, kill it
```

第一次 `continue` 先把 `0x4b395f` 处的断点指令还原、回退 PC、单步越过，然后恢复执行；`mov %rax,0x28(%rsp)` 把改过的 `0x5555` 存进 `pid` 变量，于是后续打印的 pid 全部变成了 21845（`0x5555` 的十进制），而真实进程仍然是 2296794。

这就是“篡改函数返回值”：函数返回值放在 rax 里，在调用返回后、调用方使用它之前改掉 rax，调用方拿到的就是伪造的结果。同样的手法可以用来改函数参数、改循环变量的寄存器副本，甚至改 rip 直接跳转，是指令级调试里控制程序执行流程的常用手段。

### 本节小结

本文实现了通用的寄存器修改命令 setreg：`Client.ReadRegs()` 读出完整快照，反射按名称（忽略大小写）定位字段并修改，`Client.WriteRegs()` 整体写回，底层是 `ptrace(PTRACE_SETREGS,...)`。由于 SETREGS 会覆盖整个 `user_regs_struct`，必须“读—改—写”，并且 `api.Registers` 要完整建模所有字段，否则会因字段清零被内核拒绝（EIO）。

我们把前面两条线索合起来看：setmem 改内存、setreg 改寄存器，两者配合可以修改程序的数据、返回值、PC 乃至栈帧内容。接下来我们先用它们完善多线程、多进程场景下的调试支持；等进入符号级调试（第7章）时，我们会发现按变量名修改值、按函数名下断点这些更自然的能力，最终仍然落回这里的 ptrace 原语。
