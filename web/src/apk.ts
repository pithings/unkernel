// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// apk index prefetch: once user space runs, the page gets the APKINDEX files
// of the guest's repositories that are missing or stale in /var/cache/apk,
// and pushes them in through vm.exec(). The guest's apk then skips its own
// index download, and kw-apk-install its `apk update` (about 4 s under
// kwemu: TLS in the guest plus a parse whose only output is a package count).
// The repositories are the enabled ones (/etc/apk/repositories and
// /etc/apk/repositories.d/*.list) and the lazy ones (/etc/kw-apk-lazy:
// community, off until something needs it). apk ignores a lazy one's index
// until it is enabled; kw-apk-install reads it to decide whether to enable
// it, so a command from community needs no index download in the guest.
//
// - Alpine's mirrors send no CORS headers, so the page cannot fetch() them.
//   The fetch goes through a Wisp stream as plain http instead. That is
//   safe because apk checks an index's signature every time it loads one
//   from the cache, and refuses a bad one.
// - The page keeps each index in the Cache API (CACHE_NAME, keyed by the http
//   URL) with its ETag, Last-Modified and the time it was last validated
//   (VALIDATED). One validated less than CACHE_FRESH_S ago is pushed with no
//   network at all; an older one is revalidated with a conditional GET (a 304
//   costs one round trip). Entries for repositories the guest no longer lists
//   are deleted. Without the Cache API (plain http pages, some private
//   windows) every index is downloaded.
// - apk 3 names a cached index APKINDEX.<first 4 bytes of sha1(URL), hex>
//   .tar.gz, with the https index URL from /etc/apk/repositories. It uses the
//   file as is while its mtime is less than 4 h old, and fetches again after
//   that. The push sets the mtime to the validation time, so apk's limit
//   counts from when the mirror last confirmed the index, not from the push.
// - Only plain repository lines are handled (a URL, optionally after an @tag).
//   Anything else (components after the URL, local paths) is left to apk.
// - It runs once per boot and asks only for what is missing or older than
//   MAX_AGE_S in the guest. A push never replaces a guest copy at least as
//   new as its own (apk fetched it meanwhile), and is a rename, so an apk
//   that is reading the old file keeps its open copy. The guest's state is
//   read as the session's user; the push writes /var/cache/apk, so it runs
//   as root (sudo.ts). Failures are logged and otherwise ignored.

import { backendConnect } from "./download.ts";
import { fmtMiB } from "./format.ts";
import { DEFAULT_WISP_SERVERS } from "./net.ts";
import { fetchOver, wispBackend, type GuestConnect, type KernelHandle } from "./sdk.ts";
import { execAsRoot } from "./sudo.ts";

/** Get an index again when the guest's copy is older than this (apk's own limit is 4 h). */
const MAX_AGE_S = 3 * 3600;
/** A browser-cached index validated less than this long ago is used without asking the mirror. */
const CACHE_FRESH_S = 3600;
const CACHE_NAME = "kw-apk-index-v1";
/** Header on cached responses: when the mirror last confirmed them (epoch seconds). */
const VALIDATED = "x-kw-validated";
const FETCH_TIMEOUT_MS = 60_000;

// Prints "now EPOCH", "arch ARCH", the repositories files and the lazy list
// between markers, and "file NAME MTIME" for each cached index.
const STATE_SH = `echo "now $(date +%s)"
echo "arch $(cat /etc/apk/arch 2>/dev/null)"
echo "--repos"
for f in /etc/apk/repositories /etc/apk/repositories.d/*.list /etc/kw-apk-lazy; do [ -e "$f" ] && cat "$f" && echo; done
echo "--end"
for f in /var/cache/apk/APKINDEX.*.tar.gz; do [ -e "$f" ] && echo "file \${f##*/} $(stat -c %Y "$f")"; done
true`;

// Installs stdin as /var/cache/apk/$1 with mtime $2 (at most now), unless the
// guest's copy is at least that new. Run as root.
const PUSH_SH = `set -e
f=/var/cache/apk/$1 t=/var/cache/apk/.$1.kw m=$2 n=$(date +%s)
[ "$m" -le "$n" ] || m=$n
mkdir -p /var/cache/apk
if [ -e "$f" ] && [ "$(stat -c %Y "$f")" -ge "$m" ]; then cat >/dev/null; echo kept; exit 0; fi
cat > "$t"
touch -d "@$m" "$t"
mv -f "$t" "$f"
echo pushed`;

interface GuestState { now: number; arch: string; repos: string[]; mtimes: Map<string, number> }

function parseState(out: string): GuestState {
	const st: GuestState = { now: 0, arch: "", repos: [], mtimes: new Map() };
	let inRepos = false;
	for (const raw of out.split("\n")) {
		if (raw === "--repos") { inRepos = true; continue; }
		if (raw === "--end") { inRepos = false; continue; }
		if (inRepos) {
			// apk takes only whole-line comments; more words after the URL are components.
			const tokens = raw.trim().startsWith("#") ? [] : raw.trim().split(/\s+/).filter(Boolean);
			if (tokens[0]?.startsWith("@")) tokens.shift();
			const [url] = tokens;
			if (tokens.length === 1 && url && /^https?:\/\/[^/\s]+\//.test(url) && !st.repos.includes(url)) st.repos.push(url);
			continue;
		}
		const [key, a, b] = raw.trim().split(/\s+/);
		if (key === "now") st.now = Number(a);
		else if (key === "arch") st.arch = a ?? "";
		else if (key === "file" && a && b) st.mtimes.set(a, Number(b));
	}
	return st;
}

/** apk 3's cache file name for an index URL. */
async function cacheName(indexUrl: string): Promise<string> {
	const h = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(indexUrl)));
	return `APKINDEX.${[...h.subarray(0, 4)].map((x) => x.toString(16).padStart(2, "0")).join("")}.tar.gz`;
}

/** The page's index cache, or null where the Cache API is missing or refused. */
async function openCache(): Promise<Cache | null> {
	try { return typeof caches === "undefined" ? null : await caches.open(CACHE_NAME); } catch { return null; }
}

type Source = "cache" | "revalidated" | "downloaded";

/**
 * One index: from the browser cache while fresh, else from the mirror over
 * `connect` (conditional when cached), stored back in the cache.
 */
async function getIndex(cache: Cache | null, http: URL, connect: () => GuestConnect, signal: AbortSignal):
	Promise<{ bytes: Uint8Array; validated: number; source: Source }> {
	const key = http.href;
	const hit = await cache?.match(key).catch(() => undefined);
	const now = Math.floor(Date.now() / 1000);
	const hitValidated = Number(hit?.headers.get(VALIDATED)) || 0;
	if (hit && now - hitValidated < CACHE_FRESH_S) return { bytes: new Uint8Array(await hit.arrayBuffer()), validated: hitValidated, source: "cache" };

	const headers = new Headers();
	const etag = hit?.headers.get("etag"), lastModified = hit?.headers.get("last-modified");
	if (etag) headers.set("if-none-match", etag);
	if (lastModified) headers.set("if-modified-since", lastModified);
	const res = await fetchOver(connect(), http, { signal, headers });
	let bytes: Uint8Array, source: Source;
	if (res.status === 304 && hit) {
		await res.body?.cancel();
		bytes = new Uint8Array(await hit.arrayBuffer());
		source = "revalidated";
	} else if (res.ok) {
		bytes = new Uint8Array(await res.arrayBuffer());
		source = "downloaded";
	} else {
		await res.body?.cancel();
		throw new Error(`HTTP ${res.status}`);
	}
	const stored = new Headers({ "content-type": "application/gzip", [VALIDATED]: String(now) });
	const newEtag = res.headers.get("etag") ?? etag, newLastModified = res.headers.get("last-modified") ?? lastModified;
	if (newEtag) stored.set("etag", newEtag);
	if (newLastModified) stored.set("last-modified", newLastModified);
	await cache?.put(key, new Response(bytes.slice(), { headers: stored })).catch(() => {}); // a full quota only loses the cache
	return { bytes, validated: now, source };
}

/**
 * Push fresh apk indexes into the guest (see the top of this file). Resolves
 * when done; never rejects (failures go to `log`).
 */
export async function prefetchApkIndexes(vm: KernelHandle, opts: { servers: string[] | null; log: (m: string) => void }): Promise<void> {
	const { log } = opts;
	let backend: ReturnType<typeof wispBackend> | undefined;
	try {
		const t0 = performance.now();
		const state = await vm.exec("/bin/sh", ["-c", STATE_SH]);
		if (state.exitCode !== 0) throw new Error(`reading the guest's apk state: ${state.stderr.trim() || `exit ${state.exitCode}`}`);
		const st = parseState(state.stdout);
		if (!st.arch || !st.now) return;
		const repos = await Promise.all(st.repos.map(async (repo) => {
			const url = `${repo.replace(/\/+$/, "")}/${st.arch}/APKINDEX.tar.gz`;
			const http = new URL(url);
			http.protocol = "http:";
			const name = await cacheName(url);
			const mtime = st.mtimes.get(name);
			return { http, name, stale: mtime === undefined || st.now - mtime >= MAX_AGE_S };
		}));
		const cache = await openCache();
		if (cache) { // forget repositories the guest no longer lists
			const listed = new Set(repos.map((r) => r.http.href));
			for (const req of await cache.keys().catch(() => [])) if (!listed.has(req.url)) await cache.delete(req).catch(() => {});
		}
		const wanted = repos.filter((r) => r.stale);
		if (!wanted.length) return;

		// Opened only if something is not in the browser cache. Its own connection, also in worker
		// mode, where the guest's is in the worker. No log: its "guest network offline" would be wrong here.
		const connect = (host: string) => () => backendConnect(backend ??= wispBackend(opts.servers ?? [...DEFAULT_WISP_SERVERS]), host);
		const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
		const got = await Promise.all(wanted.map(async ({ http, name }) => {
			try {
				return { name, ...(await getIndex(cache, http, connect(http.hostname), signal)) };
			} catch (e) {
				log(`[apk] index prefetch: ${http}: ${(e as Error).message}`);
				return null;
			}
		}));
		backend?.close();
		backend = undefined;
		const getMs = performance.now() - t0;

		let bytes = 0;
		const pushed: Source[] = [];
		for (const ix of got) {
			if (!ix) continue;
			const r = await execAsRoot(vm, PUSH_SH, [ix.name, String(ix.validated)], { input: ix.bytes });
			if (r.exitCode !== 0) throw new Error(`pushing ${ix.name}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
			if (r.stdout.trim() === "pushed") { pushed.push(ix.source); bytes += ix.bytes.length; }
		}
		if (!pushed.length) return;
		const by = (["cache", "revalidated", "downloaded"] as const).map((s) => [s, pushed.filter((p) => p === s).length] as const)
			.filter(([, n]) => n).map(([s, n]) => `${n} ${s === "cache" ? "from the browser cache" : s}`).join(", ");
		log(`[apk] pushed ${pushed.length} index${pushed.length > 1 ? "es" : ""} (${fmtMiB(bytes)}; ${by}) in ${((performance.now() - t0) / 1000).toFixed(1)} s` +
			` (${(getMs / 1000).toFixed(1)} s to get them)`);
	} catch (e) {
		log(`[apk] index prefetch skipped: ${(e as Error).message}`);
	} finally {
		backend?.close();
	}
}
