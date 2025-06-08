## acceptMulti 模式的工作原理

### 为什么要支持多客户端调试

在社区讨论如何解决这个问题 [Extend Delve backend RPC API to be able to make a Delve REPL front-end console in a IDE](https://github.com/go-delve/delve/issues/383) 时，有位网友反馈在调试会话调试期间，此时如果有另一个client尝试连接（dlv connect），此时会报错：“An existing connection was forcibly closed by the remote host.” 因为这个问题，所以dlv维护人员才支持了--accept-multiclient选项，允许多客户端连接。

尽管关于这个 `--accept-multiclient` 选项的讨论仅有一句话这么简单，但是如果没有这个选项，却会给开发者调试带来很多不便，下面我举个远程调试的例子。

1. 我们设置执行命令 `tinydbg exec ./binary --headless -- <args>` 运行被调试程序，或者 `tinydbg attach <pid>` 来跟踪已经在执行的进程。如果是需要指定启动参数，这个过程并不一定是很简答的。
2. 然后执行 `dlv connect <addr:port>` 进行调试；
3. 或者，希望配合tinydbg 命令行和vscode、goland图形化调试界面使用；
4. 或者，调试期间遇到瓶颈，希望其他人来协助调试、共同定位问题；
5. 或者，执行完这次调试会话，但是不想被调试进程结束，还希望用它来执行后续可能的调试活动；

这里列出的调试场景，要求我们的调试器backend必须能够支持接受多个调试客户端进行连接、共同调试的能力。这个场景和诉求是真实存在的，所以 `--accept-multiclient` 支持仅有几行代码变更，但是对于我们更便利地调试而言，却是非常重要的。

### 单客户端 vs 多客户端模式

tinydbg 支持两种调试服务器模式：
1. 单客户端模式（--headless 不带 --accept-multiclient）
    - 服务器只接受一个客户端连接
    - 当第一个客户端连接并退出时，调试服务器会自动关闭
    - 这种模式适合单次调试会话，调试完成后自动清理资源
2. 多客户端模式（--headless --accept-multiclient）
    - 服务器会持续运行，等待多个客户端连接
    - 每个客户端可以独立连接和断开
    - 所有客户端共享相同的调试状态（断点、观察点等）
    - 被调试程序会持续运行，直到所有客户端都断开连接

这两种模式的主要区别在于服务器对客户端连接的处理方式，以及调试会话的生命周期管理。

实现原理如下，关键之处在于接受1个入连接请求后，后续入连接请求是拒绝还是允许:

```go
go func() {
    defer s.listener.Close()
    for {
        c, err := s.listener.Accept()
        if err != nil {
            select {
            case <-s.stopChan:
                return
            default:
                panic(err)
            }
        }
        go s.serveConnection(c)
        if !s.config.AcceptMulti {
            break
        }
    }
}()
```

### 多客户端模式的可能应用场景

多客户端模式特别适用于以下场景：

1. **连续调试**
   - 多个客户端可以先后连接
   - 不需要重启被调试程序
   - 适合长时间运行的调试任务

2. **多工具协同**
   - 可以同时使用命令行 UI 和 VSCode 调试面板
   - 不同工具可以共享相同的调试状态
   - 便于使用不同工具的优势

3. **团队协作**
   - 多个开发者可以同时连接到同一个调试会话
   - 共享断点、观察点等设置
   - 便于团队协作解决复杂问题

### 注意事项

1. **API 非重入性**
   - 虽然支持多客户端连接，但 API 不是可重入的
   - 客户端需要协调使用，避免冲突

2. **模式限制**
   - 在非 headless 模式下，acceptMulti 选项会被忽略
   - 必须同时使用 --headless 和 --accept-multiclient

3. **客户端断开处理**
   - 客户端断开连接时，可以选择是否继续执行被调试程序
   - 使用 `quit -c` 命令可以在断开连接时继续执行程序

### 总结

acceptMulti 模式是 tinydbg 的一个重要特性，它使得调试器能够支持多客户端连接，这对于多轮调试、多客户端调试、协作调试等场景非常有用。通过共享调试状态，多个客户端可以先后进行调试，也可以协同调试，提高调试效率。可以说 `--accept-multiclient` 支持多客户端模式，不算是一个大的特性，而是一个设计实现上必须考虑到的功能点。
