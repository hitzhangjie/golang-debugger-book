父子进程，在调试器实现过程中，跟踪父子进程和跟踪进程内的线程，实现技术上差别不大。

尽管大多数调试场景中,我们更加侧重于单进程内的多线程调试部分,但是为了系统性介绍调试的方方面面,我们还是希望简单讲一下多进程调试中涉及到的一些内容.

必要时还可以实现类似 gdb `set follow-fork-mode=child/parent/ask` 的调试效果呢


之前讲过跟踪新线程，其实这里设置下这个选项，就可以实现跟踪新进程创建了

```go   
opts := syscall.PTRACE_O_TRACEFORK | syscall.PTRACE_O_TRACEVFORK | syscall.PTRACE_O_TRACECLONE
if err := syscall.PtraceSetOptions(int(pid), opts); err != nil {
    fmt.Fprintf(os.Stderr, "set options fail: %v\n", err)
    os.Exit(1)
}
```
