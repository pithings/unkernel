// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Teeworlds: the 2D platform shooter, as a window on the page's Wayland
// desktop (wayland.ts; Debian). SDL2 on Wayland (the session's
// SDL_VIDEODRIVER, kw-wayland.sh) with OpenGL through EGL, inside the GL
// 2.1 compatibility profile that guest GL offers (.agents/gl.md). Its
// servers speak UDP, which the page's network does not carry, and it has no
// bots: play.sh runs a server on the guest's loopback and joins it, to play
// the maps alone (a second client in another window can join too). Started
// windowed at 1280x800 (settings it saves).
// About 228 MiB installed, 58 MiB to download, Mesa and LLVM about 188 MiB
// of that (the image's package lists, 2026-11-22).
// The SDL prefix and packages: sdlwl.ts (the page's window frame; libdecor
// preferred from the start for a compositor that answers client-side).
import type { TerminalApp } from "../types.ts";
import { SDL_WL, SDL_WL_PACKAGES } from "../sdlwl.ts";

const PLAY = `#!/bin/sh
# A Teeworlds server on this guest's loopback (no master server: the page's
# network has no UDP), and the client joined to it; the server stops with it.
/usr/games/teeworlds-server "sv_register 0" "sv_name unkernel" >server.log 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
sleep 1
${SDL_WL} /usr/games/teeworlds "gfx_fullscreen 0" "gfx_screen_width 1280" "gfx_screen_height 800" "connect localhost:8303" "$@"
`;

export default {
	id: "teeworlds",
	title: "Teeworlds",
	desc: "The 2D platform shooter (OpenGL, SDL2) on a local server, in a window on the page",
	// A round tee with its eyes and feet (crafted).
	icon: { svg: '<path fill-rule="evenodd" d="M12 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm-1.5 5a1.5 2 0 1 0 0 4 1.5 2 0 0 0 0-4Zm4.5 0a1.5 2 0 1 0 0 4 1.5 2 0 0 0 0-4Z"/><ellipse cx="8" cy="20.5" rx="3.2" ry="1.6"/><ellipse cx="16" cy="20.5" rx="3.2" ry="1.6"/>' },
	colors: ["#65a30d", "#164e63"],
	needs: { net: true, wayland: true },
	packages: { debian: ["teeworlds", "teeworlds-server", ...SDL_WL_PACKAGES] },
	files: {
		"play.sh": { content: PLAY, mode: 0o755 },
		README: "Teeworlds has no bots, and its online servers need UDP, which the page's\n" +
			"network does not carry: ./play.sh runs a server here (server.log) and joins it.\n" +
			"A/D move, Space jumps, the mouse aims and fires, the right button hooks,\n" +
			"the wheel changes weapons, Esc is the menu.\n",
	},
	commands: ["cat README", "./play.sh"],
} satisfies TerminalApp;
