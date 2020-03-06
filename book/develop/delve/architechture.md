# 1 Internal Overview
Delve is a symbolic debugger for the Go Programming Language, used by Goland IDE, VSCode Go, vim-go, etc.
This document will give a general overview of delve's architecture, and explain why other debuggers have difficulties with Go programs.

# 2 Assembly Basics

## 2.1 CPU

- Computers have CPUs
- CPUs have registers, in particular:
    - "Program Counter" (PC), where stores the address of the next instruction to execute
        >also known as Instruction Pointer (IP)
    - "Stack Pointer" (SP), where stores the address of the "top" of the call stack
- CPUs execute assembly instructions that look like this:
    ```c
    MOVQ DX, 0x58(SP)
    ```
  
## 2.2 Call Stack

Normally, each function call has a isolated call stack frame, where stores the arguments, local variables and  return address of a function call.

Following is an illustration:

|||
|:--------------------:|:------------------:|
|Locals of runtime.main| <- high address    |
|Ret.address           |                    |
|Locals of main.main   |                    |
|Arguments of main.f   |                    |
|Ret.Address           |                    |
|Locals of main.f      | <- low address     |

Goroutine 1 starts by calling runtime.main:

|||
|:--------------------:|:------------------:|
|Locals of runtime.main|                    |
|                      | <- SP              |

runtime.main calls main.main by pushing a return address on the stack:

|||
|:--------------------:|:------------------:|
|Locals of runtime.main|                    |
|Ret.address           |                    |
|                      | <- SP              |

main.main pushes its' local variables on the stack:

|||
|:--------------------:|:------------------:|
|Locals of runtime.main|                    |
|Ret.address           |                    |
|Locals of main.main   |                    |
|                      | <- SP              |

Wheen main.main calls another function `main.f`:
 - it pushes the arguments of main.f on the stack
 - pushes the return value ono the stack
 
|||
|:--------------------:|:------------------:|
|Locals of runtime.main|                    |
|Ret.address           |                    |
|Locals of main.main   |                    |
|Arguments of main.f   |                    |
|Ret.Address           |                    |
|                      | <- SP              |

Finally main.f pushes its local variables on the stack:

|||
|:--------------------:|:------------------:|
|Locals of runtime.main|                    |
|Ret.address           |                    |
|Locals of main.main   |                    |
|Arguments of main.f   |                    |
|Ret.Address           |                    |
|Locals of main.f      |                    |
|                      | <- SP              |

Well, when calling a function, pushing the arguments, pushing the return address, saving the Base Pointer, assigning the value of Base Pointer to Stack Pointer... These actions are defined by ABI (Application Binary Interface).

## 2.3 Threads and Goroutines

- M:N threading / green threads
    - M goroutines are scheduled cooperatively on N threads
        > Well, go1.14 supports non-cooperatively preemption schedule in tight loop. 
    - N initially equal too $GOMAXPROCS (by default the number of CPU cores)
        > If Hyper-Threading supported, $GOMAXPROCS equal to number of hardware thread.
- Unlike threads, goroutines:
    - are scheduled cooperatively
        > Well, go1.14 supports non-cooperatively preemption schedule in tight loop, which is implemented by signal SIGURG. While thread preemption is implemented by hardware interrupt.
    - their stack starts small and grows/shrinks during execution
- When a go function is called
    - it checks that if there is enough space on the stack for its local variables
    - if the space is not enougth, runtime.morestack_noctx is called
    - runtime.morestack_noctx allocates more space for the stack
    - if the memory area below the current stack is already used, the stack is copied somewhere else in memory and then expanded
        > maybe adjusting the values of the pointers in current stack is needed
- Goroutine stacks can move in memory
    - debuggers normally assume stacks don't move
        > as mentioned above, goroutine stack can grow and shrink, it maybe moved here and there in memory, so the register SP must be changed to address the right position. while debuggers normally assume stacks don't move, so they may behave totally wrongly.

# 3 Architecture of Delve

## 3.1 Architecture of a Symbolic Debugger

|                |                   |
|:--------------:|:------------------|
| UI Layer       | the debugging user interface, like: <br>- command line interface<br>- graphical user interface like GoLand or VSCode Go.
| Symbolic Layer | knows about:<br> - line numbers, .debug_line<br>- types, .debug_types<br>- variable names, .debug_info, etc.
| Target Layer   | controls target process, doesn't know anything about your source code, like<br>- set breakpoint<br>- execute next statement<br>- step into a function<br>- step out a function<br>- etc.

## 3.2 Features of the Target Layer

- Attach/detach from target process
- Enumerate threads in the target process
- Can start/stop individual threads (or the whole process) 
    > CPU instruction patching, like X86 int3 generates 0xCC
- Receives "debug events" (thread creation/death and most importantly thread stop no a breakpoint)
- Can read/write the memory of the target process
    > like Linux ptrace peek/poke data in memory
- Can read/write the CPU registers of a stopped thead
    - actually this is the CPU registers saved in the thread descriptor of the OS scheduler
    > like Linux ptrace peek/poke data in registers.<br/> <br/>
    well, when thread is switched off the CPU, its hardware context must be saved somewhere. when the thread becomes runnable and scheduled, its hardware context saved before will be resumed. So where does this hardware context saved? please check the knowledge about GDT, it holds the thread descriptor entries and code segment priviledge control relevant entries.

For now, we have 3 implementions of the target layer:
- pkg/proc/native: controls target process using OS API calls, supports:
    - Windows  
    `WaitForDebugEvent`, `ContinueDebugEvent`, `SuspendThread`...
    - Linux
    `ptrace`, `waitpid`, `tgkill`...
    - macOS
    `notification/exception ports`, `ptrace`, `mach_vm_region`...
    > /pkg/proc/native, it's the default backend on Windows and Linux
- pkg/proc/core: reads linux_amd64 core files
- pkg/proc/gdbserial: used to connect to:
    - debugserver on macOS (default setup on macOS)
    - lldb-server
    - Mozillar RR (a time travel debugger backend, only works on linux/amd64)
    > the names comes from the protocol it speaks, the Gdb Remote Serial Protocol
 
About debuggserver
- pkg/proc/gdbserial connected to debugserver is the default target layer for macOS
- two reasons:
    - the native backend uses undocumented API and never worked properly
    - the kernel API used by the native backend are restricted and require a signed executable
        - distributing a signed executable as an open source project is problematic
        - users often got the self-signing process wrong

## 3.3 Symbolic Layer

```

|----------------|           Executable File
|       UI       |         |-----------------|
|----------------|         |       Code      |         |-----------------|
| Symbolic Layer | <------ |-----------------| <------ | Compiler/Linker |
|----------------|         |  debug symbols  |         |-----------------|
|  Target Layer  |         |-----------------|
|----------------|

```

The Symbolic Layer:
- does its job by opening the executable file and reading the debug symbols that the compiler wrote
- the format of the debug symbols for Go is DWARFv4: http://dwarfstd.org/

> Well, go is using DWARFv4 in compiler and linker. DWARFv5 has been released. 
>
> DWARFv5 add some more advanced features, which will improve the debugging. DWARFv5 has been used by gdb, etc.
> Also, the Go development team has a plan to build a better linker, and DWARFv5 will be used: 
> https://docs.google.com/document/d/1D13QhciikbdLtaI67U6Ble5d_1nsI4befEd6_k1z91U/view
>
> about DWARF:
> - compiler/linker, is the producer of DWARF info
> - Symbolic Layer, is the consumer of DWARF info

### 3.3.1 DWARF Sections

DWARF defines many sections:

||||
|:------:|:------:|:------:|
|debug_info|debug_types|debug_loc|
|debug_ranges|debug_line|debug_pubnames|
|debug_pubtypes|debug_arranges|debug_macinfo|
|debug_frame|debug_str|debug_abbrev|

The important ones:

||||
|:------:|:------:|:------:|
|debug_info|~~debug_types~~|~~debug_loc~~|
|~~debug_ranges~~|debug_line|~~debug_pubnames~~|
|~~debug_pubtypes~~|~~debug_arranges~~|~~debug_macinfo~~|
|debug_frame|~~debug_str~~|~~debug_abbrev~~|

- debug_line: a table mapping instruction addresses to file:line pairs
- debug_frame: stack unwinding information
- debug_info: describes all functions, types and variables in the program

### 3.3.2 debug_info example

```go
package main

type Point struct {
    X, Y int
}

func NewPoint(x, y int) Point {
    p := Point{x, y}
    return p
}
```

This program can be described by following tree of DWARF DIEs.

>- DWARF: debugging with attributed record format
>- DIE: debugging information entry
>
> Well, more documents would be introduced to describe the coordination between the work of compiler, debugger and linker if nessesary.

![debug_info example](assets/debug_info_example.jpeg)

### 3.3.3 debug_frame example

```
2 0x00000000004519c9 in main.f at ./panicy.go:4
3 0x0000000000451a00 in main.main at ./panicy.go:8
4 0x0000000000426450 in runtime.main
at /usr/local/go/src/runtime/proc.go:198
5 0x000000000044c021 in runtime.goexit
at /usr/local/go/src/runtime/asm_amd64.s:2361
```

- get the list of instruction addresses
    - 0x4519c9, 0x451a00, 0x426450, 0x44c021
- look up debug_info to find the name of the function
- look up debug_line to find the source line corresponding to the instruction

|||
|:----------------------------:|:------------------:|
|Ret.address<br>of runtime.main|                    |
|Ret.address<br>of main.main   |                    |
|Ret.Address<br>of main.f      |                    |
|                              | <- SP              |


- if functions had noo local variables of arguments this would be easy
- a stack trace is the value of PC register
- followed by reading the stack starting at SP

Section .debug_frame can be used for creating a CFI (Call Frame Information) table, which can give you the size of the current stack frame given the address of an instruction

Actually has many more features, but that's the only thing youo need for pure Go.

|||
|:-------------------------:|:------------------:|
|Locals of<br>runtime.main  |                    |
|Arguments of<br>main.main  |                    |
|Ret.address<br>main.main   |                    |
|Locals of<br>main.main     |                    |
|Arguments of<br>main.f     |                    |
|---------------------------|--------------------|
|Ret.Address<br>of main.f   |    this is a       |
|Locals of<br>main.f        |   frame size       |
|---------------------------|--------------------|

To create a stack trace:
- start with:
    - PC{0} = the value of the PC register
    - SP{0} = the value fo the SP register
- lookup PC{i} in .debug_frame:
    - get size of the current frame sz{i}
- get return address ret{i} at `SP{i}+sz{i}-8`
- repeat the procedure with
    - PC{i+1} =  ret{i}
    - SP{i+1} = SP{i}+sz{i}
- the stack trace is PC{0}, PC{1}, PC{2}...

### 3.3.4 Symbolic Layer in Delve

- mostly pkg/proc
- support code in pkg/dwarf and stdlib debug/dwarf

## 3.4 Actual Architecture of Delve

We Mentioned before, delve's architecture includes:
- UI Layer
- Symbolic Layer
- Target Layer

Well, this is a lie.

### 3.4.1 Actual Architecture

If we want delve to be embeded into other programs easier, service oriented APIs should be provided.

![delve actual architecture](assets/delve_architecture.jpeg)

This architecture and design makes embedding delve into other programs easier, so you can integrate delve with GoLand, VSCode, Atom, Vim, etc.

### 3.4.2 User Interfaces

- Built-in command line prompt Plugins
    - Atom plugin, https://github.com/lloiser/go-debug 
    - Emacs plugin, https://github.com/benma/go-dlv.el/ 
    - Vim-go, https://github.com/fatih/vim-go
    - VS Code Go, https://github.com/Microsoft/vscode-go
– IDE
    - JetBrains GoLand IDE, https://www.jetbrains.com/go
    - LiteIDE, https://github.com/visualfc/liteide
- Standalone GUI debuggers
    - Gdlv, https://github.com/aarzilli/gdlv
    
Delve's actual architecture and associated core packages is as following:

![delve_actual_architecture](assets/delve_architecture_core.jpeg)    

# 4 Reference
1. [Architecture of Delve slides](https://speakerdeck.com/aarzilli/internal-architecture-of-delve).
