## 查看进程状态：查看内存数据

### 实现目标：`godbg> pmem <addr>` 查看内存数据

这一小节，我们来实现pmem命令，方便调试进程时查看进程内存数据。

### 基础知识

我们知道，内存中的数据按字节编址，1字节包含8bits，是一些0和1序列，要正确展示内存数据，我们需要关注下面这些基本事项：

- 字节、0和1bits序列不是我们要看的最终形态，数据是有类型的，我们要根据数据类型来解释内存中的数据；
- 不同机器中数据存储是有字节序的，小端（低有效位数据在内存低地址）or 大端（低有效位数据在内存高地址）；

pmem查看进程内存数据，需要通过 `ptrace(PTRACE_PEEKDATA,...)` 操作，来读取被调试进程的从指定内存地址开始的一段数据，并按照指定字节序编组成一个个整数，然后以二进制、八进制、十进制或者十六进制的形式打印出来。godbgv2 里用的是 `ptrace(PTRACE_PEEKTEXT,...)`，读取内存时两者效果相同。

和常见的查看变量的操作 `print <var>` 不同的是，这里并没有考虑指定位置的数据是什么数据类型 （如一个 `struct{...}` ，`slice`，or `map`)。pmem类似gdb里面的 `x/fmt` 操作：`pmem <addr>` 给出起始地址，`--count`、`--size`、`--fmt` 分别对应 gdb `x/FMT` 中的重复次数、单元大小和格式。

### 代码实现

#### 第1步：实现进程内存数据读取

pmem的命令形式是 `pmem <addr>`，地址是位置参数；读多少、按什么格式展示由三个flag控制：

- `--size` 表示一个待读取并显示的数据项包括多少个字节；
- `--count` 表示连续读取并显示多少个这样的数据项；
- `--fmt` 表示按哪种进制展示，默认是 `hex`。

比如一个int数据项可能包含4个字节，要显示8个int数则要指定 `--size 4 --count 8`，两者相乘就是要从目标地址读取的字节数。

**file：cmd/debug/pmem.go**

```go
package debug

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

var pmemCmd = &cobra.Command{
	Use:   "pmem <addr>",
	Short: "查看内存数据",
	Annotations: map[string]string{
		cmdGroupAnnotation: cmdGroupInfo,
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		if len(args) == 0 || len(args[0]) == 0 {
			return errors.New("invalid <addr>")
		}
		addr := args[0]
		count, _ := cmd.Flags().GetUint("count")
		format, _ := cmd.Flags().GetString("fmt")
		size, _ := cmd.Flags().GetUint("size")

		// 检查参数
		if err := checkPmemArgs(count, format, size, addr); err != nil {
			return err
		}

		// 计算要读取的内存大小，并读取
		readAt, _ := strconv.ParseUint(addr, 0, 64)
		bytes := count * size
		buf, err := Client.ReadMemory(readAt, int(bytes))
		if err != nil || len(buf) != int(bytes) {
			return fmt.Errorf("read %d bytes, error: %v", len(buf), err)
		}

		fmt.Printf("read %d bytes ok:\n", len(buf))

		// 格式化打印内存数据
		var ft byte
		switch format {
		case "b", "binary":
			ft = 'b'
		case "o", "octal":
			ft = 'o'
		case "d", "decimal":
			ft = 'd'
		case "x", "hex":
			ft = 'x'
		default:
			return fmt.Errorf("invalid format")
		}

		// 本项目仅支持 linux/amd64（小端字节序）
		fmt.Print(prettyPrintMem(uintptr(readAt), buf, true, ft, int(size)))
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(pmemCmd)

	// 类似 gdb 的命令 x/FMT，其中 FMT=重复数字+格式化修饰符+size
	pmemCmd.Flags().Uint("count", 16, "查看数值数量")
	pmemCmd.Flags().String("fmt", "hex", "数值打印格式: b(binary), o(octal), x(hex), d(decimal)")
	pmemCmd.Flags().Uint("size", 4, "数值占用字节")
}

func checkPmemArgs(count uint, format string, size uint, addr string) error {
	if count == 0 {
		return errors.New("invalid count")
	}
	if size == 0 {
		return errors.New("invalid size")
	}
	formats := map[string]struct{}{
		"b": {}, "binary": {},
		"o": {}, "octal": {},
		"x": {}, "hex": {},
		"d": {}, "decimal": {},
	}
	if _, ok := formats[format]; !ok {
		return errors.New("invalid format")
	}
	_, err := strconv.ParseUint(addr, 0, 64)
	return err
}
```

命令层不直接调用系统调用，而是通过 `Client.ReadMemory(readAt, int(bytes))` 读取指定长度的内存。`api.Client` 新增了 `ReadMemory(addr uint64, size int) ([]byte, error)`，由 `debugger.Debugger` 门面转发到 target 层：

**file：pkg/service/debugger/debugger.go**（片段）

```go
// ReadMemory 从地址 addr 处读取 size 字节内存
func (d *Debugger) ReadMemory(addr uint64, size int) ([]byte, error) {
	if d.dbp == nil {
		return nil, fmt.Errorf("no debugged process")
	}
	buf := make([]byte, size)
	n, err := d.dbp.ReadMemory(uintptr(addr), buf)
	if err != nil {
		return nil, err
	}
	return buf[:n], nil
}
```

target 层把读取内存的能力从反汇编实现里的 `peekMemory` 抽成了 `DebuggedProcess.ReadMemory`，供 pmem、disass 等命令复用：

**file：pkg/target/memory.go**

```go
package target

import (
	"syscall"
)

// ReadMemory 读取内存地址addr处的数据到buf中，返回实际读取的字节数。
//
// 该能力最早以 peekMemory 的形态内联在 ch6.5 的反汇编实现中，
// 自本节起抽出为独立方法，供 pmem、disass 等命令复用。
func (p *DebuggedProcess) ReadMemory(addr uintptr, buf []byte) (int, error) {
	var (
		dat int
		err error
	)
	err = p.ExecPtrace(func() error {
		// PtracePeekText 与 PtracePeekData 效果相同
		n, err := syscall.PtracePeekText(p.Process.Pid, addr, buf)
		if err != nil {
			return err
		}
		dat = n
		return nil
	})
	return dat, err
}
```

`PtracePeekText` 与 `PtracePeekData` 都是按字读取 tracee 内存，效果相同；`ExecPtrace` 把 ptrace 请求放到一个锁定到具体 OS 线程的 goroutine 里执行，避免 Go runtime 在多个线程间调度导致 ptrace 请求失败。返回值 `n` 是实际读取的字节数，命令层据此判断是否读满了 `count*size` 个字节。

#### 第2步：字节序及数值解析

读取到的 `buf` 是一串字节，要按 `--size` 把连续的size个字节编组，再按字节序拼成一个整数：

```go
// byteArrayToUInt64 将字节序列转换为 uint64 数值，注意字节序的影响
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

小端字节序下低有效位字节在低地址，所以从缓冲区末尾向前累加；大端字节序下则从前往后累加。

那么，怎么知道当前机器是小端还是大端呢？一个简单直接的办法是：往内存里写入一个多字节整数，再按字节读出来，观察低地址处存放的是低有效字节还是高有效字节：

```go
import "unsafe"

// isLittleEndian 检测当前机器是否采用小端字节序。
func isLittleEndian() bool {
	buf := [2]byte{}
	// 把 buf 的前两个字节当成一个 uint16，写入 0xABCD
	*(*uint16)(unsafe.Pointer(&buf[0])) = uint16(0xABCD)

	switch buf {
	case [2]byte{0xCD, 0xAB}:
		// 低有效字节 0xCD 位于低地址，是小端
		return true
	case [2]byte{0xAB, 0xCD}:
		// 高有效字节 0xAB 位于低地址，是大端
		return false
	default:
		panic("Could not determine native endianness.")
	}
}
```

`0xABCD` 的高有效字节是 `0xAB`，低有效字节是 `0xCD`：

- 小端机器把低有效字节放在低地址，因此内存中依次是 `0xCD`、`0xAB`，命中第一个 case；
- 大端机器把高有效字节放在低地址，因此内存中依次是 `0xAB`、`0xCD`，命中第二个 case。

这里借助 `unsafe.Pointer` 绕过了类型系统，把同一块内存按 `uint16` 和 `[2]byte` 两种视角读写；`default` 分支用于兜底，正常机器不会走到。

godbgv2 只支持 linux/amd64，字节序固定为小端，因此命令层调用 `prettyPrintMem` 时直接传入 `true`，省掉了运行时探测。如果将来要支持其他体系结构，可以在启动时调用一次 `isLittleEndian()`，把结果传给 `prettyPrintMem`。

#### 第3步：实现数据"类型"解析

从内存中读取到的数据，应该按照每个数据项占用的字节数 `--size`以及要展示的进制 `--fmt` 对连续字节数据进行编组、解析。且需要考虑二进制、八进制、十进制、十六进制数展示时占用的终端列数问题，每行列数有限，使用不同的进制数情况下，每行适合展示的数字的数量不同。

```go
// prettyPrintMem 格式化打印内存数据。
//
// `format` 指定数据格式，`size` 指定每个数值占用的字节数（如 4 字节整数），
// `count` 指定数值个数。
func prettyPrintMem(address uintptr, memArea []byte, littleEndian bool, format byte, size int) string {

	var (
		cols      int
		colFormat string
		colBytes  = size

		addrLen int
		addrFmt string
	)

	switch format {
	case 'b':
		cols = 4 // 二进制格式列数少些，避免行太长
		colFormat = fmt.Sprintf("%%0%db", colBytes*8)
	case 'o':
		cols = 8
		colFormat = fmt.Sprintf("0%%0%do", colBytes*3) // 八进制始终保留前导 0
	case 'd':
		cols = 8
		colFormat = fmt.Sprintf("%%0%dd", colBytes*3)
	case 'x':
		cols = 8
		colFormat = fmt.Sprintf("0x%%0%dx", colBytes*2) // 十六进制始终保留 0x 前缀
	default:
		return fmt.Sprintf("not supprted format %q\n", string(format))
	}
	colFormat += "\t"

	l := len(memArea)
	rows := l / (cols * colBytes)
	if l%(cols*colBytes) != 0 {
		rows++
	}

	// 相邻两行地址长度一致，始终用最后一个地址的长度来格式化
	if l != 0 {
		addrLen = len(fmt.Sprintf("%x", uint64(address)+uint64(l)))
	}
	addrFmt = "0x%0" + strconv.Itoa(addrLen) + "x:\t"

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
		address += uintptr(cols * colBytes)
	}
	w.Flush()
	return b.String()
}
```

上面的代码读取内存数据逻辑不变，主要是添加了两部分逻辑：

- 根据字节序（godbgv2 为小端），对内存中读取到的数据进行正确解析，并转换成对应的数值；
- 根据数值要显示的进制格式，结合2、8、16、10进制的宽度，通过fmt.Sprintf进行适当格式化，并结合tabwriter通过tab+padding对齐后输出。

每行放多少列由进制决定：十六进制、八进制、十进制每行8列，二进制每行4列，避免一行太长。地址列统一格式化成固定宽度，每行起始地址按 `cols*colBytes` 递增，即一行展示的字节数。

> ps：上述代码取自 [hitzhangjie/godbgv2](https://github.com/hitzhangjie/godbgv2) 的 tag `ch6.13`。为了让正文聚焦在 pmem 的实现上，这里只展开了命令层以及 `ReadMemory`、`prettyPrintMem` 等核心函数；`api.Client` 接口和 `debugger` 门面的改动属于配套的支撑代码。如对字节序引起的数据转换感兴趣，可以对照16进制输出自行校验。

至此pmem命令基本完成开发，我们来测试下pmem的执行情况。

### 代码测试

测试对象是 godbgv2 自带的 `_fixtures/loop`，程序入口固定为 `0x478120`（Makefile 固定了构建所用的 Go 工具链版本）。切到本节代码并构建：

```bash
$ git checkout ch6.13
$ make build
$ make fixtures
```

#### 测试：内存数据读取

先用 `break` 在入口处下一个断点，再读取入口处的内存：

```bash
$ ./godbg exec _fixtures/loop
process 2285217 launched, stopped by SIGTRAP
godbg> break 0x478120
breakpoint 1 added at 0x478120
godbg> pmem 0x478120
read 64 bytes ok:
0x478120:   0xffc8bbcc   0xccccccff   0xcccccccc   0xcccccccc   0xcccccccc   0xcccccccc   0xcccccccc   0xcccccccc
0x478140:   0x30ec8348   0x246c8948   0x6c8d4828   0x89482824   0x894c241c   0x4c082464   0x10246c89   0x2474894c
```

`pmem 0x478120` 使用默认参数（`--count 16 --size 4 --fmt hex`），共读取64字节，按每4字节一个小端整数展示。入口第一条指令原本是 `e9 bb c8 ff ff`（`jmp` 到 `_rt0_amd64`），下断点后首字节被改写成 `0xCC`，所以第一组4字节是 `cc bb c8 ff`，按小端解析得到 `0xffc8bbcc`；从 `0x478125` 开始则是代码段里用于对齐的填充字节 `0xCC`。读出的内容与断点处的实际内存一致，说明内存读取功能正常。

#### 测试：数据"类型"解析

接着上面的会话，分别用1字节、2字节作为数据项读取同一段内存。先看16进制：

```bash
godbg> pmem 0x478120 --count 16 --size 1 --fmt x
read 16 bytes ok:
0x478120:   0xcc   0xbb   0xc8   0xff   0xff   0xcc   0xcc   0xcc
0x478128:   0xcc   0xcc   0xcc   0xcc   0xcc   0xcc   0xcc   0xcc
godbg> pmem 0x478120 --count 16 --size 2 --fmt x
read 32 bytes ok:
0x478120:   0xbbcc   0xffc8   0xccff   0xcccc   0xcccc   0xcccc   0xcccc   0xcccc
0x478130:   0xcccc   0xcccc   0xcccc   0xcccc   0xcccc   0xcccc   0xcccc   0xcccc
```

`--size 1` 时每列就是一个字节，第一列是断点改写的 `0xcc`；`--size 2` 时每列由两个连续字节按小端拼成，比如 `cc bb` 拼成 `0xbbcc`、`c8 ff` 拼成 `0xffc8`，可见字节序处理正确。

再看8进制：

```bash
godbg> pmem 0x478120 --count 16 --size 1 --fmt o
read 16 bytes ok:
0x478120:   0314   0273   0310   0377   0377   0314   0314   0314
0x478128:   0314   0314   0314   0314   0314   0314   0314   0314
godbg> pmem 0x478120 --count 16 --size 2 --fmt o
read 32 bytes ok:
0x478120:   0135714   0177710   0146377   0146314   0146314   0146314   0146314   0146314
0x478130:   0146314   0146314   0146314   0146314   0146314   0146314   0146314   0146314
```

8进制数始终保留一个前导 `0`，比如 `0xcc` 是 `0314`。

再看2进制：

```bash
godbg> pmem 0x478120 --count 16 --size 1 --fmt b
read 16 bytes ok:
0x478120:   11001100   10111011   11001000   11111111
0x478124:   11111111   11001100   11001100   11001100
0x478128:   11001100   11001100   11001100   11001100
0x47812c:   11001100   11001100   11001100   11001100
godbg> pmem 0x478120 --count 16 --size 2 --fmt b
read 32 bytes ok:
0x478120:   1011101111001100   1111111111001000   1100110011111111   1100110011001100
0x478128:   1100110011001100   1100110011001100   1100110011001100   1100110011001100
0x478130:   1100110011001100   1100110011001100   1100110011001100   1100110011001100
0x478138:   1100110011001100   1100110011001100   1100110011001100   1100110011001100
```

二进制每行只放4列，`--size 2` 时每列16位，对应两个字节。

最后看10进制：

```bash
godbg> pmem 0x478120 --count 16 --size 1 --fmt d
read 16 bytes ok:
0x478120:   204   187   200   255   255   204   204   204
0x478128:   204   204   204   204   204   204   204   204
godbg> pmem 0x478120 --count 16 --size 2 --fmt d
read 32 bytes ok:
0x478120:   048076   065480   052479   052428   052428   052428   052428   052428
0x478130:   052428   052428   052428   052428   052428   052428   052428   052428
godbg> exit
tracee is run by tracer, kill it
```

十进制按固定宽度补零输出，比如 `0xbbcc`（48076）显示为 `048076`。

pmem命令可以正常读取内存，并按不同fmt、不同size解析和展示数据了。运行结果符合预期。

### 本节小结

本文介绍了如何从指定内存地址读取数据，如何按字节序把字节序列解析成整数，并且以不同计数制进行格式化展示。这里我们还是用了go标准库中提供的一个好用的包tabwriter，它支持输出的数据按列对齐，使得输出更加清晰易读。这个操作在符号级调试器中也是基础操作，比如我们想查看slice、string底层字节数组中的真实数据构成。

godbgv2只支持linux/amd64，所以本节直接按小端字节序处理；如果后续要支持大端平台，需要把运行时字节序探测加回来，`byteArrayToUInt64` 已经同时支持两种字节序。

后续实现符号级调试器时，我们会介绍 `print <var>` 后者 `print <expr>` 中更加深入的一些只是，包括AST解析，然后EvalExpr，然后从内存读取每个操作变量的内存数据，运算得到结果变量。并将这个结果变量的值按照变量类型予以显示出来，比如 `print student.Name`。这里我们先聚焦原始的pmem操作。

接下来，我们继续介绍如何读取寄存器相关数据。
