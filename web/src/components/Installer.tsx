// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// An app's installer window (installer.ts runs it; launcher.ts opens it for
// an app that lacks packages or downloads): the app's icon (a flat tile in
// its colour) and name, one line for the current step (Paused while the
// machine is held; the error once failed, in red), one progress bar (the
// accent; red once failed; a sliding piece while nothing is known yet), a
// Log disclosure, and Cancel (dimmed while stopping would leave packages
// half installed) or, failed, Close and Retry. The log: the install's real
// output in mono, kept at its end while it grows unless the user scrolled up
// (scrolling back to the end follows again), with a copy button.
// TileProgress: the same install as a bar over the app's tile (the Dock's,
// the launcher's).
// Ids: #installer-<app> (data-state running or failed), its -step, -bar,
// -log, -last (the log's newest line while the log is closed), -cancel,
// -retry and -close.
// In compact mode the window fills the screen: the content is a column at
// most 440 px wide, in the middle while the log is closed, like a sheet.
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { cancelInstall, dismissInstall, logOf, retryInstall, toggleInstallLog, useInstall, useLogSeq, type Install } from "../installer.ts";
import { KW } from "../kw.ts";
import { isHeld, isRunning, useStore } from "../store.ts";
import { AppGlyph, CheckIcon, ChevronIcon, CopyIcon } from "./icons.tsx";

/** The app's icon: a flat rounded tile in its first colour, its glyph in white. */
function Face({ inst }: { inst: Install }) {
	const style: CSSProperties = { background: inst.colors?.[0] ?? "#3f3f46" };
	return (
		<span aria-hidden="true" style={style} className="grid size-11 flex-none place-items-center rounded-[11px] text-[22px] leading-none text-white">
			<AppGlyph icon={inst.icon} className="size-[58%]" />
		</span>
	);
}

/** The bar: `value` 0 to 1, or null (indeterminate). */
export function ProgressBar({ id, value, failed, label }: { id?: string; value: number | null; failed?: boolean; label: string }) {
	const pct = value === null ? undefined : Math.round(value * 100);
	return (
		<div id={id} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
			className="inst-bar" data-indeterminate={value === null || undefined} data-failed={failed || undefined}>
			<span style={{ width: `${pct ?? 0}%` }} />
		</div>
	);
}

/** An app's install as a bar over its tile's face (style.css .tile-progress: the Dock's, the launcher's), or nothing; `className` places it. */
export function TileProgress({ inst, className = "" }: { inst: Install | undefined; className?: string }) {
	if (!inst) return null;
	const failed = inst.state === "failed";
	const v = failed ? inst.progress ?? 1 : inst.progress;
	return (
		<span aria-hidden="true" className={`tile-progress ${className}`} data-failed={failed || undefined} data-indeterminate={v === null || undefined}>
			<span style={{ width: `${Math.round((v ?? 0) * 100)}%` }} />
		</span>
	);
}

/** The log: the lines as text, kept at the end unless scrolled up; a copy button. */
function Log({ inst }: { inst: Install }) {
	const ref = useRef<HTMLPreElement>(null);
	const stick = useRef(true);
	const [copied, setCopied] = useState(false);
	const seq = useLogSeq(inst.id);
	const lines = logOf(inst.id);
	useLayoutEffect(() => {
		const el = ref.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [seq]);
	const copy = () => {
		const text = logOf(inst.id).join("\n");
		navigator.clipboard?.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		}, () => KW.ui?.toast("Could not copy the log: the clipboard is not available"));
	};
	return (
		<div className="relative mt-3 min-h-0 flex-1">
			<pre ref={ref} id={`installer-${inst.id}-log`} tabIndex={0} aria-label="Log"
				onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 12; }}
				className="h-full overflow-auto rounded-lg border border-ink/8 bg-bg py-2 pr-9 pl-2.5 font-mono text-[11px] leading-[1.5] break-all whitespace-pre-wrap text-muted outline-none select-text focus-visible:border-accent/60">
				{lines.join("\n")}
			</pre>
			<button type="button" title="Copy" aria-label="Copy the log" onClick={copy}
				className="absolute top-1.5 right-2.5 grid size-6 place-items-center rounded-md bg-bg text-faint transition-colors hover:bg-ink/10 hover:text-fg">
				{copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
			</button>
		</div>
	);
}

/** The log's newest line, by the closed log's disclosure: what the install is printing right now. */
function LastLine({ id }: { id: string }) {
	useLogSeq(id);
	const lines = logOf(id);
	let line = "";
	for (let i = lines.length - 1; i >= 0 && !line; i--) line = lines[i]!.trim();
	return <span id={`installer-${id}-last`} aria-hidden="true" className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted/70">{line}</span>;
}

export function Installer({ id }: { id: string }) {
	const inst = useInstall(id);
	const held = useStore(isHeld);
	const canRetry = useStore((s) => isRunning(s) && !isHeld(s));
	if (!inst) return null;
	const failed = inst.state === "failed";
	const step = failed ? inst.step : held ? "Paused" : inst.step;
	const p = `installer-${id}`;
	return (
		<div id={p} data-state={inst.state} role="group" aria-labelledby={`${p}-title`} tabIndex={-1}
			className={`flex h-full flex-col bg-(--alert-bg) font-sans text-[13px] text-fg outline-none ${inst.logOpen ? "" : "justify-center"}`}>
			<div className={`mx-auto flex w-full max-w-[440px] flex-col px-4 pt-4 pb-3 ${inst.logOpen ? "min-h-0 flex-1" : ""}`}>
				<div className="flex items-center gap-3">
					<Face inst={inst} />
					<div className="min-w-0 flex-1">
						<h2 id={`${p}-title`} className="truncate font-semibold">{inst.title}</h2>
						<p id={`${p}-step`} role="status" title={step} className={`mt-0.5 truncate text-[12px] ${failed ? "text-err" : "text-muted"}`}>{step}</p>
					</div>
				</div>
				<div className="mt-3">
					<ProgressBar id={`${p}-bar`} value={inst.progress} failed={failed} label={`Installing ${inst.title}`} />
				</div>
				<div className="mt-3 flex items-center gap-2">
					<button type="button" aria-expanded={inst.logOpen} aria-controls={`${p}-log`} onClick={() => toggleInstallLog(id)}
						className="-ml-1 flex h-7 items-center gap-1 rounded-md px-1 text-[12px] text-muted transition-colors hover:text-fg">
						<span className={`flex transition-transform ${inst.logOpen ? "rotate-90" : ""}`}><ChevronIcon size={12} /></span>
						Log
					</button>
					{inst.logOpen ? <span className="flex-1" /> : <LastLine id={id} />}
					{failed ? (
						<>
							<button id={`${p}-close`} type="button" className="btn btn-sm" onClick={() => dismissInstall(id)}>Close</button>
							<button id={`${p}-retry`} type="button" className="btn btn-sm btn-primary" disabled={!canRetry} onClick={() => retryInstall(id)}
								title={canRetry ? undefined : "Once the system runs"}>Retry</button>
						</>
					) : (
						<button id={`${p}-cancel`} type="button" className="btn btn-sm" aria-disabled={!inst.cancelable || undefined}
							title={inst.cancelable ? undefined : "Packages are being installed: stopping now would break them"}
							onClick={() => cancelInstall(id)}>Cancel</button>
					)}
				</div>
				{inst.logOpen && <Log inst={inst} />}
			</div>
		</div>
	);
}
