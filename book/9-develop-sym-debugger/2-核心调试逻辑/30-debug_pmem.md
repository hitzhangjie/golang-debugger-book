## pmem：读取目标进程内存

第 6 章 6.14 已经实现了 `pmem <addr>`，并解释了 `--count`、`--fmt`、`--size` 三个参数与 gdb `x/FMT` 的对应关系。本节不重复这些内容，只补符号级会话里读内存特有的两个问题：读到的可能是断点字节 `0xCC`，以及读内存是独立于变量查看（9.2.33）的一层原语。

### 实现目标

`godbg> pmem <addr>` 的目标是：从目标进程的绝对地址 `addr` 开始，按 `--size` 指定的单元宽度、`--count` 指定的数量读取内存，再按 `--fmt` 指定的进制打印。

三个参数相乘就是要读取的字节数：

```bash
godbg> pmem <addr> [--count 16] [--fmt hex] [--size 4]
```

`pmem` 只读。写内存是另一条独立命令 `setmem <addr> <value>`（6.16 节），它一次只写 1 字节；两条命令没有共享的参数体系，这是本书有意做的拆分。

### 基础知识

读内存走 `ptrace(PTRACE_PEEKTEXT, ...)`（等价的 `PTRACE_PEEKDATA` 也可以）。内核按机器字（amd64 为 8 字节）把目标进程地址空间的数据拷回调试器，`pkg/target/memory.go` 用 `syscall.PtracePeekText` 一次读一段到 `buf` 里。

读到的只是字节。要把它显示成"人看的数"，还要两个约定：一是单元宽度（`--size`），二是字节序——本项目只支持 linux/amd64，固定小端，`byteArrayToUInt64` 按"低地址字节是低位"组装。这两个约定与数据类型无关：`pmem` 不知道目标地址上是一个 `int`、一个指针还是一段字符串，它只按你给的宽度切分并解释。

符号级会话里最容易踩的坑是断点。软件断点把目标地址的首字节改成了 `0xCC`，而 `pmem` 读的是"此刻的内存"——读到 `0xCC` 是正确行为，不是读坏了。如果想看断点前的原始指令，要用 `disass --clearall`：`DisassembleWithBreakpointCleared` 在内存副本上把属于本调试器的 `0xCC` 换回 `orig`，再反汇编（`pkg/target/disassemble.go`），进程内存本身不受影响。两者对不上，恰恰说明断点已经生效。

### 代码实现

命令层在 `cmd/debug/pmem.go`。`RunE` 先取三个 flag，交给 `checkPmemArgs` 校验：`count`/`size` 不能为 0，`fmt` 必须是 `b`/`o`/`d`/`x` 之一（也接受 `binary`/`octal`/`decimal`/`hex`），`addr` 必须能被 `strconv.ParseUint(addr, 0, 64)` 解析。随后计算 `bytes := count * size` 并调用 `Client.ReadMemory(readAt, int(bytes))`，长度对不上就报错，最后把 `buf` 交给 `prettyPrintMem`。

`Client.ReadMemory` 经 `debugger.Debugger.ReadMemory` 到 `pkg/target/memory.go`：

```go
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

这里传入的是进程 pid，不是线程 tid：读内存不需要选线程，同一进程的所有线程共享地址空间；需要 tid 的是寄存器（9.2.31）与单步（9.2.29）。

格式化由 `prettyPrintMem` 完成。每一行开头打印行首地址，随后固定 8 列（`b` 格式为 4 列，避免行太长），每列一个 `--size` 宽的值；十六进制加 `0x` 前缀，八进制加前导 `0`，十进制按 `size*3` 位补零。列对齐交给 `text/tabwriter`。最后几个字节不足一列时补空格，不会越界读取。`--fmt` 只有数值格式，没有 gdb `x/s` 那样的字符串模式；要看字符串，得由 9.2.33 的 `print` 按变量类型解释。

### 执行测试

停在 `main.main` 入口（`0x4b3940`，此处有断点）后，先用默认参数读 16 个 4 字节值，再换宽度与格式（输出为批量回放所得）：

```bash
godbg> pmem 0x4b3940
read 64 bytes ok:
0x4b3940:   0x24648dcc   0x663b4df0   0x0e860f10   0x55000001   0x48e58948   0x0088ec81   0x01e80000   0x48ffff34
0x4b3960:   0x28244489   0x2444c748   0x00000030   0xeb00eb00   0x110f4400   0x4468247c   0x247c110f   0x4c8d4878
godbg> pmem 0x4b3940 --count 4 --size 1
read 4 bytes ok:
0x4b3940:   0xcc   0x8d   0x64   0x24
godbg> pmem 0x4b3940 --count 2 --size 8 --fmt d
read 16 bytes ok:
0x4b3940:   000007366567309292637644   000006124895497762508560
```

第一行第一列是 `0x24648dcc`，最低字节 `0xcc` 正是断点写进去的 `int3`；紧随其后的 `8d 64 24` 是原指令 `LEAQ -0x10(SP), R12`（机器码 `4c 8d 64 24 f0`）去掉首字节后的前三个字节，末尾的 `f0` 落进了第二个 4 字节值——小端组装把首字节放在了最低位。`--size 1` 直接把字节摊开，`cc 8d 64 24` 一目了然。`--size 8 --fmt d` 则按 8 字节十进制展示，每个值占 24 位。

对照反汇编，确认 `0xCC` 确实来自断点：

```bash
godbg> disass --clearall --max 2
0x4b3940:   4c 8d 64 24 f0   lea -0x10(%rsp),%r12
0x4b3945:   4d 3b 66 10      cmp 0x10(%r14),%r12
```

`--clearall` 展示的是还原后的原始指令 `4c 8d 64 24 f0`，它的首字节 `4c` 被断点替换成了 `cc`。`pmem` 与 `disass` 的这点差异不是 bug，而是"读内存"与"读原始指令"两种视角的区别。若参数非法，`checkPmemArgs` 会直接返回错误，例如 `--fmt q` 输出 `Error: invalid format`——参数校验发生在读内存之前。

### 本节小结

`pmem` 是符号级调试器里最底层的查看手段：给出地址，按宽度与进制解释内存，不关心类型。实现上它由 `checkPmemArgs` 校验三个参数、`Client.ReadMemory` 走 `PTRACE_PEEKTEXT` 读一段、`prettyPrintMem` 按小端组装并对齐打印。

符号级会话里要记住两点：读到 `0xCC` 是断点生效的正常现象，想看原始指令要用 `disass --clearall`；写内存不属于 `pmem`，而是独立的 `setmem` 命令。后续 9.2.33 讲变量查看时，`print` 最终也要落到"由地址读内存"这一层，`pmem` 就是它的手工版。
