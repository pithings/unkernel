#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Declared but unused resources (GZDoom's texture12 at a binding its set
// layouts lack): only what main reaches is reflected and in the WGSL, not
// a never-sampled texture, a block only a never-called function reads, or
// a texture only a branch on a false specialization constant samples.
layout(constant_id = 0) const bool USE_DETAIL = false;
layout(set = 0, binding = 0) uniform sampler2D albedo;
layout(set = 0, binding = 1) uniform sampler2D detail;
layout(set = 2, binding = 11) uniform sampler2D texture12;
layout(set = 1, binding = 0) uniform Unused { vec4 tint; } unused;
layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 o;
vec4 never() { return unused.tint; }
void main() {
	o = texture(albedo, uv);
	if (USE_DETAIL) o *= texture(detail, uv);
}
