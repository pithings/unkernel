// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// fx: the fx coding agent (fx.sh), its native linux-arm64 build. Every
// distro image has the kw layer's shim /usr/lib/kw/bin/fx, which installs
// the newest release into ~/.local/bin on its first call (a 4.5 MB
// download, about 2 s under the Node CLI, 2026-11-18) and runs it
// (.agents/kernel/guest.md, Shims), so this demo only runs `fx`.
import type { TerminalApp } from "../types.ts";

export default {
	id: "fx",
	title: "fx",
	desc: "The fx coding agent, installed into ~/.local/bin on first use",
	icon: "𝒇x",
	colors: ["#3f3f46", "#09090b"],
	needs: { net: true },
	// The shim is on both distros; nothing to install first.
	packages: { alpine: [], arch: [], debian: [] },
	terminal: "window",
	commands: ["fx"],
} satisfies TerminalApp;
