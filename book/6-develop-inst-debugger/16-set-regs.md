## 修改进程状态：修改寄存器

### 实现目标：修改寄存器数据
我们已经展示过如何读取并且修改寄存器数据了，比如continue命令执行时，如果当前PC-1处是软件断点0xCC，我们需要重置断点并且设置寄存器PC=PC-1。

和当时设置PC=PC-1相同，我们这里用到的寄存器修改方法仍然是通过`ptrace(PTRACE_SET_REGS,...)`。所不同的是本小节要实现一个通用的寄存器修改命令 `setreg <registerName> <value>` 。

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

### 代码测试

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

### 代码测试2: 篡改返回值跳出循环

#### :) 无法修改返回变量值来跳出循环

我们先实现一个测试程序，该测试程序每隔1s打印一下进程pid，for-loop的循环条件是一个固定返回true的函数loop()，我们想通过修改寄存器的方式来篡改函数调用`loop()`的返回值来实现。

```go
package main

import (
	"fmt"
	"os"
	"runtime"
	"time"
)

func main() {
	runtime.LockOSThread()

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

这里的挑战点在于，`for loop() {}` 而不是 `for v := true; v ; v = loop() {}`，在loop函数体内部是 `return true` 而不是 `v := true; return v`。我们既不能通过 `set <var> <value>` 来修改loop返回值的值，也不能修改函数体内部return的变量值。

此时我们只能在返回前修改ret指令的操作数的值，或者loop函数调用返回后修改返回值寄存器的值。修改ret指令的操作数寄存器也可以，我们这里演示修改返回值寄存器RAX。

#### 写个程序模拟下篡改返回值的操作

TODO: 改成使用godbg进行调试，代替这里冗长的单文件测试。

下面是我们写的调试程序，它首先attach被调试进程，然后提示我们获取并输入loop()函数调用的返回地址，然后它就会通过添加断点、运行到该断点位置，然后调整寄存器RAX的值（loop()返回值就存在RAX），再然后恢复执行，我们将看到程序跳出了循环。

```go
package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"syscall"
	"time"
)

var usage = `Usage:
	go run main.go <pid>

	args:
	- pid: specify the pid of process to attach
`

func main() {
	runtime.LockOSThread()

	if len(os.Args) != 2 {
		fmt.Println(usage)
		os.Exit(1)
	}

	// pid
	pid, err := strconv.Atoi(os.Args[1])
	if err != nil {
		panic(err)
	}

	if !checkPid(int(pid)) {
		fmt.Fprintf(os.Stderr, "process %d not existed\n\n", pid)
		os.Exit(1)
	}

	// step1: supposing running dlv attach here
	fmt.Fprintf(os.Stdout, "===step1===: supposing running `dlv attach pid` here\n")

	// attach
	err = syscall.PtraceAttach(int(pid))
	if err != nil {
		fmt.Fprintf(os.Stderr, "process %d attach error: %v\n\n", pid, err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stdout, "process %d attach succ\n\n", pid)

	// check target process stopped or not
	var status syscall.WaitStatus
	var options int
	var rusage syscall.Rusage

	_, err = syscall.Wait4(int(pid), &status, options, &rusage)
	if err != nil {
		fmt.Fprintf(os.Stderr, "process %d wait error: %v\n\n", pid, err)
		os.Exit(1)
	}
	if !status.Stopped() {
		fmt.Fprintf(os.Stderr, "process %d not stopped\n\n", pid)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stdout, "process %d stopped\n\n", pid)

	regs := syscall.PtraceRegs{}
	if err := syscall.PtraceGetRegs(int(pid), &regs); err != nil {
		fmt.Fprintf(os.Stderr, "get regs fail: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stdout, "tracee stopped at %0x\n", regs.PC())

	// step2: supposing running `dlv> b <addr>`  and `dlv> continue` here
	time.Sleep(time.Second * 2)
	fmt.Fprintf(os.Stdout, "===step2===: supposing running `dlv> b <addr>`  and `dlv> continue` here\n")

	// read the address
	var input string
	fmt.Fprintf(os.Stdout, "enter return address of loop()\n")
	_, err = fmt.Fscanf(os.Stdin, "%s", &input)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read address fail\n")
		os.Exit(1)
	}
	addr, err := strconv.ParseUint(input, 0, 64)
	if err != nil {
		panic(err)
	}
	fmt.Fprintf(os.Stdout, "you entered %0x\n", addr)

	// add breakpoint and run there
	var orig [1]byte
	if n, err := syscall.PtracePeekText(int(pid), uintptr(addr), orig[:]); err != nil || n != 1 {
		fmt.Fprintf(os.Stderr, "peek text fail, n: %d, err: %v\n", n, err)
		os.Exit(1)
	}
	if n, err := syscall.PtracePokeText(int(pid), uintptr(addr), []byte{0xCC}); err != nil || n != 1 {
		fmt.Fprintf(os.Stderr, "poke text fail, n: %d, err: %v\n", n, err)
		os.Exit(1)
	}
	if err := syscall.PtraceCont(int(pid), 0); err != nil {
		fmt.Fprintf(os.Stderr, "ptrace cont fail, err: %v\n", err)
		os.Exit(1)
	}

	_, err = syscall.Wait4(int(pid), &status, options, &rusage)
	if err != nil {
		fmt.Fprintf(os.Stderr, "process %d wait error: %v\n\n", pid, err)
		os.Exit(1)
	}
	if !status.Stopped() {
		fmt.Fprintf(os.Stderr, "process %d not stopped\n\n", pid)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stdout, "process %d stopped\n\n", pid)

	// step3: supposing change register RAX value from true to false
	time.Sleep(time.Second * 2)
	fmt.Fprintf(os.Stdout, "===step3===: supposing change register RAX value from true to false\n")
	if err := syscall.PtraceGetRegs(int(pid), &regs); err != nil {
		fmt.Fprintf(os.Stderr, "ptrace get regs fail, err: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stdout, "before RAX=%x\n", regs.Rax)

	regs.Rax &= 0xffffffff00000000
	if err := syscall.PtraceSetRegs(int(pid), &regs); err != nil {
		fmt.Fprintf(os.Stderr, "ptrace set regs fail, err: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stdout, "after RAX=%x\n", regs.Rax)

	// step4: let tracee continue and check it behavior (loop3.go should exit the for-loop)
	if n, err := syscall.PtracePokeText(int(pid), uintptr(addr), orig[:]); err != nil || n != 1 {
		fmt.Fprintf(os.Stderr, "restore instruction data fail: %v\n", err)
		os.Exit(1)
	}
	if err := syscall.PtraceCont(int(pid), 0); err != nil {
		fmt.Fprintf(os.Stderr, "ptrace cont fail, err: %v\n", err)
		os.Exit(1)
	}
}

// checkPid check whether pid is valid process's id
//
// On Unix systems, os.FindProcess always succeeds and returns a Process for
// the given pid, regardless of whether the process exists.
func checkPid(pid int) bool {
	out, err := exec.Command("kill", "-s", "0", strconv.Itoa(pid)).CombinedOutput()
	if err != nil {
		panic(err)
	}

	// output error message, means pid is invalid
	if string(out) != "" {
		return false
	}

	return true
}

```

### 代码测试

测试方法：

1、首先我们准备一个测试程序，loop3.go，该程序每隔1s输出一下pid，循环由固定返回true的loop()函数控制
   详见 `testdata/loop3.go`。

2、按照ABI调用惯例，这里的函数调用loop()的返回值会通过RAX寄存器返回，所以我们想在loop()函数调用返回后，通过修改RAX寄存器的值来篡改返回值为false。

那我们先确定下loop()函数的返回地址，这个只要我们通过dlv调试器在loop3.go:13添加断点，然后disass，就可以确定返回地址为 0x4af15e。

确定完返回地址后我们即可detach tracee，恢复其执行。

```bash
(dlv) disass
Sending output to pager...
TEXT main.main(SB) /home/zhangjie/debugger101/golang-debugger-lessons/testdata/loop3.go
        loop3.go:10     0x4af140        493b6610                cmp rsp, qword ptr [r14+0x10]
        loop3.go:10     0x4af144        0f8601010000            jbe 0x4af24b
        loop3.go:10     0x4af14a        55                      push rbp
        loop3.go:10     0x4af14b        4889e5                  mov rbp, rsp
        loop3.go:10     0x4af14e        4883ec70                sub rsp, 0x70
        loop3.go:11     0x4af152        e8e95ef9ff              call $runtime.LockOSThread
        loop3.go:13     0x4af157        eb00                    jmp 0x4af159
=>      loop3.go:13     0x4af159*       e802010000              call $main.loop
        loop3.go:13     0x4af15e        8844241f                mov byte ptr [rsp+0x1f], al
        ...
(dlv) quit
Would you like to kill the process? [Y/n] n
```

3、如果我们不加干扰，loop3会每隔1s不停地输出pid信息。

```bash
$ ./loop3
pid: 4946
pid: 4946
pid: 4946
pid: 4946
pid: 4946
...
zhangjie🦀 testdata(master) $
```

4、现在运行我们编写的调试工具 ./16_set_regs 4946,

```bash
$ ./15_set_regs 4946
===step1===: supposing running `dlv attach pid` here
process 4946 attach succ
process 4946 stopped
tracee stopped at 476263

===step2===: supposing running `dlv> b <addr>`  and `dlv> continue` here
enter return address of loop()
0x4af15e

you entered 4af15e
process 4946 stopped

===step3===: supposing change register RAX value from true to false
before RAX=1
after RAX=0                   <= 我们篡改了返回值为0
```


```bash

```


```bash
...
pid: 4946
pid: 4946
pid: 4946                      <= 因为篡改了loop()的返回值为false，循环跳出，程序结束
zhangjie🦀 testdata(master) $
```

```bash
(dlv) disass
TEXT main.loop(SB) /home/zhangjie/debugger101/golang-debugger-lessons/testdata/loop3.go
        loop3.go:20     0x4af260        55              push rbp
        loop3.go:20     0x4af261        4889e5          mov rbp, rsp
=>      loop3.go:20     0x4af264*       4883ec08        sub rsp, 0x8
        loop3.go:20     0x4af268        c644240700      mov byte ptr [rsp+0x7], 0x0
        loop3.go:21     0x4af26d        c644240701      mov byte ptr [rsp+0x7], 0x1
        loop3.go:21     0x4af272        b801000000      mov eax, 0x1 <== 返回值是用eax来存的
        loop3.go:21     0x4af277        4883c408        add rsp, 0x8
        loop3.go:21     0x4af27b        5d              pop rbp
        loop3.go:21     0x4af27c        c3              ret
```

至此，通过这个实例演示了如何设置寄存器值，我们将在 [hitzhangjie/godbg](https://github.com/hitzhangjie/godbg) 中实现godbg> `set reg value` 命令来修改寄存器值。

### 本节小结

本节我们也介绍了如何修改寄存器的值，也通过具体实例演示了通过修改寄存器来篡改函数返回值的案例，当然你如果对栈帧构成了解的够细致，结合读写寄存器、内存操作，也可以修改函数调用参数、返回地址。
