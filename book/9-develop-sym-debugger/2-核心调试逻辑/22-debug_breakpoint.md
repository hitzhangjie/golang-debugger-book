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

### 代码实现: `breakpoint`

OK，接下来我们看下 `breakpoint` 命令在clientside、serverside分别是如何实现的。
#### 实现目标

先来看看break支持的操作：

- 你可以使用locspec支持的任意位置描述形式来指定断点位置，
- 你还可以额外指定一个选项来为断点位置命名，这在一次复杂的调试活动中添加了大量断点时，是非常有用的，方便我们识别重要的断点位置，
- 你还可以添加 `if <condition>` 表达式，只有当表达式条件成立时，执行到断点位置tracee才会停下来。

ps：如果你创建断点后，发现应该加个条件，避免它被不必要的触发，也是可以的。可以使用调试命令 `condition <breakpoint> <bool expr>` 。但是这两种方式的工作原理是相同的。

```bash
(tinydbg) help break
Sets a breakpoint.

	break [--name|-n=name] [locspec] [if <condition>]

Locspec is a location specifier in the form of:

  * *<address> Specifies the location of memory address address. address can be specified as a decimal, hexadecimal or octal number
  * <filename>:<line> Specifies the line in filename. filename can be the partial path to a file or even just the base name as long as the expression remains unambiguous.
  * <line> Specifies the line in the current file
  * +<offset> Specifies the line offset lines after the current one
  * -<offset> Specifies the line offset lines before the current one
  * <function>[:<line>] Specifies the line inside function.
      The full syntax for function is <package>.(*<receiver type>).<function name> however the only required element is the function name,
      everything else can be omitted as long as the expression remains unambiguous. For setting a breakpoint on an init function (ex: main.init),
      the <filename>:<line> syntax should be used to break in the correct init function at the correct location.
  * /<regex>/ Specifies the location of all the functions matching regex

If locspec is omitted a breakpoint will be set on the current line.

If you would like to assign a name to the breakpoint you can do so with the form:

	break -n mybpname main.go:4

Finally, you can assign a condition to the newly created breakpoint by using the 'if' postfix form, like so:

	break main.go:55 if i == 5

Alternatively you can set a condition on a breakpoint after created by using the 'on' command.

See also: "help on", "help cond" and "help clear"`,
```

ps：我们重写了tinydbg的clientside的断点操作，我们将甚低频使用的参数[name]调整为了选项 `--name|-n=<name>`的形式，这样也使得程序中解析断点name, locspec, condition的逻辑大幅简化。

OK，接下来我们看看断点命令的执行细节。

#### clientside实现

```bash
debug_breakpoint.go:breakpointCmd.cmdFn(...), 
i.e., breakpoint(...)
    \--> _, err := setBreakpoint(t, ctx, false, args)
            \--> name, spec, cond, err := parseBreakpointArgs(argstr)
            \--> locs, substSpec, findLocErr := t.client.FindLocation(ctx.Scope, spec, true, t.substitutePathRules())
            \--> if findLocErr != nil && shouldAskToSuspendBreakpoint(t)
                    \--> bp, err := t.client.CreateBreakpointWithExpr(requestedBp, spec, t.substitutePathRules(), true)
                    \--> return nil, nil
                    ps: how shouldAskToSuspendBreakpoint(...) works: 
                        target contains calls `plugin.Open(...)`, target exited, followexecmode enabled
            \--> if findLocErr != nil 
                    \--> return nil, findLocErr
            \--> foreach loc in locs do
                    \--> bp, err := t.client.CreateBreakpointWithExpr(requestedBp, spec, t.substitutePathRules(), false)
            \--> if it's a tracepoint, set breakpoints for return addresses
                 `trace [--name|-n=name] [locspec]`, locspec contains function name
                 foreach loc in locs do
                    \--> if loc.Function != nil then 
                         addrs, err := t.client.(*rpc2.RPCClient).FunctionReturnLocations(locs[0].Function.Name())
                    \--> foreach addr in addrs do
                          _, err = t.client.CreateBreakpoint(&api.Breakpoint{Addr: addrs[j], TraceReturn: true, Line: -1, LoadArgs: &ShortLoadConfig})
```

竟然还有普通断点、条件断点、suspended断点、tracepoints，是不是感觉有点懵？别怕！基础知识部分提到过一些概念，逻辑断点、物理断点、breaklets。我们还没有详细对breaklets进行展开，也没有将什么场景关联什么breaklet。我们需要从一个一个关联场景出发，看看服务器添加断点时会干什么，以及执行到断点时会做什么，或者说它如何影响调试器对目标进程执行、暂停的控制，等我们了解了服务器端的处理逻辑，就会豁然开朗了。

#### serverside实现

服务器端描述起来可能有点复杂，如前面所属，服务器侧为了应对各种调整，引入了多种层次的抽象和不同实现。我们先整体介绍下流程。

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

```bash
err = grp.enableBreakpoint(lbp)
    \--> for p in grp.targets, do: 
            err := enableBreakpointOnTarget(p, lbp)
                \--> addrs, err = FindFileLocation(p, lbp.Set.File, lbp.Set.Line), or 
                    addrs, err = FindFunctionLocation(p, lbp.Set.FunctionName, lbp.Set.Line), or 
                    filter the PidAddrs with same Pid as p.Pid() among lbp.Set.PidAddrs
                \--> foreach addr in addrs, do:
                        p.SetBreakpoint(lbp.LogicalID, addr, UserBreakpoint, nil)
                            \--> t.setBreakpointInternal(logicalID, addr, kind, 0, cond)
                                    \--> newBreaklet := &Breaklet{Kind: kind, Cond: cond}
                                    \--> f, l, fn := t.BinInfo().PCToLine(addr)
                                    \--> hardware debug registers, set watchpoints via writing these registers
                                    ...
                                    \--> newBreakpoint := &Breakpoint{funcName, watchType, hwidx, file, line, addr}
                                    \--> newBreakpoint.Breaklets = append(newBreakpoint.Breaklets, newBreaklet)
                                    \--> err := t.proc.WriteBreakpoint(newBreakpoint)
                                    \--> setLogicalBreakpoint(newBreakpoint)
                                            \--> if bp.WatchType != 0, then
                                                    \--> foreach thead in dbp.threads, do
                                                            err := thread.writeHardwareBreakpoint(bp.Addr, bp.WatchType, bp.HWBreakIndex)
                                                            return err
                                            \--> return dbp.writeSoftwareBreakpoint(dbp.memthread, bp.Addr)
                                                    \--> _, err := thread.WriteMemory(addr, dbp.bi.Arch.BreakpointInstruction())
                                                            \--> t.dbp.execPtraceFunc(func() { written, err = sys.PtracePokeData(t.ID, uintptr(addr), data) })
```

这里要理解几个层次

### 代码实现: `breakpoints`

### 代码实现: `clear`

### 代码实现: `clearall`

### 执行测试

### 本文总结
