## Latest: 借助LLM+调试器IO重定向实现自动化调试

### 背景：自动化调试的必要性

在软件开发过程中，调试是一项耗时且重复性高的工作。传统的调试方式通常是开发者手动与调试器交互：

- 设置断点
- 运行到断点
- 检查变量状态
- 决定下一步动作
- 重复上述过程

这种方式在定位复杂bug时往往需要进行数十次或数百次的交互，是典型的"体力活"。

随着大型语言模型（LLM）的发展，我们有机会将这类重复性工作自动化。AI Agent可以：

- 理解程序逻辑和错误症状
- 根据当前调试状态推导下一步调试策略
- 通过ReAct（Reasoning + Acting）模式不断调整调试命令
- 自动定位问题所在

这样做的优势包括：

1. **效率提升**：从手动数十次交互降低到自动多轮推理
2. **减少人工成本**：让专家从重复性工作中解放出来
3. **提高诊断准确性**：AI可以系统地遍历可能的状态空间
4. **支持复杂场景**：多线程、并发、分布式系统等复杂场景的调试

---

### 原理解析：调试器I/O重定向

#### 调试器的正常交互模式

通常，我们使用调试器时是通过交互式终端（Interactive Terminal）：

```
用户 ←→ 调试器进程 ←→ 被调试的程序
```

- **输入（stdin）**：用户在终端输入调试命令（break, step, print等）
- **输出（stdout）**：调试器打印执行结果、变量信息、源代码视图等
- **实时反馈**：用户立即看到结果，基于结果调整下一步操作

#### I/O重定向模式下的工作原理

当使用I/O重定向时，流程变为：

```
AI Agent ←→ stdin/stdout/stderr 文件 ←→ 调试器进程 ←→ 被调试的程序
```

**关键洞察**：

1. **行缓冲执行**：调试器每次从stdin读取一行命令，执行该命令，然后将结果写入stdout
2. **AI驱动**：AI Agent作为外部控制器，根据当前stdout内容决定下一条命令
3. **多轮交互**：通过不断读取stdin反馈、调用LLM推理、写入新命令到stdin，实现自动化调试

#### 具体工作流程

```
[初始化阶段]
1. 将调试命令序列写入stdin.txt
2. 启动调试器：tinydbg exec ./main --allow-non-terminal-interactive < stdin.txt > stdout.txt 2> stderr.txt
3. 调试器阻塞式读取stdin

[执行阶段 - 每次迭代]
1. 调试器读入一条命令（如 "step"）
2. 执行该命令，得到结果（源代码位置、变量值等）
3. 将结果写入stdout
4. 调试器尝试读取下一条命令

[AI反馈循环]
1. AI Agent读取stdout的最新输出
2. 通过ReAct推理判断：
   - 当前程序状态是什么？
   - 是否到达预期状态？
   - 下一步应该怎么做？
3. 追加新命令到stdin
4. 调试器继续读取执行
5. 返回步骤1

[终止阶段]
1. 当AI判断bug已定位或问题已解决
2. 追加 "exit" 命令
3. 调试器退出，stdin/stdout/stderr保存完整的调试过程
```

#### 为什么这种模式有效

1. **确定性**：每个调试命令的效果完全由当前程序状态决定，方便AI推理
2. **完全可观测**：所有调试输出（stdout/stderr）都被记录，便于事后分析
3. **灵活性**：AI可以在任何时刻基于最新输出调整策略
4. **可复现**：完整的stdin记录了调试过程，可以完全重放
5. **兼容性**：对调试器无特殊要求，只要支持stdin/stdout重定向即可

---

### 技术准备

#### 所需工具

1. **调试器**：tinydbg（Go调试器，dlv的简化版本）
2. **编译器**：Go 1.24.6（需与调试器版本兼容）
3. **LLM API**：OpenAI、Claude等（用于AI推理）
4. **脚本语言**：Python/Shell（用于AI Agent控制逻辑）

#### 编译时注意事项

为了便于调试，编译时需要禁用优化和内联：

```bash
go1.24.6 build -gcflags 'all=-N -l' -o main main.go
```

- `-N`：禁用优化
- `-l`：禁用函数内联

这样可以确保源代码行与机器指令的一一对应，调试器能精确定位位置。

---

### 案例演示：Array Index Out Of Bounds

#### 1. 问题代码

文件：`main.go`

```go
package main

import "fmt"

func main() {
	a := []int{1, 2, 3, 4, 5}
	sum := 0
	for i := 0; i <= len(a); i++ {  // Bug: loop condition should be i < len(a)
		sum += a[i]
	}
	fmt.Println("Sum:", sum)
}
```

**问题**：循环条件为 `i <= len(a)` 而非 `i < len(a)`，导致当 `i == 5` 时访问 `a[5]`，超出数组边界。

**预期表现**：运行程序会触发panic: `runtime error: index out of range [5] with length 5`

#### 2. 编译与调试准备

```bash
cd /home/zhangjie/debugger101/tinydbg/examples/llm_debug2

# 使用Go 1.24.6编译，禁用优化
go1.24.6 build -gcflags 'all=-N -l' -o main main.go

# 验证编译成功
ls -la main
```

#### 3. AI驱动的调试过程

LLM输出工具调用参数，驱动AI Agent执行调试器help命令（`tinydbg help` 和 `tinydbg help redirect`）来了解如何实现重定向。学习到下列命令：`tinydbg exec ./main --allow-non-terminal-interactive < stdin.txt > stdoutxxx.txt 2> stderrxxx.txt` 。接下来LLM就继续推理初步的调试命令，如先停在main.main入口，再一步步尝试其他调试命令及执行结果，来逼近最终问题。

下面是真实执行过程中的演示，您可以使用常见的AI Agent工具（如cursor、vscode copilot等进行测试）。

##### 第一轮：设置断点，达到初始状态

**AI推理**：程序无法直接看到内部状态，需要使用调试器。首先应在 `main` 函数入口设置断点，然后运行到该断点。

**调试命令** (写入stdin.txt第1-2行)：

```
break main.main
continue
```

**执行结果** (stdout片段)：

```
(tinydbg) Breakpoint 1 set at 0x4b1af3 for main.main() ./main.go:5
(tinydbg) > [Breakpoint 1] main.main() ./main.go:5 (hits goroutine(1):1 total:1) (PC: 0x4b1af3)
     1:	package main
     2:
     3:	import "fmt"
     4:
=>   5:	func main() {
     6:		a := []int{1, 2, 3, 4, 5}
     7:		sum := 0
     8:		for i := 0; i <= len(a); i++ {  // Bug: loop condition should be i < len(a)
     9:		    sum += a[i]
    10:	    }
```

**AI观察**：程序已停在function entry point。现在应该检查初始变量。

##### 第二轮：尝试打印变量（失败）

**AI推理**：需要理解程序的初始状态。尝试打印数组 `a` 的当前值。

**调试命令** (第3行)：

```
print a
```

**执行结果** (stderr片段)：

```
Command failed: could not find symbol value for a
```

**AI学习**：当前执行位置虽然在 `main` 入口，但变量 `a` 尚未初始化。需要向前执行。

##### 第三轮：逐步执行，初始化变量

**AI推理**：使用 `step` 命令逐行执行，让变量完成初始化。

**调试命令** (第4行)：

```
step
```

**执行结果** (stdout片段)：

```
(tinydbg) > main.main() ./main.go:6 (PC: 0x4b1afa)
     5:	func main() {
     6:	    a := []int{1, 2, 3, 4, 5}
     ...
```

**AI观察**：现在停在第6行，即 `a` 的声明处。

##### 第四轮：再次打印变量

**AI推理**：已经到达变量初始化语句。再执行一次 `step` 让赋值完成，然后打印。

**调试命令** (第5-7行)：

```
step
print a
```

**执行结果** (stdout片段)：

```
(tinydbg) > main.main() ./main.go:7 (PC: 0x4b1b75)
     7:		sum := 0
     ...
(tinydbg) []int len: 5, cap: 5, [1,2,3,4,5]
```

**AI确认**：`a = [1,2,3,4,5]`，长度为5。

##### 第五轮：进入循环，检查循环变量

**AI推理**：已理解初始状态：`a` 是长度为5的数组。现在需要进入循环，理解循环如何执行。首先应该到达循环的 `for` 语句。

**调试命令** (第8-10行)：

```
step
print i
```

**执行结果** (stdout片段)：

```
(tinydbg) > main.main() ./main.go:8 (PC: 0x4b1b7e)
=>   8:	    for i := 0; i <= len(a); i++ {  // Bug: loop condition should be i < len(a)
     9:	        sum += a[i]
(tinydbg) (tinydbg) > main.main() ./main.go:9 (PC: 0x4b1b9c)
=>   9:	        sum += a[i]
(tinydbg) 0
```

**AI确认**：`i = 0`，已进入循环体第一次迭代。

##### 第六轮：循环遍历（多次迭代）

**AI推理**：现在需要系统地观察循环如何进行。继续执行 `step` 和 `print i`，观察循环变量的递增。

**调试命令** (第11-28行，重复的 step/print i)：

```
step
print i
step
print i
step
print i
step
print i
...（共累计到i=4）
```

**执行结果** (stdout关键片段)：

```
(tinydbg) 0
(tinydbg) 1
(tinydbg) 2
(tinydbg) 3
```

**AI观察**：

- 循环变量依次为：0, 1, 2, 3
- 这些值都在数组范围 `[0, 4]` 内（因为数组长度为5）
- 循环条件为 `i <= len(a)`，意味着还会执行 `i = 5` 的情况

##### 第七轮：触发异常

**AI推理**：根据循环条件 `i <= 5`，下一次循环应该会有 `i = 5` 的情况。这会导致访问 `a[5]`，超出数组界限。为了看到异常，应该执行 `continue`（继续执行直到异常或程序结束）。

**调试命令** (第29行)：

```
continue
```

**执行结果** (stdout关键片段)：

```
(tinydbg) > [unrecovered-panic] runtime.fatalpanic() /home/zhangjie/.goenv/sdk/go1.24.6/src/runtime/panic.go:1301 
(hits goroutine(1):1 total:1) (PC: 0x43da84)
Warning: debugging optimized function
	runtime.curg._panic.arg: interface {}(string) "runtime error: index out of range [5] with length 5"
  1296:	// fatalpanic implements an unrecoverable panic. It is like fatalthrow, except
  1297:	// that if msgs != nil, fatalpanic also prints panic messages and decrements
  1298:	// runningPanicDefers once main is blocked from exiting.
  ...
=>1301:	func fatalpanic(msgs *_panic) {
```

**AI诊断**：

- 程序已捕获到panic异常
- 异常信息：`runtime error: index out of range [5] with length 5`
- 这正好对应 `i = 5` 时访问 `a[5]` 的情况
- 根本原因：循环条件应该是 `i < len(a)` 而非 `i <= len(a)`

##### 第八轮：退出调试器

**AI结论**：Bug已定位，无需继续调试。

**调试命令** (第30行)：

```
exit
```

---

### 完整的调试文件内容

#### stdin.txt - 调试命令序列

```
break main.main
continue
print a
step
print a
step
print a
step
print i
step
print i
step
print i
step
print i
step
print i
step
print i
step
print i
step
print i
step
print i
continue
print i
exit
```

#### stdout.txt - 调试器输出（完整）

```
Type 'help' for list of commands.
(tinydbg) Breakpoint 1 set at 0x4b1af3 for main.main() ./main.go:5
(tinydbg) > [Breakpoint 1] main.main() ./main.go:5 (hits goroutine(1):1 total:1) (PC: 0x4b1af3)
     1:	package main
     2:
     3:	import "fmt"
     4:
=>   5:	func main() {
     6:		a := []int{1, 2, 3, 4, 5}
     7:		sum := 0
     8:		for i := 0; i <= len(a); i++ {  // Bug: loop condition should be i < len(a) to avoid index out of range
     9:			sum += a[i]
    10:		}
(tinydbg) (tinydbg) > main.main() ./main.go:6 (PC: 0x4b1afa)
     1:	package main
     2:
     3:	import "fmt"
     4:
     5:	func main() {
=>   6:		a := []int{1, 2, 3, 4, 5}
     7:		sum := 0
     8:		for i := 0; i <= len(a); i++ {  // Bug: loop condition should be i < len(a) to avoid index out of range
     9:			sum += a[i]
    10:		}
    11:		fmt.Println("Sum:", sum)
(tinydbg) (tinydbg) > main.main() ./main.go:7 (PC: 0x4b1b75)
     2:
     3:	import "fmt"
     4:
     5:	func main() {
     6:		a := []int{1, 2, 3, 4, 5}
=>   7:		sum := 0
     8:		for i := 0; i <= len(a); i++ {  // Bug: loop condition should be i < len(a) to avoid index out of range
     9:			sum += a[i]
    10:		}
    11:		fmt.Println("Sum:", sum)
     12:	}
(tinydbg) []int len: 5, cap: 5, [1,2,3,4,5]
(tinydbg) > main.main() ./main.go:8 (PC: 0x4b1b7e)
     3:	import "fmt"
     4:
     5:	func main() {
     6:		a := []int{1, 2, 3, 4, 5}
     7:		sum := 0
=>   8:		for i := 0; i <= len(a); i++ {  // Bug: loop condition should be i < len(a) to avoid index out of range
     9:			sum += a[i]
    10:		}
     11:		fmt.Println("Sum:", sum)
     12:	}
(tinydbg) (tinydbg) > main.main() ./main.go:9 (PC: 0x4b1b9c)
     4:
     5:	func main() {
     6:		a := []int{1, 2, 3, 4, 5}
     7:		sum := 0
     8:		for i := 0; i <= len(a); i++ {  // Bug: loop condition should be i < len(a) to avoid index out of range
=>   9:			sum += a[i]
    10:		}
     11:		fmt.Println("Sum:", sum)
     12:	}
(tinydbg) 0
(tinydbg) > main.main() ./main.go:8 (PC: 0x4b1bc8)
     3:	import "fmt"
     4:
     5:	func main() {
     6:		a := []int{1, 2, 3, 4, 5}
     7:		sum := 0
=>   8:		for i := 0; i <= len(a); i++ {  // Bug: loop condition should be i < len(a) to avoid index out of range
     9:			sum += a[i]
    10:		}
     11:		fmt.Println("Sum:", sum)
     12:	}
(tinydbg) (tinydbg) > main.main() ./main.go:9 (PC: 0x4b1b9c)
     4:
     5:	func main() {
     6:		a := []int{1, 2, 3, 4, 5}
     7:		sum := 0
     8:		for i := 0; i <= len(a); i++ {  // Bug: loop condition should be i < len(a) to avoid index out of range
=>   9:			sum += a[i]
    10:		}
     11:		fmt.Println("Sum:", sum)
     12:	}
(tinydbg) 1
(tinydbg) > main.main() ./main.go:8 (PC: 0x4b1bc8)
     3:	import "fmt"
     4:
     5:	func main() {
     6:		a := []int{1, 2, 3, 4, 5}
     7:		sum := 0
=>   8:		for i := 0; i <= len(a); i++ {  // Bug: loop condition should be i < len(a) to avoid index out of range
     9:			sum += a[i]
    10:		}
     11:		fmt.Println("Sum:", sum)
     12:	}
(tinydbg) (tinydbg) > main.main() ./main.go:9 (PC: 0x4b1b9c)
     4:
     5:	func main() {
     6:		a := []int{1, 2, 3, 4, 5}
     7:		sum := 0
     8:		for i := 0; i <= len(a); i++ {  // Bug: loop condition should be i < len(a) to avoid index out of range
=>   9:			sum += a[i]
    10:		}
     11:		fmt.Println("Sum:", sum)
     12:	}
(tinydbg) 2
(tinydbg) > main.main() ./main.go:8 (PC: 0x4b1bc8)
     3:	import "fmt"
     4:
     5:	func main() {
     6:		a := []int{1, 2, 3, 4, 5}
     7:		sum := 0
=>   8:		for i := 0; i <= len(a); i++ {  // Bug: loop condition should be i < len(a) to avoid index out of range
     9:			sum += a[i]
    10:		}
     11:		fmt.Println("Sum:", sum)
     12:	}
(tinydbg) (tinydbg) > main.main() ./main.go:9 (PC: 0x4b1b9c)
     4:
     5:	func main() {
     6:		a := []int{1, 2, 3, 4, 5}
     7:		sum := 0
     8:		for i := 0; i <= len(a); i++ {  // Bug: loop condition should be i < len(a) to avoid index out of range
=>   9:			sum += a[i]
    10:		}
     11:		fmt.Println("Sum:", sum)
     12:	}
(tinydbg) 3
(tinydbg) > main.main() ./main.go:8 (PC: 0x4b1bc8)
     3:	import "fmt"
     4:
     5:	func main() {
     6:		a := []int{1, 2, 3, 4, 5}
     7:		sum := 0
=>   8:		for i := 0; i <= len(a); i++ {  // Bug: loop condition should be i < len(a) to avoid index out of range
     9:			sum += a[i]
     10:		}
     11:		fmt.Println("Sum:", sum)
     12:	}
(tinydbg) (tinydbg) > [unrecovered-panic] runtime.fatalpanic() /home/zhangjie/.goenv/sdk/go1.24.6/src/runtime/panic.go:1301 (hits goroutine(1):1 total:1) (PC: 0x43da84)
Warning: debugging optimized function
	runtime.curg._panic.arg: interface {}(string) "runtime error: index out of range [5] with length 5"
  1296:	// fatalpanic implements an unrecoverable panic. It is like fatalthrow, except
  1297:	// that if msgs != nil, fatalpanic also prints panic messages and decrements
  1298:	// runningPanicDefers once main is blocked from exiting.
  1299:	//
  1300:	//go:nosplit
=>1301:	func fatalpanic(msgs *_panic) {
  1302:		pc := sys.GetCallerPC()
  1303:		sp := sys.GetCallerSP()
  1304:		gp := getg()
  1305:		var docrash bool
  1306:		// Switch to the system stack to avoid any stack growth, which
(tinydbg) exit
```

#### stderr.txt - 错误输出（关键失败案例）

```
Command failed: could not find symbol value for a
Command failed: could not find symbol value for a
Command failed: could not find symbol value for i
Command failed: could not find symbol value for i
Command failed: could not find symbol value for i
Command failed: could not find symbol value for i
Command failed: could not find symbol value for i
```

**说明**：前两条错误是因为在变量完全初始化前尝试打印。后续的错误是在循环条件判断时尝试打印尚未进入循环体的 `i`。

---

### AI Agent的ReAct推理框架

在实际的LLM驱动调试中，AI Agent需要遵循ReAct（Reasoning + Acting）模式：

#### 推理阶段（Reasoning）

```
当前调试状态观测：
- 执行位置：main.go:6 （`a := []int{1, 2, 3, 4, 5}`）
- 可获取信息：源代码视图，当前指令指针
- 不可获取：变量 a 的值（尚未赋值）

推理：
Q: 我想了解程序的初始数据结构？
A: 需要让 a 完成赋值，然后用 print 命令查看其值。

决策：下一步应该执行 step，推进到下一行。
```

#### 行动阶段（Acting）

```
执行 step 命令→调试器输出新位置→回到推理阶段

此时观测：
- 执行位置：main.go:7 （`sum := 0`）
- 新增信息：a 已赋值

再次推理：
现在可以尝试 print a 了。

执行 print a 命令→调试器输出 [1,2,3,4,5]→回到推理阶段
```

#### 完整的推理轨迹

```
初始状态: 函数入口
    ↓ [print a] → 失败（未初始化）
学习: 需要 step 进行初始化
    ↓ [step]
状态: a 声明行
    ↓ [step]
状态: sum 初始化
    ↓ [print a] → 成功，得到 [1,2,3,4,5]
学习: 数组长度为5
    ↓ [step] × 多次 + [print i]
状态: 循环迭代中，i 递增 0→1→2→3
学习: 循环正常进行中
    ↓ [continue]
异常: runtime error: index out of range [5] with length 5
诊断: 循环条件 i <= len(a) 导致 i=5 时索引越界
  
根本原因: 循环条件应为 i < len(a)
```

---

### 关键技术要点

#### 1. 行缓冲与同步

调试器的I/O是行缓冲的（line-buffered），这意味着：

- 调试器从stdin读取一行
- 处理该命令
- 将输出写入stdout（通常包含多行）
- 重复

AI Agent需要考虑这种缓冲特性，不能假设命令与响应是原子操作。

#### 2. 变量生命周期

在启用了优化的Go程序中，变量在其作用域之外可能不存在。这导致：

```go
func main() {
    a := []int{...}   // ← a 在这里才真正存在
    // 即使调试器停在函数入口，a 也可能不可访问
}
```

AI Agent需要理解这一点，不能过早地查询变量。

#### 3. 断点与单步的区别

- **`continue`**：在当前点恢复执行，直到遇到下一个断点或异常
- **`step`**：执行单条语句，然后停下
- **`stepin` vs `stepout`**：函数调用时的选择

不同的策略适用于不同的调试场景。

#### 4. 异常处理

当程序触发panic时，调试器会捕获该异常点，并进入"paused at panic"状态。AI Agent可以：

- 检查panic信息
- 回溯call stack
- 定位触发panic的确切位置

---

### 实现AI Agent的建议

#### 伪代码框架

```python
class AutoDebugger:
    def __init__(self, program, llm_client):
        self.program = program
        self.llm = llm_client
        self.commands_history = []
        self.outputs_history = []
      
    def run_debugging_session(self):
        # 1. 启动调试器进程
        self.start_debugger()
      
        # 2. 多轮推理与行动
        for round in range(MAX_ITERATIONS):
            # 2.1 收集当前调试器输出
            current_output = self.read_latest_output()
          
            # 2.2 调用LLM进行推理
            reasoning = self.llm.reason(
                program_code=self.get_source(),
                debugging_output=current_output,
                history=self.outputs_history,
                objective="Locate the bug in this program"
            )
          
            # 2.3 从LLM推理结果提取下一步命令
            next_command = self.llm.extract_command(reasoning)
          
            # 2.4 如果LLM判定bug已找到或应该退出
            if next_command == "exit" or self.llm.is_bug_found(reasoning):
                self.send_command("exit")
                break
          
            # 2.5 发送命令到调试器
            self.send_command(next_command)
            self.commands_history.append(next_command)
          
            # 2.6 等待响应
            time.sleep(RESPONSE_DELAY)
          
        # 3. 收集完整的调试记录
        self.save_session_records()
      
    def send_command(self, cmd):
        """追加命令到stdin"""
        self.stdin_file.write(cmd + "\n")
        self.stdin_file.flush()
      
    def read_latest_output(self):
        """读取最新的调试输出"""
        return self.read_file("stdout.txt")
```

#### LLM Prompt模板

```
You are an expert Go debugger. Given the following:
- Program source code
- Current debugger state (output)
- Debugging history

Analyze the program and the current debugging status. Then:

1. Explain what you observe in the current state
2. Identify what you still need to know to locate the bug
3. Decide the next debugging action (step, continue, print, etc.)
4. Provide the exact command to send to the debugger

Format your response as JSON:
{
    "observation": "...",
    "reasoning": "...",
    "next_command": "step" or "continue" or "print <var>" or "break <loc>",
    "bug_found": true/false,
    "bug_description": "..."  # if bug_found is true
}
```

---

### 性能与优化

#### 优化指标

1. **收敛速度**：达到bug定位需要的轮次
2. **命令精确性**：AI生成的有效命令占比
3. **误判率**：错误的bug假设占比

#### 优化策略

1. **智能断点**：根据程序结构自动设置关键断点，而非只用 `main`
2. **状态缓存**：缓存已检查过的程序状态，避免重复查询
3. **并行探索**：维护多个假设，并并行调试验证
4. **领域特定知识**：针对常见bug类型（NPE、OOB、race condition等）预设策略

---

### 局限性和未来方向

#### 当前局限

1. **复杂并发场景**：多goroutine的race condition仍难以定位
2. **非确定性bug**：timing-dependent的问题难以稳定复现
3. **黑盒库代码**：无源码的依赖库中的bug难以调试
4. **大规模程序**：程序超大时，状态空间爆炸

#### 未来方向

1. **混合符号执行**：结合静态分析和动态调试
2. **程序合成**：自动生成测试用例和补丁
3. **多模态推理**：结合代码的AST、CFG等结构信息
4. **分布式调试**：扩展到微服务和分布式系统

---

### 总结

将LLM与调试器I/O重定向相结合，开启了自动化调试的新时代：

1. **机制简单**：只需标准的stdin/stdout重定向，对debugger无改动
2. **效果显著**：从手动多轮交互简化为自动推理循环
3. **可扩展**：原理适用于任何支持I/O重定向的调试工具
4. **可分析**：完整的调试历史便于事后分析和学习

这种方法充分发挥了LLM的强项——逻辑推理和模式识别——彻底改变调试这一"体力活"，释放开发者的生产力。

---

### 参考资源

- tinydbg项目：https://github.com/hitzhangjie/tinydbg
- Delve调试器：https://github.com/go-delve/delve
- ReAct论文：https://arxiv.org/abs/2210.03629
- Go调试惯例：https://golang.org/doc/gdb

---

**结语**：自动化调试不再是梦想，而是可以立刻付诸实践的技术。关键在于充分利用AI的推理能力，与传统工具的可靠性相结合。
