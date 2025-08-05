## ListFunctions

### 实现目标

`ListFunctions`是tinydbg中的一个强大功能,它允许用户列出目标进程中定义的函数列表，也允许按照正则表达式的方式查询满足条件的函数列表。

`funcs <expr>` 对应的核心逻辑即 ListFunctions，另外调试器命令 `tinydbg trace` 也依赖ListFunctions查找匹配的函数，然后在这些函数位置添加断点。

### 基础知识

最主要的原因是获取函数的定义，这部分数据从哪里获取呢？从DWARF数据可以获取到，这个我们很早之前就介绍过了。这个并不困难，甚至支持按正则表达式检索也并不困难。

但是如果要递归地展开某个函数的函数调用图，这个就有点挑战了。联想下之前我们介绍过的 go-ftrace 的函数调用图，你就知道我们这个ListFunctions实现的挑战点在哪里了。

分析函数的调用图，大致有两种办法：
1、分析源码，构建AST，对FuncDecl.Body进行分析，找到所有函数调用类型的Expr，然后进行分析记录 …… 但是依赖源码进行trace这个比较不方便，最好依赖executable就可以搞定；
2、反汇编机器指令，找到所有的CALL <targetFuncName> 指令调用，找到对应的targetFuncName …… 这个确实构建出函数调用图了，但是如果要获取出入参信息，不好确定；

在2）基础上，为了更方便获取出入参，就要在程序启动时读取二进制文件的DWARF调试信息，将所有的函数定义记录下来，比如map[pc]Function，而Function就包含了name、pc、lowpc、highpc、length、dwarfregisters情况，我们已经知道了这个函数名对应的pc，便可以添加断点，当执行到断点处时，便可以执行pc处函数定义信息，比如知道如何获取函数的参数，就可以对应的规则将参数取出来。这样就实现了 `跟踪函数执行->打印函数名->打印函数参数列表+打印函数返回值列表` 的操作。

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

```go
regex, err := regexp.Compile(filter)
if err != nil {
    return nil, fmt.Errorf("invalid filter argument: %s", err.Error())
}
```

这允许用户使用以下模式搜索函数:
- `main.*` - 所有以"main"开头的函数
- `.*Handler` - 所有以"Handler"结尾的函数
- `[A-Z].*` - 所有导出的函数

#### 二进制信息读取

函数信息从目标二进制文件的调试信息(DWARF)中读取。这些信息在调试器初始化时加载并存储在`BinaryInfo`结构中。主要组件包括:

- `Functions` 切片,包含二进制文件中的所有函数
- `Sources` 切片,包含所有源文件
- DWARF调试信息,用于详细的函数元数据

#### 函数信息提取

函数信息在调试器初始化期间从DWARF调试信息中提取。对于每个函数,存储以下信息:

```go
type Function struct {
    Name       string
    Entry, End uint64    // 函数地址范围
    offset     dwarf.Offset
    cu         *compileUnit
    trampoline bool
    InlinedCalls []InlinedCall
}
```

#### 获取函数列表


#### 函数调用遍历

当`FollowCalls`大于0时,调试器会执行函数调用的广度优先遍历。这是在`traverse`函数中实现的:

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

func traverse(t proc.ValidTargets, f *proc.Function, depth int, followCalls int) ([]string, error) {
    type TraceFunc struct {
        Func    *proc.Function
        Depth   int
        visited bool
    }
    
    // 使用map跟踪已访问的函数,避免循环
    TraceMap := make(map[string]TraceFuncptr)
    queue := make([]TraceFuncptr, 0, 40)
    funcs := []string{}
    
    // 从根函数开始
    rootnode := &TraceFunc{Func: f, Depth: depth, visited: false}
    TraceMap[f.Name] = rootnode
    queue = append(queue, rootnode)
    
    // BFS遍历
    for len(queue) > 0 {
        parent := queue[0]
        queue = queue[1:]
        
        // 如果超过调用深度则跳过
        if parent.Depth > followCalls {
            continue
        }
        
        // 如果已访问则跳过
        if parent.visited {
            continue
        }
        
        funcs = append(funcs, parent.Func.Name)
        parent.visited = true
        
        // 反汇编函数以查找调用
        text, err := proc.Disassemble(t.Memory(), nil, t.Breakpoints(), t.BinInfo(), f.Entry, f.End)
        if err != nil {
            return nil, err
        }
        
        // 处理每条指令
        for _, instr := range text {
            if instr.IsCall() && instr.DestLoc != nil && instr.DestLoc.Fn != nil {
                cf := instr.DestLoc.Fn
                // 跳过大多数runtime函数,除了特定的几个
                if (strings.HasPrefix(cf.Name, "runtime.") || strings.HasPrefix(cf.Name, "runtime/internal")) &&
                    cf.Name != "runtime.deferreturn" && cf.Name != "runtime.gorecover" && cf.Name != "runtime.gopanic" {
                    continue
                }
                
                // 如果未访问过,将新函数添加到队列
                if TraceMap[cf.Name] == nil {
                    childnode := &TraceFunc{Func: cf, Depth: parent.Depth + 1, visited: false}
                    TraceMap[cf.Name] = childnode
                    queue = append(queue, childnode)
                }
            }
        }
    }
    return funcs, nil
}
```

遍历算法:
1. 使用map跟踪已访问的函数，避免重复访问
2. 使用队列进行广度优先遍历
3. 对于每个函数:
   - 反汇编其代码
   - 查找所有CALL指令
   - 提取被调用函数的信息
   - 如果未访问过,将新函数添加到队列
4. 跳过大多数runtime函数以减少干扰
5. 遵守最大调用深度参数

ps: 这里为什么不使用AST呢？查找FuncDecl.Body中的所有函数调用，不也是一种办法，确实也是一种办法。但是通过AST的方式应该效率会很慢，而且由于存在内联，AST中的结构不一定能反映最终编译优化后的指令，比如内联优化。使用AST当我们尝试对某个函数位置进行trace并获取这个函数参数时，可能会出现错误，因为它被内联了，通过BP寄存器+参数偏移量的方式获取的不是真实参数。这里使用CALL指令可以避免上述考虑不周的错误，而且处理效率会更高效。

#### 结果处理

最后一步处理结果:

```go
// 排序并删除重复项
sort.Strings(funcs)
funcs = slices.Compact(funcs)
```

这确保返回的函数列表:
- 按字母顺序排序
- 没有重复项
- 只包含匹配过滤模式的函数

#### 使用场景

`ListFunctions`功能主要用于两个调试器命令:

1. `funcs <regexp>` - 列出所有匹配模式的函数
2. `trace <regexp>` - 在匹配的函数及其被调用函数上设置跟踪点

例如:
```
tinydbg> funcs main.*
main.main
main.init
main.handleRequest

tinydbg> trace main.*
```

trace命令使用`ListFunctions`并将`FollowCalls`设置为大于0,以查找可能被匹配函数调用的所有函数,从而实现全面的函数调用跟踪。 

### 本文总结

本文介绍了ListFunctions的设计实现，它通过正则表达式来对函数名进行过滤，并通过广度优先搜索+反汇编代码并分析CALL指令来查找函数的调用关系。相比使用AST分析，这种方式可以更好地应对内联优化带来的影响，这种方式相比分析源码也更加便利、高效。在tinydbg中ListFunctions主要服务于funcs和trace两个调试命令：1）funcs用于列出匹配模式的函数，2）trace用于在这些函数上设置跟踪点，并获取其参数。本文只讲述了如何ListFunctions，在 `tinydbg trace` 小节我们将进一步介绍如何获取跟踪到的函数的入参列表、返回值列表。
