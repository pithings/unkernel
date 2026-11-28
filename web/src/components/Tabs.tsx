// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A compact tab strip for a window's title bar (wm.ts titleContent; the
// Terminal windows' is components/TerminalTabs.tsx): one tab per item, its
// label truncated, faint while busy and in the error colour on an error, an
// optional close × (shown on the active tab and on hover; always on coarse
// pointers), an optional key hint on it (which-key style), and a + at the
// end (dimmed while newOff: it needs what is not there yet). The + runs onNew; a right click, a Shift-click or a long press runs
// onNewAlt when given (a new window, say). It scrolls sideways when the tabs
// do not fit (a wheel scrolls it too) and keeps the active tab in view.
// Presses never move the keyboard focus (the window's content keeps it), and
// the strip takes only its tabs' width, so the rest of a title bar still
// moves the window. Coarse pointers get taller targets (36 px and up).
import { useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { useLongPress } from "../hooks.ts";
import { CloseIcon, PlusIcon } from "./icons.tsx";
import { KeyHint } from "./KeyHint.tsx";

export interface TabItem {
	key: number | string;
	label: string;
	/** The tooltip (default: the label). */
	title?: string;
	/** The tab button's element id. */
	id?: string;
	state?: "busy" | "error";
	closable?: boolean;
	/** Its key after the shortcut prefix, shown on the tab while the prefix is armed (KeyHint.tsx). */
	hint?: string;
}

/** How long a press on + is held for onNewAlt (ms; with any pointer, wherever it moves on the +). */
const LONG_MS = 500;
const keepFocus = (e: ReactMouseEvent) => e.preventDefault();

export function Tabs<K extends number | string>({ items, active, label, onSelect, onClose, onNew, onNewAlt, newId, newOff, newTitle = "New tab", className = "" }: {
	items: Array<TabItem & { key: K }>;
	active: K;
	/** The tab list's accessible name. */
	label: string;
	onSelect: (key: K) => void;
	onClose?: (key: K) => void;
	/** Shows the +. */
	onNew?: () => void;
	onNewAlt?: () => void;
	newId?: string;
	/** The + is there but disabled (style.css data-off); its handlers still run (they say why). */
	newOff?: boolean;
	newTitle?: string;
	className?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const long = useLongPress(onNewAlt && (() => onNewAlt()), { ms: LONG_MS, mouse: true, slop: Infinity });

	// Keep the active tab in view (by hand: scrollIntoView would scroll the window's ancestors too).
	useLayoutEffect(() => {
		const box = ref.current, el = box?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.parentElement;
		if (!box || !el) return;
		if (el.offsetLeft < box.scrollLeft) box.scrollLeft = el.offsetLeft;
		else if (el.offsetLeft + el.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = el.offsetLeft + el.offsetWidth - box.clientWidth;
	}, [active, items.length]);

	return (
		<div ref={ref} role="tablist" aria-label={label} onMouseDown={keepFocus}
			onWheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}
			className={`tabs relative flex h-full min-w-0 items-stretch gap-0.5 overflow-x-auto py-1 select-none [scrollbar-width:none] pointer-coarse:py-0.5 [&::-webkit-scrollbar]:hidden ${className}`}
			style={{ touchAction: "pan-x" }}
		>
			{items.map((t) => {
				const on = t.key === active;
				return (
					<div key={t.key} data-active={on || undefined} data-state={t.state}
						className="group flex max-w-44 min-w-0 flex-none items-center rounded-md text-faint transition-colors hover:bg-ink/5 hover:text-muted data-active:bg-ink/10 data-active:text-fg data-[state=busy]:opacity-60 data-[state=error]:text-err!"
					>
						<button id={t.id} type="button" role="tab" aria-selected={on} title={t.title ?? t.label} onClick={() => onSelect(t.key)}
							className={`relative flex h-full min-w-0 items-center gap-1.5 truncate font-mono text-[12px] pointer-coarse:min-w-11 pointer-coarse:text-[13px] ${t.closable ? "pr-0.5 pl-2.5" : "px-2.5"}`}
						>
							{t.hint && <KeyHint k={t.hint} inline />}
							<span className="truncate">{t.label}</span>
						</button>
						{t.closable && onClose && (
							<button type="button" aria-label={`Close ${t.label}`} title={`Close ${t.label}`} onClick={() => onClose(t.key)}
								className="mr-0.5 grid h-5 w-5 flex-none place-items-center rounded opacity-0 transition-opacity group-hover:opacity-100 group-data-active:opacity-100 hover:bg-ink/10 hover:text-fg pointer-coarse:h-8 pointer-coarse:w-8 pointer-coarse:opacity-100"
							><CloseIcon size={11} /></button>
						)}
					</div>
				);
			})}
			{onNew && (
				<button id={newId} type="button" title={newTitle} aria-label={newTitle} aria-disabled={newOff || undefined} data-off={newOff || undefined}
					{...long.handlers}
					onContextMenu={(e) => { if (!onNewAlt) return; e.preventDefault(); if (!long.context()) onNewAlt(); }}
					onClick={(e) => { if (long.consumed()) return; if (e.shiftKey && onNewAlt) onNewAlt(); else onNew(); }}
					className="grid w-7 flex-none place-items-center rounded-md text-faint transition-colors [-webkit-touch-callout:none] hover:bg-ink/8 hover:text-fg pointer-coarse:w-10"
				><PlusIcon size={14} /></button>
			)}
		</div>
	);
}
