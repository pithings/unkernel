// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The app installer: what the launcher (launcher.ts) shows while an app is
// prepared before its first run (its files written, its downloads fetched
// and pushed, its packages installed), as a small window of its own per app
// (components/Installer.tsx draws it), so the user can keep working, minimize
// it, or start another install meanwhile. An app that needs nothing of that
// starts at once and never shows one (launcher.ts decides, from one check in
// the guest).
//
// - The window (wm.ts, id install-<app id>, appId "installer") is
//   fixed-size (wm.ts resizable) and carries the app's descriptor (as
//   appwindows.ts appMeta() makes it), so it is the app as far as the chrome
//   goes: the app's pinned Dock tile stands for it, else a tile of its own
//   with the app's icon; both, and the app's launcher tile, have a progress
//   bar over the face (components/Installer.tsx TileProgress, from
//   useInstalls()). Busy while it runs, error once it failed (the running
//   dot). In compact mode it is drawn maximized like any window, and the
//   view centres itself as a sheet. Showing or hiding the log grows or
//   shrinks it about its middle.
// - The work is the launcher's: runInstall(app, meta, content, task) runs task(ctl) and
//   resolves true once it succeeded (the window closes by itself and the
//   launcher starts the app), or false once the user cancelled it or closed
//   it after a failure. A failure keeps the window, with the error, the log
//   opened, and Retry (task runs again, from the start).
// - Progress: the task declares weighted stages (ctl.plan()) and reports
//   each one's share done (ctl.stage(); null: not known). The bar is the
//   weighted sum and never goes back; it is indeterminate only until
//   something is known. ctl.step() is the one line under the title.
// - Cancel: only while the task says it is safe (ctl.cancelable()): the
//   page's own work (writing files, fetching, pushing) and the package
//   manager's downloads; never while packages unpack (an apt or apk stopped
//   there leaves them half installed). ctl.signal aborts, and the process
//   the task registered (ctl.onCancel()) is hung up. The window's close
//   button cancels when that is safe, else minimizes the window: the install
//   goes on.
// - The machine held (Pause, a suspend in the background: store.ts isHeld)
//   shows as Paused; nothing else changes (the guest's work waits with it).
//   One that stops the machine ends the install's process: a failure.
// - packageParser(distro): the package manager's output (apk's "(3/12)
//   Installing" lines; apt's APT::Status-Fd lines, dlstatus and pmstatus, on
//   stdout) as progress, step and safety; status lines stay out of the log.
import { useSyncExternalStore, type ReactNode } from "react";
import type { AppIcon, AppMeta, Distro } from "./apps/types.ts";
import { KW } from "./kw.ts";
import { createStore } from "./store.ts";
import { wm } from "./wm.ts";

/** At most this many log lines are kept (the first ones go). */
const MAX_LINES = 4000;
/** The window's width, and its height without and with the log. */
export const INSTALLER_W = 440, INSTALLER_H = 178, INSTALLER_H_LOG = 440;

export type InstallState = "running" | "failed";

export interface Install {
	/** The app's id. */
	id: string;
	title: string;
	icon: string | AppIcon;
	colors?: [string, string];
	state: InstallState;
	/** The line under the title: what it does now, or the failure. */
	step: string;
	/** 0 to 1, or null while nothing is known (an indeterminate bar). */
	progress: number | null;
	cancelable: boolean;
	/** The log is shown. */
	logOpen: boolean;
}

/** The installs by app id (a finished one's key stays, undefined: the store's set() merges). */
export const installs$ = createStore<Record<string, Install | undefined>>({});
/** Each install's log lines (kept out of the store: it changes often), and a count bumped when they change (logSeq$: only the log view follows it). */
const logs = new Map<string, string[]>();
const logSeq$ = createStore<Record<string, number>>({});

export const installWinId = (appId: string): string => `install-${appId}`;
export const logOf = (appId: string): string[] => logs.get(appId) ?? [];

function patch(id: string, p: Partial<Install>): void {
	const cur = installs$.get()[id];
	if (cur) installs$.set({ [id]: { ...cur, ...p } });
}

/** The installs, re-rendering when one changes. */
export function useInstalls(): Record<string, Install | undefined> {
	return useSyncExternalStore(installs$.subscribe, installs$.get);
}
/** The count bumped when app id's log lines change (logOf()). */
export function useLogSeq(appId: string): number {
	return useSyncExternalStore(logSeq$.subscribe, () => logSeq$.get()[appId] ?? 0);
}
/** One app's install, or undefined. */
export function useInstall(appId: string): Install | undefined {
	return useSyncExternalStore(installs$.subscribe, () => installs$.get()[appId]);
}

/** What a task gets to report with (see the top of this file). */
export interface InstallCtl {
	/** Aborts on Cancel. */
	signal: AbortSignal;
	/** The stages and their weights (any scale), in order; resets the stages' progress (not the bar). */
	plan(stages: [key: string, weight: number][]): void;
	/** Stage `key`'s share done, 0 to 1 (null: not known); the stages before it count as done. */
	stage(key: string, done: number | null): void;
	/** The line under the title. */
	step(text: string): void;
	/** A line of the log (ANSI escapes and carriage-return rewrites are cleaned here). */
	log(text: string): void;
	cancelable(on: boolean): void;
	/** What Cancel does besides aborting the signal (hang up a process); null: nothing. */
	onCancel(f: (() => void) | null): void;
}

/** A cancel, as the task's error. */
export class InstallCancelled extends Error {
	constructor() { super("cancelled"); this.name = "InstallCancelled"; }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>]/g;
/** A line as the log shows it: no escapes, and what a carriage return rewrote. */
export function cleanLine(s: string): string {
	const t = s.replace(ANSI, "").replace(/\r+$/, "");
	const i = t.lastIndexOf("\r");
	return i < 0 ? t : t.slice(i + 1);
}

interface Running {
	abort: AbortController;
	cancel: (() => void) | null;
	stages: [string, number][];
	/** The bar, as shown. */
	shown: number | null;
	/** Retry or Close, once failed. */
	decide: ((retry: boolean) => void) | null;
	/** Lines not yet published; the timer that publishes them. */
	pending: boolean;
	timer: ReturnType<typeof setTimeout> | null;
}
const running = new Map<string, Running>();

/** Cancel the install of app id when that is safe (else nothing). */
export function cancelInstall(id: string): void {
	const r = running.get(id), cur = installs$.get()[id];
	if (!r || !cur || cur.state !== "running" || !cur.cancelable) return;
	r.abort.abort(new InstallCancelled());
	try { r.cancel?.(); } catch { /* gone already */ }
}
/** After a failure: run it again. */
export const retryInstall = (id: string): void => { const r = running.get(id); r?.decide?.(true); };
/** After a failure: close it. */
export const dismissInstall = (id: string): void => { const r = running.get(id); r?.decide?.(false); };
/** Show or hide the log; the window grows to hold it (not maximized, not in compact mode, where it fills the screen). */
export function toggleInstallLog(id: string, open?: boolean): void {
	const cur = installs$.get()[id];
	if (!cur) return;
	const on = open ?? !cur.logOpen;
	if (on === cur.logOpen) return;
	patch(id, { logOpen: on });
	// Grown or shrunk about its middle.
	const w = wm.get(installWinId(id));
	if (!w || w.maximized || !w.placed) return; // not placed yet: compact mode, where it fills the screen anyway
	const h = on ? INSTALLER_H_LOG : INSTALLER_H;
	wm.resize(w.id, { h, y: Math.max(0, Math.round(w.y - (h - w.h) / 2)) });
}

/** The app's installer window, shown and focused, if it has one (false: none). */
export function showInstaller(appId: string): boolean {
	if (!installs$.get()[appId]) return false;
	wm.focus(installWinId(appId));
	return true;
}

/**
 * Run an app's preparation in an installer window (see the top of this
 * file): true once it succeeded, false once cancelled or closed after a
 * failure. `meta`: the app's descriptor (its Dock tile); `content`: the
 * window's content (components/Installer.tsx for this app), given by the
 * caller so this module needs no components.
 */
export function runInstall(app: { id: string; title: string; icon?: string | AppIcon; colors?: [string, string] }, meta: AppMeta,
	content: ReactNode, task: (ctl: InstallCtl) => Promise<void>): Promise<boolean> {
	const id = app.id;
	if (running.has(id)) { showInstaller(id); return Promise.resolve(false); }
	logs.set(id, []);
	installs$.set({ [id]: {
		id, title: app.title, icon: app.icon ?? app.title.charAt(0).toUpperCase(), colors: app.colors,
		state: "running", step: "Preparing…", progress: null, cancelable: true, logOpen: false,
	} });
	const winId = installWinId(id);
	const r: Running = {
		abort: new AbortController(), cancel: null, stages: [], shown: null, decide: null, pending: false, timer: null,
	};
	running.set(id, r);
	const publish = () => {
		r.timer = null;
		if (!r.pending) return;
		r.pending = false;
		logSeq$.set((s) => ({ [id]: (s[id] ?? 0) + 1 }));
	};
	const done: Record<string, number | null> = {};
	const ctl: InstallCtl = {
		get signal() { return r.abort.signal; },
		plan(stages) { r.stages = stages.filter(([, w]) => w > 0); for (const k of Object.keys(done)) delete done[k]; },
		stage(key, frac) {
			const i = r.stages.findIndex(([k]) => k === key);
			if (i < 0) return;
			for (let j = 0; j < i; j++) done[r.stages[j]![0]] = 1;
			done[key] = frac === null ? (done[key] ?? null) : Math.min(1, Math.max(0, frac));
			const total = r.stages.reduce((a, [, w]) => a + w, 0) || 1;
			const known = r.stages.some(([k]) => done[k] !== undefined && done[k] !== null);
			if (!known) return;
			const v = r.stages.reduce((a, [k, w]) => a + w * (done[k] ?? 0), 0) / total;
			// Never back: a stage that starts over (apt-get update between two tries) holds the bar.
			// In steps of a quarter percent, so a chatty package manager does not redraw it on every line.
			const next = Math.max(r.shown ?? 0, Math.floor(v * 400) / 400);
			if (next !== r.shown) { r.shown = next; patch(id, { progress: next }); }
		},
		step(text) { if (installs$.get()[id]?.step !== text) patch(id, { step: text }); },
		log(text) {
			const lines = logs.get(id);
			if (!lines) return;
			for (const raw of text.split("\n")) lines.push(cleanLine(raw));
			if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
			r.pending = true;
			r.timer ??= setTimeout(publish, 120);
		},
		cancelable(on) { if (installs$.get()[id]?.cancelable !== on) patch(id, { cancelable: on }); },
		onCancel(f) { r.cancel = f; },
	};

	wm.open({
		id: winId, meta, appId: "installer", title: app.title, dockId: `dock-${winId}`,
		content,
		w: INSTALLER_W, h: INSTALLER_H, minW: 300, minH: INSTALLER_H, resizable: false, status: "busy",
		// Focused, it takes the keyboard from what had it (a terminal under it), as Settings does; not on touch devices.
		onFocus: () => requestAnimationFrame(() => {
			const el = document.getElementById(`installer-${id}`);
			if (el && !el.contains(document.activeElement) && !KW.config?.coarse) el.focus({ preventScroll: true });
		}),
		onClose: () => {
			const cur = installs$.get()[id];
			if (!cur) return true;
			if (cur.state === "failed") { dismissInstall(id); return false; }
			if (cur.cancelable) { cancelInstall(id); return false; }
			wm.minimize(winId); // it cannot stop now: it goes on out of sight
			return false;
		},
	});

	const finish = (ok: boolean) => {
		if (r.timer) clearTimeout(r.timer);
		running.delete(id);
		logs.delete(id);
		installs$.set({ [id]: undefined });
		wm.remove(winId);
		return ok;
	};
	return (async () => {
		for (;;) {
			try {
				await task(ctl);
				publish();
				return finish(true);
			} catch (e) {
				if (r.abort.signal.aborted || e instanceof InstallCancelled) return finish(false);
				const msg = (e as Error)?.message ?? String(e);
				ctl.log(`[installer] ${msg}`);
				publish();
				patch(id, { state: "failed", step: msg, cancelable: false });
				toggleInstallLog(id, true);
				wm.update(winId, { status: "error" });
				const retry = await new Promise<boolean>((res) => { r.decide = res; });
				r.decide = null;
				if (!retry) return finish(false);
				// Again from the start; the bar too.
				r.abort = new AbortController();
				r.cancel = null;
				r.shown = null;
				ctl.log("[installer] retrying");
				patch(id, { state: "running", step: "Preparing…", progress: null, cancelable: true });
				wm.update(winId, { status: "busy" });
			}
		}
	})();
}

// ---- the package manager's output as progress ----------------------------------

/** What a line of the package manager's output says. */
export interface PackageLine {
	/** Keep it out of the log (an apt status line). */
	hide?: boolean;
	/** The packages stage's share done. */
	done?: number;
	step?: string;
	/** Stopping now would leave packages half installed. */
	unsafe?: boolean;
}

/**
 * A parser of one install's output (install.sh, launcher.ts) for this
 * distro: each line in, what it says out. apt: APT::Status-Fd on stdout
 * (dlstatus: the downloads, 0 to 35% of the stage; pmstatus: dpkg's run, 35
 * to 100%), its summary line for the package count, dpkg's own lines, the
 * lock wait. apk: "(i/n) Installing|Upgrading" (i of n), its index fetches.
 * pacman: "installing NAME..." lines against its "Packages (N)" line, its
 * other stages by their ":: " headings.
 */
export function packageParser(distro: Distro): (line: string) => PackageLine {
	let total = 0;
	const seen = new Set<string>();
	if (distro === "alpine") {
		return (line) => {
			const m = /^\((\d+)\/(\d+)\) (Installing|Upgrading|Replacing|Purging|Downgrading|Reinstalling) /.exec(line);
			if (m) {
				const i = Number(m[1]), n = Number(m[2]);
				return { done: n ? (i - 1) / n : 0, step: `Installing ${i} of ${n} packages…`, unsafe: true };
			}
			if (/^Executing /.test(line)) return { step: "Finishing…", unsafe: true };
			if (/^fetch /.test(line)) return { step: "Updating package lists…" };
			if (/^OK: /.test(line)) return { done: 1 };
			if (/^\$ .*apk add/.test(line)) return { step: "Installing packages…" };
			return {};
		};
	}
	if (distro === "arch") {
		// On a pipe pacman prints "installing NAME..." without a count: the total is
		// the "Packages (N)" line's, and n the lines seen since it (a transaction run
		// again after pacman -Sy starts over).
		let n = 0;
		return (line) => {
			let m = /^Packages \((\d+)\)/.exec(line);
			if (m) { total = Number(m[1]); n = 0; return {}; }
			if (/^(installing|upgrading|reinstalling|downgrading|removing) \S+\.\.\.$/.test(line)) {
				n++;
				return { done: total ? (n - 1) / total : 0, step: total ? `Installing ${n} of ${total} packages…` : "Installing packages…", unsafe: true };
			}
			if (/^Waiting for another install/.test(line)) return { step: "Waiting for another install…" };
			if (/^:: Synchronizing package databases/.test(line)) return { step: "Updating package lists…" };
			if (/^:: Retrieving packages/.test(line)) return { step: "Downloading packages…" };
			if (/^:: Running post-transaction hooks/.test(line)) return { step: "Finishing…", unsafe: true };
			if (/^\$ .*pacman -S /.test(line)) return { step: "Installing packages…" };
			return {};
		};
	}
	return (line) => {
		let m = /^dlstatus:(\d+):([\d.]+):(.*)$/.exec(line);
		if (m) {
			const f = /(\d+) of (\d+)/.exec(m[3]!);
			return { hide: true, done: 0.35 * (Number(m[2]) / 100), step: f ? `Downloading ${f[1]} of ${f[2]} packages…` : "Downloading packages…" };
		}
		m = /^pmstatus:([^:]*):([\d.]+):(.*)$/.exec(line);
		if (m) {
			const pkg = m[1]!;
			if (pkg && pkg !== "dpkg-exec") seen.add(pkg.replace(/:.*$/, ""));
			const k = Math.max(1, Math.min(seen.size, total || seen.size));
			return { hide: true, done: 0.35 + 0.65 * (Number(m[2]) / 100), unsafe: true, step: total ? `Installing ${k} of ${total} packages…` : "Installing packages…" };
		}
		if (/^(pmconffile|media-change):/.test(line)) return { hide: true };
		m = /^(\d+) upgraded, (\d+) newly installed/.exec(line);
		if (m) { total = Number(m[1]) + Number(m[2]); return {}; }
		if (/^(Preparing to unpack|Unpacking|Selecting previously unselected|Setting up) /.test(line)) return { unsafe: true };
		if (/^\$ .*dpkg --configure/.test(line)) return { unsafe: true, step: "Finishing an interrupted install…" };
		if (/Waiting for cache lock|Could not get lock/.test(line)) return { step: "Waiting for another install…" };
		if (/^(Reading package lists|Building dependency tree|Reading state information)/.test(line)) return { step: "Resolving packages…" };
		if (/^(Hit|Get|Ign):\d+ .*(InRelease|Release|Packages)/.test(line)) return { step: "Updating package lists…" };
		return {};
	};
}
