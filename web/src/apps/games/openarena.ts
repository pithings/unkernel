// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// OpenArena: the free Quake III-style arena shooter (ioquake3), against
// bots, as a window on the page's Wayland desktop (wayland.ts; Debian).
// SDL2 on Wayland (the session's SDL_VIDEODRIVER, kw-wayland.sh) with
// ioquake3's OpenGL 1 renderer through EGL, inside the GL 2.1
// compatibility profile that guest GL offers (.agents/gl.md); with guest GL
// off Mesa draws it in software (llvmpipe). Started windowed at 1024x768
// (cvars it saves in ~/.openarena). The mouse aims (SDL's relative mode:
// wland has relative pointers and pointer locks). Online play needs UDP,
// which the page's network does not carry; a game against bots runs its
// server in the same process. About 636 MiB installed, 449 MiB to
// download, the game's data most of it (the image's package lists,
// 2026-11-22). Its sound plays where the page has a sound card.
// The SDL prefix and packages: sdlwl.ts (the page's window frame; libdecor
// preferred from the start for a compositor that answers client-side).
import type { TerminalApp } from "../types.ts";
import { SDL_WL, SDL_WL_PACKAGES } from "../sdlwl.ts";

export default {
	id: "openarena",
	title: "OpenArena",
	desc: "The Quake III-style arena shooter against bots (OpenGL, ioquake3), in a window on the page; a 449 MiB download",
	// A crosshair (crafted).
	icon: { svg: '<path fill-rule="evenodd" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14Z"/><path d="M11 1h2v6h-2Zm0 16h2v6h-2ZM1 11h6v2H1Zm16 0h6v2h-6Z"/><circle cx="12" cy="12" r="1.5"/>' },
	colors: ["#ea580c", "#1c1917"],
	needs: { net: true, wayland: true },
	packages: { debian: ["openarena", ...SDL_WL_PACKAGES] },
	waylandIds: ["ioquake3"],
	files: {
		README: "OpenArena: Single Player or Skirmish plays against bots. Online servers need\n" +
			"UDP, which the page's network does not carry. The mouse aims (click the\n" +
			"window to grab it), WASD moves, Space jumps, the mouse button fires, Esc is\n" +
			"the menu. Settings are in ~/.openarena.\n",
	},
	commands: [
		"cat README",
		"echo 'Guest GL (Options) draws it on the GPU; without it Mesa draws in software, slowly'",
		`${SDL_WL} /usr/games/openarena +set cl_renderer opengl1 +set r_fullscreen 0 +set r_mode -1 +set r_customwidth 1024 +set r_customheight 768`,
	],
} satisfies TerminalApp;
