## Breakpoint - part2: 断点相关命令实现

前一小节我们深入介绍了现代调试器断点精细化管理面临的挑战以及解决办法，本节我们从实现角度出发，来看一看tinydbg是如何实现常用断点操作的。

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
- watch，监视对某个变量或者内存地址处的读写操作，是借助硬件断点对特定地址的数据读写、指令执行来实现的；

ps：说它们相关，是因为这几个命令的实现也是在断点基础上实现的，`condition` 为断点命中增加条件限制，`on` 在断点命中时执行动作，`trace` 在断点命中时打印位置信息，`watch` 相对特殊一点使用硬件断点来实现。

### 代码实现: `breakpoint`

OK，接下来我们看下 `breakpoint` 命令在clientside、serverside分别是如何实现的。

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
   ID被使用则返回错误，错误中说明了使用该ID的断点位置信息， `proc.BreakpointExistsError{File: lbp.File, Line: lbp.Line}`。
4. 根据请求参数中设置断点的方式，创建断点：
   - 如果requestBp.TraceReturn=true，说明是tracepoint请求中还需指定地址requestBp.Addr（函数调用返回地址）
     ```
     setbp.PidAddrs = []proc.PidAddr{ {Pid: d.target.Selected.Pid(), Addr: requestedBp.Addr} }
     ```
   - 如果requestBp.File != "", 则使用requestBp.File:requestBp.Line来创建断点
     ```
     setbp.File = requestBp.File, setbp.Line = requestBp.Line
     ```
   - 如果requestedBp.FunctionName != ""，则使用requestBp.FunctionName:requestBp.Line来创建断点
     ```
     setbp.FunctionName = requestBp.FunctionName, setbp.Line = requestBp.Line
     ```
   - 如果 len(requestedBp.Addrs) != 0，则在目标进程的这些地址处添加断点
     ```
     setbp.PidAddrs = []proc.PidAddr{.....}
     ```
   - 其他情况，使用requestBp.Addr来设置断点
     ```
     setbp.PidAddr = []proc.PidAddr{ {Pid: d.target.Selected.Pid(), Addr: requestedBp.Addr} }
     ```
5. 如果locExpr != ""，则解析位置表达式得到LocationSpec，setbp.Expr实际上是个函数，执行后返回位置表达式查找到的地址列表
   ```
   setbp.Expr = func(t *proc.Target) []uint64 {...}
   setbp.ExprString = locExpr
   ```
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
