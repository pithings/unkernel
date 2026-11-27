// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A small popup menu in the chrome's glass (style.css .glass): the Dock's
// tile menus (Dock.tsx), and any other menu that opens against an element.
// It is fixed to the viewport, above its anchor's rect and centred on it
// (below it when there is no room above), or with `point` (a context menu at
// the pointer, DesktopMenu.tsx) its top left corner at the anchor's (left or
// up of it where there is no room), 8 px inside the viewport's edges,
// so render it where no ancestor has a transform or filter (the Dock renders
// it in #dock, outside its tiles). role="menu" with menuitems: the first
// enabled one takes the focus; arrows (wrapping), Home and End move it;
// Enter or Space picks; Esc or Tab, a press outside it, a resize or the
// page losing the focus close it. Keys typed while it has the focus stay in
// it (no terminal, display or guest sees them). It does not give the focus
// back: onClose says how it closed, and the opener decides (the Dock: to the
// tile after Esc, not after a pick, which shows a window).
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOutsidePress } from "../hooks.ts";

export interface MenuItem {
	/** The item's element id (for tests and docs). */
	id?: string;
	label: string;
	icon?: ReactNode;
	/** Its shortcut, shown on the right ("Ctrl-A n"). */
	keys?: string;
	disabled?: boolean;
	run: () => void;
}
/** An item, or null: a separator. */
export type MenuEntry = MenuItem | null;
/** How it closed: an item was picked, Esc or Tab, or a press outside (a resize, the page losing the focus). */
export type MenuClose = "pick" | "key" | "away";

const EDGE = 8, GAP = 8;

export function Menu({ id, label, header, items, anchor, point, onClose }: {
	id?: string;
	/** Its accessible name (the header's text, when there is one). */
	label: string;
	/** A small title over the items (not focusable). */
	header?: string;
	items: MenuEntry[];
	anchor: DOMRect;
	/** At the anchor's top left (a point: the pointer), not above it. */
	point?: boolean;
	onClose: (how: MenuClose) => void;
}) {
	const box = useRef<HTMLDivElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		const w = el.offsetWidth, h = el.offsetHeight;
		if (point) {
			const x = anchor.left + w > innerWidth - EDGE ? anchor.left - w : anchor.left;
			const y = anchor.top + h > innerHeight - EDGE ? anchor.top - h : anchor.top;
			setPos({ left: Math.max(EDGE, Math.min(x, innerWidth - EDGE - w)), top: Math.max(EDGE, Math.min(y, innerHeight - EDGE - h)) });
			return;
		}
		let top = anchor.top - GAP - h;
		if (top < EDGE) top = Math.min(anchor.bottom + GAP, innerHeight - EDGE - h);
		const left = Math.min(Math.max(EDGE, anchor.left + anchor.width / 2 - w / 2), innerWidth - EDGE - w);
		setPos({ left: Math.max(EDGE, left), top: Math.max(EDGE, top) });
	}, [anchor, point, items.length, header]);
	const enabled = () => [...(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
	useOutsidePress(box, () => close.current("away"));
	useEffect(() => {
		enabled()[0]?.focus({ preventScroll: true });
		const away = () => close.current("away");
		addEventListener("resize", away);
		addEventListener("blur", away);
		return () => {
			removeEventListener("resize", away);
			removeEventListener("blur", away);
		};
	}, []);
	const key = (e: KeyboardEvent<HTMLDivElement>) => {
		e.stopPropagation();
		const list = enabled(), i = list.indexOf(document.activeElement as HTMLButtonElement);
		const go = (n: number) => list[(n + list.length) % list.length]?.focus();
		switch (e.key) {
			case "ArrowDown": go(i + 1); break;
			case "ArrowUp": go(i < 0 ? -1 : i - 1); break;
			case "Home": go(0); break;
			case "End": go(-1); break;
			case "Escape": case "Tab": close.current("key"); break;
			case "Enter": case " ": (document.activeElement as HTMLElement | null)?.click(); break;
			default: if (e.key.length !== 1) return;
		}
		e.preventDefault();
	};
	// In <body>, over everything in the page (the toast included), whatever its owner's stacking context.
	return createPortal(
		<div ref={box} id={id} role="menu" aria-label={label} onKeyDown={key} onContextMenu={(e) => e.preventDefault()}
			className="popover fixed z-(--z-menu) flex max-h-[calc(100dvh-16px)] max-w-72 min-w-44 flex-col overflow-y-auto rounded-xl py-1 font-mono text-[12.5px] select-none"
			style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0 }}>
			{header && <div aria-hidden="true" className="truncate px-3 pt-1.5 pb-1 font-sans text-[11.5px] font-medium text-faint">{header}</div>}
			{items.map((it, i) => it === null
				? <div key={`sep-${i}`} role="separator" className="my-1 border-t border-ink/10" />
				: (
					<button key={it.label} id={it.id} type="button" role="menuitem" disabled={it.disabled} onClick={() => { close.current("pick"); it.run(); }}
						className="flex items-center gap-2.5 px-3 py-2 text-left text-muted enabled:hover:bg-ink/10 enabled:hover:text-fg focus-visible:bg-ink/10 focus-visible:text-fg focus-visible:outline-none disabled:cursor-default disabled:opacity-40 pointer-coarse:py-3">
						<span aria-hidden="true" className="inline-flex w-[13px] flex-none justify-center">{it.icon}</span>
						<span className="truncate">{it.label}</span>
						{it.keys && <span className="ml-auto pl-4 text-[11px] text-faint">{it.keys}</span>}
					</button>
				))}
		</div>,
		document.body,
	);
}
