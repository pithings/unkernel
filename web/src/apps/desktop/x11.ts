// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// X11 desktop: the classic X clients (xterm, xclock, xeyes) as windows of
// the page's Wayland desktop, each its own (Xwayland rootless through
// xwayland-satellite, xwl.ts; Debian); any X app started from the xterm
// gets one too. Closing the xterm ends the session and X. Xwayland's
// rootful window (app id org.freedesktop.Xwayland, Xfce's) stands for this
// app too.
import type { TerminalApp } from "../types.ts";
import { XWL_DOWNLOAD, XWL_PACKAGES, XWL_PREP, XWL_SH } from "../xwl.ts";

export default {
	id: "x11",
	title: "X11",
	desc: "X apps (xterm, xclock, xeyes) as windows on the page, through Xwayland and xwayland-satellite",
	// The X: a thick stroke and a thin one (crafted).
	icon: { svg: '<path d="M4 3h4l12 18h-4Z"/><path d="M18.6 3H20L5.4 21H4Z"/>' },
	colors: ["#f97316", "#7c2d12"],
	needs: { net: true, wayland: true },
	packages: { debian: [...XWL_PACKAGES, "xterm", "x11-apps", "fonts-dejavu-core", "fontconfig"] },
	waylandIds: ["org.freedesktop.Xwayland"],
	files: {
		"xwl.sh": { content: XWL_SH, mode: 0o755 },
		"session.sh": {
			mode: 0o755,
			content: "#!/bin/sh\n" +
				"# The X11 session: xclock and xeyes, then xterm in the foreground\n" +
				"# (closing it ends the session and X). xclock and xeyes know no DPI:\n" +
				"# their sizes are times XWL_SCALE (xwl.sh), xterm's font follows Xft.dpi.\n" +
				"s=${XWL_SCALE:-1}\n" +
				"xclock -update 1 -geometry $((160 * s))x$((160 * s)) &\n" +
				"xeyes -geometry $((160 * s))x$((110 * s)) &\n" +
				"exec xterm -fa Monospace -fs 11 -bg '#0f172a' -fg '#e2e8f0' -geometry 80x24\n",
		},
	},
	downloads: [XWL_DOWNLOAD],
	commands: [XWL_PREP, "./xwl.sh ./session.sh"],
} satisfies TerminalApp;
