## 4.1 Purpose

Though programmers pay lots of attention to code bug free programs, making bugs cannot be avoided. **Print statements** like `fmt.Println` are often used to locate the bugs, but in some complex occasions, we need do more operations to locate the bug. 

Debugger can help us **control the execution of tracee (debugged process)** and **inspect its runtime state including memory and registers**, so that we can execute the code statement by statement, check whether variable's value is expected or not, jump to the codepath that we are interested, etc.

I think debugger is an essential tool for beginners to master programming techniques and solve weired bugs, it's an essential tool even for advanced programmers.

This book aims to guide us to develop a golang debugger, so how to use a debugger is put on the second burner. But if you have any experience in debugging using symbol debuggers, you can understand the implementation details more easily. 

**Common debugging operations** are as following:

- Set breakpoint on memory address, function, statement, file line number
- Single step instruction, single step statement, or continue to breakpoint
- Get/Set registers info
- Get/Set memory info
- Evaluate expressions
- Call statement
- Others

This book will describe how to implement the relevant debugging operations. If you are interested in this boring debugging internals, then keep going on.

> Is this boring? To some extent, to some friends, Yes. But for me, it is very interesting.

 
