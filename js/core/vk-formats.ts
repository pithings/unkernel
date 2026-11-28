// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk: the VkFormat -> WebGPU table (texture and vertex formats) and the
// capability bits the hello reply carries (vk/PROTOCOL.md, Hello). The
// ICD has no format table of its own: what is listed here is what the
// guest sees.

export const CAP_SAMPLED = 1;
export const CAP_FILTER = 2;
export const CAP_COLOR = 4;
export const CAP_BLEND = 8;
export const CAP_DEPTH = 16;
export const CAP_STORAGE = 32;
export const CAP_VERTEX = 64;

export interface VkFormatInfo {
	vk: number;
	/** GPUTextureFormat, if the format can be an image */
	tex?: string;
	/** GPUVertexFormat, if the format can be a vertex attribute */
	vtx?: string;
	/** bytes per texel block */
	bpb: number;
	/** block width and height (1 for uncompressed) */
	bw: number;
	bh: number;
	/** "float" | "uint" | "sint" | "depth" | "stencil" | "depth-stencil" */
	kind: string;
	/** texture caps before feature checks (CAP_*) */
	caps: number;
	/** GPUFeatureName the texture format needs */
	feature?: string;
}

const table = new Map<number, VkFormatInfo>();
const byTex = new Map<string, VkFormatInfo>();

// sampled+filter, +colour+blend, +storage shorthands
const SF = CAP_SAMPLED | CAP_FILTER;
const SFRB = SF | CAP_COLOR | CAP_BLEND;
const SR = CAP_SAMPLED | CAP_COLOR;

function def(vk: number, tex: string | undefined, vtx: string | undefined, bpb: number, caps: number, kind = "float", feature?: string, bw = 1, bh = 1): void {
	const info: VkFormatInfo = { vk, bpb, bw, bh, kind, caps };
	if (tex) info.tex = tex;
	if (vtx) info.vtx = vtx;
	if (feature) info.feature = feature;
	table.set(vk, info);
	if (tex && !byTex.has(tex)) byTex.set(tex, info);
}

// 8-bit
def(9, "r8unorm", "unorm8", 1, SFRB);
def(10, "r8snorm", "snorm8", 1, SF);
def(13, "r8uint", "uint8", 1, SR, "uint");
def(14, "r8sint", "sint8", 1, SR, "sint");
def(16, "rg8unorm", "unorm8x2", 2, SFRB);
def(17, "rg8snorm", "snorm8x2", 2, SF);
def(20, "rg8uint", "uint8x2", 2, SR, "uint");
def(21, "rg8sint", "sint8x2", 2, SR, "sint");
def(37, "rgba8unorm", "unorm8x4", 4, SFRB | CAP_STORAGE);
def(38, "rgba8snorm", "snorm8x4", 4, SF | CAP_STORAGE);
def(41, "rgba8uint", "uint8x4", 4, SR | CAP_STORAGE, "uint");
def(42, "rgba8sint", "sint8x4", 4, SR | CAP_STORAGE, "sint");
def(43, "rgba8unorm-srgb", undefined, 4, SFRB);
def(44, "bgra8unorm", "unorm8x4-bgra", 4, SFRB);
def(50, "bgra8unorm-srgb", undefined, 4, SFRB);
// A8B8G8R8_*_PACK32 is R8G8B8A8 in memory on little endian
def(51, "rgba8unorm", "unorm8x4", 4, SFRB | CAP_STORAGE);
def(52, "rgba8snorm", "snorm8x4", 4, SF | CAP_STORAGE);
def(55, "rgba8uint", "uint8x4", 4, SR | CAP_STORAGE, "uint");
def(56, "rgba8sint", "sint8x4", 4, SR | CAP_STORAGE, "sint");
def(57, "rgba8unorm-srgb", undefined, 4, SFRB);
// 10-bit packed
def(64, "rgb10a2unorm", "unorm10-10-10-2", 4, SFRB);
def(68, "rgb10a2uint", undefined, 4, SR, "uint");
// 16-bit
def(70, undefined, "unorm16", 2, 0);
def(71, undefined, "snorm16", 2, 0);
def(74, "r16uint", "uint16", 2, SR, "uint");
def(75, "r16sint", "sint16", 2, SR, "sint");
def(76, "r16float", "float16", 2, SFRB);
def(77, undefined, "unorm16x2", 4, 0);
def(78, undefined, "snorm16x2", 4, 0);
def(81, "rg16uint", "uint16x2", 4, SR, "uint");
def(82, "rg16sint", "sint16x2", 4, SR, "sint");
def(83, "rg16float", "float16x2", 4, SFRB);
def(91, undefined, "unorm16x4", 8, 0);
def(92, undefined, "snorm16x4", 8, 0);
def(95, "rgba16uint", "uint16x4", 8, SR | CAP_STORAGE, "uint");
def(96, "rgba16sint", "sint16x4", 8, SR | CAP_STORAGE, "sint");
def(97, "rgba16float", "float16x4", 8, SFRB | CAP_STORAGE);
// 32-bit
def(98, "r32uint", "uint32", 4, SR | CAP_STORAGE, "uint");
def(99, "r32sint", "sint32", 4, SR | CAP_STORAGE, "sint");
def(100, "r32float", "float32", 4, SR | CAP_STORAGE);
def(101, "rg32uint", "uint32x2", 8, SR | CAP_STORAGE, "uint");
def(102, "rg32sint", "sint32x2", 8, SR | CAP_STORAGE, "sint");
def(103, "rg32float", "float32x2", 8, SR | CAP_STORAGE);
def(104, undefined, "uint32x3", 12, 0, "uint");
def(105, undefined, "sint32x3", 12, 0, "sint");
def(106, undefined, "float32x3", 12, 0);
def(107, "rgba32uint", "uint32x4", 16, SR | CAP_STORAGE, "uint");
def(108, "rgba32sint", "sint32x4", 16, SR | CAP_STORAGE, "sint");
def(109, "rgba32float", "float32x4", 16, SR | CAP_STORAGE);
// packed floats
def(122, "rg11b10ufloat", undefined, 4, SF);
def(123, "rgb9e5ufloat", undefined, 4, SF);
// depth / stencil (depth formats sample as "depth": no linear filter caps)
def(124, "depth16unorm", undefined, 2, CAP_SAMPLED | CAP_DEPTH, "depth");
def(125, "depth24plus", undefined, 4, CAP_SAMPLED | CAP_DEPTH, "depth");
def(126, "depth32float", undefined, 4, CAP_SAMPLED | CAP_DEPTH, "depth");
def(127, "stencil8", undefined, 1, CAP_SAMPLED | CAP_DEPTH, "stencil");
def(128, "depth24plus-stencil8", undefined, 4, CAP_SAMPLED | CAP_DEPTH, "depth-stencil");
def(129, "depth24plus-stencil8", undefined, 4, CAP_SAMPLED | CAP_DEPTH, "depth-stencil");
def(130, "depth32float-stencil8", undefined, 5, CAP_SAMPLED | CAP_DEPTH, "depth-stencil", "depth32float-stencil8");
// BC
const bc: [number, string, number][] = [
	[131, "bc1-rgba-unorm", 8], [132, "bc1-rgba-unorm-srgb", 8], [133, "bc1-rgba-unorm", 8], [134, "bc1-rgba-unorm-srgb", 8],
	[135, "bc2-rgba-unorm", 16], [136, "bc2-rgba-unorm-srgb", 16], [137, "bc3-rgba-unorm", 16], [138, "bc3-rgba-unorm-srgb", 16],
	[139, "bc4-r-unorm", 8], [140, "bc4-r-snorm", 8], [141, "bc5-rg-unorm", 16], [142, "bc5-rg-snorm", 16],
	[143, "bc6h-rgb-ufloat", 16], [144, "bc6h-rgb-float", 16], [145, "bc7-rgba-unorm", 16], [146, "bc7-rgba-unorm-srgb", 16],
];
for (const [vk, tex, bpb] of bc) def(vk, tex, undefined, bpb, SF, "float", "texture-compression-bc", 4, 4);
// ETC2 / EAC
const etc: [number, string, number][] = [
	[147, "etc2-rgb8unorm", 8], [148, "etc2-rgb8unorm-srgb", 8], [149, "etc2-rgb8a1unorm", 8], [150, "etc2-rgb8a1unorm-srgb", 8],
	[151, "etc2-rgba8unorm", 16], [152, "etc2-rgba8unorm-srgb", 16], [153, "eac-r11unorm", 8], [154, "eac-r11snorm", 8],
	[155, "eac-rg11unorm", 16], [156, "eac-rg11snorm", 16],
];
for (const [vk, tex, bpb] of etc) def(vk, tex, undefined, bpb, SF, "float", "texture-compression-etc2", 4, 4);
// ASTC LDR
const astc: [number, number][] = [[4, 4], [5, 4], [5, 5], [6, 5], [6, 6], [8, 5], [8, 6], [8, 8], [10, 5], [10, 6], [10, 8], [10, 10], [12, 10], [12, 12]];
astc.forEach(([w, h], i) => {
	def(157 + 2 * i, `astc-${w}x${h}-unorm`, undefined, 16, SF, "float", "texture-compression-astc", w, h);
	def(158 + 2 * i, `astc-${w}x${h}-unorm-srgb`, undefined, 16, SF, "float", "texture-compression-astc", w, h);
});

export function vkFormat(vk: number): VkFormatInfo | undefined {
	return table.get(vk);
}

export function texFormatInfo(tex: string): VkFormatInfo | undefined {
	return byTex.get(tex);
}

/** The texture caps of a format on a device with these features. */
export function formatCaps(info: VkFormatInfo, features: { has(name: string): boolean }): number {
	let caps = 0;
	if (info.tex && (!info.feature || features.has(info.feature))) {
		caps = info.caps;
		const t = info.tex;
		if (features.has("float32-filterable") && /^r(g|gba)?32float$/.test(t)) caps |= CAP_FILTER;
		if (features.has("float32-blendable") && /^r(g|gba)?32float$/.test(t)) caps |= CAP_BLEND;
		if (features.has("rg11b10ufloat-renderable") && t === "rg11b10ufloat") caps |= CAP_COLOR | CAP_BLEND;
		if (features.has("bgra8unorm-storage") && t === "bgra8unorm") caps |= CAP_STORAGE;
	}
	if (info.vtx) caps |= CAP_VERTEX;
	return caps;
}

/** The hello reply's "formats" object. */
export function formatTable(features: { has(name: string): boolean }): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [vk, info] of table) {
		const caps = formatCaps(info, features);
		if (caps) out[vk] = caps;
	}
	return out;
}

// Texel buffer view formats (vk/PROTOCOL.md, Amendments, "Texel buffers"):
// the translator decodes and encodes them by VkFormat number
// (vk/naga/src/texel.rs, the same list); B10G11R11 is not stored, atomics
// are on R32.
export const TEXEL_UNIFORM = 1;
export const TEXEL_STORAGE = 2;
export const TEXEL_ATOMIC = 4;
const texel = new Map<number, number>();
texel.set(122, TEXEL_UNIFORM);
for (const vk of [9, 10, 13, 14, 16, 17, 20, 21, 37, 38, 41, 42, 44, 51, 52, 55, 56, 64, 68, 70, 71, 74, 75, 76, 77, 78, 81, 82, 83, 91, 92, 95, 96, 97, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109])
	texel.set(vk, TEXEL_UNIFORM | TEXEL_STORAGE);
texel.set(98, TEXEL_UNIFORM | TEXEL_STORAGE | TEXEL_ATOMIC);
texel.set(99, TEXEL_UNIFORM | TEXEL_STORAGE | TEXEL_ATOMIC);

/** A texel buffer format's caps (TEXEL_*) and texel size in bytes, or undefined. */
export function texelFormat(vk: number): { caps: number; size: number } | undefined {
	const caps = texel.get(vk);
	return caps ? { caps, size: table.get(vk)!.bpb } : undefined;
}

/** The hello reply's "texelBuffers" object: formats and the most elements a view may have. */
export function texelTable(maxStorageBufferBindingSize: number): { formats: Record<string, number>; maxElements: number } {
	const formats: Record<string, number> = {};
	for (const [vk, caps] of texel) formats[vk] = caps;
	// any format's view (16-byte texels at most) plus the alignment slack of its binding fits a storage binding
	const maxElements = Math.max(65536, Math.floor((Math.min(maxStorageBufferBindingSize, 2 ** 32) - 256) / 16));
	return { formats, maxElements };
}

export function hasDepth(tex: string): boolean {
	return tex.startsWith("depth");
}

export function hasStencil(tex: string): boolean {
	return tex.includes("stencil");
}

/** The srgb/linear twin a texture may be viewed as (Vulkan's MUTABLE_FORMAT, approximated). */
export function srgbTwin(tex: string): string | undefined {
	if (tex.endsWith("-srgb")) return tex.slice(0, -5);
	if (tex === "rgba8unorm" || tex === "bgra8unorm" || /^(bc[1237]|etc2|astc)/.test(tex)) return tex + "-srgb";
	return undefined;
}
