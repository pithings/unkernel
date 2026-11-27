// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// What shows over the desktop, all in the alert family of Dialog.tsx: the
// confirm dialog (ui.ask()), the paste dialog (the key bar's Paste where the
// Clipboard API is unavailable), the Resume card after Suspend (and the
// Continue card while paused) in the middle of the desktop, and the toast, a
// small notification under the top bar. The boot's progress is the top
// bar's boot indicator (BootIndicator.tsx).
import { useEffect, useRef } from "react";
import { inSurface, isField } from "../focus.ts";
import { KW } from "../kw.ts";
import { useStore } from "../store.ts";
import { fmtMiB } from "../format.ts";
import { Alert, AlertButton, AlertContent, Dialog } from "./Dialog.tsx";
import { Mark } from "./icons.tsx";

/**
 * After Suspend: a card in the middle of the desktop with Resume, which
 * reloads the page and resumes (ui.resume()). Paused by hand (boot.ts,
 * autosuspend.ts Pause): the same card with Continue, which lets the held
 * machine go on. Not modal: App.tsx puts it over every window (the display,
 * the preview, the terminal windows), whose last screen shows dimmed behind
 * it; the dim takes no clicks, so the terminal still scrolls.
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
		// Not ownsKeys(): from a Dock or top bar button (a Suspend picked there) Resume takes the focus.
		const a = document.activeElement;
		if (inSurface(a) || isField(a)) return;
		resume.current?.focus({ preventScroll: true });
	}, [suspended]);
	if (!suspended && !paused) return null;
	const msg = suspended
		? `The system is saved in this browser${bytes ? ` (${fmtMiB(bytes)})` : ""}.`
		: "The session is saved in this browser: you can close this tab.";
	return (
		<div id="resume-card" data-paused={(!suspended && paused) || undefined}
			className="pointer-events-none absolute inset-0 z-(--z-resume) grid place-items-center bg-bg/30 px-4">
			<section role="region" aria-labelledby="resume-card-title" className="alert pointer-events-auto">
				<AlertContent id="resume-card" icon="pause" title={suspended ? "Suspended" : "Paused"} msg={msg} msgRole="status"
					actions={suspended
						? <AlertButton id="resume" ref={resume} kind="primary" aria-describedby="resume-card-msg" onClick={() => KW.ui!.resume()}>Resume</AlertButton>
						: <AlertButton id="continue" kind="primary" aria-describedby="resume-card-msg" onMouseDown={(e) => e.preventDefault()}
							onClick={() => { KW.continuePaused?.(); if (!KW.config.coarse) KW.term?.focus(); }}>Continue</AlertButton>} />
				{!suspended && !KW.config.coarse && <p className="alert-hint mt-2.5">or press any key</p>}
			</section>
		</div>
	);
}

/**
 * The toast (ui.toast()): a small notification over everything that goes by
 * itself, under the top bar: at the top right, or at the top in the middle
 * on narrow screens (style.css .toast). The mark, the message, and maybe a
 * button (`action`, ui.toastAction()); a mouse click on it leaves the focus
 * where it was (the terminal). Only a toast with a button takes presses.
 */
export function Toast() {
	const t = useStore((s) => s.toast);
	// Keep the last message while it fades out.
	const last = useRef<{ msg: string; action?: string }>({ msg: "" });
	if (t) last.current = t;
	return (
		<div id="toast" role="status" aria-live="polite" data-show={!!t || undefined} data-action={!!t?.action || undefined} className="toast">
			<Mark size={20} className="flex-none" />
			<span className="min-w-0 break-words">{last.current.msg}</span>
			{t?.action && (
				<button id="toast-action" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => KW.ui!.toastAction()}
					className="btn btn-sm flex-none">{t.action}</button>
			)}
		</div>
	);
}

/**
 * The paste dialog: a sheet near the top (clear of the on-screen keyboard)
 * with a text area to paste into; Send (or Ctrl-Enter, ⌘-Enter) types it
 * into the terminal, Cancel or Esc closes it. Enter makes a new line.
 */
export function PasteDialog() {
	const open = useStore((s) => s.pasteOpen);
	const text = useRef<HTMLTextAreaElement>(null);
	useEffect(() => { if (open && text.current) { text.current.value = ""; text.current.focus(); } }, [open]);
	const ui = KW.ui!;
	const send = () => ui.sendPaste(text.current?.value ?? "");
	return (
		<Dialog id="paste" open={open} onCancel={() => ui.closePaste()} size="sheet" labelledBy="paste-title" describedBy="paste-msg" className="alert-top"
			onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }}>
			{open && (
				<AlertContent id="paste" title="Paste into the terminal" msg="Long-press the field and choose Paste, then Send."
					actions={<>
						<AlertButton id="paste-cancel" onClick={() => ui.closePaste()}>Cancel</AlertButton>
						<AlertButton id="paste-send" kind="primary" title="Send (Ctrl-Enter)" onClick={send}>Send</AlertButton>
					</>}>
					<textarea id="paste-text" ref={text} aria-label="Text to paste" placeholder="Paste here" autoCapitalize="off" autoComplete="off" spellCheck={false}
						className="field mt-3 block h-30 w-full resize-y p-2.5 text-left text-[13px] pointer-coarse:text-base" />
				</AlertContent>
			)}
		</Dialog>
	);
}

/**
 * The confirm dialog (ui.ask()): the open question as an Alert (Dialog.tsx),
 * #confirm with #confirm-ok and #confirm-cancel. OK has the focus, so Enter
 * confirms, as with confirm(); y confirms and n cancels too, as in tmux.
 * A question from the guest (`untrusted`, open.ts) confirms only after a
 * moment. ui.ts queues the questions: the next one shows when this one is
 * answered.
 */
export function Confirm() {
	const ask = useStore((s) => s.ask);
	const ui = KW.ui!;
	return (
		<Alert id="confirm" open={!!ask} seq={ask?.id} icon={ask?.icon} title={ask?.title ?? ""} msg={ask?.msg} detail={ask?.url}
			ok={ask?.ok ?? "OK"} cancel={ask?.cancel} danger={ask?.danger} untrusted={ask?.untrusted} yesNo
			onAnswer={(ok) => { if (ask) ui.answer(ok, ask.id); }} />
	);
}
