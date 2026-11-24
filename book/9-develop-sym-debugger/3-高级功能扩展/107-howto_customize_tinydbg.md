## 配置系统设计（godbgv2 未实现）

> **状态**：godbgv2 未实现（❌）。本节为扩展阅读，设计思路可迁移，代码不并入本仓。
> 能力状态以 `godbgv2/docs/FEATURE-MATRIX.md` 为准。

一个交互式调试器的“配置系统”通常要解决三件事：把用户偏好**存**下来（配置文件）、让用户能**看和改**（`config` 命令）、把配置**用**到调试行为上（别名、源码路径映射、变量显示上限、配色……）。delve 有一整套成熟实现；godbgv2 目前没有，它只有 cobra 的命令行 flag。

本节以 delve 为参照拆解这套设计，最后给出 godbgv2 的现状和落地清单。需要先声明：**本节不是“godbgv2 的配置系统”**，godbgv2 没有任何配置持久化能力，所有配置项清单都按“delve 的口径”叙述。

### godbgv2 现状：只有 cobra flag

**没有 `config` 命令**。`godbg --help` 的顶层子命令只有 attach、connect、core、debug、exec（外加 cobra 自带的 completion/help 与 version），没有任何配置入口。

**全局配置只有 flag**（`cmd/root.go`）：

| flag | 作用 |
|---|---|
| `-v, --verbose` | 输出更详细的信息 |
| `--init <file>` | 回放启动脚本（批量模式），逐行执行后退出 |
| `--log` | 打开调试日志 |
| `--log-output <file>` | 日志写入文件而不是 stderr |
| `--headless` | 以调试服务端模式运行 |
| `--listen <addr>` | headless 监听地址，默认 `127.0.0.1:0` |

子命令各自还有少量 flag：`exec`/`debug` 的 `--disable-aslr`、`attach` 的 `--waitfor`、`break` 的 `-n/--name`、`disass` 的 `-s/--syntax`、`pmem` 的 `--fmt`。它们都是一次性的：不保存、不继承，下次启动要重新敲一遍。

**没有 `pkg/config`**。仓库里不存在这个包；`Makefile:54` 与 `docs/ARCH-RULES.md:12` 的 import 白名单里却写着 `pkg/config`，属于超前声明，`godbgv2/docs/FEATURE-MATRIX.md` §11③ 已把它记为待修。

**没有配置文件读写，也没有配置项的概念**。`--init` 不是配置：它把脚本逐行喂给会话执行、回放完就退出（`cmd/debug/shell.go` 的 `replay`），面向的是冒烟测试，而不是记住用户偏好。

### delve 的 `config` 命令

delve 提供了以下配置命令（实现在 `pkg/terminal/config.go`）：

1. `config -list`: 列出所有可用的配置项及其当前值
2. `config -save`: 将当前配置保存到配置文件
3. `config <name> <value>`: 设置指定配置项的值

有一部分配置项还有自己的子命令形态，比如 `config substitute-path ...`、`config debug-info-directories ...`，因为它们的值不是单个标量而是规则列表。

### delve 的配置项参考

下表是 delve `Config` 结构体里的字段（`pkg/config/config.go`），原样列出是为了看清一个交互式调试器**需要**配置哪些东西；这些配置项在 godbgv2 里都不存在：

| 配置项 | 作用 | 默认值 / 取值 |
|---|---|---|
| `aliases` | 命令别名，与内置别名合并 | `{command: [alias...]}` |
| `substitute-path` | 重写调试信息里存的源码路径 | 规则列表 `{from, to}` |
| `max-string-len` | 打印字符串时读取的最大长度 | 64 |
| `max-array-values` | 打印数组时读取的最大元素数 | 64 |
| `max-variable-recurse` | 嵌套结构体/数组/指针的展开深度 | 1 |
| `disassemble-flavor` | 反汇编语法风格 | `intel`（可选 `gnu`、`go`） |
| `show-location-expr` | `whatis` 是否打印参数的 DWARF 位置表达式 | `false` |
| `source-list-line-color` | 源码行号颜色 | ANSI 颜色 |
| `source-list-arrow-color` | 源码箭头颜色 | ANSI 颜色 |
| `source-list-keyword-color` | 源码关键字颜色 | ANSI 颜色 |
| `source-list-string-color` | 源码字符串颜色 | ANSI 颜色 |
| `source-list-number-color` | 源码数字颜色 | ANSI 颜色 |
| `source-list-comment-color` | 源码注释颜色 | ANSI 颜色 |
| `source-list-tab-color` | 源码制表符颜色 | ANSI 颜色 |
| `prompt-color` | 提示符颜色 | ANSI 颜色 |
| `stacktrace-function-color` | 栈帧中函数名的颜色 | ANSI 颜色 |
| `stacktrace-basename-color` | 栈帧中文件名（basename）的颜色 | ANSI 颜色 |
| `source-list-line-count` | `list` 在当前位置上下各显示的行数 | 5 |
| `position` | 停止后显示源码还是反汇编 | `default`（`source`/`disassembly`） |
| `tab` | 源码里的 `\t` 显示成什么 | `"\t"` |
| `debug-info-directories` | 分离调试文件的搜索目录 | `["/usr/lib/debug/.build-id"]` |
| `prompt` | 提示符模板，支持 `$d`/`$f`/`$g`/`$t`/`$p` | 空（用内置提示符） |

默认值来自 `config.yml` 的默认模板和各 `Get*` 方法，例如 `GetSourceListLineCount()` 在未配置时返回 5（`pkg/config/config.go:195`）。

### 配置文件的位置（delve 的规则）

配置文件是 `config.yml`，目录名是 `dlv`：

1. 如果设置了 `XDG_CONFIG_HOME` 环境变量：`$XDG_CONFIG_HOME/dlv/config.yml`
2. 在 Linux 系统上：`$HOME/.config/dlv/config.yml`
3. 其他系统：`$HOME/.dlv/config.yml`

规则集中在 `GetConfigFilePath`（`pkg/config/config.go:420`），目录名由常量 `configDir = "dlv"` 与 `configDirHidden = ".dlv"` 决定。delve 还会把旧位置 `$HOME/.dlv` 下的配置**迁移**到新位置（`moveOldConfig`），迁移时在 stderr 打一行提示。

如果自己写一个调试器，照这个结构搬即可，只要把 `dlv` 换成自己的名字；路径选择逻辑本身没什么可创新的，遵循 XDG 规范就好。

### 配置实现细节（delve 侧）

#### 配置加载

`LoadConfig()`（`pkg/config/config.go:219`）：

1. 先确保配置目录存在（`createConfigPath`，`os.MkdirAll(..., 0700)`）；
2. 检查是否有旧位置的配置，有就迁移；
3. 打开 `config.yml`，不存在则用 `createDefaultConfig` 写一份**带注释的默认配置**；
4. `yaml.Unmarshal` 到 `Config` 结构体；
5. 空值补默认：`debug-info-directories` 为空时补 `["/usr/lib/debug/.build-id"]`。

#### 配置应用

1. **命令别名**：`cmds.Merge(conf.Aliases)` 把用户别名合并进命令系统（`pkg/terminal/terminal.go:109`），用户就能用自定义的短命令；
2. **路径替换**：`substitutePath()`（同文件 `:477`）在查源码位置时按规则重写路径，规则本身由 `locspec.SubstitutePath` 应用，保证源码搬到别处后仍能找到文件；
3. **变量加载限制**：`loadConfig()`（`:620`）把 `max-*` 转换成 `api.LoadConfig`，影响 `print`、`locals`、`args` 等命令读取变量时的字符串长度、数组元素数、递归深度；
4. **显示设置**：颜色、行数、`position`、`tab` 在终端输出层生效——源码列表、栈帧、提示符分别取自己的配置项。

#### 配置保存

`SaveConfig()`（`pkg/config/config.go:273`）把 `Config` 序列化成 YAML 后 `os.Create` 覆写配置文件，`config -save` 调的就是它。要注意它是**整体覆写**：用户手写在 `config.yml` 里的注释会丢失。如果在意这一点，可以让 `-save` 只回写被修改过的键，或者干脆不在默认配置里写注释。

### 使用示例（delve）

1. 设置命令别名：
```
config alias print p
config alias next n
```

2. 配置源代码路径替换：
```
config substitute-path /original/path /new/path
```

3. 调整变量显示限制：
```
config max-string-len 128
config max-array-values 100
config max-variable-recurse 2
```

4. 自定义显示设置：
```
config source-list-line-count 10
config disassemble-flavor gnu
```

### 如果 godbgv2 要做：落地清单（未实现）

1. **先有 `pkg/config`，再谈 `config` 命令**。一个 YAML 结构体加 `LoadConfig`/`SaveConfig` 就能起步；`Makefile` 与 `ARCH-RULES` 的 import 白名单已经预留了 `pkg/config`，把这个包补上正好消掉那处超前声明。
2. **优先级要定死**：flag > 环境变量 > 配置文件 > 内置默认。同时 `--init` 回放与 smoke 测试必须在隔离的 `HOME`/`XDG_CONFIG_HOME` 下跑，否则开发机上的配置会让 CI 结果漂移。
3. **输出层收口**：颜色类配置必须落在 `pkg/terminal`（架构铁律：`cmd/` 之外的包不得打印），这与 102 讲的 colorize 是同一处改造点。
4. **先做性价比高的几项**：`aliases`、`source-list-line-count`、`disassemble-flavor`（`disass` 已有 `-s`，把默认值接上即可）、`max-string-len`/`max-array-values`（`print` 已有变量读取，加个上限即可）。
5. **路径替换放后面**：`substitute-path` 依赖 105 的路径映射，等 locspec 那套解析稳定后再接。
6. **失败路径也要设计**：配置语法错误、目录不可写、未知配置项都要有明确报错；`config -list` 的默认值应当取自结构体，而不是另抄一份表。

### 小结

配置系统是“用户顺手”和“结果可复现”之间的折中。delve 用 `config.yml` + `config` 命令 + `pkg/config` 把**存储、入口、应用**三件事拆得很清楚，这套结构值得照着设计，代码则按本书的净室约定自己写。godbgv2 目前只有 cobra flag，没有 `pkg/config`、没有配置持久化、没有 `config` 命令；在 `godbgv2/docs/FEATURE-MATRIX.md` 里，它与语法高亮、分页、transcript 一起被记为 ❌，属于“知道该怎么做、但还没做”的那一类，也是 9.3 这一批扩展阅读里最容易被误读成“已经实现”的一节。
