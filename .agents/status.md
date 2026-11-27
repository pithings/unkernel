# Status: roadmap and open issues

Remove items when they are done.

## Not in the image

The FreeDOS launcher app (`web/src/apps/media/dos.ts`, hidden) boots the FreeDOS
1.2 boot floppy in Alpine's qemu-system-i386 with the curses display. On
the riscv64 guest it was too slow for the launcher (about 70 s from qemu's
start to the prompt, 2026-11-15), also with a stripped FDCONFIG.SYS and
AUTOEXEC.BAT and resuming from a qemu state saved at the prompt (in the
app now): qemu's TCG keeps writing new code, which kwemu interprets or
recompiles. Not yet run on the aarch64 guest (Alpine has qemu-system-i386
and qemu-ui-curses 11.0.3 for aarch64).

WASI programs on the host's engine (prototype; js.md, WASI programs):
`guest/src/kwwasi.c` is a binfmt_misc
interpreter for `\0asm\1\0\0\0` that sends argv, environment, the preopen
and the module's identity over vsock port 1021 (the module only when the
host has not compiled it for that identity) and then does the program's
file I/O in the guest as that process. `serveWasiPrograms(vm.vsock)` (CLI
`--wasi`) compiles each module once (js.md, Modules) and runs each program in a
worker of its own, started by the owner of `vm.vsock`; its WASI file calls
round-trip to the owner, which talks to kwwasi: through a SharedArrayBuffer
per program (the worker blocks in `Atomics.wait`, the owner wakes on
`Atomics.waitAsync`) where one can be used (Node, isolated pages), else as
messages to and from JSPI Suspending imports. A kill of kwwasi
(Ctrl-C, SIGKILL, SIGPIPE) or the machine's end terminates the worker at
once, mid computation too; a worker whose program ended by itself is kept
idle for the next one (two at most). Programs are left out of snapshots:
they do not block one, and after a restore kwwasi exits 126 ("lost the
connection to the host"), also while it waits for stdin. The base's kw
layer has kwwasi and its rc registers it; `node test/wasi-binfmt.ts
[--worker] [--messages]` (on Alpine) installs a fresh build through a
mount and registers it by hand if needed. It passes inline, in
a worker and with `UNKERNEL_TEST_CPUS=2`, on the shared path and with
`--messages`, with its file-system, clock, socket and wasi-threads checks (2026-11-27, aarch64;
the snapshot part with one CPU only, from before SMP kernels had snapshots), and the built CLI (`pnpm build`,
`dist/cli.mjs --wasi`, inline and `--cpus 2`) ran programs on the shared
path (a Ctrl-C through it was tried on the message path only). Preview 0
modules (`wasi_unstable`) run adapted (js.md): wasienv's Lua 5.4 shell
(`@antonz/lua-wasi`) runs scripts, file I/O with seeks, stdin and its
REPL; its SQLite 3.44.2 shell (`@antonz/sqlite-wasi`) runs SQL given as
arguments, but SQL on stdin does nothing, also under Node's own
`node:wasi`: it is built with SQLITE_SHELL_FIDDLE, whose shell never reads
stdin (2026-11-18).
Numbers (Node 24.22, V8 13.6, 16 cores). On the aarch64 guest (the test's
own figures, inline, 2026-11-19): 1e9 rounds of an xorshift loop 6.5 s on
the first run and 1.8 s on later ones as wasm, against 3.5 s as aarch64 in
the guest; a 16-byte pread 52 µs; a 16 MiB copy 0.09 s. The first run is
Liftoff code all along: `_start` is called once and V8 13.6 has no
on-stack replacement for wasm (no flag for it), so the TurboFan code that
dynamic tiering makes serves only later calls (later runs reuse it: the
posted module shares the tiered-up code). A process-wide `--no-liftoff`
would also slow the kernel's own compile, and the JS API has no
per-module choice. The rest was measured on the riscv64 guest
(2026-11-18); the host side is the same:
- A small request (one-byte write or read, 16-byte pread, stat; medians
  of 6 runs): shared path 37-55 µs inline, 86-101 µs in worker mode,
  95-129 µs with 2 CPUs; message path 85-105 µs inline. The program's
  thread to kwwasi and back is most of it (kwwasi's syscall itself
  1.3-2.4 µs). Without the 200 µs spin the shared path took 68-74 µs
  inline (Atomics.wait's wakeup); spins of 50-200 µs did equally well
  inline, worker mode needed 200.
- Throughput (32 MiB in 64 KiB or 1 MiB reads and writes of a tmpfs
  file): shared path inline 470/753 MB/s reading and 454/740 writing,
  worker mode 400/759 and 393/695, 2 CPUs 335/579 and 341/425, message
  path inline 388/891 and 359/818. Copying payloads in kwwasi to coalesce
  its sends made 64 KiB requests 2x slower: copies under emulation cost
  more than the syscalls they save.
- Start to exit (`fork`+`exec`+`wait` in the guest): nop.wasm about
  0.9 ms median, hello.wasm 1.5-1.7 ms, on either path. The floor is the
  guest's process start and exit, the vsock connect (160-215 µs) and the
  "start" and "exit" messages to the program's worker. A new worker per
  program would cost about 41 ms (a bare Node worker starts in about
  20 ms), hence the idle ones kept.
- Module identity (modules on a 9p mount, through the guest shell): a
  hello world with a 100 MiB custom section 0.63 s on its first run and
  0.01 s later, four at once 0.80 s cold and 0.09 s warm; CPython 3.15.2
  (32 MiB) `-c pass` 0.37 s first and 0.06-0.07 s later. A copy made less
  than 2 s before it runs is sent each time (0.14-0.16 s).
- A `sleep 0.5` or a console write beside a computing program takes as
  long as alone, in every mode; a killed program's worker exits within
  3 ms of the guest seeing kwwasi exit.
- Bare round trips between a Node worker and its main thread: messages
  both ways 37 µs (55 µs with 64 KiB), a message there and the reply in
  a SharedArrayBuffer with Atomics.wait 25 µs, both ways through one
  with Atomics.waitAsync on the main thread 19 µs (39 µs with 64 KiB). A
  thread asleep in Atomics.wait takes tens of µs to wake; spinning avoids
  that.
Open:
- Browsers: `js/web/wasi.ts` and its entry are written and the build
  inlines them, but no browser has run them.
- The shared path's spin keeps the program's thread busy up to 200 µs per
  request it waits on; not measured on a phone or a host with few cores.
- A busy guest stalls every request (2026-11-18, riscv64 guest): one
  write beside a native busy loop took 35.7 ms inline and 20.1 ms in
  worker mode, against 37-87 µs alone; with 2 CPUs 0.1-0.13 ms (the loop
  on the other CPU), 20 ms in an occasional run. The host's packets
  reach a busy kernel only when its thread runs the event loop: inline the
  owner is the kernel's thread, so the program's request (a waitAsync
  task or a message) waits for the kernel to suspend; in worker mode the
  owner's packets go to the kernel's worker as messages, handled only
  while it is suspended, and the guest's packets leave from a microtask
  (worker-serve.ts) unless 64 KiB wait. A busy kernel suspends every 20 ms
  (kernel.md, IRQs and time). Nothing in kwwasi or the WASI host can reach
  it, and no existing wake or flush is per connection. A fix is generic:
  in worker mode, vsock packets through the shared transport's rings
  (worker-shared.ts, worker-serve.ts, worker-host.ts), drained by
  `Kernel.poller` at each slice end as console input and evdev are, and
  the guest's packets out from the import into a ring the owner waits on;
  inline, a synchronous path from a program's channel to the guest and
  back inside the kernel's slice-end clock import (the web streams resolve
  in microtasks, which do not run inside an import): a synchronous
  connection API in vsock.ts and a poller hook beside the console ring's.
  Either changes how every vsock connection's packets cross (9p mounts,
  kwtty and exec(), connect() and --forward, snapshots' "packets in
  flight"), so it is not done here.
- Worker mode and SMP add 45-50 µs to each small request against inline
  (above): the request packet goes to the kernel's worker as a message,
  the reply comes back as one, and an idle kernel worker is woken by a
  "kick" message. The same shared-ring transport would remove the
  messages; it is generic, as above.
- A snapshot taken while a program streams data can still be refused
  ("vsock packets in flight"), as for any vsock traffic (not tried).
- wasi-libc's cwd is always "/" (`getcwd()`), so relative and absolute
  paths reach kwwasi alike and it guesses by what exists (js.md, Paths and
  the cwd; `KWWASI_CWD` overrides); the preopen replaces an inherited
  descriptor 3. poll_oneoff's fd events come from a guest poll(); sockets
  are only those the program inherits or `KWWASI_TCPLISTEN` opens
  (preview 1 has no socket or connect); no `proc_raise`, no signals to the
  program.
- Clocks: a program's realtime and monotonic clocks are the guest's as of
  its START (js.md, Clocks): a later `date -s`, or a guest monotonic clock
  slewed by an NTP daemon, is not followed. Browsers have no thread CPU
  clock: CPU time is the time since the start there. A threaded program's
  process CPU clock read while other threads run is a round trip to the
  owner that samples each of their workers (js.md, Clocks): medians of
  90-155 us with two or four threads computing, 220-235 us with one,
  120-155 us with two sleeping (inline and in a worker, Node 24.22,
  2026-11-27), so a thread reuses the answer for 5 ms, by which the other
  threads' share lags; a loop of reads with two threads computing took
  0.49-0.62 us per read against 0.44-0.46 us with no other thread. `threads.wasm cpu 3` read 98% of the
  threads' time (twice what clock 3 showed them half way) while they
  waited and after the joins, `cpulive 2` 1.96-2.00 x the wall time.
- wasi-threads: the test runs only Zig's std.Thread (`test/wasi/threads.zig`;
  zig 0.16's wasi-libc has no pthreads). Rust 1.98 `wasm32-wasip1-threads`
  programs ran by hand (std::thread and its sync types, rayon, tokio;
  2026-11-27); wasi-sdk builds have not been tried, nor threads in a browser. A thread's
  fd_close of the preopen or fd_renumber of it changes only that thread's
  view of the preopens (each worker keeps its own list). A new worker per
  thread beyond the idle ones costs a worker's start (about 20-40 ms on
  Node).

## Roadmap

1. **JIT and interpreter** (a64/performance.md, Next levers; kwemu.md,
   Next steps). Node, Bun and Claude Code, in order: measure V8's
   worker-thread cycles and the decode share again; more tenured capacity
   or a second-chance ring (mixed sequences still evict compiled code;
   each 64K ops cost 1 MiB of guest RAM per CPU) only if long sessions
   show the same; per-CPU code caches on
   SMP; a cheaper decoder only if decode stays above about 8% of npm's
   time. Apk
   and shell: bigger regions (most remaining exits leave full ones), exits
   into self-loop modules, `run`'s entry path and region prologues, NZCV
   materialisation. Not worth revisiting: the compile threshold and heat
   policy, the block-table size, the interpreter's dispatch.
2. **A64 features**: ARMv8.0-A with AES, PMULL, SHA1, SHA2, CRC32, LSE,
   SHA512 and SHA3 is in (a64/isa.md, What is implemented). Not implemented: SVE/SME, SM3
   and SM4, FP16 arithmetic, RNDR, later-architecture encodings (the
   coverage tool lists what corpora use). The interpreter's AES is
   bitsliced; compiled AES reads data-indexed tables, so it is not
   constant-time on the host.
3. A cheaper data-TLB fast path, which also helps without the JIT.
4. **Worker mode** (`createKernel({ worker: true })`, CLI `--worker`, page
   default where the page is cross-origin isolated, `?worker=0` off;
   js.md, Worker mode). The page default since 2026-11-19, with a
   one-load fallback to the page's thread (web.md); still to do: a hand
   test on an iPhone over https, the page in desktop Safari and Firefox,
   and browser tests for worker mode. Open:
   - Without cross-origin isolation (a plain-http LAN page) input and
     frames wait for the worker's next yield (up to 20 ms while the guest
     is busy).
   - Console output from the worker is posted only when the kernel
     suspends (per microtask).
   - A `display` function is re-asked only on resize(),
     `updateDisplaySize()` and the page's resize and rotate toggle, not
     when a program opens /dev/fb0.
   - The CLI's `--worker` compiles the kernel before it creates the
     worker, so it pays the worker's startup in series (about 34 ms).
   - The page's fallback for an engine that cannot post a compiled module
     to a worker (boot.ts, `inWorker`) has never run: no such engine was
     found.
5. **One kernel shared by many tabs** in a SharedWorker, over the existing
   message protocol (it cannot share memory with pages; each tab could
   show its own terminal windows, web.md). Check first: SharedWorker on Chrome for
   Android, and JSPI inside one. A service worker is unsuitable, since
   browsers stop idle ones.
6. **glibc distros and systemd**: Debian 13 is a distro image
   (`--distro debian`, kernel/guest.md) with apt; the page's Ubuntu app
   runs Ubuntu Base in a chroot on Alpine. systemd (once installed from
   apt) booted Ubuntu Base 26.10 to multi-user.target on 2026-11-18; no
   image ships it. Next: systemd as a distro's init with the kw layer's
   network, BPF, keys, IPv6 and cgroup controllers if a service needs them
   (costs in kernel/config.md), the ENOSYS and illegal-instruction logging
   run on Debian.
7. **Stack switching.** The wasm stack-switching proposal is at Phase 3,
   behind a flag in V8 and missing from WebKit (Node 26:
   `--experimental-wasm-wasmfx`). With a module-defined memory and stub
   (or `fd_pread`-backed) kwblk/kwnet imports, that is what a standalone
   WASI runtime still needs. The generic services already use WASI
   preview 1.
8. **SMP** (experimental; kernel/smp.md; js.md, CPU threads; web.md,
   Several CPUs). The SMP kernel is a second build of the same tree, one
   kernel instance per CPU thread on a shared memory (so cross-origin
   isolation and a secure context in browsers), with per-CPU kwemu state
   and JIT tables, wasm atomics for the guest's exclusives and LSE
   atomics, and TLB shootdowns through the polled IRQ bits; release
   bundles carry the patch to it. JSPI-suspended stacks cannot move
   between threads, so a task moves only where its stack can be dropped
   and it can start on a fresh one (kernel/smp.md, Moving tasks); parking
   and snapshots work (kernel/parking.md, SMP). Measured on the
   riscv64 guest (2026-11-16 and 17, Node, i7-10700K): on one CPU against
   the UP build, user code, syscalls and copies are unchanged, while
   anonymous faults cost +40% and fork+exit+wait +46% (atomics, spinlocks,
   per-CPU offsets; kernel/smp.md, Costs); compiled loops scale 1.99x on
   2 CPUs and 3.9x on 4, gzip/bzip2/awk jobs 1.94x and 3.81x (kwemu.md,
   Numbers). The scratch stress tools (kwtlb, kwfork, kwwake and others)
   are in `vendor/smp-deferred/tools`.
   Open, roughly in order:
   - A task preempted in the kernel (`cond_resched()`) or asleep in a
     system call still stays on its CPU until it reaches user mode;
     only its later placement improved (kernel/smp.md, Placement). A long system call
     beside another task on its CPU therefore shares that CPU while
     another idles, until it returns; nothing measured needed more.
     Ending interruptible sleeps to move the sleeper (as parking does)
     is not done: calls that do not restart would return EINTR at the
     scheduler's whim.
   - Device I/O is serialised on CPU 0 and pays two cross-thread wakeups
     per request from another CPU (kernel/smp.md, Devices; a synchronous
     4 KiB O_DIRECT read took 80-90 µs from CPU 1 against 30-40 µs from
     CPU 0, riscv64 guest, 2026-11-16); adaptive idle polling
     (below) or completing on the submitting CPU would cut that.
   - Snapshots work on SMP with the CPU count they were saved with (a
     park cycle costs 13-15 ms under load, mostly a grace period in
     flight finishing; kernel/parking.md, SMP), also the page's Suspend
     (item 10).
   - Console ring (js.md, CPU threads), paths that never ran: the
     reader's 4 ms polling where the main thread has no
     `Atomics.waitAsync`, the drop path in a real guest (stress test
     only), CPU 0 stuck inside the kernel. A single write over 64 KiB
     is split into records that another CPU's write can land between.
   - No browser test in `web/test/` covers the CPUs option.
   - JIT on SMP, what is left: TLB flushes no longer wait for a CPU
     that compiles or yields to its host (kwemu.md, JIT on several
     CPUs, and Numbers, Compile stalls), but other IPIs do (`membarrier()`,
     other cross-CPU calls; a wakeup onto a compiling CPU starts after
     the compile), and so does a flush whose IPI was already on its way
     when the compile began; modules are not shared between CPUs, so a
     task that moves compiles its hot code again; exclusive pairs and
     CASP stay interpreter calls in compiled code (a64/jit.md, Atomics in
     compiled code).
   - Scaling stops near 4x: independent shell loops ran 2.9x on 4 CPUs,
     3.8x on 8 and 3.2x on 16 (Node, i7-10700K, 8 cores), 4.0x on 14
     (Chrome, 14-thread Mac), so 8 CPUs give little over 4 (testing.md,
     Profiling CPUs and worker mode, 2026-11-19). Not yet traced (a
     `kernel/build.sh stats` kernel's per-CPU counters would say where the
     CPUs wait). On other workloads (/smp-probe.html, 2026-11-23, the
     same Mac) 8 CPUs ran 5.4-6.9x in Chrome and 5.2-5.8x in Safari.
     Guest LDAR and LDXR are still wasm atomic loads, which JavaScriptCore
     runs as read-modify-writes: threads that load one shared word in a
     loop may contend there (not measured).
   - Under host load (kernel/smp.md, Waiting for another CPU): a
     synchronous TLB shootdown to a
     CPU running user code still waits until that CPU's host thread runs
     again (kwload's `shoot` 2-36 s at 4-8 CPUs beside 24 spinners);
     nothing in the guest can shorten it, so fewer guest CPUs than free
     host cores is the remedy (a CLI warning for `--cpus` above
     `os.availableParallelism()` is not built). Spinlocks taken out of
     turn have no starvation bound (a waiter that has waited,
     say, 1 ms could take a ticket; nothing measured needs it), and
     nothing switches `kw_spin_unfair=` by itself. Bare `cpu_relax()`
     loops (seqcount retries) do not take the timer.
   - Aligned `get_user()` and `put_user()` copy through `memcpy` (wasm
     `memory.copy`), which the wasm spec does not make single-copy
     atomic on a shared memory, unlike plain wasm loads and stores: a
     futex word read beside user stores on another CPU could tear.
     None seen (2026-11-17: 7.8 million `FUTEX_WAIT` reads of a word
     another CPU flips between 0 and ~0, 2 CPUs), and the futex paths
     retry on an unexpected value. Scalar `__get_user_fn` and
     `__put_user_fn` for aligned 1, 2, 4 and 8 bytes would make it so.
   - Browsers (2026-11-17; js.md, CPU threads; web.md, Several CPUs):
     `js/web/cpu.ts` starts each CPU as a Web Worker, nested in worker
     mode's kernel worker (CPU 0 must be able to block, so not on a
     page's main thread), and the page has a CPUs option (`?cpus=N`, the
     suggested count by default in worker mode) that loads the SMP bundle only then and falls back to
     one CPU. Run in headless Chromium (2 and 4 CPUs: boot, a terminal
     window, glimmer, the JIT on every CPU, parallel loops scaling) and
     by hand on a deployed build in desktop Chrome, Firefox and on iOS.
     Desktop Safari 27.2 runs it and scales as Chrome does (testing.md,
     Profiling CPUs and worker mode). Not
     tried: Android, a hidden tab (worker throttling), long sessions. The page offers it when its release
     bundle carries the SMP patch, as releases do since 2026-11-17
     (testing.md, Release workflow, lists the SMP checks the workflow
     still lacks). Several CPUs on the aarch64 guest are checked in Node
     only (kwtest on 2 and 4 CPUs, abitest on 2, 2026-11-18), not on the
     page.
   - Deferred fork and wakeup changes, measured 2026-11-16 (kwfork,
     9 alternating rounds; patches and a README with their base in
     `vendor/smp-deferred/`, which is gitignored like all of vendor):
     - Cheaper barriers: `smp_load_acquire()` and `smp_store_release()`
       as wasm atomic loads and stores instead of a plain access and
       `atomic.fence`, and `smp_mb__{before,after}_atomic()` as compiler
       barriers. Fences per fork 558 to 230. Waits for a decision on
       supported hosts: the RMW half counts on V8 compiling an atomic
       RMW as a full barrier, which holds on x86-64 and on arm64 with
       LSE but not on arm64 without it; it also adds one clang warning
       (a misaligned atomic in `objpool.h`).
     - Adaptive idle polling (`kw_idle_poll_us=`, off by default): an
       idle CPU polls its pending word for up to that long, adapting as
       KVM's `halt_poll_ns` does, before its host thread sleeps. With
       200 on two CPUs fork+exit+wait 110.5 to 67.8 µs, of an 8 MiB
       process 194.7 to 156.6 µs; a fixed 100 µs poll slowed fork+exec
       loops instead. A policy choice: it burns host CPU (1-4 points of
       a host core for light guest activity, an idle guest about none)
       for wakeup latency, and on a busy host it makes things worse (a
       polling thread looks busy to the host; alone as bad as without
       the blocking waits of kernel/smp.md, Waiting for another CPU, with
       them pipe ping-pong 1.5-3x slower). Rebased onto the load
       study's patch 1 as `load/load-3-idle-poll.patch`.
     - Rejected: `sched_fork_local=1` (a fork child starts on its
       parent's CPU) made two parallel fork+exec loops on two CPUs take
       0.65 s against 0.39; `smp_rmb()`/`smp_wmb()` as compiler barriers
       hold only on x86-64 hosts.
9. **Listening-port detection** for the preview chip and CLI
   auto-forward: a `kwtty ports` subcommand in C that re-reads
   `/proc/net/tcp` every 3 s (a stdin byte rescans at once) and prints
   changes, spawned only while someone subscribes. Each check wakes the
   kernel for about 1.3 ms of host CPU (2026-11-15); no listen event
   exists without a kernel patch.
10. **Snapshots** (save and restore the machine). Parking and snapshots
    with the console, disks, display, input, sound, shm, vsock and network
    are in (kernel/parking.md; js.md; data-disk.md): the SDK's
    `snapshot({ stop })`, `snapshot({ commit })` (stops only once the
    caller stored it) and `restore` (inline and in worker mode), the
    CLI's `{save=FILE}`, `{suspend=FILE}` and `--restore`, and the page's
    Suspend and resume (web.md). A snapshot stays restorable only
    while its disks are unchanged; vsock sessions and guest TCP
    connections do not survive a restore (the guest's ends are reset), but
    host file systems do, with their open files (inline only; worker-mode
    snapshots refuse while anything is mounted). Next, roughly in order:
    - **Rewind and fork**: restore one snapshot again after the disk moved
      on, or several times. Needs the disk state frozen at the seal, e.g.
      the CowDisk overlay frozen as a read-only layer under a new one.
    - **Mounts in worker-mode snapshots**: the owner's 9p state would have
      to be saved at the worker's snapshot point.
    - **Fewer EBUSY refusals**: a job-control-stopped task (^Z) never
      parks, because `arch_do_signal_or_restart` keeps the restart state
      in locals (moving `retval`, `restart_addr` and `continue_addr` into
      `pt_regs` would make it re-enterable); ptrace stops and FUSE waits
      (the daemon is parked first) stay EBUSY; a kthread created but never
      woken blocks a snapshot. The SDK error names the blocker; the page
      shows it as a failed Suspend.
    - **Page**: a browser test for Suspend and Resume (checked by hand
      only); suspending in the background (the commit, then the hold
      that goes on in place when the tab is shown) and the question on
      leaving tried on real phones, iOS first, and desktop browsers
      (web.md, Suspend and resume; saving at the moment the tab closes
      stays out, it says why); resuming in place instead of the reload
      that Resume does.
    - **Size**: dropping clean page cache before the seal pays off only
      with a root on a disk (the default root is tmpfs: no gain measured,
      2026-11-15).
    - **SMP**: snapshots work in the SDK, the CLI and the page
      (kernel/parking.md, SMP; js.md, Snapshots; web.md, Suspend and
      resume), restorable only with the CPU count they were saved with
      (each task is held on its CPU). Not yet run in a browser: the
      page's Suspend and resume with several CPUs.
    Known costs: parking makes epoll_wait and socket-timeout waits return
    EINTR once per snapshot; every new kernel thread needs a park point
    (kernel/parking.md).

## Host file systems: follow-ups

- The patch `9p: add metatimeout` is not upstream. It refuses
  write-back cache modes (EINVAL; kernel/devices.md, 9p); making it work with
  them would need a flush of dirty pages before each refresh.
- An adapter from mountx drivers (MIT) to the `Fs` handler interface is a
  possible follow-up.
- The page does not expose mounts.
- `vm.mount()` runs one kwtty session per mount; createKernel's mounts
  could share one.
- nodeFs is not safe against the host swapping a directory for a symlink
  between the guest's walk and its next request (no openat2
  RESOLVE_BENEATH in Node).

## Open issues

- **aarch64: the release workflow has not run its build path yet.** New
  in CI are the arm64 patch series (a new kernel tree and build: every
  kernel cache misses), the aarch64 minirootfs, the guest programs from `zig cc`, and abitest.
  Before the first aarch64 release it needs one smoke run (`release`
  unchecked), which shows its time on a hosted runner and whether
  kwtest's timing checks hold there with the A64 JIT.
- **aarch64: the rest of AdvSIMD FP and system instructions are calls
  of the interpreter in compiled code.** The A64 JIT (a64/jit.md)
  translates every ALU, memory and branch op, the frequent FP moves,
  compares and AdvSIMD moves, scalar FP arithmetic, min/max, FMADD and
  conversions (with a fast path that needs FPCR's defaults and calls the
  interpreter off it; FMADD, and double FMUL, FDIV and FSQRT without a
  zero input, only once FPSR.IXC is set) inline
  (generic.zig), and where the host compiles SIMD the integer AdvSIMD
  ops, the AdvSIMD FP forms a64/jit.md lists (vector arithmetic, min/max,
  compares, single-precision FMLA/FMLS and conversions; a fast path, and
  off it a call that stores only the V registers read), LD1/ST1, LDP/STP
  of V registers, AES, PMULL, SHA1, SHA256 and SHA512 (vec.zig); the
  other generic ops (among them the scalar AdvSIMD FP forms, pairwise and
  across-lanes FP, FMULX, FABD, FACGE/FACGT, the reciprocal estimates and
  steps, FRINT*, the other FCVT* and the 2D FMLA/FMLS and conversions)
  are calls of the reference interpreter through the kernel's function
  table, with the module's registers spilled around them (2026-11-24).
  Exclusives, LDAR/STLR and the LSE atomics are inline too, with wasm
  atomics in SMP builds (atomic.zig); pairs and CASP stay calls.
- **aarch64: OpenSSL's NEON and crypto paths need wasm SIMD in the
  host.** The image's libcrypto now picks its code from HWCAP and the
  kernel enables SHA512 by default, because the JIT translates those
  paths (aes-128-gcm 99 MB/s, sha256 157, sha512 217 against 24, 59, 131
  on the integer paths; 2026-11-18, a64/performance.md). A host whose
  engine has no SIMD (V8 on an x86-64 without SSE4.1) runs them as
  interpreter calls, 2-13x slower than the integer paths would be; such a
  host could boot with `kw.isa=-sha512` or set `OPENSSL_armcap=0`.
- **aarch64 page: not yet opened in a browser.** The launcher's apps (web.md,
  Launcher), the stand-ins (web.md, Stand-ins) and qemu-user are checked
  through the Node SDK only (2026-11-18): static busybox binaries of
  x86_64, riscv64, i386 and armv7 each installed their qemu and library
  root on first run in 8-9 s and then ran in 0.2-0.3 s. In a browser,
  writing claude's 357 MB and opencode's 248 MB to the IndexedDB data disk
  has not been timed, and every app's first run there waits on Wisp
  instead of the host's network.
- **kwfb: mmap racing a mode change.** An `mmap` of `/dev/fb0` racing a
  mode change from another thread of the same program can map the old
  buffer (found 2026-11-16, on UP too). Not fixed.
- **One long syscall delays the host.** Every syscall and page fault
  costs 1000 instructions of the 200k slice, so kernel-bound
  loops end slices, but a single syscall that stays in the kernel for long
  holds off the 20 ms yield until it returns, and host events and the timer
  until it returns or calls `cond_resched()`.
- **Safari on plain http has no JIT** (web.md). The page does not warn.
- **JavaScriptCore and freed JIT modules**: not confirmed on a phone, and
  about 50 MiB of growth per long WebKit session is unexplained (kwemu.md,
  Collecting freed modules).
- The browser keeps every range-fetched root-disk chunk in memory, and data
  disk export and import hold the whole image in memory.
- The syscall comparison in README.md (Performance, Benchmarks) has no
  committed script and is not measured again on the aarch64 guest. It was
  measured 2026-11-14 under Node with a static riscv64 C benchmark as
  `/init` of a cpio, against native x86, `qemu-riscv64` and
  `qemu-system-riscv64 -M virt` with Alpine's linux-lts.
- Kernel limits are in kernel.md (arm64 user ABI), the data-disk and
  overlay limits in data-disk.md.
