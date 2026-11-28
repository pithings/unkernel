# Kernel

How to change the kernel (`arch/wasm` and the drivers) and what must not
break. Longer topics are in `.agents/kernel/`:

| File | Covers |
| --- | --- |
| [kernel/smp.md](kernel/smp.md) | the SMP build: model, moving tasks, IPIs, MM, waiting for another CPU, devices, costs |
| [kernel/parking.md](kernel/parking.md) | parking every task, snapshots and restore, on UP and on SMP |
| [kernel/devices.md](kernel/devices.md) | console, kwblk, kwnet, kwfb, kwinput, kwsnd, kwvsock, kwshm, kwvirtio and virtio-gpu, 9p |
| [kernel/config.md](kernel/config.md) | `kw_defconfig` rules, what is on and off, measured options |
| [kernel/tests.md](kernel/tests.md) | kwtest and abitest coverage, other checks, debugging |
| [kernel/guest.md](kernel/guest.md) | the base initramfs and its shell, the kw layer, the Alpine, Arch and Debian images, guest tools and shims |

## Tree and patch workflow

`vendor/src/linux-wasm-kernel` is a git tree on branch `kw-arm64-user`:
base `7595a62d45e` (Linux v7.3.4 from kernel.org) plus one commit per file
in `kernel/patches/linux/`. On a fresh clone build.sh
(`prepare_kernel_tree`) creates the branch with `git am` on a shallow
fetch (`git fetch --deepen=100` for more history; `LINUX_REPO` names where
the base comes from); it warns when the checked-out HEAD of `KSRC` has
another number of commits than the series has patches.

`arch/wasm` grew from Joel Severin's linux-wasm series (`joelseverin/linux`,
branch `wasm-7.0`); nothing is fetched from that fork. The first two
patches (the arch panic hook, modpost on Wasm) are his as they were, and
the arch patch, which keeps about a quarter of its lines from his port,
names him in a `Co-developed-by` trailer (keep it when rewording that
patch).

```sh
cd vendor/src/linux-wasm-kernel
git commit -a          # a new patch, or `git commit --fixup X` and then
                       # GIT_SEQUENCE_EDITOR=: git -c rebase.updateRefs=false rebase -i --autosquash 7595a62d45e
cd ../../..
kernel/build.sh kernel
rm kernel/patches/linux/*.patch
git -C vendor/src/linux-wasm-kernel format-patch -N -o "$PWD/kernel/patches/linux" 7595a62d45e..kw-arm64-user
```

- One patch per piece, in this order: generic changes (Joel's two, stock
  LLVM, `VMALLOC_FLAT`, 9p `metatimeout`, the kthread park points, the
  random vmfork reseed, the switches for NET_DEVMEM, DRM_PANEL_BRIDGE,
  DRM_DDC and DRM_HDMI_INFOFRAMES, the virtio-gpu damage-clip backports
  and capset wait, `drop_caches()` for callers in the kernel); the arch;
  the ISA; each driver (kwblk, kwnet,
  kwfb, kwinput, sysrq, kwsnd, kwvsock, kwshm, kwvirtio); parking; kwvsock's reset
  after a restore; `kw_defconfig`; then the SMP series (the atomics and
  shared-memory build, the atomic tweaks, the generic mm, sched, kthread,
  workqueue and csd hooks, the arch and per-driver SMP patches, blocking
  waits, unfair spinlocks, not waiting for a compiling CPU);
  `wasm: run arm64 user space`, which rewrites the arch and ISA patches'
  riscv64 user ABI (registers, syscalls, uapi, ELF, signals, cpuinfo, the
  feature table and `kw.isa=`, the exclusive monitor, the kernel's copy of
  `kw_emu.h`); and last the guest pc sampling (prof.c).
- A fix or an extension of a piece is a `git commit --fixup` of its patch,
  autosquashed; an arm64 fix, or a kwemu ABI change that changes the
  header or what the kernel advertises, is a fixup of `wasm: run arm64
  user space`. A
  new piece (a driver, a generic change) is a new patch placed with its
  kind, with a kernel-style subject (`wasm: ...`); its config options go in
  the `kw_defconfig` patch. Each patch need not build on its own; the
  whole series must.
- Keep `-N` (no `n/m` counter) on export.
- To check that the series applies to a clean base:
  `git -C vendor/src/linux-wasm-kernel worktree add /path/x 7595a62d45e && git -C /path/x am "$PWD"/kernel/patches/linux/*.patch`,
  built with `KSRC=/path/x KOUT=vendor/build/kernel-x kernel/build.sh kernel`.
- Kbuild runs the toolchain through
  `kernel/tools/fake-llvm/llvm-wrapper.py` (`LLVM=` is the wrapper,
  `REAL_LLVM=` the real tools; toolchain.md).
- Config: config.md. The kernel builds without warnings; keep it that way.

## Where things are in the kernel tree

| What | Where |
| --- | --- |
| entry, task switch, `kw_resume`, `kw_secondary_entry`, `kw_secondary_resume` | `arch/wasm/kernel/entry.S`, `process.c` |
| user-mode loop (`kw_run` slices, IRQ and timer checks, yield) | `arch/wasm/kernel/traps.c` (`KW_SLICE` 200000, `KW_ENTRY_COST` 1000, `KW_YIELD_NS` 20 ms) |
| parking, `/proc/kwpark` | `arch/wasm/kernel/park.c`, `asm/park.h`, `include/linux/kw_park.h` |
| SMP: CPU bring-up, `kw_host_call()`; IPIs; waits | `arch/wasm/kernel/smp.c`, `irq.c`, `wait.c` |
| WASI wrappers, `wasi_ptr()` | `arch/wasm/kernel/wasi.c` |
| sync IRQ | `arch/wasm/kernel/sync.c` |
| kwemu glue, ABI check, `kw_cpu_storage` | `arch/wasm/mm/tlb.c` |
| software uaccess and the fault path | `arch/wasm/mm/fault.c` |
| flat vmalloc | `mm/vmalloc-flat.c` (`CONFIG_VMALLOC_FLAT`) |
| arm64 syscall table | `arch/wasm/kernel/Makefile.syscalls`, `syscall_table.c` |
| arm64 `mmap`, `personality` | `arch/wasm/kernel/sys.c` |
| arm64 signal frames, `[sigpage]` | `arch/wasm/kernel/signal.c`, `arch/wasm/mm/sigpage.c` |
| arm64 uapi | `arch/wasm/include/uapi/asm/`, `include/asm/elf.h` |
| features: the table, `kw.isa=`, AT_HWCAP, cpuinfo | `arch/wasm/kernel/cpu.c`, `kw_isa_init()` from `tlb.c` |
| IRQ numbers, IPI bits | `arch/wasm/include/asm/irq.h` |
| guest pc sampling (`kw_prof`, its rings and file names) | `arch/wasm/kernel/prof.c`, `asm/kwprof.h` |
| devices | `drivers/tty/hvc/hvc_wasm.c`, `drivers/block/kwblk.c`, `drivers/net/kwnet.c`, `drivers/video/fbdev/kwfb.c`, `drivers/input/kwinput.c`, `sound/drivers/kwsnd.c`, `net/vmw_vsock/kwvsock.c`, `drivers/misc/kwshm.c`, `drivers/virtio/kwvirtio.c` |

## The kwemu contract (`include/kw_emu.h`)

`include/kw_emu.h` is the source of truth; the kernel's copy is
`arch/wasm/include/asm/kw_emu.h`. build.sh copies the header over it and
warns if they differed, so a header change also needs a kernel commit and
a patch re-export.

- `KW_ABI_VERSION` is 4. `tlb.c` compares it with `kw_abi_version()` at
  boot and panics on a mismatch. Bump it in both copies on any change to
  the layout or the semantics; the header describes the current contract
  only. A new `KW_ISA_*` bit is an ABI change; implementing an extension
  that already has a bit is not. Host imports are not part of it. Nothing
  persistent keys on the number (snapshots check the banner), so a bump
  needs no migration. The riscv64 guest's releases carry 8, so a number
  names a contract only together with the guest; the page build refuses a
  release whose number is not this one (web.md, The page's kernel).
- ISA extensions: `kw_cpu_init` enables every one kwemu implements; `tlb.c`
  then calls `kw_isa_init()` (cpu.c), which calls `kw_set_isa()` once with
  what `kw.isa=` leaves on and advertises exactly the set it returns.
  `kw_set_isa()` drops all decoded code, so it is for boot only.
- `kw_host_reset()` is for a restored snapshot (`__kw_resume`, and each
  other CPU's `kw_secondary_restart()` on SMP): the memory
  belongs to a new module instance, so kwemu forgets its JIT slots without
  `kw_host_jit_free`, asks `kw_host_jit_caps` again and drops all decoded
  code.
- `KW_CPU_SIZE` is 9 MiB, reserved statically (`kw_cpu_storage`), so it
  comes out of guest RAM; about 28 KiB of it is spare with the JIT
  (kwemu.md, Numbers, Sizes). Zig checks its layouts against the header at compile
  time through translate-c.
- kwemu has no allocator and no globals: all state is in `struct kw_cpu`
  and `struct kw_regs`, which the kernel owns. The atomics build (SMP
  kernels) has two static words in kwemu's data section, shared by every
  CPU as they must be: `pair_lock` (128-bit STXP and CASP) and
  `code_epoch` (IC IVAU on any CPU; a64/tier.md, Coherence). A snapshot
  is taken with every CPU out of `kw_run()`, so `pair_lock` is free in it,
  and `code_epoch` only counts up (kernel/parking.md, SMP).
- User page tables are read at `phys_base + pa` (Memory model), and kwemu
  never writes a PTE: if A is 0, or D is 0 on a store, it raises
  `KW_EV_FAULT`, and the kernel sets the bits directly (a fast path, like
  Svadu) or goes through `handle_mm_fault`.
- Flushes: `flush_tlb_*` and `update_mmu_cache` call
  `kw_flush_tlb_range`/`kw_flush_tlb_all`, `switch_mm` calls `kw_set_pgd`.
  Code the kernel or the host writes (COW copies, page reuse, file data,
  kwshm) becomes visible only after one of these or a guest IC IVAU. A
  CPU's own guest stores into decoded code are tracked exactly and need no
  flush (kw_emu.h, Decoded-code cache).
- `kw_clear_reservation` runs before every `kw_run()` in
  `user_mode_loop()` (traps.c), as ERET clears the exclusive monitor on
  arm64, so an STXR after a syscall, a fault, an interrupt, a signal or a
  task switch fails. That is the only call of `kw_run()` and nothing runs
  between the two (UP `local_irq_enable()` only sets a flag, SMP sets it
  without delivering, and there is no preemption). A stop that was only an
  instruction sample of the profiler (prof.c) enters `kw_run()` again
  without it, as if user code had not stopped.
- kwemu polls `*irq_pending` (`&wasm_host_irqs`, or the CPU's word on SMP)
  on entry and at every block end, so at least every 64 instructions, and
  returns `KW_EV_INTERRUPT`.
- `CNTVCT_EL0` counts this CPU's retired instructions (`CNTFRQ_EL0` says 1
  GHz), not wall time; hence no vDSO, and `clock_gettime` is a real
  syscall (musl and glibc fall back to it without `AT_SYSINFO_EHDR`).
- kwemu answers every MRS that arm64 Linux allows or emulates at EL0
  (MIDR_EL1 0x000f0000, MPIDR, REVIDR, the ID_AA64* space with Linux's EL0
  view, ID_AA64ISAR0_EL1 from the enabled features), so the kernel
  emulates no instruction: every `KW_EV_ILLEGAL` is SIGILL. WFI and WFE
  are NOPs.
- The JIT imports (`unkernel.kw_host_jit_caps`/`compile`/`free`) are not
  part of the ABI version (a host takes a missing `flags` argument of
  `compile` as 0), and the kernel never calls them. Only a kwemu built with
  `-Dkwemu-jit=true` (build.sh's default; `KWEMU_JIT=0` leaves it out)
  imports them, and it then owns 1024 stub functions in the kernel's
  exported `__indirect_function_table` (kwemu.md; a64/jit.md). A host
  that returns 0 from `kw_host_jit_caps` gets the interpreter only.

## Memory model

- The kernel runs only in the direct map: virtual = physical = linear
  address, and `phys_base` is 0. Guest RAM is below 4 GiB.
- User page tables use the RISC-V Sv48 layout and PTE bits whatever the
  guest ISA (`_PAGE_PROT_NONE` = G, arch/riscv's swap format), in 4 levels
  with the P4D folded; kwemu walks them like hardware.
- vmalloc returns direct-mapped memory (`mm/vmalloc-flat.c`), so `vmap()`
  of scattered pages returns NULL (nothing in this config hits that).
  There is no `VMAP_STACK` and no stack guard; per-cpu memory is
  `percpu-km`. Kernel stacks are 16 KiB shadow stacks; overflow is not
  detected.
- uaccess (`copy_{to,from}_user`, `clear_user`, futex ops; fault.c) walks
  the user page tables in software and faults pages in;
  `get_user`/`put_user` and `strn*_user` are the generic ones on top.
  - As a hardware MMU retries the access, `kw_user_addr()` walks again for
    as long as the fault succeeds (another thread may take the page away in
    between: a zap, a fork's COW write-protect). A real fault error, a
    fatal signal or `pagefault_disable()` ends it; after 10000 rounds it
    gives up with a one-time warning (a fault handler that never maps the
    page; on UP nothing else would end the loop). Under host load other
    threads took the page away up to 17 times in a row (2026-11-17).
  - A kernel access is ended by a fatal signal only, so its faults wait
    killable, not interruptible (no `FAULT_FLAG_INTERRUPTIBLE`, as GUP): an
    interruptible wait that a pending signal ends at once would spin, and
    the kernel does not poll the tick in such a loop.
  - The futex ops on user words are wasm atomics (plain accesses without
    the atomics feature).
- Kernel memory is not shared (no SharedArrayBuffer) in the UP kernel. The
  arch Makefile's `KW_ATOMICS=1` (wasm atomics, so the `__atomic_*`
  builtins become atomic instructions) and `KW_SHARED_MEMORY=1` (also
  `--shared-memory`: passive data segments, initialised by the start
  function `__wasm_init_memory`) build a UP kernel on a shared memory;
  kwemu must then be built with `-Dkwemu-atomics=true`, and the host
  detects the shared import. The SMP kernel always links that way.

## Tasks: JSPI

- Every kernel task runs on its own wasm stack. `__switch_to` calls the
  suspending import `wasm_switch_to`, which parks the current stack on a
  promise and resumes the next one, or starts a fresh stack through the
  promising export `ret_from_fork`. `__stack_pointer` and `current` are
  wasm globals, saved in locals across the switch (entry.S).
- The UP kernel has one CPU and `ARCH_NO_PREEMPT`; the SMP kernel has one
  such thread per CPU (smp.md).
- **Suspending imports**: `unkernel.wasm_switch_to`,
  `unkernel.wasm_snapshot_point` (only for `snapshot({ commit })`, which
  holds the kernel at its consistent point; parking.md) and the WASI
  `poll_oneoff`, `sched_yield` and `proc_exit`, and only when the host
  returns a promise. Every other import must return synchronously; in
  particular `wasm_driver_block_submit` is called by blk-mq in atomic
  context, and the console's zero-timeout `poll_oneoff` must not suspend.
- `Kernel.stop()` and every exit make the suspending imports return a
  never-settling promise (a fresh one each time, so a dropped instance can
  be collected), and the kernel parks at its next suspension point.
- Keep task switching behind `wasm_switch_to`/`ret_from_fork`, so that wasm
  stack switching can replace JSPI later (status.md).

## Parking

A task suspended in JSPI cannot be saved, so parking brings every task to a
point where its state is all in memory, and resumes each on a fresh stack;
snapshots are built on it. **Every kernel thread needs a
`kw_park_point()` in its loop**, or every cycle fails with EBUSY naming it.
Parking and snapshots work on both kernels. Details:
[kernel/parking.md](kernel/parking.md).

## Host interface

The runtime is `js/core/kernel.ts` (`Kernel`) with `js/core/wasi.ts`, shared
by Node and browsers (js.md). A host must provide every import, or
instantiation fails; a standalone WASI runtime cannot run the kernel.

**`wasi_snapshot_preview1`** (kernel `wasi.c`):

- `clock_time_get` (monotonic for clocksource, sched_clock and timer;
  realtime for the boot wall clock) and `random_get`.
- `fd_write` (1 = console, 2 = panic text), `fd_read` (0 = console input),
  `poll_oneoff` (idle, and zero-timeout stdin checks; uvwasi answers those
  with the clock event alone, so the kernel also reads once whenever an
  earlier poll reported stdin readable), `sched_yield`, and `proc_exit` (0
  = power off, 1 = halt, 2 = restart, 253 = panic).
- `args_*`: the command line is argv[1..] joined with spaces (the runtime
  passes `["vmlinux", cmdline]`).
- `fd_prestat_*`, `path_open`, `fd_filestat_get`, `fd_read`, `fd_close`:
  the initrd is the file `initrd` in the first preopened directory that
  has one, read into memory memblock allocates below 4 GiB. The runtime
  preopens `/` with the bundled or given initramfs.
- Preview 1 is a wasm32 ABI, in both builds. Declare pointer and size
  parameters `u32` and pass them through `wasi_ptr()`, which panics above 4
  GiB. Anything that may live in high RAM goes through a static buffer in
  the kernel image or the bounce buffer.

**`unkernel`**: `wasm_switch_to`, `wasm_snapshot_point` (parking.md),
`wasm_init_flag`, `wasm_cpu_count`, `wasm_cpu_start` (also from a
restored snapshot's `__kw_resume()`, which the host answers with
`kw_secondary_resume`) and `wasm_stack_drop` (SMP kernels only),
`wasm_driver_console_size`, `wasm_dump_stacktrace`, the device imports (`wasm_driver_block_*`, `_net_*`, `_fb_*`, `_input_*`,
`_sound_*`, `_vsock_*`, `_shm_*`, `_virtio_*`; devices.md) and kwemu's
`kw_host_jit_caps`/`compile`/`free` (host `js/core/jit.ts`). **`env`**
holds only `memory`, fixed size, chosen by the host.

The host writes kernel memory only for `wasm_host_irqs` (and with a
profile the other CPUs' words, and `kw_prof`'s flags, period and ring
tails), kwblk and kwnet data, kwinput events, kwvsock packets, kwshm
requests, the pages of shmem files exported to it, and WASI results (and all of it for a restored
snapshot, before `kw_resume`). It does not write `boot_command_line` or the
initrd bounds. `node test/wasi-node.ts` checks the WASI side against
Node's `node:wasi`.

## IRQs and time

- IRQs are bits in `wasm_host_irqs`, written by the host and polled
  (`asm/irq.h`): console = 1 (input or a window resize), net = 2, block = 3
  (completions; on SMP also another CPU's requests for CPU 0), sync = 4
  (`ksys_sync()` from a work item; host `Kernel.requestSync()`), input = 5,
  vsock = 6 (packets queued, or room again after a refused send), shm = 7
  (requests queued), snapshot = 8 (a park cycle that ends in
  `wasm_snapshot_point`; host `Kernel.snapshot()`), profile = 9 (a time
  sample, prof.c; the host's sampler sets it in every CPU's word, without
  a notify: kwemu.md, Measuring), virtio = 10 (kwvirtio: used buffers or a
  config change; on SMP also another CPU's queue notifications for CPU 0),
  drop caches = 11 (set with snapshot: sync and drop the file caches
  before it; parking.md).
  Bits without a handler are cleared and
  ignored. SMP adds a word per CPU and IPI bits 24-27
  (smp.md).
- The timer is a one-shot deadline, checked against the host monotonic
  clock.
- Everything is checked when a slice ends, in `arch_cpu_idle`
  (`wasm_idle(timeout)`: a `poll_oneoff` on stdin and the deadline) and
  every 128 calls of `cond_resched()` (irq.c), so that a kernel loop that
  waits for another task lets it run (direct reclaim, until the OOM victim
  has exited). A
  slice is 200k user instructions of the CPU, not of one `kw_run` call:
  `cpu->budget` is refilled only after `KW_EV_BUDGET`/`KW_EV_INTERRUPT`,
  and each syscall and page fault costs `KW_ENTRY_COST` (1000) of it.
  Otherwise a loop of cheap syscalls never sees a timer tick and is never
  preempted (apt busy-polls dpkg's status pipe with `pselect()` after EOF,
  and dpkg would never run again).
- While user code is busy, the kernel yields to the host every 20 ms.
  After idle and after a yield it sets the console bit itself when stdin is
  readable, for hosts that never write `wasm_host_irqs`.
- Every slice end reads the monotonic clock (`clock_time_get`) before
  `wasm_poll_irqs`. Worker mode's shared transport (js.md) drains its input
  rings in that import and sets the IRQ bits there, so the kernel takes
  them in the same slice end (in a guest busy loop the clock ran every 0.6
  ms p90 with the JIT, 1.3 ms without; 2026-11-14). Keep a clock read at
  the slice end if `do_user_interrupt` changes.
- irq_work runs from the timer tick: `arch_irq_work_has_interrupt()` is
  false, since nothing could raise the interrupt (otherwise irq_work never
  runs and every Tiny SRCU `synchronize_srcu()` hangs: inotify `close()`,
  systemd).
- A single long stay in the kernel (one big syscall) delays these checks
  until it returns or calls `cond_resched()` (status.md; what SMP polls
  besides: smp.md).

## SMP

A second build of the same tree (`kw_smp.config`, `kernel/build.sh smp`):
one module instance per CPU in its own host thread on one shared memory.
**A task moves to another CPU only where its JSPI stack can be dropped**:
a user task on its way to user mode, a kthread at a restart point. Device
imports answer on CPU 0 only. Details: [kernel/smp.md](kernel/smp.md).

## arm64 user ABI

The kernel mirrors arch/arm64 without compat (AArch32), a vDSO, SVE, SME,
MTE, PAC, BTI, GCS or POE.

- Syscalls: number in x8, arguments in x0..x5, result in x0 (traps.c,
  asm/syscall.h); numbers from `scripts/syscall.tbl` (arm64's
  `syscall_64.tbl`) with arm64's ABIs `renameat rlimit memfd_secret`,
  through pt_regs wrappers so every syscall has one wasm type. sys.c has
  arm64's `mmap` (offset must be page aligned) and `personality`
  (PER_LINUX32 is EINVAL). Restart backs pc up by 4 (the SVC).
- Generic code takes ABI choices from arch `Kconfig` selects. arm64's clone
  argument order is `CLONE_BACKWARDS` (otherwise `tls` and `child_tid`
  swap and every pthread program breaks); arm64's other ABI selects are
  for compat or BTI. Compare with `arch/arm64/Kconfig` before adding a
  syscall-ABI select. clone: the child's x0 is 0, CLONE_SETTLS sets
  TPIDR_EL0 (otherwise the parent's is kept); exec zeroes every register,
  TPIDR_EL0, FPCR and FPSR.
- uapi: arm64's headers (fcntl: O_DIRECTORY, O_NOFOLLOW, O_DIRECT and
  O_LARGEFILE differ from generic; signal: SA_RESTORER, MINSIGSTKSZ 5120;
  mman, param, posix_types, statfs, auxvec, ptrace, sigcontext,
  sve_context, ucontext, hwcap). `uname -m` is aarch64.
- ELF: `EM_AARCH64`, AT_PLATFORM `aarch64`, AT_HWCAP below, AT_HWCAP2 and
  AT_HWCAP3 0, AT_MINSIGSTKSZ 4720 (arm64 without SVE), no
  AT_SYSINFO_EHDR.
- Signals (signal.c): arm64's rt_sigframe (siginfo, ucontext with x0..x30,
  sp, pc, pstate = NZCV and EL0t, fault_address = the last user fault)
  with an fpsimd_context record (FPSR, FPCR, V0..V31) and the null
  terminator in `__reserved`, and a frame record {x29, x30} above it that
  x29 points to; no ESR record. x30 is `sa_restorer` when SA_RESTORER is
  set (musl and glibc always set it), else the `[sigpage]` page (`mov x8,
  #139; svc #0`). sigreturn checks the records as arm64 does (one FPSIMD
  record of the right size, ESR ignored, anything else invalid), keeps
  NZCV of pstate, refuses a non-EL0t mode, and masks FPCR and FPSR to the
  bits kwemu keeps.
- Features (cpu.c): AT_HWCAP is FP | ASIMD | CPUID (kwemu answers the ID
  registers; `KW_HWCAP_CPUID`) | the KW_ISA_* features `kw_set_isa()`
  enabled: AES, PMULL, SHA1, SHA2, CRC32 (HWCAP bits 3 to 7), LSE
  (HWCAP_ATOMICS, bit 8, listed as `atomics`), SHA3 (bit 17), SHA512 (bit
  21). The `/proc/cpuinfo` `Features` line lists the same names in HWCAP
  order, with arm64's other fields for kwemu's MIDR_EL1 (implementer 0x00,
  architecture 8, variant 0x0, part 0x000, revision 0) and BogoMIPS from
  `loops_per_jiffy` (2000.00). User space picks code paths from these
  (OpenSSL reads AT_HWCAP), so nothing beyond what kwemu runs is listed: no
  SVE, SM3/SM4, FP16 arithmetic, RNG, PAC or BTI.
- `kw.isa=` masks features for A/B measurements and bisecting: a comma
  list applied left to right; `armv8` turns every optional feature off,
  `-aes` one off, `+aes` (or `aes`) one back on; the names are the Features
  line's (`lse` also names `atomics`). kwemu keeps SHA512 only with SHA2,
  so `-sha2` turns both off. A masked feature raises SIGILL like an
  unimplemented instruction. Every feature kwemu implements starts on.
- Address space: user page tables keep the Sv48 format, and TASK_SIZE is
  1 << 48 (256 TiB), arm64's 48-bit VA: all four levels' index bits, with
  no sign-extended upper half (kwemu faults any address at or above
  1 << 48), so large reservations such as .NET's 256 GiB GC regions range
  and Ladybird's 4 TiB GC cage fit. kwemu has no top-byte-ignore, so tagged pointers fault (SIGSEGV),
  and there is no tagged address ABI (`PR_SET_TAGGED_ADDR_CTRL`).
- New code: user space makes it visible with DC CVAU and IC IVAU (CTR_EL0
  has IDC = DIC = 0); there is no cache-flush syscall. IC IVAU on one CPU
  is seen by every CPU (smp.md, MM).
- The exclusive monitor belongs to the CPU, not the task, and every entry
  to user mode clears it (The kwemu contract), as ERET does on arm64 and
  qemu-user does.
- ptrace (ptrace.c): arm64's regsets NT_PRSTATUS (pstate is NZCV and
  EL0t), NT_PRFPREG, NT_ARM_TLS and NT_ARM_SYSTEM_CALL (the syscall
  number apart from x8, as arm64's `syscallno`), which also make the core
  dump notes; single-step in software (traps.c: `kw_run()` with a budget
  of 1, a stepped SVC reported at its exit); no hardware breakpoints or
  watchpoints. The kernel's writes into user code (POKETEXT,
  `/proc/PID/mem`) flush the page (`flush_icache_user_page`, tlb.c). No
  modules, swap or kallsyms (config.md).
  A wasm trap in the kernel ends the session.

## Two builds: wasm64 and lowered

`vmlinux` uses memory64 and table64. `kernel/build.sh lower` runs it
through Binaryen (`wasm-opt -g --memory64-lowering --table64-lowering
-O2`, about 3 s) to make `vmlinux32.wasm`. Pointers stay i64 in the code
and at the JS boundary, so imports, exports and JSPI are unchanged; only memory
and table accesses are wrapped to i32, which is exact because RAM is below
4 GiB. The runtime picks the memory type with `moduleIsMemory64()` and a
shared memory with `moduleIsSharedMemory()`, which read the module's
`target_features` section.

The lowering alone runs at the same speed in V8, is about 20% faster in
JavaScriptCore, and needs no memory64; `-O2` makes the module about 4%
smaller and Debian shell commands (perl, awk, sort, gzip, xz, tar) about
3.5% faster in Node (2026-11-24, medians of 4 interleaved boots; `-O3`
was no faster). The bundle, the page, the CLI's
default and `createKernel()` use it; `vmlinux` stays the build input and
the reference (`--kernel vendor/build/kernel/vmlinux`). `lower` is
required: `wasm-opt` is `$WASM_OPT`, then `vendor/toolchain/binaryen`
(build.sh fetches Binaryen 133 there), then `PATH`, and must know
`--table64-lowering`.

## Two kernels: UP and SMP

One tree, two configs, two output directories: `kernel/build.sh kernel`
builds the UP kernel into `vendor/build/kernel` (`KOUT`), `smp` the SMP
kernel into `vendor/build/kernel-smp` (`KOUT_SMP`) with kwemu built with
atomics in `vendor/build/kwemu-smp` (`KWEMU_SMP=` takes a prebuilt one);
each is lowered, and `all` builds both (`KW_SMP=0`: UP only). `kernel` is
the quick loop and never builds SMP.

- **The bundle** (`kernel/tools/bundle.mjs`, `kernel/build.sh base`:
  `vendor/build/bundle/unkernel.wasm`): `vmlinux32.wasm` with
  `base.cpio` (uncompressed: `--no-gzip` in `bundle_base`), its command
  line and the data disk template in custom sections (`unkernel.initrd`,
  `unkernel.cmdline`, `unkernel.datadisk`), and `unkernel.kernel.smp.kwpatch`, a patch from the
  UP kernel to the SMP one (`tools/kwdiff.mjs`, 1.3 MiB) that the runtime
  applies when asked for more than one CPU (js.md, CPU threads). There is
  no wasm64 bundle. bundle.mjs refuses two kernels that are not the UP and
  SMP builds of one tree: their banners must differ only in `SMP`, kwemu's
  `kw_abi_version()` must return the same constant, only the SMP one may
  import `wasm_cpu_start`, and both must have the same memory index type.
  Every step that refreshes the bundle (`kernel`, `smp`, `lower`,
  `datadisk`, `base`) adds the patch when the SMP kernel exists
  and matches, and otherwise warns and leaves it out, so after a tree
  change `kernel` gives a bundle without the patch until `smp` runs.
  `KW_SMP=1` (and `all`) makes a missing or mismatched SMP kernel an error;
  `KW_SMP=0` leaves it out. The patch takes about 15 s to make, so it is
  cached in `vendor/build/kernel-smp/up.kwpatch` while both kernels stay
  the same. The bundle is copied to `web/kernel/` for `pnpm dev`.
- **Build stamps.** Kernels are reproducible: the same tree, kwemu sources
  and toolchain give the same bytes, and so the same patch (checked
  2026-11-17). `kernel_stamps` exports `KBUILD_BUILD_USER` and `_HOST`
  (`unkernel`), `_VERSION` (the build id: 12 hex digits of a hash of the
  kernel tree's HEAD tree, its uncommitted and untracked changes, the
  repository's `src`, `include`, `build.zig*`, `kernel/patches/llvm` and
  `kernel/tools/fake-llvm`, the zig version and the JIT and stats options)
  and `_TIMESTAMP` (the newest author date on the tree, which a fresh `git
  am` reproduces), unless the environment sets them. The banner reads
  `Linux version 7.3.4+ (unkernel@unkernel) (clang ..., LLD ...) #<id>
  [SMP] <date>`. A snapshot is matched to its kernel by `linux_banner`, so
  every build whose module may differ needs another banner; a different
  clang or wasm-ld changes it through the compiler line. Libraries given as
  `KWEMU=` or `KWEMU_SMP=` count as built from the checkout's sources.
- **Overrides**: `KSRC` (the tree), `KOUT`, `KOUT_SMP`, and `KW_BUILD` (the
  output root, default `vendor/build`: kernels, kwemu-smp and kwemu-stats,
  initramfs, the data disk template, bundle, distro images; the toolchain's
  `vendor/build/lld22` stays; `KW_BASE_OUT` and `KW_DISTRO_OUT` move the base and the distro images, guest/README.md).
  The CLI, `pnpm build` and the tests read `vendor/build`, so pass them
  paths (`--kernel`, `--distro`, `UNKERNEL_TEST_KERNEL`,
  `UNKERNEL_TEST_DISTRO_DIR`). `KWEMU=path` takes a prebuilt
  kwemu as is, `KWEMU=none` links a stub. The header of `build.sh` lists
  the rest.

## Kernel tests

kwtest (`rdinit=/usr/bin/kwtest`), abitest (`rdinit=/usr/bin/abitest`),
kwbench and `node test/wasi-node.ts`, and how to debug a userland that
fails: [kernel/tests.md](kernel/tests.md).
