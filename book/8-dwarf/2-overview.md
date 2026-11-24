## DWARF内容概览

8.3 会把 DWARF 的数据分成几类，8.4 讲 DIE，8.5 讲行号表、调用栈帧这些表。分类表方便回头查，却不容易建立直觉——只看“DIE 树、行号表、CFI”几个名词，很难想象 DWARF 到底长什么样。这一节不铺开细节，只拿一段二十几行的 Go 程序，把源码、AST、DIE 树三张图并排摆出来。看懂了这三张图，后面几节的名词才有地方挂。

### 先看源码：块就是作用域

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

（行号只是为了下文引用方便，实际代码把每行开头的行号去掉即可。）

这些块一层套一层：

```text
package main                        ← 包作用域：greeting、Greeter、greet、main
├── func (g Greeter) greet(n int)   ← 函数作用域：g、n、msg
│   ├── if n > 1 { ... }            ← 块作用域：没有引入新名字
│   └── for i := 0; ...             ← 块作用域：i
└── func main()                     ← 函数作用域：g
```

块结构就是作用域。查一个名字，从当前块开始由内向外找，第一个匹配的就是它；不同块里可以有同名变量，内层遮蔽外层。这不是 DWARF 的规定，C、C++、Java、Go 这些语言都是如此，DWARF 只是把这个结构换了一种形式又记了一遍。

调试器很在意这件事。断点停在 L17 时，`g`、`n`、`msg`、`i` 都在作用域内，`vars` 命令应该把它们都列出来；如果停在 L14，`i` 还没出生，就不该列。调试器要给出这份正确的名单，就得知道“名字挂在哪个块上”，以及“当前执行位置在哪个块里”。

### 再看 AST：编译器眼里的块

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

（只画了结构性的节点，表达式、字面量这些节点省掉了。）

想亲手点开看，最省事的是 [AST Explorer](https://astexplorer.net/)：语言选 `go`，把上面那段代码贴进去，右侧就是 Go 语法树。它和本节手画的骨架是同一棵，只是表达式、字面量这些节点也展开了。

不想开浏览器，用 Go 标准库打印也只有三行：

```go
// imports: go/ast, go/parser, go/token
fset := token.NewFileSet()
f, _ := parser.ParseFile(fset, "main.go", nil, 0)
ast.Print(fset, f) // 输出很长，只保留结构节点就是上面那棵树
```

要留意 AST 的本质：它描述**语法**，不描述**语义**。`if` 后面一对花括号就是一个 `BlockStmt`，哪怕里面一行代码都没有；`msg` 挂在哪个节点下面，只说明它写在哪个块里，不说明它最后被分配到栈上哪个位置、类型是什么。AST 是编译过程中的中间物，编译器不会把它写进二进制。

### 再看 DIE：编译器留下的块

机器码里当然没有花括号。编译器在生成代码的同时，会把程序结构另写一份，这就是调试信息。DWARF 里这份结构的每个节点叫**调试信息条目**（DIE, Debugging Information Entry），节点有父子之分，所以 DIE 天然是一棵树。

把上面的程序编译出来，关掉优化和内联，让变量老老实实待在自己的块里，再来读 `.debug_info`：

```bash
# go1.24 及更早的版本不需要 GOEXPERIMENT
GOEXPERIMENT=nodwarf5 go build -gcflags='-N -l' -o greet main.go
readelf --debug-dump=info greet | less
```

下面是 `main` 这个编译单元的一部分。缩进是我按 DIE 层级重排的，`readelf` 的原始输出是按偏移量排列的平铺文本；尖括号里的两个数，前者是层级、后者是 DIE 在 `.debug_info` 里的偏移量。每个 DIE 的属性远不止这些，只保留了下文要用的：

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
```

> 本节输出来自 go1.26.7，用 `GOEXPERIMENT=nodwarf5` 强制生成 DWARF v4（与本书基线一致）。换个编译器版本，偏移量和地址都会变，但树的结构不变。

把三张图叠在一起，对应关系很清楚：

| 源码里的东西 | AST 节点 | DIE |
| --- | --- | --- |
| 一个源文件 | `*ast.File` | `DW_TAG_compile_unit` |
| 函数、方法 | `*ast.FuncDecl` | `DW_TAG_subprogram` |
| 参数、接收者 | `*ast.Field` | `DW_TAG_formal_parameter` |
| 局部变量、包级变量 | `*ast.AssignStmt`、`*ast.ValueSpec` | `DW_TAG_variable` |
| 块 | `*ast.BlockStmt` | `DW_TAG_lexical_block` |
| 类型定义 | `*ast.TypeSpec` | `DW_TAG_typedef`、`DW_TAG_structure_type` |

源码是给人看的，AST 是给编译器看的，DIE 是给调试器看的。三者描述的是同一个骨架，只是服务的读者不同，需要记下的信息也不同。

### 骨架一样，内容不同

骨架对得上，但三张图不能划等号：DIE 比 AST 多了地址、位置和引用，少了表达式层面的语法细节。下面三处差别，刚好对应后面要展开的内容。

**一、块不是一一对应的。** 源码里 `if`、`for` 各是一个内层块，AST 里两个 `BlockStmt` 都在，DIE 树里却只有一个 `lexical_block`——`for` 那个，`if` 那个不见了。

这不是 `readelf` 漏了。DWARF 并没有规定每个花括号都要对应一个 DIE：`lexical_block` 是给名字划范围的，不是语法结构的复刻。Go 编译器的做法很直接，块里没有变量就不生成 DIE，块里的东西直接挂到外层（生成 DIE 的 `putscope` 函数里，遇到没有变量的 scope 就直接跳过）。不妨动手验证：在 `if` 块里声明一个变量并让它派上用场，重新编译、重新 dump，`if` 的位置就会多出一个 `lexical_block`；如果新块外面还套着没有变量的块，新块还会被提到函数这一层。

原因不难猜：没有新名字的块，不需要在 DWARF 里留下痕迹。调试器也不必知道“这里有一对花括号”，它只需要知道“这个名字在这个地址区间里有效”。

**二、块在 DWARF 里带地址。** `DW_TAG_lexical_block` 带着 `DW_AT_low_pc`、`DW_AT_high_pc` 两个属性（这里是 `0x49e237` 到 `0x49e33b`），给出这个块“活着”的指令区间。调试器判断 `i` 当前可不可见，看的是 PC 落不落在这个区间里，而不是树的缩进。如果一个块对应的指令不连续（比如循环的初始化、循环体、回边分开排布），这两个属性会换成一个 `DW_AT_ranges`。

AST 里没有地址，因为那会儿还没有地址可填；DIE 是编译、链接都完成之后才定稿的，所以填得进去。同一类属性还有 `DW_AT_location`：它说 `msg` 在栈帧里相对 frame base 偏移 -112 的位置；像 `g`、`n` 这样的参数更麻烦，`DW_AT_location` 指向的是一张位置列表（`0x10275`），因为优化之后一个变量在函数的不同位置可能待在寄存器或不同的栈槽里。位置表达式和位置列表是 8.4.2 的主题。

**三、树上有引用，树其实是图。** `msg` 的 `DW_AT_type` 写的是 `<0x9ad1e>`，一个 `.debug_info` 里的偏移量，指向描述类型的 DIE。注意这个数：上面这棵树里最大的偏移量才 `0x1a21e`，而 `0x9ad1e` 远在它之外——`main.Greeter`、`string` 这些类型 DIE 根本不在 `main` 的编译单元里。链接器会把各目标文件里的调试信息合并、安排（8.6 展开），变量只要用偏移量指过去就行。

所以 DIE 之间除了父子关系，还有这种跨节点的引用。读 DWARF 的代码，基本就是两件事：顺着树往下走，遇到引用跳到另一个 DIE。

### 一棵树，几张表

DIE 树能回答：程序里有哪些编译单元、函数、变量、类型，它们怎么嵌套，每个名字在哪个地址区间有效、运行时到哪里去取。但调试器还要回答两个问题，这棵树答不了：

- 当前这条指令对应源码的哪一行？DIE 只给出函数和块的地址范围，一行一行地对应要靠**行号表**（`.debug_line`）；
- 当前函数是谁调用的、上一层的帧在哪？要靠**调用栈帧信息**（CFI，`.debug_frame`）。

这两样都不是树，而是表；为了省空间，它们都被编码成字节码，交给状态机执行才能得到真正的表（8.5）。再加上加速访问表、宏信息这些辅助数据，DWARF 的全貌可以概括成“一棵树 + 几张表”。

8.3 给出完整的数据分类，8.4 拆这棵树，8.5 讲这些表。

### 参考文献

1. DWARF, https://en.wikipedia.org/wiki/DWARF
2. DWARFv1, https://dwarfstd.org/doc/dwarf_1_1_0.pdf
3. DWARFv2, https://dwarfstd.org/doc/dwarf-2.0.0.pdf
4. DWARFv3, https://dwarfstd.org/doc/Dwarf3.pdf
5. DWARFv4, https://dwarfstd.org/doc/DWARF4.pdf
6. DWARFv5, https://dwarfstd.org/doc/DWARF5.pdf
7. DWARFv6 draft, https://dwarfstd.org/languages-v6.html
8. Introduction to the DWARF Debugging Format, https://dwarfstd.org/doc/Debugging-using-DWARF-2012.pdf
