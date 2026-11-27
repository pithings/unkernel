#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Headless-Chromium test of the guest network in the page (Wisp), via the
// DevTools protocol (no npm dependencies; see lib.mjs). Needs internet access.
//
//   node web/test/net.mjs [--dev] [--chrome path] [--only wisp,nonet]
//        [--big URL] [--verbose]
//
// Runs against the built output (web/.output, `pnpm build:web` first), or
// with --dev against the Vite dev server. The page is opened from
// http://127.0.0.1, an origin the default Wisp server accepts, with
// ?distro=alpine (apk and wget are Alpine's; the default image is debian).
// The console runs as the distro's user, so apk runs through sudo.
//   wisp      the default Wisp server (wss://wisp.unkernel.dev:6680/): DHCP, DNS,
//             sudo apk update + apk add, http and https wget, a large download
//             (throughput), and an unresolvable name failing.
//   nonet     ?wisp=0: the guest boots without a network device, and wget
//             fails fast instead of hanging.
import { PROMPT, opt, openPage, startServer } from "./lib.mjs";

const only = opt("only", "wisp,nonet").split(",");
const big = opt("big", "http://cachefly.cachefly.net/50mb.test");

async function withPage(env, fn, query = "") {
	const port = 19000 + Math.floor(Math.random() * 1000);
	const server = await startServer({ port, host: "127.0.0.1", env });
	let page;
	try {
		page = await openPage(`net-${port}`);
		page.on((msg) => {
			if (msg.method === "Runtime.exceptionThrown") console.error("  [exception]", msg.params.exceptionDetails.exception?.description);
		});
		await page.goto(`http://127.0.0.1:${port}/?distro=alpine${query ? `&${query}` : ""}`);
		await page.waitScreen(PROMPT, "shell prompt", 180000);
		await fn({ run: page.run, hostLog: async () => page.consoleLines.join("\n") });
	} finally {
		await page?.close();
		await server.kill();
	}
}

const results = [];
const check = (name, ok, detail = "") => {
	results.push(ok);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const attempt = async (name, f) => {
	try { await f(); } catch (e) { check(`${name}: exception`, false, e.stack ?? e.message); }
};

if (only.includes("wisp")) await attempt("wisp", async () => {
	console.log("== Wisp");
	await withPage({}, async ({ run, hostLog }) => {
		let r = await run("ip -4 -o addr show eth0 | awk '{print $4}'; cat /etc/resolv.conf");
		check("dhcp", /10\.0\.2\.15\/24/.test(r.out) && /nameserver 10\.0\.2\.3/.test(r.out), r.out.replace(/\n/g, " | "));
		r = await run("sudo apk update 2>&1 | tail -1", 300000);
		check("apk update", r.rc === 0 && /OK: \d+ distinct packages/.test(r.out), `${r.out} (${r.secs.toFixed(1)} s)`);
		check("wisp server chosen", /wisp connected: \S+/.test(await hostLog()), (await hostLog()).match(/wisp connected: [^\n]*/)?.[0] ?? "no log line");
		r = await run("sudo apk add tree >/dev/null && tree -L 1 /etc/apk | tail -1", 300000);
		check("apk add tree", r.rc === 0 && /directories/.test(r.out), `${r.out} (${r.secs.toFixed(1)} s)`);
		r = await run("wget -q -O- http://example.com | grep -o '<title>[^<]*'");
		check("wget http", r.rc === 0 && /Example Domain/.test(r.out), r.out);
		r = await run("wget -q -O- https://example.com | grep -o '<title>[^<]*'");
		check("wget https", r.rc === 0 && /Example Domain/.test(r.out), `${r.out} (${r.secs.toFixed(1)} s)`);
		r = await run(`wget -O /dev/null '${big}' 2>&1 | tail -1; grep eth0 /proc/net/dev | awk '{print $2}'`, 600000);
		const bytes = Number(r.out.split(/\s+/).pop());
		check("large download", r.rc === 0 && bytes > 1e6,
			`${r.out.split("\n")[0]}; ${(bytes / 1048576).toFixed(1)} MiB received on eth0 in total; this download took ${r.secs.toFixed(1)} s incl. shell round trip`);
		r = await run("wget -q -T 10 -O- http://nonexistent.invalid/ 2>&1", 60000);
		check("unresolvable name fails", r.rc !== 0 && r.secs < 30, `${r.out} (${r.secs.toFixed(1)} s)`);
	});
});

if (only.includes("nonet")) await attempt("nonet", async () => {
	console.log("== no network (?wisp=0)");
	await withPage({}, async ({ run }) => {
		const r = await run("wget -q -T 5 -O- http://example.com 2>&1", 60000);
		check("wget fails fast without network", r.rc !== 0 && r.secs < 20, `${r.out} (${r.secs.toFixed(1)} s)`);
	}, "wisp=0");
});

const ok = results.length > 0 && results.every(Boolean);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
