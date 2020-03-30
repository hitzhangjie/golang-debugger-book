# UI Layer

## terminal

Terminal provides a command line user interface to prompt user input to debug. 

When a terminal initialized, the common debug operations, like help, backtrace, frame, etc, and their aliases will be registered.

`terminal/command.go`:
- help [cmd], if cmd is specified, it will print the help message of `cmd`, otherwhile, it will print each command's help message.
- break [name] <locspec>, terminal wraps an debug service client, firstly, the client will query the locations specified by the locspec, secondly, the client will request to add breakpoints for the locations.
- trace [name] <linespec>, trace works similarly to break, the difference is trace gives us an ability to watch the event when the tracepoint is hit, but doesn't stop the execution of tracee..
- restart, restart the debug operation, if recording enabled, you can restart from specified position.
- continue, keep running util breakpoint is hit, well, delve may trace all threads of debugged process. fixme! if i am wrong!
- step, step execution one statement, firstly, we must select the right goroutine to single step, well, get the current thread, and read the memory at `thread.TLS+struct field G offset` to read the goroutine id, and select this goroutine and thread to step.
- step instruction, step execution one instruction, firstly, we must select the right goroutine to single step, well, get the current thread, and read the memory at `thread.TLS+struct field G offset` to read the goroutine id, and select this goroutine and thread to step.
- reverse-{n, s, si}, while this feature hasn't been merged.
- ...

>you can check the full command list and descriptions in `terminal/command.go`

Actually, any supported debug operations so far and in the future, is defined in the `Client interface`. We can check whether the debug service has implemented this, or how does it implement this.

