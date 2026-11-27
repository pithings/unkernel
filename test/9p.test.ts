// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Unit tests for the 9p server (core/9p.ts), MemoryFs (core/memfs.ts) and
// the mount helpers (core/mounts.ts) without a kernel: a fake Vsock whose
// listen() hands the server connections made of in-memory web streams, and
// a small 9P2000.L client written here, independently of 9p.ts, that plays
// the guest's kernel. The snapshot test runs the server on a real VsockHost
// with a guest end of the vsock protocol written here (GuestVsock).
//
//   node --test test/9p.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { P9FrameAssembler, serve9p } from "../js/core/9p.ts";
import { FsError, type Fs, type FsAttr, type FsFile } from "../js/core/fs.ts";
import { MemoryFs, type MemoryFsChange } from "../js/core/memfs.ts";
import { nodeFs } from "../js/node/nodefs.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { MountError, normalizeMountPath, parseMounts, snapshotMountMismatch, toFs } from "../js/core/mounts.ts";
import { VSOCK_HEADER_SIZE, VSOCK_OP_CREDIT_REQUEST, VSOCK_OP_CREDIT_UPDATE, VSOCK_OP_REQUEST, VSOCK_OP_RESPONSE, VSOCK_OP_RST, VSOCK_OP_RW, VsockHost,
	decodeVsockHeader, encodeVsockPacket, type Vsock, type VsockConnection, type VsockListener } from "../js/core/vsock.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// --- A 9P2000.L client ---------------------------------------------------------

const T = {
	statfs: 8, lopen: 12, lcreate: 14, symlink: 16, readlink: 22, getattr: 24, setattr: 26, xattrwalk: 30, readdir: 40, fsync: 50,
	link: 70, mkdir: 72, renameat: 74, unlinkat: 76, version: 100, attach: 104, flush: 108, walk: 110, read: 116, write: 118, clunk: 120, remove: 122,
} as const;
const Rlerror = 7;
const NOFID = 0xffffffff;

class Enc {
	parts: number[] = [];
	u8(v: number) { this.parts.push(v & 0xff); return this; }
	u16(v: number) { return this.u8(v).u8(v >> 8); }
	u32(v: number) { return this.u16(v & 0xffff).u16(v >>> 16); }
	u64(v: number) { return this.u32(v % 2 ** 32).u32(Math.floor(v / 2 ** 32)); }
	str(s: string | Uint8Array) { const b = typeof s === "string" ? enc.encode(s) : s; this.u16(b.length); for (const x of b) this.u8(x); return this; }
	bytes(b: Uint8Array) { for (const x of b) this.u8(x); return this; }
	frame(type: number, tag: number): Uint8Array {
		const n = this.parts.length + 7;
		return Uint8Array.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24, type, tag & 0xff, tag >> 8, ...this.parts]);
	}
}

class Dec {
	at = 7;
	dv: DataView;
	readonly b: Uint8Array;
	constructor(b: Uint8Array) { this.b = b; this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
	u8() { return this.b[this.at++]!; }
	u16() { const v = this.dv.getUint16(this.at, true); this.at += 2; return v; }
	u32() { const v = this.dv.getUint32(this.at, true); this.at += 4; return v; }
	u64() { const v = this.dv.getBigUint64(this.at, true); this.at += 8; return v; }
	str() { const n = this.u16(); const s = dec.decode(this.b.subarray(this.at, this.at + n)); this.at += n; return s; }
	qid() { return { type: this.u8(), version: this.u32(), path: this.u64() }; }
	bytes(n: number) { const s = this.b.slice(this.at, this.at + n); this.at += n; return s; }
}

class P9ClientError extends Error {
	readonly errno: number;
	constructor(errno: number) { super(`errno ${errno}`); this.errno = errno; }
}

/** One connection to the server, as the guest's kernel would use it. */
class Client {
	#w: WritableStreamDefaultWriter<Uint8Array>;
	#pending = new Map<number, (d: Dec) => void>();
	#nextTag = 1;
	nextFid = 1;
	/** Replies to tags nobody waits for (a flushed request answered anyway would land here). */
	stray: number[] = [];
	readonly conn: { toServer: WritableStream<Uint8Array>; fromServer: ReadableStream<Uint8Array> };

	constructor(conn: { toServer: WritableStream<Uint8Array>; fromServer: ReadableStream<Uint8Array> }) {
		this.conn = conn;
		this.#w = conn.toServer.getWriter();
		void this.#read();
	}

	async #read() {
		const asm = new P9FrameAssembler(1 << 24);
		const r = this.conn.fromServer.getReader();
		for (;;) {
			const { done, value } = await r.read().catch(() => ({ done: true, value: undefined }));
			if (done) break;
			asm.push(value!);
			for (let f = asm.next(); f; f = asm.next()) {
				const tag = f[5]! | (f[6]! << 8);
				const cb = this.#pending.get(tag);
				if (cb) {
					this.#pending.delete(tag);
					cb(new Dec(f));
				} else this.stray.push(tag);
			}
		}
	}

	/** The guest closes its end. */
	end() {
		void this.#w.close().catch(() => {});
	}

	send(frame: Uint8Array) {
		void this.#w.write(frame).catch(() => {});
	}

	/** Send a request and wait for its reply; an Rlerror rejects with its errno. */
	rpc(type: number, body: Enc = new Enc(), tag = (this.#nextTag++ % 0xfff0) + 1): Promise<Dec> {
		return new Promise((resolve, reject) => {
			this.#pending.set(tag, (d) => {
				if (d.b[4] === Rlerror) reject(new P9ClientError(d.u32()));
				else if (d.b[4] !== type + 1) reject(new Error(`reply type ${d.b[4]} to ${type}`));
				else resolve(d);
			});
			this.send(body.frame(type, tag));
		});
	}

	async version(msize = 1 << 20) {
		const d = await this.rpc(T.version, new Enc().u32(msize).str("9P2000.L"), 0xffff);
		return { msize: d.u32(), version: d.str() };
	}
	async attach(aname: string, fid = 0) {
		return (await this.rpc(T.attach, new Enc().u32(fid).u32(NOFID).str("root").str(aname).u32(0))).qid();
	}
	async walk(fid: number, names: Array<string | Uint8Array>, newfid = this.nextFid++) {
		const e = new Enc().u32(fid).u32(newfid).u16(names.length);
		for (const n of names) e.str(n);
		const d = await this.rpc(T.walk, e);
		const n = d.u16();
		const qids = Array.from({ length: n }, () => d.qid());
		return { fid: newfid, qids };
	}
	async getattr(fid: number) {
		const d = await this.rpc(T.getattr, new Enc().u32(fid).u64(0x7ff));
		d.u64();
		const qid = d.qid();
		const mode = d.u32(), uid = d.u32(), gid = d.u32(), nlink = d.u64(); d.u64();
		const size = d.u64();
		return { qid, mode, uid, gid, nlink: Number(nlink), size: Number(size) };
	}
	async lopen(fid: number, flags: number) { return (await this.rpc(T.lopen, new Enc().u32(fid).u32(flags))).qid(); }
	async lcreate(fid: number, name: string | Uint8Array, flags = 2, mode = 0o644) { return (await this.rpc(T.lcreate, new Enc().u32(fid).str(name).u32(flags).u32(mode).u32(0))).qid(); }
	async read(fid: number, offset: number, count: number) { const d = await this.rpc(T.read, new Enc().u32(fid).u64(offset).u32(count)); return d.bytes(d.u32()); }
	async write(fid: number, offset: number, data: Uint8Array | string) {
		const b = typeof data === "string" ? enc.encode(data) : data;
		return (await this.rpc(T.write, new Enc().u32(fid).u64(offset).u32(b.length).bytes(b))).u32();
	}
	async clunk(fid: number) { await this.rpc(T.clunk, new Enc().u32(fid)); }
	async remove(fid: number) { await this.rpc(T.remove, new Enc().u32(fid)); }
	async mkdir(dfid: number, name: string) { return (await this.rpc(T.mkdir, new Enc().u32(dfid).str(name).u32(0o755).u32(0))).qid(); }
	async symlink(dfid: number, name: string, target: string) { return (await this.rpc(T.symlink, new Enc().u32(dfid).str(name).str(target).u32(0))).qid(); }
	async readlink(fid: number) { return (await this.rpc(T.readlink, new Enc().u32(fid))).str(); }
	async link(dfid: number, fid: number, name: string) { await this.rpc(T.link, new Enc().u32(dfid).u32(fid).str(name)); }
	async renameat(od: number, on: string, nd: number, nn: string) { await this.rpc(T.renameat, new Enc().u32(od).str(on).u32(nd).str(nn)); }
	async unlinkat(dfid: number, name: string, flags = 0) { await this.rpc(T.unlinkat, new Enc().u32(dfid).str(name).u32(flags)); }
	async truncate(fid: number, size: number) { await this.rpc(T.setattr, new Enc().u32(fid).u32(8).u32(0).u32(0).u32(0).u64(size).u64(0).u64(0).u64(0).u64(0)); }
	async readdir(fid: number, offset = 0, count = 8192) {
		const d = await this.rpc(T.readdir, new Enc().u32(fid).u64(offset).u32(count));
		const end = d.at + 4 + d.u32();
		const out: Array<{ name: string; offset: number; type: number; ino: bigint }> = [];
		while (d.at < end) {
			const qid = d.qid();
			const off = Number(d.u64()), type = d.u8(), name = d.str();
			out.push({ name, offset: off, type, ino: qid.path });
		}
		return out;
	}
	async readdirAll(fid: number, count = 64) {
		const all: string[] = [];
		for (let off = 0; ;) {
			const part = await this.readdir(fid, off, count);
			if (!part.length) return all;
			all.push(...part.map((e) => e.name));
			off = part.at(-1)!.offset;
		}
	}
	/** version + attach: the root's fid is 0. */
	async mount(aname: string) {
		await this.version();
		return this.attach(aname);
	}
	/** Walk to `path` from the root and open it. */
	async open(path: string, flags = 0) {
		const { fid } = await this.walk(0, path.split("/").filter(Boolean));
		await this.lopen(fid, flags);
		return fid;
	}
}

// --- A fake Vsock: listen() only ---------------------------------------------------

class FakeVsock implements Vsock {
	guestCid = 3;
	stats = { open: 0, accepted: 0, connected: 0, refused: 0, resets: 0, bytesIn: 0, bytesOut: 0, violations: 0 };
	handler: ((c: VsockConnection) => void) | undefined;
	closedListener = false;
	conns: Array<{ resets: number; closes: number }> = [];

	listen(port: number, onConnection?: (conn: VsockConnection) => void): VsockListener {
		this.handler = onConnection;
		const self = this;
		return {
			port,
			accept: () => Promise.resolve(null),
			close() { self.closedListener = true; },
			async *[Symbol.asyncIterator]() {},
		};
	}

	connect(): Promise<VsockConnection> {
		return Promise.reject(new Error("not in this fake"));
	}

	/** A guest connection to the listener: the client's end. */
	open() {
		const c2s = new TransformStream<Uint8Array, Uint8Array>();
		const s2c = new TransformStream<Uint8Array | string, Uint8Array>();
		let resolveClosed!: (how: "closed" | "reset") => void;
		const rec = { resets: 0, closes: 0 };
		this.conns.push(rec);
		const end = (how: "closed" | "reset") => {
			void c2s.writable.abort().catch(() => {});
			void s2c.writable.abort().catch(() => {});
			resolveClosed(how);
		};
		const conn: VsockConnection = {
			localPort: 564,
			remotePort: 1000 + this.conns.length,
			readable: c2s.readable,
			writable: s2c.writable,
			close() { rec.closes++; end("closed"); },
			reset() { rec.resets++; end("reset"); },
			closed: new Promise((r) => (resolveClosed = r)),
		};
		this.handler!(conn);
		return { toServer: c2s.writable, fromServer: s2c.readable as ReadableStream<Uint8Array>, rec, conn };
	}
}

function setup() {
	const vsock = new FakeVsock();
	const logs: string[] = [];
	const srv = serve9p(vsock, (m) => logs.push(m));
	const client = () => new Client(vsock.open());
	/** Serve `fs` and return a client mounted on it (root fid 0) with its export. */
	const mount = async (fs: Fs, opts?: { readOnly?: boolean; timeout?: number }) => {
		const exp = srv.add(fs, opts);
		const c = client();
		await c.mount(exp.name);
		return { c, exp };
	};
	return { vsock, srv, client, mount, logs };
}

/** A file system whose only files are made by `file(path)` (any path but "/" is a file). */
function filesOnly(file: (path: string) => FsFile | Promise<FsFile>, extra: Partial<Fs> = {}): Fs {
	return { getattr: (p) => (p === "/" ? { type: "dir" } : { type: "file", size: 1 }), readdir: () => [], open: (p) => file(p), ...extra };
}

const errno = (n: number) => (e: unknown) => e instanceof P9ClientError && e.errno === n;
const O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2, O_EXCL = 0o200, O_TRUNC = 0o1000;

// --- Tests ---------------------------------------------------------------------

test("frame assembler: whole frames however the stream is cut, a view when within one chunk", () => {
	const a = new Enc().u32(7).str("hi").frame(100, 1), b = new Enc().u64(1).frame(116, 2);
	const all = Uint8Array.from([...a, ...b]);
	const asm = new P9FrameAssembler(1024);
	for (const x of all) asm.push(Uint8Array.of(x));
	assert.deepEqual([...asm.next()!], [...a]);
	assert.deepEqual([...asm.next()!], [...b]);
	assert.equal(asm.next(), undefined);
	const one = new P9FrameAssembler(1024);
	one.push(all);
	const f = one.next()!;
	assert.equal(f.buffer, all.buffer, "a view of the chunk, no copy");
	const bad = new P9FrameAssembler(64);
	bad.push(new Enc().bytes(new Uint8Array(100)).frame(118, 1));
	assert.throws(() => bad.next(), /at most 64/);
});

test("version, attach by name, walk, getattr, open and read; msize capped; unknown names and other names on a bound connection fail with ENOENT; a second connection to a bound export gets EBUSY", async () => {
	const { srv, client } = setup();
	const exp = srv.add(new MemoryFs({ "hello.txt": "hello\n", dir: { "a.txt": "a" } }));
	const other = srv.add(new MemoryFs());
	const c = client();
	const v = await c.version(1 << 24);
	assert.deepEqual(v, { msize: 128 * 1024, version: "9P2000.L" });
	const root = await c.attach(exp.name);
	assert.equal(root.type, 0x80);
	const w = await c.walk(0, ["dir", "a.txt"]);
	assert.equal(w.qids.length, 2);
	await assert.rejects(c.walk(0, ["nope"]), errno(2));
	const partial = await c.walk(0, ["dir", "nope", "x"]);
	assert.equal(partial.qids.length, 1, "a partial walk returns the qids walked, and no fid");
	await assert.rejects(c.getattr(partial.fid), errno(9));
	const fid = await c.open("hello.txt");
	assert.equal(dec.decode(await c.read(fid, 0, 100)), "hello\n");
	assert.equal(dec.decode(await c.read(fid, 2, 2)), "ll");
	const a = await c.getattr(fid);
	assert.equal(a.size, 6);
	assert.equal(a.mode, 0o100644);
	assert.notEqual(a.qid.version, 0, "a cacheable qid.version");
	assert.equal((await c.attach(exp.name, 50)).type, 0x80, "the guest attaches again per uid");
	await assert.rejects(c.attach(other.name, 51), errno(2), "a later attach naming another file system");
	const c2 = client();
	await c2.version();
	await assert.rejects(c2.attach("missing"), errno(2));
	await assert.rejects(c2.attach(exp.name), errno(16), "one connection per export");
	assert.equal((await c2.attach(other.name)).type, 0x80, "the second connection can take a free export");
	assert.equal(dec.decode(await c.read(fid, 0, 100)), "hello\n", "the first connection is unaffected");
	// Once the bound connection ends, the export is not attached again.
	c.end();
	await tick(5);
	const c3 = client();
	await c3.version();
	await assert.rejects(c3.attach(exp.name), errno(16));
});

test("qid.version changes with the data; qid.path is stable across renames and matches readdir's; a fid follows a rename; a backend without inode numbers gets path hashes", async () => {
	const { mount } = setup();
	const fs = new MemoryFs({ d: { sub: { "f.txt": "1" } }, "x.txt": "x" });
	const { c } = await mount(fs);
	const f1 = await c.walk(0, ["d", "sub", "f.txt"]);
	const before = await c.getattr(f1.fid);
	fs.writeFile("/d/sub/f.txt", "22");
	const after = await c.getattr(f1.fid);
	assert.notEqual(after.qid.version, before.qid.version);
	assert.equal(after.qid.path, before.qid.path, "the host's write keeps the inode");
	await c.renameat(0, "d", 0, "e");
	const f2 = await c.walk(0, ["e", "sub", "f.txt"]);
	assert.equal((await c.getattr(f2.fid)).qid.path, before.qid.path);
	assert.equal((await c.getattr(f1.fid)).size, 2, "a fid walked before the rename follows it");
	const listed = await c.readdir(await c.open("e/sub"));
	assert.equal(listed.find((e) => e.name === "f.txt")!.ino, before.qid.path, "readdir's inode is getattr's");
	await assert.rejects(c.link(0, f2.fid, "hard"), errno(1), "no hard links");
	// A path-only backend: inode numbers from the path, the same in walk and readdir.
	const files = new Map<string, FsAttr>([["/", { type: "dir" }], ["/a", { type: "dir" }], ["/a/b", { type: "file", size: 0 }]]);
	const plain: Fs = {
		getattr: (p) => { const a = files.get(p); if (!a) throw new FsError("ENOENT"); return a; },
		readdir: (p) => [...files.keys()].filter((k) => k !== p && k.startsWith(p === "/" ? "/" : p + "/") && !k.slice(p.length + 1).includes("/")).map((k) => ({ name: k.slice(k.lastIndexOf("/") + 1), type: files.get(k)!.type })),
		open: () => ({ read: () => new Uint8Array(0) }),
	};
	const p = (await mount(plain)).c;
	const b = (await p.walk(0, ["a", "b"])).qids[1]!;
	assert.ok(b.path >= 1n << 63n, "a hashed number, apart from backends' own");
	assert.equal((await p.readdir(await p.open("a"))).find((e) => e.name === "b")!.ino, b.path);
	assert.notEqual((await p.walk(0, ["a"])).qids[0]!.path, b.path);
});

test("an open file keeps working after it is renamed or removed (MemoryFs); a fid walked over in place closes its file", async () => {
	const { mount } = setup();
	const fs = new MemoryFs({ "f.txt": "abc" });
	const { c } = await mount(fs);
	const fid = await c.open("f.txt", O_RDWR);
	await c.renameat(0, "f.txt", 0, "g.txt");
	await c.unlinkat(0, "g.txt");
	assert.equal(fs.exists("/g.txt"), false);
	assert.equal(await c.write(fid, 3, "def"), 3);
	assert.equal(dec.decode(await c.read(fid, 0, 10)), "abcdef");
	assert.equal((await c.getattr(fid)).size, 6);
	await c.truncate(fid, 2);
	assert.equal(dec.decode(await c.read(fid, 0, 10)), "ab");
	await c.clunk(fid);
	let closed = 0;
	const counting = filesOnly(() => ({ read: () => enc.encode("x"), close: () => { closed++; } }));
	const k = (await mount(counting)).c;
	const o = await k.open("a");
	await k.walk(0, ["b"], o);
	await tick(5);
	assert.equal(closed, 1, "Twalk onto an open fid closes its file");
	await assert.rejects(k.read(o, 0, 1), errno(9), "the replaced fid is not open");
});

test("a computed file is evaluated once per open: its reads and getattr see that one result, the next open evaluates again; version 0; not writable", async () => {
	const { mount } = setup();
	let n = 8;
	// Each result is longer than the one before ("9\n" nine times, then "10\n" ten times, ...).
	const fs = new MemoryFs({ count: () => `${++n}\n`.repeat(n) });
	const { c } = await mount(fs);
	const fid = await c.open("count");
	const evaluated = n;
	const a = await c.getattr(fid);
	assert.equal(a.qid.version, 0, "the guest reads it uncached");
	let got = "";
	for (let off = 0; ; off += 3) {
		const b = await c.read(fid, off, 3);
		if (!b.length) break;
		got += dec.decode(b);
	}
	assert.equal(n, evaluated, "reads and getattr of the open file evaluate nothing");
	assert.equal(got, `${n}\n`.repeat(n), "one whole result, read in pieces");
	assert.equal(a.size, got.length, "the open file's size is its result's");
	const again = await c.open("count");
	assert.ok(n > evaluated, "a new open evaluates again");
	assert.equal(dec.decode(await c.read(again, 0, 1000)), `${n}\n`.repeat(n));
	assert.equal(dec.decode(await c.read(fid, 0, 1000)), got, "the first open file keeps its result");
	await assert.rejects(c.open("count", O_RDWR), errno(13));
});

test("Tlink: a hard link through an Fs with link (nodeFs); EPERM without it and for a directory, EROFS on a read-only mount; a link and a rename never overlap", async (t) => {
	const { mount } = setup();
	const dir = mkdtempSync(joinPath(tmpdir(), "unkernel-9p-link-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(joinPath(dir, "a.txt"), "same");
	const { c } = await mount(nodeFs(dir));
	const a = await c.walk(0, ["a.txt"]);
	await c.link(0, a.fid, "b.txt");
	assert.equal(statSync(joinPath(dir, "b.txt")).ino, statSync(joinPath(dir, "a.txt")).ino, "one inode, two names");
	assert.equal(readFileSync(joinPath(dir, "b.txt"), "utf8"), "same");
	assert.equal((await c.getattr((await c.walk(0, ["b.txt"])).fid)).nlink, 2);
	await assert.rejects(c.link(0, (await c.walk(0, ["a.txt"])).fid, "b.txt"), errno(17), "EEXIST: the new name is taken");
	await c.mkdir(0, "d");
	await assert.rejects(c.link(0, (await c.walk(0, ["d"])).fid, "d2"), errno(1), "EPERM: no hard links to directories");

	// A symlink to a file outside the export: on Darwin, link(2) would follow it and give the guest a name
	// for the outside file. Refused both by the 9p server (the fid is a symlink) and by nodeFs itself.
	const outside = mkdtempSync(joinPath(tmpdir(), "unkernel-9p-outside-"));
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	writeFileSync(joinPath(outside, "secret"), "host");
	symlinkSync(joinPath(outside, "secret"), joinPath(dir, "evil"));
	await assert.rejects(c.link(0, (await c.walk(0, ["evil"])).fid, "copy"), errno(1), "EPERM: a hard link to a symlink");
	await assert.rejects(Promise.resolve(nodeFs(dir).link!("/evil", "/copy2")), (e: { code?: string }) => e.code === "EPERM", "nodeFs refuses a symlink source");
	assert.equal(statSync(joinPath(outside, "secret")).nlink, 1, "the outside file got no second name (only Darwin's link(2) would give it one)");

	const mem = await mount(new MemoryFs({ "x.txt": "x" }));
	await assert.rejects(mem.c.link(0, (await mem.c.walk(0, ["x.txt"])).fid, "y.txt"), errno(1), "EPERM: an Fs without link");
	const ro = await mount(nodeFs(dir), { readOnly: true });
	await assert.rejects(ro.c.link(0, (await ro.c.walk(0, ["a.txt"])).fid, "c.txt"), errno(30), "EROFS: a read-only mount");

	// A link and a rename never overlap, so neither path can be swapped during the link: a rename in
	// flight finishes first (the link then finds no source), and a link in flight holds the rename back.
	const fs = nodeFs(dir), other = nodeFs(dir);
	const [renamed, linked] = await Promise.allSettled([fs.rename!("/a.txt", "/r.txt"), other.link!("/a.txt", "/l.txt")]);
	assert.equal(renamed.status, "fulfilled");
	assert.equal(linked.status === "rejected" && (linked.reason as { code?: string }).code, "ENOENT", "the link ran after the rename");
	await Promise.all([fs.link!("/r.txt", "/l.txt"), other.rename!("/r.txt", "/a.txt")]);
	assert.equal(statSync(joinPath(dir, "l.txt")).ino, statSync(joinPath(dir, "a.txt")).ino, "the rename ran after the link");
});

test("Tlink: ESTALE when a directory on either path is a symlink now (the host swapped it after the walk)", async (t) => {
	const { mount } = setup();
	const dir = mkdtempSync(joinPath(tmpdir(), "unkernel-9p-link-")), outside = mkdtempSync(joinPath(tmpdir(), "unkernel-9p-outside-"));
	t.after(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});
	writeFileSync(joinPath(outside, "secret"), "host");
	writeFileSync(joinPath(dir, "payload"), "guest");
	mkdirSync(joinPath(dir, "a"));
	writeFileSync(joinPath(dir, "a", "secret"), "");
	const { c } = await mount(nodeFs(dir));
	const src = await c.walk(0, ["a", "secret"]);
	const into = await c.walk(0, ["a"]);
	rmSync(joinPath(dir, "a"), { recursive: true });
	symlinkSync(outside, joinPath(dir, "a"));
	await assert.rejects(c.link(0, src.fid, "x"), errno(116), "ESTALE: the source's directory is a symlink now");
	await assert.rejects(c.link(into.fid, (await c.walk(0, ["payload"])).fid, "planted"), errno(116), "ESTALE: the new name's directory is a symlink now");
	assert.equal(statSync(joinPath(outside, "secret")).nlink, 1, "the outside file got no second name");
	assert.ok(!existsSync(joinPath(dir, "x")) && !existsSync(joinPath(outside, "planted")), "no name made inside or outside");
});

test("nodeFs: a hung rename holds back links in its own host directory only", async (t) => {
	const hung = mkdtempSync(joinPath(tmpdir(), "unkernel-9p-hung-")), free = mkdtempSync(joinPath(tmpdir(), "unkernel-9p-free-"));
	const fspc = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
	const rename = fspc.rename;
	fspc.rename = ((a: string, b: string) => (String(a).startsWith(hung) ? new Promise<void>(() => {}) : rename(a, b))) as typeof rename;
	syncBuiltinESMExports();
	t.after(() => {
		fspc.rename = rename;
		syncBuiltinESMExports();
		rmSync(hung, { recursive: true, force: true });
		rmSync(free, { recursive: true, force: true });
	});
	writeFileSync(joinPath(hung, "h"), "");
	writeFileSync(joinPath(free, "f"), "");
	void nodeFs(hung).rename!("/h", "/h2");
	const fs = nodeFs(free);
	await fs.link!("/f", "/f2");
	await fs.rename!("/f2", "/f3");
	assert.equal(statSync(joinPath(free, "f3")).ino, statSync(joinPath(free, "f")).ino);
});

test("create, mkdir, symlink, readlink, readdir in pieces, unlinkat, rmdir, rename over, truncate on open; changes reported; Tlcreate without O_EXCL opens what exists", async () => {
	const { mount } = setup();
	const fs = new MemoryFs();
	const changes: MemoryFsChange[] = [];
	fs.onChange((c) => changes.push(c));
	const { c } = await mount(fs);
	const d = await c.walk(0, []);
	await c.lcreate(d.fid, "new.txt");
	assert.equal(await c.write(d.fid, 0, "hello"), 5, "the fid is now the created file, open");
	assert.equal(fs.readText("/new.txt"), "hello");
	await assert.rejects(c.lcreate((await c.walk(0, [])).fid, "new.txt", O_RDWR | O_EXCL), errno(17));
	await c.mkdir(0, "dir");
	await c.symlink(0, "lnk", "new.txt");
	const l = await c.walk(0, ["lnk"]);
	assert.equal(l.qids[0]!.type, 0x02);
	assert.equal(await c.readlink(l.fid), "new.txt");
	assert.equal((await c.walk(0, ["lnk", "x"])).qids.length, 1, "never walks through a symlink (a partial walk)");
	await assert.rejects(c.walk(l.fid, ["x"]), errno(20));
	for (let i = 0; i < 50; i++) fs.writeFile(`/dir/f${i}`, "");
	const dfid = await c.open("dir");
	const names = await c.readdirAll(dfid, 100);
	assert.equal(names.length, 52);
	assert.deepEqual(names.slice(0, 2), [".", ".."]);
	await assert.rejects(c.unlinkat(0, "dir", 0x200), errno(39));
	await c.unlinkat(0, "lnk");
	fs.writeFile("/other.txt", "other");
	await c.renameat(0, "other.txt", 0, "new.txt");
	assert.equal(fs.readText("/new.txt"), "other");
	const t = await c.open("new.txt", O_WRONLY | O_TRUNC);
	assert.equal(fs.readText("/new.txt"), "");
	await c.clunk(t);
	assert.deepEqual(changes.map((x) => x.type), ["create", "write", "mkdir", "symlink", "remove", "rename", "truncate"]);
	assert.deepEqual(changes.find((x) => x.type === "rename"), { type: "rename", path: "/other.txt", to: "/new.txt" });
	// Without O_EXCL an existing file is opened (the host made it after the guest's lookup); O_TRUNC truncates it.
	fs.writeFile("/racy.txt", "from the host");
	const rc = await c.walk(0, []);
	await c.lcreate(rc.fid, "racy.txt", O_RDWR);
	assert.equal(dec.decode(await c.read(rc.fid, 0, 100)), "from the host");
	await c.clunk(rc.fid);
	const rt = await c.walk(0, []);
	await c.lcreate(rt.fid, "racy.txt", O_RDWR | O_TRUNC);
	assert.equal(await c.write(rt.fid, 0, "guest"), 5);
	assert.equal(fs.readText("/racy.txt"), "guest");
	await c.clunk(rt.fid);
	await assert.rejects(c.lcreate((await c.walk(0, [])).fid, "dir", O_RDWR), errno(21), "a directory is not opened");
});

test("names that are not UTF-8 are refused (EILSEQ), never decoded lossily", async () => {
	const { mount } = setup();
	const fs = new MemoryFs({ "�": "the replacement character's own file" });
	const { c } = await mount(fs);
	const bad = Uint8Array.of(0x61, 0xff, 0x62);
	await assert.rejects(c.lcreate((await c.walk(0, [])).fid, bad), errno(84));
	await assert.rejects(c.walk(0, [Uint8Array.of(0xff)]), errno(84), "not aliased to the file named U+FFFD");
	assert.deepEqual(fs.list(), ["�"]);
	assert.equal((await c.walk(0, ["�"])).qids.length, 1);
});

test("errors: handlers' errno codes (FsError, Node codes), anything else EIO and logged; missing methods EROFS/EOPNOTSUPP; xattr EOPNOTSUPP without a log line", async () => {
	const { mount, logs } = setup();
	const fs = filesOnly((p) => {
		if (p === "/acc") throw Object.assign(new Error("denied"), { code: "EACCES" });
		if (p === "/p9") throw new FsError("ENOSPC");
		if (p === "/bug") throw new TypeError("a bug");
		return { read: () => enc.encode("r") };
	});
	const { c, exp } = await mount(fs);
	await assert.rejects(c.open("acc"), errno(13));
	await assert.rejects(c.open("p9"), errno(28));
	await assert.rejects(c.open("bug"), errno(5));
	await assert.rejects(c.lcreate((await c.walk(0, [])).fid, "x"), errno(30));
	await assert.rejects(c.mkdir(0, "m"), errno(30));
	await assert.rejects(c.symlink(0, "s", "t"), errno(95));
	await assert.rejects(c.rpc(T.xattrwalk, new Enc().u32(0).u32(99).str("security.capability")), errno(95));
	await assert.rejects(c.open("ro", O_RDWR), errno(13), "a file without write() is not opened for writing");
	assert.equal(dec.decode(await c.read(await c.open("ro"), 0, 9)), "r");
	assert.equal(logs.length, 1, logs.join("\n"));
	assert.match(logs[0]!, /a bug/);
	assert.equal(exp.stats.errors, 8);
});

test("readOnly: changes answer EROFS before the backend sees them; Tremove still drops the fid", async () => {
	const { mount } = setup();
	const fs = new MemoryFs({ "f.txt": "x", d: {} });
	const changes: MemoryFsChange[] = [];
	fs.onChange((ch) => changes.push(ch));
	const { c } = await mount(fs, { readOnly: true });
	assert.equal(dec.decode(await c.read(await c.open("f.txt"), 0, 9)), "x");
	await assert.rejects(c.open("f.txt", O_RDWR), errno(30));
	await assert.rejects(c.open("f.txt", O_RDONLY | O_TRUNC), errno(30));
	await assert.rejects(c.lcreate((await c.walk(0, [])).fid, "n"), errno(30));
	await assert.rejects(c.mkdir(0, "m"), errno(30));
	await assert.rejects(c.unlinkat(0, "f.txt"), errno(30));
	await assert.rejects(c.renameat(0, "f.txt", 0, "g"), errno(30));
	const w = await c.walk(0, ["f.txt"]);
	await assert.rejects(c.remove(w.fid), errno(30));
	await assert.rejects(c.getattr(w.fid), errno(9), "the fid is gone after Tremove");
	assert.equal(fs.readText("/f.txt"), "x");
	assert.deepEqual(changes, []);
});

test("writes through one fid run in order, even with handlers that finish out of order", async () => {
	const { mount } = setup();
	const order: string[] = [];
	const store = new Uint8Array(16);
	const { c } = await mount(filesOnly(() => ({
		read: () => store,
		write: async (off, data) => {
			order.push(dec.decode(data));
			await tick(Math.random() * 5);
			store.set(data, off);
			return data.length;
		},
	})));
	const fid = await c.open("f", O_RDWR);
	await Promise.all(Array.from({ length: 12 }, (_, i) => c.write(fid, 0, String.fromCharCode(97 + i).repeat(4))));
	assert.deepEqual(order, Array.from({ length: 12 }, (_, i) => String.fromCharCode(97 + i).repeat(4)));
	assert.equal(dec.decode(store.subarray(0, 4)), "llll");
});

test("Tflush answers at once and frees the slot; at most 16 run per connection", async () => {
	const { mount } = setup();
	let started = 0;
	const { c } = await mount(filesOnly((p) => ({
		read: () => {
			if (p !== "/hang") return enc.encode("ok");
			started++;
			return new Promise<Uint8Array>(() => {}); // never settles
		},
	})));
	const hang = await c.open("hang");
	const ok = await c.open("ok");
	const tags = Array.from({ length: 24 }, (_, i) => 100 + i);
	const hung = tags.map((tag) => c.rpc(T.read, new Enc().u32(hang).u64(0).u32(1), tag));
	hung.forEach((p) => p.catch(() => {}));
	await tick(20);
	assert.equal(started, 16, "the window holds 16; the rest wait parsed");
	const quick = c.read(ok, 0, 2);
	await tick(20);
	// Flush all of them, the queued ones first (dropped here; a running one's flush frees a
	// slot, which would start the next queued request), then the running ones.
	await Promise.all([...tags].reverse().map((old, i) => c.rpc(T.flush, new Enc().u16(old), 500 + i)));
	assert.equal(dec.decode(await quick), "ok", "the request behind them ran once slots were free");
	assert.equal(started, 16, "flushed queued requests never reached the backend");
	assert.equal(dec.decode(await c.read(ok, 0, 2)), "ok");
	await tick(10);
	assert.deepEqual(c.stray, [], "no reply for a flushed tag");
});

test("a hung handler is answered ETIMEDOUT after the timeout and logged; a late open is closed; the fid's next write goes on", async () => {
	const { mount, logs } = setup();
	let closedLate = 0, writes = 0;
	let release!: () => void;
	const fs = filesOnly((p) => {
		const file: FsFile = {
			read: () => (p === "/hang" ? new Promise<Uint8Array>(() => {}) : enc.encode("ok")),
			write: (_off, data) => (writes++ === 0 ? new Promise<number>(() => {}) : data.length),
			close: () => { closedLate++; },
		};
		return p === "/slow-open" ? new Promise((r) => (release = () => r(file))) : file;
	});
	const { c } = await mount(fs, { timeout: 50 });
	const t0 = performance.now();
	await assert.rejects(c.read(await c.open("hang"), 0, 1), errno(110));
	assert.ok(performance.now() - t0 < 1000);
	assert.match(logs.join("\n"), /read: the handler did not answer within 50 ms/);
	await assert.rejects(c.open("slow-open"), errno(110));
	release();
	await tick(5);
	assert.equal(closedLate, 1, "the file opened after the timeout is closed");
	const w = await c.open("w", O_RDWR);
	await assert.rejects(c.write(w, 0, "first"), errno(110));
	assert.equal(await c.write(w, 0, "second"), 6, "the hung write holds the fid's next write back only until its timeout");
	assert.equal(dec.decode(await c.read(await c.open("ok"), 0, 2)), "ok");
	await tick(80);
	assert.deepEqual(c.stray, [], "a late answer is dropped");
});

test("a throwing or slow handler leaves other requests alone; replies may come out of order", async () => {
	const { mount } = setup();
	const { c } = await mount(filesOnly((p) => ({
		read: async () => {
			if (p === "/slow") await tick(30);
			if (p === "/boom") throw new Error("boom");
			return enc.encode(p);
		},
	})));
	const [slow, fast, boom] = await Promise.all([c.open("slow"), c.open("fast"), c.open("boom")]);
	const done: string[] = [];
	await Promise.all([
		c.read(slow, 0, 9).then((b) => done.push(dec.decode(b))),
		c.read(boom, 0, 9).catch(() => done.push("boom")),
		c.read(fast, 0, 9).then((b) => done.push(dec.decode(b))),
	]);
	assert.deepEqual(done, ["boom", "/fast", "/slow"]);
});

test("remove() and close(): connections reset; a backend's close() runs once its last export is gone", async () => {
	const { vsock, srv, client } = setup();
	let closed = 0;
	const fs = Object.assign(new MemoryFs({ a: "1" }), { close: () => { closed++; } });
	const e1 = srv.add(fs), e2 = srv.add(fs);
	const opens: boolean[] = [];
	e1.onConnection = (connected) => opens.push(connected);
	const c = client();
	await c.mount(e1.name);
	assert.deepEqual(opens, [true]);
	assert.equal(e1.connected, true);
	const c2 = client();
	await c2.mount(e2.name);
	assert.equal(e2.connected, true, "the same backend at a second export has its own connection");
	assert.notEqual(e1.name, e2.name);
	e1.remove();
	await tick(5);
	assert.equal(vsock.conns[0]!.resets, 1);
	assert.equal(vsock.conns[1]!.resets, 0);
	assert.equal(closed, 0, "still mounted elsewhere");
	e2.remove();
	await tick(5);
	assert.equal(closed, 1);
	const e3 = srv.add(new MemoryFs());
	srv.close();
	assert.equal(vsock.closedListener, true);
	assert.equal(e3.removed, true);
	assert.throws(() => srv.add(new MemoryFs()), /closed/);
	const late = client();
	await late.version();
	await assert.rejects(late.attach(e3.name), errno(2));
});

test("MemoryFs host API: a tree, computed files (version 0), writeFile keeps the inode, rm, move, list, stat", () => {
	let n = 0;
	const fs = new MemoryFs({ "a.txt": "a", bin: new Uint8Array([1, 2]), dir: { sub: { "x": "x" } }, "count": () => String(++n) });
	assert.deepEqual(fs.list().sort(), ["a.txt", "bin", "count", "dir"]);
	assert.equal(fs.readText("/dir/sub/x"), "x");
	assert.deepEqual([...fs.readFile("/bin")], [1, 2]);
	assert.equal(fs.readText("/count"), "1");
	assert.equal(fs.getattr("/count").version, 0);
	const ino = fs.stat("/a.txt")!.ino;
	const v = fs.stat("/a.txt")!.version!;
	fs.writeFile("/a.txt", "changed");
	assert.equal(fs.stat("/a.txt")!.ino, ino);
	assert.ok(fs.stat("/a.txt")!.version! > v);
	fs.writeFile("/new/deep/file", "made parents");
	assert.equal(fs.readText("/new/deep/file"), "made parents");
	fs.move("/new", "/moved");
	assert.equal(fs.exists("/new"), false);
	assert.throws(() => fs.rm("/moved"), /ENOTEMPTY/);
	fs.rm("/moved", { recursive: true });
	fs.rm("/nope", { force: true });
	assert.throws(() => fs.rm("/nope"), /ENOENT/);
	fs.writeLink("/l", "a.txt");
	assert.equal(fs.readlink("/l"), "a.txt");
	assert.throws(() => fs.rename("/dir", "/dir/sub/inside"), /into itself/);
	assert.throws(() => new MemoryFs({ bad: 1 as never }), /a string, a Uint8Array or a function/);
});

test("mount helpers: paths, createKernel's mounts checked before boot", () => {
	assert.equal(normalizeMountPath("/mnt//host/"), "/mnt/host");
	for (const bad of ["mnt", "/", "/a/../b", "", "/a,b"]) assert.throws(() => normalizeMountPath(bad), (e: unknown) => e instanceof MountError && e.code === "EINVAL");
	const tree = { "f.txt": "x" };
	const list = parseMounts({ "/a": tree, "/b/": { fs: tree, readOnly: true, requestTimeout: 5 }, "/c": { fs: { fs: "a file named fs" } } }, true);
	assert.deepEqual(list.map((m) => [m.path, m.opts]), [["/a", {}], ["/b", { readOnly: true, requestTimeout: 5 }], ["/c", {}]]);
	// A tree whose names are not all option names is a tree, even with a "fs" entry.
	assert.deepEqual(parseMounts({ "/d": { fs: { x: "1" }, "readme.txt": "r" } }, true)[0]!.opts, {});
	assert.throws(() => parseMounts({ "/a": tree }, false), (e: unknown) => e instanceof MountError && e.code === "ENODEV");
	assert.throws(() => toFs("text" as never), MountError);
	assert.ok(toFs(tree) instanceof MemoryFs);
	const own = new MemoryFs();
	assert.equal(toFs(own), own);
});

// --- Snapshots: a real VsockHost, and the guest's end of the vsock protocol ---------

/** The guest's end of one vsock stream connection to the host's port 564, as streams for Client. */
class GuestVsock {
	send: (pkt: Uint8Array) => void = () => {};
	readonly port: number;
	rxCnt = 0;
	resets = 0;
	#rc!: ReadableStreamDefaultController<Uint8Array>;
	#established!: () => void;
	readonly established = new Promise<void>((r) => (this.#established = r));
	readonly toServer: WritableStream<Uint8Array>;
	readonly fromServer: ReadableStream<Uint8Array>;

	constructor(port: number) {
		this.port = port;
		this.fromServer = new ReadableStream({ start: (c) => { this.#rc = c; } });
		this.toServer = new WritableStream({ write: (chunk) => this.#packet(VSOCK_OP_RW, chunk) });
	}

	#packet(op: number, payload?: Uint8Array): void {
		this.send(encodeVsockPacket({ srcCid: 3, dstCid: 2, srcPort: this.port, dstPort: 564, type: 1, op, flags: 0, bufAlloc: 1 << 20, fwdCnt: this.rxCnt }, payload));
	}

	connect(): Promise<void> {
		this.#packet(VSOCK_OP_REQUEST);
		return this.established;
	}

	/** A packet from the host. */
	receive(pkt: Uint8Array): void {
		const h = decodeVsockHeader(pkt);
		if (h.op === VSOCK_OP_RESPONSE) this.#established();
		else if (h.op === VSOCK_OP_RW) {
			this.rxCnt = (this.rxCnt + h.len) >>> 0;
			this.#rc.enqueue(pkt.slice(VSOCK_HEADER_SIZE, VSOCK_HEADER_SIZE + h.len));
		} else if (h.op === VSOCK_OP_CREDIT_REQUEST) this.#packet(VSOCK_OP_CREDIT_UPDATE);
		else if (h.op === VSOCK_OP_RST) this.resets++;
	}
}

/** A VsockHost whose guest is `g` (and, by port, the guests in `more`). */
function hostFor(g: GuestVsock, more?: Map<number, GuestVsock>): VsockHost {
	const host = new VsockHost({ send: (pkt) => queueMicrotask(() => (more?.get(decodeVsockHeader(pkt).dstPort) ?? g).receive(pkt)) });
	host.deviceReady(3, 65536);
	g.send = (pkt) => queueMicrotask(() => host.receive(pkt));
	return host;
}

test("snapshot of an export: the session and its connection are saved when quiet and restored on a new host; open files reopen by path; gone, replaced or orphaned ones answer ESTALE", async () => {
	const ESTALE = 116;
	const fs = new MemoryFs({ "keep.txt": "kept", "gone.txt": "g", "replaced.txt": "old", "orphan.txt": "o", dir: { a: "1", b: "2", c: "3", d: "4" } });
	const g = new GuestVsock(4000);
	const host1Guests = new Map<number, GuestVsock>([[4000, g]]);
	const host1 = hostFor(g, host1Guests);
	const srv1 = serve9p(host1);
	const exp = srv1.add(fs);
	await g.connect();
	const c = new Client(g);
	await c.mount(exp.name);
	const keep = await c.open("keep.txt", O_RDWR);
	const gone = await c.open("gone.txt");
	const replaced = await c.open("replaced.txt");
	const orphan = await c.open("orphan.txt", O_RDWR);
	await c.unlinkat(0, "orphan.txt"); // unlinked by the guest while open
	const dir = await c.open("dir");
	const first = await c.readdir(dir, 0, 70); // part of the listing
	assert.ok(first.length >= 2 && first.length < 6, `${first.length} entries in the first part`);
	assert.equal(dec.decode(await c.read(keep, 0, 10)), "kept");
	await tick(5);
	assert.equal(srv1.exportBusy(exp), undefined);
	// Another export, with a request its handler holds: not quiet until it is answered.
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const slow = srv1.add(filesOnly(() => ({ read: async () => { await gate; return enc.encode("s"); } })));
	const g2 = new GuestVsock(4001);
	g2.send = (pkt) => queueMicrotask(() => host1.receive(pkt));
	host1Guests.set(4001, g2);
	await g2.connect();
	const c2 = new Client(g2);
	await c2.mount(slow.name);
	const held = c2.read(await c2.open("x"), 0, 1);
	await tick(5);
	assert.equal(srv1.exportBusy(slow), "a request in flight");
	release();
	assert.equal(dec.decode(await held), "s");
	await tick(5);
	assert.equal(srv1.exportBusy(slow), undefined);
	const saved = JSON.parse(JSON.stringify(srv1.saveExport(exp)));
	assert.equal(saved.name, exp.name);
	assert.equal(saved.conn.remotePort, 4000);
	assert.ok(saved.fids.find((f: { path: string; orphan?: boolean }) => f.path === "/orphan.txt" && f.orphan));

	// While suspended, the host deletes one file and puts another file under a name.
	fs.rm("/gone.txt");
	fs.rm("/replaced.txt");
	fs.writeFile("/replaced.txt", "new");
	const host2 = hostFor(g); // the guest's end goes on with its counters; the old host is gone
	const srv2 = serve9p(host2);
	const exp2 = await srv2.restoreExport(fs, {}, saved, host2.adopt(saved.conn));
	assert.equal(exp2.name, exp.name);
	assert.ok(exp2.connected);
	assert.equal(srv2.add(new MemoryFs()).name, `fs${Number(exp.name.slice(2)) + 1}`, "names go on after the restored one");

	assert.equal(dec.decode(await c.read(keep, 0, 10)), "kept", "an open file reads after the restore");
	assert.equal(await c.write(keep, 4, "+more"), 5);
	assert.equal(fs.readText("/keep.txt"), "kept+more");
	await assert.rejects(c.read(gone, 0, 1), errno(ESTALE), "deleted on the host");
	await assert.rejects(c.read(replaced, 0, 1), errno(ESTALE), "another file under the name");
	await assert.rejects(c.write(orphan, 0, "x"), errno(ESTALE), "unlinked by the guest while open");
	await assert.rejects(c.getattr(orphan), errno(ESTALE));
	await c.clunk(orphan);
	const rest = await c.readdir(dir, first.at(-1)!.offset, 8192);
	assert.deepEqual([...first, ...rest].map((e) => e.name), [".", "..", "a", "b", "c", "d"], "the listing goes on where it was");
	assert.equal((await c.attach(exp.name, 60)).type, 0x80, "the guest attaches again by the same name");
	const made = await c.walk(0, []);
	await c.lcreate(made.fid, "new.txt");
	await c.write(made.fid, 0, "after");
	assert.equal(fs.readText("/new.txt"), "after");
	// A large read crosses the restored credit counters.
	fs.writeFile("/big", new Uint8Array(300 * 1024).fill(7));
	const big = await c.open("big");
	let total = 0;
	for (let off = 0; ; off += 65536) {
		const b = await c.read(big, off, 65536);
		if (!b.length) break;
		total += b.length;
	}
	assert.equal(total, 300 * 1024);
	assert.equal(g.resets, 0, "the connection was never reset");
	srv1.close();
	srv2.close();
});

test("snapshot mount checks: each saved mount path given, read-only as saved; others are mounted as at boot", () => {
	const saved = { next: 3, mounts: [{ path: "/a", readOnly: false, export: {} as never }, { path: "/b", readOnly: true, export: {} as never }] };
	const tree = { "f.txt": "x" };
	assert.equal(snapshotMountMismatch(saved, parseMounts({ "/a": tree, "/b": { fs: tree, readOnly: true }, "/c": tree }, true)), null);
	assert.match(snapshotMountMismatch(saved, parseMounts({ "/a": tree }, true))!, /has a host file system at \/b, which this machine is not given/);
	assert.match(snapshotMountMismatch(saved, parseMounts({ "/a": tree, "/b": tree }, true))!, /\/b is read-only in the snapshot/);
	assert.match(snapshotMountMismatch(saved, parseMounts({ "/a": { fs: tree, readOnly: true }, "/b": { fs: tree, readOnly: true } }, true))!, /\/a is not read-only/);
	assert.equal(snapshotMountMismatch(undefined, []), null);
});
