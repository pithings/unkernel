// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// unkernel for Node (>= 24): the universal SDK plus file disks, direct
// networking over host sockets, host directories as guest mounts
// (nodeFs), the bundled kernel read from disk, and fetchDistro() for the
// distro images.
//
//   import { createKernel, fetchDistro } from "unkernel";
//   const vm = await createKernel({ distro: await fetchDistro("alpine") }); // Alpine, no network for the guest
//   vm.onOutput((b) => process.stdout.write(b));
//   vm.write("uname -a; poweroff\n");
//   const { code } = await vm.exited;
//
//   const vm = await createKernel();            // no distro: the base shell (busybox)
//   const vm = await createKernel({ worker: true, distro }); // in a worker thread
//
// Nothing else imports this module (the CLI uses node/platform.ts), so the
// URLs below stay relative to dist/node.mjs.

import { createKernelOn, type CreateKernelOptions, type KernelHandle, type KernelInstance, type WorkerOption } from "./core/instance.ts";
import type { WorkerKernel } from "./core/worker-host.ts";
import { distroFetcher, type FetchDistroOptions } from "./node/distro-fetch.ts";
import { nodePlatform } from "./node/platform.ts";

export * from "./core/index.ts";
export { FileBase, FileDisk, createImageFromKwsparse, openDisk, openDistroDisk } from "./node/disk.ts";
export { DistroFetchError, RELEASE_REPO, defaultCacheDir } from "./node/distro-fetch.ts";
export type { FetchDistroOptions, FetchDistroProgress } from "./node/distro-fetch.ts";
export type { OpenDiskOptions } from "./node/disk.ts";
export { nodeFs } from "./node/nodefs.ts";
export { serveWasiPrograms } from "./node/wasi.ts";
export { directBackend } from "./node/net.ts";

/**
 * The bundled kernel: vmlinux32.wasm with the base initramfs, its command
 * line, the data disk template and the patch to the SMP kernel in custom
 * sections. In a source checkout this resolves (through a symlink) to
 * vendor/build/bundle/unkernel.wasm.
 */
export const bundledKernelUrl: URL = new URL("./unkernel.wasm", import.meta.url);

const platform = nodePlatform(bundledKernelUrl);

/**
 * The distro `name` ("alpine", "debian": the names in the release's
 * distros.json) as a local image file for createKernel({ distro }). In a
 * source checkout: its build, vendor/build/distro/<name>.erofs (never a
 * download). In an installed package: downloaded once from the GitHub
 * release of this package's version (UNKERNEL_RELEASE_URL overrides it)
 * into a cache directory (defaultCacheDir(); UNKERNEL_CACHE_DIR), checked
 * against the release's size and SHA-256, and reused while it matches.
 * Rejects with a DistroFetchError (`offline` when the network failed and
 * nothing usable was cached). The SDK never downloads anything else.
 */
export const fetchDistro: (name: string, opts?: FetchDistroOptions) => Promise<string> = distroFetcher(new URL("..", import.meta.url));

/**
 * Load, compile and boot a kernel (default: the bundled one, which boots
 * `distro`, or without one the base shell) and return the running
 * instance. Rejects with a BootError if it cannot start. With
 * `worker: true` the kernel is loaded, compiled and run in a worker thread
 * and the result is a WorkerKernel (no low-level `kernel`; see
 * WorkerOption for what it does not support yet).
 */
export function createKernel(opts: CreateKernelOptions & { worker: true }): Promise<WorkerKernel>;
export function createKernel(opts?: CreateKernelOptions & { worker?: false }): Promise<KernelInstance>;
export function createKernel(opts?: CreateKernelOptions & WorkerOption): Promise<KernelHandle>;
export function createKernel(opts: CreateKernelOptions & WorkerOption = {}): Promise<KernelHandle> {
	return createKernelOn(platform, opts);
}
