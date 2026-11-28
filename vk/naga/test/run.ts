// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Tests kwvk-naga.wasm through js/core/vk-shader.ts: translates the SPIR-V
// in shaders/ (compiled from the GLSL next to it by compile.sh), checks the
// WGSL and the reflection, then validates every output in a real WebGPU
// (headless Chrome on SwiftShader): createShaderModule, getCompilationInfo
// and pipelines with explicit layouts built from the reflected bindings.
//
//   node vk/naga/test/run.ts [--no-gpu]      exit 0 on success, 1 on failure

import { readdirSync, readFileSync } from "node:fs";
import { inChrome } from "./chrome.ts";
import { loadVkShader, type VkShaderOpts, type VkShaderResult } from "../../../js/core/vk-shader.ts";

const here = new URL("./shaders/", import.meta.url);
const wasm = new URL("../../../vendor/build/vk/kwvk-naga.wasm", import.meta.url);
const t = await loadVkShader(wasm);

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? `: ${detail}` : ""}`);
};

const out: Record<string, VkShaderResult> = {};
const run = (name: string, file: string, opts: VkShaderOpts) => {
	try {
		out[name] = t.translate(readFileSync(new URL(file, here)), opts);
		return out[name];
	} catch (e) {
		check(`${name} translates`, false, (e as Error).message);
		return undefined;
	}
};
const has = (r: VkShaderResult | undefined, re: RegExp) => !!r && re.test(r.wgsl);

const cv = run("cube.vert", "cube.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true });
check("cube.vert: UBO at @binding(0)", has(cv, /@group\(0\) @binding\(0\)\s*var<uniform>/));
check("cube.vert: flipY negates position.y", has(cv, /gl_Position\.y = -\(/));
check("cube.vert: reflection", JSON.stringify(cv?.bindings) === JSON.stringify([{ set: 0, binding: 0, group: 0, wgslBinding: 0, kind: "uniform" }]), JSON.stringify(cv?.bindings));
const cvn = run("cube.vert.noflip", "cube.vert.spv", { stage: "vertex", entryPoint: "main", flipY: false });
check("cube.vert: no flip without flipY", !!cvn && !has(cvn, /\.y = -\(/));

const cf = run("cube.frag", "cube.frag.spv", { stage: "fragment", entryPoint: "main" });
check("cube.frag: derivative_uniformity off", has(cf, /^diagnostic\(off, derivative_uniformity\);/));
check("cube.frag: texture at 2, sampler at 3", has(cf, /@binding\(2\)\s*var tex: texture_2d<f32>/) && has(cf, /@binding\(3\)\s*var tex_sampler: sampler;/));
check("cube.frag: reflection", cf?.bindings.length === 2 && cf.bindings[0].kind === "texture" && cf.bindings[0].binding === 1 && cf.bindings[0].sampleType === "float" && cf.bindings[1].kind === "sampler" && cf.bindings[1].wgslBinding === 3, JSON.stringify(cf?.bindings));

const pv = run("push.vert", "push.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true, pushGroup: 1 });
check("push.vert: push constants at @group(1) @binding(0)", has(pv, /@group\(1\) @binding\(0\)\s*var<uniform> pc/));
check("push.vert: pushConstantSize 80", pv?.pushConstantSize === 80, String(pv?.pushConstantSize));
check("push.vert: gl_PointSize dropped from outputs", !!pv && !/point_size/.test(pv.wgsl));
check("push.vert: no bindings", pv?.bindings.length === 0, JSON.stringify(pv?.bindings));

const sf = run("spec.frag", "spec.frag.spv", { stage: "fragment", entryPoint: "main", spec: { 0: 2.5, 2: true, 99: 1 } });
check("spec.frag: no override left", !!sf && !/override/.test(sf.wgsl));
check("spec.frag: values baked", has(sf, /scale: f32 = 2\.5f/) && has(sf, /invert: bool = true/) && has(sf, /count: i32 = 2i/));
check("spec.frag: set 1 binding 2 -> @group(1) @binding(4)", has(sf, /@group\(1\) @binding\(4\)/));
const sd = run("spec.frag.default", "spec.frag.spv", { stage: "fragment", entryPoint: "main" });
check("spec.frag: defaults baked", has(sd, /scale: f32 = 1f/) && has(sd, /invert: bool = false/));

const bc = run("buffer.comp", "buffer.comp.spv", { stage: "compute", entryPoint: "main" });
check("buffer.comp: storage kinds", bc?.bindings.map((b) => `${b.wgslBinding}:${b.kind}`).join() === "0:read-only-storage,2:storage", JSON.stringify(bc?.bindings));
check("buffer.comp: runtime array", has(bc, /array<f32>/) && has(bc, /arrayLength/));
// Older glslang (llama.cpp's release builds) marks `readonly buffer` only on the block's members:
// the same module without the variables' NonWritable must still be read-only.
{
	const w = new Uint32Array(Uint8Array.from(readFileSync(new URL("buffer.comp.spv", here))).buffer);
	const kept: number[] = [...w.subarray(0, 5)];
	for (let i = 5; i < w.length; i += w[i] >>> 16) {
		const n = w[i] >>> 16;
		if (!((w[i] & 0xffff) === 71 && n === 3 && w[i + 2] === 24)) kept.push(...w.subarray(i, i + n)); // OpDecorate %var NonWritable
	}
	let mo: VkShaderResult | undefined;
	try { mo = t.translate(new Uint8Array(new Uint32Array(kept).buffer), { stage: "compute", entryPoint: "main" }); } catch (e) { check("buffer.comp, member-only NonWritable: translates", false, (e as Error).message); }
	check("buffer.comp, member-only NonWritable: still read-only", kept.length < w.length && mo?.bindings.map((b) => `${b.wgslBinding}:${b.kind}`).join() === "0:read-only-storage,2:storage", `${w.length - kept.length} words dropped; ${JSON.stringify(mo?.bindings)}`);
}

// Storage buffers without `readonly` that the module never writes are read-only (a vertex stage
// cannot have read_write storage); stored, atomic, or sharing a binding with a written view: writable.
for (const f of ["unwritten.vert.spv", "unwritten.vert.opt.spv"]) {
	const r = run(f, f, { stage: "vertex", entryPoint: "main", flipY: true });
	check(`${f}: unwritten buffers read-only`, r?.bindings.map((b) => `${b.binding}:${b.kind}`).join() === "0:read-only-storage,1:read-only-storage" && !/read_write/.test(r.wgsl), JSON.stringify(r?.bindings));
}
for (const f of ["unwritten.comp.spv", "unwritten.comp.opt.spv"]) {
	const r = run(f, f, { stage: "compute", entryPoint: "main" });
	const kinds = Object.fromEntries((r?.bindings ?? []).map((b) => [b.binding, b.kind]));
	check(`${f}: read-only only where never written`, JSON.stringify(kinds) === JSON.stringify({ 0: "read-only-storage", 1: "storage", 2: "storage", 3: "storage", 4: "read-only-storage" }), JSON.stringify(r?.bindings));
}
// Only the resources the entry point reaches: not a never-used texture, a block only an uncalled
// function reads, or a texture behind a false specialization constant (until it is true).
for (const f of ["unused.frag.spv", "unused.frag.opt.spv"]) {
	const r = run(f, f, { stage: "fragment", entryPoint: "main" });
	check(`${f}: unused resources not reflected nor declared`, r?.bindings.map((b) => `${b.set}.${b.binding}:${b.kind}`).join() === "0.0:texture,0.0:sampler" && !/texture12|Unused|detail/.test(r.wgsl), JSON.stringify(r?.bindings));
	const d = run(`${f}.detail`, f, { stage: "fragment", entryPoint: "main", spec: { 0: true } });
	check(`${f}: the specialized branch's texture reflected`, d?.bindings.map((b) => `${b.set}.${b.binding}:${b.kind}`).join() === "0.0:texture,0.0:sampler,0.1:texture,0.1:sampler", JSON.stringify(d?.bindings));
}
// glslang -g: OpLine among the globals (Taisei), dropped.
for (const f of ["debuglines.g.frag.spv", "debuglines.g.frag.opt.spv"]) {
	const r = run(f, f, { stage: "fragment", entryPoint: "main" });
	check(`${f}: translates with OpLine among the globals`, r?.bindings.length === 3, JSON.stringify(r?.bindings));
}
// OpSpecConstantOp: Select of floats and halves (vkQuake), vector ops on the workgroup size, signed arithmetic.
const consts = (r: VkShaderResult | undefined) => [...(r?.wgsl ?? "").matchAll(/^const (\w+): [^=]+ = ([^;]+);/gm)].map((m) => `${m[1]}=${m[2]}`).join(" ");
for (const f of ["specops.comp.spv", "specops.comp.opt.spv"]) {
	const d = run(f, f, { stage: "compute", entryPoint: "main" });
	const want = "quality=1u N=5u scale=2f hscale=2f scaled=false lm=2f steps=2u wg2_=vec2<u32>(3u, 4u) sq=-4i";
	check(`${f}: defaults folded`, consts(d) === want && has(d, /@workgroup_size\(1, 2, 1\)/) && has(d, /array<f32, 5>/), consts(d));
	const r = run(`${f}.spec`, f, { stage: "compute", entryPoint: "main", spec: { 0: 3, 1: true, 2: 8 } });
	const want2 = "quality=3u N=13u scale=1f hscale=1f scaled=true lm=8f steps=3u wg2_=vec2<u32>(17u, 4u) sq=-2i";
	check(`${f}: specialized values folded`, consts(r) === want2 && has(r, /@workgroup_size\(8, 2, 1\)/) && has(r, /array<f32, 13>/), consts(r));
}

// isinf / isnan (WGSL has neither) as tests on the bits; gl_SampleMask (int[1]) as WGSL's u32 sample_mask.
for (const f of ["isinf.frag.spv", "isinf.frag.opt.spv"]) {
	const r = run(f, f, { stage: "fragment", entryPoint: "main" });
	check(`${f}: isinf/isnan on the bits`, has(r, /2139095040u/) && has(r, /2147483647u/) && !!r && !/\b(isinf|isnan)\(/.test(r.wgsl), r?.wgsl.slice(0, 400));
}
for (const f of ["samplemask.frag.spv", "samplemask.frag.opt.spv"]) {
	const r = run(f, f, { stage: "fragment", entryPoint: "main", pushGroup: 0 });
	check(`${f}: gl_SampleMask as a u32 sample_mask output`, has(r, /@builtin\(sample_mask\) \w+: u32/), r?.wgsl.slice(0, 400));
}

const ic = run("image.comp", "image.comp.spv", { stage: "compute", entryPoint: "main" });
const ib = ic?.bindings[0];
check("image.comp: storage texture", ib?.kind === "storage-texture" && ib.format === "rgba8unorm" && ib.access === "write-only" && ib.wgslBinding === 6 && ib.viewDimension === "2d", JSON.stringify(ic?.bindings));

const sh = run("shadow.frag", "shadow.frag.spv", { stage: "fragment", entryPoint: "main" });
check("shadow.frag: depth texture + comparison sampler", has(sh, /texture_depth_2d/) && has(sh, /sampler_comparison/) && has(sh, /textureSampleCompare/));
check("shadow.frag: reflection", sh?.bindings.map((b) => `${b.wgslBinding}:${b.kind}:${b.sampleType ?? ""}`).join() === "0:texture:depth,1:comparison-sampler:,2:texture:float,3:sampler:", JSON.stringify(sh?.bindings));

const mv = run("mrt.vert", "mrt.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true });
check("mrt.vert: flipY with a vertex output block", has(mv, /\.y = -\(/));
const mf = run("mrt.frag", "mrt.frag.spv", { stage: "fragment", entryPoint: "main" });
check("mrt.frag: two outputs", has(mf, /@location\(1\)/));

const fp = run("funcparam.frag", "funcparam.frag.spv", { stage: "fragment", entryPoint: "main" });
check("funcparam.frag: sampler2D parameter split", has(fp, /s: texture_2d<f32>, s_sampler: sampler/) && has(fp, /\(a, a_sampler,/));
check("funcparam.frag: reflection", fp?.bindings.map((b) => `${b.binding}/${b.wgslBinding}:${b.kind}`).join() === "0/0:texture,0/1:sampler,1/2:texture,1/3:sampler", JSON.stringify(fp?.bindings));
const lv = run("lit.vert", "lit.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true });
check("lit.vert: mat3 UBO, flat int output", has(lv, /mat3x3<f32>/) && has(lv, /@interpolate\(flat\) member_1: i32/));
run("lit.frag", "lit.frag.spv", { stage: "fragment", entryPoint: "main" });
const s1 = run("std140.frag", "std140.frag.spv", { stage: "fragment", entryPoint: "main", pushGroup: 1 });
check("std140.frag: float[4] stride 16 wrapped", has(s1, /weights: array<type_\d+, 4>/) && has(s1, /w\.weights\[\w+\]\.member;/));
check("std140.frag: push block size 16", s1?.pushConstantSize === 16, String(s1?.pushConstantSize));
const of = run("offset.frag", "offset.frag.spv", { stage: "fragment", entryPoint: "main", pushGroup: 1 });
check("offset.frag: push range at offset 64 padded", has(of, /_kwvk_pad: array<vec4<u32>, 4>,\s*@size\(32\) color: vec4<f32>,\s*k: f32,/));
check("offset.frag: UBO explicit offsets", has(of, /@size\(48\) a: vec4<f32>,\s*@size\(32\) b: vec4<f32>,\s*c: f32,/));
check("offset.frag: pushConstantSize covers offset 96", of?.pushConstantSize === 112, String(of?.pushConstantSize));
const sw = run("specwg.comp", "specwg.comp.spv", { stage: "compute", entryPoint: "main", spec: { 0: 64, 1: 8 } });
check("specwg.comp: workgroup size from a spec constant", has(sw, /@workgroup_size\(64, 1, 1\)/));
check("specwg.comp: shared array sized by a spec constant expression", has(sw, /var<workgroup> tmp: array<f32, 17>;/));
// Only what the entry point uses is reflected: the integer textures are read with texelFetch, so their sampler halves are not.
const tx = run("textures.frag", "textures.frag.spv", { stage: "fragment", entryPoint: "main" });
check("textures.frag: kinds", tx?.bindings.map((b) => `${b.wgslBinding}:${b.kind}:${b.viewDimension ?? ""}:${b.sampleType ?? ""}`).join() === "0:texture:2d:float,2:sampler::,4:texture:cube:float,5:sampler::,6:texture:3d:float,7:sampler::,8:texture:2d-array:float,9:sampler::,10:texture:2d:uint,12:texture:2d:sint,0:storage::", JSON.stringify(tx?.bindings));
const cl = run("clip.vert", "clip.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true });
check("clip.vert: clip_distances enabled", has(cl, /^enable clip_distances;/));
const ly = run("layout.frag", "layout.frag.spv", { stage: "fragment", entryPoint: "main" });
check("layout.frag: std140 struct array padded to stride 16", has(ly, /struct (\w+) \{\s*@size\(16\) a: f32,\s*\}/) && has(ly, /@size\(16\) f: f32,\s*s: array<\w+, 3>,/));
check("layout.frag: row-major matrix transposed on load", has(ly, /transpose\(/));

const arraysAll = { "0.0": { base: 0, count: 3 }, "0.1": { base: 6, count: 2 }, "0.2": { base: 10, count: 2 }, "1.0": { base: 0, count: 2 } };
// samplers[0] only pairs with a texelFetch: unused, not reflected.
const ar = run("arrays.frag", "arrays.frag.spv", { stage: "fragment", entryPoint: "main", arrays: arraysAll });
check("arrays.frag: reflection with arrayIndex", ar?.bindings.map((b) => `${b.set}.${b.binding}[${b.arrayIndex}]@${b.wgslBinding}:${b.kind}`).join() === "0.0[0]@0:texture,0.0[0]@1:sampler,0.0[1]@2:texture,0.0[1]@3:sampler,0.0[2]@4:texture,0.0[2]@5:sampler,0.1[0]@6:texture,0.1[1]@8:texture,0.2[1]@12:sampler,1.0[0]@0:uniform,1.0[1]@2:uniform", JSON.stringify(ar?.bindings));
check("arrays.frag: constant index resolved", has(ar, /textureSample\(tex_1_, tex_1_sampler, _e\d+\)/) && has(ar, /textureSample\(images_0_, samplers_1_,/));
check("arrays.frag: dynamic index switches", has(ar, /case 2: \{\s*let _e\d+ = textureSample\(tex_2_, tex_2_sampler/) && has(ar, /default: \{\s*let _e\d+ = ubos_0_\.color;/) && !!ar && !/enable wgpu_binding_array/.test(ar.wgsl));
try {
	t.translate(readFileSync(new URL("arrays.frag.spv", here)), { stage: "fragment", entryPoint: "main" });
	check("arrays.frag: without opts.arrays throws", false);
} catch (e) {
	check("arrays.frag: without opts.arrays throws", /opts\.arrays/.test((e as Error).message), (e as Error).message);
}

const gv = run("gtkish.vert", "gtkish.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true, spec: { 0: 1 } });
check("gtkish.vert: array varyings flattened to consecutive locations", [1, 2, 3, 4].every((l) => has(gv, new RegExp(`@location\\(${l}\\) @interpolate\\(flat\\) \\w+: vec4<f32>,`))));
const gf = run("gtkish.frag", "gtkish.frag.spv", { stage: "fragment", entryPoint: "main", spec: { 1: 2 }, arrays: { "0.0": { base: 0, count: 3 } } });
check("gtkish.frag: array element through a spec-constant if chain", has(gf, /textureSample\(TEX_1_, TEX_1_sampler/));
const sp = run("subpass.frag", "subpass.frag.spv", { stage: "fragment", entryPoint: "main" });
check("subpass.frag: input attachment as textureLoad at the fragment position", has(sp, /var inColor: texture_2d<f32>;/) && has(sp, /textureLoad\(inColor, /) && sp?.bindings[0].kind === "texture");
check("subpass.frag: gl_PointCoord is vec2(0.5), write-only buffer readable", has(sp, /vec2<f32>\(0\.5f, 0\.5f\)/) && has(sp, /var<storage, read_write> outBuf/));
const dm = run("demote.v13.frag", "demote.v13.frag.spv", { stage: "fragment", entryPoint: "main" });
check("demote.v13.frag: SPIR-V 1.6 demote and OpCopyLogical", has(dm, /discard;/) && has(dm, /var copy: L;/));

const pr = run("paired.frag", "paired.frag.spv", { stage: "fragment", entryPoint: "main" });
check("paired.frag: texture and sampler sharing a binding -> 2b, 2b+1", pr?.bindings.map((b) => `${b.binding}@${b.wgslBinding}:${b.kind}`).join() === "0@0:texture,0@1:sampler", JSON.stringify(pr?.bindings));

const nf = run("noformat.comp", "noformat.comp.spv", { stage: "compute", entryPoint: "main" });
check("noformat.comp: default formats by sampled type", has(nf, /texture_storage_2d<rgba8unorm,write>/) && has(nf, /texture_storage_2d<rgba32uint,write>/));
const nf2 = run("noformat.comp.rgba16f", "noformat.comp.spv", { stage: "compute", entryPoint: "main", storageFormats: { "0.0": "rgba16float" } });
check("noformat.comp: opts.storageFormats", has(nf2, /var img: texture_storage_2d<rgba16float,write>/) && nf2?.bindings[0].format === "rgba16float", JSON.stringify(nf2?.bindings));
{
	// Interpolation linked to the vertex stage: lit.frag's flat int stays,
	// its perspective vec4 input becomes flat when the vertex side says so.
	const lf = run("lit.frag.linked", "lit.frag.spv", { stage: "fragment", entryPoint: "main", link: [{ location: 0, interpolation: "flat", sampling: "" }] });
	check("opts.link matches interpolation", has(lf, /@location\(0\) @interpolate\(flat\) vVaryingColor: vec4<f32>/));
	check("vertex result lists varyings", JSON.stringify(lv?.varyings) === JSON.stringify([{ location: 0, interpolation: "perspective", sampling: "center" }, { location: 1, interpolation: "flat", sampling: "" }]), JSON.stringify(lv?.varyings));
}

const dv = run("dynvary.vert", "dynvary.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true });
check("dynvary.vert: dynamic array varying via a private shadow, struct varyings at their locations", [0, 1, 2, 3, 4].every((l) => has(dv, new RegExp(`@location\\(${l}\\) @interpolate\\(flat\\)`))));
run("dynvary.frag", "dynvary.frag.spv", { stage: "fragment", entryPoint: "main", link: dv?.varyings });

const dp = run("drawparams.vert", "drawparams.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true });
check("drawparams.vert: BaseVertex/BaseInstance/DrawIndex read as 0", !!dp && !/builtin\((base|draw)/.test(dp.wgsl));

const fd = run("fastdiv.comp", "fastdiv.comp.spv", { stage: "compute", entryPoint: "main", pushGroup: 1, spec: { 0: 128 } });
check("fastdiv.comp: umulExtended lowered, std430 push array repacked, no inf, spec-sized shared array", !!fd && !/inf/i.test(fd.wgsl) && has(fd, /var<uniform> \w+: kw_words;/) && has(fd, /array<f32, 64>/) && has(fd, /@workgroup_size\(128, 1, 1\)/) && JSON.stringify(fd.requires) === "[]", fd?.wgsl.slice(0, 0));

// A std430 push block WGSL's uniform address space cannot lay out
// (Firefox and Safari refuse arrays of stride 4 there): vec4<u32> words,
// run below with known bytes. A block that fits keeps its struct.
const pk = run("pushpack.comp", "pushpack.comp.spv", { stage: "compute", entryPoint: "main", pushGroup: 1 });
check("pushpack.comp: push block repacked into vec4<u32> words", has(pk, /var<uniform> p: kw_words;/) && has(pk, /w: array<vec4<u32>, 8>,/) && pk?.pushConstantSize === 128, String(pk?.pushConstantSize));
check("push.vert: a push block that fits keeps its struct", !!pv && !/kw_words/.test(pv.wgsl));
const pushpack = (() => {
	const buf = new ArrayBuffer(128);
	const f = new Float32Array(buf), u = new Uint32Array(buf), s = new Int32Array(buf);
	u[0] = 7;
	[f[1], f[2]] = [1.5, -2.25];
	s.set([10, -20, 30, -40], 3);
	f.set([0.5, 0.25, 0.125, 3, 100], 8);
	u.set([1, 2, 3], 13);
	f.set([5, 6, 7, 8, 1, 2, 3, 4], 16);
	for (let c = 0; c < 2; c++) for (let r = 0; r < 3; r++) f[(96 + 8 * r + 4 * c) / 4] = 10 * c + r + 0.5; // row-major mat2x3: rm[c][r]
	const want: number[] = [];
	const rm = (c: number, r: number) => 10 * c + r + 0.5;
	for (let i = 0; i < 4; i++) {
		const m = [[1, 2], [3, 4]];
		want.push(7, [1.5, -2.25][i % 2], [10, -20, 30, -40][i], [0.5, 0.25, 0.125][i % 3], 3, 100 + [1, 2, 3][i % 3], [6, 8][i % 2], m[i % 2][1 - (i % 2)], 7, 10, -0.75, rm(i % 2, i % 3), rm(0, 0) + rm(1, 0), rm(0, 1) + rm(1, 1), rm(0, 2) + rm(1, 2), [10, -20, 30, -40][3 - i]);
	}
	return { push: [...u], want };
})();

// A barrier, then a continue on an index that depends on the invocation,
// in a loop whose own condition is uniform (llama.cpp's
// mul_mat_vec_q2_k/q3_k/q6_k): the rest of the body moves into an else
// branch and the fall-through continues go (flow.rs), so WGSL takes the
// barrier as uniform; dispatched below (plain and spirv-opt -O SPIR-V) and
// every output compared. barrierneg.comp: shapes the pass must leave
// alone, which WebGPU must still refuse.
const brc = run("barriercont.comp", "barriercont.comp.spv", { stage: "compute", entryPoint: "main", pushGroup: 1 });
check("barriercont.comp: no continue left in the barrier loops", !!brc && !/continue;/.test(brc.wgsl));
const barrierRun = (() => {
	const nb = 10, rows = 2;
	const a = Array.from({ length: rows * nb * 4 }, (_, k) => (k % 7) - 3);
	const want: number[] = [];
	for (let tid = 0; tid < 16; tid++) {
		const ix = tid >> 2, lane = tid & 3, acc = [0, 0];
		for (let i = ix; i < nb; i += 4) for (let n = 0; n < rows; n++) acc[n] += a[(n * nb + i) * 4 + ((lane + 1) & 3)] * (i + 1);
		want.push(acc[0], acc[1]);
	}
	return { a, push: [nb, rows], want };
})();
const neg: Record<string, VkShaderResult> = {};
for (const f of ["barrierneg.comp.spv", "barrierneg.comp.opt.spv"]) {
	for (const shape of [0, 1]) {
		try {
			neg[`${f} SHAPE=${shape}`] = t.translate(readFileSync(new URL(f, here)), { stage: "compute", entryPoint: "main", pushGroup: 1, spec: { 0: shape } });
		} catch (e) {
			check(`${f} SHAPE=${shape} translates`, false, (e as Error).message);
		}
	}
	check(`${f} SHAPE=0: the continue under an if that more statements follow stays`, /continue;/.test(neg[`${f} SHAPE=0`]?.wgsl ?? ""));
}

// A 512- and a 1024-wide workgroup reducing through shared memory with
// barriers on a 256-invocation device (llama.cpp's norm family): run as
// 2 or 4 virtual invocations per invocation (virt.rs), the workgroup count
// unchanged (no dispatchScale). Dispatched below (plain and spirv-opt -O
// SPIR-V, one workgroup past the rows to take the early return) and every
// output compared with the same f32 operations in the same order.
// virtneg.comp: SHAPE 0 (a barrier in another function) and SHAPE 1 (a
// barrier in a loop whose trip count depends on the invocation) are
// refused, the latter by the pass's own uniformity check.
const virtLim = { maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 256, maxComputeWorkgroupSizeZ: 64, maxComputeInvocationsPerWorkgroup: 256 };
for (const f of ["virt.comp.spv", "virt.comp.opt.spv"]) {
	for (const bs of [512, 1024]) {
		const r = run(`${f} BS=${bs}`, f, { stage: "compute", entryPoint: "main", pushGroup: 1, spec: { 0: bs }, limits: virtLim });
		check(`${f} BS=${bs}: 256-wide workgroup, same workgroup count`, has(r, /@workgroup_size\(256, 1, 1\)/) && !r?.dispatchScale, JSON.stringify(r?.dispatchScale));
	}
}
const virtRun = (() => {
	const n = 1300, rows = 3;
	const a = Array.from({ length: rows * n }, (_, k) => Math.fround((((k * 37) % 101) - 50) / 7));
	const cases = [512, 1024].map((bs) => {
		const sums: number[] = [], o: number[] = new Array(rows * n).fill(-1), ids: number[] = new Array((rows + 1) * bs).fill(0xffffffff);
		for (let r = 0; r < rows; r++) {
			const s = new Float32Array(bs);
			for (let t = 0; t < bs; t++) {
				let sum = 0;
				for (let i = t; i < n; i += bs) sum = Math.fround(sum + a[r * n + i]);
				s[t] = sum;
			}
			for (let k = bs / 2; k > 0; k >>= 1) for (let t = 0; t < k; t++) s[t] = Math.fround(s[t] + s[t + k]);
			sums.push(s[0]);
			for (let t = 0; t < bs; t++) ids[r * bs + t] = t * 4 + 3;
			for (let i = 0; i < n; i++) if (i % 3 !== 1) o[r * n + i] = Math.fround(Math.fround(a[r * n + i] * 2) + s[0]);
		}
		return { bs, sums, counts: new Array(rows).fill(bs), ids, o };
	});
	return { n, rows, a, cases };
})();
try {
	t.translate(readFileSync(new URL("virtneg.comp.spv", here)), { stage: "compute", entryPoint: "main", pushGroup: 1, spec: { 0: 0 }, limits: virtLim });
	check("virtneg.comp SHAPE=0: barrier in another function refused", false);
} catch (e) {
	check("virtneg.comp SHAPE=0: barrier in another function refused", /cannot split.*virtual invocations: a barrier in a function other than the entry point/.test((e as Error).message), (e as Error).message);
}
run("virtneg.comp.opt.spv SHAPE=0 (inlined)", "virtneg.comp.opt.spv", { stage: "compute", entryPoint: "main", pushGroup: 1, spec: { 0: 0 }, limits: virtLim });
for (const f of ["virtneg.comp.spv", "virtneg.comp.opt.spv"]) {
	try {
		t.translate(readFileSync(new URL(f, here)), { stage: "compute", entryPoint: "main", pushGroup: 1, spec: { 0: 1 }, limits: virtLim });
		check(`${f} SHAPE=1: barrier loop on the invocation refused`, false);
	} catch (e) {
		check(`${f} SHAPE=1: barrier loop on the invocation refused`, /cannot split.*virtual invocations: a (condition|break or continue) around (a barrier|barriers) that may differ between invocations/.test((e as Error).message), (e as Error).message);
	}
}

// A helper's barrier loop over gl_WorkGroupID.y in steps of
// gl_NumWorkGroups.y, read through spv-in's private copies (llama.cpp's
// unoptimized bf16 rms_norm): builtins.rs passes them as arguments, so
// WGSL takes the loop as uniform. Dispatched below (2x2 workgroups, plain
// and spirv-opt -O SPIR-V) and every output compared. builtinneg.comp: the
// loop on gl_LocalInvocationID stays, and WebGPU must refuse it.
const bl = run("builtinloop.comp", "builtinloop.comp.spv", { stage: "compute", entryPoint: "main", pushGroup: 1 });
check("builtinloop.comp: the helper takes workgroup_id and num_workgroups as arguments", has(bl, /gl_WorkGroupID_arg: vec3<u32>/) && has(bl, /gl_NumWorkGroups_arg: vec3<u32>/));
const builtinRun = (() => {
	const nch = 5, iters = 7, want: number[] = new Array(2 * nch * 64).fill(-1);
	for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let c = y; c < nch; c += 2) for (let tid = 0; tid < 64; tid++) want[(x * nch + c) * 64 + tid] = c * 64 + 63 - tid + x * 1000 + iters;
	return { push: [nch, iters], want };
})();
for (const f of ["builtinneg.comp.spv", "builtinneg.comp.opt.spv"]) {
	try {
		const r = t.translate(readFileSync(new URL(f, here)), { stage: "compute", entryPoint: "main", pushGroup: 1 });
		check(`${f}: local_invocation_id not passed down`, !/gl_LocalInvocationID_arg/.test(r.wgsl));
		neg[`${f} (local_invocation_id loop)`] = r;
	} catch (e) {
		check(`${f} translates`, false, (e as Error).message);
	}
}

// Subgroup builtins without subgroup operations (llama.cpp's
// gated_delta_net): with opts subgroupSize S they become arithmetic on the
// local index (subgroup.rs), no `subgroups` feature needed. Dispatched
// below (plain and spirv-opt -O SPIR-V) for WG 64 and S 32 or 16, WG 48
// (a partial last subgroup) and WG 512 on a 256-invocation device
// (virtual invocations, virt.rs), and every output compared with what
// subgroups of exactly S invocations in local index order give.
// subgroupneg: a subgroup operation keeps WebGPU's subgroups.
const sgCases = [{ wg: 64, sg: 32 }, { wg: 48, sg: 32 }, { wg: 64, sg: 16 }, { wg: 512, sg: 32, limits: virtLim }];
const subgroupRun = sgCases.map(({ wg, sg }) => {
	const groups = 3, n = groups * wg, lanes = 8;
	const a = Array.from({ length: n }, (_, k) => Math.fround((((k * 29) % 53) - 26) / 5));
	const o: number[] = [], info: number[] = [];
	for (let g = 0; g < groups; g++) {
		let temp = Array.from({ length: wg }, (_, li) => Math.fround(a[g * wg + li] * ((li % sg) + 1)));
		for (let s = lanes / 2; s > 0; s >>= 1) temp = temp.map((v, li) => Math.fround(v + temp[li ^ s]));
		for (let li = 0; li < wg; li++) {
			o.push(temp[li]);
			info.push(sg, li % sg, Math.floor(li / sg), Math.ceil(wg / sg));
		}
	}
	return { name: `WG=${wg} S=${sg}`, wg, groups, a, o, info };
});
for (const f of ["subgroup.v13.comp.spv", "subgroup.v13.comp.opt.spv"]) {
	for (const c of sgCases) {
		const r = run(`${f} WG=${c.wg} S=${c.sg}`, f, { stage: "compute", entryPoint: "main", pushGroup: 1, spec: { 0: c.wg, 1: 8 }, subgroupSize: c.sg, limits: c.limits });
		const virt = c.wg > 256 ? has(r, /@workgroup_size\(256, 1, 1\)/) && !r?.dispatchScale : has(r, new RegExp(`@workgroup_size\\(${c.wg}, 1, 1\\)`));
		check(`${f} WG=${c.wg} S=${c.sg}: builtins lowered, nothing required${c.wg > 256 ? ", virtual invocations" : ""}`, !!r && !/subgroup/.test(r.wgsl) && r.requires?.length === 0 && virt, JSON.stringify(r?.requires));
	}
	try {
		const r = t.translate(readFileSync(new URL(f, here)), { stage: "compute", entryPoint: "main", pushGroup: 1, spec: { 0: 64, 1: 8 } });
		check(`${f} without subgroupSize: WebGPU's subgroups as before`, /@builtin\(subgroup_invocation_id\)/.test(r.wgsl) && JSON.stringify(r.requires) === JSON.stringify(["subgroups"]), JSON.stringify(r.requires));
	} catch (e) {
		check(`${f} without subgroupSize translates`, false, (e as Error).message);
	}
}
for (const f of ["subgroupneg.v13.comp.spv", "subgroupneg.v13.comp.opt.spv"]) {
	try {
		const r = t.translate(readFileSync(new URL(f, here)), { stage: "compute", entryPoint: "main", pushGroup: 1, subgroupSize: 32 });
		check(`${f}: a subgroup operation keeps WebGPU's subgroups`, /subgroupAdd\(/.test(r.wgsl) && /@builtin\(subgroup_invocation_id\)/.test(r.wgsl) && JSON.stringify(r.requires) === JSON.stringify(["subgroups"]), JSON.stringify(r.requires));
	} catch (e) {
		check(`${f} translates`, false, (e as Error).message);
	}
}

// Division by a constant zero in a branch dead for the specialization
// (llama.cpp's mul_mm with TK = 1): allowed by Vulkan, refused by naga and
// Tint, so no zero divisor may reach the WGSL (compiled below).
const zd = run("zerodiv.comp", "zerodiv.comp.spv", { stage: "compute", entryPoint: "main" });
check("zerodiv.comp: no constant zero divisor left", !!zd && !/[/%] *\(?(0[iu]|w)\b/.test(zd.wgsl), zd?.wgsl.match(/.*[/%] *\(?(0[iu]|w)\b.*/)?.[0]);
const zd4 = run("zerodiv.comp.tk4", "zerodiv.comp.spv", { stage: "compute", entryPoint: "main", spec: { 0: 4, 1: true } });
check("zerodiv.comp with TK = 4: divisions kept", has(zd4, /\/ w\b/) && has(zd4, /% w\b/));

const sm = run("small.comp", "small.comp.spv", { stage: "compute", entryPoint: "main" });
check("small.comp: 8/16-bit buffers as u32 words (one per binding), f16 via unpack2x16float, 16-bit stores atomic", has(sm, /unpack2x16float/) && has(sm, /atomicAnd\(/) && has(sm, /atomicOr\(/) && !!sm && !/enable f16/.test(sm.wgsl) && sm.bindings.filter((b) => b.wgslBinding === 0).length === 1 && sm.bindings.find((b) => b.wgslBinding === 0)?.kind === "read-only-storage", JSON.stringify(sm?.bindings));
const smf = run("small.comp.f16", "small.comp.spv", { stage: "compute", entryPoint: "main", features: ["shader-f16"] });
check("small.comp with shader-f16: f16 kept, f16-only buffer native", has(smf, /enable f16;/) && has(smf, /array<f16>/) && JSON.stringify(smf?.requires) === JSON.stringify(["shader-f16"]), JSON.stringify(smf?.requires));
if (smf) delete out["small.comp.f16"]; // SwiftShader has no shader-f16

{
	const lim = { maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 256, maxComputeWorkgroupSizeZ: 64, maxComputeInvocationsPerWorkgroup: 256 };
	const wd = run("wide.comp", "wide.comp.spv", { stage: "compute", entryPoint: "main", limits: lim });
	check("wide.comp: 512-wide workgroup shrunk to 256, dispatchScale [2,1,1]", has(wd, /@workgroup_size\(256, 1, 1\)/) && JSON.stringify(wd?.dispatchScale) === "[2,1,1]", JSON.stringify(wd?.dispatchScale));
	const wb = run("widebi.comp", "widebi.comp.spv", { stage: "compute", entryPoint: "main", limits: lim });
	check("widebi.comp: local/workgroup ids, local index, workgroup count derived from the global id", has(wb, /let gl_LocalInvocationID = gl_GlobalInvocationID % vec3<u32>\(512u, 1u, 1u\);/) && has(wb, /kwvk_nwg \/ vec3<u32>\(2u, 1u, 1u\)/) && JSON.stringify(wb?.dispatchScale) === "[2,1,1]");
	const sw = run("specwg.comp 512", "specwg.comp.spv", { stage: "compute", entryPoint: "main", spec: { 0: 512, 1: 8 }, limits: lim });
	check("workgroup memory + 512 wide: virtual invocations, no dispatchScale", has(sw, /@workgroup_size\(256, 1, 1\)/) && !sw?.dispatchScale, JSON.stringify(sw?.dispatchScale));
	try {
		t.translate(readFileSync(new URL("specwg.comp.spv", here)), { stage: "compute", entryPoint: "main", spec: { 0: 4096, 1: 8 }, limits: lim });
		check("workgroup memory + too wide for 8 virtual invocations: clear error", false);
	} catch (e) {
		check("workgroup memory + too wide for 8 virtual invocations: clear error", /exceeds the device.s limits.*cannot split.*virtual invocations: no power of two/.test((e as Error).message), (e as Error).message);
	}
}

// Texel buffers (texel.rs): a storage buffer of words and a uniform of
// parameters per binding, reflected with `texel`; run below for many view
// formats at a nonzero first byte, past the element count included.
for (const f of ["texel.comp.spv", "texel.comp.opt.spv"]) {
	const r = run(f, f, { stage: "compute", entryPoint: "main", pushGroup: 1 });
	const tb = r?.bindings.filter((b) => (b as any).texel).map((b) => `${b.binding}:${b.wgslBinding}:${(b as any).texel}:${b.kind}`).join();
	check(`${f}: texel buffers as words + parameters, read-only`, tb === "0:0:data:read-only-storage,0:1:params:uniform,1:2:data:read-only-storage,1:3:params:uniform,2:4:data:read-only-storage,2:5:params:uniform", tb);
	check(`${f}: decoders for the three sampled types, no stub left`, has(r, /fn kw_texel_decode_f\(/) && has(r, /fn kw_texel_decode_i\(/) && has(r, /fn kw_texel_decode_u\(/) && !!r && !/bitcast<vec4<f32>>\(vec4<u32>\(_e/.test(r.wgsl));
}
for (const f of ["texelimg.comp.spv", "texelimg.comp.opt.spv"]) {
	const r = run(f, f, { stage: "compute", entryPoint: "main", pushGroup: 1 });
	const kinds = r?.bindings.filter((b) => (b as any).texel === "data").map((b) => `${b.binding}:${b.kind}`).sort().join();
	check(`${f}: written texel buffers writable, readonly one read-only, atomics on words`, kinds === "0:storage,1:storage,2:storage,3:storage,4:read-only-storage" && has(r, /atomicAdd\(\(?&kw_tb_0_2_w\.w\[/) && has(r, /array<atomic<i32>>/), kinds);
}
for (const f of ["texel.vert.spv", "texel.vert.opt.spv", "texel.frag.spv", "texel.frag.opt.spv"]) {
	const stage = f.includes(".vert") ? "vertex" : "fragment";
	const r = run(f, f, { stage, entryPoint: "main", flipY: true, pushGroup: 1 });
	if (stage === "fragment") check(`${f}: textureBuffer + sampler fetched, the sampler left out`, !!r && !r.bindings.some((b) => b.kind === "sampler") && r.bindings.filter((b) => (b as any).texel === "data").map((b) => b.kind).join() === "read-only-storage,read-only-storage,storage", JSON.stringify(r?.bindings));
	else check(`${f}: read-only texel buffer in a vertex stage`, r?.bindings.map((b) => b.kind).join() === "read-only-storage,uniform", JSON.stringify(r?.bindings));
}
for (const f of ["texelrt.comp.spv", "texelrt.comp.opt.spv"]) {
	const r = run(f, f, { stage: "compute", entryPoint: "main", pushGroup: 1 });
	check(`${f}: written texel buffers without a format: atomic words, narrow stores by atomicAnd + atomicOr`, (r?.wgsl.match(/array<atomic<u32>>/g)?.length ?? 0) >= 1 && has(r, /atomicAnd\(&kw_tb_0_3_w\.w\[k\], ~m\); atomicOr\(/) && !has(r, /kw_tb_0_[345]_w\.w\[k\] = /), "");
}
for (const f of ["texelw.vert.spv", "texelw.vert.opt.spv"]) {
	try {
		t.translate(readFileSync(new URL(f, here)), { stage: "vertex", entryPoint: "main", flipY: true });
		check(`${f}: a written texel buffer in a vertex stage refused`, false);
	} catch (e) {
		check(`${f}: a written texel buffer in a vertex stage refused`, /vertex stage writes cannot work on WebGPU/.test((e as Error).message), (e as Error).message);
	}
}
// The cases run in WebGPU: bytes of 16 elements after `base` bytes, `count`
// of them in the view, and what Vulkan's conversion gives for each.
const texelRun = (() => {
	let seed = 12345;
	const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) & 0xffff;
	const fmts: Record<number, [string, number]> = {
		9: ["f", 1], 10: ["f", 1], 13: ["u", 1], 14: ["i", 1], 16: ["f", 2], 17: ["f", 2], 20: ["u", 2], 21: ["i", 2],
		37: ["f", 4], 38: ["f", 4], 41: ["u", 4], 42: ["i", 4], 44: ["f", 4], 51: ["f", 4], 56: ["i", 4], 64: ["f", 4], 68: ["u", 4],
		70: ["f", 2], 71: ["f", 2], 74: ["u", 2], 75: ["i", 2], 76: ["f", 2], 77: ["f", 4], 78: ["f", 4], 81: ["u", 4], 82: ["i", 4], 83: ["f", 4],
		91: ["f", 8], 92: ["f", 8], 95: ["u", 8], 96: ["i", 8], 97: ["f", 8], 98: ["u", 4], 99: ["i", 4], 100: ["f", 4],
		101: ["u", 8], 102: ["i", 8], 103: ["f", 8], 104: ["u", 12], 105: ["i", 12], 106: ["f", 12], 107: ["u", 16], 108: ["i", 16], 109: ["f", 16], 122: ["f", 4],
	};
	const half = (h: number) => {
		const e = (h >> 10) & 31, m = h & 1023;
		const v = e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15);
		return h & 0x8000 ? -v : v;
	};
	const finiteHalf = () => {
		let h = rnd();
		const e = (h >> 10) & 31;
		if (e === 0 || e === 31) h = (h & ~(31 << 10)) | (15 << 10);
		return h;
	};
	const cases: any[] = [];
	for (const [k, [kind, size]] of Object.entries(fmts)) {
		const fmt = Number(k);
		const base = size === 12 ? 16 : 48, count = 13;
		const bytes = new Uint8Array(base + 16 * size + 16);
		for (let j = 0; j < bytes.length; j++) bytes[j] = rnd() & 255;
		const dv = new DataView(bytes.buffer);
		// float data without NaN, infinity or subnormals
		for (let n = 0; n < 16; n++) {
			const at = base + n * size;
			if ([76, 83, 97].includes(fmt)) for (let c = 0; c < size / 2; c++) dv.setUint16(at + 2 * c, finiteHalf(), true);
			if ([100, 103, 106, 109].includes(fmt)) for (let c = 0; c < size / 4; c++) dv.setFloat32(at + 4 * c, (rnd() - 32768) / 256, true);
			if (fmt === 122) {
				let w = dv.getUint32(at, true);
				for (const [sh, mb] of [[0, 6], [11, 6], [22, 5]]) {
					const ex = (w >>> (sh + mb)) & 31;
					if (ex === 0 || ex === 31) w = (w & ~(31 << (sh + mb))) | (14 << (sh + mb));
				}
				dv.setUint32(at, w >>> 0, true);
			}
		}
		const want: number[][] = [];
		for (let n = 0; n < 16; n++) {
			if (n >= count) {
				want.push([0, 0, 0, 0]);
				continue;
			}
			const at = base + n * size;
			const u8 = (c: number) => dv.getUint8(at + c), s8 = (c: number) => dv.getInt8(at + c);
			const u16 = (c: number) => dv.getUint16(at + 2 * c, true), s16 = (c: number) => dv.getInt16(at + 2 * c, true);
			const u32 = (c: number) => dv.getUint32(at + 4 * c, true), s32 = (c: number) => dv.getInt32(at + 4 * c, true), f32 = (c: number) => dv.getFloat32(at + 4 * c, true);
			const un8 = (c: number) => u8(c) / 255, sn8 = (c: number) => Math.max(s8(c) / 127, -1);
			const un16 = (c: number) => u16(c) / 65535, sn16 = (c: number) => Math.max(s16(c) / 32767, -1);
			const pad = (v: number[]) => [...v, ...[0, 0, 1].slice(v.length - 1)].slice(0, 4);
			const ufl = (x: number, mb: number) => half(x << (10 - mb));
			const w = size >= 4 ? u32(0) : 0;
			const v: Record<number, () => number[]> = {
				9: () => pad([un8(0)]), 10: () => pad([sn8(0)]), 13: () => pad([u8(0)]), 14: () => pad([s8(0)]),
				16: () => pad([un8(0), un8(1)]), 17: () => pad([sn8(0), sn8(1)]), 20: () => pad([u8(0), u8(1)]), 21: () => pad([s8(0), s8(1)]),
				37: () => [0, 1, 2, 3].map(un8), 51: () => [0, 1, 2, 3].map(un8), 38: () => [0, 1, 2, 3].map(sn8), 41: () => [0, 1, 2, 3].map(u8),
				42: () => [0, 1, 2, 3].map(s8), 56: () => [0, 1, 2, 3].map(s8), 44: () => [2, 1, 0, 3].map(un8),
				64: () => [(w & 1023) / 1023, ((w >>> 10) & 1023) / 1023, ((w >>> 20) & 1023) / 1023, (w >>> 30) / 3],
				68: () => [w & 1023, (w >>> 10) & 1023, (w >>> 20) & 1023, w >>> 30],
				70: () => pad([un16(0)]), 71: () => pad([sn16(0)]), 74: () => pad([u16(0)]), 75: () => pad([s16(0)]), 76: () => pad([half(u16(0))]),
				77: () => pad([un16(0), un16(1)]), 78: () => pad([sn16(0), sn16(1)]), 81: () => pad([u16(0), u16(1)]), 82: () => pad([s16(0), s16(1)]), 83: () => pad([half(u16(0)), half(u16(1))]),
				91: () => [0, 1, 2, 3].map(un16), 92: () => [0, 1, 2, 3].map(sn16), 95: () => [0, 1, 2, 3].map(u16), 96: () => [0, 1, 2, 3].map(s16), 97: () => [0, 1, 2, 3].map((c) => half(u16(c))),
				98: () => pad([u32(0)]), 99: () => pad([s32(0)]), 100: () => pad([f32(0)]),
				101: () => pad([u32(0), u32(1)]), 102: () => pad([s32(0), s32(1)]), 103: () => pad([f32(0), f32(1)]),
				104: () => pad([0, 1, 2].map(u32)), 105: () => pad([0, 1, 2].map(s32)), 106: () => pad([0, 1, 2].map(f32)),
				107: () => [0, 1, 2, 3].map(u32), 108: () => [0, 1, 2, 3].map(s32), 109: () => [0, 1, 2, 3].map(f32),
				122: () => [ufl(w & 0x7ff, 6), ufl((w >>> 11) & 0x7ff, 6), ufl((w >>> 22) & 0x3ff, 5), 1],
			};
			want.push(v[fmt]!());
		}
		cases.push({ fmt, kind, size, base, count, bytes: [...bytes], want });
	}
	return cases;
})();

// Every shader again as spirv-opt -O output: translates and (below) compiles.
for (const f of readdirSync(here).filter((f) => f.endsWith(".opt.spv") && !f.startsWith("barrierneg") && !f.startsWith("builtinneg") && !f.startsWith("subgroup") && !f.startsWith("texelw"))) {
	const stage = f.includes(".vert.") ? "vertex" : f.includes(".frag.") ? "fragment" : "compute";
	const spec: Record<number, number> = f.startsWith("specwg") ? { 0: 64, 1: 8 } : f.startsWith("fastdiv") ? { 0: 128 } : {};
	const arrays = f.startsWith("gtkish") ? { "0.0": { base: 0, count: 3 } } : arraysAll;
	if (run(f, f, { stage, entryPoint: "main", flipY: true, pushGroup: 2, spec, arrays })) check(`${f} translates`, true);
}

try {
	t.translate(new Uint8Array(40), { stage: "vertex", entryPoint: "main" });
	check("garbage throws", false);
} catch (e) {
	check("garbage throws", (e as Error).message.length > 0);
}
{
	// Truncated and corrupted input: an Error each time (a naga panic
	// included), and the translator still works afterwards.
	const good = readFileSync(new URL("cube.frag.spv", here));
	let threw = 0;
	let n = 0;
	for (let len = 20; len < good.length; len += 52) {
		n++;
		try {
			t.translate(good.subarray(0, len), { stage: "fragment", entryPoint: "main" });
		} catch (e) {
			if (e instanceof Error) threw++;
		}
		const bad = new Uint8Array(good);
		bad[len] ^= 0x5a;
		try {
			t.translate(bad, { stage: "fragment", entryPoint: "main" });
		} catch {}
	}
	let after = false;
	try {
		after = t.translate(good, { stage: "fragment", entryPoint: "main" }).bindings.length === 2;
	} catch {}
	check("truncated input throws, translator survives corruption", threw === n && after, `${threw}/${n} threw, after=${after}`);
}
try {
	t.translate(readFileSync(new URL("cube.vert.spv", here)), { stage: "fragment", entryPoint: "main" });
	check("wrong stage throws", false);
} catch (e) {
	check("wrong stage throws", /entry point/.test((e as Error).message), (e as Error).message);
}

// Real WebGPU. Pipelines: [name, vertex, fragment | undefined, push group].
const pipelines: [string, string, string | undefined][] = [
	["cube", "cube.vert", "cube.frag"],
	["push+spec", "push.vert", "spec.frag"],
	["mrt", "mrt.vert", "mrt.frag"],
	["lit", "lit.vert", "lit.frag"],
	["gtkish", "gtkish.vert", "gtkish.frag"],
	["dynvary", "dynvary.vert", "dynvary.frag"],
	["buffer", "buffer.comp", undefined],
	["image", "image.comp", undefined],
	["specwg", "specwg.comp", undefined],
	["fastdiv", "fastdiv.comp", undefined],
	["small", "small.comp", undefined],
	["zerodiv", "zerodiv.comp", undefined],
	["barriercont", "barriercont.comp", undefined],
	["texel", "texel.vert.spv", "texel.frag.spv"],
	["texel.comp", "texel.comp.spv", undefined],
	["texelimg.comp", "texelimg.comp.opt.spv", undefined],
];
const page = `<!doctype html><meta charset="utf-8"><title>vk-shader</title><script type="module">
const out = ${JSON.stringify(out)};
const pipelines = ${JSON.stringify(pipelines)};
const pushpack = ${JSON.stringify(pushpack)};
const barrierRun = ${JSON.stringify(barrierRun)};
const virtRun = ${JSON.stringify(virtRun)};
const builtinRun = ${JSON.stringify(builtinRun)};
const subgroupRun = ${JSON.stringify(subgroupRun)};
const neg = ${JSON.stringify(neg)};
const texelRun = ${JSON.stringify(texelRun)};
const res = [];
function layout(device, results, pushGroup) {
	const groups = [];
	for (const [r, vis] of results) {
		for (const b of r.bindings) {
			const e = { binding: b.wgslBinding, visibility: vis };
			if (b.kind === "uniform" || b.kind === "storage" || b.kind === "read-only-storage") e.buffer = { type: b.kind };
			else if (b.kind === "sampler") e.sampler = { type: "filtering" };
			else if (b.kind === "comparison-sampler") e.sampler = { type: "comparison" };
			else if (b.kind === "texture") e.texture = { sampleType: b.sampleType, viewDimension: b.viewDimension, multisampled: b.multisampled };
			else e.storageTexture = { access: b.access, format: b.format, viewDimension: b.viewDimension };
			const g = (groups[b.group] ??= new Map());
			const old = g.get(b.wgslBinding);
			if (old) old.visibility |= vis; else g.set(b.wgslBinding, e);
		}
		if (r.pushConstantSize) {
			const g = (groups[pushGroup] ??= new Map());
			const old = g.get(0);
			if (old) old.visibility |= vis; else g.set(0, { binding: 0, visibility: vis, buffer: { type: "uniform" } });
		}
	}
	for (let i = 0; i < groups.length; i++) groups[i] ??= new Map();
	return device.createPipelineLayout({ bindGroupLayouts: groups.map((g) => device.createBindGroupLayout({ entries: [...g.values()] })) });
}
try {
	const adapter = await navigator.gpu.requestAdapter();
	const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has("clip-distances") ? ["clip-distances"] : [] });
	if (!adapter.features.has("clip-distances")) for (const k of Object.keys(out)) if (k.startsWith("clip.vert")) delete out[k];
	const mods = {};
	for (const [name, r] of Object.entries(out)) {
		device.pushErrorScope("validation");
		const m = device.createShaderModule({ code: r.wgsl });
		const info = await m.getCompilationInfo();
		const err = await device.popErrorScope();
		const msgs = info.messages.filter((x) => x.type === "error").map((x) => x.lineNum + ":" + x.message);
		res.push({ name: "WebGPU module " + name, ok: !msgs.length && !err, detail: msgs.join("; ") + (err ? err.message : "") });
		mods[name] = m;
	}
	for (const [name, vs, fs] of pipelines) {
		device.pushErrorScope("validation");
		const S = GPUShaderStage;
		try {
			if (!fs) {
				await device.createComputePipelineAsync({ layout: layout(device, [[out[vs], S.COMPUTE]], 1), compute: { module: mods[vs], entryPoint: out[vs].entryPoint } });
				await device.createComputePipelineAsync({ layout: "auto", compute: { module: mods[vs], entryPoint: out[vs].entryPoint } });
			} else {
				const vsr = out[vs], fsr = out[fs];
				const sig = vsr.wgsl.slice(vsr.wgsl.indexOf("fn " + vsr.entryPoint + "("));
				const attrs = (sig.slice(0, sig.indexOf("->")).match(/@location\\(\\d+\\)/g) ?? []).map((_, i) => ({ shaderLocation: i, offset: 0, format: "float32x3" }));
				const desc = {
					vertex: { module: mods[vs], entryPoint: vsr.entryPoint, buffers: attrs.length ? [{ arrayStride: 12, attributes: attrs }] : [] },
					fragment: { module: mods[fs], entryPoint: fsr.entryPoint, targets: Array.from({ length: Math.max(1, name === "mrt" ? 2 : 1) }, () => ({ format: "rgba8unorm" })) },
					primitive: { topology: "triangle-list" },
				};
				await device.createRenderPipelineAsync({ ...desc, layout: layout(device, [[vsr, S.VERTEX], [fsr, S.FRAGMENT]], 1) });
				await device.createRenderPipelineAsync({ ...desc, layout: "auto" });
			}
			const err = await device.popErrorScope();
			res.push({ name: "WebGPU pipeline " + name, ok: !err, detail: err ? err.message : "" });
		} catch (e) {
			await device.popErrorScope();
			res.push({ name: "WebGPU pipeline " + name, ok: false, detail: String(e.message ?? e) });
		}
	}
	// Run the repacked push block (plain and spirv-opt -O SPIR-V) and compare every output.
	for (const [name, pushGroup] of [["pushpack.comp", 1], ["pushpack.comp.opt.spv", 2]]) {
		const r = out[name];
		if (!r) continue;
		const bgls = [];
		for (let g = 0; g <= pushGroup; g++) {
			const entries = g === 0 ? [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }] : g === pushGroup ? [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }] : [];
			bgls.push(device.createBindGroupLayout({ entries }));
		}
		const pl = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: bgls }), compute: { module: mods[name], entryPoint: r.entryPoint } });
		const o = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
		const pc = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		const rb = device.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(pc, 0, new Uint32Array(pushpack.push));
		const enc = device.createCommandEncoder();
		const pass = enc.beginComputePass();
		pass.setPipeline(pl);
		bgls.forEach((l, g) => pass.setBindGroup(g, device.createBindGroup({ layout: l, entries: g === 0 ? [{ binding: 0, resource: { buffer: o } }] : g === pushGroup ? [{ binding: 0, resource: { buffer: pc } }] : [] })));
		pass.dispatchWorkgroups(1);
		pass.end();
		enc.copyBufferToBuffer(o, 0, rb, 0, 256);
		device.queue.submit([enc.finish()]);
		await rb.mapAsync(GPUMapMode.READ);
		const got = [...new Float32Array(rb.getMappedRange())];
		const bad = pushpack.want.map((w, i) => (got[i] === w ? "" : "o[" + i + "] " + got[i] + " != " + w)).filter(Boolean);
		res.push({ name: "WebGPU run " + name + ": every value at its Vulkan offset", ok: !bad.length, detail: bad.slice(0, 6).join(", ") });
	}
	// Run the barrier loop with the continue (flow.rs) and compare every output.
	for (const [name, pushGroup] of [["barriercont.comp", 1], ["barriercont.comp.opt.spv", 2]]) {
		const r = out[name];
		if (!r) continue;
		const U = GPUBufferUsage;
		const a = device.createBuffer({ size: 1024, usage: U.STORAGE | U.COPY_DST });
		const d = device.createBuffer({ size: 1024, usage: U.STORAGE | U.COPY_SRC });
		const pc = device.createBuffer({ size: 256, usage: U.UNIFORM | U.COPY_DST });
		const rb = device.createBuffer({ size: 1024, usage: U.MAP_READ | U.COPY_DST });
		device.queue.writeBuffer(a, 0, new Float32Array(barrierRun.a));
		device.queue.writeBuffer(pc, 0, new Uint32Array(barrierRun.push));
		const bgls = [], groups = [];
		for (let g = 0; g <= pushGroup; g++) {
			const bs = g === pushGroup ? [{ wgslBinding: 0, kind: "uniform", buf: pc }] : r.bindings.filter((b) => b.group === g).map((b) => ({ ...b, buf: b.binding === 0 ? a : d }));
			const l = device.createBindGroupLayout({ entries: bs.map((b) => ({ binding: b.wgslBinding, visibility: GPUShaderStage.COMPUTE, buffer: { type: b.kind } })) });
			bgls.push(l);
			groups.push(device.createBindGroup({ layout: l, entries: bs.map((b) => ({ binding: b.wgslBinding, resource: { buffer: b.buf } })) }));
		}
		device.pushErrorScope("validation");
		const pl = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: bgls }), compute: { module: mods[name], entryPoint: r.entryPoint } });
		const enc = device.createCommandEncoder();
		const pass = enc.beginComputePass();
		pass.setPipeline(pl);
		groups.forEach((bg, g) => pass.setBindGroup(g, bg));
		pass.dispatchWorkgroups(1);
		pass.end();
		enc.copyBufferToBuffer(d, 0, rb, 0, 1024);
		device.queue.submit([enc.finish()]);
		const err = await device.popErrorScope();
		await rb.mapAsync(GPUMapMode.READ);
		const got = [...new Float32Array(rb.getMappedRange())];
		const bad = barrierRun.want.map((w, i) => (got[i] === w ? "" : "d[" + i + "] " + got[i] + " != " + w)).filter(Boolean);
		res.push({ name: "WebGPU run " + name + ": every sum of the barrier loop with the continue", ok: !err && !bad.length, detail: (err ? err.message + " " : "") + bad.slice(0, 6).join(", ") });
	}
	// Run the helper's builtin loop (builtins.rs) and compare every output.
	for (const name of ["builtinloop.comp", "builtinloop.comp.opt.spv"]) {
		const r = out[name];
		if (!r) continue;
		const pushGroup = name === "builtinloop.comp" ? 1 : 2;
		const U = GPUBufferUsage;
		const d = device.createBuffer({ size: builtinRun.want.length * 4, usage: U.STORAGE | U.COPY_DST | U.COPY_SRC });
		device.queue.writeBuffer(d, 0, new Float32Array(builtinRun.want.length).fill(-1));
		const pc = device.createBuffer({ size: 256, usage: U.UNIFORM | U.COPY_DST });
		device.queue.writeBuffer(pc, 0, new Uint32Array(builtinRun.push));
		const rb = device.createBuffer({ size: d.size, usage: U.MAP_READ | U.COPY_DST });
		const bgls = [], groups = [];
		for (let g = 0; g <= pushGroup; g++) {
			const bs = g === pushGroup ? [{ wgslBinding: 0, kind: "uniform", buf: pc }] : r.bindings.filter((b) => b.group === g).map((b) => ({ ...b, buf: d }));
			const l = device.createBindGroupLayout({ entries: bs.map((b) => ({ binding: b.wgslBinding, visibility: GPUShaderStage.COMPUTE, buffer: { type: b.kind } })) });
			bgls.push(l);
			groups.push(device.createBindGroup({ layout: l, entries: bs.map((b) => ({ binding: b.wgslBinding, resource: { buffer: b.buf } })) }));
		}
		device.pushErrorScope("validation");
		const pl = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: bgls }), compute: { module: mods[name], entryPoint: r.entryPoint } });
		const enc = device.createCommandEncoder();
		const pass = enc.beginComputePass();
		pass.setPipeline(pl);
		groups.forEach((bg, g) => pass.setBindGroup(g, bg));
		pass.dispatchWorkgroups(2, 2);
		pass.end();
		enc.copyBufferToBuffer(d, 0, rb, 0, d.size);
		device.queue.submit([enc.finish()]);
		const err = await device.popErrorScope();
		await rb.mapAsync(GPUMapMode.READ);
		const got = [...new Float32Array(rb.getMappedRange())];
		const bad = builtinRun.want.map((w, i) => (got[i] === w ? "" : "d[" + i + "] " + got[i] + " != " + w)).filter(Boolean);
		res.push({ name: "WebGPU run " + name + ": every output of the helper's builtin loop", ok: !err && !bad.length, detail: (err ? err.message + " " : "") + bad.slice(0, 6).join(", ") });
	}
	// Run the virtual invocations (virt.rs) and compare every output.
	for (const f of ["virt.comp.spv", "virt.comp.opt.spv"]) {
		for (const c of virtRun.cases) {
			const name = f + " BS=" + c.bs;
			const r = out[name];
			if (!r) continue;
			const U = GPUBufferUsage;
			const bufs = [
				[virtRun.a.length, new Float32Array(virtRun.a)],
				[c.o.length, new Float32Array(c.o.length).fill(-1)],
				[c.ids.length, new Uint32Array(c.ids.length).fill(0xffffffff)],
				[virtRun.rows, new Float32Array(virtRun.rows)],
				[virtRun.rows, new Uint32Array(virtRun.rows)],
			].map(([n, init]) => {
				const b = device.createBuffer({ size: Math.max(256, n * 4), usage: U.STORAGE | U.COPY_DST | U.COPY_SRC });
				device.queue.writeBuffer(b, 0, init);
				return b;
			});
			const pc = device.createBuffer({ size: 256, usage: U.UNIFORM | U.COPY_DST });
			device.queue.writeBuffer(pc, 0, new Uint32Array([virtRun.n, virtRun.rows]));
			const bgls = [], groups = [];
			for (let g = 0; g <= 1; g++) {
				const bs = g === 1 ? [{ wgslBinding: 0, kind: "uniform", buf: pc }] : r.bindings.filter((b) => b.group === 0).map((b) => ({ ...b, buf: bufs[b.binding] }));
				const l = device.createBindGroupLayout({ entries: bs.map((b) => ({ binding: b.wgslBinding, visibility: GPUShaderStage.COMPUTE, buffer: { type: b.kind } })) });
				bgls.push(l);
				groups.push(device.createBindGroup({ layout: l, entries: bs.map((b) => ({ binding: b.wgslBinding, resource: { buffer: b.buf } })) }));
			}
			device.pushErrorScope("validation");
			const pl = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: bgls }), compute: { module: mods[name], entryPoint: r.entryPoint } });
			const enc = device.createCommandEncoder();
			const pass = enc.beginComputePass();
			pass.setPipeline(pl);
			groups.forEach((bg, g) => pass.setBindGroup(g, bg));
			pass.dispatchWorkgroups(virtRun.rows + 1);
			pass.end();
			const rbs = bufs.slice(1).map((b) => {
				const rb = device.createBuffer({ size: b.size, usage: U.MAP_READ | U.COPY_DST });
				enc.copyBufferToBuffer(b, 0, rb, 0, b.size);
				return rb;
			});
			device.queue.submit([enc.finish()]);
			const err = await device.popErrorScope();
			const got = [];
			for (const [i, rb] of rbs.entries()) {
				await rb.mapAsync(GPUMapMode.READ);
				got.push(i === 1 || i === 3 ? [...new Uint32Array(rb.getMappedRange())] : [...new Float32Array(rb.getMappedRange())]);
			}
			const bad = [];
			for (const [k, want, g] of [["o", c.o, got[0]], ["ids", c.ids, got[1]], ["sums", c.sums, got[2]], ["counts", c.counts, got[3]]])
				for (let i = 0; i < want.length && bad.length < 6; i++) if (g[i] !== want[i]) bad.push(k + "[" + i + "] " + g[i] + " != " + want[i]);
			res.push({ name: "WebGPU run " + name + ": every output of the virtual invocations", ok: !err && !bad.length, detail: (err ? err.message + " " : "") + bad.join(", ") });
		}
	}
	// Run the lowered subgroup builtins (subgroup.rs) and compare every output.
	for (const f of ["subgroup.v13.comp.spv", "subgroup.v13.comp.opt.spv"]) {
		for (const c of subgroupRun) {
			const name = f + " " + c.name;
			const r = out[name];
			if (!r) continue;
			const U = GPUBufferUsage;
			const bufs = [new Float32Array(c.a), new Float32Array(c.o.length).fill(-1), new Uint32Array(c.info.length).fill(0xffffffff)].map((init) => {
				const b = device.createBuffer({ size: init.byteLength, usage: U.STORAGE | U.COPY_DST | U.COPY_SRC });
				device.queue.writeBuffer(b, 0, init);
				return b;
			});
			const bs = r.bindings.filter((b) => b.group === 0);
			const l = device.createBindGroupLayout({ entries: bs.map((b) => ({ binding: b.wgslBinding, visibility: GPUShaderStage.COMPUTE, buffer: { type: b.kind } })) });
			const bg = device.createBindGroup({ layout: l, entries: bs.map((b) => ({ binding: b.wgslBinding, resource: { buffer: bufs[b.binding] } })) });
			device.pushErrorScope("validation");
			const pl = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [l] }), compute: { module: mods[name], entryPoint: r.entryPoint } });
			const enc = device.createCommandEncoder();
			const pass = enc.beginComputePass();
			pass.setPipeline(pl);
			pass.setBindGroup(0, bg);
			pass.dispatchWorkgroups(c.groups);
			pass.end();
			const rbs = bufs.slice(1).map((b) => {
				const rb = device.createBuffer({ size: b.size, usage: U.MAP_READ | U.COPY_DST });
				enc.copyBufferToBuffer(b, 0, rb, 0, b.size);
				return rb;
			});
			device.queue.submit([enc.finish()]);
			const err = await device.popErrorScope();
			await rbs[0].mapAsync(GPUMapMode.READ);
			await rbs[1].mapAsync(GPUMapMode.READ);
			const got = [[...new Float32Array(rbs[0].getMappedRange())], [...new Uint32Array(rbs[1].getMappedRange())]];
			const bad = [];
			for (const [k, want, g] of [["o", c.o, got[0]], ["info", c.info, got[1]]])
				for (let i = 0; i < want.length && bad.length < 6; i++) if (g[i] !== want[i]) bad.push(k + "[" + i + "] " + g[i] + " != " + want[i]);
			res.push({ name: "WebGPU run " + name + ": every output of the lowered subgroup builtins", ok: !err && !bad.length, detail: (err ? err.message + " " : "") + bad.join(", ") });
		}
	}
	// Texel buffers: every element of every case's view format decoded, at
	// its first byte, zeros past the count, and the sizes.
	for (const name of ["texel.comp.spv", "texel.comp.opt.spv"]) {
		const r = out[name];
		if (!r) continue;
		const U = GPUBufferUsage;
		const l = device.createBindGroupLayout({ entries: r.bindings.map((b) => ({ binding: b.wgslBinding, visibility: GPUShaderStage.COMPUTE, buffer: { type: b.kind } })) });
		const pl = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [l] }), compute: { module: mods[name], entryPoint: r.entryPoint } });
		const slot = { f: 0, i: 1, u: 2 };
		const bad = [];
		for (const c of texelRun) {
			const data = device.createBuffer({ size: (c.bytes.length + 3) & ~3, usage: U.STORAGE | U.COPY_DST });
			device.queue.writeBuffer(data, 0, new Uint8Array(c.bytes));
			const mk = (p) => { const b = device.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST }); device.queue.writeBuffer(b, 0, new Uint32Array(p)); return b; };
			const params = [0, 1, 2].map((s) => mk(s === slot[c.kind] ? [c.fmt, c.base, c.count, c.size] : [0, 0, 0, 4]));
			const o = device.createBuffer({ size: 784, usage: U.STORAGE | U.COPY_SRC });
			const rb = device.createBuffer({ size: 784, usage: U.MAP_READ | U.COPY_DST });
			const bg = device.createBindGroup({ layout: l, entries: r.bindings.map((b) => ({ binding: b.wgslBinding, resource: { buffer: b.texel === "params" ? params[b.binding] : b.texel ? data : o } })) });
			device.pushErrorScope("validation");
			const enc = device.createCommandEncoder();
			const pass = enc.beginComputePass();
			pass.setPipeline(pl);
			pass.setBindGroup(0, bg);
			pass.dispatchWorkgroups(1);
			pass.end();
			enc.copyBufferToBuffer(o, 0, rb, 0, 784);
			device.queue.submit([enc.finish()]);
			const err = await device.popErrorScope();
			await rb.mapAsync(GPUMapMode.READ);
			const m = rb.getMappedRange();
			const at = slot[c.kind] * 64;
			const got = c.kind === "f" ? new Float32Array(m, at * 4, 64) : c.kind === "i" ? new Int32Array(m, at * 4, 64) : new Uint32Array(m, at * 4, 64);
			const sizes = [...new Int32Array(m, 192 * 4, 3)];
			if (err) bad.push(c.fmt + ": " + err.message);
			for (let n = 0; n < 16; n++)
				for (let k = 0; k < 4; k++) {
					const w = c.want[n][k], g = got[n * 4 + k];
					const ok = c.kind === "f" ? Math.abs(g - w) <= 1e-6 * Math.max(1, Math.abs(w)) : g === w;
					if (!ok && bad.length < 8) bad.push("format " + c.fmt + " element " + n + "." + k + ": " + g + " != " + w);
				}
			if (sizes[slot[c.kind]] !== c.count && bad.length < 8) bad.push("format " + c.fmt + ": size " + sizes[slot[c.kind]] + " != " + c.count);
			rb.unmap();
		}
		res.push({ name: "WebGPU run " + name + ": " + texelRun.length + " view formats decoded at a nonzero first byte, zeros past the count, sizes", ok: !bad.length, detail: bad.join(", ") });
	}
	// Every storage format: the elements of a case's view stored through a
	// view of the same format (base 32, 16 elements): the bytes come back
	// (snorm's -128 and -32768 as -127 and -32767), zeros past the count.
	for (const name of ["texelrt.comp.spv", "texelrt.comp.opt.spv"]) {
		const r = out[name];
		if (!r) continue;
		const U = GPUBufferUsage;
		const l = device.createBindGroupLayout({ entries: r.bindings.map((b) => ({ binding: b.wgslBinding, visibility: GPUShaderStage.COMPUTE, buffer: { type: b.kind } })) });
		const pl = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [l] }), compute: { module: mods[name], entryPoint: r.entryPoint } });
		const slot = { f: 0, i: 1, u: 2 };
		const bad = [];
		let n = 0;
		for (const c of texelRun) {
			if (c.fmt === 122) continue; // not a storage format
			n++;
			const mk = (bytes, usage) => { const b = device.createBuffer({ size: (bytes.length + 3) & ~3, usage }); device.queue.writeBuffer(b, 0, bytes); return b; };
			const prm = (p) => mk(new Uint8Array(new Uint32Array(p).buffer), U.UNIFORM | U.COPY_DST);
			const src = mk(new Uint8Array(c.bytes), U.STORAGE | U.COPY_DST);
			const dstLen = 32 + 16 * c.size + 32;
			const dst = mk(new Uint8Array(dstLen).fill(0xee), U.STORAGE | U.COPY_DST | U.COPY_SRC);
			const none = () => mk(new Uint8Array(64), U.STORAGE | U.COPY_DST); // one per binding: writable ones must not alias
			const s = slot[c.kind];
			const resOf = (b) => (b.binding < 3 ? (b.texel === "params" ? prm(b.binding === s ? [c.fmt, c.base, c.count, c.size] : [0, 0, 0, 4]) : b.binding === s ? src : none()) : b.texel === "params" ? prm(b.binding - 3 === s ? [c.fmt, 32, 16, c.size] : [0, 0, 0, 4]) : b.binding - 3 === s ? dst : none());
			const bg = device.createBindGroup({ layout: l, entries: r.bindings.map((b) => ({ binding: b.wgslBinding, resource: { buffer: resOf(b) } })) });
			device.pushErrorScope("validation");
			const enc = device.createCommandEncoder();
			const pass = enc.beginComputePass();
			pass.setPipeline(pl);
			pass.setBindGroup(0, bg);
			pass.dispatchWorkgroups(1);
			pass.end();
			const rb = device.createBuffer({ size: dst.size, usage: U.MAP_READ | U.COPY_DST });
			enc.copyBufferToBuffer(dst, 0, rb, 0, dst.size);
			device.queue.submit([enc.finish()]);
			const err = await device.popErrorScope();
			if (err) bad.push(c.fmt + ": " + err.message);
			await rb.mapAsync(GPUMapMode.READ);
			const got = new Uint8Array(rb.getMappedRange().slice(0, dstLen));
			const want = new Uint8Array(dstLen).fill(0xee);
			want.fill(0, 32, 32 + 16 * c.size);
			want.set(c.bytes.slice(c.base, c.base + c.count * c.size), 32);
			const sn8 = [10, 17, 38, 52].includes(c.fmt), sn16 = [71, 78, 92].includes(c.fmt);
			for (let j = 32; j < 32 + c.count * c.size; j++) {
				if (sn8 && want[j] === 0x80) want[j] = 0x81;
				if (sn16 && (j - 32) % 2 === 1 && want[j] === 0x80 && want[j - 1] === 0) want[j - 1] = 1;
			}
			for (let j = 0; j < dstLen && bad.length < 8; j++) if (got[j] !== want[j]) bad.push("format " + c.fmt + " byte " + (j - 32) + ": " + got[j] + " != " + want[j]);
			rb.unmap();
		}
		res.push({ name: "WebGPU run " + name + ": " + n + " storage formats encoded back to their bytes, zeros past the count, nothing outside the view", ok: !bad.length, detail: bad.join(", ") });
	}
	// Storage texel buffers: read, converted and written back in three
	// formats; written without a format; atomics; a store past the end dropped.
	for (const name of ["texelimg.comp.spv", "texelimg.comp.opt.spv"]) {
		const r = out[name];
		if (!r) continue;
		const U = GPUBufferUsage;
		const l = device.createBindGroupLayout({ entries: r.bindings.map((b) => ({ binding: b.wgslBinding, visibility: GPUShaderStage.COMPUTE, buffer: { type: b.kind } })) });
		const pl = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [l] }), compute: { module: mods[name], entryPoint: r.entryPoint } });
		const bad = [];
		// img in three formats; wo, no format in the SPIR-V, in RGBA8_UINT and narrow R8_UINT, R16_UINT (atomicAnd + atomicOr)
		for (const [fmt, size, woFmt, woSize] of [[109, 16, 41, 4], [97, 8, 13, 1], [37, 4, 74, 2]]) {
			const base = 32;
			const src = new Float32Array(64).map((_, j) => (j % 7) / 8 - 0.25);
			const imgBytes = new Uint8Array(base + 16 * size);
			const dv = new DataView(imgBytes.buffer);
			const f2h = (v) => { const f = new Float32Array([v]); const u = new Uint32Array(f.buffer)[0]; const s = (u >>> 16) & 0x8000, e = ((u >>> 23) & 255) - 127 + 15, m = (u >>> 13) & 1023; return v === 0 ? 0 : s | (e << 10) | m; };
			for (let j = 0; j < 64; j++) {
				if (fmt === 109) dv.setFloat32(base + j * 4, src[j], true);
				else if (fmt === 97) dv.setUint16(base + j * 2, f2h(src[j]), true);
				else dv.setUint8(base + j, Math.round(Math.min(1, Math.max(0, src[j])) * 255));
			}
			const mk = (bytes) => { const b = device.createBuffer({ size: (bytes.byteLength + 3) & ~3, usage: U.STORAGE | U.COPY_DST | U.COPY_SRC }); device.queue.writeBuffer(b, 0, bytes); return b; };
			const prm = (p) => { const b = device.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST }); device.queue.writeBuffer(b, 0, new Uint32Array(p)); return b; };
			const img = mk(imgBytes);
			const wo = mk(new Uint8Array(16 + 128).fill(0xee));
			const counter = mk(new Uint32Array(8));
			const imax = mk(new Int32Array([-100, 0, 0, 0]));
			const ro = mk(new Int8Array(64).map((_, j) => (j % 5) - 2));
			const bufs = [[img, prm([fmt, base, 16, size])], [wo, prm([woFmt, 16, 16, woSize])], [counter, prm([98, 16, 4, 4])], [imax, prm([99, 0, 1, 4])], [ro, prm([42, 0, 16, 4])]];
			const bg = device.createBindGroup({ layout: l, entries: r.bindings.map((b) => ({ binding: b.wgslBinding, resource: { buffer: bufs[b.binding][b.texel === "params" ? 1 : 0] } })) });
			device.pushErrorScope("validation");
			const enc = device.createCommandEncoder();
			const pass = enc.beginComputePass();
			pass.setPipeline(pl);
			pass.setBindGroup(0, bg);
			pass.dispatchWorkgroups(1);
			pass.end();
			const rbs = [img, wo, counter, imax].map((b) => { const rb = device.createBuffer({ size: b.size, usage: U.MAP_READ | U.COPY_DST }); enc.copyBufferToBuffer(b, 0, rb, 0, b.size); return rb; });
			device.queue.submit([enc.finish()]);
			const err = await device.popErrorScope();
			if (err) bad.push(fmt + ": " + err.message);
			for (const rb of rbs) await rb.mapAsync(GPUMapMode.READ);
			const gi = new DataView(rbs[0].getMappedRange()), gw = new Uint8Array(rbs[1].getMappedRange()), gc = new Uint32Array(rbs[2].getMappedRange()), gm = new Int32Array(rbs[3].getMappedRange());
			const h2f = (h) => { const e = (h >> 10) & 31, m = h & 1023; const v = e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15); return h & 0x8000 ? -v : v; };
			for (let j = 0; j < 64 && bad.length < 8; j++) {
				const inv = fmt === 109 ? src[j] : fmt === 97 ? h2f(f2h(src[j])) : Math.round(Math.min(1, Math.max(0, src[j])) * 255) / 255;
				const want = fmt === 37 ? Math.round(Math.min(1, Math.max(0, inv * 2 + 1)) * 255) : inv * 2 + 1;
				const g = fmt === 109 ? gi.getFloat32(base + j * 4, true) : fmt === 97 ? h2f(gi.getUint16(base + j * 2, true)) : gi.getUint8(base + j);
				if (Math.abs(g - want) > (fmt === 97 ? 2e-3 : 1e-6)) bad.push("format " + fmt + " component " + j + ": " + g + " != " + want);
			}
			for (let n = 0; n < 16 && bad.length < 8; n++) {
				const rov = [0, 1, 2, 3].map((c) => ((n * 4 + c) % 5) - 2);
				const v = [n, 2 * n, 3 * n, 255 - n].map((x, c) => x + rov[c]);
				// RGBA8_UINT: 4 bytes; R8_UINT: x's low byte; R16_UINT: x's low 16 bits
				const want = woSize === 4 ? v.map((x) => x & 255) : woSize === 1 ? [v[0] & 255] : [v[0] & 255, (v[0] >> 8) & 255];
				for (let c = 0; c < want.length; c++) if (gw[16 + n * woSize + c] !== want[c]) bad.push("wo " + woFmt + " " + n + "." + c + ": " + gw[16 + n * woSize + c] + " != " + want[c]);
			}
			if (!gw.slice(0, 16).every((x) => x === 0xee) || !gw.slice(16 + 16 * woSize).every((x) => x === 0xee)) bad.push("wo " + woFmt + ": bytes outside the view written");
			if ([...gc].join() !== "0,0,0,0,4,4,4,4") bad.push("counter " + [...gc].join());
			if (gm[0] !== 7) bad.push("imax " + gm[0]);
		}
		res.push({ name: "WebGPU run " + name + ": storage texel buffers in three formats, without a format (4-, 1- and 2-byte texels), atomics, a store past the end dropped", ok: !bad.length, detail: bad.join(", ") });
	}
	// Shapes flow.rs and virt.rs leave alone: WebGPU refuses them for uniformity.
	for (const [name, r] of Object.entries(neg)) {
		const info = await device.createShaderModule({ code: r.wgsl }).getCompilationInfo();
		const msgs = info.messages.filter((x) => x.type === "error").map((x) => x.message);
		res.push({ name: "WebGPU refuses " + name + " (uniformity)", ok: msgs.some((m) => /uniform control flow/.test(m)), detail: msgs.join("; ") || "compiled" });
	}
	res.push({ name: "WebGPU adapter " + (adapter.info?.description || adapter.info?.vendor || "?"), ok: true });
} catch (e) {
	res.push({ name: "WebGPU", ok: false, detail: String(e.message ?? e) });
}
await fetch("/result", { method: "POST", body: JSON.stringify(res) });
</script>`;

if (!process.argv.includes("--no-gpu")) {
	let results: { name: string; ok: boolean; detail?: string }[];
	try {
		results = await inChrome(page, 60_000);
	} catch (e) {
		results = [{ name: "chrome", ok: false, detail: (e as Error).message }];
	}
	for (const r of results) check(r.name, r.ok, r.detail);
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
