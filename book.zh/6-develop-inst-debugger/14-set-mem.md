## 修改进程状态(内存)

### 实现目标: 修改内存数据

添加、移除断点过程中其实也是对内存数据做修改，只不过断点操作是修改的指令数据，而我们这里强调的是对数据做修改。指令级调试器对内存数据做修改，其实没有符号级调试器直接通过变量名来修改容易，对调试人员的要求比较高。因为如果不知道什么数据在内存什么位置，是什么类型，占多少字节，所以不好修改。符号级调试器就简单多了，直接通过变量名来修改就可以。

本节我们还是要演示下对内存数据区数据做修改的操作，介绍下大致的交互，以及用到的系统调用 `ptrace(PTRACE_POKEDATA,...)` ，为我们后续符号级调试器里通过变量名来修改值也提前做个技术准备。严格来说我们应该提供一个通用的修改内存的调试命令 `set <addr> <value>` 。OK，我们先还是先介绍如何修改任意指定地址处的内存数据，然后会在 godbg 中实现此功能。

### 代码实现

我们实现一个程序，该程序会跟踪被调试进程，然后会提示输入变量的地址和新变量值，然后我们将变量地址处的内存数据修改为新变量值。

那如何确定这个变量的地址呢？我们会实现一个go程序，编译构建启动后，我们会先用dlv这个符号级调试器来跟踪它，然后确定它的变量地址后，再detach，然后再交给我们这里的程序来attach被调试进程，就可以输入准确的变量地址、新变量值进行测试了。

OK，我们看下这里的程序的实现。

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

	// step2: supposing running list and disass <locspec> go get the address of interested code
	time.Sleep(time.Second * 2)

	var input string
	fmt.Fprintf(os.Stdout, "enter a address you want to modify data\n")
	_, err = fmt.Fscanf(os.Stdin, "%s", &input)
	if err != nil {
		panic("read address fail")
	}
	addr, err := strconv.ParseUint(input, 0, 64)
	if err != nil {
		panic(err)
	}
	fmt.Fprintf(os.Stdout, "you entered %0x\n", addr)

	fmt.Fprintf(os.Stdout, "enter a value you want to change to\n")
	_, err = fmt.Fscanf(os.Stdin, "%s", &input)
	if err != nil {
		panic("read value fail")
	}
	val, err := strconv.ParseUint(input, 0, 64)
	if err != nil {
		panic("read value fail")
	}
	fmt.Fprintf(os.Stdout, "you entered %x\n", val)
	fmt.Fprintf(os.Stdout, "we'll set *(%x) = %x\n", addr, val)

	// step2: supposing runnig step here
	time.Sleep(time.Second * 2)
	fmt.Fprintf(os.Stdout, "===step2===: supposing running `dlv> set *addr = 0xaf` here\n")

	var data [1]byte
	n, err := syscall.PtracePeekText(int(pid), uintptr(addr), data[:])
	if err != nil || n != 1 {
		fmt.Fprintf(os.Stderr, "read data fail: %v\n", err)
		os.Exit(1)
	}

	n, err = syscall.PtracePokeText(int(pid), uintptr(addr), []byte{byte(val)})
	if err != nil || n != 1 {
		fmt.Fprintf(os.Stderr, "write data fail: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stdout, "change data from %x to %d succ\n", data[0], val)
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

下面来说明下这里的测试方法，为了方便测试我们需要先准备一个测试程序，方便我们好获取某个变量的地址，然后我们修改这个变量的值，通过程序执行效果来印证修改是否生效。

1、首先我们准备了一个测试程序 testdata/loop.go

   这个程序通过一个for循环每隔1s打印当前进程的pid，循环控制变量loop默认为true。

```go
   package main
   
   import (
   	"fmt"
   	"os"
   	"time"
   )
   
   func main() {
   	loop := true
   	for loop {
   		fmt.Println("pid:", os.Getpid())
   		time.Sleep(time.Second)
   	}
   }
```

2、我们先构建并运行这个程序，注意为了变量被优化掉我们构建时需要禁用优化：`go build -gcflags 'all=-N -l'`

```bash
   $ cd../testdata && make
   $./loop
   pid:49701
   pid:49701
   pid:49701
   pid:49701
   pid:49701
   ...
```

3、然后我们借助dlv来观察变量loop的内存位置

```bash
   $dlvattach49701

   (dlv) b loop.go:11
    Breakpoint 1 set at 0x4af0f9 for main.main() ./debugger101/golang-debugger-lessons/testdata/loop.go:11
    (dlv) c
    > [Breakpoint 1] main.main() ./debugger101/golang-debugger-lessons/testdata/loop.go:11 (hitsgoroutine(1):1total:1) (PC:0x4af0f9)
         6:         "time"
         7: )
         8:
         9:funcmain() {
        10:         loop:=true
    =>  11:         forloop{
        12:                 fmt.Println("pid:",os.Getpid())
        13:                 time.Sleep(time.Second)
        14:         }
        15:}
    (dlv) p &loop
    (*bool)(0xc0000caf17)
    (dlv) x 0xc0000caf17
    0xc0000caf17:   0x01
    ...
    ```

3、然后我们让dlv进程退出恢复loop的执行

   ```bash
   (dlv) quit
   Would you like to kill the process? [Y/n] n
```

4、然后我们执行自己的程序

```bash
   $ ./14_set_mem 49701
    ===step1===: supposing running `dlv attach pid` here
    process 49701 attach succ
    process 49701 stopped
    tracee stopped at 476203

    enter a address you want to modify data         <= input address of variable `loop`
    0xc0000caf17
    you entered c0000caf17

    enter a value you want to change to             <= input false of variable `loop`
    0x00
    you entered 0

    we'll set *(c0000caf17) = 0                     <= do loop=false

    ===step2===: supposing running `dlv> set *addr = 0xaf` here     <= do loop=false succ
    change data from 1 to 0 succ
```

   此时，由于 `loop=false` 所以 `for loop {...}` 循环结束，程序会执行到结束。

```bash
    pid:49701
    pid:49701
    pid:49701                       <= tracee exit successfully for `loop=false`
    zhangjie🦀testdata(master) $
```

### 本文小结

本文我们实现了指令级调试器修改任意内存地址处的数据的功能，这个功能非常重要，我们都知道修改内存数据对于调试修改程序执行行为的重要性。了解了这里的实现技术后，我们将在实现符号级调试时继续实现对变量值的修改，对于实用高级语言进行开发的开发者来说，调整变量值是一个非常重要的观察程序执行行为的功能。

下一节我们将继续查看下如何修改寄存器的值，这在某些调试场景下也是很重要的。
