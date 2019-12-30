# Contributing Guide

# introduction

# golang-debugger

This project aims at describing how to develop a (symbolic) golang debugger, like gdb or dlv. Why we do this?

The purpose of this project isn't only finishing developping a golang debugger, it focuses on how-to develop rather than the final implemention.
The contents covered may include CPU, CPU Instruction Set, Operating System, ELF, Compiler and Linker, Debugging Information Standards, Debugger, Language Design Internals, etc.

In a word, we want to use developping a symbolic golang debugger as a chance to introduce how CPU, OS, ELF, Compiler and Linker, Debugger coordinate with others. Besides, we can also inspect the design internals of go programming language.

Thanks to the contributors of gdb, delve, DWARF, etc. I learned a lot from them. Now I want to share the knowledge.

# project plan

- ~ - 2018.11.30 write the debugger on Linux
- ~ - 2018.12.31 book chapter: dwarf
- ~ - 2019.01.31 book chapter: develop golang debugger from scratch
- ~ - 2019.02.28 book chapter: from debugger's view, understand golang type system
- ~ - 2019.03.31 book chapter: from debugger's view, understand golang runtime scheduler
- ~ - 2019.04.30 book review:
- ~ - 2019.05.31 book publish: via press or electronic

# suggestions

Please contact me `hit.zhangjie@gmail.com`，if you have any suggestions.

# contribution

Our work will be around with github.com:

1. come up with ISSUE
2. discuss the ISSUE
3. fork the project, develop, test, fix, create a PR
4. review PR and merge
5. tag and release

# welcome

I Welcome anyone willing to contribute to this book to integrate the knowledge and share them.
