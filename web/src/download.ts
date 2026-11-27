// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Host-side downloads for the guest: the page gets a file and pushes it into
// the guest through vm.exec(), so the guest does no TLS (slow under kwemu)
// and the file survives in the browser across boots and data disk resets.
//
// - The sites a demo takes files from (cdimage.ubuntu.com, archive.org,
//   ibiblio.org, Alpine's mirrors) send no CORS headers, and the page is
//   cross-origin isolated, so fetch() cannot read them, not even as no-cors.
//   The page speaks plain http over its own Wisp connection instead
//   (fetchOver() over a Wisp stream), as apk.ts does for apk's indexes.
//   https URLs, and redirects to them, are fetched as http: the pinned
//   SHA-256 is what makes that safe, so every file has one. Up to
//   MAX_REDIRECTS redirects are followed. A file whose site sends
//   Access-Control-Allow-Origin (`cors`, e.g. releases.fx.sh, https only)
//   is fetched directly with fetch() instead, and a bundle's file with a
//   `mirror` from there first.
// - Files are kept in the Cache API (CACHE_NAME), keyed by their http URL,
//   and checked against the SHA-256 on every use; a cached copy that does
//   not match is deleted. Entries are not expired: a file is pinned by its
//   hash, so a copy that matches is always good.
// - crypto.subtle and the Cache API need a secure context. Without one the
//   file is fetched every time and pushed unchecked: whatever reads it in
//   the guest must check it too (the demos' scripts do, since they also
//   download it themselves when the page could not).
// - pushFile() writes the bytes to a .part file next to the target, checks
//   its size and renames it, so a reader never sees a partial file. The
//   whole file is in page memory once, as vm.exec()'s input.
// - getFiles() fetches many small files (an app's `bundle`), a few at once
//   over one Wisp connection, each as getFile() does (its first try from
//   its mirror, if it names one, until the mirror failed too often);
//   pushFiles() writes a batch of them into a directory with one exec, as a
//   tar.

import { DEFAULT_WISP_SERVERS } from "./net.ts";
import { fetchOver, wispBackend, type ByteDuplex, type GuestConnect, type KernelHandle, type NetBackend } from "./sdk.ts";

const CACHE_NAME = "kw-files-v1";
const MAX_REDIRECTS = 5;
const MIRROR_WAIT_MS = 20_000;

/** fetchOver()'s connect over a NetBackend: the given port on a fixed remote host. */
export function backendConnect(backend: NetBackend, host: string): GuestConnect {
	return (port, { signal } = {}) => new Promise<ByteDuplex>((resolve, reject) => {
		let rc!: ReadableStreamDefaultController<Uint8Array>;
		let connected = false, drained: (() => void) | null = null;
		const readable = new ReadableStream<Uint8Array>({ start(c) { rc = c; }, cancel() { conn.destroy(); } });
		const writable = new WritableStream<Uint8Array>({
			async write(chunk) {
				conn.write(chunk);
				if (conn.buffered > 256 * 1024) await new Promise<void>((r) => (drained = r));
			},
			close() { conn.end(); },
			abort() { conn.destroy(); },
		});
		const conn = backend.connect({ host, port }, {
			onConnect() { connected = true; resolve({ readable, writable }); },
			onData(d) { rc.enqueue(d.slice()); },
			onEnd() { try { rc.close(); } catch {} },
			onDrain() { drained?.(); drained = null; },
			onClose(err) {
				drained?.(); drained = null;
				if (!connected) reject(err ?? new Error(`${host}:${port}: closed before connecting`));
				else if (err) { try { rc.error(err); } catch {} }
				else { try { rc.close(); } catch {} }
			},
		});
		signal?.addEventListener("abort", () => { conn.destroy(); reject(signal.reason); }, { once: true });
	});
}

/** The URL as plain http (same host, path and query). */
export function asHttp(url: string | URL, base?: URL): URL {
	const u = new URL(url, base);
	if (u.protocol === "https:") {
		u.protocol = "http:";
		if (u.port === "443") u.port = "";
	} else if (u.protocol !== "http:") {
		throw new Error(`not an http(s) URL: ${u.href}`);
	}
	return u;
}

/** A GET over `backend` as plain http, following redirects (each fetched as http too). */
export async function httpGet(backend: NetBackend, url: string | URL, init: { signal?: AbortSignal; headers?: HeadersInit } = {}): Promise<Response> {
	let u = asHttp(url);
	for (let hops = 0; ; hops++) {
		const res = await fetchOver(backendConnect(backend, u.hostname), u, init);
		const location = res.headers.get("location");
		if (res.status < 300 || res.status >= 400 || !location) return res;
		await res.body?.cancel();
		if (hops >= MAX_REDIRECTS) throw new Error(`too many redirects (last: ${u.href})`);
		const next = asHttp(location, u);
		// A redirect to the https form of the same URL: the site serves https only.
		if (next.href === u.href) throw new Error(`${u.host} serves this over https only`);
		u = next;
	}
}

export interface FileSpec {
	/** http or https URL; fetched as plain http (see the top of this file). */
	url: string;
	/** SHA-256 of the file, lowercase hex. */
	sha256: string;
	/** Size in bytes, for the progress when the server sends no length. */
	size?: number;
	/**
	 * The site sends Access-Control-Allow-Origin: fetch() it directly (https
	 * as given) instead of plain http over Wisp. For https-only sites.
	 */
	cors?: boolean;
	/**
	 * Another URL of the file, whose site sends Access-Control-Allow-Origin:
	 * getFiles() tries it first, with fetch(). The cache goes by `url`.
	 */
	mirror?: string;
}

export type FileSource = "cache" | "downloaded";

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** SHA-256 as hex, or null where crypto.subtle is missing (no secure context). */
async function sha256(bytes: Uint8Array): Promise<string | null> {
	if (typeof crypto === "undefined" || !crypto.subtle) return null;
	return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** fetch() from a mirror, whose answer must begin within MIRROR_WAIT_MS (not kept in the browser's HTTP cache: CACHE_NAME has the file). */
async function mirrorFetch(url: string, signal?: AbortSignal): Promise<Response> {
	const late = new AbortController();
	const timer = setTimeout(() => late.abort(new Error("no answer from the mirror")), MIRROR_WAIT_MS);
	try {
		return await fetch(url, { cache: "no-store", signal: signal ? AbortSignal.any([signal, late.signal]) : late.signal });
	} finally {
		clearTimeout(timer);
	}
}

async function openCache(): Promise<Cache | null> {
	try { return typeof caches === "undefined" ? null : await caches.open(CACHE_NAME); } catch { return null; }
}

/**
 * The file's bytes, from the browser cache when a copy there matches its
 * SHA-256, else downloaded (over Wisp, or with fetch()), checked and
 * cached. Rejects on a network error, an HTTP error or a hash mismatch.
 */
export async function getFile(f: FileSpec, opts: {
	servers?: readonly string[] | null;
	/** Fetch over this backend, which stays open, instead of one of its own. */
	backend?: NetBackend;
	/** Fetch from f.mirror (required then), and nothing else. */
	mirror?: boolean;
	signal?: AbortSignal;
	onProgress?: (got: number, total: number | null) => void;
} = {}): Promise<{ bytes: Uint8Array; source: FileSource; checked: boolean }> {
	const want = f.sha256.toLowerCase();
	const key = asHttp(f.url).href;
	const cache = await openCache();
	const hit = await cache?.match(key).catch(() => undefined);
	if (hit) {
		const bytes = new Uint8Array(await hit.arrayBuffer());
		if ((await sha256(bytes)) === want) return { bytes, source: "cache", checked: true };
		await cache!.delete(key).catch(() => {});
	}

	const direct = opts.mirror ? f.mirror! : f.cors ? f.url : null;
	const own = direct || opts.backend ? null : wispBackend(opts.servers?.length ? opts.servers : [...DEFAULT_WISP_SERVERS]);
	const backend = direct ? null : opts.backend ?? own;
	try {
		const res = backend ? await httpGet(backend, f.url, { signal: opts.signal })
			: opts.mirror ? await mirrorFetch(direct!, opts.signal)
			: await fetch(direct!, { signal: opts.signal });
		if (!res.ok || !res.body) {
			await res.body?.cancel();
			throw new Error(`HTTP ${res.status}`);
		}
		const total = Number(res.headers.get("content-length")) || f.size || null;
		const chunks: Uint8Array[] = [];
		let got = 0, shown = 0;
		const reader = res.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			got += value.length;
			const now = performance.now();
			if (now - shown > 250) { shown = now; opts.onProgress?.(got, total); }
		}
		opts.onProgress?.(got, total);
		const bytes = new Uint8Array(got);
		let at = 0;
		for (const c of chunks) { bytes.set(c, at); at += c.length; }
		const sum = await sha256(bytes);
		if (sum !== null && sum !== want) throw new Error(`SHA-256 mismatch (got ${sum.slice(0, 16)}…, ${got} bytes)`);
		if (sum !== null) {
			// A full quota only loses the cache.
			await cache?.put(key, new Response(bytes.slice(), { headers: { "content-type": "application/octet-stream" } })).catch(() => {});
		}
		return { bytes, source: "downloaded", checked: sum !== null };
	} finally {
		own?.close();
	}
}

// Writes stdin to $1 (relative to ~, or absolute) through $1.part, if it
// holds exactly $2 bytes.
const PUSH_SH = `set -e
cd ~
case "$1" in */*) mkdir -p "\${1%/*}";; esac
cat > "$1.part"
size=$(stat -c %s "$1.part")
if [ "$size" != "$2" ]; then rm -f "$1.part"; echo "got $size of $2 bytes" >&2; exit 1; fi
mv "$1.part" "$1"`;

/** Write `bytes` to `path` in the guest (relative to ~, or absolute), atomically; `signal` stops it (a .part file may stay). */
export async function pushFile(vm: KernelHandle, path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
	const r = await vm.exec("/bin/sh", ["-c", PUSH_SH, "sh", path.replace(/^~\//, ""), String(bytes.length)], { input: bytes, signal });
	if (r.exitCode !== 0) throw new Error(`writing ${path} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.exitCode}`}`);
}

/** At most this many of a bundle's files are fetched at once. */
const PARALLEL = 6;
/** Tries per file of a bundle, besides its mirror's. */
const TRIES = 3;
/** After this many files the mirror did not give, the rest do not ask it. */
const MIRROR_FAILS = 6;

/**
 * Fetch files, a few at once, each handed to onFile as it arrives (in any
 * order; awaited, so what it does holds that fetch's place). Rejects with
 * the first file that failed all its tries, or that onFile refused, once
 * the other fetches stopped.
 */
export async function getFiles(files: readonly FileSpec[], opts: {
	servers?: readonly string[] | null;
	backend?: NetBackend;
	signal?: AbortSignal;
	onFile: (f: FileSpec, bytes: Uint8Array, source: FileSource) => Promise<void> | void;
	/** Bytes fetched so far, of all the files. */
	onProgress?: (got: number) => void;
}): Promise<void> {
	const own = opts.backend ? null : wispBackend(opts.servers?.length ? opts.servers : [...DEFAULT_WISP_SERVERS]);
	const backend = opts.backend ?? own!;
	const stop = new AbortController();
	const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
	const got = new Array<number>(files.length).fill(0);
	let sum = 0, next = 0, mirrorFails = 0;
	const progress = (i: number, n: number) => { sum += n - got[i]!; got[i] = n; opts.onProgress?.(sum); };
	const worker = async () => {
		while (next < files.length) {
			const i = next++, f = files[i]!;
			let mirror = !!f.mirror && mirrorFails < MIRROR_FAILS;
			for (let t = mirror ? 0 : 1; ; t++) {
				signal.throwIfAborted();
				let file;
				try {
					file = await getFile(f, { backend, mirror, signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]), onProgress: (n) => progress(i, n) });
				} catch (e) {
					progress(i, 0);
					if (signal.aborted || t >= TRIES) throw signal.aborted ? signal.reason : new Error(`${f.url}: ${(e as Error)?.message ?? e}`);
					if (mirror) mirrorFails++;
					mirror = false;
					continue;
				}
				progress(i, file.bytes.length);
				await opts.onFile(f, file.bytes, file.source);
				break;
			}
		}
	};
	try {
		const workers = Array.from({ length: Math.min(PARALLEL, files.length) }, worker);
		await Promise.all(workers).catch(async (e) => {
			stop.abort(e);
			await Promise.allSettled(workers);
			throw e;
		});
	} finally {
		own?.close();
	}
}

/** A ustar archive of files (names of at most 100 bytes, ASCII). */
export function tarOf(files: readonly { name: string; bytes: Uint8Array }[]): Uint8Array {
	const pad = (n: number) => (n + 511) & ~511;
	const out = new Uint8Array(files.reduce((n, f) => n + 512 + pad(f.bytes.length), 1024));
	const enc = new TextEncoder();
	let at = 0;
	for (const { name, bytes } of files) {
		const head = out.subarray(at, at + 512);
		const put = (off: number, s: string) => head.set(enc.encode(s), off);
		const oct = (n: number, len: number) => `${n.toString(8).padStart(len - 1, "0")}\0`;
		if (name.length > 100) throw new Error(`${name}: the name is too long`);
		put(0, name);
		put(100, oct(0o644, 8));
		put(108, oct(0, 8));
		put(116, oct(0, 8));
		put(124, oct(bytes.length, 12));
		put(136, oct(0, 12));
		put(148, "        ");
		put(156, "0");
		put(257, "ustar\x0000");
		put(148, `${head.reduce((n, b) => n + b, 0).toString(8).padStart(6, "0")}\0 `);
		out.set(bytes, at + 512);
		at += 512 + pad(bytes.length);
	}
	return out;
}

/** Write files into the directory `dir` of the guest (relative to ~, or absolute) in one exec. A file may be cut short when it fails: the reader checks. */
export async function pushFiles(vm: KernelHandle, dir: string, files: readonly { name: string; bytes: Uint8Array }[], signal?: AbortSignal): Promise<void> {
	const r = await vm.exec("/bin/sh", ["-c", 'cd ~ && mkdir -p "$1" && cd "$1" && tar -xof -', "sh", dir.replace(/^~\//, "")], { input: tarOf(files), signal });
	if (r.exitCode !== 0) throw new Error(`writing to ${dir} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.exitCode}`}`);
}
