#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Compiled with debug info (-g, as Taisei compiles its shaders): OpLine
// among the types and globals, which naga refuses; the translator drops
// OpLine and OpNoLine.
struct Light { vec4 color; vec2 dir; };
layout(set = 0, binding = 0) uniform Lights { Light lights[4]; };
layout(set = 0, binding = 1) uniform sampler2D tex;
layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 o;
const float gain = 1.5;
void main() {
	vec4 c = vec4(0.0);
	for (int i = 0; i < 4; i++) c += lights[i].color * max(dot(lights[i].dir, uv), 0.0);
	o = c * texture(tex, uv) * gain;
}
