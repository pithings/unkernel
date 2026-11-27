// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// System's Overview (components/SystemInfo.tsx): the machine at a glance, a
// resource monitor. Rendered only while System's window shows this section,
// which is also when stats.ts takes its full samples every INTERVAL
// (useStats()); otherwise the top bar's light, slower ones go on
// (TopBar.tsx), so its charts may start with what they gathered.
// - The state (#sys-state, its dot, Settings…), the uptime (the guest's
//   /proc/uptime, else the SDK's time since kernel entry), the distro and
//   its image id, the kernel release, the CPUs and the time to boot.
// - Panels, in a grid by the section's own width (container queries: one
//   column at phone width, two, then three), each a figure, a chart of the
//   last three minutes or a meter, and a few short facts; each resource in
//   its colour (Charts.tsx TONE, as in the top bar's Resources):
//   CPU (busy history, each CPU's bar, load, tasks, context switches);
//   Memory (in use, cache and free as one bar, in-use history, swap);
//   Disk (/data and the root's own changes as bars, host block I/O history
//   and rates, the root image); Network (received and sent history, the
//   interface, totals); GPU, only with guest GL (frames per second the GPU
//   path showed, or the renderer's command buffers per second without
//   virtio-gpu; the renderer's share of the page's time, fences, errors,
//   the scanout, the WebGL2 implementation: the GPU's own load is not
//   measured, WebGL does not tell); Vulkan, only with guest Vulkan (vm.vk:
//   frames per second presented with those read back, or compute
//   dispatches per second while nothing presents; bytes to the GPU and read
//   back per second; draws, dispatches and submits per second, the
//   renderer's share of the page's time, the instances, live objects,
//   pipelines, shader translations, errors and device losses in red, the
//   load time, the WebGPU adapter; before its load, its state); Emulator
//   (JIT compiles or task switches); Processes (the busiest TOP, sortable
//   by CPU or memory).
//   What needs the guest says it waits for it until its first read (and the
//   rest shows). Sources: the guest's /proc through stats.ts, the SDK's
//   vm.stats() (block I/O, the JIT, task switches), vm.gl and vm.vk, the store (the
//   data disk) and the page's config.
// - Boot, under the panels: the stages (ui.stages()) as a timeline from the
//   page's load, stages that overlap on lanes of their own, and their list
//   (#stages, a row per stage with data-s, its state). A segment under the
//   pointer, focused or tapped shows its name, start, duration and detail,
//   and it and its row are highlighted (a row under the pointer does the
//   same for its segment).
// - Machine: the facts the Overview listed before (kernel build, distro URL,
//   CPUs, memory, data disk, command line), last and small.
import { useRef, useState, type ReactNode } from "react";
import { useOutsidePress, useTick } from "../hooks.ts";
import { openSection } from "../sysapps.ts";
import { KW } from "../kw.ts";
import { DEFAULT_WISP_SERVERS } from "../net.ts";
import type { KernelHandle } from "../sdk.ts";
import { INTERVAL, RING, useStats, type DfRow, type NetDev, type Point, type StatsState, type TopProc } from "../stats.ts";
import { isRunning, isStarting, phase, useStore } from "../store.ts";
import { capitalize, fmtBytes, fmtCount, fmtPct, fmtRate, fmtT, fmtUptime, plural } from "../format.ts";
import { H3 } from "./AppShell.tsx";
import { Bars, Key, Meter, SECOND, Spark, TONE, fullness } from "./Charts.tsx";
import { diskUse, GPU_STATE, gpuSeries, latest, VK_STATE, vkPath, vkSeries, vkTrouble } from "./Glance.tsx";
import { ActivityIcon, CpuIcon, DiskIcon, GpuIcon, LogIcon, NetIcon, PromptIcon, RamIcon } from "./icons.tsx";

const B = __KW_BUILD__;

// ---- formatting ------------------------------------------------------------------
// (sizes, rates, shares, counts, durations and plurals: format.ts)
const MiB = 1048576;
const pct = fmtPct;
/** Rows of the process table. */
const TOP = 8;
/** The charts' heights, px. */
const CHART_H = 48, CHART_H_SM = 36;

const vmOf = () => KW.vm as KernelHandle | undefined;
/** A colour, faded: a part of a meter next to its full tone. */
const faded = (c: string, f = 35) => `color-mix(in srgb, ${c} ${f}%, transparent)`;

// ---- pieces --------------------------------------------------------------------------
function Card({ title, icon, tone, aside, children, className = "" }: { title: string; icon: ReactNode; tone?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
	return (
		<section aria-label={title} className={`flex min-w-0 flex-col gap-2.5 rounded-lg border border-line bg-surface p-3 ${className}`}>
			<header className="flex items-center gap-2 font-sans text-[12px] text-faint">
				<span aria-hidden="true" className="flex" style={tone ? { color: tone } : undefined}>{icon}</span>
				<h3 className="font-medium text-muted">{title}</h3>
				{aside && <span className="ml-auto min-w-0 truncate font-mono text-[11px]">{aside}</span>}
			</header>
			{children}
		</section>
	);
}

/** The panel's figure, with its unit and what it is of. */
const Figure = ({ value, unit, of }: { value: ReactNode; unit?: ReactNode; of?: ReactNode }) => (
	<p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 font-sans leading-none">
		<span className="text-[22px] font-semibold tracking-tight text-fg tabular-nums">{value}</span>
		{unit && <span className="text-[13px] font-medium text-muted">{unit}</span>}
		{of && <span className="text-[12px] text-faint">{of}</span>}
	</p>
);

/** Short facts: a label over each value. */
const Facts = ({ items }: { items: Array<[string, ReactNode] | false | null | undefined> }) => (
	<dl className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-x-3 gap-y-1.5">
		{items.filter((x): x is [string, ReactNode] => !!x).map(([k, v]) => (
			<div key={k} className="min-w-0">
				<dt className="font-sans text-[11px] text-faint">{k}</dt>
				<dd className="truncate text-[12px] text-muted tabular-nums">{v}</dd>
			</div>
		))}
	</dl>
);

/** A labelled meter: name and figures on one line, the bar under it. */
function Usage({ name, used, size, color, note }: { name: ReactNode; used: number; size: number; color: string; note?: string }) {
	const f = size > 0 ? used / size : 0;
	return (
		<div className="flex flex-col gap-1">
			<div className="flex min-w-0 items-baseline gap-2 text-[11.5px]">
				<span className="min-w-0 truncate text-muted">{name}</span>
				<span className="ml-auto flex-none text-faint tabular-nums">{fmtBytes(used)} of {fmtBytes(size)}{note ? ` ${note}` : ""} · <span className="text-muted">{pct(f)}</span></span>
			</div>
			<Meter total={size} label={typeof name === "string" ? name : "use"} parts={[{ value: used, color: fullness(f, color), label: "used", text: pct(f) }]} />
		</div>
	);
}

/** In place of a chart that needs the guest: the same height, a quiet line. */
const Waiting = ({ why, height = CHART_H }: { why: string; height?: number }) => (
	<div className="grid place-items-center rounded-md border border-dashed border-line font-sans text-[12px] text-faint" style={{ height }}>{why}</div>
);

/** Why a guest figure is not there yet. */
function waitText(st: StatsState): string {
	if (st.idle && st.idle !== "the page is hidden") return `Not sampled: ${st.idle}`;
	return "Waiting for the guest…";
}

// ---- the state line --------------------------------------------------------------------
const STATE_TONE: Record<string, string> = { running: "bg-ok", error: "bg-err", halted: "bg-off" };

function Uptime({ st }: { st: StatsState }) {
	const running = useStore(isRunning);
	// The clock moves while it runs (also while Suspend saves it), not while it is held.
	const live = useStore((s) => isRunning(s) && phase(s) !== "held");
	useTick(1000, live);
	const since = (t: number) => (live ? (Date.now() - t) / 1000 : 0);
	let up: number | null = null;
	if (st.guest?.raw.uptime != null) up = st.guest.raw.uptime + since(st.guest.t);
	else if (running) {
		try { up = (vmOf()?.stats().uptimeMs ?? 0) / 1000 || null; } catch { /* stopped */ }
	}
	if (up == null) return null;
	return <span className="text-faint">up <span className="text-muted tabular-nums">{fmtUptime(up)}</span></span>;
}

function StateLine({ st }: { st: StatsState }) {
	const state = useStore((s) => s.state);
	const label = useStore((s) => s.label);
	const suspended = useStore((s) => s.suspended);
	const paused = useStore((s) => s.paused);
	const distro = useStore((s) => s.distro);
	const p = useStore(phase);
	const busy = p === "starting";
	const tone = p === "held" || p === "suspending" ? "bg-warn" : STATE_TONE[state] ?? "bg-warn";
	const user = KW.ui!.stages().find((s) => s.id === "userspace");
	const release = st.guest?.raw.release || B.linux;
	const name = distro ? capitalize(distro.name) : "Base shell";
	const cpus = st.guest?.raw.stat?.cpus.length || KW.config.cpus;
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2 font-sans">
				<span aria-hidden="true" className={`size-2.5 rounded-full ${tone} ${busy ? "motion-safe:animate-pulse" : ""}`} />
				<span id="sys-state" className="text-[17px] font-semibold tracking-tight text-fg">{label}{suspended ? " (suspended)" : paused ? " (paused)" : ""}</span>
				<span className="font-mono text-[12px]"><Uptime st={st} /></span>
				<button type="button" className="btn btn-sm ml-auto" onClick={() => openSection("boot")}>Settings…</button>
			</div>
			<p className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-faint">
				<span><span className="font-sans text-muted">{name}</span>{distro?.image && <> {distro.image}</>}</span>
				<span>Linux <span className="text-muted">{release || "?"}</span></span>
				<span><span className="text-muted tabular-nums">{cpus}</span> {cpus === 1 ? "CPU" : "CPUs"}</span>
				{user?.t1 != null && <span>{user.detail === "resumed" ? "resumed in" : "booted in"} <span className="text-muted tabular-nums">{fmtT(user.t1)}</span></span>}
			</p>
		</div>
	);
}

// ---- boot ------------------------------------------------------------------------------------
/** A stage's tone on the timeline: steps of the foreground, adjacent ones apart. */
const STAGE_TONE: Record<string, string> = {
	preflight: faded("var(--color-fg)", 30), kernel: faded("var(--color-fg)", 90), compile: faded("var(--color-fg)", 55),
	memory: faded("var(--color-fg)", 35), boot: faded("var(--color-fg)", 75), userspace: faded("var(--color-fg)", 48),
};
const STATE_WORD: Record<string, string> = { done: "", fail: "failed", active: "running", pending: "pending", skip: "skipped" };

type StageRow = ReturnType<NonNullable<typeof KW.ui>["stages"]>[number];

/**
 * Each shown stage's lane: the first one free at its start, so stages that
 * overlap (the compile streams while the download runs) sit on lanes of their
 * own and none hides another.
 */
function lanes(stages: StageRow[], end: (s: StageRow) => number): Map<string, number> {
	const ends: number[] = [], out = new Map<string, number>();
	for (const s of [...stages].sort((a, b) => a.t0! - b.t0!)) {
		let i = ends.findIndex((e) => e <= s.t0! + 1);
		if (i < 0) i = ends.length;
		ends[i] = end(s);
		out.set(s.id, i);
	}
	return out;
}

const LANE_H = 10, LANE_GAP = 3;

function BootTimeline() {
	const ui = KW.ui!;
	const busy = useStore(isStarting);
	// The stages live in ui.ts, outside the store: read them again on any store change, and each second while booting.
	useStore((s) => s);
	useTick(1000, busy);
	// The stage under the pointer (a segment or its row), and the one focused or tapped.
	const [hover, setHover] = useState<string | null>(null);
	const [sel, setSel] = useState<string | null>(null);
	const box = useRef<HTMLDivElement>(null);
	// A tapped segment's label goes with a press anywhere else (touch: a button may not take the focus, so no blur).
	useOutsidePress(box, () => setSel(null), !!sel);
	const stages = ui.stages();
	const now = Date.now() - KW.t0;
	const end = (s: StageRow) => s.t1 ?? (s.s === "active" ? now : null);
	const total = Math.max(1, ...stages.map((s) => end(s) ?? 0));
	const user = stages.find((s) => s.id === "userspace");
	const shown = stages.filter((s) => s.t0 != null && end(s) != null);
	const lane = lanes(shown, (s) => end(s)!);
	const nLanes = Math.max(1, ...[...lane.values()].map((i) => i + 1));
	const hot = hover ?? sel;
	const describe = (s: StageRow) => `${s.label} · started at ${fmtT(s.t0!)} · ${s.t1 != null ? "took" : "running for"} ${fmtT(end(s)! - s.t0!)}${s.s === "fail" ? " · failed" : ""}`;
	const tip = shown.find((s) => s.id === hot);
	const center = tip ? Math.min(100, ((tip.t0! + end(tip)!) / 2 / total) * 100) : 0;
	return (
		<Card title="Boot" icon={<LogIcon size={14} />} aside={user?.t1 != null ? `${user.detail === "resumed" ? "resumed" : "user space"} at ${fmtT(user.t1)}` : busy ? "booting…" : ""}>
			<div ref={box} role="group" aria-label="Boot timeline from the page's load" className="relative"
				style={{ height: nLanes * LANE_H + (nLanes - 1) * LANE_GAP }}>
				{Array.from({ length: nLanes }, (_, i) => (
					<span key={i} aria-hidden="true" className="absolute inset-x-0 rounded-[3px] bg-line/60" style={{ top: i * (LANE_H + LANE_GAP), height: LANE_H }} />
				))}
				{!shown.length && <span className="sr-only">not started</span>}
				{shown.map((s) => {
					const a = s.t0! / total, w = (end(s)! - s.t0!) / total, on = hot === s.id;
					const text = `${describe(s)}${s.detail ? `. ${s.detail}` : ""}`;
					return (
						<button key={s.id} type="button" aria-label={text} title={text}
							onPointerEnter={() => setHover(s.id)} onPointerLeave={() => setHover(null)}
							onFocus={() => setSel(s.id)} onBlur={() => setSel((x) => (x === s.id ? null : x))} onClick={() => setSel(s.id)}
							className={`absolute cursor-default rounded-[3px] outline-offset-1 transition-opacity ${s.s === "active" ? "motion-safe:animate-pulse" : ""} ${hot && !on ? "opacity-40" : ""} ${on ? "ring-1 ring-fg" : ""}`}
							style={{ left: `${a * 100}%`, width: `max(4px, ${w * 100}%)`, top: lane.get(s.id)! * (LANE_H + LANE_GAP), height: LANE_H,
								background: s.s === "fail" ? "var(--color-err)" : STAGE_TONE[s.id] }} />
					);
				})}
				{tip && (
					<div aria-hidden="true" className="pointer-events-none absolute top-[calc(100%+6px)] z-10 w-max max-w-full rounded-md bg-bg/90 px-2 py-1 text-[11px] leading-snug text-fg shadow-lg ring-1 ring-line-strong"
						style={{ left: `${center}%`, transform: `translateX(-${center}%)` }}>
						<div className="tabular-nums">{describe(tip)}</div>
						{tip.detail && <div className="break-words text-faint">{tip.detail}</div>}
					</div>
				)}
			</div>
			<ul id="stages" className="grid grid-cols-1 gap-x-5 gap-y-0.5 @lg:grid-cols-2 @4xl:grid-cols-3">
				{stages.map((st) => (
					<li key={st.id} data-s={st.s} title={st.detail || undefined} onPointerEnter={() => setHover(st.id)} onPointerLeave={() => setHover(null)}
						className={`-mx-1 grid min-w-0 grid-cols-[auto_1fr_auto] items-baseline gap-x-2 rounded px-1 py-px text-[11.5px] ${st.s === "pending" ? "opacity-50" : ""} ${hot === st.id ? "bg-hover" : ""}`}>
						<span aria-hidden="true" className="size-2 translate-y-[1px] rounded-[2px]" style={{ background: st.s === "fail" ? "var(--color-err)" : STAGE_TONE[st.id] }} />
						<span className={`min-w-0 truncate ${hot === st.id ? "text-fg" : "text-muted"}`}>
							{st.label}
							{STATE_WORD[st.s] && <span className={st.s === "fail" ? "text-err" : "text-faint"}> · {STATE_WORD[st.s]}</span>}
							{st.detail && <span className="text-faint"> · {st.detail}</span>}
						</span>
						<span className="text-faint tabular-nums">{st.ms != null ? fmtT(st.ms) : ""}</span>
					</li>
				))}
			</ul>
		</Card>
	);
}

// ---- the panels ------------------------------------------------------------------------------
function CpuCard({ st }: { st: StatsState }) {
	const cfg = KW.config;
	const g = st.guest, d = g?.derived, raw = g?.raw;
	const n = raw?.stat?.cpus.length || st.host?.stats.cpus || cfg.cpus;
	const load = raw?.load;
	return (
		<Card title="CPU" icon={<CpuIcon size={14} />} tone={TONE.cpu} aside={`${plural(n, "CPU")}${cfg.worker ? ", Web Workers" : ""}`}>
			<Figure value={d?.cpu != null ? pct(d.cpu) : "–"} of={d?.cpu != null ? "busy" : undefined} />
			{g ? <Spark points={st.points} height={CHART_H} series={[{ get: (p) => p.cpu, label: "busy", color: TONE.cpu, area: true }]} max={1} fmt={pct} label="CPU use" />
				: <Waiting why={waitText(st)} />}
			{d?.cpus && <Bars values={d.cpus} names={d.cpus.map((_, i) => `CPU ${i}`)} label="Each CPU's use" color={TONE.cpu} height={20} />}
			<Facts items={[
				["load 1 · 5 · 15", load ? `${load.one.toFixed(2)} · ${load.five.toFixed(2)} · ${load.fifteen.toFixed(2)}` : "–"],
				["tasks", load ? `${load.running} of ${fmtCount(load.tasks)}` : "–"],
				d?.ctxt != null && ["switches", `${fmtCount(d.ctxt)}/s`],
			]} />
		</Card>
	);
}

function MemoryCard({ st }: { st: StatsState }) {
	const m = st.guest?.raw.mem;
	const host = KW.memActualMiB || vmOf()?.memoryMiB || 0;
	const used = m ? m.total - m.available : 0, cache = m ? Math.max(0, m.available - m.free) : 0;
	const f = m ? used / m.total : 0;
	const usedColor = fullness(f, TONE.mem), cacheColor = faded(TONE.mem);
	return (
		<Card title="Memory" icon={<RamIcon size={14} />} tone={TONE.mem} aside={host ? `${fmtBytes(host * MiB)} wasm` : undefined}>
			<Figure value={m ? fmtBytes(used).split(" ")[0] : "–"} unit={m ? fmtBytes(used).split(" ")[1] : undefined} of={m ? `of ${fmtBytes(m.total)}` : undefined} />
			{m ? (
				<>
					<Meter total={m.total} label="Guest memory" parts={[
						{ value: used, color: usedColor, label: "in use", text: fmtBytes(used) },
						{ value: cache, color: cacheColor, label: "cache", text: fmtBytes(cache) },
					]} />
					<div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-faint">
						<Key color={usedColor}>used {pct(f)}</Key>
						<Key color={cacheColor}>cache {fmtBytes(cache)}</Key>
						<Key color="var(--color-line)">free {fmtBytes(m.free)}</Key>
					</div>
					<Spark points={st.points} series={[{ get: (p) => p.mem, label: "in use", color: TONE.mem, area: true }]} max={m.total} fmt={fmtBytes} label="Guest memory in use" height={CHART_H_SM} />
					{m.swapTotal > 0 && <Usage name="swap" used={m.swapTotal - m.swapFree} size={m.swapTotal} color={TONE.mem} />}
				</>
			) : <Waiting why={waitText(st)} />}
			<Facts items={[
				["available", m ? fmtBytes(m.available) : "–"],
				["page cache", m ? fmtBytes(m.cached + m.buffers) : "–"],
				m && m.swapTotal === 0 && ["swap", "none"],
			]} />
		</Card>
	);
}

function DiskCard({ st }: { st: StatsState }) {
	const cfg = KW.config;
	const disk = useStore((s) => s.disk);
	const distro = useStore((s) => s.distro);
	const df: DfRow[] = (st.df ?? []).filter((r) => r.size > 0);
	const data = df.find((r) => r.mount === "/data");
	const root = df.find((r) => r.mount === "/");
	// An overlay root whose changes are on /data reports /data's file system: shown once.
	const rootOwn = root && !(data && root.size === data.size && Math.abs(root.used - data.used) < 4 * MiB) ? root : undefined;
	const du = diskUse(st, disk);
	const rd = latest(st.points, (p) => p.rd), wr = latest(st.points, (p) => p.wr);
	return (
		<Card title="Disk" icon={<DiskIcon size={14} />} tone={TONE.disk} aside={disk ? (disk.saved ? "saved in this browser" : "in memory only") : "no data disk"}>
			<div className="flex flex-wrap gap-x-5 gap-y-1">
				<Figure value={rd != null ? fmtRate(rd) : "–"} of="read" />
				<Figure value={wr != null ? fmtRate(wr) : "–"} of="write" />
			</div>
			<Spark points={st.points} label="Disk I/O" fmt={fmtRate} height={CHART_H_SM} series={[
				{ get: (p) => p.rd, label: "read", color: TONE.disk, area: true },
				{ get: (p) => p.wr, label: "write", color: SECOND },
			]} />
			<div className="flex gap-4 text-[11px] text-faint"><Key color={TONE.disk}>read</Key><Key color={SECOND}>write</Key><span className="ml-auto">all disks</span></div>
			{du && <Usage name="/data" used={du.used} size={du.size} color={TONE.disk} note={du.exact ? undefined : "written"} />}
			{rootOwn && <Usage name="/ (changes)" used={rootOwn.used} size={rootOwn.size} color={TONE.disk} />}
			<Facts items={[
				disk && du?.exact && ["in the browser", `${fmtBytes(disk.used)} of ${fmtBytes(disk.size)}`],
				["root image", cfg.distro ? <span title={distro?.url}>{distro?.image || cfg.distro.name}, {fmtBytes(cfg.distro.size)}</span> : "base initramfs"],
			]} />
		</Card>
	);
}

const ifaces = (net: NetDev[]) => net.filter((n) => n.name !== "lo");
const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };

function NetworkCard({ st }: { st: StatsState }) {
	const cfg = KW.config;
	const g = st.guest, raw = g?.raw, d = g?.derived;
	const netStats = st.host?.stats.net;
	if (!cfg.net) {
		return (
			<Card title="Network" icon={<NetIcon off size={14} />} tone={TONE.net} aside="no device">
				<Figure value="Off" of="this boot" />
				<Facts items={[["turn on", <button type="button" className="text-accent hover:underline" onClick={() => openSection("network")}>Settings…</button>]]} />
			</Card>
		);
	}
	const devs = raw ? ifaces(raw.net) : [];
	const dev = devs.find((x) => x.name === "eth0") ?? devs[0];
	const oper = dev && raw ? raw.ifs[dev.name] : undefined;
	const servers = cfg.wisp ?? [...DEFAULT_WISP_SERVERS];
	const tot = devs.reduce((a, x) => ({ rx: a.rx + x.rx, tx: a.tx + x.tx }), { rx: 0, tx: 0 });
	return (
		<Card title="Network" icon={<NetIcon size={14} />} tone={TONE.net}
			aside={dev ? <>{dev.name} <span className={oper === "up" ? "text-ok" : oper === "down" ? "text-err" : ""}>{oper ?? "?"}</span></> : undefined}>
			<div className="flex flex-wrap gap-x-5 gap-y-1">
				<Figure value={d?.rx != null ? fmtRate(d.rx) : "–"} of="↓ in" />
				<Figure value={d?.tx != null ? fmtRate(d.tx) : "–"} of="↑ out" />
			</div>
			{g ? (
				<>
					<Spark points={st.points} label="Network traffic" fmt={fmtRate} height={CHART_H} series={[
						{ get: (p) => p.rx, label: "in", color: TONE.net, area: true },
						{ get: (p) => p.tx, label: "out", color: SECOND },
					]} />
					<div className="flex gap-4 text-[11px] text-faint"><Key color={TONE.net}>in</Key><Key color={SECOND}>out</Key></div>
				</>
			) : <Waiting why={waitText(st)} />}
			<Facts items={[
				["received", raw ? fmtBytes(tot.rx) : "–"],
				["sent", raw ? fmtBytes(tot.tx) : "–"],
				netStats && ["TCP · DNS", `${fmtCount(netStats.tcpOpened)} · ${fmtCount(netStats.dns)}`],
				["Wisp", <span title={servers.join(", ")}>{servers.map(host).join(", ")}</span>],
			]} />
		</Card>
	);
}

/** Guest GL (stats.ts GpuInfo): shown only with it. */
function GpuCard({ st }: { st: StatsState }) {
	const gpu = st.gpu!;
	const gs = gpuSeries(gpu);
	const gv = latest(st.points, gs.get);
	const busy = latest(st.points, (p) => p.glBusy), cmd = latest(st.points, (p) => p.glCmd);
	const dev = gpu.device;
	const ready = gpu.state === "ready";
	const lost = gpu.state === "lost" || !!dev?.contextLost;
	return (
		<Card title="GPU" icon={<GpuIcon size={14} />} tone={TONE.gpu} aside={dev ? "virtio-gpu 3D" : "GL over vtest"}>
			{ready && !lost ? <Figure value={gv != null ? gs.fmt(gv) : "–"} of={dev ? "shown" : undefined} />
				: <Figure value={capitalize(GPU_STATE[lost ? "lost" : gpu.state])} of={gpu.state === "idle" ? "loads on the first GL program" : lost ? "restart the GL programs" : undefined} />}
			<Spark points={st.points} height={CHART_H} fmt={gs.fmt} label={`GPU ${gs.label}`} series={[{ get: gs.get, label: gs.label, color: TONE.gpu, area: true }]} />
			<Spark points={st.points} height={CHART_H_SM - 12} max={1} fmt={pct} label="Renderer's share of the page's time" series={[{ get: (p) => p.glBusy, label: "renderer", color: SECOND }]} />
			<div className="flex gap-4 text-[11px] text-faint"><Key color={TONE.gpu}>{gs.label}</Key><Key color={SECOND}>renderer busy</Key></div>
			<Facts items={[
				ready && ["renderer busy", <span title="The share of the page's time spent in the GL renderer: decoding command buffers, issuing WebGL calls, reads that wait for the GPU. The GPU's own load is not measured (WebGL does not tell).">{busy != null ? pct(busy) : "–"}</span>],
				ready && dev && ["commands", cmd != null ? `${fmtCount(cmd)}/s` : "–"],
				dev?.scanout && ["scanout", `${dev.scanout.width}×${dev.scanout.height}`],
				dev && ["frames", fmtCount(dev.presents + gpu.wlGpu)],
				dev && dev.parks > 0 && ["fence waits", `${fmtCount(dev.parks)} of ${fmtCount(dev.fenced)}`],
				gpu.clients > 0 && ["vtest clients", String(gpu.clients)],
				dev && dev.errors > 0 && ["errors", <span className="text-err" title={dev.lastError}>{fmtCount(dev.errors)}</span>],
				gpu.loadMs != null && ["loaded in", fmtT(gpu.loadMs)],
			]} />
			{gpu.webgl && <p className="truncate text-[11px] text-faint" title={gpu.webgl}>WebGL2 <span className="text-muted">{gpu.webgl}</span></p>}
		</Card>
	);
}

/** Guest Vulkan (stats.ts VkInfo): shown only with it. */
function VkCard({ st }: { st: StatsState }) {
	const vk = st.vk!;
	const pts = st.points;
	const vs = vkSeries(pts);
	const vv = latest(pts, vs.get);
	const at = (get: (p: Point) => number | null) => latest(pts, get);
	const busy = at((p) => p.vkBusy), up = at((p) => p.vkUp), down = at((p) => p.vkDown);
	const draws = at((p) => p.vkDraws), disp = at((p) => p.vkDispatch), subs = at((p) => p.vkSubmits);
	const path = vkPath(at((p) => p.vkFps), at((p) => p.vkExt));
	const r = vk.renderer;
	const ready = vk.state === "ready";
	const bad = vkTrouble(vk);
	const frames = vs.label === "frames/s";
	const rate = (v: number | null) => (v != null ? `${fmtCount(v)}/s` : "–");
	return (
		<Card title="Vulkan" icon={<GpuIcon size={14} />} tone={TONE.vk} aside={ready ? plural(vk.connections, "instance") : "on WebGPU"}>
			{ready ? <Figure value={vv != null ? vs.fmt(vv) : "–"} of={frames ? path ?? "presented" : "compute"} />
				: <Figure value={<span className={vk.state === "lost" || vk.state === "failed" ? "text-err" : ""}>{capitalize(VK_STATE[vk.state])}</span>}
					of={vk.state === "idle" ? "loads on the first Vulkan program" : vk.state === "lost" ? "restart the Vulkan programs" : undefined} />}
			<Spark points={pts} height={CHART_H} fmt={vs.fmt} label={`Vulkan ${vs.label}`} series={frames
				? [{ get: vs.get, label: "frames/s", color: TONE.vk, area: true }, { get: (p) => (p.vkFps != null && p.vkExt != null ? Math.max(0, p.vkFps - p.vkExt) : null), label: "read back", color: SECOND }]
				: [{ get: vs.get, label: vs.label, color: TONE.vk, area: true }]} />
			<Spark points={pts} height={CHART_H_SM - 12} fmt={fmtRate} label="Vulkan transfers" series={[
				{ get: (p) => p.vkUp, label: "to GPU", color: TONE.vk, area: true },
				{ get: (p) => p.vkDown, label: "read back", color: SECOND },
			]} />
			<div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-faint">
				<Key color={TONE.vk}>{frames ? "frames · to GPU" : `${vs.label} · to GPU`}</Key><Key color={SECOND}>read back</Key>
			</div>
			<Facts items={[
				bad && bad.errors > 0 && ["errors", <span className="text-err" title="WebGPU validation errors and failed operations; the Kernel log and the browser console have them">{fmtCount(bad.errors)}</span>],
				bad && bad.losses > 0 && ["device lost", <span className="text-err" title={vk.error ?? undefined}>{bad.losses === 1 ? "once" : `${fmtCount(bad.losses)} times`}</span>],
				bad && bad.lost > 0 && ["programs cut off", <span className="text-err" title="Connections the renderer ended as a lost device for the guest (a failed submit or a request it could not answer)">{fmtCount(bad.lost)}</span>],
				vk.state === "failed" && ["error", <span className="text-err" title={vk.error ?? undefined}>{vk.error ?? "unknown"}</span>],
				ready && ["renderer busy", <span title="The share of the page's time spent in the Vulkan renderer: parsing the guest's frames, translating shaders, encoding submits. The GPU's own load is not measured (WebGPU does not tell).">{busy != null ? pct(busy) : "–"}</span>],
				ready && ["draws", rate(draws)],
				ready && ["dispatches", rate(disp)],
				ready && ["submits", rate(subs)],
				ready && ["to GPU", up != null ? fmtRate(up) : "–"],
				ready && ["read back", down != null ? fmtRate(down) : "–"],
				r && ["frames", <span title={`${fmtCount(r.externalPresents)} by external buffer (zero-copy), ${fmtCount(r.presents - r.externalPresents)} read back`}>{fmtCount(r.presents)}</span>],
				r && ["live objects", <span title={`${fmtCount(r.liveObjects)} guest objects, ${fmtCount(r.liveGpu)} GPU buffers and textures`}>{fmtCount(r.liveObjects)} · {fmtCount(r.liveGpu)}</span>],
				r && ["pipelines", fmtCount(r.pipelines)],
				r && ["shaders", <span title="SPIR-V to WGSL translations and the time they took">{fmtCount(r.translations)}, {fmtT(r.translateMs)}</span>],
				["instances", `${fmtCount(vk.connections)} now · ${fmtCount(vk.opened)} so far`],
				vk.loadMs != null && ["loaded in", fmtT(vk.loadMs)],
			]} />
			{vk.adapter && <p className="truncate text-[11px] text-faint" title={vk.adapter}>WebGPU <span className="text-muted">{vk.adapter}</span></p>}
		</Card>
	);
}

function EmulatorCard({ st }: { st: StatsState }) {
	const cfg = KW.config;
	const s = st.host?.stats, j = s?.jit;
	const vm = vmOf();
	const last = st.points[st.points.length - 1];
	const jitOn = !!j?.enabled && !!j.requested;
	const runs = cfg.worker ? `Web Worker${vm?.transport === "shared" ? ", shared memory" : vm?.transport === "messages" ? ", messages" : ""}` : "the page's thread";
	return (
		<Card title="Emulator" icon={<PromptIcon size={14} />} aside={`AArch64 on wasm${jitOn ? ", JIT" : j ? ", interpreter" : ""}`}>
			{jitOn ? <Figure value={fmtCount(j.compiled)} of="blocks compiled" />
				: <Figure value={!cfg.jit ? "Off" : j ? "–" : "…"} of={!cfg.jit ? "JIT off (?jit=0)" : j && !j.requested ? "no JIT tier" : j ? "JIT unavailable" : undefined} />}
			{s ? (
				<Spark points={st.points} height={CHART_H_SM} label={jitOn ? "JIT compiles" : "Task switches"} fmt={(v) => `${fmtCount(v)}/s`} series={[jitOn
					? { get: (p) => p.jit, label: "compiles", color: "var(--color-fg)", area: true }
					: { get: (p) => p.sw, label: "switches", color: "var(--color-fg)", area: true }]} />
			) : <Waiting why={st.idle ? `Not sampled: ${st.idle}` : "Waiting for the first sample…"} height={CHART_H_SM} />}
			<Facts items={[
				jitOn && ["live blocks", `${fmtCount(j.live)} (max ${fmtCount(j.maxLive)})`],
				jitOn && ["compiling", `${fmtT(j.compileMs)}, ${fmtBytes(j.bytes)}`],
				jitOn && j.failed > 0 && ["failed", fmtCount(j.failed)],
				last?.sw != null && ["task switches", `${fmtCount(last.sw)}/s`],
				last?.mips != null && ["guest MIPS", last.mips.toFixed(1)],
				["runs on", runs],
				["isolation", crossOriginIsolated ? "isolated" : "not isolated"],
			]} />
		</Card>
	);
}

type SortKey = "cpu" | "mem";
const byKey: Record<SortKey, (a: TopProc, b: TopProc) => number> = {
	cpu: (a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || b.rss - a.rss,
	mem: (a, b) => b.rss - a.rss || (b.cpu ?? -1) - (a.cpu ?? -1),
};

function ProcessesCard({ st, className = "" }: { st: StatsState; className?: string }) {
	const [sort, setSort] = useState<SortKey>("cpu");
	const g = st.guest, raw = g?.raw;
	const all = g?.derived.procs ?? [];
	const top = [...all].sort(byKey[sort]).slice(0, TOP);
	const memTotal = raw?.mem?.total ?? 0;
	// A plain call, not a component: a component made here would be new on each render and its button lose the focus at each sample.
	const th = (k: SortKey, label: string, c: string) => (
		<th aria-sort={sort === k ? "descending" : "none"} className={`pb-1 text-right font-normal ${c}`}>
			<button type="button" onClick={() => setSort(k)} className={`hover:text-fg ${sort === k ? "text-muted" : ""}`}>{label}{sort === k ? " ▾" : ""}</button>
		</th>
	);
	return (
		<Card title="Processes" icon={<ActivityIcon size={14} />} className={className}
			aside={raw ? `${all.length} user · ${raw.load ? fmtCount(raw.load.tasks) : "?"} tasks` : undefined}>
			{g && all.length ? (
				<table className="w-full table-fixed text-[12px]">
					<caption className="sr-only">The busiest user processes since the last sample; CPU is the share of one CPU, memory the resident set; kernel threads left out</caption>
					<thead className="font-sans text-[11px] text-faint">
						<tr>
							<th className="pb-1 text-left font-normal">process</th>
							<th className="w-14 pb-1 text-right font-normal @max-sm:hidden">pid</th>
							{th("cpu", "CPU", "w-24")}
							{th("mem", "memory", "w-24")}
						</tr>
					</thead>
					<tbody className="tabular-nums">
						{top.map((p) => (
							<tr key={p.pid}>
								<td className="truncate py-0.5 text-muted" title={`${p.comm}, pid ${p.pid}`}>{p.comm}</td>
								<td className="py-0.5 text-right text-faint @max-sm:hidden">{p.pid}</td>
								<td className="py-0.5 text-right">
									<span className="inline-flex items-center justify-end gap-1.5">
										<span aria-hidden="true" className="relative h-1 w-8 overflow-hidden rounded-full bg-line @max-sm:hidden">
											<span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(1, p.cpu ?? 0) * 100}%`, background: TONE.cpu }} />
										</span>
										<span className="w-9 text-fg">{p.cpu != null ? pct(p.cpu) : "–"}</span>
									</span>
								</td>
								<td className="py-0.5 text-right">
									<span className="inline-flex items-center justify-end gap-1.5">
										<span aria-hidden="true" className="relative h-1 w-8 overflow-hidden rounded-full bg-line @max-sm:hidden">
											<span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${memTotal ? Math.min(1, p.rss / memTotal) * 100 : 0}%`, background: TONE.mem }} />
										</span>
										<span className="w-14 text-faint">{fmtBytes(p.rss)}</span>
									</span>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			) : <Waiting why={g ? "No user processes listed" : waitText(st)} height={120} />}
		</Card>
	);
}

function Row({ k, children }: { k: string; children: ReactNode }) {
	return <><dt className="text-faint">{k}</dt><dd className="min-w-0 break-words text-muted">{children}</dd></>;
}

function Machine() {
	const cfg = KW.config;
	const distro = useStore((s) => s.distro);
	const disk = useStore((s) => s.disk);
	const mem = KW.memActualMiB || cfg.memMiB;
	return (
		<dl className="grid grid-cols-[11ch_1fr] gap-x-4 gap-y-1 text-[12px] tabular-nums">
			<Row k="kernel">Linux {B.linux || "?"}{B.kernel && <span className="text-faint">, {B.kernel === "local" ? "local build" : B.kernel}</span>}</Row>
			<Row k="distro">{distro ? <>{distro.image || distro.name}<span className="text-faint">, {distro.url}</span></> : "none (base shell)"}</Row>
			<Row k="cpus">{cfg.cpus}{cfg.worker ? <span className="text-faint">, in Web Workers</span> : <span className="text-faint">, on the page's thread</span>}</Row>
			<Row k="memory">{mem >= 1024 ? `${+(mem / 1024).toFixed(1)} GiB` : `${mem} MiB`}<span className="text-faint"> ({cfg.memWhy})</span></Row>
			<Row k="data disk">{disk ? <>{fmtBytes(disk.used)} of {fmtBytes(disk.size)}<span className="text-faint">, {disk.saved ? "saved in this browser" : "in memory only"}</span></> : "none"}</Row>
			<Row k="command">{cfg.cmdline}</Row>
		</dl>
	);
}

/** Whether the numbers are live, and why not. */
function Live({ st }: { st: StatsState }) {
	const live = !st.idle;
	return (
		<span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-normal">
			<span aria-hidden="true" className={`size-1.5 rounded-full ${live && !st.waiting ? "bg-ok" : "bg-off"}`} />
			{live ? (st.waiting && !st.guest ? "waiting for the guest" : `live, every ${INTERVAL / 1000} s, last ${RING * INTERVAL / 60000} min`) : `paused: ${st.idle}`}
		</span>
	);
}

export function Overview() {
	const st = useStats();
	const gpu = !!st.gpu, vk = !!st.vk;
	// The panels before Processes: five, with guest GL's and Vulkan's six or seven; it fills the grid's last row.
	const n = 5 + Number(gpu) + Number(vk);
	const span = `${n % 2 ? "" : "@lg:col-span-2"} ${["@4xl:col-span-3", "@4xl:col-span-2", "@4xl:col-span-1"][n % 3]}`;
	return (
		<div className="@container flex flex-col gap-4">
			<StateLine st={st} />
			<div>
				<div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
					<h3 className="font-sans text-[12px] font-medium text-faint">Resources</h3>
					<span className="ml-auto text-faint"><Live st={st} /></span>
				</div>
				<div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @4xl:grid-cols-3">
					<CpuCard st={st} />
					<MemoryCard st={st} />
					<DiskCard st={st} />
					<NetworkCard st={st} />
					{gpu && <GpuCard st={st} />}
					{vk && <VkCard st={st} />}
					<EmulatorCard st={st} />
					<ProcessesCard st={st} className={span} />
				</div>
			</div>
			<BootTimeline />
			<div>
				<H3>Machine</H3>
				<Machine />
			</div>
		</div>
	);
}
