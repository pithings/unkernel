// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// What the page runs: the base bundle unkernel.wasm (the kernel and the
// base initramfs, with an SMP patch section) and the read-only distro
// images it boots (NAME.erofs), which the page attaches by URL and reads
// lazily with Range requests (the SDK's createKernel({ distro })).
// vite.config.ts calls pageSource() when the dev server starts and when the
// page is built, before anything is served or built. In this order:
//   1. KW_KERNEL=<file> and/or KW_DISTROS=<dir>: that base bundle and the
//      images in that directory (the other from the local build), whatever
//      KW_LOCAL says.
//   2. A local build, when one may be used (localPolicy(): KW_LOCAL=1
//      forces it, KW_LOCAL=0 forbids it, and by default it is off when CI
//      or VERCEL is set, whose builds have no vendor/ and must ship a
//      release): vendor/build/bundle/unkernel.wasm and at least one image
//      in vendor/build/distro/ (kernel/build.sh base and distro, or all).
//   3. Else the Latest GitHub release of this repository (KW_KERNEL_RELEASE=
//      <tag>: that one), which must carry page.json (web/scripts/page-assets.ts;
//      the release workflow attaches it); a release without it (every one
//      before v0.2.0-261127-3b71fa5) is refused with what to do instead.
// It logs which it picked and why (a page build between two lines of =).
// The About dialog says "local build" for 1 and 2 and names the release
// for 3.
//
// A release: only page.json is downloaded (at build time, and when a dev
// server starts), and the page loads everything from the release mirror
// (KW_MIRROR, default
// https://mirror.unkernel.dev/github/pithings/unkernel/releases/download,
// then /<tag>/<file>), which sends GitHub's release assets with CORS (GitHub
// sends them without, so a browser cannot fetch them there): the UP and SMP
// kernels and the Vulkan translator gzipped (<file>.wasm.gz, gunzipped by
// the SDK), the GL renderer and the images as they are (the images read
// with Range requests). Nothing is copied into the output. The mirror
// answers only the origins it knows (unkernel.dev, localhost, LAN
// addresses, *.vercel.app). page.json must say this checkout's ABI, or the
// build fails.
//
// For a local build (1 and 2):
// The kernel's URLs: the dev server serves the base's UP and SMP bundles
// from web/kernel/page/<hash>/ (splitBase(), written again when the bundle
// changes); a build emits them as hashed assets from memory (baseSplit()),
// so it never touches the dev server's files. splitBundle() takes the SMP
// patch section off the bundle (kernel/tools/bundle.mjs --smp): the UP
// bundle is the bundle without it, the SMP one the kernel the patch makes
// with the same initramfs, command line and data disk template
// (js/core/kpatch.ts); without the section there is no SMP bundle.
//
// The guest GL renderer (createKernel({ gl }), the page's GL option):
// virgl.mjs and virgl.wasm (gl/wasm/build.sh), optional. KW_GL=<dir> gives
// them (KW_GL=0: none); else a local build's vendor/build/gl-wasm/ with a
// local kernel, or the release's (page.json's gl) on the mirror.
// Without them the page offers no GL. The dev server serves them at
// /_gl/virgl.mjs and /_gl/virgl.wasm; a build emits both into
// /assets/virgl-<16 hex digits of their sha256>/, side by side, because
// virgl.mjs finds virgl.wasm next to itself.
//
// The guest Vulkan renderer's SPIR-V to WGSL translator (createKernel({ vk }),
// the page's Vulkan option): kwvk-naga.wasm (vk/naga/build.sh), optional,
// picked the same way: KW_VK=<dir> (KW_VK=0: none), else a local build's
// vendor/build/vk/ with a local kernel, else the release's (page.json's vk)
// on the mirror. Without it the page offers no Vulkan. The dev server serves it at
// /_vk/kwvk-naga.wasm; a build emits it as /assets/kwvk-naga-<16 hex digits
// of its sha256>.wasm.
//
// The images' URLs: the dev server answers /distros/<name>.erofs itself
// (vite.config.ts, server/range.ts; revalidated, since a local image is
// rebuilt in place). A build names each by its content,
// /distros/<name>-<first 16 hex digits of its sha256>.erofs, immutable and
// cached for a year by browsers and CDNs, and copies it there into the
// output (vite.config.ts unkernel:distro-images; server/distros.ts on Node,
// static files on Vercel).
//
// Environment:
//   KW_KERNEL=<file>          the base bundle (relative to web/), e.g.
//                             KW_KERNEL=../vendor/build/bundle/unkernel.wasm
//   KW_DISTROS=<dir>          the images (<name>.erofs; distros.json there
//                             gives their image ids)
//   KW_GL=<dir> | 0           the GL renderer (virgl.mjs, virgl.wasm) | none
//   KW_VK=<dir> | 0           the Vulkan translator (kwvk-naga.wasm) | none
//   KW_KERNEL_RELEASE=<tag>   this release instead of the newest (e.g. v0.2.0)
//   KW_MIRROR=<url>           the release mirror (the base before /<tag>/<file>)
//   KW_LOCAL=1 | 0            use a local build when there is one (default,
//                             except when CI or VERCEL is set) | never
//   GITHUB_TOKEN, GH_TOKEN    for the GitHub API (60 requests an hour without
//                             one; past that, github.com's /releases/latest
//                             redirect is used)
//   KW_GITHUB_API, KW_GITHUB  the API and web origins (default
//                             https://api.github.com, https://github.com):
//                             a stand-in server for testing
// A local build whose ABI is not this checkout's only gets a warning.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { smpKernelFromBundle, withoutSmpPatch } from "../../js/core/kpatch.ts";

const REPO = "pithings/unkernel";
const GITHUB_API = (process.env.KW_GITHUB_API || "https://api.github.com").replace(/\/+$/, "");
const GITHUB = (process.env.KW_GITHUB || "https://github.com").replace(/\/+$/, "");
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIR = fileURLToPath(new URL("../kernel/", import.meta.url));
/** The dev server's split of the base bundle (splitBase()). */
const PAGE_DIR = `${DIR}page/`;
/** A local build's base bundle and images. */
const LOCAL_BASE = `${ROOT}vendor/build/bundle/unkernel.wasm`;
const LOCAL_DISTROS = `${ROOT}vendor/build/distro/`;
const LOCAL_GL = `${ROOT}vendor/build/gl-wasm/`;
/** The guest GL renderer's files (gl/wasm/build.sh; release assets of the same names). */
export const GL_FILES = ["virgl.mjs", "virgl.wasm"] as const;
const LOCAL_VK = `${ROOT}vendor/build/vk/`;
/** The guest Vulkan renderer's translator (vk/naga/build.sh; a release asset of the same name). */
export const VK_FILE = "kwvk-naga.wasm";
const BASE_ASSET = "unkernel.wasm";
const INDEX_ASSET = "distros.json";
/** An image file: NAME.erofs or NAME.ext4 (distros.json's `file`). */
const IMAGE_RE = /^([a-z0-9]+)\.(erofs|ext4)$/;

/** Which kernel the page runs, for the About dialog (__KW_BUILD__). */
export interface KernelRelease {
	/** The release's tag, or "local" for a local build. */
	tag: string;
	/** When it was published (ISO 8601), or the local file's time; "" if unknown. */
	date: string;
	/** The base bundle's sha256. */
	sha256: string;
}

/** One distro image the page offers, as the page gets it (virtual:unkernel-kernel). */
export interface PageDistro {
	/** The distro's name (`?distro=`), as its /usr/lib/kw-distro says. */
	name: string;
	/** Its URL on the page's origin: /distros/<name>.erofs in dev, /distros/<name>-<sha256 prefix>.erofs in a build. */
	url: string;
	size: number;
	/** Its /usr/lib/kw-image, where distros.json gives it (else the page reads it from the guest). */
	imageId?: string;
}

/** A PageDistro and the file behind it (not given to the page). */
export interface PageImage extends PageDistro {
	file: string;
	sha256: string;
}

export interface PageSource {
	/** Why this source (logged; a build's log and the dev server's first line). */
	why: string;
	kernel: KernelRelease;
	/** The base bundle's Linux release, from its banner. */
	linux: string;
	/** The base bundle. */
	base: string;
	/** The images, debian first. */
	distros: PageImage[];
	/** The guest GL renderer (see the top), or null: the page offers no GL. */
	gl: PageGl | null;
	/** Where the GL renderer comes from, or why there is none (logged). */
	glWhy: string;
	/** The guest Vulkan renderer's translator (see the top), or null: the page offers no Vulkan. */
	vk: PageVk | null;
	/** Where the translator comes from, or why there is none (logged). */
	vkWhy: string;
	/**
	 * The release mirror's URLs (see the top), or null: the page's own files.
	 * With it, base is "" and the images' url is the mirror's (file "").
	 */
	remote: PageRemote | null;
}

/** The URLs a page loads from the release mirror (page.json's files under /<tag>/). */
export interface PageRemote {
	kernel: string;
	kernelSmp: string | null;
	/** virgl.mjs (it loads virgl.wasm next to itself), or null. */
	gl: string | null;
	vk: string | null;
}

/** The guest Vulkan renderer's translator: kwvk-naga.wasm. */
export interface PageVk {
	wasm: string;
	sha256: string;
}

/** The guest GL renderer's files: virgl.mjs and virgl.wasm, in one directory. */
export interface PageGl {
	mjs: string;
	wasm: string;
	/** sha256 of both (the build's directory name). */
	sha256: string;
}

/** One entry of distros.json (guest/tools/distros-json.mjs). */
interface IndexEntry { name: string; file: string; size: number; sha256: string; image?: string | null }
interface DistrosIndex { abi: number | null; base: string | null; distros: IndexEntry[] }
const UA = { "user-agent": "unkernel-web-build" };
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const log = (msg: string) => console.log(`[kernel] ${msg}`);
const mib = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;
/** `f` relative to the repository (absolute outside it), for messages. */
const rel = (f: string) => { const r = path.relative(ROOT, f); return r.startsWith("..") ? f : r || "."; };
const isFile = async (f: string) => { try { return (await stat(f)).isFile(); } catch { return false; } };
export const banner = (bytes: Uint8Array) => /Linux version (\S+)/.exec(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1"))?.[1] ?? "";
/** Debian first (the default), then by name. */
const byName = (a: { name: string }, b: { name: string }) => (a.name === "debian" ? -1 : b.name === "debian" ? 1 : a.name.localeCompare(b.name));

/** sha256 of a file, streamed; cached per path, size and mtime (a dev server hashes again after a rebuild). */
const hashes = new Map<string, { key: string; sum: Promise<string> }>();
async function fileSha256(file: string): Promise<string> {
	const st = await stat(file);
	const key = `${st.size}:${st.mtimeMs}:${st.ino}`;
	const hit = hashes.get(file);
	if (hit?.key === key) return hit.sum;
	const sum = new Promise<string>((resolve, reject) => {
		const h = createHash("sha256");
		createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
	});
	hashes.set(file, { key, sum });
	return sum;
}

/** This checkout's include/kw_emu.h KW_ABI_VERSION. */
async function wantAbi(): Promise<number> {
	const h = await readFile(`${ROOT}include/kw_emu.h`, "utf8");
	const want = Number(/^#define KW_ABI_VERSION (\d+)$/m.exec(h)?.[1]);
	if (!Number.isInteger(want)) throw new Error("include/kw_emu.h: no KW_ABI_VERSION");
	return want;
}

/** A base bundle's kwemu ABI and base id (kernel/tools/bundle.mjs, guest/tools/distros-json.mjs). */
export async function bundleInfo(bytes: Uint8Array): Promise<{ abi: number | null; base: string | null }> {
	const { bundleInfo } = (await import(new URL("../../guest/tools/distros-json.mjs", import.meta.url).href)) as {
		bundleInfo(wasm: Uint8Array): { abi: number | null; base: string | null };
	};
	return bundleInfo(bytes);
}

function checkWasm(bytes: Uint8Array, what: string): void {
	if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error(`${what}: not a wasm module`);
}

/**
 * Write `bytes` to `file` unless it holds them already (a temporary file,
 * then a rename). The temporary name is per call: the dev server may split
 * the same bundle twice at once (its watcher and a page load).
 */
let tmpSeq = 0;
async function writeIfChanged(file: string, bytes: Uint8Array): Promise<void> {
	try {
		if (Buffer.compare(await readFile(file), bytes) === 0) return;
	} catch {}
	const tmp = `${file}.${process.pid}-${++tmpSeq}.tmp`;
	try {
		await writeFile(tmp, bytes);
		await rename(tmp, file);
	} catch (e) {
		await rm(tmp, { force: true });
		throw e;
	}
}

// ---------------------------------------------------------------------------
// Local builds.

/**
 * Whether a local build may be used: KW_LOCAL=1 or 0 says so; by default
 * yes, except where CI or VERCEL is set (a deploy or CI build, which has no
 * vendor/ and ships a release).
 */
function localPolicy(): { ok: boolean; why: string } {
	const v = process.env.KW_LOCAL;
	if (v === "1") return { ok: true, why: "KW_LOCAL=1" };
	if (v === "0") return { ok: false, why: "KW_LOCAL=0" };
	const on = (k: string) => !!process.env[k] && process.env[k] !== "0" && process.env[k] !== "false";
	const ci = on("VERCEL") ? "VERCEL" : on("CI") ? "CI" : "";
	if (ci) return { ok: false, why: `${ci} is set; KW_LOCAL=1 would use a local build` };
	return { ok: true, why: "auto-detected; KW_LOCAL=0 takes the newest release" };
}

/** distros.json in `dir`, if there is a readable one. */
async function readIndex(dir: string): Promise<DistrosIndex | undefined> {
	try {
		const j = JSON.parse(await readFile(path.join(dir, INDEX_ASSET), "utf8")) as DistrosIndex;
		return Array.isArray(j.distros) ? j : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The images in `dir`: NAME.erofs (NAME.ext4 where there is no .erofs),
 * hashed; the image id from distros.json when its entry has the same sha256.
 */
async function scanImages(dir: string): Promise<PageImage[]> {
	let files: string[] = [];
	try { files = await readdir(dir); } catch {}
	const names = new Set(files.filter((f) => IMAGE_RE.test(f)).map((f) => IMAGE_RE.exec(f)![1]!));
	const index = await readIndex(dir);
	const out: PageImage[] = [];
	for (const name of names) {
		const file = path.join(dir, files.includes(`${name}.erofs`) ? `${name}.erofs` : `${name}.ext4`);
		let st;
		try { st = await stat(file); } catch { continue; }
		if (!st.isFile() || st.size === 0) continue;
		const sum = await fileSha256(file);
		const e = index?.distros.find((d) => d.name === name && d.sha256 === sum);
		out.push({ name, url: "", size: st.size, file, sha256: sum, ...(e?.image ? { imageId: e.image } : {}) });
	}
	return out.sort(byName);
}

/** The local build (or KW_KERNEL / KW_DISTROS) as the page's source. */
async function localSource(base: string, images: PageImage[], why: string): Promise<PageSource> {
	const bytes = new Uint8Array(await readFile(base));
	checkWasm(bytes, rel(base));
	const want = await wantAbi();
	const { abi } = await bundleInfo(bytes);
	if (abi !== want) log(`warning: ${rel(base)} has kwemu ABI ${abi ?? "unknown"}, this checkout's include/kw_emu.h has ${want} (a stale local build?)`);
	return { why, kernel: { tag: "local", date: (await stat(base)).mtime.toISOString(), sha256: sha256(bytes) }, linux: banner(bytes), base, distros: images, gl: null, glWhy: "", vk: null, vkWhy: "", remote: null };
}

// ---------------------------------------------------------------------------
// Releases.

interface Asset { url: string; sha256?: string }
interface Resolved { tag: string; date: string; assets: Map<string, Asset> | null }

/**
 * The release to use: from the API (with the assets' digests), else from
 * the web's /releases/latest redirect (assets unknown). The newest is the
 * one GitHub marks Latest: release lists and the release feed are not in
 * publishing order (tags of one version and day, v0.2.0-<date>-<hash>,
 * sort by their hash).
 */
async function resolve(want?: string): Promise<Resolved> {
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	const res = await fetch(`${GITHUB_API}/repos/${REPO}/releases/${want ? `tags/${want}` : "latest"}`, {
		headers: { ...UA, accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
	});
	if (res.ok) {
		const r = await res.json() as { tag_name: string; published_at: string; assets: { name: string; browser_download_url: string; digest?: string | null }[] };
		const assets = new Map(r.assets.map((a) => [a.name, { url: a.browser_download_url, sha256: a.digest?.replace(/^sha256:/, "") || undefined }]));
		return { tag: r.tag_name, date: r.published_at, assets };
	}
	if (res.status === 404) throw new Error(want ? `${REPO} has no release ${want}` : `${REPO} has no releases`);
	// Rate limited (or the API is down): the web's redirect has no limit, but no assets.
	log(`GitHub API: ${res.status} ${res.statusText}; using ${GITHUB}/${REPO}/releases/latest`);
	let tag = want;
	if (!tag) {
		const latest = await fetch(`${GITHUB}/${REPO}/releases/latest`, { headers: UA, redirect: "manual" });
		tag = /\/releases\/tag\/([^/?#]+)/.exec(latest.headers.get("location") ?? "")?.[1];
		if (!tag) throw new Error(`${GITHUB}/${REPO}/releases/latest: ${latest.status} ${latest.statusText}, no release`);
		tag = decodeURIComponent(tag);
	}
	return { tag, date: "", assets: null };
}

/** The error for a release without page.json. */
const notThisLayout = (tag: string, missing: string, why: string) => new Error(
	`release ${tag} of ${REPO} has no ${missing}: it predates the page loading its files from the release mirror ` +
	`(every release before v0.2.0-261127-3b71fa5), or is incomplete. Build locally (kernel/build.sh all; ` +
	`a page build then uses vendor/build, or point KW_KERNEL and KW_DISTROS at a build) or cut a release ` +
	`(.github/workflows/release.yml), or pick a release that has it (KW_KERNEL_RELEASE=<tag>). ` +
	`No local build was used (${why})`);

/** Download `name` of release `r` (its API URL, else the usual download URL); check the API's digest. */
async function download(r: Resolved, name: string, why: string): Promise<Uint8Array> {
	const a = r.assets?.get(name);
	if (r.assets && !a) throw notThisLayout(r.tag, name, why);
	const url = a?.url ?? `${GITHUB}/${REPO}/releases/download/${r.tag}/${name}`;
	const res = await fetch(url, { headers: UA });
	if (res.status === 404 && !r.assets) throw notThisLayout(r.tag, name, why);
	if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (a?.sha256 && sha256(bytes) !== a.sha256) throw new Error(`${url}: sha256 ${sha256(bytes)}, the release says ${a.sha256}`);
	return bytes;
}

/** distros.json's content, checked: this checkout's ABI, well-formed entries, at least one image. */
function checkIndex(j: DistrosIndex, tag: string, want: number): IndexEntry[] {
	if (j.abi !== want) {
		throw new Error(`release ${tag}: distros.json says kwemu ABI ${j.abi ?? "unknown"}, this checkout's include/kw_emu.h has ${want}: ` +
			`the release was built for another guest CPU or kernel contract. Cut a release from this checkout first (.github/workflows/release.yml), ` +
			`build from a local build (KW_LOCAL=1, or KW_KERNEL and KW_DISTROS) or pick a matching release (KW_KERNEL_RELEASE=<tag>)`);
	}
	if (!Array.isArray(j.distros) || !j.distros.length) throw new Error(`release ${tag}: distros.json lists no images`);
	for (const d of j.distros) {
		const m = IMAGE_RE.exec(String(d.file));
		if (!m || m[1] !== d.name || !Number.isSafeInteger(d.size) || d.size <= 0 || !/^[0-9a-f]{64}$/.test(String(d.sha256)))
			throw new Error(`release ${tag}: distros.json: a bad entry ${JSON.stringify(d)}`);
	}
	return j.distros;
}

/** virgl.wasm is wasm; virgl.mjs is the ES module build that finds virgl.wasm next to itself. */
function checkGlFile(name: string, bytes: Uint8Array, what: string): void {
	if (name.endsWith(".wasm")) return checkWasm(bytes, what);
	if (!Buffer.from(bytes).toString("utf8").includes(`new URL("virgl.wasm",import.meta.url)`))
		throw new Error(`${what}: not the ES module build of the GL renderer (it does not locate virgl.wasm next to itself)`);
}

// ---------------------------------------------------------------------------
// The release mirror (see the top).

const PAGE_ASSET = "page.json";
const DEFAULT_MIRROR = `https://mirror.unkernel.dev/github/${REPO}/releases/download`;

/** One file of page.json (web/scripts/page-assets.ts). */
interface PageFile { file: string; size: number; sha256: string; gz?: { file: string; size: number; sha256: string } }
interface PageJson {
	tag: string | null; abi: number | null; base: string | null; linux: string;
	kernel: PageFile; kernelSmp: PageFile | null; gl: PageFile[] | null; vk: PageFile | null; distros: IndexEntry[];
}

/** The release mirror's base (see the top). */
const MIRROR = (process.env.KW_MIRROR || DEFAULT_MIRROR).replace(/\/+$/, "");

/** The release's page.json as the page's source, its files on the mirror (see the top); `why`: why no local build. */
async function releaseSource(why: string): Promise<PageSource> {
	const want = process.env.KW_KERNEL_RELEASE || undefined;
	let r: Resolved;
	try {
		r = await resolve(want);
	} catch (e) {
		throw new Error(`cannot find the page's release on ${REPO}'s GitHub releases: ${(e as Error).message}. ` +
			`No local build was used (${why}): build locally (kernel/build.sh all) or give KW_KERNEL and KW_DISTROS`);
	}
	const bytes = await download(r, PAGE_ASSET, why);
	let j: PageJson;
	try { j = JSON.parse(Buffer.from(bytes).toString("utf8")) as PageJson; }
	catch { throw new Error(`release ${r.tag}: ${PAGE_ASSET} is not JSON`); }
	const abi = await wantAbi();
	const entries = checkIndex({ abi: j.abi, base: j.base, distros: j.distros }, r.tag, abi);
	const okFile = (f: PageFile | null | undefined) => !!f && /^[a-z0-9.-]+$/.test(f.file) && Number.isSafeInteger(f.size) && /^[0-9a-f]{64}$/.test(f.sha256);
	if (!okFile(j.kernel) || (j.kernelSmp && !okFile(j.kernelSmp)) || (j.vk && !okFile(j.vk)) || (j.gl && (j.gl.length !== GL_FILES.length || !j.gl.every(okFile))))
		throw new Error(`release ${r.tag}: ${PAGE_ASSET}: a bad file entry`);
	const url = (name: string) => `${MIRROR}/${encodeURIComponent(r.tag)}/${name}`;
	// The gzipped copy where there is one (the SDK gunzips it).
	const pick = (f: PageFile) => url(f.gz?.file ?? f.file);
	const gl = j.gl?.find((f) => f.file === GL_FILES[0]) ?? null;
	const distros = entries.map((d) => ({
		name: d.name, url: url(d.file), size: d.size, file: "", sha256: d.sha256, ...(d.image ? { imageId: d.image } : {}),
	})).sort(byName);
	return {
		why: `release ${r.tag} on the mirror ${MIRROR} (${why})`,
		kernel: { tag: r.tag, date: r.date, sha256: r.assets?.get(BASE_ASSET)?.sha256 ?? "" },
		linux: j.linux, base: "", distros, gl: null, vk: null,
		glWhy: gl ? `release ${r.tag} on the mirror` : `release ${r.tag} has no ${GL_FILES.join(" and ")}`,
		vkWhy: j.vk ? `release ${r.tag} on the mirror` : `release ${r.tag} has no ${VK_FILE}`,
		remote: { kernel: pick(j.kernel), kernelSmp: j.kernelSmp ? pick(j.kernelSmp) : null, gl: gl ? url(gl.file) : null, vk: j.vk ? pick(j.vk) : null },
	};
}

// ---------------------------------------------------------------------------
// The choice (see the top).

/** GL_FILES in `dir`, checked and hashed, or null when either is missing. */
async function glDir(dir: string): Promise<PageGl | null> {
	const [mjs, wasm] = GL_FILES.map((f) => path.join(dir, f)) as [string, string];
	if (!(await isFile(mjs)) || !(await isFile(wasm))) return null;
	const h = createHash("sha256");
	for (const f of [mjs, wasm]) {
		const bytes = new Uint8Array(await readFile(f));
		checkGlFile(path.basename(f), bytes, rel(f));
		h.update(bytes);
	}
	return { mjs, wasm, sha256: h.digest("hex") };
}

/** The page's GL renderer (see the top): KW_GL, else a local kernel's vendor/build/gl-wasm/, else the release's. */
async function withGl(s: PageSource): Promise<PageSource> {
	const kg = process.env.KW_GL;
	if (kg === "0") return { ...s, gl: null, glWhy: "KW_GL=0" };
	if (kg) {
		const gl = await glDir(path.resolve(kg));
		if (!gl) throw new Error(`KW_GL=${kg}: no ${GL_FILES.join(" and ")} there (gl/wasm/build.sh)`);
		return { ...s, gl, glWhy: `KW_GL=${kg}` };
	}
	if (s.kernel.tag !== "local") return s;
	const gl = await glDir(LOCAL_GL);
	return { ...s, gl, glWhy: gl ? `a local build in ${rel(LOCAL_GL)}` : `no ${rel(LOCAL_GL)}${GL_FILES[0]} (gl/wasm/build.sh)` };
}

/** VK_FILE in `dir`, checked and hashed, or null when it is missing. */
async function vkDir(dir: string): Promise<PageVk | null> {
	const wasm = path.join(dir, VK_FILE);
	if (!(await isFile(wasm))) return null;
	const bytes = new Uint8Array(await readFile(wasm));
	checkWasm(bytes, rel(wasm));
	return { wasm, sha256: sha256(bytes) };
}

/** The page's Vulkan translator (see the top): KW_VK, else a local kernel's vendor/build/vk/, else the release's. */
async function withVk(s: PageSource): Promise<PageSource> {
	const kv = process.env.KW_VK;
	if (kv === "0") return { ...s, vk: null, vkWhy: "KW_VK=0" };
	if (kv) {
		const vk = await vkDir(path.resolve(kv));
		if (!vk) throw new Error(`KW_VK=${kv}: no ${VK_FILE} there (vk/naga/build.sh)`);
		return { ...s, vk, vkWhy: `KW_VK=${kv}` };
	}
	if (s.kernel.tag !== "local") return s;
	const vk = await vkDir(LOCAL_VK);
	return { ...s, vk, vkWhy: vk ? `a local build in ${rel(LOCAL_VK)}` : `no ${rel(LOCAL_VK)}${VK_FILE} (vk/naga/build.sh)` };
}

async function choose(): Promise<PageSource> {
	const kk = process.env.KW_KERNEL, kd = process.env.KW_DISTROS;
	if (kd === "0") throw new Error("KW_DISTROS=0 is gone: the page always boots a distro image (?distro=none is the base shell)");
	if (kk || kd) {
		const base = kk ? path.resolve(kk) : LOCAL_BASE, dir = kd ? path.resolve(kd) : LOCAL_DISTROS;
		if (!(await isFile(base))) throw new Error(`no base bundle ${base}${kk ? " (KW_KERNEL)" : " (kernel/build.sh base, or KW_KERNEL)"}`);
		const images = await scanImages(dir);
		if (!images.length) throw new Error(`no distro images (<name>.erofs) in ${dir}${kd ? " (KW_DISTROS)" : " (kernel/build.sh distro, or KW_DISTROS)"}`);
		return localSource(base, images, `${[kk && "KW_KERNEL", kd && "KW_DISTROS"].filter(Boolean).join(" and ")} (a local build)`);
	}
	const tag = process.env.KW_KERNEL_RELEASE;
	if (tag) return releaseSource(`KW_KERNEL_RELEASE=${tag}`);
	const policy = localPolicy();
	let why = policy.why;
	if (policy.ok) {
		const images = (await isFile(LOCAL_BASE)) ? await scanImages(LOCAL_DISTROS) : [];
		if (images.length) return localSource(LOCAL_BASE, images, `a local build in vendor/build, ${policy.why}`);
		why = !(await isFile(LOCAL_BASE)) ? `no ${rel(LOCAL_BASE)} (kernel/build.sh base)` : `no images in ${rel(LOCAL_DISTROS)} (kernel/build.sh distro)`;
	}
	return releaseSource(why);
}

const describe = (s: PageSource) => `${s.kernel.tag === "local" ? "a local build" : `release ${s.kernel.tag}`}${s.remote ? " (mirror)" : ""}, Linux ${s.linux || "?"}; ` +
	s.distros.map((d) => `${d.name} ${mib(d.size)}`).join(", ") + `; GL renderer: ${s.gl || s.remote?.gl ? "yes" : "none"}; Vulkan translator: ${s.vk || s.remote?.vk ? "yes" : "none"}`;

let once: Promise<PageSource> | undefined;

/**
 * The base bundle and the images the page runs, with their URLs (`dev`: the
 * dev server's; once per process; see the top). It logs the choice.
 */
export function pageSource(dev: boolean): Promise<PageSource> {
	return (once ??= choose().then(withGl).then(withVk).then((s) => {
		if (!s.remote) for (const d of s.distros) d.url = `/distros/${dev ? path.basename(d.file) : servedName(d)}`;
		if (dev) log(`${describe(s)} (${s.why})`);
		else {
			const line = "=".repeat(72);
			log(line);
			log(`PAGE BUILD: ${describe(s)}`);
			log(`  why: ${s.why}`);
			if (s.remote) {
				log(`  kernel: ${s.remote.kernel}`);
				log(`  SMP kernel: ${s.remote.kernelSmp ?? "none"}`);
				for (const d of s.distros) log(`  ${d.url}${d.imageId ? ` (${d.imageId})` : ""}`);
			} else {
				log(`  base: ${rel(s.base)}`);
				for (const d of s.distros) log(`  ${d.url} <- ${rel(d.file)}${d.imageId ? ` (${d.imageId})` : ""}`);
			}
			log(`  GL renderer: ${s.gl ? `${rel(path.dirname(s.gl.mjs))}/ (${s.glWhy})` : s.remote?.gl ? `${s.remote.gl} (${s.glWhy})` : `none (${s.glWhy})`}`);
			log(`  Vulkan translator: ${s.vk ? `${rel(s.vk.wasm)} (${s.vkWhy})` : s.remote?.vk ? `${s.remote.vk} (${s.vkWhy})` : `none (${s.vkWhy})`}`);
			log(line);
		}
		return s;
	}));
}

/** A build's file name for an image: NAME-<16 hex digits of its sha256>.erofs (or .ext4). */
export const servedName = (d: PageImage) => `${d.name}-${d.sha256.slice(0, 16)}${path.extname(d.file)}`;

/** The dev server's images again (sizes, ids and hashes as the files are now: an image may have been rebuilt). */
export async function rescanImages(s: PageSource): Promise<PageImage[]> {
	const out: PageImage[] = [];
	for (const d of s.distros) {
		try {
			const st = await stat(d.file);
			const sum = await fileSha256(d.file);
			out.push({ ...d, size: st.size, sha256: sum, ...(sum === d.sha256 ? {} : { imageId: undefined }) });
		} catch {
			out.push(d);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// The base bundle's UP and SMP kernels.

const splits = new Map<string, Promise<{ up: Uint8Array; smp: Uint8Array | null }>>();

/**
 * The base bundle `src` without its SMP patch section (byte for byte `src`
 * when it has none) and the SMP bundle the patch makes (null without one);
 * once per process and file unless `again`.
 */
export function baseSplit(src: string, again = false): Promise<{ up: Uint8Array; smp: Uint8Array | null }> {
	if (again) splits.delete(src);
	let p = splits.get(src);
	if (!p) splits.set(src, p = (async () => {
		const bytes = new Uint8Array(await readFile(src));
		const up = withoutSmpPatch(bytes);
		if (up === bytes) return { up, smp: null };
		const smp = await smpKernelFromBundle(bytes);
		if (!smp) throw new Error(`${src}: an SMP patch section that makes no kernel`);
		log(`SMP patch of ${rel(src)}: UP ${mib(up.length)} and SMP ${mib(smp.length)} bundles`);
		return { up, smp };
	})());
	return p;
}

/**
 * The dev server: baseSplit() written to web/kernel/page/<16 hex digits of
 * the bundle's sha256>/ (unkernel.wasm, unkernel-smp.wasm), so dev servers
 * of different bundles never overwrite each other's files. The four
 * directories used last are kept.
 */
export async function splitBase(src: string, again = false): Promise<{ up: string; smp: string | null }> {
	const { up, smp } = await baseSplit(src, again);
	const dir = path.join(PAGE_DIR, sha256(new Uint8Array(await readFile(src))).slice(0, 16));
	await mkdir(dir, { recursive: true });
	const files = { up: path.join(dir, BASE_ASSET), smp: smp ? path.join(dir, "unkernel-smp.wasm") : null };
	await writeIfChanged(files.up, up);
	if (files.smp) await writeIfChanged(files.smp, smp!);
	const now = new Date();
	await utimes(dir, now, now);
	const dirs: { d: string; t: number }[] = [];
	for (const e of await readdir(PAGE_DIR, { withFileTypes: true })) {
		if (e.isDirectory() && /^[0-9a-f]{16}$/.test(e.name)) dirs.push({ d: path.join(PAGE_DIR, e.name), t: (await stat(path.join(PAGE_DIR, e.name))).mtimeMs });
	}
	for (const { d } of dirs.sort((a, b) => b.t - a.t).slice(4)) await rm(d, { recursive: true, force: true });
	return files;
}
