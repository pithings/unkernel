// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Unit tests for the SDK's user-mode network stack and its backends (direct
// sockets, Wisp), driven by synthetic guest frames.
//
//   node --test test/net.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import dgram from "node:dgram";
import { NetStack, UDP_IDLE_MS, ip4, ip4str, type NetBackend, type NetConnectionEvents, type NetDatagramEvents } from "../js/core/net.ts";
import { wispBackend } from "../js/core/net-wisp.ts";
import { fetchRoutes } from "../js/core/net-fetch.ts";
import { directBackend } from "../js/node/net.ts";
import { acceptWebSocket } from "./ws-server.ts";
import { GUEST, GUEST_MAC, collect, csum, echoTest, eth, ipv4, mkStack, tcp, udp, until, withWisp } from "./net-helpers.ts";

test("ARP for the gateway, none for the guest's own address", () => {
	const { stack, out } = mkStack({});
	const arp = (tip: string) => {
		const a = new Uint8Array(28);
		const dv = new DataView(a.buffer);
		dv.setUint16(0, 1); dv.setUint16(2, 0x0800); a[4] = 6; a[5] = 4; dv.setUint16(6, 1);
		a.set(GUEST_MAC, 8); dv.setUint32(14, GUEST); dv.setUint32(24, ip4(tip));
		return eth(0x0806, a, [255, 255, 255, 255, 255, 255]);
	};
	stack.send(arp("10.0.2.2"));
	stack.send(arp("10.0.2.15"));
	assert.equal(out.length, 1);
	assert.equal(out[0]!.dv.getUint16(20), 2);
	assert.deepEqual([...out[0]!.f.subarray(22, 28)], [0x52, 0x55, 10, 0, 2, 2]);
	assert.equal(ip4str(out[0]!.dv.getUint32(28)), "10.0.2.2");
});

test("DHCP discover gets an offer for 10.0.2.15 with router and DNS", () => {
	const { stack, out } = mkStack({});
	const p = new Uint8Array(244);
	p[0] = 1; p[1] = 1; p[2] = 6; p.set([1, 2, 3, 4], 4); p.set(GUEST_MAC, 28);
	new DataView(p.buffer).setUint32(236, 0x63825363);
	p.set([53, 1, 1, 255], 240);
	stack.send(udp(68, 0xffffffff, 67, p, 0));
	assert.equal(out.length, 1);
	const r = out[0]!;
	assert.equal(r.dport, 68);
	assert.equal(ip4str(r.dv.getUint32(34 + 8 + 16)), "10.0.2.15");
	const opts = [...r.payload.subarray(240)];
	assert.deepEqual(opts.slice(0, 3), [53, 1, 2]);
	const i = opts.indexOf(6);
	assert.deepEqual(opts.slice(i, i + 6), [6, 4, 10, 0, 2, 3]);
});

test("DNS A query is answered from the backend, AAAA is empty, failures map to rcodes", async () => {
	const { stack, out } = mkStack({
		lookup: async (n) => {
			if (n === "example.com") return ["93.184.215.14", "::1"];
			throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
		},
	});
	const q = (name: string, type: number, id: number) => {
		const parts = name.split(".").flatMap((l) => [l.length, ...new TextEncoder().encode(l)]);
		return Uint8Array.from([id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...parts, 0, 0, type, 0, 1]);
	};
	stack.send(udp(5353, ip4("10.0.2.3"), 53, q("example.com", 1, 7)));
	stack.send(udp(5353, ip4("10.0.2.3"), 53, q("example.com", 28, 8)));
	stack.send(udp(5353, ip4("10.0.2.3"), 53, q("nope.invalid", 1, 9)));
	await until(() => out.length === 3);
	const byId = Object.fromEntries(out.map((r) => [r.dv.getUint16(42), r]));
	const a = byId[7]!.payload;
	assert.equal(a[3]! & 15, 0);
	assert.equal(new DataView(a.buffer, a.byteOffset).getUint16(6), 1);
	assert.deepEqual([...a.subarray(a.length - 4)], [93, 184, 215, 14]);
	assert.equal(new DataView(byId[8]!.payload.buffer, byId[8]!.payload.byteOffset).getUint16(6), 0);
	assert.equal(byId[9]!.payload[3]! & 15, 3);
});

test("ping the gateway; UDP elsewhere gets port unreachable without a backend udp()", () => {
	const { stack, out } = mkStack({});
	const icmp = Uint8Array.from([8, 0, 0, 0, 0, 1, 0, 1, 1, 2, 3, 4]);
	new DataView(icmp.buffer).setUint16(2, csum(icmp, 0, icmp.length));
	stack.send(ipv4(1, GUEST, ip4("10.0.2.2"), icmp));
	stack.send(udp(1234, ip4("1.1.1.1"), 123, new Uint8Array(48)));
	assert.equal(out.length, 2);
	assert.equal(out[0]!.icmpType, 0);
	assert.equal(out[1]!.icmpType, 3);
});

/** A backend whose udp() records flows; `reply(i, data)` answers on flow i. */
function fakeUdp() {
	const flows: { host: string; port: number; sent: string[]; closed: boolean; ev: NetDatagramEvents }[] = [];
	const backend: Partial<NetBackend> = {
		udp({ host, port }, ev) {
			const fl = { host, port, sent: [] as string[], closed: false, ev };
			flows.push(fl);
			return { send: (d) => fl.sent.push(Buffer.from(d).toString()), close: () => { fl.closed = true; } };
		},
	};
	return { flows, backend };
}

test("UDP flows: one per guest port and remote, replies from the remote, local and broadcast destinations stay local", () => {
	const { flows, backend } = fakeUdp();
	const { stack, out } = mkStack(backend);
	const enc = (s: string) => new TextEncoder().encode(s);
	stack.send(udp(5000, ip4("1.1.1.1"), 123, enc("a")));
	stack.send(udp(5000, ip4("1.1.1.1"), 123, enc("b")));
	stack.send(udp(5001, ip4("1.1.1.1"), 123, enc("c")));
	stack.send(udp(5000, ip4("10.0.2.2"), 9999, enc("d"))); // the gateway: 127.0.0.1 (hostLoopback)
	assert.deepEqual(flows.map((f) => `${f.host}:${f.port} ${f.sent.join("")}`),
		["1.1.1.1:123 ab", "1.1.1.1:123 c", "127.0.0.1:9999 d"]);
	assert.equal(stack.stats.udpOpened, 3);
	assert.equal(out.length, 0);

	flows[0]!.ev.onMessage(enc("pong"));
	assert.equal(out.length, 1);
	const r = out.shift()!;
	assert.equal(r.proto, 17);
	assert.equal(ip4str(r.src!), "1.1.1.1");
	assert.equal(r.sport, 123);
	assert.equal(r.dst, GUEST);
	assert.equal(r.dport, 5000);
	assert.equal(Buffer.from(r.payload).toString(), "pong");

	// The subnet and the DNS address on another port: port unreachable, not the backend.
	stack.send(udp(5000, ip4("10.0.2.9"), 7, enc("x")));
	stack.send(udp(5000, ip4("10.0.2.3"), 7, enc("x")));
	assert.deepEqual(out.splice(0).map((p) => p.icmpType), [3, 3]);
	// Broadcast and multicast: dropped.
	stack.send(udp(5000, 0xffffffff, 7, enc("x")));
	stack.send(udp(5000, ip4("224.0.0.251"), 5353, enc("x")));
	assert.equal(out.length, 0);
	assert.equal(flows.length, 3);

	// A refused flow reaches the guest as ICMP port unreachable quoting its datagram.
	flows[1]!.ev.onClose(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
	const u = out.shift()!;
	assert.equal(u.icmpType, 3);
	assert.equal(u.f[35], 3, "port unreachable");
	assert.equal(ip4str(u.src!), "1.1.1.1");
	assert.equal(u.dv.getUint16(42 + 20), 5001, "quotes the guest's UDP header");
	assert.equal(stack.udp.size, 2);
	// The next datagram on that flow opens a new one.
	stack.send(udp(5001, ip4("1.1.1.1"), 123, enc("e")));
	assert.equal(flows.length, 4);

	stack.close();
	assert.ok(flows.every((f) => f.closed || f === flows[1]));
	assert.equal(stack.udp.size, 0);
	assert.equal(stack.udpSweep, null);
});

test("UDP flows: idle ones expire, the least recently used goes past the limit", () => {
	const { flows, backend } = fakeUdp();
	const { stack } = mkStack(backend);
	const x = new Uint8Array(1);
	stack.send(udp(6000, ip4("8.8.8.8"), 53, x));
	stack.send(udp(6001, ip4("8.8.8.8"), 53, x));
	stack.udp.get(`6000/${ip4("8.8.8.8")}/53`)!.lastActive -= UDP_IDLE_MS + 1;
	stack.udpExpire();
	assert.deepEqual(flows.map((f) => f.closed), [true, false]);

	for (let p = 6002; p < 6002 + 255; p++) stack.send(udp(p, ip4("8.8.8.8"), 53, x));
	assert.equal(stack.udp.size, 256);
	stack.send(udp(6001, ip4("8.8.8.8"), 53, x)); // touch the oldest: now the newest
	flows[2]!.ev.onMessage(x); // a reply counts too: port 6002 is the newest
	stack.send(udp(7000, ip4("8.8.8.8"), 53, x));
	assert.equal(stack.udp.size, 256);
	assert.equal(flows[1]!.closed, false);
	assert.equal(flows[2]!.closed, false);
	assert.equal(flows[3]!.closed, true, "port 6003 was the least recently used");
	stack.close();
});

test("UDP through the direct backend: an echo via the gateway, port unreachable from a closed port", async () => {
	const srv = dgram.createSocket("udp4");
	srv.on("message", (m, rinfo) => srv.send(m, rinfo.port, rinfo.address));
	await new Promise<void>((r) => srv.bind(0, "127.0.0.1", r));
	const port = srv.address().port;
	const b = directBackend();
	const { stack, out } = mkStack(b);
	const gw = ip4("10.0.2.2");
	const big = new Uint8Array(4000).map((_, i) => i & 255); // more than an MTU: one frame to the guest
	stack.send(udp(5353, gw, port, new TextEncoder().encode("hello")));
	stack.send(udp(5353, gw, port, big));
	await until(() => out.length === 2);
	assert.equal(Buffer.from(out[0]!.payload).toString(), "hello");
	assert.deepEqual(out[1]!.payload, big);
	assert.ok(out.every((r) => r.src === gw && r.sport === port && r.dport === 5353));

	const closed = dgram.createSocket("udp4");
	await new Promise<void>((r) => closed.bind(0, "127.0.0.1", r));
	const dead = closed.address().port;
	await new Promise<void>((r) => closed.close(r));
	// The host reports the refusal once a datagram has drawn the ICMP error.
	for (let i = 0; i < 20 && !out.some((r) => r.icmpType === 3); i++) {
		stack.send(udp(5354, gw, dead, new Uint8Array(1)));
		await new Promise((r) => setTimeout(r, 25));
	}
	const u = out.find((r) => r.icmpType === 3);
	assert.ok(u, "ICMP port unreachable");
	assert.equal(u.f[35], 3);

	// Node's connect() throws for port 0: the flow closes with the error instead.
	let err: Error | null = null;
	b.udp!({ host: "127.0.0.1", port: 0 }, { onMessage() {}, onClose(e) { err = e; } }).send(new Uint8Array(1));
	assert.equal((err as { code?: string } | null)?.code, "ERR_SOCKET_BAD_PORT");
	stack.close();
	b.close!();
	srv.close();
});

test("UDP through Wisp: a stream per flow, a packet per datagram, a refused one is port unreachable", async () => {
	await withWisp(async (b, seen) => {
		const { stack, out } = mkStack(b);
		const [ip] = await b.lookup("echo.test");
		const enc = (s: string) => new TextEncoder().encode(s);
		// More datagrams than the TCP credit (2), in one tick: no coalescing, no waiting for CONTINUE.
		for (const s of ["one", "two", "three", "four"]) stack.send(udp(4000, ip4(ip!), 4242, enc(s)));
		await until(() => out.length === 4);
		assert.deepEqual(out.map((r) => Buffer.from(r.payload).toString()), ["one", "two", "three", "four"]);
		assert.deepEqual(seen.hosts, ["udp:echo.test:4242"]);
		assert.equal(seen.packets, 4);

		out.length = 0;
		stack.send(udp(4001, ip4("192.0.2.1"), 53, enc("q")));
		await until(() => out.length === 1);
		assert.equal(out[0]!.icmpType, 3);
		stack.close();
	});
});

test("fetchRoutes: UDP to a routed name is refused, other UDP goes to the inner backend", async () => {
	const { flows, backend } = fakeUdp();
	const fr = fetchRoutes(backend as NetBackend, { "mirror.test": "https://example.invalid/" });
	assert.ok(fr.udp);
	const [routed] = await fr.lookup("mirror.test");
	const err = await new Promise<Error | null>((res) => fr.udp!({ host: routed!, port: 80 }, { onMessage() {}, onClose: res }));
	assert.equal((err as Error & { code?: string }).code, "ECONNREFUSED");
	fr.udp({ host: "1.1.1.1", port: 53 }, { onMessage() {}, onClose() {} });
	assert.deepEqual(flows.map((f) => `${f.host}:${f.port}`), ["1.1.1.1:53"]);
	assert.equal(fetchRoutes(undefined, {}).udp, undefined, "no inner udp(), no udp()");
});

test("UDP flows that fail the same way are logged once", () => {
	const logs: string[] = [];
	const backend: Partial<NetBackend> = { udp(_a, ev) { ev.onClose(new Error("down")); return { send() {}, close() {} }; } };
	const stack = new NetStack({ backend: backend as NetBackend, log: (m) => logs.push(m) });
	stack.output = () => {};
	for (let p = 5000; p < 5010; p++) stack.send(udp(p, ip4("1.1.1.1"), 53, new Uint8Array(1)));
	assert.deepEqual(logs, ["[net] udp 1.1.1.1:53: down"]);
	assert.equal(stack.udp.size, 0);
});

test("ping beyond the gateway goes to backend.ping; without one it is prohibited", async () => {
	const echo = (seq: number) => {
		const icmp = Uint8Array.from([8, 0, 0, 0, 0x12, 0x34, 0, seq, 9, 8, 7, 6, 5]);
		new DataView(icmp.buffer).setUint16(2, csum(icmp, 0, icmp.length));
		return icmp;
	};
	const asked: Array<[string, number]> = [];
	const { stack, out } = mkStack({
		ping: async (host, ms) => { asked.push([host, ms]); return host === "192.0.2.1"; },
	});
	stack.send(ipv4(1, GUEST, ip4("192.0.2.1"), echo(1)));
	stack.send(ipv4(1, GUEST, ip4("192.0.2.9"), echo(2)));
	stack.send(ipv4(1, GUEST, ip4("10.0.2.15"), echo(3)));     // the guest itself
	stack.send(ipv4(1, GUEST, ip4("224.0.0.1"), echo(4)));     // multicast
	await until(() => asked.length === 2 && stack.pings === 0);
	assert.deepEqual(asked.map(([h]) => h), ["192.0.2.1", "192.0.2.9"]);
	assert.ok(asked[0]![1] > 0);
	assert.equal(out.length, 1, "one reply; no answer, no frame");
	const r = out[0]!;
	assert.equal(r.icmpType, 0);
	assert.equal(ip4str(r.src!), "192.0.2.1");
	assert.equal(r.dst, GUEST);
	assert.deepEqual([...r.f.subarray(38)], [0x12, 0x34, 0, 1, 9, 8, 7, 6, 5], "id, sequence and data");

	const rejecting = mkStack({ ping: () => Promise.reject(new Error("no")) });
	rejecting.stack.send(ipv4(1, GUEST, ip4("192.0.2.1"), echo(5)));
	await until(() => rejecting.stack.pings === 0);
	assert.equal(rejecting.out.length, 0);

	const none = mkStack({});
	none.stack.send(ipv4(1, GUEST, ip4("192.0.2.1"), echo(6)));
	assert.equal(none.out.length, 1);
	const u = none.out[0]!;
	assert.equal(u.icmpType, 3);
	assert.equal(u.f[35], 13, "administratively prohibited");
	assert.equal(ip4str(u.src!), "10.0.2.2");
	assert.equal(ip4str(u.dv.getUint32(42 + 16)), "192.0.2.1", "quotes the request");
	assert.equal(u.dv.getUint16(42 + 20 + 6), 6, "and its sequence");
});

test("ping in flight through the backend is capped", async () => {
	const waiting: Array<(ok: boolean) => void> = [];
	const { stack, out } = mkStack({ ping: () => new Promise<boolean>((r) => waiting.push(r)) });
	const icmp = Uint8Array.from([8, 0, 0, 0, 0, 1, 0, 1]);
	new DataView(icmp.buffer).setUint16(2, csum(icmp, 0, icmp.length));
	for (let i = 0; i < 100; i++) stack.send(ipv4(1, GUEST, ip4("192.0.2.1"), icmp));
	assert.equal(waiting.length, 64);
	for (const w of waiting) w(true);
	await until(() => out.length === 64 && stack.pings === 0);
});

test("TCP to a refused port gets RST; unknown segment gets RST", async () => {
	const { stack, out } = mkStack(directBackend());
	const srv = createServer();
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as AddressInfo).port;
	srv.close();
	await new Promise((r) => srv.on("close", r));
	stack.send(tcp(40000, ip4("10.0.2.2"), port, 100, 0, 2));
	await until(() => out.length === 1);
	assert.equal(out[0]!.flags, 4 | 16);
	assert.equal(out[0]!.ack, 101);
	stack.send(tcp(40001, ip4("10.0.2.2"), port, 5, 77, 16));
	assert.equal(out[1]!.flags, 4);
	assert.equal(out[1]!.seq, 77);
});

test("TCP echo through the direct backend: handshake, data both ways, close", async () => {
	await echoTest(directBackend());
});

test("TCP retransmits unacknowledged data after the RTO and respects the guest window", async () => {
	let ev!: NetConnectionEvents;
	const fake: Partial<NetBackend> = {
		connect(_, e) {
			ev = e;
			queueMicrotask(() => e.onConnect());
			return { write() {}, end() {}, destroy() {}, pause() {}, resume() {}, buffered: 0 };
		},
	};
	const { stack, out } = mkStack(fake);
	const dst = ip4("93.184.215.14");
	// No window scaling; the guest advertises 65535 but only acks the SYN.
	stack.send(tcp(40005, dst, 80, 1, 0, 2, undefined, [2, 4, 0x05, 0xb4]));
	await until(() => out.length === 1);
	const iss = out.shift()!.seq!;
	stack.send(tcp(40005, dst, 80, 2, iss + 1, 16));
	ev.onData(new Uint8Array(100 * 1024).fill(1));
	// 65535 bytes of window = 44 full segments + 1 partial.
	const first = out.splice(0);
	const sent = first.reduce((n, r) => n + r.payload.length, 0);
	assert.equal(sent, 65535);
	await until(() => out.length > 0, 2500);
	assert.equal(out[0]!.seq, iss + 1, "go back N from snd_una");
	out.splice(0);
	stack.close();
});

test("Wisp backend: fake DNS, flow-controlled writes, clean and refused closes", async () => {
	await withWisp(async (b, seen) => {
		const [ip] = await b.lookup("echo.test");
		assert.match(ip!, /^198\.1[89]\./);
		assert.deepEqual(await b.lookup("echo.test"), [ip], "stable mapping");
		assert.deepEqual(await b.lookup("1.2.3.4"), ["1.2.3.4"]);

		const c = collect(b, ip!, 7);
		// Writes in separate ticks are separate packets: more than the credit of 2.
		const parts = ["a", "b", "c", "d", "e", "bye"];
		for (const p of parts) { c.h.write(new TextEncoder().encode(p)); await new Promise((r) => setTimeout(r, 5)); }
		assert.equal(await c.closed, null);
		assert.equal(c.data, parts.join(""));
		assert.equal(c.h.buffered, 0);
		assert.deepEqual(seen.hosts, ["echo.test:7"]);

		const [bad] = await b.lookup("nope.test");
		const r = collect(b, bad!, 80);
		assert.match((await r.closed)!.message, /connection refused/);
	});
});

test("Wisp backend: the fake address table evicts the least recently used name; a lookup option replaces it", async () => {
	const b = wispBackend("ws://127.0.0.1:1/");
	const [first] = await b.lookup("n0.test");
	const [second] = await b.lookup("n1.test");
	for (let i = 2; i < (1 << 17) - 1; i++) await b.lookup(`n${i}.test`);   // the table is full
	assert.deepEqual(await b.lookup("n0.test"), [first], "used again: kept");
	assert.deepEqual(await b.lookup("new.test"), [second], "n1, the oldest, gives up its address");
	assert.deepEqual(await b.lookup("n0.test"), [first]);
	assert.notDeepEqual(await b.lookup("n1.test"), [second]);
	b.close();

	const real = wispBackend("ws://127.0.0.1:1/", {
		lookup: async (n) => { if (n === "known.test") return ["192.0.2.7"]; throw Object.assign(new Error(n), { code: "ENOTFOUND" }); },
	});
	assert.deepEqual(await real.lookup("known.test"), ["192.0.2.7"]);
	assert.deepEqual(await real.lookup("1.2.3.4"), ["1.2.3.4"]);
	await assert.rejects(real.lookup("nope.test"), { code: "ENOTFOUND" });
	real.close();
});

test("no Wisp server: TCP is reset", async () => {
	const b = wispBackend("ws://127.0.0.1:1/");
	const { stack, out } = mkStack(b);
	stack.send(tcp(40005, ip4("93.184.215.14"), 80, 100, 0, 2));
	await until(() => out.length === 1);
	assert.equal(out[0]!.flags, 4 | 16);
});

test("Wisp backend races several servers: a silent one loses", async () => {
	// Accepts the WebSocket but never sends the handshake CONTINUE.
	const silent = createHttpServer();
	silent.on("upgrade", (req, socket, head) => acceptWebSocket(req, socket, head, () => {}, () => {}));
	await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
	try {
		await withWisp(async (_b, _seen, url) => {
			const logs: string[] = [];
			const b = wispBackend([`ws://127.0.0.1:${(silent.address() as AddressInfo).port}/`, "ws://127.0.0.1:1/", url], { log: (m) => logs.push(m) });
			const [ip] = await b.lookup("echo.test");
			const c = collect(b, ip!, 9);
			c.h.write(new TextEncoder().encode("hi bye"));
			assert.equal(await c.closed, null);
			assert.equal(c.data, "hi bye");
			assert.ok(logs.some((m) => m.includes(`wisp connected: ${url}`)), logs.join("\n"));
			b.close();
		});
	} finally {
		silent.closeAllConnections();
		silent.close();
	}
});

test("Wisp backend: close() during the handshake gives up at once", async () => {
	const silent = createHttpServer();
	silent.on("upgrade", (req, socket, head) => acceptWebSocket(req, socket, head, () => {}, () => {}));
	await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
	try {
		const b = wispBackend(`ws://127.0.0.1:${(silent.address() as AddressInfo).port}/`);
		const c = collect(b, "1.2.3.4", 80);
		await new Promise((r) => setTimeout(r, 100));
		const t0 = Date.now();
		b.close();
		assert.match((await c.closed)!.message, /unavailable/);
		assert.ok(Date.now() - t0 < 2000, "no wait for the handshake timeout");
	} finally {
		silent.closeAllConnections();
		silent.close();
	}
});

test("Wisp handshake headers: none by default, `headers` sent as given", async () => {
	const origins: Array<string | undefined> = [];
	const srv = createHttpServer();
	srv.on("upgrade", (req, socket) => { origins.push(req.headers.origin); socket.destroy(); });
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const url = `ws://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
	try {
		for (const b of [wispBackend(url), wispBackend(url, { headers: { Origin: "http://127.0.0.1:8080" } })]) {
			await assert.rejects(b.lookup("example.com").then(() => collect(b, "198.18.0.1", 80).closed.then((e) => { throw e; })));
			b.close();
		}
		assert.deepEqual(origins, [undefined, "http://127.0.0.1:8080"]);
	} finally {
		srv.closeAllConnections();
		srv.close();
	}
});
