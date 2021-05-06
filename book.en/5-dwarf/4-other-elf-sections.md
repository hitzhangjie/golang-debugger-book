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

When the new version of the compiler and linker generates DWARF debugging information, they may want to compress the size of the binary file, and may turn on data compression. For example, the new version of golang's linker supports compression of DWARF by default.

In order to be better compatible with debuggers that do not support decompression:

- The compressed DWARF data will be written to sections prefixed with `.zdebug_`, such as `.zdebug_info`, rather than sections prefixed with `.debug_`, to avoid DWARF consumers parsing DWARF data abnormally;
- Generally, options are provided to turn off compression. For example, the golang linker option `-ldflags=-dwarfcompress=false` can be specified  to prevent the debugging information from being compressed;

In order to understand the DWARF debugging information more conveniently, you need to use certain tools to assist in viewing and analyzing. `dwarfdump` and `dwex` are both good tools.

