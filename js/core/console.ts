// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Split the kernel console (hvc0) into kernel messages and user output.
//
// The console carries both the kernel's log (printk) and whatever user space
// writes. A kernel console line is "[ seconds.micro] ..." at the start of a
// line. The same text also comes from `dmesg` in the shell, so a stamped line
// counts as a kernel message only if its time does not go backwards and it
// was not seen before; otherwise it, and the stamped lines right after it,
// are user output. A line start that could still become a stamp ("[  12")
// is held back until it is decidable, at most `holdMs` (a program that
// printed "[12" and waits for input must still see it on the screen).
//
// UI-free: a terminal can show user output only, and the kernel lines (or
// the important ones) elsewhere.

/** A kernel log line: "[    1.234567] ...". */
export const KSTAMP: RegExp = /^\[ *(\d+\.\d+)\]/;
const KMAYBE = /^\[ *(\d+(\.\d*)?)?$/; // could still become a stamp
/** Kernel messages worth showing even when kernel lines are hidden. */
export const IMPORTANT: RegExp = /Kernel panic|Oops|BUG:|WARNING:|Out of memory|Killed process|segfault|unhandled signal|soft lockup|blocked for more than/;
/** ANSI escape sequences (CSI, charset selection, keypad modes, save/restore). */
export const ANSI: RegExp = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;
/** Common shell prompt endings (POSIX $, root #, zsh %, fish/custom >, unkernel Debian ⇒, starship/pure ❯). */
export const PROMPT_RE: RegExp = /[#$%>⇒❯] ?$/;

export interface KernelLineInfo {
	/** The time stamp, seconds since boot. */
	time: number;
	/** Matches IMPORTANT (panic, oops, OOM kill, segfault, ...). */
	important: boolean;
	/** The line as received, with its line end. */
	raw: string;
}

export interface ConsoleRouterOptions {
	/** A kernel message, without "\r" and the line end. */
	onKernelLine?: (line: string, info: KernelLineInfo) => void;
	/** User-space output (including `dmesg` output), as it arrives. */
	onUserOutput?: (text: string) => void;
	/**
	 * Once: user space printed its first non-empty line, or a shell prompt.
	 * `why` is "first output: <line>" or "shell prompt".
	 */
	onUserspace?: (why: string) => void;
	/**
	 * Once: user space printed an interactive shell prompt.
	 */
	onPrompt?: (why: string) => void;
	/** How long an undecidable line start is held back, default 250 ms. */
	holdMs?: number;
}

export class ConsoleRouter {
	/** Whether user space has started printing (onUserspace fired). */
	userspace = false;
	/** Whether an interactive shell prompt was detected (onPrompt fired). */
	promptSeen = false;
	#opts: ConsoleRouterOptions;
	#dec = new TextDecoder();
	#gate: "start" | "kern" | "user" = "start";
	#hold = "";
	#kline = "";
	#holdTimer: ReturnType<typeof setTimeout> | undefined;
	#dmesgBlock = false;
	#lastKTime = -1;
	#seen = new Set<string>();
	#seenOrder: string[] = [];
	#userTail = "";

	constructor(opts: ConsoleRouterOptions = {}) {
		this.#opts = opts;
	}

	/** Console output: bytes (decoded as a UTF-8 stream) or text. */
	write(data: Uint8Array | string): void {
		this.#route(typeof data === "string" ? data : this.#dec.decode(data, { stream: true }));
	}

	/** Release a held-back line start as user output now. */
	flush(): void {
		clearTimeout(this.#holdTimer);
		this.#releaseHold();
	}

	#releaseHold(): void {
		if (this.#gate === "start" && this.#hold) {
			this.#gate = "user";
			this.#dmesgBlock = false;
			const h = this.#hold;
			this.#hold = "";
			this.#userOutput(h);
		}
	}

	#markUserspace(why: string): void {
		if (this.userspace) return;
		this.userspace = true;
		this.#opts.onUserspace?.(why);
	}

	#markPrompt(why: string): void {
		if (this.promptSeen) return;
		this.promptSeen = true;
		this.#opts.onPrompt?.(why);
	}

	#userOutput(text: string): void {
		this.#opts.onUserOutput?.(text);
		this.#userTail += text;
		if (!this.userspace) {
			let i;
			while (!this.userspace && (i = this.#userTail.indexOf("\n")) >= 0) {
				const line = this.#userTail.slice(0, i).replace(ANSI, "").replace(/\r/g, "");
				this.#userTail = this.#userTail.slice(i + 1);
				if (line.trim()) this.#markUserspace(`first output: ${line.trim().slice(0, 60)}`);
			}
		}
		if (this.#userTail.length > 8192) this.#userTail = this.#userTail.slice(-1024);
		const clean = this.#userTail.replace(ANSI, "");
		if (PROMPT_RE.test(clean)) {
			if (!this.userspace) this.#markUserspace("shell prompt");
			this.#markPrompt("shell prompt");
		}
	}

	#kernelLine(raw: string): void {
		const line = raw.replace(/\r/g, "").replace(/\n$/, "");
		const t = Number(KSTAMP.exec(line)![1]);
		if (this.#dmesgBlock || t < this.#lastKTime || this.#seen.has(line)) {
			this.#dmesgBlock = true;
			this.#userOutput(raw);
			return;
		}
		this.#lastKTime = t;
		this.#seen.add(line);
		if (this.#seenOrder.push(line) > 4096) this.#seen.delete(this.#seenOrder.shift()!);
		this.#opts.onKernelLine?.(line, { time: t, important: IMPORTANT.test(line), raw });
	}

	#route(s: string): void {
		clearTimeout(this.#holdTimer);
		while (s) {
			if (this.#gate === "start") {
				s = this.#hold + s;
				this.#hold = "";
				if (KSTAMP.test(s)) this.#gate = "kern";
				else if (KMAYBE.test(s)) {
					// Not decidable yet: give up after holdMs.
					this.#hold = s;
					this.#holdTimer = setTimeout(() => this.#releaseHold(), this.#opts.holdMs ?? 250);
					return;
				} else { this.#gate = "user"; this.#dmesgBlock = false; }
			}
			const i = s.indexOf("\n");
			const part = i < 0 ? s : s.slice(0, i + 1);
			s = i < 0 ? "" : s.slice(i + 1);
			if (this.#gate === "user") this.#userOutput(part);
			else if (this.#kline.length < 8192) this.#kline += part;
			if (i >= 0) {
				if (this.#gate === "kern") this.#kernelLine(this.#kline);
				this.#kline = "";
				this.#gate = "start";
			}
		}
	}
}
