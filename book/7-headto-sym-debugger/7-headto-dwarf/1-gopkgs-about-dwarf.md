## Go DWARF Support

### 为什么要探讨这个问题

Go编译工具链在进行编译链接时会生成DWARF调试信息，有哪些Go库可以实现对这些数据的读取呢？读取的话，针对类型、变量、常量、函数（包括参数列表、返回值）等，有没有参考手册可以得知具体应该如何读取呢（不同语言不同程序构造的DWARF数据也不同）？现在2025年了，有没有这方面更友好的开源库、参考手册、文档呢？

我因为详细钻研过DWARF规范，所以我能非常自然理解DWARF数据生成、解析这其中的工作量有多大，我们有些读者可能会想难道和读写一个ELF文件的工作量有啥巨大的差距不成？是的，有非常大的差距，完全没法类比。大家看下delve调试器中pkg/dwarf下的代码量，就知道为什么我们要探讨Go DWARF Support这个问题了。

```bash
$ cloc path-to/delve/pkg/dwarf
      35 text files.
      34 unique files.                            
       3 files ignored.

github.com/AlDanial/cloc v 2.04  T=0.03 s (1200.7 files/s, 279205.9 lines/s)
-------------------------------------------------------------------------------
Language                     files          blank        comment           code
-------------------------------------------------------------------------------
Go                              34            920            573           6413
-------------------------------------------------------------------------------
SUM:                            34            920            573           6413
-------------------------------------------------------------------------------
```

专注于调试领域的开发者，应该说非常小众，而Go目前仍然是一个比较年轻的语言，So：

- Go团队不太可能在标准库里维护一个受众不多但是又“大而全”的DWARF实现上，非常耗费精力。
- Go编译工具链专注于生成DWARF调试信息，这部分信息是相对比较全面的，该生成的都生成了，缺点是文档比较少。
- debug/dwarf是专注于DWARF数据读取，但是也不是Go编译工具链生成的信息都支持读取，比如.debug_frame它就不支持读取。

也是因此，Go非官方调试器 [go-delve/delve](https://github.com/go-delve/delve) 内部才自己实现了这部分DWARF的生成、解析逻辑，它还自己实现了生成逻辑，一方面与Go编译工具链团队生成的DWARf数据做对比，一方面对Go编译工具链生成DWARF数据描述不够充分的时候，也方便从调试器开发者视角去反馈下此处应该如何生成更好，这样就形成了和Go核心团队的协作、共建。

> ps: 有个小哥学习调试器开发时，开发了个demo [ggg](https://github.com/ConradIrwin/ggg) ，当时也定制化了debug/dwarf，详见：[ConradIrwin/go-dwarf](https://github.com/ConradIrwin/go-dwarf)。这里只是举个定制化 `debug/dwarf`的例子，不代表这个库可用，而且最后更新已经是11年前的事情了。即使要用，也应该优先考虑 `go-delve/delve` 中的实现部分。

### 实现1：Go标准库 debug/dwarf

前面小节我们介绍了go标准库 `debug/dwarf`，它提供了对DWARF调试信息的解析，作为官方实现它提供了底层的API，允许你遍历和检查DWARF数据结构。

相对来说，官方库是最基础和可靠的选择。如果需要进行更高级的分析或集成，可能需要基于官方库进行二次开发，在此基础上增加更多的特性、提供更高级的抽象等。我们分析了为什么当前 `debug/dwarf` 不太可能是达到“完美”程度的原因，也列举了 `go-delve/delve` 和 `ggg` 的例子。

OK，那我们看下 `debug/dwarf` 的支持程度和局限性，`debug/dwarf`，以go1.24为例：

- 支持读取 .debug_ .zdebug_ sections；
- 如果调试信息开了zlib或者zstd压缩，支持自动解压缩 `debug/elf.(*Section).Data()`；
- 有些调试信息需要考虑进行重定位操作，支持按需重定位操作 `debug/elf.(*File).applyRelocations(a, b)`；
- DWARFv4多个.debug_types，dwarf.Data里面对其section名进行额外的编号，方便定位问题；
- 所有.debug_ .zdebug_ sections，dwarf.Data里面统一转换为.debug_ sections；
- 所有的DWARF sections都会被正常读取！

```go
func (f *File) DWARF() (*dwarf.Data, error) {
    // 获取 .[z]debug_ sections后面的后缀，其他section返回空:w
    dwarfSuffix := func(s *Section) string { ... }
    // 获取 .[z]debug_ sections的数据，并按需解压缩，按需重定位
    sectionData := func(i int, s *Section) ([]byte, error) { ... }

    // DWARFv4 有非常多的.[z]debug_ sections，最开始 debug/dwarf 主要处理下面这些 sections
    var dat = map[string][]byte{"abbrev": nil, "info": nil, "str": nil, "line": nil, "ranges": nil}
    for i, s := range f.Sections {
        suffix := dwarfSuffix(s)
        if suffix == "" {
            continue
        }
        if _, ok := dat[suffix]; !ok {
            continue
        }
        b, _ := sectionData(i, s)
        dat[suffix] = b
    }

    // 创建dwarf.Data，只包含了已经处理的.[z]debug_ sections
    d, _ := dwarf.New(dat["abbrev"], nil, nil, dat["info"], dat["line"], nil, dat["ranges"], dat["str"])

    // 继续处理 multiple .debug_types sections and other DWARFv4/v5 sections.
    for i, s := range f.Sections {
        suffix := dwarfSuffix(s)
        if suffix == "" {
            continue
        }
        if _, ok := dat[suffix]; ok {
            // Already handled.
            continue
        }

        b, _ := sectionData(i, s)
        // 如果有多个.debug_types sections，dwarf.Data里的section名加上编号，方便定位问题
        if suffix == "types" {
            _ = d.AddTypes(fmt.Sprintf("types-%d", i), b); err != nil {
        } else {
            // 其他DWARF sections
            _ = d.AddSection(".debug_"+suffix, b); err != nil {
        }
    }

    return d, nil
}
```

`debug/dwarf` 确实有读取所有的DWARF数据，但是这不够！读取、解析并提供了合适的API后，对我们才真正的有用。调试器要实现常规的调试能力，需要：

- 支持类型、变量、常量的查看或者修改，需要读取解析.debug_info中的DIEs -- debug/dwarf支持
- 需要能实现指令地址与源代码位置之间的转换，需要读取解析.debug_line中的行号表 -- debug/dwarf支持
- 实现调用栈的回溯，需要知道pcsp的关系，需要读取解析.debug_frame中的调用栈信息表 -- debug/dwarf不支持!!!
  >ps: go runtime是利用了.gopclntab并结合tls.g信息生成调用栈。
- 其他的sections也没有提供对应的API来操作。

总的来说，就是 debug/dwarf 完成了DWARF数据的读取、解压缩、重定位，但是并没有提供全面完整的API覆盖，我们想读取不同类型的DWARF信息时就比较棘手。这也意味着，要实现调试器里面需要的各种DWARF数据的查询操作，我们要自己实现。

### 实现2：Go工具链 cmd/internal/dwarf

在Go编译工具链层面，DWARF调试信息的生成，是分散在编译器、链接器中的，它们都涉及DWARF调试信息生成的工作，分工不同，cmd/internal/dwarf这个公共库编译器、链接器都在使用。

- `go tool compile` ，会记录一系列的 link.LSym (link.LSym.Type=SDWARFXXX，link.LSym.P=DWARF编码数据）；
- `go tool link`，会整合、转换、加工输入目标文件中编译器记录的上述信息，最终输出调试信息到.debug_ sections；

接下来两个小节，我们会详细介绍编译器、链接器的上述工作过程，对我们后续开发、测试自己的调试器还是很有价值的。

现在，我们先看下cmd/internal/dwarf这个package支持哪些功能：

- dwarf_defs.go，定义了DWARF中的一些常量，DW_TAG类型、DW_CLS类型、DW_AT属性类型、DW_FORM编码形式、DW_OP操作指令、DW_ATE属性编码类型、DW_ACCESS访问修饰、DW_VIS可见性修饰、DW_VIRTUALITY虚函数修饰、DW_LANG语言类型（go是22）、DW_INL内联类型、DW_ORD按行（列）主序、DW_LNS行号表操作指令、DW_MACINFO宏定义操作、DW_CFA调用栈信息表操作，等等；

  这些定义在 `go-delve/delve`中被归类到了不同的package中，这样更清晰一点。
- dwarf.go，定义了一些生成、编码DWARF调试信息的公共代码，DWARF调试信息的生成是由编译器和链接器完成的，dwarf.go中定义了一些生成DWARF调试信息的导出函数，编译器、链接器中均有使用这部分函数。

> ps: dwarf.go对我们帮助很大，非常具有参考价值，因为各种程序构造的DWARF表示，有不少是在这个文件中实现的。阅读这个源文件，能够帮助我们了解描述不同的程序构造使用的DIE TAG、Attr等DWARF描述元素，这样我们自己实现调试器时，需要从中提取必要信息时就知道如何精准的反向操作。

这部分代码主要是给Go编译工具链使用的，设计实现和编译工具链的其他部分紧密结合，很难拿出来复用。这个包的组织也是放在internal目录下，不像 `debug/dwarf` 是暴漏给普通Go开发者用的。即便觉得这部分代码非常有用，也要copy、paste后再做大量改动。`go-delve/delve` 中copy、paste了这部分代码用于生成DWARF数据进行比对、测试，但除了调试器本身这个项目，可能很难找到其他项目会这么干了。如果我们真想复用这部分代码可以服用 `go-delve/delve` 里的实现。

### 实现3：go-delve/delve/pkg/dwarf

#### how dlv handles DWARF?

以流行的go调试器 `go-delve/delve` 为例，它是如何处理DWARF调试信息的呢？有没有使用标准库呢？为了求证这几点，可以在git仓库下执行 `git log -S "DWARF()"`来搜索下提交记录，找到几条关键信息：

1. delve早期也是使用的标准库 `debug/dwarf`来实现调试信息解析，那个时候对go、delve都是一个相对早期的阶段，各方面都还不很成熟。

   ```bash
   commit f1e5a70a4b58e9caa4b40a0493bfb286e99789b9
   Author: Derek Parker <parkerderek86@gmail.com>
   Date:   Sat Sep 13 12:28:46 2014 -0500

   Update for Go 1.3.1

   I decided to vendor all debug/dwarf and debug/elf files so that the
   project can be go get-table. All changes that I am waiting to land in Go
   1.4 are now captured in /vendor/debug/*.
   ```
2. delve开发者发现使用 `debug/dwarf`解析某些类型信息存在问题，于是使用package `x/debug/dwarf`予以了替换，临时先应付下这个问题。现在再看 `x/debug/dwarf`这个package，发现之前的一些源文件不见了，因为它已经被迁移到go源码树中。

   ```bash
   commit 54f1c9b3d40f606f7574c971187e7331699f378e
   Author: aarzilli <alessandro.arzilli@gmail.com>
   Date:   Sun Jan 24 10:25:54 2016 +0100

       proc: replace debug/dwarf with golang.org/x/debug/dwarf

       Typedefs that resolve to slices are not recorded in DWARF as typedefs
       but instead as structs in a way that there is no way to know they
       are really slices using debug/dwarf.
       Using golang.org/x/debug/dwarf instead this problem is solved and
       as a bonus some types are printed with a nicer names: (struct string
       → string, struct []int → []int, etc)

        Fixes #356 and #293
   ```
3. 后面 `debug/dwarf`修复了之前存在的问题，delve又从 `x/debug/dwarf`替换回了 `debug/dwarf`。

   ```bash
   commit 1e3ff49610690e9890a669c95d903184baae1f4f
   Author: aarzilli <alessandro.arzilli@gmail.com>
   Date:   Mon May 29 15:20:01 2017 +0200

       pkg/dwarf/godwarf: split out type parsing from x/debug/dwarf

       Splits out type parsing and go-specific Type hierarchy from
       x/debug/dwarf, replace x/debug/dwarf with debug/dwarf everywhere,
       remove x/debug/dwarf from vendoring.
   ```
4. 后续delve自己实现对debug_line的解析，并与标准库对比了处理结果，发现处理的功能正确性上与标准库已经一致了。

   不禁要问为什么要自己实现呢？我理解一方面是go、delve都在快速演进，go官方团队也没有在调试方面同步地下那么多功夫。另一方面，delve不可避免地要自己解析一部分调试信息。最终，delve开发者把.debug_line连同其他sections的解析全部重写，使得delve对调试信息的解析具备了更好的完备性。

   ```bash
   commit 3f9875e272cbaae7e507537346757ac4db6d25fa
   Author: aarzilli <alessandro.arzilli@gmail.com>
   Date:   Mon Jul 30 11:18:41 2018 +0200

       dwarf/line: fix some bugs with the state machine

       Adds a test that compares the output of our state machine with the
       output of the debug_line reader in the standard library and checks that
       they produce the same output for the debug_line section of grafana as
       compiled on macOS (which is the most interesting case since it uses cgo
       and therefore goes through dsymutil).

       ...
   ```

总之标准库对调试信息的读取解析支持有限，go、delve都在快速演进中，很明显delve对DWARF的需求是明显比go本身强烈的。delve一开始使用标准库，后面发现有局限性，于是开始自己重写DWARF调试信息的读取解析。当然这个重写的过程中，也有借鉴go标准库中的实现，go编译工具链也有收到delve开发者的DWARF调试信息生成的优化建议，是一个协作、共建的过程。

我们了解到这个程度就可以了，只要Go标准库支持了，delve设计实现就会去向Go标准库靠拢，这个肯定是没问题的。但是Go标准库还没支持的，或者不打算支持的，那就得delve开发者先自己实现、验证，然后再反馈给Go编译工具链开发者，共建的形式来完善。这部分也是一个不断优化的过程，比如现在或者以后会继续向DWARF v5中的优秀特性看齐，这部分处理逻辑还会不断优化。

我们理解这个共建过程就可以了，我们自己实现调试器时，可以参考delve调试器当前的最佳实践来实现。

#### understand delve pkg/dwarf

go-delve/delve里面dwarf操作相关的部分主要是在package `pkg/dwarf`中，简单罗列下主要实现了什么。

- pkg/dwarf/util: 该package下有些代码是从go标准库里面copy过来修改的，比如 `pkg/dwarf/util/buf.go`大部分是标准库代码，只做了一点微调，增加了几个工具函数来读取变长编码的数值、读取字符串和编译单元开头的DWARF信息。

- pkg/dwarf/dwarfbuilder: 该package提供了一些工具类、工具函数来快速对DWARF信息进行编码，比如向.debug_info中增加编译单元、增加函数、增加变量、增加类型。还有就是往.debug_loc中增加LocEntry信息。
  go-delve/delve为什么要提供这样的package实现呢？我认为一方面go标准库没有提供这方面信息（工具链cmd/internal/dwarf虽有，前面讲了未纳入标准库、且难copy&paste后复用），对如何使用DWARF调试信息来完善地描述go程序构造等也没有那么高投入，go-delve/delve这里应该也是做了一部分这方面的探索，然后和go开发团队来协作共建的方式。所以这里维护这部分DWARF数据生成逻辑也就理解了。

- pkg/dwarf/frame: 这个package下提供了对.debug_frame、.zdebug_frame的解析，每个编译单元都有自己的.debug_frame，最后链接器将其合并成一个。对每个编译单元cu来说，都是先编码对应的CIE信息，然后再跟着编译单元cu中包含的FDE信息。然后再是下一个编译单元的CIE、FDEs……如此反复。对这部分信息，可以使用一个状态机来解析。

- pkg/dwarf/line: 这个package下提供了对.debug_line的解析，之所以自己实现，不用go标准库中的debug/gosym，前面已经提过很多次了，标准库实现只支持纯go代码，cgo代码不支持，缺失了这部分行表数据。之所以也不用标准库debug/dwarf，我认为也是delve的一种实现策略，相对来说，保证了delve实现DWARF解析、调试功能的完备性。

- pkg/dwarf/godwarf: 这里的代码，和go标准库debug/dwarf对比，有很多相似的地方，应该是在标准库基础上修改的。它主要是实现了DWARF信息的读取，并且支持ZLIB解压缩。以及为了支持DWARF v5中新增的.debug_addr增加的代码，.debug_addr有助于简化现有的重定位操作。还提供了对DWARF标准中规定的一些类型信息的读取。也支持.debug_info中DIE的读取解析，为了更方便使用，它将其组织成一棵DIE Tree的形式。

- pkg/dwarf/loclist: 同一个对象在其生命周期内，其位置有可能是会发生变化的，位置列表信息就是用来描述这种情况的。DWARF v2~v4都有这方面的描述，DWARF v5也有改进。

- pkg/dwarf/op: DWARF中定义了很多的操作指令，这个package主要是实现这些指令的操作。

- pkg/dwarf/reader: 在标准库dwarf.Reader上的进一步封装，以实现更加方便的DWARF信息访问。

- pkg/dwarf/util: 提供了一些DWARF数据解析需要用到的buffer实现，以及读取LEB128编解码、读取字符串表中字符串（以null结尾）的工具函数。

## 本文小结

后面我们将参考go-delve/delve/pkg/dwarf中的实现，用于我们这个调试器的DWARF数据的解析。在使用之前我会带领大家过一遍这部分代码的设计实现，做到知其然知其所以然，这样咱们用的才放心，才能说真正的“掌握”了。这部分代码与DWARF调试信息标准息息相关，如读者能够结合接下来一章DWARF标准的内容（或者手边常备DWARF v4/v5调试信息标准）来阅读，经常性的写点测试代码，然后看看生成的DWARF调试信息长什么样子，这样理解起来会更加顺利、透彻。

> 我们开发调试器实际上只需要读，但为了让大家更好理解DWARF像derekparker、arzillia大佬们那样能自如地扩展对Go新特性的支持、能和Go工具链核心团队协作共建，我们也要思考如何用DWARF去描述不同的程序构造的问题，所以生成DWARF数据咱们也要适当掌握。尽管看上去“枯燥"，枯燥是什么？我在整理这些看上去枯燥的文字的时候，从来没觉得枯燥。

接下来第8章中我们将介绍DWARF调试信息标准，第9章实现符号级调试器的功能，到时候我们“可能会”裁剪go-delve/delve，然后进行进一步的详细解释、示例代码演示。单单go-delve/delve/pkg/dwarf代码量就超过6500行，我们本就是出于学习交流的目的，为了节省本书篇幅、代码量，尽快让此书第1个完整版跟读者见面，我很可能会考虑裁剪delve代码的方式，比如保留大家都比较容易获得的linux+amd64环境下的实现，但是保留必要的抽象层次，这样大家还能了解到一个真正可用的调试器面临的更多挑战。

> 比如，删减其中与Linux ELF无关的一些代码，如某些与Windows PE、Darwin macho相关的代码，但是会保留对接不同平台、不同可执行程序文件格式的interface抽象。

这样一来可节省笔者时间，保证全书整体进度，不至于在过多的细节上耽搁太久，也能以更快的进度完成全书并开始勘误。沉淀知识使每位读者具备符号级调试器开发的能力，是我写作这本书始终不变的初衷。我们没有这样的必要性去0开始写一个DWARF读写库，希望读者们理解这么决策的原因。更何况这本电子书，已经经历过了太长的时间，它必须尽快出第1个完整版。也许在我们拥有更多贡献者以后，可以考虑提供一个更适合我们这个教程的比 `go-delve/delve/pkg/dwarf` 更精简的、恰到好处的实现。
