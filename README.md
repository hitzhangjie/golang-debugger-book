# The Art of Debugging: Go Debugger Internals

Ever wondered how to develop a Go debugger? Curious about how debuggers work under the hood? This book provides comprehensive insights into these topics. Read the Chinese version online at: https://www.hitzhangjie.pro/debugger101.io/

> English version available at: https://www.hitzhangjie.pro/debugger101-en.io/
> And the repo: https://github.com/hitzhangjie/golang-debugger-book-en .

<p align="center">
<img alt="" src="./book/bookcover.jpeg" width="360px" />
</p>

## Introduction

This project delves into the development of a Go debugger, exploring various aspects including:

- Operating System support mechanisms
- Coordination between compiler, linker, and debugger
- Debugging information standards
- How to develop an instruction level debugger
- How to develop an symbolic level debugger
- How does the mordern debugger architect looks like
- How do to debug in modern software development
- And much more

Special thanks to [delve](https://github.com/go-delve/delve) and its author [derek parker](https://twitter.com/derkthedaring?lang=en), maintainer [aarzilli](https://github.com/aarzilli), along with all contributors. Their work has been instrumental in my learning journey, and I'm excited to share this knowledge with developers interested in debugging.

Developing a symbolic debugger requires a deep understanding of:

- Operating Systems (e.g., Linux ptrace and OS scheduler)
- CPU semantics, instructions (e.g., instruction patching), hardware breakpoints register, eflags
- Compilers, linkers, and loaders, and the debugger? How do they work together to help debugging
- Executable file formats and debugging information storage
- The description of different languages features, data, types on different OS, Archs
- Programming language-specific features (e.g., goroutines)

This project serves as an excellent opportunity to enhance your understanding of computer systems and their underlying technologies.

## Sample Code

The project includes a companion repository "**[golang-debugger-lessons](https://github.com/hitzhangjie/golang-debugger-lessons)**" containing sample code that corresponds to each chapter. The "[**0-godbg**](https://github.com/hitzhangjie/godbg)" directory provides a complete implementation of a insctruction-level debugger for Go."[**tinydbg**](https://github.com/hitzhangjie/tinydbg/tree/tinydbg_minimal)" repository is a [go-delve/delve](https://github.com/go-delve/delve) fork and simplified version for **Linux/Amd64** to help you quickly understand the core concepts and code.

While established debuggers like GDB and Delve exist for Go, developing a debugger from scratch serves as an excellent learning exercise. It not only helps understand how the debugger works, but also helps integrate knowledge across various domains:

- Go language internals (type system, goroutine scheduling)
- Go commandline utities development, especially uses spf13/cobra
- System level programming, understand how build toolchain works, how kernel works, how CPU works
- Go ebpf tracing utilities programming
- Operating system kernel concepts (virtual memory, task scheduling, system calls, instruction patching)
- etc.

> Perhaps more than understanding how debuggers work, deepening my knowledge of Computer Systems was the fundamental motivation behind writing this book. And, I wish this book could help more readers, too.

## Reading Locally

The book follows GitBook's structure, but since gitbook-cli is deprecated, we offer two methods to read the book locally:

### Using Docker (Recommended)

```bash
# For English version
rm book/_book
docker run --name gitbook --rm -v ${PWD}/book:/root/gitbook hitzhangjie/gitbook-cli:latest gitbook install .
docker run --name gitbook --rm -v ${PWD}/book:/root/gitbook -p 4000:4000 -p 35729:35729 hitzhangjie/gitbook-cli:latest gitbook serve .
```

For convenience, these commands are available in the Makefile - simply run `make english` to start the server.

### Using Legacy gitbook-cli

1. Clone the repository:

```bash
git clone https://github.com/hitzhangjie/golang-debugger-book-en
```

2. Serve the book:

```bash
cd book
gitbook install && gitbook serve
```

> Note: Installing gitbook-cli directly may encounter compatibility issues with recent Node.js and graceful-fs versions. To avoid these issues, we recommend using our Docker image `hitzhangjie/gitbook-cli:latest` instead of npm or homebrew installation.

## Contact

For any questions or feedback, please email me at **hit.zhangjie@gmail.com**. I'll respond as soon as possible.

### License

<a rel="license" href="http://creativecommons.org/licenses/by-nd/4.0/"><img alt="Creative Commons License" style="border-width:0" src="https://i.creativecommons.org/l/by-nd/4.0/88x31.png" /></a><br/>
This work is licensed under a <a rel="license" href="http://creativecommons.org/licenses/by-nd/4.0/">Creative Commons Attribution-NoDerivatives 4.0 International License </a>.
