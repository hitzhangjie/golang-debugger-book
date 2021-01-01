# 1 Develop a Golang Debugger

## 1.1 About

Hi, my name is Zhang Jie. I am currently working at Tencent (Shenzhen) Technology Co., Ltd. as a senior back-end engineer. 

During the work at Tencent, I successively engaged in the construction of backend development at Now, QQ Kandian, and information flow content processing system. As PMC, I successively participated in the design and development of microservice framework goneat and trpc. And I was also responsible for the formulation of company-level code specification and code review.

## 1.2 Introduction

This project aims to introduce **how to** develop a symbolic debugger rather than develop a new one to replace existed **gdb** or **delve**, though I would provide a simple & complete debugger implemention to assist this book's content.

In this book, I will start from a debugger's perspective to go through the journey of developing a (golang) symbolic debugger. We'll learn something relevant with CPU, instruction patching, Operating System (protective mode, task scheduler, syscall ptrace or debug port), coordination between compiler, linker, loader, debugger and DWARF. Besides, we will also introduce some design internals of go programming language (like type system), etc.

I think this book will be interesting and helpful. That makes me excited.

## 1.3 Samples

The project "**golang-debugger-book**" also provides a repository "**golang-debugger-lessons**" which contains sample code. Readers can view the sample code according to the chapter correspondence. The directory "**0-godbg**" provides a relatively complete implementation of a symbol-level debugger for go language.

Of course, there have been some debuggers for the Go language, such as gdb, dlv, etc. To develop a debugger from scratch is not just to develop a new debugger, but to use the debugger as an entry point, that could help us integrate relevant knowledge. The technical points here involve the go language itself (type system, goroutine scheduling), the cooperation between the compiler and the debugger (DWARF), the operating system kernel (virtual memory, task scheduling, system calls, instructions patching) and processor-related instructions, etc.

In short, I hope to start with the development of a go language debugger as an entry point to help beginners quickly get started with go language development, and gradually understand the mechanisms behind operating system, compiler, debugger, and processor, so we could deepen the overall understanding of the computer system.

I hope that this book and related samples can be smoothly completed. It can be regarded as a way for me to hone my temperament and improve myself. It would be great if it can really help everyone.

## 1.4 Contact

Please contact me **hit.zhangjie@gmail.com** if you have any suggestions or ideas.

