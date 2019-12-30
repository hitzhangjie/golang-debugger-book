# golang-debugger-book

## Introduction

Hack and explore the computer world from a (golang) debugger's perspective!


This book contains two parts:

- Part I, aims to introduce how to develop a (golang) debugger.
- Part II, aims to streghthen your computer knowledgee from a (golang) debugger's perspective.


To develop a symbolic debugger, we need to combine the knowledge of :


|          |description|
|----------|-----------------------------------|
| CPU  | like PC, instruction patching, etc. |
| OS   | Operating System support like linux ptrace (debug support), scheduler (sched thread), signal handler (process 0xCC (breakpoint) SIGSTOP), etc. |
| Compiler | how to generate debugging information, etc. |
| Linkers | how to link object files and generate debugging information, etc. |
| Loaders | how to load program, libraries into memory, etc. |
| Debuggers | how to execute the code of tracee step by step, statement by statement, how to map between address and source code, how to access memory and registers, etc. |
| Executable File Format | how to store debugging information, etc. |
| Debug Information Format | how to describe data, types, executable code (even language features, like c++ template, go goroutine), how to map between address and source, how to locate the call frame, etc. |
| DWARF | a standard of Debugging Information Format to guide how to coordinate the work between compilers, linkers and debuggers. |
| ... | ... | 

- CPU, like PC, instruction patching, etc.
- Operating System support, like linux ptrace (debug support), scheduler (sched thread), signal handler (process 0xCC (breakpoint) SIGSTOP), etc.
- Compilers, how to generate debugging information, etc.
- Linkers, how to link object files and generate debugging information, etc.
- Loaders, how to load program, libraries into memory, etc.
- Debuggers, how to execute the code of tracee step by step, statement by statement, how to map between address and source code, how to access memory and registers, etc.
- Executable File Format, how to store debugging information, etc.
- Debugging Information Format, how to describe data, types, executable code (even language features, like c++ template, go goroutine), how to map between address and source, how to locate the call frame, etc.
- DWARF, a standard of Debugging Information Format to guide how to coordinate the work between compilers, linkers and debuggers.
- ...
    
Ah, I think it's a good chance to improve understanding of Computer Technology by developping a (golang) debugger.

We all have learned programming with the help of a debugger. We trace the programme statement by statement, check the variable's value, check the register's value, suspend or resume thread, check the call frame stack, etc.
While, I think a debugger can teach us more that that! 

The go programming lanaguage is still a young language, go is still developping rapidly. How do we spend less time but learn go better?
If we have a good golang debugger, which knows go type system, runtime, memory management, etc, very well, I think it can help gophers understand go better!

- How does a debugger work? 
- How does compiler, linker and debugger coordinate with each other around the program written in specific programming language, eg. golang? 
- To develop a debugger for golang, what knowledge should be mastered? go type system, runtime... and some Operating System internals. 

This project aims to introduce how to develop a (golang) debugger, including Operating System's support, how to coordinate work between compiler, linker and debugger, debugging information standard, mapping between machine instruction and source code, etc. 

Thanks to [delve](github.com/go-delve/delve) and the author [derek parker](https://twitter.com/derkthedaring?lang=en) and other contributors. I learned a lot from them. I want to share the knowledge to develop a (golang) debugger. I hope this project can be useful for developers interested in debugging topic.

I think it's very helpful, So I am really excited to write this documents.

## Read the Book

1. clone the repository
```
git clone https://github.com/hitzhangjie/golang-debugger
```

2. install gitbook or gitbook-cli
```
# macOS
brew install gitbook-cli

# linux
yum install gitbook-cli
apt install gitbook-cli

# windows
...
```

3. build the book
```
cd golang-debugger/doc

# initialize gitbook plugins
make init 

# build English version
make english

# build Chinese version
make chinese

```

4. clean tmpfiles
```
make clean
```

## Contact

Please email me **hit.zhangjie@gmail.com**, I will respond as soon as possible.

