// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The small charts of System's Overview (components/Overview.tsx) and of the
// top bar's Resources (components/Glance.tsx), drawn as inline SVG and
// plain elements, no chart library:
// - Spark: a time series (stats.ts's history) as a line with a faint flat
//   area under it, one or two series, over a fixed window of time ending at
//   the newest sample; a sample without a value (the guest was not read) or
//   a gap between samples breaks the line. Its scale is fixed (0 to 100 %)
//   or the series' peak rounded up, written at its top left. Under a pointer
//   a crosshair and the values at that time; its accessible name says the
//   current value and the peak. `bare` (the popover's sparklines): only the
//   lines and the base line, no scale and no crosshair. Strokes keep their
//   width however the chart is stretched (vector-effect), so it is crisp at
//   any size and density.
// - Meter: a thin bar of one whole split into parts (memory: in use, cache,
//   free), with its parts' names and values in its accessible name.
// - Bars: one small vertical bar per value (each CPU's share).
// Colours: one per resource (TONE: CPU, memory, disk, network, GPU (guest
// GL), Vulkan), the same in the Overview and the popover, for the main
// series; the muted gray for a second one; amber and red only for a meter
// that is nearly full.
import { useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { agoSeconds } from "../format.ts";
import { GAP, INTERVAL, RING, type Point } from "../stats.ts";

export interface Series {
	/** Its value in a sample, or null. */
	get: (p: Point) => number | null;
	label: string;
	/** A CSS colour. */
	color: string;
	/** Draw the area under it (the first series). */
	area?: boolean;
}

/** Each resource's colour (its charts' main series), on the black theme. */
export const TONE = {
	cpu: "var(--color-accent)",
	mem: "#b28cff",
	disk: "#3fcfb4",
	net: "#ff8ac6",
	gpu: "#e6c84f",
	vk: "#f0905a",
} as const;
/** The second series of a chart (out, write). */
export const SECOND = "var(--color-muted)";

/** The window the charts show, ms: the whole history. */
const WINDOW = RING * INTERVAL;
const VB_W = 1000;

/** A round number at or above n (1, 2, 5 × 10^k), for a scale's top. */
export function niceCeil(n: number): number {
	if (!(n > 0)) return 1;
	const p = 10 ** Math.floor(Math.log10(n)), f = n / p;
	return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** Each series' path segments (no value, or a gap, breaks one) in viewBox units. */
function paths(points: Point[], get: Series["get"], t1: number, max: number, h: number): { line: string; area: string } {
	let line = "", area = "";
	let seg: [number, number][] = [];
	const flush = () => {
		if (!seg.length) return;
		if (seg.length === 1) seg.push([seg[0]![0] + 2, seg[0]![1]]); // a lone sample: a short dash
		line += `M${seg.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}`;
		area += `M${seg[0]![0].toFixed(1)},${h}L${seg.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}L${seg[seg.length - 1]![0].toFixed(1)},${h}Z`;
		seg = [];
	};
	let last = -Infinity;
	for (const p of points) {
		const v = get(p);
		if (v == null || p.t - last > GAP) flush();
		last = p.t;
		if (v == null) continue;
		const x = ((p.t - (t1 - WINDOW)) / WINDOW) * VB_W;
		if (x < 0) continue;
		// 1.5 units of headroom so a line at the top keeps its whole stroke.
		const y = h - 1 - (Math.min(v, max) / max) * (h - 2.5);
		seg.push([x, y]);
	}
	flush();
	return { line, area };
}


export function Spark({ points, series, max, fmt, label, height = 52, bare = false }: {
	points: Point[];
	series: Series[];
	/** A fixed top of the scale (1: shares); else the peak, rounded up. */
	max?: number;
	fmt: (v: number) => string;
	/** What it shows, for its accessible name ("CPU use"). */
	label: string;
	height?: number;
	/** Only the lines: no scale, no top rule, no crosshair (a sparkline). */
	bare?: boolean;
}) {
	/** The pointer's place across the chart, 0 to 1, or null. */
	const [hover, setHover] = useState<number | null>(null);
	const t1 = points.length ? points[points.length - 1]!.t : Date.now();
	const shown = points.filter((p) => p.t >= t1 - WINDOW);
	let peak = 0;
	for (const p of shown) for (const s of series) peak = Math.max(peak, s.get(p) ?? 0);
	const top = max ?? niceCeil(peak);
	const h = height;
	const latest = series.map((s) => {
		for (let i = shown.length - 1; i >= 0; i--) { const v = s.get(shown[i]!); if (v != null) return v; }
		return null;
	});
	const name = `${label}, the last ${Math.round(WINDOW / 60000)} minutes: ` + (shown.length && latest.some((v) => v != null)
		? series.map((s, i) => `${s.label} ${latest[i] != null ? fmt(latest[i]!) : "unknown"}`).join(", ") + `; peak ${fmt(peak)}`
		: "no samples yet");

	const onMove = (e: PointerEvent<HTMLDivElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		setHover(r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : null);
	};
	// The sample nearest the pointer (found again as samples arrive).
	let hp: Point | undefined;
	if (hover != null) {
		const t = t1 - WINDOW + hover * WINDOW;
		let d = INTERVAL * 1.5;
		for (const p of shown) { const x = Math.abs(p.t - t); if (x < d) { d = x; hp = p; } }
	}
	const hx = hp ? ((hp.t - (t1 - WINDOW)) / WINDOW) * 100 : 0;

	return (
		<div className="relative select-none" style={{ height: h }} onPointerMove={bare ? undefined : onMove} onPointerLeave={bare ? undefined : () => setHover(null)}>
			<svg role="img" aria-label={name} width="100%" height={h} viewBox={`0 0 ${VB_W} ${h}`} preserveAspectRatio="none" className="block overflow-visible">
				{!bare && <line x1="0" x2={VB_W} y1="0.5" y2="0.5" stroke="var(--color-line)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />}
				<line x1="0" x2={VB_W} y1={h - 0.5} y2={h - 0.5} stroke="var(--color-line-strong)" vectorEffect="non-scaling-stroke" />
				{series.map((s, i) => {
					const p = paths(shown, s.get, t1, top, h);
					return (
						<g key={s.label}>
							{s.area && i === 0 && <path d={p.area} fill={s.color} fillOpacity="0.14" />}
							<path d={p.line} fill="none" stroke={s.color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
						</g>
					);
				})}
			</svg>
			{!bare && (max != null || peak > 0) && <span aria-hidden="true" className="pointer-events-none absolute top-0.5 left-1 font-mono text-[10px] leading-none text-faint">{fmt(top)}</span>}
			{hp && (
				<>
					<span aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-px bg-ink/30" style={{ left: `${hx}%` }} />
					<span aria-hidden="true" className="pointer-events-none absolute top-0.5 rounded-sm bg-bg/85 px-1.5 py-0.5 font-mono text-[10.5px] leading-tight whitespace-nowrap text-fg tabular-nums ring-1 ring-line-strong"
						style={(hx > 55 ? { right: `calc(${100 - hx}% + 6px)` } : { left: `calc(${hx}% + 6px)` }) satisfies CSSProperties}>
						<span className="text-faint">{agoSeconds(t1 - hp.t)}</span>
						{series.map((s) => { const v = s.get(hp); return <span key={s.label} className="ml-2"><span style={{ color: s.color }}>●</span> {v != null ? fmt(v) : "–"}</span>; })}
					</span>
				</>
			)}
		</div>
	);
}

/** A colour by how full: `base` (the accent), amber from 85 %, red from 95 %. */
export const fullness = (f: number, base: string = "var(--color-accent)") => (f >= 0.95 ? "var(--color-err)" : f >= 0.85 ? "var(--color-warn)" : base);

export interface Part { value: number; color: string; label: string; text: string }

/** One whole split into parts, left to right; what is left of `total` is the track. */
export function Meter({ parts, total, label, height = 6 }: { parts: Part[]; total: number; label: string; height?: number }) {
	const name = `${label}: ${parts.map((p) => `${p.label} ${p.text}`).join(", ")}`;
	return (
		<div role="img" aria-label={name} className="flex w-full gap-[2px] overflow-hidden rounded-full bg-line" style={{ height }}>
			{total > 0 && parts.map((p) => p.value > 0 && (
				<span key={p.label} title={`${p.label}: ${p.text}`} className="h-full flex-none transition-[width] duration-500 motion-reduce:transition-none"
					style={{ width: `${Math.min(100, (p.value / total) * 100)}%`, background: p.color }} />
			))}
		</div>
	);
}

/** A key for a series or a part: a dot of its colour and its name. */
export const Key = ({ color, children }: { color: string; children: ReactNode }) => (
	<span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="size-2 flex-none rounded-full" style={{ background: color }} />{children}</span>
);

/** A small vertical bar per value (0 to 1), with each one's name and value, in `color`. */
export function Bars({ values, names, label, height = 26, color = "var(--color-accent)" }: { values: number[]; names: string[]; label: string; height?: number; color?: string }) {
	return (
		<div role="img" aria-label={`${label}: ${values.map((v, i) => `${names[i]} ${Math.round(v * 100)}%`).join(", ")}`} className="flex items-end gap-[3px]" style={{ height }}>
			{values.map((v, i) => (
				<span key={i} title={`${names[i]}: ${Math.round(v * 100)}%`} className="relative h-full min-w-[3px] flex-1 overflow-hidden rounded-[2px] bg-line">
					<span className="absolute inset-x-0 bottom-0 rounded-[2px] transition-[height] duration-500 motion-reduce:transition-none" style={{ height: `${Math.max(v > 0 ? 6 : 0, v * 100)}%`, background: color }} />
				</span>
			))}
		</div>
	);
}
