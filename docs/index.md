---
icon: ph:info-duotone
---

# Introduction

> A real Linux kernel, compiled to WebAssembly. It boots to a shell in less than a second.

unkernel is Linux 7.x built as a single wasm module with a real MMU. The kernel (syscalls, scheduler, memory management, ext4, TCP/IP) is compiled code, not emulated, so programs get Linux's own behavior down to the edge cases. Only user programs are emulated: unmodified aarch64 (arm64) Linux binaries, so Alpine and Debian packages run as they are.

Open a page and you have a Linux machine with a shell, a package manager, a persistent disk, internet access, and a screen with sound. It runs entirely on your device, with nothing to install and no server, and every layer is open source.

![Linux programs run on kwemu, an aarch64 CPU linked into the Linux kernel, built together into unkernel.wasm, which talks to the JavaScript SDK](/architecture.svg)

## Try it

::card-group{cols="3"}
  ::card
  ---
  title: In the browser
  icon: ph:browser-duotone
  to: https://unkernel.dev/
  ---
  Open **unkernel.dev**: a desktop with a shell, after a download of about 10 MB.
  ::

  ::card
  ---
  title: In the terminal
  icon: ph:terminal-window-duotone
  ---
  `npx unkernel` boots Alpine with networking over your host's sockets. **Ctrl-]** quits.
  ::

  ::card
  ---
  title: From JavaScript
  icon: ph:code-duotone
  to: /sdk
  ---
  `npm install unkernel`: a zero-dependency TypeScript SDK for Node and browsers.
  ::
::

:pm-x{command="unkernel"}

```js [boot.mjs]
import { createKernel, fetchDistro } from "unkernel";

const vm = await createKernel({ distro: await fetchDistro("alpine") }); // Alpine, no network
vm.onOutput((bytes) => process.stdout.write(bytes));
vm.write("uname -a; poweroff\n");

const { code, kind } = await vm.exited; // 0, "halt"
```

## Why unkernel

Much of what makes a system feel slow lives in the kernel: starting processes, syscalls, page faults, file and network I/O. In unkernel that path runs at wasm speed.

- **Boot**: the kernel reaches `/init` about 70 ms after it starts, and the Alpine prompt appears 0.3 s after `node` launches.
- **Syscalls at close to native cost**: `getppid` takes about 170 ns (110 native, 1.7 µs under qemu-system).
- **fork at native speed**: fork + exit + wait takes about 60 µs, against about 70 µs natively and 1.2 ms under qemu-system.
- **A JIT for user code**: hot aarch64 code, including the AES, PMULL and SHA instructions OpenSSL uses, is compiled to wasm while it runs.

The syscall and fork numbers were measured on 2026-11-14, the JIT numbers on 2026-11-18. CPU-heavy programs are well behind native.

## A real kernel

Anything a program relies on, from `/proc` and `epoll` to cgroups and overlayfs, behaves as it does on a server, because it runs the same code.

- **A real MMU** (`arch/wasm` with page tables): `fork`, `mmap`, copy-on-write, shared memory, threads and signals behave as they do on hardware. This is not a NOMMU port where programs are limited to `vfork`.
- **Linux's own file systems**: ext4, overlayfs, tmpfs, loop devices, FUSE, and 9p. The root file system is an overlay: a read-only distro image under your changes, which go to a persistent ext4 disk.
- **Linux's own TCP/IP stack**, with DHCP and DNS, reaching the internet through your host's sockets or a Wisp proxy.
- **cgroups, namespaces, userfaultfd, fanotify and TUN**: enough for systemd to boot Ubuntu 26.10 to `multi-user.target`.
- **Devices**: a framebuffer, evdev keyboard, mouse and touch, sound through ALSA, AF_VSOCK, shared memory with the host, and guest GL and Vulkan on the page's WebGL2 and WebGPU.
- **aarch64 user space**: ARMv8.0-A with FP and AdvSIMD plus the crypto, CRC32 and LSE atomics extensions, so distribution binaries run unchanged.

## How it works

The kernel is compiled straight to WebAssembly. User programs run on **kwemu**, an aarch64 CPU written in Zig and linked into the kernel. kwemu walks the kernel's own page tables, so memory management is done by the real Linux code.

When a program makes a syscall, kwemu returns to the kernel, which handles it as native wasm. There is no emulated trap and no emulated kernel mode in between. Task switches use JSPI (`WebAssembly.Suspending`), so the kernel gets real stacks that it can suspend and resume.

## Compared to other approaches

Most "Linux in the browser" projects emulate a whole PC (faithful but slow), emulate the CPU and reimplement the syscalls (fast, but only as much Linux as the runtime implements), or compile programs to wasm (fast, but native programs have to be rebuilt and `fork` breaks). unkernel keeps the best of each.

| Approach | Kernel | User space | MMU |
| --- | --- | --- | --- |
| **unkernel** | ✅ **Linux, native wasm** | ✅ **unmodified aarch64, emulated** | ✅ **real page tables** |
| Whole-machine emulators | ⚠️ Linux, emulated | ✅ unmodified, emulated | ⚠️ emulated |
| Syscall emulators | ❌ none: a runtime reimplements the syscalls | ✅ unmodified, emulated | ⚠️ the runtime's own |
| POSIX runtimes for wasm | ❌ none: a runtime provides the syscalls | ❌ rebuilt for wasm, or JavaScript | ❌ none |
| Linux without an MMU | ✅ Linux, native wasm | ❌ rebuilt for wasm | ❌ none |

## Requirements

unkernel needs [JSPI](https://github.com/WebAssembly/js-promise-integration): Node 24+, Chrome / Edge 137+, Firefox 153+, or Safari 27+ (and any browser on iOS/iPadOS 27).

## License

The project is GPL-2.0-or-later unless a file says otherwise. The JavaScript SDK and page are MIT, so you can embed them anywhere. The npm package ships a Linux kernel (GPL-2.0) with a small base system, so it is `MIT AND GPL-2.0-only`.
