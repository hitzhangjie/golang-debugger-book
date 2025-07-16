## watchpoint

本文我们介绍下watchpoint的设计及实现，详细解释一下watchpoint的实现原理，以及它与普通断点breakpoint的区别。

### 实现目标 `watch -r|-w|-rw`

```bash
(tinydbg) help watch
Set watchpoint.

        watch [-r|-w|-rw] <expr>

        -r      stops when the memory location is read
        -w      stops when the memory location is written
        -rw     stops when the memory location is read or written

The memory location is specified with the same expression language used by 'print', for example:

        watch v
        watch -w *(*int)(0x1400007c018)

will watch the address of variable 'v' and writes to an int at addr '0x1400007c018'.

Note that writes that do not change the value of the watched memory address might not be reported.

See also: "help print".
```

### 代码实现

#### 1. 硬件断点机制

Watchpoint是基于**硬件断点（Hardware Breakpoint）**实现的，它利用了CPU的调试寄存器（Debug Registers）：

```go
// 在 pkg/proc/amd64util/debugregs.go 中
type DebugRegisters struct {
    pAddrs     [4]*uint64  // DR0-DR3: 存储断点地址
    pDR6, pDR7 *uint64     // DR6: 状态寄存器, DR7: 控制寄存器
    Dirty      bool
}
```

- **DR0-DR3**: 存储4个硬件断点的地址
- **DR6**: 状态寄存器，记录哪个断点被触发
- **DR7**: 控制寄存器，配置断点的类型（读/写/执行）和大小

#### 2. Watchpoint的设置过程

```523:596:pkg/proc/breakpoints.go
// SetWatchpoint sets a data breakpoint at addr and stores it in the
// process wide break point table.
func (t *Target) SetWatchpoint(logicalID int, scope *EvalScope, expr string, wtype WatchType, cond ast.Expr) (*Breakpoint, error) {
    // 1. 验证watchpoint类型（至少需要读或写）
    if (wtype&WatchWrite == 0) && (wtype&WatchRead == 0) {
        return nil, errors.New("at least one of read and write must be set for watchpoint")
    }

    // 2. 解析表达式并获取变量地址
    n, err := parser.ParseExpr(expr)
    if err != nil {
        return nil, err
    }
    xv, err := scope.evalAST(n)
    if err != nil {
        return nil, err
    }
    
    // 3. 验证变量是否可以被监视
    if xv.Addr == 0 || xv.Flags&VariableFakeAddress != 0 || xv.DwarfType == nil {
        return nil, fmt.Errorf("can not watch %q", expr)
    }
    
    // 4. 特殊处理接口类型
    if xv.Kind == reflect.Interface {
        _, data, _ := xv.readInterface()
        xv = data
        expr = expr + " (interface data)"
    }

    // 5. 检查变量大小限制
    sz := xv.DwarfType.Size()
    if sz <= 0 || sz > int64(t.BinInfo().Arch.PtrSize()) {
        return nil, fmt.Errorf("can not watch variable of type %s", xv.DwarfType.String())
    }

    // 6. 检查栈变量特殊处理，栈上变量，不能 `watch -r`，因为栈会resize
    stackWatch := scope.g != nil && !scope.g.SystemStack && xv.Addr >= scope.g.stack.lo && xv.Addr < scope.g.stack.hi
    if stackWatch && wtype&WatchRead != 0 {
        return nil, errors.New("can not watch stack allocated variable for reads")
    }

    // 7. 创建硬件断点
    bp, err := t.setBreakpointInternal(logicalID, xv.Addr, UserBreakpoint, wtype.withSize(uint8(sz)), cond)
    if err != nil {
        return bp, err
    }
    bp.WatchExpr = expr

    // 8. 如果是栈变量，设置额外的监视断点
    if stackWatch {
        bp.watchStackOff = int64(bp.Addr) - int64(scope.g.stack.hi)
        err := t.setStackWatchBreakpoints(scope, bp)
        if err != nil {
            return bp, err
        }
    }

    return bp, nil
}
```

#### 3. 硬件断点的写入和清除

```180:220:pkg/proc/native/proc.go
func (dbp *nativeProcess) WriteBreakpoint(bp *proc.Breakpoint) error {
    if bp.WatchType != 0 {
        // 硬件断点：为所有线程设置调试寄存器
        for _, thread := range dbp.threads {
            err := thread.writeHardwareBreakpoint(bp.Addr, bp.WatchType, bp.HWBreakIndex)
            if err != nil {
                return err
            }
        }
        return nil
    }

    // 软件断点：替换内存中的指令
    bp.OriginalData = make([]byte, dbp.bi.Arch.BreakpointSize())
    _, err := dbp.memthread.ReadMemory(bp.OriginalData, bp.Addr)
    if err != nil {
        return err
    }
    return dbp.writeSoftwareBreakpoint(dbp.memthread, bp.Addr)
}
```

### Watchpoint vs Breakpoint

#### 1. **实现机制不同**

| 特性 | Watchpoint | Breakpoint |
|------|------------|------------|
| **实现方式** | 硬件断点（CPU调试寄存器） | 软件断点（指令替换） |
| **触发条件** | 内存访问（读/写） | 指令执行 |
| **数量限制** | 最多4个（x86-64） | 理论上无限制 |
| **性能影响** | 很小 | 较大（需要指令替换） |

#### 2. **触发时机不同**

- **Watchpoint**: 当程序访问（读或写）特定内存地址时触发
- **Breakpoint**: 当程序执行到特定指令地址时触发

#### 3. **使用场景不同**

- **Watchpoint**: 
  - 监视变量值的变化
  - 检测内存访问模式
  - 调试数据竞争问题

- **Breakpoint**:
  - 在特定代码行停止执行
  - 函数入口/出口断点
  - 条件断点

#### 4. **技术实现细节**

##### Watchpoint的硬件支持：
```go
// 在 pkg/proc/amd64util/debugregs.go 中
func (drs *DebugRegisters) SetBreakpoint(idx uint8, addr uint64, read, write bool, sz int) error {
    // 设置地址
    *(drs.pAddrs[idx]) = addr
    
    // 配置类型（读/写）和大小
    var lenrw uint64
    if write {
        lenrw |= 0x1
    }
    if read {
        lenrw |= 0x2
    }
    
    // 设置大小（1, 2, 4, 8字节）
    switch sz {
    case 1: // 1字节
    case 2: lenrw |= 0x1 << 2
    case 4: lenrw |= 0x3 << 2
    case 8: lenrw |= 0x2 << 2
    }
    
    // 写入控制寄存器并启用
    *(drs.pDR7) &^= (0xf << lenrwBitsOffset(idx))
    *(drs.pDR7) |= lenrw << lenrwBitsOffset(idx)
    *(drs.pDR7) |= 1 << enableBitOffset(idx)
    return nil
}
```

##### 检测硬件断点触发：
```go
func (drs *DebugRegisters) GetActiveBreakpoint() (ok bool, idx uint8) {
    for idx := uint8(0); idx <= 3; idx++ {
        enable := *(drs.pDR7) & (1 << enableBitOffset(idx))
        if enable == 0 {
            continue
        }
        if *(drs.pDR6)&(1<<idx) != 0 {
            *drs.pDR6 &^= 0xf // 清除状态位
            return true, idx
        }
    }
    return false, 0
}
```

#### 5. **栈变量的特殊处理**

对于栈上的变量，tinydbg还实现了额外的机制来处理栈增长：

```go
// 在 pkg/proc/stackwatch.go 中
func (t *Target) setStackWatchBreakpoints(scope *EvalScope, watchpoint *Breakpoint) error {
    // 设置栈增长检测断点
    // 当栈增长时，需要调整watchpoint的地址
}
```

### 针对栈变量的特殊处理

核心原因：Go运行时的栈增长机制

#### 1. **Go的栈增长机制**

Go的goroutine栈是**动态增长的**。当栈空间不足时，Go运行时会：

1. 分配一个更大的新栈
2. 调用 `runtime.copystack` 函数
3. 将旧栈上的所有数据复制到新栈
4. 更新goroutine的栈指针

#### 2. **栈增长时的内存读取**

在栈增长过程中，Go运行时会**读取**栈上的所有数据来复制它们：

```go
// 在 pkg/proc/stackwatch.go 中的注释说明了这一点
// In Go goroutine stacks start small and are frequently resized by the
// runtime according to the needs of the goroutine.
```

当 `runtime.copystack` 执行时，它会读取整个栈的内容，包括你监视的栈变量。这意味着：

- **读操作监视**：会频繁触发，因为运行时经常读取栈内容，会干扰我们调试判断程序逻辑中是否真有“读”操作发生
- **写操作监视**：只在程序实际修改变量时触发，运行时不会修改

#### 3. **代码中的具体实现**

```523:596:pkg/proc/breakpoints.go
if stackWatch && wtype&WatchRead != 0 {
    // In theory this would work except for the fact that the runtime will
    // read them randomly to resize stacks so it doesn't make sense to do
    // this.
    return nil, errors.New("can not watch stack allocated variable for reads")
}
```

注释明确说明了原因：**理论上这是可行的，但运行时为了调整栈大小会随机读取它们，所以这样做没有意义。**

#### 4. **栈增长检测机制**

tinydbg通过设置特殊的断点来检测栈增长：

```go
// 在 pkg/proc/stackwatch.go 中
// Stack Resize Sentinel
retpcs, err := findRetPC(t, "runtime.copystack")
if err != nil {
    return err
}

rszbp, err := t.SetBreakpoint(0, retpcs[0], StackResizeBreakpoint, sameGCond)
if err != nil {
    return err
}

rszbreaklet := rszbp.Breaklets[len(rszbp.Breaklets)-1]
rszbreaklet.callback = func(th Thread, _ *Target) (bool, error) {
    adjustStackWatchpoint(t, th, watchpoint)
    return false, nil // we never want this breakpoint to be shown to the user
}
```

当检测到栈增长时，会调用 `adjustStackWatchpoint` 来调整watchpoint的地址：

```go
func adjustStackWatchpoint(t *Target, th Thread, watchpoint *Breakpoint) {
    g, _ := GetG(th)
    if g == nil {
        return
    }
    err := t.proc.EraseBreakpoint(watchpoint)
    if err != nil {
        return
    }
    delete(t.Breakpoints().M, watchpoint.Addr)
    // 根据新的栈地址调整watchpoint位置
    watchpoint.Addr = uint64(int64(g.stack.hi) + watchpoint.watchStackOff)
    err = t.proc.WriteBreakpoint(watchpoint)
    if err != nil {
        return
    }
    t.Breakpoints().M[watchpoint.Addr] = watchpoint
}
```

#### 5. **为什么写操作可以监视？**

写操作可以监视是因为：

1. **写操作是程序逻辑的一部分**：只有当程序实际修改变量时才会触发
2. **运行时不会随机写入栈变量**：栈增长时只是读取和复制，不会修改原始数据
3. **写操作有明确的语义**：表示程序状态的实际变化

#### 6. **实际影响**

如果允许栈变量的读操作监视，会导致：

- **频繁的误报**：每次栈增长都会触发watchpoint
- **性能问题**：栈增长是常见操作，会导致大量不必要的调试器暂停
- **用户体验差**：用户无法区分是程序读取还是运行时读取

#### 总结

栈变量不能监视读操作的根本原因是：

1. **Go运行时的栈增长机制**会频繁读取栈内容，这并不是程序逻辑中的读取，设置上也会干扰我们调试
2. **读操作监视会产生大量误报**，因为无法区分程序读取和运行时读取
3. **写操作监视是安全的**，因为运行时不会修改栈变量的值

这是一个设计决策，目的是提供更好的调试体验，避免因为运行时内部操作而产生无意义的watchpoint触发。

### 总结

Watchpoint和Breakpoint是两种不同层次的调试机制：

- **Watchpoint** 是数据断点，基于CPU硬件特性实现，监视内存访问
- **Breakpoint** 是代码断点，基于软件实现，监视指令执行

Watchpoint更适合调试数据相关的问题，而Breakpoint更适合调试控制流问题。两者在tinydbg中都有完整的实现，可以根据不同的调试需求选择使用。