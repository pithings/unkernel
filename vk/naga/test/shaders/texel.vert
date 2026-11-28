#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A vertex stage fetching its positions from a uniform texel buffer.
layout(set = 0, binding = 0) uniform samplerBuffer pos;
layout(location = 0) out vec2 uv;
void main() {
	vec4 p = texelFetch(pos, gl_VertexIndex);
	uv = p.zw;
	gl_Position = vec4(p.xy, 0.0, 1.0);
}
