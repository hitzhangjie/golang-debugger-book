## DWARF内容概览

DWARF v4 的标准文档有三百多页，按 tag、attribute 逐条读很容易迷路。这一章先给一张地图：DWARF 里到底存了哪些东西，它们彼此又是什么关系。8.3 把这些数据分成几类，8.4 拆 DIE 这棵树，8.5 讲行号表、调用栈帧这些表。分类表方便回头查，却不容易建立直觉——只看“DIE 树、行号表、CFI”几个名词，很难想象 DWARF 到底长什么样。

所以这一节不铺开细节，只拿一段二十几行的 Go 程序，把源码、AST、DIE 树三张图并排摆出来。看懂了这三张图，后面几节的名词才有地方挂。

### 块结构与 DIE 树

大多数现代编程语言都采用块结构：一个文件里可以有好几个函数，函数里可以再定义变量、写语句，语句里还能套复合语句。这就划出了词法作用域——名字只在定义它的块里可见；查一个名字，从当前块开始由内向外找，第一个匹配的就是它，不同块里可以有同名变量，内层遮蔽外层。编译器自然把程序表示成一棵树。

DWARF 沿用了同一个模型。它的调试信息条目（DIE, Debugging Information Entry）本身也是块结构的：每个 DIE 可以嵌在父 DIE 里，也可以有兄弟 DIE，树上的节点代表类型、变量或函数。所以一段程序的 DWARF 数据也是一棵树，形状和编译器内部的语法树很像——只是它记的东西更多：除了“谁套在谁里面”，还有地址、位置和类型引用。

调试器很在意这件事。断点停在某个位置时，哪些变量该出现在 `vars` 里、哪些还没出生，取决于“名字挂在哪个块上”和“当前执行位置在哪个块里”。这套判断的依据就来自 DIE 树。

### 同一份程序的三种表示

#### 源码：块就是作用域

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

这些块一层套一层，每一层就是一个作用域：

```text
package main                        ← 包作用域：greeting、Greeter、greet、main
├── func (g Greeter) greet(n int)   ← 函数作用域：g、n、msg
│   ├── if n > 1 { ... }            ← 块作用域：没有引入新名字
│   └── for i := 0; ...             ← 块作用域：i
└── func main()                     ← 函数作用域：g
```

#### AST：编译器眼里的块

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

要留意 AST 的本质：它描述**语法**，不描述**语义**。`if` 后面一对花括号就是一个 `BlockStmt`，哪怕里面一行代码都没有；`msg` 挂在哪个节点下面，只说明它写在哪个块里，不说明它最后被分配到栈上哪个位置、类型是什么。AST 是编译过程中的中间物，编译器不会把它写进二进制。

想亲手点开看，最省事的是 [AST Explorer](https://astexplorer.net/)：语言选 `go`，把上面那段代码贴进去，右侧就是 Go 语法树。

#### DIE：编译器留下的块

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

（这两个 DIE 不在 main 的 CU 里，而在链接器汇总的类型区：0x9a2e9 起、名为 runtime 的那个 CU，上面 g 的 DW_AT_type: <0xb8669> 指到这里）
<1><b8669>  DW_TAG_typedef  DW_AT_name: main.Greeter  DW_AT_type: <0xb8644>
└─<2><b8644>  DW_TAG_structure_type  DW_AT_name: main.Greeter  DW_AT_byte_size: 16
   └─<3><b865c>  DW_TAG_member  DW_AT_name: name  DW_AT_data_member_location: 0  DW_AT_type: <0x9ad1e>
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

但三张图不能划等号。`if`、`for` 各是一个内层块，AST 里两个 `BlockStmt` 都在，DIE 树里却只有一个 `lexical_block`——块里没有引入新名字，就不生成 DIE；块在 DIE 里还带着自己的地址区间（`DW_AT_low_pc`、`DW_AT_high_pc`），调试器靠它判断某个名字此刻是否可见；而 `DW_AT_type` 这类属性是一个指向别处的偏移量，指过去的地方可能根本不在这个编译单元里。这三点分别是 8.4.3、8.4.2、8.4.1 的内容，这里先不展开。

### 一棵树，几张表

DIE 树能回答：程序里有哪些编译单元、函数、变量、类型，它们怎么嵌套，每个名字在哪个地址区间有效、运行时到哪里去取。但调试器还要回答两个问题，这棵树答不了：

- 当前这条指令对应源码的哪一行？DIE 只给出函数和块的地址范围，一行一行地对应要靠**行号表**（`.debug_line`）；
- 当前函数是谁调用的、上一层的帧在哪？要靠**调用栈帧信息**（CFI，`.debug_frame`）。

这两样都不是树，而是表；为了省空间，它们都被编码成字节码，交给状态机执行才能得到真正的表（8.5）。再加上加速访问表（`.debug_pubnames`、`.debug_pubtypes`、`.debug_pubranges`）和宏信息（`.debug_macro`），DWARF 的全貌可以概括成“一棵树 + 几张表”。

### 可扩展、与文件格式无关

DWARF 允许用新的 tag、attribute 扩展 DIE，而不是另立一套格式；调试器遇到不认识的扩展可以忽略，这比大多数调试格式遇到未知数据就报错友好得多。这也让 DWARF 能持续支持新语言、新特性，不受具体架构和字节序限制。

DWARF 最初是为 ELF 设计的，但设计上支持扩展到其他文件格式。今天它是最广泛使用的调试信息格式，靠的就是标准化、完备性和持续演进；其他格式与 DWARF 的关系见本章开头和附录 12.16。

### 参考文献

1. DWARF, https://en.wikipedia.org/wiki/DWARF
2. DWARFv1, https://dwarfstd.org/doc/dwarf_1_1_0.pdf
3. DWARFv2, https://dwarfstd.org/doc/dwarf-2.0.0.pdf
4. DWARFv3, https://dwarfstd.org/doc/Dwarf3.pdf
5. DWARFv4, https://dwarfstd.org/doc/DWARF4.pdf
6. DWARFv5, https://dwarfstd.org/doc/DWARF5.pdf
7. DWARFv6 draft, https://dwarfstd.org/languages-v6.html
8. Introduction to the DWARF Debugging Format, https://dwarfstd.org/doc/Debugging-using-DWARF-2012.pdf
