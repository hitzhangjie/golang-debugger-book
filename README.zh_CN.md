# 从0到1：go语言调试器开发

## 项目介绍

我是从2016年开始了解go语言，2018年开始正式将其作为主力开发语言，期间还经历了些小插曲，就是对go的抵触。我是在深入了解c、cpp、java第三方协程库支持以及开发实践战之后，才最终决定转向go。

学习go的过程中，新手难免遇到些借助调试来认识语言细节的情况，有一次在使用delve的过程中联想到，从调试器角度切入来窥探计算机世界的秘密，是一种很自然、持久有效的方法。不管是那种语言，只要是有调试信息支持，你总能借助调试器来窥探进程的运行过程。可以联想下FPS游戏，一倍镜窥探代码执行，二倍镜窥探变量，三倍镜窥探类型系统，四倍镜窥探硬件特性……有什么能绕过调试器的法眼呢？

本书希望能从go调试器角度出发让开发者更好地理解go编程语言、编译器、链接器、操作系统、调试器、硬件之间的联系，我相信那会比割裂似的课程教学更容易让读者认识到它们各自的价值以及彼此间密切的联系。开发者也将掌握调试器开发能力，从而可以开发一些针对语言级别的运行时分析、调试能力，这也是种传播分享知识的形式。

为什么要从调试器角度入手？

- 调试过程，并不只是调试器的工作，也涉及到到了源码、编译器、链接器、调试信息标准，因此从调试器视角来看，它看到的是一连串的协作过程，可以给开发者更宏观的视角来审视软件开发的位置；
- 调试标准，调试信息格式有多种标准，在了解调试信息标准的过程中，可以更好地理解处理器、操作系统、编程语言等的设计思想，如果能结合开源调试器学习还可以了解、验证某些语言特性的设计实现；
- 调试需要与操作系统交互来实现，调试给了一个更加直接、快速的途径让我们一窥操作系统的工作原理，如任务调度、信号处理、虚拟内存管理等。操作系统离我们那么近但是在认识上离我们又那么远，调试器依赖操作系统支持，也是个加深对操作系统认识的很好的契机；
- 此外，调试器是每个开发者都接触过的常用工具，我也希望借此机会剖析下调试器的常用功能的设计实现、调试的一些技巧，也领略下调试信息标准制定者的高屋建瓴的设计思想，站在巨人的肩膀上体验标准的美的一面。

## 示例代码

该项目“**golang-debugger-book**”，也提供了配套的示例代码“**golang-debugger-lessons**”，读者可以按照章节对应关系来查看示例代码，目录“**0-godbg**”中提供了一个相对完整的go语言符号级调试器实现。

当然在业界已经有针对go语言的调试器了，如gdb、dlv等等，我们从头再开发一款调试器的初衷并不只是为了开发一款新的调试器，而是希望以调试器为切入点，将相关知识进行融会贯通，这里的技术点涉及go语言本身（类型系统、协程调度）、编译器与调试器的协作（DWARF）、操作系统内核（虚拟内存、任务调度、系统调用、指令patch）以及处理器相关指令等等。

简言之，就是希望能从开发一个go语言调试器作为入口切入，帮助初学者快速上手go语言开发，也在循序渐进、拔高过程中慢慢体会操作系统、编译器、调试器、处理器之间的协作过程、加深对计算机系统全局的认识。

希望本书及示例，能顺利完成，也算是我磨练心性、自我提高的一种方式，如果能对大家确实起到帮助的作用那是再好不过了。

## 阅读本书

1. 克隆项目
```bash
git clone https://github.com/hitzhangjie/golang-debugger-book
```

2. 安装gitbook或gitbook-cli
```bash
# macOS
brew install gitbook-cli

# linux
yum install gitbook-cli
apt install gitbook-cli

# windows
...
```

3. 构建书籍
```bash
cd golang-debugger-book/book

# initialize gitbook plugins
make init 

# build English version
make english

# build Chinese version
make chinese

```

4. 清理临时文件
```bash
make clean
```

> 注意：gitbook-cli存在依赖问题，请尽量使用Node v10.x.
>
> 如果您确实希望使用更新版本的Node，可以通过如下方式来解决:
>
> 1. 如果运行 `gitbook serve` 出错，并且gitbook-cli是全局安装的话，先找到npm全局安装目录并进入该目录，如 `/usr/local/lib/node_modules/gitbook-cli/node_modules/npm/node_modules`, 运行命令 `npm install graceful-fs@latest --save`
> 2. 如果运行 `gitbook install` 出错，进入用户目录下的.gitbook模块安装目录 `.gitbook/versions/3.2.3/node_modules/npm`，运行命令 `npm install graceful-fs@latest --save`

# 意见反馈

联系邮箱 `hit.zhangjie@gmail.com`，标题中请注明来意`golang debugger交流`。

<a rel="license" href="http://creativecommons.org/licenses/by-nd/4.0/deed.zh"><img alt="知识共享许可协议" style="border-width:0" src="https://i.creativecommons.org/l/by-nd/4.0/88x31.png" /></a><br />本作品采用<a rel="license" href="http://creativecommons.org/licenses/by-nd/4.0/deed.zh">知识共享署名-禁止演绎 4.0 国际许可协议</a>进行许可。

