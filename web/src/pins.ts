// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// What is kept in the Dock (components/Dock.tsx: a tile each, in this
// order, after the launcher's): an ordered list of the launcher's apps and
// groups (apps/index.ts APPS, GROUPS: a group's tile opens its apps, the
// Dock's stack, DockStack.tsx), changed from the Dock's tile menus (Keep in
// Dock, Remove from Dock, Move Left, Move Right) and the launcher's
// (components/Launcher.tsx: its apps' and its folders' menus).
//
// - Stored as JSON in localStorage `kw.pins` (prefs.ts store(), with the page's
//   other immediate preferences): an array of strings, an app's id or
//   `group:<id>` for a group, in one order (app ids never hold a colon).
//   Without it (a fresh profile, or storage that refuses) the pins are
//   DEFAULT_PINS. Another tab's change follows through the storage event.
// - A default pin added after profiles had stored their own list (LATER_PINS:
//   Docs) is added to the end of a stored list once, and remembered in
//   localStorage `kw.pins-added` so that removing it again sticks.
// - Callers deal in targets ({ app } or { group }) and the shown pins (Pin:
//   a target and its stored key), not in the stored strings.
// - Entries the registry no longer has, a hidden app, or a group that is not
//   a folder (inline) or has no app to show, are kept in the stored list (one
//   that comes back is kept again) but are not shown: usePins() and pinned()
//   list only what can be pinned (canPin(), canPinGroup()), and move() orders
//   among those.
import { useSyncExternalStore } from "react";
import { APPS, GROUPS } from "./apps/index.ts";
import type { App, Group } from "./apps/types.ts";
import { createStore } from "./store.ts";
import { store } from "./prefs.ts";

/** The key under prefs.ts store()'s `kw.` prefix. */
const KEY = "pins";
/** A stored group entry's prefix. */
const GROUP = "group:";
/** A fresh profile's pins: the console's Terminal, Settings and Docs. */
export const DEFAULT_PINS: readonly string[] = ["terminal", "settings", "docs"];
/** The default pins a stored list predates: each is added to it once (see the top of this file). */
const LATER_PINS: readonly string[] = ["docs"];
/** The key of the LATER_PINS already added. */
const ADDED_KEY = "pins-added";

const BY_ID = new Map(APPS.map((a) => [a.id, a]));
const GROUP_BY_ID = new Map(GROUPS.map((g) => [g.id, g]));
/** An app may be kept in the Dock: any app the launcher lists (not a hidden one). */
export const canPin = (a: App | undefined): a is App => !!a && !a.hidden;
/** A group may be kept in the Dock: a launcher folder (not inline) with an app it lists. */
export const canPinGroup = (g: Group | undefined): g is Group => !!g && !g.inline && g.apps.some((a) => !a.hidden);
/** A group's apps as its folder and its Dock stack list them (not the hidden ones). */
export const groupApps = (g: Group): App[] => g.apps.filter((a) => !a.hidden);

/** What a pin stands for: an app or a launcher group. */
export type PinTarget = { app: App; group?: undefined } | { group: Group; app?: undefined };
/** A shown pin: its target and its stored key (unique among the pins: a React key, a tile's identity). */
export type Pin = PinTarget & { key: string };

/** The stored key of a target. */
export const pinKey = (t: PinTarget): string => (t.group ? `${GROUP}${t.group.id}` : t.app.id);
/** The stored key's target when it can be shown, else undefined. */
function resolve(key: string): Pin | undefined {
	if (key.startsWith(GROUP)) {
		const group = GROUP_BY_ID.get(key.slice(GROUP.length));
		return canPinGroup(group) ? { group, key } : undefined;
	}
	const app = BY_ID.get(key);
	return canPin(app) ? { app, key } : undefined;
}
const pinnable = (t: PinTarget): boolean => (t.group ? canPinGroup(t.group) : canPin(t.app));

function parse(raw: string | null): string[] {
	if (raw === null) return [...DEFAULT_PINS];
	try {
		const v: unknown = JSON.parse(raw);
		if (Array.isArray(v)) return [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0))];
	} catch { /* not ours: the defaults */ }
	return [...DEFAULT_PINS];
}

interface PinsState {
	/** The stored list, unknown entries included. */
	ids: string[];
	/** The pins shown, in order. */
	pins: Pin[];
}
const derive = (ids: string[]): PinsState => ({ ids, pins: ids.flatMap((id) => resolve(id) ?? []) });

/** The stored list with the LATER_PINS it has not had yet (saved when it changes). */
function withLater(): string[] {
	const raw = store(KEY), ids = parse(raw);
	let added: string[] = [];
	try { const v: unknown = JSON.parse(store(ADDED_KEY) ?? "[]"); if (Array.isArray(v)) added = v.filter((x): x is string => typeof x === "string"); } catch { /* none */ }
	const fresh = LATER_PINS.filter((x) => !added.includes(x));
	if (!fresh.length) return ids;
	store(ADDED_KEY, JSON.stringify([...added, ...fresh]));
	if (raw === null) return ids;
	const next = [...ids, ...fresh.filter((x) => !ids.includes(x))];
	if (next.length !== ids.length) store(KEY, JSON.stringify(next));
	return next;
}

export const pins$ = createStore<PinsState>(derive(withLater()));

function save(ids: string[]): void {
	pins$.set(derive(ids));
	store(KEY, JSON.stringify(ids));
}

if (typeof window !== "undefined") {
	addEventListener("storage", (e) => {
		if (e.key === `kw.${KEY}` || e.key === null) pins$.set(derive(parse(store(KEY))));
	});
}

/** The shown pins, in order (the Dock re-renders when they change). */
export function usePins(): Pin[] {
	return useSyncExternalStore(pins$.subscribe, () => pins$.get().pins);
}
export const pinned = (): Pin[] => pins$.get().pins;
/** The target's index among the shown pins, or -1. */
export const pinIndex = (t: PinTarget): number => {
	const key = pinKey(t);
	return pins$.get().pins.findIndex((p) => p.key === key);
};
export const isPinned = (t: PinTarget): boolean => pinIndex(t) >= 0;

/** Keep the app or group in the Dock: at the end, or at index `at` among the shown pins. */
export function pin(t: PinTarget, at?: number): void {
	if (!pinnable(t) || isPinned(t)) return;
	const shown = pins$.get().pins.map((p) => p.key);
	shown.splice(at === undefined ? shown.length : Math.max(0, Math.min(at, shown.length)), 0, pinKey(t));
	save(merge(shown));
}

/** Take the app or group out of the Dock. */
export function unpin(t: PinTarget): void {
	const { ids } = pins$.get(), key = pinKey(t);
	if (ids.includes(key)) save(ids.filter((x) => x !== key));
}

/** Move a pin to index `to` among the shown pins (clamped). */
export function move(t: PinTarget, to: number): void {
	const shown = pins$.get().pins.map((p) => p.key), key = pinKey(t);
	const from = shown.indexOf(key);
	if (from < 0) return;
	const n = Math.max(0, Math.min(to, shown.length - 1));
	if (n === from) return;
	shown.splice(from, 1);
	shown.splice(n, 0, key);
	save(merge(shown));
}

/** The shown pins in their new order, then the stored entries that are not shown (kept for one that comes back). */
function merge(shown: string[]): string[] {
	return [...shown, ...pins$.get().ids.filter((x) => !shown.includes(x) && !resolve(x))];
}
