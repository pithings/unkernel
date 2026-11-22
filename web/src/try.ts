// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Behnam Azimi
// ?try=<src>: a "try it" link for a project's README. Once the guest is up
// (tryFromUrl in launcher.ts) the page fetches the project's unkernel.json,
// checks it, shows what it will install and run, and on OK runs it as a demo
// (launcher.ts launch()) in ~/try/<id>, in a window named try-<id>.
//
//   ?try=gh:owner/repo[@ref]   https://raw.githubusercontent.com/owner/repo/<ref, default HEAD>/unkernel.json
//   ?try=https://...           any spec URL whose server sends Access-Control-Allow-Origin
//   ?try=/try/jq.json          a spec on this page's own origin (public/try/, the examples)
//
// unkernel.json, version 1 (unknown fields are ignored):
//   unkernel     1, required; any other version is refused
//   name         required; the window's title, and <id> (the name as a slug)
//   description  one line for the confirm dialog
//   install      { aarch64 | x86_64 | riscv64: { url, sha256, bin? } }: a release binary. The
//                first of those present is used; x86_64 and riscv64 run under qemu-user, which
//                only the Alpine image has, so a spec with only those runs on Alpine only. The
//                guest's install.sh fetches it (wget or curl: GitHub's release assets send no
//                CORS and are https only, so the page's download.ts cannot), checks the SHA-256,
//                extracts a .tar.gz, .tgz or .zip (bin: the binary's path inside) and links it
//                into ~/.local/bin as bin's base name (a bare binary: bin if given, else <id>)
//   packages     { alpine?: [...], debian?: [...] }: distro packages to install first (Alpine's
//                community is enabled for them). With it, the spec runs only on the distros it
//                names, as a demo's packages
//   setup        shell commands, one line each, run after packages and install (set -e); a
//                step that needs root is written `$SUDO cmd` (sudo.ts), as in the demos
//   try          example commands, run last; then the window's shell stays in ~/try/<id>
// install or setup is required. A reload asks and runs it all again: install skips a file
// whose hash matches, and setup commands should be safe to repeat.
//
// The spec comes from a third party, so every field is checked here, and the
// dialog (untrusted: OK arms after a moment) lists every package, download and
// command before anything runs. It runs only inside the guest; nothing in it
// reaches the page but text shown in the dialog and the toasts.
import { demoPackages, launch, q, unavailable, type Demo, type Distro } from "./launcher.ts";
import { KW } from "./kw.ts";

/** The spec's URL for a ?try= value, or null. */
export function tryUrl(src: string): string | null {
	const gh = /^gh:([\w.-]+)\/([\w.-]+)(?:@([\w./-]+))?$/.exec(src);
	if (gh && /(^|[/@])\.\.?([/@]|$)/.test(src.slice(3))) return null;
	if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3] ?? "HEAD"}/unkernel.json`;
	try {
		const u = new URL(src, location.href);
		return u.protocol === "https:" || u.origin === location.origin ? u.href : null;
	} catch { return null; }
}

const ARCHES = ["aarch64", "x86_64", "riscv64"] as const;
const ARCHIVE = /\.(tar\.gz|tgz|zip)$/;
const NAME = /^[\w.+][\w.+-]*$/;

// install.sh URL SHA256 BIN CMD, run in ~/try/<id>: fetch unless the file there
// matches (a reload), check, extract, link. Written by the page, not the spec.
const INSTALL_SH = `#!/bin/sh
set -e
url=$1 sha=$2 bin=$3 cmd=$4
f=\${url##*/}
ok() { echo "$sha  $f" | sha256sum -c >/dev/null 2>&1; }
if ! ok; then
	if command -v wget >/dev/null; then wget -qO "$f" "$url"; else curl -fsSLo "$f" "$url"; fi
	ok || { rm -f "$f"; echo "$f: SHA-256 mismatch" >&2; exit 1; }
fi
case $f in
*.tar.gz|*.tgz) tar -xzf "$f" ;;
*.zip) unzip -oq "$f" ;;
*) bin=$f ;;
esac
[ -f "$bin" ] || { echo "$f: no $bin in it" >&2; exit 1; }
chmod 755 "$bin"
mkdir -p ~/.local/bin
ln -sf "$PWD/$bin" ~/.local/bin/"$cmd"
`;

const isStr = (v: unknown): v is string => typeof v === "string";
const strs = (v: unknown, what: string): string[] => {
	if (v === undefined) return [];
	if (!Array.isArray(v) || !v.every(isStr)) throw new Error(`${what}: not a list of strings`);
	return v;
};

export interface TryPlan {
	demo: Demo;
	/** The install entry used, for the dialog. */
	install?: { arch: string; url: string };
}

/** A demo from an untrusted unkernel.json, or throws why not. */
export function specToDemo(s: any): TryPlan {
	if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("not a JSON object");
	if (s.unkernel !== 1) throw new Error(`unkernel: version ${JSON.stringify(s.unkernel)} is not supported (this page reads 1)`);
	if (!isStr(s.name) || !s.name.trim()) throw new Error("name: missing");
	const id = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "try";

	let packages: Demo["packages"];
	if (s.packages !== undefined) {
		if (!s.packages || typeof s.packages !== "object" || Array.isArray(s.packages)) throw new Error("packages: not an object of distro: [names]");
		packages = {};
		for (const g of ["alpine", "debian"] as Distro[]) {
			if (s.packages[g] === undefined) continue;
			const p = strs(s.packages[g], `packages.${g}`);
			if (!p.every((x) => NAME.test(x))) throw new Error(`packages.${g}: not package names`);
			packages[g] = p;
		}
		if (!packages.alpine && !packages.debian) throw new Error("packages: names neither alpine nor debian");
	}
	// One line each, so the dialog cannot push a command out of sight.
	const line = (v: unknown, what: string) => {
		const c = strs(v, what);
		if (c.some((x) => /[\x00-\x1f\x7f]/.test(x))) throw new Error(`${what}: a command with a control character (a newline?)`);
		return c;
	};
	const setup = line(s.setup, "setup");
	const tries = line(s.try, "try");

	const commands: string[] = [];
	let install: TryPlan["install"];
	if (s.install !== undefined) {
		if (!s.install || typeof s.install !== "object") throw new Error("install: not an object");
		const arch = ARCHES.find((a) => s.install[a] !== undefined);
		if (!arch) throw new Error(`install: none of ${ARCHES.join(", ")}`);
		const e = s.install[arch];
		const file = isStr(e?.url) ? e.url.split("/").pop()! : "";
		if (!isStr(e?.url) || !/^https:\/\/[^\s?#]+\/[^\s?#/]+$/.test(e.url) || !NAME.test(file)) throw new Error(`install.${arch}.url: not an https URL ending in a file name`);
		if (!isStr(e.sha256) || !/^[0-9a-f]{64}$/i.test(e.sha256)) throw new Error(`install.${arch}.sha256: not 64 hex digits`);
		const sha = e.sha256.toLowerCase();
		const archive = ARCHIVE.test(file);
		if (e.bin !== undefined || archive) {
			if (!isStr(e.bin) || !e.bin.split("/").every((p: string) => NAME.test(p) && p !== "..")) throw new Error(`install.${arch}.bin: ${archive ? "missing or " : ""}not a relative path`);
		}
		const bin: string = archive ? e.bin : "";
		const cmd: string = e.bin?.split("/").pop() ?? id;
		if (arch !== "aarch64") {
			// qemu-user is in the Alpine image only (.agents/kernel/guest.md, Foreign binaries).
			if (packages && !packages.alpine) throw new Error(`install: only an ${arch} build, which runs on Alpine only, and no packages.alpine`);
			packages = { alpine: packages?.alpine ?? [] };
		}
		commands.push(`./install.sh ${[e.url, sha, bin, cmd].map(q).join(" ")}`);
		install = { arch, url: e.url };
	}
	if (!install && !setup.length) throw new Error("needs install or setup");
	commands.push(...setup, ...tries);

	return {
		install,
		demo: {
			id: `try-${id}`, title: s.name.slice(0, 60), desc: isStr(s.description) ? s.description.slice(0, 200) : "",
			dir: `~/try/${id}`, needs: { net: true },
			packages, community: !!packages?.alpine?.length,
			files: install ? { "install.sh": { content: INSTALL_SH, mode: 0o755 } } : {},
			commands,
		},
	};
}

/** What the dialog lists: everything the spec will install or run on this boot's distro. */
function summary({ demo: d, install }: TryPlan): string {
	const lines: string[] = [];
	const pk = demoPackages(d);
	if (pk.length) lines.push(`${KW.config.guest === "alpine" ? "apk add" : "apt-get install"} ${pk.join(" ")}`);
	if (install) lines.push(`get ${install.url}${install.arch === "aarch64" ? "" : ` (${install.arch}, under qemu-user)`}`);
	for (const c of d.commands.slice(install ? 1 : 0)) lines.push(`$ ${c.replaceAll("$SUDO ", "sudo ")}`);
	return lines.join("\n");
}

/** Launches ?try=<src> (launcher.ts tryFromUrl, once the guest is up). Failures are toasts. */
export async function launchTry(src: string): Promise<void> {
	const ui = KW.ui!;
	try {
		const url = tryUrl(src);
		if (!url) throw new Error("use gh:owner/repo[@ref] or an https URL");
		const r = await fetch(url, { cache: "no-cache", signal: AbortSignal.timeout(30_000) });
		if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
		const plan = specToDemo(await r.json());
		const d = plan.demo;
		const why = unavailable(d);
		if (why) throw new Error(why);
		if (!await ui.ask({
			title: `try ${d.title}`,
			msg: `${src}${d.desc ? `: ${d.desc}` : ""}. It asks to run this in the guest, in ${d.dir}:`,
			url: summary(plan), ok: "Run", untrusted: true,
		})) return;
		await launch(d);
	} catch (e) {
		ui.toast(`?try=${src}: ${(e as Error)?.message ?? e}`);
	}
}
