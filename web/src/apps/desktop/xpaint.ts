// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// XPaint: a paint program on the X Athena widgets (Xaw3d), its windows (the
// toolbox and each canvas) windows of the page's Wayland desktop (Xwayland
// rootless through xwayland-satellite, xwl.ts; Debian). Quitting XPaint
// stops X.
import type { TerminalApp } from "../types.ts";
import { XWL_DOWNLOAD, XWL_PACKAGES, XWL_PREP, XWL_SH } from "../xwl.ts";

export default {
	id: "xpaint",
	title: "XPaint",
	desc: "A classic X paint program in windows on the page, through Xwayland",
	// A palette (crafted).
	icon: { svg: '<path fill-rule="evenodd" d="M12 3a9 9 0 0 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.8-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2ZM7 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm3-4a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm4 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm3 3a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/>' },
	colors: ["#ec4899", "#4c0519"],
	needs: { net: true, wayland: true },
	packages: { debian: [...XWL_PACKAGES, "xpaint"] },
	files: {
		"xwl.sh": { content: XWL_SH, mode: 0o755 },
	},
	downloads: [XWL_DOWNLOAD],
	commands: [XWL_PREP, "./xwl.sh xpaint"],
} satisfies TerminalApp;
