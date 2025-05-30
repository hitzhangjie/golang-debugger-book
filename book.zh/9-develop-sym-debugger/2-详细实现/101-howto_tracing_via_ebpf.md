## 扩展阅读：breakpoint-based vs. eBPF-based tracing

在程序调试和性能分析中，跟踪(tracing)是一项非常重要的技术。目前主要有两种实现方案:基于断点(breakpoint-based)和基于eBPF(eBPF-based)。让我们来详细了解这两种方案的特点。

### 两种跟踪方案对比

#### Breakpoint-based Tracing

断点跟踪是一种传统的跟踪方法,主要特点:

- 实现原理：在目标函数入口处设置软件断点(int3指令),当程序执行到断点处时触发trap异常,由调试器捕获并处理
- 优点：
  - 实现简单,无需内核支持
  - 可以获取完整的上下文信息(寄存器、调用栈等)
  - 支持任意用户态程序
- 缺点：
  - 性能开销大,每次断点都会导致进程暂停
  - 不支持内核态函数跟踪
  - 对程序运行有侵入性

#### eBPF-based Tracing

eBPF跟踪是一种新兴的跟踪技术,主要特点:

- 实现原理：利用内核eBPF机制,在内核中注入跟踪程序,直接在内核态完成数据收集
- 优点：

  - 性能开销小,无需进程暂停
  - 可以跟踪内核态和用户态函数
  - 对程序运行几乎无侵入
- 缺点：

  - 需要较新的内核版本支持
  - 实现相对复杂
  - 受限于eBPF的安全限制

因为考虑到性能影响，使用eBPF-based tracing打印函数参数时，一般也只会获取函数的直接参数，而不会对函数参数中涉及到的指针进一步解引用，因为这涉及到ptrace相关的内存读取操作，肯定要在内存地址有效的情况下去读，最可靠的做法就是像调试器那样，要求目标程序处于TRACED、Stopped状态，因为内存的堆、栈是动态变化的。但是这样做目标程序的性能是会受明显影响的。

see also the discussion:

- [go-delve/delve/issues/3586: Can dlv trace print the value of the arguments passed to a function?
  ](https://github.com/go-delve/delve/issues/3586#issuecomment-2911771133)

### eBPF跟踪实现方式

eBPF跟踪的基本实现步骤如下:

1. 编写eBPF程序

   - 定义要跟踪的事件(kprobe/uprobe)
   - 编写事件处理逻辑
   - 定义数据存储结构(map)
2. 加载eBPF程序

   - 编译eBPF程序
   - 通过bpf系统调用加载到内核
   - 将程序attach到指定的跟踪点
3. 数据收集与处理

   - eBPF程序在内核中执行,收集数据
   - 通过map与用户态程序共享数据
   - 用户态程序读取并处理数据
4. 结果展示

   - 实时显示跟踪数据
   - 统计分析
   - 可视化展示

通过eBPF跟踪,我们可以以极低的开销实现强大的跟踪功能,这使其成为现代性能分析和监控工具的首选技术。

### go程序tracing案例

#### 面临的挑战

由于go程序的特殊性，GMP调度，每个M可能会调用多个G，如果M先执行G1命中某个函数fn入口，然后切出继续执行G2也命中函数fn入口并顺利执行结束命中fn出口。此时从M视角看到的uprobe命中顺序是：fn的入口->fn的入口->fn的出口，但是命中fn的出口究竟是G1命中的呢，还是G2命中的呢？

这就是一个问题，虽然基于eBPF的tracing工具已经有很多，但是他们更多是面向一些C\C++等的基于线程编程模式的语言，它们并不理解Go的运行时调度，所以使用这些工具例如bpftrace、utrace来跟踪Go程序时就会出现统计混乱。

正确的解法就是，首先要理解Go Runtime的GMP调度，然后从当前线程的局部存储中取出 `m.tls.g.goid`，使用goid作为跟踪的对象，上述场景就可以被细化为：

- goroutine-1(goid1)的事件序列：命中fn的入口
- goroutine-2(goid2)的事件序列：命中fn的入口->命中fn的出口

这样打印tracing信息时就可以从goroutine的维度来打印，而不是从线程的视角来打印。

#### 已有的案例

目前成功实现了Go程序eBPF-based tracing的工具目前主要由：

- github.com/go-delve/delve，dlv trace
- https://github.com/jschwinger233/gofuncgraph
- github.com/hitzhangjie/go-ftrace

其中go-ftrace是我从gofuncgraph fork过来学习、修改、优化后的，并在此基础上编写了相关的examples，还写了几篇文章进行详细的介绍。由于篇幅原因，tinydbg中并没有保留go-delve/delve中的ebpf-based tracing实现，如果您感兴趣可以参考下面两篇文章，然后再去学习源码。

1. [观测Go函数调用：go-ftrace](https://www.hitzhangjie.pro/blog/2023-09-25-%E8%A7%82%E6%B5%8Bgo%E5%87%BD%E6%95%B0%E8%B0%83%E7%94%A8go-ftrace/)
2. [观测Go函数调用：go-ftrace 设计实现](https://www.hitzhangjie.pro/blog/2023-12-12-%E8%A7%82%E6%B5%8Bgo%E5%87%BD%E6%95%B0%E8%B0%83%E7%94%A8go-ftrace%E8%AE%BE%E8%AE%A1%E5%AE%9E%E7%8E%B0/)

### 本文总结

本文介绍了如何使用eBPF技术来实现程序跟踪，详细讲解了eBPF跟踪的基本流程，包括编写eBPF程序、加载到内核、数据收集处理以及结果展示等关键步骤。特别指出了在跟踪Go程序时面临的特殊挑战 - 由于Go的GMP调度模型，传统的基于线程的跟踪方案并不适用。文章分析了这一问题的本质，并介绍了正确的解决方案：通过获取goroutine ID来实现准确的函数调用跟踪。同时也介绍了几个成功实现Go程序eBPF跟踪的开源工具，为读者提供了进一步学习和实践的参考。
