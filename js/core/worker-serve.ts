// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The worker's side of createKernel({ worker: true }): wait for the boot
// message, load, compile and boot the kernel with createKernelOn() (so
// defaults, progress and errors are those of inline mode), and serve the
// owner's messages (worker-protocol.ts). Universal: a platform binding
// (js/node/worker-entry.ts) supplies the port and the file reader.
//
// The display, evdev and sound (the owner's side and the design are in
// worker-devices.ts): the display size comes from the boot message and
// "display-size"; mode and open-state changes are posted as they happen;
// evdev calls are applied to the InputHost in order. A frame credit is
// answered at once if the picture may have changed since the last frame
// sent, else when it may have: this side runs only while the kernel is
// suspended (idle or at a yield), and every return to the event loop
// counts an idle or a yield, so the frame cannot have changed while
// idles + yields stayed the same. While credits wait, a FRAME_POLL_MS timer
// checks again (it fires at the kernel's next yield). PCM chunks are posted
// at once, from inside the import (transferred); the kernel's question
// (frames queued at the sink) is answered from the owner's latest report.
//
// With the shared transport (spec.shared; worker-shared.ts) console and
// evdev input, frame requests, shm reads and vsock packets for the guest
// come through shared memory instead, read
// in the kernel's clock import (SharedServer as Kernel.poller), and frames
// go back through a shared triple buffer; "kick" messages wake an idle
// kernel. The message handlers below stay, for the frames' fallback and for
// owners that send messages anyway.

import { diskState, type DeviceRegistry, type DiskState } from "./devices.ts";
import { createKernelOn, type InstanceStats, type KernelInstance, type Platform } from "./instance.ts";
import type { ExitResult, Kernel } from "./kernel.ts";
import { CowDisk, type BlockDevice } from "./block.ts";
import { BootError } from "./load.ts";
import type { DisplayMode, DisplaySize } from "./display.ts";
import type { SoundChunk, SoundSink } from "./sound.ts";
import { SoundRingWriter } from "./sound-ring.ts";
import { sharedNow } from "./worker-devices.ts";
import { SharedServer, applyEvdev } from "./worker-shared.ts";
import { ShmShareServer, type ShmInfo } from "./shm.ts";
import { VirglGpuBackend, type GpuInit, type GpuLink, type GpuReply, type GpuRequest } from "./gl-gpu.ts";
import { SnapshotCommitError, awakeTimeout, receivedSnapshot, sentSnapshot, snapshotTransfer, type KernelSnapshot, type SnapshotHoldDecision, type SnapshotOptions } from "./snapshot.ts";
import { type FromWorker, type ToWorker, type WorkerBootSpec, type WorkerExit, type WorkerPort } from "./worker-protocol.ts";

export interface ServeKernelOptions {
	/** Reads file: URLs (and paths) without fetch; see Platform.readFile. */
	readFile?: Platform["readFile"];
	/** The device kinds the worker builds from specs (the binding's registry). */
	devices?: DeviceRegistry;
	/** Starts the threads of an SMP kernel's other CPUs (Platform.spawnCpu), from this worker. */
	spawnCpu?: Platform["spawnCpu"];
	/** Why spawnCpu cannot work in this worker (Platform.whyNoCpus). */
	whyNoCpus?: Platform["whyNoCpus"];
	/** Starts the profiler's time sampler thread (Platform.spawnSampler), from this worker. */
	spawnSampler?: Platform["spawnSampler"];
}

/** How long the exit waits for saves in flight before it is reported anyway (awake time: awakeTimeout()). */
const EXIT_SAVE_WAIT_MS = 10000;
/**
 * How long the exit waits for snapshots in progress (awake time), whose
 * results go out first: a snapshot with stop ends the kernel before its
 * disks are durable, a commit before its owner has answered. One still
 * open then is answered as failed, still before "exit".
 */
const EXIT_SNAPSHOT_WAIT_MS = 60000;
const awakeDelay = (ms: number) => new Promise<void>((r) => { awakeTimeout(r, ms); });
/** While frame credits wait for a change, how often to look (a timer; it runs at the kernel's next yield). */
const FRAME_POLL_MS = 16;

/**
 * The worker's sound sink. With a sound ring (sound-ring.ts) the PCM and a
 * record of each state change go into it, and the kernel's answer is what
 * the ring's reader reported plus the frames still in the ring. Otherwise it
 * posts each chunk and answers the kernel with the frames queued at the
 * owner's sink, estimated from its latest report.
 */
function soundSink(spec: { rate?: number; chunks: boolean; ring?: SharedArrayBuffer }, post: (msg: FromWorker, transfer?: ArrayBuffer[]) => void): SoundSink & { report(seq: number, frames: number, at: number): void } {
	let seq = 0;
	/** Frames sent in this stream, and after which chunk: [seq, frames sent up to and including it]. */
	let sent = 0;
	let marks: Array<[number, number]> = [];
	let report: { frames: number; at: number; sentThen: number } | null = null;
	const writer = spec.ring ? new SoundRingWriter(spec.ring) : undefined;
	/** State changes so far: numbers the ring's state records and their "sound-state" messages. */
	let states = 0;
	const reset = () => { sent = 0; marks = []; report = null; writer?.resetQueued(); };
	return {
		rate: spec.rate,
		onState: (state, event) => {
			if (event === "start" || event === "prepare" || event === "close") reset();
			const n = states = (states + 1) & 0x7fffffff;
			// The record first: the owner takes a message without one in the ring for one that did not fit.
			writer?.writeEvent(n, event);
			post({ t: "sound-state", state, event, n });
		},
		onChunk: writer ? (chunk: SoundChunk): number => {
			const woke = writer.write(++seq, chunk.format, chunk.data);
			if (spec.chunks && woke) post({ t: "sound-wake" });
			return writer.queuedFrames();
		} : spec.chunks ? (chunk: SoundChunk): number => {
			const n = ++seq;
			post({ t: "sound-chunk", seq: n, format: chunk.format, data: chunk.data }, [chunk.data.buffer as ArrayBuffer]);
			sent += chunk.frames;
			marks.push([n, sent]);
			if (marks.length > 256) marks.shift();
			// Unanswered chunks are still on their way to the sink; what it reported has played down since.
			if (!report) return sent;
			const played = (sharedNow() - report.at) * chunk.format.rate / 1000;
			return Math.max(0, report.frames - played) + (sent - report.sentThen);
		} : undefined,
		report: (s, frames, at) => {
			if (writer) return;
			const i = marks.findIndex(([m]) => m === s);
			if (i < 0) return; // from an earlier stream
			report = { frames, at, sentThen: marks[i]![1] };
			marks = marks.slice(i + 1);
		},
	};
}

/** An ExitResult whose error survives structured clone. */
function cloneableExit(res: ExitResult): WorkerExit {
	const { error } = res;
	const out: WorkerExit = { code: res.code, reason: res.reason, kind: res.kind };
	if (error !== undefined) out.error = error instanceof Error ? error : String(error);
	return out;
}

/** Serve one kernel over `port`, for as long as the worker lives. */
export function serveKernel(port: WorkerPort, options: ServeKernelOptions = {}): void {
	let instance: KernelInstance | undefined;
	let booting = false;
	const abort = new AbortController();
	const post = (msg: FromWorker, transfer?: ArrayBuffer[]) => port.post(msg, transfer);

	// virtio-gpu 3D: the renderer runs on the owner (gl-gpu.ts); commands go
	// there as "gpu" messages (posted from inside the notify import), the
	// guest's first 3D use asks it to load with "gpu-start", its capsets come
	// in "gpu-init" once it is up and answers in "gpu-reply".
	let gpuInitDone!: (init: GpuInit) => void, gpuInitFail!: (e: Error) => void;
	const gpuInit = new Promise<GpuInit>((res, rej) => ((gpuInitDone = res), (gpuInitFail = rej)));
	gpuInit.catch(() => {});
	const gpuReplies = new Map<number, (r: GpuReply) => void>();
	let gpuRid = 0;
	const gpuTransfer = (req: GpuRequest) => (req.data ? [req.data.buffer as ArrayBuffer] : undefined);
	const gpuLink: GpuLink = {
		init: gpuInit,
		call: (req) => new Promise<GpuReply>((resolve) => {
			const rid = ++gpuRid;
			gpuReplies.set(rid, resolve);
			post({ t: "gpu", req, rid }, gpuTransfer(req));
		}),
		post: (req) => post({ t: "gpu", req }, gpuTransfer(req)),
		start: () => post({ t: "gpu-start" }),
		reset: () => post({ t: "gpu-reset" }),
	};

	// Console output in one message per burst (the kernel writes in small pieces).
	let pending: Uint8Array[] = [];
	let scheduled = false;
	const flush = () => {
		scheduled = false;
		if (!pending.length) return;
		const chunks = pending;
		pending = [];
		if (chunks.length === 1) {
			post({ t: "output", bytes: chunks[0]! });
			return;
		}
		const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
		let at = 0;
		for (const c of chunks) {
			bytes.set(c, at);
			at += c.length;
		}
		post({ t: "output", bytes }, [bytes.buffer]);
	};
	// vsock packets from the guest: posted from inside the import once a
	// window's worth waits (the microtask runs only when the kernel suspends).
	let vsockOut: Uint8Array[] = [];
	let vsockBytes = 0;
	const flushVsock = () => {
		const packets = vsockOut;
		vsockOut = [];
		vsockBytes = 0;
		if (packets.length) post({ t: "vsock", packets }, packets.map((p) => p.buffer as ArrayBuffer));
	};
	// The owner's packets delivered to the kernel, for a commit to check that none is on the way
	// (a snapshot with host file systems, whose 9p servers run on the owner).
	let vsockIn = 0;
	const deliverVsock = (kernel: Kernel, pkt: Uint8Array) => {
		vsockIn++;
		kernel.vsock.deliver(pkt);
	};
	const onVsockPacket = (pkt: Uint8Array) => {
		vsockBytes += pkt.length;
		if (vsockOut.push(pkt) === 1) queueMicrotask(flushVsock);
		if (vsockBytes >= 65536 || vsockOut.length >= 64) flushVsock();
	};

	const onOutput = (bytes: Uint8Array) => {
		pending.push(bytes);
		if (!scheduled) {
			scheduled = true;
			queueMicrotask(flush);
		}
	};

	/** Snapshots in progress, by id: each is answered ("snapshot-result") before "exit". */
	const snapshots = new Map<number, Promise<void>>();
	/** snapshot({ commit }) held at the consistent point: the owner's verdict awaited, by id. */
	const commits = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
	/** snapshot({ commit, hold }) committed: the owner's "snapshot-release" awaited, or one that came first, by id. */
	const holds = new Map<number, { decide?: (d: SnapshotHoldDecision) => void; early?: SnapshotHoldDecision }>();
	/** Answer snapshot `msg.id` once (a result that cannot be posted, such as a failed transfer, is answered as an error). */
	const answer = (msg: Extract<FromWorker, { t: "snapshot-result" }>, transfer?: ArrayBuffer[]) => {
		if (!snapshots.delete(msg.id)) return;
		try {
			post(msg, transfer);
		} catch (e) {
			post({ t: "snapshot-result", id: msg.id, ok: false, error: `snapshot: the result could not be posted: ${(e as Error)?.message ?? e}` });
		}
	};
	/** Sync requests not answered yet: answered false at exit (no flush confirmed them). */
	const pendingSyncs = new Set<number>();
	/** spec index -> the built disk, and the specs' kinds. */
	let byIndex = new Map<number, BlockDevice>();
	let kinds: string[] = [];
	const disks = (): DiskState[] => [...byIndex].map(([i, d]) => diskState(d, i, kinds[i] ?? "?"));

	// The display size the owner last sent, and the frame credits waiting.
	let displaySize: boolean | DisplaySize = false;
	let sound: ReturnType<typeof soundSink> | undefined;
	let shared: SharedServer | undefined;
	/** kwshm reads in place on the owner's thread (a shared kernel memory with the shared transport). */
	let shmShare: ShmShareServer | undefined;
	const wants: Array<{ id: number; buf?: ArrayBuffer; now: boolean }> = [];
	let spare: ArrayBuffer | undefined;
	/** idles + yields and the display's attach count when the last frame was sent. */
	let sentRan = -1, sentGen = -1;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	const ran = (vm: KernelInstance) => vm.kernel.stats.idles + vm.kernel.stats.yields;
	const gen = (vm: KernelInstance) => vm.kernel.display.stats.attaches + vm.kernel.display.stats.detaches;
	/**
	 * Answer credit `i` if it is due: a frame, "unchanged" (data null; only
	 * a fresh request gets that) or "detached" (mode null).
	 */
	const sendFrame = (vm: KernelInstance, i: number): boolean => {
		const d = vm.kernel.display;
		const mode: DisplayMode | null = d.mode;
		const changed = ran(vm) !== sentRan || gen(vm) !== sentGen;
		const w = wants[i]!;
		if (!w.now && mode && !changed) return false;
		wants.splice(i, 1);
		if (w.buf) spare = w.buf;
		const px = mode ? d.pixels() : null;
		if (!mode || !px || !changed) {
			post({ t: "frame", id: w.id, mode, data: null });
			return true;
		}
		const row = mode.width * 4, n = row * mode.height;
		const buf = spare && spare.byteLength >= n ? spare : new ArrayBuffer(n);
		spare = undefined;
		const data = new Uint8Array(buf, 0, n);
		if (mode.stride === row) data.set(px.subarray(0, n));
		else for (let y = 0; y < mode.height; y++) data.set(px.subarray(y * mode.stride, y * mode.stride + row), y * row);
		sentRan = ran(vm);
		sentGen = gen(vm);
		post({ t: "frame", id: w.id, mode, data }, [buf]);
		return true;
	};
	const serveFrames = () => {
		const vm = instance;
		if (!vm) return;
		// Fresh requests (readFrame) now, a new frame if there is one; then one frame per change.
		for (let i = 0; i < wants.length;) if (!wants[i]!.now || !sendFrame(vm, i)) i++;
		while (wants.length && sendFrame(vm, 0));
		if (wants.length && pollTimer === undefined) pollTimer = setInterval(() => serveFrames(), FRAME_POLL_MS);
		else if (!wants.length && pollTimer !== undefined) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	};

	const boot = async (spec: WorkerBootSpec) => {
		let vm: KernelInstance;
		kinds = (spec.disks ?? []).map((d) => d.kind);
		displaySize = spec.display ?? false;
		if (spec.sound) sound = soundSink(spec.sound, post);
		if (spec.shared) shared = new SharedServer(spec.shared, post, (msg) => post({ t: "log", msg }));
		try {
			vm = await createKernelOn({
				defaultKernel: () => { throw new BootError("boot", "the worker was not told where the kernel is"); },
				readFile: options.readFile,
				devices: options.devices,
				spawnCpu: options.spawnCpu,
				whyNoCpus: options.whyNoCpus,
				spawnSampler: options.spawnSampler,
			}, {
				disks: spec.disks,
				distro: spec.distro,
				net: spec.net,
				onDiskError: (index, err) => {
					const e = err as Error | undefined;
					post({ t: "disk-error", index, error: { name: e?.name ?? "Error", message: e?.message ?? String(err), stack: e?.stack } });
				},
				kernel: spec.kernel,
				initrd: spec.initrd,
				cmdline: spec.cmdline,
				memoryMiB: spec.memoryMiB,
				memoryFallbackMiB: spec.memoryFallbackMiB,
				memory64: spec.memory64,
				jit: spec.jit,
				cpus: spec.cpus,
				consoleRing: spec.console,
				flushOutput: flush,
				consoleSize: spec.consoleSize,
				restore: spec.restore && receivedSnapshot(spec.restore),
				profile: spec.profile,
				// The owner sends the size its display function returns; the kernel asks at the first open.
				display: typeof displaySize === "object" ? () => displaySize as DisplaySize : displaySize,
				onDisplay: spec.display ? (mode) => {
					shared?.onMode(mode); // a new frame buffer goes first
					post({ t: "display", mode });
				} : undefined,
				onInput: spec.display ? (s) => post({ t: "input-state", mask: (s.keyboard ? 1 : 0) | (s.mouse ? 2 : 0) | (s.tablet ? 4 : 0) }) : undefined,
				sound: sound ?? false,
				// The protocol (VsockHost) runs on the owner; this side passes the packets.
				vsock: spec.vsock ? { raw: { onPacket: onVsockPacket, onInit: (guestCid, rxMax) => post({ t: "vsock-ready", guestCid, rxMax }), keep: spec.vsockKeep } } : false,
				shm: !!spec.shm,
				gpu: !!spec.gpu,
				gpuBackend: spec.gpu === "virgl" ? new VirglGpuBackend(gpuLink, (msg) => post({ t: "log", msg })) : undefined,
				onOutput,
				log: (msg) => post({ t: "log", msg }),
				onProgress: (p) => post({ t: "progress", p }),
				signal: abort.signal,
			});
		} catch (e) {
			flush();
			const stage = e instanceof BootError ? e.stage : "boot";
			const message = (e as Error)?.message ?? String(e);
			post({ t: "boot-error", stage, message: stage === "support" ? `in the kernel worker: ${message}` : message });
			return;
		}
		instance = vm;
		const shmDev = vm.kernel.shm;
		if (spec.shm) {
			// The API (ShmClient) is the owner's; announcements go there (posted from inside the import).
			shmDev.onAttach = (info) => post({ t: "shm-attach", info });
			shmDev.onDetach = (id) => post({ t: "shm-detach", id });
			// The owner can hold the kernel's memory itself: it then reads in place (shm.ts, at the top).
			const mem = vm.kernel.memory.buffer;
			if (shared && shmDev.enabled && typeof SharedArrayBuffer === "function" && mem instanceof SharedArrayBuffer) {
				shmShare = new ShmShareServer(shmDev, (msg) => post({ t: "log", msg }));
				post({ t: "shm-share", memory: mem, table: shmShare.table });
			}
		}
		shared?.attach({
			kernel: vm.kernel, write: (bytes) => vm.write(bytes), resize: (cols, rows) => vm.resize(cols, rows), evdev: vm.evdev,
			vsock: spec.vsock ? (pkt) => deliverVsock(vm.kernel, pkt) : undefined,
			shmRead: spec.shm ? (seq, id, offset, length) => {
				// Inside the clock import (or a kick): a copy now, the bytes transferred.
				let data: Uint8Array;
				try {
					data = shmDev.read(id, offset, length);
				} catch (e) {
					post({ t: "shm-read", seq, ok: false, code: (e as { code?: string })?.code ?? "EIO", message: (e as Error)?.message ?? String(e) });
					return;
				}
				post({ t: "shm-read", seq, ok: true, data }, [data.buffer as ArrayBuffer]);
			} : undefined,
		});
		const skippedAt = new Set(vm.skippedDisks.map((s) => s.index));
		const built = vm.kernel.block.disks.slice(vm.distro ? 1 : 0); // the distro is not one of `disks`
		byIndex = new Map(kinds.map((_, i) => i).filter((i) => !skippedAt.has(i)).map((i, n) => [i, built[n]!]));
		// The owner keeps its own output stream; drain this one so it holds nothing.
		void vm.output.pipeTo(new WritableStream()).catch(() => {});
		const stats = (): InstanceStats => (spec.compileMs === undefined ? vm.stats() : { ...vm.stats(), compileMs: spec.compileMs });
		post({ t: "started", cmdline: vm.cmdline, memoryMiB: vm.memoryMiB, memory64: vm.memory64, stats: stats(), disks: disks(), skipped: vm.skippedDisks, distro: vm.distro });
		const timer = setInterval(() => post({ t: "stats", stats: stats(), disks: disks() }), spec.statsIntervalMs);
		void vm.exited.then(async (res) => {
			clearInterval(timer);
			clearInterval(pollTimer);
			shared?.detach();
			flush();
			flushVsock();
			// The owner ends the worker when it gets "exit": let every snapshot's result go out
			// first (one with stop or a commit ends the kernel), then saves in flight commit.
			// Both waits count awake time, so the timers of a worker frozen in a background
			// tab, firing late on its return, do not beat the IndexedDB results it waits for.
			if (snapshots.size) await Promise.race([Promise.all(snapshots.values()), awakeDelay(EXIT_SNAPSHOT_WAIT_MS)]);
			for (const id of [...snapshots.keys()])
				answer({ t: "snapshot-result", id, ok: false, error: "snapshot: the kernel ended before its disks became durable" });
			await Promise.race([vm.settled(), awakeDelay(EXIT_SAVE_WAIT_MS)]);
			for (const id of pendingSyncs) post({ t: "synced", id, ok: false });
			pendingSyncs.clear();
			const result = cloneableExit(res);
			const profile = await vm.profile();
			try {
				post({ t: "exit", result, stats: stats(), disks: disks(), profile });
			} catch {
				post({ t: "exit", result: { ...result, error: String(result.error) }, stats: stats(), disks: disks(), profile });
			}
		});
	};

	const diskOp = async (index: number, op: "detach" | "export"): Promise<unknown> => {
		const d = byIndex.get(index);
		if (!(d instanceof CowDisk)) throw new Error(`disk ${index} is ${d ? "not a CowDisk" : "not attached"}`);
		if (op === "export") return d.exportParts();
		d.detach();
		await d.saving?.catch(() => {});
		await d.store?.close?.();
		return undefined;
	};

	port.listen((msg: ToWorker) => {
		switch (msg.t) {
		case "boot":
			if (!booting) {
				booting = true;
				void boot(msg.spec);
			}
			break;
		case "input":
			instance?.write(msg.data);
			break;
		case "gpu-init":
			if (msg.init) gpuInitDone(msg.init);
			else gpuInitFail(new Error(msg.error ?? "no renderer"));
			break;
		case "gpu-reply": {
			const done = gpuReplies.get(msg.rid);
			gpuReplies.delete(msg.rid);
			done?.(msg.reply);
			break;
		}
		case "resize":
			instance?.resize(msg.cols, msg.rows);
			break;
		case "sync":
			if (instance) {
				const { id } = msg;
				pendingSyncs.add(id);
				void instance.sync({ timeout: msg.timeout }).then((ok) => {
					if (pendingSyncs.delete(id)) post({ t: "synced", id, ok });
				});
			} else post({ t: "synced", id: msg.id, ok: true });
			break;
		case "disk": {
			const { id } = msg;
			diskOp(msg.index, msg.op).then(
				(value) => post({ t: "disk-result", id, ok: true, value }),
				(e) => post({ t: "disk-result", id, ok: false, error: (e as Error)?.message ?? String(e) }));
			break;
		}
		case "snapshot": {
			const { id } = msg;
			if (!instance) {
				post({ t: "snapshot-result", id, ok: false, error: "snapshot: the kernel is not running" });
				break;
			}
			if (snapshots.has(id)) break;
			// With commit: the snapshot goes to the owner (memory transferred) while the
			// kernel waits at its consistent point, and the owner's verdict ends the wait.
			const commit = msg.commit ? (snap: KernelSnapshot, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
				commits.set(id, { resolve, reject });
				signal.addEventListener("abort", () => {
					commits.delete(id);
					reject(signal.reason as Error);
				}, { once: true });
				try {
					post({ t: "snapshot-held", id, snapshot: sentSnapshot(snap), vsockIn }, snapshotTransfer(snap.memory));
				} catch (e) {
					commits.delete(id);
					reject(new Error(`the snapshot could not be posted: ${(e as Error)?.message ?? e}`));
				}
			}) : undefined;
			// With hold: after the commit the kernel waits for the owner's "snapshot-release" (no timeout).
			const hold = commit && msg.hold ? (_snap: KernelSnapshot, signal: AbortSignal) => new Promise<SnapshotHoldDecision>((resolve) => {
				const h = holds.get(id);
				if (h?.early) {
					holds.delete(id);
					resolve(h.early);
					return;
				}
				holds.set(id, { decide: resolve });
				signal.addEventListener("abort", () => holds.delete(id), { once: true });
			}) : undefined;
			const opts: SnapshotOptions = commit ? { commit, commitTimeoutMs: msg.commitTimeoutMs, ...(hold ? { hold } : {}) } : { stop: msg.stop };
			if (msg.dropCaches !== undefined) opts.dropCaches = msg.dropCaches;
			snapshots.set(id, instance.snapshot(opts).then(
				(snapshot) => commit ? answer({ t: "snapshot-result", id, ok: true }) : answer({ t: "snapshot-result", id, ok: true, snapshot: sentSnapshot(snapshot) }, snapshotTransfer(snapshot.memory)),
				(e) => answer({
					t: "snapshot-result", id, ok: false, error: (e as Error)?.message ?? String(e),
					...(e instanceof SnapshotCommitError ? { commitFailed: true, timedOut: e.timedOut } : {}),
				})));
			break;
		}
		case "snapshot-commit": {
			const c = commits.get(msg.id);
			commits.delete(msg.id);
			if (msg.ok) c?.resolve();
			else c?.reject(new Error(msg.error ?? "the commit failed"));
			break;
		}
		case "snapshot-release": {
			if (!snapshots.has(msg.id)) break; // answered already (the kernel ended)
			const how: SnapshotHoldDecision = msg.stop ? "stop" : "continue";
			const h = holds.get(msg.id);
			if (h?.decide) {
				holds.delete(msg.id);
				h.decide(how);
			} else holds.set(msg.id, { early: how }); // before the kernel asked (its microtasks after the commit)
			break;
		}
		case "profile": {
			const { id } = msg;
			if (!instance) post({ t: "profile-result", id });
			else void instance.profile().then((report) => post({ t: "profile-result", id, report }));
			break;
		}
		case "stop":
			if (instance) instance.stop({ code: msg.code, reason: msg.reason });
			else abort.abort();
			break;
		case "abort":
			abort.abort();
			break;
		case "evdev": {
			const ev = instance?.evdev;
			if (!ev) break;
			const o = msg.ops;
			for (let i = 0; i + 2 < o.length; i += 3) applyEvdev(ev, o[i]!, o[i + 1]!, o[i + 2]!);
			break;
		}
		case "kick":
			shared?.kicked();
			break;
		case "display-size":
			displaySize = msg.size;
			// The kernel's display may have booted with `true`: from now on it asks for this size.
			if (instance && !instance.kernel.result) {
				instance.kernel.display.setSize(() => displaySize as DisplaySize);
				if (msg.hotplug) instance.kernel.gpu?.displayChanged();
			}
			break;
		case "frame-want":
			if (!instance || instance.kernel.result) post({ t: "frame", id: msg.id, mode: null, data: null });
			else {
				wants.push({ id: msg.id, buf: msg.buf, now: !!msg.now });
				serveFrames();
			}
			break;
		case "sound-queued":
			sound?.report(msg.seq, msg.frames, msg.at);
			break;
		case "vsock":
			if (instance) for (const p of msg.packets) deliverVsock(instance.kernel, p);
			shared?.vsockAck();
			break;
		case "shm": {
			// Runs here, where the kernel's memory is: a read copies once and transfers the bytes.
			const { rid } = msg;
			const dev = instance?.kernel.shm;
			if (!dev) {
				post({ t: "shm-result", rid, ok: false, code: "ENODEV", message: `${msg.call.op}: the kernel is not running` });
				break;
			}
			// Reads the owner put in the ring before this message go first.
			shared?.drainShm();
			dev.run(msg.call).then(
				(value) => {
					// An export's info: with its page runs when the owner reads in place.
					const place = shmShare && value && typeof value === "object" && !(value instanceof Uint8Array) ? shmShare.place((value as ShmInfo).id) : undefined;
					post({ t: "shm-result", rid, ok: true, value, ...(place && { place }) }, value instanceof Uint8Array ? [value.buffer as ArrayBuffer] : undefined);
				},
				(e: Error & { code?: string }) => post({ t: "shm-result", rid, ok: false, code: e?.code ?? "EIO", message: e?.message ?? String(e) }));
			break;
		}
		}
	});
	post({ t: "ready", jspi: typeof WebAssembly === "object" && typeof WebAssembly.Suspending === "function" && typeof WebAssembly.promising === "function" });
}
