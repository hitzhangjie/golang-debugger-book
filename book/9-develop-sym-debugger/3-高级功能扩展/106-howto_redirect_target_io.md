## 进程IO重定向

### 为什么需要支持输入输出重定向？

在调试程序时，控制程序的输入输出流是非常必要的，原因如下：

1. **交互式程序**：许多程序需要用户交互输入。如果没有适当的重定向支持，调试这类程序将会变得困难或不可能。
2. **测试和自动化**：重定向输入输出允许进行自动化测试场景，可以程序化地提供输入并捕获输出进行验证。
3. **调试环境控制**：有时我们需要将调试器的输入输出与目标程序的输入输出分开，以避免混淆并保持清晰的调试会话。

### tinydbg中的重定向方法

tinydbg提供了两种主要方法来控制目标程序的输入输出：

#### 1. TTY重定向（`--tty`）

`--tty`选项允许你指定一个TTY设备用于目标程序的输入输出。这对于需要正确终端界面的交互式程序特别有用。

使用方法：

```bash
tinydbg debug --tty /dev/pts/X main.go
```

#### 2. 文件重定向（`-r`）

`-r`选项允许你将目标程序的输入输出重定向到文件。这对于非交互式程序或需要捕获输出进行后续分析的情况很有用。

使用方法：

```bash
tinydbg debug -r stdin=in.txt,stdout=out.txt,stderr=err.txt main.go
```

#### 实现细节

当启动调试会话时，tinydbg通过以下过程处理标准输入输出流（stdin、stdout、stderr）的重定向：

1. 对于TTY重定向：
   - 打开指定的TTY设备
   - 将目标程序的文件描述符重定向到这个TTY
   - 这允许与目标程序进行适当的终端交互

```go
// TTY重定向实现
func setupTTY(cmd *exec.Cmd, ttyPath string) error {
	tty, err := os.OpenFile(ttyPath, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open tty: %v", err)
	}

	// 设置标准输入输出
	cmd.Stdin = tty
	cmd.Stdout = tty
	cmd.Stderr = tty

	// 设置进程属性
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setctty: true,
		Setsid:  true,
	}

	return nil
}
```

2. 对于文件重定向：
   - 打开指定的文件
   - 将目标程序的文件描述符重定向到这些文件
   - 这实现了输入输出的捕获和重放功能

在Go程序中实现重定向时，我们主要通过设置 `os/exec.Cmd` 的 `SysProcAttr` 和标准输入输出来实现：

```go
// 文件重定向实现
func setupFileRedirection(cmd *exec.Cmd, stdin, stdout, stderr string) error {
	// 设置标准输入
	if stdin != "" {
		stdinFile, err := os.OpenFile(stdin, os.O_RDONLY, 0)
		if err != nil {
			return fmt.Errorf("open stdin file: %v", err)
		}
		cmd.Stdin = stdinFile
	}

	// 设置标准输出
	if stdout != "" {
		stdoutFile, err := os.OpenFile(stdout, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0644)
		if err != nil {
			return fmt.Errorf("open stdout file: %v", err)
		}
		cmd.Stdout = stdoutFile
	}

	// 设置标准错误
	if stderr != "" {
		stderrFile, err := os.OpenFile(stderr, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0644)
		if err != nil {
			return fmt.Errorf("open stderr file: %v", err)
		}
		cmd.Stderr = stderrFile
	}

	return nil
}
```

### 测试示例

假定我们有如下程序，这个程序涉及到输入输出：

```go
package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

func main() {
	fmt.Println("TTY Demo Program")
	fmt.Println("Type something and press Enter (type 'quit' to exit):")

	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("> ")
		if !scanner.Scan() {
			break
		}

		input := scanner.Text()
		if strings.ToLower(input) == "quit" {
			fmt.Println("Goodbye!")
			break
		}

		fmt.Printf("You typed: %s\n", input)
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "Error reading input: %v\n", err)
		os.Exit(1)
	}
}
```

下面我们看看使用 `-tty` 和 `-r` 重定向进行调试的过程。

#### TTY重定向示例

让我们通过 `tty_demo`程序来看一个实际的例子：

1. 首先，使用socat创建一个新的PTY对：

```bash
socat -d -d pty,raw,echo=0 pty,raw,echo=0
```

2. 记下输出中的两个PTY路径（例如，`/dev/pts/23`和 `/dev/pts/24`）
3. 在一个终端中，使用第一个PTY运行程序：

```bash
tinydbg debug --tty /dev/pts/23 main.go
```

4. 在另一个终端中，你可以使用以下方式与程序交互：

```bash
socat - /dev/pts/24
```

程序将：

- 打印欢迎信息
- 等待你的输入
- 回显你输入的内容
- 继续运行直到你输入'quit'

示例会话：

```
TTY Demo Program
Type something and press Enter (type 'quit' to exit):
> hello
You typed: hello
> world
You typed: world
> quit
Goodbye!
```

#### 文件重定向示例

要测试文件重定向，你可以：

1. 创建用于重定向的文件input.txt,output.txt
2. 使用重定向运行程序：

```bash
tinydbg debug -r stdin=input.txt,stdout=output.txt,stderr=output.txt main.go
```

3. 预先或者调试期间，将希望输入的数据写到文件，如：`echo "data..." >> input.txt`。
4. 通过 `tail -f output.txt` 观察程序输出。
5. 执行调试过程。

让我们看一个完整的文件重定向测试示例：

```bash
## 1. 创建输入文件
cat > input.txt << EOF
hello
world
quit
EOF

## 2. 创建空的输出文件
touch output.txt

## 3. 启动程序并重定向
tinydbg debug -r stdin=input.txt,stdout=output.txt,stderr=output.txt main.go

## 4. 在另一个终端中观察输出
tail -f output.txt
```

预期的输出文件内容：

```
TTY Demo Program
Type something and press Enter (type 'quit' to exit):
> hello
You typed: hello
> world
You typed: world
> quit
Goodbye!
```

#### 两种方式对比

使用文件进行重定向的方式，想必 `socat - /dev/pts/X` 的方式相比，可能大家更倾向于使用，因为它不需要你去执行不太熟悉的socat、tmux、screen之类的涉及到tty操作创建、读写的操作，但是明显 `socat - /dev/pts/X` 可以同时操作读写更方便。不过使用文件重定向在调试器的自动化测试过程中可能是一种更加稳定有效的方式。

### 本节总结

tinydbg的重定向支持提供了灵活的方式来控制目标程序的输入输出流，使得调试交互式和非交互式程序都变得更加容易。`--tty`选项特别适用于需要终端交互的程序，而 `-r`选项则提供了一种通过文件捕获和重放输入输出的方式。

这些特性使tinydbg更加通用，适用于更广泛的调试场景，从简单的命令行工具到复杂的交互式应用程序。
