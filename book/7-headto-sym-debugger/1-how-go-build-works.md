## Go 构建内幕

本章开头已经说过，符号级调试要补的是编译工具链写进二进制的那些描述信息：DWARF、符号表，以及 Go 自己的 `.gopclntab` 等。调试器在这之后读取它们。在打开 ELF、逐个看 section 之前，先把一次 `go build` 实际跑了哪些命令、命令之间如何交接走一遍。词法分析、代码生成、DWARF 的具体写法留到后面几节，这一节看 compile、asm、pack、link 如何配合。

`go build` 自己不编译源文件。它是构建驱动：解析包依赖，准备临时目录和 import 配置，再按顺序调用工具链。`go tool compile` 编译一个包里的 Go 源文件；汇编、打包、链接分别是 `go tool asm`、`go tool pack`、`go tool link`。运行 `go tool` 可以看到这些工具。和本节直接相关的是 `compile`、`asm`、`pack`、`link`，以及给产物写入构建 ID 的 `buildid`。

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

### 示例

要让编译、汇编、打包、链接出现在同一次构建里，包里需要同时有 Go 源文件和汇编源文件。有 `.s` 文件时，下面才会看到 asm 跑两遍；纯 Go 包会跳过汇编。示例只有三个文件：

```text
xx/
├── go.mod
├── main.go
└── main.s
```

`main.go` 向标准输出打一行字。`main.s` 里的 `archSqrt` 没有对应的 Go 调用，作用是让这个包带上汇编文件。`go.mod` 把模块名定为 `xx`，链接结束后的可执行文件也叫这个名字。

`main.go`：

```go
package main

import "fmt"

func main() {
        fmt.Println("vim-go")
}

```

`main.s`：

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

`go.mod`：

```go
module xx

go 1.22.3
```

### 一次构建的输出

看清驱动过程，用 `go build -v -x -work`。`go help build` 对这三个选项的说明如下：

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

`-v` 打印正在编译的包名，`-x` 打印实际执行的命令，`-work` 打印临时工作目录 `WORK`，并在退出后保留它，方便回头查看 `symabis`、`go_asm.h`、`main.o` 这些中间文件。

下面这份输出抓取时，依赖已经在构建缓存里，所以只展开了当前模块 `xx`。缓存为空时，标准库里带 `.s` 的包（例如 `runtime`）会各自再走一遍同样的步骤，日志更长，顺序不变。标了 🚩 的命令是本节要跟着读的。

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

上面日志里，`go tool asm` 出现了两次。两次的大部分参数相同，差别在第一次多了 `-gensymabis`，并且 `-o` 指向 `$WORK/b001/symabis`；第二次没有 `-gensymabis`，`-o` 指向 `$WORK/b001/main.o`。

两次都带的参数：

- `-p main`：声明这段汇编属于导入路径为 `main` 的包。`main.s` 里的 `TEXT ·archSqrt(SB)` 会被记成 `main.archSqrt`。
- `-trimpath "$WORK/b001=>"`：从记入产物的源文件路径中去掉临时目录前缀。`=>` 右侧为空，就是把这段前缀删掉，避免本机的 `WORK` 绝对路径留在目标文件里。
- `-I $WORK/b001/`：在包的临时目录中查找 `#include`。编译器写出的 `go_asm.h` 放在这个目录。
- `-I /usr/local/go/pkg/include`：在工具链自带的头文件目录中查找 `#include`。`main.s` 开头的 `#include "textflag.h"` 来自这里，`NOSPLIT` 就定义在这个头文件中。日志里的路径跟着当时的 `GOROOT` 走。
- `-D GOOS_linux`、`-D GOARCH_amd64`、`-D GOAMD64_v1`：预定义宏，汇编源文件可以用 `#ifdef` 按操作系统、架构和微架构变体选择代码。取值来自当前的 `GOOS`、`GOARCH` 和 `GOAMD64`。本例的 `main.s` 没有写这种条件编译，构建驱动仍然会带上这些 `-D`。

第一遍是：

```text
asm -p main -trimpath "$WORK/b001=>" -I $WORK/b001/ -I /usr/local/go/pkg/include -D GOOS_linux -D GOARCH_amd64 -D GOAMD64_v1 -gensymabis -o $WORK/b001/symabis ./main.s
```

`-gensymabis` 让汇编器把符号的 ABI 信息写到 `-o` 指定的文件，不生成机器码。`go tool asm -help` 里的原文是：`write symbol ABI information to output file, don't assemble`。所以这一遍的产物是文本文件 `symabis`，还没有 `main.o`。

本例这个文件的内容是：

```text
def main.archSqrt ABI0
```

每一行三个字段：`def` 或 `ref`、符号名、ABI 名称。`def` 表示该 `TEXT` 符号在汇编中有定义。`-p main` 把 `·archSqrt` 写成了 `main.archSqrt`。这条 `TEXT` 没有标注 `<ABIInternal>`，扫出来的约定是 `ABI0`，也就是稳定的、参数通过栈传递的调用约定。汇编里若引用了其他文本符号，还会出现 `ref 符号名 ABI0` 或 `ref 符号名 ABIInternal`；本例没有这类引用。

下一步的 `go tool compile` 用 `-symabis` 读入它：

```text
compile -o $WORK/b001/_pkg_.a ... -symabis $WORK/b001/symabis ... -asmhdr $WORK/b001/go_asm.h ./main.go
```

Go 函数默认使用 `ABIInternal`，参数尽量放在寄存器中。汇编 `TEXT` 在未另行标注时使用 `ABI0`。编译器依靠这份清单把两边对齐。Go 源文件里若有同名、且没有函数体的声明，编译器就把该函数的调用约定设为清单中的值；约定和 Go 的 `ABIInternal` 不一致时，再生成 ABI 包装函数，在两种约定之间转换参数。`ref` 行处理相反的方向：汇编按某种约定调用 Go 符号时，同样用它决定要不要包一层。包里没有 `.s` 文件时，第一遍 asm 不运行，compile 的命令行上也不会出现 `-symabis`。

本例的 `main.go` 没有声明 `archSqrt`，`def main.archSqrt ABI0` 对不上任何一个 Go 函数，编译器在这一步不会为它生成包装。`archSqrt` 的机器码要等第二遍汇编。

和 `symabis` 一起出现的还有 `go_asm.h`。第一遍 asm 之前，日志里有一行 `echo -n > $WORK/b001/go_asm.h`，先放一个空文件。标准库里很多汇编会 `#include "go_asm.h"`，而此时编译器还没运行，真正的头文件尚不存在。第一遍只扫描符号，并不需要这些宏已经有具体取值，空文件足以让 `#include` 通过。编译器接着用 `-asmhdr` 覆盖这个文件，把本包常量和结构体字段偏移写成宏，形式如下：

```text
#define const_<名字> <值>
#define <类型>__size <大小>
#define <类型>_<字段> <偏移>
```

第二遍 asm 使用同一个 `-I $WORK/b001/`，`#include "go_asm.h"` 就能拿到这些偏移。本例的 `main.go` 没有需要导出给汇编的常量或结构体，`main.s` 也没有包含这个头，编译结束后 `go_asm.h` 里只有一行 `// generated by compile -asmhdr from package main`。

第二遍是：

```text
asm -p main -trimpath "$WORK/b001=>" -I $WORK/b001/ -I /usr/local/go/pkg/include -D GOOS_linux -D GOARCH_amd64 -D GOAMD64_v1 -o $WORK/b001/main.o ./main.s
```

这里没有 `-gensymabis`。汇编器把 `main.s` 汇编成目标文件 `main.o`。`main.o` 是 Go 自己的目标文件，要等链接器写出可执行程序，才得到 ELF。

按日志顺序，整次构建是：

1. 准备临时目录 `$WORK/b001`。`-work` 让它在构建结束后仍然保留。`-v` 打印的包名 `xx` 出现在日志前部。
2. 包内有 `.s` 时，先写入空的 `go_asm.h`，再跑第一遍 `go tool asm -gensymabis`，得到 `symabis`。没有汇编源文件则跳过，后面的 compile 也不带 `-symabis` 和 `-asmhdr`。
3. 写入 `importcfg`，记下 `fmt`、`runtime` 这些直接依赖的归档在构建缓存中的路径。`go tool compile` 编译 `main.go`：`-symabis` 读入上一步的 ABI 清单，`-asmhdr` 写出真正的 `go_asm.h`，`-importcfg` 按这份配置查找依赖，`-pack` 把编译结果直接写入静态库 `$WORK/b001/_pkg_.a`。`-lang=go1.22` 来自 `go.mod` 的语言版本，`-trimpath` 与 asm 相同，用来去掉临时目录前缀。
4. 第二遍 `go tool asm` 把 `main.s` 汇编成 `main.o`。汇编源文件如果 `#include "go_asm.h"`，这一遍才能用上编译器刚写好的偏移。本例的 `main.s` 没有包含它。
5. `go tool pack r` 把 `main.o` 追加进 `_pkg_.a`。至此，这个模块自己的 Go 代码和汇编都在同一个归档里。随后 `buildid -w` 给归档写入构建 ID，构建驱动再把归档复制进构建缓存。
6. 写入 `importcfg.link`。它比编译阶段的 `importcfg` 更全，列出链接所需的全部归档，包括 `fmt`、`runtime` 继续依赖的标准库。
7. `go tool link` 读取 `_pkg_.a` 和 `importcfg.link`，完成符号解析与重定位，生成 `$WORK/b001/exe/a.out`。链接命令上的 `-buildid`，以及随后对可执行文件执行的 `buildid -w`，把构建 ID 写进最终程序，对应 ELF 中的 `.note.go.buildid`。符号解析和重定位在 7.4 节展开，链接阶段如何合并 DWARF 在 7.7 节展开。
8. 将 `a.out` 重命名为模块名 `xx`。

`main.o` 是汇编器写出的 Go 目标文件，`_pkg_.a` 是 ar 归档。链接器读入归档，写出的可执行程序 `xx` 才是 ELF。文件头、段头表、节头表，以及符号表、DWARF、`.note.go.buildid` 在这个文件里如何排列，是下一节的内容。

### 本节小结

本节主要顺着一次 `go build -v -x -work`，看构建驱动如何串起汇编器、编译器、打包工具和链接器。核心内容包括：包里带有汇编文件时 `go tool asm` 会执行两遍，两遍的 `-p`、`-trimpath`、`-I`、`-D` 相同，第一遍额外使用 `-gensymabis` 把符号 ABI 写到 `symabis`，第二遍才生成 `main.o`；`symabis` 由 `go tool compile -symabis` 读取，用来对齐汇编函数和 Go 函数的调用约定，并据此决定是否生成 ABI 包装函数；编译器同时用 `-asmhdr` 写出 `go_asm.h`，供第二遍汇编中的 `#include` 使用。本节把工具链留下的中间产物摊开，为下一节阅读链接器产出的 ELF 文件打下基础。
