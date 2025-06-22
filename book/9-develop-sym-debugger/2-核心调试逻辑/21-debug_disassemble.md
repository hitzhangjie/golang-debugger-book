## Disassemble

这一节我们先介绍这个命令分组中的第一各命令 `disassemble` 的设计及实现。

```bash
(tinydbg) help
...
Viewing source and disassembly, Listing pkgs, funcs, types:
    disassemble (alias: disass)  Disassembler.
    funcs ---------------------- Print list of functions.
    list (alias: ls | l) ------- Show source code.
    packages ------------------- Print list of packages.
    types ---------------------- Print list of types
...
```

### 实现目标: `disassemble [-a <start> ，end>] [-l <locspec>]`

```bash
(tinydbg) help disass
Disassembler.

        [goroutine <n>] [frame <m>] disassemble [-a <start> <end>] [-l <locspec>]

If no argument is specified the function being executed in the selected stack frame will be executed.

        -a <start> <end>        disassembles the specified address range
        -l <locspec>            disassembles the specified function
```

解释下这里的反汇编命令选项：

- `-a <start> <end>`：指定要反汇编的指令地址范围，由于x86指令集是变长编码，不是固定长度编码，意味着指令地址不是某个数字的整数倍，输入这个地址范围的时候必须是准确的，如果错了就可能得到错误的反汇编指令，或者反汇编出错。但是可以借助DWARF调试信息，比如查看某个函数的开始、结束指令地址范围，然后再指定。当然了有了函数名后，直接用 `-l <locspec>` 就可以了，也不一定有这个必要使用 `-a <start> <end>` 这种形式了；
- `-l <locspec>`：这个是指定位置，tinydbg中定义了一系列的描述位置的方式，常见的比如函数名，文件名:行号，这些都是合法的locspec，详细的受支持的locspec列表我们会在接下来介绍。

程序在执行过程中，具体到某个线程、协程，它执行过程中，一定是有自己的系统栈、协程栈的，协程的函数调用栈，要么在这个协程栈上，要么特殊场景涉及到部分系统栈上，但是不管怎么样，总是有个调用栈的。而每个调用栈都对应着一个函数调用，而且我们根据Call Frame Information，是可以拿到调用栈中任意一个栈帧对应的函数信息的，包含函数的指令地址范围。这样就方便了，我们可以直接执行 `disass` 不带任何参数，此时会直接将当前goroutine当前在执行函数的当前语句行进行反汇编。`goroutine <n>`, `frame <m>` 表示在输入 `disass` 之前的调试活动，我们已经切换到了goroutine n，并且选中了栈帧frame m。

### 基础知识

#### 受支持的locspec

see: tinydbg/pkg/locspec/doc.go

```go
// Package locspec implements code to parse a string into a specific
// location specification.
//
// Location spec examples:
//
//	locStr ::= <filename>:<line> | <function>[:<line>] | /<regex>/ | (+|-)<offset> | <line> | *<address>
//
//	* <filename> can be the full path of a file or just a suffix
//	* <function> ::= <package>.<receiver type>.<name> | <package>.(*<receiver type>).<name> | <receiver type>.<name> | <package>.<name> | (*<receiver type>).<name> | <name>
//	  <function> must be unambiguous
//	* /<regex>/ will return a location for each function matched by regex
//	* +<offset> returns a location for the line that is <offset> lines after the current line
//	* -<offset> returns a location for the line that is <offset> lines before the current line
//	* <line> returns a location for a line in the current file
//	* *<address> returns the location corresponding to the specified address
package locspec
```

这是tinydbg中受支持的locspec列表，这了我们总结下，结合添加断点来说明：

- 文件名:行号，比如 `break main.go:20`，在指定源文件main.go的20行
- 函数名，比如 `break main.main`，在指定package的指定函数 main.main
- regexp，比如 `break main.(*Student).*`，在所有匹配正则的函数名、方法名处添加断点
- +offset，比如 `break +2`，在当前断点行-2行位置
- -offset，比如 `break -2`，在当前断点所在行-2行位置
- line，比如 `break 20`，在当前源文件20行
- `*address`，比如 `*0x12345678`，指定内存地址中的地址处

see: tinydbg/pkg/locspec/locations.go，这了包含了不同位置描述对应的类型定义，以及它们满足的接口定义，以及解析函数。

locspec的目的是为了将位置描述字符串转换为内存中的地址，所以针对locspec定义了这样一个接口。locspec主要是在client端调试会话中进行输入，然后RPC传给服务器侧，服务器侧将其解析为具体的LocationSpec实现。

```go
type LocationSpec interface {
	// Find returns all locations that match the location spec.
	Find(t *proc.Target, processArgs []string, scope *proc.EvalScope,
		locStr string,
		includeNonExecutableLines bool,
		substitutePathRules [][2]string) ([]api.Location, string, error)
}
```

每一种LocationSpec实现，都实现了上述接口。调试器服务器端，由于可以和目标进程进行交互，读取它的二进制信息、DWARF信息、进程信息，所以它可以将上述输入的“位置描述”字符串精确转换为内存地址。而每一种LocationSpec实现都需要结合实际情况实现这样的查询操作Find。

```go
// FuncLocationSpec represents a function in the target program.
type FuncLocationSpec struct {
	PackageName           string
	AbsolutePackage       bool
	ReceiverName          string
	PackageOrReceiverName string
	BaseName              string
}
type NormalLocationSpec struct {
	Base       string
	FuncBase   *FuncLocationSpec
	LineOffset int
}
type LineLocationSpec struct { Line int }
type OffsetLocationSpec struct { Offset int }
type AddrLocationSpec struct { AddrExpr string }
type RegexLocationSpec struct { FuncRegex string }

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

如何实现Find操作的呢，每个LocationSpec实现有不同的实现逻辑，比如:

- `*<address>` 就需要涉及到 `ptrace(PTRACE_PEEKDATA,...)` 读取内存中数据，
- 再比如NormalLocationSpec通常是 `文件名:行号`，这种就需要利用DWARF调试信息中的行号表信息，转换出这行对应的指令地址，
- 再比如如果是 `FuncLocationSpec` 就需要根据DWARF调试信息中的FDE信息，再找到该函数所包含指令的起始地址
- ...

所以你看，不同的locspec LocationSpec实现，也各自有不同的转换成内存地址的实现方式，我们会在小节 [20-locspec解析与地址转换](./20-how_locspec_works.md) 介绍不同locspec如何实现向内存地址转换的，这部分还是很重要的，涉及到了很多核心DWARF数据结构的使用。

OK，接下来我们看下反汇编指令的具体实现。

### 代码实现

#### client端实现

client端核心代码路径如下：

```bash
disassembleCmd.cmdFn
    \--> disassCommand(t *Session, ctx callContext, args string) error
            \--> parse command flag `-a <start> <end>` and `-l <locspec>`
            \--> read disassemble flavor **intel**, **go**, **plan9**
            \--> if no flag `-a` or `-l` specified, then disassemble **current statement**
                    \--> locs, _, _ := t.client.FindLocation(ctx.Scope, "+0", true, t.substitutePathRules())
                    \--> instructions, _ = t.client.DisassemblePC(ctx.Scope, locs[0].PC, flavor)
            \--> if `-a <start> <end>` specified, then disassemble **range start,end**
                    \--> instructions, _ = t.client.DisassembleRange(ctx.Scope, uint64(startpc), uint64(endpc), flavor)
            \--> if `-l <locspec>` specified, then 
                    \--> locs, _, _ := t.client.FindLocation(ctx.Scope, locspec, true, t.substitutePathRules())
                    \--> instructions, _ = t.client.DisassemblePC(ctx.Scope, locs[0].PC, flavor)
            \--> disasmPrint, print the instructions
```

下面看下各部分实现:

反汇编命令disass对应的command定义，其执行逻辑就是disassCommand：

```go
var disassembleCmd = func(c *DebugCommands) *command {
	return &command{
		aliases: []string{"disassemble", "disass"},
		cmdFn:   disassCommand,
		group:   sourceCmds,
		helpMsg: `Disassembler.

	[goroutine <n>] [frame <m>] disassemble [-a <start> <end>] [-l <locspec>]

If no argument is specified the function being executed in the selected stack frame will be executed.

	-a <start> <end>	disassembles the specified address range
	-l <locspec>		disassembles the specified function`,
	}
}
```

看下这个disassCommand的执行逻辑：

```go
func disassCommand(t *Session, ctx callContext, args string) error {
    // cmd其实就是flag `-a` or `-l`, rest为flag对应的选项值
	var cmd, rest string
	if args != "" {
		argv := config.Split2PartsBySpace(args)
		cmd = argv[0]
		rest = argv[1]
	}

    // 获取反汇编偏好，intel, go, gnu格式汇编
	flavor := t.conf.GetDisassembleFlavour()

	var disasm api.AsmInstructions
	var disasmErr error

    // 根据指定的选项，进行反汇编处理
	switch cmd {
	case "": // 未指定选项，则反汇编当前函数当前语句
		locs, _, err := t.client.FindLocation(ctx.Scope, "+0", true, t.substitutePathRules())
		if err != nil {
			return err
		}
		disasm, disasmErr = t.client.DisassemblePC(ctx.Scope, locs[0].PC, flavor)
	case "-a": // -a start end，反汇编这个地址范围内的指令
		v := config.Split2PartsBySpace(rest)
		if len(v) != 2 {
			return errDisasmUsage
		}
		startpc, err := strconv.ParseInt(v[0], 0, 64)
		if err != nil {
			return fmt.Errorf("wrong argument: %q is not a number", v[0])
		}
		endpc, err := strconv.ParseInt(v[1], 0, 64)
		if err != nil {
			return fmt.Errorf("wrong argument: %q is not a number", v[1])
		}
		disasm, disasmErr = t.client.DisassembleRange(ctx.Scope, uint64(startpc), uint64(endpc), flavor)
	case "-l": // -l locspec，反汇编这个位置描述处的指令
		locs, _, err := t.client.FindLocation(ctx.Scope, rest, true, t.substitutePathRules())
		if err != nil {
			return err
		}
		if len(locs) != 1 {
			return errors.New("expression specifies multiple locations")
		}
		disasm, disasmErr = t.client.DisassemblePC(ctx.Scope, locs[0].PC, flavor)
	default:
		return errDisasmUsage
	}

	if disasmErr != nil {
		return disasmErr
	}

    // 打印汇编指令
	disasmPrint(disasm, t.stdout, true)

	return nil
}
```

观察上面的函数实现，会发现 client要实现反汇编，一来几个基础的RPC操作：

```go
// FindLocation returns concrete location information described by a location expression
// loc ::= <filename>:<line> | <function>[:<line>] | /<regex>/ | (+|-)<offset> | <line> | *<address>
// * <filename> can be the full path of a file or just a suffix
// * <function> ::= <package>.<receiver type>.<name> | <package>.(*<receiver type>).<name> | <receiver type>.<name> | <package>.<name> | (*<receiver type>).<name> | <name>
// * <function> must be unambiguous
// * /<regex>/ will return a location for each function matched by regex
// * +<offset> returns a location for the line that is <offset> lines after the current line
// * -<offset> returns a location for the line that is <offset> lines before the current line
// * <line> returns a location for a line in the current file
// * *<address> returns the location corresponding to the specified address
// NOTE: this function does not actually set breakpoints.
// If findInstruction is true FindLocation will only return locations that correspond to instructions.
FindLocation(scope api.EvalScope, loc string, findInstruction bool, substitutePathRules [][2]string) ([]api.Location, string, error)

// DisassemblePC disassemble code of the function containing PC
DisassemblePC(scope api.EvalScope, pc uint64, flavour api.AssemblyFlavour) (api.AsmInstructions, error)

// DisassembleRange disassemble code between startPC and endPC
DisassembleRange(scope api.EvalScope, startPC, endPC uint64, flavour api.AssemblyFlavour) (api.AsmInstructions, error)
```

- FindLocation操作支持查找指定locspec对应的指令地址，有可能对应多个指令地址，这个好理解，比如用regexp匹配了多个函数，每个函数对应一个入口指令地址。
- DisassemblePC，对包含此PC的函数，这个要靠调试器后端查找CIE列表找到CIE，然后再在这个CIE包含的FDE列表找到对应的FDE，然后确定对应的函数的起始地址，然后可以从PC到结束地址处的指令进行反汇编。
- DisassembleRange，这个直接指定了start，end地址，需要调试器后端读取进程内存start,end中的指令数据，然后进行反汇编。输入地址可能包含无效地址，不过无所谓，读内存报错 or 反汇编报错，直接返回错误就ok。

这几个操作的详细实现，我们会在server端实现部分予以介绍。

#### client端RPC

client端发起RPC调用的时候，第一个参数都是 `api.EvalScope`，这个向服务器指明了接下来的操作要在哪个协程、栈帧 or defer函数栈帧中执行。

举几个例子：

- `args`，打印函数参数，当然得知道哪个goroutine执行的函数，不同协程执行该函数时、该函数被调多次调用时参数可能不同；
- `locals`，打印局部变量，当然也得知道不同goroutine执行的函数，而且同一个函数局部变量值在不同协程中执行时可能会不同；
- `print <expr>`，打印表达式的值，表达式中可能包含变量名，相同变量名可能在不同函数中、全局函数中定义，自然需要知道是哪个函数定义的，需要这个作用域来进一步确定定义的位置，进而确定变量类型、存储位置；
- etc.


see: tinydbg/service/api/types.go: api.EvalScope

```go
// EvalScope is the scope a command should
// be evaluated in. Describes the goroutine and frame number.
type EvalScope struct {
	GoroutineID  int64
	Frame        int
	DeferredCall int // when DeferredCall is n > 0 this eval scope is relative to the n-th deferred call in the current frame
}
```

OK，介绍清楚了api.EvalScope，我们来看下反汇编期间，client端使用到的几个RPC调用。这里我们主要是了解下它的请求参数，也就了解了这个RPC可被调用的场景。

**FindLocation**:

```go
type FindLocationIn struct {
	Scope                     api.EvalScope
	Loc                       string
	IncludeNonExecutableLines bool

	// SubstitutePathRules is a slice of source code path substitution rules,
	// the first entry of each pair is the path of a directory as it appears in
	// the executable file (i.e. the location of a source file when the program
	// was compiled), the second entry of each pair is the location of the same
	// directory on the client system.
	SubstitutePathRules [][2]string
}

type FindLocationOut struct {
	Locations         []api.Location
	SubstituteLocExpr string // if this isn't an empty string it should be passed as the location expression for CreateBreakpoint instead of the original location expression
}

// Location holds program location information.
// In most cases a Location object will represent a physical location, with
// a single PC address held in the PC field.
// FindLocations however returns logical locations that can either have
// multiple PC addresses each (due to inlining) or no PC address at all.
type Location struct {
	PC       uint64    `json:"pc"`
	File     string    `json:"file"`
	Line     int       `json:"line"`
	Function *Function `json:"function,omitempty"`
	PCs      []uint64  `json:"pcs,omitempty"`
	PCPids   []int     `json:"pcpids,omitempty"`
}

func (c *RPCClient) FindLocation(scope api.EvalScope, loc string, findInstructions bool, substitutePathRules [][2]string) ([]api.Location, string, error) {
	var out FindLocationOut
	err := c.call("FindLocation", FindLocationIn{scope, loc, !findInstructions, substitutePathRules}, &out)
	return out.Locations, out.SubstituteLocExpr, err
}
```

注意这了查找指令地址时，有个参数 FindLocationIn.IncludeNonExecutableLines会被设置为false，目的是排除空行、注释等不包含可执行指令的源码行。

**DisassemblePC**:

```go
type DisassembleIn struct {
	Scope          api.EvalScope
	StartPC, EndPC uint64
	Flavour        api.AssemblyFlavour
}

type DisassembleOut struct {
	Disassemble api.AsmInstructions
}

// DisassemblePC disassembles function containing pc
func (c *RPCClient) DisassemblePC(scope api.EvalScope, pc uint64, flavour api.AssemblyFlavour) (api.AsmInstructions, error) {
	var out DisassembleOut
	err := c.call("Disassemble", DisassembleIn{scope, pc, 0, flavour}, &out)
	return out.Disassemble, err
}
```

**DisassembleRange**:

```go
// DisassembleRange disassembles code between startPC and endPC
func (c *RPCClient) DisassembleRange(scope api.EvalScope, startPC, endPC uint64, flavour api.AssemblyFlavour) (api.AsmInstructions, error) {
	var out DisassembleOut
	err := c.call("Disassemble", DisassembleIn{scope, startPC, endPC, flavour}, &out)
	return out.Disassemble, err
}
```

DisassemblePC 和 DisassembleRange 的区别，对应的服务端实现其实是同一个接口 `(s *RPCServer) Disassemble(...)`，区别只是DisassembleIn.EndPC是否为0.

OK，客户端调用的RPC我们介绍完了，接下来介绍下服务器侧是如何实现上述RPC操作的。

#### server端实现

**FindLocation**:

server端的FindLocation实现，其实就是前面咱们介绍过的locspec的内容，涉及到客户端输入的locspec的解析，解析成具体的LocationSpec实现之后，再用它来执行查找 `LocationSpec.Find(....)`，拿到找到的指令地址信息[]*api.Location。locspec小节我们也举了几个不同的LocationSpec实现是如何来查找对应的指令地址的。这部分内容我们将在 [20-locspec解析与地址转换](./20-how_locspec_works.md) 进行想介绍，感兴趣的话，你也可以先睹为快。

```go
// FindLocation returns concrete location information described by a location expression.
//
//	loc ::= <filename>:<line> | <function>[:<line>] | /<regex>/ | (+|-)<offset> | <line> | *<address>
//	* <filename> can be the full path of a file or just a suffix
//	* <function> ::= <package>.<receiver type>.<name> | <package>.(*<receiver type>).<name> | <receiver type>.<name> | <package>.<name> | (*<receiver type>).<name> | <name>
//	  <function> must be unambiguous
//	* /<regex>/ will return a location for each function matched by regex
//	* +<offset> returns a location for the line that is <offset> lines after the current line
//	* -<offset> returns a location for the line that is <offset> lines before the current line
//	* <line> returns a location for a line in the current file
//	* *<address> returns the location corresponding to the specified address
//
// NOTE: this function does not actually set breakpoints.
func (s *RPCServer) FindLocation(arg FindLocationIn, out *FindLocationOut) error {
	var err error
	out.Locations, out.SubstituteLocExpr, err = s.debugger.FindLocation(
            arg.Scope.GoroutineID, 
            arg.Scope.Frame, 
            arg.Scope.DeferredCall, 
            arg.Loc, 
            arg.IncludeNonExecutableLines, 
            arg.SubstitutePathRules)
	return err
}

// FindLocation will find the location specified by 'locStr'.
func (d *Debugger) FindLocation(goid int64, frame, deferredCall int, locStr string, ...) {
    ...
	loc, _ := locspec.Parse(locStr)
	return d.findLocation(goid, frame, deferredCall, locStr, loc, includeNonExecutableLines, substitutePathRules)
}

func (d *Debugger) findLocation(goid int64, frame, deferredCall int, 
    locStr string, 
    locSpec locspec.LocationSpec, 
    includeNonExecutableLines bool, 
    substitutePathRules [][2]string,
) ([]api.Location, string, error) {

	locations := []api.Location{}
	t := proc.ValidTargets{Group: d.target}
	subst := ""
	for t.Next() {
		pid := t.Pid()
		s, _ := proc.ConvertEvalScope(t.Target, goid, frame, deferredCall)
        // 不同的LocationSpec有不同的Find实现
		locs, s1, _ := locSpec.Find(t.Target, d.processArgs, s, locStr, includeNonExecutableLines, substitutePathRules)
		if s1 != "" {
			subst = s1
		}
		for i := range locs {
			if locs[i].PC == 0 {
				continue
			}
			file, line, fn := t.BinInfo().PCToLine(locs[i].PC)
			locs[i].File = file
			locs[i].Line = line
			locs[i].Function = api.ConvertFunction(fn)
			locs[i].PCPids = make([]int, len(locs[i].PCs))
			for j := range locs[i].PCs {
				locs[i].PCPids[j] = pid
			}
		}
		locations = append(locations, locs...)
	}
	return locations, subst, nil
}
```

现在我们拿到了输入的位置描述字符串locspec对应的指令地址了，然后咱们就可以从这个指令地址处开始读取进程指令数据，然后按照指定的汇编flavor开始反汇编了（反汇编到函数结束）。当然了，我们可能直接通过 `-a <start> <end>` 指定了地址范围，那咱们就读取进程内存地址 `<start,end>` 范围内的数据，然后开始反汇编就可以了。

**Disassemble**:

```go
// Disassemble code.
//
// If both StartPC and EndPC are non-zero the specified range will be disassembled, otherwise the function containing StartPC will be disassembled.
//
// Scope is used to mark the instruction the specified goroutine is stopped at.
//
// Disassemble will also try to calculate the destination address of an absolute indirect CALL if it happens to be the instruction the selected goroutine is stopped at.
func (s *RPCServer) Disassemble(arg DisassembleIn, out *DisassembleOut) error {
	insts, err := s.debugger.Disassemble(arg.Scope.GoroutineID, arg.StartPC, arg.EndPC)
	if err != nil {
		return err
	}
	out.Disassemble = make(api.AsmInstructions, len(insts))
	for i := range insts {
		out.Disassemble[i] = api.ConvertAsmInstruction(
            insts[i], 
            s.debugger.AsmInstructionText(&insts[i], 
            proc.AssemblyFlavour(arg.Flavour)))
	}
	return nil
}

// Disassemble code between startPC and endPC.
// if endPC == 0 it will find the function containing startPC and disassemble the whole function.
func (d *Debugger) Disassemble(goroutineID int64, addr1, addr2 uint64) ([]proc.AsmInstruction, error) {
    ...
	if addr2 == 0 {
		fn := d.target.Selected.BinInfo().PCToFunc(addr1)
		if fn == nil {
			return nil, fmt.Errorf("address %#x does not belong to any function", addr1)
		}
		addr1 = fn.Entry
		addr2 = fn.End
	}

	g, err := proc.FindGoroutine(d.target.Selected, goroutineID)
	if err != nil {
		return nil, err
	}

	curthread := d.target.Selected.CurrentThread()
	if g != nil && g.Thread != nil {
		curthread = g.Thread
	}
	regs, _ := curthread.Registers()

	return proc.Disassemble(d.target.Selected.Memory(), regs, d.target.Selected.Breakpoints(), d.target.Selected.BinInfo(), addr1, addr2)
}
```

see: tinydbg/pkg/dwarf/op/regs.go 这里先看下这个，DwarfRegisters记录了CFA计算需要用到的信息，这里面的寄存器是些伪寄存器，不一定对应着真实物理寄存器。执行CFA相关的计算时，你还有印象吗？当我们有了调用栈信息表，给我们一个指令地址PC，我们执行CIE.initial_instructions，然后执行找到对应的FDE并执行FDE.instructions，一直执行到nextPC>该指令地址PC，我们的DwarfRegisters里就得到了帧地址、函数返回地址等信息。

```go
/ DwarfRegisters holds the value of stack program registers.
type DwarfRegisters struct {
	StaticBase uint64

	CFA       int64
	FrameBase int64
	ObjBase   int64
	regs      []*DwarfRegister

	ByteOrder  binary.ByteOrder
	PCRegNum   uint64
	SPRegNum   uint64
	BPRegNum   uint64
	LRRegNum   uint64
	ChangeFunc RegisterChangeFunc

	FloatLoadError   error // error produced when loading floating point registers
	loadMoreCallback func()
}
```

see: tinydbg/pkg/proc/disasm.go

```go
// Disassemble disassembles target memory between startAddr and endAddr, marking
// the current instruction being executed in goroutine g.
// If currentGoroutine is set and thread is stopped at a CALL instruction Disassemble
// will evaluate the argument of the CALL instruction using the thread's registers.
// Be aware that the Bytes field of each returned instruction is a slice of a larger array of size startAddr - endAddr.
func Disassemble(mem MemoryReadWriter, regs Registers, breakpoints *BreakpointMap, bi *BinaryInfo, startAddr, endAddr uint64) ([]AsmInstruction, error) {
	if startAddr > endAddr {
		return nil, fmt.Errorf("start address(%x) should be less than end address(%x)", startAddr, endAddr)
	}
	return disassemble(mem, regs, breakpoints, bi, startAddr, endAddr, false)
}

func disassemble(memrw MemoryReadWriter, regs Registers, breakpoints *BreakpointMap, bi *BinaryInfo, startAddr, endAddr uint64, singleInstr bool) ([]AsmInstruction, error) {
    // 需要用物理寄存器值来初始化它，后面执行CFA计算逻辑时会用到并更新这里的值
	var dregs *op.DwarfRegisters
	if regs != nil {
		dregs = bi.Arch.RegistersToDwarfRegisters(0, regs)
	}

    // 从内存读取指令数据
	mem := make([]byte, int(endAddr-startAddr))
	_, err := memrw.ReadMemory(mem, startAddr)
	if err != nil {
		return nil, err
	}

	r := make([]AsmInstruction, 0, len(mem)/bi.Arch.MaxInstructionLength())
	pc := startAddr

	var curpc uint64
	if regs != nil {
		curpc = regs.PC()
	}

	for len(mem) > 0 {
        // 检查下一条待decode的指令开头字节是否是0xCC，是的话表明之前添加了断点，先恢复原始指令数据
        // 反汇编完了之后，再恢复添加断点
		bp, atbp := breakpoints.M[pc]
		if atbp {
			copy(mem, bp.OriginalData)
		}

        // 根据指令地址拿到源文件位置，这个表是根据DWARF行号表建立起来的
		file, line, fn := bi.PCToLine(pc)

        // 反汇编指令
		var inst AsmInstruction
		inst.Loc = Location{PC: pc, File: file, Line: line, Fn: fn}
		inst.Breakpoint = atbp
		inst.AtPC = (regs != nil) && (curpc == pc)
		bi.Arch.asmDecode(&inst, mem, dregs, memrw, bi)

		r = append(r, inst)

        // 下一条待decode的指令地址
		pc += uint64(inst.Size)
		mem = mem[inst.Size:]

        // 如果是decode单条指令的化，就可以结束了
		if singleInstr {
			break
		}
	}
	return r, nil
}
```

另外这里有一层抽象设计，不同处理器架构有不同的指令集，这里的Arch.asmDecode是一个函数引用，对应着不同处理器架构上的实现。

#### target层实现

哎对了，现代调试器的前后端分离式架构中，调试器后端的服务层，符号层，目标层，前面locspec之类查找指令地址的操作就是符号层逻辑，而与目标操作系统、硬件架构相关的就属于target层了。

比如：

- 反汇编，与指令集架构相关；
- 进程的执行控制，不同硬件、指令集断点指令也不一样，比如amd64架构下是0xcc，有些有硬件断点，有些没有；
- 进程的内存读写，不同操作系统可能系统调用也不同；
- ...

这些与具体的操作系统、硬件架构相关的（GOOS/GOARCH) 就在目标层进行实现，我们的demo tinydbg只支持 linux/amd64 组合。

see: tinydbg/pkg/proc/amd64_arch.go

```go
// AMD64Arch returns an initialized AMD64
// struct.
func AMD64Arch(goos string) *Arch {
	return &Arch{
		Name:                             "amd64",
		ptrSize:                          8,
		maxInstructionLength:             15,
		breakpointInstruction:            amd64BreakInstruction, // 断点操作
		breakInstrMovesPC:                true,
		derefTLS:                         goos == "windows",
		prologues:                        prologuesAMD64,
		fixFrameUnwindContext:            amd64FixFrameUnwindContext,
		switchStack:                      amd64SwitchStack,
		regSize:                          amd64RegSize,
		RegistersToDwarfRegisters:        amd64RegistersToDwarfRegisters,
		addrAndStackRegsToDwarfRegisters: amd64AddrAndStackRegsToDwarfRegisters,
		DwarfRegisterToString:            amd64DwarfRegisterToString,
		inhibitStepInto:                  func(*BinaryInfo, uint64) bool { return false },
		asmDecode:                        amd64AsmDecode,       // 反汇编操作
		PCRegNum:                         regnum.AMD64_Rip,
		SPRegNum:                         regnum.AMD64_Rsp,
		BPRegNum:                         regnum.AMD64_Rbp,
		ContextRegNum:                    regnum.AMD64_Rdx,
		asmRegisters:                     amd64AsmRegisters,
		RegisterNameToDwarf:              nameToDwarfFunc(regnum.AMD64NameToDwarf),
		RegnumToString:                   regnum.AMD64ToName,
		debugCallMinStackSize:            256,
		maxRegArgBytes:                   9*8 + 15*8,
		argumentRegs:                     []int{regnum.AMD64_Rax, regnum.AMD64_Rbx, regnum.AMD64_Rcx},
	}
}
```

这里我们先收一下，看下它的反汇编操作是如何实现的：

```go
func amd64AsmDecode(asmInst *AsmInstruction, mem []byte, regs *op.DwarfRegisters, memrw MemoryReadWriter, bi *BinaryInfo) error {
	return x86AsmDecode(asmInst, mem, regs, memrw, bi, 64)
}

// AsmDecode decodes the assembly instruction starting at mem[0:] into asmInst.
// It assumes that the Loc and AtPC fields of asmInst have already been filled.
func x86AsmDecode(asmInst *AsmInstruction, mem []byte, regs *op.DwarfRegisters, memrw MemoryReadWriter, bi *BinaryInfo, bit int) error {
	inst, err := x86asm.Decode(mem, bit)
	if err != nil {
		asmInst.Inst = (*x86Inst)(nil)
		asmInst.Size = 1
		asmInst.Bytes = mem[:asmInst.Size]
		return err
	}

	asmInst.Size = inst.Len
	asmInst.Bytes = mem[:asmInst.Size]
	patchPCRelX86(asmInst.Loc.PC, &inst)
	asmInst.Inst = (*x86Inst)(&inst)
	asmInst.Kind = OtherInstruction

	switch inst.Op {
	case x86asm.JMP, x86asm.LJMP:
		asmInst.Kind = JmpInstruction
	case x86asm.CALL, x86asm.LCALL:
		asmInst.Kind = CallInstruction
	case x86asm.RET, x86asm.LRET:
		asmInst.Kind = RetInstruction
	case x86asm.INT:
		asmInst.Kind = HardBreakInstruction
	}

	asmInst.DestLoc = resolveCallArgX86(&inst, asmInst.Loc.PC, asmInst.AtPC, regs, memrw, bi)
	return nil
}

`x86asm.Decode(...)` 是在 `golang.org/x/arch/x86/x86asm/decode.go` 中实现的，这了我们知道就行。
```

题外话，现在要从0到1实现一个反汇编器disassembler，是一个非常庞大的工程，为了解决这个难题capstone反汇编引擎诞生。感兴趣的可以看下 [capstone](https://www.capstone-engine.org/) 这个项目，现在也有开发者将其PORT到了[Go Gapstone](https://github.com/bnagy/gapstone)。我们这里使用的是 `golang.org/x/arch/x86/x86asm` 这个包，大家了解即可，学习过《计算机组成原理》的对变长指令编码、解码应该都不陌生。我们只是提一下工程上，要实现一个反汇编器并不容易。

> From [Dissecting Go Binaries](https://www.grant.pizza/blog/dissecting-go-binaries/):
>
> First of all, in order to build a disassembler we need to know what all of the binary machine code translates to in assembly instructions. To do this we must have a reference for all assembly instructions for the architecture of the compiled binary. If you’re not familiar with this task you wouldn’t think it’d be so difficult. However, there are multiple micro-architectures, assembly syntaxes, sparsely-documented instructions, and encoding schemes that change over time. If you want more analysis on why this is difficult I enjoy this article.
>
> Thankfully all of the heavy lifting has been done for us by the authors and maintainers of Capstone, a disassembly framework. Capstone is widely accepted as the standard to use for writing disassembly tools. Reimplementing it would be quite a daunting, albeit educational, task so we won’t be doing that as part of this post. Using Capstone in Go is as simple as importing its cleverly named Go bindings, gapstone.

#### 最后一步

OK，当调试器后端，将locspec转换成指令地址，然后读取出指令数据，并根据特定架构的指令反汇编函数进行反汇编之后，我们就得到了一系列的汇编指令。这些汇编指令列表，就这样最终返回给了客户端。客户端只需要遍历指令，然后打印出来即可。

```go
// AsmInstructions is a slice of single instructions.
type AsmInstructions []AsmInstruction

// AsmInstruction represents one assembly instruction.
type AsmInstruction struct {
	Loc        Location
	DestLoc    *Location
	Bytes      []byte
	Breakpoint bool
	AtPC       bool

	Size int
	Kind AsmInstructionKind

	Inst archInst
}

func disasmPrint(dv api.AsmInstructions, out io.Writer, showHeader bool) {
	bw := bufio.NewWriter(out)
	defer bw.Flush()
	if len(dv) > 0 && dv[0].Loc.Function != nil && showHeader {
		fmt.Fprintf(bw, "TEXT %s(SB) %s\n", dv[0].Loc.Function.Name(), dv[0].Loc.File)
	}
	tw := tabwriter.NewWriter(bw, 1, 8, 1, '\t', 0)
	defer tw.Flush()
	for _, inst := range dv {
		atbp := ""
		if inst.Breakpoint {
			atbp = "*"
		}
		atpc := ""
		if inst.AtPC {
			atpc = "=>"
		}
		fmt.Fprintf(tw, "%s\t%s:%d\t%#x%s\t%x\t%s\n", atpc, filepath.Base(inst.Loc.File), inst.Loc.Line, inst.Loc.PC, atbp, inst.Bytes, inst.Text)
	}
}
```

打印操作将服务器返回的汇编指令进行打印，操作码、操作数，并进行适当的缩进、对齐操作。`disass` 的完整处理过程到此就结束了。

### 执行测试

略。

### 本文总结

我们详细介绍了tinydbg中的反汇编操作的实现，前后端分离式架构下调试器前后端之间的服务层通信，不同位置描述locspec的解析，调试器根据locspec对应的LocationSpec实现将locspec转换为指令地址，然后读取内存指令数据、反汇编，将反汇编后的指令数据返回给客户端、客户端打印显示出来。这个完整的过程我们已经全部介绍到了，相信大家对这块的理解也更深入了。

### 参考文献

1. Capstone, https://www.capstone-engine.org/
2. Gapstone, https://github.com/bnagy/gapstone
3. Dissecting Go Binaries, https://www.grant.pizza/blog/dissecting-go-binaries/
