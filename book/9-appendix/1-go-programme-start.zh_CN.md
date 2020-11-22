# go runtime: go程序启动流程

## go程序启动流程概览

我们使用如下源程序作为示例，来看一看go程序的启动过程:

**file: main.go**

```go
package main

import "fmt"

func main() {
	fmt.Println("vim-go")
}
```

运行dlv进行调试，将程序执行到main.main处：

```
$ dlv debug main.go
Type 'help' for list of commands.
(dlv) b main.main
Breakpoint 1 set at 0x10d0faf for main.main() ./main.go:5
(dlv) c
> main.main() ./main.go:5 (hits goroutine(1):1 total:1) (PC: 0x10d0faf)
     1:	package main
     2:	
     3:	import "fmt"
     4:	
=>   5:	func main() {
     6:		fmt.Println("vim-go")
     7:	}
(dlv) 
```

这个时候看一下调用堆栈：

```bash
(dlv) bt
0  0x00000000010d0faf in main.main
   at ./main.go:5
1  0x000000000103aacf in runtime.main
   at /usr/local/go/src/runtime/proc.go:204
2  0x000000000106d021 in runtime.goexit
   at /usr/local/go/src/runtime/asm_amd64.s:1374
(dlv) 
```

由此可知go程序启动是按照如下流程启动的：

1. asm_amd64.s:1374 runtime·goexit:runtime·goexit1(SB)

2. runtime/proc.go:204 runtime.main:fn()

   这里的fn就是测试源程序中的main.main

3. 现在PC就停在main.main处，等待我们进行后续调试。

## go程序启动前初始化

这里我们讲的启动前初始化，指的是程序执行到我们的入口函数main.main之前的操作，理解这部分内容，将有助于建立对go的全局认识，也有助于加强对实现go调试器的认识。

### go进程实例化

当我们在shell里面键入`./prog`时，操作系统为我们实例化了一个prog程序的实例，进程启动了，这个过程中发生了什么呢？

- shell中首先fork一个子进程，就称为子shell吧；
- 子shell中再通过执行execvp替换掉进程待执行程序的代码、数据等等；
- 一切准备就绪后，操作系统将准备好的进程状态交给调度器调度执行；

我们就假定当前调度器选中了当前进程，看下go进程从启动开始执行了什么逻辑。

在编译c程序的时候，我们知道一个源程序首先会被编译成*.o文件，然后同系统提供的共享库、系统提供的启动代码结合起来进行链接（link）之后，形成一个最终的可执行程序。链接的时候有internal linkage（静态链接）或者external linkage（动态链接）两种方式。

go程序和c程序类似，也有不同的链接方式，参考`go tool link`中的`-linkmode`选项说明进行了解。通常情况下如果没有cgo，默认go build构建出来的都是internal linkage，所以其体积也稍大，通过系统工具`ldd <prog>`查看依赖的共享库会提示错误`not dynamic executable`也可以证实这点。

### go进程启动代码

go程序对应的进程开始执行之后，其首先要执行的指令就是启动代码，如下所示：

**file: asm_amd64.s**

```asm
// _rt0_amd64 is common startup code for most amd64 systems when using
// internal linking. This is the entry point for the program from the
// kernel for an ordinary -buildmode=exe program. The stack holds the
// number of arguments and the C-style argv.
TEXT _rt0_amd64(SB),NOSPLIT,$-8
	MOVQ	0(SP), DI	// argc
	LEAQ	8(SP), SI	// argv
	JMP	runtime·rt0_go(SB)
	
// main is common startup code for most amd64 systems when using
// external linking. The C startup code will call the symbol "main"
// passing argc and argv in the usual C ABI registers DI and SI.
TEXT main(SB),NOSPLIT,$-8
	JMP	runtime·rt0_go(SB)
```

上述是go程序构建时分别采用internal、external linkage时使用的启动代码，go进程启动时将首先执行这段指令。第一种是首先为进程传递参数argc、argv，然后跳到`runtime.rt0_go(SB)`执行，第二种是说c启动代码在调用main之前会负责传递argc、argv，`runtime.rt0_go(SB)`。

就先不在linkmode对启动代码的影响这多做讨论了，直接看`runtime.rt0_go(SB)`。

### `runtime.rt0_go(SB)`

这里汇编代码篇幅过长，我们省去了大部分汇编代码，只保留了比较重要的步骤的说明。

```asm
TEXT runtime·rt0_go(SB),NOSPLIT,$0
	// copy arguments forward on an even stack
	...

	// create istack out of the given (operating system) stack.
	...

	// find out information about the processor we're on
	...

	// others
	...
ok:
	// set the per-goroutine and per-mach "registers"
	...

	// save m->g0 = g0
	...
	// save m0 to g0->m
	...


	// copy argc
	...
	// copy argv
	...
	CALL	runtime·args(SB)
	CALL	runtime·osinit(SB)
	CALL	runtime·schedinit(SB)

	// create a new goroutine to start program
	MOVQ	$runtime·mainPC(SB), AX		// entry
	PUSHQ	AX
	PUSHQ	$0			// arg size
	CALL	runtime·newproc(SB)
	POPQ	AX
	POPQ	AX

	// start this M
	CALL	runtime·mstart(SB)

	CALL	runtime·abort(SB)	// mstart should never return
	RET

	// Prevent dead-code elimination of debugCallV1, which is
	// intended to be called by debuggers.
	MOVQ	$runtime·debugCallV1(SB), AX
	RET
```

我们看到在完成上半部分的一些初始化之后，还做了这些操作：

1. copy argc, copy argv
2. call runtime·args(SB), call runtime·osinit(SB), call runtime·schedinit(SB)
3. create a new goroutine to start program
   1. push entry: $runtime·mainPC(SB)
   2. push arg size: $0
   3. call runtime·newproc(SB)
4. call runtime·mstart(SB)

这些步骤就是我们关心的go程序启动的关键部分了，不妨一一来看下。

> ps：阅读go汇编，需要先阅读下相关的基础知识，可以参考下 [a quick guide to go's assembler](https://golang.org/doc/asm).
>
> - `FP`: Frame pointer: arguments and locals.
> - `PC`: Program counter: jumps and branches.
> - `SB`: Static base pointer: global symbols.
> - `SP`: Stack pointer: top of stack.
>
> All user-defined symbols are written as offsets to the pseudo-registers `FP` (arguments and locals) and `SB` (globals).
>
> The `SB` pseudo-register can be thought of as the origin of memory, so the symbol `foo(SB)` is the name `foo` as an address in memory. This form is used to name global functions and data. Adding `<>` to the name, as in `foo<>(SB)`, makes the name visible only in the current source file, like a top-level `static` declaration in a C file. Adding an offset to the name refers to that offset from the symbol's address, so `foo+4(SB)` is four bytes past the start of `foo`.

#### call runtime·args(SB)

指的是runtime package下的args这个函数，总之就是设置argc、argv这些参数的。

**file: runtime/runtime1.go**

```go
func args(c int32, v **byte) {
	argc = c
	argv = v
	sysargs(c, v)
}
```

#### runtime·osinit(SB)

指的是runtime package下的osinit这个函数，总之就是写系统设置相关的，先不关心。

**file: runtime/os_linux.go**

```go
func osinit() {
	ncpu = getproccount()
	physHugePageSize = getHugePageSize()
	osArchInit()
}
```

#### call runtime·schedinit(SB)

指的是runtime package下的schedinit这个函数，做了一些调度执行前的准备。

```go
// The bootstrap sequence is:
//
//	call osinit
//	call schedinit
//	make & queue new G
//	call runtime·mstart
//
// The new G calls runtime·main.
func schedinit() {
	// lockInit Linux下为空操作
    ...

	// raceinit must be the first call to race detector.
	// In particular, it must be done before mallocinit below calls racemapshadow.
    
    // @see https://github.com/golang/go/blob/master/src/runtime/HACKING.md
    // 参考对getg()的解释：这里应该是在系统栈上运行，返回的_g_应该是当前M的g0
	_g_ := getg()
	if raceenabled {
		_g_.racectx, raceprocctx0 = raceinit()
	}

	sched.maxmcount = 10000

	moduledataverify()
	stackinit()
	mallocinit()
	fastrandinit() // must run before mcommoninit
	mcommoninit(_g_.m, -1)
	cpuinit()       // must run before alginit
	alginit()       // maps must not be used before this call
	modulesinit()   // provides activeModules
	typelinksinit() // uses maps, activeModules
	itabsinit()     // uses activeModules

	msigsave(_g_.m)
	initSigmask = _g_.m.sigmask

	goargs()
	goenvs()
	parsedebugvars()
	gcinit()

	lock(&sched.lock)
	sched.lastpoll = uint64(nanotime())
	procs := ncpu
	if n, ok := atoi32(gogetenv("GOMAXPROCS")); ok && n > 0 {
		procs = n
	}
	procresize(procs)
	...
	unlock(&sched.lock)
	...
}
```

#### 启动runtime.main & main.main

好了，上面一大堆都是一些初始化的工作，现在看下runtime.main启动的最直接部分：

```asm
	// create a new goroutine to start program
	MOVQ	$runtime·mainPC(SB), AX		// entry
	PUSHQ	AX
	PUSHQ	$0			// arg size
	CALL	runtime·newproc(SB)
	POPQ	AX
	POPQ	AX

	// start this M
	CALL	runtime·mstart(SB)
```

这里首先首先获取符号`$runtime.mainPC(SB)`的地址放入AX，这个其实是函数runtime.main的入口地址，然后压函数调用参数argsize 0，因为这个函数没有参数。

```asm
DATA	runtime·mainPC+0(SB)/8,$runtime·main(SB)
GLOBL	runtime·mainPC(SB),RODATA,$8
```

runtime·main(SB)对应的就是runtime.main这个函数：

```go
// The main goroutine.
func main() {
	g := getg()

	// Racectx of m0->g0 is used only as the parent of the main goroutine.
	// It must not be used for anything else.
	g.m.g0.racectx = 0

	// 调整协程栈大小，64位最大1GB，32位最大250M
    ...

	// Allow newproc to start new Ms.
	mainStarted = true

	if GOARCH != "wasm" { // no threads on wasm yet, so no sysmon
		systemstack(func() {
            // 创建新的m，并执行sysmon，-1表示不预先指定m的id
			newm(sysmon, nil, -1)
		})
	}

    // 注意，现在执行的是main goroutine，当前线程是主线程，
    // 调用该方法将是的main goroutine绑定调度线程到主线程，
    // 意味着我们可以断定，main.main这个函数永远运行在主线程之上，除非之后解绑
	lockOSThread()
    ...

    // 这里就是执行runtime package下的初始化逻辑：
    // - 每个package都有一些import进来的依赖，这些import的package需要做初始化逻辑；
    // - 每个package内部的func init()需要在初始化完依赖之后完成调用；
	doInit(&runtime_inittask) // must be before defer
	...

	// Defer unlock so that runtime.Goexit during init does the unlock too.
	needUnlock := true
	defer func() {
		if needUnlock {
			unlockOSThread()
		}
	}()
	...

    // 在调用用户编写的程序代码之前，开启gc，这里并没有创建独立线程来做gc，可能以后会
	gcenable()

	main_init_done = make(chan bool)
	if iscgo {
		...
		// Start the template thread in case we enter Go from
		// a C-created thread and need to create a new thread.
		startTemplateThread()
		cgocall(_cgo_notify_runtime_init_done, nil)
	}

    // 初始化main package，包括其import的依赖，以及main package下的func init()
	doInit(&main_inittask)
	// main package初始化完成
	close(main_init_done)

	needUnlock = false
    
    // 注意，此处又将当前goroutine与thread做了分离，看来go的设计者只是想
    // 将某些初始化动作放在main thread上完成，并不想事后仍然特殊对待main goroutine，
    // main goroutine和其他goroutine一样，可以由scheduler选择其他线程对其进行调度
	unlockOSThread()

    // 如果编译成的是静态库、动态库，虽然有main函数，但是不能执行
	if isarchive || islibrary {
		return
	}
    
    // 注意，调用main_main，其实就是main.main，请查看前面的go directive定义：
    // 就是//go:linkname main_main main.main，对main_main的调用将转入main.main
    //
	// 因为前面已经解绑了main goroutine和main thread的关系，所以我们唯一可以断定的，
    // 是main.main方法是执行在main goroutine上的，但是不一定在main thread上
	fn := main_main 
	fn()
	if raceenabled {
		racefini()
	}

	// main.main结束，意味着整个程序准备结束，
    // 如果有panic发生，会通知所有协程打印堆栈
	if atomic.Load(&runningPanicDefers) != 0 {
		// Running deferred functions should not take long.
		for c := 0; c < 1000; c++ {
			if atomic.Load(&runningPanicDefers) == 0 {
				break
			}
			Gosched()
		}
	}
	if atomic.Load(&panicking) != 0 {
		gopark(nil, nil, waitReasonPanicWait, traceEvGoStop, 1)
	}

	exit(0)
	...
}
```

这里我们分析了go程序启动的一个流程，以及我们可以得出的一个非常重要的结论：

> main.main方法是由main goroutine来执行，但是main goroutine不一定由main thread来调度执行。
>
> main goroutine和main thread二者之间没有默认的绑定关系！

明确这点是非常重要的，它将有助于我们理解`godbg attach <pid>`之后为什么main方法没有停下来的问题。

