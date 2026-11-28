// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// createKernel(): load, compile and boot a kernel, and attach to its console.
//
// The entries (node.ts, web.ts) bind it to their platform: where the bundled
// kernel is, how to read local files and how to start a worker. With
// `worker: true` the kernel runs in a worker (worker-host.ts) instead.

import type { BlockDevice, BlockStats } from "./block.ts";
import type { CpuEndpoint, CpuInit } from "./cpu.ts";
import type { DisplayFrame, DisplayHost, DisplayMode, DisplayOption, DisplaySize, DisplayStats } from "./display.ts";
import type { Evdev, InputHost, InputState, InputStats } from "./input.ts";
import type { JitStats, KwemuStats } from "./jit.ts";
import type { ProfileOptions, ProfileReport, SamplerHandle, SamplerInit } from "./profile.ts";
import type { SoundHost, SoundOption, SoundState, SoundStats } from "./sound.ts";
import { VsockHost, type Vsock, type VsockStats } from "./vsock.ts";
import { inlineShm, type Shm, type ShmClient, type ShmStats } from "./shm.ts";
import type { GpuBackend, VirtioGpuStats } from "./virtio-gpu.ts";
import { attachOn, connectOn, execOn, spawnOn, ttySessions, type AttachOptions, type ConnectOptions, type ExecOptions, type ExecResult, type GuestSocket, type PipeOptions, type Pty, type PtyOptions, type Subprocess, type TtySessionSnapshot } from "./tty.ts";
import { fetchOver } from "./http.ts";
import { CommandTable, parseCommands, type CommandsOption, type HostCommand } from "./commands.ts";
import { MountTable, parseMounts, snapshotMountMismatch, type FsSource, type Mount, type MountOptions, type MountsOption } from "./mounts.ts";
import { prepareGl, startGl, type GlHost, type GlOption } from "./gl.ts";
import { prepareVk, startVk, type VkHost, type VkOption, type VkPlatform } from "./vk.ts";
import { prepareVa, startVa, type VaHost, type VaOption } from "./va.ts";
import { inlineGpuLink, VirglGpuBackend } from "./gl-gpu.ts";
import { Kernel, bundledBoot, moduleIsMemory64, type ExitResult, type KernelStats, type MemoryStage, type NetDevice } from "./kernel.ts";
import { BootError, loadBytes, loadKernelModule, type BytesSource, type DownloadProgress, type KernelSource } from "./load.ts";
import { NetStack, type NetBackend, type NetStats } from "./net.ts";
import { buildDisks, buildNet, isNetSpec, type DeviceRegistry, type DiskSpec, type NetSpec, type SkippedDisk } from "./devices.ts";
import { openDistro, type DistroInfo, type DistroSource } from "./distro.ts";
import { ConsoleOutput } from "./output.ts";
import { snapshotCpuMismatch, type KernelSnapshot, type SnapshotOptions } from "./snapshot.ts";
import { checkWorkerOptions, createKernelInWorker, type WorkerKernel } from "./worker-host.ts";
import type { WorkerEndpoint } from "./worker-protocol.ts";
import type { KernelTransport } from "./worker-shared.ts";

/**
 * Boot progress, in order: downloads (with compile overlapping them when
 * streaming), memory, instantiate, start. Worker mode adds "worker" (the
 * worker runs, and whether it has JSPI) before "memory": it may come
 * before, during or after the download and compile, which run on the
 * owner's thread while the worker starts (unless compileInWorker).
 */
export type BootProgress =
	| { stage: "worker"; jspi: boolean }
	| DownloadProgress
	| { stage: "compile" }
	| { stage: "compiled"; ms: number; memory64: boolean }
	| ({ stage: "memory" } & MemoryStage)
	| { stage: "instantiate" }
	| { stage: "start"; cmdline: string };

export interface CreateKernelOptions {
	/**
	 * Resume a snapshot (KernelInstance.snapshot()) instead of booting: the
	 * same kernel build; initrd, cmdline and memoryMiB are ignored. In
	 * worker mode the memory is copied to the worker (see
	 * WorkerOption.transferRestore). `disks` must be the snapshot's disks,
	 * unchanged since it was taken (same identity and write generation); otherwise createKernel
	 * rejects, naming the disk, and the caller can boot normally instead.
	 * The devices must be the snapshot's too: display, sound, vsock, shm
	 * and network each given, or not, as when it was taken (a network with
	 * the same MAC), or createKernel rejects. vsock sessions (spawn(),
	 * exec(), connect(), fetch(), listeners' connections) and the guest's
	 * TCP connections do not survive: the guest's ends are reset, except
	 * detachable terminal sessions (spawn() with `detachable`), which the
	 * guest keeps detached for attach() (the snapshot's `ttys`). Host file
	 * systems do (in worker mode from a snapshot({ commit })): `mounts` must give one for each mount path
	 * in the snapshot, read-only as it was, and the guest's open files on
	 * it are opened again by path (a file gone meanwhile answers ESTALE);
	 * nothing of their files is in the snapshot. Other `mounts` are
	 * mounted as at boot. `cpus` defaults to the snapshot's CPU count, and
	 * another count rejects (every task resumes on the CPU it ran on).
	 */
	restore?: KernelSnapshot;
	/**
	 * The kernel: a URL (a path or file: URL on Node), bytes, a Response or
	 * a compiled WebAssembly.Module. Default: the bundled kernel
	 * (unkernel.wasm next to the entry: the kernel and the base initramfs,
	 * which boots `distro`, or without one the base shell).
	 */
	kernel?: KernelSource;
	/**
	 * The initramfs (a cpio, optionally gzipped). Default (undefined): the
	 * one bundled into the kernel, if any; null boots without one.
	 */
	initrd?: BytesSource | null;
	/**
	 * Kernel command line. Default: the kernel's bundled one if its bundled
	 * initramfs is used; else "console=hvc0 root=/dev/wda rw" with disks and
	 * no initramfs; else "console=hvc0 rdinit=/init".
	 */
	cmdline?: string;
	/** Kernel memory (fixed for the run). Default 2048 on Node; on the web, autoMemoryMiB(). */
	memoryMiB?: number;
	/** Smaller sizes to try in order if memoryMiB cannot be allocated. Default none on Node; DEFAULT_MEMORY_FALLBACK_MIB on the web. */
	memoryFallbackMiB?: number[];
	/** Memory type; default: detected from the module. */
	memory64?: boolean;
	/**
	 * kwblk disks: /dev/wda, wdb, ... (CowDisk, HttpBase-backed disks,
	 * FileDisk on Node, or your own BlockDevice), or specs (devices.ts:
	 * plain data such as { kind: "file", path } on Node or { kind: "data",
	 * template: "bundled" } in browsers), which the instance builds, owns
	 * and closes at exit. Worker mode takes specs only.
	 */
	disks?: Array<BlockDevice | DiskSpec>;
	/**
	 * A distro image for the base initramfs of the bundled kernel
	 * (unkernel.wasm, which mounts the disk labelled kwroot read-only under
	 * the root overlay and runs its /sbin/init; without one it starts a
	 * base shell: busybox, the kw tools, kwtty): an erofs or ext4 image, attached read-only as the first
	 * disk (/dev/wda), before `disks` (whose indices, as in DiskState,
	 * onDiskError and WorkerKernel.detachDisk(), stay those of `disks`). A
	 * path or file: URL (Node), an http(s) URL served with Range support,
	 * read lazily and never cached across sessions (browsers: relative to
	 * the page), a disk spec (made read-only: { kind: "file", path } on
	 * Node, { kind: "http", url }), or a BlockDevice (inline only; wrapped
	 * read-only). The guest never writes it. In a snapshot it is the first
	 * disk, identified by its content (DistroDisk). Needs an initramfs: the
	 * bundled one by default, or `initrd`, unless `cmdline` is given. On
	 * Node, fetchDistro("alpine") gives the path of a named one (from the
	 * release of the package's version, downloaded once); in browsers, pass
	 * the URL of an image you host.
	 */
	distro?: DistroSource;
	/**
	 * Network: a NetBackend (wrapped in a NetStack), a NetStack, any
	 * NetDevice, or a spec ({ kind: "net", backend: { kind: "direct" } } on
	 * Node, or { kind: "wisp", servers }). Default: none (the guest has no
	 * eth0). The instance closes it (and its backend) when the kernel exits.
	 * Worker mode takes a spec only.
	 */
	net?: NetDevice | NetBackend | NetSpec;
	/** A disk built from a spec failed to save a flush (e.g. QuotaExceededError; the guest gets EIO for it). */
	onDiskError?: (index: number, error: unknown) => void;
	/**
	 * kwemu's JIT tier: hot guest code is compiled to WebAssembly modules at
	 * run time (synchronously, a few KiB each). Default true; false runs the
	 * interpreter only.
	 */
	jit?: boolean;
	/**
	 * CPUs to give an SMP kernel (a kernel built with CONFIG_SMP; kernel.md,
	 * SMP): each runs in its own thread on a shared memory, so it needs a
	 * platform that starts CPU threads (Platform.spawnCpu: Node, and browsers
	 * where the kernel runs in a worker of a cross-origin isolated page, as
	 * `worker: true` does). Default 1, or with `restore` the snapshot's. A UP
	 * kernel ignores it, and so does a thread that cannot start CPUs (both
	 * with a log line; a restore then rejects); stats().cpus says how many
	 * it got.
	 */
	cpus?: number;
	/**
	 * A display: the guest gets /dev/fb0 (kwfb, XRGB8888), and frame() /
	 * display read what it draws. true = 640x480; or a size; or a function
	 * returning the size wanted each time a program first opens the device
	 * (e.g. the window's size; the kernel caps it at 1M pixels by dividing
	 * by an integer; in worker mode it is asked ahead of time instead, see
	 * WorkerOption). A program may set its own size; onDisplay reports
	 * every change. Default false (no device).
	 */
	display?: DisplayOption;
	/** A guest program opened the display or changed its mode (the mode), or the last one closed it (null). */
	onDisplay?: (mode: DisplayMode | null) => void;
	/**
	 * With a display the guest also gets a keyboard and a mouse (evdev,
	 * /dev/input/event0 and event1). Called when a program opens or the
	 * last one closes them; send keys and motion through `evdev` only
	 * while they are open, and to the console otherwise.
	 */
	onInput?: (state: InputState) => void;
	/**
	 * A sound card (kwsnd: ALSA hw:0,0 and OSS /dev/dsp, playback only):
	 * true (output dropped) or a sink that receives the PCM chunks with
	 * their format and the playback state (sound.ts). Default false (no card).
	 */
	sound?: SoundOption;
	/**
	 * A vsock device (kwvsock: AF_VSOCK, guest CID 3, host CID 2): `vsock`
	 * on the instance listens for guest connections and connects to guest
	 * listeners, each a byte stream (vsock.ts), and spawn() and exec() run
	 * programs through it (tty.ts). true, or options. Default true; false:
	 * the guest has no vsock transport.
	 */
	vsock?: boolean | VsockOption;
	/**
	 * kwshm: `shm` on the instance opens guest shmem files (by name in
	 * /dev/shm, or by the id a guest program got from /dev/kwshm) and reads
	 * and writes their pages in place (shm.ts). Default false: no device.
	 */
	shm?: boolean;
	/**
	 * A virtio-gpu device (kwvirtio, virtio-gpu.ts): the guest gets
	 * /dev/dri/card0 and renderD128 (driver virtio_gpu), and while a client
	 * has a framebuffer on its scanout, frame() and `display` show that
	 * instead of /dev/fb0's pixels. With `gl` too, where WebGL2 is (a
	 * browser), the device has 3D: the guest's Mesa renders through its
	 * virtio_gpu (virgl) driver on gl's renderer, and a GL client's scanout
	 * is presented from its texture (`gl.gpu.drawFrame()`; gl-gpu.ts).
	 * Otherwise it is 2D: KMS with dumb buffers. Implies `display` (whose
	 * size the scanout offers) when that is not given. Default false: no
	 * virtio device.
	 */
	gpu?: boolean;
	/** @internal The virtio-gpu device's 3D side in the kernel's worker (worker-serve.ts); createKernel makes its own from `gl`. */
	gpuBackend?: GpuBackend;
	/**
	 * Host file systems to mount in the guest (mounts.ts): guest paths to a
	 * file system (an Fs such as MemoryFs or nodeFs(), or a plain object
	 * tree of files: strings, bytes, functions, subdirectory objects), or to
	 * { fs, readOnly, timeout, requestTimeout }. Each is served over 9p on
	 * vsock and mounted by the guest's kw9p, through kwtty, once it answers.
	 * spawn() and exec() wait for them; if one failed, the calls that waited
	 * reject with its MountError (it is logged too). Needs vsock (the default).
	 */
	mounts?: MountsOption;
	/**
	 * Host commands (commands.ts): names to functions of the host that the
	 * guest runs as programs. Each gets a link /run/kw/bin/NAME to the
	 * guest's kwbox, which runs kwcmd (first on PATH; not "kwcmd" or "kwbox"),
	 * made through kwtty once it answers; a
	 * guest process that runs NAME is a normal process, and the function is
	 * called with its arguments, environment, stdin, stdout and stderr, and
	 * what it returns ends that process. spawn() and exec() wait for the
	 * links; if making them failed, the calls that waited reject with the
	 * CommandError (it is logged too). Needs vsock (the default). With
	 * `restore`, the snapshot's links are replaced by these.
	 */
	commands?: CommandsOption;
	/**
	 * Guest GL (gl.ts, .agents/gl.md): the guest's Mesa renders through
	 * virglrenderer compiled to wasm on one WebGL2 context of this thread
	 * (an OffscreenCanvas; frames come back to the guest by readback). The
	 * module (virgl.mjs and virgl.wasm next to the web entry) is fetched only
	 * with `gl`, and only on the guest's first GL use (`gl.eager`: before the
	 * boot); the host listens on vsock port 1019 and starts the guest's
	 * forwarder (`kwbox vtest`) through kwtty, after which GL
	 * programs run with GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1
	 * (Debian: Mesa from apt). true, or options. Needs vsock and WebGL2:
	 * where there is none (Node) it is ignored with a log line, unless
	 * `renderer` gives one. With `gpu` the same renderer gives the virtio-gpu
	 * device 3D (see gpu). Default false.
	 */
	gl?: GlOption;
	/**
	 * Guest Vulkan (vk.ts, vk/PROTOCOL.md): the guest's ICD
	 * (/usr/lib/kw/libvulkan_kw.so, found by the Vulkan loader through
	 * /usr/share/vulkan/icd.d/kw_icd.json) sends Vulkan over vsock port 1021
	 * to a renderer on this thread's WebGPU device; SPIR-V is translated to
	 * WGSL by kwvk-naga.wasm (next to the web entry). The device, the
	 * renderer and the translator load only on the guest's first Vulkan
	 * instance. true, or options. Needs vsock and WebGPU: where there is no
	 * navigator.gpu (Node) it is ignored with a log line, unless `vk.device`
	 * gives a device. Default false.
	 */
	vk?: VkOption;
	/**
	 * Guest VA-API (va.ts, va/PROTOCOL.md): the guest's libva driver
	 * (kw_drv_video.so, which libva loads for the virtio-gpu device as
	 * virtio_gpu_drv_video.so) sends each picture over vsock port 1024 to a
	 * WebCodecs VideoDecoder on this thread and reads it back as NV12
	 * (VP9 profile 0, H.264, AV1 Main and HEVC Main where WebCodecs decodes
	 * them; decode only). Nothing is asked of WebCodecs before the
	 * guest's first connection. true, or options. Needs vsock and
	 * VideoDecoder: where there is none (Node) it is ignored with a log
	 * line. Default false.
	 */
	va?: VaOption;
	/** Initial console size (cols x rows); resize() changes it later. */
	consoleSize?: { cols: number; rows: number };
	/** Console output, from the first byte. */
	onOutput?: (bytes: Uint8Array) => void;
	/** Host diagnostics ("[host] ...", "[net] ..."). Default console.error. */
	log?: (msg: string) => void;
	/** Download, compile and boot progress. */
	onProgress?: (p: BootProgress) => void;
	/** Aborts the downloads; once booted, stops the kernel (stop()). */
	signal?: AbortSignal;
	/**
	 * Sample where guest user time goes (profile.ts; read it with
	 * profile()): true, or the rates. Time samples need the kernel's memory
	 * shared (the SMP kernel, `cpus` > 1) and a platform that starts a
	 * sampler thread (Node); otherwise only instruction samples are taken
	 * (with a log line). Default: off.
	 */
	profile?: boolean | ProfileOptions;
	/**
	 * @internal Worker mode with the shared transport: the console ring the
	 * owner reads (KernelConfig.consoleRing; console-ring.ts).
	 */
	consoleRing?: SharedArrayBuffer;
	/** @internal KernelConfig.flushOutput (the worker's batched "output" messages). */
	flushOutput?: () => void;
}

export interface VsockOption {
	/** The host's receive buffer per connection: the credit the guest gets. Default 256 KiB. */
	bufferSize?: number;
	/**
	 * Low level, inline only: the guest's packets (virtio-vsock header and
	 * payload) go to `onPacket` instead of the SDK's protocol, and `vsock`
	 * on the instance is undefined; send with kernel.vsock.deliver().
	 */
	raw?: {
		onPacket: (pkt: Uint8Array) => void;
		onInit?: (guestCid: number, rxMax: number) => void;
		/** @internal Worker mode: the connections (`guestPort:hostPort`) a restored kernel keeps, its owner's host file systems'. */
		keep?: readonly string[];
	};
}

/**
 * The worker option, kept out of CreateKernelOptions so that plain
 * options still type createKernel() as a KernelInstance.
 */
export interface WorkerOption {
	/**
	 * Run the kernel in a worker (a worker_threads Worker on Node, a module
	 * Web Worker in browsers), so it never blocks this thread. The
	 * result is a WorkerKernel: the console, sync(), stop(), stats(),
	 * exited, the disks' state, the display (frame() is the latest frame
	 * the worker sent; readFrame() waits for a fresh one), evdev and sound,
	 * without the low-level `kernel`. Disks and the network must be specs
	 * (devices.ts), which the worker builds. A `display` function is asked
	 * on this thread at boot, on resize() and on
	 * WorkerKernel.updateDisplaySize(). The worker starts at once, and while
	 * it starts this thread downloads (or reads) and compiles the kernel
	 * (the engine compiles off-thread) and then posts the compiled
	 * WebAssembly.Module to it. Default false.
	 */
	worker?: boolean;
	/**
	 * Worker mode: load and compile the kernel in the worker instead of on
	 * this thread (it then starts only once the worker runs, which is
	 * slower). A kernel given as a WebAssembly.Module is posted as it is
	 * either way. Default false.
	 */
	compileInWorker?: boolean;
	/**
	 * Worker mode: console and evdev input and frames through
	 * SharedArrayBuffers (worker-shared.ts), which the worker reads while the
	 * kernel runs, instead of messages it handles only when the kernel
	 * yields (up to 20 ms while the guest is busy). Default (undefined):
	 * shared where a SharedArrayBuffer can be posted (Node; a browser page
	 * only when cross-origin isolated), else messages. false: messages
	 * always. true: shared, or a BootError ("support") where it cannot be.
	 * WorkerKernel.transport says which is used.
	 */
	shared?: boolean;
	/**
	 * Worker mode with `restore`: hand the snapshot's memory buffer to the
	 * worker instead of copying it (about 150 ms per 512 MiB), for a
	 * snapshot that is used once; its `memory` is detached then (one of
	 * 2 GiB or more is shared with the worker instead). Default false.
	 */
	transferRestore?: boolean;
}

export interface InstanceStats extends KernelStats {
	/** Milliseconds since kernel entry. */
	uptimeMs: number;
	/** CPUs the kernel was offered (CreateKernelOptions.cpus, or 1 for a UP kernel or where CPU threads cannot start). */
	cpus: number;
	/** Milliseconds to download and compile the kernel (0 if a Module was given). */
	compileMs: number;
	block: BlockStats;
	net?: NetStats;
	/** JIT counters, of all CPUs together. */
	jit: JitStats;
	/** With more than one CPU: the JIT counters per CPU (CPU 0 first). */
	jitCpus?: JitStats[];
	/** kwemu's counters, only from a -Dkwemu-stats kernel (`kernel/build.sh stats`); CPU 0's. */
	kwemu?: KwemuStats;
	/** With more than one CPU: kwemu's counters per CPU (-Dkwemu-stats kernels). */
	kwemuCpus?: (KwemuStats | undefined)[];
	display?: DisplayStats;
	evdev?: InputStats;
	sound?: SoundStats;
	vsock?: VsockStats;
	shm?: ShmStats;
	/** virtio-gpu (gpu option): commands, transfers, flushes. */
	gpu?: VirtioGpuStats;
}

/** What the entry points supply. */
export interface Platform {
	/** The bundled kernel. */
	defaultKernel(): KernelSource;
	readFile?: (src: URL | string) => Promise<Uint8Array> | undefined;
	defaultMemoryMiB?: () => number;
	defaultMemoryFallbackMiB?: number[];
	/** Start a worker running serveKernel() (worker-serve.ts); without it there is no worker mode. */
	spawnWorker?: () => WorkerEndpoint;
	/** Start a thread running a secondary CPU of an SMP kernel (cpu.ts, runCpu()); without it the kernel gets one CPU. */
	spawnCpu?: (init: CpuInit) => CpuEndpoint;
	/** Why spawnCpu cannot work on the kernel's thread (browsers: no cross-origin isolation, a main thread), or undefined. */
	whyNoCpus?: () => string | undefined;
	/** A relative kernel or initrd location as an absolute URL, for the worker (Node: a path -> file: URL). */
	absoluteUrl?: (src: string) => string | undefined;
	/** The device kinds this platform builds from specs (devices.ts). */
	devices?: DeviceRegistry;
	/** A distro path or URL as a read-only disk spec (Node: a file or an http(s) URL; browsers: an absolute http(s) URL). */
	distroSpec?: (src: string | URL) => DiskSpec;
	/** Start the profiler's time sampler thread (profile.ts); without it there are no time samples. */
	spawnSampler?: (init: SamplerInit) => SamplerHandle;
	/** The wasm GL renderer's module (virgl.mjs, the `gl` option); without it `gl` needs a module or a renderer. */
	glModule?: () => URL;
	/** The guest Vulkan renderer (the `vk` option): its modules and the translator's wasm (kwvk-naga.wasm); web entry only. */
	vk?: () => VkPlatform;
}

/**
 * A running kernel, wherever it runs: KernelInstance (on this thread) and
 * WorkerKernel (in a worker) both have this surface.
 */
export interface KernelHandle {
	/** The command line it booted with. */
	readonly cmdline: string;
	/** The distro image (the `distro` option) as the host read it, or undefined. */
	readonly distro: DistroInfo | undefined;
	/** Settles when the kernel exits: halt (power off 0, halt 1, restart 2), panic 253, trap 254, fatal 255, or stop(). */
	readonly exited: Promise<ExitResult>;
	/** Console output as a stream: the first access gets everything since boot (the last 1 MiB); closes at exit. */
	readonly output: ReadableStream<Uint8Array>;
	/** Call `listener` with console output from now on. Returns the unsubscribe function. */
	onOutput(listener: (bytes: Uint8Array) => void): () => void;
	/** Type into the console (bytes, or text encoded as UTF-8); "\n" or "\r" is Enter. */
	write(data: Uint8Array | string): void;
	/** Console input as a stream. */
	readonly input: WritableStream<Uint8Array | string>;
	/** Set the console window size; the guest's foreground process gets SIGWINCH. */
	resize(cols: number, rows: number): void;
	/** Ask the guest to sync its file systems and disks; true once persistent disks have flushed. */
	sync(opts?: { timeout?: number }): Promise<boolean>;
	/** Stop the kernel now (no clean shutdown). Resolves with the exit. */
	stop(res?: { code?: number; reason?: string }): Promise<ExitResult>;
	/** Save the machine; resume it with createKernel({ restore }) (see KernelInstance.snapshot()). */
	snapshot(opts?: SnapshotOptions): Promise<KernelSnapshot>;
	/** Counters (in a worker: the latest snapshot, at most about 500 ms old while running). */
	stats(): InstanceStats;
	/** With the profile option: the samples so far (after the exit: all of them), else undefined. In a worker, a round trip. */
	profile(): Promise<ProfileReport | undefined>;
	/** Memory actually allocated, in MiB. */
	readonly memoryMiB: number;
	readonly memory64: boolean;
	/** With the display option: the mode while a program has /dev/fb0 open, else null. */
	readonly display: { readonly mode: DisplayMode | null } | undefined;
	/**
	 * With the display option: the display size changed. `size` replaces
	 * the option from now on; without one a `display` function is asked
	 * again (in a worker on this thread; other options: no change). kwfb
	 * takes it at the next first open of /dev/fb0. The virtio-gpu device
	 * (gpu option) offers it at once when it differs from the size the
	 * guest's driver last read (fitted: 64 to 4095 a side, at most about
	 * 3840x2400; virtio-gpu.ts fitGpuSize()): a display event, after which
	 * the driver reads the display info and the EDID again and sends a
	 * hotplug uevent. The guest decides whether to switch: a KMS client
	 * that probes the connector finds the new preferred mode (X: `xrandr
	 * --auto`; kmscube on its next start), and `display`, frames and
	 * onDisplay follow the mode it sets, not this size. Cheap when nothing
	 * changed; debounce calls during a drag yourself.
	 */
	updateDisplaySize(size?: DisplaySize): void;
	/** With the display option: the keyboard, mouse and tablet (InputHost's methods). */
	readonly evdev: Evdev | undefined;
	/** The current frame as RGBA (in a worker: the latest one it sent), or null. */
	frame(out?: Uint8ClampedArray): DisplayFrame | null;
	/** A fresh frame as RGBA (in a worker: a round trip), or null. */
	readFrame(out?: Uint8ClampedArray): Promise<DisplayFrame | null>;
	/** With the sound option: the playback state. */
	readonly sound: { readonly state: SoundState; readonly playing: boolean } | undefined;
	/**
	 * With the vsock option: listen() for guest connections to the host
	 * (CID 2) and connect() to guest listeners (CID 3). In worker mode the
	 * protocol runs on this thread and the packets cross as messages.
	 */
	readonly vsock: Vsock | undefined;
	/**
	 * Run `file` with `args` in the guest (no file: root's login shell),
	 * served by the guest's kwtty over vsock (tty.ts): on its own pty, a Pty
	 * (the zigpty / node-pty shape), or with `pty: false` on stdin, stdout
	 * and stderr pipes, a Subprocess. Rejects with a PtyError ENODEV when
	 * the instance was created with `vsock: false`. Waits until
	 * createKernel's `mounts` are mounted and its `commands` linked, as
	 * exec() does, and rejects with the MountError or CommandError if one
	 * of them failed.
	 */
	spawn(file: string | undefined, args: readonly string[] | undefined, opts: PipeOptions): Promise<Subprocess>;
	spawn(file?: string, args?: readonly string[], opts?: PtyOptions): Promise<Pty>;
	/**
	 * Take over a detachable session (spawn() with `detachable`) by its
	 * `sessionId` or as the snapshot listed it (KernelSnapshot.ttys),
	 * typically after createKernel({ restore }): a live Pty on the same
	 * program and pty, whose output starts with the session's recent output
	 * unless `replay: false` (tty.ts attachPty()). Rejects with a PtyError
	 * ENOENT when the guest has no such session (or cannot reattach: an
	 * image from before the feature), ENODEV without vsock. Does not wait
	 * for createKernel's `mounts` or `commands`.
	 */
	attach(session: string | TtySessionSnapshot, opts?: AttachOptions): Promise<Pty>;
	/**
	 * Run `file` with `args` on pipes, feed it `input`, and resolve with
	 * its stdout and stderr (strings, or bytes with `encoding: "buffer"`)
	 * and how it ended (a non-zero exit resolves too). tty.ts.
	 */
	exec(file: string, args?: readonly string[], opts?: ExecOptions & { encoding?: "utf8" }): Promise<ExecResult<string>>;
	exec(file: string, args: readonly string[] | undefined, opts: ExecOptions & { encoding: "buffer" }): Promise<ExecResult<Uint8Array>>;
	/**
	 * A raw byte stream to TCP `port` on the guest's 127.0.0.1, through the
	 * guest's kwtty (tty.ts, CONNECT): resolves once the guest connected,
	 * rejects with a PtyError ECONNREFUSED when nothing listens there, or
	 * ENODEV without vsock. Waits for createKernel's `mounts`, as spawn().
	 */
	connect(port: number, opts?: ConnectOptions): Promise<GuestSocket>;
	/**
	 * An HTTP/1.1 request to a server on the guest's loopback (http.ts
	 * fetchOver() over connect()): the URL's port picks the guest port
	 * (default 80), its host only goes into the Host header.
	 */
	fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
	/**
	 * Mount a host file system at guest `path` (mounts.ts): serve `fs` over
	 * 9p and run kw9p in the guest. Resolves with the Mount (unmount(),
	 * stats) once the guest has it mounted; rejects with a MountError
	 * (ENODEV without vsock or without 9p in the kernel, ENOENT without kw9p
	 * in the image, EBUSY, ETIMEDOUT, ...).
	 */
	mount(path: string, fs: FsSource, opts?: MountOptions): Promise<Mount>;
	/** The mounts the guest has now, by guest path. */
	readonly mounts: ReadonlyMap<string, Mount>;
	/**
	 * Add a host command (commands.ts): from now on a guest process that
	 * runs `name` calls `handler` here. Resolves once the guest has the link
	 * /run/kw/bin/NAME (at once when `name` is replaced); rejects with a
	 * CommandError (EINVAL for a bad name, ENODEV without vsock, ENOENT
	 * without kwcmd in the image, ETIMEDOUT, ...).
	 */
	addCommand(name: string, handler: HostCommand, opts?: { timeout?: number }): Promise<void>;
	/** Remove a host command and its link in the guest. A guest process running it goes on. */
	removeCommand(name: string, opts?: { timeout?: number }): Promise<void>;
	/** The host commands the guest has now, by name. */
	readonly commands: ReadonlyMap<string, HostCommand>;
	/**
	 * With the shm option: guest shmem files read and written in place
	 * (open(), create(), openId(); ShmFile.read()/write()). In worker mode the
	 * copies run in the worker, where the kernel's memory is, except where
	 * that memory is shared with this thread (an SMP kernel with the shared
	 * transport): then, as inline, readSync() and views() work here
	 * (Shm.inPlace).
	 */
	readonly shm: Shm | undefined;
	/**
	 * How input and frames reach the kernel: "inline" (this thread),
	 * "messages" or "shared" (worker mode; see WorkerOption.shared).
	 */
	readonly transport: KernelTransport;
	/** With the gl option, where it could start: the renderer's host side (ready, stats); it runs on this thread in both modes. */
	readonly gl: GlHost | undefined;
	/** With the vk option, where it could start: the Vulkan renderer's host side (status, stats); on this thread in both modes. */
	readonly vk: VkHost | undefined;
	/** With the va option, where it could start: the VA-API decoder's host side (status, stats); on this thread in both modes. */
	readonly va: VaHost | undefined;
}

function isBackend(n: NetDevice | NetBackend): n is NetBackend {
	return typeof (n as NetBackend).connect === "function" && typeof (n as NetDevice).send !== "function";
}

/** A booted kernel: its console, its exit, and the low-level Kernel. */
export class KernelInstance implements KernelHandle {
	/** The low-level runtime object (imports, memory, IRQ bits). */
	readonly kernel: Kernel;
	readonly module: WebAssembly.Module;
	/** The command line it booted with. */
	readonly cmdline: string;
	/** The network device, if any. */
	readonly net: NetDevice | undefined;
	/** The distro image (the `distro` option) as the host read it, or undefined. */
	distro: DistroInfo | undefined = undefined;
	/** Disks whose spec was optional and could not be built, and why. */
	skippedDisks: SkippedDisk[] = [];
	/** Disks built from specs: the instance closes them at exit. */
	#owned: BlockDevice[] = [];
	/** Settles when the kernel exits: halt (power off 0, halt 1, restart 2), panic 253, trap 254, fatal 255, or stop(). */
	readonly exited: Promise<ExitResult>;
	#out: ConsoleOutput;
	#input: WritableStream<Uint8Array | string> | undefined;
	#compileMs: number;
	#vsock: VsockHost | undefined;
	#shm: ShmClient | undefined;
	#mounts = new MountTable(undefined, () => {});
	#commands = new CommandTable(undefined, () => {});
	#gl: GlHost | undefined;
	#vk: VkHost | undefined;
	#va: VaHost | undefined;

	/** @internal Use createKernel(). */
	constructor(kernel: Kernel, module: WebAssembly.Module, cmdline: string, net: NetDevice | undefined, compileMs: number) {
		this.kernel = kernel;
		this.module = module;
		this.cmdline = cmdline;
		this.net = net;
		this.#compileMs = compileMs;
		this.#out = new ConsoleOutput(() => !!kernel.result);
		if (kernel.shm.enabled) this.#shm = inlineShm(kernel.shm);
		this.exited = kernel.exited.then((res) => {
			this.#gl?.shutdown();
			this.#vk?.shutdown();
			this.#va?.shutdown();
			this.#commands.shutdown();
			this.#mounts.shutdown();
			this.#vsock?.shutdown();
			this.#shm?.shutdown();
			this.#closeNet();
			this.#out.close();
			void this.#closeDisks();
			return res;
		});
	}

	/** @internal The vsock protocol's host end, when the vsock option is set (and not raw). */
	attachVsock(host: VsockHost): void {
		this.#vsock = host;
		const mounts = this.#mounts = new MountTable(host, host.log);
		this.#commands = new CommandTable(host, host.log);
		// The 9p server runs here, on the kernel's thread: its sessions are
		// saved at the snapshot point, with the vsock device.
		this.kernel.vsock.onSave = () => mounts.save();
		this.kernel.vsock.hostBusy = () => mounts.snapshotBusy();
		// The detachable sessions open at the snapshot point (their Ptys end with a stopped kernel).
		this.kernel.onSnapshot = (snap) => {
			const ttys = ttySessions(host);
			if (ttys.length) snap.ttys = ttys;
		};
	}

	/**
	 * @internal createKernel({ restore, mounts }), before the kernel runs:
	 * serve the snapshot's mounts again and tell the kernel to keep their
	 * connections. Returns the mounts to mount once it runs.
	 */
	async restoreMounts(snap: KernelSnapshot, list: ReturnType<typeof parseMounts>): Promise<ReturnType<typeof parseMounts>> {
		const { keep, rest } = await this.#mounts.restore(snap.devices?.vsock?.mounts, list);
		this.kernel.vsock.keep = keep;
		return rest;
	}

	/** @internal createKernel's `mounts`, once the kernel runs. */
	startMounts(list: ReturnType<typeof parseMounts>): void {
		this.#mounts.mountAll(list);
	}

	/** @internal createKernel's `commands`, once the kernel runs. */
	startCommands(list: ReturnType<typeof parseCommands>): void {
		this.#commands.addAll(list);
	}

	/** @internal createKernel's `gl`, once the kernel runs. */
	attachGl(gl: GlHost | undefined): void {
		this.#gl = gl;
		if (gl && this.kernel.result) gl.shutdown();
	}

	/** With the gl option: the GL renderer's host side (gl.ts), or undefined. */
	get gl(): GlHost | undefined {
		return this.#gl;
	}

	/** @internal createKernel's `vk`, once the kernel runs. */
	attachVk(vk: VkHost | undefined): void {
		this.#vk = vk;
		if (vk && this.kernel.result) vk.shutdown();
	}

	/** With the vk option: the Vulkan renderer's host side (vk.ts), or undefined. */
	get vk(): VkHost | undefined {
		return this.#vk;
	}

	/** @internal createKernel's `va`, once the kernel runs. */
	attachVa(va: VaHost | undefined): void {
		this.#va = va;
		if (va && this.kernel.result) va.shutdown();
	}

	/** With the va option: the VA-API decoder's host side (va.ts), or undefined. */
	get va(): VaHost | undefined {
		return this.#va;
	}

	/** createKernel's `mounts` and `commands` first (see KernelHandle.spawn()). */
	#gate<T>(fn: () => Promise<T>): Promise<T> {
		return this.#mounts.gate(() => this.#commands.gate(fn));
	}

	/**
	 * With the vsock option: listen() for guest connections to the host
	 * (CID 2, any port) and connect() to guest listeners (CID 3), each a
	 * byte stream with half-close and reset (VsockHost, vsock.ts).
	 */
	get vsock(): VsockHost | undefined {
		return this.#vsock;
	}

	/**
	 * A program on its own pty, or on pipes (`pty: false`), served by the
	 * guest's kwtty on vsock port 1022 (tty.ts).
	 */
	spawn(file: string | undefined, args: readonly string[] | undefined, opts: PipeOptions): Promise<Subprocess>;
	spawn(file?: string, args?: readonly string[], opts?: PtyOptions): Promise<Pty>;
	spawn(file?: string, args?: readonly string[], opts?: PtyOptions | PipeOptions): Promise<Pty | Subprocess> {
		return this.#gate(() => spawnOn(this.#vsock, file, args, opts));
	}

	/** Take over a detachable session (see KernelHandle.attach()). */
	attach(session: string | TtySessionSnapshot, opts?: AttachOptions): Promise<Pty> {
		return attachOn(this.#vsock, session, opts);
	}

	exec(file: string, args?: readonly string[], opts?: ExecOptions & { encoding?: "utf8" }): Promise<ExecResult<string>>;
	exec(file: string, args: readonly string[] | undefined, opts: ExecOptions & { encoding: "buffer" }): Promise<ExecResult<Uint8Array>>;
	exec(file: string, args?: readonly string[], opts?: ExecOptions): Promise<ExecResult<string | Uint8Array>> {
		return this.#gate(() => execOn(this.#vsock, file, args, opts));
	}

	/** A raw byte stream to a TCP server on the guest's loopback (see KernelHandle.connect()). */
	connect(port: number, opts?: ConnectOptions): Promise<GuestSocket> {
		return this.#gate(() => connectOn(this.#vsock, port, opts));
	}

	/** HTTP/1.1 to a server on the guest's loopback (see KernelHandle.fetch()). */
	fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		return fetchOver((port, o) => this.connect(port, o), input, init);
	}

	/** Mount a host file system in the guest (mounts.ts; see KernelHandle.mount()). */
	mount(path: string, fs: FsSource, opts?: MountOptions): Promise<Mount> {
		return this.#mounts.mount(path, fs, opts);
	}

	get mounts(): ReadonlyMap<string, Mount> {
		return this.#mounts.mounts;
	}

	/** Add a host command (commands.ts; see KernelHandle.addCommand()). */
	addCommand(name: string, handler: HostCommand, opts?: { timeout?: number }): Promise<void> {
		return this.#commands.add(name, handler, opts);
	}

	removeCommand(name: string, opts?: { timeout?: number }): Promise<void> {
		return this.#commands.remove(name, opts);
	}

	get commands(): ReadonlyMap<string, HostCommand> {
		return this.#commands.commands;
	}

	/**
	 * With the shm option: open guest shmem files by name or by a guest
	 * export's id and read and write their pages in place (shm.ts). Handles
	 * read in place here (readSync(), views(): zero-copy views of the
	 * kernel's memory, valid until the kernel runs again).
	 */
	get shm(): ShmClient | undefined {
		return this.#shm;
	}

	/** @internal Disks built from specs, closed (after their last save) when the kernel exits. */
	own(disks: BlockDevice[]): void {
		this.#owned.push(...disks);
	}

	/** Resolves once every save in flight on the disks has settled (a no-op for disks without saves). */
	async settled(): Promise<void> {
		await Promise.all(this.kernel.block.disks.map((d) => d.saving?.catch(() => {})));
	}

	async #closeDisks(): Promise<void> {
		await this.settled();
		for (const d of this.#owned) {
			try {
				const c = d as BlockDevice & { close?: () => void; store?: { close?: () => Promise<void> } | null };
				if (typeof c.close === "function") c.close();
				else await c.store?.close?.();
			} catch {}
		}
	}

	/** @internal Console output from the kernel. */
	emit(bytes: Uint8Array): void {
		this.#out.emit(bytes);
	}

	/**
	 * Console output as a stream. The first access gets everything since
	 * boot (the last 1 MiB); later chunks are queued without limit, so keep
	 * reading it (or use onOutput()). Closes when the kernel exits. There is
	 * one such stream; tee() it for more readers.
	 */
	get output(): ReadableStream<Uint8Array> {
		return this.#out.stream;
	}

	/** Call `listener` with console output from now on. Returns the unsubscribe function. */
	onOutput(listener: (bytes: Uint8Array) => void): () => void {
		return this.#out.listen(listener);
	}

	/** Type into the console (bytes, or text encoded as UTF-8); "\n" or "\r" is Enter. */
	write(data: Uint8Array | string): void {
		this.kernel.sendInput(data);
	}

	/** Console input as a stream (e.g. pipe a terminal into it). */
	get input(): WritableStream<Uint8Array | string> {
		return (this.#input ??= new WritableStream<Uint8Array | string>({
			write: (chunk) => this.write(chunk),
		}));
	}

	/** Set the console window size; the guest's foreground process gets SIGWINCH. */
	resize(cols: number, rows: number): void {
		this.kernel.setConsoleSize(cols, rows);
	}

	/**
	 * Ask the guest to write back all file systems and flush its disks (the
	 * sync IRQ), e.g. before a page goes away. Resolves true once every
	 * persistent disk (FileDisk, a CowDisk saved in IndexedDB) has completed
	 * a flush issued after the call, false after `timeout` ms (default 3000).
	 * True at once without persistent disks.
	 */
	sync(opts: { timeout?: number } = {}): Promise<boolean> {
		return this.kernel.requestSync(opts);
	}

	/**
	 * Save the machine (Kernel.snapshot()); resume it with createKernel({
	 * restore }). Disks are not copied: the snapshot stays restorable only
	 * while they are unchanged. Without `stop` the guest keeps running, and
	 * its next disk write ends that; `stop: true` stops the kernel right
	 * after the copy (no clean shutdown), the usual way to suspend a machine
	 * with disks. The devices' host state is saved (display, input, sound,
	 * shm exports, the network's MAC); vsock sessions and TCP connections
	 * are not (a restored guest's ends are reset), but detachable terminal
	 * sessions survive in the guest and are listed in `ttys` for attach(). Host file systems are:
	 * each mount's 9p session and the guest's open files on it (not the
	 * files themselves; restore with the same `mounts`). Rejects while a
	 * mount or unmount runs, or when a 9p request is in flight at the
	 * snapshot point. `commit` stores the snapshot while the kernel waits
	 * at that point, and the kernel stops only once it succeeded (with
	 * `hold`, or waits on there until told to stop or go on); if it fails
	 * the guest goes on (SnapshotOptions, SnapshotCommitError).
	 */
	snapshot(opts: SnapshotOptions = {}): Promise<KernelSnapshot> {
		const why = this.#mounts.snapshotBlocker(true);
		if (why) return Promise.reject(new Error(`snapshot: ${why}`));
		return this.kernel.snapshot(opts);
	}

	/**
	 * Stop the kernel now (no clean shutdown: the guest is not told and
	 * unflushed disk writes are lost; prefer typing `poweroff` or call
	 * sync() first). Resolves
	 * with the exit, which is the stop unless the kernel had already exited.
	 */
	stop(res: { code?: number; reason?: string } = {}): Promise<ExitResult> {
		this.kernel.stop(res);
		return this.exited;
	}

	stats(): InstanceStats {
		const k = this.kernel;
		return {
			...k.stats,
			uptimeMs: k.bootTime ? performance.now() - k.bootTime : 0,
			cpus: k.cpus,
			compileMs: this.#compileMs,
			block: { ...k.block.stats },
			jit: k.jitStatsAll(),
			jitCpus: k.cpus > 1 ? k.jitStatsPerCpu() : undefined,
			kwemu: k.jit.kwemuStats(),
			kwemuCpus: k.cpus > 1 ? k.kwemuStatsPerCpu() : undefined,
			net: this.net instanceof NetStack ? { ...this.net.stats } : undefined,
			display: k.display.enabled ? { ...k.display.stats } : undefined,
			evdev: k.evdev.enabled ? { ...k.evdev.stats } : undefined,
			sound: k.sound.enabled ? { ...k.sound.stats } : undefined,
			vsock: this.#vsock ? { ...this.#vsock.stats } : undefined,
			shm: this.#shm?.stats,
			gpu: k.gpu ? { ...k.gpu.stats } : undefined,
		};
	}

	/** With the profile option: the samples so far (profile.ts), else undefined. */
	profile(): Promise<ProfileReport | undefined> {
		return Promise.resolve(this.kernel.profiler?.report());
	}

	/** The kernel runs on this thread. */
	get transport(): KernelTransport {
		return "inline";
	}

	/** The sound card's host side, if the sound option was set: `playing`, `state`, `stats`. */
	get sound(): SoundHost | undefined {
		return this.kernel.sound.enabled ? this.kernel.sound : undefined;
	}

	/** Memory actually allocated, in MiB. */
	get memoryMiB(): number {
		return this.kernel.memory.buffer.byteLength / 1048576;
	}

	get memory64(): boolean {
		return this.kernel.memory64;
	}

	/**
	 * The display's host side, if the display option was set: its mode and
	 * the address of the pixels while a guest program has /dev/fb0 open.
	 */
	get display(): DisplayHost | undefined {
		return this.kernel.display.enabled ? this.kernel.display : undefined;
	}

	/** See KernelHandle.updateDisplaySize(). */
	updateDisplaySize(size?: DisplaySize): void {
		const k = this.kernel;
		if (k.result || !k.display.enabled) return;
		if (size) k.display.setSize({ width: size.width, height: size.height, dpi: size.dpi });
		k.gpu?.displayChanged();
	}

	/**
	 * The current frame as RGBA (canvas ImageData layout), or null when there
	 * is no display or no program has it open. The guest is suspended
	 * whenever this can run, but a program may be in the middle of drawing;
	 * call it once per animation frame at most. `out` is reused when it has
	 * the right size.
	 */
	/**
	 * The keyboard and mouse (with the display option): key(), button(),
	 * move(), wheel(), and their open state (keyboardOpen, mouseOpen).
	 */
	get evdev(): InputHost | undefined {
		return this.kernel.evdev.enabled ? this.kernel.evdev : undefined;
	}

	frame(out?: Uint8ClampedArray): DisplayFrame | null {
		// A 3D resource on virtio-gpu's scanout: read back from the renderer.
		if (this.#gl?.gpu?.scanout) return this.#gl.gpu.frame(out);
		return this.kernel.display.enabled ? this.kernel.display.readRGBA(out) : null;
	}

	/** frame(), as a promise (the same call as WorkerKernel.readFrame(), which needs a round trip). */
	readFrame(out?: Uint8ClampedArray): Promise<DisplayFrame | null> {
		return Promise.resolve(this.frame(out));
	}

	#closeNet(): void {
		const n = this.net;
		try {
			n?.close?.();
			if (n instanceof NetStack) n.backend.close?.();
		} catch {}
	}
}

/**
 * createKernel() for a platform (the entries export it bound): a
 * KernelInstance, or with `worker: true` a WorkerKernel.
 */
export function createKernelOn(platform: Platform, opts: CreateKernelOptions & { worker: true }): Promise<WorkerKernel>;
export function createKernelOn(platform: Platform, opts?: CreateKernelOptions & { worker?: false }): Promise<KernelInstance>;
export function createKernelOn(platform: Platform, opts?: CreateKernelOptions & WorkerOption): Promise<KernelHandle>;
export async function createKernelOn(platform: Platform, opts: CreateKernelOptions & WorkerOption = {}): Promise<KernelHandle> {
	if (typeof WebAssembly !== "object" || typeof WebAssembly.Suspending !== "function" || typeof WebAssembly.promising !== "function")
		throw new BootError("support", "This engine has no JSPI (WebAssembly.Suspending / WebAssembly.promising), which the kernel needs");
	const restoring = opts.restore;
	if (restoring) {
		// A snapshot of an SMP machine boots the SMP kernel with its CPUs, unless told otherwise.
		if (opts.cpus === undefined) opts = { ...opts, cpus: restoring.cpus ?? 1 };
		const why = snapshotCpuMismatch(restoring, Math.max(1, Math.floor(opts.cpus ?? 1)));
		if (why) throw new BootError("boot", `snapshot: ${why}`);
	}
	const { signal, onProgress } = opts;
	const progress = (p: BootProgress) => { try { onProgress?.(p); } catch {} };
	const vopt = opts.vsock ?? true;
	const raw = typeof vopt === "object" ? vopt.raw : undefined;
	const mounts = parseMounts(opts.mounts, !!vopt && !raw);
	const commands = parseCommands(opts.commands, !!vopt && !raw);
	const savedMounts = opts.restore?.devices?.vsock?.mounts;
	// The worker's kernel (raw) resumes them with the connections its owner serves them on (keep).
	if (savedMounts?.mounts.length && raw && !raw.keep)
		throw new BootError("boot", `snapshot: it has host file systems (${savedMounts.mounts.map((m) => m.path).join(", ")}), which do not resume with vsock.raw`);
	const mountsWhy = opts.restore && !raw && snapshotMountMismatch(savedMounts, mounts);
	if (mountsWhy) throw new BootError("boot", `snapshot: ${mountsWhy}`);
	// gl (and gpu): before the boot, as the device offers virgl when the driver probes; the renderer
	// itself loads on the guest's first GL use unless gl.eager (gl.ts).
	const glPrep = prepareGl(opts.gl, !!opts.gpu, !!vopt && !raw, platform.glModule?.(), opts.log ?? ((m: string) => console.error(m)), !!opts.restore);
	// vk: nothing loads before the guest's first Vulkan instance (vk.ts).
	const vkPrep = prepareVk(opts.vk, !!vopt && !raw, platform.vk?.(), opts.log ?? ((m: string) => console.error(m)));
	// va: nothing is asked of WebCodecs before the guest's first VA-API connection (va.ts).
	const vaPrep = prepareVa(opts.va, !!vopt && !raw, opts.log ?? ((m: string) => console.error(m)));
	if (opts.worker) {
		checkWorkerOptions(platform, opts);
		const vm = await createKernelInWorker(platform, opts, progress, glPrep?.gpu, mounts);
		vm.startMounts(mounts);
		vm.startCommands(commands);
		vm.attachGl(startGl(glPrep, vm.vsock, opts.log ?? ((m: string) => console.error(m))));
		vm.attachVk(startVk(vkPrep, vm.vsock, opts.log ?? ((m: string) => console.error(m))));
		vm.attachVa(startVa(vaPrep, vm.vsock, opts.log ?? ((m: string) => console.error(m)), glPrep?.gpu));
		return vm;
	}
	const loadOpts = { signal, readFile: platform.readFile, onProgress: progress };

	const t0 = performance.now();
	const kernelSource = opts.kernel ?? platform.defaultKernel();
	if (!(kernelSource instanceof WebAssembly.Module)) progress({ stage: "compile" });
	const [module, initrdBytes] = await Promise.all([
		loadKernelModule(kernelSource, { ...loadOpts, what: "kernel", smp: (opts.cpus ?? 1) > 1 }),
		opts.initrd == null ? opts.initrd : loadBytes(opts.initrd, { ...loadOpts, what: "initrd" }),
	]);
	const compileMs = kernelSource instanceof WebAssembly.Module ? 0 : performance.now() - t0;
	if (!(kernelSource instanceof WebAssembly.Module)) progress({ stage: "compiled", ms: compileMs, memory64: moduleIsMemory64(module) });
	if (signal?.aborted) throw new BootError("download", "aborted", { cause: signal.reason });

	const bundled = bundledBoot(module);
	const initrd = initrdBytes === undefined ? bundled.initrd ?? null : initrdBytes;
	const log = opts.log ?? ((m: string) => console.error(m));
	const devCtx = { module, log, onDiskError: (i: number, e: unknown) => { try { opts.onDiskError?.(i, e); } catch {} } };
	if (opts.distro !== undefined && !initrd && opts.cmdline === undefined && !opts.restore)
		throw new BootError("boot", "distro: the kernel has no initramfs to mount it (use the bundled kernel, unkernel.wasm, or pass initrd or cmdline)");
	const distro = opts.distro === undefined ? undefined : await openDistro(opts.distro, platform.devices, devCtx, platform.distroSpec);
	const items = opts.disks ?? [];
	let built: Awaited<ReturnType<typeof buildDisks>>;
	try {
		built = await buildDisks(items, platform.devices, devCtx);
	} catch (e) {
		if (distro?.owned) distro.disk.close();
		throw e;
	}
	const { skipped } = built;
	const owned = built.disks.filter((d) => !items.includes(d));
	if (distro?.owned) owned.push(distro.disk);
	const disks = distro ? [distro.disk, ...built.disks] : built.disks;
	const cmdline = opts.cmdline ?? (initrdBytes === undefined && bundled.initrd && bundled.cmdline ? bundled.cmdline
		: disks.length && !initrd ? "console=hvc0 root=/dev/wda rw" : "console=hvc0 rdinit=/init");

	const net = !opts.net ? undefined : isNetSpec(opts.net) ? buildNet(opts.net, platform.devices, devCtx)
		: isBackend(opts.net) ? new NetStack({ backend: opts.net, log: opts.log }) : opts.net;

	let kernelRef: Kernel | undefined;
	const vsock = vopt && !raw ? new VsockHost({
		send: (pkt) => kernelRef?.vsock.deliver(pkt),
		bufferSize: typeof vopt === "object" ? vopt.bufferSize : undefined,
		log,
	}) : undefined;

	let instance: KernelInstance | undefined;
	let started!: () => void;
	const startedP = new Promise<void>((r) => (started = r));
	const kernel = new Kernel({
		module, initrd, cmdline, disks, net,
		memoryMiB: opts.memoryMiB ?? platform.defaultMemoryMiB?.() ?? 2048,
		memoryFallbackMiB: opts.memoryFallbackMiB ?? platform.defaultMemoryFallbackMiB,
		memory64: opts.memory64,
		jit: opts.jit,
		cpus: opts.cpus,
		spawnCpu: platform.spawnCpu,
		whyNoCpus: platform.whyNoCpus,
		consoleRing: opts.consoleRing,
		flushOutput: opts.flushOutput,
		profile: opts.profile === true ? {} : opts.profile || undefined,
		spawnSampler: platform.spawnSampler,
		restore: opts.restore,
		display: opts.display ?? (opts.gpu ? true : undefined),
		onDisplay: opts.onDisplay,
		onInput: opts.onInput,
		sound: opts.sound,
		gpu: !!opts.gpu,
		gpuBackend: opts.gpuBackend ?? (glPrep?.gpu && new VirglGpuBackend(inlineGpuLink(glPrep.gpu), log)),
		vsock: !!vopt,
		onVsockPacket: raw ? raw.onPacket : vsock && ((pkt) => vsock.receive(pkt)),
		onVsockInit: raw ? raw.onInit : vsock && ((cid, rxMax) => vsock.deviceReady(cid, rxMax)),
		shm: !!opts.shm,
		log: opts.log,
		write: (bytes) => {
			opts.onOutput?.(bytes);
			instance?.emit(bytes);
		},
		onStage: (stage, detail) => {
			if (stage === "memory") progress({ stage, ...(detail as MemoryStage) });
			else if (stage === "instantiate") progress({ stage });
			else if (stage === "start") {
				progress({ stage, cmdline });
				started();
			}
		},
	});
	kernelRef = kernel;
	instance = new KernelInstance(kernel, module, cmdline, net, compileMs);
	if (vsock) instance.attachVsock(vsock);
	instance.skippedDisks = skipped;
	instance.distro = distro?.disk.info;
	instance.own(owned);
	if (opts.consoleSize) kernel.setConsoleSize(opts.consoleSize.cols, opts.consoleSize.rows);
	if (raw?.keep) kernel.vsock.keep = new Set(raw.keep);
	let rest = mounts;
	if (opts.restore && vsock) {
		try {
			rest = await instance.restoreMounts(opts.restore, mounts);
		} catch (e) {
			instance.stop({ code: 1, reason: (e as Error).message });
			throw new BootError("boot", `snapshot: host file systems: ${(e as Error).message}`, { cause: e });
		}
	}

	const booting = kernel.boot();
	try {
		await Promise.race([startedP, booting]);
	} catch (e) {
		const err = e as Error;
		instance.stop({ code: 1, reason: err.message });
		throw new BootError(err.name === "MemoryAllocationError" ? "memory" : "boot", err.message, { cause: e });
	}
	booting.catch(() => {});
	// A restored guest's virtio-gpu driver read a display size this host does not know: offer the current one.
	if (opts.restore) kernel.gpu?.displayChanged(true);
	instance.startMounts(rest);
	instance.startCommands(commands);
	instance.attachGl(startGl(glPrep, vsock, log));
	instance.attachVk(startVk(vkPrep, vsock, log));
	instance.attachVa(startVa(vaPrep, vsock, log, glPrep?.gpu));
	if (signal) {
		const onAbort = () => instance.stop({ code: 130, reason: "aborted" });
		if (signal.aborted) onAbort();
		else {
			signal.addEventListener("abort", onAbort, { once: true });
			void instance.exited.then(() => signal.removeEventListener("abort", onAbort));
		}
	}
	return instance;
}
