## next：源码级单步（尚未实现）

原稿把 `next` 写成了 `step` 的重复段落（"利用处理器的 step 步进执行模式"），这与 godbgv2 的现状不符：`godbg> next` 是一个桩，只打印 `TODO(ch9.2.28): next 尚未实现`。本节如实说明现状，然后给出源码级 `next` 的实现方案——方案是设计稿，尚未写进代码。

### 实现目标

`godbg> next`（别名 `n`）的语义是：执行到当前调用帧的下一行源码处；如果这一行里有函数调用，要跨过被调函数，不在函数体内停下。

这与 9.2.29 的 `step` 有本质区别：`step` 是"执行一条机器指令"，由 CPU 的单步模式完成；`next` 是"执行到下一行源码"，调试器必须先算出下一行的地址，在那里设一个隐式断点，再 continue 过去。一条源码行对应多少条指令、下一行落在哪里，都只能从行号表里查。

### 基础知识

**源码行步进 = 确定停点 + 隐式断点 + continue。** 第 9.2.21 节已经讨论过隐式断点的概念：用户执行 `next` 时，调试器自动在候选位置打一个临时断点（`int3`），恢复执行，命中后再把临时断点撤掉。`next` 的难点不在 ptrace，而在"候选位置怎么算"。**停点来自行号表。** 编译器为每个函数生成的 `.debug_line` 把机器地址映射到 `file:line`。godbgv2 的 `pkg/dwarf/line.go` 解析行号程序，产出 `LineEntry{File, Line, Address}`；`LineForPC` 做地址到位置的查询，`LineToPC` 做位置到地址的反查，`Rows()` 返回全部行记录。`next` 想要的正是 `Rows()` 中"地址大于当前 PC、且行号与当前行不同"的第一条记录。

**is_stmt 与 prologue-end 缺一不可。** `.debug_line` 的每条记录带 `is_stmt` 标志（该地址是否是语句边界）和 `prologue_end` 标志（函数序言结束的位置）。godbgv2 目前只用 `is_stmt` 做了一个过滤：`emitRow` 跳过 `!isStmt` 的行，所以 `Rows()` 里已经只有语句行；但 `LineEntry` 没有暴露 `IsStmt`，`prologueEnd` 虽然被解析进状态机、却没有任何代码读取（`pkg/dwarf/line.go` 的 `lineProgram.prologueEnd`）。缺了 prologue-end，`next` 在函数入口会算错：停在序言里时，"下一行"可能仍落在序言内。**当前帧与调用范围。** 候选地址必须限定在当前函数内，否则 `next` 会误停在别的函数里。`pkg/proc/funcs.go` 的 `BinaryInfo.FuncForPC(pc)` 能返回 `[Entry, End)`，`api.Function` 也带 `Entry`/`End`；此外 `pkg/proc/backtrace.go` 的 `ReturnAddress()` 用 CFA-8 取当前帧返回地址，供"当前行是函数最后一句、需要回到调用者"时使用。

**隐式断点的类型已经预留。** `pkg/proc/breakpoints.go` 定义了 `NextBreakpoint`，`canOverlap` 允许步进类断点与用户断点重叠，但仓库里没有任何生产者：它只出现在定义、`steppingMask` 和重叠单测中。真正在用的只有 `SetStepBreakpoint`（固定用 `StepBreakpoint`，供 stepout 使用）。

### 代码实现

#### 1. 现状：桩

`cmd/debug/next.go` 的核心代码如下（略去 `package`/`import` 与 `init` 注册）：

```go
var nextCmd = &cobra.Command{
    Use:     "next",
    Short:   "单步执行（跳过函数调用）",
    Aliases: []string{"n"},
    Annotations: map[string]string{
        cmdGroupAnnotation: cmdGroupCtrlFlow,
    },
    Run: func(cmd *cobra.Command, args []string) {
        // TODO(ch9.2.28): 源码级 next（行号表 + 临时断点）
        fmt.Println("TODO(ch9.2.28): next 尚未实现")
    },
}
```

两个细节需要点明：其一，它用 `Run` 而不是 `RunE`，不返回错误；其二，它打印一行提示就正常结束，退出码为 0。因此批量脚本或冒烟断言若只检查"命令没报错"，会把 `next` 当成成功——这是已知的"桩命令静默成功"问题，写测试时必须断言输出内容。

#### 2. 实现方案（设计稿，未实现）

编排放进符号层（`pkg/proc`，与 `StepOut` 同级），`api.Client` 增加与 `StepOut` 对称的 `Next() (*StopInfo, error)`，`cmd/debug/next.go` 只负责调用与展示。理由：`cmd/` 只经 `api.Client` 契约访问后端，碰不到行号表和 CFA。

```text
// 设计稿（伪代码，未实现）
Next():
  1. passOverCurrentBreakpoint()              // 已有：越过当前断点
  2. (file, line) = bi.PCToLine(pc)           // 当前停止位置
     fn = bi.FuncForPC(pc)                    // 当前函数 [Entry, End)
  3. 在 lineTable.Rows() 中找第一条满足
       Address > pc && Address < fn.End &&
       (File, Line) != (file, line)
     的行记录 → 候选停点
     if 当前 pc < prologue_end: 取 prologue_end 之后第一条 is_stmt 行
  4. 若无候选（当前行是函数最后一句）:
       候选 = ReturnAddress()                 // CFA-8，回到调用者
  5. SetNextBreakpoint(候选) 逐个设点          // NextBreakpoint 可重叠
  6. stop = dbp.Continue()
  7. 清除隐式断点（命中处含 PC 回退），printLocation
```

几个必须写进实现的约束：

- 隐式断点是全进程共享的。另一个 goroutine 恰好经过同一地址时，all-stop 也会停下；此时只有 `stop.PID == 当前线程 tid` 才能判定 `next` 完成，否则要继续等。
- 候选地址只取当前函数范围内，是本方案"跳过函数调用"的关键：被调函数体内没有隐式断点，执行完自然返回，再命中当前函数的下一行。代价是如果这一行调用了一个永不返回的函数，`next` 会一直等到用户中断。
- 第 4 步只处理"当前行是最后一句"；函数内多条语句共用一行、内联展开、defer/panic 路径都还没有方案。
- 当前行的判定要用有效 PC：断点命中时 PC 已加 1，`pkg/proc/variables.go` 用 `effectivePC`（pc-1 处有断点则取 pc-1），`next` 也必须如此，否则会把下一行误当成当前行。

#### 3. 实现前要补的缺口

1. `pkg/dwarf/line.go` 的 `LineEntry` 增加 `IsStmt`、`PrologueEnd` 字段，并在 `emitRow` 里填上；否则第 3 步无法判断可停点与序言结束。
2. `api.Client` 补"按 PC 查函数"的方法（proc 层 `BinaryInfo.FuncForPC` 已存在，只差契约），以及 `Next` 本身。
3. `pkg/proc/breakpoints.go` 补 `SetNextBreakpoint` 与清理函数；`NextBreakpoint` 目前只有定义。

### 执行测试

现状可以实跑，用来确认"未实现"这一事实（批量回放，`init.txt` 为脚本占位名，退出码 0）：

```bash
$ ./godbg exec _fixtures/loop --init init.txt
process 1912914 launched, stopped by SIGTRAP
godbg> next
TODO(ch9.2.28): next 尚未实现
godbg> exit
tracee is run by tracer, kill it
$ echo $?
0
```

注意 PC 没有任何变化：`next` 既没有设置断点，也没有调用 `Continue`。读者若在 `next` 之后接 `pregs`，看到的仍是上一条命令留下的停止位置。

### 本节小结

`next` 是 9.2 执行控制命令里唯一仍是桩的：桩打印 `TODO(ch9.2.28)`，退出码 0，语义上什么也没做。它的实现不是"再写一个 step"，而是把行号表、当前帧范围与隐式断点组合起来——先算下一行地址，再设 `NextBreakpoint` 后 continue，最后清理断点并按线程归属判定完成。前置改动集中在三处：行号表暴露 `IsStmt`/`PrologueEnd`、`api.Client` 补按 PC 查函数与 `Next`、断点层补 `SetNextBreakpoint`。在这些完成之前，书稿与冒烟测试都应把 `next` 记为未实现，而不是"无需调整"。
