// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// BZFlag: 3D tank battles against robots, on X in the Display window
// (xkms.ts; Debian). Not a Wayland window: BZFlag 2.4.30 stops when GLEW's
// glewInit() reports no GLX display, which it does under SDL's Wayland
// driver (fixed after 2.4.30). Fixed-function OpenGL through Mesa's virgl
// driver with guest GL on (Options); without it, X has no DRM device to
// start on. play.sh runs a server (bzfs) on the guest's loopback and joins
// it with robots (-solo), in a window the size of X's screen. About 320 MiB
// installed, 84 MiB to download, Mesa, LLVM and X about 284 MiB of that (the
// image's package lists, 2026-11-22).
import type { TerminalApp } from "../types.ts";
import { X_KMS_PACKAGES, X_KMS_SH } from "../xkms.ts";

const PLAY = `#!/bin/sh
# A BZFlag server on this guest's loopback, and the client joined to it
# with robots; the server stops with it. ROBOTS (default 4) robots.
/usr/games/bzfs -advertise NONE -j >bzfs.log 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
sleep 2
/usr/games/bzflag -solo "\${ROBOTS:-4}" -window "\${KW_X_SIZE:-1024x768}" "$@" "$(id -un)@localhost"
`;

export default {
	id: "bzflag",
	title: "BZFlag",
	desc: "3D tank battles against robots (OpenGL), on X in the Display window",
	// A tank under a flag (crafted).
	icon: { svg: '<path d="M3 15h18l-2 4H5Z"/><path d="M7 11h8l1 3H6Z"/><path d="M14.5 11.5H21V13h-6.5Z"/><path d="M5 3h1.5v8H5Z"/><path opacity=".8" d="M6.5 3H12l-1.5 2L12 7H6.5Z"/>' },
	colors: ["#2563eb", "#14532d"],
	needs: { display: true, net: true },
	packages: { debian: ["bzflag-client", "bzflag-server", ...X_KMS_PACKAGES] },
	files: {
		"x.sh": { content: X_KMS_SH, mode: 0o755 },
		"play.sh": { content: PLAY, mode: 0o755 },
		README: "BZFlag on X in the Display window (guest GL on: Options). ./play.sh runs a\n" +
			"server here (bzfs.log) and joins it with robots (ROBOTS=8 ./x.sh ./play.sh\n" +
			"for more).\n" +
			"The mouse steers, its button fires, Tab jumps, Esc is the menu.\n",
	},
	commands: ["cat README", "./x.sh ./play.sh"],
} satisfies TerminalApp;
