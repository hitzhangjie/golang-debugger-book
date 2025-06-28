## Breakpoint

断点是调试器能力的核心功能之一，在介绍指令级调试器时，我们详细介绍了断点的底层工作原理。如果你忘记了0xCC的作用，或者忘记了 `ptrace(PTRACE_PEEKDATA/POKEDATA/PEEKTEXT/POKETEXT, ...)` 是干什么用的，或者忘记了处理器执行到0xCC时会发生什么，或者忘记了内核如何响应SIGTRAP信号，或者忘记了子进程状态变化如何通过SIGCHLD通知到父进程，或者忘记了ptracer调用wait4是用来干什么的 …… 只要这里面有一个问题，你觉得模糊，那我认为，你都应该赶紧翻到 [第6章 动态断点](../../6-develop-inst-debugger/6-breakpoint.md) 小节快速回顾一下。

### 实现目标: `breakpoint` `breakpoints` `clear` `clearall` `toggle`

本节实现目标，我们将把断点操作强相关的几个调试命令，一起进行介绍，就不机械地每个调试命令单独一节内容了。其实还有另外几个 `condition`, `on`, `trace`, `watch`，这几个调试命令虽然也与断点相关，但是相对来说是比较高级点的用法，我们还是单独介绍下，以示重视，也希望在日后调试时能更好地帮助大家调试。

### 基础知识

除了本文开头的那些基础知识以外，符号级调试器添加断点时用到的位置描述locspec，以及可能涉及到表达式求值的操作evalexpr，甚至你想在特定指令地址处添加断点，可能先反汇编看下有哪些指令等，这些我们都当做本节前置内容进行安排，也介绍过了。如果你理解了这些内容，本文内容理解起来就简单多了。

但是，我也必须强调，和指令级调试器在指令处添加断点这种应用场景相比，符号级调试器里面断点处理会更复杂、多样、精细。

#### 应用及挑战

除了用户显示创建的断点 `break <locspec>`，一些调试命令也会主动创建断点。在指令级调试器里，step命令控制单步指令执行，是借助 `ptrace(PTRACE_SINGLESTEP, ...)` 打开了CPU的单步执行模式，这里的单步执行强调的步进一条指令，而非一行源代码。在符号级调试器里，要想实现next、stepin、stepout等操作，我们就需要思考，下一个断点位置应该设置在什么位置。

举几个例子：
1）next，如果程序只有顺序执行的语句，实现next很简单，从PC找到Line，Line++并且有该源码行有有效的PC，在此处添加断点后，主动continue运行到此处，就ok了；
2）next，如果程序除了顺序执行的语句，还包括了分支控制、循环控制、跳转、函数调用等逻辑，此时判断下一行待执行源码时，简单地++就是一个错误了，会导致程序不再逐行执行。

那next操作该如何兼顾 1）2）这两个问题呢？DWARF调试信息提供了行号表，尽管我们可以指定任意PC来转换为源码行，但是行号表并不直接描述当前行的下一行是哪个地址。

- 方法一：我们从当前PC开始将以后的指令地址逐个查下对应的行号，只有与当前行不一样时，我们确定可以在这个位置加个断点，但这很低效。
- 方法二：难道不能借助AST来分析函数体中执行的语句吗？但是这要对Go程序所有分支控制结构编写特殊逻辑，不够简洁，不够优雅。
- 方法三：还是有更简单暴力的办法的，比如将行号表中属于当前函数范围的所有IsStmt=true的指令，都强加断点。
  举例, `for i:=0; i<10; i++ {...}` 将至少在i:=0、i<10、i++这3个位置分别设置断点，如果forloop中有其他语句，则至少每个语句有一个断点，就不至于next调试时分支控制逻辑i++和i<10被错误跳过。

3）类似地stepin、stepout，进入一个函数、退出一个函数，也都需要自动添加类似的断点。这个相对来说比较简单，因为每个函数都有入口地址，但是返回地址就需要通过DWARF CFA进行计算了。

所以你看，在符号级调试器里面，断点的应用是非常广泛的，你可以主动添加，调试命令也会隐式添加。为了实现next、stepin、stepout这类简单操作，就涉及到了指令patch（物理断点）、DWARF行号表、DWARF调用帧信息表的使用。对条件断点的支持，还需要用到AST分析、表达式计算Eval等。

我们一起来学习下断点的相关设计实现。

#### 断点的类型

所以，从这里开始，我们的断点就可以分为两类：1）用户显示创建的断点；2）调试器其他调试命令自动隐式创建的断点。为了区分1）2）两种类型的断点，以及识别是哪种情况下自动隐式创建的断点，我们需要定义一个类型来区分 `BreakpointKind`。

```go
// BreakpointKind determines the behavior of delve when the
// breakpoint is reached.
type BreakpointKind uint16

const (
    // UserBreakpoint is a user set breakpoint
    UserBreakpoint BreakpointKind = (1 << iota)
    // NextBreakpoint is a breakpoint set by Next, Continue will stop on it and delete it
    NextBreakpoint
    // NextDeferBreakpoint is a breakpoint set by Next on the first deferred function. 
    // In addition to check their condition, breakpoints of this kind will also 
    // check that the function has been called by runtime.gopanic or through runtime.deferreturn.
    NextDeferBreakpoint
    // StepBreakpoint is a breakpoint set by Step on a CALL instruction,
    // Continue will set a new breakpoint (of NextBreakpoint kind) on the
    // destination of CALL, delete this breakpoint and then continue again
    StepBreakpoint

    // WatchOutOfScopeBreakpoint is a breakpoint used to detect when a watched
    // stack variable goes out of scope.
    WatchOutOfScopeBreakpoint

    // StackResizeBreakpoint is a breakpoint used to detect stack resizes to
    // adjust the watchpoint of stack variables.
    StackResizeBreakpoint

    // PluginOpenBreakpoint is a breakpoint used to detect that a plugin has
    // been loaded and we should try to enable suspended breakpoints.
    PluginOpenBreakpoint

    // StepIntoNewProc is a breakpoint used to step into a newly created
    // goroutine.
    StepIntoNewProcBreakpoint

    // NextInactivatedBreakpoint a NextBreakpoint that has been inactivated, see rangeFrameInactivateNextBreakpoints
    NextInactivatedBreakpoint

    StepIntoRangeOverFuncBodyBreakpoint

    steppingMask = NextBreakpoint | NextDeferBreakpoint | StepBreakpoint | StepIntoNewProcBreakpoint | NextInactivatedBreakpoint | StepIntoRangeOverFuncBodyBreakpoint
)
```

#### 逻辑断点 vs 物理断点

另外，源代码中，同一个源代码位置，将来生成的机器指令后，可能会对应多个机器指令地址，为什么呢？联想下Go Generics，一个泛型函数 `func Add[T ~int|~int32|~int64](a, b T) T {return a+b;}`，如果程序中使用了 `Add(1,2), Add(uint(1), uint(2))` 那么这个泛型函数就会为int、uint分别实例化两个函数。当然转成机器指令后，同一个源码行（泛型函数定义位置）就对应着两个机器指令地址（一个是int类型实例化位置，一个是uint类型实例化位置）。

这样添加断点的时候，我们还是执行 `break Add`，对吧，我们压根不知道实例化的两个函数的地址，符号级调试时我们也不想去理解。但是如果要能够真正对其进行调试，调试器必须知道分别在这两个实例化的函数位置添加断点。这里就出现了一个源代码位置的断点，对应着2个物理内存地址的断点。为了描述这种层次关系，我们提出 “逻辑断点” 和 “物理断点” 的概念。

- 逻辑断点：`break <address>` 以外的所有其他添加断点方式，对应的每个源码位置，都对应的会创建一个逻辑断点，1个逻辑断点对应着1个或者多个物理断点；
- 物理断点：逻辑断点强调的是源代码位置，对应着具体实现时，还是要落地到对指令地址处添加断点0xCC，这个是指的物理断点。而Go、编译器的某些特性可能会导致一个逻辑断点对应多个物理断点，比如Go泛型stenciling实现方案，编译器内联优化，any else？

> ps: 一行源代码包括多个语句，为了调试方便，是否也应该为每个语句的开始处添加断点？测试了下dlv，不支持。

OK，我们也需要意识到这点区别，逻辑断点 和 物理断点。

#### 断点重叠管理 breaklet

同一个指令地址处的断点，叫什么来着？对，物理断点。刚提过哈！这里需要注意，在同一个物理断点处有可能存在多个“逻辑断点”在此处重叠，这几个逻辑断点都希望在此处添加物理断点，但是只有一个字节需要patch为0xCC，那怎么来表示多个不同逻辑断点在此处有断点呢？移除其中一个逻辑断点，不会对其他逻辑断点产生影响呢？这就是为什么要引入 `Breaklet`。

每个Breaklet（联想下tasklet表示中断服务里的一部分处理逻辑），breaklet这里可以理解成1个物理断点的1小部分控制逻辑即可，同一个物理断点的多个breaklets共同决定了这个物理断点的行为。

- 同一个物理断点可能有多个breaklets；
- 每个breaklet有自己的断点类型，`BreakpointKind`；
- 每个breaklet有自己的条件，`Cond ast.Expr`；
- 不同BreakpointKind类型的Breaklets，有可能是兼容的，有可能是不兼容的，不兼容就不能添加Breakpoint.Breaklets；

后面介绍 `condition`, `on`, `trace`, `watch` 时会再次提到这些。

#### 软件断点 vs 硬件断点

调试器实现断点的方式主要有两种：软件断点和硬件断点。软件断点是通过将目标指令地址处的指令替换为特殊的断点指令（x86下是0xCC，int 3中断指令）来实现的，当程序执行到这里时会触发中断，从而让调试器获得控制权。关于软件断点，我们前面介绍很多了，这里再简单总结下硬件断点对调试的支持。

硬件断点则是利用CPU提供的调试寄存器（如x86的DR0-DR7）来实现的，可以设置指令执行、数据读写等多种断点类型，但数量受限于调试寄存器的数量（通常是4个）。软件断点使用更普遍，但会修改目标程序的代码；硬件断点不修改代码，但数量有限。

x86架构提供了4个调试地址寄存器(DR0-DR3)和2个调试控制寄存器(DR6-DR7)来支持硬件断点。其中:

- DR0-DR3: 用于存储断点的线性地址
- DR6: 调试状态寄存器,记录了触发断点的原因
- DR7: 调试控制寄存器,用于控制断点的类型和启用状态

要设置一个硬件断点,需要:

1. 将断点地址写入某个未使用的DR0-DR3寄存器

2. 在DR7中设置对应的控制位:
   - L0-L3位: 启用对应的DR0-DR3断点(置1启用)
   - G0-G3位: 全局启用对应断点(置1启用) 
   - R/W0-R/W3位: 设置断点类型
     - 00: 执行断点
     - 01: 数据写入断点
     - 11: 数据读写断点
   - LEN0-LEN3位: 设置监视的数据长度(1/2/4/8字节)

当程序执行到断点地址或访问监视的内存时,处理器会产生#DB异常(向量号1),内核捕获该异常并通知调试器。

相比软件断点,硬件断点的优势是:
- 不需要修改程序代码
- 可以监视数据访问
- 对于自修改代码更可靠

但缺点是数量有限,只能同时设置4个硬件断点。

### 代码实现

下面我们分别看看这几个调试命令时如何实现的。

#### break | breakpoint

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

ps：我们重写了tinydbg的clientside的断点操作，我们将甚低频使用的参数[name]调整为了选项`--name|-n=<name>`的形式，这样也使得程序中解析断点name, locspec, condition的逻辑大幅简化。

OK，接下来我们看看断点命令的执行细节。

**clientside**:

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



**serverside**：

服务器端描述起来可能有点复杂，如前面所属，服务器侧为了应对各种调整，引入了多种层次的抽象和不同实现。我们先整体介绍下流程。

```bash
rpc2/server.go:CreateBreakpoint
func (s *RPCServer) CreateBreakpoint(arg CreateBreakpointIn, out *CreateBreakpointOut) error {
    \--> err := api.ValidBreakpointName(arg.Breakpoint.Name)
    \--> createdbp, err := s.debugger.CreateBreakpoint(&arg.Breakpoint, arg.LocExpr, arg.SubstitutePathRules, arg.Suspended)
            \--> checking: if breakpoints with the same name as requestBp.Name created before
                 d.findBreakpointByName(requestedBp.Name)
            \--> checking: if breakpoints with the same requestBp.ID created before
                 lbp := d.target.LogicalBreakpoints[requestedBp.ID]
            \--> breakpoint config, initialized based on following order
                 \--> case requestedBp.TraceReturn, 
                      setbp.PidAddrs = []proc.PidAddr{{Pid: d.target.Selected.Pid(), Addr: requestedBp.Addr}}
                 \--> case requestedBp.File != "",
                      setbp.File = requestBp.File
                      setbp.Line = requestBp.Line
                 \--> requestedBp.FunctionName != "",
                      setbp.FunctionName = requestedBp.FunctionName
                      setbp.Line = requestedBp.Line
                 \--> len(requestedBp.Addrs) > 0, 
                      setbp.PidAddrs = make([]proc.PidAddr, len(requestedBp.Addrs))
                      then, fill the setbp.PidAddrs with slice of PidAddr{pid,addr}
                 \--> default, setbp.Addr = requestBp.Addr
            \--> if locexpr != "", 
                 \--> setbp.Expr = func(t *proc.Target) []uint64 {...}
                 \--> setbp.ExprString = locExpr
            \--> create the logical breakpoint
                 \--> `id`, allocate a logical breakpoint ID
                 \--> lbp := &proc.LogicalBreakpoint{LogicalID: id, HitCount: make(map[int64]uint64)}
                 \--> err = d.target.SetBreakpointEnabled(lbp, true)
                      \--> if lbp.enabled && !enabled, then 
                           lbp.enabled = false
                           err = grp.disableBreakpoint(lbp)
                      \--> if !lbp.enabled && enabled, then 
                           lbp.enabled = true
                           lbp.condSatisfiable = breakpointConditionSatisfiable(grp.LogicalBreakpoints, lbp)
                           err = grp.enableBreakpoint(lbp)
                                \--> for p in grp.targets, do: 
                                        err := enableBreakpointOnTarget(p, lbp)
                                            \--> addrs, err = FindFileLocation(p, lbp.Set.File, lbp.Set.Line), or 
                                                addrs, err = FindFunctionLocation(p, lbp.Set.FunctionName, lbp.Set.Line), or 
                                                filter the PidAddrs with same Pid as p.Pid() among lbp.Set.PidAddrs
                                            \--> foreach addr in addrs, do:
                                                    _, err = p.SetBreakpoint(lbp.LogicalID, addr, UserBreakpoint, nil)
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
                                                            
                                     
                 \--> return d.convertBreakpoint(lbp)   

    \--> out.Breakpoint = *createdbp
```

#### breakpoints

#### clear

#### clearall

### 执行测试

### 本文总结
