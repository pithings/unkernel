// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The top bar (#topbar), macOS's menu bar: a thin strip across the top of
// the page (style.css: --tb-h, over the top safe area), with no background
// over the wallpaper, nearly opaque while a maximized window is shown (wm.ts
// dockHides(): data-dark) and in compact mode. The workspace (#workspace, Workspace.tsx) starts below
// it (--tb-space). Left to right:
// - the current app, one control (what macOS's Apple menu has is in the
//   Control Center): its icon (AppIcon: its Dock tile's icon, wm.ts meta,
//   on its colours when it has them), then the focused window's app, its
//   descriptor's title (wm.ts meta: Terminal, or the terminal app a
//   Terminal window or a Wayland window stands for; Browser, Display,
//   Settings, System, another Wayland app's title) in semibold, then the
//   window's title in a quieter tone when it says more (appwindows.ts
//   windowDetail(); truncated); unkernel's mark and "Desktop" when no
//   window has the focus. It is a menu (#tb-app, #tb-app-menu): the
//   window's own items, as in its Dock tile's menu (winmenu.tsx
//   windowItems(): a Terminal window's New Tab, New Window and Close Tab,
//   then Minimize, Maximize or Restore Size, Tile Left, Tile Right, Close
//   Window). Until the boot is over this slot is the boot indicator
//   (BootIndicator.tsx: #tb-boot, the progress ring and the step);
// - on the right, macOS-style status items, then the Control Center: Errors
//   with their count (#tb-errors, key e) only while there are any; the live
//   resources, each its icon and a slim vertical bar filled to its share
//   (Bars), monochrome, amber from 85 % and red from 95 % (tone()), the
//   figures in the tooltips: CPU busy (#tb-cpu: a chip) and guest memory in
//   use (#tb-mem: a memory module); from sm up also the data disk (#tb-disk:
//   a cylinder), the network (#tb-net: a globe and two bars, received and
//   sent, on a log scale from NET_LO to NET_HI B/s; the globe struck through
//   when it is off) and, while guest GL's or guest Vulkan's renderer is
//   loaded, the GPU (#tb-gpu: a graphics card, the bar the share of the
//   page's time the two renderers took together; its tooltip has each
//   one's frame rate and share, and Vulkan's instances, errors and device
//   losses; it marks both GPU rows in Resources). Last, at the far right,
//   the Control Center (#tb-status: two
//   switches in the state's colour, red on an error, dim once halted, green
//   while suspended, style.css; #tb-status-label is the state's name), which
//   opens its popover (ControlCenter.tsx, #tb-cc: the state and uptime, quick
//   settings, Settings…, System…, the log, the shortcuts, About, Suspend or
//   Resume and Reboot). Under the mouse it shows (it goes when the mouse
//   leaves the item and the popover), a click keeps it, a second click
//   closes it. The meters open their own popover, Resources
//   (ControlCenter.tsx, #tb-res: every resource's sparkline and facts,
//   System…), under the last meter: a click shows it with that row marked (a
//   second click closes it, a click on another meter marks that one). One of the two is open at a time. The
//   figures are stats.ts's light samples (useStats("lite"): every
//   LITE_INTERVAL ms while the machine runs and the page shows, faster while
//   the Overview or Resources is open); before the first one, and while
//   the guest cannot be read or the machine does not run, the bars are empty
//   tracks. The tooltips have the exact figures and keys; while the prefix
//   is armed each control shows its key (which-key style; looked up by
//   command id, keys.ts keyFor()).
// It always shows (a maximized window fills the workspace under it), but
// while the on-screen keyboard is up (style.css: kb). App.tsx renders it after the
// desktop (over the Resume card) and before the Display's page cover, which
// covers it on phones; the launcher, the dialogs and the toast
// are over the whole #app.
// A press on the bar never moves the keyboard focus (the terminal keeps it).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { windowDetail } from "../appwindows.ts";
import { fmtFps, fmtPct, fmtRateShort, fmtSizeShort } from "../format.ts";
import { KW } from "../kw.ts";
import { useStats } from "../stats.ts";
import { toggleSection, useFocusedSection } from "../sysapps.ts";
import { keyFor, type CommandId } from "../keys.ts";
import { useStore } from "../store.ts";
import { windowItems } from "../winmenu.tsx";
import { dockHides, useWm, type WmWindow } from "../wm.ts";
import { BootSlot } from "./BootIndicator.tsx";
import { ControlCenter, ResourcesPopover, type CcClose } from "./ControlCenter.tsx";
import { GPU_STATE, VK_STATE, vkTrouble, type ResKey } from "./Glance.tsx";
import { ControlIcon, CpuIcon, DiskIcon, ErrIcon, GpuIcon, Mark, MetaIcon, NetIcon, RamIcon } from "./icons.tsx";
import { KeyHint, withKey } from "./KeyHint.tsx";
import { Menu, type MenuClose, type MenuEntry } from "./Menu.tsx";

/** A status icon: muted until hovered or pressed; a press keeps the focus where it is. `cmd`: its command (its key shows while the prefix is armed). */
function BarButton({ id, title, label, cmd, on, tone, onClick, className = "", children }: {
	id?: string; title: string; label?: string; cmd?: CommandId; on?: boolean; tone?: string; onClick: () => void; className?: string; children: ReactNode;
}) {
	const hint = cmd && keyFor(cmd);
	return (
		<button id={id} type="button" title={withKey(title, hint)} aria-label={label ?? title} aria-pressed={on} data-tone={tone}
			className={`tb-btn ${className}`} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
			{children}{hint && <KeyHint k={hint} small />}
		</button>
	);
}

/**
 * A resource's meter: a click shows Resources with its row marked (or closes it); a press keeps the
 * focus where it is. (The desktop's widget, Widget.tsx, has the resources too.)
 */
function ResButton({ res, open, title, label, tone, onToggle, className = "", children }: {
	res: ResKey; open: boolean; title: string; label: string; tone?: string; onToggle: (res: ResKey, kb: boolean) => void; className?: string; children: ReactNode;
}) {
	return (
		<button id={`tb-${res}`} type="button" title={open ? undefined : title} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? "tb-res" : undefined}
			data-meter={res} data-pop="" data-tone={tone} className={`tb-btn tb-meter ${className}`}
			onMouseDown={(e) => e.preventDefault()}
			onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); onToggle(res, true); } }}
			onClick={(e) => onToggle(res, e.detail === 0)}>
			{children}
		</button>
	);
}

/**
 * A button with its menu (Menu.tsx, under the button). Esc, Tab or a pick
 * gives the focus back: to the button when the menu was opened from the
 * keyboard, else to where it was (the terminal). A press on the button while
 * its menu is open only closes it. `items` is read on each render while open.
 */
function BarMenu({ id, menuId, title, label, header, items, className = "", children }: {
	id: string; menuId: string; title?: string; label: string; header?: string; items: () => MenuEntry[];
	className?: string; children: ReactNode;
}) {
	const [open, setOpen] = useState<{ kb: boolean; at: DOMRect } | null>(null);
	const btn = useRef<HTMLButtonElement>(null);
	const prev = useRef<HTMLElement | null>(null);
	const onMe = useRef(false), swallow = useRef(0);
	useEffect(() => {
		if (!open) return;
		// The window's capture phase runs before the menu's listener on document: was the press on this button?
		const down = (e: PointerEvent) => { onMe.current = !!btn.current?.contains(e.target as Node); };
		addEventListener("pointerdown", down, true);
		return () => removeEventListener("pointerdown", down, true);
	}, [open]);
	const close = (how: MenuClose) => {
		const kb = open?.kb;
		setOpen(null);
		if (how === "away") {
			// Its press closed the menu: the click that follows must not open it again.
			if (onMe.current) swallow.current = performance.now();
			onMe.current = false;
			return;
		}
		const back = kb ? btn.current : prev.current;
		if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
	};
	const show = (kb: boolean) => {
		prev.current = document.activeElement as HTMLElement | null;
		setOpen({ kb, at: btn.current!.getBoundingClientRect() });
	};
	return (
		<>
			<button ref={btn} id={id} type="button" title={title} aria-label={label} aria-haspopup="menu" aria-expanded={!!open}
				aria-controls={open ? menuId : undefined} className={`tb-btn ${className}`}
				onMouseDown={(e) => e.preventDefault()}
				onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); show(true); } }}
				onClick={(e) => {
					if (performance.now() - swallow.current < 1500) { swallow.current = 0; return; }
					if (open) close("key");
					else show(e.detail === 0);
				}}>
				{children}
			</button>
			{open && <Menu id={menuId} label={label} header={header} items={items()} anchor={open.at} onClose={close} />}
		</>
	);
}

/** A share's tone: amber from 85 %, red from 95 % (style.css .tb-btn[data-tone]). */
const tone = (v: number | null | undefined) => (v == null ? undefined : v >= 0.95 ? "err" : v >= 0.85 ? "warn" : undefined);
const pct = (v: number) => `${Math.round(v * 100)} %`;
const mib = (n: number) => Math.round(n / 1048576);
/** The meters' height and width, in px (style.css .tb-meter sizes the rest). */
const BAR_H = 12, BAR_W = 4;
/** Network rates map to a bar's fill on a log scale: NET_LO B/s and below empty, NET_HI B/s and above full. */
const NET_LO = 100, NET_HI = 10485760;
const netLevel = (n: number | null) => (n == null ? null : Math.min(1, Math.max(0, Math.log10(Math.max(1, n) / NET_LO) / Math.log10(NET_HI / NET_LO))));

/**
 * A resource's meter: slim vertical bars (one, or the network's two, down
 * then up) on faint tracks, filled from the bottom in the button's colour;
 * a null value leaves its track empty.
 */
function Bars({ values }: { values: (number | null)[] }) {
	const w = values.length > 1 ? 2 : BAR_W, gap = 1;
	const width = values.length * w + (values.length - 1) * gap;
	return (
		<svg width={width} height={BAR_H} viewBox={`0 0 ${width} ${BAR_H}`} aria-hidden="true">
			{values.map((v, i) => {
				const x = i * (w + gap), h = v == null || v <= 0 ? 0 : Math.max(1.5, Math.min(1, v) * BAR_H);
				return (
					<g key={i}>
						<rect x={x} y="0" width={w} height={BAR_H} rx="1" className="tb-track" />
						{h > 0 && <rect x={x} y={BAR_H - h} width={w} height={h} rx="1" fill="currentColor" />}
					</g>
				);
			})}
		</svg>
	);
}

/** The current app's icon: a 16 px rounded square in the app's colours with its icon in white (as unkernel's mark), or the bare icon. */
function AppIcon({ meta }: { meta: WmWindow["meta"] }) {
	if (!meta.colors) return <MetaIcon meta={meta} size={15} />;
	return (
		<span aria-hidden="true" className="flex size-4 flex-none items-center justify-center rounded-[4px] text-white"
			style={{ backgroundImage: `linear-gradient(135deg, ${meta.colors[0]}, ${meta.colors[1]})` }}>
			<MetaIcon meta={meta} size={11} />
		</span>
	);
}

/** The focused window's app, and its title when that says more. */
const appOf = (w: WmWindow): { name: string; detail: string } => ({ name: w.meta.title, detail: windowDetail(w) });

export function TopBar() {
	const label = useStore((s) => s.label);
	const suspended = useStore((s) => s.suspended);
	const disk = useStore((s) => s.disk);
	const errors = useStore((s) => s.errors.length);
	const section = useFocusedSection();
	const win = useWm((s) => s.windows.find((w) => w.id === s.focused));
	const dark = useWm(dockHides);
	const kmem = KW.memActualMiB || KW.config.memMiB;
	const net = KW.config.net;
	// Live resources (stats.ts): only a fresh, successful read counts; else the icons are empty.
	const st = useStats("lite");
	const g = !st.waiting && !st.idle ? st.guest : null;
	const cpu = g?.derived.cpu ?? null;
	const load = g?.raw.load ?? null;
	const ncpu = g?.raw.stat?.cpus.length ?? 0;
	const mem = g?.raw.mem ? { used: g.raw.mem.total - g.raw.mem.available, total: g.raw.mem.total } : null;
	const memShare = mem && mem.total > 0 ? mem.used / mem.total : null;
	const rx = g?.derived.rx ?? null, tx = g?.derived.tx ?? null;
	const gpu = st.gpu?.state === "ready" || st.gpu?.state === "lost" ? st.gpu : null;
	const last = st.points[st.points.length - 1];
	const glBusy = gpu && !st.idle ? last?.glBusy ?? null : null;
	const fps = gpu?.device && !st.idle ? last?.fps ?? null : null;
	const vk = st.vk?.state === "ready" || st.vk?.state === "lost" ? st.vk : null;
	const vkBusy = vk && !st.idle ? last?.vkBusy ?? null : null;
	const vkFps = vk && !st.idle ? last?.vkFps ?? null : null;
	// The GPU meter: both renderers' share of the page's time (each is time on the page's thread).
	const gpuBusy = glBusy == null && vkBusy == null ? null : Math.min(1, (glBusy ?? 0) + (vkBusy ?? 0));
	const why = st.idle ? `not sampled (${st.idle})` : "waiting for the guest";
	const cpuText = cpu != null ? `CPU ${pct(cpu)}${load ? ` · load ${load.one.toFixed(2)}` : ""}${ncpu > 1 ? ` · ${ncpu} CPUs` : ""}` : g ? "CPU: measuring…" : `CPU: ${why}`;
	const memText = mem ? `Memory ${mib(mem.used)} of ${mib(mem.total)} MiB in use (${pct(memShare ?? 0)})` : `Memory: ${why} (kernel memory ${kmem} MiB)`;
	const netText = !net ? "Network: off" : rx != null && tx != null ? `Network ↓ ${fmtRateShort(rx)} · ↑ ${fmtRateShort(tx)}` : `Network: on; ${why}`;
	const vkBad = vk && vkTrouble(vk);
	const gpuText = [
		gpu && `GPU (guest GL): ${gpu.state === "ready" ? `${fps != null ? `${fmtFps(fps)} · ` : ""}renderer ${glBusy != null ? fmtPct(glBusy) : "–"} of the page's time` : GPU_STATE[gpu.state]}`,
		vk && `Vulkan: ${vk.state === "ready" ? `${vkFps != null && vkFps > 0 ? `${fmtFps(vkFps)} · ` : ""}${vk.connections} instance${vk.connections === 1 ? "" : "s"} · renderer ${vkBusy != null ? fmtPct(vkBusy) : "–"} of the page's time` : VK_STATE[vk.state]}` +
			`${vkBad?.errors ? ` · ${vkBad.errors} error${vkBad.errors === 1 ? "" : "s"}` : ""}${vkBad?.losses ? ` · device lost ${vkBad.losses}×` : ""}`,
	].filter(Boolean).join("\n");

	const bar = useRef<HTMLElement>(null);
	/** In the bar, or in a menu or a popover (Menu.tsx and ControlCenter.tsx render them in <body>). */
	const inBar = (n: EventTarget | null): boolean => !!n && (!!bar.current?.contains(n as Node) || !!(n as Element).closest?.('[role="menu"], #tb-cc, #tb-res'));

	// ---- the popovers (ControlCenter.tsx): the Control Center (#tb-cc) and Resources (#tb-res) ----
	// One at a time. view: which; res: the meter whose row is marked (Resources); from: the control it opened from
	// (Esc after a keyboard open goes back to it); pinned: opened by a click or a key, so it stays until closed. A
	// hover (the mouse) on the Control Center's item opens it unpinned: it goes when the mouse leaves the bar's popover
	// controls and the popover; a click then pins it. Over an open Resources it switches to the Control Center, pinned
	// as the one it replaces, as a menu bar does.
	const [pop, setPop] = useState<{ view: "cc" | "res"; res: ResKey | null; from: string; kb: boolean; pinned: boolean } | null>(null);
	const popOpen = !!pop;
	/** Where the focus was when it opened (not in the bar), for Esc after the user tabbed into a mouse-opened one. */
	const popPrev = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (!popOpen) return;
		const f = document.activeElement as HTMLElement | null;
		popPrev.current = f && !inBar(f) ? f : null;
	}, [popOpen]);
	const toggleCc = (kb: boolean) => setPop((c) => (c?.view === "cc" && c.pinned ? null : { view: "cc", res: null, from: "tb-status", kb, pinned: true }));
	const hoverCc = () => setPop((c) => (c?.view === "cc" ? c : { view: "cc", res: null, from: "tb-status", kb: false, pinned: !!c?.pinned }));
	const toggleRes = (res: ResKey, kb: boolean) => setPop((c) => (c?.view === "res" && c.res === res && c.pinned ? null : { view: "res", res, from: `tb-${res}`, kb, pinned: true }));
	const hovering = !!pop && !pop.pinned;
	useEffect(() => {
		if (!hovering) return;
		// Away from the bar's popover controls and the popover for a moment (the gap between them is crossed in less): it
		// goes. Over another control, that one's hover has switched to its own popover.
		let t: ReturnType<typeof setTimeout> | undefined;
		const move = (e: PointerEvent) => {
			const over = !!(e.target as Element | null)?.closest?.("[data-pop], #tb-cc, #tb-res");
			if (over) { clearTimeout(t); t = undefined; }
			else t ??= setTimeout(() => setPop((c) => (c && !c.pinned ? null : c)), 300);
		};
		document.addEventListener("pointermove", move, true);
		return () => { clearTimeout(t); document.removeEventListener("pointermove", move, true); };
	}, [hovering]);
	const closePop = (how: CcClose) => {
		const from = pop;
		setPop(null);
		if (how !== "key" || !from) return;
		// Esc: back to the control it opened from after a keyboard open, else (the user tabbed into it) to where the focus was.
		const inPop = !!document.activeElement?.closest?.("#tb-cc, #tb-res");
		const back = from.kb ? document.getElementById(from.from) : inPop ? popPrev.current : null;
		if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
	};
	// The meter it marks went (the GPU's renderer was dropped): no row marked.
	if (pop?.res === "gpu" && !gpu && !vk) setPop({ ...pop, res: null });
	/** The bar's controls that open a popover: a press on one does not close the open one (its click toggles or switches). */
	const onPopControl = (t: EventTarget | null) => !!(t as Element | null)?.closest?.("[data-pop]");
	/** Resources opens under the last meter shown (from sm up; under sm it is a sheet). */
	const resAnchor = gpu || vk ? "tb-gpu" : "tb-net";
	const ccOn = pop?.view === "cc";

	// ---- menus ----
	/** The focused window's menu: its own items (winmenu.tsx, as on its Dock tile). */
	const appItems = (w: WmWindow) => (): MenuEntry[] => windowItems(w.id) ?? [];

	const app = win && appOf(win);
	const diskShare = disk && disk.size > 0 ? disk.used / disk.size : null;
	const used = disk && `${fmtSizeShort(disk.used)} of ${fmtSizeShort(disk.size)}${disk.size > 0 ? ` (${Math.round((disk.used / disk.size) * 100)}%)` : ""}`;

	return (
		<header id="topbar" ref={bar} data-dark={dark || undefined} aria-label="Menu bar">
			<nav aria-label="Menus" className="tb-left">
				<BootSlot>
					{win && app ? (
						<BarMenu id="tb-app" menuId="tb-app-menu" title={app.detail ? `${app.name}: ${app.detail}` : app.name} label={app.name} header={app.name}
							items={appItems(win)} className="tb-app">
							<AppIcon meta={win.meta} />
							<span className="truncate font-semibold">{app.name}</span>
							{app.detail && <span className="tb-detail truncate">{app.detail}</span>}
						</BarMenu>
					) : <span className="tb-app tb-btn pointer-events-none font-semibold"><Mark size={16} /><span className="truncate">Desktop</span></span>}
				</BootSlot>
			</nav>
			<div role="group" aria-label="Status" className="tb-right">
				{(errors > 0 || section === "errors") && (
					<BarButton id="tb-errors" title="Errors" cmd="errors" label={`Errors: ${errors}`} on={section === "errors"} className="text-err!" onClick={() => toggleSection("errors")}>
						<ErrIcon size={14} />{errors > 0 && <span className="font-mono text-[12px]">{errors}</span>}
					</BarButton>
				)}
				<ResButton res="cpu" open={pop?.view === "res" && pop.res === "cpu"} title={cpuText} label={cpuText} tone={tone(cpu)} onToggle={toggleRes}>
					<CpuIcon size={14} /><Bars values={[cpu]} />
				</ResButton>
				<ResButton res="mem" open={pop?.view === "res" && pop.res === "mem"} title={memText} label={memText} tone={tone(memShare)} onToggle={toggleRes}>
					<RamIcon size={14} /><Bars values={[memShare]} />
				</ResButton>
				{disk && (
					<ResButton res="disk" open={pop?.view === "res" && pop.res === "disk"} className="tb-wide" tone={tone(diskShare)} label={`Data disk: ${used} in use`} onToggle={toggleRes}
						title={`Data disk (/data): ${used} in use, ${disk.saved ? "saved in this browser" : "in memory only"}; counts blocks ever written, df in the guest is exact`}>
						<DiskIcon size={14} /><Bars values={[diskShare]} />
					</ResButton>
				)}
				<ResButton res="net" open={pop?.view === "res" && pop.res === "net"} className={`tb-wide ${net ? "" : "tb-off"}`} title={netText} label={netText} onToggle={toggleRes}>
					<NetIcon off={!net} size={14} />{net && <Bars values={[netLevel(rx), netLevel(tx)]} />}
				</ResButton>
				{(gpu || vk) && (
					<ResButton res="gpu" open={pop?.view === "res" && pop.res === "gpu"} className="tb-wide" title={gpuText} label={gpuText} onToggle={toggleRes}>
						<GpuIcon size={14} /><Bars values={[gpuBusy]} />
					</ResButton>
				)}
				<button id="tb-status" type="button" title={ccOn ? undefined : `Control Center: ${label}`}
					aria-label={`Control Center: ${label}`} aria-haspopup="dialog" aria-expanded={ccOn} aria-controls={ccOn ? "tb-cc" : undefined}
					data-pop="" className={`tb-btn ${suspended ? "text-ok!" : ""}`}
					onMouseDown={(e) => e.preventDefault()}
					onPointerEnter={(e) => { if (e.pointerType === "mouse") hoverCc(); }}
					onKeyDown={(e) => { if (e.key === "ArrowDown" && !(ccOn && pop?.pinned)) { e.preventDefault(); toggleCc(true); } }}
					onClick={(e) => toggleCc(e.detail === 0)}>
					<ControlIcon size={15} /><span id="tb-status-label" className="sr-only">{label}</span>
				</button>
			</div>
			{pop?.view === "cc" && <ControlCenter anchorId="tb-status" kb={pop.kb} inside={onPopControl} onClose={closePop} />}
			{pop?.view === "res" && <ResourcesPopover anchorId={resAnchor} current={pop.res} kb={pop.kb} inside={onPopControl} onClose={closePop} />}
		</header>
	);
}
