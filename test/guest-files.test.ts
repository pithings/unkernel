// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Deterministic unit tests for readGuestFile() and writeGuestFile()
// (js/core/guest-files.ts) without a kernel: validates paths, options,
// transport error preservation, bounded diagnostics, and exact event ordering
// during cancellation (SIGTERM before EOF, never closing/aborting stdin).
//
//   node --test test/guest-files.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readGuestFile, writeGuestFile } from "../js/core/guest-files.ts";
import type { KernelHandle } from "../js/core/instance.ts";
import { PtyError, type ExecOptions, type ExecResult, type PipeOptions, type PtyEnd, type Subprocess } from "../js/core/tty.ts";

const enc = new TextEncoder();

interface FakeSubprocessControl {
	proc: Subprocess;
	events: string[];
	written: Uint8Array[];
	stdinClosed: boolean;
	stdinAborted: boolean;
	closeCalls: number;
	emitStderr(chunk: Uint8Array | string): void;
	finish(end: PtyEnd): void;
	fail(err: Error): void;
}

function makeFakeSubprocess(opts: {
	onWrite?: (chunk: Uint8Array, index: number) => void | Promise<void>;
	onStdinClose?: () => void;
	onKill?: (signal: string) => void;
	onClose?: () => void;
} = {}): FakeSubprocessControl {
	const events: string[] = [];
	const written: Uint8Array[] = [];
	let stdinClosed = false;
	let stdinAborted = false;
	let closeCalls = 0;
	let writeCount = 0;
	let outCtrl!: ReadableStreamDefaultController<Uint8Array>;
	let errCtrl!: ReadableStreamDefaultController<Uint8Array>;
	let resolveEnded!: (end: PtyEnd) => void;
	let rejectEnded!: (err: Error) => void;
	let done = false;

	const stdout = new ReadableStream<Uint8Array>({ start: (c) => { outCtrl = c; } });
	const stderr = new ReadableStream<Uint8Array>({ start: (c) => { errCtrl = c; } });
	const ended = new Promise<PtyEnd>((resolve, reject) => {
		resolveEnded = resolve;
		rejectEnded = reject;
	});
	ended.catch(() => {});

	const closeStreams = (err?: Error) => {
		try {
			if (err) outCtrl.error(err);
			else outCtrl.close();
		} catch {}
		try {
			if (err) errCtrl.error(err);
			else errCtrl.close();
		} catch {}
	};

	const finish = (end: PtyEnd) => {
		if (done) return;
		done = true;
		events.push(`ended:${end.type}${end.type === "exit" ? `:${end.code}` : ""}`);
		closeStreams();
		resolveEnded(end);
	};

	const fail = (err: Error) => {
		if (done) return;
		done = true;
		events.push(`ended:error`);
		closeStreams(err);
		rejectEnded(err);
	};

	const stdin = new WritableStream<Uint8Array | string>({
		write: async (chunk) => {
			const b = typeof chunk === "string" ? enc.encode(chunk) : new Uint8Array(chunk);
			const idx = writeCount++;
			events.push(`write:${b.byteLength}`);
			written.push(b);
			await opts.onWrite?.(b, idx);
		},
		close: () => {
			stdinClosed = true;
			events.push("stdin:close");
			opts.onStdinClose?.();
		},
		abort: () => {
			stdinAborted = true;
			events.push("stdin:abort");
		},
	});

	const proc: Subprocess = {
		pid: 42,
		exitCode: null,
		version: 1,
		features: 1,
		stdin,
		stdout,
		stderr,
		ended,
		kill(signal = "SIGTERM") {
			events.push(`kill:${signal}`);
			opts.onKill?.(signal);
		},
		async close() {
			closeCalls++;
			events.push("close");
			opts.onClose?.();
			finish({ type: "closed" });
		},
		[Symbol.asyncDispose]() {
			return this.close();
		},
	};

	return {
		proc,
		events,
		written,
		get stdinClosed() { return stdinClosed; },
		get stdinAborted() { return stdinAborted; },
		get closeCalls() { return closeCalls; },
		emitStderr(chunk: Uint8Array | string) {
			errCtrl.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk);
		},
		finish,
		fail,
	};
}

function fakeVm(handlers: {
	exec?: (file: string, args: readonly string[] | undefined, opts: ExecOptions | undefined) => Promise<ExecResult<Uint8Array>>;
	spawn?: (file: string | undefined, args: readonly string[] | undefined, opts: PipeOptions) => Promise<Subprocess>;
}): KernelHandle {
	return {
		exec: (file: string, args?: readonly string[], opts?: ExecOptions) => {
			if (!handlers.exec) throw new Error("unexpected exec() call");
			return handlers.exec(file, args, opts);
		},
		spawn: (file: string | undefined, args: readonly string[] | undefined, opts: PipeOptions) => {
			if (!handlers.spawn) throw new Error("unexpected spawn() call");
			return handlers.spawn(file, args, opts);
		},
	} as unknown as KernelHandle;
}

test("validates guest paths, bytes and maxBuffer without touching vm", async () => {
	const vm = fakeVm({});
	const badPaths = ["", "relative.bin", "a/b", "./a", "/", "/tmp/", "/.", "/..", "/tmp/.", "/tmp/..", "/tmp/a\0b"];
	for (const bad of badPaths) {
		await assert.rejects(readGuestFile(vm, bad), RangeError, `readGuestFile should reject ${JSON.stringify(bad)}`);
		await assert.rejects(writeGuestFile(vm, bad, new Uint8Array()), RangeError, `writeGuestFile should reject ${JSON.stringify(bad)}`);
	}
	await assert.rejects(writeGuestFile(vm, "/tmp/a", "not bytes" as unknown as Uint8Array), TypeError);
	await assert.rejects(writeGuestFile(vm, "/tmp/a", new Uint16Array(2) as unknown as Uint8Array), TypeError);
	await assert.rejects(readGuestFile(vm, "/tmp/a", { maxBuffer: -1 }), RangeError);
	await assert.rejects(readGuestFile(vm, "/tmp/a", { maxBuffer: Number.NaN }), RangeError);
});

test("pre-aborted signal rejects with PtyError ABORTED without spawning", async () => {
	const vm = fakeVm({});
	const ac = new AbortController();
	ac.abort();
	const isAborted = (e: unknown) => e instanceof PtyError && e.code === "ABORTED";
	await assert.rejects(readGuestFile(vm, "/tmp/a", { signal: ac.signal }), isAborted);
	await assert.rejects(writeGuestFile(vm, "/tmp/a", new Uint8Array([1, 2, 3]), { signal: ac.signal }), isAborted);
});

test("readGuestFile forwards path verbatim, options and preserves transport errors", async () => {
	const calls: Array<{ file: string; args: readonly string[] | undefined; opts: ExecOptions | undefined }> = [];
	const payload = Uint8Array.of(0, 127, 128, 255);
	const vm = fakeVm({
		exec: async (file, args, opts) => {
			calls.push({ file, args, opts });
			return { stdout: payload, stderr: new Uint8Array(0), exitCode: 0, signal: null };
		},
	});
	const ac = new AbortController();
	const guestPath = "/tmp/link/../sub//-a café's.bin";
	const out = await readGuestFile(vm, guestPath, { user: "root", maxBuffer: 4096, signal: ac.signal });
	assert.deepEqual(out, payload);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.file, "/bin/sh");
	assert.equal(calls[0]!.args?.[3], guestPath, "path passed verbatim without flattening");
	assert.equal(calls[0]!.opts?.encoding, "buffer");
	assert.equal(calls[0]!.opts?.user, "root");
	assert.equal(calls[0]!.opts?.maxBuffer, 4096);
	assert.equal(calls[0]!.opts?.signal, ac.signal);

	// Guest failure includes operation, path and guest stderr.
	const failVm = fakeVm({
		exec: async () => ({ stdout: new Uint8Array(0), stderr: enc.encode("not a regular file\n"), exitCode: 1, signal: null }),
	});
	await assert.rejects(readGuestFile(failVm, "/tmp/dir"), /readGuestFile \/tmp\/dir: not a regular file/);

	// Transport PtyError is preserved unchanged.
	const enobufs = new PtyError("ENOBUFS", "kwtty: stdout went over maxBuffer");
	const transportVm = fakeVm({ exec: async () => { throw enobufs; } });
	await assert.rejects(readGuestFile(transportVm, "/tmp/big", { maxBuffer: 10 }), (e) => e === enobufs);
});

test("writeGuestFile ordered cancellation: mid-write abort sends SIGTERM before EOF and never closes or aborts stdin", async () => {
	const ac = new AbortController();
	let ctl!: FakeSubprocessControl;
	const vm = fakeVm({
		spawn: async (file, args, opts) => {
			assert.equal(file, "/bin/sh");
			assert.equal(opts.pty, false);
			assert.equal(args?.[3], "/tmp/target.bin");
			assert.equal(args?.[4], String(96 * 1024));
			ctl = makeFakeSubprocess({
				onWrite: (_chunk, idx) => {
					if (idx === 0) ac.abort();
				},
				onKill: (sig) => {
					assert.equal(sig, "TERM");
					assert.equal(ctl.stdinClosed, false, "stdin must not be closed before SIGTERM");
					assert.equal(ctl.stdinAborted, false, "stdin must not be aborted before SIGTERM");
					queueMicrotask(() => ctl.finish({ type: "exit", code: 1 }));
				},
			});
			return ctl.proc;
		},
	});

	await assert.rejects(
		writeGuestFile(vm, "/tmp/target.bin", new Uint8Array(96 * 1024), { signal: ac.signal }),
		(e: unknown) => e instanceof PtyError && e.code === "ABORTED",
	);
	assert.deepEqual(ctl.events, ["write:32768", "kill:TERM", "ended:exit:1"]);
	assert.equal(ctl.stdinClosed, false);
	assert.equal(ctl.stdinAborted, false);
	assert.equal(ctl.closeCalls, 0);
});

test("writeGuestFile abort while stdin.write is stalled immediately sends SIGTERM and does not hang", async () => {
	const ac = new AbortController();
	let ctl!: FakeSubprocessControl;
	const vm = fakeVm({
		spawn: async () => {
			ctl = makeFakeSubprocess({
				onWrite: () => new Promise<void>(() => {
					queueMicrotask(() => ac.abort());
				}),
				onKill: () => {
					queueMicrotask(() => ctl.finish({ type: "exit", code: 1 }));
				},
			});
			return ctl.proc;
		},
	});

	await assert.rejects(
		writeGuestFile(vm, "/tmp/stalled.bin", new Uint8Array(64 * 1024), { signal: ac.signal }),
		(e: unknown) => e instanceof PtyError && e.code === "ABORTED",
	);
	assert.deepEqual(ctl.events, ["write:32768", "kill:TERM", "ended:exit:1"]);
	assert.equal(ctl.stdinClosed, false);
	assert.equal(ctl.stdinAborted, false);
});

test("writeGuestFile abort falls back to close() if the guest never exits after SIGTERM", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const ac = new AbortController();
	let ctl!: FakeSubprocessControl;
	const vm = fakeVm({
		spawn: async () => {
			ctl = makeFakeSubprocess({
				onWrite: () => {
					ac.abort();
					return new Promise<void>(() => {});
				},
			});
			return ctl.proc;
		},
	});

	const pending = writeGuestFile(vm, "/tmp/hung.bin", new Uint8Array(64 * 1024), { signal: ac.signal });
	await new Promise<void>((r) => queueMicrotask(r));
	await new Promise<void>((r) => queueMicrotask(r));
	assert.deepEqual(ctl.events, ["write:32768", "kill:TERM"]);
	assert.equal(ctl.closeCalls, 0);

	t.mock.timers.tick(5000);
	await assert.rejects(pending, (e: unknown) => e instanceof PtyError && e.code === "ABORTED");
	assert.deepEqual(ctl.events, ["write:32768", "kill:TERM", "close", "ended:closed"]);
	assert.equal(ctl.stdinClosed, false);
	assert.equal(ctl.stdinAborted, false);
});

test("writeGuestFile non-EPIPE stdin failure sends SIGTERM before teardown without sending EOF", async () => {
	const boom = new Error("sink write failed");
	let ctl!: FakeSubprocessControl;
	const vm = fakeVm({
		spawn: async () => {
			ctl = makeFakeSubprocess({
				onWrite: (_chunk, idx) => {
					if (idx === 1) throw boom;
				},
				onKill: () => {
					queueMicrotask(() => ctl.finish({ type: "exit", code: 1 }));
				},
			});
			return ctl.proc;
		},
	});

	await assert.rejects(writeGuestFile(vm, "/tmp/err.bin", new Uint8Array(96 * 1024)), (e) => e === boom);
	assert.deepEqual(ctl.events, ["write:32768", "write:32768", "kill:TERM", "ended:exit:1"]);
	assert.equal(ctl.stdinClosed, false);
	assert.equal(ctl.stdinAborted, false);
});

test("writeGuestFile early guest exit (EPIPE on stdin) reports guest stderr and bounds diagnostics", async () => {
	let ctl!: FakeSubprocessControl;
	const vm = fakeVm({
		spawn: async () => {
			ctl = makeFakeSubprocess({
				onWrite: () => {
					ctl.emitStderr("destination is not a regular file\n");
					ctl.finish({ type: "exit", code: 1 });
					throw new PtyError("EPIPE", "kwtty: the session has ended");
				},
			});
			return ctl.proc;
		},
	});
	await assert.rejects(
		writeGuestFile(vm, "/tmp/dir", new Uint8Array(64 * 1024)),
		/writeGuestFile \/tmp\/dir: destination is not a regular file/,
	);

	// Huge stderr is drained without hanging and capped in the thrown error message.
	const noisyVm = fakeVm({
		spawn: async () => {
			const c = makeFakeSubprocess({
				onWrite: () => {
					for (let i = 0; i < 64; i++) c.emitStderr("x".repeat(1024));
					c.finish({ type: "exit", code: 1 });
					throw new PtyError("EPIPE", "kwtty: the session has ended");
				},
			});
			return c.proc;
		},
	});
	await assert.rejects(writeGuestFile(noisyVm, "/tmp/noisy", new Uint8Array(10)), (e: unknown) => {
		assert.ok(e instanceof Error);
		assert.match(e.message, /^writeGuestFile \/tmp\/noisy: x+/);
		assert.ok(e.message.length <= 17 * 1024, `bounded message length: ${e.message.length}`);
		return true;
	});
});

test("writeGuestFile preserves transport errors and handles empty payloads cleanly", async () => {
	// Empty payload sends EOF directly with zero DATA writes.
	let ctl!: FakeSubprocessControl;
	const okVm = fakeVm({
		spawn: async (_file, args) => {
			assert.equal(args?.[4], "0");
			ctl = makeFakeSubprocess({
				onStdinClose: () => queueMicrotask(() => ctl.finish({ type: "exit", code: 0 })),
			});
			return ctl.proc;
		},
	});
	await writeGuestFile(okVm, "/tmp/empty.bin", new Uint8Array(0));
	assert.deepEqual(ctl.events, ["stdin:close", "ended:exit:0"]);

	// Lost session -> PtyError ECONNRESET.
	const lostVm = fakeVm({
		spawn: async () => {
			const c = makeFakeSubprocess();
			queueMicrotask(() => c.finish({ type: "lost" }));
			return c.proc;
		},
	});
	await assert.rejects(
		writeGuestFile(lostVm, "/tmp/lost.bin", new Uint8Array(0)),
		(e: unknown) => e instanceof PtyError && e.code === "ECONNRESET",
	);

	// Rejected ended with PtyError -> preserved.
	const protoErr = new PtyError("EPROTO", "kwtty: bad frame");
	const protoVm = fakeVm({
		spawn: async () => {
			const c = makeFakeSubprocess();
			queueMicrotask(() => c.fail(protoErr));
			return c.proc;
		},
	});
	await assert.rejects(writeGuestFile(protoVm, "/tmp/proto.bin", new Uint8Array(0)), (e) => e === protoErr);
});
