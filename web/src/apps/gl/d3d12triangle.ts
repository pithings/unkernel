// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// D3D12 triangle: vkd3d's Direct3D 12 "hello triangle" (vkd3d-triangle) in a
// window on the page's Wayland desktop, with guest Vulkan on (Debian): the
// same package, path and notes as the gears (d3d12gears.ts). Esc quits it
// (and X with it).
import type { TerminalApp } from "../types.ts";
import { XWL_PREP, XWL_SH } from "../xwl.ts";
import { VKD3D_DOWNLOADS, VKD3D_PACKAGES, VKD3D_README } from "./d3d12gears.ts";

export default {
	id: "d3d12triangle",
	title: "D3D12 triangle",
	desc: "Direct3D 12's coloured triangle in a window on the page, no Wine: vkd3d's Vulkan rendered on this browser's WebGPU (guest Vulkan)",
	// A triangle, its three vertices marked (crafted).
	icon: { svg: '<path opacity=".55" d="M12 5 19.8 18.5H4.2Z"/><circle cx="12" cy="5" r="2.3"/><circle cx="19.8" cy="18.5" r="2.3"/><circle cx="4.2" cy="18.5" r="2.3"/>' },
	colors: ["#ac162c", "#134e4a"],
	needs: { net: true, wayland: true, vk: true },
	packages: { debian: VKD3D_PACKAGES },
	files: {
		"xwl.sh": { content: XWL_SH, mode: 0o755 },
		README: VKD3D_README +
			"Esc quits. The other demo (the D3D12 gears):\n" +
			"  ./xwl.sh vkd3d-gears\n",
	},
	downloads: VKD3D_DOWNLOADS,
	commands: [XWL_PREP, "cat README", "./xwl.sh vkd3d-triangle"],
} satisfies TerminalApp;
