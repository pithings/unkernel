// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The resource glance: the top bar's Resources popover (ControlCenter.tsx
// #tb-res, opened by clicking a resource meter: TopBar.tsx
// #tb-cpu, #tb-mem, #tb-disk, #tb-net, #tb-gpu, whose row is then marked
// and scrolled into view; #tb-gpu marks both GPU rows). One row per
// resource: its icon in its colour (Charts.tsx TONE, as in the Overview),
// its name, a sparkline of the history (stats.ts, the last three minutes)
// and its current value on one line, then a line of secondary facts:
// - CPU: busy; load, CPUs, the busiest process;
// - Memory: in use of the total; cache, free, swap when there is any;
// - Disk: /data used of its size (df, else the data disk's blocks written);
//   host block I/O read and write rates (every disk);
// - Network: received and sent per second; the interface, totals (Off
//   without a network device);
// - GPU, only with guest GL: frames per second the GPU path showed
//   (virtio-gpu presents and Wayland GPU commits), or the renderer's command
//   buffers per second without virtio-gpu, or the renderer's state before it
//   is loaded; the renderer's share of the page's time, the scanout, the
//   WebGL2 implementation. Never called GPU utilisation: WebGL does not tell.
// - Vulkan, only with guest Vulkan (vm.vk: not with the option off or
//   without WebGPU): frames per second presented, or compute dispatches per
//   second while no program presents, or the renderer's state before it is
//   loaded (it loads on the guest's first VkInstance); errors and device
//   losses in red, the renderer's share of the page's time, the instances
//   now, how the frames reach the page (zero-copy, by readback, or both),
//   the WebGPU adapter.
// While it is mounted the sampler runs at the full rate (useStats(): a full
// user), back to the top bar's light rate once it goes. Also the helpers
// System's Overview shares (latest(), diskUse(), gpuSeries(), GPU_STATE,
// vkSeries(), VK_STATE, vkTrouble()).
import { useEffect, useRef, type ReactNode } from "react";
import { fmtBytes, fmtCount, fmtFps, fmtPct, fmtRate, fmtRateShort, plural } from "../format.ts";
import { KW } from "../kw.ts";
import { useStats, type GpuInfo, type Point, type StatsState, type VkInfo } from "../stats.ts";
import { useStore } from "../store.ts";
import { SECOND, Spark, TONE } from "./Charts.tsx";
import { CpuIcon, DiskIcon, GpuIcon, NetIcon, RamIcon } from "./icons.tsx";

export type ResKey = "cpu" | "mem" | "disk" | "net" | "gpu" | "vk";

const SPARK_H = 18;

/** The renderer's state, in words. */
export const GPU_STATE: Record<GpuInfo["state"], string> = { idle: "not loaded", loading: "loading", ready: "ready", lost: "context lost", failed: "failed" };

/** The Vulkan renderer's state, in words. */
export const VK_STATE: Record<VkInfo["state"], string> = { idle: "not loaded", loading: "loading", ready: "ready", lost: "device lost", failed: "failed" };

/** Guest Vulkan's errors and device losses (they show in red), or null with none. */
export function vkTrouble(vk: VkInfo): { errors: number; losses: number; lost: number } | null {
	const errors = vk.renderer?.errors ?? 0, lost = vk.renderer?.lost ?? 0;
	return errors || lost || vk.losses ? { errors, losses: vk.losses, lost } : null;
}

/** Guest Vulkan's activity series: frames presented, else (compute only, as llama.cpp) dispatches. */
export const vkSeries = (points: Point[]) => (!points.some((p) => (p.vkFps ?? 0) > 0) && points.some((p) => (p.vkDispatch ?? 0) > 0)
	? { get: (p: Point) => p.vkDispatch, label: "dispatches/s", fmt: (v: number) => `${fmtCount(v)}/s` }
	: { get: (p: Point) => p.vkFps, label: "frames/s", fmt: fmtFps });

/** How the last sample's Vulkan frames reached the page: by external buffer (zero-copy), read back, or both; null with none. */
export function vkPath(fps: number | null, ext: number | null): string | null {
	if (fps == null || ext == null || fps <= 0) return null;
	const back = Math.max(0, fps - ext);
	return back < 0.05 ? "zero-copy" : ext < 0.05 ? "by readback" : `zero-copy ${fmtFps(ext)} · readback ${fmtFps(back)}`;
}

/** The newest sample's value of a series, or null. */
export const latest = (points: Point[], get: (p: Point) => number | null): number | null => {
	const p = points[points.length - 1];
	return p ? get(p) : null;
};

/** /data's use from the last df, else the data disk's blocks written (the store), or null. */
export function diskUse(st: StatsState, disk: { used: number; size: number } | null): { used: number; size: number; exact: boolean } | null {
	const data = st.df?.find((r) => r.mount === "/data" && r.size > 0);
	if (data) return { used: data.used, size: data.size, exact: true };
	return disk && disk.size > 0 ? { used: disk.used, size: disk.size, exact: false } : null;
}

/** The GPU's activity series: frames shown with virtio-gpu, else command buffers. */
export const gpuSeries = (gpu: GpuInfo) => (gpu.device
	? { get: (p: Point) => p.fps, label: "frames/s", fmt: fmtFps }
	: { get: (p: Point) => p.glCmd, label: "command buffers/s", fmt: (v: number) => `${fmtCount(v)}/s` });

/** A resource: icon, name, sparkline (children) and value on one line, the facts under them. */
function Row({ k, current, icon, label, value, facts, children }: {
	k: ResKey; current: boolean; icon: ReactNode; label: string; value: ReactNode; facts: Array<ReactNode | false | null | undefined>; children?: ReactNode;
}) {
	return (
		<section aria-label={label} data-res={k} aria-current={current || undefined}
			className={`flex flex-col gap-1 px-3 py-2 ${current ? "bg-ink/[0.06]" : ""}`}>
			<div className="flex min-w-0 items-center gap-2">
				<span aria-hidden="true" className="flex flex-none" style={{ color: TONE[k] }}>{icon}</span>
				<span className="w-[54px] flex-none font-sans text-[12px] text-muted">{label}</span>
				<div className="min-w-10 flex-1">{children}</div>
				<span className="min-w-0 flex-none truncate text-right text-[12.5px] text-fg tabular-nums">{value}</span>
			</div>
			<p className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 pl-[22px] text-[11px] text-faint tabular-nums">
				{facts.filter(Boolean).map((f, i) => <span key={i} className="max-w-full min-w-0 truncate">{f}</span>)}
			</p>
		</section>
	);
}

/** The resource rows; `current`: the one marked (and scrolled into view when it changes), if any. */
export function Resources({ current }: { current: ResKey | null }) {
	const st = useStats();
	const disk = useStore((s) => s.disk);
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		// The GPU meter marks both GPU rows: guest GL's and Vulkan's.
		if (current) box.current?.querySelector(current === "gpu" ? '[data-res="gpu"], [data-res="vk"]' : `[data-res="${current}"]`)?.scrollIntoView?.({ block: "nearest" });
	}, [current]);

	const cfg = KW.config;
	const g = !st.waiting && !st.idle ? st.guest : null;
	const why = st.idle ? `not sampled: ${st.idle}` : "waiting for the guest";
	const pts = st.points;
	// CPU
	const cpu = g?.derived.cpu ?? null, load = g?.raw.load, ncpu = g?.raw.stat?.cpus.length || cfg.cpus;
	const busiest = g?.derived.procs[0];
	// Memory
	const m = g?.raw.mem;
	const used = m ? m.total - m.available : 0, cache = m ? Math.max(0, m.available - m.free) : 0;
	// Disk
	const du = diskUse(st, disk);
	const rd = latest(pts, (p) => p.rd), wr = latest(pts, (p) => p.wr);
	// Network
	const rx = g?.derived.rx ?? null, tx = g?.derived.tx ?? null;
	const devs = g ? g.raw.net.filter((n) => n.name !== "lo") : [];
	const dev = devs.find((x) => x.name === "eth0") ?? devs[0];
	const tot = devs.reduce((s, x) => ({ rx: s.rx + x.rx, tx: s.tx + x.tx }), { rx: 0, tx: 0 });
	// GPU
	const gpu = st.gpu;
	const gs = gpu && gpuSeries(gpu);
	const gv = gs && latest(pts, gs.get);
	const busy = latest(pts, (p) => p.glBusy);
	// Vulkan
	const vk = st.vk;
	const vs = vk && vkSeries(pts);
	const vv = vs && latest(pts, vs.get);
	const vBusy = latest(pts, (p) => p.vkBusy);
	const vPath = vkPath(latest(pts, (p) => p.vkFps), latest(pts, (p) => p.vkExt));
	const vBad = vk && vkTrouble(vk);

	return (
		<div ref={box} role="group" aria-label="Resources" className="flex flex-col">
			{st.idle && <p className="px-3 pt-1 pb-1 font-sans text-[11.5px] text-faint">Not sampled: {st.idle}</p>}
			<Row k="cpu" current={current === "cpu"} icon={<CpuIcon size={14} />} label="CPU" value={cpu != null ? fmtPct(cpu) : "–"}
				facts={g ? [
					load && `load ${load.one.toFixed(2)}`,
					`${ncpu} CPU${ncpu === 1 ? "" : "s"}`,
					busiest && busiest.cpu != null && busiest.cpu >= 0.005 && <span title={`pid ${busiest.pid}`}>{busiest.comm} {fmtPct(busiest.cpu)}</span>,
				] : [why]}>
				<Spark bare points={pts} height={SPARK_H} max={1} fmt={fmtPct} label="CPU use" series={[{ get: (p) => p.cpu, label: "busy", color: TONE.cpu, area: true }]} />
			</Row>
			<Row k="mem" current={current === "mem"} icon={<RamIcon size={14} />} label="Memory" value={m ? fmtPct(used / m.total) : "–"}
				facts={m ? [
					`${fmtBytes(used)} of ${fmtBytes(m.total)}`,
					`cache ${fmtBytes(cache)}`,
					`free ${fmtBytes(m.free)}`,
					m.swapTotal > 0 && `swap ${fmtBytes(m.swapTotal - m.swapFree)}`,
				] : [why]}>
				<Spark bare points={pts} height={SPARK_H} max={m?.total} fmt={fmtBytes} label="Guest memory in use" series={[{ get: (p) => p.mem, label: "in use", color: TONE.mem, area: true }]} />
			</Row>
			<Row k="disk" current={current === "disk"} icon={<DiskIcon size={14} />} label="Disk" value={du ? fmtPct(du.used / du.size) : "–"}
				facts={[
					du ? `${fmtBytes(du.used)} of ${fmtBytes(du.size)}${du.exact ? "" : " written"}` : "no data disk",
					rd != null && `read ${fmtRate(rd)}`,
					wr != null && `write ${fmtRate(wr)}`,
				]}>
				<Spark bare points={pts} height={SPARK_H} fmt={fmtRate} label="Disk I/O" series={[
					{ get: (p) => p.rd, label: "read", color: TONE.disk, area: true },
					{ get: (p) => p.wr, label: "write", color: SECOND },
				]} />
			</Row>
			<Row k="net" current={current === "net"} icon={<NetIcon off={!cfg.net} size={14} />} label="Network"
				value={!cfg.net ? "Off" : rx != null && tx != null ? `↓ ${fmtRateShort(rx)}  ↑ ${fmtRateShort(tx)}` : "–"}
				facts={!cfg.net ? ["no network device this boot"] : g ? [
					dev && `${dev.name} ${g.raw.ifs[dev.name] ?? ""}`.trim(),
					`in ${fmtBytes(tot.rx)}`,
					`out ${fmtBytes(tot.tx)}`,
				] : [why]}>
				{cfg.net && (
					<Spark bare points={pts} height={SPARK_H} fmt={fmtRate} label="Network traffic" series={[
						{ get: (p) => p.rx, label: "in", color: TONE.net, area: true },
						{ get: (p) => p.tx, label: "out", color: SECOND },
					]} />
				)}
			</Row>
			{gpu && gs && (
				<Row k="gpu" current={current === "gpu"} icon={<GpuIcon size={14} />} label="GPU"
					value={gpu.state !== "ready" ? GPU_STATE[gpu.state] : gv != null ? gs.fmt(gv) : "–"}
					facts={[
						gpu.state === "ready" && busy != null && <span title="The share of the page's time spent in the GL renderer (decoding command buffers, issuing WebGL calls, reads that wait for the GPU); the GPU's own load is not measured">renderer {fmtPct(busy)} busy</span>,
						gpu.device?.scanout && `${gpu.device.scanout.width}×${gpu.device.scanout.height}`,
						gpu.state === "idle" && "loads on the first GL program",
						gpu.webgl && <span title={gpu.webgl}>{gpu.webgl}</span>,
					]}>
					<Spark bare points={pts} height={SPARK_H} fmt={gs.fmt} label={`GPU ${gs.label}`} series={[{ get: gs.get, label: gs.label, color: TONE.gpu, area: true }]} />
				</Row>
			)}
			{vk && vs && (
				<Row k="vk" current={current === "vk" || current === "gpu"} icon={<GpuIcon size={14} />} label="Vulkan"
					value={vk.state !== "ready" ? <span className={vk.state === "lost" || vk.state === "failed" ? "text-err" : ""}>{VK_STATE[vk.state]}</span> : vv != null ? vs.fmt(vv) : "–"}
					facts={[
						vBad?.errors && <span className="text-err">{plural(vBad.errors, "error")}</span>,
						vBad?.losses && <span className="text-err" title={vk.error ?? undefined}>device lost {vBad.losses === 1 ? "once" : `${vBad.losses}×`}</span>,
						vk.state === "failed" && vk.error && <span className="text-err" title={vk.error}>{vk.error}</span>,
						vk.state === "ready" && vBusy != null && <span title="The share of the page's time spent in the Vulkan renderer (parsing the guest's frames, translating shaders, encoding submits); the GPU's own load is not measured">renderer {fmtPct(vBusy)} busy</span>,
						vk.state === "ready" && plural(vk.connections, "instance"),
						vPath,
						vk.state === "idle" && "loads on the first Vulkan program",
						vk.adapter && <span title={vk.adapter}>{vk.adapter}</span>,
					]}>
					<Spark bare points={pts} height={SPARK_H} fmt={vs.fmt} label={`Vulkan ${vs.label}`} series={[{ get: vs.get, label: vs.label, color: TONE.vk, area: true }]} />
				</Row>
			)}
		</div>
	);
}
