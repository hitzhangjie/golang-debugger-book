## 扩展阅读：Go 工具链调试信息（DWARF）版本矩阵

### 背景

本书 4.2.1 节引用的 `readelf` 输出是早期基于 go1.13 环境采集的，`.zdebug_` 前缀的 sections 是那个时代的产物：调试信息用 zlib 压缩后，通过把 section 名前缀从 `.debug_` 改成 `.zdebug_` 来标记"已压缩"。多年过去，这部分行为已经发生了多次变化。下表是 2026.9 实测的版本矩阵（用各版本工具链构建同样的 hello world 程序后检查产物）。

### 版本矩阵

**ELF 目标文件（linux/amd64，CGO_ENABLED=0）**

| Go 版本 | DWARF 版本 | 调试 section 命名 | 压缩方式 |
| --- | --- | --- | --- |
| ≤ 1.18 | v4 | `.zdebug_*`（如 `.zdebug_info`） | zlib 压缩，靠 section 名前缀标记 |
| 1.19 – 1.24 | v4 | `.debug_*`（如 `.debug_info`） | zlib 压缩，靠 `SHF_COMPRESSED` flag 标记（ELF 标准压缩格式） |
| ≥ 1.25 | v5（默认） | `.debug_*`；且 `.debug_loc`/`.debug_ranges` 被 `.debug_loclists`/`.debug_rnglists` 取代，新增 `.debug_addr` | 同 1.19；`GOEXPERIMENT=nodwarf5` 可回退 v4 |
| ≥ 1.26 | 与 1.25 相同 | 与 1.25 相同 | 与 1.25 相同 |

**Mach-O 目标文件（darwin/arm64，CGO_ENABLED=0）**

| Go 版本 | DWARF 版本 | 调试 section 命名 | 压缩方式 |
| --- | --- | --- | --- |
| ≤ 1.24 | v4 | `__debug_*`/`__zdebug_*` | zlib 压缩，靠 section 名前缀标记（Mach-O 没有 `SHF_COMPRESSED` 的等价物，各版本一直沿用 z 前缀命名约定） |
| ≥ 1.25 | v4（默认） | 同上 | 同上；`GOEXPERIMENT=dwarf5` 可强制 v5（section 名变为 `__zdebug_loclist`、`__zdebug_addr` 等） |

### 关键时间点与出处

- `.zdebug_*` → `.debug_*`+`SHF_COMPRESSED` 的切换发生在 **go1.19**（issue [golang/go#50796](https://github.com/golang/go/issues/50796)，2022 年 3 月关闭）；commit [75136fc](https://github.com/golang/go/commit/75136fc14c0d3ec64a2f6728e96fc86066d853c9)（2023 年 5 月，go1.21）只是清理了不再使用的 `.zdebug_` 名字符串表项，并非切换本身；
- DWARF v5 默认启用发生在 **go1.25**（2025 年 8 月发布），release notes 原文："The compiler and linker in Go 1.25 now generate debug information using DWARF version 5 ... DWARF 5 generation can be disabled by setting the environment variable `GOEXPERIMENT=nodwarf5` at build time"（[go.dev/doc/go1.25](https://go.dev/doc/go1.25)）；
- darwin/ios 保持 v4 的原因：Xcode 16 之前的 dsymutil 处理不了 DWARF5 的 `.debug_rnglists`，会破坏 cgo 构建；aix 保持 v4 是因为 XCOFF 不支持 `.debug_addr` 等 DWARF5 section（见 [internal/buildcfg/exp.go](https://github.com/golang/go/blob/go1.25.0/src/internal/buildcfg/exp.go) 中 `dwarf5Supported` 的注释，commit [ca19f98](https://github.com/golang/go/commit/ca19f987ca74605ef977c7a8619a344504c72272)）；
- `dwarf5`/`nodwarf5` 开关只存在于 go1.25+：go1.24 及更早的 buildcfg 中没有该实验项，设置 `GOEXPERIMENT=dwarf5` 构建会直接报错 "unknown GOEXPERIMENT dwarf5"；
- `-ldflags=-compressdwarf=false` 在以上所有版本中均可用，可关闭压缩以便直接查看 section 内容；≤1.18 时它控制是否生成 `.zdebug_*`，≥1.19 时它控制是否设置 `SHF_COMPRESSED`；
- 两种压缩的载荷也不同：`.zdebug_*` 的 section 数据是裸 zlib 流；`SHF_COMPRESSED` 的 section 数据以 8 字节魔数 "ZLIB" + 8 字节解压后长度开头，之后才是 zlib 流。

### 验证命令

linux 上：

```bash
# 1. 查看调试相关 section 与 flags（Flg 列中的 C 表示 SHF_COMPRESSED）：
readelf -S binary | grep debug

# 2. 查看 DWARF 版本（.debug_info 中 CU 头部的 version 字段）：
readelf --debug-dump=info binary | grep -m1 Version
```

macOS 上可安装 LLVM 工具链后使用 `llvm-readobj -S`、`llvm-dwarfdump --debug-info`，输出中分别显示 `SHF_COMPRESSED (0x800)` 和 `version = 0x0005`。

### 实测方法

矩阵中的每个数据点都可以用下面的方法自行复核：借助 GOTOOLCHAIN 下载指定版本工具链（注意切换只在有 go.mod 的目录下生效，`go version`/`go env` 命令本身不会触发切换），构建同样的程序后检查产物：

```bash
$ GOTOOLCHAIN=go1.25.0 GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o hw hello.go
$ go version -m hw | head -1          # 确认实际使用的工具链版本
$ readelf --debug-dump=info hw | grep -m1 Version
```

另外，工具链下载强制要求校验和数据库，`GOSUMDB=off` 会导致下载失败；国内网络下可以为 GOSUMDB 配置镜像，例如 `GOSUMDB="sum.golang.org https://goproxy.io/sumdb/sum.golang.org"`。

### 小结

"go 后续可能会从 DWARF v4 升级到 v5" 的猜测已经在 go1.25 落地成真——升级的版本边界、平台差异、回退开关都已明确。在阅读本书时如果发现调试信息相关的行为与描述不符，可以先对照上面的矩阵确认一下所使用的工具链版本。
