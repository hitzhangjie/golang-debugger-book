## Appendix: trace newly cloned threads

### how does tracer automatically trace newly cloned threads

PTRACE_O_TRACECLONE is an option for the ptrace system call that allows a tracer process to receive notifications when a traced process clones new child processes via fork() or clone().

Here is how PTRACE_O_TRACECLONE works:

- A tracer process calls ptrace() on the process to be traced, passing the PTRACE_O_TRACECLONE option.
- This sets up the traced process to notify the tracer when it clones new child processes.
- When the traced process calls fork()/clone(), the kernel will pause the new child process before it starts executing.
- The kernel notifies the tracer process by delivering a PTRACE_EVENT_CLONE event along with information about the new child process (pid, registers, etc).
- The tracer can inspect or modify the child process as desired using regular ptrace commands.
- When the tracer is done, it calls ptrace() with PTRACE_CONT on the child, allowing the child to continue executing.
- The tracer will receive a PTRACE_EVENT_CLONE event for each new child cloned by the traced process going forward.

So in summary, PTRACE_O_TRACECLONE makes ptrace notify the tracer process whenever a new child process is cloned, allowing the tracer to introspect or control the child even before it starts running. This provides deeper process tracing capabilities.
