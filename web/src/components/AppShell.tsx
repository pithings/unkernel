// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The frame of a system app's window (sysapps.ts: Settings and System): a
// section list and one section shown at a time, with a footer of actions.
// - Wide windows (from WIDE px, measured on the window, not the viewport) get
//   the list as a sidebar on the left; narrow ones (phones, a small window) a
//   row of segments over the section, which scrolls sideways when it must.
// - The list is ARIA tabs (vertical in the sidebar): one tab stop, the arrow
//   keys (either axis), Home and End move between sections, and the focus
//   follows the selection. Each section is a tabpanel with a real heading.
//   The list has class `tabs` and each tab data-tab (its section, the old
//   dialog's tab names where it had them), which the browser tests click.
// - One scroll container for the sections (a new section starts at its top;
//   System's kernel log keeps itself at its end), passed to the sections that
//   follow it.
// - A section with changes not applied yet has a dot after its name.
// - Coarse pointers get taller tabs (and style.css taller buttons and fields).
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useSize } from "../hooks.ts";
import { apps$, selectSection, type AppId } from "../sysapps.ts";
import type { Tab } from "../store.ts";

/** From this width (px) the section list is a sidebar. */
const WIDE = 600;

export interface SectionDef {
	id: Tab;
	name: string;
	icon: ReactNode;
	/** A count after the name (System's errors), with its element id. */
	badge?: { text: string; id?: string; tone?: "err" };
	/** A line under the heading. */
	desc?: ReactNode;
	/** It has changes not applied yet (Settings: options that take a reboot): a dot after the name. */
	changed?: boolean;
}

/** A sub-heading in a section: ── Title ─────── */
export const H3 = ({ children }: { children: ReactNode }) => (
	<h3 className="mt-6 mb-3 flex items-center gap-2 font-sans text-[12px] font-medium text-faint first:mt-1">
		{children}<span className="flex-1 border-t border-line" />
	</h3>
);

/** A key, as the sections show them. */
export const K = ({ children }: { children: ReactNode }) => <kbd className="mx-0.5 font-mono text-muted">{children}</kbd>;

/** The app's current section (re-renders when it changes). */
export function useSection(app: AppId): Tab {
	return useSyncExternalStore(apps$.subscribe, () => apps$.get()[app]);
}

export function AppShell({ app, label, sections, render, footer }: {
	app: AppId;
	label: string;
	sections: SectionDef[];
	/** A section's content; `body` is the scroll container. */
	render: (id: Tab, body: RefObject<HTMLDivElement | null>) => ReactNode;
	footer?: ReactNode;
}) {
	const section = useSection(app);
	const [root, setRoot] = useState<HTMLDivElement | null>(null);
	const list = useRef<HTMLDivElement>(null);
	const body = useRef<HTMLDivElement>(null);
	// Measured on the window; a hidden one (width 0: minimized, parked) keeps its layout.
	const { w } = useSize(root);
	const [wide, setWide] = useState(false);
	if (w && (w >= WIDE) !== wide) setWide(w >= WIDE);
	// A new section starts at its top; focus on a tab follows the selection (arrows, shortcuts), as tabs do.
	useEffect(() => {
		if (body.current) body.current.scrollTop = 0;
		const tab = list.current?.querySelector<HTMLElement>(`[data-tab="${section}"]`);
		if (list.current?.contains(document.activeElement)) tab?.focus({ preventScroll: true });
		tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
	}, [section]);

	const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.ctrlKey || e.altKey || e.metaKey) return;
		const i = Math.max(0, sections.findIndex((s) => s.id === section)), n = sections.length;
		const to = ({ ArrowUp: i - 1, ArrowLeft: i - 1, ArrowDown: i + 1, ArrowRight: i + 1, Home: 0, End: n - 1 } as Record<string, number>)[e.key];
		if (to === undefined) return;
		e.preventDefault();
		selectSection(sections[(to + n) % n]!.id);
	};

	return (
		<div ref={setRoot} className="flex h-full flex-col bg-bg text-fg">
			<div className={`flex min-h-0 flex-1 ${wide ? "flex-row" : "flex-col"}`}>
				<div ref={list} role="tablist" aria-label={`${label} sections`} aria-orientation={wide ? "vertical" : "horizontal"} onKeyDown={onKey}
					className={`tabs flex flex-none gap-1 select-none ${wide
						? "w-48 flex-col overflow-y-auto border-r border-line bg-surface p-2"
						: "overflow-x-auto border-b border-line px-2 py-2 [scrollbar-width:none]"}`}>
					{sections.map((s) => {
						const on = s.id === section;
						return (
							<button key={s.id} id={`tab-${s.id}`} type="button" role="tab" data-tab={s.id} aria-selected={on} aria-controls={`pane-${s.id}`}
								tabIndex={on ? 0 : -1} onClick={() => selectSection(s.id)}
								className={wide
									? "flex h-8 flex-none items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg aria-selected:bg-ink/10 aria-selected:text-fg pointer-coarse:h-11"
									: "flex h-8 flex-none items-center gap-2 rounded-full border border-line px-3 text-[13px] text-muted transition-colors hover:text-fg aria-selected:border-fg aria-selected:bg-fg aria-selected:text-bg pointer-coarse:h-10"}>
								<span className="flex flex-none opacity-80">{s.icon}</span>
								<span className="min-w-0 flex-1 truncate">{s.name}</span>
								{s.changed && <><span aria-hidden="true" className="size-1.5 flex-none rounded-full bg-warn" /><span className="sr-only">, changed</span></>}
								{s.badge && <span id={s.badge.id} className={`font-mono text-[11.5px] tabular-nums ${s.badge.tone === "err" && !(on && !wide) ? "text-err" : ""}`}>{s.badge.text}</span>}
							</button>
						);
					})}
				</div>
				<div ref={body} className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
					{sections.map((s) => (
						<section key={s.id} id={`pane-${s.id}`} data-pane={s.id} role="tabpanel" aria-labelledby={`pane-${s.id}-title`} hidden={s.id !== section}
							className={`font-mono text-[12.5px] ${wide ? "px-6 pt-5 pb-6" : "px-4 pt-4 pb-5"}`}>
							<h2 id={`pane-${s.id}-title`} className="font-sans text-[17px] font-semibold tracking-tight text-fg">{s.name}</h2>
							{s.desc && <p className="mt-1 font-sans text-[12.5px] text-faint">{s.desc}</p>}
							<div className="mt-4">{render(s.id, body)}</div>
						</section>
					))}
				</div>
			</div>
			{footer && (
				<div className="flex flex-none flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-3 py-2 select-none">{footer}</div>
			)}
		</div>
	);
}
