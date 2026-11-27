#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Headless-Chromium tests of the page (web/), via the DevTools protocol
// (no npm dependencies; see lib.mjs).
//
//   node web/test/headless.mjs [--dev] [--chrome /path/to/chrome]
//        [--shots DIR] [--only desktop,mobile,nojspi,fetch404,modfail,lowmem] [--lan-ip A.B.C.D] [--verbose]
//
// Runs against the built output (web/.output, `pnpm build:web` first), or
// with --dev against the Vite dev server.
//
// Scenarios:
//   desktop   1440x900 on http://127.0.0.1 (a secure context): boot to the
//             shell prompt, run a command, check that kwemu's JIT tier
//             compiled hot code (KW.jitStats()), check cross-origin
//             isolation (the COOP/COEP route rule), open System's window (the
//             top bar's Control Center, #tb-status, then its System…,
//             #tb-cc-system): the boot stages, every option's control in
//             Settings, the kernel log.
//   mobile    360x740 phone emulation (touch, Android UA, DPR 3) loaded from
//             the machine's LAN IP over plain http (NOT a secure context, like
//             a phone on the LAN): boot, type through the terminal's textarea
//             and the touch key bar (incl. sticky Ctrl), shrink the viewport
//             as the on-screen keyboard would, open System's window and Copy
//             diagnostics there.
//   nojspi    ?simulate=nojspi: the status icon turns red and System's
//             window opens on Errors with the JSPI error; the boot module is
//             never loaded.
//   fetch404  the kernel download answers 404 (request interception):
//             System's window opens on Errors with the 404.
//   modfail   the network drops the boot module (boot-*.js, or src/boot.ts
//             with --dev): main.tsx reports it in System's Errors.
//   lowmem    ?simulate=lowmem&mem=512: allocations above 128 MiB fail, the
//             SDK falls back to 128 MiB and the default image still boots to the shell
//             and runs a command. (kwtest is not in release bundles, which
//             the built page runs.)
// Layout checks (nothing overflows or overlaps) run at both viewports. The
// page is the desktop (components/App.tsx): #desktop with the windows, the
// key bar (#keys) and the Dock (#dock) below it, the top bar (#topbar) over
// its top; Settings and System are windows (sysapps.ts: #settings, #system,
// with class open while shown), and the console is terminal 0 (#term) in its
// Terminal window.
// Screenshots go to --shots (default: $TMPDIR/unkernel-shots).
import { mkdirSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { findChrome, opt, openPage as open, sleep, startServer } from "./lib.mjs";

const shots = opt("shots", path.join(process.env.TMPDIR ?? tmpdir(), "unkernel-shots"));
const only = opt("only", "desktop,mobile,nojspi,fetch404,modfail,lowmem").split(",");
mkdirSync(shots, { recursive: true });

function lanIp() {
	const explicit = opt("lan-ip");
	if (explicit) return explicit;
	for (const list of Object.values(networkInterfaces()))
		for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
	return null;
}

const port = 18000 + Math.floor(Math.random() * 1000);
const server = await startServer({ port });
const chromePath = findChrome();
const lan = lanIp();
const openPage = (name) => open(name, { shots });

const MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36";
const PHONE = { width: 360, height: 740, deviceScaleFactor: 3, mobile: true };
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

// Layout invariants: no horizontal overflow; the desktop, the key bar, the
// Dock (and its pill), the top bar (unless the on-screen keyboard hides it)
// and its status icon inside the viewport; the desktop, the key bar
// and the Dock not overlapping one another (the top bar lies over the
// desktop by design), nor the top bar's two sides; the console's terminal
// grid fits its box.
const LAYOUT = `(() => {
	const vw = innerWidth, vh = innerHeight, bad = [];
	const R = (s) => { const e = document.querySelector(s); if (!e || e.offsetParent === null && getComputedStyle(e).position !== 'fixed') return null; return e.getBoundingClientRect(); };
	const inside = (n, r) => { if (r && (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5)) bad.push(n + ' outside viewport ' + JSON.stringify([r.left, r.top, r.right, r.bottom])); };
	const over = (a, b, ra, rb) => { if (ra && rb && ra.left < rb.right - 0.5 && rb.left < ra.right - 0.5 && ra.top < rb.bottom - 0.5 && rb.top < ra.bottom - 0.5) bad.push(a + ' overlaps ' + b); };
	if (document.documentElement.scrollWidth > vw + 0.5) bad.push('page scrolls horizontally: ' + document.documentElement.scrollWidth);
	const dock = R('#dock'), pill = R('#dock .dock-pill'), desk = R('#desktop'), keys = R('#keys');
	const top = R('#topbar'), status = R('#tb-status');
	inside('dock', dock); inside('dock pill', pill); inside('desktop', desk); inside('keys', keys); inside('top bar', top); inside('status icon', status);
	over('dock', 'desktop', dock, desk); over('desktop', 'keys', desk, keys); over('keys', 'dock', keys, dock);
	over('top bar menus', 'top bar status', R('#topbar .tb-left'), R('#topbar .tb-right'));
	const t = globalThis.term, tEl = document.getElementById('term'), term = R('#term'), grid = R('#term .term-grid');
	if (grid && term && grid.right > term.right + 0.5) bad.push('terminal grid clipped: ' + JSON.stringify([grid.right, term.right]));
	const rowH = parseFloat(getComputedStyle(tEl).getPropertyValue('--term-row-height'));
	if (t && rowH && t.rows * rowH > tEl.clientHeight + 0.5) bad.push('terminal rows do not fit: ' + t.rows + ' x ' + rowH + ' px > ' + tEl.clientHeight);
	return { bad, vw, vh, cols: t?.cols, rows: t?.rows, keys: !!keys && keys.height > 0 };
})()`;
async function checkLayout(page, label) {
	const l = await page.evaluate(LAYOUT);
	console.log(`  layout ${label}: ${l.vw}x${l.vh}, terminal ${l.cols}x${l.rows}, key bar ${l.keys ? "shown" : "hidden"}${l.bad.length ? `\n    PROBLEMS: ${l.bad.join("; ")}` : ", ok"}`);
	if (l.bad.length) throw new Error(`layout problems at ${label}: ${l.bad.join("; ")}`);
	return l;
}
const ENV = `({ secure: isSecureContext, isolated: crossOriginIsolated, clipboard: !!navigator.clipboard, deviceMemory: navigator.deviceMemory ?? null,
	sab: typeof SharedArrayBuffer, jspi: typeof WebAssembly.Suspending, mem: KW.memActualMiB, origin: location.origin })`;
// The text of the terminal's first fully visible row (wterm mounts rows as .term-row elements).
const TOP_ROW = `(() => {
	const t = document.getElementById('term'), top = t.getBoundingClientRect().top;
	const r = [...t.querySelectorAll('.term-grid .term-row')].find((e) => e.getBoundingClientRect().top >= top - 1);
	return r ? r.textContent.replace(/\\u00a0/g, ' ').trimEnd() : '';
})()`;
// Keyboard focus is in the console's textarea (so the on-screen keyboard is up).
const TERM_FOCUSED = "document.activeElement?.tagName === 'TEXTAREA' && document.getElementById('term').contains(document.activeElement)";
// The prompt is "~ ⇒ " on every distro (guest/distro/*/rootfs/etc/profile.d/kw-prompt.sh).
const PROMPT = "/⇒\\s*$/m";
// System's window is shown (sysapps.ts: its element #system has class open while it is).
const SYSTEM_OPEN = "document.getElementById('system')?.classList.contains('open')";

// --- scenarios -----------------------------------------------------------------
const envs = {};
const scenarios = {
	async desktop(page) {
		await page.emulate(DESKTOP);
		const t0 = performance.now();
		await page.goto(`http://127.0.0.1:${port}/`);
		await page.waitScreen(PROMPT, "shell prompt");
		console.log(`  shell prompt after ${((performance.now() - t0) / 1000).toFixed(1)} s, state=${await page.state()}`);
		if ((await page.state()) !== "running") throw new Error("indicator is not 'running' at the prompt");
		// The boot transcript is not scrolled away: the screen starts with the banner.
		const top = await page.evaluate(TOP_ROW);
		if (!/^unkernel · Linux on WebAssembly/.test(top)) throw new Error(`the screen does not start with the banner: ${JSON.stringify(top)}`);
		await page.evaluate(`globalThis.kernel.sendInput(${JSON.stringify("cat /etc/os-release | head -2; uname -m; echo $((7*6))\r")})`);
		const s = await page.waitScreen("/^42\\s*$/m", "command output");
		if (!/aarch64/.test(s)) throw new Error("uname -m did not print aarch64");
		console.log(s.split("\n").filter((l) => l.trim()).slice(-4).map((l) => `    | ${l}`).join("\n"));
		// The host steps stay above the summary. Kernel messages go
		// only to the Kernel log tab (the terminal showed them on its transient line).
		// "Starting Linux" was the transient line, which "Started Linux" replaced.
		const iOk = s.search(/^\[  OK  \] Checked browser/m), iStarted = s.search(/^\[  OK  \] Started Linux/m);
		if (iOk < 0 || iStarted < iOk || !/^\W*Booted in /m.test(s)) // Pip (half blocks) may stand left of it
			throw new Error("host steps not kept above \"Started Linux\", or the summary is missing");
		if (/Starting Linux/.test(s)) throw new Error("\"Starting Linux\" is still on the terminal next to \"Started Linux\"");
		if (/^\[ *\d+\.\d+\] /m.test(s)) throw new Error("kernel messages on the terminal (they belong in the Kernel log tab)");
		// User output from before "Started Linux" is drawn once, below the summary.
		const welcomes = s.match(/^Welcome to /gm)?.length ?? 0;
		if (welcomes !== 1 || s.search(/^Welcome to /m) < iStarted) throw new Error(`the welcome line is on the terminal ${welcomes} time(s), or above "Started Linux"`);
		if (!/Linux version/.test(await page.evaluate("KW.ui.diagText()"))) throw new Error("the kernel log has no \"Linux version\"");
		console.log(`  ${s.match(/Booted in .*$/m)[0]}`);
		const k = await page.evaluate("KW.config.kernelUrl");
		if (!/\/unkernel(?!-smp)[^/]*\.wasm(\.gz)?$/.test(k)) throw new Error(`the kernel is not the base bundle unkernel.wasm: ${k}`);
		const distro = await page.evaluate("KW.config.distro?.url ?? ''");
		if (!/^(\/distros\/|https:\/\/\S+\/)debian(-[0-9a-f]{16})?\.erofs$/.test(distro)) throw new Error(`the default distro is not the debian image: ${distro}`);
		console.log(`  kernel ${k}, distro ${distro}`);
		// kwemu's JIT tier works here too (lowered kernel, page main thread): hot code gets compiled.
		await page.evaluate(`globalThis.kernel.sendInput(${JSON.stringify("head -c 4000000 /dev/zero | sha256sum | cut -c1-16; echo jit-$((6*7))\r")})`);
		await page.waitScreen("/^jit-42\\s*$/m", "sha256sum output");
		const j = await page.evaluate("KW.jitStats()");
		console.log(`  jit: ${j.compiled} compiled, ${j.live} live (max ${j.maxLive}), ${j.failed} failed, ${j.compileMs.toFixed(0)} ms compiling ${(j.bytes / 1024).toFixed(0)} KiB`);
		if (!j.enabled || !j.requested || !(j.compiled > 0) || j.failed) throw new Error(`the JIT tier did not compile: ${JSON.stringify(j)}`);
		// Clipboard: a paste into the terminal reaches the shell, and a selected row copies as its text.
		await page.evaluate(`(() => {
			const dt = new DataTransfer();
			dt.setData("text/plain", "echo pasted-$((40+2))\\r");
			document.querySelector("#term textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
		})()`);
		await page.waitScreen("/^pasted-42\\s*$/m", "pasted command output");
		// wterm selects only painted rows (its renderer refuses while a repaint is
		// pending), and the output was read from the terminal core before the
		// next animation frame drew it: try for a few frames.
		const copied = await page.evaluate(`(async () => {
			const row = KW.screenText().split("\\n").lastIndexOf("pasted-42");
			if (row < 0) return null;
			let selected = false;
			for (let i = 0; i < 30 && !(selected = term.selectLine(row)); i++) await new Promise((r) => requestAnimationFrame(r));
			if (!selected) return null;
			const dt = new DataTransfer();
			document.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
			term.clearSelection();
			return dt.getData("text/plain");
		})()`);
		console.log(`  clipboard: paste ran, copy gave ${JSON.stringify(copied)}`);
		if (copied?.trim() !== "pasted-42") throw new Error(`copying a selected row gave ${JSON.stringify(copied)}`);
		if (await page.evaluate("getComputedStyle(document.getElementById('keys')).display !== 'none'")) throw new Error("the key bar is shown on desktop");
		envs.desktop = await page.evaluate(ENV);
		if (!envs.desktop.isolated || envs.desktop.sab !== "function") throw new Error(`not cross-origin isolated: ${JSON.stringify(envs.desktop)}`);
		await checkLayout(page, "desktop");
		await page.shot("desktop.png");
		await page.click("#tb-status");
		await page.waitFor("!!document.getElementById('tb-cc-system')", "the Control Center open");
		await page.click("#tb-cc-system");
		await page.waitFor(SYSTEM_OPEN, "System's window open");
		const tl = await page.evaluate("['preflight', 'kernel', 'compile', 'memory', 'boot', 'userspace'].map(id => id + ' ' + KW.ui.stageState(id))");
		if (tl.some((l) => !/ (done|skip)$/.test(l))) throw new Error(`boot stages incomplete: ${tl.join(", ")}`);
		await page.shot("desktop-system.png");
		// Every option has a control, and the settings Reboot saves follow them (defaults save nothing).
		// Check boxes and radios are set as a script would; the page renders on the next task.
		const opts = await page.evaluate(`(async () => {
			const $ = (id) => document.getElementById(id);
			const tick = () => new Promise((r) => setTimeout(r, 50));
			const set = (id, v, ev = "change") => { $(id).value = v; $(id).dispatchEvent(new Event(ev)); };
			const check = (id, on) => { $(id).checked = on; $(id).dispatchEvent(new Event("change")); };
			const net = (v) => check("opt-net-" + v, true);
			const range = (id, v) => set(id, String($(id).dataset.values.split(",").indexOf(v)), "input");
			const mem = (v) => range("opt-mem", v);
			const before = KW.ui.nextSettings();
			mem("64"); net("custom"); set("opt-wisp", "wss://a.example/, wss://b.example/", "input");
			check("opt-jit", false); check("opt-verbose", true); set("opt-append", "console=hvc0 rdinit=/bin/sh", "input");
			check("opt-data", false); check("opt-root", true); check("opt-worker", true);
			// CPUs: only where the page has the SMP kernel and may boot it (else the slider is disabled).
			const cpus = !$("opt-cpus").disabled && $("opt-cpus").dataset.values.split(",").includes("2");
			if (cpus) range("opt-cpus", "2");
			// Distro: none (the base shell) is always there; the default is the radio checked now.
			const distroDefault = document.querySelector("#opt-distro input:checked")?.id;
			// Guest GL, before the distro: its box is disabled with another distro (and without a renderer or WebGL2), its value kept.
			check("opt-gl", true);
			check("opt-distro-none", true);
			// Suspend in the background: this device's default is the radio checked now; Ask before closing is on.
			const autoDefault = document.querySelector("#opt-autosuspend input:checked")?.id;
			check("opt-autosuspend-30", true); check("opt-askleave", false);
			await tick();
			const all = KW.ui.nextSettings(), wispShown = !$("opt-wisp-row").hidden, label = $("reboot").textContent;
			net("off");
			const off = KW.ui.nextSettings();
			mem("auto"); net("default"); check("opt-jit", true); check("opt-verbose", false); set("opt-append", "", "input");
			check("opt-data", true); check("opt-root", false); check("opt-worker", false);
			if (cpus) range("opt-cpus", "1");
			if (distroDefault) check(distroDefault, true);
			if (autoDefault) check(autoDefault, true);
			check("opt-askleave", true);
			check("opt-gl", false);
			await tick();
			return { before, all, wispShown, label, off, reset: KW.ui.nextSettings(), wispHidden: $("opt-wisp-row").hidden, cpus, distroDefault, autoDefault, workerDefault: KW.config.workerDefault, cpuNext: !KW.config.smpBlocked && KW.config.cpuSuggested || 1 };
		})()`);
		const q = new URLSearchParams(opts.all);
		// The page runs at ?worker=0&cpus=1 (lib.mjs goto()): only those, where they differ from the defaults.
		const home = new URLSearchParams(opts.before);
		if (JSON.stringify(opts.before) !== JSON.stringify(opts.reset) || [...home.keys()].some((k) => k !== "worker" && k !== "cpus") || !opts.wispShown || !opts.wispHidden || opts.label !== "Reboot to apply"
			|| q.get("mem") !== "64" || q.get("wisp") !== "wss://a.example/,wss://b.example/" || q.get("jit") !== "0" || q.get("verbose") !== "1"
			|| q.get("append") !== "console=hvc0 rdinit=/bin/sh" || q.get("data") !== "0" || q.get("root") !== "initramfs" || q.get("worker") !== (opts.workerDefault ? null : "1") || q.get("cpus") !== (opts.cpus && opts.cpuNext !== 2 ? "2" : null) || opts.distroDefault !== "opt-distro-debian" || q.get("distro") !== "none" || opts.off.wisp !== "0"
			|| opts.autoDefault !== "opt-autosuspend-0" || q.get("autosuspend") !== "30" || q.get("askleave") !== "0" || q.get("gl") !== "1")
			throw new Error(`options do not map to the settings: ${JSON.stringify(opts)}`);
		console.log(`  options -> ${q}`);
		await page.click('#system [data-tab="log"]');
		const log = await page.evaluate("document.getElementById('log').textContent");
		if (!/Run \/init as init process/.test(log)) throw new Error("kernel log tab lacks the dmesg lines");
		await page.shot("desktop-system-log.png");
	},

	async mobile(page) {
		const host = lan ?? "127.0.0.1";
		await page.emulate(PHONE, { touch: true, ua: MOBILE_UA });
		const t0 = performance.now();
		await page.goto(`http://${host}:${port}/`);
		await page.waitScreen(PROMPT, "shell prompt");
		console.log(`  shell prompt after ${((performance.now() - t0) / 1000).toFixed(1)} s via http://${host} (state=${await page.state()})`);
		envs.mobile = await page.evaluate(ENV);
		const l = await checkLayout(page, "phone 360x740");
		if (l.keys) throw new Error("the key bar is shown without the on-screen keyboard");
		if (l.cols < 36) throw new Error(`only ${l.cols} columns on a 360 px phone`);
		await page.shot("mobile.png");

		// Touch scrolling is the browser's own (#term is the scroll container): a swipe
		// down scrolls back and keeps going after the finger lifts (momentum). The
		// scrollbar is the browser's too (an overlay on phones). The boot transcript
		// (host steps, and the kernel's messages on one line) is short, so print
		// enough to scroll through first.
		const scrollY = () => page.evaluate("document.getElementById('term').scrollTop");
		await page.evaluate(`globalThis.kernel.sendInput("seq 200\\r")`);
		await page.waitScreen("/^200\\s*$/m", "seq output");
		const base = await scrollY();
		if (base < 1000) throw new Error(`only ${base} px of scrollback after seq 200`);
		// The synthesized swipe's speed depends on DevTools round trips, and a slow
		// one ends without a fling: up to 3 swipes (each scrolls ~500 px).
		let start = base, lifted = base, coasted = base;
		for (let i = 0; i < 3; i++) {
			start = coasted;
			await page.swipe("#term", 300);
			lifted = await scrollY();
			await sleep(600);
			coasted = await scrollY();
			console.log(`  touch scroll: ${start} -> ${lifted} px at lift -> ${coasted} px after momentum`);
			if (!(lifted < start)) throw new Error("a swipe down did not scroll the terminal back");
			if (coasted < lifted) break;
		}
		if (!(coasted < lifted)) throw new Error("no momentum: the terminal stopped when the finger lifted (3 swipes)");
		await page.shot("mobile-scrolled.png");
		await page.evaluate("(() => { const t = document.getElementById('term'); t.scrollTop = t.scrollHeight; })()");
		await sleep(100);

		// Tap the terminal: focus must land in the terminal's textarea (keyboard opens).
		await page.tap("#term");
		if (!(await page.evaluate(TERM_FOCUSED))) throw new Error("tapping the terminal did not focus it");
		const barShown = "getComputedStyle(document.getElementById('keys')).display !== 'none'";
		if (await page.evaluate(barShown)) throw new Error("the key bar is shown before the viewport shrank (no on-screen keyboard)");
		// On-screen keyboard: the layout viewport shrinks to ~420 px, and the key bar comes up.
		await page.emulate({ ...PHONE, height: 420 }, { touch: true });
		await sleep(400);
		const k = await checkLayout(page, "phone with keyboard 360x420");
		if (!k.keys) throw new Error("the key bar is not shown with the on-screen keyboard up");
		if (!(k.rows < l.rows)) throw new Error("terminal did not shrink with the keyboard");
		await page.shot("mobile-keyboard.png");
		// Typed text + key bar '|' + Enter.
		await page.typeText("echo abc ");
		await page.tap('#keys [data-key="|"]');
		if (!(await page.evaluate(TERM_FOCUSED))) throw new Error("key bar stole focus (the keyboard would close)");
		await page.typeText(" tr a-z A-Z");
		await page.enter();
		await page.waitScreen("/^ABC\\s*$/m", "piped output via key bar");
		// Sticky Ctrl: Ctrl then 'u' kills the line typed so far.
		await page.typeText("echo junk");
		await page.tap('#keys [data-key="ctrl"]');
		if ((await page.evaluate("document.querySelector('#keys [data-key=ctrl]').getAttribute('aria-pressed')")) !== "true") throw new Error("Ctrl did not latch");
		await page.typeText("u");
		await page.typeText("echo ctrl-$((6*7))");
		await page.enter();
		const s = await page.waitScreen("/^ctrl-42\\s*$/m", "Ctrl-U then command");
		if (/junkecho/.test(s)) throw new Error("Ctrl-U was not applied");
		// Arrow key from the bar: recall the previous command.
		await page.tap('#keys [data-key="up"]');
		await page.waitScreen("/echo ctrl-\\$\\(\\(6\\*7\\)\\)\\s*$/m", "history recall via ↑ key");
		await page.tap('#keys [data-key="^c"]');
		console.log("  typing, key bar (|, Ctrl latch, ↑, ^C) ok");
		// Keyboard closed (viewport back to full height): the bar goes away.
		await page.emulate(PHONE, { touch: true });
		await sleep(300);
		if (await page.evaluate(barShown)) throw new Error("the key bar stayed after the on-screen keyboard closed");

		// Landscape.
		await page.emulate({ ...PHONE, width: 740, height: 360 }, { touch: true });
		await sleep(400);
		await checkLayout(page, "phone landscape 740x360");
		await page.shot("mobile-landscape.png");
		await page.emulate(PHONE, { touch: true });
		await sleep(300);

		await page.tap("#tb-status");
		await page.waitFor("!!document.getElementById('tb-cc-system')", "the Control Center open");
		await page.tap("#tb-cc-system");
		await page.waitFor(SYSTEM_OPEN, "System's window open");
		await page.shot("mobile-system.png");
		await page.tap('#system [data-tab="log"]');
		await page.shot("mobile-system-log.png");
		// Copy diagnostics without the Clipboard API (insecure origin): textarea fallback.
		await page.tap("#copy");
		const fallback = await page.evaluate("!document.getElementById('copy-area').hidden && document.getElementById('copy-area').value.includes('== environment')");
		if (!envs.mobile.secure && !fallback) throw new Error("copy diagnostics did not fall back to a textarea");
	},

	async nojspi(page) {
		await page.emulate(PHONE, { touch: true, ua: MOBILE_UA });
		await page.goto(`http://127.0.0.1:${port}/?simulate=nojspi`);
		await page.waitFor("document.getElementById('app').dataset.state === 'error'", "error state", 15000);
		const r = await page.evaluate(`({ open: ${SYSTEM_OPEN},
			msg: document.getElementById('fatal-msg').textContent, hint: document.getElementById('fatal-hint').textContent,
			dot: getComputedStyle(document.getElementById('tb-status')).color, moduleLoaded: !!KW.started })`);
		console.log(`  System open=${r.open}, status icon=${r.dot}, message: ${r.msg}`);
		if (!r.open) throw new Error("System's window did not open on the fatal error");
		if (!/JSPI/.test(r.msg) || !/137/.test(r.hint)) throw new Error("System's Errors do not explain the missing JSPI");
		if (r.dot !== "rgb(255, 97, 102)") throw new Error("the status icon is not red");
		if (r.moduleLoaded) throw new Error("the boot module was loaded although the preflight failed");
		await checkLayout(page, "phone error");
		await page.shot("mobile-error-nojspi.png");
	},

	async fetch404(page) {
		await page.emulate(DESKTOP);
		await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/unkernel*.wasm*" }] });
		page.on((m) => {
			if (m.method === "Fetch.requestPaused") page.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 404, body: Buffer.from("not found\n").toString("base64") });
		});
		await page.goto(`http://127.0.0.1:${port}/`);
		await page.waitFor("document.getElementById('app').dataset.state === 'error'", "error state", 20000);
		const r = await page.evaluate(`({ open: ${SYSTEM_OPEN}, msg: document.getElementById('fatal-msg').textContent,
			errors: KW.errors.map(e => e.kind + ': ' + e.message), kernelStage: KW.ui.stageState('kernel'), screen: KW.screenText() })`);
		console.log(`  ${r.msg} (failed stage: ${r.kernelStage})`);
		if (!r.open || !/404/.test(r.msg) || r.kernelStage !== "fail" || !/^\[FAILED\] Download the kernel/m.test(r.screen)) throw new Error(`unexpected: ${JSON.stringify(r)}`);
		await page.shot("desktop-error-404.png");
	},

	async modfail(page) {
		await page.emulate(PHONE, { touch: true, ua: MOBILE_UA });
		await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/assets/boot-*.js*" }, { urlPattern: "*/src/boot.ts*" }] });
		page.on((m) => {
			if (m.method === "Fetch.requestPaused") page.send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "ConnectionReset" });
		});
		await page.goto(`http://127.0.0.1:${port}/`);
		await page.waitFor("document.getElementById('app').dataset.state === 'error'", "error state", 30000);
		const r = await page.evaluate(`({ open: ${SYSTEM_OPEN}, msg: document.getElementById('fatal-msg').textContent,
			boot: document.getElementById('tb-boot-msg')?.textContent })`);
		const started = await page.evaluate("!!KW.started");
		console.log(`  ${r.msg}`);
		if (!r.open || !/boot module/.test(r.msg) || started) throw new Error(`unexpected: ${JSON.stringify(r)}`);
		await page.shot("mobile-error-module.png");
	},

	async lowmem(page) {
		await page.emulate(DESKTOP);
		await page.goto(`http://127.0.0.1:${port}/?simulate=lowmem&mem=512`);
		await page.waitScreen(PROMPT, "shell prompt");
		await page.evaluate(`globalThis.kernel.sendInput(${JSON.stringify("echo $((7*6))\r")})`);
		await page.waitScreen("/^42\\s*$/m", "command output");
		const r = await page.evaluate(`({ state: document.getElementById('app').dataset.state, mem: KW.memActualMiB, label: document.getElementById('tb-status-label').textContent })`);
		console.log(`  state=${r.state} (${r.label}), allocated ${r.mem} MiB`);
		if (r.state !== "running" || r.mem !== 128) throw new Error(`unexpected: ${JSON.stringify(r)}`);
	},
};

let failed = 0;
try {
	console.log(`chrome: ${chromePath}\nserver: ${server.kind}, http://127.0.0.1:${port}/ (LAN ${lan ?? "none found"})\nscreenshots: ${shots}`);
	for (const name of only) {
		if (!scenarios[name]) { console.log(`unknown scenario ${name}`); failed++; continue; }
		console.log(`\n[${name}]`);
		const page = await openPage(name);
		try {
			await scenarios[name](page);
			const unexpected = ["nojspi", "fetch404", "modfail"].includes(name) ? [] : page.exceptions;
			if (unexpected.length) throw new Error(`uncaught page exceptions: ${unexpected.join(" | ")}`);
			console.log(`  PASS ${name}`);
		} catch (e) {
			failed++;
			console.log(`  FAIL ${name}: ${e.message}`);
			try { await page.shot(`FAIL-${name}.png`); } catch {}
		} finally {
			await page.close();
		}
	}
	if (envs.desktop && envs.mobile) {
		console.log("\nlocalhost vs LAN origin:");
		for (const k of Object.keys(envs.desktop))
			console.log(`  ${k.padEnd(13)} ${String(envs.desktop[k]).padEnd(28)} ${envs.mobile[k]}${String(envs.desktop[k]) !== String(envs.mobile[k]) ? "   <- differs" : ""}`);
	}
} finally {
	await server.kill();
}
console.log(failed ? `\nFAIL (${failed})` : "\nPASS");
process.exit(failed ? 1 : 0);
