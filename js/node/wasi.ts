// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The guest's WASI programs on Node (core/wasi-exec.ts): each in a
// worker_threads Worker running wasi-entry.ts, started by the owner of
// vm.vsock. serveWasiPrograms() is core's with this spawner, which also
// gives each worker's CPU time (worker.cpuUsage(), for threaded programs'
// process clock).
//
// From source, Node starts the worker from wasi-entry.ts itself. `pnpm
// build` (build.config.ts, WORKERS) replaces the URL below (it must appear
// exactly once in this file) with the bundled entry as a string literal.

import { Worker } from "node:worker_threads";
import type { Vsock } from "../core/vsock.ts";
import { serveWasiProgramsWith, type WasiExecOptions, type WasiExecServer } from "../core/wasi-exec.ts";
import type { WasiFromProgram, WasiProgramEndpoint } from "../core/wasi-program.ts";

export function spawnNodeWasi(): WasiProgramEndpoint {
	const entry: URL | string = new URL("./wasi-entry.ts", import.meta.url);
	const opts = { name: "unkernel-wasi" };
	const w = typeof entry === "string" ? new Worker(entry, { ...opts, eval: true }) : new Worker(entry, opts);
	// A program never keeps the process alive: it belongs to the machine, whose end ends it.
	w.unref();
	return {
		post: (msg, transfer) => w.postMessage(msg, transfer),
		listen(h) {
			w.on("message", (m: WasiFromProgram) => h.message(m));
			w.on("error", h.error);
			w.on("exit", () => h.exit());
		},
		terminate: () => void w.terminate(),
		// Read on the worker's thread (an interrupt, also while it computes or waits); Node 24.6 and later.
		...(typeof w.cpuUsage === "function" && { cpuUsage: () => w.cpuUsage().then((u) => u.user + u.system) }),
	};
}

/** Run the guest's WASI programs (kwwasi, vsock port 1021) on this host, each in a worker thread. */
export function serveWasiPrograms(vsock: Vsock, opts: WasiExecOptions = {}): WasiExecServer {
	return serveWasiProgramsWith(vsock, { ...opts, spawn: spawnNodeWasi });
}
