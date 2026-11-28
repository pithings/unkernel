// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Radio: SomaFM's listener-supported internet radio played by mpg123 on the
// guest's sound card. Alpine's aarch64 mpg123 from main pulls in
// mpg123-libs and alsa-lib (about 0.8 MB to download). It has the ALSA and
// OSS output modules built in (no separate subpackage), and both play on
// kwsnd; radio.sh uses ALSA, the card's own interface (OSS is the kernel's
// emulation on top of it).
//
// SomaFM's MP3 streams are 128 kbit/s, 44.1 kHz stereo; everything lower is
// AAC, which mpg123 does not decode. That is cheap enough as it is: under
// the JIT, mpg123 takes about 5% of the guest's CPU and the whole emulator
// about 6% of a host core (riscv64 guest, CLI over Wisp, 2026-11-15), so there
// is no --mono or -2 downsampling; on the aarch64 guest Groove Salad
// started about 1 s after it was picked and played with no underrun (CLI,
// 2026-11-18). Each
// station is SomaFM's plain-http playlist (somafm.com/nossl/<id>.pls), the
// link SomaFM asks players to use since it does not change. radio.sh fetches
// it with wget, since mpg123 -@ exits 0 when the playlist cannot be had, and
// hands mpg123 its three servers: mpg123 plays the next when one fails or
// drops, and --timeout gives up on one that stops sending. There is no -b:
// with mpg123's buffer process, pausing ends playback with "Deep trouble!
// Cannot flush to my output anymore" (an interrupted write to the card is
// taken as an error), on ALSA and OSS alike.
//
// Pausing (space) stops mpg123 reading, but the server keeps sending in real
// time and the page's Wisp client buffers what the guest does not take
// (16 KB/s), so radio.sh says to quit with q for a longer break. The
// INT trap (a handler, reset in children) makes Ctrl-C stop mpg123 and come
// back to the menu; at the menu Ctrl-C, 0 or q leaves.
import type { TerminalApp } from "../types.ts";

const RADIO = String.raw`#!/bin/sh
# Internet radio from SomaFM (somafm.com): listener-supported, commercial-free
# stations from San Francisco, played by mpg123 on the sound card. Add a
# station as a line below: SomaFM's channel id, then its name.
STATIONS='groovesalad Groove Salad: a nicely chilled plate of ambient and downtempo beats
dronezone Drone Zone: atmospheric textures with minimal beats
spacestation Space Station Soma: tune in, turn on, space out
secretagent Secret Agent: the soundtrack for your stylish, mysterious, dangerous life
defcon DEF CON Radio: music for hacking
u80s Underground 80s: UK synthpop and a bit of new wave'

trap : INT
B='\033[1m' D='\033[90m' N='\033[0m'
count=$(printf '%s\n' "$STATIONS" | wc -l)

menu() {
	printf "\n$B%s$N\n" "SomaFM internet radio"
	printf "$D%s$N\n" "Commercial-free, listener-supported radio from San Francisco: somafm.com." \
		"If you enjoy it, SomaFM lives on donations: somafm.com/support"
	printf '%s\n' "$STATIONS" | while read -r id name; do
		i=$((${"$"}{i:-0} + 1))
		printf "  $B%d$N  %s\n" "$i" "$name"
	done
	printf "  $B%s$N  %s\n" 0 "quit"
}

fail() {
	printf "\n%s\n" "$1"
	printf "$D%s$N" "Press Enter for the menu."
	read -r _ || true
}

play() {
	id=$1 name=$2
	printf "\n$B%s$N\n" "$name"
	# The station's playlist names its servers (one stream URL per FileN= line).
	urls=$(wget -q -T 15 -O - "http://somafm.com/nossl/$id.pls" | tr -d '\r' | sed -n 's/^File[0-9]*=//p')
	if [ -z "$urls" ]; then
		fail "Could not get the station's playlist from somafm.com (is the network up?)."
		return
	fi
	printf "$D%s$N\n" "space pauses (for a longer break, quit: the stream keeps arriving while paused)," \
		"+ and - set the volume, q goes back to the menu."
	# -C: keys. The servers in order: mpg123 plays the next when one fails or
	# drops, --timeout being how long it waits for data.
	# shellcheck disable=SC2086
	mpg123 -C -o alsa --timeout 15 $urls || fail "$name stopped: no server answered, or the stream broke off."
}

while :; do
	menu
	printf 'Station (1-%d, 0 quits): ' "$count"
	read -r n || { echo; exit 0; }
	case $n in
	0 | q | Q) exit 0 ;;
	"") continue ;;
	*[!0-9]*) echo "Pick a number from the list." ;;
	*)
		line=$(printf '%s\n' "$STATIONS" | sed -n "${"$"}{n}p" 2>/dev/null)
		if [ -z "$line" ] || [ "$n" -lt 1 ]; then
			echo "Pick a number from 1 to $count."
		else
			play "${"$"}{line%% *}" "${"$"}{line#* }"
		fi
		;;
	esac
done
`;

export default {
	id: "radio",
	title: "Radio",
	desc: "SomaFM internet radio (Groove Salad, Drone Zone, DEF CON Radio...) played by mpg123 on the guest's sound card",
	// A transistor radio: antenna, speaker and dial.
	icon: { svg: '<path d="M6.5 8 17.8 2.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path fill-rule="evenodd" d="M4.5 8h15A2.5 2.5 0 0 1 22 10.5v8a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 18.5v-8A2.5 2.5 0 0 1 4.5 8Zm3.8 2.6a3.9 3.9 0 1 0 0 7.8 3.9 3.9 0 0 0 0-7.8Zm0 2.4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm5.4-1.6h5.8v1.5h-5.8Zm0 3h5.8v1.5h-5.8Z"/>' },
	colors: ["#f59e0b", "#9f1239"],
	needs: { net: true, sound: true },
	files: { "radio.sh": { content: RADIO, mode: 0o755 } },
	packages: { alpine: ["mpg123"], arch: ["mpg123", "wget"], debian: ["mpg123", "wget"] },
	commands: ["./radio.sh"],
} satisfies TerminalApp;
