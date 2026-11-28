// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//
// Texel buffers (samplerBuffer, textureBuffer, imageBuffer: OpTypeImage Dim
// Buffer) on WebGPU, which has none (vk/PROTOCOL.md, Amendments, "Texel
// buffers"). A texel buffer at set S binding B becomes two bindings:
//
//   @binding(2B)     kw_tb_S_B_w: { w: array<u32> }   the buffer's words, from
//                    the view's offset rounded down to the device's storage
//                    alignment (read-only unless the module writes it)
//   @binding(2B + 1) kw_tb_S_B_p: { p: vec4<u32> }    uniform: the view's
//                    VkFormat, its first byte in the binding, its element
//                    count and its texel size in bytes
//
// texelFetch/imageLoad decode the element's words by the view's format (a
// switch in WGSL, uniform per draw), imageStore encodes them, textureSize/
// imageSize read the count, and image atomics (OpImageTexelPointer) become
// atomics on the element's word (32-bit texels). Out-of-range elements read
// 0 and stores to them are dropped. The view's format decides, as on
// hardware; the format in the SPIR-V only tells whether texels may be
// under 4 bytes (8/16-bit formats, or Unknown): a binding the module
// writes is then `array<atomic<u32>>`, such a texel stored with atomicAnd
// + atomicOr on its word, as neighbouring invocations may store the
// word's other bytes at once.
//
// SPIR-V cannot express the decoding switch compactly, so each texel
// operation becomes a call of a stub function per binding (naga keeps the
// globals it touches and reflects them), and `patch_wgsl` replaces the
// fetch and store stubs' WGSL with the real code after naga wrote it.

use std::collections::{HashMap, HashSet};

const OP_NAME: u32 = 5;
const OP_MEMBER_NAME: u32 = 6;
const OP_ENTRY_POINT: u32 = 15;
const OP_TYPE_VOID: u32 = 19;
const OP_TYPE_INT: u32 = 21;
const OP_TYPE_FLOAT: u32 = 22;
const OP_TYPE_VECTOR: u32 = 23;
const OP_TYPE_IMAGE: u32 = 25;
const OP_TYPE_SAMPLED_IMAGE: u32 = 27;
const OP_TYPE_ARRAY: u32 = 28;
const OP_TYPE_RUNTIME_ARRAY: u32 = 29;
const OP_TYPE_STRUCT: u32 = 30;
const OP_TYPE_POINTER: u32 = 32;
const OP_TYPE_FUNCTION: u32 = 33;
const OP_CONSTANT: u32 = 43;
const OP_FUNCTION: u32 = 54;
const OP_FUNCTION_PARAMETER: u32 = 55;
const OP_FUNCTION_END: u32 = 56;
const OP_FUNCTION_CALL: u32 = 57;
const OP_VARIABLE: u32 = 59;
const OP_IMAGE_TEXEL_POINTER: u32 = 60;
const OP_LOAD: u32 = 61;
const OP_STORE: u32 = 62;
const OP_ACCESS_CHAIN: u32 = 65;
const OP_DECORATE: u32 = 71;
const OP_MEMBER_DECORATE: u32 = 72;
const OP_VECTOR_SHUFFLE: u32 = 79;
const OP_COMPOSITE_CONSTRUCT: u32 = 80;
const OP_COMPOSITE_EXTRACT: u32 = 81;
const OP_COPY_OBJECT: u32 = 83;
const OP_SAMPLED_IMAGE: u32 = 86;
const OP_IMAGE_FETCH: u32 = 95;
const OP_IMAGE_READ: u32 = 98;
const OP_IMAGE_WRITE: u32 = 99;
const OP_IMAGE: u32 = 100;
const OP_IMAGE_QUERY_SIZE_LOD: u32 = 103;
const OP_IMAGE_QUERY_SIZE: u32 = 104;
const OP_BITCAST: u32 = 124;
const OP_IADD: u32 = 128;
const OP_SELECT: u32 = 169;
const OP_SHR: u32 = 194;
const OP_ATOMIC_LOAD: u32 = 227;
const OP_ATOMIC_STORE: u32 = 228;
const OP_PHI: u32 = 245;
const OP_LABEL: u32 = 248;
const OP_RETURN: u32 = 253;
const OP_RETURN_VALUE: u32 = 254;
const DEC_BLOCK: u32 = 2;
const DEC_ARRAY_STRIDE: u32 = 6;
const DEC_NON_WRITABLE: u32 = 24;
const DEC_BINDING: u32 = 33;
const DEC_SET: u32 = 34;
const DEC_OFFSET: u32 = 35;
const SC_UNIFORM_CONSTANT: u32 = 0;
const SC_UNIFORM: u32 = 2;
const SC_IMAGE: u32 = 11;
const SC_STORAGE_BUFFER: u32 = 12;
const DIM_BUFFER: u32 = 5;

fn inst(out: &mut Vec<u32>, op: u32, operands: &[u32]) {
	out.push(((operands.len() as u32 + 1) << 16) | op);
	out.extend_from_slice(operands);
}

fn name(out: &mut Vec<u32>, op: u32, target: &[u32], s: &str) {
	let mut b = s.as_bytes().to_vec();
	b.push(0);
	while b.len() % 4 != 0 {
		b.push(0);
	}
	let mut ops = target.to_vec();
	ops.extend(b.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])));
	inst(out, op, &ops);
}

/// What the WGSL and the reflection need after naga ran.
#[derive(Default)]
pub struct Texel {
	/// variable -> WGSL binding (split_combined_samplers keeps them)
	pub fixed: Vec<(u32, u32)>,
	/// (group, WGSL binding, "data" | "params") for the reflection
	pub reflect: Vec<(u32, u32, &'static str)>,
	/// stub function name -> its WGSL (signature and body)
	helpers: Vec<(String, String)>,
}

// One texel buffer variable.
struct Var {
	set: u32,
	binding: u32,
	kind: char, // f, i, u: the image's sampled type
	ck: u32,    // that component type's id
	written: bool,
	// a format of texels under 4 bytes possible (declared so, or Unknown):
	// stores read-modify-write words
	narrow: bool,
	atomic: Option<bool>, // Some(signed): its words are atomics (OpImageTexelPointer on it, or narrow stores)
	data: u32,
	params: u32,
	fetch: u32,
	store: u32,
	size: u32,
	need: [bool; 3], // fetch, store, size reached
}

// Opcodes with no result type (or none at a[0] / no result id at a[1]):
// what val_ty must not record.
fn untyped(o: u32) -> bool {
	(19..=39).contains(&o)
		|| matches!(
			o,
			2 | 3 | 4 | 5 | 6 | 7 | 8 | 10 | 11 | 14 | 15 | 16 | 17 | 56 | 62 | 63 | 64 | 71..=75 | 99 | 224 | 225 | 228 | 246..=257 | 317 | 331 | 332 | 400 | 4416 | 5632 | 5633
		)
}

pub fn lower_texel_buffers(words: Vec<u32>, vertex: bool) -> Result<(Vec<u32>, Texel), String> {
	// Most modules have none: back before any map is made (std's hash keys
	// on wasm32 advance with every map, so making them would reorder the
	// output of later passes for nothing).
	let mut i = 5;
	let mut any = false;
	while i < words.len() && !any {
		let n = (words[i] >> 16) as usize;
		any = words[i] & 0xffff == OP_TYPE_IMAGE && n >= 4 && words[i + 3] == DIM_BUFFER;
		i += n;
	}
	if !any {
		return Ok((words, Texel::default()));
	}
	// image types of Dim Buffer, sampled images of them, pointers to either
	let mut tb_img: HashMap<u32, u32> = HashMap::new(); // image type -> sampled type
	let mut tb_fmt: HashMap<u32, u32> = HashMap::new(); // image type -> its SPIR-V ImageFormat
	let mut tb_simg: HashMap<u32, u32> = HashMap::new(); // sampled image type -> image type
	let mut tb_ptr: HashMap<u32, u32> = HashMap::new(); // UniformConstant pointer -> image type
	let mut tb_arr: HashSet<u32> = HashSet::new(); // arrays of them (and pointers to those)
	let mut ints: HashMap<u32, (u32, bool)> = HashMap::new();
	let mut floats: HashMap<u32, u32> = HashMap::new();
	let mut vecs: HashMap<u32, (u32, u32)> = HashMap::new();
	let mut ptrs: HashMap<u32, (u32, u32)> = HashMap::new(); // pointer -> (class, pointee)
	let mut void_ty = None;
	let mut set_of: HashMap<u32, u32> = HashMap::new();
	let mut binding_of: HashMap<u32, u32> = HashMap::new();
	let mut val_ty: HashMap<u32, u32> = HashMap::new();
	let mut vars: Vec<(u32, u32)> = Vec::new(); // (variable, image type)
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let a = &words[i + 1..i + n];
		match o {
			OP_TYPE_VOID => void_ty = Some(a[0]),
			OP_TYPE_INT if a.len() >= 3 => {
				ints.insert(a[0], (a[1], a[2] != 0));
			}
			OP_TYPE_FLOAT if a.len() >= 2 => {
				floats.insert(a[0], a[1]);
			}
			OP_TYPE_VECTOR if a.len() >= 3 => {
				vecs.insert(a[0], (a[1], a[2]));
			}
			OP_TYPE_IMAGE if a.len() >= 8 && a[2] == DIM_BUFFER => {
				tb_img.insert(a[0], a[1]);
				tb_fmt.insert(a[0], a[7]);
			}
			OP_TYPE_SAMPLED_IMAGE if a.len() >= 2 && tb_img.contains_key(&a[1]) => {
				tb_simg.insert(a[0], a[1]);
			}
			OP_TYPE_ARRAY | OP_TYPE_RUNTIME_ARRAY if a.len() >= 2 && (tb_img.contains_key(&a[1]) || tb_simg.contains_key(&a[1])) => {
				tb_arr.insert(a[0]);
			}
			OP_TYPE_POINTER if a.len() >= 3 => {
				ptrs.insert(a[0], (a[1], a[2]));
				if let Some(&img) = tb_img.get(&a[2]).map(|_| &a[2]).or_else(|| tb_simg.get(&a[2])).filter(|_| a[1] == SC_UNIFORM_CONSTANT) {
					tb_ptr.insert(a[0], img);
				}
				if tb_arr.contains(&a[2]) {
					tb_arr.insert(a[0]);
				}
			}
			OP_TYPE_FUNCTION if a[1..].iter().any(|t| tb_ptr.contains_key(t) || tb_img.contains_key(t) || tb_simg.contains_key(t)) => {
				return Err("a texel buffer (samplerBuffer, imageBuffer) passed to a function is not supported".into());
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_SET => {
				set_of.insert(a[0], a[2]);
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_BINDING => {
				binding_of.insert(a[0], a[2]);
			}
			OP_VARIABLE if a.len() >= 3 => {
				if let Some(&img) = tb_ptr.get(&a[0]) {
					vars.push((a[1], img));
				} else if tb_arr.contains(&a[0]) {
					return Err(format!(
						"descriptor arrays of texel buffers are not supported (set {} binding {})",
						set_of.get(&a[1]).copied().unwrap_or(0),
						binding_of.get(&a[1]).copied().unwrap_or(0)
					));
				}
				val_ty.insert(a[1], a[0]);
			}
			_ => {
				if n >= 3 && !untyped(o) {
					val_ty.insert(a[1], a[0]);
				}
			}
		}
		i += n;
	}
	if tb_img.is_empty() {
		return Ok((words, Texel::default()));
	}

	let mut bound = words[3];
	let mut id = || {
		bound += 1;
		bound - 1
	};
	let mut tv: Vec<Var> = Vec::new();
	let mut var_index: HashMap<u32, usize> = HashMap::new();
	for &(v, img) in &vars {
		let st = tb_img[&img];
		let kind = match (ints.get(&st), floats.get(&st)) {
			(Some(&(32, true)), _) => 'i',
			(Some(&(32, false)), _) => 'u',
			(_, Some(&32)) => 'f',
			_ => return Err("a texel buffer of a sampled type other than 32-bit float, int or uint is not supported".into()),
		};
		let (set, binding) = (set_of.get(&v).copied().unwrap_or(0), binding_of.get(&v).copied().unwrap_or(0));
		if tv.iter().any(|t| t.set == set && t.binding == binding) {
			return Err(format!("two texel buffer variables at set {} binding {} are not supported", set, binding));
		}
		var_index.insert(v, tv.len());
		// SPIR-V ImageFormats of texels under 4 bytes: R16f, Rg8, R16, R8, Rg8Snorm, R16Snorm, R8Snorm, Rg8i, R16i, R8i, Rg8ui, R16ui, R8ui
		let narrow = matches!(tb_fmt[&img], 0 | 9 | 13 | 14 | 15 | 18 | 19 | 20 | 27 | 28 | 29 | 37 | 38 | 39);
		tv.push(Var { set, binding, kind, ck: st, written: false, narrow, atomic: None, data: 0, params: 0, fetch: 0, store: 0, size: 0, need: [false; 3] });
	}

	// Values that are a texel buffer (loads of its variable and the images
	// taken from them), and what the module does with each.
	let mut alias: HashMap<u32, usize> = HashMap::new();
	let mut other_texel_ptr = false; // OpImageTexelPointer on other images
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let a = &words[i + 1..i + n];
		match o {
			OP_LOAD if a.len() >= 3 => {
				if let Some(&k) = var_index.get(&a[2]) {
					alias.insert(a[1], k);
				}
			}
			OP_IMAGE | OP_COPY_OBJECT if a.len() >= 3 => {
				if let Some(&k) = alias.get(&a[2]) {
					alias.insert(a[1], k);
				}
			}
			OP_SAMPLED_IMAGE if a.len() >= 4 => {
				if let Some(&k) = alias.get(&a[2]) {
					alias.insert(a[1], k);
				}
			}
			OP_IMAGE_WRITE if a.len() >= 3 => {
				if let Some(&k) = alias.get(&a[0]) {
					tv[k].written = true;
				}
			}
			OP_IMAGE_TEXEL_POINTER if a.len() >= 5 => {
				if let Some(&k) = var_index.get(&a[2]) {
					let pointee = ptrs.get(&a[0]).map(|p| p.1).unwrap_or(0);
					let signed = match ints.get(&pointee) {
						Some(&(32, s)) => s,
						_ => return Err(format!("image atomics on a texel buffer of other than 32-bit integers are not supported (set {} binding {})", tv[k].set, tv[k].binding)),
					};
					tv[k].written = true;
					tv[k].atomic = Some(signed);
				} else {
					other_texel_ptr = true;
				}
			}
			OP_PHI | OP_SELECT | OP_FUNCTION_CALL => {
				let from = if o == OP_FUNCTION_CALL { 3 } else { 2 };
				if a.len() > from && a[from..].iter().any(|x| alias.contains_key(x) || var_index.contains_key(x)) {
					return Err(format!("a texel buffer used by opcode {} (a phi, select or call) is not supported", o));
				}
			}
			_ => {}
		}
		i += n;
	}
	for t in tv.iter_mut() {
		// narrow texels share words with their neighbours, which other
		// invocations may store at once: atomicAnd + atomicOr on the word
		if t.written && t.narrow && t.atomic.is_none() {
			t.atomic = Some(false);
		}
	}
	for t in &tv {
		if vertex && t.written {
			return Err(format!(
				"set {} binding {}: a storage texel buffer the vertex stage writes cannot work on WebGPU (no writable storage in vertex shaders)",
				t.set, t.binding
			));
		}
	}

	// New ids.
	let (t_uint, t_int, t_uvec4, c0, c1, c2) = (id(), id(), id(), id(), id(), id());
	let (t_params, p_params, p_uvec4, p_uint) = (id(), id(), id(), id());
	let (t_rarr_u, t_words_u, p_words_u, p_word_u) = (id(), id(), id(), id());
	let (t_rarr_i, t_words_i, p_words_i, p_word_i) = (id(), id(), id(), id());
	let (fty_size, void_new) = (id(), id());
	let t_void = void_ty.unwrap_or(void_new);
	let any_signed = tv.iter().any(|t| t.atomic == Some(true));
	// per sampled kind: vec4 type, zero, fetch and store function types
	let mut kinds: HashMap<char, (u32, u32, u32, u32, u32)> = HashMap::new(); // kind -> (ck, v4, zero, fty_fetch, fty_store)
	for t in tv.iter_mut() {
		if !kinds.contains_key(&t.kind) {
			let e = (t.ck, id(), id(), id(), id());
			kinds.insert(t.kind, e);
		}
		t.data = id();
		t.params = id();
		t.fetch = id();
		t.store = id();
		t.size = id();
	}
	let mut kind_list: Vec<char> = kinds.keys().copied().collect();
	kind_list.sort();
	let words_of = |t: &Var| if t.atomic == Some(true) { (p_words_i, p_word_i, t_int) } else { (p_words_u, p_word_u, t_uint) };

	let mut names: Vec<u32> = Vec::new();
	name(&mut names, OP_NAME, &[t_params], "kw_texel_params");
	name(&mut names, OP_MEMBER_NAME, &[t_params, 0], "p");
	name(&mut names, OP_NAME, &[t_words_u], "kw_texel_words");
	name(&mut names, OP_MEMBER_NAME, &[t_words_u, 0], "w");
	if any_signed {
		name(&mut names, OP_NAME, &[t_words_i], "kw_texel_words_i");
		name(&mut names, OP_MEMBER_NAME, &[t_words_i, 0], "w");
	}
	let mut decos: Vec<u32> = Vec::new();
	inst(&mut decos, OP_DECORATE, &[t_params, DEC_BLOCK]);
	inst(&mut decos, OP_MEMBER_DECORATE, &[t_params, 0, DEC_OFFSET, 0]);
	inst(&mut decos, OP_DECORATE, &[t_rarr_u, DEC_ARRAY_STRIDE, 4]);
	inst(&mut decos, OP_DECORATE, &[t_words_u, DEC_BLOCK]);
	inst(&mut decos, OP_MEMBER_DECORATE, &[t_words_u, 0, DEC_OFFSET, 0]);
	if any_signed {
		inst(&mut decos, OP_DECORATE, &[t_rarr_i, DEC_ARRAY_STRIDE, 4]);
		inst(&mut decos, OP_DECORATE, &[t_words_i, DEC_BLOCK]);
		inst(&mut decos, OP_MEMBER_DECORATE, &[t_words_i, 0, DEC_OFFSET, 0]);
	}
	let mut texel = Texel::default();
	for t in &tv {
		let base = format!("kw_tb_{}_{}", t.set, t.binding);
		name(&mut names, OP_NAME, &[t.data], &format!("{}_w", base));
		name(&mut names, OP_NAME, &[t.params], &format!("{}_p", base));
		name(&mut names, OP_NAME, &[t.fetch], &format!("{}_fetch", base));
		name(&mut names, OP_NAME, &[t.store], &format!("{}_store", base));
		name(&mut names, OP_NAME, &[t.size], &format!("{}_size", base));
		for v in [t.data, t.params] {
			inst(&mut decos, OP_DECORATE, &[v, DEC_SET, t.set]);
			inst(&mut decos, OP_DECORATE, &[v, DEC_BINDING, t.binding]);
		}
		if !t.written {
			inst(&mut decos, OP_DECORATE, &[t.data, DEC_NON_WRITABLE]);
		}
		texel.fixed.push((t.data, 2 * t.binding));
		texel.fixed.push((t.params, 2 * t.binding + 1));
		texel.reflect.push((t.set, 2 * t.binding, "data"));
		texel.reflect.push((t.set, 2 * t.binding + 1, "params"));
	}
	let mut types: Vec<u32> = Vec::new();
	if void_ty.is_none() {
		inst(&mut types, OP_TYPE_VOID, &[t_void]);
	}
	inst(&mut types, OP_TYPE_INT, &[t_uint, 32, 0]);
	inst(&mut types, OP_TYPE_INT, &[t_int, 32, 1]);
	inst(&mut types, OP_TYPE_VECTOR, &[t_uvec4, t_uint, 4]);
	inst(&mut types, OP_CONSTANT, &[t_uint, c0, 0]);
	inst(&mut types, OP_CONSTANT, &[t_uint, c1, 1]);
	inst(&mut types, OP_CONSTANT, &[t_uint, c2, 2]);
	inst(&mut types, OP_TYPE_STRUCT, &[t_params, t_uvec4]);
	inst(&mut types, OP_TYPE_POINTER, &[p_params, SC_UNIFORM, t_params]);
	inst(&mut types, OP_TYPE_POINTER, &[p_uvec4, SC_UNIFORM, t_uvec4]);
	inst(&mut types, OP_TYPE_POINTER, &[p_uint, SC_UNIFORM, t_uint]);
	inst(&mut types, OP_TYPE_RUNTIME_ARRAY, &[t_rarr_u, t_uint]);
	inst(&mut types, OP_TYPE_STRUCT, &[t_words_u, t_rarr_u]);
	inst(&mut types, OP_TYPE_POINTER, &[p_words_u, SC_STORAGE_BUFFER, t_words_u]);
	inst(&mut types, OP_TYPE_POINTER, &[p_word_u, SC_STORAGE_BUFFER, t_uint]);
	if any_signed {
		inst(&mut types, OP_TYPE_RUNTIME_ARRAY, &[t_rarr_i, t_int]);
		inst(&mut types, OP_TYPE_STRUCT, &[t_words_i, t_rarr_i]);
		inst(&mut types, OP_TYPE_POINTER, &[p_words_i, SC_STORAGE_BUFFER, t_words_i]);
		inst(&mut types, OP_TYPE_POINTER, &[p_word_i, SC_STORAGE_BUFFER, t_int]);
	}
	inst(&mut types, OP_TYPE_FUNCTION, &[fty_size, t_int]);
	for k in &kind_list {
		let (ck, v4, zero, ff, fs) = kinds[k];
		inst(&mut types, OP_TYPE_VECTOR, &[v4, ck, 4]);
		inst(&mut types, OP_CONSTANT, &[ck, zero, 0]);
		inst(&mut types, OP_TYPE_FUNCTION, &[ff, v4, t_int]);
		inst(&mut types, OP_TYPE_FUNCTION, &[fs, t_void, t_int, v4]);
	}
	for t in &tv {
		inst(&mut types, OP_VARIABLE, &[words_of(t).0, t.data, SC_STORAGE_BUFFER]);
		inst(&mut types, OP_VARIABLE, &[p_params, t.params, SC_UNIFORM]);
	}

	// Removed: the texel buffer types and variables, the Image-class
	// pointers only their texel pointers used, and everything naming them.
	let mut gone: HashSet<u32> = HashSet::new();
	gone.extend(tb_img.keys());
	gone.extend(tb_simg.keys());
	gone.extend(tb_ptr.keys());
	gone.extend(var_index.keys());
	let image_ptrs: HashSet<u32> = ptrs.iter().filter(|(_, &(sc, _))| sc == SC_IMAGE).map(|(&p, _)| p).collect();
	if !other_texel_ptr {
		gone.extend(&image_ptrs);
	}
	let is_vec4 = |t: u32| vecs.get(&t).map_or(false, |v| v.1 == 4);
	let int_coord = |out: &mut Vec<u32>, c: u32, id: &mut dyn FnMut() -> u32| -> u32 {
		// texel buffer coordinates are scalar ints; the stubs take i32
		match val_ty.get(&c).and_then(|t| ints.get(t)) {
			Some(&(_, true)) => c,
			_ => {
				let x = id();
				inst(out, OP_BITCAST, &[t_int, x, c]);
				x
			}
		}
	};

	let mut out: Vec<u32> = Vec::with_capacity(words.len() + names.len() + decos.len() + types.len() + 256);
	out.extend_from_slice(&words[..5]);
	let (mut names_done, mut decos_done, mut types_done) = (false, false, false);
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let a = &words[i + 1..i + n];
		let annotation = matches!(o, 71..=75 | 332 | 5632 | 5633);
		let global = (19..=39).contains(&o) || (41..=52).contains(&o) || o == OP_VARIABLE || o == OP_FUNCTION || o == 1; // 1: OpUndef
		if !names_done && (annotation || global || o == 331) {
			names_done = true;
			out.extend_from_slice(&names);
		}
		if !decos_done && global {
			decos_done = true;
			out.extend_from_slice(&decos);
		}
		if !types_done && o == OP_FUNCTION {
			types_done = true;
			out.extend_from_slice(&types);
		}
		match o {
			OP_ENTRY_POINT => {
				// the interface list after the name: the removed variables leave it
				let name_end = 2 + a[2..].iter().position(|w| w.to_le_bytes().contains(&0)).map_or(a.len() - 2, |p| p + 1);
				let mut ops: Vec<u32> = a[..name_end.min(a.len())].to_vec();
				ops.extend(a[name_end.min(a.len())..].iter().filter(|x| !gone.contains(x)));
				inst(&mut out, o, &ops);
			}
			OP_NAME | OP_MEMBER_NAME | OP_DECORATE | OP_MEMBER_DECORATE if !a.is_empty() && gone.contains(&a[0]) => {}
			OP_TYPE_IMAGE | OP_TYPE_SAMPLED_IMAGE | OP_TYPE_POINTER | OP_VARIABLE if gone.contains(&a[if o == OP_VARIABLE { 1 } else { 0 }]) => {}
			OP_LOAD if var_index.contains_key(&a[2]) => {}
			OP_IMAGE | OP_COPY_OBJECT | OP_SAMPLED_IMAGE if alias.contains_key(&a[1]) => {}
			OP_IMAGE_FETCH | OP_IMAGE_READ if alias.contains_key(&a[2]) => {
				let k = alias[&a[2]];
				tv[k].need[0] = true;
				let (_, v4, _, _, _) = kinds[&tv[k].kind];
				let c = int_coord(&mut out, a[3], &mut id);
				if is_vec4(a[0]) {
					inst(&mut out, OP_FUNCTION_CALL, &[v4, a[1], tv[k].fetch, c]);
				} else {
					let r = id();
					inst(&mut out, OP_FUNCTION_CALL, &[v4, r, tv[k].fetch, c]);
					match vecs.get(&a[0]) {
						Some(&(_, m)) => {
							let mut ops = vec![a[0], a[1], r, r];
							ops.extend(0..m);
							inst(&mut out, OP_VECTOR_SHUFFLE, &ops);
						}
						None => inst(&mut out, OP_COMPOSITE_EXTRACT, &[a[0], a[1], r, 0]),
					}
				}
			}
			OP_IMAGE_WRITE if alias.contains_key(&a[0]) => {
				let k = alias[&a[0]];
				tv[k].need[1] = true;
				let (ck, v4, zero, _, _) = kinds[&tv[k].kind];
				let c = int_coord(&mut out, a[1], &mut id);
				let tx = a[2];
				let texel = match val_ty.get(&tx).and_then(|t| vecs.get(t)) {
					Some(&(_, 4)) => tx,
					Some(&(_, m)) => {
						let mut comps: Vec<u32> = (0..m)
							.map(|j| {
								let e = id();
								inst(&mut out, OP_COMPOSITE_EXTRACT, &[ck, e, tx, j]);
								e
							})
							.collect();
						comps.resize(4, zero);
						let v = id();
						let mut ops = vec![v4, v];
						ops.extend(comps);
						inst(&mut out, OP_COMPOSITE_CONSTRUCT, &ops);
						v
					}
					None => {
						let v = id();
						inst(&mut out, OP_COMPOSITE_CONSTRUCT, &[v4, v, tx, zero, zero, zero]);
						v
					}
				};
				let r = id();
				inst(&mut out, OP_FUNCTION_CALL, &[t_void, r, tv[k].store, c, texel]);
			}
			OP_IMAGE_QUERY_SIZE | OP_IMAGE_QUERY_SIZE_LOD if alias.contains_key(&a[2]) => {
				let k = alias[&a[2]];
				tv[k].need[2] = true;
				if ints.get(&a[0]).map_or(false, |x| x.1) {
					inst(&mut out, OP_FUNCTION_CALL, &[t_int, a[1], tv[k].size]);
				} else {
					let r = id();
					inst(&mut out, OP_FUNCTION_CALL, &[t_int, r, tv[k].size]);
					inst(&mut out, OP_BITCAST, &[a[0], a[1], r]);
				}
			}
			OP_IMAGE_TEXEL_POINTER if var_index.contains_key(&a[2]) => {
				// the element's word: (first byte >> 2) + coordinate (32-bit texels)
				let t = &tv[var_index[&a[2]]];
				let (pa, py, pw, cu, ix) = (id(), id(), id(), id(), id());
				inst(&mut out, OP_ACCESS_CHAIN, &[p_uint, pa, t.params, c0, c1]);
				inst(&mut out, OP_LOAD, &[t_uint, py, pa]);
				inst(&mut out, OP_SHR, &[t_uint, pw, py, c2]);
				inst(&mut out, OP_BITCAST, &[t_uint, cu, a[3]]);
				inst(&mut out, OP_IADD, &[t_uint, ix, pw, cu]);
				inst(&mut out, OP_ACCESS_CHAIN, &[words_of(t).1, a[1], t.data, c0, ix]);
			}
			87..=94 | 96 | 97 | 101 | 102 | 105..=107 | 305..=320 if a.len() >= 3 && alias.contains_key(&a[2]) => {
				return Err(format!("texel buffers support only fetch, read, write, size queries and atomics (opcode {})", o));
			}
			_ => out.extend_from_slice(&words[i..i + n]),
		}
		i += n;
	}
	if !types_done {
		return Err("SPIR-V: no function".into());
	}

	// The stubs: what naga reflects and validates; patch_wgsl replaces
	// fetch and store with the real code.
	for t in &tv {
		let (p_words, p_word, e) = words_of(t);
		let _ = p_words;
		let (ck, v4, _, ff, fs) = kinds[&t.kind];
		let load_px = |out: &mut Vec<u32>, id: &mut dyn FnMut() -> u32, comp: u32| -> u32 {
			let (pp, pv, px) = (id(), id(), id());
			inst(out, OP_ACCESS_CHAIN, &[p_uvec4, pp, t.params, c0]);
			inst(out, OP_LOAD, &[t_uvec4, pv, pp]);
			inst(out, OP_COMPOSITE_EXTRACT, &[t_uint, px, pv, comp]);
			px
		};
		if t.need[0] {
			let (pi, l, wp, w, wu, vv, r) = (id(), id(), id(), id(), id(), id(), id());
			inst(&mut out, OP_FUNCTION, &[v4, t.fetch, 0, ff]);
			inst(&mut out, OP_FUNCTION_PARAMETER, &[t_int, pi]);
			inst(&mut out, OP_LABEL, &[l]);
			let px = load_px(&mut out, &mut id, 0);
			inst(&mut out, OP_ACCESS_CHAIN, &[p_word, wp, t.data, c0, px]);
			if t.atomic.is_some() {
				inst(&mut out, OP_ATOMIC_LOAD, &[e, w, wp, c1, c0]);
			} else {
				inst(&mut out, OP_LOAD, &[e, w, wp]);
			}
			inst(&mut out, OP_BITCAST, &[t_uint, wu, w]);
			inst(&mut out, OP_COMPOSITE_CONSTRUCT, &[t_uvec4, vv, wu, wu, wu, wu]);
			inst(&mut out, OP_BITCAST, &[v4, r, vv]);
			inst(&mut out, OP_RETURN_VALUE, &[r]);
			inst(&mut out, OP_FUNCTION_END, &[]);
			texel.helpers.push((format!("kw_tb_{}_{}_fetch", t.set, t.binding), fetch_wgsl(t)));
		}
		if t.need[1] {
			let (pi, pv4, l, wp, x0, xb) = (id(), id(), id(), id(), id(), id());
			inst(&mut out, OP_FUNCTION, &[t_void, t.store, 0, fs]);
			inst(&mut out, OP_FUNCTION_PARAMETER, &[t_int, pi]);
			inst(&mut out, OP_FUNCTION_PARAMETER, &[v4, pv4]);
			inst(&mut out, OP_LABEL, &[l]);
			let px = load_px(&mut out, &mut id, 0);
			inst(&mut out, OP_ACCESS_CHAIN, &[p_word, wp, t.data, c0, px]);
			inst(&mut out, OP_COMPOSITE_EXTRACT, &[ck, x0, pv4, 0]);
			inst(&mut out, OP_BITCAST, &[e, xb, x0]);
			if t.atomic.is_some() {
				inst(&mut out, OP_ATOMIC_STORE, &[wp, c1, c0, xb]);
			} else {
				inst(&mut out, OP_STORE, &[wp, xb]);
			}
			inst(&mut out, OP_RETURN, &[]);
			inst(&mut out, OP_FUNCTION_END, &[]);
			texel.helpers.push((format!("kw_tb_{}_{}_store", t.set, t.binding), store_wgsl(t)));
		}
		if t.need[2] {
			// exact as naga writes it: bitcast<i32>(p.z)
			let (l, r) = (id(), id());
			inst(&mut out, OP_FUNCTION, &[t_int, t.size, 0, fty_size]);
			inst(&mut out, OP_LABEL, &[l]);
			let pz = load_px(&mut out, &mut id, 2);
			inst(&mut out, OP_BITCAST, &[t_int, r, pz]);
			inst(&mut out, OP_RETURN_VALUE, &[r]);
			inst(&mut out, OP_FUNCTION_END, &[]);
		}
	}
	out[3] = bound;
	Ok((out, texel))
}

fn wgsl_ty(k: char) -> &'static str {
	match k {
		'i' => "i32",
		'u' => "u32",
		_ => "f32",
	}
}

// Loads and stores of word k of a binding (atomic when the module has
// atomics on it).
fn ld(t: &Var, k: &str) -> String {
	let w = format!("kw_tb_{}_{}_w.w[{}]", t.set, t.binding, k);
	match t.atomic {
		Some(true) => format!("bitcast<u32>(atomicLoad(&{}))", w),
		Some(false) => format!("atomicLoad(&{})", w),
		None => w,
	}
}
fn st(t: &Var, k: &str, x: &str) -> String {
	let w = format!("kw_tb_{}_{}_w.w[{}]", t.set, t.binding, k);
	match t.atomic {
		Some(true) => format!("atomicStore(&{}, bitcast<i32>({}));", w, x),
		Some(false) => format!("atomicStore(&{}, {});", w, x),
		None => format!("{} = {};", w, x),
	}
}

fn fetch_wgsl(t: &Var) -> String {
	let ty = wgsl_ty(t.kind);
	format!(
		"fn kw_tb_{s}_{b}_fetch(i: i32) -> vec4<{ty}> {{
    let p = kw_tb_{s}_{b}_p.p;
    let n = u32(i);
    if (n < p.z) {{
        let a = p.y + n * p.w;
        let k = a >> 2u;
        var r = vec4<u32>({l0} >> ((a & 3u) * 8u), 0u, 0u, 0u);
        if (p.w > 4u) {{ r.y = {l1}; }}
        if (p.w > 8u) {{ r.z = {l2}; }}
        if (p.w > 12u) {{ r.w = {l3}; }}
        return kw_texel_decode_{k}(p.x, r);
    }}
    return vec4<{ty}>();
}}",
		s = t.set,
		b = t.binding,
		ty = ty,
		k = t.kind,
		l0 = ld(t, "k"),
		l1 = ld(t, "k + 1u"),
		l2 = ld(t, "k + 2u"),
		l3 = ld(t, "k + 3u"),
	)
}

fn store_wgsl(t: &Var) -> String {
	let ty = wgsl_ty(t.kind);
	let w = format!("kw_tb_{}_{}_w.w[k]", t.set, t.binding);
	// a texel under 4 bytes: its bits of word k (m), the others kept
	let narrow = match t.atomic {
		Some(true) => format!("atomicAnd(&{w}, bitcast<i32>(~m)); atomicOr(&{w}, bitcast<i32>((e.x << sh) & m));", w = w),
		Some(false) => format!("atomicAnd(&{w}, ~m); atomicOr(&{w}, (e.x << sh) & m);", w = w),
		None => format!("{w} = ({w} & ~m) | ((e.x << sh) & m);", w = w),
	};
	format!(
		"fn kw_tb_{s}_{b}_store(i: i32, v: vec4<{ty}>) {{
    let p = kw_tb_{s}_{b}_p.p;
    let n = u32(i);
    if (n < p.z) {{
        let e = kw_texel_encode_{k}(p.x, v);
        let a = p.y + n * p.w;
        let k = a >> 2u;
        if (p.w < 4u) {{
            let sh = (a & 3u) * 8u;
            let m = select(0xffffu, 0xffu, p.w == 1u) << sh;
            {nw}
        }} else {{
            {s0}
            if (p.w > 4u) {{ {s1} }}
            if (p.w > 8u) {{ {s2} }}
            if (p.w > 12u) {{ {s3} }}
        }}
    }}
}}",
		s = t.set,
		b = t.binding,
		ty = ty,
		k = t.kind,
		nw = narrow,
		s0 = st(t, "k", "e.x"),
		s1 = st(t, "k + 1u", "e.y"),
		s2 = st(t, "k + 2u", "e.z"),
		s3 = st(t, "k + 3u", "e.w"),
	)
}

// The formats a texel buffer view may have (VkFormat numbers; the host's
// table, js/core/vk-formats.ts TEXEL, lists the same). `r` holds the
// element's bytes from bit 0 of r.x on, in whole words for texels of 4
// bytes or more. Missing components read 0, alpha 1.
const DECODE_F: &str = "fn kw_texel_decode_f(f: u32, r: vec4<u32>) -> vec4<f32> {
    switch f {
        case 9u: { return vec4<f32>(unpack4x8unorm(r.x).x, 0.0, 0.0, 1.0); }
        case 10u: { return vec4<f32>(unpack4x8snorm(r.x).x, 0.0, 0.0, 1.0); }
        case 16u: { return vec4<f32>(unpack4x8unorm(r.x).xy, 0.0, 1.0); }
        case 17u: { return vec4<f32>(unpack4x8snorm(r.x).xy, 0.0, 1.0); }
        case 37u, 51u: { return unpack4x8unorm(r.x); }
        case 38u, 52u: { return unpack4x8snorm(r.x); }
        case 44u: { return unpack4x8unorm(r.x).zyxw; }
        case 64u: { return vec4<f32>(vec4<u32>(r.x, r.x >> 10u, r.x >> 20u, r.x >> 30u) & vec4<u32>(1023u, 1023u, 1023u, 3u)) / vec4<f32>(1023.0, 1023.0, 1023.0, 3.0); }
        case 70u: { return vec4<f32>(unpack2x16unorm(r.x).x, 0.0, 0.0, 1.0); }
        case 71u: { return vec4<f32>(unpack2x16snorm(r.x).x, 0.0, 0.0, 1.0); }
        case 76u: { return vec4<f32>(unpack2x16float(r.x).x, 0.0, 0.0, 1.0); }
        case 77u: { return vec4<f32>(unpack2x16unorm(r.x), 0.0, 1.0); }
        case 78u: { return vec4<f32>(unpack2x16snorm(r.x), 0.0, 1.0); }
        case 83u: { return vec4<f32>(unpack2x16float(r.x), 0.0, 1.0); }
        case 91u: { return vec4<f32>(unpack2x16unorm(r.x), unpack2x16unorm(r.y)); }
        case 92u: { return vec4<f32>(unpack2x16snorm(r.x), unpack2x16snorm(r.y)); }
        case 97u: { return vec4<f32>(unpack2x16float(r.x), unpack2x16float(r.y)); }
        case 100u: { return vec4<f32>(bitcast<f32>(r.x), 0.0, 0.0, 1.0); }
        case 103u: { return vec4<f32>(bitcast<vec2<f32>>(r.xy), 0.0, 1.0); }
        case 106u: { return vec4<f32>(bitcast<vec3<f32>>(r.xyz), 1.0); }
        case 109u: { return bitcast<vec4<f32>>(r); }
        case 122u: {
            // 11-, 11- and 10-bit unsigned floats (5-bit exponents) as halves
            let h = vec3<u32>((r.x & 0x7ffu) << 4u, ((r.x >> 11u) & 0x7ffu) << 4u, ((r.x >> 22u) & 0x3ffu) << 5u);
            return vec4<f32>(unpack2x16float(h.x | (h.y << 16u)), unpack2x16float(h.z).x, 1.0);
        }
        default: { return vec4<f32>(); }
    }
}";

const DECODE_U: &str = "fn kw_texel_decode_u(f: u32, r: vec4<u32>) -> vec4<u32> {
    let b = (vec4<u32>(r.x) >> vec4<u32>(0u, 8u, 16u, 24u)) & vec4<u32>(255u);
    switch f {
        case 13u: { return vec4<u32>(b.x, 0u, 0u, 1u); }
        case 20u: { return vec4<u32>(b.xy, 0u, 1u); }
        case 41u, 55u: { return b; }
        case 68u: { return vec4<u32>(r.x & 1023u, (r.x >> 10u) & 1023u, (r.x >> 20u) & 1023u, r.x >> 30u); }
        case 74u: { return vec4<u32>(r.x & 0xffffu, 0u, 0u, 1u); }
        case 81u: { return vec4<u32>(r.x & 0xffffu, r.x >> 16u, 0u, 1u); }
        case 95u: { return vec4<u32>(r.x & 0xffffu, r.x >> 16u, r.y & 0xffffu, r.y >> 16u); }
        case 98u: { return vec4<u32>(r.x, 0u, 0u, 1u); }
        case 101u: { return vec4<u32>(r.xy, 0u, 1u); }
        case 104u: { return vec4<u32>(r.xyz, 1u); }
        case 107u: { return r; }
        default: { return vec4<u32>(); }
    }
}";

const DECODE_I: &str = "fn kw_texel_decode_i(f: u32, r: vec4<u32>) -> vec4<i32> {
    let s = bitcast<vec4<i32>>(r);
    switch f {
        case 14u: { return vec4<i32>(extractBits(s.x, 0u, 8u), 0, 0, 1); }
        case 21u: { return vec4<i32>(extractBits(s.x, 0u, 8u), extractBits(s.x, 8u, 8u), 0, 1); }
        case 42u, 56u: { return vec4<i32>(extractBits(s.x, 0u, 8u), extractBits(s.x, 8u, 8u), extractBits(s.x, 16u, 8u), extractBits(s.x, 24u, 8u)); }
        case 75u: { return vec4<i32>(extractBits(s.x, 0u, 16u), 0, 0, 1); }
        case 82u: { return vec4<i32>(extractBits(s.x, 0u, 16u), extractBits(s.x, 16u, 16u), 0, 1); }
        case 96u: { return vec4<i32>(extractBits(s.x, 0u, 16u), extractBits(s.x, 16u, 16u), extractBits(s.y, 0u, 16u), extractBits(s.y, 16u, 16u)); }
        case 99u: { return vec4<i32>(s.x, 0, 0, 1); }
        case 102u: { return vec4<i32>(s.xy, 0, 1); }
        case 105u: { return vec4<i32>(s.xyz, 1); }
        case 108u: { return s; }
        default: { return vec4<i32>(); }
    }
}";

// Storage formats: the element's words, or its bits from bit 0 of x for
// texels under 4 bytes.
const ENCODE_F: &str = "fn kw_texel_encode_f(f: u32, v: vec4<f32>) -> vec4<u32> {
    switch f {
        case 9u: { return vec4<u32>(pack4x8unorm(vec4<f32>(v.x, 0.0, 0.0, 0.0)), 0u, 0u, 0u); }
        case 10u: { return vec4<u32>(pack4x8snorm(vec4<f32>(v.x, 0.0, 0.0, 0.0)), 0u, 0u, 0u); }
        case 16u: { return vec4<u32>(pack4x8unorm(vec4<f32>(v.xy, 0.0, 0.0)), 0u, 0u, 0u); }
        case 17u: { return vec4<u32>(pack4x8snorm(vec4<f32>(v.xy, 0.0, 0.0)), 0u, 0u, 0u); }
        case 70u: { return vec4<u32>(pack2x16unorm(vec2<f32>(v.x, 0.0)), 0u, 0u, 0u); }
        case 71u: { return vec4<u32>(pack2x16snorm(vec2<f32>(v.x, 0.0)), 0u, 0u, 0u); }
        case 76u: { return vec4<u32>(pack2x16float(vec2<f32>(v.x, 0.0)), 0u, 0u, 0u); }
        case 37u, 51u: { return vec4<u32>(pack4x8unorm(v), 0u, 0u, 0u); }
        case 38u, 52u: { return vec4<u32>(pack4x8snorm(v), 0u, 0u, 0u); }
        case 44u: { return vec4<u32>(pack4x8unorm(v.zyxw), 0u, 0u, 0u); }
        case 64u: {
            let u = vec4<u32>(round(clamp(v, vec4<f32>(0.0), vec4<f32>(1.0)) * vec4<f32>(1023.0, 1023.0, 1023.0, 3.0)));
            return vec4<u32>(u.x | (u.y << 10u) | (u.z << 20u) | (u.w << 30u), 0u, 0u, 0u);
        }
        case 77u: { return vec4<u32>(pack2x16unorm(v.xy), 0u, 0u, 0u); }
        case 78u: { return vec4<u32>(pack2x16snorm(v.xy), 0u, 0u, 0u); }
        case 83u: { return vec4<u32>(pack2x16float(v.xy), 0u, 0u, 0u); }
        case 91u: { return vec4<u32>(pack2x16unorm(v.xy), pack2x16unorm(v.zw), 0u, 0u); }
        case 92u: { return vec4<u32>(pack2x16snorm(v.xy), pack2x16snorm(v.zw), 0u, 0u); }
        case 97u: { return vec4<u32>(pack2x16float(v.xy), pack2x16float(v.zw), 0u, 0u); }
        default: { return bitcast<vec4<u32>>(v); }
    }
}";

const ENCODE_U: &str = "fn kw_texel_encode_u(f: u32, v: vec4<u32>) -> vec4<u32> {
    switch f {
        case 13u, 14u: { return vec4<u32>(v.x & 255u, 0u, 0u, 0u); }
        case 20u, 21u: { return vec4<u32>((v.x & 255u) | ((v.y & 255u) << 8u), 0u, 0u, 0u); }
        case 74u, 75u: { return vec4<u32>(v.x & 0xffffu, 0u, 0u, 0u); }
        case 41u, 42u, 55u, 56u: {
            let b = v & vec4<u32>(255u);
            return vec4<u32>(b.x | (b.y << 8u) | (b.z << 16u) | (b.w << 24u), 0u, 0u, 0u);
        }
        case 68u: { return vec4<u32>((v.x & 1023u) | ((v.y & 1023u) << 10u) | ((v.z & 1023u) << 20u) | (v.w << 30u), 0u, 0u, 0u); }
        case 81u, 82u: { return vec4<u32>((v.x & 0xffffu) | (v.y << 16u), 0u, 0u, 0u); }
        case 95u, 96u: { return vec4<u32>((v.x & 0xffffu) | (v.y << 16u), (v.z & 0xffffu) | (v.w << 16u), 0u, 0u); }
        default: { return v; }
    }
}";

const ENCODE_I: &str = "fn kw_texel_encode_i(f: u32, v: vec4<i32>) -> vec4<u32> {
    return kw_texel_encode_u(f, bitcast<vec4<u32>>(v));
}";

/// After naga: the fetch and store stubs become the real code, and the
/// decoders and encoders they call are appended.
pub fn patch_wgsl(wgsl: &mut String, t: &Texel) -> Result<(), String> {
	let mut need: Vec<&'static str> = Vec::new();
	for (fname, text) in &t.helpers {
		let head = format!("fn {}(", fname);
		let Some(start) = wgsl.find(&head) else { continue }; // not reached: compacted away
		let open = start + wgsl[start..].find('{').ok_or("texel stub without a body")?;
		let mut depth = 0usize;
		let mut end = None;
		for (j, ch) in wgsl[open..].char_indices() {
			match ch {
				'{' => depth += 1,
				'}' => {
					depth -= 1;
					if depth == 0 {
						end = Some(open + j + 1);
						break;
					}
				}
				_ => {}
			}
		}
		let end = end.ok_or("texel stub body unterminated")?;
		wgsl.replace_range(start..end, text);
		for (key, f) in [
			("kw_texel_decode_f(", DECODE_F),
			("kw_texel_decode_u(", DECODE_U),
			("kw_texel_decode_i(", DECODE_I),
			("kw_texel_encode_f(", ENCODE_F),
			("kw_texel_encode_i(", ENCODE_I),
			("kw_texel_encode_u(", ENCODE_U),
		] {
			if text.contains(key) && !need.contains(&f) {
				need.push(f);
				if f == ENCODE_I && !need.contains(&ENCODE_U) {
					need.push(ENCODE_U);
				}
			}
		}
	}
	for f in need {
		wgsl.push('\n');
		wgsl.push_str(f);
		wgsl.push('\n');
	}
	Ok(())
}
