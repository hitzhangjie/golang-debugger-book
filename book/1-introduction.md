# 1 Develop a Golang Debugger

## 1.1 About

Hi, I am a developer. I am curious about something unknown. Full of curiousity makes me excited. 

In 2018, I began learning go programming, then I noticed [delve](https://github.com/go-delve/delve), a really good debugger. **delve** is opensource, I am curious about the mechanism it works, so I try to read its code. It's really an exciting journey. I see the perfect thinkings and ideas behind DWARF to blueprint a programming language, I see the relations between CPU, Operating System, building toolchains, ELF and DWARF, it even improves my understanding of design internals of go programming language.

I think it's a good entry to inspect the secrets of computer technologies. I want to share the journey of learning developing a golang debugger.

## 1.2 Introduction

This project aims to introduce **how to** develop a symbolic debugger rather than develop a new one to replace existed **gdb** or **delve**, though I would provide a simple & complete debugger implemention to assist this book's content.

In this book, I will start from a debugger's perspective to go through the journey of developing a (golang) symbolic debugger. We'll learn something relevant with CPU, instruction patching, Operating System (protective mode, task scheduler, syscall ptrace or debug port), coordination between compiler, linker, loader, debugger and DWARF. Besides, we will also introduce some design internals of go programming language (like type system), etc.

I think this book will be interesting and helpful. That makes me excited.

## 1.3 Plan

- ~ - 2019.10.06~2019.10.13 debugging information format: Dwarf v4
- ~ - 2019.10.14~2019.10.20 based on go v1.12.6+linux, finish developing instruction level debugger
- ~ - 2019.10.21~2019.10.27 be familiar with the go standard library: debug、elf
- ~ - 2019.10.28~2019.11.03 based on go v1.12.6+linux，finish developing symbolic level debugger
    - parsing ELF
    - parsing .debug_info
    - parsing .debug_line
    - ...

>Remark: 
>
>This plan started in 2018.7, but it is held on for nearly one year...my bad.
>
>Hope I can finish this book in 2019!

## 1.4 Contact

Please contact me **hit.zhangjie@gmail.com** if you have any suggestions or ideas.

