// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Browser window's body (preview.ts opens the window, wm.ts draws its
// frame): a compact toolbar under the title bar (reload; the address, shown
// as localhost:PORT/path, where a port, a port and path, or a path on the
// current port sends it elsewhere; open the same URL in a new tab, which
// works while this page stays open) over an iframe on /vm/<vmId>/<port>/
// (the service worker public/vm-sw.js and preview.ts relay it to the guest's
// server). Every id is derived from the window id, so the first window keeps
// #preview, #preview-reload, #preview-port, #preview-tab, #preview-frame.
// - The address follows the page: read from the iframe's location on each
//   load, its popstate and hashchange, and when the field or the tab link is
//   used (a client-side router's pushState is seen then). The page's title
//   is the window's title.
// - Pointer: a press inside the page raises and focuses the window (a
//   listener on the iframe's window, same-origin; the page's blur with the
//   iframe focused where the document is not reachable). Moves and resizes
//   over it are safe: the root's wm-dragging takes pointer events off
//   iframes (style.css).
// - Keyboard: when the window gets the WM's focus and the DOM focus is
//   elsewhere (a terminal under a title bar click, the Dock, Ctrl-A p), the
//   body's root takes it, so keys reach neither a terminal nor the guest's
//   display; losing the WM's focus gives it up. Inside the iframe the page
//   sees no key events, so the Ctrl-A prefix does not work there: a click on
//   the toolbar or the title bar brings it back.
// - Coarse pointers get 40 px targets, and the address field 16 px text so
//   iOS does not zoom.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { KW } from "../kw.ts";
import { browserAt, browserGo, browserNav, browserReload, parseAddress, previewReady, previewUrl, useBrowser } from "../preview.ts";
import { useWm, wm } from "../wm.ts";
import { ExternalIcon, PreviewIcon, RebootIcon } from "./icons.tsx";

/** A press in the page this recently (ms) gave the window the focus: the page keeps the DOM focus. */
const PRESS_MS = 1000;
const address = (port: number, path: string) => `localhost:${port}${path === "/" ? "" : path}`;
const tool = "grid h-7 w-7 flex-none place-items-center rounded-md text-muted transition-colors hover:bg-ink/8 hover:text-fg disabled:pointer-events-none disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-10";

export function Browser({ id }: { id: string }) {
	const b = useBrowser(id);
	const focused = useWm((s) => s.focused === id);
	const [wait, setWait] = useState<string | null>("Starting the preview…");
	const [edit, setEdit] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const root = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLIFrameElement>(null);
	const pressed = useRef(0);
	const port = b?.port ?? 0;

	useEffect(() => {
		if (!port) return;
		let live = true;
		setWait("Waiting for the kernel and the preview's service worker…");
		previewReady().then(() => { if (live) setWait(null); }, (e: Error) => { if (live) setWait(e.message); });
		return () => { live = false; };
	}, [port]);

	// The WM's focus moves the DOM focus (see the top).
	useEffect(() => {
		const r = root.current, at = document.activeElement;
		if (!r) return;
		if (focused) {
			if (at && r.contains(at)) return;
			if (performance.now() - pressed.current < PRESS_MS) return;
			r.focus({ preventScroll: true });
		} else if (at && r.contains(at)) {
			// From the iframe too: focusing the root takes the focus out of it first.
			r.focus({ preventScroll: true });
			r.blur();
		}
	}, [focused]);

	// A click in a page this window cannot reach into (cross-origin) still focuses the iframe: the page blurs.
	useEffect(() => {
		const onBlur = () => setTimeout(() => {
			if (frame.current && document.activeElement === frame.current) { pressed.current = performance.now(); wm.focus(id); }
		}, 0);
		addEventListener("blur", onBlur);
		return () => removeEventListener("blur", onBlur);
	}, [id]);

	const nav = b?.nav ?? 0;
	useEffect(() => { setLoading(true); }, [nav, wait]);

	if (!b) return null;
	const { here } = b;
	const ids = { frame: `${id}-frame`, reload: `${id}-reload`, port: `${id}-port`, tab: `${id}-tab` };
	const src = wait === null ? previewUrl(b.port, b.path) : "";
	const tabUrl = wait === null ? previewUrl(here.port, here.path) : "";

	/** Where the page is now, from the iframe's location (same-origin only), into the store. */
	const readLoc = () => {
		const f = frame.current;
		if (!f) return;
		try {
			const l = f.contentWindow!.location;
			const base = previewUrl(0, "").slice(0, -1); // /vm/<vmId>/
			const m = l.pathname.startsWith(base) ? /^(\d+)(\/.*)?$/.exec(l.pathname.slice(base.length)) : null;
			if (m) browserAt(id, Number(m[1]), (m[2] ?? "/") + l.search + l.hash, f.contentDocument?.title ?? "");
		} catch { /* not reachable: another origin */ }
	};
	const onLoad = () => {
		setLoading(false);
		let w: Window | null = null;
		try { w = frame.current?.contentWindow ?? null; void w?.document; } catch { return; }
		if (!w) return;
		w.addEventListener("pointerdown", () => { pressed.current = performance.now(); wm.focus(id); }, true);
		w.addEventListener("popstate", readLoc);
		w.addEventListener("hashchange", readLoc);
		w.addEventListener("pagehide", () => setLoading(true));
		readLoc();
	};
	const reload = () => {
		setLoading(true);
		try { frame.current!.contentWindow!.location.reload(); } catch { browserReload(id); }
	};
	const submit = (e: FormEvent) => {
		e.preventDefault();
		const text = edit ?? address(here.port, here.path);
		const to = parseAddress(text, here.port);
		if (!to) { KW.ui!.toast(`Not an address in the guest: ${text} (a port, or localhost:PORT/path)`); return; }
		setEdit(null);
		root.current?.focus({ preventScroll: true });
		browserGo(id, to.port, to.path);
	};
	const onFieldKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		setEdit(null);
		root.current?.focus({ preventScroll: true });
	};

	return (
		<div id={id} ref={root} tabIndex={-1} aria-label={`Browser: the guest's port ${here.port}`} className="absolute inset-0 flex flex-col outline-none">
			<div className="relative flex flex-none items-center gap-1 border-b border-line bg-surface px-1.5 py-1 pointer-coarse:gap-1.5 pointer-coarse:py-1.5">
				<button id={ids.reload} type="button" className={tool} title="Reload" aria-label="Reload the page" disabled={!src} onClick={reload}>
					<RebootIcon size={14} />
				</button>
				<form onSubmit={submit} className="min-w-0 flex-1">
					<label className="flex h-7 min-w-0 items-center gap-2 rounded-md border border-line bg-bg px-2.5 text-faint transition-colors focus-within:border-line-strong focus-within:text-muted pointer-coarse:h-10">
						<PreviewIcon size={12} />
						<input id={ids.port} type="text" inputMode="url" enterKeyHint="go" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
							aria-label="Address in the guest: a port, or localhost:PORT/path"
							value={edit ?? address(here.port, here.path)}
							onFocus={(e) => {
								readLoc();
								const now = browserNav(id)?.here ?? here;
								setEdit(address(now.port, now.path));
								const el = e.currentTarget;
								requestAnimationFrame(() => el.select());
							}}
							onBlur={() => setEdit(null)}
							onChange={(e) => setEdit(e.currentTarget.value)}
							onKeyDown={onFieldKey}
							className="h-full min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-fg outline-none placeholder:text-faint pointer-coarse:text-[16px] [.mobile_&]:text-[16px]" />
					</label>
				</form>
				{tabUrl
					? <a id={ids.tab} href={tabUrl} target="_blank" rel="noopener" className={tool} onPointerEnter={readLoc} onFocus={readLoc}
						title="Open in a new tab (works while this page stays open)" aria-label="Open the page in a new tab"><ExternalIcon /></a>
					: <span aria-hidden="true" className={`${tool} opacity-40`}><ExternalIcon /></span>}
				{loading && src && <span aria-hidden="true" className="absolute inset-x-0 -bottom-px h-px animate-pulse bg-accent" />}
			</div>
			<div className="relative min-h-0 flex-1 bg-white">
				{src
					? <iframe key={nav} ref={frame} id={ids.frame} src={src} data-kw-preview={`${previewUrl(here.port, "")}/`} title={`The guest's port ${here.port}`}
						className="absolute inset-0 h-full w-full border-0" allow="fullscreen" onLoad={onLoad} />
					: <p className="absolute inset-0 bg-bg p-4 font-mono text-[12px] text-muted">{wait}</p>}
			</div>
		</div>
	);
}
