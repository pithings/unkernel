// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// sshfs: FUSE in the tab. Rebex's public SFTP test server (test.rebex.net,
// user demo, password password, read only) is mounted at /mnt/rebex by
// sshfs, a FUSE daemon running in the guest, and browsed with ordinary
// tools. Packages from main: sshfs (fuse3, which has fusermount3, plus
// openssh-client and glib) and tree, about 4.3 MB to download, and mc
// (about 1.7 MB more, since it shares glib) to browse the mount after.
// httpdirfs, the other idea (an HTTP directory listing as a file system),
// is not in Alpine v3.24, and rclone's http backend is a
// 37 MB download.
//
// The guest's TCP goes through the page's Wisp server, which lets port 22
// through (checked 2026-11-15 with the default Wisp server). The server's
// host key is accepted on first use into known_hosts in the demo's
// directory, so a key change on Rebex's side does not break the demo.
//
// mount.sh runs as root (sudo ./mount.sh): /mnt is root's, and a root
// mount does not depend on how the image sets up /dev/fuse and fusermount3
// for users. allow_other lets the session's user (tour.sh, mc) read it.
// mount.sh is idempotent: a live mount is kept, and a stale one (its sshfs
// gone, e.g. after a snapshot restore reset the connection) is unmounted
// first. sshfs forks into the background once the mount is up, so the
// mount stays after run.sh ends; -o reconnect redials if the connection
// drops (the password, read once from stdin, is kept by sshfs). tour.sh
// lists the mount, reads a file, and reads only the 24-byte header of each
// PNG to print its size, which shows FUSE's partial reads.
import type { TerminalApp } from "../types.ts";

const ABOUT = `sshfs: a remote SFTP server, mounted as a file system in your browser

  ls, cat, tree, mc   ordinary programs make ordinary system calls
  fuse                Linux's FUSE driver (CONFIG_FUSE_FS) passes the calls
                      on /mnt/rebex to a program in user space, via /dev/fuse
  sshfs               that program: a FUSE daemon, running in your browser,
                      answering each request with SFTP over SSH
  the network         the guest's TCP leaves the tab through the page's Wisp
                      connection (a WebSocket) to test.rebex.net, port 22

The server is Rebex's public test server: user demo, password password,
read only.
`;

const MOUNT_SH = String.raw`#!/bin/sh
# Mounts Rebex's public SFTP test server at /mnt/rebex with sshfs, unless it
# is mounted already. Run it as root (sudo ./mount.sh); allow_other lets
# other users read the mount. sshfs forks into the background once the
# mount is up; sudo umount /mnt/rebex unmounts it and stops it.
set -e
cd "$(dirname "$0")"
MNT=/mnt/rebex
if grep -qs " $MNT fuse" /proc/mounts; then
	if timeout 20 ls "$MNT" >/dev/null 2>&1; then
		echo "$MNT is mounted already."
		exit 0
	fi
	echo "$MNT is mounted but does not answer (its sshfs is gone): unmounting it."
	fusermount3 -u "$MNT" 2>/dev/null || umount -l "$MNT"
fi
mkdir -p "$MNT"
echo "Connecting to test.rebex.net:22 as demo..."
echo password | sshfs demo@test.rebex.net:/ "$MNT" \
	-o password_stdin,ro,reconnect,allow_other \
	-o ServerAliveInterval=15,ServerAliveCountMax=3 \
	-o StrictHostKeyChecking=accept-new,UserKnownHostsFile="$PWD/known_hosts"
grep " $MNT " /proc/mounts
`;

const TOUR_SH = String.raw`#!/bin/sh
# A look around the mount: every read below is a FUSE request answered by
# sshfs over the network.
cd /mnt/rebex
step() { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }

step "ls -la: one SFTP directory listing"
time ls -la --color=always

step "tree: the whole server"
tree -C -s --dirsfirst

step "cat readme.txt"
time cat readme.txt

step "PNG sizes, reading only the 24-byte header of each file"
for f in pub/example/*.png; do
	set -- $(od -An -tu1 -j16 -N8 "$f")
	printf '  %-28s %5d x %-5d %7d bytes\n' "$(basename "$f")" \
		$((($1 << 24) | ($2 << 16) | ($3 << 8) | $4)) \
		$((($5 << 24) | ($6 << 16) | ($7 << 8) | $8)) "$(stat -c %s "$f")"
done

step "Writing fails: the server and the mount are read only"
touch hello.txt 2>&1 || true

printf '\n\033[1mThe mount stays after this script ends. Try:\033[0m\n'
cat <<'EOF'
  cd /mnt/rebex                 and look around with ls, cat, od
  mc /mnt/rebex                 Midnight Commander on the mount (F3 views, F10 quits)
  cp -r /mnt/rebex/pub /tmp     copy it to the guest
  sudo umount /mnt/rebex        unmount (./run.sh mounts it again)
EOF
`;

export default {
	id: "sshfs",
	title: "sshfs (FUSE)",
	desc: "Mount a public SFTP server as a file system with FUSE and browse it",
	// A folder on a network.
	icon: { svg: '<path d="M2 5.5A2.5 2.5 0 0 1 4.5 3h4.2l2.3 2.3h8.5A2.5 2.5 0 0 1 22 7.8V13a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 13Z"/><path d="M11.1 15.5h1.8v2.6h-1.8ZM2 19.3h7.5v1.6H2Zm12.5 0H22v1.6h-7.5Z"/><rect x="9.6" y="17.6" width="4.8" height="4.4" rx="1"/>' },
	colors: ["#2dd4bf", "#3730a3"],
	needs: { net: true },
	files: {
		"ABOUT": ABOUT,
		"mount.sh": { content: MOUNT_SH, mode: 0o755 },
		"tour.sh": { content: TOUR_SH, mode: 0o755 },
	},
	packages: { alpine: ["sshfs", "tree", "mc"], arch: ["sshfs", "tree", "mc"], debian: ["sshfs", "tree", "mc"] },
	commands: [
		"cat ABOUT",
		"$SUDO ./mount.sh",
		"./tour.sh",
	],
} satisfies TerminalApp;
