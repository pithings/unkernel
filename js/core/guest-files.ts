// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Single-file guest transfers over the existing kwtty channel:
// readGuestFile() uses buffered binary vm.exec(), and writeGuestFile() uses
// vm.spawn(..., { pty: false }) so cancellation can send SIGTERM before EOF
// and let the guest shell remove its temporary file. Works identically inline
// and in worker mode on both Node and browsers.

import type { KernelHandle } from "./instance.ts";
import { PtyError, type ExecOptions, type PipeOptions, type PtyEnd } from "./tty.ts";

/** Common options for reading or writing a guest file. */
export interface GuestFileOptions {
	/**
	 * The guest user to run as: a name, or a uid. Default: the guest's default
	 * user (`user`, uid 1000 on the distro images; root on the base shell).
	 */
	user?: string | number;
	/** Aborts the transfer with a PtyError (`ABORTED`). */
	signal?: AbortSignal;
}

/** Options for readGuestFile(). */
export interface ReadGuestFileOptions extends GuestFileOptions {
	/**
	 * The most bytes to read from the file; beyond it the transfer rejects with
	 * PtyError `ENOBUFS`. Default 64 MiB (vm.exec()'s default).
	 */
	maxBuffer?: number;
}

/** Options for writeGuestFile(). */
export interface WriteGuestFileOptions extends GuestFileOptions {}

/** Chunk size fed to pipe stdin per write (a small multiple of kwtty's 4 KiB frame limit). */
const WRITE_CHUNK_BYTES = 32 * 1024;
/** Cap on stderr bytes collected from the write helper while draining the rest to EOF. */
const MAX_DIAG_BYTES = 16 * 1024;
/** How long writeGuestFile() waits after SIGTERM for the guest shell to clean up and exit before closing the session. */
const CANCEL_GRACE_MS = 5000;

// Check that $1 resolves to a regular file (following symlinks, without opening
// FIFOs or directories), then stream it via `exec cat < "$1"`. If not a regular
// file, distinguish existing non-regular entries from stat failures (ENOENT,
// EACCES, ELOOP, ENOTDIR) so guest stderr carries the real reason.
const READ_SH = [
	'if [ -f "$1" ]; then',
	'\texec cat < "$1"',
	"fi",
	'if [ -e "$1" ]; then',
	"\tprintf 'not a regular file\\n' >&2",
	"\texit 1",
	"fi",
	'stat -L -- "$1" >/dev/null || exit 1',
	"printf 'not a regular file\\n' >&2",
	"exit 1",
].join("\n");

// Write stdin ($2 expected bytes) to a unique sibling temporary file in the
// destination's parent directory, verify the written byte count, and publish
// atomically with `mv -fT`. `cat` runs as a child reading a duplicate of stdin
// while the shell waits on it so SIGTERM interrupts `wait` and triggers the
// cleanup trap before any rename.
const WRITE_SH = [
	"set -e",
	"dst=$1",
	"want=$2",
	'if [ -L "$dst" ] || { [ -e "$dst" ] && [ ! -f "$dst" ]; }; then',
	"\tprintf 'destination is not a regular file\\n' >&2",
	"\texit 1",
	"fi",
	"tmp=",
	"pid=",
	"cleanup() {",
	'\t[ -z "$pid" ] || { kill "$pid" 2>/dev/null || :; wait "$pid" 2>/dev/null || :; }',
	'\t[ -z "$tmp" ] || rm -f -- "$tmp"',
	"}",
	"trap cleanup EXIT",
	"trap 'exit 1' HUP INT TERM",
	'tmp=$(mktemp -- "${dst%/*}/.unkernel-write.XXXXXX")',
	"exec 3<&0",
	'cat > "$tmp" <&3 3<&- &',
	"pid=$!",
	'wait "$pid"',
	"pid=",
	"exec 3<&-",
	'size=$(stat -c %s -- "$tmp")',
	'if [ "$size" != "$want" ]; then',
	'\tprintf \'wrote %s of %s bytes\\n\' "$size" "$want" >&2',
	"\texit 1",
	"fi",
	'if [ -L "$dst" ] || { [ -e "$dst" ] && [ ! -f "$dst" ]; }; then',
	"\tprintf 'destination is not a regular file\\n' >&2",
	"\texit 1",
	"fi",
	'mv -fT -- "$tmp" "$dst"',
	"tmp=",
].join("\n");

function validateGuestFilePath(op: string, path: string): void {
	if (typeof path !== "string" || path.length === 0) {
		throw new RangeError(`${op}: path must be a non-empty string`);
	}
	if (!path.startsWith("/")) {
		throw new RangeError(`${op}: path ${JSON.stringify(path)} must be absolute`);
	}
	if (path.includes("\0")) {
		throw new RangeError(`${op}: path ${JSON.stringify(path)} must not contain NUL`);
	}
	if (path.endsWith("/")) {
		throw new RangeError(`${op}: path ${JSON.stringify(path)} must name a file, not a directory`);
	}
	const base = path.slice(path.lastIndexOf("/") + 1);
	if (base === "." || base === "..") {
		throw new RangeError(`${op}: path ${JSON.stringify(path)} must name a file, not ${JSON.stringify(base)}`);
	}
}

function guestProcessError(op: string, path: string, exitCode: number | null, signal: number | null, stderr: Uint8Array): Error {
	const text = new TextDecoder().decode(stderr).trim();
	if (text) return new Error(`${op} ${path}: ${text}`);
	if (signal !== null) return new Error(`${op} ${path}: guest process killed by signal ${signal}`);
	return new Error(`${op} ${path}: guest process exited with status ${exitCode}`);
}

/** Drain a stream to EOF, keeping at most `maxBytes` bytes. */
async function collectBounded(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let kept = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (kept < maxBytes && value.byteLength > 0) {
				const take = Math.min(value.byteLength, maxBytes - kept);
				chunks.push(take === value.byteLength ? value : value.subarray(0, take));
				kept += take;
			}
		}
	} finally {
		reader.releaseLock();
	}
	if (kept === 0) return new Uint8Array(0);
	const out = new Uint8Array(kept);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

/**
 * Read a regular file at the guest-absolute `path` and resolve with its bytes
 * (`Uint8Array`). Follows symlinks to readable regular files and rejects
 * missing, unreadable or non-regular paths (such as directories or FIFOs).
 *
 * Buffered in memory (capped by `opts.maxBuffer`, defaulting to 64 MiB). For
 * large or streamed transfers, use `vm.spawn(..., { pty: false })` on pipes.
 * Preserves kwtty transport errors (`PtyError`, such as `ENODEV`, `ENOBUFS`,
 * `ABORTED`, `EREMOTE`, `ETIMEDOUT`, `ECONNRESET`, `ECONNABORTED`).
 */
export async function readGuestFile(vm: KernelHandle, path: string, opts: ReadGuestFileOptions = {}): Promise<Uint8Array> {
	validateGuestFilePath("readGuestFile", path);
	if (opts.maxBuffer !== undefined && (typeof opts.maxBuffer !== "number" || Number.isNaN(opts.maxBuffer) || opts.maxBuffer < 0)) {
		throw new RangeError(`readGuestFile: maxBuffer must be a non-negative number`);
	}
	if (opts.signal?.aborted) {
		throw new PtyError("ABORTED", `readGuestFile ${path}: aborted`);
	}
	const execOpts: ExecOptions & { encoding: "buffer" } = { encoding: "buffer" };
	if (opts.user !== undefined) execOpts.user = opts.user;
	if (opts.signal !== undefined) execOpts.signal = opts.signal;
	if (opts.maxBuffer !== undefined) execOpts.maxBuffer = opts.maxBuffer;
	const r = await vm.exec("/bin/sh", ["-c", READ_SH, "sh", path], execOpts);
	if (r.exitCode === 0) return r.stdout;
	throw guestProcessError("readGuestFile", path, r.exitCode, r.signal, r.stderr);
}

/**
 * Write `bytes` to a regular file at the guest-absolute `path`. The parent
 * directory must already exist; rejects destinations that are symlinks,
 * directories or other non-regular files.
 *
 * Writes to a unique sibling temporary file, verifies the written byte count,
 * and publishes atomically via `mv -fT`, creating a new inode owned by the
 * selected guest user with private temporary-file mode (typically `0600`).
 * Concurrent writers each publish a complete file and the last rename wins.
 * For durability on an attached data disk, call `vm.sync()` or power off
 * cleanly.
 *
 * On `opts.signal` abort, stops feeding stdin and sends `SIGTERM` before EOF so
 * the guest shell removes its temporary file, then waits briefly before closing
 * an unresponsive session. Guest loss can still leave a temporary file, and a
 * cancellation racing a completed rename does not roll back. Preserves kwtty
 * transport errors (`PtyError`) and reports cancellation with `ABORTED`.
 */
export async function writeGuestFile(vm: KernelHandle, path: string, bytes: Uint8Array, opts: WriteGuestFileOptions = {}): Promise<void> {
	validateGuestFilePath("writeGuestFile", path);
	if (!(bytes instanceof Uint8Array)) {
		throw new TypeError("writeGuestFile: bytes must be a Uint8Array");
	}
	if (opts.signal?.aborted) {
		throw new PtyError("ABORTED", `writeGuestFile ${path}: aborted`);
	}

	const spawnOpts: PipeOptions = { pty: false };
	if (opts.user !== undefined) spawnOpts.user = opts.user;
	if (opts.signal !== undefined) spawnOpts.signal = opts.signal;
	const p = await vm.spawn("/bin/sh", ["-c", WRITE_SH, "sh", path, String(bytes.byteLength)], spawnOpts);

	const signal = opts.signal;
	let stopFeed = false;
	let abortError: PtyError | undefined;
	let inputFailure: unknown;
	let feedError: unknown;
	let cancelWait: Promise<void> | undefined;
	let resolveCancelTriggered!: () => void;
	const cancelTriggered = new Promise<void>((r) => { resolveCancelTriggered = r; });

	const requestCancel = () => {
		stopFeed = true;
		if (cancelWait) return;
		// Signal the guest shell before touching stdin (close/abort both send TTY_EOF).
		try {
			p.kill("TERM");
		} catch { /* session already gone */ }
		cancelWait = new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				void p.close().catch(() => {}).finally(resolve);
			}, CANCEL_GRACE_MS);
			const done = () => {
				clearTimeout(timer);
				resolve();
			};
			p.ended.then(done, done);
		});
		resolveCancelTriggered();
	};

	const onAbort = () => {
		if (!abortError) abortError = new PtyError("ABORTED", `writeGuestFile ${path}: aborted`);
		requestCancel();
	};

	signal?.addEventListener("abort", onAbort);
	if (signal?.aborted) onAbort();

	const stdoutDrain = collectBounded(p.stdout, 0);
	const stderrDrain = collectBounded(p.stderr, MAX_DIAG_BYTES);
	stdoutDrain.catch(() => {});
	stderrDrain.catch(() => {});

	const feed = async () => {
		const writer = p.stdin.getWriter();
		try {
			for (let offset = 0; offset < bytes.byteLength; offset += WRITE_CHUNK_BYTES) {
				if (stopFeed) return;
				const end = Math.min(offset + WRITE_CHUNK_BYTES, bytes.byteLength);
				await writer.write(bytes.subarray(offset, end));
			}
			if (stopFeed) return;
			await writer.close();
		} catch (e) {
			if (stopFeed) return;
			if (e instanceof PtyError && e.code === "EPIPE") {
				// The guest exited (or the transport closed) before consuming all input.
				feedError = e;
				return;
			}
			inputFailure = e;
			requestCancel();
		} finally {
			writer.releaseLock();
		}
	};
	const feedDone = feed();
	feedDone.catch(() => {});

	let end: PtyEnd | undefined;
	let endErr: unknown;
	const endedSettled = p.ended.then(
		(v) => { end = v; },
		(e) => { endErr = e; },
	);

	try {
		await Promise.race([endedSettled, cancelTriggered]);
		stopFeed = true;
		if (cancelWait) await cancelWait;
		if (abortError) throw abortError;
		if (inputFailure !== undefined) throw inputFailure;
		if (endErr !== undefined) throw endErr;
		const stderrBytes = await stderrDrain;
		await stdoutDrain;
		if (abortError) throw abortError;
		if (end?.type === "exit" && end.code === 0) {
			await feedDone;
			if (abortError) throw abortError;
			if (inputFailure !== undefined) throw inputFailure;
			if (feedError !== undefined) throw feedError;
			return;
		}
		if (end?.type === "exit" || end?.type === "signal") {
			throw guestProcessError("writeGuestFile", path, end.type === "exit" ? end.code : null, end.type === "signal" ? end.signal : null, stderrBytes);
		}
		throw new PtyError("ECONNRESET", `writeGuestFile ${path}: the session was lost before the transfer completed (did the kernel exit?)`);
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}
