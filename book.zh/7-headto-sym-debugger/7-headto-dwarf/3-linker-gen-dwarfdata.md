## go tool link: 调试信息生成

### ld.Main()->dwarfGenerateDebugSyms()

下面是链接器生成所有DWARF调试信息的路径，

file: cmd/link/internal/ld/main.go

```go
func Main() {
    ...

    // entry1: generate dwarf data .debug_info for all types, variables, ...
    dwarfGenerateDebugInfo(ctxt)
    ...

    // entry2: generate dwarf data for all other .debug_ sections
    dwarfGenerateDebugSyms(ctxt)   
    ...

    // compress generated dwarf data
    dwarfcompress(ctxt) 
    ...
}
```

分析一下这两个函数的关系：

1. 从代码注释中可以看到这两个函数是 DWARF 调试信息生成的两个主要入口点：

```go
// dwarfGenerateDebugInfo generated debug info entries for all types,
// variables and functions in the program.
// Along with dwarfGenerateDebugSyms they are the two main entry points into
// dwarf generation: dwarfGenerateDebugInfo does all the work that should be
// done before symbol names are mangled while dwarfGenerateDebugSyms does
// all the work that can only be done after addresses have been assigned to
// text symbols.
```

2. 它们的主要区别在于执行时机和职责：

- `dwarfGenerateDebugInfo`:

  - 在符号名称被修改(mangled)之前执行 （源代码中的函数 `func Add(a, b int) int`，经过名称修饰后可能变成 `go.info.Add$main$int$int$int`）
  - 负责生成所有类型、变量和函数的调试信息条目
  - 主要处理 DWARF 信息的内容生成
- `dwarfGenerateDebugSyms`:

  - 在文本符号(text symbols)的地址被分配之后执行
  - 负责生成调试符号
  - 主要处理 DWARF 信息的布局和最终输出

3. 从 `main.go` 中的调用顺序可以看出它们的执行顺序：

```go
bench.Start("dwarfGenerateDebugInfo")
dwarfGenerateDebugInfo(ctxt)

// ... 中间有其他操作 ...

bench.Start("dwarfGenerateDebugSyms")
dwarfGenerateDebugSyms(ctxt)
```

4. 具体实现上：

- `dwarfGenerateDebugInfo` 主要做：

  - 初始化 DWARF 上下文
  - 生成类型信息
  - 处理编译单元
  - 收集变量和函数信息
- `dwarfGenerateDebugSyms` 主要做：

  - 生成 .debug_line、.debug_frame 和 .debug_loc 等调试段
  - 处理地址相关的信息
  - 最终输出调试信息

5. 它们共同完成 DWARF 调试信息的生成，但分成了两个阶段：
   - 第一阶段(`dwarfGenerateDebugInfo`)专注于内容的生成
   - 第二阶段(`dwarfGenerateDebugSyms`)专注于布局和输出

这种分阶段的设计使得 DWARF 调试信息的生成更加清晰和可控，同时也符合链接器的工作流程 - 先确定内容，再确定布局和地址。

### entry1: dwarfGenerateDebugInfo

```go
// dwarfGenerateDebugInfo generated debug info entries for all types,
// variables and functions in the program.
// Along with dwarfGenerateDebugSyms they are the two main entry points into
// dwarf generation: dwarfGenerateDebugInfo does all the work that should be
// done before symbol names are mangled while dwarfGenerateDebugSyms does
// all the work that can only be done after addresses have been assigned to
// text symbols.
func dwarfGenerateDebugInfo(ctxt *Link) {
    ...

    d := &dwctxt{
        linkctxt: ctxt,
        ldr:      ctxt.loader,
        arch:     ctxt.Arch,
        tmap:     make(map[string]loader.Sym),
        tdmap:    make(map[loader.Sym]loader.Sym),
        rtmap:    make(map[loader.Sym]loader.Sym),
    }
    ...
    // traverse the []*sym.Library
    for _, lib := range ctxt.Library {

        consts := d.ldr.Lookup(dwarf.ConstInfoPrefix+lib.Pkg, 0)
        // traverse the []*sym.CompilationUnit
        for _, unit := range lib.Units {
            // We drop the constants into the first CU.
            if consts != 0 {
                unit.Consts = sym.LoaderSym(consts)
                d.importInfoSymbol(consts)
                consts = 0
            }
            ctxt.compUnits = append(ctxt.compUnits, unit)
            ...
            newattr(unit.DWInfo, dwarf.DW_AT_comp_dir, dwarf.DW_CLS_STRING, int64(len(compDir)), compDir)
            ...
            newattr(unit.DWInfo, dwarf.DW_AT_go_package_name, dwarf.DW_CLS_STRING, int64(len(pkgname)), pkgname)
            ...
            // Scan all functions in this compilation unit, create
            // DIEs for all referenced types, find all referenced
            // abstract functions, visit range symbols. Note that
            // Textp has been dead-code-eliminated already.
            for _, s := range unit.Textp {
                d.dwarfVisitFunction(loader.Sym(s), unit)
            }
        }
    }

    // Make a pass through all data symbols, looking for those
    // corresponding to reachable, Go-generated, user-visible
    // global variables. For each global of this sort, locate
    // the corresponding compiler-generated DIE symbol and tack
    // it onto the list associated with the unit.
    // Also looks for dictionary symbols and generates DIE symbols for each
    // type they reference.
    for idx := loader.Sym(1); idx < loader.Sym(d.ldr.NDef()); idx++ {
        if !d.ldr.AttrReachable(idx) ||
            d.ldr.AttrNotInSymbolTable(idx) ||
            d.ldr.SymVersion(idx) >= sym.SymVerStatic {
            continue
        }
        t := d.ldr.SymType(idx)
        switch t {
        case sym.SRODATA, sym.SDATA, sym.SNOPTRDATA, sym.STYPE, sym.SBSS, sym.SNOPTRBSS, sym.STLSBSS:
            // ok
        default:
            continue
        }
        // Skip things with no type, unless it's a dictionary
        gt := d.ldr.SymGoType(idx)
        if gt == 0 {
            if t == sym.SRODATA {
                if d.ldr.IsDict(idx) {
                    // This is a dictionary, make sure that all types referenced by this dictionary are reachable
                    relocs := d.ldr.Relocs(idx)
                    for i := 0; i < relocs.Count(); i++ {
                        reloc := relocs.At(i)
                        if reloc.Type() == objabi.R_USEIFACE {
                            d.defgotype(reloc.Sym())
                        }
                    }
                }
            }
            continue
        }
        ...

        // Find compiler-generated DWARF info sym for global in question,
        // and tack it onto the appropriate unit.  Note that there are
        // circumstances under which we can't find the compiler-generated
        // symbol-- this typically happens as a result of compiler options
        // (e.g. compile package X with "-dwarf=0").
        varDIE := d.ldr.GetVarDwarfAuxSym(idx)
        if varDIE != 0 {
            unit := d.ldr.SymUnit(idx)
            d.defgotype(gt)
            unit.VarDIEs = append(unit.VarDIEs, sym.LoaderSym(varDIE))
        }
    }

    d.synthesizestringtypes(ctxt, dwtypes.Child)
    d.synthesizeslicetypes(ctxt, dwtypes.Child)
    d.synthesizemaptypes(ctxt, dwtypes.Child)
    d.synthesizechantypes(ctxt, dwtypes.Child)
}
```

### entry2: dwarfGenerateDebugSyms

```go
// dwarfGenerateDebugSyms constructs debug_line, debug_frame, and
// debug_loc. It also writes out the debug_info section using symbols
// generated in dwarfGenerateDebugInfo2.
func dwarfGenerateDebugSyms(ctxt *Link) {
    if !dwarfEnabled(ctxt) {
        return
    }
    d := &dwctxt{
        linkctxt: ctxt,
        ldr:      ctxt.loader,
        arch:     ctxt.Arch,
        dwmu:     new(sync.Mutex),
    }
    d.dwarfGenerateDebugSyms()
}
```

### ld.Main()→dwarfcompress(*Link)

**linker对dwarf调试信息进行必要的压缩**

```go
// dwarfcompress compresses the DWARF sections. Relocations are applied
// on the fly. After this, dwarfp will contain a different (new) set of
// symbols, and sections may have been replaced.
func dwarfcompress(ctxt *Link) {
    ...
}
```
