DWARF is a widely used, standardized debugging data format. DWARF was originally designed along with Executable and Linkable Format (ELF), although it is independent of object file formats. The name is a medieval fantasy complement to "ELF" that has no official meaning, although the backronym '**Debugging With Attributed Record Formats**' was later proposed.

Dwarf uses DIE (Debugging Information Entry) with Tags and Attributes to describe variable, datatype, executable code, etc.

Dwarf also defines some important data structure, including **Line Number Table**, **Call Frame Information**, etc. 

Thanks to this, developers can add breakpoints at source statement level, or use `frame N`, `bt` to traverse the callstack, or do something others like that.

There're too many smart thinkings in Dwarf standard, if you're interested in deubgging please read more about Dwarf standard.

