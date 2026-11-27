// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Settings app (sysapps.ts; a desktop window, AppShell.tsx): what the user
// changes or acts on. Sections (the options are Options.tsx's groups, saved
// and applied by Reboot, ui.nextSettings()):
// - Machine (boot): CPUs, memory, worker thread, JIT, verbose boot, the
//   kernel command line;
// - Distro: the image, safe mode;
// - Storage (the old Guest tab's name opens it): the data disk option, its
//   state, the safe-mode note and its actions (Export, Import, Reset, Safe
//   mode);
// - Network: Wisp, and the preview of the guest's web servers;
// - Display and sound: display, guest GL, sound, the terminal font size (at
//   once);
// - Desktop: the wallpaper and its dim and blur (at once, DesktopSettings.tsx);
// - Session: suspend in the background, ask before closing;
// - Keyboard: the shortcuts (keys.ts COMMANDS), under the keyboard the
//   shortcuts HUD draws (KeysHud.tsx Keyboard, not on phones);
// - About: the build and the credits (About.tsx).
// A section with options changed since this boot has a dot in the list.
// Footer, from every section: what changed, Suspend (Resume once suspended)
// and Reboot, which says "Reboot to apply" while the options differ from
// this boot's.
// Rendered all the time (into its element, sysapps.ts), so its ids are always in
// the document, as the old dialog's were.
import { useRef, useState } from "react";
import { KW } from "../kw.ts";
import { lastPreviewPort, openPreview, previewSupported } from "../preview.ts";
import { APPLE, CHORD, COMMANDS, DIALOG_KEYS, PREFIX, directKeys, keyFor } from "../keys.ts";
import { useStore, type Tab } from "../store.ts";
import { AboutInfo } from "./About.tsx";
import { AppShell, H3, K, type SectionDef } from "./AppShell.tsx";
import { Keyboard } from "./KeysHud.tsx";
import { DesktopSettings } from "./DesktopSettings.tsx";
import { DiskIcon, DisplayIcon, KeysIcon, LayersIcon, MemIcon, PauseIcon, PreviewIcon, Triangle, WallpaperIcon } from "./icons.tsx";
import { DisplayOptions, DistroOptions, FontSize, MachineOptions, NetworkOptions, SessionOptions, StorageOptions, TermGlass, TermTheme } from "./Options.tsx";

const SECTIONS: SectionDef[] = [
	{ id: "boot", name: "Machine", icon: <MemIcon size={14} />, desc: "The virtual machine and the kernel. Applied when you reboot." },
	{ id: "distro", name: "Distro", icon: <LayersIcon />, desc: "The root file system the guest boots. Applied when you reboot." },
	{ id: "storage", name: "Storage", icon: <DiskIcon size={14} />, desc: "The data disk: /data and your changes to the root, kept in this browser." },
	{ id: "network", name: "Network", icon: <PreviewIcon size={14} />, desc: "The guest's internet, and its web servers in a browser window." },
	{ id: "display", name: "Display and sound", icon: <DisplayIcon size={14} />, desc: "The guest's devices (applied when you reboot) and the terminal's font and colours." },
	{ id: "desktop", name: "Desktop", icon: <WallpaperIcon size={14} />, desc: "The wallpaper and the console after boot. Applied at once." },
	{ id: "session", name: "Session", icon: <PauseIcon size={14} />, desc: "Saving the running system when the tab is hidden or closed." },
	{ id: "keys", name: "Keyboard", icon: <KeysIcon />, desc: <>Shortcuts work anywhere: {PREFIX}, then a key.</> },
	{ id: "about", name: "About", icon: <Triangle size={12} /> },
];
/** Which section each saved setting's control is in (ui.nextSettings()'s names), for the changed dots. */
const SETTING_SECTION: Record<string, Tab> = {
	mem: "boot", cpus: "boot", worker: "boot", jit: "boot", verbose: "boot", append: "boot",
	distro: "distro", root: "distro", data: "storage", datasize: "storage", wisp: "network",
	display: "display", gl: "display", vk: "display", sound: "display", autosuspend: "session", askleave: "session",
};

/** The sections whose options differ from this boot's settings. */
function changedSections(): Set<Tab> {
	const next = KW.ui!.nextSettings(), cur = KW.config.settings as Record<string, string>;
	const out = new Set<Tab>();
	for (const k of new Set([...Object.keys(next), ...Object.keys(cur)]))
		if (next[k] !== cur[k] && SETTING_SECTION[k]) out.add(SETTING_SECTION[k]);
	return out;
}

export function Settings() {
	const ui = KW.ui!;
	const options = useStore((s) => s.options);
	const suspended = useStore((s) => s.suspended);
	void options; // re-render (the dots, the Reboot label) when an option changes
	const changed = ui.optionsChanged();
	const dirty = changed ? changedSections() : new Set<Tab>();
	const sections = SECTIONS.map((s) => (dirty.has(s.id) ? { ...s, changed: true } : s));
	const names = SECTIONS.filter((s) => dirty.has(s.id)).map((s) => s.name).join(", ");
	return (
		<AppShell app="settings" label="Settings" sections={sections}
			render={(id) => id === "boot" ? <MachineOptions />
				: id === "distro" ? <DistroOptions />
				: id === "storage" ? <Storage />
				: id === "network" ? <Network />
				: id === "display" ? <><DisplayOptions /><H3>Terminal</H3><FontSize /><TermTheme /><TermGlass /></>
				: id === "desktop" ? <DesktopSettings />
				: id === "session" ? <SessionOptions />
				: id === "keys" ? <KeysHelp />
				: <AboutInfo />}
			footer={<>
				<p className={`mr-auto min-w-0 truncate text-[12px] max-sm:basis-full ${changed ? "text-warn" : "text-faint"}`} title={changed && names ? `Changed: ${names}` : undefined}>
					{changed ? `Changed${names ? `: ${names}` : ""}. Applies when you reboot` : "Options apply when you reboot"}
				</p>
				{suspended
					? <button id="resume-settings" type="button" className="btn btn-sm max-sm:flex-1" onClick={() => ui.resume()}>Resume</button>
					: <button id="suspend" type="button" className="btn btn-sm max-sm:flex-1" title="Save the running system in this browser and stop it; Resume, or the next load, resumes it"
						onClick={() => ui.suspend()}>Suspend</button>}
				<button id="reboot" type="button" className={`btn btn-sm max-sm:flex-1 ${changed ? "btn-primary" : ""}`} onClick={() => ui.reboot()}>{changed ? "Reboot to apply" : "Reboot"}</button>
			</>}
		/>
	);
}

function Storage() {
	return (
		<>
			<StorageOptions />
			<H3>Data disk</H3>
			<DataDisk />
		</>
	);
}

function Network() {
	return (
		<>
			<NetworkOptions />
			<H3>Guest web servers</H3>
			<PreviewOpen />
		</>
	);
}

function DataDisk() {
	const ui = KW.ui!;
	const status = useStore((s) => s.dataStatus);
	const safeNote = useStore((s) => s.safeNote);
	const file = useRef<HTMLInputElement>(null);
	const safe = KW.config.root === "initramfs";
	return (
		<>
			<p id="data-status" className="text-muted">{status}</p>
			<p id="data-safe-note" hidden={!safeNote} className="mt-2 border-l-2 border-warn pl-3 text-fg">{safeNote}</p>
			<div className="mt-3 flex flex-wrap gap-2">
				<button id="data-export" type="button" className="btn btn-sm" title="Download /data as a .kwsparse.gz file" onClick={() => ui.dataExport()}>Export</button>
				<button id="data-import" type="button" className="btn btn-sm" title="Replace /data with an exported file"
					onClick={async () => { if (await ui.dataImport() && file.current) { file.current.value = ""; file.current.click(); } }}>Import…</button>
				<button id="data-reset" type="button" className="btn btn-sm" title="Start /data again from an empty file system" onClick={() => ui.dataReset()}>Reset</button>
				<button id="data-safe" type="button" className="btn btn-sm"
					title={safe ? "Reboot with the overlay root and your changes on the data disk" : "Reboot with the plain image as the root (kw.root=initramfs), to repair an overlay root"}
					onClick={() => ui.safeModeToggle()}>{safe ? "Leave safe mode" : "Safe mode"}</button>
				<input ref={file} type="file" id="data-file" accept=".gz,.kwsparse,application/gzip,application/octet-stream" hidden
					onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) ui.dataImport(f); }} />
			</div>
		</>
	);
}

/** Open the guest preview (preview.ts, Preview.tsx) on a port; outside the Options form, as it is no URL parameter. */
function PreviewOpen() {
	const ui = KW.ui!;
	const [port, setPort] = useState(() => String(lastPreviewPort()));
	if (!previewSupported()) return <p id="preview-status" className="text-muted">Needs a secure context (https or localhost): the preview runs on a service worker.</p>;
	const open = () => { if (!openPreview(port)) ui.toast(`Not a port: ${port}`); };
	return (
		<>
			<p className="text-muted">A web server running in the guest (e.g. <code className="text-fg">python3 -m http.server 8000</code>), in a window over the terminal or a tab of its own while this page stays open. {PREFIX} {keyFor("preview")} opens it too.</p>
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<label className="flex items-center gap-1.5 text-[11.5px] text-faint">Port
					<input id="preview-open-port" type="text" inputMode="numeric" value={port} size={5} autoComplete="off" spellCheck={false}
						onChange={(e) => setPort(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); open(); } }}
						className="field h-8 w-20 px-2 text-[12.5px] text-fg" />
				</label>
				<button id="preview-open" type="button" className="btn btn-sm" onClick={open}>Preview</button>
			</div>
		</>
	);
}

function KeysHelp() {
	return (
		<>
			<H3>Anywhere: {PREFIX}, then a key</H3>
			<div className="mb-4 max-sm:hidden"><Keyboard /></div>
			<dl className="grid grid-cols-[minmax(84px,auto)_minmax(108px,auto)_1fr] gap-x-4 gap-y-1.5 max-sm:grid-cols-[minmax(72px,auto)_1fr]">
				{COMMANDS.map((c) => (
					<div key={c.id} className="contents">
						<dt>{c.keys.map((k) => <K key={k}>{k}</K>)}</dt>
						<dd className="text-faint max-sm:hidden">{directKeys(c).join(", ")}</dd>
						<dd className="text-muted">{c.label}</dd>
					</div>
				))}
				{!APPLE && <><dt><K>{PREFIX}</K></dt><dd className="max-sm:hidden" /><dd className="text-muted">Send {PREFIX} itself to the guest</dd></>}
				<dt><K>1</K>…<K>9</K></dt><dd className="text-faint max-sm:hidden">{CHORD}-1…9</dd><dd className="text-muted">Terminals 1 to 9: tabs of the Terminal windows, each its own shell ({keyFor("new-tab")} opens one; its tab closes when its shell exits)</dd>
			</dl>
			<H3>In Settings and System</H3>
			<dl className="grid grid-cols-[minmax(84px,auto)_1fr] gap-x-4 gap-y-1.5">
				{DIALOG_KEYS.map(([k, label]) => (
					<div key={label} className="contents"><dt className="text-muted">{k}</dt><dd className="text-muted">{label}</dd></div>
				))}
			</dl>
			<H3>Terminal</H3>
			<p className="text-muted">{APPLE ? "⌘C copies the selected text; Ctrl-C always sends ^C." : "With text selected, Ctrl-C copies instead of sending ^C; Ctrl-Shift-C always copies."} On phones, pinch the terminal to change the font size; the extra keys show above the on-screen keyboard.</p>
		</>
	);
}
