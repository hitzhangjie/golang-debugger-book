## 架构设计

本章开头，我们介绍了调试器在软件开发全生命周期中的必要性。这一节我们来分析在真实的开发、测试、线上环境中软件调试面临的诸多挑战，包括多平台兼容性、远程调试、安全隔离、性能影响等。

为了应对这些挑战，现代调试器普遍采用前后端分离式架构，并支持前后端的独立扩展、演进。本书的配套实现 godbgv2 采用如下分层：

- 前端：`cmd/`（进程级入口命令）+ `cmd/debug/`（交互式会话命令）+ `pkg/terminal`（输出辅助）；
- 服务层：`pkg/service/api`（前后端契约）、`pkg/service/rpc2`（RPC 方法）、`pkg/service/wire.go`（本地/远程装配）、`pkg/service/listenerpipe.go`（`net.Pipe` 监听器）；
- 后端服务门面：`pkg/service/debugger`；
- 符号层：`pkg/dwarf`（DWARF 解析）+ `pkg/proc`（函数、变量、goroutine、调用栈等符号视图）+ `pkg/locspec`（位置描述解析）；
- 目标层：`pkg/target`（ptrace、线程、寄存器、内存、断点、continue/step）。

各层的职责边界与代码约束见 godbgv2 仓库的 `docs/ARCH-RULES.md`；本章后续小节会按「UI → Service → 符号层 → 目标层」的顺序展开，并始终以 godbgv2 的真实代码为准。早期基于 tinydbg（delve 裁剪版）的叙述仅作为历史对照。

OK，让我们一起了解下现代调试器面临的挑战，以及如何通过合理的架构设计来解决这些问题吧。Let's Go!
