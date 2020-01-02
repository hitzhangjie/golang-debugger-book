### 5.3.1 Introduction

Each **debugging information entry (DIE)** is described by **an identifying tag** and contains **a series of attributes**. 
- The tag specifies the class to which an entry belongs;
- The attributes define the specific characteristics of the entry;

The debugging information entries in Dwarf v2/v3 are intended to exist in the **.debug_info** section of an object file.

#### 5.3.1.1 Tag

Tag, with prefix DW_TAG, specifies what the DIE describes, the set of required tag names is listed in following figure.

This table lists attributes extracted from Dwarf v2:

![img](assets/clip_image001.png)

> Dwarf v3 adds:
>
> DW_TAG_condition, DW_TAG_dwarf_procedure, DW_TAG_imported_module, DW_TAG_imported_unit, DW_TAG_interface_type, DW_TAG_namespace, DW_TAG_partial_unit, DW_TAG_restrict_type, DW_TAG_shared_type, DW_TAG_unspecified_type.

#### 5.3.1.2 Attribute

Attribute, with prefix DW_AT, fills in details of DIE and further describes the entity.

An attribute has a variety of values: constants (such as function name), variables (such as start address for a function), or references to another DIE (such as for the type of functions’ return value).

The permissive values for an attribute belong to one or more classes of attribute value forms. Each form class may be represented in one or more ways. 

For instance, some attribute values consist of a single piece of constant data. “Constant data” is the class of attribute value that those attributes may have. There’re several representations of constant data, however (one, two, four, eight bytes and variable length data). The particular representation for any given instance of an attribute is encoded along with the attribute name as part of of the information that guides the interpretation of a debugging information entry.

This table lists attributes extracted from Dwarf v2:

![img](assets/clip_image002.png)

>Dwarf v3 add some new attributes:
>
>DW_AT_allocated, DW_AT_associated, DW_AT_binary_scale, DW_AT_bit_stride, DW_AT_byte_stride, DW_AT_call_file, DW_AT_call_line,  DW_AT_call_column, DW_AT_data_location, DW_AT_decimal_scale, DW_AT_decimal_sign, DW_AT_description, DW_AT_digit_count, DW_AT_elemental, DW_AT_endianity, DW_AT_entry_pc, DW_AT_explicit, DW_AT_extension, DW_AT_mutable, DW_AT_object_pointer, DW_AT_prototyped, DW_AT_pure, DW_AT_ranges, DW_AT_recursive, DW_AT_small, DW_AT_threads_scaled, DW_AT_trampoline, DW_AT_use_UTF8.

Attribute value may belong to one of the following classes:

1. **Address**, refers to some location in the address space of the described program.

2. **Block**, an arbitrary number of uninterpreted bytes of data.

3. **Constant**, one, two, four or eight bytes of uninterpreted data, or data encoded in LEB128.

4. **Flag**, a small constant that indicates the presence or absence of the an attribute.

5. **lineptr**, refers to a location in the DWARF section that holds line number information.

6. **loclistptr**, refers to a location in the DWARF section that holds location lists, which describe objects whose location can change during their lifetime.

7. **macptr**, refers to location in the DWARF section that holds macro definition information.

8. **rangelistptr**, refers to a location in the DWARF section that holds non-continuous address ranges.

9. **Reference**, refers to one of the DIEs that describe the program.

   > There are two types of reference: 
   >
   > - The first is an offset relative to the beginning of the compilation unit in which the reference occurs and must refer to an entry within that same compilation unit.
   > - The second type of reference is the offset of a DIE in any compilation unit, including one different from the unit containing the reference.

10. **String**, a null-terminated sequence of zero or more (non-null) bytes. Strings maybe represented directly in the DIE or as an offset in a separate string table.

#### 5.3.1.3 Form

Briefly, DIE can be classified into 2 forms: 

1. the one to describe **the data and type**
2. the one to describe **the function and executable code**

> One DIE can have parent, siblings and children DIEs, dwarf debugging information is constructed as a tree in which each node is a DIE, several DIE combined to describe an entity in programming language (such as a function). If all such relations are taken into account, the debugging entries form a graph, not a tree.

In following sections, types of DIEs will be described before we dive into dwarf further.

