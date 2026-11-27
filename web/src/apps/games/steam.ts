// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Steam: Valve's native aarch64 Linux client (the Steam Frame's, which Valve
// does not support on other ARM machines), its windows on the page's Wayland
// desktop through Xwayland and xwayland-satellite (xwl.ts; Debian): the
// client's UI links libX11 and GTK 2 and exits without an X display. Valve's
// launcher (bin_steam.sh) knows only the x86 bootstrap, so steam.sh does its
// job: it takes the client binary (steamrtarm64/steam, which links only
// glibc) out of the bins_linuxarm64_linuxarm64 package that Valve's
// steam_client_linuxarm64 manifest names, checked against the manifest's
// SHA-256, makes the ~/.steam links the client asks for, and starts the
// client again when it exits with 42 (it updated itself) or gives up on its
// first update. The client downloads the rest of itself on the first start
// (about 660 MB, into ~/.local/share/Steam). Its games are x86: Steam starts
// them through its FEX tool, which has no x86 root file system here, so
// steam.sh puts a script in place of that tool's FEX that leaves them to
// box64 (FEX_SHIM, below), and adds a compatibility tool that does the same
// (BOX64_TOOL).
import type { TerminalApp } from "../types.ts";
import { XWL_DOWNLOAD, XWL_PACKAGES, XWL_PREP, XWL_SH } from "../xwl.ts";

const README = `Steam: Valve's native arm64 Linux client, as windows on the page's desktop
(X through Xwayland and xwayland-satellite).
Experimental: Valve supports this client on its own hardware only, and its
games are x86 (below).

The first start downloads the client (110 MB, then about 660 MB that the
client fetches itself into ~/.local/share/Steam: have 2 GiB free on the disk)
and unpacks it for a few minutes; then it restarts and shows the sign-in
window. When that download gives up part way ("Steam needs to be online to
update"), steam.sh starts the client again, which goes on from there.
It is slow: the UI is a Chromium on an emulated CPU.

  ./xwl.sh ./steam.sh            start it (arguments go to the client)
  rm -rf ~/.local/share/Steam    start over from the download

Games are x86. Steam starts them through its FEX tool, which fails here (no
x86 root file system), so steam.sh replaces that tool's FEX with a script
that runs the game as it is, on box64 (untried; 32-bit games are box64's
weak side). The tool comes with the first game you start: that start fails,
and the replacement is made the next time Steam is started here. The
commands it ran are in /tmp/kw-fex-shim.log. Steam also lists "box64
(binfmt)" under a game's Properties, Compatibility, if it takes custom tools.

For feedback, what to look at and send:
  steam.log                                 the client's output of the last run
  ~/.steam/steam/logs/steamwebhelper.log    the UI's Chromium
  the xwayland-satellite log xwl.sh names when it starts
Ctrl-C in this terminal stops Steam and X.
`;

const STEAM_SH = `#!/bin/sh
# Start Valve's arm64 Steam client on the X display xwl.sh made: fetch the
# client binary on the first run, keep the ~/.steam links it asks for, and
# start it again whenever it exits with 42 (it updated itself).
set -e
[ "$(id -u)" != 0 ] || { echo "Steam does not run as root"; exit 1; }
here=$(pwd)
R=\${XDG_DATA_HOME:-$HOME/.local/share}/Steam
CDN=https://client-update.steamstatic.com
if [ ! -x "$R/steamrtarm64/steam" ]; then
	# The package's name changes with every client release: take it and its
	# SHA-256 from the manifest.
	echo "Reading $CDN/steam_client_linuxarm64"
	fh=$(curl -fsSL "$CDN/steam_client_linuxarm64" | awk -F'"' '
		$2 == "bins_linuxarm64_linuxarm64" { p = 1 }
		p && $2 == "file" { f = $4 }
		p && $2 == "sha2" { print f, $4; exit }')
	f=\${fh% *} h=\${fh#* }
	[ -n "$f" ] && [ "$f" != "$h" ] || { echo "the manifest names no bins_linuxarm64_linuxarm64 package"; exit 1; }
	echo "Downloading $f (about 110 MB)"
	curl -fL --retry 3 -o "$here/client.zip" "$CDN/$f"
	echo "$h  $here/client.zip" | sha256sum -c -
	mkdir -p "$R"
	unzip -o -q "$here/client.zip" steamrtarm64/steam -d "$R"
	chmod 755 "$R/steamrtarm64" "$R/steamrtarm64/steam"
	rm -f "$here/client.zip"
fi
mkdir -p "$HOME/.steam"
ln -sfn "$R" "$HOME/.steam/steam"
ln -sfn "$R" "$HOME/.steam/root"
ln -sfn "$R/linuxarm64" "$HOME/.steam/sdkarm64"
# What games are started with: the overlay is preloaded from bin32, bin64 and
# bin64/../steamrtarm64 (the client's x86 files are in ubuntu12_32 and
# ubuntu12_64, as on x86, where Valve's steam.sh makes these links).
ln -sfn "$R/ubuntu12_32" "$HOME/.steam/bin32"
ln -sfn "$R/ubuntu12_64" "$HOME/.steam/bin64"
ln -sfn "$R/linux32" "$HOME/.steam/sdk32"
ln -sfn "$R/linux64" "$HOME/.steam/sdk64"
# The box64 compatibility tool (README), where the client looks for such tools.
mkdir -p "$R/compatibilitytools.d/box64"
cp -p "$here"/box64/* "$R/compatibilitytools.d/box64/"
# Games on box64: Steam's FEX tool (it comes with the first game) starts
# usr/bin/FEX COMMAND...; put ./fex-shim there, which runs the command itself.
# Done again after Steam updated the tool.
fex=$R/steamapps/common/FEX-Emu/usr/bin/FEX
if [ -f "$fex" ] && [ "$(head -c 4 "$fex" | tail -c 3)" = ELF ]; then
	mv "$fex" "$fex.real"
	cp "$here/fex-shim" "$fex"
	chmod 755 "$fex"
	echo "Steam's FEX now hands games to box64 ($fex; the original is FEX.real)"
fi
# The client cannot read a CPU frequency here and says so on every start.
export CPU_MHZ=\${CPU_MHZ:-2000}
# steamwebhelper.sh pins the UI to CPUs 2 to 6 (taskset 0x7c), which fails on
# a machine with fewer than three: ./bin/taskset drops the mask then.
taskset 0x7c true 2>/dev/null || { echo "fewer than 3 CPUs: running the UI unpinned (./bin/taskset)"; PATH=$here/bin:$PATH; export PATH; }
echo "$(nproc) CPUs, $(awk '/MemTotal/ { printf "%d MiB RAM", $2 / 1024 }' /proc/meminfo), $(df -h --output=avail "$R" | tail -n 1 | tr -d ' ') free in $R"
log=$here/steam.log
: >"$log"
tries=0
cd "$R"
while :; do
	{ st=0; "$R/steamrtarm64/steam" "$@" || st=$?; echo $st >"$here/.status"; } 2>&1 | tee -a "$log"
	st=$(cat "$here/.status")
	if [ "$st" = 42 ]; then
		echo "Steam updated itself: starting it again" | tee -a "$log"
	elif [ "$st" != 0 ] && [ ! -e "$R/package/steam_client_linuxarm64.installed" ] && [ $tries -lt 8 ]; then
		# The client gives up on its first update when downloads fail
		# ("Repeatedly failed to download packages"); what it has is kept, so
		# another start goes on from there.
		tries=$((tries + 1))
		echo "Steam ended (status $st) before its first update was done: starting it again ($tries of 8)" | tee -a "$log"
		sleep 3
	else
		break
	fi
done
echo "Steam ended with status $st (the output is in $log)"
exit "$st"
`;

// A Steam Play compatibility tool (compatibilitytools.d) that runs a game's
// command as it is, so that binfmt_misc hands its x86 binary to box64
// (.agents/x64.md) instead of the FEX tool Steam installs, which wants the
// Steam Frame's x86 root file system (/usr/share/guestos/fex-mesa).
const BOX64_TOOL = `"compatibilitytools"
{
	"compat_tools"
	{
		"kw-box64"
		{
			"install_path" "."
			"display_name" "box64 (binfmt)"
			"from_oslist" "linux"
			"to_oslist" "linux"
		}
	}
}
`;

const BOX64_MANIFEST = `"manifest"
{
	"version" "2"
	"commandline" "/run %verb%"
}
`;

const BOX64_RUN = `#!/bin/sh
# run VERB COMMAND...: Steam's verb (run, waitforexitandrun), then the game's
# command, which runs as it is: the kernel starts box64 for an x86 binary.
shift
exec "$@"
`;

// What steam.sh puts in place of the FEX tool's emulator
// (steamapps/common/FEX-Emu/usr/bin/FEX, kept beside it as FEX.real): Steam
// starts every x86 game through that tool, whichever compatibility tool the
// game has, and its FEX has no x86 root file system here.
const FEX_SHIM = `#!/bin/sh
# FEX COMMAND...: in place of Steam's FEX (FEX.real, beside this), run the
# command as it is: the kernel starts box64 for an x86 binary (binfmt_misc).
echo "$(date +%T) $*" >>/tmp/kw-fex-shim.log
exec "$@"
`;

const TASKSET = `#!/bin/sh
# taskset MASK COMMAND...: run COMMAND without pinning it (steam.sh puts this
# first in PATH where the machine lacks the CPUs Steam's mask names).
shift
exec "$@"
`;

export default {
	id: "steam",
	title: "Steam",
	desc: "Valve's native arm64 Steam client (experimental, unsupported by Valve), as windows on the page through Xwayland",
	// Rising steam, three wisps (crafted).
	icon: { svg: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 20c-2-2.5 2-4 0-6.5s2-4 0-6.5"/><path d="M12 21c-2-2.5 2-4.5 0-7s2-4.5 0-7 1-3 0-4"/><path d="M17 20c-2-2.5 2-4 0-6.5s2-4 0-6.5"/></g>' },
	colors: ["#1b2838", "#0b1220"],
	needs: { wayland: true, net: true },
	// The libraries are what the client's aarch64 binaries name as NEEDED and
	// do not bring themselves (steamui.so, steamclient.so, the web helper and
	// its libcef.so; read from Valve's packages on 2026-11-25), less what the
	// image has; apt installs no recommended packages here, so each is named.
	packages: {
		debian: [
			...XWL_PACKAGES, "curl", "unzip", "lsof", "xdg-user-dirs", "fonts-dejavu",
			"libgtk2.0-0t64", "libgdk-pixbuf-2.0-0", "libglib2.0-0t64", "libpango-1.0-0", "libcairo2", "libfreetype6",
			"libatk1.0-0t64", "libatk-bridge2.0-0t64", "libatspi2.0-0t64", "libibus-1.0-5", "libcups2t64", "libnm0", "libnss3", "libnspr4",
			"libx11-6", "libx11-xcb1", "libxcb1", "libxext6", "libxi6", "libxtst6", "libxfixes3", "libxrandr2", "libxrender1", "libxinerama1",
			"libxcomposite1", "libxdamage1", "libxkbcommon0", "libice6", "libsm6",
			"libgl1", "libegl1", "libgbm1", "libdrm2", "libvulkan1", "mesa-vulkan-drivers", "libva2", "libvdpau1",
			"libpipewire-0.3-0t64", "libpulse0", "libasound2t64", "libopenal1", "libsdl2-2.0-0", "libsndfile1", "libasyncns0",
		],
	},
	downloads: [XWL_DOWNLOAD],
	files: {
		README,
		"xwl.sh": { content: XWL_SH, mode: 0o755 },
		"steam.sh": { content: STEAM_SH, mode: 0o755 },
		"bin/taskset": { content: TASKSET, mode: 0o755 },
		"fex-shim": { content: FEX_SHIM, mode: 0o755 },
		"box64/compatibilitytool.vdf": BOX64_TOOL,
		"box64/toolmanifest.vdf": BOX64_MANIFEST,
		"box64/run": { content: BOX64_RUN, mode: 0o755 },
	},
	commands: [
		"cat README",
		XWL_PREP,
		"./xwl.sh ./steam.sh",
	],
} satisfies TerminalApp;
