## 问题探讨：why load buildid sections

### 先说点结论性的

涉及到build id这个概念的sections主要有两个，.note.go.buildid，以及.note.gnu.build-id，前者就是大家熟知的go tool buildid `<binary>` 显示的buildid，后者是更多的Linux生态中的工具使用的。

前面讲解ELF文件段头表的时候发现个问题，.note.go.build, .note.gnu.build-id 为何会被加载到内存中呢？有几个猜测：

- 程序运行时希望不读取ELF文件直接获取这些buildid信息；
- 程序生成内存转储后，希望将这些信息包含在core文件中，方便其他工具从core文件中提取buildid信息与符号

.note.gnu.build-id，这个的作用是用来跟踪构建时的代码版本、代码目录、构建环境是否一致，有些构建系统会记录这个buildid以及关联的上述信息、制品、分离的调试符号、符号表等等，在需要定位问题的时候可以按需加载这些。
.note.go.buildid，这个的作用主要是go工具链内部使用，外部工具不应该使用这个buildid。

### 探索：pprof profile信息中希望记录下GNU build-id

在阅读了go源码以后，初步判断是pprof生成profile信息时希望能在其中记录下buildid，以方便分析时用来跟踪版本、构建环境、符号信息，这些信息可能构建系统会自己通过数据库维护起来。但是仔细查看后这里的buildid是.note.gnu.build-id中的build-id，而非go buildid，前者是一些工具通用的

从/proc/pid/maps获取对应的GNU build-id的源码，大致如下：

```
// newProfileBuilder returns a new profileBuilder.
// CPU profiling data obtained from the runtime can be added
// by calling b.addCPUData, and then the eventual profile
// can be obtained by calling b.finish.
func newProfileBuilder(w io.Writer) *profileBuilder {
	zw, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
	b := &profileBuilder{
		...
	}
	b.readMapping()
	return b
}

// readMapping reads /proc/self/maps and writes mappings to b.pb.
// It saves the address ranges of the mappings in b.mem for use
// when emitting locations.
func (b *profileBuilder) readMapping() {
	data, _ := os.ReadFile("/proc/self/maps")
	parseProcSelfMaps(data, b.addMapping)
	...
}

func parseProcSelfMaps(data []byte, addMapping func(lo, hi, offset uint64, file, buildID string)) {
	// $ cat /proc/self/maps
	// 00400000-0040b000 r-xp 00000000 fc:01 787766                             /bin/cat
	// 0060a000-0060b000 r--p 0000a000 fc:01 787766                             /bin/cat
	// 0060b000-0060c000 rw-p 0000b000 fc:01 787766                             /bin/cat
	// 014ab000-014cc000 rw-p 00000000 00:00 0                                  [heap]
	// 7f7d76af8000-7f7d7797c000 r--p 00000000 fc:01 1318064                    /usr/lib/locale/locale-archive
	// 7f7d7797c000-7f7d77b36000 r-xp 00000000 fc:01 1180226                    /lib/x86_64-linux-gnu/libc-2.19.so
	// 7f7d77b36000-7f7d77d36000 ---p 001ba000 fc:01 1180226                    /lib/x86_64-linux-gnu/libc-2.19.so
	...
	// 7f7d77f65000-7f7d77f66000 rw-p 00000000 00:00 0
	// 7ffc342a2000-7ffc342c3000 rw-p 00000000 00:00 0                          [stack]
	// 7ffc34343000-7ffc34345000 r-xp 00000000 00:00 0                          [vdso]
	// ffffffffff600000-ffffffffff601000 r-xp 00000000 00:00 0                  [vsyscall]

	...

	for len(data) > 0 {
		...
		buildID, _ := elfBuildID(file)
		addMapping(lo, hi, offset, file, buildID)
	}
}

// elfBuildID returns the GNU build ID of the named ELF binary,
// without introducing a dependency on debug/elf and its dependencies.
func elfBuildID(file string) (string, error) {
    	...
}
```

### 探索：测试下pprof profile信息中包含GNU build-id

在这个基础上，我们生成个pprof profile信息，然后查看下是否有记录这个GNU build-id：

```
$ cat main.go
package main

import (
	"log"
	"os"
	"runtime/pprof"
)

func main() {
	f, err := os.Create("profile.pb.gz")
	if err != nil {
		log.Fatal(err)
	}
	pprof.StartCPUProfile(f)
	defer pprof.StopCPUProfile()
	var i int64
	for i = 0; i < (1 << 33); i++ {
	}
}
```

```bash
$ go build -ldflags "-B gobuildid" main.go

$ file main
main: ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, BuildID[sha1]=f4b5d514bc46fad9417898216b23910ae874a85d, with debug_info, not stripped

$ readelf -n main

Displaying notes found in: .note.gnu.build-id
  Owner                Data size 	Description
  GNU                  0x00000014	NT_GNU_BUILD_ID (unique build ID bitstring)
    Build ID: f4b5d514bc46fad9417898216b23910ae874a85d

Displaying notes found in: .note.go.buildid
  Owner                Data size 	Description
  Go                   0x00000053	GO BUILDID
   description data: 45 72 5a 36 6f 30 30 37 79 53 35 48 4c 67 41 7a 51 66 6e 52 2f 42 5a 53 51 58 54 4b 49 35 53 61 61 4f 4d 6e 65 49 36 63 56 2f 52 37 41 42 44 38 68 6c 34 6c 6b 65 79 44 66 7a 35 35 69 4d 2f 73 58 6a 56 4b 38 6d 52 58 79 35 4d 79 41 73 46 46 52 6d 74

$ ./main

$ pprof -raw profile.pb.gz | grep -A10 Mappings
Mappings
1: 0x400000/0x4ac000/0x0 /tmp/main f4b5d514bc46fad9417898216b23910ae874a85d [FN]
```

注意这里的GNU build-id不是默认生成的，需要显示传 -ldflags "-B ..." 来指定，如果不指定的话，就没有这个信息：

```
$ go build main.go

$ file main
main: ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, Go BuildID=llrn1go725_F2vCvvETz/OITeRu6kDScHG6FVjdK8/R7ABD8hl4lkeyDfz55iM/uoTostDrfB5kdwhy6UpG, with debug_info, not stripped

$ readelf -n main

Displaying notes found in: .note.go.buildid
  Owner                Data size 	Description
  Go                   0x00000053	GO BUILDID
   description data: 6c 6c 72 6e 31 67 6f 37 32 35 5f 46 32 76 43 76 76 45 54 7a 2f 4f 49 54 65 52 75 36 6b 44 53 63 48 47 36 46 56 6a 64 4b 38 2f 52 37 41 42 44 38 68 6c 34 6c 6b 65 79 44 66 7a 35 35 69 4d 2f 75 6f 54 6f 73 74 44 72 66 42 35 6b 64 77 68 79 36 55 70 47

$ ./main

$ pprof -raw profile.pb.gz | grep -A10 Mappings
Mappings
1: 0x400000/0x4ac000/0x0 /tmp/main  [FN]
```

### 探索：为什么text segment要包含buildid? coredump?

但是我们想搞清楚的是，这么一个GNU build-id或者go buildid，链接器创建对应的segment的时候为什么非要将其和.text section一起定义为PT_LOAD类型，毕竟没有工具直接从二进制中去读它。实际上如果没有原始ELF信息中的sections、segments信息也不知道进程中该buildid应该位于内存地址的什么位置、占多少字节，还是没法解析。实际上现在看go官方工具链里至少也没有直接这么去读的，都最终还是读的ELF文件中的sections来拿到这个GNU build-id或者go buildid信息的。

我现在能联想到的就是，如果不是一个bug的话，那很可能是希望在生成core文件 或者 内存转储（dump memory）的时候能把这部分信息存下来，好方便确定生成core文件的builid，以和构建系统中维护的信息建立联系。下面举个这样的例子：

启动一个go程序 myapp 并生成 core 文件

1. go build -o main main.go
2. ./main
3. gcore -o main.core $(pidof main)

加载这个core文件，并读取buildid信息

1. gdb main.core main
2. gdb> maintenance info sections
   ```bash
   Exec file:
       `/home/zhangjie/test/main', file type elf64-x86-64.
    [0]     0x00401000->0x00480c75 at 0x00001000: .text ALLOC LOAD READONLY CODE HAS_CONTENTS
    [1]     0x00481000->0x004be35d at 0x00081000: .rodata ALLOC LOAD READONLY DATA HAS_CONTENTS
    [2]     0x004be360->0x004be8f0 at 0x000be360: .typelink ALLOC LOAD READONLY DATA HAS_CONTENTS
    [3]     0x004be900->0x004be958 at 0x000be900: .itablink ALLOC LOAD READONLY DATA HAS_CONTENTS
    [4]     0x004be958->0x004be958 at 0x000be958: .gosymtab ALLOC LOAD READONLY DATA HAS_CONTENTS
    [5]     0x004be960->0x00523070 at 0x000be960: .gopclntab ALLOC LOAD READONLY DATA HAS_CONTENTS
    [6]     0x00524000->0x00524150 at 0x00124000: .go.buildinfo ALLOC LOAD DATA HAS_CONTENTS
    [7]     0x00524160->0x00529600 at 0x00124160: .noptrdata ALLOC LOAD DATA HAS_CONTENTS
    [8]     0x00529600->0x0052d850 at 0x00129600: .data ALLOC LOAD DATA HAS_CONTENTS
    [9]     0x0052d860->0x0058d390 at 0x0012d860: .bss ALLOC
    [10]     0x0058d3a0->0x00590de0 at 0x0018d3a0: .noptrbss ALLOC
    [11]     0x00000000->0x00000214 at 0x0012e000: .debug_abbrev READONLY HAS_CONTENTS
    [12]     0x00000000->0x00037302 at 0x0012e135: .debug_line READONLY HAS_CONTENTS
    [13]     0x00000000->0x00012674 at 0x0014d803: .debug_frame READONLY HAS_CONTENTS
    [14]     0x00000000->0x0000002a at 0x00153a70: .debug_gdb_scripts READONLY HAS_CONTENTS
    [15]     0x00000000->0x000928ac at 0x00153a9a: .debug_info READONLY HAS_CONTENTS
    [16]     0x00000000->0x000a772c at 0x00191567: .debug_loc READONLY HAS_CONTENTS
    [17]     0x00000000->0x0003e3a0 at 0x001adaae: .debug_ranges READONLY HAS_CONTENTS
    [18]     0x00400fdc->0x00401000 at 0x00000fdc: .note.gnu.build-id ALLOC LOAD READONLY DATA HAS_CONTENTS
    [19]     0x00400f78->0x00400fdc at 0x00000f78: .note.go.buildid ALLOC LOAD READONLY DATA HAS_CONTENTS
   Core file:
       `/home/zhangjie/test/mycore.444388', file type elf64-x86-64.
    [0]     0x00000000->0x00002798 at 0x00000548: note0 READONLY HAS_CONTENTS
    [1]     0x00000000->0x000000d8 at 0x00000668: .reg/444388 HAS_CONTENTS
    [2]     0x00000000->0x000000d8 at 0x00000668: .reg HAS_CONTENTS
    ...
   ```
3. 生成转储，包含了go buildid
   ```bash
   gdb$ dump memory dump.go.buildid 0x00400f78 0x00400fdc
   ```
4. 生成转储，包含了GNU build-id
   ```bash
   gdb$ dump memory dump.gnu.buildid 0x00400fdc 0x00401000
   ```

对比分析上述内存中转出来的buildid信息与ELF文件中数据是否一致：

- 查看上述内存转储数据可以使用 `strings`、`hexdump`；
- 查看ELF文件中数据 `file`、`readelf -S <main> --string-dump=|--hex-dump=`；
- 对比发现是一致的。

### 探索：似乎除了core没有其他理由要load上述sections？

但是呢？还是那句话，如果我们拿不到原始的executable文件，拿不到对应的ELF sections、segments信息，上面调试器也输出不了各个sections在内存中的地址，我们也不方便内存转储后分析。
思来想去，将这个.note.gnu.build-id和.note.go.builid加载到内存，唯一可能的原因就是为了生成core文件的时候能够包含这个信息了。

> ps: 得有工具帮助跟踪这个core文件的pid对应的二进制文件的映射关系。

Read More:

- [what does go build -ldflags &#34;-B [0x999|gobuildid]&#34; do](https://go-review.googlesource.com/c/go/+/511475#related-content) , 这个其实就是想在ELF里记录一个GNU buildid，但是能从go buildid派生出来，不用外部系统重复做这个计算工作。这个buildid可以用来用来追踪构建有没有发生改变，有些外部系统会维护一个数据库记录构建时代码版本、符号信息以及与buildid的映射关系，方便进行问题定位、制品跟踪等。
- .note.gnu.build-id 可以由外部系统构建好在编译的时候传入（go build -ldflags "-B `<yourbuildid>`"），也可以通过.note.go.buildid生成规则来派生一个出来（go build -ldflags "-B gobuildid"）。
- .note.gnu.build-id 是很多通用工具会去读取的，而.note.go.buildid定位上是只给go官方工具链中的内部工具使用。
- 不管怎么样吧，现在pprof profile信息里记录这个GNU build-id的时候也是通过先读取 /proc/`<pid>/maps然后找到可执行权限的mmaped的文件，然后再去读取这个文件找到对应的section .note.gnu.build-id来读取的。这部分代码写的很重复，实际上只是为了避免引入标准库中的东西，不想导入那么多依赖，所以是自己读取后来解析的。`

Well, I'm still a little confused:

- 通过这个来跟踪下讨论进展：https://groups.google.com/g/golang-nuts/c/Pv5gPIUTVyY
