# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Pinned inputs of the Arch image (build.sh), sourced: the Arch Linux ARM
# generic aarch64 root file system. Upstream publishes only a rolling
# "latest" file (no versioned archive), so this pin fails the checksum
# once upstream replaces it (Last-Modified 2026-08-05 at pinning): re-pin
# ARCH_SHA256 then. ARCH_TARBALL=file overrides the download.
ARCH_VERSION=rolling-20260805
ARCH_TARBALL_NAME="ArchLinuxARM-aarch64-$ARCH_VERSION.tar.gz"
ARCH_URL="http://os.archlinuxarm.org/os/ArchLinuxARM-aarch64-latest.tar.gz"
ARCH_SHA256=42a4eeaa038994ffd31fa173256ef2f0ef511358eeb41b9ea1f8626391b9b319
# The package mirror (pacman.conf's, without $repo): the build upgrades the
# tarball's packages and adds the image's own (ARCH_PACKAGES in build.sh) from
# it in a boot of the tree, and takes the file lists of its repositories for
# the command -> package map. The mirror keeps only current packages, so
# these are not pinned: an image is as current as its build.
ARCH_MIRROR="http://mirror.archlinuxarm.org/aarch64"
