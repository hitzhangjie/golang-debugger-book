多线程调试的问题，前面已经提到过，对go程序而言，我们关注的是：

-   区分go中哪些线程可以trace、哪些不可以trace
-   可以trace的多个线程，如何自动trace
-   GPM模型中，如果因为ptrace挂起了一个线程，GPM会不会创建新的M
-   。。。



TODO 任务优先级：高