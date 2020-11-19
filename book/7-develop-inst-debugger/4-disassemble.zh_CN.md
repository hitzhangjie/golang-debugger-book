## 反汇编

### 实现目标：实现反汇编

反汇编是指令级调试过程中不可缺少的环节，对于符号级调试需要展示源码信息，对于指令级调试而言就是要展示汇编指令了。

汇编指令是和硬件强相关的，其实汇编指令不过是些助记符，一条汇编指令的操作码、操作数通过规定的编码方式进行编码，就得到了机器指令。不同指令的操作码占用字节数可能是相同的，也可能是不同的，操作数占用字节数也可能相同或不同。

汇编指令本来就有很多，除了指令定长、变长编码以外，还有些其他因素也给反汇编带来了一定的难度，比如我们有非常多的硬件平台，有不同的指令集架构等等，要想实现反汇编还真的不是一件容易的事情。

幸好已经有反汇编框架[Capstone](http://www.capstone-engine.org/)来专门解决这个问题，对于go语言而言可以考虑使用go版本的[Gapstone](https://github.com/bnagy/gapstone)。或者，我们使用go官方提供的反汇编工具类[arch/x86/x86asm](https://golang.org/x/arch/x86/x86asm)，注意到在流行的go语言调试器dlv里面也是使用x86asm进行反汇编操作的。

为了简单起见，我们也将使用arch/x86/x86asm来完成反汇编任务，当然使用Capstone、Gapstone也并非不可以，如果读者感兴趣可以自行实验。

### 代码实现

实现反汇编操作，这里的任务也分几步，我们首先掌握对一个完整的程序进行反汇编操作，然后再进一步获取当前断点处指令地址，并对指令地址处机器指令进行反汇编操作。

#### 根据pid找到可执行程序

调试器和被调试进程的交互，很多操作都需要依赖pid，如果我们要读取pid对应的可执行程序的指令数据，那就必须先通过pid找到对应的可执行程序路径，怎么做呢？

在Linux系统下，虚拟文件系统路径`/proc/<pid>/exe`是一个符号链接，它指向了`pid`标识的进程对应的可执行程序文件的路径。在go程序里面读取该符号链接指向的目的位置就可以了。

比如这样操作：

```go
package main

// GetExecutable 根据pid获取可执行程序路径
func GetExecutable(pid int) (string, error) {
	exeLink := fmt.Sprintf("/proc/%d/exe", pid)
	exePath, err := os.Readlink(exeLink)
	if err != nil {
		return "", err
	}
	return exePath, nil
}
```

#### 实现对完整程序反汇编

根据pid找到可执行程序文件路径之后，可以尝试读取文件内容，为接下来反汇编做准备。但要注意的是，Linux二进制可执行程序是有结构的，`ioutil.ReadFile(fname)`虽然可以读取内容但是却不能解析`ELF (Executable and Linkable Format)`的结构。

对于ELF文件格式而言，其大致的结构如下所示：

![elf](assets/elf_layout.png)

我们看到一个ELF Header包含了`Program Header (Segments)`、`Section Header (Sections)`以及一系列的Data。

这其实是ELF格式为构建两种不同的视图所特意设计的：

- segments视图，是为linker提供的视图，用来指导linker如何执行segments中指令；
- 另一种视图就是将指令和数据进行区分的视图，如指令和数据secitions的区分；

那现在我们要想实现反汇编操作的话，我们就必须能够将ELF文件解析成上述格式，并能够从提取出程序对应的机器指令。

下面我们就来做这个事情：

```go
package main

import (
	"debug/elf"
	"fmt"
	"os"
	"strconv"

	"golang.org/x/arch/x86/x86asm"
)

func main() {

    // go run main.go <pid>
	if len(os.Args) != 2 {
		panic("invalid params")
	}

	// pid
	pid, err := strconv.Atoi(os.Args[1])
	if err != nil {
		panic(err)
	}

	// 通过pid找到可执行程序路径
	exePath, err := GetExecutable(pid)
	if err != nil {
		panic(err)
	}
	fmt.Println(exePath)

	// 读取指令信息并反汇编
	elfFile, err := elf.Open(exePath)
	if err != nil {
		panic(err)
	}
	section := elfFile.Section(".text")
	buf, err := section.Data()
	if err != nil {
		panic(err)
	}

    // 逐语句解析机器指令并反汇编，然后打印出来
	offset := 0
	for {
		inst, err := x86asm.Decode(buf[offset:], 64)
		if err != nil {
			panic(err)
		}
		fmt.Printf("%8x %s\n", offset, inst.String())
		offset += inst.Len
	}
}
```

这里的代码逻辑比较完整，它接收一个pid，然后获取对应的可执行文件路径，然后通过标准库提供的elf package来取文件并解析成ELF文件。从中读取.text section的数据。众所周知，.text端内部数据即为程序的执行指令。

拿到指令之后，我们就可以通过官方提供的golang.org/x/arch/x86/x86asm来进行反汇编操作了，因为指令是变长编码，反汇编成功后返回的信息中包含了当前反汇编指令的内存编码数据长度，方便我们调整偏移量继续进行反汇编。

#### 对断点位置进行反汇编

对断点位置进行反汇编，首要任务就是获得当前断点的位置。

动态断点，往往是通过指令patch来实现的，即将任意完整机器指令的第一字节数据保存，然后将其替换成`0xCC (int 3)`指令，处理器执行完0xCC之后自身就会停下来，这就是断点的效果。

断点通过指令patch来实现必须覆盖指令的第一字节，不能覆盖其他字节，原因很简单，指令为了提高解码效率、支持更多操作类型，往往都是采用的变长编码。如果不写第一字节，那么可能会产生错误，或者造成解析时困难。比如，如果一条指令只有一个字节，我们非要写到第二个字节存起来，那就起不到断点的作用。因为执行到这个断点时，前面本不应该执行的一字节指令执行了。

前面我们有系统性地介绍过指令patch的概念、应用场景等（比如调试器、mock测试框架gomonkey等等），如您还感到不熟悉，请回头查看相关章节，或者问下google。

假如说当前我们的断点位于offset处，现在要执行反汇编动作，大致有如下步骤：

```bash
断点添加之前：
offset:  0x0 0x1 0x2 0x3 0x4

断点添加之后：
offset: 0xcc 0x1 0x2 0x3 0x4   | orig: <offset,0x0>
```

- 首先，要知道0xCC执行后会暂停执行，执行后，意味着此时PC=offset+1
- 再次，要知道offset处的指令不是完整整理，第一字节指令被patch了，需要还原；
- 最后，要知道PC值是特殊寄存器值，要将其PC值减去1，让指令执行位置往后退1字节，然后重新读取接下来的指令；

这大概就是断点位置的相关操作，如果对应位置处不是断点就不需要执行pc=pc-1这一rewind动作。

#### Put It Together

经过上面一番讨论之后，得到了下面的反汇编实现：

```go
package debug

import (
	"fmt"
	"os"
	"syscall"

	"github.com/spf13/cobra"
	"golang.org/x/arch/x86/x86asm"
)

var disassCmd = &cobra.Command{
	Use:   "disass <locspec>",
	Short: "反汇编机器指令",
	Annotations: map[string]string{
		cmdGroupKey: cmdGroupSource,
	},
	RunE: func(cmd *cobra.Command, args []string) error {

		// 读取PC值
		regs := syscall.PtraceRegs{}
		err := syscall.PtraceGetRegs(TraceePID, &regs)
		if err != nil {
			return err
		}

		buf := make([]byte, 1)
		n, err := syscall.PtracePeekText(TraceePID, uintptr(regs.PC()), buf)
		if err != nil || n != 1 {
			return fmt.Errorf("peek text error: %v, bytes: %d", err, n)
		}
		fmt.Printf("read %d bytes, value of %x\n", n, buf[0])
		// read a breakpoint
		if buf[0] == 0xCC {
			regs.SetPC(regs.PC() - 1)
		}

		// 查找，如果之前设置过断点，将恢复
		dat := make([]byte, 1024)
		n, err = syscall.PtracePeekText(TraceePID, uintptr(regs.PC()), dat)
		if err != nil {
			return fmt.Errorf("peek text error: %v, bytes: %d", err, n)
		}
		fmt.Printf("size of text: %d\n", n)

		// 反汇编这里的指令数据
		offset := 0
		for {
			inst, err := x86asm.Decode(dat[offset:], 64)
			if err != nil {
				return fmt.Errorf("x86asm decode error: %v", err)
			}
			fmt.Printf("%8x %s\n", offset, inst.String())
			offset += inst.Len
		}
	},
}

func init() {
	debugRootCmd.AddCommand(disassCmd)
}

// GetExecutable 根据pid获取可执行程序路径
func GetExecutable(pid int) (string, error) {
	exeLink := fmt.Sprintf("/proc/%d/exe", pid)
	exePath, err := os.Readlink(exeLink)
	if err != nil {
		return "", err
	}
	return exePath, nil
}
```

### 代码测试

我们随便写一个go程序，让其运行起来，查看其pid为2507，随后执行`godbg attach 2507`开始对目标进程进行调试。

调试会话启动之后，我们直接输入disass命令进行反汇编，注意我们没有设置断点，因为我们还没有完成breakpoint命令的实现逻辑。不管怎样，我们的反汇编结果功能是正常的，可以看到正常的输出。

```bash
$ godbg attach 2507
process 2507 attached succ
process 2507 stopped: true

godbg> disass
read 1 bytes, value of 89
size of text: 1024
       0 MOV [RSP+Reg(0)+0x20], EAX
       4 RET
       5 INT 0x3
      ..........
      1e INT 0x3
      1f INT 0x3
      20 MOV EDI, [RSP+Reg(0)+0x8]
      24 MOV RSI, 0x2
      2b MOV RDX, 0x1
      32 MOV EAX, 0x48
      37 SYSCALL
      39 RET
      ..........
     100 CMP [RAX+0x8], RCX
     104 JE .+60
     106 XOR ECX, ECX
     108 TEST CL, CL
     10a JNE .+16
     10c XOR EAX, EAX
     10e MOV [RSP+Reg(0)+0x40], AL
     112 MOV RBP, [RSP+Reg(0)+0x20]
     117 ADD RSP, 0x28
     11b RET
     11c LEA RCX, [RDX+0x18]
     120 MOV [RSP+Reg(0)], RCX
     124 ADD RAX, 0x18
      ..........
     3fd INT 0x3
     3fe INT 0x3
     3ff INT 0x3
     Error: x86asm decode error: truncated instruction
```

我们也注意到最后一行有错误信息，提示“truncated instruction”，这是因为我们固定了读取指令的buffer是1024 bytes，可能有一条最后的指令没有完全读取过来，所以进行decode的时候这条指令失败了。

这里的失败是符合预期的、无害的，我们调试过程中，不会显示这么多汇编指令，只会显示断点附近的几十条指令而已，对于decode失败的buffer末尾几条指令简单忽略就可以。

现在我们已经实现了反汇编的功能，下一节，我们将通过指令patch来实现动态断点的添加、移除。