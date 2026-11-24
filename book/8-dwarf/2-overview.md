## DWARF内容概览

DWARF v4 的标准文档有三百余页，涵盖类型、作用域、行号、栈帧、宏等多类数据；篇幅之外，真正的难点在于它要用同一套格式支持不同语言、编译器和硬件平台，并为各语言及其工具链特有的语义留出扩展空间。这些差异最终被编码进 tag、attribute 和若干张表，可扩展性也因此成为 DWARF 复杂度的主要来源之一。DWARF 因此远不只是一张枚举值清单，而是一套用于描述语言构造和平台差异的抽象机制。对不熟悉软件调试领域的开发者，无论经验深浅，都很难看清整体结构。

本章后续的安排是：8.3 按用途对调试数据分类，8.4 详细展开 DIE，8.5 介绍行号表、调用帧信息及其他调试数据。分类便于查阅，但仅凭“DIE 树、行号表、CFI”这几个名词，仍难以建立具体的印象。

所以在深入具体的数据结构之前，先给出一个概览，帮助读者理清主要脉络。本节不展开细节，只以一段二十余行的 Go 程序为例，将源码、AST、DIE 树三种表示并列对照，为后续各节的概念提供一个可复现的实例。

### 块结构与 DIE 树

大多数现代编程语言采用块结构：一个文件可以包含多个类型、变量、常量和函数，函数内可以定义变量并包含语句，语句中可以嵌套复合语句。这些构造中，复合类型由基本类型及其他复合类型逐层组合而成；变量和常量也都带有类型。块结构划定了词法作用域——名字只在定义它的块中可见；名称解析从当前块开始逐层向外，第一个匹配的定义即为该名字的绑定，因此不同块中允许出现同名变量，内层名字遮蔽外层。编译器据此把程序表示为树。

DWARF 沿用这一模型。调试信息条目（DIE, Debugging Information Entry）本身也按块结构组织：每个 DIE 可以嵌套在父 DIE 中，也可以有兄弟 DIE，树上的节点表示类型、变量、常量或函数。因此一个程序的 DWARF 数据同样是一棵树，其结构与编译器内部的语法树相近，但记录的信息更多：除父子嵌套关系外，还包括地址、位置描述和类型引用。类型之间的组合关系，以及变量、常量与类型之间的关联，都通过类型引用表达。

调试器依赖这一结构。程序在断点处中断时，哪些变量应出现在 `vars` 中、哪些尚未进入作用域，取决于名字所属的块和当前执行位置所在的块，判断依据正是 DIE 树。

### 同一份程序的三种表示

#### 源码：块与作用域

```go
 1  package main
 2
 3  import "fmt"
 4
 5  var greeting = "hello"
 6
 7  type Greeter struct {
 8      name string
 9  }
10
11  func (g Greeter) greet(n int) {
12      msg := g.name + ", " + greeting
13      if n > 1 {
14          msg += "!"
15      }
16      for i := 0; i < n; i++ {
17          fmt.Println(msg, i)
18      }
19  }
20
21  func main() {
22      g := Greeter{name: "dwarf"}
23      g.greet(2)
24  }
```

（行号为便于下文引用而添加，实际代码不含行号。）

各层块对应不同的作用域：

```text
package main                        ← 包作用域：greeting、Greeter、greet、main
├── func (g Greeter) greet(n int)   ← 函数作用域：g、n、msg
│   ├── if n > 1 { ... }            ← 块作用域：没有引入新名字
│   └── for i := 0; ...             ← 块作用域：i
└── func main()                     ← 函数作用域：g
```

#### AST：语法层面的块

编译器前端把源码解析成抽象语法树（AST），每个块对应一个节点：

```text
*ast.File  main.go
├── *ast.GenDecl (import)                L3
├── *ast.GenDecl (var)                   L5
│   └── *ast.ValueSpec  greeting         L5
├── *ast.GenDecl (type)                  L7
│   └── *ast.TypeSpec  Greeter           L7
│       └── *ast.StructType              L7
├── *ast.FuncDecl  Greeter.greet         L11
│   └── *ast.BlockStmt                   L11
│       ├── *ast.AssignStmt  msg := ...  L12
│       ├── *ast.IfStmt                  L13
│       │   └── *ast.BlockStmt           L13
│       │       └── *ast.AssignStmt      L14
│       └── *ast.ForStmt                 L16
│           └── *ast.BlockStmt           L16
│               └── *ast.ExprStmt        L17
└── *ast.FuncDecl  main                  L21
    └── *ast.BlockStmt                   L21
        ├── *ast.AssignStmt  g := ...    L22
        └── *ast.ExprStmt                L23
```

（仅保留结构性节点，省略表达式、字面量等节点。）

AST 描述**语法**，不描述**语义**。`if` 后的一对花括号即使为空，也对应一个 `BlockStmt`；`msg` 所在的 AST 节点只说明它写在哪个块中，不说明它最终被分配到栈上的位置，也不说明其类型。AST 是编译过程中的中间表示，编译器不会把它写入二进制。

在线查看 AST 可以使用 [AST Explorer](https://astexplorer.net/)：语言选择 `go`，粘贴上述代码，页面右侧即显示对应的 Go 语法树。

#### DIE：调试信息中的块

机器码中不保留块结构。编译器在生成机器码的同时，会把本编译单元的程序结构写入调试信息；链接器再合并各编译单元的记录、解析跨编译单元的引用，最终写入可执行文件。在 DWARF 中，这份结构由 DIE 树表示。

将上述程序编译为二进制，禁用优化和内联（使 DIE 结构与源码的作用域保持一致），再读取 `.debug_info`：

```bash
# 以 go1.24 为基线，产物为 DWARF v4
go build -gcflags='-N -l' -o greet main.go
readelf --debug-dump=info greet | less
```

> go1.25 及之后的工具链默认生成 DWARF v5；此时需要给 `go build` 加上 `GOEXPERIMENT=nodwarf5`，产物才是 v4。

下面是 `main` 编译单元（CU）的一部分。`readelf` 的原始输出按偏移量平铺排列，这里按 DIE 层级重新缩进；尖括号内第一个数为 DIE 所在的层级，第二个数为该 DIE 在 `.debug_info` 中的偏移量。每个 DIE 的属性不止于此，此处只保留后文用到的部分：

```text
<0><1a126>  DW_TAG_compile_unit  DW_AT_name: main
│
├─<1><1a16a>  DW_TAG_subprogram  DW_AT_name: main.Greeter.greet
│  ├─<2><1a196>  DW_TAG_formal_parameter  DW_AT_name: g  DW_AT_type: <0xb8669>
│  ├─<2><1a1a3>  DW_TAG_formal_parameter  DW_AT_name: n  DW_AT_type: <0x9ac48>
│  ├─<2><1a1b0>  DW_TAG_variable  DW_AT_name: msg  DW_AT_type: <0x9ad1e>  DW_AT_location: DW_OP_fbreg: -112
│  └─<2><1a1be>  DW_TAG_lexical_block  DW_AT_low_pc: 0x49e237  DW_AT_high_pc: 0x49e33b
│     └─<3><1a1cf>  DW_TAG_variable  DW_AT_name: i  DW_AT_type: <0x9ac48>
├─<1><1a1dd>  DW_TAG_subprogram  DW_AT_name: main.main
│  └─<2><1a200>  DW_TAG_variable  DW_AT_name: g
└─<1><1a21e>  DW_TAG_variable  DW_AT_name: main.greeting  DW_AT_location: DW_OP_addr: 0x57e1b0

（这两个 DIE 不在 main 的 CU 内，而在链接器汇总的类型区——从 0x9a2e9 开始、名为 runtime 的 CU；前面 g 的 DW_AT_type: <0xb8669> 指向此处）
<1><b8669>  DW_TAG_typedef  DW_AT_name: main.Greeter  DW_AT_type: <0xb8644>
└─<2><b8644>  DW_TAG_structure_type  DW_AT_name: main.Greeter  DW_AT_byte_size: 16
   └─<3><b865c>  DW_TAG_member  DW_AT_name: name  DW_AT_data_member_location: 0  DW_AT_type: <0x9ad1e>
```

这两个类型 DIE 落在 `runtime` CU，是当前 Go 链接器生成类型信息的实现方式：类型 DIE 由链接器根据程序用到的类型生成、去重，再统一追加到 `runtime` 的 CU 中，而不是随各自的编译单元存放。这是 Go 工具链的实现选择，不是 DWARF 标准的要求；把类型 DIE 的生成移到编译器的方案见 [golang/go#52209](https://github.com/golang/go/issues/52209)，该 issue 目前仍未关闭，方案尚未落地。

> 本节输出来自 go1.26.7，构建时加了 `GOEXPERIMENT=nodwarf5`，产物为 DWARF v4。编译器版本不同，偏移量和地址会变化，但树的结构不变。

三种表示的对应关系如下：

| 源码中的构造 | AST 节点 | DIE |
| --- | --- | --- |
| 一个源文件 | `*ast.File` | `DW_TAG_compile_unit` |
| 函数、方法 | `*ast.FuncDecl` | `DW_TAG_subprogram` |
| 参数、接收者 | `*ast.Field` | `DW_TAG_formal_parameter` |
| 局部变量、包级变量 | `*ast.AssignStmt`、`*ast.ValueSpec` | `DW_TAG_variable` |
| 常量 | `*ast.ValueSpec`（`const`） | `DW_TAG_constant` |
| 块 | `*ast.BlockStmt` | `DW_TAG_lexical_block` |
| 类型定义 | `*ast.TypeSpec` | `DW_TAG_typedef`、`DW_TAG_structure_type` |

源码面向开发者，AST 面向编译器，DIE 面向调试器。三者描述同一种程序结构，只是读者不同，需要记录的信息也不同。

但三种表示并不等价。`if` 与 `for` 各是一个内层块，AST 中两个 `BlockStmt` 都存在，DIE 树中却只有一个 `lexical_block`——`if` 块没有引入新名字，因此没有对应的 DIE；DIE 中的块还带有各自的地址区间（`DW_AT_low_pc`、`DW_AT_high_pc`），调试器据此判断名字在该区间内是否可见；`DW_AT_type` 这类属性则是指向别处的偏移量，其目标可能不在当前编译单元内。这三点分别见 8.4.3、8.4.2、8.4.1，本节不展开。

### 树与表

DIE 树描述了程序的静态结构：有哪些编译单元、函数、变量和类型，它们如何嵌套，每个名字在哪个地址区间有效，运行时从何处取值。调试器还需要回答另外两个问题，DIE 树无法提供：

- 当前指令对应源码的哪一行？DIE 只给出函数和块的地址区间，指令与源码行的逐条对应由**行号表**（`.debug_line`）提供；
- 当前函数由谁调用、上一帧位于何处？这由**调用帧信息**（CFI，`.debug_frame`）提供。

这两类数据都是表而非树；为节省空间，它们被编码为字节码程序，由状态机执行后才能得到完整的表（8.5）。连同加速访问表（`.debug_aranges`、`.debug_pubnames`、`.debug_pubtypes`）和宏信息（`.debug_macinfo`/`.debug_macro`），DWARF 的内容可以概括为“一棵树加几张表”。

### 可扩展、与文件格式无关

DWARF 允许以新增 tag、attribute 的方式扩展 DIE，而不必另立一种格式；调试器遇到不认识的扩展可以忽略，而不像多数其他调试格式那样，遇到未知数据便直接报错。这也使 DWARF 能够持续支持新的语言和语言特性，不受特定架构和字节序的限制。

DWARF 最初为 ELF 设计，但其设计允许扩展到其他对象文件格式。如今它是最广泛使用的调试信息格式，这得益于其标准化程度、描述完备性和持续演进；其他调试信息格式与 DWARF 的关系见本章开头及附录 12.16。

### 参考文献

1. DWARF, https://en.wikipedia.org/wiki/DWARF
2. DWARFv1, https://dwarfstd.org/doc/dwarf_1_1_0.pdf
3. DWARFv2, https://dwarfstd.org/doc/dwarf-2.0.0.pdf
4. DWARFv3, https://dwarfstd.org/doc/Dwarf3.pdf
5. DWARFv4, https://dwarfstd.org/doc/DWARF4.pdf
6. DWARFv5, https://dwarfstd.org/doc/DWARF5.pdf
7. DWARFv6 draft, https://dwarfstd.org/languages-v6.html
8. Introduction to the DWARF Debugging Format, https://dwarfstd.org/doc/Debugging-using-DWARF-2012.pdf
