## godbg> funcs `<regexp>`

### 实现目标

前面一节介绍了调试器后端ListFunctions的实现，这一小节介绍下在此基础上 `godbg> funcs <expr>` 的实现。

### 基础知识

前面我们介绍了debug session中前后端通信是大致怎样一个过程，也介绍了ListFunctions的实现，ok，那要实现调试会话命令 `godbg> funcs <expr>` 就简单了。无非是通过JSON-RPC的client调用远程过程ListFunctions。

### 代码实现

下面一起来这部分的关键代码逻辑。
#### 请求和响应参数类型

`ListFunctions` RPC调用接受两个参数:

```go
type ListFunctionsIn struct {
    Filter      string  // 用于过滤函数名的正则表达式模式
    FollowCalls int     // 跟踪函数调用的深度(0表示不跟踪)
}

type ListFunctionsOut struct {
    Funcs []string      // 匹配的函数名列表
}
```

#### 正则表达式过滤

函数名过滤使用正则表达式实现。当提供过滤模式时,它会被编译成正则表达式对象:

这允许用户使用以下模式搜索函数:
- `main.*` - 所有以"main"开头的函数
- `.*Handler` - 所有以"Handler"结尾的函数
- `[A-Z].*` - 所有导出的函数

#### 函数调用遍历

这里的go函数调用路径，大致如下：

```bash
// clientside 执行调试命令
tinydbg> funcs <expr>
    \--> funcsCmd.cmdFn()
            \--> funcs(s *Session, ctx callContext, args string)
                    \--> t.printSortedStrings(t.client.ListFunctions(...))
                            \--> rpc2.(*RPCClient).ListFunctions(...)
```

一起看下clientside如何实现的：

```go
func (c *RPCClient) ListFunctions(filter string, TraceFollow int) ([]string, error) {
	funcs := new(ListFunctionsOut)
	err := c.call("ListFunctions", ListFunctionsIn{filter, TraceFollow}, funcs)
	return funcs.Funcs, err
}
```

下面再看下serverside是如何实现的：

t.client.ListFunctions(...)` 对应着服务器端的ListFunctions处理

```go
// ListFunctions lists all functions in the process matching filter.
func (s *RPCServer) ListFunctions(arg ListFunctionsIn, out *ListFunctionsOut) error {
	fns, err := s.debugger.Functions(arg.Filter, arg.FollowCalls)
	if err != nil {
		return err
	}
	out.Funcs = fns
	return nil
}
```

服务器端调用这个小哥(*RPCServer).ListFunctions(...)，然后调用到debuggger.Functions。下面我们看看 `s.debugger.Functions(filter, followCalls)`：

```go
// Functions returns a list of functions in the target process.
func (d *Debugger) Functions(filter string, followCalls int) ([]string, error) {
	d.targetMutex.Lock()
	defer d.targetMutex.Unlock()

	regex, err := regexp.Compile(filter)
	if err != nil {
		return nil, fmt.Errorf("invalid filter argument: %s", err.Error())
	}

	funcs := []string{}
	t := proc.ValidTargets{Group: d.target}
	for t.Next() {
		for _, f := range t.BinInfo().Functions {
			if regex.MatchString(f.Name) {
				if followCalls > 0 {
					newfuncs, err := traverse(t, &f, 1, followCalls)
					if err != nil {
						return nil, fmt.Errorf("traverse failed with error %w", err)
					}
					funcs = append(funcs, newfuncs...)
				} else {
					funcs = append(funcs, f.Name)
				}
			}
		}
	}
	// uniq = sort + compact
	sort.Strings(funcs)
	funcs = slices.Compact(funcs)
	return funcs, nil
}
```

上述代码是展示了如何为智能体增加多方智能，并不是不可能的。

### 本文总结

本节介绍了调试器命令 `godbg> funcs <expr>` 的实现。该命令通过JSON-RPC调用远程的ListFunctions过程，支持正则表达式过滤函数名，并可设置函数调用跟踪深度。实现展示了调试器前后端的关键代码处理逻辑。
