DWARF uses a series of **debugging information entries (DIEs)** to define a low-level representation of a source program. **An entry, or group of entries together**, provide a description of a corresponding entity in the source program. 

Each debugging information entry is described by **an identifying tag** and contains **a series of attributes**. 

- The tag specifies the class to which an entry belongs;
- The attributes define the specific characteristics of the entry;

The debugging information entries are contained in the **.debug_info** and **.debug_types** sections of an object file.

> If compiler **compresses debugging information**, compressed debugging information will **be stored in section with “z” prefix**, for example, compressed “.debug_info” will be stored in section “.zdebug_info”.

