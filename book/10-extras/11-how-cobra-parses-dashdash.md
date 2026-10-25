## 命令行参数与选项的分离：cobra 如何解析 `--`

### 1. 问题背景

调试器本身是一个命令行程序，它有自己的选项；而被调试程序也有自己的命令行参数。以 `godbg` 为例：

```bash
godbg exec <prog> -- --flag1=value1 arg1 arg2
```

这里同时存在两套“参数”：

* `godbg` 自己的选项，比如 `-v/--verbose`；
* 被调试程序的参数，比如 `--flag1=value1 arg1 arg2`。

如果两者混在一起，解析器就无法区分 `--flag1` 到底是给调试器的还是给被调试程序的。因此需要一个明确的分隔符，把“调试器选项”和“被调试程序参数”切开，这个分隔符就是 `--`。

一个常见的疑问是：godbg 使用了 `spf13/cobra` 来管理命令和选项，但在 `exec` 命令的 `RunE` 中并没有看到任何针对 `--` 的特殊处理，那么 `--` 到底是在哪里被消费掉的？

**结论：`--` 的语义由底层 `spf13/pflag` 实现，cobra 只负责把解析后的位置参数透传给 `RunE`。** 业务代码拿到的 `args` 中已经不含 `--` 本身。

### 2. 完整解析链路

以 `godbg exec ./prog -- --flag1=value1 arg1 arg2` 为例，`os.Args[1:]` 是：

```
[exec, ./prog, --, --flag1=value1, arg1, arg2]
```

整个解析过程分为三步：cobra 先定位子命令，再由 pflag 解析标志，最后 cobra 把剩余位置参数交给 `RunE`。

#### 2.1 cobra `Find`：定位子命令

cobra 的 `ExecuteC` 首先调用 `Find`，沿着参数列表找到真正要执行的子命令。查找过程中会调用 `stripFlags` 跳过标志，只保留候选的位置参数（`cobra@v1.10.2/command.go`）：

```go
func stripFlags(args []string, c *Command) []string {
	if len(args) == 0 {
		return args
	}
	c.mergePersistentFlags()

	commands := []string{}
	flags := c.Flags()

Loop:
	for len(args) > 0 {
		s := args[0]
		args = args[1:]
		switch {
		case s == "--":
			// "--" terminates the flags
			break Loop
		case strings.HasPrefix(s, "--") && !strings.Contains(s, "=") && !hasNoOptDefVal(s[2:], flags):
			// If '--flag arg' then delete arg from args.
			fallthrough
		case strings.HasPrefix(s, "-") && !strings.Contains(s, "=") && len(s) == 2 && !shortHasNoOptDefVal(s[1:], flags):
			// If '-f arg' then delete 'arg' from args.
			if len(args) <= 1 {
				break Loop
			} else {
				args = args[1:]
				continue
			}
		case s != "" && !strings.HasPrefix(s, "-"):
			commands = append(commands, s)
		}
	}

	return commands
}
```

对 root 命令来说：

1. `exec` 不是标志，作为子命令候选；
2. `./prog` 不是标志，也作为候选；
3. 遇到 `--`，`break Loop`，后面的内容不再参与子命令查找。

于是 cobra 找到了 `exec` 子命令，并用 `argsMinusFirstX` 去掉 `exec` 一词，把 `[./prog, --, --flag1=value1, arg1, arg2]` 交给 `exec` 继续处理。由于 `exec` 没有子命令，`findNext("./prog")` 返回 nil，`Find` 就此结束，返回 `exec` 和完整的参数列表。

注意：这一步的 `stripFlags` **只用于查找子命令**，并不修改最终传给 `RunE` 的参数，也不是真正消费 `--` 的地方。

#### 2.2 cobra `execute`：解析标志并提取位置参数

找到命令后，cobra 调用 `ParseFlags` 做真正的标志解析，然后通过 `Flags().Args()` 取出位置参数（`cobra@v1.10.2/command.go:919`、`command.go:963`、`command.go:1015`）：

```go
err = c.ParseFlags(a)
if err != nil {
	return c.FlagErrorFunc()(c, err)
}
// ...
argWoFlags := c.Flags().Args()
if c.DisableFlagParsing {
	argWoFlags = a
}
// ...
if err := c.RunE(c, argWoFlags); err != nil {
	return err
}
```

`ParseFlags` 内部会合并持久标志，然后调用 pflag 的 `FlagSet.Parse`：

```go
func (c *Command) ParseFlags(args []string) error {
	if c.DisableFlagParsing {
		return nil
	}
	// ...
	c.mergePersistentFlags()
	// ...
	err := c.Flags().Parse(args)
	// ...
}
```

`--` 就是在这之后的 pflag 解析中被消费的。

#### 2.3 pflag `parseArgs`：`--` 终止标志解析

pflag 的 `parseArgs` 是整条链路的关键（`pflag@v1.0.9/flag.go:1129`）：

```go
for len(args) > 0 {
	s := args[0]
	args = args[1:]
	if len(s) == 0 || s[0] != '-' || len(s) == 1 {
		if !f.interspersed {
			f.args = append(f.args, s)
			f.args = append(f.args, args...)
			return nil
		}
		f.args = append(f.args, s)
		continue
	}

	if s[1] == '-' {
		if len(s) == 2 { // "--" terminates the flags
			f.argsLenAtDash = len(f.args)
			f.args = append(f.args, args...)
			break
		}
		args, err = f.parseLongArg(s, args, fn)
	} else {
		args, err = f.parseShortArg(s, args, fn)
	}
	if err != nil {
		return
	}
}
```

逐词分析 `[./prog, --, --flag1=value1, arg1, arg2]`：

| 输入 token | 处理逻辑 | 位置参数 `f.args` |
| --- | --- | --- |
| `./prog` | 不以 `-` 开头，作为位置参数保存 | `[./prog]` |
| `--` | `len(s) == 2`，记录 `argsLenAtDash = 1`，把其后的所有 token 原样追加，然后 `break` | `[./prog, --flag1=value1, arg1, arg2]` |
| `--flag1=value1` | 因已 `break`，不再解析 | 同上 |
| `arg1`、`arg2` | 因已 `break`，不再解析 | 同上 |

由此得到两个重要事实：

1. **`--` 本身不会出现在位置参数中**，它被 pflag 吞掉了；
2. **`--` 之后的任何 token 都不再被当作标志解析**，无论它们长得多像标志。

最终 cobra 把 `[./prog, --flag1=value1, arg1, arg2]` 传给 `exec` 命令的 `RunE`。

### 3. 在 godbgv2 中的对应实现

`exec` 命令的实现非常直接（`cmd/exec.go`）：

```go
RunE: func(cmd *cobra.Command, args []string) error {
	if len(args) < 1 {
		return errors.New("参数错误")
	}

	// 启动并跟踪被调试进程（剩余参数原样传递给被调试程序）
	pid, err := Client.Launch(api.KindExec, args[0], args[1:]...)
	if err != nil {
		return err
	}
	fmt.Printf("process %d launched, stopped by SIGTRAP\n", pid)
	return nil
},
```

`args[0]` 是被调试程序路径，`args[1:]` 是它的参数。由于 pflag 已经去掉了 `--`，这里无需再做任何分隔处理，直接把 `args[1:]` 转发给 `Launch` 即可。

### 4. 边界情况与易错点

#### 4.1 位置参数之后的标志仍会被 godbg 解析

pflag 默认开启 `interspersed`（`pflag@v1.0.9/flag.go:1269`），即标志可以和位置参数交错出现。因此：

```bash
godbg exec ./prog -v
```

中的 `-v` 会命中 root 命令的持久标志 `-v/--verbose`，而不是被调试程序的参数。若被调试程序也需要 `-v`，必须写成：

```bash
godbg exec ./prog -- -v
```

#### 4.2 省略 `--` 时，带破折号的参数会报错

```bash
godbg exec ./prog --flag1=value1
```

`--flag1` 会在 `exec` 命令自己的标志集合（只有继承来的 `-v/--verbose`、`--help`）里查找，找不到就报 `unknown flag: --flag1`。这正是 `exec` 命令的 `Long` 描述里强调 `--` 的原因。

#### 4.3 `--` 也可以写在程序路径之前

```bash
godbg exec -- ./prog --foo
```

pflag 在 `--` 处停止解析，因此 `./prog` 和 `--foo` 都会原样进入 `args`。此时 `args[0]` 仍然是 `./prog`，效果与把 `--` 放在程序路径之后相同。

#### 4.4 如何知道是否使用过 `--`

`cmd.Flags().ArgsLenAtDash()` 返回 `--` 之前的位置参数个数；没有出现 `--` 时返回 `-1`。对于上面的例子，该值为 `1`（`./prog`）。当前 godbg 只是整体转发参数，不需要这个信息，但在需要区分“参数是写死的还是用户用 `--` 明确分隔的”时会很有用。

#### 4.5 如果确实要传递 `--` 本身

由于第一个 `--` 会被 pflag 吞掉，想把它传给被调试程序，需要写两次：

```bash
godbg exec ./prog -- -- arg
```

第一个 `--` 被 pflag 消费，第二个作为普通 token 留在 `args` 中。

#### 4.6 需要完全接管参数时

如果希望像 delve 那样完全自己解析参数，可以给命令设置：

```go
DisableFlagParsing: true
```

此时 cobra 跳过 `ParseFlags`，`RunE` 拿到的是原始参数（包括 `--`），需要自己完成全部解析。另一种折中方案是 `cmd.Flags().SetInterspersed(false)`，让 pflag 在遇到第一个位置参数时就停止解析标志，其后的内容全部作为位置参数保留。

### 5. 小结

`godbg exec ./prog -- --flag1=value1 arg1 arg2` 的解析结果是：

* `--` 由 pflag 在 `parseArgs` 中消费，不进入位置参数；
* 其后的 `--flag1=value1 arg1 arg2` 原样保留，不再做标志解析；
* cobra 将 `[./prog, --flag1=value1, arg1, arg2]` 传给 `RunE`；
* `RunE` 取 `args[0]` 作为程序路径，`args[1:]` 作为被调试程序参数。

因此，业务代码里看不到 `--` 的处理是正常的：这件事在 cobra/pflag 这一层就已经完成了。理解这条链路的意义在于，当参数划分出现问题时，可以从 `Find`（找子命令）、`ParseFlags`（解析标志）、`parseArgs`（消费 `--`）三个层次分别排查，而不是在 `RunE` 里反复寻找并不存在的分隔逻辑。
