## 核心调试命令

在第 5 章《调试器概貌》我们分析了调试器的功能性需求、非功能性需求和大致的实现方案；第 6 章介绍了指令级调试器的设计实现；第 7 章介绍了 ELF、编译器、链接器、加载器以及地址换算；第 8 章介绍了 DWARF 如何描述源程序的数据、指令和运行时视图。9.1 对现代调试器的整体架构做了介绍，本节开始进入具体调试命令的设计与实现。

在展开之前，先把「第 9 章到底要实现哪些命令、实现到什么程度」说清楚。godbgv2 不是 dlv 的完整复刻：它只保留 linux/amd64 的 native backend，按教学节奏逐节增加命令；有些命令是完整实现，有些是明确的能力子集，有些是桩，还有一些是书稿声明「本书不做」的范围决策。后文每个小节都会对应一个 godbgv2 tag（如 `ch9.2.22`），读者可以用 `git checkout` 复现该节完成时的代码；本节先给出一张总表，避免读者把「书里提到了」误当成「已经实现」。

> 历史说明：第 9 章早期版本以 tinydbg（基于 go-delve/delve 裁剪的符号级调试器）为 demo；现在配套实现是 godbgv2。两者的命令形态有继承关系，但代码与能力边界以 godbgv2 为准。

### 支持多种调试对象

| 命令 | 描述 | 对象类型 | godbgv2 状态 | 说明 |
| --- | --- | --- | --- | --- |
| `godbg attach <pid>` | 调试一个正在运行的进程 | process | ✅ | 支持 `--waitfor`（等待指定 pid 出现，不是按进程名匹配） |
| `godbg exec <prog>` | 启动并调试指定的可执行文件 | executable | ✅ | 支持 `--` 之后的参数透传、`--disable-aslr` |
| `godbg debug [dir\|file]` | 编译并调试 main 包 | go main package | ✅ | 固定 `-N -l -compressdwarf=false`，产物 `__debug_bin__` |
| `godbg core <corefile> <executable>` | 调试 core 文件 | core dump | 🅿️ | 后端 `pkg/proc/core` 已能解析，`cmd/core.go` 仍是桩，返回明确错误 |
| `godbg connect <addr>` | 连接 headless 调试服务端 | remote | ✅ | 仅 TCP；不支持多客户端 |
| `godbg test` | 调试测试函数 | test package | 🚫 | 本书明确不做，可用 `go test -c` + `godbg exec` 替代 |

> 关于 `godbg test`：Go 原生测试框架已经提供了 `go test`，调试测试包可以 `go test -c -gcflags 'all=-N -l'` 后 `godbg exec ./xxx.test`。单独做 `godbg test` 只是构建/启动的便利，不涉及新的核心调试逻辑，因此不纳入本书范围。

### 支持多种调试模式

| 模式 | 命令 | godbgv2 状态 | 说明 |
| --- | --- | --- | --- |
| 本地调试 | `godbg debug/exec/attach` | ✅ | 本地也走进程内 RPC（`net.Pipe`），见 9.2.16 |
| 远程/headless 服务端 | `--headless --listen <addr>` | ✅ | 只支持 TCP，不支持 Unix socket |
| 远程客户端 | `godbg connect <addr>` | ✅ | 只支持 TCP；服务端同一时刻只服务一个客户端 |
| DAP | `godbg dap` | 🚫 | 不做；DAP 只在 9.3 作为扩展方向介绍 |
| 函数跟踪 | 会话内 `trace <regexp>` | ✅ | breakpoint-based；没有 eBPF-based，也没有顶层 `godbg trace` |
| 禁用 ASLR | `--disable-aslr` | ✅ | 通过 `setarch -R` 实现 |
| 其他 backend | `--backend=gdb/lldb/rr` | 🚫 | 只有 native backend；backend 抽象是扩展方向 |
| 多客户端 | `--accept-multiclient` | 🚫 | 所有连接共享同一个 `debugger.Debugger` 单例，未实现会话隔离 |

> **命令形态注意**：godbgv2 **没有顶层 `trace` 命令**。`trace` 是进入调试会话后的断点族命令（`godbg> trace main.*`），见 9.2.17（后端）和 9.2.25（命令）。

### 命令能力矩阵

> 图例：✅ 可用 ｜ ⚠️ 可用但有明确边界 ｜ 🅿️ 桩/未接线 ｜ 🚫 本书有意不做 ｜ ❌ 未实现（未规划）。能力判定以「命令可用性」为准，不以「代码存在」为准。

#### 执行控制

| 命令 | 别名 | 状态 | 说明 | 代码定位 |
| --- | --- | --- | --- | --- |
| `continue` | `c` | ✅ | 运行到下一个断点或进程结束；all-stop | `cmd/debug/continue.go`、`pkg/target/continue.go` |
| `step` | `s` | ✅ | **指令级**单步，不是源码行单步 | `cmd/debug/step.go`、`pkg/target/step.go` |
| `stepout` | `so`、`finish` | ✅ | 执行到当前函数返回；`finish` 别名存在，但被同名桩遮蔽（见 9.2.39） | `cmd/debug/stepout.go`、`pkg/proc/backtrace.go` |
| `call` | — | ⚠️ | 调试期函数调用；仅整型实参、最多 9 个 | `cmd/debug/call.go`、`pkg/proc/call.go` |
| `next` | `n` | 🅿️ | 桩：打印 `TODO(ch9.2.28)` 后返回；源码级单步未实现 | `cmd/debug/next.go` |
| `step-instruction` / `next-instruction` | `si`/`ni` | 🚫 | 不单独提供；`step` 本身即指令级 | — |

#### 断点体系

| 命令 | 别名 | 状态 | 说明 | 代码定位 |
| --- | --- | --- | --- | --- |
| `break` | `b`、`breakpoint` | ✅ | locspec 全形式；`--name/-n` 命名；`if <cond>` 条件 | `cmd/debug/break.go`、`pkg/proc/location.go` |
| `breakpoints` | `bp`、`bs` | ✅ | 列出逻辑断点、地址、命中计数、启用状态 | `cmd/debug/breakpoints.go` |
| `clear` | — | ✅ | 按编号删除断点 | `cmd/debug/clear.go` |
| `clearall` | — | ✅ | 删除全部断点 | `cmd/debug/clearall.go` |
| `condition` | `cond` | ✅ | 设置/清除条件断点条件 | `cmd/debug/condition.go` |
| `toggle` | — | ✅ | 启用/禁用断点；禁用时还原物理指令并回退 PC | `cmd/debug/toggle.go` |
| `trace` | `t` | ✅ | 按正则批量设置跟踪点，命中打印后自动继续 | `cmd/debug/trace.go`、`pkg/proc/trace.go` |
| `watch` | `wa` | ✅ | 硬件监视点；DR0-DR3/DR6/DR7，固定 4 字节窗口（DR7 LEN=0b11；源码注释写 8 字节有误） | `cmd/debug/watch.go`、`pkg/target/hwbreakpoint.go` |
| `on` | — | 🚫 | 断点命中自动执行命令，依赖 starlark，本书不做 | — |

#### 数据查看与修改

| 命令 | 别名 | 状态 | 说明 | 代码定位 |
| --- | --- | --- | --- | --- |
| `print` | `p` | ⚠️ | 表达式求值；支持标识符/字段/下标/解引用/取址/算术/比较/逻辑/`len`/`cap` | `cmd/debug/print.go`、`pkg/proc/eval.go` |
| `set` | — | ⚠️ | 修改变量；教学版仅支持基本类型，支持 `pt.X`、`arr[1]` 等 lvalue | `cmd/debug/set.go` |
| `pmem` | — | ✅ | 查看内存；`--count/--fmt/--size` | `cmd/debug/pmem.go` |
| `setmem` | — | ✅ | 写内存 | `cmd/debug/set_mem.go` |
| `pregs` | — | ✅ | 查看寄存器 | `cmd/debug/pregs.go` |
| `setreg` | — | ✅ | 修改寄存器 | `cmd/debug/set_reg.go` |
| `args` / `locals` / `vars` | — | ❌ | 未实现；目前用 `print` 逐个取 | — |
| `whatis` | — | ❌ | 未实现；`ptypes` 是桩 | `cmd/debug/ptypes.go` |
| `display` | — | 🅿️ | 桩：每次停止时打印表达式的能力未实现 | `cmd/debug/display.go` |

> `print` 不支持函数调用、复合字面量、map/channel 操作、方法调用、接口断言、切片表达式；具体边界见 9.2.18 与 9.2.36。
>
> 类型转换也按「不支持」处理：`pkg/proc/eval.go` 顶部注释和 `docs/FEATURE-MATRIX.md` §4 曾把类型转换列为支持，但 `print int(i)` 实测报 `function calls not supported (教学版能力边界)`；以代码和实测为准，这一项记为 ❌（文档订正另见 storyboard §7）。

#### 线程与 goroutine

| 命令 | 别名 | 状态 | 说明 | 代码定位 |
| --- | --- | --- | --- | --- |
| `goroutines` | `grs` | ✅ | 列出全部 goroutine（goid、状态、入口） | `cmd/debug/goroutines.go`、`pkg/proc/goroutines.go` |
| `goroutine` | `gr` | ⚠️ | 选中/切换 goroutine 作为调试上下文；跨 M 运行中的 goroutine 有限制 | `cmd/debug/goroutine.go` |
| `threads` | — | ✅ | 列出全部线程（tid、PC、位置，`*` 标当前事件线程） | `cmd/debug/threads.go` |
| `thread` | `tr` | ✅ | 切换调试上下文到指定线程；`thread -r` 复位 | `cmd/debug/thread.go` |

#### 调用栈

| 命令 | 别名 | 状态 | 说明 | 代码定位 |
| --- | --- | --- | --- | --- |
| `backtrace` | `bt` | ✅ | 按 `.debug_frame` CFI 逐帧回溯 | `cmd/debug/backtrace.go`、`pkg/proc/backtrace.go` |
| `bt` / `stack` | — | 🅿️ | 同名桩；输入 `bt` 会先命中 `backtrace` 的别名，`stack` 则命中桩 | `cmd/debug/bt.go` |
| `frame` | — | 🅿️ | 桩：选择栈帧未实现 | `cmd/debug/frame.go` |
| `up` / `down` | — | ❌ | 未实现 | — |
| `deferred` | — | ❌ | 未实现；defer 相关能力在 9.3 作为扩展方向 | — |

> `cmd/debug/bt.go` 里的 `bt` 桩与 `backtrace` 的 `bt` 别名冲突，正常输入 `bt` 会命中 `backtrace`，而 `stack` 会命中桩；这个桩属于待清理代码，详见 `godbgv2/docs/FEATURE-MATRIX.md` §11。

#### 源码与符号

| 命令 | 别名 | 状态 | 说明 | 代码定位 |
| --- | --- | --- | --- | --- |
| `list` | `ls`、`l` | ✅ | 按当前上下文或 locspec 展示源码，±5 行、`=>` 标当前行 | `cmd/debug/list.go`、`pkg/proc/source.go` |
| `disass` | `dis`、`disassemble` | ✅ | 反汇编；`--count`、`--syntax`、`--clearall` | `cmd/debug/disass.go`、`pkg/target/disassemble.go` |
| `funcs` | `fn` | ✅ | 按正则列出函数（名称/入口；`Function` 有声明位置字段，但批量路径未填、命令不打印） | `cmd/debug/funcs.go` |
| `types` | — | ❌ | 未实现 | — |
| `libraries` | — | ❌ | 未实现；动态库支持不在本书范围 | — |
| `sources` | — | ❌ | 未实现 | — |

#### 会话与其他

| 命令 | 别名 | 状态 | 说明 | 代码定位 |
| --- | --- | --- | --- | --- |
| `exit` | `quit`、`q` | ✅ | 退出调试会话，按启动方式执行清理（kill/detach） | `cmd/debug/exit.go`、`cmd/debug/shell.go` |
| `help` | `h` | ✅ | 按分组显示命令帮助 | `cmd/debug/shell.go` |
| `core`（顶层） | — | 🅿️ | 解析后端已有，命令未接线 | `cmd/core.go`、`pkg/proc/core/core.go` |
| `source` | — | 🚫 | 没有通用 `source`；只有 `--init` 批量回放（测试用） | `cmd/debug/shell.go` 的 `replay()` |
| `config` / `edit` / `dump` / `rebuild` | — | 🚫 | 本书不做；相关设计见 9.3 | — |

### 还需要注意什么

做一个产品需要注重用户体验，做一个调试器也一样。我们梳理了这么多调试命令，正是关注产品体验的体现。但命令并不是越多越好：基于命令行的调试器，命令太多反而会增加记忆和输入负担。除了功能本身，还要特别注意以下几点：

- 简化命令行输入，尤其是需要连续多次输入的情况；
- 方便查看命令帮助，相关命令合理分组，编写精简有用的帮助信息；
- 方便观测多个变量，如执行期间观察、命中断点时观察；
- 保证健壮性：调试器崩溃、tracee 崩溃、DWARF 数据不兼容等问题应尽早暴露，避免浪费开发者时间。

#### 调试器的易用性

##### 调试命令众多，需要降低记忆、使用成本

- 调试命令有学习成本，命令行调试器比 GUI 调试器曲线更陡；
- 命令行调试器需要考虑输入效率：GUI 里点一下就能加的断点，命令行需要显式给出位置，如 `break main.go:15`、`break main.main`；
- 需要命令/参数补全、别名、历史记录。godbgv2 用 cobra + liner 实现了命令名与别名补全、单会话历史、回车重复上一条命令；参数级补全（函数名、变量名）尚未实现；
- 每个命令、参数都应有 `help` 信息，用户可以通过 `help cmd` 查看用法。

##### 命令行调试器需要能同时显示多个观测值

- 命令行 UI 基于终端文本模式，不能像 GUI 那样同时铺开源码、断点、变量、寄存器、调用栈；
- 但调试器仍应提供类似能力，让用户执行 `next`/`step` 后能观测到多个变量、寄存器状态，且刷新耗时要短。

#### 调试器的扩展性

##### 命令、选项的扩展要有良好简洁的支持

- 调试器有多种启动方式，对应多个启动命令（`exec`、`debug`、`attach`、`core`、`connect`），各有不同参数；会话内又有 `break`、`condition`、`trace` 等命令。如何可扩展地管理这些命令及选项，需要仔细考虑；
- 选项尽量遵循 GNU/POSIX 风格，在消除歧义的前提下同时支持长选项、短选项。

##### 调试器应满足个性化定义

- 允许用户自定义命令别名、配置输出格式等，是提升体验的方向；godbgv2 目前只支持 liner 的内存历史与命令补全，没有配置文件系统（见 9.3.107）。

##### 跨平台、支持不同调试后端、支持与 IDE 集成

- 需要考虑将来扩展到 Darwin/Windows、arm64 等平台，设计时应做必要的抽象；
- 需要考虑与 GoLand、VSCode 等 IDE 集成，或远程调试场景；
- 某些能力可以借助其他调试器实现（如 Mozilla rr 的录制重放、反向调试），这要求前后端分离且后端接口可替换。godbgv2 目前只有 native backend，`--backend`/rr 都是扩展方向，见 9.3.110。

#### 调试器的健壮性

- 调试器依赖操作系统能力（如 Linux ptrace），ptrace attach 后的 tracee 后续 ptrace 请求必须来自同一个 tracer；`wait4` 等系统调用还有平台特殊性，调试器应做兼容处理；
- Go 调试器依赖 Go 工具链生成的调试信息，不同 Go 版本的 DWARF 表示、信号处理可能有差异，应限制支持的 Go 版本或在版本不匹配时明确报错。

非功能性需求很多，从易用性、命令管理的可维护性、选型规范性，到跨平台/多 backend 扩展、自身健壮性，都会影响一个调试器能否被接受。

### 本节小结

本节是对第 9 章符号级调试器 godbgv2 的功能型需求与非功能性需求的总体分析：哪些命令已经可用、哪些只是桩、哪些是本书有意不做。后面的小节会按 tag 逐个展开实现，读者可以把本节当作「能力地图」，也可以把 `godbgv2/docs/FEATURE-MATRIX.md` 当作更细的对照表。接下来进入具体命令的设计实现，Let's Go！
