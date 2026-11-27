// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// D3D12 gears: vkd3d's Direct3D 12 gears demo (vkd3d-gears) in a window on
// the page's Wayland desktop, with guest Vulkan on (Debian). A native Linux
// program written against Direct3D 12, no Wine: vkd3d (Wine's D3D12
// library) turns its calls into Vulkan, and the guest's Vulkan is the base's
// ICD on this browser's WebGPU (.agents/vk.md): D3D12 -> Vulkan -> WebGPU.
// Debian 13's vkd3d-demos (vkd3d 1.2: vkd3d-gears and vkd3d-triangle, 22 kB)
// with libvkd3d1, libvkd3d-shader1 and libvkd3d-utils1 is about 230 kB to
// download, 880 KiB installed (the archive's arm64 packages, 2026-11-24).
// The demos are X11 only (xcb): each window a window of the page through
// xwayland-satellite (xwl.ts). Their frames are read back from WebGPU and drawn with XPutImage, not the
// zero-copy path of Vulkan's Wayland windows. At start-up vkd3d makes a few
// pipelines (its UAV clears: texel buffers, 1D-array storage images) that
// WebGPU cannot run and the demos never bind; kwvk says so on stderr
// ("cannot run on WebGPU"), and the README says that is expected. Esc quits
// either demo (and X with it); the arrow keys turn the gears.
import type { TerminalApp } from "../types.ts";
import { XWL_DOWNLOAD, XWL_PACKAGES, XWL_PREP, XWL_SH } from "../xwl.ts";

/** The vkd3d demos' packages, for both tiles (this one and d3d12triangle.ts). */
export const VKD3D_PACKAGES = ["libvulkan1", "vkd3d-demos", ...XWL_PACKAGES];

/** Their downloads (xwayland-satellite), for both tiles. */
export const VKD3D_DOWNLOADS = [XWL_DOWNLOAD];

/** What both demos' READMEs start with. */
export const VKD3D_README = "A native Linux program written against Direct3D 12, no Wine: vkd3d turns\n" +
	"its Direct3D 12 into Vulkan, and the guest's Vulkan is this browser's WebGPU\n" +
	"(guest Vulkan, Options): D3D12 -> Vulkan -> WebGPU. It is an X11 program, on\n" +
	"Xwayland in a window on the page; its frames are read back from WebGPU.\n" +
	"At start-up kwvk prints a few lines saying a pipeline \"cannot run on WebGPU\"\n" +
	"(texel buffers, 1D-array storage images): vkd3d makes them up front and these\n" +
	"demos never use them, so they are expected. A device lost would be an error.\n";

export default {
	id: "d3d12gears",
	title: "D3D12 gears",
	desc: "Direct3D 12's gears in a window on the page, no Wine: vkd3d's Vulkan rendered on this browser's WebGPU (guest Vulkan)",
	// A gear (crafted).
	icon: { svg: '<g fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9.2" stroke-width="3" stroke-dasharray="2.41 2.41"/><circle cx="12" cy="12" r="5.5" stroke-width="4.8"/></g>' },
	colors: ["#ac162c", "#14532d"],
	needs: { net: true, wayland: true, vk: true },
	packages: { debian: VKD3D_PACKAGES },
	files: {
		"xwl.sh": { content: XWL_SH, mode: 0o755 },
		README: VKD3D_README +
			"Esc quits, the arrow keys turn the gears. The other demo (the D3D12 triangle):\n" +
			"  ./xwl.sh vkd3d-triangle\n",
	},
	downloads: VKD3D_DOWNLOADS,
	commands: [XWL_PREP, "cat README", "./xwl.sh vkd3d-gears"],
} satisfies TerminalApp;
