## 5.2 Structure

DWARF uses a data structure called a **Debugging Information Entry (DIE)** to represent each variable, type, procedure, etc. 
- A DIE has a tag (e.g., DW_TAG_variable, DW_TAG_pointer_type, DW_TAG_subprogram…) and set of attributes (key-value pairs). 
- A DIE can have nested (child) DIEs, forming a tree structure. 
- A DIE attribute can refer to another DIE anywhere in the tree—for instance.  
    For example, a DIE representing a variable would have a DW_AT_type entry pointing to the DIE describing the variable's type.

To save space, **two large tables needed by symbolic debuggers** are represented as **byte-coded instructions for simple, special-purpose finite state machines**:

1. **The Line Number Table**, which maps code locations to source code locations and vice versa, also specifies which instructions are part of function prologues and epilogues. 
2. **The Call Frame Information table**, which allows debuggers to locate frames on the call stack.

>The finite state machines run the byte-coded instructions to build the the tables mentioned above.

