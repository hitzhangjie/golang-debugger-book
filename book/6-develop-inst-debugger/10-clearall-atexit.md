## 软件动态断点：退出前清理机制

### 问题背景：断点残留的危害

在调试器开发过程中，我们通过ptrace系统调用对目标进程的指令进行动态修改来实现动态软件断点。具体来说，断点的添加是通过将目标地址的指令字节替换为0xCC（int3指令）来实现的，同时需要备份原始指令字节以便后续恢复。

调试器与tracee的关系存在多种场景：

- 通过 `debug` 编译构建并启动构建好的程序；
- 通过 `exec` 启动已经构建好的程序；
- 通过`attach`跟踪正在运行中的进程。

对于前两种情况，调试器退出时通常会主动终止tracee；而对于`attach`场景，调试器退出后时一般会倾向于恢复tracee的执行。

然而，如果调试器在退出前没有主动清理这些动态添加的断点，将会给被调试进程造成严重的不良影响：

1. **指令不完整**：多字节指令被patch后变成不完整的指令序列
2. **SIGTRAP信号**：当tracee执行到断点位置时，会触发SIGTRAP信号  
3. **进程终止**：在没有tracer的情况下，内核的默认行为是杀死该tracee进程

我们必须足够重视这个问题，需要实现一个类似C语言atexit的机制，在调试器退出前自动清理所有断点。

### 实现目标：自动断点清理

为了避免上述问题，我们需要在调试器退出前自动清理所有已添加的断点。这要求我们：

1. **跟踪所有断点**：维护一个全局的断点集合，记录所有已添加的断点信息
2. **自动清理机制**：在调试会话结束时，自动遍历并清理所有断点
3. **优雅退出**：确保tracee进程在调试器退出后能够继续正常运行

### 代码实现

我们通过实现一个类似C语言`atexit`的机制来实现自动断点清理。具体实现包括：

#### 1. DebugSession结构体扩展

```go
type DebugSession struct {
    // ... 其他字段
    defers []func() // 退出前需要执行的清理函数
}

// AtExit 注册退出前的清理函数
func (s *DebugSession) AtExit(fn func()) *DebugSession {
    s.defers = append(s.defers, fn)
    return s
}
```

#### 2. 启动方法中的defer机制

```go
func (s *DebugSession) Start() {
    s.liner.SetCompleter(completer)
    s.liner.SetTabCompletionStyle(liner.TabPrints)

    // 注册退出前的清理逻辑
    defer func() {
        for idx := len(s.defers) - 1; idx >= 0; idx-- {
            s.defers[idx]()
        }
    }()
    
    // ... 其他启动逻辑
}
```

#### 3. 断点清理函数

```go
// Cleanup 清理所有断点的函数
func Cleanup() {
    fmt.Println("正在清理断点...")
    
    for _, brk := range breakpoints {
        n, err := syscall.PtracePokeData(TraceePID, brk.Addr, []byte{brk.Orig})
        if err != nil || n != 1 {
            fmt.Printf("清理断点失败: %v\n", err)
            continue
        }
    }
    
    // 清空断点集合
    breakpoints = map[uintptr]*target.Breakpoint{}
    fmt.Println("断点清理完成")
}
```

#### 4. 调试会话的创建和使用

```go
// 创建调试会话并注册清理函数
session := debug.NewDebugSession().AtExit(Cleanup)
session.Start()
```

### 测试用例

#### 测试场景：不清理断点的后果

我们通过一个实际的测试来演示不清理断点会导致的问题：

1. **启动测试进程**：

```bash
$ while [ 1 -eq 1 ]; do t=`date`; echo "$t pid: $$"; sleep 1; done

Sun Sep  7 15:22:23 CST 2025 pid: 416728
Sun Sep  7 15:22:24 CST 2025 pid: 416728
Sun Sep  7 15:22:25 CST 2025 pid: 416728
Sun Sep  7 15:22:26 CST 2025 pid: 416728
```

2. **附加调试器并添加断点**：

```bash
godbg attach 416728
godbg> pregs
    Rax <Rax value>
    Rbx <Rbx value>
    ... 
    Rip <Rip value>
    ...

godbg> break <Rip value>
godbg> continue
```

3. **观察进程行为**：

执行continue后，tracee开始重新输出信息：

```bash
Sun Sep  7 15:23:19 CST 2025 pid: 416728 <= after we run `continue`, we see the output again.
```

4. **退出调试器（不清理断点）**：

```bash
godbg> exit
```

5. **观察进程终止**：

```bash
Sun Sep  7 15:22:23 CST 2025 pid: 416728
Sun Sep  7 15:22:24 CST 2025 pid: 416728
Sun Sep  7 15:22:25 CST 2025 pid: 416728
Sun Sep  7 15:22:26 CST 2025 pid: 416728
Sun Sep  7 15:22:27 CST 2025 pid: 416728 
                                        

Sun Sep  7 15:23:19 CST 2025 pid: 416728

[process exited with code 5 (0x00000005)] <= tracee exited with error
You can now close this terminal with Ctrl+D, or press Enter to restart.
```

#### 测试场景：使用AtExit机制的正确行为

1. **启动测试进程**：

```bash
$ while [ 1 -eq 1 ]; do t=`date`; echo "$t pid: $$"; sleep 1; done
```

2. **使用带AtExit的调试器**：

```bash
godbg attach 416728
godbg> break <address>
godbg> exit
正在清理断点...
断点清理完成
```

3. **验证进程继续运行**：

```bash
Sun Sep  7 15:22:23 CST 2025 pid: 416728
Sun Sep  7 15:22:24 CST 2025 pid: 416728
Sun Sep  7 15:22:25 CST 2025 pid: 416728
Sun Sep  7 15:22:26 CST 2025 pid: 416728
Sun Sep  7 15:22:27 CST 2025 pid: 416728 
                                        

Sun Sep  7 15:23:19 CST 2025 pid: 416728
Sun Sep  7 15:23:20 CST 2025 pid: 416728 <= 进程继续正常运行
Sun Sep  7 15:23:21 CST 2025 pid: 416728
```

### 本节小结

本节主要探讨了调试器退出前断点清理机制的重要性与实现方法，核心内容包括：**断点残留的危害性分析**；**SIGTRAP信号导致的进程终止问题**；**AtExit机制的实现原理**；**自动断点清理的代码实现**。

本节核心要点包括：

- 断点通过ptrace修改指令字节实现，如果不清理会导致多字节指令不完整，执行时触发SIGTRAP信号
- 在没有tracer的情况下，内核默认行为是杀死触发SIGTRAP的进程，导致被调试进程异常终止
- 通过实现类似C语言atexit的机制，在调试会话退出前自动清理所有断点，确保tracee进程能够继续正常运行
- AtExit机制通过defer函数和回调函数注册实现，提供了优雅的资源清理方式

本节内容为调试器的健壮性设计提供了重要保障，确保调试器在各种退出场景下都能正确清理资源，为读者理解调试器的生命周期管理和资源清理机制奠定了实践基础。通过本节的学习，读者可以掌握调试器开发中资源管理的最佳实践，为后续开发更复杂的调试器功能提供了重要的设计参考。
