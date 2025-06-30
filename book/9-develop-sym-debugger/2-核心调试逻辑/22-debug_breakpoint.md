## Breakpoint

断点是调试器能力的核心功能之一，在介绍指令级调试器时，我们详细介绍了断点的底层工作原理。如果你忘记了0xCC的作用，忘记了 `ptrace(PTRACE_PEEKDATA/POKEDATA/PEEKTEXT/POKETEXT, ...)` 是干什么用的，搞不清处理器执行到0xCC时会发生什么，搞不清内核如何响应SIGTRAP信号，搞不清子进程状态变化如何通过SIGCHLD通知到父进程，甚至忘记了ptracer调用wait4是用来干什么的 …… 如果果真如此，那可以细点翻到 [第6章 动态断点](../../6-develop-inst-debugger/6-breakpoint.md) 小节快速回顾一下。

### 实现目标: `breakpoint` `breakpoints` `clear` `clearall` `toggle`

本节实现目标，我们将把断点操作强相关的几个调试命令，一起进行介绍。另外几个调试命令 `condition`, `on`, `trace`, `watch` 虽然也与断点相关，但是相对来说是比较高级点的用法，我们单独介绍以示重视，也希望在日后调试时能更好地帮助大家调试。

### 基础知识

除了本文开头的那些基础知识以外，符号级调试器添加断点时用到的位置描述locspec，以及可能涉及到表达式求值的操作evalexpr，甚至你想在特定指令地址处添加断点，可能先反汇编看下有哪些指令等，这些我们都当做本节前置内容进行安排，也介绍过了。如果你理解了这些内容，本文内容理解起来就简单多了。

但是，我也必须强调，和指令级调试器在指令处添加断点这种应用场景相比，符号级调试器里面断点处理会更复杂、多样、精细。

#### 应用及挑战

符号级调试器中的断点处理不仅包括用户显式创建的断点，某些调试命令也会自动创建断点。这与指令级调试器有很大不同 - 在指令级调试器中，step命令通过 `ptrace(PTRACE_SINGLESTEP, ...)`开启CPU单步执行模式来实现指令级别的步进。而在符号级调试器中，要实现next、stepin、stepout等源码级别的步进操作，就需要智能地确定下一个断点位置。

以next操作为例，其复杂性体现在:

- 对于顺序执行的代码，实现相对简单 - 从当前PC确定行号，找到下一个包含可执行指令的行(跳过注释、空行等)，在该处设置断点即可。
- 但当代码包含分支控制(if-else、switch-case)和循环控制(for、break、continue)时，情况就变得复杂。此时简单地递增行号是错误的，因为程序执行可能会跳转到判断语句或特定label处。

虽然DWARF行号表支持通过PC查询对应源码行，但无法直接获取"下一行源码"。对此，我们有几种可能的解决方案:

- 方案一: 从当前PC开始顺序扫描指令，直到找到行号不同的PC位置。这种方法可行但需要频繁读取内存。
- 方案二: 通过AST分析函数体，识别并处理各类控制流。这种方法可行但需要复杂的AST分析，且容易受Go语言演进的影响。
- 方案三: 一个更优雅的方案是 - 在next操作时，确定当前函数的指令范围，然后在所有lineEntry.IsStmt=true的指令位置设置NextBreakpoint类型的断点。这些断点会在函数执行结束后自动禁用。

以 `for i:=0; i<10; i++ {...}`为例，DWARF会在i:=0、i<10、i++这三个关键位置的lineEntry中设置IsStmt=true。通过在这些位置设置断点，我们就能确保在循环执行过程中正确地停在控制点上，而不会错误地跳到循环体之后。

stepin和stepout的实现相对简单，因为函数都有明确的入口地址和返回地址。入口地址可以从函数定义的DIE获取，而返回地址则需要通过DWARF调用帧信息(CFA)计算。

此外，我们还需要处理:

- 函数内联和泛型导致的一个逻辑位置对应多个物理地址的情况
- 用户断点和调试命令创建的断点重叠时的行为管理
- 条件断点的表达式计算

这些都使得符号级调试器的断点处理比指令级调试器要复杂得多，需要更细致的设计和实现。

#### 断点的类型

正如前面提到的那样，符号级调试器里，创建断点大致可以分为如下两类：1）用户执行breakpoint命令显示创建的断点；2）用户执行其他调试命令（如next、stepin、stepout等）时自动隐式创建的断点。

为了区分1）2）两种类型的（逻辑）断点，以及精确区分是什么情况下创建的，需要定义一个类型 `BreakpointKind` 来予以区分。

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

另外，源代码中，同一个源代码位置，将来生成的机器指令后，可能会对应多个机器指令地址，为什么呢？

- 联想下Go泛型函数 `func Add[T ~int|~int32|~int64](a, b T) T {return a+b;}`，如果程序中使用了 `Add(1,2), Add(uint(1), uint(2))` 那么这个泛型函数就会为int、uint分别实例化两个函数（了解下泛型函数实现方案，gcshaped stenciling）。继续转成机器指令后，泛型函数内同一个源码行自然就对应着两个地址（一个是int类型实例化位置，一个是uint类型实例化位置）。
- 对于内联函数，其实也存在类似的情况。满足内联规则的小函数，在多个源码位置多次调用，编译器将其内联处理后，函数体内同一行源码被复制到多个调用位置处，也存在同一个源码行对应多个地址的情况。

实际上我们添加断点的时候，我们还是执行 `break [locspec]`，对吧，我们压根不会去考虑泛型函数如何去实例化成多个的、哪些函数会被内联出来。而且，我们也不想用泛型函数实例化后的指令地址、内联函数内联后的地址去逐个设置断点。

这里就出现了现象：一个源代码位置的断点，其实可能对应着多个物理指令地址的断点。为了描述这种关系，我们提出 “逻辑断点” 和 “物理断点” 的概念。

- 逻辑断点：`break <指令地址>` 以外的所有其他添加断点方式，对应的每个源码位置，都对应的会创建一个逻辑断点，1个逻辑断点对应着1个或者多个物理断点；
- 物理断点：逻辑断点强调的是源代码位置，真正实现时还是要具体到对哪些指令进行指令patch，这里强调的就是物理断点。

因此当我们添加断点时，其实涉及到两部分工作：添加逻辑断点，添加逻辑断点对应的物理断点。OK，关于二者的关系，先介绍到这里。

> ps: 一行源代码包括多个语句，为了调试方便，是否也应该为每个语句的开始处添加断点？测试了下dlv，不支持。

#### 断点重叠管理 breaklet

同一个指令地址处的断点，叫什么来着？对，物理断点。刚提过哈！这里需要注意，在同一个物理断点处有可能存在多个“逻辑断点”在此处重叠，这几个逻辑断点都希望在此处添加物理断点。物理断点最终是否生效，需要综合多个逻辑断点在此处的设置项及状态值来判断，比如某个断点最多命中多少次，即使这个物理断点存在，但是当执行次数不满足时也会被自动continue跳过。当一个物理断点存在时，如果想跳过这个断点，我们只需要控制执行一次continue操作即可。

那怎么来表示多个不同逻辑断点在同一个物理断点处都有设置呢？或者说同一个物理断点处，存在多个断点的重叠逻辑呢？移除其中一个逻辑断点，不会导致其他的逻辑断点生效呢？这就是要引入 `Breaklet` 抽象的原因。

同一个物理断点 `proc.Breakpoint` 可能会包含多个 `proc.Breaklet`。每个Breaklet可以理解成1个物理断点的1小部分控制逻辑即可，同一个物理断点的多个breaklet共同决定了这个物理断点的行为。

简单总结下：

- 同一个逻辑断点可能对应着多个物理断点，因为Go对泛型函数、内联函数的支持；
- 同一个物理断点可能有多个breaklets，因为多个逻辑断点在同一个物理断点处出现重叠；
- 每个breaklet有自己的断点类型，`BreakpointKind`，因为要精确区分每个断点是因为什么添加的；
  ps: 物理断点的breaklets必须兼容，不兼容的breaklet是不能创建的。
- 每个breaklet有自己的条件，`Cond ast.Expr`，因为要区分不同断点的激活条件；
  ps：后面介绍 `condition`, `on`, `trace`, `watch` 时会再次提到这些。

#### 软件断点 vs 硬件断点

调试器实现断点的方式主要有两种：软件断点和硬件断点。软件断点是通过指令patch将目标指令第一字节覆写为断点指令（x86下是0xCC），当CPU执行0xCC一字节指令后，会触发SIGTRAP，进而执行内核服务，此时会通知tracer让让调试器获得对tracee的控制权完成后续调试动作。关于软件断点，我们前面介绍很多了。软件断点使用更普遍，但会修改目标程序指令。

硬件断点则是利用CPU提供的调试寄存器（如x86的DR0-DR7）来实现的，可以设置指令执行、数据读写等多种断点类型，但数量受限于调试寄存器的数量（通常是4个）。硬件断点不需要修改指令，可以监视代码执行和数据访问，但调试寄存器数量有限。

x86架构提供了4个调试地址寄存器(DR0-DR3)和2个调试控制寄存器(DR6-DR7)来支持硬件断点。其中:

- DR0-DR3: 用于存储断点的线性地址
- DR6: 调试状态寄存器，记录了触发断点的原因
- DR7: 调试控制寄存器，用于控制断点的类型和启用状态

当设置一个硬件断点时，需要:

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

#### 断点层次化管理机制

要考虑支持多进程、多线程调试的支持：1）对Linux而言，线程实现也是轻量级进程，只是有些资源是共享的；2）对调试器而言，所有的被跟踪对象tracee，都是线程粒度的，ptrace操作的参数pid也是被跟踪的线程对应的轻量级进程的pid（`syscall(SYS_gettid)`来获取，而非 `getpid()`）。

断点的管理，是否需要针对线程或者进程粒度单独进行维护呢？举个例子，假设我们现在正在调试的是进程P1的线程T1，调试期间我们创建了一些断点。那么当我们切换到进程P1的线程T2去跟踪调试的时候，你希望这些断点在T2继续生效吗？再或者进程P1 forkexec创建了子进程P2，P2执行期间也创建时了一些线程，你希望上述断点在P2也生效吗？答案是，当然希望它们能自动生效！这里断点的管理，直接影响到我们将来调试时的便利性。

下面是tinydbg断点管理的层次结构：

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

- 逻辑断点全局共享，统一管理：所有断点都是逻辑断点，在 TargetGroup 级别统一管理，避免重复设置

  ```go
  // 在 TargetGroup 中
  LogicalBreakpoints map[int]*LogicalBreakpoint
  ```

  这意味着：当你在进程P1的线程T1上设置断点时，创建的是一个逻辑断点。这个逻辑断点会被自动应用到所有相关的进程和线程，这离不开下面的自动传播机制。
- 自动断点传播机制，调试便利：新进程/线程自动继承现有断点

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

那么`setLogicalBreakpoint(newBreakpoint)`又具体做了什么呢？

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
