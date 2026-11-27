// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's alerts, sheets and cards, in the manner of macOS alerts
// (style.css .alert, .btn): a flat surface with a thin
// even edge, a soft shadow and a 16 px radius; the unkernel mark on top (with
// a caution, error or pause badge), a semibold centred title, a smaller muted
// message, an optional detail line (a URL, in mono), an optional body, and
// rounded buttons side by side, stacked once their labels do not fit (the
// default one on top). Geist Sans at 13 px; 44 px buttons on coarse pointers.
// - Dialog: a native modal <dialog> (the top layer, the page under it inert,
//   focus kept in it and given back when it closes, ::backdrop a light dim):
//   open follows the prop, pointer lock is released first (the pointer must
//   reach the buttons), Esc (and a close the browser forces) calls onCancel,
//   and keys typed in it go no further (no terminal, display or guest sees
//   them; the page's capture listeners leave dialogs alone).
// - Alert: a question in a Dialog with OK and Cancel, as ui.ask() asks it
//   (Overlays.tsx Confirm). OK has the focus; Enter on anything but another
//   button, and y with `yesNo`, confirm; n and Esc cancel. A held key's
//   repeats and a Space released that was pressed before the question
//   appeared do nothing. `untrusted` (the guest asks): OK, Enter and y work
//   only UNTRUSTED_MS after the question appeared (OK is dimmed, not disabled,
//   which would lose the focus), so a key or a click meant for the terminal
//   cannot confirm it.
// - AlertContent, AlertIconView, AlertButton: the parts, for cards that are
//   not modal: the Resume card and the toast (Overlays.tsx), and ErrorCard,
//   a failure with its hint and actions (the boot failure's card).
import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { capitalize } from "../format.ts";
import { Mark } from "./icons.tsx";

/** The icon over the title: the mark, or the mark with a badge. */
export type AlertIcon = "mark" | "caution" | "error" | "pause";
/** Widths: alert 280 px (a question), wide 360 px (a URL, a failure), sheet 440 px (a body to type in). */
export type AlertSize = "alert" | "wide" | "sheet";

/** How long OK waits before it confirms, for a question from the guest. */
export const UNTRUSTED_MS = 700;

const SIZE: Record<AlertSize, string> = { alert: "", wide: "alert-wide", sheet: "alert-sheet" };


const BADGES: Record<Exclude<AlertIcon, "mark">, ReactNode> = {
	caution: <>
		<path d="M12 2.6 22.8 21.2H1.2Z" fill="#f5a524" stroke="var(--alert-bg)" strokeWidth="1.6" strokeLinejoin="round" />
		<path d="M12 9.2v5.2" stroke="#000" strokeWidth="2.2" strokeLinecap="round" />
		<circle cx="12" cy="17.7" r="1.3" fill="#000" />
	</>,
	error: <>
		<circle cx="12" cy="12" r="10.2" fill="#e5484d" stroke="var(--alert-bg)" strokeWidth="1.6" />
		<path d="M12 6.8v6.4" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
		<circle cx="12" cy="16.9" r="1.3" fill="#fff" />
	</>,
	pause: <>
		<circle cx="12" cy="12" r="10.2" fill="#3a3a3a" stroke="var(--alert-bg)" strokeWidth="1.6" />
		<path d="M9.4 8.2v7.6M14.6 8.2v7.6" stroke="#ededed" strokeWidth="2.2" strokeLinecap="round" />
	</>,
};

/** The mark, 48 px, with its badge at the bottom right. */
export function AlertIconView({ icon, size = 48 }: { icon: AlertIcon; size?: number }) {
	return (
		<div aria-hidden="true" className="relative mx-auto" style={{ width: size, height: size }}>
			<Mark size={size} />
			{icon !== "mark" && (
				<svg width={size / 2} height={size / 2} viewBox="0 0 24 24" className="absolute -right-1.5 -bottom-1.5">{BADGES[icon]}</svg>
			)}
		</div>
	);
}

/** A button of an alert or card: primary (white, or black), danger (red) or secondary (quiet). */
export function AlertButton({ kind = "secondary", className = "", ...rest }: ComponentProps<"button"> & { kind?: "primary" | "danger" | "secondary" }) {
	const tone = kind === "primary" ? "btn-primary" : kind === "danger" ? "btn-danger" : "";
	return <button type="button" {...rest} className={`btn btn-alert ${tone} ${className}`} />;
}

/**
 * The inside of an alert or card: icon, title (`${id}-title`), message
 * (`${id}-msg`), detail (`${id}-detail`, mono, scrolls past 10 lines), the
 * body (children) and the buttons (`actions`).
 */
export function AlertContent({ id, icon, title, msg, msgRole, detail, children, actions }: {
	id: string;
	icon?: AlertIcon;
	title: string;
	msg?: ReactNode;
	/** The message's role ("status": the Resume card's, read when it changes). */
	msgRole?: string;
	detail?: string;
	children?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<>
			{icon && <AlertIconView icon={icon} />}
			<h2 id={`${id}-title`} className="alert-title">{capitalize(title)}</h2>
			{msg && <p id={`${id}-msg`} role={msgRole} className="alert-msg">{msg}</p>}
			{detail && <p id={`${id}-detail`} className="alert-detail">{detail}</p>}
			{children}
			{actions && <div className="alert-actions">{actions}</div>}
		</>
	);
}

export interface DialogProps {
	id: string;
	open: boolean;
	/** Esc, or the browser closing it (a second Esc without a click in between). */
	onCancel: () => void;
	size?: AlertSize;
	/** Its accessible name: the title's id, or a label. */
	labelledBy?: string;
	label?: string;
	describedBy?: string;
	onKeyDown?: (e: KeyboardEvent<HTMLDialogElement>) => void;
	onKeyUp?: (e: KeyboardEvent<HTMLDialogElement>) => void;
	className?: string;
	children?: ReactNode;
}

/** A native modal <dialog> with the alert surface (see the file's header). */
export function Dialog({ id, open, onCancel, size = "alert", labelledBy, label, describedBy, onKeyDown, onKeyUp, className = "", children }: DialogProps) {
	const ref = useRef<HTMLDialogElement>(null);
	const cancel = useRef(onCancel);
	cancel.current = onCancel;
	useEffect(() => {
		const d = ref.current!;
		if (!open) { if (d.open) d.close(); return; }
		if (document.pointerLockElement) document.exitPointerLock();
		if (!d.open) d.showModal();
	}, [open]);
	return (
		<dialog id={id} ref={ref} aria-labelledby={labelledBy} aria-label={label} aria-describedby={describedBy}
			onCancel={(e) => { e.preventDefault(); cancel.current(); }}
			// A close the page did not ask for (the browser's own); a late close event from an earlier close finds it open again.
			onClose={() => { if (open && !ref.current?.open) cancel.current(); }}
			onKeyDown={(e) => { e.stopPropagation(); onKeyDown?.(e); }}
			onKeyUp={(e) => { e.stopPropagation(); onKeyUp?.(e); }}
			className={`alert ${SIZE[size]} ${className}`}>
			{children}
		</dialog>
	);
}

export interface AlertProps {
	id: string;
	open: boolean;
	/** A new value for each question shown (re-arms `untrusted`, focuses OK again). */
	seq?: number | string;
	icon?: AlertIcon;
	title: string;
	msg?: ReactNode;
	detail?: string;
	ok: string;
	/** The other button's label (default "Cancel"); null: no other button. */
	cancel?: string | null;
	danger?: boolean;
	untrusted?: boolean;
	/** y confirms and n cancels too, as in tmux. */
	yesNo?: boolean;
	size?: AlertSize;
	onAnswer: (ok: boolean) => void;
	children?: ReactNode;
}

/** A question with OK and Cancel in a Dialog (see the file's header); its buttons are `${id}-ok` and `${id}-cancel`. */
export function Alert({ id, open, seq, icon, title, msg, detail, ok, cancel = "Cancel", danger, untrusted, yesNo, size, onAnswer, children }: AlertProps) {
	const okRef = useRef<HTMLButtonElement>(null);
	const [armed, setArmed] = useState<unknown>(null);
	// Keys pressed since this question appeared: a Space released that went down before it does not click.
	const downs = useRef(new Set<string>());
	useEffect(() => {
		if (!open) return;
		downs.current.clear();
		okRef.current?.focus();
		if (!untrusted) return;
		const t = setTimeout(() => setArmed(seq), UNTRUSTED_MS);
		return () => clearTimeout(t);
	}, [open, seq, untrusted]);
	const waiting = !!untrusted && armed !== seq;
	const confirm = () => { if (!waiting) onAnswer(true); };
	const key = (e: KeyboardEvent<HTMLDialogElement>) => {
		if (e.ctrlKey || e.altKey || e.metaKey) return;
		const k = e.key, t = e.target as HTMLElement;
		if (e.repeat) { if (k === "Enter" || k === " " || k === "y") e.preventDefault(); return; }
		downs.current.add(k);
		if (yesNo && (k === "y" || k === "n")) { e.preventDefault(); if (k === "y") confirm(); else onAnswer(false); return; }
		if (k === "Enter" && !t.closest("button, textarea, input, select, a")) { e.preventDefault(); confirm(); }
		// The focused OK: Enter clicks it natively, so the wait applies there too.
		else if (k === "Enter" && t === okRef.current && waiting) e.preventDefault();
	};
	const keyUp = (e: KeyboardEvent<HTMLDialogElement>) => { if (e.key === " " && !downs.current.has(" ")) e.preventDefault(); };
	const body = detail || children;
	return (
		<Dialog id={id} open={open} onCancel={() => onAnswer(false)} size={size ?? (body ? "wide" : "alert")}
			labelledBy={`${id}-title`} describedBy={msg ? `${id}-msg` : undefined} onKeyDown={key} onKeyUp={keyUp}>
			{open && (
				<AlertContent id={id} icon={icon ?? (danger ? "caution" : "mark")} title={title} msg={msg} detail={detail}
					actions={<>
						{cancel !== null && <AlertButton id={`${id}-cancel`} title={yesNo ? "Cancel (n, Esc)" : "Cancel (Esc)"} onClick={() => onAnswer(false)}>{cancel}</AlertButton>}
						<AlertButton id={`${id}-ok`} ref={okRef} kind={danger ? "danger" : "primary"} aria-disabled={waiting || undefined}
							title={`${ok} (${yesNo ? "y, " : ""}Enter)`} onClick={confirm}>{ok}</AlertButton>
					</>}>
					{children}
				</AlertContent>
			)}
		</Dialog>
	);
}

/**
 * A failure, not modal: the mark with the error badge, the title, the
 * message, an optional hint (smaller, faint) and the buttons (AlertButton).
 * For the boot failure where the desktop shows it; role="alert".
 */
export function ErrorCard({ id = "error-card", title, msg, hint, actions, className = "" }: {
	id?: string;
	title: string;
	msg: ReactNode;
	hint?: ReactNode;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<section id={id} role="alert" aria-labelledby={`${id}-title`} aria-describedby={`${id}-msg`} className={`alert alert-wide ${className}`}>
			<AlertContent id={id} icon="error" title={title} msg={msg} actions={actions}>
				{hint && <p className="alert-hint">{hint}</p>}
			</AlertContent>
		</section>
	);
}
