// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The unkernel mark: a prompt on a black tile (also the favicon, index.html).
// And the chrome's stroke icons (the Dock, the top bar, the window title bars,
// the apps' toolbars): 24-unit paths drawn in currentColor at any size;
// MetaIcon, a window's or a Dock tile's icon (apps/types.ts AppMeta.glyph,
// a guest app's image among them);
// and AppGlyph, an app's or group's own icon (apps/types.ts AppIcon) inside
// whatever tile the Dock or the launcher draws around it.
import type { ReactNode } from "react";
import type { AppIcon, AppMeta } from "../apps/types.ts";

export function Mark({ size = 20, className }: { size?: number; className?: string }) {
	return (
		<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={className}>
			<rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="#000" stroke="#333" />
			<path d="M9 11l5.5 5L9 21" stroke="#ededed" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M16.5 21.5H23" stroke="#ededed" strokeWidth="2.4" strokeLinecap="round" />
		</svg>
	);
}

/** A stroke icon in currentColor, `size` px (default 13). */
const Icon = ({ children, size = 13, className }: { children: ReactNode; size?: number; className?: string }) => (
	<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{children}</svg>
);
type P = { size?: number; className?: string };
/** A gear: a ring with eight teeth and a hub. */
export const SysIcon = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="6.5" /><circle cx="12" cy="12" r="2.5" /><path d="M18.5 12H21M12 18.5V21M5.5 12H3M12 5.5V3M16.6 16.6l1.8 1.8M7.4 16.6l-1.8 1.8M7.4 7.4 5.6 5.6M16.6 7.4l1.8-1.8" /></Icon>;
export const LogIcon = (p: P) => <Icon {...p}><path d="M4 5h16M4 10h16M4 15h10M4 20h7" /></Icon>;
export const MemIcon = (p: P) => <Icon {...p}><rect x="5" y="5" width="14" height="14" rx="1.5" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></Icon>;
/** A processor: a square chip with pins on every side and its die. */
export const CpuIcon = (p: P) => <Icon {...p}><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="10" y="10" width="4" height="4" rx=".5" /><path d="M10 2.5V6M14 2.5V6M10 18v3.5M14 18v3.5M2.5 10H6M2.5 14H6M18 10h3.5M18 14h3.5" /></Icon>;
/** A memory module: a long board with chips on it and contacts along its edge. */
export const RamIcon = (p: P) => <Icon {...p}><rect x="2.5" y="6" width="19" height="10" rx="1.5" /><path d="M6.5 9.5v3M10.5 9.5v3M13.5 9.5v3M17.5 9.5v3M6 16v3M10 16v3M14 16v3M18 16v3" /></Icon>;
/** A graphics card: the board, its fan, the bus connector (guest GL). */
export const GpuIcon = (p: P) => <Icon {...p}><rect x="2.5" y="5.5" width="19" height="11" rx="1.5" /><circle cx="9" cy="11" r="3" /><path d="M15.5 9v4M18.5 9v4M6 16.5v3h8v-3" /></Icon>;
export const DiskIcon = (p: P) => <Icon {...p}><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></Icon>;
export const PauseIcon = (p: P) => <Icon {...p}><path d="M9 5v14M15 5v14" /></Icon>;
/** A circular arrow. */
export const RebootIcon = (p: P) => <Icon {...p}><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v4.5h-4.5" /></Icon>;
/** A power symbol: a broken ring with a stroke through the gap. */
export const PowerIcon = (p: P) => <Icon {...p}><path d="M12 3v8" /><path d="M6.3 6.8a8 8 0 1 0 11.4 0" /></Icon>;
export const PlayIcon = (p: P) => <Icon {...p}><path d="M7 4.5v15L19.5 12 7 4.5Z" /></Icon>;
export const ErrIcon = (p: P) => <Icon {...p}><path d="M12 3.5 2.5 20h19L12 3.5Z" /><path d="M12 10v4.5M12 17.5h0" /></Icon>;
/** A monitor on a stand: the guest's display. */
export const DisplayIcon = (p: P) => <Icon {...p}><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8M12 16v4" /></Icon>;
/** Two overlapping windows: the Wayland desktop. */
export const DesktopIcon = (p: P) => <Icon {...p}><rect x="3" y="7" width="13" height="11" rx="1.5" /><path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h10A1.5 1.5 0 0 1 21 5.5v8a1.5 1.5 0 0 1-1.5 1.5H16" /></Icon>;
/** A picture (hills and a sun in a frame): the wallpaper, Settings' Desktop. */
export const WallpaperIcon = (p: P) => <Icon {...p}><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="m3.5 17 5-5.5 4 4 2.5-2.5 5.5 5.5" /><circle cx="15.5" cy="9" r="1.5" /></Icon>;
/** A prompt: the console and the terminal windows. */
export const PromptIcon = (p: P) => <Icon {...p}><path d="m5 7 5 5-5 5M12.5 17H19" /></Icon>;
/** A globe: the preview of a web server in the guest. */
/** An open book. */
export const DocsIcon = (p: P) => <Icon {...p}><path d="M12 6.5C10.3 5 7.9 4.5 3.5 4.5v14c4.4 0 6.8.5 8.5 2 1.7-1.5 4.1-2 8.5-2v-14c-4.4 0-6.8.5-8.5 2ZM12 6.5v14" /></Icon>;
export const PreviewIcon = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" /></Icon>;
/** Nine squares: the launcher. */
export const GridIcon = (p: P) => <Icon {...p}><rect x="4" y="4" width="4" height="4" rx="1" /><rect x="10" y="4" width="4" height="4" rx="1" /><rect x="16" y="4" width="4" height="4" rx="1" /><rect x="4" y="10" width="4" height="4" rx="1" /><rect x="10" y="10" width="4" height="4" rx="1" /><rect x="16" y="10" width="4" height="4" rx="1" /><rect x="4" y="16" width="4" height="4" rx="1" /><rect x="10" y="16" width="4" height="4" rx="1" /><rect x="16" y="16" width="4" height="4" rx="1" /></Icon>;
export const PlusIcon = (p: P) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>;
export const MinIcon = (p: P) => <Icon {...p}><path d="M6 12h12" /></Icon>;
export const MaxIcon = (p: P) => <Icon {...p}><rect x="5.5" y="5.5" width="13" height="13" rx="1.5" /></Icon>;
/** Two squares: restore a maximized window. */
export const UnmaxIcon = (p: P) => <Icon {...p}><rect x="5" y="8.5" width="10.5" height="10.5" rx="1.5" /><path d="M8.5 8.5V6.5A1.5 1.5 0 0 1 10 5h7.5A1.5 1.5 0 0 1 19 6.5V14a1.5 1.5 0 0 1-1.5 1.5h-2" /></Icon>;
/** A square with its left or right half filled: snap a window to that half (wm.ts). */
export const TileIcon = ({ side, ...p }: P & { side: "left" | "right" }) => (
	<Icon {...p}><rect x="4.5" y="5.5" width="15" height="13" rx="1.5" /><rect x={side === "left" ? 7 : 13} y="8" width="4" height="8" rx=".5" fill="currentColor" stroke="none" /></Icon>
);
export const CloseIcon = (p: P) => <Icon {...p}><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></Icon>;
/** A chevron pointing right (a disclosure: turned down while open). */
export const ChevronIcon = (p: P) => <Icon {...p}><path d="m9 6 6 6-6 6" /></Icon>;
/** Two overlapping sheets: copy. */
export const CopyIcon = (p: P) => <Icon {...p}><rect x="8.5" y="8.5" width="12" height="12" rx="2" /><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" /></Icon>;
/** A tick: done (a copy made). */
export const CheckIcon = (p: P) => <Icon {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Icon>;
/** The About triangle (filled). */
export const Triangle = ({ size = 11 }: { size?: number }) => (
	<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 23 21.5H1Z" fill="currentColor" /></svg>
);

/** A pulse line: the System app (sysapps.ts). */
export const ActivityIcon = (p: P) => <Icon {...p}><path d="M3 12h4l2.5-6 5 12 2.5-6h4" /></Icon>;
/** Two switches, one on the right and one on the left: the top bar's Control Center (ControlCenter.tsx). */
export const ControlIcon = (p: P) => (
	<Icon {...p}>
		<rect x="2.5" y="4" width="19" height="7" rx="3.5" /><circle cx="17.5" cy="7.5" r="1.25" fill="currentColor" />
		<rect x="2.5" y="13" width="19" height="7" rx="3.5" /><circle cx="6.5" cy="16.5" r="1.25" fill="currentColor" />
	</Icon>
);
/** A globe (the network, the top bar), struck through when it is off. */
export const NetIcon = ({ off, size = 15, ...p }: P & { off?: boolean }) => (
	<Icon size={size} {...p}>
		<circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
		{off && <path d="M4 4l16 16" />}
	</Icon>
);
/** Three stacked sheets: the distro (Settings). */
export const LayersIcon = ({ size = 14, ...p }: P) => <Icon size={size} {...p}><path d="M12 3 2.5 8 12 13l9.5-5L12 3Z" /><path d="m2.5 12 9.5 5 9.5-5M2.5 16l9.5 5 9.5-5" /></Icon>;
/** A compact keyboard, one row of keys and a space bar: the shortcuts (Settings' Keyboard). */
export const KeysIcon = ({ size = 14, ...p }: P) => <Icon size={size} {...p}><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8" /></Icon>;
/** Crossing arrows: another wallpaper (DesktopSettings). */
export const ShuffleIcon = ({ size = 16, ...p }: P) => <Icon size={size} {...p}><path d="M3 7h3.5c2 0 3.2 1 4.3 2.6l2.4 4.8C14.3 16 15.5 17 17.5 17H21M3 17h3.5c1.4 0 2.4-.5 3.2-1.4M14.3 8.4C15.1 7.5 16.1 7 17.5 7H21M18 4l3 3-3 3M18 14l3 3-3 3" /></Icon>;
/** A push pin: keep this wallpaper (DesktopSettings). */
export const PinIcon = (p: P) => <Icon {...p}><path d="M9 4h6l-1 6 3 3H7l3-3-1-6ZM12 13v7" /></Icon>;
/** An arrow out of a box: open in a new tab (the Browser). */
export const ExternalIcon = ({ size = 14, ...p }: P) => <Icon size={size} {...p}><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /></Icon>;
/** A magnifier: the launcher's search field (a little heavier than the rest). */
export const SearchIcon = ({ size = 14, className }: P) => (
	<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" className={className}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);

// The Display window's controls (Display.tsx Pad), 14 px.
/** Full screen: corners out, or in while it is on. */
export const FullscreenIcon = ({ on, size = 14, ...p }: P & { on: boolean }) => (
	<Icon size={size} {...p}><path d={on ? "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" : "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"} /></Icon>
);
/** Touch mode "mouse": the pointer goes to the finger (an arrow pointer). */
export const PointerIcon = ({ size = 14, ...p }: P) => <Icon size={size} {...p}><path d="M5 3l5.5 17 2.6-7.4L20.5 10z" /><path d="M13.1 12.6 19 18.5" /></Icon>;
/** Touch mode "trackpad": a pad with its two buttons. */
export const TrackpadIcon = ({ size = 14, ...p }: P) => <Icon size={size} {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 15h18M12 15v5" /></Icon>;
/** A full keyboard, two rows of keys and a space bar: the on-screen keyboard. */
export const KeyboardIcon = ({ size = 14, ...p }: P) => (
	<Icon size={size} {...p}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M10 13h4M7 16h10" /></Icon>
);
/** The stick and buttons on or off: a controller. */
export const GamepadIcon = ({ size = 14, ...p }: P) => (
	<Icon size={size} {...p}><path d="M7 7h10a5 5 0 0 1 4.6 7l-1 2.4a2.5 2.5 0 0 1-4.3.5L14.5 15h-5l-1.8 1.9a2.5 2.5 0 0 1-4.3-.5l-1-2.4A5 5 0 0 1 7 7z" /><path d="M7.5 10v3M6 11.5h3M16 11h.01M18 12.5h.01" /></Icon>
);
/** A phone on its side between two turning arrows: rotate the display. */
export const RotateIcon = ({ size = 14, ...p }: P) => (
	<Icon size={size} {...p}>
		<rect x="7" y="2.5" width="10" height="16" rx="1.5" transform="rotate(-90 12 12)" />
		<path d="M3 8a9 9 0 0 1 9-5l-2-1.5M21 16a9 9 0 0 1-9 5l2 1.5" />
	</Icon>
);

/**
 * A window's or a Dock tile's icon (apps/types.ts AppMeta.glyph), `size` px:
 * a stroke icon; an app's character (in a semibold face at 0.8 of the size)
 * or pictogram (AppGlyph); an image (a guest app's icon, a blob: URL, so an
 * SVG one runs nothing), in an <img>; else the title's first letter.
 */
export function MetaIcon({ meta, size = 18 }: { meta: AppMeta; size?: number }) {
	const g = meta.glyph;
	if (typeof g === "function") return <>{g({ size })}</>;
	if (typeof g === "string") return <span aria-hidden="true" className="leading-none font-semibold" style={{ fontSize: Math.round(size * 0.8) }}>{g}</span>;
	if (g && "src" in g) return <img src={g.src} alt="" aria-hidden="true" width={size} height={size} draggable={false} className="object-contain" />;
	if (g) return <AppGlyph icon={g} size={size} />;
	return <span aria-hidden="true" className="font-mono font-semibold leading-none" style={{ fontSize: size * 0.8 }}>{(meta.title.trim()[0] ?? "?").toUpperCase()}</span>;
}

/**
 * An app's or group's own icon (apps/types.ts): a character, as text in the
 * tile's font (in a span with `textClassName` if given, else bare), or a
 * pictogram filled in currentColor (its own fills stay), `size` px or sized
 * by `className`. The pictogram is static markup from the app files, never
 * user input, so it is set as inner HTML. The tile around it is the caller's.
 */
export function AppGlyph({ icon, size, className, textClassName }: { icon: string | AppIcon; size?: number; className?: string; textClassName?: string }) {
	if (typeof icon === "string") return textClassName ? <span aria-hidden="true" className={textClassName}>{icon}</span> : <>{icon}</>;
	return <svg width={size} height={size} viewBox={icon.viewBox ?? "0 0 24 24"} fill="currentColor" aria-hidden="true" className={className} dangerouslySetInnerHTML={{ __html: icon.svg }} />;
}
