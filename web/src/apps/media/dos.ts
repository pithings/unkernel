// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// DOS: FreeDOS 1.2 booting on a PC emulated by qemu-system-i386, an aarch64
// program on the guest, drawn in the terminal by qemu's curses display
// (VGA text mode; a program that switches to graphics shows nothing).
// qemu-system-i386 and qemu-ui-curses are in community: about 25 MB to
// download with glib, pixman and their other libraries, so the first run
// takes a while. qemu's TCG output is interpreted by kwemu like any other
// code.
//
// The disk is FreeDOS 1.2's boot floppy (FD12FLOPPY.zip from ibiblio, the
// FreeDOS project's mirror: 839 KB, one 1.44 MB image), fetched once.
// It boots the installer, so dos.sh edits the image with mtools (main,
// 0.1 MB): it deletes SETUP.BAT and replaces FDCONFIG.SYS and AUTOEXEC.BAT
// with the least that boots to a prompt. Every driver the floppy loads
// costs seconds under two layers of emulation: as shipped, qemu took 6.5 s
// to reach the FreeDOS kernel, 19 s more to the shell (the F5/F8 wait,
// HIMEMX) and 45 s more for AUTOEXEC.BAT (CD-ROM drivers, LBACACHE, the
// welcome text) (riscv64 guest, CLI, 2026-11-15). Only FDAPM APMDOS stays: it halts the
// CPU while DOS waits for a key, so an idle prompt does not keep qemu, and
// the tab, at full speed. qemu runs with -nodefaults (no CD-ROM for the
// BIOS to probe, no parallel port) and 4 MB of memory. The
// floppy keeps EDIT, MEM, FDISK, XCOPY and the rest of the installer's
// tools in \FDSETUP\BIN, which is on PATH, and A: is writable, so what you
// save stays in fdos12.img for the next run.
//
// Even stripped, the boot is slow: qemu's TCG writes new x86 translations
// all the time, and kwemu must interpret or recompile each one, so code
// the PC runs once (the BIOS, the kernel, AUTOEXEC) costs the most. So
// FreeDOS boots once: AUTOEXEC.BAT ends with READY on COM1 (a file), and
// dos.sh then pauses the PC and saves it with qemu's migration (HMP on a
// FIFO monitor: stop, migrate to gzip, cont) into freedos.state. Later
// runs start qemu with -incoming from that file, at the prompt, with the
// welcome text on the screen. A state fits only the floppy it was saved
// with, since DOS keeps parts of the disk in memory: once the image is
// newer than the state (DOS wrote to A:), dos.sh boots again and saves
// again. A state qemu cannot load is deleted.
//
// AUTOEXEC.BAT's alias halt (fdapm poweroff) turns the PC off over APM,
// and qemu exits; so does reboot, because of -no-reboot. Esc then 2 opens
// qemu's monitor, where quit leaves too. qemu's own messages go to
// qemu.log, so they do not scribble over the curses screen; dos.sh shows
// the log when qemu fails.
import type { TerminalApp } from "../types.ts";

const DOS = String.raw`#!/bin/sh
# FreeDOS on an emulated PC: qemu-system-i386 (an aarch64 program) boots the
# FreeDOS 1.2 boot floppy, with its installer removed, to an A:\> prompt.
set -e
IMG=fdos12.img
URL=https://www.ibiblio.org/pub/micro/pc-stuff/freedos/files/distributions/1.2/official/FD12FLOPPY.zip
export MTOOLS_SKIP_CHECK=1
B='\033[1m' D='\033[90m' N='\033[0m'

# dos FILE: write stdin to FILE on the image, with DOS line ends.
dos() { sed 's/$/\r/' > dos.tmp && mcopy -o -i FLOPPY.img dos.tmp "::$1" && rm dos.tmp; }

if [ ! -f "$IMG" ]; then
	printf "$D%s$N\n" "Fetching the FreeDOS 1.2 boot floppy (839 KB) from ibiblio.org"
	rm -f fd12.zip FLOPPY.img
	wget -q -O fd12.zip "$URL" || { echo "dos.sh: could not download $URL" >&2; exit 1; }
	unzip -oq fd12.zip FLOPPY.img
	rm fd12.zip
	# The least that boots to a prompt: no installer, no HIMEM, no CD-ROM
	# drivers, no disk cache, and no F5/F8 wait (SWITCHES=/F /N).
	mdel -i FLOPPY.img ::SETUP.BAT
	dos FDCONFIG.SYS <<'EOF'
SWITCHES=/F /N
FILES=20
BUFFERS=10
LASTDRIVE=E
SHELL=\COMMAND.COM \FDSETUP\BIN /E:1024 /P=\AUTOEXEC.BAT
EOF
	dos AUTOEXEC.BAT <<'EOF'
@echo off
set DOSDIR=\FDSETUP
set PATH=\FDSETUP\BIN
set DIRCMD=/OGN
rem Halt the CPU while DOS waits for a key, so qemu idles too.
FDAPM APMDOS >NUL
alias halt=fdapm poweroff
alias shutdown=fdapm poweroff
cls
echo FreeDOS 1.2, on a PC emulated by qemu-system-i386, an aarch64 program,
echo on Linux compiled to WebAssembly, running in your browser.
echo.
echo Try DIR /W, VER, MEM, or EDIT NOTES.TXT (A: is writable and kept).
echo HALT turns the PC off and returns to Linux.
echo.
rem Tell dos.sh the prompt is up, so it can save the machine here.
echo READY>COM1
EOF
	mv FLOPPY.img "$IMG"
fi

# The machine saved at the prompt fits only the floppy it was saved with:
# once DOS has written to the floppy, boot again (and save again).
STATE=freedos.state
[ -f "$STATE" ] && [ "$IMG" -nt "$STATE" ] && rm -f "$STATE"
rm -f ctl.in ctl.out com1.log
mkfifo ctl.in ctl.out
cat ctl.out >/dev/null &

# -nodefaults: no CD-ROM for the BIOS to probe, no parallel port. COM1 goes
# to a file (AUTOEXEC.BAT's READY), and a second monitor reads ctl.in.
set -- -display curses -nodefaults -vga std -m 4 -no-reboot \
	-accel tcg,thread=single -monitor vc -serial file:com1.log \
	-chardev pipe,id=ctl,path=ctl -mon chardev=ctl,mode=readline \
	-drive file="$IMG",format=raw,if=floppy -boot a
watcher=
if [ -f "$STATE" ]; then
	printf "\n$B%s$N\n" "Resuming FreeDOS at its prompt"
	set -- "$@" -incoming "exec:gzip -dc $STATE"
else
	printf "\n$B%s$N\n" "Booting FreeDOS on qemu-system-i386 (once: later runs resume at the prompt)"
	# At READY: pause, save the machine (HMP's migrate returns when it is
	# written), run on.
	(
		i=0
		until grep -q READY com1.log 2>/dev/null; do
			i=$((i + 1)); [ $i -lt 600 ] || exit 0
			sleep 1
		done
		sleep 1
		printf '%s\n' stop "migrate \"exec:gzip -c > $STATE.tmp && mv $STATE.tmp $STATE\"" cont > ctl.in
	) &
	watcher=$!
fi
printf "$D%s$N\n" "HALT at the A:\\> prompt powers off; Esc then 2 opens qemu's monitor (type quit)."
sleep 1
status=0
qemu-system-i386 "$@" 2>qemu.log || status=$?
[ -n "$watcher" ] && kill "$watcher" 2>/dev/null || true
rm -f ctl.in ctl.out "$STATE.tmp"
clear
if [ $status -ne 0 ]; then
	rm -f "$STATE" # a state qemu could not load is no use
	echo "qemu-system-i386 failed:" >&2
	tail -n 20 qemu.log >&2
	exit 1
fi
printf "$D%s$N\n" "The PC is off. ./dos.sh resumes it at the prompt; rm $IMG $STATE starts from a fresh floppy."
`;

export default {
	id: "dos",
	// Hidden: too slow for the launcher, even stripped (status.md).
	hidden: true,
	title: "FreeDOS",
	desc: "FreeDOS 1.2 booting on a PC emulated by qemu-system-i386, inside the aarch64 Linux in your browser",
	// A floppy disk.
	icon: { svg: '<path fill-rule="evenodd" d="M4 2h13l5 5v13a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm3 1.5v5.5h9V3.5Zm5.5 1h2v3.5h-2ZM5.5 13v7.5h13V13Z"/><path opacity=".55" d="M7.5 15h9v1.2h-9Zm0 2.5h6.5v1.2H7.5Z"/>' },
	colors: ["#2563eb", "#0b1d4d"],
	needs: { net: true },
	community: true,
	files: { "dos.sh": { content: DOS, mode: 0o755 } },
	packages: { alpine: ["qemu-system-i386", "qemu-ui-curses", "mtools"], arch: ["qemu-system-x86", "mtools", "wget"], debian: ["qemu-system-x86", "mtools", "wget"] },
	commands: ["./dos.sh"],
} satisfies TerminalApp;
