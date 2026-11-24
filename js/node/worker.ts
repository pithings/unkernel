// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Start the kernel worker (worker-entry.ts) on a worker_threads Worker, for
// createKernel({ worker: true }) (core/worker-host.ts).
//
// From source, Node starts the worker from worker-entry.ts itself. `pnpm
// build` (build.config.ts) bundles worker-entry.ts into one minified ES
// module and replaces the URL of worker-entry.ts below (the expression
// must appear exactly once in this file) with that code as a string literal, so the published package has
// no worker file to find and nothing for a downstream bundler to resolve.

import { Worker } from "node:worker_threads";
import type { WorkerEndpoint } from "../core/worker-protocol.ts";

export function spawnNodeWorker(): WorkerEndpoint {
	const entry: URL | string = new URL("./worker-entry.ts", import.meta.url);
	const w = typeof entry === "string" ? new Worker(entry, { eval: true }) : new Worker(entry);
	return {
		post: (msg, transfer) => w.postMessage(msg, transfer as import("node:worker_threads").Transferable[]),
		listen(h) {
			w.on("message", h.message);
			w.on("error", h.error);
			w.on("exit", h.exit);
		},
		terminate: () => void w.terminate(),
	};
}
