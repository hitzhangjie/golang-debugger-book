## debug：构建后再调试

### 实现目标

`godbg debug [directory|file] [-- args...]` 先 `go build`，再把产物按 exec 的方式启动。它省掉“先手动编译、再 exec”两步，并保证构建时带上调试需要的参数；构建与启动命令本身在 6.3 讲过，本节只讲符号级调试对产物提的要求和产物生命周期。

```bash
$ ./godbg debug --help
Usage:
  godbg debug [directory|file] [-- args...] [flags]

Flags:
      --disable-aslr   禁用地址空间布局随机化（ch6.80）
```

- `--` 之前的位置参数是 go build 的构建目标（目录或源码文件，缺省 `.`，可以多个），`--` 之后的是程序参数；
- 构建参数写死三条：`-gcflags=all=-N -l`、`-ldflags=-compressdwarf=false`、`-o __debug_bin__`（常量 `BuildExecName`，`cmd/debug.go:13`）；没有 `--build-flags`、`--build-tags`、`--output`；
- 产物落在当前目录，会话结束即删除；`--disable-aslr` 同样支持。

### 基础知识

**为什么 `-N -l`**：优化会重排、合并甚至删除原本对应某条语句的指令，局部变量在寄存器和栈之间搬家或被优化掉，于是断点停不下来、单步顺序和源码对不上、变量显示 optimized out。内联是另一件事：被调函数体嵌进调用方后，调用处不再有真正的 CALL，同一段函数体多处内联还会变成多套变量位置；DWARF 虽用 inlined subroutine 描述这种逻辑调用，信息一旦不全，单步和栈回溯就丢层。`-N` 关优化、`-l` 禁内联，前面的 `all=` 让依赖包也按同样选项构建，否则只有命令行上的包被关掉。

**为什么 `-compressdwarf=false`**：Go 链接器默认压缩 DWARF（go1.19 起是 `SHF_COMPRESSED`，更早是 `.zdebug_*` 命名），压缩与否落在 section 头的一个标志位上。godbg 经标准库 `debug/elf` 读节，两种压缩形式都会被透明解压，所以这不是“读不读得了”的问题；显式关掉它的收益是：第 8 章的对照实验用 `readelf`/`dwarfdump` 直接看到原始 `.debug_*`，运行时也少一层解压。同一份源码两种构建的对比（`readelf -SW` 的 section 标志里，`C` 表示已压缩）：

```text
go1.24 默认                .debug_info ... C ...   0x036936
go1.24 + 该 flag           .debug_info ...         0x08c54c
```

要强调：这条 flag 管的是**压缩**，不是 DWARF 版本。版本由工具链决定——go1.24 出 v4，go1.25 起默认 v5（附录 12.6）；本书基线是 go1.24 + v4（8.1）。godbgv2 因此在 `Makefile` 里用 `GOTOOLCHAIN ?= go1.24.13` 钉住工具链，fixture 和正文输出都按这个基线。换成 go1.26 构建同一程序，即使加了 `-compressdwarf=false`，`readelf --debug-dump=info` 看到的仍是 `Version: 5`。

### 代码实现

#### 1. 用 ArgsLenAtDash 拆位置参数

debug 与 exec 不同：exec 的第一个位置参数一定是程序，debug 的第一个是 go build 的构建目标，后面既可能是更多构建目标，也可能是程序参数，光看位置分不清。所以按 `--` 切：

```go
// cmd/debug.go:37-46
cmdName := []string{"."}
var traceeArgs []string
if dash := cmd.ArgsLenAtDash(); dash >= 0 {
	if dash > 0 {
		cmdName = args[:dash]
	}
	traceeArgs = args[dash:]
} else if len(args) != 0 {
	cmdName = args
}
```

四种情形：`debug . -- -name value`（构建 `.`，参数给 tracee）、`debug .`（只构建）、`debug ./a ./b`（没有 `--`，两个都当构建目标，与 go build 一致）、`debug -- -flag`（`--` 前没有位置参数，构建目标取 `.`）。

#### 2. 固定构建参数

```go
// cmd/debug.go:48-56
cmdArgs := []string{"build", "-gcflags=all=-N -l", "-ldflags=-compressdwarf=false", "-o", BuildExecName}
cmdArgs = append(cmdArgs, cmdName...)
buildCmd := exec.Command("go", cmdArgs...)
if buf, err := buildCmd.CombinedOutput(); err != nil {
	fmt.Fprintf(os.Stderr, "build error: %v\n", err)
	fmt.Fprintf(os.Stderr, "\terrmsg: %s\n", string(buf))
	return err
}
```

`-gcflags=all=-N -l` 的值里有空格，必须作为**一个** argv 元素传进去；拆成两个会被 go 当成 `-l` 参数，报 `flag provided but not defined: -l`。失败时把编译器输出一并打出来，读者不用再手动跑一遍 go build 才知道原因。

#### 3. 启动与产物删除

构建成功后交给 `Client.Launch`，Kind 是 `api.KindDebug`，程序路径固定 `./` + `BuildExecName`（`cmd/debug.go:61`），`--` 之后的参数原样透传。产物删除在两处：

```go
// cmd/debug.go:62-74（节选）
if err != nil {
	os.RemoveAll(BuildExecName)
	return err
}
...
PostRun: func(cmd *cobra.Command, args []string) {
	defer os.RemoveAll(BuildExecName)
	startDebugSession(cmd)
},
```

启动失败那一支为什么要单独删？因为 cobra 在 `RunE` 返回错误后会直接返回，不再进入 `PostRun`（`spf13/cobra` 的 `command.go`），`defer` 根本没机会执行。

#### 4. 关于 tag

tag `ch9.2.14`（`c9b5985`）也是**空提交**：`git diff-tree` 同样显示零改动、tree 与父提交一致。构建、启动、`--` 拆分在 6.3/6.4 已经落地，这个 tag 只为挂节；本节没有新增代码。

### 执行测试

在一个临时模块里（`main.go` 打印 `os.Args` 后 sleep），会话进行中另开终端看产物，退出后再看：

```bash
$ ./godbg debug . -- -name value
process 1970110 launched, stopped by SIGTRAP
godbg> continue
tracee argv: [./__debug_bin__ -name value]
godbg> exit
tracee is built and run by tracer, remove binary and kill it
$ ls -l __debug_bin__          # 会话进行中
-rwxr-xr-x ... 3021696 __debug_bin__
$ ls -l __debug_bin__          # 会话退出后
ls: cannot access '__debug_bin__': No such file or directory
```

`tracee argv` 的第一项是 `./__debug_bin__`，说明启动的确实是构建产物。构建失败时不会产生新产物，报错带编译器原文：

```bash
$ ./godbg debug .
build error: exit status 1
	errmsg: # argprinter
./main.go:6:1: syntax error: unexpected EOF, expected }
```

注意 go 命令是在**当前目录**执行的，模块上下文以 CWD 为准：在模块外 `godbg debug /path/to/pkg` 会得到 `go.mod file not found`，正确姿势是先 `cd` 进模块。

### 本节小结

debug = go build + exec。真正属于符号级调试的只有那三条写死的构建参数：`-N -l` 保住指令与源码的对应关系，`all=` 让依赖包一起关优化，`-compressdwarf=false` 让 DWARF 保持未压缩、与第 8 章的对照实验口径一致；DWARF 版本则由 `GOTOOLCHAIN=go1.24.13` 钉住的 go1.24 保证为 v4。

位置参数用 `ArgsLenAtDash` 按 `--` 拆分，产物 `__debug_bin__` 在 `PostRun` 里删除、启动失败那条路径自己删。tag `ch9.2.14` 是空提交。
