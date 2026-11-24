# Testing

The browser tests (`web/test/`, see web.md) are run only when asked; the
page is tested by hand with `pnpm dev`.

CLI exit codes: 0 = power off, 1 = halt or boot failure, 2 = restart,
124 = `--timeout`, 253 = panic, 254 = wasm trap, 255 = fatal.

## Quick checks

Run the row for what you changed, and no more.

| Change | Quick check |
| --- | --- |
| Emulator (`src/`, `test/guest/`, `include/`) | `zig build test` |
| Kernel, `kw_emu.h`, JIT | `kernel/build.sh kernel`; `node js/cli.ts --append "console=hvc0 rdinit=/usr/bin/kwtest"` (`kwtest: 0 failure(s)`, exit 0); for JIT changes, again with `--no-jit` |
| JIT control flow, regions, budget or polls | the row above; `zig build test -Dkwemu-a64-fuzz=20000` (the A64 block fuzz; a64/jit.md) |
| Base initramfs, kw layer, distro images (`guest/`) | `KW_BASE_OUT=/tmp/b kernel/build.sh base`, `KW_BASE_OUT=/tmp/b KW_DISTRO_OUT=/tmp/d guest/build.sh distro`, then `UNKERNEL_TEST_BASE_KERNEL=/tmp/b/unkernel.wasm UNKERNEL_TEST_DISTRO_DIR=/tmp/d pnpm test:distro` and `UNKERNEL_TEST_KERNEL=/tmp/b/unkernel.wasm UNKERNEL_TEST_DISTRO_DIR=/tmp/d pnpm test:api` (or the same in place: `kernel/build.sh base`, `kernel/build.sh distro`, `pnpm test:distro`, `pnpm test:api`); `UNKERNEL_TEST_DISTRO_FORMAT=ext4` for the ext4 images; optional: `node js/cli.ts --timeout 120 --input '{8}uname -a; apk --version\n{2}poweroff\n'` |
| distros.json, `fetchDistro()` (`guest/tools/distros-json.mjs`, `js/node/distro-fetch.ts`) | `guest/build.sh index` (with the same `KW_BASE_OUT`/`KW_DISTRO_OUT` as the build); `pnpm build`, then the downloader against a local copy of the release (below, SDK row) |
| Display, input, sound (kwfb, kwinput, kwsnd) | `pnpm test:api`; optional: `node test/glimmer-check.mjs --run` |
| kwvirtio, virtio-gpu (`js/core/virtio*.ts`) | the kernel row; `node test/gpu/check.mjs` (a dumb-buffer KMS client against the host's frame, a refused and a restored snapshot, display size changes heard by `test/gpu/kms-hotplug.c` inline and in worker mode), `node test/gpu/flip-check.mjs BUNDLE 120 30` (page flips and DIRTYFB at 60 Hz, the idle tail); for SMP paths `--cpus 2 --pin 1`; 3D (`js/core/gl-gpu.ts`, `kw_vgpu_*`): `node test/gl/unkernel-check.mjs --drm` (headless Chromium; gl.md, Testing) |
| Block, ext4, data disk | `pnpm test:block` |
| SDK (`js/`) | `pnpm typecheck`; `pnpm test:api` |
| Host file systems (9p, `kw9p`) | `pnpm test:9p`; `pnpm test:api` (after a kw9p change, `kernel/build.sh base` first) |
| Inbound to the guest (`vm.connect`, `vm.fetch`, `websocketOver`, kwtty CONNECT, `--forward`), kwtty's detachable sessions (`vm.attach`) | `pnpm test:http`; `pnpm test:ws`; `pnpm test:tty`; `pnpm test:api` (after a kwtty change, `kernel/build.sh base` first) |
| Network | `pnpm test:net`; `pnpm test:net-port` |
| SMP code (`CONFIG_SMP` paths, per-CPU data, IPIs, CPU parking, `js/core/cpu.ts`; kernel/smp.md) | `kernel/build.sh smp` (after `kernel`, so that the bundle carries the patch); kwtest with `--cpus 2` (the SMP kernel from the bundle) and once with `--kernel vendor/build/kernel-smp/vmlinux32.wasm --initrd base-test` (one CPU); `zig build test -Dkwemu-atomics=true` after a kwemu change |
| Bundle and kernel patch (`bundle.mjs`, `kwdiff.mjs`, `kpatch.ts`, `kremap.ts`) | `KPATCH_UP=vendor/build/kernel/vmlinux32.wasm KPATCH_SMP=vendor/build/kernel-smp/vmlinux32.wasm pnpm test:kpatch` |
| Page (`web/`) | `pnpm typecheck:web`; `node --test web/test/open.test.ts`; `pnpm build:web` |
| Wayland desktop (`web/src/wayland.ts`, `web/src/wayland/`, `WaylandOutput.tsx`, the foot app, the kw layer's `wland`, the Debian image's `wlandr`) | `node test/wland/page-check.mjs` (the dev server on port 8092, headless Chromium, worker mode then inline, about 30 s; the relay started at boot idle and nothing of wland fetched, a plain `foot` from a login shell and a second one on the same link, the launcher's foot tile, a killed relay replaced; makes the prepared disk `vendor/build/wland/debian-wland.img` and its `.kwsparse.gz` once with `test/wland/debian-disk.mjs`, which needs the internet; delete both after a new Debian image or a change to its package list); `--cpus 0` for the page's default CPU count, `--only worker\|inline`; longer cases in the first mode: `--apps` (two windows, the window manager, the page resized, foot's resize border, the clipboard and wland's bridge to the page's), `--gtk` (l3afpad and where its menu opens), `--keys` (foot's keys, the page's shortcuts and focus), `--pacing` (commits per second of busy clients, every mode), `--all` (those four); `--gpu` (GL apps by GPU resource: guest GL's virtio-gpu, wland's linux-dmabuf, weston-simple-egl's pixels, a stale-frame check, foot beside a GL window, gtk4-widget-factory, a relay without `--dmabuf`, an on-demand relay that finds its render node at the dial, Suspend with a GL app, then `?wlgpu=0` and `?gpu=0`; about 3 min with `--only worker`; imports `vendor/build/wland/debian-wland-gl.img.kwsparse.gz`, made once by `debian-disk.mjs --gl`; with `--pacing` frame rates by resource and in software); `--chromium` (instead of the other cases, in each mode: Debian's `chromium` started plainly maps a window, from a login shell and with no Wayland variables (the hook `/etc/chromium.d/kw-wayland` then runs `wland`), and renders on the GPU: its window by GPU resource, no shm reads, its GPU process kept; imports `vendor/build/wland/debian-wland-chromium.img.kwsparse.gz`, 260 MiB, made once by `debian-disk.mjs --chromium`: chromium as `apt-get install chromium` takes it, recommends included, and Mesa's EGL (`libegl1 libegl-mesa0`, with `libgles2 libgbm1 mesa-utils`), about 3 min; delete both files to make them again; the run about 2 min); `--firefox` (instead of the other cases, worker mode on 4 CPUs with `mem=2048` unless `--only` or `--cpus` say otherwise: firefox-esr from a login shell maps its window on a local page whose title shows what reached it, then two clicks, typing, the context menu opened and closed with Escape, the wheel, a drag selection (`wl-paste -p`) and Ctrl+C (`wl-paste`), a link and a typed URL; needs a wland that sends seat events to every pointer and keyboard of a client (0.1.0-261122-632f589 or later); imports `vendor/build/wland/debian-wland-firefox.img.kwsparse.gz`, 218 MiB, made once by `debian-disk.mjs --firefox`: the GL disk's packages and firefox-esr, about 3 min; the run about 3 min); `--suspend` (Suspend and resume with foot open: the relay goes idle, a plain foot maps; and a session saved with `?shm=0`: no `kw.wayland=1`, no relay), `--fresh` (no prepared disk: the tile's apt path, needs the internet), `--built` (web/.output; also when another dev server runs on the same `web/`: two at once disturbed each other's dep optimizer, pages failed to load, 2026-11-22), `--output DIR` (another build's output, e.g. `web/.wland-local/output`: the page built against a local wland package, web.md, Wayland desktop), `--shots DIR`, `--keep-open` (prints the DevTools port), `--verbose` (the server's and Chromium's output). Chromium runs with `--disable-dev-shm-usage`: in a container whose `/dev/shm` is small (64 MiB here, 25 MiB of it another session's) the GL page crashed its renderer and then got `net::ERR_INSUFFICIENT_RESOURCES` for its scripts (2026-11-22) |
| Guest GL (`gl/`, `js/core/gl*.ts`, the forwarder; gl.md, Testing) | `node gl/wasm/test/check.mjs` (the module); `test/gl/stream-check.sh info state` (the stream link); `node test/gl/unkernel-check.mjs` (unkernel in headless Chromium; makes the prepared disk once); the DRM path and the renderer loaded on first use: `node test/gl/unkernel-check.mjs --drm --skip c` (`--eager`, `--fail`: gl.md, Testing; step h: integer vertex attributes and colour buffers, `test/gpu/int-attrib.c`; step m: multisampling, `test/gpu/msaa.c`; `--lose`: glmark2-es2-drm twice, then the WebGL2 context lost four ways, restored or not, and new GL programs after each; `pnpm test:gl-gpu` without a browser); the page's GL option (`web/`, `kw-gl.sh`): `node test/gl/page-check.mjs` (the dev server on port 8091 with the default URL, where GL is on, Mesa from apt over the page's network: needs the internet; `--no-apt` without; `--suspend` adds the session checks; with the device it resizes the page and checks the guest's DRM mode, `--no-resize` skips that; `--inline` for `?worker=0`; `--server URL` reads the page from a server that runs instead of starting one) |

The optional checks boot the same bundle as `pnpm test:api`, which already
runs shell commands and `glimmer --test` inline and in worker mode (most of
its tests on the base shell; the "Alpine" suite and the glimmer tests on
the Alpine image). Run them when the change touches what only they cover. The Alpine
boot adds `apk` and the CLI's `--input`. `glimmer-check` compares the whole frame pixel for
pixel and the sound sample for sample, and checks the mouse and tablet
events and the CLI's `--display`, `--sound-wav` and `--worker`.

To add a test: for the emulator, a unit test in `src/a64/tests.zig` or a
guest in `test/guest/a64/` plus entries in `build.zig` (`a64_guests`) and
`test/a64-test.mjs`; for the kernel, a `CHECK(...)` in
`guest/src/test/kwtest.c`. A separate static guest program goes into
`guest/src/`, the `tools` list of `guest/base/build.sh` and the table
in `guest/src/kwbox.c` (the layer's tools are one program), or into
`guest/src/test/` and the `kwtest kwbench` loop if it is only for tests (those, and abitest, stay out of release bundles; base-test.cpio
always has them).

## Full matrix

Only before a release, or when asked. A row applies when the release
contains changes to that area.

| Area | Run |
| --- | --- |
| Emulator (`src/`, `test/guest/`, `include/`) | `zig build test` (it also reruns the wasm64 unit tests and the guests on a JIT host without wasm SIMD, `a64-nosimd` and `wasm64+jit/nosimd`) and `zig build test -Dkwemu-atomics=true`, then the kernel row |
| Kernel or `kw_emu.h` | `kernel/build.sh kernel` and `kernel/build.sh smp`; `node js/cli.ts --append "console=hvc0 rdinit=/usr/bin/kwtest"`, the same with `--kernel vendor/build/kernel/vmlinux`, and both again with `--no-jit` (expect `kwtest: 0 failure(s)`, exit 0); kwtest once more with `kw.isa=armv8` appended (the `isa` checks then expect SIGILL) and once with `--no-vsock`; abitest the same way (`rdinit=/usr/bin/abitest`, `abitest: 0 failure(s)`, exit 0; kernel/tests.md) with and without the JIT and with `--cpus 2`; the SMP kernel (below); `node test/wasi-node.ts` (`PASS`) |
| Bundle, kernel patch, `build.sh` | `KPATCH_UP=vendor/build/kernel/vmlinux32.wasm KPATCH_SMP=vendor/build/kernel-smp/vmlinux32.wasm pnpm test:kpatch`; after a change to the stamps or the build, two clean builds into different `KW_BUILD` roots give the same `vmlinux32.wasm` files and bundle (`sha256sum`) |
| JIT (`src/emu/jitcore.zig`, `src/a64/jit/`, `js/core/jit.ts`) | the two rows above; `zig build test -Dkwemu-a64-fuzz=20000` (the A64 block fuzz, natively and on the JIT with and without SIMD; `-Dkwemu-a64-fuzz-seed=S` for other programs; a64/jit.md); Alpine with real work under JIT, `--no-jit` and a host without wasm SIMD, comparing outputs (`seq 30000 \| sort -rn \| md5sum`, `tar cf - /lib \| gzip \| md5sum` (with `--exclude=lib/apk` after an `apk add`: apk's database holds install times), `sha256sum`, awk FP output, and with `apk add openssl` digests and ciphers against the host's `openssl`); `node --expose-gc --test test/api.test.ts`. A host without SIMD: preload a module that makes `WebAssembly.validate` refuse `jitSimd()`'s 31-byte probe (js/core/jit.ts), `node --import file:///PATH/nosimd.mjs js/cli.ts ...` |
| Anything a real userland sees | `node js/cli.ts --timeout 120 --input '{8}uname -a; apk --version\n{2}poweroff\n'`; `pnpm test:distro` |
| Debian image, or anything glibc sees | `kernel/build.sh distro debian`; `node js/cli.ts --distro debian --timeout 180 --input '{10}getconf GNU_LIBC_VERSION; apt --version; dpkg -l \| wc -l\n{4}poweroff\n'` (exit 0); with a network, also `apt-get update` and an `apt-get install` |
| Data disk, overlay root (`block.ts`, `kwsparse.ts`, `web/src/data.ts`, the base's `/init`, `kw-overlay`, `data-stop`) | `pnpm test:block`; `pnpm test:distro` (persistence, safe mode, `kw.root=initramfs`, `kw-overlay discard`, an image change, two distros on one disk); `pnpm test:api` (its data disk tests); `node js/cli.ts --data /tmp/d.img --timeout 120 --input '{10}ls /data /data/distros\n{2}{sync}{2}poweroff\n'` (`sync: block flush after`, a clean exit; delete the image afterwards) |
| Network (SDK or kwnet) | `pnpm test:net`; `pnpm test:net-port`; `pnpm test:api`; `UNKERNEL_TEST_WISP=1 node --test test/api.test.ts` |
| SDK (`js/`, `package.json`, `build.config.ts`) | `pnpm typecheck`; `pnpm test:tty`; `pnpm test:http`; `pnpm test:9p`; `pnpm test:api`; `pnpm test:distro`; `pnpm build`, then the kwtest and userland rows with `node dist/cli.mjs`, `UNKERNEL_DIST=1 node --test test/api.test.ts`, and `npm pack --dry-run`; after a change to `fetchDistro()` or the CLI's `--distro`, the installed package (`npm pack`, unpacked elsewhere) against a local copy of a release (a static server over a directory with `distros.json` and the images, `UNKERNEL_RELEASE_URL=http://127.0.0.1:PORT/ UNKERNEL_CACHE_DIR=/tmp/c node PKG/dist/cli.mjs`): a download, a second run from the cache, a corrupted cache file downloaded again, and the server stopped (an error naming `--distro none` without a cache, the cached image with one) |
| Host file systems (`fs.ts`, `9p.ts`, `memfs.ts`, `mounts.ts`, `nodefs.ts`, `kw9p.c`) | after a kw9p change `kernel/build.sh base`; `pnpm test:9p`; `pnpm test:api`; `node test/9p-bench.ts` and with `--worker`, against js.md's table |
| Page (`web/`) | `pnpm typecheck:web`; `node --test web/test/open.test.ts`; `pnpm build:web` (it uses a local build when there is one, else the newest release's base bundle and distro images, and refuses a release without them or of another kwemu ABI; web.md, The page's kernel and distro images) |

`node test/glimmer-check.mjs --run` takes `--no-sound` (no sound card)
and `--worker` (through the CLI's `--worker`, with input and frames in
shared memory); run it also with `--worker=messages` after a worker-mode
change. The A64 guests of `zig build test` must match qemu-aarch64 on
every runner (`ok   a64 <runner> <guest> = qemu`).

The SMP kernel (kernel/smp.md; `kernel/build.sh smp` puts it in the
bundle) runs the same checks:

- kwtest with `--cpus 2`, `--cpus 4` and `--cpus 2 --no-jit` (add `--display
  --shm` for its kwfb and kwshm checks), and once on one CPU (`--kernel
  vendor/build/kernel-smp/vmlinux32.wasm --initrd base-test`);
- abitest with `--cpus 2`;
- `UNKERNEL_TEST_CPUS=2 pnpm test:api` (the snapshot tests too: they then
  save and restore 2-CPU machines; the "SMP: snapshot()" test uses 4 CPUs
  without the variable);
- `node test/glimmer-check.mjs --run --kernel <it> --cpus 2` (on Alpine;
  `--distro none` for the base shell).

kwtest's `smp:`, `lse smp:`, `excl smp:`, `move:` and `jit:` checks race
by design, so one pass proves little: run `rdinit=/usr/bin/kwtest -- smp`
(only those checks, a few seconds a boot) 5 times, and 20 or more only
when chasing a race.

When you measure something, follow the rules in a64/performance.md (machine, date,
command, interleaved medians).

## Profiling CPUs and worker mode

Two twins time everyday guest work (command latency, a shell loop,
fork+exec, gzip, sort, sha256sum, `find /usr`, and three parallel ones:
4 loops, 8 sort pipelines, one loop per CPU of the widest configuration)
in each configuration, one boot each, with medians over runs and the
first run apart, and score the single-threaded and the parallel ones
apart (geometric means). Use them before changing the CPU or worker
defaults (web/src/config.ts `SUGGESTED_CPUS`), and to judge SMP work.

- `/profile.html` (web/src/profile.ts; the dev server or a build): the
  page's thread and a worker on 1 CPU, a worker on 2 to the device's
  threads (up to `MAX_CPUS`), the longest frame gaps meanwhile, Copy
  JSON / Copy table, and Host threads: workers and nested workers doing
  the same work (do they run in parallel) and Atomics.wait/notify against
  spinning round trips between two workers, without a kernel.
- `node test/profile.ts [--cpus 1,2,4,8] [--no-main] [--runs 3] [--scale
  1] [--distro debian] [--mem 512] [--no-jit] [--json FILE]`: the same on
  Node (this thread, and worker threads), with the event loop's longest
  lag instead of frame gaps; a markdown table on stdout.

Results (Debian, 512 MiB, JIT; speedup of the parallel ones against one
CPU in a worker; 2026-11-19):

| Host | 1 CPU: worker vs main thread | 4 CPUs | 8 CPUs | most | single-threaded at 8 | boot 1 / 8 CPUs |
| --- | --- | --- | --- | --- | --- | --- |
| Chrome 157, macOS, 14 threads | same speed; frame gaps 9 ms vs 100 ms | 2.5-3.5x | 2.7-5.3x | 14: 2.7-4.7x | +5% | 0.21 / 0.54 s |
| Safari 27.2, same Mac (reports 8) | same speed, smoother | 0.4-0.6x | 0.15-0.4x | | +7% | 0.23 / 0.63 s |
| Node 24, Linux, i7-10700K, 16 threads | same speed; event loop lag 4 ms vs 23 ms | 2.9-3.3x | 2.9-3.8x | 16: 2.9-4.0x | +4% | 0.39 / 1.08 s |

Parallel work tops out near 4x however many CPUs on these workloads
(status.md, SMP). Safari's row predates the fix for its loss: kwemu polled
the code epoch, one word, with an atomic load at every block end, and
JavaScriptCore runs a wasm atomic load as a read-modify-write, so the CPUs
took the cache line from each other (a64/tier.md, Coherence).

`/smp-probe.html` (web/src/smp-probe.ts; the dev server or a build) is the
page that found it: engine probes without a kernel (workers and nested
workers, timed waits and wake latency, wasm loads, stores and atomics on
one shared memory, compiles, GC) and the kernel on 1 to 8 CPUs with as
many copies of a compute, a syscall and a fork+exec loop, with the JIT off
and with the `kw_spin_*` parameters changed; Copy text / Copy JSON, and
URL options (`?auto=`, `?configs=`, `?probes=`, `?scale=`). With the fix
(2026-11-23, JIT; speedup against one CPU):

| Host | 2 CPUs | 4 CPUs | 8 CPUs | 4 CPUs, JIT off |
| --- | --- | --- | --- | --- |
| Safari 27.2, macOS, 14 threads (reports 8) | 1.6-1.9x | 3.3-3.5x | 5.2-5.8x | 3.2-3.7x |
| Chrome 157, same Mac | 1.6-1.9x | 3.4-3.6x | 5.4-6.9x | 3.3-3.7x |
| Safari 27.2, iPhone 15 Pro (2 fast cores, reports 4) | 1.3-1.6x | 1.8-2.0x | | 2.1-2.4x |

## Release workflow (CI)

`.github/workflows/release.yml` is the source for what CI does; the
maintainer runs it by hand from main (its `release` input unchecked makes
it a smoke run). One job builds everything from source with
`KW_RELEASE=1` (kwtest, abitest and kwbench stay out of the bundle;
base-test.cpio brings them): the patched wasm-ld, both kernels, the data
disk template, the base bundle `unkernel.wasm` (`KW_SMP=1`: it must carry
the SMP patch), then the distro images (`kernel/build.sh distro`: the
Debian image boots on that bundle to make apt's cache, and the step fails
if it was left out) and `distros.json`, which it checks against
`include/kw_emu.h`'s ABI and the images (sha256, size, ids; exactly
alpine and debian, erofs), and the guest GL renderer the package carries
(`gl/wasm/build.sh`: emscripten and virglrenderer, pinned). Network is
needed only for the pinned downloads. Then it runs kwtest with and without the JIT and on 2 CPUs,
and abitest on the UP kernel and on 2 CPUs (`--initrd base-test`, no
distro), `pnpm typecheck` and `pnpm typecheck:web`, `pnpm test:kpatch`,
the tty, http and 9p tests, `pnpm test:distro`, and kwtest and the api
tests on the built package (none of these needs a network: the images
come from the build). The package must hold no image or initramfs and
stay under 20 MB packed (4.7 MB, 11.4 MB unpacked, 2026-11-19, a dry run
of the step). A release publishes the tarball to npm and a GitHub release
(tag `v<version>`, the version stamped into package.json) with the
tarball, `unkernel.wasm`, `distros.json` and the images it names
(`alpine.erofs`, `debian.erofs`; not the `.ext4`, `.tar` or `.id` files),
which the package's `fetchDistro()` and the page's build
(web.md, The page's kernel and distro images) download. The build steps
are `kernel/build.sh all`'s, split so that each cache is saved after its
part. Re-running a release skips what exists (the tag, the npm version)
and uploads only the assets an existing GitHub release lacks, publishing
it if a cut-off run left it a draft. Caches: the
toolchain, the kernel tree and builds, and the downloads; the workflow's
header lists their keys.

Not in the workflow, so only the full matrix covers them: kwtest without
the JIT on 2 CPUs, the api tests with `UNKERNEL_TEST_CPUS=2`, `zig build
test`, the block and net tests, the page (`web/test/`), and
`fetchDistro()` and the page's build against a real release.
