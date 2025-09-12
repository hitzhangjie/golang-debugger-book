## 编译器和运行时中的基于哈希的二分调试

【注】本文翻译自 Russ Cox 于2024-07-18 发表的一篇文章[《Hash-Based Bisect Debugging in Compilers and Runtimes》](https://research.swtch.com/bisect)。为了本章bisect reduce调试技术的内容完整性，特别引用并翻译该文章来介绍下bisect reduce的算法逻辑。

### [设置舞台](https://research.swtch.com/bisect#setting_the_stage)

这听起来熟悉吗？你对一个库进行更改来优化性能、清理技术债务或修复错误，结果却收到一个错误报告：某个非常庞大、难以理解的测试现在失败了。或者你添加了一个新的编译器优化，结果也差不多。现在你不得不在一个陌生的代码库中进行大量的调试工作。

如果我告诉你存在一根魔法棒，可以精确定位那个陌生代码库中的相关代码行或调用栈，你会怎么想？它确实存在。这是一个真实的工具，我将向你展示它。这个描述可能看起来有点夸张，但每次我使用这个工具时，它真的感觉像魔法一样。不是普通的魔法，而是最好的魔法：即使你完全知道它是如何工作的，观看它仍然令人愉悦。[](https://research.swtch.com/bisect#binary_search_and_bisecting_data)

### [二分搜索和二分数据](https://research.swtch.com/bisect#binary_search_and_bisecting_data)

在介绍新技巧之前，我们先来看看一些更简单、更基础的技术。每个优秀的魔术师都从掌握基本功开始。在我们的场景中，这个基本功就是二分搜索。大多数二分搜索的演示都专注于在排序列表中查找项目，但实际上它有更有趣的用途。这是我很久以前为Go的[`sort.Search`](https://go.dev/pkg/sort/#Search)文档写的一个例子：

```
func GuessingGame() {
    var s string
    fmt.Printf("Pick an integer from 0 to 100.\n")
    answer := sort.Search(100, func(i int) bool {
        fmt.Printf("Is your number <= %d? ", i)
        fmt.Scanf("%s", &s)
        return s != "" && s[0] == 'y'
    })
    fmt.Printf("Your number is %d.\n", answer)
}
```

如果我们运行这段代码，它会和我们玩一个猜数字游戏：

```
% go run guess.go
Pick an integer from 0 to 100.
Is your number <= 50? y
Is your number <= 25? n
Is your number <= 38? y
Is your number <= 32? y
Is your number <= 29? n
Is your number <= 31? n
Your number is 32.
%
```

同样的猜数字游戏也可以应用到调试中。Jon Bentley在他1983年9月在《ACM通讯》上发表的题为"Aha! Algorithms"的《编程珠玑》专栏中，将二分搜索称为"寻找问题的解决方案"。这是他给出的一个例子：

> Roy Weil在清理大约一千张包含一张坏卡片的穿孔卡片时应用了[二分搜索]技术。不幸的是，坏卡片无法通过视觉识别；只能通过将卡片的某个子集运行程序并看到严重错误的答案来识别——这个过程需要几分钟。他的前任们试图通过一次运行几张卡片来解决这个问题，并朝着解决方案稳步（但缓慢）前进。Weil是如何在仅十次程序运行中找到罪魁祸首的？

显然，Weil使用二分搜索玩猜数字游戏。坏卡片在前500张中吗？是的。前250张中吗？不是。以此类推。这是我能够找到的关于通过二分搜索进行调试的最早发表描述。在这种情况下，它是用于调试数据的。[](https://research.swtch.com/bisect#bisecting_version_history)

### [二分版本历史](https://research.swtch.com/bisect#bisecting_version_history)

我们可以将二分搜索应用到程序的版本历史上，而不是数据上。每当我们发现旧程序中出现新错误时，我们就会玩猜数字游戏："这个程序最后一次正常工作是什么时候？"

* 50天前它工作正常吗？是的。
* 25天前它工作正常吗？不是。
* 38天前它工作正常吗？是的。

以此类推，直到我们发现程序最后一次正确工作是在32天前，这意味着错误是在31天前引入的。

通过时间进行二分搜索调试是一个非常古老的技巧，被许多人独立发现了很多次。例如，我们可以使用像`cvs checkout -D '31 days ago'`这样的命令或Plan 9的[更音乐化的](https://9fans.github.io/plan9port/man/man1/yesterday.html)`yesterday -n 31`来玩猜数字游戏。对于一些程序员来说，使用二分搜索来调试数据或通过时间调试的技术似乎"[如此基础，以至于没有必要写下来](https://groups.google.com/g/comp.compilers/c/vGh4s3HBQ-s/m/qmrVKmF5AgAJ)"。但写下技巧是确保每个人都能掌握的第一步：魔术技巧可以是基础的，但不一定是显而易见的。在软件中，写下技巧也是自动化它和构建好工具的第一步。

在1990年代后期，版本历史二分搜索的想法[至少被记录过两次](https://groups.google.com/g/comp.compilers/c/vGh4s3HBQ-s/m/Chvpu7vTAgAJ)。Brian Ness和Viet Ngo在COMPSAC '97（1997年8月）发表了"[通过源代码变更隔离进行回归控制](https://ieeexplore.ieee.org/abstract/document/625082)"，描述了他们在Cray Research构建的一个系统，用于交付更频繁的非回归编译器版本。独立地，Larry McVoy在Linux 1.3.73版本（1996年3月）中发布了一个文件"[Documentation/BUG-HUNTING](https://elixir.bootlin.com/linux/1.3.73/source/Documentation/BUG-HUNTING)"。他捕捉到了这个技巧的神奇之处，即使你对被测试的代码没有特别的专业知识，它也能发挥作用：

> 如果你对内核黑客一无所知，这就是如何追踪错误的方法。这是一种蛮力方法，但效果很好。
>
> 你需要：
>
> * 一个可重现的错误 - 它必须可预测地发生（抱歉）
> * 从工作版本到不工作版本的所有内核tar文件
>
> 然后你将：
>
> * 重新构建一个你认为工作的版本，安装并验证它。
> * 在内核上进行二分搜索，找出哪个版本引入了错误。即，假设1.3.28没有错误，但你知道1.3.69有。选择一个中间的内核并构建它，比如1.3.50。构建和测试；如果它工作，选择.50和.69之间的中点，否则选择.28和.50之间的中点。
> * 你将缩小到引入错误的内核。你可能可以做得比这更好，但这变得棘手。
>
> . . .
>
> 我为向Linus和其他内核黑客描述这种蛮力方法而道歉，这几乎不是内核黑客会做的事情。然而，它确实有效，它让非黑客帮助修复错误。这很酷，因为Linux快照让你可以这样做 - 这是你无法用供应商提供的版本做的事情。

后来，Larry McVoy创建了Bitkeeper，Linux将其用作第一个源代码控制系统。Bitkeeper提供了一种通过提交的有向无环图打印最长直线变更的方法，为二分搜索提供了更细粒度的时间线。当Linus Torvalds创建Git时，他将这个想法进一步发展，推出了[`git rev-list --bisect`](https://github.com/git/git/commit/8b3a1e056f2107deedfdada86046971c9ad7bb87)，这启用了相同类型的手动二分搜索。在添加它几天后，他在Linux内核邮件列表上[解释了如何使用它](https://groups.google.com/g/fa.linux.kernel/c/N4CqlNCvFCY/m/ItQoFhVZyJgJ)：

> 嗯..既然你似乎是git用户，也许你可以尝试git的"bisect"功能来帮助缩小确切发生的位置（并帮助测试那个东西；）。
>
> 你基本上可以使用git找到一组"已知良好"点和"已知错误"点之间的中点（"二分"提交集），只做几次这些应该给我们一个更好的视图，了解事情开始出错的地方。
>
> 例如，既然你知道2.6.12-rc3是好的，而2.6.12是坏的，你会这样做
>
> git-rev-list --bisect v2.6.12 ^v2.6.12-rc3
>
> 其中"v2.6.12 ^v2.6.12-rc3"基本上意味着"v2.6.12中的所有内容但_不是_v2.6.12-rc3中的内容"（这就是^标记的含义），而"--bisect"标志只是要求git-rev-list列出最中间的提交，而不是那些内核版本之间的所有提交。

这个回应引发了一场[关于简化过程的单独讨论](https://groups.google.com/g/fa.linux.kernel/c/cp6abJnEN5U/m/5Z5s14LkzR4J)，最终催生了今天存在的[`git bisect`](https://git-scm.com/docs/git-bisect)工具。

这里有一个例子。我们尝试更新到Go的更新版本，发现一个测试失败了。我们可以使用`git bisect`来精确定位导致失败的特定提交：

```
% git bisect start master go1.21.0
Previous HEAD position was 3b8b550a35 doc: document run..
Switched to branch 'master'
Your branch is ahead of 'origin/master' by 5 commits.
Bisecting: a merge base must be tested
[2639a17f146cc7df0778298c6039156d7ca68202] doc: run rel...
% git bisect run sh -c '
    git clean -df
    cd src
    ./make.bash || exit 125
    cd $HOME/src/rsc.io/tmp/timertest/retry
    go list || exit 0
    go test -count=5
'
```

编写正确的`git bisect`调用需要一些注意，但一旦你做对了，你就可以放手让它自动运行，让`git bisect`施展它的魔法。在这种情况下，我们传递给`git bisect run`的脚本会清理任何过时的文件，然后构建Go工具链（`./make.bash`）。如果那一步失败，它以代码125退出，这是`git bisect`的特殊不确定答案：这个提交有其他问题，我们不能说我们正在寻找的错误是否存在。否则它切换到失败测试的目录。如果`go list`失败，这在bisect使用太旧的Go版本时会发生，脚本成功退出，表示错误不存在。否则脚本运行`go test`并以该命令的状态退出。`-count=5`在那里是因为这是一个不稳定的失败，不总是发生：运行五次足以确保我们观察到错误（如果它存在的话）。

当我们运行这个命令时，`git bisect`打印大量输出，以及我们测试脚本的输出，以确保我们可以看到进度：

```
% git bisect run ...
...
go: download go1.23 for darwin/arm64: toolchain not available
Bisecting: 1360 revisions left to test after this (roughly 10 steps)
[752379113b7c3e2170f790ec8b26d590defc71d1]
    runtime/race: update race syso for PPC64LE
...
go: download go1.23 for darwin/arm64: toolchain not available
Bisecting: 680 revisions left to test after this (roughly 9 steps)
[ff8a2c0ad982ed96aeac42f0c825219752e5d2f6]
    go/types: generate mono.go from types2 source
...
ok      rsc.io/tmp/timertest/retry  10.142s
Bisecting: 340 revisions left to test after this (roughly 8 steps)
[97f1b76b4ba3072ab50d0d248fdce56e73b45baf]
    runtime: optimize timers.cleanHead
...
FAIL    rsc.io/tmp/timertest/retry  22.136s
Bisecting: 169 revisions left to test after this (roughly 7 steps)
[80157f4cff014abb418004c0892f4fe48ee8db2e]
    io: close PipeReader in test
...
ok      rsc.io/tmp/timertest/retry  10.145s
Bisecting: 84 revisions left to test after this (roughly 6 steps)
[8f7df2256e271c8d8d170791c6cd90ba9cc69f5e]
    internal/asan: match runtime.asan{read,write} len parameter type
...
FAIL    rsc.io/tmp/timertest/retry  20.148s
Bisecting: 42 revisions left to test after this (roughly 5 steps)
[c9ed561db438ba413ba8cfac0c292a615bda45a8]
    debug/elf: avoid using binary.Read() in NewFile()
...
FAIL    rsc.io/tmp/timertest/retry  14.146s
Bisecting: 20 revisions left to test after this (roughly 4 steps)
[2965dc989530e1f52d80408503be24ad2582871b]
    runtime: fix lost sleep causing TestZeroTimer flakes
...
FAIL    rsc.io/tmp/timertest/retry  18.152s
Bisecting: 10 revisions left to test after this (roughly 3 steps)
[b2e9221089f37400f309637b205f21af7dcb063b]
    runtime: fix another lock ordering problem
...
ok      rsc.io/tmp/timertest/retry  10.142s
Bisecting: 5 revisions left to test after this (roughly 3 steps)
[418e6d559e80e9d53e4a4c94656e8fb4bf72b343]
    os,internal/godebugs: add missing IncNonDefault calls
...
ok      rsc.io/tmp/timertest/retry  10.163s
Bisecting: 2 revisions left to test after this (roughly 2 steps)
[6133c1e4e202af2b2a6d4873d5a28ea3438e5554]
    internal/trace/v2: support old trace format
...
FAIL    rsc.io/tmp/timertest/retry  22.164s
Bisecting: 0 revisions left to test after this (roughly 1 step)
[508bb17edd04479622fad263cd702deac1c49157]
    time: garbage collect unstopped Tickers and Timers
...
FAIL    rsc.io/tmp/timertest/retry  16.159s
Bisecting: 0 revisions left to test after this (roughly 0 steps)
[74a0e3160d969fac27a65cd79a76214f6d1abbf5]
    time: clean up benchmarks
...
ok      rsc.io/tmp/timertest/retry  10.147s
508bb17edd04479622fad263cd702deac1c49157 is the first bad commit
commit 508bb17edd04479622fad263cd702deac1c49157
Author:     Russ Cox <rsc@golang.org>
AuthorDate: Wed Feb 14 20:36:47 2024 -0500
Commit:     Russ Cox <rsc@golang.org>
CommitDate: Wed Mar 13 21:36:04 2024 +0000

    time: garbage collect unstopped Tickers and Timers
    ...
    This CL adds an undocumented GODEBUG asynctimerchan=1
    that will disable the change. The documentation happens in
    the CL 568341.
    ...

bisect found first bad commit
%
```

这个错误似乎是由我的新的垃圾回收友好的定时器实现引起的，它将在Go 1.23中。*变魔术！*[](https://research.swtch.com/bisect#new_trick)

### [新技巧：二分程序位置](https://research.swtch.com/bisect#new_trick)

`git bisect`识别的罪魁祸首提交是对定时器实现的重大更改。我预期它可能导致微妙的测试失败，所以我包含了一个[GODEBUG设置](https://go.dev/doc/godebug)来在旧实现和新实现之间切换。果然，切换它后错误就消失了：

```
% GODEBUG=asynctimerchan=1 go test -count=5 # old
PASS
ok      rsc.io/tmp/timertest/retry  10.117s
% GODEBUG=asynctimerchan=0 go test -count=5 # new
--- FAIL: TestDo (4.00s)
    ...
--- FAIL: TestDo (6.00s)
    ...
--- FAIL: TestDo (4.00s)
    ...
FAIL    rsc.io/tmp/timertest/retry  18.133s
%
```

知道哪个提交导致了错误，以及关于失败的最少信息，通常足以帮助识别错误。但如果不是呢？如果测试很大很复杂，完全是你从未见过的代码，它以某种难以理解的方式失败，似乎与你的更改无关怎么办？当你从事编译器或低级库的工作时，这种情况经常发生。为此，我们有一个新的魔术技巧：二分程序位置。

也就是说，我们可以在不同的轴上运行二分搜索：在*程序的代码*上，而不是它的版本历史。我们在一个毫无想象力地命名为`bisect`的新工具中实现了这种搜索。当应用于像定时器更改这样的库函数行为时，`bisect`可以搜索所有导致新代码的堆栈跟踪，为某些堆栈启用新代码，为其他堆栈禁用它。通过重复执行，它可以将失败缩小到仅为特定堆栈启用代码：

```
% go install golang.org/x/tools/cmd/bisect@latest
% bisect -godebug asynctimerchan=1 go test -count=5
...
bisect: FOUND failing change set
--- change set #1 (disabling changes causes failure)
internal/godebug.(*Setting).Value()
    /Users/rsc/go/src/internal/godebug/godebug.go:165
time.syncTimer()
    /Users/rsc/go/src/time/sleep.go:25
time.NewTimer()
    /Users/rsc/go/src/time/sleep.go:145
time.After()
    /Users/rsc/go/src/time/sleep.go:203
rsc.io/tmp/timertest/retry.Do()
    /Users/rsc/src/rsc.io/tmp/timertest/retry/retry.go:37
rsc.io/tmp/timertest/retry.TestDo()
    /Users/rsc/src/rsc.io/tmp/timertest/retry/retry_test.go:63
```

这里`bisect`工具报告说，仅对这个调用堆栈禁用`asynctimerchan=1`（即启用新实现）就足以引发测试失败。

调试中最困难的事情之一是反向追踪程序：有一个具有错误值的数据结构，或者控制流走了弯路而不是直路，很难理解它是如何进入那种状态的。相比之下，这个`bisect`工具显示的是事情出错*之前*那一刻的堆栈：堆栈识别了决定测试通过或失败的关键决策点。与困惑地向前看相反，通常很容易在程序执行中向前看，以理解为什么这个特定决策会很重要。此外，在一个巨大的代码库中，二分法已经识别了我们应该开始调试的具体几行。我们可以阅读负责该特定调用序列的代码，并研究为什么新定时器会改变代码的行为。

当你在编译器或运行时上工作，并在一个巨大、陌生的代码库中导致测试失败，然后这个`bisect`工具将原因缩小到几行特定代码时，这真是一种神奇的体验。

这篇文章的其余部分解释了这个`bisect`工具的内部工作原理，这是Keith Randall、David Chase和我在过去十年Go工作中开发和改进的。其他人和其他项目也实现了二分程序位置的想法：我并不是声称我们是第一个发现它的人。然而，我认为我们进一步发展了这种方法，并比其他人更系统化了它。这篇文章记录了我们所学到的，以便其他人可以在我们的努力基础上构建，而不是重新发现它们。[](https://research.swtch.com/bisect#example)

### [例子：二分函数优化](https://research.swtch.com/bisect#example)

让我们从一个简单的例子开始，然后回到堆栈跟踪。假设我们正在开发一个编译器，并且知道一个测试程序只有在启用优化编译时才会失败。我们可以列出程序中所有函数的列表，然后尝试一次禁用一个函数的优化，直到我们找到一个最小的函数集（可能只有一个），其优化会触发错误。不出所料，我们可以使用二分搜索来加速这个过程：

1. 修改编译器，让它打印出它考虑优化的每个函数的列表。
2. 修改编译器，让它接受一个允许优化的函数列表。传递空列表（不优化任何函数）应该使测试通过，而传递完整列表（优化所有函数）应该使测试失败。
3. 使用二分搜索确定可以传递给编译器以使测试失败的最短列表前缀。该列表前缀中的最后一个函数是必须优化以使测试失败的函数之一（但可能不是唯一的）。
4. 强制该函数始终被优化，我们可以重复该过程以找到还必须优化的任何其他函数来引发错误。

例如，假设程序中有十个函数，我们运行这三个二分搜索试验：

![](https://research.swtch.com/hashbisect0func.png)

当我们优化前5个函数时，测试通过。7个？失败。6个？仍然通过。这告诉我们第七个函数`sin`是必须优化以引发失败的函数之一。更准确地说，在优化`sin`的情况下，我们知道列表中后面的函数不需要优化，但我们不知道列表中前面的任何函数是否也必须优化。为了检查前面的位置，我们可以在其他剩余的六个列表条目上运行另一个二分搜索，总是也添加`sin`：

![](https://research.swtch.com/hashbisect0funcstep2.png)

这次，优化前两个（加上硬连线的`sin`）失败，但优化第一个通过，表明`cos`也必须被优化。然后我们只剩下一个可疑位置：`add`。在该单条目列表（加上两个硬连线的`cos`和`sin`）上的二分搜索显示，`add`可以从列表中删除而不会失去失败。

现在我们知道答案了：要导致测试失败的一个局部最小函数集是`cos`和`sin`。通过局部最小，我的意思是从集合中删除任何函数都会使测试失败消失：单独优化`cos`或`sin`是不够的。然而，该集合可能仍然不是全局最小的：也许只优化`tan`会导致不同的失败（或不会）。

可能很想运行更像传统二分搜索的搜索，在每一步将搜索的列表切成两半。也就是说，在确认程序在优化前半部分时通过后，我们可能考虑丢弃列表的那一半，并在另一半上继续二分搜索。应用于我们的例子，该算法将像这样运行：

![](https://research.swtch.com/hashbisect0funcbad.png)

第一次试验通过会建议错误的优化在列表的后半部分，所以我们丢弃前半部分。但现在`cos`永远不会被优化（它刚刚被丢弃），所以所有未来的试验也通过，导致矛盾：我们失去了使程序失败的方法。问题是，只有在我们知道那部分不重要时，丢弃列表的一部分才是合理的。这只有在错误是由优化单个函数引起时才成立，这可能是可能的，但不能保证。如果错误只有在同时优化多个函数时才显现，丢弃一半列表就丢弃了失败。这就是为什么二分搜索通常必须在列表前缀长度上，而不是列表子部分上。[](https://research.swtch.com/bisect#bisect-reduce)

### [Bisect-Reduce](https://research.swtch.com/bisect#bisect-reduce)

我们刚才看到的"重复二分搜索"算法确实有效，但对重复的需要表明二分搜索可能不是正确的核心算法。这里有一个更直接的算法，我将其称为"bisect-reduce"算法，因为它是一个基于二分法的归约。

为简单起见，让我们假设我们有一个全局函数`buggy`，它报告当我们的更改在给定位置列表上启用时是否触发错误：

```
// buggy reports whether the bug is triggered
// by enabling the change at the listed locations.
func buggy(locations []string) bool
```

`BisectReduce`接受一个输入列表`targets`，其中`buggy(targets)`为真，并返回一个局部最小子集`x`，其中`buggy(x)`保持为真。它调用一个更通用的辅助函数`bisect`，它接受一个附加参数：在归约期间保持启用的`forced`位置列表。

```
// BisectReduce returns a locally minimal subset x of targets
// where buggy(x) is true, assuming that buggy(targets) is true.
func BisectReduce(targets []string) []string {
    return bisect(targets, []string{})
}

// bisect returns a locally minimal subset x of targets
// where buggy(x+forced) is true, assuming that
// buggy(targets+forced) is true.
//
// Precondition: buggy(targets+forced) = true.
//
// Postcondition: buggy(result+forced) = true,
// and buggy(x+forced) = false for any x ⊂ result.
func bisect(targets []string, forced []string) []string {
    if len(targets) == 0 || buggy(forced) {
        // Targets are not needed at all.
        return []string{}
    }
    if len(targets) == 1 {
        // Reduced list to a single required entry.
        return []string{targets[0]}
    }

    // Split targets in half and reduce each side separately.
    m := len(targets)/2
    left, right := targets[:m], targets[m:]
    leftReduced := bisect(left, slices.Concat(right, forced))
    rightReduced := bisect(right, slices.Concat(leftReduced, forced))
    return slices.Concat(leftReduced, rightReduced)
}
```

像任何好的分治算法一样，几行代码做了很多工作：

* 如果目标列表已被归约为空，或者如果`buggy(forced)`（没有任何目标）为真，那么我们可以返回一个空列表。否则我们知道需要目标中的某些东西。
* 如果目标列表是单个条目，那么该条目就是需要的：我们可以返回一个单元素列表。
* 否则，递归情况：将目标列表分成两半，分别归约每一半。注意在归约`right`时强制`leftReduced`（而不是`left`）很重要。

应用于函数优化例子，`BisectReduce`最终会调用

```
bisect([add cos div exp mod mul sin sqr sub tan], [])
```

这将把目标列表分成

```
left = [add cos div exp mod]
right = [mul sin sqr sub tan]
```

递归调用计算：

```
bisect([add cos div exp mod], [mul sin sqr sub tan]) = [cos]
bisect([mul sin sqr sub tan], [cos]) = [sin]
```

然后`return`将两半放在一起：`[cos sin]`。

我们一直在考虑的`BisectReduce`版本是我知道的最短的；让我们称它为"短算法"。一个更长的版本处理错误包含在一半中的"简单"情况，然后是需要两半部分的"困难"情况。让我们称它为"简单/困难算法"：

```
// BisectReduce returns a locally minimal subset x of targets
// where buggy(x) is true, assuming that buggy(targets) is true.
func BisectReduce(targets []string) []string {
    if len(targets) == 0 || buggy(nil) {
        return nil
    }
    return bisect(targets, []string{})
}

// bisect returns a locally minimal subset x of targets
// where buggy(x+forced) is true, assuming that
// buggy(targets+forced) is true.
//
// Precondition: buggy(targets+forced) = true,
// and buggy(forced) = false.
//
// Postcondition: buggy(result+forced) = true,
// and buggy(x+forced) = false for any x ⊂ result.
// Also, if there are any valid single-element results,
// then bisect returns one of them.
func bisect(targets []string, forced []string) []string {
    if len(targets) == 1 {
        // Reduced list to a single required entry.
        return []string{targets[0]}
    }

    // Split targets in half.
    m := len(targets)/2
    left, right := targets[:m], targets[m:]

    // If either half is sufficient by itself, focus there.
    if buggy(slices.Concat(left, forced)) {
        return bisect(left, forced)
    }
    if buggy(slices.Concat(right, forced)) {
        return bisect(right, forced)
    }

    // Otherwise need parts of both halves.
    leftReduced := bisect(left, slices.Concat(right, forced))
    rightReduced := bisect(right, slices.Concat(leftReduced, forced))
    return slices.Concat(leftReduced, rightReduced)
}
```

与短算法相比，简单/困难算法有两个好处和一个缺点。

一个好处是简单/困难算法更直接地映射到我们对二分应该做什么的直觉：尝试一边，尝试另一边，回退到两边的某种组合。相比之下，短算法总是依赖于一般情况，更难理解。

简单/困难算法的另一个好处是它保证在存在时找到单一罪魁祸首答案。由于大多数错误可以归约为单一罪魁祸首，保证在存在时找到一个使调试会话更容易。假设优化`tan`会触发测试失败，简单/困难算法会尝试

```
buggy([add cos div exp mod]) = false // left
buggy([mul sin sqr sub tan]) = true  // right
```

然后会丢弃左侧，专注于右侧，最终找到`[tan]`，而不是`[sin cos]`。

缺点是，因为简单/困难算法不经常依赖一般情况，一般情况需要更仔细的测试，更容易在不知不觉中出错。例如，Andreas Zeller 1999年的论文"[昨天，我的程序工作了。今天，它没有。为什么？](https://dl.acm.org/doi/10.1145/318774.318946)"给出了应该是bisect-reduce算法的简单/困难版本，作为在独立程序更改上进行二分的方法，除了算法有一个错误：在"困难"情况下，`right`二分强制`left`而不是`leftReduced`。结果是，如果有两个罪魁祸首对跨越`left`/`right`边界，归约可以从每对中选择一个罪魁祸首，而不是匹配的对。简单的测试用例都由简单情况处理，掩盖了错误。相比之下，如果我们将相同的错误插入到短算法的一般情况中，非常简单的测试用例就会失败。

实际实现更适合简单/困难算法，但它们必须小心正确实现它。[](https://research.swtch.com/bisect#list-based_bisect-reduce)

### [基于列表的Bisect-Reduce](https://research.swtch.com/bisect#list-based_bisect-reduce)

既然已经建立了算法，现在让我们转向将其连接到编译器的细节。我们究竟如何获得源代码位置列表，以及如何将其反馈给编译器？

最直接的答案是实现一个调试模式，打印所讨论优化的完整位置列表，以及另一个调试模式，接受一个指示允许优化的位置的列表。[Meta的Python Cinder JIT](https://bernsteinbear.com/blog/cinder-jit-bisect/)，发表于2021年，采用这种方法来决定哪些函数用JIT编译（而不是解释）。它的[`Tools/scripts/jitlist_bisect.py`](https://github.com/facebookincubator/cinder/blob/cinder/3.10/Tools/scripts/jitlist_bisect.py)是我所知道的bisect-reduce算法的最早正确发布版本，使用简单/困难形式。

这种方法的唯一缺点是列表的潜在大小，特别是因为二分调试对于减少非常大的程序中的失败至关重要。如果有某种方法可以减少每次迭代必须发送回编译器的数据量，那将是有帮助的。在复杂的构建系统中，函数列表可能太大，无法在命令行或环境变量中传递，并且可能很难甚至不可能安排将新的输入文件传递给每个编译器调用。能够将目标列表指定为短命令行参数的方法在实践中更容易使用。[](https://research.swtch.com/bisect#counter-based_bisect-reduce)

### [基于计数器的Bisect-Reduce](https://research.swtch.com/bisect#counter-based_bisect-reduce)

Java的HotSpot C2即时（JIT）编译器提供了一个调试机制来控制哪些函数用JIT编译，但与Cinder中使用显式函数列表不同，HotSpot在考虑函数时对它们进行编号。编译器标志`-XX:CIStart`和`-XX:CIStop`设置符合编译条件的函数编号范围。这些标志[今天仍然存在（在调试构建中）](https://github.com/openjdk/jdk/blob/151ef5d4d261c9fc740d3ccd64a70d3b9ccc1ab5/src/hotspot/share/compiler/compileBroker.cpp#L1569)，你可以在[至少追溯到2000年初的Java错误报告](https://bugs.java.com/bugdatabase/view_bug?bug_id=4311720)中找到它们的使用。

对函数编号至少有两个限制。

第一个限制是轻微的，容易修复：只允许单个连续范围启用单个罪魁祸首的二分搜索，但不启用多个罪魁祸首的一般bisect-reduce。要启用bisect-reduce，接受整数范围列表就足够了，比如`-XX:CIAllow=1-5,7-10,12,15`。

第二个限制更严重：很难保持编号在运行之间稳定。像并行编译函数这样的实现策略可能意味着基于线程交错以不同顺序考虑函数。在JIT的上下文中，即使是线程运行时执行也可能改变函数被考虑编译的顺序。二十五年前，线程很少使用，这个限制可能不是一个大问题。今天，假设一致的功能编号是一个阻碍。[](https://research.swtch.com/bisect#hash-based_bisect-reduce)

### [基于哈希的Bisect-Reduce](https://research.swtch.com/bisect#hash-based_bisect-reduce)

保持位置列表隐式的另一种方法是将每个位置哈希为（看起来随机的）整数，然后使用位后缀来识别位置集。哈希计算不依赖于遇到源代码位置的序列，使哈希与并行编译、线程交错等兼容。哈希有效地将函数排列成二叉树：

![](https://research.swtch.com/hashbisect1.png)

寻找单个罪魁祸首是沿着树向下走的基本过程。更好的是，一般的bisect-reduce算法很容易适应哈希后缀模式。首先我们必须调整`buggy`的定义：我们需要它告诉我们正在考虑的后缀的匹配数量，这样我们就知道是否可以停止归约情况：

```
// buggy reports whether the bug is triggered
// by enabling the change at the locations with
// hashes ending in suffix or any of the extra suffixes.
// It also returns the number of locations found that
// end in suffix (only suffix, ignoring extra).
func buggy(suffix string, extra []string) (fail bool, n int)
```

现在我们可以或多或少直接翻译简单/困难算法：

```
// BisectReduce returns a locally minimal list of hash suffixes,
// each of which uniquely identifies a single location hash,
// such that buggy(list) is true.
func BisectReduce() []string {
    if fail, _ := buggy("none", nil); fail {
        return nil
    }
    return bisect("", []string{})
}

// bisect returns a locally minimal list of hash suffixes,
// each of which uniquely identifies a single location hash,
// and all of which end in suffix,
// such that buggy(result+forced) = true.
//
// Precondition: buggy(suffix, forced) = true, _.
// and buggy("none", forced) = false, 0.
//
// Postcondition: buggy("none", result+forced) = true, 0;
// each suffix in result matches a single location hash;
// and buggy("none", x+forced) = false for any x ⊂ result.
// Also, if there are any valid single-element results,
// then bisect returns one of them.
func bisect(suffix string, forced []string) []string {
    if _, n := buggy(suffix, forced); n == 1 {
        // Suffix identifies a single location.
        return []string{suffix}
    }

    // If either of 0suffix or 1suffix is sufficient
    // by itself, focus there.
    if fail, _ := buggy("0"+suffix, forced); fail {
        return bisect("0"+suffix, forced)
    }
    if fail, _ := buggy("1"+suffix, forced); fail {
        return bisect("1"+suffix, forced)
    }

    // Matches from both extensions are needed.
    // Otherwise need parts of both halves.
    leftReduced := bisect("0"+suffix,
        slices.Concat([]string{"1"+suffix"}, forced))
    rightReduced := bisect("1"+suffix,
        slices.Concat(leftReduced, forced))
    return slices.Concat(leftReduce, rightReduce)
}
```

细心的读者可能会注意到，在简单情况下，对`bisect`的递归调用通过重复调用者所做的相同`buggy`调用来开始，这次是为了计算所讨论后缀的匹配数量。高效的实现可以将该运行的结果传递给递归调用，避免冗余试验。

在这个版本中，`bisect`不保证在递归的每一层将搜索空间切成两半。相反，哈希的随机性意味着它平均将搜索空间大致切成两半。当只有少数罪魁祸首时，这仍然足以实现对数行为。如果后缀应用于匹配一致的顺序编号而不是哈希，算法也能正确工作；唯一的问题是获得编号。

哈希后缀与函数编号范围一样短，很容易在命令行上传递。例如，假设的Java编译器可以使用`-XX:CIAllowHash=000,10,111`。[](https://research.swtch.com/bisect#use_case)

### [用例：函数选择](https://research.swtch.com/bisect#use_case)

Go中基于哈希的bisect-reduce的最早使用是用于选择函数，就像我们一直在考虑的例子一样。2015年，Keith Randall正在为Go编译器开发一个新的SSA后端。新旧后端共存，编译器可以为正在编译的程序中的任何给定函数使用其中任何一个。Keith引入了一个[环境变量GOSSAHASH](https://go.googlesource.com/go/+/e3869a6b65bb0f95dac7eca3d86055160b12589f)，它指定应该使用新后端的函数名哈希的最后几个二进制数字：GOSSAHASH=0110意味着"只编译那些名称哈希到最后四位为0110的值的函数。"当测试在新后端上失败时，调试测试用例的人尝试GOSSAHASH=0和GOSSAHASH=1，然后使用二分搜索逐步细化模式，将失败缩小到只有一个函数用新后端编译。这对于处理我们没有编写和理解的巨大现实世界测试（库或生产代码的测试，而不是编译器的测试）中的失败是无价的。该方法假设失败总是可以归约为单个罪魁祸首函数。

令人着迷的是，HotSpot、Cinder和Go都想到了使用二分搜索来查找编译器中的错误编译函数，但三者使用了不同的选择机制（计数器、函数列表和哈希）。[](https://research.swtch.com/bisect#use_case)

### [用例：SSA重写选择](https://research.swtch.com/bisect#use_case)

2016年底，David Chase正在调试一个新的优化器重写规则，它应该是正确的，但导致了神秘的测试失败。他[重用了相同的技术](https://go-review.googlesource.com/29273)，但粒度更细：位模式现在控制重写规则可以在哪些函数中使用。

David还编写了[工具`gossahash`的初始版本](https://github.com/dr2chase/gossahash/tree/e0bba144af8b1cc8325650ea8fbe3a5c946eb138)，用于承担二分搜索的工作。虽然`gossahash`只寻找单个失败，但它非常有用。它服务了很多年，最终成为了`bisect`。[](https://research.swtch.com/bisect#use_case)

### [用例：融合乘加](https://research.swtch.com/bisect#use_case)

拥有一个可用的工具，而不是需要手动二分，让我们不断找到可以解决的问题。2022年，另一个问题出现了。我们更新了Go编译器以在新架构上使用浮点融合乘加（FMA）指令，一些测试失败了。通过使FMA重写依赖于包含当前文件名和行号的哈希后缀，我们可以应用bisect-reduce来识别FMA指令破坏测试的源代码中的特定行。

例如，这个二分法发现`b.go:7`是罪魁祸首行：

![](https://research.swtch.com/hashbisect0.png)

FMA不是大多数程序员遇到的东西。如果他们确实遇到FMA引起的测试失败，拥有一个自动识别确切罪魁祸首行的工具是无价的。[](https://research.swtch.com/bisect#use_case)

### [用例：语言更改](https://research.swtch.com/bisect#use_case)

下一个出现的问题是语言更改。Go，像C#和JavaScript一样，艰难地学会了循环作用域循环变量与闭包和并发性不能很好地混合。像这些语言一样，Go最近改为[迭代作用域循环变量](https://go.dev/blog/loopvar-preview)，在此过程中纠正了许多有错误的程序。

不幸的是，有时测试无意中检查了有错误的行为。在大型代码库中部署循环更改时，我们在复杂、陌生的代码中遇到了真正神秘的失败。将循环更改条件化在源文件名和行号的哈希后缀上，使bisect-reduce能够精确定位触发测试失败的特定循环或循环。我们甚至发现了一些情况，其中更改任何一个循环都不会导致失败，但更改特定的循环对会。在实践中，找到多个罪魁祸首的通用性是必要的。

没有自动诊断，循环更改会更加困难。[](https://research.swtch.com/bisect#use_case)

### [用例：库更改](https://research.swtch.com/bisect#use_case)

Bisect-reduce也适用于库更改：我们可以哈希调用者，或者更准确地说是调用堆栈，然后基于哈希后缀在旧实现和新实现之间选择。

例如，假设你添加了一个新的排序实现，一个大程序失败了。假设排序是正确的，问题几乎肯定是新排序和旧排序在比较相等的某些值的最终顺序上存在分歧。或者也许排序有错误。无论哪种方式，大程序可能在许多不同的地方调用排序。在调用堆栈的哈希上运行bisect-reduce将识别使用新排序导致失败的确切调用堆栈。这就是文章开头例子中发生的事情，用新的定时器实现而不是新的排序。

调用堆栈是一个只适用于哈希而不适用于顺序编号的用例。对于到目前为止的例子，设置过程可以给程序中的所有函数编号或给呈现给编译器的所有源代码行编号，然后bisect-reduce可以应用于序列号的二进制后缀。但是没有程序将遇到的所有可能调用堆栈的密集顺序编号。另一方面，哈希程序计数器列表是微不足道的。

我们意识到bisect-reduce将适用于库更改，大约在我们引入[GODEBUG机制](https://go.dev/doc/godebug)的时候，它提供了一个框架来跟踪和切换这些兼容但破坏性的更改。我们安排该框架自动为所有GODEBUG设置提供`bisect`支持。

对于Go 1.23，我们重写了[time.Timer](https://go.dev/pkg/time/#Timer)实现并稍微改变了其语义，以消除现有API中的一些竞争条件，并在某些常见情况下启用更早的垃圾回收。新实现的一个效果是非常短的定时器触发更可靠。以前，0ns或1ns定时器（经常在测试中使用）可能需要许多微秒才能触发。现在，它们按时触发。但当然，存在有错误的代码（主要在测试中），当定时器开始按应该的时间触发时会失败。我们在Google的源代码树中调试了十几个这样的问题——它们都很复杂和陌生——`bisect`使这个过程变得轻松，甚至可能很有趣。

对于一个失败的测试用例，我犯了一个错误。测试看起来足够简单，可以用肉眼观察，所以我花了半个小时困惑地思考测试代码中唯一的定时器，一个硬编码的一分钟定时器，怎么可能受到新实现的影响。最终我放弃了，运行了`bisect`。堆栈跟踪立即显示有一个测试中间件层正在将一分钟超时重写为1ns超时以加速测试。工具看到了人们看不到的东西。[](https://research.swtch.com/bisect#interesting_lessons_learned)

### [学到的有趣经验](https://research.swtch.com/bisect#interesting_lessons_learned)

我们在开发`bisect`时学到的一件有趣的事情是，尝试检测不稳定的测试很重要。在调试循环更改失败的早期，`bisect`指向加密包中一个完全正确、微不足道的循环。起初，我们非常害怕：如果*那个*循环正在改变行为，编译器中的某些东西一定非常错误。我们意识到问题是不稳定的测试。随机失败的测试导致`bisect`在源代码上进行随机游走，最终指向完全无辜的代码。之后，我们向`bisect`添加了一个`-count=N`标志，使其运行每个试验*N*次，如果它们不一致就完全退出。我们将默认值设置为`-count=2`，这样`bisect`总是进行基本的不稳定性检查。

不稳定的测试仍然是一个需要更多工作的领域。如果要调试的问题是测试从可靠通过变为一半时间失败，运行`go test -count=5`通过运行测试五次来增加失败的机会。同样，使用像这样的小shell脚本可能会有帮助：

```
% cat bin/allpass
##!/bin/sh
n=$1
shift
for i in $(seq $n); do
    "$@" || exit 1
done
```

然后可以这样调用`bisect`：

```
% bisect -godebug=timer allpass 5 ./flakytest
```

现在bisect只看到`./flakytest`连续通过五次作为成功运行。

类似地，如果测试从不可靠地通过变为一直失败，可以使用`anypass`变体：

```
% cat bin/anypass
##!/bin/sh
n=$1
shift
for i in $(seq $n); do
    "$@" && exit 0
done
exit 1
```

如果更改使测试永远运行而不是失败，[`timeout`命令](https://man7.org/linux/man-pages/man1/timeout.1.html)也很有用。

基于工具的处理不稳定性的方法工作得不错，但似乎不是一个完整的解决方案。在`bisect`内部采用更有原则的方法会更好。我们仍在研究那会是什么。

我们学到的另一件有趣的事情是，当在运行时更改上进行二分时，哈希决策做得如此频繁，以至于在bisect-reduce的每个阶段打印每个决策的完整堆栈跟踪太昂贵了（第一次运行使用匹配每个哈希的空后缀！）相反，bisect哈希模式默认为"安静"模式，其中每个决策只打印哈希位，因为这就是`bisect`引导搜索和缩小相关堆栈所需的全部。一旦`bisect`识别出最小相关堆栈集，它就会在"详细"模式下再次运行测试。这导致bisect库打印哈希位和相应的堆栈跟踪，`bisect`在其报告中显示这些堆栈跟踪。[](https://research.swtch.com/bisect#try_bisect)

### [尝试Bisect](https://research.swtch.com/bisect#try_bisect)

[`bisect`工具](https://pkg.go.dev/golang.org/x/tools/cmd/bisect)今天就可以下载和使用：

```
% go install golang.org/x/tools/cmd/bisect@latest
```

如果你正在调试Go 1.22中的[循环变量问题](https://go.dev/wiki/LoopvarExperiment)，你可以使用这样的命令：

```
% bisect -compile=loopvar go test
```

如果你正在调试[Go 1.23中的定时器问题](https://go.dev/change/966609ad9e82ba173bcc8f57f4bfc35a86a62c8a)，你可以使用：

```
% bisect -godebug asynctimerchan=1 go test
```

`-compile`和`-godebug`标志是便利功能。命令的一般形式是

```
% bisect [KEY=value...] cmd [args...]
```

其中前导的`KEY=value`参数在调用带有剩余参数的命令之前设置环境变量。`Bisect`期望在其命令行某处找到字面字符串`PATTERN`，每次重复命令时它都会用哈希模式替换该字符串。

你可以使用`bisect`来调试你自己的编译器或库中的问题，方法是让它们接受环境变量或命令行中的哈希模式，然后在标准输出或标准错误上为`bisect`打印特殊格式的行。最简单的方法是使用[bisect包](https://pkg.go.dev/golang.org/x/tools/internal/bisect)。该包还不能直接导入（有一个[待定提案](https://go.dev/issue/67140)将其添加到Go标准库），但该包只是一个[没有导入的单个文件](https://cs.opensource.google/go/x/tools/+/master:internal/bisect/bisect.go)，所以很容易复制到新项目中，甚至翻译成其他语言。包文档还记录了哈希模式语法和所需的输出格式。

如果你从事编译器或库的工作，并且需要调试为什么你做的看似正确的更改破坏了复杂程序，试试`bisect`。它永远不会停止感觉像魔法。

### 本节小结

本节主要探讨了编译器和运行时中的基于哈希的二分调试技术，核心内容包括：二分搜索在调试中的应用历史；从版本历史二分到程序位置二分的演进；bisect-reduce算法的设计原理和实现细节；基于哈希的位置选择机制及其优势；在实际项目中的多种应用场景。本节内容为读者理解现代调试工具的设计思路和实现方法提供了重要参考，展示了如何将经典的二分搜索算法创新性地应用于复杂的软件调试场景中。

### 参考内容

1. hash-based bisect debugging in compilers and runtimes, https://research.swtch.com/bisect
2. vscode extension bisect, https://code.visualstudio.com/blogs/2021/02/16/extension-bisect
3. git bisect, https://git-scm.com/docs/git-bisect
