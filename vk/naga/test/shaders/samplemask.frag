#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A fragment shader writing gl_SampleMask (vkQuake's MSAA SSAO composite):
// int[1] in SPIR-V, WGSL's sample_mask is a u32.
layout(push_constant) uniform P { float full; } pc;
layout(location = 0) out vec4 o;
void main() {
	int mask = int(gl_SampleMaskIn[0]) & 5;
	gl_SampleMask[0] = pc.full == 1.0 ? -1 : mask;
	o = vec4(1.0);
}
