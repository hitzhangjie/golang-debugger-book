### 5.4.2 Macro Information 

Most debuggers have a very difficult time displaying and debugging code which has macros. The user sees the original source file, with the macros, while the code corresponds to whatever the macros generated. 

Dwarf includes the description of the macros defined in the progam. This is quite rudimentary information, but can be used by a debugger to display the values for a macro or possibly translate the macro into the corresponding source language. 

Macro information will be needed in programming language that supports macros like c, c++. While go doesn’t support macro, so we just skip this part.