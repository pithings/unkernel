// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// htop: the process viewer, on the guest's own processes. htop reads /proc,
// so what it shows is this kernel's view: the CPU count, memory and every
// task of the Linux running in the tab. One small package from main.
import type { TerminalApp } from "../types.ts";

export default {
	id: "htop",
	title: "htop",
	desc: "The interactive process viewer, showing the Linux running in your browser",
	// Three meters, as htop's header draws them.
	icon: { svg: '<g opacity=".35"><rect x="2" y="3.3" width="20" height="4.4" rx="1.4"/><rect x="2" y="9.8" width="20" height="4.4" rx="1.4"/><rect x="2" y="16.3" width="20" height="4.4" rx="1.4"/></g><rect x="2" y="3.3" width="14" height="4.4" rx="1.4"/><rect x="2" y="9.8" width="8.5" height="4.4" rx="1.4"/><rect x="2" y="16.3" width="17.5" height="4.4" rx="1.4"/>' },
	colors: ["#16a34a", "#0f2a1c"],
	needs: { net: true },
	packages: { alpine: ["htop"], arch: ["htop"], debian: ["htop"] },
	terminal: "window",
	commands: [
		"echo 'F6 sorts, F5 shows a tree, F9 kills, q quits (no F-keys: Esc then the digit)'",
		"htop",
	],
} satisfies TerminalApp;
