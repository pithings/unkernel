#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// isinf and isnan (vkQuake's wboit_resolve and mboit), which WGSL lacks:
// tests on the bits.
layout(set = 0, binding = 0) uniform sampler2D accum;
layout(location = 0) out vec4 o;
void main() {
	vec4 a = texelFetch(accum, ivec2(gl_FragCoord.xy), 0);
	if (isinf(max(abs(a.r), abs(a.g)))) a.rgb = vec3(a.a);
	bvec2 n = isnan(a.ba);
	o = vec4(a.rgb, any(n) ? 0.0 : 1.0);
}
