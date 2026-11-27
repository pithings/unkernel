// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Prototype check of WASI programs run by the guest on the host's wasm
// engine (guest/src/kwwasi.c, js/core/wasi-exec.ts), on Alpine. Builds
// kwwasi and the test programs in test/wasi/ with zig (aarch64-linux-musl
// and wasm32-wasi; threads.zig with zig build-exe), mounts them in the guest, copies kwwasi to /usr/lib/kw,
// registers it with the guest's binfmt_misc (the kw layer does that at
// boot), and runs the programs by path.
//
//   node test/wasi-binfmt.ts [--worker] [--messages]
//   --messages                      requests as messages and JSPI (the fallback),
//                                   not through a SharedArrayBuffer
//   UNKERNEL_TEST_KERNEL=path ...   another bundle instead of the bundled kernel
//   UNKERNEL_TEST_DISTRO_DIR=dir    where alpine.erofs is (default vendor/build/distro)
//   UNKERNEL_TEST_CPUS=n ...        CPUs for an SMP kernel (implies a worker)
//
// Exit 0 when every check passes. It checks argv[0], paths against the cwd
// and "/" (KWWASI_CWD), file-system calls (fd_readdir's cookies, errors,
// fd_allocate, fd_fdstat_set_flags, the umask), the clocks (the guest's
// realtime and monotonic, CPU time, unknown clocks), preview 0 calls, sockets (KWWASI_TCPLISTEN's and
// ones inherited from busybox nc), wasi-threads (file I/O in several
// threads, one blocked on stdin beside them, proc_exit and a trap in a
// thread, kills; on --messages a clean refusal), and that a module is sent only
// when the host has not compiled it for that file (rewrites in the guest
// and on the host). Each program runs in a worker of its own:
// it checks that the guest and its console go on while one computes, that
// a kill ends the worker at once, and two programs at a time. It prints the
// time of a compute loop as wasm on the host (cold, then with the compiled
// module cached) and as aarch64 in the guest, how fast a small program
// starts with and without idle workers, a 16 MiB copy through kwwasi and
// what one small request costs.
// With one CPU it also saves a snapshot with programs running (one
// computing, one waiting for its stdin, one blocked writing to a full pipe,
// and on the shared path one with two threads computing),
// stops, resumes it and checks that kwwasi tells them they are gone. A host
// of its own on kwwasi's port checks kwwasi's side of the protocol's ends.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel, nodeFs, serveWasiPrograms, type VsockConnection } from "../js/node.ts";
import { wasiErrno } from "../js/core/wasi-program.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = process.argv.includes("--worker");
const messages = process.argv.includes("--messages");
const kernel = process.env.UNKERNEL_TEST_KERNEL ? path.resolve(process.env.UNKERNEL_TEST_KERNEL) : undefined;
const distro = path.join(path.resolve(process.env.UNKERNEL_TEST_DISTRO_DIR ?? path.join(root, "vendor/build/distro")), "alpine.erofs");
if (!existsSync(distro)) {
	console.log(`FAIL: no ${distro} (kernel/build.sh distro alpine)`);
	process.exit(1);
}
const cpus = Number(process.env.UNKERNEL_TEST_CPUS) || undefined;
const zig = process.env.ZIG ?? "zig";

const dir = mkdtempSync(path.join(tmpdir(), "kwwasi-"));
const cc = (target: string, src: string, out: string, flags: string[] = []) =>
	execFileSync(zig, ["cc", "-target", target, "-O2", "-s", ...(target.startsWith("aarch64") ? ["-mcpu=generic", "-static"] : []), ...flags, "-o", path.join(dir, out), src]);
cc("aarch64-linux-musl", path.join(root, "guest/src/kwwasi.c"), "kwwasi");
for (const t of ["hello", "cat", "ls", "loop", "trap", "calls", "put", "sock", "fs", "clock"]) cc("wasm32-wasi", path.join(root, "test/wasi", `${t}.c`), `${t}.wasm`);
cc("wasm32-wasi", path.join(root, "test/wasi/p0.c"), "p0.wasm", ["-nostdlib", "-fno-builtin"]);
// Two modules of the same size that print different things.
for (const v of ["A", "B"]) cc("wasm32-wasi", path.join(root, "test/wasi/ver.c"), `ver${v}.wasm`, [`-DVARIANT="${v}"`]);
assert.equal(statSync(path.join(dir, "verA.wasm")).size, statSync(path.join(dir, "verB.wasm")).size);
cc("aarch64-linux-musl", path.join(root, "test/wasi/loop.c"), "loop.a64");
cc("aarch64-linux-musl", path.join(root, "test/wasi/sockclient.c"), "sockclient");
cc("aarch64-linux-musl", path.join(root, "test/wasi/clock.c"), "clock.a64");
// wasi-threads: zig's wasi-libc has no pthreads (its thread stub), so this one is Zig (std.Thread).
execFileSync(zig, ["build-exe", path.join(root, "test/wasi/threads.zig"), "-target", "wasm32-wasi", "-mcpu=generic+atomics+bulk_memory",
	"-fno-single-threaded", "-O", "ReleaseSmall", "--import-memory", "--shared-memory", "--max-memory=67108864", "--export=wasi_thread_start",
	`-femit-bin=${path.join(dir, "threads.wasm")}`], { cwd: dir });

const mounts = () => ({ "/mnt/kw": { fs: nodeFs(dir), readOnly: true } });
const hostLog = (m: string) => process.stderr.write(`${m}\n`);
const vm = await createKernel({ kernel, distro, worker, cpus, log: () => {}, mounts: mounts() });
const serve = (v: typeof vm, opts: { idleWorkers?: number } = {}) => serveWasiPrograms(v.vsock!, { log: hostLog, sharedMemory: !messages, ...opts });
let wasi = serve(vm);
assert.equal(wasi.shared, !messages);
console.log(`     requests ${wasi.shared ? "through a SharedArrayBuffer" : "as messages (JSPI)"}`);
// As root: the distro images' exec user is uid 1000 (`user`).
const sh = (cmd: string, input?: string) => vm.exec("sh", ["-c", cmd], { input, user: "root" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait until `cond` holds (at most `ms`); the time it took, in ms. */
async function until(cond: () => boolean, ms: number, what: string): Promise<number> {
	const t = performance.now();
	while (!cond()) {
		if (performance.now() - t > ms) throw new Error(`timed out after ${ms} ms waiting for ${what} (stats ${JSON.stringify(wasi.stats)})`);
		await sleep(2);
	}
	return performance.now() - t;
}
/** No program or thread running, no worker but the idle ones, no shared channel served. */
const quiet = () => wasi.stats.running === 0 && wasi.stats.threads === 0 && wasi.stats.workers === wasi.stats.idle && wasi.stats.channels === 0;
let failed = 0;
async function check(name: string, cmd: string, want: { stdout?: string | RegExp; stderr?: RegExp; code: number }, input?: string) {
	const r = await sh(cmd, input);
	try {
		if (typeof want.stdout === "string") assert.equal(r.stdout, want.stdout);
		else if (want.stdout) assert.match(r.stdout, want.stdout);
		if (want.stderr) assert.match(r.stderr, want.stderr);
		assert.equal(r.exitCode, want.code);
		console.log(`ok   ${name}`);
	} catch (e) {
		failed++;
		console.log(`FAIL ${name}: ${(e as Error).message}\n  stdout: ${JSON.stringify(r.stdout)}\n  stderr: ${JSON.stringify(r.stderr)}\n  exit: ${r.exitCode}`);
	}
}

try {
	const setup = await sh(`set -e
		install -m 755 /mnt/kw/kwwasi /usr/lib/kw/kwwasi
		d=/proc/sys/fs/binfmt_misc
		[ -e $d/wasi ] || printf '%s\\n' ':wasi:M::\\x00asm\\x01\\x00\\x00\\x00::/usr/lib/kw/kwwasi:P' > $d/register || :
		mkdir -p /root/work/sub /tmp/w /root/bin
		cp /mnt/kw/*.wasm /mnt/kw/loop.a64 /mnt/kw/sockclient /mnt/kw/clock.a64 /root/work/ && chmod 755 /root/work/*.wasm /root/work/*.a64 /root/work/sockclient
		cp /root/work/hello.wasm /root/bin/ && ln -s /root/work/hello.wasm /root/bin/hello-link
		echo "file in work dir" > /root/work/sub/data.txt
		cat /proc/sys/fs/binfmt_misc/wasi`);
	assert.match(setup.stdout, /interpreter \/usr\/lib\/kw\/kwwasi/, setup.stderr);

	await check("argv, env, exit status", "cd /root/work && KW_GREETING=hola ./hello.wasm one 'two words'",
		{ stdout: "argv[0]=./hello.wasm\nargv[1]=one\nargv[2]=two words\nKW_GREETING=hola\ngetcwd=/\n", code: 43 });
	// argv[0] as given, except a name found through $PATH: then the path exec ran (a symlink's own name).
	await check("argv[0] by ./, absolute path, $PATH and a $PATH symlink",
		"cd /root/work && { ./hello.wasm; /root/work/hello.wasm; PATH=/root/bin:$PATH hello.wasm; PATH=/root/bin:$PATH hello-link; cd /root/bin && ./hello-link; } | grep '^argv'",
		{ stdout: "argv[0]=./hello.wasm\nargv[0]=/root/work/hello.wasm\nargv[0]=/root/bin/hello.wasm\nargv[0]=/root/bin/hello-link\nargv[0]=./hello-link\n", code: 0 });
	await check("stdin from a pipe", "cd /root/work && echo hi | ./cat.wasm", { stdout: "hi\n", code: 0 });
	await check("stdin from the host", "/root/work/cat.wasm", { stdout: "from the host\n", code: 0 }, "from the host\n");
	await check("stdout redirected to a file", "cd /root/work && ./cat.wasm /etc/alpine-release > /tmp/w/out && cat /tmp/w/out",
		{ stdout: /^\d+\.\d+\.\d+\n$/, code: 0 });
	await check("absolute path in a non-root cwd", "cd /root/work/sub && ../cat.wasm /etc/hostname", { stdout: /\S/, code: 0 });
	await check("relative path in a non-root cwd", "cd /root/work && ./cat.wasm sub/data.txt", { stdout: "file in work dir\n", code: 0 });
	await check("relative path, cwd one deeper", "cd /root/work/sub && ../cat.wasm data.txt", { stdout: "file in work dir\n", code: 0 });
	await check("relative path in /", "cd / && /root/work/cat.wasm root/work/sub/data.txt", { stdout: "file in work dir\n", code: 0 });
	await check("missing file", "cd /root/work && ./cat.wasm nope", { stderr: /nope: No such file or directory/, code: 1 });
	await check("readdir and stat", "cd /root/work/sub && ../ls.wasm", { stdout: /^\. dir \d+\n\.\. dir \d+\ndata\.txt file 17\n$/, code: 0 });
	await check("pipeline of two programs", "/root/work/cat.wasm /etc/os-release | /root/work/cat.wasm | cmp - /etc/os-release", { code: 0 });
	await check("the caller's credentials", "cp /root/work/cat.wasm /tmp/w/ && su nobody -s /bin/sh -c '/tmp/w/cat.wasm /etc/shadow'",
		{ stderr: /\/etc\/shadow: Permission denied/, code: 1 });
	await check("a cwd the caller may not search",
		"mkdir -p /tmp/w/priv/sub && echo x > /tmp/w/priv/sub/f && chmod 700 /tmp/w/priv && cd /tmp/w/priv && su nobody -s /bin/sh -c '/tmp/w/cat.wasm sub/f'",
		{ stderr: /sub\/f: Permission denied/, code: 1 });
	await cwdChecks();
	await fsChecks();
	await moduleChecks();
	await clockChecks();
	await check("preview 0 (wasi_unstable): fd_seek's whence, filestat, poll_oneoff", "cd / && /root/work/p0.wasm", { stdout: "p0 ok\n", code: 0 });
	await socketChecks();
	await threadChecks();
	await check("trap", "/root/work/trap.wasm", { stdout: "before trap\n", stderr: /wasm trap: unreachable/, code: 134 });
	await check("not a module", "printf '\\0asm\\1\\0\\0\\0xx' > /tmp/w/bad.wasm && chmod +x /tmp/w/bad.wasm && /tmp/w/bad.wasm",
		{ stderr: /not a valid WebAssembly module/, code: 126 });
	// A module with a 64-bit memory of its own and an empty _start.
	await check("a wasm64 module is refused", "printf '\\0asm\\1\\0\\0\\0\\1\\4\\1\\140\\0\\0\\3\\2\\1\\0\\5\\3\\1\\4\\1\\7\\12\\1\\6_start\\0\\0\\12\\4\\1\\2\\0\\13' > /tmp/w/m64.wasm && " +
		"chmod +x /tmp/w/m64.wasm && /tmp/w/m64.wasm", { stdout: "", stderr: /a wasm64 module \(64-bit memory\)/, code: 126 });
	await check("killed while waiting for stdin", "(sleep 2; echo) | timeout -s INT 0.5 /root/work/cat.wasm", { code: 130 });
	await check("SIGKILL while waiting for stdin",
		"mkfifo /tmp/w/in && { sleep 3 > /tmp/w/in & } && timeout -s KILL 0.5 /root/work/cat.wasm < /tmp/w/in; rc=$?; kill $! 2>/dev/null; rm /tmp/w/in; exit $rc",
		{ code: 137 });
	console.log(`ok   its worker gone ${(await until(quiet, 2000, "the killed program's worker to end")).toFixed(0)} ms after the guest saw it exit`);
	await check("many small requests", "/root/work/calls.wasm write 1000 | wc -c", { stdout: "1000\n", code: 0 });
	await check("small preads and stats", "/root/work/calls.wasm pread 100 /etc/hostname && /root/work/calls.wasm stat 100 /etc/hostname", { code: 0 });
	await check("large reads and writes", "head -c 3000000 /dev/urandom > /tmp/w/big && /root/work/calls.wasm copy 4000000 < /tmp/w/big | cmp - /tmp/w/big", { code: 0 });
	await check("large reads and writes of regular files",
		"/root/work/calls.wasm copy 4000000 < /tmp/w/big > /tmp/w/big.out && cmp /tmp/w/big /tmp/w/big.out && rm /tmp/w/big /tmp/w/big.out", { code: 0 });
	await check("small reads of a regular file, each after a seek", "/root/work/calls.wasm reread 200 /etc/hostname", { code: 0 });
	await check("nonblocking stdin, an empty pipe: EAGAIN", "sleep 0.3 | /root/work/calls.wasm nbread", { stdout: "EAGAIN\n", code: 0 });
	await check("nonblocking stdin, a pipe with data", "printf hi | { sleep 0.3; /root/work/calls.wasm nbread; }", { stdout: "read 2\n", code: 0 });
	await check("nonblocking stdin, a tty: EAGAIN", "/root/work/calls.wasm nbread < /dev/console", { stdout: "EAGAIN\n", code: 0 });
	await check("SIGPIPE", "/root/work/cat.wasm /dev/zero | head -c 100000 | wc -c", { stdout: "100000\n", code: 0 });
	await until(quiet, 2000, "no program and no busy worker");
	console.log(`ok   instances dropped (stats ${JSON.stringify(wasi.stats)})`);
	await fakeHostChecks();

	const secs = async (cmd: string, code = 0) => {
		const t = performance.now();
		const r = await sh(cmd);
		assert.equal(r.exitCode, code, r.stderr);
		return (performance.now() - t) / 1000;
	};
	// While a program computes (no WASI calls), the guest and its console go on.
	const console0 = { text: "" };
	const unsubscribe = vm.onOutput((b) => (console0.text += new TextDecoder().decode(b)));
	const marker = async (n: number) => {
		const t = performance.now();
		await sh(`echo kw-marker-${n} > /dev/console`);
		await until(() => console0.text.includes(`kw-marker-${n}`), 20000, `console marker ${n}`);
		return (performance.now() - t) / 1000;
	};
	const idleSleep = await secs("sleep 0.5"), idleMarker = await marker(1);
	await check("a program computing in the background", "/root/work/loop.wasm 100000000000 >/dev/null 2>&1 & echo $! > /tmp/w/bg.pid", { code: 0 });
	await until(() => wasi.stats.running === 1, 5000, "the background program");
	await sleep(300); // well into the loop
	const busySleep = await secs("sleep 0.5"), busyMarker = await marker(2);
	unsubscribe();
	console.log(`     sleep 0.5 took ${idleSleep.toFixed(2)} s idle, ${busySleep.toFixed(2)} s next to the loop; console marker ${(idleMarker * 1000).toFixed(0)} ms idle, ${(busyMarker * 1000).toFixed(0)} ms next to the loop`);
	if (busySleep < idleSleep + 0.3 && busyMarker < idleMarker + 0.3) console.log("ok   the guest and its console go on while a program computes");
	else {
		failed++;
		console.log("FAIL the guest or its console stalled while a program computed");
	}
	await check("kill -9 of a computing program", "kill -9 $(cat /tmp/w/bg.pid) && sleep 0.1 && ! kill -0 $(cat /tmp/w/bg.pid) 2>/dev/null", { code: 0 });
	console.log(`ok   its worker gone ${(await until(quiet, 2000, "the killed program's worker to end")).toFixed(0)} ms after the guest saw it die`);

	// Killed in the middle of a computation: the status, and the worker ends at once.
	for (const [sig, code] of [["INT", 130], ["KILL", 137]] as const) {
		await check(`SIG${sig} mid-compute`, `timeout -s ${sig} 1 /root/work/loop.wasm 100000000000; exit $?`, { code });
		console.log(`ok   its worker gone ${(await until(quiet, 2000, "the killed program's worker to end")).toFixed(0)} ms after the guest saw it exit`);
	}

	// Two at a time: each in its own worker, same answers as one alone.
	const one = await sh("/root/work/loop.wasm 300000000");
	let most = 0;
	const watch = setInterval(() => (most = Math.max(most, wasi.stats.running)), 5);
	const t2 = performance.now();
	await check("two programs at a time", "/root/work/loop.wasm 300000000 > /tmp/w/a & /root/work/loop.wasm 300000000 > /tmp/w/b & wait; cat /tmp/w/a /tmp/w/b",
		{ stdout: one.stdout + one.stdout, code: 0 });
	const both = (performance.now() - t2) / 1000;
	clearInterval(watch);
	console.log(`     3e8 rounds: ${(await secs("/root/work/loop.wasm 300000000 >/dev/null")).toFixed(2)} s alone, two at a time ${both.toFixed(2)} s (most running at once: ${most})`);
	await until(quiet, 2000, "no busy worker");

	const time = async (cmd: string) => (await secs(cmd)).toFixed(2);
	// loop.wasm with an empty custom section added: another module, not compiled yet, so its first run is cold.
	await sh("cp /root/work/loop.wasm /tmp/w/loop2.wasm && printf '\\000\\004\\003kwx' >> /tmp/w/loop2.wasm");
	console.log(`loop 1e9: wasm cold ${await time("/tmp/w/loop2.wasm 1000000000")} s, wasm cached ${await time("/tmp/w/loop2.wasm 1000000000")} s, aarch64 ${await time("/root/work/loop.a64 1000000000")} s`);
	const hellos = "for i in $(seq 20); do /root/work/hello.wasm >/dev/null; done; true";
	const hello = await time(hellos);
	await sh("head -c 16777216 /dev/urandom > /tmp/w/z16");
	const req0 = wasi.stats.requests;
	const copy = await time("/root/work/cat.wasm /tmp/w/z16 > /tmp/w/z16.out");
	const reqs = wasi.stats.requests - req0;
	await check("16 MiB copied intact", "cmp /tmp/w/z16 /tmp/w/z16.out && rm /tmp/w/z16.out", { code: 0 });
	console.log(`16 MiB cat.wasm copy: ${copy} s (${reqs} requests to kwwasi; exec() of true takes ${((await secs("true")) * 1000).toFixed(1)} ms)`);
	const small = await secs("/root/work/calls.wasm pread 10000 /etc/hostname");
	console.log(`10000 16-byte preads: ${small.toFixed(2)} s (${(small * 100).toFixed(0)} us per request)`);
	// The same without idle workers: a new worker for every program.
	wasi.close();
	await until(quiet, 2000, "the idle workers to end");
	wasi = serve(vm, { idleWorkers: 0 });
	console.log(`20 x hello.wasm: ${hello} s with idle workers, ${await time(hellos)} s with a new worker each`);
	await until(quiet, 2000, "every worker to end");
	console.log(`ok   no worker left (stats ${JSON.stringify(wasi.stats)})`);

	if (!cpus) await snapshotCheck();
	else console.log("skip snapshot (an SMP kernel has none: KW_PARK needs !SMP)");
} finally {
	await vm.stop();
	rmSync(dir, { recursive: true, force: true });
}

/**
 * A WASI program has no cwd (wasi-libc's is "/"), so "/etc/x" and "etc/x"
 * reach kwwasi alike; it resolves each by what exists (kwwasi.c, resolve()).
 */
async function cwdChecks() {
	const host = (await sh("cat /etc/hostname")).stdout;
	await sh(`mkdir -p /tmp/w/col/etc /tmp/w/col/lib /tmp/w/half/etc && echo fake-hostname > /tmp/w/col/etc/hostname
		echo mine > /tmp/w/col/lib/x && echo other > /tmp/w/half/etc/other && cat /etc/hostname /etc/hostname > /tmp/w/hh`);
	const warning = (p: string, used: string) =>
		new RegExp(`^kwwasi: warning: "${p}" may mean \\./${p} or /${p} \\(a WASI program cannot say which\\); used ${used}\\. KWWASI_CWD=auto, root, cwd or off chooses and silences this\n`);
	await check("cwd and / both have the file: the cwd's, one warning", "cd /tmp/w/col && /root/work/cat.wasm /etc/hostname etc/hostname",
		{ stdout: "fake-hostname\nfake-hostname\n", stderr: new RegExp(`${warning("etc/hostname", "\\./etc/hostname").source}$`), code: 0 });
	await check("KWWASI_CWD=auto: the same, no warning", "cd /tmp/w/col && KWWASI_CWD=auto /root/work/cat.wasm /etc/hostname",
		{ stdout: "fake-hostname\n", stderr: /^$/, code: 0 });
	await check("KWWASI_CWD=root: such a collision goes to /", "cd /tmp/w/col && KWWASI_CWD=root /root/work/cat.wasm /etc/hostname",
		{ stdout: host, stderr: /^$/, code: 0 });
	await check("KWWASI_CWD=cwd: no guessing, every path the cwd's", "cd /tmp/w/half && KWWASI_CWD=cwd /root/work/cat.wasm etc/other && " +
		"! KWWASI_CWD=cwd /root/work/cat.wasm etc/hostname 2>/dev/null && cd /tmp/w/col && KWWASI_CWD=cwd /root/work/cat.wasm etc/hostname",
		{ stdout: "other\nfake-hostname\n", stderr: /^$/, code: 0 });
	await check("KWWASI_CWD=off: every path from /", "cd /tmp/w/col && KWWASI_CWD=off /root/work/cat.wasm /etc/hostname etc/hostname | cmp - /tmp/w/hh",
		{ stderr: /^$/, code: 0 });
	await check("cwd and / both have the first component: where the file is", "cd /tmp/w/half && /root/work/cat.wasm etc/other /etc/hostname",
		{ stdout: `other\n${host}`, stderr: warning("etc/other", "\\./etc/other"), code: 0 });
	await check("relative under a name / has too", "cd /tmp/w/col && /root/work/cat.wasm lib/x", { stdout: "mine\n", stderr: warning("lib/x", "\\./lib/x"), code: 0 });
	await check("./ from a program without chdir(): the cwd's", "cd /tmp/w/col && /root/work/cat.wasm ./etc/hostname", { stdout: "fake-hostname\n", stderr: /^$/, code: 0 });
	await check("new files and directories go to the cwd",
		"cd /tmp/w/col && /root/work/put.wasm newf hi && /root/work/put.wasm -d out && /root/work/put.wasm out/f there && cat newf out/f",
		{ stdout: "hi\nthere\n", stderr: /^$/, code: 0 });
	await check("a new entry named like one in /: that one, and a warning", "cd /tmp/w/col && /root/work/put.wasm -d tmp",
		{ stderr: new RegExp(`${warning("tmp", "/tmp").source}put\\.wasm: mkdir tmp: File exists\n$`), code: 1 });
	await check("the cwd is /", "cd / && /root/work/cat.wasm etc/hostname /etc/hostname | cmp - /tmp/w/hh", { stderr: /^$/, code: 0 });
	await check("absolute paths from a cwd the caller may not search", "cd /tmp/w/priv && su nobody -s /bin/sh -c '/tmp/w/cat.wasm /etc/hostname'",
		{ stdout: host, stderr: /^$/, code: 0 });
}

/**
 * File-system calls: fd_readdir's cookies on a large directory (tmpfs and
 * the overlay root), Linux errors as WASI's, fd_allocate,
 * fd_fdstat_set_flags with the sync flags, and created files' modes
 * against the umask.
 */
async function fsChecks() {
	const readdir = new RegExp("^3002 entries in \\d+ calls of 128 bytes, each once\nresumed from entry 1501's cookie: the same entries\n" +
		"cookie 0 again: from the first entry\nshort buffers filled\nentries removed and added meanwhile: the others each once\n$");
	await check("fd_readdir: 3000 files on tmpfs, small buffers, a mid cookie, cookie 0, changes between calls",
		"mkdir /tmp/w/many && /root/work/fs.wasm readdir /tmp/w/many 3000 && rm -r /tmp/w/many", { stdout: readdir, code: 0 });
	await check("fd_readdir: the same on the overlay root", "mkdir /root/many && /root/work/fs.wasm readdir /root/many 3000 && rm -r /root/many",
		{ stdout: readdir, code: 0 });
	await check("Linux errors as WASI's", `set -e; e=/tmp/w/e; mkdir -p $e/full $e/other $e/small $e/ro
		touch $e/full/x && echo data > $e/file && ln -s loop $e/loop
		mount -t tmpfs -o size=64k none $e/small && mount -t tmpfs -o ro none $e/ro && mount -t tmpfs none $e/other
		cp /bin/busybox $e/busy && ln -s busy $e/sleep && { $e/sleep 10 & }; sleep 0.3
		cd / && (ulimit -f 4096 && trap '' XFSZ && /root/work/fs.wasm errno $e); kill $!; umount $e/small $e/ro $e/other`,
	{
		stdout: "open a symlink loop: ELOOP\nrmdir a directory with a file: ENOTEMPTY\nrename to another file system: EXDEV\n" +
			"open a directory for writing: EISDIR\na file as a directory: ENOTDIR\nwrite a full file system: ENOSPC\n" +
			"create on a read-only file system: EROFS\nwrite beyond the file size limit: EFBIG\nopen a running program for writing: ETXTBSY\n" +
			"a 299-byte name: ENAMETOOLONG\n",
		code: 0,
	});
	// The table itself, for those the guest cannot easily make (EMLINK) and the socket ones.
	const want: Array<[string, number, number]> = [["ELOOP", 40, 32], ["ENOTEMPTY", 39, 55], ["EXDEV", 18, 75], ["EISDIR", 21, 31], ["ENOTDIR", 20, 54],
		["EMLINK", 31, 34], ["ENOSPC", 28, 51], ["EROFS", 30, 69], ["EFBIG", 27, 22], ["ETXTBSY", 26, 74], ["ENAMETOOLONG", 36, 37],
		["ECONNABORTED", 103, 13], ["EADDRINUSE", 98, 3], ["EHOSTUNREACH", 113, 23], ["EMSGSIZE", 90, 35], ["ENOBUFS", 105, 42],
		["EINPROGRESS", 115, 26], ["ENOTBLK, none: EIO", 15, 29]];
	const wrong = want.filter(([, l, w]) => wasiErrno(l) !== w);
	if (!wrong.length) console.log(`ok   errno table: ${want.map(([n]) => n).join(", ")}`);
	else {
		failed++;
		console.log(`FAIL errno table: ${wrong.map(([n, l, w]) => `${n} (${l}) is ${wasiErrno(l)}, want ${w}`).join("; ")}`);
	}
	await check("fd_allocate (posix_fallocate)", "/root/work/fs.wasm alloc /tmp/w/alloc /etc/hostname && rm /tmp/w/alloc", {
		stdout: "allocate 1 MiB: no error, size 1048576\nallocate 4 KiB at 4 MiB: no error, size 4198400\nallocate a negative length: EINVAL\n" +
			"allocate in a file opened read-only: EBADF\n",
		code: 0,
	});
	await check("fd_fdstat_set_flags: the sync flags only as they are", "echo x > /tmp/w/setfl && /root/work/fs.wasm setfl /tmp/w/setfl", {
		stdout: "O_SYNC file: F_GETFL has O_SYNC yes, O_DSYNC yes\nO_SYNC file: F_SETFL F_GETFL's | O_NONBLOCK: no error\n... O_NONBLOCK now set\n" +
			"O_SYNC file: F_SETFL O_NONBLOCK alone (O_SYNC cleared): ENOTSUP\nplain file: F_SETFL | O_APPEND: no error\n... O_APPEND now set\n" +
			"plain file: F_SETFL | O_DSYNC: ENOTSUP\nplain file: F_SETFL | O_SYNC: ENOTSUP\n",
		code: 0,
	});
	await check("created files and directories: the umask applies",
		"mkdir /tmp/w/um && cd /tmp/w/um && umask 027 && /root/work/put.wasm f x && /root/work/put.wasm -d d && umask 0 && " +
			"/root/work/put.wasm g x && /root/work/put.wasm -d e && stat -c '%n %a' f d g e",
		{ stdout: "f 640\nd 750\ng 666\ne 777\n", stderr: /^$/, code: 0 });
}

/**
 * Clocks: realtime and monotonic are the guest's (also after its date was
 * set), how far behind they are, CPU time, unknown clocks, absolute sleeps.
 */
async function clockChecks() {
	const ns = (s: string) => s.trim().split("\n").map((l) => BigInt(l));
	/** Native, wasm, native readings: the wasm one between (at most `slack` ms before the first: it lags the guest by its START's delivery). */
	const between = async (name: string, cmd: string) => {
		const r = await sh(`${cmd} && /root/work/clock.a64 now && /root/work/clock.wasm now && /root/work/clock.a64 now`);
		const v = r.exitCode === 0 ? ns(r.stdout) : [];
		const slack = 20_000_000n;
		const bad = v.length !== 6 ? "no readings" : [0, 1].map((i) => v[i]! - slack <= v[i + 2]! && v[i + 2]! <= v[i + 4]! ? "" : `clock ${i}: ${v[i]} ${v[i + 2]} ${v[i + 4]}`).filter(Boolean).join("; ");
		if (!bad) console.log(`ok   ${name}`);
		else {
			failed++;
			console.log(`FAIL ${name}: ${bad}\n  stdout: ${JSON.stringify(r.stdout)}\n  stderr: ${JSON.stringify(r.stderr)}`);
		}
	};
	await between("clocks: realtime and monotonic are the guest's", "true");
	// A day of 400 later (and back): the guest's realtime, not the host's.
	await between("clocks: realtime follows the guest's date", "date -s @$(( $(date +%s) + 400 * 86400 )) >/dev/null");
	await sh("date -s @$(( $(date +%s) - 400 * 86400 )) >/dev/null");
	await check("clocks: resolutions, unknown clocks EINVAL (time, res, poll_oneoff)", "/root/work/clock.wasm ids", {
		stdout: "clock 0: res under 1 ms\nclock 1: res under 1 ms\nclock 2: res under 1 ms\nclock 3: res under 1 ms\n" +
			"clock 4: time EINVAL, res EINVAL, poll EINVAL\nclock 999: time EINVAL, res EINVAL, poll EINVAL\n",
		code: 0,
	});
	const cpu = await sh("/root/work/clock.wasm cpu");
	const c = /^start (\d+) (\d+)\ncompute (\d+) (\d+)\nsleep (\d+) (\d+)\n$/.exec(cpu.stdout)?.slice(1).map(Number);
	if (c && c[0]! < 50 && c[1]! < 50 && c[2]! >= 150 && c[3]! >= 150 && c[4]! < 30 && c[5]! < 30)
		console.log(`ok   clocks: CPU time (process, thread ms): ${c[0]}, ${c[1]} at the start, ${c[2]}, ${c[3]} over 300 ms computing, ${c[4]}, ${c[5]} over a 300 ms sleep`);
	else {
		failed++;
		console.log(`FAIL clocks: CPU time: ${JSON.stringify(cpu.stdout)} ${JSON.stringify(cpu.stderr)}`);
	}
	const abs = await sh("/root/work/clock.wasm abs 100");
	const a = /^realtime ok (\d+)\nmonotonic ok (\d+)\n$/.exec(abs.stdout)?.slice(1).map(Number);
	if (a && a.every((ms) => ms >= 99 && ms < 250)) console.log(`ok   clocks: poll_oneoff until an absolute time: ${a[0]} ms (realtime), ${a[1]} ms (monotonic) for 100`);
	else {
		failed++;
		console.log(`FAIL clocks: absolute sleeps: ${JSON.stringify(abs.stdout)} ${JSON.stringify(abs.stderr)}`);
	}
	// How far the program's monotonic clock is behind the guest's: for the first of a series of starts, and after 20 (the host keeps the best).
	for (const [what, cmd] of [["a first start", "true"], ["after 20 starts", "for i in $(seq 20); do /root/work/clock.wasm now >/dev/null; done"]]) {
		if (what === "a first start") await sleep(10_500); // the host's best offset expires (CLOCK_BEST_NS)
		const lag = await sh(`${cmd}; /root/work/clock.wasm lag 100`);
		const m = /^lag between (-?\d+) and (-?\d+) us/.exec(lag.stdout);
		if (m && Number(m[2]) >= 0) console.log(`ok   clocks: the program's monotonic clock behind the guest's, ${what}: ${m[1]}-${m[2]} us`);
		else {
			failed++;
			console.log(`FAIL clocks: lag ${what}: ${JSON.stringify(lag.stdout)} ${JSON.stringify(lag.stderr)}`);
		}
	}
}

/**
 * Sockets: one from KWWASI_TCPLISTEN, a connection and a UDP socket
 * inherited from busybox nc -l -e, against sockclient in the guest.
 */
async function socketChecks() {
	await check("sockets: KWWASI_TCPLISTEN's listener: accept nonblocking, poll, accept, peek, recv WAITALL, read, send, write, shutdown",
		`rm -f /tmp/w/sock.ready; cd / && { KWWASI_TCPLISTEN=127.0.0.1:7001 /root/work/sock.wasm serve /tmp/w/sock.ready > /tmp/w/serve.out & }
		for i in $(seq 200); do [ -e /tmp/w/sock.ready ] && break; sleep 0.05; done
		/root/work/sockclient 7001 send 'hello world'; wait $!; echo "server exit $?"; cat /tmp/w/serve.out`,
		{
			stdout: "echo: hello world\nbye\nserver exit 0\nlistener: socket_stream\naccept, nonblocking listener: EAGAIN\npoll: 0\npoll: listener readable\n" +
				"accepted: socket_stream, nonblocking\npeeked 5: hello\nreceived 11: hello world\nread to the end: 11 bytes in all\nrecv after the client's end: 0\ndone\n",
			code: 0,
		});
	await check("sockets: KWWASI_TCPLISTEN with two listeners: descriptors 4 and 5",
		"cd / && KWWASI_TCPLISTEN=127.0.0.1:7005,:7006 /root/work/sock.wasm types 3 4 5 6",
		{ stdout: "3: not a socket\n4: socket_stream\n5: socket_stream\n6: error\n", code: 0 });
	await check("sockets: KWWASI_TCPLISTEN with descriptor 4 inherited", "KWWASI_TCPLISTEN=127.0.0.1:7007 /root/work/hello.wasm 4</dev/null",
		{ stdout: "", stderr: /^kwwasi: KWWASI_TCPLISTEN 127\.0\.0\.1:7007: descriptor 4 is already open \(inherited\)\n$/, code: 126 });
	await check("sockets: KWWASI_TCPLISTEN that is not ADDR:PORT", "KWWASI_TCPLISTEN=localhost /root/work/hello.wasm",
		{ stdout: "", stderr: /^kwwasi: KWWASI_TCPLISTEN localhost: not ADDR:PORT/, code: 126 });
	await check("sockets: an inherited connection on 0 and 1 (nc -l -e): nonblocking recv, poll, recv WAITALL, write, shutdown",
		`nc -l -p 7002 -e /root/work/sock.wasm inherited 2>/tmp/w/inh.err & /root/work/sockclient 7002 go ping; wait $!; echo "nc exit $?"; cat /tmp/w/inh.err`,
		{ stdout: "pong\nnc exit 0\nfd 0: socket_stream, fd 1: socket_stream\nnonblocking recv: EAGAIN\nreceived 4: ping\n", code: 0 });
	await check("sockets: an inherited UDP socket (nc -u -l -e): socket_dgram, a datagram cut short",
		`nc -u -l -p 7003 -e /root/work/sock.wasm udp 2>/tmp/w/udp.err & /root/work/sockclient 7003 udp datagram-payload; wait $!; echo "nc exit $?"; cat /tmp/w/udp.err`,
		{ stdout: "ok\nnc exit 0\nfd 0: socket_dgram\ndatagram: 4 bytes, truncated\n", code: 0 });
}

/**
 * wasi-threads (threads.zig): threads computing and doing file I/O at
 * once, one blocked on its stdin while others go on, proc_exit and a trap
 * in a thread, kills while threads run. On the message path a threads
 * module fails at its start.
 */
async function threadChecks() {
	if (messages) {
		await check("wasi-threads on the message path: exit 126 at the start", "/root/work/threads.wasm files 2",
			{ stdout: "", stderr: /^kwwasi: \/root\/work\/threads\.wasm: a wasi-threads module needs SharedArrayBuffer .* passes requests as messages\n$/, code: 126 });
		return;
	}
	await check("threads: eight computing and doing file I/O at once, positive unique tids", "cd / && /root/work/threads.wasm files 8 && echo \"files left: $(ls /tmp/w | grep -c thr-)\"",
		{ stdout: /^(thread \d: sum \d+\n){8}tids positive and unique\nfiles left: 0\n$/, code: 0 });
	await threadCpuChecks();
	await check("threads: one blocked reading stdin while four do file calls", "cd / && (sleep 2; echo late) | /root/work/threads.wasm stdin 4",
		{ stdout: "4 threads did their file calls; the stdin reader still waited\nstdin: late\n", code: 0 });
	await check("threads: proc_exit in a thread ends the program", "/root/work/threads.wasm exit", { stdout: "", code: 7 });
	await check("threads: a trap in a thread ends the program", "/root/work/threads.wasm trap", { stderr: /wasm trap: unreachable \(in thread \d+\)/, code: 134 });
	await until(quiet, 2000, "no program and no thread");
	await check("threads: three computing in the background", "/root/work/threads.wasm spin 3 >/dev/null 2>&1 & echo $! > /tmp/w/spin.pid", { code: 0 });
	await until(() => wasi.stats.threads === 3, 10000, "three threads running");
	await check("... kwwasi has a pthread for each", "ls /proc/$(cat /tmp/w/spin.pid)/task | wc -l", { stdout: "4\n", code: 0 });
	await check("kill -9 while threads run", "kill -9 $(cat /tmp/w/spin.pid) && sleep 0.1 && ! kill -0 $(cat /tmp/w/spin.pid) 2>/dev/null", { code: 0 });
	console.log(`ok   its four workers gone ${(await until(quiet, 2000, "the killed program's workers to end")).toFixed(0)} ms after the guest saw it die`);
	await check("SIGINT while threads run", "timeout -s INT 1 /root/work/threads.wasm spin 2 >/dev/null; exit $?", { code: 130 });
	console.log(`ok   its three workers gone ${(await until(quiet, 2000, "the killed program's workers to end")).toFixed(0)} ms after the guest saw it exit`);
}

/**
 * A threaded program's process CPU clock (clock 2; threads.zig's cpu
 * modes): read right after joining threads that computed without calls at
 * their end, read by main while threads compute without calls, with
 * threads waiting (in memory.atomic.wait32, in poll_oneoff) counted as
 * idle, and in a program on workers another one used before. Tolerances
 * for a loaded host.
 */
async function threadCpuChecks() {
	const judge = async (name: string, cmd: string, re: RegExp, ok: (v: number[]) => boolean) => {
		const r = await sh(cmd);
		const v = r.exitCode === 0 ? re.exec(r.stdout)?.slice(1).map(Number) : undefined;
		if (v && ok(v)) console.log(`ok   ${name}: ${r.stdout.trim()}`);
		else {
			failed++;
			console.log(`FAIL ${name}\n  stdout: ${JSON.stringify(r.stdout)}\n  stderr: ${JSON.stringify(r.stderr)}\n  exit: ${r.exitCode}`);
		}
	};
	await judge("threads: waiting threads are not counted", "/root/work/threads.wasm cpuidle",
		/^process cpu grew (\d+) ms in 400 ms/, ([ms]) => ms! < 40);
	await judge("threads: the process CPU clock counts every thread's (waiting after computing without calls, then joined)", "/root/work/threads.wasm cpu 3",
		/^process cpu grew (\d+) ms while they waited, (\d+)% of .*; (\d+) ms after the joins, (\d+)%/,
		([, mid, , end]) => mid! >= 75 && mid! <= 125 && end! >= 75 && end! <= 125);
	await judge("threads: the process CPU clock while two threads compute without calls", "/root/work/threads.wasm cpulive 2",
		/^process cpu grew (\d+) ms in (\d+) ms of wall time, ([\d.]+) x, (\d+) of 10/, ([, , rate, steps]) => rate! >= 1.2 && rate! <= 2.3 && steps! >= 9);
	// The workers of programs that ended (idle now, each having computed for 300 ms or more) run the next: its clocks start from its own start.
	await until(() => wasi.stats.idle >= 2, 2000, "two idle workers");
	await judge("threads: a program on reused workers starts from 0", "/root/work/threads.wasm cpustart",
		/^process (\d+) ms, main (\d+) ms at the start; the thread (\d+) ms at its start; process (\d+) ms after the join/,
		([p0, m0, t0, p1]) => p0! < 50 && m0! < 50 && t0! < 50 && p1! < 100);
}

/**
 * kwwasi against a host of this test's own on its port (the server closed
 * meanwhile): the host's EXIT while a request is in flight (as when the
 * program's worker fails), and a reset in the middle of regular-file reads.
 */
async function fakeHostChecks() {
	wasi.close();
	await until(quiet, 2000, "the idle workers to end");
	const frame = (op: number, ...words: number[]) => {
		const b = new Uint8Array(8 + words.length * 4), dv = new DataView(b.buffer);
		dv.setUint32(0, op, true);
		dv.setUint32(4, words.length * 4, true);
		words.forEach((w, i) => dv.setUint32(8 + i * 4, w, true));
		return b;
	};
	const cat = (...parts: Uint8Array[]) => {
		const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const p of parts) {
			out.set(p, at);
			at += p.length;
		}
		return out;
	};
	const exitFrame = (code: number, msg: string) => {
		const m = new TextEncoder().encode(msg), b = new Uint8Array(12 + m.length), dv = new DataView(b.buffer);
		dv.setUint32(0, 3, true);
		dv.setUint32(4, 4 + m.length, true);
		dv.setUint32(8, code, true);
		b.set(m, 12);
		return b;
	};
	const MODULE0 = frame(4, 0), R_READ = 16, R_FSTAT = 22;
	/** The ops of the frames kwwasi sends on conn, one at a time. */
	const frames = (conn: VsockConnection) => {
		const reader = conn.readable.getReader();
		let have = new Uint8Array(0);
		return async () => {
			for (;;) {
				const dv = new DataView(have.buffer, have.byteOffset, have.byteLength);
				if (have.length >= 8 && have.length >= 8 + dv.getUint32(4, true)) {
					const op = dv.getUint32(0, true);
					have = have.slice(8 + dv.getUint32(4, true));
					return op;
				}
				const { value, done } = await reader.read();
				if (done) throw new Error("kwwasi closed the connection");
				have = cat(have, value);
			}
		};
	};
	const listener = vm.vsock!.listen(1021);
	try {
		for (const [what, req] of [["a read of a regular file", frame(R_READ, 0, 16)], ["an fstat", frame(R_FSTAT, 0)]] as const) {
			const run = sh("/root/work/hello.wasm < /etc/hostname");
			const conn = (await listener.accept())!;
			assert.equal(await frames(conn)(), 1); // START
			// MODULE 0, the request and EXIT at once, then the connection closed both ways.
			void conn.writable.getWriter().write(cat(MODULE0, req, exitFrame(77, "kwwasi: the fake host ended it"))).catch(() => {});
			conn.close();
			const r = await run;
			if (r.exitCode === 77 && /the fake host ended it/.test(r.stderr)) console.log(`ok   the host's EXIT during ${what}: kwwasi exits as it says`);
			else {
				failed++;
				console.log(`FAIL the host's EXIT during ${what}: exit ${r.exitCode}, ${JSON.stringify(r.stderr)}`);
			}
		}
		// Replies read back for 50 reads of a regular stdin, then a 51st and a reset.
		const run = sh("/root/work/hello.wasm < /etc/hostname");
		const conn = (await listener.accept())!;
		const w = conn.writable.getWriter();
		const next = frames(conn);
		assert.equal(await next(), 1); // START
		void w.write(MODULE0);
		for (let i = 0; i < 50; i++) {
			void w.write(frame(R_READ, 0, 16));
			assert.equal(await next(), 2); // REPLY
		}
		void w.write(frame(R_READ, 0, 16)).catch(() => {});
		conn.reset();
		const r = await run;
		if (r.exitCode === 126 && /^kwwasi: (lost the connection to the host|the host closed the connection)/.test(r.stderr))
			console.log("ok   a reset in the middle of regular-file reads: kwwasi exits 126");
		else {
			failed++;
			console.log(`FAIL a reset in the middle of regular-file reads: exit ${r.exitCode}, ${JSON.stringify(r.stderr)}`);
		}
	} finally {
		listener.close();
		wasi = serve(vm);
	}
}

/**
 * kwwasi sends the module's identity and the bytes only when the host has
 * not compiled them for that identity, and never for a file changed less
 * than 2 s ago (kwwasi.c, UNSETTLED).
 */
async function moduleChecks() {
	const runs = async (name: string, cmd: string, stdout: string, sent: number) => {
		const r0 = wasi.stats.received;
		const r = await sh(cmd);
		const got = wasi.stats.received - r0;
		if (r.stdout === stdout && r.exitCode === 0 && got === sent) console.log(`ok   ${name}`);
		else {
			failed++;
			console.log(`FAIL ${name}: ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)} exit ${r.exitCode}, ${got} modules sent, want ${JSON.stringify(stdout)} and ${sent}`);
		}
	};
	const A = "variant A\n", B = "variant B\n";
	const v = "/tmp/w/v.wasm";
	await sh(`cp /root/work/verA.wasm ${v} && chmod +x ${v}`);
	await runs("a module changed just now is sent each time", `${v} && ${v}`, A + A, 2);
	await sleep(2100);
	await runs("one that has not changed for 2 s is sent once", `${v} && ${v} && ${v}`, A + A + A, 1);
	await runs("rewritten in place three times in a row, same size: sent each time",
		`cat /root/work/verB.wasm > ${v} && ${v} && cat /root/work/verA.wasm > ${v} && ${v} && cat /root/work/verB.wasm > ${v} && ${v}`, B + A + B, 3);
	await runs("replaced by a rename", `cp /root/work/verA.wasm /tmp/w/n.wasm && chmod +x /tmp/w/n.wasm && mv /tmp/w/n.wasm ${v} && ${v}`, A, 1);
	const cached = wasi.stats.cached;
	await runs("another file with the same bytes", `cp ${v} /tmp/w/w.wasm && /tmp/w/w.wasm`, A, 1);
	if (wasi.stats.cached === cached) console.log(`ok   ... shares the compiled module (${cached} kept)`);
	else {
		failed++;
		console.log(`FAIL a copy compiled again: ${cached} modules kept before, ${wasi.stats.cached} after`);
	}
	// A host file system: the host's edits show once the mount's attribute cache (1 s) expires.
	const hv = path.join(dir, "v9.wasm"), g = "/mnt/kw/v9.wasm";
	copyFileSync(path.join(dir, "verA.wasm"), hv);
	await sleep(2100);
	await runs("on a 9p mount: sent once", `${g} && ${g}`, A + A, 1);
	writeFileSync(hv, readFileSync(path.join(dir, "verB.wasm")));
	await sleep(1100);
	await runs("rewritten in place by the host", g, B, 1);
	copyFileSync(path.join(dir, "verA.wasm"), path.join(dir, "n9.wasm"));
	renameSync(path.join(dir, "n9.wasm"), hv);
	await sleep(1100);
	await runs("replaced by a rename on the host", g, A, 1);
}

/**
 * Snapshots with a program computing, one waiting for its stdin, one
 * blocked writing to a full pipe and (shared path) one with two threads
 * computing: they are not blocked, one without stop
 * leaves the three running, the programs' workers end when the machine
 * stops, and in the resumed machine kwwasi
 * finds its connection reset and exits 126.
 */
async function snapshotCheck() {
	const names = messages ? ["l", "c", "p"] : ["l", "c", "p", "t"], n = names.length;
	await sh(`rm -f /tmp/w/*.rc
		(/root/work/loop.wasm 100000000000 >/tmp/w/l.out 2>/tmp/w/l.err; echo $? > /tmp/w/l.rc) >/dev/null 2>&1 &
		sleep 100000 | (/root/work/cat.wasm >/tmp/w/c.out 2>/tmp/w/c.err; echo $? > /tmp/w/c.rc) >/dev/null 2>&1 &
		(/root/work/calls.wasm copy 4096 </dev/zero 2>/tmp/w/p.err; echo $? > /tmp/w/p.rc) | sleep 100000 >/dev/null 2>&1 &
		${messages ? "" : "(/root/work/threads.wasm spin 2 >/dev/null 2>/tmp/w/t.err; echo $? > /tmp/w/t.rc) >/dev/null 2>&1 &"}`);
	await until(() => wasi.stats.running === n && wasi.stats.threads === 2 * (n - 3), 10000, `${n} programs running`);
	await sleep(300);
	// In a worker a snapshot may not have host file systems (they resume inline only).
	if (worker) await vm.mounts.get("/mnt/kw")!.unmount();
	const old = wasi;
	// One without stop: the guest and the programs go on.
	await vm.snapshot();
	await sleep(200);
	if (old.stats.running === n && old.stats.workers - old.stats.idle === n + 2 * (n - 3)) console.log(`ok   a snapshot without stop leaves the ${n} programs running`);
	else {
		failed++;
		console.log(`FAIL a snapshot without stop: ${JSON.stringify(old.stats)}`);
	}
	const t = performance.now();
	const snap = await vm.snapshot({ stop: true });
	console.log(`ok   snapshot with ${n} programs running, in ${((performance.now() - t) / 1000).toFixed(2)} s`);
	await until(() => old.stats.running === 0 && old.stats.workers === 0 && old.stats.channels === 0, 2000, "the stopped machine's program workers to end");
	console.log(`ok   the stopped machine's program workers ended (stats ${JSON.stringify(old.stats)})`);
	const vm2 = await createKernel({ kernel, distro, worker, log: () => {}, ...(worker ? {} : { mounts: mounts() }), restore: snap });
	try {
		wasi = serve(vm2);
		for (let i = 0; ; i++) {
			const r = await vm2.exec("sh", ["-c", `cd /tmp/w && cat ${names.map((x) => `${x}.rc`).join(" ")} 2>/dev/null`], { user: "root" });
			if (r.stdout.split("\n").filter(Boolean).length === n) break;
			if (i > 100) {
				const ps = await vm2.exec("sh", ["-c", "ps; cat /tmp/w/*.err"], { user: "root" });
				throw new Error(`kwwasi still running after the restore: ${r.stdout}\n${ps.stdout}`);
			}
			await sleep(100);
		}
		const r = await vm2.exec("sh", ["-c", `cd /tmp/w && cat ${names.map((x) => `${x}.rc`).join(" ")} ${names.map((x) => `${x}.err`).join(" ")}`], { user: "root" });
		try {
			const lost = "kwwasi: lost the connection to the host \\([^)]+\\): [^\\n]*snapshot[^\\n]*\\n";
			assert.match(r.stdout, new RegExp(`^${"126\\n".repeat(n)}${lost.repeat(n)}$`));
			console.log(`ok   after the restore the ${n} kwwasi exit 126 (computing, waiting for stdin, blocked writing to a full pipe${n > 3 ? ", with threads" : ""}): ${JSON.stringify(r.stdout.split("\n")[n])}`);
		} catch (e) {
			failed++;
			console.log(`FAIL after the restore: ${(e as Error).message}`);
		}
		const h = await vm2.exec("sh", ["-c", "/root/work/hello.wasm"], { user: "root" });
		if (h.exitCode === 41) console.log("ok   a program runs in the resumed machine");
		else {
			failed++;
			console.log(`FAIL a program in the resumed machine: exit ${h.exitCode}, ${JSON.stringify(h.stderr)}`);
		}
	} finally {
		await vm2.stop();
	}
}
console.log(failed ? `${failed} failure(s)` : "all passed");
process.exit(failed ? 1 : 0);
