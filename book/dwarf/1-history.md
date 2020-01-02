## History

Dwarf standards, its intended audience is the developers of both producers and consumers of debugging information, typically language compilers, debuggers and other tools that need to interpret a binary program in terms of its original source. So before we set out to writing code, we’d better thoroughly learn Dwarf standards, even its history.

The DWARF Debugging Information Format Committee was originally organized in 1988 as the Programming Languages Special Interest Group (PLSIG) of Unix International, Inc., a trade group organized to promote Unix System V Release 4 (SVR4).

### DWARF v1

PLSIG drafted a standard for DWARF Version 1, compatible with the DWARF debugging format used at the time by SVR4 compilers and debuggers from AT&T. As DWARF was new, it still had evident problems. It was difficult to be widely approved.

### DWARF v2 vs. DWARF v1

The first version of DWARF proved to use excessive amounts of storage, and an incompatible successor, DWARF-2, superseded it and added various encoding schemes to reduce data size. 

Though, DWARF did not immediately gain universal acceptance. Maybe it was still new, maybe the event that Unix International dissolved shortly after the draft of DWARF v2 was released destroyed this. No industry comments were received or addressed, and no final standard was released. The committee mailing list was hosted by OpenGroup (formerly XOpen).

For instance, when Sun Microsystems adopted ELF as part of their move to Solaris, they opted to continue using **stabs, in an embedding known as "stabs-in-elf"**. Linux followed suit, and DWARF v2 did not become the default until the late 1990s.

### DWARF v3 vs. DWARF v2

The Committee reorganized in October, 1999, and met for the next several years to address issues that had been noted with DWARF Version 2 as well as to add a number of new features. In mid-2003, the Committee became a workgroup under the Free Standards Group (FSG), a industry consortium chartered to promote open standards. DWARF Version 3 was published on December 20, 2005, following industry review and comment.

DWARF v3 added (among other things) support for Java, C++ namespaces, Fortran 90 allocatable data and additional optimization techniques for compilers and linkers.

For example, the return_address_register field in a Common Information Entry record for call frame information is changed to unsigned LEB representation.

### DWARF v4 vs. DWARF v3

The DWARF Committee withdrew from the Free Standards Group in February, 2007, when FSG merged with the Open Source Development Labs to form The Linux Foundation, more narrowly focused on promoting Linux. The DWARF Committee has been independent since that time.

It is the intention of the DWARF Committee that migrating from DWARF Version 2 or Version 3 to later versions should be straightforward and easily accomplished. Almost all DWARF Version 2 and Version 3 constructs have been retained unchanged in DWARF Version 4.

The DWARF committee published version 4 of DWARF, which offers "improved data compression, better description of optimized code, and support for new language features in C++", in 2010.

### DWARF v5

The DWARF Debugging Information Format Committee is open to compiler and debugger developers who have experience with source language debugging and debugging formats, and have an interest in promoting or extending the DWARF debugging format.

Version 5 of the DWARF format was published in February 2017. It "incorporates improvements in many areas: better data compression, separation of debugging data from executable files, improved description of macros and source files, faster searching for symbols, improved debugging of optimized code, as well as numerous improvements in functionality and performance."

Now golang build tools use Dwarf v4, while gcc has applied some features of Dwarf v5 for C++. If you're interested in golang build tools, please watch issue: https://github.com/golang/go/issues/26379.
