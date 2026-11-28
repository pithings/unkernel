#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A vertex stage writing a storage texel buffer: refused (WebGPU has no
// writable storage in vertex shaders).
layout(set = 0, binding = 0, r32f) uniform writeonly imageBuffer trace;
void main() {
	imageStore(trace, gl_VertexIndex, vec4(1.0));
	gl_Position = vec4(0.0);
}
