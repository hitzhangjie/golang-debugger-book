## Appendix: 使用二分查找解决扩展问题

[来源](https://code.visualstudio.com/blogs/2021/02/16/extension-bisect "Permalink to Resolving extension issues with bisect")

2021年2月16日，作者：Johannes Rieken，[@johannesrieken](https://twitter.com/johannesrieken)

> "就像 git-bisect 一样，但适用于 VS Code 扩展。"

Visual Studio Code 的真正威力在于其扩展：主题扩展添加颜色和图标，语言扩展启用智能代码补全（IntelliSense）和导航，调试器扩展让你能够运行代码并轻松找到错误。有些扩展播放音乐，有些显示股票行情，还有一些扩展支持跨地点和时区的协作工作。VS Code [市场](https://marketplace.visualstudio.com/vscode)托管着超过 28,000 个扩展，用户安装 50 个或更多扩展并不罕见。有如此多的扩展，出现错误是不可避免的。与其否认这一点，我们更希望让故障排除变得简单。

### ["问题"扩展](https://code.visualstudio.com/blogs/2021/02/16/extension-bisect#_bad-extensions)

我们热爱扩展，并不认为真的存在"问题"扩展。然而，就像所有软件一样，扩展也有错误和功能缺陷。因此，为了阅读便利和增加戏剧效果，让我们使用"问题扩展"这个术语，指的是可能会崩溃或显示不期望行为的扩展。幸运的是，我们在设计 VS Code 时考虑了"问题"扩展的存在，因此将它们运行在单独的[进程](https://code.visualstudio.com/api/advanced-topics/extension-host)中。这种隔离保证了 VS Code 继续运行，光标始终闪烁，你总是能够保存你的工作。

为了好玩，也为了让扩展二分查找的演示更容易，我们创建并发布了 [Extension Bisect Demo](https://marketplace.visualstudio.com/items?itemName=jrieken.bisectdemo) 扩展。安装后，每当你输入"bisect"这个词时，它会烦人地重置你的光标。你可以使用这个扩展来跟随这篇博客文章。

### [用困难的方式找到"问题"扩展](https://code.visualstudio.com/blogs/2021/02/16/extension-bisect#_finding-a-bad-extension-the-hard-way)

如今，找到"问题"扩展可能很容易，也可能很困难。打开扩展视图（Ctrl+Shift+X），[禁用扩展](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_disable-an-extension)，重新加载窗口（**开发者：重新加载窗口**），然后检查问题是否仍然存在。如果问题消失了，那个扩展就是"问题"扩展，你就完成了。否则，重新启用该扩展并对下一个扩展重复此过程。

![逐步禁用扩展](https://code.visualstudio.com/assets/blogs/2021/02/16/disable_manually.png)

如果你幸运的话，第一个扩展就是"问题"扩展；如果你不幸的话，它就是最后一个扩展。用计算机科学的语言来说，这意味着对于 `N` 个扩展，你在最坏情况下需要重复这个过程 `O(N)` 次（N 阶），平均情况下是 `O(N/2)` 次。因为这个算法是由人类（你）操作的，即使 `N` 值很小也很费力。这就是 **扩展二分查找** 工具派上用场的地方。它在最坏情况和平均情况下都要好得多，因为它按一半一半地禁用扩展。

### [欢迎扩展二分查找](https://code.visualstudio.com/blogs/2021/02/16/extension-bisect#_welcome-extension-bisect)

VS Code 中的扩展二分查找工具受到 [git bisect](https://git-scm.com/docs/git-bisect) 命令的启发。对于熟悉 Git 的人来说，这个命令有助于找出仓库中哪个提交引入了问题。

让我们用一个例子：我安装了 24 个扩展，第 8 个扩展是"问题"扩展。我们知道迭代方法需要 8 步。二分查找怎么样？

下面的视频显示了通过 **帮助：开始扩展二分查找** 命令启动扩展二分查找，然后选择 **现在正常** 或 **这是问题** 直到识别出"问题"扩展。一旦识别出来，你可以选择为该扩展报告问题。

![扩展二分查找过程](https://code.visualstudio.com/assets/blogs/2021/02/16/bisect.gif)

以下是逐步找到"问题"扩展的过程：

1. 二分查找将 24 个扩展分成两半，每半 12 个扩展，并禁用后半部分的所有 12 个扩展。
2. 在这个例子中，第 8 个扩展是"问题"扩展，所以它在前半部分，没有被禁用。事情仍然不像我们期望的那样工作。因为仍然有问题，扩展二分查找重复这个过程，将前 12 个扩展分成两部分：6 个启用，6 个禁用。所有其他扩展也重新启用。
3. 第 8 个扩展现在被禁用了。现在一切正常。这意味着二分查找可以继续处理后半部分（扩展 6-11），并将它们分成 3 个启用和 3 个禁用的扩展。
4. 现在，第 8 个扩展重新启用，问题重新出现。这意味着二分查找继续处理前半部分。它将它们分成 1 个启用和 2 个禁用的扩展。
5. 第 8 个扩展现在被禁用，一切又正常了，二分查找继续处理后半部分，将其分成 1 个启用和 1 个禁用的扩展。
6. 第 8 个扩展是唯一被禁用的扩展，问题消失了。这意味着我们已经找到了"问题"扩展，我们完成了。

### [更快地故障排除](https://code.visualstudio.com/blogs/2021/02/16/extension-bisect#_troubleshoot-faster)

我们看到，在每一步中，二分查找都将搜索空间减半。现在步骤以对数时间运行，导致平均和最坏情况性能为 `O(log N)`。这很好，因为它扩展性很好。对于 24 个扩展，你需要 4 到 5 步来找到"问题"扩展，对于 38 个扩展，只需要多 1 步。然而，最好情况更糟，因为使用迭代方法，你可能很幸运地在第一轮就找到"问题"扩展。

请记住，扩展二分查找依赖于你给出正确的反馈。你可以很容易地欺骗它，也欺骗自己，总是回答 **现在正常**（责怪最后一个扩展）或 **这是问题**（不会找到扩展）。

另一个有用的见解是，扩展二分查找从考虑所有启用的扩展列表开始。这意味着你可以通过在开始前禁用已知的"正常"扩展，然后在之后重新启用它来将其从二分查找中排除。但是，只有当你确定该扩展不是"问题"扩展时才这样做。

最后，你可能会注意到二分查找需要额外的一步（`log2(N) + 1`）。这是因为它通过禁用所有扩展来开始第一轮。这第一步是因为你可能看到的是由 VS Code 本身引起的问题，而不是由扩展引起的，我们不想不必要地让你陷入兔子洞。

就是这样。我们希望您永远不需要使用扩展二分查找。但是，如果您确实遇到可能与扩展相关的问题，那么我们希望能够让故障排除变得更容易、更快、更愉快。

编码愉快，

Johannes Rieken，VS Code 首席软件工程师 [@johannesrieken](https://twitter.com/johannesrieken)

### 参考内容

1. vscode extension bisect, https://code.visualstudio.com/blogs/2021/02/16/extension-bisect