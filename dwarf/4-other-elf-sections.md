### 5.4.6 ELF Sections

While DWARF is defined in a way that allows it to be used with any object file format, it’s most often used with ELF.  

Each of the different kinds of DWARF data are stored in their own section. The names of these sections all start with prefix ‘.debug_’. For improved efficiency, most references to DWARF data use an offset from the start of the data for current compilation. This avoids the need to relocate the debugging data, which speeds up program loading and debugging. 

The ELF sections and their contents are:

1. .debug_abbrev, abbreviations used in .debug_info
2. .debug_arranges, a mapping between memory address and compilation
3. .debug_frame, call frame info
4. .debug_info, the core Dwarf data containing DIE
5. .debug_line, the line number program (sequence of instructions to generate the complete the line number table)
6. .debug_loc, location descriptions
7. .debug_macinfo, macro information
8. .debug_pubnames, a lookup table for global object and functions
9. .debug_pubtypes, a lookup table for global types
10. .debug_ranges, address ranges referenced by DIEs
11. .debug_str, string table used by .debug_info
12. .debug_types, type descriptions

