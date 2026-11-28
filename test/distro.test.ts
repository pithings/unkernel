// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// createKernel({ distro }): the distroless bundle (kernel + base initramfs)
// with a read-only distro image, for each of Alpine, Arch and Debian.
//
//   node --test test/distro.test.ts
//   UNKERNEL_TEST_BASE_KERNEL=path ...      # another distroless bundle (default vendor/build/bundle/unkernel.wasm)
//   UNKERNEL_TEST_DISTRO_FORMAT=ext4 ...    # the .ext4 images (default: .erofs if the kernel has erofs, else .ext4)
//   UNKERNEL_TEST_DISTRO_DIR=dir ...        # where the images are (default vendor/build/distro; KW_DISTRO_OUT of a build)
//
// Skips what is not built (kernel/build.sh base, kernel/build.sh distro).
// The images are copied to a temporary directory first, so a rebuild while
// the tests run does not matter, and checked byte for byte at the end.
import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel, createImageFromKwsparse, bundledBoot, decodeSnapshot, encodeSnapshot, openDistroDisk, snapshotDiskMismatch } from "../js/node.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kernelFile = path.resolve(process.env.UNKERNEL_TEST_BASE_KERNEL ?? path.join(root, "vendor/build/bundle/unkernel.wasm"));
const kernelBytes = existsSync(kernelFile) ? readFileSync(kernelFile) : undefined;
/** A message of the kernel's erofs driver (fs/erofs/super.c). */
const hasErofs = !!kernelBytes?.includes("cannot find valid erofs superblock");
const format = process.env.UNKERNEL_TEST_DISTRO_FORMAT ?? (hasErofs ? "erofs" : "ext4");
const module = kernelBytes && await WebAssembly.compile(kernelBytes);
const bundled = module && bundledBoot(module);
const shown = kernelFile.startsWith(root + path.sep) ? path.relative(root, kernelFile) : kernelFile;
const noKernel = !kernelBytes ? `no ${shown} (kernel/build.sh base)` : !bundled?.initrd ? `${shown} has no bundled base initramfs` : false;

const tmp = mkdtempSync(path.join(tmpdir(), "unkernel-distro-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const MEM = 512, EXEC = { timeout: 120000 };
const distroDir = path.resolve(process.env.UNKERNEL_TEST_DISTRO_DIR ?? path.join(root, "vendor/build/distro"));

/** The test's copy of a distro image, and its hash at copy time; undefined if it is not built. */
function image(name: string): { file: string; sha: string } | undefined {
	const src = path.join(distroDir, `${name}.${format}`);
	if (!existsSync(src)) return undefined;
	const file = path.join(tmp, `${name}.${format}`);
	if (!existsSync(file)) copyFileSync(src, file);
	return { file, sha: sha(file) };
}

/** A new data disk image (sparse) from the bundle's template. */
async function dataDisk(name: string): Promise<string> {
	const file = path.join(tmp, `${name}-data.img`);
	rmSync(file, { force: true });
	const tpl = bundled?.datadisk ?? readFileSync(path.join(root, "vendor/build/disk/kwdata.kwsparse.gz"));
	await createImageFromKwsparse(file, tpl);
	return file;
}

type Vm = Awaited<ReturnType<typeof createKernel>>;
/** A command in a session of the default user (the image's), or of `user`. */
const sh = async (vm: Vm, cmd: string, user?: string) => {
	const r = await vm.exec("sh", ["-c", cmd], { ...EXEC, user });
	assert.equal(r.exitCode, 0, `${cmd}: exit ${r.exitCode}, ${r.stderr}`);
	return r.stdout.trim();
};
const asRoot = (vm: Vm, cmd: string) => sh(vm, cmd, "root");
/** The user's home on the image, and in an upper layer. */
const HOME = "/home/user";
/** Power off cleanly (the data disk's file systems are written back) and wait for the exit. */
const poweroff = async (vm: Vm) => {
	vm.write("\npoweroff\n");
	const res = await vm.exited;
	assert.equal(res.code, 0, res.reason);
};

for (const name of ["alpine", "arch", "debian"]) {
	const img = noKernel ? undefined : image(name);
	const skip = noKernel || (!img && `no ${path.join(distroDir, `${name}.${format}`)} (kernel/build.sh distro ${name})`);
	describe(`distro ${name} (${format})`, { skip, concurrency: 1 }, () => {
		const boot = async (t: { after(fn: () => unknown): void }, opts: NonNullable<Parameters<typeof createKernel>[0]>) => {
			const vm = await createKernel({ kernel: module, memoryMiB: MEM, log: () => {}, ...opts });
			t.after(() => vm.stop({ reason: "test cleanup" }));
			return vm;
		};

		test("boots through the SDK: exec() (the base's kwtty), /usr/lib/kw-distro, an overlay root, a read-only /dev/wda", async (t) => {
			const vm = await boot(t, { distro: img!.file });
			assert.equal(vm.distro?.fs, format);
			assert.equal(vm.distro?.label, "kwroot");
			assert.equal(await sh(vm, "cat /usr/lib/kw-distro"), name);
			assert.match(await sh(vm, "grep ' / ' /proc/self/mounts"), /^overlay \/ overlay .*lowerdir=\/kw\/layer:\/kw\/distro/m);
			assert.match(await sh(vm, "ls /usr/bin/kwbox"), /kwbox/);
			assert.equal(await sh(vm, "cat /sys/block/wda/ro"), "1");
			const w = await vm.exec("sh", ["-c", "echo x > /dev/wda"], EXEC);
			assert.notEqual(w.exitCode, 0, "a write to the distro's disk fails");
			await poweroff(vm);
		});

		test("the kw layer's shims: fx, claude, opencode, node, npm, npx, bun, bunx, uv and uvx last on PATH; without a network the first call exits 127 and installs nothing (Debian's docker shim too)", async (t) => {
			const vm = await boot(t, { distro: img!.file });
			const tools = ["fx", "claude", "opencode", "node", "npm", "npx", "bun", "bunx", "uv", "uvx"];
			const which = `for n in ${tools.join(" ")}; do command -v $n; done`;
			const want = tools.map((n) => `/usr/lib/kw/bin/${n}`).join("\n");
			assert.equal(await sh(vm, which), want, "kwtty's PATH");
			const l = await vm.exec("sh", ["-lc", which], EXEC);
			assert.equal(l.stdout.trim(), want, `a login shell's PATH: ${l.stderr}`);
			const r = await vm.exec("fx", ["--version"], EXEC);
			assert.equal(r.exitCode, 127);
			assert.match(r.stderr, /^fx: not installed yet, and installing it needs a network/);
			assert.equal(await sh(vm, "[ -e ~/.local/bin ] && echo yes || echo no"), "no");
			// Anything else of the name wins: a program in ~/.local/bin (where an install goes).
			await sh(vm, "mkdir -p ~/.local/bin && ln -s /bin/true ~/.local/bin/fx");
			assert.equal(await sh(vm, "command -v fx"), `${HOME}/.local/bin/fx`);
			if (name === "debian") {
				// The image's docker shim, ahead of /usr/bin; offline it sets up nothing.
				assert.equal(await sh(vm, "command -v docker"), "/usr/local/bin/docker");
				const d = await vm.exec("docker", ["ps"], EXEC);
				assert.equal(d.exitCode, 127, d.stderr);
				assert.match(d.stderr, /^docker: not installed yet, and installing it needs a network/);
				assert.equal(await sh(vm, "[ -e /etc/docker ] && echo yes || echo no"), "no");
			}
			await poweroff(vm);
		});

		test("a data disk keeps the root's changes across two boots, in /data/distros/<name>/upper", async (t) => {
			const data = await dataDisk(name);
			const token = `kw-${Math.random().toString(36).slice(2)}`;
			const vm1 = await boot(t, { distro: img!.file, disks: [{ kind: "file", path: data }] });
			await sh(vm1, `echo ${token} > ~/persist && sync`);
			await poweroff(vm1);
			const vm2 = await boot(t, { distro: img!.file, disks: [{ kind: "file", path: data }] });
			assert.equal(await sh(vm2, "cat ~/persist"), token);
			assert.equal(await sh(vm2, `cat /data/distros/${name}/upper${HOME}/persist`), token);
			await poweroff(vm2);
		});

		/** Boot with a data disk; the console's text so far is out(). */
		const bootData = async (t: { after(fn: () => unknown): void }, data: string, cmdline?: string) => {
			const vm = await boot(t, { distro: img!.file, disks: [{ kind: "file", path: data }], ...(cmdline ? { cmdline: `${bundled!.cmdline} ${cmdline}` } : {}) });
			let text = "";
			const dec = new TextDecoder();
			vm.onOutput((b) => { text += dec.decode(b, { stream: true }); });
			await sh(vm, "true");   // kwtty runs: the distro's init has printed the welcome and the base's messages
			return { vm, out: () => text };
		};
		const st = `/data/distros/${name}`;

		test("an init in the data disk's upper layer that runs /usr/bin/kwtty (from before kwbox) gives safe mode with the image's own init", async (t) => {
			const data = await dataDisk(`${name}-oldinit`);
			const b1 = await bootData(t, data);
			const init = name === "alpine" ? "/etc/inittab" : "/usr/local/sbin/kw-init";
			const line = name === "alpine" ? "::once:/usr/bin/kwtty serve" : "/usr/bin/kwtty serve";
			await asRoot(b1.vm, `echo '${line}' >> ${init} && sync`);
			await poweroff(b1.vm);
			const b2 = await bootData(t, data);
			assert.match(b2.out(), /kw-overlay: SAFE MODE: its init runs \/usr\/bin\/kwtty, from before kwbox/);
			assert.match(await sh(b2.vm, "cat /run/kw-base"), /^upper=tmpfs$/m);
			await poweroff(b2.vm);
		});

		test("a root on the data disk that cannot boot (/bin/sh deleted) falls back to safe mode, and the next boot checks again", async (t) => {
			const data = await dataDisk(`${name}-safe`);
			const b1 = await bootData(t, data);
			await sh(b1.vm, "echo kept > ~/kept");
			const r = await b1.vm.exec("rm", ["/bin/sh"], { ...EXEC, user: "root" });
			assert.equal(r.exitCode, 0, r.stderr);
			await b1.vm.exec("sync", [], EXEC);
			b1.vm.stop({ reason: "test: /bin/sh is gone, so no clean poweroff" });
			const b2 = await bootData(t, data);
			assert.match(b2.out(), /kw-overlay: SAFE MODE: \/bin\/sh is missing/);
			assert.match(await sh(b2.vm, "cat /run/kw-base"), /^upper=tmpfs$/m);
			assert.equal(await sh(b2.vm, "cat ~/kept 2>/dev/null || echo gone"), "gone");
			assert.equal(await sh(b2.vm, `cat ${st}/upper${HOME}/kept`), "kept");
			assert.match(await sh(b2.vm, "kw-overlay status"), /SAFE MODE/);
			// The repair: remove the whiteout of /bin/sh (on Debian /bin is usr/bin).
			await asRoot(b2.vm, `rm -f ${st}/upper/bin/sh ${st}/upper/usr/bin/sh`);
			await poweroff(b2.vm);
			const b3 = await bootData(t, data);
			assert.doesNotMatch(b3.out(), /SAFE MODE/);
			assert.match(await sh(b3.vm, "cat /run/kw-base"), /^upper=data$/m);
			assert.equal(await sh(b3.vm, "cat ~/kept"), "kept");
			await poweroff(b3.vm);
		});

		test("kw.root=initramfs boots the plain image on a tmpfs upper, the data upper unmounted", async (t) => {
			const data = await dataDisk(`${name}-initramfs`);
			const b1 = await bootData(t, data);
			await sh(b1.vm, "echo kept > ~/kept");
			await poweroff(b1.vm);
			const b2 = await bootData(t, data, "kw.root=initramfs");
			assert.match(b2.out(), /kw-overlay: kw\.root=initramfs: the plain image this time/);
			assert.match(await sh(b2.vm, "cat /run/kw-base"), /^upper=tmpfs$/m);
			assert.equal(await sh(b2.vm, "cat ~/kept 2>/dev/null || echo gone"), "gone");
			assert.equal(await sh(b2.vm, `cat ${st}/upper${HOME}/kept`), "kept");
			await poweroff(b2.vm);
		});

		test("kw-overlay discard: at the next boot on the data upper, at once when it is not mounted", async (t) => {
			const data = await dataDisk(`${name}-discard`);
			const b1 = await bootData(t, data);
			await sh(b1.vm, "echo one > ~/one");
			assert.match(await sh(b1.vm, "sudo -n kw-overlay discard"), /at the next boot/);
			assert.equal(await sh(b1.vm, "cat ~/one"), "one", "still there this boot");
			await poweroff(b1.vm);
			const b2 = await bootData(t, data);
			assert.match(b2.out(), /kw-overlay: starting over from the image; the previous changes are in \/data\/distros\/\w+\/discarded-/);
			assert.equal(await sh(b2.vm, "cat ~/one 2>/dev/null || echo gone"), "gone");
			assert.equal(await sh(b2.vm, `cat ${st}/discarded-*/upper${HOME}/one`), "one");
			await sh(b2.vm, "echo two > ~/two");
			await poweroff(b2.vm);
			const b3 = await bootData(t, data, "kw.root=initramfs");
			assert.match(await sh(b3.vm, "sudo -n kw-overlay discard"), /your changes are now in/);
			assert.equal(await sh(b3.vm, `ls ${st}/upper 2>/dev/null | wc -l; ls -d ${st}/discarded-* | wc -l`), "0\n2");
			await poweroff(b3.vm);
			const b4 = await bootData(t, data);
			assert.equal(await sh(b4.vm, "cat ~/two 2>/dev/null || echo gone"), "gone");
			await poweroff(b4.vm);
		});

		test("an image id change under the changes prints one line and goes into the history", async (t) => {
			const data = await dataDisk(`${name}-update`);
			const b1 = await bootData(t, data);
			const id = await sh(b1.vm, "cat /usr/lib/kw-image");
			assert.equal(await sh(b1.vm, `cat ${st}/lower`), id);
			await asRoot(b1.vm, `echo ${name}-0-older > ${st}/lower`);
			await poweroff(b1.vm);
			const b2 = await bootData(t, data);
			const lines = b2.out().split(/\r?\n/).filter((l) => l.includes("image updated"));
			assert.equal(lines.length, 1, b2.out());
			assert.match(lines[0]!, new RegExp(`${name} image updated: ${id}`));
			assert.match(await sh(b2.vm, `cat ${st}/history`), new RegExp(` ${name}-0-older -> ${id}$`));
			assert.equal(await sh(b2.vm, `cat ${st}/lower`), id);
			await poweroff(b2.vm);
			const b3 = await bootData(t, data);
			assert.doesNotMatch(b3.out(), /image updated/);
			await poweroff(b3.vm);
		});

		test("both distros keep their own changes on one data disk", { skip: name !== "debian" && "once, from the Debian suite" }, async (t) => {
			const other = image("alpine");
			if (!other) return t.skip("no alpine image");
			const data = await dataDisk("shared");
			const vm1 = await boot(t, { distro: other.file, disks: [{ kind: "file", path: data }] });
			await sh(vm1, "echo alpine > ~/who");
			await poweroff(vm1);
			const vm2 = await boot(t, { distro: img!.file, disks: [{ kind: "file", path: data }] });
			assert.equal(await sh(vm2, "cat ~/who 2>/dev/null || echo none"), "none");
			await sh(vm2, "echo debian > ~/who");
			assert.equal(await sh(vm2, `cat /data/distros/alpine/upper${HOME}/who`), "alpine");
			await poweroff(vm2);
			const vm3 = await boot(t, { distro: other.file, disks: [{ kind: "file", path: data }] });
			assert.equal(await sh(vm3, "cat ~/who"), "alpine");
			await poweroff(vm3);
		});

		test("worker mode boots, with the distro as a spec", async (t) => {
			const vm = await boot(t, { worker: true, distro: img!.file });
			assert.equal(vm.distro?.fs, format);
			assert.equal(await sh(vm, "cat /usr/lib/kw-distro"), name);
			await poweroff(vm);
		});

		test("a snapshot is refused with another distro image, and resumes with its own", async (t) => {
			const other = image(name === "alpine" ? "debian" : "alpine");
			const vm = await boot(t, { distro: img!.file, vsock: false });
			const dec = new TextDecoder();
			let out = "";
			vm.onOutput((b) => { out += dec.decode(b, { stream: true }); });
			const until = async (re: RegExp) => { for (let i = 0; i < 1200 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 100)); assert.match(out, re); };
			vm.write("\necho ready-$((6*7))\n");
			await until(/ready-42/);
			const snap = decodeSnapshot(encodeSnapshot(await vm.snapshot({ stop: true })));
			assert.equal(snap.disks.length, 1);
			assert.match(snap.disks[0]!.identity, new RegExp(`^distro ${format} `));
			assert.equal(snapshotDiskMismatch(snap.disks, [await openDistroDisk(img!.file)]), null);
			await assert.rejects(boot(t, { restore: snap, vsock: false }), /disk wda .* is missing/);
			if (other) await assert.rejects(boot(t, { restore: snap, vsock: false, distro: other.file }), /is not the disk of the snapshot/);
			const vm2 = await boot(t, { restore: snap, vsock: false, distro: img!.file });
			out = "";
			vm2.onOutput((b) => { out += dec.decode(b, { stream: true }); });
			vm2.write("echo resumed-$((6*8))\n");
			await until(/resumed-48/);
			await poweroff(vm2);
		});

		const pm = { alpine: "apk add", arch: "pacman -S", debian: "apt install" }[name]!;
		const userShell = name === "alpine" ? "/bin/sh" : "/bin/bash";

		test("the image's user: sessions and the console run as user (uid 1000, its groups, in /home/user), sudo -n works without a tty, root on request", async (t) => {
			const vm = await boot(t, { distro: img!.file });
			let out = "";
			const dec = new TextDecoder();
			vm.onOutput((b) => { out += dec.decode(b, { stream: true }); });
			const [uid, gid, groups, cwd, env, p] = (await sh(vm, 'id -u; id -g; id -Gn; pwd; echo "$HOME $USER $LOGNAME $SHELL"; echo "$PATH"')).split("\n");
			assert.deepEqual([uid, gid, cwd, env], ["1000", "1000", HOME, `${HOME} user user ${userShell}`]);
			for (const g of ["audio", "video", "input", name === "debian" ? "sudo" : "wheel"]) assert.ok(groups!.split(" ").includes(g), `${g} in ${groups}`);
			assert.match(p!, new RegExp(`^/run/kw/bin:${HOME}/\\.local/bin:.*:/usr/sbin:.*:/usr/lib/kw/bin$`));
			assert.equal(await sh(vm, "sudo -n true && sudo -n id -u && sudo -n sh -c 'echo $(id -u) $HOME' </dev/null"), "0\n0 /root");
			assert.equal(await sh(vm, "id -u; pwd; echo $HOME", "root"), "0\n/root\n/root");
			assert.equal(await sh(vm, "sudo -n id -u", "root"), "0", "sudo in a root session too");
			assert.equal((await vm.exec("id", ["-un"], { ...EXEC, user: 0 })).stdout.trim(), "root");
			assert.equal((await vm.exec("id", ["-un"], { ...EXEC, user: "user" })).stdout.trim(), "user");
			await assert.rejects(vm.exec("true", [], { ...EXEC, user: "nosuchuser" }), /no user nosuchuser/);
			// Readable as the user: the boot's description, the README (owned by the user, naming this distro's package manager).
			assert.match(await sh(vm, "cat /run/kw-base"), /^name=/m);
			assert.equal(await sh(vm, "stat -c '%U:%G %a' ~/README /home/user"), "user:user 644\nuser:user 700");
			assert.match(await sh(vm, "cat ~/README"), new RegExp(`\\n  ${pm} htop\\n.*\\n.*runs through sudo`));
			assert.equal(await sh(vm, "ls -a /root 2>/dev/null | grep -c README || true"), "0");
			vm.write("\necho \"con-$(id -un)-$(pwd)-$((6*7))\"\n");
			for (let i = 0; i < 600 && !/con-\w+-\S+-42/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
			assert.match(out, new RegExp(`con-user-${HOME}-42`));
			vm.write("\ncommand grep SigIgn /proc/self/status\n");   // not an alias: Arch's skel colours grep
			for (let i = 0; i < 600 && !/SigIgn:\s+\w{16}/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
			assert.match(out, /SigIgn:\s+0{16}/, "the console's programs do not ignore ^C");
			await poweroff(vm);   // as the user: poweroff goes through sudo
			const vm2 = await boot(t, { distro: img!.file, cmdline: `${bundled!.cmdline} kw.user=root` });
			out = "";
			vm2.onOutput((b) => { out += dec.decode(b, { stream: true }); });
			vm2.write("\necho \"con-$(id -un)-$(pwd)-$((6*7))\"\n");
			for (let i = 0; i < 600 && !/con-\w+-\S+-42/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
			assert.match(out, /con-root-\/root-42/, "kw.user=root: a root console");
			await poweroff(vm2);
		});

		test("every interactive shell gets the kw profile (prompt, command not found, PATH): the login shell, a nested shell, sudo -s, sudo -i", async (t) => {
			const vm = await boot(t, { distro: img!.file });
			const pty = await vm.spawn(undefined, [], { cols: 200, rows: 50 });
			let out = "";
			const dec = new TextDecoder();
			void (async () => { for await (const b of pty.output) out += dec.decode(b, { stream: true }); })().catch(() => {});
			let n = 0;
			// Sent again every 5 s: a sudo that is ending may have taken the line (its relay reads what is typed).
			const probe = async () => {
				const m = `M${++n}`;
				const at = out.length;
				const re = new RegExp(`${m} (\\d+) <([^>\\n]*)> (\\S*) :(\\S*):`);
				for (let i = 0; i < 600 && !re.test(out.slice(at)); i++) {
					if (i % 50 === 0) await pty.write(`echo "${m} $(id -u) <$PS1> $(command -v command_not_found_handle) :$PATH:"\n`);
					await new Promise((r) => setTimeout(r, 100));
				}
				const r = re.exec(out.slice(at));
				assert.ok(r, `${m}: no answer; output:\n${out.slice(-2000)}`);
				return { uid: r[1]!, ps1: r[2]!, handler: r[3]!, path: r[4]!.split(":") };
			};
			const check = (r: Awaited<ReturnType<typeof probe>>, uid: string, home: string, what: string) => {
				assert.equal(r.uid, uid, what);
				assert.match(r.ps1, /⇒/, `${what}: the kw prompt`);
				assert.equal(r.handler, "command_not_found_handle", `${what}: the command not found handler`);
				for (const d of ["/run/kw/bin", `${home}/.local/bin`, "/usr/sbin", "/usr/lib/kw/bin"]) assert.ok(r.path.includes(d), `${what}: ${d} on PATH ${r.path.join(":")}`);
			};
			check(await probe(), "1000", HOME, "the login shell");
			await pty.write(`${name === "alpine" ? "sh" : "bash"}\n`);
			check(await probe(), "1000", HOME, "a nested shell");
			// One step at a time: an exiting sudo's relay may take what is typed behind its shell's exit.
			for (const [cmd, uid, home, what] of [["exit", "1000", HOME, "back in the login shell"], ["sudo -s", "0", "/root", "sudo -s"],
				["exit", "1000", HOME, "back in the login shell"], ["sudo -i", "0", "/root", "sudo -i"], ["exit", "1000", HOME, "back in the login shell"]]) {
				await pty.write(`${cmd}\n`);
				check(await probe(), uid!, home!, what!);
			}
			await pty.close();
			await poweroff(vm);
		});

		test(`${{ alpine: "apk", arch: "pacman", debian: "apt and apt-get" }[name]} typed in an interactive shell run through sudo for the user; \\${{ alpine: "apk", arch: "pacman", debian: "apt" }[name]} is the real one`, async (t) => {
			const vm = await boot(t, { distro: img!.file });
			// A package to install offline: Debian's from a .deb the user builds, Arch's from a package file that is only a .PKGINFO, Alpine's a virtual one.
			const install = { alpine: "apk add --no-network -t kw-test busybox", arch: "pacman -U --noconfirm /tmp/kw-test.pkg.tar", debian: "apt install -y -q /tmp/kw-test.deb" }[name]!;
			if (name === "arch") await sh(vm, "cd /tmp && printf 'pkgname = kw-test\\npkgver = 1-1\\npkgdesc = t\\narch = any\\nsize = 0\\n' > .PKGINFO && tar -cf kw-test.pkg.tar .PKGINFO");
			if (name === "debian") await sh(vm, "mkdir -p /tmp/kwt/DEBIAN && printf 'Package: kw-test\\nVersion: 1\\nArchitecture: all\\nMaintainer: t <t@t>\\nDescription: t\\n' > /tmp/kwt/DEBIAN/control && dpkg-deb --root-owner-group -b /tmp/kwt /tmp/kw-test.deb >/dev/null");
			const real = { alpine: "\\apk add --no-network -t kw-test2 busybox", arch: "\\pacman -U --noconfirm /tmp/kw-test.pkg.tar", debian: "\\apt-get install -y -q /tmp/kw-test.deb" }[name]!;
			const pty = await vm.spawn(undefined, [], { cols: 200, rows: 50 });
			let out = "";
			const dec = new TextDecoder();
			void (async () => { for await (const b of pty.output) out += dec.decode(b, { stream: true }); })().catch(() => {});
			const run = async (line: string, m: string) => {
				await pty.write(`${line}; echo "${m} $?"\n`);
				const re = new RegExp(`${m} (\\d+)`);
				for (let i = 0; i < 1800 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 100));
				return re.exec(out)?.[1];
			};
			assert.equal(await run(install, "R1"), "0", out.slice(-2000));
			assert.notEqual(await run(real, "R2"), "0", "the real command, without sudo, cannot install");
			assert.equal(await run("sudo -n true", "R3"), "0");
			await pty.close();
			assert.equal(await sh(vm, { alpine: "apk info -e kw-test", arch: "pacman -Qq kw-test", debian: "dpkg-query -W -f '${Status}' kw-test" }[name]!), name === "debian" ? "install ok installed" : "kw-test");
			// Scripts have no alias.
			assert.notEqual((await vm.exec("sh", ["-c", { alpine: "apk add --no-network -t kw-test3 busybox", arch: "pacman -U --noconfirm /tmp/kw-test.pkg.tar", debian: "apt-get install -y -q /tmp/kw-test.deb" }[name]!], EXEC)).exitCode, 0);
			await poweroff(vm);
		});

		test("command not found and the shims install packages as the user, through sudo (offline: they get as far as the package manager)", async (t) => {
			const vm = await boot(t, { distro: img!.file });
			// A default route, so that the tools see "a network" and go on to install; a name server
			// that does not answer, with the shortest timeout and one attempt (musl ignores the port
			// unreachable and would wait 5 s a lookup), so that their downloads fail fast.
			await asRoot(vm, "ip route add default dev lo && printf 'nameserver 127.0.0.1\\noptions timeout:1 attempts:1\\n' > /etc/resolv.conf");
			// Debian: apt-get is a stub that logs its uid and arguments and fails at once. A real
			// apt-get takes ~8 s a run on the emulator, and offline the shims run three each
			// (install, update, which exits 0, and the install again): ~100 s.
			if (name === "debian") await asRoot(vm, `printf '%s\\n' '#!/bin/sh' 'echo "$(id -u) $*" >>/tmp/kw-apt.log' 'exit 100' >/usr/bin/apt-get`);
			// Arch: pacman is the same stub (the shim waits for the keyring first).
			if (name === "arch") await asRoot(vm, `touch /etc/pacman.d/gnupg/.kw-keys; printf '%s\\n' '#!/bin/sh' 'echo "$(id -u) $*" >>/tmp/kw-pacman.log' 'exit 1' >/usr/bin/pacman`);
			const cnf = { alpine: "/etc/kw-apk-install", arch: "/usr/local/sbin/kw-pacman-install", debian: "/usr/local/sbin/kw-apt-install" }[name]!;
			// rg: in no image (Debian's has htop).
			const r = await vm.exec(cnf, ["rg"], EXEC);
			assert.equal(r.exitCode, 127, r.stderr);
			// As root (through sudo): Alpine fetches its index first, Arch and Debian run their package manager.
			assert.match(r.stderr, { alpine: /rg: not found, fetching the apk index/, arch: /rg: not found, sudo pacman -S ripgrep/, debian: /rg: not found, sudo apt-get install ripgrep/ }[name]!);
			if (name === "alpine") {
				// A fixed version, so that the shim goes on to the library before any download.
				const s = await vm.exec("node", ["--version"], { ...EXEC, env: { KW_NODE_VERSION: "24.0.0" } });
				assert.equal(s.exitCode, 127);
				assert.match(s.stderr, /node: sudo apk add libgcc \(node needs libgcc_s\.so\.1\)/);
			} else if (name === "arch") {
				// A failed install fetches the lists; that fails too, so no second install.
				assert.match(r.stderr, /fetching the package lists/);
				assert.equal(await sh(vm, "cat /tmp/kw-pacman.log"), ["0 -S --noconfirm --needed ripgrep", "0 -Sy --noconfirm"].join("\n"));
			} else {
				// A failed install fetches the lists; the update fails too, so no second install.
				assert.match(r.stderr, /fetching the package lists/);
				const d = await vm.exec("docker", ["ps"], EXEC);
				assert.equal(d.exitCode, 127, d.stderr);
				assert.match(d.stderr, /docker: sudo apt-get install docker\.io docker-cli crun/);
				assert.match(d.stderr, /docker: installing docker\.io, docker-cli and crun failed/);
				// Both ran apt-get as root.
				assert.equal(await sh(vm, "cat /tmp/kw-apt.log"), [
					"0 install -y -q --no-install-recommends ripgrep",
					"0 update -q",
					"0 install -y -q --no-install-recommends docker.io docker-cli crun",
					"0 update -q",
				].join("\n"));
			}
			await poweroff(vm);
		});

		test("the image file is unchanged", () => {
			assert.equal(sha(img!.file), img!.sha);
			assert.ok(!existsSync(`${img!.file}.kwsnap`), "no snapshot sidecar for a read-only image");
		});
	});
}
