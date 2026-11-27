// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A 9P2000.L file server on vsock: host-defined file systems in the guest.
//
// The guest's kw9p (guest/src/kw9p.c) connects to host CID 2, port 564,
// and mounts 9p with trans=fd on that socket and `aname=NAME`, so the
// kernel's 9p client talks to this server directly. One server listens per
// VM; each mount is its own export, with an attach name add() makes up, and
// its own connection: the first connection that attaches to an export owns
// it, and any other gets EBUSY. mounts.ts builds vm.mount() and
// createKernel({ mounts }) on this; the handler types (fs.ts) are public,
// nothing here is.
//
// - Framing: size u32 (whole message), type u8, tag u16, then the body;
//   integers little-endian, strings u16 length + UTF-8, a qid is u8 type,
//   u32 version, u64 path. A message within one received chunk is a view of
//   it; one spanning chunks is copied once.
// - Window: at most WINDOW requests run at once per connection; a request
//   holds its slot until its reply is sent, so replies alive at once stay
//   within WINDOW x msize. Up to QUEUE more wait parsed; beyond that the
//   connection stops reading, so vsock credit stops the guest's sends.
//   Tflush always goes through: a queued request is dropped, a running one
//   is answered Rflush at once and its late reply dropped.
// - Requests run concurrently and are answered as they finish (9P allows
//   any order), except that writes, truncation, fsync and clunk through one
//   fid run in order. A handler that does not settle within the export's
//   timeout (30 s by default) is answered ETIMEDOUT and logged, so a hung
//   handler cannot leave guest processes waiting forever; what it returns
//   later is dropped (an open file is closed).
// - Names are UTF-8: a name that is not (in a walk, create, rename, ...)
//   is answered EILSEQ, never decoded lossily, so two names cannot alias.
// - Inode numbers (qid.path) are the backend's (dev, ino), else a hash of
//   the path. qid.version is the backend's `version`, else from mtime and
//   size; 0 makes the guest read the file uncached (computed files).
// - Snapshots (mounts.ts): at the snapshot point a quiet session (nothing
//   in flight) is saved as its fids (path, type, how a file was opened and
//   its inode number, a directory listing being read); a restore opens the
//   files again by path. One that is gone, is another file now, or was
//   unlinked or replaced by the guest while open answers ESTALE.

import type { MaybePromise } from "./block.ts";
import { ERRNO, FS_DEFAULT_OWNER, FsError, type Fs, type FsAttr, type FsDirEntry, type FsFile, type FsFileType, type FsSetAttr } from "./fs.ts";
import type { MountStats } from "./mounts.ts";
import { saveVsockConnection, type Vsock, type VsockConnection, type VsockConnSnapshot, type VsockListener } from "./vsock.ts";
import { errorText } from "./output.ts";

/** The 9p server's vsock port (the 9P well-known port; kw9p's). */
export const P9_PORT = 564;
/** The msize the server offers: the largest message, header included (kw9p asks for the same). */
const MSIZE = 128 * 1024;
/** How long a handler may take before the guest gets ETIMEDOUT, in ms (MountOptions.requestTimeout). */
const DEFAULT_TIMEOUT = 30000;
const P9_VERSION = "9P2000.L";
const HDR = 7;
/** Requests running at once per connection. */
const WINDOW = 16;
/** Requests parsed and waiting for a slot before the connection stops reading. */
const QUEUE = 16;

// Message types (9P2000.L); a reply is the request's type + 1.
const Rlerror = 7, Tstatfs = 8, Tlopen = 12, Tlcreate = 14, Tsymlink = 16, Tmknod = 18, Trename = 20,
	Treadlink = 22, Tgetattr = 24, Tsetattr = 26, Txattrwalk = 30, Txattrcreate = 32, Treaddir = 40,
	Tfsync = 50, Tlock = 52, Tgetlock = 54, Tlink = 70, Tmkdir = 72, Trenameat = 74, Tunlinkat = 76,
	Tversion = 100, Tauth = 102, Tattach = 104, Tflush = 108, Twalk = 110, Tread = 116, Twrite = 118,
	Tclunk = 120, Tremove = 122;

const QTDIR = 0x80, QTSYMLINK = 0x02, QTFILE = 0;
const S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;
const DT_DIR = 4, DT_REG = 8, DT_LNK = 10;
const AT_REMOVEDIR = 0x200;
const O_ACCMODE = 3, O_EXCL = 0o200, O_TRUNC = 0o1000, O_APPEND = 0o2000;
const P9_STATS_BASIC = 0x7ff;
const V9FS_MAGIC = 0x01021997;

/** The errno for a handler's error (an FsError, or an Error with a known `code` as Node's have), else 0. */
function knownErrno(e: unknown): number {
	if (e instanceof FsError) return e.errno;
	const code = (e as { code?: unknown } | null)?.code;
	return (typeof code === "string" && ERRNO[code]) || 0;
}

/** @internal A file system the server offers under a made-up attach name. */
export interface P9Export {
	readonly name: string;
	readonly removed: boolean;
	readonly stats: MountStats;
	/** Its guest connection is open. */
	readonly connected: boolean;
	/** Called when its guest connection opens (true) or ends (false). */
	onConnection: ((connected: boolean) => void) | undefined;
	/** Drop it: its connection is reset, and the backend's close() runs if no other export uses it. */
	remove(): void;
}

/** @internal A fid as a snapshot keeps it (JSON: inode numbers are decimal strings). */
export interface P9FidSnapshot {
	fid: number;
	path: string;
	type: FsFileType;
	/** An open regular file: how it was opened, and its qid.path then. */
	open?: { read: boolean; write: boolean; append: boolean; ino: string };
	/** The guest unlinked or replaced it while open: ESTALE after a restore. */
	orphan?: true;
	/** A directory listing being read (readdir past offset 0). */
	dir?: Array<{ name: string; type: FsFileType; ino?: string; dev?: string }>;
}

/** @internal An export's session as a snapshot keeps it (P9Server.saveExport()). */
export interface P9ExportSnapshot {
	name: string;
	/** The guest connection (vsock ports and credit counters). */
	conn: VsockConnSnapshot;
	msize: number;
	fids: P9FidSnapshot[];
}

/** @internal */
export interface P9Server {
	/** Serve `fs` (EROFS for every change with readOnly; handlers time out after `timeout` ms, 0 for never). */
	add(fs: Fs, opts?: { readOnly?: boolean; timeout?: number }): P9Export;
	/** Stop listening, reset every connection and drop every export. */
	close(): void;
	/** The number the next export's name gets (fs1, fs2, ...); a restore continues it. */
	next: number;
	/** At the snapshot point: why `e` cannot be saved now (not attached, a request in flight), or undefined. */
	exportBusy(e: P9Export): string | undefined;
	/** At the snapshot point (exportBusy() was undefined): its session and connection. */
	saveExport(e: P9Export): P9ExportSnapshot;
	/**
	 * A restore, before the kernel runs: serve `fs` under the saved name on
	 * `conn` (the connection VsockHost.adopt() took over), with the saved
	 * fids; open files are opened again by path (ESTALE for those that
	 * cannot be).
	 */
	restoreExport(fs: Fs, opts: { readOnly?: boolean; timeout?: number }, saved: P9ExportSnapshot, conn: VsockConnection): Promise<P9Export>;
}

/** @internal Listen on vsock port 564. Throws a VsockError EADDRINUSE if the port is taken. */
export function serve9p(vsock: Vsock, log: (msg: string) => void = () => {}): P9Server {
	return new Server(vsock, log);
}

// --- Encoding -----------------------------------------------------------------

const enc = new TextEncoder();
const lenient = new TextDecoder();
const strict = new TextDecoder("utf-8", { fatal: true });

class Writer {
	buf: Uint8Array;
	dv: DataView;
	n = HDR;
	constructor(size = 64) {
		this.buf = new Uint8Array(Math.max(size, HDR));
		this.dv = new DataView(this.buf.buffer);
	}
	room(k: number): void {
		if (this.n + k <= this.buf.length) return;
		const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
		b.set(this.buf.subarray(0, this.n));
		this.buf = b;
		this.dv = new DataView(b.buffer);
	}
	u8(v: number): this { this.room(1); this.dv.setUint8(this.n, v); this.n += 1; return this; }
	u16(v: number): this { this.room(2); this.dv.setUint16(this.n, v, true); this.n += 2; return this; }
	u32(v: number): this { this.room(4); this.dv.setUint32(this.n, v >>> 0, true); this.n += 4; return this; }
	u64(v: number | bigint): this {
		this.room(8);
		this.dv.setBigUint64(this.n, typeof v === "bigint" ? BigInt.asUintN(64, v) : BigInt(Math.max(0, Math.floor(v))), true);
		this.n += 8;
		return this;
	}
	str(s: string): this { const b = enc.encode(s); this.u16(b.length); return this.bytes(b); }
	bytes(b: Uint8Array): this { this.room(b.length); this.buf.set(b, this.n); this.n += b.length; return this; }
	qid(q: Qid): this { return this.u8(q.type).u32(q.version).u64(q.path); }
	finish(type: number, tag: number): Uint8Array {
		this.dv.setUint32(0, this.n, true);
		this.dv.setUint8(4, type);
		this.dv.setUint16(5, tag, true);
		return this.buf.subarray(0, this.n);
	}
}

class Reader {
	at = HDR;
	readonly dv: DataView;
	readonly buf: Uint8Array;
	constructor(buf: Uint8Array) {
		this.buf = buf;
		this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	u8(): number { const v = this.dv.getUint8(this.at); this.at += 1; return v; }
	u16(): number { const v = this.dv.getUint16(this.at, true); this.at += 2; return v; }
	u32(): number { const v = this.dv.getUint32(this.at, true); this.at += 4; return v; }
	u64(): number { const v = this.dv.getBigUint64(this.at, true); this.at += 8; return Number(v); }
	/** A string where bad UTF-8 does no harm (user and attach names). */
	str(): string { return lenient.decode(this.bytes(this.u16())); }
	/** A file name or link target: EILSEQ unless valid UTF-8. */
	name(): string {
		try {
			return strict.decode(this.bytes(this.u16()));
		} catch (e) {
			if (e instanceof FsError) throw e;
			throw new FsError("EILSEQ", "a name that is not UTF-8");
		}
	}
	bytes(n: number): Uint8Array {
		if (this.at + n > this.buf.length) throw new FsError("EPROTO", "a message shorter than its fields");
		const b = this.buf.subarray(this.at, this.at + n);
		this.at += n;
		return b;
	}
}

const typeOf = (frame: Uint8Array) => frame[4]!;
const tagOf = (frame: Uint8Array) => frame[5]! | (frame[6]! << 8);
const errorReply = (tag: number, errno: number) => new Writer(HDR + 4).u32(errno).finish(Rlerror, tag);

/** @internal Splits a byte stream into 9p messages however it is chunked. A message within one chunk is a view of it, else one copy. */
export class P9FrameAssembler {
	#chunks: Uint8Array[] = [];
	#head = 0;
	#len = 0;
	readonly maxSize: number;

	constructor(maxSize: number) {
		this.maxSize = maxSize;
	}

	/** Bytes received and not yet taken as messages. */
	get buffered(): number {
		return this.#len;
	}

	push(chunk: Uint8Array): void {
		if (chunk.length) {
			this.#chunks.push(chunk);
			this.#len += chunk.length;
		}
	}

	/** The next whole message, or undefined. Throws on a size outside 7..maxSize. */
	next(): Uint8Array | undefined {
		if (this.#len < 4) return undefined;
		let size = 0;
		for (let i = 0, c = 0, off = this.#head; i < 4;) {
			const chunk = this.#chunks[c]!;
			if (off >= chunk.length) {
				c++;
				off = 0;
				continue;
			}
			size |= chunk[off++]! << (8 * i++);
		}
		size >>>= 0;
		if (size < HDR || size > this.maxSize) throw new Error(`a 9p message of ${size} bytes (at most ${this.maxSize})`);
		if (this.#len < size) return undefined;
		const first = this.#chunks[0]!;
		let out: Uint8Array;
		if (first.length - this.#head >= size) {
			out = first.subarray(this.#head, this.#head + size);
			this.#head += size;
		} else {
			out = new Uint8Array(size);
			for (let at = 0; at < size;) {
				const c = this.#chunks[0]!;
				const k = Math.min(size - at, c.length - this.#head);
				out.set(c.subarray(this.#head, this.#head + k), at);
				at += k;
				this.#head += k;
				if (this.#head === c.length) {
					this.#chunks.shift();
					this.#head = 0;
				}
			}
		}
		if (this.#chunks.length && this.#head === this.#chunks[0]!.length) {
			this.#chunks.shift();
			this.#head = 0;
		}
		this.#len -= size;
		return out;
	}
}

interface Qid {
	type: number;
	version: number;
	path: number | bigint;
}

function join(dir: string, name: string): string {
	return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function parent(path: string): string {
	const i = path.lastIndexOf("/");
	return i <= 0 ? "/" : path.slice(0, i);
}

function checkName(name: string): void {
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) throw new FsError("EINVAL", `bad name ${JSON.stringify(name)}`);
	if (enc.encode(name).length > 255) throw new FsError("ENAMETOOLONG");
}

/** `path` is `prefix` or inside it. */
function under(path: string, prefix: string): boolean {
	return prefix === "/" || path === prefix || (path.startsWith(prefix) && path[prefix.length] === "/");
}

/** qid.path: the backend's (dev, ino), else a 63-bit hash of the path with the top bit set (two FNV-1a). */
function inode(path: string, ino: number | bigint | undefined, dev: number | bigint | undefined): number | bigint {
	if (ino !== undefined) return dev !== undefined && dev !== 0 && dev !== 0n ? BigInt.asUintN(64, (BigInt(dev) << 40n) ^ BigInt(ino)) : ino;
	let a = 0x811c9dc5, b = 0x050c5d1f;
	for (let i = 0; i < path.length; i++) {
		const c = path.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193);
		b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
	}
	return (1n << 63n) | (BigInt((a >>> 1) | 0x40000000) << 32n) | BigInt(b >>> 0);
}

const qidType = (t: FsFileType) => (t === "dir" ? QTDIR : t === "symlink" ? QTSYMLINK : QTFILE);

function qidOf(path: string, a: FsAttr): Qid {
	let version = a.version;
	if (version === undefined) {
		const t = Math.floor((a.mtimeMs ?? 0) * 1000) % 0x100000000;
		version = ((t ^ Math.imul((a.size ?? 0) % 0x100000000, 0x9e3779b1)) >>> 0) || 1;
	}
	return { type: qidType(a.type), version: version >>> 0, path: inode(path, a.ino, a.dev) };
}

const MSG_NAMES: Record<number, string> = {
	[Tstatfs]: "statfs", [Tlopen]: "lopen", [Tlcreate]: "lcreate", [Tsymlink]: "symlink", [Tmknod]: "mknod",
	[Trename]: "rename", [Treadlink]: "readlink", [Tgetattr]: "getattr", [Tsetattr]: "setattr",
	[Treaddir]: "readdir", [Tfsync]: "fsync", [Tlink]: "link", [Tmkdir]: "mkdir", [Trenameat]: "renameat",
	[Tunlinkat]: "unlinkat", [Tattach]: "attach", [Twalk]: "walk", [Tread]: "read", [Twrite]: "write",
	[Tclunk]: "clunk", [Tremove]: "remove",
};

/** Requests a read-only export answers with EROFS (Tlopen only with write or truncate flags; Tremove apart). */
const MUTATING = new Set([Tlcreate, Tsymlink, Tmknod, Trename, Tsetattr, Txattrcreate, Tlink, Tmkdir, Trenameat, Tunlinkat, Twrite]);

// --- Server and connections -----------------------------------------------------

class Export implements P9Export {
	readonly name: string;
	readonly fs: Fs;
	readonly readOnly: boolean;
	readonly timeout: number;
	readonly stats: MountStats = { requests: 0, errors: 0, bytesRead: 0, bytesWritten: 0 };
	/** The connection that attached first; it stays bound after it ends, so the export is never attached again. */
	conn: Connection | undefined;
	connected = false;
	onConnection: ((connected: boolean) => void) | undefined;
	readonly server: Server;
	removed = false;

	constructor(server: Server, name: string, fs: Fs, readOnly: boolean, timeout: number) {
		this.server = server;
		this.name = name;
		this.fs = fs;
		this.readOnly = readOnly;
		this.timeout = timeout;
	}

	/** Its connection attached (true) or ended (false). */
	opened(c: Connection, open: boolean): void {
		if (open) this.conn = c;
		else if (this.conn !== c || !this.connected) return;
		this.connected = open;
		try { this.onConnection?.(open); } catch (e) { this.server.log(`[9p] ${this.name}: onConnection threw: ${errorText(e)}`); }
	}

	remove(): void {
		if (this.removed) return;
		this.removed = true;
		this.onConnection = undefined;
		this.server.forget(this);
		if (this.connected) this.conn!.reset();
	}
}

class Server implements P9Server {
	readonly log: (msg: string) => void;
	#listener: VsockListener;
	#exports = new Map<string, Export>();
	/** Exports per backend: its close() runs when the last one goes. */
	#users = new Map<Fs, number>();
	#conns = new Set<Connection>();
	next = 1;
	#closed = false;

	constructor(vsock: Vsock, log: (msg: string) => void) {
		this.log = log;
		this.#listener = vsock.listen(P9_PORT, (conn) => {
			const c = new Connection(this, conn);
			this.#conns.add(c);
			void c.run().finally(() => this.#conns.delete(c));
		});
	}

	add(fs: Fs, opts: { readOnly?: boolean; timeout?: number } = {}): P9Export {
		if (this.#closed) throw new FsError("ECONNABORTED", "the 9p server is closed");
		const e = new Export(this, `fs${this.next++}`, fs, !!opts.readOnly, opts.timeout ?? DEFAULT_TIMEOUT);
		this.#exports.set(e.name, e);
		this.#users.set(fs, (this.#users.get(fs) ?? 0) + 1);
		return e;
	}

	exportBusy(p: P9Export): string | undefined {
		const e = p as Export;
		if (e.removed || !e.connected || !e.conn) return "not attached";
		return e.conn.busy();
	}

	saveExport(p: P9Export): P9ExportSnapshot {
		const e = p as Export;
		return { name: e.name, ...e.conn!.save() };
	}

	async restoreExport(fs: Fs, opts: { readOnly?: boolean; timeout?: number }, saved: P9ExportSnapshot, conn: VsockConnection): Promise<P9Export> {
		if (this.#closed) throw new FsError("ECONNABORTED", "the 9p server is closed");
		if (this.#exports.has(saved.name)) throw new FsError("EEXIST", `export ${saved.name} exists`);
		const e = new Export(this, saved.name, fs, !!opts.readOnly, opts.timeout ?? DEFAULT_TIMEOUT);
		this.#exports.set(e.name, e);
		this.#users.set(fs, (this.#users.get(fs) ?? 0) + 1);
		const n = /^fs(\d+)$/.exec(saved.name);
		if (n) this.next = Math.max(this.next, Number(n[1]) + 1);
		const session = new Session(e, Math.max(4096, Math.min(saved.msize, MSIZE)));
		await session.restore(saved.fids);
		const c = new Connection(this, conn, session);
		this.#conns.add(c);
		e.opened(c, true);
		void c.run().finally(() => this.#conns.delete(c));
		return e;
	}

	get(name: string): Export | undefined {
		return this.#exports.get(name);
	}

	forget(e: Export): void {
		if (this.#exports.get(e.name) !== e) return;
		this.#exports.delete(e.name);
		const n = (this.#users.get(e.fs) ?? 1) - 1;
		if (n > 0) {
			this.#users.set(e.fs, n);
			return;
		}
		this.#users.delete(e.fs);
		Promise.resolve().then(() => e.fs.close?.()).catch((err) => this.log(`[9p] close: ${(err as Error)?.message ?? err}`));
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#listener.close();
		for (const e of [...this.#exports.values()]) e.remove();
		for (const c of [...this.#conns]) c.reset();
	}
}

/** One guest connection (one mount): framing, Tversion and the first Tattach, the window. */
class Connection {
	#server: Server;
	#conn: VsockConnection;
	#writer: WritableStreamDefaultWriter<Uint8Array | string>;
	#asm: P9FrameAssembler;
	#msize: number;
	#session: Session | undefined;
	#queue: Array<{ frame: Uint8Array; tag: number }> = [];
	#inFlight = 0;
	#wake: (() => void) | undefined;
	#done = false;
	/** The vsock connection is gone (closed both ways, or reset). */
	#gone = false;

	/** `session`: a restored one (the connection is attached already). */
	constructor(server: Server, conn: VsockConnection, session?: Session) {
		this.#server = server;
		this.#conn = conn;
		this.#writer = conn.writable.getWriter();
		this.#msize = session?.msize ?? MSIZE;
		this.#asm = new P9FrameAssembler(MSIZE);
		this.#session = session;
		void conn.closed.then(() => { this.#gone = true; });
	}

	/** At the snapshot point: why it cannot be saved now, or undefined (nothing in flight either way). */
	busy(): string | undefined {
		if (this.#done || this.#gone) return "its connection ended";
		if (this.#inFlight || this.#queue.length || this.#asm.buffered || this.#session?.busy) return "a request in flight";
		const v = saveVsockConnection(this.#conn);
		return typeof v === "string" ? `its connection: ${v}` : undefined;
	}

	/** At the snapshot point (busy() was undefined). */
	save(): Omit<P9ExportSnapshot, "name"> {
		const conn = saveVsockConnection(this.#conn);
		if (typeof conn === "string" || !this.#session) throw new Error(`9p: cannot save the connection (${conn})`);
		return { conn, msize: this.#session.msize, fids: this.#session.save() };
	}

	reset(): void {
		this.#conn.reset();
	}

	async run(): Promise<void> {
		const reader = this.#conn.readable.getReader();
		try {
			for (;;) {
				// Backpressure: stop reading while the window and the queue are full.
				while (this.#queue.length >= QUEUE && !this.#gone) await Promise.race([new Promise<void>((r) => (this.#wake = r)), this.#conn.closed]);
				if (this.#gone) break;
				let chunk: ReadableStreamReadResult<Uint8Array>;
				try {
					chunk = await reader.read();
				} catch {
					break; // reset (by either side, or the kernel exited)
				}
				if (chunk.done || this.#done) break;
				this.#asm.push(chunk.value);
				for (let f = this.#asm.next(); f; f = this.#asm.next()) this.#frame(f);
			}
		} catch (e) {
			this.#server.log(`[9p] ${this.#session?.exp.name ?? "connection"}: ${(e as Error)?.message ?? e}; resetting`);
			this.#conn.reset();
		} finally {
			this.#done = true;
			try { reader.releaseLock(); } catch {}
			this.#conn.close();
			this.#queue = [];
			this.#session?.destroy();
			this.#session?.exp.opened(this, false);
		}
	}

	#send(frame: Uint8Array): void {
		if (this.#done) return;
		const s = this.#session?.exp.stats;
		if (s) {
			const t = typeOf(frame);
			if (t === Rlerror) s.errors++;
			else if (t === Tread + 1) s.bytesRead += frame.length - HDR - 4;
		}
		void this.#writer.write(frame).catch(() => {});
	}

	#frame(frame: Uint8Array): void {
		const type = typeOf(frame), tag = tagOf(frame);
		const session = this.#session;
		if (session) session.exp.stats.requests++;
		if (type === Tflush) {
			const old = frame.length >= HDR + 2 ? frame[HDR]! | (frame[HDR + 1]! << 8) : -1;
			const i = this.#queue.findIndex((q) => q.tag === old);
			if (i >= 0) this.#queue.splice(i, 1);
			if (i < 0 && session) session.flush(old);
			this.#send(new Writer(HDR).finish(Tflush + 1, tag));
			this.#pump();
			return;
		}
		if (!session && type === Tversion) {
			try {
				const r = new Reader(frame);
				this.#msize = Math.max(4096, Math.min(r.u32(), MSIZE));
				const version = r.str();
				this.#send(new Writer(32).u32(this.#msize).str(version.startsWith(P9_VERSION) ? P9_VERSION : "unknown").finish(Tversion + 1, tag));
			} catch {
				this.#send(errorReply(tag, ERRNO.EPROTO!));
			}
			return;
		}
		if (!session && type === Tattach) {
			// The first attach binds the connection to the file system it names.
			let exp: Export | undefined;
			try {
				const r = new Reader(frame);
				r.u32(), r.u32(), r.str();
				exp = this.#server.get(r.str());
			} catch {}
			if (!exp || exp.removed) {
				this.#server.log("[9p] attach to a file system that is not served");
				this.#send(errorReply(tag, ERRNO.ENOENT!));
				return;
			}
			if (exp.conn) {
				this.#server.log(`[9p] ${exp.name}: attach from a second connection refused`);
				this.#send(errorReply(tag, ERRNO.EBUSY!));
				return;
			}
			this.#session = new Session(exp, this.#msize);
			exp.opened(this, true);
			exp.stats.requests++;
		} else if (!session) {
			this.#send(errorReply(tag, type === Tauth ? ERRNO.EOPNOTSUPP! : ERRNO.EBADF!));
			return;
		}
		this.#queue.push({ frame, tag });
		this.#pump();
	}

	/** Start queued requests while the window has room. */
	#pump(): void {
		while (this.#session && this.#inFlight < WINDOW && this.#queue.length) {
			const q = this.#queue.shift()!;
			this.#inFlight++;
			void this.#session.call(q.frame).then((reply) => {
				if (reply) this.#send(reply);
			}).finally(() => {
				this.#inFlight--;
				this.#pump();
			});
		}
		if (this.#queue.length < QUEUE) {
			const w = this.#wake;
			this.#wake = undefined;
			w?.();
		}
	}
}

// --- A protocol session over an Fs ------------------------------------------------

interface Fid {
	path: string;
	type: FsFileType;
	/** The open file (Tlopen/Tlcreate of a regular file). */
	file?: FsFile;
	/** How `file` was opened, and its qid.path then (a restore opens it again so, and checks it is the same file). */
	open?: { read: boolean; write: boolean; append: boolean; ino: number | bigint };
	/** The guest unlinked or replaced the open file's name: a restore cannot open it again. */
	orphan?: boolean;
	/** Restored without its file (gone, another file now, or orphaned): its file operations answer ESTALE. */
	stale?: boolean;
	/** Directory listing taken at readdir offset 0 (with . and ..). */
	dir?: FsDirEntry[];
	/** Writes, truncation, fsync and clunk through this fid run in order. */
	chain: Promise<unknown>;
}

/** A restored fid's file operations: ESTALE once its file could not be opened again. */
function fileOf(f: Fid): FsFile | undefined {
	if (f.stale) throw new FsError("ESTALE", `${f.path}: the file open before the snapshot is gone`);
	return f.file;
}

const big = (v: number | bigint | undefined) => (v === undefined ? undefined : String(v));
const unbig = (v: string | undefined) => (v === undefined ? undefined : BigInt(v));

/** A running request: `dead` once it was flushed or timed out (its result is dropped). */
interface Pending {
	dead: boolean;
	resolve: (r: Uint8Array | null) => void;
	timer?: ReturnType<typeof setTimeout>;
}

class Session {
	readonly exp: Export;
	#fs: Fs;
	#fids = new Map<number, Fid>();
	#msize: number;
	#pending = new Map<number, Pending>();
	#destroyed = false;

	constructor(exp: Export, msize: number) {
		this.exp = exp;
		this.#fs = exp.fs;
		this.#msize = msize;
	}

	get msize(): number {
		return this.#msize;
	}

	/** Requests running (a snapshot waits for none). */
	get busy(): boolean {
		return this.#pending.size > 0;
	}

	/** The fids, as a snapshot keeps them (at the snapshot point: nothing in flight). */
	save(): P9FidSnapshot[] {
		return [...this.#fids].map(([fid, f]): P9FidSnapshot => ({
			fid, path: f.path, type: f.type,
			...(f.file && f.open && !f.orphan ? { open: { read: f.open.read, write: f.open.write, append: f.open.append, ino: String(f.open.ino) } } : {}),
			...((f.file && (f.orphan || !f.open)) || f.stale ? { orphan: true as const } : {}),
			...(f.dir ? { dir: f.dir.map((e) => ({ name: e.name, type: e.type, ino: big(e.ino), dev: big(e.dev) })) } : {}),
		}));
	}

	/**
	 * A restore: the saved fids, with open files opened again by path. A
	 * file that is gone, is another file now (another inode number), was
	 * orphaned, or does not open within the timeout leaves its fid stale.
	 */
	async restore(saved: P9FidSnapshot[]): Promise<void> {
		await Promise.all(saved.map(async (s) => {
			const f: Fid = {
				path: s.path, type: s.type, chain: Promise.resolve(),
				...(s.dir ? { dir: s.dir.map((e) => ({ name: e.name, type: e.type, ino: unbig(e.ino), dev: unbig(e.dev) })) } : {}),
			};
			this.#fids.set(s.fid, f);
			if (s.orphan) f.stale = true;
			if (!s.open) return;
			const o = s.open;
			let file: FsFile | undefined;
			let late = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const t = this.exp.timeout;
				const opening = (async () => {
					const opened = await this.#fs.open(s.path, { read: o.read, write: o.write, truncate: false, append: o.append });
					if (late) {
						await opened.close?.();
						return false;
					}
					file = opened;
					const a = opened.getattr ? await opened.getattr() : await this.#fs.getattr(s.path);
					return a.type === "file" && String(inode(s.path, a.ino, a.dev)) === o.ino && (!o.write || !!opened.write);
				})();
				const same = await (t > 0 ? Promise.race([opening, new Promise<boolean>((r) => (timer = setTimeout(() => r(false), t)))]) : opening);
				if (same) {
					f.file = file;
					f.open = { read: o.read, write: o.write, append: o.append, ino: BigInt(o.ino) };
					return;
				}
			} catch {} finally {
				clearTimeout(timer);
			}
			late = true;
			f.stale = true;
			if (file) void Promise.resolve((file as FsFile).close?.()).catch(() => {});
		}));
	}

	/** The guest unlinked `path` or put another file there: open fids of it can no longer be opened again by name. */
	#orphan(path: string): void {
		for (const f of this.#fids.values()) if (f.file && f.path === path) f.orphan = true;
	}

	#log(msg: string): void {
		this.exp.server.log(`[9p] ${this.exp.name}: ${msg}`);
	}

	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		for (const p of this.#pending.values()) {
			clearTimeout(p.timer);
			p.resolve(null);
		}
		this.#pending.clear();
		for (const f of this.#fids.values()) this.#closeFile(f);
		this.#fids.clear();
	}

	/** Tflush of a running request: its reply is dropped and its slot freed. */
	flush(tag: number): void {
		const p = this.#pending.get(tag);
		if (!p) return;
		p.dead = true;
		clearTimeout(p.timer);
		this.#pending.delete(tag);
		p.resolve(null);
	}


	#closeFile(f: Fid): void {
		const file = f.file;
		f.file = undefined;
		f.open = undefined;
		if (file?.close) void this.#ordered(f, () => file.close!()).catch((e) => this.#failed("close", e));
	}

	#failed(what: string, e: unknown): number {
		const n = knownErrno(e);
		if (!n) this.#log(`${what}: ${errorText(e)}`);
		return n || ERRNO.EIO!;
	}

	call(frame: Uint8Array): Promise<Uint8Array | null> {
		const type = typeOf(frame), tag = tagOf(frame);
		if (this.#destroyed) return Promise.resolve(null);
		return new Promise((resolve) => {
			const state: Pending = { dead: false, resolve };
			this.#pending.set(tag, state);
			const timeout = this.exp.timeout;
			if (timeout > 0) state.timer = setTimeout(() => {
				if (state.dead) return;
				state.dead = true;
				this.#pending.delete(tag);
				this.#log(`${MSG_NAMES[type] ?? type}: the handler did not answer within ${timeout} ms; the guest gets ETIMEDOUT`);
				resolve(errorReply(tag, ERRNO.ETIMEDOUT!));
			}, timeout);
			let run: Promise<Writer>;
			try {
				run = this.#handle(type, new Reader(frame), state);
			} catch (e) {
				run = Promise.reject(e);
			}
			run.then((w) => w.finish(type + 1, tag), (e) => errorReply(tag, this.#failed(MSG_NAMES[type] ?? String(type), e))).then((reply) => {
				clearTimeout(state.timer);
				if (this.#pending.get(tag) === state) this.#pending.delete(tag);
				if (!state.dead) resolve(reply);
			});
		});
	}

	#fid(n: number): Fid {
		const f = this.#fids.get(n);
		if (!f) throw new FsError("EBADF", `unknown fid ${n}`);
		return f;
	}

	/** A fid that must be a directory (names are made below it, so never below a symlink). */
	#dir(n: number): Fid {
		const f = this.#fid(n);
		if (f.type !== "dir") throw new FsError("ENOTDIR");
		return f;
	}

	/** Run `op` after the fid's earlier ordered operations; a hung one holds the next back for at most the timeout. */
	#ordered<T>(f: Fid, op: () => MaybePromise<T>): Promise<T> {
		const p = f.chain.then(op);
		const t = this.exp.timeout;
		let timer: ReturnType<typeof setTimeout> | undefined;
		f.chain = (t > 0 ? Promise.race([p, new Promise((r) => (timer = setTimeout(r, t)))]) : p).catch(() => {}).finally(() => clearTimeout(timer));
		return p;
	}

	#need<K extends keyof Fs>(k: K, code = "EROFS"): NonNullable<Fs[K]> {
		const fn = this.#fs[k];
		if (typeof fn !== "function") throw new FsError(code);
		return (fn as (...a: never[]) => unknown).bind(this.#fs) as NonNullable<Fs[K]>;
	}

	/** Open a regular file for a fid; one opened after the request died is closed again. */
	async #open(f: Fid, state: Pending, file: MaybePromise<FsFile>, write: boolean): Promise<FsFile> {
		const opened = await file;
		if (state.dead || (write && !opened.write)) {
			await opened.close?.();
			if (!state.dead) throw new FsError("EACCES", `${f.path}: not writable`);
		} else {
			if (f.file) this.#closeFile(f);
			f.file = opened;
		}
		return opened;
	}

	/** A rename in this tree: fids below `from` follow it. */
	#renamed(from: string, to: string): void {
		for (const f of this.#fids.values()) if (under(f.path, from)) f.path = to + f.path.slice(from.length);
	}

	async #handle(type: number, r: Reader, state: Pending): Promise<Writer> {
		const fs = this.#fs;
		if (this.exp.readOnly) {
			const flags = type === Tlopen ? new DataView(r.buf.buffer, r.buf.byteOffset).getUint32(HDR + 4, true) : 0;
			if (MUTATING.has(type) || (type === Tlopen && (flags & O_ACCMODE || flags & O_TRUNC))) throw new FsError("EROFS");
			if (type === Tremove) {
				// The fid goes away as Tremove's would, and the answer is EROFS.
				const n = r.u32();
				const f = this.#fid(n);
				this.#fids.delete(n);
				this.#closeFile(f);
				throw new FsError("EROFS");
			}
		}
		switch (type) {
		case Tversion: {
			// A second Tversion: a new session on this connection.
			const msize = r.u32();
			const version = r.str();
			this.#msize = Math.max(4096, Math.min(msize, this.#msize));
			for (const f of this.#fids.values()) this.#closeFile(f);
			this.#fids.clear();
			return new Writer(32).u32(this.#msize).str(version.startsWith(P9_VERSION) ? P9_VERSION : "unknown");
		}
		case Tauth:
			throw new FsError("EOPNOTSUPP");
		case Tattach: {
			// The guest attaches again for each uid it acts as (access=client), naming the same file system.
			const fid = r.u32();
			r.u32(), r.str();
			if (r.str() !== this.exp.name) throw new FsError("ENOENT", "an attach to another file system on this connection");
			const a = await fs.getattr("/");
			if (a.type !== "dir") throw new FsError("ENOTDIR", "the file system's root is not a directory");
			if (!state.dead) this.#fids.set(fid, { path: "/", type: "dir", chain: Promise.resolve() });
			return new Writer(HDR + 13).qid(qidOf("/", a));
		}
		case Twalk: {
			const fid = r.u32(), newfid = r.u32(), n = r.u16();
			const f = this.#fid(fid);
			let path = f.path, ftype = f.type;
			const qids: Qid[] = [];
			for (let i = 0; i < n; i++) {
				let a: FsAttr;
				try {
					const name = r.name();
					if (ftype !== "dir") throw new FsError("ENOTDIR");
					const next = name === ".." ? parent(path) : (checkName(name), join(path, name));
					a = await fs.getattr(next);
					path = next;
				} catch (e) {
					if (i === 0) throw e;
					break;
				}
				qids.push(qidOf(path, a));
				ftype = a.type;
			}
			if (qids.length === n && !state.dead) {
				// A fid replaced here (newfid in use, or walked in place) closes its open file.
				const old = this.#fids.get(newfid);
				if (old) this.#closeFile(old);
				this.#fids.set(newfid, { path, type: ftype, chain: old?.chain ?? Promise.resolve() });
			}
			const w = new Writer(HDR + 2 + 13 * qids.length).u16(qids.length);
			for (const q of qids) w.qid(q);
			return w;
		}
		case Tclunk:
		case Tremove: {
			const n = r.u32();
			const f = this.#fid(n);
			this.#fids.delete(n);
			const file = f.file;
			f.file = undefined;
			await this.#ordered(f, () => file?.close?.());
			if (type === Tremove) {
				if (f.path === "/") throw new FsError("EBUSY");
				await this.#need("remove")(f.path, f.type === "dir");
				this.#orphan(f.path);
			}
			return new Writer(HDR);
		}
		case Tstatfs: {
			this.#fid(r.u32());
			const s = (await fs.statfs?.()) ?? {};
			return new Writer(HDR + 60).u32(V9FS_MAGIC).u32(s.bsize ?? 4096).u64(s.blocks ?? 0).u64(s.bfree ?? 0).u64(s.bavail ?? s.bfree ?? 0)
				.u64(s.files ?? 0).u64(s.ffree ?? 0).u64(0).u32(s.namelen ?? 255);
		}
		case Tlopen: {
			const f = this.#fid(r.u32());
			const flags = r.u32();
			const write = (flags & O_ACCMODE) !== 0;
			let a = await fs.getattr(f.path);
			f.type = a.type;
			if (a.type === "file") {
				const truncate = (flags & O_TRUNC) !== 0;
				const read = (flags & O_ACCMODE) !== 1, append = (flags & O_APPEND) !== 0;
				const file = await this.#open(f, state, fs.open(f.path, { read, write, truncate, append }), write);
				if (truncate) a = (await file.getattr?.()) ?? (await fs.getattr(f.path));
				if (!state.dead && f.file === file) f.open = { read, write, append, ino: inode(f.path, a.ino, a.dev) };
			}
			f.dir = undefined;
			return new Writer(HDR + 17).qid(qidOf(f.path, a)).u32(0);
		}
		case Tlcreate: {
			const f = this.#dir(r.u32());
			const name = r.name();
			const flags = r.u32(), mode = r.u32();
			checkName(name);
			const path = join(f.path, name);
			let file: FsFile;
			let how = { read: true, write: true, append: false };
			try {
				file = await this.#open(f, state, this.#need("create")(path, mode & 0o7777), false);
			} catch (e) {
				// The guest sends Tlcreate for a name it believes missing; if it exists now (the host made
				// it meanwhile), open(O_CREAT) without O_EXCL opens it, as on a local file system.
				if (flags & O_EXCL || (e as { code?: unknown } | null)?.code !== "EEXIST") throw e;
				const a = await fs.getattr(path);
				if (a.type !== "file") throw new FsError(a.type === "dir" ? "EISDIR" : "EEXIST");
				how = { read: (flags & O_ACCMODE) !== 1, write: true, append: (flags & O_APPEND) !== 0 };
				file = await this.#open(f, state, fs.open(path, { ...how, truncate: (flags & O_TRUNC) !== 0 }), true);
			}
			const a = (await file.getattr?.()) ?? (await fs.getattr(path));
			if (!state.dead) {
				f.path = path;
				f.type = "file";
				if (f.file === file) f.open = { ...how, ino: inode(path, a.ino, a.dev) };
			}
			return new Writer(HDR + 17).qid(qidOf(path, a)).u32(0);
		}
		case Tmkdir:
		case Tsymlink: {
			const f = this.#dir(r.u32());
			const name = r.name();
			checkName(name);
			const path = join(f.path, name);
			if (type === Tmkdir) await this.#need("mkdir")(path, r.u32() & 0o7777);
			else await this.#need("symlink", "EOPNOTSUPP")(path, r.name());
			return new Writer(HDR + 13).qid(qidOf(path, await fs.getattr(path)));
		}
		case Tlink: {
			// Tlink dfid fid name: a new name in the directory dfid for the file fid.
			const d = this.#dir(r.u32());
			const f = this.#fid(r.u32());
			const name = r.name();
			checkName(name);
			if (f.stale) throw new FsError("ESTALE", `${f.path}: the file open before the snapshot is gone`);
			// Regular files only: a hard link to a symlink is one that some hosts' link(2) follows (Darwin's).
			if (f.type !== "file") throw new FsError("EPERM", `a hard link to a ${f.type}`);
			await this.#need("link", "EPERM")(f.path, join(d.path, name));
			return new Writer(HDR);
		}
		case Tmknod:
			throw new FsError("EOPNOTSUPP");
		case Tunlinkat: {
			const f = this.#dir(r.u32());
			const name = r.name();
			const flags = r.u32();
			checkName(name);
			await this.#need("remove")(join(f.path, name), !!(flags & AT_REMOVEDIR));
			this.#orphan(join(f.path, name));
			return new Writer(HDR);
		}
		case Trenameat:
		case Trename: {
			let from: string, to: string;
			if (type === Trenameat) {
				const od = this.#dir(r.u32()), oname = r.name(), nd = this.#dir(r.u32()), nname = r.name();
				checkName(oname);
				checkName(nname);
				from = join(od.path, oname);
				to = join(nd.path, nname);
			} else {
				const f = this.#fid(r.u32()), d = this.#dir(r.u32()), name = r.name();
				checkName(name);
				from = f.path;
				to = join(d.path, name);
			}
			if (from === "/" || (under(to, from) && to !== from)) throw new FsError(from === "/" ? "EBUSY" : "EINVAL");
			if (from !== to) {
				await this.#need("rename")(from, to);
				this.#orphan(to);
				this.#renamed(from, to);
			}
			return new Writer(HDR);
		}
		case Treadlink: {
			const f = this.#fid(r.u32());
			return new Writer().str(await this.#need("readlink", "EINVAL")(f.path));
		}
		case Tgetattr: {
			const f = this.#fid(r.u32());
			const file = fileOf(f);
			const a = file?.getattr ? await file.getattr() : await fs.getattr(f.path);
			const size = a.size ?? 0;
			const perm = a.mode ?? (a.type === "dir" ? 0o755 : a.type === "symlink" ? 0o777 : 0o644);
			const fmt = a.type === "dir" ? S_IFDIR : a.type === "symlink" ? S_IFLNK : S_IFREG;
			const w = new Writer(HDR + 153).u64(P9_STATS_BASIC).qid(qidOf(f.path, a)).u32(fmt | (perm & 0o7777))
				.u32(a.uid ?? FS_DEFAULT_OWNER).u32(a.gid ?? FS_DEFAULT_OWNER).u64(a.nlink ?? (a.type === "dir" ? 2 : 1)).u64(0).u64(size).u64(4096)
				.u64(Math.ceil(size / 512));
			const m = a.mtimeMs ?? Date.now();
			for (const t of [a.atimeMs ?? m, m, a.ctimeMs ?? m, 0]) {
				const s = Math.floor(t / 1000);
				w.u64(s).u64(Math.min(999999999, Math.round((t - s * 1000) * 1e6)));
			}
			return w.u64(0).u64(0);
		}
		case Tsetattr: {
			const f = this.#fid(r.u32());
			const valid = r.u32(), mode = r.u32(), uid = r.u32(), gid = r.u32(), size = r.u64();
			const as = r.u64(), an = r.u64(), ms = r.u64(), mn = r.u64();
			const attr: FsSetAttr = {};
			if (valid & 1) attr.mode = mode & 0o7777;
			if (valid & 2) attr.uid = uid;
			if (valid & 4) attr.gid = gid;
			if (valid & 8) attr.size = size;
			if (valid & 16) attr.atimeMs = valid & 128 ? as * 1000 + an / 1e6 : Date.now();
			if (valid & 32) attr.mtimeMs = valid & 256 ? ms * 1000 + mn / 1e6 : Date.now();
			const file = fileOf(f);
			if (Object.keys(attr).length) await this.#ordered(f, () => (file?.setattr ? file.setattr(attr) : this.#need("setattr")(f.path, attr)));
			return new Writer(HDR);
		}
		case Treaddir: {
			const f = this.#fid(r.u32());
			const offset = r.u64(), count = r.u32();
			if (f.type !== "dir") throw new FsError("ENOTDIR");
			if (offset === 0 || !f.dir) f.dir = [{ name: ".", type: "dir" }, { name: "..", type: "dir" }, ...(await fs.readdir(f.path))];
			const max = Math.min(count, this.#msize - HDR - 4);
			const w = new Writer(Math.min(max, 65536) + HDR + 4);
			w.u32(0);
			const start = w.n;
			for (let i = offset; i < f.dir.length; i++) {
				const e = f.dir[i]!;
				const name = enc.encode(e.name);
				if (w.n - start + 24 + name.length > max) break;
				const path = e.name === "." ? f.path : e.name === ".." ? parent(f.path) : join(f.path, e.name);
				w.u8(qidType(e.type)).u32(0).u64(inode(path, e.ino, e.dev));
				w.u64(i + 1).u8(e.type === "dir" ? DT_DIR : e.type === "symlink" ? DT_LNK : DT_REG);
				w.u16(name.length).bytes(name);
			}
			w.dv.setUint32(HDR, w.n - start, true);
			return w;
		}
		case Tread: {
			const f = this.#fid(r.u32());
			const offset = r.u64(), count = Math.min(r.u32(), this.#msize - HDR - 4);
			const file = fileOf(f);
			if (!file) throw new FsError(f.type === "dir" ? "EISDIR" : "EBADF");
			const data = await file.read(offset, count);
			const n = Math.min(data.length, count);
			// The reply buffer is the one copy of the data on this side.
			return new Writer(HDR + 4 + n).u32(n).bytes(n === data.length ? data : data.subarray(0, n));
		}
		case Twrite: {
			const f = this.#fid(r.u32());
			const offset = r.u64(), count = r.u32();
			const data = r.bytes(count);
			const file = fileOf(f);
			if (!file?.write) throw new FsError(f.type === "dir" ? "EISDIR" : "EBADF");
			this.exp.stats.bytesWritten += count;
			return new Writer(HDR + 4).u32(await this.#ordered(f, () => file.write!(offset, data)));
		}
		case Tfsync: {
			// A directory, or a file without fsync: nothing to do on this side.
			const f = this.#fid(r.u32());
			const file = fileOf(f);
			await this.#ordered(f, () => file?.fsync?.());
			return new Writer(HDR);
		}
		case Tlock:
			// Locks are the guest's own: its kernel checks conflicts before asking.
			this.#fid(r.u32());
			return new Writer(HDR + 1).u8(0);
		case Tgetlock: {
			this.#fid(r.u32());
			r.u8();
			const start = r.u64(), length = r.u64(), procId = r.u32(), client = r.str();
			return new Writer().u8(2).u64(start).u64(length).u32(procId).str(client);
		}
		case Txattrwalk:
		case Txattrcreate:
			// No extended attributes (kw9p mounts with noxattr, so the guest rarely asks).
			throw new FsError("EOPNOTSUPP");
		default:
			throw new FsError("EOPNOTSUPP", `unknown message type ${type}`);
		}
	}
}
