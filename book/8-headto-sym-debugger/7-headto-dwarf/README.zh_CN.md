## 挺近DWARF

### debug/dwarf

在前面的小节中，我们介绍了go标准库`debug/elf`对读取elf文件的支持，介绍了`debug/gosym`对运行时行号表信息的解析应用，还介绍了`debug/dwarf`对DWARF调试信息的解析应用。

我们有提到`debug/dwarf`只支持部分调试信息的解析，包括：

- .debug_abbrev，描述一些缩写信息，info section中会引用；

- .debug_info，描述编译单元、类型、变量、函数；

  > .debug_types section也可以保存类型描述信息，何时需将类型描述放在types section？
  >
  > 有些情况下，一个类型在多个编译单元中出现，可能会造成多个编译单元重复生成类型对应的调试信息，导致二进制文件尺寸偏大，此时可以考虑将该类型的描述从.debug_info section转移到.debug_types section，并利用链接器COMPAT模式，减少文件尺寸。

- .debug_str，描述字符串表，info section中会引用；

- .debug_line，描述行号表信息；

- .debug_ranges，查询表，用于在pc和编译单元之间映射；

关于支持哪些调试信息，哪些不支持，这点我们可以从下面的go源码看出来。

**src/debug/elf/file.go**

```go
func (f *File) DWARF() (*dwarf.Data, error) {
	dwarfSuffix := func(s *Section) string {
		// 去掉.debug_/.zdebug_后的后缀
	}
	// sectionData gets the data for s, checks its size, and
	// applies any applicable relations.
	sectionData := func(i int, s *Section) ([]byte, error) {
		// 读取section数据
        // 如果是zlib压缩数据，则执行对应解压缩
        // 如果是需要重定位的，则执行重定位操作
        // 返回处理后section数据
	}

	// debug/dwarf package当前只支持处理这些sections
	var dat = map[string][]byte{"abbrev": nil, "info": nil, "str": nil, "line": nil, "ranges": nil}
	for i, s := range f.Sections {
		suffix := dwarfSuffix(s)
		if _, ok := dat[suffix]; !ok {
			continue
		}
		b, err := sectionData(i, s)
        ...
		dat[suffix] = b
	}

    // 注意，nil对应的参数，debug/dwarf当前并不支持解析
	d, err := dwarf.New(dat["abbrev"], nil, nil, dat["info"], dat["line"], nil, dat["ranges"], dat["str"])
	...

	// 继续处理，DWARF4 .debug_types sections and DWARF5 sections.
	for i, s := range f.Sections {
        ...
	}

	return d, nil
}
```

 `debug/dwarf` 确实实现了部分调试信息的解析，但另一方面，调试器还需要其他信息的支持，如调用栈信息.debug_frame、位置列表信息.debug_loc等等，这些信息标准库并没有提供解析的能力，需要自己动手编码实现了。

### cmd/internal/dwarf

除了debug/dwarf这个package，go编译工具链`src/cmd/internal/dwarf`中也包含了一部分DWARF相关的信息：

- dwarf_defs.go，定义了DWARF中的一些常量，DW_TAG类型、DW_CLS类型、DW_AT属性类型、DW_FORM编码形式、DW_OP操作指令、DW_ATE属性编码类型、DW_ACCESS访问修饰、DW_VIS可见性修饰、DW_VIRTUALITY虚函数修饰、DW_LANG语言类型（go是22）、DW_INL内联类型、DW_ORD按行（列）主序、DW_LNS行号表操作指令、DW_MACINFO宏定义操作、DW_CFA调用栈信息表操作，等等；

  这些定义在`go-delve/delve`中被归类到了不同的package中，这样更清晰一点。

- dwarf.go，定义了一些生成、编码DWARF调试信息的公共代码，DWARF调试信息的生成是由编译器和链接器完成的，dwarf.go中的公共代码在编译器、链接器中都有使用。

  该文件中给出了一些对调试器开发很有帮助的信息，比如缩写表中定义了描述不同的程序构造对应的属性列表，如描述一个subprogram需要哪些属性信息。

即使这里的代码比较有意义，我们也很难复用，因为它是放在internal下，专门给go编译工具链使用的。即便要用，也要copy、paste再改造。

## go-delve/delve

### dwarf解析变化

以流行的go调试器`go-delve/delve`为例，它是如何处理DWARF调试信息的呢？有没有使用标准库呢？为了求证这几点，可以在git仓库下执行 `git log -S "DWARF()"`来搜索下提交记录，找到几条关键信息：

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

2. delve开发者发现使用`debug/dwarf`解析某些类型信息存在问题，于是使用package `x/debug/dwarf`予以了替换，临时先应付下这个问题。现在再看`x/debug/dwarf`这个package，发现之前的一些源文件不见了，因为它已经被迁移到go源码树中。

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

3. 后面 `debug/dwarf`修复了之前存在的问题，delve又从`x/debug/dwarf`替换回了`debug/dwarf`。

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

总之标准库对调试信息的读取解析支持有限，go、delve都在快速演进中，很明显delve对DWARF的需求是明显比go本身强烈的。delve一开始使用标准库，后面发现有局限性，于是开始自己重写DWARF调试信息的读取解析。当然这个重写的过程中，也有借鉴go标准库中的实现，go编译工具链也有收到delve开发者的DWARF调试信息生成的优化建议。

### dwarf解析介绍

go-delve/delve里面dwarf操作相关的部分主要是在package `pkg/dwarf`中。

- pkg/dwarf/util

  其中有些代码是从go标准库里面copy过来修改的，比如`pkg/dwarf/util/buf.go`大部分是标准库代码，只做了一点微调、加减了几个方法。

  `pkg/dwarf/util/util.go`则增加了几个工具函数，用来读取变长编码的数值，以及读取字符串和编译单元开头的DWARF信息。

- pkg/dwarf/dwarfbuilder

  这个package下的代码提供了一些工具类、工具函数来快速对DWARF信息进行编码，比如向.debug_info中增加编译单元、增加函数、增加变量、增加类型。还有就是往.debug_loc中增加LocEntry信息。

  go-delve/delve为什么要提供这样的package实现呢？我认为一方面go标准库没有提供这方面信息，对如何使用DWARF调试信息来完善地描述go类型系统等等也没有快速地跟进，go-delve/delve这里应该也是做了一部分这方面的探索，然后和go开发团队来协调共建的方式。最后go编译工具链团队可能采纳了这里的某些描述方法。

- pkg/dwarf/frame

  这个package下提供了对.debug_frame、.zdebug_frame的解析，每个编译单元都有自己的.debug_frame，最后链接器将其合并成一个。对每个编译单元cu来说，都是先编码对应的CIE信息，然后再跟着编译单元cu中包含的FDE信息。然后再是下一个编译单元的CIE、FDEs……如此反复。对这部分信息，可以使用一个状态机来解析。

- pkg/dwarf/line

  这个package下提供了对.debug_line的解析，之所以自己实现，不用go标准库中的debug/gosym，前面已经提过很多次了，标准库实现只支持纯go代码，cgo代码不支持，缺失了这部分行表数据。之所以也不用标准库debug/dwarf，我认为也是delve的一种实现策略，相对来说，保证了delve调试器实现DWARF解析的完整性。

- pkg/dwarf/godwarf

  这里的代码，和go标准库debug/dwarf对比，有很多相似的地方，应该是在标准库基础上修改的。它主要是实现了DWARF信息的读取，并且支持ZLIB解压缩。以及为了支持DWARF v5中新增的.debug_addr增加的代码，.debug_addr有助于简化现有的重定位操作。还提供了对DWARF标准中规定的一些类型信息的读取。也支持.debug_info中DIE的读取解析，为了更方便使用，它将其组织成一棵DIE Tree的形式。

- pkg/dwarf/loclist

  同一个对象在其生命周期内，其位置有可能是会发生变化的，位置列表信息就是用来描述这种情况的。DWARF v2~v4都有这方面的描述，DWARF v5也有改进。

- pkg/dwarf/op

  DWARF中定义了很多的操作指令，这个package主要是实现这些指令的操作。

- pkg/dwarf/reader

  在标准库dwarf.Reader上的进一步封装，以实现更加方便的DWARF信息访问。

- pkg/dwarf/util

  提供了一些DWARF数据解析需要用到的buffer实现，以及读取LEB128编解码、读取字符串表中字符串（以null结尾）的工具函数。

## 本文小结

后面我们将参考go-delve/delve中的实现来实现自己的DWARF解析部分，并用它来辅助我们后续的调试器开发过程。实际上，这部分代码与DWARF调试信息标准息息相关，如读者能够结合前面介绍的DWARF标准的内容或者手边常备DWARF v4/v5调试信息标准来阅读，理解起来会更加顺利、透彻。

由于这部分代码量会偏多，实现起来也略显枯燥，我们可能会借用go-delve/delve中的部分解析代码，并删减关系不是很紧密的代码（如与ELF无关的PE、Macho文件操作代码），然后结合标准进行进一步的详细解释、示例代码演示。

这样一来可节省笔者时间，保证全书整体进度，不至于在过多的细节上耽搁太久，也能以更快的进度完成全书并开始勘误。尽管如此，沉淀知识使每位读者具备调试器开发的能力，是我写作这本书始终不变的初衷。关于《挺近DWARF》的介绍部分，就介绍到这里。

忍不住回头看下与读者朋友一起走过的路：

- 一起浏览了DWARF调试信息标准，大致掌握了其描述代码和数据的方式；
- 一起实现了指令级调试器，了解了调试的底层工作原理；
- 一起了解了go语言调试相关的部分源码，了解了大致的历史；
- 还以业界流行的go-delve/delve调试器作为参考，了解了其对dwarf的运用；

读者朋友能够坚持到现在，相信已经没什么可畏惧的了。下面我们将进一步走进DWARF，认识DWARF中精心编码的源码信息，也一窥DWARF标准委员会高屋建瓴的抽象建模能力。

