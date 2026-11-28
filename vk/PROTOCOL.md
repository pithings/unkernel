# kwvk: guest Vulkan on the page's WebGPU

```
app -> Vulkan loader (libvulkan1) -> libvulkan_kw.so (vk/icd, the guest's ICD)
    -> AF_VSOCK, host CID 2, port 1018 (one stream per VkInstance)
    -> VsockHost -> VkHost (js/core/vk.ts) -> VkRenderer (js/core/vk-host.ts)
    -> SPIR-V to WGSL (vk/naga, wasm; js/core/vk-shader.ts) -> WebGPU (GPUDevice)
```

No kernel changes, no Mesa. The ICD is thin: it keeps guest-side state
(device memory shadows, fences, command recording) and sends everything
else to the host, which implements it in TypeScript on WebGPU. Browser
only. Vulkan 1.0 subset; what is unsupported is refused at the ICD, or
reaches the app as a Vulkan error (a refused pipeline, a lost device), never
as a silently wrong result where avoidable (Amendments, "Loud failures").

This file is the contract between the ICD, the host and the shader
translator. If you must deviate, change this file in the same edit and add
a line under Amendments (bottom) so the other side sees it.

## Link

`KWVK_LINK` in the ICD's environment: `vsock:CID:PORT` (default
`vsock:2:1018`), `tcp:HOST:PORT` or `unix:PATH` (the last two for native
tests through `test/vk/relay.mjs`).

## Framing (both directions, little endian)

```
u32 total   bytes after these 8
u32 jsonLen bytes of UTF-8 JSON
json[jsonLen], zero padding to a multiple of 4, then binary (total - padded jsonLen bytes)
```

A request with `"r": N` (N > 0, unique per connection) gets exactly one
reply `{"r": N, ...}` (maybe with binary), or `{"r": N, "err": "text"}`.
Requests without `r` get no reply: when one fails the host ends the
connection as a lost device (`{"r":0,"lost":"why"}`, then the close), except
creations, whose ids become tombstones that fail at first use (Amendments,
"Loud failures").
Replies may come in any order relative to other replies. The host
processes requests strictly in order.

## Conventions

- `op` is the Vulkan function name where one exists. Its fields are the
  Vulkan parameter and struct member names verbatim (`createInfo` members
  are flattened into the message). Nested structs are objects, arrays are
  arrays (their count members are omitted), enums and flags are numbers
  with Vulkan's values, VkBool32 is 0/1, 64-bit values are JSON numbers,
  floats are JSON numbers. `pNext` is ignored unless listed here. No
  `device`, `instance` or allocator fields.
- Handles are u32 ids chosen by the guest, non-zero, unique per connection
  across all object types. A created object's id is the field `id`.
  VK_NULL_HANDLE is 0.
- `{"op":"destroy","ids":[...]}` destroys any objects (the host defers what
  WebGPU still needs).

## Hello

`{"op":"hello","r":1,"version":1,"subgroupSize":N,"engineName":"..."}` ->
```
{"r":1,"version":1,
 "adapter":{"vendor":"","architecture":"","device":"","description":""},
 "limits":{ every GPUSupportedLimits member of the device },
 "features":[ GPUFeatureName of the device ],
 "formats":{ "<VkFormat number>": caps, ... },
 "subgroupSize":S,
 "texelBuffers":{"formats":{ "<VkFormat number>": bits, ... },"maxElements":N},   (Amendments, "Texel buffers")
 "external":{"token":T}}   (only where the host offers external present: Amendments, "External present")
```
`subgroupSize`: the subgroup size the ICD reports, which the host
translates compute shaders for (Amendments, "Subgroup size").
`engineName`: the app's VkApplicationInfo.pEngineName, when it gave one
(Amendments, "Y flip hint").
caps bits: 1 sampled, 2 linear filter, 4 colour attachment, 8 blend, 16
depth/stencil attachment, 32 storage image, 64 vertex attribute format.
Only formats the host can map are listed; the ICD derives
VkFormatProperties, VkPhysicalDeviceLimits and features from this reply
alone (it has no format table of its own). One queue family (graphics,
compute, transfer), one queue.

## Memory and buffers

VkDeviceMemory is guest-only. No message. Two memory types: 0
DEVICE_LOCAL (no shadow: nothing is diffed or read back), 1 HOST_VISIBLE |
HOST_COHERENT (a malloc'd shadow); no DEVICE_LOCAL | HOST_VISIBLE type
(Amendments, "Device memory tracking"). Images have no CPU-visible data
(linear-tiling images are unsupported); only buffers carry data.

- `vkCreateBuffer {id,size,usage}`: the host makes a GPUBuffer (size
  rounded up to 4, to 16 with UNIFORM_BUFFER usage; COPY_SRC | COPY_DST |
  STORAGE always added); writes, reads and copies stay within the Vulkan
  size.
- `{"op":"writeBuffer","buffer":id,"offset":o}` + binary: guest to host.
  The ICD sends the bytes of host-visible memory that changed since it last
  sent them (it keeps a last-sent copy and diffs; unmapped and never-written
  memory sends nothing): before each vkQueueSubmit, for the ranges of
  buffers that the submitted commands may read or write (Amendments,
  "Submit flush"), and at vkUnmapMemory and vkFlushMappedMemoryRanges, for
  the whole memory.
- `{"op":"readBuffer","r":N,"buffer":id,"offset":o,"size":s}` -> reply
  with the bytes as binary. The ICD tracks the byte ranges of buffers the
  GPU may have written (copy destinations, storage buffers in descriptor
  sets bound at a draw or dispatch) and reads them back into the shadow
  (and the last-sent copy) when a fence wait, vkQueueWaitIdle or
  vkDeviceWaitIdle completes, at vkMapMemory and at
  vkInvalidateMappedMemoryRanges (Amendments, "Device memory tracking").

## Objects (host-side)

`vkCreateImage`, `vkCreateImageView`, `vkCreateSampler`,
`vkCreateShaderModule` (binary: the SPIR-V), `vkCreateDescriptorSetLayout`,
`vkCreatePipelineLayout`, `vkCreateRenderPass`, `vkCreateFramebuffer`,
`vkCreateGraphicsPipelines` and `vkCreateComputePipelines` (one message
per pipeline, `id` each; `stages[].specializationInfo` as
`{"mapEntries":[{constantID,offset,size}],"data":[bytes]}`),
`vkCreateBufferView` (Amendments, "Texel buffers").

Guest-only (no message): instance, physical device, device, queue,
memory, fences, semaphores, events, command pools, descriptor pools,
pipeline caches, binding memory to buffers and images.

Descriptor sets: `{"op":"vkAllocateDescriptorSets","sets":[{"id","layout"}]}`,
`vkUpdateDescriptorSets {descriptorWrites:[{dstSet,dstBinding,dstArrayElement,
descriptorType,imageInfo:[{sampler,imageView,imageLayout}],
bufferInfo:[{buffer,offset,range}]}],descriptorCopies:[...]}` (range -1 =
VK_WHOLE_SIZE), freed with `destroy`.

## Command buffers and submit

The ICD records each command buffer as a JSON array of commands and sends
them at submit; secondary command buffers are inlined by the ICD at
vkCmdExecuteCommands.

```
{"op":"vkQueueSubmit","cmds":[{"c":"vkCmdBeginRenderPass",...},{"c":"vkCmdDraw",...},...],"r":N?}
```
`cmds` is the concatenation of the submitted command buffers. Each
command's fields are the Vulkan parameter names (no `commandBuffer`);
`vkCmdBeginRenderPass` flattens `renderPassBegin`; byte data
(`vkCmdPushConstants.values`, `vkCmdUpdateBuffer.data`) is an array of
byte values. With `r` the host replies `{"r":N}` once the GPU has finished
this submission (`queue.onSubmittedWorkDone()`): the ICD sends `r` when
the submit has a fence and signals it at the reply (or at the submit, when
its commands write no host-visible memory: Amendments, "Fences at
submit"). `{"op":"sync","r":N}`
replies when everything submitted so far is done (vkQueueWaitIdle,
vkDeviceWaitIdle).

## Shaders and coordinates

The host translates SPIR-V per pipeline stage with
`translate(spirv, opts)` (js/core/vk-shader.ts, below). Fixed rules both
sides rely on:

- Clip space: vertex shaders get `position.y` negated by the translator,
  so texture memory has Vulkan's orientation and viewports and scissors
  pass through unchanged. `frontFace` passes through too (both APIs judge
  winding in framebuffer space, which the flip keeps). Negative viewport
  heights (VK_KHR_maintenance1) work: the host draws with the vertex stage
  translated without the flip and the viewport normalized (which of the
  two a pipeline is made with first: Amendments, "Y flip hint").
- Bindings: WGSL `@group(set) @binding(2 * vkBinding)`; the sampler half
  of a COMBINED_IMAGE_SAMPLER is at `2 * vkBinding + 1`. Descriptor arrays
  are unsupported.
- Push constants: a uniform buffer at `@group(pushGroup) @binding(0)`
  where `pushGroup` = the pipeline layout's set count (so at most 3 sets
  with push constants), filled by the host from vkCmdPushConstants.
- Specialization constants are applied by the translator from the values
  the host gives it.

```ts
// js/core/vk-shader.ts
export interface VkShaderOpts {
  stage: "vertex" | "fragment" | "compute";
  entryPoint: string;                       // the SPIR-V entry point name
  flipY?: boolean;                          // vertex: negate position.y
  pushGroup?: number;                       // group for the push constant block
  spec?: Record<number, number | boolean>;  // constantID -> value
  arrays?: Record<string, { base: number; count: number }>;  // "set.binding" -> descriptor array numbering (Amendments)
  link?: { location: number; interpolation: string; sampling: string }[];  // fragment: the vertex result's `varyings`
  storageFormats?: Record<string, string>;  // "set.binding" -> WebGPU format for storage images declared without one
  features?: string[];  // the device's WebGPU features; "shader-f16" keeps float16_t native (Amendments)
  limits?: { maxComputeWorkgroupSizeX: number; maxComputeWorkgroupSizeY: number;
             maxComputeWorkgroupSizeZ: number; maxComputeInvocationsPerWorkgroup: number };  // compute (Amendments)
  subgroupSize?: number;  // compute: the reported subgroup size (Amendments, "Subgroup size")
}
export interface VkShaderResult {
  wgsl: string;
  entryPoint: string;                       // the WGSL entry point name
  bindings: { set: number; binding: number; group: number; wgslBinding: number;
              kind: "uniform" | "storage" | "read-only-storage" | "sampler" | "comparison-sampler" | "texture" | "storage-texture";
              viewDimension?: string; sampleType?: string; multisampled?: boolean; format?: string; access?: string;
              arrayIndex?: number; texel?: "data" | "params" }[];  // texel: Amendments, "Texel buffers"
  pushConstantSize?: number;
  varyings?: { location: number; interpolation: string; sampling: string }[];  // vertex: outputs
  requires?: string[];  // WebGPU features the WGSL needs (Amendments)
  dispatchScale?: [number, number, number];  // compute: multiply dispatch group counts (Amendments)
}
export interface VkShaderTranslator { translate(spirv: Uint8Array, opts: VkShaderOpts): VkShaderResult }  // throws Error(text) on failure
export function loadVkShader(wasm: BufferSource | Response | Promise<Response> | URL | string): Promise<VkShaderTranslator>;
```

## Host API (what the SDK wires)

```ts
// js/core/vk-host.ts
export class VkRenderer {
  constructor(opts: { device: GPUDevice; adapter?: GPUAdapter; shaders: VkShaderTranslator;
                      log?: (line: string) => void });
  connect(send: (bytes: Uint8Array) => void): VkConnection;   // one per guest stream
}
export interface VkConnection { feed(bytes: Uint8Array): void; close(): void }  // feed takes arbitrary chunks
```

Also exported (see Amendments): `vkDeviceDescriptor(adapter)` (the
GPUDeviceDescriptor to create the renderer's device with: the optional
features it uses and the adapter's best limits), `VK_FEATURES`, the
`onPresent?(info)` renderer option and `connection.lastPresented`
(`{connection, image, texture, width, height, format}`).

## Presentation (WSI)

The ICD offers VK_KHR_surface, VK_KHR_wayland_surface, VK_KHR_xcb_surface
(if cheap) and VK_EXT_headless_surface, and VK_KHR_swapchain. Swapchain
images are ordinary images the ICD creates with `vkCreateImage` (ids its
own); acquire is guest-side round robin (FIFO and IMMEDIATE alike).

`{"op":"present","r":N,"image":id,"readback":1}` -> `{"r":N,"width":w,
"height":h,"stride":w*4}` + binary: the image's level 0 as tightly packed
rows in the image's own byte order (B8G8R8A8 stays BGRA), top row first.
The ICD copies them into a wl_shm buffer (or XPutImage) and commits. With
`"readback":0` (headless surface) the reply has no binary. The host also
keeps the last presented texture per connection (`lastPresented`).
Wayland surfaces on the page's wland present without pixels where both
sides can (Amendments, "External present").

## Amendments

- Host (2026-11-24): `frontFace` is NOT inverted. With the translator's y
  negation a vertex lands on the same framebuffer pixel as in Vulkan, and
  WebGPU, like Vulkan, judges winding in framebuffer space; verified in
  test/vk/host/check.mjs (a clockwise triangle with CW front faces and
  back-face culling draws, with inversion it is culled).
- Host: field names may come with or without Vulkan's pointer prefix: the
  host strips `p`/`pp` before an upper-case letter from every key
  (`pStages` -> `stages`, `pName` -> `name`, `pDynamicOffsets` ->
  `dynamicOffsets`, `pSampleMask` -> `sampleMask`, `pImmutableSamplers` ->
  `immutableSamplers`), so both spellings work.
- Union values: a VkClearValue is sent as
  `{"color":{"float32":[4],"int32":[4],"uint32":[4]},"depthStencil":{"depth":d,"stencil":s}}`
  with every member decoded from the same 16 bytes (send what you can; the
  host picks `uint32`/`int32` for integer formats, `float32` otherwise,
  bit-reinterpreting from another member when its pick is missing).
  vkCmdClearColorImage's `color` is the `color` object alone,
  vkCmdClearDepthStencilImage's `depthStencil` the `depthStencil` object.
- Specialization: the host types each value by the SPIR-V's own
  declarations (OpSpecConstant* result type: float, signed or unsigned int,
  bool) and passes the translator the value itself (1.5, -3, true), not raw
  bits.
- writeBuffer: offset and length must be multiples of 4 (WebGPU's
  queue.writeBuffer rule): the ICD widens its diff ranges to 4-byte
  boundaries (buffer sizes are rounded up to 4 host-side, so a widened tail
  stays in range). The host pads an unaligned tail only past the Vulkan
  size and otherwise answers/logs an error.
- Pipelines: the host builds bind group layouts from the translator's
  reflection (union over the pipeline's stages), not from the set layout
  alone; bindings a pipeline's shaders do not use need not be written.
  Push constants are at most 256 bytes.
- Translator (2026-11-24): `bindings` lists only the descriptor-set
  resources the entry point reaches (through the functions it calls,
  after branches on baked constants are dropped), in every stage, and the
  WGSL declares only those; the push constant block is NOT in it: when
  `pushConstantSize` is set, the stage reads a uniform buffer at
  `@group(pushGroup) @binding(0)` of at least that many bytes (the block's
  WGSL size, which covers a later stage's `layout(offset = N)` range: such
  a block is padded so member offsets equal Vulkan's, i.e. the host writes
  the push constant bytes at their Vulkan offsets). `binding` is the Vulkan
  binding (`wgslBinding >> 1`), so a combined image sampler appears twice,
  as `texture` and `sampler`/`comparison-sampler`. Texture `sampleType` is
  `float`, `sint`, `uint` or `depth` (never `unfilterable-float`); storage
  texture `access` is `read-only`, `write-only` or `read-write`, `format`
  WebGPU's name. The WGSL text has no `override`s (spec constants are
  baked, also into array sizes and the workgroup size). Shaders writing
  `gl_ClipDistance` come out with `enable clip_distances;`: create the
  device with the `clip-distances` feature where the adapter has it.
  `gl_PointSize` writes are dropped (WebGPU points are 1 px).
- Host API: `vkDeviceDescriptor(adapter)` gives the device descriptor the
  SDK should create the renderer's GPUDevice with (optional features such
  as `float32-filterable`, `depth32float-stencil8`, `texture-compression-*`
  when the adapter has them, and the adapter's limits); the hello reply
  reflects whatever device the renderer got. `onPresent?(info)` is called
  at each present and `connection.lastPresented` holds the last one.
- ICD (2026-11-24): readBuffer is sent per GPU-written range (`offset`
  and `size` multiples of 4; "Device memory tracking" below). At a fence
  wait or wait-idle the ICD reads back only GPU-written buffers whose
  memory is mapped at that moment; the others stay marked and are read at
  vkMapMemory or vkInvalidateMappedMemoryRanges.
- ICD: the ICD also offers VK_KHR_xcb_surface and VK_KHR_xlib_surface
  (xcb_put_image through a dlopen'ed libxcb; Xlib through
  XGetXCBConnection), presenting with `"readback":1` like Wayland. It
  creates its own VkIcdSurface* structs (newer loaders require that at ICD
  interface version >= 3). `KWVK_DUMP=FILE` (debugging) makes every present
  ask for readback, headless included, and writes the frame as a PPM.
- ICD: `viewportState` carries `viewportCount` and `scissorCount` (the
  arrays are absent when those states are dynamic). With
  `rasterizerDiscardEnable` the viewport, multisample, depth/stencil and
  colour blend states are omitted. Layout bindings carry
  `immutableSamplers` (ids) only for sampler types; texel buffer
  descriptors are written as `texelBufferView:[ids]` (Amendments, "Texel
  buffers").
- ICD: the physical device reports VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
  and apiVersion 1.1 (round 2); maxBoundDescriptorSets is the host's maxBindGroups
  (a layout with that many sets and push constants fails in
  vkCreatePipelineLayout: the push constant group), maxPushConstantsSize 128.
- Host (2026-11-24, round 2): the host also takes these (the ICD may
  start sending them; field names as Vulkan's, pointer prefixes optional):
  - Dynamic rendering: `vkCmdBeginRendering {renderArea, layerCount,
    viewMask, colorAttachments:[{imageView, imageLayout, resolveMode,
    resolveImageView, resolveImageLayout, loadOp, storeOp, clearValue}],
    depthAttachment, stencilAttachment}` (same attachment shape; imageView
    0 = unused) and `vkCmdEndRendering`. A graphics pipeline with
    `renderPass` 0 carries `rendering:{viewMask, colorAttachmentFormats,
    depthAttachmentFormat, stencilAttachmentFormat}` (VkFormats, 0 =
    none). Layer 0 only (layerCount > 1 and viewMask are logged).
  - `vkCreateRenderPass2` is read like vkCreateRenderPass (pNext resolve
    info ignored); `vkCmdBeginRenderPass2`,
    `vkCmdNextSubpass2`, `vkCmdEndRenderPass2` are aliases of the 1.0
    commands (the extra subpass begin/end info is ignored).
  - Extended dynamic state (pipelines list the states in
    `dynamicState.dynamicStates`; the host makes a pipeline variant per
    combination): `vkCmdSetCullMode {cullMode}`, `vkCmdSetFrontFace
    {frontFace}`, `vkCmdSetPrimitiveTopology {primitiveTopology}`,
    `vkCmdSetDepthTestEnable`, `vkCmdSetDepthWriteEnable`,
    `vkCmdSetDepthCompareOp`, `vkCmdSetStencilTestEnable`,
    `vkCmdSetStencilOp {faceMask, failOp, passOp, depthFailOp,
    compareOp}`, `vkCmdSetDepthBiasEnable`, `vkCmdSetViewportWithCount
    {viewports}`, `vkCmdSetScissorWithCount {scissors}`,
    `vkCmdBindVertexBuffers2 {firstBinding, buffers, offsets, sizes,
    strides}`; `vkCmdSetPrimitiveRestartEnable` and
    `vkCmdSetDepthBoundsTestEnable` are no-ops. `vkCmdPipelineBarrier2`,
    `vkCmdSetEvent2`, `vkCmdResetEvent2`, `vkCmdWaitEvents2`,
    `vkCmdWriteTimestamp2` are no-ops. vkCmdDraw(Indexed)IndirectCount is
    not supported (the count lives in GPU memory).
  - Render areas smaller than the framebuffer clear only the area;
    partial vkCmdResolveImage regions work.
- Host API: `renderer.image(connectionOrId, imageId)` returns an
  ImageBitmap of the image (GPU copy into an OffscreenCanvas configured
  for the device, then transferToImageBitmap; rgba8/bgra8/rgba16float
  formats, else undefined), for a page compositor; `connection.id`.
  `renderer.stats` (totals) and `connection.stats` are `VkStats`
  {messages, submits, draws, dispatches, presents, bytesWritten,
  bytesRead, translations, translateMs, pipelines, errors}.
  `VK_FEATURES` includes `clip-distances`.
- Translator: descriptor arrays of constant size (sampled images,
  samplers, combined image samplers, uniform and storage buffers) are
  flattened to one WGSL binding per element, numbered by the host through
  `opts.arrays["set.binding"] = { base, count }`: element i at
  `wgslBinding base + 2*i`, a combined image sampler's sampler half at
  `base + 2*i + 1` (`count` >= the shader's array length). A shader with a
  descriptor array missing from `opts.arrays` fails with an error naming
  it ("descriptor array at set S binding B (N elements): the host must pass
  it in opts.arrays"). Reflection entries of elements carry `arrayIndex`
  (and the Vulkan `binding`). Constant and dynamic indices both work
  (dynamic: a switch over the elements, index out of range reads element
  0), so the ICD may report shader{Sampled,UniformBuffer,StorageBuffer}
  ArrayDynamicIndexing. Runtime-sized arrays and two dynamic indices in one
  expression (`sampler2D(tex[i], smp[j])`) are rejected.
- Translator: input attachments (`subpassInput`) are `texture_2d` (or
  multisampled) bindings like sampled images (`kind: "texture"`), read with
  textureLoad at the fragment's position: the host binds the attachment's
  view there.

- Port: the link is vsock port 1018, not 1021 (1021 is WASI_EXEC_PORT, the
  guest's WASI programs). The ICD's default, VK_PORT and the checks changed.
- ICD (2026-11-24, round 2): Vulkan 1.1 core (guest-only parts:
  properties2/features2 with pNext chains, bind memory 2, memory
  requirements 2, device groups of one, no external handles, descriptor
  update templates expanded into vkUpdateDescriptorSets messages) and the
  device extensions maintenance1/2/3, get_memory_requirements2,
  bind_memory2, dedicated_allocation, driver_properties,
  descriptor_update_template, create_renderpass2, depth_stencil_resolve,
  dynamic_rendering, EXT_extended_dynamic_state,
  storage_buffer_storage_class. It sends `vkCreateRenderPass2` with the
  2-structs' members (attachment references add `aspectMask`, subpasses
  `viewMask` and, from VkSubpassDescriptionDepthStencilResolve,
  `depthResolveMode`, `stencilResolveMode`,
  `depthStencilResolveAttachment`; dependencies `viewOffset`; top level
  `correlatedViewMasks`), `vkCmdBeginRenderPass`/`vkCmdNextSubpass`/
  `vkCmdEndRenderPass` for their *2 forms, `vkCmdBeginRendering` (plus
  `flags`) and `vkCmdEndRendering`, the extended dynamic state commands as
  listed above (each with its Vulkan parameter name, e.g.
  `{"c":"vkCmdSetDepthTestEnable","depthTestEnable":1}`), and
  `vkCmdBindVertexBuffers2` with `sizes` (-1 = VK_WHOLE_SIZE) and `strides`
  only when given. Debugging: `KWVK_TRACE=FILE` writes every message's
  JSON, one per line.
- ICD: two memory types, DEVICE_LOCAL and HOST_VISIBLE | HOST_COHERENT |
  HOST_CACHED;
  no DEVICE_LOCAL | HOST_VISIBLE ("BAR") type ("Device memory tracking"
  below).
- Host (2026-11-24, round 3):
  - Queries. `vkCreateQueryPool {id, queryType, queryCount}` (1..4096):
    OCCLUSION (0) on a WebGPU occlusion query set, TIMESTAMP (2) on a
    timestamp query set when the device has `timestamp-query` (values in
    nanoseconds: report timestampPeriod 1; without the feature they read
    0), PIPELINE_STATISTICS (1) reads 0. Commands: `vkCmdResetQueryPool
    {queryPool, firstQuery, queryCount}`, `vkCmdBeginQuery {queryPool,
    query, flags}` / `vkCmdEndQuery {queryPool, query}` (occlusion: inside
    a render pass, one pool per render pass, as WebGPU wants),
    `vkCmdWriteTimestamp {pipelineStage, queryPool, query}` (outside render
    passes; inside one it reads 0. WebGPU has timestamps only at pass
    boundaries: each is a pass of its own, written at its start, after
    the work before it, with a no-op dispatch so that it is not empty; a
    difference of two is the time between those points, waits for the
    guest's next submit included. Queries are resolved when they are read,
    one resolve for a read, as WebGPU converts to nanoseconds at the
    resolve and a backend's conversion may change between resolves),
    `vkCmdCopyQueryPoolResults {queryPool,
    firstQuery, queryCount, dstBuffer, dstOffset, stride, flags}` (64-bit
    and 32-bit, WITH_AVAILABILITY; WAIT is implied by queue order;
    occlusion values there are WebGPU's raw non-zero counts, which
    non-PRECISE Vulkan allows; mark dstBuffer GPU-written). Host-side
    `vkResetQueryPool {queryPool, firstQuery, queryCount}` (1.2 host query
    reset) and `{"op":"getQueryPoolResults","r":N,"queryPool","firstQuery",
    "queryCount"}` -> `{"r":N,"available":[0|1,...]}` + binary: queryCount
    little-endian u64 values (occlusion normalized to 0/1; a timestamp
    that reads earlier than the one written before it, as WebGPU allows,
    is raised to that one, so differences are never negative), answered once
    the work submitted before it is done (vkGetQueryPoolResults: format per
    its flags guest-side; with WAIT send it after the fence/submit, values
    of queries not yet ended read 0 with available 0).
  - Descriptor arrays: set layout bindings with descriptorCount > 1 work
    for what the translator flattens (sampled images, samplers, combined
    image samplers, uniform and storage buffers, constant size). The host
    numbers them per set layout: array bindings in binding order get WGSL
    bindings from `2 * (highest binding + 1)` up, `2 * count` each (WebGPU
    allows binding numbers < 1000). vkUpdateDescriptorSets honours
    dstArrayElement, descriptorCount and Vulkan's consecutive-binding
    overflow; descriptorCopies honour srcArrayElement/dstArrayElement/
    descriptorCount and the same overflow on both sides; dynamic offsets
    count per element.
  - Input attachments (descriptor type 10) are bound as sampled textures
    (the translator's `textureLoad` at the fragment position): reading an
    attachment written in an earlier subpass works; one also written in the
    same subpass is not (logged).
  - Untrusted input: frames over 256 MiB (`VK_MAX_FRAME`) or with jsonLen >
    total end the stream (the host calls the `close` callback of
    `connect(send, close)`); bad JSON, unknown ops/ids, out-of-range sizes
    and counts are answered with `err` (or logged) and the loop goes on.
    At most 2^20 objects per connection. A closed connection's GPU objects
    are destroyed (after the work in flight).
- Host API (round 3): `renderer.connect(send, close?)`: `close` is called
  when the host ends the stream (device loss, a bad frame): close the vsock
  stream then. Device loss: `renderer.lost` (a Promise of `{reason,
  message}`) and the `onLost(info)` option fire once; by then every
  connection was answered (pending requests get `err`), closed and its
  `close` callback called, and connections made later are refused the same
  way. The SDK should then drop the renderer and make a new GPUDevice and
  VkRenderer for new programs. VkStats adds `encodeMs`, `parseMs` and the
  gauges `liveObjects` (guest ids held) and `liveGpu` (GPU buffers,
  textures and query sets held for guests).
- Translator: a vertex result has `varyings` (each output location's
  `interpolation` "perspective" | "linear" | "flat" and `sampling`
  "center" | "centroid" | "sample" | "" for flat); passing them as the
  fragment stage's `opts.link` makes its inputs match (WebGPU requires
  equal interpolation across stages; HLSL-derived SPIR-V such as vkd3d's
  often differs). The host does this in `stages()` (vertex translated
  first).
- Translator: storage images declared without a format (Unknown) get
  `opts.storageFormats["set.binding"]` (a WebGPU format name) or else
  rgba8unorm (float), rgba32sint, rgba32uint; the reflection's `format`
  says which. The host does not pass storageFormats yet.
- Translator: rejected with a plain message: runtime-sized descriptor
  arrays (texel buffers: Amendments, "Texel buffers"). The
  BaseVertex, BaseInstance and DrawIndex builtins (shader draw parameters)
  read as 0 (right for draws with firstVertex/vertexOffset/firstInstance 0
  and for non-indirect single draws; WGSL's vertex_index/instance_index
  already include the bases, as Vulkan's do). Dual-source blending outputs
  (`layout(location = 0, index = 1)`) come out with
  `enable dual_source_blending;`: the device needs the
  `dual-source-blending` feature. A separate image and sampler at the same
  set and binding (HLSL via DXC) form one combined descriptor: texture at
  2*b, sampler at 2*b + 1, as for COMBINED_IMAGE_SAMPLER.
- Host: on a translation failure with `globalThis.KWVK_DUMP_SPIRV = true`
  the host logs the module as base64 (`kwvk: shader N stage SPIR-V
  (base64): ...`).

- ICD (2026-11-24, round 3): query pools (`vkCreateQueryPool {id, flags,
  queryType, queryCount, pipelineStatistics}`, the query commands as the
  host lists them, `vkResetQueryPool`, `getQueryPoolResults` formatted
  guest-side per the flags; timestampValidBits 64 and
  timestampComputeAndGraphics when the hello features have
  `timestamp-query`); shader{SampledImage,UniformBuffer,StorageBuffer}
  ArrayDynamicIndexing reported; input attachments allowed (4 per stage).
  The ICD sends with MSG_NOSIGNAL; once the stream ends every wait,
  submit, acquire, present and query returns VK_ERROR_DEVICE_LOST.
  Finite fence timeouts are honoured (waits poll the stream in slices of
  at most 20 ms, so several threads may wait on one fence). A submit marks
  its GPU-written buffers and is sent under one lock, and readbacks are
  serialized, so a thread's fence wait never reads another thread's
  buffer before its submit, nor races its readback. The last-sent copy of
  a memory object exists only while it is mapped (rebuilt from the shadow
  at the next map). `KWVK_STATS=1` prints where the ICD's time goes every
  2 s (at present); `KWVK_SPIRV_DIR=DIR` keeps every shader module as
  DIR/ID.spv. Wayland surfaces also offer compositeAlpha PRE_MULTIPLIED,
  presented as WL_SHM_FORMAT_ARGB8888 (XRGB8888 for OPAQUE).
- Host (2026-11-24, round 4): image view `components` swizzles are
  applied through WebGPU's `texture-component-swizzle` feature (view
  `swizzle`, sampled views only; in `VK_FEATURES`); without the feature
  they are logged and identity is used (the ICD may check the hello
  reply's `features` for "texture-component-swizzle"). Storage images
  declared without a format get the bound view's format (the host passes
  `opts.storageFormats` and makes a pipeline variant per bound format
  combination at draw/dispatch time). BaseVertex/BaseInstance/DrawIndex
  read 0 in WGSL: the host logs once when a draw with non-zero
  firstVertex/vertexOffset/firstInstance uses a shader that reads them
  (gl_VertexIndex/gl_InstanceIndex are right: WebGPU's include the
  bases).
- Translator: every result has `requires`, the WebGPU features its WGSL
  enables: "shader-f16" (float16_t, 16-bit float storage), "subgroups",
  "clip-distances", "dual-source-blending", "primitive-index", and
  "uniform_buffer_standard_layout", a WGSL language feature (below). Any
  other entry is not a WebGPU feature (e.g. naga's "wgpu_int16" for
  uint16_t) and cannot run. The host checks them against the device's
  features and `navigator.gpu.wgslLanguageFeatures` and fails the
  pipeline with "shader needs WebGPU features the device lacks: ...".
- Translator: the WGSL is valid under WebGPU's core rules on every engine
  (Chrome's Tint, Firefox's naga, Safari's WGSL). A uniform block (push
  constants included) whose Vulkan layout WGSL's uniform address space
  cannot express (std430 push constants: arrays of stride 4 or 8 such as
  llama.cpp's rope parameters, 4-byte-aligned structs; non-square
  row-major matrices; members inside a struct's 16-byte rounding) becomes
  `struct kw_words { w: array<vec4<u32>, N> }` over the same bytes, every
  load rebuilt from words (vk/naga/src/uniform.rs); the push constant
  size is then rounded up to 16. Blocks WGSL can lay out keep their
  struct. naga validates with WebGPU's capabilities and struct layouts;
  a block the pass cannot repack (8/16-bit or bool members, a pointer
  used other than by access chains and loads) passes only with
  uniform_buffer_standard_layout (Chrome) and lists it in `requires`.
- Translator: an integer division or remainder by a constant zero
  (undefined in Vulkan, typically in a branch the specialization makes
  dead: llama.cpp's mul_mm `k_pair / (TK / 2)` with TK = 1) becomes
  WGSL's run-time result, x / 0 = x and x % 0 = 0, so no zero divisor
  reaches the WGSL (naga and Tint refuse one even unreachable); spec
  constant expressions fold the same way.
- Translator: compute shaders are compacted (naga's wrapper inlined so
  WGSL's uniformity rule accepts barriers after workgroup-uniform early
  exits).
- Translator (2026-11-24): in a loop that may execute a barrier,
  `if (c) { ...; continue; } REST` becomes `if (c) { ...; continue; }
  else { REST }` and continues in tail position of the body (plain
  fall-throughs) are dropped (vk/naga/src/flow.rs), so a barrier after
  an invocation-dependent continue (llama.cpp's
  mul_mat_vec_q2_k/q3_k/q6_k) is uniform for WGSL. Exact rewrites only;
  other non-uniform barriers are still refused by WebGPU.
- Host (2026-11-24, round 5): varying interpolation follows Vulkan, where
  the FRAGMENT inputs' decorations decide (vkd3d and glslang put Flat only
  on the fragment input). The host no longer passes the fragment stage
  `opts.link` from the vertex stage's varyings (that forced flat inputs to
  perspective: vkd3d-gears' smeared lighting); it reads the fragment
  module's Input decorations (Flat, NoPerspective, Centroid, Sample) from
  its SPIR-V and rewrites the vertex entry point's output struct in the
  translated WGSL to the same `@interpolate(...)` (integer outputs stay
  flat). `opts.link` stays available in the translator but the host does
  not use it. Frames over 1 MiB are assembled in a buffer of their own (one
  copy) and readBuffer replies are framed straight from the mapped staging
  range (one copy): 64 MiB write 73 ms, read 82 ms on SwiftShader.
  `VK_FEATURES` adds `shader-f16` and `subgroups`; `vkDeviceDescriptor`
  requests every adapter limit at its maximum (maxBufferSize,
  maxStorageBufferBindingSize included). vkCmdDispatchBase stays
  unsupported (logged).
- ICD (2026-11-24, round 4): apiVersion 1.2 (vkEnumerateInstanceVersion
  1.2): VkPhysicalDeviceVulkan11/12Features and Properties in the *2
  chains, honest (hostQueryReset true; shaderFloat16 and
  VK_KHR_shader_float16_int8 only when the hello features have
  `shader-f16`; storageBuffer16BitAccess and storageBuffer8BitAccess true
  with VK_KHR_16bit_storage and VK_KHR_8bit_storage, as the translator
  emulates them as u32 words; the uniform/push-constant 8/16-bit variants,
  shaderInt8/Int16, buffer device address and descriptor indexing false;
  timeline semaphores: Amendments, "Timeline semaphores"; subgroups basic
  only, no stage, of the hello's size: Amendments, "Subgroup size"); the
  1.2 entry points exist (BDA ones are inert, the draw-indirect-count ones
  are dropped and logged). multiDrawIndirect is true, maxDrawIndirectCount
  65535 (the host draws each record). maxVertexOutputComponents and
  maxFragmentInputComponents are the hello's maxInterStageShaderVariables
  times 4, plus 4 for an app whose VkApplicationInfo engine is `wgpu-hal`
  (wgpu takes these components / 4 - 1 as its limit and asks for WebGPU's
  16). Two memory heaps: device-only memory's is
  4 GiB (`KWVK_HEAP_MB` sets it, as `KWVK_DEVICE_NAME` sets the device name, which is "kwvk (WebGPU: ADAPTER)" otherwise, with "apple", "metal", "cuda", "rocm" and "hip" spelled apart ("a.p.p.l.e"), as Ollama takes a device so named for a Metal, CUDA or ROCm one (driverInfo has the adapter as it is); WebGPU tells no size, and that memory has
  no copy in the guest), host-visible memory's half of the guest's RAM
  (sysconf); maxMemoryAllocationSize min(maxBufferSize, maxStorageBufferBindingSize); a host-visible allocation over its heap fails (VK_ERROR_OUT_OF_DEVICE_MEMORY). writeBuffer frames
  carry at most 16 MiB each (a multi-MiB upload is several frames).
- ICD (round 4): GPU-written buffers are now marked at each draw or
  dispatch, only for the storage buffers the bound pipeline's shaders may
  write (the ICD scans each module's SPIR-V for storage-buffer variables
  not decorated NonWritable; a module it cannot read marks everything, as
  before). Mapped memory is page-aligned.
- Host (ICD agent, round 4): compute stages get their read-only storage
  buffers as `read_write` (WGSL rewritten after translation, layout type
  "storage"): ggml-vulkan binds one buffer at different offsets read-only
  and writable in one dispatch, which WebGPU refuses for read-only +
  writable storage in one usage scope but allows for writable + writable.
- Translator: 8- and 16-bit storage on every device. `opts.features`
  (the host passes ["shader-f16"] when the device has it) decides f16:
  with it float16_t stays f16 (requires "shader-f16"); without it
  float16_t is computed as f32. Storage buffers holding 8/16-bit members
  (int8/uint8/int16/uint16, and float16 without shader-f16), or bound
  through differently typed views of one binding, become ONE
  `array<u32>` variable per binding (reflection: one entry for the
  binding, "read-only-storage" when every view is NonWritable or the module writes
  none of them), addressed
  in bytes from the SPIR-V Offset/ArrayStride decorations: loads shift and
  mask (f16 via unpack2x16float); a writable such buffer is
  `array<atomic<u32>>` and every access atomic, sub-word stores being
  atomicAnd + atomicOr on the word, so adjacent 8/16-bit elements written
  by different invocations do not race. 8/16-bit integer values become
  32-bit elsewhere (narrowing conversions mask or sign-extend; unpack8/
  pack8-style bitcasts are expanded). Unsupported: matrices other than
  column-major at natural stride in such buffers, atomics on 8/16-bit
  members, uniform buffers with 8/16-bit members.
- Translator + host: compute workgroups larger than the device allows
  (ggml hardcodes 512, SwiftShader's WebGPU allows 256). The host passes
  the device's `limits` for compute stages; when the local size exceeds
  them and the shader has no workgroup variables, barriers or subgroup
  operations, each axis is
  divided by the smallest power of two that fits and the result carries
  `dispatchScale` [kx, ky, kz]; the host multiplies vkCmdDispatch's group
  counts by it (the same set of global invocation ids). The entry's
  local_invocation_id/index, workgroup_id and num_workgroups are then
  derived from global_invocation_id and the original local size S
  (gid % S, gid / S, num_workgroups / k). Otherwise the translation fails
  with "workgroup size AxBxC exceeds the device's limits (...) and the
  shader uses X". vkCmdDispatchIndirect with a scale
  is logged as unsupported (counts not scaled).

- Host (ICD agent, final round): a buffer binding the app left unwritten
  (Vulkan allows it when the shader does not access it; ggml-vulkan does)
  gets a zeroed 64 KiB placeholder buffer, one per WGSL binding number,
  instead of failing the dispatch; logged once. Textures, storage
  textures and samplers get placeholders too (logged once per
  connection); a sampler binding with immutable samplers takes the
  layout's sampler.
- Host (2026-11-24, round 6): bindings a shader declares but never
  references once its specialization constants are baked (the
  translator drops branches on baked constants and leaves such bindings
  out of `bindings`; the host still drops any `if false { ... }` left)
  are left out of the bind group layout and bind group, so a dead binding aliasing a live
  writable one (ggml's matmul binds one range to bindings 2 and 3) no
  longer fails WebGPU's aliasing check. vkCmdCopyBuffer at any byte size
  and offset writes exactly [dstOffset, dstOffset+size): the aligned part
  with copyBufferToBuffer, the rest through a small compute pass (all
  buffers now carry STORAGE usage host-side).

- Loud failures (2026-11-24, round 7; overrides "logged and the loop goes
  on" of round 3 for requests without `r`, and the logged-only
  vkCmdDispatchBase and vkCmdDispatchIndirect-with-scale above). A host
  failure reaches the app as a Vulkan error, never as missing or stale
  results:
  - Pipelines are requests: the ICD sends `vkCreateGraphicsPipelines` and
    `vkCreateComputePipelines` with `r` (all of a call's pipelines before
    the first wait). The host creates the GPU objects in an error scope of
    their own and replies once each stage's WGSL compiled
    (`getCompilationInfo`) and the scope popped: `{"r":N}` (made),
    `{"r":N,"err":"why"}` (refused: translation, a WGSL error such as Tint's
    uniformity analysis, a pipeline or layout WebGPU refuses; the ICD
    returns VK_ERROR_INVALID_SHADER_NV, or the reply's `result`, and
    VK_NULL_HANDLE for that pipeline, and sends `destroy` for its id), or
    `{"r":N,"unusable":"why"}` (made but cannot run: resource kinds WebGPU
    lacks, 1D-array storage images, which vkd3d declares
    in pipelines it makes at start-up: the ICD returns VK_SUCCESS and a
    command buffer that binds it makes vkQueueSubmit lose the device). Without
    `r` (older ICDs) the host marks a failed pipeline and binding it fails
    the submit. Pipeline variants made at draw time are checked with their
    submit. Adjacency and patch-list topologies are refused with `result`
    -8 (VK_ERROR_FEATURE_NOT_PRESENT).
  - Any `err` reply may carry `result`: the VkResult the ICD should return.
  - `{"r":0,"lost":"why"}` is the host's last frame before it ends a stream
    as a lost device (also at a WebGPU device loss and a bad frame); then
    pending requests get `err` and the stream closes. The host loses the
    device for a connection when a submit fails (a command it cannot encode,
    an unknown or failed object, or a WebGPU validation error: WebGPU drops
    the whole submit), when a request without `r` fails (other than a
    creation), and at a frame with bad JSON. A creation without `r` that
    fails, synchronously or by WebGPU validation, leaves tombstones under its
    ids: a later use fails with "failed at its creation (op: why)". Replies
    to readBuffer, getQueryPoolResults, present (with readback) and sync are
    sent only once the validation of every earlier submit is known.
  - ICD: `lost` prints `kwvk: device lost: why` once on stderr, and from
    then on every wait, submit, acquire, present and query returns
    VK_ERROR_DEVICE_LOST (a fence signalled before the loss included;
    vkMapMemory returns VK_ERROR_MEMORY_MAP_FAILED, as GPU writes can no
    longer be read back). An
    `err` reply to a submit, sync, readBuffer, present or
    getQueryPoolResults is a lost device too (never success with stale
    data). Refused guest-side, with a stderr line: vkCreateBuffer over the
    hello's maxBufferSize (VK_ERROR_OUT_OF_DEVICE_MEMORY;
    maxMemoryAllocationSize is at most maxBufferSize), vkCreateImage of a
    format the hello does not list (VK_ERROR_FORMAT_NOT_SUPPORTED), push
    descriptor templates (VK_ERROR_FEATURE_NOT_PRESENT). 1D images report
    maxArrayLayers and maxMipLevels 1 (WebGPU has neither). A command buffer
    recording vkCmdDispatchBase with a non-zero base or
    vkCmdDraw(Indexed)IndirectCount is marked; vkQueueSubmit of it returns
    VK_ERROR_DEVICE_LOST and loses the device. Timeline semaphores:
    Amendments, "Timeline semaphores". Wrong-result approximations that stay warn once on stderr:
    linear-tiling images (treated as optimal), BaseVertex/BaseInstance read as 0 in a draw with non-zero
    bases, buffer device addresses (0). Errors and these warnings are
    printed whatever `KWVK_DEBUG` says, each distinct line once.
  - Host: vkCmdDispatchIndirect of a pipeline whose workgroup was split
    (dispatchScale) fails the submit; cullMode FRONT_AND_BACK draws nothing
    to the attachments (it drew unculled). VkStats adds `lost` (connections
    the host ended as a lost device).

- External present (2026-11-24): Wayland swapchains on the page's wland
  present without pixels, through wland's `wland_external_buffer_manager_v1`
  (wland's protocol/wland-external-buffer-v1.xml: a wl_buffer named by an
  opaque 64-bit id that the page resolves to a picture at each commit).
  - Hello: the reply carries `"external":{"token":T}` (T a random non-zero
    u32, different for every connection the page's renderers ever made)
    where the host can make such pictures (a WebGPU OffscreenCanvas on its
    device that the SDK's probe found working); without it the ICD never
    uses external present.
  - `{"op":"exportImages","r":N,"images":[ids]}` -> `{"r":N,"ids":[E...]}`:
    an export id per swapchain image (2D, single-sampled, B8G8R8A8 or
    R8G8B8A8, sRGB or not). Export ids count up per connection from 1 and
    are never given to another image (an image exported again keeps its
    id). `err` (not offered, not an image, a format it cannot show) is a
    refusal, NOT a lost device: the ICD presents that swapchain by readback.
  - The ICD uses it when the hello has the token, the compositor advertises
    the global (wland does only with a relay started with
    `--external-buffers` and a page that resolves them), the swapchain is
    B8G8R8A8, and neither `KWVK_EXTERNAL=0` nor `KWVK_DUMP` is set (else
    readback into wl_shm as before; X11 and headless never use it). It
    binds the global (version 1) and makes one wl_buffer per image with
    `create_buffer(id_hi = T, id_lo = E, width, height, format, 0)`:
    format ARGB8888 for compositeAlpha PRE_MULTIPLIED, XRGB8888 otherwise
    (as the wl_shm formats), flags 0 (row 0 at the top).
  - `{"op":"present","r":N,"image":id,"readback":0,"external":1}` ->
    `{"r":N,"width":w,"height":h}`, no binary, sent once the validation of
    every earlier submit is known (a failed frame loses the device instead
    of reaching the compositor); from then on the image's id resolves. The
    ICD commits to Wayland only after this reply: the frame's commands
    travel on this link, the commit on wland's, so present -> reply ->
    wl_surface.attach of the image's buffer, damage of the whole buffer, a
    frame callback (FIFO pacing as with wl_shm), commit. A present of an
    image not exported fails (err: a lost device).
  - Lifetime: the image is the buffer. The ICD acquires an image again
    only once its wl_buffer was released (wland releases at the commit's
    ACK; after 100 ms it renders into it anyway rather than hang). At
    vkDestroySwapchainKHR it waits up to 250 ms for its busy buffers to be
    released, then sends `destroy` for the images and destroys the
    wl_buffers (no release follows the destruction of a busy one): the
    `destroy` is the lifetime message; the host keeps an exported texture
    until then (a closed connection or a lost device drops them all).
  - Host API: `renderer.external(ref)` (wland's ExternalRef: `{id: bigint,
    width, height, format, flags}`) gives the picture of the image as an
    ImageBitmap (a copy into a WebGPU OffscreenCanvas on the renderer's
    device, alphaMode premultiplied, or opaque for XRGB8888/XBGR8888, then
    transferToImageBitmap; synchronous, no readback), or null: an unknown
    token or export id, a destroyed or never presented image, a closed
    connection, a lost device, a claimed size, format (byte order) or
    flags that are not the image's. The SDK's `vm.vk.externalImage(ref)`
    calls it on the current renderer. VkStats adds `externalPresents` and
    `externalImages`; `bytesRead` does not grow for external presents.

- Device memory tracking (2026-11-24, ICD; host: descriptor copies):
  - Consecutive binding updates: the ICD records each storage buffer of a
    VkWriteDescriptorSet, VkCopyDescriptorSet (both sides) and descriptor
    update template entry where Vulkan puts it: past a binding's last
    element at element 0 of the next binding by number that has
    descriptors (zero-count bindings skipped), from the set layout's
    bindings (the ICD keeps them for the sets allocated from it). The host
    numbers writes and copies the same way (a binding the layout lacks
    counts as one descriptor). ggml-vulkan writes all of a set's buffers in
    one write at binding 0.
  - Ranges: what a submit may write is kept per buffer as byte ranges
    (sorted, overlapping and adjacent ones joined, at most 8: past that the
    two closest are joined), and readBuffer is sent per range. A range is
    narrower than the buffer only where the command says exactly what it
    writes: vkCmdCopyBuffer regions, vkCmdUpdateBuffer, vkCmdFillBuffer,
    vkCmdCopyQueryPoolResults (`dstOffset + (queryCount - 1) * stride` plus
    one result), a storage buffer descriptor as bound (`offset` plus its
    dynamic offset, `range`; VK_WHOLE_SIZE is the size minus `offset`, as
    the host binds it: WebGPU keeps a shader's writes inside the binding);
    vkCmdCopyImageToBuffer from each region's `bufferOffset` to the end of
    the buffer; everything else (sets bound for another bind point, more
    dynamic offsets than the ICD keeps) the whole buffer. Ranges are
    widened to 4 bytes; the host's readBuffer takes any 4-aligned
    `offset`/`size` inside the buffer.
  - Read back into a mapped shadow, a 4-byte word the CPU changed since
    the last flush (shadow differs from the last-sent copy) keeps the
    CPU's value (the GPU cannot have written it too in a valid program)
    and is sent at the next flush; before, a whole-buffer readback
    replaced bytes the CPU wrote while the GPU worked elsewhere in the
    buffer.
  - Memory types: 0 DEVICE_LOCAL, 1 HOST_VISIBLE | HOST_COHERENT |
    HOST_CACHED (the shadow is the guest's RAM; DDNet maps only
    HOST_CACHED memory), and no
    DEVICE_LOCAL | HOST_VISIBLE type, so that memory the GPU writes is not
    mapped by apps that prefer that type on an integrated GPU: ggml-vulkan
    (deviceType INTEGRATED_GPU: uma) asks for DEVICE_LOCAL | HOST_VISIBLE |
    HOST_COHERENT first for every device buffer and maps it for good (its
    compute buffer, KV cache and weights would be read back, within the
    ranges they were bound with, at every fence wait); it now gets type 0
    and moves data through staging copies, as on a discrete GPU. SDL3's GPU
    API puts its uniform buffers in type 1 (its warning "Out of BAR
    memory, allocating uniform buffers on host-local memory" is below SDL's
    default log priority). Allocators
    that take the first type with the flags they need (GTK's GSK, VMA for
    GPU-only allocations) get type 0 for GPU-only resources as before.
    memoryTypeBits is 3 for buffers and images.

- Submit flush (2026-11-24, ICD): at vkQueueSubmit the ICD diffs and sends
  only the host-visible ranges the submitted command buffers may read or
  write, recorded with each command: uniform and storage buffer
  descriptors as bound at each draw or dispatch (offset plus dynamic
  offset, range; VK_WHOLE_SIZE to the end; a dynamic offset the ICD does
  not keep: the whole buffer), vkCmdCopyBuffer sources and destinations
  (the regions), vertex buffers (offset to the end, or `size`), index and
  indirect buffers (offset to the end), vkCmdCopyBufferToImage sources
  (each region's `bufferOffset` to the end) and every range the
  GPU-written tracking ("Device memory tracking") marks. Device-only memory
  is never listed. Other CPU writes stay pending until a submit uses them,
  vkUnmapMemory or vkFlushMappedMemoryRanges: the GPU reads nothing else
  of host-visible memory. Before, every mapped byte was diffed at every
  submit, which for ggml-vulkan (its token embeddings and staging buffers
  kept mapped, 60 MiB for SmolLM2 135M, 300 MiB for Qwen2.5 0.5B) cost
  tens of milliseconds per submit in the guest.

- Fences at submit (2026-11-24, ICD): a fence given to a vkQueueSubmit
  whose command buffers write no host-visible memory (nothing the app can
  read changes; the GPU-written tracking of "Device memory tracking" finds
  none) is signaled at the submit. The submit still carries `r`; the ICD
  collects those replies later (the ones that have come at each fence wait,
  vkGetFenceStatus, wait-idle and submit; a 9th unanswered one waits for the
  oldest), and an `err` among them loses the device, which the next wait,
  submit or present reports instead of that fence. What earlier work wrote
  to mapped memory is read back after the wait as before, by readBuffer
  requests the host answers in order, after that work, once its validation
  is known. A submit that may write host-visible memory signals its fence
  at its reply. `KWVK_FENCE_SYNC=1` makes every fence wait for its reply. A
  fence still pending: vkGetFenceStatus waits up to 1 ms in the kernel for
  the reply from the second call on (callers that spin on it, as
  ggml-vulkan does, would keep the guest's CPU from the host in inline
  mode). ggml-vulkan's waited uploads of each token's inputs went from 7
  round trips a token (Qwen2.5 0.5B) to none.

- Read-only buffers kept (2026-11-24, host; amends "Host (ICD agent,
  round 4)"): a compute pipeline is made with its read-only storage
  buffers promoted to read_write as before; when WebGPU refuses that (Tint
  takes reads of read_write storage as non-uniform: ggml's matmul_id
  returns early on a read-only buffer's value before its barriers), it is
  made again, in an error scope of its own, with the shader's read-only
  buffers kept ("read-only-storage" layout entries), and the reply waits
  for that. At a dispatch of such a pipeline, a kept read-only binding
  whose buffer the dispatch also binds writable, at any range (one usage
  scope), is read from a scratch copy made just before it, as for
  overlapping ranges. Pipelines WebGPU takes promoted are unchanged.
- Translator (2026-11-24): a compute helper that reads num_workgroups or
  workgroup_id through spv-in's private copy (SPIR-V that spirv-opt did not
  inline: llama.cpp's bf16 and rope rms_norm) gets the builtin as an
  argument instead, when the copy is provably the builtin (stored once
  from it at the entry point's start and never otherwise written), so
  WGSL takes loops on them as uniform. The value of OpAtomicIAdd and the
  other single-value atomics is copied into the atomic's block first
  (naga's spv-in left a loop header's value out of scope after the loop).
- Virtual invocations (2026-11-24, translator; amends "Translator +
  host: compute workgroups larger than the device allows"): a workgroup
  over the device's limits that has workgroup variables or barriers keeps
  its workgroup count and memory and is made X / K wide, K a power of two
  up to 8, each invocation running K virtual invocations
  (vk/naga/src/virt.rs): local_invocation_id/index and
  global_invocation_id are those of the original workgroup, the code
  between barriers runs once per virtual invocation, barriers and the
  control flow around them once per invocation. No `dispatchScale`. The
  translation fails as before, with "; virtual invocations: REASON"
  appended, when the pass refuses: a barrier in a function other than the
  entry point, subgroup operations or workgroupUniformLoad, a condition
  around a barrier (or a break or continue past one) that its
  conservative uniformity check cannot show to be the same for every
  invocation, no power of two up to 8 that fits, constructs it does not
  know.
- Subgroup size (2026-11-24, ICD, host, translator; amends "ICD
  (2026-11-24, round 4)", which reported size 1). The ICD offers no
  subgroup operation (supportedStages 0, operations BASIC; Vulkan 1.1
  wants COMPUTE among the stages, a known deviation), but apps size
  workgroups by subgroupSize (llama.cpp's mat-vec, soft_max, argmax,
  sum_rows: one invocation per workgroup at 1) and some shaders read the
  subgroup builtins without operations (llama.cpp's gated_delta_net
  shmem variant: shared memory indexed by gl_SubgroupInvocationID in a
  workgroup of subgroupSize invocations). The size is agreed per
  connection in the hello:
  - The ICD sends `"subgroupSize":N`: N = `KWVK_SUBGROUP_SIZE` (a power of
    two up to 128), else 0, the host's choice. It reports the reply's
    `subgroupSize` (in VkPhysicalDeviceSubgroupProperties and
    VkPhysicalDeviceVulkan11Properties), or 1 when the reply has none (an
    older host, which translates as before; a `KWVK_SUBGROUP_SIZE` it
    cannot take is reported on stderr).
  - The host answers N when it is a power of two up to 128, else its own
    (`VK_SUBGROUP_SIZE`, 32: ggml's largest multiple of it, 4x, stays
    within the 256 invocations every WebGPU device allows), and 1 to a
    hello without the field (older ICDs report 1). It translates every
    compute stage of the connection with `opts.subgroupSize` = that size.
  - Translator (vk/naga/src/subgroup.rs): a compute module that reads
    SubgroupSize, SubgroupLocalInvocationId, SubgroupId or NumSubgroups
    and has no subgroup or group operation, no subgroup-scoped barrier,
    none of their capabilities and no mask builtins gets them as
    `subgroupSize`, local_invocation_index % `subgroupSize`,
    local_invocation_index / `subgroupSize` and ceil(local size /
    `subgroupSize`): subgroups of exactly that size filled in local index
    order (a last one may be partial), which nothing else in such a module
    can tell from real ones. No `enable subgroups` then. It runs before the
    other passes, so a split workgroup and virtual invocations see the
    original local index. Other modules keep WebGPU's subgroups (requires
    "subgroups", their width the adapter's), as before; graphics stages
    are not lowered.
- Y flip hint (2026-11-25, ICD, host; amends "Loud failures", where the
  variant made at creation was always the flipped one). Vulkan 1.1 makes
  negative viewport heights core, so neither the enabled extensions nor
  the API version tell the host which way an app's viewports point, and
  wgpu (Zed) makes its pipelines with dynamic viewports before its first
  draw, then draws every pass with a negative height.
  - The ICD sends `"engineName"` in the hello: VkApplicationInfo's
    pEngineName, when the app gave one (an older host ignores it).
  - The host makes the graphics pipelines of a connection whose engine
    it knows to draw with negative heights (`wgpu-hal`) with the vertex
    stage translated without the flip, and builds that variant at
    vkCreateGraphicsPipelines (its errors reported there); other
    connections, an older ICD's included, get the flipped one as before.
    The other orientation is a variant made at the first draw that uses
    it (checked with its submit), so a wrong hint costs only time.
- Translator (2026-11-28): a storage buffer variable (StorageBuffer, or
  Uniform with BufferBlock) the module never writes gets NonWritable
  before naga (a pointer into it reaching anything but OpLoad,
  OpAtomicLoad, OpArrayLength, an access chain or OpCopyObject counts as
  a write, as does a write through any other variable at its binding;
  modules with VariablePointers are left alone), so it is
  "read-only-storage" in `bindings`. Compute: promoted to read_write by
  the host with `ro`, as declared read-only buffers are (overlapping
  another binding of its buffer: read from the scratch copy), and kept
  read-only by "Read-only buffers kept". OpLine/OpNoLine are dropped;
  OpSpecConstantOp is folded for every Shader-capability operation on
  integers and booleans (scalar and vector) and for Select, FConvert,
  QuantizeToF16 and the composite operations on any type; isinf/isnan on
  f32 become bit tests; an `int[1]` SampleMask input or output becomes a
  u32.
- Host (2026-11-28): a uniform binding is sized in 16-byte steps within
  its buffer (WebGPU sizes it by the WGSL struct; GZDoom binds 252
  bytes). Buffer-image copies of block-compressed images are made in
  whole blocks (Vulkan lets them end mid-block at a level's edge).
  vkCmdCopyImage between size-compatible formats WebGPU cannot copy
  directly (BC1 and R32G32_UINT) goes through a scratch buffer, the
  extent counting the same blocks on both sides. Indirect draws draw the
  whole records of `drawCount`, `stride` bytes apart. Indexed triangle
  fans are rewritten as lists before their render pass, primitive
  restart included. A storage or uniform binding at an offset WebGPU
  refuses (not a multiple of the device's alignment) is a scratch copy
  in a dispatch, copied back when writable, and a named device loss in a
  draw.
- Timeline semaphores (2026-11-28, ICD): timelineSemaphore is true
  (VkPhysicalDeviceVulkan12Features, VkPhysicalDeviceTimelineSemaphoreFeatures,
  VK_KHR_timeline_semaphore 2); maxTimelineSemaphoreValueDifference is
  UINT64_MAX. Values live in the guest:
  - A value that a submit writing no host-visible memory signals is
    reached at the submit (the rule of "Fences at submit"). One that a
    submit which may write host-visible memory signals is reached at the
    reply to a `{"op":"sync","r":N}` the ICD sends right after that
    submit, or earlier at a fence wait or wait-idle covering the submit,
    or once a later submit's values are reached (queue order).
  - vkGetSemaphoreCounterValue and vkWaitSemaphores make no request of
    their own: they take the replies that have come (an `err` loses the
    device), read back what submitted work wrote to mapped memory as a
    fence wait does, and return VK_ERROR_DEVICE_LOST after a loss.
  - Wait before signal: a batch that waits for a value above what sent
    work, vkSignalSemaphore or an earlier batch of the same vkQueueSubmit
    gives is held in the ICD, with every batch after it (earlier batches
    of the call are sent); its fence stays unsignaled. vkSignalSemaphore,
    or the sending of an earlier held batch whose signal gives the value,
    releases them in order. vkQueueWaitIdle, vkDeviceWaitIdle and
    vkQueuePresentKHR wait for the release first. A lost device drops the
    held batches and signals their fences; destroying a semaphore or
    fence removes it from them; vkDestroyDevice drops them.
- Imageless framebuffers (2026-11-28, ICD): an imageless VkFramebuffer
  (VK_FRAMEBUFFER_CREATE_IMAGELESS_BIT) is not sent at creation. Each set
  of VkRenderPassAttachmentBeginInfo views it begins with gets a
  `vkCreateFramebuffer` of its own id, sent when a command buffer first
  records that set; vkCmdBeginRenderPass names that id, and the ids are
  destroyed with the VkFramebuffer. imagelessFramebuffer,
  separateDepthStencilLayouts (the host keeps no image layouts),
  shaderSubgroupExtendedTypes and subgroupBroadcastDynamicId (no stage
  has subgroup operations) are true, with their extensions, and
  VK_KHR_image_format_list and VK_KHR_swapchain_mutable_format (the host
  gives every single-sampled image, swapchain images included, its sRGB
  twin as a view format).
- Texel buffers (2026-11-28, ICD, host, translator; amends "Loud
  failures", where pipelines declaring them were made unusable, and the
  ICD's buffer view warning). Uniform and storage texel buffers
  (samplerBuffer, textureBuffer, imageBuffer: OpTypeImage Dim Buffer)
  become storage buffers of words that the shader decodes by the view's
  format, given in a uniform of its own:
  - Hello: the reply carries `"texelBuffers":{"formats":{"<VkFormat>":bits},
    "maxElements":N}`, bits 1 uniform texel buffer, 2 storage texel
    buffer, 4 storage texel buffer atomics. Formats: R8, R8G8, R16, R16G16
    (UNORM, SNORM, UINT, SINT; R16 and R16G16 also SFLOAT), R8G8B8A8 and
    A8B8G8R8_PACK32 (UNORM, SNORM, UINT, SINT), B8G8R8A8_UNORM,
    A2B10G10R10_UNORM/UINT_PACK32, R16G16B16A16 (UNORM, SNORM, UINT, SINT,
    SFLOAT), R32, R32G32, R32G32B32, R32G32B32A32 (UINT, SINT, SFLOAT), all
    3; B10G11R11_UFLOAT_PACK32 1 (not stored); R32_UINT and R32_SINT 7.
    `maxElements`: (maxStorageBufferBindingSize - 256) / 16. The ICD
    reports bufferFeatures UNIFORM_TEXEL_BUFFER, STORAGE_TEXEL_BUFFER and
    STORAGE_TEXEL_BUFFER_ATOMIC from the bits, maxTexelBufferElements =
    N and minTexelBufferOffsetAlignment 16; without the field (an older
    host) none, 65536 and 256.
  - `vkCreateBufferView {id, buffer, format, offset, range}` (range -1 =
    VK_WHOLE_SIZE): the ICD refuses a format whose bits lack a texel usage
    of the buffer (VK_ERROR_FORMAT_NOT_SUPPORTED, a stderr line). The host
    binds the view as a storage buffer from `offset` rounded down to
    minStorageBufferOffsetAlignment to its last element (rounded up to 4
    bytes), so any 16-byte offset works without a copy, and makes its 16-byte
    uniform: [VkFormat, offset minus that bound offset, element count
    (range / texel size, rounded down), texel size]. A format it does not
    list fails the creation (a tombstone: a later use loses the device).
  - Descriptors of types 4 and 5: writes carry `texelBufferView:[ids]`
    (0: as if unwritten), copies and templates as for other descriptors
    (consecutive binding updates included). A write of a view whose format
    lacks the type's bit (B10G11R11 as a storage texel buffer) fails:
    vkUpdateDescriptorSets has no reply, so the device is lost, named.
  - Translator (vk/naga/src/texel.rs): a texel buffer at set S binding B
    is `@group(S) @binding(2B)` `{ w: array<u32> }`, "read-only-storage"
    unless the module writes it (OpImageWrite, an image atomic), and
    `@binding(2B + 1)` a uniform `{ p: vec4<u32> }` of the parameters;
    both are reflected with `binding` B and `texel: "data"` or `texel:
    "params"`, and only when reached (a module that only asks the size
    has the parameters alone). texelFetch and imageLoad decode the element
    by the parameters' format (a switch; the format in the SPIR-V is not
    used), imageStore encodes it, textureSize and imageSize are the count;
    elements past the count read 0 and are not stored. Image atomics
    (OpImageTexelPointer, 32-bit integer texels) are atomics on the
    element's word, and a binding the module writes whose SPIR-V format is
    8- or 16-bit or Unknown is `array<atomic<u32>>`, its texels under 4
    bytes stored with atomicAnd + atomicOr on their word. Refused, with
    the reason: descriptor arrays of texel buffers, texel buffers passed
    to functions or through OpPhi/OpSelect, operations other than fetch,
    read, write, size and atomics, sampled types other than 32-bit float
    and integers, atomics on other than 32-bit integers, and a texel
    buffer a vertex stage writes (WebGPU has no writable storage there).
  - Host: the "data" entry binds the view's buffer at the bound offset and
    size, as a storage buffer (a compute stage's read-only one promoted to
    read_write and copied aside where it aliases a writable binding, as
    other storage buffers); the "params" entry binds the view's uniform.
    Each texel buffer takes one of its stages' maxStorageBuffersPerShaderStage
    and one of their maxUniformBuffersPerShaderStage: a pipeline past
    either is refused, naming the counts. Pipelines are made "unusable"
    only for 1D-array storage images now.
  - Device memory tracking: a texel buffer descriptor counts as its view's
    range of its buffer (VK_WHOLE_SIZE: to the buffer's end): read by a
    draw or dispatch for the submit flush, and, for a storage texel buffer
    the bound pipeline may write (the ICD's scan: an imageBuffer variable
    not decorated NonWritable), GPU-written there for readback.
