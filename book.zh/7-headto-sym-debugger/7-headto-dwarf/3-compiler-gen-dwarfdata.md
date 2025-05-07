## go tool compile: DWARF调试信息生成

### gc.Main()→dwarfgen.RecordFlags()

**记录当前构建信息到dwarf调试信息中去，方便调试器调试时查看tracee的构建细节**

```go
这个函数的主要目的是将编译器的命令行参数记录到 DWARF 调试信息中。DWARF 是一种调试信息格式，用于帮助调试器理解程序的内部结构。具体来说：
1. 函数接收一系列标志名称作为参数，这些标志是编译器命令行参数
2. 对于每个标志，函数会：
    - 检查标志是否存在
    - 检查标志值是否与默认值不同（如果相同则跳过）
    - 根据标志类型（布尔型、计数型或普通型）以不同格式记录到缓冲区中
3. 特殊处理：
    - 对于布尔型标志（如 -race），如果值为 true，只记录标志名
    - 对于计数型标志（如 -v），如果值为 1，只记录标志名
    - 对于其他标志，记录标志名和值（如 -gcflags="-N -l"）
4. 最后，这些参数会被存储在一个特殊的符号中：
    - 符号名格式为 dwarf.CUInfoPrefix + "producer." + base.Ctxt.Pkgpath
    - 符号类型设置为 objabi.SDWARFCUINFO（表示这是编译单元信息）
    - 允许重复（因为测试时可能会链接多个 main 包）
    - 将参数信息存储在符号的数据中
这样做的目的是让调试器能够知道程序是如何被编译的，这对于调试和问题诊断很有帮助。比如，如果程序是用 -race 编译的，调试器就能知道这是一个竞态检测版本的程序。
这个信息会被写入到最终的可执行文件中，作为 DWARF 调试信息的一部分。当使用调试器（如 GDB）时，这些信息可以帮助开发者更好地理解程序的编译环境和配置。
```

### gc.Main()→dwarf flags设置

**根据命令行参数设置对应的dwarf设置**

```go
if base.Flag.Dwarf {
    base.Ctxt.DebugInfo = dwarfgen.Info
    base.Ctxt.GenAbstractFunc = dwarfgen.AbstractFunc
    base.Ctxt.DwFixups = obj.NewDwarfFixupTable(base.Ctxt)
} else {
    // turn off inline generation if no dwarf at all
    base.Flag.GenDwarfInl = 0
    base.Ctxt.Flag_locationlists = false
}
if base.Ctxt.Flag_locationlists && len(base.Ctxt.Arch.DWARFRegisters) == 0 {
    log.Fatalf("location lists requested but register mapping not available on %v", base.Ctxt.Arch.Name)
}
if base.Flag.Dwarf {
    dwarf.EnableLogging(base.Debug.DwarfInl != 0)
}
```

### gc.Main()→dwarfgen.RecordPackageName()

**记录下当前编译单元的PackageName，记录在哪呢？生成一个符号表符号，类型为SDWARFCUINFO**

```go
// RecordPackageName records the name of the package being
// compiled, so that the linker can save it in the compile unit's DIE.
func RecordPackageName() {
    s := base.Ctxt.Lookup(dwarf.CUInfoPrefix + "packagename." + base.Ctxt.Pkgpath)
    s.Type = objabi.SDWARFCUINFO
    // Sometimes (for example when building tests) we can link
    // together two package main archives. So allow dups.
    s.Set(obj.AttrDuplicateOK, true)
    base.Ctxt.Data = append(base.Ctxt.Data, s)
    s.P = []byte(types.LocalPkg.Name)
}
```

### gc.Main()→dumpGlobal(n)/dumpGlobalConst(n)

**将当前localpackage中的全局变量、常量生成到dwarf调试信息**

```go
for nextFunc, nextExtern := 0, 0; ; {
        ...
        if nextExtern < len(typecheck.Target.Externs) {
            switch n := typecheck.Target.Externs[nextExtern]; n.Op() {
            case ir.ONAME:
                dumpGlobal(n)
            case ir.OLITERAL:
                dumpGlobalConst(n)
            ...
            }
            nextExtern++
            continue
        }
        ...
}

func dumpGlobal(n *ir.Name) {
    ...
    if n.Class == ir.PFUNC { return    }
    if n.Sym().Pkg != types.LocalPkg { return }
    ...
    base.Ctxt.DwarfGlobal(types.TypeSymName(n.Type()), n.Linksym())
}

// DwarfGlobal creates a link symbol containing a DWARF entry for
// a global variable.
func (ctxt *Link) DwarfGlobal(typename string, varSym *LSym) {
    myimportpath := ctxt.Pkgpath
    if myimportpath == "" || varSym.Local() {
        return
    }
    varname := varSym.Name
    dieSym := &LSym{
        Type: objabi.SDWARFVAR,
    }
    varSym.NewVarInfo().dwarfInfoSym = dieSym
    ctxt.Data = append(ctxt.Data, dieSym)
    typeSym := ctxt.Lookup(dwarf.InfoPrefix + typename)
    dwarf.PutGlobal(dwCtxt{ctxt}, dieSym, typeSym, varSym, varname)
}

// PutGlobal writes a DIE for a global variable.
func PutGlobal(ctxt Context, info, typ, gvar Sym, name string) {
    Uleb128put(ctxt, info, DW_ABRV_VARIABLE)
    putattr(ctxt, info, DW_ABRV_VARIABLE, DW_FORM_string, DW_CLS_STRING, int64(len(name)), name)
    putattr(ctxt, info, DW_ABRV_VARIABLE, DW_FORM_block1, DW_CLS_ADDRESS, 0, gvar)
    putattr(ctxt, info, DW_ABRV_VARIABLE, DW_FORM_ref_addr, DW_CLS_REFERENCE, 0, typ)
    putattr(ctxt, info, DW_ABRV_VARIABLE, DW_FORM_flag, DW_CLS_FLAG, 1, nil)
}

func dumpGlobalConst(n *ir.Name) {
    ...
    base.Ctxt.DwarfIntConst(n.Sym().Name, types.TypeSymName(t), ir.IntVal(t, v))
}

// DwarfIntConst creates a link symbol for an integer constant with the
// given name, type and value.
func (ctxt *Link) DwarfIntConst(name, typename string, val int64) {
    myimportpath := ctxt.Pkgpath
    if myimportpath == "" {
        return
    }
    s := ctxt.LookupInit(dwarf.ConstInfoPrefix+myimportpath, func(s *LSym) {
        s.Type = objabi.SDWARFCONST
        ctxt.Data = append(ctxt.Data, s)
    })
    dwarf.PutIntConst(dwCtxt{ctxt}, s, ctxt.Lookup(dwarf.InfoPrefix+typename), myimportpath+"."+name, val)
}

// PutIntConst writes a DIE for an integer constant
func PutIntConst(ctxt Context, info, typ Sym, name string, val int64) {
    Uleb128put(ctxt, info, DW_ABRV_INT_CONSTANT)
    putattr(ctxt, info, DW_ABRV_INT_CONSTANT, DW_FORM_string, DW_CLS_STRING, int64(len(name)), name)
    putattr(ctxt, info, DW_ABRV_INT_CONSTANT, DW_FORM_ref_addr, DW_CLS_REFERENCE, 0, typ)
    putattr(ctxt, info, DW_ABRV_INT_CONSTANT, DW_FORM_sdata, DW_CLS_CONSTANT, val, nil)
}
```

### gc.Main()→enqueueFunc(f)+compilequeue

```bash
gc.Main()
   \-> enqueueFunc 
         \-> compileFunctions 
               \-> compile 
                     \-> (*Progs).FLush
                             \-> (*Progs).Flushplist
                                   \-> (*Link).populateDWARF
```

OK，详细展开看看：

```go
func gc.Main(...) {
    ...
    for nextFunc, nextExtern := 0, 0; ; {
        if nextFunc < len(typecheck.Target.Funcs) {
            enqueueFunc(typecheck.Target.Funcs[nextFunc])
            nextFunc++
            continue
        }
  
        // The SSA backend supports using multiple goroutines, so keep it
        // as late as possible to maximize how much work we can batch and
        // process concurrently.
        if len(compilequeue) != 0 {
            compileFunctions(profile)
            continue
        }
        ...
  
        // Finalize DWARF inline routine DIEs, then explicitly turn off
        // further DWARF inlining generation to avoid problems with
        // generated method wrappers.
        //
        // Note: The DWARF fixup code for inlined calls currently doesn't
        // allow multiple invocations, so we intentionally run it just
        // once after everything else. Worst case, some generated
        // functions have slightly larger DWARF DIEs.
        if base.Ctxt.DwFixups != nil {
            base.Ctxt.DwFixups.Finalize(base.Ctxt.Pkgpath, base.Debug.DwarfInl != 0)
            base.Ctxt.DwFixups = nil
            base.Flag.GenDwarfInl = 0
            continue // may have called reflectdata.TypeLinksym (#62156)
        }
        ...
    }
}

// 递归地分析fn中的body，如果内部还有新创建的fn将继续假如compilequeue
func enqueueFunc(fn *ir.Func) {
    todo := []*ir.Func{fn}
    for len(todo) > 0 {
        next := todo[len(todo)-1]
        todo = todo[:len(todo)-1]

        prepareFunc(next)
        todo = append(todo, next.Closures...)
    }
    ...

    // Enqueue just fn itself. compileFunctions will handle
    // scheduling compilation of its closures after it's done.
    compilequeue = append(compilequeue, fn)
}

// compileFunctions compiles all functions in compilequeue.
// It fans out nBackendWorkers to do the work
// and waits for them to complete.
func compileFunctions(profile *pgoir.Profile) {
    ...
    var compile func([]*ir.Func)
    compile = func(fns []*ir.Func) {
        for _, fn := range fns {
            fn := fn
            queue(func(worker int) {
                ssagen.Compile(fn, worker, profile)
                compile(fn.Closures)
            })
        }
    }
    ...
    compile(compilequeue)
}

// Compile builds an SSA backend function,
// uses it to generate a plist,
// and flushes that plist to machine code.
// worker indicates which of the backend workers is doing the processing.
func Compile(fn *ir.Func, worker int, profile *pgoir.Profile) {
    f := buildssa(fn, worker, inline.IsPgoHotFunc(fn, profile) || inline.HasPgoHotInline(fn))
    ...
    pp := objw.NewProgs(fn, worker)
    defer pp.Free()
    genssa(f, pp)
    ...
    pp.Flush() // assemble, fill in boilerplate, etc.
    ...
}

// Flush converts from pp to machine code.
func (pp *Progs) Flush() {
    plist := &obj.Plist{Firstpc: pp.Text, Curfn: pp.CurFunc}
    obj.Flushplist(base.Ctxt, plist, pp.NewProg)
}

func Flushplist(ctxt *Link, plist *Plist, newprog ProgAlloc) {
    ...
    ctxt.populateDWARF(plist.Curfn, s)
    ...
}

// populateDWARF fills in the DWARF Debugging Information Entries for
// TEXT symbol 's'. The various DWARF symbols must already have been
// initialized in InitTextSym.
func (ctxt *Link) populateDWARF(curfn Func, s *LSym) {
    // see more details below
    ...
}
```

### (*Link).populateDWARF(Func, *LSym)

```go
// populateDWARF fills in the DWARF Debugging Information Entries for
// TEXT symbol 's'. The various DWARF symbols must already have been
// initialized in InitTextSym.
func (ctxt *Link) populateDWARF(curfn Func, s *LSym) {
    ...
    info, loc, ranges, absfunc, lines := ctxt.dwarfSym(s)
    ...
    var scopes []dwarf.Scope
    var inlcalls dwarf.InlCalls
    if ctxt.DebugInfo != nil {
        scopes, inlcalls = ctxt.DebugInfo(s, info, curfn)
    }
    var err error
    dwctxt := dwCtxt{ctxt}
    startPos := ctxt.InnermostPos(textPos(s))
    ...
    fnstate := &dwarf.FnState{
        Name:          s.Name,
        Info:          info,
        Loc:           loc,
        Ranges:        ranges,
        Absfn:         absfunc,
        StartPC:       s,
        Size:          s.Size,
        StartPos:      startPos,
        External:      !s.Static(),
        Scopes:        scopes,
        InlCalls:      inlcalls,
        UseBASEntries: ctxt.UseBASEntries,
    }
    if absfunc != nil {
        err = dwarf.PutAbstractFunc(dwctxt, fnstate)
        if err != nil {
            ctxt.Diag("emitting DWARF for %s failed: %v", s.Name, err)
        }
        err = dwarf.PutConcreteFunc(dwctxt, fnstate, s.Wrapper())
    } else {
        err = dwarf.PutDefaultFunc(dwctxt, fnstate, s.Wrapper())
    }
    if err != nil {
        ctxt.Diag("emitting DWARF for %s failed: %v", s.Name, err)
    }
    // Fill in the debug lines symbol.
    ctxt.generateDebugLinesSymbol(s, lines)
}

func PutAbstractFunc(ctxt Context, s *FnState) error {...}
func putAbstractVar(...)
func putAbstractVarAbbrev(...)
func putattr(...)
...
// 将函数声明记录到dwarf信息中
func PutConcreteFunc(ctxt Context, s *FnState, isWrapper bool) error {...}
func putattr(...)
func concreteVar(...)
func inlinedVarTable(...)
func putparamtypes(...)
...
// 这些函数是将函数体中不同作用域的变量给记录到dwarf信息中
func putPrunedScopes(...)
func putscope(...)
func putparamtypes(...)
...
func putInlinedFunc(...)
...
func Uleb128put(...)
...
// 将函数体中的语句的pc值变化、行号值变化记录到dwarf行号信息表中
func generateDebugLinesSymbol(...)
func putpclcdelta(...) // pc< delta <-> ln delta
```

### gc.Main()→ foreach func → (*DwarfFixupTable).Finalize()

**貌似是有引用某些内联函数中定义的局部变量，此时可能需要这里处理下**

```go
// Called after all functions have been compiled; the main job of this
// function is to identify cases where there are outstanding fixups.
// This scenario crops up when we have references to variables of an
// inlined routine, but that routine is defined in some other package.
// This helper walks through and locate these fixups, then invokes a
// helper to create an abstract subprogram DIE for each one.
func (ft *DwarfFixupTable) Finalize(myimportpath string, trace bool) {
    ...
    // Collect up the keys from the precursor map, then sort the
    // resulting list (don't want to rely on map ordering here).
    fns := make([]*LSym, len(ft.precursor))
    idx := 0
    for fn := range ft.precursor {
        fns[idx] = fn
        idx++
    }
    sort.Sort(BySymName(fns))
    ...

    // Generate any missing abstract functions.
    for _, s := range fns {
        absfn := ft.AbsFuncDwarfSym(s)
        slot, found := ft.symtab[absfn]
        if !found || !ft.svec[slot].defseen {
            ft.ctxt.GenAbstractFunc(s)
        }
    }

    // Apply fixups.
    for _, s := range fns {
        absfn := ft.AbsFuncDwarfSym(s)
        slot, found := ft.symtab[absfn]
        if !found {
            ft.ctxt.Diag("internal error: DwarfFixupTable.Finalize orphan abstract function for %v", s)
        } else {
            ft.processFixups(slot, s)
        }
    }
}
```

### DWARF数据最终记录在哪里了？

OK, 先说结论，实际上是编译器将这些待生成的某个程序构造（类型定义、变量定义、常量定义、函数定义等）都用一个link.LSym来表示，将其符号类型设置为link.LSym.Type=SDWARFXXX类型，并且根据语言设计以及DWARF调试信息标准，根据多方约定好的生成方式（比如与链接器、调试器维护者沟通好），将该程序构造对应的DWARF编码数据写入到link.LSym.P中。

file: cmd/internal/obj/link.go

```go
// An LSym is the sort of symbol that is written to an object file.
// It represents Go symbols in a flat pkg+"."+name namespace.
type LSym struct {
    Name string
    Type objabi.SymKind // <= 这里的类型为DWARF符号类型，
                        //    1) 将来链接器会将其统一生成到.debug_ 相关的sections
                        //    2) 那是不是所有DWARF信息都是通过LSym记录的呢？
                        //       可以这么说！链接器负责整合、再加工这些信息，然后生成到.debug_ sections,
                        //       比如典型的.debug_frames，编译器记录函数相关的LSym，
                        //     
    Attribute

    Size   int64
    Gotype *LSym
    P      []byte       // <= DWARF编码数据会记录在这里
    R      []Reloc

    Extra *interface{} // *FuncInfo, *VarInfo, *FileInfo, or *TypeInfo, if present

    Pkg    string
    PkgIdx int32
    SymIdx int32
}
```

file: cmd/internal/dwarf/dwarf.go

```go
func (ctxt *Link) DwarfAbstractFunc(curfn Func, s *LSym) {
    ...
    if err := dwarf.PutAbstractFunc(dwctxt, &fnstate); err != nil {
        ctxt.Diag("emitting DWARF for %s failed: %v", s.Name, err)
    }
}

// Emit DWARF attributes and child DIEs for an 'abstract' subprogram.
// The abstract subprogram DIE for a function contains its
// location-independent attributes (name, type, etc). Other instances
// of the function (any inlined copy of it, or the single out-of-line
// 'concrete' instance) will contain a pointer back to this abstract
// DIE (as a space-saving measure, so that name/type etc doesn't have
// to be repeated for each inlined copy).
func PutAbstractFunc(ctxt Context, s *FnState) error {
    if logDwarf {
        ctxt.Logf("PutAbstractFunc(%v)\n", s.Absfn)
    }

    abbrev := DW_ABRV_FUNCTION_ABSTRACT
    Uleb128put(ctxt, s.Absfn, int64(abbrev))
    ...
}

// Uleb128put appends v to s using DWARF's unsigned LEB128 encoding.
func Uleb128put(ctxt Context, s Sym, v int64) {
    b := sevenBitU(v)
    if b == nil {
        var encbuf [20]byte
        b = AppendUleb128(encbuf[:0], uint64(v))
    }
    ctxt.AddBytes(s, b)
}
```

file: cmd/internal/obj/dwarf.go

```go
// A Context specifies how to add data to a Sym.
type Context interface {
    PtrSize() int
    Size(s Sym) int64
    AddInt(s Sym, size int, i int64)
    AddBytes(s Sym, b []byte)
    AddAddress(s Sym, t interface{}, ofs int64)
    AddCURelativeAddress(s Sym, t interface{}, ofs int64)
    AddSectionOffset(s Sym, size int, t interface{}, ofs int64)
    AddDWARFAddrSectionOffset(s Sym, t interface{}, ofs int64)
    CurrentOffset(s Sym) int64
    RecordDclReference(from Sym, to Sym, dclIdx int, inlIndex int)
    RecordChildDieOffsets(s Sym, vars []*Var, offsets []int32)
    AddString(s Sym, v string)
    Logf(format string, args ...interface{})
}

func (c dwCtxt) AddBytes(s dwarf.Sym, b []byte) {
    ls := s.(*LSym)
    ls.WriteBytes(c.Link, ls.Size, b)
}
```

file: cmd/internal/obj/data.go

```go
// WriteBytes writes a slice of bytes into s at offset off.
func (s *LSym) WriteBytes(ctxt *Link, off int64, b []byte) int64 {
    s.prepwrite(ctxt, off, len(b))
    copy(s.P[off:], b)
    return off + int64(len(b))
}
```
