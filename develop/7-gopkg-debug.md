Here summarizes the supports provided by `golang/debug` package.

### debug/dwarf

#### const.go

```go
// An Attr identifies the attribute type in a DWARF Entry's Field.
type Attr uint32

const (
	AttrSibling        Attr = 0x01
	AttrLocation       Attr = 0x02
	AttrName           Attr = 0x03
	AttrOrdering       Attr = 0x09
	AttrByteSize       Attr = 0x0B
	AttrBitOffset      Attr = 0x0C
  ...
)

// A format is a DWARF data encoding format.
type format uint32

const (
	// value formats
	formAddr        format = 0x01
	formDwarfBlock2 format = 0x03
	formDwarfBlock4 format = 0x04
	formData2       format = 0x05
	formData4       format = 0x06
	...
)

// A Tag is the classification (the type) of an Entry.
type Tag uint32

const (
	TagArrayType              Tag = 0x01
	TagClassType              Tag = 0x02
	TagEntryPoint             Tag = 0x03
	TagEnumerationType        Tag = 0x04
	TagFormalParameter        Tag = 0x05
	...
)

// Location expression operators.
// The debug info encodes value locations like 8(R3)
// as a sequence of these op codes.
// This package does not implement full expressions;
// the opPlusUconst operator is expected by the type parser.
const (
	opAddr       = 0x03 /* 1 op, const addr */
	opDeref      = 0x06
	opConst1u    = 0x08 /* 1 op, 1 byte const */
	opConst1s    = 0x09 /*	" signed */
	...
	opDup        = 0x12
	opDrop       = 0x13
	opOver       = 0x14
	...
)

...
```

#### attr_string.go

```go
const _Attr_name = "SiblingLocationNameOrderingByteSizeBitOffsetBitSizeStmtListLowpcHighpcLanguageDiscrDiscrValueVisibilityImportStringLengthCommonRefCompDirConstValueContainingTypeDefaultValueInlineIsOptionalLowerBoundProducerPrototypedReturnAddrStartScopeStrideSizeUpperBoundAbstractOriginAccessibilityAddrClassArtificialBaseTypesCallingCountDataMemberLocDeclColumnDeclFileDeclLineDeclarationDiscrListEncodingExternalFrameBaseFriendIdentifierCaseMacroInfoNamelistItemPrioritySegmentSpecificationStaticLinkTypeUseLocationVarParamVirtualityVtableElemLocAllocatedAssociatedDataLocationStrideEntrypcUseUTF8ExtensionRangesTrampolineCallColumnCallFileCallLineDescription"

var _Attr_map = map[Attr]string{
	1:  _Attr_name[0:7],
	2:  _Attr_name[7:15],
	3:  _Attr_name[15:19],
	9:  _Attr_name[19:27],
	11: _Attr_name[27:35],
	12: _Attr_name[35:44],
	...
}

func (i Attr) String() string {
	if str, ok := _Attr_map[i]; ok {
		return str
	}
	return "Attr(" + strconv.FormatInt(int64(i), 10) + ")"
}
```

#### entry.go

DWARF `debug information entry (DIE) parser`. An entry is a sequence of data items of a given format. The first word in the entry is an index into what DWARF calls the `abbreviation table`. An abbreviation is really just a type descriptor: it’s an array of attribute tag/value format pairs

```go
// An entry is a sequence of attribute/value pairs.
type Entry struct {
	Offset   Offset // offset of Entry in DWARF info
	Tag      Tag    // tag (kind of Entry)
	Children bool   // whether Entry is followed by children
	Field    []Field
}

// An Offset represents the location of an Entry within the DWARF info.
// (See Reader.Seek.)
type Offset uint32

// A Field is a single attribute/value pair in an Entry.
//
// A value can be one of several "attribute classes" defined by DWARF.
// The Go types corresponding to each class are:
//
//    DWARF class       Go type        Class
//    -----------       -------        -----
//    address           uint64         ClassAddress
//    block             []byte         ClassBlock
//    constant          int64          ClassConstant
//    flag              bool           ClassFlag
//    reference
//      to info         dwarf.Offset   ClassReference
//      to type unit    uint64         ClassReferenceSig
//    string            string         ClassString
//    exprloc           []byte         ClassExprLoc
//    lineptr           int64          ClassLinePtr
//    loclistptr        int64          ClassLocListPtr
//    macptr            int64          ClassMacPtr
//    rangelistptr      int64          ClassRangeListPtr
//
// For unrecognized or vendor-defined attributes, Class may be
// ClassUnknown.
type Field struct {
	Attr  Attr
	Val   interface{}
	Class Class
}

// A Class is the DWARF 4 class of an attribute value.
type Class int

const (
	// ClassUnknown represents values of unknown DWARF class.
	ClassUnknown Class = iota

	// ClassAddress represents values of type uint64 that are
	// addresses on the target machine.
	ClassAddress

	// ClassBlock represents values of type []byte whose
	// interpretation depends on the attribute.
	ClassBlock
	...
)

// a single entry's description: a sequence of attributes
type abbrev struct {
   tag      Tag
   children bool
   field    []afield
}

type afield struct {
	attr  Attr
	fmt   format
	class Class
}

// a map from entry format ids to their descriptions
type abbrevTable map[uint32]abbrev

// ParseAbbrev returns the abbreviation table that starts at byte off
// in the .debug_abbrev section.
func (d *Data) parseAbbrev(off uint64, vers int) (abbrevTable, error) {
	if m, ok := d.abbrevCache[off]; ok {
		return m, nil
	}

	data := d.abbrev
	...
	b := makeBuf(d, unknownFormat{}, "abbrev", 0, data)
  
  ...
}
```

#### class_string.go

```go
const _Class_name = "ClassUnknownClassAddressClassBlockClassConstantClassExprLocClassFlagClassLinePtrClassLocListPtrClassMacPtrClassRangeListPtrClassReferenceClassReferenceSigClassStringClassReferenceAltClassStringAlt"

var _Class_index = [...]uint8{0, 12, 24, 34, 47, 59, 68, 80, 95, 106, 123, 137, 154, 165, 182, 196}

func (i Class) String() string {
	if i < 0 || i >= Class(len(_Class_index)-1) {
		return "Class(" + strconv.FormatInt(int64(i), 10) + ")"
	}
	return _Class_name[_Class_index[i]:_Class_index[i+1]]
}
```



#### open.go

```go
// Data represents the DWARF debugging information
// loaded from an executable file (for example, an ELF or Mach-O executable).
type Data struct {
	// raw data
	abbrev   []byte
	aranges  []byte
	frame    []byte
	info     []byte
	line     []byte
	pubnames []byte
	ranges   []byte
	str      []byte

	// parsed data
	abbrevCache map[uint64]abbrevTable
	order       binary.ByteOrder
	typeCache   map[Offset]Type
	typeSigs    map[uint64]*typeUnit
	unit        []unit
}

```

`.debug_info` of 32-bit DWARF differs from the one of 64-bit DWARF:

- 32-bit DWARF: 4 byte length, 2 byte version
- 64-bit DWARF: 4 bytes of 0xff, 8 byte length, 2 byte version

Compiler generates debug information for each compilation unit. Linker will merge them into section .debug_info into executable file, like ELF executable file.

`Data.parseUnits()` parses the .debug_info section in executable file, it works as following:

```go
func (d *Data) parseUnits() ([]unit, error) {
	// Count units.
	nunit := 0
	b := makeBuf(d, unknownFormat{}, "info", 0, d.info)
  // all compilation units' debug info is merged by linker into executable file,
  // here counts the number of compilation unit.
	for len(b.data) > 0 {
		len, _ := b.unitLength()
		if len != Offset(uint32(len)) {
			b.error("unit length overflow")
			break
		}
		b.skip(int(len))
		nunit++
	}
	if b.err != nil {
		return nil, b.err
	}
  
 		// Again, this time writing them down.
	b = makeBuf(d, unknownFormat{}, "info", 0, d.info)
	units := make([]unit, nunit)
	for i := range units {
		u := &units[i]
		u.base = b.off
		// parse .debug_info and build the struct `unit` for each compilation unit
    ...
    
  }
	return units, nil
}


```

#### unit.go

DWARF debug info is split into a sequence of compilation units. Each unit has its own abbreviation table and address size.

```go
// unit a unit represents a compilation unit
type unit struct {
	base   Offset // byte offset of header within the aggregate info
	off    Offset // byte offset of data within the aggregate info
	data   []byte
	atable abbrevTable
	asize  int
	vers   int
	is64   bool // True for 64-bit DWARF format
}
```

#### buf.go

Buffered reading and decoding of DWARF data streams.

```go
// Data buffer being decoded.
type buf struct {
  dwarf *Data
  order binary.ByteOrder
  format dataFormat
  name string
  off Offset
  data []byte
  err error
}
```

#### line.go

```go
// A LineReader reads a sequence of LineEntry structures from a DWARF
// "line" section for a single compilation unit. LineEntries occur in
// order of increasing PC and each LineEntry gives metadata for the
// instructions from that LineEntry's PC to just before the next
// LineEntry's PC. The last entry will have its EndSequence field set.
type LineReader struct {
  ...
}

// A LineEntry is a row in a DWARF line table.
type LineEntry struct {
	// Address is the program-counter value of a machine
	// instruction generated by the compiler. This LineEntry
	// applies to each instruction from Address to just before the
	// Address of the next LineEntry.
	Address uint64

	// OpIndex is the index of an operation within a VLIW
	// instruction. The index of the first operation is 0. For
	// non-VLIW architectures, it will always be 0. Address and
	// OpIndex together form an operation pointer that can
	// reference any individual operation within the instruction
	// stream.
	OpIndex int

	// File is the source file corresponding to these
	// instructions.
	File *LineFile

	// Line is the source code line number corresponding to these
	// instructions. Lines are numbered beginning at 1. It may be
	// 0 if these instructions cannot be attributed to any source
	// line.
	Line int

	// Column is the column number within the source line of these
	// instructions. Columns are numbered beginning at 1. It may
	// be 0 to indicate the "left edge" of the line.
	Column int
	...
}

// A LineFile is a source file referenced by a DWARF line table entry.
type LineFile struct {
	Name   string
	Mtime  uint64 // Implementation defined modification time, or 0 if unknown
	Length int    // File length, or 0 if unknown
}

// LineReader returns a new reader for the line table of compilation
// unit cu, which must be an Entry with tag TagCompileUnit.
//
// If this compilation unit has no line table, it returns nil, nil.
func (d *Data) LineReader(cu *Entry) (*LineReader, error) {
  ...
}
```

#### tag_string.go

```go
const (
	_Tag_name_0 = "ArrayTypeClassTypeEntryPointEnumerationTypeFormalParameter"
	_Tag_name_1 = "ImportedDeclaration"
	_Tag_name_2 = "LabelLexDwarfBlock"
	_Tag_name_3 = "Member"
	_Tag_name_4 = "PointerTypeReferenceTypeCompileUnitStringTypeStructType"
	_Tag_name_5 = "SubroutineTypeTypedefUnionTypeUnspecifiedParametersVariantCommonDwarfBlockCommonInclusionInheritanceInlinedSubroutineModulePtrToMemberTypeSetTypeSubrangeTypeWithStmtAccessDeclarationBaseTypeCatchDwarfBlockConstTypeConstantEnumeratorFileTypeFriendNamelistNamelistItemPackedTypeSubprogramTemplateTypeParameterTemplateValueParameterThrownTypeTryDwarfBlockVariantPartVariableVolatileTypeDwarfProcedureRestrictTypeInterfaceTypeNamespaceImportedModuleUnspecifiedTypePartialUnitImportedUnitMutableTypeConditionSharedTypeTypeUnitRvalueReferenceTypeTemplateAlias"
)

var (
	_Tag_index_0 = [...]uint8{0, 9, 18, 28, 43, 58}
	_Tag_index_2 = [...]uint8{0, 5, 18}
	_Tag_index_4 = [...]uint8{0, 11, 24, 35, 45, 55}
	_Tag_index_5 = [...]uint16{0, 14, 21, 30, 51, 58, 74, 89, 100, 117, 123, 138, 145, 157, 165, 182, 190, 205, 214, 222, 232, 240, 246, 254, 266, 276, 286, 307, 329, 339, 352, 363, 371, 383, 397, 409, 422, 431, 445, 460, 471, 483, 494, 503, 513, 521, 540, 553}
)

func (i Tag) String() string {
	switch {
	case 1 <= i && i <= 5:
		i -= 1
	...
  }
}
```

#### type

DWARF type information structures. The format is heavily biased toward C, but for simplicity the String methods use a pseudo-Go syntax.

```go
// A Type conventionally represents a pointer to any of the
// specific Type structures (CharType, StructType, etc.).
type Type interface {
	Common() *CommonType
	String() string
	Size() int64
}

// A CommonType holds fields common to multiple types.
// If a field is not known or not applicable for a given type,
// the zero value is used.
type CommonType struct {
	ByteSize int64  // size of value of this type, in bytes
	Name     string // name that can be used to refer to type
}
...

// Basic types

// A BasicType holds fields common to all basic types.
type BasicType struct {
	CommonType
	BitSize   int64
	BitOffset int64
}

// A CharType represents a signed character type
type CharType struct{
  BasicType
}

type UcharType{...}

type IntType struct{...}

...

type AddrType struct{...}

type UnspecifiedType struct{...}

type QualType struct{...}

type ArrayType struct{...}

type VoidType struct{...}

type PtrType struct{...}

type StructType struct{...}

type StructField struct{...}

type FuncType struct{...}

type DotDotDotType struct{...}

type TypedefType struct{...}

...

```



#### typeunit.go

```go
// Parse the type units stored in a DWARF4 .debug_types section. Each
// type unit defines a single primary type and an 8-byte signature.
// Other sections may then use formRefSig8 to refer to the type.

// The typeUnit format is a single type with a signature. It holds
// the same data as a compilation unit.
type typeUnit struct {
	unit
	toff  Offset // Offset to signature type within data.
	name  string // Name of .debug_type section.
	cache Type   // Cache the type, nil to start.
}

// Parse a .debug_types section.
func (d *Data) parseTypes(name string, types []byte) error {
	b := makeBuf(d, unknownFormat{}, name, 0, types)
	for len(b.data) > 0 {
	...
}
  
// typeUnitReader is a typeReader for a tagTypeUnit.
type typeUnitReader struct {
	d   *Data
	tu  *typeUnit
	b   buf
	err error
	...
)
```



### debug/elf

### debug/gosym

### debug/macho

### debug/pe

### debug/plan9obj