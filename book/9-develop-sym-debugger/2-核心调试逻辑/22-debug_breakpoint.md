## Breakpoint

断点是调试器能力的核心功能之一，在介绍指令级调试器时，我们详细介绍过断点的底层工作原理。如果你忘记了指令0xCC的作用，忘记了 `ptrace(PTRACE_PEEKDATA/POKEDATA/PEEKTEXT/POKETEXT, ...)` 的功能，忘记了处理器执行0xCC后会发生什么，忘记了Linux内核如何响应SIGTRAP信号，忘记了子进程状态变化如何通过SIGCHLD通知到父进程并唤醒阻塞在wait4上的ptracer，甚至忘记了ptracer调用wait4是用来干什么的 …… 那我建议读者可以先翻到 [第6章 动态断点](../../6-develop-inst-debugger/6-breakpoint.md) 小节快速回顾一下。

本节内容不会再重复上述底层细节，而是会将精力聚焦在现代调试器中对断点的精细化管理上，包括逻辑断点与物理断点，物理断点重叠点与Breaklets，硬件断点与软件断点。调试器gdb、lldb等也是采用了与本节内容相仿的设计，所以当你掌握了本节内容，可以很自信地说掌握了现代调试器的断点精细化管理。

### 实现目标: `breakpoint` `breakpoints` `clear` `clearall` `toggle`

本节实现目标，重点是介绍断点的精细化管理，以及添加断点命令 `breakpoint` 的设计实现。由于采用了断点的精细化管理措施，引入了一些必要的层次设计及抽象，代码复杂度、理解难度也随之增加。断点强相关的调试命令，为了读者阅读起来更加友好，我们不会一个小节就介绍完所有与断点强相关的指令，而是先介绍提及的几个：

- breakpoint，添加断点、条件断点；
- breakpoints，列出所有断点；
- clear，移除指定断点；
- clearall，移除所有断点；
- toggle，激活、关闭指定断点；

另外几个断点相关的命令，我们会在后续小节中介绍：

- condition，将已有断点转化为条件断点；
- on，设置断点命中时要执行的具体动作；
- trace，在指定位置设置tracepoint，本质上还是断点，命中后并打印相关位置信息，然后恢复执行；
- watch，监视对某个变量或者内存地址处的读写操作，是借助硬件断点来实现的；

ps：说它们相关，是因为这几个命令的实现也是在断点基础上实现的，`condition` 为断点命中增加条件限制，`on` 在断点命中时执行后置动作，`trace` 在断点命中时打印位置信息，`watch` 相对特殊一点使用硬件断点来实现。

### 基础知识

除了本文开头的那些基础知识以外，符号级调试器添加断点时用到的位置描述locspec，以及可能涉及到条件断点的表达式求值操作evalexpr，甚至是想在特定指令地址处添加断点，可能需要先反汇编看下有哪些指令等，这些我们都当做本节前置内容介绍了。如果你理解了指令级调试器时介绍过的断点工作原理，以及这里的locspec、evalexpr，后面理解其逻辑断点、物理断点的关系，以及条件断点的实现，都会更加轻松一点。

OK，接下来我们一起看看符号级调试断点管理这块存在哪些挑战，以及如何通过层次化、精细化管理来解决这些挑战。

#### 隐式断点操作 `next` `stepin` `stepout`

符号级调试器中的断点处理不仅包括用户显式创建的断点，某些调试命令也会自动创建断点。

我们这里比较下step和next，step表示步进单条指令，next表示执行到下一行源码处：

- 在指令级调试器中，step命令通过 `ptrace(PTRACE_SINGLESTEP, ...)`开启CPU单步执行模式来实现指令级别的步进。本质上是CPU控制的，CPU发现flags是步进模式，那么就解码一条指令后停下来了。
- 而在符号级调试器中，要实现next源码行级别的步进操作，就需要智能地确定要执行到的下个源码行是哪一行，并在此处设置对应的断点，然后continue到此断点处，通过这种方式来实现源码行级别的步进。

stepin和stepout的实现也需要自动隐式创建断点：

- stepin, stepin一个函数时，需要在函数入口地址处添加断点，然后continue到断点处；
- stepout, 从一个函数中stepout时，需要在函数返回地址处添加断点，然后continue到断点处；

调试器中涉及到大量的隐式断点的操作，后面我们遇到时会再介绍。

#### 如何确定源码下一行

##### next

以next操作为例，它表示要执行到下一行，那如何确定下一行是哪一行呢？

- 对于顺序执行的代码，可以从当前PC确定行号，然后line++直到找到下一个包含可执行指令的行(跳过注释、空行等)，在该处设置断点即可。
- 对于代码包含分支控制(if-else、switch-case)和循环控制(for、break、continue)时，还可以继续line++来寻找吗？

明显不行！此时简单地递增行号是错误的，因为程序包含了分支控制，涉及到一些跳转指令跳转回判断语句或特定LABEL处，行号并不是 `+1` 这么简单，它可能会变大，也可能会变小。下面这个示例比较容易说明这点。

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

- 方案一: 从当前PC开始顺序扫描指令，直到找到行号不同的PC位置。这不可行，因为不仅要读取大量指令数据，还要解码jmp、call指令，非常低效。
- 方案二: 通过AST分析函数体，识别并处理各类控制流，在控制流的分支判断表达式处添加断点。这也不可行，这需要复杂的AST分析，且容易受Go语言版本演进AST结构变化的影响；

或者，我们换个思路，我们不需要精准地只在要执行的下一行源码处设置断点，而是用一种更简单高效的“广撒网”的方式：

1. 在next操作时，确定当前PC；
2. 进而确定当前所执行的函数，即函数的指令地址范围；
3. 然后在行号表中筛选出这样的lineEntries：
   - lineEntry地址必须是在函数指令范围内的；
   - 并且lineEntry.IsStmt=true；
4. 在筛选出的lineEntries的lineEntry.Addr处添加断点，并且断点类型标记为NextBreakpoint（next命令隐式创建的断点）

ps: NextBreakpoint类型的断点，这些断点会在函数执行结束后自动禁用。

以 `for i:=0; i<10; i++ {...}` 为例，编译工具链生成DWARF行号表时，会为 i:=0、i<10、i++ 这几个位置处的指令生成对应的lineEntries，每个位置都存在一个lineEntry满足lineEntry.IsStmt=true。调试器可以在这些entries的Addr处设置断点。这样我们就能确保在循环执行过程中正确地停在i++、i<10这几个位置，而不是直接调到forloop循环体之后的位置。

对于break、continue、break LABEL、continue LABEL，我们这里的方法也同样奏效，读者感兴趣可以自己揣摩下。

##### stepin, stepout

stepin和stepout的实现也需要自动隐式创建断点：

- stepin, 函数入口地址可以从函数定义对应的DWARF DIE获取，
- stepout, 而返回地址则需要通过DWARF调用帧信息(CFA)进行计算，

这样执行stepin、stepout时，在相应位置设置好断点位置，并continue执行到断点位置即可。

#### 断点类型

正如前面提到的那样，符号级调试器里，创建断点大致可以分为如下两类：1）用户执行breakpoint命令显示创建的断点；2）用户执行其他调试命令（如next、stepin、stepout等）时自动隐式创建的断点。

为了区分人工创建、隐式自动创建的断点，以及精确区分隐式自动创建具体是因为什么，可以定义一个断点类型进行区分。具体地相关处理逻辑后面再介绍。

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

    steppingMask = NextBreakpoint | NextDeferBreakpoint | StepBreakpoint | StepIntoNewProcBreakpoint | NextInactivatedBreakpoint | StepIntoRangeOverFuncBodyBreakpoint
)
```

#### 逻辑断点 vs 物理断点

我们期望在指定的一个源代码位置处添加断点，为了达到这个断点效果，我们可能要在多个不同机器指令地址处添加断点。

考虑如下几种常见情况：

- Go泛型函数 `func Add[T ~int|~int32|~int64](a, b T) T {return a+b;}`，如果程序中使用了 `Add(1,2), Add(uint(1), uint(2))` 那么这个泛型函数就会为int、uint分别实例化两个函数（了解下Go泛型函数实现方案，gcshaped stenciling）。继续转成机器指令后，泛型函数内同一个源码行自然就对应着两个地址（一个是int类型实例化位置，一个是uint类型实例化位置）。
- 对于函数内联，其实也存在类似的情况。满足内联规则的小函数，在多个源码位置多次调用，编译器将其内联处理后，函数体内同一行源码对应的指令被复制到多个调用位置处，也存在同一个源码行对应多个地址的情况。

实际上我们添加断点的时候，我们还是执行 `break [locspec]`，对吧，我们压根不会去考虑泛型函数如何去实例化成多个的、哪些函数会被内联出来。而且，我们也不想用泛型函数实例化后的指令地址、内联函数内联后的地址去逐个设置断点。

**为了描述这种关系，就有了“逻辑断点” 和 “物理断点” 的概念：**

- 逻辑断点：`break 源码位置`，通过这种方式创建断点，会在对应源码位置处创建1个逻辑断点；
- 物理断点：逻辑断点强调的是源代码位置，物理断点强调的是底层实现时要用断点指令0xCC进行指令patch，这样一个逻辑断点对应着至少1个物理断点。

当添加断点时，其实是指的添加逻辑断点，过程中底层相关的操作可能会涉及多个物理断点。OK，关于二者的关系，先介绍到这里。

#### 断点重叠管理 breaklet

先举个例子，比如有下面代码片段: 假定当前我们现在停在11行这个位置，现在我们执行 `break 12` 那么将会在12行创建一个逻辑断点，对应的也会创建1个物理断点，然后我们执行 `next`操作来逐源码行执行。next操作会确定当前函数范围，并为函数内所有指令地址对应的lineEntry.IsStmt的指令地址处增加一个断点，12行当然也不例外。

此时，在12行就出现了两个创建逻辑断点的操作，一个是人为 `break 12`设置的，一个是 `next` 隐式创建的。这里的两个逻辑断点，最终也是要去设置物理断点的，但是我们怎么明确表示这个地址处实际上是有两个“物理断点”发生了重叠呢？

```go
   10 for {
=> 11     i++
   12     println(i)
   13 }
```

重叠意味着什么呢？物理断点最终是否生效，需要综合重叠的多个断点的创建逻辑、断点激活条件来判断。比如某个断点命中n次后才触发激活，或者命中超过m次后就不再激活，此时调试器即使发现这个位置是个断点、ptracee也停下了，或者是个条件断点，在不满足激活条件时还是要主动continue。通过这种方式，我们在物理断点基础上又玩出了新的花样，而这种灵活性对于调试效率来说是很重要的。

那怎么描述这种同一个物理断点处存在多个断点的重叠呢？这就是要引入 `Breaklet` 抽象的原因。

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
  - 每个breaklet有自己的激活条件；
  - 每个breaklet的所有条件满足时，有自己的callback可以触发执行；

#### 软件断点 vs 硬件断点

调试器实现断点的方式主要有两种：软件断点和硬件断点。

- 软件断点是通过断点指令0xCC进行指令patch，软件断点相对来说使用更普遍，兼容性更好，但会修改目标程序指令。
- 硬件断点则是利用CPU提供的调试寄存器（如x86的DR0-DR7）来实现的，不需要修改指令，能监视代码执行和数据访问，但调试寄存器数量有限。

以x86架构为例，提供了4个调试地址寄存器(DR0-DR3)和2个调试控制寄存器(DR6-DR7)来支持硬件断点。当设置一个硬件断点时，需要:

1. 将断点地址写入某个未使用的DR0-DR3寄存器
2. 在DR7中设置对应的控制位:

   - L0-L3位: 启用对应的DR0-DR3断点(置1启用)
   - G0-G3位: 全局启用对应断点(置1启用)
   - R/W0-R/W3位: 设置断点类型
     - 00: 执行断点
     - 01: 数据写入断点
     - 11: 数据读写断点
   - LEN0-LEN3位: 设置监视的数据长度(1/2/4/8字节)

当程序执行到断点地址或访问监视的内存时，处理器会产生#DB异常(向量号1)，内核捕获该异常并通知调试器。

#### 支持多进程+多线程调试

并发编程模型，当前无外乎多进程、多线程、协程这几种编程模型，以Go为例吧，Go暴漏给开发者的并发操作是基于goroutine的，但是goroutine执行最终还是依赖于thread。对Linux而言，thread实现其实是轻量级进程lwp，我们可以通过系统调用clone结合一些资源复制选项来创建线程。有时我们也会实现多进程程序，比如支持热重启的微服务框架。OK，调试器如果能够方便地支持对多进程、多线程、协程进行跟踪，那肯定是非常方便的。

对调试器而言，所有的被跟踪对象tracee都是就线程这个身份来说的。线程隶属于进程，`getpid()`返回的是所属进程ID，`syscall(SYS_gettid)`返回的是线程ID，这里的tid就是线程对应的LWP的pid。ptrace操作的参数pid，其实指的就是线程对应的轻量级进程的pid。

多进程调试、多线程调试、协程调试的困难点：

- 当父进程创建子进程时，如何自动跟踪子进程，如果需要手动加断点让子进程停下来，会错过合适的调试时机；
- 当进程内部创建新线程时，如何自动跟踪新线程，如果需要手动加断点让新线程停下来，也会错过合适的调试时机；
- 当跟踪某个协程G1时，continue恢复现成执行后，GMP调度器可能会调度另一个goroutine G2来执行并停在断点处，但是我们期望跟踪的是G1；

对于自动跟踪新进程、新线程，我们需要通过自动跟踪新创建的进程、线程。对于跟踪特定协程执行，我们可以借助条件断点的方式，调试器可以给断点加条件 `break [--name|-n name] [locspec] [if condition]` 相当于调试器内部隐式加个条件 `cond runtime.curg.goid == 创建断点时goid`。都可以相对简单的搞定。

我们需要进一步思考的是，断点的管理，是否需要针对线程或者进程粒度单独进行维护呢？举个例子，假设我们现在正在调试的是进程P1的线程T1，调试期间我们创建了一些断点。那么当我们切换到进程P1的线程T2去跟踪调试的时候，你希望这些断点在T2继续生效吗？再或者进程P1 forkexec创建了子进程P2，P2执行期间也创建时了一些线程，你希望上述断点在P2也生效吗？可以有不同的实现方式，但是从实践来看，当触发断点时能够默认暂停整个进程中的所有活动（Stop The World），对调试来说是更便利的，开发者可以有更多时间去观察。ps：当然我们可以手动恢复某个进程、线程的执行。

#### Put it Together

OK，上面这些统筹起来，就设计出了tinydbg这种断点管理的层次结构，这也是现代调试器的常规做法：

```bash
TargetGroup (调试器级别, debugger.Debugger.target)
├── LogicalBreakpoints map[int]*LogicalBreakpoint  // 全局逻辑断点
└── targets []proc.Target (多个目标进程)
    ├── Target 1 (进程P1)
    │   └── BreakpointMap (每个进程的断点映射)
    │       ├── M map[uint64]*Breakpoint           // 物理断点（按地址索引）
    |       |                 ├── []*Breaklet      // 每个物理断点又包含了一系列的Breaklet，每个Breaklet有自己的Kind,Cond,etc.
    │       └── Logical map[int]*LogicalBreakpoint // 逻辑断点（共享引用）
    └── Target 2 (进程P2)
        └── BreakpointMap
            ├── M map[uint64]*Breakpoint
            └── Logical map[int]*LogicalBreakpoint
```

- **逻辑断点全局共享，统一管理**：所有断点都是逻辑断点，在 TargetGroup 级别统一管理，避免重复设置

  ```go
  // 在 TargetGroup 中
  LogicalBreakpoints map[int]*LogicalBreakpoint
  ```

  这意味着，当在进程P1的线程T1上设置断点时，创建的是一个逻辑断点。这个逻辑断点会被自动应用到所有相关的进程和线程，这离不开下面的自动传播机制。
- **自动断点传播机制，调试便利**：新进程、新线程自动继承现有的断点

  当新进程或线程加入调试组时，断点会自动传播：

  ```go
  func (grp *TargetGroup) addTarget(p ProcessInternal, pid int, currentThread Thread, path string, stopReason StopReason, cmdline string) (*Target, error) {
    // ...
    t.Breakpoints().Logical = grp.LogicalBreakpoints  // 共享逻辑断点

    // 自动为新目标启用所有现有的逻辑断点
    for _, lbp := range grp.LogicalBreakpoints {
        if lbp.LogicalID < 0 {
            continue
        }
        err := enableBreakpointOnTarget(t, lbp)  // 在新目标上启用断点
        // ...
    }
    // ...
  }

  func enableBreakpointOnTarget(p *Target, lbp *LogicalBreakpoint) error {
    // 根据断点类型决定在哪些地址设置物理断点
    switch {
    case lbp.Set.File != "":
        // 文件行断点：在所有匹配的地址设置
        addrs, err = FindFileLocation(p, lbp.Set.File, lbp.Set.Line)
    case lbp.Set.FunctionName != "":
        // 函数断点：在函数入口设置
        addrs, err = FindFunctionLocation(p, lbp.Set.FunctionName, lbp.Set.Line)
    case len(lbp.Set.PidAddrs) > 0:
        // 特定进程地址断点：只在指定进程设置
        for _, pidAddr := range lbp.Set.PidAddrs {
            if pidAddr.Pid == p.Pid() {
                addrs = append(addrs, pidAddr.Addr)
            }
        }
    }

    // 在每个地址设置物理断点
    for _, addr := range addrs {
        _, err = p.SetBreakpoint(lbp.LogicalID, addr, UserBreakpoint, nil)
    }
  }
  ```
- 状态同步，全局共享：断点命中计数等信息在逻辑断点级别维护

  ```go
  // 逻辑断点：用户概念上的断点
  type LogicalBreakpoint struct {
    LogicalID    int
    Set          SetBreakpoint            // 断点设置信息
    enabled      bool
    HitCount     map[int64]uint64         // 命中计数
    TotalHitCount uint64
    // ...
  }
  ```
- 断点启用策略，控制灵活：通过 follow-exec 和正则表达式控制断点传播范围

  如果打开了followExec模式，并且followExecRegexp不空，此时就会检查子进程执行的cmdline是否匹配，如果匹配就会自动追踪并进行断点传播。

  ```bash
  target follow-exec -on              // 打开follow-exec模式
  target follow-exec -on "myapp.*"    // 打开follow-exec模式，但是只跟踪cmdline匹配myapp.*的子进程
  target follow-exec -off             // 关闭follow-exec模式

  ```

  处理逻辑详见：

  ```go
  type TargetGroup struct {
    followExecEnabled bool        // 是否启用 follow-exec
    followExecRegex   *regexp.Regexp  // 正则表达式过滤器
    // ...
  }

  func (grp *TargetGroup) addTarget(p ProcessInternal, pid int, currentThread Thread, path string, stopReason StopReason, cmdline string) (*Target, error) {
    logger := logflags.LogDebuggerLogger()
    if len(grp.targets) > 0 {
        // 检查是否启用 follow-exec
        if !grp.followExecEnabled {
            logger.Debugf("Detaching from child target (follow-exec disabled) %d %q", pid, cmdline)
            return nil, nil  // 不跟踪子进程
        }

        // 检查正则表达式过滤
        if grp.followExecRegex != nil && !grp.followExecRegex.MatchString(cmdline) {
            logger.Debugf("Detaching from child target (follow-exec regex not matched) %d %q", pid, cmdline)
            return nil, nil  // 不跟踪不匹配的进程
        }
    }

    // 新进程被添加到调试组，所有现有断点会自动应用
    t.Breakpoints().Logical = grp.LogicalBreakpoints
    for _, lbp := range grp.LogicalBreakpoints {
        err := enableBreakpointOnTarget(t, lbp)  // 在新进程中设置断点
    }
  }
  ```

### 代码实现: `breakpoint`

OK，接下来我们看下 `breakpoint` 命令在clientside、serverside分别是如何实现的。

#### 实现目标

先来看看break支持的操作, `break [--name|-n=name] [locspec] [if <condition>]`:

- 可以指定断点名字，如果调试任务比较重，涉及到大量断点，能给断点命名非常有用，它比id更易于辨识使用；
- 前面介绍过的所有受支持的 `locspec`写法，`break` 命令都予以了支持，这将使得添加断点非常方便；
- 添加断点时还可以直接指定断点激活条件 `if <condition>`，这里的condition是任意bool类型表达式。

ps：如果断点已经创建，后续调试期间希望给这个断点加个激活条件，也是可以的，`condition <breakpoint> <bool expr>`，实现方法上和 `if condition` 是相同的。

```bash
(tinydbg) help break
Sets a breakpoint.

	break [--name|-n=name] [locspec] [if <condition>]

Locspec is a location specifier in the form of:

  * *<address> Specifies the location of memory address address. address can be specified as a decimal, hexadecimal or octal number
  * <filename>:<line> Specifies the line in filename. filename can be the partial path to a file or even just the base name as long as the expression remains unambiguous.
  * <line> Specifies the line in the current file
  ...
If locspec is omitted a breakpoint will be set on the current line.

If you would like to assign a name to the breakpoint you can do so with the form:
	break -n mybpname main.go:4

Finally, you can assign a condition to the newly created breakpoint by using the 'if' postfix form, like so:
	break main.go:55 if i == 5

Alternatively you can set a condition on a breakpoint after created by using the 'on' command.

```

ps：我们重写了tinydbg的clientside的断点操作，我们将相对低频使用的参数[name]调整为了选项 `--name|-n=<name>`的形式，这样也使得程序中解析断点name, locspec, condition的逻辑大幅简化。

OK，接下来我们看看断点命令的执行细节。

#### clientside 实现

```bash
debug_breakpoint.go:breakpointCmd.cmdFn(...), 
i.e., breakpoint(...)
    \--> _, err := setBreakpoint(t, ctx, false, args)
            \--> name, spec, cond, err := parseBreakpointArgs(argstr)
            |    解析断点相关的name，spec，cond
            |
            \--> locs, substSpec, findLocErr := t.client.FindLocation(ctx.Scope, spec, true, t.substitutePathRules())
            |    查找spec对应的地址列表，注意文件路径的替换
            |
            \--> if findLocErr != nil && shouldAskToSuspendBreakpoint(t)
            |    如果没找到，询问是否要添加suspended断点，后续会激活
            |       bp, err := t.client.CreateBreakpointWithExpr(requestedBp, spec, t.substitutePathRules(), true)
            |       return nil, nil
            |    if findLocErr != nil 
            |       return nil, findLocErr
            |
            |    ps: how shouldAskToSuspendBreakpoint(...) works: 
            |        target calls `plugin.Open(...)`, target exited, followexecmode enabled
            |
            \--> foreach loc in locs do
            |    对于每个找到的地址，创建断点
            |       bp, err := t.client.CreateBreakpointWithExpr(requestedBp, spec, t.substitutePathRules(), false)
            |
            \--> if it is a tracepoint, set breakpoints for return addresses, then
            |    如果是添加tracepoint，那么对于locspec匹配的每个函数，都要在返回地址处设置断点
            |    ps: like `trace [--name|-n=name] [locspec]`, in which `locspec` matches functions
            | 
            |    foreach loc in locs do
            |       if loc.Function != nil then 
            |           addrs, err := t.client.(*rpc2.RPCClient).FunctionReturnLocations(locs[0].Function.Name())
            |       foreach addr in addrs do
            |           _, err = t.client.CreateBreakpoint(&api.Breakpoint{Addr: addrs[j], TraceReturn: true, Line: -1, LoadArgs: &ShortLoadConfig})

   
```

简单总结下clientside添加断点的处理流程：

1. 解析输入字符串，得到断点名name、位置描述spec、条件cond；
2. 然后请求服务器返回位置描述spec对应的指令地址列表；
3. 如果服务器查找spec失败，至少说明spec对应的位置当前没有指令数据。此时询问是否要尝试添加suspended断点，等后续指令加载后或者进程启动后就可以激活断点；如果服务器查找spec失败，也不需要添加suspended断点，那么返回失败。
4. 如果服务器查找spec失败，则将服务器返回的每个指令地址处都请求添加断点；
5. 如果当前添加的是tracepoint，并且解析出的位置描述spec中还匹配了一些函数，tracepoint因为要观察func的进入、退出时状态，所以这里请求服务器返回匹配函数的返回地址列表，然后返回地址处也添加断点。

通过clientside添加断点的处理过程，我们可以粗略看出，这里处理了普通断点、条件断点、suspended断点、tracepoints 。读者朋友可以关注，clientside发起的RPC操作时不同断点情况下的请求参数设置的差异。

> ps:  创建断点相关的几个RPC协议设计，给人感觉非常繁琐、冗余、不精炼。
>
> ```
> type Client interface {
>     ...
>     // CreateBreakpoint creates a new breakpoint.
>     CreateBreakpoint(*api.Breakpoint) (*api.Breakpoint, error)
>
>     // CreateBreakpointWithExpr creates a new breakpoint and sets an expression to restore it after it is disabled.
>     CreateBreakpointWithExpr(*api.Breakpoint, string, [][2]string, bool) (*api.Breakpoint, error)
>     ...
> }
> ```
>
> 实际上api.Breakpoint描述的是一个断点在clientside希望能看到的完整信息，但是将其用于创建断点请求，让人感觉使用起来非常不方便，这个类型有29个字段，设置是哪些字段才是有效请求呢？再比如CreateBreakpointWithExpr，第2、3个参数分别是locspec以及是否是suspended bp，这俩字段本来就可以包含在api.Breakpoint内，为什么又要多此一举放外面？总之就感觉这里的API设计有点难受。

接下来我们看看服务器收到serverside的添加断点请求时是如何进行处理的。

#### serverside 实现

服务器端描述起来可能有点复杂，如前面所属，服务器侧为了应对各种调整，引入了多种层次的抽象和不同实现。前面介绍了断点层次化管理机制，这部分信息对于理解serverside处理流程非常重要。

OK，假定读者朋友们已经理解了上述内容，现在我们整体介绍下serverside添加断点的处理流程。

```bash
rpc2/server.go:CreateBreakpoint
func (s *RPCServer) CreateBreakpoint(arg CreateBreakpointIn, out *CreateBreakpointOut) error {
    \--> err := api.ValidBreakpointName(arg.Breakpoint.Name)
    \--> createdbp, err := s.debugger.CreateBreakpoint(&arg.Breakpoint, arg.LocExpr, arg.SubstitutePathRules, arg.Suspended)
    |       \--> checking: if breakpoints with the same name as requestBp.Name created before
    |            d.findBreakpointByName(requestedBp.Name)
    |       \--> checking: if breakpoints with the same requestBp.ID created before
    |            lbp := d.target.LogicalBreakpoints[requestedBp.ID]
    |       \--> breakpoint config, initialized based on following order
    |       |    \--> case requestedBp.TraceReturn, 
    |       |         setbp.PidAddrs = []proc.PidAddr{{Pid: d.target.Selected.Pid(), Addr: requestedBp.Addr}}
    |       |    \--> case requestedBp.File != "",
    |       |         setbp.File = requestBp.File
    |       |         setbp.Line = requestBp.Line
    |       |    \--> requestedBp.FunctionName != "",
    |       |         setbp.FunctionName = requestedBp.FunctionName
    |       |         setbp.Line = requestedBp.Line
    |       |    \--> len(requestedBp.Addrs) > 0, 
    |       |         setbp.PidAddrs = make([]proc.PidAddr, len(requestedBp.Addrs))
    |       |         then, fill the setbp.PidAddrs with slice of PidAddr{pid,addr}
    |       |    \--> default, setbp.Addr = requestBp.Addr
    |       \--> if locexpr != "", 
    |            \--> setbp.Expr = func(t *proc.Target) []uint64 {...}
    |            \--> setbp.ExprString = locExpr
    |       \--> create the logical breakpoint
    |       |    \--> `id`, allocate a logical breakpoint ID
    |       |    \--> lbp := &proc.LogicalBreakpoint{LogicalID: id, HitCount: make(map[int64]uint64)}
    |       |    \--> err = d.target.SetBreakpointEnabled(lbp, true)
    |       |    |    \--> if lbp.enabled && !enabled, then 
    |       |    |         lbp.enabled = false
    |       |    |         err = grp.disableBreakpoint(lbp)
    |       |    |    \--> if !lbp.enabled && enabled, then 
    |       |    |         lbp.enabled = true
    |       |    |         lbp.condSatisfiable = breakpointConditionSatisfiable(grp.LogicalBreakpoints, lbp)
    |       |    |         err = grp.enableBreakpoint(lbp)
    |       |    \--> return d.convertBreakpoint(lbp)   
    \--> out.Breakpoint = *createdbp
```

简单总结下这里的处理流程：

1. 创建断点时如果指定了name，先检查名字是否符合要求（必须是unicode字符，并且不能为纯数字）。
   不符合要求直接返回失败。
2. 开始创建断点，如果指定了name，检查下这个名字是否已经被其他逻辑断点使用了。
   名字被使用则返回错误。
3. 如果指定了逻辑断点ID，则检查该ID是否已经被其他逻辑断点使用了。
   ID被使用则返回错误，错误中说明了使用该ID的断点位置信息， proc.BreakpointExistsError{File: lbp.File, Line: lbp.Line}。
4. 根据请求参数中设置断点的方式，创建断点：
   - 如果requestBp.TraceReturn=true，说明是tracepoint请求中还需指定地址requestBp.Addr（函数调用返回地址）
     setbp.PidAddrs = []proc.PidAddr{{Pid: d.target.Selected.Pid(), Addr: requestedBp.Addr}}
   - 如果requestBp.File != "", 则使用requestBp.File:requestBp.Line来创建断点
     setbp.File = requestBp.File, setbp.Line = requestBp.Line
   - 如果requestedBp.FunctionName != ""，则使用requestBp.FunctionName:requestBp.Line来创建断点
     setbp.FunctionName = requestBp.FunctionName, setbp.Line = requestBp.Line
   - 如果 len(requestedBp.Addrs) != 0，则在目标进程的这些地址处添加断点
     setbp.PidAddrs = []proc.PidAddr{.....}
   - 其他情况，使用requestBp.Addr来设置断点
     setbp.PidAddr = []proc.PidAddr{{Pid: d.target.Selected.Pid(), Addr: requestedBp.Addr}}
5. 如果locExpr != ""，则解析位置表达式得到LocationSpec，setbp.Expr实际上是个函数，执行后返回位置表达式查找到的地址列表
   setbp.Expr = func(t *proc.Target) []uint64 {...}
   setbp.ExprString = locExpr
6. 更新逻辑断点的id，创建一个逻辑断点proc.LogicalBreakpoint{LogicalID: id, ...,Set: setbp, ...,File:...,Line:...,FunctionName:...,}
7. 设置逻辑断点对应的物理断点：err = d.target.SetBreakpointEnabled(lbp, true)
8. 将逻辑断点信息转换为api.Breakpoint信息返还给客户端展示

接下来看下 `d.target.SetBreakpointEnabled(lbp, true)`，设置逻辑断点关联的物理断点信息的流程。

```bash
err = d.target.SetBreakpointEnabled(lbp, true)
    \-->  err = grp.enableBreakpoint(lbp)
            \--> for target in grp.targets, do: 
                    err := enableBreakpointOnTarget(target, lbp)
                    |   \--> addrs, err = FindFileLocation(t, lbp.Set.File, lbp.Set.Line), or 
                    |        addrs, err = FindFunctionLocation(t, lbp.Set.FunctionName, lbp.Set.Line), or 
                    |        filter the lbp.Set.PidAddrs if lbp.Set.PidAddrs[i].Pid == t.Pid(), or
                    |        runs lbp.Set.Expr() to find the address list
                    |   \--> foreach addr in addrs, do:
                    |           p.SetBreakpoint(lbp.LogicalID, addr, UserBreakpoint, nil)
                    |           |    \--> t.setBreakpointInternal(logicalID, addr, kind, 0, cond)
                    |           |    |       \--> newBreaklet := &Breaklet{LogicalID: logicalID, Kind: kind, Cond: cond}
                    |           |    |
                    |           |    |       \--> if breakpoint existed at `addr`, then
                    |           |    |               check this newBreaklet can overlap:
                    |           |    |               1) if no, return BreakpointExistsError{bp.File, bp.Line, bp.Addr}; 
                    |           |    |               2)if yes, bp.Breaklets = append(bp.Breaklets, newBreaklet), 
                    |           |    |               3) then `setLogicalBreakpoint(bp)`, and return
                    |           |    |       \--> else breakpoint not existed at `addr`, create a new breakpoint, so go on
                    |           |    |
                    |           |    |       \--> f, l, fn := t.BinInfo().PCToLine(addr)
                    |           |    |   
                    |           |    |       \--> if it's watchtype: set hardware debug registers
                    |           |    |       ...
                    |           |    |       \--> newBreakpoint := &Breakpoint{funcName, watchType, hwidx, file, line, addr}
                    |           |    |       \--> newBreakpoint.Breaklets = append(newBreakpoint.Breaklets, newBreaklet)
                    |           |    |       \--> err := t.proc.WriteBreakpoint(newBreakpoint)
                    |           |    |       |       \--> if bp.WatchType != 0, then
                    |           |    |       |               for each thread in dbp.threads, do
                    |           |    |       |                    err := thread.writeHardwareBreakpoint(bp.Addr, bp.WatchType, bp.HWBreakIndex)
                    |           |    |       |               return nil
                    |           |    |       |       \--> _, err := dbp.memthread.ReadMemory(bp.OriginalData, bp.Addr)
                    |           |    |       |       \--> return dbp.writeSoftwareBreakpoint(dbp.memthread, bp.Addr)
                    |           |    |       |               \--> _, err := thread.WriteMemory(addr, dbp.bi.Arch.BreakpointInstruction())
                    |           |    |       |                       \--> t.dbp.execPtraceFunc(func() { written, err = sys.PtracePokeData(t.ID, uintptr(addr), data) })
                    |           |    |       \--> newBreakpoint.Breaklets = append(newBreakpoint.Breaklets, newBreaklet)
                    |           |    |       \--> setLogicalBreakpoint(newBreakpoint)
```

那么 `setLogicalBreakpoint(newBreakpoint)`又具体做了什么呢？

```go
setLogicalBreakpoint(newBreakpoint)
    \--> if bp.WatchType != 0, then
            \--> foreach thead in dbp.threads, do
                    err := thread.writeHardwareBreakpoint(bp.Addr, bp.WatchType, bp.HWBreakIndex)
                    return err
    \--> return dbp.writeSoftwareBreakpoint(dbp.memthread, bp.Addr)
            \--> _, err := thread.WriteMemory(addr, dbp.bi.Arch.BreakpointInstruction())
                    \--> t.dbp.execPtraceFunc(func() { written, err = sys.PtracePokeData(t.ID, uintptr(addr), data) })
```

是不是感觉有点混乱？是！

主要是明确这几点：

- 这个逻辑断点对进程组grp中的所有进程都生效 `grp.enableBreakpoint(lbp) -> enableBreakpointOnTarget(target, lbp)`；
- 这个逻辑断点位置，可能对应着多个机器指令地址，`FindFileLocation(...), or FindFunctionLocation, or filter from lbp.Set.PidAddrs, or runs lbp.Set.Expr() to find address`
- 每个找到的机器指令地址处都需要添加物理断点 `p.SetBreakpoint(lbp.LogicalID, addr, UserBreakpoint, nil) -> t.setBreakpointInternal(logicalID, addr, kind, 0, cond)`
- 物理断点

### 代码实现: `breakpoints`

### 代码实现: `clear`

### 代码实现: `clearall`

### 执行测试

### 本文总结
