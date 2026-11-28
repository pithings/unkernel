<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- Copyright (C) 2026 Pooya Parsa <pooya@pi0.io> -->
# guest/

What runs inside unkernel: the base initramfs that the kernel bundle
(`unkernel.wasm`) boots, the distro images it mounts under an overlay root
(with their index `distros.json`), and the guest programs. The npm package
carries the bundle; the images are release assets that the SDK's
`fetchDistro()` and the CLI download (.agents/js.md). Behaviour and
invariants: `.agents/kernel/guest.md` (the images) and
`.agents/data-disk.md` (the overlay root on the data disk). `test/guest/`
is unrelated: kwemu's own test programs.

```sh
guest/build.sh base                  # vendor/build/initramfs/base.cpio (+ base-test.cpio)
guest/build.sh distro [NAME...]      # vendor/build/distro/NAME.{erofs,ext4,id}; default: all; then index
guest/build.sh index                 # vendor/build/distro/distros.json for the images there
guest/build.sh list                  # the distros and their versions
kernel/build.sh base                 # base, then the bundle vendor/build/bundle/unkernel.wasm
kernel/build.sh distro [NAME...]     # the same as guest/build.sh distro
```

## Layout

| Path | What |
| --- | --- |
| `build.sh` | the driver; it finds the distros as `distro/*/build.sh` |
| `lib/` | bash, sourced only: `env.sh` (paths, `cc_guest`; sources `kernel/tools/env.sh`), `stage.sh` (`distro_unpack`, `install_tree`, `install_common`, `install_user`, `install_readme`), `image.sh` (`distro_images`: the erofs and ext4 images) |
| `common/` | what every distro image has from a source of its own: `README` (the user's `/home/user/README`, rendered per distro by `install_readme`: `@KEY@` values, `@if DISTRO` ... `@end` blocks) |
| `tools/` | host tools: `mkcpio.py` (cpio archives), `mktree.py` (an image's tar stream and id), `erofs-utils.sh` (pinned mkfs.erofs, with `erofs-utils-patches/`), `erofs-trace.py` (the files a traced boot read), `distros-json.mjs` (the index), `vm-run.ts` (run a command in an image at build time); `pins.sh` (erofs-utils, lz4, zstd) |
| `src/` | the guest programs in the base's kw layer: `kwtty`, `kw9p`, `kwvsock`, `kwshm`, `kwwasi`, `kwcmd`, linked as one program with `kwbox.c` (`/usr/bin/kwbox`: `kwbox TOOL ARGS`); `glimmer`, which every distro image gets (`install_common`, `lib/stage.sh`); `src/test/`: `kwtest`, `kwbench`, `abitest` (base-test.cpio) |
| `base/` | `build.sh`, `pins.sh` (static busybox), `initramfs/` (the cpio root: `/init`, the base shell), `rootfs/` (the kw layer, `/kw/layer`: on top of every distro's root; `build.sh` adds guest Vulkan's ICD to it from `vk/icd/build.sh`: `/usr/lib/kw/libvulkan_kw.so` and `/usr/share/vulkan/icd.d/kw_icd.json`) |
| `distro/NAME/` | `build.sh`, `pins.sh`, `rootfs/` (files added to the image); Debian: `tools/` (apt-lz4); Arch: `tools/` (commands.py) |

`distros.json` (written by `guest/build.sh distro` and `index`, and
refreshed by `kernel/build.sh base`, `kernel`, `smp`, `lower` and
`datadisk`) indexes the images of the output directory for the base bundle
(the one of `KW_BASE_OUT`, else `vendor/build/bundle/unkernel.wasm`); a
release publishes it with the images and the bundle:

```json
{ "abi": 4, "base": "base-<hash>",
  "distros": [{ "name": "alpine", "file": "alpine.erofs", "size": 4317184, "sha256": "<hex>", "image": "alpine-3.24.4-<hash>" }] }
```

One entry per distro: `NAME.erofs`, or `NAME.ext4` without one; Alpine
first, then by name. `abi` is the bundle's `KW_ABI_VERSION`, `base` its
base id (`/kw/layer/usr/lib/kw-base`), `image` the image id from `NAME.id`.

## Conventions

- `initramfs/`, `base/rootfs/` and `distro/*/rootfs/` are mirror trees:
  each file at its installed path and name. `install_tree` copies one
  into a staged root without the file's leading header (an optional `#!`
  line, then the comment block with the SPDX line, ended by an empty
  line; `#` or `//` comments), so images carry none; a file without
  comment syntax keeps its header in `NAME.license`, which is not
  installed. Mode: 755 with the x bit, else 644 (umask 022); anything else
  is set by the build script. No heredocs for image content.
- What unkernel adds to an image is named `kw-*` or lives under
  `/usr/lib/kw/`, so the kw layer never shadows a distro's file. The kw
  layer is RAM-resident: keep it small. Its scripts run the base's busybox
  (`#!/run/kw-lower/bin/busybox sh`), so they work on any distro, and only
  gain features: a distro image may meet a newer base, but an image from
  before kwbox (its init runs `/usr/bin/kwtty`) gets the base shell on a
  base with it, which says why (.agents/kernel/guest.md, Guest tools).
- Build scripts are `build.sh`, pins `pins.sh`; pins live next to their
  owner (`kernel/build.sh` keeps the kernel's and the toolchain's).
- Builds are reproducible: an identical rebuild gives byte-identical
  cpio archives and images, with the same ids.
- An erofs image starts with the distro header (`lib/image.sh`
  `distro_hint`), 128 or 136 bytes at offset 0, before the superblock at
  1024: `KWDISTRO`, version 1, header length, then u64 image size and u64
  `prefetch` (bytes from the start a boot reads; the image size: fetch it
  whole; 0: no hint), the distro name (32 bytes) and the image id (64),
  NUL-padded, little-endian, and in a 136-byte header u64 `background`
  (the end of the warm set; js/core/distro.ts). The SDK fetches
  `[0, prefetch)` ahead when it reads the image over HTTP, and
  `[prefetch, background)` once the boot is done. The image is
  laid out so that a boot's reads are one piece at its front: all inodes
  and directories, then the data of the files a boot to the prompt and a
  first exec reads (found by booting an uncompressed image of the same
  tree as the page boots it, with kwshm and `kw.wayland=1`, `tools/vm-run.ts
  --trace`, the same set in every boot so far),
  then those of the distro's warm set (what the first commands after the
  prompt read, `KW_WARM_SCRIPT` in its build.sh: Debian's apt; the list
  `distro/NAME/warm-files`), both without fragments, then the rest
  (`lib/image.sh`, the patched mkfs.erofs's `--sort=tar --nofrag-first
  --MZ-front`). An image of at most `KW_PREFETCH_WHOLE_MAX` bytes (16 MiB)
  is fetched whole; for a larger one `prefetch` is what a boot of the
  final image reads of that piece, rounded up to 1 MiB, and `background`
  the end of the warm set's data, rounded up to 1 MiB. Both need the base
  bundle and node, like Debian's apt cache; without them the image is not
  ordered, and a larger one gets `prefetch` 0.

## Environment

`KW_BUILD` (output root, default `vendor/build`), `KW_BASE_OUT` (the
base's cpio files and, with `kernel/build.sh base`, `unkernel.wasm`; not
copied to `web/kernel/`), `KW_DISTRO_OUT` (images and staging trees),
`KW_DISTRO_FORMATS` (`erofs ext4`), `KW_EROFS_COMPRESS`, `KW_EROFS_OPTS`,
`KW_EXT4_SLACK`, `KW_RELEASE=1` (base.cpio without the test programs),
`NAME_TARBALL=file` (another upstream tarball), `KW_DEBIAN_APT_CACHE=0`,
`KW_DISTRO_HINT=0` (no distro header, no boot layout), `KW_DISTRO_TRACE=1`
(boot the image here and record `distro/NAME/boot-files` again: what a
boot reads, laid out first in the erofs image; and `warm-files`, where the
distro has a warm set), `KW_PREFETCH_WHOLE_MAX`. A build beside the
main outputs:

```sh
KW_BASE_OUT=/tmp/b kernel/build.sh base
KW_BASE_OUT=/tmp/b KW_DISTRO_OUT=/tmp/d guest/build.sh distro
node js/cli.ts --kernel /tmp/b/unkernel.wasm --distro /tmp/d/alpine.erofs
UNKERNEL_TEST_BASE_KERNEL=/tmp/b/unkernel.wasm UNKERNEL_TEST_DISTRO_DIR=/tmp/d pnpm test:distro
UNKERNEL_TEST_KERNEL=/tmp/b/unkernel.wasm UNKERNEL_TEST_DISTRO_DIR=/tmp/d pnpm test:api
```

## Adding a distro

1. `distro/NAME/pins.sh`: `NAME_VERSION`, `NAME_URL`, `NAME_SHA256`,
   `NAME_TARBALL_NAME` (NAME upper-case), the upstream root file system
   tarball for arm64 (`[a-z0-9]+` for the name).
2. `distro/NAME/build.sh` (executable): source `lib/env.sh`, `lib/stage.sh`,
   `lib/image.sh` and the pins; `distro_unpack NAME VAR` (the tree in
   `$stage`, `/usr/lib/kw-distro` written); `install_tree
   "$guest/distro/NAME/rootfs" "$stage"`; end with `distro_images NAME
   "$stage" "$NAME_TARBALL" "NAME-$NAME_VERSION"`, which writes
   `/usr/lib/kw-image` and prints the image id last. It gets `KW_DISTRO`
   and `KW_DISTRO_DIR` from the driver.
3. `distro/NAME/rootfs/`: at least an executable `/sbin/init` (or what it
   links to), or `/usr/local/sbin/kw-init`, which the base execs first
   (where a package manager may replace `/sbin/init`: Debian). The base has mounted `/dev`, `/proc`, `/sys`, `/run`, `/tmp`
   and `/data`; init runs `/usr/lib/kw/rc`, `/usr/lib/kw/welcome` and
   `/usr/lib/kw/net`, keeps `/usr/bin/kwbox tty login` on hvc0 (the console's
   shell, as the image's user) and `/usr/bin/kwbox tty serve` running, and at
   poweroff stops every process and runs `/usr/lib/kw/shutdown` before
   reboot(2) (Debian's `kw-init` is a small example; `poweroff` must work
   for the user, through `sudo -n`). The build gives the image sudo (or a
   `sudo` command) without a password for the user, `install_user` (the
   account, in the distro's audio, video and input groups) and
   `install_readme` (its values for `guest/common/README`), passes
   `"${user_owner[@]}"` to `distro_images`, and makes the distro's
   interactive non-login shells source `/usr/lib/kw/shrc`. The image must
   not carry the kw layer's files.
4. `guest/build.sh distro NAME`, then boot it with `node js/cli.ts --distro
   NAME`; `test/distro.test.ts` lists the distros it runs. Once a release
   carries it (distros.json lists every image built), `fetchDistro("NAME")`
   and `npx unkernel --distro NAME` find it.
