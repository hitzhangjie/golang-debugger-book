## tinydbg 配置系统设计实现

tinydbg 提供了一个灵活的配置系统，允许用户根据自己的使用习惯自定义调试器的行为。本文将详细介绍配置系统的设计实现。

### 配置命令使用

tinydbg 提供了以下配置命令：

1. `config -list`: 列出所有可用的配置项及其当前值
2. `config -save`: 将当前配置保存到配置文件
3. `config <name> <value>`: 设置指定配置项的值

### 支持的配置项

tinydbg 支持以下配置项：

1. **命令别名 (aliases)**
   - 允许为命令创建别名
   - 例如：`config alias print p` 将 `p` 设置为 `print` 命令的别名

2. **源代码路径替换规则 (substitute-path)**
   - 用于重写程序调试信息中存储的源代码路径
   - 当源代码在编译和调试之间被移动到不同位置时特别有用
   - 支持以下操作：
     - `config substitute-path <from> <to>`: 添加替换规则
     - `config substitute-path <from>`: 删除指定规则
     - `config substitute-path -clear`: 清除所有规则
     - `config substitute-path -guess`: 自动猜测替换规则

3. **字符串长度限制 (max-string-len)**
   - 控制命令打印、locals、args 和 vars 时读取的最大字符串长度
   - 默认值：64

4. **数组值限制 (max-array-values)**
   - 控制命令打印、locals、args 和 vars 时读取的最大数组项数
   - 默认值：64

5. **变量递归深度 (max-variable-recurse)**
   - 控制嵌套结构体成员、数组和切片项以及解引用指针的输出评估深度
   - 默认值：1

6. **反汇编风格 (disassemble-flavor)**
   - 允许用户指定汇编输出的语法风格
   - 可选值："intel"(默认)、"gnu"、"go"

7. **位置表达式显示 (show-location-expr)**
   - 控制 whatis 命令是否打印其参数的 DWARF 位置表达式

8. **源代码列表颜色设置**
   - `source-list-line-color`: 源代码行号颜色
   - `source-list-arrow-color`: 源代码箭头颜色
   - `source-list-keyword-color`: 源代码关键字颜色
   - `source-list-string-color`: 源代码字符串颜色
   - `source-list-number-color`: 源代码数字颜色
   - `source-list-comment-color`: 源代码注释颜色
   - `source-list-tab-color`: 源代码制表符颜色

9. **其他显示设置**
   - `prompt-color`: 提示行颜色
   - `stacktrace-function-color`: 堆栈跟踪中函数名的颜色
   - `stacktrace-basename-color`: 堆栈跟踪中路径基本名称的颜色
   - `source-list-line-count`: 调用 printfile() 时在光标上下显示的行数
   - `position`: 控制程序当前位置的显示方式（source/disassembly/default）
   - `tab`: 控制源代码中遇到 '\t' 时打印的内容

### 配置文件存储

配置文件存储在以下位置：

1. 如果设置了 `XDG_CONFIG_HOME` 环境变量：
   - `$XDG_CONFIG_HOME/tinydbg/config.yml`

2. 在 Linux 系统上：
   - `$HOME/.config/tinydbg/config.yml`

3. 其他系统：
   - `$HOME/.tinydbg/config.yml`

### 配置实现细节

#### 配置加载

配置系统通过 `pkg/config/config.go` 中的 `LoadConfig()` 函数加载配置：

1. 首先检查并创建配置目录
2. 检查是否存在旧版本的配置文件，如果存在则迁移到新位置
3. 打开配置文件，如果不存在则创建默认配置
4. 使用 YAML 解析器将配置文件内容解析到 `Config` 结构体

#### 配置应用

配置在调试器中的主要应用点：

1. **命令别名**
   - 在 `DebugSession` 初始化时通过 `cmds.Merge(conf.Aliases)` 合并到命令系统中
   - 允许用户使用自定义的短命令

2. **路径替换**
   - 通过 `substitutePath()` 方法应用路径替换规则
   - 在查找源代码位置时使用，确保调试器能找到正确的源文件

3. **变量加载配置**
   - 通过 `loadConfig()` 方法将配置转换为 `api.LoadConfig`
   - 影响变量查看命令（如 print、locals、args 等）的行为
   - 控制字符串长度、数组大小和递归深度等限制

4. **显示设置**
   - 影响调试器的输出格式和颜色
   - 通过终端输出函数应用颜色设置
   - 控制源代码列表和堆栈跟踪的显示方式

#### 配置保存

配置通过 `SaveConfig()` 函数保存：

1. 将 `Config` 结构体序列化为 YAML 格式
2. 写入到配置文件
3. 保持用户的自定义设置持久化

### 使用示例

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

这些配置可以帮助用户根据自己的需求优化调试体验，提高调试效率。 