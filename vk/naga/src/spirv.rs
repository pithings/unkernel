// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//
// A SPIR-V pass run before naga: every binding b becomes 2*b, and each
// UniformConstant variable of OpTypeSampledImage (GLSL sampler2D, a
// COMBINED_IMAGE_SAMPLER) is split into the image variable at 2*b and a new
// sampler variable at 2*b+1, with each OpLoad of it rewritten to two loads
// and an OpSampledImage, which naga's spv-in handles; function parameters
// of that type become an image and a sampler parameter. Not handled: arrays
// of combined samplers (naga then rejects).
// Output interface blocks also get per-member Locations here.

use std::collections::HashMap;

const OP_NAME: u32 = 5;
const OP_ENTRY_POINT: u32 = 15;
const OP_TYPE_SAMPLER: u32 = 26;
const OP_TYPE_SAMPLED_IMAGE: u32 = 27;
const OP_TYPE_POINTER: u32 = 32;
const OP_VARIABLE: u32 = 59;
const OP_LOAD: u32 = 61;
const OP_TYPE_FUNCTION: u32 = 33;
const OP_FUNCTION_PARAMETER: u32 = 55;
const OP_FUNCTION_CALL: u32 = 57;
const OP_DECORATE: u32 = 71;
const OP_MEMBER_DECORATE: u32 = 72;
const OP_TYPE_STRUCT: u32 = 30;
const DEC_LOCATION: u32 = 30;
const DEC_BUILTIN: u32 = 11;
const SC_OUTPUT: u32 = 3;
const OP_SAMPLED_IMAGE: u32 = 86;
const DEC_BINDING: u32 = 33;
const DEC_DESCRIPTOR_SET: u32 = 34;
const SC_UNIFORM_CONSTANT: u32 = 0;

struct Combined {
	image_type: u32,
	sampler_var: u32,
}

fn inst(op: u32, operands: &[u32]) -> impl Iterator<Item = u32> + '_ {
	std::iter::once(((operands.len() as u32 + 1) << 16) | op).chain(operands.iter().copied())
}

fn string_words(s: &str) -> Vec<u32> {
	let mut b = s.as_bytes().to_vec();
	b.push(0);
	while b.len() % 4 != 0 {
		b.push(0);
	}
	b.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

fn read_string(w: &[u32]) -> String {
	let mut b = Vec::new();
	'o: for x in w {
		for c in x.to_le_bytes() {
			if c == 0 {
				break 'o;
			}
			b.push(c);
		}
	}
	String::from_utf8_lossy(&b).into_owned()
}

// Header and instruction lengths, so the passes below can index freely.
pub fn check(words: &[u32]) -> Result<(), String> {
	if words[0] != 0x0723_0203 {
		return Err("SPIR-V: bad magic (big-endian SPIR-V is not supported)".into());
	}
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		if n == 0 || i + n > words.len() {
			return Err(format!("SPIR-V: bad instruction length at word {}", i));
		}
		i += n;
	}
	Ok(())
}

// Storage images without a format (shaderStorageImage*WithoutFormat):
// WGSL needs one. opts.storageFormats["set.binding"] gives it (a SPIR-V
// ImageFormat number), else rgba8unorm for float, rgba32sint/rgba32uint
// for integer images. Each such variable gets its own image type.
pub fn storage_image_formats(words: Vec<u32>, formats: &[(u32, u32, u32)]) -> Vec<u32> {
	const OP_TYPE_INT: u32 = 21;
	const OP_TYPE_IMAGE: u32 = 25;
	let mut unknown: HashMap<u32, Vec<u32>> = HashMap::new(); // image type -> operands
	let mut sint: Vec<u32> = Vec::new();
	let mut uint: Vec<u32> = Vec::new();
	let mut pointers: HashMap<u32, u32> = HashMap::new();
	let mut binding: HashMap<u32, u32> = HashMap::new();
	let mut set: HashMap<u32, u32> = HashMap::new();
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		match words[i] & 0xffff {
			OP_TYPE_INT => {
				if a[2] != 0 { sint.push(a[0]) } else { uint.push(a[0]) }
			}
			OP_TYPE_IMAGE if a.len() >= 8 && a[6] == 2 && a[7] == 0 => {
				unknown.insert(a[0], a.to_vec());
			}
			OP_TYPE_POINTER => {
				pointers.insert(a[0], a[2]);
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_BINDING => {
				binding.insert(a[0], a[2]);
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_DESCRIPTOR_SET => {
				set.insert(a[0], a[2]);
			}
			_ => {}
		}
		i += n;
	}
	if unknown.is_empty() {
		return words;
	}
	let default_of = |t: &Vec<u32>| if sint.contains(&t[1]) { 21 } else if uint.contains(&t[1]) { 30 } else { 4 };
	let mut bound = words[3];
	let mut out: Vec<u32> = Vec::with_capacity(words.len() + 32);
	out.extend_from_slice(&words[..5]);
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		match words[i] & 0xffff {
			OP_TYPE_IMAGE if unknown.contains_key(&a[0]) => {
				let mut ops = a.to_vec();
				ops[7] = default_of(&unknown[&a[0]]);
				out.extend(inst(OP_TYPE_IMAGE, &ops));
			}
			OP_VARIABLE if a[2] == SC_UNIFORM_CONSTANT && pointers.get(&a[0]).map_or(false, |p| unknown.contains_key(p)) => {
				let img = pointers[&a[0]];
				let (s, b) = (set.get(&a[1]).copied().unwrap_or(0), binding.get(&a[1]).copied().unwrap_or(0));
				match formats.iter().find(|f| f.0 == s && f.1 == b) {
					Some(&(_, _, f)) if f != default_of(&unknown[&img]) => {
						let mut ops = unknown[&img].clone();
						ops[0] = bound;
						ops[7] = f;
						out.extend(inst(OP_TYPE_IMAGE, &ops));
						out.extend(inst(OP_TYPE_POINTER, &[bound + 1, SC_UNIFORM_CONSTANT, bound]));
						out.extend(inst(OP_VARIABLE, &[bound + 1, a[1], a[2]]));
						bound += 2;
					}
					_ => out.extend_from_slice(&words[i..i + n]),
				}
			}
			_ => out.extend_from_slice(&words[i..i + n]),
		}
		i += n;
	}
	out[3] = bound;
	out
}

pub fn split_combined_samplers(words: Vec<u32>, fixed: &HashMap<u32, u32>) -> Result<Vec<u32>, String> {
	if words[0] != 0x0723_0203 {
		return Err("SPIR-V: bad magic (big-endian SPIR-V is not supported)".into());
	}
	let version = words[1];
	let mut bound = words[3];
	// Split into instructions.
	let mut insts: Vec<(usize, usize)> = Vec::new();
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		if n == 0 || i + n > words.len() {
			return Err("SPIR-V: truncated instruction".into());
		}
		insts.push((i, n));
		i += n;
	}
	let op = |k: usize| words[insts[k].0] & 0xffff;
	let args = |k: usize| &words[insts[k].0 + 1..insts[k].0 + insts[k].1];

	let mut sampled: HashMap<u32, u32> = HashMap::new(); // sampled image type -> image type
	let mut pointers: HashMap<u32, (u32, u32)> = HashMap::new(); // ptr -> (class, pointee)
	let mut comb_ptrs: HashMap<u32, u32> = HashMap::new(); // ptr to sampled image -> image type
	let mut sampler_type: Option<u32> = None;
	// Combined variables and function parameters -> (image type, sampler id).
	let mut combined: HashMap<u32, Combined> = HashMap::new();
	let mut first_type: Option<usize> = None;
	for k in 0..insts.len() {
		let a = args(k);
		let o = op(k);
		if (19..=39).contains(&o) && first_type.is_none() {
			first_type = Some(k);
		}
		match o {
			OP_TYPE_SAMPLED_IMAGE => {
				sampled.insert(a[0], a[1]);
			}
			OP_TYPE_SAMPLER if sampler_type.is_none() => sampler_type = Some(a[0]),
			OP_TYPE_POINTER => {
				pointers.insert(a[0], (a[1], a[2]));
				if a[1] == SC_UNIFORM_CONSTANT {
					if let Some(&img) = sampled.get(&a[2]) {
						comb_ptrs.insert(a[0], img);
					}
				}
			}
			OP_VARIABLE | OP_FUNCTION_PARAMETER => {
				let (ty, id) = (a[0], a[1]);
				if let Some(&img) = comb_ptrs.get(&ty) {
					combined.insert(id, Combined { image_type: img, sampler_var: 0 });
				}
			}
			_ => {}
		}
	}

	// New ids: the sampler type (unless declared), its pointer, one image
	// pointer per image type, one sampler id per combined variable or
	// parameter. The sampler types go before the first type, each image
	// pointer right after the first OpTypeSampledImage of its image, so all
	// precede the function types and variables that use them.
	let mut samp_ptr = 0;
	let mut img_ptrs: HashMap<u32, u32> = HashMap::new();
	let mut samp_ty = 0;
	let mut new_types: Vec<u32> = Vec::new();
	if !combined.is_empty() {
		let mut alloc = || {
			let id = bound;
			bound += 1;
			id
		};
		// Always a new OpTypeSampler before every other type (an existing
		// one may come after the variables); naga merges equal types.
		samp_ty = alloc();
		new_types.extend(inst(OP_TYPE_SAMPLER, &[samp_ty]));
		sampler_type = None;
		samp_ptr = alloc();
		let mut ids: Vec<u32> = combined.keys().copied().collect();
		ids.sort();
		for v in ids {
			let c = combined.get_mut(&v).unwrap();
			c.sampler_var = alloc();
		}
		let mut imgs: Vec<u32> = comb_ptrs.values().copied().collect();
		imgs.sort();
		imgs.dedup();
		for it in imgs {
			img_ptrs.insert(it, alloc());
		}
	}
	// Output blocks (GLSL `out V { ... } v;`) carry one Location on the
	// variable; naga's spv-in drops struct outputs whose members have none,
	// so give member i Location + i.
	let mut struct_len: HashMap<u32, u32> = HashMap::new();
	let mut member_located: Vec<(u32, u32)> = Vec::new();
	let mut out_blocks: HashMap<u32, u32> = HashMap::new(); // var -> struct
	for k in 0..insts.len() {
		let a = args(k);
		match op(k) {
			OP_TYPE_STRUCT => {
				struct_len.insert(a[0], a.len() as u32 - 1);
			}
			OP_MEMBER_DECORATE if a.len() >= 3 && (a[2] == DEC_LOCATION || a[2] == DEC_BUILTIN) => member_located.push((a[0], a[1])),
			OP_VARIABLE if a[2] == SC_OUTPUT => {
				if let Some(&(_, pointee)) = pointers.get(&a[0]) {
					if struct_len.contains_key(&pointee) {
						out_blocks.insert(a[1], pointee);
					}
				}
			}
			_ => {}
		}
	}
	let mut set_of: HashMap<u32, u32> = HashMap::new();
	for k in 0..insts.len() {
		let a = args(k);
		if op(k) == OP_DECORATE && a.len() >= 3 && a[1] == DEC_DESCRIPTOR_SET {
			set_of.insert(a[0], a[2]);
		}
	}
	// A separate image and sampler at the same set and binding (HLSL via
	// DXC: Texture2D t : register(t0) + SamplerState s : register(s0)) are
	// one COMBINED_IMAGE_SAMPLER descriptor: the sampler goes to 2*b+1.
	let mut binding_of: HashMap<u32, u32> = HashMap::new();
	let mut var_kind: HashMap<u32, u32> = HashMap::new(); // var -> pointee opcode (image/sampler)
	let mut type_op: HashMap<u32, u32> = HashMap::new();
	for k in 0..insts.len() {
		let a = args(k);
		match op(k) {
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_BINDING => {
				binding_of.insert(a[0], a[2]);
			}
			25 | OP_TYPE_SAMPLER => {
				type_op.insert(a[0], op(k));
			}
			OP_VARIABLE if a[2] == SC_UNIFORM_CONSTANT => {
				if let Some(&t) = pointers.get(&a[0]).and_then(|(_, p)| type_op.get(p)) {
					var_kind.insert(a[1], t);
				}
			}
			_ => {}
		}
	}
	let slot = |v: u32| binding_of.get(&v).map(|&b| (set_of.get(&v).copied().unwrap_or(0), b));
	let paired_samplers: Vec<u32> = var_kind
		.iter()
		.filter(|(v, &k)| k == OP_TYPE_SAMPLER && !fixed.contains_key(v))
		.filter(|(v, _)| var_kind.iter().any(|(w, &k2)| k2 == 25 && slot(*w) == slot(**v)))
		.map(|(v, _)| *v)
		.collect();

	let mut out: Vec<u32> = Vec::with_capacity(words.len() + 64);
	out.extend_from_slice(&words[..5]);
	let mut emitted_ptrs: Vec<u32> = Vec::new();
	for k in 0..insts.len() {
		let (start, n) = insts[k];
		let a = args(k);
		if Some(k) == first_type && !combined.is_empty() {
			out.extend_from_slice(&new_types);
			if sampler_type.is_none() {
				out.extend(inst(OP_TYPE_POINTER, &[samp_ptr, SC_UNIFORM_CONSTANT, samp_ty]));
			}
		}
		match op(k) {
			OP_NAME if combined.contains_key(&a[0]) => {
				out.extend_from_slice(&words[start..start + n]);
				let mut ops = vec![combined[&a[0]].sampler_var];
				ops.extend(string_words(&(read_string(&a[1..]) + "_sampler")));
				out.extend(inst(OP_NAME, &ops));
			}
			OP_ENTRY_POINT if version >= 0x0001_0400 => {
				let mut ops = a.to_vec();
				for x in a.iter() {
					if let Some(c) = combined.get(x) {
						ops.push(c.sampler_var);
					}
				}
				out.extend(inst(OP_ENTRY_POINT, &ops));
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_LOCATION && out_blocks.contains_key(&a[0]) => {
				out.extend_from_slice(&words[start..start + n]);
				let st = out_blocks[&a[0]];
				for i in 0..struct_len[&st] {
					if !member_located.contains(&(st, i)) {
						out.extend(inst(OP_MEMBER_DECORATE, &[st, i, DEC_LOCATION, a[2] + i]));
					}
				}
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_BINDING => {
				// Flattened descriptor array elements come with their final
				// binding; everything else doubles.
				let b = fixed.get(&a[0]).copied().unwrap_or(a[2] * 2 + paired_samplers.contains(&a[0]) as u32);
				out.extend(inst(OP_DECORATE, &[a[0], DEC_BINDING, b]));
				if let Some(c) = combined.get(&a[0]) {
					out.extend(inst(OP_DECORATE, &[c.sampler_var, DEC_BINDING, b + 1]));
					// A missing DescriptorSet means set 0 on both.
					if let Some(&s) = set_of.get(&a[0]) {
						out.extend(inst(OP_DECORATE, &[c.sampler_var, DEC_DESCRIPTOR_SET, s]));
					}
				}
			}
			OP_TYPE_SAMPLER if !combined.is_empty() && Some(a[0]) == sampler_type => {
				out.extend_from_slice(&words[start..start + n]);
				out.extend(inst(OP_TYPE_POINTER, &[samp_ptr, SC_UNIFORM_CONSTANT, samp_ty]));
			}
			OP_TYPE_SAMPLED_IMAGE if !combined.is_empty() => {
				out.extend_from_slice(&words[start..start + n]);
				if let Some(&ip) = img_ptrs.get(&a[1]) {
					if !emitted_ptrs.contains(&ip) {
						emitted_ptrs.push(ip);
						out.extend(inst(OP_TYPE_POINTER, &[ip, SC_UNIFORM_CONSTANT, a[1]]));
					}
				}
			}
			OP_TYPE_FUNCTION if a[2..].iter().any(|t| comb_ptrs.contains_key(t)) => {
				let mut ops = a[..2].to_vec();
				for t in &a[2..] {
					match comb_ptrs.get(t) {
						Some(img) => ops.extend([img_ptrs[img], samp_ptr]),
						None => ops.push(*t),
					}
				}
				out.extend(inst(OP_TYPE_FUNCTION, &ops));
			}
			OP_VARIABLE | OP_FUNCTION_PARAMETER if combined.contains_key(&a[1]) => {
				let c = &combined[&a[1]];
				let mut tail = a[2..].to_vec(); // storage class (+ initializer)
				tail.truncate(1);
				let mut o1 = vec![img_ptrs[&c.image_type], a[1]];
				o1.extend(&tail);
				out.extend(inst(op(k), &o1));
				let mut o2 = vec![samp_ptr, c.sampler_var];
				o2.extend(&tail);
				out.extend(inst(op(k), &o2));
			}
			OP_FUNCTION_CALL if a[3..].iter().any(|x| combined.contains_key(x)) => {
				let mut ops = a[..3].to_vec();
				for x in &a[3..] {
					ops.push(*x);
					if let Some(c) = combined.get(x) {
						ops.push(c.sampler_var);
					}
				}
				out.extend(inst(OP_FUNCTION_CALL, &ops));
			}
			OP_LOAD if a.len() >= 3 && combined.contains_key(&a[2]) => {
				let c = &combined[&a[2]];
				let (ri, rs) = (bound, bound + 1);
				bound += 2;
				out.extend(inst(OP_LOAD, &[c.image_type, ri, a[2]]));
				out.extend(inst(OP_LOAD, &[samp_ty, rs, c.sampler_var]));
				out.extend(inst(OP_SAMPLED_IMAGE, &[a[0], a[1], ri, rs]));
			}
			_ => out.extend_from_slice(&words[start..start + n]),
		}
	}
	out[3] = bound;
	Ok(out)
}

// std140 arrays of scalars, vec2s and vec3s (ArrayStride 16 where WGSL's
// natural stride is 4, 8 or 16 with a different element) read wrongly
// through naga's WGSL, which has no stride attribute: wrap each element in
// a struct padded with copies of itself to the stride, and step every
// access chain through the new member 0.
pub fn wrap_strided_arrays(words: Vec<u32>) -> Result<Vec<u32>, String> {
	const OP_TYPE_INT: u32 = 21;
	const OP_TYPE_FLOAT: u32 = 22;
	const OP_TYPE_VECTOR: u32 = 23;
	const OP_TYPE_ARRAY: u32 = 28;
	const OP_TYPE_RUNTIME_ARRAY: u32 = 29;
	const OP_CONSTANT: u32 = 43;
	const OP_ACCESS_CHAIN: u32 = 65;
	const OP_IN_BOUNDS_ACCESS_CHAIN: u32 = 66;
	const DEC_ARRAY_STRIDE: u32 = 6;
	const DEC_OFFSET: u32 = 35;

	let mut bound = words[3];
	let mut insts: Vec<(usize, usize)> = Vec::new();
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		insts.push((i, n));
		i += n;
	}
	let op = |k: usize| words[insts[k].0] & 0xffff;
	let args = |k: usize| &words[insts[k].0 + 1..insts[k].0 + insts[k].1];

	let mut scalar32: Vec<u32> = Vec::new();
	let mut vec_of: HashMap<u32, (u32, u32)> = HashMap::new(); // vector -> (component, count)
	let mut stride: HashMap<u32, u32> = HashMap::new();
	let mut arrays: HashMap<u32, u32> = HashMap::new(); // array -> element
	let mut structs: HashMap<u32, Vec<u32>> = HashMap::new();
	let mut pointee: HashMap<u32, u32> = HashMap::new(); // pointer type -> pointee
	let mut consts: HashMap<u32, u32> = HashMap::new();
	let mut uint_ty: Option<u32> = None;
	for k in 0..insts.len() {
		let a = args(k);
		match op(k) {
			OP_TYPE_INT | OP_TYPE_FLOAT if a[1] == 32 => {
				scalar32.push(a[0]);
				if op(k) == OP_TYPE_INT && a[2] == 0 && uint_ty.is_none() {
					uint_ty = Some(a[0]);
				}
			}
			OP_TYPE_VECTOR => {
				vec_of.insert(a[0], (a[1], a[2]));
			}
			OP_TYPE_ARRAY | OP_TYPE_RUNTIME_ARRAY => {
				arrays.insert(a[0], a[1]);
			}
			OP_TYPE_STRUCT => {
				structs.insert(a[0], a[1..].to_vec());
			}
			OP_TYPE_POINTER => {
				pointee.insert(a[0], a[2]);
			}
			OP_CONSTANT if a.len() >= 3 => {
				consts.insert(a[1], a[2]);
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_ARRAY_STRIDE => {
				stride.insert(a[0], a[2]);
			}
			_ => {}
		}
	}
	// array -> (wrapper struct, element, natural stride, member count)
	let mut wrap: HashMap<u32, (u32, u32, u32, u32)> = HashMap::new();
	let mut ids: Vec<u32> = arrays.keys().copied().collect();
	ids.sort();
	for arr in ids {
		let el = arrays[&arr];
		let Some(&s) = stride.get(&arr) else { continue };
		let natural = if scalar32.contains(&el) {
			4
		} else if let Some(&(c, n)) = vec_of.get(&el) {
			if !scalar32.contains(&c) {
				continue;
			}
			if n == 3 { 16 } else { 4 * n }
		} else {
			continue;
		};
		if s == natural || s % natural != 0 {
			continue;
		}
		wrap.insert(arr, (bound, el, natural, s / natural));
		bound += 1;
	}
	if wrap.is_empty() {
		return Ok(words);
	}
	let (zero_ty, zero) = (uint_ty.unwrap_or(bound), bound + 1);
	bound += 2;

	let mut out: Vec<u32> = Vec::with_capacity(words.len() + 64);
	out.extend_from_slice(&words[..5]);
	let mut ptr_of: HashMap<u32, u32> = HashMap::new(); // id -> pointer type
	let mut val_ty: HashMap<u32, u32> = HashMap::new(); // loaded value -> type
	let mut zero_done = false;
	for k in 0..insts.len() {
		let (start, n) = insts[k];
		let a = args(k);
		let o = op(k);
		if o == OP_VARIABLE || o == OP_FUNCTION_PARAMETER {
			ptr_of.insert(a[1], a[0]);
		}
		if o == OP_LOAD {
			if let Some(p) = ptr_of.get(&a[2]).and_then(|p| pointee.get(p)) {
				val_ty.insert(a[1], *p);
			}
		}
		match o {
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_ARRAY_STRIDE && wrap.contains_key(&a[0]) => {
				out.extend_from_slice(&words[start..start + n]);
				let (w, _, nat, cnt) = wrap[&a[0]];
				for m in 0..cnt {
					out.extend(inst(OP_MEMBER_DECORATE, &[w, m, DEC_OFFSET, m * nat]));
				}
			}
			OP_TYPE_ARRAY | OP_TYPE_RUNTIME_ARRAY if wrap.contains_key(&a[0]) => {
				if !zero_done {
					zero_done = true;
					if uint_ty.is_none() {
						out.extend(inst(OP_TYPE_INT, &[zero_ty, 32, 0]));
					}
					out.extend(inst(OP_CONSTANT, &[zero_ty, zero, 0]));
				}
				let (w, el, _, cnt) = wrap[&a[0]];
				let mut m = vec![w];
				m.extend(std::iter::repeat(el).take(cnt as usize));
				out.extend(inst(OP_TYPE_STRUCT, &m));
				let mut ops = a.to_vec();
				ops[1] = w;
				out.extend(inst(o, &ops));
			}
			// Extracting from a loaded value through a wrapped array.
			81 if a.len() >= 4 => {
				let mut cur = val_ty.get(&a[2]).copied();
				let mut ops = a[..3].to_vec();
				for &lit in &a[3..] {
					ops.push(lit);
					let Some(c) = cur else { continue };
					if let Some(&(_, el, _, _)) = wrap.get(&c) {
						ops.push(0);
						cur = Some(el);
					} else if let Some(&el) = arrays.get(&c) {
						cur = Some(el);
					} else if let Some(ms) = structs.get(&c) {
						cur = ms.get(lit as usize).copied();
					} else {
						cur = None;
					}
				}
				val_ty.insert(a[1], a[0]);
				out.extend(inst(o, &ops));
			}
			OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN => {
				ptr_of.insert(a[1], a[0]);
				let mut cur = ptr_of.get(&a[2]).and_then(|p| pointee.get(p)).copied();
				let mut ops = a[..3].to_vec();
				for &idx in &a[3..] {
					ops.push(idx);
					let Some(c) = cur else { continue };
					if let Some(&(_, el, _, _)) = wrap.get(&c) {
						ops.push(zero);
						cur = Some(el);
					} else if let Some(&el) = arrays.get(&c) {
						cur = Some(el);
					} else if let Some(ms) = structs.get(&c) {
						cur = consts.get(&idx).and_then(|&v| ms.get(v as usize)).copied();
					} else {
						cur = None;
					}
				}
				out.extend(inst(o, &ops));
			}
			_ => out.extend_from_slice(&words[start..start + n]),
		}
	}
	out[3] = bound;
	Ok(out)
}

// Specialization: every OpSpecConstant* becomes the plain constant with the
// value the host gave for its SpecId (else its default), before naga sees
// it, so spec constants also work where naga's overrides do not (array
// sizes, the workgroup size). OpSpecConstantOp is folded next
// (fold_spec_ops).
pub fn bake_spec_constants(words: Vec<u32>, spec: &[(String, f64)]) -> Vec<u32> {
	const OP_TYPE_BOOL: u32 = 20;
	const OP_TYPE_INT: u32 = 21;
	const OP_TYPE_FLOAT: u32 = 22;
	const OP_CONSTANT_TRUE: u32 = 41;
	const OP_CONSTANT_FALSE: u32 = 42;
	const OP_CONSTANT: u32 = 43;
	const OP_CONSTANT_COMPOSITE: u32 = 44;
	const OP_SPEC_CONSTANT_TRUE: u32 = 48;
	const OP_SPEC_CONSTANT_FALSE: u32 = 49;
	const OP_SPEC_CONSTANT: u32 = 50;
	const OP_SPEC_CONSTANT_COMPOSITE: u32 = 51;
	const DEC_SPEC_ID: u32 = 1;

	let mut spec_id: HashMap<u32, u32> = HashMap::new();
	let mut num: HashMap<u32, (bool, u32, bool)> = HashMap::new(); // type -> (float, width, signed)
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		match words[i] & 0xffff {
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_SPEC_ID => {
				spec_id.insert(a[0], a[2]);
			}
			OP_TYPE_INT => {
				num.insert(a[0], (false, a[1], a[2] != 0));
			}
			OP_TYPE_FLOAT => {
				num.insert(a[0], (true, a[1], true));
			}
			_ => {}
		}
		i += n;
	}
	let value = |id: u32| -> Option<f64> {
		let s = spec_id.get(&id)?.to_string();
		spec.iter().find(|(k, _)| *k == s).map(|(_, v)| *v)
	};
	let _ = OP_TYPE_BOOL;
	// The workgroup size: a (spec) constant composite decorated BuiltIn
	// WorkgroupSize, or LocalSizeId, overrides OpExecutionMode LocalSize.
	let mut scalar: HashMap<u32, u32> = HashMap::new();
	let mut composite: HashMap<u32, Vec<u32>> = HashMap::new();
	let mut wg_builtin: Option<u32> = None;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		match words[i] & 0xffff {
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_BUILTIN && a[2] == 25 => wg_builtin = Some(a[0]),
			OP_CONSTANT | OP_SPEC_CONSTANT if a.len() >= 3 => {
				let v = value(a[1]).map(|v| v as i64 as u32).unwrap_or(a[2]);
				scalar.insert(a[1], v);
			}
			OP_CONSTANT_COMPOSITE | OP_SPEC_CONSTANT_COMPOSITE => {
				composite.insert(a[1], a[2..].to_vec());
			}
			_ => {}
		}
		i += n;
	}
	let wg: Option<Vec<u32>> = wg_builtin
		.and_then(|id| composite.get(&id))
		.and_then(|c| c.iter().map(|x| scalar.get(x).copied()).collect());
	let mut out: Vec<u32> = Vec::with_capacity(words.len());
	out.extend_from_slice(&words[..5]);
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		match words[i] & 0xffff {
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_SPEC_ID => {}
			// OpExecutionMode %ep LocalSize x y z
			16 if a.len() == 5 && a[1] == 17 && wg.is_some() => {
				let w = wg.as_ref().unwrap();
				out.extend(inst(16, &[a[0], 17, w[0], w[1], w[2]]));
			}
			// OpExecutionModeId %ep LocalSizeId %x %y %z
			331 if a.len() == 5 && a[1] == 38 => {
				let w: Vec<u32> = a[2..].iter().map(|x| scalar.get(x).copied().unwrap_or(1)).collect();
				let w = wg.as_ref().unwrap_or(&w);
				out.extend(inst(16, &[a[0], 17, w[0], w[1], w[2]]));
			}
			OP_SPEC_CONSTANT_TRUE | OP_SPEC_CONSTANT_FALSE => {
				let def = words[i] & 0xffff == OP_SPEC_CONSTANT_TRUE;
				let v = value(a[1]).map(|v| v != 0.0).unwrap_or(def);
				out.extend(inst(if v { OP_CONSTANT_TRUE } else { OP_CONSTANT_FALSE }, a));
			}
			OP_SPEC_CONSTANT => {
				let mut ops = a.to_vec();
				if let (Some(v), Some(&(float, width, signed))) = (value(a[1]), num.get(&a[0])) {
					let bits: u64 = match (float, width) {
						(true, 64) => v.to_bits(),
						(true, 16) => 0, // unsupported: keep the default below
						(true, _) => (v as f32).to_bits() as u64,
						(false, _) if signed => v as i64 as u64,
						(false, _) => v as u64,
					};
					if !(float && width == 16) {
						ops.truncate(2);
						ops.push(bits as u32);
						if width == 64 {
							ops.push((bits >> 32) as u32);
						}
					}
				}
				out.extend(inst(OP_CONSTANT, &ops));
			}
			OP_SPEC_CONSTANT_COMPOSITE => out.extend(inst(OP_CONSTANT_COMPOSITE, a)),
			_ => out.extend_from_slice(&words[i..i + n]),
		}
		i += n;
	}
	out
}

// OpSpecConstantOp on (now baked) constants, folded to plain constants
// (naga's spv-in rejects OpSpecConstantOp, "unsupported instruction
// SpecConstantOp at Type"): every operation the Shader capability allows
// there, plus Bitcast of equal widths and QuantizeToF16, on integers of 8
// to 64 bits and booleans, scalars and vectors (component-wise), as glslang
// emits for `const uint N2 = N * 2;` or `gl_WorkGroupSize.xy * 2u`; on
// floats only what needs no float arithmetic (Select, FConvert,
// QuantizeToF16, the composite operations), as vkQuake's world.frag and
// ssao_evaluate (`quality == 1u ? 2.0 : 1.0`, also in half). An operation
// on something that is not a constant is left to naga, which rejects it.
pub fn fold_spec_ops(words: Vec<u32>) -> Vec<u32> {
	#[derive(Clone, Copy, PartialEq)]
	enum Ty {
		Int(u32, bool),
		Float(u32),
		Bool,
		Vector(u32, u32),
	}
	const OP_TYPE_BOOL: u32 = 20;
	const OP_TYPE_INT: u32 = 21;
	const OP_TYPE_FLOAT: u32 = 22;
	const OP_TYPE_VECTOR: u32 = 23;
	const OP_CONSTANT_TRUE: u32 = 41;
	const OP_CONSTANT_FALSE: u32 = 42;
	const OP_CONSTANT: u32 = 43;
	const OP_CONSTANT_COMPOSITE: u32 = 44;
	const OP_CONSTANT_NULL: u32 = 46;
	const OP_SPEC_CONSTANT_OP: u32 = 52;
	const OP_VECTOR_SHUFFLE: u32 = 79;
	const OP_COMPOSITE_EXTRACT: u32 = 81;
	const OP_COMPOSITE_INSERT: u32 = 82;
	const OP_SELECT: u32 = 169;

	fn mask(w: u32) -> u64 {
		if w >= 64 {
			u64::MAX
		} else {
			(1u64 << w) - 1
		}
	}
	fn sext(x: u64, w: u32) -> i64 {
		let s = 64 - w.clamp(1, 64);
		((x << s) as i64) >> s
	}
	fn width(t: Ty) -> u32 {
		match t {
			Ty::Int(w, _) | Ty::Float(w) => w,
			_ => 1,
		}
	}
	fn to_f64(bits: u64, w: u32) -> Option<f64> {
		match w {
			16 => Some(f16_to_f32(bits as u16) as f64),
			32 => Some(f32::from_bits(bits as u32) as f64),
			64 => Some(f64::from_bits(bits)),
			_ => None,
		}
	}
	// One scalar operation: the result type and the operands' (type, bits),
	// bits masked to the type's width. None when it does not apply.
	fn scalar_op(sop: u32, rty: Ty, x: &[(Ty, u64)]) -> Option<u64> {
		let rw = width(rty);
		let arg = |k: usize| x.get(k).copied();
		let (t0, a) = arg(0)?;
		let w0 = width(t0);
		let ints = x.iter().all(|(t, _)| matches!(t, Ty::Int(..)));
		let bools = x.iter().all(|(t, _)| *t == Ty::Bool);
		let b = || arg(1).map(|(_, v)| v);
		let flag = |f: bool| Some(f as u64);
		let r = match sop {
			// Select: either operand as it is (any scalar type).
			OP_SELECT => {
				let (c, (_, p), (_, q)) = (a, arg(1)?, arg(2)?);
				return Some(if c != 0 { p } else { q });
			}
			124 if w0 == rw && matches!(rty, Ty::Int(..) | Ty::Float(_)) => a, // Bitcast
			115 => {
				// FConvert (no double rounding: not from 64 to 16 bits)
				let v = to_f64(a, w0)?;
				match (w0, rw) {
					(64, 16) => return None,
					(_, 16) => f32_to_f16(v as f32) as u64,
					(_, 32) => (v as f32).to_bits() as u64,
					(_, 64) => v.to_bits(),
					_ => return None,
				}
			}
			116 if w0 == 32 => f16_to_f32(f32_to_f16(f32::from_bits(a as u32))).to_bits() as u64, // QuantizeToF16
			_ if bools => match sop {
				164 => ((a != 0) == (b()? != 0)) as u64, // LogicalEqual
				165 => ((a != 0) != (b()? != 0)) as u64,
				166 => (a != 0 || b()? != 0) as u64,
				167 => (a != 0 && b()? != 0) as u64,
				168 => (a == 0) as u64,
				_ => return None,
			},
			_ if ints => {
				let (sa, sb) = (sext(a, w0), b().map(|v| sext(v, width(arg(1).unwrap().0))));
				let sh = |v: u64| (v % w0 as u64) as u32; // WGSL's shift: by the amount modulo the width
				match sop {
					113 => a,                // UConvert: zero-extended (or truncated)
					114 => sa as u64,        // SConvert: sign-extended
					126 => sa.wrapping_neg() as u64,
					200 => !a,
					128 => a.wrapping_add(b()?),
					130 => a.wrapping_sub(b()?),
					132 => a.wrapping_mul(b()?),
					// By zero (undefined in Vulkan): x / 0 = x, x % 0 = 0, as
					// WGSL defines it at run time.
					134 => a.checked_div(b()?).unwrap_or(a),
					135 => match sb? {
						0 => a,
						d => sa.wrapping_div(d) as u64,
					},
					137 => a.checked_rem(b()?).unwrap_or(0),
					138 => match sb? {
						0 => 0,
						d => sa.wrapping_rem(d) as u64,
					},
					139 => match sb? {
						// SMod: the sign of the divisor
						0 => 0,
						d => {
							let r = sa.wrapping_rem(d);
							(if r != 0 && (r < 0) != (d < 0) { r.wrapping_add(d) } else { r }) as u64
						}
					},
					194 => a >> sh(b()?),
					195 => (sa >> sh(b()?)) as u64,
					196 => a << sh(b()?),
					197 => a | b()?,
					198 => a ^ b()?,
					199 => a & b()?,
					170 => return flag(a == b()?),
					171 => return flag(a != b()?),
					172 => return flag(a > b()?),
					173 => return flag(sa > sb?),
					174 => return flag(a >= b()?),
					175 => return flag(sa >= sb?),
					176 => return flag(a < b()?),
					177 => return flag(sa < sb?),
					178 => return flag(a <= b()?),
					179 => return flag(sa <= sb?),
					_ => return None,
				}
			}
			_ => return None,
		};
		Some(r & mask(rw))
	}

	let mut types: HashMap<u32, Ty> = HashMap::new();
	let mut scal: HashMap<u32, (u32, u64)> = HashMap::new(); // scalar constant -> (type, bits)
	let mut comps: HashMap<u32, (u32, Vec<u32>)> = HashMap::new(); // composite constant -> (type, members)
	let mut bound = words[3];
	let mut out: Vec<u32> = Vec::with_capacity(words.len());
	out.extend_from_slice(&words[..5]);
	// A folded scalar as a constant of `ty` (narrower signed integers
	// sign-extended into their word, as SPIR-V wants them).
	let emit_scalar = |out: &mut Vec<u32>, types: &HashMap<u32, Ty>, ty: u32, id: u32, v: u64| -> bool {
		match types.get(&ty) {
			Some(Ty::Bool) => out.extend(inst(if v != 0 { OP_CONSTANT_TRUE } else { OP_CONSTANT_FALSE }, &[ty, id])),
			Some(&Ty::Int(w, signed)) => {
				let lo = if signed && w < 32 { sext(v, w) as u32 } else { v as u32 };
				if w == 64 {
					out.extend(inst(OP_CONSTANT, &[ty, id, lo, (v >> 32) as u32]));
				} else {
					out.extend(inst(OP_CONSTANT, &[ty, id, lo]));
				}
			}
			Some(&Ty::Float(w)) => {
				if w == 64 {
					out.extend(inst(OP_CONSTANT, &[ty, id, v as u32, (v >> 32) as u32]));
				} else {
					out.extend(inst(OP_CONSTANT, &[ty, id, v as u32]));
				}
			}
			_ => return false,
		}
		true
	};
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		let o = words[i] & 0xffff;
		match o {
			OP_TYPE_BOOL => {
				types.insert(a[0], Ty::Bool);
			}
			OP_TYPE_INT if a.len() >= 3 => {
				types.insert(a[0], Ty::Int(a[1], a[2] != 0));
			}
			OP_TYPE_FLOAT if a.len() >= 2 => {
				types.insert(a[0], Ty::Float(a[1]));
			}
			OP_TYPE_VECTOR if a.len() >= 3 => {
				types.insert(a[0], Ty::Vector(a[1], a[2]));
			}
			OP_CONSTANT_TRUE | OP_CONSTANT_FALSE if a.len() >= 2 => {
				scal.insert(a[1], (a[0], (o == OP_CONSTANT_TRUE) as u64));
			}
			OP_CONSTANT if a.len() >= 3 => {
				if let Some(&(Ty::Int(w, _) | Ty::Float(w))) = types.get(&a[0]) {
					let hi = if w == 64 { a.get(3).copied().unwrap_or(0) as u64 } else { 0 };
					scal.insert(a[1], (a[0], (a[2] as u64 | hi << 32) & mask(w)));
				}
			}
			OP_CONSTANT_NULL if a.len() >= 2 => {
				if let Some(Ty::Int(..) | Ty::Float(_) | Ty::Bool) = types.get(&a[0]) {
					scal.insert(a[1], (a[0], 0));
				}
			}
			OP_CONSTANT_COMPOSITE if a.len() >= 2 => {
				comps.insert(a[1], (a[0], a[2..].to_vec()));
			}
			_ => {}
		}
		if o == OP_SPEC_CONSTANT_OP && a.len() >= 4 {
			let (ty, id, sop) = (a[0], a[1], a[2]);
			let start = out.len();
			let start_bound = bound;
			let done = (|| -> Option<()> {
				// A composite result made of existing constants.
				fn composite(out: &mut Vec<u32>, comps: &mut HashMap<u32, (u32, Vec<u32>)>, ty: u32, id: u32, members: Vec<u32>) {
					let mut ops = vec![ty, id];
					ops.extend(&members);
					out.extend(inst(OP_CONSTANT_COMPOSITE, &ops));
					comps.insert(id, (ty, members));
				}
				match sop {
					OP_COMPOSITE_EXTRACT if a.len() >= 5 => {
						let mut cur = a[3];
						for &k in &a[4..] {
							cur = *comps.get(&cur)?.1.get(k as usize)?;
						}
						if let Some(&(_, v)) = scal.get(&cur) {
							if !emit_scalar(&mut out, &types, ty, id, v) {
								return None;
							}
							scal.insert(id, (ty, v));
						} else {
							let m = comps.get(&cur)?.1.clone();
							composite(&mut out, &mut comps, ty, id, m);
						}
						return Some(());
					}
					OP_COMPOSITE_INSERT if a.len() == 6 => {
						let mut m = comps.get(&a[4])?.1.clone();
						*m.get_mut(a[5] as usize)? = a[3];
						composite(&mut out, &mut comps, ty, id, m);
						return Some(());
					}
					OP_VECTOR_SHUFFLE if a.len() >= 6 => {
						let mut all = comps.get(&a[3])?.1.clone();
						all.extend(&comps.get(&a[4])?.1);
						// 0xFFFFFFFF: an undefined component; any value is right.
						let m = a[5..].iter().map(|&k| all.get(if k == u32::MAX { 0 } else { k as usize }).copied()).collect::<Option<Vec<u32>>>()?;
						composite(&mut out, &mut comps, ty, id, m);
						return Some(());
					}
					// A scalar condition choosing a whole composite.
					OP_SELECT if a.len() == 6 && scal.contains_key(&a[3]) && !scal.contains_key(&a[4]) => {
						let pick = if scal[&a[3]].1 != 0 { a[4] } else { a[5] };
						let m = comps.get(&pick)?.1.clone();
						composite(&mut out, &mut comps, ty, id, m);
						return Some(());
					}
					_ => {}
				}
				let operand = |x: u32, k: Option<usize>| -> Option<(Ty, u64)> {
					let c = match (k, comps.get(&x)) {
						(Some(k), Some((_, m))) => *m.get(k)?,
						_ => x,
					};
					let &(t, v) = scal.get(&c)?;
					Some((*types.get(&t)?, v))
				};
				match types.get(&ty).copied()? {
					Ty::Vector(c, cnt) => {
						let rty = *types.get(&c)?;
						let vals = (0..cnt as usize)
							.map(|k| scalar_op(sop, rty, &a[3..].iter().map(|&v| operand(v, Some(k))).collect::<Option<Vec<_>>>()?))
							.collect::<Option<Vec<u64>>>()?;
						let mut members = Vec::new();
						for v in vals {
							let m = bound;
							bound += 1;
							if !emit_scalar(&mut out, &types, c, m, v) {
								return None;
							}
							scal.insert(m, (c, v));
							members.push(m);
						}
						composite(&mut out, &mut comps, ty, id, members);
					}
					rty => {
						let x = a[3..].iter().map(|&v| operand(v, None)).collect::<Option<Vec<_>>>()?;
						let v = scalar_op(sop, rty, &x)?;
						if !emit_scalar(&mut out, &types, ty, id, v) {
							return None;
						}
						scal.insert(id, (ty, v));
					}
				}
				Some(())
			})();
			if done.is_some() {
				i += n;
				continue;
			}
			out.truncate(start);
			bound = start_bound;
		}
		out.extend_from_slice(&words[i..i + n]);
		i += n;
	}
	out[3] = bound;
	out
}

// IEEE half <-> single precision (round to nearest even), for folding.
fn f16_to_f32(h: u16) -> f32 {
	let sign = ((h as u32) & 0x8000) << 16;
	let exp = ((h >> 10) & 0x1f) as u32;
	let man = (h & 0x3ff) as u32;
	let bits = match exp {
		0 if man == 0 => sign,
		0 => {
			// subnormal: normalized
			let (mut e, mut m) = (113u32, man);
			while m & 0x400 == 0 {
				m <<= 1;
				e -= 1;
			}
			sign | (e << 23) | ((m & 0x3ff) << 13)
		}
		0x1f => sign | 0x7f80_0000 | (man << 13),
		_ => sign | ((exp + 112) << 23) | (man << 13),
	};
	f32::from_bits(bits)
}

fn f32_to_f16(f: f32) -> u16 {
	let x = f.to_bits();
	let sign = ((x >> 16) & 0x8000) as u16;
	let exp = ((x >> 23) & 0xff) as i32;
	let man = x & 0x7f_ffff;
	if exp == 0xff {
		return sign | 0x7c00 | if man != 0 { 0x200 | (man >> 13) as u16 } else { 0 };
	}
	let e = exp - 127 + 15;
	if e >= 0x1f {
		return sign | 0x7c00;
	}
	if e <= 0 {
		if e < -10 {
			return sign;
		}
		let m = man | 0x80_0000;
		let shift = (14 - e) as u32;
		let half = 1u32 << (shift - 1);
		let (mut r, rem) = (m >> shift, m & ((1u32 << shift) - 1));
		if rem > half || (rem == half && r & 1 != 0) {
			r += 1;
		}
		return sign | r as u16;
	}
	let mut r = ((e as u32) << 10) | (man >> 13);
	let rem = man & 0x1fff;
	if rem > 0x1000 || (rem == 0x1000 && r & 1 != 0) {
		r += 1; // may carry into the exponent, up to infinity: right
	}
	sign | r as u16
}

// `readonly buffer` / `writeonly buffer` as older glslang emits them (the
// Ubuntu glslc of llama.cpp's release builds): NonWritable or NonReadable
// on every member of the block, none on the variable. naga reads only the
// variable's decorations, so such a buffer became read_write in WGSL, and
// WebGPU then refused a dispatch that binds it over the same range as a
// written buffer ("writable storage buffer binding aliasing"), which
// Vulkan allows. Each variable (or array of them) of a block whose members
// all carry the decoration gets it too.
pub fn member_access_to_variables(words: Vec<u32>) -> Vec<u32> {
	const OP_TYPE_ARRAY: u32 = 28;
	const OP_TYPE_RUNTIME_ARRAY: u32 = 29;
	const OP_DECORATE_ID: u32 = 332;
	const OP_DECORATE_STRING: u32 = 5632;
	const DEC_NON_WRITABLE: u32 = 24;
	const DEC_NON_READABLE: u32 = 25;
	let (mut members, mut marked) = (HashMap::<u32, usize>::new(), HashMap::<(u32, u32), usize>::new());
	let (mut elem, mut pointee, mut vars) = (HashMap::<u32, u32>::new(), HashMap::<u32, u32>::new(), Vec::new());
	let mut has = std::collections::HashSet::<(u32, u32)>::new();
	let mut last_annotation = 0;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		match words[i] & 0xffff {
			OP_DECORATE if a.len() >= 2 => {
				has.insert((a[0], a[1]));
				last_annotation = i + n;
			}
			OP_MEMBER_DECORATE if a.len() >= 3 => {
				if a[2] == DEC_NON_WRITABLE || a[2] == DEC_NON_READABLE {
					*marked.entry((a[0], a[2])).or_default() += 1;
				}
				last_annotation = i + n;
			}
			OP_DECORATE_ID | OP_DECORATE_STRING => last_annotation = i + n,
			OP_TYPE_STRUCT if !a.is_empty() => {
				members.insert(a[0], a.len() - 1);
			}
			OP_TYPE_ARRAY | OP_TYPE_RUNTIME_ARRAY if a.len() >= 2 => {
				elem.insert(a[0], a[1]);
			}
			OP_TYPE_POINTER if a.len() >= 3 => {
				pointee.insert(a[0], a[2]);
			}
			OP_VARIABLE if a.len() >= 3 => vars.push((a[1], a[0])),
			_ => {}
		}
		i += n;
	}
	let mut add = Vec::new();
	for (var, ptr) in vars {
		let Some(mut t) = pointee.get(&ptr).copied() else { continue };
		while let Some(&e) = elem.get(&t) {
			t = e;
		}
		let Some(&count) = members.get(&t) else { continue };
		for dec in [DEC_NON_WRITABLE, DEC_NON_READABLE] {
			if count > 0 && marked.get(&(t, dec)).copied().unwrap_or(0) >= count && !has.contains(&(var, dec)) {
				add.extend(inst(OP_DECORATE, &[var, dec]));
			}
		}
	}
	if add.is_empty() || last_annotation == 0 {
		return words;
	}
	let mut out = Vec::with_capacity(words.len() + add.len());
	out.extend_from_slice(&words[..last_annotation]);
	out.extend(add);
	out.extend_from_slice(&words[last_annotation..]);
	out
}

// Storage buffers the module never writes, as GLSL `buffer` blocks without
// `readonly` (GZDoom's bone and light buffers, read by its vertex shaders):
// glslang decorates NonWritable only for `readonly`, so such a block became
// read_write in WGSL, which WebGPU refuses in a vertex stage. A storage
// buffer variable (StorageBuffer, or Uniform with a BufferBlock struct; an
// array of them too) gets NonWritable when no pointer into it reaches
// anything but OpLoad, OpAtomicLoad, OpArrayLength, an access chain or
// OpCopyObject: a store, an atomic, a function call or any use this pass
// does not know counts as a write. Variables sharing a binding (views
// merge_aliased_buffers and small.rs join into one) are marked only when
// none of them is written. Variables decorated NonReadable are left alone,
// and so is a module with variable pointers (pointers can then join out of
// the order this single walk sees).
pub fn mark_unwritten_buffers(words: Vec<u32>) -> Vec<u32> {
	const OP_CAPABILITY: u32 = 17;
	const OP_TYPE_ARRAY: u32 = 28;
	const OP_TYPE_RUNTIME_ARRAY: u32 = 29;
	const OP_FUNCTION: u32 = 54;
	const OP_ACCESS_CHAIN: u32 = 65;
	const OP_IN_BOUNDS_ACCESS_CHAIN: u32 = 66;
	const OP_PTR_ACCESS_CHAIN: u32 = 67;
	const OP_ARRAY_LENGTH: u32 = 68;
	const OP_IN_BOUNDS_PTR_ACCESS_CHAIN: u32 = 70;
	const OP_COPY_OBJECT: u32 = 83;
	const OP_ATOMIC_LOAD: u32 = 227;
	const OP_DECORATE_ID: u32 = 332;
	const OP_DECORATE_STRING: u32 = 5632;
	const OP_MEMBER_DECORATE_STRING: u32 = 5633;
	const DEC_BUFFER_BLOCK: u32 = 3;
	const DEC_NON_WRITABLE: u32 = 24;
	const DEC_NON_READABLE: u32 = 25;
	const SC_UNIFORM: u32 = 2;
	const SC_STORAGE_BUFFER: u32 = 12;
	const CAP_VARIABLE_POINTERS_STORAGE_BUFFER: u32 = 4441;
	const CAP_VARIABLE_POINTERS: u32 = 4442;

	let mut has = std::collections::HashSet::<(u32, u32)>::new();
	let (mut elem, mut pointee) = (HashMap::<u32, u32>::new(), HashMap::<u32, u32>::new());
	let (mut set, mut binding) = (HashMap::<u32, u32>::new(), HashMap::<u32, u32>::new());
	let mut vars: Vec<u32> = Vec::new();
	let mut root: HashMap<u32, u32> = HashMap::new(); // pointer -> the storage variable it points into
	let mut written = std::collections::HashSet::<u32>::new();
	let mut last_annotation = 0;
	let mut in_function = false;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let a = &words[i + 1..i + n];
		if o == OP_FUNCTION {
			in_function = true;
		}
		if !in_function {
			match o {
				OP_CAPABILITY if a.first().is_some_and(|&c| c == CAP_VARIABLE_POINTERS || c == CAP_VARIABLE_POINTERS_STORAGE_BUFFER) => return words,
				OP_DECORATE if a.len() >= 2 => {
					has.insert((a[0], a[1]));
					if a.len() >= 3 && a[1] == DEC_BINDING {
						binding.insert(a[0], a[2]);
					}
					if a.len() >= 3 && a[1] == DEC_DESCRIPTOR_SET {
						set.insert(a[0], a[2]);
					}
					last_annotation = i + n;
				}
				OP_MEMBER_DECORATE | OP_DECORATE_ID | OP_DECORATE_STRING | OP_MEMBER_DECORATE_STRING | 73 | 74 | 75 => last_annotation = i + n,
				OP_TYPE_ARRAY | OP_TYPE_RUNTIME_ARRAY if a.len() >= 2 => {
					elem.insert(a[0], a[1]);
				}
				OP_TYPE_POINTER if a.len() >= 3 => {
					pointee.insert(a[0], a[2]);
				}
				OP_VARIABLE if a.len() >= 3 && (a[2] == SC_STORAGE_BUFFER || a[2] == SC_UNIFORM) => {
					let mut t = pointee.get(&a[0]).copied().unwrap_or(0);
					while let Some(&e) = elem.get(&t) {
						t = e;
					}
					if a[2] == SC_STORAGE_BUFFER || has.contains(&(t, DEC_BUFFER_BLOCK)) {
						vars.push(a[1]);
						root.insert(a[1], a[1]);
					}
				}
				_ => {}
			}
			i += n;
			continue;
		}
		match o {
			OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN | OP_PTR_ACCESS_CHAIN | OP_IN_BOUNDS_PTR_ACCESS_CHAIN | OP_COPY_OBJECT if a.len() >= 3 => {
				if let Some(&r) = root.get(&a[2]) {
					root.insert(a[1], r);
				}
				// The indices are integers, never pointers into a buffer.
			}
			OP_LOAD | OP_ATOMIC_LOAD | OP_ARRAY_LENGTH if a.len() >= 3 => {}
			_ => {
				for x in a {
					if let Some(&r) = root.get(x) {
						written.insert(r);
					}
				}
			}
		}
		i += n;
	}
	let slot = |v: u32| (set.get(&v).copied().unwrap_or(0), binding.get(&v).copied());
	let written_slots: std::collections::HashSet<(u32, Option<u32>)> = written.iter().map(|&v| slot(v)).collect();
	let mut add = Vec::new();
	for v in vars {
		if has.contains(&(v, DEC_NON_WRITABLE)) || has.contains(&(v, DEC_NON_READABLE)) || written.contains(&v) || written_slots.contains(&slot(v)) {
			continue;
		}
		add.extend(inst(OP_DECORATE, &[v, DEC_NON_WRITABLE]));
	}
	if add.is_empty() || last_annotation == 0 {
		return words;
	}
	let mut out = Vec::with_capacity(words.len() + add.len());
	out.extend_from_slice(&words[..last_annotation]);
	out.extend(add);
	out.extend_from_slice(&words[last_annotation..]);
	out
}

// OpLine and OpNoLine (source positions only): a -g build (Taisei compiles
// its shaders with glslang's debug info) has OpLine among the types and
// globals, which naga's spv-in refuses ("unsupported instruction Line at
// Type"). Dropped everywhere.
pub fn strip_debug_lines(words: Vec<u32>) -> Vec<u32> {
	const OP_LINE: u32 = 8;
	const OP_NO_LINE: u32 = 317;
	let is_line = |w: u32| matches!(w & 0xffff, OP_LINE | OP_NO_LINE);
	let mut any = false;
	let mut i = 5;
	while i < words.len() {
		any |= is_line(words[i]);
		i += (words[i] >> 16) as usize;
	}
	if !any {
		return words;
	}
	let mut out: Vec<u32> = Vec::with_capacity(words.len());
	out.extend_from_slice(&words[..5]);
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		if !is_line(words[i]) {
			out.extend_from_slice(&words[i..i + n]);
		}
		i += n;
	}
	out
}

// Constructs naga's spv-in rejects that have a WGSL-compatible meaning:
// - NonSemantic.* extended instructions (DebugPrintf, ...): dropped.
// - gl_PointCoord (no WGSL builtin; points are 1 px): a private vec2(0.5).
// - BaseVertex, BaseInstance, DrawIndex (shader draw parameters): 0.
// - OpDemoteToHelperInvocation: OpKill (WGSL's discard demotes), followed
//   by a fresh block label for the instructions after it.
// - OpCopyLogical (SPIR-V 1.4+, copies between same-shaped types with
//   different layouts): member-wise OpCompositeExtract/Construct.
pub fn misc_fixes(words: Vec<u32>) -> Vec<u32> {
	let words = hoist_undefs(words);
	let words = dual_source_index(words);
	const OP_EXTENSION: u32 = 10;
	const OP_EXT_INST_IMPORT: u32 = 11;
	const OP_EXT_INST: u32 = 12;
	const OP_TYPE_VECTOR: u32 = 23;
	const OP_TYPE_ARRAY: u32 = 28;
	const OP_CONSTANT: u32 = 43;
	const OP_CONSTANT_COMPOSITE: u32 = 44;
	const OP_COPY_OBJECT: u32 = 83;
	const OP_COMPOSITE_CONSTRUCT: u32 = 80;
	const OP_COMPOSITE_EXTRACT: u32 = 81;
	const OP_KILL: u32 = 252;
	const OP_LABEL: u32 = 248;
	const OP_COPY_LOGICAL: u32 = 400;
	const OP_DEMOTE: u32 = 5380;
	const BI_POINT_COORD: u32 = 16;
	const SC_INPUT: u32 = 1;
	const SC_PRIVATE: u32 = 6;

	let mut bound = words[3];
	let mut drop_sets: Vec<u32> = Vec::new();
	let mut point_coord: Vec<u32> = Vec::new();
	let mut pointers: HashMap<u32, u32> = HashMap::new();
	let mut vectors: HashMap<u32, (u32, u32)> = HashMap::new();
	let mut structs: HashMap<u32, Vec<u32>> = HashMap::new();
	let mut arrays: HashMap<u32, (u32, u32)> = HashMap::new();
	let mut consts: HashMap<u32, u32> = HashMap::new();
	let mut any = false;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		match words[i] & 0xffff {
			OP_EXT_INST_IMPORT if read_string(&a[1..]).starts_with("NonSemantic.") && !read_string(&a[1..]).starts_with("NonSemantic.Shader.DebugInfo") => {
				drop_sets.push(a[0]);
				any = true;
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_BUILTIN && (a[2] == BI_POINT_COORD || (4424..=4426).contains(&a[2])) => {
				point_coord.push(a[0]);
				any = true;
			}
			OP_TYPE_POINTER => {
				pointers.insert(a[0], a[2]);
			}
			OP_TYPE_VECTOR => {
				vectors.insert(a[0], (a[1], a[2]));
			}
			OP_TYPE_STRUCT => {
				structs.insert(a[0], a[1..].to_vec());
			}
			OP_TYPE_ARRAY => {
				arrays.insert(a[0], (a[1], a[2]));
			}
			OP_CONSTANT if a.len() >= 3 => {
				consts.insert(a[1], a[2]);
			}
			OP_DEMOTE | OP_COPY_LOGICAL => any = true,
			OP_EXTENSION if matches!(read_string(a).as_str(), "SPV_EXT_demote_to_helper_invocation" | "SPV_KHR_shader_draw_parameters" | "SPV_KHR_8bit_storage" | "SPV_KHR_16bit_storage") => any = true,
			_ => {}
		}
		i += n;
	}
	if !any {
		return words;
	}
	let mut out: Vec<u32> = Vec::with_capacity(words.len() + 64);
	out.extend_from_slice(&words[..5]);
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		let o = words[i] & 0xffff;
		match o {
			OP_EXTENSION if matches!(read_string(a).as_str(), "SPV_KHR_non_semantic_info" | "SPV_EXT_demote_to_helper_invocation" | "SPV_KHR_shader_draw_parameters" | "SPV_KHR_8bit_storage" | "SPV_KHR_16bit_storage") => {}
			OP_EXT_INST_IMPORT if drop_sets.contains(&a[0]) => {}
			OP_EXT_INST if drop_sets.contains(&a[2]) => {}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_BUILTIN && (a[2] == BI_POINT_COORD || (4424..=4426).contains(&a[2])) => {}
			OP_ENTRY_POINT if !point_coord.is_empty() => {
				// Interface ids follow the name string.
				let name_words = a[2..].iter().position(|w| w.to_le_bytes().contains(&0)).map(|p| p + 1).unwrap_or(a.len() - 2);
				let mut ops = a[..2 + name_words].to_vec();
				ops.extend(a[2 + name_words..].iter().filter(|x| !point_coord.contains(x)));
				out.extend(inst(OP_ENTRY_POINT, &ops));
			}
			OP_VARIABLE if a[2] == SC_INPUT && point_coord.contains(&a[1]) && !vectors.contains_key(&pointers.get(&a[0]).copied().unwrap_or(0)) => {
				// BaseVertex, BaseInstance, DrawIndex: 0 (right for draws with
				// firstVertex/vertexOffset/firstInstance 0 and single draws).
				let ty = pointers.get(&a[0]).copied().unwrap_or(0);
				let z = bound;
				bound += 1;
				out.extend(inst(OP_CONSTANT, &[ty, z, 0]));
				out.extend(inst(OP_VARIABLE, &[a[0], a[1], SC_PRIVATE, z]));
			}
			OP_VARIABLE if a[2] == SC_INPUT && point_coord.contains(&a[1]) => {
				let vec = pointers.get(&a[0]).copied().unwrap_or(0);
				let (comp, cnt) = vectors.get(&vec).copied().unwrap_or((0, 2));
				let (half, init) = (bound, bound + 1);
				bound += 2;
				out.extend(inst(OP_CONSTANT, &[comp, half, 0.5f32.to_bits()]));
				let mut c = vec![vec, init];
				c.extend(std::iter::repeat(half).take(cnt as usize));
				out.extend(inst(OP_CONSTANT_COMPOSITE, &c));
				out.extend(inst(OP_VARIABLE, &[a[0], a[1], SC_PRIVATE, init]));
			}
			OP_DEMOTE => {
				out.extend(inst(OP_KILL, &[]));
				out.extend(inst(OP_LABEL, &[bound]));
				bound += 1;
			}
			OP_COPY_LOGICAL => {
				fn copy(out: &mut Vec<u32>, bound: &mut u32, dst: u32, src_ty: u32, src: u32, res: u32, t: &(&HashMap<u32, Vec<u32>>, &HashMap<u32, (u32, u32)>, &HashMap<u32, u32>)) {
					let (structs, arrays, consts) = *t;
					let parts: Vec<(u32, u32)> = if let (Some(d), Some(s)) = (structs.get(&dst), structs.get(&src_ty)) {
						d.iter().copied().zip(s.iter().copied()).collect()
					} else if let (Some(&(de, len)), Some(&(se, _))) = (arrays.get(&dst), arrays.get(&src_ty)) {
						(0..consts.get(&len).copied().unwrap_or(0)).map(|_| (de, se)).collect()
					} else {
						out.extend(inst(OP_COPY_OBJECT, &[dst, res, src]));
						return;
					};
					let mut comps = Vec::new();
					for (k, (d, s)) in parts.into_iter().enumerate() {
						let e = *bound;
						*bound += 1;
						out.extend(inst(OP_COMPOSITE_EXTRACT, &[s, e, src, k as u32]));
						if d == s {
							comps.push(e);
						} else {
							let c = *bound;
							*bound += 1;
							copy(out, bound, d, s, e, c, t);
							comps.push(c);
						}
					}
					let mut ops = vec![dst, res];
					ops.extend(comps);
					out.extend(inst(OP_COMPOSITE_CONSTRUCT, &ops));
				}
				// The source's type: found from its defining instruction.
				let src_ty = type_of(&words, a[2]).unwrap_or(a[0]);
				copy(&mut out, &mut bound, a[0], src_ty, a[2], a[1], &(&structs, &arrays, &consts));
			}
			_ => out.extend_from_slice(&words[i..i + n]),
		}
		i += n;
	}
	out[3] = bound;
	out
}

// The result type of the instruction defining `id` (result type first).
fn type_of(words: &[u32], id: u32) -> Option<u32> {
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		if n >= 3 && words[i + 2] == id && !(19..=39).contains(&(words[i] & 0xffff)) {
			return Some(words[i + 1]);
		}
		i += n;
	}
	None
}

// A constant-index access chain into a flattened array: an alias for the
// element or a chain from it. False for a dynamic index.
fn static_chain(o: u32, a: &[u32], elems: &[u32], consts: &HashMap<u32, u32>, alias: &mut HashMap<u32, u32>, out: &mut Vec<u32>) -> Result<bool, String> {
	let Some(&ci) = consts.get(&a[3]) else { return Ok(false) };
	let e = *elems.get(ci as usize).ok_or("descriptor array index out of range")?;
	if a.len() == 4 {
		alias.insert(a[1], e);
	} else {
		let mut ops = vec![a[0], a[1], e];
		ops.extend(&a[4..]);
		out.extend(inst(o, &ops));
	}
	Ok(true)
}

/// A descriptor array element after flattening.
pub struct Flat {
	pub var: u32,
	pub set: u32,
	pub wgsl_binding: u32,
	pub binding: u32,
	pub index: u32,
}

// Descriptor arrays of constant size (sampled images, samplers, combined
// image samplers, uniform and storage buffers) become one variable per
// element at the binding the host chose (`arrays`: (set, binding, base,
// count); element i at base + 2*i, a combined sampler's sampler half at
// base + 2*i + 1). A constant index picks the element; a dynamic one
// becomes an OpSwitch over the elements around the instructions from the
// access chain to the first one producing a plain value (the sample, load,
// query or store), joined by an OpPhi.
pub fn flatten_descriptor_arrays(words: Vec<u32>, arrays: &[(u32, u32, u32, u32)]) -> Result<(Vec<u32>, Vec<Flat>), String> {
	const OP_TYPE_IMAGE: u32 = 25;
	const OP_TYPE_ARRAY: u32 = 28;
	const OP_TYPE_RUNTIME_ARRAY: u32 = 29;
	const OP_CONSTANT: u32 = 43;
	const OP_FUNCTION: u32 = 54;
	const OP_FUNCTION_END: u32 = 56;
	const OP_STORE: u32 = 62;
	const OP_ACCESS_CHAIN: u32 = 65;
	const OP_IN_BOUNDS_ACCESS_CHAIN: u32 = 66;
	const OP_PHI: u32 = 245;
	const OP_SELECTION_MERGE: u32 = 247;
	const OP_LABEL: u32 = 248;
	const OP_BRANCH: u32 = 249;
	const OP_SWITCH: u32 = 251;
	const SC_UNIFORM: u32 = 2;
	const SC_STORAGE_BUFFER: u32 = 12;

	let version = words[1];
	let mut bound = words[3];
	let mut insts: Vec<(usize, usize)> = Vec::new();
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		insts.push((i, n));
		i += n;
	}
	let op = |k: usize| words[insts[k].0] & 0xffff;
	let args = |k: usize| &words[insts[k].0 + 1..insts[k].0 + insts[k].1];

	let mut pointers: HashMap<u32, (u32, u32)> = HashMap::new();
	let mut arr_ty: HashMap<u32, (u32, u32)> = HashMap::new(); // array -> (element, length id)
	let mut runtime: Vec<u32> = Vec::new();
	let mut consts: HashMap<u32, u32> = HashMap::new();
	let mut handle_types: Vec<u32> = Vec::new(); // image, sampler, sampled image, pointer
	let mut binding: HashMap<u32, u32> = HashMap::new();
	let mut set: HashMap<u32, u32> = HashMap::new();
	for k in 0..insts.len() {
		let a = args(k);
		match op(k) {
			OP_TYPE_POINTER => {
				pointers.insert(a[0], (a[1], a[2]));
				handle_types.push(a[0]);
			}
			OP_TYPE_IMAGE | OP_TYPE_SAMPLER | OP_TYPE_SAMPLED_IMAGE => handle_types.push(a[0]),
			OP_TYPE_ARRAY => {
				arr_ty.insert(a[0], (a[1], a[2]));
			}
			OP_TYPE_RUNTIME_ARRAY => runtime.push(a[0]),
			OP_CONSTANT if a.len() >= 3 => {
				consts.insert(a[1], a[2]);
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_BINDING => {
				binding.insert(a[0], a[2]);
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_DESCRIPTOR_SET => {
				set.insert(a[0], a[2]);
			}
			_ => {}
		}
	}
	// Targets: var -> (element pointer type, element ids, original pointer).
	struct Target {
		elem_ptr: u32,
		elems: Vec<u32>,
	}
	let mut targets: HashMap<u32, Target> = HashMap::new();
	let mut elem_ptr_of: HashMap<u32, u32> = HashMap::new(); // array pointer -> element pointer
	let mut flats = Vec::new();
	for k in 0..insts.len() {
		let a = args(k);
		if op(k) != OP_VARIABLE || !matches!(a[2], SC_UNIFORM_CONSTANT | SC_UNIFORM | SC_STORAGE_BUFFER) {
			continue;
		}
		let Some(&(sc, pointee)) = pointers.get(&a[0]) else { continue };
		let (v, s, b) = (a[1], set.get(&a[1]).copied().unwrap_or(0), binding.get(&a[1]).copied().unwrap_or(0));
		if runtime.contains(&pointee) {
			return Err(format!("descriptor array at set {} binding {} is runtime-sized (unsupported)", s, b));
		}
		let Some(&(elem, len)) = arr_ty.get(&pointee) else { continue };
		let n = consts.get(&len).copied().unwrap_or(0);
		let Some(&(_, _, base, count)) = arrays.iter().find(|x| x.0 == s && x.1 == b) else {
			return Err(format!("descriptor array at set {} binding {} ({} elements): the host must pass it in opts.arrays", s, b, n));
		};
		if count < n {
			return Err(format!("descriptor array {}.{}: {} elements but opts.arrays gives {}", s, b, n, count));
		}
		let ep = *elem_ptr_of.entry(a[0]).or_insert_with(|| {
			bound += 1;
			bound - 1
		});
		let _ = (sc, elem);
		let mut elems = Vec::new();
		for idx in 0..n {
			elems.push(bound);
			flats.push(Flat { var: bound, set: s, wgsl_binding: base + 2 * idx, binding: b, index: idx });
			bound += 1;
		}
		targets.insert(v, Target { elem_ptr: ep, elems });
	}
	if targets.is_empty() {
		return Ok((words, flats));
	}
	let final_binding: HashMap<u32, u32> = flats.iter().map(|f| (f.var, f.wgsl_binding)).collect();

	// Operand positions that hold a pointer, per opcode (for aliases).
	fn ptr_operands(o: u32, n_args: usize) -> Vec<usize> {
		match o {
			61 | 65 | 66 | 60 | 68 | 83 => vec![2], // Load, AccessChain(s), ImageTexelPointer, ArrayLength, CopyObject
			62 => vec![0],                         // Store
			57 => (3..n_args).collect(),           // FunctionCall
			227..=242 | 4396 => vec![2],           // atomics
			_ => vec![],
		}
	}

	let mut out: Vec<u32> = Vec::with_capacity(words.len() + 256);
	out.extend_from_slice(&words[..5]);
	let mut alias: HashMap<u32, u32> = HashMap::new();
	let mut dyn_ptrs: HashMap<u32, (u32, u32, u32, u32, Vec<u32>)> = HashMap::new(); // r -> (op, type, var, index, rest)
	let mut label_renames: HashMap<u32, u32> = HashMap::new();
	let mut cur_label = 0u32;
	let mut fn_end = 0usize; // index of the current function's OpFunctionEnd
	let mut k = 0;
	while k < insts.len() {
		let (start, n) = insts[k];
		let o = op(k);
		let mut a = args(k).to_vec();
		for p in ptr_operands(o, a.len()) {
			if let Some(&x) = alias.get(&a[p]) {
				a[p] = x;
			}
		}
		if o == OP_FUNCTION {
			fn_end = (k..insts.len()).find(|&j| op(j) == OP_FUNCTION_END).unwrap_or(insts.len());
		}
		if o == OP_LABEL {
			cur_label = a[0];
		}
		let first = if o == OP_STORE { 0 } else { 2 };
		let dyn_use = if dyn_ptrs.is_empty() || o == OP_NAME || o == OP_DECORATE { None } else { a.iter().skip(first).find(|x| dyn_ptrs.contains_key(x)).copied() };
		match o {
			OP_NAME if targets.contains_key(&a[0]) => {
				let name = read_string(&a[1..]);
				for (idx, &e) in targets[&a[0]].elems.iter().enumerate() {
					let mut ops = vec![e];
					ops.extend(string_words(&format!("{}_{}", name, idx)));
					out.extend(inst(OP_NAME, &ops));
				}
			}
			OP_DECORATE if targets.contains_key(&a[0]) => {
				for &e in &targets[&a[0]].elems {
					let mut ops = a.clone();
					ops[0] = e;
					if a[1] == DEC_BINDING {
						ops[2] = final_binding[&e];
					}
					out.extend(inst(OP_DECORATE, &ops));
				}
			}
			OP_ENTRY_POINT if version >= 0x0001_0400 => {
				let mut ops = Vec::new();
				for &x in &a {
					match targets.get(&x) {
						Some(t) => ops.extend(&t.elems),
						None => ops.push(x),
					}
				}
				out.extend(inst(OP_ENTRY_POINT, &ops));
			}
			OP_TYPE_POINTER if elem_ptr_of.contains_key(&a[0]) => {
				out.extend_from_slice(&words[start..start + n]);
				let elem = arr_ty[&a[2]].0;
				out.extend(inst(OP_TYPE_POINTER, &[elem_ptr_of[&a[0]], a[1], elem]));
			}
			OP_VARIABLE if targets.contains_key(&a[1]) => {
				let t = &targets[&a[1]];
				for &e in &t.elems {
					out.extend(inst(OP_VARIABLE, &[t.elem_ptr, e, a[2]]));
				}
			}
			OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN if targets.contains_key(&a[2]) => {
				let t = &targets[&a[2]];
				if static_chain(o, &a, &t.elems, &consts, &mut alias, &mut out)? {
					k += 1;
					continue;
				}
				// Dynamic index: remembered; each instruction using the
				// pointer starts a switch (below).
				dyn_ptrs.insert(a[1], (o, a[0], a[2], a[3], a[4..].to_vec()));
				k += 1;
				continue;
			}
			_ if dyn_use.is_some() => {
				let r = dyn_use.unwrap();
				let (chain_op, chain_ty, var, idx, rest) = dyn_ptrs[&r].clone();
				let t = &targets[&var];
				let mut derived = vec![r];
				let mut window: Vec<usize> = vec![k];
				let a_k = args(k);
				if o != OP_STORE && a_k.len() >= 2 && !matches!(o, 99 | 228) && handle_types.contains(&a_k[0]) {
					derived.push(a_k[1]);
				}
				let mut consumer = if derived.len() == 1 { Some(k) } else { None };
				let mut hoist: Vec<usize> = Vec::new();
				let mut j = k + 1;
				while j < fn_end && consumer.is_none() {
					let oj = op(j);
					if matches!(oj, OP_LABEL | OP_BRANCH | 250 | OP_SWITCH | 252 | 253 | 254 | 255 | OP_SELECTION_MERGE | 246) {
						break;
					}
					let aj = args(j);
					let uses = aj.iter().skip(if oj == OP_STORE { 0 } else { 2 }).any(|x| derived.contains(x));
					if !uses {
						hoist.push(j);
						j += 1;
						continue;
					}
					window.push(j);
					let has_result = oj != OP_STORE && aj.len() >= 2 && !matches!(oj, 99 | 228) /* ImageWrite, AtomicStore */;
					if has_result && handle_types.contains(&aj[0]) {
						derived.push(aj[1]);
						j += 1;
						continue;
					}
					consumer = Some(j);
					break;
				}
				let Some(m) = consumer else {
					return Err("dynamic descriptor array index: no consuming instruction in the same block".into());
				};
				// Derived handles must not be used past the window (the
				// pointer itself may: each use gets its own switch).
				for jj in m + 1..fn_end {
					if args(jj).iter().any(|x| derived[1..].contains(x)) {
						return Err("dynamic descriptor array index: the element is used more than once".into());
					}
				}
				for &h in &hoist {
					let oh = op(h);
					let mut ah = args(h).to_vec();
					for p in ptr_operands(oh, ah.len()) {
						if let Some(&x) = alias.get(&ah[p]) {
							ah[p] = x;
						}
					}
					if matches!(oh, OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN) && targets.contains_key(&ah[2]) {
						if !static_chain(oh, &ah, &targets[&ah[2]].elems, &consts, &mut alias, &mut out)? {
							return Err("two dynamic descriptor array indices in one expression".into());
						}
						continue;
					}
					out.extend(inst(oh, &ah));
				}
				let merge = bound;
				let cases: Vec<u32> = (0..t.elems.len() as u32).map(|x| merge + 1 + x).collect();
				bound += 1 + cases.len() as u32;
				out.extend(inst(OP_SELECTION_MERGE, &[merge, 0]));
				let mut sw = vec![idx, cases[0]];
				// Element 0 is the default (out-of-range indices too); naga
				// mishandles a case literal sharing the default's block.
				for (x, &c) in cases.iter().enumerate().skip(1) {
					sw.extend([x as u32, c]);
				}
				out.extend(inst(OP_SWITCH, &sw));
				let cons_args = args(m);
				let cons_result = if op(m) != OP_STORE && cons_args.len() >= 2 && !matches!(op(m), 99 | 228) { Some((cons_args[0], cons_args[1])) } else { None };
				let mut phi = Vec::new();
				for (x, &c) in cases.iter().enumerate() {
					out.extend(inst(OP_LABEL, &[c]));
					let mut ren: HashMap<u32, u32> = HashMap::new();
					for &w in &window {
						let ow = op(w);
						let mut aw = args(w).to_vec();
						if w == k {
							if rest.is_empty() {
								ren.insert(r, t.elems[x]);
							} else {
								let mut ops = vec![chain_ty, bound, t.elems[x]];
								ops.extend(&rest);
								ren.insert(r, bound);
								bound += 1;
								out.extend(inst(chain_op, &ops));
							}
						}
						let skip = if ow == OP_STORE { 0 } else { 2 };
						for q in skip..aw.len() {
							if let Some(&v) = ren.get(&aw[q]) {
								aw[q] = v;
							}
						}
						if ow != OP_STORE && aw.len() >= 2 && !matches!(ow, 99 | 228) {
							ren.insert(aw[1], bound);
							if w == m {
								phi.extend([bound, c]);
							}
							aw[1] = bound;
							bound += 1;
						}
						out.extend(inst(ow, &aw));
					}
					out.extend(inst(OP_BRANCH, &[merge]));
				}
				out.extend(inst(OP_LABEL, &[merge]));
				label_renames.insert(cur_label, merge);
				cur_label = merge;
				if let Some((ty, res)) = cons_result {
					let mut ops = vec![ty, res];
					ops.extend(phi);
					out.extend(inst(OP_PHI, &ops));
				}
				k = m + 1;
				continue;
			}
			_ => {
				if ptr_operands(o, a.len()).iter().any(|&p| targets.contains_key(&a[p])) {
					return Err("a descriptor array is used whole (passed to a function or loaded)".into());
				}
				out.extend(inst(o, &a));
			}
		}
		k += 1;
	}
	// Phis naming a split block as predecessor now name its merge block.
	if !label_renames.is_empty() {
		let mut i = 5;
		while i < out.len() {
			let n = (out[i] >> 16) as usize;
			if out[i] & 0xffff == OP_PHI {
				let mut q = i + 4;
				while q < i + n {
					if let Some(&m) = label_renames.get(&out[q]) {
						out[q] = m;
					}
					q += 2;
				}
			}
			i += n;
		}
	}
	out[3] = bound;
	Ok((out, flats))
}

// Input attachments (subpassInput, Dim SubpassData) are textures in WGSL:
// the image type becomes 2D sampled, and OpImageRead (subpassLoad) an
// OpImageFetch at the fragment's position (gl_FragCoord.xy + the offset),
// level 0 or the given sample. A FragCoord input is added when missing.
pub fn subpass_inputs(words: Vec<u32>) -> Vec<u32> {
	const OP_TYPE_INT: u32 = 21;
	const OP_TYPE_FLOAT: u32 = 22;
	const OP_TYPE_VECTOR: u32 = 23;
	const OP_TYPE_IMAGE: u32 = 25;
	const OP_CONSTANT: u32 = 43;
	const OP_FUNCTION: u32 = 54;
	const OP_VECTOR_SHUFFLE: u32 = 79;
	const OP_CONVERT_F_TO_S: u32 = 110;
	const OP_IADD: u32 = 128;
	const OP_IMAGE_FETCH: u32 = 95;
	const OP_IMAGE_READ: u32 = 98;
	const DIM_SUBPASS: u32 = 6;
	const BI_FRAG_COORD: u32 = 15;
	const SC_INPUT: u32 = 1;

	let mut subpass_types: Vec<u32> = Vec::new();
	let mut frag_coord: Option<u32> = None;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		match words[i] & 0xffff {
			OP_TYPE_IMAGE if a[2] == DIM_SUBPASS => subpass_types.push(a[0]),
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_BUILTIN && a[2] == BI_FRAG_COORD => frag_coord = Some(a[0]),
			_ => {}
		}
		i += n;
	}
	if subpass_types.is_empty() {
		return words;
	}
	let mut bound = words[3];
	let mut id = || {
		bound += 1;
		bound - 1
	};
	let (f32t, v4, v2, i32t, v2i, pin, zero) = (id(), id(), id(), id(), id(), id(), id());
	let fc_new = frag_coord.is_none();
	let fc = frag_coord.unwrap_or_else(&mut id);
	let mut images: Vec<u32> = Vec::new(); // loaded subpass images
	let mut extra: Vec<u32> = Vec::new();
	let mut out: Vec<u32> = Vec::with_capacity(words.len() + 64);
	out.extend_from_slice(&words[..5]);
	let mut globals_done = false;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		let o = words[i] & 0xffff;
		match o {
			OP_ENTRY_POINT if fc_new => {
				let mut ops = a.to_vec();
				ops.push(fc);
				out.extend(inst(o, &ops));
			}
			OP_DECORATE if fc_new && !globals_done && out.len() > 5 && extra.is_empty() => {
				extra.push(0);
				out.extend(inst(OP_DECORATE, &[fc, DEC_BUILTIN, BI_FRAG_COORD]));
				out.extend_from_slice(&words[i..i + n]);
			}
			OP_TYPE_IMAGE if subpass_types.contains(&a[0]) => {
				let mut ops = a.to_vec();
				ops[2] = 1; // 2D
				ops[6] = 1; // sampled
				out.extend(inst(o, &ops));
			}
			OP_FUNCTION if !globals_done => {
				globals_done = true;
				out.extend(inst(OP_TYPE_FLOAT, &[f32t, 32]));
				out.extend(inst(OP_TYPE_VECTOR, &[v4, f32t, 4]));
				out.extend(inst(OP_TYPE_VECTOR, &[v2, f32t, 2]));
				out.extend(inst(OP_TYPE_INT, &[i32t, 32, 1]));
				out.extend(inst(OP_TYPE_VECTOR, &[v2i, i32t, 2]));
				out.extend(inst(OP_TYPE_POINTER, &[pin, SC_INPUT, v4]));
				out.extend(inst(OP_CONSTANT, &[i32t, zero, 0]));
				if fc_new {
					out.extend(inst(OP_VARIABLE, &[pin, fc, SC_INPUT]));
				}
				out.extend_from_slice(&words[i..i + n]);
			}
			OP_LOAD if subpass_types.contains(&a[0]) => {
				images.push(a[1]);
				out.extend_from_slice(&words[i..i + n]);
			}
			OP_IMAGE_READ if images.contains(&a[2]) => {
				let (l, sh, ixy, c) = (bound, bound + 1, bound + 2, bound + 3);
				bound += 4;
				out.extend(inst(OP_LOAD, &[v4, l, fc]));
				out.extend(inst(OP_VECTOR_SHUFFLE, &[v2, sh, l, l, 0, 1]));
				out.extend(inst(OP_CONVERT_F_TO_S, &[v2i, ixy, sh]));
				out.extend(inst(OP_IADD, &[v2i, c, ixy, a[3]]));
				let mut ops = vec![a[0], a[1], a[2], c];
				if a.len() > 4 {
					ops.extend(&a[4..]); // Sample for subpassInputMS
				} else {
					ops.extend([2, zero]); // Lod 0
				}
				out.extend(inst(OP_IMAGE_FETCH, &ops));
			}
			_ => out.extend_from_slice(&words[i..i + n]),
		}
		i += n;
	}
	out[3] = bound;
	out
}

// Array, matrix and struct varyings (GTK 4's `#define Rect vec4[1]`, or
// `struct Rect { vec4 bounds; }`) take one location per element in Vulkan;
// WGSL allows only scalars and vectors. Each such Input/Output variable
// becomes one variable per element/member at consecutive locations (a
// member's own Location wins), keeping the variable's and the members'
// interpolation decorations. Constant-index access chains pick the
// element and whole loads/stores go element-wise; a variable indexed
// dynamically instead gets a private shadow copied from the inputs at the
// entry point's start, or to the outputs before each return.
pub fn flatten_io_arrays(words: Vec<u32>) -> Result<Vec<u32>, String> {
	const OP_TYPE_INT: u32 = 21;
	const OP_TYPE_VECTOR: u32 = 23;
	const OP_TYPE_MATRIX: u32 = 24;
	const OP_TYPE_ARRAY: u32 = 28;
	const OP_CONSTANT: u32 = 43;
	const OP_FUNCTION: u32 = 54;
	const OP_FUNCTION_END: u32 = 56;
	const OP_COMPOSITE_CONSTRUCT: u32 = 80;
	const OP_COMPOSITE_EXTRACT: u32 = 81;
	const OP_STORE: u32 = 62;
	const OP_ACCESS_CHAIN: u32 = 65;
	const OP_IN_BOUNDS_ACCESS_CHAIN: u32 = 66;
	const OP_LABEL: u32 = 248;
	const OP_RETURN: u32 = 253;
	const SC_INPUT: u32 = 1;
	const SC_OUTPUT: u32 = 3;
	const SC_PRIVATE: u32 = 6;
	const INTERP: [u32; 5] = [13, 14, 15, 16, 17]; // NoPerspective Flat Patch Centroid Sample

	let mut bound = words[3];
	let mut pointers: HashMap<u32, (u32, u32)> = HashMap::new();
	let mut composite: HashMap<u32, Vec<u32>> = HashMap::new(); // array/matrix/struct -> element types
	let mut is_struct: Vec<u32> = Vec::new();
	let mut vectors: Vec<u32> = Vec::new();
	let mut consts: HashMap<u32, u32> = HashMap::new();
	let mut located: HashMap<u32, u32> = HashMap::new();
	let mut member_decs: HashMap<(u32, u32), Vec<(u32, Vec<u32>)>> = HashMap::new();
	let mut builtin_structs: Vec<u32> = Vec::new();
	let mut array_len: Vec<(u32, u32, u32)> = Vec::new();
	let mut entry_fns: Vec<u32> = Vec::new();
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		match words[i] & 0xffff {
			OP_ENTRY_POINT => entry_fns.push(a[1]),
			OP_TYPE_POINTER => {
				pointers.insert(a[0], (a[1], a[2]));
			}
			OP_TYPE_VECTOR => vectors.push(a[0]),
			OP_TYPE_MATRIX => {
				composite.insert(a[0], vec![a[1]; a[2] as usize]);
			}
			OP_TYPE_STRUCT => {
				composite.insert(a[0], a[1..].to_vec());
				is_struct.push(a[0]);
			}
			OP_TYPE_ARRAY => array_len.push((a[0], a[1], a[2])),
			OP_CONSTANT if a.len() >= 3 => {
				consts.insert(a[1], a[2]);
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_LOCATION => {
				located.insert(a[0], a[2]);
			}
			OP_MEMBER_DECORATE if a.len() >= 3 => {
				if a[2] == DEC_BUILTIN {
					builtin_structs.push(a[0]);
				}
				member_decs.entry((a[0], a[1])).or_default().push((a[2], a[3..].to_vec()));
			}
			_ => {}
		}
		i += n;
	}
	for (arr, el, len) in array_len {
		if let Some(&n) = consts.get(&len) {
			composite.insert(arr, vec![el; n as usize]);
		}
	}
	let simple = |t: u32| vectors.contains(&t) || !composite.contains_key(&t) && !pointers.contains_key(&t);
	struct T {
		class: u32,
		elem_tys: Vec<u32>,
		elem_ptrs: Vec<u32>,
		elems: Vec<u32>,
		locs: Vec<u32>,
		decs: Vec<Vec<(u32, Vec<u32>)>>,
		shadow: Option<(u32, u32, u32)>, // (private var, its pointer type, composite type)
	}
	let mut targets: HashMap<u32, T> = HashMap::new();
	let mut ptr_for: HashMap<(u32, u32), u32> = HashMap::new();
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		if words[i] & 0xffff == OP_VARIABLE && (a[2] == SC_INPUT || a[2] == SC_OUTPUT) {
			if let Some(&loc) = located.get(&a[1]) {
				let comp = pointers.get(&a[0]).map(|p| p.1).unwrap_or(0);
				if let Some(tys) = composite.get(&comp) {
					if !builtin_structs.contains(&comp) && tys.iter().all(|&t| simple(t)) {
						let st = is_struct.contains(&comp);
						let mut locs = Vec::new();
						let mut decs = Vec::new();
						for k in 0..tys.len() as u32 {
							let md = if st { member_decs.get(&(comp, k)).cloned().unwrap_or_default() } else { Vec::new() };
							let own = md.iter().find(|d| d.0 == DEC_LOCATION).map(|d| d.1[0]);
							locs.push(own.unwrap_or(loc + k));
							decs.push(md.into_iter().filter(|d| INTERP.contains(&d.0)).collect());
						}
						let elem_ptrs = tys
							.iter()
							.map(|&t| {
								*ptr_for.entry((a[2], t)).or_insert_with(|| {
									bound += 1;
									bound - 1
								})
							})
							.collect();
						let elems: Vec<u32> = (0..tys.len() as u32).map(|k| bound + k).collect();
						bound += tys.len() as u32;
						targets.insert(a[1], T { class: a[2], elem_tys: tys.clone(), elem_ptrs, elems, locs, decs, shadow: None });
					}
				}
			}
		}
		i += n;
	}
	if targets.is_empty() {
		return Ok(words);
	}
	// Dynamic indexing -> shadow.
	let mut uint_ty = None;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		let o = words[i] & 0xffff;
		if (o == OP_ACCESS_CHAIN || o == OP_IN_BOUNDS_ACCESS_CHAIN) && n >= 5 && !consts.contains_key(&a[3]) {
			if let Some(t) = targets.get_mut(&a[2]) {
				if t.shadow.is_none() {
					let comp = composite.iter().find(|(_, v)| **v == t.elem_tys).map(|(k, _)| *k);
					let comp = pointers.values().find(|p| p.0 == t.class && Some(p.1) == comp).map(|p| p.1).or(comp).unwrap_or(0);
					t.shadow = Some((bound, bound + 1, comp));
					bound += 2;
				}
			}
		}
		if o == OP_TYPE_INT && a[1] == 32 && a[2] == 0 && uint_ty.is_none() {
			uint_ty = Some(a[0]);
		}
		i += n;
	}
	// The composite type of each shadowed variable, exactly: from its pointer.
	let mut var_comp: HashMap<u32, u32> = HashMap::new();
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		if words[i] & 0xffff == OP_VARIABLE && targets.contains_key(&words[i + 2]) {
			var_comp.insert(words[i + 2], pointers[&words[i + 1]].1);
		}
		i += n;
	}
	for (v, t) in targets.iter_mut() {
		if let Some(sh) = t.shadow.as_mut() {
			sh.2 = var_comp[v];
		}
	}
	let any_shadow = targets.values().any(|t| t.shadow.is_some());
	let uint = uint_ty.unwrap_or_else(|| {
		bound += 1;
		bound - 1
	});
	let max_n = targets.values().map(|t| t.elems.len()).max().unwrap_or(0) as u32;
	let idx_consts: Vec<u32> = (0..max_n).map(|k| bound + k).collect();
	bound += max_n;
	let mut priv_elem_ptr: HashMap<u32, u32> = HashMap::new();
	for t in targets.values() {
		if t.shadow.is_some() {
			for &ty in &t.elem_tys {
				priv_elem_ptr.entry(ty).or_insert_with(|| {
					bound += 1;
					bound - 1
				});
			}
		}
	}

	let mut alias: HashMap<u32, u32> = HashMap::new();
	let mut emitted_ptrs: Vec<u32> = Vec::new();
	let mut out: Vec<u32> = Vec::with_capacity(words.len() + 256);
	out.extend_from_slice(&words[..5]);
	let mut globals_done = false;
	let mut in_entry = false;
	let mut entry_started = false;
	let copy = |out: &mut Vec<u32>, bound: &mut u32, t: &T, input: bool| {
		let (pv, _, _) = t.shadow.unwrap();
		for (k, &e) in t.elems.iter().enumerate() {
			let ty = t.elem_tys[k];
			let (p, v) = (*bound, *bound + 1);
			*bound += 2;
			out.extend(inst(OP_ACCESS_CHAIN, &[priv_elem_ptr[&ty], p, pv, idx_consts[k]]));
			if input {
				out.extend(inst(OP_LOAD, &[ty, v, e]));
				out.extend(inst(OP_STORE, &[p, v]));
			} else {
				out.extend(inst(OP_LOAD, &[ty, v, p]));
				out.extend(inst(OP_STORE, &[e, v]));
			}
		}
	};
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let mut a = words[i + 1..i + n].to_vec();
		let pos: &[usize] = match o {
			OP_LOAD | OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN => &[2],
			OP_STORE => &[0],
			_ => &[],
		};
		for &p in pos {
			if let Some(&x) = alias.get(&a[p]) {
				a[p] = x;
			}
			if let Some(sh) = targets.get(&a[p]).and_then(|t| t.shadow) {
				a[p] = sh.0;
			}
		}
		if o == OP_FUNCTION {
			if !globals_done && any_shadow {
				out.extend(inst(OP_TYPE_INT, &[uint, 32, 0]).take(if uint_ty.is_some() { 0 } else { 4 }));
				for (k, &c) in idx_consts.iter().enumerate() {
					out.extend(inst(OP_CONSTANT, &[uint, c, k as u32]));
				}
				for (&ty, &p) in &priv_elem_ptr {
					out.extend(inst(OP_TYPE_POINTER, &[p, SC_PRIVATE, ty]));
				}
				for t in targets.values() {
					if let Some((pv, pp, comp)) = t.shadow {
						out.extend(inst(OP_TYPE_POINTER, &[pp, SC_PRIVATE, comp]));
						out.extend(inst(OP_VARIABLE, &[pp, pv, SC_PRIVATE]));
					}
				}
			}
			globals_done = true;
			in_entry = entry_fns.contains(&a[1]);
			entry_started = false;
		}
		if o == OP_FUNCTION_END {
			in_entry = false;
		}
		// Copy the inputs in after the entry block's OpVariables.
		if in_entry && !entry_started && o != OP_LABEL && o != OP_VARIABLE && o != OP_FUNCTION && o != 55 {
			entry_started = true;
			for t in targets.values() {
				if t.shadow.is_some() && t.class == SC_INPUT {
					copy(&mut out, &mut bound, t, true);
				}
			}
		}
		if in_entry && o == OP_RETURN {
			for t in targets.values() {
				if t.shadow.is_some() && t.class == SC_OUTPUT {
					copy(&mut out, &mut bound, t, false);
				}
			}
		}
		match o {
			OP_ENTRY_POINT => {
				let mut ops = Vec::new();
				for &x in &a {
					match targets.get(&x) {
						Some(t) => ops.extend(&t.elems),
						None => ops.push(x),
					}
				}
				out.extend(inst(o, &ops));
			}
			OP_NAME if targets.contains_key(&a[0]) => {
				let name = read_string(&a[1..]);
				for (k, &e) in targets[&a[0]].elems.iter().enumerate() {
					let mut ops = vec![e];
					ops.extend(string_words(&format!("{}_{}", name, k)));
					out.extend(inst(OP_NAME, &ops));
				}
			}
			OP_DECORATE if targets.contains_key(&a[0]) => {
				let t = &targets[&a[0]];
				for (k, &e) in t.elems.iter().enumerate() {
					let mut ops = a.clone();
					ops[0] = e;
					if a[1] == DEC_LOCATION {
						ops[2] = t.locs[k];
						out.extend(inst(OP_DECORATE, &ops));
						for (d, extra) in &t.decs[k] {
							if !words_has_decoration(&words, a[0], *d) {
								let mut ops = vec![e, *d];
								ops.extend(extra);
								out.extend(inst(OP_DECORATE, &ops));
							}
						}
						continue;
					}
					out.extend(inst(OP_DECORATE, &ops));
				}
			}
			OP_VARIABLE if targets.contains_key(&a[1]) => {
				let t = &targets[&a[1]];
				for (k, &e) in t.elems.iter().enumerate() {
					let p = t.elem_ptrs[k];
					if !emitted_ptrs.contains(&p) {
						emitted_ptrs.push(p);
						out.extend(inst(OP_TYPE_POINTER, &[p, t.class, t.elem_tys[k]]));
					}
					out.extend(inst(OP_VARIABLE, &[p, e, a[2]]));
				}
			}
			OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN if targets.contains_key(&a[2]) => {
				let t = &targets[&a[2]];
				let Some(e) = consts.get(&a[3]).and_then(|&c| t.elems.get(c as usize)).copied() else {
					return Err("dynamic index into an array varying".into());
				};
				if a.len() == 4 {
					alias.insert(a[1], e);
				} else {
					let mut ops = vec![a[0], a[1], e];
					ops.extend(&a[4..]);
					out.extend(inst(o, &ops));
				}
			}
			OP_LOAD if targets.contains_key(&a[2]) => {
				let t = &targets[&a[2]];
				let mut parts = Vec::new();
				for (k, &e) in t.elems.iter().enumerate() {
					out.extend(inst(OP_LOAD, &[t.elem_tys[k], bound, e]));
					parts.push(bound);
					bound += 1;
				}
				let mut ops = vec![a[0], a[1]];
				ops.extend(parts);
				out.extend(inst(OP_COMPOSITE_CONSTRUCT, &ops));
			}
			OP_STORE if targets.contains_key(&a[0]) => {
				let t = &targets[&a[0]];
				for (k, &e) in t.elems.iter().enumerate() {
					out.extend(inst(OP_COMPOSITE_EXTRACT, &[t.elem_tys[k], bound, a[1], k as u32]));
					out.extend(inst(OP_STORE, &[e, bound]));
					bound += 1;
				}
			}
			_ => out.extend(inst(o, &a)),
		}
		i += n;
	}
	out[3] = bound;
	Ok(out)
}

fn words_has_decoration(words: &[u32], id: u32, dec: u32) -> bool {
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		if words[i] & 0xffff == OP_DECORATE && n >= 3 && words[i + 1] == id && words[i + 2] == dec {
			return true;
		}
		i += n;
	}
	false
}

// Relaxed block layout (Vulkan 1.1; DXC's default for HLSL cbuffers):
// a vector may sit at an offset aligned only to its component (float2 at
// 4), which WGSL cannot express. Such a member is split into scalar
// members; access chains, extracts, loads and stores are remapped.
pub fn split_misaligned_vectors(words: Vec<u32>) -> Vec<u32> {
	const OP_MEMBER_NAME: u32 = 6;
	const OP_TYPE_INT: u32 = 21;
	const OP_TYPE_FLOAT: u32 = 22;
	const OP_TYPE_VECTOR: u32 = 23;
	const OP_CONSTANT: u32 = 43;
	const OP_FUNCTION: u32 = 54;
	const OP_STORE: u32 = 62;
	const OP_ACCESS_CHAIN: u32 = 65;
	const OP_IN_BOUNDS_ACCESS_CHAIN: u32 = 66;
	const OP_COMPOSITE_CONSTRUCT: u32 = 80;
	const OP_COMPOSITE_EXTRACT: u32 = 81;
	const DEC_OFFSET: u32 = 35;

	let mut vectors: HashMap<u32, (u32, u32)> = HashMap::new();
	let mut scalar32: Vec<u32> = Vec::new();
	let mut structs: HashMap<u32, Vec<u32>> = HashMap::new();
	let mut offsets: HashMap<(u32, u32), u32> = HashMap::new();
	let mut pointers: HashMap<u32, (u32, u32)> = HashMap::new();
	let mut consts: HashMap<u32, u32> = HashMap::new();
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		match words[i] & 0xffff {
			OP_TYPE_INT | OP_TYPE_FLOAT if a[1] == 32 => scalar32.push(a[0]),
			OP_TYPE_VECTOR => {
				vectors.insert(a[0], (a[1], a[2]));
			}
			OP_TYPE_STRUCT => {
				structs.insert(a[0], a[1..].to_vec());
			}
			OP_MEMBER_DECORATE if a.len() >= 4 && a[2] == DEC_OFFSET => {
				offsets.insert((a[0], a[1]), a[3]);
			}
			OP_TYPE_POINTER => {
				pointers.insert(a[0], (a[1], a[2]));
			}
			OP_CONSTANT if a.len() >= 3 => {
				consts.insert(a[1], a[2]);
			}
			_ => {}
		}
		i += n;
	}
	// struct -> per old member: (new index, Some((component type, count)) if split)
	let mut remap: HashMap<u32, Vec<(u32, Option<(u32, u32)>)>> = HashMap::new();
	for (&st, ms) in &structs {
		let mut map = Vec::new();
		let mut next = 0;
		let mut any = false;
		for (k, &m) in ms.iter().enumerate() {
			let split = match (vectors.get(&m), offsets.get(&(st, k as u32))) {
				(Some(&(c, cnt)), Some(&off)) if scalar32.contains(&c) => {
					let align = if cnt == 2 { 8 } else { 16 };
					if off % align != 0 { Some((c, cnt)) } else { None }
				}
				_ => None,
			};
			map.push((next, split));
			next += split.map(|s| s.1).unwrap_or(1);
			any |= split.is_some();
		}
		if any {
			remap.insert(st, map);
		}
	}
	if remap.is_empty() {
		return words;
	}
	let mut bound = words[3];
	let uint_ty = bound;
	bound += 1;
	let mut new_consts: HashMap<u32, u32> = HashMap::new(); // value -> id
	let mut cid = |v: u32, bound: &mut u32| -> u32 {
		*new_consts.entry(v).or_insert_with(|| {
			*bound += 1;
			*bound - 1
		})
	};
	// Pre-allocate the constants every remapped index may need.
	for map in remap.values() {
		for &(ni, sp) in map {
			for j in 0..sp.map(|s| s.1).unwrap_or(1) {
				cid(ni + j, &mut bound);
			}
		}
	}
	let mut ptr_ty: HashMap<u32, u32> = HashMap::new(); // id -> pointee type
	let mut val_ty: HashMap<u32, u32> = HashMap::new();
	// Pointers to a split vector: id -> (base pointer, first scalar index const, comp type, count, storage class)
	let mut split_ptrs: HashMap<u32, (u32, u32, u32, u32, u32)> = HashMap::new();
	let mut prefix: HashMap<u32, Vec<u32>> = HashMap::new(); // split pointer -> its chain up to the struct
	let mut scalar_ptr: HashMap<(u32, u32), u32> = HashMap::new(); // (class, comp) -> pointer type
	let mut out: Vec<u32> = Vec::with_capacity(words.len() + 128);
	out.extend_from_slice(&words[..5]);
	let mut extra_types: Vec<u32> = Vec::new();
	let mut first_fn_at = None;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let a = words[i + 1..i + n].to_vec();
		if o == OP_FUNCTION && first_fn_at.is_none() {
			first_fn_at = Some(out.len());
		}
		if o == OP_VARIABLE || o == 55 {
			if let Some(&(_, p)) = pointers.get(&a[0]) {
				ptr_ty.insert(a[1], p);
			}
		}
		match o {
			OP_TYPE_STRUCT if remap.contains_key(&a[0]) => {
				let mut ops = vec![a[0]];
				for (k, &m) in a[1..].iter().enumerate() {
					match remap[&a[0]][k].1 {
						Some((c, cnt)) => ops.extend(std::iter::repeat(c).take(cnt as usize)),
						None => ops.push(m),
					}
				}
				out.extend(inst(o, &ops));
			}
			OP_MEMBER_DECORATE | OP_MEMBER_NAME if remap.contains_key(&a[0]) => {
				let (ni, sp) = remap[&a[0]][a[1] as usize];
				let cnt = sp.map(|s| s.1).unwrap_or(1);
				for j in 0..cnt {
					let mut ops = a.clone();
					ops[1] = ni + j;
					if o == OP_MEMBER_DECORATE && a[2] == DEC_OFFSET {
						ops[3] = a[3] + 4 * j;
					}
					if o == OP_MEMBER_NAME && sp.is_some() {
						ops.truncate(2);
						ops.extend(string_words(&format!("{}_{}", read_string(&a[2..]), j)));
					}
					out.extend(inst(o, &ops));
				}
			}
			OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN => {
				let mut cur = ptr_ty.get(&a[2]).copied();
				let class = ptr_ty.get(&a[2]).and(pointers.get(&a[0]).map(|p| p.0)).unwrap_or(2);
				let mut ops = a[..3].to_vec();
				let mut q = 3;
				let mut split_end = None;
				while q < a.len() {
					let idx = a[q];
					let Some(c) = cur else {
						ops.push(idx);
						q += 1;
						continue;
					};
					if let (Some(map), Some(&k)) = (remap.get(&c), consts.get(&idx)) {
						let (ni, sp) = map[k as usize];
						match sp {
							Some((comp, cnt)) => {
								if let Some(&ci) = a.get(q + 1).and_then(|x| consts.get(x)) {
									ops.push(cid(ni + ci, &mut bound));
									cur = Some(comp);
									q += 2;
									continue;
								}
								split_end = Some((ni, comp, cnt));
								break;
							}
							None => {
								ops.push(cid(ni, &mut bound));
								cur = structs.get(&c).and_then(|ms| ms.get(k as usize)).copied();
							}
						}
					} else {
						ops.push(idx);
						cur = structs
							.get(&c)
							.and_then(|ms| consts.get(&idx).and_then(|&k| ms.get(k as usize)))
							.copied()
							.or_else(|| vectors.get(&c).map(|v| v.0));
					}
					q += 1;
				}
				if let Some((ni, comp, cnt)) = split_end {
					// Chain to the struct; loads/stores of the vector go per scalar.
					let base = bound;
					bound += 1;
					let sp_ty = *scalar_ptr.entry((class, comp)).or_insert_with(|| {
						bound += 1;
						extra_types.extend(inst(OP_TYPE_POINTER, &[bound - 1, class, comp]));
						bound - 1
					});
					// Each load/store of it chains to one scalar member.
					split_ptrs.insert(a[1], (base, ni, comp, cnt, sp_ty));
					prefix.insert(a[1], ops.clone());
				} else {
					if let Some(c) = cur {
						ptr_ty.insert(a[1], c);
					}
					out.extend(inst(o, &ops));
				}
			}
			OP_LOAD if split_ptrs.contains_key(&a[2]) => {
				let (_, ni, comp, cnt, sp_ty) = split_ptrs[&a[2]];
				let pre = prefix[&a[2]].clone();
				let mut parts = Vec::new();
				for j in 0..cnt {
					let (p, v) = (bound, bound + 1);
					bound += 2;
					let mut ch = vec![sp_ty, p];
					ch.extend(&pre[2..]);
					ch.push(cid(ni + j, &mut bound));
					out.extend(inst(OP_ACCESS_CHAIN, &ch));
					out.extend(inst(OP_LOAD, &[comp, v, p]));
					parts.push(v);
				}
				let mut ops = vec![a[0], a[1]];
				ops.extend(parts);
				out.extend(inst(OP_COMPOSITE_CONSTRUCT, &ops));
			}
			OP_STORE if split_ptrs.contains_key(&a[0]) => {
				let (_, ni, comp, cnt, sp_ty) = split_ptrs[&a[0]];
				let pre = prefix[&a[0]].clone();
				for j in 0..cnt {
					let (p, v) = (bound, bound + 1);
					bound += 2;
					let mut ch = vec![sp_ty, p];
					ch.extend(&pre[2..]);
					ch.push(cid(ni + j, &mut bound));
					out.extend(inst(OP_ACCESS_CHAIN, &ch));
					out.extend(inst(OP_COMPOSITE_EXTRACT, &[comp, v, a[1], j]));
					out.extend(inst(OP_STORE, &[p, v]));
				}
			}
			OP_LOAD => {
				if let Some(&t) = ptr_ty.get(&a[2]) {
					val_ty.insert(a[1], t);
				}
				out.extend(inst(o, &a));
			}
			OP_COMPOSITE_EXTRACT if a.len() >= 4 => {
				let mut cur = val_ty.get(&a[2]).copied();
				let mut ops = a[..3].to_vec();
				let mut q = 3;
				let mut whole = None;
				while q < a.len() {
					let lit = a[q];
					match cur.and_then(|c| remap.get(&c).map(|m| (c, m))) {
						Some((c, map)) => {
							let (ni, sp) = map[lit as usize];
							match sp {
								Some((comp, cnt)) => {
									if q + 1 < a.len() {
										ops.push(ni + a[q + 1]);
										cur = Some(comp);
										q += 2;
										continue;
									}
									whole = Some((ni, comp, cnt));
									break;
								}
								None => {
									ops.push(ni);
									cur = structs.get(&c).and_then(|ms| ms.get(lit as usize)).copied();
								}
							}
						}
						None => {
							ops.push(lit);
							cur = cur.and_then(|c| structs.get(&c).and_then(|ms| ms.get(lit as usize)).copied());
						}
					}
					q += 1;
				}
				if let Some((ni, comp, cnt)) = whole {
					let mut parts = Vec::new();
					for j in 0..cnt {
						let mut e = vec![comp, bound];
						e.extend(&ops[2..]);
						e.push(ni + j);
						out.extend(inst(OP_COMPOSITE_EXTRACT, &e));
						parts.push(bound);
						bound += 1;
					}
					let mut c = vec![a[0], a[1]];
					c.extend(parts);
					out.extend(inst(OP_COMPOSITE_CONSTRUCT, &c));
				} else {
					val_ty.insert(a[1], a[0]);
					out.extend(inst(o, &ops));
				}
			}
			_ => out.extend(inst(o, &a)),
		}
		i += n;
	}
	// Types and index constants before the first function.
	if let Some(at) = first_fn_at {
		let mut decl = Vec::new();
		decl.extend(inst(OP_TYPE_INT, &[uint_ty, 32, 0]));
		let mut cs: Vec<(u32, u32)> = new_consts.iter().map(|(&v, &id)| (v, id)).collect();
		cs.sort();
		for (v, id) in cs {
			decl.extend(inst(OP_CONSTANT, &[uint_ty, id, v]));
		}
		decl.extend(extra_types);
		out.splice(at..at, decl);
	}
	out[3] = bound;
	out
}

// OpUndef inside a function trips naga's spv-in ("Expression can't be
// introduced - it's already in scope", seen in GTK 4's shaders): each one
// becomes a module-level OpConstantNull of its type.
fn hoist_undefs(words: Vec<u32>) -> Vec<u32> {
	const OP_UNDEF: u32 = 1;
	const OP_FUNCTION: u32 = 54;
	const OP_CONSTANT_NULL: u32 = 46;
	let mut undefs: Vec<u32> = Vec::new();
	let mut first_fn = None;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		match words[i] & 0xffff {
			OP_FUNCTION if first_fn.is_none() => first_fn = Some(i),
			OP_UNDEF if first_fn.is_some() => undefs.extend([words[i + 1], words[i + 2]]),
			_ => {}
		}
		i += n;
	}
	if undefs.is_empty() {
		return words;
	}
	let mut out: Vec<u32> = Vec::with_capacity(words.len());
	out.extend_from_slice(&words[..5]);
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		if Some(i) == first_fn {
			for c in undefs.chunks(2) {
				out.extend(inst(OP_CONSTANT_NULL, c));
			}
		}
		if !(words[i] & 0xffff == OP_UNDEF && i > first_fn.unwrap_or(usize::MAX)) {
			out.extend_from_slice(&words[i..i + n]);
		}
		i += n;
	}
	out
}

// Dual-source blending (`layout(location = 0, index = 1) out`): WGSL needs
// @blend_src on both outputs, so the other location-0 output gets Index 0.
fn dual_source_index(words: Vec<u32>) -> Vec<u32> {
	const DEC_INDEX: u32 = 32;
	let mut indexed: Vec<u32> = Vec::new();
	let mut loc0: Vec<u32> = Vec::new();
	let mut outputs: Vec<u32> = Vec::new();
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		if words[i] & 0xffff == OP_DECORATE && n >= 4 {
			match (words[i + 2], words[i + 3]) {
				(DEC_INDEX, _) => indexed.push(words[i + 1]),
				(DEC_LOCATION, 0) => loc0.push(words[i + 1]),
				_ => {}
			}
		}
		if words[i] & 0xffff == OP_VARIABLE && n >= 4 && words[i + 3] == 3 {
			outputs.push(words[i + 2]);
		}
		i += n;
	}
	if indexed.is_empty() {
		return words;
	}
	let mut extra = Vec::new();
	for v in loc0 {
		if !indexed.contains(&v) && outputs.contains(&v) {
			extra.extend(inst(OP_DECORATE, &[v, DEC_INDEX, 0]));
		}
	}
	let mut out = words;
	let mut i = 5;
	while i < out.len() {
		let n = (out[i] >> 16) as usize;
		if out[i] & 0xffff == OP_DECORATE {
			out.splice(i..i, extra);
			break;
		}
		i += n;
	}
	out
}

// gl_SampleMask and gl_SampleMaskIn (vkQuake's MSAA SSAO composite):
// SPIR-V's are int[1] (or uint[1]), naga's a u32 (it writes the output's
// default as a u32 into the array, "Initializer doesn't match the variable
// type", and refuses an array input). Each becomes a u32 variable: access
// chains to its element go, stores of an int are bitcast, loads bitcast
// back. A mask wider than one word is left to naga (WebGPU has at most 32
// samples).
pub fn output_sample_mask(words: Vec<u32>) -> Vec<u32> {
	const OP_TYPE_INT: u32 = 21;
	const OP_TYPE_ARRAY: u32 = 28;
	const OP_CONSTANT: u32 = 43;
	const OP_FUNCTION: u32 = 54;
	const OP_STORE: u32 = 62;
	const OP_ACCESS_CHAIN: u32 = 65;
	const OP_IN_BOUNDS_ACCESS_CHAIN: u32 = 66;
	const OP_BITCAST: u32 = 124;
	const BI_SAMPLE_MASK: u32 = 20;
	const SC_INPUT: u32 = 1;
	let mut mask_vars = Vec::new();
	let mut ints: HashMap<u32, bool> = HashMap::new();
	let mut arrays: HashMap<u32, (u32, u32)> = HashMap::new(); // array type -> (element, length id)
	let mut pointers: HashMap<u32, u32> = HashMap::new();
	let mut consts: HashMap<u32, u32> = HashMap::new();
	let mut vars: HashMap<u32, (u32, u32)> = HashMap::new(); // Input/Output variable -> (pointer type, class)
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		match words[i] & 0xffff {
			OP_FUNCTION => break,
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_BUILTIN && a[2] == BI_SAMPLE_MASK => mask_vars.push(a[0]),
			OP_TYPE_INT if a.len() >= 3 && a[1] == 32 => {
				ints.insert(a[0], a[2] != 0);
			}
			OP_TYPE_ARRAY if a.len() >= 3 => {
				arrays.insert(a[0], (a[1], a[2]));
			}
			OP_TYPE_POINTER if a.len() >= 3 => {
				pointers.insert(a[0], a[2]);
			}
			OP_CONSTANT if a.len() == 3 => {
				consts.insert(a[1], a[2]);
			}
			OP_VARIABLE if a.len() >= 3 && (a[2] == SC_OUTPUT || a[2] == SC_INPUT) => {
				vars.insert(a[1], (a[0], a[2]));
			}
			_ => {}
		}
		i += n;
	}
	// The variables (arrays of one 32-bit integer): their class, element
	// type and whether that is signed.
	let mut masks: HashMap<u32, (u32, u32, bool)> = mask_vars
		.iter()
		.filter_map(|&v| {
			let &(p, class) = vars.get(&v)?;
			let &(e, len) = arrays.get(pointers.get(&p)?)?;
			(consts.get(&len) == Some(&1)).then_some(())?;
			Some((v, (class, e, *ints.get(&e)?)))
		})
		.collect();
	// Every use in a function must be an access chain to the element.
	let mut i = 5;
	let mut in_fn = false;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let a = &words[i + 1..i + n];
		in_fn |= o == OP_FUNCTION;
		if in_fn {
			let chain = matches!(o, OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN) && a.len() == 4;
			masks.retain(|v, _| !a.contains(v) || (chain && a[2] == *v));
		}
		i += n;
	}
	if masks.is_empty() {
		return words;
	}
	let mut bound = words[3];
	let uint = bound;
	bound += 1;
	let mut uint_declared = false;
	let mut alias: HashMap<u32, u32> = HashMap::new(); // element pointer -> variable
	let mut out: Vec<u32> = Vec::with_capacity(words.len() + 16);
	out.extend_from_slice(&words[..5]);
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let a = &words[i + 1..i + n];
		match o {
			OP_VARIABLE if a.len() >= 3 && masks.contains_key(&a[1]) => {
				if !uint_declared {
					uint_declared = true;
					out.extend(inst(OP_TYPE_INT, &[uint, 32, 0]));
				}
				let ptr = bound;
				bound += 1;
				out.extend(inst(OP_TYPE_POINTER, &[ptr, a[2], uint]));
				out.extend(inst(OP_VARIABLE, &[ptr, a[1], a[2]]));
			}
			// The only element (any other index is out of bounds).
			OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN if a.len() == 4 && masks.contains_key(&a[2]) => {
				alias.insert(a[1], a[2]);
			}
			OP_STORE if a.len() >= 2 && alias.contains_key(&a[0]) => {
				let var = alias[&a[0]];
				let mut v = a[1];
				if masks[&var].2 {
					v = bound;
					bound += 1;
					out.extend(inst(OP_BITCAST, &[uint, v, a[1]]));
				}
				out.extend(inst(OP_STORE, &[var, v]));
			}
			OP_LOAD if a.len() >= 3 && alias.contains_key(&a[2]) => {
				let var = alias[&a[2]];
				let (_, elem, signed) = masks[&var];
				if signed {
					out.extend(inst(OP_LOAD, &[uint, bound, var]));
					out.extend(inst(OP_BITCAST, &[elem, a[1], bound]));
					bound += 1;
				} else {
					out.extend(inst(OP_LOAD, &[uint, a[1], var]));
				}
			}
			_ => out.extend_from_slice(&words[i..i + n]),
		}
		i += n;
	}
	out[3] = bound;
	out
}

// OpIsInf and OpIsNan on 32-bit floats (vkQuake's wboit_resolve and
// mboit): WGSL has neither, naga's writer refuses them. The bits instead:
// |x| == 0x7f800000 (inf), |x| > 0x7f800000 (NaN), on a bitcast to u32
// (vectors component-wise). Other widths are left to naga.
pub fn lower_isinf_isnan(words: Vec<u32>) -> Vec<u32> {
	const OP_TYPE_INT: u32 = 21;
	const OP_TYPE_FLOAT: u32 = 22;
	const OP_TYPE_VECTOR: u32 = 23;
	const OP_CONSTANT: u32 = 43;
	const OP_CONSTANT_COMPOSITE: u32 = 44;
	const OP_FUNCTION: u32 = 54;
	const OP_BITCAST: u32 = 124;
	const OP_IS_NAN: u32 = 156;
	const OP_IS_INF: u32 = 157;
	const OP_IEQUAL: u32 = 170;
	const OP_UGREATER_THAN: u32 = 172;
	const OP_BITWISE_AND: u32 = 199;
	let (mut f32s, mut vectors, mut val_ty) = (Vec::new(), HashMap::<u32, (u32, u32)>::new(), HashMap::<u32, u32>::new());
	let mut any = false;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let a = &words[i + 1..i + n];
		match o {
			OP_TYPE_FLOAT if a.len() >= 2 && a[1] == 32 => f32s.push(a[0]),
			OP_TYPE_VECTOR if a.len() >= 3 => {
				vectors.insert(a[0], (a[1], a[2]));
			}
			OP_IS_NAN | OP_IS_INF => any = true,
			_ => {}
		}
		// Result-typed instructions: (type, id) first.
		if n >= 3 && !(19..=39).contains(&o) && !matches!(o, 5 | 6 | 7 | 10 | 11 | 15 | 16 | 17 | 71 | 72 | 331 | 332) {
			val_ty.insert(a[1], a[0]);
		}
		i += n;
	}
	if !any {
		return words;
	}
	// The float operand's component count, when it is f32 or vecN<f32>.
	let count = |x: u32| -> Option<u32> {
		let t = *val_ty.get(&x)?;
		if f32s.contains(&t) {
			return Some(1);
		}
		let &(c, k) = vectors.get(&t)?;
		f32s.contains(&c).then_some(k)
	};
	let mut bound = words[3];
	let mut id = || {
		bound += 1;
		bound - 1
	};
	let (uint, abs_mask, inf) = (id(), id(), id());
	// uvecN and its two constants, per component count used.
	let mut vec_ids: HashMap<u32, (u32, u32, u32)> = HashMap::new();
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let a = &words[i + 1..i + n];
		if (o == OP_IS_NAN || o == OP_IS_INF) && a.len() == 3 {
			if let Some(k) = count(a[2]).filter(|&k| k > 1) {
				vec_ids.entry(k).or_insert_with(|| (id(), id(), id()));
			}
		}
		i += n;
	}
	let mut out: Vec<u32> = Vec::with_capacity(words.len() + 64);
	out.extend_from_slice(&words[..5]);
	let mut first_fn = true;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let a = &words[i + 1..i + n];
		match o {
			OP_FUNCTION if first_fn => {
				first_fn = false;
				out.extend(inst(OP_TYPE_INT, &[uint, 32, 0]));
				out.extend(inst(OP_CONSTANT, &[uint, abs_mask, 0x7fff_ffff]));
				out.extend(inst(OP_CONSTANT, &[uint, inf, 0x7f80_0000]));
				let mut vs: Vec<_> = vec_ids.iter().map(|(&k, &v)| (k, v)).collect();
				vs.sort();
				for (k, (t, m, f)) in vs {
					out.extend(inst(OP_TYPE_VECTOR, &[t, uint, k]));
					let mut c = vec![t, m];
					c.extend(std::iter::repeat(abs_mask).take(k as usize));
					out.extend(inst(OP_CONSTANT_COMPOSITE, &c));
					let mut c = vec![t, f];
					c.extend(std::iter::repeat(inf).take(k as usize));
					out.extend(inst(OP_CONSTANT_COMPOSITE, &c));
				}
				out.extend_from_slice(&words[i..i + n]);
			}
			OP_IS_NAN | OP_IS_INF if a.len() == 3 && count(a[2]).is_some() => {
				let k = count(a[2]).unwrap();
				let (t, m, f) = if k == 1 { (uint, abs_mask, inf) } else { vec_ids[&k] };
				let (bits, abs) = (bound, bound + 1);
				bound += 2;
				out.extend(inst(OP_BITCAST, &[t, bits, a[2]]));
				out.extend(inst(OP_BITWISE_AND, &[t, abs, bits, m]));
				out.extend(inst(if o == OP_IS_INF { OP_IEQUAL } else { OP_UGREATER_THAN }, &[a[0], a[1], abs, f]));
			}
			_ => out.extend_from_slice(&words[i..i + n]),
		}
		i += n;
	}
	out[3] = bound;
	out
}

// OpUMulExtended (llama.cpp's fastdiv: umulExtended), which naga lacks:
// the low word is a*b, the high word from 16-bit partial products.
// Scalar 32-bit operands only. Also +-inf float constants (naga rejects
// infinite literals; shaders use them as max/min seeds): +-3.4028233e38
// (FLT_MAX itself prints as a decimal Tint finds out of range, so it
// gets the same treatment).
pub fn lower_umul_extended(words: Vec<u32>) -> Vec<u32> {
	const OP_TYPE_INT: u32 = 21;
	const OP_TYPE_FLOAT: u32 = 22;
	const OP_CONSTANT: u32 = 43;
	const OP_FUNCTION: u32 = 54;
	const OP_COMPOSITE_CONSTRUCT: u32 = 80;
	const OP_IADD: u32 = 128;
	const OP_IMUL: u32 = 132;
	const OP_SHIFT_RIGHT_LOGICAL: u32 = 194;
	const OP_BITWISE_AND: u32 = 199;
	const OP_UMUL_EXTENDED: u32 = 151;
	let mut structs: HashMap<u32, Vec<u32>> = HashMap::new();
	let mut f32s: Vec<u32> = Vec::new();
	let mut any = false;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		match words[i] & 0xffff {
			OP_TYPE_STRUCT => {
				structs.insert(a[0], a[1..].to_vec());
			}
			OP_TYPE_FLOAT if a[1] == 32 => f32s.push(a[0]),
			OP_UMUL_EXTENDED => any = true,
			OP_CONSTANT if a.len() == 3 && f32s.contains(&a[0]) && matches!(a[2] & 0x7fff_ffff, 0x7f80_0000 | 0x7f7f_ffff) => any = true,
			_ => {}
		}
		i += n;
	}
	if !any {
		return words;
	}
	let mut bound = words[3];
	let (uint, c16, cffff) = (bound, bound + 1, bound + 2);
	bound += 3;
	let mut out: Vec<u32> = Vec::with_capacity(words.len() + 64);
	out.extend_from_slice(&words[..5]);
	let mut first_fn = true;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		match words[i] & 0xffff {
			OP_FUNCTION if first_fn => {
				first_fn = false;
				out.extend(inst(OP_TYPE_INT, &[uint, 32, 0]));
				out.extend(inst(OP_CONSTANT, &[uint, c16, 16]));
				out.extend(inst(OP_CONSTANT, &[uint, cffff, 0xffff]));
				out.extend_from_slice(&words[i..i + n]);
			}
			OP_CONSTANT if a.len() == 3 && f32s.contains(&a[0]) && matches!(a[2] & 0x7fff_ffff, 0x7f80_0000 | 0x7f7f_ffff) => {
				out.extend(inst(OP_CONSTANT, &[a[0], a[1], (a[2] & 0x8000_0000) | 0x7f7f_fffe]));
			}
			OP_UMUL_EXTENDED if structs.get(&a[0]).map_or(false, |m| m.len() == 2) => {
				let t = structs[&a[0]][0];
				let (x, y) = (a[2], a[3]);
				let mut id = || {
					bound += 1;
					bound - 1
				};
				let mut op = |out: &mut Vec<u32>, o: u32, p: u32, q: u32| -> u32 {
					let r = id();
					out.extend(inst(o, &[t, r, p, q]));
					r
				};
				let lo = op(&mut out, OP_IMUL, x, y);
				let xl = op(&mut out, OP_BITWISE_AND, x, cffff);
				let xh = op(&mut out, OP_SHIFT_RIGHT_LOGICAL, x, c16);
				let yl = op(&mut out, OP_BITWISE_AND, y, cffff);
				let yh = op(&mut out, OP_SHIFT_RIGHT_LOGICAL, y, c16);
				let p0 = op(&mut out, OP_IMUL, xl, yl);
				let p1 = op(&mut out, OP_IMUL, xl, yh);
				let p2 = op(&mut out, OP_IMUL, xh, yl);
				let p3 = op(&mut out, OP_IMUL, xh, yh);
				let p0h = op(&mut out, OP_SHIFT_RIGHT_LOGICAL, p0, c16);
				let p1l = op(&mut out, OP_BITWISE_AND, p1, cffff);
				let p2l = op(&mut out, OP_BITWISE_AND, p2, cffff);
				let m1 = op(&mut out, OP_IADD, p0h, p1l);
				let mid = op(&mut out, OP_IADD, m1, p2l);
				let p1h = op(&mut out, OP_SHIFT_RIGHT_LOGICAL, p1, c16);
				let p2h = op(&mut out, OP_SHIFT_RIGHT_LOGICAL, p2, c16);
				let midh = op(&mut out, OP_SHIFT_RIGHT_LOGICAL, mid, c16);
				let h1 = op(&mut out, OP_IADD, p3, p1h);
				let h2 = op(&mut out, OP_IADD, h1, p2h);
				let hi = op(&mut out, OP_IADD, h2, midh);
				out.extend(inst(OP_COMPOSITE_CONSTRUCT, &[a[0], a[1], lo, hi]));
			}
			_ => out.extend_from_slice(&words[i..i + n]),
		}
		i += n;
	}
	out[3] = bound;
	out
}

// One storage buffer bound through several views (llama.cpp: data_a as
// float16_t[] and f16vec2[], data_b as float[] and vec4[]): WGSL allows one
// variable per binding. When a binding has a scalar view
// `{ T x[]; }` and vector views `{ vecN<T> x[]; }`, the vector views go
// through the scalar one: element i of a vector view is scalars
// i*N .. i*N+N-1 (loads build the vector, stores scatter it).
pub fn merge_aliased_buffers(words: Vec<u32>) -> Vec<u32> {
	const OP_TYPE_INT: u32 = 21;
	const OP_TYPE_VECTOR: u32 = 23;
	const OP_TYPE_RUNTIME_ARRAY: u32 = 29;
	const OP_CONSTANT: u32 = 43;
	const OP_FUNCTION: u32 = 54;
	const OP_STORE: u32 = 62;
	const OP_ACCESS_CHAIN: u32 = 65;
	const OP_IN_BOUNDS_ACCESS_CHAIN: u32 = 66;
	const OP_COMPOSITE_CONSTRUCT: u32 = 80;
	const OP_COMPOSITE_EXTRACT: u32 = 81;
	const OP_IADD: u32 = 128;
	const OP_IMUL: u32 = 132;
	const SC_STORAGE_BUFFER: u32 = 12;
	const SC_UNIFORM: u32 = 2;

	let mut pointers: HashMap<u32, (u32, u32)> = HashMap::new();
	let mut structs: HashMap<u32, Vec<u32>> = HashMap::new();
	let mut rarr: HashMap<u32, u32> = HashMap::new();
	let mut vectors: HashMap<u32, (u32, u32)> = HashMap::new();
	let mut binding: HashMap<u32, u32> = HashMap::new();
	let mut set: HashMap<u32, u32> = HashMap::new();
	let mut vars: Vec<(u32, u32, u32)> = Vec::new(); // (var, pointer type, class)
	let mut int_types: HashMap<u32, u32> = HashMap::new(); // int type -> signedness
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		match words[i] & 0xffff {
			OP_TYPE_POINTER => {
				pointers.insert(a[0], (a[1], a[2]));
			}
			OP_TYPE_STRUCT => {
				structs.insert(a[0], a[1..].to_vec());
			}
			OP_TYPE_RUNTIME_ARRAY => {
				rarr.insert(a[0], a[1]);
			}
			OP_TYPE_VECTOR => {
				vectors.insert(a[0], (a[1], a[2]));
			}
			OP_TYPE_INT if a[1] == 32 => {
				int_types.insert(a[0], a[2]);
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_BINDING => {
				binding.insert(a[0], a[2]);
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_DESCRIPTOR_SET => {
				set.insert(a[0], a[2]);
			}
			OP_VARIABLE if a[2] == SC_STORAGE_BUFFER || a[2] == SC_UNIFORM => vars.push((a[1], a[0], a[2])),
			_ => {}
		}
		i += n;
	}
	// The element type of a `{ X[] }` buffer variable.
	let elem = |ptr: u32| -> Option<u32> {
		let st = pointers.get(&ptr)?.1;
		let m = structs.get(&st)?;
		if m.len() != 1 {
			return None;
		}
		rarr.get(&m[0]).copied()
	};
	// vector view var -> (scalar var, scalar pointer type, component type, N)
	let mut redirect: HashMap<u32, (u32, u32, u32, u32)> = HashMap::new();
	let mut scalar_ptr_types: HashMap<(u32, u32), u32> = HashMap::new();
	let mut bound = words[3];
	for &(v, p, class) in &vars {
		let Some(e) = elem(p) else { continue };
		let Some(&(comp, cnt)) = vectors.get(&e) else { continue };
		let slot = (set.get(&v).copied().unwrap_or(0), binding.get(&v));
		let Some(&(s, _, _)) = vars.iter().find(|&&(w, q, _)| w != v && (set.get(&w).copied().unwrap_or(0), binding.get(&w)) == slot && elem(q) == Some(comp)) else { continue };
		let sp = *scalar_ptr_types.entry((class, comp)).or_insert_with(|| {
			bound += 1;
			bound - 1
		});
		redirect.insert(v, (s, sp, comp, cnt));
	}
	if redirect.is_empty() {
		return words;
	}
	let uint = bound;
	bound += 1;
	let c0 = bound;
	bound += 1;
	let mut uconsts: HashMap<u32, u32> = HashMap::new();
	for &(_, _, _, cnt) in redirect.values() {
		for k in 0..=cnt {
			uconsts.entry(k).or_insert_with(|| {
				bound += 1;
				bound - 1
			});
		}
	}
	// Pointers into a vector view: id -> (scalar var, scalar ptr type, comp, N, element index id, component or none)
	let mut vptr: HashMap<u32, (u32, u32, u32, u32, u32)> = HashMap::new();
	let mut out: Vec<u32> = Vec::with_capacity(words.len() + 256);
	out.extend_from_slice(&words[..5]);
	let mut first_fn = true;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let a = &words[i + 1..i + n];
		match o {
			OP_FUNCTION if first_fn => {
				first_fn = false;
				out.extend(inst(OP_TYPE_INT, &[uint, 32, 0]));
				out.extend(inst(OP_CONSTANT, &[uint, c0, 0]));
				let mut cs: Vec<(u32, u32)> = uconsts.iter().map(|(&v, &id)| (v, id)).collect();
				cs.sort();
				for (v, id) in cs {
					out.extend(inst(OP_CONSTANT, &[uint, id, v]));
				}
				for (&(class, comp), &p) in &scalar_ptr_types {
					out.extend(inst(OP_TYPE_POINTER, &[p, class, comp]));
				}
				out.extend_from_slice(&words[i..i + n]);
			}
			// The vector views themselves disappear (with their decorations).
			OP_VARIABLE if redirect.contains_key(&a[1]) => {}
			OP_DECORATE | OP_NAME if redirect.contains_key(&a[0]) => {}
			OP_ENTRY_POINT => {
				let ops: Vec<u32> = a.iter().copied().filter(|x| !redirect.contains_key(x)).collect();
				out.extend(inst(o, &ops));
			}
			OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN if redirect.contains_key(&a[2]) && a.len() >= 5 => {
				let (s, sp, comp, cnt) = redirect[&a[2]];
				// a[3] is the struct member (0), a[4] the element index.
				let idx = a[4];
				// Convert the index to uint and scale: idx * N.
				let iu = bound;
				bound += 1;
				out.extend(inst(124, &[uint, iu, idx])); // OpBitcast to uint
				let base = bound;
				bound += 1;
				let ncon = uconsts[&cnt];
				out.extend(inst(OP_IMUL, &[uint, base, iu, ncon]));
				if a.len() >= 6 {
					// A component: the scalar element directly.
					let cidx = *a.get(5).unwrap();
					let ci = bound;
					bound += 1;
					out.extend(inst(124, &[uint, ci, cidx]));
					let e = bound;
					bound += 1;
					out.extend(inst(OP_IADD, &[uint, e, base, ci]));
					out.extend(inst(o, &[a[0], a[1], s, c0, e]));
				} else {
					vptr.insert(a[1], (s, sp, comp, cnt, base));
				}
			}
			OP_LOAD if vptr.contains_key(&a[2]) => {
				let (s, sp, comp, cnt, base) = vptr[&a[2]];
				let mut parts = Vec::new();
				for k in 0..cnt {
					let (e, p, v) = (bound, bound + 1, bound + 2);
					bound += 3;
					let kc = uconsts[&k];
					out.extend(inst(OP_IADD, &[uint, e, base, kc]));
					out.extend(inst(OP_ACCESS_CHAIN, &[sp, p, s, c0, e]));
					out.extend(inst(OP_LOAD, &[comp, v, p]));
					parts.push(v);
				}
				let mut ops = vec![a[0], a[1]];
				ops.extend(parts);
				out.extend(inst(OP_COMPOSITE_CONSTRUCT, &ops));
			}
			OP_STORE if vptr.contains_key(&a[0]) => {
				let (s, sp, comp, cnt, base) = vptr[&a[0]];
				for k in 0..cnt {
					let (e, p, v) = (bound, bound + 1, bound + 2);
					bound += 3;
					let kc = uconsts[&k];
					out.extend(inst(OP_IADD, &[uint, e, base, kc]));
					out.extend(inst(OP_ACCESS_CHAIN, &[sp, p, s, c0, e]));
					out.extend(inst(OP_COMPOSITE_EXTRACT, &[comp, v, a[1], k]));
					out.extend(inst(OP_STORE, &[p, v]));
				}
			}
			_ => out.extend_from_slice(&words[i..i + n]),
		}
		i += n;
	}
	let _ = int_types;
	out[3] = bound;
	out
}

pub fn read_string_pub(w: &[u32]) -> String {
	read_string(w)
}

pub fn string_words_pub(s: &str) -> Vec<u32> {
	string_words(s)
}

// naga's spv-in panics ("Emitting has already started"/unwrap in
// Emitter::finish) when a subgroup operation's value comes from another
// block (llama.cpp's cumsum, rms_norm_partials, ssm_scan...). A local
// OpCopyObject of the value right before the operation keeps it in-block.
// The same for the value of OpAtomicIAdd and the other atomics spv-in
// reads with one value (it looks that operand up without spilling it, so
// a value from a loop header used after the loop is out of scope: "Used by
// a statement before it was introduced", llama.cpp's count_experts).
pub fn localize_subgroup_operands(words: Vec<u32>) -> Vec<u32> {
	let atomic_value = |o: u32| o == 229 || (234..=242).contains(&o) || o == 6035;
	let mut val_ty: HashMap<u32, u32> = HashMap::new();
	let mut any = false;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		if n >= 3 && !(19..=39).contains(&o) && !matches!(o, 5 | 6 | 71 | 72 | 15 | 16 | 17 | 10 | 11) {
			val_ty.insert(words[i + 2], words[i + 1]);
		}
		if (333..=366).contains(&o) || atomic_value(o) {
			any = true;
		}
		i += n;
	}
	if !any {
		return words;
	}
	let mut bound = words[3];
	let mut out: Vec<u32> = Vec::with_capacity(words.len() + 64);
	out.extend_from_slice(&words[..5]);
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		if ((333..=366).contains(&o) && n >= 5) || (atomic_value(o) && n == 7) {
			let mut a = words[i + 1..i + n].to_vec();
			let vi = if atomic_value(o) { 5 } else if (349..=364).contains(&o) || o == 342 { 4 } else { 3 };
			if vi < a.len() {
				if let Some(&t) = val_ty.get(&a[vi]) {
					out.extend(inst(83, &[t, bound, a[vi]]));
					a[vi] = bound;
					bound += 1;
				}
			}
			out.extend(inst(o, &a));
		} else {
			out.extend_from_slice(&words[i..i + n]);
		}
		i += n;
	}
	out[3] = bound;
	out
}

// Memory operands on OpLoad/OpStore (Aligned, Volatile, NonPrivate...;
// llama.cpp's argsort_large) are not parsed by naga's spv-in: dropped.
pub fn strip_memory_operands(words: Vec<u32>) -> Vec<u32> {
	let mut out: Vec<u32> = Vec::with_capacity(words.len());
	out.extend_from_slice(&words[..5]);
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let keep = match o {
			61 if n > 4 => 4,
			62 if n > 3 => 3,
			_ => n,
		};
		out.push(((keep as u32) << 16) | o);
		out.extend_from_slice(&words[i + 1..i + keep]);
		i += n;
	}
	out
}

#[cfg(test)]
mod tests {
	// fold_spec_ops' half conversions: exact on every half, round to
	// nearest even from single precision.
	#[test]
	fn half_conversions() {
		for h in 0..=u16::MAX {
			let f = super::f16_to_f32(h);
			if f.is_nan() {
				assert!(super::f32_to_f16(f) & 0x7fff > 0x7c00, "{:04x}", h);
			} else {
				assert_eq!(super::f32_to_f16(f), h, "{:04x} {}", h, f);
			}
		}
		assert_eq!(super::f32_to_f16(1.0 + 1.0 / 2048.0), 0x3c00); // tie: even
		assert_eq!(super::f32_to_f16(1.0 + 3.0 / 2048.0), 0x3c02);
		assert_eq!(super::f32_to_f16(65520.0), 0x7c00); // rounds to inf
		assert_eq!(super::f32_to_f16(5.9604645e-8), 0x0001);
		assert_eq!(super::f32_to_f16(2.9802322e-8), 0x0000); // tie with 0: even
		assert_eq!(super::f32_to_f16(1e-10), 0x0000);
	}
}
