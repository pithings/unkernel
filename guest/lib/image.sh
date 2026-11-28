# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Sourced by guest/distro/NAME/build.sh (bash, after env.sh): turns a
# staged root file system into the distro images vendor/build/distro/
# NAME.erofs and NAME.ext4, read-only file systems labelled kwroot that the
# base initramfs mounts as the lower layer of the root overlay.
#
#   distro_images NAME STAGE UPSTREAM.tar.gz ID-PREFIX [MKTREE-OPTION...]
#
# Both formats come from one tar stream (mktree.py), which carries the
# upstream tarball's owners, modes and hard links, fixed times and the image
# id (/usr/lib/kw-image), so no step needs root and an identical rebuild
# gives identical images:
#   erofs   mkfs.erofs --tar=f from that stream (the pinned, patched build
#           of tools/erofs-utils.sh; the layout: below), compressed with $KW_EROFS_COMPRESS (default
#           zstd,level=15; "none" for no compression) and the options in
#           $KW_EROFS_OPTS (default 128 KiB physical clusters and
#           fragments), fixed UUID and build time; checked with fsck.erofs,
#           and its extraction must equal STAGE (diff -r). Not
#           -Eztailpacking together with -Efragments and -C131072: in
#           erofs-utils 1.9.4 one file of Debian's (var/log/apt/eipp.log.xz,
#           kept whole in the fragment) then reads back wrong. Not lz4 or
#           lz4hc: on this kernel (flat vmalloc) reads of lz4-compressed
#           files fail with ENOMEM, and lz4 images with -C do not mount;
#           zstd works on the UP and SMP kernels. One algorithm per image: mkfs.erofs 1.9.4 crashes on
#           --compress-hints lines that name an algorithm index.
#   ext4    mke2fs -d STAGE, then debugfs sets every inode's owner, mode and
#           times from the stream (mktree.py --debugfs); no journal, no
#           reserved blocks, as many blocks as the tree takes plus
#           $KW_EXT4_SLACK percent (default 1); checked with e2fsck -fn
# KW_DISTRO_FORMATS="erofs ext4" picks the formats (default both). The UUID
# of both is derived from the image id, which goes to NAME.id next to them
# (for distros.json). KW_DISTRO_OUT (an absolute path) puts the images and
# the staging trees elsewhere (default $build/distro).
#
# The erofs image is laid out for its boot (distro_erofs): what a boot to
# the console's prompt plus `ls` and `cat` reads (the boot set: the recorded
# list guest/distro/NAME/boot-files) comes first, as
# one piece: every inode and directory (the metadata zone, about 0.5 MiB
# for Debian), then the boot set's data, with its tails (no -Efragments
# for them), then the other files' data, then the packed inode with their
# fragments. That takes the patched mkfs.erofs (tools/erofs-utils-patches).
# KW_DISTRO_TRACE=1 records the list again (it needs the base bundle and
# node): an uncompressed image of the same stream boots here, and the
# files it reads replace boot-files. Record it when what a boot runs
# changes (init, profile, the shell's libraries); a list that is behind
# costs a few lazy reads, nothing else. Without a list the image is laid
# out as mkfs.erofs does it (data breadth-first by name, metadata in
# between), with a warning.
# A distro may name a warm set too: what the first commands a user types
# after the prompt read ($KW_WARM_SCRIPT, set by its build.sh; Debian:
# apt's binaries, libraries and srcpkgcache.bin), recorded in
# guest/distro/NAME/warm-files by the same KW_DISTRO_TRACE=1 run (a second
# traced boot that runs the script; the boot set's files and paths matching
# $KW_WARM_EXCLUDE, a list of globs, left out; small files first, then
# those over 1 MiB), plus $KW_WARM_FILES (files no offline trace reaches).
# Its data follows the boot set's, also without tails in the packed inode,
# and the header's `background` (the end of its data, rounded up to 1 MiB)
# lets the SDK fetch it once the boot is done. No list: no warm set.
# It starts with the distro header (its format: js/core/distro.ts), in the
# 1024 bytes before the superblock that erofs leaves unused, so the SDK
# knows how much of it to fetch ahead over HTTP: an image of at most
# $KW_PREFETCH_WHOLE_MAX bytes (default 16 MiB) is fetched whole; for a
# larger one prefetch is the end of the boot set's data plus 256 KiB,
# rounded up to 1 MiB; background (the warm set) is 0 for an image fetched
# whole. With KW_DISTRO_TRACE=1 it boots once more here
# (guest/tools/vm-run.ts --trace), prefetch also covers what that boot
# reads up to there, and the build prints what the boot reads inside and
# beyond it. Not ordered, the header says 0 (no hint);
# KW_DISTRO_HINT=0 writes none and does not order. ext4 images have none.

KW_EROFS_COMPRESS="${KW_EROFS_COMPRESS:-zstd,level=15}"
KW_EROFS_OPTS="${KW_EROFS_OPTS:--C131072 -Efragments}"
KW_EXT4_SLACK="${KW_EXT4_SLACK:-1}"
KW_DISTRO_FORMATS="${KW_DISTRO_FORMATS:-erofs ext4}"
KW_PREFETCH_WHOLE_MAX="${KW_PREFETCH_WHOLE_MAX:-16777216}"
# What the traced boot (with a network: DHCP reads the image's resolv.conf)
# runs at the prompt: the first things a user types.
KW_BOOT_FILES="${KW_BOOT_FILES:-etc/resolv.conf usr/share/terminfo/l/linux}"
KW_BOOT_SCRIPT='ls -l / >/dev/null; cat /etc/os-release >/dev/null'
# How the traced boots boot (guest/tools/vm-run.ts): as the page does, with a
# network, kwshm and its command line, so that the boot set has what the
# page's boot reads too (kw.wayland=1: wland's relay, where the image has one).
KW_TRACE_BOOT=(--net --shm --append "kw.gl=1 kw.wayland=1")
# The warm set (above): the distro's build.sh sets these; none by default.
KW_WARM_SCRIPT="${KW_WARM_SCRIPT:-}"
KW_WARM_EXCLUDE="${KW_WARM_EXCLUDE:-}"
KW_WARM_FILES="${KW_WARM_FILES:-}"

distro_out="$(realpath -m "${KW_DISTRO_OUT:-$build/distro}")"

# distro_report FILE: raw size and what it takes to download compressed.
distro_report() {
	local f=$1 gz zs
	gz=$(gzip -9n < "$f" | wc -c)
	zs=$(zstd -19 -T0 -q -c "$f" | wc -c)
	awk -v n="${f##*/}" -v r="$(stat -c %s "$f")" -v g="$gz" -v z="$zs" -v a="$(du -B1 "$f" | cut -f1)" \
		'BEGIN { printf "  %-14s raw %7.1f MiB (allocated %6.1f), gzip -9 %6.1f MiB, zstd -19 %6.1f MiB\n",
			n, r / 1048576, a / 1048576, g / 1048576, z / 1048576 }'
}

distro_images() {
	local name=$1 stage=$2 upstream=$3 prefix=$4
	shift 4
	local tar="$distro_out/$name.tar" id uuid epoch fmt bin mzblocks=0
	mkdir -p "$distro_out"
	# Images of this distro only: an old one must not outlive a failed build.
	rm -f "$distro_out/$name".{erofs,ext4,tar,debugfs,id,boot,warm}
	id=$(python3 "$guest/tools/mktree.py" "$stage" "$upstream" "$tar" --id "$prefix" \
		--debugfs "$distro_out/$name.debugfs" "$@")
	echo "image id: $id"
	# A UUID from the image id: fixed for the same tree, new for a new one.
	uuid=$(printf '%s' "$id" | sha256sum | sed -E 's/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*/\1-\2-4\3-8\4-\5/')
	# The newest mtime in the stream (= in the upstream tarball, mktree.py).
	epoch=$(python3 -I -c 'import sys, tarfile; print(max(m.mtime for m in tarfile.open(sys.argv[1])))' "$tar")
	for fmt in $KW_DISTRO_FORMATS; do
		case $fmt in
		erofs)
			bin=$("$guest/tools/erofs-utils.sh")
			distro_erofs "$name" "$tar" "$uuid" "$epoch" "$bin"
			"$bin/fsck.erofs" "$distro_out/$name.erofs.tmp" >/dev/null ||
				{ "$bin/fsck.erofs" "$distro_out/$name.erofs.tmp"; exit 1; }
			# What it reads back is what went in (fsck alone checks
			# only the structure).
			rm -rf "$distro_out/$name.erofs.x"
			"$bin/fsck.erofs" --extract="$distro_out/$name.erofs.x" --no-preserve "$distro_out/$name.erofs.tmp" >/dev/null
			# A mode the owner cannot read (4710 root:dbus) would stop diff.
			chmod -R u+rwX "$distro_out/$name.erofs.x"
			diff -r --no-dereference "$stage" "$distro_out/$name.erofs.x" >&2 ||
				{ echo "distro: $name.erofs does not read back as $stage" >&2; exit 1; }
			rm -rf "$distro_out/$name.erofs.x"
			if [ "${KW_DISTRO_HINT:-1}" != 0 ]; then
				distro_hint "$distro_out/$name.erofs.tmp" "$(cat "$stage/usr/lib/kw-distro" 2>/dev/null || echo "$name")" "$id" "$bin" \
					"$distro_out/$name.boot" "$mzblocks" "$distro_out/$name.warm"
				"$bin/fsck.erofs" "$distro_out/$name.erofs.tmp" >/dev/null ||
					{ echo "distro: $name.erofs is broken by its header" >&2; exit 1; }
			fi
			mv "$distro_out/$name.erofs.tmp" "$distro_out/$name.erofs"
			;;
		ext4) distro_ext4 "$name" "$stage" "$uuid" "$epoch" ;;
		*) echo "distro: unknown format $fmt (KW_DISTRO_FORMATS: erofs ext4)" >&2; exit 2 ;;
		esac
	done
	rm -f "$distro_out/$name".{debugfs,boot,warm}
	# The id for distros.json (guest/tools/distros-json.mjs), written last:
	# it says the images are complete.
	echo "$id" > "$distro_out/$name.id"
	echo "distro $name ($id):"
	for fmt in $KW_DISTRO_FORMATS; do distro_report "$distro_out/$name.$fmt"; done
}

# distro_erofs NAME TAR UUID EPOCH EROFS-BIN: $distro_out/NAME.erofs.tmp
# from TAR (see the top), and in mzblocks the size of its metadata zone
# (0: none). Unless KW_DISTRO_HINT is 0, the boot set first
# ($distro_out/NAME.boot): the recorded $KW_DISTRO_DIR/boot-files, or with
# KW_DISTRO_TRACE=1 a new record of it: an uncompressed image of TAR
# without inline data boots (vm-run.ts --trace: to the console's prompt,
# then $KW_BOOT_SCRIPT) and erofs-trace.py maps its reads to the files it read.
# Then the warm set ($distro_out/NAME.warm): $KW_DISTRO_DIR/warm-files, or
# with KW_DISTRO_TRACE=1 a second traced boot that also runs
# $KW_WARM_SCRIPT (warm_select), plus $KW_WARM_FILES.
# mktree.py --first moves both to the front of TAR, and the patched mkfs.erofs
# (tools/erofs-utils-patches) lays out data in tar order (--sort=tar), keeps
# those files out of the packed inode of -Efragments (--nofrag-first) and
# puts all inodes and directories in front of the data (--MZ --MZ-front;
# a first run says how many blocks that takes, the second fills them).
distro_erofs() {
	local name=$1 tar=$2 uuid=$3 epoch=$4 bin=$5 out="$distro_out/$1.erofs.tmp" n log
	local rec="${KW_DISTRO_DIR:-$guest/distro/$1}/boot-files" boot="$distro_out/$1.boot"
	local wrec="${KW_DISTRO_DIR:-$guest/distro/$1}/warm-files" warm="$distro_out/$1.warm"
	local z=() order=()
	[ "$KW_EROFS_COMPRESS" = none ] || z=("-z$KW_EROFS_COMPRESS" $KW_EROFS_OPTS)
	# --tar=f: owners, modes, hard links and mtimes come from the
	# stream; -T is the build time only (--mkfs-time), the files
	# keep theirs (which costs 32 bytes per inode: 0.2%).
	local mkfs=("$bin/mkfs.erofs" --quiet --tar=f -L kwroot -U "$uuid" -T "$epoch" --mkfs-time --preserve-mtime)
	mzblocks=0
	rm -f "$boot" "$warm"
	if [ "${KW_DISTRO_HINT:-1}" = 0 ]; then
		:
	elif [ "${KW_DISTRO_TRACE:-0}" = 1 ]; then
		[ -f "$base_bundle" ] && command -v node >/dev/null ||
			{ echo "distro: KW_DISTRO_TRACE=1 needs $base_bundle (kernel/build.sh base) and node" >&2; exit 1; }
		rm -f "$out"
		"${mkfs[@]}" -Enoinline_data "$out" "$tar"
		node "$guest/tools/vm-run.ts" "$base_bundle" "$out" "${KW_TRACE_BOOT[@]}" --timeout 300 --trace "$out.trace" "$KW_BOOT_SCRIPT" ||
			{ echo "distro: $name.erofs (uncompressed) does not boot (vm-run.ts)" >&2; exit 1; }
		python3 -I "$guest/tools/erofs-trace.py" "$out" "$out.trace" > "$boot"
		{ boot_files_header "$name"; cat "$boot"; } > "$rec"
		echo "distro: $name: recorded $rec" >&2
		if [ -n "$KW_WARM_SCRIPT" ]; then
			node "$guest/tools/vm-run.ts" "$base_bundle" "$out" "${KW_TRACE_BOOT[@]}" --timeout 600 --trace "$out.trace" \
				"$KW_BOOT_SCRIPT; $KW_WARM_SCRIPT" >/dev/null ||
				{ echo "distro: the warm script fails in $name.erofs (uncompressed) (vm-run.ts)" >&2; exit 1; }
			python3 -I "$guest/tools/erofs-trace.py" "$out" "$out.trace" > "$out.files"
			warm_select "$out.files" "$boot" "$tar" > "$warm"
			rm -f "$out.files"
			{ warm_files_header "$name"; cat "$warm"; } > "$wrec"
			echo "distro: $name: recorded $wrec" >&2
		fi
		rm -f "$out" "$out.trace"
	elif [ -f "$rec" ]; then
		grep -v -e '^#' -e '^$' "$rec" > "$boot" || true
		if [ -f "$wrec" ]; then grep -v -e '^#' -e '^$' "$wrec" > "$warm" || true; fi
	else
		echo "distro: WARNING: no $rec (record it: KW_DISTRO_TRACE=1 guest/build.sh distro $name):" \
			"$name.erofs is not laid out for its boot, and over $KW_PREFETCH_WHOLE_MAX bytes it gets no prefetch hint (read lazily, a range per miss)" >&2
	fi
	# Files a boot reads only sometimes (the DHCP lease script compares
	# /etc/resolv.conf; a login shell on a console with a size reads the
	# terminfo entry of the kernel's TERM, linux), which a recording may
	# miss: always in the boot set, where the image has them.
	if [ -s "$boot" ]; then
		for n in $KW_BOOT_FILES; do grep -qxF "$n" "$boot" || echo "$n" >> "$boot"; done
		# The warm set without what the boot set has (a recorded list may
		# be older than boot-files), plus its extra files.
		if [ -s "$warm" ] || [ -n "$KW_WARM_FILES" ]; then
			{ cat "$warm" 2>/dev/null; printf '%s\n' $KW_WARM_FILES; } | awk 'NR == FNR { b[$0]; next } $0 != "" && !($0 in b) && !s[$0]++' "$boot" - > "$warm.tmp"
			mv "$warm.tmp" "$warm"
		fi
	fi
	if [ -s "$boot" ]; then
		# No warm set (Alpine): the boot set alone.
		{ cat "$boot"; [ ! -f "$warm" ] || cat "$warm"; } > "$out.first"
		n=$(python3 -I "$guest/tools/mktree.py" --first "$out.first" "$tar" "$tar.tmp")
		rm -f "$out.first"
		mv "$tar.tmp" "$tar"
		echo "distro: $name.erofs: the boot set and the warm set are $n files ($(wc -l < "$boot") + $(cat "$warm" 2>/dev/null | wc -l) listed), first in the image" >&2
		order=(--sort=tar --nofrag-first="$n" --MZ)
		log="$out.log"
		rm -f "$out"
		if "${mkfs[@]}" "${z[@]}" "${order[@]}" --MZ-front=1 "$out" "$tar" 2>"$log"; then
			mzblocks=1
		else
			mzblocks=$(sed -n 's/.*the metazone needs \([0-9]*\) blocks.*/\1/p' "$log")
			[ -n "$mzblocks" ] || { cat "$log" >&2; exit 1; }
			order+=(--MZ-front="$mzblocks")
		fi
		rm -f "$log"
		if [ "$mzblocks" = 1 ]; then return; fi
		rm -f "$out"
	fi
	"${mkfs[@]}" "${z[@]}" "${order[@]}" "$out" "$tar"
}

# boot_files_header NAME: the head of a recorded guest/distro/NAME/boot-files.
boot_files_header() {
	sed -n '1,2p' "$guest/lib/image.sh"
	printf '%s\n' "# What a boot of the $1 image to the console's prompt plus a first exec" \
		"# reads, in that order: these files come first in $1.erofs, and the SDK" \
		"# fetches them ahead in one request (guest/lib/image.sh). Recorded by" \
		"# KW_DISTRO_TRACE=1 guest/build.sh distro $1; do not edit by hand."
}

# warm_files_header NAME: the head of a recorded guest/distro/NAME/warm-files.
warm_files_header() {
	sed -n '1,2p' "$guest/lib/image.sh"
	printf '%s\n' "# What the first commands after the prompt read in the $1 image (the" \
		"# warm set: KW_WARM_SCRIPT in its build.sh), past the boot set: these" \
		"# files follow boot-files in $1.erofs, and the SDK fetches them in the" \
		"# background once the boot is done (guest/lib/image.sh). Recorded by" \
		"# KW_DISTRO_TRACE=1 guest/build.sh distro $1; do not edit by hand."
}

# warm_select PATHS BOOT-LIST TAR: of the paths in PATHS (erofs-trace.py of
# the boot plus the warm script), those not in BOOT-LIST nor matching a glob of
# $KW_WARM_EXCLUDE; the ones of at most 1 MiB first, then the larger ones
# (sizes from TAR), each in path order.
warm_select() {
	python3 -I - "$1" "$2" "$3" "$KW_WARM_EXCLUDE" <<'EOF'
import fnmatch, sys, tarfile
files, boot, tar, exclude = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split()
skip = {l.strip() for l in open(boot)}
size = {m.name.removeprefix("./"): m.size for m in tarfile.open(tar) if m.isreg()}
paths = [p for p in (l.rstrip("\n") for l in open(files))
         if p and p not in skip and not any(fnmatch.fnmatchcase(p, g) for g in exclude)]
for p in sorted(paths, key=lambda p: size.get(p, 0) > 1 << 20):   # stable: path order within each
    print(p)
EOF
}

# set_end LIST IMAGE EROFS-BIN MZ-BLOCKS: the end of the data of LIST's
# files in IMAGE: that of the last file in it with data after the metadata
# zone (one with inline data only ends in it); 0 if none has.
set_end() {
	local p e=0
	while read -r p; do
		e=$("$3/dump.erofs" --path="/$p" -e "$2" 2>/dev/null |
			awk -F'[|:]' -v mz=$((($4 + 1) * 4096)) '/^ *[0-9]+:/ { sub(/.*\.\./, "", $4); if ($4 + 0 > mz && $4 + 0 > e) e = $4 + 0 } END { print e + 0 }')
		[ "$e" = 0 ] || break
	done < <(tac "$1")
	echo "$e"
}

# distro_hint IMAGE DISTRO ID EROFS-BIN [BOOT-LIST MZ-BLOCKS WARM-LIST]: write the
# distro header (see the top) into IMAGE's first 1024 bytes, which must be
# zeros. BOOT-LIST, MZ-BLOCKS and WARM-LIST: from distro_erofs (no boot
# list: no hint for a large image; no warm list: no background, and the
# 128-byte header).
distro_hint() {
	local img=$1 distro=$2 id=$3 bin=$4 list=${5:-} mz=${6:-0} wlist=${7:-} size prefetch=0 background=0 trace cut=0 report
	size=$(stat -c %s "$img")
	if [ "$size" -le "$KW_PREFETCH_WHOLE_MAX" ]; then
		prefetch=$size
	elif [ -s "$list" ]; then
		# The end of the boot set's data; the boot's reads after that
		# (probes of the device's last block) are not the boot set's.
		cut=$(set_end "$list" "$img" "$bin" "$mz")
		[ "$cut" != 0 ] || cut=$size
		trace="$img.trace"
		if [ "${KW_DISTRO_TRACE:-0}" = 1 ]; then
			node "$guest/tools/vm-run.ts" "$base_bundle" "$img" "${KW_TRACE_BOOT[@]}" --timeout 300 --trace "$trace" "$KW_BOOT_SCRIPT" ||
				{ echo "distro: ${img##*/} does not boot (vm-run.ts)" >&2; exit 1; }
		else
			: > "$trace"
		fi
		read -r prefetch report < <(awk -v cut="$cut" -v size="$size" '
			{ e = $1 + $2; if ($1 < cut && e > hw) hw = e; t[NR] = $1; l[NR] = $2 }
			END { if (cut > hw) hw = cut; p = int((hw + 262144 + 1048575) / 1048576) * 1048576; if (p > size) p = size
				for (i = 1; i <= NR; i++) if (t[i] + l[i] <= p) { n++; b += l[i] } else { m++; c += l[i] }
				printf "%d %d reads (%.1f MiB) inside it, %d (%.1f KiB) beyond\n", p, n, b / 1048576, m, c / 1024 }' "$trace")
		rm -f "$trace"
		if [ "${KW_DISTRO_TRACE:-0}" = 1 ]; then report="; its boot makes $report"; else report=; fi
		# The warm set's data follows the boot set's: its end, rounded up to 1 MiB.
		if [ -s "$wlist" ]; then
			background=$(set_end "$wlist" "$img" "$bin" "$mz")
			background=$(( (background + 1048575) / 1048576 * 1048576 ))
			[ "$background" -le "$size" ] || background=$size
			[ "$background" -gt "$prefetch" ] || background=0
			[ "$background" = 0 ] || report="$report; background to $((background / 1048576)) MiB (the warm set)"
		fi
		echo "distro: $distro.erofs: prefetch $((prefetch / 1048576)) MiB of $((size / 1048576)) MiB$report" >&2
	fi
	python3 -I - "$img" "$size" "$prefetch" "$distro" "$id" "$background" <<'EOF'
import struct, sys
img, size, prefetch, distro, image, background = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], sys.argv[5], int(sys.argv[6])
if len(distro.encode()) > 31 or len(image.encode()) > 63:
    sys.exit(f"distro: {distro!r} or {image!r} is too long for the distro header")
head = struct.pack("<8sIIQQ32s64s", b"KWDISTRO", 1, 136 if background else 128, size, prefetch, distro.encode(), image.encode())
if background:
    head += struct.pack("<Q", background)
with open(img, "r+b") as f:
    if f.read(1024).strip(b"\0"):
        sys.exit(f"distro: {img}: the first 1024 bytes are not free for the distro header")
    f.seek(0)
    f.write(head)
EOF
}

# distro_ext4 NAME STAGE UUID EPOCH: the ext4 image (see the top).
distro_ext4() {
	local name=$1 stage=$2 uuid=$3 epoch=$4 img="$distro_out/$name.ext4.tmp" t inodes blocks
	export PATH="$PATH:/usr/sbin:/sbin"
	for t in mke2fs debugfs dumpe2fs e2fsck; do
		command -v "$t" >/dev/null || { echo "need $t (e2fsprogs >= 1.43 for mke2fs -d)" >&2; exit 1; }
	done
	# Inodes: one per entry (hard links share one), some to spare.
	inodes=$(find "$stage" -printf '%i\n' | sort -u | wc -l)
	inodes=$((inodes + inodes / 50 + 64))
	# Blocks: a first image with plenty of room tells how many the tree
	# takes (mke2fs -d leaves all-zero blocks out, so the tree's own size
	# says little), the second has that many plus $KW_EXT4_SLACK percent;
	# should it not fit after all, a little more.
	blocks=$(du -s -B4096 "$stage" | cut -f1)
	blocks=$((blocks + blocks / 4 + inodes / 16 + 4096))
	distro_mke2fs "$stage" "$img" "$blocks" "$inodes" "$uuid" "$epoch" || exit 1
	blocks=$(dumpe2fs -h "$img" 2>/dev/null | awk -F: '/^Block count/ { n = $2 } /^Free blocks/ { f = $2 } END { print n - f }')
	blocks=$((blocks + blocks * KW_EXT4_SLACK / 100 + 16))
	until distro_mke2fs "$stage" "$img" "$blocks" "$inodes" "$uuid" "$epoch" 2>/dev/null; do
		blocks=$((blocks + blocks / 50 + 16))
	done
	E2FSPROGS_FAKE_TIME=$epoch debugfs -w -f "$distro_out/$name.debugfs" "$img" >/dev/null 2>"$distro_out/$name.debugfs.log" ||
		{ cat "$distro_out/$name.debugfs.log" >&2; exit 1; }
	if grep -v '^debugfs ' "$distro_out/$name.debugfs.log" | grep -q .; then
		cat "$distro_out/$name.debugfs.log" >&2; exit 1
	fi
	rm -f "$distro_out/$name.debugfs.log"
	E2FSPROGS_FAKE_TIME=$epoch e2fsck -fn "$img" >/dev/null 2>&1 || { e2fsck -fn "$img"; exit 1; }
	mv "$img" "$distro_out/$name.ext4"
}

# distro_mke2fs STAGE IMG BLOCKS INODES UUID EPOCH: an ext4 of BLOCKS 4 KiB
# blocks with the tree of STAGE. Read-only use: no journal, no resize
# reserve, no orphan file, no reserved blocks. The times come from
# E2FSPROGS_FAKE_TIME (and debugfs, later), the UUID and directory hash seed
# are fixed: reproducible.
distro_mke2fs() {
	rm -f "$2"
	truncate -s $(($3 * 4096)) "$2"
	E2FSPROGS_FAKE_TIME=$6 mke2fs -q -F -t ext4 -b 4096 -m 0 -N "$4" -L kwroot -U "$5" \
		-O ^has_journal,^resize_inode,^orphan_file \
		-E "hash_seed=$5,lazy_itable_init=0,root_owner=0:0,nodiscard" -d "$1" "$2"
}
