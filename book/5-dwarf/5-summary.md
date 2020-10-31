## 5.5 Summary 

The basic concepts for the Dwarf are quit straight-forward. 

- A program is described as a **tree with nodes (DIEs)** representing the various functions, data and types in the source in a compact language and machine-independent fashion. 

- The **Line Number Table** provides the mapping between the executable instructions and the source that generated them. 

- The **CFI (Call Frame Information)** describes how to unwind the stack.

- There is quite a bit of subtlety in Dwarf as well, given that it needs to express the many different nuances for a wide range of programming languages and different machine architectures. 

By using ‘**gcc -g -c filename.c**’ can generate the Dwarf debugging information and stored it into the object file filename.o.  

![img](assets/clip_image012.png)

By using ‘**readelf -w**’ can read and display all Dwarf debugging information. By using ‘readelf -w’ and specifying flags can read and display specific Dwarf debugging information.  

![img](assets/clip_image013.png)

