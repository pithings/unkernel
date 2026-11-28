// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk host renderer: the Vulkan subset of vk/PROTOCOL.md on a GPUDevice.
// One VkConnection per guest stream (VkInstance): it reassembles frames
// from arbitrary chunks, runs requests strictly in order through an async
// queue, keeps the guest's objects by id and answers requests that carry
// "r". Command lists of vkQueueSubmit are replayed by vk-exec.ts.
//
// Nothing throws out of the message loop: each op runs in a WebGPU error
// scope and a try block, failures are logged once per distinct text
// ("kwvk: <op>: <error>") and answered with "err" when the request has
// "r". What the guest cannot be told at the call that caused it is never
// left as a silently wrong result: a failed submit (a command the host
// cannot encode, or a WebGPU validation error, which drops the whole
// submit) or a failed request without "r" ends the connection as a lost
// device (deviceLost: a {"lost"} frame with the reason, then the close); an
// object whose creation failed is kept as a tombstone, so that its first
// use fails with the reason. Pipelines are requests with a reply that waits
// for WGSL compilation and pipeline validation (pipelineCheck).

import { formatTable, formatCaps, CAP_FILTER, vkFormat, texFormatInfo, hasDepth, hasStencil, srgbTwin, texelFormat, texelTable, TEXEL_UNIFORM, TEXEL_STORAGE, type VkFormatInfo } from "./vk-formats.ts";
import { runSubmit, resolveQueries } from "./vk-exec.ts";

// The translator's interface (js/core/vk-shader.ts), restated so this
// module does not depend on the wasm loader.
export interface VkShaderOpts {
	stage: "vertex" | "fragment" | "compute";
	entryPoint: string;
	flipY?: boolean;
	pushGroup?: number;
	spec?: Record<number, number | boolean>;
	/** descriptor arrays, "set.binding" -> element i at wgslBinding base + 2*i */
	arrays?: Record<string, { base: number; count: number }>;
	/** fragment: the vertex stage's varyings (interpolation matched per location) */
	link?: { location: number; interpolation: string; sampling: string }[];
	/** storage images declared without a format, "set.binding" -> WebGPU format */
	storageFormats?: Record<string, string>;
	/** the device's WebGPU features that change the translation ("shader-f16") */
	features?: string[];
	limits?: { maxComputeWorkgroupSizeX: number; maxComputeWorkgroupSizeY: number; maxComputeWorkgroupSizeZ: number; maxComputeInvocationsPerWorkgroup: number };
	/** compute: the subgroup size the guest reports (subgroup builtins without operations become arithmetic for it) */
	subgroupSize?: number;
}
export interface VkShaderBinding {
	set: number;
	binding: number;
	group: number;
	wgslBinding: number;
	kind: "uniform" | "storage" | "read-only-storage" | "sampler" | "comparison-sampler" | "texture" | "storage-texture";
	viewDimension?: string;
	sampleType?: string;
	multisampled?: boolean;
	format?: string;
	access?: string;
	arrayIndex?: number;
	/** a texel buffer's words ("data", a storage buffer) or parameters ("params", a uniform): vk/PROTOCOL.md, Amendments, "Texel buffers" */
	texel?: "data" | "params";
}
export interface VkShaderResult {
	wgsl: string;
	entryPoint: string;
	bindings: VkShaderBinding[];
	pushConstantSize?: number;
	varyings?: { location: number; interpolation: string; sampling: string }[];
	requires?: string[];
	dispatchScale?: [number, number, number];
}
export interface VkShaderTranslator {
	translate(spirv: Uint8Array, opts: VkShaderOpts): VkShaderResult;
}

export interface VkPresentInfo {
	connection: VkConnection;
	image: number;
	texture: any;
	width: number;
	height: number;
	format: string;
}

/** Counters per connection (`connection.stats`) and summed over the renderer's connections (`renderer.stats`). */
export interface VkStats {
	/** protocol messages handled */
	messages: number;
	submits: number;
	draws: number;
	dispatches: number;
	presents: number;
	/** guest -> host buffer bytes (writeBuffer) */
	bytesWritten: number;
	/** host -> guest bytes (readBuffer, present readback) */
	bytesRead: number;
	/** SPIR-V -> WGSL translations and the time they took */
	translations: number;
	translateMs: number;
	/** GPURenderPipeline / GPUComputePipeline creations (variants included) */
	pipelines: number;
	/** failed ops and WebGPU validation errors */
	errors: number;
	/** connections the host ended as a lost device for the guest (a failed submit or request it could not answer; WebGPU device losses not counted) */
	lost: number;
	/** CPU time spent encoding submits (vk-exec.ts), ms */
	encodeMs: number;
	/** CPU time spent parsing frames (JSON), ms */
	parseMs: number;
	/** gauge: guest objects alive (ids held) */
	liveObjects: number;
	/** gauge: GPU buffers and textures held for guests, deferred destroys included (renderer-wide) */
	liveGpu: number;
	/** presents of external swapchains (no readback: a page compositor resolves them, `renderer.external()`) */
	externalPresents: number;
	/** pictures made for a page compositor by `renderer.external()` (resolved external buffers) */
	externalImages: number;
}

const GAUGES = new Set(["liveObjects", "liveGpu"]);

export function newStats(): VkStats {
	return { messages: 0, submits: 0, draws: 0, dispatches: 0, presents: 0, bytesWritten: 0, bytesRead: 0, translations: 0, translateMs: 0, pipelines: 0, errors: 0, lost: 0, encodeMs: 0, parseMs: 0, liveObjects: 0, liveGpu: 0, externalPresents: 0, externalImages: 0 };
}

/** wland's ExternalRef (protocol/wland-external-buffer-v1.xml): the id, as the ICD made it, is (token << 32) | export id. */
export interface VkExternalRef {
	id: bigint;
	width: number;
	height: number;
	/** DRM fourcc: ARGB8888 / XRGB8888 (B8G8R8A8 images), ABGR8888 / XBGR8888 (R8G8B8A8) */
	format: number;
	flags: number;
}
/** DRM fourccs of external buffers: alpha (premultiplied) or opaque, by the image's byte order. */
export const DRM_FORMATS: Record<number, { base: string; opaque: boolean }> = {
	0x34325241: { base: "bgra8unorm", opaque: false }, // AR24
	0x34325258: { base: "bgra8unorm", opaque: true }, // XR24
	0x34324241: { base: "rgba8unorm", opaque: false }, // AB24
	0x34324258: { base: "rgba8unorm", opaque: true }, // XB24
};
/**
 * Per-connection tokens handed out (the high 32 bits of every external id),
 * never given twice in this realm, renderers after a device loss included:
 * an id an old connection made can never name a newer connection's image.
 */
const usedTokens = new Set<number>();
function newToken(): number {
	const a = new Uint32Array(1);
	for (;;) {
		globalThis.crypto.getRandomValues(a);
		if (a[0] && !usedTokens.has(a[0])) {
			usedTokens.add(a[0]);
			return a[0];
		}
	}
}

export interface VkRendererOptions {
	device: any;
	adapter?: any;
	shaders: VkShaderTranslator;
	log?: (line: string) => void;
	/** called after each present, with the presented texture (valid until the next present of that image) */
	onPresent?: (info: VkPresentInfo) => void;
	/** called once when the GPUDevice is lost, after every connection was failed and closed */
	onLost?: (info: { reason?: string; message?: string }) => void;
	/**
	 * Offer external present (the hello's `external` token; renderer.external()).
	 * Default: where this thread has OffscreenCanvas. The SDK passes false where
	 * its probe (vk.ts probeCanvas) found the WebGPU canvas path broken.
	 */
	external?: boolean;
}

/**
 * The subgroup size the host offers in the hello (vk/PROTOCOL.md, Amendments,
 * "Subgroup size"): what the ICD reports unless KWVK_SUBGROUP_SIZE asks for
 * another. Apps size workgroups by it (llama.cpp's mat-vec shaders run one
 * invocation per workgroup at 1); 32 keeps their largest multiple (4x) within
 * the 256 invocations every WebGPU device allows. No subgroup operation is
 * offered: the builtins are arithmetic on the local index (vk-shader.ts).
 */
export const VK_SUBGROUP_SIZE = 32;

/**
 * Engines (the hello's `engineName`, VkApplicationInfo.pEngineName) that draw
 * every pass with a negative viewport height: their graphics pipelines are
 * made for that first, the flipped variant only when a draw needs it
 * (vk/PROTOCOL.md, Amendments, "Y flip hint"). wgpu-hal: set_viewport and
 * begin_render_pass always flip (wgpu-hal 29, vulkan/command.rs).
 */
const NO_FLIP_ENGINES = new Set(["wgpu-hal"]);

/** Limits on what one guest stream may make the host hold (the guest is untrusted). */
export const VK_MAX_FRAME = 1 << 28;
export const VK_MAX_OBJECTS = 1 << 20;
/** Frames above this get a buffer of their own while they arrive. */
const BIG_FRAME = 1 << 20;

export interface VkConnection {
	feed(bytes: Uint8Array): void;
	close(): void;
	/** unique per renderer */
	readonly id: number;
	readonly stats: VkStats;
	/** the last presented image, for a later zero-copy path */
	lastPresented?: VkPresentInfo;
}

// GPUBufferUsage / GPUTextureUsage / GPUShaderStage / GPUMapMode values
export const BU = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
export const TU = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
export const SS = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
const MAP_READ = 1;

export const UNUSED = 0xffffffff;
export function isWhole(v: any): boolean {
	return v === undefined || v === null || v < 0 || v >= 2 ** 52;
}
/** v rounded up (alignDown: down) to a multiple of a, exact past 2^31 (buffer sizes and offsets; `&` is 32-bit) */
export function alignUp(v: number, a: number): number {
	return Math.ceil(v / a) * a;
}
export function alignDown(v: number, a: number): number {
	return v - (v % a);
}

const COMPARE = ["never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"];
const ADDRESS = ["repeat", "mirror-repeat", "clamp-to-edge", "clamp-to-edge", "mirror-repeat"];
const VIEW_DIM = ["1d", "2d", "3d", "cube", "2d-array", "2d-array", "cube-array"];

// Vulkan descriptor types
export const DT = { SAMPLER: 0, COMBINED: 1, SAMPLED_IMAGE: 2, STORAGE_IMAGE: 3, UNIFORM_TEXEL: 4, STORAGE_TEXEL: 5, UNIFORM: 6, STORAGE: 7, UNIFORM_DYN: 8, STORAGE_DYN: 9, INPUT_ATTACHMENT: 10 };

/** A failure that makes the device lost for the guest whatever the request (thrown by runSubmit). */
export class VkDeviceLost extends Error {}

/** An error whose reply carries the VkResult the ICD should return ("result"). */
export class VkResultError extends Error {
	result: number;
	constructor(message: string, result: number) {
		super(message);
		this.result = result;
	}
}
export const VK_ERROR_FEATURE_NOT_PRESENT = -8;

/** Ops that create objects by id: when one fails without a reply, its ids become tombstones (failing at first use). */
const CREATE_OPS = new Set([
	"vkCreateBuffer", "vkCreateImage", "vkCreateImageView", "vkCreateSampler", "vkCreateShaderModule", "vkCreateDescriptorSetLayout",
	"vkCreatePipelineLayout", "vkCreateRenderPass", "vkCreateRenderPass2", "vkCreateFramebuffer", "vkCreateGraphicsPipelines",
	"vkCreateComputePipelines", "vkCreateQueryPool", "vkCreateBufferView", "vkAllocateDescriptorSets",
]);

/**
 * Pipeline failures that make the pipeline unusable rather than refused:
 * resource kinds WebGPU lacks (1D-array storage images), which apps such
 * as vkd3d declare in pipelines they make at start-up and may never run.
 * Binding one in a submit loses the device.
 */
const UNUSABLE = /_1d_array/;

/**
 * Debugging only, never set by the SDK: globalThis.KWVK_NO_GPU = true makes
 * the host encode every dispatch but run none (results are garbage) and
 * compile workgroups over the device's limits clamped, so a model's
 * per-token overhead (guest, protocol, host) can be timed on software
 * WebGPU without its GPU time.
 */
export function noGpu(): boolean {
	return (globalThis as { KWVK_NO_GPU?: boolean }).KWVK_NO_GPU === true;
}

/** The first line of a WebGPU message (they are multi-line chains). */
export function firstLine(text: string): string {
	const l = String(text).split("\n").map((x) => x.trim()).filter(Boolean);
	return (l[0] || "").slice(0, 400);
}

/** Strip Vulkan's pointer prefixes from keys, in place: pStages -> stages, pName -> name. */
function normalize(v: any, depth = 0): any {
	if (depth > 64) throw new Error("JSON nested too deeply");
	if (Array.isArray(v)) {
		if (v.length && typeof v[0] !== "object") return v;
		for (let i = 0; i < v.length; i++) {
			const e = v[i];
			if (e && typeof e === "object") normalize(e, depth + 1);
		}
		return v;
	}
	if (v && typeof v === "object") {
		for (const k in v) {
			const e = v[k];
			const c1 = k.charCodeAt(1);
			if (k.charCodeAt(0) === 112 /* p */ && ((c1 >= 65 && c1 <= 90) || (c1 === 112 && k.charCodeAt(2) >= 65 && k.charCodeAt(2) <= 90))) {
				let key = k.slice(c1 === 112 ? 2 : 1);
				key = key[0]!.toLowerCase() + key.slice(1);
				delete v[k];
				v[key] = e;
			}
			if (e && typeof e === "object") normalize(e, depth + 1);
		}
	}
	return v;
}

/** WebGPU features the renderer uses when the device has them (each widens the format table or the pipeline state it can map). */
export const VK_FEATURES = [
	"depth-clip-control", "depth32float-stencil8", "texture-compression-bc", "texture-compression-etc2", "texture-compression-astc",
	"indirect-first-instance", "rg11b10ufloat-renderable", "bgra8unorm-storage", "float32-filterable", "float32-blendable", "dual-source-blending",
	"clip-distances", "texture-component-swizzle", "shader-f16", "subgroups", "timestamp-query",
];

/** A GPUDeviceDescriptor for adapter.requestDevice(): the features above the adapter has and its best limits. */
export function vkDeviceDescriptor(adapter: any): any {
	const requiredLimits: Record<string, number> = {};
	for (const k in adapter.limits) {
		const v = adapter.limits[k];
		if (typeof v === "number") requiredLimits[k] = v;
	}
	return { label: "kwvk", requiredFeatures: VK_FEATURES.filter((f) => adapter.features.has(f)), requiredLimits };
}

export class VkRenderer {
	device: any;
	adapter: any;
	shaders: VkShaderTranslator;
	onPresent?: (info: VkPresentInfo) => void;
	logged = new Set<string>();
	logFn: (line: string) => void;
	/** shared helper pipelines (blit, clears), keyed */
	helpers = new Map<string, any>();
	conns = new Map<number, Conn>();
	/** live connections by their external token (hello reply) */
	tokens = new Map<number, Conn>();
	/** external present is offered (VkRendererOptions.external) */
	externalOk = false;
	nextConn = 1;
	retired: VkStats = newStats();
	canvases = new Map<string, any>();
	/** GPU buffers/textures created for guests and not yet destroyed */
	liveGpu = 0;
	bglCache = new Map<string, any>();
	emptyBGL: any;
	emptyBG: any;
	pushBGL: any;
	/** indices 0,i,i+1 for drawing triangle fans as lists */
	fanIndex?: { buf: any; count: number };
	/** resolves when the device is lost (every connection is then failed and closed); the SDK makes a new device and renderer for new programs */
	lost: Promise<{ reason?: string; message?: string }>;
	isLost = false;
	onLost?: (info: { reason?: string; message?: string }) => void;

	constructor(opts: VkRendererOptions) {
		this.device = opts.device;
		this.adapter = opts.adapter;
		this.shaders = opts.shaders;
		if (opts.onPresent) this.onPresent = opts.onPresent;
		if (opts.onLost) this.onLost = opts.onLost;
		this.externalOk = opts.external ?? typeof (globalThis as any).OffscreenCanvas === "function";
		this.logFn = opts.log || ((line) => console.warn(line));
		this.emptyBGL = this.device.createBindGroupLayout({ entries: [] });
		this.emptyBG = this.device.createBindGroup({ layout: this.emptyBGL, entries: [] });
		this.pushBGL = this.device.createBindGroupLayout({
			entries: [{ binding: 0, visibility: SS.VERTEX | SS.FRAGMENT | SS.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true } }],
		});
		const lost: Promise<any> = this.device.lost && typeof this.device.lost.then === "function" ? this.device.lost : new Promise(() => {});
		this.lost = lost.then((info: any) => {
			const i = { reason: info?.reason, message: info?.message };
			this.isLost = true;
			this.log(`kwvk: device lost (${i.reason ?? "?"}: ${i.message ?? ""}): failing ${this.conns.size} connection(s)`);
			for (const c of [...this.conns.values()]) c.lose(`the WebGPU device was lost (${i.message || i.reason || "?"})`);
			try {
				this.onLost?.(i);
			} catch {}
			return i;
		});
		try {
			this.device.addEventListener?.("uncapturederror", (e: any) => {
				this.retired.errors++;
				this.log(`kwvk: webgpu: ${e?.error?.message ?? e}`);
			});
		} catch {}
	}

	log(line: string): void {
		// WebGPU messages are multi-line chains: one line each
		line = line.split("\n").map((l) => l.trim()).filter(Boolean).join(" / ");
		if (line.length > 600) line = line.slice(0, 600) + "...";
		if (this.logged.has(line)) return;
		if (this.logged.size > 4096) this.logged.clear();
		this.logged.add(line);
		this.logFn(line);
	}

	/**
	 * One connection per guest stream. `close`, if given, is called when the
	 * host ends the stream itself (device loss, a malformed or oversized
	 * frame): the SDK should then close the vsock stream.
	 */
	connect(send: (bytes: Uint8Array) => void, close?: () => void): VkConnection {
		const c = new Conn(this, send, this.nextConn++, close);
		if (this.isLost) c.lose("the WebGPU device was lost");
		else this.conns.set(c.id, c);
		return c;
	}

	/** Totals over all connections, closed ones included. */
	get stats(): VkStats {
		const out = { ...this.retired };
		for (const c of this.conns.values()) for (const k in out) if (!GAUGES.has(k)) (out as any)[k] += (c.stats as any)[k];
		out.liveObjects = 0;
		for (const c of this.conns.values()) out.liveObjects += c.objs.size;
		out.liveGpu = this.liveGpu;
		return out;
	}

	gpuCreated(): void {
		this.liveGpu++;
	}

	/** Destroy a guest GPU buffer/texture once the work submitted so far is done. */
	gpuDestroy(gpu: any): void {
		const done = () => {
			try {
				gpu.destroy();
			} catch {}
			this.liveGpu--;
		};
		if (this.isLost) done();
		else this.device.queue.onSubmittedWorkDone().then(done, done);
	}

	/**
	 * An image of a connection as an ImageBitmap (GPU to GPU: a copy into an
	 * OffscreenCanvas configured for the device, then transferToImageBitmap),
	 * for a page compositor. The image is level 0, layer 0. undefined when
	 * the connection or image is gone or the format cannot go to a canvas.
	 */
	image(connection: VkConnection | number, imageId: number): ImageBitmap | undefined {
		const c = typeof connection === "number" ? this.conns.get(connection) : (connection as Conn);
		const img = c?.objs.get(imageId);
		if (!c || !img || img.t !== "image" || img.samples > 1) return undefined;
		return this.picture(img, false);
	}

	/**
	 * wland's resolveExternal for the ICD's external buffers (vk/PROTOCOL.md,
	 * Amendments, "External present"): the picture of the swapchain image the
	 * ref's id names, as it is now (the frame its last present queued: the ICD
	 * renders into it again only after the compositor released the buffer),
	 * GPU to GPU, no readback. Synchronous. null (the surface keeps its last
	 * content) for an id no live connection made (a wrong token, an image
	 * destroyed or never presented, a closed connection, a lost device) and
	 * for a claimed size, format or flags that are not the image's.
	 */
	external(ref: VkExternalRef): ImageBitmap | null {
		if (this.isLost || typeof ref?.id !== "bigint") return null;
		const c = this.tokens.get(Number(ref.id >> 32n));
		const e = c?.exported.get(Number(ref.id & 0xffffffffn));
		if (!c || c.closed || !e || c.objs.get(e.id) !== e.img || !e.img.presented) return null;
		const img = e.img, f = DRM_FORMATS[ref.format];
		if (!f || ref.flags !== 0 || ref.width !== img.width || ref.height !== img.height || img.format.replace(/-srgb$/, "") !== f.base) return null;
		let bmp: ImageBitmap | null = null;
		try {
			bmp = this.picture(img, f.opaque) ?? null;
		} catch (err) {
			this.log(`kwvk: external image: ${(err as Error).message}`);
		}
		if (bmp) c.stats.externalImages++;
		return bmp;
	}

	/** Level 0, layer 0 of an image into an ImageBitmap: a copy into a WebGPU OffscreenCanvas on the device (premultiplied alpha, or opaque: alpha read as 1), then transferToImageBitmap. */
	picture(img: any, opaque: boolean): ImageBitmap | undefined {
		const base = img.format.replace(/-srgb$/, "");
		if (base !== "bgra8unorm" && base !== "rgba8unorm" && base !== "rgba16float") return undefined;
		const OC = (globalThis as any).OffscreenCanvas;
		if (!OC) return undefined;
		const key = `${img.width}x${img.height}:${base}:${opaque ? "opaque" : "premultiplied"}`;
		let cv = this.canvases.get(key);
		if (!cv) {
			const canvas = new OC(img.width, img.height);
			const ctx = canvas.getContext("webgpu");
			if (!ctx) return undefined;
			ctx.configure({ device: this.device, format: base, usage: TU.COPY_DST | TU.RENDER_ATTACHMENT, alphaMode: opaque ? "opaque" : "premultiplied" });
			cv = { canvas, ctx };
			if (this.canvases.size > 8) this.canvases.clear();
			this.canvases.set(key, cv);
		}
		const e = this.device.createCommandEncoder({ label: "kwvk image" });
		e.copyTextureToTexture({ texture: img.tex }, { texture: cv.ctx.getCurrentTexture() }, [img.width, img.height, 1]);
		this.device.queue.submit([e.finish()]);
		return cv.canvas.transferToImageBitmap();
	}
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function frame(json: any, bin?: Uint8Array): Uint8Array {
	const j = enc.encode(JSON.stringify(json));
	const padded = (j.length + 3) & ~3;
	const blen = bin ? bin.length : 0;
	const out = new Uint8Array(8 + padded + blen);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, padded + blen, true);
	dv.setUint32(4, j.length, true);
	out.set(j, 8);
	if (bin) out.set(bin, 8 + padded);
	return out;
}

interface Reply {
	json?: any;
	bin?: Uint8Array;
	/** runs once the reply was framed (bin may be a mapped range until then) */
	after?: () => void;
}
interface Deferred {
	defer: Promise<Reply | undefined>;
}

export class Conn implements VkConnection {
	r: VkRenderer;
	id: number;
	stats: VkStats = newStats();
	dev: any;
	sendFn: (bytes: Uint8Array) => void;
	buf = new Uint8Array(4096);
	len = 0;
	chain: Promise<void> = Promise.resolve();
	closed = false;
	objs = new Map<number, any>();
	lastPresented?: VkPresentInfo;
	/** the high 32 bits of this connection's external ids (hello reply), 0 before the hello */
	token = 0;
	/** the subgroup size the guest reports (hello): compute stages get their subgroup builtins for it; an ICD that asks nothing reports 1 */
	subgroupSize = 1;
	/** the app's engine draws with negative viewport heights (hello's engineName): vertex stages are translated without the y flip first */
	noFlip = false;
	/** the hello's engineName, and whether a draw in the orientation its pipelines were not made for was logged (once) */
	engineName = "";
	flipMissLogged = false;
	/** export id (the low 32 bits) -> the image it names; ids are never given twice */
	exported = new Map<number, { id: number; img: any }>();
	nextExport = 1;
	closeFn?: () => void;
	/** "r" of deferred replies not sent yet (answered with err at device loss) */
	pending = new Set<number>();
	/** settles once the WebGPU validation of every submit so far is known (a failed one lost the device first) */
	checked: Promise<unknown> = Promise.resolve();
	/** a timestamp read earlier than the one before it was raised (logged once) */
	tsRaised = false;

	constructor(r: VkRenderer, send: (bytes: Uint8Array) => void, id: number, close?: () => void) {
		this.r = r;
		this.id = id;
		this.dev = r.device;
		this.sendFn = send;
		if (close) this.closeFn = close;
	}

	get bglCache(): Map<string, any> {
		return this.r.bglCache;
	}
	get emptyBGL(): any {
		return this.r.emptyBGL;
	}
	get emptyBG(): any {
		return this.r.emptyBG;
	}
	get pushBGL(): any {
		return this.r.pushBGL;
	}
	get fanIndex(): { buf: any; count: number } | undefined {
		return this.r.fanIndex;
	}
	set fanIndex(v: { buf: any; count: number } | undefined) {
		this.r.fanIndex = v;
	}

	/** Fail the connection (device loss, protocol abuse): say why ({"lost"}), answer what is pending with err, drop everything, end the stream. */
	lose(why: string): void {
		if (this.closed) return;
		this.send({ r: 0, lost: why });
		for (const r of this.pending) this.send({ r, err: why });
		this.pending.clear();
		this.close();
		try {
			this.closeFn?.();
		} catch {}
	}

	log(line: string): void {
		this.r.log(line);
	}

	/**
	 * The guest's work went wrong in a way no reply can report (a failed
	 * submit, a failed request without "r"): rather than let the program go
	 * on with wrong or missing results, its device is lost (VK_ERROR_DEVICE_LOST
	 * from its next wait, submit or present; the ICD prints `why`).
	 */
	deviceLost(why: string): void {
		if (this.closed) return;
		this.stats.lost++;
		this.log(`kwvk: connection ${this.id}: device lost for the guest: ${why}`);
		this.lose(why);
	}

	feed(bytes: Uint8Array): void {
		if (this.closed || !bytes.length) return;
		let src = bytes;
		while (src.length && !this.closed) {
			// a large frame (writeBuffer of a big buffer) fills a buffer of its own: one copy, no regrowing
			const big = this.big;
			if (big) {
				const n = Math.min(src.length, big.data.length - big.filled);
				big.data.set(src.subarray(0, n), big.filled);
				big.filled += n;
				src = src.subarray(n);
				if (big.filled < big.data.length) return;
				this.big = undefined;
				this.frameBody(big.data, big.jlen, true);
				continue;
			}
			// a growable buffer (doubling), so frames that arrive in many small chunks cost O(n)
			if (this.len + src.length > this.buf.length) {
				const n = new Uint8Array(Math.max(this.buf.length * 2, this.len + src.length, 4096));
				n.set(this.buf.subarray(0, this.len));
				this.buf = n;
			}
			this.buf.set(src, this.len);
			this.len += src.length;
			src = src.subarray(src.length);
			let off = 0;
			while (this.len - off >= 8) {
				const dv = new DataView(this.buf.buffer, this.buf.byteOffset + off, 8);
				const total = dv.getUint32(0, true);
				const jlen = dv.getUint32(4, true);
				if (total > VK_MAX_FRAME || jlen > total) {
					this.log(`kwvk: frame: bad lengths (total ${total}, json ${jlen}): closing the connection`);
					this.lose("bad frame");
					return;
				}
				if (this.len - off - 8 < total) {
					if (total > BIG_FRAME) {
						const data = new Uint8Array(total);
						data.set(this.buf.subarray(off + 8, this.len));
						this.big = { data, filled: this.len - off - 8, jlen };
						off = this.len;
					}
					break;
				}
				const body = this.buf.subarray(off + 8, off + 8 + total);
				off += 8 + total;
				this.frameBody(body, jlen, false);
			}
			if (off) {
				this.buf.copyWithin(0, off, this.len);
				this.len -= off;
				if (this.len === 0 && this.buf.length > 1 << 20) this.buf = new Uint8Array(4096);
			}
		}
	}

	big?: { data: Uint8Array; filled: number; jlen: number };

	/** Queue one frame's message; `owned` bodies are not reused, so the binary is a view of them. */
	frameBody(body: Uint8Array, jlen: number, owned: boolean): void {
		const padded = (jlen + 3) & ~3;
		let msg: any;
		const t0 = performance.now();
		try {
			msg = normalize(JSON.parse(dec.decode(body.subarray(0, Math.min(jlen, body.length)))));
			this.stats.parseMs += performance.now() - t0;
		} catch (e) {
			// the guest may be waiting on this request: no silent drop
			this.deviceLost(`a frame with bad JSON (${(e as Error).message})`);
			return;
		}
		const rest = body.subarray(Math.min(padded, body.length));
		const bin = owned ? rest : rest.slice();
		this.chain = this.chain.then(() => this.run(msg, bin));
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.r.conns.delete(this.id);
		if (this.token && this.r.tokens.get(this.token) === this) this.r.tokens.delete(this.token);
		this.exported.clear();
		for (const k in this.stats) if (!GAUGES.has(k)) (this.r.retired as any)[k] += (this.stats as any)[k];
		this.buf = new Uint8Array(0);
		this.big = undefined;
		this.len = 0;
		// not through the queue: a closed connection runs nothing more, and the GPU objects go now (deferred past in-flight work)
		for (const id of [...this.objs.keys()]) this.destroyOne(id);
		this.stats.liveObjects = 0;
	}

	send(json: any, bin?: Uint8Array): void {
		if (this.closed) return;
		try {
			this.sendFn(frame(json, bin));
		} catch (e) {
			this.log(`kwvk: send: ${(e as Error).message}`);
		}
	}

	replyTo(msg: any, res: Reply | undefined): void {
		try {
			if (!msg.r) return;
			this.pending.delete(msg.r);
			this.send({ ...(res?.json || {}), r: msg.r }, res?.bin);
		} finally {
			res?.after?.();
		}
	}

	/**
	 * An op failed: a request with "r" is answered with err (and a VkResult
	 * when the error has one); a creation without "r" leaves tombstones under
	 * its ids; anything else (or a VkDeviceLost) loses the device.
	 */
	fail(msg: any, e: unknown): void {
		const text = (e as Error)?.message ?? String(e);
		const op = String(msg?.op);
		this.stats.errors++;
		this.log(`kwvk: ${op}: ${text}`);
		if (e instanceof VkDeviceLost) {
			if (msg?.r) this.pending.add(msg.r);
			this.deviceLost(`${op}: ${text}`);
		} else if (msg?.r) {
			this.pending.delete(msg.r);
			const reply: any = { r: msg.r, err: text };
			if (e instanceof VkResultError) reply.result = e.result;
			this.send(reply);
		} else if (CREATE_OPS.has(op)) {
			this.tombstone(msg, `${op}: ${text}`);
		} else {
			this.deviceLost(`${op}: ${text}`);
		}
	}

	/** The ids a creation message makes. */
	createdIds(msg: any): number[] {
		if (msg?.op === "vkAllocateDescriptorSets") return (Array.isArray(msg.sets) ? msg.sets : []).map((s: any) => s?.id);
		return [msg?.id];
	}

	/** Objects whose creation failed: kept so that their first use fails with the reason, not as an unknown id. */
	tombstone(msg: any, why: string): void {
		try {
			for (const id of this.createdIds(msg)) if (Number.isInteger(id) && id > 0 && id <= 0xffffffff) this.put(id, { t: "failed", why });
		} catch (e) {
			this.deviceLost(`${why} (${(e as Error).message})`);
		}
	}

	async run(msg: any, bin: Uint8Array): Promise<void> {
		if (this.closed) return;
		if (!msg || typeof msg !== "object" || Array.isArray(msg)) msg = { op: "?" };
		if (msg.r !== undefined && !(Number.isInteger(msg.r) && msg.r > 0)) msg.r = 0;
		const op = String(msg.op);
		const dev = this.dev;
		this.stats.messages++;
		dev.pushErrorScope("validation");
		let out: any;
		try {
			const h = (handlers as any)[op];
			if (!h) throw new Error("unsupported op");
			out = h(this, msg, bin);
			if (out && typeof out.then === "function") out = await out;
		} catch (e) {
			out = undefined;
			this.fail(msg, e);
			msg = { ...msg, r: 0, failed: true };
		}
		// a creation WebGPU refuses (asynchronously) leaves a tombstone; any
		// other op without a reply that WebGPU refuses loses the device
		const made = !msg.r && !msg.failed && CREATE_OPS.has(op) ? this.createdIds(msg).map((id) => [id, this.objs.get(id)] as const) : undefined;
		dev.popErrorScope().then(
			(err: any) => {
				if (!err) return;
				this.stats.errors++;
				this.log(`kwvk: ${op}: ${err.message}`);
				if (msg.r || msg.failed || op === "destroy") return;
				const why = `${op}: ${firstLine(err.message)}`;
				if (!made) return this.deviceLost(why);
				for (const [id, o] of made) if (o && this.objs.get(id) === o) this.put(id, { t: "failed", why });
			},
			() => {},
		);
		if (out && out.defer) {
			if (msg.r) this.pending.add(msg.r);
			(out as Deferred).defer.then(
				(res) => this.replyTo(msg, res),
				(e) => this.fail(msg, e),
			);
		} else if (msg.r) this.replyTo(msg, out as Reply | undefined);
	}

	get(id: number, what?: string): any {
		const o = this.objs.get(id);
		if (!o) throw new Error(`no ${what || "object"} ${id}`);
		if (o.t === "failed") throw new Error(`${what || "object"} ${id} failed at its creation (${o.why})`);
		if (what && o.t !== what) throw new Error(`object ${id} is a ${o.t}, not a ${what}`);
		return o;
	}

	put(id: number, o: any): void {
		if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff) throw new Error(`bad id ${id}`);
		if (this.objs.has(id)) this.destroyOne(id);
		else if (this.objs.size >= VK_MAX_OBJECTS) throw new Error("too many objects");
		this.objs.set(id, o);
		this.stats.liveObjects = this.objs.size;
	}

	destroyOne(id: number): void {
		const o = this.objs.get(id);
		if (!o) return;
		this.objs.delete(id);
		this.stats.liveObjects = this.objs.size;
		const gpu = o.t === "buffer" ? o.buf : o.t === "image" ? o.tex : undefined;
		if (gpu) this.r.gpuDestroy(gpu);
		// its external id now resolves to null, and is never given to another image
		if (o.t === "image" && o.exportId) this.exported.delete(o.exportId);
		if (o.t === "queryPool") {
			if (o.set) this.r.gpuDestroy(o.set);
			this.r.gpuDestroy(o.results);
		}
		if (o.t === "bufferView") this.r.gpuDestroy(o.params);
	}

	// --- views -----------------------------------------------------------

	/** A GPUTextureView of an image view for binding ("bind"), attachment ("att") or storage ("storage"). */
	viewFor(v: any, use: string, sampleType?: string, dimension?: string): any {
		const key = `${use}:${sampleType || ""}:${dimension || ""}`;
		let gv = v.cache.get(key);
		if (gv) return gv;
		const img = v.image;
		const r = v.range;
		const desc: any = { format: v.tex, baseMipLevel: r.baseMipLevel, baseArrayLayer: r.baseArrayLayer };
		const levels = isWhole(r.levelCount) || r.levelCount === UNUSED ? img.mipLevels - r.baseMipLevel : r.levelCount;
		const layers = isWhole(r.layerCount) || r.layerCount === UNUSED ? img.layers - r.baseArrayLayer : r.layerCount;
		const ds = hasDepth(v.tex) && hasStencil(v.tex);
		if (use === "att") {
			desc.dimension = "2d";
			desc.mipLevelCount = 1;
			desc.arrayLayerCount = 1;
			desc.aspect = "all";
		} else {
			desc.dimension = dimension || VIEW_DIM[v.viewType] || "2d";
			if (v.viewType === 4) this.log("kwvk: vkCreateImageView: 1D array views are unsupported");
			desc.mipLevelCount = use === "storage" ? 1 : levels;
			desc.arrayLayerCount = desc.dimension === "3d" ? 1 : desc.dimension === "2d" || desc.dimension === "1d" ? 1 : layers;
			// swizzles apply to sampled views only (WebGPU requires identity for storage)
			if (v.swizzle && use === "bind") desc.swizzle = v.swizzle;
			if (ds || hasDepth(v.tex) || hasStencil(v.tex)) {
				const m = r.aspectMask;
				if (sampleType === "uint" || (m & 4 && !(m & 2))) desc.aspect = hasDepth(v.tex) ? "stencil-only" : "all";
				else desc.aspect = ds ? "depth-only" : "all";
			}
		}
		gv = img.tex.createView(desc);
		v.cache.set(key, gv);
		return gv;
	}

	// --- shaders and layouts -----------------------------------------------

	/** `mod`: a shader module's id, or the module itself (a pipeline's stage keeps it: the app may destroy the module once the pipeline is made, and a variant made at draw time translates it again). */
	translate(mod: number | any, opts: VkShaderOpts): { module: any; res: VkShaderResult; check: Promise<string | undefined> } {
		const m = typeof mod === "number" ? this.get(mod, "shader") : mod;
		const moduleId = m.id;
		const key = JSON.stringify(opts);
		let t = m.cache.get(key);
		if (!t) {
			const t0 = performance.now();
			let res: VkShaderResult;
			// relink and keepReadOnly are the host's own post-passes, not translator options
			const { relink, keepReadOnly, ...topts } = opts as VkShaderOpts & { relink?: Record<number, string>; keepReadOnly?: boolean };
			try {
				res = this.r.shaders.translate(m.code, topts);
				if (relink) res = { ...res, wgsl: relinkVertexOutputs(res.wgsl, relink) };
				res = pruneDeadBindings(res);
				// Compute: read-only storage buffers become read_write. A Vulkan app
				// may bind one buffer (at other offsets) both read-only and writable
				// in one dispatch (ggml-vulkan does); WebGPU refuses read-only +
				// writable storage of one buffer in a usage scope, but allows
				// writable + writable. (Vertex stages cannot have writable storage.)
				// keepReadOnly: the pipeline's fallback when WebGPU refused that
				// (makePipeline readOnlyRetry; vk-exec.ts aliasFix copies such a
				// buffer aside when the dispatch also binds it writable).
				if (topts.stage === "compute" && !keepReadOnly)
					res = {
						...res,
						wgsl: res.wgsl.replace(/var<storage(, ?read)?>/g, "var<storage, read_write>"),
						bindings: res.bindings.map((b) => (b.kind === "read-only-storage" ? { ...b, kind: "storage" as const, ro: true } : b)),
					};
				// KWVK_NO_GPU (debugging): no dispatch runs, so a workgroup over the device's limits only needs to compile
				if (topts.stage === "compute" && noGpu()) {
					const l = this.dev.limits;
					res = { ...res, wgsl: res.wgsl.replace(/@workgroup_size\((\d+)(?:, ?(\d+))?(?:, ?(\d+))?\)/, (_s, x, y, z) => {
						let [a, b, c] = [Number(x), Number(y || 1), Number(z || 1)];
						while (a * b * c > l.maxComputeInvocationsPerWorkgroup || a > l.maxComputeWorkgroupSizeX) a = Math.max(1, a >> 1);
						while (a * b * c > l.maxComputeInvocationsPerWorkgroup || b > l.maxComputeWorkgroupSizeY) b = Math.max(1, b >> 1);
						while (a * b * c > l.maxComputeInvocationsPerWorkgroup || c > l.maxComputeWorkgroupSizeZ) c = Math.max(1, c >> 1);
						return `@workgroup_size(${a}, ${b}, ${c})`;
					}) };
				}
			} catch (e) {
				// Debugging: globalThis.KWVK_DUMP_SPIRV = true logs the module.
				if ((globalThis as { KWVK_DUMP_SPIRV?: boolean }).KWVK_DUMP_SPIRV) this.log(`kwvk: shader ${moduleId} ${opts.stage} SPIR-V (base64): ${b64(m.code)}`);
				throw new Error(`${opts.stage} stage of shader module ${moduleId}: ${(e as Error)?.message ?? e}`);
			}
			this.stats.translations++;
			this.stats.translateMs += performance.now() - t0;
			// WebGPU features the shader needs (vk-shader.ts result.requires).
			// uniform_buffer_standard_layout is a WGSL language feature (Chrome's; not Firefox's or Safari's).
			const lang = (globalThis as { navigator?: { gpu?: { wgslLanguageFeatures?: { has(f: string): boolean } } } }).navigator?.gpu?.wgslLanguageFeatures;
			const missing = (res.requires || []).filter((f) => !this.dev.features?.has?.(f) && !lang?.has?.(f));
			if (missing.length) throw new Error(`${opts.stage} stage of shader module ${moduleId}: shader needs WebGPU features the device lacks: ${missing.map((f) => (f.includes("_") ? `${f} (a WGSL language feature this browser lacks)` : f)).join(", ")}`);
			const module = this.dev.createShaderModule({ code: res.wgsl, label: `kwvk shader ${moduleId} ${opts.stage}` });
			// the first WGSL error (Tint's, e.g. its uniformity analysis), or undefined: pipelines wait for it (pipelineCheck)
			const check: Promise<string | undefined> = module.getCompilationInfo
				? module.getCompilationInfo().then(
						(info: any) => {
							const m = (info.messages || []).find((x: any) => x.type === "error");
							return m ? `${opts.stage} stage of shader module ${moduleId}: WGSL ${m.lineNum}:${m.linePos}: ${firstLine(m.message)}` : undefined;
						},
						() => undefined,
					)
				: Promise.resolve(undefined);
			t = { module, res, check };
			m.cache.set(key, t);
		}
		return t;
	}

	bgl(entries: any[]): { key: string; layout: any } {
		entries.sort((a, b) => a.binding - b.binding);
		const key = JSON.stringify(entries);
		let layout = this.bglCache.get(key);
		if (!layout) {
			layout = entries.length ? this.dev.createBindGroupLayout({ entries }) : this.emptyBGL;
			this.bglCache.set(key, layout);
		}
		return { key, layout };
	}

	/**
	 * The bind group layouts of a pipeline: per set from the reflected
	 * bindings of its stages (falling back to the Vulkan set layout), then
	 * the push constant group.
	 */
	pipelineLayout(layoutId: number, stages: { stage: number; res: VkShaderResult }[]): any {
		const pl = this.get(layoutId, "pipelineLayout");
		const sets: any[] = [];
		const reflected = stages.some((s) => Array.isArray(s.res.bindings));
		for (let s = 0; s < pl.setLayouts.length; s++) {
			const dsl = pl.setLayouts[s] ? this.get(pl.setLayouts[s], "setLayout") : { bindings: new Map() };
			const byWgsl = new Map<number, any>();
			// wgslBinding -> [Vulkan binding, array element]
			const src = new Map<number, [number, number]>();
			if (reflected) {
				for (const st of stages) {
					for (const b of st.res.bindings || []) {
						if (b.group !== s) continue;
						const prev = byWgsl.get(b.wgslBinding);
						if (prev) {
							prev.visibility |= st.stage;
							continue;
						}
						byWgsl.set(b.wgslBinding, entryFromReflection(b, st.stage, dsl));
						src.set(b.wgslBinding, [b.binding ?? b.wgslBinding >> 1, b.arrayIndex ?? 0]);
					}
				}
			} else {
				const vis = stages.reduce((a, s) => a | s.stage, 0);
				for (const [binding, d] of dsl.bindings) {
					for (const e of entriesFromVk(binding, d, vis)) {
						byWgsl.set(e.binding, e);
						src.set(e.binding, [binding, 0]);
					}
				}
			}
			const entries = [...byWgsl.values()];
			const { key, layout } = this.bgl(entries);
			// dynamic buffers of this set as WebGPU orders them, as indices into the Vulkan order
			const dynIdx: number[] = [];
			const vkDyn = dsl.dynamic as string[] | undefined;
			for (const e of [...entries].sort((a, b) => a.binding - b.binding)) {
				if (e.buffer?.hasDynamicOffset) {
					const [b, el] = src.get(e.binding)!;
					dynIdx.push(vkDyn ? vkDyn.indexOf(`${b}:${el}`) : 0);
				}
			}
			sets.push({ key, layout, entries, dynIdx, src });
		}
		const pushSize = Math.max(pl.pushSize, ...stages.map((s) => s.res.pushConstantSize || 0));
		const groups = sets.map((s) => s.layout);
		let pushGroup = -1;
		if (pushSize > 0) {
			pushGroup = sets.length;
			groups.push(this.pushBGL);
		}
		// each texel buffer takes a storage and a uniform buffer slot of its
		// stages: past WebGPU's per-stage limits the pipeline is refused, named
		// (WebGPU would refuse the layout less plainly)
		if (sets.some((s) => s.entries.some((e: any) => e.kwTexel))) {
			const l = this.dev.limits || {};
			for (const [bit, stage] of [[SS.VERTEX, "vertex"], [SS.FRAGMENT, "fragment"], [SS.COMPUTE, "compute"]] as const) {
				let storage = 0, uniform = pushSize > 0 ? 1 : 0, texels = 0;
				for (const s of sets)
					for (const e of s.entries) {
						if (!(e.visibility & bit) || !e.buffer) continue;
						if (e.buffer.type === "uniform") uniform++;
						else storage++;
						if (e.kwTexel === "data") texels++;
					}
				const sl = l.maxStorageBuffersPerShaderStage ?? 8, ul = l.maxUniformBuffersPerShaderStage ?? 12;
				if (storage > sl || uniform > ul)
					throw new Error(`the ${stage} stage needs ${storage} storage and ${uniform} uniform buffers, ${texels} texel buffers taking one of each, over the device's maxStorageBuffersPerShaderStage (${sl}) or maxUniformBuffersPerShaderStage (${ul})`);
			}
		}
		const layout = this.dev.createPipelineLayout({ bindGroupLayouts: groups });
		const hasFloatTex = sets.some((s) => s.entries.some((e: any) => e.texture?.sampleType === "float"));
		const hasStorageTex = sets.some((s) => s.entries.some((e: any) => e.storageTexture));
		return { layout, sets, pushGroup, pushSize, hasFloatTex, hasStorageTex };
	}

	placeholders = new Map<string, any>();
	/** placeholders for unwritten bindings (bindGroup), by binding (buffers, storage textures) and kind */
	unwritten = new Map<string, any>();
	/**
	 * A placeholder resource for a bind group layout entry: a zeroed 64 KiB
	 * buffer, a 1x1 texture's view of the entry's dimension, sample type
	 * and sample count (a storage texture of its format), or a sampler.
	 */
	placeholderResource(e: any): any {
		if (e.buffer) return { buffer: this.dev.createBuffer({ size: 65536, usage: BU.STORAGE | BU.UNIFORM, label: "kwvk placeholder buffer" }) };
		if (e.sampler) return this.dev.createSampler(e.sampler.type === "comparison" ? { compare: "less" } : {});
		const t = e.texture || e.storageTexture;
		const formats: Record<string, string> = { float: "rgba8unorm", "unfilterable-float": "r32float", uint: "r32uint", sint: "r32sint", depth: "depth32float" };
		const dim = t.viewDimension || "2d";
		const layers = dim === "cube" || dim === "cube-array" ? 6 : 1;
		const tex = this.dev.createTexture({
			size: [1, 1, layers],
			dimension: dim === "1d" ? "1d" : dim === "3d" ? "3d" : "2d",
			format: e.texture ? formats[t.sampleType] || "rgba8unorm" : t.format,
			sampleCount: e.texture?.multisampled ? 4 : 1,
			usage: e.texture ? (e.texture.multisampled ? TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT : TU.TEXTURE_BINDING) : TU.STORAGE_BINDING,
			label: "kwvk placeholder texture",
		});
		return tex.createView({ dimension: dim });
	}

	/**
	 * A set the pipeline's shaders declare but the app never bound (GTK 4:
	 * a set its shaders only use under a specialization it does not take;
	 * the translator reflects unused bindings too): a bind group of
	 * placeholder resources (a zeroed buffer, a 1x1 texture, a sampler), so
	 * that the draw goes on; logged once per set.
	 */
	placeholderBindGroup(s: number, slot: any): any {
		let bg = this.placeholders.get(slot.key);
		if (bg) return bg;
		this.log(`kwvk: descriptor set ${s} not bound but declared by the pipeline's shaders: placeholder resources bound`);
		const entries = slot.entries.map((e: any) => ({ binding: e.binding, resource: this.placeholderResource(e) }));
		bg = this.dev.createBindGroup({ layout: slot.layout, entries });
		this.placeholders.set(slot.key, bg);
		return bg;
	}

	/** The bind group of a descriptor set for a pipeline's set slot. */
	bindGroup(set: any, slot: any, override?: Map<number, any>): any {
		if (!slot.entries.length) return this.emptyBG;
		if (!set) throw new Error("descriptor set not bound");
		let bg = override ? undefined : set.cache.get(slot.key);
		if (bg) return bg;
		const entries: any[] = [];
		for (const e of slot.entries) {
			const [vkb, el] = slot.src.get(e.binding) || [e.binding >> 1, 0];
			const d = set.desc.get(dkey(vkb, el));
			const immutable = e.sampler ? set.layout.bindings.get(vkb)?.immutable?.[el] : undefined;
			if (!d && immutable) {
				// a sampler binding with immutable samplers needs no write
				entries.push({ binding: e.binding, resource: this.get(immutable, "sampler").gpu });
				continue;
			}
			if (!d) {
				// Vulkan lets a binding the shader does not access stay unwritten
				// (ggml-vulkan leaves its unused operands; a shader may sample a
				// texture only on a branch the app never takes): a placeholder,
				// a zeroed buffer, a 1x1 texture or a sampler. Buffers and storage
				// textures get one per WGSL binding number, so two of them never
				// alias in a dispatch; logged once per connection.
				const own = e.buffer || e.storageTexture;
				const key = `${own ? e.binding : ""}:${JSON.stringify(e.buffer || e.sampler || e.texture || e.storageTexture)}:${e.buffer ? "b" : e.sampler ? "s" : e.texture ? "t" : "st"}`;
				let res = this.unwritten.get(key);
				if (!res) {
					if (!this.unwritten.size) this.log(`kwvk: set binding ${vkb}${el ? `[${el}]` : ""} not written: a placeholder ${e.buffer ? "buffer" : e.sampler ? "sampler" : "texture"} bound (logged once)`);
					res = this.placeholderResource(e);
					this.unwritten.set(key, res);
				}
				entries.push({ binding: e.binding, resource: res });
				continue;
			}
			if (e.kwTexel === "params") {
				if (!d.view) throw new Error(`set binding ${vkb}${el ? `[${el}]` : ""}: the shader reads a texel buffer, the descriptor is not one`);
				entries.push({ binding: e.binding, resource: { buffer: this.get(d.view, "bufferView").params, offset: 0, size: 16 } });
			} else if (e.buffer) {
				if (e.kwTexel && !d.view) throw new Error(`set binding ${vkb}${el ? `[${el}]` : ""}: the shader reads a texel buffer, the descriptor is not one`);
				const b = this.get(d.buffer, "buffer");
				const size = isWhole(d.range) ? b.size - d.offset : d.range;
				const sub = override?.get(e.binding);
				// WebGPU sizes a uniform binding by its WGSL struct, a multiple of 16
				// bytes, Vulkan by the bytes the app names (GZDoom binds 252): a
				// uniform range grows to 16-byte steps within the GPU buffer, which
				// for a uniform buffer ends on a 16-byte boundary (vkCreateBuffer);
				// offsets (and dynamic offsets) are multiples of
				// minUniformBufferOffsetAlignment, so the grown range fits wherever
				// the app's did
				const step = e.buffer.type === "uniform" ? 16 : 4;
				if (!sub && !e.buffer.hasDynamicOffset) {
					// a dispatch binds such a binding as a scratch copy (vk-exec.ts aliasFix); a draw cannot copy inside its render pass
					const name = e.buffer.type === "uniform" ? "minUniformBufferOffsetAlignment" : "minStorageBufferOffsetAlignment";
					const al = this.dev.limits?.[name] || 256;
					if (d.offset % al) throw new Error(`set binding ${vkb}${el ? `[${el}]` : ""} at offset ${d.offset}, not a multiple of ${name} (${al}): taken by compute dispatches only`);
				}
				if (sub) entries.push({ binding: e.binding, resource: { buffer: sub.buf, offset: 0, size: sub.size } });
				else entries.push({ binding: e.binding, resource: { buffer: b.buf, offset: d.offset, size: Math.min(alignUp(size, step), b.buf.size - d.offset) } });
			} else if (e.sampler) {
				const sid = d.sampler || set.layout.bindings.get(vkb)?.immutable?.[el];
				entries.push({ binding: e.binding, resource: this.get(sid, "sampler").gpu });
			} else if (e.texture) {
				const v = this.get(d.imageView, "imageView");
				entries.push({ binding: e.binding, resource: this.viewFor(v, "bind", e.texture.sampleType, e.texture.viewDimension) });
			} else if (e.storageTexture) {
				const v = this.get(d.imageView, "imageView");
				entries.push({ binding: e.binding, resource: this.viewFor(v, "storage", undefined, e.storageTexture.viewDimension) });
			}
		}
		bg = this.dev.createBindGroup({ layout: slot.layout, entries });
		if (!override) set.cache.set(slot.key, bg);
		return bg;
	}

	/**
	 * Layouts from reflection say "float" for every sampled float texture,
	 * but WebGPU binds depth and other unfilterable formats only as
	 * "unfilterable-float" with "non-filtering" samplers. Given the bound
	 * descriptor sets, return a refined copy of a pipeline layout (cached
	 * on it) when any bound view needs that, else undefined.
	 */
	refine(pl: any, sets: any[]): any {
		if (!pl.hasFloatTex) return undefined;
		let key = "";
		pl.sets.forEach((slot: any, s: number) => {
			const set = sets[s];
			if (!set) return;
			for (const e of slot.entries) {
				if (e.texture?.sampleType !== "float") continue;
				const [vkb, el] = slot.src?.get(e.binding) || [e.binding >> 1, 0];
				const d = set.desc.get(dkey(vkb, el));
				const v = d?.imageView && this.objs.get(d.imageView);
				if (v && !(formatFilterable(v.tex, this.dev.features))) key += `${s}:${e.binding},`;
			}
		});
		if (!key) return undefined;
		let r = pl.refined?.get(key);
		if (r) return r;
		const marks = new Set(key.split(",").filter(Boolean));
		const sl = pl.sets.map((slot: any, s: number) => {
			const hit = slot.entries.some((e: any) => marks.has(`${s}:${e.binding}`));
			if (!hit) return slot;
			const entries = slot.entries.map((e: any) => {
				if (e.texture && marks.has(`${s}:${e.binding}`)) return { ...e, texture: { ...e.texture, sampleType: "unfilterable-float" } };
				if (e.sampler?.type === "filtering") {
					const paired = marks.has(`${s}:${e.binding - 1}`);
					const [vkb, el] = slot.src?.get(e.binding) || [e.binding >> 1, 0];
					const d = sets[s]?.desc.get(dkey(vkb, el));
					const smp = d?.sampler && this.objs.get(d.sampler);
					if (paired || (smp && !smp.filtering)) return { ...e, sampler: { type: "non-filtering" } };
				}
				return e;
			});
			const { key: k, layout } = this.bgl(entries);
			return { ...slot, key: k, layout, entries };
		});
		const groups = sl.map((x: any) => x.layout);
		if (pl.pushGroup >= 0) groups.push(this.pushBGL);
		r = { ...pl, sets: sl, layout: this.dev.createPipelineLayout({ bindGroupLayouts: groups }), refineKey: key, refined: undefined };
		(pl.refined ||= new Map()).set(key, r);
		return r;
	}

	/**
	 * Storage images the shader declares without a format take the bound
	 * view's (vk-shader.ts opts.storageFormats): a pipeline variant per
	 * combination of bound formats that differ from the default the
	 * pipeline was made with. Returns the pipeline itself when none differ.
	 */
	storageVariant(p: any, sets: any[]): any {
		if (!p.layout.hasStorageTex) return p;
		let key = "";
		const formats: Record<string, string> = { ...(p.storageFormats || {}) };
		p.layout.sets.forEach((slot: any, s: number) => {
			for (const e of slot.entries) {
				if (!e.storageTexture) continue;
				const [b, el] = slot.src?.get(e.binding) || [e.binding >> 1, 0];
				const d = sets[s]?.desc.get(dkey(b, el));
				const v = d?.imageView && this.objs.get(d.imageView);
				if (v && v.tex !== e.storageTexture.format) {
					formats[`${s}.${b}`] = v.tex;
					key += `${s}.${b}=${v.tex},`;
				}
			}
		});
		if (!key) return p;
		const root = p.root || p;
		let v = root.storageVariants?.get(key);
		if (v) return v;
		const stages = root.stages.map((st: any) => {
			const opts = { ...st.opts, storageFormats: formats };
			return { ...st, opts, ...this.translate(st.mod, opts) };
		});
		const layout = this.pipelineLayout(root.layoutId ?? root.msg.layout, stages);
		v = { ...root, root, stages, layout, storageFormats: formats, variants: new Map(), storageVariants: undefined };
		if (root.kind === "compute") {
			this.stats.pipelines++;
			v.stage = stages[0];
			v.gpu = this.dev.createComputePipeline({ label: "kwvk pipeline (storage formats)", layout: layout.layout, compute: { module: stages[0].module, entryPoint: stages[0].res.entryPoint } });
		}
		(root.storageVariants ||= new Map()).set(key, v);
		return v;
	}

	/** Translate the stages of a pipeline message (keepReadOnly: compute storage buffers as the shader declares them). */
	stages(msg: any, pushGroupOf: number, setLayouts: number[] = [], keepReadOnly = false): { stage: number; kind: string; module: any; res: VkShaderResult; moduleId: number; opts: VkShaderOpts; check: Promise<string | undefined> }[] {
		const out: any[] = [];
		let arrays: Record<string, { base: number; count: number }> | undefined;
		setLayouts.forEach((id, s) => {
			const dsl = id ? this.objs.get(id) : undefined;
			for (const b in dsl?.arrays || {}) (arrays ||= {})[`${s}.${b}`] = dsl.arrays[b];
		});
		for (const st of msg.stages || []) {
			const kind = st.stage === 1 ? "vertex" : st.stage === 0x10 ? "fragment" : st.stage === 0x20 ? "compute" : "";
			if (!kind) throw new Error(`unsupported shader stage ${st.stage}`);
			const opts: VkShaderOpts = { stage: kind as any, entryPoint: st.name || "main", pushGroup: pushGroupOf };
			if (keepReadOnly && kind === "compute") (opts as any).keepReadOnly = true;
			// "shader-f16" keeps float16_t native; without it 16-bit storage is emulated (vk-shader.ts)
			if (this.dev.features?.has?.("shader-f16")) opts.features = ["shader-f16"];
			if (kind === "compute" && this.dev.limits) {
				// a larger workgroup may be shrunk (res.dispatchScale, applied at dispatch in vk-exec.ts)
				const l = this.dev.limits;
				opts.limits = { maxComputeWorkgroupSizeX: l.maxComputeWorkgroupSizeX, maxComputeWorkgroupSizeY: l.maxComputeWorkgroupSizeY, maxComputeWorkgroupSizeZ: l.maxComputeWorkgroupSizeZ, maxComputeInvocationsPerWorkgroup: l.maxComputeInvocationsPerWorkgroup };
				// KWVK_NO_GPU (debugging): every workgroup size translates; translate() clamps it
				if (noGpu()) opts.limits = { maxComputeWorkgroupSizeX: 1024, maxComputeWorkgroupSizeY: 1024, maxComputeWorkgroupSizeZ: 64, maxComputeInvocationsPerWorkgroup: 1024 };
			}
			if (arrays) opts.arrays = arrays;
			if (kind === "compute") opts.subgroupSize = this.subgroupSize;
			// the orientation the app is expected to draw with (Conn.noFlip); the other is a variant made at draw time
			if (kind === "vertex") opts.flipY = !this.noFlip;
			const sm = this.get(st.module, "shader");
			if (st.specializationInfo && !sm.specTypes) sm.specTypes = specTypes(sm.code);
			const spec = specValues(st.specializationInfo, sm.specTypes);
			if (spec) opts.spec = spec;
			// WebGPU wants equal interpolation per location across stages; in
			// Vulkan the fragment inputs' decorations decide: the vertex
			// outputs take them (relinkVertexOutputs).
			if (kind === "vertex") {
				const fst = (msg.stages || []).find((x: any) => x.stage === 0x10);
				const fm = fst && this.objs.get(fst.module);
				if (fm?.t === "shader") {
					fm.inputs ||= fragmentInputs(fm.code);
					if (Object.keys(fm.inputs).length) (opts as any).relink = fm.inputs;
				}
			}
			const { module, res, check } = this.translate(sm, opts);
			out.push({ stage: kind === "vertex" ? SS.VERTEX : kind === "fragment" ? SS.FRAGMENT : SS.COMPUTE, kind, module, res, moduleId: st.module, mod: sm, opts, check });
		}
		return out;
	}

	/**
	 * Create a pipeline's GPU objects inside an error scope of its own, then
	 * answer once its WGSL compiled and WebGPU validated it: {} (made), err
	 * (refused: the ICD returns VK_ERROR_INVALID_SHADER_NV, or the VkResult
	 * thrown) or {unusable} (UNUSABLE: made, but it cannot run). A pipeline
	 * that failed keeps `failed`, so binding it fails the submit. Once per
	 * pipeline (variants made at draw time are checked by their submit).
	 */
	makePipeline(msg: any, make: () => any): Reply | Deferred | undefined {
		this.dev.pushErrorScope("validation");
		let p: any;
		let scope: Promise<any>;
		try {
			p = make();
		} catch (e) {
			const why = (e as Error)?.message ?? String(e);
			if (!UNUSABLE.test(why)) throw e;
			// made, but it cannot run (vkd3d makes such pipelines at start-up)
			this.stats.errors++;
			this.log(`kwvk: ${msg.op} (pipeline ${msg.id}): ${why}`);
			this.put(msg.id, { t: "pipeline", kind: msg.op === "vkCreateComputePipelines" ? "compute" : "graphics", failed: why, stages: [] });
			return msg.r ? { json: { unusable: why } } : undefined;
		} finally {
			scope = this.dev.popErrorScope();
		}
		this.put(msg.id, p);
		const checks: Promise<string | undefined>[] = p.stages.map((st: any) => st.check);
		checks.push(scope.then((e: any) => (e ? firstLine(e.message) : undefined), (e: any) => firstLine(e?.message ?? String(e))));
		const defer = Promise.all(checks).then(async (errs) => {
			let why = errs.find(Boolean);
			// compute: refused with read-only storage made read_write (Tint takes
			// reads of read_write storage as non-uniform): try the shader's own
			// read-only buffers; the first reason stays if that fails too
			if (why && p.readOnlyRetry && (await p.readOnlyRetry())) why = undefined;
			if (!why) return msg.r ? { json: {} } : undefined;
			p.failed = why;
			if (msg.r && !UNUSABLE.test(why)) throw new Error(why); // fail() logs and answers err
			this.stats.errors++;
			this.log(`kwvk: ${msg.op} (pipeline ${msg.id}): ${why}`);
			// an ICD without replies: binding it fails the submit
			return msg.r ? { json: { unusable: why } } : undefined;
		});
		if (msg.r) return { defer };
		defer.catch(() => {});
		return undefined;
	}
}

function b64(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

/**
 * A fragment shader's input interpolation per location from its SPIR-V
 * (Flat 14, NoPerspective 13, Centroid 16, Sample 17 on Input variables):
 * location -> WGSL `@interpolate` arguments.
 */
export function fragmentInputs(code: Uint8Array): Record<number, string> {
	const out: Record<number, string> = {};
	if (code.length < 20 || code.length & 3) return out;
	const w = new Uint32Array(code.buffer.slice(code.byteOffset, code.byteOffset + code.length));
	if (w[0] !== 0x07230203) return out;
	const loc = new Map<number, number>();
	const deco = new Map<number, Set<number>>();
	const inputs = new Set<number>();
	for (let i = 5; i < w.length; ) {
		const op = w[i]! & 0xffff;
		const n = w[i]! >>> 16 || 1;
		if (op === 71) {
			const id = w[i + 1]!;
			const d = w[i + 2]!;
			if (d === 30) loc.set(id, w[i + 3]!);
			else if (d === 13 || d === 14 || d === 16 || d === 17) (deco.get(id) || deco.set(id, new Set()).get(id)!).add(d);
		} else if (op === 59 && w[i + 3] === 1) inputs.add(w[i + 2]!); // OpVariable ... Input
		else if (op === 54) break;
		i += n;
	}
	for (const id of inputs) {
		const l = loc.get(id);
		if (l === undefined) continue;
		const d = deco.get(id) || new Set();
		if (d.has(14)) out[l] = "flat";
		else out[l] = `${d.has(13) ? "linear" : "perspective"}, ${d.has(17) ? "sample" : d.has(16) ? "centroid" : "center"}`;
	}
	return out;
}

/** The index of the "}" closing the block whose "{" is at `open`. */
function blockEnd(t: string, open: number): number {
	let depth = 0;
	for (let i = open; i < t.length; i++) {
		if (t[i] === "{") depth++;
		else if (t[i] === "}" && --depth === 0) return i;
	}
	return -1;
}

/**
 * Drop branches a baked specialization constant made constant (naga
 * leaves `if false { ... }`) and leave out of the reflection the bindings
 * nothing references then: WebGPU validates every bound resource (ggml
 * binds one buffer range to two writable bindings, only one of them live).
 */
export function pruneDeadBindings(res: VkShaderResult): VkShaderResult {
	let t = res.wgsl;
	if (!/\bif (false|true) \{/.test(t)) return res;
	for (let guard = 0; guard < 1000; guard++) {
		const m = /\bif (false|true) \{/.exec(t);
		if (!m) break;
		const open = m.index + m[0].length - 1;
		const close = blockEnd(t, open);
		if (close < 0) return res;
		const thenBody = t.slice(open + 1, close);
		const rest = /^\s*else\s*/.exec(t.slice(close + 1));
		let elseBody = "";
		let end = close + 1;
		if (rest) {
			const after = close + 1 + rest[0].length;
			if (t[after] === "{") {
				const ec = blockEnd(t, after);
				if (ec < 0) return res;
				elseBody = t.slice(after + 1, ec);
				end = ec + 1;
			} else {
				// else if: a dead head goes, the chain goes on; a live head is left alone (marked so it is not matched again)
				t = m[1] === "false" ? t.slice(0, m.index) + t.slice(after) : t.slice(0, m.index) + "if (true) {" + t.slice(open + 1);
				continue;
			}
		}
		t = t.slice(0, m.index) + `{${m[1] === "true" ? thenBody : elseBody}}` + t.slice(end);
	}
	const bindings = res.bindings.filter((b) => {
		const d = new RegExp(`@group\\(${b.group}\\)\\s*@binding\\(${b.wgslBinding}\\)\\s*var(<[^>]*>)?\\s+(\\w+)`).exec(t);
		if (!d) return true;
		const name = d[2]!;
		const uses = t.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
		return uses > 1;
	});
	return { ...res, wgsl: t, bindings };
}

/**
 * Give the vertex entry point's outputs the fragment inputs' interpolation
 * (a WGSL text pass over the entry's output struct). Integer outputs stay
 * flat, as WGSL requires.
 */
export function relinkVertexOutputs(wgsl: string, inputs: Record<number, string>): string {
	const m = /@vertex\s*fn\s+\w+\s*\([^]*?\)\s*->\s*(\w+)/.exec(wgsl);
	if (!m) return wgsl;
	const start = wgsl.search(new RegExp(`struct\\s+${m[1]}\\s*\\{`));
	if (start < 0) return wgsl;
	const end = wgsl.indexOf("}", start);
	if (end < 0) return wgsl;
	const body = wgsl.slice(start, end).replace(/@location\((\d+)\)(\s*@interpolate\([^)]*\))?(\s*)(\w+\s*:\s*[^,\n]+)/g, (all, l, _interp, sp, decl) => {
		const want = inputs[Number(l)];
		if (!want || /\b[iu]32\b|vec\d<[iu]32>|vec\di\b|vec\du\b/.test(decl)) return all;
		return want === "perspective, center" ? `@location(${l})${sp}${decl}` : `@location(${l}) @interpolate(${want})${sp}${decl}`;
	});
	return wgsl.slice(0, start) + body + wgsl.slice(end);
}

/** Whether a SPIR-V module decorates anything BuiltIn BaseVertex (4424), BaseInstance (4425) or DrawIndex (4426). */
function usesBaseBuiltins(code: Uint8Array): boolean {
	if (code.length < 20 || code.length & 3) return false;
	const w = new Uint32Array(code.buffer, code.byteOffset, code.length >> 2);
	if (w[0] !== 0x07230203) return false;
	for (let i = 5; i < w.length; ) {
		const op = w[i]! & 0xffff;
		const n = w[i]! >>> 16 || 1;
		if (op === 71 && w[i + 2] === 11 && w[i + 3]! >= 4424 && w[i + 3]! <= 4426) return true;
		if (op === 72 && w[i + 3] === 11 && w[i + 4]! >= 4424 && w[i + 4]! <= 4426) return true;
		if (op === 54) break; // OpFunction: past the annotations
		i += n;
	}
	return false;
}

/** SpecId -> "f" | "i" | "u" | "b" from the module's SPIR-V (OpDecorate SpecId, OpSpecConstant*). */
function specTypes(code: Uint8Array): Map<number, string> {
	const out = new Map<number, string>();
	if (code.length < 20 || code.length & 3) return out;
	const w = new Uint32Array(code.buffer.slice(code.byteOffset, code.byteOffset + code.length));
	if (w[0] !== 0x07230203) return out;
	const specId = new Map<number, number>();
	const types = new Map<number, string>();
	for (let i = 5; i < w.length; ) {
		const op = w[i]! & 0xffff;
		const n = w[i]! >>> 16 || 1;
		if (op === 71 && w[i + 2] === 1) specId.set(w[i + 1]!, w[i + 3]!); // OpDecorate id SpecId n
		else if (op === 20) types.set(w[i + 1]!, "b"); // OpTypeBool
		else if (op === 21) types.set(w[i + 1]!, w[i + 3] ? "i" : "u"); // OpTypeInt
		else if (op === 22) types.set(w[i + 1]!, "f"); // OpTypeFloat
		else if (op === 48 || op === 49 || op === 50) {
			const id = specId.get(w[i + 2]!);
			if (id !== undefined) out.set(id, types.get(w[i + 1]!) || "u");
		}
		i += n;
	}
	return out;
}

/** Specialization constants as constantID -> value, typed by the SPIR-V's declarations. */
function specValues(info: any, types: Map<number, string>): Record<number, number | boolean> | undefined {
	if (!info || !info.mapEntries?.length) return undefined;
	const data = Uint8Array.from(info.data || []);
	const dv = new DataView(data.buffer);
	const out: Record<number, number | boolean> = {};
	for (const m of info.mapEntries) {
		const size = m.size || 4;
		if (m.offset + Math.min(size, 4) > data.length) continue;
		const t = types.get(m.constantID) || "u";
		if (size === 1) out[m.constantID] = t === "b" ? dv.getUint8(m.offset) !== 0 : dv.getUint8(m.offset);
		else if (size === 2) out[m.constantID] = dv.getUint16(m.offset, true);
		else if (size === 8) out[m.constantID] = t === "f" ? dv.getFloat64(m.offset, true) : Number(dv.getBigInt64(m.offset, true));
		else if (t === "f") out[m.constantID] = dv.getFloat32(m.offset, true);
		else if (t === "i") out[m.constantID] = dv.getInt32(m.offset, true);
		else if (t === "b") out[m.constantID] = dv.getUint32(m.offset, true) !== 0;
		else out[m.constantID] = dv.getUint32(m.offset, true);
	}
	return out;
}

/** Descriptor set storage key of (binding, array element). */
export function dkey(binding: number, element: number): number {
	return binding + element * 2 ** 21;
}

function entryFromReflection(b: VkShaderBinding, stage: number, dsl: any): any {
	const e: any = { binding: b.wgslBinding, visibility: stage };
	// a texel buffer: its words (a storage buffer) or its parameters (a uniform), bound from the view (bindGroup)
	if (b.texel) e.kwTexel = b.texel;
	const vkd = dsl.bindings.get(b.binding);
	const dyn = vkd && (vkd.type === DT.UNIFORM_DYN || vkd.type === DT.STORAGE_DYN);
	switch (b.kind) {
		case "uniform":
			e.buffer = { type: "uniform", hasDynamicOffset: !!dyn };
			break;
		case "storage":
			e.buffer = { type: "storage", hasDynamicOffset: !!dyn };
			// read-only in the app's shader (promoted for compute): may be copied
			// aside when it aliases a writable binding (vk-exec.ts aliasFix)
			if ((b as any).ro) e.kwRO = true;
			break;
		case "read-only-storage":
			e.buffer = { type: "read-only-storage", hasDynamicOffset: !!dyn };
			break;
		case "sampler":
			e.sampler = { type: "filtering" };
			break;
		case "comparison-sampler":
			e.sampler = { type: "comparison" };
			break;
		case "texture": {
			let sampleType = b.sampleType || "float";
			if (b.multisampled && sampleType === "float") sampleType = "unfilterable-float";
			e.texture = { sampleType, viewDimension: b.viewDimension || "2d", multisampled: !!b.multisampled };
			break;
		}
		case "storage-texture":
			e.storageTexture = { access: b.access || "write-only", format: b.format || "rgba8unorm", viewDimension: b.viewDimension || "2d" };
			break;
	}
	return e;
}

/**
 * A texel buffer descriptor: the view's buffer as the storage binding the
 * shader's words are (offset and range as bound, vk-exec.ts aliasFix sees
 * them as any storage buffer), and the view for its parameters. A view
 * whose format lacks the descriptor type's feature is refused.
 */
function texelDescriptor(c: Conn, viewId: number, type: number): any {
	const v = c.get(viewId, "bufferView");
	const need = type === DT.STORAGE_TEXEL ? TEXEL_STORAGE : TEXEL_UNIFORM;
	if (!(v.caps & need)) throw new Error(`buffer view ${viewId}: format ${v.format} is not a ${type === DT.STORAGE_TEXEL ? "storage" : "uniform"} texel buffer format here`);
	return { view: viewId, buffer: v.buffer, offset: v.bindOffset, range: v.bindSize };
}

function entriesFromVk(binding: number, d: any, visibility: number): any[] {
	const w = 2 * binding;
	switch (d.type) {
		case DT.UNIFORM:
		case DT.UNIFORM_DYN:
			return [{ binding: w, visibility, buffer: { type: "uniform", hasDynamicOffset: d.type === DT.UNIFORM_DYN } }];
		case DT.STORAGE:
		case DT.STORAGE_DYN:
			return [{ binding: w, visibility: visibility & ~SS.VERTEX, buffer: { type: "storage", hasDynamicOffset: d.type === DT.STORAGE_DYN } }];
		case DT.SAMPLER:
			return [{ binding: w, visibility, sampler: { type: "filtering" } }];
		case DT.SAMPLED_IMAGE:
			return [{ binding: w, visibility, texture: { sampleType: "float", viewDimension: "2d" } }];
		case DT.COMBINED:
			return [
				{ binding: w, visibility, texture: { sampleType: "float", viewDimension: "2d" } },
				{ binding: w + 1, visibility, sampler: { type: "filtering" } },
			];
	}
	return [];
}

function makeTexture(c: Conn, msg: any, info: VkFormatInfo): any {
	const ext = msg.extent || { width: 1, height: 1, depth: 1 };
	const samples = msg.samples || 1;
	const dim = msg.imageType === 0 ? "1d" : msg.imageType === 2 ? "3d" : "2d";
	const tex = info.tex!;
	let usage = TU.TEXTURE_BINDING;
	const renderable = (info.caps & 20) !== 0 && dim === "2d";
	if (samples > 1) usage |= TU.RENDER_ATTACHMENT;
	else {
		usage |= TU.COPY_SRC | TU.COPY_DST;
		if (renderable) usage |= TU.RENDER_ATTACHMENT;
		if (msg.usage & 8 && info.caps & 32) usage |= TU.STORAGE_BINDING;
	}
	const desc: any = {
		label: `kwvk image ${msg.id}`,
		size: [ext.width, dim === "1d" ? 1 : ext.height, dim === "3d" ? ext.depth : msg.arrayLayers || 1],
		mipLevelCount: msg.mipLevels || 1,
		sampleCount: samples,
		dimension: dim,
		format: tex,
		usage,
	};
	const twin = srgbTwin(tex);
	if (twin && samples === 1) desc.viewFormats = [twin];
	const texture = c.dev.createTexture(desc);
	c.r.gpuCreated();
	return texture;
}

const SAMPLER_FILTER = ["nearest", "linear"];

type Handler = (c: Conn, msg: any, bin: Uint8Array) => Reply | Deferred | undefined | Promise<Reply | Deferred | undefined>;

const handlers: Record<string, Handler> = {
	hello(c, msg) {
		const dev = c.dev;
		// the ICD reports what this reply says: the size it asked for
		// (KWVK_SUBGROUP_SIZE), else the host's; an older ICD asks nothing
		// and reports 1
		const want = msg.subgroupSize;
		if (want !== undefined) c.subgroupSize = Number.isInteger(want) && want >= 1 && want <= 128 && !(want & (want - 1)) ? want : VK_SUBGROUP_SIZE;
		// a hint only: a draw with the other orientation gets its variant then
		c.engineName = typeof msg.engineName === "string" ? msg.engineName.slice(0, 64) : "";
		c.noFlip = NO_FLIP_ENGINES.has(c.engineName);
		const limits: Record<string, number> = {};
		for (const k in dev.limits) {
			const v = dev.limits[k];
			if (typeof v === "number") limits[k] = v;
		}
		const features = [...dev.features];
		const ai = dev.adapterInfo || c.r.adapter?.info || {};
		// external present: swapchain images become a page compositor's pictures without
		// readback (renderer.external()), where this thread can make them (a WebGPU OffscreenCanvas)
		if (!c.token && c.r.externalOk && typeof (globalThis as any).OffscreenCanvas === "function" && typeof (globalThis as any).crypto?.getRandomValues === "function") {
			c.token = newToken();
			c.r.tokens.set(c.token, c);
		}
		return {
			json: {
				version: 1,
				adapter: { vendor: ai.vendor || "", architecture: ai.architecture || "", device: ai.device || "", description: ai.description || "" },
				limits,
				features,
				formats: formatTable(dev.features),
				// texel buffer view formats and limits (vk/PROTOCOL.md, Amendments, "Texel buffers")
				texelBuffers: texelTable(dev.limits.maxStorageBufferBindingSize),
				subgroupSize: c.subgroupSize,
				...(c.token ? { external: { token: c.token } } : {}),
			},
		};
	},

	/** External present: an export id for each swapchain image (the low 32 bits of its wland external id). */
	exportImages(c, msg) {
		if (!c.token) throw new Error("external present is not offered on this connection (no token)");
		const imgs = (Array.isArray(msg.images) ? msg.images : []).map((id: number) => {
			const img = c.get(id, "image");
			const base = img.format.replace(/-srgb$/, "");
			if (img.samples > 1 || img.is3D || (base !== "bgra8unorm" && base !== "rgba8unorm"))
				throw new Error(`image ${id} (${img.format}) cannot be presented externally`);
			return img;
		});
		const ids = imgs.map((img: any, i: number) => {
			if (!img.exportId) {
				if (c.nextExport > 0xffffffff) throw new Error("export ids exhausted");
				img.exportId = c.nextExport++;
				c.exported.set(img.exportId, { id: msg.images[i], img });
			}
			return img.exportId;
		});
		return { json: { ids } };
	},

	sync(c) {
		return { defer: Promise.all([c.dev.queue.onSubmittedWorkDone(), c.checked]).then(() => undefined) };
	},

	destroy(c, msg) {
		for (const id of msg.ids || []) c.destroyOne(id);
		return undefined;
	},

	vkCreateBuffer(c, msg) {
		if (!(msg.size >= 0)) throw new Error(`bad buffer size ${msg.size}`);
		let size = Math.max(4, alignUp(msg.size, 4));
		// a uniform buffer's GPU buffer ends on a 16-byte boundary, so that a
		// uniform binding of it can grow to the 16-byte multiple WebGPU
		// sizes it by (bindGroup); the Vulkan size (`size` below) stays the
		// bound of writes, reads and copies
		if ((msg.usage || 0) & 0x10 && msg.size > 0) {
			const padded = Math.max(16, alignUp(msg.size, 16));
			if (padded <= c.dev.limits.maxBufferSize) size = padded;
		}
		// STORAGE always: vkCmdCopyBuffer patches unaligned bytes with a compute pass (vk-exec.ts byteCopy)
		let usage = BU.COPY_SRC | BU.COPY_DST | BU.STORAGE;
		const u = msg.usage || 0;
		if (u & 0x10) usage |= BU.UNIFORM;
		if (u & 0x20) usage |= BU.STORAGE;
		if (u & 0x40) usage |= BU.INDEX;
		if (u & 0x80) usage |= BU.VERTEX;
		if (u & 0x100) usage |= BU.INDIRECT;
		// texel buffers (0x4 uniform, 0x8 storage) are bound as storage buffers of words
		if (!(size <= c.dev.limits.maxBufferSize)) throw new Error(`buffer size ${msg.size} over maxBufferSize`);
		const buf = c.dev.createBuffer({ size, usage, label: `kwvk buffer ${msg.id}` });
		c.r.gpuCreated();
		c.put(msg.id, { t: "buffer", buf, size: msg.size });
		return undefined;
	},

	writeBuffer(c, msg, bin) {
		const b = c.get(msg.buffer, "buffer");
		const off = msg.offset || 0;
		if (off % 4 || bin.length & 3) {
			// pad an unaligned tail with zeros only where it lies past the Vulkan size
			if (off % 4) throw new Error(`unaligned offset ${off}`);
			const end = off + bin.length;
			if (end >= b.size) {
				const p = new Uint8Array((bin.length + 3) & ~3);
				p.set(bin);
				bin = p;
			} else throw new Error(`unaligned size ${bin.length}`);
		}
		// the Vulkan size in whole words bounds it, not a uniform buffer's 16-byte padding
		const room = Math.min(alignUp(b.size, 4), b.buf.size);
		if (off + bin.length > room) throw new Error(`write past the end (${off}+${bin.length} > ${room})`);
		c.dev.queue.writeBuffer(b.buf, off, bin);
		c.stats.bytesWritten += bin.length;
		return undefined;
	},

	readBuffer(c, msg) {
		const b = c.get(msg.buffer, "buffer");
		const off = msg.offset || 0;
		if (!(off >= 0 && off <= b.size)) throw new Error(`offset ${off} out of range`);
		const size = Math.min(isWhole(msg.size) ? b.size - off : msg.size, b.size - off);
		const start = alignDown(off, 4);
		const end = Math.min(alignUp(off + size, 4), b.buf.size);
		const len = Math.max(4, end - start);
		const stage = c.dev.createBuffer({ size: len, usage: BU.MAP_READ | BU.COPY_DST });
		const e = c.dev.createCommandEncoder();
		e.copyBufferToBuffer(b.buf, start, stage, 0, end - start);
		c.dev.queue.submit([e.finish()]);
		return {
			// after the validation of earlier submits: a failed one loses the device before stale bytes go out
			defer: Promise.all([stage.mapAsync(MAP_READ), c.checked]).then(() => {
				// framed straight from the mapped range (the only copy), then unmapped
				const out = new Uint8Array(stage.getMappedRange()).subarray(off - start, off - start + size);
				c.stats.bytesRead += out.length;
				return {
					bin: out,
					after: () => {
						stage.unmap();
						stage.destroy();
					},
				};
			}),
		};
	},

	vkCreateImage(c, msg) {
		const info = vkFormat(msg.format);
		if (!info?.tex) throw new Error(`unsupported image format ${msg.format}`);
		if (msg.tiling === 1) c.log("kwvk: vkCreateImage: linear tiling is unsupported (treated as optimal)");
		const tex = makeTexture(c, msg, info);
		c.put(msg.id, {
			t: "image",
			tex,
			info,
			format: info.tex,
			width: msg.extent?.width || 1,
			height: msg.extent?.height || 1,
			depth: msg.imageType === 2 ? msg.extent?.depth || 1 : 1,
			is3D: msg.imageType === 2,
			mipLevels: msg.mipLevels || 1,
			layers: msg.arrayLayers || 1,
			samples: msg.samples || 1,
		});
		return undefined;
	},

	vkCreateImageView(c, msg) {
		const image = c.get(msg.image, "image");
		const info = vkFormat(msg.format);
		let tex = info?.tex || image.format;
		if (tex !== image.format && tex !== srgbTwin(image.format)) {
			c.log(`kwvk: vkCreateImageView: view format ${tex} of a ${image.format} image is unsupported, using the image's`);
			tex = image.format;
		}
		const r = msg.subresourceRange || {};
		// VkComponentSwizzle -> WebGPU's view swizzle ("texture-component-swizzle"): IDENTITY, ZERO, ONE, R, G, B, A
		const sw = msg.components || {};
		const letter = (v: number, own: string) => (!v ? own : ["", "0", "1", "r", "g", "b", "a"][v] || own);
		let swizzle: string | undefined = letter(sw.r, "r") + letter(sw.g, "g") + letter(sw.b, "b") + letter(sw.a, "a");
		if (swizzle === "rgba") swizzle = undefined;
		else if (!c.dev.features.has("texture-component-swizzle")) {
			c.log("kwvk: vkCreateImageView: component swizzles need WebGPU's texture-component-swizzle (identity used)");
			swizzle = undefined;
		}
		c.put(msg.id, {
			t: "imageView",
			image,
			tex,
			swizzle,
			viewType: msg.viewType ?? 1,
			range: { aspectMask: r.aspectMask ?? 1, baseMipLevel: r.baseMipLevel || 0, levelCount: r.levelCount ?? -1, baseArrayLayer: r.baseArrayLayer || 0, layerCount: r.layerCount ?? -1 },
			cache: new Map(),
		});
		return undefined;
	},

	vkCreateSampler(c, msg) {
		const desc: any = {
			magFilter: SAMPLER_FILTER[msg.magFilter] || "nearest",
			minFilter: SAMPLER_FILTER[msg.minFilter] || "nearest",
			mipmapFilter: SAMPLER_FILTER[msg.mipmapMode] || "nearest",
			addressModeU: ADDRESS[msg.addressModeU] || "repeat",
			addressModeV: ADDRESS[msg.addressModeV] || "repeat",
			addressModeW: ADDRESS[msg.addressModeW] || "repeat",
			lodMinClamp: Math.max(0, msg.minLod || 0),
			lodMaxClamp: Math.min(32, Math.max(msg.minLod || 0, msg.maxLod ?? 32)),
		};
		if (msg.compareEnable) desc.compare = COMPARE[msg.compareOp] || "less";
		if (msg.anisotropyEnable && msg.maxAnisotropy > 1 && desc.magFilter === "linear" && desc.minFilter === "linear" && desc.mipmapFilter === "linear") {
			desc.maxAnisotropy = Math.min(16, Math.floor(msg.maxAnisotropy));
		}
		// rendering approximations WebGPU forces (logged once each)
		if ([msg.addressModeU, msg.addressModeV, msg.addressModeW].includes(3)) c.log("kwvk: vkCreateSampler: CLAMP_TO_BORDER is approximated as clamp-to-edge (no border colour)");
		if (msg.unnormalizedCoordinates) c.log("kwvk: vkCreateSampler: unnormalizedCoordinates is unsupported (coordinates are taken as normalized)");
		const filtering = desc.magFilter === "linear" || desc.minFilter === "linear" || desc.mipmapFilter === "linear";
		c.put(msg.id, { t: "sampler", gpu: c.dev.createSampler(desc), filtering });
		return undefined;
	},

	vkCreateShaderModule(c, msg, bin) {
		let code = bin;
		if (!code.length && Array.isArray(msg.code)) code = Uint8Array.from(msg.code);
		code = code.slice();
		c.put(msg.id, { t: "shader", id: msg.id, code, cache: new Map(), baseBuiltins: usesBaseBuiltins(code) });
		return undefined;
	},

	vkCreateDescriptorSetLayout(c, msg) {
		const bindings = new Map<number, any>();
		for (const b of msg.bindings || []) {
			bindings.set(b.binding, { type: b.descriptorType, count: b.descriptorCount ?? 1, stages: b.stageFlags, immutable: b.immutableSamplers });
		}
		const order = [...bindings.keys()].sort((a, b) => a - b);
		// dynamic offsets come in binding order, one per array element
		const dynamic: string[] = [];
		for (const b of order) {
			const d = bindings.get(b);
			if (d.type === DT.UNIFORM_DYN || d.type === DT.STORAGE_DYN) for (let i = 0; i < Math.min(d.count, 1024); i++) dynamic.push(`${b}:${i}`);
		}
		// descriptor arrays get WGSL bindings after 2 * (the highest binding + 1): element i at base + 2i (vk-shader.ts opts.arrays)
		const arrays: Record<number, { base: number; count: number }> = {};
		let next = 2 * ((order[order.length - 1] ?? -1) + 1);
		for (const b of order) {
			const d = bindings.get(b);
			if (d.count > 1) {
				arrays[b] = { base: next, count: d.count };
				next += 2 * d.count;
			}
		}
		if (next > 1000) c.log("kwvk: vkCreateDescriptorSetLayout: descriptor arrays past WebGPU's binding numbers (1000)");
		c.put(msg.id, { t: "setLayout", bindings, dynamic, order, arrays });
		return undefined;
	},

	vkCreatePipelineLayout(c, msg) {
		const setLayouts: number[] = msg.setLayouts || [];
		let pushSize = 0;
		for (const r of msg.pushConstantRanges || []) pushSize = Math.max(pushSize, r.offset + r.size);
		if (pushSize && setLayouts.length > 3) c.log("kwvk: vkCreatePipelineLayout: push constants with more than 3 sets are unsupported");
		c.put(msg.id, { t: "pipelineLayout", setLayouts, pushSize });
		return undefined;
	},

	vkAllocateDescriptorSets(c, msg) {
		for (const s of msg.sets || []) {
			const layout = c.get(s.layout, "setLayout");
			c.put(s.id, { t: "set", layout, desc: new Map(), cache: new Map() });
		}
		return undefined;
	},

	vkUpdateDescriptorSets(c, msg) {
		// past a binding's last element a write or copy goes on at element 0 of the next binding
		// that has descriptors (Vulkan's consecutive binding updates; the ICD numbers them the same)
		const settle = (layout: any, b: number, el: number, what: string): [number, number] => {
			while (el >= (layout.bindings.get(b)?.count ?? 1)) {
				const nb = layout.order.find((x: number) => x > b);
				if (nb === undefined) throw new Error(`descriptor ${what} past the last binding`);
				b = nb;
				el = 0;
			}
			return [b, el];
		};
		for (const w of msg.descriptorWrites || []) {
			const set = c.get(w.dstSet, "set");
			set.cache.clear();
			const infos: any[] = w.imageInfo?.length ? w.imageInfo : w.bufferInfo?.length ? w.bufferInfo : w.texelBufferView || [];
			const n = Math.min(w.descriptorCount ?? infos.length, infos.length);
			let b = w.dstBinding | 0;
			let el = w.dstArrayElement | 0;
			for (let i = 0; i < n; i++) {
				[b, el] = settle(set.layout, b, el, "write");
				const info = infos[i];
				const d: any = { type: w.descriptorType };
				if (w.imageInfo?.length) Object.assign(d, { sampler: info.sampler, imageView: info.imageView });
				else if (w.bufferInfo?.length) Object.assign(d, { buffer: info.buffer, offset: info.offset || 0, range: info.range });
				else if (w.texelBufferView?.length) {
					if (!info) {
						// a null view: as if unwritten (a placeholder if the shader reaches it)
						set.desc.delete(dkey(b, el));
						el++;
						continue;
					}
					Object.assign(d, texelDescriptor(c, info, w.descriptorType));
				}
				const k = dkey(b, el);
				const prev = set.desc.get(k);
				// a sampler-only write keeps a combined binding's view and vice versa
				set.desc.set(k, prev && w.descriptorType === DT.SAMPLER ? { ...prev, sampler: d.sampler } : d);
				el++;
			}
		}
		for (const cp of msg.descriptorCopies || []) {
			const src = c.get(cp.srcSet, "set");
			const dst = c.get(cp.dstSet, "set");
			const n = Math.min(cp.descriptorCount ?? 1, 4096);
			let sb = cp.srcBinding | 0;
			let se = cp.srcArrayElement | 0;
			let db = cp.dstBinding | 0;
			let de = cp.dstArrayElement | 0;
			for (let i = 0; i < n; i++) {
				[sb, se] = settle(src.layout, sb, se, "copy source");
				[db, de] = settle(dst.layout, db, de, "copy");
				const d = src.desc.get(dkey(sb, se));
				if (d) dst.desc.set(dkey(db, de), { ...d });
				se++;
				de++;
			}
			dst.cache.clear();
		}
		return undefined;
	},

	vkCreateRenderPass(c, msg) {
		const atts = (msg.attachments || []).map((a: any) => ({ ...a, tex: vkFormat(a.format)?.tex }));
		const subpasses = (msg.subpasses || []).map((s: any) => ({
			colors: (s.colorAttachments || []).map((r: any) => r.attachment),
			resolves: (s.resolveAttachments || []).map((r: any) => r.attachment),
			depth: s.depthStencilAttachment ? s.depthStencilAttachment.attachment : UNUSED,
			inputs: (s.inputAttachments || []).map((r: any) => r.attachment),
		}));
		const first = new Map<number, number>();
		const last = new Map<number, number>();
		subpasses.forEach((s: any, i: number) => {
			for (const a of [...s.colors, ...s.resolves, s.depth]) {
				if (a === UNUSED || a === undefined) continue;
				if (!first.has(a)) first.set(a, i);
				last.set(a, i);
			}
			if (s.inputs?.some?.((a: number) => a !== UNUSED && (s.colors.includes(a) || s.depth === a))) {
				c.log("kwvk: vkCreateRenderPass: an input attachment that is also written in the same subpass is unsupported");
			}
		});
		for (const s of subpasses) {
			const colors = s.colors.map((a: number) => (a === UNUSED ? null : atts[a]?.tex || null));
			const depth = s.depth === UNUSED ? null : atts[s.depth]?.tex || null;
			let samples = 1;
			for (const a of [...s.colors, s.depth]) if (a !== UNUSED && atts[a]) samples = atts[a].samples || 1;
			s.colorFormats = colors;
			s.depthFormat = depth;
			s.samples = samples;
			s.key = `${colors.join(",")}|${depth}|${samples}`;
		}
		c.put(msg.id, { t: "renderPass", atts, subpasses, first, last });
		return undefined;
	},

	vkCreateFramebuffer(c, msg) {
		c.put(msg.id, { t: "framebuffer", views: msg.attachments || [], width: msg.width, height: msg.height, layers: msg.layers || 1 });
		return undefined;
	},

	vkCreateGraphicsPipelines(c, msg) {
		return c.makePipeline(msg, () => graphicsPipeline(c, msg));
	},

	vkCreateComputePipelines(c, msg) {
		return c.makePipeline(msg, () => {
			const pl = c.get(msg.layout, "pipelineLayout");
			const stages = c.stages({ stages: [msg.stage] }, pl.setLayouts.length, pl.setLayouts);
			const layout = c.pipelineLayout(msg.layout, stages);
			const st = stages[0]!;
			c.stats.pipelines++;
			const gpu = c.dev.createComputePipeline({ label: `kwvk pipeline ${msg.id}`, layout: layout.layout, compute: { module: st.module, entryPoint: st.res.entryPoint } });
			const p: any = { t: "pipeline", kind: "compute", layout, gpu, stage: st, stages, layoutId: msg.layout, variants: new Map() };
			// The read_write promotion (translate()) can make WebGPU refuse a
			// shader it takes as written (ggml's matmul_id: an early return on a
			// read-only buffer's value before barriers). Then the pipeline is
			// made with the read-only buffers kept, in an error scope of its own,
			// and resolves true when that compiled and validated.
			if (st.res.bindings.some((b: any) => b.ro))
				p.readOnlyRetry = async (): Promise<boolean> => {
					p.readOnlyRetry = undefined;
					let ro: any;
					c.dev.pushErrorScope("validation");
					try {
						const stages2 = c.stages({ stages: [msg.stage] }, pl.setLayouts.length, pl.setLayouts, true);
						const layout2 = c.pipelineLayout(msg.layout, stages2);
						c.stats.pipelines++;
						const gpu2 = c.dev.createComputePipeline({ label: `kwvk pipeline ${msg.id} (read-only kept)`, layout: layout2.layout, compute: { module: stages2[0]!.module, entryPoint: stages2[0]!.res.entryPoint } });
						ro = { layout: layout2, gpu: gpu2, stage: stages2[0], stages: stages2, variants: new Map(), storageVariants: undefined };
					} catch {
						ro = undefined;
					}
					const scope = await c.dev.popErrorScope().catch((e: any) => e || true);
					if (!ro || scope || (await ro.stage.check)) return false;
					Object.assign(p, ro);
					return true;
				};
			return p;
		});
	},

	vkCreateQueryPool(c, msg) {
		const count = msg.queryCount | 0;
		if (!(count >= 1 && count <= 4096)) throw new Error(`queryCount ${msg.queryCount} out of range (1..4096)`);
		const type = msg.queryType | 0;
		let set: any;
		if (type === 0) set = c.dev.createQuerySet({ type: "occlusion", count, label: `kwvk queries ${msg.id}` });
		else if (type === 2 && c.dev.features.has("timestamp-query")) set = c.dev.createQuerySet({ type: "timestamp", count, label: `kwvk queries ${msg.id}` });
		else c.log(`kwvk: vkCreateQueryPool: query type ${type} ${type === 2 ? "without timestamp-query" : ""} reads as zeros`);
		if (set) c.r.gpuCreated();
		const results = c.dev.createBuffer({ size: count * 8, usage: BU.COPY_SRC | BU.COPY_DST, label: `kwvk query results ${msg.id}` });
		c.r.gpuCreated();
		// written: the query set holds the query's value (resolved when read); seq: order of the writes
		c.put(msg.id, { t: "queryPool", type, count, set, results, avail: new Uint8Array(count), written: new Uint8Array(count), seq: new Float64Array(count), clock: 0 });
		return undefined;
	},

	vkResetQueryPool(c, msg) {
		const p = c.get(msg.queryPool, "queryPool");
		const first = msg.firstQuery | 0;
		const n = Math.min(msg.queryCount | 0, p.count - first);
		if (first < 0 || n <= 0) return undefined;
		p.avail.fill(0, first, first + n);
		p.written.fill(0, first, first + n);
		const e = c.dev.createCommandEncoder();
		e.clearBuffer(p.results, first * 8, n * 8);
		c.dev.queue.submit([e.finish()]);
		return undefined;
	},

	getQueryPoolResults(c, msg) {
		const p = c.get(msg.queryPool, "queryPool");
		const first = msg.firstQuery | 0;
		const n = Math.min(msg.queryCount | 0, p.count - first);
		if (first < 0 || n <= 0) throw new Error("query range out of range");
		const stage = c.dev.createBuffer({ size: n * 8, usage: BU.MAP_READ | BU.COPY_DST });
		const e = c.dev.createCommandEncoder();
		const scratch: any[] = [];
		resolveQueries(c.dev, e, p, first, n, scratch);
		e.copyBufferToBuffer(p.results, first * 8, stage, 0, n * 8);
		c.dev.queue.submit([e.finish()]);
		const available = [...p.avail.subarray(first, first + n)];
		// the timestamps written, in the order they were written
		const order = p.type === 2 && p.set ? [...Array(n).keys()].filter((i) => p.written[first + i]).sort((a, b) => p.seq[first + a] - p.seq[first + b]) : [];
		return {
			defer: Promise.all([stage.mapAsync(MAP_READ), c.checked]).then(() => {
				const out = new Uint8Array(stage.getMappedRange().slice(0));
				stage.unmap();
				stage.destroy();
				for (const b of scratch) b.destroy();
				if (p.type === 0) {
					// occlusion: WebGPU's values are only zero / non-zero
					const v = new BigUint64Array(out.buffer);
					for (let i = 0; i < v.length; i++) v[i] = v[i] ? 1n : 0n;
				}
				if (order.length > 1) {
					// WebGPU allows timestamps that go backwards (a counter reset, a sample the
					// backend did not write reads 0): a timestamp never reads earlier than the
					// one written before it, so differences stay >= 0
					const v = new BigUint64Array(out.buffer);
					let max = v[order[0]!]!, raised = 0;
					for (const i of order) {
						if (v[i]! < max) {
							v[i] = max;
							raised++;
						} else max = v[i]!;
					}
					if (raised && !c.tsRaised) {
						c.tsRaised = true;
						c.log(`kwvk: getQueryPoolResults: ${raised} of ${order.length} timestamps read earlier than the one written before them (raised to it; logged once)`);
					}
				}
				c.stats.bytesRead += out.length;
				return { json: { available }, bin: out };
			}),
		};
	},

	/**
	 * A texel buffer view: bound as a storage buffer from its offset rounded
	 * down to minStorageBufferOffsetAlignment, with a 16-byte uniform of
	 * parameters the translated shader decodes by (vk/naga/src/texel.rs):
	 * [VkFormat, first byte in the binding, element count, texel size].
	 */
	vkCreateBufferView(c, msg) {
		const b = c.get(msg.buffer, "buffer");
		const tf = texelFormat(msg.format);
		if (!tf) throw new Error(`format ${msg.format} is not a texel buffer format`);
		const offset = msg.offset || 0;
		if (!(offset >= 0 && offset < b.size)) throw new Error(`offset ${offset} past the buffer's ${b.size} bytes`);
		const bytes = isWhole(msg.range) ? b.size - offset : Math.min(msg.range, b.size - offset);
		const count = Math.floor(bytes / tf.size);
		const al = c.dev.limits?.minStorageBufferOffsetAlignment || 256;
		const bindOffset = alignDown(offset, al);
		const bindSize = Math.max(4, Math.min(alignUp(offset + count * tf.size, 4), b.buf.size) - bindOffset);
		const max = c.dev.limits?.maxStorageBufferBindingSize;
		if (max && bindSize > max) throw new Error(`${count} elements (${bindSize} bytes bound) over maxStorageBufferBindingSize (${max})`);
		const params = c.dev.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST, label: `kwvk buffer view ${msg.id}` });
		c.r.gpuCreated();
		c.dev.queue.writeBuffer(params, 0, new Uint32Array([msg.format, offset - bindOffset, count, tf.size]));
		c.put(msg.id, { t: "bufferView", buffer: msg.buffer, format: msg.format, caps: tf.caps, bindOffset, bindSize, params });
		return undefined;
	},

	vkQueueSubmit(c, msg) {
		c.stats.submits++;
		// a command the host cannot encode throws VkDeviceLost (nothing of the
		// submit runs); a WebGPU validation error drops the whole submit: both
		// lose the device rather than leave the guest with missing results
		c.dev.pushErrorScope("validation");
		let done: Promise<void>;
		try {
			done = runSubmit(c, msg.cmds || []);
		} finally {
			const scope = c.dev.popErrorScope();
			c.checked = scope.then(
				(err: any) => {
					if (!err) return;
					c.stats.errors++;
					c.log(`kwvk: vkQueueSubmit: ${err.message}`);
					c.deviceLost(`vkQueueSubmit: WebGPU refused the submit (none of it ran): ${firstLine(err.message)}`);
				},
				() => {},
			);
		}
		const check = c.checked;
		return { defer: Promise.all([done, check]).then(() => undefined) };
	},

	present(c, msg) {
		const img = c.get(msg.image, "image");
		const w = img.width;
		const h = img.height;
		c.stats.presents++;
		const info: VkPresentInfo = { connection: c, image: msg.image, texture: img.tex, width: w, height: h, format: img.format };
		c.lastPresented = info;
		try {
			c.r.onPresent?.(info);
		} catch (e) {
			c.log(`kwvk: onPresent: ${(e as Error).message}`);
		}
		if (msg.external) {
			// external present: no pixels; the reply (which the ICD's wl_surface.commit waits for)
			// goes once the validation of every earlier submit is known, so a failed frame loses
			// the device instead of reaching the compositor; the image's id resolves from then on
			if (!img.exportId) throw new Error(`image ${msg.image} was not exported (exportImages)`);
			c.stats.externalPresents++;
			return {
				defer: c.checked.then(() => {
					img.presented = true;
					return { json: { width: w, height: h } };
				}),
			};
		}
		if (msg.readback === 0) return { json: { width: w, height: h, stride: w * img.info.bpb } };
		const json = { width: w, height: h, stride: w * img.info.bpb };
		return {
			defer: Promise.all([readTexture(c, img, 0, 0, w, h), c.checked]).then(([bin]) => {
				c.stats.bytesRead += bin.length;
				return { json, bin };
			}),
		};
	},
};

/** vkCreateGraphicsPipelines: the stages translated, the layout, and the variant of the render pass it names (so its errors show at creation). */
function graphicsPipeline(c: Conn, msg: any): any {
	const pl = c.get(msg.layout, "pipelineLayout");
	const stages = c.stages(msg, pl.setLayouts.length, pl.setLayouts);
	const layout = c.pipelineLayout(msg.layout, stages);
	const vi = msg.vertexInputState || {};
	const bindings = (vi.vertexBindingDescriptions || []).slice().sort((a: any, b: any) => a.binding - b.binding);
	const buffers = bindings.map((b: any) => ({
		binding: b.binding,
		desc: {
			arrayStride: b.stride,
			stepMode: b.inputRate === 1 ? "instance" : "vertex",
			attributes: (vi.vertexAttributeDescriptions || [])
				.filter((a: any) => a.binding === b.binding)
				.map((a: any) => {
					const f = vkFormat(a.format)?.vtx;
					if (!f) throw new Error(`unsupported vertex format ${a.format}`);
					return { format: f, offset: a.offset, shaderLocation: a.location };
				}),
		},
	}));
	const topo = msg.inputAssemblyState?.topology ?? 3;
	// adjacency and patch lists: drawing them as lists would make wrong primitives
	if (!(topo >= 0 && topo <= 5)) throw new VkResultError(`primitive topology ${topo} (adjacency or patch list) is unsupported`, VK_ERROR_FEATURE_NOT_PRESENT);
	const rs = msg.rasterizationState || {};
	// fillModeNonSolid is false: drawn filled (visible, not silent), logged
	if (rs.polygonMode) c.log("kwvk: vkCreateGraphicsPipelines: polygon modes other than FILL are unsupported (drawn filled)");
	const p = {
		t: "pipeline",
		kind: "graphics",
		msg,
		layout,
		stages,
		buffers,
		topology: topo,
		dynamic: new Set<number>(msg.dynamicState?.dynamicStates || []),
		variants: new Map<string, any>(),
		// BaseVertex / BaseInstance / DrawIndex: WGSL has none, the translator reads 0
		usesBase: stages.some((st: any) => st.mod.baseBuiltins),
	};
	// build the variant of the render pass it was created for, so errors show here
	const rp = msg.renderPass ? c.objs.get(msg.renderPass) : undefined;
	let sp = rp?.subpasses?.[msg.subpass || 0];
	if (!msg.renderPass && msg.rendering) {
		// dynamic rendering: the formats come with the pipeline (same key as vkCmdBeginRendering's)
		const r = msg.rendering;
		const colorFormats = (r.colorAttachmentFormats || []).map((f: number) => (f ? vkFormat(f)?.tex || null : null));
		const df = r.depthAttachmentFormat || r.stencilAttachmentFormat;
		const depthFormat = df ? vkFormat(df)?.tex || null : null;
		const samples = msg.multisampleState?.rasterizationSamples || 1;
		sp = { colorFormats, depthFormat, samples, key: `${colorFormats.join(",")}|${depthFormat}|${samples}` };
	}
	// in the orientation its vertex stage was translated for (Conn.noFlip), which the app is expected to draw with
	if (sp) pipelineVariant(c, p, sp, c.noFlip ? { noFlip: true } : {}, undefined);
	return p;
}

/** Read level `mip`, layer `layer` of an image as tightly packed rows. */
export async function readTexture(c: Conn, img: any, mip: number, layer: number, w: number, h: number): Promise<Uint8Array> {
	const bpb = img.info.bpb;
	const tight = w * bpb;
	const stride = (tight + 255) & ~255;
	const stage = c.dev.createBuffer({ size: stride * h, usage: BU.MAP_READ | BU.COPY_DST });
	const e = c.dev.createCommandEncoder();
	e.copyTextureToBuffer({ texture: img.tex, mipLevel: mip, origin: [0, 0, layer] }, { buffer: stage, bytesPerRow: stride, rowsPerImage: h }, [w, h, 1]);
	c.dev.queue.submit([e.finish()]);
	await stage.mapAsync(MAP_READ);
	const src = new Uint8Array(stage.getMappedRange());
	const out = new Uint8Array(tight * h);
	for (let y = 0; y < h; y++) out.set(src.subarray(y * stride, y * stride + tight), y * tight);
	stage.unmap();
	stage.destroy();
	return out;
}

// --- render pipeline variants ---------------------------------------------

// fans (5) draw as lists through a generated index buffer (vk-exec.ts)
const TOPOLOGY = ["point-list", "line-list", "line-strip", "triangle-list", "triangle-strip", "triangle-list"];
const BLEND_FACTOR = [
	"zero", "one", "src", "one-minus-src", "dst", "one-minus-dst", "src-alpha", "one-minus-src-alpha", "dst-alpha",
	"one-minus-dst-alpha", "constant", "one-minus-constant", "constant", "one-minus-constant", "src-alpha-saturated",
	"src1", "one-minus-src1", "src1-alpha", "one-minus-src1-alpha",
];
const BLEND_OP = ["add", "subtract", "reverse-subtract", "min", "max"];
const STENCIL_OP = ["keep", "zero", "replace", "increment-clamp", "decrement-clamp", "invert", "increment-wrap", "decrement-wrap"];

export interface VariantDyn {
	bias?: [number, number, number];
	readMask?: number;
	writeMask?: number;
	/** a negative viewport height is current: the vertex stage is translated without the y flip */
	noFlip?: boolean;
	/** extended dynamic state (VK_EXT_extended_dynamic_state(2), Vulkan 1.3) as set by the vkCmdSet* commands */
	ext?: Record<string, any>;
}

// VkDynamicState -> the ext key its setter fills
const EXT_DYN: Record<number, string> = {
	1000267000: "cullMode", 1000267001: "frontFace", 1000267002: "topology", 1000267005: "strides",
	1000267006: "depthTestEnable", 1000267007: "depthWriteEnable", 1000267008: "depthCompareOp",
	1000267010: "stencilTestEnable", 1000267011: "stencilOp", 1000377002: "depthBiasEnable",
};

/** The extended dynamic state a pipeline takes from the command buffer (only what it declares dynamic). */
export function effectiveExt(p: any, ext: Record<string, any> | undefined): Record<string, any> {
	const eff: Record<string, any> = {};
	if (!ext || !p.dynamic) return eff;
	for (const d of p.dynamic) {
		const k = EXT_DYN[d];
		if (k && ext[k] !== undefined) eff[k] = ext[k];
	}
	return eff;
}

/** The GPURenderPipeline of a pipeline for a subpass's formats (and baked dynamic state). */
export function pipelineVariant(c: Conn, p: any, sp: any, dyn: VariantDyn, stripFormat: string | undefined, refined?: any): any {
	const eff = effectiveExt(p, dyn.ext);
	const topoN = eff.topology ?? p.topology;
	const topo = TOPOLOGY[topoN];
	if (!topo) throw new Error(`primitive topology ${topoN} (adjacency or patch list) is unsupported`);
	const strip = topo.endsWith("strip") ? stripFormat : undefined;
	const useBias = p.dynamic.has(3) ? dyn.bias : undefined;
	const rm = p.dynamic.has(6) ? dyn.readMask : undefined;
	const wm = p.dynamic.has(7) ? dyn.writeMask : undefined;
	const key = `${sp.key}|${strip}|${useBias}|${rm}|${wm}|${refined?.refineKey || ""}|${dyn.noFlip ? 1 : 0}|${JSON.stringify(eff)}`;
	let v = p.variants.get(key);
	if (v) return v;
	c.stats.pipelines++;
	const m = p.msg;
	let vs = p.stages.find((s: any) => s.kind === "vertex");
	const fs = p.stages.find((s: any) => s.kind === "fragment");
	if (!vs) throw new Error("graphics pipeline without a vertex stage");
	// the stage was translated for one orientation (Conn.noFlip): the other is translated again here
	if (!dyn.noFlip !== !!vs.opts.flipY) {
		// what tells whether an engine belongs in NO_FLIP_ENGINES (or does not)
		if (!c.flipMissLogged) {
			c.flipMissLogged = true;
			c.log(`kwvk: engine ${JSON.stringify(c.engineName)} draws with a ${dyn.noFlip ? "negative" : "positive"} viewport height, its pipelines were made for a ${dyn.noFlip ? "positive" : "negative"} one: a variant per pipeline at its first such draw (logged once)`);
		}
		vs = { ...vs, ...c.translate(vs.mod, { ...vs.opts, flipY: !dyn.noFlip }) };
	}
	const rs0 = m.rasterizationState || {};
	const rs = { ...rs0 };
	if (eff.cullMode !== undefined) rs.cullMode = eff.cullMode;
	if (eff.frontFace !== undefined) rs.frontFace = eff.frontFace;
	if (eff.depthBiasEnable !== undefined) rs.depthBiasEnable = eff.depthBiasEnable;
	const d0 = m.depthStencilState || {};
	const dss = { ...d0 };
	for (const k of ["depthTestEnable", "depthWriteEnable", "depthCompareOp", "stencilTestEnable"]) if (eff[k] !== undefined) dss[k] = eff[k];
	if (eff.stencilOp) {
		if (eff.stencilOp.front) dss.front = { ...(d0.front || {}), ...eff.stencilOp.front };
		if (eff.stencilOp.back) dss.back = { ...(d0.back || {}), ...eff.stencilOp.back };
	}
	const buffers = p.buffers.map((b: any) => (eff.strides?.[b.binding] !== undefined ? { ...b.desc, arrayStride: eff.strides[b.binding] } : b.desc));
	const tri = topo.startsWith("triangle");
	// cullMode FRONT_AND_BACK culls every triangle (WebGPU has no such mode): no attachment writes
	const cullAll = tri && rs.cullMode === 3;
	const desc: any = {
		label: `kwvk pipeline ${m.id}`,
		layout: (refined || p.layout).layout,
		vertex: { module: vs.module, entryPoint: vs.res.entryPoint, buffers },
		primitive: {
			topology: topo,
			frontFace: (rs.frontFace || 0) === 0 ? "ccw" : "cw",
			cullMode: rs.cullMode === 1 ? "front" : rs.cullMode === 2 ? "back" : "none",
		},
		multisample: { count: sp.samples },
	};
	if (strip) desc.primitive.stripIndexFormat = strip;
	if (rs.depthClampEnable && c.dev.features.has("depth-clip-control")) desc.primitive.unclippedDepth = true;
	const ms = m.multisampleState;
	if (ms) {
		if (ms.sampleMask?.length) desc.multisample.mask = ms.sampleMask[0];
		if (ms.alphaToCoverageEnable) desc.multisample.alphaToCoverageEnabled = true;
	}
	if (fs && !rs.rasterizerDiscardEnable) {
		const cb = m.colorBlendState || {};
		desc.fragment = {
			module: fs.module,
			entryPoint: fs.res.entryPoint,
			targets: sp.colorFormats.map((f: string | null, i: number) => {
				if (!f) return null;
				const a = cb.attachments?.[i] || cb.attachments?.[0] || { colorWriteMask: 15 };
				const t: any = { format: f, writeMask: cullAll ? 0 : (a.colorWriteMask ?? 15) };
				const fi = texFormatInfo(f);
				if (a.blendEnable && fi && fi.caps & 8) {
					const comp = (src: number, dst: number, op: number) => {
						const operation = BLEND_OP[op] || "add";
						if (operation === "min" || operation === "max") return { operation, srcFactor: "one", dstFactor: "one" };
						return { operation, srcFactor: BLEND_FACTOR[src] || "one", dstFactor: BLEND_FACTOR[dst] || "zero" };
					};
					t.blend = {
						color: comp(a.srcColorBlendFactor, a.dstColorBlendFactor, a.colorBlendOp),
						alpha: comp(a.srcAlphaBlendFactor, a.dstAlphaBlendFactor, a.alphaBlendOp),
					};
				}
				return t;
			}),
		};
		if (cb.logicOpEnable) c.log("kwvk: vkCreateGraphicsPipelines: logic ops are unsupported");
	} else if (rs.rasterizerDiscardEnable) {
		c.log("kwvk: vkCreateGraphicsPipelines: rasterizer discard is unsupported (fragments dropped)");
	}
	if (sp.depthFormat) {
		const df = sp.depthFormat as string;
		const d = dss;
		const depth = hasDepth(df);
		const stencil = hasStencil(df);
		const face = (s: any) =>
			d.stencilTestEnable && s
				? { compare: COMPARE[s.compareOp] || "always", failOp: STENCIL_OP[s.failOp] || "keep", depthFailOp: STENCIL_OP[s.depthFailOp] || "keep", passOp: STENCIL_OP[s.passOp] || "keep" }
				: { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" };
		const ds: any = {
			format: df,
			depthWriteEnabled: depth && !cullAll && !!d.depthTestEnable && !!d.depthWriteEnable,
			depthCompare: depth && d.depthTestEnable ? COMPARE[d.depthCompareOp] || "less" : "always",
		};
		if (stencil) {
			ds.stencilFront = face(d.front);
			ds.stencilBack = face(d.back);
			ds.stencilReadMask = rm ?? d.front?.compareMask ?? 0xff;
			ds.stencilWriteMask = d.stencilTestEnable && !cullAll ? (wm ?? d.front?.writeMask ?? 0xff) : 0;
		}
		if (tri && depth) {
			const b = useBias || (rs.depthBiasEnable ? [rs.depthBiasConstantFactor || 0, rs.depthBiasClamp || 0, rs.depthBiasSlopeFactor || 0] : undefined);
			if (b && rs.depthBiasEnable) {
				ds.depthBias = Math.round(b[0]);
				ds.depthBiasClamp = b[1];
				ds.depthBiasSlopeScale = b[2];
			}
		}
		desc.depthStencil = ds;
	}
	v = c.dev.createRenderPipeline(desc);
	p.variants.set(key, v);
	return v;
}


function formatFilterable(tex: string, features: { has(name: string): boolean }): boolean {
	const info = texFormatInfo(tex);
	return !!info && (formatCaps(info, features) & CAP_FILTER) !== 0;
}

/** The GPUComputePipeline of a compute pipeline for a refined layout (or its own). */
export function computeVariant(c: Conn, p: any, refined?: any): any {
	if (!refined) return p.gpu;
	let v = p.variants.get(refined.refineKey);
	if (!v) {
		v = c.dev.createComputePipeline({ label: `kwvk pipeline (refined)`, layout: refined.layout, compute: { module: p.stage.module, entryPoint: p.stage.res.entryPoint } });
		p.variants.set(refined.refineKey, v);
	}
	return v;
}

// Vulkan 1.2's render pass 2: the same members as far as the host reads them
handlers.vkCreateRenderPass2 = handlers.vkCreateRenderPass!;
