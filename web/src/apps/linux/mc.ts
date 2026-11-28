// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Midnight Commander: mc from Alpine's main repository (about 4.5 MB to
// download with its libraries, glib and slang the largest), opened on a
// small tree written here (the left panel) and /proc (the right one), so
// there is something of the guest's own to look at.
//
// The skin is modarin256-defbg, which ships with mc: 256 colours over the
// terminal's own background, so mc sits on the page's black instead of
// mc's classic blue. It needs a terminal that reports 256 colours, which
// the window's TERM=xterm-256color does (the terminfo comes with mc's
// dependencies, in /etc/terminfo). The mouse stays on: mc asks for
// button-event tracking with SGR coordinates (modes 1002 and 1006), which
// wterm reports, and tapping mc's menu and F-key bar is the way to reach
// F-keys on a phone (Esc then a digit works too). Shift-drag still selects
// text; mc -d would turn the mouse off. samples.tar.gz is made from samples/ on each run, for mc's
// archive VFS: Enter on it browses it like a directory.
import type { TerminalApp } from "../types.ts";

const README = `Midnight Commander in unkernel: the distro's aarch64 build of mc,
running on Linux, compiled to WebAssembly, in this browser tab.

The left panel is this directory, the right one is /proc: the kernel's
view of itself. Try F3 on /proc/cpuinfo, /proc/version or /proc/meminfo.

  Tab      other panel              Enter    open a directory or archive
  F3       view                     F4       edit (mcedit)
  F5       copy to the other panel  F6       move or rename
  F7       make a directory         F8       delete
  F9       menu                     F10      quit (to the shell)
  Insert   mark a file              Ctrl-O   show the shell under mc
  Alt-?    find files               Ctrl-\\   directory hotlist

No F-keys (a phone)? Press Esc, then the digit: Esc 3 is F3, Esc 0 is F10.
Or tap the bar at the bottom: the mouse works in mc.

Things to try here:
  - Enter on samples.tar.gz: mc reads the archive like a directory.
  - F3 or F4 on samples/hello.c: mcedit highlights the syntax.
  - Enter on colors.sh: runs it and shows the terminal's 256 colours.
  - Ctrl-O, type a command, Ctrl-O again to go back to the panels.

./run.sh starts mc again. The skin is chosen with -S in run.sh; the others
are in /usr/share/mc/skins.
`;

const HELLO = `/* Open me with F4: mcedit highlights C (and many other languages). */
#include <stdio.h>
#include <sys/utsname.h>

int main(void)
{
	struct utsname u;

	if (uname(&u) != 0)
		return 1;
	printf("Hello from %s %s on %s\\n", u.sysname, u.release, u.machine);
	return 0;
}
`;

const UNKERNEL = `unkernel, layer by layer

  your browser      runs one WebAssembly module
  the kernel        Linux, built for arch/wasm with an MMU
  user space        unmodified aarch64 Linux binaries
  kwemu             the aarch64 CPU inside the kernel, with a JIT
                    that turns hot guest code into WebAssembly

mc, the shell and everything in /proc come from that stack. Nothing
here runs on a server: close the tab and the machine is gone (unless
the data disk keeps your files).
`;

const PLANETS = `name,type,moons,day_hours
Mercury,rocky,0,4222.6
Venus,rocky,0,2802.0
Earth,rocky,1,24.0
Mars,rocky,2,24.7
Jupiter,gas giant,95,9.9
Saturn,gas giant,146,10.7
Uranus,ice giant,28,17.2
Neptune,ice giant,16,16.1
`;

const COLORS = `#!/bin/sh
# The terminal's 256 colours: the 16 standard ones, the 6x6x6 cube and
# the gray ramp. Enter on this file in mc runs it.
cell() { printf '\\033[48;5;%sm  \\033[0m' "$1"; }
i=0
while [ $i -lt 16 ]; do cell $i; i=$((i + 1)); done
echo
i=16
while [ $i -lt 232 ]; do
	cell $i
	[ $(((i - 15) % 36)) -eq 0 ] && echo
	i=$((i + 1))
done
while [ $i -lt 256 ]; do cell $i; i=$((i + 1)); done
echo
`;

export default {
	id: "mc",
	title: "Midnight Commander",
	desc: "The two-panel file manager, on a demo tree and the guest's /proc",
	// Two file panels, a selected row and the key bar.
	icon: { svg: '<path fill-rule="evenodd" d="M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm.4 2.4v11.2h6.4V5.4Zm8.8 0v11.2h6.4V5.4Z"/><path opacity=".7" d="M5.8 7h3.6v1.4H5.8Zm0 2.8h3.6v1.4H5.8Zm8.8-2.8h3.6v1.4h-3.6Zm0 5.6h3.6V14h-3.6Zm0-2.8h3.6v1.4h-3.6Z"/><path d="M4.4 12.6h6.4V14H4.4Z"/>' },
	colors: ["#00a8a8", "#0000a8"],
	needs: { net: true },
	files: {
		"README": README,
		"colors.sh": { content: COLORS, mode: 0o755 },
		"samples/hello.c": HELLO,
		"samples/unkernel.txt": UNKERNEL,
		"samples/planets.csv": PLANETS,
	},
	packages: { alpine: ["mc"], arch: ["mc"], debian: ["mc"] },
	terminal: "window",
	commands: [
		"tar czf samples.tar.gz samples",
		"mc -S modarin256-defbg \"$PWD\" /proc",
	],
} satisfies TerminalApp;
