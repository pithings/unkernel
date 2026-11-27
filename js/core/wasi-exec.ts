// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// WASI programs (wasm32-wasi, preview 1 or 0) that the guest runs, executed by
// the host's own wasm engine (prototype). The guest's binfmt_misc hands an
// executable .wasm file to kwwasi (guest/src/kwwasi.c), which connects
// to vsock port 1021 and sends argv, the environment, its preopened
// directory and the module (unless this side has it); kwwasi then does the
// program's file calls with
// its own descriptors, cwd and credentials. The protocol is described at
// the top of kwwasi.c; a change goes in both (and in wasi-program.ts).
//
// This is the owner's side, where `vsock` (VsockHost) runs: on the
// kernel's thread inline, on the owner's thread in worker mode and with
// several CPUs. It reads the START frame, gets the module (ModuleCache:
// compiled once per SHA-256 of its bytes, so a program run again is not
// sent or compiled again and runs the code V8 tiered up), checks its
// imports and gives the program a worker of its own (spawned by the
// platform's binding, js/node/wasi.ts or
// js/web/wasi.ts; WorkerPool), posting it the compiled module. kwwasi sends
// the file's identity first (size, dev, ino, mtime, ctime) and the bytes
// only when asked: ModuleCache maps identities to modules compiled before,
// for this machine. The program
// runs there (wasi-program.ts) and hands kwwasi's requests to this side,
// which writes them to the connection and hands the replies back: through
// a SharedArrayBuffer per program where this thread can use one
// (`sharedMemory`, wasiSharedChannelAvailable(); this side wakes on
// Atomics.waitAsync and never blocks), else as messages. The workers are
// the owner's, not the kernel worker's, because the connection is here: a
// request crosses one thread boundary, not two.
//
// Imports: WASI preview 1 and 0, and for wasi-threads wasi.thread-spawn and
// env.memory. A shared env.memory is made here, with the limits read from
// the module's import section (importedMemory(); Module.imports() has no
// limits), and posted to every thread's worker; one that is not shared is
// made in the worker. Threads need the shared path: elsewhere such a
// module ends at its start (126). Each wasm thread has a worker, a channel
// and a kwwasi connection of its own (Link): kwwasi's thread-spawn request
// starts a pthread that connects with THREAD (the program's token from
// MODULE, the tid, the start argument), and accept() hands that connection
// to its Program, which starts the thread's worker. A Program ends as a
// whole (Program.end()). Its process CPU clock: a thread reading it while
// others run asks this side (H_CPU on its channel, answered here), which
// samples the other threads' workers (WasiProgramEndpoint.cpuUsage, where
// the platform has it) and adds those that returned (CPU_DONE).
//
// Ending: proc_exit, a return from `_start` or a trap (in any thread) comes
// as an "exit" message, sent to kwwasi as EXIT; kwwasi exits with that
// status, and that worker, idle now, is kept for the next program (at most
// `idleWorkers`) or terminated; the program's other threads' workers are
// terminated. A thread that returned ("done") gives its worker back the
// same way. When a connection ends first (kwwasi killed: Ctrl-C, SIGKILL,
// SIGPIPE; the kernel exited or was stopped), every worker of the program
// is terminated at once, even in the middle of a computation.
//
// Snapshots: programs are not part of one. Nothing here holds up the
// snapshot point (no VsockDevice.hostBusy, no VsockDevice.keep), so a
// restored kernel resets kwwasi's connection like any other the host does
// not keep, and kwwasi exits with an error (126).

import type { Vsock, VsockConnection, VsockListener } from "./vsock.ts";
import {
	CH_CPU0, CH_DATA, CH_INITIAL, CH_LEN, CH_MAX, CH_REP, CH_REQ, channelRoom, CPU_BYTES, CPU_DONE, CPU_LIVE, Enc, H_CPU, hostClockNs, OP_DATA, OP_END,
	OP_EXIT, OP_MODULE, OP_REPLY, OP_START, OP_THREAD, type ProgramClock, WASI_MEMORY, WASI_MODULES, WASI_PROTOCOL_VERSION, WASI_THREAD_SPAWN, WASI_TOKEN_BYTES,
	type WasiFromProgram, type WasiProgramEndpoint, type WasiToProgram,
} from "./wasi-program.ts";
import { sharedMemoryAvailable } from "./worker-shared.ts";
import { errorText } from "./output.ts";

export type { WasiFromProgram, WasiProgramEndpoint, WasiProgramPort, WasiToProgram } from "./wasi-program.ts";

/** The host port kwwasi connects to (guest/src/kwwasi.c KWWASI_PORT). */
export const WASI_EXEC_PORT = 1021;

export interface WasiExecOptions {
	/** The vsock port to listen on (default WASI_EXEC_PORT, 1021). */
	port?: number;
	/** The largest module accepted (default 256 MiB). */
	maxModuleBytes?: number;
	log?: (msg: string) => void;
	/** Workers kept for the next program once theirs ended by itself (default 2). */
	idleWorkers?: number;
	/**
	 * Compiled modules kept, least recently used dropped first: at most
	 * `count` (default 16) and `bytes` of module files (default 512 MiB; the
	 * newest is kept even when larger).
	 */
	moduleCache?: { count?: number; bytes?: number };
	/**
	 * Requests through a SharedArrayBuffer per program instead of messages
	 * (default: when this thread can use one, wasiSharedChannelAvailable()).
	 * false: messages and JSPI.
	 */
	sharedMemory?: boolean;
}

/**
 * Can programs use the shared channel: SharedArrayBuffer that can be posted
 * (Node; browsers only when cross-origin isolated), growable, and
 * Atomics.waitAsync (so this thread never blocks).
 */
export function wasiSharedChannelAvailable(): boolean {
	return sharedMemoryAvailable() && typeof Atomics.waitAsync === "function" &&
		typeof (SharedArrayBuffer.prototype as { grow?: unknown }).grow === "function";
}

export interface WasiExecSpawn {
	/** Start a worker running serveWasiProgram() (wasi-program.ts). */
	spawn: () => WasiProgramEndpoint;
}

export interface WasiExecStats {
	/** Programs started, running now, and ended by a trap or an error. */
	started: number;
	running: number;
	failed: number;
	/** wasi-threads threads running now (besides their programs' own). */
	threads: number;
	/** Requests made to kwwasi. */
	requests: number;
	/** Modules kwwasi sent (it sends none the host has), and compiled modules kept. */
	received: number;
	cached: number;
	/** Worker threads alive (running a program or idle), and the idle ones. */
	workers: number;
	idle: number;
	/** Shared channels still served (sharedMemory; 0 once no program runs). */
	channels: number;
}

export interface WasiExecServer {
	readonly port: number;
	/** Requests go through a SharedArrayBuffer (WasiExecOptions.sharedMemory), not messages. */
	readonly shared: boolean;
	readonly stats: WasiExecStats;
	/** Stop listening and end the idle workers (running programs go on). */
	close(): void;
}

/**
 * Reads exact byte counts from a stream; null at its end. The stream's
 * chunks are this reader's own (the connection's copies of the guest's
 * packets), so exact() hands out a chunk that is exactly what was asked
 * for as it is, not a copy.
 */
class ByteReader {
	#reader: ReadableStreamDefaultReader<Uint8Array>;
	#chunks: Uint8Array[] = [];
	#have = 0;
	constructor(stream: ReadableStream<Uint8Array>) {
		this.#reader = stream.getReader();
	}
	async exact(n: number): Promise<Uint8Array | null> {
		if (!(await this.#fill(n))) return null;
		const c = this.#chunks[0]!;
		if (c.length === n) {
			this.#chunks.shift();
			this.#have -= n;
			return c;
		}
		const out = new Uint8Array(n);
		this.#take(out);
		return out;
	}
	/** Fill `out`; false at the stream's end. */
	async into(out: Uint8Array): Promise<boolean> {
		if (!(await this.#fill(out.length))) return false;
		this.#take(out);
		return true;
	}
	/** Have at least `n` bytes; false at the stream's end. */
	async #fill(n: number): Promise<boolean> {
		while (this.#have < n) {
			let r: ReadableStreamReadResult<Uint8Array>;
			try {
				r = await this.#reader.read();
			} catch {
				return false;
			}
			if (r.done) return false;
			this.#chunks.push(r.value);
			this.#have += r.value.length;
		}
		return true;
	}
	#take(out: Uint8Array): void {
		const n = out.length;
		let at = 0;
		while (at < n) {
			const c = this.#chunks[0]!;
			const take = Math.min(c.length, n - at);
			out.set(c.subarray(0, take), at);
			at += take;
			if (take === c.length) this.#chunks.shift();
			else this.#chunks[0] = c.subarray(take);
		}
		this.#have -= n;
	}
	cancel(): void {
		this.#reader.cancel().catch(() => {});
	}
}

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * Start the host side: compile the guest's WASI programs that kwwasi sends
 * and run each in a worker of its own (`spawn`).
 */
export function serveWasiProgramsWith(vsock: Vsock, opts: WasiExecOptions & WasiExecSpawn): WasiExecServer {
	const port = opts.port ?? WASI_EXEC_PORT;
	const log = opts.log ?? (() => {});
	const maxModule = opts.maxModuleBytes ?? 256 << 20;
	const stats: WasiExecStats = { started: 0, running: 0, threads: 0, failed: 0, requests: 0, received: 0, cached: 0, workers: 0, idle: 0, channels: 0 };
	const cache = new ModuleCache(opts.moduleCache?.count ?? 16, opts.moduleCache?.bytes ?? 512 << 20, stats);
	const pool = new WorkerPool(opts.spawn, opts.idleWorkers ?? 2, stats);
	const shared = opts.sharedMemory ?? wasiSharedChannelAvailable();
	const ctx: RunContext = { log, maxModule, stats, cache, pool, shared, programs: new Map() };
	const listener: VsockListener = vsock.listen(port, (conn) => {
		void accept(conn, ctx).catch((e) => log(`[wasi] ${errorText(e)}`));
	});
	return {
		port,
		shared,
		stats,
		close: () => {
			listener.close();
			pool.close();
		},
	};
}

interface RunContext {
	log: (msg: string) => void;
	maxModule: number;
	stats: WasiExecStats;
	cache: ModuleCache;
	pool: WorkerPool;
	shared: boolean;
	/** Running programs by their token (MODULE gave it to kwwasi; its THREAD frames bring it back). */
	programs: Map<string, Program>;
	/** The best guest-minus-host monotonic offset of recent STARTs (programClock()). */
	clockBest?: { offset: bigint; at: bigint };
}

/** How long the best START's clock offset is kept (ns; programClock()). */
const CLOCK_BEST_NS = 10_000_000_000n;

/**
 * A program's clocks from its START's readings of the guest's realtime and
 * monotonic clocks, taken by the host at `host`. The guest's monotonic
 * clock is the host's plus an offset that only grows (Kernel.advanceClock;
 * a restored machine is another VsockHost), and each START's reading
 * arrives late by its delivery (the guest's send, then this thread's next
 * turn of its event loop: at most 0.2-0.35 ms in test/wasi-binfmt.ts, up to
 * 9 ms just after boot, 2026-11-27), so it gives that
 * offset less the delay: the largest of the last CLOCK_BEST_NS is the
 * nearest (a guest whose monotonic clock is slewed, by an NTP daemon, moves
 * the true offset meanwhile; not seen here). The realtime clock is the
 * monotonic one plus their difference in the guest, read together.
 */
function programClock(ctx: RunContext, real: bigint, mono: bigint, host: bigint): ProgramClock {
	const sample = mono - host, best = ctx.clockBest;
	let offset = sample;
	if (best && host - best.at < CLOCK_BEST_NS && best.offset > sample) offset = best.offset;
	else ctx.clockBest = { offset, at: host };
	return { mono: offset, real: offset + real - mono, start: host };
}

/** A compiled module, and the limits of the memory it imports (WebAssembly.Module.imports() leaves them out). */
interface Compiled {
	module: WebAssembly.Module;
	memory?: MemoryImport;
}
interface MemoryImport {
	initial: number;
	maximum?: number;
	shared: boolean;
	memory64: boolean;
	/** Not an import: the module's own memory, reported only when it is 64-bit. */
	own?: boolean;
}

/**
 * The memory a module imports as env.memory (WASI_MEMORY), from its import
 * section: undefined when it imports none (but a 64-bit memory of its own is
 * reported, as `own`). Only needs to be right for a
 * module that compiles.
 */
function importedMemory(b: Uint8Array): MemoryImport | undefined {
	let at = 8;
	const byte = () => {
		if (at >= b.length) throw new RangeError("truncated module");
		return b[at++]!;
	};
	const leb = () => {
		let v = 0;
		for (let shift = 0; ; shift += 7) {
			const c = byte();
			v += (c & 0x7f) * 2 ** shift;
			if (!(c & 0x80)) return v;
		}
	};
	const name = () => {
		const n = leb();
		const s = utf8d.decode(b.subarray(at, at + n));
		at += n;
		return s;
	};
	/** A value or element type: a reference type with a heap type ((ref null? ht), 0x63 and 0x64) takes more bytes. */
	const valtype = () => {
		const t = byte();
		if (t === 0x63 || t === 0x64) leb();
	};
	while (at < b.length) {
		const id = byte(), size = leb(), end = at + size;
		// The import section (2) comes after the custom (0) and type (1) sections only; the memory section is 5.
		if (id > 5) return undefined;
		if (id === 5) {
			// A memory of its own: only whether it is 64-bit (wasm64) matters, which no WASI preview 1 host runs.
			if (leb() > 0 && byte() & 4) return { initial: 0, shared: false, memory64: true, own: true };
			return undefined;
		}
		if (id === 2) {
			for (let n = leb(); n > 0; n--) {
				const mod = name(), field = name(), kind = byte();
				if (kind === 0) {
					leb(); // a function: its type
				} else if (kind === 1 || kind === 2) {
					if (kind === 1) valtype(); // a table: its element type, then limits
					const flags = byte(), initial = leb(), maximum = flags & 1 ? leb() : undefined;
					if (kind === 2 && mod === WASI_MEMORY.module && field === WASI_MEMORY.name)
						return { initial, maximum, shared: (flags & 2) !== 0, memory64: (flags & 4) !== 0 };
				} else if (kind === 3) {
					valtype(); // a global: its type and mutability
					byte();
				} else if (kind === 4) {
					byte(); // a tag: its attribute and type
					leb();
				} else {
					return undefined;
				}
			}
		}
		at = end;
	}
	return undefined;
}

/**
 * Compiled modules, by the SHA-256 of their bytes (a counter where there is
 * no crypto.subtle), and the identities kwwasi gave for those bytes (size,
 * dev, ino, mtime, ctime of the file it opened; only settled ones, whose
 * ctime was 2 s old, kwwasi.c). Identities are this
 * machine's: one ModuleCache belongs to one serveWasiPrograms(), that is
 * one VsockHost, and a machine restored from a snapshot is another
 * VsockHost with its own (inode numbers mean nothing across machines).
 * Bounded by count and bytes, least recently used first; at most
 * ID_LIMIT identities.
 */
class ModuleCache {
	#modules = new Map<string, { module: Promise<Compiled>; bytes: number }>();
	#bytes = 0;
	#ids = new Map<string, Promise<string | undefined>>();
	#count: number;
	#limit: number;
	#stats: WasiExecStats;
	#serial = 0;
	static readonly ID_LIMIT = 256;

	constructor(count: number, bytes: number, stats: WasiExecStats) {
		this.#count = Math.max(1, count);
		this.#limit = bytes;
		this.#stats = stats;
	}

	/**
	 * The module for identity `id`, or a claim: the caller gets the bytes
	 * and calls claim() with compile()'s key once they compiled (undefined
	 * when it failed or the file changed while kwwasi read it). A program
	 * that starts while another with the same identity is being sent waits
	 * for that one.
	 */
	async acquire(id: string): Promise<{ module: Compiled } | { claim: (key: string | undefined) => void }> {
		for (;;) {
			const p = this.#ids.get(id);
			if (!p) {
				let done!: (key: string | undefined) => void;
				const mine = new Promise<string | undefined>((r) => (done = r));
				this.#ids.set(id, mine);
				while (this.#ids.size > ModuleCache.ID_LIMIT) this.#ids.delete(this.#ids.keys().next().value!);
				let claimed = false;
				return {
					claim: (key) => {
						if (claimed) return;
						claimed = true;
						if (!key && this.#ids.get(id) === mine) this.#ids.delete(id);
						done(key);
					},
				};
			}
			this.#ids.delete(id); // most recently used last
			this.#ids.set(id, p);
			const key = await p;
			const e = key ? this.#touch(key) : undefined;
			const module = e && (await e.module.catch(() => undefined));
			if (module) return { module };
			if (this.#ids.get(id) === p) this.#ids.delete(id);
		}
	}

	#touch(key: string) {
		const e = this.#modules.get(key);
		if (e) {
			this.#modules.delete(key);
			this.#modules.set(key, e);
		}
		return e;
	}

	/** Compile `bytes`, or share the module compiled from the same bytes. */
	async compile(bytes: Uint8Array): Promise<{ key: string; module: Promise<Compiled> }> {
		const subtle = globalThis.crypto?.subtle;
		const key = subtle
			? Array.from(new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource)), (b) => b.toString(16).padStart(2, "0")).join("")
			: `#${++this.#serial}`;
		const had = this.#touch(key);
		if (had) return { key, module: had.module };
		let memory: MemoryImport | undefined;
		try {
			memory = importedMemory(bytes);
		} catch {
			// not a valid module: compile() says why
		}
		const e = { module: WebAssembly.compile(bytes as BufferSource).then((module): Compiled => ({ module, memory })), bytes: bytes.length };
		e.module.catch(() => {
			if (this.#modules.get(key) === e) this.#drop(key);
		});
		this.#modules.set(key, e);
		this.#bytes += e.bytes;
		while (this.#modules.size > 1 && (this.#modules.size > this.#count || this.#bytes > this.#limit)) this.#drop(this.#modules.keys().next().value!);
		this.#stats.cached = this.#modules.size;
		return { key, module: e.module };
	}

	#drop(key: string): void {
		const e = this.#modules.get(key);
		if (!e) return;
		this.#modules.delete(key);
		this.#bytes -= e.bytes;
		this.#stats.cached = this.#modules.size;
	}
}

/** kwwasi.c's MAX_FRAME, CHUNK and the identity's size (without its u64 flags). */
const MAX_FRAME = 64 << 20;
const MAX_DATA = 256 << 10;
const IDENTITY = 40;

/**
 * The module's DATA frames, `size` bytes, and END; `same`: END's identity is
 * START's (the file did not change while kwwasi read it). Null when kwwasi
 * went away or broke the protocol.
 */
async function receiveModule(reader: ByteReader, size: number, identity: Uint8Array): Promise<{ bytes: Uint8Array; same: boolean } | null> {
	const bytes = new Uint8Array(size);
	for (let at = 0; ;) {
		const h = await reader.exact(8);
		if (!h) return null;
		const hv = view(h);
		const op = hv.getUint32(0, true), len = hv.getUint32(4, true);
		if (at < size) {
			if (op !== OP_DATA || len === 0 || len > MAX_DATA || len > size - at) return null;
			if (!(await reader.into(bytes.subarray(at, at + len)))) return null;
			at += len;
			continue;
		}
		if (op !== OP_END || len !== IDENTITY + 8) return null;
		const end = await reader.exact(IDENTITY + 8);
		if (!end) return null;
		return { bytes, same: identity.every((b, i) => b === end[i]) };
	}
}

/** kwwasi's first frame on a connection: START (a program), or THREAD (one of its threads, wasi-threads). */
async function accept(conn: VsockConnection, ctx: RunContext): Promise<void> {
	const reader = new ByteReader(conn.readable);
	const head = await reader.exact(8);
	if (!head) return conn.reset();
	const hv = view(head);
	const op = hv.getUint32(0, true);
	const len = hv.getUint32(4, true);
	if ((op !== OP_START && op !== OP_THREAD) || len > MAX_FRAME) {
		ctx.log(`[wasi] bad first frame (op ${op}, ${len} bytes)`);
		return conn.reset();
	}
	const payload = await reader.exact(len);
	if (!payload) return conn.reset();
	return op === OP_START ? runProgram(conn, reader, payload, ctx) : attachThread(conn, reader, payload, ctx);
}

/** THREAD: u32 version, the program's token, u32 tid, u32 start argument (kwwasi.c). */
function attachThread(conn: VsockConnection, reader: ByteReader, t: Uint8Array, ctx: RunContext): void {
	const tv = view(t);
	const prog = t.length === 12 + WASI_TOKEN_BYTES && tv.getUint32(0, true) === WASI_PROTOCOL_VERSION
		? ctx.programs.get(hex(t.subarray(4, 4 + WASI_TOKEN_BYTES)))
		: undefined;
	if (!prog || prog.ended) {
		ctx.log("[wasi] a thread of no running program; connection reset");
		return conn.reset();
	}
	const tid = tv.getUint32(4 + WASI_TOKEN_BYTES, true), arg = tv.getUint32(8 + WASI_TOKEN_BYTES, true);
	prog.run(new Link(conn, reader, ctx, prog.name, () => prog.end()), { tid, arg });
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function runProgram(conn: VsockConnection, reader: ByteReader, start: Uint8Array, ctx: RunContext): Promise<void> {
	// The host's clock when START came, against which its guest clock readings become offsets (ProgramClock).
	const host = hostClockNs();
	let prog: Program | undefined;
	const link = new Link(conn, reader, ctx, "", () => prog?.end());
	const sv = view(start);
	let at = 0;
	const u32 = () => {
		const v = sv.getUint32(at, true);
		at += 4;
		return v;
	};
	const str = () => {
		const n = u32();
		const s = start.slice(at, at + n);
		at += n;
		return s;
	};
	let args: Uint8Array[], env: Uint8Array[], identity: Uint8Array, size: number, unsettled: boolean, clock: ProgramClock;
	const preopens: Array<[number, Uint8Array]> = [];
	try {
		const version = u32();
		if (version !== WASI_PROTOCOL_VERSION)
			return link.exit(126, `kwwasi: protocol version ${version}, the host speaks ${WASI_PROTOCOL_VERSION}`);
		const argc = u32(), envc = u32(), npre = u32();
		identity = start.slice(at, at + IDENTITY);
		size = Number(sv.getBigUint64(at, true));
		unsettled = (sv.getBigUint64(at + IDENTITY, true) & 1n) !== 0n;
		at += IDENTITY + 8;
		clock = programClock(ctx, sv.getBigUint64(at, true), sv.getBigUint64(at + 8, true), host);
		at += 16;
		args = Array.from({ length: argc }, str);
		env = Array.from({ length: envc }, str);
		for (let i = 0; i < npre; i++) {
			const fd = u32();
			preopens.push([fd, str()]);
		}
	} catch (e) {
		ctx.log(`[wasi] bad START frame: ${(e as Error).message}`);
		return conn.reset();
	}
	const name = utf8d.decode(args[0] ?? new Uint8Array());
	link.name = name;
	if (size > ctx.maxModule) return link.exit(126, `kwwasi: ${name}: ${size} bytes, larger than the host takes (${ctx.maxModule})`);

	// MODULE also gives kwwasi the program's token, which its threads' connections bring back (THREAD).
	const token = new Uint8Array(WASI_TOKEN_BYTES);
	crypto.getRandomValues(token);
	// The module: compiled before for this identity, or sent now (always for a file changed just now, UNSETTLED).
	let compiled: Compiled;
	const got = unsettled ? undefined : await ctx.cache.acquire(Array.from(identity).join(","));
	if (got && "module" in got) {
		link.send(new Enc().u32(0).bytes(token).frame(OP_MODULE));
		compiled = got.module;
	} else {
		let key: string | undefined;
		try {
			link.send(new Enc().u32(1).bytes(token).frame(OP_MODULE));
			const bytes = await receiveModule(reader, size, identity);
			if (!bytes) {
				ctx.log(`[wasi] ${name}: kwwasi did not send the module; connection reset`);
				return conn.reset();
			}
			ctx.stats.received++;
			const c = await ctx.cache.compile(bytes.bytes);
			try {
				compiled = await c.module;
			} catch (e) {
				return link.exit(126, `kwwasi: ${name}: not a valid WebAssembly module: ${(e as Error).message}`);
			}
			if (bytes.same) key = c.key;
		} finally {
			got?.claim(key);
		}
	}
	const { module } = compiled;
	let threads = false, memoryImport = false;
	for (const imp of WebAssembly.Module.imports(module)) {
		if (WASI_MODULES.includes(imp.module)) continue;
		if (imp.module === WASI_MEMORY.module && imp.name === WASI_MEMORY.name && imp.kind === "memory") memoryImport = true;
		else if (imp.module === WASI_THREAD_SPAWN.module && imp.name === WASI_THREAD_SPAWN.name && imp.kind === "function") threads = true;
		else {
			return link.exit(126, `kwwasi: ${name}: imports ${imp.module}.${imp.name}; only wasi_snapshot_preview1, wasi_unstable, ` +
				"and for wasi-threads wasi.thread-spawn and env.memory, are provided");
		}
	}
	const exports = WebAssembly.Module.exports(module);
	const hasStart = exports.some((e) => e.name === "_start" && e.kind === "function");
	if (!hasStart) return link.exit(126, `kwwasi: ${name}: no _start export (not a WASI command)`);
	if (compiled.memory?.own) return link.exit(126, `kwwasi: ${name}: a wasm64 module (64-bit memory); WASI preview 1 is wasm32 only`);
	const mem = memoryImport ? compiled.memory : undefined;
	if (memoryImport && (!mem || mem.memory64)) return link.exit(126, `kwwasi: ${name}: imports a memory this host cannot make (${mem ? "64-bit" : "unreadable limits"})`);
	if (threads && !mem?.shared) return link.exit(126, `kwwasi: ${name}: imports wasi.thread-spawn but no shared env.memory (wasi-threads needs one)`);
	if (threads && !exports.some((e) => e.name === "wasi_thread_start" && e.kind === "function"))
		return link.exit(126, `kwwasi: ${name}: imports wasi.thread-spawn but exports no wasi_thread_start`);
	// Threads share their memory and block on their own channels: SharedArrayBuffer, so the shared path only.
	if (mem?.shared && !ctx.shared) {
		return link.exit(126, `kwwasi: ${name}: ${threads ? "a wasi-threads module" : "a module with a shared memory"} needs SharedArrayBuffer ` +
			"(Node, or a cross-origin isolated page), and this host passes requests as messages");
	}
	let memory: WebAssembly.Memory | undefined;
	if (mem?.shared) {
		try {
			memory = new WebAssembly.Memory({ initial: mem.initial, maximum: mem.maximum, shared: true } as WebAssembly.MemoryDescriptor);
		} catch (e) {
			return link.exit(126, `kwwasi: ${name}: cannot make its shared memory: ${(e as Error)?.message ?? e}`);
		}
	}
	prog = new Program(ctx, hex(token), name, compiled, { args, env, preopens, clock }, memory);
	prog.run(link);
}

/**
 * One kwwasi connection and the requests a worker makes over it: the
 * program's, or one of its threads'. One request at a time, as kwwasi
 * serves each connection; `broken` is called when kwwasi went away
 * mid-request or broke the protocol (the connection is reset then).
 */
class Link {
	readonly conn: VsockConnection;
	readonly reader: ByteReader;
	name: string;
	/** No more requests (stop()). */
	stopped = false;
	#writer: WritableStreamDefaultWriter<Uint8Array | string>;
	#ctx: RunContext;
	#broken: () => void;
	#replyHead = new Uint8Array(8);
	#replyView = view(this.#replyHead);
	/** The message path's requests, in order (each waits for the one before). */
	#queue = Promise.resolve();
	#ctl: Int32Array | undefined;
	/** H_CPU's answer (a threaded program's channel): the CPU time of the program's other threads (ns). */
	cpu: (() => Promise<bigint>) | undefined;

	constructor(conn: VsockConnection, reader: ByteReader, ctx: RunContext, name: string, broken: () => void) {
		this.conn = conn;
		this.reader = reader;
		this.name = name;
		this.#writer = conn.writable.getWriter();
		this.#ctx = ctx;
		this.#broken = broken;
	}

	// Written as it is, not copied: the connection copies what it is given
	// (vsock.ts), and a request's frame in the shared channel is overwritten
	// only after its reply, which kwwasi sends once it has read all of it.
	send(b: Uint8Array): void {
		this.#writer.write(b).catch(() => {});
	}
	/** EXIT (kwwasi exits with `code`, writing `msg` to stderr), and nothing more from this side. */
	exit(code: number, msg = ""): void {
		this.send(new Enc().u32(code).bytes(utf8.encode(msg)).frame(OP_EXIT));
		this.closeWrite();
	}
	closeWrite(): void {
		this.#writer.close().catch(() => {});
	}
	/** No more requests: the reader and the channel's loop end. */
	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.reader.cancel();
		if (this.#ctl) Atomics.notify(this.#ctl, CH_REQ); // ends the channel's waitAsync
	}

	/**
	 * One request to kwwasi: its REPLY body, or null when it is stopped or
	 * broken. `place` gives where the body goes (the shared channel), else
	 * it is a buffer of its own (transferable); undefined from it: no room.
	 */
	async request(frame: Uint8Array, place?: (len: number) => Uint8Array | undefined): Promise<Uint8Array | null> {
		if (this.stopped) return null;
		this.#ctx.stats.requests++;
		this.send(frame);
		const h = await this.reader.into(this.#replyHead);
		const len = h && this.#replyView.getUint32(0, true) === OP_REPLY ? this.#replyView.getUint32(4, true) : -1;
		let body: Uint8Array | null = null;
		if (len >= 4) {
			const at = place?.(len);
			if (place && !at) {
				this.#ctx.log(`[wasi] ${this.name}: a reply of ${len} bytes from kwwasi; connection reset`);
				this.#fail();
				return null;
			}
			body = at ? ((await this.reader.into(at)) ? at : null) : await this.reader.exact(len);
		}
		if (this.stopped) return null;
		if (!body) {
			// kwwasi went away mid-request, or broke the protocol.
			if (h) this.#ctx.log(`[wasi] ${this.name}: unexpected frame from kwwasi; connection reset`);
			this.#fail();
			return null;
		}
		return body;
	}
	#fail(): void {
		this.conn.reset();
		this.#broken();
	}

	/** The message path: a "request" message's frame, its body to `reply`. */
	queue(frame: Uint8Array, reply: (body: Uint8Array) => void): void {
		this.#queue = this.#queue.then(async () => {
			const body = await this.request(frame);
			if (body) reply(body);
		});
	}
	/** `f` once the requests queued so far are answered. */
	after(f: () => void): void {
		this.#queue = this.#queue.then(f);
	}

	/**
	 * The shared path: a channel (CH_*) whose requests this serves until
	 * stop(), waiting (never blocking) for the worker to bump CH_REQ, then
	 * answering in place and setting CH_REP.
	 */
	channel(): SharedArrayBuffer {
		const channel = new SharedArrayBuffer(CH_INITIAL, { maxByteLength: CH_MAX });
		const ctl = this.#ctl = new Int32Array(channel, 0, CH_DATA / 4);
		const op = new Uint32Array(channel, CH_DATA, 1);
		const serve = async () => {
			let seen = 0;
			for (;;) {
				const w = Atomics.waitAsync(ctl, CH_REQ, seen);
				if (w.async) await w.value;
				if (this.stopped) return;
				const seq = Atomics.load(ctl, CH_REQ);
				if (seq === seen) continue;
				seen = seq;
				const len = Atomics.load(ctl, CH_LEN);
				let n: number;
				if (this.cpu && len === 8 && op[0] === H_CPU) {
					const ns = await this.cpu();
					if (this.stopped) return;
					const dv = new DataView(channel, CH_DATA, 12);
					dv.setInt32(0, 0, true);
					dv.setBigUint64(4, ns, true);
					n = 12;
				} else {
					// The reply is read straight into the channel, over the request.
					const body = await this.request(new Uint8Array(channel, CH_DATA, len), (n) => channelRoom(channel, n) ? new Uint8Array(channel, CH_DATA, n) : undefined);
					if (!body) return;
					n = body.length;
				}
				Atomics.store(ctl, CH_LEN, n);
				Atomics.store(ctl, CH_REP, seq);
				Atomics.notify(ctl, CH_REP);
			}
		};
		// "exit" and "done" come after the last reply was taken, so they need not wait for this loop.
		this.#ctx.stats.channels++;
		void serve()
			.catch((e) => {
				this.#ctx.log(`[wasi] ${this.name}: ${errorText(e)}`);
				this.#fail();
			})
			.finally(() => this.#ctx.stats.channels--);
		return channel;
	}
}

/** What every thread's "start" brings of its program's START. */
type ProgramStart = Pick<Extract<WasiToProgram, { t: "start" }>, "args" | "env" | "preopens" | "clock">;

/** One of a program's threads: its connection and its worker (tid 0: the program's own, `_start`). */
interface Part {
	link: Link;
	worker: ProgramWorker;
	tid: number;
	/** A thread whose wasi_thread_start returned. */
	done: boolean;
	/** A threaded program's: the channel's CH_CPU0 (the thread's start), the CPU time (ns) its last sample gave, and its total once it returned. */
	cpu0?: BigInt64Array;
	seen: bigint;
	final?: bigint;
}

/** How long a sample of a worker's CPU time may take (ms) before its last one stands in. */
const CPU_SAMPLE_MS = 250;

/** A thread's CPU time (ns): its total once it returned, else a sample of its worker's now (Part.cpu0), else the last one. */
async function partCpu(p: Part): Promise<bigint> {
	const ep = p.worker.ep;
	if (ep.cpuUsage && p.final === undefined) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const us = await Promise.race([
			ep.cpuUsage().catch(() => undefined),
			new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), CPU_SAMPLE_MS))),
		]);
		clearTimeout(timer);
		const base = p.cpu0 ? Atomics.load(p.cpu0, CH_CPU0) : -1n;
		if (us !== undefined && base >= 0n) {
			const ns = (BigInt(Math.round(us)) - base) * 1000n;
			if (ns > p.seen) p.seen = ns;
		}
	}
	return p.final ?? p.seen;
}

/**
 * A running program: its connection and worker, and those of its threads
 * (wasi-threads: each thread has a worker of its own on the same compiled
 * module and shared memory, and a connection of its own to a pthread of
 * kwwasi, so a thread blocked in a read holds up no other). It ends as a
 * whole: proc_exit, a trap or an error in any thread, a return from
 * `_start`, or a connection lost; the worker whose thread ended by itself
 * is kept for the next program, the others are terminated.
 */
class Program {
	readonly name: string;
	ended = false;
	#ctx: RunContext;
	#token: string;
	#compiled: Compiled;
	#start: ProgramStart;
	#memory: WebAssembly.Memory | undefined;
	/** A threaded program's CPU words ("start"'s `cpu`: CPU_DONE, CPU_LIVE). */
	#cpu: SharedArrayBuffer | undefined;
	#cpuDone: BigInt64Array | undefined;
	#cpuLive: Int32Array | undefined;
	#main: Part | undefined;
	#parts = new Set<Part>();

	constructor(ctx: RunContext, token: string, name: string, compiled: Compiled, start: ProgramStart, memory?: WebAssembly.Memory) {
		this.#ctx = ctx;
		this.#token = token;
		this.name = name;
		this.#compiled = compiled;
		this.#start = start;
		this.#memory = memory;
		if (memory) {
			this.#cpu = new SharedArrayBuffer(CPU_BYTES);
			this.#cpuDone = new BigInt64Array(this.#cpu, 0, 1);
			this.#cpuLive = new Int32Array(this.#cpu, CPU_LIVE * 4, 1);
		}
	}

	/** Run the program on `link` with a worker of its own, or (`thread`) one of its threads. */
	run(link: Link, thread?: { tid: number; arg: number }): void {
		const ctx = this.#ctx;
		let worker: ProgramWorker;
		try {
			worker = ctx.pool.take();
		} catch (e) {
			const msg = `kwwasi: ${this.name}: cannot start a worker: ${(e as Error)?.message ?? e}`;
			if (thread) {
				link.conn.reset();
				this.end({ code: 126, msg });
			} else link.exit(126, msg);
			return;
		}
		const part: Part = { link, worker, tid: thread?.tid ?? 0, done: false, seen: 0n };
		this.#parts.add(part);
		if (thread) {
			ctx.stats.threads++;
		} else {
			this.#main = part;
			ctx.programs.set(this.#token, this);
			ctx.stats.started++;
			ctx.stats.running++;
		}
		const channel = ctx.shared ? link.channel() : undefined;
		if (channel && this.#cpu) {
			// Counted before its worker starts (CPU_LIVE), from its start on (CH_CPU0, the worker writes it).
			part.cpu0 = new BigInt64Array(channel, 0, CH_DATA / 8);
			Atomics.store(part.cpu0, CH_CPU0, -1n);
			Atomics.add(this.#cpuLive!, 0, 1);
			link.cpu = () => this.#othersCpu(part);
		}
		worker.on = {
			message: (m) => {
				if (m.t === "request") {
					link.queue(m.frame, (body) => worker.ep.post({ t: "reply", body }, [body.buffer as ArrayBuffer]));
				} else if (m.t === "exit") {
					if (m.failed) ctx.stats.failed++;
					link.after(() => this.end({ code: m.code, msg: m.msg }, worker));
				} else if (m.t === "done") {
					this.#threadDone(part, m.cpu);
				} else if (m.t === "log") {
					ctx.log(m.msg);
				}
			},
			gone: (e) => {
				if (this.ended) return;
				ctx.stats.failed++;
				this.end({ code: 134, msg: `kwwasi: ${this.name}: ${e ? (e as Error)?.message ?? e : "its worker ended"}` });
			},
		};
		void link.conn.closed.then(() => {
			if (this.ended || part.done) return;
			ctx.log(`[wasi] ${this.name}: kwwasi went away; worker${this.#parts.size > 1 ? "s" : ""} terminated`);
			this.end();
		});
		const { module, memory: mem } = this.#compiled;
		const start: Extract<WasiToProgram, { t: "start" }> = { t: "start", module, name: this.name, ...this.#start, channel, thread, cpu: this.#cpu };
		if (this.#memory) start.memory = this.#memory;
		else if (mem) start.memoryType = { initial: mem.initial, maximum: mem.maximum };
		worker.ep.post(start);
	}

	/** A thread returned (`cpu`: its CPU time, ns): its connection ends (and kwwasi's pthread for it), its worker can run something else. */
	#threadDone(part: Part, cpu?: bigint): void {
		if (this.ended || part.done) return;
		part.done = true;
		if (part.cpu0) {
			part.final = cpu ?? part.seen;
			Atomics.add(this.#cpuDone!, CPU_DONE, part.final);
			Atomics.sub(this.#cpuLive!, 0, 1);
		}
		this.#parts.delete(part);
		this.#ctx.stats.threads--;
		part.link.stop();
		part.link.closeWrite();
		this.#ctx.pool.release(part.worker, true);
	}

	/**
	 * H_CPU from `asker`: the CPU time of the program's other threads (ns),
	 * those that returned (CPU_DONE) and the others' now, each sampled on
	 * its worker's thread. Both are taken at once: a thread whose "done"
	 * comes while the samples are taken counts its total (Part.final), not
	 * twice.
	 */
	async #othersCpu(asker: Part): Promise<bigint> {
		let sum = Atomics.load(this.#cpuDone!, CPU_DONE);
		const parts = [...this.#parts].filter((p) => p !== asker);
		for (const ns of await Promise.all(parts.map(partCpu))) sum += ns;
		return sum;
	}

	/**
	 * The program has ended: `status` is sent as EXIT (none when kwwasi went
	 * away); `by`: the worker whose thread ended by itself, kept for the next
	 * program. Every other worker is terminated, wherever it is.
	 */
	end(status?: { code: number; msg: string }, by?: ProgramWorker): void {
		if (this.ended) return;
		this.ended = true;
		const ctx = this.#ctx;
		ctx.programs.delete(this.#token);
		ctx.stats.running--;
		if (status) this.#main?.link.exit(status.code, status.msg);
		for (const part of this.#parts) {
			part.link.stop();
			if (part !== this.#main) {
				part.link.closeWrite();
				ctx.stats.threads--;
			}
			ctx.pool.release(part.worker, part.worker === by);
		}
		this.#parts.clear();
	}
}

/** A program worker and whoever uses it now. */
interface ProgramWorker {
	ep: WasiProgramEndpoint;
	/** The running program's handlers (undefined while idle). */
	on: { message(m: WasiFromProgram): void; gone(err?: unknown): void } | undefined;
	alive: boolean;
}

/**
 * Program workers: a new one per program, or an idle one whose last
 * program ended by itself (proc_exit, return, trap: its stack unwound and
 * its instance is garbage). Up to `max` idle ones are kept, so a program
 * run again does not wait for a worker to start. A worker ended for a
 * kill is terminated, never reused.
 */
class WorkerPool {
	#spawn: () => WasiProgramEndpoint;
	#idle: ProgramWorker[] = [];
	#max: number;
	#stats: WasiExecStats;
	#closed = false;

	constructor(spawn: () => WasiProgramEndpoint, max: number, stats: WasiExecStats) {
		this.#spawn = spawn;
		this.#max = max;
		this.#stats = stats;
	}

	take(): ProgramWorker {
		const idle = this.#idle.pop();
		if (idle) {
			this.#stats.idle--;
			return idle;
		}
		const w: ProgramWorker = { ep: this.#spawn(), on: undefined, alive: true };
		this.#stats.workers++;
		const gone = (err?: unknown) => {
			if (!w.alive) return;
			w.alive = false;
			this.#stats.workers--;
			const i = this.#idle.indexOf(w);
			if (i >= 0) {
				this.#idle.splice(i, 1);
				this.#stats.idle--;
			}
			const on = w.on;
			w.on = undefined;
			on?.gone(err);
		};
		w.ep.listen({
			message: (m) => w.on?.message(m),
			error: (e) => {
				gone(e);
				w.ep.terminate();
			},
			exit: () => gone(),
		});
		return w;
	}

	release(w: ProgramWorker, reusable: boolean): void {
		w.on = undefined;
		if (!w.alive) return;
		if (reusable && !this.#closed && this.#idle.length < this.#max) {
			this.#idle.push(w);
			this.#stats.idle++;
		} else {
			w.ep.terminate();
		}
	}

	close(): void {
		this.#closed = true;
		// Each leaves #idle (and stats.idle) when it is gone, as any other worker.
		for (const w of [...this.#idle]) w.ep.terminate();
	}
}
