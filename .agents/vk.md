# Guest Vulkan on WebGPU (kwvk)

`createKernel({ vk: true })` in a browser with WebGPU gives the guest a
Vulkan 1.2 device, "kwvk (WebGPU)". The contract between the three parts is
`vk/PROTOCOL.md` (framing, messages, shader rules, and its Amendments,
which override the body); read it before changing any of them. The page's
Guest Vulkan option is in web.md (Guest Vulkan). State as of 2026-11-24.

```
app -> Vulkan loader (Debian libvulkan1) -> /usr/lib/kw/libvulkan_kw.so (vk/icd)
    -> AF_VSOCK, host CID 2, port 1018 (VK_PORT), one stream per VkInstance
    -> VkHost (js/core/vk.ts, the thread that owns the VM, both modes)
    -> VkRenderer (js/core/vk-host.ts, vk-exec.ts, vk-formats.ts) on WebGPU
    -> SPIR-V to WGSL: kwvk-naga.wasm (vk/naga, js/core/vk-shader.ts)
```

## Parts

- **ICD** (`vk/icd/`, GPL-2.0-or-later, C): thin. Instance, physical
  device, device, queue, memory (a device-local type without a shadow and a
  host-visible coherent, cached one with a malloc'd shadow; Device memory below),
  fences, semaphores, command recording and
  presentation are guest-side; every other object is made on the host by a
  message. Command buffers go as JSON at submit; host-visible memory is
  diffed and sent before each submit, over the ranges the submit's commands
  may read or write (vk/PROTOCOL.md, Amendments, "Submit flush"); the ranges of mapped buffers that
  submitted work may write (copy regions, storage buffers and storage
  texel buffers the bound pipeline's SPIR-V may write, as bound) are read
  back at fence waits. Its physical device is an
  integrated GPU whose limits, features and formats come from the host's
  hello reply (WebGPU's; texel buffer formats from its `texelBuffers`), as does its subgroup size (32; no subgroup
  operation, supportedStages 0, which Vulkan 1.1 does not allow: it wants
  COMPUTE there). WSI: VK_KHR_wayland_surface (external buffers
  on the page's wland, else wl_shm buffers; pre-multiplied alpha;
  Presentation below), VK_KHR_xcb_surface and VK_KHR_xlib_surface
  (XPutImage), VK_EXT_headless_surface; Wayland, xcb and Xlib are
  `dlopen`ed. `KWVK_LINK` picks the link (`vsock:2:1018` default, `tcp:`,
  `unix:`); `KWVK_SUBGROUP_SIZE=N` (a power of two up to 128) asks the
  host for another subgroup size than its 32, which the ICD reports
  (`KWVK_SUBGROUP_SIZE=1`: the size before 2026-11-24; an older host
  takes none and the ICD reports 1; vk/PROTOCOL.md, Amendments, "Subgroup
  size"); `KWVK_DEBUG`, `KWVK_TRACE`, `KWVK_STATS`,
  `KWVK_FENCE_SYNC=1` (every fence waits for its submit's reply) and
  `KWVK_SPIRV_DIR=DIR` (keeps every module) are for debugging. Errors and
  wrong-result warnings go to stderr whatever `KWVK_DEBUG` says, each
  distinct line once (`kw_err`; Errors below). Built by `vk/icd/build.sh` (aarch64
  glibc, `$KW_BUILD/vk/libvulkan_kw.so`, `kw_icd.json`, the test programs
  `test/vk/guest/vk-*.c`) or `vk/icd/build.sh native` (this host,
  `$KW_BUILD/vk/native/`, for `test/vk/relay.mjs`), against the Vulkan
  headers pinned in `vk/pins.sh` (Khronos 1.4.309, trixie's loader;
  fetched into `vendor/downloads` by `vk/headers.sh`).
- **In the guest**: the base's kw layer carries the ICD and its manifest
  (`/usr/share/vulkan/icd.d/kw_icd.json`, the loader's default path: no
  environment variables); `guest/base/build.sh` runs `vk/icd/build.sh`
  (`KW_VK=0` leaves it out; about 110 KB of the layer). kernel/guest.md,
  The kw layer. Debian only (it links glibc); programs need `libvulkan1`.
- **Host** (`js/core/vk-host.ts`, `vk-exec.ts`, `vk-formats.ts`, MIT):
  implements the objects and the command stream on one GPUDevice.
  Swapchain images are read back at present (the `present` reply carries
  the pixels) unless they are external buffers (`renderer.external()`,
  Presentation below). A lost device fails and closes every stream, then
  calls `onLost`; a failure of one stream's work that no reply can report
  loses the device for that stream only (Errors below).
- **SDK** (`js/core/vk.ts`; js.md, Guest Vulkan): the web entry only.
  Nothing loads before the guest's first VkInstance: then the adapter (every
  feature it has, its maximum limits), the renderer's modules (chunks of
  their own) and the translator. `vm.vk`: `status` (idle, loading, ready,
  lost, failed), `stats` (streams, bytes, `losses`, `renderer`: the host's
  counters, e.g. `presents`, `errors`, `lost`), `device`, `loaded`,
  `load()`, `externalImage(ref)` (wland's resolveExternal; Presentation).
  After a lost
  device the next program gets a new device and renderer. Snapshots hold
  no renderer state: a restore drops the connections. Ignored with a log
  line on Node.
- **Translator** (`vk/naga/`, Rust on naga with passes of its own; the
  loader `js/core/vk-shader.ts`): SPIR-V to WGSL per stage with reflection
  (bindings, push constants, varyings, `requires`: the WebGPU features the
  WGSL enables). Specialization constants are baked, vertex output gets
  the Y flip, descriptor arrays are flattened, input attachments become
  textures, 8/16-bit and float16 storage is lowered to u32 words (float16
  computed in f32 without `shader-f16`), texel buffers (samplerBuffer,
  imageBuffer) become storage buffers of u32 words plus a uniform of the
  view's format, first byte, count and texel size, decoded and encoded by
  a switch on the format (`src/texel.rs`; vk/PROTOCOL.md, Amendments,
  "Texel buffers"), and a block whose members are all
  NonWritable (or NonReadable), as older glslang marks `readonly buffer`,
  is read-only (write-only) as a whole: naga reads only the variable's
  decorations, and WebGPU refuses a read_write buffer bound over the range
  of another binding. A storage buffer the module never writes (no
  pointer into any view of its binding reaches a store, an atomic, a
  call or any instruction but a load, OpArrayLength or an access chain;
  modules with variable pointers left alone) is read-only too (GZDoom's plain `buffer` blocks in vertex
  stages, where WebGPU has no read_write storage). Every stage's WGSL and
  `bindings` hold only the resources its entry point reaches, after
  branches on baked constants and statements after a return, break or
  continue are dropped. OpLine/OpNoLine are dropped (Taisei's `-g`
  modules), OpSpecConstantOp is folded (every Shader-capability operation
  on integers and booleans, scalar and vector; Select, FConvert,
  QuantizeToF16 and the composite operations on floats: vkQuake),
  isinf/isnan become bit tests and an `int[1]` gl_SampleMask(In) a u32.
  Compute helpers that read num_workgroups or workgroup_id through
  spv-in's private copies get them as arguments (`src/builtins.rs`), and
  a workgroup over the device's limits that shares memory or has barriers
  runs each invocation as 2 to 8 virtual
  ones (`src/virt.rs`; vk/PROTOCOL.md, Amendments, "Virtual
  invocations"). Compute modules that read the subgroup builtins without
  any subgroup operation (llama.cpp's gated_delta_net and ssm_scan) get
  them as arithmetic on the local index for the reported subgroup size,
  so they need no `subgroups` feature and see that size whatever the
  adapter's (`src/subgroup.rs`; vk/PROTOCOL.md, Amendments, "Subgroup
  size"). Uniform blocks WGSL cannot lay out (std430 push
  constants with arrays of stride 4, as llama.cpp's rope, which Firefox
  and Safari refused) are repacked into `array<vec4<u32>, N>` words
  (`src/uniform.rs`; vk/PROTOCOL.md, Amendments), and naga validates
  with WebGPU's capabilities and WGSL's struct layouts, so the WGSL is
  meant for every engine, not only Chrome. `vk/naga/build.sh` ->
  `$KW_BUILD/vk/kwvk-naga.wasm` (about 0.9 MB) -> `dist/kwvk-naga.wasm`.

## Build

- `vk/build.sh [all|naga|icd]` (as `gl/wasm/build.sh` is for GL): the ICD
  and its test programs, then the translator where cargo has the
  `wasm32-unknown-unknown` target (else a message, and the SDK has no guest
  Vulkan). `setup.sh` checks cargo as optional and runs `vk/build.sh naga`
  after `kernel/build.sh all`; `pnpm build` copies the translator (a
  warning without it); the base build includes the ICD.

## Testing

- `pnpm test:vk` (no browser, part of `pnpm test`): `VkHost` on a fake
  vsock with a fake renderer and device (lazy load, a renderer connection
  per stream, bytes both ways, close and shutdown, a stream the renderer
  ends closed only after its last frame, a lost device and a new one for
  the next program), `prepareVk`'s refusals, distinct host vsock
  ports (9p, GL, commands, WASI exec, tty, Vulkan, the page's Wayland), and
  the translator on `test/vk/guest/double.comp` (skipped without
  `kwvk-naga.wasm`).
- `node test/vk/host/check.mjs`: the host renderer alone in headless Chrome
  with a fake client (153 cases, the failures that must reach the guest
  included: refused and unusable pipelines, lost devices; a pipeline made
  with its read-only buffers kept and dispatched with them in a buffer it
  also writes; a 512-wide shared-memory reduction on 256 invocations;
  the hello's subgroup size and subgroup builtins that follow it;
  timestamps over
  several submits under a conversion that changes per resolve, and a
  sample that reads 0, never going backwards; descriptor copies
  past a binding's end; uniform bindings of 252 bytes read by a 256-byte
  block; block-compressed copies ending mid-block (BC1, ASTC 6x6) and
  BC1 to and from R32G32_UINT; unwritten textures and samplers, unwritten
  immutable samplers; multi-draw indirect at strides past the record;
  indexed fans with primitive restart; storage bindings at offsets 4480
  and 6146; texel buffers: the hello's formats, fetches of 12 view formats
  at offsets off the storage alignment (4496, 272, 8176, ...), a storage
  texel buffer written by compute and read back, a format refused at view
  creation and one refused as a storage texel buffer, a compute stage
  with every storage buffer slot taken and a texel buffer more (refused,
  named); external present:
  tokens, export ids, pictures premultiplied and opaque, every ref that
  must resolve to null). `vk/naga/test/run.ts`: the translator on the shaders
  in `vk/naga/test/shaders/`, validated in a real WebGPU (pushpack.comp
  also runs and compares every value of a repacked push block, and
  subgroup.v13.comp every value of lowered subgroup builtins, under
  virtual invocations too, texel.comp every element of 45 texel buffer
  view formats at a nonzero first byte, texelrt.comp every storage format
  stored back to its bytes, texelimg.comp storage texel buffers with and
  without a format, atomics and narrow stores);
  `corpus.sh`: a real-world corpus (Sascha Willems' examples, vkmark,
  GTK 4, SDL 3). `vk/naga/test/compile.sh` (the test shaders' SPIR-V;
  `*.g.*` with `-g`) and `corpus.sh` need glslangValidator and spirv-opt
  (`sudo dnf install glslang spirv-tools`; reset with the image).
  `cargo run --release --features check --example check --manifest-path
  vk/naga/Cargo.toml -- DIR...` parses and validates WGSL files with
  naga's WGSL front end under WebGPU's capabilities, as Firefox does (2026-11-24: every translated ggml-vulkan variant of
  llama.cpp's b12674 release and source builds, with and without
  `shader-f16`, and the corpus pass; subgroup variants are skipped,
  naga 30 refuses `enable subgroups`, which gated_delta_net and ssm_scan,
  subgroup builtins without operations, no longer have: they pass).
- `node test/vk/relay.mjs -- CMD` runs CMD (e.g. `vulkaninfo --summary`,
  `vendor/build/vk/native/vk-compute`) on this host against the renderer
  in headless Chrome, with `KWVK_LINK` and the native manifest set;
  without CMD it serves `tcp:127.0.0.1:10210`. It re-imports the
  renderer's sources when they change.
- `node test/vk/unkernel-check.mjs` (`--worker`; `--source`: the SDK from
  its sources, no `pnpm build`): Debian in headless Chrome with `vk: true`
  and the prepared disk `$KW_BUILD/vk/debian-vk.img` (`test/vk/debian-disk.mjs`:
  libvulkan1, vulkan-tools, libwayland-client0, wayland-utils, weston;
  139 s, 605 MiB); pushes the ICD under test (`--no-push`: the base's;
  `--kernel FILE`: another bundle). Steps: h (a raw hello over `kwbox
  vsock`), a (`vulkaninfo --summary` names kwvk), b (every
  `$KW_BUILD/vk/vk-*` test program exits 0: compute, triangle, headless,
  dynamic state, threads, depth (also with vkCreateRenderPass2,
  depth-only layouts and an imageless framebuffer begun with two sets of
  views), flat varyings, loud failures: refused pipelines (a barrier in
  non-uniform control flow; a 512-wide workgroup with its barriers in a
  function), a 512-wide shared-memory reduction run as virtual
  invocations, lost devices, descriptor sets: consecutive binding updates
  by a write, a copy and a template, dynamic offsets, mapped results read
  directly, texel buffers: format features, a refused view format, a
  uniform texel buffer gathered through an index one into a storage one
  with image atomics, set by a write, a copy and a template, the results
  read from the mapping, timeline semaphores: values reached at the submit without a
  sync request (counted in `KWVK_TRACE`), wait before signal held and
  released in order by another thread's vkSignalSemaphore or an earlier
  held submit, wait-idle across a release, wait any and all, timeouts,
  device loss with a held submit, and the inter-stage limit per engine),
  c (`vkcube --wsi wayland`
  under `weston --backend=headless --renderer=pixman --debug`, started by
  the page's `/usr/local/bin/kwvk-wl CMD`; then a running vkcube's frame
  taken by `weston-screenshooter` and judged: many colours, the LunarG
  teal, not olive), w (vkcube through wland: wland/headless on the page,
  from `web/node_modules/wland`, serves vsock port 1023 with
  `resolveExternal` = `vm.vk.externalImage`; the relay in the guest is the
  image's or `--relay FILE`, an aarch64 wlandr pushed to
  `/tmp/kwvk-wlandr`; with a relay that has `--external-buffers`, vkcube
  (IMMEDIATE) at each `--wsizes` size, default 500x500 and 1280x720, for
  `--wsecs` seconds by external buffers, then with `KWVK_EXTERNAL=0` by
  readback, frames/s and bytes read back per frame printed; always a relay
  without the flag, where vkcube must run over wl_shm). `--lose` (the device destroyed while vkcube runs; new
  programs work), `--snapshot` (a snapshot with a running vkcube,
  restored), `--cpus N` (SMP; the page cross-origin isolated). `--apps`
  boots the second-stage disk (`debian-disk.mjs --apps`: vkmark,
  gtk-4-examples, SDL 2 and 3 tests, vkd3d demos, Xvfb, x11-apps), or
  with `--disk $KW_BUILD/vk/debian-vk-games.img` the third
  (`debian-disk.mjs --games`: mpv, mesa-utils, taisei, ddnet; 1284 MiB,
  78 s), for `--cmd '...'` runs, whose files in `/tmp/kwvk-out` come back to the out
  dir; `--capture-shaders` (with `--source`) writes SPIR-V the translator
  refuses; `--disk FILE` boots another prepared disk; `--mem MIB` sets the
  guest's memory; `--nogpu` encodes dispatches without running them
  (timing only: wrong results; workgroups over the device's limits
  compile clamped); `--profile N` writes instruction samples of the guest
  during `--cmd` to profile.json (symbolizeProfile).
- `node test/vk/page-check.mjs`: the page's option (web.md, Guest Vulkan).
- WebGPU in headless Chrome here: only the Playwright Chromium
  (`~/.cache/ms-playwright/chromium-1234/`) with `--enable-unsafe-webgpu
  --enable-features=Vulkan,WebGPU --use-vulkan=swiftshader
  --use-webgpu-adapter=swiftshader --disable-dev-shm-usage` (adapter
  "google swiftshader", no `shader-f16`, 256 invocations per workgroup);
  dnf's `chromium-headless` has no adapter. External present also needs
  `--use-angle=swiftshader --enable-unsafe-swiftshader` (the scripts pass
  them): without a GL backend for canvases a WebGPU OffscreenCanvas's
  transferToImageBitmap makes Chrome destroy the GPUDevice, which the SDK's
  probe catches (no external present, a `[host] vk:` line). Without
  `--disable-dev-shm-usage` other browsers filled `/dev/shm` (64 MiB) and
  Chrome crashed before the page ran.

## What runs (2026-11-24, SwiftShader WebGPU)

Every number is software WebGPU on this host's CPU, with the guest under
kwemu, except the subgroup size's effect on the user's GPU (below).

- unkernel-check, inline and worker mode, with `--lose`, `--snapshot` and
  `--cpus 2`: all steps pass; the renderer loads at the first connection
  in 10-20 ms.
- vulkaninfo (full, exit 0); vkcube and vkcubepp on Wayland (FIFO, MAILBOX,
  IMMEDIATE) and on X11 under Xvfb (xcb, xlib), frames right; vkmark's 7
  scenes (headless 700-1150 FPS; on Wayland 143-195 FPS); SDL 2 and SDL 3
  `testvulkan` (28-32 FPS); SDL 3's GPU API (`testgpu_simple_clear`,
  `testgpu_spinning_cube`, 27-31 FPS); GTK 4.18 with
  `GSK_RENDERER=vulkan` (gtk4-demo: as with the cairo renderer, shadow
  included; GTK's default renderer stays GL); vkd3d-gears (Direct3D 12 on
  vkd3d) under Xvfb (2026-11-28: its texel buffer UAV-clear pipelines are
  made; the two for 1D-array images stay unusable, Unsupported below).
- 2026-11-28, under weston headless: mpv 0.40 with `--vo=gpu-next
  --gpu-api=vulkan` (libplacebo 7.349 takes kwvk: it needs
  timelineSemaphore and hostQueryReset) draws a 320x240 yuv420p clip
  right, 196 presents in 20 s; with an rgb24 source (lavfi testsrc,
  320x240), which libplacebo uploads through a storage texel buffer of
  R8_UNORM into an emulated RGBA8 texture, the frames are right too, more
  slowly (about 2 s of video in the 10 s the yuv420p source plays 5);
  the DDNet 19.1 client on Vulkan with its own SPIR-V (Unsupported
  below) draws its menu.
- llama.cpp (ggml-vulkan; not packaged in trixie: forky's wants glibc
  2.43): ggml selects kwvk and generates, cross-built for aarch64 by
  `test/vk/guest/build-llama.sh` and as llama.cpp's own release build
  (`llama-b12674-bin-ubuntu-vulkan-arm64.tar.gz`, which the page's
  llama.cpp app runs; web.md, Guest Vulkan; its older glslang's shaders
  need the translator's member-decoration rule above, without which WebGPU
  refused its first submit for binding aliasing). stories260K (F32, `-ngl
  99`, temperature 0) gives the CPU backend's text: 8.5 tokens/s in the
  guest (llama-simple, inline mode, one CPU; Performance below) against
  0.25 on the emulated CPU, 9.5 natively through the relay; the release build's llama-completion 5.1-6.9 tokens/s
  in the page (one CPU). Natively through the relay on SwiftShader with
  an unpatched llama.cpp (llama-simple, 32 tokens, `-ngl 99`): stories15M
  q4_0 gives the CPU backend's text at 1.0 tokens/s, SmolLM2 135M Q4_K_M
  "...dreams of becoming a detective. I spent years honing my skills,
  attending law school, ..." (the CPU backend's for its first 15 tokens)
  at 0.32 tokens/s, Qwen2.5 0.5B Q4_K_M at 0.11 tokens/s (24 tokens; the
  CPU backend's text differs from the fourth on). The subgroup size the
  ICD reports (32, before 1; vk/PROTOCOL.md, Amendments, "Subgroup size")
  sizes ggml's mat-vec, soft_max, argmax and sum_rows workgroups; the
  texts are the same at 1 and 32. Tokens/s at 1 and 32 natively through
  the relay: stories260K 9.9 and 5.0, stories15M q4_0 1.69 and 1.20,
  SmolLM2 0.33 and 0.32, Qwen2.5 0.12 and 0.16. The small models lose on
  SwiftShader: a mat-vec over 64 columns (stories260K's rows) or 8 (its
  attention heads) gives an invocation of 32 at most 2 elements, then a
  5-step shared-memory reduction, and SwiftShader pays on the CPU for
  every invocation and barrier (GGML_VK_PERF_LOGGER: its mat-vecs 30 ms
  a token at 1, 122 at 32); longer rows gain. On the user's GPU (Apple M4
  Pro, Chrome, the page, Qwen2.5 0.5B Q4_K_M, `KWVK_SUBGROUP_SIZE=32`
  before it was the default) 75 ms a token became 21.4 (13 to 47
  tokens/s; 18.8 ms with no GPU work), the same text. Compute shaders wider than the device's workgroup
  limit (ggml's are 512, SwiftShader allows 256) are split by the
  translator where they have no barriers or shared memory, and run as
  virtual invocations where they have (the norm family, soft_max_wg512,
  get_rows of the iq types). 139 of
  ggml's 156 shader variants translate and compile. Its
  `test-backend-ops` against the CPU backend (partial runs): GET_ROWS,
  SILU, SOFT_MAX, ROPE pass; CPY 209 of 211, ADD 90 of 97, MUL_MAT 209
  of 249; RMS_NORM, NORM, GROUP_NORM, L2_NORM, RMS_NORM_BACK, SOFT_MAX,
  CROSS_ENTROPY_LOSS(_BACK) and GET_ROWS 617 of 617 without bf16, RMS_NORM
  bf16 at 64 columns 11 of 11 (at 1025 the 512-wide bf16 variant is
  refused, which aborts the run). At subgroup size 32 and 1 alike: SOFT_MAX
  215, ARGMAX 7, SUM_ROWS 11, IM2COL 113, RMS_NORM f32 61 and
  GATED_DELTA_NET 81 (all but the replay variants, which are refused: 11
  storage buffers, a barrier WebGPU takes as non-uniform) pass; SSM_SCAN
  is not supported (ggml wants subgroup operations); MUL_MAT's mat-vec
  cases (n up to 8) of f32, f16, q4_0, q5_0, q8_0, q4_K and q6_K pass,
  449 of them, until a storage binding at offset 4480 (ggml's matmul
  binds a tensor view where it lies; 256 is reported), which WebGPU
  refuses; a dispatch now binds such a binding as a scratch copy (Errors
  below), and the cases after it have not been run with that. GATED_DELTA_NET
  failed all 16 cases tried at 32 before its subgroup builtins were
  lowered (SwiftShader's subgroups are not 32 wide).
- Ollama 0.40.18: its runner is llama.cpp's llama-server (b12651). It runs
  as its `bin/ollama` plus llama.cpp's own arm64 Vulkan build of that tag
  (the page's Ollama app; web.md, Guest Vulkan). Its discovery
  (`llama-server --list-devices` through the loader) finds "kwvk (WebGPU)"
  as an integrated GPU. It puts layers there only with
  `OLLAMA_IGPU_ENABLE=1` and `LLAMA_ARG_FIT_TARGET=64`, since
  llama-server's default target of 1 GiB free was more than kwvk's heap
  when that was half the guest's RAM (the device-only heap is 4 GiB now,
  `KWVK_HEAP_MB`: with half of a 2 GiB guest's RAM, Ollama put 18 of
  Qwen2.5 0.5B's 25 layers on the GPU, 2026-11-24). stories260K, made an Ollama model with F32 kept:
  - 6/6 layers on kwvk ("100% GPU") and right text.
  - 2.7-6.0 tokens/s in the guest (one CPU, the page and `/sh` runs).
  - 43 tokens/s on the guest's CPU, no layers offloaded.
  - 10.3 tokens/s natively through the relay.

  F16 weights run too. stories260K converted by llama-quantize gave the CPU
  backend's text with llama.cpp natively, and ran 100% GPU at 6.2 tokens/s
  with Ollama in the guest. rms_norm_mul_f32_512, where SmolLM2 135M and
  Qwen2.5-Coder 0.5B (F16) stopped on SwiftShader, is made there now (as
  virtual invocations); neither F16 model has been run since. The page's
  Ollama app offers the registry's quantized tags now (web.md, Guest
  Vulkan): llama.cpp b12651's own x86-64 Vulkan build, natively through
  the relay, ran Ollama's `qwen3:0.6b` (Q4_K_M) and `qwen3.5:0.8b` (Q8_0)
  GGUFs with every layer on kwvk, no pipeline refused, the token
  embeddings' lookup the only op on the CPU (2 graph splits), and sane
  text (2026-11-24). Ollama's `qwen3.5:0.8b` tag also carries an MTP
  draft, for which Ollama starts llama-server with speculative decoding:
  that needs the refused gated_delta_net replay variants, so the app
  takes `qwen3.5:0.8b-q8_0` (the same weights, no draft).
- Presentation: below.

## Device memory (2026-11-24)

vk/PROTOCOL.md, Amendments, "Device memory tracking", is the contract.

- Memory type 0 is DEVICE_LOCAL without a shadow, type 1 HOST_VISIBLE |
  HOST_COHERENT | HOST_CACHED with one (the shadow is the guest's RAM;
  DDNet maps only HOST_CACHED memory; ggml-vulkan, SDL3's GPU API and
  vkd3d pick type 0 and 1 for the same uses with or without the flag);
  there is no DEVICE_LOCAL | HOST_VISIBLE type.
  CPU writes to mapped memory are found by diffing the shadow against a
  last-sent copy at each submit, over the ranges its commands may read or
  write (descriptors as bound, copy regions, vertex, index and indirect
  buffers); GPU writes are known only from the
  commands, so the ICD tracks per buffer the byte ranges submitted work
  may write and reads them back when the app can look (a fence wait or
  wait-idle for mapped memory, else at vkMapMemory). Storage buffers
  count where Vulkan's consecutive binding updates put them (a write,
  copy or template entry spilling past a binding), at the range they were
  bound with plus the dynamic offset; texel buffers at their view's range
  (2026-11-28: read when bound, written when storage and the pipeline may
  write them). A rule that must hold: a range only
  shrinks to what the command says exactly; when unsure, the whole buffer.
  Words the CPU changed meanwhile keep the CPU's value.
- Why no DEVICE_LOCAL | HOST_VISIBLE type: kwvk is an integrated GPU, and
  ggml-vulkan then asks for that type first for every device buffer and
  keeps it mapped (`ggml-vulkan-buffers.cpp`, `ggml_vk_create_buffer_device`;
  on a discrete GPU it does the same when such a type shares the first
  device-local heap, "rebar"), so its compute buffer and KV cache would be
  read back at every token: for stories260K F32 192 KB a token even with
  ranges (ggml binds whole tensors), for real models their full size.
  Without it ggml gets device-only memory and moves data by staging
  copies, as on a discrete GPU without ReBAR. SDL3's GPU API then puts its
  uniform buffers in type 1 (testgpu_spinning_cube and testgpu_simple_clear
  30 FPS as before; its "Out of BAR memory" warning is below SDL's default
  log priority). vkcube, vkmark, GTK 4's Vulkan renderer and vkd3d-gears
  run as before. Reporting a
  discrete GPU instead would not have helped ggml by itself (rebar) and
  would change how Mesa, GTK and Ladybird pick devices.
- Measured (llama-simple, stories260K F32, `-ngl 99`, 32 tokens, temperature
  0; SwiftShader; text the same in every case: "Once upon a time, there was
  a little girl named Lily..."). Read back at load / per decode:

  | ICD | load | per decode | native (relay) | guest (inline, one CPU) |
  | --- | --- | --- | --- | --- |
  | before (spill-over untracked) | 45.8 MB in 44 readbacks | 2080 B | 8.8 tokens/s | 5.1-7.6 (4 runs, three of them 6.2-7.6) |
  | spill-over tracked, whole buffers, DL+HV type | 45.8 MB | 235 KB | 8.8 | not run |
  | spill-over tracked, ranges, DL+HV type | 1.0 MB | 192 KB in 7 readbacks | 9.0 | 6.8 (1 run) |
  | now | 0 | 2048 B (the logits, one copy) | 8.8 | 4.8-5.8 (4 runs) |

  The load readback was each weight upload chunk (a vkCmdCopyBuffer from
  ggml's pinned staging) re-reading the whole 1 MB weight buffer. Now
  ggml uploads each per-token input tensor (tokens, positions, mask, ...)
  with its own copy and fence wait: 405 submits (260 with a fence) for
  the run against 180 (67); per-token readback no longer grows with the
  model. Those fences now signal at their submit (Performance below), as
  the copies write device-only memory.
- Fences: a fence of a submit that writes no host-visible memory signals
  at the submit (its reply is collected later, an error losing the device
  at the next wait or submit; at most 8 unanswered), the others at the
  reply; vkGetFenceStatus of a pending fence waits up to 1 ms in the
  kernel from its second call (vk/PROTOCOL.md, Amendments, "Fences at
  submit"; `KWVK_FENCE_SYNC=1` waits for every reply).
- Timeline semaphores (timelineSemaphore, VK_KHR_timeline_semaphore):
  values follow the fences' rule, so vkGetSemaphoreCounterValue and
  vkWaitSemaphores answer without a round trip for submits that write no
  host-visible memory (mpv's libplacebo, 2026-11-28: 981 submits, one sync
  request, in 20 s). A queue wait for a value nothing has given yet holds
  that submit and every later one in the ICD until vkSignalSemaphore or an
  earlier held submit gives it; vkQueueWaitIdle, vkDeviceWaitIdle and
  vkQueuePresentKHR wait for the release (vk/PROTOCOL.md, Amendments,
  "Timeline semaphores"; `KWVK_DEBUG` logs each hold).
- Open: two VkBuffers bound to overlapping ranges of one memory are two
  GPU buffers on the host: a GPU write through one is not seen through the
  other.

## Performance (2026-11-24)

Language models through ggml-vulkan (llama.cpp, Ollama) were slow for
reasons that do not depend on the GPU: on the user's GPU (Chrome,
Qwen2.5-Coder 0.5B F16, Ollama) a decode pass took 565 ms (1.8 tokens/s)
and the load minutes. Measured on this host's SwiftShader with
`test/vk/unkernel-check.mjs --nogpu` (dispatches encoded but not run, so
the time is the guest's, the link's and the host's alone; vk-host.ts
`noGpu`), `--mem 3072`, `--disk` a copy of the prepared disk with
llama.cpp's cross-built `llama-completion` and the models written into its
upper layer under /opt/llm by `debugfs -w`, and `llama-completion -ngl 99
-c 1024 --temp 0 --ignore-eos -n 104 -p "Once upon a time"`; `--profile N`
for instruction samples of the guest (diffed between an 8- and a 104-token
run to keep the load out).

| Qwen2.5-Coder 0.5B F16, no GPU work | load | prompt (4 tokens) | eval |
| --- | --- | --- | --- |
| before, inline, one CPU | 137.5 s | 740 ms a token | 1588 ms a token |
| submit flush by ranges | 16.5 s | 228 | 88.5 |
| and the fence status wait, merge fast path | 17.2 | 233 | 41.7 |
| now (and fences at submit, coarser diff), inline | 16.2 | 217 | 41.4 |
| before, worker mode, 4 CPUs | 145.0 | 717 | 1649 |
| now, worker mode, 4 CPUs | 15.5 | 203 | 39.1 |

Fences at submit save little here, where a round trip costs 0.3-0.8 ms
(no GPU work, the host on the same thread); on a real GPU each saved one
also waited for the GPU's queue (`onSubmittedWorkDone`).

- Where it went: every vkQueueSubmit diffed every mapped byte of
  host-visible memory, and ggml keeps its CPU-side tensors (the token
  embeddings: 272 MiB for Qwen, 57 MiB for SmolLM2 135M) and its staging
  in mapped pinned memory: 102 ms a submit for Qwen, 14 submits a token
  and one per uploaded weight chunk at load. The flush now covers only
  what the submit's commands may read or write (vk/PROTOCOL.md,
  Amendments, "Submit flush").
- Then: ggml spins on vkGetFenceStatus at the end of each graph (44% of
  the guest's instructions per token), and in inline mode the host cannot
  answer while the guest's CPU is busy; each token had 9 round trips (7
  fence waits, among them 5 waited input uploads, and the logits
  readback). Now one readback a token.
- Left per token (instruction samples): ggml's graph building and fusion
  checks, llama.cpp's sampling over Qwen's 151936 tokens (10%), the
  ICD's JSON (about 12%: push constants as decimal byte arrays, 16 KiB of
  JSON a submit, 470 dispatches a token), the readback of 608 KB of
  logits. Of the load, 6.3 s is reading the 994 MB file from the disk
  (HTTP in the test; IndexedDB on the page), most of the rest llama.cpp
  and the upload (995 MB of writeBuffer frames).
- stories260K F32 with its GPU work (llama-simple, 32 tokens, inline):
  5.9 tokens/s before, 8.5 now, the same text. SmolLM2 135M F16 without
  GPU work: eval 529 ms a token before, 91 ms after the flush alone; load
  20.1 s, then 9.5 s.
- Not measured on a real GPU: its decode time adds the GPU's work and the
  latency of one readback (mapAsync) a token. Pipelines are made as ggml
  asks, one request each (the first prompt waits for them).

## Presentation (2026-11-24)

- Wayland on the page's wland: external buffers (vk/PROTOCOL.md,
  Amendments, "External present"). Where the hello has a token (the SDK's
  canvas probe passed), the compositor advertises
  `wland_external_buffer_manager_v1` (a relay with `--external-buffers`,
  which the base's `wland` launcher passes where `wlandr --version` lists
  `external-buffers`, and a page with `resolveExternal`: web.md, Wayland
  desktop) and the swapchain is B8G8R8A8, the ICD makes one wl_buffer per
  swapchain image named (token << 32) | export id, and a present is a
  request without pixels whose reply (after the validation of earlier
  submits) comes before the commit. The page resolves each commit with
  `vm.vk.externalImage()`: a copy of the GPUTexture into a WebGPU
  OffscreenCanvas on the renderer's device, `transferToImageBitmap()`
  (synchronous: the renderer is on the page's thread in both modes, so
  no worker crossing). The image is acquired again only after its
  wl_buffer's release; a swapchain's destroy waits up to 250 ms for
  releases before the images go. `KWVK_EXTERNAL=0` forces readback.
- Else readback: the frame's pixels cross vsock and are copied into a
  wl_shm buffer (other compositors, e.g. weston in the guest; an older
  relay; `?wlgpu=0`; the probe failed) or by XPutImage (X11 always).
- Measured (test/vk/unkernel-check.mjs step w, one CPU, vkcube IMMEDIATE
  through wland/headless after a warm-up, each case twice in alternating
  order, frames/s over 6 s; SwiftShader on this host's CPU):

  | | external | readback |
  | --- | --- | --- |
  | 500x500 inline | 100.0, 98.9 (10.0 ms a frame) | 77.4, 78.6 (12.8 ms; 1 MB a frame) |
  | 1280x720 inline | 36.8, 31.7 (27-32 ms) | 33.6, 33.0 (30 ms; 3.6 MB a frame) |
  | 500x500 worker | 103.2, 102.4 (9.7 ms) | 94.1, 99.1 (10.4 ms) |
  | 1280x720 worker | 36.1, 36.0 (27.7 ms) | 40.4, 39.6 (25 ms) |

  No byte read back and no wait for releases (ICD `acquire` 0 ms) on the
  external path; the resolver takes 0.1 ms (page-check: 0.12 ms worker,
  0.61 ms inline; wland's draw 0.26-1.25 ms). On SwiftShader the GPU work
  is CPU work too: the readback's copy and transfer are traded for a
  page-side copy into the canvas and a new canvas texture per frame, a
  gain at 500x500 and none (worker mode: a loss of 10%) at 1280x720.
  Nothing measured on a real GPU, where the readback's map stalls the
  pipeline and the copy is cheap. The probe makes the renderer's load
  about 60 ms longer (90-120 ms against 30).

## Unsupported and open (2026-11-24)

- Not offered: geometry and tessellation shaders,
  1D-array storage images (WGSL has none), linear-tiling images,
  robustBufferAccess, logicOp, fillModeNonSolid, wide
  lines, large points, shaderInt16/Int64/Float64, pipeline statistics
  queries, sparse resources; subgroup clustered reductions, elect and
  ballot counts in shaders (naga lacks them).
- vkQuake 1.34 (2026-11-28, its 51 shaders compiled with glslang 16.2,
  translated and compiled in WebGPU): 42 pass. Image atomics (storage
  class Image) stop the 4 ssao_mip shaders, physical storage buffers
  mesh_interpolate and skinning, ray queries ray_debug, Tint's
  uniformity rule update_lightmap (a barrier in non-uniform control
  flow); world.vert uses set 4 and push constants, more bind groups than
  WebGPU's default maxBindGroups (4).
- Texel buffers (2026-11-28; vk/PROTOCOL.md, Amendments, "Texel
  buffers"): each takes one storage buffer and one uniform buffer slot of
  every stage that uses it (WebGPU's maxStorageBuffersPerShaderStage,
  often 8, and maxUniformBuffersPerShaderStage, 12): past either the
  pipeline is refused, naming the counts, where a Vulkan driver counts
  texel buffers apart from storage buffers. A storage texel buffer a
  vertex stage writes cannot work (WebGPU has no writable storage in
  vertex shaders: refused). Not supported: descriptor arrays of texel
  buffers, texel buffers passed to functions, view formats outside the
  hello's list (sRGB, 3-byte, 64-bit, packed 16-bit and E5B9G9R9 among
  them; B10G11R11 is uniform only), atomics other than on R32_UINT and
  R32_SINT. A storage texel buffer the module writes whose SPIR-V format
  is 8/16-bit or Unknown (vkd3d's UAV clears) has atomic words, every
  access to it atomic. Measured only on SwiftShader.
- Vulkan 1.2 requirements left: uniformBufferStandardLayout is false (it
  needs every std430 uniform block translated for every engine; the
  translator leaves blocks with 8/16/64-bit or bool members, or used other
  than through access chains and loads, to Chrome's
  uniform_buffer_standard_layout, which Firefox and Safari lack), and
  VkPhysicalDeviceSubgroupProperties.supportedStages is 0, where Vulkan
  1.1 wants COMPUTE (it needs subgroupElect, subgroupBarrier,
  subgroupMemoryBarrier* and the subgroup builtins in compute shaders on
  every adapter: the builtins are lowered only in modules without
  subgroup operations, naga lacks elect, WGSL has no subgroup barrier).
- Mesa's zink: low priority (guest GL has virgl). Mesa 25.0 (Debian 13)
  never picks zink while virgl works, and with no DRM device EGL (Wayland,
  surfaceless) and GLX (Xvfb) take llvmpipe (2026-11-28). Forced
  (`GALLIUM_DRIVER=zink`; not run since texel buffers work), zink takes kwvk and warns that logicOp,
  fillModeNonSolid, scalarBlockLayout, custom border colours and line
  rasterization are missing. After a virgl failure GLX on a DRI3 X server
  would try zink on the first Vulkan device (kwvk), so the base profile
  (`guest/base/rootfs/etc/profile.d/kw-gl.sh`) exports
  `LIBGL_KOPPER_DISABLE=1`; that path is unconfirmed (no DRI3 X server in
  the tests: Xvfb has none, Xwayland is not on the disks). EGL on Wayland
  skips kwvk only because it has no VK_EXT_physical_device_drm: keep zink
  off EGL before offering it.
- Debian's games (trixie, 2026-11-28): taisei 1.4.1 has no Vulkan
  renderer (SDL2; `--renderer {gl33,null}`); ddnet 19.1-2 ships no Vulkan
  SPIR-V (data/shader/vulkan is missing), so its client falls back to
  OpenGL; with the 38 modules compiled from its 19.1 sources by host
  glslang 16.2 placed where it looks ($CURRENTDIR/shader/vulkan), it
  draws its first-run menu on kwvk (699 presents, 18402 draws in about
  60 s, no errors). vkQuake is only in forky and sid.
- llama.cpp: some pipelines are refused, and ggml aborts at the first it
  needs (2026-11-24, every variant ggml declares on a 256-invocation
  device: 1807 of 1854 compile). Tint's uniformity analysis
  (`workgroupBarrier` outside uniform control flow) refuses
  quantize_q8_1_x4 (an early return before its barriers), rwkv_wkv6/7 and
  gated_linear_attn (loop bounds that depend on the invocation),
  count_experts and topk_radix (branches on workgroup memory before
  barriers); count_experts stops MUL_MAT_ID, so mixture-of-experts models
  abort although the matmul_id pipelines are made (with their read-only
  buffers kept: vk/PROTOCOL.md, Amendments, "Read-only buffers kept").
  Speculative decoding of gated-delta-net models (Ollama's Qwen3.5 tags
  with an MTP draft) needs gated_delta_net's replay variants, refused (11
  storage buffers). On a 256-invocation device the 512-wide bf16 rms_norm variants and
  rms_norm_mul_rope_*_512 are refused (their barriers are in a function
  spirv-opt did not inline, which virtual invocations do not take).
  Eval is bound by GPU time on SwiftShader
  natively, and in the guest also by ggml's waited copies (Device memory
  below). Never run on a real GPU.
- Chrome-specific reliances: the `texture-component-swizzle` feature
  (image view swizzles; identity without it, logged), and WGSL's
  `uniform_buffer_standard_layout` only for a uniform block the
  translator cannot repack (none in ggml's shaders or the corpus; then
  `requires` names it and other browsers refuse the pipeline with that
  name). Firefox and Safari have not been run: the WGSL is checked
  against naga's WGSL front end (Firefox's compiler) only.
- A descriptor set that the pipeline's shaders use but the app never
  binds (GTK binds no set 1; 3 of GTK 4.18's 17 fragment shaders use
  it, 2026-11-28) gets placeholder resources, logged once. So does a
  binding of a bound set that the app left unwritten (a buffer, texture
  or sampler; logged once per connection); a sampler binding with
  immutable samplers needs no write.
- Rendering approximations kept, logged by the host (not errors): polygon
  modes drawn filled, logic ops, component swizzles without the feature,
  view formats other than the image's (or its sRGB twin), indirect draws
  of triangle fans drawn as lists (indexed fans are rewritten as lists
  before their render pass), CLAMP_TO_BORDER as clamp-to-edge,
  unnormalizedCoordinates ignored, timestamps inside render passes read 0,
  layered rendering to layer 0 only. Not logged: events set by a command
  buffer never reach vkGetEventStatus.
- Open in the host (2026-11-28): block-compressed images whose base size
  is not a whole number of blocks (Vulkan allows a 6x6 BC image) fail at
  creation, as WebGPU wants whole blocks; a storage or uniform binding at
  an offset that is not a multiple of the device's alignment loses the
  device in a draw (a render pass cannot copy it aside), and a misaligned
  dynamic offset anywhere; the rewrite of an indexed fan runs on one GPU
  invocation per draw, so it is slow for large index counts (unmeasured).

## Errors (2026-11-24)

What the host cannot do reaches the app as a Vulkan error and the user as
a line on the guest's stderr (`kwvk: ...`) and on the host's log
(`[vk] kwvk: ...`, counted in `stats.renderer.errors`); vk/PROTOCOL.md,
Amendments, "Loud failures", is the contract.

- At the call: pipelines are requests whose reply waits for WGSL
  compilation and WebGPU's validation, so vkCreate{Compute,Graphics}Pipelines
  returns VK_ERROR_INVALID_SHADER_NV (translation or Tint errors, e.g. a
  barrier in non-uniform control flow, a 512-wide workgroup with shared
  memory on a 256-invocation device that cannot run as virtual
  invocations) or VK_ERROR_FEATURE_NOT_PRESENT
  (adjacency or patch topologies), with the reason. Pipelines that only
  declare 1D-array storage images are made "unusable" (vkd3d
  makes such pipelines at start-up and never runs them): binding one makes
  vkQueueSubmit lose the device. The ICD refuses buffers over maxBufferSize,
  images of unlisted formats and buffer views of formats the hello does
  not list for the buffer's texel usages.
- Later: a submit the host cannot encode or WebGPU refuses (it drops the
  whole submit), a failed request without a reply, or the use of an object
  whose creation failed loses the device for that connection only
  (`stats.renderer.lost`): the next wait, submit or present returns
  VK_ERROR_DEVICE_LOST, and the program can make a new device. Replies that
  carry data wait for the validation of earlier submits, as does an
  external present's (so a failed frame never reaches the compositor). A
  refused exportImages is not an error: that swapchain presents by
  readback. The page's resolver gives null (the window keeps its last
  content) for any id no live connection made, a destroyed or never
  presented image, and after a device loss.
- A storage or uniform binding at an offset that is not a multiple of the
  device's min{Storage,Uniform}BufferOffsetAlignment is bound as a
  scratch copy in a dispatch (copied back when writable); in a draw it
  loses the device, naming the offset.
- Measured 2026-11-24 natively through the relay (SwiftShader): llama.cpp
  stories260K F32 gives the same text at the same speed (eval 9.7-9.8
  tokens/s, prompt 4.9-5.1 s; 9.4 and 5.0 before).
