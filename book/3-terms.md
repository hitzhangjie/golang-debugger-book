# Terms

In this book, we'll cover knowledge in compilers, linkers, operating systems, debuggers and deubgging information standards, software development, etc. Many terms will be used. We list all common and important terms here so that readers can lookup conveniently.

| **Term**                   | **Description**                                              |
| :------------------------- | :----------------------------------------------------------- |
| Source                     | Source code programmed in golang, etc                        |
| Compiler                   | Build object file based on source                            |
| Linker                     | Link object files, shared libraries, system startup code to build executable file |
| Debugger                   | Attach a running process or load a core file, load debugging information from process or core file, inspect process running state like memory, registers |
| Dwarf                      | A standard to guide the compiler generating debugging information into object files, guide linker to merge debugging information stored in several object files, debugger will load this debugging information. Dwarf coordinates the work between compiler, linker and debugger |
| Debugger types             | Generally debuggers can be classified into 2 types: instruction level debugger and symbol level debugger. |
| Instruction level debugger | An instruction-level debugger whose object of operation is machine instructions. Instruction level debugging can be achieved by the processor instruction patch technique, and there is no need of debugging symbols. It works at the instruction or assembly language level rather than source level. |
| Symbol level debugger      | It depends on on ptrace syscall, too. Besides, it can extract and parse debugging symbols table, remap information between memory address, instruction address and source, so you can set a breakpoint on source statement, and something others like that |
