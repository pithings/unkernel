#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# The Arch Linux ARM distro image: vendor/build/distro/arch.erofs and
# arch.ext4 (guest/lib/image.sh), the read-only root that the base initramfs
# mounts under the root overlay: the generic aarch64 root file system as
# Arch Linux ARM publishes it, minus what a VM never uses (firmware, kernel
# modules, /boot) and docs, man pages and locales, upgraded to the mirror's
# current packages in a boot of the tree, with a bash PID 1 instead of
# systemd. The kw guest tools and the runtime its init calls (/usr/lib/kw/:
# mounts, network by DHCP, welcome, shutdown) come from the base's kw layer.
# No pre-overlay hook. The files unkernel adds are in rootfs/, at their
# installed paths (guest/lib/stage.sh: install_tree).
#
#   /usr/local/sbin/kw-init   PID 1 (the base execs it first): the kw layer's
#                             rc, welcome and net, a login shell on hvc0 and
#                             kwtty serve (respawned); poweroff, halt and
#                             reboot in /usr/local/sbin signal it, and it
#                             runs the layer's shutdown, then reboot(2). No
#                             services: systemd does not run
#   /usr/lib/kw-distro        "arch"
#   /usr/lib/kw-image         arch-<version>-<hash of the tree>
#   packages                  the tarball's, upgraded (pacman -Syu) and
#                             ARCH_PACKAGES added by the image's own pacman in
#                             a boot of the tree on the base bundle
#                             (guest/tools/vm-run.ts; needs node and the
#                             network). The mirror keeps only current
#                             packages, so an image is as current as its build
#                             and not reproducible
#   /var/lib/pacman/sync      the package lists of that build, so that the
#                             first install needs no download of them
#   /usr/lib/kw-commands      "NAME PACKAGE" per command in /usr/bin of the
#                             repositories, for kw-pacman-install (command
#                             not found: etc/profile.d/kw-pacman.sh;
#                             tools/commands.py)
#   user                      the default user of the console and kwtty
#                             sessions (uid 1000, bash, /home/user with
#                             /etc/skel's files and the README), in wheel,
#                             audio, video, input and users; sudo without a
#                             password (/etc/sudoers.d/kw-user). The tarball's
#                             own account "alarm" is removed. /etc/skel/
#                             .bashrc leaves the prompt to kw-prompt.sh, and
#                             /etc/bash.bashrc sources /usr/lib/kw/shrc, so
#                             that every interactive shell gets the kw
#                             profile files, not only login shells
#
# pacman's keyring is made at the first boot (kw-init, in the background, about
# 25 s, 2026-11-28), not shipped: its master key is per machine.
# ARCH_TARBALL=file overrides the pinned tarball (pins.sh); KW_ARCH_MEM=MiB is
# the build VM's memory (default 3072: the upgrade is held in it).
set -euo pipefail

. "$(dirname "$0")/../../lib/env.sh"   # root, build, guest, dl, base_bundle, fetch_verified
. "$guest/lib/stage.sh"                # distro_unpack, install_tree, install_common
. "$guest/lib/image.sh"                # distro_images, distro_out
. "$guest/distro/arch/pins.sh"         # ARCH_*
umask 022
here="$guest/distro/arch"

# What the image has on top of the tarball (Debian's DEBIAN_PACKAGES): sudo,
# the download tools, tmux, htop and vim.
ARCH_PACKAGES="sudo curl wget ca-certificates unzip procps-ng less vim xz zstd iproute2 htop tmux"

distro_unpack arch ARCH   # $stage, $ARCH_TARBALL
# Nothing in a VM reads firmware, kernel modules and /boot, and Debian's image
# has no docs, man pages or locales either. pacman's file lists lose them too
# and NoExtract keeps them out of later installs, else every upgrade warns for
# each file it cannot find (the firmware and kernel packages are removed below).
rm -rf "${stage:?}"/usr/lib/firmware "$stage"/usr/lib/modules "$stage"/boot/* \
	"$stage"/usr/share/{doc,man,info,locale}
find "$stage/var/lib/pacman/local" -name files -exec sed -i -E '\#^usr/share/(doc|man|info|locale)/#d' {} +

# The hostname (the kw layer's rc sets it from /etc/hostname); DNS comes with the
# DHCP lease (/usr/lib/kw/udhcpc writes /etc/resolv.conf: the tarball's is a link
# into /run/systemd, which does not exist here).
echo unkernel > "$stage/etc/hostname"
printf '127.0.0.1\tlocalhost\n127.0.1.1\tunkernel\n::1\tlocalhost ip6-localhost ip6-loopback\n' > "$stage/etc/hosts"
rm -f "$stage/etc/resolv.conf"
: > "$stage/etc/resolv.conf"

# pacman 7 downloads as the sandbox user alpm, which needs Landlock: this kernel
# has none, so every download would fail. Without DownloadUser it runs as root.
dl_line='DownloadUser = alpm'
[ "$(grep -Fxc -- "$dl_line" "$stage/etc/pacman.conf")" = 1 ] ||
	{ echo "arch: /etc/pacman.conf has not the expected DownloadUser line (upstream changed it?)" >&2; exit 1; }
grep -Fxv -- "$dl_line" "$stage/etc/pacman.conf" > "$stage/etc/pacman.conf.kw"
cat "$stage/etc/pacman.conf.kw" > "$stage/etc/pacman.conf"
rm "$stage/etc/pacman.conf.kw"
sed -i '/^\[options\]$/a NoExtract  = usr/share/doc/* usr/share/man/* usr/share/info/* usr/share/locale/*' "$stage/etc/pacman.conf"
grep -q '^NoExtract' "$stage/etc/pacman.conf" || { echo "arch: no [options] in /etc/pacman.conf" >&2; exit 1; }

install_tree "$here/rootfs" "$stage"
chmod 440 "$stage/etc/sudoers.d/kw-user"
install_common "$stage"
echo 'hvc0' >> "$stage/etc/securetty"
# Every interactive shell, not only login shells, gets the kw profile files.
echo '[ -r /usr/lib/kw/shrc ] && . /usr/lib/kw/shrc' >> "$stage/etc/bash.bashrc"

# --- packages --------------------------------------------------------------------
# The image's own pacman, in a boot of the tree (an uncompressed erofs image of
# it, on the base bundle, with the network), once its keyring is made (kw-init):
# the kernel and firmware packages the tarball has go, then pacman -Syu (the
# keyring package first, as Arch says: the new packages may be signed with keys
# the old one does not know) and ARCH_PACKAGES. What that changed in the
# root overlay's upper layer (ctime after a stamp: the files, the directories
# they are in, pacman's database and package lists; deletions as whiteouts; not
# the keyring, the package cache, the logs, the lease's resolv.conf) comes out
# as a tar and goes into the tree; mktree.py then gives the new files root:root
# and the upstream epoch. openssh's hook that marks sshd.service for restart
# needs systemd and fails here: rootfs/etc/pacman.d/hooks masks it.
kernel="$base_bundle"
if [ ! -f "$kernel" ] || ! command -v node >/dev/null; then
	echo "arch: no $kernel (kernel/build.sh base) or no node: the image cannot be upgraded" >&2
	exit 1
fi
gen=arch-pkgsgen
(KW_DISTRO_FORMATS=erofs KW_EROFS_COMPRESS=none KW_DISTRO_HINT=0 distro_images "$gen" "$stage" "$ARCH_TARBALL" "arch-$ARCH_VERSION") >/dev/null
u=/run/kw-lower/kw/tmp/upper
echo "arch: upgrading and installing $ARCH_PACKAGES in the image" >&2
node "$guest/tools/vm-run.ts" "$kernel" "$distro_out/$gen.erofs" --net --mem "${KW_ARCH_MEM:-3072}" --timeout 3000 \
	--get /tmp/kw-pkgs.tar="$distro_out/$gen.pkgs.tar" --get /tmp/kw-gone="$distro_out/$gen.gone" "
	set -e
	[ -d $u ]
	n=0
	until [ -e /etc/pacman.d/gnupg/.kw-keys ]; do
		n=\$((n + 1)); [ \$n -le 300 ] || { echo 'no keyring'; exit 1; }; sleep 1
	done
	touch /tmp/kw-stamp
	pacman -Qq | grep -E '^(linux-aarch64|linux-firmware|uboot-)' | xargs -r pacman -Rdd --noconfirm
	pacman -Sy --noconfirm
	pacman -S --needed --noconfirm archlinuxarm-keyring
	pacman-key --populate archlinuxarm
	pacman -Su --noconfirm
	pacman -S --needed --noconfirm $ARCH_PACKAGES
	cd $u
	find . -mindepth 1 -cnewer /tmp/kw-stamp -type c | sort > /tmp/kw-gone
	find . -mindepth 1 -cnewer /tmp/kw-stamp ! -type c ! -path './var/log/*' ! -path './var/cache/pacman/*' \\
		! -path './etc/pacman.d/gnupg*' ! -path ./var/lib/pacman/db.lck ! -path ./var/cache/ldconfig/aux-cache \\
		! -path ./etc/resolv.conf ! -path './root/*' ! -path ./root ! -path './tmp/*' ! -path './run/*' | sort > /tmp/kw-list
	tar -cf /tmp/kw-pkgs.tar --no-recursion --numeric-owner -T /tmp/kw-list" ||
	{ echo "arch: upgrading the image failed" >&2; exit 1; }
while read -r p; do rm -rf "${stage:?}/${p#./}"; done < "$distro_out/$gen.gone"
tar -xpf "$distro_out/$gen.pkgs.tar" -C "$stage" --no-same-owner --delay-directory-restore
# A package mode the owner cannot read (dbus-daemon-launch-helper: 4710) would stop
# mktree.py, which reads every file; the image keeps the upstream tarball's mode
# for a path it has, and this one only for new paths.
find "$stage" -type d ! -perm -u=rwx -exec chmod u+rwx {} +
find "$stage" -type f ! -perm -u=r -exec chmod u+r {} +
rm -f "$distro_out/$gen".{erofs,tar,id,pkgs.tar,gone}
[ -x "$stage/usr/bin/sudo" ] && [ -u "$stage/usr/bin/sudo" ] ||
	{ echo "arch: no setuid sudo in the image after the upgrade" >&2; exit 1; }

# --- the command map --------------------------------------------------------------
# What kw-pacman-install installs for a missing command: the repositories' file
# lists (what pacman -Fy fetches: 47 MB, not worth a download at a typo).
mkdir -p "$dl/arch-files"
for r in core extra alarm; do
	curl -fsSL -o "$dl/arch-files/$r.files" "$ARCH_MIRROR/$r/$r.files"
done
python3 -I "$here/tools/commands.py" "$dl/arch-files"/{core,extra,alarm}.files > "$stage/usr/lib/kw-commands"
grep -qx 'rg ripgrep' "$stage/usr/lib/kw-commands" ||
	{ echo "arch: /usr/lib/kw-commands has no rg -> ripgrep" >&2; exit 1; }

# --- the user ----------------------------------------------------------------------
# After the packages, whose scripts may add system users and groups. The
# tarball's own account "alarm" (uid 1000, with a published password) goes, and
# root's published password is locked, as in the Debian and Alpine images (the
# user has sudo). /etc/skel/.bashrc would set Arch's prompt over kw-prompt.sh's:
# its line goes.
sed -i '/^alarm:/d' "$stage"/etc/{passwd,shadow,group,gshadow,subuid,subgid}
sed -i 's/^root:[^:]*:/root:*:/' "$stage/etc/shadow"
grep -q '^root:\*:' "$stage/etc/shadow" || { echo "arch: root's password is not locked" >&2; exit 1; }
sed -i 's/^\(wheel:.*\):alarm$/\1:/' "$stage/etc/group" "$stage/etc/gshadow"
rm -rf "${stage:?}/home/alarm"
grep -q alarm "$stage"/etc/{passwd,shadow,group,gshadow,subuid,subgid} && { echo "arch: alarm is still in the account files" >&2; exit 1; }
ps1='PS1='"'"'[\u@\h \W]\$ '"'"
[ "$(grep -Fxc -- "$ps1" "$stage/etc/skel/.bashrc")" = 1 ] ||
	{ echo "arch: /etc/skel/.bashrc has not the expected PS1 line (upstream changed it?)" >&2; exit 1; }
grep -Fxv -- "$ps1" "$stage/etc/skel/.bashrc" > "$stage/etc/skel/.bashrc.kw"
cat "$stage/etc/skel/.bashrc.kw" > "$stage/etc/skel/.bashrc"
rm "$stage/etc/skel/.bashrc.kw"
install_user "$stage" /bin/bash wheel audio video input users
install_readme "$stage" arch NAME="Arch Linux ARM" USERLAND="glibc, GNU coreutils, bash" PKG="pacman -S" \
	MIRROR="Arch Linux ARM's" AUTO=KW_AUTO_PACMAN DISTRO=arch REPO=https://github.com/pithings/unkernel

distro_images arch "$stage" "$ARCH_TARBALL" "arch-$ARCH_VERSION" "${user_owner[@]}"
