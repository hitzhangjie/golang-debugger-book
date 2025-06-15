## Core (Part2): 生成Core+调试Core

### 实现目标: `tinydbg core [corefile]`

本节我们介绍根据core文件进行调试 `tinydbg core [corefile]`，通常情况下core文件是程序异常终止或崩溃时操作系统为其生成的一个内存快照文件。它包含了程序崩溃时的信息，调试器利用它可以重建程序崩溃时的执行现场，帮助开发者定位问题。

利用core文件进行问题定位的一个最常见操作，就是执行命令 `bt`，可以定位程序崩溃时的堆栈，对于SIGMENTATION FAULT很容易定位。现在主流编程语言在程序出现异常或者严重错误时，都提供了栈回溯的能力，方便开发者查看问题堆栈。

比如：
1. Go语言支持对panic进行recover的同时，可以通过debug.Stack()来获取并打印协程堆栈信息；而环境变量GOTRACKBACK=crash就可以在崩溃时生成core文件；
2. Java语言可以通过Thread.dumpStack()或者Throwable.printStackTrace()打印当前线程的堆栈信息；JVM崩溃时会生成hs_err_pid*.log文件记录崩溃信息；
3. C++可以通过backtrace()、backtrace_symbols()等函数获取堆栈信息；通过设置ulimit -c unlimited开启core dump，程序崩溃时会生成core文件；

Core文件本质上是进程某个时刻的快照信息，也不一定是崩溃时才生成，比如 `gcore <pid>` 可以不挂掉进程的情况下生成core文件，当然肯定是想定位进程的一些问题时才会这么做，对于线上服务要踢掉流量后才能这么干，因为生成core文件过程中进程是暂停执行的。

### 基础知识

#### core包含哪些信息

part1部分对core文件进行了详细介绍，这里还是简单回顾下。core文件是进程的一个内存快照文件，它包含了程序崩溃时的内存内容和寄存器状态等信息，主要有如下几部分：

1. ELF头信息：标识这是一个core文件，包含文件类型、机器架构等基本信息
2. 程序头表：描述了core文件中各个段的位置和属性
3. 内存映射段：
   - 包含程序的代码段、数据段、堆、栈等内存区域的内容
   - 每个段都有对应的虚拟地址和访问权限信息   
4. 寄存器状态：
   - 所有线程的通用寄存器值
   - 浮点寄存器状态
   - 特殊寄存器状态
5. 其他信息：
   - 进程ID、用户ID等进程信息
   - 导致崩溃的信号信息
   - 命令行参数和环境变量
   - 打开的文件描述符信息

调试器可以读取core文件中的上述信息，然后重建程序崩溃时的执行现场，帮助开发者进行事后调试分析、问题复盘。

#### core文件如何生成

### Linux下Core文件生成

#### Linux内核来生成

当程序收到某些特定信号(如SIGSEGV、SIGABRT等)时,如果系统开启了core dump功能,内核会帮助生成core文件。具体流程如下:

1. 触发core dump的常见信号:
   - SIGSEGV: 段错误,非法内存访问
   - SIGABRT: 调用abort()函数
   - SIGFPE: 浮点异常
   - SIGILL: 非法指令
   - SIGBUS: 总线错误
   - SIGQUIT: 用户发送quit信号

2. 系统配置:
   ```bash
   # 检查是否开启core dump
   ulimit -c
   
   # 设置core文件大小限制(unlimited表示不限制)
   ulimit -c unlimited
   
   # 配置core文件路径格式
   echo "/tmp/core-%e-%p-%t" > /proc/sys/kernel/core_pattern
   ```

3. 内核处理流程:
   1. 进程收到上述信号后,内核介入处理
   2. 检查系统core dump配置是否允许生成core文件
   3. 内核暂停进程所有线程
   4. 收集进程内存映射、寄存器状态等信息
   5. 将信息写入core文件
   6. 终止进程

4. core文件命名规则(/proc/sys/kernel/core_pattern):
   - %p - 进程ID 
   - %u - 用户ID
   - %g - 组ID
   - %s - 导致core dump的信号号
   - %t - core dump的时间(UNIX时间戳)
   - %h - 主机名
   - %e - 可执行文件名

所以生成core文件不需要调试器参与,这是由Linux内核提供的一个重要特性。调试器的作用是事后分析这个core文件,重建崩溃现场进行调试。

#### 自定义工具来生成

除了上述提到的哪些给进程发送信号、利用内核的能力来自动生成core文件以外，我们的自定义调试工具也可以自己实现这里的core文件转储的能力。

比如gdb软件包中的gcore，它也可以生成进程的core文件，而不用真的让进程挂掉。尽管大多数时候线上服务生成core文件是因为遇到了严重错误，但是实际上我们可以在不干掉进程的情况下生成它的core文件，实现其实也不复杂。


比如我们现在要生成某个进程的core文件，我们可以这么做：

- 使用 `ptrace` 系统调用附加到目标进程；
- 读取 `/proc/<pid>/maps` 来了解内存布局；
- 使用 `process_vm_readv()` 或通过 `ptrace(PTRACE_PEEKDATA, ...)` 读取内存区域；
- 使用 `ptrace(PTRACE_GETREGS, ...)` 捕获寄存器状态；
- 获取打开的文件、线程信息等；
- 获取启动时的环境变量、启动参数、构建参数等；
- ...
- 将上述感兴趣的信息，按格式组织好后写入core文件。

OK，接下来我们就看看 tinydbg 中是如何生成core文件，并加载core文件的。

### 代码实现

core文件生成其实是有调试会话的调试命令 `tinydbg> dump <corefile>` 来生成的，而加载core文件并启动调试是 `tinydbg core <exectable> <corefile>` 来实现的。按照我们的目录安排，这一小节我们要先介绍core命令，然后再调试会话的命令部分，再介绍dump命令。但是core文件中数据的生产、消费是紧密相关的，生产、消费在章节安排上隔的很远，跳跃性太大、不易于读者理解学习。

所以我们先介绍dump命令如何实现core文件的生成，再介绍core文件的消费。

#### tinydbg生成core文件

```bash
$ (tinydbg) help dump
Creates a core dump from the current process state

        dump <output file>

The core dump is always written in ELF, even on systems (windows, macOS) where this is not customary. For environments other than linux/amd64 threads and registers are dumped in a format that only Delve can read back.
```

生成core文件的核心代码路径：

```bash
debug_other.go:debugCmd.cmdFn(...)
    \--> dump(s *Session, ctx callContext, args string)
            \--> dumpState, err := t.client.CoreDumpStart(args)
                    \--> c.call("DumpStart", DumpStartIn{Destination: dest}, out)
            \--> forloop
                    \--> print dumping progress
                    \--> if !dumpState.Dumping { break }
                    \--> else { 
                            dumpState = t.client.CoreDumpWait(1000)}
                                \--> c.call("DumpWait", DumpWaitIn{Wait: msec}, out)
                         }
```

对于调试器后端来说很代码路径：

```bash
tinydbg/service/rpc2.(*RPCServer).DumpStart(arg DumpStartIn, out *DumpStartOut)
    \--> s.debugger.DumpStart(arg.Destination)
            \--> (d *Debugger) DumpStart(dest string) error {
                    \--> (t *Target) Dump(out elfwriter.WriteCloserSeeker, flags DumpFlags, state *DumpState) 
                            \--> 1. dump os/machine/abi... info as file header
                            \--> 2. t.dumpMemory(state, w, mme): write mapped memory data
                                    \--> upadte DumpState.MemoryDone, DumpState.MemoryTotal
                            \--> 3. prepare notes of dlv header, process, threads and other info
                                    \--> prepare note of dlv headerr: ... 
                                    \--> prepare note of process: t.proc.DumpProcessNotes(notes, state.threadDone)
                                    \--> for each thread:
                                            \--> t.dumpThreadNotes(notes, state, th)
                                            \--> update DumpState.ThreadsDone, DumpState.ThreadsTotal
                            \--> 4. w.WriteNotes(notes): dump dlv header, process info, threads info, and others as 
                                    a new PT_NOTE type entry of ProgHeader table 
    \--> out.State = *api.ConvertDumpState(s.debugger.DumpWait(0))
    \--> return DumpState to rpc2.Client
```

看下具体的源码实现，这里可以明确的是进程转储的过程是可能会花点时间的，不一定立马就完成，所以客户端请求DumpStart后服务器执行后会先返回一个DumpState，这个状态是当前的状态，不一定彻底完成了。如果没完成，客户端还会每隔1s再请求一次 `dumpState := t.client.CoreDumpWait(...)` 重新获取一次转储进度。

看完下面Dump的实现大家也会明白这里的转储进度是怎么算的，就两个指标，threads信息是否都转储完了，内存信息是否都转储完了，就这两部分可能会随进程工作负载情况耗时会久些。

```go
// DumpStart starts a core dump to arg.Destination.
func (s *RPCServer) DumpStart(arg DumpStartIn, out *DumpStartOut) error {
	err := s.debugger.DumpStart(arg.Destination)
	if err != nil {
		return err
	}
	out.State = *api.ConvertDumpState(s.debugger.DumpWait(0))
	return nil
}

// ConvertDumpState converts proc.DumpState to api.DumpState.
func ConvertDumpState(dumpState *proc.DumpState) *DumpState {
    ...
	return &DumpState{
		Dumping:      dumpState.Dumping,
		AllDone:      dumpState.AllDone,
		ThreadsDone:  dumpState.ThreadsDone,
		ThreadsTotal: dumpState.ThreadsTotal,
		MemDone:      dumpState.MemDone,
		MemTotal:     dumpState.MemTotal,
	}
}

// DumpStart starts a core dump to dest.
func (d *Debugger) DumpStart(dest string) error {
    ...
	fh, err := os.Create(dest)
    ...
	d.dumpState.Dumping = true
	d.dumpState.AllDone = false
	d.dumpState.Canceled = false
	d.dumpState.DoneChan = make(chan struct{})
	d.dumpState.ThreadsDone = 0
	d.dumpState.ThreadsTotal = 0
	d.dumpState.MemDone = 0
	d.dumpState.MemTotal = 0
	d.dumpState.Err = nil

	go d.target.Selected.Dump(fh, 0, &d.dumpState)
	return nil
}
```

这里的selected实际上是TargetGroup中的某个Target，而Target指的是进程维度。如果是单进程程序TargetGroup中Target只有一个，如果是多进程程序，并且调试时 `tinydbg> target follow-exec [-on [regex]] [-off]` 打开了follow-exec模式。那么当创建子进程时如果子进程执行的命令命中正则表达式，就会自动将新创建的进程也给管理起来。此时TargetGroup就有不止一个Target。当然这里的Target层控制backend实现必须支持对父子进程进行控制，backend=native支持，对于gdb调试器也支持 `set follow-fork-mode child`。

对于多进程调试场景，又希望对父子进程同时进行暂停执行、恢复执行的情况，这里TargetGroup统一进行管理起来，就方便进行相应的暂停、恢复操作了。

ps：关于backend可扩展可替换的问题：在我们的demo tinydbg中，仅保留了dlv自己的实现native debugger，我们移除了支持gdb、lldb、mozilla rr等debugger backend的实现逻辑。注意，这里的术语backend指的不是前后端分离式架构中的调试器服务器，而是指的调试器服务器中的对于Target层进行控制的部分。中英文混用时，请读者注意分辨术语具体的含义。

OK，我们继续看 Target.Dump(...) 是如何实现的：

```go
// Dump writes a core dump to out. State is updated as the core dump is written.
func (t *Target) Dump(out elfwriter.WriteCloserSeeker, flags DumpFlags, state *DumpState) {
	defer func() {
		state.Dumping = false
		close(state.DoneChan)
        ...
	}()

	bi := t.BinInfo()

    // 1. write the ELF corefile header
	var fhdr elf.FileHeader
	fhdr.Class = elf.ELFCLASS64
	fhdr.Data = elf.ELFDATA2LSB
	fhdr.Version = elf.EV_CURRENT
	fhdr.OSABI = elf.ELFOSABI_LINUX
	fhdr.Type = elf.ET_CORE
	fhdr.Machine = elf.EM_X86_64
	fhdr.Entry = 0
	w := elfwriter.New(out, &fhdr) 
    ...

    // prepare notes of dlv header, process, threads and others
	notes := []elfwriter.Note{}
    // - note of dlv header
	entryPoint, _ := t.EntryPoint()
	notes = append(notes, elfwriter.Note{
		Type: elfwriter.DelveHeaderNoteType,
		Name: "Delve Header",
		Data: []byte(fmt.Sprintf("%s/%s\n%s\n%s%d\n%s%#x\n", bi.GOOS, bi.Arch.Name, version.DelveVersion.String(), elfwriter.DelveHeaderTargetPidPrefix, t.pid, elfwriter.DelveHeaderEntryPointPrefix, entryPoint)),
	})

    // - notes of threads
	state.setThreadsTotal(len(threads))

    // note of process
	var threadsDone bool
	if flags&DumpPlatformIndependent == 0 {
		threadsDone, notes, _ = t.proc.DumpProcessNotes(notes, state.threadDone)
	}
    // notes of threads
	threads := t.ThreadList()
	if !threadsDone {
		for _, th := range threads {
			notes = t.dumpThreadNotes(notes, state, th)
			state.threadDone()
		}
	}

    // 2. write mapped memory data into corefile
	memmap, _ := t.proc.MemoryMap()
	memmapFilter := make([]MemoryMapEntry, 0, len(memmap))
	memtot := uint64(0)
	for i := range memmap {
		if mme := &memmap[i]; t.shouldDumpMemory(mme) {
			memmapFilter = append(memmapFilter, *mme)
			memtot += mme.Size
		}
	}
	state.setMemTotal(memtot)
	for i := range memmapFilter {
		mme := &memmapFilter[i]
		t.dumpMemory(state, w, mme)
	}

    // 3. write these notes into corefile as a new entry of 
    // ProgHeader table, with type `PT_NOTE`.
	notesProg := w.WriteNotes(notes)
	w.Progs = append(w.Progs, notesProg)
	w.WriteProgramHeaders()
	if w.Err != nil {
		state.setErr(fmt.Errorf("error writing to output file: %v", w.Err))
	}
	state.Mutex.Lock()
	state.AllDone = true
	state.Mutex.Unlock()
}
```

#### tinydbg加载core文件

加载Core文件的核心代码路径：

```bash
main.go:main.main
    \--> cmds.New(false).Execute()
            \--> coreCommand.Run()
                    \--> coreCmd(...)
                            \--> execute(0, []string{args[0]}, conf, args[1], debugger.ExecutingOther, args, buildFlags)
                                    \--> server := rpccommon.NewServer(...)
                                    \--> server.Run()
                                            \--> debugger, _ := debugger.New(...)
                                                if attach 启动方式: debugger.Attach(...)
                                                elif core 启动方式：core.OpenCore(...)
                                                else 其他 debuger.Launch(...)
```

对于tinydbg core来说，就是core.OpenCore(...)这种方式。

```go
// OpenCore will open the core file and return a *proc.TargetGroup.
// If the DWARF information cannot be found in the binary, Delve will look
// for external debug files in the directories passed in.
//
// note: we remove the support of reading seprate dwarfdata.
func OpenCore(corePath, exePath string) (*proc.TargetGroup, error) {
	p, currentThread, err := readLinuxOrPlatformIndependentCore(corePath, exePath)
	if err != nil {
		return nil, err
	}

	if currentThread == nil {
		return nil, ErrNoThreads
	}

	grp, addTarget := proc.NewGroup(p, proc.NewTargetGroupConfig{
		DisableAsyncPreempt: false,
		CanDump:             false,
	})
	_, err = addTarget(p, p.pid, currentThread, exePath, proc.StopAttached, "")
	return grp, err
}
```

那读取core重建问题现场的核心逻辑，就在这里了：

```go
// readLinuxOrPlatformIndependentCore reads a core file from corePath
// corresponding to the executable at exePath. For details on the Linux ELF
// core format, see:
// https://www.gabriel.urdhr.fr/2015/05/29/core-file/,
// https://uhlo.blogspot.com/2012/05/brief-look-into-core-dumps.html,
// elf_core_dump in https://elixir.bootlin.com/linux/v4.20.17/source/fs/binfmt_elf.c,
// and, if absolutely desperate, readelf.c from the binutils source.
func readLinuxOrPlatformIndependentCore(corePath, exePath string) (*process, proc.Thread, error) {

    // read notes
	coreFile, _ := elf.Open(corePath)
	machineType := coreFile.Machine
	notes, platformIndependentDelveCore, err := readNotes(coreFile, machineType)
    ...

    // read executable
	exe, _ := os.Open(exePath)
	exeELF, _ := elf.NewFile(exe)
    ...

    // 1. build memory
	memory := buildMemory(coreFile, exeELF, exe, notes)

    // 2. build process
	bi := proc.NewBinaryInfo("linux", "amd64")
	entryPoint := findEntryPoint(notes, bi.Arch.PtrSize()) // saved in dlv header in PT_NOTE segment

	p := &process{
		mem:         memory,
		Threads:     map[int]*thread{},
		entryPoint:  entryPoint,
		bi:          bi,
		breakpoints: proc.NewBreakpointMap(),
	}

	if platformIndependentDelveCore {
		currentThread, err := threadsFromDelveNotes(p, notes)
		return p, currentThread, err
	}

	currentThread := linuxThreadsFromNotes(p, notes, machineType)
	return p, currentThread, nil
}
```

这里面最核心的两步就是建立起内存现场、进程状态现场。

前面没有详细介绍note的类型：

```go
// Note is a note from the PT_NOTE prog.
// Relevant types:
// - NT_FILE: File mapping information, e.g. program text mappings. Desc is a LinuxNTFile.
// - NT_PRPSINFO: Information about a process, including PID and signal. Desc is a LinuxPrPsInfo.
// - NT_PRSTATUS: Information about a thread, including base registers, state, etc. Desc is a LinuxPrStatus.
// - NT_FPREGSET (Not implemented): x87 floating point registers.
// - NT_X86_XSTATE: Other registers, including AVX and such.
type note struct {
	Type elf.NType
	Name string
	Desc interface{} // Decoded Desc from the
}
```

ok继续看看buildMemory，这个函数主要分两步，对于PT_NOTE、PT_LOAD类型的分别进行处理：
1）PT_NOTE类型的程序头，其中类型为note.Type=_NT_FILE的note表示非匿名VMA区域映射的一些文件；
   Linux来生成Core文件的时候，会包含这些；tinydbg 内存区全部是PT_LOAD转储出去的。
2）PT_LOAD类型的程序头，读取的主要是可执行程序中的一些数据；

```go
func buildMemory(core, exeELF *elf.File, exe io.ReaderAt, notes []*note) proc.MemoryReader {
	memory := &SplicedMemory{}

	// tinydbg没有生成note.Type=NT_FILE的notes信息，
	//
	// - 对于go程序而言，如果是内核生成的core文件，则会包含这个，详见linux `fill_files_notes`
	// - 对于tinydbg> debug my.core 而言，不会生成这部分信息
	//
	// 这里假定所有的文件映射都来自exe，显然是不对的，比如共享库文件、外部其他文件就不是嘛
	// - 1) 如果是只读文件，通常不会存储到core文件中（节省空间），此时需要从外部文件读 
	//      这里支持的不够!!! 
	//      因为readNote函数里面只读取了VMA.start/end/offsetByPage,后面真正映射的文件名没有读取!
	//
	// - 2) 如果是可读写文件，通常会内核转储时转储这部分数据，应该以core文件数据为主，
	//      避免盲目读取外部文件数据造成覆盖
	//
	// For now, assume all file mappings are to the exe.
	for _, note := range notes {

		if note.Type == _NT_FILE {
			fileNote := note.Desc.(*linuxNTFile)
			for _, entry := range fileNote.entries {
				r := &offsetReaderAt{
					// why? 因为它假定了go大多数时候是静态编译，不使用共享库，也不涉及到mmap文件，
					// 那么内核生成coredump时基本就是这种情况。这里实现可以优化
					reader: exe, 
					offset: entry.Start - (entry.FileOfs * fileNote.PageSize),
				}
				memory.Add(r, entry.Start, entry.End-entry.Start)
			}
		}
	}

	// Load memory segments from exe and then from the core file,
	// allowing the corefile to overwrite previously loaded segments
	for _, elfFile := range []*elf.File{exeELF, core} {
		if elfFile == nil {
			continue
		}
		for _, prog := range elfFile.Progs {
			if prog.Type == elf.PT_LOAD {
				if prog.Filesz == 0 {
					continue
				}
				r := &offsetReaderAt{
					reader: prog.ReaderAt,
					offset: prog.Vaddr,
				}
				memory.Add(r, prog.Vaddr, prog.Filesz)
			}
		}
	}
	return memory
}
```

注意对于NT_FILE类型的note，这种是内核创建Core文件时生成的，tinydbg中dump生成Core文件生成的都是PT_LOAD类型的，一股脑的将映射的内存全部以PT_LOAD的形式转储出来，省事。内核创建时会将非匿名映射VMA的关联文件信息以PT_NOTE的形式转储，并且里面的note.Type=NT_FILE。虽然，上述代码中假定所有的mapped files都来自executable是不完全对，但是即便如此，也不会影响调试准确性，因为这类note只是记录VMA与文件的映射关系，并不真的包含数据，数据还是要看这个PT_LOAD类型的部分。实际上已经读取的文件内容早就在进程地址空间中了，内核生成Core文件时记录了已映射数据在Core文件中的位置，所以可以知道已经映射的文件内容 …… 所以上面 `offsetReaderAt{reade.exe, ...}` 虽然写的看上去不太对，但是如果这些数据都已经通过PT_LOAD segments dump出来之后也就没问题了，读数据时是可以读到的。

但是有文章提到，说对于只读的PT_LOAD，其FileSZ==0 && MemSZ != 0，并且还是Non-Anonymous VMA区域，这时想拿到数据就得根据PT_NOTE表中的mapped file的filename来从外部存储读取，但是由于readNote处理时显示忽略了这些filenames，所以我认为在某些场景下tinydbg的调试会遇到问题。不过这不是本小节想一揽子解决的问题，大家理解即可。

```go
// readNote reads a single note from r, decoding the descriptor if possible.
func readNote(r io.ReadSeeker, machineType elf.Machine) (*note, error) {
	// Notes are laid out as described in the SysV ABI:
	// https://www.sco.com/developers/gabi/latest/ch5.pheader.html#note_section
	note := &note{}
	hdr := &elfNotesHdr{}

	err := binary.Read(r, binary.LittleEndian, hdr)
	note.Type = elf.NType(hdr.Type)

	name := make([]byte, hdr.Namesz)
	note.Name = string(name)
	desc := make([]byte, hdr.Descsz)

	descReader := bytes.NewReader(desc)
	switch note.Type {
	case elf.NT_PRSTATUS:
		note.Desc = &linuxPrStatusAMD64{}
	case elf.NT_PRPSINFO:
		note.Desc = &linuxPrPsInfo{}
		binary.Read(descReader, binary.LittleEndian, note.Desc)
	case _NT_FILE:
		// No good documentation reference, but the structure is
		// simply a header, including entry count, followed by that
		// many entries, and then the file name of each entry,
		// null-delimited. Not reading the names here.
		data := &linuxNTFile{}
		binary.Read(descReader, binary.LittleEndian, &data.linuxNTFileHdr)
		for i := 0; i < int(data.Count); i++ {
			entry := &linuxNTFileEntry{}
			binary.Read(descReader, binary.LittleEndian, entry)
			data.entries = append(data.entries, entry)
		}
		note.Desc = data
	case _NT_X86_XSTATE:
		if machineType == _EM_X86_64 {
			var fpregs amd64util.AMD64Xstate
			amd64util.AMD64XstateRead(desc, true, &fpregs, 0)
			note.Desc = &fpregs
		}
	case _NT_AUXV, elfwriter.DelveHeaderNoteType, elfwriter.DelveThreadNodeType:
		note.Desc = desc
	}
	skipPadding(r, 4)
	return note, nil
}
```

另外，参考内核源码中 `fill_files_note(struct memelfnote *note)` 的实现，这个函数展示了NT_FILE note的数据格式，我们可以知道long start, long end, long file_ofs都是VMA中的位置，而不是mapped files中的位置。所以前面也说只要mapped files的内容，除了在PT_NOTE中的映射关系，即使我们不读取文件名，只要这些数据被dump到了core文件PT_LOAD segments中，我们从core文件buildMemory后，建立了SplicedMemory，这里面包含了进程coredump时所有的VMA区域，只要这些mapped files的数据被记录到了core文件中，后续读内存时实际上就是从这个SplicedMemory中读取，是可以读取到的，没有必要读取外部文件。但是前提是，转储出来了（FileSZ != 0)。

实际上，尽管进程执行时可能mapped file对应的VMA是只读，但是在文件系统上不一定是，还是可能会被修改，那调试时从外部文件读取不就完蛋了吗。所以我认为，为了方便调试，还是应该把这部分数据转储到core中来，虽然core文件会大点。但是应该也不那么在乎这点磁盘占用把

>ps: 进程的完整地址空间，所有的这些VMAs都不会被转储到core文件中。但是有些VMAs是没有建立物理内存映射的，这部分在记录到core文件中时只会记录一些必要信息，没有实际数据，也不会写0值，但是文件中确实留下了一些空洞。这种情况下 `ls -h` 会显示文件偏大，但是 `du -hs` 会显示更小些。我在做游戏服务器开发时，观察到战斗服进程Core文件尺寸 `ls` 显示高达80GB，但是实际上`du`显示只有800MB+左右。

```c
/*
 * Format of NT_FILE note:
 *
 * long count     -- how many files are mapped
 * long page_size -- units for file_ofs
 * array of [COUNT] elements of
 *   long start
 *   long end
 *   long file_ofs
 * followed by COUNT filenames in ASCII: "FILE1" NUL "FILE2" NUL...
 */
static int fill_files_note(struct memelfnote *note)
{
	struct vm_area_struct *vma;
	unsigned count, size, names_ofs, remaining, n;
	user_long_t *data;
	user_long_t *start_end_ofs;
	char *name_base, *name_curpos;

	/* *Estimated* file count and total data size needed */
	count = current->mm->map_count;
	size = count * 64;

	names_ofs = (2 + 3 * count) * sizeof(data[0]);
 alloc:
	size = round_up(size, PAGE_SIZE);
	data = kvmalloc(size, GFP_KERNEL);

	start_end_ofs = data + 2;
	name_base = name_curpos = ((char *)data) + names_ofs;
	remaining = size - names_ofs;
	count = 0;
	for (vma = current->mm->mmap; vma != NULL; vma = vma->vm_next) {
		struct file *file;
		const char *filename;

		file = vma->vm_file;
		filename = file_path(file, name_curpos, remaining);

		/* file_path() fills at the end, move name down */
		/* n = strlen(filename) + 1: */
		n = (name_curpos + remaining) - filename;
		remaining = filename - name_curpos;
		memmove(name_curpos, filename, n);
		name_curpos += n;

		*start_end_ofs++ = vma->vm_start;
		*start_end_ofs++ = vma->vm_end;
		*start_end_ofs++ = vma->vm_pgoff;
		count++;
	}

	/* Now we know exact count of files, can store it */
	data[0] = count;
	data[1] = PAGE_SIZE;
	...

	size = name_curpos - (char *)data;
	fill_note(note, "CORE", NT_FILE, size, data);
	return 0;
}
```

#### 后续读取内存操作

注意到从core文件buildMemory过程中追踪进程coredump时的内存映射情况：

```go
type SplicedMemory struct {
	readers []readerEntry
}

func buildMemory(core, exeELF *elf.File, exe io.ReaderAt, notes []*note) proc.MemoryReader {
	memory := &SplicedMemory{}

	// For now, assume all file mappings are to the exe.
	for _, note := range notes {
		if note.Type == _NT_FILE {
			fileNote := note.Desc.(*linuxNTFile)
			for _, entry := range fileNote.entries {
				r := &offsetReaderAt{
					reader: exe,
					offset: entry.Start - (entry.FileOfs * fileNote.PageSize),
				}
				memory.Add(r, entry.Start, entry.End-entry.Start)
			}
		}
	}

	// Load memory segments from exe and then from the core file,
	// allowing the corefile to overwrite previously loaded segments
	for _, elfFile := range []*elf.File{exeELF, core} {
		if elfFile == nil {
			continue
		}
		for _, prog := range elfFile.Progs {
			if prog.Type == elf.PT_LOAD {
				if prog.Filesz == 0 {
					continue
				}
				r := &offsetReaderAt{
					reader: prog.ReaderAt,
					offset: prog.Vaddr,
				}
				memory.Add(r, prog.Vaddr, prog.Filesz)
			}
		}
	}
	return memory
}
```

我们重点关注下半部分的readers构建情况：

```
		for _, prog := range elfFile.Progs {
			if prog.Type == elf.PT_LOAD {
				if prog.Filesz == 0 {
					continue
				}
				r := &offsetReaderAt{
					reader: prog.ReaderAt,
					offset: prog.Vaddr,
				}
				memory.Add(r, prog.Vaddr, prog.Filesz)
			}
		}
```

我们只处理有映射，并且FileSZ !=0 的部分，如果FileSZ==0，索性直接不处理了（联想下我们readNote时也没有记录下文件名，也没法读取，实际上读取了，由于这些文件本身可能内容变了，对我们也没什么用）。然后就将这些有数据的内存给放到咱们的SplicedMemory中，每个VMA都对应着这样的一个reader：

```go
				r := &offsetReaderAt{
					reader: prog.ReaderAt,
					offset: prog.Vaddr,
				}
```

后续当我们需要读取内存时，就不是像调试进程那样通过ptrace(PTRACE_PEEKTEXT/PEEKDATA, ...)那样读取了，而是直接从这里的SplicedMemory中的readers中读取：
1、先根据要读取的起始地址、数据量确定大约在哪些VMAs对应的readers中；
2、然后从这些readers中读取；
3、这里的每个reader要读取的数据的起始地址都已经记录好了，起始地址起始就是Core文件中每个PT_LOAD类型的VirtSize。
   ps: part1部分我们提到过，在可执行程序中，VirtSize表示PT_LOAD类型在进程地址空间中的加载地址，但是在Core文件中，它表示在Core文件中的偏移量。

#### 后续读取寄存器操作

这个自然就更简单了，这些信息都记录在了PT_NOTE对一个的segment里，我们读取时就已经解析好了，并放置到了合适的数据结构里，自然不是什么问题。

#### 唯一美中不足的是

唯一美中不足的是，有些FileSZ==0的非匿名mapped file对应的VMA，这部分数据可能内核没有写出，而这些mapped file在事后又被修改了。即使我们读取回来也和当时问题现场不一致。这个是个现实问题。

tinydbg，没有处理这些mapped file的读取，而是直接选择性忽略了。因为即使它支持读取，其实也没法善后处理这些真实存在的问题。
tinydbg做到现在这样，及很好了，see discussion here: https://github.com/go-delve/delve/discussions/4031。

#### 后续初始化及调试

之后，调试器继续初始化完调试会话、网络通信部分，就可以基于core文件查看问题现场，并尝试定位问题了。

### 执行测试

即使打开了core文件，也只是读了一份快照，虽然重建了问题现场，但是并不是重建了进程，所以调试会话中的涉及到执行类的调试命令都是没法执行的。core文件调试，通常使用bt观察堆栈、frame选择栈帧并通过locals、args来查看函数参数、局部变量信息。

测试示例，略。

### 本文总结

