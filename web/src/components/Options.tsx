// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Options: one control per setting (config.ts) except ?simulate and
// ?showcase, in groups that Settings (Settings.tsx) shows in its sections:
// MachineOptions (CPUs, memory, worker thread, JIT, verbose boot, kernel
// command line), DistroOptions (distro, safe mode), StorageOptions (data disk),
// NetworkOptions (Wisp), DisplayOptions (display, guest GL, guest Vulkan, sound) and
// SessionOptions (suspend in the background, ask before closing). Reboot
// saves them in localStorage and reloads (ui.nextSettings()).
// Terminal style: on/off options are [x] check boxes, Network and Distro are
// (•) radio choices, CPUs and Memory are sliders over their counts and sizes.
// FontSize is the same kind of slider; it applies at once and is kept in
// localStorage. The
// CPUs slider is disabled, with the reason, where the page cannot boot more
// than one (config.ts smpBlocker()). Distro (?distro=) lists the page's images and none.
// Guest GL (?gl=, on by default where the display is) is disabled, unticked, with the reason,
// where the page cannot offer it (config.ts glBlocker()) or the Distro chosen is not one of
// GL_DISTROS; its stored value stays. Guest Vulkan (?vk=, on by default) likewise, where the
// page cannot offer it (config.ts vkBlocker()) or the Distro chosen is not one of VK_DISTROS.
// Suspend in the background (?autosuspend=, autosuspend.ts) offers off, at once, 30 s and 5 min,
// plus a ?autosuspend= of other seconds; this device's default is marked.
//
// The fields are controlled by the store. Besides onChange, native listeners
// on each group's form (OptionsForm; capture phase, so non-bubbling events
// count too) read every change: React drops an event whose value was set
// from script (autofill, the browser tests), and the store would miss it. A
// check box stores its data-on or data-off value, so the options keep the
// values nextSettings() reads.
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";
import { AUTO_SUSPEND_CHOICES, autoSuspendLabel } from "../autosuspend.ts";
import { DATA_SIZES, DEFAULT_CMDLINE, dataSizeCap, DEFAULT_DISTRO, DISTROS_OFFERED, GL_DISTROS, VK_DISTROS } from "../config.ts";
import { capitalize, fmtSize } from "../format.ts";
import { KW } from "../kw.ts";
import { useStore, type Options as Opts } from "../store.ts";
import { autoFont } from "../ui.ts";

/** A field changed: the store's option of its name, or the font size (applied at once). */
function onField(e: Event | ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
	const t = e.target as HTMLInputElement | HTMLSelectElement;
	if (!t.name) return;
	let v = t.value;
	if (t instanceof HTMLInputElement && t.type === "checkbox") v = (t.checked ? t.dataset.on : t.dataset.off) ?? "";
	else if (t instanceof HTMLInputElement && t.type === "range") v = t.dataset.values?.split(",")[openStop(t, +t.value)] ?? "";
	else if (t instanceof HTMLInputElement && t.type === "radio" && !t.checked) return;
	pick(t.name, v);
}

/** A slider's stop index, moved to the nearest stop that is not off (data-off: their indices). */
function openStop(t: HTMLInputElement, i: number): number {
	const off = new Set((t.dataset.off ?? "").split(",").filter(Boolean).map(Number));
	for (let d = 0; d <= +t.max; d++) {
		if (i - d >= 0 && !off.has(i - d)) return i - d;
		if (i + d <= +t.max && !off.has(i + d)) return i + d;
	}
	return i;
}

const pick = (name: string, v: string) => (name === "font" ? KW.ui!.setFont(v)
	: name === "theme" ? KW.ui!.setTheme(v)
	: name === "termtheme" ? KW.ui!.setTermTheme(v)
	: name === "termglass" ? KW.ui!.setTermGlass(v)
	: KW.ui!.setOption(name as keyof Opts, v as never));

function Field({ label, wide, hidden, id, children }: { label: string; wide?: boolean; hidden?: boolean; id?: string; children: ReactNode }) {
	return (
		<label id={id} hidden={hidden} className={`flex flex-col gap-1.5 text-[11.5px] text-faint ${wide ? "col-span-full" : ""}`}>
			{label}
			{children}
		</label>
	);
}

/**
 * [x] Label, with a note under it. The input is real (keyboard, screen readers), drawn as text.
 * A forced box is shown ticked and disabled, its stored value kept (Worker thread with several CPUs);
 * a blocked one unticked and disabled, its stored value kept (Guest GL with another distro).
 */
function Check({ id, name, on, off, value, label, note, forced, blocked }: { id: string; name: string; on: string; off: string; value: string; label: string; note?: string; forced?: boolean; blocked?: boolean }) {
	const checked = !blocked && (forced || value === on);
	const locked = forced || blocked;
	return (
		<label className={`group flex items-start gap-2 py-0.5 text-muted select-none ${locked ? "cursor-not-allowed" : "cursor-pointer hover:text-fg"}`}>
			<input id={id} name={name} type="checkbox" data-on={on} data-off={off} checked={checked} disabled={locked} onChange={onField} className="peer sr-only" />
			<span aria-hidden="true" className="whitespace-pre peer-focus-visible:outline-2 peer-focus-visible:outline-accent">
				<span className="text-faint">[</span><span className={checked ? "text-ok" : ""}>{checked ? "x" : " "}</span><span className="text-faint">]</span>
			</span>
			<span>
				<span className={checked ? "text-fg" : ""}>{label}</span>
				{note && <small className="block text-[11.5px] text-faint">{note}</small>}
			</span>
		</label>
	);
}

/** (•) one of several. */
function Radio({ id, name, value, current, label }: { id: string; name: string; value: string; current: string; label: string }) {
	const checked = value === current;
	return (
		<label className="flex cursor-pointer items-center gap-1.5 text-muted select-none hover:text-fg">
			<input id={id} name={name} type="radio" value={value} checked={checked} onChange={onField} className="peer sr-only" />
			<span aria-hidden="true" className="whitespace-pre peer-focus-visible:outline-2 peer-focus-visible:outline-accent">
				<span className="text-faint">(</span><span className={checked ? "text-ok" : ""}>{checked ? "•" : " "}</span><span className="text-faint">)</span>
			</span>
			<span className={checked ? "text-fg" : ""}>{label}</span>
		</label>
	);
}

/**
 * `warn`: a choice to try, not to keep (red when selected, with `warnNote` under the slider).
 * `off`: shown, but not a choice (greyed; the thumb moves to the nearest other stop).
 */
type Stop = { value: string; tick: string; label: string; note?: string; warn?: boolean; off?: boolean };

/**
 * A slider over a few stops (value: the stop's index; data-values maps it
 * back), with the current value beside the label and each stop's tick label
 * under it, plus an optional note under that (Memory: "auto" under the size
 * auto picks). A tick is clickable and lines up with the thumb's centre there.
 * A disabled slider (CPUs where only one is possible) says why in its note.
 */
function Slider({ id, name, label, value, stops, disabled, note, noteId, warnNote }: {
	id: string; name: string; label: string; value: string; stops: Stop[]; disabled?: boolean; note?: string; noteId?: string; warnNote?: string;
}) {
	const i = Math.max(0, stops.findIndex((s) => s.value === value)), last = stops.length - 1;
	const at = (k: number) => `calc(${last ? k / last : 0} * (100% - var(--thumb)) + var(--thumb) / 2)`;
	const cur = stops[i]!.label;
	const warn = !disabled && !!stops[i]!.warn;
	if (warn && warnNote) note = warnNote;
	return (
		<div className="flex flex-col gap-1.5 text-[11.5px] text-faint [--thumb:12px]">
			<div className="flex items-baseline justify-between gap-2">
				<label htmlFor={id}>{label}</label>
				<output htmlFor={id} className={`font-mono text-[12px] tabular-nums ${warn ? "text-err" : "text-fg"}`}>{cur}</output>
			</div>
			<input id={id} name={name} type="range" min={0} max={last} step={1} value={i} data-values={stops.map((s) => s.value).join(",")}
				data-off={stops.flatMap((s, k) => (s.off ? [k] : [])).join(",")}
				disabled={disabled} aria-valuetext={cur} aria-describedby={note ? noteId : undefined} onChange={onField}
				className="slider w-full disabled:cursor-not-allowed disabled:opacity-50" style={{ "--fill": at(i), ...(warn ? { "--tone": "var(--color-err)" } : {}) } as never} />
			<div className={`relative font-mono text-[11px] leading-[14px] select-none ${stops.some((s) => s.note) ? "h-7" : "h-3.5"} ${disabled ? "opacity-50" : ""}`} aria-hidden="true">
				{stops.map((s, k) => (
					<span key={s.value} onClick={disabled || s.off ? undefined : () => pick(name, s.value)} style={{ left: at(k) }}
						className={`absolute top-0 flex -translate-x-1/2 flex-col items-center tabular-nums ${disabled ? "" : s.off ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:text-fg"} ${k === i ? (warn ? "text-err" : "text-fg") : ""}`}>
						{s.tick}{s.note && <span className="text-[10px] text-ok">{s.note}</span>}
					</span>
				))}
			</div>
			{note && <small id={noteId} className={`text-[11.5px] ${warn ? "text-err" : "text-faint"}`}>{note}</small>}
		</div>
	);
}

const SIZES = [64, 128, 256, 512, 1024, 2048, 4096];
const CPU_COUNTS = [1, 2, 4, 8, 16];
const FONTS = [11, 12, 13, 14, 15, 16, 18];

/**
 * A group of options (Settings has one per section): a form whose fields the
 * store follows, by their onChange and by native listeners on the form
 * (capture phase), which see the changes React drops (the top of this file).
 */
export function OptionsForm({ children }: { children: ReactNode }) {
	const form = useRef<HTMLFormElement>(null);
	useEffect(() => {
		const f = form.current!;
		f.addEventListener("change", onField, true);
		f.addEventListener("input", onField, true);
		return () => {
			f.removeEventListener("change", onField, true);
			f.removeEventListener("input", onField, true);
		};
	}, []);
	return <form ref={form} className="flex flex-col gap-5" onSubmit={(e) => e.preventDefault()}>{children}</form>;
}

/** Enter in a text field reboots, like the button. */
const enter = (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); KW.ui!.reboot(); } };

/** A column of check boxes. */
const Checks = ({ children }: { children: ReactNode }) => <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-6 gap-y-1.5">{children}</div>;

/** Machine: CPUs, memory, the worker thread, the JIT, the kernel command line and verbose boot. */
export function MachineOptions() {
	const cfg = KW.config;
	const o = useStore((s) => s.options);

	// Memory stops: the sizes, the one auto picks on this device (marked, and
	// choosing it means auto) and a ?mem= that is none of them.
	const mib = (n: number) => (n < 1024 ? `${n} MiB` : `${+(n / 1024).toFixed(1)} GiB`);
	const sizes = [...new Set([...SIZES, cfg.memAutoMiB, ...(cfg.memParam ? [Number(cfg.memParam)] : [])])].sort((a, b) => a - b);
	const mem: Stop[] = sizes.map((n) => ({
		value: n === cfg.memAutoMiB ? "auto" : String(n),
		tick: n < 1024 ? String(n) : `${+(n / 1024).toFixed(1)}G`,
		label: n === cfg.memAutoMiB ? `Auto (${mib(n)})` : mib(n),
		note: n === cfg.memAutoMiB ? "auto" : undefined,
	}));
	const memValue = o.mem === String(cfg.memAutoMiB) ? "auto" : o.mem;

	// CPUs: 1, 2, 4, 8, 16 up to the host's threads, the host's threads themselves (the most
	// there is to try), the suggested count and a ?cpus= that is none of them. Past the
	// suggestion (one in WebKit) a count is there to try: red when selected.
	const cpuOk = cfg.cpuSuggested || 1;
	const cpus: Stop[] = [...new Set([...CPU_COUNTS.filter((n) => n <= cfg.cpuMax), cfg.cpuMax, ...(cfg.cpuSuggested ? [cfg.cpuSuggested] : []), cfg.smpParam])].sort((a, b) => a - b)
		.map((n) => {
			const sug = n === cfg.cpuSuggested && n > 1;
			return { value: String(n), tick: String(n), label: `${n} CPU${n > 1 ? "s" : ""}${sug ? " (suggested)" : ""}`, note: sug ? "suggested" : undefined, warn: n > cpuOk };
		});
	const cpuWarn = `To try: more than ${cpuOk} CPU${cpuOk > 1 ? "s" : ""} leaves this device's threads busy (a busy host stalls the guest) and gains little; boot is slower and each CPU takes 9 MiB of guest memory, and as much in a suspended session.`;
	// More than one CPU runs each in a Web Worker (config.ts: worker), so Worker thread is ticked and locked.
	const smp = o.cpus !== "1" && !cfg.smpBlocked;
	const cpuNote = cfg.smpBlocked ? `One CPU on this page: ${cfg.smpBlocked}.`
		: cfg.smpWhy ? `This boot runs on one CPU: ${cfg.smpWhy}.`
		: cfg.resumeCpus ? `This boot runs on ${cfg.resumeCpus} CPUs, those of the suspended session it resumes.`
		: "More than one boots the SMP kernel, each CPU in a Web Worker (as with Worker thread); a suspended session resumes on as many.";

	return (
		<OptionsForm>
			<div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] items-start gap-x-12 gap-y-5">
				<Slider id="opt-cpus" name="cpus" label="CPUs" value={o.cpus} stops={cpus} disabled={!!cfg.smpBlocked} note={cpuNote} noteId="opt-cpus-note" warnNote={cpuWarn} />
				<Slider id="opt-mem" name="mem" label="Memory" value={memValue} stops={mem} />
			</div>
			<Checks>
				<Check id="opt-worker" name="worker" on="on" off="off" value={o.worker} label="Worker thread" forced={smp}
					note={smp ? "always on with several CPUs" : "the kernel off the page's main thread"} />
				<Check id="opt-jit" name="jit" on="on" off="off" value={o.jit} label="JIT compiler" note="hot guest code to WebAssembly" />
				<Check id="opt-verbose" name="verbose" on="keep" off="clear" value={o.verbose} label="Verbose boot" note="show all kernel messages" />
			</Checks>
			<Field label="Kernel command line" wide>
				<input id="opt-append" name="append" type="text" autoCapitalize="off" autoComplete="off" spellCheck={false} placeholder={DEFAULT_CMDLINE}
					value={o.append} onChange={onField} onKeyDown={enter} className="field h-8 px-2.5 text-[12.5px]" />
			</Field>
		</OptionsForm>
	);
}

/** Distro: the image (?distro=) and safe mode (the plain image as the root). */
export function DistroOptions() {
	const cfg = KW.config;
	const o = useStore((s) => s.options);
	// Distro: the images (debian first) and none, the base shell.
	const mib1 = (n: number) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MiB`;
	const distros = [...DISTROS_OFFERED.map((d) => ({ value: d.name, label: capitalize(d.name), title: `${d.url}, ${mib1(d.size)}, streamed` })),
		{ value: "none", label: "None (base shell)", title: "no distro image: the base initramfs's busybox shell" }];
	const distroNote = cfg.distroWhy ? `${cfg.distroWhy}.`
		: `A read-only image under the root overlay; its changes are kept per distro on the data disk. Default ${DEFAULT_DISTRO}.`;
	return (
		<OptionsForm>
			<fieldset className="flex flex-col gap-1.5">
				<legend className="mb-1.5 text-[11.5px] text-faint">Distro</legend>
				<div className="flex flex-wrap gap-x-5 gap-y-1" role="radiogroup" id="opt-distro">
					{distros.map((d) => (
						<span key={d.value} title={d.title || undefined}>
							<Radio id={`opt-distro-${d.value}`} name="distro" value={d.value} current={o.distro} label={d.label} />
						</span>
					))}
				</div>
				<small id="opt-distro-note" className="text-[11.5px] text-faint">{distroNote}</small>
			</fieldset>
			<Checks>
				<Check id="opt-root" name="root" on="safe" off="overlay" value={o.root} label="Safe mode" note="boot without your changes: the plain image as the root" />
			</Checks>
		</OptionsForm>
	);
}

/** Storage: the data disk (/data, saved in this browser). */
/**
 * Storage: the data disk, and its size (?datasize=, GiB). A size above the
 * saved disk's grows it at the next boot (openDataDisk()'s size, the guest's
 * kwbox growfs). Every size is shown; those below the saved disk's (a disk
 * never shrinks) and above the browser's quota for the page
 * (navigator.storage; boot.ts clamps ?datasize= to it, as a disk larger than
 * the quota would fail its writes with EIO once the quota is used up) are off.
 */
export function StorageOptions() {
	const o = useStore((s) => s.options);
	const disk = useStore((s) => s.disk);
	const have = disk?.saved ? Math.floor(disk.size / 1073741824) : 0;
	const [quota, setQuota] = useState<number>();
	useEffect(() => { navigator.storage?.estimate?.().then((e) => setQuota(e.quota), () => {}); }, []);
	const cap = dataSizeCap(quota, have);
	const sizes = [...new Set([...DATA_SIZES, have, Number(o.datasize)])].filter((n) => n >= DATA_SIZES[0]!).sort((a, b) => a - b);
	const open = (n: number) => n >= have && n <= cap;
	const want = Math.max(Number(o.datasize), have);
	const value = String(sizes.filter((n) => open(n) && n <= want).at(-1) ?? have);
	const capped = sizes.some((n) => n > cap);
	const stops = sizes.map((n) => ({ value: String(n), tick: String(n), label: `${n} GiB`, off: !open(n) }));
	return (
		<OptionsForm>
			<Checks>
				<Check id="opt-data" name="data" on="on" off="off" value={o.data} label="Data disk" note="/data, saved in this browser" />
			</Checks>
			<div className="mt-4 max-w-sm">
				<Slider id="opt-datasize" name="datasize" label="Disk size" value={value} stops={stops} disabled={o.data === "off"}
					note={`Grows when you reboot, never shrinks; space is used as /data fills${capped && quota !== undefined ? `; up to ${fmtSize(quota)} in this browser` : ""}`}
					noteId="opt-datasize-note" />
			</div>
		</OptionsForm>
	);
}

/** Network: Wisp (the default servers or custom ones) or none. */
export function NetworkOptions() {
	const o = useStore((s) => s.options);
	return (
		<OptionsForm>
			<fieldset className="flex flex-col gap-1.5">
				<legend className="mb-1.5 text-[11.5px] text-faint">Network</legend>
				<div className="flex flex-wrap gap-x-5 gap-y-1" role="radiogroup" id="opt-net">
					<Radio id="opt-net-default" name="net" value="default" current={o.net} label="Wisp" />
					<Radio id="opt-net-custom" name="net" value="custom" current={o.net} label="Wisp, custom servers" />
					<Radio id="opt-net-off" name="net" value="off" current={o.net} label="Off" />
				</div>
			</fieldset>
			<Field label="Wisp servers (comma-separated)" wide id="opt-wisp-row" hidden={o.net !== "custom"}>
				<input id="opt-wisp" name="wisp" type="text" inputMode="url" placeholder="wss://wisp.example.com/" autoCapitalize="off" autoComplete="off" spellCheck={false}
					value={o.wisp} onChange={onField} onKeyDown={enter} className="field h-8 px-2.5 text-[12.5px]" />
			</Field>
		</OptionsForm>
	);
}

/** Display and sound: the framebuffer and input devices, guest GL, sound. */
export function DisplayOptions() {
	const cfg = KW.config;
	const o = useStore((s) => s.options);
	// Guest GL: Debian only, and only where the page has the renderer and WebGL2.
	const glOff = cfg.glBlocked ?? (GL_DISTROS.includes(o.distro) ? null : `${GL_DISTROS.join(", ")} only (its Mesa has the virgl driver)`);
	const glNote = glOff ? `Off: ${glOff}` : cfg.glWhy ? `This boot runs without it: ${cfg.glWhy}`
		: "guest Mesa on this browser's WebGL2 (virgl), through /dev/dri (virtio-gpu); loaded on first use";
	// Guest Vulkan: Debian only, and only where the page has the translator and WebGPU.
	const vkOff = cfg.vkBlocked ?? (VK_DISTROS.includes(o.distro) ? null : `${VK_DISTROS.join(", ")} only`);
	const vkNote = vkOff ? `Off: ${vkOff}` : cfg.vkWhy ? `This boot runs without it: ${cfg.vkWhy}`
		: "Vulkan 1.0 in the guest on this browser's WebGPU (kwvk); loaded on first use";
	return (
		<OptionsForm>
			<Checks>
				<Check id="opt-display" name="display" on="on" off="off" value={o.display} label="Display" note="/dev/fb0 and input devices" />
				<Check id="opt-gl" name="gl" on="on" off="off" value={o.gl} label="Guest GL" blocked={!!glOff} note={glNote} />
				<Check id="opt-vk" name="vk" on="on" off="off" value={o.vk} label="Guest Vulkan" blocked={!!vkOff} note={vkNote} />
				<Check id="opt-sound" name="sound" on="on" off="off" value={o.sound} label="Sound" note="ALSA and /dev/dsp" />
			</Checks>
		</OptionsForm>
	);
}

/** Session: suspending in the background, and asking before the tab closes. */
export function SessionOptions() {
	const cfg = KW.config;
	const o = useStore((s) => s.options);
	// Suspend in the background: the choices, a ?autosuspend= of other seconds, this device's default marked.
	const autoValues = [...new Set([...AUTO_SUSPEND_CHOICES, cfg.autosuspendParam])];
	const autoNote = `When the tab has been hidden that long, a system you have used since it booted is saved as with Suspend and paused; shown again, it goes on where it was (or, if the browser dropped the page meanwhile, resumes from the saved session). Default: ${autoSuspendLabel(cfg.autosuspendDefault).toLowerCase()} ${cfg.mobile ? "on phones and tablets, which may drop a background tab at any time" : "on desktops, where a background tab keeps running"}.`;
	return (
		<OptionsForm>
			<fieldset className="flex flex-col gap-1.5">
				<legend className="mb-1.5 text-[11.5px] text-faint">Suspend in the background</legend>
				<div className="flex flex-wrap gap-x-5 gap-y-1" role="radiogroup" id="opt-autosuspend">
					{autoValues.map((v) => (
						<Radio key={v} id={`opt-autosuspend-${v}`} name="autosuspend" value={v} current={o.autosuspend}
							label={`${autoSuspendLabel(v)}${v === cfg.autosuspendDefault ? " (default)" : ""}`} />
					))}
				</div>
				<small id="opt-autosuspend-note" className="text-[11.5px] text-faint">{autoNote}</small>
			</fieldset>
			<Checks>
				<Check id="opt-askleave" name="askleave" on="on" off="off" value={o.askleave} label="Ask before closing" note="while a system you used runs" />
			</Checks>
		</OptionsForm>
	);
}

/** The terminal font size (Settings, Display and sound): applied at once, no reboot. Stops like Memory's: auto's size marked, and a size from a pinch. */
export function FontSize() {
	const fontPref = useStore((s) => s.fontPref);
	const autoPx = autoFont();
	const px = [...new Set([...FONTS, autoPx, ...(fontPref !== "auto" ? [Number(fontPref)] : [])])].sort((a, b) => a - b);
	const fonts: Stop[] = px.map((n) => ({
		value: n === autoPx ? "auto" : String(n), tick: String(n),
		label: n === autoPx ? `Auto (${n} px)` : `${n} px`, note: n === autoPx ? "auto" : undefined,
	}));
	const fontValue = fontPref === String(autoPx) ? "auto" : fontPref;
	return (
		<div className="max-w-sm">
			<Slider id="opt-font" name="font" label="Font size" value={fontValue} stops={fonts} />
		</div>
	);
}

export function Theme() {
	const theme = useStore((s) => s.theme);
	return (
		<fieldset className="flex max-w-sm flex-col gap-1.5">
			<legend className="mb-1.5 text-[11.5px] text-faint">Theme</legend>
			<div className="flex flex-wrap gap-x-5 gap-y-1" role="radiogroup" id="opt-theme">
				<Radio id="opt-theme-auto" name="theme" value="auto" current={theme} label="Auto" />
				<Radio id="opt-theme-dark" name="theme" value="dark" current={theme} label="Dark" />
				<Radio id="opt-theme-light" name="theme" value="light" current={theme} label="Light" />
			</div>
		</fieldset>
	);
}

export function TermTheme() {
	const termTheme = useStore((s) => s.termTheme);
	return (
		<fieldset className="mt-5 flex max-w-sm flex-col gap-1.5">
			<legend className="mb-1.5 text-[11.5px] text-faint">Colours</legend>
			<div className="flex flex-wrap gap-x-5 gap-y-1" role="radiogroup" id="opt-termtheme">
				<Radio id="opt-termtheme-auto" name="termtheme" value="auto" current={termTheme} label="Auto" />
				<Radio id="opt-termtheme-dark" name="termtheme" value="dark" current={termTheme} label="Dark" />
				<Radio id="opt-termtheme-light" name="termtheme" value="light" current={termTheme} label="Light" />
			</div>
		</fieldset>
	);
}

export function TermGlass() {
	const termGlass = useStore((s) => s.termGlass);
	return (
		<div className="mt-5 max-w-sm">
			<Check id="opt-termglass" name="termglass" on="on" off="off" value={termGlass} label="See-through window" note="the desktop shows through, blurred" />
		</div>
	);
}
