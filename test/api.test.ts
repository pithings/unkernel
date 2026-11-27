// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The public createKernel() API on the bundled kernel (unkernel.wasm), inline
// and (where marked) also with `worker: true`, whose input and frames go
// through shared memory on Node unless `shared: false` (marked "worker,
// messages"). Most tests boot it without a distro, into the base
// shell (busybox and the kw tools); those marked "Alpine" boot the Alpine
// image and skip when it is not built.
//
//   node --test test/api.test.ts                       # from source (js/node.ts)
//   UNKERNEL_DIST=1 node --test test/api.test.ts       # the built package ("unkernel" -> dist/)
//   UNKERNEL_TEST_WISP=1 ...                           # also the default Wisp server (internet)
//   UNKERNEL_TEST_KERNEL=path ...                      # another bundle instead of the bundled kernel
//   UNKERNEL_TEST_DISTRO_DIR=dir ...                   # where alpine.erofs is (default vendor/build/distro)
//   UNKERNEL_TEST_CPUS=n ...                           # CPUs for an SMP kernel under test (the bundle's SMP kernel for n > 1)
//   UNKERNEL_TEST_CONCURRENCY=n ...                    # tests at once (default: the number of cores; 1 = in order)
//
// The tests run concurrently, each kernel stopped by its own test's cleanup. A
// suite marked "one kernel" boots once and runs its tests in order on it.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const spec = process.env.UNKERNEL_DIST ? "unkernel" : "../js/node.ts";
const sdk: typeof import("../js/node.ts") = await import(spec);
const { createKernel, ConsoleRouter, NetStack, directBackend, wispBackend, DEFAULT_WISP_SERVERS, FileDisk, bundledBoot, bundledKernelUrl, createImageFromKwsparse, MemoryFs, nodeFs } = sdk;
type Instance = Awaited<ReturnType<typeof createKernel>>;
/** The kernel under test: UNKERNEL_TEST_KERNEL (a bundle, e.g. from a build of your own), else the bundled one. */
const testKernel = process.env.UNKERNEL_TEST_KERNEL ? path.resolve(process.env.UNKERNEL_TEST_KERNEL) : undefined;
const kernelFile = testKernel ?? fileURLToPath(bundledKernelUrl);
/** UNKERNEL_TEST_CPUS: CPUs to offer an SMP kernel under test. */
const testCpus = Number(process.env.UNKERNEL_TEST_CPUS) || undefined;
/** Kernel messages a restored machine must not show (a WARN, an RCU stall, an idle state out of balance, a hung task). */
const KERNEL_TROUBLE = "WARNING|BUG|INFO: rcu| stall|not watching|blocked for more|Oops|Call trace|NOHZ";
/** The kernel under test compiled once by the test (a Module skips the SMP patch, so this applies it for UNKERNEL_TEST_CPUS > 1). */
const compileTestKernel = () => sdk.loadKernelModule(readFileSync(kernelFile), { smp: (testCpus ?? 1) > 1 });

/** The shell prompts: the base shell's (guest/base/initramfs/etc/profile), Alpine's (guest/distro/alpine/rootfs). */
const PROMPT = /base\x1b\[0m \S* # |⇒/;
const CONCURRENCY = Number(process.env.UNKERNEL_TEST_CONCURRENCY) || availableParallelism();

/** Does the kernel under test have kwvsock (net/vmw_vsock/kwvsock.c) and kwshm (drivers/misc/kwshm.c)? */
const kernelBytes = readFileSync(kernelFile);
/** The Alpine image for the tests that need a distro (erofs if the kernel has it, else ext4), or a reason to skip them. */
const distroDir = path.resolve(process.env.UNKERNEL_TEST_DISTRO_DIR ?? fileURLToPath(new URL("../vendor/build/distro/", import.meta.url)));
const alpine = (kernelBytes.includes("cannot find valid erofs superblock") ? ["erofs", "ext4"] : ["ext4", "erofs"])
	.map((f) => path.join(distroDir, `alpine.${f}`)).find((f) => existsSync(f));
const noAlpine = !alpine && `no ${path.join(distroDir, "alpine.erofs")} (kernel/build.sh distro alpine)`;
const kernelModule = await WebAssembly.compile(kernelBytes);
const kernelImports = WebAssembly.Module.imports(kernelModule);
/** 9p adds no import; its client's version string is in the kernel only with NET_9P (kw_defconfig). */
const kernelHas9p = kernelBytes.includes("9P2000.L");
const kernelHasVsock = kernelImports.some((i) => i.name === "wasm_driver_vsock_init");
const kernelHasShm = kernelImports.some((i) => i.name === "wasm_driver_shm_init");
/** Was kwemu built with its JIT tier (kw_host_jit_*)? kernel/build.sh builds it unless KWEMU_JIT=0 (.agents/a64/jit.md). */
const kernelHasJit = kernelImports.some((i) => i.name === "kw_host_jit_caps");
/** Does the bundle carry the SMP kernel (its patch; kernel.md, Two kernels)? */
const hasSmpPatch = WebAssembly.Module.customSections(kernelModule, "unkernel.kernel.smp.kwpatch").length > 0;

type BootOptions = NonNullable<Parameters<typeof createKernel>[0]>;
// A failed assertion must not leave a kernel running (it would keep the test process alive).
// Each test stops its own kernels: a shared afterEach would stop the kernels of tests still running.
const boot = async (t: { after(fn: () => unknown): void }, opts: BootOptions) => {
	const vm = await createKernel({ kernel: testKernel, cpus: testCpus, ...opts });
	t.after(() => vm.stop({ reason: "test cleanup" }));
	return vm;
};
/** One kernel for the tests of the calling suite, which then run in order on it; stopped when the suite ends. */
function sharedKernel(opts: () => BootOptions) {
	const k = {} as { vm: Instance } & ReturnType<typeof screen>;
	before(async () => {
		k.vm = await createKernel({ kernel: testKernel, cpus: testCpus, ...opts() });
		Object.assign(k, screen(k.vm));
	});
	after(async () => { await k.vm?.stop({ reason: "test cleanup" }); });
	return k;
}
const MODES = [{ worker: false, name: "inline" }, { worker: true, name: "worker" }] as const;
/** Also worker mode with messages for console and evdev input and frames (the transport of a browser page that is not cross-origin isolated). */
const TRANSPORTS = [
	{ worker: false, shared: undefined, name: "inline", transport: "inline" },
	{ worker: true, shared: undefined, name: "worker", transport: "shared" },
	{ worker: true, shared: false, name: "worker, messages", transport: "messages" },
] as const;

/** Collects console text and lets a test wait for a pattern. */
function screen(vm: Instance) {
	const dec = new TextDecoder();
	const s = { text: "" };
	let exit: string | undefined;
	void vm.exited.then((r) => { exit = r.reason; });
	const reader = vm.output.getReader();
	void (async () => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			s.text += dec.decode(value, { stream: true });
		}
	})();
	const waitFor = async (re: RegExp, from = 0, ms = 60000) => {
		const end = Date.now() + ms;
		while (!re.test(s.text.slice(from))) {
			if (Date.now() > end) throw new Error(`timeout waiting for ${re}; screen tail:\n${s.text.slice(-1500)}`);
			if (exit !== undefined) throw new Error(`kernel exited (${exit}) waiting for ${re}`);
			await new Promise((r) => setTimeout(r, 50));
		}
	};
	return { s, waitFor };
}

describe("api", { concurrency: CONCURRENCY }, () => {
	// Powering off with exit code 0 is checked by the display, data disk, jit and device tests.
	for (const { worker, shared, name, transport } of TRANSPORTS) describe(`createKernel() with no devices, one kernel (${spec}, ${name})`, { concurrency: 1 }, () => {
		const stages: string[] = [], kernelLines: string[] = [];
		let user = "", userspace = "";
		const router = new ConsoleRouter({
			onKernelLine: (line) => kernelLines.push(line),
			onUserOutput: (t) => { user += t; },
			onUserspace: (why) => { userspace = why; },
		});
		const k = sharedKernel(() => ({
			worker, shared, log: () => {}, onProgress: (p) => stages.push(p.stage),
			onOutput: (b) => router.write(b), consoleSize: { cols: 100, rows: 30 },
		}));

		test("boots the bundled kernel's base shell without a network and runs a command", async () => {
			const { vm, s, waitFor } = k;
			assert.equal(vm.transport, transport);
			assert.equal("kernel" in vm, !worker, "the low-level kernel only inline");
			assert.equal(vm instanceof sdk.WorkerKernel, worker);
			assert.equal(vm.memoryMiB, 2048);
			assert.equal(vm.memory64, false);
			assert.ok(stages.includes("compiled") && stages.includes("memory") && stages.at(-1) === "start", stages.join(","));
			assert.match(vm.cmdline, /rdinit=/);
			await waitFor(PROMPT);
			assert.match(s.text, /Linux version/, "the stream starts at the first byte");
			const at = s.text.length;
			vm.write("uname -m; nproc; ls /sys/class/net | cat\n");
			await waitFor(new RegExp(`aarch64[\\s\\S]*(?:${PROMPT.source})`), at);
			const out = s.text.slice(at);
			// stats().cpus: the CPUs the kernel got, which the guest sees (UNKERNEL_TEST_CPUS on an SMP kernel).
			const cpus = vm.stats().cpus;
			assert.equal(cpus, testCpus ?? 1);
			assert.match(out, new RegExp(`aarch64\\r?\\n${cpus}\\r?\\n`), "the guest's nproc is stats().cpus");
			assert.match(out, /\blo\b/);
			assert.doesNotMatch(out, /\beth0\b/, "no network device unless one is passed");
			assert.ok(vm.vsock, "a vsock device by default");
			assert.equal(vm.shm, undefined, "no shm device unless asked for");
		});

		test("ConsoleRouter splits kernel lines from user output; consoleSize, resize(), input stream", async () => {
			const { vm, s, waitFor } = k;
			let at = s.text.length;
			vm.write("stty size; echo marker-$((6*7))\n");
			await waitFor(/marker-42/, at);
			at = s.text.length;
			vm.resize(120, 40);
			const w = vm.input.getWriter();
			await w.write("stty size; echo resized-$((6*7))\n");
			w.releaseLock();
			await waitFor(/40 120[\s\S]*resized-42/, at);
			assert.ok(kernelLines.some((l) => /Linux version/.test(l)), "kernel log routed as kernel lines");
			assert.ok(!/Linux version/.test(user), "no kernel log in the user output");
			assert.match(user, /30 100/, "console size from consoleSize");
			assert.match(user, /marker-42/);
			assert.ok(userspace, "onUserspace fired");
		});

		// Four processes (spread over the CPUs of an SMP kernel at fork) print
		// 200 lines in turn, passing a token through FIFOs (each held open
		// read-write by its reader, so a token is never lost to a writer that
		// has not closed yet): the host must see them in that order (the
		// console ring, console-ring.ts).
		test("lines printed in turn by several processes arrive in order", async () => {
			const { vm, s, waitFor } = k;
			const at = s.text.length;
			vm.write("cd /tmp && mkfifo t0 t1 t2 t3 && for c in 0 1 2 3; do (exec 3<>t$c; i=$c; while [ $i -lt 200 ]; do read x <&3; echo ord-$i; i=$((i+4)); " +
				"[ $((i-3)) -lt 200 ] && echo > t$(((c+1)%4)); done) & done; echo > t0; wait; rm t0 t1 t2 t3; cd; echo ord-end-$((6*7))\n");
			await waitFor(/ord-end-42/, at);
			const got = [...s.text.slice(at).matchAll(/^ord-(\d+)\r?$/gm)].map((m) => Number(m[1]));
			assert.deepEqual(got, Array.from({ length: 200 }, (_, i) => i));
		});

		// The device not offered: the guest has no /dev/kwshm.
		if (!worker && kernelHasShm) test("shm: no /dev/kwshm without the option", async () => {
			const { vm, s, waitFor } = k;
			const at = s.text.length;
			vm.write("kwbox shm memfd 4096 < /dev/null; echo rc=$?\n");
			await waitFor(/rc=\d/, at);
			assert.match(s.text.slice(at), /kwshm: open \/dev\/kwshm: No such device[\s\S]*rc=1/);
		});

		test("stop() ends a running kernel", async () => {
			const { vm } = k;
			const res = await vm.stop({ reason: "test over" });
			assert.equal(res.kind, "stopped");
			assert.equal(res.reason, "test over");
			const st = vm.stats();
			assert.ok(st.switches > 0 && st.uptimeMs > 0 && st.compileMs > 0, JSON.stringify(st));
			assert.ok(st.jit.enabled, "JIT on by default");
			assert.equal(await vm.sync(), true, "sync() after the exit: nothing to flush");
		});
	});

	test("worker mode: exit codes (restart, panic), an AbortSignal stops it", async (t) => {
		await Promise.all([
			(async () => {
				const vm = await boot(t, { worker: true, log: () => {} });
				await screen(vm).waitFor(PROMPT);
				vm.write("reboot\n");
				assert.deepEqual(await vm.exited.then((r) => [r.code, r.kind]), [2, "halt"]);
			})(),
			// init exits at once: the kernel panics (253).
			(async () => {
				const vm = await boot(t, { worker: true, log: () => {}, cmdline: "console=hvc0 rdinit=/bin/true" });
				assert.equal(vm.cmdline, "console=hvc0 rdinit=/bin/true");
				assert.deepEqual(await vm.exited.then((r) => [r.code, r.kind]), [253, "panic"]);
			})(),
			(async () => {
				const ac = new AbortController();
				const vm = await boot(t, { worker: true, log: () => {}, signal: ac.signal });
				await screen(vm).waitFor(PROMPT);
				ac.abort();
				assert.deepEqual(await vm.exited.then((r) => [r.code, r.reason]), [130, "aborted"]);
			})(),
		]);
	});

	test("worker mode: the kernel from a relative path, bytes or a Module; an initrd from bytes", async (t) => {
		const file = kernelFile;
		const bytes = new Uint8Array(readFileSync(file));
		const module = await WebAssembly.compile(bytes);
		const panics = { cmdline: "console=hvc0 rdinit=/bin/true", log: () => {} };
		await Promise.all([
			...[path.relative(process.cwd(), file), bytes, module].map(async (kernel) => {
				const vm = await boot(t, { worker: true, kernel, ...panics });
				assert.equal((await vm.exited).code, 253, `kernel from ${kernel.constructor.name}`);
			}),
			// compileInWorker: the worker loads and compiles it (its progress is forwarded).
			...[path.relative(process.cwd(), file), bytes].map(async (kernel) => {
				const stages: string[] = [];
				const vm = await boot(t, { worker: true, compileInWorker: true, kernel, ...panics, onProgress: (p) => stages.push(p.stage) });
				assert.equal((await vm.exited).code, 253, `compileInWorker, kernel from ${kernel.constructor.name}`);
				assert.ok(stages.indexOf("worker") < stages.indexOf("compiled") && vm.stats().compileMs > 0, stages.join(","));
			}),
			// The bundled root fs as an explicit initrd: same boot.
			(async () => {
				const initrd = bundledBoot(module).initrd!;
				const vm = await boot(t, { worker: true, kernel: module, initrd, cmdline: "console=hvc0 rdinit=/init", log: () => {} });
				await screen(vm).waitFor(PROMPT);
				vm.write("poweroff\n");
				assert.equal((await vm.exited).code, 0);
			})(),
			assert.rejects(createKernel({ worker: true, kernel: "/nonexistent/kernel.wasm", log: () => {} }),
				(e: Error) => e.name === "BootError" && (e as InstanceType<typeof sdk.BootError>).stage === "download" && /nonexistent/.test(e.message)),
		]);
		assert.equal(bytes.byteLength, readFileSync(file).byteLength, "the caller's bytes are not detached");
	});

	test("worker mode rejects device objects (naming the spec instead)", async (t) => {
		const disk = { size: 1 << 20, read: () => {} } as unknown as import("../js/node.ts").BlockDevice;
		await assert.rejects(createKernel({ worker: true, disks: [{ kind: "file", path: "/nonexistent" }, disk] }), (e: Error) =>
			e.name === "BootError" && /disks\[1\] is a BlockDevice object, which cannot cross to the worker; pass a spec instead: \{ kind: "file", path \}/.test(e.message));
		await assert.rejects(createKernel({ worker: true, net: directBackend() }), (e: Error) =>
			e.name === "BootError" && /net is a NetDevice or NetBackend object.*\{ kind: "net", backend: \{ kind: "direct" \} \}/.test(e.message));
		// A spec of a kind nobody registered, and a spec that cannot be built.
		await assert.rejects(createKernel({ worker: true, disks: [{ kind: "nope" } as never], log: () => {} }), (e: Error) =>
			e.name === "BootError" && /disk kind "nope" is not available on this platform/.test(e.message));
		await assert.rejects(createKernel({ worker: true, disks: [{ kind: "file", path: "/nonexistent/disk.img" }], log: () => {} }), (e: Error) =>
			e.name === "BootError" && /disk 0 \(file\): .*ENOENT/.test(e.message));
		// Empty or off is fine (and the boot is real).
		const vm = await boot(t, { worker: true, disks: [], display: false, sound: false, cmdline: "console=hvc0 rdinit=/bin/true", log: () => {} });
		assert.equal((await vm.exited).code, 253);
	});

	for (const { worker, shared, name } of TRANSPORTS) test(`display, evdev and sound: glimmer --test draws a frame of the size offered, reads a key, plays PCM; mode changes reported (Alpine, ${name})`, { skip: noAlpine }, async (t) => {
		type Mode = { width: number; height: number; stride: number } | null;
		const modes: Mode[] = [], inputs: string[] = [], events: string[] = [];
		const chunks: Array<{ rate: number; channels: number; format: number; frames: number }> = [];
		let size = { width: 320, height: 240 };
		const vm = await boot(t, {
			worker, shared, log: () => {}, distro: alpine!, // glimmer comes with the distro images
			display: () => size,
			onDisplay: (m) => modes.push(m && { width: m.width, height: m.height, stride: m.stride }),
			onInput: (st) => inputs.push(`${+st.keyboard}${+st.mouse}${+st.tablet}`),
			sound: {
				rate: 48000,
				onState: (_st, ev) => events.push(ev),
				onChunk: (c) => { chunks.push({ rate: c.format.rate, channels: c.format.channels, format: c.format.format, frames: c.frames }); return 0; },
			},
		});
		const { s, waitFor } = screen(vm);
		await waitFor(PROMPT);
		// Nothing is open before a program opens a device: an in-kernel input handler that opens the
		// keyboard (sysrq did, before it became a passive observer) would send every key to evdev.
		assert.deepEqual(vm.evdev!.state, { keyboard: false, mouse: false, tablet: false }, inputs.join(","));
		assert.equal(inputs.length, 0, `no open reported at boot: ${inputs.join(",")}`);
		let at = s.text.length;
		vm.write("glimmer --test 2\n");
		await waitFor(/glimmer: test ready/, at);
		assert.deepEqual(modes, [{ width: 320, height: 240, stride: 1280 }]);
		assert.deepEqual(vm.display?.mode && { w: vm.display.mode.width, h: vm.display.mode.height }, { w: 320, h: 240 });
		const f = await vm.readFrame();
		assert.ok(f, "a frame while glimmer holds the picture");
		assert.deepEqual([f.width, f.height, f.data.length], [320, 240, 320 * 240 * 4]);
		const px = (x: number, y: number) => [...f.data.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 4)];
		assert.deepEqual([px(0, 0), px(4, 4), px(315, 4), px(4, 235)], [[255, 255, 255, 255], [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]], "glimmer's test pattern, as RGBA");
		assert.deepEqual(vm.frame()?.data, f.data, "frame() has the same picture");
		// The keyboard is open once glimmer listed the devices: a key press and release reach it.
		const ev = vm.evdev!;
		assert.ok(ev.keyboardOpen && ev.tabletOpen && inputs.at(-1)?.startsWith("1"), inputs.join(","));
		assert.equal(ev.key(30, true), true);
		assert.equal(ev.key(30, false), true);
		assert.equal(ev.key(31, false), false, "a release of a key the guest never saw");
		await waitFor(/glimmer: event event\d+ EV_KEY 30 1[\s\S]*EV_KEY 30 0/, at);
		await waitFor(/glimmer: test sound done/, at, 30000);
		await waitFor(PROMPT, s.text.length - 200);
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(modes.at(-1), null, "the close is reported");
		assert.deepEqual(ev.state, { keyboard: false, mouse: false, tablet: false }, inputs.join(","));
		assert.equal(ev.moveTo(0.5, 0.5), false, "no motion while nothing reads the tablet");
		assert.equal(ev.key(30, true), false, "no presses while nothing reads the keyboard");
		assert.deepEqual([...new Set(chunks.map((c) => `${c.rate}/${c.channels}/${c.format}`))], ["22050/2/2"], "the test signal: 22050 Hz, stereo, S16_LE");
		assert.equal(chunks.reduce((n, c) => n + c.frames, 0), 66150, "3 s of it");
		assert.deepEqual([events[0], events.at(-1)], ["open", "close"], events.join(","));
		assert.ok(events.includes("prepare") && events.includes("start"), events.join(","));
		assert.equal(vm.sound?.state.open, false);
		// Another size offered: the next program gets it (worker mode: sent ahead, the kernel cannot ask this thread).
		size = { width: 400, height: 300 };
		if (vm instanceof sdk.WorkerKernel) vm.updateDisplaySize();
		at = s.text.length;
		vm.write("glimmer --test 1 --no-sound\n");
		await waitFor(/glimmer: test done/, at);
		await waitFor(PROMPT, s.text.length - 200);
		await new Promise((r) => setTimeout(r, 300));
		assert.deepEqual(modes.slice(-2), [{ width: 400, height: 300, stride: 1600 }, null]);
		vm.write("poweroff\n");
		const res = await vm.exited;
		assert.deepEqual({ code: res.code, kind: res.kind }, { code: 0, kind: "halt" });
		const st = vm.stats();
		assert.ok(st.display && st.display.attaches === 2 && st.display.detaches === 2, JSON.stringify(st.display));
		assert.ok(st.evdev && st.evdev.delivered >= 4, JSON.stringify(st.evdev));
		assert.ok(st.sound && st.sound.frames === 66150, JSON.stringify(st.sound));
	});

	for (const shared of [true, false]) test(`worker mode with a busy guest (${shared ? "shared memory" : "messages"}): 150 KB of console input arrives whole and in order; readFrame() and keys while it runs (Alpine)`, { skip: noAlpine }, async (t) => {
		const vm = await boot(t, { worker: true, shared, log: () => {}, distro: alpine!, display: { width: 320, height: 240 } });
		assert.equal(vm.transport, shared ? "shared" : "messages");
		const { s, waitFor } = screen(vm);
		await waitFor(PROMPT);
		vm.write("(while :; do :; done) & stty -echo; cat > /tmp/paste; stty echo; echo got-$((6*7))\n");
		await new Promise((r) => setTimeout(r, 300));
		// More than the 64 KiB ring: the rest waits on this side and follows in order.
		let text = "";
		for (let i = 0; i < 1500; i++) text += `${String(i).padStart(5, "0")} ${"abcdefghijklmnopqrstuvwxyz0123456789".repeat(3)}${i % 7 ? "" : " ünïcödé"}\n`;
		const bytes = new TextEncoder().encode(text);
		assert.ok(bytes.length > 150000, String(bytes.length));
		for (let i = 0; i < bytes.length; i += 4000) vm.write(bytes.subarray(i, i + 4000));
		vm.write("\x04");
		await waitFor(/got-42/, 0, 120000);
		const { createHash } = await import("node:crypto");
		const at = s.text.length;
		vm.write("wc -c < /tmp/paste; md5sum /tmp/paste\n");
		await waitFor(/[0-9a-f]{32}/, at);
		assert.match(s.text.slice(at), new RegExp(`\\b${bytes.length}\\b`));
		assert.match(s.text.slice(at), new RegExp(createHash("md5").update(bytes).digest("hex")));
		// glimmer while the loop runs: a fresh frame and a key press.
		vm.write("glimmer --test 3 --no-sound\n");
		await waitFor(/glimmer: test ready/, at);
		const f = await vm.readFrame();
		assert.deepEqual(f && [f.width, f.height, [...f.data.subarray(0, 4)]], [320, 240, [255, 255, 255, 255]]);
		const k0 = s.text.length;
		assert.equal(vm.evdev!.key(30, true), true);
		assert.equal(vm.evdev!.key(30, false), true);
		await waitFor(/EV_KEY 30 1[\s\S]*EV_KEY 30 0/, k0);
		await waitFor(/glimmer: test done/, at);
		await vm.stop();
	});

	test("sound: worker mode delivers PCM via SharedArrayBuffer SoundSink.onRing without wake messages (Alpine)", { skip: noAlpine }, async (t) => {
		let reader: InstanceType<typeof sdk.SoundRingReader> | undefined;
		let totalFrames = 0;
		const formats = new Set<string>();
		const events: string[] = [];
		/** The ring's records in order: its state records, and "pcm" once per run of chunks. */
		const records: string[] = [];
		const fallbackChunks: number[] = [];
		const drain = (queued: number) => {
			for (let rec; (rec = reader?.readNext());) {
				if (rec.event) { records.push(rec.event); continue; }
				if (records.at(-1) !== "pcm") records.push("pcm");
				formats.add(`${rec.format.rate}/${rec.format.channels}/${rec.format.format}`);
				totalFrames += Math.floor(rec.data.length / rec.format.frameBytes);
				reader!.setQueuedFrames(queued);
			}
		};
		const vm = await boot(t, {
			worker: true, shared: true, log: () => {}, distro: alpine!,
			display: () => ({ width: 320, height: 240 }),
			sound: {
				rate: 48000,
				onRing: (ring) => {
					reader = new sdk.SoundRingReader(ring);
				},
				onState: (_st, ev) => {
					if (ev === "prepare" || ev === "drain" || ev === "stop" || ev === "close") drain(0);
					events.push(ev);
				},
				// Set alongside onRing to verify onRing takes priority over onChunk in shared worker mode.
				onChunk: (c) => { fallbackChunks.push(c.frames); return 0; },
			},
		});
		assert.ok(reader, "onRing received SharedArrayBuffer on boot");
		const poll = setInterval(() => drain(64), 20);
		try {
			const { s, waitFor } = screen(vm);
			await waitFor(PROMPT);
			const at = s.text.length;
			vm.write("glimmer --test 2\n");
			await waitFor(/glimmer: test sound done/, at, 30000);
			await waitFor(PROMPT, s.text.length - 200);
			await new Promise((r) => setTimeout(r, 150));
		} finally {
			clearInterval(poll);
		}
		assert.equal(fallbackChunks.length, 0, "onChunk stayed idle when onRing was attached");
		assert.deepEqual([...formats], ["22050/2/2"]);
		assert.equal(totalFrames, 66150);
		assert.deepEqual([events[0], events.at(-1)], ["open", "close"], events.join(","));
		drain(0);
		// The ring carries the state changes too, the PCM between its start and the stop or drain.
		assert.deepEqual(records.filter((r) => r !== "pcm"), events, records.join(","));
		const pcm = records.indexOf("pcm");
		assert.ok(pcm > 0 && records[pcm - 1] === "start" && /^(stop|drain)$/.test(records[pcm + 1]!), records.join(","));
		vm.write("poweroff\n");
		assert.equal((await vm.exited).code, 0);
	});

	test("WorkerKernel: sync() is a round trip, and a request the worker never answered resolves false with a persistent disk", async () => {
		// A stand-in worker: records what is posted, and lets the test answer.
		type Msg = { t: string; id?: number };
		const make = () => {
			const posted: Msg[] = [];
			let h!: { message(m: unknown): void; error(e: unknown): void; exit(): void };
			const endpoint = { post: (m: Msg) => posted.push(m), listen: (x: typeof h) => { h = x; }, terminate: () => {} };
			const vm = new sdk.WorkerKernel(endpoint as never, { onProgress: () => {}, log: () => {} });
			return { vm, posted, h: () => h };
		};
		const stats = { switches: 0, idles: 0, yields: 0, uptimeMs: 1, compileMs: 0, block: {}, jit: {} };
		const disk = (persistent: boolean) => ({ index: 0, kind: "file", size: 512, readOnly: false, persistent, flushSeq: 0, saving: false });
		for (const persistent of [true, false]) {
			const { vm, posted, h } = make();
			h().message({ t: "started", cmdline: "", memoryMiB: 1, memory64: false, stats, disks: [disk(persistent)], skipped: [] });
			await vm.started;
			const answered = vm.sync({ timeout: 50 });
			const sync = posted.find((m) => m.t === "sync")!;
			assert.equal((sync as { timeout?: number }).timeout, 50);
			h().message({ t: "synced", id: sync.id, ok: false });
			assert.equal(await answered, false, "the worker's answer is the result");
			const open = vm.sync();
			h().exit(); // the worker died with the request open
			assert.equal(await open, !persistent);
			assert.equal((await vm.exited).kind, "fatal");
			assert.equal(await vm.sync(), true, "after the exit: nothing can become dirty");
		}
	});

	for (const { worker, name } of MODES) test(`data disk from the bundled template: sync() saves what the guest has not written back (${name}${worker ? ", a file disk spec" : ""})`, async (t) => {
		const dir = mkdtempSync(path.join(tmpdir(), "unkernel-api-"));
		try {
			const module = await WebAssembly.compile(readFileSync(kernelFile));
			const tpl = bundledBoot(module).datadisk;
			assert.ok(tpl, "the bundle carries the data disk template (kernel/build.sh datadisk)");
			const file = path.join(dir, "data.img");
			await createImageFromKwsparse(file, tpl);
			// Inline: a FileDisk object (the caller closes it); worker: a spec, built and closed in the worker.
			let disk: InstanceType<typeof FileDisk> | undefined;
			const disks = () => (worker ? [{ kind: "file" as const, path: file }] : [disk = new FileDisk(file)]);
			let vm = await boot(t, { worker, kernel: module, disks: disks(), log: () => {} });
			let { s, waitFor } = screen(vm);
			await waitFor(PROMPT);
			let at = s.text.length;
			// Slow the guest's writeback and journal commits down: only the sync request gets the file out.
			vm.write("echo 360000 > /proc/sys/vm/dirty_expire_centisecs; echo 360000 > /proc/sys/vm/dirty_writeback_centisecs; " +
				"mount -o remount,commit=600 /data && echo kept-$((6*7)) > /data/kept.txt && echo written\n");
			await waitFor(/^written/m, at);
			assert.equal(await vm.sync({ timeout: 10000 }), true, "the kernel confirms the sync with a flush");
			if (vm instanceof sdk.WorkerKernel) {
				const d = vm.disks[0]!;
				assert.deepEqual({ index: d.index, kind: d.kind, persistent: d.persistent, readOnly: d.readOnly, size: d.size }, { index: 0, kind: "file", persistent: true, readOnly: false, size: 4 * 2 ** 30 });
			}
			assert.equal((await vm.stop({ reason: "no clean shutdown" })).kind, "stopped");
			disk?.close();

			vm = await boot(t, { worker, kernel: module, disks: disks(), log: () => {} });
			({ s, waitFor } = screen(vm));
			await waitFor(PROMPT);
			at = s.text.length;
			vm.write("cat /data/kept.txt\n");
			await waitFor(/kept-42/, at);
			vm.write("poweroff\n");
			assert.equal((await vm.exited).code, 0);
			disk?.close();
			if (vm instanceof sdk.WorkerKernel) assert.ok(vm.disks[0]!.flushSeq > 0 && vm.stats().block.flushes > 0, "the final snapshot has the flushes");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("jit option: kwemu's JIT tier compiles hot guest code when on (the default) and nothing when off", async (t) => {
		// sha256 over busybox (~1 MiB) runs well past the 2^17-instruction threshold.
		const run = async (jit: boolean | undefined) => {
			const logs: string[] = [];
			const vm = await boot(t, { log: (m) => logs.push(m), ...(jit === undefined ? {} : { jit }) });
			const { s, waitFor } = screen(vm);
			await waitFor(PROMPT);
			const at = s.text.length;
			vm.write("sha256sum /bin/busybox; echo jit-$((6*7))\n");
			await waitFor(/jit-42/, at);
			const sum = s.text.slice(at).match(/\b[0-9a-f]{64}\b/)?.[0];
			vm.write("poweroff\n");
			assert.equal((await vm.exited).code, 0);
			return { sum, st: vm.stats().jit, logs };
		};
		const [on, off] = await Promise.all([run(undefined), run(false)]);
		if (!kernelHasJit) {
			// A kernel without the tier never asks for it, whatever the option says.
			assert.ok(!on.st.requested && !off.st.requested && on.st.compiled === 0, JSON.stringify(on.st));
			assert.ok(on.sum && on.sum === off.sum, `same sha256 with and without the JIT option: ${on.sum} vs ${off.sum}`);
			t.diagnostic("this kernel has no JIT tier (kw_host_jit_*): checked the option only");
			return;
		}
		assert.ok(on.st.enabled && on.st.requested, JSON.stringify(on.st));
		assert.ok(on.st.compiled > 0 && on.st.compileMs > 0 && on.st.bytes > 0, JSON.stringify(on.st));
		assert.equal(on.st.failed, 0, on.logs.join("\n"));
		assert.equal(on.st.live, on.st.compiled - on.st.freed);
		assert.ok(on.st.maxLive >= on.st.live && on.st.maxLive <= 1024);
		assert.equal(on.st.refused, 0);
		assert.ok(on.st.collected >= 0 && on.st.retained === on.st.freed - on.st.collected, JSON.stringify(on.st));
		assert.deepEqual({ ...off.st, compileMs: 0 }, {
			enabled: false, requested: true, compiled: 0, live: 0, maxLive: 0, freed: 0, failed: 0, compileMs: 0, maxCompileMs: 0, bytes: 0,
			collected: 0, retained: 0, maxRetained: 0, gcNudges: 0, refused: 0,
		});
		assert.ok(on.sum && on.sum === off.sum, `same sha256 with and without the JIT: ${on.sum} vs ${off.sum}`);
	});

	test("JitHost: prompts a collection once freed modules pile up uncollected, refuses compiles at the limit", async () => {
		// A stand-in for the kernel: a memory holding one module in kwemu's shape
		// (imports env.memory, exports f: (i64, i64, i64, i64) -> i64) and a table of stubs.
		const T = [0x60, 4, 0x7e, 0x7e, 0x7e, 0x7e, 1, 0x7e];
		const mod = [0, 97, 115, 109, 1, 0, 0, 0, 1, 1 + T.length, 1, ...T, 2, 15, 1, 3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2, 0, 0,
			3, 2, 1, 0, 7, 5, 1, 1, 102, 0, 0, 10, 6, 1, 4, 0, 0x20, 0, 0x0b];
		const memory = new WebAssembly.Memory({ initial: 1 });
		new Uint8Array(memory.buffer).set(mod, 64);
		const stub = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(mod)), { env: { memory } }).exports.f;
		const table = new WebAssembly.Table({ element: "anyfunc", initial: 8 });
		for (let i = 1; i < 8; i++) table.set(i, stub);
		const logs: string[] = [];
		const host = new sdk.JitHost({ memory: () => memory, memory64: () => false, log: (m) => logs.push(m), retainedNudge: 2, retainedLimit: 4 });
		host.attach({ __indirect_function_table: table });
		assert.equal(host.caps(), 3 | 16 | (sdk.jitSimd() ? 32 : 0)); // available, 32-bit memory, env.table, SIMD
		// Finalizers never run inside one synchronous loop, so nothing is collected here.
		const results: number[] = [];
		for (let i = 0; i < 6; i++) {
			const r = host.compile(64, mod.length, 1 + (i % 7));
			results.push(r);
			if (r === 0) host.free(1 + (i % 7));
		}
		assert.deepEqual(results, [0, 0, 0, 0, -1, -1]);
		const st = host.stats;
		assert.deepEqual({ compiled: st.compiled, freed: st.freed, live: st.live, failed: st.failed, refused: st.refused, collected: st.collected, retained: st.retained, maxRetained: st.maxRetained },
			{ compiled: 4, freed: 4, live: 0, failed: 0, refused: 2, collected: 0, retained: 4, maxRetained: 4 });
		// Nudged on every compile (not on a free) with 2 or more uncollected: compiles 3-6.
		assert.equal(st.gcNudges, 4);
		assert.equal(table.get(1), stub);
		assert.equal(logs.length, 1, logs.join("\n"));
		// With a GC the modules are collected and compiling resumes.
		const gc = (globalThis as { gc?: () => void }).gc;
		if (gc) {
			for (let i = 0; i < 50 && host.stats.collected < 4; i++) {
				gc();
				await new Promise((r) => setTimeout(r, 20));
			}
			assert.equal(host.stats.collected, 4);
			assert.equal(host.stats.retained, 0);
			assert.equal(host.compile(64, mod.length, 1), 0);
			host.free(1);
		}
	});

	test("worker mode: Wisp from a net spec reaches a local Wisp server", async (t) => {
		const { withWisp } = await import("./net-helpers.ts");
		await withWisp(async (_b, seen, url) => {
			const vm = await boot(t, { worker: true, log: () => {}, net: { kind: "net", backend: { kind: "wisp", servers: [url] } } });
			const { s, waitFor } = screen(vm);
			await waitFor(PROMPT);
			const at = s.text.length;
			vm.write("/usr/lib/kw/net wait; wget -q -T 3 -O /dev/null http://echo.test/; echo wisp-tried\n"); // the prompt can come before the lease
			await waitFor(/^wisp-tried/m, at);
			assert.ok(seen.hosts.includes("echo.test:80"), JSON.stringify(seen));
			vm.write("poweroff\n");
			assert.equal((await vm.exited).code, 0);
		});
	});

	for (const { worker, name } of MODES) test(`Wisp networking through the default server (${name})`, { skip: !process.env.UNKERNEL_TEST_WISP && "set UNKERNEL_TEST_WISP=1 (needs internet)" }, async (t) => {
		const logs: string[] = [];
		const vm = await boot(t, { worker, log: (m) => logs.push(m), net: worker ? { kind: "net", backend: { kind: "wisp", servers: [...DEFAULT_WISP_SERVERS] } }
			: wispBackend(DEFAULT_WISP_SERVERS, { log: (m) => logs.push(m) }) });
		const { s, waitFor } = screen(vm);
		await waitFor(PROMPT);
		const at = s.text.length;
		vm.write("/usr/lib/kw/net wait; wget -q -O - http://example.com/ | grep -o '<title>.*</title>'; echo wisp-done\n");
		await waitFor(/wisp-done/, at, 90000);
		assert.match(s.text.slice(at), /<title>Example Domain<\/title>/, logs.join("\n"));
		vm.write("poweroff\n");
		assert.equal((await vm.exited).code, 0);
	});

	// Linux sends at most its own buffer (256 KiB) ahead of the host's credit and never asks for more,
	// so a host that waited for half of a larger buffer to fill before granting credit stalled it for good.
	test("vsock: a host buffer larger than the guest's window does not stall the guest's sends (inline)",
		{ skip: !kernelHasVsock && "the kernel under test has no kwvsock" }, async (t) => {
		const SIZE = 2 << 20;
		const vm = await boot(t, { log: () => {}, vsock: { bufferSize: 1 << 20 } });
		const { s, waitFor } = screen(vm);
		await waitFor(PROMPT);
		const l = vm.vsock!.listen(5000);
		const got = (async () => {
			const c = (await l.accept())!;
			let n = 0;
			for await (const chunk of c.readable) n += chunk.length;
			await c.writable.close();
			return n;
		})();
		const at = s.text.length;
		vm.write(`dd if=/dev/zero bs=65536 count=${SIZE / 65536} 2>/dev/null | kwbox vsock connect 5000; echo rc=$?\n`);
		await waitFor(/rc=0/, at, 30000);
		assert.equal(await got, SIZE);
		l.close();
		vm.write("poweroff\n");
		assert.equal((await vm.exited).code, 0);
	});

	// With kwshm, the device not offered is checked in the inline createKernel() suite.
	test("shm: the option on a kernel without kwshm", { skip: kernelHasShm && "the kernel under test has kwshm" }, async (t) => {
		// Requests fail at once with ENODEV.
		const vm = await boot(t, { log: () => {}, shm: true });
		assert.ok(vm.shm);
		await assert.rejects(vm.shm!.open("x"), (e: Error & { code?: string }) => e.code === "ENODEV");
		await assert.rejects(vm.shm!.openId(1), (e: Error & { code?: string }) => e.code === "ENOENT");
		await vm.stop();
	});

	/** FNV-1a 32, as guest/src/kwshm.c prints it. */
	const fnv32 = (b: Uint8Array) => {
		let h = 2166136261;
		for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 16777619);
		return (h >>> 0).toString(16).padStart(8, "0");
	};
	/** kwshm.c's memfd pattern. */
	const shmPattern = (n: number, seed: number) => {
		const b = new Uint8Array(n);
		for (let i = 0, x = seed; i < n; i++) b[i] = (x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 24;
		return b;
	};

	for (const { worker, name } of MODES) describe(`direct networking, vsock and shm, one kernel (${name})`, { concurrency: 1 }, () => {
		const net = worker ? { kind: "net" as const, backend: { kind: "direct" as const }, hostLoopback: true } : new NetStack({ backend: directBackend(), hostLoopback: true });
		const k = sharedKernel(() => ({
			worker, log: () => {}, net,
			// vsock: a small window (16 times smaller than the transfers) so the credit runs out over and over.
			...(kernelHasVsock && { vsock: { bufferSize: 64 * 1024 } }),
			...(kernelHasShm && { shm: true }),
		}));
		/** Shm handles the poweroff test checks. */
		const held: Array<import("../js/node.ts").ShmFile> = [];

		test(`direct networking: the guest fetches from a host HTTP server through the gateway${worker ? " (a net spec)" : ""}`, async () => {
			const http = createServer((_req, res) => res.end("hello from the host\n"));
			await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
			const port = (http.address() as AddressInfo).port;
			try {
				const { vm, s, waitFor } = k;
				await waitFor(PROMPT);
				const at = s.text.length;
				vm.write(`/usr/lib/kw/net wait; wget -q -O - http://10.0.2.2:${port}/ && echo fetch-ok\n`); // the prompt can come before the lease
				await waitFor(/hello from the host[\s\S]*fetch-ok/, at);
				if (net instanceof NetStack) assert.ok(net.stats.tcpOpened >= 1);
				else {
					await new Promise((r) => setTimeout(r, 700)); // the next stats snapshot
					assert.ok(vm.stats().net!.tcpOpened >= 1, JSON.stringify(vm.stats().net));
				}
			} finally {
				http.close();
			}
		});

		test("vsock: guest to a host listener and host to a guest listener, 4 MiB each way by checksum under credit flow control, half-close, refused and reset",
			{ skip: !kernelHasVsock && "the kernel under test has no kwvsock" }, async (t) => {
			const { createHash } = await import("node:crypto");
			const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
			const SIZE = 4 << 20;
			const { vm, s, waitFor } = k;
			const v = vm.vsock!;
			assert.ok(v, "vm.vsock with the vsock option");
			// Inline: the host refuses some of the guest's packets for now; the kernel must send them again, in order.
			const dev = vm instanceof sdk.KernelInstance ? vm.kernel.vsock : undefined;
			if (dev) {
				dev.refuse = () => Math.random() < 0.05;
				t.after(() => { dev.refuse = undefined; });
			}
			await waitFor(PROMPT);
			assert.equal(v.guestCid, 3);

			// 1. The guest connects to a host listener that echoes everything back; both directions at once.
			const echo = v.listen(5000);
			assert.throws(() => v.listen(5000), (e: Error & { code?: string }) => e.code === "EADDRINUSE");
			const echoed = (async () => {
				const c = await echo.accept();
				assert.ok(c && c.localPort === 5000 && c.remotePort > 0);
				const hash = createHash("sha256");
				let n = 0;
				await c.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, ctl) { hash.update(chunk); n += chunk.length; ctl.enqueue(chunk); },
				})).pipeTo(c.writable); // ends with a half-close once the guest's EOF arrives
				return { n, sum: hash.digest("hex"), closed: await c.closed };
			})();
			let at = s.text.length;
			vm.write(`head -c ${SIZE} /dev/urandom > /tmp/blob; kwbox vsock connect 5000 < /tmp/blob > /tmp/back; echo rc=$?; sha256sum /tmp/blob /tmp/back\n`);
			await waitFor(/rc=\d+[\s\S]*\/tmp\/back/, at, 120000);
			const out1 = s.text.slice(at);
			assert.match(out1, /rc=0/, out1);
			const blob = out1.match(/([0-9a-f]{64})\s+\/tmp\/blob/)?.[1], back = out1.match(/([0-9a-f]{64})\s+\/tmp\/back/)?.[1];
			const e = await echoed;
			assert.equal(e.n, SIZE);
			assert.equal(e.sum, blob, "what the host received is what the guest sent");
			assert.equal(back, blob, "what the guest received back is what it sent");
			assert.equal(e.closed, "closed", "an orderly close");
			echo.close();

			// 2. The host connects to a guest listener and sends 4 MiB; the guest has already
			// sent its reply and shut down its side (a half-close), so the host reads it, then EOF.
			at = s.text.length;
			vm.write("echo reply-$((6*7)) > /tmp/reply; kwbox vsock listen 5001 < /tmp/reply > /tmp/in; echo rc=$?; sha256sum /tmp/in\n");
			await waitFor(/kwvsock: listening on port 5001/, at);
			const data = new Uint8Array(SIZE);
			for (let i = 0, x = 12345; i < SIZE; i++) data[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
			const c = await v.connect(5001);
			assert.ok(c.localPort >= 49152 && c.remotePort === 5001);
			const replyP = (async () => {
				const chunks: Uint8Array[] = [];
				for await (const chunk of c.readable) chunks.push(chunk);
				return new TextDecoder().decode(Buffer.concat(chunks));
			})();
			const w = c.writable.getWriter();
			for (let i = 0; i < SIZE; i += 100000) await w.write(data.subarray(i, i + 100000));
			await w.close();
			assert.equal(await replyP, "reply-42\n");
			assert.equal(await c.closed, "closed");
			await waitFor(/rc=\d+[\s\S]*\/tmp\/in/, at, 120000);
			const out2 = s.text.slice(at);
			assert.match(out2, /rc=0/, out2);
			assert.equal(out2.match(/([0-9a-f]{64})\s+\/tmp\/in/)?.[1], sha(data), "the guest got exactly what the host sent");

			// 3. Refused both ways, and a reset by the host while the guest sends.
			await assert.rejects(v.connect(5999), (e: Error & { code?: string }) => e.name === "VsockError" && e.code === "ECONNREFUSED");
			at = s.text.length;
			vm.write("kwbox vsock connect 5002 < /dev/null; echo rc=$?\n");
			await waitFor(/rc=\d/, at);
			assert.match(s.text.slice(at), /kwvsock: connect: Connection reset by peer[\s\S]*rc=1/);
			let resetClosed: Promise<string> | undefined;
			const rst = v.listen(5003, (conn) => {
				resetClosed = conn.closed;
				void (async () => {
					const r = conn.readable.getReader();
					await r.read();
					conn.reset();
					await r.read().catch(() => {});
				})();
			});
			at = s.text.length;
			vm.write("yes | kwbox vsock connect 5003 > /dev/null; echo rc=$?\n");
			await waitFor(/rc=\d/, at);
			assert.match(s.text.slice(at), /kwvsock: send: Broken pipe[\s\S]*rc=1/);
			assert.equal(await resetClosed, "reset");
			rst.close();

			const st = v.stats;
			assert.ok(st.accepted >= 2 && st.connected >= 1 && st.refused >= 2 && st.resets >= 1 && st.violations === 0, JSON.stringify(st));
			assert.ok(st.bytesIn > SIZE && st.bytesOut === 2 * SIZE, JSON.stringify(st)); // in: the blob, the reply, some of yes; out: the echo and the data
			if (dev) assert.ok(dev.stats.refused > 0, "the refusal path ran");
			assert.equal(st.open, 0, "nothing left open");
			assert.deepEqual(vm.stats().vsock, st);
		});

		test("shm: guest shmem files read and written in place by name and by a guest export's id; sparse, resized, refused, released",
			{ skip: !kernelHasShm && "the kernel under test has no kwshm" }, async () => {
			const { createHash } = await import("node:crypto");
			const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
			const { vm, s, waitFor } = k;
			const shm = vm.shm!;
			assert.ok(shm, "vm.shm with the shm option");
			await waitFor(PROMPT);
			let marks = 0;
			/** Run a shell line and wait for it to finish; returns its output. */
			const sh = async (cmd: string, ms = 60000) => {
				const m = `done-${++marks}`;
				const at = s.text.length;
				vm.write(`${cmd}; echo done-$((${marks}))\n`);
				await waitFor(new RegExp(`\\n${m}\\r?\\n`), at, ms);
				return s.text.slice(at);
			};
			const guestSha = async (file: string) => {
				const out = await sh(`sha256sum ${file}`);
				return out.match(new RegExp(`([0-9a-f]{64})\\s+${file.replace(/\//g, "\\/")}`))?.[1];
			};
			const rejects = (p: Promise<unknown>, code: string, what: string) =>
				assert.rejects(p, (e: Error & { code?: string }) => e.name === "ShmError" && e.code === code, what);

			// 1. A patterned 8 MiB file the guest wrote, read back by checksum.
			const BIG = 8 << 20;
			await sh(`dd if=/dev/urandom of=/dev/shm/big bs=65536 count=${BIG / 65536} 2>/dev/null`);
			const big = await shm.open("big");
			assert.deepEqual({ size: big.size, pages: big.pages, origin: big.origin, writable: big.writable, gen: big.generation, name: big.name },
				{ size: BIG, pages: BIG / 4096, origin: "host", writable: true, gen: 1, name: "big" });
			let content = await big.read();
			assert.equal(content.length, BIG);
			assert.equal(sha(content), await guestSha("/dev/shm/big"), "the host read what the guest wrote");
			assert.equal(sha(await big.read(4095, 10000)), sha(content.subarray(4095, 14095)), "an unaligned read across pages");
			if (!worker) {
				const views = (big as import("../js/node.ts").InlineShmFile).views(100, BIG - 200);
				assert.ok(views.length >= 1 && views.every((v) => v.buffer === (vm as import("../js/node.ts").KernelInstance).kernel.memory.buffer), "views of the kernel's memory");
				assert.equal(sha(Buffer.concat(views)), sha(content.subarray(100, BIG - 100)), "the views cover the range in order");
			} else {
				assert.throws(() => (big as unknown as { views(): unknown }).views(), (e: Error & { code?: string }) => e.code === "EOPNOTSUPP", "no views in worker mode");
			}

			// 2. The host writes into it (unaligned, across many pages); the guest sees the bytes.
			const patch = shmPattern(3 * 1048576 + 777, 99);
			await big.write(1048576 + 123, patch);
			content.set(patch, 1048576 + 123);
			assert.equal(await guestSha("/dev/shm/big"), sha(content), "the guest reads what the host wrote");
			await rejects(big.write(BIG - 10, new Uint8Array(11)), "EINVAL", "a write past the end");
			await rejects(big.read(BIG, 1), "EINVAL", "a read past the end");

			// 3. A file the host creates, for data to the guest.
			const CR = 5 * 1048576 + 100;
			const created = await shm.create("fromhost", CR, { mode: 0o644 });
			assert.equal(created.size, CR);
			assert.equal(sha(await created.read()), sha(new Uint8Array(CR)), "created as zeros");
			const fromHost = shmPattern(CR, 5);
			await created.write(0, fromHost);
			let out = await sh("stat -c '%s %a' /dev/shm/fromhost");
			assert.match(out, new RegExp(`\\n${CR} 644\\r?\\n`));
			assert.equal(await guestSha("/dev/shm/fromhost"), sha(fromHost), "the guest reads the host's file");
			await rejects(shm.create("fromhost", 10), "EEXIST", "create does not replace");

			// 4. A memfd the guest exports through /dev/kwshm; the host opens it by id.
			const MFD = 3000000;
			let at = s.text.length;
			vm.write(`kwbox shm memfd ${MFD} 7\n`);
			await waitFor(/kwshm: id=(\d+) size=(\d+) pages=(\d+) fnv=([0-9a-f]{8})/, at);
			const [, idS, sizeS, pagesS, fnvS] = s.text.slice(at).match(/kwshm: id=(\d+) size=(\d+) pages=(\d+) fnv=([0-9a-f]{8})/)!;
			assert.deepEqual([Number(sizeS), Number(pagesS)], [MFD, Math.ceil(MFD / 4096)]);
			const mfd = await shm.openId(Number(idS));
			assert.deepEqual({ size: mfd.size, origin: mfd.origin, writable: mfd.writable, name: mfd.name }, { size: MFD, origin: "guest", writable: true, name: undefined });
			const mfdData = await mfd.read();
			assert.equal(fnv32(mfdData), fnvS, "the guest's memfd as it wrote it");
			assert.equal(fnv32(mfdData), fnv32(shmPattern(MFD, 7)));
			const hello = new TextEncoder().encode("hello from the host");
			await mfd.write(5000, hello);
			mfdData.set(hello, 5000);
			at = s.text.length;
			vm.write("\n");
			await waitFor(/kwshm: fnv=([0-9a-f]{8}) size=/, at);
			assert.equal(s.text.slice(at).match(/kwshm: fnv=([0-9a-f]{8})/)![1], fnv32(mfdData), "the guest sees the host's write in its memfd");
			const second = await shm.openId(Number(idS));
			await second.close(); // a guest export: only this handle ends
			assert.equal(await second.closed, "closed");
			assert.equal(mfd.size, MFD, "the other handle still works");
			at = s.text.length;
			vm.write("q\n");
			assert.equal(await mfd.closed, "released", "the export dies with the guest's /dev/kwshm file");
			await waitFor(PROMPT, at);
			await rejects(mfd.read(0, 1), "EBADF", "a closed handle");
			await rejects(shm.openId(Number(idS)), "ENOENT", "the id is gone");
			// Released by ioctl, with the helper still running; an unlinked shm file, read-only for the host, a range.
			await sh("dd if=/dev/urandom of=/dev/shm/ranged bs=65536 count=4 2>/dev/null");
			const rangedSha = createHash("sha256");
			const rangedHost = await shm.open("ranged");
			rangedSha.update((await rangedHost.read()).subarray(8192, 8192 + 50000));
			await rangedHost.close();
			at = s.text.length;
			vm.write("kwbox shm export /dev/shm/ranged -u -r -o 8192 -l 50000\n");
			await waitFor(/kwshm: id=(\d+) size=50000 pages=13 /, at);
			const ranged = await shm.openId(Number(s.text.slice(at).match(/kwshm: id=(\d+) size=50000/)![1]));
			assert.deepEqual({ size: ranged.size, writable: ranged.writable }, { size: 50000, writable: false });
			assert.equal(sha(await ranged.read()), rangedSha.digest("hex"), "the range of an unlinked file");
			await rejects(ranged.write(0, new Uint8Array(1)), "EACCES", "a read-only export");
			at = s.text.length;
			vm.write("release\n");
			await waitFor(/kwshm: released/, at);
			assert.equal(await ranged.closed, "released");
			vm.write("q\n");
			await waitFor(PROMPT, at);

			// 5. A sparse file: the export allocates its holes.
			await sh("truncate -s 16M /dev/shm/sparse; printf X | dd of=/dev/shm/sparse bs=1 seek=8388608 conv=notrunc 2>/dev/null");
			out = await sh("du -k /dev/shm/sparse");
			assert.ok(Number(out.match(/\n(\d+)\s+\/dev\/shm\/sparse/)![1]) < 100, `holes before the export: ${out}`);
			const sparse = await shm.open("sparse");
			assert.deepEqual([sparse.size, sparse.pages], [16 << 20, 4096]);
			const sp = await sparse.read();
			assert.equal(sp[8388608], 0x58);
			sp[8388608] = 0;
			assert.ok(sp.every((b) => b === 0), "zeros elsewhere");
			out = await sh("du -k /dev/shm/sparse");
			assert.equal(Number(out.match(/\n(\d+)\s+\/dev\/shm\/sparse/)![1]), 16384, `all allocated after the export: ${out}`);
			await sparse.close();

			// 6. The guest truncates and grows the file while the host holds it.
			assert.equal(await big.isStale(), false);
			assert.equal(await big.refresh(), false, "nothing to refresh");
			await sh("truncate -s 4M /dev/shm/big");
			assert.equal(await big.isStale(), true, "a truncation makes the view stale");
			assert.equal(big.size, BIG, "until refreshed the view keeps its pages");
			assert.equal(sha(await big.read()), sha(content), "the held pages, stale but intact");
			assert.equal(await big.refresh(), true);
			assert.deepEqual([big.size, big.generation], [4 << 20, 2]);
			content = content.slice(0, 4 << 20);
			assert.equal(sha(await big.read()), sha(content));
			await sh("truncate -s 6M /dev/shm/big");
			assert.equal(await big.isStale(), true, "growth too");
			assert.equal(await big.refresh(), true);
			assert.deepEqual([big.size, big.generation], [6 << 20, 3]);
			const grown = new Uint8Array(6 << 20);
			grown.set(content);
			assert.equal(sha(await big.read()), sha(grown), "the old bytes, then zeros");
			assert.equal(await big.refresh({ force: true }), true, "force takes the pages again");
			assert.equal(big.generation, 4);
			assert.equal(await guestSha("/dev/shm/big"), sha(grown));

			// 7. Refused names and files.
			await sh("mkdir /dev/shm/dir; ln -s big /dev/shm/link; mkfifo /dev/shm/fifo; touch /dev/shm/pv; mount --bind /proc/version /dev/shm/pv; echo x > /tmp/notshm");
			await rejects(shm.open("../x"), "EINVAL", "a name escaping /dev/shm");
			await rejects(shm.open("../../tmp/notshm"), "EINVAL", "a path");
			await rejects(shm.open("dir/x"), "EINVAL", "a path into a directory");
			await rejects(shm.open(".."), "EINVAL", "..");
			await rejects(shm.open(""), "EINVAL", "an empty name");
			await rejects(shm.open("dir"), "EISDIR", "a directory");
			await rejects(shm.open("link"), "EINVAL", "a symlink is not followed");
			await rejects(shm.open("fifo"), "EINVAL", "a FIFO");
			await rejects(shm.open("pv"), "EOPNOTSUPP", "a regular file that is not shmem (a bind mount of /proc/version)");
			await rejects(shm.open("missing"), "ENOENT", "a missing file");
			await rejects(shm.open("x".repeat(256)), "ENAMETOOLONG", "a name too long");
			await rejects(shm.openId(987654), "ENOENT", "an unknown id");

			// 8. Release and open again.
			const big2 = await shm.open("big");
			assert.notEqual(big2.id, big.id, "each open is its own export");
			await big.close();
			assert.equal(await big.closed, "closed");
			await rejects(big.read(0, 1), "EBADF", "a closed handle");
			assert.equal(sha(await big2.read()), sha(grown), "the other export is untouched");
			await big2.close();
			const again = await shm.open("big");
			assert.equal(sha(await again.read()), sha(grown), "opened again");
			const st = shm.stats;
			assert.ok(st.open === 2 && st.reads > 10 && st.writes >= 3, JSON.stringify(st)); // again and created
			assert.deepEqual(vm.stats().shm, st);
			held.push(again, created);
		});

		test("poweroff: exit code 0; the vsock and shm handles end with the kernel", async () => {
			const { vm } = k;
			vm.write("poweroff\n");
			assert.equal((await vm.exited).code, 0);
			if (kernelHasVsock) await assert.rejects(vm.vsock!.connect(5001), (e: Error & { code?: string }) => e.code === "ECONNABORTED");
			for (const f of held) assert.equal(await f.closed, "exit");
			if (kernelHasShm) await assert.rejects(vm.shm!.open("big"), (e: Error & { code?: string }) => e.name === "ShmError" && e.code === "ECONNABORTED", "after the exit");
		});
	});

	// shm's read paths in worker mode (shm.ts, worker-shared.ts): in place on this thread where the
	// worker shares the kernel's memory (an SMP kernel, with the shared transport), else reads through
	// the shared transport's ring (the UP kernel), else messages (shared: false).
	const SHM_PATHS = [
		{ name: "SMP: in place", opts: { worker: true, cpus: 2 }, via: "in place", smp: true },
		{ name: "the shared transport's ring", opts: { worker: true, cpus: 1 }, via: "ring", smp: false },
		{ name: "messages", opts: { worker: true, cpus: 1, shared: false }, via: "messages", smp: false },
		{ name: "SMP, messages", opts: { worker: true, cpus: 2, shared: false }, via: "messages", smp: true },
	] as const;
	for (const { name, opts, via, smp } of SHM_PATHS) test(`shm in worker mode (${name}): read, readSync, views and write, in order; reads while the guest is busy; a refresh; a release while views are held; across a snapshot and restore`,
		{ skip: (!kernelHasShm && "the kernel under test has no kwshm") || (smp && !hasSmpPatch && "the kernel under test carries no SMP kernel") }, async (t) => {
		const logs: string[] = [];
		const base = { ...opts, shm: true, vsock: false, log: (m: string) => logs.push(m) };
		const vm = await boot(t, base);
		const a = screen(vm);
		const { s, waitFor } = a;
		await waitFor(PROMPT);
		const sh = shell(vm, a);
		const shm = vm.shm!;
		const inPlace = via === "in place";
		const code = (c: string) => (e: Error & { code?: string }) => e.name === "ShmError" && e.code === c;
		/** Start kwshm.c on a memfd of `size` bytes (pattern `seed`); its export's id. */
		const memfd = async (size: number, seed: number) => {
			const from = s.text.length;
			vm.write(`kwbox shm memfd ${size} ${seed}\n`);
			await waitFor(/kwshm: id=(\d+) size=/, from);
			return Number(s.text.slice(from).match(/kwshm: id=(\d+) size=/)![1]);
		};
		/** Type a line to kwshm.c and wait for `re`. */
		const helper = async (line: string, re: RegExp) => {
			const from = s.text.length;
			vm.write(`${line}\n`);
			await waitFor(re, from);
			return s.text.slice(from);
		};
		assert.equal(shm.inPlace, inPlace, "Shm.inPlace");

		// A file the host creates: written and read in place (or not), then grown by the guest and refreshed.
		const CR = 4 * 65536;
		const c = await shm.create("paths", CR);
		assert.equal(c.inPlace, inPlace);
		const data = shmPattern(CR, 3);
		await c.write(0, data);
		assert.equal(await sh("md5sum < /dev/shm/paths | cut -c1-32"), `${createHash("md5").update(data).digest("hex")}\n`, "the guest reads the host's write");
		if (inPlace) assert.deepEqual(c.readSync(), data);
		await sh(`truncate -s ${2 * CR} /dev/shm/paths`);
		assert.equal(await c.refresh(), true);
		assert.equal(c.size, 2 * CR);
		assert.equal(c.inPlace, inPlace, "in place again after the refresh's answer");
		const grown = new Uint8Array(2 * CR);
		grown.set(data);
		assert.deepEqual(inPlace ? c.readSync() : await c.read(), grown, "the new page list");
		await c.close();
		assert.equal(c.inPlace, false, "an ended handle");
		assert.throws(() => c.readSync(0, 1), code("EBADF"));

		// A guest export by id.
		const MFD = 3000000;
		const pattern = shmPattern(MFD, 7);
		const f = await shm.openId(await memfd(MFD, 7));
		assert.equal(f.inPlace, inPlace);
		assert.equal(fnv32(await f.read()), fnv32(pattern));
		if (inPlace) {
			assert.equal(fnv32(f.readSync()), fnv32(pattern));
			const out = new Uint8Array(10000);
			assert.equal(f.readSync(4095, 10000, out), out, "into the buffer given");
			assert.deepEqual(out, pattern.subarray(4095, 14095), "an unaligned read across pages");
			const views = f.views(100, MFD - 200);
			assert.ok(views.length >= 1 && views.every((v) => v.buffer instanceof SharedArrayBuffer), "views of the shared memory");
			assert.equal(fnv32(Buffer.concat(views)), fnv32(pattern.subarray(100, MFD - 100)), "the views cover the range in order");
			assert.throws(() => f.readSync(MFD, 1), code("EINVAL"));
		} else {
			assert.throws(() => f.readSync(), code("EOPNOTSUPP"));
			assert.throws(() => f.views(), code("EOPNOTSUPP"));
		}
		// A write and a read right behind it, not awaited: the read sees the write.
		const hello = new TextEncoder().encode("hello, in order");
		const w = f.write(5000, hello), r = f.read(5000, hello.length);
		await w;
		assert.deepEqual(await r, hello);
		const written = pattern.slice();
		written.set(hello, 5000);
		const out = await helper("", /kwshm: fnv=([0-9a-f]{8})/);
		assert.equal(out.match(/kwshm: fnv=([0-9a-f]{8})/)![1], fnv32(written), "the guest sees the host's write");
		await helper("q", PROMPT);
		assert.equal(await f.closed, "released");

		// Reads while the guest keeps every CPU busy: in place or through the ring they do not wait for the kernel's yield.
		await sh(`rm -f /tmp/spin; for i in $(seq ${opts.cpus}); do (while :; do :; done) & echo $! >> /tmp/spin; done`);
		const id2 = await memfd(MFD, 7);
		const g = await shm.openId(id2);
		const times: number[] = [];
		for (let i = 0; i < 25; i++) {
			const t0 = performance.now();
			const b = await g.read(i * 65536, 524288);
			times.push(performance.now() - t0);
			assert.equal(fnv32(b), fnv32(pattern.subarray(i * 65536, i * 65536 + 524288)));
		}
		times.sort((x, y) => x - y);
		const median = times[12]!;
		// This thread's own delay (a zero timer): with every test of the suite at once it alone can exceed a yield.
		const lags: number[] = [];
		for (let i = 0; i < 9; i++) {
			const t0 = performance.now();
			await new Promise((res) => setTimeout(res, 0));
			lags.push(performance.now() - t0);
		}
		const lag = lags.sort((x, y) => x - y)[4]!;
		t.diagnostic(`${via}: reads of 512 KiB with the guest busy: median ${median.toFixed(2)} ms, longest ${times.at(-1)!.toFixed(1)} ms (this thread's timer delay ${lag.toFixed(2)} ms)`);
		if (via === "in place") assert.ok(median < 2, `in place: median ${median} ms`);
		if (via === "ring" && lag < 2) assert.ok(median < 8, `through the ring: median ${median} ms (a message waits for the kernel's 20 ms yield)`);
		assert.equal(shm.stats.inPlaceReads > 0, inPlace, JSON.stringify(shm.stats));

		if (inPlace) {
			// Released by the guest while this thread holds views: the kernel's detach waits until this
			// task's microtasks run (here past the worker's 1 s limit, which it then logs), and the views
			// keep the pages meanwhile.
			const v = g.views(0, MFD);
			const from = s.text.length;
			vm.write("release\n");
			const until = performance.now() + 1300;
			while (performance.now() < until) { /* hold the views */ }
			assert.equal(fnv32(Buffer.concat(v)), fnv32(pattern), "the views, still held");
			assert.equal(await g.closed, "released");
			await waitFor(/kwshm: released/, from);
			assert.throws(() => g.readSync(0, 1), code("EBADF"));
			assert.ok(logs.some((l) => l.includes(`export ${id2} retired while the owner still had it pinned`)), `the worker waited for the pin: ${logs.join("\n")}`);
			await helper("q", PROMPT);
			// A short hold: the release waits for it, and then goes on without a word.
			const id3 = await memfd(100000, 5);
			const h = await shm.openId(id3);
			const hv = h.views();
			vm.write("release\n");
			const short = performance.now() + 200;
			while (performance.now() < short) { /* hold the views */ }
			assert.equal(fnv32(Buffer.concat(hv)), fnv32(shmPattern(100000, 5)));
			assert.equal(await h.closed, "released");
			assert.ok(!logs.some((l) => l.includes(`export ${id3} retired`)), logs.join("\n"));
		} else {
			await helper("release", /kwshm: released/);
			assert.equal(await g.closed, "released");
		}
		await helper("q", PROMPT);
		await sh("kill $(cat /tmp/spin)");

		// Across a snapshot: a guest export held by a process, opened again in the restored machine.
		const id4 = await memfd(200000, 9);
		const k = await shm.openId(id4);
		const snap = await vm.snapshot({ stop: true });
		assert.equal(await k.closed, "exit");
		assert.equal(shm.inPlace, false, "not after the exit");
		assert.throws(() => k.readSync(), code("EBADF"));
		const vm2 = await boot(t, { ...base, restore: snap });
		const b2 = screen(vm2);
		assert.equal(vm2.shm!.inPlace, inPlace, "in place in the restored machine as before");
		const k2 = await vm2.shm!.openId(id4);
		assert.equal(k2.inPlace, inPlace);
		assert.equal(fnv32(inPlace ? k2.readSync() : await k2.read()), fnv32(shmPattern(200000, 9)), "the restored export's pages");
		if (inPlace) assert.equal(fnv32(Buffer.concat(k2.views())), fnv32(shmPattern(200000, 9)));
		const from = b2.s.text.length;
		vm2.write("release\n");
		await b2.waitFor(/kwshm: released/, from);
		assert.equal(await k2.closed, "released");
	});

	// Host file systems (js/core/9p.ts, mounts.ts; guest/src/kw9p.c): 9p over vsock, mounted through kwtty.
	for (const { worker, name } of MODES) describe(`host file systems over 9p, one kernel (${name})`,
		{ concurrency: 1, skip: (!kernelHasVsock && "the kernel under test has no kwvsock") || (!kernelHas9p && "the kernel under test has no 9p") }, () => {
		let reads = 0, bigReads = 0, closes = 0;
		const blob = new Uint8Array(3 << 20);
		for (let i = 0; i < blob.length; i++) blob[i] = (i * 2654435761) >>> 24;
		const easy = { "hello.txt": "hi from the host\n", dir: { "a.bin": blob, sub: { "deep.txt": "deep\n" } }, "now.txt": () => `read ${++reads}\n`,
			// Longer at each evaluation and larger than one 9p read: "N\n" repeated 50000 + N times.
			"big.txt": () => `${++bigReads}\n`.repeat(50000 + bigReads) };
		const rw = Object.assign(new MemoryFs({ "f.txt": "one\n" }), { close: () => { closes++; } });
		const scratch = mkdtempSync(path.join(tmpdir(), "unkernel-api-9p-"));
		after(() => rmSync(scratch, { recursive: true, force: true }));
		const k = sharedKernel(() => ({
			worker, log: () => {},
			mounts: { "/mnt/easy": easy, "/mnt/rw": rw, "/mnt/rw2": rw, "/mnt/ro": { fs: { "r.txt": "read only\n" }, readOnly: true } },
		}));
		const sh = async (cmd: string) => {
			const r = await k.vm.exec("sh", ["-c", cmd]);
			return { out: r.stdout.trim(), err: r.stderr.trim(), code: r.exitCode };
		};
		const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
		/** Longer than kw9p's metatimeout (1000 ms): the guest asks the host again about anything it looked up before. */
		const pastWindow = () => new Promise((res) => setTimeout(res, 1200));
		/** Run `script` on pipes until its first line, with it then waiting on stdin: `release()` lets it go on and resolves the rest of its stdout. */
		const hold = async (script: string) => {
			const p = await k.vm.spawn("sh", ["-c", script], { pty: false });
			void new Response(p.stderr).text();
			const out = p.stdout.getReader(), dec = new TextDecoder();
			let text = "";
			while (!text.includes("\n")) {
				const r = await out.read();
				if (r.done) throw new Error(`${script}: ended before its first line`);
				text += dec.decode(r.value);
			}
			const release = async () => {
				const w = p.stdin.getWriter();
				await w.write("\n");
				await w.close();
				let rest = text.slice(text.indexOf("\n") + 1);
				for (let r = await out.read(); !r.done; r = await out.read()) rest += dec.decode(r.value);
				assert.deepEqual(await p.ended, { type: "exit", code: 0 });
				return rest;
			};
			return { first: text.slice(0, text.indexOf("\n")), release };
		};

		test("createKernel({ mounts }): an object tree, one MemoryFs at two paths, a read-only one; exec() waits for them", async () => {
			// exec() waits for createKernel's mounts by itself.
			const r = await sh("cat /mnt/easy/hello.txt /mnt/easy/dir/sub/deep.txt; cat /mnt/easy/now.txt; cat /mnt/easy/now.txt; cat /mnt/rw2/f.txt; grep ' 9p ' /proc/mounts");
			assert.equal(r.code, 0, r.err);
			assert.match(r.out, /^hi from the host\ndeep\nread \d+\nread \d+\none\n/, "a computed file is evaluated again at each open");
			const [n1, n2] = [...r.out.matchAll(/read (\d+)/g)].map((m) => Number(m[1]));
			assert.ok(n2! > n1!, r.out);
			assert.match(r.out, /^kw9p:fs\d+ \/mnt\/easy 9p rw,.*metatimeout=1000,.*cache=0x3\b/m, "cache=readahead plus CACHE_META from metatimeout");
			assert.match(r.out, /^kw9p:fs\d+ \/mnt\/ro 9p ro,/m);
			assert.deepEqual([...k.vm.mounts.keys()], ["/mnt/easy", "/mnt/rw", "/mnt/rw2", "/mnt/ro"]);
			assert.ok([...k.vm.mounts.values()].every((m) => m.mounted));
			assert.ok(k.vm.mounts.get("/mnt/easy")!.stats.requests > 5);
		});

		test("a computed file whose length changes at each evaluation: each cat gets one whole result, the next cat a fresh one", async () => {
			const r = await sh("for i in 1 2 3; do cat /mnt/easy/big.txt | uniq -c; done");
			assert.equal(r.code, 0, r.err);
			const runs = r.out.split("\n").map((l) => l.trim().split(/\s+/).map(Number));
			assert.equal(runs.length, 3, `one value per cat, untorn:\n${r.out.slice(0, 500)}`);
			for (const [count, n] of runs) assert.equal(count, 50000 + n!, `the whole result for ${n}`);
			assert.ok(runs[0]![1]! < runs[1]![1]! && runs[1]![1]! < runs[2]![1]!, r.out);
		});

		test("host changes show within metatimeout's 1 s: rewrite, grow, shrink, create, delete, rename of files the guest has looked up, also of a file another process holds open", async () => {
			assert.equal((await sh("cat /mnt/rw/f.txt; [ -e /mnt/rw/later.txt ] || echo missing")).out, "one\nmissing");
			rw.writeFile("/f.txt", "two, longer\n");
			rw.writeFile("/later.txt", "later\n");
			rw.writeFile("/doomed.txt", "doomed\n");
			await pastWindow();
			// The process holds f.txt open, so its inode and pages stay cached; they are revalidated all the same.
			const held = await hold("exec 3</mnt/rw/f.txt; echo $(cat - /mnt/rw/later.txt /mnt/rw/doomed.txt <&3) $(stat -c %s /mnt/rw/f.txt); read _; cat /mnt/rw/f.txt; [ -e /mnt/rw/later.txt ] || echo gone; cat /mnt/rw/moved.txt; [ -e /mnt/rw/doomed.txt ] || echo deleted");
			assert.equal(held.first, "two, longer later doomed 12");
			rw.writeFile("/f.txt", "3\n");
			rw.move("/later.txt", "/moved.txt");
			rw.rm("/doomed.txt");
			await pastWindow();
			assert.equal(await held.release(), "3\ngone\nlater\ndeleted\n");
			rw.rm("/moved.txt");
		});

		test("within metatimeout's 1 s a repeated stat costs no round trip; the guest's own writes show at once on both sides", async () => {
			const fs = new MemoryFs({ "f.txt": "one\n" });
			const m = await k.vm.mount("/meta", fs);
			await sh("cat /meta/f.txt");
			const q = m.stats.requests;
			await sh("i=0; while [ $i -lt 50 ]; do [ -e /meta/f.txt ]; i=$((i+1)); done");
			assert.ok(m.stats.requests - q <= 2, `${m.stats.requests - q} requests for 50 stats (one revalidation if the window passed)`);
			assert.equal((await sh("echo guest > /meta/f.txt; cat /meta/f.txt; stat -c %s /meta/f.txt")).out, "guest\n6");
			assert.equal(fs.readText("/f.txt"), "guest\n");
			await m.unmount();
		});

		test("guest writes reach the host at each write(2), with no close or sync; create, rename, unlink, mkdir, symlink; hard links fail", async () => {
			const changes: string[] = [];
			const off = rw.onChange((c) => changes.push(`${c.type} ${c.path}${c.to ? ` ${c.to}` : ""}`));
			const held = await hold("exec 3>/mnt/rw/open.txt; echo still-open >&3; echo written; read _");
			assert.equal(rw.readText("/open.txt"), "still-open\n", "on the host while the guest still holds it open");
			await held.release();
			const r = await sh("echo w > /mnt/rw/w.txt && mkdir /mnt/rw/d && mv /mnt/rw/w.txt /mnt/rw/d/w.txt && ln -s d/w.txt /mnt/rw/lnk && rm /mnt/rw/open.txt; ln /mnt/rw/d/w.txt /mnt/rw/hard");
			assert.match(r.err, /hard.*Operation not permitted/);
			off();
			assert.equal(rw.readText("/d/w.txt"), "w\n");
			assert.equal(rw.readlink("/lnk"), "d/w.txt");
			assert.deepEqual(changes.filter((c) => !c.startsWith("write")), ["create /open.txt", "create /w.txt", "mkdir /d", "rename /w.txt /d/w.txt", "symlink /lnk d/w.txt", "remove /open.txt"]);
			assert.equal((await sh("cat /mnt/rw2/lnk")).out, "w", "the same MemoryFs at another path");
		});

		test("a large file both ways, by sha256", async () => {
			const r = await sh("sha256sum /mnt/easy/dir/a.bin; dd if=/dev/urandom of=/tmp/up.bin bs=64k count=48 2>/dev/null; cp /tmp/up.bin /mnt/rw/up.bin; sha256sum /tmp/up.bin");
			const [down, up] = r.out.split("\n").map((l) => l.split(" ")[0]);
			assert.equal(down, sha(blob));
			assert.equal(sha(rw.readFile("/up.bin")), up);
		});

		test("errors: ENOENT, EROFS on the read-only mount, EACCES writing a computed file", async () => {
			const r = await sh("cat /mnt/easy/nope; echo x > /mnt/ro/x; touch /mnt/ro/r.txt; rm /mnt/ro/r.txt; echo x > /mnt/easy/now.txt; cat /mnt/ro/r.txt");
			assert.match(r.err, /can't open '\/mnt\/easy\/nope': No such file or directory/);
			assert.match(r.err, /can't create \/mnt\/ro\/x: Read-only file system/);
			assert.match(r.err, /touch: \/mnt\/ro\/r.txt: Read-only file system/);
			assert.match(r.err, /rm: can't remove '\/mnt\/ro\/r.txt': Read-only file system/);
			assert.match(r.err, /now.txt: Permission denied/);
			assert.equal(r.out, "read only");
		});

		test("hard links on nodeFs: ln in the guest makes a second name for the host file (one inode)", async (t) => {
			// Not below scratch: the next test lists all of it.
			const dir = mkdtempSync(path.join(tmpdir(), "unkernel-api-hard-"));
			t.after(() => rmSync(dir, { recursive: true, force: true }));
			writeFileSync(path.join(dir, "a.txt"), "same\n");
			const m = await k.vm.mount("/hard", nodeFs(dir));
			const r = await sh("ln /hard/a.txt /hard/b.txt && stat -c %h /hard/b.txt && cat /hard/b.txt");
			assert.equal(r.code, 0, r.err);
			assert.deepEqual(r.out.split("\n").slice(0, 2), ["2", "same"], "the guest sees one file with two names");
			assert.equal(lstatSync(path.join(dir, "b.txt")).ino, lstatSync(path.join(dir, "a.txt")).ino, "one inode on the host");
			await m.unmount();
		});

		test("vm.mount() and unmount() at runtime: nodeFs (symlinks stay links, ls -i matches stat, names that are not UTF-8 left out), busy paths", async () => {
			mkdirSync(path.join(scratch, "sub"));
			writeFileSync(path.join(scratch, "sub", "h.txt"), "host file\n");
			writeFileSync(Buffer.concat([Buffer.from(path.join(scratch, "bad-")), Buffer.from([0xff])]), "not utf-8\n");
			symlinkSync("/tmp/kw-link-target", path.join(scratch, "abs-link"));
			const m = await k.vm.mount("/work", nodeFs(scratch));
			await assert.rejects(k.vm.mount("/work", { a: "b" }), (e: Error & { code?: string }) => e.name === "MountError" && e.code === "EBUSY");
			await assert.rejects(k.vm.mount("/proc", { a: "b" }), (e: Error & { code?: string }) => e.code === "EBUSY" && /already a mount point/.test(e.message), "a guest mount point");
			await assert.rejects(k.vm.mount("/etc/passwd", { a: "b" }), (e: Error & { code?: string }) => e.code === "ENOTDIR");
			const r = await sh("echo guest-target > /tmp/kw-link-target; cat /work/sub/h.txt; readlink /work/abs-link; cat /work/abs-link; ls /work; echo made > /work/sub/g.txt; mkdir /work/nd; ln -s sub/g.txt /work/gl; mv /work/sub/g.txt /work/nd/g.txt; fsync /work/nd || echo fsync of a directory failed; ls -i /work/sub | awk '{print $1}'; stat -c %i /work/sub/h.txt");
			assert.equal(r.code, 0, r.err);
			const lines = r.out.split("\n");
			assert.deepEqual(lines.slice(0, 3), ["host file", "/tmp/kw-link-target", "guest-target"], "the guest resolves a symlink in its own tree");
			assert.deepEqual(lines.slice(3, 5), ["abs-link", "sub"], "the name that is not UTF-8 is left out");
			assert.equal(lines.at(-2), lines.at(-1), "ls -i shows stat's inode number");
			assert.equal(readFileSync(path.join(scratch, "nd", "g.txt"), "utf8"), "made\n");
			assert.ok(lstatSync(path.join(scratch, "gl")).isSymbolicLink());
			// A process with its cwd there keeps it busy.
			const holder = await hold("cd /work && echo in && read _");
			await assert.rejects(m.unmount(), (e: Error & { code?: string }) => e.code === "EBUSY");
			assert.equal(m.mounted, true);
			await holder.release();
			await m.unmount();
			assert.equal(m.mounted, false);
			assert.equal(k.vm.mounts.has("/work"), false);
			assert.equal((await sh("grep -c ' /work ' /proc/mounts")).out, "0");
		});

		test("a hung handler: killed readers die at once, a waiting one gets ETIMEDOUT (after up to three requestTimeouts: the guest retries)", async () => {
			const hang: import("../js/node.ts").Fs = {
				getattr: (p) => (p === "/" ? { type: "dir" } : { type: "file", size: 10 }),
				readdir: () => [{ name: "x", type: "file" }],
				open: () => ({ read: () => new Promise<Uint8Array>(() => {}) }),
			};
			await k.vm.mount("/hang", hang, { requestTimeout: 1000 });
			const t0 = performance.now();
			const killed = await sh("cat /hang/x & p=$!; sleep 0.3; kill -9 $p; wait $p; echo killed $?");
			assert.equal(killed.out, "killed 137");
			assert.ok(performance.now() - t0 < 900, "the killed reader did not wait for the timeout");
			const r = await sh("cat /hang/x; echo cat $?");
			assert.equal(r.out, "cat 1");
			assert.match(r.err, /Operation timed out/);
			assert.ok(performance.now() - t0 < 6000);
			// One left hanging into the poweroff below.
			void k.vm.exec("cat", ["/hang/x"]).catch(() => {});
		});

		test("poweroff completes with a reader of a hung handler; the mounts end with the kernel and the backend's close() ran once", async () => {
			await new Promise((res) => setTimeout(res, 300));
			k.vm.write("poweroff\n");
			assert.equal((await k.vm.exited).code, 0);
			assert.equal(k.vm.mounts.size, 0);
			assert.equal(closes, 1, "close() once for the MemoryFs mounted twice");
			await assert.rejects(k.vm.mount("/x", { a: "b" }), (e: Error & { code?: string }) => e.code === "ECONNABORTED");
		});
	});

	test("mounts: without vsock createKernel rejects ENODEV before booting; a failed boot mount rejects the exec() that waited, later ones run",
		{ skip: (!kernelHasVsock && "the kernel under test has no kwvsock") || (!kernelHas9p && "the kernel under test has no 9p") }, async (t) => {
		await assert.rejects(createKernel({ kernel: testKernel, vsock: false, mounts: { "/m": { a: "b" } } }), (e: Error & { code?: string }) => e.name === "MountError" && e.code === "ENODEV");
		const logs: string[] = [];
		const vm = await boot(t, { log: (m) => logs.push(m), mounts: { "/etc/passwd": { a: "b" }, "/good": { "g.txt": "good" } } });
		await assert.rejects(vm.exec("true"), (e: Error & { code?: string }) => e.name === "MountError" && e.code === "ENOTDIR");
		assert.ok(logs.some((l) => /mount \/etc\/passwd/.test(l)), "logged too");
		assert.equal((await vm.exec("cat", ["/good/g.txt"])).stdout, "good");
	});

	/** Collects a terminal session's output and lets a test wait for a pattern in it. */
	const termScreen = (sess: import("../js/node.ts").Pty) => {
		const dec = new TextDecoder();
		const st = { text: "" };
		const done = (async () => {
			for await (const chunk of sess.output) st.text += dec.decode(chunk, { stream: true });
		})();
		done.catch(() => {});
		const waitFor = async (re: RegExp, from = 0, ms = 60000) => {
			const end = Date.now() + ms;
			while (!re.test(st.text.slice(from))) {
				if (Date.now() > end) throw new Error(`timeout waiting for ${re} in the terminal; tail:\n${st.text.slice(-1500)}`);
				await new Promise((r) => setTimeout(r, 50));
			}
		};
		return { st, waitFor, done };
	};

	// kwtty (guest/src/kwtty.c, js/core/tty.ts): terminal sessions over vsock, each with its own pty.
	for (const { worker, name } of MODES) describe(`terminal sessions over vsock (kwtty), one kernel (${name})`,
		{ concurrency: 1, skip: !kernelHasVsock && "the kernel under test has no kwvsock" }, () => {
		const k = sharedKernel(() => ({ worker, log: () => {} })); // vsock is on by default
		/** Run `cmd` on the hvc0 console and return what it printed after it, up to `done`. */
		const consoleRun = async (cmd: string, done: RegExp) => {
			const at = k.s.text.length;
			k.vm.write(`${cmd}\n`);
			await k.waitFor(done, at);
			return k.s.text.slice(at);
		};
		/** Poll the console until `echo "probe=<expr>"` prints `want` (up to about 10 s). */
		const consoleUntil = async (expr: string, want: RegExp) => {
			let out = "";
			for (let i = 0; i < 50; i++) {
				out = await consoleRun(`echo "probe=${expr}"`, /probe=[^\r\n$]*\r?\n/);
				if (want.test(out)) return out;
				await new Promise((r) => setTimeout(r, 200));
			}
			return out;
		};

		test("two sessions at once, each with its own pty and size; exit 0", async () => {
			await k.waitFor(PROMPT);
			const [a, b] = await Promise.all([k.vm.spawn(undefined, [], { rows: 30, cols: 100 }), k.vm.spawn(undefined, [], { rows: 40, cols: 120, term: "vt100" })]);
			assert.notEqual(a.pts, b.pts);
			assert.ok(a.pid > 1 && b.pid > 1 && a.pid !== b.pid);
			const sa = termScreen(a), sb = termScreen(b);
			await Promise.all([a.write("tty; stty size; echo $TERM; echo done-$((40+2))\n"), b.write("tty; stty size; echo $TERM; echo done-$((40+2))\n")]);
			await Promise.all([sa.waitFor(/done-42/), sb.waitFor(/done-42/)]);
			for (const [sess, sc, size, term] of [[a, sa, "30 100", "xterm-256color"], [b, sb, "40 120", "vt100"]] as const) {
				assert.match(sc.st.text, new RegExp(`^/dev/pts/${sess.pts}\\r?$`, "m"), sc.st.text);
				assert.match(sc.st.text, new RegExp(`^${size}\\r?$`, "m"), sc.st.text);
				assert.match(sc.st.text, new RegExp(`^${term}\\r?$`, "m"), sc.st.text);
			}
			await Promise.all([a.write("exit\n"), b.write("exit\n")]);
			assert.deepEqual(await a.ended, { type: "exit", code: 0 });
			assert.deepEqual(await b.ended, { type: "exit", code: 0 });
			await Promise.all([sa.done, sb.done]);
		});

		test("spawn(file, args, { cwd }): a program from PATH, its arguments, directory and exit code; exec and chdir failures", async () => {
			const s = await k.vm.spawn("sh", ["-c", 'pwd; tty; echo "[$0][$1]"; exit 5', "a b", ""], { cwd: "/tmp", cols: 100, rows: 30 });
			const sc = termScreen(s);
			assert.deepEqual(await s.ended, { type: "exit", code: 5 });
			await sc.done;
			assert.equal(s.exitCode, 5);
			assert.match(sc.st.text, /^\/tmp\r?$/m, sc.st.text);
			assert.match(sc.st.text, new RegExp(`^/dev/pts/${s.pts}\\r?$`, "m"), sc.st.text);
			assert.match(sc.st.text, /^\[a b\]\[\]\r?$/m, sc.st.text);
			const isRemote = (re: RegExp) => (e: Error & { code?: string }) => e.name === "PtyError" && e.code === "EREMOTE" && re.test(e.message);
			await assert.rejects(k.vm.spawn("/no/such/program"), isRemote(/exec \/no\/such\/program: No such file/));
			await assert.rejects(k.vm.spawn(undefined, [], { cwd: "/no/such/dir" }), isRemote(/chdir \/no\/such\/dir: No such file/));
		});

		test("kill(): TERM to the program, ended reports the signal", async () => {
			const s = await k.vm.spawn("sleep", ["100"]);
			const sc = termScreen(s);
			s.kill("SIGTERM");
			assert.deepEqual(await s.ended, { type: "signal", signal: 15, coreDumped: false });
			assert.equal(s.exitCode, null);
			await sc.done;
		});

		test("resize(), then stty size; exit 3", async () => {
			const s = await k.vm.spawn(undefined, [], { rows: 24, cols: 80 });
			const sc = termScreen(s);
			s.resize(132, 50);
			assert.deepEqual([s.cols, s.rows], [132, 50]);
			await s.write("stty size; echo r-$((1+1))\n");
			await sc.waitFor(/r-2/);
			assert.match(sc.st.text, /^50 132\r?$/m, sc.st.text);
			await s.write("exit 3\n");
			assert.deepEqual(await s.ended, { type: "exit", code: 3 });
		});

		test("seq 1 200000; exit: all of it arrives through a slow reader before ended settles", async () => {
			const N = 200000;
			const s = await k.vm.spawn(undefined, [], { rows: 24, cols: 80 });
			const dec = new TextDecoder();
			let text = "", chunks = 0, atEnd = -1, sinceNap = 0;
			// ended settles only when the reader asks past the last output, so by then it has all of it.
			void s.ended.then(() => { atEnd = text.length; }, () => {});
			await s.write(`seq 1 ${N}; exit\n`);
			// Slow: nothing read at first, so the guest fills the vsock window and blocks, then naps as it reads.
			await new Promise((r) => setTimeout(r, 1500));
			for await (const chunk of s.output) {
				assert.equal(atEnd, -1, "ended settled while output was still being read");
				text += dec.decode(chunk, { stream: true });
				chunks++;
				if ((sinceNap += chunk.length) >= 128 * 1024) {
					sinceNap = 0;
					await new Promise((r) => setTimeout(r, 20));
				}
			}
			assert.ok(chunks > 10, `${chunks} chunks`);
			assert.equal(atEnd, text.length, "ended settled after the last output was read");
			assert.deepEqual(await s.ended, { type: "exit", code: 0 });
			const nums = text.split(/\r?\n/).filter((l) => /^\d+$/.test(l)).map(Number);
			assert.equal(nums.length, N, `${nums.length} lines; tail: ${text.slice(-200)}`);
			assert.ok(nums.every((x, i) => x === i + 1), "every line, in order");
		});

		test("sleep 100 & exit: the session ends promptly although a background job holds the pty", async () => {
			const s = await k.vm.spawn(undefined, [], { rows: 24, cols: 80 });
			const sc = termScreen(s);
			const t0 = Date.now();
			await s.write("sleep 100 & exit\n");
			assert.deepEqual(await s.ended, { type: "exit", code: 0 });
			assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
			await sc.done;
		});

		test("yes & exit: the session ends although a background job keeps printing, and the job is hung up", async () => {
			const s = await k.vm.spawn(undefined, [], { rows: 24, cols: 80 });
			const sc = termScreen(s);
			await s.write("yes kwtty-bg-test & exit\n");
			assert.deepEqual(await s.ended, { type: "exit", code: 0 });
			await sc.done;
			const out = await consoleUntil("$(ps | grep -c '[y]es kwtty-bg-test')", /probe=0\r?\n/);
			assert.match(out, /probe=0\r?\n/, `no leftover yes:\n${out}`);
		});

		test("close() during output: ended closed, the shell and its program are gone", async () => {
			const s = await k.vm.spawn(undefined, [], { rows: 24, cols: 80 });
			const sc = termScreen(s);
			await s.write("yes kwtty-close-test\n");
			await sc.waitFor(/(kwtty-close-test\r?\n){20}/);
			assert.match(await consoleUntil("$(ps | grep -c '[y]es kwtty-close-test')", /probe=1\r?\n/), /probe=1\r?\n/, "yes runs");
			await s.close();
			assert.deepEqual(await s.ended, { type: "closed" });
			await sc.done;
			const out = await consoleUntil(`$(ps | grep -c '[y]es kwtty-close-test')$([ -d /proc/${s.pid} ] && echo -shell-alive)`, /probe=0\r?\n/);
			assert.match(out, /probe=0\r?\n/, `no leftover yes or shell (pid ${s.pid}):\n${out}`);
		});

		// The trap is in a foreground job: the kernel signals the session leader (the login shell, which
		// then dies) and, as it exits, the foreground process group. A HUP trap in busybox ash's own
		// interactive login shell does not run once its tty is hung up (2026-11-14), so it is not used.
		test("close() hangs up: a foreground shell's HUP trap runs", async () => {
			await consoleRun("rm -f /tmp/kwtty-hup; echo rm-$((3+4))", /rm-7/);
			const s = await k.vm.spawn(undefined, [], { rows: 24, cols: 80 });
			const sc = termScreen(s);
			await s.write(`sh -c 'trap "echo hup > /tmp/kwtty-hup; exit" HUP; echo armed-$((2+3)); while :; do sleep 0.1; done'\n`);
			await sc.waitFor(/armed-5/);
			await s.close();
			assert.deepEqual(await s.ended, { type: "closed" });
			const out = await consoleUntil("$(cat /tmp/kwtty-hup 2>/dev/null)", /probe=hup\r?\n/);
			assert.match(out, /probe=hup\r?\n/, out);
		});

		// Pipes: spawn(file, args, { pty: false }) and exec().
		test("exec(): stdout and stderr apart, without a pty (no \\r, no TERM, not a tty); the exit code", async () => {
			const r = await k.vm.exec("sh", ["-c", 'echo out; echo err >&2; echo "TERM=${TERM-unset}"; [ -t 0 ] || [ -t 1 ] && echo tty || echo notty; exit 4']);
			assert.deepEqual(r, { stdout: "out\nTERM=unset\nnotty\n", stderr: "err\n", exitCode: 4, signal: null });
			const cwd = await k.vm.exec("pwd", [], { cwd: "/tmp", env: { X: "1" } });
			assert.equal(cwd.stdout, "/tmp\n");
			await assert.rejects(k.vm.exec("/no/such/program"), (e: Error & { code?: string }) => e.code === "EREMOTE" && /exec \/no\/such\/program/.test(e.message));
		});

		test("exec(): binary output byte for byte, input through stdin then EOF, 300 KB each way", async () => {
			const bin = await k.vm.exec("printf", ["\\000\\377\\r\\n\\200"], { encoding: "buffer" });
			assert.deepEqual([...bin.stdout], [0, 255, 13, 10, 128]);
			const input = new Uint8Array(300 * 1024);
			for (let i = 0; i < input.length; i++) input[i] = (i * 31 + (i >> 8)) & 0xff;
			const echo = await k.vm.exec("cat", [], { input, encoding: "buffer" });
			assert.equal(echo.exitCode, 0);
			assert.equal(echo.stdout.length, input.length);
			assert.ok(Buffer.from(echo.stdout).equals(Buffer.from(input)), "cat gives the input back unchanged");
			const wc = await k.vm.exec("wc", ["-c"], { input });
			assert.equal(wc.stdout.trim(), String(input.length));
			const seq = await k.vm.exec("seq", ["1", "100000"]);
			const lines = seq.stdout.split("\n");
			assert.equal(lines.length, 100001);
			assert.equal(lines[99999], "100000");
		});

		test("spawn(file, args, { pty: false }): stdin as a stream, EOF ends cat; kill() sends SIGTERM", async () => {
			const p = await k.vm.spawn("cat", [], { pty: false });
			const out = new Response(p.stdout).text();
			const err = new Response(p.stderr).text();
			const w = p.stdin.getWriter();
			await w.write("one\n");
			await w.write(new TextEncoder().encode("two\n"));
			await w.close();
			assert.deepEqual(await p.ended, { type: "exit", code: 0 });
			assert.equal(await out, "one\ntwo\n");
			assert.equal(await err, "");

			const sl = await k.vm.spawn("sleep", ["100"], { pty: false });
			const done = Promise.all([new Response(sl.stdout).arrayBuffer(), new Response(sl.stderr).arrayBuffer()]);
			sl.kill();
			assert.deepEqual(await sl.ended, { type: "signal", signal: 15, coreDumped: false });
			await done;
		});

		test("pipes: close() hangs up the program's process group (SIGHUP), its children included", async () => {
			const p = await k.vm.spawn("sh", ["-c", "sleep 1000 & echo $!; wait"], { pty: false });
			const reader = p.stdout.getReader();
			let text = "";
			while (!text.includes("\n")) text += new TextDecoder().decode((await reader.read()).value);
			const child = Number(text.trim());
			assert.ok(child > 1, text);
			await p.close();
			assert.deepEqual(await p.ended, { type: "closed" });
			let alive = "";
			for (let i = 0; i < 50; i++) {
				alive = (await k.vm.exec("sh", ["-c", `for p in ${p.pid} ${child}; do [ -d /proc/$p ] && echo $p; done; true`])).stdout;
				if (!alive) break;
				await new Promise((r) => setTimeout(r, 100));
			}
			assert.equal(alive, "", "the shell and its sleep are gone");
		});

		// CONNECT: vm.connect() to a TCP server on the guest's loopback, and vm.fetch() over it.
		/** A busybox nc server on the guest's 127.0.0.1:`port` running `prog` per connection; connect() once it listens. */
		const guestServer = async (port: number, prog: string[]) => {
			const srv = await k.vm.spawn("nc", ["-lk", "-s", "127.0.0.1", "-p", String(port), "-e", ...prog], { pty: false });
			void new Response(srv.stdout).arrayBuffer().catch(() => {});
			void new Response(srv.stderr).arrayBuffer().catch(() => {});
			const connect = async () => {
				for (let i = 0; ; i++) {
					try {
						return await k.vm.connect(port);
					} catch (e) {
						if ((e as { code?: string }).code !== "ECONNREFUSED" || i > 100) throw e;
						await new Promise((r) => setTimeout(r, 100));
					}
				}
			};
			return { srv, connect };
		};
		const relays = async () => (await k.vm.exec("sh", ["-c", "ps -o args | grep -c '[k]wbox tty serve'"])).stdout.trim();

		test("connect(): an echo server, half-close, 1 MiB each way under credit; a refused port is ECONNREFUSED; close() of an idle connection ends the guest's relay", async () => {
			const { srv, connect } = await guestServer(7000, ["cat"]);
			const before = await relays();
			const enc = new TextEncoder();
			// Half-close: cat reads EOF, exits, and the server's close ends readable.
			const s = await connect();
			assert.equal(s.port, 7000);
			const w = s.writable.getWriter();
			await w.write(enc.encode("hello, "));
			await w.write(enc.encode("guest\n"));
			await w.close();
			assert.equal(await new Response(s.readable).text(), "hello, guest\n");
			assert.equal(await s.closed, "closed");

			// 1 MiB each way at once: more than the vsock window (256 KiB) and the relay's buffers.
			const N = 1 << 20;
			const data = new Uint8Array(N);
			for (let i = 0; i < N; i++) data[i] = (i * 31 + (i >> 8)) & 0xff;
			const b = await connect();
			const sent = (async () => {
				const bw = b.writable.getWriter();
				for (let i = 0; i < N; i += 50000) await bw.write(data.subarray(i, i + 50000));
				await bw.close();
			})();
			const back = new Uint8Array(await new Response(b.readable).arrayBuffer());
			await sent;
			assert.equal(back.length, N);
			assert.ok(Buffer.from(back).equals(Buffer.from(data)), "the echo is byte for byte");
			assert.equal(await b.closed, "closed");

			await assert.rejects(k.vm.connect(7999), (e: Error & { code?: string }) =>
				e.name === "PtyError" && e.code === "ECONNREFUSED" && /127\.0\.0\.1:7999/.test(e.message));
			await assert.rejects(k.vm.connect(0), RangeError);

			// The host half-closes, the server never answers, then the host closes: the relay sees it (a probe each second) and exits.
			const idle = await guestServer(7001, ["sleep", "100"]);
			const c = await idle.connect();
			const cw = c.writable.getWriter();
			await cw.write(enc.encode("x"));
			await cw.close();
			await c.close();
			let now = "";
			for (let i = 0; i < 50; i++) {
				now = await relays();
				if (now === before) break;
				await new Promise((r) => setTimeout(r, 100));
			}
			// The idle server's own session (kwtty with PIPES) is one more.
			assert.equal(Number(now), Number(before) + 1, `kwtty processes: ${before} before, ${now} after`);
			await idle.srv.close();
			await srv.close();
		});

		test("fetch(): GET from a shell HTTP server in the guest: status, headers and body", async () => {
			const script = [
				"#!/bin/sh",
				"cr=$(printf '\\r')",
				"read -r line",
				'while IFS= read -r h; do [ "$h" = "$cr" ] || [ -z "$h" ] && break; done',
				'body="hello from the guest: ${line%$cr}"',
				`printf 'HTTP/1.1 201 Created\\r\\nContent-Type: text/plain\\r\\nX-Guest: yes\\r\\nContent-Length: %d\\r\\n\\r\\n%s' "\${#body}" "$body"`,
				"",
			].join("\n");
			await k.vm.exec("sh", ["-c", "cat > /tmp/kw-http.sh && chmod +x /tmp/kw-http.sh"], { input: script });
			const { srv, connect } = await guestServer(8000, ["/tmp/kw-http.sh"]);
			await (await connect()).close(); // listening now
			const res = await k.vm.fetch("http://guest.example:8000/some/path?q=1");
			assert.equal(res.status, 201);
			assert.equal(res.headers.get("x-guest"), "yes");
			assert.equal(res.headers.get("content-type"), "text/plain");
			assert.equal(await res.text(), "hello from the guest: GET /some/path?q=1 HTTP/1.1");
			await srv.close();
		});
	});

	// Host commands (js/core/commands.ts; guest/src/kwcmd.c): guest processes that run functions of the host.
	for (const { worker, name } of MODES) describe(`host commands (kwcmd), one kernel (${name})`,
		{ concurrency: 1, skip: !kernelHasVsock && "the kernel under test has no kwvsock" }, () => {
		const seen: Array<Record<string, unknown> | string> = [];
		const k = sharedKernel(() => ({
			worker, log: () => {},
			commands: {
				hello: (c) => {
					seen.push({ args: c.args, cwd: c.cwd, uid: c.uid, tty: c.isTTY, foo: c.env.FOO, pid: c.pid });
					return `hello ${c.args.join(",")}\n`;
				},
				upper: async (c) => {
					const dec = new TextDecoder();
					await c.stdin.pipeThrough(new TransformStream<Uint8Array, string>({ transform: (b, tc) => tc.enqueue(dec.decode(b, { stream: true }).toUpperCase()) })).pipeTo(c.stdout);
					return 3;
				},
				boom: () => { throw new Error("it broke"); },
				noawait: (c) => {
					const out = c.stdout.getWriter(), err = c.stderr.getWriter();
					for (let i = 0; i < 5; i++) void out.write(`line ${i}\n`);
					void err.write("err\n");
				},
				big: async (c) => {
					const w = c.stdout.getWriter();
					for (let i = 0; i < 4; i++) await w.write(new Uint8Array(1 << 20).fill(120));
				},
				first: async (c) => `first:${new TextDecoder().decode((await c.stdin.getReader().read()).value)}`,
				die: (c) => ({ signal: c.args[0] }),
				hang: (c) => new Promise<number>((r) => c.signal.addEventListener("abort", () => { seen.push("aborted"); r(0); })),
				ask: async (c) => {
					const w = c.stdout.getWriter();
					await w.write(`${c.cols}x${c.rows} ${c.isTTY.stdin} name? `);
					const { value } = await c.stdin.getReader().read();
					await w.write(`hi ${new TextDecoder().decode(value).trim()}\n`);
				},
			},
		}));
		const sh = (script: string) => k.vm.exec("sh", ["-c", script]);

		test("exec() waits for createKernel's commands: arguments, environment, cwd, stdout and the exit status; a link per command, first on PATH", async () => {
			const r = await sh("cd /tmp && FOO=bar hello a 'b c'; echo rc=$?; command -v hello; readlink /run/kw/bin/hello; ls /run/kw/bin | tr '\\n' ' '");
			assert.equal(r.stdout, "hello a,b c\nrc=0\n/run/kw/bin/hello\n/usr/bin/kwbox\nask big boom die first hang hello noawait upper ");
			const call = seen.pop() as Record<string, unknown>;
			assert.ok((call.pid as number) > 1);
			assert.deepEqual({ ...call, pid: 0 }, { args: ["a", "b c"], cwd: "/tmp", uid: 0, tty: { stdin: false, stdout: false, stderr: false }, foo: "bar", pid: 0 });
			assert.deepEqual([...k.vm.commands.keys()], ["hello", "upper", "boom", "noawait", "big", "first", "die", "hang", "ask"]);
		});

		test("stdin to the handler and back, a returned status, a throw (stderr, exit 1), writes not awaited, 4 MiB through a pipe, a reader that leaves early", async () => {
			assert.deepEqual(await sh("echo abc | upper; echo rc=$?"), { stdout: "ABC\nrc=3\n", stderr: "", exitCode: 0, signal: null });
			assert.deepEqual(await sh("boom; echo rc=$?"), { stdout: "rc=1\n", stderr: "boom: it broke\n", exitCode: 0, signal: null });
			assert.deepEqual(await sh("noawait; echo rc=$?"), { stdout: "line 0\nline 1\nline 2\nline 3\nline 4\nrc=0\n", stderr: "err\n", exitCode: 0, signal: null });
			assert.equal((await sh("big | wc -c; big | head -c 5; echo; echo rc=$?")).stdout, "4194304\nxxxxx\nrc=0\n");
		});

		test("stdin is read only as the handler reads it: one read takes one line of a slow pipe and the rest stays; { signal } ends the process by that signal", async () => {
			assert.equal((await sh("{ echo one; sleep 0.3; echo two; } | { first; cat; }")).stdout, "first:one\ntwo\n");
			assert.equal((await sh("first </dev/null; echo; die TERM; echo rc=$?; die SIGUSR1; echo rc=$?; die NOPE 2>&1; echo rc=$?")).stdout,
				'first:\nrc=143\nrc=138\ndie: unknown signal "NOPE"\nrc=1\n');
			assert.deepEqual(await k.vm.exec("die", ["KILL"]), { stdout: "", stderr: "", exitCode: null, signal: 9 });
		});

		test("a normal process: ps and /proc show it by its name and arguments; killing it aborts the handler's signal", async () => {
			const r = await sh("hang x y & sleep 0.3; cat /proc/$!/comm; tr '\\0' ' ' < /proc/$!/cmdline; echo; kill $!; wait $!; echo rc=$?");
			assert.equal(r.stdout, "hang\nhang x y \nrc=143\n");
			for (let i = 0; i < 100 && !seen.includes("aborted"); i++) await new Promise((done) => setTimeout(done, 20));
			assert.ok(seen.includes("aborted"));
		});

		test("on a terminal: its size, stdin read only when the handler reads it (typeahead stays), Ctrl-C ends the process", async () => {
			const p = await k.vm.spawn(undefined, [], { cols: 90, rows: 20 });
			const sc = termScreen(p);
			await p.write("hello; echo typeahead-$((1+1))\n");
			await sc.waitFor(/typeahead-2/);
			await p.write("ask\n");
			await sc.waitFor(/90x20 true name\? /);
			await p.write("bob\n");
			await sc.waitFor(/hi bob\r?\n[^]*# /); // the next prompt: busybox ash drops what is typed before it
			const at = sc.st.text.length;
			await p.write("ask\n");
			await sc.waitFor(/name\? /, at);
			await p.write("\x03");
			await p.write("echo rc=$?\n");
			await sc.waitFor(/^rc=130\r?$/m, at);
			await p.close();
		});

		test("a name the host does not have (127), kwbox cmd run, addCommand() and removeCommand(), bad names", async () => {
			const r = await sh("ln -s /usr/bin/kwbox /tmp/nope; /tmp/nope; echo rc=$?; kwbox cmd run hello via-run");
			assert.deepEqual(r, { stdout: "rc=127\nhello via-run\n", stderr: "nope: the host does not provide this command\n", exitCode: 0, signal: null });
			await k.vm.addCommand("late", () => 7);
			assert.equal((await sh("late; echo rc=$?")).stdout, "rc=7\n");
			await k.vm.addCommand("late", () => 8); // replaced: the link is there already
			assert.equal((await sh("late; echo rc=$?")).stdout, "rc=8\n");
			await k.vm.removeCommand("late");
			assert.equal((await sh("late 2>/dev/null; echo rc=$?; ls /run/kw/bin | wc -l")).stdout, "rc=127\n9\n");
			assert.ok(!k.vm.commands.has("late"));
			for (const bad of ["", "a/b", ".x", "-x", "kwcmd", "kwbox", "a b"])
				await assert.rejects(k.vm.addCommand(bad, () => 0), (e: Error) => e instanceof sdk.CommandError && e.code === "EINVAL", bad);
		});
	});

	test("host commands: the option without vsock is refused before boot", async () => {
		await assert.rejects(createKernel({ kernel: testKernel, vsock: false, commands: { x: () => 0 } }),
			(e: Error) => e instanceof sdk.CommandError && e.code === "ENODEV");
	});

	// A distro root (guest/distro/alpine, the kw layer of guest/base/rootfs on top): what only a full userland has.
	describe("Alpine, one kernel", { concurrency: 1, skip: noAlpine || (!kernelHasVsock && "the kernel under test has no kwvsock") }, () => {
		const alp = sharedKernel(() => ({ distro: alpine!, log: () => {}, commands: { whoru: (c) => `uid ${c.uid}\n` } }));

		test("boots the Alpine image under the overlay root, with the kw layer on top", async () => {
			const r = await alp.vm.exec("sh", ["-c", "cat /etc/alpine-release /usr/lib/kw-distro; apk --version; grep ' / ' /proc/self/mounts; command -v kwbox"]);
			assert.equal(r.exitCode, 0, r.stderr);
			assert.match(r.stdout, /^\d+\.\d+\.\d+\nalpine\napk-tools \S+/);
			assert.match(r.stdout, /^overlay \/ overlay .*lowerdir=\/kw\/layer:\/kw\/distro/m);
			assert.match(r.stdout, /\/usr\/bin\/kwbox$/m);
			assert.equal(alp.vm.distro?.label, "kwroot");
		});

		test("PATH: the host's commands, ~/.local/bin, then /etc/profile's, then the shims, for programs kwtty starts and for login shells (kwtty.c, kw-path.sh)", async () => {
			const want = "/run/kw/bin:/home/user/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/kw/bin\n";
			assert.equal((await alp.vm.exec("sh", ["-c", 'echo "$PATH"'])).stdout, want);
			assert.equal((await alp.vm.exec("sh", ["-lc", 'echo "$PATH"'])).stdout, want);
		});

		test("as the image's user (uid 1000): host commands linked by root and run by the user, a host mount the user can write", async () => {
			assert.equal((await alp.vm.exec("sh", ["-c", "id -u; ls -l /run/kw/bin/whoru | cut -c1; whoru"])).stdout, "1000\nl\nuid 1000\n");
			const m = await alp.vm.mount("/mnt/host", new MemoryFs({ "a.txt": "host\n" }));
			const r = await alp.vm.exec("sh", ["-c", "stat -c '%U %u' /mnt/host /mnt/host/a.txt; echo guest > /mnt/host/b.txt; mkdir /mnt/host/d; cat /mnt/host/b.txt"]);
			assert.equal(r.stdout, "user 1000\nuser 1000\nguest\n", r.stderr);
			await m.unmount();
		});

		test("poweroff: exit code 0", async () => {
			alp.vm.write("poweroff\n");
			assert.equal((await alp.vm.exited).code, 0);
		});
	});

	test("connect() and fetch() on an instance created with vsock: false: ENODEV", async (t) => {
		const vm = await boot(t, { vsock: false, log: () => {}, cmdline: "console=hvc0 rdinit=/bin/true" });
		const isNoDev = (e: Error & { code?: string }) => e.name === "PtyError" && e.code === "ENODEV";
		await assert.rejects(vm.connect(80), isNoDev);
		await assert.rejects(vm.fetch("http://guest/"), isNoDev);
		await vm.exited;
	});

	test("snapshot() of a running machine, resumed by createKernel({ restore }) in a new instance (console only)", async (t) => {
		const vm = await boot(t, { vsock: false, log: () => {} });
		assert.ok(vm instanceof sdk.KernelInstance);
		const a = screen(vm);
		await a.waitFor(PROMPT);
		vm.write("X=kept; echo $((6*7)) > /tmp/f; (while :; do usleep 50000; done) & echo saved-$X\n");
		await a.waitFor(/saved-kept/);
		const snap = sdk.decodeSnapshot(sdk.encodeSnapshot(await vm.snapshot()));
		assert.equal(snap.memory.byteLength, 2048 * 1048576);
		assert.match(snap.fingerprint, /^Linux version /);
		vm.write("echo still-$X\n");
		await a.waitFor(/still-kept/);
		await vm.stop({ reason: "snapshot taken" });

		const vm2 = await boot(t, { vsock: false, restore: snap, log: () => {} });
		const b = screen(vm2);
		vm2.write("jobs > /tmp/j; echo got-$X-$(cat /tmp/f)-$(grep -c Running /tmp/j)\n");
		await b.waitFor(/got-kept-42-1/);
		// The restored kernel has the drivers it had: the devices must be given as when it was saved.
		await assert.rejects(boot(t, { restore: snap, log: () => {} }), /snapshot: the snapshot has no vsock device, but this machine is given one/);
	});

	test("snapshot() leaves out the free pages: after a memory-heavy workload the file stays small, and tmpfs and a running process survive", async (t) => {
		const vm = await boot(t, { vsock: false, log: () => {} });
		assert.ok(vm instanceof sdk.KernelInstance);
		const a = screen(vm);
		await a.waitFor(PROMPT);
		// 64 MiB of random data written and removed: free pages that are not zero.
		vm.write("dd if=/dev/urandom of=/tmp/big bs=1M count=64 2>/dev/null; head -c 4194304 /tmp/big > /tmp/keep; rm /tmp/big; " +
			"(while :; do usleep 50000; done) & echo sum-$(md5sum < /tmp/keep | cut -c1-32)-done\n");
		await a.waitFor(/sum-[0-9a-f]{32}-done/);
		const sum = a.s.text.match(/sum-([0-9a-f]{32})-done/)![1]!;
		const snap = await vm.snapshot({ stop: true });
		assert.ok((snap.freeBytes ?? 0) > 256 * 1048576, `free pages left out: ${snap.freeBytes}`);
		const bytes = sdk.encodeSnapshot(snap);
		assert.ok(bytes.length < 64 * 1048576, `snapshot of ${bytes.length} bytes, the freed 64 MiB must not be in it`);

		const vm2 = await boot(t, { vsock: false, restore: sdk.decodeSnapshot(bytes), log: () => {} });
		const b = screen(vm2);
		vm2.write("jobs > /tmp/j; echo got-$(md5sum < /tmp/keep | cut -c1-32)-$(grep -c Running /tmp/j)\n");
		await b.waitFor(new RegExp(`got-${sum}-1`));
	});

	test("snapshot() with display, evdev and sound: the restored glimmer keeps its picture, its open devices and its stream, and reads a key (Alpine)", { skip: noAlpine }, async (t) => {
		const opts = (events: string[], chunks: number[], modes: Array<string | null>, inputs: string[]) => ({
			log: () => {}, vsock: false, distro: alpine!, display: { width: 320, height: 240 },
			onDisplay: (m: { width: number; height: number } | null) => modes.push(m && `${m.width}x${m.height}`),
			onInput: (st: { keyboard: boolean; mouse: boolean; tablet: boolean }) => inputs.push(`${+st.keyboard}${+st.mouse}${+st.tablet}`),
			sound: { onState: (_s: unknown, ev: string) => events.push(ev), onChunk: (c: { frames: number }) => { chunks.push(c.frames); return 0; } },
		});
		const ev1: string[] = [], ch1: number[] = [], md1: Array<string | null> = [], in1: string[] = [];
		const vm = await boot(t, opts(ev1, ch1, md1, in1));
		assert.ok(vm instanceof sdk.KernelInstance);
		const a = screen(vm);
		await a.waitFor(PROMPT);
		vm.write("glimmer --test 6\n");
		await a.waitFor(/glimmer: test ready/);
		await new Promise((r) => setTimeout(r, 300)); // the stream runs
		const before = vm.frame()!;
		const snap = sdk.decodeSnapshot(sdk.encodeSnapshot(await vm.snapshot({ stop: true })));
		assert.ok(snap.devices.display?.mode && snap.devices.input && snap.devices.sound?.state.open, JSON.stringify(snap.devices));
		assert.equal(snap.devices.vsock, undefined);

		await assert.rejects(boot(t, { ...opts([], [], [], []), display: false, restore: snap }), /the snapshot has a display device/);
		const ev2: string[] = [], ch2: number[] = [], md2: Array<string | null> = [], in2: string[] = [];
		const vm2 = await boot(t, { ...opts(ev2, ch2, md2, in2), restore: snap });
		assert.ok(vm2 instanceof sdk.KernelInstance);
		const b = screen(vm2);
		assert.deepEqual(md2, ["320x240"], "the attachment is reported again");
		assert.deepEqual(vm2.frame()!.data, before.data, "the picture is the saved one");
		assert.ok(vm2.evdev!.keyboardOpen && in2.at(-1)?.startsWith("1"), in2.join(","));
		assert.deepEqual(ev2.slice(0, 2), ["open", "prepare"], ev2.join(","));
		assert.equal(vm2.evdev!.key(30, true), true);
		assert.equal(vm2.evdev!.key(30, false), true);
		await b.waitFor(/glimmer: event event\d+ EV_KEY 30 1[\s\S]*EV_KEY 30 0/);
		await b.waitFor(/glimmer: test sound done, \d+ frames/);
		await b.waitFor(/glimmer: test done/);
		assert.ok(ch2.reduce((n, f) => n + f, 0) > 0, "the stream went on after the restore");
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(md2.at(-1), null, "glimmer's close is reported");
		assert.equal(ev2.at(-1), "close", ev2.join(","));
		vm2.write("poweroff\n");
		assert.equal((await vm2.exited).code, 0);
	});

	test("snapshot() with network and vsock: the guest's old sessions end, new connections, exec() and fetch() work",
		{ skip: !kernelHasVsock && "the kernel under test has no kwvsock" }, async (t) => {
		const http = createServer((_req, res) => res.end("hello after restore\n"));
		await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
		t.after(() => http.close());
		const port = (http.address() as AddressInfo).port;
		const net = () => new NetStack({ backend: directBackend(), hostLoopback: true });
		const vm = await boot(t, { log: () => {}, net: net() });
		assert.ok(vm instanceof sdk.KernelInstance);
		const a = screen(vm);
		await a.waitFor(PROMPT);
		// A kwtty session (a program on pipes) and a guest connection to a host listener, open at the snapshot.
		const sub = await vm.spawn("sleep", ["1001"], { pty: false });
		void new Response(sub.stdout).arrayBuffer().catch(() => {});
		void new Response(sub.stderr).arrayBuffer().catch(() => {});
		const l = vm.vsock!.listen(5005);
		vm.write("kwbox vsock connect 5005 </dev/null >/tmp/vs.out 2>&1 & echo vs-started\n");
		await a.waitFor(/vs-started/);
		const conn = (await l.accept())!;
		// snapshot() refuses while vsock packets are in flight (the accept's and kwtty's last ones may still be), and the guest goes on.
		const quiet = async () => {
			for (let i = 0; ; i++) {
				try {
					return await vm.snapshot({ stop: true });
				} catch (e) {
					if (i >= 40 || !/in flight/.test(String((e as Error)?.message))) throw e;
					await new Promise((done) => setTimeout(done, 50));
				}
			}
		};
		const snap = sdk.decodeSnapshot(sdk.encodeSnapshot(await quiet()));
		assert.deepEqual(snap.devices.network?.mac, [0x52, 0x54, 0x00, 0x12, 0x34, 0x56]);
		assert.ok(snap.devices.vsock?.guestCid === 3, JSON.stringify(snap.devices));
		void conn.closed;

		await assert.rejects(boot(t, { log: () => {}, restore: snap }), /the snapshot has a network device/);
		const vm2 = await boot(t, { log: () => {}, net: net(), restore: snap });
		assert.ok(vm2 instanceof sdk.KernelInstance);
		const b = screen(vm2);
		// The kernel reset the old vsock connections: kwtty's program and the kwvsock client end.
		const gone = async () => {
			for (let i = 0; ; i++) {
				const r: { stdout: string } = await vm2.exec("sh", ["-c", "pgrep -f '[s]leep 1001'; pgrep -f '[k]wvsock connect 5005'; true"]);
				if (!r.stdout.trim()) return;
				if (i > 50) assert.fail(`still running after the restore: ${r.stdout}`);
				await new Promise((done) => setTimeout(done, 200));
			}
		};
		await gone();
		const at = b.s.text.length;
		vm2.write(`wget -q -O - http://10.0.2.2:${port}/ && echo fetch-ok\n`);
		await b.waitFor(/hello after restore[\s\S]*fetch-ok/, at);
		assert.equal((await vm2.exec("echo", ["exec-ok"])).stdout, "exec-ok\n");
		const srv = await vm2.spawn("nc", ["-lk", "-s", "127.0.0.1", "-p", "8001", "-e", "sh", "-c", "printf 'HTTP/1.0 200 OK\\r\\n\\r\\nguest-ok'"], { pty: false });
		void new Response(srv.stdout).arrayBuffer().catch(() => {});
		void new Response(srv.stderr).arrayBuffer().catch(() => {});
		let res: Response | undefined;
		for (let i = 0; !res; i++) {
			try { res = await vm2.fetch("http://guest:8001/"); } catch (e) { if (i > 50) throw e; await new Promise((r) => setTimeout(r, 100)); }
		}
		assert.equal(await res.text(), "guest-ok");
		vm2.write("poweroff\n");
		assert.equal((await vm2.exited).code, 0);
	});

	// Detachable terminal sessions (kwtty's DETACH and ATTACH, tty.ts attachPty()): the restore's
	// reset of every vsock connection detaches them, and attach() takes them over.
	for (const { worker, name } of MODES) test(`snapshot() with detachable terminal sessions: attach() after the restore gets the same shell, jobs and pty (replay, resize, input, exit status); close(), the timeout and a plain session hang up; a snapshot without stop leaves them connected; restored twice (${name})`,
		{ skip: !kernelHasVsock && "the kernel under test has no kwvsock" }, async (t) => {
		const vm = await boot(t, { worker, log: () => {} });
		const a = screen(vm);
		await a.waitFor(PROMPT);
		const isNoEnt = (re?: RegExp) => (e: Error & { code?: string }) => e.name === "PtyError" && e.code === "ENOENT" && (!re || re.test(e.message));
		const d = await vm.spawn(undefined, [], { cols: 80, rows: 24, detachable: true });
		if (d.sessionId === undefined) {
			// An image from before DETACH (UNKERNEL_TEST_KERNEL=an older bundle): ordinary sessions, and attach() is ENOENT.
			assert.equal(d.features & sdk.TTY_FEATURE_DETACH, 0);
			await assert.rejects(vm.attach("abc"), isNoEnt(/older than ATTACH/));
			return;
		}
		assert.match(d.sessionId, /^[0-9a-f]{32}$/);
		const alive = async (vmx: Instance, pid: number) => (await vmx.exec("sh", ["-c", `[ -d /proc/${pid} ] && echo yes || echo no`])).stdout.trim() === "yes";
		const until = async (what: string, ok: () => Promise<boolean>, ms = 15000) => {
			const end = Date.now() + ms;
			while (!(await ok())) {
				if (Date.now() > end) assert.fail(`timed out: ${what}`);
				await new Promise((r) => setTimeout(r, 200));
			}
		};
		// snapshot() refuses while vsock packets are in flight (kwtty's last output may still be); the guest goes on.
		const quiet = async (vmx: Instance, opts: NonNullable<Parameters<Instance["snapshot"]>[0]>) => {
			for (let i = 0; ; i++) {
				try {
					return await vmx.snapshot(opts);
				} catch (e) {
					if (i >= 40 || !/in flight/.test(String((e as Error)?.message))) throw e;
					await new Promise((done) => setTimeout(done, 50));
				}
			}
		};

		// A deliberate close() hangs up: the shell is gone and its id with it.
		const gone = await vm.spawn(undefined, [], { detachable: true });
		await gone.close();
		assert.deepEqual(await gone.ended, { type: "closed" });
		await until("the closed session's shell exits", async () => !(await alive(vm, gone.pid)));
		await assert.rejects(vm.attach(gone.sessionId!), isNoEnt(/no detachable session/));
		await assert.rejects(vm.attach("no-such-session"), isNoEnt(/no detachable session no-such-session/));

		const plain = await vm.spawn(undefined, [], { cols: 80, rows: 24 });
		const short = await vm.spawn(undefined, [], { detachable: true, detachTimeout: 1500 });
		// A full-screen program: the alternate screen, then more output than the 64 KiB kept for REPLAY.
		const alt = await vm.spawn("sh", ["-c", 'trap "echo winch-\\$(stty size)" WINCH; printf "\\033[?1049h"; seq 1 15000; echo alt-ready; while :; do sleep 0.1; done'], { cols: 80, rows: 24, detachable: true });
		assert.equal(plain.sessionId, undefined);
		const sd = termScreen(d), salt = termScreen(alt);
		void termScreen(plain).done;
		void termScreen(short).done;
		await d.write("X=kept; (i=0; while :; do i=$((i+1)); echo $i > /tmp/cnt; sleep 0.2; done) & echo ready-$((1+1))\n");
		await sd.waitFor(/ready-2/);
		await salt.waitFor(/alt-ready/);

		// Without stop: the snapshot lists the detachable sessions, and they stay connected.
		const live = await quiet(vm, {});
		assert.deepEqual(live.ttys?.map((s) => s.id).sort(), [d.sessionId, short.sessionId, alt.sessionId].sort());
		await d.write("echo still-$((3+3))\n");
		await sd.waitFor(/still-6/);

		// With a commit (the page's suspend), which already sees them.
		let committed: string[] | undefined;
		const snap = sdk.decodeSnapshot(sdk.encodeSnapshot(await quiet(vm, { commit: (s) => { committed = s.ttys?.map((x) => x.id); } })));
		assert.deepEqual(committed?.sort(), [d.sessionId, short.sessionId, alt.sessionId].sort());
		assert.deepEqual(snap.ttys?.find((s) => s.id === d.sessionId), { id: d.sessionId, pid: d.pid, pts: d.pts, cols: 80, rows: 24 });
		assert.deepEqual(await d.ended, { type: "lost" }, "the old host's Pty ends with the kernel");

		const vm2 = await boot(t, { worker, restore: snap, log: () => {} });
		// The same shell: its pid, variable and background job; the replay first; the size of the attach.
		const p = await vm2.attach(d.sessionId, { cols: 100, rows: 30 });
		assert.equal(p.pid, d.pid);
		assert.equal(p.pts, d.pts);
		assert.equal(p.sessionId, d.sessionId);
		const sp = termScreen(p);
		await sp.waitFor(/ready-2[\s\S]*still-6/);
		const count = async () => Number((await vm2.exec("cat", ["/tmp/cnt"])).stdout);
		const n1 = await count();
		await p.write("echo got-$X-$$; stty size\n");
		await sp.waitFor(new RegExp(`got-kept-${d.pid}\\r?\\n30 100\\r?\\n`));
		await until("the background job counts on", async () => (await count()) > n1);
		p.resize(90, 20);
		await p.write("stty size; echo r-$((4+4))\n");
		await sp.waitFor(/\n20 90\r?\nr-8/);

		// The full-screen program: the replay starts with its modes (the alternate screen) at a line start, then it redraws (SIGWINCH).
		const q = await vm2.attach(snap.ttys!.find((s) => s.id === alt.sessionId)!);
		q.resize(80, 24); // the same size again (the page does this): the redraw's second step still comes
		const sq = termScreen(q);
		await sq.waitFor(/winch-24 80/);
		assert.match(sq.st.text, /^\x1b\[\?1049h\d+\r\n/, JSON.stringify(sq.st.text.slice(0, 40)));
		assert.ok(sq.st.text.length < 70000, `${sq.st.text.length} bytes replayed`);
		await q.close();

		// The plain session's shell was hung up; the short one's after its 1.5 s; unknown ids are ENOENT.
		await until("the plain session's shell exits", async () => !(await alive(vm2, plain.pid)));
		await until("the unattached session is hung up after its timeout", async () => !(await alive(vm2, short.pid)));
		await assert.rejects(vm2.attach(short.sessionId!), isNoEnt());
		await assert.rejects(vm2.attach("no-such-session"), isNoEnt());

		// A second attach takes the session over; the first connection ends.
		const p2 = await vm2.attach(d.sessionId, { cols: 90, rows: 20, replay: false });
		assert.deepEqual(await p.ended, { type: "lost" });
		const sp2 = termScreen(p2);
		await p2.write("exit 7\n");
		assert.deepEqual(await p2.ended, { type: "exit", code: 7 });
		await sp2.done;
		await assert.rejects(vm2.attach(d.sessionId), isNoEnt());

		// The same snapshot restored again: its sessions are there to attach again.
		const vm3 = await boot(t, { worker, restore: snap, log: () => {} });
		const r = await vm3.attach(d.sessionId, { replay: false });
		const sr = termScreen(r);
		await r.write("echo again-$X-$$\n");
		await sr.waitFor(new RegExp(`again-kept-${d.pid}`));
		await r.close();
		assert.deepEqual(await r.ended, { type: "closed" });
		await until("a closed attached session's shell exits", async () => !(await alive(vm3, d.pid)));
	});

	test("snapshot() with host file systems: the mounts and a process's open files on them survive; a file deleted on the host meanwhile answers ESTALE; refused without the mounts and in worker mode",
		{ skip: !kernelHasVsock && "the kernel under test has no kwvsock" }, async (t) => {
		const dir = mkdtempSync(path.join(tmpdir(), "unkernel-api-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		writeFileSync(path.join(dir, "held.txt"), "");
		writeFileSync(path.join(dir, "r.txt"), "line one\nline two\n");
		writeFileSync(path.join(dir, "gone.txt"), "soon gone\n");
		const mem = new MemoryFs({ "m.txt": "memory\n" });
		const mounts = () => ({ "/mnt/h": nodeFs(dir), "/mnt/m": mem });
		const vm = await boot(t, { log: () => {}, mounts: mounts() });
		assert.ok(vm instanceof sdk.KernelInstance);
		const a = screen(vm);
		await a.waitFor(PROMPT);
		await vm.exec("true"); // createKernel's mounts are done
		// A process with three files open on the nodeFs mount, waiting across the snapshot.
		vm.write("echo guest > /mnt/m/g.txt; (exec 3<>/mnt/h/held.txt 4</mnt/h/r.txt 5<>/mnt/h/gone.txt; echo before >&3; " +
			"while [ ! -e /tmp/go ]; do usleep 20000; done; echo after >&3; read l <&4; echo \"$l\" > /tmp/r.out; " +
			"echo x >&5 2>/tmp/e.out || echo write-failed >> /tmp/e.out; echo done > /tmp/done) & echo held-ready\n");
		await a.waitFor(/held-ready/);
		for (let i = 0; readFileSync(path.join(dir, "held.txt"), "utf8") !== "before\n"; i++) {
			if (i > 200) assert.fail("the guest's first write did not arrive");
			await new Promise((r) => setTimeout(r, 25));
		}
		const snap = sdk.decodeSnapshot(sdk.encodeSnapshot(await vm.snapshot({ stop: true })));
		assert.deepEqual(snap.devices.vsock?.mounts?.mounts.map((m) => m.path).sort(), ["/mnt/h", "/mnt/m"]);
		rmSync(path.join(dir, "gone.txt"));

		await assert.rejects(boot(t, { log: () => {}, restore: snap }), /snapshot: the snapshot has a host file system at \/mnt\/[hm], which this machine is not given/);
		await assert.rejects(boot(t, { log: () => {}, restore: snap, mounts: { ...mounts(), "/mnt/m": { fs: mem, readOnly: true } } }), /\/mnt\/m is not read-only in the snapshot/);
		await assert.rejects(boot(t, { log: () => {}, restore: snap, mounts: mounts(), worker: true }), /resume inline only/);
		const vm2 = await boot(t, { log: () => {}, restore: snap, mounts: mounts() });
		assert.ok(vm2 instanceof sdk.KernelInstance);
		assert.deepEqual([...vm2.mounts.keys()].sort(), ["/mnt/h", "/mnt/m"]);
		assert.ok(vm2.mounts.get("/mnt/h")!.mounted);
		await vm2.exec("touch", ["/tmp/go"]);
		let out = "";
		for (let i = 0; !/done/.test(out); i++) {
			if (i > 100) assert.fail(`the process did not finish: ${out}`);
			await new Promise((r) => setTimeout(r, 50));
			out = (await vm2.exec("sh", ["-c", "cat /tmp/done 2>/dev/null; true"])).stdout;
		}
		assert.equal(readFileSync(path.join(dir, "held.txt"), "utf8"), "before\nafter\n", "a write through a file open across the restore, at its offset");
		assert.equal((await vm2.exec("cat", ["/tmp/r.out"])).stdout, "line one\n", "a read through a file open across the restore");
		assert.match((await vm2.exec("cat", ["/tmp/e.out"])).stdout, /Stale file handle[\s\S]*write-failed/, "the file deleted on the host while suspended");
		const r = await vm2.exec("sh", ["-c", "echo new > /mnt/h/new.txt && cat /mnt/m/g.txt /mnt/m/m.txt && ls /mnt/h"]);
		assert.equal(r.stdout, "guest\nmemory\nheld.txt\nnew.txt\nr.txt\n");
		assert.equal(readFileSync(path.join(dir, "new.txt"), "utf8"), "new\n");
		assert.equal(mem.readText("/g.txt"), "guest\n", "the MemoryFs passed again has the guest's write from before the snapshot");
		await vm2.mounts.get("/mnt/m")!.unmount();
		assert.equal(existsSync(path.join(dir, "new.txt")), true);
		vm2.write("poweroff\n");
		assert.equal((await vm2.exited).code, 0);
	});

	test("snapshot() with a data disk: resumes with the saved and the unsaved writes; refused once the disk changed", async (t) => {
		const dir = mkdtempSync(path.join(tmpdir(), "unkernel-api-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const module = await compileTestKernel();
		const file = path.join(dir, "data.img");
		await createImageFromKwsparse(file, bundledBoot(module).datadisk!);
		const open: Array<InstanceType<typeof FileDisk>> = [];
		t.after(() => { for (const d of open) try { d.close(); } catch {} });
		const disk = () => { const d = new FileDisk(file); open.push(d); return d; };

		const vm = await boot(t, { kernel: module, vsock: false, disks: [disk()], log: () => {} });
		assert.ok(vm instanceof sdk.KernelInstance);
		const a = screen(vm);
		await a.waitFor(PROMPT);
		// /data/synced reaches the disk; /data/dirty stays in the page cache (writeback and commits slowed down).
		vm.write("echo 360000 > /proc/sys/vm/dirty_expire_centisecs; echo 360000 > /proc/sys/vm/dirty_writeback_centisecs; " +
			"echo synced-1 > /data/synced; sync; mount -o remount,commit=600 /data; echo dirty-2 > /data/dirty; echo ready-$((6*7))\n");
		await a.waitFor(/ready-42/);
		const snap = sdk.decodeSnapshot(sdk.encodeSnapshot(await vm.snapshot({ stop: true })));
		assert.equal((await vm.exited).kind, "stopped", "stop: true stops the kernel after the copy");
		assert.equal(snap.disks.length, 1);
		assert.equal(snap.disks[0]!.name, file);
		assert.ok(existsSync(`${file}.kwsnap`), "the generation sidecar");

		await assert.rejects(boot(t, { kernel: module, vsock: false, restore: snap, log: () => {} }), /disk wda \(.*\) is missing/);
		const vm2 = await boot(t, { kernel: module, vsock: false, restore: snap, disks: [disk()], log: () => {} });
		assert.ok(vm2 instanceof sdk.KernelInstance);
		const b = screen(vm2);
		vm2.write("echo got-$(cat /data/synced)-$(cat /data/dirty)\n");
		await b.waitFor(/got-synced-1-dirty-2/);
		// Saved while it runs on: the next write to the disk makes this snapshot unrestorable.
		const snap2 = await vm2.snapshot();
		vm2.write("sync; echo after > /data/after; sync; echo wrote-$((6*7))\n"); // not the typed line's echo
		await b.waitFor(/wrote-42/);
		await vm2.stop({ reason: "test" });
		await assert.rejects(boot(t, { kernel: module, vsock: false, restore: snap2, disks: [disk()], log: () => {} }),
			/snapshot: disk wda \(.*data\.img\) was written after the snapshot \(generation \d+, the snapshot has \d+\)/);
		await assert.rejects(boot(t, { kernel: module, vsock: false, restore: snap, disks: [disk()], log: () => {} }), /was written after the snapshot/);
	});

	test("worker mode: snapshot() in the worker, resumed inline and in a worker (a 2 GiB memory is shared, not detached)", async (t) => {
		const vm = await boot(t, { worker: true, vsock: false, log: () => {} });
		assert.ok(vm instanceof sdk.WorkerKernel);
		const a = screen(vm);
		await a.waitFor(PROMPT);
		vm.write("X=w-kept; echo saved-$X\n");
		await a.waitFor(/saved-w-kept/);
		const snap = await vm.snapshot({ stop: true });
		assert.equal((await vm.exited).kind, "stopped");
		assert.equal(snap.memory.byteLength, 2048 * 1048576, "the memory came across");
		assert.ok(snap.memory.buffer instanceof SharedArrayBuffer, "a memory of 2 GiB is shared (Chrome posts no plain ArrayBuffer that large)");

		const vm2 = await boot(t, { vsock: false, restore: snap, log: () => {} });
		assert.ok(vm2 instanceof sdk.KernelInstance);
		const b = screen(vm2);
		vm2.write("echo inline-$X\n");
		await b.waitFor(/inline-w-kept/);
		await vm2.stop({ reason: "test" });

		const vm3 = await boot(t, { worker: true, vsock: false, restore: snap, transferRestore: true, log: () => {} });
		assert.equal(snap.memory.byteLength, 2048 * 1048576, "a shared memory is posted as it is");
		const c = screen(vm3);
		vm3.write("echo worker-$X\n");
		await c.waitFor(/worker-w-kept/);
		vm3.write("poweroff\n");
		assert.equal((await vm3.exited).code, 0);
	});

	test("worker mode: transferRestore detaches a memory under 2 GiB", async (t) => {
		const vm = await boot(t, { worker: true, vsock: false, memoryMiB: 512, log: () => {} });
		await screen(vm).waitFor(PROMPT);
		const snap = await vm.snapshot({ stop: true });
		assert.ok(snap.memory.buffer instanceof ArrayBuffer && snap.memory.byteLength === 512 * 1048576, "a plain memory came across");
		const vm2 = await boot(t, { worker: true, vsock: false, restore: snap, transferRestore: true, log: () => {} });
		assert.equal(snap.memory.byteLength, 0, "transferRestore handed the buffer over");
		const b = screen(vm2);
		vm2.write("echo back-$((6*7))\n");
		await b.waitFor(/back-42/);
		vm2.write("poweroff\n");
		assert.equal((await vm2.exited).code, 0);
	});

	test("worker mode: snapshot() with a data disk, resumed in a worker and saved again, then inline; refused once the disk changed", async (t) => {
		const dir = mkdtempSync(path.join(tmpdir(), "unkernel-api-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const module = await compileTestKernel();
		const file = path.join(dir, "data.img");
		await createImageFromKwsparse(file, bundledBoot(module).datadisk!);
		const spec = { kind: "file", path: file } as const;

		const vm = await boot(t, { worker: true, kernel: module, vsock: false, disks: [spec], log: () => {} });
		const a = screen(vm);
		await a.waitFor(PROMPT);
		vm.write("echo one > /data/one; echo ready-$((6*7))\n");
		await a.waitFor(/ready-42/);
		const snapA = await vm.snapshot({ stop: true });
		assert.equal((await vm.exited).kind, "stopped");
		assert.equal(snapA.disks[0]?.name, file);

		const vm2 = await boot(t, { worker: true, kernel: module, vsock: false, disks: [spec], restore: snapA, log: () => {} });
		assert.equal(snapA.memory.byteLength, 2048 * 1048576, "copied, not transferred, by default");
		const b = screen(vm2);
		vm2.write("echo two > /data/two; echo got-$(cat /data/one)\n");
		await b.waitFor(/got-one/);
		const snapB = await vm2.snapshot({ stop: true });
		await vm2.exited;

		const vm3 = await boot(t, { kernel: module, vsock: false, disks: [new FileDisk(file)], restore: snapB, log: () => {} });
		const c = screen(vm3);
		// vm2's write was still in the page cache (snapB): written back only now, which changes the disk.
		vm3.write("echo both-$(cat /data/one)-$(cat /data/two); sync; echo synced-$((6*7))\n");
		await c.waitFor(/both-one-two[\s\S]*synced-42/);
		await vm3.stop({ reason: "test" });
		await assert.rejects(boot(t, { worker: true, kernel: module, vsock: false, disks: [spec], restore: snapA, log: () => {} }),
			/snapshot: disk wda \(.*data\.img\) was written after the snapshot/);
	});

	/** A shell command's output on the console, between markers of its own. */
	const shell = (vm: Instance, a: ReturnType<typeof screen>) => {
		let n = 0;
		return async (cmd: string, ms?: number): Promise<string> => {
			const tag = `Q${++n}x${Math.floor(Math.random() * 1e6)}`;
			const from = a.s.text.length;
			vm.write(`echo ${tag}-B; ${cmd}; echo ${tag}-E\n`);
			const re = new RegExp(`\\n${tag}-B\\r?\\n([\\s\\S]*?)${tag}-E\\r?\\n`);
			await a.waitFor(re, from, ms);
			return re.exec(a.s.text.slice(from))![1]!.replace(/\r/g, "");
		};
	};

	for (const { worker, name } of MODES) test(`snapshot({ commit }) with a data disk (${name}): a rejected, a throwing and a timed-out commit leave the machine running (its tasks, clocks and disk); a committed one stops it, and it restores`, async (t) => {
		const dir = mkdtempSync(path.join(tmpdir(), "unkernel-api-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const module = await compileTestKernel();
		const file = path.join(dir, "data.img");
		await createImageFromKwsparse(file, bundledBoot(module).datadisk!);
		const open: Array<InstanceType<typeof FileDisk>> = [];
		t.after(() => { for (const d of open) try { d.close(); } catch {} });
		const disk = () => {
			if (worker) return { kind: "file", path: file } as const;
			const d = new FileDisk(file);
			open.push(d);
			return d;
		};
		const vm = await boot(t, { worker, kernel: module, vsock: false, disks: [disk()], log: () => {} } as BootOptions);
		const a = screen(vm), sh = shell(vm, a);
		await a.waitFor(PROMPT);
		await sh("X=kept; (i=0; while :; do i=$((i+1)); echo $i > /tmp/n; usleep 20000; done) & echo one > /data/one; sync");
		const counter = async () => Number((await sh("cat /tmp/n")).trim());
		const uptime = async () => Number((await sh("cut -d' ' -f1 /proc/uptime")).trim());
		const runsOn = async (what: string) => {
			const n = await counter();
			await new Promise((r) => setTimeout(r, 300));
			assert.ok(await counter() > n, `the background task counts on after ${what}`);
		};

		// Rejected: the commit got the whole snapshot while the kernel waited; a second snapshot is refused meanwhile.
		let held: import("../js/node.ts").KernelSnapshot | undefined;
		let second: Promise<unknown> | undefined;
		const e1 = await vm.snapshot({ commit: (s) => {
			held = s;
			second = vm.snapshot().then(() => "taken", (e: Error) => e.message);
			return new Promise((_, reject) => setTimeout(() => reject(new Error("no room")), 200));
		} }).catch((e: unknown) => e);
		assert.ok(e1 instanceof sdk.SnapshotCommitError && /no room/.test(e1.message) && /runs on/.test(e1.message) && !e1.timedOut, String(e1));
		assert.equal(held?.memory.byteLength, 2048 * 1048576, "the commit got the snapshot");
		assert.match(String(await second), /one is in progress/);
		await runsOn("a rejected commit");

		// Throwing at once.
		const e2 = await vm.snapshot({ commit: () => { throw new Error("thrown"); } }).catch((e: unknown) => e);
		assert.ok(e2 instanceof sdk.SnapshotCommitError && /thrown/.test(e2.message), String(e2));

		// Timed out: the signal aborts, the guest's monotonic clock jumped by the wait, its wall clock is the host's.
		let aborted = false;
		const u1 = await uptime(), h1 = performance.now();
		const e3 = await vm.snapshot({ commitTimeoutMs: 1500, commit: (_s, signal) => new Promise(() => signal.addEventListener("abort", () => { aborted = true; })) })
			.catch((e: unknown) => e);
		const u2 = await uptime(), h2 = performance.now();
		assert.ok(e3 instanceof sdk.SnapshotCommitError && e3.timedOut && aborted, String(e3));
		assert.ok(u2 - u1 >= 1.4 && u2 - u1 <= (h2 - h1) / 1000 + 0.5, `guest uptime ${(u2 - u1).toFixed(2)} s over ${((h2 - h1) / 1000).toFixed(2)} s on the host, a 1.5 s wait in it`);
		const skew = Number((await sh("date +%s")).trim()) - Date.now() / 1000;
		assert.ok(Math.abs(skew) < 3, `guest wall clock off by ${skew.toFixed(1)} s`);
		await runsOn("a timed-out commit");
		assert.equal((await sh(`dmesg | grep -cE '${KERNEL_TROUBLE}'; true`)).trim(), "0", await sh("dmesg | tail -30"));

		// The disk after the failures: written on, so the held snapshot can no longer resume with it (below).
		await sh("echo two > /data/two; sync");
		let bytes: Uint8Array | undefined;
		const snap = await vm.snapshot({ commit: (s) => { bytes = sdk.encodeSnapshot(s); } });
		assert.equal((await vm.exited).kind, "stopped", "stopped once committed");
		assert.equal(snap.memory.byteLength, 2048 * 1048576);

		const vm2 = await boot(t, { worker, kernel: module, vsock: false, disks: [disk()], restore: sdk.decodeSnapshot(bytes!), log: () => {} } as BootOptions);
		const b = screen(vm2), sh2 = shell(vm2, b);
		assert.equal((await sh2("echo got-$X-$(cat /data/one)-$(cat /data/two)")).trim(), "got-kept-one-two");
		const n = Number((await sh2("cat /tmp/n")).trim());
		await new Promise((r) => setTimeout(r, 300));
		assert.ok(Number((await sh2("cat /tmp/n")).trim()) > n, "the background task counts on after the restore");
		await vm2.stop({ reason: "test" });
		await assert.rejects(boot(t, { worker, kernel: module, vsock: false, disks: [disk()], restore: held!, log: () => {} } as BootOptions), /was written after the snapshot/);
	});

	/**
	 * snapshot({ commit, hold }) (the page's suspend in the background): a
	 * machine with an ext4 data disk, a background counter, a detachable and a
	 * plain terminal session, its snapshot committed (encoded, as the page
	 * stores it) and the kernel held at its snapshot point. UNKERNEL_TEST_HOLD_MS
	 * sets how long the hold of the "continue" test lasts (default 3 s).
	 */
	const holdMs = Number(process.env.UNKERNEL_TEST_HOLD_MS) || 3000;
	const heldMachine = async (t: { after(fn: () => unknown): void }, worker: boolean) => {
		const dir = mkdtempSync(path.join(tmpdir(), "unkernel-api-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const module = await compileTestKernel();
		const file = path.join(dir, "data.img");
		await createImageFromKwsparse(file, bundledBoot(module).datadisk!);
		const open: Array<InstanceType<typeof FileDisk>> = [];
		t.after(() => { for (const d of open) try { d.close(); } catch {} });
		const disk = () => {
			if (worker) return { kind: "file", path: file } as const;
			const d = new FileDisk(file);
			open.push(d);
			return d;
		};
		const vm = await boot(t, { worker, kernel: module, disks: [disk()], log: () => {} } as BootOptions);
		const a = screen(vm), sh = shell(vm, a);
		await a.waitFor(PROMPT);
		assert.match(await sh("grep ' /data ' /proc/mounts"), / ext4 /);
		await sh("X=kept; (i=0; while :; do i=$((i+1)); echo $i > /tmp/n; usleep 20000; done) & echo one > /data/one; sync");
		const d = await vm.spawn(undefined, [], { cols: 80, rows: 24, detachable: true });
		const p = await vm.spawn(undefined, [], { cols: 80, rows: 24 });
		const sd = termScreen(d), sp = termScreen(p);
		await d.write("Y=det; echo d-ready-$((2+2))\n");
		await p.write("Z=plain; echo p-ready-$((3+3))\n");
		await Promise.all([sd.waitFor(/d-ready-4/), sp.waitFor(/p-ready-6/)]);
		const counter = async () => Number((await sh("cat /tmp/n")).trim());
		const alive = async (pid: number) => (await sh(`[ -d /proc/${pid} ] && echo yes || echo no`)).trim() === "yes";
		// snapshot() refuses while vsock packets are in flight (kwtty's last output may still be); the guest goes on.
		const quietly = async (opts: NonNullable<Parameters<Instance["snapshot"]>[0]>) => {
			for (let i = 0; ; i++) {
				try {
					return await vm.snapshot(opts);
				} catch (e) {
					if (i >= 40 || !/in flight/.test(String((e as Error)?.message))) throw e;
					await new Promise((done) => setTimeout(done, 50));
				}
			}
		};
		return { vm, module, disk, a, sh, d, p, sd, sp, counter, alive, quietly };
	};

	for (const { worker, name } of MODES) test(`snapshot({ commit, hold }) with a data disk, held, then continued (${name}): the same machine runs on (tasks, a detachable and a plain terminal session, input queued meanwhile), its clocks moved on as designed without kernel warnings, sync() and a second snapshot answer during the hold, the disk is written after it, and a later snapshot restores`,
		{ skip: !kernelHasVsock && "the kernel under test has no kwvsock" }, async (t) => {
		const m = await heldMachine(t, worker);
		const { vm, sh, d, p, sd, sp } = m;
		// Inline: a wall clock of the test's own, which runs `lagMs` ahead while held (a device that slept for 6 h).
		const kernel = vm instanceof sdk.KernelInstance ? vm.kernel : undefined;
		const lagMs = kernel ? 6 * 3600e3 : 0;
		let wallAhead = 0;
		if (kernel) kernel.wallClock = () => Date.now() + wallAhead;
		await sh("echo kw-hold-mark > /dev/kmsg");
		const u1 = Number((await sh("cut -d' ' -f1 /proc/uptime")).trim()), h1 = performance.now();
		const n1 = await m.counter();
		let bytes: Uint8Array | undefined, during: { sync?: boolean; syncMs?: number; second?: string } = {};
		const snap = await m.quietly({
			commit: (s) => { bytes = sdk.encodeSnapshot(s); },
			hold: async (s, signal) => {
				assert.ok(s.ttys?.some((x) => x.id === d.sessionId), "the detachable session is in the snapshot");
				const t0 = performance.now();
				during.sync = await vm.sync();
				during.syncMs = performance.now() - t0;
				during.second = await vm.snapshot().then(() => "taken", (e: Error) => e.message);
				vm.write("echo typed-$((40+2))\n"); // queued until it runs on
				await d.write("echo det-typed-$((50+5))\n");
				await new Promise((r) => setTimeout(r, holdMs));
				wallAhead = lagMs;
				assert.equal(signal.aborted, false);
				return "continue" as const;
			},
		});
		const heldS = (performance.now() - h1) / 1000;
		assert.equal(snap.memory.byteLength, 2048 * 1048576, "resolved with the snapshot");
		// True, and not through the kernel (held, it would not flush: false after sync()'s 3 s).
		assert.ok(during.sync === true && during.syncMs! < 2500, `sync() during the hold: ${during.sync} after ${during.syncMs?.toFixed(0)} ms`);
		assert.match(String(during.second), /one is in progress/);
		await m.a.waitFor(/typed-42/);
		await sd.waitFor(/det-typed-55/);
		// The same machine: its tasks count on, both sessions are the same shells (no hangup), with their variables.
		const n2 = await m.counter();
		await new Promise((r) => setTimeout(r, 300));
		assert.ok(n2 >= n1 && await m.counter() > n2, "the background task counts on");
		assert.ok(await m.alive(d.pid) && await m.alive(p.pid), "both sessions' shells are alive");
		await d.write("echo det-$Y-$((1+1))\n");
		await p.write("echo plain-$Z-$((2+1))\n");
		await Promise.all([sd.waitFor(/det-det-2/), sp.waitFor(/plain-plain-3/)]);
		assert.equal((await sh("echo $X")).trim(), "kept");
		// Clocks: the monotonic clock moved on by the hold (and, inline, by the wall clock's lag); the wall clock is the host's.
		const u2 = Number((await sh("cut -d' ' -f1 /proc/uptime")).trim()), h2 = performance.now();
		const span = (h2 - h1) / 1000 + lagMs / 1000;
		assert.ok(u2 - u1 >= heldS - 1 + lagMs / 1000 && u2 - u1 <= span + 1, `guest uptime +${(u2 - u1).toFixed(1)} s over ${((h2 - h1) / 1000).toFixed(1)} s held ${heldS.toFixed(1)} s, lag ${lagMs / 1000} s`);
		const skew = Number((await sh("date +%s")).trim()) - (Date.now() + lagMs) / 1000;
		assert.ok(Math.abs(skew) < 3, `guest wall clock off by ${skew.toFixed(1)} s`);
		// Timers that expired meanwhile have fired; RCU, NOHZ and the rest said nothing (an SMP stall would come within 21 s).
		await new Promise((r) => setTimeout(r, testCpus && testCpus > 1 ? 25000 : 2000));
		assert.equal((await sh(`dmesg | sed -n '/kw-hold-mark/,$p' | grep -cE '${KERNEL_TROUBLE}|clocksource|watchdog|hung|rcu'; true`)).trim(), "0", await sh("dmesg | tail -30"));
		assert.ok(await m.counter() > n2);
		// The disk: written after the hold (a new generation), so the held snapshot no longer resumes with it.
		assert.equal((await sh("echo two > /data/two; sync; cat /data/one /data/two")).trim().replace(/\s+/g, " "), "one two");
		await assert.rejects(boot(t, { worker, kernel: m.module, disks: [m.disk()], restore: sdk.decodeSnapshot(bytes!), log: () => {} } as BootOptions), /was written after the snapshot/);
		// A later suspend (commit and stop) restores, the detachable session reattached.
		let later: Uint8Array | undefined;
		await m.quietly({ commit: (s) => { later = sdk.encodeSnapshot(s); } });
		assert.equal((await vm.exited).kind, "stopped");
		const vm2 = await boot(t, { worker, kernel: m.module, disks: [m.disk()], restore: sdk.decodeSnapshot(later!), log: () => {} } as BootOptions);
		const re = await vm2.attach(d.sessionId!);
		assert.equal(re.pid, d.pid);
		const sr = termScreen(re);
		await re.write("echo again-$Y-$(cat /data/two)\n");
		await sr.waitFor(/again-det-two/);
		await vm2.stop({ reason: "test" });
	});

	for (const { worker, name } of MODES) test(`snapshot({ commit, hold }): held, then stopped, restores from the committed snapshot; held, then the kernel ended (the page killed), the committed snapshot restores in a new kernel; a failed commit holds nothing (${name})`,
		{ skip: !kernelHasVsock && "the kernel under test has no kwvsock" }, async (t) => {
		// Stopped: the hold's "stop" (the page's cap, or Suspend by hand during the hold).
		const m = await heldMachine(t, worker);
		let bytes: Uint8Array | undefined;
		const snap = await m.quietly({ commit: (s) => { bytes = sdk.encodeSnapshot(s); }, hold: () => new Promise((r) => setTimeout(() => r("stop"), 500)) });
		assert.equal(snap.memory.byteLength, 2048 * 1048576);
		assert.equal((await m.vm.exited).reason, "stopped after a snapshot");
		const vm2 = await boot(t, { worker, kernel: m.module, disks: [m.disk()], restore: sdk.decodeSnapshot(bytes!), log: () => {} } as BootOptions);
		const re = await vm2.attach(m.d.sessionId!);
		const sr = termScreen(re);
		await re.write("echo back-$Y-$(cat /data/one)\n");
		await sr.waitFor(/back-det-one/);

		// A failed commit: no hold is asked for, and the machine runs on.
		const b2 = screen(vm2), sh2 = shell(vm2, b2);
		let asked = false;
		const e = await vm2.snapshot({ commit: () => { throw new Error("no room"); }, hold: () => { asked = true; return "stop"; } }).catch((x: unknown) => x);
		assert.ok(e instanceof sdk.SnapshotCommitError && /no room/.test(e.message), String(e));
		assert.equal(asked, false, "nothing held after a failed save");
		assert.equal((await sh2("echo runs-on-$((7*6))")).trim(), "runs-on-42");

		// Ended while held (the browser killed the page or its worker): the snapshot was committed and resolves;
		// the hold's signal aborts; a new kernel restores it (nothing ran after it, so the disk is as sealed).
		let signal: AbortSignal | undefined, bytes2: Uint8Array | undefined;
		const snap2P = vm2.snapshot({ commit: (s) => { bytes2 = sdk.encodeSnapshot(s); }, hold: (_s, sig) => { signal = sig; return new Promise(() => {}); } });
		for (let i = 0; !signal && i < 200; i++) await new Promise((r) => setTimeout(r, 50));
		assert.ok(signal && !signal.aborted, "held");
		assert.equal(await vm2.sync(), true, "sync() during the hold");
		await vm2.stop({ reason: "the page went away" });
		const snap2 = await snap2P;
		assert.ok(snap2.memory.byteLength > 0 && signal.aborted, "resolved, the hold's signal aborted");
		const vm3 = await boot(t, { worker, kernel: m.module, disks: [m.disk()], restore: sdk.decodeSnapshot(bytes2!), log: () => {} } as BootOptions);
		const re3 = await vm3.attach(m.d.sessionId!);
		const s3 = termScreen(re3);
		await re3.write("echo third-$Y\n");
		await s3.waitFor(/third-det/);
		await vm3.stop({ reason: "test" });
	});

	/**
	 * A kernel worker on this thread (serveKernel() over a MessageChannel)
	 * with an extra disk kind: a file disk whose snapshot seal becomes
	 * durable only after `delayMs`, or fails.
	 */
	const inProcessWorker = async () => {
		const [{ serveKernel }, { createKernelOn }, { nodePlatform, nodeReadFile }, { nodeDevices }, { extendDevices }, { MessageChannel }] = await Promise.all([
			import("../js/core/worker-serve.ts"), import("../js/core/instance.ts"), import("../js/node/platform.ts"),
			import("../js/node/devices.ts"), import("../js/core/devices.ts"), import("node:worker_threads")]);
		const devices = extendDevices(nodeDevices, { disks: { sealhook: (spec: { path: string; delayMs: number; fail?: boolean }) => {
			const d = new FileDisk(spec.path);
			const seal = d.snapshotSeal.bind(d);
			d.snapshotSeal = () => {
				const r = seal();
				return { state: r.state, done: r.done.then(() => new Promise<void>((ok, no) => setTimeout(() => (spec.fail ? no(new Error("the store went away")) : ok()), spec.delayMs))) };
			};
			return d;
		} } });
		const platform = { ...nodePlatform(new URL(`file://${kernelFile}`)), spawnWorker: () => {
			const { port1, port2 } = new MessageChannel();
			serveKernel({ post: (m, tr) => port2.postMessage(m, tr), listen: (h) => port2.on("message", h) }, { readFile: nodeReadFile(), devices });
			return {
				post: (m, tr) => port1.postMessage(m, tr),
				listen: (h) => port1.on("message", h.message),
				terminate: () => { port1.close(); port2.close(); },
			} satisfies import("../js/core/worker-protocol.ts").WorkerEndpoint;
		} };
		return (opts: BootOptions) => createKernelOn(platform, { ...opts, worker: true });
	};

	test("worker mode: a snapshot's result goes out before the exit its stop causes, also when a disk becomes durable only after the exit's 10 s wait for saves; with a commit, a disk that fails to become durable leaves the machine running",
		{ skip: !!process.env.UNKERNEL_DIST && "an in-process worker from the sources" }, async (t) => {
		const dir = mkdtempSync(path.join(tmpdir(), "unkernel-api-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const module = await compileTestKernel();
		const create = await inProcessWorker();
		const image = async (name: string) => {
			const file = path.join(dir, name);
			await createImageFromKwsparse(file, bundledBoot(module).datadisk!);
			return file;
		};
		const slow = await image("slow.img"), failing = await image("failing.img");
		const vm = await create({ kernel: module, vsock: false, cpus: testCpus, disks: [{ kind: "sealhook", path: slow, delayMs: 11000 } as never], log: () => {} });
		t.after(() => vm.stop({ reason: "test cleanup" }));
		const vm2 = await create({ kernel: module, vsock: false, cpus: testCpus, disks: [{ kind: "sealhook", path: failing, delayMs: 100, fail: true } as never], log: () => {} });
		t.after(() => vm2.stop({ reason: "test cleanup" }));
		const a = screen(vm), b = screen(vm2), sh2 = shell(vm2, b);
		await Promise.all([a.waitFor(PROMPT), b.waitFor(PROMPT)]);

		const t0 = performance.now();
		const snap = await vm.snapshot({ stop: true });
		assert.ok(performance.now() - t0 >= 11000 && snap.memory.byteLength === 2048 * 1048576, "resolved once the disk was durable");
		assert.equal((await vm.exited).reason, "stopped after a snapshot");

		await sh2("echo before > /data/f; sync");
		const e = await vm2.snapshot({ commit: () => { throw new Error("must not be asked: the disk failed"); } }).catch((x: unknown) => x);
		assert.ok(e instanceof sdk.SnapshotCommitError && /saving a disk failed: the store went away/.test(e.message), String(e));
		assert.equal((await sh2("echo after > /data/g; sync; cat /data/f /data/g")).trim().replace(/\s+/g, " "), "before after");
	});

	test("awakeTimeout(): time a frozen thread spends asleep does not count", { skip: !!process.env.UNKERNEL_DIST && "an internal of the sources" }, async () => {
		const { awakeTimeout } = await import("../js/core/snapshot.ts");
		let fired = 0;
		const t0 = performance.now();
		awakeTimeout(() => { fired = performance.now() - t0; }, 200, 20);
		// Blocked (as a frozen page) for longer than the timeout: on waking, a plain timer would fire at once.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(fired, 0, "not fired on waking");
		for (let i = 0; !fired && i < 100; i++) await new Promise((r) => setTimeout(r, 50)); // a busy test process delays the steps
		assert.ok(fired >= 400, `fired after ${fired.toFixed(0)} ms`);
	});

	test("SMP: snapshot() of a machine busy on every CPU (saved while running, repeatedly), restored with as many CPUs; every task continues, kwtest's SMP checks pass in it and across its own snapshot, restored again; another CPU count is refused",
		{ skip: !hasSmpPatch && "the kernel under test carries no SMP kernel" }, async (t) => {
		const cpus = testCpus && testCpus > 1 ? testCpus : 4;
		const vm = await boot(t, { cpus, vsock: false, log: () => {} });
		assert.equal(vm.stats().cpus, cpus);
		const a = screen(vm);
		await a.waitFor(PROMPT);
		const sh = shell(vm, a);
		// A counter per CPU and one more (busy in user mode), a pipe pair, and a reader blocked opening a fifo.
		// Each value replaces the file by a rename: a shell's read takes a byte at a time and could mix two values.
		await sh(`for i in $(seq 0 ${cpus}); do sh -c "n=0; while :; do n=\\$((n+1)); [ \\$((n % 50)) = 0 ] && echo \\$n > /tmp/c.$i.t && mv /tmp/c.$i.t /tmp/c.$i; done" & done; ` +
			"yes | sh -c 'n=0; while read l; do n=$((n+1)); [ $((n % 200)) = 0 ] && echo $n > /tmp/pipe.t && mv /tmp/pipe.t /tmp/pipe; done' & " +
			"mkfifo /tmp/ff; (read x < /tmp/ff; echo \"fifo-$x\" > /tmp/ffout) & sleep 0.5");
		// Wait until the counters' tasks have run on every CPU (field 39 of /proc/PID/stat).
		const onCpus = (s: (cmd: string) => Promise<string>) => s("for p in $(pgrep -f 'n % 50'); do cut -d' ' -f39 /proc/$p/stat; done | sort -un | tr '\\n' ' '")
			.then((o) => o.trim().split(/\s+/).filter(Boolean));
		const everyCpu = async (s: (cmd: string) => Promise<string>, label: string) => {
			for (let i = 0; ; i++) {
				const seen = await onCpus(s);
				if (seen.length >= cpus) return;
				if (i > 100) assert.fail(`${label}: the counters ran on CPUs ${seen.join(",")} only, of ${cpus}`);
				await new Promise((r) => setTimeout(r, 100));
			}
		};
		await everyCpu(sh, "before");
		const counters = async (s: (cmd: string) => Promise<string>) => (await s(`for f in $(for i in $(seq 0 ${cpus}); do echo /tmp/c.$i; done) /tmp/pipe; do v=; while [ -z "$v" ]; do read v < $f; done; echo $v; done`)).trim().split(/\s+/).map(Number);
		const advanced = async (s: (cmd: string) => Promise<string>, label: string) => {
			const c0 = await counters(s);
			assert.equal(c0.length, cpus + 2, `${label}: ${c0}`);
			await new Promise((r) => setTimeout(r, 500));
			const c1 = await counters(s);
			assert.ok(c1.every((v, i) => v > c0[i]!), `${label}: every counter advances (${c0} -> ${c1})`);
		};
		await advanced(sh, "before");

		// Saved while running, three times: the machine goes on each time.
		for (let i = 0; i < 3; i++) {
			const s = await vm.snapshot();
			assert.equal(s.cpus, cpus);
			await advanced(sh, `after snapshot ${i + 1} without stop`);
		}
		// Across the last one also a sleeper (nanosleep).
		await sh("(u0=$(cut -d' ' -f1 /proc/uptime); sleep 3; echo \"$u0 $(cut -d' ' -f1 /proc/uptime)\" > /tmp/slept) & sleep 0.5");
		const snap = sdk.decodeSnapshot(sdk.encodeSnapshot(await vm.snapshot({ stop: true })));
		assert.equal(snap.cpus, cpus, "the encoding keeps the CPU count");
		assert.equal((await vm.exited).kind, "stopped");

		await assert.rejects(boot(t, { cpus: cpus - 1, vsock: false, restore: snap, log: () => {} }), new RegExp(`snapshot: the snapshot has ${cpus} CPUs, this machine has ${cpus - 1}`));
		// Without cpus a restore takes the snapshot's.
		const vm2 = await createKernel({ kernel: testKernel, vsock: false, restore: snap, log: () => {} });
		t.after(() => vm2.stop({ reason: "test cleanup" }));
		assert.equal(vm2.stats().cpus, cpus);
		const b = screen(vm2);
		const sh2 = shell(vm2, b);
		assert.equal((await sh2("nproc")).trim(), String(cpus));
		await advanced(sh2, "restored");
		await everyCpu(sh2, "restored");
		await sh2("echo hi > /tmp/ff");
		const done = async (s: (cmd: string, ms?: number) => Promise<string>, files: string, ok: (out: string) => boolean) => {
			for (let i = 0; ; i++) {
				const out = await s(`cat ${files} 2>/dev/null; true`, 30000);
				if (ok(out)) return out;
				if (i > 480) assert.fail(`not done after the restore: ${out}`);
				await new Promise((r) => setTimeout(r, 250));
			}
		};
		const slept = await done(sh2, "/tmp/ffout /tmp/slept", (o) => /fifo-hi/.test(o) && /^\d+\.\d+ \d+\.\d+$/m.test(o));
		const [u0, u1] = /^(\d+\.\d+) (\d+\.\d+)$/m.exec(slept)!.slice(1).map(Number) as [number, number];
		assert.ok(u1 - u0 >= 2.995 && u1 - u0 < 30, `the sleep across the snapshot took ${(u1 - u0).toFixed(2)} s of guest uptime`); // /proc/uptime has 2 decimals
		assert.equal((await sh2(`dmesg | grep -cE '${KERNEL_TROUBLE}'; true`)).trim(), "0", await sh2("dmesg | tail -30"));

		// kwtest's SMP checks in the restored machine (they need idle CPUs: the counters end), then across a
		// snapshot of it (threads on several CPUs: exclusives, futexes, moves; 5 s on 4 CPUs), restored again.
		// Where the threads ran and whether a woken or exec'd task moved race with the host's load (testing.md),
		// so those checks may fail under a busy test run, but only as placement misses: no failed call (err 0),
		// every exec'd child exited with its CPU (abnormal 0), nothing read wrong (bad 0). Every count and every
		// other check must hold.
		const smpOk = (out: string) => out.split("\n").filter((l) => l.startsWith("FAIL")).every((l) =>
			/^FAIL move: a thread woken in read\(\) on a CPU a busy thread keeps: .*\(\d+ away, 0 bad, err 0\)/.test(l) ||
			/^FAIL move: exec beside a busy thread on CPU 0: \d+ of \d+ new images started on another CPU \([0-9+]+; err 0, abnormal 0, bad 0\)$/.test(l) ||
			/^FAIL smp: .* atomic add (\d+), cas (\d+), mutex (\d+) \(want \1, \2, \3\)$/.test(l));
		await sh2("pkill -f 'n % 50'; pkill yes; sleep 0.5");
		// A release bundle (KW_RELEASE=1, the release's package test) has no kwtest: only base-test.cpio does.
		const hasKwtest = (await sh2("command -v kwtest >/dev/null && echo yes; true")).trim() === "yes";
		if (hasKwtest) {
			const smpRun = await sh2("kwtest smp 2>&1 | grep -v '^ok'", 240000);
			assert.ok(/kwtest: \d+ failure\(s\)/.test(smpRun) && smpOk(smpRun), smpRun);
			await sh2("(kwtest smp > /tmp/smp.log 2>&1; echo $? > /tmp/smp.rc) & sleep 1");
		} else t.diagnostic("the bundle's initramfs has no kwtest: snapshotted again without its SMP checks");
		const snap2 = await vm2.snapshot({ stop: true });
		assert.equal(snap2.cpus, cpus);
		const vm3 = await boot(t, { cpus, vsock: false, restore: snap2, log: () => {} });
		const c = screen(vm3);
		const sh3 = shell(vm3, c);
		if (hasKwtest) {
			const rc = await done(sh3, "/tmp/smp.rc", (o) => /^\d+$/m.test(o));
			const smpLog = await sh3("grep -v '^ok' /tmp/smp.log");
			assert.ok(/kwtest: \d+ failure\(s\)/.test(smpLog) && (rc.trim() === "0" || smpOk(smpLog)), `kwtest smp across the snapshot (exit ${rc.trim()}): ${smpLog}`);
		}
		// A park cycle after the restore (fields: requests R done D result X ...).
		assert.equal((await sh3("set -- $(cat /proc/kwpark); w=$(($2 + 1)); echo 1 > /proc/kwpark; " +
			"while set -- $(cat /proc/kwpark); [ $(($4 - w)) -lt 0 ]; do usleep 10000; done; echo $6", 30000)).trim(), "0", "a park cycle after the restore");
		assert.equal((await sh3(`dmesg | grep -cE '${KERNEL_TROUBLE}'; true`)).trim(), "0", await sh3("dmesg | tail -30"));
		vm3.write("poweroff -f\n");
		assert.equal((await vm3.exited).code, 0);
	});

	test("snapshots and the CPU count: a UP snapshot is refused with more CPUs and by the SMP kernel (another build), and an SMP one by the UP kernel",
		{ skip: !hasSmpPatch && "the kernel under test carries no SMP kernel" }, async (t) => {
		const up = await WebAssembly.compile(readFileSync(kernelFile));
		const smp = await sdk.loadKernelModule(readFileSync(kernelFile), { smp: true });
		// Saved once init is done starting the shell: a vfork child parked before its exec would keep init from parking.
		const settled = async (v: Instance) => {
			const a = screen(v);
			await a.waitFor(PROMPT);
			v.write("echo up-$((6*7))\n");
			await a.waitFor(/up-42/);
		};
		const vm = await boot(t, { kernel: up, cpus: 1, vsock: false, log: () => {} });
		await settled(vm);
		const snap = await vm.snapshot({ stop: true });
		assert.equal(snap.cpus, 1);
		await assert.rejects(boot(t, { kernel: up, cpus: 2, vsock: false, restore: snap, log: () => {} }), /the snapshot has 1 CPU, this machine has 2/);
		await assert.rejects(boot(t, { kernel: smp, cpus: 1, vsock: false, restore: snap, log: () => {} }), /saved by another kernel build/);
		// A header without a CPU count (a file from before SMP snapshots) is one CPU.
		const bytes = sdk.encodeSnapshot(snap), dv = new DataView(bytes.buffer, bytes.byteOffset);
		const hlen = dv.getUint32(8, true), header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + hlen)));
		assert.equal(header.cpus, 1);
		delete header.cpus;
		const h2 = new TextEncoder().encode(JSON.stringify(header)), old = new Uint8Array(12 + h2.length + bytes.length - 12 - hlen);
		old.set(bytes.subarray(0, 8));
		new DataView(old.buffer).setUint32(8, h2.length, true);
		old.set(h2, 12);
		old.set(bytes.subarray(12 + hlen), 12 + h2.length);
		const oldSnap = sdk.decodeSnapshot(old);
		assert.equal(oldSnap.cpus, 1);
		const vmOld = await boot(t, { kernel: up, cpus: 1, vsock: false, restore: oldSnap, log: () => {} });
		const o = screen(vmOld);
		vmOld.write("echo old-file-$((6*7))\n");
		await o.waitFor(/old-file-42/);
		await vmOld.stop({ reason: "test" });
		const vmSmp = await boot(t, { kernel: smp, cpus: 2, vsock: false, log: () => {} });
		await settled(vmSmp);
		const snapSmp = await vmSmp.snapshot({ stop: true });
		assert.equal(snapSmp.cpus, 2);
		// The UP kernel runs on one CPU whatever it is offered, so it cannot resume two.
		await assert.rejects(boot(t, { kernel: up, cpus: 2, vsock: false, restore: snapSmp, log: () => {} }), /the snapshot has 2 CPUs, this machine has 1/);
	});

});

// Not with the others: it replaces WebAssembly.Memory, which every boot uses.
test("SMP: the kernel's memory is allocated once, shared, at a boot and at a restore; memoryFallbackMiB applies where a shared memory cannot be had",
	{ skip: !hasSmpPatch && "the kernel under test carries no SMP kernel" }, async (t) => {
	const kernel = await sdk.loadKernelModule(readFileSync(kernelFile), { smp: true });
	const { Memory } = WebAssembly;
	const asked: string[] = [];
	let maxSharedMiB = Infinity;
	WebAssembly.Memory = new Proxy(Memory, {
		construct(target, args: [WebAssembly.MemoryDescriptor], newTarget) {
			const mib = Number(args[0].initial) / 16;
			if (mib >= 128) asked.push(`${mib} MiB${args[0].shared ? " shared" : ""}`);
			if (args[0].shared && mib > maxSharedMiB) throw new RangeError("could not allocate memory");
			return Reflect.construct(target, args, newTarget) as WebAssembly.Memory;
		},
	});
	try {
		const opts = { kernel, cpus: 1, worker: false, vsock: false, log: () => {} };
		const vm = await boot(t, { ...opts, memoryMiB: 512 });
		const a = screen(vm);
		await a.waitFor(PROMPT);
		// Saved once init is done starting the shell (as above).
		vm.write("echo up-$((6*7))\n");
		await a.waitFor(/up-42/);
		const snap = await vm.snapshot({ stop: true });
		assert.deepEqual(asked.splice(0), ["512 MiB shared"]);

		const vm2 = await boot(t, { ...opts, restore: snap });
		const b = screen(vm2);
		vm2.write("echo restored-$((6*7))\n");
		await b.waitFor(/restored-42/);
		await vm2.stop({ reason: "test" });
		assert.deepEqual(asked.splice(0), ["512 MiB shared"]);

		maxSharedMiB = 256;
		const vm3 = await boot(t, { ...opts, memoryMiB: 512, memoryFallbackMiB: [384, 256] });
		await screen(vm3).waitFor(PROMPT);
		assert.equal(vm3.memoryMiB, 256);
		assert.deepEqual(asked, ["512 MiB shared", "384 MiB shared", "256 MiB shared"]);
	} finally {
		WebAssembly.Memory = Memory;
	}
});

// Not with the others: it changes globalThis.crossOriginIsolated, which every worker-mode boot reads.
test("worker mode: messages where SharedArrayBuffer cannot be used (a page that is not cross-origin isolated); shared: true then rejects", async (t) => {
	const g = globalThis as { crossOriginIsolated?: boolean };
	g.crossOriginIsolated = false;
	try {
		assert.equal(sdk.sharedMemoryAvailable(), false);
		await assert.rejects(createKernel({ worker: true, shared: true, log: () => {} }), (e: Error) =>
			e.name === "BootError" && (e as Error & { stage: string }).stage === "support" && /cross-origin isolated/.test(e.message));
		const vm = await boot(t, { worker: true, log: () => {}, cmdline: "console=hvc0 rdinit=/bin/true" });
		assert.equal(vm.transport, "messages");
		assert.equal((await vm.exited).code, 253);
	} finally {
		delete g.crossOriginIsolated;
	}
	assert.equal(sdk.sharedMemoryAvailable(), true);
});

test("sound ring: the owner delivers states and PCM in the kernel's order, whatever the messages' timing", async () => {
	const { SoundBridge } = await import("../js/core/worker-devices.ts");
	const { SoundRingWriter, createSoundRing } = await import("../js/core/sound-ring.ts");
	const fmt = (rate: number) => ({ rate, channels: 2, format: 2, frameBytes: 4 });
	const ring = createSoundRing(1024);
	const writer = new SoundRingWriter(ring);
	const seen: string[] = [];
	const logs: string[] = [];
	const bridge = new SoundBridge({
		onChunk: (c) => { seen.push(`pcm${c.format.rate}`); return 100; },
		onState: (_s, ev) => { seen.push(ev); },
	}, () => {}, (m) => logs.push(m), ring);
	const st = { open: true, playing: false, format: null };
	// The worker's side: a record per state, then its message (delivered late, in `msgs`).
	const msgs: Array<() => void> = [];
	let n = 0;
	const state = (ev: "open" | "prepare" | "start" | "stop" | "close") => {
		const k = ++n;
		writer.writeEvent(k, ev);
		msgs.push(() => bridge.onState(st, ev, k));
	};
	const pcm = (rate: number) => { if (writer.write(1, fmt(rate), new Uint8Array(64))) msgs.push(() => bridge.onWake()); };
	state("open"); state("prepare"); state("start"); pcm(48000);
	// The owner is behind: the next stream is in the ring before it has handled the first one's messages.
	state("stop"); state("prepare"); state("start"); pcm(8000);
	assert.equal(writer.queuedFrames(), 32, "frames in the ring count as delay");
	for (const m of msgs.splice(0)) m();
	assert.deepEqual(seen, ["open", "prepare", "start", "pcm48000", "stop", "prepare", "start", "pcm8000"]);
	assert.equal(writer.queuedFrames(), 100, "the sink's answer, nothing left in the ring");
	// A full ring: PCM is dropped and logged, the states still arrive, in order.
	seen.length = 0;
	for (let i = 0; i < 20; i++) pcm(8000);
	state("stop"); state("close");
	for (const m of msgs.splice(0)) m();
	assert.deepEqual(seen.slice(-2), ["stop", "close"]);
	assert.ok(seen.length < 22 && seen.slice(0, -2).every((x) => x === "pcm8000"), seen.join(","));
	assert.match(logs.join("\n"), /sound ring was full: \d+ bytes/);
});

test("yieldToEventLoop() resolves concurrently and across turns without setImmediate", async () => {
	const { yieldToEventLoop } = await import("../js/core/wasi.ts");
	const g = globalThis as { setImmediate?: typeof setImmediate };
	const orig = g.setImmediate;
	g.setImmediate = undefined;
	try {
		const order: number[] = [];
		await Promise.all([
			yieldToEventLoop().then(() => order.push(1)),
			yieldToEventLoop().then(() => order.push(2)),
			yieldToEventLoop().then(() => yieldToEventLoop()).then(() => order.push(3)),
		]);
		assert.deepEqual(order, [1, 2, 3]);
	} finally {
		g.setImmediate = orig;
	}
});