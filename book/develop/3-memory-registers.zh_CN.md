## Inspect Registers

### Get Registers

```go
func PtraceGetRegs(pid int, regsout *PtraceRegs) (err error)
```

This function can be used to get tracee’s registers’ data.

### Set Registers

```go
func PtraceSetRegs(pid int, regs *PtraceRegs) (err error)
```

This function is often used to update Program Counter (PC) when handle breakpoints.