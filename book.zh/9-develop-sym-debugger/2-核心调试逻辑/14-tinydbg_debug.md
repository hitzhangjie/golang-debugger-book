## Debug

### 实现目标: `tinydbg debug ./path-to`

attach操作是对一个已经运行的程序进行调试，或者--waitfor等待一个程序运行起来后进行调试。exec是对一个已经编译构建好的go可执行程序进行调试。debug则是对源代码的main package先进行编译，然后再执行类似exec的逻辑。go build这么简单的事情，为什么要多搞一个debug操作出来呢？

从实现上来说，debug确实没有比exec多出太多编码工作，它主要是简化大家的调试体验：
1）软件调试依赖调试信息生成，我们必须告知编译器生成调试信息，而且要对所有用到的modules；
2）编译器会对代码进行优化，如函数内联等，调试信息生成时如果没有照顾到这种情况，调试也会有问题，所以一般还会禁用内联；
通常需要这样指定编译选项，`go build -gcflags 'all=-N -l'` 这个命令是不是也没那么好敲？

debug就是一个简化上述操作流的命令，我们一起来看下：

```bash
$ tinydbg help debug
Compiles your program with optimizations disabled, starts and attaches to it.

By default, with no arguments, Delve will compile the 'main' package in the
current directory, and begin to debug it. Alternatively you can specify a
package name and Delve will compile that package instead, and begin a new debug
session.

Usage:
  tinydbg debug [package] [flags]

Flags:
      --continue        Continue the debugged process on start.
  -h, --help            help for debug
      --output string   Output path for the binary.
      --tty string      TTY to use for the target program

Global Flags:
      --accept-multiclient               Allows a headless server to accept multiple client connections via JSON-RPC.
      --allow-non-terminal-interactive   Allows interactive sessions of Delve that don't have a terminal as stdin, stdout and stderr
      --build-flags string               Build flags, to be passed to the compiler. For example: --build-flags="-tags=integration -mod=vendor -cover -v"
      --disable-aslr                     Disables address space randomization
      --headless                         Run debug server only, in headless mode. Server will accept JSON-RPC client connections.
      --init string                      Init file, executed by the terminal client.
  -l, --listen string                    Debugging server listen address. Prefix with 'unix:' to use a unix domain socket. (default "127.0.0.1:0")
      --log                              Enable debugging server logging.
      --log-dest string                  Writes logs to the specified file or file descriptor (see 'dlv help log').
      --log-output string                Comma separated list of components that should produce debug output (see 'dlv help log')
  -r, --redirect stringArray             Specifies redirect rules for target process (see 'dlv help redirect')
      --wd string                        Working directory for running the program.
```

因为这里涉及到编译这个动作，`go build --tags=?` 支持对特定buildtag的源码进行编译，所以debug操作也需要增加一个选项 `--build-tags=` 来与之配合。其他选项我们前面都介绍过。

### 基础知识

debug操作主要，主要就是为了保证编译时能够传递正确的编译选项，以保证编译器链接器能够生成DWARF调试信息，从而使我们顺利的进行调试。

没有其他特殊的。OK，我们来看下代码实现。

### 代码实现

```bash
main.go:main.main
    \--> cmds.New(false).Execute()
            \--> debugCommand.Run()
                    \--> debugCmd(...)
                            \--> buildBinary
                            \--> execute(0, processArgs, conf, "", debugger.ExecutingGeneratedFile, dlvArgs, buildFlags)
                                    \--> server := rpccommon.NewServer(...)
                                    \--> server.Run()
                                            \--> debugger, _ := debugger.New(...)
                                                if attach 启动方式: debugger.Attach(...)
                                                elif core 启动方式：core.OpenCore(...)
                                                else 其他 debuger.Launch(...)
                                            \--> c, _ := listener.Accept() 
                                            \--> serveConnection(conn)
```

构建可执行程序的操作如下，这个函数其实是支持对main module和test package执行构建的（isTest），只不过我们的demo tinydbg希望尽可能简化，而tinydbg debug、tinydbg test的不同之处也仅仅在此而已，所以我们demo tinydbg中移除了test命令。

```go
func buildBinary(cmd *cobra.Command, args []string, isTest bool) (string, bool) {
    // 确定构建产物的文件名：
    // main module，go build 产物为 __debug_bin
    // test package，用了go test -c的文件名方式
	if isTest {
		debugname = gobuild.DefaultDebugBinaryPath("debug.test")
	} else {
		debugname = gobuild.DefaultDebugBinaryPath("__debug_bin")	
    }

    // 执行构建操作 go build or go test -c, 带上合适的编译选项
	err = gobuild.GoBuild(debugname, args, buildFlags)
	if err != nil {
		if outputFlag == "" {
			gobuild.Remove(debugname)
		}
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return "", false
	}
	return debugname, true
}

// GoBuild builds non-test files in 'pkgs' with the specified 'buildflags'
// and writes the output at 'debugname'.
func GoBuild(debugname string, pkgs []string, buildflags string) error {
	args := goBuildArgs(debugname, pkgs, buildflags, false)
	return gocommandRun("build", args...)
}
```

debug命令，在正常完成构建后，接下来和exec命令一样执行debugger.Launch(...)，完成进程启动前的ALSR相关的设置、然后对Fork后子进程PTRACEME相关的设置，然后启动进程，进程启动后继续完成必要的初始化动作，如读取二进制文件的信息，通过ptrace设置将已经启动的线程和未来可能创建的线程全部管控起来。这里我们就这样简单总结一下，不详细展开了。

### 执行测试

略

### 本文总结

本文介绍了`tinydbg debug`命令的实现原理和使用方法。该命令的主要目的是简化Go程序的调试流程，通过自动添加必要的编译选项（如`-gcflags 'all=-N -l'`）来确保生成正确的调试信息、禁用内联优化。debug命令首先会编译源代码（如果有buildtags控制也支持通过 `--build-tags` 进行控制）然后执行类似exec的初始化逻辑，初始化debugger启动并attach到进程、管控进程下线程，以及初始化调试器的网络层通信。
