## Go 构建内幕

### 基础知识

`go build` 这个命令用来完成 Go 程序的构建，只要用过 Go 的，相信都不陌生。可大家有没有仔细看过，这条命令底下到底调用了哪些工具？和 `go tool compile` 又有什么区别？

符号级调试要读 `go build` 写进二进制的 DWARF 和符号表，甚至可能会用到 Go 的 `.gopclntab`，所以我们要了解下go build的详细构建过程，看看到底做了什么。

`go build` 自己并不编译源文件。它负责构建驱动：解析包依赖，准备好临时目录和 import 配置，再把活按顺序派出去。`go tool compile` 负责编译一个包里的 Go 源文件；汇编、打包、链接，分别是 `go tool asm`、`go tool pack`、`go tool link`，以及负责写入构建 ID 的 `buildid`。这条调用链可以用 `go build -v -x -work` 查看。`-v` 打印正在编译的包名，`-x` 把实际执行的命令打出来，`-work` 告诉你临时目录在哪，并且退出之后保留中间构建产物，方便我们去查看 `symabis`、`go_asm.h`、`main.o` 这些中间文件。

本文要讲的是这些工具怎么配合，不是某一个工具内部怎么做词法分析、怎么写 DWARF。那些留到后面几节。这里先把协作这条线理顺。

### 示例准备

go提供了完整的编译工具链，运行 `go tool` 命令可以查看到编译器compile、汇编器asm、链接器link、静态库打包工具pack，以及 buildid 等其他工具。本节我们先关注这些，其他的有需要的时候再介绍。

```bash
$ go tool

addr2line
asm
buildid
cgo
compile
covdata
cover
doc
fix
link
nm
objdump
pack
pprof
test2json
trace
vet
```

为了能演示go编译工具链的功能，尽可能让compile、asm、linker、pack这几个工具都能被执行，我们设计如下这个工程实例。包里放了汇编文件，所以后面 asm 会跑两遍。

```text
xx/
├── go.mod
├── main.go
└── main.s
```

file1: main.go

```go
package main

import "fmt"

func main() {
        fmt.Println("vim-go")
}

```

file2: main.s

```asm
// Copyright 2009 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

#include "textflag.h"

// func archSqrt(x float64) float64
TEXT ·archSqrt(SB), NOSPLIT, $0
        XORPS  X0, X0 // break dependency
        SQRTSD x+0(FP), X0
        MOVSD  X0, ret+8(FP)
        RET

```

file3: go.mod

```go
module xx

go 1.22.3
```

### 执行测试

执行构建命令 `go build -v -x -work`，我们介绍下这里用到的这几个选项：

```bash
$ go help build
usage: go build [-o output] [build flags] [packages]
...

The build flags are shared by the build, clean, get, install, list, run,
and test commands:
        -v
                print the names of packages as they are compiled.
        -x
                print the commands.
        -work
                print the name of the temporary work directory and
                do not delete it when exiting.
...
```

我们看下go构建过程的输出信息，因为添加了上述几个选项的原因，我们可以看到编译构建过程中执行的各个命令，以及构建临时目录中的产物信息：

```bash
$ go build -v -x -work
WORK=/tmp/go-build3686919208
xx
mkdir -p $WORK/b001/
echo -n > $WORK/b001/go_asm.h # internal
cd $HOME/test/xx
🚩/usr/local/go/pkg/tool/linux_amd64/asm -p main -trimpath "$WORK/b001=>" -I $WORK/b001/ -I /usr/local/go/pkg/include -D GOOS_linux -D GOARCH_amd64 -D GOAMD64_v1 -gensymabis -o $WORK/b001/symabis ./main.s
cat >/tmp/go-build3686919208/b001/importcfg << 'EOF' # internal
# import config
packagefile fmt=$HOME/.cache/go-build/1a/1aeb36219a78df45c71149c716fa273649ec980faca58452aaa9184ba8747d05-d
packagefile runtime=$HOME/.cache/go-build/ff/ff9a2c1087b07575bc898f6cbded2c2bd65005b7d3ceaec59cd5dc9ef4dd8bcb-d
EOF
🚩/usr/local/go/pkg/tool/linux_amd64/compile -o $WORK/b001/_pkg_.a -trimpath "$WORK/b001=>" -p main -lang=go1.22 -buildid -wqdZirDfarB_eqBW8ak/-wqdZirDfarB_eqBW8ak -goversion go1.22.3 -symabis $WORK/b001/symabis -c=4 -nolocalimports -importcfg $WORK/b001/importcfg -pack -asmhdr $WORK/b001/go_asm.h ./main.go
🚩/usr/local/go/pkg/tool/linux_amd64/asm -p main -trimpath "$WORK/b001=>" -I $WORK/b001/ -I /usr/local/go/pkg/include -D GOOS_linux -D GOARCH_amd64 -D GOAMD64_v1 -o $WORK/b001/main.o ./main.s
🚩/usr/local/go/pkg/tool/linux_amd64/pack r $WORK/b001/_pkg_.a $WORK/b001/main.o # internal
🚩/usr/local/go/pkg/tool/linux_amd64/buildid -w $WORK/b001/_pkg_.a # internal
cp $WORK/b001/_pkg_.a $HOME/.cache/go-build/a8/a8abe4134014b2c51a6c890004545b5381947bf7b46ad92639eef689fda633c3-d # internal
🚩cat >/tmp/go-build3686919208/b001/importcfg.link << 'EOF' # internal
packagefile xx=/tmp/go-build3686919208/b001/_pkg_.a
packagefile fmt=$HOME/.cache/go-build/1a/1aeb36219a78df45c71149c716fa273649ec980faca58452aaa9184ba8747d05-d
packagefile runtime=$HOME/.cache/go-build/ff/ff9a2c1087b07575bc898f6cbded2c2bd65005b7d3ceaec59cd5dc9ef4dd8bcb-d
packagefile errors=$HOME/.cache/go-build/89/892ce7f48762195fcd6840c12c5f9ce87785a46c63b0dc07a57865a519122f28-d
packagefile internal/fmtsort=$HOME/.cache/go-build/dd/ddfbd9f18abcb9d77cbc7008f82d128c92ff43558ca6b7efc602cda04d7f6442-d
packagefile io=$HOME/.cache/go-build/31/313bc3b844204dfa06aa297c9ccdb7c50e8f5a400e6a2d0194022dc91cc2e16f-d
packagefile math=$HOME/.cache/go-build/d9/d965e602a715d2aed8249bef0203c0cd6e28e87987bf89a859f6166427adcd30-d
packagefile os=$HOME/.cache/go-build/58/5843eabefbd1a16227acf29d96ad1373972d6e6b6db2aabc28c31dc676b5e465-d
packagefile reflect=$HOME/.cache/go-build/bf/bfc22ec705a18fff28097e03b3f013e0ae088c1c0c26c9e1ce7cb5f64106a305-d
packagefile sort=$HOME/.cache/go-build/5e/5ed02f1d2aa35fd662d38bde42d018a9dc81f1c38efb01f210cba4daeaa54d0f-d
packagefile strconv=$HOME/.cache/go-build/da/da217c7dbe580ef4130eed0028da7aa38f8cec1787943e05a24d792dece7f6fa-d
packagefile sync=$HOME/.cache/go-build/6e/6e7ba2c9b00da040587f76dcf4ffc872412e07752bca8280065a41d7eb812e07-d
packagefile unicode/utf8=$HOME/.cache/go-build/a5/a5a3730633d8e8c948dcd5588bce011bd0bda847ecdc1c8b8db8d802d683bb76-d
packagefile internal/abi=$HOME/.cache/go-build/a9/a98408ccf41589aa8b8552dfd9d6ad04a59f9092a73f1d2237a2cca1e9dedfc2-d
packagefile internal/bytealg=$HOME/.cache/go-build/0e/0ef7fc32ea503101ae8a71905a3cc725d82f4436e1fb64e23dabc9a559a81717-d
packagefile internal/chacha8rand=$HOME/.cache/go-build/74/74c0617b7f700fffb3e2ec0a75511fe4b4442142fd8ea9d28af32c8e87f91a2e-d
packagefile internal/coverage/rtcov=$HOME/.cache/go-build/7a/7a8c48e81d34485c0a46d3b762d70b7252ff2a5122d7929976ac1ed316003edf-d
packagefile internal/cpu=$HOME/.cache/go-build/fe/fec87c97c3c638490387af5dca95acb3c7ca00cd3d34c4b665dce7ee8143e59a-d
packagefile internal/goarch=$HOME/.cache/go-build/0b/0bf1fceb5ecd8badbcb18732b4e517a2f4968c9960af4e0175726a2d0ce8ba31-d
packagefile internal/godebugs=$HOME/.cache/go-build/38/387def0b0b5adb9f38a38b5d5301a4816420da0d8d3259354903883ebf3d06ed-d
packagefile internal/goexperiment=$HOME/.cache/go-build/75/755756dfc319f00bcffc6745334076209023acfd72ec9f80b665e0e6b8ca7d37-d
packagefile internal/goos=$HOME/.cache/go-build/e2/e2b0d1019a4dd99ef01bb1d44e3ce0504234e38fe6dd5bf5e94960dfa0eae968-d
packagefile runtime/internal/atomic=$HOME/.cache/go-build/a1/a1ab93c6b342fa82fa28906124bad4a20b5fcb4c23653212bd8973861814fa46-d
packagefile runtime/internal/math=$HOME/.cache/go-build/01/01886c1840e6c3e18c9458497803130f0f40342031eda05d66824c0018d028c2-d
packagefile runtime/internal/sys=$HOME/.cache/go-build/cc/cc237a5895f1661e82c3a240f72bf165b7c98c49f584233dac2c830d1fd96db9-d
packagefile runtime/internal/syscall=$HOME/.cache/go-build/57/57f5686c8b8b90f002882a4d3020168b314b41aff9b7561f3b7fed78985bf682-d
packagefile internal/reflectlite=$HOME/.cache/go-build/fc/fc635c76e99ef1256f0df28309730bc72ada766800e7f75f43eacd4a49ac1825-d
packagefile math/bits=$HOME/.cache/go-build/b4/b49ee4aa1defd50d4d0dcfa35c74bc03c59487b53ad698f824db7d092fe12c89-d
packagefile internal/itoa=$HOME/.cache/go-build/3b/3b4a89fac06e8caef384af48ace1bd2da07824467fe03ad1980ceaeda67983c6-d
packagefile internal/poll=$HOME/.cache/go-build/15/1529e1d377fc16952dcba29f52c6a22a942f61a5059c8f9f959095b5089f1ab8-d
packagefile internal/safefilepath=$HOME/.cache/go-build/64/641d3e96f0d2f68d3472d7b1e6a695ffd71295a1e4c7028f28f4b2ef031b6914-d
packagefile internal/syscall/execenv=$HOME/.cache/go-build/7a/7a6794530a44ee997a0fcbb91f42ac2b1d30a58bf10a82a7ef31b48ee5279ae7-d
packagefile internal/syscall/unix=$HOME/.cache/go-build/97/97c10030ba3200bbde9370669d2d453aab43cfb97af080345505cbba2c755a5c-d
packagefile internal/testlog=$HOME/.cache/go-build/8b/8b88f2b695d41ad558f1e04ab9c0d0385b0ea6f33d09d1cf5f98f1e6e286cf65-d
packagefile io/fs=$HOME/.cache/go-build/53/536225877d64d4db64280b8ceddb0efddf18f3d88f01b0525ed1e1375cdaa4b5-d
packagefile sync/atomic=$HOME/.cache/go-build/a8/a8bc9b57a63c717e41c47f1b2561385a3e99ad7e6f1ac998dfa126558fb2a77c-d
packagefile syscall=$HOME/.cache/go-build/09/090478bb0bb13e1af21c128b423010e7ce96eb925d5fbe48dc0d9e0003bf90ea-d
packagefile time=$HOME/.cache/go-build/c5/c537d62b8dbfa4801ba05947b4cb7ed69b231f00fc275abd287c8d073c846360-d
packagefile internal/unsafeheader=$HOME/.cache/go-build/cb/cbfd364d12f2f9873ac2dbe3f709d93e560c6285abbd5800ed08870b0eef13da-d
packagefile unicode=$HOME/.cache/go-build/a6/a68c49fe16820f404e05e8b52685c89f9824b3a05241e84176f664b6b26def68-d
packagefile slices=$HOME/.cache/go-build/ee/ee5afcbf5fb8afb740704f6aaf3a227ad2304a26abf14792dfe91814e4ecbbe8-d
packagefile internal/race=$HOME/.cache/go-build/c5/c5d493a5513e485a53e716d5a2857cfeef7c998bc786b3d7cdba59c6c6b58ec8-d
packagefile internal/oserror=$HOME/.cache/go-build/70/70c743407927cf8c172a78fddb04df52b02d264b6e7b25dfbdd6179824a327c3-d
packagefile path=$HOME/.cache/go-build/7a/7aac686e9c5205ee6c817e8ed03a971f77c90d90d1fc668cfae54befbcee36e9-d
packagefile cmp=$HOME/.cache/go-build/a1/a12133a77c368ad656257d944b4049e56404cc17981f2a0f1f91ae5ab36419f7-d
modinfo "0w\xaf\f\x92t\b\x02A\xe1\xc1\a\xe6\xd6\x18\xe6path\txx\nmod\txx\t(devel)\t\nbuild\t-buildmode=exe\nbuild\t-compiler=gc\nbuild\tCGO_ENABLED=1\nbuild\tCGO_CFLAGS=\nbuild\tCGO_CPPFLAGS=\nbuild\tCGO_CXXFLAGS=\nbuild\tCGO_LDFLAGS=\nbuild\tGOARCH=amd64\nbuild\tGOOS=linux\nbuild\tGOAMD64=v1\n\xf92C1\x86\x18 r\x00\x82B\x10A\x16\xd8\xf2"
EOF
mkdir -p $WORK/b001/exe/
cd .
🚩/usr/local/go/pkg/tool/linux_amd64/link -o $WORK/b001/exe/a.out -importcfg $WORK/b001/importcfg.link -buildmode=exe -buildid=DnmbfNnl2SoT5ZrYeE1X/-wqdZirDfarB_eqBW8ak/b4gs6m2b26a_jZ5hsnkn/DnmbfNnl2SoT5ZrYeE1X -extld=gcc $WORK/b001/_pkg_.a
/usr/local/go/pkg/tool/linux_amd64/buildid -w $WORK/b001/exe/a.out # internal
mv $WORK/b001/exe/a.out xx
```

### 构建过程

上述输出里，感兴趣的工具已经用 🚩 标出来了。先说一个容易看漏的地方：`go tool asm` 出现了两次。两次大部分参数是一样的，差别在第一次多了个 `-gensymabis`，`-o` 指向 `$WORK/b001/symabis`；第二次没有 `-gensymabis`，`-o` 指向 `$WORK/b001/main.o`。

相同的那些参数，我们挨个说下它们是干什么的。

`-p main`，是在告诉汇编器，这段代码属于导入路径为 `main` 的包。所以 `main.s` 里写的 `TEXT ·archSqrt(SB)`，记下来就成了 `main.archSqrt`。

`-trimpath "$WORK/b001=>"`，把记进产物的源文件路径里、临时目录那一截前缀去掉。`=>` 右边是空的，意思就是直接删掉这一截，免得本机 `WORK` 的绝对路径留在目标文件里。

`-I` 给了两个目录。`$WORK/b001/` 是这个包的临时目录，编译器一会儿写出的 `go_asm.h` 就放在这儿。`/usr/local/go/pkg/include` 是工具链自带的头文件目录，`main.s` 开头的 `#include "textflag.h"` 就是从这儿找到的，`NOSPLIT` 定义在这个头里面。日志里的路径跟着当时的 `GOROOT` 走，你自己机器上未必是 `/usr/local/go`。

`-D GOOS_linux -D GOARCH_amd64 -D GOAMD64_v1`，是预定义三个宏。汇编里可以用 `#ifdef` 按操作系统、架构，以及 GOAMD64 这种更细的档位来挑代码，取值就来自当前的 `GOOS`、`GOARCH`、`GOAMD64`。本例的 `main.s` 并没有写这种条件编译，构建的时候这几个 `-D` 还是会带上。

OK，相同的部分就这些。两遍各自干什么，差别就在 `-gensymabis` 和 `-o` 上。

第一遍是这样：

```text
asm -p main -trimpath "$WORK/b001=>" -I $WORK/b001/ -I /usr/local/go/pkg/include -D GOOS_linux -D GOARCH_amd64 -D GOAMD64_v1 -gensymabis -o $WORK/b001/symabis ./main.s
```

注意哦，`-gensymabis` 让汇编器把符号的 ABI 信息写到 `-o` 指定的那个文件里，这一遍不生成机器码。`go tool asm -help` 的原文就是：`write symbol ABI information to output file, don't assemble`。所以这一遍你在临时目录里还找不到 `main.o`，只有一个文本文件 `symabis`。

本例这个文件里就一行：

```text
def main.archSqrt ABI0
```

一行三个字段，`def` 或者 `ref`，然后是符号名，然后是 ABI 的名字。`def` 表示这个 `TEXT` 符号在汇编里有定义。`-p main` 把 `·archSqrt` 补成了 `main.archSqrt`。这条 `TEXT` 没有写 `<ABIInternal>`，扫出来就是 `ABI0`，也就是那套稳定的、参数走栈的调用约定。汇编里要是引用了别的文本符号，还会多出 `ref 符号名 ABI0` 或者 `ref 符号名 ABIInternal` 这样的行。本例没有这种引用。

这个文件是交给下一步的编译器的。你看 compile 的命令行上带着 `-symabis $WORK/b001/symabis`：

```text
compile -o $WORK/b001/_pkg_.a ... -symabis $WORK/b001/symabis ... -asmhdr $WORK/b001/go_asm.h ./main.go
```

编译器为什么要先知道这些？Go 函数默认走 `ABIInternal`，参数尽量放在寄存器里；汇编里的 `TEXT` 如果没有另外标注，走的是 `ABI0`。两边约定不一样，调用会对不上。编译器读到这份清单之后，Go 源文件里如果有同名、又没有函数体的声明，就把这个函数的调用约定设成清单里写的那个；和 `ABIInternal` 不一致的话，再生成一个 ABI 包装函数，在两种约定之间把参数倒一手。`ref` 那一行是反过来的情况，汇编按某种约定去调用 Go 的符号，同样靠它决定要不要包一层。包里要是没有 `.s` 文件，第一遍 asm 整个跳过，compile 的命令行上也不会出现 `-symabis`。

本例的 `main.go` 并没有声明 `archSqrt`，`def main.archSqrt ABI0` 对不上任何一个 Go 函数，这一步就不会给它生成包装。`archSqrt` 的机器码，得等第二遍汇编。

和 `symabis` 一起出现的，还有 `go_asm.h`。第一遍 asm 之前，日志里有一句 `echo -n > $WORK/b001/go_asm.h`，先放了个空文件。标准库里不少汇编会 `#include "go_asm.h"`，可这时候编译器还没跑，真正的头文件还不存在。第一遍只是扫符号，并不需要这些宏已经有具体的值，有个空文件，`#include` 能通过就行。编译器接着用 `-asmhdr` 把这个文件盖掉，把本包的常量、结构体大小、字段偏移写成宏，样子是这样的：

```text
#define const_<名字> <值>
#define <类型>__size <大小>
#define <类型>_<字段> <偏移>
```

第二遍 asm 还带着同一个 `-I $WORK/b001/`，`#include "go_asm.h"` 就能拿到这些偏移。本例的 `main.go` 没有要导出给汇编的常量和结构体，`main.s` 也没有包含这个头，所以编译结束以后，`go_asm.h` 里只剩下一行 `// generated by compile -asmhdr from package main`。

第二遍长这样：

```text
asm -p main -trimpath "$WORK/b001=>" -I $WORK/b001/ -I /usr/local/go/pkg/include -D GOOS_linux -D GOARCH_amd64 -D GOAMD64_v1 -o $WORK/b001/main.o ./main.s
```

这次没有 `-gensymabis`。汇编器这才把 `main.s` 编成目标文件 `main.o`。注意哦，这个 `main.o` 是 Go 自己的目标文件，还不是 ELF。ELF 要等最后链接器把可执行程序写出来，才看得到。

按日志里的顺序，整次构建可以收成下面几步：

1. 先准备构建用的临时目录 `$WORK/b001`，后面的产物都在这个目录里。因为加了 `-work`，构建结束以后它还在，我们可以 cd 进去看。`-v` 打出来的包名 `xx` 出现在日志前头。不过末尾有 `mv`，那个最终的可执行文件会被挪走。
2. 包里有 `.s` 的话，先写一个空的 `go_asm.h`，再跑第一遍 `go tool asm -gensymabis`，得到 `symabis`。没有汇编源文件，这一步就跳过，后面的 compile 也不会带上 `-symabis` 和 `-asmhdr`。
3. 写好 `importcfg`，里面记下 `fmt`、`runtime` 这些直接依赖的归档，在构建缓存里的路径。然后 `go tool compile` 编译 `main.go`。`-symabis` 读上一步那份 ABI 清单，`-asmhdr` 写出真正的 `go_asm.h`，`-importcfg` 按这份配置去找依赖。compile 这里带了 `-pack`，编译结果直接打进静态库 `$WORK/b001/_pkg_.a`。`-lang=go1.22` 来自 `go.mod` 里的语言版本。compile 同样带了 `-trimpath`，作用和 asm 那边一样，把临时目录前缀去掉。
4. 第二遍 `go tool asm`，把 `main.s` 汇编成 `main.o`。汇编文件如果 `#include "go_asm.h"`，这一遍才能用上编译器刚写好的那些偏移。本例的 `main.s` 没有包含它。
5. `go tool pack r` 把 `main.o` 追加进 `_pkg_.a`。到这儿，这个模块自己的 Go 代码和汇编，都进了同一个归档。随后 `buildid -w` 给归档写上构建 ID，go 命令再把这个归档复制进构建缓存。
6. 准备 `importcfg.link`。它比编译时候那个 `importcfg` 要全，链接要用到的归档都列在里面，包括 `fmt`、`runtime` 再往下依赖的那些标准库。
7. `go tool link` 读 `_pkg_.a` 和 `importcfg.link`，做符号解析、重定位，生成 `$WORK/b001/exe/a.out`。链接命令上的 `-buildid`，再加上随后对这个可执行文件跑的 `buildid -w`，把构建 ID 写进最终程序，落在 ELF 的 `.note.go.buildid` 里。符号解析和重定位，我们放到 7.4 节再展开；链接的时候 DWARF 是怎么合并的，放到 7.7 节。
8. 把 `a.out` 重命名成模块名，这里就是 `xx`。

至此，这个示例模块的构建就结束了。再提一个容易混的地方：`main.o` 是汇编器写出的 Go 目标文件，`_pkg_.a` 是个 ar 归档，链接器读的是这个归档。它写出来的可执行程序 `xx`，才是 ELF。文件头、段头表、节头表里有符号表和 DWARF，还有链接器与 `buildid` 写入的 `.note.go.buildid`，以及 Go 运行时跟踪调用栈用的 `.gopclntab`。这些节怎么排，下一节再看。

### 本文小节

OK，本文顺着一次 `go build -v -x -work`，把编译器、汇编器、静态库打包工具、链接器、buildid 这些是怎么配合的，简单走了一遍。包里要是带了汇编，`go tool asm` 会跑两遍。两遍的 `-p`、`-trimpath`、`-I`、`-D` 是一样的，第一遍多一个 `-gensymabis`，只把符号 ABI 写进 `symabis`，交给后面的 `go tool compile -symabis`，好让编译器把汇编函数和 Go 函数的调用约定对齐，需要的时候再生成 ABI 包装；第二遍才真正把 `main.s` 编成 `main.o`。编译器同时还用 `-asmhdr` 写出 `go_asm.h`，第二遍汇编如果要 `#include`，用的就是它。

接下来我们还会进一步展开讲下，它们究竟做了什么。但是在我们详细介绍每一个工具的工作之前，我们得把关注点转向链接器的最终产物 —— ELF 文件。我们得先了解下 ELF 文件的构成（如节头表、段头表、sections、segments）以及它们的具体作用，了解了这些之后，我们再回头看这些工具是如何协调起来去生成它们的，以及后续其他的工具，加载器、调试器，又如何利用它们。
