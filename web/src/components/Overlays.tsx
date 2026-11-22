// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The splash card over the stage (before the terminal shows the boot, and
// for an early failure), the Resume card after Suspend (and the Continue
// card while paused) in the middle of the stage, the toast, and the paste dialog (the key bar's Paste
// where the Clipboard API is unavailable).
import { useEffect, useRef, useState } from "react";
import { KW } from "../kw.ts";
import { useStore } from "../store.ts";
import { fmtMiB } from "../ui.ts";
import { Mark } from "./icons.tsx";

/**
 * Startup normally takes well under a second before the terminal shows the
 * boot, so the card stays invisible unless that is slow or something fails.
 * index.html has the same markup, for a page module that never runs.
 */
export function Splash() {
	const s = useStore((st) => st.splash);
	const [slow, setSlow] = useState(() => Date.now() - KW.t0 >= 1500);
	useEffect(() => {
		if (slow) return;
		const t = setTimeout(() => setSlow(true), Math.max(0, 1500 - (Date.now() - KW.t0)));
		return () => clearTimeout(t);
	}, [slow]);
	if (s.hidden) return null;
	return (
		<div id="splash" role="status" aria-live="polite" data-slow={slow || undefined} data-error={s.error || undefined}
			className="group absolute inset-0 z-1 grid place-items-center bg-bg p-5">
			<div className="invisible w-full max-w-[420px] text-center group-data-error:visible group-data-slow:visible">
				<Mark size={44} className="mx-auto mb-5" />
				<h1 id="splash-title" className="mb-1.5 font-mono text-[15px] font-medium tracking-tight group-data-error:text-err">{s.title}</h1>
				<p id="splash-msg" className="font-mono text-[12.5px] break-words text-muted group-data-error:whitespace-pre-wrap group-data-error:text-fg">{s.msg}</p>
				{s.details && <button id="splash-details" type="button" className="btn mt-5" onClick={() => KW.ui!.openPanel("errors")}>Show details</button>}
			</div>
		</div>
	);
}

/**
 * After Suspend: a card in the middle of the stage with Resume, which
 * reloads the page and resumes (ui.resume()). Paused by hand (boot.ts,
 * autosuspend.ts Pause): the same card with Continue, which lets the held
 * machine go on. App.tsx puts it over every window (the display, the
 * preview, the terminal windows), whose last screen shows dimmed behind it;
 * the dim takes no clicks, so the terminal still scrolls.
 *
 * Focus: Resume takes it when the card appears (the stopped machine takes no
 * keys), so Enter or Space resumes; not from a field or dialog the user is
 * in. Continue does not: any key typed for the guest continues (boot.ts
 * guestKey), so the focus stays in the terminal; Tab reaches the button.
 */
export function ResumeCard() {
	const suspended = useStore((s) => s.suspended);
	const paused = useStore((s) => s.paused);
	const bytes = useStore((s) => s.suspendedBytes);
	const resume = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!suspended) return;
		const a = document.activeElement;
		if (a?.closest?.("#panel, #confirm, #paste, #launcher, #copy-area") || (a?.closest?.("input, select, textarea, [contenteditable]") && !a.closest("#terms"))) return;
		resume.current?.focus({ preventScroll: true });
	}, [suspended]);
	if (!suspended && !paused) return null;
	const title = suspended ? "suspended" : "paused";
	const msg = suspended
		? `The system is saved in this browser${bytes ? ` (${fmtMiB(bytes)})` : ""}.`
		: "The session is saved in this browser: you can close this tab.";
	return (
		<div id="resume-card" data-paused={(!suspended && paused) || undefined}
			className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/40 px-4">
			<section role="region" aria-labelledby="resume-card-title"
				className="pointer-events-auto relative w-[min(360px,100%)] border border-line-strong bg-bg px-5 pt-6 pb-5 font-mono text-[12.5px] shadow-[0_16px_48px_rgba(0,0,0,.8)]">
				<h2 id="resume-card-title" className="absolute -top-2 left-3 bg-bg px-1.5 text-[12px] leading-4 font-normal"><span className="text-faint">┤</span> {title} <span className="text-faint">├</span></h2>
				<p id="resume-card-msg" role="status" className="leading-relaxed text-muted">{msg}</p>
				{suspended
					? <button id="resume" ref={resume} type="button" aria-describedby="resume-card-msg"
						className="btn btn-primary mt-4 w-full pointer-coarse:h-11" onClick={() => KW.ui!.resume()}>Resume</button>
					: <>
						<button id="continue" type="button" aria-describedby="resume-card-msg"
							className="btn btn-primary mt-4 w-full pointer-coarse:h-11" onMouseDown={(e) => e.preventDefault()}
							onClick={() => { KW.continuePaused?.(); if (!KW.config.coarse) KW.term?.focus(); }}>Continue</button>
						{!KW.config.coarse && <p className="mt-2 text-center text-[11.5px] text-faint">or press any key</p>}
					</>}
			</section>
		</div>
	);
}

/**
 * The toast (ui.toast()): a line at the bottom right, over everything, that
 * goes by itself. One may carry a button (`action`, ui.toastAction()); a
 * mouse click on it leaves the focus where it was (the terminal).
 */
export function Toast() {
	const t = useStore((s) => s.toast);
	// Keep the last message while it fades out.
	const last = useRef<{ msg: string; action?: string }>({ msg: "" });
	if (t) last.current = t;
	return (
		<div id="toast" role="status" aria-live="polite" data-show={!!t || undefined}
			className={`${t?.action ? "pointer-events-auto flex items-center gap-3" : "pointer-events-none"} fixed right-[max(12px,var(--sr))] bottom-[calc(var(--bar-h)+var(--sb)+8px)] z-40 max-w-[min(640px,calc(100%-24px))] translate-y-1 bg-fg px-2.5 py-1.5 font-mono text-[12px] text-black opacity-0 shadow-[0_8px_30px_rgba(0,0,0,.6)] transition-[opacity,translate] duration-150 data-show:translate-y-0 data-show:opacity-100`}>
			<span>{last.current.msg}</span>
			{t?.action && (
				<button id="toast-action" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => KW.ui!.toastAction()}
					className="flex-none cursor-pointer border border-black px-2 py-0.5 font-medium hover:bg-black hover:text-fg">{t.action}</button>
			)}
		</div>
	);
}

export function PasteDialog() {
	const open = useStore((s) => s.pasteOpen);
	const text = useRef<HTMLTextAreaElement>(null);
	useEffect(() => { if (open && text.current) { text.current.value = ""; text.current.focus(); } }, [open]);
	if (!open) return null;
	return (
		<div id="paste" role="dialog" aria-modal="true" aria-label="Paste text"
			className="fixed top-[18%] left-1/2 z-30 w-[min(460px,calc(100%-24px))] -translate-x-1/2 border border-line-strong bg-bg px-4 pt-5 pb-4 font-mono text-[12.5px] shadow-[0_16px_48px_rgba(0,0,0,.8)]">
			<b className="absolute -top-2 left-3 bg-bg px-1.5 text-[12px] leading-4 font-normal"><span className="text-faint">┤</span> paste into the terminal <span className="text-faint">├</span></b>
			<textarea id="paste-text" ref={text} placeholder="Long-press here and choose Paste" autoCapitalize="off" autoComplete="off" spellCheck={false}
				className="field h-30 w-full resize-y p-2 text-[13px]" />
			<div className="mt-3 flex justify-end gap-2">
				<button id="paste-cancel" type="button" className="btn btn-sm" onClick={() => KW.ui!.closePaste()}>Cancel</button>
				<button id="paste-send" type="button" className="btn btn-sm btn-primary" onClick={() => KW.ui!.sendPaste(text.current?.value ?? "")}>Send</button>
			</div>
		</div>
	);
}

/** How long OK waits before it confirms, for a question from the guest. */
const UNTRUSTED_MS = 700;

/**
 * The confirm dialog (ui.ask()): a native modal <dialog>, so the page under
 * it is inert, focus stays in it and Esc cancels, with the browser doing it.
 * OK has focus, so Enter confirms, as with confirm(); y confirms and n
 * cancels too, as in tmux. Closing returns focus to where it was. A question
 * from the guest (`untrusted`, open.ts) has OK focused too, but OK, Enter
 * and y confirm only after UNTRUSTED_MS (OK is dimmed until then, not
 * disabled, which would lose the focus), so a key or a click meant for the
 * terminal does not confirm it.
 */
export function Confirm() {
	const ask = useStore((s) => s.ask);
	const ref = useRef<HTMLDialogElement>(null), ok = useRef<HTMLButtonElement>(null);
	const [armed, setArmed] = useState(0);
	useEffect(() => {
		const d = ref.current!;
		if (!ask) { if (d.open) d.close(); return; }
		if (!d.open) d.showModal();
		ok.current?.focus();
		if (!ask.untrusted) return;
		const t = setTimeout(() => setArmed(ask.id), UNTRUSTED_MS);
		return () => clearTimeout(t);
	}, [ask]);
	const waiting = !!ask?.untrusted && armed !== ask.id;
	const ui = KW.ui!;
	return (
		<dialog id="confirm" ref={ref} aria-labelledby="confirm-title" aria-describedby="confirm-msg"
			onCancel={(e) => { e.preventDefault(); ui.answer(false); }} onClose={() => ui.answer(false)}
			onKeyDown={(e) => {
				if (e.ctrlKey || e.altKey || e.metaKey || e.repeat || (e.key !== "y" && e.key !== "n")) return;
				e.preventDefault();
				if (e.key === "y" && waiting) return;
				ui.answer(e.key === "y");
			}}
			className="m-auto w-[min(420px,calc(100%-24px))] overflow-visible border border-line-strong bg-bg px-4 pt-5 pb-4 font-mono text-[12.5px] text-fg shadow-[0_16px_48px_rgba(0,0,0,.8)] backdrop:bg-black/65">
			{ask && (
				<>
					<h2 id="confirm-title" className="absolute -top-2 left-3 bg-bg px-1.5 text-[12px] leading-4 font-normal"><span className="text-faint">┤</span> {ask.title} <span className="text-faint">├</span></h2>
					<p id="confirm-msg" className="leading-relaxed text-muted">{ask.msg}</p>
					{ask.url && <p id="confirm-url" className="mt-3 max-h-40 overflow-y-auto border border-line px-2 py-1.5 break-all whitespace-pre-wrap text-fg">{ask.url}</p>}
					<div className="mt-4 flex justify-end gap-2">
						<button id="confirm-cancel" type="button" title="Cancel (n, Esc)" className="btn btn-sm" onClick={() => ui.answer(false)}>{ask.cancel ?? "Cancel"}</button>
						<button id="confirm-ok" ref={ok} type="button" aria-disabled={waiting || undefined} title={`${ask.ok} (y, Enter)`} className={`btn btn-sm ${waiting ? "cursor-default opacity-50" : ""} ${ask.danger ? "btn-danger" : "btn-primary"}`} onClick={() => { if (!waiting) ui.answer(true); }}>{ask.ok}</button>
					</div>
				</>
			)}
		</dialog>
	);
}
