# The Art of Debugging: Go Debugger Internals

Ever wondered how to develop a Go debugger? Curious about how debuggers work under the hood? This book provides comprehensive insights into these topics.
Read the book:

- Chinese version: [www.hitzhangjie.pro/debugger101.io](https://www.hitzhangjie.pro/debugger101.io)
- English version: [www.hitzhangjie.pro/debugger101-en.io](https://www.hitzhangjie.pro/debugger101-en.io/)

> ps: The English version repo: [https://github.com/hitzhangjie/golang-debugger-book-en](https://github.com/hitzhangjie/golang-debugger-book-en) .

© 2018–present 张杰 (hitzhangjie). Licensed under [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/). You may share unmodified copies for non-commercial purposes with attribution. You may not sell this work, distribute modified versions, or present it as your own. The author reserves all commercial publishing rights. See [Copyright and License](#copyright-and-license) for details.

## Introduction

This project explores the development of a Go debugger, covering a wide range of topics, including:

- Operating system support mechanisms
- Coordination between compiler, linker, and debugger
- Debugging information standards that guide the compiler, linker, and debugger
- How to develop an instruction-level debugger
- How to develop a symbolic-level debugger
- What a modern debugger architecture looks like
- Debugging in modern software development (SSH remote, Kubernetes containers)
- Deterministic debugging
- Debugging with LLM agents
- And much more

Special thanks to Delve and its author, Derek Parker, maintainer aarzilli, along with all contributors. Their work has been instrumental in my learning journey, and I'm excited to share this knowledge with developers interested in debugging.

Developing a symbolic debugger requires a deep understanding of:

- Operating systems (e.g., Linux ptrace and the OS scheduler)
- CPU semantics and instructions (e.g., instruction patching), hardware breakpoint registers, and eflags
- Compilers, linkers, and loaders—and how they work with the debugger to support debugging
- Executable file formats and debug information storage
- How language features, data, and types are described across different OSes and architectures
- Programming language–specific features (e.g., interfaces, goroutines)

This project is an excellent opportunity to deepen your understanding of computer systems and the technologies that power them.

## Sample Code

The project includes a companion repository "**[golang-debugger-lessons](https://github.com/hitzhangjie/golang-debugger-lessons)**" containing sample code that corresponds to each chapter. The "**[0-godbg](https://github.com/hitzhangjie/godbg)**" directory provides a complete implementation of a insctruction-level debugger for Go."**[tinydbg](https://github.com/hitzhangjie/tinydbg/tree/tinydbg_minimal)**" repository is a [go-delve/delve](https://github.com/go-delve/delve) fork and simplified version for **Linux/Amd64** to help you quickly understand the core concepts and code.

While established debuggers like GDB and Delve already exist for Go, building one from scratch is an excellent learning exercise. It not only demystifies how debuggers work but also connects knowledge across many domains:

- Go language internals (type system, goroutine scheduling)
- Developing Go command-line tools with spf13/cobra
- System-level programming, including how the build toolchain, kernel, and CPU work
- Writing eBPF tracing utilities for Go
- Operating system kernel mechanisms (virtual memory, task scheduling, system calls, instruction patching)
- And more

Ultimately, my motivation for writing this book was less about understanding debuggers and more about deepening my understanding of computer systems. I hope it helps many readers do the same.

## Reading Locally

The book follows GitBook's structure. The original Node.js gitbook-cli is deprecated; we offer three methods to read the book locally:

### Using Docker (Recommended)

```bash
# For English version
rm book/_book
docker run --name gitbook --rm -v ${PWD}/book:/root/gitbook hitzhangjie/gitbook-cli:latest gitbook install .
docker run --name gitbook --rm -v ${PWD}/book:/root/gitbook -p 4000:4000 -p 35729:35729 hitzhangjie/gitbook-cli:latest gitbook serve .
```

For convenience, these commands are available in the Makefile - simply run `make english` to start the server.

### Using gitbook (Go rewrite)

[hitzhangjie/gitbook](https://github.com/hitzhangjie/gitbook) is a Go rewrite of gitbook-cli. Usage is the same as the original CLI. Search, table of contents, and other features that previously required plugins are built in.

1. Install:

```bash
go install github.com/hitzhangjie/gitbook@latest
```

1. Serve the book:

```bash
cd book
gitbook serve
```

### Using Legacy gitbook-cli

1. Clone the repository:

```bash
git clone https://github.com/hitzhangjie/golang-debugger-book-en
```

1. Serve the book:

```bash
cd book
gitbook install && gitbook serve
```

> Note: Installing gitbook-cli directly may encounter compatibility issues with recent Node.js and graceful-fs versions. To avoid these issues, we recommend using our Docker image `hitzhangjie/gitbook-cli:latest` or the Go rewrite above, instead of npm or homebrew installation.

## Copyright and License

© 2018–present 张杰 (hitzhangjie).

This is a free textbook for reading and non-commercial sharing. You are welcome to read it and post an **unmodified** copy on your own website, as long as you do not charge for it. Officially, this work is licensed under the [Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International License](https://creativecommons.org/licenses/by-nc-nd/4.0/). 

[![CC BY-NC-ND 4.0](https://licensebuttons.net/l/by-nc-nd/4.0/88x31.png)](https://creativecommons.org/licenses/by-nc-nd/4.0/)

The author retains all commercial rights, including the right to publish print and paid electronic editions. This license only describes what *others* may do; it does not restrict the author's own use of the work.

In plain language:

**You may**

- Copy and redistribute unmodified copies for **non-commercial** purposes, including posting them on your own site
- Quote short excerpts with proper citation

**You may not**

- Sell this book, or otherwise use it for commercial advantage (including wrapping it as a paid course, paid reprint, or other commercial product)
- Distribute modified, remixed, abridged, or rewritten versions of this book (including publishing a translation as a new work)
- Remove, replace, or obscure the author's name
- Present this work, in whole or in substantial part, as your own
- Strip the copyright notice or license terms when you share it

If you need permission beyond this license (for example, to publish a translation, or to include substantial portions in another book or a paid course), email [hit.zhangjie@gmail.com](mailto:hit.zhangjie@gmail.com).

## Contact

For any questions or feedback, please email me at **[hit.zhangjie@gmail.com](mailto:hit.zhangjie@gmail.com)**. I'll respond as soon as possible.
