## 如何跟踪DWARF生成过程

本章节开头我们介绍了 `go build` 执行期间实际调用的工具列表，DWARF调试信息生成逻辑是由compile、link生成的，本文介绍下编译器compile中生成DWARF调试信息的大致过程。

对于一个相对比较陌生的项目，大家可能会通过走读代码、调试器跟踪执行来大致了解其执行过程。

### 走读代码的方式

这可能是我们首先想到的方式，走读代码可以掌握主流程以及边边角角的细节。但代码量比较大时，就需要注意排除一些无关代码，否则容易迷失在代码中。如果读者项目不熟，那就更让人头大了。

以go为例，编译工具链进考虑编译器、链接器，go源码行数高达44w。尽管作者对这部分代码已经比较熟悉了，但是如果不借助任何工具，走读代码还是会有“迷失在森林”中的感觉。

```bash
path-to/go/src/cmd $ cloc compile/ link/

     877 text files.
     853 unique files.                                        
      34 files ignored.

github.com/AlDanial/cloc v 2.01  T=1.00 s (853.0 files/s, 561112.0 lines/s)
--------------------------------------------------------------------------------
Language                      files          blank        comment           code
--------------------------------------------------------------------------------
Go                              810          28854          72117         442276
Snakemake                        20           1968              0          13760
Markdown                          4            379             23           1313
Text                              6             60              0            146
Assembly                          9             21             35             92
Objective-C                       1              2              3             11
Bourne Shell                      1              5              6             10
Bourne Again Shell                1              7             10              9
MATLAB                            1              1              0              4
--------------------------------------------------------------------------------
SUM:                            853          31297          72194         457621
--------------------------------------------------------------------------------
```

分享几个走读代码时我常用的vscode插件，对于应对这种中大型工程、流程长的处理逻辑时非常有帮助：

- bookmarks：拉一个分支 notes/go1.24, 走读代码时即时添加书签，书签命名、描述遵循一定的格式，如：`"分类": "书签描述"`。这样后续查看起来就方便多了。
- codetour：拉一个分支 notes/go1.24，可以针对一个特定的流程，对关心的流程细节进行记录，首先创建一个tour，然后中途记录每个step添加描述，后续就可以一步步地回放流程中关键的步骤。

我们添加的书签、tours，都是存储在项目分支的 .vscode/ 目录下，记得提交入库，这样换台设备阅读代码时，可以无缝衔接，作者已经这样使用了多年，个人感觉还是非常有帮助的。

### 调试跟踪的方式

调试器跟踪可以跳过代码中很多执行不到的分支逻辑，但是比较特殊的是，go编译工具链发行版本中是去掉了DWARF的，所以你如果想调试go编译工具链本身普遍会因为缺少DWARF调试信息而导致无法调试。

一个解决办法是，从源码重新构建编译工具链：

```bash
# 下载go源码并检出标签go1.24.0
git clone https://github.com/golang/go
cd go
git checkout go1.24.0

# 改写VERSION首行，time行保留。首行不能以go或release.开头，
# 否则cmd/dist按发行版构建，会加上-w和-dwarf=false，compile、link里就没有DWARF。
sed -i '1s|.*|notes/go1.24.0|' VERSION

# 编译构建，构建产物会输出到 path-to/go/bin 以及 path-to/go/pkg/tool/ 目录下
cd src
./make.bash
```

构建完成后，可以查看构建产物：

```
ls ../bin/ ../pkg/tool/linux_amd64/
../bin/:
go  gofmt

../pkg/tool/linux_amd64/:
addr2line  buildid  compile  cover  distpack  fix   nm       pack   preprofile  trace
asm        cgo      covdata  dist   doc       link  objdump  pprof  test2json   vet
```

此时使用 `readelf -S ../pkg/tool/linux_amd64/compile | grep debug` 可以看到程序中已经包含了DWARF调试信息，可以使用调试器跟踪了。

### ebpf跟踪的方式

了解我的同学，都知道我是一个喜欢不断打破边界的人，我不喜欢职场中那些搞信息壁垒的做法，我喜欢OpenMinded，包括服务架构中存在的风险，我不喜欢以个人笔记的方式进行管理，我喜欢以issue的方式进行公开讨论。因为我更倾向于相信，如果一个人拥有的信息足够多，他就能够做出越来越合理的决策。对于个人成长，对于团队成长，都是非常棒的。因为我常年浪迹于开源社区，我非常明白Open对于激发一个个优秀的个体的潜力有多大的作用。但是有些人喜欢喜欢偷偷摸摸的干，开小会，问问题只问答案不交代背景，手里资料也“舍不得”公开，负责模块的问题也愿让人知道，这让我不是很喜欢。

当我的领导让我朝着TechLead这个方向努力时，我就开始落地我的一系列理念。

1. 系统问题你不是想藏着掖着吗？OK，那从监控平台拉出主调、被调维度的模调监控数据，建立SLA看板，让每个人名下的每个服务的每个接口的成功率完全暴漏在看板下；
2. 方案问题你不是想藏着掖着吗？OK，那建立wiki空间，将所有团队的各个子系统的系统设计、里程碑计划、跟进进度，全部给我搬上去；
3. 你们不是喜欢不暴漏问题、不讨论问题、自己“偷偷”修改代码吗？OK，那精细化管理项目组成员的代码push、merge权限，代码提交必须关联--story|--bug|--task等需求、问题、任务信息，否则拒绝push。
4. 服务接口处理耗时不是经常性偏久，但是排查不出处理流程中哪个问题导致的吗，OK，RPC框架层统一接入opentelemetry，在tracing可视化界面下，问题环节直接暴漏出来；
5. 更甚至，压测环节会关闭对外部系统opentelemtry的影响，有时候接口耗时久开发同学含含糊糊的说辞，令我很不满意，OK，那在每台机器上部署ebpf程序go-ftrace，只要我想看，我可以分析处理逻辑中每个环节的耗时。
6. ...
7. ...
8. ...
9. ...
10. ...

"新人不知我过往，过往不与新人讲" ... 哈哈哈，确实还是做了不少工作，收回来看看我写的go-ftrace的跟踪效果：

```bash
$ sudo ftrace -u 'main.*' -u 'fmt.Print*' ./main 'main.(*Student).String(s.name=(*+0(%ax)):c64, s.name.len=(+8(%ax)):s64, s.age=(+16(%ax)):s64)'
WARN[0000] skip main.main, failed to get ret offsets: no ret offsets 
found 14 uprobes, large number of uprobes (>1000) need long time for attaching and detaching, continue? [Y/n]

>>> press `y` to continue
y
add arg rule at 47cc40: {Type:1 Reg:0 Size:8 Length:1 Offsets:[0 0 0 0 0 0 0 0] Deference:[1 0 0 0 0 0 0 0]}
add arg rule at 47cc40: {Type:1 Reg:0 Size:8 Length:1 Offsets:[8 0 0 0 0 0 0 0] Deference:[0 0 0 0 0 0 0 0]}
add arg rule at 47cc40: {Type:1 Reg:0 Size:8 Length:1 Offsets:[16 0 0 0 0 0 0 0] Deference:[0 0 0 0 0 0 0 0]}
INFO[0002] start tracing                              

...

                           🔬 You can inspect all nested function calls, when and where started or finished
23 17:11:00.0890           main.doSomething() { main.main+15 github/go-ftrace/examples/main.go:10
23 17:11:00.0890             main.add() { main.doSomething+37 github/go-ftrace/examples/main.go:15
23 17:11:00.0890               main.add1() { main.add+149 github/go-ftrace/examples/main.go:27
23 17:11:00.0890                 main.add3() { main.add1+149 github/go-ftrace/examples/main.go:40
23 17:11:00.0890 000.0000        } main.add3+148 github/go-ftrace/examples/main.go:46
23 17:11:00.0890 000.0000      } main.add1+154 github/go-ftrace/examples/main.go:33
23 17:11:00.0890 000.0001    } main.add+154 github/go-ftrace/examples/main.go:27
23 17:11:00.0890             main.minus() { main.doSomething+52 github/go-ftrace/examples/main.go:16
23 17:11:00.0890 000.0000    } main.minus+3 github/go-ftrace/examples/main.go:51

                            🔍 Here, member fields of function receiver extracted, receiver is the 1st argument actually.
23 17:11:00.0891             main.(*Student).String(s.name=zhang<ni, s.name.len=5, s.age=100) { fmt.(*pp).handleMethods+690 /opt/go/src/fmt/print.go:673
23 17:11:00.0891 000.0000    } main.(*Student).String+138 github/go-ftrace/examples/main.go:64
23 17:11:01.0895 001.0005  } main.doSomething+180 github/go-ftrace/examples/main.go:22
                 ⏱️ Here, timecost is displayed at the end of the function call

...

>>> press `Ctrl+C` to quit.

INFO[0007] start detaching                            
detaching 16/16
```

这个基于ebpf实现的跟踪工具，可以用来分析go源码执行历程，你不需要走读代码这么机械，也不需要使用调试器去控制执行，你只需要用go-ftrace去跟踪一遍程序执行，它就可以把执行期间走过的所有函数给输出出来。然后可以有的放矢的去看看源码，事半功倍！

#### LLM 如虎添翼

哈哈哈，现在 LLM 也是一个非常好的办法，“hi，请给我解释下这段代码”。确实，我现在也经常使用这种方法，而且通常都有非常正向的帮助。

这些是我日常经常使用的一些AI产品和大模型：

- Website: claude.ai / you.com / chatgpt.com / gemini.google.com / sourcegraph.com
- App: 腾讯元宝 / 豆包 / kimi / gemini
- LLM: claude / gpt-4o / qwen2.5 / gemma3 / deepseek / hunyuan
- VSCode Extension: continue / copilot / cody ai / ...
- Chrome Extension: Page Assist
- Self-Hosted: Open-WebUI

#### 其他方式

开发者的智慧，不是我能枚举的完的，我列举的是我个人职业生涯中一些经验，如果你有更好的了解程序执行流的方法，也可以分享一下。

### 总结

有可能读者最初是想了解下调试器开发，但是读到这几个小节，因为我们用不少篇幅介绍了go编译工具链，大家可能也想去了解下go编译工具链、go运行时、go标准库的设计实现。作者当然理解一个喜欢钻研技术的同学有多么想穷尽所有细节，我理解，所以我分享了在我过去类似工作学习中认为还不错的掌握中大型工程“细节”的一些方法，如果你真的有这个必要。不同于业务代码中的一些相对简单的CRUD逻辑，不是看看文档、PPT、听别人口述个大概就可以说OK的，有些项目讲究的就是一个“精确”“严谨”，我非常欣赏那些愿意投入个人时间在这些枯燥的细节上稳扎稳打的技术人。你们在这些地方的投入，最终会不断丰满你们的羽翼，让你们飞的更高。

ps: 我说的更高，并不是世俗上认为的成功，而是一种“超越”。
