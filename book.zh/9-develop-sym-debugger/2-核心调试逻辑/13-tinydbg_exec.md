## Exec

### 实现目标: `tinydbg exec ./prog`

本节介绍exec这个启动调试的命令：`tinydbg exec [executable] [flags]`，exec操作将执行executable对自动attach住对应的进程。在第6章介绍指令级调试器时，我们有演示如何通过exec.Command来指定要启动的程序、启动该程序以及如何在程序启动后自动被ptracer跟踪。如果忘记了这部分内容，可以回去看看6.1, 6.2, 6.3这几个小节。

demo tinydbg中的exec命令其实又是老调重弹，只不过这里tinydbg是前后端分离式架构，如果只考虑后端的target层对tracee的启动、控制部分，在需要注意的要点上是一样的。

```bash
$ tinydbg help exec
Execute a precompiled binary and begin a debug session.

This command will cause Delve to exec the binary and immediately attach to it to
begin a new debug session. Please note that if the binary was not compiled with
optimizations disabled, it may be difficult to properly debug it. Please
consider compiling debugging binaries with -gcflags="all=-N -l" on Go 1.10
or later, -gcflags="-N -l" on earlier versions of Go.

Usage:
  tinydbg exec <path/to/binary> [flags]

Flags:
      --continue     Continue the debugged process on start.
  -h, --help         help for exec
      --tty string   TTY to use for the target program

Global Flags:
      --accept-multiclient               Allows a headless server to accept multiple client connections via JSON-RPC.
      --allow-non-terminal-interactive   Allows interactive sessions of Delve that don't have a terminal as stdin, stdout and stderr
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

exec操作的选项相比attach操作增加了一个 `--disable-aslr` ，我们只介绍下这个选项，其他选项我们介绍attach操作时都介绍过了，不重复描述。OK，第6章指令级调试器部分我们介绍过ASLR。这个特性大家一般很少会去用到，所以我们再提一下。

ASLR是一种操作系统级别的安全技术，主要作用是通过随机化程序在内存中的加载位置来增加攻击者预测目标地址、利用软件漏洞进行恶意操作的难度。其核心机制包括动态随机分配进程地址空间中各个部分的位置，例如executable基址、库文件、堆和栈等。Linux内核默认开启了完整的地址随机化，但是对于executale地址随机化必须要开启PIE编译模式。这虽然带来了一定安全性，但是如果你想做一些自动化调试的任务，而这些任务中使用指令地址进行了某些操作，那么ASLR可能会让调试失败。

所以这里增加了一个选项 `--disable-aslr`，这个选项会禁用上述提及的所有地址空间随机化能力。

### 基础知识

### 代码实现

主要代码执行路径如下：

```bash
main.go:main.main
    \--> cmds.New(false).Execute()
            \--> execCommand.Run()
                    \--> execute(0, args, conf, "", debugger.ExecutingExistingFile, args, buildFlags)
                            \--> server := rpccommon.NewServer(...)
                            \--> server.Run()
                                    \--> debugger, _ := debugger.New(...)
                                            if attach 启动方式: debugger.Attach(...)
                                            elif core 启动方式：core.OpenCore(...)
                                            else 其他 debuger.Launch(...)
                                    \--> c, _ := listener.Accept() 
                                    \--> serveConnection(conn)
```

由于调试器后端初始化的逻辑我们之前都已经介绍过了，包括网络通信的初始化、debugger的初始化，这里我们直接看最核心的代码就好了。

对于exec启动方式的话，我们直接看debugger.Launch(...)的实现：

```go
// Launch will start a process with the given args and working directory.
func (d *Debugger) Launch(processArgs []string, wd string) (*proc.TargetGroup, error) {
    ...

	launchFlags := proc.LaunchFlags(0)
	if d.config.DisableASLR {
		launchFlags |= proc.LaunchDisableASLR
	}
    ...

	return native.Launch(processArgs, wd, launchFlags, d.config.TTY, d.config.Stdin, d.config.Stdout, d.config.Stderr)
}

func Launch(cmd []string, wd string, flags proc.LaunchFlags, tty string, stdinPath string, stdoutOR proc.OutputRedirect, stderrOR proc.OutputRedirect) (*proc.TargetGroup, error) {
    ...

    // 输入输出重定向设置
	stdin, stdout, stderr, closefn, err := openRedirects(stdinPath, stdoutOR, stderrOR, foreground)
	if err != nil {
		return nil, err
	}
    ...

	dbp := newProcess(0)
    ...
	dbp.execPtraceFunc(func() {
        // 通过personality系统调用，禁用地址空间随机化 (只影响当前进程及其子进程）
        // 然后再启动我们的待调试程序，此时该程序就是禁用地址空间随机化的
		if flags&proc.LaunchDisableASLR != 0 {
			oldPersonality, _, err := syscall.Syscall(sys.SYS_PERSONALITY, personalityGetPersonality, 0, 0)
			if err == syscall.Errno(0) {
				newPersonality := oldPersonality | _ADDR_NO_RANDOMIZE
				syscall.Syscall(sys.SYS_PERSONALITY, newPersonality, 0, 0)
				defer syscall.Syscall(sys.SYS_PERSONALITY, oldPersonality, 0, 0)
			}
		}

        // 启动待调试程序，此时该进程是被禁用了地址空间随机化的
		process = exec.Command(cmd[0])
		process.Args = cmd
		process.Stdin = stdin
		process.Stdout = stdout
		process.Stderr = stderr
		process.SysProcAttr = &syscall.SysProcAttr{
            // Ptrace=true，go标准库中，子进程中会调用PTRACEME
			Ptrace:     true, 
			Setpgid:    true,
			Foreground: foreground,
		}
        ...
		err = process.Start()
	})

    // 等待tracee启动完成
	dbp.pid = process.Process.Pid
	dbp.childProcess = true
	_, _, err = dbp.wait(process.Process.Pid, 0)

    // 进一步初始化，包括将tracee下的所有已有线程、未来可能创建的线程都纳入管控
	tgt, err := dbp.initialize(cmd[0])
	if err != nil {
		return nil, err
	}
	return tgt, nil
}
```

see go/src/syscall/exec_linux.go

```go
func forkAndExecInChild1(...) {
    ...
	if sys.Ptrace {
		_, _, err1 = RawSyscall(SYS_PTRACE, uintptr(PTRACE_TRACEME), 0, 0)
		if err1 != 0 {
			goto childerror
		}
	}
    ...
```

这样exec操作，调试器后端的目标层逻辑就执行完成了。前后端网络IO初始化也完成之后，前端就可以通过调试会话发送调试命令了。

### 执行测试

略

### 本文总结

本文介绍了tinydbg exec命令的实现细节。exec命令用于启动一个新进程并对其进行调试，主要通过设置进程的SysProcAttr.Ptrace=true来实现。当新进程启动时，go运行时会自动调用PTRACE_TRACEME使子进程进入被跟踪状态。调试器等待子进程启动完成后，会将其所有线程纳入管控。这样就完成了exec操作的目标层逻辑，为后续的调试会话做好了准备。

另外我们也重新回顾了下ASLR的作用，以及对调试器调试的影响，介绍了下 `--disable-aslr` 的方法。
