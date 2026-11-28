#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Regenerates the SPIR-V C arrays (*_comp.h, *_vert.h, *_frag.h) from the
# GLSL next to them with glslangValidator.
set -eu
cd "$(dirname "$0")"
for s in double.comp barrier.comp shared512.comp shared512fn.comp wide.comp sets.comp triangle.vert triangle.frag depth.vert depth.frag flat.vert flat.frag texel.comp; do
	n=$(tr . _ <<<"$s")
	glslangValidator -V --vn "spv_$n" -o "$n.h.tmp" "$s" >/dev/null
	{ printf '// SPDX-License-Identifier: GPL-2.0-or-later\n// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>\n// Generated from %s by shaders.sh\n' "$s"; cat "$n.h.tmp"; } >"$n.h"
	rm "$n.h.tmp"
done
