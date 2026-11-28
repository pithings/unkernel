// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Messages between the thread that owns a WorkerKernel (worker-host.ts) and
// the worker that runs the kernel (worker-serve.ts). Universal: the same
// messages go over Node's worker_threads and (later) a web Worker.
//
// Every message is a plain object tagged with `t` and must survive
// structured clone. With the shared transport (worker-shared.ts) console
// and evdev input and frames go through SharedArrayBuffers instead. Each side ignores tags it does not know, so a device is
// added with new tags (frames, evdev events, PCM chunks, block requests,
// Ethernet frames) and new fields in WorkerBootSpec, without touching the
// existing ones.

import type { DiskSpec, DiskState, NetSpec, SkippedDisk } from "./devices.ts";
import type { DistroInfo } from "./distro.ts";
import type { DisplayMode, DisplaySize } from "./display.ts";
import type { SoundEvent, SoundFormat, SoundState } from "./sound.ts";
import type { ShmCall, ShmCallResult, ShmInfo, ShmPlace } from "./shm.ts";
import type { GpuInit, GpuReply, GpuRequest } from "./gl-gpu.ts";
import type { ExitKind } from "./kernel.ts";
import type { BootProgress, InstanceStats } from "./instance.ts";
import type { KernelSnapshot } from "./snapshot.ts";
import type { ProfileOptions, ProfileReport } from "./profile.ts";

/**
 * A kernel or initrd source that crosses a thread: an absolute URL (the
 * worker fetches it, or reads it from disk on Node: file: URLs), bytes
 * (transferred), or, for the kernel, a WebAssembly.Module (it survives
 * postMessage within one process).
 */
export type WorkerSource = string | Uint8Array;

/** Everything the worker needs to boot. It loads and compiles the kernel itself. */
export interface WorkerBootSpec {
	kernel: WorkerSource | WebAssembly.Module;
	/** undefined = the module's bundled initramfs (if any), null = none. */
	initrd: WorkerSource | null | undefined;
	cmdline?: string;
	memoryMiB: number;
	memoryFallbackMiB?: number[];
	memory64?: boolean;
	jit?: boolean;
	/** CPUs for an SMP kernel (CreateKernelOptions.cpus); the worker starts their threads itself. */
	cpus?: number;
	consoleSize?: { cols: number; rows: number };
	/** Disk and network specs (devices.ts), built by the worker's registry. */
	disks?: DiskSpec[];
	/** The distro image as a read-only disk spec (CreateKernelOptions.distro), the first disk. */
	distro?: DiskSpec;
	net?: NetSpec;
	/** Milliseconds between stats snapshots while running. */
	statsIntervalMs: number;
	/** Milliseconds the owner took to load and compile the kernel, when it did (the worker's stats report it). */
	compileMs?: number;
	/**
	 * The display: true (640x480) or the size wanted. For a `display`
	 * function the owner calls it and sends the result here and in
	 * "display-size" messages; the worker answers the kernel from the latest.
	 */
	display?: boolean | DisplaySize;
	/** A sound card: the sink's preferred rate, whether the owner wants "sound-wake"/"sound-chunk", and an optional shared PCM ring. */
	sound?: false | { rate?: number; chunks: boolean; ring?: SharedArrayBuffer };
	/** A vsock device: the worker's kernel passes packets ("vsock" both ways); the protocol runs on the owner. */
	vsock?: boolean;
	/** kwshm: the worker's kernel offers it and runs the owner's "shm" calls (the copies happen there). */
	shm?: boolean;
	/**
	 * virtio-gpu (gpu option): the device model runs in the worker, next to
	 * the kernel; 2D frames come as the display's. "virgl": with 3D, whose
	 * renderer is on the owner (gl-gpu.ts): the worker's VirglGpuBackend
	 * sends "gpu-start" (the guest's first 3D use) and "gpu" requests, and
	 * gets "gpu-init" (once the renderer is up) and "gpu-reply".
	 */
	gpu?: boolean | "virgl";
	/**
	 * The shared transport's control block (worker-shared.ts): console and
	 * evdev input and frame requests go through it instead of "input",
	 * "evdev" and "frame-want" messages. Absent: messages only.
	 */
	shared?: SharedArrayBuffer;
	/**
	 * With the shared transport and more than one CPU: the console ring
	 * (console-ring.ts) the owner reads; every CPU writes its console output
	 * there instead of "output" messages.
	 */
	console?: SharedArrayBuffer;
	/**
	 * Resume this snapshot instead of booting (CreateKernelOptions.restore);
	 * its memory is transferred. The worker builds the disks and devices from
	 * the spec and checks them against it, as inline.
	 */
	restore?: KernelSnapshot;
	/**
	 * The vsock connections (`guestPort:hostPort`) the restored kernel keeps:
	 * those of the host file systems the owner serves again (MountTable.restore()).
	 */
	vsockKeep?: string[];
	/** Sample guest pcs (CreateKernelOptions.profile); the worker starts the sampler thread itself. */
	profile?: ProfileOptions;
}

/**
 * Evdev calls in an "evdev" message: flat triples (op, a, b), applied in
 * order to the worker's InputHost. Booleans are 1 or 0.
 */
export const EVDEV_OP = { key: 0, button: 1, move: 2, wheel: 3, moveTo: 4, tabletButton: 5, tabletWheel: 6, releaseAll: 7 } as const;

/** An ExitResult with `error` reduced to something structured clone accepts. */
export interface WorkerExit {
	code: number;
	reason: string;
	kind: ExitKind;
	error?: unknown;
}

/** Owner -> worker. */
export type ToWorker =
	| { t: "boot"; spec: WorkerBootSpec }
	| { t: "input"; data: Uint8Array | string }
	| { t: "resize"; cols: number; rows: number }
	| { t: "sync"; id: number; timeout?: number }
	| { t: "stop"; code?: number; reason?: string }
	/** The owner's AbortSignal fired: abort the downloads, or stop the kernel once booted. */
	| { t: "abort" }
	/**
	 * An operation on disk `index` (built order), answered by "disk-result":
	 * "detach" stops its saves, waits for the one in flight and closes its
	 * store (before the owner replaces the store); "export" returns its
	 * content as kwsparse parts (CowDisk.exportParts(): Blobs).
	 */
	| { t: "disk"; id: number; index: number; op: "detach" | "export" }
	/** Evdev calls, in order (EVDEV_OP triples). */
	| { t: "evdev"; ops: number[] }
	/** The display size wanted now (kwfb asks at the next first open); `hotplug`: virtio-gpu offers it (updateDisplaySize()). */
	| { t: "display-size"; size: DisplaySize; hotplug?: boolean }
	/**
	 * A frame credit: send one "frame" (id = this id) once the picture may
	 * have changed (at once with `now`, even if unchanged). `buf` is a
	 * returned frame buffer for the worker to reuse.
	 */
	| { t: "frame-want"; id: number; buf?: ArrayBuffer; now?: boolean }
	/**
	 * The sink's answer to "sound-chunk" `seq`: frames queued after it, at
	 * `at` (performance.timeOrigin + performance.now() on the owner).
	 */
	| { t: "sound-queued"; seq: number; frames: number; at: number }
	/** Shared transport: the owner wrote into the control block while the kernel waited idle. */
	| { t: "kick" }
	/** vsock packets for the guest (header and payload each; transferred), in order; the shared transport puts them in its ring instead (worker-shared.ts). */
	| { t: "vsock"; packets: Uint8Array[] }
	/** A kwshm call (shm.ts) for the worker's ShmDevice; answered by "shm-result" with the same rid. */
	| { t: "shm"; rid: number; call: ShmCall }
	/** virtio-gpu 3D: the renderer's capsets and formats (or why there is none). */
	| { t: "gpu-init"; init?: GpuInit; error?: string }
	/** virtio-gpu 3D: the answer to a "gpu" request with that rid (a readback's bytes transferred). */
	| { t: "gpu-reply"; rid: number; reply: GpuReply }
	/**
	 * Save the machine (KernelInstance.snapshot()); answered by
	 * "snapshot-result" with the same id. With `commit` (SnapshotOptions)
	 * the worker first posts "snapshot-held" and keeps the kernel at its
	 * consistent point until "snapshot-commit" (or `commitTimeoutMs`); with
	 * `hold` also, after a successful commit, until "snapshot-release" (no
	 * timeout: a page frozen for hours meanwhile changes nothing).
	 */
	| { t: "snapshot"; id: number; stop?: boolean; commit?: boolean; commitTimeoutMs?: number; hold?: boolean; dropCaches?: boolean }
	/** The owner's commit of "snapshot-held" `id` succeeded (the kernel then stops, or with `hold` waits on) or failed (it goes on). */
	| { t: "snapshot-commit"; id: number; ok: boolean; error?: string }
	/** The owner's hold decision for snapshot `id` (after a successful commit): stop at the snapshot, or go on. */
	| { t: "snapshot-release"; id: number; stop: boolean }
	/** The profile so far (KernelHandle.profile()); answered by "profile-result" with the same id. */
	| { t: "profile"; id: number };

/** Worker -> owner. Output, log and progress keep their order relative to "started" and "exit". */
export type FromWorker =
	/** First message: the worker runs (a web binding revokes its Blob URL then), and whether it has JSPI. */
	| { t: "ready"; jspi: boolean }
	| { t: "output"; bytes: Uint8Array }
	| { t: "log"; msg: string }
	| { t: "progress"; p: BootProgress }
	| { t: "started"; cmdline: string; memoryMiB: number; memory64: boolean; stats: InstanceStats; disks: DiskState[]; skipped: SkippedDisk[]; distro?: DistroInfo }
	| { t: "boot-error"; stage: string; message: string }
	| { t: "stats"; stats: InstanceStats; disks: DiskState[] }
	| { t: "synced"; id: number; ok: boolean }
	/** A disk failed to save a flush (CowDisk onError). */
	| { t: "disk-error"; index: number; error: { name: string; message: string; stack?: string } }
	| { t: "disk-result"; id: number; ok: true; value?: unknown } | { t: "disk-result"; id: number; ok: false; error: string }
	/** A program opened the display or changed its mode, or the last one closed it (null). */
	| { t: "display"; mode: DisplayMode | null }
	/** The evdev open mask changed (InputHost.mask). */
	| { t: "input-state"; mask: number }
	/**
	 * The answer to "frame-want" `id`: the mode, and the pixels as packed
	 * XRGB8888 rows (width * 4 bytes; transferred), or null when the picture
	 * did not change since the last frame sent or no program has the display.
	 */
	| { t: "frame"; id: number; mode: DisplayMode | null; data: Uint8Array | null }
	/**
	 * Shared transport: the frame triple buffer for the mode in the next
	 * "display" message (`cap` bytes per slot), or null when none could be
	 * made (frames then go by "frame-want" and "frame").
	 */
	| { t: "frame-buffer"; buffer: SharedArrayBuffer | null; cap: number }
	/** Shared transport: the answer to FRAME_NOW `id` (and earlier ones); the frame is in the buffer. */
	| { t: "frame-ready"; id: number; mode: DisplayMode | null }
	| { t: "sound-state"; state: SoundState; event: SoundEvent; n: number }
	/** PCM the guest played (transferred); answered by "sound-queued" (throttled). */
	| { t: "sound-chunk"; seq: number; format: SoundFormat; data: Uint8Array }
	/** Sound ring: it became non-empty; the owner drains it into onChunk (and onState, in the ring's order). */
	| { t: "sound-wake" }
	/** vsock packets from the guest (transferred), in order; posted from inside the import once 64 KiB or 64 packets are waiting, else per microtask. */
	| { t: "vsock"; packets: Uint8Array[] }
	/** virtio-gpu 3D: a command for the owner's renderer (data transferred), answered by "gpu-reply" when it has a rid. */
	| { t: "gpu"; req: GpuRequest; rid?: number }
	/** virtio-gpu 3D: the guest's first 3D use: load the renderer if it is not loaded or loading ("gpu-init" follows). */
	| { t: "gpu-start" }
	/** virtio-gpu 3D: the driver reset the device. */
	| { t: "gpu-reset" }
	/** The kernel's kwvsock started (VsockDevice onInit). */
	| { t: "vsock-ready"; guestCid: number; rxMax: number }
	/**
	 * The answer to "shm": the result (read's bytes transferred), or the
	 * ShmError's code and message. After "shm-share", an info result also
	 * carries the export's page runs for the owner (`place`; absent when no
	 * slot was free).
	 */
	| { t: "shm-result"; rid: number; ok: true; value: ShmCallResult; place?: ShmPlace } | { t: "shm-result"; rid: number; ok: false; code: string; message: string }
	/** Shared transport: the answer to a read from the control block's shm ring (worker-shared.ts), bytes transferred. */
	| { t: "shm-read"; seq: number; ok: true; data: Uint8Array } | { t: "shm-read"; seq: number; ok: false; code: string; message: string }
	/**
	 * Shared transport with a shared kernel memory (an SMP kernel), before
	 * "started": that memory and ShmShareServer's slot table, for reads in
	 * place on the owner's thread (shm.ts, ShmInPlace).
	 */
	| { t: "shm-share"; memory: SharedArrayBuffer; table: SharedArrayBuffer }
	/** kwshm announced an export's page list (new, or refreshed). */
	| { t: "shm-attach"; info: ShmInfo }
	/** kwshm withdrew an export. */
	| { t: "shm-detach"; id: number }
	/**
	 * A "snapshot" with `commit` at the kernel's consistent point, its disks
	 * durable: the snapshot (memory transferred) for the owner to commit; the
	 * kernel waits for "snapshot-commit". `vsockIn`: the vsock packets the
	 * worker had delivered to the kernel by then, of those the owner sent.
	 */
	| { t: "snapshot-held"; id: number; snapshot: KernelSnapshot; vsockIn: number }
	/**
	 * The answer to "snapshot": the snapshot (its memory transferred; none
	 * after "snapshot-held", whose snapshot it confirms), or why it failed
	 * (`commitFailed`: a SnapshotCommitError, the kernel went on unless it
	 * ended). Always posted before "exit", for every "snapshot" (a snapshot
	 * with stop or a commit ends the kernel).
	 */
	| { t: "snapshot-result"; id: number; ok: true; snapshot?: KernelSnapshot }
	| { t: "snapshot-result"; id: number; ok: false; error: string; commitFailed?: boolean; timedOut?: boolean }
	/** The answer to "profile" (undefined: no profile option, or the kernel had none). */
	| { t: "profile-result"; id: number; report?: ProfileReport }
	/** Sent after every save in flight has settled, so the worker can be ended at once; with the profile option, its last report. */
	| { t: "exit"; result: WorkerExit; stats: InstanceStats; disks: DiskState[]; profile?: ProfileReport };

/** The worker's end of the channel (Node: parentPort; a web Worker: self). */
export interface WorkerPort {
	post(msg: FromWorker, transfer?: ArrayBuffer[]): void;
	listen(handler: (msg: ToWorker) => void): void;
}

/** The owner's end: a started worker running serveKernel(). */
export interface WorkerEndpoint {
	post(msg: ToWorker, transfer?: ArrayBuffer[]): void;
	listen(handlers: {
		message(msg: FromWorker): void;
		/** An uncaught error in the worker. */
		error(err: unknown): void;
		/** The worker thread ended (also after terminate()). */
		exit(): void;
	}): void;
	terminate(): void;
}
