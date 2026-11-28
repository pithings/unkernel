#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The prepared data disk of the guest Vulkan tests (unkernel-check.mjs): a
// data disk (.agents/data-disk.md) whose Debian upper layer has the Vulkan
// loader and vulkan-tools installed, so that test runs download nothing.
// Made once, as test/gl/debian-disk.mjs makes the GL one: boots the Debian
// image on Node with the guest network (the SDK's direct backend),
// apt-installs the packages below as root, powers off cleanly and renames
// the image into place. Skipped when the image exists (delete it to make it
// again, e.g. after a new Debian image: the upper layer belongs to the
// image it was made on).
//
//   node test/vk/debian-disk.mjs [--apps | --games] [--out FILE] [--kernel unkernel.wasm] [--distro debian.erofs]
//
// --apps: a second stage on top of the first image (made first when it is
// missing; copied, so it stays as it is): the real Vulkan programs of
// unkernel-check.mjs --apps (APP_PACKAGES), in
// $KW_BUILD/vk/debian-vk-apps.img. --games: a third on top of a copy of
// that one: mpv (libplacebo's gpu-next on Vulkan), Mesa's GL tools and the
// Vulkan games of GAME_PACKAGES that the archive has for the guest's
// architecture (the others are named and skipped), in
// $KW_BUILD/vk/debian-vk-games.img.
//
// Default out: $KW_BUILD/vk/debian-vk.img (vendor/build). The packages: the
// loader (libvulkan1, without its recommended mesa-vulkan-drivers: our ICD
// is the only one), vulkaninfo and vkcube (vulkan-tools; vkcube's Wayland
// path needs libwayland-client0), wayland-info, and weston (its headless
// backend with the pixman renderer is vkcube's compositor in step c).
import { spawnSync } from "node:child_process";
import { copyFileSync, constants, existsSync, mkdirSync, renameSync, rmSync, statSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createImageFromKwsparse, createKernel } from "../../js/node.ts";

export const VK_PACKAGES = ["libvulkan1", "vulkan-tools", "libwayland-client0", "wayland-utils", "weston"];
// vkmark, GTK 4's demos (GSK_RENDERER=vulkan), SDL 2 and SDL 3's test
// programs (testvulkan), vkd3d's Direct3D 12 demos (on Vulkan, X11 only),
// Xvfb for the X11 (xcb, xlib) surfaces.
export const APP_PACKAGES = ["vkmark", "gtk-4-examples", "libsdl2-tests", "libsdl3-tests", "vkd3d-demos", "fonts-dejavu-core", "xvfb", "xauth", "x11-utils", "x11-apps"];
// mpv (vo=gpu-next: libplacebo, which wants timelineSemaphore), glxinfo and
// eglinfo (which driver Mesa picks with kwvk there), and games with Vulkan
// renderers (issue #32: Taisei on SDL3's GPU API, the DDNet client;
// vkQuake, from contrib, needs game data it does not carry).
export const GAME_PACKAGES = ["mpv", "mesa-utils", "taisei", "ddnet", "vkquake"];

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const build = process.env.KW_BUILD ? resolve(process.env.KW_BUILD) : join(root, "vendor/build");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const games = args.includes("--games");
const apps = args.includes("--apps") || games;
const first = join(build, "vk/debian-vk.img");
const second = join(build, "vk/debian-vk-apps.img");
const out = resolve(opt("--out", games ? join(build, "vk/debian-vk-games.img") : apps ? second : first));
const kernel = opt("--kernel");
const distro = resolve(opt("--distro", join(build, "distro/debian.erofs")));

if (existsSync(out)) {
	console.log(`${out} exists (${(statSync(out).blocks * 512 / 1048576).toFixed(0)} MiB used); delete it to make it again`);
	process.exit(0);
}
if (!existsSync(distro)) {
	console.error(`no ${distro} (kernel/build.sh distro debian)`);
	process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });
const tmp = `${out}.tmp`;
rmSync(tmp, { force: true });
const t0 = performance.now();
const secs = () => ((performance.now() - t0) / 1000).toFixed(0);
if (apps) {
	const base = games ? second : first;
	if (!existsSync(base) && spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...(games ? ["--apps"] : []), ...(kernel ? ["--kernel", kernel] : []), "--distro", distro], { stdio: "inherit" }).status !== 0) process.exit(1);
	// sparse copy: the 4 GiB image has about 600 MiB in it
	if (spawnSync("cp", ["--sparse=always", base, tmp]).status !== 0) copyFileSync(base, tmp, constants.COPYFILE_FICLONE);
} else await createImageFromKwsparse(tmp, readFileSync(join(build, "disk/kwdata.kwsparse.gz")));

const vm = await createKernel({
	...(kernel ? { kernel: resolve(kernel) } : {}),
	distro,
	disks: [{ kind: "file", path: tmp }],
	net: { kind: "net", backend: { kind: "direct" } },
	memoryMiB: 1024,
});
vm.onOutput((b) => process.stderr.write(b));
const script = games
	? `set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
# the games the archive has (vkQuake is in contrib)
pk=
for p in ${GAME_PACKAGES.join(" ")}; do
	if [ -n "$(apt-cache policy "$p" 2>/dev/null | sed -n 's/^ *Candidate: //p' | grep -v '(none)')" ]; then pk="$pk $p"; else echo "[vk-disk] not in the archive for $(dpkg --print-architecture): $p"; fi
done
echo "[vk-disk] installing:$pk"
apt-get install -y -q --no-install-recommends $pk </dev/null
apt-get clean
for c in mpv glxinfo; do command -v $c >/dev/null || { echo "missing: $c"; exit 1; }; done`
	: `set -e
export DEBIAN_FRONTEND=noninteractive
inst() { apt-get install -y -q --no-install-recommends ${(apps ? APP_PACKAGES : VK_PACKAGES).join(" ")} </dev/null; }
inst || { apt-get update -q && inst; }
apt-get clean
for c in ${apps ? "vkmark gtk4-demo Xvfb xvfb-run" : "vulkaninfo vkcube wayland-info weston"}; do command -v $c >/dev/null || { echo "missing: $c"; exit 1; }; done
ls /usr/lib/aarch64-linux-gnu/libvulkan.so.1
sync`;
let code = 1;
try {
	const r = await vm.exec("bash", ["-c", script], { user: "root", timeout: 3 * 3600_000 });
	process.stdout.write(r.stdout);
	process.stderr.write(r.stderr);
	code = r.exitCode ?? 1;
	console.log(`[vk-disk] apt-get finished with ${code} after ${secs()} s`);
} catch (e) {
	console.error(`[vk-disk] ${e?.message ?? e}`);
}
// A clean shutdown: the base stops the overlay and syncs the data disk.
vm.write("sudo poweroff\n");
const res = await Promise.race([vm.exited, new Promise((r) => setTimeout(() => r(null), 120_000))]);
if (!res) {
	console.error("[vk-disk] no power-off within 120 s");
	await vm.stop();
	code = 1;
}
if (code !== 0) {
	rmSync(tmp, { force: true });
	console.error(`[vk-disk] failed after ${secs()} s`);
	process.exit(1);
}
renameSync(tmp, out);
console.log(`[vk-disk] ${out}: ${(statSync(out).blocks * 512 / 1048576).toFixed(0)} MiB used (sparse, ${statSync(out).size / 1048576} MiB), made in ${secs()} s`);
process.exit(0);
