## 修改进程状态(寄存器)

### 实现目标：修改寄存器数据

在执行到断点后继续执行前，我们需要恢复PC-1处的指令数据，并且需要修改寄存器PC=PC-1。这里我们已经展示过如何读取并且修改寄存器数据了，但是它的修改动作是内置于continue调试命令中的。而我们这里需要的是一个通用的调试命令 `set <register> <value>` ，OK，我们确实需要一个这样的调试命令，尤其是对指令级调试器而言，指令的操作数不是立即数、内存地址，就是寄存器。我们将在 godbg 中实现这个修改任意寄存器的调试命令。但本节还是以具体案例来说明掌握这个操作的必要性以及掌握如何实现为主要目的。

### 代码实现

我们将先实现一个测试程序，该测试程序每隔1s打印一下进程pid，for-loop的循环条件是一个固定返回true的函数loop()，我们想通过修改寄存器的方式来篡改函数调用loop()的返回值来实现。

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

4、现在运行我们编写的调试工具 ./15_set_regs 4946,

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

### 本文小结

本节我们也介绍了如何修改寄存器的值，也通过具体实例演示了通过修改寄存器来篡改函数返回值的案例，当然你如果对栈帧构成了解的够细致，结合读写寄存器、内存操作，也可以修改函数调用参数、返回地址。
