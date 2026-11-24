// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A NetBackend across a MessagePort: the network stack runs in the kernel
// worker, the backend on another thread (the one that called createKernel).
//
//   worker                                         owner
//   portBackend(port) -----------------------------> serveNetBackend(port, backend)
//     a NetBackend for the worker's NetStack            calls the real backend
//
// createKernel({ worker: true, net: <NetBackend> }) makes the channel and
// runs both ends itself; { kind: "net", backend: { kind: "port", port } }
// is the same thing for an embedder that serves the other end (a service
// worker, another thread, a page that answers for several kernels).
//
// Messages are objects tagged with `t`. Worker to owner: "connect",
// "write", "end", "destroy", "ack", "lookup", "close". Owner to worker:
// "connected", "data", "end", "wack", "closed", "lookup-result". Each
// connection has an `id` chosen by the worker.
//
// Flow control, in both directions, with byte counts instead of the
// synchronous pause() and buffered of a local backend:
//   * guest to backend: the worker sends each write at once and counts the
//     bytes as `buffered` until the owner reports ("wack") that the
//     backend's own buffer no longer holds them (`written - buffer`, after
//     each write and on onDrain). The stack's receive window shrinks with
//     `buffered`, so a backend that does not drain stops the guest, and at
//     most the stack's window (256 KiB) is ever in flight.
//   * backend to guest: the owner sends at most `window` bytes that the
//     worker has not acknowledged ("ack"), calls the backend's pause() when
//     that is reached, queues what a backend sends after that, and resume()s
//     once the worker has caught up. The worker acknowledges what it
//     delivered to the stack unless the stack paused the connection
//     (NetStack does so at 512 KiB of unsent data), so a slow guest stops
//     the backend.
// Chunks cross by transfer: a Uint8Array that does not fill its ArrayBuffer
// (a Node Buffer from the pool) is copied once first. Data handed to
// onData() on the owner's side is detached by the call; the backend must
// not use it after (NetStack does not either).
import type { NetAddress, NetBackend, NetConnection, NetConnectionEvents } from "./net.ts";

/** Bytes sent towards the guest without an acknowledgement, per connection. */
export const NET_PORT_WINDOW = 256 * 1024;

export interface NetPortOptions {
	log?: (msg: string) => void;
}

export interface ServeNetBackendOptions extends NetPortOptions {
	/** Unacknowledged bytes per connection towards the guest. Default NET_PORT_WINDOW. */
	window?: number;
	/** The worker closed its end (the kernel exited), or the port closed: called once, after every connection was destroyed and the backend closed. */
	onClose?: () => void;
}

/** What crosses an error: the message, and `code` ("ENOTFOUND" makes the guest's DNS answer NXDOMAIN). */
interface WireError {
	message: string;
	code?: string;
}

type ToOwner =
	| { t: "connect"; id: number; host: string; port: number; source?: NetAddress["source"] }
	| { t: "write"; id: number; data: Uint8Array }
	| { t: "end"; id: number }
	| { t: "destroy"; id: number }
	| { t: "ack"; id: number; n: number }
	| { t: "lookup"; rid: number; name: string }
	| { t: "close" };

type ToWorker =
	| { t: "connected"; id: number }
	| { t: "data"; id: number; data: Uint8Array }
	| { t: "end"; id: number }
	| { t: "wack"; id: number; n: number }
	| { t: "closed"; id: number; error: WireError | null }
	| { t: "lookup-result"; rid: number; addrs?: string[]; error?: WireError };

const wireError = (e: unknown): WireError => {
	const x = e as { message?: unknown; code?: unknown } | null;
	return { message: typeof x?.message === "string" ? x.message : String(e), code: typeof x?.code === "string" ? x.code : undefined };
};

const fromWire = (e: WireError): Error => Object.assign(new Error(e.message), e.code === undefined ? {} : { code: e.code });

/** `u8` as a chunk that can be transferred: itself if it is all of its ArrayBuffer, else a copy. */
function transferable(u8: Uint8Array): Uint8Array {
	const b = u8.buffer;
	return b instanceof ArrayBuffer && u8.byteOffset === 0 && u8.byteLength === b.byteLength && b.byteLength > 0 ? u8 : new Uint8Array(u8); // not slice(): a Buffer's shares memory
}

function listen(port: MessagePort, onMessage: (msg: unknown) => void, onClose: () => void): void {
	port.addEventListener("message", (e) => onMessage((e as MessageEvent).data));
	// Node emits "close" when the other end goes away (a terminated worker); browsers that do not simply never fire it.
	(port as EventTarget).addEventListener("close", onClose);
	port.start();
}

// --- the worker's end: a NetBackend ------------------------------------------

interface ClientConn {
	ev: NetConnectionEvents;
	/** Guest writes not yet sent (flushed once per microtask, as one transferred buffer). */
	out: Uint8Array[];
	outBytes: number;
	sent: number;
	acked: number;
	/** The stack paused the connection: hold back the acknowledgements. */
	paused: boolean;
	/** Bytes delivered to the stack and not yet acknowledged to the owner. */
	unacked: number;
	ackScheduled: boolean;
	flushScheduled: boolean;
}

/**
 * The NetBackend for a NetStack in the kernel worker whose connections are
 * made by `serveNetBackend()` on the other end of `port`. close() tells the
 * owner (which destroys the connections and closes its backend) and closes
 * the port.
 */
export function portBackend(port: MessagePort, opts: NetPortOptions = {}): NetBackend & { close(): void } {
	const conns = new Map<number, ClientConn>();
	const lookups = new Map<number, { resolve(a: string[]): void; reject(e: unknown): void }>();
	let nextId = 1, nextRid = 1, closed = false;
	const post = (msg: ToOwner, transfer?: Array<ArrayBuffer | MessagePort>) => {
		if (closed) return;
		try { port.postMessage(msg, transfer ?? []); } catch (e) { opts.log?.(`[net] port: ${(e as Error)?.message ?? e}`); }
	};

	/** The owner or its thread is gone: every connection and lookup fails. */
	function lost(): void {
		if (closed) return;
		closed = true;
		const err = new Error("net backend port closed");
		for (const [id, c] of [...conns]) {
			conns.delete(id);
			c.ev.onClose(err);
		}
		for (const l of lookups.values()) l.reject(err);
		lookups.clear();
		port.close();
	}

	listen(port, (m) => {
		const msg = m as ToWorker;
		if (msg.t === "lookup-result") {
			const l = lookups.get(msg.rid);
			if (!l) return;
			lookups.delete(msg.rid);
			if (msg.error) l.reject(fromWire(msg.error));
			else l.resolve(msg.addrs ?? []);
			return;
		}
		const c = conns.get(msg.id);
		if (!c) return;
		switch (msg.t) {
		case "connected": c.ev.onConnect(); break;
		case "data": {
			const n = msg.data.length;
			c.unacked += n;
			c.ev.onData(msg.data);
			if (!c.paused) ack(msg.id, c);
			break;
		}
		case "end": c.ev.onEnd(); break;
		case "wack": c.acked += msg.n; c.ev.onDrain(); break;
		case "closed":
			conns.delete(msg.id);
			c.ev.onClose(msg.error ? fromWire(msg.error) : null);
			break;
		}
	}, lost);

	/** Acknowledge what the stack has taken, once per microtask however many chunks came. */
	function ack(id: number, c: ClientConn): void {
		if (c.ackScheduled || c.unacked === 0) return;
		c.ackScheduled = true;
		queueMicrotask(() => {
			c.ackScheduled = false;
			if (c.paused || c.unacked === 0 || conns.get(id) !== c) return;
			post({ t: "ack", id, n: c.unacked });
			c.unacked = 0;
		});
	}

	function flush(id: number, c: ClientConn): void {
		c.flushScheduled = false;
		if (!c.out.length) return;
		const data = new Uint8Array(c.outBytes);
		let o = 0;
		for (const chunk of c.out) { data.set(chunk, o); o += chunk.length; }
		c.out = [];
		c.outBytes = 0;
		post({ t: "write", id, data }, [data.buffer]);
	}

	return {
		connect({ host, port: dport, source }, ev): NetConnection {
			const id = nextId++;
			const c: ClientConn = { ev, out: [], outBytes: 0, sent: 0, acked: 0, paused: false, unacked: 0, ackScheduled: false, flushScheduled: false };
			if (closed) {
				queueMicrotask(() => ev.onClose(new Error("net backend port closed")));
			} else {
				conns.set(id, c);
				post({ t: "connect", id, host, port: dport, source });
			}
			return {
				write(u8) {
					if (conns.get(id) !== c || !u8.length) return;
					// The stack's bytes may be a view of a frame it reuses: copy them now.
					c.out.push(new Uint8Array(u8));
					c.outBytes += u8.length;
					c.sent += u8.length;
					if (!c.flushScheduled) { c.flushScheduled = true; queueMicrotask(() => flush(id, c)); }
				},
				end() {
					if (conns.get(id) !== c) return;
					flush(id, c);
					post({ t: "end", id });
				},
				destroy() {
					if (conns.get(id) !== c) return;
					conns.delete(id);
					c.out = [];
					post({ t: "destroy", id });
				},
				pause() { c.paused = true; },
				resume() {
					c.paused = false;
					ack(id, c);
				},
				get buffered() { return c.sent - c.acked; },
			};
		},
		lookup(name) {
			if (closed) return Promise.reject(new Error("net backend port closed"));
			return new Promise<string[]>((resolve, reject) => {
				const rid = nextRid++;
				lookups.set(rid, { resolve, reject });
				post({ t: "lookup", rid, name });
			});
		},
		close() {
			if (closed) return;
			post({ t: "close" });
			lost();
		},
	};
}

// --- the owner's end: serves a real backend ------------------------------------

type QueueItem = { chunk: Uint8Array } | { end: true } | { close: WireError | null };

interface ServedConn {
	handle: NetConnection | undefined;
	queue: QueueItem[];
	/** Bytes posted to the worker and not yet acknowledged. */
	inflight: number;
	/** Bytes the backend was given and bytes of those it no longer holds (reported to the worker). */
	written: number;
	acked: number;
	paused: boolean;
	done: boolean;
}

/**
 * Serve `backend` to the portBackend() on the other end of `port`. Returns
 * a handle whose close() destroys every connection, closes the backend and
 * the port. The same happens when the worker closes its end (the kernel
 * exits) or the port closes (the worker was terminated).
 */
export function serveNetBackend(port: MessagePort, backend: NetBackend, opts: ServeNetBackendOptions = {}): { close(): void } {
	const window = opts.window ?? NET_PORT_WINDOW;
	const conns = new Map<number, ServedConn>();
	let closed = false;
	const post = (msg: ToWorker, transfer?: Array<ArrayBuffer | MessagePort>) => {
		if (closed) return;
		try { port.postMessage(msg, transfer ?? []); } catch (e) { opts.log?.(`[net] port: ${(e as Error)?.message ?? e}`); }
	};

	function shutdown(): void {
		if (closed) return;
		for (const c of conns.values()) {
			c.done = true;
			try { c.handle?.destroy(); } catch {}
		}
		conns.clear();
		try { backend.close?.(); } catch (e) { opts.log?.(`[net] backend close: ${(e as Error)?.message ?? e}`); }
		closed = true;
		port.close();
		opts.onClose?.();
	}

	/** Post queued events in order, while the worker's window has room. */
	function pump(id: number, c: ServedConn): void {
		while (c.queue.length && !c.done) {
			const item = c.queue[0]!;
			if ("chunk" in item) {
				if (c.inflight >= window) break;
				c.queue.shift();
				const data = transferable(item.chunk);
				c.inflight += data.length;
				post({ t: "data", id, data }, [data.buffer as ArrayBuffer]);
			} else if ("end" in item) {
				c.queue.shift();
				post({ t: "end", id });
			} else {
				c.queue.shift();
				c.done = true;
				conns.delete(id);
				post({ t: "closed", id, error: item.close });
			}
		}
		if (c.done) return;
		// Hold the backend back while the worker is behind; let it go once the worker has caught up.
		if (!c.paused && (c.inflight >= window || c.queue.length)) {
			c.paused = true;
			c.handle?.pause();
		} else if (c.paused && !c.queue.length && c.inflight < window / 2) {
			c.paused = false;
			c.handle?.resume();
		}
	}

	/** Tell the worker how many of its written bytes the backend no longer holds. */
	function report(id: number, c: ServedConn): void {
		if (!c.handle || c.done) return;
		const target = c.written - c.handle.buffered;
		if (target > c.acked) {
			post({ t: "wack", id, n: target - c.acked });
			c.acked = target;
		}
	}

	function open(id: number, addr: NetAddress): void {
		const c: ServedConn = { handle: undefined, queue: [], inflight: 0, written: 0, acked: 0, paused: false, done: false };
		conns.set(id, c);
		const push = (item: QueueItem) => { if (!c.done) { c.queue.push(item); pump(id, c); } };
		try {
			c.handle = backend.connect(addr, {
				onConnect: () => { if (!c.done) post({ t: "connected", id }); },
				onData: (data) => push({ chunk: data }),
				onEnd: () => push({ end: true }),
				onDrain: () => report(id, c),
				onClose: (err) => push({ close: err ? wireError(err) : null }),
			});
		} catch (e) {
			c.done = true;
			conns.delete(id);
			post({ t: "closed", id, error: wireError(e) });
			return;
		}
		// A backend that paused or closed while connect() was still running.
		if (c.paused && !c.done) c.handle.pause();
	}

	listen(port, (m) => {
		const msg = m as ToOwner;
		switch (msg.t) {
		case "connect": {
			const addr: NetAddress = { host: msg.host, port: msg.port };
			if (msg.source) addr.source = msg.source;
			open(msg.id, addr);
			return;
		}
		case "lookup":
			// A backend that throws instead of rejecting answers like one that rejects.
			Promise.resolve().then(() => backend.lookup(msg.name)).then(
				(addrs) => post({ t: "lookup-result", rid: msg.rid, addrs }),
				(e) => post({ t: "lookup-result", rid: msg.rid, error: wireError(e) }));
			return;
		case "close": shutdown(); return;
		}
		const c = conns.get(msg.id);
		if (!c || c.done || !c.handle) return;
		switch (msg.t) {
		case "write":
			c.written += msg.data.length;
			c.handle.write(msg.data);
			report(msg.id, c);
			break;
		case "end": c.handle.end(); break;
		case "destroy":
			c.done = true;
			conns.delete(msg.id);
			c.handle.destroy();
			break;
		case "ack":
			c.inflight = Math.max(0, c.inflight - msg.n);
			pump(msg.id, c);
			break;
		}
	}, shutdown);

	return { close: shutdown };
}
