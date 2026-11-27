#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# The Debian distro image: vendor/build/distro/debian.erofs and debian.ext4
# (guest/lib/image.sh), the read-only root that the base initramfs mounts
# under the root overlay: the debian:trixie-slim arm64 root file system,
# Debian's own builds, with apt and debconf set up for a slow CPU and
# nobody at the prompt, and a bash PID 1. The kw guest tools and the
# runtime its init calls (/usr/lib/kw/: mounts, network by DHCP, welcome,
# shutdown) come from the base's kw layer. No pre-overlay hook. The files
# unkernel adds are in rootfs/, at their installed paths
# (guest/lib/stage.sh: install_tree).
#
#   /sbin/init                -> /usr/local/sbin/kw-init (bash; Debian's
#                             /sbin is a link to /usr/sbin): the kw layer's
#                             rc, welcome and net, a login shell on hvc0 and
#                             kwtty serve (respawned); poweroff, halt and
#                             reboot in /usr/local/sbin signal it, and it
#                             runs the layer's shutdown, then reboot(2);
#                             services: sysv-rc's runlevels 2, then 0 or 6
#                             (/usr/sbin/runlevel; no policy-rc.d)
#   /usr/lib/kw-distro        "debian"
#   /usr/lib/kw-image         debian-<version>-<hash of the tree>
#   /var/lib/apt/lists        the package lists of the image's date, as
#                             apt-get update would leave them (pinned)
#   /var/cache/apt/srcpkgcache.bin  apt's source cache of those lists, made
#                             by the image's apt at build time (needs the
#                             base bundle and node; else left out)
#   curl, wget, ca-certificates, unzip, procps, less, vim-tiny, xz-utils, zstd,
#   iproute2, htop, tmux, sudo, libatomic1, sysv-rc, dbus-daemon installed
#                             (DEBIAN_PACKAGES, below; needs the same)
#   /usr/lib/kw-commands      "NAME PACKAGE" per command of main, for
#                             kw-apt-install (command not found:
#                             etc/profile.d/kw-apt.sh; tools/commands.py)
#   /usr/local/bin/docker     the docker shim: installs docker.io, docker-cli
#                             and crun on first use, writes daemon.json for
#                             this kernel, starts the service, defaults to
#                             --network host; its runtime is
#                             /usr/local/libexec/kw-docker-runtime (crun
#                             without a device cgroup)
#   /usr/local/libexec/kw-binfmt  binfmt_misc's interpreter for x86_64 and
#                             i386 binaries (box64), which kw-init
#                             registers; installs box64 on first use
#   /usr/lib/kw/wlandr        wland's relay, a release binary pinned in
#                             pins.sh, which the kw layer's bin/wland starts
#                             (Wayland apps as windows in the page)
#   /usr/lib/kw/xwayland-satellite  rootless Xwayland for wland (Fedora's
#                             build, pinned in pins.sh), which the relay
#                             starts for the first X client
#   user                      the default user of the console and kwtty
#                             sessions (uid 1000, bash, /home/user with
#                             /etc/skel's files and the README), in sudo,
#                             audio, video, input (a group the build adds:
#                             udev would) and users; sudo without a password
#                             (/etc/sudoers.d/kw-user). /etc/skel/.bashrc
#                             leaves the prompt to kw-prompt.sh, and
#                             /etc/bash.bashrc sources /usr/lib/kw/shrc, so
#                             that every interactive shell gets the kw
#                             profile files, not only login shells
#
# The tree is the tarball's in full: glibc's gconv modules (19 MiB, which an
# initramfs would keep resident) and dpkg's and debconf's -old backups stay. An image is paged in on demand, so
# they cost no RAM, and their share of the download is small: 2.1 of the
# erofs image's 25.0 MiB, 1.3 of 18.8 MiB for the ext4 image with zstd -19
# without the package lists and the cache (2026-11-19); with them the erofs
# image is 56.9 MiB (lists 15.6, cache 16.3), the ext4 one 45.5 MiB with
# zstd -19. Booting to the prompt reads neither (4 MiB of the erofs image
# over HTTP, laid out in front by guest/lib/image.sh); the cache is part of
# the warm set fetched after the boot (below). iconv to other charsets works as on Debian.
# DEBIAN_TARBALL=file overrides the pinned image (pins.sh);
# KW_DEBIAN_APT_CACHE=0 leaves the cache out (no boot at build time).
# KW_WLANDR=<file>: a local static aarch64 wlandr (e.g. a wland checkout's
# zig-out/release/wlandr-link-linux-arm64) instead of the pinned release's,
# for development against an unreleased wland (.agents/web.md, Wayland
# desktop); refused with KW_RELEASE=1.
set -euo pipefail

. "$(dirname "$0")/../../lib/env.sh"   # root, build, guest, dl, base_bundle, fetch_verified
. "$guest/lib/stage.sh"                # distro_unpack, install_tree, install_common
. "$guest/lib/image.sh"                # distro_images, distro_out
. "$guest/distro/debian/pins.sh"       # DEBIAN_*, WLANDR_*, XWS_*
umask 022
here="$guest/distro/debian"

distro_unpack debian DEBIAN   # $stage, $DEBIAN_TARBALL

# apt (no recommends, no pdiffs, no pty: rootfs/etc/apt/apt.conf.d/90kw,
# installed below) and debconf: it asks nothing (DEBIAN_FRONTEND=
# noninteractive for every program, also those kwtty starts without a
# shell), set in its database, not /etc/debconf.conf (a conffile).
sed -i '/^Name: debconf\/frontend$/,/^$/ s/^Value: .*/Value: Noninteractive/' "$stage/var/cache/debconf/config.dat"
grep -q '^Value: Noninteractive$' "$stage/var/cache/debconf/config.dat" ||
	{ echo "debian: could not set debconf/frontend" >&2; exit 1; }

# --- apt: package lists and source cache -----------------------------------------
# apt's source cache (/var/cache/apt/srcpkgcache.bin, the parsed package
# lists) on: the image's docker-clean turns both binary caches off and
# deletes them after every dpkg run and update, so that every apt command
# parses all package lists again (12 s here). The image comes with
# srcpkgcache.bin (below). The other cache, pkgcache.bin (the same plus
# dpkg's status), stays off: apt makes it in memory from srcpkgcache.bin
# each time, which costs 0.11 s (apt-cache policy bash 0.23 instead of 0.12
# s, apt-get install -s htop 7.7 s either way), where on disk it would be
# another 45 MB (15 MiB compressed) in the image, rewritten into the upper
# layer (RAM without a data disk) after every dpkg run (2026-11-19). The
# Post-Invoke hooks keep deleting downloaded .deb files. Exact lines, so that
# a change upstream fails the build instead of going unnoticed.
python3 -I - "$stage/etc/apt/apt.conf.d/docker-clean" <<'EOF'
import sys
f = sys.argv[1]
bins = " /var/cache/apt/*.bin"
hooks = [f'{k} {{ "rm -f /var/cache/apt/archives/*.deb /var/cache/apt/archives/partial/*.deb{bins} || true"; }};'
         for k in ("DPkg::Post-Invoke", "APT::Update::Post-Invoke")]
off = ['Dir::Cache::pkgcache "";', 'Dir::Cache::srcpkgcache "";']
lines = open(f).read().split("\n")
for l in hooks + off:
    if lines.count(l) != 1:
        sys.exit(f"debian: {f}: expected the line {l!r} once (upstream changed it?)")
out = []
for l in lines:
    if l in hooks:
        out.append(l.replace(bins, ""))
    elif l == off[1]:
        out.append("# unkernel: the source cache stays on and")
        out.append("# the image comes with it.")
    else:
        out.append(l)
text = "\n".join(out)
if ".bin" in text or "srcpkgcache" in text or text.count("Dir::Cache") != 1:
    sys.exit(f"debian: {f}: the edit went wrong")
open(f, "w").write(text)
EOF

# The package lists, so that apt can install without an apt-get update first:
# main/binary-arm64 of the image's three suites as snapshot.debian.org has
# them at the image's date (DEBIAN_LISTS in pins.sh, SHA-256 pinned),
# stored as apt stores what it fetches from the deb.debian.org URIs of
# debian.sources: InRelease as is, Packages decompressed and verified against
# InRelease, then lz4 as apt writes it (apt-lz4.c), root:root 0644, with the
# mtime apt sets from the server's Last-Modified (mktree.py --keep-mtime
# keeps it). A later apt-get update sees them as its own: Hit for an
# unchanged suite, a normal replacement otherwise.
grep -qxF "# http://snapshot.debian.org/archive/debian/$DEBIAN_LISTS_SNAPSHOT" "$stage/etc/apt/sources.list.d/debian.sources" &&
	grep -qxF "# http://snapshot.debian.org/archive/debian-security/$DEBIAN_LISTS_SNAPSHOT" "$stage/etc/apt/sources.list.d/debian.sources" ||
	{ echo "debian: debian.sources does not name the snapshot $DEBIAN_LISTS_SNAPSHOT (DEBIAN_LISTS_SNAPSHOT in pins.sh)" >&2; exit 1; }
lz4=$("$here/tools/apt-lz4.sh")
lists="$stage/var/lib/apt/lists"
keyring="$stage/usr/share/keyrings/debian-archive-keyring.pgp"
command -v gpgv >/dev/null || echo "debian: no gpgv on this host: the InRelease files are checked by their pinned SHA-256 only" >&2
while read -r archive suite path sum mtime; do
	[ -n "$archive" ] || continue
	file="$dl/debian-lists/$DEBIAN_LISTS_SNAPSHOT/$archive/$suite/$path"
	fetch_verified "https://snapshot.debian.org/archive/$archive/$DEBIAN_LISTS_SNAPSHOT/dists/$suite/$path" "$file" "$sum"
	name="deb.debian.org_${archive}_dists_${suite}_${path//\//_}"
	case $path in
	InRelease)
		if command -v gpgv >/dev/null; then
			gpgv --keyring "$keyring" "$file" 2>/dev/null ||
				{ echo "debian: $file: no good signature by $keyring" >&2; exit 1; }
		fi
		cp "$file" "$lists/$name"
		release="$lists/$name"
		;;
	*.xz)
		# What InRelease (the one just before it) says of the uncompressed file.
		read -r want size < <(awk -v p="${path%.xz}" '/^[^ ]/ { s = ($1 == "SHA256:") } s && $3 == p { print $1, $2 }' "$release")
		xz -dc "$file" > "$file.plain"
		[ "$(sha256sum < "$file.plain" | cut -d' ' -f1)" = "${want:-}" ] && [ "$(stat -c %s "$file.plain")" = "${size:-}" ] ||
			{ echo "debian: $file does not match ${path%.xz} in $release" >&2; exit 1; }
		name="${name%.xz}.lz4"
		"$lz4" < "$file.plain" > "$lists/$name"
		rm -f "$file.plain"
		;;
	*) echo "debian: DEBIAN_LISTS: $path: InRelease or *.xz only" >&2; exit 1 ;;
	esac
	touch -d "@$mtime" "$lists/$name"
done <<< "$DEBIAN_LISTS"

# --- command not found: the command -> package map ----------------------------
# /usr/lib/kw-commands for kw-apt-install (rootfs/usr/local/sbin), from
# trixie main's Contents files at the same snapshot (DEBIAN_CONTENTS in
# pins.sh), limited to the packages of its Packages list (tools/commands.py).
# 1.1 MiB, ~0.3 MiB in the erofs image (2026-11-19).
contents=()
while read -r path sum; do
	[ -n "$path" ] || continue
	file="$dl/debian-lists/$DEBIAN_LISTS_SNAPSHOT/debian/trixie/$path"
	fetch_verified "https://snapshot.debian.org/archive/debian/$DEBIAN_LISTS_SNAPSHOT/dists/trixie/$path" "$file" "$sum"
	contents+=("$file")
done <<< "$DEBIAN_CONTENTS"
python3 -I "$here/tools/commands.py" \
	<(xz -dc "$dl/debian-lists/$DEBIAN_LISTS_SNAPSHOT/debian/trixie/main/binary-arm64/Packages.xz") \
	"${contents[@]}" > "$stage/usr/lib/kw-commands"
grep -qx 'rg ripgrep' "$stage/usr/lib/kw-commands" ||
	{ echo "debian: /usr/lib/kw-commands has no rg -> ripgrep" >&2; exit 1; }

# --- boot ---------------------------------------------------------------------
# The hostname (the kw layer's rc sets it from /etc/hostname); DNS comes
# with the DHCP lease (/usr/lib/kw/udhcpc writes /etc/resolv.conf).
echo unkernel > "$stage/etc/hostname"
printf '127.0.0.1\tlocalhost\n127.0.1.1\tunkernel\n::1\tlocalhost ip6-localhost ip6-loopback\n' > "$stage/etc/hosts"

# /sbin/init -> /usr/local/sbin/kw-init (rootfs/usr/sbin/init), poweroff,
# halt and reboot for it, and the shell's prompt.
[ -L "$stage/sbin" ] && [ ! -e "$stage/usr/sbin/init" ] && [ ! -L "$stage/usr/sbin/init" ] ||
	{ echo "debian: expected /sbin -> usr/sbin and no /usr/sbin/init" >&2; exit 1; }
install_tree "$here/rootfs" "$stage"
chmod 440 "$stage/etc/sudoers.d/kw-user"
install_common "$stage"
# wland's relay (pins.sh), for the kw layer's /usr/lib/kw/bin/wland: Wayland
# apps as windows in the page. The layer has no /usr/lib/kw/wlandr, so this
# one shows through its /usr/lib/kw in the merged root.
mkdir -p "$stage/usr/lib/kw"
if [ -n "${KW_WLANDR:-}" ]; then
	[ "${KW_RELEASE:-}" != 1 ] || { echo "KW_WLANDR is for development: a release carries the pinned relay (pins.sh)" >&2; exit 1; }
	[ -f "$KW_WLANDR" ] || { echo "KW_WLANDR=$KW_WLANDR: no such file" >&2; exit 1; }
	echo "debian: wlandr from KW_WLANDR=$KW_WLANDR (not the pinned $WLANDR_VERSION)" >&2
	cp "$KW_WLANDR" "$stage/usr/lib/kw/wlandr"
else
	fetch_verified "$WLANDR_URL" "$dl/$WLANDR_TARBALL" "$WLANDR_SHA256"
	tar -xzf "$dl/$WLANDR_TARBALL" -O wlandr > "$stage/usr/lib/kw/wlandr"
fi
chmod 755 "$stage/usr/lib/kw/wlandr"
# xwayland-satellite (pins.sh), out of Fedora's RPM: X apps as windows in
# the page, through the relay.
fetch_verified "$XWS_URL" "$dl/$XWS_RPM" "$XWS_SHA256"
python3 -I "$here/tools/rpmfile.py" "$dl/$XWS_RPM" ./usr/bin/xwayland-satellite > "$stage/usr/lib/kw/xwayland-satellite"
chmod 755 "$stage/usr/lib/kw/xwayland-satellite"

# --- in the image: apt's source cache, the baked packages ----------------------------
# The packages the image comes with, on top of the tarball's (with their
# dependencies, no recommends). Adding one is adding its name here.
# libatomic1: the official Node.js build links it (the kw layer's node shim).
# sysv-rc (with insserv and startpar): the service runner kw-init drives
# (below, and rootfs/usr/local/sbin/kw-init).
# dbus-daemon: session buses for desktop apps (dbus-run-session); nothing
# starts at boot (the system bus is the package dbus).
# libxcb-cursor0, libfontconfig1: xwayland-satellite's libraries (with
# fontconfig's DejaVu fonts, about 7 MiB installed).
DEBIAN_PACKAGES="curl wget ca-certificates unzip procps less vim-tiny xz-utils zstd iproute2 htop tmux sudo libatomic1 sysv-rc dbus-daemon libxcb-cursor0 libfontconfig1"
# Both are made by the image's own programs: the tree as it is at that
# point becomes a first image (erofs, uncompressed), which boots on the
# distroless bundle (guest/tools/vm-run.ts); files come out over exec's
# stdout (--get). Without the bundle the image has neither.
#
# 1. srcpkgcache.bin (apt-cache gencaches). apt checks the cache against the
#    size and mtime of every list (and its own mtime against
#    debian.sources'), and these are the same in the final image: mktree.py
#    gives every file the same metadata from the same tree, and the cache the
#    upstream epoch, the mtime of debian.sources. Without it the first apt
#    command parses the lists (12 s) and writes it to the upper layer.
#    The same boot asks apt for the .deb files the packages need
#    (--print-uris; the closure follows from the pinned lists and tarball).
# 2. The packages. The host fetches those .deb files from
#    snapshot.debian.org, checked against the SHA-256 that the baked (pinned)
#    lists give them, and puts them in /kw-debs of a second image (apt's
#    archive directory for that run; the tarball has no
#    /var/cache/apt/archives), whose apt installs them with --no-download
#    (maintainer scripts included: update-ca-certificates fills
#    /etc/ssl/certs, update-alternatives /etc/alternatives). What the install
#    created or changed in the root overlay's upper layer (ctime after a
#    stamp; not /var/log, ldconfig's aux-cache with its inode numbers, D-Bus's
#    random machine id (kw-init makes one per machine), apt's caches or the
#    .debs) comes out as a tar and goes into the tree, and what
#    it deleted (whiteouts) is deleted there; mktree.py then gives the new
#    files root:root, their modes and the upstream epoch, so a rebuild is
#    identical.
mktree_opts=(--keep-mtime var/lib/apt/lists)
kernel="$base_bundle"
gen=debian-aptgen
genimage() { (KW_DISTRO_FORMATS=erofs KW_EROFS_COMPRESS=none KW_DISTRO_HINT=0 distro_images "$gen" "$stage" "$DEBIAN_TARBALL" "debian-$DEBIAN_VERSION" "${mktree_opts[@]}") >/dev/null; }
if [ ! -f "$kernel" ] || ! command -v node >/dev/null; then
	echo "debian: WARNING: no $kernel (kernel/build.sh base) or no node: the image has no apt cache" \
		"(apt parses the package lists, 12 s, at its first command) and not $DEBIAN_PACKAGES" >&2
else
	script='set -e' gets=()
	if [ "${KW_DEBIAN_APT_CACHE:-1}" = 0 ]; then
		echo "debian: KW_DEBIAN_APT_CACHE=0: no apt cache in the image" >&2
	else
		script+='; apt-cache gencaches; [ ! -e /var/cache/apt/pkgcache.bin ]'
		gets+=(--get /var/cache/apt/srcpkgcache.bin="$distro_out/$gen.srcpkgcache.bin")
	fi
	script+="; apt-get install -qq --print-uris --no-install-recommends $DEBIAN_PACKAGES > /tmp/kw-uris"
	genimage
	node "$guest/tools/vm-run.ts" "$kernel" "$distro_out/$gen.erofs" --timeout 300 \
		"${gets[@]}" --get /tmp/kw-uris="$distro_out/$gen.uris" "$script" ||
		{ echo "debian: apt-cache gencaches or apt-get --print-uris in the image failed" >&2; exit 1; }
	if [ "${KW_DEBIAN_APT_CACHE:-1}" != 0 ]; then
		mv "$distro_out/$gen.srcpkgcache.bin" "$stage/var/cache/apt/srcpkgcache.bin"
		chmod 644 "$stage/var/cache/apt/srcpkgcache.bin"
	fi

	# "ARCHIVE POOL-PATH SHA256" of every package in the baked lists.
	sums="$distro_out/$gen.sums"
	while read -r archive suite path sum mtime; do
		case $path in *Packages.xz) ;; *) continue ;; esac
		xz -dc "$dl/debian-lists/$DEBIAN_LISTS_SNAPSHOT/$archive/$suite/$path" |
			awk -v a="$archive" '/^Filename: / { f = $2 } /^SHA256: / { s = $2 } /^$/ { if (f != "") print a, f, s; f = "" }'
	done <<< "$DEBIAN_LISTS" > "$sums"
	archives="$stage/kw-debs"
	mkdir "$archives"
	n=0
	while read -r url name _; do
		url=${url//\'/}
		rest=${url#http://deb.debian.org/}
		archive=${rest%%/*}
		path=${rest#*/}
		path=${path//%/\\x}; printf -v path '%b' "$path"   # %2b -> +
		sum=$(awk -v a="$archive" -v p="$path" '$1 == a && $2 == p { print $3; exit }' "$sums")
		[ -n "$sum" ] || { echo "debian: $url is in none of the baked package lists" >&2; exit 1; }
		file="$dl/debian-pool/$archive/$path"
		fetch_verified "https://snapshot.debian.org/archive/$archive/$DEBIAN_LISTS_SNAPSHOT/$path" "$file" "$sum"
		cp "$file" "$archives/$name"
		n=$((n + 1))
	done < "$distro_out/$gen.uris"
	echo "debian: installing $DEBIAN_PACKAGES ($n packages) in the image" >&2
	genimage
	u=/run/kw-lower/kw/tmp/upper
	node "$guest/tools/vm-run.ts" "$kernel" "$distro_out/$gen.erofs" --timeout 900 \
		--get /tmp/kw-pkgs.tar="$distro_out/$gen.pkgs.tar" --get /tmp/kw-gone="$distro_out/$gen.gone" "
		set -e
		[ -d $u ]
		touch /tmp/kw-stamp
		apt-get install -y -q --no-download --no-install-recommends -o Dir::Cache::Archives=/kw-debs/ \
			$DEBIAN_PACKAGES > /tmp/kw-log 2>&1 ||
			{ cat /tmp/kw-log; exit 1; }
		[ \"\$(dpkg-query -W -f '\${db:Status-Abbrev}\n' $DEBIAN_PACKAGES | sort -u)\" = 'ii ' ]
		update-rc.d sudo disable >> /tmp/kw-log 2>&1 || { cat /tmp/kw-log; exit 1; }
		cd $u
		find . -mindepth 1 -cnewer /tmp/kw-stamp -type c | sort > /tmp/kw-gone
		find . -mindepth 1 -cnewer /tmp/kw-stamp ! -type c ! -path './var/log/*' \\
			! -path ./var/cache/ldconfig/aux-cache ! -path ./var/lib/dbus/machine-id ! -path './var/cache/apt/*' ! -path './kw-debs*' | sort > /tmp/kw-list
		tar -cf /tmp/kw-pkgs.tar --no-recursion --numeric-owner -T /tmp/kw-list" ||
		{ echo "debian: installing $DEBIAN_PACKAGES in the image failed" >&2; exit 1; }
	rm -rf "$archives"
	while read -r p; do rm -rf "${stage:?}/${p#./}"; done < "$distro_out/$gen.gone"
	tar -xpf "$distro_out/$gen.pkgs.tar" -C "$stage" --no-same-owner
	rm -f "$distro_out/$gen".{erofs,tar,id,uris,sums,pkgs.tar,gone}
fi

# --- services ------------------------------------------------------------------
# Debian's packages enable their init scripts (update-rc.d: insserv's links
# in /etc/rcN.d) and start them (invoke-rc.d), and kw-init runs runlevel 2
# at boot. The image's policy-rc.d (docker's: exit 101, start nothing) goes,
# so that an apt-get install starts its service as on a Debian system; it
# stays for the build's own install above. sudo's script (enabled by the
# build, disabled above) only clears /run/sudo, which is new at every boot.
policy="$stage/usr/sbin/policy-rc.d"
[ ! -e "$policy" ] || { grep -qx 'exit 101' "$policy" && rm "$policy"; } ||
	{ echo "debian: $policy is not docker's exit 101 (upstream changed it?)" >&2; exit 1; }

# --- the user -------------------------------------------------------------------
# After the packages, whose scripts may add system users and groups. The
# group input, which udev's package would add (the kw layer's rc gives it
# the input devices), then the account (guest/lib/stage.sh). The user's
# ~/.bashrc (from /etc/skel) would set Debian's prompt over kw-prompt.sh's
# in every shell: the two exact lines become no-ops, so that a change
# upstream fails the build.
grep -q '^input:' "$stage/etc/group" || {
	! awk -F: '$3 == 101 { f = 1 } END { exit !f }' "$stage/etc/group" ||
		{ echo "debian: gid 101 is taken: pick another for the input group" >&2; exit 1; }
	echo "input:x:101:" >> "$stage/etc/group"
	echo "input:!::" >> "$stage/etc/gshadow"
}
python3 -I - "$stage/etc/skel/.bashrc" <<'EOF'
import sys
f = sys.argv[1]
lines = open(f).read().split("\n")
ps1 = ["    PS1='${debian_chroot:+($debian_chroot)}\\[\\033[01;32m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ '",
       "    PS1='${debian_chroot:+($debian_chroot)}\\u@\\h:\\w\\$ '"]
for l in ps1:
    if lines.count(l) != 1:
        sys.exit(f"debian: {f}: expected the line {l!r} once (upstream changed it?)")
lines = ["    :  # unkernel: the prompt is /etc/profile.d/kw-prompt.sh's" if l in ps1 else l for l in lines]
open(f, "w").write("\n".join(lines))
EOF
printf '\n%s\n%s\n' '# unkernel: the kw profile files in interactive shells that are not login shells too' \
	'[ -r /usr/lib/kw/shrc ] && . /usr/lib/kw/shrc' >> "$stage/etc/bash.bashrc"
# Without sudo (no bundle or node: no packages) every session stays root's.
if [ -x "$stage/usr/bin/sudo" ]; then
	install_user "$stage" /bin/bash sudo audio video input users
	install_readme "$stage" debian NAME=Debian USERLAND="glibc, GNU coreutils, bash" PKG="apt install" \
		MIRROR="Debian's" AUTO=KW_AUTO_APT DISTRO=debian REPO=https://github.com/pithings/unkernel
fi

# The command map without the commands the image has (/usr/local: the
# kw-init's poweroff, halt and reboot).
awk 'NR == FNR { have[$0]; next } !($1 in have)' \
	<(find "$stage/usr/bin" "$stage/usr/sbin" "$stage/usr/local/bin" "$stage/usr/local/sbin" -maxdepth 1 ! -type d -printf '%f\n') \
	"$stage/usr/lib/kw-commands" > "$stage/usr/lib/kw-commands.new"
mv "$stage/usr/lib/kw-commands.new" "$stage/usr/lib/kw-commands"

# The warm set (guest/lib/image.sh): what apt reads offline, fetched in the
# background after the boot: apt's programs and libraries, dpkg's state and
# srcpkgcache.bin (16 MiB of the image), not the package lists (another
# 15.6 MiB, of which apt-cache show reads only up to a package's record).
# Plus apt's http method and dpkg's unpackers, which an install runs and no
# offline trace reaches.
KW_WARM_SCRIPT='apt-cache show bash >/dev/null; apt-cache policy >/dev/null; apt show bash >/dev/null 2>&1; apt-get -s install git >/dev/null; dpkg -l >/dev/null'
KW_WARM_EXCLUDE='var/lib/apt/lists/*'
KW_WARM_FILES='usr/lib/apt/methods/http usr/bin/dpkg-deb usr/bin/dpkg-split'
distro_images debian "$stage" "$DEBIAN_TARBALL" "debian-$DEBIAN_VERSION" "${mktree_opts[@]}" "${user_owner[@]}"
# apt in each final image takes the cache as it is: a new one would have
# been written to the upper layer, with a new mtime.
if [ -f "$stage/var/cache/apt/srcpkgcache.bin" ]; then
	for fmt in $KW_DISTRO_FORMATS; do
		node "$guest/tools/vm-run.ts" "$kernel" "$distro_out/debian.$fmt" --timeout 120 \
			'apt-cache policy bash >/dev/null && c=/var/cache/apt/srcpkgcache.bin &&
			[ "$(stat -c %Y $c)" = "$(stat -c %Y /etc/apt/sources.list.d/debian.sources)" ]' ||
			{ echo "debian: apt in debian.$fmt does not take its srcpkgcache.bin" >&2; exit 1; }
	done
fi
