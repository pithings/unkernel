// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The launcher: presets that show what unkernel runs, opened from the status
// line's first item (components/Launcher.tsx). Each demo is a file in demos/,
// listed in order in demos/index.ts. The page ships no assets for
// them, so a demo is text only: files written into the guest, packages
// installed with apk, commands run in a new terminal window, and the
// preview opened on the ports it serves.
//
// launch(demo):
// 1. writes the demo's files (loaded first when the demo gives a loader)
//    under its directory (~/demos/<id> unless it
//    sets dir) through vm.exec(), one exec per file (waiting for the
//    guest's kwtty while it boots), and run.sh there: the running distro's
//    packages not yet installed (Alpine: community enabled if the demo
//    asks, then `apk add`; Debian: `apt-get install`, once more after
//    `apt-get update` when the image's baked package lists name a version
//    the mirror no longer has), then the commands, each printed before it
//    runs, under set -e. vm.exec() and the window run as the distro's user
//    (sudo.ts): the directory is made the user's (with sudo when it is
//    outside the user's reach, nginx's /srv/nginx), a file the user cannot
//    write (an absolute path under /etc) is written with sudo, and run.sh
//    runs the package manager, and the commands written `$SUDO cmd`, with
//    sudo (SUDO_SH), printing them as `sudo cmd`, so what it shows is what
//    to type; as root (the base shell) without it;
// 1b. gets the demo's downloads on the page (download.ts: plain http over
//    Wisp, checked against their SHA-256, kept in the browser's cache) and
//    pushes each into the guest, unless its `unless` test passes in dir or
//    the file is there already. A failure is logged and toasted, not fatal:
//    the demo's script must check the file and fetch it itself when missing;
// 2. opens a terminal window named after the demo (windows.ts) running
//    WRAP_SH in place of the login shell: it runs `cd <dir> && ./run.sh`
//    and then execs the login shell, so the window stays to edit run.sh
//    and run it again. Ctrl-C stops run.sh, not the wrapper. (Typing the
//    command into a fresh shell lost the start of the line: the login reads
//    or flushes input typed ahead of its prompt.)
// 3. with ports, waits until the guest answers http on each, opens the
//    preview on the first (preview.ts) and toasts the others.
// A demo runs once at a time: launching one whose window is open (a window
// named after it, even after run.sh ended) shows that window instead.
// A demo names its packages per distro (`packages: { alpine, debian }`), since
// the names differ; its scripts handle what else differs (paths, wget on
// Alpine and curl on Debian, apk's or dpkg's database). Alpine's come from
// main; a demo with `community` enables community first (lazy in the image,
// .agents/kernel/guest.md), once per guest.
// A demo whose `needs` the page cannot meet (?display=0, ?net=0, ?sound=0, a
// kernel without the Wayland desktop) is listed
// but disabled, with why; so is one whose `packages` leave out this boot's
// distro (?distro=).
import { fmtMiB, getFile, pushFile, type FileSpec } from "./download.ts";
import { KW } from "./kw.ts";
import { selectWindow } from "./shortcuts.ts";
import { ui$ } from "./store.ts";
import type { KernelHandle } from "./sdk.ts";
import { SUDO_SH } from "./sudo.ts";

export interface DemoFile {
	content: string;
	/** Octal mode as a number, e.g. 0o755. Default 0o644. */
	mode?: number;
}

/** A demo's files, by path relative to its dir, to the home directory (starting with ~/), or absolute. */
export type DemoFiles = Record<string, string | DemoFile>;

/** A tile's pictogram: SVG elements (paths, shapes) as static markup from this repository. */
export interface DemoIcon {
	svg: string;
	viewBox?: string;
}

/** A file the page fetches and pushes into the guest before the demo runs (download.ts). */
export interface DemoDownload extends FileSpec {
	/** Where it goes in the guest: relative to the demo's dir, or absolute. */
	path: string;
	/** A shell test run in dir: when it succeeds the file is not needed, and nothing is fetched. */
	unless?: string;
}

/** The distro images a demo can name packages for. */
export type Distro = "alpine" | "debian";
const DISTROS: Distro[] = ["alpine", "debian"];
const isDistro = (s: string): s is Distro => (DISTROS as string[]).includes(s);

export interface Demo {
	id: string;
	title: string;
	/** Left out of the launcher (a demo that is not ready yet); its file stays. */
	hidden?: boolean;
	/** One line: the tile's tooltip, and what search matches besides the title. */
	desc: string;
	/**
	 * The tile's glyph: a character or an emoji (default: the title's first
	 * letter), or a pictogram as inline SVG markup in `viewBox` (default
	 * "0 0 24 24"), filled white (currentColor) unless the markup sets its own.
	 */
	icon?: string | DemoIcon;
	/** The tile's gradient, top left to bottom right (CSS colours). */
	colors?: [string, string];
	/** wayland: the Wayland desktop (wayland.ts: a kernel with vsock and kwshm). */
	needs?: { display?: boolean; net?: boolean; sound?: boolean; wayland?: boolean };
	/** The working directory in the guest. Default ~/demos/<id>. */
	dir?: string;
	/**
	 * Files to write, by path relative to dir, to ~ (~/...) or absolute
	 * (written with sudo when the user cannot write it), or a function
	 * that loads them when the demo launches (a dynamic import), which keeps
	 * their text out of the page's main chunk.
	 */
	files?: DemoFiles | (() => Promise<DemoFiles>);
	/** Files fetched by the page and pushed into the guest before run.sh starts. */
	downloads?: DemoDownload[];
	/**
	 * Packages to install first (those not installed yet), per distro. With
	 * it, the demo runs only on the distros it names (an empty list: nothing
	 * to install there).
	 */
	packages?: Partial<Record<Distro, string[]>>;
	/**
	 * Alpine: some packages are in community: enable it first (/etc/kw-apk-enable).
	 * The image starts apk with main only, since every apk command parses
	 * all enabled indexes and community's makes that ~2 s slower.
	 */
	community?: boolean;
	/**
	 * Shell commands run in order in dir (run.sh, set -e); the last may run in
	 * the foreground. A step that needs root is written `$SUDO cmd` (sudo.ts),
	 * and printed as `sudo cmd`.
	 */
	commands: string[];
	/** Ports the demo serves http on: the preview opens on the first once it answers. */
	ports?: number[];
}

/** Show or hide the launcher overlay (components/Launcher.tsx). */
export function setLauncher(open: boolean): void {
	const $ = ui$();
	if ($.get().launcher === open) return;
	if (open) KW.ui?.closePanel();
	$.set({ launcher: open });
	if (!open && !KW.config.coarse) KW.term?.focus();
}
export const toggleLauncher = (): void => setLauncher(!ui$().get().launcher);

/** The distros the demo runs on, or null for any. */
export function demoDistros(d: Demo): Distro[] | null {
	return d.packages ? DISTROS.filter((x) => d.packages![x]) : null;
}

/** The packages the demo installs on this boot's distro. */
export function demoPackages(d: Demo): string[] {
	const g = KW.config.guest;
	return isDistro(g) ? d.packages?.[g] ?? [] : [];
}

const DISTRO_NAMES: Record<Distro, string> = { alpine: "Alpine", debian: "Debian" };

/** Why the demo cannot run on this page, or null. */
export function unavailable(d: Demo): string | null {
	if (d.needs?.display && !KW.config.display) return "needs the display (off with ?display=0)";
	if (d.needs?.net && !KW.config.net) return "needs the network (off with ?net=0)";
	if (d.needs?.sound && !KW.config.sound) return "needs sound (off with ?sound=0)";
	if (d.needs?.wayland && KW.vm && !ui$().get().desktop.available) return "needs the Wayland desktop: this boot has no kwshm (?shm=0, or a session resumed from before the desktop)";
	const on = demoDistros(d);
	const g = KW.config.guest;
	if (on && !(isDistro(g) && on.includes(g)))
		return `runs on ${on.map((x) => DISTRO_NAMES[x]).join(" or ")}; this boot runs ${g === "none" ? "no distro" : isDistro(g) ? DISTRO_NAMES[g] : g} (Options, Distro)`;
	return null;
}

/** Single-quoted for sh. */
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Makes the demo's directory $1 (relative to ~, or absolute) and gives it to
// the user: one outside the user's reach (/srv/nginx), or one that is root's
// (made by a launcher of the days when sessions ran as root), is made and
// handed over with sudo, so the user can edit its files.
const DIR_SH = `cd ~
mkdir -p "$1" 2>/dev/null && [ "$(stat -c %u "$1")" = "$(id -u)" ] && exit 0
${SUDO_SH}
S=\${SUDO:+$SUDO -n}
$S mkdir -p "$1" && $S chown -R "$(id -u):$(id -g)" "$1"`;

// Writes stdin to $1 (relative to ~, or absolute) with mode $2, making its
// directory; as root (sudo) when the user cannot write it there (a file
// under /etc), so such a file stays root's.
const WRITE_SH = `set -e
cd ~
case "$1" in */*) d=\${1%/*};; *) d=.;; esac
S=
if ! { mkdir -p "$d" 2>/dev/null && [ -w "$d" ] && { [ ! -e "$1" ] || [ -w "$1" ]; }; }; then
	${SUDO_SH}
	S=\${SUDO:+$SUDO -n}
fi
$S mkdir -p "$d"
$S tee "$1" >/dev/null
$S chmod "$2" "$1"`;

/** A path in a demo: relative to its dir, else to ~ (~/...), else absolute. */
const demoPath = (dir: string, rel: string) => (rel.startsWith("/") || rel.startsWith("~/") ? rel : `${dir}/${rel}`);
/** As $1 of a script that runs `cd ~` first: no ~/. */
const fromHome = (path: string) => path.replace(/^~\//, "");

async function writeFiles(vm: KernelHandle, dir: string, files: DemoFiles) {
	// sh expands the ~ in dir; paths are passed as $1 so they are not split.
	const d = await vm.exec("/bin/sh", ["-c", DIR_SH, "sh", dir === "~" ? "." : fromHome(dir)]);
	if (d.exitCode !== 0) throw new Error(`making ${dir} failed: ${(d.stderr || d.stdout).trim() || `exit ${d.exitCode}`}`);
	for (const [rel, f] of Object.entries(files)) {
		const { content, mode = 0o644 } = typeof f === "string" ? { content: f } : f;
		const path = demoPath(dir, rel);
		const r = await vm.exec("/bin/sh", ["-c", WRITE_SH, "sh", fromHome(path), mode.toString(8)], { input: content });
		if (r.exitCode !== 0) throw new Error(`writing ${path} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.exitCode}`}`);
	}
}

// Prints "need" when $2 (relative to ~, or absolute) is missing or not $3
// bytes long and the test $4 fails, run in $1.
const NEED_SH = `cd ~ && cd "$1" || exit 1
[ -n "$4" ] && eval "$4" >/dev/null 2>&1 && exit 0
cd ~
[ -f "$2" ] && [ "$(stat -c %s "$2")" = "$3" ] && exit 0
echo need`;

/** Fetch and push the demo's downloads (step 1b at the top of this file). Never rejects. */
async function pushDownloads(vm: KernelHandle, d: Demo, dir: string): Promise<void> {
	const ui = KW.ui!;
	for (const f of d.downloads ?? []) {
		const path = demoPath(dir, f.path);
		const name = f.url.replace(/[?#].*$/, "").split("/").pop() || f.url;
		try {
			const need = await vm.exec("/bin/sh", ["-c", NEED_SH, "sh", dir.replace(/^~\/?/, "") || ".", fromHome(path), String(f.size ?? -1), f.unless ?? ""]);
			if (need.stdout.trim() !== "need") continue;
			const t0 = performance.now();
			const got = await getFile(f, {
				servers: KW.config.wisp,
				signal: AbortSignal.timeout(30 * 60_000),
				onProgress: (n, total) => ui.toast(`${d.title}: fetching ${name}: ${fmtMiB(n)}${total ? ` of ${fmtMiB(total)}` : ""}`),
			});
			const t1 = performance.now();
			ui.toast(`${d.title}: copying ${name} into the guest`);
			await pushFile(vm, path, got.bytes);
			ui.log(`[demo] ${d.id}: pushed ${name} (${fmtMiB(got.bytes.length)}, ${got.source === "cache" ? "from the browser cache" : "downloaded"}` +
				`${got.checked ? "" : ", SHA-256 not checked: no secure context"}) to ${path}: ` +
				`${((t1 - t0) / 1000).toFixed(1)} s to get, ${((performance.now() - t1) / 1000).toFixed(1)} s to push`, "h");
		} catch (e) {
			const msg = (e as Error)?.message ?? String(e);
			ui.log(`[demo] ${d.id}: ${name}: ${msg}; the guest fetches it instead`, "e");
			ui.toast(`${d.title}: could not fetch ${name} on the page (${msg}); the guest fetches it instead`);
		}
	}
}

/**
 * A step as run.sh prints it after its dim "$ ", as one sh word: each
 * `$SUDO ` prints as "sudo " where run.sh uses sudo, else as nothing.
 */
function shownWord(shown: string): string {
	const parts = shown.split("$SUDO ");
	return parts.map((p) => (p || parts.length === 1 ? q(p) : "")).join('"${SUDO:+sudo }"');
}

/** run.sh for this boot's distro: the packages, then the commands, each printed (dim, after a $) before it runs. */
export function runScript(d: Demo): string {
	const step = (shown: string, cmd = shown) => `printf '\\033[90m$ %s\\033[0m\\n' ${shownWord(shown)}\n${cmd}\n`;
	const pkgs = demoPackages(d);
	const pk = pkgs.map(q).join(" ");
	let install = "";
	if (pk && KW.config.guest === "alpine") {
		install = (d.community ? step("$SUDO /etc/kw-apk-enable   # community") : "") +
			step(`$SUDO apk add ${pkgs.join(" ")}`, `apk info -e ${pk} >/dev/null 2>&1 || $SUDO apk add ${pk}`);
	} else if (pk) {
		// stdin from /dev/null: dpkg would eat what was typed ahead. The image's
		// package lists are baked in and age: when a version is gone from the
		// mirror, the install fails, and runs again after apt-get update.
		const get = `$SUDO apt-get install -y -q --no-install-recommends ${pk} </dev/null`;
		install = step(`$SUDO apt-get install ${pkgs.join(" ")}`,
			`[ "$(dpkg-query -W -f='\${db:Status-Status}\\n' ${pk} 2>/dev/null | grep -cx installed)" = ${pkgs.length} ] ||\n` +
			`	${get} || { $SUDO apt-get update -q </dev/null && ${get}; }`);
	}
	return `#!/bin/sh
# The ${d.title} demo, written by the unkernel launcher for ${KW.config.guest}. Edit it and run it again.
set -e
# Root for the steps written $SUDO: sudo, unless this runs as root already.
${SUDO_SH}
cd "$(dirname "$0")"
${install}${d.commands.map((c) => step(c)).join("")}`;
}

// Runs in a demo's window as `sh -lc WRAP_SH sh DIR SHOWN`: run.sh in DIR
// (relative to ~, or absolute; SHOWN is how to print it), then the login
// shell. The INT trap (a handler, reset in children) keeps this shell alive
// when Ctrl-C stops run.sh.
const WRAP_SH = `trap : INT
printf '\\033[90m$ cd %s && ./run.sh\\033[0m\\n' "$2"
cd && cd "$1" && ./run.sh
printf '\\033[90m[run.sh ended (status %s); ./run.sh runs it again]\\033[0m\\n' "$?"
exec "\${SHELL:-/bin/sh}" -l`;

/** Resolves once http://localhost:port answers at all (any status), or rejects after timeout ms. */
export async function waitPort(vm: KernelHandle, port: number, timeout: number, signal?: AbortSignal) {
	const end = performance.now() + timeout;
	for (;;) {
		signal?.throwIfAborted();
		try {
			const r = await vm.fetch(`http://localhost:${port}/`, { method: "HEAD", signal: AbortSignal.timeout(5000) });
			await r.body?.cancel();
			return;
		} catch {
			if (performance.now() > end) throw new Error(`nothing answered on port ${port} within ${timeout / 1000} s`);
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
}

/** ?showcase: the scripted tour of the demos, for a recording (showcase.ts). Called once the guest is up (boot.ts). */
export function showcaseFromUrl(): void {
	const v = new URLSearchParams(location.search).get("showcase");
	if (v === null || v === "0") return;
	void import("./showcase.ts").then((m) => m.runShowcase(v), (e) => KW.ui?.toast(`showcase: ${(e as Error)?.message ?? e}`));
}

/** ?try=<src>: a project's "try it" link, its unkernel.json run as a demo (try.ts). Called once the guest is up (boot.ts). */
export function tryFromUrl(): void {
	const src = new URLSearchParams(location.search).get("try");
	if (src) void import("./try.ts").then((m) => m.launchTry(src), (e) => KW.ui?.toast(`?try: ${(e as Error)?.message ?? e}`));
}

/** Demos between the click and their window appearing (the files are being written). */
const starting = new Set<string>();

/** The terminal window a demo runs in (named after it), if one is open. */
export const demoWindow = (d: Demo) => KW.windows?.list().find((w) => w.n !== 0 && w.name === d.id);

/**
 * Run a demo in a new terminal window (see the top of this file), or show
 * its window if it already has one: a demo runs once at a time. Failures
 * are toasts.
 */
export async function launch(d: Demo): Promise<void> {
	const ui = KW.ui!;
	const why = unavailable(d);
	if (why) { ui.toast(`${d.title}: ${why}`); return; }
	const vm = KW.vm as KernelHandle | undefined;
	if (!KW.windows || !vm) { ui.toast("The system is not running yet"); return; }
	const open = demoWindow(d);
	if (open) return selectWindow(open.n);
	if (starting.has(d.id)) return;
	starting.add(d.id);
	try {
		const dir = d.dir ?? `~/demos/${d.id}`;
		try {
			const files = typeof d.files === "function" ? await d.files() : d.files;
			await writeFiles(vm, dir, { ...files, "run.sh": { content: runScript(d), mode: 0o755 } });
			await pushDownloads(vm, d, dir);
			// sh -l, so run.sh gets the login environment (PATH, the apk hooks).
			const win = KW.windows.open({ name: d.id, file: "/bin/sh", args: ["-lc", WRAP_SH, "sh", dir.replace(/^~\//, ""), dir] });
			starting.delete(d.id); // the window is listed from here on
			await win;
		} finally {
			starting.delete(d.id);
		}
		// apk add can take minutes on a slow network.
		await Promise.all((d.ports ?? []).map(async (port, i) => {
			await waitPort(vm, port, 600_000);
			if (i === 0) KW.preview?.open(port);
			else ui.toast(`${d.title}: port ${port} answers too (Ctrl-A p, then change the port)`);
		}));
	} catch (e) {
		ui.toast(`${d.title}: ${(e as Error)?.message ?? e}`);
	}
}
