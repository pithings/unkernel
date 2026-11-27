// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// One guest WASI program, in its own worker (the program side of
// wasi-exec.ts). The owner (serveWasiPrograms(), where vm.vsock's VsockHost
// runs) compiles the module once and gives each running program a worker
// of its own (spawned by js/node/wasi.ts, js/web/wasi.ts); the worker's
// entry calls serveWasiProgram() with its port. A "start" message brings
// the compiled module, argv, the environment and the preopened
// directories; the worker instantiates the module with a
// wasi_snapshot_preview1 and calls `_start`. A module importing preview 0
// (`wasi_unstable`, older toolchains) gets the same calls, adapted where
// preview 0 differs (WASI0 below). Sockets are kwwasi's descriptors like
// files: sock_accept, sock_recv, sock_send and sock_shutdown go to it too.
//
// wasi-threads (a module importing wasi.thread-spawn and a shared
// env.memory, exporting wasi_thread_start): every thread is a worker of its
// own, the main one and each that thread-spawn started, all instantiating
// the same module on the owner's shared memory, each with a channel and a
// kwwasi connection of its own (wasi-exec.ts, Program; kwwasi.c, Threads).
// thread-spawn is a request (R_SPAWN) that returns the new thread's tid
// once kwwasi's pthread for it has connected; the owner then starts its
// worker, whose "start" brings `thread`, and it calls
// `wasi_thread_start(tid, arg)`. A thread that returns sends "done";
// proc_exit or a trap in any thread sends "exit", which ends the program.
// Threads need the shared path (the owner refuses them on the other).
//
// WASI imports are synchronous. Those answered here (args, environ,
// clocks, random_get, preopens, proc_exit) are plain functions. The
// realtime and monotonic clocks are the guest's: START brings kwwasi's
// readings, kept as offsets from the host's clock (ProgramClock), so a
// clock call is no request. The CPU-time clocks are this worker's thread's
// CPU time where the engine tells it (Node), else the time since the
// program or thread started; a threaded program's process clock adds the
// other threads', which the owner samples (H_CPU). Those that
// kwwasi does in the guest (files, poll_oneoff on descriptors) are one
// round trip each: the request frame (kwwasi.c's protocol, built here) goes
// to the owner, which writes it to the vsock connection, reads kwwasi's
// REPLY frame and hands its body back. Two ways:
// - Shared (the "start" message brings a `channel`; the owner's choice,
//   where SharedArrayBuffer can be used: Node, isolated pages): the frame
//   is written into the channel (CH_*), and the import spins briefly, then
//   sleeps in Atomics.wait until the owner has written the reply there. The
//   imports are plain functions and `_start` runs to its end inside the
//   "start" message's handler; no JSPI, no message per request.
// - Messages (the fallback, no cross-origin isolation needed): the imports
//   are JSPI Suspending imports, `_start` is called through
//   WebAssembly.promising, the frame goes as a "request" message and the
//   body comes back as "reply".
// One body of code serves both: #call() returns a Reply or a promise of
// one, and then() continues either way.
//
// A program never waits for anything but its own replies: a computation
// runs on this thread without holding up the kernel or the owner, and the
// owner ends it with terminate() wherever it is (kwwasi gone, the machine
// stopped). proc_exit, a return from `_start`, a trap and a failed
// instantiation end with an "exit" message; the stack has unwound and the
// instance is garbage then, so the owner may keep the worker for its next
// program (wasi-exec.ts, WorkerPool).
// Universal: no node: imports, no DOM.

/** @internal kwwasi.c's protocol version and the frames the owner handles. */
export const WASI_PROTOCOL_VERSION = 3;
export const OP_START = 1;
export const OP_REPLY = 2;
export const OP_EXIT = 3;
export const OP_MODULE = 4;
export const OP_DATA = 5;
export const OP_END = 6;
export const OP_THREAD = 7;
/** @internal The token in MODULE and THREAD frames (kwwasi.c TOKEN). */
export const WASI_TOKEN_BYTES = 16;
const R_READ = 16;
const R_PREAD = 17;
const R_WRITE = 18;
const R_PWRITE = 19;
const R_SEEK = 20;
const R_CLOSE = 21;
const R_FSTAT = 22;
const R_FDSTAT = 23;
const R_SETFL = 24;
const R_OPENAT = 25;
const R_STATAT = 26;
const R_READDIR = 27;
const R_MKDIRAT = 28;
const R_UNLINKAT = 29;
const R_RENAMEAT = 30;
const R_READLINKAT = 31;
const R_SYMLINKAT = 32;
const R_FTRUNCATE = 33;
const R_FSYNC = 34;
const R_UTIMENS = 35;
const R_LINKAT = 36;
const R_POLL = 37;
const R_RENUMBER = 38;
const R_ACCEPT = 39;
const R_RECV = 40;
const R_SEND = 41;
const R_SHUTDOWN = 42;
const R_SPAWN = 43;
const R_ALLOCATE = 44;

/** @internal The import modules a program may use: WASI preview 1, and preview 0 (adapted). */
export const WASI_MODULES = ["wasi_snapshot_preview1", "wasi_unstable"];
/**
 * @internal wasi-threads: a module imports this function and a shared
 * memory (WASI_MEMORY), and exports `wasi_thread_start(tid, start_arg)`.
 */
export const WASI_THREAD_SPAWN = { module: "wasi", name: "thread-spawn" } as const;
export const WASI_MEMORY = { module: "env", name: "memory" } as const;

/** The most one read or write asks of kwwasi. */
const MAX_IO = 1 << 20;

/**
 * @internal The shared channel (one growable SharedArrayBuffer per program):
 * Int32 control words, then the frame area at CH_DATA. The worker writes a
 * request frame there, its length to CH_LEN, and bumps CH_REQ; the owner
 * writes the REPLY body (errno, result) over it, its length to CH_LEN, and
 * sets CH_REP to that CH_REQ. CH_SLEEP is never notified (poll_oneoff's
 * sleeps wait on it). CH_CPU0, a BigInt64 index (bytes 32-39): a threaded
 * program's thread's CPU time (us) when it started, as the worker's thread
 * counts it (-1 until the worker wrote it), against which the owner's
 * samples of the worker's CPU time (WasiProgramEndpoint.cpuUsage, the
 * worker's whole life) count.
 */
export const CH_REQ = 0, CH_REP = 1, CH_LEN = 2, CH_SLEEP = 3, CH_CPU0 = 4;
/**
 * @internal A request on the channel that the owner answers itself, never
 * sent to kwwasi (no payload): the CPU time of the program's threads but
 * the caller's (u64 ns), the finished ones' and the running ones' now.
 */
export const H_CPU = 256;
/**
 * @internal A threaded program's CPU words ("start"'s `cpu`, 16 bytes):
 * BigInt64 CPU_DONE, the CPU time of its threads that returned (ns), and
 * Int32 CPU_LIVE, how many of its threads run (the main one too). The owner
 * adds a thread to CPU_LIVE before its worker starts, and on its "done"
 * adds its time to CPU_DONE, then takes it from CPU_LIVE.
 */
export const CPU_DONE = 0, CPU_LIVE = 2, CPU_BYTES = 16;
/**
 * How long a thread reuses the owner's answer to H_CPU (ms) before it asks
 * again: a process clock read while other threads run costs a round trip
 * to the owner and a sample of each of their workers (numbers in
 * .agents/status.md), and a loop of reads does not pay it each time; the
 * other threads' share lags by at most this much each.
 */
const CPU_ASK_MS = 5;
export const CH_DATA = 64;
export const CH_INITIAL = CH_DATA + (256 << 10);
/** kwwasi's MAX_FRAME and a frame header. */
export const CH_MAX = CH_DATA + 8 + (64 << 20);
/** @internal Make room for `bytes` in the frame area (false: more than CH_MAX). */
export function channelRoom(sab: SharedArrayBuffer, bytes: number): boolean {
	const need = CH_DATA + bytes;
	if (need > CH_MAX) return false;
	if (sab.byteLength < need) {
		let size = sab.byteLength;
		while (size < need) size *= 2;
		sab.grow(Math.min(size, CH_MAX));
	}
	return true;
}
/**
 * How long the worker spins on a reply before it sleeps in Atomics.wait
 * (ms). A small request takes kwwasi 40-90 us; waking from Atomics.wait
 * adds tens of us to each (numbers in .agents/status.md).
 */
const SPIN_MS = 0.2;
const pause: (() => void) | undefined = (Atomics as { pause?: () => void }).pause;

type Maybe<T> = T | Promise<T>;
/** f(x), after x settles if it is a promise: one body for the shared (sync) and the message (JSPI) path. */
function then<T, U>(x: Maybe<T>, f: (v: T) => Maybe<U>): Maybe<U> {
	return x instanceof Promise ? x.then(f) : f(x);
}

const originNs = BigInt(Math.round(performance.timeOrigin * 1e6));
/**
 * @internal The host's clock (ns) that the owner and the program workers
 * share: performance.timeOrigin + performance.now(), one clock across
 * Node's threads and a page's workers (.agents/js.md, CPU threads).
 */
export function hostClockNs(): bigint {
	return originNs + BigInt(Math.round(performance.now() * 1e6));
}
/**
 * @internal A program's clocks, from START: the guest's CLOCK_REALTIME
 * and CLOCK_MONOTONIC as offsets from hostClockNs() (kwwasi read them just
 * before it sent START, so they lag the guest's by its delivery), and the
 * host's clock when START came (the process CPU clock where the engine
 * has no thread CPU time).
 */
export interface ProgramClock {
	real: bigint;
	mono: bigint;
	start: bigint;
}
/**
 * This thread's CPU time (us), where the engine tells it: Node's
 * process.threadCpuUsage() (getrusage(RUSAGE_THREAD), so in a worker its
 * own thread's). Browsers have none.
 */
const threadCpuUs: (() => number) | undefined = (() => {
	const p = (globalThis as { process?: { threadCpuUsage?: () => { user: number; system: number } } }).process;
	const f = p?.threadCpuUsage;
	if (typeof f !== "function") return undefined;
	try {
		f.call(p);
	} catch {
		return undefined;
	}
	return () => {
		const u = f.call(p);
		return u.user + u.system;
	};
})();
let nowResNs: bigint | undefined;
/**
 * The realtime and monotonic clocks' resolution: the step performance.now()
 * takes here, sampled once per worker (the median of 8 steps, at most
 * 20 ms of sampling). Browsers coarsen it (to 5 us or 100 us in Chrome by
 * cross-origin isolation, other engines otherwise), Node's follows the
 * OS's monotonic clock; a fixed figure would be wrong somewhere.
 */
function nowResolution(): bigint {
	if (nowResNs === undefined) {
		const steps: number[] = [];
		const t0 = performance.now();
		let last = t0;
		while (steps.length < 8) {
			const t = performance.now();
			if (t !== last) {
				steps.push(t - last);
				last = t;
			}
			if (t - t0 > 20) break;
		}
		steps.sort((a, b) => a - b);
		const ms = steps.length ? steps[steps.length >> 1]! : 20;
		nowResNs = BigInt(Math.max(1, Math.round(ms * 1e6)));
	}
	return nowResNs;
}

// Linux open and at flags with their asm-generic values, which is how they
// cross the connection: kwwasi maps the open flags to its architecture's.
const O_WRONLY = 0x1;
const O_RDWR = 0x2;
const O_CREAT = 0x40;
const O_EXCL = 0x80;
const O_TRUNC = 0x200;
const O_APPEND = 0x400;
const O_NONBLOCK = 0x800;
const O_DSYNC = 0x1000;
const O_SYNC = 0x101000;
const O_DIRECTORY = 0x10000;
const O_NOFOLLOW = 0x20000;
const AT_SYMLINK_NOFOLLOW = 0x100;
const AT_REMOVEDIR = 0x200;
const AT_SYMLINK_FOLLOW = 0x400;

// WASI errno values.
const E = {
	SUCCESS: 0, BADF: 8, FAULT: 21, INVAL: 28, IO: 29, NAMETOOLONG: 37, NOSYS: 52, NOTSUP: 58,
} as const;
// Linux errno (asm-generic, which arm64 uses) -> WASI errno. One with no
// WASI counterpart (ENOTBLK, ENODATA, EREMOTEIO, ...) is EIO.
const LINUX_TO_WASI: Record<number, number> = {
	1: 63, 2: 44, 3: 71, 4: 27, 5: 29, 6: 60, 7: 1, 8: 45, 9: 8, 10: 12, 11: 6, 12: 48, 13: 2, 14: 21,
	16: 10, 17: 20, 18: 75, 19: 43, 20: 54, 21: 31, 22: 28, 23: 41, 24: 33, 25: 59, 26: 74, 27: 22,
	28: 51, 29: 70, 30: 69, 31: 34, 32: 64, 33: 18, 34: 68, 35: 16, 36: 37, 37: 46, 38: 52, 39: 55,
	40: 32, 42: 49, 43: 24, 61: 29, 67: 47, 71: 65, 72: 36, 74: 9, 75: 61, 84: 25, 88: 57, 89: 17,
	90: 35, 91: 67, 92: 50, 93: 66, 94: 58, 95: 58, 97: 5, 98: 3, 99: 4, 100: 38, 101: 40, 102: 39,
	103: 13, 104: 15, 105: 42, 106: 30, 107: 53, 110: 73, 111: 14, 112: 23, 113: 23, 114: 7, 115: 26,
	116: 72, 122: 19, 125: 11, 130: 62, 131: 56,
};
/** @internal A Linux errno as WASI's. */
export const wasiErrno = (linux: number): number => LINUX_TO_WASI[linux] ?? E.IO;

// WASI file types.
const FT_UNKNOWN = 0;
const FT_BLOCK = 1;
const FT_CHAR = 2;
const FT_DIR = 3;
const FT_REG = 4;
const FT_SOCK = 6;
const FT_LINK = 7;
function fileType(mode: number): number {
	switch (mode & 0o170000) {
		case 0o060000: return FT_BLOCK;
		case 0o020000: return FT_CHAR;
		case 0o040000: return FT_DIR;
		case 0o100000: return FT_REG;
		case 0o140000: return FT_SOCK;
		case 0o120000: return FT_LINK;
		default: return FT_UNKNOWN;
	}
}

const RIGHTS_ALL = (1n << 30n) - 1n;
const RIGHT_FD_READ = 1n << 1n;
const RIGHT_FD_SEEK = 1n << 2n;
const RIGHT_FD_TELL = 1n << 5n;
const RIGHT_FD_WRITE = 1n << 6n;
/** A socket's: fd_read, fd_fdstat_set_flags, fd_write, fd_filestat_get, poll_fd_readwrite, sock_shutdown, sock_accept. */
const RIGHTS_SOCKET = (1n << 1n) | (1n << 3n) | (1n << 6n) | (1n << 21n) | (1n << 27n) | (1n << 28n) | (1n << 29n);
const FT_SOCK_DGRAM = 5;

/** proc_exit. */
class ProcExit extends Error {
	readonly code: number;
	constructor(code: number) {
		super(`proc_exit(${code})`);
		this.code = code;
	}
}

/** @internal Little-endian frame builder. */
export class Enc {
	#buf = new Uint8Array(64);
	#dv = new DataView(this.#buf.buffer);
	#len = 8; // room for the frame header
	#grow(n: number): void {
		if (this.#len + n <= this.#buf.length) return;
		let cap = this.#buf.length * 2;
		while (cap < this.#len + n) cap *= 2;
		const b = new Uint8Array(cap);
		b.set(this.#buf.subarray(0, this.#len));
		this.#buf = b;
		this.#dv = new DataView(b.buffer);
	}
	u32(v: number): this {
		this.#grow(4);
		this.#dv.setUint32(this.#len, v >>> 0, true);
		this.#len += 4;
		return this;
	}
	u64(v: bigint): this {
		this.#grow(8);
		this.#dv.setBigUint64(this.#len, BigInt.asUintN(64, v), true);
		this.#len += 8;
		return this;
	}
	bytes(b: Uint8Array): this {
		this.#grow(b.length);
		this.#buf.set(b, this.#len);
		this.#len += b.length;
		return this;
	}
	str(b: Uint8Array): this {
		return this.u32(b.length).bytes(b);
	}
	/** The frame so far, its header filled in; `more`: payload bytes that the caller puts after it. */
	frame(op: number, more = 0): Uint8Array {
		this.#dv.setUint32(0, op, true);
		this.#dv.setUint32(4, this.#len - 8 + more, true);
		return this.#buf.subarray(0, this.#len);
	}
}

interface LinuxStat {
	dev: bigint;
	ino: bigint;
	nlink: bigint;
	size: bigint;
	atim: bigint;
	mtim: bigint;
	ctim: bigint;
	mode: number;
}
function decodeStat(b: Uint8Array): LinuxStat {
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const q = (i: number) => dv.getBigUint64(i * 8, true);
	return { dev: q(0), ino: q(1), nlink: q(2), size: q(3), atim: q(4), mtim: q(5), ctim: q(6), mode: dv.getUint32(56, true) };
}

/** What the owner sends a program's worker (structured-cloneable). */
export type WasiToProgram =
	/** The first message: run this program (or one of its threads, `thread`). */
	| {
		t: "start"; module: WebAssembly.Module; name: string; args: Uint8Array[]; env: Uint8Array[]; preopens: Array<[number, Uint8Array]>;
		/** The shared channel (CH_*): requests go through it, not as messages, and the imports block instead of suspending. */
		channel?: SharedArrayBuffer;
		/** env.memory when the module imports a shared one (the owner made it; every thread gets it). */
		memory?: WebAssembly.Memory;
		/** env.memory's limits when the module imports one that is not shared (made here). */
		memoryType?: { initial: number; maximum?: number };
		/** A wasi-threads thread: call `wasi_thread_start(tid, arg)` instead of `_start`. */
		thread?: { tid: number; arg: number };
		/** The program's clocks (every thread gets the same). */
		clock: ProgramClock;
		/** A threaded program's CPU words (CPU_DONE, CPU_LIVE). */
		cpu?: SharedArrayBuffer;
	}
	/** kwwasi's REPLY to the last request: i32 Linux errno, then the result. */
	| { t: "reply"; body: Uint8Array };

/** What a program's worker sends its owner. */
export type WasiFromProgram =
	/** A request frame for kwwasi (op, length, payload); its REPLY comes back as "reply". */
	| { t: "request"; frame: Uint8Array }
	/** The program ended: kwwasi exits with `code` and writes `msg` (if any) to stderr. `failed`: a trap or an error. */
	| { t: "exit"; code: number; msg: string; failed: boolean }
	/** A thread's `wasi_thread_start` returned (the program goes on); `cpu`: its CPU time (ns), where the engine tells it. */
	| { t: "done"; cpu?: bigint }
	| { t: "log"; msg: string };

/** The owner's handle on a program's worker (WasiExecOptions.spawn). */
export interface WasiProgramEndpoint {
	post(msg: WasiToProgram, transfer?: ArrayBuffer[]): void;
	listen(h: {
		message(msg: WasiFromProgram): void;
		/** An uncaught error in the worker (or one that failed to start). */
		error(err: unknown): void;
		/** The worker thread ended (also after terminate()). */
		exit(): void;
	}): void;
	/** End the worker now, even in the middle of a computation. */
	terminate(): void;
	/**
	 * The worker thread's CPU time (us) since it started, read on that
	 * thread wherever it is (computing, waiting): Node's worker.cpuUsage().
	 * Where there is none, a threaded program's process clock counts the
	 * other threads once they returned.
	 */
	cpuUsage?(): Promise<number>;
}

/** The worker's way to its owner (its entry's port). */
export interface WasiProgramPort {
	post(msg: WasiFromProgram, transfer?: ArrayBuffer[]): void;
	listen(handler: (msg: WasiToProgram) => void): void;
}

/**
 * A program's worker (called by the worker's entry): run the program a
 * "start" brings; once it has ended by itself ("exit" sent), the owner may
 * send the next one.
 */
export function serveWasiProgram(port: WasiProgramPort): void {
	let prog: Program | undefined;
	port.listen((msg) => {
		if (msg.t === "start" && !prog) {
			const p = prog = new Program(port, msg.args, msg.env, new Map(msg.preopens), msg.channel);
			void p.run(msg).finally(() => {
				if (prog === p) prog = undefined;
			});
		} else if (msg.t === "reply") {
			prog?.reply(msg.body);
		}
	});
}

interface Reply {
	err: number;
	data: Uint8Array;
}

class Program {
	memory: WebAssembly.Memory | undefined;
	#port: WasiProgramPort;
	#args: Uint8Array[];
	#env: Uint8Array[];
	#preopens: Map<number, Uint8Array>;
	/** Takes the reply to the request in flight (one at a time; the message path). */
	#pending: ((body: Uint8Array) => void) | undefined;
	/** The shared channel, its control words and the last request's number (the shared path). */
	#ch: SharedArrayBuffer | undefined;
	#ctl: Int32Array | undefined;
	#seq = 0;
	#clock: ProgramClock = { real: 0n, mono: 0n, start: 0n };
	/** The guest's clocks less performance.now() (ns): realtime's, and monotonic's as a number (exact below 2^53 ns). */
	#realBase = 0n;
	#monoBase = 0;
	/** When this thread started: the host's clock, and its CPU time then (us; a worker runs one program after another). */
	#runStart = 0n;
	#cpu0 = 0;
	/** A threaded program's CPU words (start's `cpu`: CPU_DONE, CPU_LIVE). */
	#cpuDone: BigInt64Array | undefined;
	#cpuLive: Int32Array | undefined;
	/** The other threads' CPU time (ns) the owner gave last (H_CPU), when (performance.now()), and the last process clock this thread read. */
	#cpuOthers = 0n;
	#cpuAsked = -Infinity;
	#cpuLast = 0n;

	constructor(port: WasiProgramPort, args: Uint8Array[], env: Uint8Array[], preopens: Map<number, Uint8Array>, channel?: SharedArrayBuffer) {
		this.#port = port;
		this.#args = args;
		this.#env = env;
		this.#preopens = preopens;
		this.#ch = channel;
		this.#ctl = channel && new Int32Array(channel, 0, CH_DATA / 4);
	}

	#exit(code: number, msg = "", failed = false): void {
		this.#port.post({ t: "exit", code, msg, failed });
	}

	/**
	 * Instantiate the module and run `_start`, or for a thread
	 * `wasi_thread_start`; ends with an "exit" message, or "done" for a
	 * thread that returned.
	 */
	async run(start: Extract<WasiToProgram, { t: "start" }>): Promise<void> {
		const { module, name, thread } = start;
		this.#clock = start.clock;
		this.#realBase = originNs + start.clock.real;
		this.#monoBase = Number(originNs + start.clock.mono);
		this.#runStart = hostClockNs();
		this.#cpu0 = Math.round(threadCpuUs?.() ?? 0);
		if (start.cpu) {
			this.#cpuDone = new BigInt64Array(start.cpu, 0, 1);
			this.#cpuLive = new Int32Array(start.cpu, CPU_LIVE * 4, 1);
			// The owner's samples of this worker's CPU time count from here (threads run on the shared path only).
			if (this.#ch && threadCpuUs) Atomics.store(new BigInt64Array(this.#ch, 0, CH_DATA / 8), CH_CPU0, BigInt(this.#cpu0));
		}
		let instance: WebAssembly.Instance;
		try {
			// env.memory: the owner's shared one, or one of this program's own.
			this.memory = start.memory ?? (start.memoryType && new WebAssembly.Memory(start.memoryType));
			instance = await WebAssembly.instantiate(module, this.imports(module));
		} catch (e) {
			return this.#exit(126, `kwwasi: ${name}: ${(e as Error)?.message ?? e}`);
		}
		if (!this.memory) {
			const memory = instance.exports.memory;
			if (!(memory instanceof WebAssembly.Memory)) return this.#exit(126, `kwwasi: ${name}: exports no memory`);
			this.memory = memory;
		}
		try {
			if (thread) {
				// Threads run only on the shared path (the owner checked), so this blocks as `_start` does.
				(instance.exports.wasi_thread_start as (tid: number, arg: number) => void)(thread.tid, thread.arg);
				this.#port.post({ t: "done", cpu: threadCpuUs ? this.#threadCpu() : undefined });
				return;
			}
			const start = instance.exports._start as () => void;
			// Shared: the imports block, so `_start` runs to its end right here; else they suspend.
			if (this.#ch) start();
			else await WebAssembly.promising(start)();
			this.#exit(0);
		} catch (e) {
			if (e instanceof ProcExit) return this.#exit(e.code);
			const msg = e instanceof WebAssembly.RuntimeError ? `wasm trap: ${e.message}` : `${(e as Error)?.message ?? e}`;
			this.#exit(134, `kwwasi: ${name}: ${msg}${thread ? ` (in thread ${thread.tid})` : ""}`, true);
		}
	}

	/** kwwasi's reply to the request in flight. */
	reply(body: Uint8Array): void {
		const p = this.#pending;
		this.#pending = undefined;
		p?.(body);
	}

	get #u8(): Uint8Array<ArrayBuffer> {
		return new Uint8Array(this.memory!.buffer as ArrayBuffer);
	}
	get #dv(): DataView {
		return new DataView(this.memory!.buffer);
	}

	/**
	 * One request to kwwasi and its reply (the owner checked the frame). The
	 * shared path returns at once with a view of the channel, valid until the
	 * next request; the message path returns a promise. `tail`: the rest of
	 * the payload (a write's data, views of the program's memory), copied
	 * once, into the channel or the frame.
	 */
	#call(op: number, req: Enc, tail?: Uint8Array[]): Maybe<Reply> {
		const toReply = (body: Uint8Array): Reply => {
			const err = new DataView(body.buffer, body.byteOffset, body.byteLength).getInt32(0, true);
			return { err: err ? wasiErrno(err) : 0, data: body.subarray(4) };
		};
		const ch = this.#ch, ctl = this.#ctl;
		if (!ch || !ctl) {
			if (tail) for (const t of tail) req.bytes(t);
			// The Enc's buffer goes with the message: this request is its only use.
			const frame = req.frame(op);
			return new Promise<Uint8Array>((resolve) => {
				this.#pending = resolve;
				this.#port.post({ t: "request", frame }, [frame.buffer as ArrayBuffer]);
			}).then(toReply);
		}
		const more = tail ? tail.reduce((n, t) => n + t.length, 0) : 0;
		const head = req.frame(op, more);
		if (!channelRoom(ch, head.length + more)) return { err: E.NAMETOOLONG, data: new Uint8Array() };
		const area = new Uint8Array(ch, CH_DATA, head.length + more);
		area.set(head);
		if (tail) {
			let at = head.length;
			for (const t of tail) {
				area.set(t, at);
				at += t.length;
			}
		}
		Atomics.store(ctl, CH_LEN, area.length);
		const seq = ++this.#seq | 0;
		Atomics.store(ctl, CH_REQ, seq);
		Atomics.notify(ctl, CH_REQ);
		if (Atomics.load(ctl, CH_REP) !== seq) {
			const t = performance.now();
			while (Atomics.load(ctl, CH_REP) !== seq && performance.now() - t < SPIN_MS) pause?.();
		}
		for (let rep; (rep = Atomics.load(ctl, CH_REP)) !== seq;) Atomics.wait(ctl, CH_REP, rep);
		return toReply(new Uint8Array(ch, CH_DATA, Atomics.load(ctl, CH_LEN)));
	}
	/** Sleep `ms` (poll_oneoff with only clocks). */
	#sleep(ms: number): Maybe<void> {
		// setTimeout() drops the fraction of a millisecond, which would end the sleep early.
		if (!this.#ctl) return new Promise((r) => setTimeout(r, Math.ceil(ms)));
		Atomics.wait(this.#ctl, CH_SLEEP, 0, ms);
	}

	#bytes(ptr: number, len: number): Uint8Array {
		return this.#u8.slice(ptr, ptr + len);
	}
	#iovs(ptr: number, n: number): Array<[number, number]> {
		const dv = this.#dv;
		return Array.from({ length: n }, (_, i) => [dv.getUint32(ptr + i * 8, true), dv.getUint32(ptr + i * 8 + 4, true)]);
	}
	/** A filestat: preview 1's 64 bytes (u64 nlink), or preview 0's 56 (u32 nlink at 20, the rest 8 bytes earlier). */
	#putFilestat(ptr: number, st: LinuxStat, p0: boolean): void {
		const dv = this.#dv;
		dv.setBigUint64(ptr, st.dev, true);
		dv.setBigUint64(ptr + 8, st.ino, true);
		dv.setUint8(ptr + 16, fileType(st.mode));
		let at = ptr + 24;
		if (p0) {
			dv.setUint32(ptr + 20, st.nlink > 0xffffffffn ? 0xffffffff : Number(st.nlink), true);
		} else {
			dv.setBigUint64(at, st.nlink, true);
			at += 8;
		}
		dv.setBigUint64(at, st.size, true);
		dv.setBigUint64(at + 8, st.atim, true);
		dv.setBigUint64(at + 16, st.mtim, true);
		dv.setBigUint64(at + 24, st.ctim, true);
	}
	#strings(list: Uint8Array[], ptrs: number, buf: number): number {
		const u8 = this.#u8, dv = this.#dv;
		list.forEach((s, i) => {
			dv.setUint32(ptrs + i * 4, buf, true);
			u8.set(s, buf);
			u8[buf + s.length] = 0;
			buf += s.length + 1;
		});
		return E.SUCCESS;
	}
	#sizes(list: Uint8Array[], countPtr: number, sizePtr: number): number {
		this.#dv.setUint32(countPtr, list.length, true);
		this.#dv.setUint32(sizePtr, list.reduce((n, s) => n + s.length + 1, 0), true);
		return E.SUCCESS;
	}
	/** The u32 or u64 at the start of a reply's result. */
	#u32(r: Reply): number {
		return new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength).getUint32(0, true);
	}
	#u64(r: Reply): bigint {
		return new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength).getBigUint64(0, true);
	}

	/** The bytes the iovecs at `iovs` take, at most MAX_IO. */
	#room(iovs: number, n: number): number {
		return Math.min(MAX_IO, this.#iovs(iovs, n).reduce((s, [, l]) => s + l, 0));
	}
	/** Spread `data` over the iovecs at `iovs`; the bytes placed. */
	#scatter(iovs: number, n: number, data: Uint8Array): number {
		const u8 = this.#u8;
		let at = 0;
		for (const [p, l] of this.#iovs(iovs, n)) {
			if (at >= data.length) break;
			const take = Math.min(l, data.length - at);
			u8.set(data.subarray(at, at + take), p);
			at += take;
		}
		return at;
	}
	#read(fd: number, iovs: number, n: number, nread: number, offset?: bigint): Maybe<number> {
		const req = new Enc().u32(fd).u32(this.#room(iovs, n));
		if (offset !== undefined) req.u64(offset);
		return then(this.#call(offset === undefined ? R_READ : R_PREAD, req), (r) => {
			if (r.err) return r.err;
			this.#dv.setUint32(nread, this.#scatter(iovs, n, r.data), true);
			return E.SUCCESS;
		});
	}
	/** sock_recv: riflags 1 RECV_PEEK, 2 RECV_WAITALL; roflags 1 RECV_DATA_TRUNCATED. */
	#recv(fd: number, iovs: number, n: number, riflags: number, nread: number, roflags: number): Maybe<number> {
		if (riflags & ~3) return E.INVAL;
		return then(this.#call(R_RECV, new Enc().u32(fd).u32(this.#room(iovs, n)).u32(riflags)), (r) => {
			if (r.err) return r.err;
			this.#dv.setUint32(nread, this.#scatter(iovs, n, r.data.subarray(4)), true);
			this.#dv.setUint16(roflags, this.#u32(r) & 1, true);
			return E.SUCCESS;
		});
	}
	/** fd_write, fd_pwrite (`offset`) and sock_send (`op` R_SEND, siflags 0). */
	#write(fd: number, iovs: number, n: number, nwritten: number, offset?: bigint, op?: number): Maybe<number> {
		const req = new Enc().u32(fd);
		if (offset !== undefined) req.u64(offset);
		if (op === R_SEND) req.u32(0);
		let total = 0;
		const u8 = this.#u8, data: Uint8Array[] = [];
		for (const [p, l] of this.#iovs(iovs, n)) {
			const take = Math.min(l, MAX_IO - total);
			data.push(u8.subarray(p, p + take));
			total += take;
			if (total >= MAX_IO) break;
		}
		return then(this.#call(op ?? (offset === undefined ? R_WRITE : R_PWRITE), req, data), (r) => {
			if (r.err) return r.err;
			this.#dv.setUint32(nwritten, this.#u32(r), true);
			return E.SUCCESS;
		});
	}
	#stat(op: number, req: Enc, out: number, p0: boolean): Maybe<number> {
		return then(this.#call(op, req), (r) => {
			if (r.err) return r.err;
			this.#putFilestat(out, decodeStat(r.data), p0);
			return E.SUCCESS;
		});
	}
	#times(atim: bigint, mtim: bigint, flags: number): [bigint, bigint] {
		// fstflags: 1 ATIM, 2 ATIM_NOW, 4 MTIM, 8 MTIM_NOW. -1 = now, -2 = omit.
		const a = flags & 2 ? -1n : flags & 1 ? atim : -2n;
		const m = flags & 8 ? -1n : flags & 4 ? mtim : -2n;
		return [a, m];
	}
	#simple(op: number, req: Enc): Maybe<number> {
		return then(this.#call(op, req), (r) => r.err);
	}
	/** A request whose result is a u32 (`fd`, a count) or u64 (a position) to store at `out`. */
	#scalar(op: number, req: Enc, out: number, wide: boolean): Maybe<number> {
		return then(this.#call(op, req), (r) => {
			if (r.err) return r.err;
			if (wide) this.#dv.setBigUint64(out, this.#u64(r), true);
			else this.#dv.setUint32(out, this.#u32(r), true);
			return E.SUCCESS;
		});
	}
	/** A request whose result is bytes for the program's buffer (`buf`, at most `len`; `used` gets the count). */
	#into(op: number, req: Enc, buf: number, len: number, used: number): Maybe<number> {
		return then(this.#call(op, req), (r) => {
			if (r.err) return r.err;
			const n = Math.min(len, r.data.length);
			this.#u8.set(r.data.subarray(0, n), buf);
			this.#dv.setUint32(used, n, true);
			return E.SUCCESS;
		});
	}
	/**
	 * Clock `id` (ns), undefined for one WASI does not define: 0 realtime and
	 * 1 monotonic (the guest's, ProgramClock), 2 the process's CPU time, 3
	 * this thread's (since it started; without threadCpuUs the time since the
	 * program or the thread started).
	 */
	#now(id: number): bigint | undefined {
		switch (id) {
			// hostClockNs() plus the offset, with one BigInt made (clock calls are hot).
			case 0: return BigInt(Math.round(performance.now() * 1e6)) + this.#realBase;
			case 1: return BigInt(Math.round(performance.now() * 1e6 + this.#monoBase));
			case 2: return this.#processCpu();
			case 3: return this.#threadCpu();
		}
		return undefined;
	}
	#threadCpu(): bigint {
		return threadCpuUs ? BigInt(Math.round((threadCpuUs() - this.#cpu0) * 1000)) : hostClockNs() - this.#runStart;
	}
	/**
	 * The process's CPU time: this thread's, and for a threaded program its
	 * other threads' too. Those that returned are in CPU_DONE; while others
	 * run, the owner adds theirs up now (H_CPU, a round trip; its answer is
	 * reused for CPU_ASK_MS). Never less than this thread read before.
	 */
	#processCpu(): bigint {
		if (!threadCpuUs) return hostClockNs() - this.#clock.start;
		const live = this.#cpuLive;
		if (!live) return this.#threadCpu();
		let others: bigint;
		// CPU_LIVE first: the owner adds a thread's time to CPU_DONE before it takes the thread from CPU_LIVE.
		if (Atomics.load(live, 0) <= 1) others = Atomics.load(this.#cpuDone!, 0);
		else {
			if (performance.now() - this.#cpuAsked >= CPU_ASK_MS) {
				const r = this.#call(H_CPU, new Enc()) as Reply;
				if (!r.err) {
					this.#cpuOthers = this.#u64(r);
					this.#cpuAsked = performance.now();
				}
			}
			others = this.#cpuOthers;
		}
		const t = this.#threadCpu() + others;
		if (t > this.#cpuLast) this.#cpuLast = t;
		return this.#cpuLast;
	}

	/**
	 * poll_oneoff. Subscriptions are 48 bytes in preview 1; preview 0's are
	 * 56, its clock subscription starting with a u64 `identifier` (so id,
	 * timeout and flags are 8 bytes later). Events are the same in both.
	 */
	#poll(inPtr: number, outPtr: number, nsubs: number, neventsPtr: number, p0: boolean): Maybe<number> {
		if (nsubs === 0) return E.INVAL;
		const dv = this.#dv;
		const size = p0 ? 56 : 48, clock = p0 ? 24 : 16;
		interface Sub { userdata: bigint; tag: number; fd: number; timeout: number }
		const subs: Sub[] = [];
		const events: Array<{ sub: Sub; flags: number; error: number }> = [];
		for (let i = 0; i < nsubs; i++) {
			const p = inPtr + i * size;
			const tag = dv.getUint8(p + 8);
			const sub: Sub = { userdata: dv.getBigUint64(p, true), tag, fd: 0, timeout: Infinity };
			if (tag === 0) {
				// An absolute time (flags 1) is on the same clocks as clock_time_get.
				const id = dv.getUint32(p + clock, true), now = this.#now(id);
				let t = dv.getBigUint64(p + clock + 8, true);
				if (now === undefined) {
					events.push({ sub, flags: 0, error: E.INVAL });
					continue;
				}
				if (dv.getUint16(p + clock + 24, true) & 1) t = t > now ? t - now : 0n;
				sub.timeout = Number(t) / 1e6;
			} else {
				sub.fd = dv.getUint32(p + 16, true);
			}
			subs.push(sub);
		}
		// An unknown clock: its event now, nothing waited for.
		if (events.length) subs.length = 0;
		const min = Math.min(...subs.map((s) => s.timeout));
		const fdSubs = subs.filter((s) => s.tag !== 0);
		const finish = () => {
			if (!events.length) for (const s of subs) if (s.tag === 0 && s.timeout <= min) events.push({ sub: s, flags: 0, error: 0 });
			const out = this.#dv;
			events.forEach((ev, i) => {
				const p = outPtr + i * 32;
				for (let j = 0; j < 32; j += 8) out.setBigUint64(p + j, 0n, true);
				out.setBigUint64(p, ev.sub.userdata, true);
				out.setUint16(p + 8, ev.error, true);
				out.setUint8(p + 10, ev.sub.tag);
				out.setUint16(p + 24, ev.flags, true);
			});
			out.setUint32(neventsPtr, events.length, true);
			return E.SUCCESS;
		};
		if (fdSubs.length) {
			const req = new Enc().u32(min === Infinity ? -1 : Math.ceil(min)).u32(fdSubs.length);
			for (const s of fdSubs) req.u32(s.fd).u32(s.tag === 1 ? 1 : 4); // POLLIN, POLLOUT
			return then(this.#call(R_POLL, req), (r) => {
				if (r.err) return r.err;
				const rv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
				fdSubs.forEach((s, i) => {
					const revents = rv.getUint32(i * 4, true);
					if (revents & 0x8) events.push({ sub: s, flags: 0, error: E.IO }); // POLLERR
					else if (revents & 0x20) events.push({ sub: s, flags: 0, error: E.BADF }); // POLLNVAL
					else if (revents) events.push({ sub: s, flags: revents & 0x10 ? 1 : 0, error: 0 }); // POLLHUP
				});
				return finish();
			});
		}
		return min > 0 && min !== Infinity ? then(this.#sleep(min), finish) : finish();
	}

	/** The import object for `module`: the functions it imports from wasi_snapshot_preview1 and wasi_unstable (WASI0). */
	imports(module: WebAssembly.Module): WebAssembly.Imports {
		const self = this;
		// Calls that ask kwwasi (block on the shared channel, or suspend), then those answered here.
		const remote: Record<string, (...a: any[]) => Maybe<number>> = {
			fd_read: (fd: number, iovs: number, n: number, nread: number) => this.#read(fd, iovs, n, nread),
			fd_pread: (fd: number, iovs: number, n: number, off: bigint, nread: number) => this.#read(fd, iovs, n, nread, off),
			fd_write: (fd: number, iovs: number, n: number, nw: number) => this.#write(fd, iovs, n, nw),
			fd_pwrite: (fd: number, iovs: number, n: number, off: bigint, nw: number) => this.#write(fd, iovs, n, nw, off),
			// whence: SET 0, CUR 1, END 2, as Linux's lseek().
			fd_seek: (fd: number, off: bigint, whence: number, out: number) =>
				whence > 2 ? E.INVAL : this.#scalar(R_SEEK, new Enc().u32(fd).u32(whence).u64(off), out, true),
			fd_tell: (fd: number, out: number) => this.#scalar(R_SEEK, new Enc().u32(fd).u32(1).u64(0n), out, true),
			fd_close: (fd: number) =>
				then(this.#simple(R_CLOSE, new Enc().u32(fd)), (err) => {
					if (!err) self.#preopens.delete(fd);
					return err;
				}),
			fd_renumber: (from: number, to: number) =>
				then(this.#simple(R_RENUMBER, new Enc().u32(from).u32(to)), (err) => {
					if (!err && from !== to) {
						const p = self.#preopens.get(from);
						self.#preopens.delete(from);
						self.#preopens.delete(to);
						if (p) self.#preopens.set(to, p);
					}
					return err;
				}),
			fd_filestat_get: (fd: number, out: number) => this.#stat(R_FSTAT, new Enc().u32(fd), out, false),
			fd_fdstat_get: (fd: number, out: number) =>
				then(this.#call(R_FDSTAT, new Enc().u32(fd)), (r) => {
					if (r.err) return r.err;
					const v = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
					const mode = v.getUint32(0, true), fl = v.getUint32(4, true), tty = v.getUint32(8, true), sotype = v.getUint32(12, true);
					let flags = 0;
					if (fl & O_APPEND) flags |= 1;
					if (fl & O_DSYNC) flags |= 2;
					if (fl & O_NONBLOCK) flags |= 4;
					if ((fl & O_SYNC) === O_SYNC) flags |= 16;
					const dv = self.#dv, type = fileType(mode);
					// A socket: SOCK_DGRAM (2) is socket_dgram, any other socket_stream.
					dv.setUint8(out, type === FT_SOCK && sotype === 2 ? FT_SOCK_DGRAM : type);
					dv.setUint16(out + 2, flags, true);
					// isatty() in wasi-libc: a character device without seek and tell rights.
					const rights = type === FT_SOCK ? RIGHTS_SOCKET : tty ? RIGHTS_ALL & ~(RIGHT_FD_SEEK | RIGHT_FD_TELL) : RIGHTS_ALL;
					dv.setBigUint64(out + 8, rights, true);
					dv.setBigUint64(out + 16, type === FT_SOCK ? RIGHTS_SOCKET : RIGHTS_ALL, true);
					return E.SUCCESS;
				}),
			// fdflags: 1 APPEND, 2 DSYNC, 4 NONBLOCK, 8 RSYNC, 16 SYNC. Linux cannot change the sync ones after open: kwwasi
			// refuses (NOTSUP) another state than the descriptor's, which fcntl(F_SETFL, F_GETFL's | O_NONBLOCK) keeps.
			fd_fdstat_set_flags: (fd: number, flags: number) => flags & ~31 ? E.INVAL : this.#simple(R_SETFL, new Enc().u32(fd).u32(
				(flags & 1 ? O_APPEND : 0) | (flags & 4 ? O_NONBLOCK : 0) | (flags & 24 ? O_SYNC : flags & 2 ? O_DSYNC : 0))),
			fd_allocate: (fd: number, off: bigint, len: bigint) => this.#simple(R_ALLOCATE, new Enc().u32(fd).u64(off).u64(len)),
			fd_filestat_set_size: (fd: number, size: bigint) => this.#simple(R_FTRUNCATE, new Enc().u32(fd).u64(size)),
			fd_filestat_set_times(fd: number, atim: bigint, mtim: bigint, flags: number) {
				const [a, m] = self.#times(atim, mtim, flags);
				return self.#simple(R_UTIMENS, new Enc().u32(fd).u32(0).u64(a).u64(m));
			},
			fd_sync: (fd: number) => this.#simple(R_FSYNC, new Enc().u32(fd).u32(0)),
			fd_datasync: (fd: number) => this.#simple(R_FSYNC, new Enc().u32(fd).u32(1)),
			fd_readdir: (fd: number, buf: number, len: number, cookie: bigint, used: number) =>
				this.#into(R_READDIR, new Enc().u32(fd).u32(len).u64(cookie), buf, len, used),
			path_open(dirfd: number, lookup: number, path: number, plen: number, oflags: number,
				base: bigint, _inheriting: bigint, fdflags: number, out: number) {
				let fl = 0;
				if (oflags & 2) fl |= O_DIRECTORY;
				else if (base & RIGHT_FD_WRITE) fl |= base & RIGHT_FD_READ ? O_RDWR : O_WRONLY;
				if (oflags & 1) fl |= O_CREAT;
				if (oflags & 4) fl |= O_EXCL;
				if (oflags & 8) fl |= O_TRUNC;
				if (fdflags & 1) fl |= O_APPEND;
				if (fdflags & 2) fl |= O_DSYNC;
				if (fdflags & 4) fl |= O_NONBLOCK;
				if (fdflags & 24) fl |= O_SYNC;
				if (!(lookup & 1)) fl |= O_NOFOLLOW;
				return self.#scalar(R_OPENAT, new Enc().u32(dirfd).u32(fl).bytes(self.#bytes(path, plen)), out, false);
			},
			path_filestat_get: (fd: number, lookup: number, path: number, plen: number, out: number) =>
				this.#stat(R_STATAT, new Enc().u32(fd).u32(lookup & 1 ? 0 : AT_SYMLINK_NOFOLLOW).bytes(this.#bytes(path, plen)), out, false),
			path_filestat_set_times(fd: number, lookup: number, path: number, plen: number, atim: bigint, mtim: bigint, flags: number) {
				const [a, m] = self.#times(atim, mtim, flags);
				const p = self.#bytes(path, plen);
				if (!p.length) return 44; // ENOENT, as utimensat("")
				return self.#simple(R_UTIMENS, new Enc().u32(fd).u32(lookup & 1 ? 0 : AT_SYMLINK_NOFOLLOW).u64(a).u64(m).bytes(p));
			},
			path_create_directory: (fd: number, path: number, plen: number) =>
				this.#simple(R_MKDIRAT, new Enc().u32(fd).bytes(this.#bytes(path, plen))),
			path_remove_directory: (fd: number, path: number, plen: number) =>
				this.#simple(R_UNLINKAT, new Enc().u32(fd).u32(AT_REMOVEDIR).bytes(this.#bytes(path, plen))),
			path_unlink_file: (fd: number, path: number, plen: number) =>
				this.#simple(R_UNLINKAT, new Enc().u32(fd).u32(0).bytes(this.#bytes(path, plen))),
			path_rename: (fd: number, old: number, olen: number, nfd: number, np: number, nlen: number) =>
				this.#simple(R_RENAMEAT, new Enc().u32(fd).u32(nfd).str(this.#bytes(old, olen)).str(this.#bytes(np, nlen))),
			path_link: (fd: number, lookup: number, old: number, olen: number, nfd: number, np: number, nlen: number) =>
				this.#simple(R_LINKAT, new Enc().u32(fd).u32(nfd).u32(lookup & 1 ? AT_SYMLINK_FOLLOW : 0)
					.str(this.#bytes(old, olen)).str(this.#bytes(np, nlen))),
			path_symlink: (old: number, olen: number, fd: number, np: number, nlen: number) =>
				this.#simple(R_SYMLINKAT, new Enc().u32(fd).str(this.#bytes(old, olen)).str(this.#bytes(np, nlen))),
			path_readlink: (fd: number, path: number, plen: number, buf: number, blen: number, used: number) =>
				this.#into(R_READLINKAT, new Enc().u32(fd).bytes(this.#bytes(path, plen)), buf, blen, used),
			poll_oneoff: (inp: number, out: number, n: number, nev: number) => this.#poll(inp, out, n, nev, false),
			// Sockets the program has (kwwasi's: inherited, or KWWASI_TCPLISTEN's). fdflags: only NONBLOCK (4).
			sock_accept: (fd: number, flags: number, out: number) =>
				flags & ~4 ? E.INVAL : this.#scalar(R_ACCEPT, new Enc().u32(fd).u32(flags & 4 ? O_NONBLOCK : 0), out, false),
			sock_recv: (fd: number, iovs: number, n: number, riflags: number, nread: number, roflags: number) =>
				this.#recv(fd, iovs, n, riflags, nread, roflags),
			sock_send: (fd: number, iovs: number, n: number, _siflags: number, nw: number) => this.#write(fd, iovs, n, nw, undefined, R_SEND),
			// sdflags: 1 RD, 2 WR.
			sock_shutdown: (fd: number, how: number) => how < 1 || how > 3 ? E.INVAL : this.#simple(R_SHUTDOWN, new Enc().u32(fd).u32(how)),
		};
		/**
		 * Preview 0 (`wasi_unstable`; WebAssembly/WASI's legacy preview0 witx,
		 * wasmtime crates/wasi/witx/p0): the same functions but for whence
		 * (CUR 0, END 1, SET 2), filestat (56 bytes, u32 nlink) and poll_oneoff's
		 * subscriptions (56 bytes); it has no sock_accept.
		 */
		const WASI0_WHENCE = [1, 2, 0];
		const remote0: Record<string, (...a: any[]) => Maybe<number>> = {
			...remote,
			fd_seek: (fd: number, off: bigint, whence: number, out: number) =>
				remote.fd_seek!(fd, off, WASI0_WHENCE[whence] ?? 3, out),
			fd_filestat_get: (fd: number, out: number) => this.#stat(R_FSTAT, new Enc().u32(fd), out, true),
			path_filestat_get: (fd: number, lookup: number, path: number, plen: number, out: number) =>
				this.#stat(R_STATAT, new Enc().u32(fd).u32(lookup & 1 ? 0 : AT_SYMLINK_NOFOLLOW).bytes(this.#bytes(path, plen)), out, true),
			poll_oneoff: (inp: number, out: number, n: number, nev: number) => this.#poll(inp, out, n, nev, true),
		};
		delete remote0.sock_accept;
		const local: Record<string, (...a: any[]) => number> = {
			args_sizes_get: (c: number, s: number) => this.#sizes(this.#args, c, s),
			args_get: (p: number, b: number) => this.#strings(this.#args, p, b),
			environ_sizes_get: (c: number, s: number) => this.#sizes(this.#env, c, s),
			environ_get: (p: number, b: number) => this.#strings(this.#env, p, b),
			fd_prestat_get(fd: number, out: number) {
				const name = self.#preopens.get(fd);
				if (!name) return E.BADF;
				self.#dv.setUint32(out, 0, true); // tag 0: a directory
				self.#dv.setUint32(out + 4, name.length, true);
				return E.SUCCESS;
			},
			fd_prestat_dir_name(fd: number, buf: number, len: number) {
				const name = self.#preopens.get(fd);
				if (!name) return E.BADF;
				self.#u8.set(name.subarray(0, len), buf);
				return E.SUCCESS;
			},
			fd_advise: () => E.SUCCESS,
			fd_fdstat_set_rights: () => E.SUCCESS,
			// The CPU-time clocks count in us where the engine has them (threadCpuUs), else they are the monotonic clock's.
			clock_res_get(id: number, out: number) {
				if (id < 0 || id > 3) return E.INVAL;
				self.#dv.setBigUint64(out, id >= 2 && threadCpuUs ? 1000n : nowResolution(), true);
				return E.SUCCESS;
			},
			clock_time_get(id: number, _precision: bigint, out: number) {
				const t = self.#now(id);
				if (t === undefined) return E.INVAL;
				self.#dv.setBigUint64(out, t, true);
				return E.SUCCESS;
			},
			random_get(buf: number, len: number) {
				const u8 = self.#u8;
				// getRandomValues() takes no view of a SharedArrayBuffer (a threads program's memory) in browsers.
				const shared = typeof SharedArrayBuffer !== "undefined" && u8.buffer instanceof SharedArrayBuffer;
				for (let at = 0; at < len; at += 65536) {
					const part = u8.subarray(buf + at, buf + Math.min(len, at + 65536));
					if (shared) part.set(crypto.getRandomValues(new Uint8Array(part.length)));
					else crypto.getRandomValues(part);
				}
				return E.SUCCESS;
			},
			sched_yield: () => E.SUCCESS,
			proc_raise: () => E.NOSYS,
			proc_exit(code: number) {
				throw new ProcExit(code);
			},
		};
		const out: Record<string, Record<string, unknown>> = {};
		for (const imp of WebAssembly.Module.imports(module)) {
			if (imp.module === WASI_MEMORY.module && imp.name === WASI_MEMORY.name && imp.kind === "memory") {
				(out[imp.module] ??= {})[imp.name] = this.memory;
				continue;
			}
			if (imp.module === WASI_THREAD_SPAWN.module && imp.name === WASI_THREAD_SPAWN.name && imp.kind === "function") {
				// The new thread's tid (kwwasi's pthread for it has connected; the owner starts its worker), or a negative errno.
				(out[imp.module] ??= {})[imp.name] = (arg: number) => {
					if (!this.#ch) return -E.NOTSUP;
					const r = this.#call(R_SPAWN, new Enc().u32(arg)) as Reply;
					return r.err ? -r.err : this.#u32(r) | 0;
				};
				continue;
			}
			if (!WASI_MODULES.includes(imp.module) || imp.kind !== "function") continue;
			const ns = (out[imp.module] ??= {});
			const r = (imp.module === "wasi_unstable" ? remote0 : remote)[imp.name];
			const l = local[imp.name];
			if (r) {
				ns[imp.name] = this.#ch ? r : new WebAssembly.Suspending(r as (...a: any[]) => Promise<number>);
			} else if (l) {
				ns[imp.name] = l;
			} else {
				this.#port.post({ t: "log", msg: `[wasi] ${imp.module}.${imp.name} is not implemented (ENOSYS)` });
				ns[imp.name] = () => E.NOSYS;
			}
		}
		return out as WebAssembly.Imports;
	}
}
