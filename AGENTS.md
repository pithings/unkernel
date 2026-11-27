# AGENTS.md

unkernel runs Linux 7.3, compiled to a single wasm module (`arch/wasm` with an
MMU), in Node 24 or a browser with JSPI. User space is unmodified aarch64
Linux ELF (ARMv8.0-A with FP, AdvSIMD and the crypto, CRC32 and LSE
extensions; a64/isa.md), run by kwemu, a software CPU in Zig linked
into the kernel: the AArch64 front end (src/a64: a reference interpreter, a
decoded-op tier and a wasm JIT) on an ISA-neutral MMU, block cache and JIT
core (src/emu). Its contract with the kernel is `include/kw_emu.h` (ABI 3).
The kernel bundle (`unkernel.wasm`) carries a small base initramfs that
boots a distro image (Alpine or Debian, read-only erofs, attached as a disk)
under an overlay root, or the base shell without one. README.md is the overview,
kernel/README.md maps the kernel directory and its build steps, and
guest/README.md the guest side (base initramfs, distro images, guest
programs).

`.agents/` has one file per area. Read the one for the area you change:

| File | Covers |
| --- | --- |
| [.agents/kernel.md](.agents/kernel.md) | kernel tree and patch workflow, `kw_emu.h` contract, memory model, JSPI, host imports, IRQs, arm64 user ABI, the two builds and two kernels; `.agents/kernel/` holds SMP, parking and snapshots, devices, config, kernel tests, guest images |
| [.agents/a64.md](.agents/a64.md) | the AArch64 CPU (src/a64): layout, group-file conventions, adding instructions, tests; `.agents/a64/` holds instruction semantics and the coverage tool (`isa.md`), the decoded-op tier (`tier.md`), the JIT (`jit.md`), numbers, rejected designs and levers (`performance.md`) |
| [.agents/kwemu.md](.agents/kwemu.md) | the ISA-neutral core: MMU and TLBs, block cache, JIT core (regions, invariants, SMP, compile window, host contract), softfloat, measuring, rejected designs |
| [.agents/js.md](.agents/js.md) | the SDK (`js/`): rules, build checks, disks, network stack and Wisp |
| [.agents/web.md](.agents/web.md) | the browser page, releasing its kernel, engine quirks |
| [.agents/data-disk.md](.agents/data-disk.md) | the persistent data disk, overlay root, safe mode, image updates |
| [.agents/toolchain.md](.agents/toolchain.md) | patched wasm-ld, Binaryen, Zig 0.16, host tools, pinned downloads |
| [.agents/testing.md](.agents/testing.md) | quick checks per area, CLI exit codes, the full matrix, release CI |
| [.agents/gl.md](.agents/gl.md) | guest GL through virgl on WebGL2 (branch `webgl`): plan, measurements, headless tests |
| [.agents/vk.md](.agents/vk.md) | guest Vulkan on WebGPU (kwvk): the ICD, the host renderer, the SPIR-V translator, the relay and headless tests |
| [.agents/va.md](.agents/va.md) | guest VA-API on WebCodecs (kwva): the libva driver, the host decoder and its codecs (VP9, H.264, AV1, HEVC), decoders other than the modelled one, zero-copy output (dmabuf export into virtio-gpu resources), the relay and headless tests |
| [.agents/x64.md](.agents/x64.md) | x86-64 and i386 guest binaries: box64 and qemu-user behind binfmt_misc, what runs and what does not, measurements, a native front end and its references |
| [.agents/status.md](.agents/status.md) | roadmap and open issues; read only for planning, or when asked |

## Building and testing

```sh
./setup.sh                  # check prerequisites, then zig build + kernel/build.sh all
zig build test              # A64 unit tests and guests against qemu-aarch64
kernel/build.sh kernel      # the UP kernel, refreshes the bundle (smp: the SMP kernel)
node js/cli.ts              # boot Alpine (vendor/build/distro) on the bundle; --help lists options
```

Run the quick check for what you changed (testing.md, Quick checks); the
full matrix is for releases or when asked. Do not run the browser tests
(`web/test/`) unless asked.

`vendor/` (gitignored) holds the kernel tree `vendor/src/linux-wasm-kernel`
(branch `kw-arm64-user`), `vendor/src/llvm22`, the toolchain and all build
outputs; `kernel/patches/` is the only durable record of those branches.

## Easy to break

These cut across areas; each area file lists its own invariants.

- Bump `KW_ABI_VERSION` on any layout or semantic change to
  `include/kw_emu.h` (kernel.md).
- `kw_defconfig` is maintained by hand and Kconfig drops options silently:
  check `$KOUT/.config` after changing it.
- Never use `switch_root` in the guest's init: it empties rootfs, the
  overlay's lower layer (data-disk.md).
- Never clear the IndexedDB store `kwdisk:kwdata-v1` in code or tests: it
  is the user's persistent disk (data-disk.md).

## Changing things

- **Kernel**: commit on `kw-arm64-user` in `vendor/src/linux-wasm-kernel`,
  then export so that `kernel/patches/linux/` equals
  `format-patch -N 7595a62d45e..kw-arm64-user` (kernel.md).
- **wasm-ld**: commit in `vendor/src/llvm22`, run `kernel/build.sh
  toolchain`, and re-export (toolchain.md).
- **Guest image**: `kernel/build.sh base` (the base initramfs and the
  bundle) or `kernel/build.sh distro [NAME]` (the images and
  `distros.json`); guest/README.md.
- **Page**: kernel and guest changes reach the deployed page with the next
  release (`.github/workflows/release.yml`, which the maintainer runs
  by hand; web.md).

## Conventions

- When asked to commit, commit on `main` rather than a new branch, unless
  told otherwise.
- Commit messages are imperative sentences, optionally prefixed with an
  area (`web: `); kernel patches use kernel style (kernel.md). No
  `Signed-off-by` lines.
- New files get an SPDX header and a copyright line: GPL-2.0-or-later,
  except MIT for JavaScript (`js/`, `web/`, SDK tests) and GPL-2.0-only
  for kernel patches.
- If a change contradicts a statement in a doc, fix that statement in the
  same commit. Do not audit the docs or document new details unless asked.
  Docs describe the current state (no history, no commit hashes); date
  measurements.
