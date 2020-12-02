## pkg debug/elf 应用

### 数据类型及关系

标准库提供了package`debug/elf`来读取、解析elf文件数据，相关的数据类型及其之间的依赖关系，如下图所示：

![image-20201128125408007](assets/image-20201128125408007.png)

简单讲，elf.File中包含了我们可以从elf文件中获取的所有信息，为了方便使用，标准库又提供了其他package `debug/gosym`来解析符号信息、行号表信息，还提供了`debug/dwarf`来解析调试信息。

### 常用操作及示例

#### 打开一个ELF文件

通过命令选项传递一个待打开的elf文件名，然后打开该elf文件，并打印elf.File的结构信息。这里我们使用了一个三方库go-spew/spew，它基于反射实现能够打印出elf.File结构中各个字段的信息，如果字段也是组合类型也会对齐进行递归地展开。

```go
package main

import (
	"debug/elf"
	"fmt"
	"os"

	"github.com/davecgh/go-spew/spew"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run main.go <prog>")
		os.Exit(1)
	}
	prog := os.Args[1]

	file, err := elf.Open(prog)
	if err != nil {
		panic(err)
	}
	spew.Dump(file)
}
```

运行测试`go run main.go ../testdata/loop`，这个结构非常复杂，为了方便读者查看，我删减了部分内容。

不难看出，ELF文件中包含了如下关键信息：

- FileHeader，即ELF Header；
- Sections，Sections中每个Section都包含了一个elf.SectionHeader定义，实际上这个字段是读取ELF文件中节头表、节汇总之后的结果；
- Progs，即ELF文件中的段头表，其中每个元素都是一个elf.ProgHeader；

通过打印信息，细心的读者会发现：

- 对于sections，我们可以看到section具体的名称，如.text、.rodata、.data；
- 对于segments，也可以看到segment具体的类型，如note、load，还有其虚拟地址；

```bash
(*elf.File)(0xc0000ec3c0)({
 FileHeader: (elf.FileHeader) {
  Class: (elf.Class) ELFCLASS64,
  Data: (elf.Data) ELFDATA2LSB,
  Version: (elf.Version) EV_CURRENT,
  OSABI: (elf.OSABI) ELFOSABI_NONE,
  ABIVersion: (uint8) 0,
  ByteOrder: (binary.littleEndian) LittleEndian,
  Type: (elf.Type) ET_EXEC,
  Machine: (elf.Machine) EM_X86_64,
  Entry: (uint64) 4605856
 },
 Sections: ([]*elf.Section) (len=25 cap=25) {
  (*elf.Section)(0xc0000fe000)({ SectionHeader: (elf.SectionHeader) { Name: (string) "" ...  }}),
  (*elf.Section)(0xc0000fe080)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=5) ".text", ...  }}),
  (*elf.Section)(0xc0000fe100)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=7) ".rodata", ...  }}),
  (*elf.Section)(0xc0000fe180)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=9) ".typelink", ...  }}),
  (*elf.Section)(0xc0000fe200)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=9) ".itablink", ...  }}),
  (*elf.Section)(0xc0000fe280)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=9) ".gosymtab", ...  }}),
  (*elf.Section)(0xc0000fe300)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=10) ".gopclntab", ...  }}),
  (*elf.Section)(0xc0000fe380)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=13) ".go.buildinfo", }}),
  (*elf.Section)(0xc0000fe400)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=10) ".noptrdata", ...  }}),
  (*elf.Section)(0xc0000fe480)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=5) ".data", ...  }}),
  (*elf.Section)(0xc0000fe500)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=4) ".bss", ...  }}),
  (*elf.Section)(0xc0000fe580)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=9) ".noptrbss", ...  }}),
  (*elf.Section)(0xc0000fe600)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=14) ".zdebug_abbrev", ...  }}),
  (*elf.Section)(0xc0000fe680)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=12) ".zdebug_line", ...  }}),
  (*elf.Section)(0xc0000fe700)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=13) ".zdebug_frame", ...  }}),
  (*elf.Section)(0xc0000fe780)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=16) ".zdebug_pubnames", ...  }}),
  (*elf.Section)(0xc0000fe800)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=16) ".zdebug_pubtypes", ...  }}),
  (*elf.Section)(0xc0000fe880)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=18) ".debug_gdb_scripts", ...  }}),
  (*elf.Section)(0xc0000fe900)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=12) ".zdebug_info", ...  }}),
  (*elf.Section)(0xc0000fe980)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=11) ".zdebug_loc", ...  }}),
  (*elf.Section)(0xc0000fea00)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=14) ".zdebug_ranges", ...  }}),
  (*elf.Section)(0xc0000fea80)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=16) ".note.go.buildid", ...  }}),
  (*elf.Section)(0xc0000feb00)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=7) ".symtab", ...  }}),
  (*elf.Section)(0xc0000feb80)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=7) ".strtab", ...  }}),
  (*elf.Section)(0xc0000fec00)({ SectionHeader: (elf.SectionHeader) { Name: (string) (len=9) ".shstrtab", ...  }})
 },
 Progs: ([]*elf.Prog) (len=7 cap=7) {
  (*elf.Prog)(0xc0000ba2a0)({ ProgHeader: (elf.ProgHeader) { Type: (elf.ProgType) PT_PHDR, Flags: (elf.ProgFlag) PF_R, Vaddr: (uint64) 4194368 }}),
  (*elf.Prog)(0xc0000ba300)({ ProgHeader: (elf.ProgHeader) { Type: (elf.ProgType) PT_NOTE, Flags: (elf.ProgFlag) PF_R, Vaddr: (uint64) 4198300 }}),
  (*elf.Prog)(0xc0000ba360)({ ProgHeader: (elf.ProgHeader) { Type: (elf.ProgType) PT_LOAD, Flags: (elf.ProgFlag) PF_X+PF_R, Vaddr: (uint64) 4194304 }}),
  (*elf.Prog)(0xc0000ba3c0)({ ProgHeader: (elf.ProgHeader) { Type: (elf.ProgType) PT_LOAD, Flags: (elf.ProgFlag) PF_R, Vaddr: (uint64) 4825088 }}),
  (*elf.Prog)(0xc0000ba420)({ ProgHeader: (elf.ProgHeader) { Type: (elf.ProgType) PT_LOAD, Flags: (elf.ProgFlag) PF_W+PF_R, Vaddr: (uint64) 5500928 }}),
  (*elf.Prog)(0xc0000ba480)({ ProgHeader: (elf.ProgHeader) { Type: (elf.ProgType) PT_LOOS+74769745, Flags: (elf.ProgFlag) PF_W+PF_R, Vaddr: (uint64) 0 }}),
  (*elf.Prog)(0xc0000ba4e0)({ ProgHeader: (elf.ProgHeader) { Type: (elf.ProgType) PT_LOOS+84153728, Flags: (elf.ProgFlag) 0x2a00, Vaddr: (uint64) 0 }})
 },
 ...
})
```

#### 读取文件段头表

通过前面的示例输出不难看出，文件段头表其实是elf.File的一个导出字段Progs，该字段就是解析之后的段头表。

在前面示例的基础上，我们继续读取段头表信息。

我们遍历ELF文件中段头表数据，查看每个段的类型、权限位、虚拟存储器地址、段大小，当然段头中还有其他数据，我们就不一一打印了。

```go
package main

import (
    "text/tabwriter"
    ...
)

func main() {
    ...
    file, err := elf.Open(prog)
	...    

	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 3, ' ', 0)
	defer tw.Flush()
	fmt.Fprintf(tw, "No.\tType\tFlags\tVAddr\tMemSize\n")

	for idx, p := range file.Progs {
		fmt.Fprintf(tw, "%d\t%v\t%v\t%#x\t%d\n", idx, p.Type, p.Flags, p.Vaddr, p.Memsz)
	}
}
```

运行测试`go run main.go ../testdata/loop`，程序额外输出了如下段头表信息，从中我们可以看到各个segments的索引编号、段类型、权限位、虚拟存储器地址、段占用内存大小（有的段与文件大小可能不同，如多出来的规划给bss段）。

```bash
No.   Type               Flags       VAddr      MemSize
0     PT_PHDR            PF_R        0x400040   392
1     PT_NOTE            PF_R        0x400f9c   100
2     PT_LOAD            PF_X+PF_R   0x400000   626964
3     PT_LOAD            PF_R        0x49a000   673559
4     PT_LOAD            PF_W+PF_R   0x53f000   295048
5     PT_LOOS+74769745   PF_W+PF_R   0x0        0
6     PT_LOOS+84153728   0x2a00      0x0        0
```

FIXME: WHY READ OK but x86asm.Decode ERROR?

如果要读取段中的数据呢？以text段为例，它显然是索引值为2的段，因为只有这个段为PT_LOAD类型并且具备可执行权限。我们尝试读取这个段中的数据。

```go
func main() {
    ...
    file, err := elf.Open(prog)
    ...
    
	text := file.Progs[2]
	buf := make([]byte, text.Filesz, text.Filesz)
	n, err := text.ReadAt(buf, 0)
	if err != nil {
		panic(err)
	}
	fmt.Printf("i have read some data: %d bytes\n", n)
}
```

运行测试`go run main.go ../testdata/loop`:

```bash
i have read some data: 626964 bytes
```





#### 读取文件节头表

#### 读取sections列表

#### 读取指定section



### 参考内容

1. How to Fool Analysis Tools, https://tuanlinh.gitbook.io/ctf/golang-function-name-obfuscation-how-to-fool-analysis-tools

2. Go 1.2 Runtime Symbol Information, Russ Cox, https://docs.google.com/document/d/1lyPIbmsYbXnpNj57a261hgOYVpNRcgydurVQIyZOz_o/pub

3. Some notes on the structure of Go Binaries, https://utcc.utoronto.ca/~cks/space/blog/programming/GoBinaryStructureNotes

4. Buiding a better Go Linker, Austin Clements, https://docs.google.com/document/d/1D13QhciikbdLtaI67U6Ble5d_1nsI4befEd6_k1z91U/view


5.  Time for Some Function Recovery, https://www.mdeditor.tw/pl/2DRS/zh-hk