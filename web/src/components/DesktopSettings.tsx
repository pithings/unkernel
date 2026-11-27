// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Settings > Desktop (Settings.tsx; the state is desktop.ts): how the
// desktop looks, applied at once and kept in this browser (localStorage
// kw.desktop), not a boot option.
// - Wallpaper: thumbnails of Random (the default: the photo shown, with a
//   shuffle glyph; while it is the wallpaper, Next rolls again and Keep pins
//   the photo), the built-in default (the gradient and the mark) and the CSS
//   presets; then Photos, Lorem Picsum's: the curated ones and More (another
//   page of its list), whose thumbnails load once this section has been
//   shown. The credit of the photo shown, and one line on where photos come
//   from and when the page contacts that service. A click applies a
//   wallpaper; a photo shows a spinner until it has loaded, and a quiet line
//   if it did not.
// - Photo (while the wallpaper is Random or a photo): Dim and Blur.
// - Console: "Hide the console after boot" (autohide.ts; prefs.ts
//   kw.hideConsole, default on).
// More desktop options go in as further groups (an H3 and their controls)
// in DesktopSettings below.
import { useState, type ReactNode } from "react";
import { AUTO_HIDE_MS, hideConsolePref, setHideConsolePref } from "../autohide.ts";
import {
	DIM_MAX, PHOTOS, PRESETS, keepRandom, morePhotos, nextRandom, photoLink, setBlur, setDim, setWallpaper, thumbUrl, useDesktop, wallpaperKey,
	type Photo, type Wallpaper,
} from "../desktop.ts";
import { useAppVisible } from "../sysapps.ts";
import { H3, useSection } from "./AppShell.tsx";
import { PinIcon, ShuffleIcon } from "./icons.tsx";
import { Theme } from "./Options.tsx";

/** The default wallpaper in a thumbnail: style.css's #app gradient and #desktop mark. */
const DEFAULT_THUMB = {
	background: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none' stroke='%23fff' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='.5' y='.5' width='31' height='31' rx='7.5' stroke-opacity='.12'/%3E%3Cpath d='M9 11l5.5 5L9 21M16.5 21.5H23' stroke-width='2.4' stroke-opacity='.18'/%3E%3C/svg%3E\") center / 22px no-repeat, radial-gradient(130% 90% at 50% -10%, #171717 0%, #070707 55%, #000 100%)",
};
const Spinner = () => <span className="size-4 animate-spin rounded-full border-2 border-ink/25 border-t-ink" />;

export function DesktopSettings() {
	return (
		<>
			<Theme />
			<H3>Wallpaper</H3>
			<Builtins />
			<H3>Photos</H3>
			<Photos />
			<PhotoOptions />
			<ConsoleOptions />
		</>
	);
}

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2.5 pointer-coarse:grid-cols-[repeat(auto-fill,minmax(104px,1fr))]";

/** A wallpaper's thumbnail button: pressed while it is the wallpaper, a spinner while it loads. */
function Tile({ label, w, children }: { label: string; w: Wallpaper; children: ReactNode }) {
	const key = wallpaperKey(w);
	const on = useDesktop((s) => wallpaperKey(s.prefs.wallpaper) === key);
	const busy = useDesktop((s) => s.pending === key);
	return (
		<button type="button" aria-pressed={on} aria-label={label} title={label} onClick={() => void setWallpaper(w)}
			className="relative aspect-[16/10] overflow-hidden rounded-md border border-line bg-surface transition-[border-color,box-shadow] outline-none hover:border-(--line-hover) focus-visible:ring-2 focus-visible:ring-accent aria-pressed:border-fg aria-pressed:ring-2 aria-pressed:ring-fg/70">
			{children}
			{busy && <span className="absolute inset-0 grid place-items-center bg-bg/45"><Spinner /></span>}
		</button>
	);
}

function Builtins() {
	const random = useDesktop((s) => s.prefs.wallpaper.kind === "random");
	// The photo shown (Random's pick, or the placeholder): its decoded copy, no request.
	const url = useDesktop((s) => (s.prefs.wallpaper.kind === "random" ? s.shown?.url : undefined));
	const shownPhoto = useDesktop((s) => s.shown?.photo);
	const rolling = useDesktop((s) => s.pending === "random");
	return (
		<>
			<div className={GRID}>
				<Tile label="Random photo, a new one each load" w={{ kind: "random" }}>
					{url ? <img src={url} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
						: <span className="absolute inset-0 bg-[linear-gradient(135deg,#1d2c52,#432150_50%,#1a382f)]" />}
					<span className="absolute inset-0 grid place-items-center bg-black/25 text-white drop-shadow-[0_1px_2px_rgb(0_0_0/60%)]"><ShuffleIcon size={18} /></span>
				</Tile>
				<Tile label="Default" w={{ kind: "default" }}><span className="absolute inset-0" style={DEFAULT_THUMB} /></Tile>
				{PRESETS.map((p) => (
					<Tile key={p.id} label={p.name} w={{ kind: "preset", id: p.id }}><span className="absolute inset-0" style={{ background: p.css }} /></Tile>
				))}
			</div>
			{random && (
				<div className="mt-3 flex flex-wrap gap-2">
					<button id="desktop-next" type="button" className="btn btn-sm" disabled={rolling} onClick={() => void nextRandom()}>
						{rolling ? <Spinner /> : <ShuffleIcon size={13} />}Next
					</button>
					<button id="desktop-keep" type="button" className="btn btn-sm" disabled={!shownPhoto} title="Keep this photo as the wallpaper" onClick={keepRandom}>
						<PinIcon />Keep
					</button>
				</div>
			)}
		</>
	);
}

/** A Picsum thumbnail (CORS, so it loads in the cross-origin isolated page; no referrer). */
function Thumb({ photo }: { photo: Photo }) {
	const [failed, setFailed] = useState(false);
	return failed ? <span className="absolute inset-0 bg-hover" />
		: <img src={thumbUrl(photo.id)} alt="" crossOrigin="anonymous" referrerPolicy="no-referrer" loading="lazy" decoding="async" draggable={false}
			onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />;
}

function Photos() {
	// The thumbnails load once the section has been seen (it is rendered all the time, hidden).
	const section = useSection("settings"), visible = useAppVisible("settings");
	const [seen, setSeen] = useState(false);
	if (section === "desktop" && visible && !seen) setSeen(true);
	const more = useDesktop((s) => s.more);
	const moreBusy = useDesktop((s) => s.moreBusy);
	const error = useDesktop((s) => s.error);
	const wp = useDesktop((s) => s.prefs.wallpaper);
	const credit = useDesktop((s) => s.shown?.photo);
	const photos = [...PHOTOS, ...more];
	// The chosen photo, from More on an earlier load: shown too.
	if (wp.kind === "photo" && !photos.some((p) => p.id === wp.photo.id)) photos.unshift(wp.photo);
	const remote = wp.kind === "random" || wp.kind === "photo";
	return (
		<>
			{seen && (
				<div className={GRID}>
					{photos.map((p) => <Tile key={p.id} label={`Photo by ${p.author}`} w={{ kind: "photo", photo: p }}><Thumb photo={p} /></Tile>)}
					<button type="button" title="More photos" aria-label="More photos" disabled={moreBusy} onClick={() => void morePhotos()}
						className="grid aspect-[16/10] place-items-center rounded-md border border-dashed border-line-strong text-muted transition-colors outline-none hover:border-(--line-hover) hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-progress">
						{moreBusy ? <Spinner /> : <ShuffleIcon />}
					</button>
				</div>
			)}
			{error && <p role="status" className="mt-2.5 font-sans text-[12px] text-warn">{error}</p>}
			<p className="mt-2.5 font-sans text-[12px] text-faint">
				{credit && remote && <>Photo by <Ext href={photoLink(credit)}>{credit.author}</Ext> on Unsplash. </>}
				Photos come from <Ext href="https://picsum.photos/">Lorem Picsum</Ext>
				{remote ? ", which this page contacts on every load; Default and the presets make no request." : ", contacted only while this section is open."}
			</p>
		</>
	);
}

const Ext = ({ href, children }: { href: string; children: ReactNode }) => (
	<a href={href} target="_blank" rel="noopener noreferrer" className="text-muted underline decoration-line-strong underline-offset-2 hover:text-fg">{children}</a>
);

/** Dim and Blur, while the wallpaper is a photo (Random's or a chosen one). */
function PhotoOptions() {
	const photo = useDesktop((s) => s.prefs.wallpaper.kind === "photo" || s.prefs.wallpaper.kind === "random");
	const dim = useDesktop((s) => s.prefs.dim);
	const blur = useDesktop((s) => s.prefs.blur);
	if (!photo) return null;
	const pct = Math.round(dim * 100), max = Math.round(DIM_MAX * 100);
	return (
		<>
			<H3>Photo</H3>
			<div className="flex max-w-sm flex-col gap-4">
				<div className="flex flex-col gap-1.5 text-[11.5px] text-faint [--thumb:12px]">
					<div className="flex items-baseline justify-between gap-2">
						<label htmlFor="desktop-dim">Dim</label>
						<output htmlFor="desktop-dim" className="font-mono text-[12px] text-fg tabular-nums">{pct}%</output>
					</div>
					<input id="desktop-dim" type="range" min={0} max={max} step={5} value={pct} onChange={(e) => setDim(Number(e.currentTarget.value) / 100)}
						className="slider w-full" style={{ "--fill": `calc(${pct / max} * (100% - var(--thumb)) + var(--thumb) / 2)` } as never} />
				</div>
				<label className="flex cursor-pointer items-center gap-2 text-muted select-none hover:text-fg">
					<input id="desktop-blur" type="checkbox" checked={blur} onChange={(e) => void setBlur(e.currentTarget.checked)} className="peer sr-only" />
					<span aria-hidden="true" className="whitespace-pre peer-focus-visible:outline-2 peer-focus-visible:outline-accent">
						<span className="text-faint">[</span><span className={blur ? "text-ok" : ""}>{blur ? "x" : " "}</span><span className="text-faint">]</span>
					</span>
					<span className={blur ? "text-fg" : ""}>Blur</span>
				</label>
			</div>
		</>
	);
}

/** Hide the console after boot (autohide.ts): a checkbox like Blur's, kept in this browser. */
function ConsoleOptions() {
	const [on, setOn] = useState(hideConsolePref);
	return (
		<>
			<H3>Console</H3>
			<label className="flex w-fit cursor-pointer items-center gap-2 text-muted select-none hover:text-fg">
				<input id="desktop-hide-console" type="checkbox" checked={on} onChange={(e) => { const v = e.currentTarget.checked; setHideConsolePref(v); setOn(v); }} className="peer sr-only" />
				<span aria-hidden="true" className="whitespace-pre peer-focus-visible:outline-2 peer-focus-visible:outline-accent">
					<span className="text-faint">[</span><span className={on ? "text-ok" : ""}>{on ? "x" : " "}</span><span className="text-faint">]</span>
				</span>
				<span className={on ? "text-fg" : ""}>Hide the console after boot</span>
			</label>
			<p className="mt-2.5 font-sans text-[12px] text-faint">
				Untouched for {AUTO_HIDE_MS / 1000} s once the system runs, the console goes into its Dock tile. Not on phones, in safe mode or after a resume.
			</p>
		</>
	);
}
