## Breakpoint - part2: 添加断点+执行到断点

前一小节我们深入介绍了现代调试器断点精细化管理面临的挑战以及解决办法，本节我们从实现角度出发，来看一看tinydbg是如何实现常用断点操作的，以及执行到断点之后的处理。

### 实现目标: 添加+执行到断点

本节实现目标，重点是介绍添加断点命令 `breakpoint` 的设计实现，以及执行到断点后调试器的相关处理逻辑。前一节介绍了现代调试器断点的层次化、精细化管理，引入了一些必要的设计及抽象，实现是也会相对更复杂。调试器中断点强相关的调试命令有多个，为了保证内容更聚焦、更便于阅读理解，本节仅介绍添加断点命令 `breakpoint` 以及 程序执行到断点后的相关处理逻辑。

这也是断点相关设计实现中最核心的内容，理解了这部分内容后，再去理解其他的调试命令都是水到渠成的事情。这些剩下的调试命令，我们将在后续断点相关的其他小结进行介绍：

- part1：介绍现代调试器断点的层次化、精细化管理；
- part2：breakpoint命令添加断点，以及执行到断点后的处理逻辑；
- part3：`breakpoint ... if expr` or `condition <bpid> expr` 条件断点的创建，及断点命中后的处理逻辑；
- part4：`breakpoints` `clear` `clearall` `toggle`，这几个查看、清理、关闭or激活断点的操作；
- ~part5~：`trace` `watch` 这两种特殊类型的断点会在 [trace](./26-debug_trace.md) 和 [watch](./2-debug_watch.md) 中分别进行介绍。

ps: `on <bpid> command` 断点命中后执行指定的动作，这个会在介绍part2、part3过程中介绍。

### 代码实现: `breakpoint`

OK，接下来我们看下 `breakpoint` 命令在clientside、serverside分别是如何实现的。

先来看看break支持的操作, `break [--name|-n=name] [locspec] [if <condition>]`:

- `--name|-n=name` 可以指定断点名字，如果调试任务比较重，涉及到大量断点，能给断点命名非常有用，它比id更易于辨识使用；
- `[locspec]` 前面介绍过的所有受支持的 `locspec`写法，`break` 命令都予以了支持，这将使得添加断点非常方便；
- `[if condition]` 添加断点时还可以直接指定断点激活条件 `if <condition>`，这里的condition是任意bool类型表达式。

ps：如果断点创建时未指定条件，后续也可以使用 `condition <breakpoint> <boolexpr>` 为已有断点指定条件。

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

#### 关键拆解

- **逻辑断点全局共享，统一管理**：所有断点都是逻辑断点，在 TargetGroup 级别统一管理，避免重复设置

  ```go
  // 在 TargetGroup 中
  LogicalBreakpoints map[int]*LogicalBreakpoint
  ```

  当在进程P1的线程T1上设置断点时，创建的是一个逻辑断点。这个逻辑断点会被自动应用到所有相关的进程和线程，这离不开下面的自动断点传播机制。

- **自动断点传播机制，调试便利**：新进程、新线程自动继承现有的断点

  当新进程或线程加入调试组时，断点会自动传播：

  ```go
  func (grp *TargetGroup) addTarget(p ProcessInternal, pid int, currentThread Thread, path string, stopReason StopReason, cmdline string) (*Target, error) {
    ...
    t, err := grp.newTarget(p, pid, currentThread, path, cmdline)
    ...
    // 共享逻辑断点
    t.Breakpoints().Logical = grp.LogicalBreakpoints  

    // 自动为新目标启用所有现有的逻辑断点
    for _, lbp := range grp.LogicalBreakpoints {
        if lbp.LogicalID < 0 {
            continue
        }
        // 在新目标上启用断点
        err := enableBreakpointOnTarget(t, lbp)  
        ...
    }
    ...
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
        // 指定进程指定地址处添加断点：过滤出目标进程为p的逻辑断点进行设置
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

- **断点状态同步，全局共享**：断点命中计数等信息在逻辑断点级别维护，所有进程、线程共享

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

- **断点启用策略，控制灵活**：通过 follow-exec 和正则表达式控制断点传播范围

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

OK，接下来我们将在下一小节看下 `breakpoint` 命令在clientside、serverside分别是如何实现的。

### 执行测试

略。

### 本文总结

本节深入介绍了tinydbg调试器中 `breakpoint` 命令的实现机制，从客户端到服务器端的完整处理流程。客户端通过解析用户输入的断点参数（名称、位置描述、条件），向服务器请求对应的指令地址列表，并支持创建普通断点、条件断点、suspended断点和tracepoints等多种类型。服务器端采用层次化的断点管理架构，通过逻辑断点（LogicalBreakpoint）统一管理用户概念上的断点，通过物理断点（Breakpoint）在具体指令地址处实现断点功能，并通过自动断点传播机制确保新进程和线程能够继承现有断点。这种设计不仅提高了断点管理的效率，还支持复杂的多进程调试场景，为现代调试器提供了强大而灵活的断点功能。


