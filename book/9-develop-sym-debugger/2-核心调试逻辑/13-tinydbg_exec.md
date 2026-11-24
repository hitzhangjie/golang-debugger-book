## exec：启动一个新进程并跟踪

### 实现目标

`godbg exec <prog> [args...]` 把一个已经构建好的可执行程序拉起来，一起手就把它停住，交给调试会话。与 9.2.11/9.2.12 的 attach 相比，这里不需要“等”谁：进程是调试器自己创建的子进程。

```bash
$ ./godbg exec --help
Usage:
  godbg exec <prog> [args...] [flags]

Flags:
      --disable-aslr   禁用地址空间布局随机化（ch6.80）
```

- 第一个位置参数是被调试程序，其余位置参数原样传给 tracee；
- `--` 之前的 flag 归 `godbg`，`--` 之后的一律给 tracee；程序参数不以 `-` 开头时可以省略 `--`；
- 本地 flag 只有 `--disable-aslr`，没有 `--tty`/`--redirect`/`--wd`/`--continue`：stdio 直接继承当前终端，会话停在入口，“继续跑”交给会话里的 `continue`；成功后打印 `process <pid> launched, stopped by SIGTRAP`。

### 基础知识

6.1 已经把 `PTRACE_TRACEME` 与 post-exec `SIGTRAP` 讲透，这里只补三件第 9 章才需要的东西。**停止点**：`SysProcAttr.Ptrace=true` 让子进程在 exec 前 `PTRACE_TRACEME`，exec 成功时内核投递 `SIGTRAP`，进程停在**新程序的入口**。对非 PIE 的 Go 二进制入口是 `_rt0_amd64_linux`；对动态链接的 PIE 程序，第一站是动态链接器。

**stdio 继承**：`pkg/target/process.go:281-283` 把 `os.Stdin/Stdout/Stderr` 直接赋给子进程，没有重定向机制。实现简单，tracee 的打印直接落在当前终端；代价是调试器插不上手，不能给 tracee 输出加前缀或转存文件。

**关闭 ASLR**（背景见附录 12.8）：godbg 不在本进程里调 `personality`，而是用 `setarch x86_64 -R` 包一层——`setarch` 先设 `ADDR_NO_RANDOMIZE` 再 exec 目标程序。副作用是被跟踪的第一层进程是 `setarch`，第一次 `SIGTRAP` 停在 setarch 的入口，此时 ASLR 还没关；必须放行 `setarch`，再等它 exec 目标程序时产生的 `PTRACE_EVENT_EXEC`，那时的停止点才是真正的 tracee。

### 代码实现

#### 1. 命令层：`--` 与参数透传

```go
// cmd/exec.go:32-38
disableASLR, _ := cmd.Flags().GetBool("disable-aslr")
opts := &api.LaunchOptions{DisableASLR: disableASLR}
pid, err := Client.Launch(api.KindExec, args[0], args[1:], opts)
if err != nil {
	return err
}
fmt.Printf("process %d launched, stopped by SIGTRAP\n", pid)
```

透传就是 `args[1:]`：cobra 已经摘掉 `--`、并保证其后的参数进入 `args`，命令层不必自己切分；`--` 的说明写在 `Long` 里，help 直接可见。

#### 2. 契约与门面

契约签名是 `Launch(kind Kind, cmd string, args []string, opts *LaunchOptions) (int, error)`（`pkg/service/api/client.go:36`），选项结构 `api.LaunchOptions` 只有一个布尔字段 `DisableASLR`（`pkg/service/api/types.go:9-12`）。门面只做两件事：转成目标层的选项类型，调 `target.NewDebuggedProcess`，再用返回的进程建符号层：

```go
// pkg/service/debugger/debugger.go:29-43（省略错误检查）
var top *target.LaunchOptions
if opts != nil {
	top = &target.LaunchOptions{DisableASLR: opts.DisableASLR}
}
dbp, err := target.NewDebuggedProcess(cmd, args, target.Kind(kind), top)
d.t, err = proc.NewTarget(dbp)
return dbp.Process.Pid, nil
```

`api.KindExec` 与 `target.EXEC` 的取值顺序一致（`pkg/target/kind.go:6-10`），可以直接转换；Kind 真正派上用场是在退出善后：exec 杀进程、attach 分离、debug 还要删产物（`cmd/debug/exit.go`）。

#### 3. 目标层：启动与两段停止

```go
// pkg/target/process.go:273-280
var progCmd *exec.Cmd
if opts != nil && opts.DisableASLR {
	// util-linux ≥2.39 的 setarch 要求显式指定架构参数
	argv := append([]string{archName(), "-R", execName}, args...)
	progCmd = exec.Command("setarch", argv...)
} else {
	progCmd = exec.Command(execName, args...)
}
```

紧接着三行把 `os.Stdin/Stdout/Stderr` 赋给子进程（`:281-283`），`SysProcAttr` 设 `Ptrace=true`、`Setpgid=true`、`Foreground=false`（`:285-289`），环境里追加 `GODEBUG=asyncpreemptoff=1`（`:290-291`）。`archName()` 返回 `x86_64`：util-linux ≥ 2.39 的 `setarch` 要求显式写架构；`GODEBUG=asyncpreemptoff=1` 关掉 Go 运行时的异步抢占，否则运行时会用 `SIGURG` 抢占线程，tracee 在莫名其妙的位置停下来。

`launchCommand` 末尾 `wait` 到 `SIGTRAP`；若开了 `--disable-aslr`，此时停的是 `setarch`，于是放行它并等 `PTRACE_EVENT_EXEC`：

```go
// pkg/target/process.go:83-94（省略错误检查）
if opts != nil && opts.DisableASLR {
	syscall.PtraceCont(dbp.Process.Pid, 0)
	_, status, _ := dbp.wait(dbp.Process.Pid, syscall.WSTOPPED)
	if !status.Stopped() || status.TrapCause() != syscall.PTRACE_EVENT_EXEC {
		return fmt.Errorf("unexpected status after setarch: %v", status)
	}
}
```

`TrapCause()` 取出事件号，`PTRACE_EVENT_EXEC` 由 `PTRACE_O_TRACEEXEC` 触发。此前已经设好四个 TRACE 选项（CLONE/FORK/VFORK/EXEC），这段之后 `addThread(pid, false)` 把主线程加入线程表、`currentThread` 指向它，`NewDebuggedProcess` 返回。

#### 4. 关于 tag

tag `ch9.2.13`（`0b1c7c0`）是**空提交**：`git diff-tree` 显示零个文件改动，提交的 tree 与父提交完全相同。exec 的启动链路在 6.1 就已落地，`--` 透传也在 6.1 的“向被调试程序传递参数”一小节讲过，这个 tag 只是给书稿挂节用。所以本节没有新增代码，写的是 tag 那棵树里已有的实现（行号以 master 为准，`process.go`、`debugger.go` 在 tag 之后有增补）。

### 执行测试

tracee 用一个只打印 `os.Args` 然后 `sleep` 的小程序，`--init` 脚本里放 `continue` 和 `exit`：

```bash
$ ./godbg exec /tmp/argprint-bin -- -name value
process 1964896 launched, stopped by SIGTRAP
godbg> continue
tracee argv: [/tmp/argprint-bin -name value]
```

省略 `--` 也能透传，只要参数不以 `-` 开头；反之就会被当成 `godbg` 自己的 flag：

```bash
$ ./godbg exec /tmp/argprint-bin arg1 arg2
tracee argv: [/tmp/argprint-bin arg1 arg2]
$ ./godbg exec /tmp/argprint-bin -name value
Error: unknown shorthand flag: 'n' in -name
```

`--disable-aslr` 的效果可以用 `pregs` 直接看。对动态链接的 `/bin/sleep`，连续启动三次、每次在会话里 `pregs` 读首次停止的 Rip：

```bash
$ ./godbg exec /bin/sleep -- 5                   # 0x7f6ecba1ede0 / 0x7f874581ede0 / 0x7f9561c1ede0
$ ./godbg exec /bin/sleep --disable-aslr -- 5    # 0x7ffff7c1ede0（三次相同）
```

不开 ASLR 时地址每次都在变，开了之后稳定在同一个地址——正是附录 12.8 说的“记录下来的地址下次还能用”。对非 PIE 的 Go 程序，第一次 `threads` 能看到停止点在入口：

```bash
$ ./godbg exec _fixtures/loop           # 输出 process 1957459 launched, stopped by SIGTRAP
godbg> threads
* Thread 1957459 at 0x478120 _rt0_amd64_linux .../runtime/rt0_linux_amd64.s:8
```

### 本节小结

exec 自己创建进程：命令层把 `--` 之后的参数用 `args[1:]` 交给 `Client.Launch(KindExec, ...)`，门面转 `target.NewDebuggedProcess`，目标层用带 `Ptrace` 的 `exec.Command` 启动，等 post-exec 的 `SIGTRAP` 停住，再把主线程和四个 TRACE 选项安排好。

`--disable-aslr` 经 `setarch x86_64 -R` 实现，代价是多一段“放行 setarch、等 `PTRACE_EVENT_EXEC`”的处理；没有 tty/redirect/wd/continue。tag `ch9.2.13` 是空提交。下一节 debug 在 exec 前面加一步 go build。
