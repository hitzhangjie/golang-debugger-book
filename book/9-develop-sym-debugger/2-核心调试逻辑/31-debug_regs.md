## pregs：查看寄存器

第 6 章 6.15 实现了 `pregs`，6.17 实现了 `setreg`。命令名是 `pregs` 而不是 `regs`，与 `pmem`、`setmem` 的命名一脉相承。本节在回顾读取链路的同时，重点说明寄存器在符号级调试器后续章节里扮演的三个角色：DWARF 表达式求值的输入、goroutine 定位的入口、以及函数调用传参的载体。

### 实现目标

`godbg> pregs` 没有参数：读取一次当前线程的寄存器快照，按"寄存器名 + 值"两列对齐打印。`godbg> setreg <reg> <value>` 则按名称修改一个寄存器并写回。两者合起来构成"寄存器视图"：`pregs` 看、`setreg` 改。与 `pmem` 不同，寄存器操作必须带线程概念——同一个进程的不同线程各有独立的寄存器现场。

### 基础知识

amd64 的寄存器可以粗分为几类：

- 通用寄存器 `rax`、`rbx`、`rcx`、`rdx`、`rsi`、`rdi`、`rbp`、`rsp`、`r8`～`r15`：函数参数、返回值、局部变量与栈帧都在这组里；
- 指令指针 `rip`：断点命中后它是断点地址加 1，PC 回退改的就是它；
- 标志寄存器 `eflags`：比较与条件跳转的结果记录在这里；
- 段寄存器 `cs`、`ss`、`ds`、`es`、`fs`、`gs` 与段基址 `fs_base`、`gs_base`：amd64 下分段基本扁平化，`fs_base`/`gs_base` 主要用作 TLS 基址；
- `orig_rax`：系统调用进入内核前的调用号。

`PTRACE_GETREGS` 一次返回内核的 `struct user_regs_struct`，godbgv2 把它整份拷贝进契约类型 `api.Registers`。这个类型必须完整建模全部字段，原因不只是"想看得全"：写回时 `PTRACE_SETREGS` 会整份写入，若段寄存器或段基址被清零，内核会拒绝写入并返回 `EIO`（`pkg/target/registers_amd64.go` 的 `RegsToPtrace` 注释记录了这一点）。`api.Registers` 的字段与上面的分类一一对应：`Rip`、`Rsp`、`Rbp`、`Rax`～`R15`、`EFlags`、`Cs`/`Ss`/`Ds`/`Es`/`Fs`/`Gs`、`FsBase`/`GsBase`、`OrigRax`。

寄存器还有一套与 DWARF 相关的编号。amd64 上 DWARF 寄存器号 `0`～`16` 依次对应 `rax`、`rdx`、`rcx`、`rbx`、`rsi`、`rdi`、`rbp`、`rsp`、`r8`～`r15`、`rip`，`pkg/proc/variables.go` 的 `dwarfRegisters` 负责这层映射。变量定位时 `DW_OP_reg*`/`DW_OP_breg*` 要按这套编号去取值——这就是"寄存器是 DW_OP 求值输入"的含义。TLS 则与 goroutine 有关：Go 运行时把当前 goroutine 的 `g` 指针放在线程本地存储里，linux/amd64 上是 `fs_base-8` 这个槽位。`pkg/proc/goroutines.go` 定位当前 goroutine 时，先经 `pkg/target/ptrace_linux.go` 的 `FSBase(tid)` 取 TLS 基址，再读 `fs_base-8` 得到 `g`。这条路径是 9.2.40 的基础。

### 代码实现

`cmd/debug/pregs.go` 只做三件事（节选）：

```go
RunE: func(cmd *cobra.Command, args []string) error {
    // 当前线程（ch6.18.5）
    tid, err := Client.CurrentThread()
    if err != nil {
        return err
    }
    regs, err := Client.ReadRegs(tid)
    if err != nil {
        return fmt.Errorf("get regs error: %v", err)
    }
    prettyPrintRegs(regs)
    return nil
},
```

`prettyPrintRegs` 用 `text/tabwriter` 打一张两列表，27 个寄存器逐个按 `%#x` 打印。顺序固定（`Rip`、`Rsp`、`Rbp`、通用寄存器、`EFlags`、段寄存器、段基址、`OrigRax`），方便多次执行之间横向对比。

读取链路是 `Client.ReadRegs(tid)` → `debugger.Debugger.ReadRegs` → `pkg/target/registers_amd64.go` 的 `ReadRegister`：它在 `ExecPtrace` 里调用 `syscall.PtraceGetRegs` 取内核的 `user_regs_struct`，门面再用 `RegsFromPtrace` 逐字段翻译成 `api.Registers`（`Eflags`、`Fs_base`、`Orig_rax` 等下划线命名改成 Go 风格）。

写回路径是 `setreg` → `Client.WriteRegs(tid, regs)` → `WriteRegister`（`PTRACE_SETREGS`）。命令层先用 `strconv.ParseUint(args[1], 0, 64)` 解析数值，再经 `setRegField` 用反射按字段名（忽略大小写）匹配 `api.Registers` 的导出字段，所以 `rax`、`Rip`、`eflags` 都能写，名字不匹配时返回 `invalid register name`。由于写回是整份 `user_regs_struct`，修改前必须先 `ReadRegs` 拿到完整快照——命令层正是这么做的。

另外，`pkg/target/ptrace_linux.go` 里还有一个 `FSBase(tid)`：它用 `PTRACE_PEEKUSER` 读 user 区偏移 168（`user_regs_struct.fs_base` 的位置），专供 goroutine 定位使用。它与 `pregs` 打印的 `FsBase` 是同一个字段，只是读取路径不同。

### 执行测试

停在 `main.go:16` 的断点后执行 `pregs`（批量回放，仅保留部分寄存器行，其余省略）：

```bash
godbg> pregs
Register    Value
Rip         0x4b3972
Rsp         0xc000186ee0
Rbp         0xc000186f68
Rax         0x1d1cbe
Rbx         0xc000180060
R14         0xc000004380
...
FsBase      0x574830
OrigRax     0xffffffffffffffff
```

先解释两个关键值：`Rip=0x4b3972` 是断点地址 `0x4b3971` 加 1，符合"`int3` 已执行"；`FsBase=0x574830` 是当前线程的 TLS 基址，`fs_base-8` 里就存着该线程正在运行的 `g` 指针（9.2.40 会用到）。`R14` 在 Go 的 amd64 实现里也常被用作 `g` 指针，但它属于编译器约定，不是可移植的接口，定位 goroutine 仍要走 TLS。

写回同样可以实跑：

```bash
godbg> setreg rax 0x1234
setreg ok, rax: 0x1234
godbg> pregs
Register    Value
Rip         0x4b3941
Rsp         0xc0000c0f70
...
Rax         0x1234
...
godbg> setreg rip 0x4b3940
setreg ok, rip: 0x4b3940
godbg> pregs
Register    Value
Rip         0x4b3940
...
```

`setreg rax` 之后 `pregs` 立刻能看到 `Rax=0x1234`，说明写回生效；`setreg rip` 把 PC 从 `0x4b3941` 改回断点地址 `0x4b3940`，`pregs` 也如实反映。两次写回后的完整输出里都只有目标字段变化，其余字段不变，这验证了"整份快照读、改一个、整份写回"的路径没有破坏其他寄存器。

### 本节小结

`pregs` 读取当前线程的 `user_regs_struct` 快照，`api.Registers` 是它与调试器其余部分之间的契约；`setreg` 按名称改一个字段后整份写回，正因为整份写回，段基址这类字段不能被清空。寄存器不只是"看一眼"的调试信息，它在后续章节里是三种输入：9.2.33 的变量定位要把 `DW_OP_reg*`/`DW_OP_breg*` 按 DWARF 编号映射成寄存器值；9.2.40 的 goroutine 定位要从 `fs_base-8` 读 `g`；9.2.42 的调试期函数调用要按 ABIInternal 把实参写进寄存器，并在返回后恢复现场。理解了 `pregs` 的字段含义，这几节才读得顺。
