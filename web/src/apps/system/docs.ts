// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Docs (docs.ts, components/Docs.tsx): unkernel's documentation site in a
// window, opened or brought to the front; it works whatever the system's
// state. Pinned in the Dock by default (pins.ts). Its name and chrome icon
// are its window's (docs.ts DOCS).
import { DOCS, DOCS_WIN, openDocs } from "../../docs.ts";
import type { PageApp } from "../types.ts";

export default {
	kind: "page",
	...DOCS,
	desc: "unkernel's documentation: the SDK, the guest, the page",
	win: DOCS_WIN,
	// An open book.
	icon: { svg: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 6.5C10.3 5 7.9 4.5 3.5 4.5v14c4.4 0 6.8.5 8.5 2 1.7-1.5 4.1-2 8.5-2v-14c-4.4 0-6.8.5-8.5 2ZM12 6.5v14"/>' },
	colors: ["#52525b", "#18181b"],
	open: openDocs,
} satisfies PageApp;
