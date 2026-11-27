// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's files of a release, for a page that loads them from a mirror of
// the release's assets (CORS) instead of copying them into its own output.
//
//   node web/scripts/page-assets.ts <dir> [--tag <tag>]
//
// <dir> holds the release's assets (the release workflow's out/):
// unkernel.wasm and distros.json, optionally virgl.mjs and virgl.wasm (the
// GL renderer) and kwvk-naga.wasm (the Vulkan translator). It adds:
//   unkernel-up.wasm   the UP kernel the page boots: the base bundle without
//                      its SMP patch section (byte for byte the bundle when
//                      it has none)
//   unkernel-smp.wasm  the SMP kernel the patch makes (same initramfs,
//                      command line and data disk template); not written
//                      without an SMP patch
//   <file>.wasm.gz     every .wasm there gzipped (level 9, no name or time in
//                      the header, so the same bytes every run), for a page
//                      that loads them through DecompressionStream("gzip"):
//                      the mirror sends files as they are, and gzip is the
//                      one format every browser's DecompressionStream has
//   page.json          what a page build needs without downloading any of
//                      them: the tag, the kwemu ABI, the base id, the Linux
//                      release (the bundle's banner), the files (kernel,
//                      kernelSmp, gl, vk; null where there is none), each
//                      with its name, size and sha256 and those of its .gz
//                      (`gz`, where there is one), and distros.json's entries
// The images stay as they are: the page reads them with Range requests, and
// erofs compresses inside. virgl.mjs too: the page imports it as a module,
// which finds virgl.wasm next to itself.
// The split is scripts/kernel.ts baseSplit(), the one a page build does.
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { constants, gunzipSync, gzipSync } from "node:zlib";
import { GL_FILES, VK_FILE, banner, baseSplit, bundleInfo } from "./kernel.ts";

interface FileEntry { file: string; size: number; sha256: string; gz?: { file: string; size: number; sha256: string } }

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const exists = async (f: string) => { try { return (await stat(f)).isFile(); } catch { return false; } };
const die = (msg: string): never => { console.error(`page-assets: ${msg}`); process.exit(1); };

const args = process.argv.slice(2);
const t = args.indexOf("--tag");
const tag = t >= 0 ? args.splice(t, 2)[1] : undefined;
if (args.length !== 1 || (t >= 0 && !tag)) die("usage: page-assets.ts <dir> [--tag <tag>]");
const dir = path.resolve(args[0]!);

/** The .gz of each .wasm (gzipAll()), by the .wasm's name. */
const gzipped = new Map<string, { file: string; size: number; sha256: string }>();

async function entry(file: string, bytes?: Uint8Array): Promise<FileEntry> {
	const b = bytes ?? new Uint8Array(await readFile(path.join(dir, file)));
	const gz = gzipped.get(file);
	return { file, size: b.length, sha256: sha256(b), ...(gz ? { gz } : {}) };
}

/** <file>.gz of every .wasm in dir, checked by decompressing it again. */
async function gzipAll(): Promise<void> {
	for (const file of (await readdir(dir)).filter((f) => f.endsWith(".wasm")).sort()) {
		const raw = new Uint8Array(await readFile(path.join(dir, file)));
		const gz = new Uint8Array(gzipSync(raw, { level: constants.Z_BEST_COMPRESSION }));
		if (Buffer.compare(gunzipSync(gz), raw) !== 0) die(`${file}.gz does not decompress to ${file}`);
		await writeFile(path.join(dir, `${file}.gz`), gz);
		gzipped.set(file, { file: `${file}.gz`, size: gz.length, sha256: sha256(gz) });
	}
}

const bundlePath = path.join(dir, "unkernel.wasm");
const bundle = new Uint8Array(await readFile(bundlePath));
const index = JSON.parse(await readFile(path.join(dir, "distros.json"), "utf8")) as { abi: number | null; base: string | null; distros: unknown[] };
const info = await bundleInfo(bundle);
if (info.abi === null || info.abi !== index.abi) die(`unkernel.wasm has kwemu ABI ${info.abi ?? "unknown"}, distros.json says ${index.abi ?? "none"}`);
if (index.base && info.base !== index.base) die(`unkernel.wasm is base ${info.base ?? "unknown"}, distros.json was made for ${index.base}`);
const linux = banner(bundle);
if (!linux) die("unkernel.wasm has no Linux banner");

const { up, smp } = await baseSplit(bundlePath);
await writeFile(path.join(dir, "unkernel-up.wasm"), up);
if (smp) await writeFile(path.join(dir, "unkernel-smp.wasm"), smp);
await gzipAll();
const kernel = await entry("unkernel-up.wasm", up);
const kernelSmp = smp ? await entry("unkernel-smp.wasm", smp) : null;

const haveGl = await Promise.all(GL_FILES.map((f) => exists(path.join(dir, f))));
if (haveGl.some(Boolean) && !haveGl.every(Boolean)) die(`only some of ${GL_FILES.join(", ")} (virgl.mjs loads virgl.wasm next to itself)`);
const gl = haveGl.every(Boolean) ? await Promise.all(GL_FILES.map((f) => entry(f))) : null;
const vk = (await exists(path.join(dir, VK_FILE))) ? await entry(VK_FILE) : null;

const page = { tag: tag ?? null, abi: info.abi, base: info.base, linux, kernel, kernelSmp, gl, vk, distros: index.distros };
await writeFile(path.join(dir, "page.json"), `${JSON.stringify(page, null, "\t")}\n`);
console.log(`page-assets: ${tag ?? "(no tag)"}, Linux ${linux}, ABI ${info.abi}, base ${info.base ?? "?"}: ` +
	`${kernel.file} ${kernel.size} bytes, ${kernelSmp ? `${kernelSmp.file} ${kernelSmp.size} bytes` : "no SMP kernel"}, ` +
	`GL renderer: ${gl ? "yes" : "none"}, Vulkan translator: ${vk ? "yes" : "none"}; ` +
	`gzipped: ${[...gzipped].map(([f, g]) => `${f} ${g.size} bytes`).join(", ")}`);
