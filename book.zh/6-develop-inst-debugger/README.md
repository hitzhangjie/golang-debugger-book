### 指令级调试

本章开始进入指令级调试器开发，我们将一步步实现指令级调试相关操作。

#### 指令级 VS. 符号级调试

指令级调试是相对符号级调试而言的。它只关心机器指令级别的调试，不依赖调试符号、源程序信息。缺少了调试符号信息，会让调试变得有些困难，难以理解调试代码的含义。

但是指令级调试技术是符号级调试技术的基石，可以说符号级调试相关的操作是在指令级调试基础上的完善。大家在软件开发过程中接触到的大多数调试器，是符号级调试器，如gdb、lldb、dlv等，但是它们也具备指令级调试能力。当然也有一些专门的指令级调试器，如radare2、IDA Pro、OllyDbg、Hopper等。

#### 指令级调试的实践应用

我们既然要支持指令级调试能力，不妨多说一点。

指令级调试技术，在软件逆向工程中的应用是非常广泛的。当然这里要求调试器具备更加强大的能力，绝不仅仅是只支持step逐指令执行、读写内存、读写寄存器这么简单，下面就以使用过的radare2为例演示下其有多强大。

以如下程序main.go为例：

```go
package main
import "fmt"

func main() {
  fmt.Println("vim-go")
}
```

执行`go build -o main main.go`编译完成，然后执行`radare2 main`：

```bash
$ go build -o main main.go
$ 
$ r2 main
[0x0105cba0]> s sym._main.main             ; 注意先定位到函数main.main
[0x0109ce80]> af                           ; 对当前函数进行分析
[0x0109ce80]> pdf                          ; 反汇编当前函数并打印
            ; CODE XREF from sym._main.main @ 0x109cf04
┌ 137: sym._main.main ();
│           ; var int64_t var_50h @ rsp+0x8
│           ; var int64_t var_48h @ rsp+0x10
│           ; var int64_t var_40h @ rsp+0x18
│           ; var int64_t var_38h @ rsp+0x20
│           ; var int64_t var_18h @ rsp+0x40
│           ; var int64_t var_10h @ rsp+0x48
│           ; var int64_t var_8h @ rsp+0x50
│       ┌─> 0x0109ce80      65488b0c2530.  mov rcx, qword gs:[0x30]
│       ╎   0x0109ce89      483b6110       cmp rsp, qword [rcx + 0x10]
│      ┌──< 0x0109ce8d      7670           jbe 0x109ceff
│      │╎   0x0109ce8f      4883ec58       sub rsp, 0x58
│      │╎   0x0109ce93      48896c2450     mov qword [var_8h], rbp
│      │╎   0x0109ce98      488d6c2450     lea rbp, [var_8h]
│      │╎   0x0109ce9d      0f57c0         xorps xmm0, xmm0
│      │╎   0x0109cea0      0f11442440     movups xmmword [var_18h], xmm0
│      │╎   0x0109cea5      488d0554e200.  lea rax, [0x010ab100]
│      │╎   0x0109ceac      4889442440     mov qword [var_18h], rax
│      │╎   0x0109ceb1      488d05a8b804.  lea rax, [0x010e8760]
│      │╎   0x0109ceb8      4889442448     mov qword [var_10h], rax
│      │╎   0x0109cebd      488b0594e10d.  mov rax, qword [sym._os.Stdout] ; [0x117b058:8]=0
│      │╎   0x0109cec4      488d0d35d304.  lea rcx, sym._go.itab._os.File_io.Writer ; 0x10ea200 ; "`>\v\x01"
│      │╎   0x0109cecb      48890c24       mov qword [rsp], rcx
│      │╎   0x0109cecf      4889442408     mov qword [var_50h], rax
│      │╎   0x0109ced4      488d442440     lea rax, [var_18h]
│      │╎   0x0109ced9      4889442410     mov qword [var_48h], rax
│      │╎   0x0109cede      48c744241801.  mov qword [var_40h], 1
│      │╎   0x0109cee7      48c744242001.  mov qword [var_38h], 1
│      │╎   0x0109cef0      e87b99ffff     call sym._fmt.Fprintln
│      │╎   0x0109cef5      488b6c2450     mov rbp, qword [var_8h]
│      │╎   0x0109cefa      4883c458       add rsp, 0x58
│      │╎   0x0109cefe      c3             ret
│      └──> 0x0109ceff      e87cc4fbff     call sym._runtime.morestack_noctxt
└       └─< 0x0109cf04      e977ffffff     jmp sym._main.main
[0x0109ce80]> 
```

我们在radare2调试会话里面执行了3个命令：

-   s sym._main.main，定位到main.main函数；
-   af，对当前函数进行分析；
-   pdf，对当前函数进行反汇编并打印出来；

大家可以看到，与普通符号级调试器disass命令不同的是，radare2不仅展示了汇编信息，还将函数调用关系的起止点通过箭头的形式给标识了出来。

甚至可以执行命令`vV`将汇编指令转换成调用图（callgraph）的形式：

![radare2 callgraph](assets/radare2-callgraph.png)

读者朋友们可能会认为该功能有点神奇，当读者理解了像ABI、function prologue、function epilogue之后就对如何实现此类功能习以为常了，实际上在指令级别、高级语言级别均可实现此类功能。

radare2的功能之强大远不只是这些，从其支持的命令及选项可见一斑，其学习曲线也异常陡峭，逆向工程师、对二进制分析感兴趣的人对其青睐有加，也是个有力证明。

```bash
[0x0109ce80]> ?
Usage: [.][times][cmd][~grep][@[@iter]addr!size][|>pipe] ; ...   
Append '?' to any char command to get detailed help
Prefix with number to repeat command N times (f.ex: 3x)
| %var=value              alias for 'env' command
| *[?] off[=[0x]value]    pointer read/write data/values (see ?v, wx, wv)
| (macro arg0 arg1)       manage scripting macros
| .[?] [-|(m)|f|!sh|cmd]  Define macro or load r2, cparse or rlang file
| _[?]                    Print last output
| =[?] [cmd]              send/listen for remote commands (rap://, raps://, udp://, http://, <fd>)
| <[...]                  push escaped string into the RCons.readChar buffer
| /[?]                    search for bytes, regexps, patterns, ..
| ![?] [cmd]              run given command as in system(3)
| #[?] !lang [..]         Hashbang to run an rlang script
| a[?]                    analysis commands
| b[?]                    display or change the block size
| c[?] [arg]              compare block with given data
| C[?]                    code metadata (comments, format, hints, ..)
| d[?]                    debugger commands
| e[?] [a[=b]]            list/get/set config evaluable vars
| f[?] [name][sz][at]     add flag at current address
| g[?] [arg]              generate shellcodes with r_egg
| i[?] [file]             get info about opened file from r_bin
| k[?] [sdb-query]        run sdb-query. see k? for help, 'k *', 'k **' ...
| l [filepattern]         list files and directories
| L[?] [-] [plugin]       list, unload load r2 plugins
| m[?]                    mountpoints commands
| o[?] [file] ([offset])  open file at optional address
| p[?] [len]              print current block with format and length
| P[?]                    project management utilities
| q[?] [ret]              quit program with a return value
| r[?] [len]              resize file
| s[?] [addr]             seek to address (also for '0x', '0x1' == 's 0x1')
| t[?]                    types, noreturn, signatures, C parser and more
| T[?] [-] [num|msg]      Text log utility (used to chat, sync, log, ...)
| u[?]                    uname/undo seek/write
| v                       visual mode (v! = panels, vv = fcnview, vV = fcngraph, vVV = callgraph)
| w[?] [str]              multiple write operations
| x[?] [len]              alias for 'px' (print hexadecimal)
| y[?] [len] [[[@]addr    Yank/paste bytes from/to memory
| z[?]                    zignatures management
| ?[??][expr]             Help or evaluate math expression
| ?$?                     show available '$' variables and aliases
| ?@?                     misc help for '@' (seek), '~' (grep) (see ~??)
| ?>?                     output redirection
| ?|?                     help for '|' (pipe)
[0x0109ce80]> 
```

如果读者进一步了解下rafare2的详细功能，它功能之强大一定会让你感到惊叹。

ps: 如果读者想了解radare2的使用，可以先看下我之前写过的一偏实践文章：[monkey patching in golang](hitzhangjie.pro/blog/2020-08-23-monkey_patching_in_go/)，描述了指令patch技术在golang mock测试中 的应用，以及如何借助radare2来演示指令patching的过程。

#### 有限的指令级调试支持

本书中，我们仅介绍如何支持有限的指令级调试能力，我们的初衷是学习分享，而非工程上的取代、大而全。如果篇幅允许，也会适当的和其他指令级调试做对比，探讨下某些特性的实现方式。