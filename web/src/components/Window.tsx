// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A desktop window (wm.ts draws its state here): a frame with a title bar
// (its descriptor's icon, wm.ts meta, as on its Dock tile, and the window's
// title; minimize, maximize and, when it may close, close), the body that holds its content, and resize edges and corners.
// - A press anywhere in it raises and focuses it (wm.focus). The title bar
//   moves it (wm.startMove: pointer capture, so mouse, touch and pen alike,
//   and the root's wm-dragging keeps iframes and canvases from taking the
//   moves); a double click or double tap on it maximizes or restores it.
//   Presses on the chrome never move the keyboard focus (mousedown is
//   cancelled), so the terminal under a title bar click keeps it.
// - titleContent (an app's own, such as the Terminal windows' tab strip)
//   takes the title's place in the title bar and in the compact strip; the
//   part of the bar it leaves free still moves the window.
// - resizable false (wm.ts): a fixed size: no edges, no maximize button,
//   and a double click on the title bar does nothing.
// - frame "none": no title bar (the app draws its own decorations and calls
//   wm.startMove and wm.startResize itself); the edges stay.
// - Snapped (wm.ts snap: data-snap) it is drawn at its tile, edges and all;
//   dragging it by the title bar to the workspace's edges snaps it (wm.ts).
// - Maximized it fills the workspace without edges; compact (phones, narrow
//   viewports) every window does, with a slim strip for its title (and its
//   close button) in place of the title bar, hidden while the on-screen
//   keyboard is up (style.css).
// - Hidden (minimized, or not the top one in compact mode) it keeps its box
//   (visibility through data-hidden, style.css, like the terminals always
//   were: wterm keeps its grid) and is inert, so nothing in it takes the
//   focus. Inert at once; drawn until its effect ends (wmfx.ts: minimized it
//   flies into its Dock tile; restored, opened, closed, maximized: each its
//   own effect). `closing`: a closed window's ghost (Workspace.tsx), inert,
//   drawn while it fades out.
// - The body mounts an element content once (appendChild: it is never
//   recreated; another one in its place, a window opened again under a
//   ghost's id, puts the old one out) or renders a React node, and reports its size (wm.reportSize,
//   the app's onResize). The parts are always in the same order, so React
//   never remounts the body (the console's #term lives in it). An app that
//   lends its element elsewhere for a while (the Display's page cover)
//   gets it back in the body with adoptContent(id); once the body goes (the
//   window closed and its close effect over) it hands the element to the
//   app's onRelease (sysapps.ts parks its apps' elements), else it goes with
//   the body.
// - Coarse pointers get a taller title bar, wider buttons and wider edges
//   (style.css: --wm-title, --wm-edge).
import { memo, useEffect, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { snapGeom, wm, type Edge, type WmWindow } from "../wm.ts";
import { windowFx, windowGone, type FxState } from "../wmfx.ts";
import { CloseIcon, MaxIcon, MetaIcon, MinIcon, UnmaxIcon } from "./icons.tsx";

const EDGES: Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
/** Two releases this close in time (ms) and place (px) are a double click or tap. */
const DOUBLE_MS = 350, DOUBLE_PX = 12;

/** No focus change, no text selection: the chrome is not a place to type. */
const keepFocus = (e: ReactMouseEvent) => e.preventDefault();
const press = (e: ReactPointerEvent<HTMLElement>) => ({ pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY, button: e.button, target: e.currentTarget });

function TitleButton({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
	return (
		<button type="button" title={label} aria-label={label} onClick={onClick}
			className={`wm-btn grid h-full place-items-center rounded-md text-faint transition-colors hover:text-fg ${danger ? "hover:bg-err/20 hover:text-err" : "hover:bg-ink/8"}`}
		>{children}</button>
	);
}

/** The mounted bodies' adopters, by window id (one Window per id: a window opened again under a ghost's id takes the ghost's). */
const adopters = new Map<string, () => void>();
/** Put window id's element content back in its body, from wherever its app lent it (false: no such body is mounted). */
export function adoptContent(id: string): boolean {
	const adopt = adopters.get(id);
	adopt?.();
	return !!adopt;
}

function Body({ win }: { win: WmWindow }) {
	const ref = useRef<HTMLDivElement>(null);
	const el = win.content instanceof HTMLElement ? win.content : null;
	const had = useRef<HTMLElement | null>(null);
	const release = useRef(win.onRelease);
	release.current = win.onRelease;
	useLayoutEffect(() => {
		const b = ref.current!, old = had.current;
		had.current = el;
		if (old && old !== el && old.parentElement === b) old.remove();
		if (el && el.parentElement !== b) b.appendChild(el);
	}, [el]);
	useLayoutEffect(() => {
		const id = win.id, b = ref.current!;
		const adopt = () => { const e = had.current; if (e && e.parentElement !== b) b.appendChild(e); };
		adopters.set(id, adopt);
		return () => {
			if (adopters.get(id) === adopt) adopters.delete(id);
			// The body goes: its element to the app, if it wants it back.
			const e = had.current;
			if (e && e.parentElement === b) release.current?.(e);
		};
	}, [win.id]);
	useEffect(() => {
		const b = ref.current!;
		const report = () => wm.reportSize(win.id, b.clientWidth, b.clientHeight);
		const ro = new ResizeObserver(report);
		ro.observe(b);
		return () => ro.disconnect();
	}, [win.id]);
	return (
		<div ref={ref} className="wm-body relative min-h-0 flex-1" data-app={win.appId}>
			{el ? null : (win.content as ReactNode)}
		</div>
	);
}

export const Window = memo(function Window({ win, z, focused, visible, closing = false, compact, area }: {
	win: WmWindow; z: number; focused: boolean; visible: boolean; closing?: boolean; compact: boolean; area: { w: number; h: number };
}) {
	const max = win.maximized || compact;
	const g = max ? { x: 0, y: 0, w: area.w, h: area.h } : win.snap ? snapGeom(win, area) : win;
	const chrome = win.frame === "normal";
	const fixed = win.resizable === false;
	const free = !max && !fixed;
	const closable = win.closable !== false;
	const lastTap = useRef({ t: 0, x: 0, y: 0 });
	// A press anywhere in the window raises and focuses it. A native listener on the element, not React's
	// onPointerDownCapture: content rendered through a portal (Settings, System) bubbles in React to where
	// the portal was made, not to this window.
	const section = useRef<HTMLElement>(null);
	useEffect(() => {
		const el = section.current;
		if (!el) return;
		const down = () => wm.focus(win.id);
		el.addEventListener("pointerdown", down, true);
		return () => el.removeEventListener("pointerdown", down, true);
	}, [win.id]);
	// Its effects (wmfx.ts): after each render, what changed since the last one picks one.
	const fx = useRef<FxState | null>(null);
	useLayoutEffect(() => {
		const now: FxState = { visible, closing, minimized: win.minimized, maximized: win.maximized, framed: chrome, g: { x: g.x, y: g.y, w: g.w, h: g.h } };
		const prev = fx.current;
		fx.current = now;
		windowFx(section.current!, win.id, prev, now);
	});
	useLayoutEffect(() => { const el = section.current!; return () => windowGone(el); }, []);

	const onTitleDown = (e: ReactPointerEvent<HTMLElement>) => {
		if ((e.target as Element).closest("button")) return;
		e.preventDefault();
		const p = press(e);
		wm.startMove(win.id, p, (moved) => {
			const last = lastTap.current, now = performance.now();
			if (moved) { last.t = 0; return; }
			if (now - last.t < DOUBLE_MS && Math.hypot(p.clientX - last.x, p.clientY - last.y) < DOUBLE_PX) {
				last.t = 0;
				if (!fixed) wm.maximize(win.id);
			} else lastTap.current = { t: now, x: p.clientX, y: p.clientY };
		});
	};

	return (
		<section
			ref={section} id={`win-${win.id}`} role="group" aria-label={win.title} inert={!visible || closing}
			data-focused={focused || undefined} data-max={max || undefined} data-snap={(!max && win.snap) || undefined} data-frame={win.frame} data-hidden={!visible || undefined}
			className="wm-win absolute flex flex-col"
			style={{ left: g.x, top: g.y, width: g.w, height: g.h, zIndex: z }}
		>
			{chrome && (compact ? (
				<header className="wm-strip flex flex-none items-center gap-2 pl-3 select-none" onMouseDown={keepFocus}>
					<span className="flex text-faint"><MetaIcon meta={win.meta} size={13} /></span>
					{win.titleContent
						? <div className="flex h-full min-w-0 flex-1 items-center">{win.titleContent}</div>
						: <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">{win.title}</span>}
					{closable && <TitleButton label={`Close ${win.title}`} danger onClick={() => wm.close(win.id)}><CloseIcon size={14} /></TitleButton>}
				</header>
			) : (
				<header className="wm-title flex flex-none touch-none items-center gap-2 pr-1 pl-3 select-none" onPointerDown={onTitleDown} onMouseDown={keepFocus}>
					<span className="flex text-faint"><MetaIcon meta={win.meta} size={13} /></span>
					{win.titleContent
						? <div className="flex h-full min-w-0 flex-1 items-center">{win.titleContent}</div>
						: <span className="wm-name min-w-0 flex-1 truncate text-[12.5px]">{win.title}</span>}
					<div className="flex h-full items-center gap-0.5 py-1">
						<TitleButton label="Minimize" onClick={() => wm.minimize(win.id)}><MinIcon size={14} /></TitleButton>
						{!fixed && (
							<TitleButton label={win.maximized ? "Restore" : "Maximize"} onClick={() => wm.maximize(win.id)}>
								{win.maximized ? <UnmaxIcon size={13} /> : <MaxIcon size={13} />}
							</TitleButton>
						)}
						{closable && <TitleButton label="Close" danger onClick={() => wm.close(win.id)}><CloseIcon size={14} /></TitleButton>}
					</div>
				</header>
			))}
			<Body win={win} />
			{free && EDGES.map((edge) => (
				<div key={edge} aria-hidden="true" className={`wm-edge wm-edge-${edge}`} onMouseDown={keepFocus}
					onPointerDown={(e) => { e.preventDefault(); wm.startResize(win.id, edge, press(e)); }} />
			))}
		</section>
	);
});
