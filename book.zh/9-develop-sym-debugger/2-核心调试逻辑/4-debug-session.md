调试会话，这部分的能力，和指令级调试器中的调试会话基本上是一样的，我们可以复用指令级调试器中的调试会话实现，而将重点放置在符号级操作的实现上。

这里，提到符号级的操作，我们也应该进一步考虑下调试器的架构设计，前面曾经提到过符号级调试器一般按照UI层、符号层、目标层进行设计。

为了更好的扩展性（如对接IDE）也可以考虑调试器区分为frontend和backend，frontend和backend通过service层进行通信，frontend在UI层操作，听通过service层发送请求到backend，backend在service层接受请求，并在符号层完成符号到目标平台的转换，然后调用目标层完成具体的调试动作，如内存数据读取。

这里我们的主要任务是对现有设计进行更清晰的符号层、目标层的划分，service层我们可以先暂时不做考虑。



TODO 任务优先级：高



基于这种架构进行设计的时候，也需要考虑将来调试器如何和其他工具的集成，比如微软就提出了DAP（debugger adapter protocol），调试器适配器协议，如果调试器要与vscode集成，在backend这里实现DAP定义的协议操作就可以了。也就是真正的backend也要支持可扩展，比如dlv启动的时候可以通过参数--backend来选择native、dap、lldb、gdbserial等不同的backend实现。see https://github.com/hitzhangjie/tinydbg/issues/3。

