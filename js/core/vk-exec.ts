// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk: replay of a vkQueueSubmit command list on one GPUCommandEncoder.
// Data that Vulkan records into the command buffer (push constants,
// vkCmdUpdateBuffer, vkCmdFillBuffer patterns, blit parameters) goes into
// one upload buffer per submit, written while encoding and copied or bound
// from there, so it keeps its place in the command order (queue.writeBuffer
// would run before the whole submit). A command that cannot be encoded
// fails the whole submit (VkDeviceLost: the guest's device is lost) rather
// than being skipped.

import { BU, TU, UNUSED, alignDown, alignUp, isWhole, dkey, pipelineVariant, computeVariant, effectiveExt, noGpu, VkDeviceLost, type Conn } from "./vk-host.ts";
import { hasDepth, hasStencil, srgbTwin, texFormatInfo } from "./vk-formats.ts";

const ALIGN = 256;

class Upload {
	buf: any;
	map: Uint8Array;
	off = 0;
	size: number;
	constructor(c: Conn, size: number) {
		this.size = Math.max(ALIGN * 2, (size + ALIGN * 2 + 255) & ~255);
		this.buf = c.dev.createBuffer({ size: this.size, usage: BU.COPY_SRC | BU.UNIFORM, mappedAtCreation: true, label: "kwvk upload" });
		this.map = new Uint8Array(this.buf.getMappedRange());
	}
	alloc(bytes: Uint8Array | number, align: number, reserve = 0): number {
		const off = (this.off + align - 1) & ~(align - 1);
		const n = typeof bytes === "number" ? bytes : bytes.length;
		if (off + Math.max(n, reserve) > this.size) throw new Error("upload buffer overflow");
		if (typeof bytes !== "number") this.map.set(bytes, off);
		this.off = off + Math.max(n, reserve);
		return off;
	}
}

const MAX_UPLOAD = 1 << 28;

// commands that cannot change which pipeline variant a draw uses (the draw lookup memo survives them)
const NO_VARIANT_CHANGE = new Set([
	"vkCmdDraw", "vkCmdDrawIndexed", "vkCmdDrawIndirect", "vkCmdDrawIndexedIndirect", "vkCmdPushConstants",
	"vkCmdBindDescriptorSets", "vkCmdBindVertexBuffers", "vkCmdSetScissor", "vkCmdSetBlendConstants",
	"vkCmdSetStencilReference", "vkCmdSetLineWidth", "vkCmdSetDepthBounds", "vkCmdPipelineBarrier",
	"vkCmdBeginQuery", "vkCmdEndQuery",
]);

function scanSize(cmds: any[]): number {
	let n = 0;
	const len = (a: any) => (Array.isArray(a) ? a.length : 1);
	for (const k of cmds) {
		switch (k?.c) {
			case "vkCmdDraw":
			case "vkCmdDrawIndexed":
			case "vkCmdDrawIndirect":
			case "vkCmdDrawIndexedIndirect":
			case "vkCmdDispatch":
			case "vkCmdDispatchIndirect":
				n += ALIGN;
				break;
			case "vkCmdBlitImage":
				// layers per region are capped by the image's in blit()
				for (const r of Array.isArray(k.regions) ? k.regions : []) n += ALIGN * Math.min(2048, Math.max(1, r?.srcSubresource?.layerCount | 0));
				break;
			case "vkCmdClearAttachments":
				n += ALIGN * len(k.attachments);
				break;
			case "vkCmdBeginRenderPass":
			case "vkCmdBeginRenderPass2":
			case "vkCmdBeginRendering":
			case "vkCmdNextSubpass":
			case "vkCmdNextSubpass2":
				n += ALIGN * 10; // partial render area clears
				break;
			case "vkCmdUpdateBuffer":
				n += ((len(k.data) | 0) + 7) & ~3;
				break;
			case "vkCmdFillBuffer":
				if (k.data && !isWhole(k.size) && k.size > 0) n += (Math.min(k.size, MAX_UPLOAD) + 7) & ~3;
				break;
			case "vkCmdCopyQueryPoolResults":
				n += 8;
				break;
			case "vkCmdCopyBuffer":
				n += ALIGN * len(k.regions);
				break;
		}
	}
	if (n > MAX_UPLOAD) throw new Error(`submit needs ${n} bytes of command data`);
	return n;
}

function clearColorOf(v: any, tex: string | null): any {
	const kind = tex ? texFormatInfo(tex)?.kind : "float";
	const c = v?.color ?? v;
	let arr: number[] | undefined;
	if (Array.isArray(c)) arr = c;
	else if (c) {
		if (kind === "uint") arr = c.uint32 ?? reinterpret(c.int32, "u") ?? c.float32;
		else if (kind === "sint") arr = c.int32 ?? reinterpret(c.uint32, "i") ?? c.float32;
		else arr = c.float32 ?? reinterpret(c.uint32 ?? c.int32, "f");
	}
	const a = arr || [0, 0, 0, 0];
	return { r: a[0] ?? 0, g: a[1] ?? 0, b: a[2] ?? 0, a: a[3] ?? 0 };
}

function reinterpret(v: number[] | undefined, to: string): number[] | undefined {
	if (!v) return undefined;
	const b = new ArrayBuffer(16);
	const src = new Uint32Array(b);
	const f = new Float32Array(b);
	const i = new Int32Array(b);
	// v holds integer words (uint32 or int32 members): keep the bits
	for (let k = 0; k < 4; k++) src[k] = (v[k] ?? 0) >>> 0;
	return to === "u" ? [...src] : to === "i" ? [...i] : [...f];
}

/** n texels rounded up to whole blocks of b texels (b = 1: unchanged) */
function blockAlign(n: number, b: number): number {
	return b > 1 ? Math.ceil(n / b) * b : n;
}

/** A mip level's width and height in texels of whole blocks (its physical size; WebGPU's bound for copies). */
function levelBlocks(img: any, mip: number): [number, number] {
	const info = img.info || {};
	return [blockAlign(Math.max(1, Math.floor(img.width / 2 ** mip)), info.bw || 1), blockAlign(Math.max(1, Math.floor(img.height / 2 ** mip)), info.bh || 1)];
}

function depthClearOf(v: any): { depth: number; stencil: number } {
	const d = v?.depthStencil ?? v ?? {};
	return { depth: d.depth ?? 1, stencil: d.stencil ?? 0 };
}

interface Bound {
	pipe?: any;
	groups: string[];
	vbs: any[];
	ib?: string;
	push?: number;
}

class Exec {
	c: Conn;
	dev: any;
	enc: any;
	up: Upload;
	pushBG: any;
	pass: any = null;
	passKind = "";
	push = new Uint8Array(256);
	pushVer = 1;
	pushOff = -1;
	pushOffVer = 0;
	gfx: { pipeline?: any; sets: any[]; dyn: number[][] } = { sets: [], dyn: [] };
	comp: { pipeline?: any; sets: any[]; dyn: number[][] } = { sets: [], dyn: [] };
	vbs = new Map<number, { buf: any; offset: number }>();
	ib?: { buf: any; offset: number; format: string };
	viewport?: any;
	scissor?: any;
	blend?: number[];
	stencilRef = 0;
	bias?: [number, number, number];
	readMask?: number;
	writeMask?: number;
	rp?: { pass: any; fb: any; subpass: number; clear: any[]; width: number; height: number; area?: any };
	/** extended dynamic state set in this command list */
	ext: Record<string, any> = {};
	bound: Bound = { groups: [], vbs: [] };
	index = 0;
	cmds: any[];
	stateVer = 0;
	drawMemo?: { key: string; v: any; refined: any; p: any };
	/** textures to destroy once the submit is done */
	scratch: any[] = [];

	constructor(c: Conn, cmds: any[]) {
		this.c = c;
		this.cmds = cmds;
		this.dev = c.dev;
		this.enc = c.dev.createCommandEncoder({ label: "kwvk submit" });
		this.up = new Upload(c, scanSize(cmds));
		this.pushBG = c.dev.createBindGroup({ layout: c.pushBGL, entries: [{ binding: 0, resource: { buffer: this.up.buf, offset: 0, size: 256 } }] });
	}

	occlusionPool?: any;

	endPass(): void {
		if (this.activeQuery !== undefined) {
			this.pass.endOcclusionQuery();
			this.activeQuery = undefined;
		}
		this.occlusionPool = undefined;
		if (this.pass) this.pass.end();
		this.pass = null;
		this.passKind = "";
		this.bound = { groups: [], vbs: [] };
	}

	buffer(id: number): any {
		return this.c.get(id, "buffer");
	}

	// --- render passes ---------------------------------------------------

	beginSubpass(): void {
		const rp = this.rp!;
		const pass = rp.pass;
		const sp = pass.subpasses[rp.subpass];
		if (!sp) throw new Error(`no subpass ${rp.subpass}`);
		const view = (a: number) => this.c.viewFor(this.c.get(rp.fb.views[a], "imageView"), "att");
		const first = (a: number) => pass.first.get(a) === rp.subpass;
		const last = (a: number) => pass.last.get(a) === rp.subpass;
		// a render area smaller than the attachments: load, then clear only the area with a draw
		const ar = rp.area;
		const partial = !!ar && ((ar.offset?.x || 0) > 0 || (ar.offset?.y || 0) > 0 || (ar.offset?.x || 0) + ar.extent.width < rp.width || (ar.offset?.y || 0) + ar.extent.height < rp.height);
		const clears: any[] = [];
		const load = (a: number, op: number) => (!first(a) || op === 0 || partial ? "load" : "clear");
		const store = (a: number, op: number) => (!last(a) || op !== 1 || partial ? "store" : "discard");
		const colorAttachments = sp.colors.map((a: number, j: number) => {
			if (a === UNUSED) return null;
			const att = pass.atts[a];
			const ca: any = { view: view(a), loadOp: load(a, att.loadOp), storeOp: store(a, att.storeOp), clearValue: clearColorOf(rp.clear[a], att.tex) };
			if (partial && first(a) && att.loadOp === 1) clears.push({ aspectMask: 1, colorAttachment: j, clearValue: rp.clear[a] });
			const r = sp.resolves[j];
			if (r !== undefined && r !== UNUSED) ca.resolveTarget = view(r);
			return ca;
		});
		const desc: any = { colorAttachments, label: "kwvk render pass" };
		if (sp.depth !== UNUSED) {
			const a = sp.depth;
			const att = pass.atts[a];
			const dc = depthClearOf(rp.clear[a]);
			const ds: any = { view: view(a) };
			let mask = 0;
			if (hasDepth(att.tex)) {
				Object.assign(ds, { depthLoadOp: load(a, att.loadOp), depthStoreOp: store(a, att.storeOp), depthClearValue: dc.depth });
				if (att.loadOp === 1) mask |= 2;
			}
			if (hasStencil(att.tex)) {
				Object.assign(ds, { stencilLoadOp: load(a, att.stencilLoadOp), stencilStoreOp: store(a, att.stencilStoreOp), stencilClearValue: dc.stencil });
				if (att.stencilLoadOp === 1) mask |= 4;
			}
			if (partial && first(a) && mask) clears.push({ aspectMask: mask, colorAttachment: 0, clearValue: rp.clear[a] });
			desc.depthStencilAttachment = ds;
		}
		// occlusion queries inside this pass: WebGPU wants their query set at the pass's start
		for (let i = this.index + 1; i < this.cmds.length; i++) {
			const k = this.cmds[i];
			const kc = k?.c;
			if (kc === "vkCmdEndRenderPass" || kc === "vkCmdEndRenderPass2" || kc === "vkCmdEndRendering" || kc === "vkCmdNextSubpass" || kc === "vkCmdNextSubpass2") break;
			if (kc === "vkCmdBeginQuery") {
				const p = this.c.objs.get(k.queryPool);
				if (p?.t === "queryPool" && p.type === 0 && p.set) {
					desc.occlusionQuerySet = p.set;
					this.occlusionPool = p;
				}
				break;
			}
		}
		this.prepareFans();
		this.pass = this.enc.beginRenderPass(desc);
		this.passKind = "render";
		this.bound = { groups: [], vbs: [] };
		if (clears.length) this.clearAttachments({ attachments: clears, rects: [{ rect: ar }] });
		else this.applyDynamic();
	}

	/** vkCmdBeginRendering (dynamic rendering): a one-subpass render pass made from the attachments. */
	beginRendering(k: any): void {
		const atts: any[] = [];
		const views: number[] = [];
		const clear: any[] = [];
		let width = 0;
		let height = 0;
		const add = (viewId: number, att: any, cv: any) => {
			const v = this.c.get(viewId, "imageView");
			const mip = v.range.baseMipLevel || 0;
			width = width || Math.max(1, v.image.width >> mip);
			height = height || Math.max(1, v.image.height >> mip);
			atts.push({ ...att, tex: v.tex, samples: v.image.samples });
			views.push(viewId);
			clear.push(cv);
			return atts.length - 1;
		};
		const colors: number[] = [];
		const resolves: number[] = [];
		for (const ca of k.colorAttachments || []) {
			if (!ca?.imageView) {
				colors.push(UNUSED);
				resolves.push(UNUSED);
				continue;
			}
			colors.push(add(ca.imageView, { loadOp: ca.loadOp ?? 0, storeOp: ca.storeOp ?? 0 }, ca.clearValue));
			resolves.push(ca.resolveMode && ca.resolveImageView ? add(ca.resolveImageView, { loadOp: 2, storeOp: 0 }, undefined) : UNUSED);
		}
		const da = k.depthAttachment?.imageView ? k.depthAttachment : undefined;
		const sa = k.stencilAttachment?.imageView ? k.stencilAttachment : undefined;
		let depth = UNUSED;
		if (da || sa) {
			const dv = { depthStencil: { depth: da?.clearValue?.depthStencil?.depth ?? 1, stencil: sa?.clearValue?.depthStencil?.stencil ?? 0 } };
			depth = add((da || sa).imageView, { loadOp: da ? da.loadOp ?? 0 : 0, storeOp: da ? da.storeOp ?? 0 : 0, stencilLoadOp: sa ? sa.loadOp ?? 0 : 0, stencilStoreOp: sa ? sa.storeOp ?? 0 : 0 }, dv);
		}
		if ((k.layerCount || 1) > 1 || k.viewMask) this.c.log("kwvk: vkCmdBeginRendering: layered and multiview rendering are unsupported (layer 0 only)");
		const colorFormats = colors.map((a) => (a === UNUSED ? null : atts[a].tex));
		const depthFormat = depth === UNUSED ? null : atts[depth].tex;
		let samples = 1;
		for (const a of [...colors, depth]) if (a !== UNUSED) samples = atts[a].samples || 1;
		const sp = { colors, resolves, depth, colorFormats, depthFormat, samples, key: `${colorFormats.join(",")}|${depthFormat}|${samples}` };
		const all = new Map(atts.map((_, i) => [i, 0]));
		const pass = { atts, subpasses: [sp], first: all, last: all };
		this.rp = { pass, fb: { views, width, height }, subpass: 0, clear, width, height, area: k.renderArea };
		this.beginSubpass();
	}

	applyDynamic(): void {
		if (this.passKind !== "render") return;
		const rp = this.rp!;
		if (this.viewport) {
			const v = this.viewport;
			let y = v.y;
			let h = v.height;
			if (h < 0) {
				// VK_KHR_maintenance1: the draw uses the vertex stage without the y flip (flushDraw)
				y += h;
				h = -h;
			}
			let mn = Math.min(1, Math.max(0, v.minDepth ?? 0));
			let mx = Math.min(1, Math.max(0, v.maxDepth ?? 1));
			if (mn > mx) [mn, mx] = [mx, mn];
			if (v.width > 0 && h > 0) this.pass.setViewport(v.x, y, v.width, h, mn, mx);
		}
		if (this.scissor) {
			const s = this.scissor;
			const x = Math.min(Math.max(0, s.offset?.x || 0), rp.width);
			const y = Math.min(Math.max(0, s.offset?.y || 0), rp.height);
			const w = Math.max(0, Math.min((s.offset?.x || 0) + s.extent.width, rp.width) - x);
			const h = Math.max(0, Math.min((s.offset?.y || 0) + s.extent.height, rp.height) - y);
			this.pass.setScissorRect(x, y, w, h);
		}
		if (this.blend) this.pass.setBlendConstant({ r: this.blend[0], g: this.blend[1], b: this.blend[2], a: this.blend[3] });
		this.pass.setStencilReference(this.stencilRef);
	}

	// --- draw-time state ---------------------------------------------------

	bindSets(pass: any, layout: any, st: { sets: any[]; dyn: number[][] }, over?: Map<number, Map<number, any>>): void {
		layout.sets.forEach((slot: any, s: number) => {
			const o = over?.get(s);
			const bg = st.sets[s] || !slot.entries.length ? this.c.bindGroup(st.sets[s], slot, o) : this.c.placeholderBindGroup(s, slot);
			const vk = st.dyn[s] || [];
			const offs = slot.dynIdx.map((i: number) => vk[i] ?? 0);
			const key = o ? `alias${this.nextId++}` : `${this.bgId(bg)}:${offs.join(",")}`;
			if (this.bound.groups[s] === key) return;
			this.bound.groups[s] = key;
			pass.setBindGroup(s, bg, offs);
		});
		if (layout.pushGroup >= 0) {
			if (this.pushOffVer !== this.pushVer) {
				this.pushOff = this.up.alloc(this.push.subarray(0, Math.min(256, (layout.pushSize + 15) & ~15)), ALIGN, 256);
				this.pushOffVer = this.pushVer;
			}
			if (this.bound.push !== this.pushOff || this.bound.groups[layout.pushGroup] !== "push") {
				pass.setBindGroup(layout.pushGroup, this.pushBG, [this.pushOff]);
				this.bound.push = this.pushOff;
				this.bound.groups[layout.pushGroup] = "push";
			}
		}
	}

	ids = new WeakMap<object, number>();
	nextId = 1;
	bgId(o: object): number {
		let id = this.ids.get(o);
		if (!id) this.ids.set(o, (id = this.nextId++));
		return id;
	}

	baseWarn(): void {
		this.c.log("kwvk: draw: the shader reads BaseVertex/BaseInstance/DrawIndex, which read 0 on WebGPU (non-zero firstVertex/vertexOffset/firstInstance)");
	}

	fan(): boolean {
		const p = this.gfx.pipeline;
		return !!p && (effectiveExt(p, this.ext).topology ?? p.topology) === 5;
	}

	activeQuery?: number;

	/**
	 * Copy `size` bytes at any byte offsets so that no byte outside the
	 * destination range changes: the source words go to a scratch buffer,
	 * then a compute pass rebuilds each destination word from them, keeping
	 * the bytes outside the range.
	 */
	byteScratch?: any;

	/**
	 * A helper pass's uniform parameters: in the upload buffer when the
	 * submit's scan counted them (scanSize: vkCmdCopyBuffer's byte copies),
	 * else in a buffer of their own (helpers the scan cannot foresee:
	 * misaligned bindings, fans), so they never take room a later command
	 * was counted for.
	 */
	params(words: Uint32Array, counted: boolean): { buf: any; offset: number; size: number } {
		const bytes = new Uint8Array(words.buffer, words.byteOffset, words.byteLength);
		if (counted) return { buf: this.up.buf, offset: this.up.alloc(bytes, ALIGN), size: bytes.length };
		const buf = this.dev.createBuffer({ size: alignUp(bytes.length, 16), usage: BU.UNIFORM, mappedAtCreation: true, label: "kwvk helper parameters" });
		new Uint8Array(buf.getMappedRange()).set(bytes);
		buf.unmap();
		this.scratch.push(buf);
		return { buf, offset: 0, size: bytes.length };
	}

	byteCopy(src: any, so: number, dst: any, dO: number, size: number, counted = true): void {
		if (!size) return;
		const a0 = alignDown(so, 4);
		const a1 = Math.min(alignUp(so + size, 4), src.size);
		// one scratch per submit, reused: the encoder runs the copies and passes in order
		const need = Math.max(256, alignUp(a1 - a0, 4));
		if (!this.byteScratch || this.byteScratch.size < need) {
			this.byteScratch = this.dev.createBuffer({ size: need, usage: BU.STORAGE | BU.COPY_DST, label: "kwvk byte copy" });
			this.scratch.push(this.byteScratch);
		}
		const scratch = this.byteScratch;
		this.enc.copyBufferToBuffer(src, a0, scratch, 0, a1 - a0);
		const h = byteCopyPipeline(this.c);
		const pb = this.params(new Uint32Array([so - a0, dO, size, 0]), counted);
		const bg = this.dev.createBindGroup({
			layout: h.bgl,
			entries: [
				{ binding: 0, resource: { buffer: scratch } },
				{ binding: 1, resource: { buffer: dst } },
				{ binding: 2, resource: { buffer: pb.buf, offset: pb.offset, size: pb.size } },
			],
		});
		const words = Math.ceil((dO + size) / 4) - Math.floor(dO / 4);
		const pass = this.enc.beginComputePass({ label: "kwvk byte copy" });
		pass.setPipeline(h.pipeline);
		pass.setBindGroup(0, bg);
		pass.dispatchWorkgroups(Math.ceil(words / 64));
		pass.end();
	}

	/** A query that reads as zero: its result is cleared and it counts as available. */
	touchAvail(p: any, q: number): void {
		p.avail[q] = 1;
	}

	/** A query the query set holds a value of (resolved when it is read: resolveQueries); seq is the order of writes. */
	touch(p: any, q: number): void {
		p.written[q] = 1;
		p.seq[q] = ++p.clock;
		p.avail[q] = 1;
	}

	queryPool(k: any): { p: any; q: number } {
		const p = this.c.get(k.queryPool, "queryPool");
		const q = k.query | 0;
		if (q < 0 || q >= p.count) throw new Error(`query ${k.query} out of range`);
		return { p, q };
	}

	/** this pass's indexed triangle fans rewritten as lists (prepareFans), by command index */
	fanLists = new Map<number, { ib: any; buf: any; offset: number; count: number }>();

	/**
	 * Indexed triangle fans, which WebGPU has not, drawn as the lists they
	 * describe. Before a render pass begins (a compute pass cannot run inside
	 * one), its indexed fan draws are found by replaying the pass's pipeline,
	 * topology and index buffer binds, and a compute pass rewrites each
	 * draw's indices as (fan's first, previous, current) triples, a
	 * primitive restart (when the pipeline enables it) starting a new fan
	 * and the triangles it saves left degenerate. The draw then reads those
	 * (vkCmdDrawIndexed); the index data is what the draw sees, as no
	 * transfer runs inside a render pass.
	 */
	prepareFans(): void {
		this.fanLists.clear();
		let p = this.gfx.pipeline;
		let ext = this.ext;
		let ib = this.ib;
		const jobs: { i: number; ib: any; first: number; count: number; restart: boolean }[] = [];
		for (let i = this.index + 1; i < this.cmds.length; i++) {
			const k = this.cmds[i];
			const kc = k?.c;
			if (typeof kc !== "string" || kc === "vkCmdEndRenderPass" || kc === "vkCmdEndRenderPass2" || kc === "vkCmdEndRendering" || kc === "vkCmdNextSubpass" || kc === "vkCmdNextSubpass2") break;
			if (kc === "vkCmdBindPipeline") {
				const o = this.c.objs.get(k.pipeline);
				if (o?.t === "pipeline" && o.kind !== "compute") p = o;
			} else if (kc === "vkCmdSetPrimitiveTopology") ext = { ...ext, topology: k.primitiveTopology };
			else if (kc === "vkCmdBindIndexBuffer") {
				const b = this.c.objs.get(k.buffer);
				ib = b?.t === "buffer" && (k.indexType === 0 || k.indexType === 1) ? { buf: b.buf, offset: k.offset || 0, format: k.indexType === 0 ? "uint16" : "uint32" } : undefined;
			} else if (kc === "vkCmdDrawIndexed" && p && ib && (effectiveExt(p, ext).topology ?? p.topology) === 5) {
				const count = k.indexCount;
				const first = k.firstIndex || 0;
				if (!(Number.isInteger(count) && count >= 3 && count <= 1 << 24 && Number.isInteger(first) && first >= 0)) continue;
				jobs.push({ i, ib, first, count, restart: !!p.msg?.inputAssemblyState?.primitiveRestartEnable });
			}
		}
		if (!jobs.length) return;
		let total = 0;
		const at = jobs.map((j) => {
			const o = total;
			total += alignUp(3 * (j.count - 2) * 4, ALIGN);
			return o;
		});
		const out = this.dev.createBuffer({ size: total, usage: BU.INDEX | BU.STORAGE, label: "kwvk fan lists" });
		this.scratch.push(out);
		const h = fanPipeline(this.c);
		const pass = this.enc.beginComputePass({ label: "kwvk fan lists" });
		pass.setPipeline(h.pipeline);
		jobs.forEach((j, n) => {
			const isz = j.ib.format === "uint16" ? 2 : 4;
			const start = j.ib.offset + j.first * isz;
			// the indices as a storage binding at a 256-byte aligned offset, clamped to the buffer (indices past it read 0)
			const base = alignDown(start, ALIGN);
			const size = Math.min(alignUp(start - base + j.count * isz, 4), j.ib.buf.size - base);
			if (!(size > 0)) return;
			const pb = this.params(new Uint32Array([start - base, j.count, isz, j.restart ? 1 : 0, size >> 2, 0, 0, 0]), false);
			const bg = this.dev.createBindGroup({
				layout: h.bgl,
				entries: [
					{ binding: 0, resource: { buffer: j.ib.buf, offset: base, size } },
					{ binding: 1, resource: { buffer: out, offset: at[n], size: 3 * (j.count - 2) * 4 } },
					{ binding: 2, resource: { buffer: pb.buf, offset: pb.offset, size: pb.size } },
				],
			});
			pass.setBindGroup(0, bg);
			pass.dispatchWorkgroups(1);
			this.fanLists.set(j.i, { ib: j.ib, buf: out, offset: at[n]!, count: 3 * (j.count - 2) });
		});
		pass.end();
	}

	/** A list index buffer for a fan of n vertices (relative indices; the draw's base vertex is the fan's first). */
	fanIndices(n: number): { buf: any; offset: number; format: string } {
		const c = this.c;
		const tris = Math.max(0, n - 2);
		if (!c.fanIndex || c.fanIndex.count < tris) {
			const count = Math.max(1024, 1 << Math.ceil(Math.log2(tris || 1)));
			const buf = this.dev.createBuffer({ size: count * 12, usage: BU.INDEX, mappedAtCreation: true, label: "kwvk fan indices" });
			const a = new Uint32Array(buf.getMappedRange());
			for (let i = 0; i < count; i++) a.set([0, i + 1, i + 2], i * 3);
			buf.unmap();
			c.fanIndex = { buf, count };
		}
		return { buf: c.fanIndex.buf, offset: 0, format: "uint32" };
	}

	flushDraw(indexed: boolean, ibOverride?: { buf: any; offset: number; format: string }): boolean {
		if (this.passKind !== "render") throw new Error("draw outside a render pass");
		const p0 = this.gfx.pipeline;
		if (!p0) throw new Error("no graphics pipeline bound");
		this.c.stats.draws++;
		const ib = ibOverride || this.ib;
		// back-to-back draws with no other command between them reuse the last variant lookup
		const memo = `${this.stateVer}|${indexed}|${!!ibOverride}`;
		let v: any;
		let refined: any;
		let p = p0;
		if (this.drawMemo?.key === memo) ({ v, refined, p } = this.drawMemo);
		else {
			const sp = this.rp!.pass.subpasses[this.rp!.subpass];
			const dyn: any = {};
			if (this.bias) dyn.bias = this.bias;
			if (this.readMask !== undefined) dyn.readMask = this.readMask;
			if (this.writeMask !== undefined) dyn.writeMask = this.writeMask;
			if (this.viewport && this.viewport.height < 0) dyn.noFlip = true;
			dyn.ext = this.ext;
			p = this.c.storageVariant(p0, this.gfx.sets);
			refined = this.c.refine(p.layout, this.gfx.sets);
			v = pipelineVariant(this.c, p, sp, dyn, indexed ? ib?.format : undefined, refined);
			this.drawMemo = { key: memo, v, refined, p };
		}
		if (this.bound.pipe !== v) {
			this.pass.setPipeline(v);
			this.bound.pipe = v;
			this.bound.groups = [];
			this.bound.push = undefined;
		}
		this.bindSets(this.pass, refined || p.layout, this.gfx);
		p.buffers.forEach((b: any, slot: number) => {
			const vb = this.vbs.get(b.binding);
			if (!vb) throw new Error(`vertex binding ${b.binding} not bound`);
			if (this.bound.vbs[slot] === vb) return;
			this.bound.vbs[slot] = vb;
			this.pass.setVertexBuffer(slot, vb.buf, vb.offset);
		});
		if (indexed) {
			if (!ib) throw new Error("no index buffer bound");
			const key = `${this.bgId(ib.buf)}:${ib.offset}:${ib.format}`;
			if (this.bound.ib !== key) {
				this.pass.setIndexBuffer(ib.buf, ib.format, ib.offset);
				this.bound.ib = key;
			}
		}
		return true;
	}

	computePass(): any {
		if (this.passKind === "compute") return this.pass;
		if (this.passKind === "render") throw new Error("dispatch inside a render pass");
		this.pass = this.enc.beginComputePass({ label: "kwvk compute" });
		this.passKind = "compute";
		this.bound = { groups: [], vbs: [] };
		return this.pass;
	}

	flushDispatch(): any {
		let p = this.comp.pipeline;
		if (!p) throw new Error("no compute pipeline bound");
		this.c.stats.dispatches++;
		p = this.c.storageVariant(p, this.comp.sets);
		const refined = this.c.refine(p.layout, this.comp.sets);
		// copies aside (outside the pass) before the pass and pipeline are set
		const over = this.aliasFix(refined || p.layout, this.comp);
		const pass = this.computePass();
		const gpu = computeVariant(this.c, p, refined);
		if (this.bound.pipe !== gpu) {
			pass.setPipeline(gpu);
			this.bound.pipe = gpu;
			this.bound.groups = [];
			this.bound.push = undefined;
		}
		this.bindSets(pass, refined || p.layout, this.comp, over);
		return pass;
	}

	/** alias copies of this submit by index within a dispatch (destroyed with the submit's scratch) */
	aliasScratch: any[] = [];
	/** scratch copies of writable bindings to copy back after the dispatch (copyBack) */
	backs: { sc: any; buf: any; off: number; size: number }[] = [];
	/**
	 * WebGPU refuses a buffer range bound writable twice (or read-only and
	 * writable) in one dispatch; Vulkan allows it (ggml-vulkan's in-place
	 * ops bind src and dst to one range). A binding that is read-only in the
	 * app's shader and overlaps another binding of the same buffer is read
	 * from a scratch copy made just before the dispatch. So is a binding a
	 * pipeline keeps "read-only-storage" (vk-host.ts readOnlyRetry) whose
	 * buffer the dispatch also binds writable anywhere (one usage scope).
	 * A binding at an offset that is not a multiple of the device's
	 * min{Storage,Uniform}BufferOffsetAlignment (ggml-vulkan's matmul binds
	 * a tensor view where it lies, 4480, with 256 reported: invalid in
	 * Vulkan, but drivers that report less take it) is bound as a scratch
	 * copy at offset 0 too, and copied back after the dispatch when the
	 * shader may write it (copyBack).
	 */
	aliasFix(layout: any, st: { sets: any[]; dyn: number[][] }): Map<number, Map<number, any>> | undefined {
		const ents: any[] = [];
		const lim = this.dev.limits || {};
		layout.sets.forEach((slot: any, s: number) => {
			const set = st.sets[s];
			if (!set) return;
			for (const e of slot.entries) {
				// a texel buffer's parameters are the host's own buffer, never the app's
				if (!e.buffer || e.kwTexel === "params") continue;
				const uniform = e.buffer.type === "uniform";
				const [vkb, el] = slot.src.get(e.binding) || [e.binding >> 1, 0];
				const d = set.desc.get(dkey(vkb, el));
				if (!d) continue;
				const b = this.c.objs.get(d.buffer);
				if (!b?.buf) continue;
				// dynamic offsets: only as the writable buffer a kept read-only binding meets
				if (e.buffer.hasDynamicOffset) {
					if (e.buffer.type === "storage") ents.push({ s, binding: e.binding, dyn: true, w: true, buf: b.buf });
					continue;
				}
				const mis = d.offset % ((uniform ? lim.minUniformBufferOffsetAlignment : lim.minStorageBufferOffsetAlignment) || 256) !== 0;
				if (uniform && !mis) continue;
				const range = Math.min(isWhole(d.range) ? b.size - d.offset : d.range, b.size - d.offset);
				const size = Math.min(alignUp(range, uniform ? 16 : 4), b.buf.size - d.offset);
				ents.push({ s, binding: e.binding, ro: !!e.kwRO, kept: e.buffer.type === "read-only-storage", w: e.buffer.type === "storage", mis, uniform, buf: b.buf, off: d.offset, size, range });
			}
		});
		let over: Map<number, Map<number, any>> | undefined;
		let n = 0;
		for (const a of ents) {
			if (!a.ro && !a.kept && !a.mis) continue;
			const clash =
				a.mis ||
				(a.kept
					? ents.some((x) => x.w && x.buf === a.buf)
					: ents.some((x) => x !== a && !x.dyn && x.buf === a.buf && x.off < a.off + a.size && a.off < x.off + x.size));
			if (!clash) continue;
			if (!(a.size > 0)) throw new Error(`buffer binding at offset ${a.off} past the end of its buffer`);
			if (this.passKind === "compute") this.endPass();
			// the binding's size in whole words (16 bytes for a uniform)
			const bsize = alignUp(a.size, a.uniform ? 16 : 4);
			let sc = this.aliasScratch[n];
			if (!sc || sc.size < bsize) {
				sc = this.dev.createBuffer({ size: Math.max(bsize, 256), usage: BU.STORAGE | BU.UNIFORM | BU.COPY_SRC | BU.COPY_DST, label: "kwvk alias scratch" });
				this.aliasScratch[n] = sc;
				this.scratch.push(sc); // destroyed when the submit is done
			}
			n++;
			// a binding off a word boundary (only a misaligned one can be) goes by bytes
			if (a.off % 4) this.byteCopy(a.buf, a.off, sc, 0, a.size, false);
			else this.enc.copyBufferToBuffer(a.buf, a.off, sc, 0, a.size);
			// back: the app's range exactly
			if (a.mis && a.w && a.range > 0) this.backs.push({ sc, buf: a.buf, off: a.off, size: a.range });
			((over ||= new Map()).get(a.s) || over.set(a.s, new Map()).get(a.s)!).set(a.binding, { buf: sc, size: bsize });
		}
		if (over) this.bound.groups = [];
		return over;
	}

	/** After a dispatch: the writable misaligned bindings' scratch copies back where the app bound them (aliasFix). */
	copyBack(): void {
		if (!this.backs.length) return;
		this.endPass();
		for (const k of this.backs.splice(0)) {
			if (k.off % 4 || k.size % 4) this.byteCopy(k.sc, 0, k.buf, k.off, k.size, false);
			else this.enc.copyBufferToBuffer(k.sc, 0, k.buf, k.off, k.size);
		}
	}

	outside(): void {
		if (this.passKind === "compute") this.endPass();
		else if (this.passKind === "render") throw new Error("transfer command inside a render pass");
	}

	// --- transfers ---------------------------------------------------------

	copyBufImg(toImage: boolean, bufId: number, imgId: number, r: any): void {
		const b = this.buffer(bufId);
		const img = this.c.get(imgId, "image");
		const info = img.info;
		const sub = r.imageSubresource || {};
		const ext = r.imageExtent || { width: img.width, height: img.height, depth: 1 };
		const off = r.imageOffset || { x: 0, y: 0, z: 0 };
		// Vulkan lets a copy of a block-compressed image end mid-block at the
		// mip level's edge (a 2x2 level of a BC texture); WebGPU wants whole
		// blocks, the level's physical size: the extent in whole blocks (the
		// buffer's footprint is in blocks either way)
		const w = blockAlign(ext.width, info.bw);
		const h = blockAlign(ext.height, info.bh);
		const d = img.is3D ? ext.depth || 1 : sub.layerCount || 1;
		const z0 = img.is3D ? off.z || 0 : sub.baseArrayLayer || 0;
		const rowLen = r.bufferRowLength || w;
		const imgH = r.bufferImageHeight || h;
		const [lw, lh] = levelBlocks(img, sub.mipLevel || 0);
		if (!(w >= 1 && h >= 1 && d >= 1 && w <= lw && h <= lh && d <= Math.max(img.layers, img.depth))) throw new Error(`copy extent ${w}x${h}x${d} out of range`);
		const bytesPerRow = Math.ceil(rowLen / info.bw) * info.bpb;
		const rowsPerImage = Math.ceil(imgH / info.bh);
		let aspect = "all";
		if (hasDepth(img.format) || hasStencil(img.format)) aspect = sub.aspectMask & 4 ? (hasDepth(img.format) ? "stencil-only" : "all") : hasStencil(img.format) ? "depth-only" : "all";
		const base = r.bufferOffset || 0;
		const copy = (offset: number, bpr: number | undefined, rows: number | undefined, x: number, y: number, z: number, cw: number, ch: number, cd: number) => {
			const layout: any = { buffer: b.buf, offset };
			if (bpr !== undefined) layout.bytesPerRow = bpr;
			if (rows !== undefined) layout.rowsPerImage = rows;
			const tex = { texture: img.tex, mipLevel: sub.mipLevel || 0, origin: [x, y, z], aspect };
			if (toImage) this.enc.copyBufferToTexture(layout, tex, [cw, ch, cd]);
			else this.enc.copyTextureToBuffer(tex, layout, [cw, ch, cd]);
		};
		if (bytesPerRow % 256 === 0) {
			copy(base, bytesPerRow, rowsPerImage, off.x || 0, off.y || 0, z0, w, h, d);
			return;
		}
		// WebGPU wants bytesPerRow % 256 == 0: one copy per block row
		const blocksH = Math.ceil(h / info.bh);
		for (let k = 0; k < d; k++) {
			for (let row = 0; row < blocksH; row++) {
				const y = row * info.bh;
				copy(base + (k * rowsPerImage + row) * bytesPerRow, undefined, undefined, off.x || 0, (off.y || 0) + y, z0 + k, w, Math.min(info.bh, h - y), 1);
			}
		}
	}

	/**
	 * One region of vkCmdCopyImage. The extent is in the source's texels and
	 * covers the same blocks of both images; a compressed side's extent is
	 * in whole blocks (it may end mid-block at a level's edge in Vulkan, not
	 * in WebGPU). Formats WebGPU copies between (equal, or sRGB twins) copy
	 * directly; other size-compatible ones (BC1 and R32G32_UINT, R32_UINT
	 * and RGBA8) through a scratch buffer, the same bytes per block.
	 */
	copyImg(s: any, d: any, r: any): void {
		const ss = r.srcSubresource || {};
		const ds = r.dstSubresource || {};
		const e = r.extent || {};
		const si = s.info;
		const di = d.info;
		const bx = Math.ceil((e.width ?? 0) / si.bw);
		const by = Math.ceil((e.height ?? 0) / si.bh);
		const n = s.is3D ? e.depth || 1 : ss.layerCount || 1;
		const src = { texture: s.tex, mipLevel: ss.mipLevel || 0, origin: [r.srcOffset?.x || 0, r.srcOffset?.y || 0, s.is3D ? r.srcOffset?.z || 0 : ss.baseArrayLayer || 0] };
		const dst = { texture: d.tex, mipLevel: ds.mipLevel || 0, origin: [r.dstOffset?.x || 0, r.dstOffset?.y || 0, d.is3D ? r.dstOffset?.z || 0 : ds.baseArrayLayer || 0] };
		const sSize = [bx * si.bw, by * si.bh, n];
		if (s.format === d.format || srgbTwin(s.format) === d.format) {
			this.enc.copyTextureToTexture(src, dst, sSize);
			return;
		}
		const ds2 = hasDepth(s.format) || hasStencil(s.format) || hasDepth(d.format) || hasStencil(d.format);
		if (ds2 || si.bpb !== di.bpb || s.samples > 1) throw new Error(`vkCmdCopyImage from ${s.format} to ${d.format} is unsupported (not size-compatible, or depth/stencil or multisampled)`);
		const bytesPerRow = alignUp(bx * si.bpb, 256);
		const tmp = this.dev.createBuffer({ size: Math.max(4, bytesPerRow * by * n), usage: BU.COPY_SRC | BU.COPY_DST, label: "kwvk image copy" });
		this.scratch.push(tmp);
		const layout = { buffer: tmp, offset: 0, bytesPerRow, rowsPerImage: by };
		this.enc.copyTextureToBuffer(src, layout, sSize);
		this.enc.copyBufferToTexture(layout, dst, [bx * di.bw, by * di.bh, n]);
	}

	renderableView(img: any, mip: number, layer: number): any {
		return img.tex.createView({ dimension: "2d", baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
	}

	clearImage(imgId: number, ranges: any[], color: any, ds: any): void {
		const img = this.c.get(imgId, "image");
		for (const r of ranges || [{}]) {
			const levels = Math.min(isWhole(r.levelCount) || r.levelCount === UNUSED ? img.mipLevels - (r.baseMipLevel || 0) : r.levelCount ?? 1, img.mipLevels);
			const layers = Math.min(isWhole(r.layerCount) || r.layerCount === UNUSED ? img.layers - (r.baseArrayLayer || 0) : r.layerCount ?? 1, img.layers);
			for (let m = 0; m < levels; m++) {
				for (let l = 0; l < layers; l++) {
					const view = this.renderableView(img, (r.baseMipLevel || 0) + m, (r.baseArrayLayer || 0) + l);
					const desc: any = { colorAttachments: [] };
					if (ds) {
						const a: any = { view };
						const mask = r.aspectMask ?? 6;
						if (hasDepth(img.format)) Object.assign(a, mask & 2 ? { depthLoadOp: "clear", depthClearValue: ds.depth ?? 1 } : { depthLoadOp: "load" }, { depthStoreOp: "store" });
						if (hasStencil(img.format)) Object.assign(a, mask & 4 ? { stencilLoadOp: "clear", stencilClearValue: ds.stencil ?? 0 } : { stencilLoadOp: "load" }, { stencilStoreOp: "store" });
						desc.depthStencilAttachment = a;
					} else {
						desc.colorAttachments.push({ view, loadOp: "clear", storeOp: "store", clearValue: clearColorOf(color, img.format) });
					}
					this.enc.beginRenderPass(desc).end();
				}
			}
		}
	}

	blit(k: any): void {
		const src = this.c.get(k.srcImage, "image");
		const dst = this.c.get(k.dstImage, "image");
		for (const r of k.regions || []) {
			const so = r.srcOffsets;
			const dO = r.dstOffsets;
			const ss = r.srcSubresource || {};
			const dsub = r.dstSubresource || {};
			const sw = so[1].x - so[0].x;
			const sh = so[1].y - so[0].y;
			const dw = dO[1].x - dO[0].x;
			const dh = dO[1].y - dO[0].y;
			const layers = Math.min(ss.layerCount || 1, src.layers, dst.layers);
			if (sw === dw && sh === dh && sw > 0 && sh > 0 && src.format === dst.format && so[1].z - so[0].z <= 1) {
				this.enc.copyTextureToTexture(
					{ texture: src.tex, mipLevel: ss.mipLevel || 0, origin: [so[0].x, so[0].y, src.is3D ? so[0].z : ss.baseArrayLayer || 0] },
					{ texture: dst.tex, mipLevel: dsub.mipLevel || 0, origin: [dO[0].x, dO[0].y, dst.is3D ? dO[0].z : dsub.baseArrayLayer || 0] },
					[sw, sh, layers],
				);
				continue;
			}
			if (hasDepth(dst.format) || hasStencil(dst.format) || texFormatInfo(dst.format)?.kind !== "float") {
				throw new Error(`scaled blit of ${dst.format} is unsupported`);
			}
			const sinfo = texFormatInfo(src.format);
			const linear = k.filter === 1 && !!(sinfo && sinfo.caps & 2);
			const h = blitPipeline(this.c, dst.format, linear);
			const smw = Math.max(1, src.width >> (ss.mipLevel || 0));
			const smh = Math.max(1, src.height >> (ss.mipLevel || 0));
			for (let l = 0; l < layers; l++) {
				const u = new Float32Array([so[0].x / smw, so[0].y / smh, so[1].x / smw, so[1].y / smh]);
				let x0 = dO[0].x;
				let y0 = dO[0].y;
				let x1 = dO[1].x;
				let y1 = dO[1].y;
				if (x1 < x0) {
					[x0, x1] = [x1, x0];
					[u[0], u[2]] = [u[2]!, u[0]!];
				}
				if (y1 < y0) {
					[y0, y1] = [y1, y0];
					[u[1], u[3]] = [u[3]!, u[1]!];
				}
				if (x1 === x0 || y1 === y0) continue;
				const off = this.up.alloc(new Uint8Array(u.buffer), ALIGN);
				const bg = this.dev.createBindGroup({
					layout: h.bgl,
					entries: [
						{ binding: 0, resource: this.renderableView(src, ss.mipLevel || 0, (ss.baseArrayLayer || 0) + l) },
						{ binding: 1, resource: h.sampler },
						{ binding: 2, resource: { buffer: this.up.buf, offset: off, size: 16 } },
					],
				});
				const pass = this.enc.beginRenderPass({
					colorAttachments: [{ view: this.renderableView(dst, dsub.mipLevel || 0, (dsub.baseArrayLayer || 0) + l), loadOp: "load", storeOp: "store" }],
				});
				pass.setPipeline(h.pipeline);
				pass.setBindGroup(0, bg);
				pass.setViewport(x0, y0, x1 - x0, y1 - y0, 0, 1);
				pass.draw(4);
				pass.end();
			}
		}
	}

	resolve(k: any): void {
		const src = this.c.get(k.srcImage, "image");
		const dst = this.c.get(k.dstImage, "image");
		for (const r of k.regions || []) {
			const e = r.extent || {};
			const ss = r.srcSubresource || {};
			const ds = r.dstSubresource || {};
			const sw = Math.max(1, src.width >> (ss.mipLevel || 0));
			const sh = Math.max(1, src.height >> (ss.mipLevel || 0));
			const dw = Math.max(1, dst.width >> (ds.mipLevel || 0));
			const dh = Math.max(1, dst.height >> (ds.mipLevel || 0));
			const so = r.srcOffset || {};
			const dO = r.dstOffset || {};
			const whole = !so.x && !so.y && !dO.x && !dO.y && e.width === dw && e.height === dh && sw === dw && sh === dh;
			let target = this.renderableView(dst, ds.mipLevel || 0, ds.baseArrayLayer || 0);
			let tmp: any;
			if (!whole) {
				// resolve all of it into a scratch texture, then copy the region
				tmp = this.dev.createTexture({ size: [sw, sh, 1], format: dst.format, usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC, label: "kwvk resolve" });
				target = tmp.createView();
			}
			const pass = this.enc.beginRenderPass({
				colorAttachments: [{ view: this.renderableView(src, ss.mipLevel || 0, ss.baseArrayLayer || 0), resolveTarget: target, loadOp: "load", storeOp: "store" }],
			});
			pass.end();
			if (tmp) {
				this.enc.copyTextureToTexture(
					{ texture: tmp, origin: [so.x || 0, so.y || 0, 0] },
					{ texture: dst.tex, mipLevel: ds.mipLevel || 0, origin: [dO.x || 0, dO.y || 0, ds.baseArrayLayer || 0] },
					[e.width, e.height, 1],
				);
				this.scratch.push(tmp);
			}
		}
	}

	clearAttachments(k: any): void {
		if (this.passKind !== "render") throw new Error("vkCmdClearAttachments outside a render pass");
		const rp = this.rp!;
		const sp = rp.pass.subpasses[rp.subpass];
		for (const a of k.attachments || []) {
			const isColor = (a.aspectMask & 1) !== 0;
			const target = isColor ? a.colorAttachment : -1;
			const fmt = isColor ? sp.colorFormats[target] : sp.depthFormat;
			if (!fmt) continue;
			const h = clearPipeline(this.c, sp, target, a.aspectMask);
			const kind = texFormatInfo(fmt)?.kind;
			const data = new ArrayBuffer(32);
			if (isColor) {
				const cc = clearColorOf(a.clearValue, fmt);
				if (kind === "uint") new Uint32Array(data, 0, 4).set([cc.r, cc.g, cc.b, cc.a]);
				else if (kind === "sint") new Int32Array(data, 0, 4).set([cc.r, cc.g, cc.b, cc.a]);
				else new Float32Array(data, 0, 4).set([cc.r, cc.g, cc.b, cc.a]);
			}
			const dc = depthClearOf(a.clearValue);
			new Float32Array(data, 16, 1)[0] = dc.depth;
			const off = this.up.alloc(new Uint8Array(data), ALIGN);
			const bg = this.dev.createBindGroup({ layout: h.bgl, entries: [{ binding: 0, resource: { buffer: this.up.buf, offset: off, size: 32 } }] });
			this.pass.setPipeline(h.pipeline);
			this.pass.setBindGroup(0, bg);
			if (a.aspectMask & 4) this.pass.setStencilReference(dc.stencil);
			for (const r of k.rects || []) {
				const x = Math.max(0, r.rect.offset.x);
				const y = Math.max(0, r.rect.offset.y);
				const w = Math.min(r.rect.extent.width, rp.width - x);
				const hh = Math.min(r.rect.extent.height, rp.height - y);
				if (w <= 0 || hh <= 0) continue;
				this.pass.setScissorRect(x, y, w, hh);
				this.pass.draw(4);
			}
		}
		this.bound = { groups: [], vbs: [] };
		this.pass.setViewport(0, 0, rp.width, rp.height, 0, 1);
		this.pass.setScissorRect(0, 0, rp.width, rp.height);
		this.applyDynamic();
	}

	// --- commands ------------------------------------------------------------

	run(k: any): void {
		if (!NO_VARIANT_CHANGE.has(k.c)) this.stateVer++;
		switch (k.c) {
			case "vkCmdBeginRenderPass2":
			case "vkCmdBeginRenderPass": {
				this.outside();
				const pass = this.c.get(k.renderPass, "renderPass");
				const fb = this.c.get(k.framebuffer, "framebuffer");
				this.rp = { pass, fb, subpass: 0, clear: k.clearValues || [], width: fb.width, height: fb.height, area: k.renderArea };
				this.beginSubpass();
				break;
			}
			case "vkCmdBeginRendering":
				this.outside();
				this.beginRendering(k);
				break;
			case "vkCmdEndRendering":
				this.endPass();
				this.rp = undefined;
				break;
			case "vkCmdSetCullMode":
				this.ext.cullMode = k.cullMode;
				break;
			case "vkCmdSetFrontFace":
				this.ext.frontFace = k.frontFace;
				break;
			case "vkCmdSetPrimitiveTopology":
				this.ext.topology = k.primitiveTopology;
				break;
			case "vkCmdSetDepthTestEnable":
				this.ext.depthTestEnable = k.depthTestEnable;
				break;
			case "vkCmdSetDepthWriteEnable":
				this.ext.depthWriteEnable = k.depthWriteEnable;
				break;
			case "vkCmdSetDepthCompareOp":
				this.ext.depthCompareOp = k.depthCompareOp;
				break;
			case "vkCmdSetStencilTestEnable":
				this.ext.stencilTestEnable = k.stencilTestEnable;
				break;
			case "vkCmdSetDepthBiasEnable":
				this.ext.depthBiasEnable = k.depthBiasEnable;
				break;
			case "vkCmdSetStencilOp": {
				const face = { failOp: k.failOp, passOp: k.passOp, depthFailOp: k.depthFailOp, compareOp: k.compareOp };
				const so = { ...(this.ext.stencilOp || {}) };
				if (k.faceMask & 1) so.front = face;
				if (k.faceMask & 2) so.back = face;
				this.ext.stencilOp = so;
				break;
			}
			case "vkCmdSetPrimitiveRestartEnable":
			case "vkCmdSetDepthBoundsTestEnable":
				break;
			case "vkCmdSetRasterizerDiscardEnable":
				if (k.rasterizerDiscardEnable) this.c.log("kwvk: vkCmdSetRasterizerDiscardEnable: unsupported");
				break;
			case "vkCmdNextSubpass2":
			case "vkCmdNextSubpass":
				this.endPass();
				this.rp!.subpass++;
				this.beginSubpass();
				break;
			case "vkCmdEndRenderPass2":
			case "vkCmdEndRenderPass":
				this.endPass();
				this.rp = undefined;
				break;
			case "vkCmdBindPipeline": {
				const p = this.c.get(k.pipeline, "pipeline");
				if (p.failed) throw new Error(`pipeline ${k.pipeline} cannot run: ${p.failed}`);
				if (p.kind === "compute") this.comp.pipeline = p;
				else {
					this.gfx.pipeline = p;
					// static state the pipeline carries
					const m = p.msg;
					if (!p.dynamic.has(0) && m.viewportState?.viewports?.[0]) this.viewport = m.viewportState.viewports[0];
					if (!p.dynamic.has(1) && m.viewportState?.scissors?.[0]) this.scissor = m.viewportState.scissors[0];
					if (!p.dynamic.has(4) && m.colorBlendState?.blendConstants) this.blend = m.colorBlendState.blendConstants;
					if (!p.dynamic.has(8) && m.depthStencilState?.front) this.stencilRef = m.depthStencilState.front.reference || 0;
					this.applyDynamic();
				}
				break;
			}
			case "vkCmdBindDescriptorSets": {
				const st = k.pipelineBindPoint === 1 ? this.comp : this.gfx;
				const offs: number[] = k.dynamicOffsets || [];
				let di = 0;
				(k.descriptorSets || []).forEach((id: number, i: number) => {
					const set = id ? this.c.get(id, "set") : undefined;
					const s = (k.firstSet || 0) + i;
					// other sets can change the refined layout (vk-host.ts refine); new offsets cannot
					if (st.sets[s] !== set) this.stateVer++;
					st.sets[s] = set;
					const n = set ? set.layout.dynamic.length : 0;
					st.dyn[s] = offs.slice(di, di + n);
					di += n;
				});
				break;
			}
			case "vkCmdBindVertexBuffers":
			case "vkCmdBindVertexBuffers2": {
				(k.buffers || []).forEach((id: number, i: number) => {
					const binding = (k.firstBinding || 0) + i;
					if (!id) return;
					this.vbs.set(binding, { buf: this.buffer(id).buf, offset: k.offsets?.[i] || 0 });
					if (k.strides?.length) this.ext.strides = { ...(this.ext.strides || {}), [binding]: k.strides[i] };
				});
				break;
			}
			case "vkCmdBindIndexBuffer": {
				if (k.indexType !== 0 && k.indexType !== 1) throw new Error(`index type ${k.indexType} is unsupported`);
				this.ib = { buf: this.buffer(k.buffer).buf, offset: k.offset || 0, format: k.indexType === 0 ? "uint16" : "uint32" };
				break;
			}
			case "vkCmdSetViewportWithCount":
			case "vkCmdSetViewport":
				if ((k.firstViewport || 0) === 0 && k.viewports?.[0]) this.viewport = k.viewports[0];
				this.applyDynamic();
				break;
			case "vkCmdSetScissorWithCount":
			case "vkCmdSetScissor":
				if ((k.firstScissor || 0) === 0 && k.scissors?.[0]) this.scissor = k.scissors[0];
				this.applyDynamic();
				break;
			case "vkCmdSetBlendConstants":
				this.blend = k.blendConstants;
				if (this.passKind === "render") this.pass.setBlendConstant({ r: this.blend![0], g: this.blend![1], b: this.blend![2], a: this.blend![3] });
				break;
			case "vkCmdSetStencilReference":
				this.stencilRef = k.reference || 0;
				if (this.passKind === "render") this.pass.setStencilReference(this.stencilRef);
				break;
			case "vkCmdSetStencilCompareMask":
				this.readMask = k.compareMask;
				break;
			case "vkCmdSetStencilWriteMask":
				this.writeMask = k.writeMask;
				break;
			case "vkCmdSetDepthBias":
				this.bias = [k.depthBiasConstantFactor || 0, k.depthBiasClamp || 0, k.depthBiasSlopeFactor || 0];
				break;
			case "vkCmdSetLineWidth":
			case "vkCmdSetDepthBounds":
			case "vkCmdPipelineBarrier":
			case "vkCmdSetEvent":
			case "vkCmdResetEvent":
			case "vkCmdWaitEvents":
			case "vkCmdPipelineBarrier2":
			case "vkCmdSetEvent2":
			case "vkCmdResetEvent2":
			case "vkCmdWaitEvents2":
			case "vkCmdWriteTimestamp2":
				break;
			case "vkCmdResetQueryPool": {
				this.outside();
				const p = this.c.get(k.queryPool, "queryPool");
				const first = k.firstQuery | 0;
				const n = Math.min(k.queryCount | 0, p.count - first);
				if (first >= 0 && n > 0) {
					this.enc.clearBuffer(p.results, first * 8, n * 8);
					p.avail.fill(0, first, first + n);
					p.written.fill(0, first, first + n);
				}
				break;
			}
			case "vkCmdBeginQuery": {
				const { p, q } = this.queryPool(k);
				if (p.type !== 0) {
					this.c.log("kwvk: vkCmdBeginQuery: pipeline statistics queries read as zeros");
					this.touchAvail(p, q);
					break;
				}
				if (this.passKind !== "render" || this.occlusionPool !== p) throw new Error("occlusion queries must begin inside a render pass (one pool per pass)");
				if (this.activeQuery !== undefined) this.pass.endOcclusionQuery();
				this.pass.beginOcclusionQuery(q);
				this.activeQuery = q;
				this.touch(p, q);
				break;
			}
			case "vkCmdEndQuery":
				if (this.activeQuery !== undefined && this.passKind === "render") {
					this.pass.endOcclusionQuery();
					this.activeQuery = undefined;
				}
				break;
			case "vkCmdWriteTimestamp":
			case "vkCmdWriteTimestamp2": {
				const { p, q } = this.queryPool(k);
				if (!p.set || p.type !== 2) {
					this.touchAvail(p, q);
					break;
				}
				if (this.passKind === "render") {
					this.c.log("kwvk: vkCmdWriteTimestamp: inside a render pass reads as zero");
					this.touchAvail(p, q);
					break;
				}
				if (this.passKind === "compute") this.endPass();
				// a pass of its own, written at its start (after the work before it), with one
				// no-op dispatch: backends that sample at stage boundaries may not sample an empty pass
				const tp = this.enc.beginComputePass({ label: "kwvk timestamp", timestampWrites: { querySet: p.set, beginningOfPassWriteIndex: q } });
				tp.setPipeline(nopPipeline(this.c));
				tp.dispatchWorkgroups(1);
				tp.end();
				this.touch(p, q);
				break;
			}
			case "vkCmdCopyQueryPoolResults": {
				this.outside();
				const p = this.c.get(k.queryPool, "queryPool");
				const d = this.buffer(k.dstBuffer).buf;
				const first = k.firstQuery | 0;
				const n = Math.min(k.queryCount | 0, p.count - first);
				const wide = (k.flags & 1) !== 0;
				const avail = (k.flags & 4) !== 0;
				const w = wide ? 8 : 4;
				const stride = k.stride || w * (avail ? 2 : 1);
				if (stride & 3 || (k.dstOffset || 0) & 3) throw new Error("unaligned query copy");
				resolveQueries(this.dev, this.enc, p, first, n, this.scratch);
				const one = this.up.alloc(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]), 4);
				for (let i = 0; i < n; i++) {
					const at = (k.dstOffset || 0) + i * stride;
					if (at + w * (avail ? 2 : 1) > d.size) throw new Error("query copy past the buffer");
					this.enc.copyBufferToBuffer(p.results, (first + i) * 8, d, at, w);
					if (avail) {
						if (p.avail[first + i]) this.enc.copyBufferToBuffer(this.up.buf, one, d, at + w, w);
						else this.enc.clearBuffer(d, at + w, w);
					}
				}
				break;
			}
			case "vkCmdPushConstants": {
				const v: number[] = k.values || [];
				const off = k.offset || 0;
				if (off + v.length > 256) throw new Error("push constants past 256 bytes");
				this.push.set(v, off);
				this.pushVer++;
				break;
			}
			case "vkCmdDraw":
				if ((k.firstVertex || k.firstInstance) && this.gfx.pipeline?.usesBase) this.baseWarn();
				if (this.fan()) {
					if (!(k.vertexCount >= 0 && k.vertexCount <= 1 << 22)) throw new Error("fan vertex count out of range");
					if (this.flushDraw(true, this.fanIndices(k.vertexCount))) {
						this.pass.drawIndexed(3 * Math.max(0, k.vertexCount - 2), k.instanceCount ?? 1, 0, k.firstVertex || 0, k.firstInstance || 0);
					}
				} else if (this.flushDraw(false)) this.pass.draw(k.vertexCount, k.instanceCount ?? 1, k.firstVertex || 0, k.firstInstance || 0);
				break;
			case "vkCmdDrawIndexed":
				if ((k.vertexOffset || k.firstInstance) && this.gfx.pipeline?.usesBase) this.baseWarn();
				if (this.fan()) {
					// rewritten as a list before the pass (prepareFans), for the index buffer bound now
					const f = this.fanLists.get(this.index);
					const ib = this.ib;
					if (f && ib && f.ib.buf === ib.buf && f.ib.offset === ib.offset && f.ib.format === ib.format) {
						if (this.flushDraw(true, { buf: f.buf, offset: f.offset, format: "uint32" })) this.pass.drawIndexed(f.count, k.instanceCount ?? 1, 0, k.vertexOffset || 0, k.firstInstance || 0);
						break;
					}
					if (k.indexCount >= 3) this.c.log("kwvk: vkCmdDrawIndexed: an indexed triangle fan not rewritten before its render pass (drawn as a list)");
				}
				if (this.flushDraw(true)) this.pass.drawIndexed(k.indexCount, k.instanceCount ?? 1, k.firstIndex || 0, k.vertexOffset || 0, k.firstInstance || 0);
				break;
			case "vkCmdDrawIndirect":
			case "vkCmdDrawIndexedIndirect": {
				const indexed = k.c === "vkCmdDrawIndexedIndirect";
				this.flushDraw(indexed);
				const b = this.buffer(k.buffer).buf;
				// drawCount records `stride` bytes apart (multiDrawIndirect), one
				// WebGPU indirect draw each; stride is unused (may be 0) at one.
				// Only whole records inside the buffer are drawn (Vulkan's rule)
				const rec = indexed ? 20 : 16;
				const stride = Math.max(4, k.stride || rec);
				const n = Math.max(0, Math.min(k.drawCount ?? 1, Math.floor((b.size - (k.offset || 0) - rec) / stride) + 1));
				if (this.fan()) this.c.log("kwvk: indirect draws of triangle fans are unsupported (drawn as lists)");
				for (let i = 0; i < n; i++) {
					if (indexed) this.pass.drawIndexedIndirect(b, (k.offset || 0) + i * stride);
					else this.pass.drawIndirect(b, (k.offset || 0) + i * stride);
				}
				break;
			}
			case "vkCmdDispatch": {
				// a workgroup shrunk to the device's limits runs more groups (vk-shader.ts dispatchScale)
				const ds = this.comp.pipeline?.stage?.res?.dispatchScale || [1, 1, 1];
				const pass = this.flushDispatch();
				if (!noGpu()) pass.dispatchWorkgroups((k.groupCountX ?? 1) * ds[0], (k.groupCountY ?? 1) * ds[1], (k.groupCountZ ?? 1) * ds[2]);
				this.copyBack();
				break;
			}
			case "vkCmdDispatchIndirect":
				// the group counts live in GPU memory and cannot be scaled: 1/k of the work would run
				if (this.comp.pipeline?.stage?.res?.dispatchScale) throw new Error("vkCmdDispatchIndirect of a pipeline whose workgroup was split to fit the device (dispatchScale) is unsupported");
				this.flushDispatch().dispatchWorkgroupsIndirect(this.buffer(k.buffer).buf, k.offset || 0);
				this.copyBack();
				break;
			case "vkCmdCopyBuffer": {
				this.outside();
				const sb = this.buffer(k.srcBuffer);
				const db = this.buffer(k.dstBuffer);
				const s = sb.buf;
				const d = db.buf;
				for (const r of k.regions || []) {
					const so = r.srcOffset || 0;
					const dO = r.dstOffset || 0;
					const size = r.size;
					if (!(so >= 0 && dO >= 0 && size >= 0 && so + size <= sb.size && dO + size <= db.size)) throw new Error("buffer copy out of range");
					if (!(so % 4) && !(dO % 4)) {
						// WebGPU copies whole words: the aligned part directly, an unaligned tail exactly (byteCopy)
						const head = alignDown(size, 4);
						if (head) this.enc.copyBufferToBuffer(s, so, d, dO, head);
						if (size % 4) this.byteCopy(s, so + head, d, dO + head, size % 4);
					} else this.byteCopy(s, so, d, dO, size);
				}
				break;
			}
			case "vkCmdCopyBufferToImage":
				this.outside();
				for (const r of k.regions || []) this.copyBufImg(true, k.srcBuffer, k.dstImage, r);
				break;
			case "vkCmdCopyImageToBuffer":
				this.outside();
				for (const r of k.regions || []) this.copyBufImg(false, k.dstBuffer, k.srcImage, r);
				break;
			case "vkCmdCopyImage": {
				this.outside();
				const s = this.c.get(k.srcImage, "image");
				const d = this.c.get(k.dstImage, "image");
				for (const r of k.regions || []) this.copyImg(s, d, r);
				break;
			}
			case "vkCmdBlitImage":
				this.outside();
				this.blit(k);
				break;
			case "vkCmdResolveImage":
				this.outside();
				this.resolve(k);
				break;
			case "vkCmdClearColorImage":
				this.outside();
				this.clearImage(k.image, k.ranges, k.color, undefined);
				break;
			case "vkCmdClearDepthStencilImage":
				this.outside();
				this.clearImage(k.image, k.ranges, undefined, k.depthStencil || {});
				break;
			case "vkCmdClearAttachments":
				this.clearAttachments(k);
				break;
			case "vkCmdUpdateBuffer": {
				this.outside();
				const data = Uint8Array.from(k.data || []);
				const size = (data.length + 3) & ~3;
				const padded = new Uint8Array(size);
				padded.set(data);
				const off = this.up.alloc(padded, 4);
				this.enc.copyBufferToBuffer(this.up.buf, off, this.buffer(k.dstBuffer).buf, k.dstOffset || 0, size);
				break;
			}
			case "vkCmdFillBuffer": {
				this.outside();
				const b = this.buffer(k.dstBuffer);
				const off = k.dstOffset || 0;
				const size = isWhole(k.size) ? alignDown(b.size - off, 4) : k.size;
				if (!(off >= 0 && size >= 0 && off + size <= b.buf.size)) throw new Error("fill out of range");
				if (!k.data) this.enc.clearBuffer(b.buf, off, size);
				else {
					const words = new Uint32Array(size >> 2).fill(k.data >>> 0);
					const src = this.up.alloc(new Uint8Array(words.buffer), 4);
					this.enc.copyBufferToBuffer(this.up.buf, src, b.buf, off, size);
				}
				break;
			}
			default:
				throw new Error("unsupported command");
		}
	}
}

/**
 * Replay a submit; resolves when the GPU has finished it. A command that
 * cannot be encoded throws VkDeviceLost naming it (the submit is dropped).
 */
export function runSubmit(c: Conn, cmds: any[]): Promise<void> {
	if (!Array.isArray(cmds)) throw new VkDeviceLost("cmds is not an array");
	const t0 = performance.now();
	const ex = new Exec(c, cmds);
	const abandon = (what: string, e: unknown) => {
		try {
			if (ex.pass) ex.pass.end();
		} catch {}
		try {
			ex.up.buf.unmap();
			ex.up.buf.destroy();
		} catch {}
		for (const t of ex.scratch) {
			try {
				t.destroy();
			} catch {}
		}
		c.stats.encodeMs += performance.now() - t0;
		return new VkDeviceLost(`${what}: ${(e as Error)?.message ?? e}`);
	};
	for (let i = 0; i < cmds.length; i++) {
		const k = cmds[i];
		ex.index = i;
		try {
			if (!k || typeof k !== "object" || typeof k.c !== "string") throw new Error("bad command");
			ex.run(k);
		} catch (e) {
			throw abandon(`command ${i} (${typeof k?.c === "string" ? k.c.slice(0, 64) : "?"})`, e);
		}
	}
	try {
		if (ex.pass) ex.endPass();
	} catch (e) {
		throw abandon("the end of the command list", e);
	}
	ex.up.buf.unmap();
	c.dev.queue.submit([ex.enc.finish()]);
	ex.up.buf.destroy();
	c.stats.encodeMs += performance.now() - t0;
	const done = c.dev.queue.onSubmittedWorkDone();
	if (ex.scratch.length) done.then(() => ex.scratch.forEach((t) => t.destroy()));
	return done;
}

/**
 * Resolve the queries of pool p in [first, first + n) that the query set
 * holds values of into p.results, with one resolveQuerySet. Queries are
 * resolved when they are read (getQueryPoolResults, vkCmdCopyQueryPoolResults),
 * not by the submits that wrote them: WebGPU converts timestamps to
 * nanoseconds at the resolve, and a backend's conversion may change between
 * resolves (Dawn on Metal refines its tick period while it runs), so the
 * timestamps of one read, whichever submits wrote them, take one conversion.
 * The resolve buffer goes to `scratch` (destroyed by the caller).
 */
export function resolveQueries(dev: any, enc: any, p: any, first: number, n: number, scratch: any[]): void {
	if (!p.set || first < 0) return;
	let lo = -1, hi = -1;
	for (let i = first; i < first + n; i++) {
		if (!p.written[i]) continue;
		if (lo < 0) lo = i;
		hi = i;
	}
	if (lo < 0) return;
	const buf = dev.createBuffer({ size: (hi - lo + 1) * 8, usage: BU.QUERY_RESOLVE | BU.COPY_SRC, label: "kwvk query resolve" });
	scratch.push(buf);
	enc.resolveQuerySet(p.set, lo, hi - lo + 1, buf, 0);
	// only the written runs: the others between them may hold values from before a reset
	for (let i = lo; i <= hi; ) {
		if (!p.written[i]) {
			i++;
			continue;
		}
		let j = i;
		while (j + 1 <= hi && p.written[j + 1]) j++;
		enc.copyBufferToBuffer(buf, (i - lo) * 8, p.results, i * 8, (j - i + 1) * 8);
		i = j + 1;
	}
}

// --- helper pipelines --------------------------------------------------------

/** A compute pipeline that does nothing (the dispatch that keeps a timestamp's pass from being empty). */
function nopPipeline(c: Conn): any {
	let h = c.r.helpers.get("nop");
	if (h) return h;
	const module = c.dev.createShaderModule({ code: "@compute @workgroup_size(1) fn main() {}" });
	h = c.dev.createComputePipeline({ layout: c.dev.createPipelineLayout({ bindGroupLayouts: [] }), compute: { module, entryPoint: "main" } });
	c.r.helpers.set("nop", h);
	return h;
}

/**
 * prepareFans' rewrite: one invocation walks a fan draw's indices (u16 or
 * u32 words of `src` from byte `start`) and writes (first, previous,
 * current) for each vertex past a fan's second; a restart index (with
 * restart on) starts a new fan; the slots left over are degenerate.
 */
function fanPipeline(c: Conn): any {
	let h = c.r.helpers.get("fanlists");
	if (h) return h;
	const dev = c.dev;
	const module = dev.createShaderModule({
		code: `
struct P { start: u32, count: u32, isz: u32, restart: u32, words: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<uniform> p: P;
fn index(k: u32) -> u32 {
	let b = p.start + k * p.isz;
	let w = b >> 2u;
	if (w >= p.words) { return 0u; }
	if (p.isz == 2u) { return (src[w] >> ((b & 2u) * 8u)) & 0xffffu; }
	return src[w];
}
@compute @workgroup_size(1) fn main() {
	let rv = select(0xffffffffu, 0xffffu, p.isz == 2u);
	var o = 0u;
	var have = 0u;
	var first = 0u;
	var prev = 0u;
	for (var k = 0u; k < p.count; k++) {
		let v = index(k);
		if (p.restart != 0u && v == rv) { have = 0u; continue; }
		if (have == 0u) { first = v; }
		if (have >= 2u) {
			dst[o] = first;
			dst[o + 1u] = prev;
			dst[o + 2u] = v;
			o += 3u;
		}
		prev = v;
		have += 1u;
	}
	for (; o < 3u * (p.count - 2u); o++) { dst[o] = first; }
}`,
		label: "kwvk fan lists",
	});
	const bgl = dev.createBindGroupLayout({
		entries: [
			{ binding: 0, visibility: 4, buffer: { type: "read-only-storage" } },
			{ binding: 1, visibility: 4, buffer: { type: "storage" } },
			{ binding: 2, visibility: 4, buffer: { type: "uniform" } },
		],
	});
	const pipeline = dev.createComputePipeline({ layout: dev.createPipelineLayout({ bindGroupLayouts: [bgl] }), compute: { module, entryPoint: "main" } });
	h = { pipeline, bgl };
	c.r.helpers.set("fanlists", h);
	return h;
}

function byteCopyPipeline(c: Conn): any {
	let h = c.r.helpers.get("bytecopy");
	if (h) return h;
	const dev = c.dev;
	const module = dev.createShaderModule({
		code: `
struct P { srcOff: u32, dstOff: u32, size: u32, pad: u32 }
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<uniform> p: P;
fn srcByte(i: u32) -> u32 { let b = p.srcOff + i; return (src[b >> 2u] >> ((b & 3u) * 8u)) & 0xffu; }
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
	let w = (p.dstOff >> 2u) + id.x;
	if (w * 4u >= p.dstOff + p.size) { return; }
	var v = dst[w];
	for (var k = 0u; k < 4u; k++) {
		let b = w * 4u + k;
		if (b >= p.dstOff && b < p.dstOff + p.size) {
			v = (v & ~(0xffu << (k * 8u))) | (srcByte(b - p.dstOff) << (k * 8u));
		}
	}
	dst[w] = v;
}
`,
	});
	const bgl = dev.createBindGroupLayout({
		entries: [
			{ binding: 0, visibility: 4, buffer: { type: "read-only-storage" } },
			{ binding: 1, visibility: 4, buffer: { type: "storage" } },
			{ binding: 2, visibility: 4, buffer: { type: "uniform" } },
		],
	});
	const pipeline = dev.createComputePipeline({ layout: dev.createPipelineLayout({ bindGroupLayouts: [bgl] }), compute: { module, entryPoint: "main" } });
	h = { pipeline, bgl };
	c.r.helpers.set("bytecopy", h);
	return h;
}

function blitPipeline(c: Conn, format: string, linear: boolean): any {
	const key = `blit:${format}:${linear}`;
	let h = c.r.helpers.get(key);
	if (h) return h;
	const dev = c.dev;
	const module = dev.createShaderModule({
		code: `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
@group(0) @binding(2) var<uniform> u: vec4f;
struct VO { @builtin(position) p: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
	let c = vec2f(f32(i & 1u), f32(i >> 1u));
	var o: VO;
	o.p = vec4f(c.x * 2.0 - 1.0, 1.0 - c.y * 2.0, 0.0, 1.0);
	o.uv = mix(u.xy, u.zw, c);
	return o;
}
@fragment fn fs(v: VO) -> @location(0) vec4f { return textureSampleLevel(t, s, v.uv, 0.0); }
`,
	});
	const bgl = dev.createBindGroupLayout({
		entries: [
			{ binding: 0, visibility: 2, texture: { sampleType: linear ? "float" : "unfilterable-float" } },
			{ binding: 1, visibility: 2, sampler: { type: linear ? "filtering" : "non-filtering" } },
			{ binding: 2, visibility: 1, buffer: { type: "uniform" } },
		],
	});
	const pipeline = dev.createRenderPipeline({
		layout: dev.createPipelineLayout({ bindGroupLayouts: [bgl] }),
		vertex: { module, entryPoint: "vs" },
		fragment: { module, entryPoint: "fs", targets: [{ format }] },
		primitive: { topology: "triangle-strip" },
	});
	const sampler = dev.createSampler({ magFilter: linear ? "linear" : "nearest", minFilter: linear ? "linear" : "nearest" });
	h = { pipeline, bgl, sampler };
	c.r.helpers.set(key, h);
	return h;
}

function clearPipeline(c: Conn, sp: any, target: number, aspect: number): any {
	const key = `clear:${sp.key}:${target}:${aspect}`;
	let h = c.r.helpers.get(key);
	if (h) return h;
	const dev = c.dev;
	const outs: string[] = [];
	const sets: string[] = [];
	sp.colorFormats.forEach((f: string | null, i: number) => {
		if (!f) return;
		const kind = texFormatInfo(f)?.kind;
		const ty = kind === "uint" ? "vec4u" : kind === "sint" ? "vec4i" : "vec4f";
		outs.push(`@location(${i}) o${i}: ${ty}`);
		sets.push(`o.o${i} = bitcast<${ty}>(u.c);`);
	});
	const depth = !!sp.depthFormat && hasDepth(sp.depthFormat);
	if (depth) {
		outs.push("@builtin(frag_depth) d: f32");
		sets.push("o.d = u.d.x;");
	}
	const code = `
struct U { c: vec4u, d: vec4f }
@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
	let c = vec2f(f32(i & 1u), f32(i >> 1u));
	return vec4f(c.x * 2.0 - 1.0, 1.0 - c.y * 2.0, 0.0, 1.0);
}
${outs.length ? `struct FO { ${outs.join(", ")} }
@fragment fn fs() -> FO { var o: FO; ${sets.join(" ")} return o; }` : "@fragment fn fs() {}"}
`;
	const module = dev.createShaderModule({ code });
	const bgl = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: 3, buffer: { type: "uniform" } }] });
	const desc: any = {
		layout: dev.createPipelineLayout({ bindGroupLayouts: [bgl] }),
		vertex: { module, entryPoint: "vs" },
		fragment: { module, entryPoint: "fs", targets: sp.colorFormats.map((f: string | null, i: number) => (f ? { format: f, writeMask: i === target ? 15 : 0 } : null)) },
		primitive: { topology: "triangle-strip" },
		multisample: { count: sp.samples },
	};
	if (sp.depthFormat) {
		const stencil = hasStencil(sp.depthFormat) && aspect & 4;
		const face = { compare: "always", passOp: stencil ? "replace" : "keep", failOp: "keep", depthFailOp: "keep" };
		desc.depthStencil = {
			format: sp.depthFormat,
			depthWriteEnabled: depth && !!(aspect & 2),
			depthCompare: "always",
			stencilFront: face,
			stencilBack: face,
			stencilWriteMask: stencil ? 0xff : 0,
		};
		if (!hasStencil(sp.depthFormat)) {
			delete desc.depthStencil.stencilFront;
			delete desc.depthStencil.stencilBack;
			delete desc.depthStencil.stencilWriteMask;
		}
	}
	h = { pipeline: dev.createRenderPipeline(desc), bgl };
	c.r.helpers.set(key, h);
	return h;
}
