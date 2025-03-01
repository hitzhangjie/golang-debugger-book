## 查看进程状态(内存)

### 实现目标：pmem读取内存数据

这一小节，我们来实现pmem命令，方便调试进程时查看进程内存数据。

### 基础知识

我们知道，内存中的数据是一些0和1序列，要正确展示内存数据，我们需要关注下面这些基本事项：

- 0和1字节序列不是最终形态，数据是有类型的，我们要根据数据类型来解释内存中的数据；
- 不同机器中数据存储是有字节序的，小端（低位数据在低地址）or 大端（低位数据在高地址）；

pmem读取指定内存地址开始的一段数据，并按照指定字节数编组成一个整数，然后以二进制、八进制、十进制或者十六进制的形式打印出来。和常见的查看变量的操作 `print <var>` 不同的是，这里并没有考虑指定位置的数据是什么数据类型 （如一个 `struct{...}` ，`slice`，or `map`)。pmem类似gdb里面的 `x/fmt` 操作。

查看进程内存数据，需要通过 `ptrace(PTRACE_PEEKDATA,...)`操作来读取被调试进程的内存数据。

### 代码实现

#### 第1步：实现进程内存数据读取

首先，我们通过 `ptrace(PTRACE_PEEKDATA,...)` 系统调用实现对内存内数据的读取，每次读取的数据量可以由count和size计算得到：

- size表示一个待读取并显示的数据项包括多少个字节；
- count表示连续读取并显示多少个这样的数据项；

比如一个int数据项可能包含4个字节，要显示8个int数则要指定 `-size=4 -count=8`。

下面的程序读取内存数据，并以16进制数打印读取的字节数据。

**file: cmd/debug/pmem.go**

```go
package debug

import (
	"errors"
	"fmt"
	"strconv"
	"syscall"

	"github.com/spf13/cobra"
)

var pmemCmd = &cobra.Command{
	Use:   "pmem ",
	Short: "打印内存数据",
	Annotations: map[string]string{
		cmdGroupKey: cmdGroupInfo,
	},
	RunE: func(cmd *cobra.Command, args []string) error {

		count, _ := cmd.Flags().GetUint("count")
		format, _ := cmd.Flags().GetString("fmt")
		size, _ := cmd.Flags().GetUint("size")
		addr, _ := cmd.Flags().GetString("addr")

		// check params
		err := checkPmemArgs(count, format, size, addr)
		if err != nil {
			return err
		}

		// calculate size of memory to read
		readAt, _ := strconv.ParseUint(addr, 0, 64)
		bytes := count * size

		buf := make([]byte, bytes, bytes)
		n, err := syscall.PtracePeekData(TraceePID, uintptr(readAt), buf)
		if err != nil || n != int(bytes) {
			return fmt.Errorf("read %d bytes, error: %v", n, err)
		}

		// print result
		fmt.Printf("read %d bytes ok:", n)
		for _, b := range buf[:n] {
			fmt.Printf("%x", b)
		}
		fmt.Println()

		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(pmemCmd)
	// 类似gdb的命令x/FMT，其中FMT=重复数字+格式化修饰符+size
	pmemCmd.Flags().Uint("count", 16, "查看数值数量")
	pmemCmd.Flags().String("fmt", "hex", "数值打印格式: b(binary), o(octal), x(hex), d(decimal), ud(unsigned decimal)")
	pmemCmd.Flags().Uint("size", 4, "数值占用字节")
	pmemCmd.Flags().String("addr", "", "读取的内存地址")
}

func checkPmemArgs(count uint, format string, size uint, addr string) error {
	if count == 0 {
		return errors.New("invalid count")
	}
	if size == 0 {
		return errors.New("invalid size")
	}
	formats := map[string]struct{}{
		"b":  {},
		"o":  {},
		"x":  {},
		"d":  {},
		"ud": {},
	}
	if _, ok := formats[format]; !ok {
		return errors.New("invalid format")
	}
	// TODO make it compatible
	_, err := strconv.ParseUint(addr, 0, 64)
	return err
}

```

#### 第2步：判断字节序及数值解析

```go
// 检测是否是小端字节序
func isLittleEndian() bool {
	buf := [2]byte{}
	*(*uint16)(unsafe.Pointer(&buf[0])) = uint16(0xABCD)

	switch buf {
	case [2]byte{0xCD, 0xAB}:
		return true
	case [2]byte{0xAB, 0xCD}:
		return false
	default:
		panic("Could not determine native endianness.")
	}
}

// 将byteslice转成uint64数值，注意字节序
func byteArrayToUInt64(buf []byte, isLittleEndian bool) uint64 {
	var n uint64
	if isLittleEndian {
		for i := len(buf) - 1; i >= 0; i-- {
			n = n<<8 + uint64(buf[i])
		}
	} else {
		for i := 0; i < len(buf); i++ {
			n = n<<8 + uint64(buf[i])
		}
	}
	return n
}
```

#### 第3步：实现数据"类型"解析

从内存中读取到的数据，应该按照每个数据项占用的字节数 `-size`以及要展示的进制 `-fmt` 对连续字节数据进行编组、解析。且需要考虑二进制、八进制、十进制、十六进制数展示时占用的终端列数问题，每行列数有限，使用不同的进制数情况下，每行适合展示的数字的数量不同。

```go
package debug
...

var pmemCmd = &cobra.Command{
	Use:   "pmem ",
	Short: "打印内存数据",
	Annotations: map[string]string{
		cmdGroupKey: cmdGroupInfo,
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		...
  
		// 该函数以美观的tab+padding对齐方式打印数据
		s := prettyPrintMem(uintptr(readAt), buf, isLittleEndian(), format[0], int(size))
		fmt.Println(s)

		return nil
	},
}

...

// prettyPrintMem 使用tabwriter控制对齐.
//
// 注意结合2、8、10、16进制的显示情况进行适当的格式化处理后，再予以显示，看起来更美观
func prettyPrintMem(address uintptr, memArea []byte, littleEndian bool, format byte, size int) string {

	var (
		cols      int 		// 不同进制数，每行展示的列数(如cols=4， 1 2 3 4)
		colFormat string 	// 不同进制数，每列数字格式化方式（如%08b, 00000001)
		colBytes  = size    // 每列数字占用字节数（如2, 需2个字节，考虑字节序）

		addrLen int
		addrFmt string
	)

	switch format {
	case 'b':
		cols = 4 // Avoid emitting rows that are too long when using binary format
		colFormat = fmt.Sprintf("%%0%db", colBytes*8)
	case 'o':
		cols = 8
		colFormat = fmt.Sprintf("0%%0%do", colBytes*3) // Always keep one leading zero for octal.
	case 'd':
		cols = 8
		colFormat = fmt.Sprintf("%%0%dd", colBytes*3)
	case 'x':
		cols = 8
		colFormat = fmt.Sprintf("0x%%0%dx", colBytes*2) // Always keep one leading '0x' for hex.
	default:
		return fmt.Sprintf("not supprted format %q\n", string(format))
	}
	colFormat += "\t"

	// the number of rows to print
	l := len(memArea)
	rows := l / (cols * colBytes)
	if l%(cols*colBytes) != 0 {
		rows++
	}

	// We should print memory address in the beginnning of every line.
	// And we should use fixed length bytes to print the address for 
	// better readability.
	if l != 0 {
		addrLen = len(fmt.Sprintf("%x", uint64(address)+uint64(l)))
	}
	addrFmt = "0x%0" + strconv.Itoa(addrLen) + "x:\t"

	// use tabwriter to print lines with columns aligned vertically.
	var b strings.Builder
	w := tabwriter.NewWriter(&b, 0, 0, 3, ' ', 0)

	for i := 0; i < rows; i++ {
		fmt.Fprintf(w, addrFmt, address)

		for j := 0; j < cols; j++ {
			offset := i*(cols*colBytes) + j*colBytes
			if offset+colBytes <= len(memArea) {
				n := byteArrayToUInt64(memArea[offset:offset+colBytes], littleEndian)
				fmt.Fprintf(w, colFormat, n)
			}
		}
		fmt.Fprintln(w, "")
		address += uintptr(cols)
	}
	w.Flush()
	return b.String()
}



```

上面的代码读取内存数据逻辑不变，主要是添加了两部分逻辑：

- 根据机器大小端字节序，对内存中读取到的数据进行正确解析，并转换成对应的数值；
- 根据数值要显示的进制格式，结合2、8、16、10进制的宽度，通过fmt.Sprintf进行适当格式化，并结合tabwrite通过tab+padding对齐后输出；

至此pmem命令基本完成开发，我们来测试下pmem的执行情况。

### 代码测试

#### 测试：内存数据读取

首先运行测试程序，获取其pid，然后运行 `godbg attach <pid>`跟踪目标进程，等调试会话就绪后，我们输入 `disass`查看下反汇编数据，显示有很多的 `int3`指令，其对应的字节数据是 `0xCC`，我们可以读取一字节该指令地址处的数据来快速验证pmem是否工作正常。

```bash
$ godbg attach 7764
process 7764 attached succ
process 7764 stopped: true
godbg> disass
0x4651e0 mov %eax,0x20(%rsp)
0x4651e4 retq
0x4651e5 int3
0x4651e6 int3
0x4651e7 int3
0x4651e8 int3
0x4651e9 int3
0x4651ea int3
0x4651eb int3
0x4651ec int3
godbg> pmem --addr 0x4651e5 --count 1 --fmt x --size 1
read 1 bytes ok:cc
godbg> pmem --addr 0x4651e5 --count 4 --fmt x --size 1
read 4 bytes ok:cccccccc
godbg> 
```

可见，程序从指令地址0x4561e5先读取了1字节数据，即1个int3对应的16进制数0xCC，然后从相同地址处读取了4字节数据，即连续4个int3对应的16进制数0xCCCCCCC。

运行结果符合预期，说明pmem基本的内存数据读取功能正常。

#### 测试：数据"类型"解析

查看16进制数，每个16进制数分别为1字节、2字节，注意字节序为小端：

```bash
godbg> pmem --addr 0x464fc3 --count 16 --fmt x --size 1
read 16 bytes ok:
0x464fc3:   0x89   0x44   0x24   0x30   0xc3   0xcc   0xcc   0xcc   
0x464fcb:   0xcc   0xcc   0xcc   0xcc   0xcc   0xcc   0xcc   0xcc   

godbg> pmem --addr 0x464fc3 --count 16 --fmt x --size 2
read 32 bytes ok:
0x464fc3:   0x4489   0x3024   0xccc3   0xcccc   0xcccc   0xcccc   0xcccc   0xcccc   
0x464fcb:   0xcccc   0xcccc   0xcccc   0xcccc   0xcccc   0xcccc   0x8bcc   0x247c 
```

查看8进制数，每个8进制数分别为1字节、2字节，注意字节序为小端：

```bash
godbg> pmem --addr 0x464fc3 --count 16 --fmt o --size 1
read 16 bytes ok:
0x464fc3:   0211   0104   0044   0060   0303   0314   0314   0314   
0x464fcb:   0314   0314   0314   0314   0314   0314   0314   0314   

godbg> pmem --addr 0x464fc3 --count 16 --fmt o --size 2
read 32 bytes ok:
0x464fc3:   0042211   0030044   0146303   0146314   0146314   0146314   0146314   0146314   
0x464fcb:   0146314   0146314   0146314   0146314   0146314   0146314   0105714   0022174
```

查看2进制数，每个2进制数分别为1字节、2字节，注意字节序为小端：

```bash
godbg> pmem --addr 0x464fc3 --count 16 --fmt b --size 1
read 16 bytes ok:
0x464fc3:   10001001   01000100   00100100   00110000   
0x464fc7:   11000011   11001100   11001100   11001100   
0x464fcb:   11001100   11001100   11001100   11001100   
0x464fcf:   11001100   11001100   11001100   11001100   

godbg> pmem --addr 0x464fc3 --count 16 --fmt b --size 2
read 32 bytes ok:
0x464fc3:   0100010010001001   0011000000100100   1100110011000011   1100110011001100   
0x464fc7:   1100110011001100   1100110011001100   1100110011001100   1100110011001100   
0x464fcb:   1100110011001100   1100110011001100   1100110011001100   1100110011001100   
0x464fcf:   1100110011001100   1100110011001100   1000101111001100   0010010001111100 
```

最后，查看下10进制数，每个10进制数分别为1字节、2字节，注意字节序为小端：

```bash
godbg> pmem --addr 0x464fc3 --count 16 --fmt d --size 1
read 16 bytes ok:
0x464fc3:   137   068   036   048   195   204   204   204   
0x464fcb:   204   204   204   204   204   204   204   204   

godbg> pmem --addr 0x464fc3 --count 16 --fmt d --size 2
read 32 bytes ok:
0x464fc3:   017545   012324   052419   052428   052428   052428   052428   052428   
0x464fcb:   052428   052428   052428   052428   052428   052428   035788   009340 
```

pmem命令可以正常解析不同fmt、不同size、大小端字节序的内存数据了。

运行结果符合预期，说明pmem数据读取、解析、展示功能均正常。

> ps: 这里prettyPrintMem逻辑实际上取自当初贡献给 `go-delve/delve的examinemem(x)`命令。如您对字节序引起的数据转换感兴趣，可以对数据进行校验验证下正确性，通过16进制数据校验可能会更方便些。

### 本文小结

本文介绍了如何从指定内存地址读取数据，如何高效判断机器字节序，不同字节序下如何进行数值解析，并且以不同计数制进行格式化展示。这里我们还是用了go标准库中提供的一个好用的包tabwriter，它支持输出的数据按列对齐，使得输出更加清晰易读。

在后续符号级调试环节，我们还需要实现打印任意变量值的功能，读取内存数据后我们还需要其他技术来帮助解析成对应的高级语言中的数据类型。接下来我们看看如何读取寄存器相关数据。
