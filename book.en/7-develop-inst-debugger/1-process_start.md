## StartProcess

```go
func Command(name string, arg ...string) *Cmd
func FindProcess(pid int) (*Process, error)
```



## TraceProcess

### PtraceAttach

```go
func PtraceAttach(pid int) (err error)
```

According to Linux manual of ptrace, a ptrace attach syscall can only trace a single physical thread. If the debugged process has multiple threads to trace, each tracee thread must be traced by a ptrace call.

Also, the tracer thread must be locked to the same physical thread, pay attention to this if you want to use golang to develop a debugger, because goroutine maybe offered to another physical thread to schedule.

### Wait

```go
func (p *Process) Wait()
```

After tracee thread stopped or exited, OS will send a signal to the tracer to notify the tracee’s state, then the tracer thread can use ptrace syscall to inspect the tracee’s memory and registers.

 