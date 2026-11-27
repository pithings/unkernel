// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Docs window (components/Docs.tsx is its body): unkernel's documentation
// site, DOCS_URL, in an iframe in a desktop window (wm.ts), a singleton like
// Settings. Opened from its launcher app (apps/system/docs.ts), which is
// pinned in the Dock by default (pins.ts).
//
// - Embedding: the page is cross-origin isolated (COEP require-corp), so a
//   cross-origin iframe loads only if its document sends COEP and
//   `Cross-Origin-Resource-Policy: cross-origin`, which the site does
//   (docs/.config/docs.yaml crossOriginIsolation), or the iframe is
//   credentialless (Chromium only). The iframe is credentialless too, so
//   Chromium shows the site even from a deploy without those headers.
// - The site is another origin: the window cannot read where its page is,
//   so Home goes back to DOCS_URL and the new tab opens there.
// - Theme: the iframe's URL carries an undocs theme fragment (`#~` and
//   base64url JSON of design tokens, https://undocs.unjs.io/guide/embedding),
//   THEME: the page's colours (style.css) on a transparent background,
//   so the window is glass like a terminal, the colour mode pinned to the page's.
//   The new tab gets the site as it is.
import { createElement } from "react";
import type { AppMeta } from "./apps/types.ts";
import { Docs } from "./components/Docs.tsx";
import { DocsIcon } from "./components/icons.tsx";
import { hideDisplay } from "./display.ts";
import { createStore } from "./store.ts";
import { wm, wm$ } from "./wm.ts";

/** The documentation site. */
export const DOCS_URL = "https://docs.unkernel.dev/";
/**
 * The page's look as undocs tokens (style.css: fg, hover, muted, line,
 * accent); the colour mode pinned to the page's (`m`). The background and cards
 * are transparent: the window's glass (style.css) shows through, which
 * works because the page and the site are both dark or both light (`color-scheme`), else
 * the browser paints the iframe opaque.
 */
const THEME = {
	dark: { m: "d", bg: "transparent", fg: "#ededed", c: "rgb(255 255 255 / 4%)", mu: "#1a1a1a", muf: "#a1a1a1", bd: "#242424", p: "#52a8ff", pf: "#000000", br: "#52a8ff", r: "0.5rem" },
	light: { m: "l", bg: "transparent", fg: "#171717", c: "rgb(0 0 0 / 4%)", mu: "#f2f2f2", muf: "#525252", bd: "#ebebeb", p: "#0068d6", pf: "#ffffff", br: "#0068d6", r: "0.5rem" },
};
const embedUrl = (theme: object) => `${DOCS_URL}#~${btoa(JSON.stringify(theme)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
/** DOCS_URL with THEME as its fragment: what the iframe loads. */
export const DOCS_EMBED_URL = { dark: embedUrl(THEME.dark), light: embedUrl(THEME.light) };
export const pageTheme = (): "dark" | "light" => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
export function onPageTheme(cb: () => void): () => void {
	const o = new MutationObserver(cb);
	o.observe(document.documentElement, { attributeFilter: ["data-theme"] });
	return () => o.disconnect();
}
/** The window's WM id (its body's root is #docs). */
export const DOCS_WIN = "docs";
/** Its Dock tile's element id while it is open. */
const DOCS_DOCK = "dock-docs";
/** The window's descriptor (wm.ts meta), and the Docs page app's (apps/system/docs.ts). */
export const DOCS: AppMeta = { id: "docs", title: "Docs", glyph: DocsIcon };

/** Bumped by Home: the iframe is made again (its key) on DOCS_URL. */
export const docsNav$ = createStore<{ nav: number }>({ nav: 0 });

/** Its first geometry: centred, most of the workspace; the WM places it where the workspace is not measured yet. */
function firstGeom(): { w: number; h: number; x?: number; y?: number } {
	const { area } = wm$.get();
	if (!area.w || !area.h) return { w: 1280, h: 820 };
	const w = Math.round(Math.min(1440, area.w - 32, Math.max(560, area.w * 0.8)));
	const h = Math.round(Math.min(area.h - 16, Math.max(400, area.h * 0.94)));
	return { w, h, x: Math.max(0, Math.round((area.w - w) / 2)), y: Math.max(0, Math.round((area.h - h) / 2)) };
}

/** Open the Docs window, or show and focus it where it is (the guest's Display window goes under it, as for the Browser). */
export function openDocs(): void {
	hideDisplay();
	if (wm.get(DOCS_WIN)) { wm.focus(DOCS_WIN); return; }
	wm.open({
		id: DOCS_WIN, meta: DOCS, dockId: DOCS_DOCK, minW: 320, minH: 220, ...firstGeom(),
		content: createElement(Docs, { id: DOCS_WIN }),
	});
}

/** Back to the site's first page. */
export const docsHome = (): void => docsNav$.set((s) => ({ nav: s.nav + 1 }));
