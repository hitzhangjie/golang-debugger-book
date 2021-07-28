# How to develop a (golang) debugger

You can read this book (Chinese version) here: https://www.hitzhangjie.pro/debugger101.io/ .

## Introduction

This project aims to introduce how to develop a (golang) debugger, including Operating System's support, how to coordinate work between compiler, linker and debugger, debugging information standard, mapping between machine instruction and source code, etc. 

Thanks to [delve](github.com/go-delve/delve) and the author [derek parker](https://twitter.com/derkthedaring?lang=en) and other contributors. I learned a lot from them. I want to share the knowledge to develop a (golang) debugger. I hope this project can be useful for developers interested in debugging topic.

To develop a symbolic debugger need to combine the knowledge of CPU instruction (like instruction patching), Operating System (like linux ptrace and OS scheduler), compilers, linkers, loaders, debuggers (how to coordinate the work between them), executable file format (how to store debugging information), debugging information format (how to describe source code, how to map between instruction and source, vice versa), and features of different programming languages (like goroutine concept), so I think it's also a good chance to improve the understanding of computer technology.

I think it's very helpful, So I am really excited to write this documents.

## Samples

The project "**golang-debugger-book**" also provides a repository "**golang-debugger-lessons**" which contains sample code. Readers can view the sample code according to the chapter correspondence. The directory "**0-godbg**" provides a relatively complete implementation of a symbol-level debugger for go language.

Of course, there have been some debuggers for the Go language, such as gdb, dlv, etc. To develop a debugger from scratch is not just to develop a new debugger, but to use the debugger as an entry point, that could help us integrate relevant knowledge. The technical points here involve the go language itself (type system, goroutine scheduling), the cooperation between the compiler and the debugger (DWARF), the operating system kernel (virtual memory, task scheduling, system calls, instructions patching) and processor-related instructions, etc.

In short, I hope to start with the development of a go language debugger as an entry point to help beginners quickly get started with go language development, and gradually understand the mechanisms behind operating system, compiler, debugger, and processor, so we could deepen the overall understanding of the computer system.

I hope that this book and related samples can be smoothly completed. It can be regarded as a way for me to hone my temperament and improve myself. It would be great if it can really help everyone.

## Read the Book locally

1. clone the repository
```bash
git clone https://github.com/hitzhangjie/golang-debugger-book
```

2. install gitbook or gitbook-cli
```bash
# macOS
brew install gitbook-cli

# linux
yum install gitbook-cli
apt install gitbook-cli

# windows
...
```

3. build the book
```bash
cd golang-debugger-book/book

# initialize gitbook plugins
make init 

# build English version
make english

# build Chinese version
make chinese

```

4. clean tmpfiles
```bash
make clean
```

> NOTE: please use Node v10.x.
>
> If you really want to use higher version of Node, please pay attention:
>
> 1. if you run `gitbook serve` has error and your `gitbook-cli` is installed globally. Find the NPM global installation directory and into dir `node_modules/gitbook-cli/node_modules/npm/node_modules`, run command `npm install graceful-fs@latest --save`
> 2. if you run `gitbook install` has error, go to user directory and into dir `.gitbook/versions/3.2.3/node_modules/npm`, run command `npm install graceful-fs@latest --save`

## Contact

Please email me **hit.zhangjie@gmail.com**, I will respond as soon as possible.

<a rel="license" href="http://creativecommons.org/licenses/by-nd/4.0/"><img alt="Creative Commons License" style="border-width:0" src="https://i.creativecommons.org/l/by-nd/4.0/88x31.png" /></a><br />This work is licensed under a <a rel="license" href="http://creativecommons.org/licenses/by-nd/4.0/">Creative Commons Attribution-NoDerivatives 4.0 International License</a>.

