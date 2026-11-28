#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Recompiles the test shaders' GLSL to the checked-in SPIR-V (glslang),
# plus spirv-opt -O variants (*.opt.spv) as optimizing toolchains emit.
set -euo pipefail
cd "$(dirname "$0")/shaders"
for f in *.vert *.frag *.comp; do
	env=vulkan1.0
	case "$f" in *.v13.*) env=vulkan1.3 ;; esac
	g=()
	case "$f" in *.g.*) g=(-g) ;; esac # with debug info (OpLine)
	glslangValidator -V "${g[@]}" --target-env "$env" -o "$f.spv" "$f" >/dev/null
	spirv-opt -O "$f.spv" -o "$f.opt.spv"
done
