// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's UI state: one small external store that the imperative side
// (ui.ts, boot.ts, display.ts) writes and the React components (components/)
// read with useStore(). Updates replace the changed fields, so a selector that
// returns a field gets the same reference until that field changes. The
// terminals' state is termtabs.ts's, the windows' wm.ts's.
import { useSyncExternalStore } from "react";
import type { KWError } from "./kw.ts";

export type State = "checking" | "loading" | "booting" | "running" | "halted" | "error";
export type CheckResult = "pass" | "fail" | "warn" | "info";
/**
 * A section of the system apps (sysapps.ts): Settings has boot (Machine),
 * distro, storage, network, display, desktop, session, keys and about; System has
 * status, env, log and errors. guest, the old dialog's Guest tab, is an alias of storage.
 */
export type Tab = "status" | "env" | "log" | "errors" | "keys" | "guest"
	| "boot" | "distro" | "storage" | "network" | "display" | "desktop" | "session" | "about";

export interface Check { id: string; label: string; r: CheckResult; value: string; note: string }

/** The touch controls' right side (components/Display.tsx). */
export type PadLayout = "gamepad" | "keys";
/** Touch on the picture with the tablet open: the pointer goes to the finger (mouse), or drags move it (trackpad). */
export type TouchMode = "mouse" | "trackpad";

export interface DisplayState {
	/** A program has /dev/fb0 open; mode is its size. */
	attached: boolean;
	width: number;
	height: number;
	/** Which evdev devices a program has open. */
	keyboard: boolean;
	mouse: boolean;
	tablet: boolean;
	/** Touch devices: draw the display a quarter turn round over the page while the page is portrait (kept in localStorage). */
	rotate: boolean;
	/** Touch devices: the buttons' layout (kept in localStorage). */
	layout: PadLayout;
	/** Touch devices: how touches on the picture move the pointer (kept in localStorage). */
	touchMode: TouchMode;
	/** Touch devices: the stick and buttons are shown (off for a demo or a desktop; kept in localStorage). */
	controls: boolean;
}

/** A Wayland app's window (wayland.ts), as wland lists it. */
export interface WaylandWindow { key: string; title: string; focused: boolean; minimized: boolean }

/** The Wayland apps (wayland.ts; their windows are the window manager's: wayland.ts waylandFocused()). */
export interface WaylandState {
	/** The page listens for wland's relay (the kernel has vsock and kwshm). */
	available: boolean;
	/** The relay is connected: the compositor runs (the Dock's #dock-wayland). */
	attached: boolean;
	windows: WaylandWindow[];
}

/**
 * A question in the confirm dialog; `cancel` labels the other button (default "Cancel"), `url` shows
 * under the message. `untrusted` (the guest asks, open.ts): OK (focused, as always), Enter and y
 * confirm only after a moment, so a key or a click meant for the terminal does not confirm it.
 * `icon`: the mark over the title, plain or with a badge (default: caution for `danger`, else plain).
 */
export interface Ask { title: string; msg: string; ok: string; cancel?: string; danger?: boolean; url?: string; untrusted?: boolean; icon?: "mark" | "caution" | "error"; id: number }

/**
 * The boot's progress (ui.ts drives it): what the top bar's boot indicator
 * shows (components/BootIndicator.tsx) until user space first prints
 * (`done`, which never goes back). A failure before then shows there too
 * (the store's `fatal`, while not done).
 */
export interface BootState {
	/** The current step, without "…" ("Downloading the kernel"), and what is known of it ("3.1 of 8.4 MiB", or ""). */
	label: string;
	detail: string;
	/** The ring, 0 to 1: the boot stages' share, the download's bytes within its own (ui.ts BOOT_SPAN). It never goes back. */
	progress: number;
	/** A suspended session is being restored: the label stays "Resuming". */
	resuming: boolean;
	/** The console has nothing to show yet (before boot.ts writes, during a quiet resume): its window shows a faint placeholder. */
	blank: boolean;
	done: boolean;
}

/**
 * Where Suspend is (boot.ts sets it with the state: ui.setState's third
 * argument): saving the session while the machine runs ("saving"), the
 * machine held at its snapshot point once saved ("held": Pause, or a suspend
 * in the background; it runs on when continued), or stopped once saved
 * ("stopped", the state halted: the Resume card, or a resume when the tab is
 * shown). null otherwise.
 */
export type SuspendStep = "saving" | "held" | "stopped";

/**
 * The machine's phase, one name for each case the page tells apart (phase()):
 * starting (checking, downloading, booting), running, suspending (Suspend
 * saves it; it still runs), held (saved and held: paused by hand or in the
 * background), suspended (stopped once saved), halted (stopped otherwise:
 * powered off, halted, restarting, not started, or a failed suspend), error.
 */
export type Phase = "starting" | "running" | "suspending" | "held" | "suspended" | "halted" | "error";

/** The machine's phase (Phase), from its state, Suspend's step and the paused and suspended flags. */
export function phase(s: UiState): Phase {
	switch (s.state) {
		case "error": return "error";
		case "halted": return s.suspended || s.suspend === "stopped" ? "suspended" : "halted";
		case "running": return s.paused || s.suspend === "held" ? "held" : s.suspend === "saving" ? "suspending" : "running";
		default: return "starting";
	}
}
/**
 * The system runs (also while Suspend saves it, or holds it): what needs it
 * (a new terminal, the launcher, Suspend) is enabled only then.
 */
export const isRunning = (s: UiState): boolean => s.state === "running";
/** Checking the browser, downloading or booting: the boot is under way. */
export const isStarting = (s: UiState): boolean => s.state === "checking" || s.state === "loading" || s.state === "booting";
/** The kernel runs (booting or running): a reboot loses what it holds, so it asks first. */
export const isUp = (s: UiState): boolean => s.state === "booting" || s.state === "running";
/** The machine stopped for good on this load (halted, suspended or failed): nothing new opens on it. */
export const isStopped = (s: UiState): boolean => s.state === "halted" || s.state === "error";
/** The machine is held (suspending, held, suspended): nothing should exec into it (stats.ts blocked() says which). */
export const isHeld = (s: UiState): boolean => {
	const p = phase(s);
	return p === "suspending" || p === "held" || p === "suspended";
};

export interface UiState {
	state: State;
	/** The state's name as shown (#tb-status-label, System, Copy diagnostics): "Running", "Paused", "Powered off"...; code tells the phase by phase(), not by it. */
	label: string;
	/** Where Suspend is (SuspendStep), set with the state; null: not suspending. */
	suspend: SuspendStep | null;
	/** Suspend saved the system and the kernel stopped (halted): the page offers Resume (components/Overlays.tsx, TopBar.tsx). */
	suspended: boolean;
	/** The saved session's size in bytes, for the Resume card (0: not known). */
	suspendedBytes: number;
	boot: BootState;
	checks: Check[];
	/** KW.errors, copied on each change. */
	errors: KWError[];
	fatal: { title: string; msg: string; hint: string } | null;
	/** The toast (ui.toast()); `action`: its one button's label. */
	toast: { msg: string; id: number; action?: string } | null;
	dataStatus: string;
	/** The data disk's blocks in use (non-zero, written at some point) and its size, in bytes; null: none. */
	disk: { used: number; size: number; saved: boolean } | null;
	/** The safe-mode explanation in the Data disk section, or null. */
	safeNote: string | null;
	/**
	 * The distro this load boots, as the About dialog shows it (its name,
	 * then its image id once the guest said it, from /run/kw-base); null with
	 * ?distro=none.
	 */
	distro: { name: string; image: string; url: string } | null;
	/** The key bar's Ctrl is armed. */
	ctrl: boolean;
	/** The key bar is showing (phones, on-screen keyboard up). */
	keysOn: boolean;
	pasteOpen: boolean;
	/** A question in the confirm dialog (ui.ask()), or null. */
	ask: Ask | null;
	/** Paused by hand (boot.ts, autosuspend.ts Pause): saved and held; the notice offers Continue (components/Overlays.tsx). */
	paused: boolean;
	/** The shortcut prefix (Ctrl-A, keys.ts) was pressed: the next key is a command. */
	prefix: boolean;
	/** The Font size option: "auto" or a size in px. */
	fontPref: string;
	fontSize: number;
	termTheme: "auto" | "dark" | "light";
	/** The Copy diagnostics fallback text, shown when the clipboard is unavailable. */
	copyText: string | null;
	display: DisplayState;
	wayland: WaylandState;
	/** The app launcher (components/Launcher.tsx) covers the page. */
	launcher: boolean;
	/** The Options as chosen (components/Options.tsx), read by nextSettings(). */
	options: Options;
}

export interface Options {
	mem: string;
	net: "default" | "custom" | "off";
	wisp: string;
	jit: "on" | "off";
	verbose: "clear" | "keep";
	display: "on" | "off";
	sound: "on" | "off";
	append: string;
	data: "on" | "off";
	/** The data disk's size in GiB (?datasize=; config.ts DATA_SIZES). */
	datasize: string;
	root: "overlay" | "safe";
	worker: "on" | "off";
	/** CPUs, "1" to "16" (?cpus=). */
	cpus: string;
	/** The distro image (?distro=): a name, or "none". */
	distro: string;
	/** Suspend in the background (?autosuspend=): "0" (off), "now" or seconds. */
	autosuspend: string;
	/** Ask before closing (?askleave=0: off). */
	askleave: "on" | "off";
	/** Guest GL (?gl=), Debian only; on by default where the display is. */
	gl: "on" | "off";
	/** Guest Vulkan (?vk=), Debian only; on by default where WebGPU is. */
	vk: "on" | "off";
}

type Listener = () => void;

export function createStore<T extends object>(init: T) {
	let s = init;
	const listeners = new Set<Listener>();
	return {
		get: (): T => s,
		set(patch: Partial<T> | ((s: T) => Partial<T>)) {
			s = { ...s, ...(typeof patch === "function" ? patch(s) : patch) };
			for (const l of listeners) l();
		},
		subscribe(l: Listener) {
			listeners.add(l);
			return () => { listeners.delete(l); };
		},
	};
}

export type Store<T extends object> = ReturnType<typeof createStore<T>>;

let store: Store<UiState> | null = null;

/** The page's store; ui.ts creates it (initStore) before anything renders. */
export function ui$(): Store<UiState> {
	if (!store) throw new Error("the UI store is not initialised");
	return store;
}

export function initStore(init: UiState): Store<UiState> {
	store = createStore(init);
	return store;
}

/** A field of the UI state; the component re-renders when it changes. */
export function useStore<U>(select: (s: UiState) => U): U {
	const s = ui$();
	return useSyncExternalStore(s.subscribe, () => select(s.get()));
}
