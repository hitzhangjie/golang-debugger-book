## Attach WaitFor 工作原理

### 简介

在调试进程时，我们经常需要等待目标进程启动后再附加调试器。`waitfor` 机制提供了一种灵活的方式来等待进程启动，它通过匹配进程名称前缀来实现。本文将详细解释这个功能在调试器中是如何工作的。

```bash
```bash
$ tinydbg help attach
Attach to an already running process and begin debugging it.

This command will cause Delve to take control of an already running process, and
begin a new debug session.  When exiting the debug session you will have the
option to let the process continue or kill it.

Usage:
  tinydbg attach pid [executable] [flags]

Flags:
      --continue                 Continue the debugged process on start.
  -h, --help                     help for attach
      --waitfor string           Wait for a process with a name beginning with this prefix
      --waitfor-duration float   Total time to wait for a process
      --waitfor-interval float   Interval between checks of the process list, in millisecond (default 1)
      ...
```

### 为什么需要 WaitFor

在以下场景中，我们需要等待进程：

1. **进程启动时序**：
   - 调试时需要确保目标进程已经运行
   - 直接附加到不存在的进程会导致失败
   - WaitFor 确保只在进程就绪后才进行附加

2. **进程名称匹配**：
   - 有时我们只知道进程名称前缀，而不是具体的 PID
   - WaitFor 允许通过名称前缀匹配进程
   - 这提供了更灵活的进程选择方式

3. **超时控制**：
   - 等待进程启动需要设置合理的超时时间
   - WaitFor 提供了检查间隔和最大等待时间参数
   - 这可以防止无限等待，并提供细粒度的控制

### 实现细节

#### 核心数据结构

WaitFor 机制使用一个简单的结构体实现：

```go
type WaitFor struct {
    Name               string        // 要匹配的进程名称前缀
    Interval, Duration time.Duration // 检查间隔和最大等待时间
}
```

#### 主要实现

核心功能在 `native` 包中实现：

```go
func WaitFor(waitFor *proc.WaitFor) (int, error) {
    t0 := time.Now()
    seen := make(map[int]struct{})
    for (waitFor.Duration == 0) || (time.Since(t0) < waitFor.Duration) {
        pid, err := waitForSearchProcess(waitFor.Name, seen)
        if err != nil {
            return 0, err
        }
        if pid != 0 {
            return pid, nil
        }
        time.Sleep(waitFor.Interval)
    }
    return 0, errors.New("waitfor duration expired")
}
```

#### 进程搜索实现

进程搜索通过以下步骤实现：

1. 遍历 `/proc` 目录查找匹配的进程
2. 读取进程的 `cmdline` 文件获取其名称
3. 使用 map 记录已检查过的进程
4. 通过名称前缀匹配进程

以下是实现的关键部分：

```go
func waitForSearchProcess(pfx string, seen map[int]struct{}) (int, error) {
    des, err := os.ReadDir("/proc")
    if err != nil {
        return 0, nil
    }
    for _, de := range des {
        if !de.IsDir() {
            continue
        }
        name := de.Name()
        if !isProcDir(name) {
            continue
        }
        pid, _ := strconv.Atoi(name)
        if _, isseen := seen[pid]; isseen {
            continue
        }
        seen[pid] = struct{}{}
        buf, err := os.ReadFile(filepath.Join("/proc", name, "cmdline"))
        if err != nil {
            continue
        }
        // 将空字节转换为空格以便字符串比较
        for i := range buf {
            if buf[i] == 0 {
                buf[i] = ' '
            }
        }
        if strings.HasPrefix(string(buf), pfx) {
            return pid, nil
        }
    }
    return 0, nil
}
```

#### 与调试器集成

WaitFor 机制集成到调试器的附加功能中：

```go
func Attach(pid int, waitFor *proc.WaitFor) (*proc.TargetGroup, error) {
    if waitFor.Valid() {
        var err error
        pid, err = WaitFor(waitFor)
        if err != nil {
            return nil, err
        }
    }
    // ... 附加实现的其他部分
}
```

### 命令行支持

调试器为 WaitFor 提供了几个命令行选项：

- `--waitfor`：指定要等待的进程名称前缀
- `--waitfor-interval`：设置检查间隔（毫秒）
- `--waitfor-duration`：设置最大等待时间

使用示例：
```bash
## 等待名为 "myapp" 的进程启动
debugger attach --waitfor myapp --waitfor-interval 100 --waitfor-duration 10
```

### 代码示例

以下是使用 WaitFor 的完整示例：

```go
// 创建 WaitFor 配置
waitFor := &proc.WaitFor{
    Name: "myapp",
    Interval: 100 * time.Millisecond,
    Duration: 10 * time.Second,
}

// 等待进程并附加
pid, err := native.WaitFor(waitFor)
if err != nil {
    return err
}

// 附加到目标进程
target, err := native.Attach(pid, nil)
if err != nil {
    return err
}
```

### 总结

WaitFor 机制为调试场景中的进程附加提供了可靠的方式。它确保我们只附加到实际运行的进程，并在如何识别目标进程方面提供了灵活性。该实现高效且与调试器的其他功能良好集成。

### 参考资料

1. Linux `/proc` 文件系统文档
2. Go 标准库 `os` 包文档
3. 调试器源码 `pkg/proc/native` 包 