## How "go build" works

### 基础知识

`go build` 这个命令用于完成go程序构建，只要用过go的相信都不陌生，但大家是否有仔细去看过这条命令到底涉及到了哪些操作呢？更甚至有没有仔细看过 `go help build` 都支持哪些选项？和 `go tool compile` 又有什么区别？

OK，我们这里并不是故意挑事，如果运行的一切顺利，有谁会多此一举非得看看它内部是怎么工作的呢，毕竟大家都是学习过编译原理的，对不对？对。但是，我恰恰就遇到过几次事情，强迫我把go源码中的工具链部分研究了下。

故事起因是因为 `go test` 做了些额外生成main函数桩代码、flags解析的工作，当时go1.13调整了一个flags解析顺序的代码，导致我编写的 [微服务框架trpc](https://github.com/Tencent/trpc) 配套的效率工具无法正常工作了。于是我就想知道 `go test` 到底是如何工作的，进而了解到 `go test -v -x -work` 和 `go build -v -x -work` 这几个可以展示编译构建过程、保留构建临时目录及产物的控制选项。这样一点点入手逐渐了解了 `go build` 和 `go test` 的详细执行过程。

这部分内容如果您感兴趣可以参考我的博客或者自己阅读go源码。

- [go源码剖析 - go命令/go build](https://www.hitzhangjie.pro/blog/2020-09-28-go%E6%BA%90%E7%A0%81%E5%89%96%E6%9E%90-go%E5%91%BD%E4%BB%A4/#go-build)
- [go源码剖析 - go命令/go test](https://www.hitzhangjie.pro/blog/2020-09-28-go%E6%BA%90%E7%A0%81%E5%89%96%E6%9E%90-go%E5%91%BD%E4%BB%A4/#go-test)
- [go源码剖析 - go test实现](https://www.hitzhangjie.pro/blog/2020-02-23-go%E6%BA%90%E7%A0%81%E5%89%96%E6%9E%90-gotest%E5%AE%9E%E7%8E%B0/)

OK，上面几篇文章详细介绍了下 go tool compile 的工作过程，以及go test生成测试用入口桩代码的过程，但是没有提及 go tool asm、pack、link、buildid 在构建过程中的作用。本文主要是想介绍编译工具链中各个工具的协作，而非单一工具具体是如何做的。所以你也可以不看上面几篇文章，而是将重点放在我们关心的这个协作目标上。

### 示例准备

go提供了完整的编译工具链，运行 `go tool` 命令可以查看到编译器compile、汇编器asm、链接器link、静态库打包工具pack，以及一些其他的工具。本节我们先关注这些，其他的有需要的时候再介绍。

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

为了能演示go编译工具链的功能，尽可能让compile、asm、linker、pack这几个工具都能被执行，我们设计如下这个工程实例，详见：[golang-debugger-lessons/30_how_gobuild_works](https://github.com/hitzhangjie/golang-debugger-lessons/tree/master/30_how_gobuild_works) .

file1: main.go

```go
package main

import "fmt"

func main() {
        fmt.Println("vim-go")
}

```

file2： main.s

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

上述输出中，我们对感兴趣的工具的执行步骤进行了标记（🚩），简单总结如下：

1. 准备构建用的临时目录，后续构建产物都在这个临时目录中，我们可以cd到此目录查看，但是因为涉及到mv操作、rm操作，构建结束后某些中间产物会消失；
2. `go tool asm` 处理汇编源文件main.s，输出汇编文件中定义的函数列表 symabis。如果没有汇编源文件，此步骤会跳过；
3. `go tool compile` 处理go源文件main.go，输出目标文件，注意compile直接将*.o文件加到了静态库_pkg_.a中；
4. `go tool asm` 对汇编源文件执行汇编操作，输出目标文件main.o。注意哦，main.go以及其他go文件对应的目标文件加到了静态库_pkg_.a中；
5. `go tool pack` 将main.o加到静态库文件_pkg_.a中。此时示例module中的源文件都编译、汇编加入_pkg_.a中了；
6. 准备其他需要链接的目标文件列表，已经编译构建好的go运行时、标准库对应的目标文件，全部写入importcfg.link文件；
7. `go tool link` 对_pkg_.a以及importcfg.link中记录的go运行时、标准库进行链接操作，完成符号解析、重定位，生成一个可执行程序a.out，同时在其.note.go.buildid写入buildid信息；
8. 将a.out重命名为module name，这里为xx；

至此这个示例模块的构建过程结束。

### 本文小节

OK，本文简单介绍了下 `go build` 内部的工作过程，编译器、汇编器、链接器、静态库创建工具、buildid工具，接下来我们还会进一步展开讲下，它们究竟做了什么。但是在我们详细介绍每一个工具的工作之前，我们得把关注点转向它们的最终产物 —— ELF文件。我们得先了解下ELF文件的构成（如节头表、段头表、sections、segments）以及它们的具体作用，了解了这些之后，我们再回头看这些工具是如何协调起来去生成它们的，以及后续其他的工具加载器、调试器又如何利用它们。
