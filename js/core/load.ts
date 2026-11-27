// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Loading a kernel module and an initramfs: download with progress, then
// compile (streaming when the engine can). Universal; the Node entry adds
// file paths and file: URLs (readFile hook). A kernel that is gzipped (a
// .wasm.gz a server sends as it is, such as a release mirror's) is
// gunzipped on the way (DecompressionStream), told by gzip's magic, not by
// the name or the headers.

import { smpKernelFromBundle } from "./kpatch.ts";

/** A kernel: a compiled module, its bytes, a Response, or a URL to fetch (a file path or file: URL on Node). */
export type KernelSource = WebAssembly.Module | BytesSource;

/** Bytes, a Response, or a URL to fetch (a file path or file: URL on Node). */
export type BytesSource = Uint8Array | ArrayBuffer | ArrayBufferView | Response | URL | string;

/** Download progress of the kernel or the initramfs. */
export interface DownloadProgress {
	stage: "download";
	what: "kernel" | "initrd";
	url: string;
	/** Bytes so far. */
	loaded: number;
	/** Expected bytes, 0 if unknown. */
	total: number;
	done: boolean;
}

export interface LoadOptions {
	what?: "kernel" | "initrd";
	onProgress?: (p: DownloadProgress) => void;
	signal?: AbortSignal;
	/**
	 * Read a URL or path without fetch, or return undefined to fetch it (the
	 * Node entry reads file: URLs and plain paths from disk).
	 */
	readFile?: (src: URL | string) => Promise<Uint8Array> | undefined;
	/**
	 * Want the SMP kernel: if the kernel is a bundle with an SMP patch
	 * (kernel/tools/bundle.mjs --smp), load its bytes (no streaming
	 * compile), patch them (kpatch.ts) and compile the result. A bundle
	 * without one, or a compiled Module, is used as it is.
	 */
	smp?: boolean;
}

/** Why loading or booting failed: the step that failed. */
export type BootFailStage = "support" | "download" | "compile" | "memory" | "boot";

/** An error from createKernel() or the loaders, tagged with the step that failed. */
export class BootError extends Error {
	stage: BootFailStage;
	constructor(stage: BootFailStage, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "BootError";
		this.stage = stage;
	}
}

const WASM_HEADERS = { "content-type": "application/wasm" };

function isBufferSource(src: unknown): src is Uint8Array | ArrayBuffer | ArrayBufferView {
	return src instanceof ArrayBuffer || ArrayBuffer.isView(src);
}

/**
 * A URL or a path. Tested before `instanceof Response`: on Node the first
 * use of the Response global loads its fetch implementation (about 25 ms),
 * which reading a file does not need.
 */
function isLocation(src: unknown): src is URL | string {
	return typeof src === "string" || src instanceof URL;
}

function toU8(src: ArrayBuffer | ArrayBufferView): Uint8Array {
	return src instanceof Uint8Array ? src
		: src instanceof ArrayBuffer ? new Uint8Array(src)
		: new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
}

const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/** `bytes` gunzipped if they are gzip (by the magic), else `bytes`. */
export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
	if (!isGzip(bytes)) return bytes;
	const out = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(out).arrayBuffer());
}

/**
 * `r` with its body gunzipped if it starts with gzip's magic (streamed),
 * else as it is; with `headers`. It reads the first chunk to tell.
 */
async function gunzipBody(r: Response, headers: HeadersInit): Promise<Response> {
	if (!r.body) return new Response(r.body, { status: r.status, headers });
	const reader = r.body.getReader();
	let head = new Uint8Array(0);
	while (head.length < 2) {
		const c = await reader.read();
		if (c.done) break;
		const n = new Uint8Array(head.length + c.value.length);
		n.set(head);
		n.set(c.value, head.length);
		head = n;
	}
	const body = new ReadableStream<Uint8Array>({
		start(c) { if (head.length) c.enqueue(head); },
		async pull(c) {
			const chunk = await reader.read();
			if (chunk.done) c.close();
			else c.enqueue(chunk.value);
		},
		cancel(reason) { return reader.cancel(reason); },
	});
	const out = isGzip(head) ? body.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>) : body;
	return new Response(out, { status: r.status, headers });
}

/** Expected size of a response body: x-decoded-length (if a server sends it), else content-length if not compressed. */
function expectedLength(r: Response): number {
	return Number(r.headers.get("x-decoded-length") ||
		(r.headers.get("content-encoding") ? 0 : r.headers.get("content-length"))) || 0;
}

async function fetchOk(url: URL | string, signal?: AbortSignal): Promise<Response> {
	let r: Response;
	try {
		r = await fetch(url, { cache: "no-cache", signal });
	} catch (e) {
		throw new BootError("download", `Network error fetching ${url}: ${(e as Error).message}`, { cause: e });
	}
	if (!r.ok) throw new BootError("download", `GET ${url} → ${r.status} ${r.statusText || ""}`.trim());
	return r;
}

/**
 * A copy of `r` whose body reports progress as it is read, and a function
 * that returns the error if reading the original body failed (a network
 * error, as opposed to a consumer's error).
 */
function withProgress(r: Response, url: string, opts: LoadOptions, headers?: HeadersInit): [Response, () => unknown] {
	const total = expectedLength(r);
	const what = opts.what ?? "kernel";
	const report = (loaded: number, done: boolean) => opts.onProgress?.({ stage: "download", what, url, loaded, total, done });
	if (!r.body) return [r, () => undefined];
	const reader = r.body.getReader();
	let loaded = 0, failed: unknown;
	report(0, false);
	const body = new ReadableStream<Uint8Array>({
		async pull(c) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await reader.read();
			} catch (e) {
				failed = e ?? new Error("read failed");
				c.error(e);
				return;
			}
			if (chunk.done) {
				report(loaded, true);
				c.close();
				return;
			}
			loaded += chunk.value.length;
			report(loaded, false);
			c.enqueue(chunk.value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return [new Response(body, { status: r.status, headers: headers ?? r.headers }), () => failed];
}

/**
 * Download into memory, reporting progress (`onProgress`). With
 * content-encoding, content-length counts compressed bytes but the reader
 * yields decoded ones: x-decoded-length (if the server sends it) is used, else the total
 * is unknown (0).
 */
export async function download(url: URL | string, opts: LoadOptions = {}): Promise<Uint8Array> {
	const r = await fetchOk(url, opts.signal);
	return readResponse(r, String(url), opts);
}

async function readResponse(r: Response, url: string, opts: LoadOptions): Promise<Uint8Array> {
	try {
		return new Uint8Array(await withProgress(r, url, opts)[0].arrayBuffer());
	} catch (e) {
		if (e instanceof BootError) throw e;
		throw new BootError("download", `Reading ${url} failed: ${(e as Error).message}`, { cause: e });
	}
}

/** Bytes of an initramfs (or any file) from any BytesSource. */
export async function loadBytes(src: BytesSource, opts: LoadOptions = {}): Promise<Uint8Array> {
	if (isBufferSource(src)) return toU8(src);
	if (!isLocation(src)) return readResponse(src, src.url, opts);
	const local = opts.readFile?.(src);
	if (local) return local;
	return download(src, opts);
}

/**
 * Compile a kernel from any KernelSource. URLs and Responses are compiled
 * while they download (WebAssembly.compileStreaming) when the engine has it.
 */
export async function loadKernelModule(src: KernelSource, opts: LoadOptions = {}): Promise<WebAssembly.Module> {
	if (src instanceof WebAssembly.Module) return src;
	const compile = async (bytes: Uint8Array) => {
		try {
			bytes = await gunzipBytes(bytes);
		} catch (e) {
			throw new BootError("download", `The kernel is gzip that does not decompress: ${(e as Error).message}`, { cause: e });
		}
		if (opts.smp) {
			try {
				bytes = (await smpKernelFromBundle(bytes)) ?? bytes;
			} catch (e) {
				throw new BootError("compile", `Deriving the SMP kernel from the bundle failed: ${(e as Error).message}`, { cause: e });
			}
		}
		try {
			return await WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
		} catch (e) {
			throw new BootError("compile", `Compiling the kernel failed: ${(e as Error).message}`, { cause: e });
		}
	};
	if (isBufferSource(src)) return compile(toU8(src));
	let r: Response;
	if (isLocation(src)) {
		const local = opts.readFile?.(src);
		if (local) return compile(await local);
		r = await fetchOk(src, opts.signal);
	} else {
		r = src;
	}
	const url = r.url || (isLocation(src) ? String(src) : "");
	if (opts.smp || typeof WebAssembly.compileStreaming !== "function" || !r.body) return compile(await readResponse(r, url, { ...opts, what: "kernel" }));
	// Progress counts the bytes as they arrive (a .wasm.gz's, against its Content-Length).
	const [counted, readError] = withProgress(r, url, { ...opts, what: "kernel" });
	try {
		return await WebAssembly.compileStreaming(await gunzipBody(counted, WASM_HEADERS));
	} catch (e) {
		if (e instanceof BootError) throw e;
		const re = readError();
		if (re !== undefined || opts.signal?.aborted)
			throw new BootError("download", `Fetching ${url} failed: ${(re as Error)?.message ?? (e as Error).message}`, { cause: re ?? e });
		throw new BootError("compile", `Compiling the kernel failed: ${(e as Error).message}`, { cause: e });
	}
}
