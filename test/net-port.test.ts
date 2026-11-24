// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Unit tests for a NetBackend served across a MessagePort (js/core/net-port.ts):
// both ends in this thread, over a MessageChannel, with fake backends.
//
//   node --test test/net-port.test.ts
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { NET_PORT_WINDOW, portBackend, serveNetBackend } from "../js/core/net-port.ts";
import type { NetAddress, NetBackend, NetConnection, NetConnectionEvents } from "../js/core/net.ts";
import { directBackend } from "../js/node/net.ts";
import { echoTest, until } from "./net-helpers.ts";

/** A backend whose connections are driven by the test. */
function fakeBackend(opts: { holdWrites?: boolean } = {}) {
	const conns: Array<{
		addr: NetAddress; ev: NetConnectionEvents;
		writes: Uint8Array[]; ended: boolean; destroyed: boolean; paused: boolean; pauses: number; buffered: number;
	}> = [];
	let closed = false;
	const backend: NetBackend = {
		connect(addr, ev): NetConnection {
			const c = { addr, ev, writes: [] as Uint8Array[], ended: false, destroyed: false, paused: false, pauses: 0, buffered: 0 };
			conns.push(c);
			return {
				write: (u8) => { c.writes.push(u8); if (opts.holdWrites) c.buffered += u8.length; },
				end: () => { c.ended = true; },
				destroy: () => { c.destroyed = true; },
				pause: () => { c.paused = true; c.pauses++; },
				resume: () => { c.paused = false; },
				get buffered() { return c.buffered; },
			};
		},
		async lookup(name) {
			if (name === "boom.test") throw new Error("resolver down");
			if (name !== "known.test") throw Object.assign(new Error("no such host"), { code: "ENOTFOUND" });
			return ["10.1.2.3"];
		},
		close() { closed = true; },
	};
	return { backend, conns, isClosed: () => closed };
}

/** The two ends, wired through a MessageChannel. */
function wire(t: TestContext, backend: NetBackend, opts: { window?: number } = {}) {
	const { port1, port2 } = new MessageChannel();
	let served = true;
	const server = serveNetBackend(port1, backend, { window: opts.window, onClose: () => { served = false; } });
	const client = portBackend(port2);
	t.after(() => { client.close(); server.close(); });
	return { client, server, port2, isServing: () => served };
}

/** A guest-side connection that records what the stack would see. */
function open(client: NetBackend, host = "10.77.0.5", port = 80, source?: NetAddress["source"]) {
	const r = {
		events: [] as string[], received: 0, drains: 0, error: undefined as Error | null | undefined, closed: false,
		connected: false, handle: undefined as unknown as NetConnection,
	};
	r.handle = client.connect({ host, port, source }, {
		onConnect: () => { r.connected = true; r.events.push("connect"); },
		onData: (u8) => { r.received += u8.length; r.events.push(`data:${u8.length}`); },
		onEnd: () => { r.events.push("end"); },
		onDrain: () => { r.drains++; },
		onClose: (e) => { r.error = e; r.closed = true; r.events.push("close"); },
	});
	return r;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("connect carries the destination and the guest's source; events come back in order, data transferred", async (t) => {
	const fake = fakeBackend();
	const { client, server } = wire(t, fake.backend);
	const c = open(client, "10.77.0.5", 80, { host: "10.0.2.15", port: 49152 });
	await until(() => fake.conns.length === 1);
	assert.deepEqual(fake.conns[0]!.addr, { host: "10.77.0.5", port: 80, source: { host: "10.0.2.15", port: 49152 } });
	const ev = fake.conns[0]!.ev;
	ev.onConnect();
	const chunk = new Uint8Array(1000).fill(7);
	ev.onData(chunk);
	ev.onData(new Uint8Array(500));
	ev.onEnd();
	ev.onClose(null);
	await until(() => c.closed);
	assert.deepEqual(c.events, ["connect", "data:1000", "data:500", "end", "close"]);
	assert.equal(c.error, null);
	assert.equal(chunk.byteLength, 0, "a chunk that fills its buffer is transferred, not copied");
	client.close();
	server.close();
});

test("a chunk that is a view into a larger buffer (a pooled Buffer) is copied, and the original stays usable", async (t) => {
	const fake = fakeBackend();
	const { client, server } = wire(t, fake.backend);
	const c = open(client);
	await until(() => fake.conns.length === 1);
	const pool = new Uint8Array(8192).fill(9);
	fake.conns[0]!.ev.onConnect();
	fake.conns[0]!.ev.onData(pool.subarray(100, 200));
	await until(() => c.received === 100);
	assert.equal(pool.byteLength, 8192);
	assert.equal(pool[150], 9);
	// A small Buffer lives in Node's shared pool, and Buffer#slice() shares memory instead of copying.
	const small = Buffer.from("hello");
	fake.conns[0]!.ev.onData(small);
	await until(() => c.received === 105);
	assert.equal(small.toString(), "hello");
	client.close();
	server.close();
});

test("writes reach the backend in order as one transferred buffer, and end() is a half-close that arrives after them", async (t) => {
	const fake = fakeBackend();
	const { client, server } = wire(t, fake.backend);
	const c = open(client);
	await until(() => fake.conns.length === 1);
	fake.conns[0]!.ev.onConnect();
	const view = Uint8Array.from([1, 2, 3, 4, 5, 6]);
	c.handle.write(view.subarray(0, 2));
	c.handle.write(view.subarray(2, 6));
	view.fill(0); // the stack reuses its frame: what was written must have been copied
	c.handle.end();
	await until(() => fake.conns[0]!.ended);
	const got = Buffer.concat(fake.conns[0]!.writes);
	assert.deepEqual([...got], [1, 2, 3, 4, 5, 6]);
	assert.equal(fake.conns[0]!.destroyed, false, "half-close is not a destroy");
	assert.equal(c.closed, false, "the other direction stays open");
	// The backend can still answer after the guest's half-close.
	fake.conns[0]!.ev.onData(new Uint8Array(10));
	fake.conns[0]!.ev.onClose(null);
	await until(() => c.closed);
	assert.equal(c.received, 10);
	client.close();
	server.close();
});

test("destroy() reaches the backend and no further events are delivered", async (t) => {
	const fake = fakeBackend();
	const { client, server } = wire(t, fake.backend);
	const c = open(client);
	await until(() => fake.conns.length === 1);
	fake.conns[0]!.ev.onConnect();
	await until(() => c.connected);
	c.handle.destroy();
	await until(() => fake.conns[0]!.destroyed);
	fake.conns[0]!.ev.onData(new Uint8Array(5));
	fake.conns[0]!.ev.onClose(new Error("late"));
	await tick();
	assert.deepEqual(c.events, ["connect"]);
	client.close();
	server.close();
});

test("a refused or failed connection reaches the guest as onClose(error) with its code; a throwing connect() does too", async (t) => {
	const fake = fakeBackend();
	const { client, server } = wire(t, fake.backend);
	const a = open(client);
	await until(() => fake.conns.length === 1);
	fake.conns[0]!.ev.onClose(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }));
	await until(() => a.closed);
	assert.equal(a.connected, false);
	assert.equal(a.error?.message, "connection refused");
	assert.equal((a.error as { code?: string }).code, "ECONNREFUSED");
	// An error after the connection was up.
	const b = open(client);
	await until(() => fake.conns.length === 2);
	fake.conns[1]!.ev.onConnect();
	fake.conns[1]!.ev.onData(new Uint8Array(4));
	fake.conns[1]!.ev.onClose(new Error("reset by peer"));
	await until(() => b.closed);
	assert.deepEqual(b.events, ["connect", "data:4", "close"]);
	assert.equal(b.error?.message, "reset by peer");
	client.close();
	server.close();

	const throwing: NetBackend = { connect() { throw new Error("no route"); }, lookup: async () => [] };
	const w = wire(t, throwing);
	const c = open(w.client);
	await until(() => c.closed);
	assert.equal(c.error?.message, "no route");
	w.client.close();
	w.server.close();
});

test("lookup: addresses, ENOTFOUND keeps its code, any other failure is an error", async (t) => {
	const fake = fakeBackend();
	const { client, server } = wire(t, fake.backend);
	assert.deepEqual(await client.lookup("known.test"), ["10.1.2.3"]);
	await assert.rejects(client.lookup("nope.test"), (e: Error & { code?: string }) => e.code === "ENOTFOUND" && /no such host/.test(e.message));
	await assert.rejects(client.lookup("boom.test"), (e: Error & { code?: string }) => e.code === undefined && /resolver down/.test(e.message));
	client.close();
	server.close();
});

test("flow control towards the guest: a paused consumer stops the backend, which holds at most a window in flight", async (t) => {
	const fake = fakeBackend();
	const WINDOW = 64 * 1024, CHUNK = 16 * 1024;
	const { client, server } = wire(t, fake.backend, { window: WINDOW });
	const c = open(client);
	await until(() => fake.conns.length === 1);
	const b = fake.conns[0]!;
	b.ev.onConnect();
	await until(() => c.connected);
	c.handle.pause(); // the stack's pause: it holds enough unsent data
	// A socket-like producer: it writes while it is not paused, and one more chunk is already on its way when pause() is called.
	let produced = 0;
	const produce = () => { b.ev.onData(new Uint8Array(CHUNK)); produced += CHUNK; };
	for (let i = 0; i < 100 && !b.paused; i++) { produce(); await tick(); }
	assert.ok(b.paused, "the backend was paused");
	produce();
	await tick();
	assert.ok(c.received <= WINDOW + CHUNK, `delivered ${c.received}`);
	assert.ok(produced <= WINDOW + 3 * CHUNK, `produced ${produced}`);
	const stalled = c.received;
	await tick();
	assert.equal(c.received, stalled, "nothing more is delivered while the consumer is paused");
	// The consumer catches up: what was held back arrives and the backend runs again.
	c.handle.resume();
	await until(() => !b.paused);
	assert.equal(c.received, produced);
	for (let i = 0; i < 20; i++) { produce(); await tick(); }
	await until(() => c.received === produced);
	assert.ok(b.pauses >= 1);
	client.close();
	server.close();
});

test("flow control towards the guest: a backend that ignores pause() is queued on the owner's side, not flooded into the worker", async (t) => {
	const fake = fakeBackend();
	const WINDOW = 32 * 1024;
	const { client, server } = wire(t, fake.backend, { window: WINDOW });
	const c = open(client);
	await until(() => fake.conns.length === 1);
	fake.conns[0]!.ev.onConnect();
	c.handle.pause();
	for (let i = 0; i < 40; i++) fake.conns[0]!.ev.onData(new Uint8Array(8192));
	fake.conns[0]!.ev.onEnd();
	await tick();
	assert.ok(c.received <= WINDOW + 8192, `delivered ${c.received}`);
	assert.ok(!c.events.includes("end"), "end waits behind the queued data");
	c.handle.resume();
	await until(() => c.events.includes("end"));
	assert.equal(c.received, 40 * 8192);
	client.close();
	server.close();
});

test("flow control from the guest: buffered counts bytes the backend still holds, and onDrain follows when it lets go", async (t) => {
	const fake = fakeBackend({ holdWrites: true }); // a slow backend: it holds what it was given
	const { client, server } = wire(t, fake.backend);
	const c = open(client);
	await until(() => fake.conns.length === 1);
	const b = fake.conns[0]!;
	b.ev.onConnect();
	c.handle.write(new Uint8Array(100_000));
	assert.equal(c.handle.buffered, 100_000, "counted at once");
	await until(() => b.writes.length === 1);
	await tick();
	assert.equal(c.handle.buffered, 100_000, "the backend has not drained: the stack's window stays shut");
	assert.equal(c.drains, 0);
	// It drains 60 000 bytes, then the rest.
	b.buffered = 40_000;
	b.ev.onDrain();
	await until(() => c.handle.buffered === 40_000);
	assert.equal(c.drains, 1);
	b.buffered = 0;
	b.ev.onDrain();
	await until(() => c.handle.buffered === 0);
	assert.equal(c.drains, 2);
	// A backend that takes writes at once (nothing left in its buffer) acknowledges them without a drain event.
	const quick = fakeBackend();
	const q = wire(t, quick.backend);
	const qc = open(q.client);
	await until(() => quick.conns.length === 1);
	quick.conns[0]!.ev.onConnect();
	qc.handle.write(new Uint8Array(500));
	await until(() => qc.handle.buffered === 0 && quick.conns[0]!.writes.length === 1);
	client.close();
	server.close();
});

test("closing the worker's end destroys every connection, closes the backend and the served port", async (t) => {
	const fake = fakeBackend();
	const { client, server, isServing } = wire(t, fake.backend);
	open(client);
	open(client);
	await until(() => fake.conns.length === 2);
	client.close();
	await until(() => fake.isClosed());
	assert.ok(fake.conns.every((c) => c.destroyed));
	await until(() => !isServing());
	server.close(); // idempotent
});

test("a worker that goes away without a word (the port closes) is handled like a close", async (t) => {
	const fake = fakeBackend();
	const { server, port2, isServing } = wire(t, fake.backend);
	const dead = portBackend(port2);
	open(dead);
	await until(() => fake.conns.length === 1);
	port2.close();
	await until(() => fake.isClosed());
	assert.equal(fake.conns[0]!.destroyed, true);
	await until(() => !isServing());
	server.close();
});

test("when the owner closes, the guest's connections fail and lookups reject", async (t) => {
	const fake = fakeBackend();
	const { client, server } = wire(t, fake.backend);
	const c = open(client);
	await until(() => fake.conns.length === 1);
	fake.conns[0]!.ev.onConnect();
	await until(() => c.connected);
	server.close();
	await until(() => c.closed);
	assert.match(c.error?.message ?? "", /port closed/);
	await assert.rejects(client.lookup("known.test"), /port closed/);
	const late = open(client);
	await until(() => late.closed);
	assert.ok(late.error);
});

test("the stack's TCP echo (300 KB, FIN both ways) works through a port in front of the direct backend", async (t) => {
	const inner = directBackend();
	const { client, server } = wire(t, inner);
	await echoTest(client);
	client.close();
	server.close();
});

test("the default window is 256 KiB", () => {
	assert.equal(NET_PORT_WINDOW, 256 * 1024);
});
