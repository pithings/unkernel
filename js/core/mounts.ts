// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Host file systems mounted in the guest: createKernel({ mounts }) and
// vm.mount(). Built on the 9p server (9p.ts) and kwtty (tty.ts): the server
// listens on vsock port 564, and a mount runs `kw9p NAME PATH [ro]` in the
// guest through exec(), which retries its connect while kwtty is not up
// yet. Both run on the thread that owns the VM, so the API and the handlers
// are the same inline and in worker mode.
//
//   const vm = await createKernel({ mounts: { "/mnt/host": { "hello.txt": "hi\n" } } });
//   await vm.exec("cat", ["/mnt/host/hello.txt"]);    // spawn() and exec() wait for these mounts
//   const m = await vm.mount("/work", nodeFs("."), { readOnly: true });
//   await m.unmount();
//
// Every mount uses the 9p client's cache=readahead with metatimeout=1000
// (kw9p's fixed options): the guest reuses names and attributes it has
// looked up for up to 1 s, then asks the host again, so a host change shows
// within 1 s; each guest write(2) reaches the host before it returns, and
// nothing waits in the guest to be written back (.agents/js.md has numbers).
//
// Snapshots (inline mode): a mount survives a restore with its open files.
// At the snapshot point each 9p session is quiet (every guest task is
// parked, and a 9p request holds its task until answered), so its fids and
// its vsock connection's counters are saved (MountTable.save(), carried in
// the vsock device's snapshot). createKernel({ restore, mounts }) must be
// given a file system for each saved mount path, read-only as it was; it
// serves it under the same export name on the connection it takes over,
// opens the files again by path, and tells the kernel to keep exactly these
// connections (VsockDevice.keep). The files are the given file system's:
// nothing of them is copied (a MemoryFs passed again keeps the guest's
// changes; a new one has its own content, which the guest sees within 1 s,
// as any host change).

import { P9_PORT, serve9p, type P9Export, type P9ExportSnapshot, type P9Server } from "./9p.ts";
import type { Fs } from "./fs.ts";
import { MemoryFs, type FsTree } from "./memfs.ts";
import { PtyError, execSubprocess, type ExecResult } from "./tty.ts";
import { VsockHost, type Vsock } from "./vsock.ts";

/** A file system to mount: an Fs (MemoryFs, nodeFs(), your own) or a plain object tree (made a MemoryFs). */
export type FsSource = Fs | FsTree;

export interface MountOptions {
	/** The host answers every change with EROFS, and the guest mounts it read-only. Default false. */
	readOnly?: boolean;
	/** How long mounting (or unmounting) may take, in ms, kwtty's start included. Default 30000; 120000 for createKernel's mounts. */
	timeout?: number;
	/** How long a handler may take before the guest's request fails with ETIMEDOUT (and a log line), in ms; 0 for never. Default 30000. */
	requestTimeout?: number;
}

export interface MountSpec extends MountOptions {
	fs: FsSource;
}

/** createKernel's `mounts`: guest paths to a file system, or to { fs, ...MountOptions }. */
export type MountsOption = Record<string, FsSource | MountSpec>;

export type MountErrorCode =
	/** The instance has no vsock device, or the guest's kernel has no 9p (CONFIG_9P_FS). */
	| "ENODEV"
	/** The guest has no kwbox (a base from before it). */
	| "ENOENT"
	/** The path is already a mount point (in the guest, or by this SDK), or busy at unmount. */
	| "EBUSY"
	/** The guest path exists and is not a directory. */
	| "ENOTDIR"
	/** A bad path or file system. */
	| "EINVAL"
	/** The guest did not finish within the timeout (no kwtty answered, or a handler hung). */
	| "ETIMEDOUT"
	/** The kernel exited. */
	| "ECONNABORTED"
	/** The guest failed otherwise (the message has its words). */
	| "EREMOTE";

export class MountError extends Error {
	readonly code: MountErrorCode;
	constructor(code: MountErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "MountError";
		this.code = code;
	}
}

/** What the guest asked of a mount (Mount.stats). */
export interface MountStats {
	requests: number;
	/** Requests answered with an error. */
	errors: number;
	/** Payload bytes the guest read and wrote. */
	bytesRead: number;
	bytesWritten: number;
}

/** A host file system mounted in the guest (vm.mount(), createKernel({ mounts })). */
export interface Mount {
	/** The guest path. */
	readonly path: string;
	/** True while the guest has it mounted (false once unmounted, by unmount() or in the guest, or at exit). */
	readonly mounted: boolean;
	/** Requests, errors, and payload bytes the guest read and wrote. */
	readonly stats: MountStats;
	/** Unmount it in the guest and stop serving it. Rejects with a MountError EBUSY while a guest process uses it. */
	unmount(opts?: { timeout?: number }): Promise<void>;
}

/** @internal Host file systems as a snapshot keeps them (in VsockSnapshot.mounts). */
export interface MountsSnapshot {
	/** The 9p server's next export number. */
	next: number;
	mounts: Array<{ path: string; readOnly: boolean; export: P9ExportSnapshot }>;
}

/**
 * @internal Why createKernel's `mounts` cannot resume a snapshot with
 * `saved`, or null: each saved mount path must be given, read-only as it
 * was (the restored guest has it mounted so). Mounts not in the snapshot
 * are mounted after the restore, as at boot.
 */
export function snapshotMountMismatch(saved: MountsSnapshot | undefined, given: Parsed[]): string | null {
	for (const m of saved?.mounts ?? []) {
		const g = given.find((x) => x.path === m.path);
		if (!g) return `the snapshot has a host file system at ${m.path}, which this machine is not given (mounts)`;
		if (!!g.opts.readOnly !== m.readOnly) return `the host file system at ${m.path} is ${m.readOnly ? "" : "not "}read-only in the snapshot`;
	}
	return null;
}

const BOOT_TIMEOUT_MS = 120000;
const DEFAULT_TIMEOUT_MS = 30000;
const SPEC_KEYS = new Set(["fs", "readOnly", "timeout", "requestTimeout"]);

const isFs = (v: unknown): v is Fs => !!v && typeof v === "object" && typeof (v as Fs).getattr === "function";

/** An object is a { fs, ... } spec only when it has `fs` (an object) and nothing but option names, so a tree may hold a file called `fs`. */
function isSpec(v: unknown): v is MountSpec {
	if (!v || typeof v !== "object" || isFs(v) || !("fs" in v)) return false;
	const fs = (v as { fs: unknown }).fs;
	return !!fs && typeof fs === "object" && Object.keys(v).every((k) => SPEC_KEYS.has(k));
}

/** @internal An FsSource as an Fs (a tree becomes a MemoryFs). */
export function toFs(src: FsSource): Fs {
	if (isFs(src)) return src;
	if (src && typeof src === "object" && !(src instanceof Uint8Array)) return new MemoryFs(src as FsTree);
	throw new MountError("EINVAL", "a file system is an Fs (MemoryFs, nodeFs(), your own) or an object tree of files");
}

/** @internal "/a//b/" -> "/a/b"; EINVAL for a relative path, "..", "/", a NUL or a comma. */
export function normalizeMountPath(path: string): string {
	if (typeof path !== "string" || !path.startsWith("/") || /[\0,]/.test(path)) throw new MountError("EINVAL", `mount path ${JSON.stringify(path)}: an absolute guest path`);
	const parts = path.split("/").filter((p) => p && p !== ".");
	if (parts.includes("..")) throw new MountError("EINVAL", `mount path ${JSON.stringify(path)}: no ".." parts`);
	if (!parts.length) throw new MountError("EINVAL", "mount path \"/\": not over the root");
	return `/${parts.join("/")}`;
}

/** @internal */
export type Parsed = { path: string; fs: FsSource; opts: MountOptions };

/** @internal createKernel's `mounts`, checked before boot. */
export function parseMounts(mounts: MountsOption | undefined, vsock: boolean): Parsed[] {
	if (!mounts) return [];
	const list = Object.entries(mounts).map(([path, v]): Parsed => {
		const { fs, ...opts } = isSpec(v) ? v : { fs: v as FsSource };
		toFs(fs); // checks it
		return { path: normalizeMountPath(path), fs, opts };
	});
	if (list.length && !vsock) throw new MountError("ENODEV", "createKernel({ mounts }) needs the vsock device (the 9p server and kwtty run over it); it was turned off (vsock: false)");
	return list;
}

class MountHandle implements Mount {
	readonly path: string;
	readonly exp: P9Export;
	readonly readOnly: boolean;
	state: "mounting" | "mounted" | "unmounting" | "gone" = "mounting";
	#table: MountTable;

	constructor(table: MountTable, exp: P9Export, path: string, readOnly: boolean) {
		this.#table = table;
		this.exp = exp;
		this.path = path;
		this.readOnly = readOnly;
	}

	get mounted(): boolean {
		return this.state === "mounted" || this.state === "unmounting";
	}

	get stats(): MountStats {
		return { ...this.exp.stats };
	}

	/** Gone (unmounted, failed, or the kernel exited): free the path and stop serving. */
	gone(): void {
		this.state = "gone";
		this.#table.release(this);
		this.exp.remove();
	}

	unmount(opts: { timeout?: number } = {}): Promise<void> {
		return this.#table.unmount(this, opts);
	}
}

/** @internal The guest's tools as one program (guest/src/kwbox.c): `kwbox TOOL ARGS`, in the base's kw layer. */
export const KWBOX = "/usr/bin/kwbox";

/** @internal A guest without KWBOX: a base from before it (kwtty refused the exec). */
export const noKwbox = (msg: string) => msg.includes(`exec ${KWBOX}: No such file`);

/** @internal Run `cmd` in the guest as root (mount, umount, kwbox cmd sync: /run/kw/bin) with a deadline over the whole run (exec()'s own covers only reaching kwtty); it is killed when it runs out. */
export async function guestRun(vsock: Vsock, file: string, args: string[], timeout: number): Promise<ExecResult<string>> {
	const ac = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			execSubprocess(vsock, file, args, { timeout, signal: ac.signal, user: "root" }),
			new Promise<never>((_, rej) => (timer = setTimeout(() => {
				ac.abort();
				rej(new PtyError("ETIMEDOUT", `${file} did not finish within ${timeout} ms (it was killed)`));
			}, timeout))),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** @internal The mounts of one instance (KernelInstance and WorkerKernel each have one). */
export class MountTable {
	#vsock: Vsock | undefined;
	#log: (msg: string) => void;
	#server: P9Server | undefined;
	#mounts = new Map<string, MountHandle>();
	/** createKernel's mounts while they run: rejects with the first failure. */
	#boot: Promise<unknown> | undefined;
	#down = false;

	constructor(vsock: Vsock | undefined, log: (msg: string) => void) {
		this.#vsock = vsock;
		this.#log = log;
	}

	get mounts(): ReadonlyMap<string, Mount> {
		return this.#mounts;
	}

	/**
	 * Why a snapshot cannot be started now, or undefined. `keep`: the
	 * snapshot can keep mounts (inline: the 9p server runs on the kernel's
	 * thread, so it is saved at the snapshot point); without it (worker
	 * mode) any mount refuses, since a restored machine would not get its
	 * 9p session back.
	 */
	snapshotBlocker(keep = false): string | undefined {
		if (this.#boot) return "createKernel's mounts are still being mounted";
		if (!keep && this.#mounts.size) return `host file systems are mounted (${[...this.#mounts.keys()].join(", ")}); unmount them first, or take it with commit (a worker's snapshot keeps them only then)`;
		for (const h of this.#mounts.values()) if (h.state !== "mounted") return `${h.path} is being ${h.state === "mounting" ? "mounted" : "unmounted"}`;
		return undefined;
	}

	/** At the snapshot point: why the mounts cannot be saved now (a request in flight), or "". */
	snapshotBusy(): string {
		const why = this.snapshotBlocker(true);
		if (why) return why;
		for (const h of this.#mounts.values()) {
			const b = this.#server!.exportBusy(h.exp);
			if (b) return `host file system ${h.path}: ${b}`;
		}
		return "";
	}

	/** At the snapshot point (snapshotBusy() was ""): the mounts, or undefined without any. */
	save(): MountsSnapshot | undefined {
		if (!this.#mounts.size || !this.#server) return undefined;
		return {
			next: this.#server.next,
			mounts: [...this.#mounts.values()].map((h) => ({ path: h.path, readOnly: h.readOnly, export: this.#server!.saveExport(h.exp) })),
		};
	}

	/**
	 * A restore, before the kernel runs (snapshotMountMismatch() was null):
	 * serve each saved mount from the given file system on the connection
	 * the snapshot kept. Returns the connections to keep
	 * (VsockDevice.keep) and the given mounts that were not in the
	 * snapshot, which mountAll() mounts once the kernel runs.
	 */
	async restore(saved: MountsSnapshot | undefined, given: Parsed[]): Promise<{ keep: Set<string>; rest: Parsed[] }> {
		const keep = new Set<string>();
		if (!saved?.mounts.length) return { keep, rest: given };
		const vsock = this.#vsock;
		if (!(vsock instanceof VsockHost)) throw new MountError("ENODEV", "host file systems in a snapshot need this instance's vsock host");
		this.#server ??= serve9p(vsock, this.#log);
		this.#server.next = Math.max(this.#server.next, saved.next);
		for (const m of saved.mounts) {
			const g = given.find((x) => x.path === m.path)!;
			const conn = vsock.adopt(m.export.conn);
			// The kernel's socket: guest port (the connection's remote end) : host port.
			keep.add(`${m.export.conn.remotePort}:${m.export.conn.localPort}`);
			const exp = await this.#server.restoreExport(toFs(g.fs), { readOnly: m.readOnly, timeout: g.opts.requestTimeout }, m.export, conn);
			const h = new MountHandle(this, exp, m.path, m.readOnly);
			h.state = "mounted";
			this.#mounts.set(m.path, h);
			this.#watch(h);
		}
		return { keep, rest: given.filter((g) => !saved.mounts.some((m) => m.path === g.path)) };
	}

	/** Unmounted in the guest (umount by hand, or the connection failed): the handle is gone. */
	#watch(h: MountHandle): void {
		h.exp.onConnection = (connected) => {
			if (!connected && h.state === "mounted") {
				this.#log(`[host] ${h.path} was unmounted in the guest`);
				h.gone();
			}
		};
	}

	/** Run fn once createKernel's mounts are done; rejects with the first MountError if one failed (spawn() and exec() go through here). */
	gate<T>(fn: () => Promise<T>): Promise<T> {
		return this.#boot ? this.#boot.then(fn) : fn();
	}

	/** Mount createKernel's `mounts` (already parsed) once kwtty answers. */
	mountAll(list: Parsed[]): void {
		if (!list.length) return;
		const boot = Promise.allSettled(list.map((m) => this.mount(m.path, m.fs, { timeout: BOOT_TIMEOUT_MS, ...m.opts }))).then((rs) => {
			if (this.#boot === boot) this.#boot = undefined;
			const failed = rs.flatMap((r) => (r.status === "rejected" ? [r.reason as Error] : []));
			for (const e of failed) this.#log(`[host] ${e?.message ?? e}`);
			if (failed.length) throw failed[0];
		});
		boot.catch(() => {}); // reported in the log and to the spawn() and exec() calls that waited
		this.#boot = boot;
	}

	async mount(path: string, src: FsSource, opts: MountOptions = {}): Promise<Mount> {
		const vsock = this.#vsock;
		if (!vsock) throw new MountError("ENODEV", "host file systems need the vsock device, which this instance has not: it was created with vsock: false");
		if (this.#down) throw new MountError("ECONNABORTED", "the kernel exited");
		const p = normalizeMountPath(path);
		const fs = toFs(src);
		if (this.#mounts.has(p)) throw new MountError("EBUSY", `${p}: already mounted by this SDK`);
		if (!this.#server) {
			try {
				this.#server = serve9p(vsock, this.#log);
			} catch (e) {
				throw new MountError("EBUSY", `cannot serve 9p on vsock port ${P9_PORT}: ${(e as Error)?.message ?? e}`, e);
			}
		}
		const exp = this.#server.add(fs, { readOnly: opts.readOnly, timeout: opts.requestTimeout });
		const h = new MountHandle(this, exp, p, !!opts.readOnly);
		this.#mounts.set(p, h);
		this.#watch(h);
		const fail = (e: MountError): never => {
			h.gone();
			throw e;
		};
		const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
		let r: ExecResult<string>;
		try {
			r = await guestRun(vsock, KWBOX, ["9p", exp.name, p, ...(opts.readOnly ? ["ro"] : [])], timeout);
		} catch (e) {
			const code = e instanceof PtyError ? e.code : "";
			const msg = (e as Error)?.message ?? String(e);
			if (this.#down || code === "ECONNABORTED" || code === "ECONNRESET") fail(new MountError("ECONNABORTED", `mount ${p}: the kernel exited`, e));
			if (code === "ETIMEDOUT") fail(new MountError("ETIMEDOUT", `mount ${p}: ${/killed/.test(msg) ? msg : `no answer from the guest's kwtty within ${timeout} ms (an image without kwtty, or still booting?)`}`, e));
			if (code === "EREMOTE" && noKwbox(msg)) fail(new MountError("ENOENT", `mount ${p}: the guest has no ${KWBOX} (a base from before kwbox)`, e));
			fail(new MountError("EREMOTE", `mount ${p}: ${msg}`, e));
		}
		if (r!.exitCode !== 0) {
			// kw9p's last line is "kw9p: what: text (errno N)".
			const text = (r!.stderr || r!.stdout).trim().split("\n").pop() ?? "";
			const errno = Number(/\(errno (\d+)\)\s*$/.exec(text)?.[1] ?? 0);
			const why = `mount ${p}: ${text.replace(/^kw9p: /, "").replace(/\s*\(errno \d+\)\s*$/, "") || `kw9p exited with ${r!.exitCode ?? `signal ${r!.signal}`}`}`;
			if (errno === 19) fail(new MountError("ENODEV", `${why} (the guest's kernel has no 9p file system, CONFIG_9P_FS)`));
			if (errno === 16) fail(new MountError("EBUSY", why));
			if (errno === 20) fail(new MountError("ENOTDIR", why));
			fail(new MountError("EREMOTE", why));
		}
		if (this.#down) fail(new MountError("ECONNABORTED", `mount ${p}: the kernel exited`));
		if (h.state === "mounting") h.state = "mounted";
		return h;
	}

	/** @internal A handle is gone: free its path. */
	release(h: MountHandle): void {
		if (this.#mounts.get(h.path) === h) this.#mounts.delete(h.path);
	}

	async unmount(h: MountHandle, opts: { timeout?: number }): Promise<void> {
		const vsock = this.#vsock;
		if (h.state === "gone" || h.state === "mounting" || !vsock || this.#down) return h.gone();
		if (h.state === "unmounting") throw new MountError("EBUSY", `${h.path}: an unmount is already running`);
		h.state = "unmounting";
		let r: ExecResult<string>;
		try {
			r = await guestRun(vsock, "umount", [h.path], opts.timeout ?? DEFAULT_TIMEOUT_MS);
		} catch (e) {
			if (this.#down || (e as PtyError).code === "ECONNABORTED") return h.gone();
			h.state = "mounted";
			throw new MountError((e as PtyError).code === "ETIMEDOUT" ? "ETIMEDOUT" : "EREMOTE", `unmount ${h.path}: ${(e as Error)?.message ?? e}`, e);
		}
		const text = (r.stderr || r.stdout).trim();
		if (r.exitCode !== 0 && !/not mounted|Invalid argument|No such file/i.test(text)) {
			h.state = "mounted";
			throw new MountError(/busy/i.test(text) ? "EBUSY" : "EREMOTE", `unmount ${h.path}: ${text || `umount exited with ${r.exitCode}`}`);
		}
		// The guest closes the connection as it drops the mount; give it a moment before resetting.
		const end = performance.now() + 2000;
		while (h.exp.connected && performance.now() < end && !this.#down) await new Promise((res) => setTimeout(res, 10));
		h.gone();
	}

	/** The kernel exited: every mount is gone. */
	shutdown(): void {
		if (this.#down) return;
		this.#down = true;
		for (const h of [...this.#mounts.values()]) h.state = "gone";
		this.#mounts.clear();
		this.#server?.close();
	}
}
