## 修改进程状态：修改寄存器数据

### 实现目标：`godbg> setreg <reg> <val>` 修改寄存器数据

我们已经展示过如何读取并且修改寄存器数据了，比如continue命令执行时，如果当前PC-1处是软件断点0xCC，我们需要重置断点并且设置寄存器PC=PC-1。

和当时设置PC=PC-1相同，我们这里用到的寄存器修改方法仍然是通过 `ptrace(PTRACE_SET_REGS,...)`。所不同的是本小节要实现一个通用的寄存器修改命令 `setreg <registerName> <value>` 。

当高级语言代码被构建完成后就变成了一系列的机器指令，机器指令的操作数可以是立即数、内存地址、寄存器编号。我们在使用符号级调试器的时候，有时候会改变变量值（迭代变量、函数参数、函数返回值等等）来控制程序执行逻辑。其实在指令级调试时，也是有这样的需求去修改内存中的数据、寄存器中的数据，所以我们需要有修改内存命令setmem、修改寄存器命令setreg命令。

ps: 当然从易用性角度来说，可以使用一个set命令来实现setmem、setreg、setvar，但是我们是为了教学目的，所以每个操作最好相对独立，这样逻辑清晰简单、篇幅也更简短。

### 代码实现

godbg中的实现也非常简单，接收用户输入的寄存器名args[0]、要设置的值args[1]，然后通过 `syscall.PtraceGetRegs(...)` 操作拿到所有寄存器的值regs，并通过反射找到代表对应寄存器名的字段(如regs.rax)，并修改字段值，最后将修改后的regs再通过 `syscall.PtraceSetRegs(...)` 设置回寄存器。

```go
package debug

import (
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"

	"github.com/hitzhangjie/godbg/pkg/target"
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

		// 检查是否有调试进程
		if target.DBPProcess == nil {
			return errors.New("please attach to a process first")
		}

		regName := strings.ToLower(args[0])
		valueStr := args[1]

		// 解析值参数
		value, err := strconv.ParseUint(valueStr, 0, 64)
		if err != nil {
			return fmt.Errorf("invalid value format: %s", valueStr)
		}

		// 读取当前寄存器状态
		regs, err := target.DBPProcess.ReadRegister()
		if err != nil {
			return fmt.Errorf("failed to read registers: %v", err)
		}

		// 使用反射设置寄存器值
		rv := reflect.ValueOf(regs).Elem()
		rt := reflect.TypeOf(*regs)

		var fieldFound bool
		for i := 0; i < rv.NumField(); i++ {
			fieldName := strings.ToLower(rt.Field(i).Name)
			if fieldName == regName {
				// 设置新值
				rv.Field(i).SetUint(value)
				fieldFound = true

				// 写回寄存器
				err = target.DBPProcess.WriteRegister(regs)
				if err != nil {
					return fmt.Errorf("failed to write register %s: %v", regName, err)
				}
				break
			}
		}

		if !fieldFound {
			return fmt.Errorf("invalid register name: %s", regName)
		}
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(setRegCmd)
}
```

### 代码测试1：修改寄存器值并查看

首先我们先执行一个简单的测试：

```bash
$ while [ 1 -eq 1 ]; do echo $$; sleep 1; done
1521639
1521639
1521639
1521639
1521639
1521639
1521639 <= godbg attach 1521639

```

然后我们执行调试跟踪：

```bash
root🦀 ~ $ godbg attach 1521639
process 1521639 attached succ
process 1521639 stopped: true
godbg> 

godbg> pregs                            <= pregs显示当前寄存器信息，其中R12=0x1
Register    R15         0x7ffd8a1e55e0      
Register    R14         0x0                 
Register    R13         0x7ffd8a1e56b0      
Register    R12         0x1                 
Register    Rbp         0x0                 
Register    Rbx         0xa                 
Register    R11         0x246               
Register    R10         0x0                 
...              
godbg> setreg r12 0x2                   <= 执行setreg命令修改R12=0x2
godbg> pregs                            <= 再次查看当前寄存器信息，R12=0x2，修改成功
Register    R15         0x7ffd8a1e55e0      
Register    R14         0x0                 
Register    R13         0x7ffd8a1e56b0      
Register    R12         0x2                 
Register    Rbp         0x0                 
Register    Rbx         0xa                 
Register    R11         0x246               
Register    R10         0x0                 
...           
godbg> 
```

OK，这个测试演示了调试精灵setreg基本的用法和执行效果。

有的读者可能会想，什么情况下我需要显示修改寄存器，真有这种情景吗？下面咱们就来看一个相对更实际的案例。

### 代码测试2：篡改返回值跳出循环

#### 无法修改返回变量值来跳出循环 :(

我们先实现一个测试程序，该测试程序每隔1s打印一下进程pid，for-loop的循环条件是一个固定返回true的函数loop()，我们想通过修改寄存器的方式来篡改函数调用 `loop()`的返回值来实现。

file: main.go

```go
package main

import (
	"fmt"
	"os"
	"time"
)

func main() {
	for loop() {
		fmt.Println("pid:", os.Getpid())
		time.Sleep(time.Second)
	}
}

//go:noinline
func loop() bool {
	return true
}

```

这里的挑战点在于，`for loop() {}` 而不是 `for v := true; v ; v = loop() {}`，在loop函数体内部是 `return true` 而不是 `v := true; return v`。我们既不能通过 `set <varName> <Value>` 来修改loop()返回值的值，也不能修改loop函数体内部return的值。

此时我们只能在返回前修改ret指令的操作数的值，或者loop函数调用返回后修改返回值寄存器的值。修改ret指令的操作数寄存器也可以，我们这里演示修改返回值寄存器RAX。

#### 修改返回值寄存器RAX来跳出循环

我们首先上述目标程序编译构建，然后运行起来：

```bash
$ go build -gcflags 'all=-N -l' -o main ./main.go
$ ./main
pid: 2746680
pid: 2746680
pid: 2746680
pid: 2746680
pid: 2746680
...
```

我们需要先借助dlv来帮助我们确定下函数调用loop()时的返回指令地址：

```bash
$ dlv attach 2746680
```

然后我们需要在main.go:10这行设置断点，这行也就是调用loop()的地方：

```bash
$ break main.go:10
Breakpoint 1 set at 0x49b5d4 for main.main() ./fuck/test/main.go:10
```

然后执行到断点处：

```bash
$ continue
> [Breakpoint 1] main.main() ./fuck/test/main.go:10 (hits goroutine(1):1 total:1) (PC: 0x49b5d4)
     5:		"os"
     6:		"time"
     7:	)
     8:
     9:	func main() {
=>  10:		for loop() {
    11:			fmt.Println("pid:", os.Getpid())
    12:			time.Sleep(time.Second)
    13:		}
    14:	}
```

现在我们需要等这个loop()函数调用返回，我们需要知道返回后的返回地址，并在返回地址处设置断点：

```bash
(dlv) disass
TEXT main.main(SB) /root/fuck/test/main.go
	main.go:9	0x49b5c0	493b6610		cmp rsp, qword ptr [r14+
0x10]
	main.go:9	0x49b5c4	0f86fb000000		jbe 0x49b6c5
	main.go:9	0x49b5ca	55			push rbp
	main.go:9	0x49b5cb	4889e5			mov rbp, rsp
	main.go:9	0x49b5ce	4883ec70		sub rsp, 0x70
	main.go:10	0x49b5d2	eb00			jmp 0x49b5d4
=>	main.go:10	0x49b5d4*	e807010000		call $main.loop
	main.go:10	0x49b5d9	8844241f		mov byte ptr [rsp+0x1f],al
```

现在我们知道 `call $main.loop` 后的返回地址为0x49b5d9，现在可以退出dlv并保持tracee运行：

```bash
(dlv) exit
Would you like to kill the process? [Y/n] n
```

然后，我们后续使用godbg在这个地址处设置断点，注意我们也没有启用ALSR，所以这个地址是不变的：

```bash
godbg attach 2746680
process 2746680 attached succ
process 2746680 stopped: true
godbg> break 0x49b5d9
godbg> 
```

然后我们需要执行到这个断点处，此处loop()刚刚返回，根据ABI调用约定，RAX中存储着loop()的返回值，我们再通过setreg来修改rax的值为“false”。

```bash
godbg> continue
thread 2746680 continued succ
thread 2746681 continued succ
thread 2746682 continued succ
thread 2746683 continued succ
thread 2746684 continued succ
thread 2746680 status: stopped: trace/breakpoint trap
```

然后修改寄存器的值：

```bash
godbg> pregs
Register    R15         0x9                 
Register    R14         0xc0000061c0        
Register    R13         0x20                
Register    R12         0x7ffe2df6ce18      
Register    Rbp         0xc0000c6f68        
Register    Rbx         0x43cdfc            
Register    R11         0x206               
Register    R10         0x0                 
Register    R9          0x0                 
Register    R8          0x0                 
Register    Rax         0x1          // <= true
...
godbg> setreg rax 0x0                // <= false
```

然后continue恢复执行，观察到恢复执行后有些线程开始退出了，但是也还有继续运行到断点的线程：

```bash
godbg> continue
warn: thread 2746681 exited
warn: thread 2746682 exited
warn: thread 2746683 exited
...
continue ok
```

我们结束调试，结束调试时会清理断点并将暂停在断点处的线程rewind PC (PC=PC-1)，然后detach，这样被调试进程会恢复执行：

```bash
godbg> exit
before detached, clearall created breakpoints.warn: thread 3037322 exited
```

此时，再来观察被调试程序及其输出：

```bash
$ ./main
pid: 2746680
pid: 2746680
pid: 2746680
pid: 2746680
pid: 2746680 <= 调试器修改了loop()调用的返回值为FALSE，该返回值存储在寄存器RAX
$            <= 然后循环条件检测不通过，退出了循环，程序结束
```

我们通过调试器篡改函数调用返回值，让程序执行跳出了for循环。

### 本节小结

本节主要探讨了调试器中修改寄存器数据的功能实现，核心内容包括：通过 `ptrace(PTRACE_SET_REGS,...)`系统调用实现寄存器修改；使用反射机制动态定位和修改特定寄存器字段；结合 `setreg`命令实现通用的寄存器修改功能。本节通过篡改函数返回值寄存器RAX的实例，演示了如何利用寄存器修改来控制程序执行流程，为读者展示了指令级调试中修改程序状态的强大能力。这种技术不仅适用于修改函数返回值，还可以结合栈帧知识修改函数参数和返回地址，为深入的程序调试和逆向分析提供了重要工具。
