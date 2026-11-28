#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A vertex shader reading plain `buffer` blocks (no `readonly`), as
// GZDoom's bones: never written, so read-only (WebGPU refuses read_write
// storage in a vertex stage).
layout(std430, set = 0, binding = 0) buffer Bones { mat4 bones[]; };
layout(std430, set = 0, binding = 1) buffer Weights { vec4 w[]; } weights;
layout(location = 0) in vec3 pos;
layout(location = 1) in uvec4 idx;
void main() {
	uint n = uint(bones.length());
	mat4 m = bones[idx.x % n] * weights.w[gl_VertexIndex].x + bones[idx.y % n] * weights.w[gl_VertexIndex].y;
	gl_Position = m * vec4(pos, 1.0);
}
