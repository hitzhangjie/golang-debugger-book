## 压缩DWARF数据

与DWARF v1相比，DWARF新版本使用的编码方案大大减少了调试信息的大小。但不幸的是，编译器生成的调试信息仍然很大，通常大于可执行代码和数据的存储占用。DWARF新版本提供了进一步减少调试数据大小的方法，比如使用zlib数据压缩。

下面是一个生产环境服务（编译后大约147MB），即使采用了DWARF v4并且开启了DWARF数据压缩之后 (Flags==C），编译完也有147MB。构建后文件尺寸大，是多方面原因，比如这里的Go程序使用静态链接，符号表信息，调试信息也都有保留。

```bash
root🦀 bin $ readelf -S grpc_admin_svr
There are 36 section headers, starting at offset 0x238:

Section Headers:
  [Nr] Name              Type             Address           Offset
       Size              EntSize          Flags  Link  Info  Align
       ...
  [24] .debug_abbrev     PROGBITS         0000000000000000  0688d000
       0000000000000135  0000000000000000   C       0     0     1
  [25] .debug_line       PROGBITS         0000000000000000  0688d135
       00000000006538d5  0000000000000000   C       0     0     1
  [26] .debug_frame      PROGBITS         0000000000000000  06ee0a0a
       000000000012ada4  0000000000000000   C       0     0     1
  [27] .debug_gdb_script PROGBITS         0000000000000000  0700b7ae
       0000000000000030  0000000000000000           0     0     1
  [28] .debug_info       PROGBITS         0000000000000000  0700b7de
       0000000000ace1cb  0000000000000000   C       0     0     1
  [29] .debug_loc        PROGBITS         0000000000000000  07ad99a9
       0000000000881add  0000000000000000   C       0     0     1
  [30] .debug_ranges     PROGBITS         0000000000000000  0835b486
       00000000004836ee  0000000000000000   C       0     0     1
  ...
```

那我们去掉DWARF数据看看能节省多少存储占用，使用objcopy去掉所有的DWARF debug sections，然后查看文件大小，32MB!!!

```bash
root🦀 bin $ objcopy --strip-debug grpc_admin_svr grpc_admin_svr.stripped
root🦀 bin $ ll -h
total 262M
drwxr-xr-x 2 root root 4.0K May 18 11:34 ./
drwxr-xr-x 4 root root 4.0K Apr 28 16:05 ../
-rwxr-xr-x 1 root root 147M May 12 13:01 grpc_admin_svr
-rwxr-xr-x 1 root root 115M May 18 11:34 grpc_admin_svr.stripped
```

32MB还是有点大的，大多数编程语言是默认不生成调试信息的，Go语言是个例外。

golang/go issues也有讨论是否应该默认关闭DWARF数据生成。至于Go新版本是否会默认关闭DWARF生成，很可能不会，因为这也会增加调试的成本，制品库、代码版本、调试符号信息一一对应的管理成本。在存储成本低廉的今天，默认关闭DWARF调试信息生成的策略，可能是一个按下葫芦起了瓢的做法，对实践并不见的特别有价值。

当然如果你想显示关闭DWARF调试信息生成，可以通过 `go build -ldflags='-w'` 来关闭调试信息生成。
