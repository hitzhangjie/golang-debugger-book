### 5.4.4 Variable Length Data 

Integer values are used throughout DWARF to represent everything from offsets into data sections to sizes of arrays or structures. Since most values can be represented in only a few bits, this means that the data consists mostly of zeros. 

Dwarf defines a variable length integer, called Little Endian Base 128 (LEB128 for signed integers or ULEB128 for unsigned integers), which compresses the bytes taken up to represent the integers.  

Wiki: https://en.wikipedia.org/wiki/LEB128 

