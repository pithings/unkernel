// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// NetStack backend for Wisp v1 servers (https://github.com/MercuryWorkshop/wisp-protocol):
// the guest's TCP connections and UDP flows, multiplexed over one
// WebSocket. Works wherever there is a global WebSocket (browsers, Node >= 22).
//
// Packets: [type u8][stream id u32 LE][payload], all integers little-endian.
//   0x01 CONNECT  type u8 (1 = TCP, 2 = UDP), port u16, hostname   client -> server
//   0x02 DATA     bytes (one datagram on a UDP stream)            both
//   0x03 CONTINUE buffer remaining u32 (packets)                   server -> client
//   0x04 CLOSE    reason u8                                        both
// The server opens with CONTINUE on stream 0 (the per-stream packet credit
// of TCP streams; UDP streams have none).
//
// What the guest can see, compared with real sockets:
//   * Wisp has no DNS. lookup() hands out stable fake addresses from
//     198.18.0.0/15 and connect() maps them back to the name, so the server
//     resolves it. Every name "resolves"; a bad one fails at connect time.
//   * There is no connect acknowledgement, so the guest's connect succeeds
//     at once and a refused or unreachable host shows up as a reset.
//   * There is no half-close: the guest's FIN is not forwarded (the stream
//     stays open until the server closes it).
//   * Only the client -> server direction is flow-controlled; pause() is
//     a no-op and NetStack buffers what the server sends.
//   * A UDP flow is a stream to one host and port. A server without UDP
//     closes it (reason 0x41 or 0x48), and the guest's datagrams are lost.

import type { NetBackend, NetConnection, NetConnectionEvents, NetDatagramSocket } from "./net.ts";

/**
 * The default Wisp server: the project's own. Public alternatives (run by
 * third parties, who see the host names and ports the guest connects to and
 * plain-HTTP content; the guest's TLS is end to end): wss://anura.pro/,
 * wss://wisp.mercurywork.shop/. A ws:// server is blocked as mixed content
 * on an https page.
 */
export const DEFAULT_WISP_SERVERS: readonly string[] = Object.freeze(["wss://wisp.pi0.io:6680/"]);

export interface WispBackendOptions {
	log?: (msg: string) => void;
	/**
	 * Extra handshake headers, e.g. `{ Origin: "http://localhost" }`. Only
	 * runtimes whose WebSocket takes `{ headers }` (Node, Deno, Bun) send
	 * them; in browsers, which set Origin themselves, the option is ignored.
	 * The Node entry's wispBackend() defaults to NODE_WISP_HEADERS.
	 */
	headers?: Record<string, string>;
}

/** Browsers (window or worker) cannot set WebSocket handshake headers. */
const isBrowser = () => typeof (globalThis as { document?: unknown }).document !== "undefined" ||
	typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined";

/** A Wisp backend; close() drops the WebSocket (and with it every stream). */
export interface WispBackend extends NetBackend {
	udp: NonNullable<NetBackend["udp"]>;
	close(): void;
}

const RETRY_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 10000;
const MAX_PACKET = 64 * 1024;          // coalesce guest segments up to this size
const UDP_QUEUE = 64;                  // datagrams a UDP stream queues until the WebSocket is up
const TYPE_TCP = 0x01, TYPE_UDP = 0x02;
const FAKE_BASE = (198 << 24 | 18 << 16) >>> 0, FAKE_SIZE = 1 << 17;
const enc = new TextEncoder();

const CLOSE_REASONS: Record<number, string> = {
	0x01: "unspecified", 0x03: "network error", 0x41: "invalid info", 0x42: "host unreachable",
	0x43: "connect timed out", 0x44: "connection refused", 0x47: "transfer timed out",
	0x48: "blocked by the proxy", 0x49: "throttled",
};

function packet(type: number, id: number, payload?: Uint8Array): Uint8Array<ArrayBuffer> {
	const b = new Uint8Array(5 + (payload?.length ?? 0));
	b[0] = type;
	new DataView(b.buffer).setUint32(1, id, true);
	if (payload) b.set(payload, 5);
	return b;
}

const ip4 = (s: string) => s.split(".").reduce((a, b) => ((a << 8) | Number(b)) >>> 0, 0);
const isIPv4 = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

interface Stream {
	ev: NetConnectionEvents;
	/** A UDP stream: one DATA packet per datagram, no credit. */
	udp: boolean;
	credit: number;
	out: Uint8Array[];
	outBytes: number;
	done: boolean;
	scheduled: boolean;
	open: boolean;
	closed(err: Error | null): void;
	pump(): void;
}

/**
 * @param url  Wisp endpoint(s), e.g. "wss://wisp.example/" (trailing slash
 *   per the spec). Several are raced; the fastest handshake wins.
 */
export function wispBackend(url: string | readonly string[], opts: WispBackendOptions = {}): WispBackend {
	const urls = typeof url === "string" ? [url] : [...url];
	const log = opts.log ?? (() => {});
	// Logs name a default server, not its URL: logs end up in bug reports.
	const name = (u: string) => (DEFAULT_WISP_SERVERS.includes(u) ? "the default server" : u);
	// Node's WebSocket takes { protocols, headers } as its second argument.
	const wsInit = opts.headers && !isBrowser() ? ({ headers: opts.headers } as unknown as string[]) : undefined;
	let ws: WebSocket | null = null, ready: Promise<WebSocket> | null = null, failedAt = -Infinity, warned = false;
	let initialCredit = 0;
	let nextId = 1;
	const streams = new Map<number, Stream>();
	const nameToIp = new Map<string, number>(), ipToName = new Map<number, string>();
	let nextFake = 1;
	let udpWarned = false;
	let connecting: WebSocket[] = [];   // sockets racing for the handshake

	// With several URLs, all are tried at once and the first to complete the
	// handshake (the stream 0 CONTINUE) wins; the others are closed.
	function connectWs(): Promise<WebSocket> {
		if (ready) return ready;
		if (performance.now() - failedAt < RETRY_MS) return Promise.reject(new Error("wisp server unavailable"));
		ready = new Promise<WebSocket>((resolve, reject) => {
			const t0 = performance.now();
			const sockets: WebSocket[] = (connecting = []);
			let settled = false, pending = urls.length;
			const fail = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				for (const s of sockets) s.close();
				ready = null; failedAt = performance.now();
				if (!warned) log(`[net] wisp ${urls.length > 1 ? "servers" : "server"} ${urls.map(name).join(", ")} unavailable; guest network offline`);
				warned = true;
				reject(new Error("wisp server unavailable"));
			};
			const timer = setTimeout(fail, HANDSHAKE_TIMEOUT_MS);
			for (const u of urls) {
				let s: WebSocket;
				try { s = new WebSocket(u, wsInit); } catch { if (--pending === 0) fail(); continue; }
				sockets.push(s);
				s.binaryType = "arraybuffer";
				s.onerror = () => {};
				s.onclose = () => {
					if (ws === s) {
						ws = null; ready = null;
						log("[net] wisp connection closed");
						for (const st of [...streams.values()]) st.closed(new Error("wisp connection closed"));
					} else if (--pending === 0) fail();
				};
				s.onmessage = (e) => {
					const m = new Uint8Array(e.data as ArrayBuffer);
					if (ws === s) return onPacket(m);
					// The first packet must be CONTINUE on stream 0.
					if (settled || m.length < 9 || m[0] !== 0x03) return;
					settled = true;
					clearTimeout(timer);
					initialCredit = new DataView(m.buffer).getUint32(5, true);
					ws = s; warned = false;
					for (const o of sockets) if (o !== s) o.close();
					log(`[net] wisp connected: ${name(u)} (handshake ${Math.round(performance.now() - t0)} ms, buffer ${initialCredit} packets)`);
					resolve(s);
				};
			}
		});
		ready.catch(() => {});
		return ready;
	}

	function onPacket(m: Uint8Array): void {
		if (m.length < 5) return;
		const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
		const st = streams.get(dv.getUint32(1, true));
		if (!st) return;
		switch (m[0]) {
		case 0x02: st.ev.onData(m.subarray(5)); break;
		case 0x03:
			if (m.length >= 9) { st.credit = dv.getUint32(5, true); st.pump(); }
			break;
		case 0x04: {
			const r = m.length > 5 ? m[5]! : 0x01;
			if (r === 0x02) { st.closed(null); break; }
			const err = new Error(`wisp: ${CLOSE_REASONS[r] ?? `close reason 0x${r.toString(16)}`}`);
			if (r === 0x44) (err as Error & { code: string }).code = "ECONNREFUSED";
			if (st.udp && (r === 0x41 || r === 0x48) && !udpWarned) {
				udpWarned = true;
				log("[net] the wisp server refused a UDP stream; it may not carry UDP");
			}
			st.closed(err);
			break;
		}
		}
	}

	/** Open a stream (CONNECT once the WebSocket is up). */
	function open(type: number, host: string, port: number, ev: NetConnectionEvents): { id: number; st: Stream } {
		const id = nextId++;
		const udp = type === TYPE_UDP;
		const name = isIPv4(host) ? ipToName.get(ip4(host)) ?? host : host;
		const st: Stream = {
			ev, udp, credit: 0, out: [], outBytes: 0, done: false, scheduled: false, open: false,
			closed(err) {
				if (st.done) return;
				st.done = true;
				streams.delete(id);
				ev.onClose(err);
			},
			// Send queued guest data as DATA packets while credit lasts.
			pump() {
				st.scheduled = false;
				if (!st.open || st.done || !ws) return;
				const before = st.outBytes;
				while (st.out.length && (udp || st.credit > 0)) {
					let n = 0, k = 0;
					if (!udp) while (k < st.out.length && n + st.out[k]!.length <= MAX_PACKET) n += st.out[k++]!.length;
					if (k === 0) { n = st.out[0]!.length; k = 1; }
					const p = new Uint8Array(5 + n);
					p[0] = 0x02;
					new DataView(p.buffer).setUint32(1, id, true);
					let o = 5;
					for (const c of st.out.splice(0, k)) { p.set(c, o); o += c.length; }
					ws.send(p);
					if (!udp) st.credit--;
					st.outBytes -= n;
				}
				if (st.outBytes < before) ev.onDrain();
			},
		};
		streams.set(id, st);
		connectWs().then((s) => {
			if (st.done) return;
			const host = enc.encode(name);
			const req = new Uint8Array(3 + host.length);
			req[0] = type;
			new DataView(req.buffer).setUint16(1, port, true);
			req.set(host, 3);
			s.send(packet(0x01, id, req));
			st.credit = initialCredit;
			st.open = true;
			ev.onConnect();
			st.pump();
		}, (e) => queueMicrotask(() => st.closed(e)));
		return { id, st };
	}

	/** Drop a stream from this side (CLOSE, reason 0x02); no events follow. */
	function drop(id: number, st: Stream): void {
		if (st.done) return;
		st.done = true;
		streams.delete(id);
		if (st.open) ws?.send(packet(0x04, id, Uint8Array.of(0x02)));
	}

	return {
		connect({ host, port }, ev): NetConnection {
			const { id, st } = open(TYPE_TCP, host, port, ev);
			return {
				write(u8) {
					if (st.done) return;
					st.out.push(u8.slice());
					st.outBytes += u8.length;
					if (!st.scheduled) { st.scheduled = true; queueMicrotask(st.pump); }
				},
				end() {},
				destroy() { drop(id, st); },
				pause() {},
				resume() {},
				get buffered() { return st.outBytes; },
			};
		},
		udp({ host, port }, ev): NetDatagramSocket {
			const { id, st } = open(TYPE_UDP, host, port, {
				onConnect() {}, onEnd() {}, onDrain() {},
				onData: (u8) => ev.onMessage(u8),
				onClose: (err) => ev.onClose(err),
			});
			return {
				send(data) {
					if (st.done || (!st.open && st.out.length >= UDP_QUEUE)) return;
					st.out.push(data);
					st.outBytes += data.length;
					if (!st.scheduled) { st.scheduled = true; queueMicrotask(st.pump); }
				},
				close() { drop(id, st); },
			};
		},
		lookup(name) {
			if (isIPv4(name)) return Promise.resolve([name]);
			let ip = nameToIp.get(name);
			if (ip === undefined) {
				ip = (FAKE_BASE + (nextFake++ % FAKE_SIZE)) >>> 0;
				const old = ipToName.get(ip);
				if (old !== undefined) nameToIp.delete(old);
				nameToIp.set(name, ip);
				ipToName.set(ip, name);
			}
			return Promise.resolve([`${ip >>> 24}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`]);
		},
		/** Drop the WebSocket (and with it every stream), or abandon a handshake in progress. */
		close() {
			ws?.close();
			if (!ws) for (const s of connecting) s.close();
		},
	};
}
