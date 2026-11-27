// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page chrome's imperative side: the API that main.ts and boot.ts drive
// (KW.ui: state, boot stages, environment checks, kernel log, errors,
// toast, data disk status, Reboot) on top of the store (store.ts) that the
// React components (components/) render. Also the actions those components
// run: Copy diagnostics, the data disk buttons, the key bar, paste, font size.
// The system apps' windows (Settings, System) are sysapps.ts's.
import { flushSync } from "react-dom";
import { RESUME_AUTO, RESUME_BY_HAND, RESUME_FRESH, allowLeave, resumeAskedFor, resumeRequestKind, type ResumeRequest } from "./autosuspend.ts";
import { DATA_SIZE_DEFAULT, DEFAULT_CMDLINE, DEFAULT_DISTRO, SETTING_NAMES, glDefault, saveSettings, type Config } from "./config.ts";
import { KW, type KWError } from "./kw.ts";
import { store } from "./prefs.ts";
import { initStore, isRunning, isUp, phase, type Ask, type PadLayout, type CheckResult, type Options, type Phase, type State, type SuspendStep, type UiState } from "./store.ts";
import { openSection, showSystem } from "./sysapps.ts";
import { capitalize, fmtMiB, fmtT } from "./format.ts";

export type { CheckResult, State } from "./store.ts";
export type StageState = "pending" | "active" | "done" | "fail" | "skip";

/**
 * sessionStorage: what this tab's next load does with the suspended
 * session: "1" resume it after the Resume button, "auto" after a suspend in
 * the background (autosuspend.ts), "fresh" boot fresh after Reboot
 * (autosuspend.ts resumeChoice()). A plain load resumes a session it can
 * too. Every resume is quiet and ends in the same toast (boot.ts).
 */
const RESUME_KEY = "kw-resume";
/**
 * Resume on this tab's next load. `auto`: after a suspend in the background
 * (boot.ts; a reload after the browser discarded the tab resumes too).
 */
export function setResumeRequest(auto = false): void {
	try { sessionStorage.setItem(RESUME_KEY, auto ? RESUME_AUTO : RESUME_BY_HAND); } catch { /* a plain load, which resumes it too */ }
}
/** Do not resume on the next load after all (boot.ts: a held machine went on, so its saved session is stale). */
export function clearResumeRequest(): void {
	try { sessionStorage.removeItem(RESUME_KEY); } catch { /* nothing set */ }
}
/** What the last load asked of this one, read once (boot.ts): "auto", "hand", "fresh" or null. */
export function takeResumeRequest(): ResumeRequest {
	try {
		const v = sessionStorage.getItem(RESUME_KEY);
		sessionStorage.removeItem(RESUME_KEY);
		return resumeRequestKind(v);
	} catch {
		return null;
	}
}
/** The same without taking it (the boot indicator, before boot.ts runs). */
function peekResumeRequest(): ResumeRequest {
	try { return resumeRequestKind(sessionStorage.getItem(RESUME_KEY)); } catch { return null; }
}
/** Reload and resume (boot.ts reads RESUME_KEY once); `auto`: after a suspend in the background. */
function reloadToResume(auto: boolean): void {
	setResumeRequest(auto);
	allowLeave();
	location.reload();
}

/** The "Suspending…" toast stays up to this long (the save takes about a second; the Resume card replaces it). */
const SUSPEND_TOAST_MS = 20000;

const padLayout = (v: string | null): PadLayout => (v === "keys" ? v : "gamepad");
const termThemePref = (v: string | null): UiState["termTheme"] => (v === "auto" || v === "light" ? v : "dark");

interface BrowserInfo { name: string; v: number; ios?: boolean }

export function browser(): BrowserInfo {
	const ua = navigator.userAgent;
	let m: RegExpExecArray | null;
	if ((m = /EdgA?\/(\d+)/.exec(ua))) return { name: "Edge", v: +m[1]! };
	if ((m = /SamsungBrowser\/(\d+)/.exec(ua))) return { name: "Samsung Internet", v: +m[1]! };
	if ((m = /(?:Firefox|FxiOS)\/(\d+)/.exec(ua))) return { name: "Firefox", v: +m[1]!, ios: /FxiOS/.test(ua) };
	if ((m = /CriOS\/(\d+)/.exec(ua))) return { name: "Chrome (iOS)", v: +m[1]!, ios: true };
	if ((m = /Chrome\/(\d+)/.exec(ua))) return { name: "Chrome", v: +m[1]! };
	// iPadOS Safari presents a Mac UA; touch points give it away.
	const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
	if ((m = /Version\/(\d+).*Safari/.exec(ua))) return { name: "Safari", v: +m[1]!, ios };
	return { name: "unknown browser", v: 0, ios };
}

const B = browser();

function hintFor(msg: string): string {
	if (/JSPI|Suspending|promising/i.test(msg)) {
		let s = "The kernel switches tasks with JSPI (WebAssembly JavaScript Promise Integration). " +
			"It is on by default in Chrome and Edge 137+ (desktop and Android) and in Safari 27+ (macOS, iOS and iPadOS 27).";
		if (B.ios) s += " On iPhone and iPad every browser (Safari, Chrome, Firefox, …) uses the system WebKit, so JSPI depends on the iOS version: update to iOS/iPadOS 27 or later." +
			(B.name === "Safari" && B.v ? ` This is Safari ${B.v}.` : "");
		else if (B.name === "Chrome" && B.v && B.v < 137) s += ` This is Chrome ${B.v}: update it (Play Store → Chrome → Update, or chrome://settings/help). Chrome 126–136 can try chrome://flags/#enable-experimental-webassembly-jspi.`;
		else if (B.name === "Samsung Internet") s += ` Samsung Internet ${B.v} is built on an older Chromium; use Chrome 137+ instead.`;
		else if (B.name === "Firefox") s += " Firefox only has it behind about:config javascript.options.wasm_js_promise_integration (Nightly).";
		else if (B.name === "Safari") s += ` This is Safari ${B.v || "(unknown version)"}; update macOS/Safari to 27 or later.`;
		return s;
	}
	if (/allocate|Memory\(\)|out of memory|array buffer/i.test(msg))
		return "The browser refused the kernel's memory. Phones (especially 32-bit Chrome builds) have little contiguous address space; " +
			"pick a smaller size in Settings, Machine (e.g. 128 MiB) or add ?mem=128 to the URL. Alpine boots in 64 MiB.";
	if (/\b(404|403|500)\b|Failed to fetch|NetworkError|network/i.test(msg))
		return "The kernel could not be downloaded. Check the network and reload; a page from an older deploy may refer to a kernel that is gone.";
	if (/module|script/i.test(msg))
		return "A page script failed to load or parse: check the network and the server log. A browser too old for the syntax fails the same way; Chrome/Edge 137+ or Safari 27+ is required anyway.";
	const smp = (KW.config?.cpus ?? 1) > 1;
	if (/panic|trap|unreachable|RuntimeError/i.test(msg) || (smp && /\bCPU \d/.test(msg)))
		return "The kernel stopped. System's Kernel log has the last console lines; Copy diagnostics and reboot." +
			(smp ? " To rule out the SMP kernel, set CPUs to 1 in Settings, Machine and reboot." : "");
	return "";
}

const LABEL: Record<State, string> = { checking: "Checking", loading: "Downloading", booting: "Booting", running: "Running", halted: "Halted", error: "Error" };

/**
 * The tab title's first character, by the machine's phase (store.ts phase()):
 * ▶ running, ‖ held (paused by hand or in the background, boot.ts) or
 * suspended, … starting, resuming or suspending, ■ halted or powered off,
 * ! failed. Plain text glyphs (▶ with U+FE0E, the text presentation, so no
 * browser draws it as a colour emoji).
 */
const TITLE_MARK: Record<Phase, string> = { starting: "…", running: "▶︎", suspending: "…", held: "‖", suspended: "‖", halted: "■", error: "!" };
export const titleMark = (p: Phase): string => TITLE_MARK[p];

interface Stage { id: string; label: string; s: StageState; t0: number | null; t1: number | null; detail: string }
export interface LogLine { t: number; line: string; cls: string }

/** Phones: 12 px fits ~47 columns at 360 px. */
export const autoFont = (): number => (innerWidth < 600 ? 12 : 14);

export function createUi(cfg: Config) {
	const now = () => Date.now() - KW.t0;

	const fontPref = store("font") || "auto";
	cfg.fontSize = fontPref === "auto" ? autoFont() : Number(fontPref);
	const options: Options = {
		mem: cfg.memParam || "auto",
		net: !cfg.net ? "off" : cfg.wisp ? "custom" : "default",
		wisp: (cfg.wisp ?? []).join(", "), // the default servers are not shown
		jit: cfg.jit ? "on" : "off",
		verbose: cfg.verbose ? "keep" : "clear",
		display: cfg.display ? "on" : "off",
		sound: cfg.sound ? "on" : "off",
		append: cfg.baseCmdline,
		data: cfg.data ? "on" : "off",
		datasize: String(cfg.dataSizeGiB),
		root: cfg.root === "initramfs" ? "safe" : "overlay",
		worker: cfg.workerParam ? "on" : "off",
		cpus: String(cfg.smpParam),
		distro: cfg.distroParam,
		autosuspend: cfg.autosuspendParam,
		askleave: cfg.askLeave ? "on" : "off",
		gl: cfg.glParam ? "on" : "off",
		vk: cfg.vkParam ? "on" : "off",
	};
	// Where the root's changes live on the data disk: per distro (guest/base/initramfs/init).
	const upperDir = `/data/distros/${cfg.guest}/upper`;
	const imageName = `${cfg.guest} image`;
	const $ = initStore({
		state: "checking", label: LABEL.checking, suspend: null, suspended: false, suspendedBytes: 0,
		// A resume asked for (the Resume button, a suspend in the background) says "Resuming" until the screen is restored (boot.ts).
		boot: { label: "Starting", detail: "", progress: 0, resuming: resumeAskedFor(peekResumeRequest()) && !cfg.verbose, blank: true, done: false },
		checks: [], errors: [], fatal: null,
		toast: null,
		dataStatus: "Not attached yet.", disk: null,
		safeNote: cfg.root === "initramfs" && cfg.distro
			? `Safe mode: the root is the plain ${imageName} (kw.root=initramfs, until you leave safe mode); /data is mounted as usual and your root changes stay in ${upperDir}. kw-overlay status explains, sudo kw-overlay discard starts over from the image.`
			: null,
		distro: cfg.distro ? { name: cfg.distro.name, image: cfg.distro.imageId ?? "", url: cfg.distro.url } : null,
		ctrl: false, keysOn: false, pasteOpen: false, ask: null, paused: false, prefix: false,
		fontPref, fontSize: cfg.fontSize, termTheme: termThemePref(store("termtheme")), copyText: null,
		display: { attached: false, width: 0, height: 0, keyboard: false, mouse: false, tablet: false,
			rotate: store("fbRotate") === "1", layout: padLayout(store("padLayout")),
			touchMode: store("touchMode") === "trackpad" ? "trackpad" : "mouse",
			controls: store("padHidden") !== "1" },
		wayland: { available: false, attached: false, windows: [] },
		launcher: false,
		options,
	} satisfies UiState);

	const lightScheme = matchMedia("(prefers-color-scheme: light)");
	const showTermTheme = () => {
		const pref = $.get().termTheme;
		document.documentElement.dataset.termTheme = pref === "auto" ? (lightScheme.matches ? "light" : "dark") : pref;
	};
	lightScheme.addEventListener("change", showTermTheme);
	showTermTheme();

	// ---- the tab's title ---------------------------------------------------
	// One character before the title says how the machine is (titleMark()),
	// set synchronously with each state change, so the tab switcher shows it
	// even when the page is frozen right after (a hold begins as the tab hides).
	// Whatever else sets the title keeps its text: only our own mark is replaced.
	let markPrefix = "";
	const showMark = () => {
		const s = $.get();
		const prefix = `${titleMark(phase(s))} `;
		if (prefix === markPrefix && document.title.startsWith(prefix)) return;
		const cur = document.title;
		const base = markPrefix && cur.startsWith(markPrefix) ? cur.slice(markPrefix.length) : cur;
		markPrefix = prefix;
		document.title = prefix + (base || "unkernel");
	};
	$.subscribe(showMark);
	showMark();

	// ---- boot stages ------------------------------------------------------
	// Timed here, shown on the terminal by boot.ts and in Copy diagnostics.
	const STAGES: Array<[string, string]> = [
		["preflight", "Feature checks"], ["kernel", "Download kernel + root file system"],
		["compile", "Compile kernel"], ["memory", "Allocate memory"], ["boot", "Kernel boot"], ["userspace", "Start user space"],
	];
	const stages: Record<string, Stage> = {};
	for (const [id, label] of STAGES) stages[id] = { id, label, s: "pending", t0: null, t1: null, detail: "" };

	// ---- the boot indicator's ring and step (components/BootIndicator.tsx) ---------
	// Each stage has a share of the ring: an active one fills to its start (the
	// download: by its bytes, where the size is known), a finished one to its end.
	// The ring never goes back. The step shown is the last active stage's, or what
	// ui.bootStep() said while none is; a resume says "Resuming" throughout.
	const BOOT_SPAN: Record<string, [number, number]> = {
		preflight: [0, 0.06], kernel: [0.08, 0.6], compile: [0.6, 0.7], memory: [0.7, 0.76], boot: [0.76, 0.9], userspace: [0.9, 1],
	};
	const BOOT_STEP: Record<string, string> = {
		preflight: "Checking the browser", kernel: "Downloading the kernel", compile: "Compiling the kernel", memory: "Allocating memory",
		boot: "Starting Linux", userspace: `Starting ${cfg.distro ? capitalize(cfg.guest) : "the base shell"}`,
	};
	let downloadPart = 0, downloadT = 0;
	const setBoot = (patch: Partial<UiState["boot"]>) => $.set((s) => ({ boot: { ...s.boot, ...patch } }));
	/** The ring and step from the stages; `detail`: the download's bytes. */
	function bootProgress(detail = "") {
		const b = $.get().boot;
		if (b.done || $.get().fatal) return;
		let p = 0, step = "";
		for (const [id] of STAGES) {
			const st = stages[id]!, [lo, hi] = BOOT_SPAN[id]!;
			if (st.s === "done" || st.s === "skip") p = Math.max(p, hi);
			else if (st.s === "active") {
				p = Math.max(p, id === "kernel" ? lo + (hi - lo) * downloadPart : lo);
				step = BOOT_STEP[id]!;
			}
		}
		if (stages.kernel!.s !== "active") detail = "";
		const patch: Partial<UiState["boot"]> = { progress: Math.max(b.progress, p), detail };
		if (step) patch.label = step;
		if (patch.progress !== b.progress || detail !== b.detail || (step && step !== b.label)) setBoot(patch);
	}

	// The kernel log is kept outside the store: it grows by a line at a time,
	// and the Kernel log tab appends to its <pre> instead of re-rendering.
	const logLines: LogLine[] = [];
	const logListeners = new Set<(reset: boolean) => void>();
	const LOG_MAX = 4000;
	let fatalShown = false;
	let toastId = 0, toastTimer: ReturnType<typeof setTimeout> | undefined;
	/** The questions (ui.ask()): the first is shown, the others wait their turn. */
	let askId = 0;
	const asks: Array<{ q: Ask; resolve: (ok: boolean) => void }> = [];
	let toastRun: (() => void) | null = null;

	const ui = {
		state: (): State => $.get().state,
		/** The state, its label (default: the state's name) and Suspend's step (boot.ts; null: not suspending). */
		setState(s: State, label?: string, suspend: SuspendStep | null = null) {
			const cur = $.get().state;
			if (cur === "error" || (cur === "halted" && s !== "error")) return; // terminal states stick
			$.set({ state: s, label: label || LABEL[s], suspend });
			// Stopped before user space printed (a halt, a kept session): the terminal says why.
			if (s === "halted") ui.bootDone();
			// boot.ts begins the download (its stage starts with the first bytes).
			else if (s === "loading" && cur !== "loading") setBoot({ label: BOOT_STEP.kernel! });
		},

		// ---- the boot indicator (components/BootIndicator.tsx) -----------------------
		/** The indicator's step, until a stage replaces it ("Loading": the boot module). */
		bootStep(label: string) {
			if ($.get().state === "error") return;
			setBoot({ label: label.replace(/…$/, ""), detail: "" });
		},
		/** boot.ts: a suspended session is being restored (the label says "Resuming"), or not after all. */
		bootResume(on: boolean) { if ($.get().boot.resuming !== on) setBoot({ resuming: on }); },
		/** boot.ts: the console shows something now (its first lines, or a quiet resume's held ones): its placeholder goes. */
		consoleShown() { if ($.get().boot.blank) setBoot({ blank: false }); },
		/** The kernel download's bytes (boot.ts; total 0: unknown): the label's detail, and the ring within the download's share. */
		download(loaded: number, total: number) {
			const t = performance.now();
			if (t - downloadT < 80 && !(total > 0 && loaded >= total)) return; // a store update every chunk is too many
			downloadT = t;
			downloadPart = total > 0 ? Math.min(1, loaded / total) : 0;
			const mib = (n: number) => (n / 1048576).toFixed(1);
			bootProgress(total > 0 ? `${mib(loaded)} of ${mib(total)} MiB` : `${mib(loaded)} MiB`);
		},
		/**
		 * The boot is over (user space printed, boot.ts markRunning(); or the kernel stopped): the indicator
		 * fades out, the top bar shows the focused app again, the console's placeholder goes. It does not come back.
		 */
		bootDone() { if (!$.get().boot.done) setBoot({ done: true, blank: false }); },

		stage(id: string, s: StageState, detail?: string) {
			const st = stages[id];
			if (!st) return;
			if (s === "active" && st.t0 == null) st.t0 = now();
			if ((s === "done" || s === "fail") && st.t1 == null) { st.t1 = now(); st.t0 ??= st.t1; }
			st.s = s;
			if (detail != null) st.detail = detail;
			bootProgress();
		},
		/** State of a stage: pending, active, done, fail or skip. */
		stageState: (id: string): StageState | null => stages[id]?.s ?? null,
		/** Duration in ms of a finished stage, else null. */
		stageTime(id: string): number | null {
			const st = stages[id];
			return st && st.t0 != null && st.t1 != null ? st.t1 - st.t0 : null;
		},
		/**
		 * The boot stages in their order, as System's Overview lists them and draws their timeline
		 * (components/SystemInfo.tsx): t0 and t1 are ms since the page loaded (KW.t0), null until known.
		 */
		stages: () => STAGES.map(([id]) => {
			const st = stages[id]!;
			return { id, label: st.label, s: st.s, ms: st.t0 != null && st.t1 != null ? st.t1 - st.t0 : null, t0: st.t0, t1: st.t1, detail: st.detail };
		}),

		check(id: string, label: string, r: CheckResult, value: string, note?: string) {
			$.set((s) => {
				const c = { id, label, r, value, note: note || "" };
				const i = s.checks.findIndex((x) => x.id === id);
				return { checks: i < 0 ? [...s.checks, c] : s.checks.map((x, j) => (j === i ? c : x)) };
			});
		},

		log(line: string, cls?: string) {
			logLines.push({ t: now(), line, cls: cls || "" });
			const reset = logLines.length > LOG_MAX;
			if (reset) logLines.splice(0, logLines.length - LOG_MAX);
			for (const l of logListeners) l(reset);
		},
		hostLog(m: string) { ui.log(m, /fatal|panic|trap|error|fail/i.test(m) ? "e" : "h"); },
		/** The Kernel log tab: the lines, and a subscription (reset: the oldest lines were dropped). */
		logView: { lines: logLines as readonly LogLine[], subscribe(l: (reset: boolean) => void) { logListeners.add(l); return () => { logListeners.delete(l); }; } },

		onError(e: KWError) {
			e.hint ||= hintFor(`${e.message} ${e.detail || ""}`);
			ui.log(`[${e.kind}] ${e.message}`, "e");
			$.set({ errors: [...KW.errors] });
			if (e.fatal) fatal(e);
			else ui.toast(e.message);
		},
		fail(kind: string, message: string, detail?: string, extra?: Partial<KWError>): KWError {
			const e: KWError = { t: now(), kind, message: String(message), detail: detail ? String(detail) : "", fatal: true, ...extra };
			KW.errors.push(e);
			ui.onError(e);
			return e;
		},

		setPrefix(on: boolean) { if ($.get().prefix !== on) $.set({ prefix: on }); },
		/** Reboot from a shortcut or the top bar's Control Center: one key away from a running session, so ask first. */
		async confirmReboot() {
			if (isUp($.get()) &&
				!await ui.ask({ title: "reboot", msg: "The running system and its unsaved state are lost.", ok: "Reboot", danger: true })) return;
			reboot();
		},
		/**
		 * Suspend from a shortcut, the top bar's Control Center or Settings, at once (boot.ts
		 * does it: KW.suspend). Nothing to confirm: the machine stops only once its
		 * session is stored, and Resume (or the next load) brings it back.
		 */
		suspend() {
			const s = $.get();
			if (!KW.suspend || !isRunning(s)) { ui.toast("Suspend works once the system runs"); return; }
			if (phase(s) === "suspending") return; // pressed twice
			// The Resume card says the rest (the size included), so this toast goes once it is saved.
			const id = ui.toast("Suspending…", { ms: SUSPEND_TOAST_MS });
			KW.suspend().then(() => ui.toastHide(id),
				(e: Error) => KW.report("suspend", `Suspend failed: ${e?.message ?? String(e)}`, e?.stack ?? "", false));
		},
		/** boot.ts, once Suspend has saved the system (`bytes`: its size) and the kernel stopped: the Resume card. */
		setSuspended(bytes = 0) { $.set({ suspended: true, suspendedBytes: bytes }); },
		/** boot.ts: paused by hand (autosuspend.ts Pause), saved and held: the notice with Continue (components/Overlays.tsx). */
		setPaused(on: boolean) { if ($.get().paused !== on) $.set({ paused: on }); },
		/**
		 * Resume after Suspend: reload the page and resume
		 * (boot.ts reads RESUME_KEY once). The reload keeps the URL, so the
		 * devices match the saved session.
		 */
		resume() { reloadToResume(false); },
		/** The same after a suspend in the background (autosuspend.ts). */
		resumeAuto() { reloadToResume(true); },

		/**
		 * Ask in the confirm dialog (components/Overlays.tsx Confirm, an Alert on a
		 * modal <dialog>: Dialog.tsx) instead of confirm(): true for OK. One at a
		 * time: a question asked while another is open waits for it (first in,
		 * first shown).
		 */
		ask(q: Omit<Ask, "id">): Promise<boolean> {
			if (document.pointerLockElement) document.exitPointerLock(); // the pointer must reach the buttons
			return new Promise((resolve) => {
				asks.push({ q: { ...q, id: ++askId }, resolve });
				if (asks.length === 1) $.set({ ask: asks[0]!.q });
			});
		},
		/**
		 * Answer a question: question `id`, else the one shown. Without an id,
		 * false is also how the guest takes its question back (boot.ts, open.ts
		 * dismiss): while a guest's question waits behind one of the page's, the
		 * guest's goes, not the one shown.
		 */
		answer(ok: boolean, id?: number) {
			let i = 0;
			if (id !== undefined) i = asks.findIndex((a) => a.q.id === id);
			else if (!ok && asks[0] && !asks[0].q.untrusted) i = Math.max(0, asks.findIndex((a) => a.q.untrusted));
			const a = asks[i];
			if (i < 0 || !a) return;
			asks.splice(i, 1);
			if (i === 0) $.set({ ask: asks[0]?.q ?? null });
			a.resolve(ok);
		},

		/**
		 * A short message under the top bar (components/Overlays.tsx Toast), for `ms` (default 3.2 s). With
		 * `action`, one button that runs `run` and hides the toast (it does not
		 * take the focus). Returns its id, for toastHide().
		 */
		toast(msg: string, o: { action?: string; run?: () => void; ms?: number } = {}): number {
			const id = ++toastId;
			toastRun = o.action && o.run ? o.run : null;
			$.set({ toast: { msg: msg.length > 140 ? `${msg.slice(0, 137)}…` : msg, id, ...(toastRun ? { action: o.action } : {}) } });
			clearTimeout(toastTimer);
			toastTimer = setTimeout(() => ui.toastHide(id), o.ms ?? 3200);
			return id;
		},
		/** Hide the toast (only toast `id`, if given). */
		toastHide(id?: number) {
			const t = $.get().toast;
			if (!t || (id !== undefined && t.id !== id)) return;
			clearTimeout(toastTimer);
			toastRun = null;
			$.set({ toast: null });
		},
		/** The toast's button. */
		toastAction() {
			const run = toastRun;
			ui.toastHide();
			run?.();
		},

		/** The Data disk section's status line (boot.ts). */
		dataStatus(text: string) { $.set({ dataStatus: text }); },
		/** The data disk's usage, for the top bar's disk meter and System (boot.ts, every 5 s). */
		diskUsage(used: number, size: number, saved: boolean) {
			const d = $.get().disk;
			if (d?.used !== used || d.size !== size || d.saved !== saved) $.set({ disk: { used, size, saved } });
		},
		/**
		 * The base fell back to safe mode for this boot (boot.ts saw "kw-overlay: SAFE MODE: <reason>"):
		 * the root with the changes failed its check, so this boot runs the plain image. Each boot checks again.
		 */
		safeMode(reason: string) {
			$.set({
				safeNote: `Safe mode: ${reason}. This boot runs the plain ${imageName}; your changes to the root are kept, unused, in ${upperDir}. ` +
					"Fix them there (with sudo) and reboot: each boot tries them again (kw-overlay status explains, sudo kw-overlay discard sets them aside and starts over from the image).",
			});
			ui.check("overlay", "Root", "warn", "safe mode", reason);
			ui.toast(`Safe mode: ${reason}. Your root changes are kept but unused this boot; fix them and reboot.`);
		},

		/**
		 * The base found no distro to boot and started its base shell (boot.ts
		 * saw "unkernel base shell (...): <reason>").
		 */
		baseShell(reason: string) {
			if (cfg.distro) {
				ui.check("overlay", "Root", "warn", "base shell", `the ${cfg.distro.name} image did not boot: ${reason}`);
				KW.report("distro", `The ${cfg.distro.name} image did not boot (${reason}): this is the base shell. Reboot, or pick another distro under Options.`, "", false);
			} else ui.check("overlay", "Root", "info", "base shell", `no distro (?distro=none): ${reason}`);
		},
		/** What the guest says it booted (/run/kw-base; boot.ts). */
		distroBooted(image: string) {
			const d = $.get().distro;
			if (d && image && d.image !== image) $.set({ distro: { ...d, image } });
		},

		diagText,
		/** The page URL that Reboot loads (the Options as chosen; config.ts reads them back); defaults are left out. */
		nextSettings, optionsChanged,
		/** Reload the page with the Options as chosen, like the Reboot button. */
		reboot,
		setOption<K extends keyof Options>(k: K, v: Options[K]) { $.set((s) => ({ options: { ...s.options, [k]: v } })); },

		/** Turn the next typed character into its control code when the key bar's Ctrl is armed. */
		applyCtrl(d: string): string {
			if (!$.get().ctrl || d.length !== 1) return d;
			ui.setCtrl(false);
			const c = d.charCodeAt(0);
			if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return String.fromCharCode(c & 31);
			const map: Record<string, number> = { "@": 0, " ": 0, "2": 0, "[": 27, "3": 27, "\\": 28, "4": 28, "]": 29, "5": 29, "^": 30, "6": 30, "~": 30, "_": 31, "-": 31, "/": 31, "7": 31, "?": 127, "8": 127 };
			return d in map ? String.fromCharCode(map[d]!) : d;
		},
		setCtrl(on: boolean) { $.set({ ctrl: on }); },
		/** A key bar button: arrows, Esc, Tab, ^C, Ctrl (latches), the shortcut prefix (arms it, or disarms it: keys.ts), Paste, or a character. */
		pressKey(k: string) {
			const ctrl = $.get().ctrl;
			if (k === "ctrl") { ui.setCtrl(!ctrl); return; }
			if (k === "prefix") { ui.setCtrl(false); ui.setPrefix(!$.get().prefix); return; }
			if (k === "paste") { ui.setCtrl(false); openPaste(); return; }
			if (!KW.term) return;
			const arrows: Record<string, string> = { up: "A", down: "B", right: "C", left: "D" };
			let seq: string;
			if (arrows[k]) seq = ctrl ? `\x1b[1;5${arrows[k]}` : (KW.term.appCursor() ? "\x1bO" : "\x1b[") + arrows[k];
			else if (k === "esc") seq = "\x1b";
			else if (k === "tab") seq = "\t";
			else if (k === "^c") seq = "\x03";
			else seq = ui.applyCtrl(k);
			ui.setCtrl(false);
			KW.term.send(seq);
		},
		closePaste() { $.set({ pasteOpen: false }); KW.term?.focus(); },
		sendPaste(t: string) {
			if (t && KW.term) KW.term.paste(t);
			ui.closePaste();
		},

		/** The Font size option ("auto" or px), or a pinch (px, whole, 9 to 24). */
		setFont(pref: string) {
			const size = pref === "auto" ? autoFont() : Math.min(24, Math.max(9, Math.round(Number(pref))));
			if (pref !== "auto") pref = String(size);
			store("font", pref);
			cfg.fontSize = size;
			$.set({ fontPref: pref, fontSize: size });
			KW.term?.setFontSize(size);
		},
		setTermTheme(pref: string) {
			const termTheme = termThemePref(pref);
			store("termtheme", termTheme);
			$.set({ termTheme });
			showTermTheme();
		},

		copyDiagnostics,
		dataExport, dataImport, dataReset, safeModeToggle,
	};

	function fatal(e: KWError) {
		for (const id in stages) if (stages[id]!.s === "active") ui.stage(id, "fail");
		ui.setState("error", "Error");
		if (fatalShown) return;
		fatalShown = true;
		const titles: Record<string, string> = { resource: "A page script failed to load", exception: "Script error", rejection: "Script error",
			watchdog: "Startup stalled", preflight: "This browser cannot run the kernel" };
		// The boot indicator turns red with the title while the boot is not over (components/BootIndicator.tsx);
		// the top bar's status icon turns red either way.
		$.set({ fatal: { title: e.title || titles[e.kind] || `Stopped: ${e.kind}`, msg: e.message, hint: e.hint || "" } });
		KW.term?.notice(`[host] ${e.message}`);
		// System's Errors as a window on the desktop (it works in any state): the title, message, hint and details.
		openSection("errors");
	}

	// ---- diagnostics / copy / reboot ---------------------------------------
	function diagText(): string {
		const s = $.get();
		const L: string[] = [];
		L.push(`unkernel diagnostics, ${new Date().toISOString()}`);
		L.push(`url: ${location.href}`);
		L.push(`state: ${s.state} (${s.label}) after ${fmtT(now())}`);
		L.push(`config: mem=${cfg.memMiB} MiB (${cfg.memWhy})${KW.memActualMiB ? ` allocated=${KW.memActualMiB} MiB` : ""} kernel=${cfg.cpus > 1 ? cfg.kernelSmpUrl : cfg.kernelUrl} distro=${cfg.guest}${s.distro ? ` image=${s.distro.image || "?"} (${s.distro.url})` : ""} cmdline="${cfg.cmdline}"${cfg.worker ? " worker=1" : ""}${cfg.smpParam > 1 || cfg.cpus > 1 || cfg.smpWhy ? ` cpus=${cfg.cpus}${cfg.smpWhy ? ` (asked ${cfg.smpParam}: ${cfg.smpWhy})` : cfg.resumeCpus ? " (the suspended session's)" : ""}` : ""}`);
		L.push("", "== stages");
		for (const [id] of STAGES) {
			const st = stages[id]!;
			L.push(`  ${id}: ${st.s}${st.t0 != null ? ` @${fmtT(st.t0)}` : ""}${st.t1 != null ? ` took ${fmtT(st.t1 - st.t0!)}` : ""}${st.detail ? ` - ${st.detail}` : ""}`);
		}
		L.push("", "== environment");
		for (const c of s.checks) L.push(`  [${c.r}] ${c.label}: ${c.value}${c.note ? ` (${c.note})` : ""}`);
		L.push("", `== errors (${KW.errors.length})`);
		for (const e of KW.errors) {
			L.push(`  +${fmtT(e.t)} ${e.kind}${e.fatal ? " FATAL" : ""}: ${e.message}`);
			if (e.detail) L.push(`    ${e.detail.split("\n").join("\n    ")}`);
		}
		L.push("", "== log (last 300 lines)");
		for (const l of logLines.slice(-300)) L.push(l.line);
		return L.join("\n");
	}
	function copyDiagnostics() {
		const text = diagText();
		const fallback = () => {
			// The textarea is in System's window: shown, so it can be selected (and seen).
			flushSync(() => { showSystem(); $.set({ copyText: text }); });
			const area = document.getElementById("copy-area") as HTMLTextAreaElement | null;
			let ok = false;
			if (area) {
				area.focus();
				area.select();
				try { ok = document.execCommand("copy"); } catch {}
				area.scrollIntoView({ block: "nearest" });
			}
			ui.toast(ok ? "Diagnostics copied" : "Clipboard unavailable here: select the text below and copy it");
		};
		if (navigator.clipboard?.writeText && isSecureContext) navigator.clipboard.writeText(text).then(() => ui.toast("Diagnostics copied"), fallback);
		else fallback();
	}

	/**
	 * The settings Reboot saves (config.ts SETTINGS_KEY): the options as
	 * chosen, by their parameter names, only where they differ from the
	 * defaults; a setting without a control (?shared=) is kept as it is.
	 */
	function nextSettings(): Record<string, string> {
		const o = $.get().options;
		const p = new URLSearchParams(cfg.settings);
		const set = (k: string, v: string | null) => (v === null ? p.delete(k) : p.set(k, v));
		set("mem", o.mem === "auto" ? null : o.mem);
		const wisp = o.wisp.split(",").map((s) => s.trim()).filter(Boolean).join(",");
		set("wisp", o.net === "off" ? "0" : o.net === "custom" && wisp ? wisp : null);
		set("jit", o.jit === "off" ? "0" : null);
		set("verbose", o.verbose === "keep" ? "1" : null);
		set("display", o.display === "off" ? "0" : null);
		set("sound", o.sound === "off" ? "0" : null);
		const append = o.append.trim();
		set("append", append && append !== DEFAULT_CMDLINE ? append : null);
		set("data", o.data === "off" ? "0" : null);
		set("datasize", o.datasize === String(DATA_SIZE_DEFAULT) ? null : o.datasize);
		set("root", o.root === "safe" ? "initramfs" : null);
		// Worker thread and CPUs: saved only where they differ from this device's defaults (config.ts).
		set("worker", (o.worker === "on") === cfg.workerDefault ? null : o.worker === "on" ? "1" : "0");
		// The next load's default count: the suggestion in worker mode (config.ts cpuDefault).
		const cpuNext = o.worker === "on" && !cfg.smpBlocked && cfg.cpuSuggested ? cfg.cpuSuggested : 1;
		set("cpus", o.cpus === String(cpuNext) ? null : o.cpus);
		set("distro", o.distro === DEFAULT_DISTRO ? null : o.distro);
		// Auto-suspend: saved only where it differs from this device's default (config.ts).
		set("autosuspend", o.autosuspend === cfg.autosuspendDefault ? null : o.autosuspend);
		set("askleave", o.askleave === "off" ? "0" : null);
		// Guest GL: saved only where it differs from its default (on where the display is; config.ts glDefault()).
		set("gl", (o.gl === "on") === glDefault(o.display !== "off") ? null : o.gl === "on" ? "1" : "0");
		// Guest Vulkan: saved only when off (on by default).
		set("vk", o.vk === "off" ? "0" : null);
		return Object.fromEntries([...p].sort(([a], [b]) => a.localeCompare(b)));
	}
	/** The options differ from the settings this load booted with (the Reboot button says so). */
	function optionsChanged(): boolean {
		const sorted = (s: Record<string, string>) => JSON.stringify(Object.entries(s).sort(([a], [b]) => a.localeCompare(b)));
		return sorted(nextSettings()) !== sorted(cfg.settings);
	}
	let rebooting = false;
	/** A data disk reset or import is running (dataAction); it ends in a reload. */
	let dataBusy = false;
	function reboot() {
		if (rebooting) return;
		// A reset or import in progress reloads the page itself; a reload now would cut it off.
		if (dataBusy) { ui.toast("The data disk is being replaced; the page reloads when it is done"); return; }
		rebooting = true;
		// Save the options and load the URL without settings (the URL's applied to
		// one load, and are saved with the rest now). Where localStorage refuses,
		// the URL carries them instead.
		const next = nextSettings();
		const u = new URL(location.href);
		for (const k of SETTING_NAMES) u.searchParams.delete(k);
		if (!saveSettings(next)) for (const [k, v] of Object.entries(next)) u.searchParams.set(k, v);
		const go = () => {
			// A boot from scratch: not the resume a background suspend asked for (setResumeRequest()), nor the one a
			// plain load does (boot.ts: a saved session is kept, or with a data disk asked about), and no question on leaving.
			try { sessionStorage.setItem(RESUME_KEY, RESUME_FRESH); } catch {}
			allowLeave();
			if (u.href === location.href) location.reload();
			else location.assign(u);
		};
		// Let the guest write its file systems back to the saved disks first
		// (boot.ts: KW.sync, at most 3 s).
		if (KW.beforeReboot && isRunning($.get())) {
			ui.toast("Saving disks…");
			KW.beforeReboot().then(go, go);
		} else go();
	}

	// ---- data disk ------------------------------------------------------------
	// The actions live in boot.ts (KW.exportData / importData / resetData).
	function dataAction(name: "exportData" | "importData" | "resetData", run: () => Promise<unknown>) {
		if (!KW[name]) { ui.toast("The data disk is not ready yet"); return; }
		if (dataBusy) { ui.toast("The data disk is busy; wait for it to finish"); return; }
		dataBusy = name !== "exportData";
		run().finally(() => { dataBusy = false; }).catch((e: Error) => KW.report("data", `Data disk: ${e?.message ?? String(e)}`, e?.stack ?? "", false));
	}
	function dataExport() {
		dataAction("exportData", async () => {
			ui.toast("Exporting the data disk…");
			const r = await KW.exportData!();
			ui.toast(`Saved ${r.name} (${fmtMiB(r.bytes)})`);
		});
	}
	/** Without a file, asks first; true: go on and pick the file (the OK click still counts as a user gesture). */
	async function dataImport(f?: File): Promise<boolean> {
		if (!KW.importData) { ui.toast("The data disk is not ready yet"); return false; }
		if (!f) return ui.ask({ title: "import data disk", msg: "Replace /data with a .kwsparse.gz file? Its current content is lost, and the page reloads.", ok: "Choose file…", danger: true });
		dataAction("importData", () => { ui.toast(`Importing ${f.name}…`); return KW.importData!(f); });
		return true;
	}
	async function dataReset() {
		if (!await ui.ask({ title: "reset data disk", msg: "Everything in /data is deleted, and the page reloads.", ok: "Reset", danger: true })) return;
		dataAction("resetData", () => { ui.toast("Resetting the data disk… the page reloads when it is done"); return KW.resetData!(); });
	}
	// Safe mode: one boot on the plain image root (kw.root=initramfs), with
	// /data still mounted, to repair or turn off an overlay root (kw-overlay).
	async function safeModeToggle() {
		if (cfg.root !== "initramfs" && isUp($.get()) &&
			!await ui.ask({ title: "safe mode", msg: `Reboot on the plain ${imageName} as the root: your root changes on /data are not used. /data stays mounted.`, ok: "Reboot" })) return;
		ui.setOption("root", cfg.root === "initramfs" ? "overlay" : "safe");
		reboot();
	}

	// ---- paste ------------------------------------------------------------------
	function openPaste() {
		const show = () => $.set({ pasteOpen: true });
		if (navigator.clipboard?.readText && isSecureContext) {
			navigator.clipboard.readText().then((t) => { if (t && KW.term) KW.term.paste(t); else show(); }, show);
		} else show();
	}

	return ui;
}

export type Ui = ReturnType<typeof createUi>;
