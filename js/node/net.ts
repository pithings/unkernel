// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// NetStack backend for Node: real TCP sockets and the host resolver.
//
// The guest reaches whatever this machine can reach, as this process. Use
// it with `new NetStack({ backend: directBackend(), hostLoopback: true })`
// to also let TCP to the gateway (10.0.2.2) reach 127.0.0.1.
import net from "node:net";
import dns from "node:dns";
import type { NetBackend } from "../core/net.ts";

const CONNECT_TIMEOUT_MS = 20000;

export function directBackend(): NetBackend {
	const sockets = new Set<net.Socket>();
	return {
		connect({ host, port }, ev) {
			const s = net.connect({ host, port, allowHalfOpen: true, noDelay: true });
			sockets.add(s);
			let closed = false;
			const timer = setTimeout(() => s.destroy(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
			s.on("connect", () => { clearTimeout(timer); ev.onConnect(); });
			s.on("data", (b: Buffer) => ev.onData(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)));
			s.on("end", () => ev.onEnd());
			s.on("drain", () => ev.onDrain());
			s.on("error", () => {});
			s.on("close", () => {
				clearTimeout(timer);
				sockets.delete(s);
				if (closed) return;
				closed = true;
				ev.onClose(s.errored ?? null);
			});
			return {
				write: (u8) => { s.write(u8); },
				end: () => { s.end(); },
				destroy: () => { closed = true; s.destroy(); },
				pause: () => { s.pause(); },
				resume: () => { s.resume(); },
				get buffered() { return s.writableLength; },
			};
		},
		lookup(name) {
			return new Promise((resolve, reject) => {
				dns.lookup(name, { family: 4, all: true }, (err, addrs) => {
					if (err) reject(err);
					else resolve(addrs.map((a) => a.address));
				});
			});
		},
		/** Destroy every open socket. */
		close() {
			for (const s of sockets) s.destroy();
			sockets.clear();
		},
	};
}
