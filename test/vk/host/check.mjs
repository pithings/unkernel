#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Headless check of the kwvk host renderer (js/core/vk-host.ts) without a
// guest: serves the repository (TypeScript stripped on the fly with
// node:module's stripTypeScriptTypes), opens test/vk/host/client.js in
// headless Chrome with WebGPU (SwiftShader), which plays a fake client:
// hello, buffer round trip, a triangle (render pass, pipeline, dynamic
// uniform offset, push constants) read back with copyImageToBuffer and
// present, a scaled blit, and a compute dispatch; failures that must reach
// the guest (pipelines refused or unusable, lost devices). With glslangValidator
// (else vk/glslc.sh's glslc) and vendor/build/vk/kwvk-naga.wasm it runs again on
// real SPIR-V through js/core/vk-shader.ts. Exit 0 when every check passes.
//
//   node test/vk/host/check.mjs [--chrome PATH] [--keep]
//
// Chrome: $KWVK_CHROME, else Playwright's Chromium (~/.cache/ms-playwright);
// the system's chromium-headless has no WebGPU adapter.

import { createServer } from "node:http";
import { readFile, mkdtemp, readdir } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir, homedir } from "node:os";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w).includes("stripTypeScriptTypes") ? undefined : emitWarning.call(process, w, ...rest));

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const args = process.argv.slice(2);
const argVal = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

async function findChrome() {
	const c = argVal("--chrome") || process.env.KWVK_CHROME;
	if (c) return c;
	const base = join(homedir(), ".cache/ms-playwright");
	const dirs = existsSync(base) ? (await readdir(base)).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
	for (const d of dirs) {
		const p = join(base, d, "chrome-linux64/chrome");
		if (existsSync(p)) return p;
	}
	throw new Error("no Chrome with WebGPU found (set KWVK_CHROME)");
}

// SPIR-V for the real-translator suite
const naga = join(root, "vendor/build/vk/kwvk-naga.wasm");
const spirv = {};
const SHADERS = ["tri.vert", "tri.frag", "double.comp", "quad.vert", "quad.frag", "fs.vert", "ia.frag", "arr.frag", "store.comp", "flat.vert", "flat.frag", "wide.comp", "dead.comp", "barrier.comp", "shared512.comp", "shared512fn.comp", "earlyro.comp", "sgids.comp", "tbfetch.comp", "tbstore.comp"];
const work = await mkdtemp(join(tmpdir(), "kwvk-host-"));
// glslangValidator, else vk/glslc.sh's glslc (vendor/toolchain/glslc)
const glslc = join(root, "vendor/toolchain/glslc/bin/glslc");
const useGlslc = spawnSync("glslangValidator", ["--version"]).error && existsSync(glslc);
if (existsSync(naga) && existsSync(join(root, "js/core/vk-shader.ts"))) {
	for (const name of SHADERS) {
		const out = join(work, `${name}.spv`);
		// subgroup builtins need Vulkan 1.1 SPIR-V
		const env = name.startsWith("sg") ? "vulkan1.1" : "vulkan1.0";
		const src = join(here, "shaders", name);
		const r = useGlslc
			? spawnSync(glslc, [`--target-env=${env}`, "-o", out, src], { encoding: "utf8" })
			: spawnSync("glslangValidator", ["-V", "--target-env", env, "-o", out, src], { encoding: "utf8" });
		if (r.status !== 0) {
			console.log(`${useGlslc ? "glslc" : "glslangValidator"} ${name}: ${r.error?.message || r.stdout || r.stderr}`);
			break;
		}
		spirv[name] = `/spv/${name}.spv`;
	}
}
const haveSpirv = Object.keys(spirv).length === SHADERS.length;

const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".ts": "text/javascript", ".html": "text/html", ".wasm": "application/wasm", ".spv": "application/octet-stream" };
let finish;
const done = new Promise((r) => (finish = r));

const server = createServer(async (req, res) => {
	const url = new URL(req.url, "http://x");
	const body = async () => {
		let s = "";
		for await (const c of req) s += c;
		return s;
	};
	try {
		if (req.method === "POST" && url.pathname === "/log") {
			console.log(`  ${await body()}`);
			res.end();
			return;
		}
		if (req.method === "POST" && url.pathname === "/done") {
			finish(JSON.parse(await body()));
			res.end();
			return;
		}
		if (url.pathname === "/" || url.pathname === "/index.html") {
			res.setHeader("content-type", "text/html");
			res.end(`<!doctype html><meta charset="utf-8"><title>kwvk host check</title><script type="module" src="${argVal("--client") || "/test/vk/host/client.js"}"></script>`);
			return;
		}
		if (url.pathname === "/config") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ spirv: haveSpirv ? spirv : null }));
			return;
		}
		let file;
		if (url.pathname === "/naga.wasm") file = naga;
		else if (url.pathname.startsWith("/spv/")) file = join(work, url.pathname.slice(5));
		else file = join(root, decodeURIComponent(url.pathname));
		if (!file.startsWith(root) && !file.startsWith(work)) throw new Error("outside");
		let data = await readFile(file);
		if (extname(file) === ".ts") data = stripTypeScriptTypes(data.toString(), { mode: "strip" });
		res.setHeader("content-type", types[extname(file)] || "application/octet-stream");
		res.end(data);
	} catch (e) {
		res.statusCode = 404;
		res.end(String(e));
	}
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const chromePath = await findChrome();
const profile = await mkdtemp(join(tmpdir(), "kwvk-chrome-"));
const chrome = spawn(chromePath, [
	"--headless", "--no-sandbox", "--disable-gpu-sandbox", "--enable-unsafe-webgpu",
	"--enable-features=Vulkan,WebGPU", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader",
	"--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage", ...(process.env.KWVK_CHROME_FLAGS || "").split(" ").filter(Boolean), `--user-data-dir=${profile}`, "--remote-debugging-port=0",
	`http://127.0.0.1:${port}/`,
], { stdio: ["ignore", "ignore", args.includes("--keep") ? "inherit" : "ignore"] });

const timeout = setTimeout(() => finish({ results: [{ name: "timeout (180 s)", ok: false }] }), 180_000);
const out = await done;
clearTimeout(timeout);
chrome.kill("SIGKILL");
server.close();
await new Promise((r) => setTimeout(r, 200));
for (const d of [profile, work]) rmSync(d, { recursive: true, force: true });

const failed = out.results.filter((r) => !r.ok);
console.log(`${out.results.length - failed.length}/${out.results.length} checks passed${haveSpirv ? "" : " (spirv suite skipped)"}`);
for (const f of failed) console.log(`FAIL ${f.name} ${f.detail || ""}`);
process.exit(failed.length || !out.results.length ? 1 : 0);
