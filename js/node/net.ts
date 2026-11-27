// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// NetStack backend for Node: real TCP and UDP sockets and the host resolver.
//
// The guest reaches whatever this machine can reach, as this process. Use
// it with `new NetStack({ backend: directBackend(), hostLoopback: true })`
// to also let TCP and UDP to the gateway (10.0.2.2) reach 127.0.0.1.
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import { UDP_QUEUE, type NetBackend } from "../core/net.ts";
import { wispBackend as coreWispBackend, type WispBackend, type WispBackendOptions } from "../core/net-wisp.ts";

/**
 * Handshake headers the Node entry's wispBackend() sends unless `headers`
 * is given. Node's WebSocket sends no Origin, and the project's server
 * (DEFAULT_WISP_SERVERS) accepts only pages from localhost or 127.0.0.1.
 */
export const NODE_WISP_HEADERS: Readonly<Record<string, string>> = Object.freeze({ Origin: "http://localhost" });

/** wispBackend() with `headers` defaulting to NODE_WISP_HEADERS. */
export function wispBackend(url: string | readonly string[], opts: WispBackendOptions = {}): WispBackend {
	return coreWispBackend(url, { ...opts, headers: opts.headers ?? { ...NODE_WISP_HEADERS } });
}

const CONNECT_TIMEOUT_MS = 20000;

export function directBackend(): NetBackend {
	const sockets = new Set<net.Socket>();
	const udps = new Set<() => void>();   // each open UDP flow's drop()
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
		// One connected socket per flow: the host's kernel picks the source
		// port and drops datagrams from anyone but the flow's remote, and an
		// ICMP port unreachable from it surfaces as ECONNREFUSED.
		udp({ host, port }, ev) {
			const s = dgram.createSocket("udp4");
			let closed = false, ready = false;
			const queue: Uint8Array[] = [];
			const drop = () => {
				if (closed) return;
				closed = true;
				udps.delete(drop);
				try { s.close(); } catch { /* not running */ }
			};
			const fail = (err: Error) => {
				if (closed) return;
				drop();
				ev.onClose(err);
			};
			const send = (d: Uint8Array) => {
				try { s.send(d); } catch (e) { fail(e as Error); }
			};
			udps.add(drop);
			s.on("message", (b: Buffer) => { if (!closed) ev.onMessage(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)); });
			s.on("error", fail);
			try {
				s.connect(port, host, () => {
					ready = true;
					for (const d of queue.splice(0)) if (!closed) send(d);
				});
			} catch (e) { fail(e as Error); } // throws at once for port 0
			return {
				send(data) {
					if (closed) return;
					if (ready) send(data);
					else if (queue.length < UDP_QUEUE) queue.push(data);
				},
				close: drop,
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
			for (const drop of [...udps]) drop();
		},
	};
}
