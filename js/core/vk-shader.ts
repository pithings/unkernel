// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// SPIR-V -> WGSL for the Vulkan host renderer (vk-host.ts): a wrapper
// around kwvk-naga.wasm (vk/naga/, naga plus the binding rules of
// vk/PROTOCOL.md "Shaders and coordinates"). Runs in browsers and Node.

import { gunzipBytes } from "./load.ts";

export interface VkShaderOpts {
	stage: "vertex" | "fragment" | "compute";
	entryPoint: string;
	flipY?: boolean;
	pushGroup?: number;
	spec?: Record<number, number | boolean>;
	/** Descriptor arrays, "set.binding" -> element i at wgslBinding base + 2*i (its sampler half + 1). */
	arrays?: Record<string, { base: number; count: number }>;
	/** Fragment: the vertex stage's `varyings`, to match interpolation per location. */
	link?: VkShaderVarying[];
	/** Storage images declared without a format, "set.binding" -> WebGPU format (default rgba8unorm / rgba32sint / rgba32uint). */
	storageFormats?: Record<string, string>;
	/** The device's WebGPU features: "shader-f16" keeps float16_t as f16 (else f32, with 16-bit buffers read as u32 words). */
	features?: string[];
	/** Compute: the device's workgroup limits; a larger workgroup that only uses global_invocation_id is shrunk (result.dispatchScale). */
	limits?: { maxComputeWorkgroupSizeX: number; maxComputeWorkgroupSizeY: number; maxComputeWorkgroupSizeZ: number; maxComputeInvocationsPerWorkgroup: number };
	/** Compute: the subgroup size the ICD reports. A module that reads the subgroup builtins but uses no subgroup operation gets them as arithmetic on the local invocation index for this size (no `subgroups` feature); others keep WebGPU's subgroups. */
	subgroupSize?: number;
}

export interface VkShaderVarying {
	location: number;
	interpolation: string;
	sampling: string;
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
	/** WebGPU features the WGSL needs ("shader-f16", "subgroups", "clip-distances", "dual-source-blending", "primitive-index"), or the WGSL language feature "uniform_buffer_standard_layout" (a uniform block the translator could not repack; navigator.gpu.wgslLanguageFeatures); anything else cannot run on WebGPU. */
	requires?: string[];
	/** Compute: multiply each dispatch's group counts by these (the workgroup was shrunk to fit opts.limits). */
	dispatchScale?: [number, number, number];
	/** Vertex: the outputs' interpolation, for the fragment stage's opts.link. */
	varyings?: VkShaderVarying[];
}

export interface VkShaderTranslator {
	translate(spirv: Uint8Array, opts: VkShaderOpts): VkShaderResult;
}

// WebGPU format names at their SPIR-V ImageFormat numbers.
const SPIRV_FORMATS = ["", "rgba32float", "rgba16float", "r32float", "rgba8unorm", "rgba8snorm", "rg32float", "rg16float", "", "r16float", "rgba16unorm", "rgb10a2unorm", "rg16unorm", "rg8unorm", "r16unorm", "r8unorm", "rgba16snorm", "rg16snorm", "rg8snorm", "r16snorm", "r8snorm", "rgba32sint", "rgba16sint", "rgba8sint", "r32sint", "rg32sint", "rg16sint", "rg8sint", "r16sint", "r8sint", "rgba32uint", "rgba16uint", "rgba8uint", "r32uint", "rgb10a2uint", "rg32uint", "rg16uint", "rg8uint", "r16uint", "r8uint"];

interface Exports {
	memory: WebAssembly.Memory;
	kwvk_alloc(len: number): number;
	kwvk_free(ptr: number, len: number): void;
	kwvk_translate(spv: number, spvLen: number, opts: number, optsLen: number): number;
}

async function wasmBytes(src: BufferSource | Response | Promise<Response> | URL | string): Promise<BufferSource> {
	if (typeof src === "string" || src instanceof URL) {
		const url = typeof src === "string" ? new URL(src, (globalThis as { location?: { href: string } }).location?.href ?? import.meta.url) : src;
		if (url.protocol === "file:") {
			// Node only; not an import, so that the web entry reaches no Node built-in (build.config.ts checks)
			const fs = (globalThis as { process?: { getBuiltinModule?(id: string): unknown } }).process?.getBuiltinModule?.("node:fs/promises") as typeof import("node:fs/promises") | undefined;
			if (!fs) throw new Error(`kwvk-naga.wasm: cannot read ${url.href} here`);
			return fs.readFile(url);
		}
		src = fetch(url);
	}
	const res = await src;
	if (typeof Response !== "undefined" && res instanceof Response) {
		if (!res.ok) throw new Error(`kwvk-naga.wasm: HTTP ${res.status}`);
		return res.arrayBuffer();
	}
	return res as BufferSource;
}

export async function loadVkShader(wasm: BufferSource | Response | Promise<Response> | URL | string): Promise<VkShaderTranslator> {
	// A gzipped translator (kwvk-naga.wasm.gz, as a release mirror sends it) is gunzipped first.
	const bytes = await wasmBytes(wasm);
	const module = await WebAssembly.compile(await gunzipBytes(ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes)) as Uint8Array<ArrayBuffer>);
	let ex = (await WebAssembly.instantiate(module, {})).exports as unknown as Exports;
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	// A trap (a naga panic) leaves the instance unusable: start a fresh one.
	let broken = false;
	return {
		translate(spirv: Uint8Array, opts: VkShaderOpts): VkShaderResult {
			if (broken) {
				ex = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
				broken = false;
			}
			const e = ex;
			let text = `stage=${opts.stage}\nentry=${opts.entryPoint}\nflipY=${opts.flipY ? 1 : 0}\npushGroup=${opts.pushGroup ?? 0}\n`;
			for (const [id, v] of Object.entries(opts.spec ?? {})) text += `spec.${id}=${typeof v === "boolean" ? (v ? 1 : 0) : v}\n`;
			for (const [sb, a] of Object.entries(opts.arrays ?? {})) text += `array.${sb}=${a.base},${a.count}\n`;
			for (const [sb, f] of Object.entries(opts.storageFormats ?? {})) {
				const n = SPIRV_FORMATS.indexOf(f);
				if (n > 0) text += `format.${sb}=${n}\n`;
			}
			const l = opts.limits;
			if (l) text += `limits=${l.maxComputeWorkgroupSizeX},${l.maxComputeWorkgroupSizeY},${l.maxComputeWorkgroupSizeZ},${l.maxComputeInvocationsPerWorkgroup}\n`;
			if (opts.features?.length) text += `features=${opts.features.join(",")}\n`;
			if (opts.subgroupSize) text += `subgroupSize=${opts.subgroupSize}\n`;
			for (const v of opts.link ?? []) text += `link.${v.location}=${v.interpolation},${v.sampling}\n`;
			const o = enc.encode(text);
			const sp = e.kwvk_alloc(spirv.length);
			const op = e.kwvk_alloc(o.length);
			new Uint8Array(e.memory.buffer, sp, spirv.length).set(spirv);
			new Uint8Array(e.memory.buffer, op, o.length).set(o);
			let json: string;
			try {
				const rp = e.kwvk_translate(sp, spirv.length, op, o.length);
				const len = new DataView(e.memory.buffer).getUint32(rp, true);
				json = dec.decode(new Uint8Array(e.memory.buffer, rp + 4, len));
				e.kwvk_free(rp, len + 4);
				e.kwvk_free(sp, spirv.length);
				e.kwvk_free(op, o.length);
			} catch (err) {
				broken = true;
				throw new Error(`SPIR-V translation crashed (a naga panic): ${(err as Error).message}`);
			}
			const r = JSON.parse(json) as VkShaderResult & { error?: string };
			if (r.error !== undefined) throw new Error(r.error);
			return r;
		},
	};
}
