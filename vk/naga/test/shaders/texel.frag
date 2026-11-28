#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A fragment stage reading a texel buffer made from a textureBuffer and a
// sampler, and an integer one, and writing a storage texel buffer.
layout(set = 0, binding = 1) uniform textureBuffer lut;
layout(set = 0, binding = 2) uniform sampler smp;
layout(set = 0, binding = 3) uniform usamplerBuffer ids;
layout(set = 0, binding = 4, r32f) uniform writeonly imageBuffer trace;
layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 color;
void main() {
	int i = int(uv.x * float(textureSize(samplerBuffer(lut, smp))));
	color = texelFetch(samplerBuffer(lut, smp), i) * float(texelFetch(ids, i).x);
	imageStore(trace, int(gl_FragCoord.x), vec4(uv.y));
}
