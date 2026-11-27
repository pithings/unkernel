// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Docs window's body (docs.ts opens the window, wm.ts draws its frame):
// a compact toolbar under the title bar (Home: the site's first page again;
// open the site in a new tab) over a credentialless iframe on DOCS_URL in
// the page's theme (docs.ts DOCS_EMBED_URL). Ids: #docs (the root), #docs-home, #docs-tab, #docs-frame.
// - Under the toolbar it is glass, as a Terminal window's content
//   (style.css): the iframe's page has a transparent background.
// - Pointer and keyboard as in the Browser (Preview.tsx): a click in the
//   page (another origin: seen as the page's blur with the iframe focused)
//   raises and focuses the window; the WM's focus moves the DOM focus to the
//   root, and losing it gives it up, so keys reach no terminal under it.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DOCS_EMBED_URL, DOCS_URL, docsHome, docsNav$, onPageTheme, pageTheme } from "../docs.ts";
import { useWm, wm } from "../wm.ts";
import { DocsIcon, ExternalIcon } from "./icons.tsx";

/** A press in the page this recently (ms) gave the window the focus: the page keeps the DOM focus. */
const PRESS_MS = 1000;
const tool = "grid h-7 w-7 flex-none place-items-center rounded-md text-muted transition-colors hover:bg-ink/8 hover:text-fg disabled:pointer-events-none disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-10";
const HOME_SVG = <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 11 12 4l8.5 7M5.5 9.5V20h13V9.5" /></svg>;
/** React passes an unknown attribute through as it is; the DOM types lack this one. */
const CREDENTIALLESS = { credentialless: "" } as Record<string, string>;

export function Docs({ id }: { id: string }) {
	const { nav } = useSyncExternalStore(docsNav$.subscribe, docsNav$.get);
	const theme = useSyncExternalStore(onPageTheme, pageTheme);
	const focused = useWm((s) => s.focused === id);
	const [loading, setLoading] = useState(true);
	const root = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLIFrameElement>(null);
	const pressed = useRef(0);

	useEffect(() => {
		const r = root.current, at = document.activeElement;
		if (!r) return;
		if (focused) {
			if (at && r.contains(at)) return;
			if (performance.now() - pressed.current < PRESS_MS) return;
			r.focus({ preventScroll: true });
		} else if (at && r.contains(at)) {
			r.focus({ preventScroll: true });
			r.blur();
		}
	}, [focused]);

	useEffect(() => {
		const onBlur = () => setTimeout(() => {
			if (frame.current && document.activeElement === frame.current) { pressed.current = performance.now(); wm.focus(id); }
		}, 0);
		addEventListener("blur", onBlur);
		return () => removeEventListener("blur", onBlur);
	}, [id]);

	useEffect(() => { setLoading(true); }, [nav, theme]);

	return (
		<div id={id} ref={root} tabIndex={-1} aria-label="unkernel's documentation" className="absolute inset-0 flex flex-col outline-none">
			<div className="relative flex flex-none items-center gap-1 border-b border-line bg-surface px-1.5 py-1 pointer-coarse:gap-1.5 pointer-coarse:py-1.5">
				<button id={`${id}-home`} type="button" className={tool} title="Home" aria-label="Back to the first page" onClick={docsHome}>
					{HOME_SVG}
				</button>
				<span className="flex h-7 min-w-0 flex-1 items-center gap-2 truncate px-1.5 font-mono text-[12.5px] text-faint pointer-coarse:h-10">
					<DocsIcon size={12} />
					<span className="truncate">{new URL(DOCS_URL).host}</span>
				</span>
				<a id={`${id}-tab`} href={DOCS_URL} target="_blank" rel="noopener" className={tool} title="Open in a new tab" aria-label="Open the docs in a new tab"><ExternalIcon /></a>
				{loading && <span aria-hidden="true" className="absolute inset-x-0 -bottom-px h-px animate-pulse bg-accent" />}
			</div>
			<div className="relative min-h-0 flex-1">
				<iframe key={`${nav}-${theme}`} ref={frame} id={`${id}-frame`} src={DOCS_EMBED_URL[theme]} title="unkernel's documentation" {...CREDENTIALLESS}
					className="absolute inset-0 h-full w-full border-0" onLoad={() => setLoading(false)} />
			</div>
		</div>
	);
}
