## 扩展阅读：Go编译器简介

`cmd/compile` 包含构成Go编译器的主要包。编译器逻辑上可分为四个阶段，我们将简要描述每个阶段，并列出包含其代码的包列表。

您可能听到过"前端（front-end）"和"后端（back-end）"这两个术语。粗略地说，它们对应我们列出的前两个阶段和后两个阶段。第三个术语"中端（middle-end）"通常指第二阶段中进行的大部分工作。

请注意，`go/*` 系列包（如 `go/parser` 和 `go/types`）主要由编译器内部API使用。由于编译器最初是用C语言编写的，`go/*` 包被开发用于编写处理Go代码的工具（如 `gofmt` 和 `vet`）。然而，随着时间推移，编译器的内部API已逐渐演变为更符合 `go/*` 包用户的习惯。

需要澄清的是，"gc"代表"Go编译器"，与表示垃圾回收的大写"GC"无关。

### 1. 解析（Parsing）

* `cmd/compile/internal/syntax`（词法分析器、语法分析器、语法树）

编译的第一阶段将源代码进行分词（词法分析）、解析（语法分析），并为每个源文件构建语法树。

每个语法树都是相应源文件的精确表示，节点对应源代码的各种元素（如表达式、声明和语句）。语法树还包含位置信息，用于错误报告和调试信息生成。

### 2. 类型检查（Type checking）

* `cmd/compile/internal/types2`（类型检查）

`types2` 包是将 `go/types` 移植到使用 `syntax` 包的AST而非 `go/ast` 的版本。

### 3. 中间表示构建（IR construction, "noding"）

* `cmd/compile/internal/types`（编译器类型）
* `cmd/compile/internal/ir`（编译器AST）
* `cmd/compile/internal/noder`（创建编译器AST）

编译器中端使用自己的AST定义和Go类型表示（源自C语言版本）。类型检查后的下一步是将 `syntax` 和 `types2` 表示转换为 `ir` 和 `types`。此过程称为"noding"。

使用称为统一IR（Unified IR）的技术构建节点表示，该技术基于第2阶段类型检查代码的序列化版本。统一IR还参与包的导入导出和内联优化。

### 4. 中端优化（Middle end）

* `cmd/compile/internal/inline`（函数调用内联）
* `cmd/compile/internal/devirtualize`（已知接口方法调用的虚函数消除）
* `cmd/compile/internal/escape`（逃逸分析）

对IR表示执行多个优化过程：

- 死代码消除
- （早期）虚函数消除
- 函数调用内联
- 逃逸分析

早期死代码消除集成在统一IR写入阶段。

### 5. 遍历（Walk）

* `cmd/compile/internal/walk`（求值顺序、解糖）

对IR表示的最后一步处理是"walk"，其作用包括：

1. 将复杂语句分解为简单语句，引入临时变量并保持求值顺序（也称为"order"阶段）
2. 将高级Go构造解糖为原始形式。例如：
   - `switch` 语句转换为二分查找或跳转表
   - map和channel操作替换为运行时调用

### 6. 通用SSA（Generic SSA）

* `cmd/compile/internal/ssa`（SSA传递和规则）
* `cmd/compile/internal/ssagen`（将IR转换为SSA）

在此阶段，IR被转换为静态单赋值（SSA）形式，这是一种具有特定属性的低级中间表示，便于实现优化和最终生成机器码。

转换过程中应用函数内联（intrinsics）——编译器针对特定情况用高度优化的代码替换的特殊函数。某些节点也会降级为更简单的组件（例如 `copy` 内置函数替换为内存移动，`range` 循环重写为 `for` 循环）。出于历史原因，部分转换目前发生在SSA转换之前，但长期计划是将所有转换集中于此阶段。

随后执行一系列与机器无关的传递和规则，包括：

- 死代码消除
- 删除冗余的空指针检查
- 删除未使用的分支

通用重写规则主要涉及表达式优化，例如用常量替换某些表达式，优化乘法和浮点运算。

### 7. 生成机器码（Generating machine code）

* `cmd/compile/internal/ssa`（SSA降级和架构相关传递）
* `cmd/internal/obj`（机器码生成）

编译器的机器相关阶段从"降级（lower）"传递开始，将通用值重写为其机器特定变体。例如，在amd64架构上允许内存操作数，因此许多加载-存储操作可以合并。

请注意，降级传递运行所有机器特定重写规则，因此当前也执行大量优化。

一旦SSA被"降级"并针对目标架构具体化，将运行最终代码优化传递，包括：

- 另一次死代码消除
- 将值移近使用位置
- 删除从未读取的局部变量
- 寄存器分配

此步骤的其他重要工作包括：

- 栈帧布局（为局部变量分配栈偏移）
- 指针存活分析（计算每个GC安全点上栈上指针的存活状态）

SSA生成阶段结束时，Go函数已转换为一系列 `obj.Prog` 指令。这些指令传递给汇编器（`cmd/internal/obj`），后者将其转换为机器码并输出最终目标文件。目标文件还将包含反射数据、导出数据和调试信息。

### 7a. 导出（Export）

除了为链接器编写目标文件外，编译器还为下游编译单元编写"导出数据"文件。导出数据包含编译包P时计算的以下信息：

- 所有导出声明的类型信息
- 可内联函数的IR
- 可能在其他包实例化的泛型函数的IR
- 函数参数逃逸分析结果的摘要

导出数据格式经历多次迭代，当前版本称为"统一格式"（unified），它是对象图的序列化表示，带有允许延迟解码部分内容的索引（因为大多数导入仅用于提供少数符号）。

GOROOT仓库包含统一格式的读取器和写入器；它从/向编译器的IR进行编码和解码。`golang.org/x/tools` 仓库也为导出数据读者提供公共API（使用 `go/types` 表示），始终支持编译器的当前文件格式和少量历史版本。（`x/tools/go/packages` 在需要类型信息但不需要带类型注释的语法模式中使用它。）

`x/tools` 仓库还为使用旧版"索引格式"的导出类型信息（仅限类型信息）提供公共API。（例如，`gopls` 使用此版本存储工作区信息数据库，其中包括类型信息。）

导出数据通常提供"深度"摘要，因此编译包Q只需读取每个直接导入的导出数据文件，即可确保这些文件提供间接导入（如P的公共API中引用的类型的方法和结构字段）的所有必要信息。深度导出数据简化了构建系统，因为每个直接依赖只需要一个文件。然而，当处于大型仓库的导入图较高层时，这会导致导出数据膨胀：如果有常用类型具有大型API，几乎每个包的导出数据都会包含副本。这一问题推动了"索引"设计的发展，该设计允许按需部分加载。

### 8. 实用技巧

#### 入门指南

* 如果您从未贡献过编译器，简单的方法是在感兴趣的位置添加日志语句或 `panic("here")` 以初步了解问题。
* 编译器本身提供日志、调试和可视化功能：
  ```bash
  $ go build -gcflags=-m=2                   # 打印优化信息（包括内联、逃逸分析）
  $ go build -gcflags=-d=ssa/check_bce/debug # 打印边界检查信息
  $ go build -gcflags=-W                     # 打印类型检查后的内部解析树
  $ GOSSAFUNC=Foo go build                   # 为函数Foo生成ssa.html文件
  $ go build -gcflags=-S                     # 打印汇编代码
  $ go tool compile -bench=out.txt x.go      # 打印编译器阶段的计时信息
  ```
* 部分标志会改变编译器行为，例如：
  ```bash
  $ go tool compile -h file.go               # 遇到第一个编译错误时恐慌
  $ go build -gcflags=-d=checkptr=2          # 启用额外的unsafe指针检查
  ```
* 更多标志详情可通过以下方式获取：
  ```bash
  $ go tool compile -h              # 查看编译器标志（如 -m=1 -l）
  $ go tool compile -d help         # 查看调试标志（如 -d=checkptr=2）
  $ go tool compile -d ssa/help     # 查看SSA标志（如 -d=ssa/prove/debug=2）
  ```
#### 测试修改

* 请务必阅读 [快速测试修改](https://go.dev/doc/contribute#quick_test) 部分。
* 部分测试位于 `cmd/compile` 包内，可通过 `go test ./...` 运行，但许多测试位于顶级 [test](https://github.com/golang/go/tree/master/test) 目录：

  ```bash
  $ go test cmd/internal/testdir                           # 运行'test'目录所有测试
  $ go test cmd/internal/testdir -run='Test/escape.*.go'   # 运行特定模式的测试
  ```

  详情参见 [testdir README](https://github.com/golang/go/tree/master/test#readme)。
  `testdir_test.go` 中的 `errorCheck` 方法有助于解析测试中使用的 `ERROR` 注释。
* 新的 [基于应用的覆盖率分析](https://go.dev/testing/coverage/) 可用于编译器：

  ```bash
  $ go install -cover -coverpkg=cmd/compile/... cmd/compile  # 构建带覆盖率检测的编译器
  $ mkdir /tmp/coverdir                                      # 选择覆盖率数据存放位置
  $ GOCOVERDIR=/tmp/coverdir go test [...]                   # 使用编译器并保存覆盖率数据
  $ go tool covdata textfmt -i=/tmp/coverdir -o coverage.out # 转换为传统覆盖率格式
  $ go tool cover -html coverage.out                         # 通过传统工具查看覆盖率
  ```
#### 处理编译器版本

* 许多编译器测试使用 `$PATH` 中的 `go` 命令及其对应的 `compile` 二进制文件。
* 如果您在分支中且 `$PATH` 包含 `<go-repo>/bin`，执行 `go install cmd/compile` 将使用分支代码构建编译器，并安装到正确位置，以便后续 `go` 命令使用新编译器。
* [toolstash](https://pkg.go.dev/golang.org/x/tools/cmd/toolstash) 提供保存、运行和恢复Go工具链已知良好版本的功能。例如：

  ```bash
  $ go install golang.org/x/tools/cmd/toolstash@latest
  $ git clone https://go.googlesource.com/go
  $ cd go
  $ git checkout -b mybranch
  $ ./src/all.bash               # 构建并确认良好起点
  $ export PATH=$PWD/bin:$PATH
  $ toolstash save               # 保存当前工具链
  ```

  之后编辑/编译/测试循环类似：

  ```bash
  <... 修改cmd/compile源码 ...>
  $ toolstash restore && go install cmd/compile   # 恢复已知良好工具链构建编译器
  <... 'go build', 'go test', etc. ...>           # 使用新编译器进行测试
  ```
* `toolstash` 还允许比较已安装与存储版本的编译器，例如验证重构后行为一致性：

  ```bash
  $ toolstash restore && go install cmd/compile   # 构建最新编译器
  $ go build -toolexec "toolstash -cmp" -a -v std # 比较新旧编译器生成的std库
  ```
* 如果版本不同步（例如出现 `linked object header mismatch` 错误），可执行：

  ```bash
  $ toolstash restore && go install cmd/...
  ```
#### 其他有用的工具

* [compilebench](https://pkg.go.dev/golang.org/x/tools/cmd/compilebench) 用于基准测试编译器速度。
* [benchstat](https://pkg.go.dev/golang.org/x/perf/cmd/benchstat) 是报告编译器修改性能变化的标准工具：
  ```bash
  $ go test -bench=SomeBenchmarks -count=20 > new.txt   # 使用新编译器测试
  $ toolstash restore                                   # 恢复旧编译器
  $ go test -bench=SomeBenchmarks -count=20 > old.txt   # 使用旧编译器测试
  $ benchstat old.txt new.txt                           # 对比结果
  ```
* [bent](https://pkg.go.dev/golang.org/x/benchmarks/cmd/bent) 可方便地在Docker容器中运行社区Go项目的基准测试集。
* [perflock](https://github.com/aclements/perflock) 通过控制CPU频率等手段提高基准测试一致性。
* [view-annotated-file](https://github.com/loov/view-annotated-file) 可将内联、边界检查和逃逸信息叠加显示在源代码上。
* [godbolt.org](https://go.godbolt.org) 广泛用于查看和分享汇编输出，支持比较不同Go编译器版本的汇编代码。

---

### 进阶阅读

如需深入了解SSA包的工作原理（包括其传递和规则），请参阅 [cmd/compile/internal/ssa/README.md](internal/ssa/README.md)。

如果本文档介绍或SSA README有任何不清楚之处，或您有改进建议，请在 [issue 30074](https://go.dev/issue/30074) 中留言。
