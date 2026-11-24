## attach --waitfor：等待目标进程出现

> ps：本书早期稿件曾以 tinydbg 为示例，自本节起统一以 godbgv2 项目的 `godbg` 二进制为准。

### 实现目标

`godbg attach <pid> --waitfor` 处理的是“调试器比目标进程先到”的时序问题。`--waitfor` 是一个布尔开关：打开后，`godbg` 在真正发起 attach 之前，反复探测命令行给出的那个 pid 是否已经存在，直到它出现才往下走。

```bash
$ ./godbg attach --help
跟踪正在运行的进程（--waitfor：等待目标进程出现后再跟踪）

Usage:
  godbg attach <pid> [--waitfor] [flags]

Flags:
      --waitfor   等待目标进程出现后再跟踪（ch9.2.12）
```

这个开关的语义比“按名字等进程”窄得多，有三点先说清楚：

- 等待对象是调用方给出的**确定 pid**，不是进程名、也不是名字前缀。想等“某个名字的程序”，得先在 shell 侧用 `pgrep -x name` 之类把 pid 算出来；
- 只有 `attach` 有它（`cmd/attach.go:56`）。`exec`、`debug` 自己创建进程，“等进程出现”对它们没有意义；
- 等到之后走的还是 9.2.11 那套 attach：`PTRACE_ATTACH` 接管全部线程，停止原因是 `SIGSTOP`。

不带 `--waitfor` 时，目标不存在就直接失败（`Error: process 999999 not existed`，来自目标层的 `checkPid`）；`--waitfor` 就是把这个“立刻失败”换成“等到出现再试”。

### 基础知识

`processExists` 只有一行，用的是 signal 0 这个古老的探测手法：

```go
// cmd/attach.go:60-62
func processExists(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}
```

`kill(pid, 0)` 不投递任何信号，内核只做两件事：查这个 pid 在当前 pid 命名空间里有没有进程，以及调用者有没有权限向它发信号。返回 `nil` 表示“存在且可操作”，`ESRCH` 表示不存在，`EPERM` 表示存在但没权限。

这行代码把 `EPERM` 也算成“不存在”，后果在测试里会看到：非 root 用户 `kill -0 1` 得到 EPERM，于是 `godbg attach 1 --waitfor` 会一直等下去，尽管 pid 1 明明活着。写等待类功能时这是必须显式决定的语义选择——`processExists` 选的是“我能不能操作它”，而不是“它到底在不在”。

轮询间隔写死 100ms（`cmd/attach.go:31-33`），没有次数上限，也没有总时长上限。目标迟迟不出现时 `godbg` 会**永远等下去**，脚本里必须自己用 `timeout` 兜底（冒烟测试框架正是这么做的：`timeout -k 5 30`）。pid 又会被复用：内核在编号用完一圈后从头分配，等待窗口越长，“等到同号但不同程序”的概率越大——`--waitfor` 只保证此刻有该 pid 的进程存在，不保证它是你想调的那个。此外，它与 `PTRACE_ATTACH` 自身的竞态是两件事：等待结束那一刻进程可能刚好 exec 或刚好退出；attach 之后循环 wait 到 `SIGSTOP`、其间丢弃 post-exec `SIGTRAP` 的处理见附录 12.5、12.9。

### 代码实现

#### 1. 命令层：先等，再 attach

`cmd/attach.go` 的 `RunE` 只加了这一段：

```go
// cmd/attach.go:28-34
// --waitfor：目标进程可能尚未启动，轮询等待其出现（ch9.2.12）
if waitfor, _ := cmd.Flags().GetBool("waitfor"); waitfor {
	fmt.Printf("waiting for process %d to appear...\n", pid)
	for !processExists(pid) {
		time.Sleep(100 * time.Millisecond)
	}
}
```

两个细节。一是那句 `waiting for ...` 打在循环**外面**，即使目标已经存在也会先打印一行再立刻继续，从输出上分不清“等了多久”，只能看到“等过”。二是 `GetBool` 的错误被丢掉了：flag 在 `init()` 里注册、名字写死，取不到只可能是编程错误，命令层不值得为此加错误分支。注册同样朴素：`attachCmd.Flags().Bool("waitfor", false, "等待目标进程出现后再跟踪（ch9.2.12）")`（`cmd/attach.go:56`）。

#### 2. 等待发生在发起请求之前

`--waitfor` 完全在命令层完成，没有往下传。契约方法签名是 `Attach(pid int) ([]int, error)`（`pkg/service/api/client.go:38`），没有 waitfor 参数，`Debugger.Attach` 和 `target.AttachTargetProcess` 也都没有。这个分工是对的：等待是“什么时候发起请求”的策略，属于命令层；目标层只负责“请求来了就把进程接管住”。

#### 3. 能力边界

| 边界 | 现状 | 影响 |
|---|---|---|
| 按名字/前缀等待 | 不支持 | 需在 shell 侧换算成 pid |
| 超时 | 无 | pid 永不存在时死等，脚本必须 `timeout` |
| 轮询间隔 | 固定 100ms | 不可调，最坏多等 100ms 才 attach |
| 权限不足（EPERM） | 视作不存在 | 非 root 等 pid 1 会永远等 |
| pid 复用 | 未校验 | 等到同号的其他进程也会照常 attach |
| 其他命令 | 无此 flag | 只有 `attach` |

如果将来要支持“按名字等”，缺的是一段扫 `/proc` 的逻辑：遍历 `/proc/<pid>`、读 `comm`/`cmdline` 做前缀匹配、再用 `seen` 集合避免重复检查同一批进程。这段代码目前**不存在**，写在这里只是标明扩展位置。

### 执行测试

先看目标已经存在的情况：

```bash
$ ./_fixtures/loop2 &                 # 常驻的多线程调试目标
$ ./godbg attach $! --waitfor
waiting for process 1972545 to appear...
process 1972545 attached, stopped by SIGSTOP
thread 1972545 attached
thread 1972547 attached
...
godbg> threads
* Thread 1972545 at 0x4788a3 runtime.futex .../runtime/sys_linux_amd64.s:558
```

“等待”这句照样打印，但循环第一次判断就为真，实际没有 sleep。

要真正看到“等一个还不存在的 pid”，得让 pid 可预测。最省事的办法是新建一个 pid 命名空间：里面第一个进程是 pid 1，之后按 fork 顺序是 2、3、4……于是可以先让 `godbg` 等 pid 5，再制造出 pid 5（以下命令在 godbgv2 仓库根执行，CWD 会被 `unshare` 继承）：

```bash
$ unshare -U -p -f --mount-proc bash -c '
    ./godbg attach 5 --waitfor --init /tmp/init.txt > /tmp/wf.out 2>&1 &
    sleep 0.4 & sleep 0.4 &        # 占掉 pid 3、4
    sleep 30 &                     # 目标，拿到 pid 5
    wait; cat /tmp/wf.out'
waiting for process 5 to appear...
process 5 attached, stopped by SIGSTOP
thread 5 attached
godbg> threads
* Thread 5 at 0x7f4d08308068
godbg> exit
tracee is an attached process, leave it running
```

（`/tmp/init.txt` 里只有 `threads`、`exit` 两行，用 `--init` 回放；`unshare` 需要内核开启用户命名空间。）

再看两个边界。pid 永不存在时一直等，只能由外部 timeout 收场；pid 存在但没权限时同样一直等：

```bash
$ timeout 3 ./godbg attach 999999 --waitfor; echo "exit=$?"
waiting for process 999999 to appear...
exit=124
$ kill -0 1 2>/dev/null; echo $?      # 非 root：EPERM，退出码 1
1
$ timeout 2 ./godbg attach 1 --waitfor; echo "exit=$?"
waiting for process 1 to appear...
exit=124
```

`testdata/script` 下目前没有本节对应的冒烟脚本，以上输出均为手工实测。

### 本节小结

`--waitfor` 是只有几行的开关：布尔 flag，等待命令行给出的 pid 出现，用 `kill(pid, 0)` 探测、100ms 轮询、不设超时。它解决“pid 已知但进程还没起来”这一小段时序，代价是引入死等和 pid 复用两个风险，脚本里要自己加 `timeout`。实现放在命令层，`Attach` 契约不变；名称匹配、超时、间隔都**没有**实现。

下一节看 `exec`：不再等别人的进程，而是自己创建一个。
