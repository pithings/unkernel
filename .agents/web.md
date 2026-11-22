# The browser page (`web/`)

A static page: a full-screen terminal ([wterm](https://wterm.dev/)), with
more terminal windows over vsock, a tmux-style status line at the bottom
and terminal-style dialogs, built with React and Tailwind (v4, a black
theme after Vercel's Geist), Vite (client) and Nitro (server and route
rules), on the SDK from source. The top-level README.md describes it for
users.

## Files

`web/index.html` (the inline error bootstrap, and fallback markup that
React replaces), and in `web/src/`: `main.tsx` (entry: config, renders the
app, preflight with the SDK's `checkSupport()`), `config.ts` (the
settings, kept in localStorage, documented at its top), `store.ts` (the UI state, read with
`useStore()`), `ui.ts` (`KW.ui`: the imperative API boot.ts and main.tsx
drive, plus `nextSettings()`), `shortcuts.ts`, `boot.ts` (terminal and boot,
a separate chunk loaded only after the preflight passes), `windows.ts`
(terminal windows 1-9), `bottom.ts` (keeps a terminal at its bottom when
it gets shorter), `net.ts` (Wisp only), `apk.ts` (apk index prefetch), `download.ts` (files the page fetches for the guest), `sudo.ts` (root in the guest: `SUDO_SH`, `execAsRoot()`), `sdk.ts`, `kw.ts` (`window.KW`),
`data.ts` (the data disk), `session.ts` (the suspended session), `autosuspend.ts` (suspending in the background and the question on leaving: when, decided without a DOM), `display.ts` (the guest display's state, the
mode offered, keyboard routing), `audio.ts` (Web Audio output),
`preview.ts` (the guest preview's page side), `wayland.ts` (the Wayland
desktop: wland on vsock and kwshm), `open.ts` (the guest's
`open` and `xdg-open`, host commands: a URL on the guest's own address in
the preview, any other http(s) URL in a new tab, each only after the user
confirms), `sw.ts` (the service
worker's registration and the update check), `launcher.ts` (how a demo
runs; the demos are in `src/demos/`), `style.css`
(Tailwind theme, the dialog, wterm's colours). `src/components/`: `App.tsx`
(layout, viewport, key bar visibility, pinch), `Bar.tsx` (the status line), `Launcher.tsx` (its first item and the
launcher overlay),
`Panel.tsx` (the dialog), `Options.tsx`, `Display.tsx` (the display layer,
rotation, mouse and touch input, touch controls), `Desktop.tsx` (the
Wayland desktop's layer), `Keys.tsx` (extra keys),
`Overlays.tsx` (splash, toast, paste and confirm dialogs), `About.tsx`
(the status line's triangle and the credits dialog), `Preview.tsx`
(the preview panel), `icons.tsx`. `src/env.d.ts` declares `__KW_BUILD__`,
which `vite.config.ts` defines: the Linux release read from the committed
kernel's banner, the kernel's release tag and the page's commit (empty
where git is missing or the clone is too shallow). `web/public/vm-sw.js` is the page's
service worker (the preview's relay), `web/server/vm.ts` the preview's server fallback,
`web/server/distros.ts` the built Node server's `/distros/` handler and
`web/server/range.ts` the Range logic it shares with the dev server,
`web/scripts/kernel.ts` what the page runs (below).
`web/public/manifest.webmanifest` makes the page installable (standalone, black); its icons
`icon-192.png`, `icon-512.png` (the whole logo at 6x and 16x), `icon-maskable-512.png` (inside the
border, corners filled, opaque) and `apple-touch-icon.png` are `assets/logo.svg` rendered at 32 px
and scaled nearest neighbour (`magick -filter point`).
`web/vite.config.ts` holds the COOP/COEP headers (Nitro route rules, plus
the dev server's own responses), `__KW_BUILD__`, `virtual:unkernel-kernel`
(the kernel's URLs, the GL renderer's URL and the list of images), the dev
server's `/distros/` and `/_gl/` middleware, and the build step that copies
the images into the output (below).

## The page's kernel and distro images

The page runs the base bundle `unkernel.wasm` (the kernel and the base
initramfs, with the data disk template and the SMP patch section) and boots
it with a read-only distro image (`alpine.erofs`, `debian.erofs`) that it
attaches by URL and reads lazily with Range requests (the SDK's
`createKernel({ distro })`, js.md, Disks). `pageSource()` in
`web/scripts/kernel.ts` (described at its top) picks both when the dev
server starts or a page build begins (the `unkernel:kernel` plugin's
`config` hook in `vite.config.ts`, before anything is served or built), and
logs which and why (a build between two lines of `=`). Building or
deploying the page needs no kernel toolchain.

- The source, in this order:
  1. `KW_KERNEL=<file>` and/or `KW_DISTROS=<dir>` (relative to `web/`):
     that base bundle and the images in that directory (`<name>.erofs`, or
     `<name>.ext4` where there is no `.erofs`; `distros.json` there gives
     image ids), the other part from the local build, whatever `KW_LOCAL`
     says.
  2. A local build, when one may be used: `KW_LOCAL=1` forces it,
     `KW_LOCAL=0` forbids it, and by default it is used unless `CI` or
     `VERCEL` is set (a deploy or CI build has no `vendor/` and must ship
     a release). It needs `vendor/build/bundle/unkernel.wasm` (`kernel/build.sh
     base`) and at least one image in `vendor/build/distro/`
     (`kernel/build.sh distro`; both from `kernel/build.sh all`).
  3. Else the newest non-draft release of `pithings/unkernel`
     (`.github/workflows/release.yml`; `KW_KERNEL_RELEASE=<tag>` picks
     one), which must carry `unkernel.wasm`, `distros.json` and every image
     `distros.json` names. A release without them (every release before
     the base bundle: `unkernel-alpine.wasm` only) fails the build with
     what to do: build locally (`kernel/build.sh all`), cut a release, or
     name a release that has them. So a deploy (Vercel) and CI ship a
     release, never a local build.
  1 and 2 show as "local build" in the About dialog, 3 as the release's tag.
- A release is downloaded at build time (the dev server only when it has no
  copy yet, and then without a network check), because GitHub serves
  release assets without CORS (both the `github.com` redirect and
  `release-assets.githubusercontent.com`), so the browser cannot fetch
  them, and CDNs such as jsDelivr only serve files from the git tree. The
  copy is `web/kernel/release/` (gitignored: `unkernel.wasm`,
  `distros.json`, the images, `release.json` with the tag and every file's
  sha256). Everything is checked in a temporary directory before it
  replaces that copy (a rename), so a refused or broken release leaves
  `web/kernel/` as it was: `distros.json` first (its `abi` must be
  `include/kw_emu.h`'s `KW_ABI_VERSION`, its entries well formed), then
  `unkernel.wasm` (the API's sha256 digest where there is one, wasm magic,
  its own ABI from `kernelInfo()` in `kernel/tools/bundle.mjs`, its base
  id against `distros.json`'s `base`, `bundleInfo()` in
  `guest/tools/distros-json.mjs`), then each image (size and sha256 from
  `distros.json`, and the API's digest). An image the copy already has
  with that sha256 is reused, and a build whose newest release is the
  copy's downloads nothing. The GitHub API gives the newest release and the
  digests; without `GITHUB_TOKEN` (or `GH_TOKEN`) it allows 60 requests an
  hour per IP, so on any API failure the build reads the newest tag from
  `releases.atom` and downloads from the usual URLs (no digests; the
  sha256 in `distros.json` still checks the images). If GitHub cannot be
  reached, a build keeps the copy (when it is the tag asked for).
  `KW_GITHUB_API` and `KW_GITHUB` replace `https://api.github.com` and
  `https://github.com`, for a stand-in server. Checked 2026-11-19 against
  such a stand-in: a complete release built and booted (Alpine, Debian),
  a second build downloaded nothing, and a release without
  `distros.json`, one without an image, one whose `distros.json` says
  another ABI and one with a wrong image sha256 each failed with
  `web/kernel/` unchanged; the real newest release (v0.1.0-261117-0e4b2ec)
  fails with that message.
- The kernel must match the page: a local base bundle whose kwemu ABI is
  not `KW_ABI_VERSION` only gets a warning, a release is refused (above).
  The page's texts and demos (the Ubuntu demo's arm64 tarball, the
  launcher's aarch64 packages) are written for this checkout's guest.
  Order after an ABI or guest change: merge, cut a release (the workflow),
  then deploy the page; a page build that takes the newest release before
  then (CI, Vercel, `KW_LOCAL=0`) fails (or give `KW_KERNEL` and
  `KW_DISTROS`, `KW_LOCAL=1` or a matching `KW_KERNEL_RELEASE`). A
  release changes a deployed page only once the page is rebuilt.
- The kernel's URLs (`virtual:unkernel-kernel`'s `kernelUrl` and
  `kernelSmpUrl`, which `src/sdk.ts` exports): `baseSplit()` takes the
  SMP patch section off the bundle: the UP kernel is the bundle without it
  (byte for byte the bundle when it has none), the SMP one the kernel the
  patch makes with the same initramfs, command line and data disk template
  (js/core/kpatch.ts; `kernelSmpUrl` is null without the section). A build
  emits both from memory as hashed assets (`unkernel-<hash>.wasm`,
  `unkernel-smp-<hash>.wasm`), so it never touches the dev server's files;
  the dev server writes them to `web/kernel/page/<16 hex digits of the
  bundle's sha256>/` (`splitBase()`; the four used last are kept, so dev
  servers of different bundles do not overwrite each other) and serves
  them as `/@fs/` files, split again when a local bundle changes. UP
  visitors download only the UP kernel (8.4 MiB, about 4.7 MiB
  compressed); only a load with several CPUs fetches the SMP one (Several
  CPUs, below).
- The images' URLs and caching, with `virtual:unkernel-kernel`'s
  `distros` list (`{ name, url, size, imageId? }`, debian first;
  `imageId` where `distros.json` gives it, else the page reads it from
  `/run/kw-base`):
  - A build names each image by its content,
    `/distros/<name>-<16 hex digits of its sha256>.erofs`, and copies it
    (a real file with the source's mtime; never anything else from its
    directory, whose tar and ext4 files are 100 MB and more) into the
    output's `public/distros/` (`.output/public/distros/`, on Vercel
    `.vercel/output/static/distros/`) in the `unkernel:distro-images`
    plugin, whose `buildApp` hook runs after Nitro's. That is after Nitro
    compressed its public files and listed its static assets:
    `compressPublicAssets` has no filter and compresses every file whose
    type it does not know as text, and Nitro's static handler (which does
    answer single ranges) would then send the `.br` variant. Such a URL
    never changes content, so it is `cache-control: public,
    max-age=31536000, immutable`, with the strong ETag
    `"<hash>-<size in hex>"`, the same on every server and deploy. A new
    image is a new URL, so a session suspended on the old one is not
    resumed (Suspend and resume).
  - The built Node server answers them in `web/server/distros.ts` (a Nitro
    handler for `/distros/**`, reading `../public/distros/` next to its
    `index.mjs`). On Vercel the CDN serves them as static files (its
    `config.json` has the `filesystem` handle before the function's
    `/distros/` route), with its own Range support and ETag; the
    `/distros/**` route rule adds CORP, and `unkernel:distro-images` adds
    a route in the `hit` phase (a request a static file answered) that
    sets the immutable Cache-Control, so a 404 from the function is never
    cached. Checked 2026-11-19 in the build output only, not on a
    deployment.
  - The dev server answers `/distros/<name>.erofs` itself (the
    `unkernel:kernel` plugin's middleware; Nitro's dev handler answers
    public files br-compressed, in full and without Range support) from
    the files the list names, wherever they are. A local image is rebuilt
    in place, so these plain names are `cache-control: no-cache` with an
    ETag from size and mtime. The SDK's opening request revalidates (a 304
    while the image is unchanged); its other requests take the browser's
    cached copy anyway (`force-cache` ignores `no-cache`), and after a
    rebuild their old ETag fails the check against the opening one, so
    they are fetched again (below). The list's sizes are read again when
    an image changes (on the next page load). Earlier dev servers linked the images into
    `web/public/distros/` (gitignored); that directory is unused, and in
    Nitro's `ignore`.
  - What the SDK asks of the server (js/core/block.ts `HttpBase`): it
    opens an image with one Range request for its first 256 KiB with
    `cache: "no-cache"` (the one request that revalidates), then reads the
    prefetch the image's distro header names (Alpine: the whole image, one
    plain GET; Debian: one streamed Range request of its first 4 MiB), the
    background tier it names once the boot is quiet (Debian: the warm set,
    apt's files, from 4 to 27 MiB, in 4 MiB Range requests one at a time),
    and lazy and read-ahead ranges (256 KiB-aligned; read-ahead up to 4 MiB),
    all `cache: "force-cache"`, comparing each response's
    ETag with the opening one's and fetching a mismatch again with
    `cache: "reload"`. So every response for an image, 200 and 206 alike,
    must carry the same strong ETag, be cacheable (never `no-store`) and
    not be content-encoded (a 200's Content-Length is checked against the
    image's size).
  - The dev middleware and the Node handler share `web/server/range.ts`:
    no compression, 200 for a request without Range, 206 with
    Content-Range for one range (a malformed or multi-range header gets
    the whole file), 416 with `bytes */<size>` past the end, one ETag per
    image on every response (a rebuilt image changes it, and the SDK's
    strict `HttpBase` then refuses reads instead of mixing two images),
    If-None-Match before Range (RFC 9110: a cached range revalidates with
    a 304), If-Range, COOP/COEP/CORP, and 404 (`no-store`) for anything
    else under `/distros/`. Vercel's CDN sends its own ETag; whether it is
    the same on a 200 and a 206, and across its edges, is not checked (a
    differing one costs a refetch, never a mixed image).
  - Measured 2026-11-19, headless Chromium (Playwright's build), one
    profile, the same load twice, `?data=0`, to the prompt: on the built
    Node server Debian made 20 requests, 18.9 MiB, the first time (prompt
    2.2 s); the second time only the opening request reached the network
    (a 304, 423 bytes) and 19 came from the HTTP cache (prompt 0.52 s);
    Alpine 2 requests, 4.1 MiB (0.36 s), then 1 on the network (304) and 1
    from the cache (0.34 s). The dev server: the same counts (Debian's
    second load 0.67 s).
- The guest GL renderer (`virgl.mjs` and `virgl.wasm`, gl/wasm; Guest GL,
  below), optional, picked with the kernel (`withGl()` in
  `web/scripts/kernel.ts`): `KW_GL=<dir>` (`KW_GL=0`: none), else with a
  local kernel `vendor/build/gl-wasm/` (`gl/wasm/build.sh`), else the
  release's `virgl.mjs` and `virgl.wasm` assets (the release workflow
  attaches them; a release without them, every one before guest GL, gives
  none and the page builds without GL: `release.json`'s `gl` is null). The
  build log's `GL renderer:` line says which. `virtual:unkernel-kernel`'s
  `glUrl` (null without one; `src/sdk.ts` passes it to `webPlatform()`):
  in a build both files are emitted under fixed names into
  `/assets/virgl-<16 hex digits of their sha256>/` (virgl.mjs loads
  `./virgl.wasm` next to itself, so neither may be renamed alone); the dev
  server answers `/_gl/virgl.mjs` and `/_gl/virgl.wasm` itself (`serveGl()`,
  `no-cache` with an ETag, untransformed: Vite would rewrite the module).
  Either is fetched only by a load with GL on, on the guest's first GL use
  (the SDK imports the module then; Guest GL, below).
- `web/src/sdk.ts` imports `js/core/index.ts`, `js/web/memory.ts` and
  `js/web/platform.ts`, not `js/web.ts`, whose own bundled kernel would
  become a second 10 MB asset. Its `kernelUrl` is a hashed Vite asset,
  which the Node server sends precompressed (br, zstd, gzip). Compressed
  responses have no decoded length, so there is no download percentage.
- `vite.config.ts` keeps the dev server from watching `.output/`,
  `.vercel/`, `kernel/release/` and `kernel/page/`: a page build rewrites
  `index.html` there, which would reload an open dev page and end its VM.

## Rules

- Settings live in localStorage `kw.settings` (config.ts `SETTINGS_KEY`:
  the parameter names and values, only those that differ from the
  defaults). Reboot saves the options there and loads the bare URL; a URL
  parameter of the same name overrides the saved one for that load (the
  browser tests use that), and the page never writes the URL (where
  localStorage refuses, Reboot puts them in the URL instead). Every
  setting except `?shared` has a control under Options in the System tab
  (`Options.tsx`, the store's `options`, `nextSettings()`); `?simulate`,
  `?showcase` and `?try` are URL only. A new setting needs a control too. The
  desktop test checks the mapping. The
  fields are controlled, and also read by native listeners on the form,
  because React drops change events for a value set from script (the test
  does that).
- `window.KW` is what the browser tests read, together with the element
  ids: `#bar-win-N` (window N), `#bar-new`, `#bar-display`, `#bar-desktop`, `#bar-log`,
  `#bar-errors`, `#status` (its CSS `color` turns red on an error) and
  `#status-label`, `#panel` (class `open`), `#confirm`. Keep them working.
- Safe areas are the CSS variables `--st`, `--sr`, `--sb`, `--sl` (style.css). On iOS,
  `--sb` is three quarters of the bottom inset: the status line's background reaches the
  bottom edge, its contents sit that far above it, and it moves its ends in by `--sc`
  (half the bottom inset) for the round corners. While the on-screen keyboard is up
  (`App.tsx` sets `kb` on the root when the visual viewport is well below the layout
  viewport, so on iOS) both are 0 and the status line is hidden. In an iOS home screen
  app `--st` is 24 px more than the top inset: iOS fades the page's top 20 px or so
  there.
  On macOS outside fullscreen, `main.tsx` sets `mac-window` on the root and `--sc` is
  8 px, for the window's round bottom corners.
  In a home screen app (standalone) `App.tsx` sizes `#app` to the layout viewport's height
  unless the keyboard is up (the visual viewport can stay short after it closed). The
  status bar style is `black`, not `black-translucent`: with that, iOS 26+ makes the
  viewport shorter than the screen by the status bar and shows nothing below it (WebKit
  bug 301108). iOS reads the style when the app is added to the home screen.
- The tab's title is `<mark> unkernel`: one character for the machine's
  state (ui.ts `titleMark()`, from the store's state, label and
  `suspended`, set in the store's listener, so synchronously with each
  change and before a hidden page may be frozen): `▶` (U+25B6 with U+FE0E,
  text presentation) running, `‖` paused (held in the background or by
  Pause) or suspended, `…` starting, resuming or suspending, `■` halted or
  powered off, `!` failed. Only that mark is replaced; the rest of the
  title is kept as found.
- An unknown or failed boot step must end in `ui.fail(...)`, so the
  indicator turns red and the panel opens. The page must never stay blank.
  `index.html` installs `error`/`unhandledrejection` handlers first and
  reports the page module if it has not run after 8 s; `main.tsx` imports
  the boot chunk only after `checkSupport()` passed. A missing feature, a
  module that fails to load, a 404, a failed allocation, a panic or a trap
  all end there.
- Memory: the default is the SDK's `autoMemoryMiB()` (2 GiB on desktops,
  512 MiB on phones, less with a low `navigator.deviceMemory`); if the browser
  refuses the allocation the runtime retries with
  `DEFAULT_MEMORY_FALLBACK_MIB` (1024 down to 64, `js/web/memory.ts`).
  Alpine boots in 48 MiB.
- Keyboard shortcuts (`shortcuts.ts`): Ctrl-A is a prefix as in GNU
  screen, and ⌘A too on Apple devices (it takes nothing from the guest). Digits
  are windows, as in screen and tmux (also Ctrl-Shift-digit, which
  terminals and browsers leave unused), so new shortcuts use letters. New
  window is n or c (as in tmux); the launcher is o, also ⌘K on Apple devices
(a `meta` code in COMMANDS; Ctrl-K is readline's kill-line, so not that
elsewhere) and Ctrl-Shift-O; Copy diagnostics is y after the prefix
  and c inside the dialog. The listener is
  on window in the capture phase and is added before display.ts's, so the
  shortcuts work while a program holds the evdev keyboard; key-ups always
  pass, so a Ctrl the guest saw go down comes up.
- The dialog is modal and keyboard-usable (`aria-modal`, `inert` while
  closed, ARIA tabs, focus trapped and returned). Options are real inputs,
  so keyboards and screen readers work on them. Questions use `ui.ask()`,
  a native modal `<dialog>`, never `confirm()`; it releases pointer lock
  first.
- Display and input: the mode offered to the guest is the stage size in
  CSS pixels (turned when the rotate chip is on), and the canvas is scaled
  to fit. kwfb takes it at a program's first open; virtio-gpu (guest GL)
  is told when the stage settles at another size (a ResizeObserver on the
  stage and the rotate chip, `vm.updateDisplaySize()` 300 ms after the
  last change: window resizes, full screen, a turned phone, the preview
  docked), a hotplug with the new preferred mode; the canvas follows the
  mode the guest then sets (gl.md, Display size). While a program has the evdev keyboard open, keys go to it and
  not to the terminal. With the tablet open the pointer goes there as
  absolute positions and nothing locks; this wins when both mice are open.
  Otherwise a click with the relative mouse open takes pointer lock. Phone
  keyboards send no usable keydowns, so a hidden input's value is diffed
  against a sentinel and sent as US-layout key presses. Pointer positions
  under rotation go through `unturn()`/`localPos()` (Display.tsx). Touch
  layout choices are in localStorage (`kw.*`).
- Terminal windows (`windows.ts`): 1-9 are `vm.spawn()` sessions (js.md),
  each its own wterm. Output is read all the time, shown or not, since an
  unread `Pty` blocks its programs; the reader takes the next chunk only
  after `write()` returned and yields a task (a MessageChannel, which
  background tabs do not throttle) every 16 ms or 256 KiB. `KW.windows`
  is their API. Every window's session is detachable (`detachable: true`),
  so it survives Suspend and resume (below). Checked by hand only (no
  browser test yet).
- Worker mode (the default where the page is cross-origin isolated, else
  off; `?worker=0` / `?worker=1` pick; implied by several CPUs) boots through the SDK's worker mode (js.md):
  the page compiles the kernel and passes the `WebAssembly.Module`; disks
  and the network are specs built in the worker. The data disk in worker
  mode follows data-disk.md (Persistence in the browser). `KW.kernel` and
  `globalThis.kernel` stay unset, so the browser tests (whose
  `page.type()` uses `kernel.sendInput()`) run inline only: lib.mjs
  `goto()` adds `?worker=0&cpus=1` unless the URL has them. A default
  worker (no `?worker=`) that does not start (a `support` BootError, or
  no report within 20 s) reloads once on the page's thread
  (`bootUpOnce(..., inline)`, sessionStorage `kw-inline-once`); every
  other way an asked worker can fail ends in `ui.fail`.
- Sound is an AudioWorklet fed by postMessage, because the kernel calls
  the import from a busy main thread; scheduled buffers are the fallback
  where there is no secure context. Checked by hand only.
- Every response carries COOP/COEP. A secure context is therefore
  cross-origin isolated, which worker mode's shared transport needs (the
  kernel's own memory is not shared). Anything cross-origin that the page
  loads must send CORP (WebSockets are exempt).
- The guest network is Wisp only. A page served from an origin outside the
  Wisp server's allow list needs its own Wisp server (js.md). A `ws://`
  server is blocked as mixed content on an `https://` page.
- The distro (above): `?distro=<name>` (default `debian`, else the first
  image; an unknown name boots the default, with a warning line, a toast,
  the Environment tab's Distro row and the option's note; `none` attaches
  no image: the base shell). Its option is the Distro radios
  (`#opt-distro-<name>`, `#opt-distro-none`, `#opt-distro-note`). Inline,
  boot.ts opens the image with `openDistroDisk()` while the kernel
  downloads, so the resume check sees the snapshot's disks (`[distro,
  data]`); worker mode passes the URL. The image is the read-only
  `/dev/wda`, the data disk `/dev/wdb`. The bundle's own command line is
  used unless `?append=` gives one (`?root=` appends `kw.root=`). Once
  user space runs, boot.ts reads `/run/kw-base` (guest/base/initramfs/init)
  for the Distro and Root rows, About (the image id) and diagnostics'
  config line (`distro=`, `image=`). Where a feature or text is Alpine's
  (apk, wget), it is gated on `cfg.guest === "alpine"` (Rules,
  Launcher). Failures: an image that does not open (404, a
  server without Range, not erofs/ext4) is `ui.fail` (kind `distro`, with
  a hint); a read that fails later (the image changed or the server
  stopped; the guest gets EIO) is a non-fatal `KW.report`; the base's
  base shell (`unkernel base shell (...): why` on the console) is a
  warning row and a report. Checked 2026-11-19 with headless Chromium (a
  scratch script, not in `web/test/`) on the built Node server and the dev
  server, from a scratch build of the current sources: both distros, the
  switch through Options and Reboot, per-distro changes on the data disk,
  `?data=0`, `?worker=1`, `?cpus=2`, `?root=initramfs`, `?distro=none` and
  an unknown name, suspend and resume (inline and worker) and the refusal
  across distros, the data disk reset (`KW.resetData()`), and the
  failures above (404, no Range, a changed ETag, by request interception).
  To the prompt, Debian 0.9 s and Alpine 0.3 s on the Node server with a
  cold cache (caching above).
- apk index prefetch (`apk.ts`, described at its top): on the alpine
  image only. Once user space
  runs, the page pushes the guest's missing or stale APKINDEX files into
  `/var/cache/apk` through `vm.exec()` (as root: `execAsRoot()`, sudo.ts), so apk skips its own index download.
  That covers the enabled repositories and the lazy ones in
  `/etc/kw-apk-lazy` (community), which kw-apk-install reads before it
  enables one (kernel/guest.md). It fetches them as plain http over its own Wisp connection (the mirrors
  send no CORS headers; apk checks the signature on every load) and keeps
  them in the Cache API (`kw-apk-index-v1`), revalidated after 1 h. The
  pushed file's mtime is the time the mirror last confirmed it. Off with
  `?net=0`.
- `~/README` (intro notes) comes from the image, not the page
  (kernel/guest.md); its section on the page names the page's shortcuts
  and options: keep them in step with the page.
- The safe-mode explanation comes from watching the console for
  `kw-overlay: SAFE MODE:` (`boot.ts`, see data-disk.md): the base's check
  of the root with the data disk's changes failed, so this boot runs the
  plain image on a tmpfs upper; the changes stay in
  `/data/distros/<name>/upper`, and every boot checks them again. The
  panel note (`data-safe-note`), a toast and the Root row say so, with
  `kw-overlay status` and `kw-overlay discard`. `?root=initramfs` (the
  Safe mode button) is the same for one boot by choice.
- A guest `reboot` (halt code 2) reloads the page once the last data-disk
  save has committed, at most 3 times a minute per tab (sessionStorage
  `kw-auto-reboot`); then the page stays halted and says why.
- Kernel messages go to the Kernel log tab; during boot only the newest
  shows on a transient line, and IMPORTANT ones (`js/core/console.ts`) are
  written in full. Once user space prints, "Started Linux" (the kernel until
  it runs `/init`), "Started Alpine" (the base mounting the image and the
  distro's init; "Started the base shell" without one), the "Booted
  in" summary, two notes (the repository as an OSC 8 link, and how to
  open the demo launcher; not on a resumed session), with Pip from the
  logo (`assets/logo.svg`) in truecolor half blocks to their left when
  the terminal is wide enough, and the buffered
  user-space output follow; nothing is scrolled away or erased. The desktop test checks the order.
- wterm (`@wterm/dom`, Apache-2.0; xterm.js was dropped because its touch
  scrolling had no momentum) renders rows as DOM text, and `#term` (and
  each `.term-win`) is itself the scroll container, so `#term` must not
  set `overflow`. When it gets shorter while scrolled to the bottom,
  App.tsx puts it back at the bottom before wterm refits (wterm would
  otherwise show the prompt behind the keyboard). React renders `#terms`
  and `#term` once and never touches them again. wterm takes the row
  height from `--term-row-height`, so `setTermFont()` sets both together.
  `KW.screenText()` reads its core directly, because `readText()` is async.
- Phones never zoom the page: a pinch sets the font size, two-finger
  touchmoves and Safari's `gesture*` events are cancelled (iOS ignores
  `user-scalable=no`), and wterm's hidden textarea is 16 px, because iOS
  zooms on focusing a smaller field.

## Guest GL

The Guest GL option (`?gl=`, the `#opt-gl` box in Options; on by default
on Debian where the display is: `?gl=0` turns it off, `?display=0` too
unless `?gl=1`; config.ts `glDefault()`, saved only where it differs)
boots with the SDK's `createKernel({ gl: true, gpu: true })` (js.md, Guest
GL, virtio-gpu 3D; gl.md, The DRM path): the guest's Mesa renders through
virglrenderer compiled to wasm on a WebGL2 context of the page's thread (in
worker mode too: vsock and the renderer are served there), through the
virtio-gpu device's `/dev/dri` (stock Mesa, no variables; a KMS client's
frames go to the display from the renderer's texture, `drawFrame()` in
Display.tsx) or the vtest link (frames come back to the guest by readback).
The renderer (`virgl.mjs`, `virgl.wasm`) is fetched and started only on
the guest's first GL use (gl.md, Loading on first use), so a visitor who
never runs a GL program fetches nothing of it; before the boot the SDK
only tries a WebGL2 context (a few ms). `?glload=eager` (this load's URL
only) loads it before the boot (`gl: { eager: true }`). `?gpu=0` (this
load's URL only, like `?glwait=`; also `?display=0`) leaves the device
out, so the guest has the vtest link alone, for comparison.

- Only on Debian (`GL_DISTROS`, config.ts: Alpine's Mesa has no virgl
  driver) and only where `glBlocker()` passes: the page's build has the
  renderer (`glUrl`, above) and the page's thread has `OffscreenCanvas` and
  `WebGL2RenderingContext`. Otherwise the box is unticked and disabled with
  the reason in its note (it follows the Distro radios as chosen), its
  saved value kept; a load that cannot have it boots without and says why
  in the Environment tab's Guest GL row (`cfg.glWhy`: a warning where the
  option was set, `cfg.glAsked`, information where it is the default,
  as on Alpine).
- With GL on the page appends `kw.gl=1` to the command line;
  `/etc/profile.d/kw-gl.sh` (the base's kw layer, kernel/guest.md) then
  exports `GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1` in every login
  and interactive shell (the console, terminal windows, `bash -l`) where
  there is no DRM render node (`?gpu=0`, or a kernel without kwvirtio), so
  a plain `eglinfo` or `glmark2-es2` uses virgl either way; with the
  device `GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1 cmd` runs one
  program on the vtest link. Mesa is not in the image:
  `sudo apt-get install` it (deb.debian.org goes through the page's
  CORS mirror). Programs `vm.exec()` starts without a shell do not get the
  variables.
- `showGl()` (boot.ts): the Guest GL row says "starting", then, once the
  forwarder is linked, "on, not loaded yet" (`vm.gl.status`) until the
  guest's first GL use, "loading" while it loads, then the WebGL2 renderer
  (the unmasked name, `WEBGL_debug_renderer_info`, as the SDK logs it) and
  how long the load took and when (`vm.gl.loaded`, `status.loadMs`), with
  the forwarder links and GL clients (`vm.gl.stats`, every 2 s
  while they change) in its note, and from the renderer's counters
  (`vm.gl.stats.renderer`) where a frame's time went in the renderer over
  the last 2 s with readbacks (`glFrameTimes()`: per readback, time parked
  in busy waits, reading back, issuing GL, uploading; how busy waits were
  answered; gl.md, Stats), and with the device its counters
  (`vm.gl.stats.gpu`, `gpuFrames()`: presents a second and parks over the
  last 2 s, then in all presents, commands, fenced commands parked and the
  time parked, readbacks, errors). `?glwait=strict` passes `gl: { strictWaits:
  true }` (busy waits answered as vtest does) for comparing frame times,
  and the note says so. A software renderer (SwiftShader,
  llvmpipe, WARP...) is a warning row and a toast. The browser console
  gets `[unkernel] guest GL: WebGL2 renderer ...`, the Kernel log the
  SDK's `[host] gl:` lines. No WebGL2 context before the boot is an
  "unavailable" row (information, or a warning and a toast where the
  option was set): the device is 2D and GL programs use llvmpipe. A
  renderer that fails at first use, or a `vm.gl.ready` that rejects
  otherwise (no forwarder in an older bundle), is a failed row and a
  toast, not fatal. A lost WebGL2 context (status "lost", or
  `stats.gpu.contextLost`) is a warning row "WebGL context lost": the GL
  programs that were running fail and must be restarted, the next one
  gets a new renderer, no reload (gl.md, Context loss); "loading" while
  that renderer is made, then the ready row again, whose note counts the
  losses and new renderers.
- A suspended session records GL with the device options (`gl` and `gpu`
  in `SessionDevices`; absent in older records: off), since its kernel's
  command line has `kw.gl=1` or not and its devices differ. It is matched
  with its own GL devices (`sessionDevicesFor()`) and resumed with them
  (`adoptSessionGl()`: `cfg.gl` and `cfg.gpu` become the session's for
  that boot, the row says "off: the resumed session was saved without
  it"), unless this load's URL names `?gl=` or `?gpu=` (then they must
  match) or the session had GL and this load cannot; a resume that fails
  boots fresh with this load's own (`dropSessionGl()`). So a session saved
  before GL was on by default resumes as it was, and a fresh boot uses the
  options. The renderer being loaded or not changes nothing in a session
  (gl.md, Loading on first use). The SDK refuses a snapshot while the
  device holds resources or 3D contexts that submitted commands (a running
  GL program or KMS client; gl.md, The DRM path), before the guest parks, and Suspend then says that a program is
  using the GPU and to quit it (`refusal()`, boot.ts; the same text in
  the auto-suspend and Pause notes). The renderer's state is not saved: a
  resume ends the guest's GL clients, and the forwarder relinks by itself
  (gl.md, unkernel).
- Trying it: `sudo apt-get install mesa-utils libegl-mesa0 libgles2` and
  `eglinfo -B -p gbm` (with the device; `-p surfaceless` either way: the
  GLES renderer must be `virgl (<the WebGL2 renderer>)`); KMS clients on
  the display: `sudo apt-get install kmscube glmark2-es2-drm`, each with a
  stdin that stays open (gl.md, The DRM path: `mkfifo /tmp/h; exec
  3<>/tmp/h; kmscube <&3`, `glmark2-es2-drm --visual-config
  red=8:green=8:blue=8:alpha=0 <&3`); X with glamor on the device: `sudo
  apt-get install xserver-xorg-core xserver-xorg-input-evdev
  libgl1-mesa-dri libglx-mesa0`, then the kw layer's
  `/etc/X11/kw-kms.conf` (kernel/guest.md), `sudo
  Xorg :0 -config kw-kms.conf -nolisten tcp &`, then `DISPLAY=:0
  glxgears`; after the page resized, `xrandr; xrandr --output Virtual-1
  --auto` (x11-xserver-utils; X hears no hotplug without udev; the X +
  glamor tile's start.sh follows by itself: gl.md, Display size). Without the device (`?gpu=0`) X runs on kwfb (kernel/guest.md,
  X.Org on the framebuffer: `xserver-xorg-video-fbdev`, `sudo Xorg :0
  -nolisten tcp &`) and GL clients on it go through the vtest link,
  reading each frame back; for frame rates without the display,
  `sudo apt-get install xvfb xauth glmark2-es2-x11` and `xvfb-run -a -s
  "-screen 0 640x480x24" glmark2-es2`. Installed packages live in Debian's
  upper layer on the data disk (data-disk.md).
- Checked 2026-11-21 with `test/gl/page-check.mjs --suspend` (testing.md):
  the dev server, headless Chromium (Playwright's) on SwiftShader, the
  default URL (GL on by default, no request for the renderer until the
  first GL program; suspend and resume before GL use; Suspend refused
  while kmscube runs; a session saved with `?gl=0` resumed with GL off),
  worker mode, one CPU, `?data=0`, the device (gl.md, The page); and with
  the default CPU count (`--cpus 0`: 4 CPUs here), eglinfo and kmscube on
  the device. Not checked: X on
  kwfb with virgl (`?gpu=0`; a picture on the page's display, its frame
  rate), packages kept across reloads on the
  data disk, the built server's
  `/assets/virgl-*/` files in a browser.

## Wayland desktop

Wayland apps in the guest show as windows on the page, through
[wland](https://github.com/pithings/wland) (npm `wland`, pinned exactly
in `web/package.json`; `src/wayland.ts`, `components/Desktop.tsx`): its
compositor (wasm) runs on the page's thread, its relay in the guest. The
page boots with `createKernel({ shm: true })` (kwshm; js.md, shm) and
`kw.wayland=1` on the command line (with kwshm only, as `kw.gl=1` with
GL; a resume keeps the saved kernel's command line) and, once the kernel
runs, listens on vsock port 1023 (`WAYLAND_PORT`). Wayland is always
there in a Debian guest (its image carries the relay, kernel/guest.md;
Alpine and the base shell have none, so nothing starts and `wland` says
why; with a relay that has `--link-on-demand`: wland after the pinned
release, below): with `kw.wayland=1` the kw layer's rc starts the relay
`/usr/lib/kw/wlandr --link vsock:2:1023 --buffers kwshm --link-on-demand`
for the image's user (with `--dmabuf virtgpu:/dev/dri/renderD128
--no-fence-wait` where guest GL's render node is: GL apps, below), which
binds `/run/user/UID/wayland-0` and dials the page only when an app
connects, and every login and interactive shell has the variables that
make toolkits pick Wayland (`WAYLAND_DISPLAY`, `XDG_SESSION_TYPE=wayland`
and the rest; Debian's chromium gets `--ozone-platform=wayland`), so
`foot` started plainly maps a window (kernel/guest.md, the kw layer).
`wland CMD` (`/usr/lib/kw/bin/wland`) still works: it starts a relay
where none runs (killed, or a relay without `--link-on-demand`, which
the boot leaves out: it would dial at once and load wland at every page
boot) and runs CMD in the session. The relay tells its features with
`wlandr --version` (a `features:` line; a relay without it, the pinned
release, is read from `--help`). The apps' buffers stay in guest memory: the
relay exports each through `/dev/kwshm` and the compositor reads it in
place wherever `ShmFile.inPlace` (inline, and worker mode on several CPUs:
the SMP kernel's memory is shared with the page, js.md, shm): wland takes
the export's page runs (its `view`: `ShmFile.views()`, no copy of ours; a
single run is presented as it is, several have the damaged spans
gathered). Else (one CPU in worker mode) every damaged span of a commit
goes in one `readv`, a `ShmFile.read()` each, posted together through the
shared transport's ring and served at the kernel's next clock read (about
0.6 ms), and with `?shared=0` (or no cross-origin isolation) as messages
answered at the kernel's next yield.

- Loaded on first use: the relay's first connection (at the first app)
  imports wland (its own chunk) and `wland.wasm` (passed by URL:
  `wland/wland.wasm?url`, since the dev server's dep optimizer breaks the
  package's own `import.meta.url` lookup); a page that never runs a
  Wayland app fetches neither. The relay's next connection after a drop
  goes to the same wland (a fresh compositor; the apps of the old link are
  gone). The relay counts a completed connect as the compositor attached
  and the SDK's listener completes every connect, so the page takes a
  connection only where wland serves it: one at a time (a second
  relay's is reset, its apps fail at once instead of waiting), none once
  wland failed to load (the listener closes, so dials are refused), and
  one that went away before wland took it (a dial that timed out while
  wland loaded) is skipped. After the last window the link stays up and
  wland loaded: closing it frees only the compositor's state (the module
  stays) and races an app connecting meanwhile.
- Costs when unused (2026-11-22): the relay's RSS 904 to 908 KiB, its
  start at boot about 35 ms of guest time (`wland --boot` 0.11 s against
  0.08 s for `sudo true`, Node CLI; whole boots to a prompt 1.05 s
  without, 1.09 s with the flag, within the noise), nothing fetched and no
  compositor until the first app (`page-check.mjs`, "idle before an
  app"). Plain foot maps 1.1 to 1.2 s after its start in a fresh page,
  wland's chunks and wasm fetched 0.3 s after it.
- Failure: outside the page (the Node CLI, which never adds the flag) no
  relay starts and shells get no session: `foot` fails at once as on any
  machine without a compositor (`failed to connect to wayland`). Where
  the relay runs but nothing takes its dial (the CLI with `--shm` and
  `wland`, an app before the page listens) the app fails within 0.3 s:
  the host refuses the connect, the relay closes the waiting app and logs
  `wayland client refused: no engine on link vsock:2:1023
  (ConnectionRefused)`; foot prints `no compositor` and `failed to flush
  wayland socket` (exit 230), and `wland CMD` adds that the page did not
  take the link.
- The view: a layer over the stage (`#wl-layer`, z-11, over the display,
  under the preview) with wland's container `#wl-desktop`, the stage's
  size (the output size the apps get), always mounted and only hidden
  (`invisible`, `inert`). The store's `desktop` state: `attached` while
  the relay is connected, which shows the status line's desktop icon
  (`#bar-desktop`, overlapping windows, its tooltip lists the windows);
  `shown` when the first window maps and hidden when the last one goes,
  or by hand: the icon, Ctrl-A w (`toggleDesktop()`); picking a terminal
  window or the display hides it. wland does its own input: a click
  focuses a window, whose keys go to wland's hidden editable sink, which
  display.ts and the terminals leave alone (display.ts takes no keys while
  the desktop is shown); the page's shortcuts (Ctrl-A) still come first,
  and Ctrl-A Ctrl-A sends Ctrl-A on to the app. Hiding the desktop gives
  the terminal the keyboard if a window had it (not on touch devices);
  showing it gives the top window the keyboard once the layer has rendered
  (`focusDesktop()` from Desktop.tsx: an inert layer takes no focus).
  Windows have the apps' own title bars (wland draws no decorations);
  wland's window manager: Alt+drag moves, Alt+F9/F10/F11 minimize,
  maximize, fullscreen (to the desktop's size, which follows the stage:
  wland's output follows its container's size, so `wl.output` is not
  used).
  The clipboard works between the apps (wl-copy, foot, GTK), and wland's
  bridge (its `clipboard` option, left on) joins it to the page's for
  plain text: a paste chord in the desktop (Ctrl+V, Ctrl+Shift+V,
  Shift+Insert) gives the focused app the page clipboard's text (from the
  browser's paste event), and an app's copy is written to the page
  clipboard around a click or key in the desktop. On because it asks for
  no permission: it reads the page clipboard only from a paste event (or
  on focus where clipboard-read was granted already) and writes only
  around a gesture, so no browser prompts; a relay without the bridge
  (0.1.0) turns it off for its link.
- Sessions: kwshm is a device of the snapshot, so a session records it
  (`SessionDevices.shm`; absent in older ones: off) and resumes with its
  own (`adoptSessionGl()`); a fresh boot has it unless `?shm=0` (this
  load only, config.ts), which boots without it as the page did before
  the desktop. Without kwshm the page does not listen, the foot tile is
  dimmed with why, and `wland` says there is no `/dev/kwshm`; no
  `kw.wayland=1`, so no relay at boot. A resume resets vsock: the
  relay's apps of the old link are gone and it dials again at the next
  app (`link ... closed; dialing again for the next app`); the resumed
  page fetches nothing of wland until then. A session saved before the
  relay started at boot resumes as it was (its relay, started by `wland`,
  dials at once and the page loads wland).
- **GL apps by GPU resource** (`gpuSource()`): with guest GL's virtio-gpu
  device (gl.md, The DRM path) the relay starts with
  `--dmabuf virtgpu:/dev/dri/renderD128` where that node exists and the
  relay has the mode (`dmabuf:virtgpu` in `--version`, else its `--help`;
  0.1.0 has not), with `--no-fence-wait` where it has that, and the page gives
  wland a `gpu` source where `vm.gl.gpu` exists (the `gl` and `gpu`
  options, WebGL2), unless `?wlgpu=0` (this load only, config.ts). wland
  then offers linux-dmabuf v4 (AR24, XR24, AB24, XB24, each with the
  implicit modifier and LINEAR), the relay names each GL client buffer by
  its virtio-gpu resource, and `resolve()` is `vm.gl.gpu.image(resource,
  { width, height, opaque: XR24 or XB24, flipY: y_invert })`: an
  ImageBitmap blitted in the renderer's WebGL2 context, no readback (a
  promise only while the renderer loads; a buffer at a plane offset gives
  null, logged once), which wland draws into the window's canvas and
  `release` closes. After a lost WebGL2 context `image()` gives null for
  the buffers of the GL clients that ran then (restart them); the relay's
  own context never submitted, so the new renderer makes it again, and GL
  clients started after the loss show (gl.md, Context loss). Without the source wland leaves linux-dmabuf out, also
  in front of a relay with `--dmabuf`, and GL apps render in software
  (llvmpipe) into wl_shm buffers like any app: GL off (no render node, no
  flag), `?gpu=0` (the vtest link: with `GALLIUM_DRIVER=virpipe
  LIBGL_ALWAYS_SOFTWARE=1` Mesa's software winsys shows virpipe's frames
  in wl_shm buffers), a 2D device (no WebGL2 at boot: the node and the
  flag are there, the source is not), `?wlgpu=0`. A relay started without
  the flag (a session resumed from a boot without the node) keeps GL apps
  in software; `wland` says so and that `pkill -x wlandr` (which ends its
  apps) lets the next `wland` start one with it.
- Ordering: in both modes a GL client's SUBMIT_3D reaches the renderer
  before the relay's commit naming its buffer reaches wland (in worker
  mode virtio-gpu requests and vsock packets share the worker's one
  message channel to the page, which runs a submit as it arrives), so the
  blit sees the frame. So the relay runs with `--no-fence-wait` where it
  has it; a relay without (the pinned release) waits up to 100 ms per
  commit for the dmabuf's write fence (signalled once the device answered
  the submit), which only adds latency, and logs `still being written
  after 100 ms` once per connection at GTK 4's first frame (shader
  compiles on SwiftShader); the window is right either way. An on-demand
  relay started without its render node warns (`linux-dmabuf off for
  now`) and looks the node up again at each dial (page-check `--gpu`).
- What Mesa picks (Debian 13, Mesa 25.0.7; 2026-11-22): EGL's Wayland
  platform on the `virtio_gpu` DRI driver, window configs in B8G8R8A8 and
  B8G8R8X8 only (no R8G8B8A8 one), so ARGB8888 with alpha and XRGB8888
  without, always with the LINEAR modifier (0), never y_invert, plane
  offset 0, stride width x 4. GTK 4.18 draws with GskGLRenderer (no Vulkan
  driver installed), which needed renderer patch 14 (gl.md, Patches).
- One wland release on both sides: the npm version in `web/package.json`
  and the relay's `WLANDR_VERSION` (guest/distro/debian/pins.sh) change
  together (the link protocol is theirs). The relay comes with the Debian
  image, so it matches the page only where the image is the same
  release's (the page's own images are); nothing checks the link's
  version, and `wland` reads only the relay's features for its own flags. The page needs wland 0.1.0-261122 or
  later (the `gpu` source, `view`, `readv`, the clipboard bridge); with
  the first 0.1.0 package it still runs, wland ignoring what it does not
  know (a read per span, no GL windows by resource, no bridge). The
  relay asset is `wlandr-link-linux-arm64.tar.gz` (the `--link`-only
  build, its entry `wlandr`). The relay at boot needs `--link-on-demand`
  (and `--version`, `--no-fence-wait`), and Firefox's input the core that
  sends seat events to every pointer and keyboard of a client: both in
  wland 0.1.0-261122-632f589, the pin. With an older relay the boot
  starts none and shells get no session (plain apps fail as outside the
  page; `wland CMD` works as before). A new release: `WLANDR_VERSION` and
  `WLANDR_SHA256` in pins.sh and the npm version in `web/package.json`
  (and the lockfile), then `kernel/build.sh distro debian`
  without `KW_WLANDR`. To try a local wland build:
  `KW_WLANDR=<wland>/zig-out/release/wlandr-link-linux-arm64 kernel/build.sh
  distro debian` (guest/distro/debian/build.sh; refused with
  `KW_RELEASE=1`), and for the
  page a build against that checkout's package: copy its `package.json`,
  `LICENSE`, `README.md` and `dist/` to a directory of their own, then
  `KW_WLAND_PKG=<dir> node node_modules/vite/bin/vite.js build` in `web/`
  (`unkernel:wland-pkg` in vite.config.ts resolves `wland` and its
  subpaths through that package's exports; build only) writes
  `web/.wland-local/output/`, and `node test/wland/page-check.mjs --output
  web/.wland-local/output` (any case) or `PORT=<port> node
  web/.wland-local/output/server/index.mjs` runs it. It leaves
  `web/node_modules` (Nitro's `last-build.json` is put back), `web/.output`
  and a running dev server alone: never replace `web/node_modules/wland`,
  a pnpm store link (a swapped package broke a running dev server's page).
- The launcher's foot demo (`demos/foot.ts`, Debian: foot,
  fonts-dejavu-core, fontconfig; `needs.wayland`: dimmed without the
  desktop) runs plain `foot` (the session is in every shell, the relay
  runs from boot); its README suggests wl-clipboard, wayland-info and a
  GTK 3 app (l3afpad). The GL windows
  demo (`demos/wlgl.ts`, Debian: mesa-utils; `needs.wayland`) runs `wland
  es2gears_wayland` after `eglinfo -B -p wayland`; its README suggests
  glmark2-es2-wayland and gtk4-widget-factory (GTK 4).
- `KW.wayland`: `windows()` (title, focused, maximized, fullscreen,
  minimized), `container()`, `loaded()`, `popups()` (mapped now) and
  `popupKeys()`, `stats()` (buffer handles opened; reads, how many in
  place and of those views, bytes, the reads' total and longest time;
  commits; GPU commits, images, waits for the renderer, image()'s total
  and longest time, and resolve to release, which includes wland's draw),
  `gpuLast()` (the last GPU buffer a commit named), `log()` (wland's
  last 500 wire-level lines: the apps' decoded requests), `wland()`
  (wland itself, for debugging).
- Frame pacing (2026-11-22, `page-check.mjs --built --pacing`, headless
  Chromium at 61 rAF/s, worker mode): weston-simple-shm (250x250, redraws
  everything) 60 commits/s on 1 CPU (readv through the ring, 0.25 ms) and
  on 4 (in place, 0.01 ms); inline 60 (0.01 ms). foot under `yes` output
  (696x468, 116x36 cells of DejaVu Sans Mono 8 pt) redraws its whole
  window each commit (1272 KiB: more than a screenful arrives between
  frames, so every row is dirty): 13.5 to 14.8 commits/s on 1 CPU (reads
  0.9 ms, 1% of the time; 12.0 to 12.5 while the page's vsock packets
  went as messages, below), 19 on 4, 11 to 15 inline (repeated runs).
  Where a frame goes (2026-11-22, one CPU, worker mode, timestamps at
  each hop: the packets in the worker's VsockDevice and the page's
  VsockHost, wland's commit event, rAF, and foot's `WAYLAND_DEBUG` and an
  LD_PRELOAD shim on its reads, the guest's clock aligned to the page's
  within about 2 ms): foot's commit to the relay's packet leaving the
  guest 1 to 3 ms, to the page 0.1 to 0.2 ms (posted at the kernel's next
  task switch), to wland's commit event 1.5 ms (the readv), to the frame
  callback at the next rAF 0 to 16 ms (8 on average: wland answers at the
  first rAF after it presents, as it should), into the guest 0.2 ms (the
  shared transport's vsock ring; as messages 0.6 to 20 ms, 12 on average,
  waiting for the kernel's yield), the guest takes it within 0.3 ms; then
  about 25 ms until foot reads its Wayland socket and 30 to 40 ms to its
  next commit. That last part is foot: between commits it reads the pty
  in 4 KiB pieces, each parsed in about 1.4 ms here, up to ten per pass of
  its event loop, and handles the Wayland socket after them, so the frame
  callback waits one or two such passes (`nice -n 19 foot` changes
  nothing). weston-simple-shm next to a `yes > /dev/null` keeps 60
  commits/s (49 while the packets went as messages). Inline the page runs
  only at the kernel's 20 ms yields (about 48 rAF/s under foot's load),
  and the packets need no crossing. The page's counters are every
  window's: the pacing check fails while another window is open (60 to 75
  commits/s at about 430 KiB measured once for foot were 13 of foot's
  plus about 47 of a weston-simple-shm that the cleanup had missed;
  both together give 61 at 429 KiB). With `?shared=0` each read is a
  message that waits for the kernel's next yield, as are the vsock
  packets: a read about 11 ms under foot's load, foot 10 commits/s
  instead of 13.5 to 14.8; weston-simple-shm keeps 60
  (0.22 ms: the idle kernel yields soon). wland processes nothing else
  while a read is pending (a synchronous read never leaves one pending).
  Not taken: the engine in
  the kernel's worker, an early yield on request (a kernel change), the
  SMP kernel on one CPU (js.md, Worker mode).
- wland issues: the two seen with 0.1.0 and reported upstream are fixed in
  the release after it (checked with the local build, 2026-11-22): a GTK
  window's popups (l3afpad's context menu) open at the pointer (the menu
  1 px right of and below the click; it was about 20 px up and left), and
  a quick click on foot's resize border (its request comes after the
  release) no longer starts a resize that follows the pointer (a drag on
  the border resizes by the drag, foot rounding to whole cells).
- Not wland's: l3afpad (GTK 3) ignored a right click in its text about
  every other time (2026-11-22: 6 of 12 and 4 of 6 attempts, its menu
  never came) when the left click before it had its press and release
  sent back to back, as the DevTools protocol does: both reach the app in
  one read, and l3afpad's own `button-press-event` handler (`view.c`,
  `cb_button_press_event`) calls `gtk_clipboard_wait_for_text(PRIMARY)`,
  a nested main loop, which dispatches the release before GtkTextView's
  gestures have seen the press (traced with an LD_PRELOAD shim on GTK's
  calls into GLib and GDK). Those gestures stay pressed, and the next
  right press goes to cancelling them instead of the context menu. With
  the button held 60 ms, as a hand does, 14 of 14 menus opened, and 10 of
  10 with clicks held 80 ms while `yes` kept the guest's CPU busy, so
  people do not meet it unless the app is too busy to read the press
  before the release arrives. page-check's clicks hold the button 60 ms
  (`holdMs`). The strip GTK redraws at the window's right edge after the
  pointer moves is its overlay scrollbar fading in and out (about a
  second).
- Checked 2026-11-22 with `test/wland/page-check.mjs` (testing.md): the
  dev server and the built page, headless Chromium (Playwright's) on
  SwiftShader (wland's 2D path: it uses WebGL only on hardware), the
  prepared disk imported into the fresh profile's data disk, worker mode
  on 1 CPU and on 4, and inline: nothing of wland fetched before the tile
  (its chunk nor its wasm), foot's window mapped about 1 s after the click
  (33 s from a fresh Debian, apt over the page's network), its pixels on
  the page, typed keys reached its shell and not the terminal, `exit`
  closed it and hid the desktop, the relay ran on, a second `wland` reused
  it, a killed relay was replaced by the next `wland foot`; two foot
  windows (focus by click, keys to the focused one, closing one gives the
  other the keyboard), Alt+F10 and the page resized while maximized,
  Alt+drag, the clipboard from wl-copy to foot and from foot to wl-paste;
  l3afpad (GTK 3): typing, its context menu (a popup) and Escape, Ctrl-A
  Ctrl-A then Ctrl+C to wl-paste; foot's keys (Ctrl-C, Up, Left, Alt+.,
  Ctrl-U, auto-repeat: 24 x for a 1.13 s hold, Ctrl-A Ctrl-A), Ctrl-A w
  both ways and the status line's window, with the focus following;
  Suspend with foot open (worker mode) and a plain load resumed, the relay
  reconnected, a new foot mapped; a session saved with `?shm=0` resumed
  without kwshm and the next boot had it. Again with wland's release
  after 0.1.0 (the local build, `--built`, worker mode on 1 CPU and
  inline): all of that, plus the bridge to the page's clipboard both ways,
  the two fixes above and edge resizing by drag; and `--gpu` (worker mode
  on 1 CPU and inline; on 4 CPUs the pacing run): the relay
  with `--dmabuf virtgpu`, linux-dmabuf v4 offered, the renderer loaded on
  the first GL frame (not before), weston-simple-egl by resource (no shm
  reads) with its translucent background kept (alpha 128) and the right
  way up, `-o` opaque, a stopped client's window equal pixel for pixel to
  its last resource's picture taken afresh, foot and a GL window updating
  together, gtk4-widget-factory (GskGLRenderer) with no renderer errors,
  a relay without `--dmabuf` (wland's note; GL apps in shm windows),
  the GL windows tile (es2gears by resource), Suspend refused while
  es2gears ran and done after, es2gears by resource
  after the resume, `?wlgpu=0` (linux-dmabuf not offered although the
  relay has `--dmabuf`; llvmpipe frames in shm windows) and `?gpu=0`
  (virpipe frames over the vtest link in shm windows). Not checked: real
  GPUs (wland's WebGL path; the GPU path's cost there), Safari,
  phones (touch, the on-screen keyboard), the guest display under the
  desktop.
- Firefox (Debian's firefox-esr 153, 2026-11-22, headless Chromium,
  worker mode on 4 CPUs, `debian-disk.mjs --firefox`): WebRender on
  virgl, its window by GPU resource (ARGB8888, one buffer reused, as wland
  releases it after the image), renders a page since renderer patch 15
  (gl.md, Patches; before, the window stayed fully transparent and the
  guest's kernel flooded with failed transfers). 512
  MiB is too little: the guest thrashes (about 20 MiB left, half the CPU
  time in I/O wait) and the first page takes minutes; with 2 GiB (the
  page's default on desktops) its window maps in about 45 to 65 s (a new
  profile; 24 s for the next start in the same boot). Its input
  needs wland 0.1.0-261122-632f589 (the pin); before it Firefox took none,
  on the GPU path and in software alike: wland
  0.1.0-261122-f36330a kept one wl_pointer and one wl_keyboard per client (the
  last made; `pointer_id`, `keyboard_id` in its compositor.zig), while
  Firefox binds wl_seat twice (GTK's at v5, then its own at v8 for serials
  and pointer constraints), so the events go to Firefox's own objects and
  GTK's get none (seen with WAYLAND_DEBUG: `wl_pointer#36.button`,
  `wl_keyboard#37.key`, nothing for GTK's `wl_pointer#8`,
  `wl_keyboard#19`). wland now sends each seat event
  to every pointer, keyboard, relative pointer and data and
  primary-selection device of a client (WAYLAND_DEBUG: `wl_pointer#8` and
  `#36` both get the motion, button and frame, one enter serial for
  both), and Firefox takes
  clicks, typing, Ctrl+L and a typed URL, its context menu (a click on an
  item, Escape), the wheel, a drag selection (the primary selection) and
  Ctrl+C and Ctrl+V with wl-copy and wl-paste, on the GPU path and with
  `?wlgpu=0` (`page-check.mjs --firefox`). Ctrl+A is the page's prefix
  there as everywhere (Ctrl-A Ctrl-A sends it on). Guest memory with
  Firefox on a page: 730 MiB used of 1978, its processes' RSS 1.4 GiB
  (shared pages counted in each).
- Chromium (Debian's chromium 156, 2026-11-22, headless Chromium on
  SwiftShader, worker mode on 4 CPUs, 2 GiB): renders on the GPU path,
  its window by GPU resource (ABGR8888), with two conditions. Mesa's EGL
  must be installed: the package's recommends bring the DRI driver, GBM
  and GLX but not `libegl1` and `libegl-mesa0`, which its ANGLE loads
  as `libEGL.so.1` (without them the GPU process cannot start;
  `/etc/chromium.d/kw-wayland` then prints the apt-get line where the
  render node is; `libgles2` is not needed). And the renderer needs
  multisampling (gl.md, patch 17): Chromium's ANGLE (its GL backend on
  the native EGL, `gl=egl-angle,angle=opengl`) offers OpenGL ES 3.0 only
  where each required colour and depth format takes 4 samples, and
  Chromium 156 asks for ES 3.0 and nothing less. Before the patch the
  guest's Mesa offered no multisampling on any WebGL2 host (WebGL2 has
  no multisample textures, the GPU or SwiftShader alike), so its GPU
  process logged `eglCreateContext: Requested version is not supported`
  (ANGLE's EGL refusing ES 3.0 on its ES 2.0 cap, not Mesa: virgl's
  context is ES 3.0) and `ES version fallback is disabled`, exited three
  times, and Chromium composited in software into wl_shm buffers
  (chrome://gpu all "Software only" or "Disabled", WebGL too; seen the
  same on an M4 Pro with ANGLE Metal). Now chrome://gpu has Compositing,
  Rasterization, Canvas and WebGL hardware accelerated, `GL_RENDERER
  ANGLE (Mesa, virgl (ANGLE (...)), OpenGL ES 3.0 Mesa 25.0.7)`, GL_VERSION
  OpenGL ES 3.0 (one more `Requested version is not supported` is a
  context of a higher version, WebGPU's, which stays unusable). Measured
  (one run each, a fresh profile once started before): a CSS animation
  (a 200x200 gradient moving and turning) 54 rAF/s and 51 to 53 commits/s
  by resource against 45 to 49 rAF/s and 44 to 47 commits/s with
  `--disable-gpu` (3084 KiB a commit read in place); a WebGL2 page
  (antialias, 4 samples) 54 rAF/s by resource, while with `--disable-gpu`
  (as before the patch) Chromium has no WebGL; the window maps 10 to 14
  s after the start either way (9.1 to 9.3 s with `--disable-gpu`). No
  flag is needed or set by default (`page-check.mjs --chromium` checks
  the GPU path). Not measured on a GPU.
- GL frame rates (2026-11-22, `page-check.mjs --built --gpu --pacing`,
  headless Chromium on SwiftShader, so a floor; 61 rAF/s; worker mode;
  weston-simple-egl -o, which redraws everything each frame; one run
  each):

  | weston-simple-egl -o | 1 CPU | 4 CPUs |
  | --- | --- | --- |
  | by resource, 250x250 | 60.0 commits/s, 0.15 ms | 60.0, 0.35 ms |
  | by resource, maximized (1280x772) | 55.6, 0.17 ms | 56.1, 0.18 ms |
  | software (`?wlgpu=0`), 250x250 | 59.9, reads 0.44 ms | 60.0, in place 0.01 ms |
  | software (`?wlgpu=0`), maximized | 13.9, reads 1.33 ms (1938 KiB) | 30.7, in place 0.01 ms |

  By resource the page's cost per commit is resolve to release (image()'s
  blit and wland's drawImage of it, as issued: their GPU work runs later
  in Chromium's GPU process and is not counted); image() alone 0.07 to
  0.16 ms. In software the
  guest renders with llvmpipe and the page reads the buffer. glmark2-es2-
  wayland (800x600 windowed, by resource, 1 CPU): build 110, texture 125,
  phong 103 FPS (it swaps without waiting for frame callbacks, and every
  frame is an image).

## Several CPUs

The CPUs option (System tab, Options, the `#opt-cpus` slider; `?cpus=N`,
config.ts) boots the SMP kernel on N CPUs (kernel/smp.md; js.md, CPU
threads). Default in worker mode where the page can boot the SMP
kernel: the suggested count (`cfg.cpuDefault`); else 1, the UP kernel.
`?cpus=1` is the UP kernel (the same files and code paths as before
the option). The Worker thread and CPUs options are saved only
where they differ from these defaults. It applies on Reboot, like the
other options.

- Choices: 1, 2, 4, 8 and 16 up to `navigator.hardwareConcurrency`, and
  that count itself (the kernel's limit is 16, `NR_CPUS`), plus the suggested count,
  hardwareConcurrency / 2 up to `SUGGESTED_CPUS` (4 on desktops, 2 in
  Firefox, none on phones until measured; config.ts, with the
  /profile.html numbers behind it), marked
  "(suggested)" (none below 4 threads, and none in WebKit: Safari 27.2 ran
  parallel work slower on every added CPU, 2026-11-19; `webkitEngine()`).
  A count past the suggestion (past one where there is none) is there to
  try: selected, the slider, its value and its note turn red (`Stop.warn`).
  Half the host's threads stay free for the page, the browser and other
  tabs: a guest CPU whose thread the host deschedules stalls the CPUs
  that wait for it (status.md, SMP, under host load). A larger `?cpus=` is
  capped at the thread count.
- `smpBlocker()` (config.ts) disables the slider, with the
  reason under it (`#opt-cpus-note`) and in the Environment tab's
  "Guest CPUs" row: no SMP kernel in the page's bundle (`kernelSmpUrl`
  null: a bundle without the SMP patch), no cross-origin isolation (a plain-http
  LAN page), no Web Workers or no `Atomics.waitAsync`
  (`webCpuBlocker({ worker: true })`), or one host thread. Such a load
  with `?cpus=N` boots on one CPU as usual and says why.
- With several CPUs, boot.ts loads `kernelSmpUrl` instead of `kernelUrl`
  (streaming compile; the UP bundle is not fetched) and boots in worker
  mode (`cfg.worker` is set, not `?worker=1`; Options shows the Worker
  thread box ticked and disabled, keeping its own value for one CPU), with
  `cpus`; the kernel worker starts the other CPUs as nested Web Workers.
  The download starts only after the suspended session was offered
  (below), since the answer picks the kernel. The SMP bundle is a hashed
  `/assets/` file like the UP one: the service worker (scope `/vm/`) never
  sees it, and the HTTP cache keeps each file on its own.
- `/profile.html` (testing.md, Profiling CPUs and worker mode) measures
  the configurations the defaults choose between; `SUGGESTED_CPUS`
  carries the numbers it is based on.
- Falling back: a failed SMP download or compile, or a `createKernel()`
  that rejects (the worker, its JSPI, the shared memory), calls
  `bootUpOnce()`: it stores the reason in sessionStorage `kw-up-once` and
  reloads; that load boots on one CPU the usual way (in worker mode
  where that is the default) and shows the reason (`cfg.smpWhy`: the Guest CPUs row,
  the CPUs note, diagnostics). The saved CPUs setting stays, so the next
  load tries again. If sessionStorage refuses, the failure is reported
  instead (no reload loop). A kernel worker that cannot start CPU threads
  (`webCpuBlocker()` there) runs the SMP kernel on one CPU: the Guest
  CPUs row warns, from `stats().cpus`. A failure after the kernel started
  (a CPU's trap or fatal error) ends the session like any other, with a
  hint to set CPUs to 1.
- The console with several CPUs: every CPU's output comes through the
  console ring the page itself reads (js.md, CPU threads), not through
  the kernel worker, so the terminal gets a few hundred chunks for
  `seq 1 200000` instead of one message per write, and output from a task
  on CPU 1 is not held up while CPU 0 runs user code. Headless Chromium,
  `?cpus=2` (2026-11-17, before, then after): `seq 1 200000` on CPU 1
  37.7-38.4 s and 2.8 s (CPU 0: 2.3-2.5 s); echo of a shell on CPU 1
  while CPU 0 spins, median 9.4 and 0.57 ms; lines printed in turn on
  CPUs 0 and 1 in order either way; the default load unchanged.
- Suspend works with several CPUs (Suspend and resume, below). The
  session records its CPU count (none in sessions saved before: one), and
  resumes only on as many, with the kernel for that count. A load whose
  count differs offers it before the download (`offerResumeCpus()`):
  "Resume on N CPUs" reloads once on N (sessionStorage `kw-cpus-once`,
  config.ts `resumeCpus`; for one CPU `bootUpOnce()`, both with
  `kw-resume`) and resumes it; "Boot on M CPUs" boots this load's count
  and, when the session has a data disk, deletes it (that boot changes the
  disk), else keeps it. Where the page cannot start N CPUs now
  (`smpBlocker()`, this tab's fallback to one CPU, fewer host threads) it
  is not offered: with a data disk the page asks first ("Boot on M CPUs",
  which deletes it, or "Keep it", which stops without booting,
  `keepSession()`), without one it boots M with a warning and keeps it. A
  resume whose CPUs do not start (`createKernel()` rejects, other than for
  a disk or device) keeps the session and reloads on one CPU
  (`bootUpOnce()`), which then asks as above; a resumed SMP session is
  deleted only once user space answers an `exec()` (its tasks resume only
  after every CPU is back, so until then a CPU that fails leaves the disk
  as saved). The SMP kernel on fewer CPUs than asked (the worker could
  not start their threads) refuses Suspend: no load boots that again.
- The boot summary says "on N CPUs"; diagnostics' config
  line has `cpus=`.
- Checked in headless Chromium (Playwright's build, the built page from
  the l2 patch bundle, 2026-11-17, a scratch script, not in `web/test/`):
  the default load fetched only the UP bundle and ran on one CPU; `?cpus=2`
  and `?cpus=4` fetched only the SMP bundle, `nproc` gave 2 and 4, a
  terminal window, glimmer's test pattern, key and sound through worker
  mode worked, the JIT compiled on every CPU, and n parallel awk loops
  took 1.14x (2 CPUs) and 1.20x (4) the time of one; a plain-http LAN
  load disabled the option and booted on one CPU; a blocked SMP download
  reloaded on one CPU; a UP session resumed from a `?cpus=2` load ("Resume
  on 1 CPU") and was deleted by "Boot on 2 CPUs"; a page from the newest
  release (no patch) showed the option disabled and booted UP. Also the
  Vite dev server (nested worker from source).
- Checked by hand on a deployed build (2026-11-17): several CPUs work in
  desktop Chrome, in Firefox and on iOS. Desktop Safari and Android: not
  tried.

## Suspend and resume

Suspend (Ctrl-A z, `z` in the dialog, the dialog footer's `#suspend`, the
status line's pause icon `#bar-suspend` while the system runs, or
`KW.suspend()`; `ui.suspend()`, no question: the machine stops only once its
session is stored, and Resume brings it back) saves the running machine with the SDK's
`snapshot({ commit })` (js.md, Snapshots), inline or in worker mode: the
kernel waits at its snapshot point while the page writes the session, and
stops only once that transaction committed. A write that fails, or that
takes longer than 20 s of awake time (`SUSPEND_COMMIT_MS` in boot.ts; a
page frozen meanwhile does not use it up), leaves the machine running and
the saved session as it was (`SuspendSaveError`, autosuspend.ts: "the
session was not saved (why); the system runs on"); a record written but
given up after all (the timeout came first) is deleted. The page then shows "Suspended" (an `[  OK  ]` line, not a red
notice; the "Suspending…" toast goes), the store's `suspended` is set,
and a Resume card (`#resume-card` with `#resume`, Overlays.tsx: "The system
is saved in this browser (N MiB).") sits in the middle of the stage, over
whatever window is shown there (App.tsx renders it above the display and
the preview), which shows dimmed behind it (the dim takes no clicks), with
a play icon `#bar-resume` in the status line. Resume takes the focus when
the card appears (not from a field or dialog the user is in), so Enter or
Space resumes; toasts keep their corner, below it. Resume (`ui.resume()`)
sets sessionStorage `kw-resume` and reloads the same URL; the load reads it
once and resumes. A plain load resumes a session it can resume as it is too,
without a question. Every resume of a saved session (the Resume button, a
plain load, a suspend in the background, the reload on the session's CPU
count) is quiet (below) and ends in the same informational toast, "Resumed
the session suspended …" (`sayResumed()` in boot.ts, 5 s,
`RESUMED_TOAST_MS`; a hidden tab gets it once shown); a machine that goes
on in place (a hold in the background ended, Continue) never stopped and
shows nothing. Reboot sets
`kw-resume` to `fresh` and first deletes any record of the running machine
still saved (held, the resumed one, one a given-up save left;
`KW.beforeReboot`); the load after it boots fresh and, for a session it
could resume (one kept from before), keeps it without a data disk (the next
plain load resumes it) and asks with one (Resume, or Boot fresh, which
deletes it: the fresh boot changes the disk; autosuspend.ts
`resumeChoice()`). So Reboot never leads to the same session again.

- `session.ts` keeps one session in IndexedDB `kwsnap:session-v2`, its own
  database (the first open on a page deletes `kwsnap:session-v1` and any
  other older version, unawaited): `meta` (time, the page's kernel URL, UP
  or SMP, the CPU count, the banner, the device
  options, the disks' snapshot state, the console's last 64 KiB, the
  preview panel, the terminal windows 1-9 whose sessions the snapshot lists
  (number, name, session id) and the window shown) and `bytes` (the `encodeSnapshot()` Blob, made before the
  transaction opens), written in one transaction with strict durability
  (where the engine has it), which a given-up commit aborts. It never opens
  `kwdisk:kwdata-v1`.
- Resumed only when the CPU count (another: Several CPUs, above), the
  kernel URL (a hashed asset: another release cannot
  resume), the distro image's URL (`meta.distro`; a build's names its
  content, so another build of the same distro cannot resume) and the device
  options (Display, Sound, Network, Data disk) are
  as saved, and inline when `snapshotDiskMismatch()` passes on the opened
  data disk. A disk that changed makes the session useless, so it is
  deleted then. In worker mode the worker checks the disk; a tab without
  the disk lock is not offered it. Any refusal (a disk, a device, another
  kernel build) boots fresh with a warning line and a toast. A resumed or
  refused session is deleted.
- On a resume the terminal shows only the console's saved tail (the guest
  redraws nothing; below); where the boot lines showed after all (a plain
  load whose session took over 2 s to read), "Resumed the
  session suspended …" and the summary come first.
  Terminal windows 1-9 survive: their sessions are kwtty's detachable ones
  (js.md), which the restore's reset of their vsock connections detaches
  instead of hanging up, so their shells and programs run on. The resume
  opens each saved window again with its number and name, `attach()`es its
  session (`windows.reattach()`) and shows the window shown at the
  suspend. The screen comes from kwtty: it replays the last 64 KiB of the
  session's output into the fresh wterm (from a line start, behind the
  terminal modes in force there), and a full-screen program on the
  alternate screen gets two SIGWINCHs and redraws (busybox vi does not use
  the alternate screen: its last full draw in the replay is what shows).
  The guest keeps a detached session for 60 s; one gone by then gives a
  tty N window a new shell with a gray line saying so, and a demo's window
  shows that it ended; a record without windows reopens none. Not yet
  checked in a browser (the SDK side: `test/api.test.ts`). Network
  connections do not survive (their TCP ends are reset), nor do
  `vm.exec()` pipes. A guest server keeps running and listening, but
  its connections from the old page (the preview's requests) are reset. The
  preview panel open at the suspend (port, path, shown, filling) opens again
  once its port answers (`reopenPreview()`, `waitPort()` from launcher.ts,
  at most 15 s; else a toast says Ctrl-A p opens it), on the new kernel's
  vmId: the old iframe could not have been kept, since the resume is a
  reload.
- Suspend in the background (`autosuspend.ts`, wired in boot.ts;
  `?autosuspend=now|<seconds>|0`, the Options radios
  `#opt-autosuspend-<value>`): once the tab has been hidden that long, the
  page saves the session as Suspend does (written while the kernel waits at
  its snapshot point), but holds the kernel there instead of stopping it
  (`KW.suspend({ hold: true })`, the SDK's `snapshot({ commit, hold })`,
  js.md), for as long as the tab stays hidden; the status is "Paused". As
  soon as the session is stored it sets `kw-resume` to `auto`.
  - Shown again with the page alive (the common case on a phone: a short
    switch to another app), the machine goes on where it was
    (`continueHeld()`): no reload, every terminal window, vsock connection,
    the preview and the guest's state as they were, its clocks moved on by
    the hold (js.md, Snapshots). `kw-resume` is cleared in the same task as
    the release, and the session saved for the hold is deleted after it (by
    its time, as a given-up save's; stale once the guest writes its disks
    again). A page killed between the release and that deletion leaves a
    stale record: the next load resumes it (with its toast), and refuses it
    once the data disk changed, as for a record a given-up save could not
    delete. Quiet: only
    the status ("Paused", then "Running"), the Kernel log and the
    Environment row ("held for N s, continued"). Wisp connections may have
    been closed by their servers meanwhile; the guest's TCP connections over
    them then fail when it goes on (acceptable: a resume loses them too).
  - Killed or discarded by the browser while held: the session is stored,
    so the next load resumes it quietly (`kw-resume` `auto`; Reboot
    deletes the record). After `AUTO_SUSPEND_HOLD_MS` held (10 min, autosuspend.ts;
    counted by the page's timers, so not while the page is frozen) the hold
    becomes the stop, which frees the machine's memory (a held machine keeps
    it all, which may make a phone kill the page sooner); so does a kernel
    or worker that ended while held. The tab, when shown, then resumes it
    (`ui.resumeAuto()`, the Resume reload).
  - The resume is quiet: the suspend wrote nothing to the terminal and showed
    no Resume card (the status is "Suspended", the Kernel log and the
    Environment row say it), and with `kw-resume` `auto` (or `1`, after the
    Resume button: every resume is the same, autosuspend.ts `quietStart()`)
    the load keeps the splash ("Resuming") over the terminal and holds back
    the host's boot lines until the restore, whose first paint is the screen
    as it was, then the toast; a load that boots fresh or fails after all
    shows them (`unquiet()` in boot.ts). A plain load does the same once
    the session's meta says it can resume it (CPU count, kernel, image,
    devices; else, or after 2 s without an answer, the boot lines show at
    once).
    Real failures still say so (a toast and the row; a machine
    stopped without its session saved, a red notice).
  - During a hold the guest runs nothing: console and terminal input queue
    until it goes on, `sync()` (hiding, `pagehide`, Reboot's) answers at
    once (the disks were sealed at the snapshot point), Suspend (by hand or
    `KW.suspend()`) turns the hold into the stop, and Reboot deletes the
    record and boots fresh. Closing the page asks nothing (the session is
    stored).
  Default
  `now` (at once on `visibilitychange`) where `cfg.mobile` (pointer coarse
  or a mobile user agent): phones and tablets freeze or discard background
  tabs when they like, and iOS stops a hidden page's scripts within
  seconds, so a timer may never fire there. Off on desktops, where a
  background tab keeps running and a machine working there (a build, a
  server used from another tab) is the user's work. Saved only where it
  differs from the device's default.
  - Only a machine worth keeping: one the user typed into, tapped or
    clicked since it booted (trusted `keydown`, `pointerdown`, `input`,
    `paste` outside `#panel`, `#bar` and `#confirm`), or a resumed one. An
    untouched machine boots again in about a second.
  - Shown again before the snapshot started, nothing happens (the timer is
    cancelled); while it saves, it finishes and then goes on. A refusal
    before the copy (a task that does not park, I/O in flight; the machine
    runs on) is tried again while the tab stays hidden, at most 3 times
    1 s apart, then the page syncs the disks as hiding does otherwise; the
    Environment row "Suspend in the background" and a toast once the tab is
    shown say why. A suspend that starts at once skips that sync: the
    snapshot seals the disks at its consistent point.
  - A save that fails (`SuspendSaveError`: the transaction aborted, the
    commit's timeout, a disk seal that did not become durable) leaves the
    machine running as it was (its tasks resume as after a snapshot without
    stop; the guest's clocks move on by the wait), and the disks synced as
    hiding does otherwise; nothing is held. It is not tried again while the tab stays hidden,
    but the next time it is hidden; after 2 failed saves
    (`AUTO_SUSPEND_SAVE_FAILURES`) it stays off for the page load. The row
    and a toast once the tab is shown say why.
  - It never does what doing nothing would not: it does not replace a
    session kept from before (the load after Reboot keeps one without a data disk;
    only Suspend by hand replaces it; a record of this machine's own, the
    resumed one or one a given-up save could not delete, does not count),
    and it does not start when `navigator.storage.estimate()` reports less
    free space than twice a session's usual size (`sessionRoom()`: 80 MiB on
    one CPU, 192 on 8), where the save would only fail after parking the
    machine and writing tens of MiB. The estimate is the browser's own and
    approximate; insecure contexts have none. The checks run at once (a
    hidden page may have seconds), and the snapshot is encoded before its
    transaction opens.
  - What can still be lost: a page that the browser kills (not just
    freezes) while the session is being written loses the running machine,
    as it would have without the suspend; the data disk is then as sealed
    at the snapshot point and the record the earlier one (one transaction).
    A page frozen during the write and woken later goes on: the commit's
    timeout counts awake time, so the transaction's own result (committed,
    or aborted by WebKit) decides. A record given up after all whose
    removal also failed stays: the next load resumes it, a machine with a
    data disk refuses it once the disk changed.
  - WebKit (Safari, every iOS browser): on 2026-11-20 an iPhone lost the
    machine twice before the commit existed (it saved after the stop), once
    with "IndexedDB transaction aborted" for the page's session write
    (Chrome on iOS), once with the worker's exit ahead of the snapshot
    (Safari, worker mode, a data disk: most likely the worker's IndexedDB
    seal had not settled within the exit's 10 s, which then counted wall
    time, so a freeze used it up; reproduced with a slow seal under Node,
    js.md, Worker mode). WebKit is widely reported to drop the IndexedDB
    connections and transactions of pages it suspends in the background
    ("Connection to Indexed Database server lost"); nothing the page does makes a hidden
    page's transaction commit, so those failures now leave the machine
    running instead. Not yet tried on an iPhone with the commit.
- Closing or leaving the page while such a machine runs or is being saved
  asks first (`beforeunload`; `?askleave=0`, the `#opt-askleave` box, turns
  it off). Browsers show their own text and only after the user
  interacted with the page; most phone browsers never ask. The page's own
  reloads and navigations (Reboot, Resume, `bootUpOnce()`, the reload on
  another CPU count, data disk import and reset) call `allowLeave()`
  first. Nothing can be saved from inside the question and no browser
  shows the page's text, and a user who stays (Cancel, Stay) may simply
  want to go on working, so staying changes nothing by itself: once the
  page's timers run again (`LEAVE_STAYED_MS`) and it has the focus back
  (Firefox asks from its parent process, where the page's timers keep
  running), a toast offers "Pause to save this session before closing?"
  with a Pause button (`#toast-action`; the toast's one optional action,
  `ui.toast(msg, { action, run, ms })`, which does not take the focus) for
  `LEAVE_OFFER_MS` (9 s), or until a key is typed for the guest. Doing
  nothing keeps it running. `pagehide` cancels the wait.
- Pause (that button; `KW.pause()`, autosuspend.ts `Pause`) is the hold of
  a suspend in the background with the tab shown: the session committed,
  `kw-resume` set to `auto`, the kernel held at its snapshot point, the
  status "Paused" and the title mark `‖`, and the Resume card shows
  "paused: The session is saved in this browser: you can close this tab."
  with Continue (`#continue`), which does not take the focus: it stays in
  the terminal, where any key continues (Tab reaches the button; the
  display's keyboard routing leaves the card's keys alone). Closing the tab then asks nothing (held), and the next
  load resumes it quietly, as after a hold in the background. Continue, or
  any key typed for the guest (a terminal or the display; not the
  shortcut prefix, the dialog or the page's fields), goes on in place
  (`continueHeld()`, which deletes the record, as when a held tab is
  shown). Unlike that hold, hiding and showing the tab does not end it
  (AutoSuspend leaves a held machine alone). After `AUTO_SUSPEND_HOLD_MS`
  (10 min of awake time) paused it becomes the stop, and the page shows
  the Resume card as after Suspend (so does a kernel or worker that ended
  while paused, or Suspend pressed meanwhile). A save that fails is a
  toast, "Not saved: why; the system runs on", and the machine runs on.
- No save at the moment the tab closes: a save needs the kernel to park,
  the memory copied and encoded (about 150 ms with the CLI, 2026-11-15)
  and about 30 MiB committed to IndexedDB, and a closing page has no
  guarantee that a transaction it starts commits (with several CPUs
  more: 35 MiB on 2, 54 on 4, 90 on 8; kernel/parking.md, SMP). A
  suspend started by the `visibilitychange` of a closing tab does not
  finish; on a phone the tab is usually hidden (the tab switcher) before
  it is closed, and that suspend has finished by then. A snapshot without
  `stop` would not help: the guest writes `/data` within seconds, which
  makes it unrestorable.
- Checked by hand only (no browser test); suspending in the background
  (with the hold) and the question on leaving not yet on a real phone or
  desktop browser (their decisions: `web/test/autosuspend.test.ts`; the
  SDK's commit, hold and their failures, inline, in worker mode and on
  several CPUs: `test/api.test.ts`).

## Service worker and updates

The page's one service worker (`public/vm-sw.js`, registered by `sw.ts`)
has scope `/vm/`, in dev and in a build alike, and serves only the guest
preview (below). It does not control the page: `/`, `/assets/` (the
kernel among them) and everything else the page loads go to the network
and the HTTP cache, so a reload always runs the newest deploy. There is no
offline copy: a cache-first page stays old whenever caching a new build
fails.

- Its own updates: `register()` with an unchanged script URL does not
  look for a new one, and loads of `/` are outside the scope, so the
  browser's own check on navigation never runs. `sw.ts` therefore calls
  `registration.update()` on every load (the first `serviceWorker()` call,
  when the preview attaches) and again when the tab is shown after an
  hour. `/vm-sw.js` is `no-cache` and registered with
  `updateViaCache: "none"`. A new script activates at once (`skipWaiting`,
  `clients.claim`), so the relay's messages must stay compatible.
- Legacy scope `/`: earlier builds registered the same script at `/` and
  answered `/` and `/assets/` from the Cache API `kw-app-v1`. The browser
  checks that registration's script on each navigation to `/`, so it gets
  the new `vm-sw.js`, which then answers nothing outside `/vm/` (as at
  any scope), deletes `kw-app-*` caches on
  activation, and (`LEGACY` in the worker) answers the old page's
  `{t: "kw-check"}` with `update`,
  so that page's status line offers a reload. The load that brought the
  new script still ran the old cached page; the next one comes from the
  network, and its `boot.ts` calls `dropLegacyScope()`, which unregisters
  `/`. Activation never deletes other caches (`kw-apk-index-v1` is apk.ts's).

## Guest preview

A web server running in the guest (say on port 8000) shows in a panel
docked right of the stage (`Preview.tsx`), or in a tab of its own, at
`/vm/<vmId>/<port>/<path>`. The vmId is random per booted kernel
(`preview.ts`). Ways to open it: Ctrl-A p (it opens on the last port, or
8000; pressed again it hides or shows the panel), the Preview section in
the Guest tab, the status line's globe icon on the right (`#bar-preview`,
which hides and shows it; the port is in its tooltip), `KW.preview.open(port)`, and in the guest
`open` or `xdg-open http://localhost:<port>/<path>` (`open.ts`, after a confirm). On wide screens the panel takes part of the
stage's width, so the terminal (and the display offered to the guest) gets
narrower; its left edge sets the split (localStorage `kw.previewSplit`,
default 40%) and `[□]` fills the stage. On narrow ones (under 720 px) it
fills the stage. While it covers the stage it is a view like a terminal
window or the display: picking one of those (`windows.ts` `select()`,
`toggleDisplay()`) hides it, and the status line marks only the globe as
current. Hidden, the terminal gets its width back. It has a port field, reload,
and a link that opens the URL in a new tab. It is no URL parameter, so it
has no Options control.

- Relay: `public/vm-sw.js`, a plain script served at `/vm-sw.js`, outside
  the TypeScript build: the page's one service worker (scope `/vm/`;
  Service worker and updates). The relay is stateless, because
  browsers stop idle service workers. For each request it posts
  `{t: "kw-vm-fetch", vmId, port, method, path, headers, body}` (path
  includes the query, body is an ArrayBuffer or null) with a
  MessagePort of its own to every window client that is not under `/vm/`
  (`clients.matchAll({type: "window", includeUncontrolled: true})`). The
  page whose vmId matches answers `accept` at once, and other tabs
  ignore the message. Then come `head` (status, statusText,
  headers), `chunk` messages (transferred ArrayBuffers), and then `end`, or
  `error` (an HTTP status before `head`). The worker sends `more` when its
  body stream pulls and `cancel` when the stream is cancelled. The page
  may send 4 chunks ahead of `more`. Transferable streams are not used,
  because Safari lacks them. With no `accept` within 5 s the worker
  answers 502 with a short text. If the guest sends no head within 60 s
  after the accept, it answers 504. `/vm/<id>/<port>` without the slash
  gets a 308 to the slash.
- Page side (`preview.ts`): boot.ts calls `attachPreview(vm)` once the
  kernel runs, and `attachPreview(null)` at exit; requests then get 503. The
  first call registers the worker (`sw.ts`), only where `navigator.serviceWorker`
  exists (secure contexts). The window waits until the worker is
  active. It does not use `navigator.serviceWorker.ready`, which never
  resolves, because the scope `/vm/` does not control the page. Requests go
  to `vm.fetch("http://localhost:<port><path>", {method, headers, body,
  redirect: "manual", signal})` (the SDK's, js.md, which follows no
  redirects and does not decode bodies). preview.ts needs only its
  `GuestFetcher` interface. At most 8 relayed requests run at once and the rest queue,
  because each guest connection forks a server process. Request headers
  lose hop-by-hop ones and `host`/`content-length`. `accept-encoding` is
  `identity`, because the browser does not decode a synthesized response.
  `origin` becomes `http://localhost:<port>`, so CSRF checks see the guest's
  own origin.
- Response headers: the worker drops hop-by-hop headers, the guest's own
  COOP/COEP/CORP, and Set-Cookie (a synthesized response cannot set
  cookies). It adds `Cross-Origin-Embedder-Policy: require-corp` and
  `Cross-Origin-Resource-Policy: same-origin`. A document in the
  isolated page's iframe needs a COEP. `credentialless` would also
  let a guest page's CDN assets load in Chrome and Firefox, but Safari
  does not implement it and would block the iframe. With require-corp a
  guest page's cross-origin subresources load only if they send CORP or
  CORS. A redirect to `/x` or to `http://localhost:<port>/x` is rewritten
  under the prefix.
- Root-relative URLs: the worker answers only `/vm/<id>/<port>[/…]`.
  Nothing outside it is relayed, so a preview document's `/style.css`
  reaches the unkernel server, not the guest: guest pages must use
  relative URLs. Navigations outside `/vm/` (a link to `/about`) reach the
  server, which sends the page, and `main.tsx` sends them back under the
  prefix (`previewEscape()`: the iframe's `data-kw-preview`, or in a tab the
  referrer) instead of booting a second kernel.
- Server: `/vm/**` reaching the server (a shift-reload bypasses the worker,
  or the worker is not installed) gets a 503 page from `server/vm.ts` that
  says the preview needs the page open, not the app. Its link to `/` is
  `rel="noreferrer"`, so `previewEscape()` does not send it back.
  `/vm-sw.js` is `no-cache`, and the worker registers with
  `updateViaCache: "none"`. In `pnpm dev`, Vite serves `public/` and Nitro
  the handler; both carry COOP/COEP.
- Limits: same-origin and trusted content only, since the guest's pages can
  script the unkernel page (`parent.KW`). A sandbox without
  `allow-same-origin` would take the iframe out of the worker's control. A client-side
  router sees the `/vm/<id>/<port>` prefix in `location`. WebSockets and
  Vite-style HMR bypass service workers, so they do not reach the guest.
  Cookies are not set. A tab on the URL works only while the page that
  owns the vmId stays open, and a reload gives a new vmId. There is no
  back-pressure beyond the 4 chunks ahead plus one per pull. A long
  stream may be cut when the browser stops a worker whose event runs for
  minutes. Checked by hand only, plus a Node harness of the
  relay against a fake `vm.fetch`. No browser test.
- Trying it by hand: the image's busybox has no httpd. In a terminal
  window, run `sudo apk add busybox-extras`, then `mkdir -p /tmp/www && echo hi >
  /tmp/www/index.html && httpd -f -p 8000 -h /tmp/www`. Or run `sudo apk add
  python3`, then `cd /tmp/www && python3 -m http.server 8000`. Then Ctrl-A
  p, and "Go" after changing the port.

## Launcher

The status line's first item (`❯`, `#bar-launcher`), ⌘K on Apple
devices, Ctrl-Shift-O or Ctrl-A o open the launcher (`#launcher`, `Launcher.tsx`, the store's `launcher`):
an overlay over the whole page in the manner of macOS Launchpad, the page
blurred behind a grid of tiles (glyph and gradient from the demo) and a
search field. The focus stays in the field (tiles take none), so
display.ts never routes its keys to a program holding the guest's
keyboard; arrows select, Enter runs, Esc clears the search, then closes; a
click on the backdrop closes. On touch devices the field is not focused.
A demo's `icon` is a glyph or a pictogram as inline SVG markup (static
strings in the demo file, set as inner HTML): project logos from Simple
Icons (CC0, the slug in a comment), else the project's own mark from its
site (the source in a comment), crafted ones otherwise.
After the demos comes a gray System tile that opens the dialog
(`PANEL_TILES`), which works in any state.

The demos are one file each in `src/demos/`, listed in order in
`src/demos/index.ts`; `launcher.ts` runs them. The page ships no assets for
them, so a demo is text only (`Demo` in launcher.ts): `files` written under
its directory (`~/demos/<id>` by default) with one `vm.exec()` each (or a
function that loads them at launch with a dynamic import, which keeps
their text out of the page's main chunk), plus
a generated `run.sh` there for the running distro (the `packages` it
names for that distro, `{ alpine, debian }`, not yet installed: on Alpine
`/etc/kw-apk-enable` when the demo sets `community`, then `apk add`; on
Debian `apt-get install`, again after `apt-get update` when the baked lists
name a version the mirror dropped; then the `commands`, each printed
before it runs, under `set -e`). The files, run.sh and the window are the
session's user's (`user` on the distros): run.sh starts with `SUDO_SH`
(`sudo.ts`) and runs the package manager, and the commands a demo writes
as `$SUDO cmd` (nginx's server, PostgreSQL's `start.sh`, Ubuntu's
chroot, sshfs's mount), with sudo, printed as `sudo cmd`; where it runs as
root (the base shell, which has no sudo) both are plain. A demo directory
outside the user's reach (nginx's `/srv/nginx`) is made and handed to the
user with sudo, and a file the user cannot write (PostgreSQL's
`createcluster.d` file under `/etc`) is written with sudo. A demo runs only on the distros its
`packages` name; its scripts handle what else differs (Doom's and
Ubuntu's, with no `packages`, run on both). A new terminal
window named after the demo runs `sh -lc` with a wrapper in place of the
login shell: `cd <dir> && ./run.sh`, then `exec` the login shell, so the
window stays to edit and rerun (an INT trap keeps the wrapper alive through
Ctrl-C). Typing the command into a fresh shell lost the start of the line,
because the login discards input typed ahead of its prompt. The preview opens once the
guest answers http on the first of its `ports`. The distros' nginx default
site also listens on `[::]:80`, which fails in the guest (no IPv6), so the
nginx demo replaces it. A demo's files are text in its own file: Doom (`web/src/demos/doom.ts`) carries the `fbdoom` script (fbDOOM built in
the guest with tcc, on `/dev/fb0` with evdev input and `/dev/dsp` sound,
installed in `~/.local/bin` and building into `~/.local/share/fbdoom`; the
first run took 22 s to the first frame, a later one 0.2 s, 2026-11-18) and
its patches to fbDOOM as template literals, and these GPL-2.0-or-later texts keep their license
(the script's SPDX header) inside the MIT bundle. Files with absolute paths land outside the demo directory, and
files from an earlier launch are never removed. A demo's `downloads`
(url, SHA-256, size, guest path, an optional `unless` shell test) are
fetched by the page before its window opens (`download.ts`, described at
its top): the sites send no CORS headers and the page is cross-origin
isolated, so it speaks plain http over its own Wisp connection, as apk.ts
does, follows redirects as http (a site that redirects to https only
fails; a download with `cors`, for a site that sends
Access-Control-Allow-Origin such as releases.fx.sh, is a direct `fetch()`
instead), checks the SHA-256 and keeps the file in the Cache API
(`kw-files-v1`), then pushes it with one `vm.exec()` (through a `.part`
file, size checked). It skips a file that is in the guest already at that
size, or whose `unless` passes in the demo's directory. A failure is a toast
and a log line, not fatal, so the demo's script checks the file itself and
downloads it when it is missing (Ubuntu does). On 2026-11-15 (Node, the
default Wisp server) the riscv64 Ubuntu Base tarball (31 MB) took 1.5 to
4.4 s to fetch and 0.2 s to push; the arm64 26.10 one (35 MB) took 0.3 s
to push (Node SDK, 2026-11-18). A demo with `hidden` set is left out of the launcher. A demo runs once at a time: picking one whose window
is open (a dot under its tile) shows that window. A demo whose `needs`
(display, net, sound; wayland: the Wayland desktop) the page's options rule out is dimmed, with why; so
is one whose `packages` leave out this boot's distro.
Failures are toasts. Checked by hand only.

Every demo's run.sh, as the launcher writes it, was run on the aarch64
guest through the Node SDK on 2026-11-18: a fresh data disk per demo, 512
MiB, the files written with `vm.exec()` and run.sh in a pty session (the
window's command without the wrapper), the host's network instead of Wisp,
a display or sound card where the demo needs one, and the Ubuntu tarball
pushed as `downloads` does (a scratch harness, not in the repository).
Each reached its working state: the
servers answered over `vm.fetch()` (nitro's echo POST), postgres's `select version()` said aarch64, glimmer and Doom drew
frames, radio and speak played sound, sshfs mounted Rebex's server.
Seconds from run.sh's start, the `apk add` step (indexes and packages
over the host's network) first, then the time to the working state:
htop 1.6/1.7, tmux 1.8/2.6, mc 2.6/3.0, Neovim 6.8/7.7 (community), Git
2.8/4.9 (clone 1.6 s), sshfs 2.9/4.6 (mounted, tour done), nginx
1.8/2.1, Nitro 5.9/39.4 (upm install 16 s, `nitro dev`
14 s), PostgreSQL 5.7/19.6 (initdb and start 13 s),
SQLite 1.7/2.9, Valkey 2.1/3.3, radio 1.7 (sound about 1 s after a
station is picked), speak 2.4 (the introduction starts at once),
asciiquarium 6.7/6.8 (community), glimmer 0.1 (no packages), Ubuntu 28
(extracting the pushed tarball; 0.2 later, `apt-get update` 28 s in the
chroot), Doom 22 (tcc install, downloads and a 6 s build; 0.2 later).
The REPL and toolchain demos (Claude Code, fx, Bun, Node.js, Python, Go,
Rust) came after that run and have not been through it.
Docker (Debian only: `docker run --rm hello-world` through the image's
docker shim, kernel/guest.md) came later too: with Docker installed, its
command pulled and ran hello-world in 6 s (Node SDK, 1 GiB, data disk, the
host's network, 2026-11-19); the first run adds the shim's install
(about 1 min).

`?try=gh:owner/repo[@ref]` (the repository's `unkernel.json` at that
ref, default HEAD) or `?try=<https url>` is a "try it" link for a
project's README (`src/try.ts`, schema at its top; `tryFromUrl()` starts
it once the guest is up). try.ts checks the spec, the confirm dialog
(`untrusted`) lists its packages, download and commands, and on Run it
becomes demo `try-<name>` in `~/try/<name>`. The guest downloads the
binary and checks its SHA-256. The spec's server must send
`Access-Control-Allow-Origin` (raw GitHub does); `?try=/try/jq.json`
runs an example in `web/public/try/`. URL only: a reload asks again,
Reboot drops it. Checked by hand only.

`?showcase` runs `src/showcase.ts` once the guest is up: a
fast, hands-off tour of the demos, leaving out the web servers (described at its top).
Each step shows a caption and launches its demo.
It waits for a process (`pgrep -f`), a pattern on the screen, the display or
the preview, then plays it: keys typed into the terminal, or the evdev
keyboard for glimmer and Doom. Then it closes the demo. A bar along the top
shows progress, and the tour ends on a title card. `?showcase=a,b` runs only
those steps. The tour does not wait: a demo not ready within 30 s is
skipped and logged, as is a step that fails. `?showcase=warm` launches each
demo and waits until it is ready, without captions, so apk, npm and the
Doom build come from the data disk on later tours. `KW.showcase` has
`skip()`, `pause()` and `resume()`.

## Running and deploying

- `pnpm dev`: Vite on port 8080, all interfaces (`server.host: true` in
  `vite.config.ts`; `pnpm -C web dev --host 127.0.0.1 --port 8090` binds
  and moves it), with the local build once
  `kernel/build.sh all` (or `base` and `distro`) has run, else the newest
  release (The page's kernel and distro images). `pnpm build:web` writes
  `web/.output/` the same way (a build beside the main outputs:
  `KW_KERNEL=<dir>/unkernel.wasm KW_DISTROS=<dir> pnpm build:web`), and
  `pnpm start:web` runs it (port 3000 unless `PORT=`). `pnpm
  typecheck:web` type-checks it.
- On Vercel, Nitro detects the platform and writes `web/.vercel/output`.
  Elsewhere, `NITRO_PRESET=vercel pnpm build:web` produces the same for
  `vercel deploy --prebuilt`. Vercel's build sets `VERCEL`, so it takes
  the newest release: deploy only after a release with this layout
  (unkernel.wasm, distros.json, the images) exists. The images are about
  77 MB of static files (alpine 4.0, debian 72.6 MB).
- A LAN `http://` page is not a secure context: no clipboard API, no
  `deviceMemory`, no Web Locks, and no cross-origin isolation. It still
  works.

## Browser tests (`web/test/`)

Agents run these only when asked. The page is tested by hand with
`pnpm dev` on port 8080, so do not start anything on that port.

`headless.mjs` (`pnpm test:web`: desktop with the JIT compiling and
cross-origin isolation asserted, phone over LAN, nojspi, fetch404, modfail,
lowmem booting to the shell at 128 MiB), `data.mjs` (data disk, overlay root per distro,
safe mode, second tab, export/reset/import) and `net.mjs` (needs the internet), both on
`?distro=alpine` (apk, wget, Alpine's upper layer; `headless.mjs` runs the default image). Shared
code is in `lib.mjs`. They drive Chromium over the DevTools protocol with no
npm dependencies and start the built server (`--dev` starts the Vite dev
server). They use the newest Playwright Chromium in `~/.cache/ms-playwright`
unless `--chrome PATH` or `CHROME=` is given. There is no WebKit test
script.

`open.test.ts` and `autosuspend.test.ts` are no browser tests: plain unit
tests of `src/open.ts` and `src/autosuspend.ts` (`node --test
web/test/open.test.ts web/test/autosuspend.test.ts`).

## Engines

- Several CPUs need, besides JSPI in every worker: cross-origin
  isolation, nested dedicated workers (Chrome, Firefox, Safari 15.5+),
  `Atomics.waitAsync` (Chrome 87+, Safari 16.4+; check Firefox) and
  posting a `WebAssembly.Module` and a shared `WebAssembly.Memory` to a
  worker. Only Chromium has run it (Several CPUs).
- JSPI (`WebAssembly.Suspending`/`promising`) is required: Chrome/Edge
  137+, Firefox 153+, Safari 27+ (every iOS browser uses the system
  WebKit). memory64 is not needed, because the page runs the lowered
  kernel; as of 2026-11 no stable Safari has it.
- Playwright WebKit builds (2336 and 2388) behave like iOS; on 2026-11-13
  they and a real iPhone gave the same hashes with the JIT on and with
  `?jit=0`.
- **Safari 27 runs plain-http pages without a JIT** (2026-11-13, Mac and
  iPhone). On a page that is not a secure context (`http://` at a LAN,
  VPN or proxy address) Safari interprets JS and wasm: kwbench's int
  loop runs at 248 MIPS against 3670 in Chrome on the same Mac. At
  `http://localhost:<port>` or over https it has its JIT. Playwright
  WebKit has no such policy, so it cannot reproduce this. When Safari or
  an iPhone is slow, check the origin first. The page does not warn about
  it.
- JavaScriptCore collects freed JIT modules only when prompted (kwemu.md,
  Collecting freed modules). On an iPhone the JIT row of the Environment tab
  should show `collected` keeping up with `freed`, uncollected modules in
  the hundreds, and `refused` 0. Not yet measured on a phone.
