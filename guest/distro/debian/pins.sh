# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Pinned inputs of the Debian image (build.sh), sourced. The root file
# system of the official debian:trixie-slim arm64 image, as debuerreotype
# publishes it (a minbase debootstrap without docs, man pages and locales).
# Pinned to a commit of the dist-arm64v8 branch, whose files do not change;
# DEBIAN_EPOCH is that build's snapshot.debian.org date
# (rootfs.debuerreotype-epoch). DEBIAN_TARBALL=file overrides the download.
DEBIAN_VERSION=13.7
DEBIAN_EPOCH=20261116
DEBIAN_ARTIFACTS_COMMIT=5994ab615f09f401eef80676e152b497e2a7b3ba
DEBIAN_TARBALL_NAME="debian-trixie-slim-$DEBIAN_EPOCH-arm64.tar.gz"
DEBIAN_URL="https://raw.githubusercontent.com/debuerreotype/docker-debian-artifacts/$DEBIAN_ARTIFACTS_COMMIT/trixie/slim/oci/blobs/rootfs.tar.gz"
DEBIAN_SHA256=247b26a4519187bec80e4b91bfca39d2882f58e608b9ac5a8d753f860823fad8
# The package lists baked into the image (build.sh): main for arm64 of the
# image's three suites, as snapshot.debian.org has them at DEBIAN_EPOCH (the
# snapshot URLs in the image's debian.sources). One line per file: archive,
# suite, path under dists/SUITE/, SHA-256, and the mtime apt gives its copy,
# which is the server's Last-Modified: deb.debian.org's where it still
# served the same file when pinned (snapshot.debian.org's is its own import
# time), else the Date of the suite's InRelease (no later than the real one,
# so apt's If-Modified-Since never hides a newer file). Only the mtime of
# InRelease matters to a later apt-get update (Hit without a download when
# exact).
DEBIAN_LISTS_SNAPSHOT="${DEBIAN_EPOCH}T000000Z"
DEBIAN_LISTS="
debian          trixie          InRelease                    0584fba32e13e0ab8285fb16c27adea1ec03a73669c18702821094fd6ca86675 1789199950
debian          trixie          main/binary-arm64/Packages.xz be16b37b2f740f066ea93d35d56f04f94d63693e5a3eb421b052bf86fae75bcd 1789198192
debian          trixie-updates  InRelease                    5abd14276db149bdebbf10107692f7dbd400e50847d746c71802488042c71412 1794774556
debian          trixie-updates  main/binary-arm64/Packages.xz eea860c5dea11680e64299adb2736c2367c4235763a66f2b70ca61ce1b51978a 1793887066
debian-security trixie-security InRelease                    787ce8d47494fb7cc048bfb42bf46fa8672f3fb9dede9b02e4120a128bfcb732 1794781098
debian-security trixie-security main/binary-arm64/Packages.xz da10b3ed199a5577402efafbbef2428fb9724168c8bdfd8768efaf17340a67fb 1794781098
"
# The Contents files the command -> package map (/usr/lib/kw-commands) is
# made from, of trixie main at the same snapshot: path under dists/trixie/
# and SHA-256. Contents-arm64 has no arch:all packages; Contents-all has
# them. The other two suites' are empty.
DEBIAN_CONTENTS="
main/Contents-arm64.gz 276dbed691664effd4be91435f7e0d1552f0ab645c0aa0397de9ba5900e13b74
main/Contents-all.gz   0c2e2d099588073221d6eebb0a84e950f1728818faf527de9034d0116f7a8221
"
# wland's relay (https://github.com/pithings/wland, MPL-2.0 AND MIT): the
# static aarch64 wlandr of a wland release, installed as /usr/lib/kw/wlandr
# (the kw layer's /usr/lib/kw/bin/wland starts it; Wayland apps as windows
# in the page). Only this image has it: the base and Alpine have no relay.
# The asset is the --link-only build (wlandr-link-linux-arm64.tar.gz, entry
# wlandr; no HTTP server). GL apps by GPU resource (--dmabuf virtgpu, which
# bin/wland passes only to a relay that has it) need 0.1.0-261122 or later,
# as does the page (web/package.json; .agents/web.md, Wayland desktop).
# The relay at boot (wland --boot: --link-on-demand, read from wlandr
# --version, as --no-fence-wait is) needs 0.1.0-261122-632f589 or later;
# with an older one the boot starts none and wland CMD works as before.
# Bump together: WLANDR_VERSION, WLANDR_SHA256 and wland's version in
# web/package.json. build.sh takes a local relay from KW_WLANDR instead
# (development).
WLANDR_VERSION=v0.1.0-261125-0023837
WLANDR_TARBALL="wlandr-link-$WLANDR_VERSION-linux-arm64.tar.gz"
WLANDR_URL="https://github.com/pithings/wland/releases/download/$WLANDR_VERSION/wlandr-link-linux-arm64.tar.gz"
WLANDR_SHA256=135b4cc69996a9ee443ceda8b7122c2d9ede9101ef38c8db61a94775636baadd
# xwayland-satellite (https://github.com/Supreeeme/xwayland-satellite,
# MPL-2.0): rootless Xwayland for wland, X apps' windows as Wayland windows,
# installed as /usr/lib/kw/xwayland-satellite, which wland's relay starts
# when an X client connects (bin/wland, where the relay has lodpi: wland
# 0.1.0-261125-0023837 or later). Neither
# Debian nor upstream ships a binary: this is Fedora 43's aarch64 build,
# whose newest glibc symbol is 2.34 (Arch Linux ARM's needs 2.43, trixie has
# 2.41), from Koji, which keeps every build (the copy signed with Fedora's
# key, 31645531, as the mirrors have it; its unsigned one differs). It
# needs libxcb-cursor0 and libfontconfig1 (DEBIAN_PACKAGES in build.sh)
# and, at run time, Xwayland (Debian's xwayland, not in the image: 215 MiB
# installed with Mesa).
XWS_VERSION=0.8.3-1.fc43
XWS_RPM="xwayland-satellite-$XWS_VERSION.aarch64.rpm"
XWS_URL="https://kojipkgs.fedoraproject.org/packages/xwayland-satellite/0.8.3/1.fc43/data/signed/31645531/aarch64/$XWS_RPM"
XWS_SHA256=e721c1efd1dee42f25763c3a132fc8d063cc3ae41c9ad6208683b30a19efb986
