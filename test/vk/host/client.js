// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Browser side of test/vk/host/check.mjs: a fake kwvk client that encodes
// protocol messages directly and drives VkRenderer (js/core/vk-host.ts) on
// the page's WebGPU device, with a fake translator (hand-written WGSL) and,
// when the server provides it, the real one (vk-shader.ts) on SPIR-V.

import { VK_SUBGROUP_SIZE, VkRenderer, frame, vkDeviceDescriptor } from "/js/core/vk-host.ts";

const logs = [];
const log = (line) => {
	logs.push(line);
	fetch("/log", { method: "POST", body: line });
};

// --- fake translator: the "SPIR-V" is the text FAKE:<name> -----------------

const FAKE = {
	"tri.vert": (o) => ({
		wgsl: `struct U { scale: vec4f }
@group(0) @binding(0) var<uniform> u: U;
@vertex fn main(@location(0) pos: vec2f) -> @builtin(position) vec4f {
	var p = vec4f(pos * u.scale.xy, 0.0, 1.0);
	${o.flipY ? "p.y = -p.y;" : ""}
	return p;
}`,
		bindings: [{ set: 0, binding: 0, group: 0, wgslBinding: 0, kind: "uniform" }],
	}),
	"tri.frag": (o) => ({
		wgsl: `struct P { color: vec4f }
@group(${o.pushGroup}) @binding(0) var<uniform> pc: P;
@fragment fn main() -> @location(0) vec4f { return pc.color; }`,
		bindings: [],
		pushConstantSize: 16,
	}),
	"quad.vert": (o) => ({
		wgsl: `struct VO { @builtin(position) p: vec4f, @location(0) uv: vec2f }
@vertex fn main(@location(0) pos: vec3f, @location(1) uv: vec2f) -> VO {
	var o: VO;
	o.p = vec4f(pos.x, ${o.flipY ? "-" : ""}pos.y, pos.z, 1.0);
	o.uv = uv;
	return o;
}`,
		bindings: [],
	}),
	"quad.frag": () => ({
		wgsl: `@group(0) @binding(2) var t: texture_2d<f32>;
@group(0) @binding(3) var s: sampler;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return textureSample(t, s, uv); }`,
		bindings: [
			{ set: 0, binding: 1, group: 0, wgslBinding: 2, kind: "texture", sampleType: "float", viewDimension: "2d" },
			{ set: 0, binding: 1, group: 0, wgslBinding: 3, kind: "sampler" },
		],
	}),
	"wide.comp": () => ({
		wgsl: `struct P { n: u32 }
struct B { v: array<f32> }
@group(1) @binding(0) var<uniform> p: P;
@group(0) @binding(0) var<storage, read_write> b: B;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id: vec3u) { if (id.x < p.n) { b.v[id.x] *= 2.0; } }`,
		bindings: [{ set: 0, binding: 0, group: 0, wgslBinding: 0, kind: "storage" }],
		pushConstantSize: 4,
		dispatchScale: [2, 1, 1],
	}),
	"barrier.comp": () => ({
		wgsl: `struct B { v: array<u32> }
@group(0) @binding(0) var<storage, read_write> b: B;
var<workgroup> s: array<u32, 64>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_id) id: vec3u) {
	s[id.x] = b.v[id.x];
	if (b.v[id.x] > 5u) { workgroupBarrier(); }
	b.v[id.x] = s[63u - id.x];
}`,
		bindings: [{ set: 0, binding: 0, group: 0, wgslBinding: 0, kind: "storage" }],
	}),
	"shared512.comp": () => {
		throw new Error("workgroup size 512x1x1 exceeds the device's limits (maxComputeWorkgroupSize 256x256x64, maxComputeInvocationsPerWorkgroup 256) and the shader uses var<workgroup>");
	},
	"arr1d.comp": () => {
		throw new Error("WGSL: texture_storage_1d_array is not a WGSL type");
	},
	// test/vk/host hostCases: a 256-byte uniform block (GZDoom binds 252 bytes of one)
	"u256.comp": () => ({
		wgsl: `struct U { v: array<vec4u, 16> }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(2) var<storage, read_write> o: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) i: u32) { o[i] = u.v[i / 4u][i % 4u]; }`,
		bindings: [{ set: 0, binding: 0, group: 0, wgslBinding: 0, kind: "uniform" }, { set: 0, binding: 1, group: 0, wgslBinding: 2, kind: "storage" }],
	}),
	// a texture and a sampler the app may leave unwritten, read into a buffer
	"tex.comp": () => ({
		wgsl: `@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(2) var s: sampler;
@group(0) @binding(4) var<storage, read_write> o: array<f32>;
@compute @workgroup_size(1) fn main() { let c = textureSampleLevel(t, s, vec2f(0.5), 0.0); o[0] = c.r; o[1] = c.g; o[2] = c.b; o[3] = c.a; o[4] = 7.0; }`,
		bindings: [
			{ set: 0, binding: 0, group: 0, wgslBinding: 0, kind: "texture", sampleType: "float", viewDimension: "2d" },
			{ set: 0, binding: 1, group: 0, wgslBinding: 2, kind: "sampler" },
			{ set: 0, binding: 2, group: 0, wgslBinding: 4, kind: "storage" },
		],
	}),
	// o[i] = a[i] for 64 words, a read-only
	"copyro.comp": () => ({
		wgsl: `@group(0) @binding(0) var<storage, read> a: array<u32>;
@group(0) @binding(2) var<storage, read_write> o: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) i: u32) { o[i] = a[i]; }`,
		bindings: [{ set: 0, binding: 0, group: 0, wgslBinding: 0, kind: "read-only-storage" }, { set: 0, binding: 1, group: 0, wgslBinding: 2, kind: "storage" }],
	}),
	// position from the vertex buffer, no bindings
	"pos.vert": (o) => ({
		wgsl: `@vertex fn main(@location(0) pos: vec2f) -> @builtin(position) vec4f { return vec4f(pos.x, ${o.flipY ? "-" : ""}pos.y, 0.0, 1.0); }`,
		bindings: [],
	}),
	"red.frag": () => ({ wgsl: `@fragment fn main() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }`, bindings: [] }),
	// a fragment stage reading a storage buffer
	"sbo.frag": () => ({
		wgsl: `@group(0) @binding(0) var<storage, read> a: array<vec4f>;
@fragment fn main() -> @location(0) vec4f { return a[0]; }`,
		bindings: [{ set: 0, binding: 0, group: 0, wgslBinding: 0, kind: "read-only-storage" }],
	}),
	"double.comp": (o) => ({
		wgsl: `const MUL = ${o.spec?.[0] ?? 1}u;
struct B { v: array<u32> }
@group(0) @binding(0) var<storage, read_write> b: B;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) { b.v[id.x] *= MUL; }`,
		bindings: [{ set: 0, binding: 0, group: 0, wgslBinding: 0, kind: "storage" }],
	}),
};

const fakeTranslator = {
	translate(spirv, opts) {
		const text = new TextDecoder().decode(spirv);
		const f = FAKE[text.replace(/^FAKE:/, "")];
		if (!f) throw new Error(`fake translator: unknown shader ${text.slice(0, 20)}`);
		return { entryPoint: "main", ...f(opts) };
	},
};

// --- client ------------------------------------------------------------------

class Client {
	constructor(renderer) {
		this.pending = new Map();
		this.nextR = 1;
		this.buf = new Uint8Array(0);
		this.closedByHost = 0;
		// the host ended the stream: what is pending fails, as the ICD's waits do on a dead link
		this.conn = renderer.connect((bytes) => this.onBytes(bytes), () => {
			this.closedByHost++;
			for (const p of this.pending.values()) p.reject(new Error(`link closed${this.lost ? ` (lost: ${this.lost})` : ""}`));
			this.pending.clear();
		});
		this.chunky = true;
	}
	onBytes(bytes) {
		const n = new Uint8Array(this.buf.length + bytes.length);
		n.set(this.buf);
		n.set(bytes, this.buf.length);
		this.buf = n;
		while (this.buf.length >= 8) {
			const dv = new DataView(this.buf.buffer, this.buf.byteOffset);
			const total = dv.getUint32(0, true);
			const jlen = dv.getUint32(4, true);
			if (this.buf.length < 8 + total) break;
			const json = JSON.parse(new TextDecoder().decode(this.buf.subarray(8, 8 + jlen)));
			const bin = this.buf.slice(8 + ((jlen + 3) & ~3), 8 + total);
			this.buf = this.buf.slice(8 + total);
			if (json.lost) this.lost = json.lost;
			const p = this.pending.get(json.r);
			if (p) {
				this.pending.delete(json.r);
				if (json.err) p.reject(Object.assign(new Error(json.err), { result: json.result }));
				else p.resolve({ json, bin });
			}
		}
	}
	feed(bytes) {
		// arbitrary chunking: split frames into odd pieces
		if (!this.chunky) return this.conn.feed(bytes);
		for (let i = 0; i < bytes.length; ) {
			const n = 1 + ((i * 7 + bytes.length) % 13) * 37;
			this.conn.feed(bytes.subarray(i, i + n));
			i += n;
		}
	}
	post(msg, bin) {
		this.feed(frame(msg, bin));
	}
	req(msg, bin) {
		const r = this.nextR++;
		return new Promise((resolve, reject) => {
			this.pending.set(r, { resolve, reject });
			this.feed(frame({ ...msg, r }, bin));
		});
	}
}

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok: !!ok, detail });
	log(`${ok ? "ok" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

const u8 = (a) => new Uint8Array(a.buffer ? a.buffer : a);

async function suite(device, adapter, translator, label, shaderBytes) {
	const renderer = new VkRenderer({ device, adapter, shaders: translator, log: (l) => log(`[${label}] ${l}`) });
	const cl = new Client(renderer);
	let id = 1;
	const nid = () => id++;

	// (a) hello
	const hello = await cl.req({ op: "hello", version: 1 });
	const h = hello.json;
	check(`${label} hello`, h.version === 1 && h.limits.maxBindGroups >= 4 && (h.formats["37"] & 5) === 5 && (h.formats["44"] & 4) && (h.formats["126"] & 16) && (h.formats["106"] & 64), `adapter ${JSON.stringify(h.adapter)} formats ${Object.keys(h.formats).length}`);

	// (b) buffer round trip
	const buf = nid();
	cl.post({ op: "vkCreateBuffer", id: buf, size: 64, usage: 0x20 | 0x3 });
	const data = new Uint8Array(64).map((_, i) => i * 3 + 1);
	cl.post({ op: "writeBuffer", buffer: buf, offset: 0 }, data);
	const rb = await cl.req({ op: "readBuffer", buffer: buf, offset: 5, size: 21 });
	check(`${label} buffer round trip`, rb.bin.length === 21 && rb.bin.every((v, i) => v === data[i + 5]));

	// (c) triangle
	const W = 64, H = 64;
	const img = nid(), view = nid(), rp = nid(), fb = nid();
	cl.post({ op: "vkCreateImage", id: img, imageType: 1, format: 37, extent: { width: W, height: H, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, tiling: 0, usage: 0x10 | 0x1 | 0x4 });
	cl.post({ op: "vkCreateImageView", id: view, image: img, viewType: 1, format: 37, subresourceRange: { aspectMask: 1, baseMipLevel: 0, levelCount: 1, baseArrayLayer: 0, layerCount: 1 } });
	cl.post({
		op: "vkCreateRenderPass", id: rp,
		pAttachments: [{ format: 37, samples: 1, loadOp: 1, storeOp: 0, stencilLoadOp: 2, stencilStoreOp: 1, initialLayout: 0, finalLayout: 1000001002 }],
		pSubpasses: [{ pipelineBindPoint: 0, pColorAttachments: [{ attachment: 0, layout: 2 }], pDepthStencilAttachment: null }],
	});
	cl.post({ op: "vkCreateFramebuffer", id: fb, renderPass: rp, attachments: [view], width: W, height: H, layers: 1 });
	const vs = nid(), fs = nid(), dsl = nid(), pl = nid(), pipe = nid(), set = nid(), ubo = nid(), vbo = nid();
	cl.post({ op: "vkCreateShaderModule", id: vs }, shaderBytes("tri.vert"));
	cl.post({ op: "vkCreateShaderModule", id: fs }, shaderBytes("tri.frag"));
	cl.post({ op: "vkCreateDescriptorSetLayout", id: dsl, bindings: [{ binding: 0, descriptorType: 8, descriptorCount: 1, stageFlags: 1 }] });
	cl.post({ op: "vkCreatePipelineLayout", id: pl, setLayouts: [dsl], pushConstantRanges: [{ stageFlags: 0x10, offset: 0, size: 16 }] });
	cl.post({
		op: "vkCreateGraphicsPipelines", id: pipe, layout: pl, renderPass: rp, subpass: 0,
		stages: [{ stage: 1, module: vs, pName: "main" }, { stage: 0x10, module: fs, pName: "main" }],
		vertexInputState: { vertexBindingDescriptions: [{ binding: 0, stride: 8, inputRate: 0 }], vertexAttributeDescriptions: [{ location: 0, binding: 0, format: 103, offset: 0 }] },
		inputAssemblyState: { topology: 3, primitiveRestartEnable: 0 },
		viewportState: { viewports: [{ x: 0, y: 0, width: W, height: H, minDepth: 0, maxDepth: 1 }], scissors: [{ offset: { x: 0, y: 0 }, extent: { width: W, height: H } }] },
		// Vulkan: (-1,-1),(1,-1),(-1,1) is clockwise in framebuffer space; cull back faces
		rasterizationState: { polygonMode: 0, cullMode: 2, frontFace: 1, lineWidth: 1 },
		multisampleState: { rasterizationSamples: 1 },
		colorBlendState: { attachments: [{ blendEnable: 0, colorWriteMask: 15 }] },
		dynamicState: { dynamicStates: [0, 1] },
	});
	cl.post({ op: "vkCreateBuffer", id: ubo, size: 512, usage: 0x10 });
	const ub = new Float32Array(128);
	ub.set([1, 1, 0, 0], 64); // scale at offset 256; offset 0 holds zeros (a degenerate triangle)
	cl.post({ op: "writeBuffer", buffer: ubo, offset: 0 }, u8(ub));
	cl.post({ op: "vkCreateBuffer", id: vbo, size: 24, usage: 0x80 });
	cl.post({ op: "writeBuffer", buffer: vbo, offset: 0 }, u8(new Float32Array([-1, -1, 1, -1, -1, 1])));
	cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: set, layout: dsl }] });
	cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: set, dstBinding: 0, dstArrayElement: 0, descriptorType: 8, bufferInfo: [{ buffer: ubo, offset: 0, range: 16 }] }], descriptorCopies: [] });
	const out = nid();
	cl.post({ op: "vkCreateBuffer", id: out, size: W * H * 4, usage: 0x2 });
	const out2 = nid();
	cl.post({ op: "vkCreateBuffer", id: out2, size: 30 * 20 * 4, usage: 0x2 });
	// a second, smaller image for a scaled blit
	const small = nid();
	cl.post({ op: "vkCreateImage", id: small, imageType: 1, format: 37, extent: { width: 32, height: 32, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x3 | 0x4 | 0x10 });
	const outSmall = nid();
	cl.post({ op: "vkCreateBuffer", id: outSmall, size: 32 * 32 * 4, usage: 0x2 });
	const red = u8(new Float32Array([1, 0, 0, 1]));
	const sub = await cl.req({
		op: "vkQueueSubmit",
		cmds: [
			{ c: "vkCmdBeginRenderPass", renderPass: rp, framebuffer: fb, renderArea: { offset: { x: 0, y: 0 }, extent: { width: W, height: H } }, clearValues: [{ color: { float32: [0, 0, 1, 1] } }], contents: 0 },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: pipe },
			{ c: "vkCmdSetViewport", firstViewport: 0, viewports: [{ x: 0, y: 0, width: W, height: H, minDepth: 0, maxDepth: 1 }] },
			{ c: "vkCmdSetScissor", firstScissor: 0, scissors: [{ offset: { x: 0, y: 0 }, extent: { width: W, height: H } }] },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: pl, firstSet: 0, descriptorSets: [set], dynamicOffsets: [256] },
			{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [vbo], offsets: [0] },
			{ c: "vkCmdPushConstants", layout: pl, stageFlags: 0x10, offset: 0, size: 16, values: [...red] },
			{ c: "vkCmdDraw", vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
			{ c: "vkCmdEndRenderPass" },
			{ c: "vkCmdPipelineBarrier" },
			{ c: "vkCmdCopyImageToBuffer", srcImage: img, srcImageLayout: 6, dstBuffer: out, regions: [{ bufferOffset: 0, bufferRowLength: 0, bufferImageHeight: 0, imageSubresource: { aspectMask: 1, mipLevel: 0, baseArrayLayer: 0, layerCount: 1 }, imageOffset: { x: 0, y: 0, z: 0 }, imageExtent: { width: W, height: H, depth: 1 } }] },
			// unaligned rows (120 bytes): the per-row path
			{ c: "vkCmdCopyImageToBuffer", srcImage: img, srcImageLayout: 6, dstBuffer: out2, regions: [{ bufferOffset: 0, bufferRowLength: 0, bufferImageHeight: 0, imageSubresource: { aspectMask: 1, mipLevel: 0, baseArrayLayer: 0, layerCount: 1 }, imageOffset: { x: 20, y: 30, z: 0 }, imageExtent: { width: 30, height: 20, depth: 1 } }] },
			{ c: "vkCmdBlitImage", srcImage: img, srcImageLayout: 6, dstImage: small, dstImageLayout: 7, regions: [{ srcSubresource: { aspectMask: 1, mipLevel: 0, baseArrayLayer: 0, layerCount: 1 }, srcOffsets: [{ x: 0, y: 0, z: 0 }, { x: W, y: H, z: 1 }], dstSubresource: { aspectMask: 1, mipLevel: 0, baseArrayLayer: 0, layerCount: 1 }, dstOffsets: [{ x: 0, y: 0, z: 0 }, { x: 32, y: 32, z: 1 }] }], filter: 1 },
			{ c: "vkCmdCopyImageToBuffer", srcImage: small, srcImageLayout: 6, dstBuffer: outSmall, regions: [{ bufferOffset: 0, imageSubresource: { aspectMask: 1, mipLevel: 0, baseArrayLayer: 0, layerCount: 1 }, imageOffset: { x: 0, y: 0, z: 0 }, imageExtent: { width: 32, height: 32, depth: 1 } }] },
		],
	});
	check(`${label} submit reply`, sub.json.r > 0);
	const px = (await cl.req({ op: "readBuffer", buffer: out, offset: 0, size: W * H * 4 })).bin;
	const at = (b, w, x, y) => [...b.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)].join(",");
	check(`${label} triangle top-left red`, at(px, W, 2, 2) === "255,0,0,255", at(px, W, 2, 2));
	check(`${label} triangle bottom-right clear blue`, at(px, W, 60, 60) === "0,0,255,255", at(px, W, 60, 60));
	check(`${label} triangle top-right red, centre-right blue (orientation, culling)`, at(px, W, 50, 2) === "255,0,0,255" && at(px, W, 40, 40) === "0,0,255,255", `${at(px, W, 50, 2)} / ${at(px, W, 40, 40)}`);
	const px2 = (await cl.req({ op: "readBuffer", buffer: out2, offset: 0, size: 30 * 20 * 4 })).bin;
	let rowsOk = true;
	for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) if (at(px2, 30, x, y) !== at(px, W, 20 + x, 30 + y)) rowsOk = false;
	check(`${label} unaligned copyImageToBuffer`, rowsOk);
	const ps = (await cl.req({ op: "readBuffer", buffer: outSmall, offset: 0, size: 32 * 32 * 4 })).bin;
	check(`${label} scaled blit`, at(ps, 32, 1, 1) === "255,0,0,255" && at(ps, 32, 30, 30) === "0,0,255,255", `${at(ps, 32, 1, 1)} / ${at(ps, 32, 30, 30)}`);

	// present readback
	const pr = await cl.req({ op: "present", image: img, readback: 1 });
	check(`${label} present`, pr.json.width === W && pr.json.height === H && pr.json.stride === W * 4 && pr.bin.length === W * H * 4 && at(pr.bin, W, 2, 2) === "255,0,0,255" && at(pr.bin, W, 60, 60) === "0,0,255,255" && cl.conn.lastPresented?.image === img);

	// (d) compute: double a storage buffer (MUL is a specialization constant)
	const cs = nid(), cdsl = nid(), cpl = nid(), cpipe = nid(), cset = nid(), sbo = nid();
	cl.post({ op: "vkCreateShaderModule", id: cs }, shaderBytes("double.comp"));
	cl.post({ op: "vkCreateDescriptorSetLayout", id: cdsl, bindings: [{ binding: 0, descriptorType: 7, descriptorCount: 1, stageFlags: 0x20 }] });
	cl.post({ op: "vkCreatePipelineLayout", id: cpl, setLayouts: [cdsl], pushConstantRanges: [] });
	cl.post({ op: "vkCreateComputePipelines", id: cpipe, layout: cpl, stage: { stage: 0x20, module: cs, pName: "main", pSpecializationInfo: { mapEntries: [{ constantID: 0, offset: 0, size: 4 }], data: [2, 0, 0, 0] } } });
	cl.post({ op: "vkCreateBuffer", id: sbo, size: 256, usage: 0x20 });
	const vals = new Uint32Array(64).map((_, i) => i + 1);
	cl.post({ op: "writeBuffer", buffer: sbo, offset: 0 }, u8(vals));
	cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: cset, layout: cdsl }] });
	cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: cset, dstBinding: 0, descriptorType: 7, bufferInfo: [{ buffer: sbo, offset: 0, range: -1 }] }] });
	cl.post({ op: "vkQueueSubmit", cmds: [
		{ c: "vkCmdBindPipeline", pipelineBindPoint: 1, pipeline: cpipe },
		{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 1, layout: cpl, firstSet: 0, descriptorSets: [cset], dynamicOffsets: [] },
		{ c: "vkCmdDispatch", groupCountX: 1, groupCountY: 1, groupCountZ: 1 },
	] });
	await cl.req({ op: "sync" });
	const cr = new Uint32Array((await cl.req({ op: "readBuffer", buffer: sbo, offset: 0, size: 256 })).bin.buffer);
	check(`${label} compute doubles`, cr.every((v, i) => v === (i + 1) * 2), `${cr.slice(0, 4).join(",")}`);

	// (d1) consecutive binding updates: a write spilling from binding 0 into 1,
	// then a copy from (0, element 1), which is binding 1's buffer, into the
	// compute set's binding 0: the dispatch doubles that buffer, not the other
	{
		const sdsl = nid(), sset = nid(), dset = nid(), ba = nid(), bb = nid();
		cl.post({ op: "vkCreateDescriptorSetLayout", id: sdsl, bindings: [{ binding: 0, descriptorType: 7, descriptorCount: 1, stageFlags: 0x20 }, { binding: 1, descriptorType: 7, descriptorCount: 1, stageFlags: 0x20 }] });
		cl.post({ op: "vkCreateBuffer", id: ba, size: 256, usage: 0x20 });
		cl.post({ op: "vkCreateBuffer", id: bb, size: 256, usage: 0x20 });
		cl.post({ op: "writeBuffer", buffer: ba, offset: 0 }, u8(vals));
		cl.post({ op: "writeBuffer", buffer: bb, offset: 0 }, u8(vals));
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: sset, layout: sdsl }, { id: dset, layout: cdsl }] });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: sset, dstBinding: 0, descriptorType: 7, descriptorCount: 2, bufferInfo: [{ buffer: ba, offset: 0, range: -1 }, { buffer: bb, offset: 0, range: -1 }] }] });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [], descriptorCopies: [{ srcSet: sset, srcBinding: 0, srcArrayElement: 1, dstSet: dset, dstBinding: 0, dstArrayElement: 0, descriptorCount: 1 }] });
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 1, pipeline: cpipe },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 1, layout: cpl, firstSet: 0, descriptorSets: [dset], dynamicOffsets: [] },
			{ c: "vkCmdDispatch", groupCountX: 1, groupCountY: 1, groupCountZ: 1 },
		] });
		await cl.req({ op: "sync" });
		const ra = new Uint32Array((await cl.req({ op: "readBuffer", buffer: ba, offset: 0, size: 256 })).bin.buffer);
		const rb = new Uint32Array((await cl.req({ op: "readBuffer", buffer: bb, offset: 0, size: 256 })).bin.buffer);
		check(`${label} descriptor copy past a binding's end (consecutive binding updates)`, rb.every((v, i) => v === (i + 1) * 2) && ra.every((v, i) => v === i + 1), `${ra[1]} ${rb[1]}`);
	}

	// (d2) a 512-wide workgroup (ggml's) on a device allowing 256: shrunk by
	// the translator, the dispatch scaled by the host; 1000 floats doubled
	{
		const ws = nid(), wdsl = nid(), wpl = nid(), wpipe = nid(), wset = nid(), wbo = nid();
		cl.post({ op: "vkCreateShaderModule", id: ws }, shaderBytes("wide.comp"));
		cl.post({ op: "vkCreateDescriptorSetLayout", id: wdsl, bindings: [{ binding: 0, descriptorType: 7, descriptorCount: 1, stageFlags: 0x20 }] });
		cl.post({ op: "vkCreatePipelineLayout", id: wpl, setLayouts: [wdsl], pushConstantRanges: [{ stageFlags: 0x20, offset: 0, size: 4 }] });
		cl.post({ op: "vkCreateComputePipelines", id: wpipe, layout: wpl, stage: { stage: 0x20, module: ws, pName: "main" } });
		cl.post({ op: "vkCreateBuffer", id: wbo, size: 4096, usage: 0x20 });
		const wv = new Float32Array(1024).map((_, i) => i + 0.5);
		cl.post({ op: "writeBuffer", buffer: wbo, offset: 0 }, u8(wv));
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: wset, layout: wdsl }] });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: wset, dstBinding: 0, descriptorType: 7, bufferInfo: [{ buffer: wbo, offset: 0, range: -1 }] }] });
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 1, pipeline: wpipe },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 1, layout: wpl, firstSet: 0, descriptorSets: [wset], dynamicOffsets: [] },
			{ c: "vkCmdPushConstants", layout: wpl, stageFlags: 0x20, offset: 0, size: 4, values: [232, 3, 0, 0] },
			{ c: "vkCmdDispatch", groupCountX: 2, groupCountY: 1, groupCountZ: 1 },
		] });
		await cl.req({ op: "sync" });
		const wr = new Float32Array((await cl.req({ op: "readBuffer", buffer: wbo, offset: 0, size: 4096 })).bin.buffer);
		check(`${label} 512-wide workgroup doubles 1000 floats`, wr.every((v, i) => v === (i < 1000 ? (i + 0.5) * 2 : i + 0.5)), `${wr[0]},${wr[600]},${wr[999]},${wr[1000]}`);
	}

	// (e) depth test, indexed draws, a sampled texture uploaded with
	// copyBufferToImage, clearAttachments, sRGB BGRA present
	{
		const S = 32;
		const tex = nid(), texView = nid(), smp = nid(), stg = nid();
		cl.post({ op: "vkCreateImage", id: tex, imageType: 1, format: 37, extent: { width: 2, height: 2, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x2 | 0x4 });
		cl.post({ op: "vkCreateImageView", id: texView, image: tex, viewType: 1, format: 37, subresourceRange: { aspectMask: 1, baseMipLevel: 0, levelCount: 1, baseArrayLayer: 0, layerCount: 1 } });
		cl.post({ op: "vkCreateSampler", id: smp, magFilter: 0, minFilter: 0, mipmapMode: 0, addressModeU: 2, addressModeV: 2, addressModeW: 2, maxLod: 0.25 });
		cl.post({ op: "vkCreateBuffer", id: stg, size: 16, usage: 0x1 });
		cl.post({ op: "writeBuffer", buffer: stg, offset: 0 }, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]));
		const col = nid(), colView = nid(), dep = nid(), depView = nid(), rp2 = nid(), fb2 = nid();
		cl.post({ op: "vkCreateImage", id: col, imageType: 1, format: 50, extent: { width: S, height: S, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x10 | 0x1 });
		cl.post({ op: "vkCreateImageView", id: colView, image: col, viewType: 1, format: 50, subresourceRange: { aspectMask: 1, baseMipLevel: 0, levelCount: 1, baseArrayLayer: 0, layerCount: 1 } });
		cl.post({ op: "vkCreateImage", id: dep, imageType: 1, format: 124, extent: { width: S, height: S, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x20 });
		cl.post({ op: "vkCreateImageView", id: depView, image: dep, viewType: 1, format: 124, subresourceRange: { aspectMask: 2, baseMipLevel: 0, levelCount: 1, baseArrayLayer: 0, layerCount: 1 } });
		cl.post({
			op: "vkCreateRenderPass", id: rp2,
			attachments: [
				{ format: 50, samples: 1, loadOp: 1, storeOp: 0, stencilLoadOp: 2, stencilStoreOp: 1 },
				{ format: 124, samples: 1, loadOp: 1, storeOp: 1, stencilLoadOp: 2, stencilStoreOp: 1 },
			],
			subpasses: [{ colorAttachments: [{ attachment: 0, layout: 2 }], depthStencilAttachment: { attachment: 1, layout: 3 } }],
		});
		cl.post({ op: "vkCreateFramebuffer", id: fb2, renderPass: rp2, attachments: [colView, depView], width: S, height: S, layers: 1 });
		const qv = nid(), qf = nid(), qdsl = nid(), qpl = nid(), qp = nid(), qset = nid(), qvb = nid(), qib = nid();
		cl.post({ op: "vkCreateShaderModule", id: qv }, shaderBytes("quad.vert"));
		cl.post({ op: "vkCreateShaderModule", id: qf }, shaderBytes("quad.frag"));
		cl.post({ op: "vkCreateDescriptorSetLayout", id: qdsl, bindings: [{ binding: 1, descriptorType: 1, descriptorCount: 1, stageFlags: 0x10 }] });
		cl.post({ op: "vkCreatePipelineLayout", id: qpl, setLayouts: [qdsl] });
		cl.post({
			op: "vkCreateGraphicsPipelines", id: qp, layout: qpl, renderPass: rp2, subpass: 0,
			stages: [{ stage: 1, module: qv, name: "main" }, { stage: 0x10, module: qf, name: "main" }],
			vertexInputState: {
				vertexBindingDescriptions: [{ binding: 0, stride: 20, inputRate: 0 }],
				vertexAttributeDescriptions: [{ location: 0, binding: 0, format: 106, offset: 0 }, { location: 1, binding: 0, format: 103, offset: 12 }],
			},
			inputAssemblyState: { topology: 3 },
			rasterizationState: { cullMode: 0, frontFace: 0 },
			multisampleState: { rasterizationSamples: 1 },
			depthStencilState: { depthTestEnable: 1, depthWriteEnable: 1, depthCompareOp: 1 },
			colorBlendState: { attachments: [{ blendEnable: 0, colorWriteMask: 15 }] },
			dynamicState: { dynamicStates: [0, 1] },
		});
		// near quad (z 0.2) on the left half sampling texel (0,0) red; far quad (z 0.8) everywhere sampling (1,1) white
		const quad = (x0, x1, z, u) => [x0, -1, z, u, u, x1, -1, z, u, u, x1, 1, z, u, u, x0, 1, z, u, u];
		cl.post({ op: "vkCreateBuffer", id: qvb, size: 160, usage: 0x80 });
		cl.post({ op: "writeBuffer", buffer: qvb, offset: 0 }, u8(new Float32Array([...quad(-1, 0, 0.2, 0.25), ...quad(-1, 1, 0.8, 0.75)])));
		cl.post({ op: "vkCreateBuffer", id: qib, size: 24, usage: 0x40 });
		cl.post({ op: "writeBuffer", buffer: qib, offset: 0 }, u8(new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])));
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: qset, layout: qdsl }] });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: qset, dstBinding: 1, descriptorType: 1, imageInfo: [{ sampler: smp, imageView: texView, imageLayout: 5 }] }] });
		const outq = nid();
		cl.post({ op: "vkCreateBuffer", id: outq, size: 4 * 4, usage: 0x2 });
		const sq = await cl.req({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdCopyBufferToImage", srcBuffer: stg, dstImage: tex, dstImageLayout: 7, regions: [{ bufferOffset: 0, bufferRowLength: 0, bufferImageHeight: 0, imageSubresource: { aspectMask: 1, mipLevel: 0, baseArrayLayer: 0, layerCount: 1 }, imageOffset: { x: 0, y: 0, z: 0 }, imageExtent: { width: 2, height: 2, depth: 1 } }] },
			{ c: "vkCmdCopyImageToBuffer", srcImage: tex, dstBuffer: outq, regions: [{ bufferOffset: 0, imageSubresource: { aspectMask: 1, mipLevel: 0, layerCount: 1 }, imageOffset: { x: 1, y: 1, z: 0 }, imageExtent: { width: 1, height: 1, depth: 1 } }] },
			{ c: "vkCmdBeginRenderPass", renderPass: rp2, framebuffer: fb2, renderArea: { offset: { x: 0, y: 0 }, extent: { width: S, height: S } }, clearValues: [{ color: { float32: [0, 0, 0, 1], uint32: [0, 0, 0, 1065353216] } }, { depthStencil: { depth: 1, stencil: 0 } }] },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: qp },
			{ c: "vkCmdSetViewport", viewports: [{ x: 0, y: 0, width: S, height: S, minDepth: 0, maxDepth: 1 }] },
			{ c: "vkCmdSetScissor", scissors: [{ offset: { x: 0, y: 0 }, extent: { width: S, height: S } }] },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: qpl, firstSet: 0, descriptorSets: [qset] },
			{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [qvb], offsets: [0] },
			{ c: "vkCmdBindIndexBuffer", buffer: qib, offset: 0, indexType: 0 },
			{ c: "vkCmdDrawIndexed", indexCount: 6, instanceCount: 1, firstIndex: 0, vertexOffset: 0, firstInstance: 0 },
			{ c: "vkCmdDrawIndexed", indexCount: 6, instanceCount: 1, firstIndex: 6, vertexOffset: 0, firstInstance: 0 },
			{ c: "vkCmdClearAttachments", attachments: [{ aspectMask: 1, colorAttachment: 0, clearValue: { color: { float32: [0, 1, 0, 1] } } }], rects: [{ rect: { offset: { x: 28, y: 0 }, extent: { width: 4, height: 4 } }, baseArrayLayer: 0, layerCount: 1 }] },
			{ c: "vkCmdEndRenderPass" },
		] });
		check(`${label} depth scene submit`, sq.json.r > 0);
		const tq = (await cl.req({ op: "readBuffer", buffer: outq, offset: 0, size: 4 })).bin;
		check(`${label} copyBufferToImage (unaligned rows)`, [...tq].join(",") === "255,255,255,255", [...tq].join(","));
		const pq = await cl.req({ op: "present", image: col, readback: 1 });
		const b = pq.bin;
		check(`${label} depth test + texture (near red wins on the left, BGRA)`, at(b, S, 4, 16) === "0,0,255,255", at(b, S, 4, 16));
		check(`${label} far quad white on the right`, at(b, S, 24, 16) === "255,255,255,255", at(b, S, 24, 16));
		check(`${label} clearAttachments rect green`, at(b, S, 30, 1) === "0,255,0,255" && at(b, S, 26, 1) === "255,255,255,255", `${at(b, S, 30, 1)} / ${at(b, S, 26, 1)}`);
		// a depth texture sampled through a plain sampler2D: the layout is
		// refined to unfilterable-float / non-filtering at draw time
		const dt = nid(), dtView = nid(), qset2 = nid();
		cl.post({ op: "vkCreateImage", id: dt, imageType: 1, format: 126, extent: { width: 4, height: 4, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x20 | 0x4 | 0x2 });
		cl.post({ op: "vkCreateImageView", id: dtView, image: dt, viewType: 1, format: 126, subresourceRange: { aspectMask: 2, levelCount: 1, layerCount: 1 } });
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: qset2, layout: qdsl }] });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: qset2, dstBinding: 1, descriptorType: 1, imageInfo: [{ sampler: smp, imageView: dtView, imageLayout: 5 }] }] });
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdClearDepthStencilImage", image: dt, imageLayout: 7, depthStencil: { depth: 0.5, stencil: 0 }, ranges: [{ aspectMask: 2, levelCount: 1, layerCount: 1 }] },
			{ c: "vkCmdBeginRenderPass", renderPass: rp2, framebuffer: fb2, clearValues: [{ color: { float32: [0, 0, 0, 1] } }, { depthStencil: { depth: 1, stencil: 0 } }] },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: qp },
			{ c: "vkCmdSetViewport", viewports: [{ x: 0, y: 0, width: S, height: S, minDepth: 0, maxDepth: 1 }] },
			{ c: "vkCmdSetScissor", scissors: [{ offset: { x: 0, y: 0 }, extent: { width: S, height: S } }] },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: qpl, firstSet: 0, descriptorSets: [qset2] },
			{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [qvb], offsets: [0] },
			{ c: "vkCmdBindIndexBuffer", buffer: qib, offset: 0, indexType: 0 },
			{ c: "vkCmdDrawIndexed", indexCount: 12, instanceCount: 1, firstIndex: 0, vertexOffset: 0, firstInstance: 0 },
			{ c: "vkCmdEndRenderPass" },
		] });
		const pd = await cl.req({ op: "present", image: col, readback: 1 });
		const dr = pd.bin[(16 * S + 8) * 4 + 2];
		check(`${label} depth texture sampled as float (refined layout)`, dr >= 180 && dr <= 195, `R=${dr} (sRGB of 0.5 is 188)`);
		// component swizzles: an R8 texture viewed as (ONE, ONE, ONE, R), GTK's alpha-only glyph case
		{
			const r8 = nid(), r8v = nid(), sset = nid();
			cl.post({ op: "vkCreateImage", id: r8, imageType: 1, format: 9, extent: { width: 1, height: 1, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x2 | 0x4 });
			cl.post({ op: "vkCreateImageView", id: r8v, image: r8, viewType: 1, format: 9, components: { r: 2, g: 2, b: 2, a: 3 }, subresourceRange: { aspectMask: 1, levelCount: 1, layerCount: 1 } });
			cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: sset, layout: qdsl }] });
			cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: sset, dstBinding: 1, descriptorType: 1, imageInfo: [{ sampler: smp, imageView: r8v, imageLayout: 5 }] }] });
			cl.post({ op: "vkQueueSubmit", cmds: [
				{ c: "vkCmdClearColorImage", image: r8, color: { float32: [0.5, 0, 0, 0] }, ranges: [{ aspectMask: 1, levelCount: 1, layerCount: 1 }] },
				{ c: "vkCmdBeginRenderPass", renderPass: rp2, framebuffer: fb2, clearValues: [{ color: { float32: [0, 0, 0, 1] } }, { depthStencil: { depth: 1, stencil: 0 } }] },
				{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: qp },
				{ c: "vkCmdSetViewport", viewports: [{ x: 0, y: 0, width: S, height: S, minDepth: 0, maxDepth: 1 }] },
				{ c: "vkCmdSetScissor", scissors: [{ offset: { x: 0, y: 0 }, extent: { width: S, height: S } }] },
				{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: qpl, firstSet: 0, descriptorSets: [sset] },
				{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [qvb], offsets: [0] },
				{ c: "vkCmdBindIndexBuffer", buffer: qib, offset: 0, indexType: 0 },
				{ c: "vkCmdDrawIndexed", indexCount: 12, instanceCount: 1, firstIndex: 0, vertexOffset: 0, firstInstance: 0 },
				{ c: "vkCmdEndRenderPass" },
			] });
			const pz = (await cl.req({ op: "present", image: col, readback: 1 })).bin;
			const z = [...pz.subarray((16 * S + 8) * 4, (16 * S + 8) * 4 + 4)];
			check(`${label} component swizzle (1,1,1,R) on R8`, z[0] === 255 && z[1] === 255 && z[2] === 255 && Math.abs(z[3] - 128) <= 1, z.join(","));
		}

		if (label === "spirv") {
			// a descriptor array of two combined image samplers (flattened by the translator, numbered by the host)
			const ta = nid(), tb = nid(), va = nid(), vb2 = nid(), adsl = nid(), apl = nid(), af = nid(), ap = nid(), aset = nid();
			for (const [img2, v2] of [[ta, va], [tb, vb2]]) {
				cl.post({ op: "vkCreateImage", id: img2, imageType: 1, format: 37, extent: { width: 1, height: 1, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x2 | 0x4 });
				cl.post({ op: "vkCreateImageView", id: v2, image: img2, viewType: 1, format: 37, subresourceRange: { aspectMask: 1, levelCount: 1, layerCount: 1 } });
			}
			cl.post({ op: "vkCreateShaderModule", id: af }, shaderBytes("arr.frag"));
			cl.post({ op: "vkCreateDescriptorSetLayout", id: adsl, bindings: [{ binding: 1, descriptorType: 1, descriptorCount: 2, stageFlags: 0x10 }] });
			cl.post({ op: "vkCreatePipelineLayout", id: apl, setLayouts: [adsl] });
			cl.post({
				op: "vkCreateGraphicsPipelines", id: ap, layout: apl, renderPass: 0, rendering: { colorAttachmentFormats: [37] },
				stages: [{ stage: 1, module: qv, name: "main" }, { stage: 0x10, module: af, name: "main" }],
				vertexInputState: { vertexBindingDescriptions: [{ binding: 0, stride: 20, inputRate: 0 }], vertexAttributeDescriptions: [{ location: 0, binding: 0, format: 106, offset: 0 }, { location: 1, binding: 0, format: 103, offset: 12 }] },
				inputAssemblyState: { topology: 3 }, rasterizationState: { cullMode: 0 }, multisampleState: { rasterizationSamples: 1 },
				colorBlendState: { attachments: [{ colorWriteMask: 15 }] }, dynamicState: { dynamicStates: [0, 1] },
			});
			cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: aset, layout: adsl }] });
			cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: aset, dstBinding: 1, dstArrayElement: 0, descriptorCount: 2, descriptorType: 1, imageInfo: [{ sampler: smp, imageView: va }, { sampler: smp, imageView: vb2 }] }] });
			cl.post({ op: "vkQueueSubmit", cmds: [
				{ c: "vkCmdClearColorImage", image: ta, color: { float32: [1, 0, 0, 1] }, ranges: [{ aspectMask: 1, levelCount: 1, layerCount: 1 }] },
				{ c: "vkCmdClearColorImage", image: tb, color: { float32: [0, 0, 1, 1] }, ranges: [{ aspectMask: 1, levelCount: 1, layerCount: 1 }] },
				{ c: "vkCmdBeginRendering", renderArea: { offset: { x: 0, y: 0 }, extent: { width: W, height: H } }, layerCount: 1, colorAttachments: [{ imageView: view, loadOp: 1, storeOp: 0, clearValue: { color: { float32: [0, 0, 0, 1] } } }] },
				{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: ap },
				{ c: "vkCmdSetViewport", viewports: [{ x: 0, y: 0, width: W, height: H, minDepth: 0, maxDepth: 1 }] },
				{ c: "vkCmdSetScissor", scissors: [{ offset: { x: 0, y: 0 }, extent: { width: W, height: H } }] },
				{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: apl, firstSet: 0, descriptorSets: [aset] },
				{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [qvb], offsets: [0] },
				{ c: "vkCmdBindIndexBuffer", buffer: qib, offset: 0, indexType: 0 },
				{ c: "vkCmdDrawIndexed", indexCount: 6, instanceCount: 1, firstIndex: 0, vertexOffset: 0, firstInstance: 0 },
				{ c: "vkCmdEndRendering" },
			] });
			const pa = (await cl.req({ op: "present", image: img, readback: 1 })).bin;
			const [ar, ag, ab] = pa.subarray((32 * W + 10) * 4, (32 * W + 10) * 4 + 3);
			check(`${label} descriptor array (texs[0] / 2 + texs[1] / 2)`, Math.abs(ar - 128) <= 2 && ag === 0 && Math.abs(ab - 128) <= 2, `${ar},${ag},${ab}`);
		}
		// clearColorImage
		cl.post({ op: "vkQueueSubmit", cmds: [{ c: "vkCmdClearColorImage", image: small, imageLayout: 7, color: { float32: [0, 1, 0, 1] }, ranges: [{ aspectMask: 1, baseMipLevel: 0, levelCount: 1, baseArrayLayer: 0, layerCount: 1 }] }] });
		const pc = await cl.req({ op: "present", image: small, readback: 1 });
		check(`${label} clearColorImage`, at(pc.bin, 32, 5, 5) === "0,255,0,255", at(pc.bin, 32, 5, 5));
	}

	// (f) MSAA: 4x colour resolved in the render pass
	{
		const msImg = nid(), msView = nid(), rsImg = nid(), rsView = nid(), rp3 = nid(), fb3 = nid(), mp = nid();
		cl.post({ op: "vkCreateImage", id: msImg, imageType: 1, format: 37, extent: { width: W, height: H, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 4, usage: 0x10 | 0x40 });
		cl.post({ op: "vkCreateImageView", id: msView, image: msImg, viewType: 1, format: 37, subresourceRange: { aspectMask: 1, levelCount: 1, layerCount: 1 } });
		cl.post({ op: "vkCreateImage", id: rsImg, imageType: 1, format: 37, extent: { width: W, height: H, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x10 | 0x1 });
		cl.post({ op: "vkCreateImageView", id: rsView, image: rsImg, viewType: 1, format: 37, subresourceRange: { aspectMask: 1, levelCount: 1, layerCount: 1 } });
		cl.post({
			op: "vkCreateRenderPass", id: rp3,
			attachments: [{ format: 37, samples: 4, loadOp: 1, storeOp: 0 }, { format: 37, samples: 1, loadOp: 2, storeOp: 0 }],
			subpasses: [{ colorAttachments: [{ attachment: 0 }], resolveAttachments: [{ attachment: 1 }] }],
		});
		cl.post({ op: "vkCreateFramebuffer", id: fb3, renderPass: rp3, attachments: [msView, rsView], width: W, height: H, layers: 1 });
		cl.post({
			op: "vkCreateGraphicsPipelines", id: mp, layout: pl, renderPass: rp3, subpass: 0,
			stages: [{ stage: 1, module: vs, pName: "main" }, { stage: 0x10, module: fs, pName: "main" }],
			vertexInputState: { vertexBindingDescriptions: [{ binding: 0, stride: 8, inputRate: 0 }], vertexAttributeDescriptions: [{ location: 0, binding: 0, format: 103, offset: 0 }] },
			inputAssemblyState: { topology: 3 },
			viewportState: { viewports: [{ x: 0, y: 0, width: W, height: H, minDepth: 0, maxDepth: 1 }], scissors: [{ offset: { x: 0, y: 0 }, extent: { width: W, height: H } }] },
			rasterizationState: { cullMode: 0, frontFace: 0 },
			multisampleState: { rasterizationSamples: 4 },
			colorBlendState: { attachments: [{ colorWriteMask: 15 }] },
		});
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBeginRenderPass", renderPass: rp3, framebuffer: fb3, clearValues: [{ color: { float32: [0, 0, 1, 1] } }, {}] },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: mp },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: pl, firstSet: 0, descriptorSets: [set], dynamicOffsets: [256] },
			{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [vbo], offsets: [0] },
			{ c: "vkCmdPushConstants", layout: pl, stageFlags: 0x10, offset: 0, size: 16, values: [...red] },
			{ c: "vkCmdDraw", vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
			{ c: "vkCmdEndRenderPass" },
		] });
		const pm = await cl.req({ op: "present", image: rsImg, readback: 1 });
		const edge = pm.bin.subarray((32 * W + 31) * 4, (32 * W + 31) * 4 + 4);
		// partial vkCmdResolveImage: src (0,0) 16x16 into a cleared 32x32 image at (8,8)
		const pr2 = nid();
		cl.post({ op: "vkCreateImage", id: pr2, imageType: 1, format: 37, extent: { width: 32, height: 32, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x3 | 0x10 });
		const sr = { aspectMask: 1, mipLevel: 0, baseArrayLayer: 0, layerCount: 1 };
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdClearColorImage", image: pr2, color: { float32: [0, 1, 0, 1] }, ranges: [{ aspectMask: 1, levelCount: 1, layerCount: 1 }] },
			{ c: "vkCmdResolveImage", srcImage: msImg, dstImage: pr2, regions: [{ srcSubresource: sr, srcOffset: { x: 0, y: 0, z: 0 }, dstSubresource: sr, dstOffset: { x: 8, y: 8, z: 0 }, extent: { width: 16, height: 16, depth: 1 } }] },
		] });
		const pp = await cl.req({ op: "present", image: pr2, readback: 1 });
		check(`${label} partial resolveImage`, at(pp.bin, 32, 10, 10) === "255,0,0,255" && at(pp.bin, 32, 2, 2) === "0,255,0,255" && at(pp.bin, 32, 30, 30) === "0,255,0,255", `${at(pp.bin, 32, 10, 10)} / ${at(pp.bin, 32, 2, 2)}`);
		check(`${label} MSAA resolve`, at(pm.bin, W, 2, 2) === "255,0,0,255" && at(pm.bin, W, 60, 60) === "0,0,255,255", `${at(pm.bin, W, 2, 2)} / ${at(pm.bin, W, 60, 60)} edge ${[...edge]}`);
	}

	// (h) mipmap generation: blit level 0 into level 1 of the same image
	{
		const mi = nid(), mo = nid();
		cl.post({ op: "vkCreateImage", id: mi, imageType: 1, format: 37, extent: { width: 8, height: 8, depth: 1 }, mipLevels: 2, arrayLayers: 1, samples: 1, usage: 0x1 | 0x2 | 0x4 });
		cl.post({ op: "vkCreateBuffer", id: mo, size: 64, usage: 0x2 });
		const lv = (m) => ({ aspectMask: 1, mipLevel: m, baseArrayLayer: 0, layerCount: 1 });
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdClearColorImage", image: mi, color: { float32: [1, 0, 0, 1] }, ranges: [{ aspectMask: 1, baseMipLevel: 0, levelCount: 1, baseArrayLayer: 0, layerCount: 1 }] },
			{ c: "vkCmdClearColorImage", image: mi, color: { float32: [0, 0, 1, 1] }, ranges: [{ aspectMask: 1, baseMipLevel: 1, levelCount: 1, baseArrayLayer: 0, layerCount: 1 }] },
			{ c: "vkCmdBlitImage", srcImage: mi, dstImage: mi, regions: [{ srcSubresource: lv(0), srcOffsets: [{ x: 0, y: 0, z: 0 }, { x: 8, y: 8, z: 1 }], dstSubresource: lv(1), dstOffsets: [{ x: 0, y: 0, z: 0 }, { x: 4, y: 4, z: 1 }] }], filter: 1 },
			{ c: "vkCmdCopyImageToBuffer", srcImage: mi, dstBuffer: mo, regions: [{ bufferOffset: 0, imageSubresource: lv(1), imageOffset: { x: 0, y: 0, z: 0 }, imageExtent: { width: 4, height: 4, depth: 1 } }] },
		] });
		const mb = (await cl.req({ op: "readBuffer", buffer: mo, offset: 0, size: 64 })).bin;
		check(`${label} mipmap blit`, at(mb, 4, 0, 0) === "255,0,0,255" && at(mb, 4, 3, 3) === "255,0,0,255", `${at(mb, 4, 0, 0)} / ${at(mb, 4, 3, 3)}`);
	}

	// (g) a triangle fan (emulated with a generated index buffer)
	{
		const fp = nid(), fvb = nid();
		cl.post({
			op: "vkCreateGraphicsPipelines", id: fp, layout: pl, renderPass: rp, subpass: 0,
			stages: [{ stage: 1, module: vs, pName: "main" }, { stage: 0x10, module: fs, pName: "main" }],
			vertexInputState: { vertexBindingDescriptions: [{ binding: 0, stride: 8, inputRate: 0 }], vertexAttributeDescriptions: [{ location: 0, binding: 0, format: 103, offset: 0 }] },
			inputAssemblyState: { topology: 5 },
			viewportState: { viewports: [{ x: 0, y: 0, width: W, height: H, minDepth: 0, maxDepth: 1 }], scissors: [{ offset: { x: 0, y: 0 }, extent: { width: W, height: H } }] },
			rasterizationState: { cullMode: 0, frontFace: 0 },
			multisampleState: { rasterizationSamples: 1 },
			colorBlendState: { attachments: [{ colorWriteMask: 15 }] },
		});
		cl.post({ op: "vkCreateBuffer", id: fvb, size: 40, usage: 0x80 });
		cl.post({ op: "writeBuffer", buffer: fvb, offset: 0 }, u8(new Float32Array([9, 9, 0, 0, 1, 0, 1, 1, 0, 1])));
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBeginRenderPass", renderPass: rp, framebuffer: fb, clearValues: [{ color: { float32: [0, 0, 1, 1] } }] },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: fp },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: pl, firstSet: 0, descriptorSets: [set], dynamicOffsets: [256] },
			{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [fvb], offsets: [0] },
			{ c: "vkCmdPushConstants", layout: pl, stageFlags: 0x10, offset: 0, size: 16, values: [...red] },
			{ c: "vkCmdDraw", vertexCount: 4, instanceCount: 1, firstVertex: 1, firstInstance: 0 },
			{ c: "vkCmdEndRenderPass" },
		] });
		const pf = await cl.req({ op: "present", image: img, readback: 1 });
		check(`${label} triangle fan`, at(pf.bin, W, 35, 51) === "255,0,0,255" && at(pf.bin, W, 10, 10) === "0,0,255,255", `${at(pf.bin, W, 35, 51)} / ${at(pf.bin, W, 10, 10)}`);
	}

	// (i) negative viewport heights (VK_KHR_maintenance1) and dynamic cull mode
	{
		const np = nid();
		cl.post({
			op: "vkCreateGraphicsPipelines", id: np, layout: pl, renderPass: rp, subpass: 0,
			stages: [{ stage: 1, module: vs, pName: "main" }, { stage: 0x10, module: fs, pName: "main" }],
			vertexInputState: { vertexBindingDescriptions: [{ binding: 0, stride: 8, inputRate: 0 }], vertexAttributeDescriptions: [{ location: 0, binding: 0, format: 103, offset: 0 }] },
			inputAssemblyState: { topology: 3 },
			// CCW front faces, back faces culled
			rasterizationState: { cullMode: 2, frontFace: 0 },
			multisampleState: { rasterizationSamples: 1 },
			colorBlendState: { attachments: [{ colorWriteMask: 15 }] },
			dynamicState: { dynamicStates: [0, 1, 1000267000] },
		});
		const frameCmds = (vp, extra = []) => [
			{ c: "vkCmdBeginRenderPass", renderPass: rp, framebuffer: fb, clearValues: [{ color: { float32: [0, 0, 1, 1] } }] },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: np },
			{ c: "vkCmdSetViewport", viewports: [vp] },
			{ c: "vkCmdSetScissor", scissors: [{ offset: { x: 0, y: 0 }, extent: { width: W, height: H } }] },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: pl, firstSet: 0, descriptorSets: [set], dynamicOffsets: [256] },
			{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [vbo], offsets: [0] },
			{ c: "vkCmdPushConstants", layout: pl, stageFlags: 0x10, offset: 0, size: 16, values: [...red] },
			...extra,
			{ c: "vkCmdDraw", vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
			{ c: "vkCmdEndRenderPass" },
		];
		// with y + height / -height the triangle is the GL-style lower-left half and counter-clockwise: drawn
		cl.post({ op: "vkQueueSubmit", cmds: frameCmds({ x: 0, y: H, width: W, height: -H, minDepth: 0, maxDepth: 1 }) });
		let f = (await cl.req({ op: "present", image: img, readback: 1 })).bin;
		check(`${label} negative viewport height`, at(f, W, 50, 60) === "255,0,0,255" && at(f, W, 50, 2) === "0,0,255,255" && at(f, W, 2, 30) === "255,0,0,255", `${at(f, W, 50, 60)} / ${at(f, W, 50, 2)}`);
		// a positive viewport makes it clockwise: culled
		cl.post({ op: "vkQueueSubmit", cmds: frameCmds({ x: 0, y: 0, width: W, height: H, minDepth: 0, maxDepth: 1 }) });
		f = (await cl.req({ op: "present", image: img, readback: 1 })).bin;
		check(`${label} positive viewport culls the clockwise triangle`, at(f, W, 2, 2) === "0,0,255,255", at(f, W, 2, 2));
		cl.post({ op: "vkQueueSubmit", cmds: frameCmds({ x: 0, y: 0, width: W, height: H, minDepth: 0, maxDepth: 1 }, [{ c: "vkCmdSetCullMode", cullMode: 0 }]) });
		f = (await cl.req({ op: "present", image: img, readback: 1 })).bin;
		check(`${label} vkCmdSetCullMode NONE`, at(f, W, 2, 2) === "255,0,0,255", at(f, W, 2, 2));

		// (j) a render area of the left half with LOAD_OP_CLEAR clears only that half
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBeginRenderPass", renderPass: rp, framebuffer: fb, renderArea: { offset: { x: 0, y: 0 }, extent: { width: 32, height: H } }, clearValues: [{ color: { float32: [0, 1, 0, 1] } }] },
			{ c: "vkCmdEndRenderPass" },
		] });
		f = (await cl.req({ op: "present", image: img, readback: 1 })).bin;
		check(`${label} partial render area clear`, at(f, W, 2, 40) === "0,255,0,255" && at(f, W, 50, 2) === "255,0,0,255" && at(f, W, 60, 60) === "0,0,255,255", `${at(f, W, 2, 40)} / ${at(f, W, 50, 2)} / ${at(f, W, 60, 60)}`);

		// Vulkan 1.2 names: vkCreateRenderPass2 / vkCmdBeginRenderPass2 / vkCmdEndRenderPass2
		const rp2b = nid(), fb2b = nid();
		cl.post({ op: "vkCreateRenderPass2", id: rp2b, attachments: [{ format: 37, samples: 1, loadOp: 1, storeOp: 0 }], subpasses: [{ colorAttachments: [{ attachment: 0, layout: 2, aspectMask: 1 }] }] });
		cl.post({ op: "vkCreateFramebuffer", id: fb2b, renderPass: rp2b, attachments: [view], width: W, height: H, layers: 1 });
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBeginRenderPass2", renderPass: rp2b, framebuffer: fb2b, renderArea: { offset: { x: 0, y: 0 }, extent: { width: W, height: H } }, clearValues: [{ color: { float32: [1, 1, 0, 1] } }], subpassBeginInfo: { contents: 0 } },
			{ c: "vkCmdEndRenderPass2", subpassEndInfo: {} },
		] });
		f = (await cl.req({ op: "present", image: img, readback: 1 })).bin;
		check(`${label} render pass 2`, at(f, W, 60, 60) === "255,255,0,255", at(f, W, 60, 60));

		// (l) dynamic rendering with a renderPass-less pipeline
		const dp = nid();
		cl.post({
			op: "vkCreateGraphicsPipelines", id: dp, layout: pl, renderPass: 0, subpass: 0,
			rendering: { viewMask: 0, colorAttachmentFormats: [37], depthAttachmentFormat: 0, stencilAttachmentFormat: 0 },
			stages: [{ stage: 1, module: vs, pName: "main" }, { stage: 0x10, module: fs, pName: "main" }],
			vertexInputState: { vertexBindingDescriptions: [{ binding: 0, stride: 8, inputRate: 0 }], vertexAttributeDescriptions: [{ location: 0, binding: 0, format: 103, offset: 0 }] },
			inputAssemblyState: { topology: 3 },
			rasterizationState: { cullMode: 0, frontFace: 0 },
			multisampleState: { rasterizationSamples: 1 },
			colorBlendState: { attachments: [{ colorWriteMask: 15 }] },
			dynamicState: { dynamicStates: [0, 1] },
		});
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBeginRendering", renderArea: { offset: { x: 0, y: 0 }, extent: { width: W, height: H } }, layerCount: 1, viewMask: 0,
				colorAttachments: [{ imageView: view, imageLayout: 2, resolveMode: 0, resolveImageView: 0, loadOp: 1, storeOp: 0, clearValue: { color: { float32: [0, 1, 0, 1] } } }] },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: dp },
			{ c: "vkCmdSetViewport", viewports: [{ x: 0, y: 0, width: W, height: H, minDepth: 0, maxDepth: 1 }] },
			{ c: "vkCmdSetScissor", scissors: [{ offset: { x: 0, y: 0 }, extent: { width: W, height: H } }] },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: pl, firstSet: 0, descriptorSets: [set], dynamicOffsets: [256] },
			{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [vbo], offsets: [0] },
			{ c: "vkCmdPushConstants", layout: pl, stageFlags: 0x10, offset: 0, size: 16, values: [...red] },
			{ c: "vkCmdDraw", vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
			{ c: "vkCmdEndRendering" },
		] });
		f = (await cl.req({ op: "present", image: img, readback: 0 })).json;
		check(`${label} present without readback`, f.width === W && f.height === H);

		// (m) zero-copy groundwork: the image as an ImageBitmap
		const bmp = renderer.image(cl.conn, img);
		let bmpOk = "no bitmap";
		if (bmp) {
			const cv = new OffscreenCanvas(W, H);
			const g = cv.getContext("2d");
			g.drawImage(bmp, 0, 0);
			const d = g.getImageData(0, 0, W, H).data;
			bmpOk = `${at(d, W, 2, 2)} / ${at(d, W, 60, 60)}`;
		}
		check(`${label} dynamic rendering + renderer.image() bitmap`, bmpOk === "255,0,0,255 / 0,255,0,255", bmpOk);
		const st = renderer.stats;
		check(`${label} stats`, st.draws >= 5 && st.submits >= 5 && st.presents >= 5 && st.translations >= 3 && st.bytesWritten > 0 && st.bytesRead > 0 && st.pipelines > 3 && cl.conn.stats.messages > 50, JSON.stringify(st));
	}

	// (s) vkCmdUpdateBuffer between draws in one submit: each draw sees its own data
	{
		const rpL = nid(), fbL = nid();
		cl.post({ op: "vkCreateRenderPass", id: rpL, attachments: [{ format: 37, samples: 1, loadOp: 0, storeOp: 0 }], subpasses: [{ colorAttachments: [{ attachment: 0 }] }] });
		cl.post({ op: "vkCreateFramebuffer", id: fbL, renderPass: rpL, attachments: [view], width: W, height: H, layers: 1 });
		const cmds = [{ c: "vkCmdClearColorImage", image: img, color: { float32: [0, 0, 0, 1] }, ranges: [{ aspectMask: 1, levelCount: 1, layerCount: 1 }] }];
		const cols = [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1]];
		[1, 0.5, 0.25].forEach((sc, i) => {
			cmds.push(
				{ c: "vkCmdUpdateBuffer", dstBuffer: ubo, dstOffset: 256, data: [...u8(new Float32Array([sc, sc, 0, 0]))] },
				{ c: "vkCmdBeginRenderPass", renderPass: rpL, framebuffer: fbL, clearValues: [] },
				{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: pipe },
				{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: pl, firstSet: 0, descriptorSets: [set], dynamicOffsets: [256] },
				{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [vbo], offsets: [0] },
				{ c: "vkCmdPushConstants", layout: pl, stageFlags: 0x10, offset: 0, size: 16, values: [...u8(new Float32Array(cols[i]))] },
				{ c: "vkCmdDraw", vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
				{ c: "vkCmdEndRenderPass" },
			);
		});
		cl.post({ op: "vkQueueSubmit", cmds });
		const pu = (await cl.req({ op: "present", image: img, readback: 1 })).bin;
		check(`${label} updateBuffer between draws`, at(pu, W, 3, 3) === "255,0,0,255" && at(pu, W, 19, 19) === "0,255,0,255" && at(pu, W, 25, 25) === "0,0,255,255", `${at(pu, W, 3, 3)} / ${at(pu, W, 19, 19)} / ${at(pu, W, 25, 25)}`);
		// restore the scale the later checks use
		cl.post({ op: "writeBuffer", buffer: ubo, offset: 256 }, u8(new Float32Array([1, 1, 0, 0])));
	}

	// (t) vkCmdCopyBuffer with sizes/offsets that are not multiples of 4 changes no byte outside the range
	{
		const ca = nid(), cb2 = nid();
		cl.post({ op: "vkCreateBuffer", id: ca, size: 16, usage: 0x3 });
		cl.post({ op: "vkCreateBuffer", id: cb2, size: 16, usage: 0x3 });
		cl.post({ op: "writeBuffer", buffer: ca, offset: 0 }, new Uint8Array(16).map((_, i) => i));
		cl.post({ op: "writeBuffer", buffer: cb2, offset: 0 }, new Uint8Array(16).fill(0xee));
		cl.post({ op: "vkQueueSubmit", cmds: [{ c: "vkCmdCopyBuffer", srcBuffer: ca, dstBuffer: cb2, regions: [{ srcOffset: 0, dstOffset: 4, size: 6 }, { srcOffset: 1, dstOffset: 13, size: 2 }] }] });
		const cr2 = [...(await cl.req({ op: "readBuffer", buffer: cb2, offset: 0, size: 16 })).bin];
		const want = [0xee, 0xee, 0xee, 0xee, 0, 1, 2, 3, 4, 5, 0xee, 0xee, 0xee, 1, 2, 0xee];
		check(`${label} unaligned vkCmdCopyBuffer exact`, cr2.join() === want.join(), cr2.join());
	}

	// (u) two writable storage bindings of one buffer range, one dead by a spec constant
	if (label === "spirv") {
		const dm = nid(), ddsl = nid(), dpl = nid(), dp = nid(), dset = nid(), db = nid();
		cl.post({ op: "vkCreateShaderModule", id: dm }, shaderBytes("dead.comp"));
		cl.post({ op: "vkCreateDescriptorSetLayout", id: ddsl, bindings: [{ binding: 2, descriptorType: 7, descriptorCount: 1, stageFlags: 0x20 }, { binding: 3, descriptorType: 7, descriptorCount: 1, stageFlags: 0x20 }] });
		cl.post({ op: "vkCreatePipelineLayout", id: dpl, setLayouts: [ddsl] });
		cl.post({ op: "vkCreateComputePipelines", id: dp, layout: dpl, stage: { stage: 0x20, module: dm, name: "main", specializationInfo: { mapEntries: [{ constantID: 0, offset: 0, size: 4 }], data: [1, 0, 0, 0] } } });
		cl.post({ op: "vkCreateBuffer", id: db, size: 16, usage: 0x20 });
		cl.post({ op: "writeBuffer", buffer: db, offset: 0 }, new Uint8Array(16));
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: dset, layout: ddsl }] });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [2, 3].map((b) => ({ dstSet: dset, dstBinding: b, descriptorType: 7, bufferInfo: [{ buffer: db, offset: 0, range: 16 }] })) });
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 1, pipeline: dp },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 1, layout: dpl, firstSet: 0, descriptorSets: [dset] },
			{ c: "vkCmdDispatch", groupCountX: 1, groupCountY: 1, groupCountZ: 1 },
		] });
		const dv = new Uint32Array((await cl.req({ op: "readBuffer", buffer: db, offset: 0, size: 16 })).bin.buffer.slice(0, 16));
		check(`${label} dead aliased writable binding left out`, dv[0] === 9, `${dv[0]}`);
	}

	// (v) refused with its read-only buffers made read_write (an early return on
	// one's value before a barrier): made with them kept read-only, and right
	// with all three bindings in one buffer (the read-only ones copied aside)
	if (label === "spirv") {
		const em = nid(), edsl = nid(), epl = nid(), ep = nid(), eset = nid(), eb = nid();
		cl.post({ op: "vkCreateShaderModule", id: em }, shaderBytes("earlyro.comp"));
		cl.post({ op: "vkCreateDescriptorSetLayout", id: edsl, bindings: [0, 1, 2].map((b) => ({ binding: b, descriptorType: 7, descriptorCount: 1, stageFlags: 0x20 })) });
		cl.post({ op: "vkCreatePipelineLayout", id: epl, setLayouts: [edsl] });
		const made = await cl.req({ op: "vkCreateComputePipelines", id: ep, layout: epl, stage: { stage: 0x20, module: em, name: "main" } }).then(() => "made", (e) => e.message);
		check(`${label} read-only buffers kept where read_write is refused: pipeline made`, made === "made", made);
		// c.n = 2 at 0, a.v (3 groups of 64) at 256, d.v at 1024; group 2 returns early
		const init = new Uint32Array(512);
		init[0] = 2;
		for (let i = 0; i < 192; i++) init[64 + i] = 1000 + i;
		init.fill(7, 256);
		cl.post({ op: "vkCreateBuffer", id: eb, size: 2048, usage: 0x20 });
		cl.post({ op: "writeBuffer", buffer: eb, offset: 0 }, new Uint8Array(init.buffer));
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: eset, layout: edsl }] });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [[0, 0, 4], [1, 256, 768], [2, 1024, 1024]].map(([b, offset, range]) => ({ dstSet: eset, dstBinding: b, descriptorType: 7, bufferInfo: [{ buffer: eb, offset, range }] })) });
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 1, pipeline: ep },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 1, layout: epl, firstSet: 0, descriptorSets: [eset] },
			{ c: "vkCmdDispatch", groupCountX: 3, groupCountY: 1, groupCountZ: 1 },
		] });
		const ev = new Uint32Array((await cl.req({ op: "readBuffer", buffer: eb, offset: 1024, size: 1024 })).bin.buffer.slice(0, 1024));
		const bad = [];
		for (let g = 0; g < 192; g++) {
			const want = g < 128 ? 1000 + (g & ~63) + 63 - (g & 63) + 1 : 7;
			if (ev[g] !== want && bad.length < 4) bad.push(`d[${g}]=${ev[g]} (want ${want})`);
		}
		check(`${label} read-only buffers kept, bound with a writable range of the same buffer`, made === "made" && !bad.length && !cl.lost, bad.join(", ") || cl.lost);
	}

	// (n) occlusion queries: query 0 around the triangle, query 1 around nothing
	{
		const qp = nid(), qb = nid();
		cl.post({ op: "vkCreateQueryPool", id: qp, queryType: 0, queryCount: 2 });
		cl.post({ op: "vkCreateBuffer", id: qb, size: 32, usage: 0x2 });
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdResetQueryPool", queryPool: qp, firstQuery: 0, queryCount: 2 },
			{ c: "vkCmdBeginRenderPass", renderPass: rp, framebuffer: fb, clearValues: [{ color: { float32: [0, 0, 1, 1] } }] },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: pipe },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: pl, firstSet: 0, descriptorSets: [set], dynamicOffsets: [256] },
			{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [vbo], offsets: [0] },
			{ c: "vkCmdPushConstants", layout: pl, stageFlags: 0x10, offset: 0, size: 16, values: [...red] },
			{ c: "vkCmdBeginQuery", queryPool: qp, query: 0, flags: 0 },
			{ c: "vkCmdDraw", vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
			{ c: "vkCmdEndQuery", queryPool: qp, query: 0 },
			{ c: "vkCmdBeginQuery", queryPool: qp, query: 1, flags: 0 },
			{ c: "vkCmdEndQuery", queryPool: qp, query: 1 },
			{ c: "vkCmdEndRenderPass" },
			{ c: "vkCmdCopyQueryPoolResults", queryPool: qp, firstQuery: 0, queryCount: 2, dstBuffer: qb, dstOffset: 0, stride: 16, flags: 1 | 4 },
		] });
		const gr = await cl.req({ op: "getQueryPoolResults", queryPool: qp, firstQuery: 0, queryCount: 2 });
		const gv = new BigUint64Array(gr.bin.buffer.slice(gr.bin.byteOffset, gr.bin.byteOffset + 16));
		const cb = new BigUint64Array((await cl.req({ op: "readBuffer", buffer: qb, offset: 0, size: 32 })).bin.buffer.slice(0, 32));
		check(`${label} occlusion queries`, gv[0] === 1n && gv[1] === 0n && gr.json.available.join() === "1,1" && cb[0] > 0n && cb[1] === 1n && cb[2] === 0n && cb[3] === 1n, `get ${gv} avail ${gr.json.available} copy ${cb}`);
	}

	// (r) Flat only on the fragment input (as glslang and vkd3d emit it): the vertex outputs follow, first vertex wins
	if (label === "spirv") {
		const fv = nid(), ff = nid(), fpl = nid(), fpp = nid();
		cl.post({ op: "vkCreateShaderModule", id: fv }, shaderBytes("flat.vert"));
		cl.post({ op: "vkCreateShaderModule", id: ff }, shaderBytes("flat.frag"));
		cl.post({ op: "vkCreatePipelineLayout", id: fpl, setLayouts: [] });
		cl.post({
			op: "vkCreateGraphicsPipelines", id: fpp, layout: fpl, renderPass: rp, subpass: 0,
			stages: [{ stage: 1, module: fv, name: "main" }, { stage: 0x10, module: ff, name: "main" }],
			vertexInputState: { vertexBindingDescriptions: [{ binding: 0, stride: 8, inputRate: 0 }], vertexAttributeDescriptions: [{ location: 0, binding: 0, format: 103, offset: 0 }] },
			inputAssemblyState: { topology: 3 }, rasterizationState: { cullMode: 0 }, multisampleState: { rasterizationSamples: 1 }, colorBlendState: { attachments: [{ colorWriteMask: 15 }] },
			viewportState: { viewports: [{ x: 0, y: 0, width: W, height: H, minDepth: 0, maxDepth: 1 }], scissors: [{ offset: { x: 0, y: 0 }, extent: { width: W, height: H } }] },
		});
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBeginRenderPass", renderPass: rp, framebuffer: fb, clearValues: [{ color: { float32: [0, 0, 0, 1] } }] },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: fpp },
			{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [vbo], offsets: [0] },
			{ c: "vkCmdDraw", vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
			{ c: "vkCmdEndRenderPass" },
		] });
		const pf = (await cl.req({ op: "present", image: img, readback: 1 })).bin;
		check(`${label} flat fragment input, plain vertex output`, at(pf, W, 40, 2) === "255,0,0,255" && at(pf, W, 2, 40) === "255,0,0,255", `${at(pf, W, 40, 2)} / ${at(pf, W, 2, 40)}`);
	}

	// (q) a storage image declared without a format takes the bound view's (rgba16float)
	if (label === "spirv") {
		const si = nid(), siv = nid(), sm = nid(), sdsl = nid(), spl = nid(), sp = nid(), sset2 = nid(), sb = nid();
		cl.post({ op: "vkCreateImage", id: si, imageType: 1, format: 97, extent: { width: 2, height: 2, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x8 | 0x1 });
		cl.post({ op: "vkCreateImageView", id: siv, image: si, viewType: 1, format: 97, subresourceRange: { aspectMask: 1, levelCount: 1, layerCount: 1 } });
		cl.post({ op: "vkCreateShaderModule", id: sm }, shaderBytes("store.comp"));
		cl.post({ op: "vkCreateDescriptorSetLayout", id: sdsl, bindings: [{ binding: 0, descriptorType: 3, descriptorCount: 1, stageFlags: 0x20 }] });
		cl.post({ op: "vkCreatePipelineLayout", id: spl, setLayouts: [sdsl] });
		cl.post({ op: "vkCreateComputePipelines", id: sp, layout: spl, stage: { stage: 0x20, module: sm, name: "main" } });
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: sset2, layout: sdsl }] });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: sset2, dstBinding: 0, descriptorType: 3, imageInfo: [{ sampler: 0, imageView: siv, imageLayout: 1 }] }] });
		cl.post({ op: "vkCreateBuffer", id: sb, size: 256 * 2, usage: 0x2 });
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 1, pipeline: sp },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 1, layout: spl, firstSet: 0, descriptorSets: [sset2] },
			{ c: "vkCmdDispatch", groupCountX: 2, groupCountY: 2, groupCountZ: 1 },
			{ c: "vkCmdCopyImageToBuffer", srcImage: si, dstBuffer: sb, regions: [{ bufferOffset: 0, bufferRowLength: 0, imageSubresource: { aspectMask: 1, layerCount: 1 }, imageOffset: { x: 0, y: 0, z: 0 }, imageExtent: { width: 2, height: 2, depth: 1 } }] },
		] });
		const hb = new Uint16Array((await cl.req({ op: "readBuffer", buffer: sb, offset: 0, size: 32 })).bin.buffer.slice(0, 32));
		check(`${label} format-less storage image on rgba16float`, hb[0] === 0x3c00 && hb[1] === 0x3800 && hb[2] === 0 && hb[3] === 0x3c00 && hb[12] === 0x3c00, [...hb.slice(0, 4)].map((x) => x.toString(16)).join(","));
	}

	// (o) an input attachment written in subpass 0 and read in subpass 1
	if (label === "spirv") {
		const iA = nid(), iAv = nid(), iB = nid(), iBv = nid(), irp = nid(), ifb = nid(), p0 = nid(), fsv = nid(), iaf = nid(), idsl = nid(), ipl = nid(), ip = nid(), iset = nid();
		for (const [im, v2] of [[iA, iAv], [iB, iBv]]) {
			cl.post({ op: "vkCreateImage", id: im, imageType: 1, format: 37, extent: { width: W, height: H, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x10 | 0x80 | 0x1 });
			cl.post({ op: "vkCreateImageView", id: v2, image: im, viewType: 1, format: 37, subresourceRange: { aspectMask: 1, levelCount: 1, layerCount: 1 } });
		}
		cl.post({
			op: "vkCreateRenderPass", id: irp,
			attachments: [{ format: 37, samples: 1, loadOp: 1, storeOp: 0 }, { format: 37, samples: 1, loadOp: 1, storeOp: 0 }],
			subpasses: [{ colorAttachments: [{ attachment: 0 }] }, { inputAttachments: [{ attachment: 0 }], colorAttachments: [{ attachment: 1 }] }],
		});
		cl.post({ op: "vkCreateFramebuffer", id: ifb, renderPass: irp, attachments: [iAv, iBv], width: W, height: H, layers: 1 });
		const vp = { viewportState: { viewports: [{ x: 0, y: 0, width: W, height: H, minDepth: 0, maxDepth: 1 }], scissors: [{ offset: { x: 0, y: 0 }, extent: { width: W, height: H } }] } };
		cl.post({
			op: "vkCreateGraphicsPipelines", id: p0, layout: pl, renderPass: irp, subpass: 0, ...vp,
			stages: [{ stage: 1, module: vs, pName: "main" }, { stage: 0x10, module: fs, pName: "main" }],
			vertexInputState: { vertexBindingDescriptions: [{ binding: 0, stride: 8, inputRate: 0 }], vertexAttributeDescriptions: [{ location: 0, binding: 0, format: 103, offset: 0 }] },
			inputAssemblyState: { topology: 3 }, rasterizationState: { cullMode: 0 }, multisampleState: { rasterizationSamples: 1 }, colorBlendState: { attachments: [{ colorWriteMask: 15 }] },
		});
		cl.post({ op: "vkCreateShaderModule", id: fsv }, shaderBytes("fs.vert"));
		cl.post({ op: "vkCreateShaderModule", id: iaf }, shaderBytes("ia.frag"));
		cl.post({ op: "vkCreateDescriptorSetLayout", id: idsl, bindings: [{ binding: 0, descriptorType: 10, descriptorCount: 1, stageFlags: 0x10 }] });
		cl.post({ op: "vkCreatePipelineLayout", id: ipl, setLayouts: [idsl] });
		cl.post({
			op: "vkCreateGraphicsPipelines", id: ip, layout: ipl, renderPass: irp, subpass: 1, ...vp,
			stages: [{ stage: 1, module: fsv, pName: "main" }, { stage: 0x10, module: iaf, pName: "main" }],
			vertexInputState: {}, inputAssemblyState: { topology: 3 }, rasterizationState: { cullMode: 0 }, multisampleState: { rasterizationSamples: 1 }, colorBlendState: { attachments: [{ colorWriteMask: 15 }] },
		});
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: iset, layout: idsl }] });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: iset, dstBinding: 0, descriptorType: 10, imageInfo: [{ sampler: 0, imageView: iAv, imageLayout: 5 }] }] });
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBeginRenderPass", renderPass: irp, framebuffer: ifb, clearValues: [{ color: { float32: [0, 1, 0, 1] } }, { color: { float32: [0, 0, 0, 1] } }] },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: p0 },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: pl, firstSet: 0, descriptorSets: [set], dynamicOffsets: [256] },
			{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [vbo], offsets: [0] },
			{ c: "vkCmdPushConstants", layout: pl, stageFlags: 0x10, offset: 0, size: 16, values: [...red] },
			{ c: "vkCmdDraw", vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
			{ c: "vkCmdNextSubpass", contents: 0 },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: ip },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: ipl, firstSet: 0, descriptorSets: [iset] },
			{ c: "vkCmdDraw", vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
			{ c: "vkCmdEndRenderPass" },
		] });
		const pi = (await cl.req({ op: "present", image: iB, readback: 1 })).bin;
		check(`${label} input attachment (subpass 1 reads subpass 0, swizzled)`, at(pi, W, 2, 2) === "0,0,255,255" && at(pi, W, 60, 60) === "0,255,0,255", `${at(pi, W, 2, 2)} / ${at(pi, W, 60, 60)}`);
	}

	// errors answer with err and do not stop the loop
	let err = "";
	try {
		await cl.req({ op: "readBuffer", buffer: 9999, offset: 0, size: 4 });
	} catch (e) {
		err = e.message;
	}
	const after = await cl.req({ op: "readBuffer", buffer: buf, offset: 0, size: 4 });
	check(`${label} error reply then continue`, err.includes("9999") && after.bin.length === 4, err);

	if (label === "fake") {
		// (p) many draws per submit: per-draw descriptor set binds (dynamic offsets) and push constants
		const N = 2000;
		const cmds = [
			{ c: "vkCmdBeginRenderPass", renderPass: rp, framebuffer: fb, clearValues: [{ color: { float32: [0, 0, 1, 1] } }] },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: pipe },
			{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [vbo], offsets: [0] },
		];
		for (let i = 0; i < N; i++) {
			cmds.push(
				{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: pl, firstSet: 0, descriptorSets: [set], dynamicOffsets: [i & 1 ? 256 : 0] },
				{ c: "vkCmdPushConstants", layout: pl, stageFlags: 0x10, offset: 0, size: 16, values: [...u8(new Float32Array([i / N, 0, 0, 1]))] },
				{ c: "vkCmdDraw", vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
			);
		}
		cmds.push({ c: "vkCmdEndRenderPass" });
		const times = [];
		cl.chunky = false;
		for (let run = 0; run < 9; run++) {
			const e0 = renderer.stats.encodeMs;
			const p0 = renderer.stats.parseMs;
			const t0 = performance.now();
			await cl.req({ op: "vkQueueSubmit", cmds });
			times.push({ encode: renderer.stats.encodeMs - e0, parse: renderer.stats.parseMs - p0, wall: performance.now() - t0 });
		}
		const best = times.slice(1).sort((a, b) => a.encode + a.parse - b.encode - b.parse)[0];
		cl.chunky = true;
		const per1k = (best.encode * 1000) / N;
		perf = `encode ${per1k.toFixed(2)} ms, parse ${((best.parse * 1000) / N).toFixed(2)} ms per 1000 draws (wall incl. client encoding, chunked feed and GPU ${((best.wall * 1000) / N).toFixed(2)} ms)`;
		check(`${label} perf: ${perf}`, per1k < 50);
	}

	cl.post({ op: "destroy", ids: [buf, img, view, out, out2] });
	await cl.req({ op: "sync" });

	// a submit WebGPU refuses (none of it runs): the guest's device is lost,
	// the reason in a {"lost"} frame, pending requests answered with err
	cl.post({ op: "vkQueueSubmit", cmds: [
		{ c: "vkCmdBindPipeline", pipelineBindPoint: 1, pipeline: cpipe },
		{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 1, layout: cpl, firstSet: 0, descriptorSets: [cset], dynamicOffsets: [] },
		{ c: "vkCmdDispatch", groupCountX: 1 << 20, groupCountY: 1, groupCountZ: 1 },
	] });
	let serr = "";
	try {
		await cl.req({ op: "sync" });
	} catch (e) {
		serr = e.message;
	}
	check(`${label} refused submit loses the device`, /vkQueueSubmit/.test(cl.lost) && /vkQueueSubmit/.test(serr) && cl.closedByHost === 1 && logs.some((l) => l.startsWith(`[${label}] kwvk: vkQueueSubmit:`)), `lost ${cl.lost} | sync ${serr} | closed ${cl.closedByHost}`);
	cl.conn.close();
	await loud(renderer, label, shaderBytes);
	await flipHint(renderer, label, shaderBytes);
}

/**
 * The hello's engineName (vk/PROTOCOL.md, Amendments, "Y flip hint"): a
 * graphics pipeline is made at creation for the orientation its app is
 * expected to draw with (wgpu-hal: negative viewport heights, with
 * dynamic viewports, as wgpu does), the other is a variant made at the
 * draw that needs it; both from the module the pipeline keeps after the
 * app destroyed it. Each engine on a connection of its own.
 */
async function flipHint(renderer, label, shaderBytes) {
	const W = 64, H = 64;
	const at = (b, x, y) => [...b.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)].join(",");
	const up = { x: 0, y: H, width: W, height: -H, minDepth: 0, maxDepth: 1 };
	const down = { x: 0, y: 0, width: W, height: H, minDepth: 0, maxDepth: 1 };
	for (const engine of ["wgpu-hal", undefined, "vkcube"]) {
		const name = `${label} y flip hint (engine ${engine ?? "none"})`;
		const cl = new Client(renderer);
		let id = 1;
		const nid = () => id++;
		await cl.req({ op: "hello", version: 1, subgroupSize: 0, ...(engine ? { engineName: engine } : {}) });
		const img = nid(), view = nid(), rp = nid(), fb = nid(), vs = nid(), fs = nid(), dsl = nid(), pl = nid(), pipe = nid(), set = nid(), ubo = nid(), vbo = nid();
		cl.post({ op: "vkCreateImage", id: img, imageType: 1, format: 37, extent: { width: W, height: H, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, tiling: 0, usage: 0x10 | 0x1 | 0x4 });
		cl.post({ op: "vkCreateImageView", id: view, image: img, viewType: 1, format: 37, subresourceRange: { aspectMask: 1, baseMipLevel: 0, levelCount: 1, baseArrayLayer: 0, layerCount: 1 } });
		cl.post({ op: "vkCreateRenderPass", id: rp, attachments: [{ format: 37, samples: 1, loadOp: 1, storeOp: 0 }], subpasses: [{ colorAttachments: [{ attachment: 0, layout: 2 }] }] });
		cl.post({ op: "vkCreateFramebuffer", id: fb, renderPass: rp, attachments: [view], width: W, height: H, layers: 1 });
		cl.post({ op: "vkCreateShaderModule", id: vs }, shaderBytes("tri.vert"));
		cl.post({ op: "vkCreateShaderModule", id: fs }, shaderBytes("tri.frag"));
		cl.post({ op: "vkCreateDescriptorSetLayout", id: dsl, bindings: [{ binding: 0, descriptorType: 6, descriptorCount: 1, stageFlags: 1 }] });
		cl.post({ op: "vkCreatePipelineLayout", id: pl, setLayouts: [dsl], pushConstantRanges: [{ stageFlags: 0x10, offset: 0, size: 16 }] });
		cl.post({ op: "vkCreateBuffer", id: ubo, size: 16, usage: 0x10 });
		cl.post({ op: "writeBuffer", buffer: ubo, offset: 0 }, u8(new Float32Array([1, 1, 0, 0])));
		cl.post({ op: "vkCreateBuffer", id: vbo, size: 24, usage: 0x80 });
		cl.post({ op: "writeBuffer", buffer: vbo, offset: 0 }, u8(new Float32Array([-1, -1, 1, -1, -1, 1])));
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: set, layout: dsl }] });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: set, dstBinding: 0, dstArrayElement: 0, descriptorType: 6, bufferInfo: [{ buffer: ubo, offset: 0, range: 16 }] }], descriptorCopies: [] });
		const st = cl.conn.stats;
		const p0 = st.pipelines;
		await cl.req({
			op: "vkCreateGraphicsPipelines", id: pipe, layout: pl, renderPass: rp, subpass: 0,
			stages: [{ stage: 1, module: vs, pName: "main" }, { stage: 0x10, module: fs, pName: "main" }],
			vertexInputState: { vertexBindingDescriptions: [{ binding: 0, stride: 8, inputRate: 0 }], vertexAttributeDescriptions: [{ location: 0, binding: 0, format: 103, offset: 0 }] },
			inputAssemblyState: { topology: 3 },
			viewportState: { viewportCount: 1, scissorCount: 1 },
			rasterizationState: { cullMode: 0, frontFace: 0 },
			multisampleState: { rasterizationSamples: 1 },
			colorBlendState: { attachments: [{ colorWriteMask: 15 }] },
			dynamicState: { dynamicStates: [0, 1] },
		});
		const made = st.pipelines - p0;
		// as wgpu does: the modules go once the pipeline is made
		cl.post({ op: "destroy", ids: [vs, fs] });
		const p1 = st.pipelines, t1 = st.translations;
		const draw = async (vp) => {
			cl.post({ op: "vkQueueSubmit", cmds: [
				{ c: "vkCmdBeginRenderPass", renderPass: rp, framebuffer: fb, renderArea: { offset: { x: 0, y: 0 }, extent: { width: W, height: H } }, clearValues: [{ color: { float32: [0, 0, 1, 1] } }] },
				{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: pipe },
				{ c: "vkCmdSetViewport", viewports: [vp] },
				{ c: "vkCmdSetScissor", scissors: [{ offset: { x: 0, y: 0 }, extent: { width: W, height: H } }] },
				{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: pl, firstSet: 0, descriptorSets: [set], dynamicOffsets: [] },
				{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [vbo], offsets: [0] },
				{ c: "vkCmdPushConstants", layout: pl, stageFlags: 0x10, offset: 0, size: 16, values: [...u8(new Float32Array([1, 0, 0, 1]))] },
				{ c: "vkCmdDraw", vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
				{ c: "vkCmdEndRenderPass" },
			] });
			const f = (await cl.req({ op: "present", image: img, readback: 1 })).bin;
			// (-1,-1),(1,-1),(-1,1): the upper-left half of the image, the lower-left one with a negative height
			const pix = `${at(f, 50, 2)} / ${at(f, 50, 60)}`;
			return { pix, ok: pix === (vp.height < 0 ? "0,0,255,255 / 255,0,0,255" : "255,0,0,255 / 0,0,255,255"), pipes: st.pipelines - p1, trans: st.translations - t1 };
		};
		const first = engine === "wgpu-hal" ? up : down;
		const a = await draw(first);
		check(`${name}: made at creation for ${first.height < 0 ? "negative" : "positive"} heights, drawn with them`, made === 1 && a.ok && a.pipes === 0 && a.trans === 0, `made ${made}; ${a.pix}; at the draw: pipelines ${a.pipes}, translations ${a.trans}`);
		const b = await draw(first === up ? down : up);
		check(`${name}: the other orientation made at its draw, modules destroyed`, b.ok && b.pipes === 1 && b.trans === 1, `${b.pix}; at the draws: pipelines ${b.pipes}, translations ${b.trans}`);
		cl.conn.close();
	}
}

/**
 * Failures the guest must see: pipelines the host cannot make answer err
 * (the ICD returns a VkResult) or "unusable"; what no reply can report
 * (an unusable pipeline bound, an object whose creation failed used in a
 * submit, a command that cannot be encoded) loses the device. Each case
 * on a connection of its own.
 */
async function loud(renderer, label, shaderBytes) {
	const computePipe = async (name, extra = {}) => {
		const cl = new Client(renderer);
		cl.chunky = false;
		cl.post({ op: "vkCreateShaderModule", id: 1 }, shaderBytes(name));
		cl.post({ op: "vkCreateDescriptorSetLayout", id: 2, bindings: [{ binding: 0, descriptorType: 7, descriptorCount: 1, stageFlags: 0x20 }] });
		cl.post({ op: "vkCreatePipelineLayout", id: 3, setLayouts: [2], pushConstantRanges: [] });
		let err;
		let reply;
		try {
			reply = await cl.req({ op: "vkCreateComputePipelines", id: 4, layout: 3, stage: { stage: 0x20, module: 1, pName: "main" }, ...extra });
		} catch (e) {
			err = e;
		}
		return { cl, err, reply };
	};
	// a barrier in non-uniform control flow: Tint's uniformity analysis refuses the WGSL
	{
		const { cl, err } = await computePipe("barrier.comp");
		check(`${label} pipeline refused: barrier in non-uniform control flow`, err && /uniform/.test(err.message) && /WGSL \d+:\d+/.test(err.message) && err.result === undefined && !cl.closedByHost, err?.message ?? "created");
		// the connection goes on: a good pipeline after it
		const ok = await cl.req({ op: "vkCreateComputePipelines", id: 5, layout: 3, stage: { stage: 0x20, module: 6, pName: "main" } }).then(() => "made", (e) => e.message);
		check(`${label} refused pipeline: the connection goes on`, /no shader 6/.test(ok) && !cl.closedByHost, ok);
		cl.conn.close();
	}
	// 512 invocations sharing memory on a 256-invocation device: no split possible
	// 512 invocations sharing memory on a 256-invocation device: the fake
	// translator refuses it; the real one runs 2 virtual invocations each
	if (renderer.device.limits.maxComputeInvocationsPerWorkgroup < 512 && label === "fake") {
		const { cl, err } = await computePipe("shared512.comp");
		check(`${label} pipeline refused: 512-wide workgroup with shared memory`, err && /workgroup size 512/.test(err.message), err?.message ?? "created");
		cl.conn.close();
	}
	if (renderer.device.limits.maxComputeInvocationsPerWorkgroup < 512 && label === "spirv") {
		const { cl, err } = await computePipe("shared512.comp");
		let sum = "no pipeline";
		if (!err) {
			cl.post({ op: "vkCreateBuffer", id: 10, size: 2048, usage: 0x20 });
			cl.post({ op: "writeBuffer", buffer: 10, offset: 0 }, new Uint8Array(new Float32Array(512).map((_, i) => i).buffer));
			cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: 11, layout: 2 }] });
			cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: 11, dstBinding: 0, descriptorType: 7, bufferInfo: [{ buffer: 10, offset: 0, range: 2048 }] }] });
			cl.post({ op: "vkQueueSubmit", cmds: [
				{ c: "vkCmdBindPipeline", pipelineBindPoint: 1, pipeline: 4 },
				{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 1, layout: 3, firstSet: 0, descriptorSets: [11] },
				{ c: "vkCmdDispatch", groupCountX: 1, groupCountY: 1, groupCountZ: 1 },
			] });
			sum = new Float32Array((await cl.req({ op: "readBuffer", buffer: 10, offset: 0, size: 4 })).bin.buffer.slice(0, 4))[0];
		}
		check(`${label} 512-wide workgroup with shared memory: made (virtual invocations), sum right`, !err && sum === 130816, err?.message ?? `sum ${sum}`);
		cl.conn.close();
		const neg = await computePipe("shared512fn.comp");
		check(`${label} pipeline refused: 512-wide workgroup, barrier in another function`, neg.err && /workgroup size 512.*virtual invocations: a barrier in a function/.test(neg.err.message), neg.err?.message ?? "created");
		neg.cl.conn.close();
	}
	// the subgroup size (hello): an ICD that asks nothing (older ones) reports
	// 1, 0 takes the host's, a power of two its own; compute stages get the
	// subgroup builtins as subgroups of exactly that size in local index order
	if (label === "spirv") {
		for (const [ask, want] of [[undefined, 1], [0, VK_SUBGROUP_SIZE], [8, 8], [3, VK_SUBGROUP_SIZE]]) {
			const cl = new Client(renderer);
			cl.chunky = false;
			const h = (await cl.req({ op: "hello", version: 1, ...(ask === undefined ? {} : { subgroupSize: ask }) })).json;
			cl.post({ op: "vkCreateShaderModule", id: 1 }, shaderBytes("sgids.comp"));
			cl.post({ op: "vkCreateDescriptorSetLayout", id: 2, bindings: [{ binding: 0, descriptorType: 7, descriptorCount: 1, stageFlags: 0x20 }] });
			cl.post({ op: "vkCreatePipelineLayout", id: 3, setLayouts: [2], pushConstantRanges: [] });
			const err = await cl.req({ op: "vkCreateComputePipelines", id: 4, layout: 3, stage: { stage: 0x20, module: 1, pName: "main" } }).then(() => undefined, (e) => e);
			let bad = err ? err.message : "";
			if (!err) {
				cl.post({ op: "vkCreateBuffer", id: 10, size: 512, usage: 0x20 });
				cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: 11, layout: 2 }] });
				cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: 11, dstBinding: 0, descriptorType: 7, bufferInfo: [{ buffer: 10, offset: 0, range: 512 }] }] });
				cl.post({ op: "vkQueueSubmit", cmds: [
					{ c: "vkCmdBindPipeline", pipelineBindPoint: 1, pipeline: 4 },
					{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 1, layout: 3, firstSet: 0, descriptorSets: [11] },
					{ c: "vkCmdDispatch", groupCountX: 2, groupCountY: 1, groupCountZ: 1 },
				] });
				const v = new Uint32Array((await cl.req({ op: "readBuffer", buffer: 10, offset: 0, size: 512 })).bin.buffer.slice(0, 512));
				const exp = (i) => want * 1000000 + Math.ceil(64 / want) * 10000 + Math.floor((i % 64) / want) * 100 + ((i % 64) % want);
				const i = v.findIndex((x, k) => x !== exp(k));
				if (i >= 0) bad = `v[${i}] ${v[i]} != ${exp(i)}`;
			}
			check(`${label} subgroup size asked ${ask}: hello says ${want}, the builtins follow it`, h.subgroupSize === want && !bad, `hello ${h.subgroupSize}; ${bad}`);
			cl.conn.close();
		}
	}
	if (label !== "fake") return;
	// a graphics pipeline with an adjacency topology: refused with VK_ERROR_FEATURE_NOT_PRESENT (-8)
	{
		const cl = new Client(renderer);
		cl.chunky = false;
		cl.post({ op: "vkCreateShaderModule", id: 1 }, shaderBytes("tri.vert"));
		cl.post({ op: "vkCreatePipelineLayout", id: 3, setLayouts: [], pushConstantRanges: [] });
		const err = await cl.req({ op: "vkCreateGraphicsPipelines", id: 4, layout: 3, stages: [{ stage: 1, module: 1, pName: "main" }], inputAssemblyState: { topology: 8 } }).then(() => undefined, (e) => e);
		check("fake pipeline refused: adjacency topology (VK_ERROR_FEATURE_NOT_PRESENT)", err && err.result === -8 && /topology 8/.test(err.message), err ? `${err.message} (${err.result})` : "created");
		cl.conn.close();
	}
	// a pipeline declaring a 1D-array storage image: made "unusable"; binding it in a submit loses the device
	{
		const { cl, err, reply } = await computePipe("arr1d.comp");
		check("fake pipeline unusable: 1D-array storage image", !err && /_1d_array/.test(reply?.json?.unusable), err?.message ?? JSON.stringify(reply?.json));
		const serr = await cl.req({ op: "vkQueueSubmit", cmds: [{ c: "vkCmdBindPipeline", pipelineBindPoint: 1, pipeline: 4 }, { c: "vkCmdDispatch", groupCountX: 1 }] }).then(() => "ran", (e) => e.message);
		check("fake unusable pipeline bound: device lost", /cannot run/.test(cl.lost) && /cannot run/.test(serr) && cl.closedByHost === 1, `lost ${cl.lost} | submit ${serr}`);
	}
	// an image whose creation failed (no reply to tell): its first use in a submit loses the device, naming the cause
	{
		const cl = new Client(renderer);
		cl.chunky = false;
		const lost0 = renderer.stats.lost;
		cl.post({ op: "vkCreateImage", id: 1, imageType: 1, format: 9999, extent: { width: 4, height: 4, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x2 });
		cl.post({ op: "vkQueueSubmit", cmds: [{ c: "vkCmdClearColorImage", image: 1, color: { float32: [1, 0, 0, 1] }, ranges: [{ aspectMask: 1, levelCount: 1, layerCount: 1 }] }] });
		const serr = await cl.req({ op: "sync" }).then(() => "answered", (e) => e.message);
		check("fake failed creation used: device lost, the cause named", /failed at its creation \(vkCreateImage: unsupported image format 9999\)/.test(cl.lost) && serr !== "answered" && cl.closedByHost === 1 && renderer.stats.lost === lost0 + 1, `lost ${cl.lost} | sync ${serr}`);
	}
	// a request without a reply that fails (a write to no buffer): device lost
	{
		const cl = new Client(renderer);
		cl.chunky = false;
		cl.post({ op: "writeBuffer", buffer: 77, offset: 0 }, new Uint8Array(8));
		const serr = await cl.req({ op: "sync" }).then(() => "answered", (e) => e.message);
		check("fake failed writeBuffer: device lost", /writeBuffer: no buffer 77/.test(cl.lost) && serr !== "answered" && cl.closedByHost === 1, `lost ${cl.lost} | sync ${serr}`);
	}
}

// --- texel buffers (vk/PROTOCOL.md, Amendments, "Texel buffers"): views of
// several formats at offsets off the storage alignment, a storage texel
// buffer written and read back, refused formats, a stage out of storage
// buffers, the hello's formats -------------------------------------------------
async function texelCases(device, adapter, translatorP, spirvUrls) {
	const fakeR = new VkRenderer({ device, adapter, shaders: fakeTranslator, log: (l) => log(`[texel] ${l}`) });
	const fresh = (r) => {
		const cl = new Client(r);
		cl.chunky = false;
		return cl;
	};
	const sync = (cl) => cl.req({ op: "sync" }).then(() => "answered", (e) => e.message);
	const h = (await fresh(fakeR).req({ op: "hello", version: 1 })).json;
	const tb = h.texelBuffers || {};
	check("texel: hello lists texel buffer formats and maxElements", tb.formats?.[122] === 1 && tb.formats?.[9] === 3 && tb.formats?.[109] === 3 && tb.formats?.[98] === 7 && !tb.formats?.[43] && tb.maxElements >= 65536, JSON.stringify(tb).slice(0, 200));
	// a stage with every storage buffer slot taken and a texel buffer more: refused, named
	{
		const lim = h.limits.maxStorageBuffersPerShaderStage;
		const bindings = [];
		for (let b = 0; b < lim; b++) bindings.push({ set: 0, binding: b, group: 0, wgslBinding: 2 * b, kind: "storage" });
		bindings.push({ set: 0, binding: lim, group: 0, wgslBinding: 2 * lim, kind: "read-only-storage", texel: "data" }, { set: 0, binding: lim, group: 0, wgslBinding: 2 * lim + 1, kind: "uniform", texel: "params" });
		FAKE["many.comp"] = () => ({ wgsl: "@compute @workgroup_size(1) fn main() {}", bindings });
		const cl = fresh(fakeR);
		cl.post({ op: "vkCreateShaderModule", id: 1 }, new TextEncoder().encode("FAKE:many.comp"));
		cl.post({ op: "vkCreateDescriptorSetLayout", id: 2, bindings: bindings.filter((b) => b.texel !== "params").map((b) => ({ binding: b.binding, descriptorType: b.texel ? 4 : 7, descriptorCount: 1, stageFlags: 0x20 })) });
		cl.post({ op: "vkCreatePipelineLayout", id: 3, setLayouts: [2], pushConstantRanges: [] });
		const err = await cl.req({ op: "vkCreateComputePipelines", id: 4, layout: 3, stage: { stage: 0x20, module: 1, pName: "main" } }).then(() => undefined, (e) => e);
		check(`texel: a compute stage with ${lim} storage buffers and a texel buffer refused, named`, err && new RegExp(`compute stage needs ${lim + 1} storage and 1 uniform buffers, 1 texel buffers taking one of each, over the device's maxStorageBuffersPerShaderStage \\(${lim}\\)`).test(err.message) && !cl.closedByHost, err?.message ?? "created");
		cl.conn.close();
	}
	// a view of a format that is not a texel buffer format (R8G8B8A8_SRGB): its creation fails, a write of it loses the device
	{
		const cl = fresh(fakeR);
		cl.post({ op: "vkCreateBuffer", id: 10, size: 1024, usage: 0x4 });
		cl.post({ op: "vkCreateBufferView", id: 11, buffer: 10, format: 43, offset: 0, range: -1 });
		cl.post({ op: "vkCreateDescriptorSetLayout", id: 2, bindings: [{ binding: 0, descriptorType: 4, descriptorCount: 1, stageFlags: 0x20 }] });
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: 5, layout: 2 }] });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: 5, dstBinding: 0, descriptorType: 4, texelBufferView: [11] }] });
		const serr = await sync(cl);
		check("texel: a view of R8G8B8A8_SRGB refused, its write loses the device, named", /format 43 is not a texel buffer format/.test(cl.lost) && serr !== "answered", `lost ${cl.lost}`);
	}
	// B10G11R11_UFLOAT is a uniform texel buffer format only: as a storage texel buffer descriptor it loses the device
	{
		const cl = fresh(fakeR);
		cl.post({ op: "vkCreateBuffer", id: 10, size: 1024, usage: 0x8 });
		cl.post({ op: "vkCreateBufferView", id: 11, buffer: 10, format: 122, offset: 0, range: -1 });
		cl.post({ op: "vkCreateDescriptorSetLayout", id: 2, bindings: [{ binding: 0, descriptorType: 5, descriptorCount: 1, stageFlags: 0x20 }] });
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: 5, layout: 2 }] });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: 5, dstBinding: 0, descriptorType: 5, texelBufferView: [11] }] });
		const serr = await sync(cl);
		check("texel: B10G11R11_UFLOAT as a storage texel buffer loses the device, named", /format 122 is not a storage texel buffer format/.test(cl.lost) && serr !== "answered", `lost ${cl.lost}`);
	}
	if (!translatorP) {
		log("skip texel buffer runs (no translator or glslangValidator)");
		return;
	}
	const tr = await translatorP;
	const renderer = new VkRenderer({ device, adapter, shaders: tr, log: (l) => log(`[texel] ${l}`) });
	const spv = {};
	for (const name of ["tbfetch.comp", "tbstore.comp"]) spv[name] = new Uint8Array(await (await fetch(spirvUrls[name])).arrayBuffer());
	const f2h = (v) => {
		const u = new Uint32Array(new Float32Array([v]).buffer)[0];
		return v === 0 ? 0 : ((u >>> 16) & 0x8000) | ((((u >>> 23) & 255) - 112) << 10) | ((u >>> 13) & 1023);
	};
	const h2f = (h) => {
		const e = (h >> 10) & 31, m = h & 1023;
		const v = e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15);
		return h & 0x8000 ? -v : v;
	};
	// fetches: one buffer, views of several formats at offsets that are multiples of 16 but not of 256
	{
		const cl = fresh(renderer);
		cl.post({ op: "vkCreateShaderModule", id: 1 }, spv["tbfetch.comp"]);
		cl.post({ op: "vkCreateDescriptorSetLayout", id: 2, bindings: [0, 1, 2, 3].map((b) => ({ binding: b, descriptorType: b < 3 ? 4 : 7, descriptorCount: 1, stageFlags: 0x20 })) });
		cl.post({ op: "vkCreatePipelineLayout", id: 3, setLayouts: [2], pushConstantRanges: [] });
		const perr = await cl.req({ op: "vkCreateComputePipelines", id: 4, layout: 3, stage: { stage: 0x20, module: 1, pName: "main" } }).then(() => undefined, (e) => e.message);
		check("texel: a pipeline fetching three texel buffers is made", !perr, perr);
		const bytes = new Uint8Array(8192).map((_, j) => (j * 37 + 11) & 255);
		const dv = new DataView(bytes.buffer);
		const halves = [1.5, -2.25, 0.125, 1000, -0.5, 3, 7.75, -64, 0.25, 2, 12, -1, 5, 6, 0.75, 9];
		halves.forEach((v, j) => dv.setUint16(4496 + 2 * j, f2h(v), true));
		for (let j = 0; j < 24; j++) dv.setFloat32(16 + 4 * j, j * 1.25 - 7, true);
		cl.post({ op: "vkCreateBuffer", id: 10, size: 8192, usage: 0x4 });
		cl.post({ op: "writeBuffer", buffer: 10, offset: 0 }, bytes);
		cl.post({ op: "vkCreateBuffer", id: 11, size: 400, usage: 0x20 });
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: 5, layout: 2 }] });
		const u8at = (o) => bytes[o], s8at = (o) => (bytes[o] << 24) >> 24;
		// [float view, int view, uint view]: [format, offset, range, expected element k (count from the range)]
		const runs = [
			[[9, 4096 + 400, 6, (o, k) => [u8at(o + k) / 255, 0, 0, 1]], [42, 272, 32, (o, k) => [0, 1, 2, 3].map((c) => s8at(o + 4 * k + c))], [74, 16, 10, (o, k) => [dv.getUint16(o + 2 * k, true), 0, 0, 1]]],
			[[83, 4496, 32, (o, k) => [h2f(dv.getUint16(o + 4 * k, true)), h2f(dv.getUint16(o + 4 * k + 2, true)), 0, 1]], [75, 4112, 14, (o, k) => [dv.getInt16(o + 2 * k, true), 0, 0, 1]], [104, 16, 96, (o, k) => [0, 1, 2].map((c) => dv.getUint32(o + 12 * k + 4 * c, true)).concat(1)]],
			[[106, 16, 96, (o, k) => [0, 1, 2].map((c) => dv.getFloat32(o + 12 * k + 4 * c, true)).concat(1)], [99, 8000, -1, (o, k) => [dv.getInt32(o + 4 * k, true), 0, 0, 1]], [41, 4352, 20, (o, k) => [0, 1, 2, 3].map((c) => bytes[o + 4 * k + c])]],
			[[44, 256, 32, (o, k) => [2, 1, 0, 3].map((c) => bytes[o + 4 * k + c] / 255)], [14, 4097 + 15, 5, (o, k) => [s8at(o + k), 0, 0, 1]], [98, 8176, -1, (o, k) => [dv.getUint32(o + 4 * k, true), 0, 0, 1]]],
		];
		const SIZE = { 9: 1, 42: 4, 74: 2, 83: 4, 75: 2, 104: 12, 106: 12, 99: 4, 41: 4, 44: 4, 14: 1, 98: 4 };
		let id = 20;
		const bad = [];
		for (const views of runs) {
			const ids = views.map(([fmt, offset, range]) => {
				cl.post({ op: "vkCreateBufferView", id: id, buffer: 10, format: fmt, offset, range });
				return id++;
			});
			cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [
				{ dstSet: 5, dstBinding: 0, descriptorType: 4, descriptorCount: 3, texelBufferView: ids },
				{ dstSet: 5, dstBinding: 3, descriptorType: 7, bufferInfo: [{ buffer: 11, offset: 0, range: -1 }] },
			] });
			cl.post({ op: "vkQueueSubmit", cmds: [
				{ c: "vkCmdBindPipeline", pipelineBindPoint: 1, pipeline: 4 },
				{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 1, layout: 3, firstSet: 0, descriptorSets: [5], dynamicOffsets: [] },
				{ c: "vkCmdDispatch", groupCountX: 1, groupCountY: 1, groupCountZ: 1 },
			] });
			const got = await cl.req({ op: "readBuffer", buffer: 11, offset: 0, size: 400 }).then((r) => r.bin, (e) => (bad.push(e.message), undefined));
			if (!got) break;
			const gv = new DataView(got.buffer, got.byteOffset, got.length);
			views.forEach(([fmt, offset, range, want], slot) => {
				const count = Math.floor((range === -1 ? 8192 - offset : range) / SIZE[fmt]);
				const n = gv.getInt32(384 + 4 * slot, true);
				if (n !== count) bad.push(`format ${fmt}: size ${n} != ${count}`);
				for (let k = 0; k < 8; k++) {
					const w = k < count ? want(offset, k) : [0, 0, 0, 0];
					for (let c = 0; c < 4; c++) {
						const at = slot * 128 + k * 16 + c * 4;
						const g = slot === 0 ? gv.getFloat32(at, true) : slot === 1 ? gv.getInt32(at, true) : gv.getUint32(at, true);
						const ok = slot === 0 ? Math.abs(g - w[c]) <= 1e-6 * Math.max(1, Math.abs(w[c])) : g === w[c];
						if (!ok && bad.length < 6) bad.push(`format ${fmt} at ${offset} element ${k}.${c}: ${g} != ${w[c]}`);
					}
				}
			});
		}
		check("texel: fetches of 12 formats at offsets off the storage alignment (4496, 272, 4112, 8176, ...), sizes, zeros past the count", !bad.length && !cl.closedByHost, `${bad.join(", ")} | lost ${cl.lost}`);
		cl.conn.close();
	}
	// a storage texel buffer written by compute (RGBA32F, then RGBA8 at an offset off the alignment), read back; the bytes around the view kept
	{
		const cl = fresh(renderer);
		cl.post({ op: "vkCreateShaderModule", id: 1 }, spv["tbstore.comp"]);
		cl.post({ op: "vkCreateDescriptorSetLayout", id: 2, bindings: [{ binding: 0, descriptorType: 4, descriptorCount: 1, stageFlags: 0x20 }, { binding: 1, descriptorType: 5, descriptorCount: 1, stageFlags: 0x20 }] });
		cl.post({ op: "vkCreatePipelineLayout", id: 3, setLayouts: [2], pushConstantRanges: [] });
		const perr = await cl.req({ op: "vkCreateComputePipelines", id: 4, layout: 3, stage: { stage: 0x20, module: 1, pName: "main" } }).then(() => undefined, (e) => e.message);
		const src = new Float32Array(32).map((_, j) => j / 64 - 0.125);
		cl.post({ op: "vkCreateBuffer", id: 10, size: 128, usage: 0x4 });
		cl.post({ op: "writeBuffer", buffer: 10, offset: 0 }, u8(src));
		cl.post({ op: "vkCreateBufferView", id: 11, buffer: 10, format: 109, offset: 0, range: -1 });
		cl.post({ op: "vkCreateBuffer", id: 12, size: 4400, usage: 0x8 });
		cl.post({ op: "writeBuffer", buffer: 12, offset: 0 }, new Uint8Array(4400).fill(0xee));
		cl.post({ op: "vkCreateBufferView", id: 13, buffer: 12, format: 109, offset: 48, range: 128 });
		cl.post({ op: "vkCreateBufferView", id: 14, buffer: 12, format: 37, offset: 4112, range: 32 });
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: 5, layout: 2 }] });
		const bad = [];
		for (const [view, fmt, off] of [[13, 109, 48], [14, 37, 4112]]) {
			cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: 5, dstBinding: 0, descriptorType: 4, texelBufferView: [11] }, { dstSet: 5, dstBinding: 1, descriptorType: 5, texelBufferView: [view] }] });
			cl.post({ op: "vkQueueSubmit", cmds: [
				{ c: "vkCmdBindPipeline", pipelineBindPoint: 1, pipeline: 4 },
				{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 1, layout: 3, firstSet: 0, descriptorSets: [5], dynamicOffsets: [] },
				{ c: "vkCmdDispatch", groupCountX: 1, groupCountY: 1, groupCountZ: 1 },
			] });
			const got = await cl.req({ op: "readBuffer", buffer: 12, offset: 0, size: 4400 }).then((r) => r.bin, (e) => (bad.push(e.message), undefined));
			if (!got) break;
			const gv = new DataView(got.buffer, got.byteOffset, got.length);
			const end = off + (fmt === 109 ? 128 : 32);
			for (let j = 0; j < 4400 && bad.length < 6; j++) {
				if (j >= 48 && j < 176 && fmt === 37) continue; // the first run's
				if (j >= off && j < end) continue;
				if (got[j] !== 0xee) bad.push(`byte ${j} outside the view written: ${got[j]}`);
			}
			for (let j = 0; j < (fmt === 109 ? 32 : 32) && bad.length < 6; j++) {
				const w = src[j] * 2 + 1;
				const g = fmt === 109 ? gv.getFloat32(off + 4 * j, true) : got[off + j];
				const want = fmt === 109 ? w : Math.round(Math.min(1, Math.max(0, w)) * 255);
				if (Math.abs(g - want) > 1e-6) bad.push(`format ${fmt} component ${j}: ${g} != ${want}`);
			}
		}
		check("texel: a storage texel buffer written by compute (RGBA32F at 48, RGBA8 at 4112) and read back, nothing around it written", !perr && !bad.length && !cl.closedByHost, `${perr || ""} ${bad.join(", ")} | lost ${cl.lost}`);
		cl.conn.close();
	}
}

// --- host rules: uniform sizes, compressed copies, unwritten bindings,
// multi-draw indirect, misaligned storage offsets ------------------------------

async function hostCases(device, adapter) {
	const renderer = new VkRenderer({ device, adapter, shaders: fakeTranslator, log: (l) => log(`[rules] ${l}`) });
	const fake = (name) => new TextEncoder().encode(`FAKE:${name}`);
	const words = (bin) => new Uint32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length));
	const fresh = () => {
		const cl = new Client(renderer);
		cl.chunky = false;
		return cl;
	};
	const sync = (cl) => cl.req({ op: "sync" }).then(() => "answered", (e) => e.message);
	// one compute pipeline over set 0 (descriptor types as given), its set and a dispatch
	const compute = (cl, shader, types, extra = {}) => {
		cl.post({ op: "vkCreateShaderModule", id: 1 }, fake(shader));
		cl.post({ op: "vkCreateDescriptorSetLayout", id: 2, bindings: types.map((t, i) => ({ binding: i, descriptorType: t, descriptorCount: 1, stageFlags: 0x20, ...(extra[i] || {}) })) });
		cl.post({ op: "vkCreatePipelineLayout", id: 3, setLayouts: [2], pushConstantRanges: [] });
		cl.post({ op: "vkCreateComputePipelines", id: 4, layout: 3, stage: { stage: 0x20, module: 1, pName: "main" } });
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: 5, layout: 2 }] });
	};
	const dispatch = (cl, set = 5) => cl.post({ op: "vkQueueSubmit", cmds: [
		{ c: "vkCmdBindPipeline", pipelineBindPoint: 1, pipeline: 4 },
		{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 1, layout: 3, firstSet: 0, descriptorSets: [set], dynamicOffsets: [] },
		{ c: "vkCmdDispatch", groupCountX: 1, groupCountY: 1, groupCountZ: 1 },
	] });
	const h = (await fresh().req({ op: "hello", version: 1 })).json;
	log(`[rules] adapter features: ${[...adapter.features].filter((f) => f.startsWith("texture-compression")).join(" ")}; minStorageBufferOffsetAlignment ${h.limits.minStorageBufferOffsetAlignment}, minUniformBufferOffsetAlignment ${h.limits.minUniformBufferOffsetAlignment}`);

	// #4: a 252-byte uniform buffer bound with range 252 (GZDoom) and whole,
	// read by a shader whose block is 256 bytes: the binding grows to 256
	// within the buffer's GPU buffer; reads, writes and readback keep 252
	{
		const cl = fresh();
		compute(cl, "u256.comp", [6, 7]);
		cl.post({ op: "vkCreateBuffer", id: 10, size: 252, usage: 0x10 | 0x2 });
		cl.post({ op: "vkCreateBuffer", id: 11, size: 256, usage: 0x20 });
		const vals = new Uint32Array(63).map((_, i) => 1000 + i);
		cl.post({ op: "writeBuffer", buffer: 10, offset: 0 }, u8(vals));
		const res = [];
		for (const range of [252, -1]) {
			cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [
				{ dstSet: 5, dstBinding: 0, descriptorType: 6, bufferInfo: [{ buffer: 10, offset: 0, range }] },
				{ dstSet: 5, dstBinding: 1, descriptorType: 7, bufferInfo: [{ buffer: 11, offset: 0, range: -1 }] },
			] });
			dispatch(cl);
			const o = words((await cl.req({ op: "readBuffer", buffer: 11, offset: 0, size: 256 })).bin);
			res.push(o.slice(0, 63).every((v, i) => v === 1000 + i) && o[63] === 0 ? "ok" : `${o[0]},${o[62]},${o[63]}`);
		}
		const rb = await cl.req({ op: "readBuffer", buffer: 10, offset: 0, size: -1 });
		check("uniform binding of 252 bytes read by a 256-byte block (range 252 and whole)", res.join() === "ok,ok" && rb.bin.length === 252 && !cl.closedByHost, `${res.join(" ")}; readback ${rb.bin.length} bytes; lost ${cl.lost}`);
		cl.post({ op: "writeBuffer", buffer: 10, offset: 252 }, new Uint8Array(4));
		const past = await sync(cl);
		check("uniform buffer: a write past its Vulkan size into the padding is refused: device lost", /write past the end \(252\+4 > 252\)/.test(cl.lost) && past !== "answered", `lost ${cl.lost}`);
	}
	// a uniform range that 16-byte steps do not bring up to the block (200 of 256) is still refused: device lost
	{
		const cl = fresh();
		compute(cl, "u256.comp", [6, 7]);
		cl.post({ op: "vkCreateBuffer", id: 10, size: 512, usage: 0x10 });
		cl.post({ op: "vkCreateBuffer", id: 11, size: 256, usage: 0x20 });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [
			{ dstSet: 5, dstBinding: 0, descriptorType: 6, bufferInfo: [{ buffer: 10, offset: 0, range: 200 }] },
			{ dstSet: 5, dstBinding: 1, descriptorType: 7, bufferInfo: [{ buffer: 11, offset: 0, range: -1 }] },
		] });
		dispatch(cl);
		const serr = await sync(cl);
		check("uniform range 200 for a 256-byte block: device lost", /too small|bound with size 208/.test(cl.lost) && serr !== "answered", `lost ${cl.lost}`);
	}

	// #6: block-compressed copies that end mid-block at a level's edge,
	// both directions, and between images (same format, and BC1 to and
	// from R32G32_UINT: the same 8 bytes a block)
	if (adapter.features.has("texture-compression-bc")) {
		const cl = fresh();
		// BC1 8x8, 4 levels (8, 4, 2, 1)
		cl.post({ op: "vkCreateImage", id: 20, imageType: 1, format: 133, extent: { width: 8, height: 8, depth: 1 }, mipLevels: 4, arrayLayers: 1, samples: 1, usage: 0x1 | 0x2 | 0x4 });
		cl.post({ op: "vkCreateImage", id: 21, imageType: 1, format: 133, extent: { width: 8, height: 8, depth: 1 }, mipLevels: 4, arrayLayers: 1, samples: 1, usage: 0x1 | 0x2 | 0x4 });
		cl.post({ op: "vkCreateImage", id: 22, imageType: 1, format: 101, extent: { width: 2, height: 2, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x1 | 0x2 });
		cl.post({ op: "vkCreateBuffer", id: 30, size: 256, usage: 0x1 | 0x2 });
		cl.post({ op: "vkCreateBuffer", id: 31, size: 256, usage: 0x1 | 0x2 });
		const blocks = new Uint8Array(256).map((_, i) => (i * 37 + 11) & 255);
		cl.post({ op: "writeBuffer", buffer: 30, offset: 0 }, blocks);
		const sub = (mip) => ({ aspectMask: 1, mipLevel: mip, baseArrayLayer: 0, layerCount: 1 });
		const reg = (off, mip, w, hh) => ({ bufferOffset: off, bufferRowLength: 0, bufferImageHeight: 0, imageSubresource: sub(mip), imageOffset: { x: 0, y: 0, z: 0 }, imageExtent: { width: w, height: hh, depth: 1 } });
		cl.post({ op: "vkQueueSubmit", cmds: [
			// level 2 (2x2) and level 3 (1x1): one block each, from bytes 0 and 8
			{ c: "vkCmdCopyBufferToImage", srcBuffer: 30, dstImage: 20, dstImageLayout: 7, regions: [reg(0, 2, 2, 2), reg(8, 3, 1, 1)] },
			// and back into another buffer at 16 and 24
			{ c: "vkCmdCopyImageToBuffer", srcImage: 20, srcImageLayout: 6, dstBuffer: 31, regions: [reg(16, 2, 2, 2), reg(24, 3, 1, 1)] },
			// level 2 to the other BC1 image's level 2 (extent 2x2), then out at 32
			{ c: "vkCmdCopyImage", srcImage: 20, srcImageLayout: 6, dstImage: 21, dstImageLayout: 7, regions: [{ srcSubresource: sub(2), srcOffset: { x: 0, y: 0, z: 0 }, dstSubresource: sub(2), dstOffset: { x: 0, y: 0, z: 0 }, extent: { width: 2, height: 2, depth: 1 } }] },
			{ c: "vkCmdCopyImageToBuffer", srcImage: 21, srcImageLayout: 6, dstBuffer: 31, regions: [reg(32, 2, 2, 2)] },
		] });
		const o = (await cl.req({ op: "readBuffer", buffer: 31, offset: 0, size: 40 })).bin;
		const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
		check("BC1 levels 2x2 and 1x1: buffer to image and back, and image to image (extents mid-block)", same(o.subarray(16, 24), blocks.subarray(0, 8)) && same(o.subarray(24, 32), blocks.subarray(8, 16)) && same(o.subarray(32, 40), blocks.subarray(0, 8)) && !cl.closedByHost, `lost ${cl.lost}; ${[...o.subarray(16, 40)].join(",")}`);
		// BC1 level 0 (8x8: 2x2 blocks) into R32G32_UINT 2x2 and back into BC1 level 1 (4x4: one block)
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdCopyBufferToImage", srcBuffer: 30, dstImage: 20, dstImageLayout: 7, regions: [reg(64, 0, 8, 8)] },
			{ c: "vkCmdCopyImage", srcImage: 20, srcImageLayout: 6, dstImage: 22, dstImageLayout: 7, regions: [{ srcSubresource: sub(0), srcOffset: { x: 0, y: 0, z: 0 }, dstSubresource: sub(0), dstOffset: { x: 0, y: 0, z: 0 }, extent: { width: 8, height: 8, depth: 1 } }] },
			{ c: "vkCmdCopyImageToBuffer", srcImage: 22, srcImageLayout: 6, dstBuffer: 31, regions: [{ ...reg(64, 0, 2, 2), imageSubresource: sub(0) }] },
			{ c: "vkCmdCopyImage", srcImage: 22, srcImageLayout: 6, dstImage: 21, dstImageLayout: 7, regions: [{ srcSubresource: sub(0), srcOffset: { x: 1, y: 1, z: 0 }, dstSubresource: sub(1), dstOffset: { x: 0, y: 0, z: 0 }, extent: { width: 1, height: 1, depth: 1 } }] },
			{ c: "vkCmdCopyImageToBuffer", srcImage: 21, srcImageLayout: 6, dstBuffer: 31, regions: [reg(96, 1, 4, 4)] },
		] });
		const o2 = (await cl.req({ op: "readBuffer", buffer: 31, offset: 64, size: 40 })).bin;
		check("BC1 to R32G32_UINT and back (size-compatible formats through a buffer)", same(o2.subarray(0, 32), blocks.subarray(64, 96)) && same(o2.subarray(32, 40), blocks.subarray(88, 96)) && !cl.closedByHost, `lost ${cl.lost}; ${[...o2].join(",")}`);
		// a copy extent past the level (8x8 into level 1, 4x4): device lost, named
		cl.post({ op: "vkQueueSubmit", cmds: [{ c: "vkCmdCopyBufferToImage", srcBuffer: 30, dstImage: 20, dstImageLayout: 7, regions: [reg(0, 1, 8, 8)] }] });
		const serr = await sync(cl);
		check("BC1 copy extent past the level: device lost", /copy extent 8x8x1 out of range/.test(cl.lost) && serr !== "answered", `lost ${cl.lost}`);
	} else check("BC copies: skipped (no texture-compression-bc)", true);
	if (adapter.features.has("texture-compression-astc")) {
		// ASTC 6x6 (format 165) 24x24, levels 24, 12, 6, 3: level 3 is half a block
		const cl = fresh();
		cl.post({ op: "vkCreateImage", id: 20, imageType: 1, format: 165, extent: { width: 24, height: 24, depth: 1 }, mipLevels: 4, arrayLayers: 1, samples: 1, usage: 0x1 | 0x2 | 0x4 });
		cl.post({ op: "vkCreateBuffer", id: 30, size: 64, usage: 0x1 | 0x2 });
		const blk = new Uint8Array(64).map((_, i) => (i * 53 + 5) & 255);
		cl.post({ op: "writeBuffer", buffer: 30, offset: 0 }, blk);
		const r = (off, w) => ({ bufferOffset: off, imageSubresource: { aspectMask: 1, mipLevel: 3, baseArrayLayer: 0, layerCount: 1 }, imageOffset: { x: 0, y: 0, z: 0 }, imageExtent: { width: w, height: w, depth: 1 } });
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdCopyBufferToImage", srcBuffer: 30, dstImage: 20, dstImageLayout: 7, regions: [r(0, 3)] },
			{ c: "vkCmdCopyImageToBuffer", srcImage: 20, srcImageLayout: 6, dstBuffer: 30, regions: [r(32, 3)] },
		] });
		const o = (await cl.req({ op: "readBuffer", buffer: 30, offset: 32, size: 16 })).bin;
		check("ASTC 6x6 level 3x3: buffer to image and back", o.every((v, i) => v === blk[i]) && !cl.closedByHost, `lost ${cl.lost}`);
	} else check("ASTC copies: skipped (no texture-compression-astc)", true);

	// #3: a texture and a sampler left unwritten get placeholders (logged
	// once, the shader reads zeros); a sampler binding with immutable
	// samplers needs no write
	{
		const cl = fresh();
		compute(cl, "tex.comp", [2, 0, 7]);
		cl.post({ op: "vkCreateBuffer", id: 10, size: 64, usage: 0x20 });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: 5, dstBinding: 2, descriptorType: 7, bufferInfo: [{ buffer: 10, offset: 0, range: -1 }] }] });
		const before = logs.length;
		dispatch(cl);
		dispatch(cl);
		const o = new Float32Array(words((await cl.req({ op: "readBuffer", buffer: 10, offset: 0, size: 20 })).bin).buffer);
		const lines = logs.slice(before).filter((l) => /^\[rules\] kwvk:.*not written/.test(l));
		check("unwritten texture and sampler: placeholders bound, zeros read, logged once", [...o].join() === "0,0,0,0,7" && lines.length === 1 && /set binding 0 not written: a placeholder texture/.test(lines[0]) && !cl.closedByHost, `${[...o].join()} | ${lines.join(" / ")} | lost ${cl.lost}`);
		cl.conn.close();
	}
	{
		const cl = fresh();
		cl.post({ op: "vkCreateSampler", id: 40, magFilter: 0, minFilter: 0 });
		compute(cl, "tex.comp", [2, 0, 7], { 1: { immutableSamplers: [40] } });
		cl.post({ op: "vkCreateBuffer", id: 10, size: 64, usage: 0x20 });
		cl.post({ op: "vkCreateImage", id: 41, imageType: 1, format: 37, extent: { width: 1, height: 1, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x4 | 0x2 });
		cl.post({ op: "vkCreateImageView", id: 42, image: 41, viewType: 1, format: 37, subresourceRange: { aspectMask: 1, levelCount: 1, layerCount: 1 } });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [
			{ dstSet: 5, dstBinding: 0, descriptorType: 2, imageInfo: [{ imageView: 42, imageLayout: 5 }] },
			{ dstSet: 5, dstBinding: 2, descriptorType: 7, bufferInfo: [{ buffer: 10, offset: 0, range: -1 }] },
		] });
		cl.post({ op: "vkQueueSubmit", cmds: [{ c: "vkCmdClearColorImage", image: 41, color: { float32: [1, 0, 0, 1] }, ranges: [{ aspectMask: 1, levelCount: 1, layerCount: 1 }] }] });
		const before = logs.length;
		dispatch(cl);
		const o = new Float32Array(words((await cl.req({ op: "readBuffer", buffer: 10, offset: 0, size: 20 })).bin).buffer);
		const lines = logs.slice(before).filter((l) => /^\[rules\] kwvk:/.test(l));
		check("immutable sampler unwritten: the layout's sampler bound, the texture read, nothing logged", [...o].join() === "1,0,0,1,7" && !lines.length && !cl.closedByHost, `${[...o].join()} | ${lines.join(" / ")} | lost ${cl.lost}`);
		cl.conn.close();
	}

	// #1: vkCmdDrawIndirect / vkCmdDrawIndexedIndirect with drawCount > 1 and
	// a stride larger than the record: each record drawn, the bytes between
	// records never read; a drawCount past the buffer's end draws its whole records
	{
		const cl = fresh();
		const W = 64;
		cl.post({ op: "vkCreateImage", id: 50, imageType: 1, format: 37, extent: { width: W, height: W, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x10 | 0x1 });
		cl.post({ op: "vkCreateImageView", id: 51, image: 50, viewType: 1, format: 37, subresourceRange: { aspectMask: 1, levelCount: 1, layerCount: 1 } });
		cl.post({ op: "vkCreateRenderPass", id: 52, pAttachments: [{ format: 37, samples: 1, loadOp: 1, storeOp: 0, stencilLoadOp: 2, stencilStoreOp: 1, initialLayout: 0, finalLayout: 6 }], pSubpasses: [{ pipelineBindPoint: 0, pColorAttachments: [{ attachment: 0, layout: 2 }] }] });
		cl.post({ op: "vkCreateFramebuffer", id: 53, renderPass: 52, attachments: [51], width: W, height: W, layers: 1 });
		cl.post({ op: "vkCreateShaderModule", id: 54 }, fake("pos.vert"));
		cl.post({ op: "vkCreateShaderModule", id: 55 }, fake("red.frag"));
		cl.post({ op: "vkCreatePipelineLayout", id: 56, setLayouts: [], pushConstantRanges: [] });
		cl.post({
			op: "vkCreateGraphicsPipelines", id: 57, layout: 56, renderPass: 52, subpass: 0,
			stages: [{ stage: 1, module: 54, pName: "main" }, { stage: 0x10, module: 55, pName: "main" }],
			vertexInputState: { vertexBindingDescriptions: [{ binding: 0, stride: 8, inputRate: 0 }], vertexAttributeDescriptions: [{ location: 0, binding: 0, format: 103, offset: 0 }] },
			inputAssemblyState: { topology: 3 }, rasterizationState: { polygonMode: 0, cullMode: 0, frontFace: 0, lineWidth: 1 },
			viewportState: { viewports: [{ x: 0, y: 0, width: W, height: W, minDepth: 0, maxDepth: 1 }], scissors: [{ offset: { x: 0, y: 0 }, extent: { width: W, height: W } }] },
			multisampleState: { rasterizationSamples: 1 }, colorBlendState: { attachments: [{ blendEnable: 0, colorWriteMask: 15 }] },
		});
		// six small triangles, one around each of six cells (8 px from the centre of cell k at x = 8 + 10k... in clip space)
		const cells = [0, 1, 2, 3, 4, 5].map((k) => [-0.9 + k * 0.3, 0]);
		const tri = (cx, cy) => [cx - 0.1, cy - 0.1, cx + 0.1, cy - 0.1, cx, cy + 0.1];
		cl.post({ op: "vkCreateBuffer", id: 58, size: 6 * 24, usage: 0x80 });
		cl.post({ op: "writeBuffer", buffer: 58, offset: 0 }, u8(new Float32Array(cells.flatMap(([x, y]) => tri(x, y)))));
		cl.post({ op: "vkCreateBuffer", id: 59, size: 64, usage: 0x40 });
		cl.post({ op: "writeBuffer", buffer: 59, offset: 0 }, u8(new Uint32Array(16).map((_, i) => i)));
		// non-indexed: records {3, 1, 3k, 0} for k = 0, 1, 2 at stride 32; the gap holds {3, 1, 15, 0} (cell 5), never to be drawn
		const ind = new Uint32Array(64);
		for (let k = 0; k < 3; k++) ind.set([3, 1, 3 * k, 0, 3, 1, 15, 0], 8 * k);
		// indexed at 112: records {3, 1, 9, 0, 0} and {3, 1, 12, 0, 0} at stride 28; the gap's two words would shift a packed read
		ind.set([3, 1, 9, 0, 0, 7, 7, 3, 1, 12, 0, 0], 28);
		cl.post({ op: "vkCreateBuffer", id: 60, size: 256, usage: 0x100 });
		cl.post({ op: "writeBuffer", buffer: 60, offset: 0 }, u8(ind));
		cl.post({ op: "vkCreateBuffer", id: 61, size: W * W * 4, usage: 0x2 });
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBeginRenderPass", renderPass: 52, framebuffer: 53, renderArea: { offset: { x: 0, y: 0 }, extent: { width: W, height: W } }, clearValues: [{ color: { float32: [0, 0, 1, 1] } }] },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: 57 },
			{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [58], offsets: [0] },
			{ c: "vkCmdBindIndexBuffer", buffer: 59, offset: 0, indexType: 1 },
			{ c: "vkCmdDrawIndirect", buffer: 60, offset: 0, drawCount: 3, stride: 32 },
			{ c: "vkCmdDrawIndexedIndirect", buffer: 60, offset: 112, drawCount: 2, stride: 28 },
			{ c: "vkCmdEndRenderPass" },
			{ c: "vkCmdCopyImageToBuffer", srcImage: 50, srcImageLayout: 6, dstBuffer: 61, regions: [{ bufferOffset: 0, imageSubresource: { aspectMask: 1, mipLevel: 0, baseArrayLayer: 0, layerCount: 1 }, imageOffset: { x: 0, y: 0, z: 0 }, imageExtent: { width: W, height: W, depth: 1 } }] },
		] });
		const px = (await cl.req({ op: "readBuffer", buffer: 61, offset: 0, size: W * W * 4 })).bin;
		const red = cells.map(([x]) => px[(32 * W + Math.round((x + 1) * 32)) * 4] === 255 ? 1 : 0).join("");
		check("multi-draw indirect: drawCount 3 at stride 32, indexed drawCount 2 at stride 28", red === "111110" && !cl.closedByHost, `cells drawn ${red} (want 111110) | lost ${cl.lost}`);
		// drawCount 5 on a buffer with 3 whole records at stride 32 and 4 bytes of a fourth: 3 drawn, nothing refused
		cl.post({ op: "vkCreateBuffer", id: 62, size: 100, usage: 0x100 });
		cl.post({ op: "writeBuffer", buffer: 62, offset: 0 }, u8(ind.slice(0, 25)));
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBeginRenderPass", renderPass: 52, framebuffer: 53, renderArea: { offset: { x: 0, y: 0 }, extent: { width: W, height: W } }, clearValues: [{ color: { float32: [0, 0, 1, 1] } }] },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: 57 },
			{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [58], offsets: [0] },
			{ c: "vkCmdDrawIndirect", buffer: 62, offset: 0, drawCount: 5, stride: 32 },
			{ c: "vkCmdEndRenderPass" },
			{ c: "vkCmdCopyImageToBuffer", srcImage: 50, srcImageLayout: 6, dstBuffer: 61, regions: [{ bufferOffset: 0, imageSubresource: { aspectMask: 1, mipLevel: 0, baseArrayLayer: 0, layerCount: 1 }, imageOffset: { x: 0, y: 0, z: 0 }, imageExtent: { width: W, height: W, depth: 1 } }] },
		] });
		const px2 = (await cl.req({ op: "readBuffer", buffer: 61, offset: 0, size: W * W * 4 })).bin;
		const red2 = cells.map(([x]) => px2[(32 * W + Math.round((x + 1) * 32)) * 4] === 255 ? 1 : 0).join("");
		check("multi-draw indirect: drawCount past the buffer's end draws its whole records", red2 === "111000" && !cl.closedByHost, `cells drawn ${red2} (want 111000) | lost ${cl.lost}`);
		// indexed triangle fans with primitive restart (uint16, firstIndex 1): two
		// quads [0,1,2,3] and [4,5,6,7] rewritten as lists before the pass; as
		// plain lists each quad would be half drawn
		cl.post({
			op: "vkCreateGraphicsPipelines", id: 80, layout: 56, renderPass: 52, subpass: 0,
			stages: [{ stage: 1, module: 54, pName: "main" }, { stage: 0x10, module: 55, pName: "main" }],
			vertexInputState: { vertexBindingDescriptions: [{ binding: 0, stride: 8, inputRate: 0 }], vertexAttributeDescriptions: [{ location: 0, binding: 0, format: 103, offset: 0 }] },
			inputAssemblyState: { topology: 5, primitiveRestartEnable: 1 }, rasterizationState: { polygonMode: 0, cullMode: 0, frontFace: 0, lineWidth: 1 },
			viewportState: { viewports: [{ x: 0, y: 0, width: W, height: W, minDepth: 0, maxDepth: 1 }], scissors: [{ offset: { x: 0, y: 0 }, extent: { width: W, height: W } }] },
			multisampleState: { rasterizationSamples: 1 }, colorBlendState: { attachments: [{ blendEnable: 0, colorWriteMask: 15 }] },
		});
		const quad = (x0, x1) => [x0, -0.5, x1, -0.5, x1, 0.5, x0, 0.5];
		cl.post({ op: "vkCreateBuffer", id: 81, size: 64, usage: 0x80 });
		cl.post({ op: "writeBuffer", buffer: 81, offset: 0 }, u8(new Float32Array([...quad(-0.9, -0.1), ...quad(0.1, 0.9)])));
		cl.post({ op: "vkCreateBuffer", id: 82, size: 20, usage: 0x40 });
		cl.post({ op: "writeBuffer", buffer: 82, offset: 0 }, u8(new Uint16Array([99, 0, 1, 2, 3, 0xffff, 4, 5, 6, 7])));
		const before = logs.length;
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBeginRenderPass", renderPass: 52, framebuffer: 53, renderArea: { offset: { x: 0, y: 0 }, extent: { width: W, height: W } }, clearValues: [{ color: { float32: [0, 0, 1, 1] } }] },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: 80 },
			{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [81], offsets: [0] },
			{ c: "vkCmdBindIndexBuffer", buffer: 82, offset: 0, indexType: 0 },
			{ c: "vkCmdDrawIndexed", indexCount: 9, instanceCount: 1, firstIndex: 1, vertexOffset: 0, firstInstance: 0 },
			{ c: "vkCmdEndRenderPass" },
			{ c: "vkCmdCopyImageToBuffer", srcImage: 50, srcImageLayout: 6, dstBuffer: 61, regions: [{ bufferOffset: 0, imageSubresource: { aspectMask: 1, mipLevel: 0, baseArrayLayer: 0, layerCount: 1 }, imageOffset: { x: 0, y: 0, z: 0 }, imageExtent: { width: W, height: W, depth: 1 } }] },
		] });
		const px3 = (await cl.req({ op: "readBuffer", buffer: 61, offset: 0, size: W * W * 4 })).bin;
		const at3 = (x, y) => (px3[(Math.floor((1 - y) * 32) * W + Math.floor((x + 1) * 32)) * 4] === 255 ? 1 : 0);
		const corners = [-0.5, 0.5].map((cx) => [at3(cx - 0.3, -0.35), at3(cx + 0.3, -0.35), at3(cx + 0.3, 0.35), at3(cx - 0.3, 0.35)].join("")).join(" ") + ` outside ${at3(0, 0)}${at3(-0.5, 0.8)}`;
		const fanLogs = logs.slice(before).filter((l) => /^\[rules\] kwvk:.*fan/.test(l));
		check("indexed triangle fans with primitive restart drawn as their triangles", corners === "1111 1111 outside 00" && !fanLogs.length && !cl.closedByHost, `${corners} (want 1111 1111 outside 00) | ${fanLogs.join(" / ")} | lost ${cl.lost}`);
		// a misaligned storage binding in a draw: device lost, named (a render pass cannot copy it aside)
		cl.post({ op: "vkCreateShaderModule", id: 70 }, fake("sbo.frag"));
		cl.post({ op: "vkCreateDescriptorSetLayout", id: 71, bindings: [{ binding: 0, descriptorType: 7, descriptorCount: 1, stageFlags: 0x10 }] });
		cl.post({ op: "vkCreatePipelineLayout", id: 72, setLayouts: [71], pushConstantRanges: [] });
		cl.post({
			op: "vkCreateGraphicsPipelines", id: 73, layout: 72, renderPass: 52, subpass: 0,
			stages: [{ stage: 1, module: 54, pName: "main" }, { stage: 0x10, module: 70, pName: "main" }],
			vertexInputState: { vertexBindingDescriptions: [{ binding: 0, stride: 8, inputRate: 0 }], vertexAttributeDescriptions: [{ location: 0, binding: 0, format: 103, offset: 0 }] },
			inputAssemblyState: { topology: 3 }, rasterizationState: { polygonMode: 0, cullMode: 0, frontFace: 0, lineWidth: 1 },
			viewportState: { viewports: [{ x: 0, y: 0, width: W, height: W, minDepth: 0, maxDepth: 1 }], scissors: [{ offset: { x: 0, y: 0 }, extent: { width: W, height: W } }] },
			multisampleState: { rasterizationSamples: 1 }, colorBlendState: { attachments: [{ blendEnable: 0, colorWriteMask: 15 }] },
		});
		cl.post({ op: "vkCreateBuffer", id: 74, size: 8192, usage: 0x20 });
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: 75, layout: 71 }] });
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [{ dstSet: 75, dstBinding: 0, descriptorType: 7, bufferInfo: [{ buffer: 74, offset: 4480, range: 256 }] }] });
		cl.post({ op: "vkQueueSubmit", cmds: [
			{ c: "vkCmdBeginRenderPass", renderPass: 52, framebuffer: 53, renderArea: { offset: { x: 0, y: 0 }, extent: { width: W, height: W } }, clearValues: [{ color: { float32: [0, 0, 1, 1] } }] },
			{ c: "vkCmdBindPipeline", pipelineBindPoint: 0, pipeline: 73 },
			{ c: "vkCmdBindDescriptorSets", pipelineBindPoint: 0, layout: 72, firstSet: 0, descriptorSets: [75], dynamicOffsets: [] },
			{ c: "vkCmdBindVertexBuffers", firstBinding: 0, buffers: [58], offsets: [0] },
			{ c: "vkCmdDraw", vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
			{ c: "vkCmdEndRenderPass" },
		] });
		const serr = await sync(cl);
		check("storage binding at offset 4480 in a draw: device lost, named", /at offset 4480, not a multiple of minStorageBufferOffsetAlignment \(256\)/.test(cl.lost) && serr !== "answered", `lost ${cl.lost}`);
	}

	// storage bindings at offsets WebGPU refuses (4480: ggml-vulkan's matmul
	// views; 4482: off a word boundary) in a dispatch: bound as scratch
	// copies, the writable one copied back; the bytes around stay
	{
		const cl = fresh();
		cl.post({ op: "vkCreateShaderModule", id: 1 }, fake("double.comp"));
		cl.post({ op: "vkCreateDescriptorSetLayout", id: 2, bindings: [{ binding: 0, descriptorType: 7, descriptorCount: 1, stageFlags: 0x20 }] });
		cl.post({ op: "vkCreatePipelineLayout", id: 3, setLayouts: [2], pushConstantRanges: [] });
		cl.post({ op: "vkCreateComputePipelines", id: 4, layout: 3, stage: { stage: 0x20, module: 1, pName: "main", pSpecializationInfo: { mapEntries: [{ constantID: 0, offset: 0, size: 4 }], data: [3, 0, 0, 0] } } });
		cl.post({ op: "vkAllocateDescriptorSets", sets: [{ id: 5, layout: 2 }, { id: 6, layout: 2 }] });
		const N = 8192;
		const init = new Uint8Array(N).map((_, i) => (i * 29 + 3) & 255);
		cl.post({ op: "vkCreateBuffer", id: 10, size: N, usage: 0x20 });
		cl.post({ op: "writeBuffer", buffer: 10, offset: 0 }, init);
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [
			{ dstSet: 5, dstBinding: 0, descriptorType: 7, bufferInfo: [{ buffer: 10, offset: 4480, range: 256 }] },
			{ dstSet: 6, dstBinding: 0, descriptorType: 7, bufferInfo: [{ buffer: 10, offset: 6146, range: 256 }] },
		] });
		dispatch(cl, 5);
		dispatch(cl, 6);
		const got = (await cl.req({ op: "readBuffer", buffer: 10, offset: 0, size: N })).bin;
		// expected: 64 little-endian words at 4480 and at 6146 tripled
		const want = init.slice();
		const dv = new DataView(want.buffer);
		for (const base of [4480, 6146]) for (let i = 0; i < 64; i++) dv.setUint32(base + 4 * i, Math.imul(dv.getUint32(base + 4 * i, true), 3) >>> 0, true);
		const bad = want.findIndex((v, i) => v !== got[i]);
		check("storage bindings at offsets 4480 and 6146 in dispatches: scratch copies, written back exactly", bad < 0 && !cl.closedByHost, bad < 0 ? "" : `byte ${bad}: ${got[bad]} != ${want[bad]} | lost ${cl.lost}`);
		cl.conn.close();
	}
	{
		const cl = fresh();
		compute(cl, "copyro.comp", [7, 7]);
		cl.post({ op: "vkCreateBuffer", id: 10, size: 8192, usage: 0x20 });
		cl.post({ op: "vkCreateBuffer", id: 11, size: 256, usage: 0x20 });
		const init = new Uint32Array(2048).map((_, i) => i * 7 + 1);
		cl.post({ op: "writeBuffer", buffer: 10, offset: 0 }, u8(init));
		cl.post({ op: "vkUpdateDescriptorSets", descriptorWrites: [
			{ dstSet: 5, dstBinding: 0, descriptorType: 7, bufferInfo: [{ buffer: 10, offset: 4480, range: 256 }] },
			{ dstSet: 5, dstBinding: 1, descriptorType: 7, bufferInfo: [{ buffer: 11, offset: 0, range: -1 }] },
		] });
		dispatch(cl);
		const o = words((await cl.req({ op: "readBuffer", buffer: 11, offset: 0, size: 256 })).bin);
		check("read-only storage binding at offset 4480 in a dispatch", o.every((v, i) => v === init[1120 + i]) && !cl.closedByHost, `${o[0]} ${o[63]} | lost ${cl.lost}`);
		cl.conn.close();
	}
}

let perf = "";
let large = "";

// --- robustness: lifecycle, malformed input, device loss --------------------

async function robustness(device, adapter) {
	const renderer = new VkRenderer({ device, adapter, shaders: fakeTranslator, log: (l) => logs.push(`[robust] ${l}`) });
	let escaped = 0;
	const onErr = () => escaped++;
	addEventListener("error", onErr);
	addEventListener("unhandledrejection", onErr);

	// 200 connections that allocate, some closed mid-frame without waiting
	for (let i = 0; i < 200; i++) {
		const cl = new Client(renderer);
		cl.chunky = false;
		cl.post({ op: "vkCreateBuffer", id: 1, size: 4096, usage: 0x80 });
		cl.post({ op: "writeBuffer", buffer: 1, offset: 0 }, new Uint8Array(4096));
		cl.post({ op: "vkCreateImage", id: 2, imageType: 1, format: 44, extent: { width: 64, height: 64, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, usage: 0x10 | 0x1 });
		cl.post({ op: "vkCreateImageView", id: 3, image: 2, viewType: 1, format: 44, subresourceRange: { aspectMask: 1, levelCount: 1, layerCount: 1 } });
		cl.post({ op: "vkCreateQueryPool", id: 4, queryType: 0, queryCount: 4 });
		cl.post({ op: "vkQueueSubmit", cmds: [{ c: "vkCmdClearColorImage", image: 2, color: { float32: [1, 0, 0, 1] }, ranges: [{ aspectMask: 1, levelCount: 1, layerCount: 1 }] }] });
		if (i % 2) await cl.req({ op: "present", image: 2, readback: 1 });
		else cl.post({ op: "present", image: 2, readback: 1, r: 99 });
		cl.conn.close();
	}
	await device.queue.onSubmittedWorkDone();
	await new Promise((r) => setTimeout(r, 300));
	let st = renderer.stats;
	check("lifecycle: 200 connections leave nothing alive", st.liveGpu === 0 && st.liveObjects === 0, `liveGpu ${st.liveGpu} liveObjects ${st.liveObjects}`);

	// large buffers: a 64 MiB writeBuffer fed in 64 KiB chunks, read back whole
	{
		const cl = new Client(renderer);
		cl.chunky = false;
		const N = 64 << 20;
		cl.post({ op: "vkCreateBuffer", id: 1, size: N, usage: 0x20 | 0x3 });
		const data = new Uint8Array(N);
		const w32 = new Uint32Array(data.buffer);
		for (let i = 0; i < w32.length; i += 1024) w32[i] = i * 2654435761;
		w32[w32.length - 1] = 0xdeadbeef;
		const f = frame({ op: "writeBuffer", buffer: 1, offset: 0 }, data);
		const t0 = performance.now();
		for (let i = 0; i < f.length; i += 65536) cl.conn.feed(f.subarray(i, i + 65536));
		await cl.req({ op: "sync" });
		const t1 = performance.now();
		const rb = await cl.req({ op: "readBuffer", buffer: 1, offset: 0, size: N });
		const t2 = performance.now();
		const r32 = new Uint32Array(rb.bin.buffer, rb.bin.byteOffset, rb.bin.length >> 2);
		let ok = rb.bin.length === N && r32[r32.length - 1] === 0xdeadbeef;
		for (let i = 0; ok && i < r32.length; i += 1024) ok = r32[i] === w32[i];
		const mb = (ms) => ((N / (1 << 20)) / (ms / 1000)).toFixed(0);
		large = `write ${(t1 - t0).toFixed(0)} ms (${mb(t1 - t0)} MiB/s), read ${(t2 - t1).toFixed(0)} ms (${mb(t2 - t1)} MiB/s)`;
		check(`64 MiB writeBuffer/readBuffer: ${large}`, ok);
		cl.conn.close();
	}

	// malformed input
	let rnd = 12345;
	const rand = () => ((rnd = (rnd * 1103515245 + 12345) >>> 0) / 2 ** 32);
	const pick = (a) => a[Math.floor(rand() * a.length)];
	const ops = ["hello", "sync", "destroy", "vkCreateBuffer", "writeBuffer", "readBuffer", "vkCreateImage", "vkCreateImageView", "vkCreateSampler", "vkCreateShaderModule", "vkCreateDescriptorSetLayout", "vkCreatePipelineLayout", "vkAllocateDescriptorSets", "vkUpdateDescriptorSets", "vkCreateRenderPass", "vkCreateFramebuffer", "vkCreateGraphicsPipelines", "vkCreateComputePipelines", "vkQueueSubmit", "present", "vkCreateQueryPool", "getQueryPoolResults", "vkResetQueryPool", "nonsense", "__proto__", "constructor", "toString"];
	const cmdNames = ["vkCmdDraw", "vkCmdDrawIndexed", "vkCmdBeginRenderPass", "vkCmdEndRenderPass", "vkCmdCopyBuffer", "vkCmdCopyBufferToImage", "vkCmdBlitImage", "vkCmdFillBuffer", "vkCmdUpdateBuffer", "vkCmdPushConstants", "vkCmdBindPipeline", "vkCmdBindDescriptorSets", "vkCmdDrawIndirect", "vkCmdClearColorImage", "vkCmdBeginRendering", "vkCmdBeginQuery", "vkCmdCopyQueryPoolResults", "vkCmdResolveImage", "vkCmdSetViewport", "vkCmdDispatch", "bogus"];
	const keys = ["id", "size", "usage", "buffer", "offset", "image", "format", "extent", "width", "height", "depth", "mipLevels", "arrayLayers", "samples", "layout", "sets", "bindings", "regions", "cmds", "r", "ids", "queryPool", "queryCount", "firstQuery", "vertexCount", "drawCount", "stride", "data", "values", "stages", "module", "renderPass", "framebuffer", "attachments", "subpasses", "imageView", "colorAttachments", "dstBuffer", "srcBuffer", "dstImage", "srcImage", "imageExtent", "layerCount", "levelCount", "ranges", "readback"];
	const val = (depth) => {
		const t = rand();
		if (depth > 3 || t < 0.35) return pick([0, 1, 2, 3, -1, 7, 255, 4096, 65536, 2 ** 31, 2 ** 32 - 1, 2 ** 53, -(2 ** 40), 1e300, 0.5, NaN]);
		if (t < 0.45) return pick(["", "x", "vkCmdDraw", "__proto__", "9".repeat(50)]);
		if (t < 0.5) return pick([null, true, false]);
		if (t < 0.75) return Array.from({ length: Math.floor(rand() * 6) }, () => (rand() < 0.5 ? val(depth + 1) : obj(depth + 1)));
		return obj(depth + 1);
	};
	const obj = (depth) => {
		const o = {};
		for (let i = 0, n = Math.floor(rand() * 6); i < n; i++) o[pick(keys)] = val(depth);
		if (rand() < 0.3) o.c = pick(cmdNames);
		return o;
	};
	// a malformed message the host cannot answer (no "r") loses the device:
	// the connection is ended (with a {"lost"} frame) and the fuzzer makes a new one
	let fz = new Client(renderer);
	let losses = 0;
	let lostFrames = 0;
	for (let i = 0; i < 3000; i++) {
		if (i % 25 === 0) await new Promise((r) => setTimeout(r, 0)); // let the host run what was fed
		if (fz.closedByHost) {
			losses++;
			if (fz.lost) lostFrames++;
			fz = new Client(renderer);
		}
		const m = obj(0);
		m.op = pick(ops);
		if (m.op === "vkQueueSubmit") m.cmds = Array.from({ length: Math.floor(rand() * 8) }, () => ({ ...obj(1), c: pick(cmdNames) }));
		if (rand() < 0.5) m.id = 1 + Math.floor(rand() * 20);
		if (rand() < 0.3) m.r = 100000 + i;
		const bin = rand() < 0.2 ? new Uint8Array(Math.floor(rand() * 64) * 4) : undefined;
		fz.conn.feed(frame(m, bin));
	}
	// a frame whose JSON is not JSON, a jsonLen past the frame, then a sane request
	const bad = new Uint8Array(16);
	new DataView(bad.buffer).setUint32(0, 8, true);
	new DataView(bad.buffer).setUint32(4, 4, true);
	bad.set([0x7b, 0x7b, 0x7b, 0x7b], 8);
	fz = new Client(renderer);
	fz.conn.feed(bad);
	await new Promise((r) => setTimeout(r, 100));
	const badJsonLost = fz.closedByHost === 1 && /bad JSON/.test(fz.lost);
	let alive = false;
	try {
		const fresh = new Client(renderer);
		await Promise.race([fresh.req({ op: "hello", version: 1 }), new Promise((_, j) => setTimeout(() => j(new Error("no reply")), 20000))]);
		alive = true;
		fresh.conn.close();
	} catch (e) {
		logs.push(`[robust] ${e.message}`);
	}
	check("fuzz: 3000 random messages: each connection the host ended said why, a new one answers", alive && losses > 0 && lostFrames === losses && badJsonLost, `alive ${alive} losses ${losses} with reason ${lostFrames} bad JSON lost ${badJsonLost}`);
	// absurd frame length: the host ends the stream instead of buffering 4 GiB
	fz = new Client(renderer);
	const huge = new Uint8Array(8);
	new DataView(huge.buffer).setUint32(0, 0xfffffff0, true);
	fz.conn.feed(huge);
	check("fuzz: absurd frame length closes the stream", fz.closedByHost === 1);
	await device.queue.onSubmittedWorkDone();
	await new Promise((r) => setTimeout(r, 300));
	st = renderer.stats;
	check("fuzz: no escaped exceptions, nothing left alive", escaped === 0 && st.liveGpu === 0 && st.liveObjects === 0, `escaped ${escaped} liveGpu ${st.liveGpu} liveObjects ${st.liveObjects} errors ${st.errors}`);
	removeEventListener("error", onErr);
	removeEventListener("unhandledrejection", onErr);
}

// External present (vk/PROTOCOL.md, Amendments, "External present"): the
// hello's token, exportImages, present without pixels, and renderer.external()
// resolving (token << 32 | export id) to the image's picture, with every way
// a ref must come out null.
async function externalPresent(device, adapter) {
	const renderer = new VkRenderer({ device, adapter, shaders: fakeTranslator, log: (l) => logs.push(`[ext] ${l}`) });
	const cl = new Client(renderer);
	const h = (await cl.req({ op: "hello", version: 1 })).json;
	const token = h.external?.token;
	check("external: hello carries a token", Number.isInteger(token) && token > 0 && token <= 0xffffffff, JSON.stringify(h.external));
	const other = new Client(renderer);
	const t2 = (await other.req({ op: "hello", version: 1 })).json.external?.token;
	check("external: tokens differ per connection", t2 && t2 !== token, `${token} ${t2}`);
	const W = 8, H = 6, AR24 = 0x34325241, XR24 = 0x34325258, AB24 = 0x34324241;
	const image = (id) => cl.post({ op: "vkCreateImage", id, imageType: 1, format: 44 /* B8G8R8A8_UNORM */, extent: { width: W, height: H, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, tiling: 0, usage: 0x10 | 0x1 | 0x2 });
	image(1);
	image(2);
	image(3);
	const ids = (await cl.req({ op: "exportImages", images: [1, 2] })).json.ids;
	const again = (await cl.req({ op: "exportImages", images: [2] })).json.ids;
	check("external: export ids", JSON.stringify(ids) === "[1,2]" && JSON.stringify(again) === "[2]", `${JSON.stringify(ids)} ${JSON.stringify(again)}`);
	// premultiplied: R 0.5, G 0.25, B 0, A 0.5 (straight 255,128,0 at alpha 128)
	cl.post({ op: "vkQueueSubmit", cmds: [{ c: "vkCmdClearColorImage", image: 1, color: { float32: [0.5, 0.25, 0, 0.5] }, ranges: [{ aspectMask: 1, levelCount: 1, layerCount: 1 }] }] });
	const before = renderer.stats.bytesRead;
	const pr = await cl.req({ op: "present", image: 1, readback: 0, external: 1 });
	const id = (lo, tok = token) => (BigInt(tok) << 32n) | BigInt(lo);
	const px = (bmp) => {
		if (!bmp) return "null";
		const cv = new OffscreenCanvas(W, H), g = cv.getContext("2d");
		g.drawImage(bmp, 0, 0);
		bmp.close();
		return Array.from(g.getImageData(3, 3, 1, 1).data).join(",");
	};
	const near = (s, want) => s !== "null" && s.split(",").every((v, i) => Math.abs(Number(v) - want[i]) <= 3);
	const a = px(renderer.external({ id: id(ids[0]), width: W, height: H, format: AR24, flags: 0 }));
	const x = px(renderer.external({ id: id(ids[0]), width: W, height: H, format: XR24, flags: 0 }));
	check("external: present replies without pixels", pr.json.width === W && pr.json.height === H && !pr.bin.length && renderer.stats.bytesRead === before && renderer.stats.externalPresents === 1, JSON.stringify(pr.json));
	check("external: ARGB8888 resolves premultiplied", near(a, [255, 128, 0, 128]), a);
	check("external: XRGB8888 resolves opaque", near(x, [128, 64, 0, 255]), x);
	const nulls = {
		"a wrong token": renderer.external({ id: id(ids[0], token ^ 1), width: W, height: H, format: AR24, flags: 0 }),
		"the other connection's token": renderer.external({ id: id(ids[0], t2), width: W, height: H, format: AR24, flags: 0 }),
		"an unknown export id": renderer.external({ id: id(99), width: W, height: H, format: AR24, flags: 0 }),
		"a wrong size": renderer.external({ id: id(ids[0]), width: W + 1, height: H, format: AR24, flags: 0 }),
		"a wrong byte order": renderer.external({ id: id(ids[0]), width: W, height: H, format: AB24, flags: 0 }),
		"y_invert": renderer.external({ id: id(ids[0]), width: W, height: H, format: AR24, flags: 1 }),
		"an image never presented": renderer.external({ id: id(ids[1]), width: W, height: H, format: AR24, flags: 0 }),
		"a number id": renderer.external({ id: Number(id(ids[0])), width: W, height: H, format: AR24, flags: 0 }),
	};
	// pictures closed unused (what a compositor that skips a frame does), at a window's size
	cl.post({ op: "vkCreateImage", id: 9, imageType: 1, format: 44, extent: { width: 500, height: 500, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, tiling: 0, usage: 0x10 | 0x1 | 0x2 });
	const big = (await cl.req({ op: "exportImages", images: [9] })).json.ids[0];
	for (let i = 0; i < 4; i++) {
		cl.post({ op: "vkQueueSubmit", cmds: [{ c: "vkCmdClearColorImage", image: 9, color: { float32: [0, 0, 1, 1] }, ranges: [{ aspectMask: 1, levelCount: 1, layerCount: 1 }] }] });
		await cl.req({ op: "present", image: 9, readback: 0, external: 1 });
		renderer.external({ id: id(big), width: 500, height: 500, format: XR24, flags: 0 })?.close();
	}
	await cl.req({ op: "sync" });
	await new Promise((r) => setTimeout(r, 300));
	check("external: pictures closed unused keep the device", !renderer.isLost, `lost ${renderer.isLost}`);
	const notNull = Object.entries(nulls).filter(([, v]) => v !== null).map(([k]) => k);
	check("external: refs that are not the image's resolve to null", !notNull.length, notNull.join(", "));
	let unexported = "";
	await cl.req({ op: "present", image: 3, readback: 0, external: 1 }).catch((e) => (unexported = e.message));
	check("external: present of an unexported image fails", /not exported/.test(unexported), unexported);
	// destroyed: null; its export id is never given again
	cl.post({ op: "destroy", ids: [1] });
	cl.post({ op: "vkCreateImage", id: 1, imageType: 1, format: 44, extent: { width: W, height: H, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, tiling: 0, usage: 0x10 | 0x1 | 0x2 });
	const ids2 = (await cl.req({ op: "exportImages", images: [1] })).json.ids;
	await cl.req({ op: "present", image: 1, readback: 0, external: 1 });
	const gone = renderer.external({ id: id(ids[0]), width: W, height: H, format: AR24, flags: 0 });
	check("external: a destroyed image's id resolves to null, ids are not reused", gone === null && ids2[0] === big + 1, `${gone} new id ${ids2[0]}`);
	cl.conn.close();
	const closed = renderer.external({ id: id(ids2[0]), width: W, height: H, format: AR24, flags: 0 });
	check("external: a closed connection's ids resolve to null", closed === null && renderer.stats.externalImages === 6, `${closed} images ${renderer.stats.externalImages}`);
	other.conn.close();
	// a renderer told not to offer it (the SDK's canvas probe failed): no token, exportImages refused
	const off = new VkRenderer({ device, adapter, shaders: fakeTranslator, external: false, log: (l) => logs.push(`[ext-off] ${l}`) });
	const co = new Client(off);
	const ho = (await co.req({ op: "hello", version: 1 })).json;
	co.post({ op: "vkCreateImage", id: 1, imageType: 1, format: 44, extent: { width: W, height: H, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, tiling: 0, usage: 0x10 | 0x1 | 0x2 });
	let refused = "";
	await co.req({ op: "exportImages", images: [1] }).catch((e) => (refused = e.message));
	check("external: not offered: no token, exports refused", !ho.external && /not offered/.test(refused), `${JSON.stringify(ho.external)} ${refused}`);
	co.conn.close();
}

/**
 * Timestamp queries as ggml-vulkan's GGML_VK_PERF_LOGGER uses them: a host
 * reset, timestamps spread over several submits, one vkGetQueryPoolResults.
 * WebGPU resolves timestamps to nanoseconds when they are resolved, and a
 * backend's conversion may change between resolves (Dawn on Metal refines
 * its tick period as it runs): emulated here by each resolve adding a
 * smaller offset. Also a sample the backend did not write (it reads 0), and
 * whether a timestamp sits in an empty pass (stage-boundary backends may not
 * sample those).
 */
async function timestamps(device, adapter) {
	if (!device.features.has("timestamp-query")) return log("skip timestamps (the device has no timestamp-query)");
	const renderer = new VkRenderer({ device, adapter, shaders: fakeTranslator, log: (l) => log(`[ts] ${l}`) });
	const cl = new Client(renderer);
	await cl.req({ op: "hello", version: 1 });
	const E = GPUCommandEncoder.prototype, D = GPUDevice.prototype, P = GPUComputePassEncoder.prototype;
	const orig = { resolve: E.resolveQuerySet, begin: E.beginComputePass, createBuffer: D.createBuffer, dispatch: P.dispatchWorkgroups, end: P.end };
	const shift = device.createComputePipeline({
		layout: "auto",
		compute: {
			entryPoint: "main",
			module: device.createShaderModule({ code: `
@group(0) @binding(0) var<storage, read_write> v: array<u32>;
@group(0) @binding(1) var<uniform> p: vec4u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
	if (id.x < p.y) { let i = p.x / 4u + id.x * 2u + 1u; v[i] = v[i] + p.z; }
}` }),
		},
	});
	let resolves = 0, drop = -1, tsPasses = 0, emptyTs = 0;
	const passes = new WeakMap();
	D.createBuffer = function (desc) {
		// resolve targets also writable by the shift above
		return orig.createBuffer.call(this, desc.usage & 512 ? { ...desc, usage: desc.usage | 128 | 8 } : desc);
	};
	E.resolveQuerySet = function (set, first, n, dst, off) {
		orig.resolve.call(this, set, first, n, dst, off);
		const u = orig.createBuffer.call(device, { size: 16, usage: 64 | 8 });
		device.queue.writeBuffer(u, 0, new Uint32Array([off, n, 100 - ++resolves, 0]));
		const pass = orig.begin.call(this, {});
		pass.setPipeline(shift);
		pass.setBindGroup(0, device.createBindGroup({ layout: shift.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: dst } }, { binding: 1, resource: { buffer: u } }] }));
		orig.dispatch.call(pass, Math.ceil(n / 64));
		orig.end.call(pass);
		if (drop >= first && drop < first + n) this.clearBuffer(dst, off + (drop - first) * 8, 8);
	};
	E.beginComputePass = function (desc) {
		const pass = orig.begin.call(this, desc);
		if (desc?.timestampWrites) {
			passes.set(pass, 0);
			tsPasses++;
		}
		return pass;
	};
	P.dispatchWorkgroups = function (...a) {
		if (passes.has(this)) passes.set(this, passes.get(this) + 1);
		return orig.dispatch.apply(this, a);
	};
	P.end = function () {
		if (passes.get(this) === 0) emptyTs++;
		return orig.end.call(this);
	};
	try {
		const qp = 1, fb = 2;
		const ts = (q) => ({ c: "vkCmdWriteTimestamp", pipelineStage: 1, queryPool: qp, query: q });
		const fill = { c: "vkCmdFillBuffer", dstBuffer: fb, dstOffset: 0, size: 4096, data: 7 };
		const values = (r) => [...new BigUint64Array(r.bin.buffer.slice(r.bin.byteOffset, r.bin.byteOffset + r.bin.length))];
		cl.post({ op: "vkCreateQueryPool", id: qp, queryType: 2, queryCount: 8 });
		cl.post({ op: "vkCreateBuffer", id: fb, size: 4096, usage: 0x2 });
		// three submits, as ggml splits a graph, then one read
		cl.post({ op: "vkResetQueryPool", queryPool: qp, firstQuery: 0, queryCount: 8 });
		cl.post({ op: "vkQueueSubmit", cmds: [ts(0), fill, ts(1)] });
		cl.post({ op: "vkQueueSubmit", cmds: [fill, ts(2), fill, ts(3)] });
		cl.post({ op: "vkQueueSubmit", cmds: [ts(4)] });
		const r = await cl.req({ op: "getQueryPoolResults", queryPool: qp, firstQuery: 0, queryCount: 5 });
		const v = values(r);
		const d = v.slice(1).map((x, i) => x - v[i]);
		check("timestamps over three submits: monotonic, in nanoseconds", r.json.available.join() === "1,1,1,1,1" && v[0] > 0n && d.every((x) => x >= 0n && x < 1_000_000_000n), `deltas ${d.join(" ")} ns, available ${r.json.available}`);
		check("timestamps not in empty passes", tsPasses >= 5 && emptyTs === 0, `${emptyTs} of ${tsPasses} timestamp passes empty`);
		// a sample the backend did not write reads 0: never earlier than the one before it
		drop = 1;
		cl.post({ op: "vkResetQueryPool", queryPool: qp, firstQuery: 0, queryCount: 8 });
		cl.post({ op: "vkQueueSubmit", cmds: [ts(0), fill, ts(1), fill, ts(2)] });
		const v2 = values(await cl.req({ op: "getQueryPoolResults", queryPool: qp, firstQuery: 0, queryCount: 3 }));
		check("timestamps: an unwritten sample repeats the previous one", v2[0] > 0n && v2[1] === v2[0] && v2[2] >= v2[1], `${v2.join(" ")}`);
	} finally {
		Object.assign(E, { resolveQuerySet: orig.resolve, beginComputePass: orig.begin });
		Object.assign(P, { dispatchWorkgroups: orig.dispatch, end: orig.end });
		D.createBuffer = orig.createBuffer;
		cl.conn.close();
	}
}

async function deviceLoss() {
	const adapter = await navigator.gpu.requestAdapter();
	const device = await adapter.requestDevice(vkDeviceDescriptor(adapter));
	let lostCb = 0;
	const renderer = new VkRenderer({ device, adapter, shaders: fakeTranslator, log: (l) => logs.push(`[lost] ${l}`), onLost: () => lostCb++ });
	let closed = 0;
	const cl = new Client(renderer);
	cl.chunky = false;
	cl.conn = renderer.connect((b) => cl.onBytes(b), () => closed++);
	cl.post({ op: "vkCreateBuffer", id: 1, size: 64, usage: 0x2 });
	await cl.req({ op: "readBuffer", buffer: 1, offset: 0, size: 64 });
	device.destroy();
	const info = await Promise.race([renderer.lost, new Promise((r) => setTimeout(() => r(null), 5000))]);
	let err = "";
	try {
		await Promise.race([cl.req({ op: "readBuffer", buffer: 1, offset: 0, size: 64 }), new Promise((_, j) => setTimeout(() => j(new Error("no reply")), 3000))]);
	} catch (e) {
		err = e.message;
	}
	// a program started after the loss is refused at once
	const late = new Client(renderer);
	let lateClosed = 0;
	late.conn = renderer.connect((b) => late.onBytes(b), () => lateClosed++);
	check("device loss: renderer.lost, onLost, connections closed", !!info && lostCb === 1 && closed === 1 && lateClosed === 1 && renderer.stats.liveGpu === 0, `info ${JSON.stringify(info)} cb ${lostCb} closed ${closed} late ${lateClosed} err ${err} liveGpu ${renderer.stats.liveGpu}`);
}

async function main() {
	try {
		const adapter = await navigator.gpu?.requestAdapter();
		if (!adapter) throw new Error("no WebGPU adapter");
		const device = await adapter.requestDevice(vkDeviceDescriptor(adapter));
		const fakeBytes = (name) => new TextEncoder().encode(`FAKE:${name}`);
		await suite(device, adapter, fakeTranslator, "fake", fakeBytes);
		const cfg = await (await fetch("/config")).json();
		if (cfg.spirv) {
			const { loadVkShader } = await import("/js/core/vk-shader.ts");
			const tr = await loadVkShader(new URL("/naga.wasm", location.href));
			const spv = {};
			for (const name of Object.keys(cfg.spirv)) spv[name] = new Uint8Array(await (await fetch(cfg.spirv[name])).arrayBuffer());
			await suite(device, adapter, tr, "spirv", (name) => spv[name]);
		} else log("skip spirv suite (no translator or glslangValidator)");
		await hostCases(device, adapter);
		await texelCases(device, adapter, cfg.spirv ? (await import("/js/core/vk-shader.ts")).loadVkShader(new URL("/naga.wasm", location.href)) : undefined, cfg.spirv);
		await robustness(device, adapter);
		await timestamps(device, adapter);
		await externalPresent(device, adapter);
		await deviceLoss();
	} catch (e) {
		check("exception", false, `${e.message}\n${e.stack}`);
	}
	await fetch("/done", { method: "POST", body: JSON.stringify({ results, logs }) });
}

main();
