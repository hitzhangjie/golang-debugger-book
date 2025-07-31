## Breakpoint part1: 现代调试器断点精细化管理

### 前言

断点是调试器能力的核心功能之一，在介绍指令级调试器时，我们详细介绍过断点的底层工作原理。如果你忘记了指令0xCC的作用，忘记了 `ptrace(PTRACE_PEEKDATA/POKEDATA/PEEKTEXT/POKETEXT, ...)` 的功能，忘记了处理器执行0xCC后会发生什么，忘记了Linux内核如何响应SIGTRAP信号，忘记了子进程状态变化如何通过SIGCHLD通知到父进程并__wake_up_parent唤醒阻塞在wait4上的ptracer，甚至忘记了ptracer调用wait4是用来干什么的 …… 那我建议读者可以先翻到 [第6章 动态断点](../../6-develop-inst-debugger/6-breakpoint.md) 小节快速回顾一下。

除此以外，作为我们本节及后续小节的前置内容，我们已经介绍了：

- 位置描述locspec：符号级调试器添加断点时，可以使用locspec支持的所有位置描述类型；
- 表达式求值evalexpr：条件断点，其实是普通断点+条件表达式，当断点命中后，tracer会检查该断点关联的条件表达式是否成立，如果不成立会立即恢复tracee的执行；
- 反汇编操作disass：符号级调试器中对特定指令地址添加断点，也是支持的，但是我们可能需要先借助反汇编操作对指定源码位置进行反汇编，看到对应的指令列表后再确定加断点的地址；

本节内容不会再重复上述底层细节，而是会将精力聚焦在现代调试器中对断点的精细化管理上，包括逻辑断点与物理断点，物理断点重叠点与Breaklets，硬件断点与软件断点。调试器gdb、lldb等也是采用了与本节内容相仿的设计，所以当你掌握了本节内容，可以很自信地说掌握了现代调试器的断点精细化管理。

OK，接下来我们一起看看符号级调试断点管理这块存在哪些挑战，以及如何通过层次化、精细化管理来解决这些挑战。

### 定点停车的艺术

大家在坐地铁时，都有注意到列车车门会通过“定点停车”相关的技术让列车车门与站台精准对齐，以方便乘客上下车。大家早已见怪不怪，大家有没有想过，调试器如何做到“定点停车”？

读者可能想到了调试器支持各种类型的位置描述locspec，对，它提供了描述源码位置 or 指令地址的方式。单纯就源码位置而言，每一行源码可能对应着1个or多个表达式、1个or多个语句，每个表达式、语句有会对应着多条机器指令 …… 那1个源码位置对应着那么多条指令，究竟应该在哪些指令地址处添加断点呢？

这涉及到DWARF行号表一个十分关键的设计 `lineEntry.IsStmt`，每行源码对应哪些机器指令，这个编译器生成指令时早就确定了，并且编译器知道在哪条指令地址处设置断点更加合适，所以会在对应行号表中记录对应指令的 `lineEntry.IsStmt=true` 。当指定了locspec实例，并解析对应的断点位置列表时，就需要通过 `lineEntry.IsStmt=true` 对lineEntries进行筛选，筛选出来的每个lineEntry都对应着一个候选断点地址lineEntry.Addr。

然后，在这些地址处通过指令patch添加断点，或者通过调试寄存器添加断点，也就实现了定点停车。

### 执行到下行源码

#### 执行一行源码：next

以next操作为例，它表示要执行到下一行，那如何确定下一行是哪一行呢？

- 对于顺序执行的代码，可以从当前PC确定行号，然后line++直到找到下一个包含可执行指令的行(跳过注释、空行等)，在该处设置断点即可。
- 对于代码包含分支控制(if-else、switch-case)和循环控制(for、break、continue)时，还可以继续line++来寻找吗？

明显不行！下面这个示例比较容易说明这点：此时简单地递增行号是错误的。因为程序包含了分支控制、跳转，程序可能跳转回forloop判断语句或特定LABEL处，行号并不是简单地 `+1` ，下一行的行号可能变大、变小。

```go
10     var uploaded int
11 UploadNextFile:
12     for _, f := range files {
13         _, err := uploader.Upload(f)
14         if err != nil {
15             if err == APIExceedLimit {
16                 slog.Error("exceed api limit ... quit")
17                 break UploadNextFile          // <= 执行next，应该执行到 line 29
18             }
19             if err == APIBadFileFormat {
20                 slog.Error("bad file format ... try next")   
21                 continue                      // <= 执行next，应该执行到 line 12
22             }
23             slog.Error("unknown error ... quit")
24             break UploadNextFile
25         }
26         slog.Info("upload success", slog.String("file", f.Name)) // <= 执行next，应该执行到 line 12
27     }
28 
29     println("uploaded files:", uploaded)      // <= 执行next，应该执行到 line 30
30     println("total files:" len(files))
```

DWARF行号表支持通过PC查询对应源码行，但无法直接获取"下一行要执行的源码"，那我们如何才能做到这点呢？

| 方案列表 | 执行操作                                                                                  | 是否可行 | 原因                                                            |
| -------- | ----------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| 方案1    | 从当前PC开始顺序扫描指令，<br />直到找到对应行号不同的PC位置                              | 否       | 要频繁读取内存指令数据，还必须对jmp、call指令进行分析，非常低效 |
| 方案2    | 通过AST分析函数体，<br />识别并处理各类控制流，<br />在控制流的分支判断表达式处均添加断点 | 否       | 需要做复杂的AST分析，且容易受Go语言版本演进中AST变化的影响      |
| 方案3    | ？                                                                                        | ？       | ？                                                              |

方案1、方案2工程中都是难以落地的，有没有更简单有效的办法呢？有！

我们换个思路，用 **一种更简单高效的“广撒网”的方式**，而不是只在要执行的下一行源码处设置断点：

1. 执行next操作时，首先确定当前PC；
2. 进而确定当前PC所属的函数，通过函数FDE确定函数的指令地址范围 [low,high)；
3. 然后在行号表中筛选出这样的lineEntries：
   - lineEntry地址必须是在函数指令地址范围[low,high)内；
   - 并且lineEntry.IsStmt=true；
4. 在筛选出的lineEntries的lineEntry.Addr处添加断点；

以 `for i:=0; i<10; i++ {...}` 为例，编译工具链生成DWARF行号表时，会为 i:=0、i<10、i++ 这几个位置处的指令生成对应的lineEntries，每个位置都存在一个lineEntry满足lineEntry.IsStmt=true。调试器可以在这些entries的Addr处设置断点。这样我们就能确保在循环执行过程中正确地停在 i:=0、i++、i<10 这几个位置，而不是直接执行到forloop循环体之后的位置。

这种方法，不仅可以解决上述forloop的问题，即使源码中包含了break、continue、break LABEL、continue LABEL，也同样奏效。

#### 进入退出函数：stepin, stepout

stepin和stepout的实现也需要自动隐式创建断点：

- stepin, 函数入口地址可以从函数定义对应的DWARF DIE获取，
- stepout, 而返回地址则需要通过DWARF调用帧信息(CFA)进行计算，

这样执行stepin、stepout时，在相应位置设置好断点位置，并continue执行到断点位置即可。

#### Go定制化需要：StackSplit

go为了支持协程栈伸缩，编译器在函数序言部分安插了一些栈检查指令，go函数调用时首先进行栈大小检查，如果栈大小不够用了，就会创建一个更大的栈，并将当前栈上的数据copy过去，然后调整goroutine的一些硬件上下文信息，也包括将goroutine的栈指向这个新的栈。这个过程俗称 "**栈分裂 stacksplit**"。当完成上述过程后，需要通过跳转指令重新跳转回指令函数地址开头，然后重新开始执行。

stacksplit特殊在哪里？为什么需要调试器特别关注？不妨思考下stepin时应该在函数入口哪个指令地址处添加断点。函数开头的第一条指令？第二条指令？or others? 如果我们在第一条指令 or 第二条指令处添加断点，那么我们大概率会观察到一个函数被调用了两次，很诡异。实际上我们应该停在stacksplit、callee保存rbp并重新更新rbp之后的第一条指令位置处。类似地，Go调试器需要对此做特殊处理。

以下面源码为例，我们来说明下特殊处理的必要性，然后执行 `go build -o main -gcflags 'all=-N -l' main.go` 完成构建：

```go
01 package main
02
03 func main() {
04        var a int = 1
05        var b int = 2
06        var c int
07
08        c = Add(a, b)
09        println(c)
10 }
11
12 func Add(a, b int) int {
13        return a + b
14 }
```

接下来我们使用 radare2 (r2) 来演示下go函数反汇编后指令执行、跳转流程，很明显可以看到main.main开头存在一个栈检查、栈分裂过程：

```
$ r2 ./main
[0x00470b60]> s sym.main.main
[0x00470ae0]> af
[0x00470ae0]> pdf
┌ 103: sym.main.main ();
│ afv: vars(3:sp[0x10..0x20])
│       ┌─> 0x00470ae0      493b6610       cmp rsp, qword [r14 + 0x10]               // main.main入口地址
│      ┌──< 0x00470ae4      7659           jbe 0x470b3f                              // 如果栈空间不够，则跳转到0x004700b3f执行stacksplit
│      │╎   0x00470ae6      55             push rbp  
│      │╎   0x00470ae7      4889e5         mov rbp, rsp
│      │╎   0x00470aea      4883ec28       sub rsp, 0x28                             // <== 栈分裂+callee保存并设置帧基址后，这个地址更适合用做断点
│      │╎   0x00470aee      48c7442420..   mov qword [var_20h], 1
│      │╎   0x00470af7      48c7442418..   mov qword [var_18h], 2
│      │╎   0x00470b00      48c7442410..   mov qword [var_10h], 0
│      │╎   0x00470b09      b801000000     mov eax, 1
│      │╎   0x00470b0e      bb02000000     mov ebx, 2
│      │╎   0x00470b13      e848000000     call sym.main.Add
│      │╎   0x00470b18      4889442410     mov qword [var_10h], rax
│      │╎   0x00470b1d      0f1f00         nop dword [rax]
│      │╎   0x00470b20      e85b8bfcff     call sym.runtime.printlock
│      │╎   0x00470b25      488b442410     mov rax, qword [var_10h]
│      │╎   0x00470b2a      e8f191fcff     call sym.runtime.printint
│      │╎   0x00470b2f      e88c8dfcff     call sym.runtime.printnl
│      │╎   0x00470b34      e8a78bfcff     call sym.runtime.printunlock
│      │╎   0x00470b39      4883c428       add rsp, 0x28
│      │╎   0x00470b3d      5d             pop rbp
│      │╎   0x00470b3e      c3             ret
│      └──> 0x00470b3f      90             nop
│       ╎   0x00470b40      e89badffff     call sym.runtime.morestack_noctxt.abi0   // stacksplit
└       └─< 0x00470b45      eb99           jmp sym.main.main                        // 当stacksplit准备ok后，重新跳转回main.main执行
[0x00470ae0]>
```

前面我们提过了，为了避免栈分裂导致的同一个函数被调用两次的假象，我们不应该在栈检查相关的几条指令位置添加断点，如 `0x00470ae0` `0x00470ae4` 这几条都是不合适的，但是偏偏go编译器生成行号表的时候，将 `0x00470ae0` 对应的lineEntry.IsStmt设置为了true，意味着调试器应该将此为止作为一个断点位置。

你可以通过dwarfviewer来查看行号表，下面是截取的一部分main.main开头的指令对应的行号表lineEntries:

```
Address	Line	File	Column	IsStmt	Basic Block
0x00470ae0	3	/home/zhangjie/debugger101/test/go_func/main.go	0	true	false   // 这个位置不合适，栈分裂时会导致同一个函数被执行两次的假象
0x00470aea	3	/home/zhangjie/debugger101/test/go_func/main.go	0	true	false   // 这个位置可以！
0x00470aee	4	/home/zhangjie/debugger101/test/go_func/main.go	0	true	false
0x00470af7	5	/home/zhangjie/debugger101/test/go_func/main.go	0	true	false
```

其实将 `0x00470ae0` 作为候选断点位置不太合适，至少对普通开发者来说是不合适的。但是对于运行时调试人员，比如你想跟踪stacksplit，那么在 `0x00470ae0` 设置断点就是合适的。所以也可以理解成go编译器开发人员给了调试器设计人员一定的自由度，你可以通过一个选项来打开对stacksplit的跟踪（在0x00470ae0设置断点），默认不跟踪stacksplit（在0x00470aea设置断点）。

> 关于如何使用dwarfviewer查看行号表？
>
> 执行命令  `dwarfviewer -file=./main -view=line -webui`, 然后使用浏览器打开webui（ http://localhost:8080 ），注意从webui左侧侧边栏中选择编译单元 `main`，便可以查看该编译单元的行号表。

### 隐式断点操作 `next` `stepin` `stepout`

符号级调试器中，用户会通过执行 `break` 命令显式创建的断点，也有些调试命令会隐式地自动创建断点，比如 `next` `stepin` `stepout`。

我们这里比较下step和next，step表示步进单条指令，next表示执行到下一行源码处：

- 在指令级调试器中，step命令通过 `ptrace(PTRACE_SINGLESTEP, ...)`开启CPU单步执行模式来实现指令级别的步进。本质上是CPU控制的，CPU发现flags是步进模式，那么就执行一条指令后触发一个DebugException，该异常处理程序中会让tracee停下来，并通知tracer来观察tracee状态。
- 而在符号级调试器中，要实现next源码行级别的步进操作，就需要智能地确定要执行到的下个源码行是哪一行，并在此处设置对应的断点，然后continue到此断点处，如果是0xCC软件断点则触发BreakpointException，该异常处理程序中会让tracee停下来，并通知tracer来观察tracee状态。通过这种方式来实现源码行级别的步进。

stepin和stepout的实现也需要自动隐式创建断点：

- stepin, stepin一个函数时，需要在函数入口地址处添加断点，然后continue到断点处；
- stepout, 从一个函数中stepout时，需要在函数返回地址处添加断点，然后continue到断点处；

**为了方便在源码级别进行调试，符号级调试器会隐式地自动创建断点**。设想下，如果没有next自动地断点管理机制，要实现执行一行源码的操作，我们还需要手动走读下代码判断下下一行源码位置是跳转到line10还是line20，然后再手动添加断点，再continue …… 这得多不方便。

### 隐式断点细分

为了更好地进行断点管理，需要区分人工手动创建、隐式自动创建的断点，对后者还需要再进一步细分其创建的情景、原因。当上述两类断点在同一个源码位置多次添加时、重叠时，我们需要精细化控制这个断点的行为。

```go
// BreakpointKind determines the behavior of debugger when the breakpoint is reached.
type BreakpointKind uint16

const (
    // 用户执行break命令创建的断点
    UserBreakpoint BreakpointKind = (1 << iota)
    // 用户执行next命令时隐式创建的断点
    NextBreakpoint
    // ...
    NextDeferBreakpoint
    // ...
    StepBreakpoint
    // ...
    WatchOutOfScopeBreakpoint
    // ...
    StackResizeBreakpoint
    // ...
    PluginOpenBreakpoint
    // 用户执行stepin命令时隐式创建的断点
    StepIntoNewProcBreakpoint
    // ...
    NextInactivatedBreakpoint
    // ...
    StepIntoRangeOverFuncBodyBreakpoint

    // 该bitset表示步进操作断点的所有类型
    steppingMask = NextBreakpoint | NextDeferBreakpoint | StepBreakpoint | StepIntoNewProcBreakpoint | NextInactivatedBreakpoint | StepIntoRangeOverFuncBodyBreakpoint
)
```

### 逻辑断点 vs 物理断点

我们期望在指定的一个源代码位置处添加断点，在个别特殊场景下，为了达到这个断点效果，我们要在多个不同机器指令地址处添加断点。

考虑如下几种常见情况：

- Go泛型函数 `func Add[T ~int|~int32|~int64](a, b T) T {return a+b;}`，如果程序中使用了 `Add(1,2), Add(uint(1), uint(2))` 那么这个泛型函数就会为int、uint分别实例化两个函数（了解下Go泛型函数实现方案，gcshaped stenciling）。继续转成机器指令后，泛型函数内同一个源码行自然就对应着两个地址（一个是int类型实例化位置，一个是uint类型实例化位置）。
- 对于函数内联，其实也存在类似的情况。满足内联规则的小函数，在多个源码位置多次调用，编译器将其内联处理后，函数体内同一行源码对应的指令被复制到多个调用位置处，也存在同一个源码行对应多个地址的情况。

实际上我们执行 `break locspec` 添加断点的时候，我们压根不会去考虑泛型函数如何去实例化成多个、哪些函数会被内联。即使知道也肯定不想用泛型函数实例化后的指令地址、函数内联后的地址去逐个设置断点 …… 因为这样非常不方便。

**“在1个源码位置添加断点，实际上需要在泛型实例化、内联后的多个指令地址处创建断点”**，为了描述这种关系，就有了**“逻辑断点” 和 “物理断点”** 的概念：

- 逻辑断点：`break 源码位置`，通过这种方式创建断点，会在对应源码位置处创建1个逻辑断点；
- 物理断点：逻辑断点强调的是源代码位置，物理断点强调的是底层实现时要用断点指令0xCC进行指令patch，一个逻辑断点对应着至少1个物理断点。
  泛型函数多次实例化、满足内联规则的函数多次内联时，1个逻辑断点会对应着多个物理断点。

实际日常调试过程中，我们说“添加断点”强调的是更容易感知的“逻辑断点”，底层实现时会涉及1个或多个“物理断点”的创建。

### 断点重叠管理 breaklet

先举个例子，比如有下面代码片段: 假定当前我们现在停在11行这个位置，现在我们执行 `break 12` 那么将会在12行创建一个逻辑断点，对应的也会创建1个物理断点，然后我们执行 `next`操作来逐源码行执行。next操作会确定当前函数范围，并为函数内所有指令地址对应的lineEntry.IsStmt的指令地址处增加一个断点，12行也不例外。

此时，在12行就出现了两个创建逻辑断点的操作，一个是人为 `break 12`设置的，一个是 `next` 隐式创建的。这里的两个逻辑断点，最终也是要去设置物理断点的，但是我们怎么明确表示这个地址处实际上是有两个“物理断点”发生了重叠呢？

```go
   10 for {
=> 11     i++
   12     println(i)
   13 }
```

重叠意味着什么呢？物理断点最终是否生效，需要综合重叠的多个断点的创建逻辑、断点激活条件来判断。举个例子，比如某个逻辑断点命中n次后才触发激活，或者命中超过m次后就不再激活，调试期间执行到此断点时tracee也停下了，但是tracer发现条件不满足断点激活条件，tracer便会执行PTRACE_CONT操作恢复tracee执行。但是，假如当前断点位置有next隐式创建的断点，那么实际上这个断点处还是应该停下来，因为next操作设计预期就是如此，它比条件断点的条件判断优先级还要高。

那怎么描述这种同一个物理断点处存在多个断点的重叠呢？这就要引入 `Breaklet` 抽象。

OK，截止到这里，我们可以抛出逻辑断点、物理断点、Breaklet三者的层次关系了：

```go
// 1个逻辑断点包含多个物理断点，解决的是泛型函数、函数内联情况下，
// 一个源码位置处添加逻辑断点对应多个机器指令位置添加物理断点的问题
type LogicalBreakpoint struct {
    breakpoints []*Breakpoint
    ...
}

// 1个物理多点包含至少1个breaklets，解决的是描述多个断点在同一个物理地址处重叠的问题
type Breakpoint struct {
    breaklets []*Breaklet
    ...
}

// Breaklet表示多个在同一个物理断点处重叠的多个断点之一
type Breaklet struct {
    // 表示是否是一个步进断点（next、step）
    Kind      BreakpointKind

    // 当前物理断点归属的逻辑断点的ID
    LogicalID int

    // 如果不为nil，Cond表达式求值为true时该断点才会激活，
    // 不激活的意思就是调试器会发现tracee触发断点后，会主动执行continue让tracee继续执行
    Cond      ast.Expr

    // 当这个breaklet的所有条件都满足时，触发这个回调，这个回调逻辑允许包含带副作用的逻辑，
    // 返回true时表示这个断点是active状态
    callback func(th Thread, p *Target) (bool, error)

    ...
}
```

Ok，结合上面伪代码，现在我们可以简单总结下：

- 同一个逻辑断点可能对应着多个物理断点，因为Go支持泛型函数、函数内联；
- 同一个物理断点可能有多个breaklets，因为多个断点在同一个物理断点处会出现重叠；
- 每个breaklet表示在同一个物理断点处重叠的多个断点之一
  - 它有独立的断点类型Kind来区分每个断点添加原因；
  - 它有标识字段体现它实际上从属于哪一个逻辑断点；
  - 每个breaklet有自己的激活条件；
  - 每个breaklet的所有条件满足时，有自己的callback可以触发执行；

### 软件断点 vs 硬件断点

调试器实现断点的方式主要有两种：软件断点和硬件断点。

- 软件断点是通过断点指令0xCC进行指令patch，软件断点相对来说使用更普遍，兼容性更好，但会修改目标程序指令。
- 硬件断点则是利用CPU提供的调试寄存器（如x86的DR0-DR7）来实现的，不需要修改指令，能监视代码执行和数据访问，但调试寄存器数量有限。

#### 软件断点

不同处理器架构有不同的断点指令，以x86为例，其断点指令是0xCC（INT 3）。
当处理器执行了指令0xCC后，处理器会产生#BP异常（向量号3，BreakpointException），内核捕获该异常并通知调试器。

#### 硬件断点

以x86架构为例，提供了4个调试地址寄存器(DR0-DR3)和2个调试控制寄存器(DR6-DR7)来支持硬件断点。

当设置一个硬件断点时，需要执行如下操作:

1. 将断点地址写入某个未使用的DR0-DR3寄存器
2. 在DR7中设置对应的控制位:

   - L0-L3位: 启用对应的DR0-DR3断点(置1启用)
   - G0-G3位: 全局启用对应断点(置1启用)
   - R/W0-R/W3位: 设置断点类型
     - 00: 执行断点
     - 01: 数据写入断点
     - 11: 数据读写断点
   - LEN0-LEN3位: 设置监视的数据长度(1/2/4/8字节)

当程序执行到断点地址或访问监视的内存时，处理器会产生#DB异常(向量号1, DebugException)，内核捕获该异常并通知调试器。

#### 异常处理

无论是软件断点产生的#BP异常，还是硬件断点产生的#DB异常，产生异常后，处理器会立即转入对该异常的处理。具体流程是：处理器从中断描述符表(IDT)中找到该异常对应的处理程序入口地址，然后跳转到该异常处理程序去执行。这里的IDT是在内核启动时设立的，每个异常对应的处理程序都是Linux内核提供的。

Linux内核的异常处理程序执行时，会生成SIGTRAP信号发送给tracee。比较特殊的是，SIGTRAP信号的处理也是内核负责的，内核会进一步通知tracer。tracer此时一般处于wait4阻塞等待状态，等内核通过SIGCHLD信号和__wake_up_parent机制唤醒tracer后，tracer就可以使用ptrace相关操作去获取tracee的运行时状态了。

> **术语澄清**：严格来讲，"中断"这个术语可以泛指异常(exception)、陷阱(trap)、外部中断(interrupt)，也可以专指外部中断。外部中断是外设通过中断控制器连接到CPU的INTR引脚产生的，CPU在每个指令执行周期结束时通过中断控制器（负责中断屏蔽、按优先级扫描设备中断）来感知接下来需要处理哪个外设的中断请求。外部中断的处理是异步的，而上述提及的软件断点通过安插指令来生成异常并处理的方式是同步的。
>
> -Exception（异常）：通常由程序错误或CPU检测到的特殊情况产生（如除零、无效指令、页错误等），向量号0-31。其实0-31中的异常可以细分为faults可恢复的异常, traps调试相关, aborts不可恢复的三大类。
> -Trap（陷阱）：是一种特殊的异常，通常用于调试（如#DB, #BP），陷阱处理后会返回到异常指令的下一条。
> -Interrupt（中断）：通常由外部设备产生（如定时器、键盘、网卡等），向量号32及以上。

### 支持多进程+多线程调试

并发编程模型，当前无外乎多进程、多线程、协程这几种编程模型，以Go为例吧，Go暴漏给开发者的并发操作是基于goroutine的，但是goroutine执行最终还是依赖于thread。对Linux而言，thread实现其实是轻量级进程LWP，我们可以通过系统调用clone结合一些资源复制选项来创建线程。有时我们也会实现多进程程序，比如支持热重启的微服务框架。OK，调试器如果能够方便地支持对多进程、多线程、协程进行跟踪，那肯定是非常方便的。

#### tid or pid

对调试器而言，所有的被跟踪对象tracee都是就线程这个身份来说的。线程隶属于进程，`getpid()`返回的是所属进程ID，`syscall(SYS_gettid)`返回的是线程ID，这里的tid就是线程对应的LWP的pid。ptrace操作的参数pid，其实指的就是线程对应的轻量级进程的pid。ps: `/proc/<pid>/tasks/` 下是进程包含的线程的tid（对应的LWP的pid）。

#### 调试困难点

多进程调试、多线程调试、协程调试的困难点：

- 当父进程创建子进程时，如何自动跟踪子进程，如果需要手动加断点让子进程停下来，会错过合适的调试时机；
- 当进程内部创建新线程时，如何自动跟踪新线程，如果需要手动加断点让新线程停下来，也会错过合适的调试时机；
- 当跟踪某个协程goroutine-10时，continue恢复现成执行后，GMP调度器可能会调度另一个goroutine-20来执行并停在断点处，但是我们期望跟踪的是goroutine-10；

对于自动跟踪新进程、新线程，我们需要通过自动跟踪新创建的进程、线程。对于跟踪特定协程执行，我们可以借助条件断点的方式，调试器可以给断点加条件 `break [--name|-n name] [locspec] [if condition]` 相当于调试器内部隐式加个条件 `cond runtime.curg.goid == 创建断点时goid`。都可以相对简单的搞定。

#### 断点传播

我们需要进一步思考的是，断点的管理，是否需要针对线程或者进程粒度单独进行维护呢？假设我们现在正在调试的是进程P1的线程T1，调试期间我们创建了一些断点。

思考以下问题：

1. 当我们切换到进程P1的线程T2去跟踪调试的时候，你希望这些断点在T2继续生效吗？
2. 再或者进程P1 forkexec创建了子进程P2，你希望上述断点在P2也生效吗？

对于问题1，从实践角度来说，大家是倾向于添加一个断点后，这个断点对当前进程的所有线程生效，但是我们可能更倾向于跟踪当前线程，所以更希望当前线程运行到断点后停下来，而不是其他线程运行到断点后就停下来。

对于问题2，有可能父子进程运行的代码是完全一样的，也可能子进程通过exec替换了可执行的代码，对于前者，我们还是倾向于能够自动将父进程设置过的断点，让它在子进程也生效的。

对于问题1，我们不需要特殊处理，因为同一个进程中的线程执行的代码都是相同的，设置了断点之后对所有线程都是生效的。对于问题2，尤其是父子进程执行相同代码的情况，我们是希望能够将父进程中的断点给传播到子进程，让这些断点在子进程中也生效的。

#### Stop Mode

当进程执行期间命中断点时，是只让命中断点的线程停下来，还是让其内部的所有线程都停下来？这其实就是主流调试器采用的两种控制模式：All-stop Mode 和 Non-stop Mode。但是从实践来看，当触发断点时能够默认暂停整个进程中的所有活动（All-stop Mode），对调试来说是更便利的，开发者可以有更多时间去观察。

ps：默认暂停整个进程中的所有活动比较便利，但是也要同时伴之以提供恢复某个特定进程、线程的执行，这在调试某几个有协作关系、并发执行的线程时，是非常有价值的。

##### All-stop Mode

当一个线程命中断点时，主流调试器 (如 GDB, LLDB, Delve, Visual Studio Debugger 等) 的默认行为是暂停整个进程，也就是暂停所有其他线程。这种模式通常被称为 "All-Stop Mode"。

为什么更倾向于将All-stop Mode作为默认行为？主要原因是为了保证调试会话的一致性和可预测性：

1. 冻结状态：当您在某个断点停下来时，您希望检查的是程序在“那一个瞬间”的完整状态。如果其他线程继续运行，它们可能会修改内存、改变变量值、释放资源等。这样一来，您在调试器中看到的数据可能在您查看它的下一秒就失效了，这会让调试变得几乎不可能。
2. 避免数据竞争：让其他线程继续运行会引入新的、仅在调试时才会出现的竞态条件（Race Condition），或者掩盖掉您正在试图寻找的那个竞态条件。
3. 可控的执行：当您单步执行（Step Over, Step Into）代码时，您期望只有当前线程执行一小步。如果其他线程在后台“自由飞翔”，那么程序的全局状态在您执行一步之后可能会发生天翻地覆的变化，这违背了单步调试的初衷。

当一个线程因为断点（通常是一个特殊的陷阱指令，如 x86 上的 INT 3）而暂停时：

1. CPU 产生一个异常。
2. 操作系统内核捕获这个异常，并通知正在监控（trace）这个进程的调试器。
3. 调试器接收到通知，此时它获得了控制权。
4. 调试器会立即通过操作系统接口，向该进程的其他所有线程发送一个暂停信号（如 SIGSTOP），将它们全部“冻结”住。

##### Non-stop Mode

虽然“All-stop”是默认且最常用的模式，但现代调试器也支持另一种高级模式，称为 "Non-stop Mode"。

在 Non-stop 模式下，当一个线程命中断点时，只有该线程被暂停，其他线程可以继续运行。调试器可以独立地控制每一个线程的执行（暂停、继续、单步等）。

什么时候会使用 Non-stop 模式？这通常用于一些特殊的、复杂的调试场景：


- 实时系统：比如一个线程负责UI响应，您不希望因为调试后台工作线程而导致整个界面卡死。
- 监控程序：一个线程可能需要持续地响应心跳或处理网络请求，暂停它会导致连接超时。
- 分析复杂的并发问题：您可能想观察当一个线程被“卡住”时，其他线程的行为模式。

在 GDB 中，你可以通过 `set non-stop on/off` 命令来切换这两种模式。但毫无疑问，Non-stop 模式对调试者的心智负担远大于 All-stop 模式。

ps：后续可以看到tinydbg的一些设计，为同时启停进程组内的多个进程、同一个进程内的多个线程，提供了支持。

### Put it Together

OK，上面这些统筹起来，就是现代调试器断点管理的层次结构，tinydbg的实现也借鉴了类似的设计。

```bash
TargetGroup (调试器跟踪的进程组 debugger.Debugger.target)
├── LogicalBreakpoints map[int]*LogicalBreakpoint  // 调试器维护的全局逻辑断点
└── targets []proc.Target (进程组中的多个进程)
    ├── Target 1 (进程P1, 包含多个threads)
    │   └── BreakpointMap (每个进程的断点映射)
    │       ├── M map[uint64]*Breakpoint           // 物理断点（按地址索引）
    |       |                 ├── []*Breaklet      // 每个物理断点又包含了一系列的Breaklet，
    |       |                                         每个Breaklet有自己的Kind,Cond,etc.
    │       └── Logical map[int]*LogicalBreakpoint // 逻辑断点（共享引用）
    └── Target 2 (进程P2, 包含多个threads)
        └── BreakpointMap (每个进程的断点映射)
            ├── M map[uint64]*Breakpoint           // 物理断点（按地址索引）
            |                 ├── []*Breaklet      // 每个物理断点又包含了一系列的Breaklet，
            |                                         每个Breaklet有自己的Kind,Cond,etc.            
            └── Logical map[int]*LogicalBreakpoint // 逻辑断点（共享引用）
```

tinydbg，它做到了这些方面：

- **跟踪进程组的多进程与多线程**: 支持跟踪进程组中的多进程、多线程，并支持对它们的启停等进行统一管理；
- **逻辑断点与物理断点层次区分**：1个逻辑断点可以对应多个物理断点，同1个物理断点处允许存在多个断点在此处重叠；
- **逻辑断点全局共享，统一管理**：所有断点都是逻辑断点，在 TargetGroup 级别统一管理；
    也因此，逻辑断点状态也做到了全局共享，如断点命中计数等信息在逻辑断点级别维护，所有进程、线程共享；
- **自动断点传播机制，调试便利**：新进程、新线程自动继承现有的断点；
    也允许通过 follow-exec 和正则表达式控制断点传播范围，如子进程cmdline匹配正则时才继承断点；
- **断点实现灵活，基于软件&硬件**：根据调试场景及当时状态，选择适用的软件&硬件断点方案；
- **手动创建&隐式创建完美协作**：通过breaklets解决调试人员手动创建的断点、其他调试命令隐式创建的断点重叠的问题；
- **Stop-all Mode并支持切换**：在Stop-all Mode这种更直观的场景上，支持threads/goroutines切换，更好适应并发调试场景；

这使得它成为了一个非常实用的Go调试器，它也成为了现代调试器设计实现的典型代表，致敬 go-delve/delve 的贡献者们。

### 本文总结

本文围绕现代调试器（以 go-delve/delve 为例）中断点的精细化管理展开，系统梳理了逻辑断点、物理断点、Breaklet 等多层次断点抽象，以及它们在支持泛型、内联、断点重叠等复杂场景下的作用。我们还介绍了多进程多线程调试时的断点的自动传播机制、断点启用策略（如 follow-exec 及正则过滤）、Stop-all与Non-stop Mode，以及 next/stepin/stepout 等调试命令背后的隐式断点管理。通过这些机制，调试器能够在多进程、多线程、复杂控制流下，实现灵活、精准且高效的断点控制，极大提升了调试的便利性。

本文主要聚焦于断点管理的原理和设计思想，尚未深入到具体的实现细节和源码分析。下一小节我们进一步剖析实现断点的一些关键操作，将原理与实践相结合，更好地理解和掌握现代调试器的断点管理。
