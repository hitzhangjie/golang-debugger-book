### 5.4.0 Accelerated Access

**Lookup data objects, functions by name**: *A debugger frequently needs to find the debugging information for a program entity defined outside of the compilation unit where the debugged program is currently stopped. Sometimes the debugger will know only the name of the entity; sometimes only the address. To find the debugging information associated with a global entity by name, using the DWARF debugging information entries alone, a debugger would need to run through all entries at the highest scope within each compilation unit.*

**Lookup types by name**: *Similarly, in languages in which the name of a type is required to always refer to the same concrete type (such as C++), a compiler may choose to elide type definitions in all compilation units except one. In this case a debugger needs a rapid way of locating the concrete type definition by name. As with the definition of global data objects, this would require a search of all the top level type definitions of all compilation units in a program.*

**Lookup by address**: *To find the debugging information associated with a subroutine, given an address, a debugger can use the low and high pc attributes of the compilation unit entries to quickly narrow down the search, but these attributes only cover the range of addresses for the text associated with a compilation unit entry. To find the debugging information associated with a data object, given an address, an exhaustive search would be needed. Furthermore, any search through debugging information entries for different compilation units within a large program would potentially require the access of many memory pages, probably hurting debugger performance.*

**To make lookups of program entities (data objects, functions and types) by name or by address faster**, a producer of DWARF information may provide **three different types of tables** containing information about the debugging information entries owned by a particular compilation unit entry in a more condensed format.

#### 5.4.0.1 Lookup by Name

For lookup by name, two tables are maintained in separate object file sections named **.debug_pubnames** for objects and functions, and **.debug_pubtypes** for types. Each table consists of sets of variable length entries. Each set describes the names of global objects and functions, or global types, respectively, whose definitions are represented by debugging information entries owned by a single compilation unit.

#### 5.4.0.2 Lookup by Address

For lookup by address, a table is maintained in a separate object file section called **.debug_aranges**. The table consists of sets of variable length entries, each set describing the portion of the program’s address space that is covered by a single compilation unit.



