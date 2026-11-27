# Guest images

What goes into the guest (`guest/`, layout and conventions in
`guest/README.md`): the bundle `unkernel.wasm` (the kernel and a small base
initramfs; the default of the SDK, the CLI and the npm package) boots a
distro image, a read-only erofs or ext4 file system the host attaches,
under an overlay root, or the base shell without one. Below: base
initramfs, kw layer, distro images, guest tools. The data disk and
overlay root are in data-disk.md.

## Base initramfs (`kernel/build.sh base`, `guest/base/`)

`guest/build.sh base` writes `vendor/build/initramfs/base.cpio` and
`base-test.cpio`; `kernel/build.sh base` also bundles it as
`vendor/build/bundle/unkernel.wasm` (command line `console=hvc0
rdinit=/init`, the data disk template, the SMP patch) and copies that to
`web/kernel/`. `KW_BASE_OUT=dir` puts all three in dir and copies nothing.
1508 KiB (844 KiB gzipped), bundle 11.0 MiB with base.cpio uncompressed (2026-11-22); 1607 KiB (885 KiB gzipped) with guest Vulkan's ICD (2026-11-24).

- Alpine's static busybox (`busybox-static`, pinned in `base/pins.sh`
  with its own Alpine release), every applet linked in `/bin` (names from
  the binary's applet table), `/init` (`base/initramfs/init`: the boot
  sequence and the state on `/data`, data-disk.md), the base shell
  (`/etc/inittab`, `/kw/lib/sysinit`), and the kw layer at `/kw/layer`.
- The kernel tests and benchmark (`guest/src/test/`: kwtest, abitest,
  kwbench; tests.md) are a second cpio archive after the image's, which the
  kernel unpacks after the first: in `base-test.cpio` always, in
  `base.cpio` unless `KW_RELEASE=1` (the release workflow), so release
  bundles, the npm package and the deployed page have none; boot a release
  bundle with `--initrd base-test` (a checkout's
  `vendor/build/initramfs/base-test.cpio`) to run them. The choice is in
  `guest/base/build.sh`, not `kernel/build.sh`, because `kernel/build.sh`
  is part of CI's kernel cache key.
- `/kw/layer/usr/lib/kw-base` is the base's id (`base-<hash of the
  tree>`).
- `kw.root=base`, no image labelled kwroot (`createKernel()` without
  `distro`, the CLI's `--distro none`), or an image that does not mount or
  boot (also one whose init runs `/usr/bin/kwtty`: from before kwbox, Guest
  tools below): the base shell on the base itself (busybox init, a root shell on hvc0
  with the prompt `base DIR #`, `kwtty serve`, the layer's rc and net),
  with `/data` mounted when there is one; `kw-overlay status NAME` works
  there. Most of `test/api.test.ts` runs on it.

## The kw layer (`guest/base/rootfs/`)

The top lower layer of every distro's root (`/kw/layer` in the base, so
RAM-resident: keep it small). Everything in it is `kw-*`, `kw_*` or under
`/usr/lib/kw/`, so it never shadows a distro's file, except the VA driver's
`virtio_gpu_drv_video.so` link (below); its scripts run the
base's busybox (`#!/run/kw-lower/bin/busybox sh`) and only gain features,
with one floor: an image from before kwbox does not boot on a base with it
(Guest tools, below).

- `/usr/bin/kwbox`: the guest tools kwtty, kw9p, kwvsock, kwshm, kwwasi,
  kwcmd and vtest-bridge as one program, `kwbox TOOL ARGS` (Guest tools,
  below), with `/usr/lib/kw/kwwasi` (binfmt_misc's interpreter, a link to
  it). The image must not carry them:
  kwtty's protocol belongs to the SDK shipped with the kernel. `glimmer` is not in the layer: every distro
  build compiles it into its image (`install_common`, guest/lib/stage.sh),
  so the base shell has none.
- `kwbox vtest` (Guest tools, below): the guest GL forwarder, in
  the layer for the same reason (its link protocol belongs to the SDK's
  `gl` option).
- `/usr/lib/kw/libvulkan_kw.so` and `/usr/share/vulkan/icd.d/kw_icd.json`:
  guest Vulkan's ICD (`vk/icd/build.sh`, aarch64 glibc; vk.md), in the
  layer for the same reason (its link protocol belongs to the SDK's `vk`
  option); the manifest is in the loader's default search path, so
  Debian's `libvulkan1` finds it with no environment variables. Alpine's
  musl loader cannot load it. `KW_VK=0` builds the base without it.
- `/usr/lib/aarch64-linux-gnu/dri/kw_drv_video.so` and the link
  `virtio_gpu_drv_video.so` to it: guest VA-API's libva driver
  (`va/build.sh`; va.md), in the layer for the same reason (its link
  protocol belongs to the SDK's `va` option). libva names a DRM device's
  driver after its kernel driver, `virtio_gpu`, so Debian's `libva2` loads
  it with no environment variables (`LIBVA_DRIVER_NAME=kw` names it
  directly). The link shadows mesa-va-drivers' file of that name, which the
  image does not carry; installing mesa-va-drivers replaces it in the upper
  layer, and removing it again leaves an overlay whiteout over the layer's
  link (`LIBVA_DRIVER_NAME=kw`, or make the link again). `KW_VA=0` builds
  the base without both.
- `/usr/lib/kw/bin/wland`: Wayland apps as windows on the page (web.md,
  Wayland desktop) through wland's relay `/usr/lib/kw/wlandr`
  (https://github.com/pithings/wland, MPL-2.0 and MIT), which only the
  Debian image carries (Distro images, below), not the layer: the static
  aarch64 release binary pinned in `guest/distro/debian/pins.sh`
  (`WLANDR_*`; the `--link`-only build, 341 KB; `KW_WLANDR=<file>` builds
  the image with a local one instead, web.md, Wayland desktop). Without it
  (Alpine, the base shell, a Debian image older than the base) `wland
  --boot` does nothing and `wland` fails saying so. One relay per user (`setsid`, its pid in
  `$XDG_RUNTIME_DIR/wlandr.pid`, its log `wlandr.log` there, afresh for
  each relay) with `--link vsock:2:1023 --buffers kwshm`, plus what its
  `wlandr --version` features line has (a relay without `--version`, the
  pinned release, is read from `--help`): `--link-on-demand` (dial at the
  first app, not at start; after a drop at the next app; a failed dial
  closes the waiting apps at once), and where `/dev/dri/renderD128` exists
  `--dmabuf virtgpu:/dev/dri/renderD128` (GL apps by GPU resource; a
  running relay without it gets a note on how to restart it) with
  `--no-fence-wait`, `--external-buffers` (Vulkan apps' swapchain
  images by id; vk.md, Presentation), and where the image has
  `/usr/lib/kw/xwayland-satellite` and `/tmp/.X11-unix` is there (the
  boot makes it) `--xwayland <it> --lodpi --xwayland-display 1` (feature
  `lodpi`: the relay holds X display :1, :0 being the KMS Xorg's, and
  starts satellite for the first X client on its scale-1 socket
  `wayland-0-lodpi`; it writes the display to `wayland-0.x11`, which
  `kw-wayland.sh` exports as `DISPLAY` where `/usr/bin/Xwayland` exists). `wland --boot` (the layer's rc, as root, with
  `kw.wayland=1` on the command line: the page's boot) starts it for the
  image's user (`kw.user=`, else `user`, else root, as `kwtty login`
  picks), through busybox `su`, after making `/run/user/UID` (0700, the
  user's) and root's `/run/user/0`; only on a distro (not the base
  shell), with `/dev/kwshm` and a relay that has `link-on-demand` (else
  it would dial at once and the page load wland at every boot). `wland
  [CMD...]` starts one where none runs (killed, or not started at boot),
  making `/run/user/UID` (through `sudo -n`) where `XDG_RUNTIME_DIR` is
  unset, then runs CMD with `XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY` (default
  `wayland-0`), the toolkit hints and `LANG` (default C.UTF-8); without
  CMD it prints them as `export` lines. As root it uses the image user's
  running relay (`WAYLAND_DISPLAY` that socket's path, `XDG_RUNTIME_DIR`
  root's own) instead of starting a second one (the page takes one link
  at a time). With an on-demand relay CMD runs as a child, and when it
  fails while the relay's log got a new `wayland client refused` line,
  `wland` says the page did not take the link; with a relay that dials at
  once it fails (exit 1, saying why) when the log has not said the link is
  connected within 3 s (not in the page: an app would wait for a
  compositor forever). Apps close when the link drops. `wland` fails
  without `/dev/kwshm`.
- `/usr/lib/kw/rc`: cgroup2, devpts, `/dev/shm`, `/run/lock`, the
  hostname (`/etc/hostname` unless empty or `localhost`, else
  `unkernel`), binfmt_misc and the WASI format (kwwasi), the console
  user's devices as udev's rules give them (no udev: `/dev/fb*`,
  `/dev/dri/card*` and `/dev/udmabuf` to video, `/dev/input/*` to input, `/dev/dsp*`,
  `/dev/snd/*` to audio, 0660, by group name; `/dev/fuse` and
  `/dev/dri/renderD*` 0666; the drivers make them at boot, none later),
  udev's links `/dev/fd`, `/dev/stdin`, `/dev/stdout` and `/dev/stderr`,
  `drm.vblankoffdelay` 100 ms (kernel/devices.md, kwvirtio), and with
  `kw.wayland=1` wland's relay (`wland --boot`, above).
- The image's user: every distro image has `user` (uid and gid 1000,
  `/home/user` mode 700, `install_user` in guest/lib/stage.sh; bash on
  Debian, `/bin/sh` on Alpine) in audio, video, input and users, plus sudo
  (Debian) or wheel (Alpine), with sudo without a password and without a
  tty (Debian's sudo, `/etc/sudoers.d/kw-user`; Alpine's doas with
  doas-sudo-shim as `sudo`, `/etc/doas.d/kw-user.conf`). kwtty's console
  (`kwtty login`) and sessions run as it (Guest tools, below); the base
  shell, which has no such account, stays root's. `poweroff`, `halt` and
  `reboot` in `/usr/local/sbin` go through `sudo -n` for another user than
  root. Its home has the README (`guest/common/README`, rendered per distro
  by `install_readme`: `@KEY@` values and `@if DISTRO` blocks; root's
  home and the base shell have none).
- `/usr/lib/kw/welcome`: `Welcome to PRETTY_NAME on unkernel (aarch64)`,
  then `/run/kw-overlay.msg` in yellow on a terminal.
- `/usr/lib/kw/net`: lo, and eth0 by DHCP with busybox udhcpc (lease
  script `/usr/lib/kw/udhcpc`, which writes `/etc/resolv.conf` only when
  it changes) on every distro. `net background` (the base shell, Debian's
  kw-init; not Alpine's inittab) leaves DHCP to a job holding
  `/run/kw-net.lock`, so the console's prompt can come before the lease;
  `net wait` waits for that job (with its failure, kept in
  `/run/kw-net.msg` instead of the console, it prints it and exits 1).
  `kwtty serve` starts after `net wait`, so programs the host starts find
  the network; a command typed at the console the moment the prompt shows
  may not (`/usr/lib/kw/net wait` first).
- `/usr/lib/kw/shutdown`: with `/data` mounted, stop every process, then
  `/usr/lib/kw/data-stop` (data-disk.md); then sync. When
  `/run/kw-shutdown` names the action (Alpine's `poweroff`, `reboot` and
  `halt` in `/usr/local/sbin` write it before they signal busybox init),
  it stops every process in any case and ends with that reboot(2) itself,
  skipping busybox init's two 1 s pauses.
- `/usr/lib/kw/shim` and `/usr/lib/kw/bin/{fx,claude,opencode,node,npm,npx,bun,bunx}`
  (Shims, below).
- `/usr/sbin/kw-overlay` (data-disk.md), `/etc/profile.d/kw-path.sh`
  (`/run/kw/bin`, then `~/.local/bin` first on PATH, the sbin directories
  where the distro leaves them out for users (Debian), `/usr/lib/kw/bin`
  last, below), `/etc/profile.d/kw-gl.sh` (with `kw.gl=1` on the command
  line, which the page's GL option adds, and no DRM render node:
  `GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1`, so Mesa renders
  through the host's WebGL2 over vtest; with `/dev/dri` it sets nothing;
  gl.md), `/etc/profile.d/kw-wayland.sh` (a shell gets `XDG_RUNTIME_DIR`
  and `WAYLAND_DISPLAY=wayland-0` for its user's `/run/user/UID` where the
  relay's socket is there, or, with `kw.wayland=1`, wherever that
  directory exists (made at boot for the image's user); root's shells
  there (`sudo -s`, `su`) get the user's socket by its path and
  `/run/user/0`; `sudo CMD` clears them, `sudo /usr/lib/kw/bin/wland CMD`
  does not (sudo's PATH has no `/usr/lib/kw/bin`); wherever
  `WAYLAND_DISPLAY` is set, and for `wland CMD`, which sources it:
  `XDG_SESSION_TYPE=wayland` and the GTK, Qt, SDL, Firefox and Electron
  variables that pick Wayland, each only where unset; builtins only, `[ -O
  / ]` for root) with `/etc/chromium.d/kw-wayland` (Debian's chromium
  wrapper clears `CHROMIUM_FLAGS` and sources that directory:
  `--ozone-platform=wayland` in a Wayland session, and a `chromium` with
  no display at all, such as one not started from a shell, gets wland's
  session first, where `/dev/kwshm` is; with a render node but no
  `libEGL.so.1` it says to install `libegl1 libegl-mesa0`, without which
  Chromium renders in software; web.md, Wayland desktop). Programs the host starts without
  a shell (`vm.exec()`, `vm.spawn()`) get no session: `/etc/environment`
  is static and kwtty sets none, `/etc/profile.d/kw-term.sh
  (busybox init's console is vt102, without colours: TERM becomes
  xterm-256color), the X.Org fbdev/evdev config (below), and
  `/usr/share/licenses/unkernel` (the GPL notice for these files, which
  names the Debian image's wlandr's own licences).
- `/usr/lib/kw/shrc`: the `/etc/profile.d/kw-*.sh` files (PATH, TERM, the
  prompt, command not found, the package manager through sudo) for
  interactive shells that are not login
  shells, which do not read `/etc/profile` (a shell typed at the prompt,
  `sudo -s`, `su`): Debian's `/etc/bash.bashrc` sources it (a line the
  build appends), Alpine's busybox ash reads it as `ENV` (exported by
  kw-prompt.sh; doas sets it for `sudo -s`). Once per shell: a bash login
  shell (bash.bashrc runs before profile.d) skips it, and kw-path.sh sets
  the unexported `_kw_sh`, which ash's ENV (read after profile.d) checks.
  Before, only login shells had them, so a nested shell lost the prompt,
  the handler and, after `sudo -s`, PATH.

## Shims (fx, claude, opencode, node, bun, uv)

The kw layer's `/usr/lib/kw/bin/fx`, `claude`, `opencode`, `node`, `npm`,
`npx`, `bun`, `bunx`, `uv` and `uvx` link to `/usr/lib/kw/shim`, which installs the real program on
its first call and runs it (described at its top). Every distro has them, the page and
the CLI alike; `test/distro.test.ts` checks them on each image (no
network). On the page it takes the glibc arm64 files the page's mirror has
(claude, node, uv and the version lookups of opencode and uv) from
`http://mirror.unkernel.dev` first, where that name resolves to a routed
address (198.51.100.0/24: the page's own `fetch()`, web.md), and from the
upstream when the mirror fails; elsewhere from the upstreams only.

- PATH: `/usr/lib/kw/bin` comes last (kw-path.sh for every interactive
  shell, kwtty for programs it starts), and the install goes to `~/.local/bin`, which
  comes before the distro's, so later calls start the program directly and anything
  else of those names (a user's own install) wins. A shell that ran the
  shim keeps it hashed until `hash -r`, which costs one busybox `sh`
  start per call (the shim execs the installed program).
- The script runs the base's busybox `sh` (pipefail on any distro); its
  other commands are the distro's. Downloads use wget, else curl: Alpine's
  busybox wget, Debian's curl (the image has curl and ca-certificates).
  It fails with exit 127 and a message when there is neither, no network
  (no default route) or too little space.
- The first call installs the newest release, straight from the URLs the
  official installers use (fx.sh/setup.sh, claude.ai/install.sh,
  opencode.ai/v2/install; none of them is run): fx at `~/.local/bin/fx`,
  claude as `claude install` lays it out
  (`~/.local/share/claude/versions/VER`, symlinked from `~/.local/bin`),
  opencode in `~/.opencode/bin` (symlinked). `KW_FX_VERSION`,
  `KW_CLAUDE_VERSION` (also `stable`) and `KW_OPENCODE_VERSION` pin one.
  The musl builds on a musl distro (`/lib/ld-musl-*`), else the glibc
  ones. No published checksum is checked (each would come from the same
  host as the file, over the same verified TLS); gzip's CRC or zstd's
  frame checksum covers the stream, and the result must be an ELF
  program. claude comes as its `.zst` and needs zstd. The download
  streams into a temporary file next to the final one (no copy in /tmp),
  after a free-space check; one install at a time per tool (flock); a
  cut-off one leaves nothing.
- node, npm and npx install one thing: the Node.js release tarball,
  unpacked as `~/.local/share/node/vVER` with `bin/node`, `npm` and `npx`
  symlinked from `~/.local/bin` (so `npm install -g` writes into that
  tree, and its programs are not on PATH). The newest LTS from the
  release index, or `KW_NODE_VERSION` (`lts`, `latest`, a major version,
  or `X.Y.Z`). glibc
  distros get the official build (nodejs.org/dist, linux-arm64); Node.js
  publishes no musl build for arm64 there, so Alpine gets the one of
  unofficial-builds.nodejs.org (the project's own builder,
  linux-arm64-musl). The musl build links `libgcc_s.so.1`, the glibc one
  `libatomic.so.1`; when one is missing the shim installs its package
  first, as root (directly, or with `sudo -n`), with apk (`libgcc`) or
  apt-get (`libatomic1`); Debian's
  image has libatomic1 (DEBIAN_PACKAGES), Alpine's has no libgcc. The
  `.tar.gz` (63 MB for 26.13.1, against 33 MB `.tar.xz`), unpacked with
  pigz on Alpine; about 230 MB unpacked. Node CLI, 1 GiB, no data disk,
  2026-11-19, node 26.13.1: Alpine first call 18.3 s (libgcc and pigz
  included), then `npm --version` 4.9 s and `node -e 1` 1.8 s; Debian
  18.3 s, then 3.0 and 0.4 s (23.4 s when apt-get installs libatomic1
  first).
- bun and bunx install bun as bun.sh/install lays it out (`~/.bun/bin/bun`,
  symlinked from `~/.local/bin/bun` and `bunx`), but from the npm package
  `npm install -g bun` picks (`@oven/bun-linux-aarch64[-musl]`): the
  same program as the installer's
  GitHub zip, which busybox unzip cannot read from a pipe (its entries
  have data descriptors). The newest release, or `KW_BUN_VERSION`
  (`X.Y.Z`). The musl build links `libstdc++.so.6`, which the shim
  installs with apk first (`libstdc++`); the glibc one only glibc.
  About 50 MB download, 100 MB unpacked (1.4.5). Node CLI, Alpine, 1 GiB,
  no data disk, 2026-11-19, bun 1.4.5: first call 9.7 s (libstdc++ and
  pigz included), then `bun -e` 0.06 s.
- uv and uvx install uv's release tarball from releases.astral.sh (the
  first host of astral.sh/uv/install.sh, whose `APP_VERSION` names the
  newest release; `KW_UV_VERSION` pins one), the two programs straight
  into `~/.local/bin` as that installer puts them. The musl build on
  Alpine, the glibc one elsewhere; neither needs a library the images
  lack. No install receipt, so `uv self update` declines. The installer
  run in the guest itself works too and wins on PATH.
- On Alpine it installs zstd (for claude) and pigz (unpacking 3x faster;
  it works without) with apk when it can; Debian's image has zstd, and
  GNU gzip unpacks opencode. Downloads use libcrypto's own choice of code
  (AT_HWCAP: AES, PMULL, NEON), which kwemu's JIT translates; forcing its
  C code (`OPENSSL_armcap=0`) made a 50 MB TLS 1.3 download over the host
  loopback no faster (AES-128-GCM 10.5-13.1 s against 9.2-11.6 s,
  ChaCha20-Poly1305 9.4-9.9 against 9.6-10.7; the network path and the
  pipeline dominate) and costs AES 4x in `openssl speed`.
- Earlier pages wrote shims into `~/.local/bin` (`# kw-shim N` on line
  2), which the data disk keeps on Alpine. They still work, come first on
  PATH, and are replaced by the program they install; the kw layer's
  shim installs over one.
- Sizes and times on Alpine (Node CLI and SDK, 512 MiB, data disk,
  2026-11-18): fx 4.5 MB download, 6.9 MB, first call 2.5 s, later ones
  0.01 s; claude 2.1.327 127 MB (`.zst`), 357 MB, 23 s, then `--version`
  0.2 s, `--help` 6 s; opencode 2.3.2 120 MB, 248 MB, 22 s, then
  `--version` 6 s (its own startup); rechecked the same day on a fresh
  data disk (fx 0.0.17, claude 2.1.327, opencode 2.3.2): first calls 2.2,
  16.9 and 20.9 s, then 0.0, 0.1 and 4.3 s. All three also run at 256 MiB.
  On Debian (Node CLI, 2026-11-19): fx 0.0.17 installs and runs; claude
  2.1.328 (glibc build) at 1 GiB without a data disk, first call 18.8 s,
  then `--version` 0.13 s. Without a data disk the root is in RAM (230 MiB
  free at 512 MiB): fx installs, claude and opencode refuse with a
  message; at 1 GiB claude fits.
- claude's own auto-updater is left on: it may download a newer version
  into `~/.local/share/claude/versions` in the background and keep the old
  one until it cleans up, so up to twice its size on the data disk.
- The guest downloads everything itself (TLS in the guest; on the page
  through Wisp). The page could not fetch for it: downloads.claude.ai
  sends no CORS headers and is https only; registry.npmjs.org and
  releases.fx.sh send `Access-Control-Allow-Origin: *`, but the guest's TLS
  is not the bottleneck any more (claude's `.zst` in 11 s and opencode's
  tarball in 4 s through the default Wisp server from a server host,
  2026-11-18).

## Distro images (`kernel/build.sh distro`, `guest/distro/`)

`guest/build.sh distro [NAME...]` writes `vendor/build/distro/NAME.erofs`
and `NAME.ext4` (`KW_DISTRO_OUT` elsewhere, `KW_DISTRO_FORMATS` picks),
`NAME.id` (the image id) and then the index `distros.json` (guest/README.md),
which a release publishes with the `.erofs` images for `fetchDistro()`
(js.md).
Both formats come from one tar stream (`guest/tools/mktree.py`) with the
upstream tarball's owners, modes and hard links and fixed times, so no
step needs root and a rebuild is byte-identical. `guest/lib/image.sh` has
the erofs choices (zstd level 15, 128 KiB clusters with fragments; not
lz4, not ztailpacking with fragments) and the ext4 one (`mke2fs -d`, then
debugfs from the stream). Each image has label `kwroot`,
`/usr/lib/kw-distro` (its name) and `/usr/lib/kw-image`
(`NAME-VERSION-<hash of the tree>`), and an init that calls into the kw
layer: boot to a prompt 0.25 s (Alpine) and 0.32 s (Debian) from
`createKernel()` (Node, 2026-11-19).

- **Alpine** (`distro/alpine/`): the minirootfs as Alpine builds it
  (stock busybox, zlib, openssl and apk-tools), busybox init with `etc/inittab` (the layer's rc,
  welcome and net, `/etc/kw-binfmt.sh` for qemu-user, `kwtty login` on hvc0,
  `kwtty serve`, the layer's shutdown), and what "In the Alpine image"
  below lists. OpenSSL's engines, `legacy.so` and `*.dist` stay (the image
  is paged in on demand, not RAM-resident). An `apk add` cut off
  mid-install needs no cleanup (data-disk.md). The build adds doas and
  doas-sudo-shim (pinned in `pins.sh`, from main: 21 KB to download
  against 0.75 MB for the real sudo, which is in community), installed by
  the image's apk in a boot of the tree on the base bundle
  (`guest/tools/vm-run.ts`; the changes to the overlay's upper layer are
  copied back into the tree, and `/etc/apk/world` keeps plain names);
  without the bundle or node the image has no doas and no user. What else
  a program needs comes from apk on first use (the shim's libgcc, above).
- **Debian** (`distro/debian/`): debian:trixie-slim (pinned in
  `pins.sh`), Debian's own builds in full. `/sbin/init` ->
  `/usr/local/sbin/kw-init`, a bash PID 1: the layer's rc, welcome and
  net, the console's login shell on hvc0 (`kwtty login`) and `kwtty
  serve` (respawned); `poweroff`/`halt`/`reboot` in `/usr/local/sbin`
  signal it (through `sudo -n` for the user), and it stops
  everything, runs the layer's shutdown and calls reboot(2) through the
  base's busybox. Services are Debian's init scripts under sysv-rc (with
  insserv and startpar, in `DEBIAN_PACKAGES`): kw-init runs runlevel 2
  once DHCP is done (`net wait`) and 0 or 6 before it stops everything, only when that rc
  directory has links to run; runlevel S (rcS.d) never runs, the layer's
  rc does early boot. `/usr/sbin/runlevel` prints what kw-init writes to
  `/run/kw-runlevel` (`N 2`), so that a package's invoke-rc.d starts its
  service on install (`apt-get install cron`: running, and started at
  every boot with a data disk). sudo's script is disabled (it only resets
  `/run/sudo`). The base's init execs `/usr/local/sbin/kw-init` itself
  where the image has it, not `/sbin/init`, and
  `/etc/apt/preferences.d/kw-init` pins `systemd-sysv` away: desktop
  packages (chromium, GTK apps) reach it through dbus-user-session and
  libpam-systemd, it would replace `/sbin/init` and have apt remove
  sysv-rc, and systemd as PID 1 does not come up here (it waits for
  `dev-hvc0.device`); without it apt takes dbus-x11, and systemd itself
  (not as init) installs fine. On a disk where it already happened the
  boot is kw-init's again, without services (no `/etc/init.d/rc`) until
  `apt-get install sysv-rc`. apt: `90kw` (no recommends, pdiffs or pty), debconf
  Noninteractive, the package lists of the image's date baked in
  (`DEBIAN_LISTS`, compressed by `tools/apt-lz4` as apt does) and apt's
  source cache made by the image's own apt at build time
  (`guest/tools/vm-run.ts` on the base bundle), so `apt-get install`
  works with no `apt-get update` first. The image's `policy-rc.d`
  (docker's `exit 101`) is removed after the build's own install.
  wland's relay `/usr/lib/kw/wlandr` (the kw layer, above) is in this
  image only; the page's boot (`kw.wayland=1`) reads it, and the build's
  traced boots boot as the page does (`KW_TRACE_BOOT` in
  `guest/lib/image.sh`), so it is in the boot set.
  `/usr/lib/kw/xwayland-satellite` (pins.sh `XWS_*`: Fedora 43's
  aarch64 build, newest glibc symbol 2.34, taken out of the RPM by
  `tools/rpmfile.py`) is for the relay's X display; Xwayland is not in
  the image (215 MiB installed with Mesa).
  `DEBIAN_PACKAGES` in build.sh (curl, ca-certificates, unzip, dbus-daemon
  for session buses, which starts nothing at boot: kw-init makes its
  machine id, which the image leaves out, once per machine;
  libxcb-cursor0 and libfontconfig1 for satellite) are
  installed at build time by the image's apt in the same build VM, from
  .debs the host fetches from snapshot.debian.org (checked against the
  baked lists); the install's changes to the overlay's upper layer are
  copied back into the tree.
  Command not found installs as on Alpine (below), with bash's
  `command_not_found_handle` (`/etc/profile.d/kw-apt.sh`, which gets the
  arguments too; `KW_AUTO_APT=0` turns it off) and
  `/usr/local/sbin/kw-apt-install`, which looks the name up in
  `/usr/lib/kw-commands` (`NAME PACKAGE` per command of main, made at
  build time from the snapshot's Contents files by `tools/commands.py`)
  and runs `apt-get install --no-install-recommends` (as the user through
  `sudo -n`). kw-apt.sh also makes `apt` and `apt-get` typed by a user
  other than root, where sudo exists, `sudo apt ...` (aliases, interactive
  shells only: `\apt` and `command apt` are the real one, `sudo apt` stays
  as typed, scripts are untouched); kw-apk.sh does the same for `apk`
  where `/lib/apk/db` is not writable. `/usr/lib/kw-commands` leaves out every command the image
  has, `/usr/local` included (else `poweroff` would map to finit-sysv).
  The user's `~/.bashrc` (from `/etc/skel`, whose two prompt lines the
  build makes no-ops) leaves the prompt to kw-prompt.sh; the build adds
  the group input (gid 101), which udev's package would.
- **Foreign binaries (Debian)**: x86_64 and i386 run through box64;
  kw-init registers both ELF types with the interpreter
  `/usr/local/libexec/kw-binfmt`, which installs box64 and the
  architecture's libc6, libgcc-s1 and libstdc++6 on first use (x64.md).
- **Docker (Debian)**: `/usr/local/bin/docker` (ahead of `/usr/bin` on
  PATH, run for every call, described at its top) installs docker.io,
  docker-cli (a Recommends in trixie) and crun on first use (apt-get,
  through `sudo -n`; exit 127 offline), adds the user to the group docker
  (until the next login it runs the CLI through `sudo -n -E -u USER`),
  starts the service when dockerd is not running and waits for its
  socket; sysv-rc starts it at every boot after that. It writes
  `/etc/docker/daemon.json` (when missing) for what the kernel lacks:
  iptables, ip6tables and the default bridge off (no netfilter, no
  bridge), cgroupns host (no CGROUP_NS), and the data root outside the
  root's overlay, on which overlay2 cannot put its upper layers:
  `/data/distros/debian/docker` with a data disk (a `kw-overlay discard`
  keeps it), else a tmpfs on `/var/lib/docker`. The runtime is
  `/usr/local/libexec/kw-docker-runtime`: crun after two edits of the
  bundle's config.json, one rule allowing every device (the device
  cgroup is a BPF program, there is no bpf(2), and crun goes on without
  it when no rule denies; runc adds rules of its own and fails) and no
  empty `blockIO` (crun then wants the io controller; cgroup2 has only
  pids). So containers can open any device node they make, and Docker
  drops `--memory` with a warning. The default network would be an
  empty namespace, so the shim adds `--network host` to run, create and
  build unless the arguments name a network; `-p` is ignored, a
  container's ports are the guest's. `docker build` is the legacy builder
  (no buildx); no compose. Node CLI, 1 GiB, data disk, 2026-11-19, Docker
  26.1.5: first `docker run --rm alpine` 58 s (45 MB of packages, the
  pull), then 1-3 s; debian:trixie-slim pulled and run 21 s; a build with
  `apk add` 5 s; dockerd and containerd about 130 MB RSS.

## Data disk template (`kernel/build.sh datadisk`)

`vendor/build/disk/kwdata.kwsparse.gz`: an empty ext4 labelled `kwdata`, 4
GiB, made with `mke2fs -t ext4 -b 4096 -L kwdata -m 0 -J size=8 -E
lazy_itable_init=0,lazy_journal_init=0,root_owner=0:0,orphan_file_size=32K`
and common ext4 host defaults (pinned in a generated `mke2fs.conf`),
checked with `e2fsck -fn`, then encoded by
`tools/kwsparse.mjs` (554 non-zero blocks, 17 KiB gzipped). The orphan
file is 8 blocks instead of 256, because the kernel reads it one block at
a time at every mount; give `orphan_file_size` a unit (a bare number is
blocks). Reproducible: fixed `-U` and `hash_seed`, and
`E2FSPROGS_FAKE_TIME`/`SOURCE_DATE_EPOCH`. `all` runs it before the
bundle and goes on with a warning without mke2fs.

## In the Alpine image

The files are in `guest/distro/alpine/rootfs/`.

- **Network setup**: the kw layer's net (above). The guest clock is host
  wall time, so TLS works.
- **apk repositories**: apk starts with `main` only, because every apk
  command that loads the indexes parses all enabled ones (~0.65 s for main,
  ~2.7 s with community, 2026-11-15). The community line is in
  `/etc/kw-apk-lazy`, and `/etc/kw-apk-enable` appends it to
  `/etc/apk/repositories` when something needs it, for good (packages
  installed with `apk add -X URL` would not be upgraded later). The page
  pushes index files into apk's cache (web.md, apk index prefetch).
- **Command not found**: in an interactive shell with a default
  route, a missing command is installed with `apk add cmd:NAME` and run
  (as root: kw-apk-install runs itself again through `sudo -n` for the
  user)
  (`/etc/profile.d/kw-apk.sh`, a busybox ash `command_not_found_handle`,
  and `/etc/kw-apk-install`). ash passes only the command name, so the
  arguments come from the history line, and only for a simple line (after
  `htop; ls` it asks to run the command again); `$?` is 127 either way.
  `KW_AUTO_APK=0` turns it off. kw-apk-install looks the command up in a
  list of the `cmd:` names each cached index provides
  (`/var/cache/kw-apk/*.cmds`, rebuilt when the index changes: ~1.2 s for
  main, ~3.1 s for community; a lookup ~0.1 s). A command in none of the
  enabled repositories is looked up in the lazy ones: their index is
  fetched with wget to the name apk uses for its cache
  (`APKINDEX.<8 hex digits of sha1(index URL)>.tar.gz`, unless the page has
  pushed it), and on a hit the repository is enabled and apk reuses that
  file.
- **`~/.local/bin` ahead of the distro's on PATH** (`/etc/profile.d/kw-path.sh`, from the
  kw layer): Alpine's
  `/etc/profile` sets a fixed PATH; this prepends `/run/kw/bin` (the
  host's commands, kwcmd) and `$HOME/.local/bin` and
  appends `/usr/lib/kw/bin` (the shims) for every interactive shell, and
  kwtty gives programs it starts directly the same PATH. Per-user installs
  go there (`pip install --user`, the fx and claude installers, the
  shims).
- **curl shim** (`/usr/local/bin/curl`) over busybox
  wget, because the real curl costs about 2.4 MB of download and 5 MB of
  RAM. It handles only GET requests with `-L` whose result it can
  reproduce exactly (`curl -fsSL URL | sh`, `curl -fLo FILE URL`; options
  `-f -s -S -L -k -g -o -O -H -A -e -m`). Anything else (other options, a
  body, no `-L`, credentials, an HTTP error without `-f`, a TLS failure)
  runs the real curl, installed on first use by `/etc/kw-apk-install
  curl`; after that the shim execs `/usr/bin/curl`. Output is written only
  after a complete transfer, so `curl | sh` does not stream.
- **Foreign binaries**: x86_64, riscv64, i386 (i486-i686) and arm
  (armv5-armv7, little-endian; the kernel has no AArch32) run through
  qemu-user. The inittab runs `/etc/kw-binfmt.sh`, which registers the
  four ELF types (flag P, `CONFIG_BINFMT_MISC`) with the interpreter
  `/etc/kw-qemu`. WASI `.wasm` programs go to `/usr/lib/kw/kwwasi`, which
  runs them on the host's wasm engine (js.md, WASI programs); the kw
  layer's rc registers it. **Guest only: never run kw-binfmt.sh on the
  host.**
  The first time an architecture is needed (as root, through `sudo -n` for
  the user (`kw-qemu --kw-install`), with a network, under
  a lock so parallel execs do not race apk) kw-qemu enables community and
  installs `qemu-ARCH` and a library root at qemu's default prefix
  `/usr/gnemul/qemu-ARCH`: musl, libgcc, libstdc++ and gcompat (glibc's
  loader names and sonames on musl), about 4 MB, verified with that
  architecture's keys from `alpine-keys`. More: `apk add --root
  /usr/gnemul/qemu-ARCH --arch APKARCH --keys-dir
  /usr/share/apk/keys/APKARCH PKG` (APKARCH `x86` for i386, `armv7` for
  arm). Expect several times slower than native aarch64: qemu's TCG output
  is new code to kwemu.
- **`kw-arch ARCH [command...]`** runs a command (default a shell) with
  `uname` and `arch` reporting x86_64, riscv64, i686 or armv7l, for
  installers that pick their download by `uname -m` (`curl -fsSL
  https://opencode.ai/install | kw-arch x86_64 bash`). Only the commands
  are faked (shims in `/usr/lib/kw-arch`, first on PATH), not `uname()`.
- **X.Org on the framebuffer**: no udev, so `/etc/X11/xorg.conf.d/10-kw-fb.conf`
  and `20-kw-input.conf` (the kw layer) name the fbdev
  driver and the evdev keyboard, mouse and tablet; `apk add xorg-server
  xf86-video-fbdev xf86-input-evdev` and `X :0` use them.
  `/etc/X11/kw-kms.conf`, not read by default, names the modesetting
  driver with glamor on `/dev/dri/card0` instead (gl.md, The DRM path):
  `Xorg :0 -config kw-kms.conf`.
- **Data disk**: the base mounts a `kwdata` disk at `/data` and keeps the
  root's changes in `/data/distros/alpine/` (data-disk.md).
- **Known upstream crash, not ours**: `time nosuchcmd` prints status 127
  and then segfaults at address 0 (exit 139; checked 2026-11-19, busybox
  1.37.0-r31, musl 1.2.6-r3). busybox `time`'s vfork child calls `exit()`
  when exec fails. musl's `exit()` stores the caller's tid in a static
  `exit_lock` to catch re-entry, and the child shares the parent's memory
  and thread pointer. When the parent then calls `exit()` it finds its
  own tid there and hits `a_crash()` (`strb wzr, [x0]` at
  `ld-musl-aarch64.so.1` `exit+0x78`). The fix belongs in busybox (the
  child should call `_exit`). If a vfork child crashes or exits oddly,
  rule this out before suspecting `CLONE_VM` in kwemu or arch/wasm.
  `qemu-aarch64` does not reproduce it, because qemu-user runs vfork as a
  plain fork.

## Guest tools (`guest/src/*.c`)

Built static by `guest/base/build.sh` with `zig cc -target
aarch64-linux-musl -mcpu=generic` (ARMv8.0) into the kw layer; the test
programs (`guest/src/test/`) into the second archive. New code must stay
within what kwemu implements: check it with the coverage classifier
(a64/isa.md).

The layer's tools and vtest-bridge are one program, `/usr/bin/kwbox`
(`kwbox.c`), with one copy of libc: each source is compiled as an object
of its own with its `main` renamed (`-Dmain=kwtty_main`, so each still
builds alone, as `test/wasi-binfmt.ts` and `gl/bridge/build-guest.sh` do).
136 KB against 348 KB as seven programs (vtest-bridge adds 12 KB to it, 67
KB alone; 2026-11-22). Callers name it: `kwbox TOOL ARGS` with TOOL `tty`,
`9p`, `vsock`, `shm`, `wasi`, `cmd` or `vtest` (the GL forwarder, which
serves Mesa's vtest socket; `gl` would also name virtio-gpu's path, which
has no forwarder), or `growfs DEV DIR` (in `kwbox.c`: grows the ext4 on
DEV mounted at DIR to DEV's size; the base's `/init` runs it on `/data`). The tool runs with argv[0] and the process name (comm)
its program's own (`kwtty`, `kw9p`, ..., `vtest-bridge`): ps shows
`{kwtty} /usr/bin/kwbox tty serve`, busybox `pidof kwtty` finds it
(Debian's procps `pidof` matches argv[0], so there only `pidof kwbox`),
and the tools' messages keep their names. Under any other name kwbox is the
host command of that name (kwcmd, below), so a host command may be named
like a tool, but not `kwbox` or `kwcmd`. binfmt_misc cannot pass a TOOL,
so `/usr/lib/kw/kwwasi` links to it and kwbox runs kwwasi for that exact
argv[0], the path the layer's rc registers. The old paths
(`/usr/bin/kwtty`, `kw9p`, ...) are gone: an image from before kwbox,
whose init runs `/usr/bin/kwtty login|serve`, gets no console shell and no
`kwtty serve` on this base, and neither does an image whose inittab or
kw-init the user changed before kwbox, which the data disk's upper layer
keeps (no image update rewrites it, data-disk.md). The base's `/init`
tells both apart from a boot to nothing: an init that runs `/usr/bin/kwtty`
fails its check of the merged root, so a changed one in the upper layer
gives safe mode (the image's own init on a tmpfs upper, with `kw-overlay
status` and `discard`, or a fix in the upper from there), and the image's
own gives the base shell, saying why. The SDK has no fallback to the old
names: on a base from before kwbox, mounts, host commands and GL fail
saying the guest has no `/usr/bin/kwbox`. `kwbox TOOL` costs nothing per exec against a
standalone tool given one more argument (0.39 ms each for a usage error;
base shell, Node, 2026-11-22).

- `kwbox vsock connect PORT [CID]` and `kwbox vsock listen PORT` pipe stdin and
  stdout over a vsock connection.
- `kwbox tty login` (the distros' inits, on hvc0): the console's login shell,
  as the user `kw.user=NAME` on the kernel command line names (the CLI's
  `--user`), else the default user (below), with the terminal given to it,
  its groups, environment and home.
- `kwbox tty serve [PORT]` (from inittab) serves sessions to the host on vsock
  port 1022 (privileged, so no unprivileged program can take it; only CID
  2 may connect, since there is no authentication). Each connection gets
  its own pty, size and resizes, and a user's login shell or the program
  the host names (argv, working directory, environment), and a hangup when
  the host closes. The user is OPEN's USER (a name or uid; empty: the
  default user, `user` where `/etc/passwd` has it, else root; no USER:
  root, as a host from before it expects); the program gets its groups
  (initgroups), the pty (owner, group tty, 0620, as login(1) does), and
  its home as the working directory. The environment starts with HOME,
  USER, LOGNAME, SHELL, TERM
  (on a pty, or when the host sets it) and a login shell's PATH. With PIPES
  the program gets stdin, stdout and stderr pipes instead, in a session of
  its own (a hangup goes to its process group), and EOF closes its stdin.
  With CONNECT there is no program: kwtty connects to a TCP port on
  127.0.0.1 and relays bytes, passing half-closes on (`vm.connect()`,
  `vm.fetch()`, the CLI's `--forward`). A session opened with DETACH (on
  a pty) survives a snapshot restore: the restore's reset of its
  connection (ECONNRESET as the socket error, which only kwvsock's restore
  notifier sets) detaches it instead of hanging it up; the program runs on,
  kwtty keeps reading the pty into a 64 KiB ring, and a connection with
  ATTACH and the session's id takes it over (REPLAY: the ring from where a
  fresh terminal can start, behind the modes in force there; a program on
  the alternate screen gets two SIGWINCHs to redraw). The handover goes
  over the session's abstract unix socket `\0kwtty/<id>` (SCM_RIGHTS, root
  peers only). Hung up when nobody attaches within its timeout (60 s by
  default), and on the host's own close as any session. The protocol is described at the
  top of `kwtty.c` and `js/core/tty.ts` (js.md). `socket(AF_VSOCK)` works
  without a transport, so kwtty asks `/dev/vsock` for the local CID
  (`IOCTL_VM_SOCKETS_GET_LOCAL_CID`) and, without a device, sleeps in
  `pause()` instead of exiting, so init does not respawn it every second.
- `kwbox 9p NAME DIR [ro]` mounts a host file system (devices.md, 9p); the SDK
  runs it through kwtty.
- `kwcmd` runs a command the host provides (`createKernel({ commands })`,
  `js/core/commands.ts`; the protocol is at the top of `kwcmd.c` and
  there): through a link `/run/kw/bin/NAME -> /usr/bin/kwbox`, or `kwbox
  cmd run NAME`, it connects to vsock port 1020 and is that command's
  process. `kwbox cmd sync NAME...` makes the links; the SDK runs it
  through kwtty.
- `kwbox shm memfd SIZE [SEED]` and `kwbox shm export FILE` export a patterned
  memfd or a file and print its id.
- `kwbox vtest bridge --link vsock:2:1019 --daemon`: the guest
  GL forwarder, `gl/bridge/vtest-bridge.c` built stream-only
  (`-DVTEST_BRIDGE_STREAM_ONLY`, in kwbox; gl.md, gl/bridge/README.md): Mesa's
  vtest socket `/tmp/.virgl_test` (mode 0666, made once the host's renderer
  is ready) to the host's renderer on vsock port 1019, reconnecting every
  second. `--daemon` returns once it holds its lock (an abstract socket
  named after the vtest socket), so a second start exits 0. The SDK's `gl`
  option runs it through kwtty as root.
- `glimmer` is a small game for the display, keyboard and mouse at any
  size, with synthesised sound effects when there is a sound card (22050 Hz
  stereo through the raw ALSA ioctls, about 46 ms queued; M or Tab mutes,
  `--no-sound`). `glimmer --test` draws a fixed pattern, plays 1 s each of
  440 Hz on both channels, 660 Hz left and 880 Hz right, and prints every
  input event; `node test/glimmer-check.mjs --run` checks all three from
  the host (`--no-sound`: without a sound card).
