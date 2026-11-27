// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A control's key after the shortcut prefix (keys.ts), as the chrome
// shows it: KeyHint, the key on the control while the prefix is armed
// (which-key style: the Dock's tiles, the top bar's icons, the terminal
// tabs), withKey() for its tooltip ("Settings (Ctrl-A ,)"), and menuKeys()
// for a menu item's shortcut column ("^A n"), left out on touch devices,
// which have no keyboard to press it on. Controls name their command by
// its id (keys.ts CommandId); keyFor() gives its key.
import { KW } from "../kw.ts";
import { keyFor, PREFIX, PREFIX_SHORT, type CommandId } from "../keys.ts";
import { useStore } from "../store.ts";

/** A tooltip with the control's key after the prefix (keyFor(), terminalKey()), when it has one. */
export const withKey = (title: string, key?: string): string => (key ? `${title} (${PREFIX} ${key})` : title);

/** A menu item's shortcut: command id's key after the prefix ("^A n"), none on touch devices. */
export const menuKeys = (id: CommandId): string | undefined => (KW.config?.coarse ? undefined : `${PREFIX_SHORT} ${keyFor(id)}`);

/**
 * Key `k`, shown while the prefix is armed: over the control's top left
 * corner (its parent is positioned), `small` for the top bar's icons, or
 * `inline` in a row of content (a tab's label).
 */
export function KeyHint({ k, small, inline }: { k: string; small?: boolean; inline?: boolean }) {
	const armed = useStore((s) => s.prefix);
	if (!armed) return null;
	const at = inline ? "flex-none" : `pointer-events-none absolute z-1 ${small ? "-top-0.5 -left-0.5" : "top-0 left-0"}`;
	const size = small ? "h-3.5 min-w-3.5 rounded-[3px] text-[10px]" : "h-4 min-w-4 rounded-[4px] text-[11px]";
	return <kbd className={`${at} grid ${size} place-items-center bg-warn px-0.5 font-mono leading-none font-semibold text-bg`}>{k}</kbd>;
}
