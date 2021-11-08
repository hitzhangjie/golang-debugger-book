## 查看进程状态

### 实现目标：pregs查看寄存器

这一小节，我们来实现pregs命令，方便调试进程时查看进程寄存器数据。

### 代码实现

查看进程寄存器数据，需要通过`ptrace(PTRACE_GETREGS,...)`操作就可以获取被调试进程上下文所有的寄存器列表及其数据。

**file: cmd/debug/pregs.go**

```go
package debug

import (
	"fmt"
	"os"
	"reflect"
	"syscall"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

var pregsCmd = &cobra.Command{
	Use:   "pregs",
	Short: "打印寄存器数据",
	Annotations: map[string]string{
		cmdGroupKey: cmdGroupInfo,
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		regsOut := syscall.PtraceRegs{}
		err := syscall.PtraceGetRegs(TraceePID, &regsOut)
		if err != nil {
			return fmt.Errorf("get regs error: %v", err)
		}
		prettyPrintRegs(regsOut)
		return nil
	},
}

func init() {
	debugRootCmd.AddCommand(pregsCmd)
}

func prettyPrintRegs(regs syscall.PtraceRegs) {
	w := tabwriter.NewWriter(os.Stdout, 0, 8, 4, ' ', 0)
	rt := reflect.TypeOf(regs)
	rv := reflect.ValueOf(regs)
	for i := 0; i < rv.NumField(); i++ {
		fmt.Fprintf(w, "Register\t%s\t%#x\t\n", rt.Field(i).Name, rv.Field(i).Uint())
	}
	w.Flush()
}
```

程序首先通过ptrace获取寄存器数据，然后通过prettyPrintRegs打印寄存器信息，prettyPrintRegs函数使用了tabwriter对分列展示的寄存器数据进行格式化输出。

### 代码测试

首先启动一个测试程序充当被调试进程，获取其pid，然后通过`godbg attach <pid>`对目标进程进行调试。等调试会话准别就绪后，输入命令pregs查看寄存器信息。

```bash
$ godbg attach 116
process 116 attached succ
process 116 stopped: true
godbg> pregs
Register    R15         0x400                 
Register    R14         0x3                   
Register    R13         0xa                   
Register    R12         0x4be86f              
Register    Rbp         0x7ffc5095bd50        
Register    Rbx         0x555900              
Register    R11         0x286                 
Register    R10         0x0                   
Register    R9          0x0                   
Register    R8          0x0                   
Register    Rax         0xfffffffffffffe00    
Register    Rcx         0x464fc3              
Register    Rdx         0x0                   
Register    Rsi         0x80                  
Register    Rdi         0x555a48              
Register    Orig_rax    0xca                  
Register    Rip         0x464fc3              
Register    Cs          0x33                  
Register    Eflags      0x286                 
Register    Rsp         0x7ffc5095bd08        
Register    Ss          0x2b                  
Register    Fs_base     0x555990              
Register    Gs_base     0x0                   
Register    Ds          0x0                   
Register    Es          0x0                   
Register    Fs          0x0                   
Register    Gs          0x0                   
godbg> 
```

我们看到pregs命令显示了三列数据：

-   第1列统一为Register，没有什么特殊含义，只是为了可读性和美观性；
-   第2列为寄存器名称，为了美观采用了左对齐；
-   第3列为寄存器当前值，采用16进制数打印，为了美观采用了左对齐；

调试时有时是有需要查看、修改寄存器状态的，比如查看、修改返回值，我们通常可以修改rax寄存器的值来实现。