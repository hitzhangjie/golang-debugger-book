## go tool link: 调试信息生成

### ld.Main()→dwarfGenerateDebugInfo(*Link)

**记录调试信息到.debug_info section**

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
