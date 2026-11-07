## 扩展阅读：PIE 可执行文件为什么有 .interp/.dynsym/.dynamic

### 从一个容易误解的现象说起

7.3 节末尾提到：纯 Go 程序默认构建出来的是静态链接的 `ET_EXEC`，其中没有需要动态符号解析的 symbol 或 section；可一旦加上 `-buildmode=pie`，产物里就出现了 `.interp`、`.dynsym`、`.dynamic`，而 `ldd` 有时仍然打印 `statically linked`。外部链接、cgo、`-linkshared` 构建的产物也有这些 section。

初看这像是自相矛盾：既然 `ldd` 说“静态链接”，怎么又会有动态符号表和动态段？

答案在于，平时说的“静态/动态”其实混在一起讲了两件不同的事：

- **动态链接（dynamic linking）**：链接阶段不解析全部符号，而把一部分符号解析推迟到装载/运行时，由动态链接器到共享库（`.so`）里查找。证据是 `DT_NEEDED`、`.dynsym` 中的 `UND` 符号、`.rela.plt` 里的 `JUMP_SLOT` 重定位。
- **动态装载/重定位（dynamic loading & relocation）**：可执行文件以 `ET_DYN` 形式构建，可以被装载到任意基址，装载器需要在运行时给代码/数据中的地址打补丁（重定位）。

`-buildmode=pie` 改变的是后者。一个纯 Go 的 PIE 程序**没有链接任何共享库**，但它必须借助系统的动态加载器 `ld.so` 来完成自重定位（self-relocation），于是 ELF 里就带上了动态文件所需的一套标准结构。

### 两种“静态/动态”要分开看

| | 静态链接 | 动态链接 |
|---|---|---|
| 符号解析时机 | 链接时全部完成 | 推迟到装载/运行时 |
| 是否依赖 `.so` | 否 | 是，记录在 `DT_NEEDED` |
| 典型证据 | 无 `DT_NEEDED`，无 `UND` 动态符号 | `.dynsym` 有 `UND` 符号，`.rela.plt` 有 `JUMP_SLOT` |
| 常见产物 | `ET_EXEC` 或 `ET_DYN` | `ET_EXEC` 或 `ET_DYN` |

| | `ET_EXEC` | `ET_DYN`（PIE） |
|---|---|---|
| 装载基址 | 链接时固定 | 装载时随机选择 |
| 重定位时机 | 链接时完成 | 装载时由 `ld.so` 完成 |
| 是否需要 loader | 否 | 是，通过 `PT_INTERP` 指定 |
| 典型证据 | 无 `.interp`/`.dynamic` | 有 `.interp`/`.dynamic`/`.rela` |

`ET_EXEC` 和 `ET_DYN` 都可以是静态链接的（不依赖 `.so`）；`ET_DYN` 也不一定动态链接 libc。PIE 只是选择了 `ET_DYN` 这种“可被重定位”的形态。

### 默认 `-buildmode=exe`：为什么没有这些 section

纯 Go、内部链接、默认 `-buildmode=exe` 时，Go 链接器自己完成所有符号解析和重定位，产物是 `ET_EXEC`，代码段从固定地址（linux/amd64 上通常是 `0x400000`）开始映射。程序里所有符号地址在链接时就已经确定，运行时不需要任何动态解析。

（go1.24.13、linux/amd64 实测）

```bash
$ file exe
exe: ELF 64-bit LSB executable, x86-64, ... statically linked, ...
$ readelf -h exe | grep Type
  Type: EXEC (Executable file)
$ readelf -d exe
There is no dynamic section in this file.
$ ldd -r ./exe
        not a dynamic executable
```

Go runtime 直接使用原始系统调用，vDSO 也是运行时从 auxv 里找到的，不需要动态符号。产物中当然还有 `.symtab`/`.strtab`（链接和调试用的符号表，Go 默认还带 DWARF），但它们是给链接器和调试器用的，不是装载器运行时做符号解析用的。

### `-buildmode=pie`：为什么必须生成动态结构

PIE 产物是 `ET_DYN`（旧版 `file` 甚至称其为 shared object）。它可能被装载到任意基址，而 x86-64 上 Go 代码本身虽然位置无关，**数据段里仍有大量绝对地址**：函数指针表、itab/type 链接、`moduledata`、GC 元数据等。链接时不知道最终基址，只能在文件里留下重定位记录，等装载时再补上基址：

（go1.24.13 实测，示例程序有 6519 条重定位）

```bash
$ readelf -rW pie | awk '/R_X86_64/{print $3}' | sort | uniq -c
   6519 R_X86_64_RELATIVE
```

内核装载 `ET_DYN` 主程序时，只负责按 `PT_LOAD` 映射，然后跳到 `PT_INTERP` 指定的解释器；**内核不做动态重定位**。如果 PIE 没有自带重定位代码（只有 static-pie 才带），就必须把控制权交给用户态的 `ld.so`。

因此 ELF 必须携带：

- `PT_INTERP` → `.interp`：告诉内核用哪个 loader，例如 `/lib64/ld-linux-x86-64.so.2`；
- `PT_DYNAMIC` → `.dynamic`：告诉 loader 重定位表、符号表、hash 表的位置，即 `DT_RELA/DT_RELASZ/DT_RELAENT`、`DT_SYMTAB/DT_STRTAB/DT_HASH`、`DT_PLTGOT`、`DT_FLAGS_1=DF_1_PIE` 等；
- `.rela`：重定位条目本身；
- `.dynsym/.dynstr/.hash`：动态 ELF 的标准表结构。

（go1.24.13、纯 Go 内部链接 PIE 实测；节区排列顺序与 GNU ld 产物不同，不影响含义）

```bash
$ readelf -SW pie | grep -E '\.(interp|rela|rela\.plt|dynsym|dynstr|hash|dynamic|plt|got)'
  [ 2] .plt        PROGBITS  0000000000491f80 091f80 000010 10  AX  0   0 16
  [ 4] .rela       RELA      00000000004b9018 0b9018 026328 18   A 10   0  8
  [ 5] .rela.plt   RELA      00000000004df340 0df340 000000 18   A 10   2  8
  [ 7] .dynstr     STRTAB    00000000004df340 0df340 000001 00   A  0   0  1
  [ 9] .hash       HASH      00000000004df350 0df350 000014 04   A 10   0  8
  [10] .dynsym     DYNSYM    00000000004df370 0df370 000018 18   A  7   1  8
  [12] .got        PROGBITS  0000000000504180 104180 000000 08  WA  0   0  8
  [13] .dynamic    DYNAMIC   0000000000504180 104180 0000c0 10  WA  7   0  8
  [20] .got.plt    PROGBITS  000000000057e160 17e160 000018 08  WA  0   0  8
  [33] .interp     PROGBITS  0000000000400fe4 000fe4 00001c 00   A  0   0  1
```

```bash
$ readelf -dW pie
Dynamic section at offset 0x104180 contains 12 entries:
  Tag        Type                         Name/Value
 0x0000000000000004 (HASH)               0x4df350
 0x0000000000000006 (SYMTAB)             0x4df370
 0x000000000000000b (SYMENT)             24 (bytes)
 0x0000000000000005 (STRTAB)             0x4df340
 0x000000000000000a (STRSZ)              1 (bytes)
 0x0000000000000007 (RELA)               0x4b9018
 0x0000000000000008 (RELASZ)             156456 (bytes)
 0x0000000000000009 (RELAENT)            24 (bytes)
 0x0000000000000003 (PLTGOT)             0x57e160
 0x0000000000000015 (DEBUG)              0x0
 0x000000006ffffffb (FLAGS_1)            Flags: PIE
 0x0000000000000000 (NULL)               0x0
```

注意这些“最小化”的细节：**没有 `NEEDED`，也没有 `JMPREL`**；`STRSZ` 只有 1 字节；`.dynsym` 里只有 1 个 0 号空符号；`.rela.plt` 为空；`.plt` 只有一段永远不会被调用的 PLT0 桩代码；`.got` 大小为 0。这说明 PIE 模式下的 `ld.so` 只负责**做重定位**，不需要解析任何符号。

loader 做完重定位、填写 `DT_DEBUG`（供调试器读取 `link_map`）后跳到 entry；Go runtime 启动后仍然只用原始系统调用和 vDSO，不依赖 libc。

所以更准确的说法是：**PIE 是“动态 ELF + 静态链接”，它需要动态加载器，但不依赖共享库。**

### 为什么 `ldd` 仍然显示 statically linked

`ldd` 不是独立分析工具，它本质上是让动态加载器以 `LD_TRACE_LOADED_OBJECTS=1` 模式跑一遍，报告“需要装载哪些共享库”：

- 对没有 `PT_INTERP` 的静态 `ET_EXEC`，`ldd` 给出 `not a dynamic executable`；
- 对有 `PT_INTERP` 但没有 `DT_NEEDED` 的 PIE，`ld.so` 发现没有共享库依赖，于是打印 `statically linked`。

所以两个说法都对，只是层面不同：

- `file` 输出里的 `dynamically linked` 表示“存在 `PT_INTERP`”；
- `ldd` 输出里的 `statically linked` 表示“没有 `DT_NEEDED` 共享库依赖”。

（go1.24.13 实测：`ldd -r ./exe` 输出 `not a dynamic executable`；`ldd -r ./pie` 输出 `statically linked`。）

还要注意 `.interp` 是**真实依赖**：它硬编码了 loader 的路径。把这种 PIE 拷到没有 glibc loader 的系统（例如纯 musl 容器）里会跑不起来，所以它并不是“自包含”的。

### 外部链接、cgo、`-linkshared` 才是真正的动态链接

同样是“有这些 section”，含义并不相同：

- **cgo / 外部链接**：产物里出现 `DT_NEEDED libc.so.6`、`libpthread.so.0`，`.dynsym` 里有大量 `UND` 符号（带 `GLIBC_2.2.5` 之类的版本），`.rela.plt` 里有 `JUMP_SLOT`，装载时由 `ld.so` 真正做符号解析和共享库装载。
- **纯 Go + `-linkmode=external`**（需 `CGO_ENABLED=1`）：即使源码没有 `import "C"`，也会交给 gcc/ld 链接，默认产出动态 `ET_EXEC`（实测带 `NEEDED libpthread/libc`）。要静态可加 `-extldflags=-static`，但这要求系统安装了静态 libc；本机未装，ld 会报 `cannot find -lpthread`/`-lc`。
- **`-linkshared`**：链接 Go 自己构建的 `libstd.so`、`libruntime.so`，`DT_NEEDED` 它们，Go 符号通过 `.dynsym` 动态解析。
- **`-buildmode=pie` 只是把 `ET_EXEC` 换成 `ET_DYN`**；与外部链接叠加时，就同时具备 PIE 和真正的动态链接。

各种构建方式的对照（输出基于 go1.24.13、linux/amd64）：

| 构建方式 | Type | `PT_INTERP` | `.dynsym` | `DT_NEEDED` | `ldd -r` | 说明 |
|---|---|---|---|---|---|---|
| 纯 Go，默认 `-buildmode=exe` | `EXEC` | 无 | 无 | 无 | `not a dynamic executable` | 内核直接装载 |
| 纯 Go，`-buildmode=pie` | `DYN` | 有 | 仅 0 号空符号 | 无 | `statically linked` | `ld.so` 只做重定位 |
| cgo / 外部链接 | `EXEC` | 有 | 大量 `UND`（带版本） | libc、libpthread | 列出共享库 | 真正的动态链接 |
| `-buildmode=pie` + 外部链接 | `DYN` | 有 | 同上 | libc、libpthread | 列出共享库 | 动态链接 + PIE |
| `-linkshared` | `DYN`/`EXEC` | 有 | Go 符号 | libstd/libruntime | 列出共享库 | 链接 Go 共享库 |
| static-pie（外部链接） | `DYN` | 无 | 最小 | 无 | 通常 `not a dynamic executable` | 自带自举重定位 |

### 真正自包含的 PIE：static-pie

如果 PIE 不带 `PT_INTERP`，也不需要系统 loader，那它必须在启动代码里自己完成重定位，这类产物称为 **static-pie**（gcc 的 `-static-pie`、musl 的 `rcrt1.o` 都提供这种自举重定位启动代码）。

Go 内部链接器没有生成这种自举重定位代码，所以它的 PIE 必须借用系统 `ld.so`。若想用 Go 构建 static-pie，需要走外部链接并让 C 工具链参与，例如 `-buildmode=pie -ldflags="-linkmode=external -extldflags=-static-pie"`，具体是否可用取决于系统的 C 工具链和静态库支持。

### 对调试器的意义

理解了这些区别，对开发和使用调试器都有直接帮助：

- **判断是不是 PIE**：`e_type == ET_DYN`、存在 `PT_INTERP`、`DT_FLAGS_1` 含 `DF_1_PIE`；也可以结合 auxv 的 `AT_PHDR`/`AT_ENTRY` 与 ELF 头中的 `p_vaddr`/`e_entry` 计算装载基址（load bias）。
- **符号地址换算**：PIE 的 `.symtab`/`.dynsym` 中记录的是链接时地址，运行时地址需要加上 load bias；静态 `ET_EXEC` 的 load bias 可视为 0。
- **不要被 `.dynsym` 误导**：有 `.dynsym` 不等于动态链接了 libc，内部链接的 Go PIE 里它可能只有一个空符号；要判断动态链接，看 `DT_NEEDED` 和 `UND` 符号。
- **动态链接程序的启动信息**：`ld.so` 会填写 `DT_DEBUG`，指向 `r_debug`/`link_map`；GDB 等调试器通过它获取已装载共享库的信息。这是调试器处理动态链接程序的重要入口。

### 验证命令

```bash
# 1. 看 ELF 类型：EXEC 还是 DYN
readelf -h bin | grep Type

# 2. 看是否需要 loader：有没有 PT_INTERP
readelf -lW bin | grep -E 'INTERP|DYNAMIC'

# 3. 看是否真的动态链接：有没有 NEEDED 以及 PIE 标记
readelf -dW bin | grep -E 'NEEDED|FLAGS_1'

# 4. 看重定位类型：RELATIVE 是自重定位，JUMP_SLOT/GLOB_DAT 才是符号解析
readelf -rW bin | awk '/R_X86_64/{print $3}' | sort | uniq -c

# 5. 看动态符号：有 UND 符号才说明需要动态符号解析
readelf -sW --dyn-syms bin

# 6. ldd 只能回答“依赖哪些共享库”
ldd -r bin
```

一句话总结：判断“是否动态链接”看 `DT_NEEDED`，判断“是否需要 loader”看 `PT_INTERP`，判断“是否有动态符号解析”看 `.dynsym` 中是否有 `UND` 符号；三者可以彼此独立。

### 版本说明

以上输出基于 go1.24.13、linux/amd64（Oracle Linux 8，glibc 2.28）实测；不同 Go 版本、不同发行版在 section 顺序、section 名字、重定位条数等细节上可能略有差异，但结论不变。
