### 挺近DWARF

在前面的小节中，我们介绍了go标准库`debug/elf`对读取elf文件的支持，介绍了`debug/gosym`对运行时行号表信息的解析应用，还介绍了`debug/dwarf`对DWARF调试信息的解析应用。

我们有提到`debug/dwarf`只支持部分调试信息sections的解析，包括（省略前缀）：

- abbrev，描述一些缩写信息，info section中会引用；

- info，描述编译单元、类型、变量、函数；

  > types section也可以保存类型描述信息，何时需将类型描述放在types section？
  >
  > 有些情况下，一个类型在多个编译单元中出现，可能会造成多个编译单元重复生成类型对应的调试信息，导致二进制文件尺寸偏大，此时可以考虑将该类型的描述从Info section转移到types section，利用链接器COMPAT模式，减少文件尺寸。

- str，描述字符串表，info section中会引用；

- line，描述行号表信息；

- ranges，查询表，用于在pc和编译单元之间映射；

这点可以从源码 `debug/elf/file.go` 中看出来：

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

这就有点尴尬了，一方面 `debug/dwarf` 确实实现了部分调试信息的解析，可以拿来复用，另一方面，调试器又不止是依赖这点调试信息，还需要其他信息的支持，如调用栈信息，这部分还得单独编码实现。

`go-delve/delve` 中是如何处理DWARF调试信息的，没有使用标准库吗？来看点历史，我们使用命令 `git log -S "DWARF()"`来搜索下提交记录，找到几条关键信息：

1. 最开始也是使用的标准库 `debug/dwarf`

   ```bash
   commit f1e5a70a4b58e9caa4b40a0493bfb286e99789b9
   Author: Derek Parker <parkerderek86@gmail.com>
   Date:   Sat Sep 13 12:28:46 2014 -0500
   
   Update for Go 1.3.1
   
   I decided to vendor all debug/dwarf and debug/elf files so that the
   project can be go get-table. All changes that I am waiting to land in Go
   1.4 are now captured in /vendor/debug/*.
   ```

2. 后面发现 `debug/dwarf`有些问题，使用`x/debug/dwarf`予以替换

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

3. 后面 `debug/dwarf`修复了之前的问题，又替换回来了

   ```bash
   commit 1e3ff49610690e9890a669c95d903184baae1f4f
   Author: aarzilli <alessandro.arzilli@gmail.com>
   Date:   Mon May 29 15:20:01 2017 +0200
   
       pkg/dwarf/godwarf: split out type parsing from x/debug/dwarf
       
       Splits out type parsing and go-specific Type hierarchy from
       x/debug/dwarf, replace x/debug/dwarf with debug/dwarf everywhere,
       remove x/debug/dwarf from vendoring.
   ```

4. 有自己实现对debug_line的解析，并于标准库对比了结果

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

   为什么要自己实现呢？

5. 使用debug_line完全替换掉gosymtab/gopclntab

   ```bash
   commit 6d40517944d40113469b385784f47efa4a25080d
   Author: aarzilli <alessandro.arzilli@gmail.com>
   Date:   Fri Sep 1 15:30:45 2017 +0200
   
       proc: replace all uses of gosymtab/gopclntab with uses of debug_line
       
       gosymtab and gopclntab only contain informations about go code, linked
       C code isn't there, we should use debug_line instead to also cover C.
       
       Updates #935
   ```

6. ....

anyway，总之就是标准库实现比较鸡肋，并且标准库也是在演进中的，delve也是并发的开发中的，delve对dwarf的需求是明显走在go本身前面的。delve一开始有使用标准库，后面发现有局限性，开始参考了标准库的部分实现，然后开始自己写dwarf解析这块。并慢慢把需要用到的所有DWARF sections都实现了解析。

后面我们将参考go-delve/delve中的实现也实现自己的DWARF解析部分，并用它来辅助我们后续的调试器开发过程。

