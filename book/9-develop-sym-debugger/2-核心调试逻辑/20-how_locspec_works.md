## locspec解析与地址转换

符号级调试器和指令级调试器相比，最明显的不同之一就是我们可以使用字符串来表示位置信息，如添加断点时、反汇编时可以使用"文件名:行号"、"函数名"来表示目标地址。为了调试时更加便利，我们需要设计一些大家常用、容易记住、容易输入的位置描述方式，这里我们就叫做locationspec，简称locspec了。

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

结合前面locspec文法的定义，这了看下每种位置类型的定义，将输入位置字符串解析为不同LocationSpec实现的逻辑我们就省略了。我们将重点放在不同LocationSpec如何将human-redable位置描述转换为内存地址的过程。

ps：这个转换过程当然是在调试器后端实现的，因为转换的过程涉及到“符号层(Symbolic Layer)”、“目标层 (Target Layer)”的操作。

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

locspec主要是在client端调试会话中进行输入，然后RPC传给服务器侧，服务器侧将其解析为具体的LocationSpec实现，之后的最常用操作就是使用 `XXXLocationSpec.Find(t, args, scope, locStr, ...)` 来将locStr转换为内存地址。

```go
type LocationSpec interface {
	// Find returns all locations that match the location spec.
	Find(t *proc.Target, processArgs []string, scope *proc.EvalScope,
		locStr string,
		includeNonExecutableLines bool,
		substitutePathRules [][2]string) ([]api.Location, string, error)
}
```

调试器后端和目标进程进行交互，可以读取它的二进制、DWARF、进程等信息，可以将上述输入的"位置描述"字符串精确转换为内存地址。

每一种LocationSpec实现结合实际情况实现这样的查询操作Find，如何实现Find操作的呢？每个LocationSpec实现有不同的实现逻辑，比如：

- `*<address>` 就需要涉及到 `ptrace(PTRACE_PEEKDATA,...)` 读取内存中数据，
- 再比如NormalLocationSpec通常是 `文件名:行号`，这种就需要利用DWARF调试信息中的行号表信息，转换出这行对应的指令地址，
- 再比如如果是 `FuncLocationSpec` 就需要根据DWARF调试信息中的FDE信息，再找到该函数所包含指令的起始地址
- ...

所以你看，不同的locspec LocationSpec实现，也各自有不同的转换成内存地址的实现方式，这部分还是很重要的，涉及到了很多核心DWARF数据结构的使用。

我们一起来看几个示例，你就明白就了。

##### NormalLocationSpec

NormalLocationSpec表示的是 `file:line` 或者 `func:line` 这种类型的位置描述，注意它包含了一个FuncLocationSpec用以支持 `func:line` 这种情况，FuncLocationSpec并没有实现 LocationSpec interface。

OK，我们来看下这个函数是如何实现的。

```go
// NormalLocationSpec represents a basic location spec.
// This can be a file:line or func:line.
type NormalLocationSpec struct {
	Base       string
	FuncBase   *FuncLocationSpec
	LineOffset int
}

// FuncLocationSpec represents a function in the target program.
type FuncLocationSpec struct {
	PackageName           string
	AbsolutePackage       bool
	ReceiverName          string
	PackageOrReceiverName string
	BaseName              string
}

// Find will return a list of locations that match the given location spec.
// This matches each other location spec that does not already have its own spec
// implemented (such as regex, or addr).
func (loc *NormalLocationSpec) Find(t *proc.Target, processArgs []string, scope *proc.EvalScope, locStr string, includeNonExecutableLines bool, substitutePathRules [][2]string) ([]api.Location, string, error) {
	// 如果是file:line描述方式，所有后缀匹配的文件都算是候选文件，我们需要先找到候选的源文件列表
	// - 但是这里的候选文件可能比较多，所以必须加个数量限制，如果没有开发者想要的候选文件，那就得指定的路径更明确点
	// - 再一个是源文件路径映射的问题，这里需要根据路径映射规则进行映射，以免匹配不到
	limit := maxFindLocationCandidates
	var candidateFiles []string
	for _, sourceFile := range t.BinInfo().Sources {
		substFile := sourceFile
		if len(substitutePathRules) > 0 {
			substFile = SubstitutePath(sourceFile, substitutePathRules)
		}
		if loc.FileMatch(substFile) || (len(processArgs) >= 1 && tryMatchRelativePathByProc(loc.Base, processArgs[0], substFile)) {
			candidateFiles = append(candidateFiles, sourceFile)
			if len(candidateFiles) >= limit {
				break
			}
		}
	}
	limit -= len(candidateFiles)

	// 如果是func:line描述方式，所有后缀匹配的函数名都算是候选函数，我们也得先找到候选的函数列表
	// - 这里的候选函数可能也比较多，所以也得加个数量限制，如果没有开发者想要的候选函数，那也得指定的函数名更明确点，
	//   比如包含包路径、receivertype
	var candidateFuncs []string
	if loc.FuncBase != nil && limit > 0 {
		// 查找最多limit个函数名匹配的函数
		// - 先查泛型函数 (Go 的泛型在编译时会为不同的类型参数生成不同的具体实现，这些实现可能都对应到同一行源码???)
		//   how generics works? see: https://github.com/golang/proposal/blob/master/design/generics-implementation-dictionaries-go1.18.md
		// - 再查其他普通函数
		candidateFuncs = loc.findFuncCandidates(t.BinInfo(), limit)
	}

	// 如果没有找到匹配的源文件名、函数名
	if matching := len(candidateFiles) + len(candidateFuncs); matching == 0 {
		// 如果没有指定作用域，那么直接返回未找到错误
		if scope == nil {
			return nil, "", fmt.Errorf("location %q not found", locStr)
		}
		// 注意，file:line, func:line这里的line是可选项，想象下添加断点时，对吧！
		// 简化下，如果输入了 xxx，但是当做func去查找时没有查到，有可能是少输入了符号* …… 所以当做 *xxx 重新解析下
		addrSpec := &AddrLocationSpec{AddrExpr: locStr}
		locs, subst, err := addrSpec.Find(t, processArgs, scope, locStr, includeNonExecutableLines, nil)
		if err != nil {
			return nil, "", fmt.Errorf("location %q not found", locStr)
		}
		return locs, subst, nil
	} else if matching > 1 {
	// 如果找到了多个匹配，调试器不知道在哪里添加断点，需要提示开发者位置有歧义
		return nil, "", AmbiguousLocationError{Location: locStr, CandidatesString: append(candidateFiles, candidateFuncs...)}
	}

	var addrs []uint64
	var err error

	// 如果候选源文件只有1个，下面看下有没有line要求
	if len(candidateFiles) == 1 {
		// 行号只能>=0，解析NormalLocationSpec时，LineOffset初始化为-1
		if loc.LineOffset < 0 {
			return nil, "", errors.New("Malformed breakpoint location, no line offset specified")
		}
		// 通过DWARF行号表查找 file:line 对应的指令地址，
		addrs, err = proc.FindFileLocation(t, candidateFiles[0], loc.LineOffset)
	} else { 
	// 如果候选函数只有1个，下面看下有没有line要求，这个其实要分两步来完成
	// - 先找到函数入口地址对应的源码行（file:line)
	// - newLine=line+LineOffset，使用 file:newLine 作为位置，查行号表得到地址
		addrs, err = proc.FindFunctionLocation(t, candidateFuncs[0], loc.LineOffset)
	}
	...

	return []api.Location{addressesToLocation(addrs)}, "", nil
}
```

##### LineLocationSpec

LineLocationSpec描述的是当前源文件的指定行的位置，当前源文件位置的确定依赖scope.PC+DWARF行号表，这样先确定当前PC所处的源码位置"文件名：行号"，然后确定新的文件名行号"文件名:loc.Line"。然后再通过行号表将其转换为对应的PC地址。

关于DWARF行号表的设计实现，如果你忘记了相关的细节，可以翻翻 [DWARF行号表](8-dwarf/5-other/2-lineno-table.md)。

```go
// LineLocationSpec represents a line number in the current file.
type LineLocationSpec struct {
	Line int
}

// Find will return the location at the given line in the current file.
func (loc *LineLocationSpec) Find(t *proc.Target, _ []string, scope *proc.EvalScope, _ string, includeNonExecutableLines bool, _ [][2]string) ([]api.Location, string, error) {
	// 由于需要确定当前执行到的源码行位置，依赖PC，所以参数EvalScope不能为空。
	if scope == nil {
		return nil, "", errors.New("could not determine current location (scope is nil)")
	}
	// 确定当前执行到的源文件位置，只关心文件名，行号已经重新指定
	file, _, fn := scope.BinInfo.PCToLine(scope.PC)
	if fn == nil {
		return nil, "", errors.New("could not determine current location")
	}
	// 确定新的位置file:loc.Line
	subst := fmt.Sprintf("%s:%d", file, loc.Line)
	// 查找源文件位置对应的指令地址
	addrs, err := proc.FindFileLocation(t, file, loc.Line)
	if includeNonExecutableLines {
		if _, isCouldNotFindLine := err.(*proc.ErrCouldNotFindLine); isCouldNotFindLine {
			return []api.Location{{File: file, Line: loc.Line}}, subst, nil
		}
	}
	return []api.Location{addressesToLocation(addrs)}, subst, err
}
```

>注意，同一行源代码，可能对应了多条机器指令，那么该使用哪一个指令地址应该作为该源码行的第一条指令呢？比如用来添加断点时，应该停在哪一条指令处？
>
>在行号表中每一行都有一列标识，是否将该行指令当做源码行添加断点时的指令。这个是很重要的，比如Go里面的函数调用是非常特殊的，它不同于C、C++，Go函数调用开始会先检查栈帧大小是否够用，不够用会会执行栈扩容动作，扩容完成再返回原来的函数执行。如果在函>数调用的第一条指令处添加断点，我们会观察到这个函数执行了两次，这很奇怪！所以，对于Go语言调试器，通常要将函数入口处栈检查通过后的第一条指令位置当做断点位置。

但是这并不是 `LocationSpec.Find(...) ([]api.Location, _, error)` 会返回多个位置的理由？上面的问题，DWARF中已经解决了，只需要compiler、linker、debugger开发者注意即可。Find操作返回多个位置的一个情景是，Go Generics，Go泛型函数是通过一种称为"stenciling（蜡印）"的技术，即会为每种泛型参数生成一个函数实例，这多个实例的入口地址自然是不同的，所以这个情景下就存在一个file:line位置存在多个api.Location的可能性。

在介绍NormalLocationSpec查找候选函数名的时候，我们有提到过，会优先搜索泛型函数名，再搜索其他普通函数名，了解即可。

##### OffsetLocationSpec

当前调试器执行到的源码行file:line，在当前源代码位置，增加一个行偏移量LineOffset，得到新的位置file:line+LineOffset。

```go
// OffsetLocationSpec represents a location spec that
// is an offset of the current location (file:line).
type OffsetLocationSpec struct {
	Offset int
}

// Find returns the location after adding the offset amount to the current line number.
func (loc *OffsetLocationSpec) Find(t *proc.Target, _ []string, scope *proc.EvalScope, _ string, includeNonExecutableLines bool, _ [][2]string) ([]api.Location, string, error) {
	// 因为要确定当前执行到的源代码位置，依赖PC，所以scope必须有效
	if scope == nil {
		return nil, "", errors.New("could not determine current location (scope is nil)")
	}
	// 根据PC确定当前执行到的源文件位置 file:line, fn
	file, line, fn := scope.BinInfo.PCToLine(scope.PC)
	if loc.Offset == 0 {
		subst := ""
		if fn != nil {
			subst = fmt.Sprintf("%s:%d", file, line)
		}
		return []api.Location{{PC: scope.PC}}, subst, nil
	}
	if fn == nil {
		return nil, "", errors.New("could not determine current location")
	}
	// 确定新的源文件位置 file:line+LineOffset
	subst := fmt.Sprintf("%s:%d", file, line+loc.Offset)
	// 确定新位置对应的指令地址
	addrs, err := proc.FindFileLocation(t, file, line+loc.Offset)
	...
	return []api.Location{addressesToLocation(addrs)}, subst, err
}
```

##### AddrLocationSpec

AddrLocationSpec其实支持了如下几种方式：

- `<address>`，直接指定了一个地址
- `*<address>`，表达式形式指定了一个地址
- `<funcName>`，函数本身也算是一个地址？函数序言之后的第一条指令的地址

```go
// AddrLocationSpec represents an address when used
// as a location spec.
type AddrLocationSpec struct {
	AddrExpr string
}

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

ps: scope.EvalExpression的工作原理，我们在前一小节 [19-表达式计算](./19-how_evalexpr_works.md) 中进行了详细介绍。如果你忘记了它是如何工作的，可以翻回去看看。当然这一节并没有对所有类型的表达式进行计算，但是我们已经介绍了读者了解这些的所有必备知识、关键流程，读者可以自行了解。

##### RegexLocationSpec

通过 `/regexp/` 的格式来配置一个正则表达式，所有函数名与该正则匹配的位置，都会作为候选函数，然后找到这些函数对应的指令地址。

```go
type RegexLocationSpec struct {
	FuncRegex string
}

// Find will search all functions in the target program and filter them via the
// regex location spec. Only functions matching the regex will be returned.
func (loc *RegexLocationSpec) Find(t *proc.Target, _ []string, scope *proc.EvalScope, locStr string, includeNonExecutableLines bool, _ [][2]string) ([]api.Location, string, error) {
	if scope == nil {
		//TODO(aarzilli): this needs only the list of function we should make it work
		return nil, "", errors.New("could not determine location (scope is nil)")
	}
	funcs := scope.BinInfo.Functions
	matches, err := regexFilterFuncs(loc.FuncRegex, funcs)
	if err != nil {
		return nil, "", err
	}
	r := make([]api.Location, 0, len(matches))
	for i := range matches {
		addrs, _ := proc.FindFunctionLocation(t, matches[i], 0)
		if len(addrs) > 0 {
			r = append(r, addressesToLocation(addrs))
		}
	}
	return r, "", nil
}
```

### 执行测试

略

### 本文小结

本文详细介绍了符号级调试器中locspec（位置描述符）的解析与地址转换机制。locspec允许开发者使用直观的字符串表示位置信息，如"文件名:行号"、"函数名"、"正则表达式"等，而不需要直接操作内存地址。文章首先定义了locspec的文法规范，支持多种位置描述方式，然后通过具体的Go代码实现展示了如何将位置描述字符串解析为不同的LocationSpec类型（如NormalLocationSpec、LineLocationSpec、OffsetLocationSpec等），并详细说明了每种类型如何通过Find方法将位置描述转换为实际的内存地址。整个实现涉及DWARF调试信息的解析、行号表查找、函数符号匹配等核心调试技术，为调试器提供了用户友好的位置描述方式和位置定位功能。

### 参考文献

1. how go generics works, https://github.com/golang/proposal/blob/master/design/generics-implementation-dictionaries-go1.18.md
2. 