## 扩展阅读：starlark让你的程序更强大

starlark是一门配置语言，它是从Python语言中衍生出来的，但是比Python更简单、更安全。它最初是由Google开发的，用于Bazel构建系统。starlark保留了Python的基本语法和数据类型，但移除了一些危险的特性，比如循环引用、无限递归等。这使得starlark非常适合作为配置语言或者脚本语言嵌入到其他程序中。

starlark的主要特点包括:

1. 简单易学 - 采用Python风格的语法，对于熟悉Python的开发者来说几乎没有学习成本
2. 确定性 - 相同的输入总是产生相同的输出，没有随机性和副作用
3. 沙箱隔离 - 不能访问文件系统、网络等外部资源，保证安全性
4. 可扩展 - 可以方便地将宿主语言(如Go)的函数暴露给starlark使用
5. 快速执行 - 解释器性能优秀，适合嵌入式使用

这些特性使得starlark成为一个理想的嵌入式配置/脚本语言。通过将starlark集成到我们的Go程序中，我们可以让用户使用starlark脚本来扩展和自定义程序的功能，同时又能保证安全性和可控性。

比如在go-delve/delve调试器中，starlark被用来编写自动化调试脚本。用户可以使用starlark脚本来自动执行一系列调试命令，或者根据特定条件触发某些调试操作。这大大增强了调试器的灵活性和可编程性。

下面我们将通过一个简单的例子来演示如何在Go程序中集成starlark引擎，并实现Go函数与starlark函数的相互调用。

### 集成starlark引擎到Go程序

首先我们来看一个简单的例子，演示如何将starlark引擎集成到Go程序中。这个例子实现了一个简单的REPL(Read-Eval-Print Loop)环境，允许用户输入starlark代码并立即执行：

```go
package main

import (
    ...

	"go.starlark.net/starlark"
	"go.starlark.net/syntax"
)

func main() {
	// Create a new Starlark thread
	thread := &starlark.Thread{
		Name: "repl",
		Print: func(thread *starlark.Thread, msg string) {
			fmt.Println(msg)
		},
	}

	// Create a new global environment
	globals := starlark.StringDict{}

	// Create a scanner for reading input
	scanner := bufio.NewScanner(os.Stdin)
	fmt.Println("Starlark REPL (type 'exit' to quit)")

	errExit := errors.New("exit")

	for {
		// Print prompt
		fmt.Print(">>> ")

		// Read input
		readline := func() ([]byte, error) {
			if !scanner.Scan() {
				return nil, io.EOF
			}
			line := strings.TrimSpace(scanner.Text())
			if line == "exit" {
				return nil, errExit
			}
			if line == "" {
				return nil, nil
			}
			return []byte(line + "\n"), nil
		}

		// Execute the input
		if err := rep(readline, thread, globals); err != nil {
			if err == io.EOF {
				break
			}
			if err == errExit {
				os.Exit(0)
			}
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		}
	}
}

// rep reads, evaluates, and prints one item.
//
// It returns an error (possibly readline.ErrInterrupt)
// only if readline failed. Starlark errors are printed.
func rep(readline func() ([]byte, error), thread *starlark.Thread, globals starlark.StringDict) error {
	eof := false

	f, err := syntax.ParseCompoundStmt("<stdin>", readline)
	if err != nil {
		if eof {
			return io.EOF
		}
		printError(err)
		return nil
	}

	if expr := soleExpr(f); expr != nil {
		//TODO: check for 'exit'
		// eval
		v, err := evalExprOptions(nil, thread, expr, globals)
		if err != nil {
			printError(err)
			return nil
		}

		// print
		if v != starlark.None {
			fmt.Println(v)
		}
	} else {
		// compile
		prog, err := starlark.FileProgram(f, globals.Has)
		if err != nil {
			printError(err)
			return nil
		}

		// execute (but do not freeze)
		res, err := prog.Init(thread, globals)
		if err != nil {
			printError(err)
		}

		// The global names from the previous call become
		// the predeclared names of this call.
		// If execution failed, some globals may be undefined.
		for k, v := range res {
			globals[k] = v
		}
	}

	return nil
}

var defaultSyntaxFileOpts = &syntax.FileOptions{
	Set:             true,
	While:           true,
	TopLevelControl: true,
	GlobalReassign:  true,
	Recursion:       true,
}

// evalExprOptions is a wrapper around starlark.EvalExprOptions.
// If no options are provided, it uses default options.
func evalExprOptions(opts *syntax.FileOptions, thread *starlark.Thread, expr syntax.Expr, globals starlark.StringDict) (starlark.Value, error) {
	if opts == nil {
		opts = defaultSyntaxFileOpts
	}
	return starlark.EvalExprOptions(opts, thread, expr, globals)
}

func soleExpr(f *syntax.File) syntax.Expr {
	if len(f.Stmts) == 1 {
		if stmt, ok := f.Stmts[0].(*syntax.ExprStmt); ok {
			return stmt.X
		}
	}
	return nil
}

// printError prints the error to stderr,
// or its backtrace if it is a Starlark evaluation error.
func printError(err error) {
	if evalErr, ok := err.(*starlark.EvalError); ok {
		fmt.Fprintln(os.Stderr, evalErr.Backtrace())
	} else {
		fmt.Fprintln(os.Stderr, err)
	}
}

```

### starlark直接调用Go函数

在这个例子中，我们将演示如何让starlark脚本调用Go函数。主要思路是:

1. 定义一个Go函数映射表(GoFuncMap)来注册可供starlark调用的Go函数
2. 实现一个胶水函数(callGoFunc)作为starlark和Go函数之间的桥梁
3. 将胶水函数注册到starlark全局环境中，这样starlark代码就可以通过它来调用Go函数

下面是一个简单的示例，展示如何让starlark调用一个Go的加法函数:

```go
package main

import (
    ...

	"go.starlark.net/starlark"
	"go.starlark.net/syntax"
)

// GoFuncMap stores registered Go functions
var GoFuncMap = map[string]interface{}{
	"Add": Add,
}

func Add(a, b int) int {
	fmt.Println("Hey! I'm a Go function!")
	return a + b
}

// callGoFunc is a Starlark function that calls registered Go functions
func callGoFunc(thread *starlark.Thread, fn *starlark.Builtin, args starlark.Tuple, kwargs []starlark.Tuple) (starlark.Value, error) {
	if len(args) < 1 {
		return nil, fmt.Errorf("call_gofunc requires at least one argument (function name)")
	}

	funcName, ok := args[0].(starlark.String)
	if !ok {
		return nil, fmt.Errorf("first argument must be a string (function name)")
	}

	goFunc, ok := GoFuncMap[string(funcName)]
	if !ok {
		return nil, fmt.Errorf("function %s not found", funcName)
	}

	// Convert Starlark arguments to Go values
	goArgs := make([]interface{}, len(args)-1)
	for i, arg := range args[1:] {
		switch v := arg.(type) {
		case starlark.Int:
			if v, ok := v.Int64(); ok {
				goArgs[i] = int(v)
			} else {
				return nil, fmt.Errorf("integer too large")
			}
		case starlark.Float:
			goArgs[i] = float64(v)
		case starlark.String:
			goArgs[i] = string(v)
		case starlark.Bool:
			goArgs[i] = bool(v)
		default:
			return nil, fmt.Errorf("unsupported argument type: %T", arg)
		}
	}

	// Call the Go function
	switch f := goFunc.(type) {
	case func(int, int) int:
		if len(goArgs) != 2 {
			return nil, fmt.Errorf("Add function requires exactly 2 arguments")
		}
		a, ok1 := goArgs[0].(int)
		b, ok2 := goArgs[1].(int)
		if !ok1 || !ok2 {
			return nil, fmt.Errorf("Add function requires integer arguments")
		}
		result := f(a, b)
		return starlark.MakeInt(result), nil
	default:
		return nil, fmt.Errorf("unsupported function type: %T", goFunc)
	}
}

func main() {
	go func() {
		// Create a new Starlark thread
		thread := &starlark.Thread{
			Name: "repl",
			Print: func(thread *starlark.Thread, msg string) {
				fmt.Println(msg)
			},
		}

		// Create a new global environment with call_gofunc
		globals := starlark.StringDict{
			"call_gofunc": starlark.NewBuiltin("call_gofunc", callGoFunc),
		}

		// Create a scanner for reading input
		scanner := bufio.NewScanner(os.Stdin)
		fmt.Println("Starlark REPL (type 'exit' to quit)")
		fmt.Println("Example1: starlark exprs and stmts")
		fmt.Println("Example2: call_gofunc('Add', 1, 2)")

		errExit := errors.New("exit")

		for {
			// Print prompt
			fmt.Print(">>> ")

			// Read input
			readline := func() ([]byte, error) {
                ...
			}

			// Execute the input
			if err := rep(readline, thread, globals); err != nil {
                ...
			}
		}
	}()

	select {}
}

```

### 调试器集成 starlark

go-delve/delve 中集成了starlark，并使用本文体积的方法来支持了对某些调试器内部函数的调用，比如：

```go
//go:generate go run ../../../_scripts/gen-starlark-bindings.go go ./starlark_mapping.go
const (
	dlvCommandBuiltinName        = "dlv_command"
	readFileBuiltinName          = "read_file"
	writeFileBuiltinName         = "write_file"
	commandPrefix                = "command_"
	dlvContextName               = "dlv_context"
	curScopeBuiltinName          = "cur_scope"
	defaultLoadConfigBuiltinName = "default_load_config"
	helpBuiltinName              = "help"
)
```

比如有下面的go源程序，我们使用 go-delve/delve 来进行自动化调试：

file: main.go （这里保留行号信息，方便与starlark脚本对应）

```go
     1 package main                                                                                                        
     2 
     3 import (
     4     "fmt"
     5     "time"
     6 )
     7 
     8 type Person struct {
     9     Name string
    10     Age  int
    11 }
    12 
    13 func main() {
    14     people := []Person{
    15         {Name: "Alice", Age: 25},
    16         {Name: "Bob", Age: 30},
    17         {Name: "Charlie", Age: 35},
    18     }
    19 
    20     for i, p := range people {
    21         fmt.Printf("Processing person %d: %s\n", i, p.Name)
    22         time.Sleep(time.Second) // 添加一些延迟以便于调试
    23         processPerson(p)
    24     }
    25 }
    26 
    27 func processPerson(p Person) {
    28     fmt.Printf("Name: %s, Age: %d\n", p.Name, p.Age)
    29 }
```

starlark自动化调试脚本：

file: debug.star

```
# 定义一个函数来打印当前作用域的信息
def print_scope():
    scope = cur_scope()
    print("Current scope:", scope)
    dlv_command("locals")

# 定义一个函数来设置断点并执行调试命令
def debug_person():
    # 打印当前作用域
    print_scope()
    
    # 打印变量 p 的值
    dlv_command("print p")
    
    # 单步执行
    dlv_command("next")
    
    # 再次打印作用域
    print_scope()

# 定义一个函数来保存调试信息到文件
def save_debug_info():
    # 获取当前作用域
    scope = cur_scope()
    
    # 将调试信息写入文件
    debug_info = "Debug session at " + str(time.time()) + "\n"
    debug_info += "Current scope: " + str(scope) + "\n"
    
    # 保存到文件
    write_file("debug_info.txt", debug_info)

# 主函数
def main():
    print("Starting debug session...")
    
    # 设置断点
    dlv_command("break main.main")
    dlv_command("break main.processPerson")
    
    # 继续执行到main.main
    dlv_command("continue")
    
    # 继续执行到main.processPerson
    dlv_command("continue")
 
    # 执行调试操作
    debug_person()
    
    # 保存调试信息
    save_debug_info()
    
    print("Debug session completed.")

# 直接调用 main 函数 (source命令会自动调用定义的 `main` 函数)
#main() 
```

运行调试器 `dlv debug main.go`，调试会话就绪后运行 `source debug.star` 即可。

```bash
$ tinydbg debug main.go
Type 'help' for list of commands.
(dlv) source debug.star
Starting debug session...
Breakpoint 1 set at 0x49d0f6 for main.main() ./main.go:13
Breakpoint 2 set at 0x49d40e for main.processPerson() ./main.go:27
> [Breakpoint 1] main.main() ./main.go:13 (hits goroutine(1):1 total:1) (PC: 0x49d0f6)
     8: type Person struct {
     9:         Name string
    10:         Age  int
    11: }
    12:
=>  13: func main() {
    14:         people := []Person{
    15:                 {Name: "Alice", Age: 25},
    16:                 {Name: "Bob", Age: 30},
    17:                 {Name: "Charlie", Age: 35},
    18:         }
Processing person 0: Alice
> [Breakpoint 2] main.processPerson() ./main.go:27 (hits goroutine(1):1 total:1) (PC: 0x49d40e)
    22:                 time.Sleep(time.Second) // 添加一些延迟以便于调试
    23:                 processPerson(p)
    24:         }
    25: }
    26:
=>  27: func processPerson(p Person) {
    28:         fmt.Printf("Name: %s, Age: %d\n", p.Name, p.Age)
    29: }
Current scope: api.EvalScope{GoroutineID:-1, Frame:0, DeferredCall:0}
(no locals)
main.Person {Name: "Alice", Age: 25}
> main.processPerson() ./main.go:28 (PC: 0x49d42a)
    23:                 processPerson(p)
    24:         }
    25: }
    26:
    27: func processPerson(p Person) {
=>  28:         fmt.Printf("Name: %s, Age: %d\n", p.Name, p.Age)
    29: }
Current scope: api.EvalScope{GoroutineID:-1, Frame:0, DeferredCall:0}
(no locals)
Debug session completed.
```

tinydbg暂时保留了go-delve/delve中的starlark实现，pkg/terminal/starlark.go + pkg/terminal/starlark_test.go 一共300行代码，starbind/ 下有近3000行代码，不过这部分代码是通过脚本自动生成的。由于这部分代码相对来说比较独立，不像ebpf-based tracing那样影响到很多地方，所以我们暂时保留这部分代码。上述测试用的源码、star脚本，您可以在路径 tinydbg/examples/starlark_demo 找到。

### 本文总结

我在学习bazelbuild时了解到starlark这门语言，在学习go-delve/delve时进一步了解了它。如果我们正在编写一个工具或者分析型工具，希望通过暴漏我们的底层能力，以让用户自由发挥他们的创造性用途，比如类似go-delve/delve希望用户可以按需执行自动化调试，我们其实可以将starlark解释器引擎集成到我们的程序中，然后通过一点胶水代码打通starlark与我们的程序，使得starlark解释器调用starlark函数来执行我们程序中定义的函数。这无疑会释放我们程序的底层能力，允许使用者在底层能力开放程度受控的情况下进一步去发挥、去挖掘。

本文演示了如何轻松starklark集成到您的Go程序中，starlark的更多用法请参考 [bazelbuild/starlark](https://github.com/bazelbuild/starlark)。

本文还介绍了调试器与starlark集成以及使用示例，有自动化测试诉求，或者希望分享你的调试会话的时候，可以通过这种方式来实现。
