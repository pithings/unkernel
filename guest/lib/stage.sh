# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Sourced by the guest/ build scripts (bash, after env.sh): putting files
# into a staged root file system.
#
#   distro_unpack NAME VAR   the upstream tarball ($VAR_TARBALL, else the
#                            pinned $VAR_URL, fetched) extracted into
#                            $stage ($distro_out/NAME-root, image.sh), with
#                            /usr/lib/kw-distro (NAME)
#   install_tree SRC DEST    the files of the mirror tree SRC (initramfs/,
#                            rootfs/) into DEST at the same paths
#   install_common DEST      what every distro image has and the base's kw
#                            layer (RAM-resident) leaves out: the game and
#                            display self-test, /usr/bin/glimmer
#   install_user DEST SHELL GROUP...
#                            the image's user (kwtty's default): "user",
#                            uid and gid 1000, home /home/user (mode 700,
#                            /etc/skel's files), in the GROUPs
#   install_readme DEST DISTRO KEY=VALUE...
#                            /home/user/README from guest/common/README for
#                            DISTRO (after install_user)
# The user's home goes into the image owned by 1000:1000: pass
# "${user_owner[@]}" to distro_images (mktree.py --owner).
#
# A mirror tree holds files at their installed path and name. Each starts
# with the repository's header (SPDX line, copyright, what the file is): a
# comment block (# or //) after an optional #! line, ended by an empty
# line; install_tree leaves that block and the empty line out, so the
# image has the file's text only. A file without comment syntax has its
# header in NAME.license next to it, which is not installed. Modes: 755
# for a file with the x bit, else 644; directories 755; symlinks as they
# are. Anything else is set by the build script.

# distro_unpack NAME VAR: sets $VAR_TARBALL and $stage. Owners, exact modes
# and hard links come from the tarball later (mktree.py), so the extraction
# needs no root; neither tarball has device nodes or xattrs.
distro_unpack() {
	local name=$1 t="$2_TARBALL" n="$2_TARBALL_NAME" u="$2_URL" s="$2_SHA256"
	if [ -z "${!t:-}" ]; then
		printf -v "$t" '%s' "$dl/${!n}"
		fetch_verified "${!u}" "${!t}" "${!s}"
	fi
	echo "$name: ${!t}"
	stage="$distro_out/$name-root"
	rm -rf "$stage"
	mkdir -p "$stage"
	tar -xzf "${!t}" -C "$stage" --no-same-owner --delay-directory-restore
	chmod -R u+rwX "$stage"
	echo "$name" > "$stage/usr/lib/kw-distro"
}

# strip_header FILE: FILE without its header (see the top) on stdout; fails
# when FILE has none.
strip_header() {
	awk '
		NR == 1 && /^#!/ { print; next }
		state == 0 && /^(#|\/\/)( |$)/ { hdr = 1; next }
		state == 0 && hdr && /^$/ { state = 1; next }
		state == 0 { exit 1 }
		{ print }
		END { if (!state) exit 1 }' "$1"
}

# install_tree SRC DEST
install_tree() {
	local src=$1 dest=$2 f
	[ -d "$src" ] || { echo "install_tree: no $src" >&2; return 1; }
	while IFS= read -r -d '' f; do
		case $f in *.license) continue ;; esac
		mkdir -p "$dest/$(dirname "$f")"
		if [ -L "$src/$f" ]; then
			ln -sfn "$(readlink "$src/$f")" "$dest/$f"
		elif [ -e "$src/$f.license" ]; then
			cat "$src/$f" > "$dest/$f"
		else
			strip_header "$src/$f" > "$dest/$f" ||
				{ echo "install_tree: $src/$f has no header block (SPDX lines, then an empty line)" >&2; return 1; }
		fi
		[ -L "$src/$f" ] || if [ -x "$src/$f" ]; then chmod 755 "$dest/$f"; else chmod 644 "$dest/$f"; fi
	done < <(cd "$src" && find . \( -type f -o -type l \) -printf '%P\0' | sort -z)
}

# install_common DEST
install_common() {
	"${cc_guest[@]}" -o "$1/usr/bin/glimmer" "$guest/src/glimmer.c"
	chmod 755 "$1/usr/bin/glimmer"
}

# install_user DEST SHELL GROUP...: passwd, group, shadow (and gshadow,
# subuid, subgid where the image has them) get "user" (uid and gid 1000,
# SHELL, no password: "*", so only root, sudo or kwtty start its
# sessions), a member of each GROUP. Lines are appended as adduser would,
# with root's password-change day (a fixed date, so the build is
# reproducible). Fails if the name, uid or gid is taken or a GROUP is
# missing. The home is /home/user (mode 700) with /etc/skel's files.
user_owner=(--owner home/user=1000:1000)
install_user() {
	local dest=$1 shell=$2 g lastchg
	shift 2
	if grep -q '^user:' "$dest/etc/passwd" "$dest/etc/group" ||
		awk -F: '$3 == 1000 { f = 1 } END { exit !f }' "$dest/etc/passwd" "$dest/etc/group"; then
		echo "install_user: the name user or the id 1000 is taken in $dest" >&2
		return 1
	fi
	echo "user:x:1000:1000::/home/user:$shell" >> "$dest/etc/passwd"
	echo "user:x:1000:" >> "$dest/etc/group"
	lastchg=$(awk -F: '$1 == "root" { print $3 }' "$dest/etc/shadow")
	echo "user:*:$lastchg:0:99999:7:::" >> "$dest/etc/shadow"
	[ ! -f "$dest/etc/gshadow" ] || echo "user:!::" >> "$dest/etc/gshadow"
	for g in subuid subgid; do
		[ ! -f "$dest/etc/$g" ] || echo "user:100000:65536" >> "$dest/etc/$g"
	done
	for g; do
		grep -q "^$g:" "$dest/etc/group" || { echo "install_user: no group $g in $dest" >&2; return 1; }
		for f in group gshadow; do
			[ -f "$dest/etc/$f" ] || continue
			awk -F: -v OFS=: -v g="$g" '$1 == g { $4 = $4 == "" ? "user" : $4 ",user" } { print }' \
				"$dest/etc/$f" > "$dest/etc/$f.kw"
			cat "$dest/etc/$f.kw" > "$dest/etc/$f"
			rm "$dest/etc/$f.kw"
		done
	done
	mkdir -p "$dest/home/user"
	[ ! -d "$dest/etc/skel" ] || cp -a "$dest/etc/skel/." "$dest/home/user/"
	chmod 700 "$dest/home/user"
}

# install_readme DEST DISTRO KEY=VALUE...: /home/user/README (mode 644)
# from the one text of every distro, guest/common/README: @KEY@ becomes
# VALUE, and the lines between "@if NAME" and "@end" stay only for DISTRO
# NAME. Fails on a KEY the text has and the call does not give.
install_readme() {
	local dest=$1 distro=$2 out
	shift 2
	out="$dest/home/user/README"
	awk -v distro="$distro" '
		BEGIN { for (i = 2; i < ARGC; i++) { k = ARGV[i]; sub(/=.*/, "", k); v = substr(ARGV[i], length(k) + 2); val["@" k "@"] = v; ARGV[i] = "" } }
		/^@if / { skip = $2 != distro; next }
		/^@end$/ { skip = 0; next }
		skip { next }
		{
			for (k in val) while ((i = index($0, k))) $0 = substr($0, 1, i - 1) val[k] substr($0, i + length(k))
			if ($0 ~ /@[A-Z_]+@/) { print "install_readme: no value for " $0 > "/dev/stderr"; bad = 1 }
			print
		}
		END { exit bad }' "$guest/common/README" "$@" > "$out"
	chmod 644 "$out"
}
