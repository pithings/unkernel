// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The launcher: the overlay the Dock's first tile opens (#launcher, Launchpad;
// Dock.tsx #dock-launcher), in the manner of the iOS home screen: the page
// blurred behind a search field and a grid of the apps (../apps/), the page's
// own apps first (Terminal, Browser, Settings, System: the inline group), then
// one folder per group. A folder's face is a fan of its first three apps'
// real icons, the first in front at 80% of an app icon's size and the next
// two tilted out behind it, left and right; it spreads a little under the
// pointer and while selected. An open folder's title carries its group's own
// icon (apps/<group>/index.ts). A tile runs its app (launcher.ts launch()).
//
// - A folder opens in place: it grows from its tile into a panel with its
//   title and its apps' tiles, over the top level blurred once more; a click
//   outside the panel, or Esc, closes it back into its tile (no motion with
//   prefers-reduced-motion).
// - Typing searches every app, whatever the folder (title, id, description
//   and its group's title), in one flat grid; clearing it shows the folders.
// - Keys: the arrows move the selection in whatever grid shows (the top
//   level, the open folder, the search results): left and right through the
//   list, up and down to the nearest tile in the next row; the selected tile
//   is scrolled into view. They do so with text in the field too (a short
//   query has no caret to steer; with Shift, Alt, Ctrl or ⌘ they edit the
//   text as usual, and Home and End move the caret). A new query selects its
//   first result. Enter opens a folder or runs an app, Esc closes the
//   folder, else clears the search, else closes the launcher; Tab goes
//   nowhere. The focus stays in the search field (tiles
//   take none), so display.ts never routes these keys to a program holding
//   the guest's keyboard. On touch devices the field is not focused (it would
//   raise the on-screen keyboard): the overlay itself takes the focus, away
//   from a terminal, and display.ts leaves keys in #launcher alone too.
// - Under the grid, with a keyboard (not on touch devices): the keys, and
//   the shortcut prefix as key caps with "shortcuts" (keys.ts PREFIX); a
//   click on it closes the launcher and arms the prefix, so the shortcuts
//   HUD shows (KeysHud.tsx). It takes no focus and is no tab stop.
// - A click on the backdrop closes it; so do its shortcuts (⌘K on Apple
//   devices, Ctrl-Shift-O, Ctrl-A o: keys.ts) and the Dock's tile.
// - An app's tile and a folder have a menu (Menu.tsx, at the pointer;
//   #launcher-menu): a right click, a long press on touch (LONG_PRESS without
//   moving more than 8 px; the tap that ends it does nothing else), or the
//   ContextMenu key or Shift-F10 for the selected tile. Open, then Keep in
//   Dock or Remove from Dock (pins.ts: the app, or the folder's group, whose
//   Dock tile opens its apps). The launcher stays open while it is used and
//   closes only with an app's Open; a press outside the menu only closes the
//   menu (that press and its click do nothing else); its keys stay in it,
//   and Esc closes it first, before the folder and the launcher.
// - An app being installed (installer.ts) has a progress bar over its icon,
//   and picking it shows its installer.
// - A running app (a terminal named after it, or a page app's open window)
//   has a dot under its tile, and picking it shows that window (launcher.ts:
//   one run at a time); a folder has the dot while one of its apps runs.
// - An app with `hidden` set is left out. One the page cannot run
//   (launcher.ts unavailable()) is dimmed, with why in its tooltip and under
//   the grid while it is selected (on touch, once it is tapped); a folder
//   whose apps all are is dimmed too, and still opens.
import {
	useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
	type ReactNode, type RefObject,
} from "react";
import { GROUPS } from "../apps/index.ts";
import { isPageApp, type App, type AppIcon } from "../apps/types.ts";
import { reducedMotion, useLongPress } from "../hooks.ts";
import { useInstalls, type Install } from "../installer.ts";
import { KW } from "../kw.ts";
import { appPackages, launch, setLauncher, unavailable } from "../launcher.ts";
import { PREFIX } from "../keys.ts";
import { canPin, canPinGroup, isPinned, pin, unpin, usePins, type PinTarget } from "../pins.ts";
import { isStopped, useStore } from "../store.ts";
import { useTermTabs } from "../termtabs.ts";
import { useWm } from "../wm.ts";
import { AppGlyph, SearchIcon } from "./icons.tsx";
import { TileProgress } from "./Installer.tsx";
import { Menu, type MenuClose, type MenuEntry } from "./Menu.tsx";

/** An app's tile. */
interface Tile {
	app: App;
	id: string;
	title: string;
	desc: string;
	icon: string | AppIcon;
	colors: [string, string];
	/** Why it cannot run now, or null. */
	why: string | null;
	/** Where it runs ("running in terminal 3", "open"), or null. */
	running: string | null;
	tip: string;
	/** Its group's title, for search. */
	group: string;
	/** Its install, while it is being installed. */
	install?: Install;
}
/** A group's folder. */
interface Folder {
	id: string;
	title: string;
	desc: string;
	icon: string | AppIcon;
	colors: [string, string];
	tiles: Tile[];
	running: boolean;
	/** Every app in it is unavailable. */
	off: boolean;
}
type Entry = { tile: Tile; folder?: undefined } | { folder: Folder; tile?: undefined };

const GRAY: [string, string] = ["#52525b", "#18181b"];
const GROUP_TITLE = new Map(GROUPS.map((g) => [g.id, g.title]));
const matches = (t: Tile, q: string) => `${t.title} ${t.id} ${t.desc} ${t.group}`.toLowerCase().includes(q);
const gradient = (c: [string, string]): CSSProperties => ({ backgroundImage: `linear-gradient(135deg, ${c[0]}, ${c[1]})` });
const optId = (e: Entry) => (e.folder ? `launcher-folder-${e.folder.id}` : `launcher-app-${e.tile.id}`);

/** A rounded square with the app's gradient and glyph, or its pictogram at 58%; its install's bar over its bottom. */
function Icon({ t }: { t: Tile }) {
	return (
		<span style={gradient(t.colors)} aria-hidden="true"
			className={`relative grid size-16 place-items-center rounded-[22%] text-3xl text-white shadow-[0_8px_24px_rgba(0,0,0,.5),inset_0_1px_0_rgba(255,255,255,.25)] transition-transform group-hover:scale-105 group-active:scale-95 sm:size-[4.5rem] sm:text-4xl ${t.why ? "grayscale" : ""}`}>
			<AppGlyph icon={t.icon} className="size-[58%] drop-shadow-[0_1px_1.5px_rgba(0,0,0,.3)]" />
			<TileProgress inst={t.install} className="right-[16%] bottom-[12%] left-[16%]" />
		</span>
	);
}

/**
 * Where the cards behind a folder's front one sit (transform-origin at their
 * bottom middle): the second out to the right, the third to the left, each a
 * little smaller; spread by 1.4 under the pointer and while selected.
 */
const FAN: CSSProperties[] = [
	{ "--x": "15%", "--r": "11deg", "--s": "0.92" } as CSSProperties,
	{ "--x": "-15%", "--r": "-11deg", "--s": "0.86" } as CSSProperties,
];

/**
 * A folder's face: its first apps' icons as a fan of cards, back to front,
 * in a box as large as an app's icon (the tilted cards overhang it a few px
 * at the sides, so rows stay even). Each card is the app's own gradient and
 * glyph, dimmed while the app cannot run, with a shadow that parts it from
 * the card behind. data-face is the box an opening folder grows from.
 */
function FolderFace({ f }: { f: Folder }) {
	const shown = f.tiles.slice(0, 3);
	const card = (t: Tile, i: number) => (
		<span key={t.id} style={{ ...gradient(t.colors), ...(i ? FAN[i - 1] : {}) }}
			className={`absolute bottom-0 left-[10%] grid size-[80%] origin-bottom place-items-center rounded-[22%] text-2xl text-white shadow-[0_3px_10px_rgba(0,0,0,.55),inset_0_1px_0_rgba(255,255,255,.25)] sm:text-3xl ${i ? "[transform:translateX(var(--x))_rotate(var(--r))_scale(var(--s))] transition-transform duration-200 ease-out group-hover:[transform:translateX(calc(var(--x)*1.4))_rotate(calc(var(--r)*1.4))_scale(var(--s))] group-aria-selected:[transform:translateX(calc(var(--x)*1.4))_rotate(calc(var(--r)*1.4))_scale(var(--s))]" : ""} ${t.why ? "brightness-75 grayscale" : ""}`}>
			<AppGlyph icon={t.icon} className="size-[58%] drop-shadow-[0_1px_1.5px_rgba(0,0,0,.3)]" />
		</span>
	);
	return (
		<span data-face="1" aria-hidden="true" className="relative block size-16 transition-transform group-active:scale-95 sm:size-[4.5rem]">
			{shown.map((t, i) => ({ t, i })).reverse().map(({ t, i }) => card(t, i))}
		</span>
	);
}

/** A long press on touch: how long (ms), as on the Dock's tiles. */
const LONG_PRESS = 500;

/**
 * A cell's menu triggers: a right click, and a long press on touch
 * (hooks.ts useLongPress: a move past 8 px, a scroll or a lift cancels it).
 * `onMenu` gets the point; without it the browser's menu is still kept
 * away. `consumed()`: the click ends a long press that opened the menu, so
 * it does nothing else.
 */
function useCellMenu(onMenu: ((at: DOMRect) => void) | undefined) {
	const long = useLongPress(onMenu && ((at) => onMenu(new DOMRect(at.x, at.y, 0, 0))), { ms: LONG_PRESS });
	const handlers = {
		onContextMenu: (e: ReactMouseEvent) => {
			e.preventDefault();
			if (!onMenu) return;
			long.context();
			onMenu(new DOMRect(e.clientX, e.clientY, 0, 0));
		},
		...long.handlers,
	};
	return { handlers, consumed: long.consumed };
}

/** A cell of a grid: a folder's or an app's face, its title, and the running dot; `onMenu`: its menu (useCellMenu). */
function Cell({ e, idx, on, onPick, onHover, onMenu }: { e: Entry; idx: number; on: boolean; onPick(): void; onHover(): void; onMenu?(at: DOMRect): void }) {
	const { handlers, consumed } = useCellMenu(onMenu);
	const f = e.folder, t = e.tile;
	const dim = f ? f.off : !!t!.why;
	const running = f ? f.running : !!t!.running;
	const title = f ? f.title : t!.title;
	return (
		<button
			id={optId(e)} data-idx={idx} data-folder={f?.id} data-app={t?.id}
			type="button" role="option" aria-selected={on} aria-disabled={!f && dim} tabIndex={-1}
			title={f ? `${f.title}: ${f.desc}` : t!.tip}
			onMouseDown={(ev) => ev.preventDefault()} // the focus stays in the search field
			onMouseEnter={onHover} onClick={() => { if (!consumed()) onPick(); }} {...handlers}
			className={`group flex min-w-0 flex-col items-center gap-1.5 rounded-2xl px-1 pt-2.5 pb-1.5 outline-none transition-colors select-none [-webkit-touch-callout:none] ${on ? "bg-ink/10" : ""} ${dim ? "opacity-45" : ""}`}
		>
			{f ? <FolderFace f={f} /> : <Icon t={t!} />}
			<span className="max-w-full truncate text-[12px] text-ink/90 [text-shadow:0_1px_3px_color-mix(in_srgb,var(--color-bg)_60%,transparent)] sm:text-[13px]">{title}</span>
			{/* Running: a dot under the title, as in the Dock. */}
			<span aria-hidden="true" className={`-mt-0.5 size-1 rounded-full ${running ? "bg-ink/80" : "bg-transparent"}`} />
			<span className="sr-only">
				{f ? `, folder, ${f.tiles.length} apps${f.running ? ", one running" : ""}` : t!.running ? `, ${t!.running}` : ""}
			</span>
		</button>
	);
}

/**
 * An open folder over the top level: its title and a panel of its apps. It
 * grows from its tile on the top level and, `leaving`, shrinks back into it,
 * then calls onGone.
 */
function FolderLayer({ f, leaving, listRef, onClose, onGone, children }: {
	f: Folder; leaving: boolean; listRef: RefObject<HTMLDivElement | null>; onClose(): void; onGone(): void; children: ReactNode;
}) {
	const layer = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null), head = useRef<HTMLHeadingElement>(null);
	/** The transform that puts the panel over the folder's face (null when either is not laid out). */
	const atFace = (): string | null => {
		const face = document.querySelector<HTMLElement>(`#launcher [data-folder="${CSS.escape(f.id)}"] [data-face]`);
		const p = panel.current;
		if (!face || !p) return null;
		const a = face.getBoundingClientRect(), b = p.getBoundingClientRect();
		if (!a.width || !b.width) return null;
		return `translate(${a.left + a.width / 2 - (b.left + b.width / 2)}px, ${a.top + a.height / 2 - (b.top + b.height / 2)}px) scale(${a.width / b.width})`;
	};
	useLayoutEffect(() => {
		if (reducedMotion()) return;
		const ease = "cubic-bezier(.2,.8,.2,1)";
		layer.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
		head.current?.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: ease });
		const from = atFace();
		panel.current?.animate([{ opacity: 0.5, transform: from ?? "scale(.92)" }, { opacity: 1, transform: "none" }], { duration: 280, easing: ease });
	}, []);
	useEffect(() => {
		if (!leaving) return;
		let done = false;
		const end = () => { if (!done) { done = true; onGone(); } };
		if (reducedMotion()) { end(); return; }
		const opts: KeyframeAnimationOptions = { duration: 180, easing: "cubic-bezier(.4,0,.7,.2)", fill: "forwards" };
		const to = atFace();
		const anims = [
			layer.current?.animate([{ opacity: 1 }, { opacity: 0 }], opts),
			panel.current?.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: to ?? "scale(.92)" }], opts),
		];
		if (anims[1]) anims[1].onfinish = end;
		const timer = setTimeout(end, 400); // a finish that never comes (a hidden tab)
		// Opened again before it was gone: it stays.
		return () => { done = true; clearTimeout(timer); for (const a of anims) a?.cancel(); };
	}, [leaving]);
	return (
		<div
			ref={layer} data-backdrop="1"
			onMouseDown={(e) => e.preventDefault()}
			onClick={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.backdrop) onClose(); }}
			className={`absolute inset-0 z-10 flex flex-col items-center justify-center bg-bg/40 pt-[max(16px,var(--st))] pr-[max(16px,var(--sr))] pb-[max(16px,var(--sb))] pl-[max(16px,var(--sl))] backdrop-blur-xl ${leaving ? "pointer-events-none" : ""}`}
		>
			<div data-backdrop="1" className="flex w-full max-w-[25rem] flex-col sm:max-w-[30rem]">
				<h2 ref={head} data-backdrop="1" className="mb-3 flex items-center gap-2.5 px-3 text-[26px] font-semibold tracking-tight text-ink [text-shadow:0_1px_3px_color-mix(in_srgb,var(--color-bg)_50%,transparent)]">
					<span aria-hidden="true" style={gradient(f.colors)} className="grid size-8 flex-none place-items-center rounded-[28%] text-[15px] shadow-[0_2px_8px_rgba(0,0,0,.45),inset_0_1px_0_rgba(255,255,255,.25)]">
						<AppGlyph icon={f.icon} className="size-[62%]" />
					</span>
					{f.title}
				</h2>
				<div ref={panel} className="rounded-[2rem] border border-ink/10 bg-(--launcher-panel) p-3 shadow-(--launcher-panel-shadow) backdrop-blur-2xl sm:p-5">
					<div ref={listRef} id="launcher-folder" role="listbox" aria-label={f.title}
						className={`grid gap-y-3 sm:gap-y-5 ${f.tiles.length > 9 ? "grid-cols-3 sm:grid-cols-4" : "grid-cols-3"}`}>
						{children}
					</div>
				</div>
			</div>
		</div>
	);
}

export function Launchpad() {
	const open = useStore((s) => s.launcher);
	return open ? <Pad /> : null;
}

function Pad() {
	const stopped = useStore(isStopped);
	const terms = useTermTabs((s) => s.terms);
	const windows = useWm((s) => s.windows);
	const installs = useInstalls();
	const coarse = !!KW.config.coarse;
	const [query, setQuery] = useState("");
	/** The open folder (its group's id); `layer` is the one drawn, which stays while it closes. */
	const [folder, setFolder] = useState<string | null>(null);
	const [layer, setLayer] = useState<string | null>(null);
	const [sel, setSel] = useState(0);
	/** The selection and the line under the grid show: from the start with a keyboard, on touch once a dimmed tile is tapped. */
	const [hint, setHint] = useState(!coarse);
	/** The top level's selection, back when the folder closes. */
	const topSel = useRef(0);
	const root = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const grid = useRef<HTMLDivElement>(null);
	const folderList = useRef<HTMLDivElement>(null);
	const q = query.trim().toLowerCase();
	usePins(); // a menu's Keep in Dock or Remove from Dock follows the pins
	/** The open menu: its app's tile or its folder (by id), the cell's index, and the point it opened at. */
	const [ctx, setCtx] = useState<{ id: string; folder: boolean; idx: number; at: DOMRect } | null>(null);
	/** A press outside the menu closed it: the launcher's own handlers leave that press alone. */
	const ignoreDown = useRef(false);

	const { top, folders, all } = useMemo(() => {
		const tileOf = (a: App): Tile => {
			const page = isPageApp(a);
			const why = !page && stopped ? "the system is not running" : unavailable(a);
			let running: string | null = null;
			if (page) running = a.win && windows.some((w) => w.id === a.win) ? "open" : null;
			else {
				const n = terms.find((x) => x.name === a.id)?.n;
				running = n ? `running in terminal ${n}` : null;
			}
			const pkgs = page ? [] : appPackages(a);
			const install = installs[a.id];
			const tip = install ? `${a.title}: ${install.state === "failed" ? "the install failed" : "installing"}, shows it`
				: why ? `${a.title}: ${why}` : running ? `${a.title}: ${running}, shows it`
				: page ? `${a.title}: ${a.desc}` : `${a.desc}${pkgs.length ? `\nInstalls: ${pkgs.join(" ")}` : ""}\nRuns: ${a.commands.join("; ")}`;
			return {
				app: a, id: a.id, title: a.title, desc: a.desc, icon: a.icon ?? a.title[0]!.toUpperCase(), colors: a.colors ?? GRAY,
				why, running, tip, group: GROUP_TITLE.get(a.group) ?? "", install,
			};
		};
		const pinned: Entry[] = [], folders: Folder[] = [], all: Tile[] = [];
		for (const g of GROUPS) {
			const tiles = g.apps.filter((a) => !a.hidden).map(tileOf);
			if (!tiles.length) continue;
			all.push(...tiles);
			if (g.inline) pinned.push(...tiles.map((tile) => ({ tile })));
			else folders.push({
				id: g.id, title: g.title, desc: g.desc ?? tiles.map((t) => t.title).join(", "), icon: g.icon ?? g.title[0]!.toUpperCase(), colors: g.colors ?? GRAY, tiles,
				running: tiles.some((t) => t.running), off: tiles.every((t) => t.why),
			});
		}
		return { top: [...pinned, ...folders.map((f): Entry => ({ folder: f }))], folders, all };
	}, [stopped, terms, windows, installs]);

	const results = q ? all.filter((t) => matches(t, q)).map((tile): Entry => ({ tile })) : null;
	const opened = folders.find((f) => f.id === folder);
	const items: Entry[] = results ?? (opened ? opened.tiles.map((tile) => ({ tile })) : top);
	const cur = items.length ? items[Math.min(sel, items.length - 1)] : undefined;
	const drawn = folders.find((f) => f.id === layer);
	/** The grid the selection moves in. */
	const list = () => (opened && !results ? folderList.current : grid.current);

	useEffect(() => {
		if (!coarse) input.current?.focus({ preventScroll: true });
		else {
			// Not the field (the on-screen keyboard): the overlay, so a hardware keyboard's keys stay here, not in a terminal.
			(document.activeElement as HTMLElement | null)?.blur?.();
			root.current?.focus({ preventScroll: true });
		}
	}, []);
	// Keep the selected tile in view as the keys move it.
	useEffect(() => {
		if (hint) list()?.querySelector(`[data-idx="${Math.min(sel, items.length - 1)}"]`)?.scrollIntoView({ block: "nearest" });
	}, [sel, folder, q, hint]);

	const openFolder = (id: string, idx: number) => {
		topSel.current = idx;
		setFolder(id);
		setLayer(id);
		setSel(0);
	};
	const closeFolder = () => {
		if (!folder) return;
		setFolder(null);
		setSel(topSel.current);
	};
	const pick = (e: Entry | undefined, idx: number) => {
		if (!e) return;
		if (e.folder) return openFolder(e.folder.id, idx);
		if (e.tile.why) { setSel(idx); setHint(true); return; }
		setLauncher(false);
		void launch(e.tile.app);
	};
	/** The focus back where the launcher keeps it: the search field, on touch the overlay. */
	const refocus = () => (coarse ? root.current : input.current)?.focus({ preventScroll: true });
	const openMenu = (e: Entry, at: DOMRect, idx: number) => {
		const id = e.folder ? e.folder.id : e.tile.id, folder = !!e.folder;
		setSel(idx);
		setCtx((c) => (c?.id === id && c.folder === folder ? c : { id, folder, idx, at })); // Android: a long press opens it twice
	};
	const closeMenu = (_how: MenuClose) => { setCtx(null); refocus(); };
	/** Keep in Dock or Remove from Dock, for an app or a folder's group. */
	const dockItem = (t: PinTarget): MenuEntry => (isPinned(t) ? { label: "Remove from Dock", run: () => unpin(t) } : { label: "Keep in Dock", run: () => pin(t) });
	/** An app's menu: Open (closes the launcher), then Keep in Dock or Remove from Dock. */
	const menuItems = (t: Tile): MenuEntry[] => {
		const items: MenuEntry[] = [{ label: "Open", disabled: !!t.why, run: () => { setLauncher(false); void launch(t.app); } }];
		if (canPin(t.app)) items.push(null, dockItem({ app: t.app }));
		return items;
	};
	/** A folder's menu: Open (the folder), then Keep in Dock or Remove from Dock (its group). */
	const folderItems = (f: Folder, idx: number): MenuEntry[] => {
		const items: MenuEntry[] = [{ label: "Open", run: () => openFolder(f.id, idx) }];
		const group = GROUPS.find((g) => g.id === f.id);
		if (canPinGroup(group)) items.push(null, dockItem({ group }));
		return items;
	};
	const ctxTile = ctx && !ctx.folder ? all.find((t) => t.id === ctx.id) : undefined;
	const ctxFolder = ctx?.folder && !q && !folder ? folders.find((f) => f.id === ctx.id) : undefined;
	const ctxHead = ctxTile?.title ?? ctxFolder?.title;
	useEffect(() => { if (ctx && !ctxHead) setCtx(null); }, [ctx, ctxHead]);
	// A press outside the open menu (which closes it, Menu.tsx) does nothing else: not the
	// backdrop's close, not a tile's or a folder's click. On the window, ahead of Menu's listener.
	useEffect(() => {
		if (!ctx) return;
		const down = (e: PointerEvent) => {
			if ((e.target as Element | null)?.closest?.("#launcher-menu")) return;
			ignoreDown.current = true;
			const eat = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
			const done = () => {
				removeEventListener("pointerup", done, true);
				removeEventListener("pointercancel", done, true);
				// The click, if any, comes right after the pointerup.
				setTimeout(() => { ignoreDown.current = false; removeEventListener("click", eat, true); }, 0);
			};
			addEventListener("click", eat, { capture: true, once: true });
			addEventListener("pointerup", done, true);
			addEventListener("pointercancel", done, true);
		};
		addEventListener("pointerdown", down, true);
		return () => removeEventListener("pointerdown", down, true);
	}, [ctx]);
	/** From tile i, the nearest tile in the next row up or down (the grids' columns vary with the width). */
	const vertical = (i: number, down: boolean): number => {
		const els = [...(list()?.querySelectorAll<HTMLElement>("[data-idx]") ?? [])];
		const c = els[i];
		if (!c) return i;
		const r = c.getBoundingClientRect(), cx = r.left + r.width / 2;
		const below = els.map((el) => {
			const b = el.getBoundingClientRect();
			return { j: Number(el.dataset.idx), dy: down ? b.top - r.bottom : r.top - b.bottom, dx: Math.abs(b.left + b.width / 2 - cx) };
		}).filter((x) => x.dy > -2);
		if (!below.length) return i;
		const row = Math.min(...below.map((x) => x.dy));
		return below.filter((x) => x.dy < row + 4).sort((a, b) => a.dx - b.dx)[0]!.j;
	};
	const onKey = (e: ReactKeyboardEvent) => {
		const n = items.length;
		const i = Math.max(0, Math.min(sel, n - 1));
		const arrow = e.key.startsWith("Arrow");
		// With a modifier an arrow edits the text (select, by word), as in any field.
		if (arrow && (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey)) return;
		if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
			// The selected app's or folder's menu, at its tile's middle.
			e.preventDefault();
			if (!cur) return;
			const r = list()?.querySelector(`[data-idx="${i}"]`)?.getBoundingClientRect();
			setHint(true);
			openMenu(cur, r ? new DOMRect(r.left + r.width / 2, r.top + r.height / 2, 0, 0) : new DOMRect(innerWidth / 2, innerHeight / 2, 0, 0), i);
		} else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
			if (!n) return;
			e.preventDefault();
			setHint(true);
			setSel(Math.min(n - 1, Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1))));
		} else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
			if (!n) return;
			e.preventDefault();
			setHint(true);
			setSel(vertical(i, e.key === "ArrowDown"));
		} else if (e.key === "Enter") {
			if (e.nativeEvent.isComposing) return; // an input method's Enter commits its text
			e.preventDefault();
			pick(cur, i);
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			if (folder && !results) closeFolder();
			else if (query) { setQuery(""); setSel(0); }
			else setLauncher(false);
		} else if (e.key === "Tab") {
			e.preventDefault(); // nothing else here takes the focus, and the page under it must not
		}
	};
	/** The hint's click: close the launcher (the focus goes back where it was) and arm the prefix, so the shortcuts HUD shows (KeysHud.tsx). */
	const showShortcuts = () => {
		setLauncher(false);
		KW.ui!.setPrefix(true);
	};
	const onType = (v: string) => {
		setQuery(v);
		setSel(0);
		// A search covers every group: the folder closes.
		if (v.trim() && folder) setFolder(null);
	};

	const cells = (entries: Entry[]) => entries.map((e, idx) => (
		<Cell key={optId(e)} e={e} idx={idx} on={hint && e === cur} onHover={() => setSel(idx)} onPick={() => pick(e, idx)}
			onMenu={(at) => openMenu(e, at, idx)} />
	));
	const line = !cur ? "" : cur.folder ? cur.folder.tiles.map((t) => t.title).join(" · ")
		: cur.tile.why ? `${cur.tile.title}: ${cur.tile.why}` : `${cur.tile.desc}${cur.tile.running ? ` · ${cur.tile.running}: ↵ shows it` : ""}`;

	return (
		<div
			id="launcher" ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Launcher" onKeyDown={onKey}
			onPointerDown={(e) => {
				if (ignoreDown.current) return; // it closed the app menu
				if (folder) return; // the folder's layer closes it on a click outside its panel
				if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.backdrop) setLauncher(false);
			}}
			className="fixed inset-0 z-(--z-launcher) flex flex-col items-center bg-(--launcher-dim) pt-[max(28px,calc(var(--st)+20px))] pb-[max(12px,var(--sb))] outline-none backdrop-blur-2xl backdrop-saturate-150 transition-[opacity,scale] duration-200 ease-out starting:scale-105 starting:opacity-0"
		>
			<label className="relative z-20 mb-5 flex w-[min(17rem,calc(100%-32px))] flex-none items-center sm:mb-8">
				<SearchIcon className="pointer-events-none absolute left-2.5 text-ink/60" />
				<input
					ref={input} type="search" value={query} onChange={(e) => onType(e.target.value)}
					placeholder="Search" aria-label="Search the apps" aria-controls={opened && !results ? "launcher-folder" : "launcher-grid"}
					aria-activedescendant={hint && cur ? optId(cur) : undefined} autoComplete="off" spellCheck={false}
					className="h-9 w-full rounded-xl border border-ink/15 bg-ink/10 pr-3 pl-8 text-[14px] text-ink placeholder:text-ink/50 focus:border-ink/30 focus:outline-none max-sm:text-[16px] [&::-webkit-search-cancel-button]:hidden"
				/>
			</label>
			<div data-backdrop="1" className="flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto overscroll-contain pr-[max(16px,var(--sr))] pb-4 pl-[max(16px,var(--sl))]">
				<div
					id="launcher-grid" ref={grid} role="listbox" aria-label={results ? "Search results" : "Apps"} data-backdrop="1"
					className={`grid w-full content-start gap-x-1 gap-y-4 sm:mt-[4vh] sm:gap-y-6 ${results ? "max-w-[34rem] grid-cols-4 sm:max-w-[42rem] sm:grid-cols-5" : "max-w-[34rem] grid-cols-4"}`}
				>
					{cells(results ?? top)}
					{results && !results.length && <p className="col-span-full pt-6 text-center text-ink/60">Nothing matches “{query.trim()}”.</p>}
				</div>
			</div>
			<p aria-live="polite" className={`pointer-events-none relative z-20 min-h-[2.75rem] w-[min(36rem,calc(100%-32px))] flex-none pt-2 text-center text-[12px] text-ink/60 ${hint ? "" : "invisible"}`}>
				<span className="block truncate">{line}</span>
				<span className="mt-1 block font-mono text-[11px] text-ink/40 max-sm:hidden">
					↵ open · arrows select · esc {folder ? "back" : "close"}
					{!coarse && <>
						{" · "}
						<span title={`${PREFIX}, then a key: the page's shortcuts`} onMouseDown={(e) => e.preventDefault()} onClick={showShortcuts}
							className="pointer-events-auto cursor-pointer whitespace-nowrap hover:text-ink/70">
							{PREFIX.split("-").map((k) => <kbd key={k} className="mr-0.5 rounded-[4px] border border-ink/20 px-1 font-mono text-[10px]">{k}</kbd>)} shortcuts
						</span>
					</>}
				</span>
			</p>
			{drawn && (
				<FolderLayer key={drawn.id} f={drawn} leaving={drawn.id !== folder} listRef={folderList} onClose={closeFolder} onGone={() => setLayer(null)}>
					{opened && !results ? cells(items) : cells(drawn.tiles.map((tile) => ({ tile })))}
				</FolderLayer>
			)}
			{ctx && ctxHead && <Menu id="launcher-menu" label={ctxHead} header={ctxHead} items={ctxTile ? menuItems(ctxTile) : folderItems(ctxFolder!, ctx.idx)} anchor={ctx.at} point onClose={closeMenu} />}
		</div>
	);
}
