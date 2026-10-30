## 查看进程状态：查看寄存器数据

### 实现目标：`godbg> pregs` 查看寄存器数据

这一小节，我们来实现pregs命令，方便调试进程时查看进程寄存器数据。对于指令级调试而言，我们通过反汇编看到待执行的汇编指令，为了搞清楚指令的操作数，我们需要借助pmem来查看内存数据，也需要pregs来查看寄存器数据。这就好比符号级调试器看到源码后需要知道对应的变量值一样。

在前面章节中我们已经不止一次使用 `ptrace(PTRACE_GETREGS,...)` 获取寄存器数据了（比如 step 单步、continue 回退 PC 时都要读写寄存器），这里我们把它做成一个独立的调试命令：每次执行 `pregs` 就打印当前所有寄存器的信息。我们不像gdb那样支持 `pregs <reg>` 单独打印某个寄存器的值，一次看全更符合指令级调试的习惯。

> ps：指令级调试门槛是有点高的，至少要懂汇编语言，或者在某些工具帮助下能看得懂汇编语言，也有些工具支持从指令数据还原出对应的高级语言源码，如生成对应的C程序，但是因为变量名、函数名问题即使生成了可读性也比较差，只能看程序组织、调用方式。在这个过程中，不同处理器对应的寄存器也不一样，比如i386、amd64、arm64等，这要求开发人员必须参考并了解相关的细节才能顺利调试。

### 基础知识

amd64 架构下的寄存器可以粗略分成几类：

- 通用寄存器 rax、rbx、rcx、rdx、rsi、rdi、rbp、rsp、r8 ~ r15：函数参数、返回值、局部变量、栈帧基址和栈顶都在这里面；
- 指令指针 rip：指向下一条要执行的指令，断点处回退 PC、单步越过断点都是在改它；
- 标志寄存器 eflags：比较、条件跳转指令的结果记录在这里；
- 段寄存器 cs、ss、ds、es、fs、gs 以及段基址 fs_base、gs_base：amd64 下分段基本被扁平化，fs/gs 基址主要用来定位线程本地存储（TLS），go runtime 也会把当前 goroutine 的 g 保存在 TLS 里；
- orig_rax：系统调用进入内核前，系统调用号会被保存到这里。

`ptrace(PTRACE_GETREGS,...)` 一次就能读出全部这些寄存器，返回的是内核中的 `struct user_regs_struct`。

> ps: `PTRACE_GETREGS` 是x86架构特有的ptrace请求，它读取的是x86架构的 `struct user_regs_struct`。内核还提供了架构无关的新接口 `PTRACE_GETREGSET`（Linux 2.6.30+），通过指定regset类型（如通用寄存器对应的NT_PRSTATUS）来读取寄存器，各架构只需实现各自的regset即可，gdb等调试器就基于GETREGSET实现跨架构支持。Go标准库 `syscall.PtraceGetRegs` 仅在amd64/386等平台提供，底层即PTRACE_GETREGS；如需使用GETREGSET，可借助 `golang.org/x/sys/unix` 中的 `PTRACE_GETREGSET` 常量自行封装调用。

### 代码实现

#### 第1步：实现 pregs 命令

pregs 没有参数，执行时读取一次寄存器快照，再用 `text/tabwriter` 按“寄存器名 + 值”两列对齐打印出来。

**file：cmd/debug/pregs.go**

```go
package debug

import (
	"fmt"
	"os"
	"text/tabwriter"

	"github.com/hitzhangjie/godbgv2/pkg/service/api"
	"github.com/spf13/cobra"
)

var pregsCmd = &cobra.Command{
	Use:   "pregs",
	Short: "查看寄存器数据",
	Annotations: map[string]string{
		cmdGroupAnnotation: cmdGroupInfo,
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		regs, err := Client.ReadRegs()
		if err != nil {
			return fmt.Errorf("get regs error: %v", err)
		}
		prettyPrintRegs(regs)
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(pregsCmd)
}

// prettyPrintRegs 以表格形式打印寄存器数据
func prettyPrintRegs(regs *api.Registers) {
	w := tabwriter.NewWriter(os.Stdout, 0, 8, 4, ' ', 0)
	fmt.Fprintf(w, "Register\tValue\n")

	fmt.Fprintf(w, "Rip\t%#x\n", regs.Rip)
	fmt.Fprintf(w, "Rsp\t%#x\n", regs.Rsp)
	fmt.Fprintf(w, "Rbp\t%#x\n", regs.Rbp)
	fmt.Fprintf(w, "Rax\t%#x\n", regs.Rax)
	fmt.Fprintf(w, "Rbx\t%#x\n", regs.Rbx)
	fmt.Fprintf(w, "Rcx\t%#x\n", regs.Rcx)
	fmt.Fprintf(w, "Rdx\t%#x\n", regs.Rdx)
	fmt.Fprintf(w, "Rsi\t%#x\n", regs.Rsi)
	fmt.Fprintf(w, "Rdi\t%#x\n", regs.Rdi)
	fmt.Fprintf(w, "R8\t%#x\n", regs.R8)
	fmt.Fprintf(w, "R9\t%#x\n", regs.R9)
	fmt.Fprintf(w, "R10\t%#x\n", regs.R10)
	fmt.Fprintf(w, "R11\t%#x\n", regs.R11)
	fmt.Fprintf(w, "R12\t%#x\n", regs.R12)
	fmt.Fprintf(w, "R13\t%#x\n", regs.R13)
	fmt.Fprintf(w, "R14\t%#x\n", regs.R14)
	fmt.Fprintf(w, "R15\t%#x\n", regs.R15)
	fmt.Fprintf(w, "EFlags\t%#x\n", regs.EFlags)
	fmt.Fprintf(w, "Cs\t%#x\n", regs.Cs)
	fmt.Fprintf(w, "Ss\t%#x\n", regs.Ss)
	fmt.Fprintf(w, "Ds\t%#x\n", regs.Ds)
	fmt.Fprintf(w, "Es\t%#x\n", regs.Es)
	fmt.Fprintf(w, "Fs\t%#x\n", regs.Fs)
	fmt.Fprintf(w, "Gs\t%#x\n", regs.Gs)
	fmt.Fprintf(w, "FsBase\t%#x\n", regs.FsBase)
	fmt.Fprintf(w, "GsBase\t%#x\n", regs.GsBase)
	fmt.Fprintf(w, "OrigRax\t%#x\n", regs.OrigRax)

	w.Flush()
}
```

`RunE` 只做两件事：通过 `Client.ReadRegs()` 拿到寄存器快照，再交给 `prettyPrintRegs` 打印。这里没有用反射遍历字段，而是按调试时最常关注的顺序把 27 个寄存器逐个写出来——顺序固定，多次执行之间的输出才好对比。

每个值都用 `%#x` 打印成带 `0x` 前缀的十六进制数，宽度不补齐，所以 `0x0` 和 `0x7fffffffffffffff` 都能原样展示，不会丢掉高位信息；列的宽度交给 `tabwriter` 去对齐。

> tabwrite对于需要输出多行、多列数据且需要对每列数据进行对齐的场景非常适用。

#### 第2步：寄存器数据从内核到命令层

命令层拿到的不是内核的 `syscall.PtraceRegs`，而是 `api.Registers`。这是有意为之：`cmd/` 只依赖 `pkg/service/api`，不能直接引用 ptrace 和内核数据结构（架构铁律，见 docs/ARCH-RULES.md）。

**file：pkg/service/api/types.go**（片段）

```go
// Registers amd64 通用寄存器（linux/amd64）
type Registers struct {
	Rip    uint64 // 指令指针
	Rsp    uint64 // 栈指针
	Rbp    uint64 // 栈帧基址
	Rax    uint64
	Rbx    uint64
	Rcx    uint64
	Rdx    uint64
	Rsi    uint64
	Rdi    uint64
	R8     uint64
	R9     uint64
	R10    uint64
	R11    uint64
	R12    uint64
	R13    uint64
	R14    uint64
	R15    uint64
	EFlags uint64 // 标志寄存器
	Cs     uint64 // 段寄存器（选择子）
	Ss     uint64
	Ds     uint64
	Es     uint64
	Fs     uint64
	Gs     uint64
	FsBase uint64 // 段基址
	GsBase uint64
	OrigRax uint64 // 系统调用号（syscall 进入内核前保存于此）
}
```

`debugger.Debugger` 门面把 target 层读到的内核数据转换成这个契约类型：

**file：pkg/service/debugger/debugger.go**（片段）

```go
// ReadRegs 读取当前线程的寄存器
func (d *Debugger) ReadRegs() (*api.Registers, error) {
	if d.dbp == nil {
		return nil, fmt.Errorf("no debugged process")
	}
	regs, err := d.dbp.ReadRegister(d.dbp.Process.Pid)
	if err != nil {
		return nil, err
	}
	return target.RegsFromPtrace(regs), nil
}
```

真正的 ptrace 调用在 target 层。`ExecPtrace` 把 ptrace 请求放到一个锁定到具体 OS 线程的 goroutine 上执行，避免 Go runtime 把 goroutine 调度到其他线程导致 ptrace 请求失败：

**file：pkg/target/registers_amd64.go**（片段）

```go
// ReadRegister 读取指定线程/进程的寄存器数据
func (p *DebuggedProcess) ReadRegister(pid int) (*syscall.PtraceRegs, error) {
	var regs syscall.PtraceRegs
	err := p.ExecPtrace(func() error {
		return syscall.PtraceGetRegs(pid, &regs)
	})
	if err != nil {
		return nil, err
	}
	return &regs, nil
}
```

`RegsFromPtrace` 则逐字段把 `user_regs_struct` 拷贝成 `api.Registers`，顺带把内核里 `Eflags`、`Fs_base`、`Orig_rax` 这些下划线命名改成 go 风格：

```go
// RegsFromPtrace 将内核返回的寄存器数据转换为 api 层契约类型
func RegsFromPtrace(regs *syscall.PtraceRegs) *api.Registers {
	return &api.Registers{
		Rip: regs.Rip, Rsp: regs.Rsp, Rbp: regs.Rbp,
		Rax: regs.Rax, Rbx: regs.Rbx, Rcx: regs.Rcx, Rdx: regs.Rdx,
		Rsi: regs.Rsi, Rdi: regs.Rdi,
		R8: regs.R8, R9: regs.R9, R10: regs.R10, R11: regs.R11,
		R12: regs.R12, R13: regs.R13, R14: regs.R14, R15: regs.R15,
		EFlags: regs.Eflags, Cs: regs.Cs, Ss: regs.Ss,
		Ds: regs.Ds, Es: regs.Es, Fs: regs.Fs, Gs: regs.Gs,
		FsBase: regs.Fs_base, GsBase: regs.Gs_base, OrigRax: regs.Orig_rax,
	}
}
```

> ps：上述代码取自 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.15`。为了让正文聚焦在 pregs 上，这里只展开了命令层和寄存器读取链路；`Client.ReadRegs` / `Client.WriteRegs` 这对接口在 step、continue 小节已经就位，本节新增的是命令层和打印逻辑。

至此pregs命令基本完成开发，我们来测试下pregs的执行情况。

### 代码测试

测试对象是 godbgv2 自带的 `_fixtures/loop`，程序入口固定为 `0x478120`（Makefile 固定了构建所用的 Go 工具链版本）。切到本节代码并构建：

```bash
$ git checkout ch6.15
$ make build
$ make fixtures
```

#### 测试：程序启动时的寄存器

`exec` 启动的程序会先停在入口处，此时打印一次寄存器：

```bash
$ ./godbg exec _fixtures/loop
process 2297262 launched, stopped by SIGTRAP
godbg> pregs
Register    Value
Rip         0x478120
Rsp         0x7ffde1705900
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
EFlags      0x200
Cs          0x33
Ss          0x2b
Ds          0x0
Es          0x0
Fs          0x0
Gs          0x0
FsBase      0x0
GsBase      0x0
OrigRax     0x3b
godbg> break 0x4b3971
breakpoint 1 added at 0x4b3971
godbg> continue
thread 2297262 status: stopped: trace/breakpoint trap
```

这份快照很能说明“进程刚被 exec 起来”是什么状态：

- `Rip=0x478120` 正是 ELF 头里记录的入口地址，对应符号 `_rt0_amd64_linux`——它是 go 程序的启动桩，第一条指令就是跳向 `_rt0_amd64`；
- `Rsp` 指向这块 OS 线程的栈顶，此时 go runtime 还没接管；
- 通用寄存器基本都是 0，`EFlags=0x200` 表示中断允许位 IF 置位；
- `Cs=0x33`、`Ss=0x2b` 是 amd64 下用户态代码段和栈段的段选择子；
- `OrigRax=0x3b`（59）是 `execve` 的系统调用号——exec 过程中内核就是用这个系统调用把目标程序加载起来的。

#### 测试：在断点处再次查看

继续执行到 `_fixtures/loop` 循环体的起点 `0x4b3971`，再看一次寄存器：

```bash
godbg> pregs
Register    Value
Rip         0x4b3972
Rsp         0xc00011cee0
Rbp         0xc00011cf68
Rax         0x230dae
...
godbg> exit
tracee is run by tracer, kill it
```

和启动时相比，变化很直观：

- `Rip=0x4b3972`，是断点地址 `0x4b3971` 加 1。断点处的 `int3` 已经执行完毕，PC 停在了它的下一条指令上，这正是 continue、step 里判断“PC-1 处是否为断点”的原因；
- `Rsp=0xc00011cee0`，这是 go runtime 给 main goroutine 分配的栈，说明此刻已经运行在 `main.main` 的栈帧里，`Rbp` 就是该栈帧的基址；
- `Rax`、`Rbx`、`R12` ~ `R15` 已经装满了 runtime 的数据，不再是启动时的全 0。比如 `R14` 在 go 的 amd64 实现里固定指向当前 goroutine 的 `g`，`R14=0xc000004380` 就落在 go 堆上。

pregs 能随时反映进程停止位置的真实寄存器状态，说明读取链路是通的。后面查看内存、修改内存与寄存器时，都要先靠它拿到 Rsp 这类“地址线索”。

### 本节小结

本文实现了pregs命令：通过 `Client.ReadRegs()` 读取寄存器快照，用 `tabwriter` 按两列对齐打印；读寄存器的底层是 `ptrace(PTRACE_GETREGS,...)`，封装在 target 层的 `ReadRegister` 里。同时我们引入了 `api.Registers` 这个契约类型，把命令层与内核的 `user_regs_struct` 隔离开——`cmd/` 不再直接依赖 ptrace。

截止到目前我们实现了pmem、pregs这两个查看内存、查看寄存器数据的命令，只查看还不够，我们还应该实现修改内存数据、修改寄存器数据的操作，我们会在后面小节介绍。
