## locspec解析与地址转换

符号级调试器和指令级调试器相比，最明显的不同之一就是我们可以使用字符串来表示位置信息，如添加断点时、反汇编时可以使用“文件名:行号"、“函数名”来表示目标地址。为了调试时更加便利，我们需要设计一些大家常用、容易记住、容易输入的位置描述方式，这里我们就叫做locationspec，简称locspec了。

### 实现目标：支持locspec解析及地址转换

本节我们就结合多种调试器中的断点操作、反汇编操作等等，常见的locspec操作如下：

- `<filename>` 完整的源文件路径，或者是源文件路径的某一段后缀；
- `<function>` 任何有效的Go函数名、方法名，使用后缀也可以，如：
  - `<package>.<receiver type>.<name>`
  - `<package>.(*<receiver type>).<name>`
  - `<receiver type>.<name>`
  - `<package>.<name>`
  - `(*<receiver type>).<name>`
  - `<name>`
    ps: 使用其后缀也可以，但是如果有冲突要提示存在冲突函数名。
- `/<regex>/` 名字与正则表达式匹配的所有函数、方法；
- `+<offset>` 当前行后面+offset行；
- `-<offset>` 当前行前面-offset行；
- `<line>` 当前源文件中的行号，也可与 `<filename>`结合使用；
- `*<address>` 内存地址address处数据作为地址；

最后总结一下，我们要支持locspec它的文法应该满足：`locStr ::= <filename>:<line> | <function>[:<line>] | /<regex>/ | (+|-)<offset> | <line> | *<address>` .

我们本节不仅要根据locspec实现对输入地址字符串的解析，还要能够将其转换为内存中的地址，OK，接下来我们一起来实现它。

### 代码实现

#### locspec

结合前面确定的locspec `locStr ::= <filename>:<line> | <function>[:<line>] | /<regex>/ | (+|-)<offset> | <line> | *<address>`，我们明确了要支持的几种位置描述类型。

结合调试器tinydbg加断点操作，来说明下使用时是什么效果：

- 文件名:行号，比如 `break main.go:20`，在指定源文件main.go的20行
- 函数名，比如 `break main.main`，在指定package的指定函数 main.main
- regexp，比如 `break main.(*Student).*`，在所有匹配正则的函数名、方法名处添加断点
- +offset，比如 `break +2`，在当前断点行-2行位置
- -offset，比如 `break -2`，在当前断点所在行-2行位置
- line，比如 `break 20`，在当前源文件20行
- `*address`，比如 `*0x12345678`，指定内存地址中的地址处

see: tinydbg/pkg/locspec/locations.go，这定义了每个locspec类型必须满足的接口定义LocationSpec，以及不同locspec类型的定义以及解析函数。

#### 位置类型

将上述位置描述方式，转换为Go中的类型描述，有些file:line方式是通过类型组合的方式来实现的。

see: tinydbg/pkg/locspec/locations.go

```go
// 函数位置
// 比如 main.main, PackageName=main, BaseName=main
type FuncLocationSpec struct {
	PackageName           string
	AbsolutePackage       bool
	ReceiverName          string
	PackageOrReceiverName string
	BaseName              string
}

// 文件:行号 or funcName:行号
// 比如 main.go:20，Base=main.go，LineOffset=20
type NormalLocationSpec struct {
	Base       string
	FuncBase   *FuncLocationSpec
	LineOffset int
}

// 指定行号位置（相对于当前源文件）
// 比如20，Line=20
type LineLocationSpec struct { Line int }

// 源码行基础上加减行数（相对于当前源码行）
// 比如+20，Offset=+20
type OffsetLocationSpec struct { Offset int }

// 解引用内存位置得到地址
// 比如0x123456，AddrExpr=0x123456
type AddrLocationSpec struct { AddrExpr string }

// 名字与正则表达式匹配的函数、方法
// 比如/[a-z].*/，FuncRegex=/[a-z].*/
type RegexLocationSpec struct { FuncRegex string }
```

#### 地址解析

开发人员调试时，会在调试器前端输入位置字符串，比如添加断点时输入 `break main.main` , `break main.go:20` , `break main.main:20` 等不同位置写法。需要调试器后端进行代为处理的，调试器前端会在JSON-RPC请求参数中设置必要的位置信息，就是输入的位置描述字符串。到了调试器后端这里，接收到调试请求参数后，会发现原来是个加断点请求，并且参数里的位置字符串指明了位置，就是下面的locStr了。

接下来就是，调试器先解析这个locStr，我们一起粗略看下解析过程吧，对照着前面的locspec，一看就能理解Parse的含义，Parse的结果是一个LocationSpec实现，可能是FuncLocationSpec, LineLocationSpec or others。

see: tinydbg/pkg/locspec/locations.go

```go
// Parse will turn locStr into a parsed LocationSpec.
func Parse(locStr string) (LocationSpec, error) {
	rest := locStr
    ...

	switch rest[0] {
	case '+', '-': // 解析 `+/-<offset>`
		offset, _ := strconv.Atoi(rest)
		return &OffsetLocationSpec{offset}, nil
	case '/':
		if rest[len(rest)-1] == '/' { // 解析 `/regexp/` 正则表达式位置描述
			rx, rest := readRegex(rest[1:])
			if len(rest) == 0 {
				return nil, malformed("non-terminated regular expression")
			}
			if len(rest) > 1 {
				return nil, malformed("no line offset can be specified for regular expression locations")
			} return &RegexLocationSpec{rx}, nil
		} else {                     // 解析 `文件行号、函数行号` 位置描述
			return parseLocationSpecDefault(locStr, rest)
		}
	case '*': // 解析 *<address> 位置描述
		return &AddrLocationSpec{AddrExpr: rest[1:]}, nil
	default: // 解析 `文件行号、函数行号` 位置描述
		return parseLocationSpecDefault(locStr, rest)
	}
}
```

#### 地址转换

locspec的目的是为了将位置描述字符串转换为内存中的地址，所以针对locspec定义了这样一个接口LocationSpec。

locspec主要是在client端调试会话中进行输入，然后RPC传给服务器侧，服务器侧将其解析为具体的LocationSpec实现，之后的最常用操作就是使用 `LocationSpecConcreate.Find(t, args, scope, locStr, ...)` 来将locStr转换为内存地址。

```go
type LocationSpec interface {
	// Find returns all locations that match the location spec.
	Find(t *proc.Target, processArgs []string, scope *proc.EvalScope,
		locStr string,
		includeNonExecutableLines bool,
		substitutePathRules [][2]string) ([]api.Location, string, error)
}
```

调试器后端和目标进程进行交互，可以读取它的二进制、DWARF、进程等信息，可以将上述输入的“位置描述”字符串精确转换为内存地址。

每一种LocationSpec实现结合实际情况实现这样的查询操作Find，如何实现Find操作的呢？每个LocationSpec实现有不同的实现逻辑，比如：

- `*<address>` 就需要涉及到 `ptrace(PTRACE_PEEKDATA,...)` 读取内存中数据，
- 再比如NormalLocationSpec通常是 `文件名:行号`，这种就需要利用DWARF调试信息中的行号表信息，转换出这行对应的指令地址，
- 再比如如果是 `FuncLocationSpec` 就需要根据DWARF调试信息中的FDE信息，再找到该函数所包含指令的起始地址
- ...

所以你看，不同的locspec LocationSpec实现，也各自有不同的转换成内存地址的实现方式，这部分还是很重要的，涉及到了很多核心DWARF数据结构的使用。

我们一起来看几个示例，你就明白就了。

##### FuncLocationSpec

##### NormalLocationSpec

##### LineLocationSpec

LineLocationSpec描述的是当前源文件的指定行的位置。因此它依赖scope信息。


```go
// Find will return the location at the given line in the current file.
func (loc *LineLocationSpec) Find(t *proc.Target, _ []string, scope *proc.EvalScope, _ string, includeNonExecutableLines bool, _ [][2]string) ([]api.Location, string, error) {
	if scope == nil {
		return nil, "", errors.New("could not determine current location (scope is nil)")
	}
	file, _, fn := scope.BinInfo.PCToLine(scope.PC)
	if fn == nil {
		return nil, "", errors.New("could not determine current location")
	}
	subst := fmt.Sprintf("%s:%d", file, loc.Line)
	addrs, err := proc.FindFileLocation(t, file, loc.Line)
	if includeNonExecutableLines {
		if _, isCouldNotFindLine := err.(*proc.ErrCouldNotFindLine); isCouldNotFindLine {
			return []api.Location{{File: file, Line: loc.Line}}, subst, nil
		}
	}
	return []api.Location{addressesToLocation(addrs)}, subst, err
}
```

##### OffsetLocationSpec

##### AddrLocationSpec

AddrLocationSpec其实支持了如下几种方式：

- `<address>`
- `*<address>`
- `<funcName>`

```go
// Find returns the locations specified via the address location spec.
func (loc *AddrLocationSpec) Find(t *proc.Target, _ []string, scope *proc.EvalScope, locStr string, includeNonExecutableLines bool, _ [][2]string) ([]api.Location, string, error) {
    // locStr 本身包含的是一个地址，如locStr=0x12345678
	if scope == nil {
		addr, _ := strconv.ParseInt(loc.AddrExpr, 0, 64)
		return []api.Location{{PC: uint64(addr)}}, "", nil
	}

    // locStr可能是一个表达式，如 *0x12345678 or 0x12345678+0x20
	v, _ := scope.EvalExpression(loc.AddrExpr, proc.LoadConfig{FollowPointers: true})
	switch v.Kind {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		addr, _ := constant.Uint64Val(v.Value)
		return []api.Location{{PC: addr}}, "", nil
	case reflect.Func:
		fn := scope.BinInfo.PCToFunc(v.Base)
		pc, _ := proc.FirstPCAfterPrologue(t, fn, false)
		return []api.Location{{PC: pc}}, v.Name, nil
	default:
		return nil, "", fmt.Errorf("wrong expression kind: %v", v.Kind)
	}
}
```

这里分两种情况：本身就是一个地址值，直接字符串转Int64后返回；另一种是一个表达式，`scope.EvalExpression(...)`，表达式结果可以是一个计算出的地址，也可能是一个函数，如果是后者，那么就需要取函数prologue后的第一条指令地址。

ps: scope.EvalExpression的工作原理，我们在前一小节 [19-表达式计算](./19-how_evalexpr_works.md) 中进行了详细介绍。如果你忘记了它是如何工作的，可以翻回去看看。

##### RegexLocationSpec

### 执行测试

略

### 本文小结
