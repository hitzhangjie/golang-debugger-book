## 软件调试技术全景：工具与场景的精准适配

### 引言

软件调试（Debugging）是贯穿软件生命周期的重要活动，其目标可能是一个进程、一个核心转储文件、带有不同优化特性的复杂程序，一个单体服务，也可能是一个分布式系统。**调试的本质是系统性认知与场景化工具的结合**。当开发者抱怨 “某个工具没用” 时，往往是因为他尚未遭遇需要该工具特性的复杂场景。本文将通过核心调试技术及其适用场景的解析，展示现代软件调试的立体图景。

### 核心调试技术矩阵

#### 1. 调试器（Debugger）

调试器设计实现是全书介绍的目标，大家读到这里自然更不陌生了。调试器是通过断点控制、内存分析、堆栈跟踪等机制实现对目标进程状态观测的交互式工具。调试器对于单进程、多进程、多线程应用程序的实时状态分析中，作用非常大。现代调试器如go-delve/delve甚至实现了协程级的调试能力。对于操作系统内核的调试一般需要内核级调试器，如Linux kdb，Windows winDBG。对于编译期优化后的代码，借助DWARF也可以进行调试，比如内联函数。

> 前面提到过调试器也从一个简单的3层架构，演化到前后端分离式架构，以应对不同软硬件架构的差异。一些主流的IDE为了能与不同的调试器backend进行集成，也需要调试协议层面的标准化支持，如DAP（Debugger Adapter Protocol）。
>
> 调试器对单进程、少量进程的程序调试还算比较简单，微服务架构下的分布式系统调试是一个挑战。

#### 2. 日志系统（Logging）

打日志也是一种非常普遍的调试手段，只要有源码，不管是本地运行的命令行程序，还是远程运行的服务，在可疑位置加几行代码，重新部署运行，就可以观察验证。打日志虽然适用面广，但并不总是那么高效。比如可能需要多次修改源码、编译构建、部署测试才能缩小问题范围。在某些代码交付、制品管理比较严格的企业，还需要经过一系列的评审、CI/CD流程检查。对于分布式系统，一般需要借助远程日志系统，并通过TraceID来串联完整的事务处理日志。为了方便检索，还可能需要结构化日志解析、存储、检索能力的支持，比如ELK Stack。

> 日志就是些不断追加的文本，如何从中提取有价值的信息？
>
> 在远程日志系统出现之前， `tail -f <xyz.log> | grep` 或者 `grep <xyz.log>` 就是大家最常用的操作了吧，如果日志很多还需要 `ls -rth` 查看下日志最后修改时间以确定日志落在哪个文件。远程日志系统出现之后，我们需要将日志进行采集、清洗、解析，比如提取出traceid, loglevel, timestamp, event message 以及其他参数信息，上报到远程日志，远程日志基于这些构建一些索引方便我们进行检索。
>
> 除了上述提及的流程方面的问题，远程日志系统有个不便之处，就是日志量大的情况下、等待日志入库、能被检索出来，一般都有分钟级延迟，对于希望高效调试的情景可能非常不便。

#### 3. 指标监控（Metrics）

监控打点，是一个软件工程师的必修课。有些新手只知道在出错的时候加个监控上报，但是老手却会在每个接口的总请求量、成功量、失败量加监控上报，处理逻辑进入一些关键分支、异常分支也会加上报，对于整体逻辑的处理耗时、其中关键步骤的耗时也会加监控。为什么？就是因为老司机们知道解决线上问题的急迫性，以及如何更好地定位问题。监控打点如果加的细致，也可以作为分析代码执行路径的一种根据，至少可以知道大盘的一个情况。再加上对代码的熟悉程度，也能比较容易缩小问题范围。

> 如CPU利用率、内存泄露趋势图会让开发者迅速联想到耗CPU、耗内存的部分代码，再比如事务处理耗时分布可以帮助联想到某些处理步骤。业务侧指标上报一般借助框架提供的操作，平台侧指标监控一般来源于平台可观测性能力的建设，如机器（物理机、虚拟机、容器）的网络、文件系统、任务调度、CPU、内存等情况，最近几年eBPF在这方面非常出彩。
>
> 借助监控指标缩小问题范围后，还是需要再借助源码、其他手段进一步确定根因，在确定根因之前，监控指标也只是现象。

#### 4. 追踪系统（Tracing）

在微服务架构下的分布式系统领域，如何跟踪事务处理的全流程，是一个挑战。[Google dapper](https://static.googleusercontent.com/media/research.google.com/en//archive/papers/dapper-2010-1.pdf) 详细介绍了如何化解这些难题，如事务处理中调用了哪些服务、调用顺序、各自耗时、各自成功与否、请求及响应参数、关联事件信息等。该论文公开后，市面上出现了zipkin、jaeger等众多开源产品。

其实大家Chrome Developer Tools的Timing Tab也能看到类似的网络请求的tracing可视化信息，区别是dapper里的每个span展示的往往是微服务粒度的，而Timing Tab展示的是每个关键步骤的信息，如Queueing、Request Sent、Wait for response、Content Download。go tool trace也借鉴了这里的思路，将整个go runtime的执行情况都纳入了tracing分析之中，而且还提供了API允许开发者创建自己关心的tracing。

> 早期的opentracing往往聚焦在tracing领域，和metrics、logging的结合比较少，这意味着当你看到一个耗时比较久的span时，如果缺少日志系统的支持，你可能还是不知道当时的问题详情是什么，缺少日志嘛。如果没有关联metrics，你也不知道特定的某个请求触发了什么监控打点。
>
> 这就是早期opentracing、opencencus等存在的不足，现在opentelemetry意识到了这点，将logging、metrics、tracing整合到了一起，形成了新的行业的可观测性标准。[opentelemetry](https://opentelemetry.io/) 可以在框架层实现，也可以借助eBPF的强大能力作为平台化能力来实现。

#### 5. 二分定位法

##### 二分搜索

二分查找，特别适用于在有序数组中寻找目标元素，时间复杂度为 O(log n)。通过二分不断缩小搜索范围，直到找到目标或确定目标不存在。大家有算法基础，对此应该不陌生，这里我们想谈谈二分思想在bug定位方面的实践。

##### git bisect

借助git bisect寻找引入bug的commit，`git bisect (good|bad) [<rev>...]`。假定我们发现当前版本存在bug，bad=HEAD，但是并不是当前版本首次引入的，但是我们凭印象记得v1.0是正常的，那么引入bug的commit肯定介于v1.0和当前最新版本之间。git提交历史中的commits都是按照时间顺序有序排列的，意味着可以采用二分查找的方式每次取一个commit，然后测试当前commit是否有bug，然后通过 `git bisect good|bad` 将比较结果反馈给git，辅助git确定下次的查找范围。附录[《Appendix: 使用 git bisect 定位引入bug的commit》](../12-appendix/3-git-bisect.md)提供了一个示例。

`git bisect` 可以在git commit粒度下锁定bug，但是这对于大型项目还不够。思考下面几个问题：1）程序中不止有一个bug；2）程序中的bug是在某几个特性共同开启的情况下才会出现；3）这些特性的代码分散在多个commit、多个源文件位置。这种情况下使用 `git bisect` 确定导致bug的源文件位置的最小集合比较困难，尤其是在具有一定规模的项目中，如何能解决这类问题呢？

##### bisect reduce

Russ Cox等人提出了一种方法，用于快速定位go编译器、go运行时中bug位置的方法，[Hash-Based Bisect Debugging in Compilers and Runtimes](https://research.swtch.com/bisect)，在这之前也有其他技术人员提出了类似的技术，比如 List-Based Bisect-Reduce，Counter-Based Bisect-Reduce，Russ Cox等人是在他们基础上提出了 Hash-Based Bisect-Reduce。区别就是使用hash值来唯一标识每个特性相关的代码（Hash("feat1")，或者特定源文件位置（Hash("file:lineno"))，而不是使用冗长的locspec列表，或者对应位置的计数器（同一位置计数编号随着代码修改会失效）。

bisect reduce，大致思想就是我们要采用 “特性开关” 的实践方式，当然这里不完全等同于特性开关，也可以是一个简单的优化changelist（如同一个feat对应的多个源文件位置、特定的源码行） …… 我们会给changelist一个名字，比如MyChangeList。假设我们使用 [go bisect](https://github.com/golang/tools/cmd/bisect) 并使用对应的 [golang/tools/internal/bisect库](https://github.com/golang/tools/tree/master/internal/bisect) 来控制changelist开启关闭、上报，然后执行程序 `MyChangeList=y ./a.out` 就等同于打开该changelist所有源码位置，`MyChangeList=n ./a.out` 就等同于关闭该changelist所有源码位置。预期关闭changelist时没有bug、开启时有bug，此时结合上报可以收集到该changelist涉及到的所有源码位置，然后在此基础上进行基于二分的缩减（bisect-based reduction）。

大致思路是：先打开一半位置（记为集合a）检查有没有预期的bug，如果没有就再添加额外一半位置（记为集合b），如果有bug就将刚才添加的b缩减一半（记为c），如果减少后发现没没bug了，那可以确定刚才新添加的一半位置（差集b-c）会导致该预期的bug。将这些可疑位置（b-c）固定下来并在后续搜索过程中带上它们，接下来继续搜索a中可能的位置 …… 最终可以确定一个导致bug出现的源文件位置的局部最小集合，只要这些位置都被打开就会导致该预期的bug。详细的算法可以参考 https://research.swtch.com/bisect。

这里提供了一个demo供大家学习如何在go项目中使用bisect [bisect example](https://github.com/hitzhangjie/golang-debugger-lessons/tree/master/1000_hash_based_bisect_reduce)。

> ps: bisect reduce，和二分搜索都是基于分治或者二分的思想，但也不完全一样，这个场景下核心算法如果使用二分搜索是不正确的。

#### 6. 动态跟踪

eBPF（扩展Berkeley Packet Filter）是一项强大的技术，允许用户在不修改、不重启内核或明显降低系统性能的情况下安全地注入和执行自定义代码。它主要用于网络、性能分析和监控等领域。这里重点强调下eBPF在动态跟踪技术中的应用，Linux kprobe、uprobe、tracepoint 现在已经支持回调eBPF程序，借此可以实现非常强大的动态跟踪功能，比如bpftrace。

对于go语言调试而言，结合eBPF可以实现任意源文件位置的动态跟踪，只要工具实现的足够细致。作者现在维护了一个go程序动态跟踪工具[go-ftrace](https://github.com/hitzhangjie/go-ftrace)，基于DWARF调试信息识别特定函数位置，并动态添加uprobe，然后注册eBPF耗时统计程序，这样就实现了强大的函数调用跟踪能力。

```bash
$ sudo ftrace -u 'main.*' -u 'fmt.Print*' ./main 'main.(*Student).String(s.name=(*+0(%ax)):c64, s.name.len=(+8(%ax)):s64, s.age=(+16(%ax)):s64)'
...
23 17:11:00.0890           main.doSomething() { main.main+15 ~/github/go-ftrace/examples/main.go:10
23 17:11:00.0890             main.add() { main.doSomething+37 ~/github/go-ftrace/examples/main.go:15
23 17:11:00.0890               main.add1() { main.add+149 ~/github/go-ftrace/examples/main.go:27
23 17:11:00.0890                 main.add3() { main.add1+149 ~/github/go-ftrace/examples/main.go:40
23 17:11:00.0890 000.0000        } main.add3+148 ~/github/go-ftrace/examples/main.go:46
23 17:11:00.0890 000.0000      } main.add1+154 ~/github/go-ftrace/examples/main.go:33
23 17:11:00.0890 000.0001    } main.add+154 ~/github/go-ftrace/examples/main.go:27
23 17:11:00.0890             main.minus() { main.doSomething+52 ~/github/go-ftrace/examples/main.go:16
23 17:11:00.0890 000.0000    } main.minus+3 ~/github/go-ftrace/examples/main.go:51

23 17:11:00.0891             main.(*Student).String(s.name=zhang<ni, s.name.len=5, s.age=100) { fmt.(*pp).handleMethods+690 /opt/go/src/fmt/print.go:673
23 17:11:00.0891 000.0000    } main.(*Student).String+138 ~/github/go-ftrace/examples/main.go:64
23 17:11:01.0895 001.0005  } main.doSomething+180 ~/github/go-ftrace/examples/main.go:22
```

#### 7. 确定性重放

即便我们拥有了上述这些令人拍手叫好的技术，还有一个困扰在开发者头上的问题。“**我们知道有bug，但是如何稳定复现它**”。flaky tests，是开发者调试时最头疼的一个问题。应对这个问题，有几个办法：1）先从准备可复现的测试用例集入手，看能不能将原本不能稳定复现的bug，精心构造测试参数后能够稳定复现；2）使用确定性重放技术，首先通过录制记录下问题出现时的情景，然后便可以无限制重放这个场景。第一种办法，更应该理解成是一种工程素养，我们日常就应该这么做。但是面对棘手的问题时，即便做到了也不一定能奏效，这里我们重点介绍第二种办法。

> You record a failure once, then debug the recording, deterministically, as many times as you want. The same execution is replayed every time.
>
> 你只要能录制一次失败，就能利用这次录制进行无限制地重放，进而进行确定性地调试。

明星项目 **Mozilla RR** 做到了这一点，它记录了程序非确定性执行时的全量上下文信息，以使得后续基于录制文件的调试能够精准重放当时的状态，进而进行确定性地调试。rr 还支持了逆向调试，比如 gdb、dlv 的逆向调试命令，在使用 Mozilla RR 作为调试器backend的情况下就可以实现逆向调试，这是非常有用的，不必因为错过执行语句而重启整个调试过程。

读者可能很好奇，rr 录制全量上下文信息，指的是录制了什么呢？系统调用结果、收到的信号、线程创建和销毁、线程调度顺序、共享内存访问、时钟和计数器、硬件中断、随机性来源、内存分配情况，等等。究竟如何解决这些问题，详见论文：[Engineering Record And Replay For Deployability: Extended Technical Report](https://arxiv.org/pdf/1705.05937)。在记录了这些信息的基础上，我们就可以在调试期间通过tracer做些文章实现状态的精准重放，这样就解决了那些会导致flaky test的可变因素干扰的问题。

> ps: 录制数据如何精准重放呢？读者可以先联想下本书介绍过的ptrace对tracee的一系列控制，具体如控制tracee执行多少条指令停止，读写寄存器信息等，看看有没有什么思路。完整解决方案可以查看 Mozilla RR 的论文。

#### 8. 分布式系统调试

在系统架构设计领域，微服务架构越来越获得大家的青睐，独立部署、技术多样性、可扩展性、故障隔离、团队自治、模块化设计，等等都是它的一些优势。但是它确实也带来一些挑战，所以业界也针对性的出现了微服务治理方面的一些解决方案，比如CNCF中的一系列明星项目。这里我们重点提一下对于软件调试带来的挑战。

微服务架构下，由于一个完整的事务处理会在多个微服务中进行处理，给调试带来了非常多的麻烦：

- 首先，整个系统的运行，依赖所有微服务的正确部署，可能涉及到很多机器，不一定支持混部，不一定能保证每个开发都有自己的自测环境；
- 如果没有专属的自测环境，传统的调试器attach一个进程进行跟踪的方式，还会影响服务正常运行，影响其他人测试；
- 即使有专属的自测环境，如果不能混部，还需要分别登录多台机器attach目标进程进行跟踪；
- 即使有专属的自测环境，也能混部，attach多个进程、加断点的位置和时机也还是很难协调；
- ……

总而言之，如果用调试器的思路去尝试解决这个问题，是真的比较难。我们一般会通过Logging、Metrics、Tracing系统来解决微服务架构下的这类问题，生产环境下实践看来也还不错。但是你要说这种方案完美，那也很不现实，比如开发、测试环境中，我们更希望快速定位问题，但是实际情况是：1）你可能要等待一段时间才能观察到日志、监控上报、链路跟踪信息，有一定延迟。2）而且你可能要反复修改代码（补充下日志、监控、创建新的trace或者span），编译，构建，部署测试 …… 然后才能观察到。

本来调试器可能只需要几秒钟就能搞定的事情，只是因为对多机多个进程attach、添加断点时机这块比较难协调，难道就认为调试器搞不定这种情景了？SquashIO提供了完整的云原生情景下的解决方案：Squash Debugger，支持Kubernetes、Openshift、Istio等容器编排平台，实时注入调试容器，并自动关联对应版本的源码，并且能在RPC调用触发后自动触发对Callee特定接口处理函数的断点设置、UI上也支持自动切换到目标服务，支持常见的VSCode等IDE。

### 调试技术选择哲学

从单体应用到云原生、分布式系统，调试技术已形成多维武器库，形成了针对不同场景的技术矩阵。即将展开的系列文章将深入解析每项技术的实现原理、最佳实践和前沿发展，帮助开发者建立"场景-工具-方法论"的立体化调试思维。调试不仅是解决问题的过程，更是理解系统本质的认知革命。掌握不同场景的调试技术，开发者如同获得了上帝之眼，可以了解系统全貌，也可以拨开迷雾探查一切。

### 参考文献

1. [Hash-Based Bisect Debugging in Compilers and Runtimes](https://research.swtch.com/bisect)
2. [go bisect tool](https://github.com/golang/tools/tree/master/cmd/bisect)
3. [go bisect library](https://github.com/golang/tools/tree/master/internal/bisect)
4. [Engineering Record And Replay For Deployability: Extended Technical Report](https://arxiv.org/pdf/1705.05937)
5. [Squash Debugger Docs](https://squash.solo.io/)
6. [Squash Debugger GitHub](https://github.com/solo-io/squash)
7. [Lightning Talk: Debugging microservices applications with Envoy + Squash - Idit Levine, Solo.io](https://www.youtube.com/watch?v=i5_eacXkw3w)
8. [Dapper, a Large-Scale Distributed System Tracing Infrastructure](https://static.googleusercontent.com/media/research.google.com/en//archive/papers/dapper-2010-1.pdf)
9. [OpenTelemetry](https://opentelemetry.io/)
