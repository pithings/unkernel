// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Git: linenoise (github.com/antirez/linenoise), antirez's small readline
// replacement, cloned with git, toured, then browsed with tig. Its whole
// history, 163 commits since 2010, is about 224 KB packed (2026-11-15), so
// the clone takes a moment even over the page's Wisp connection. git and
// tig are Alpine's aarch64 packages from main (about 6.6 MB to download
// with their libraries); git talks HTTPS to GitHub with its own libcurl,
// not the image's curl shim.
//
// clone.sh makes a full clone, or pulls on a second run (a failed pull is
// not fatal). tour.sh prints a few views of the history in the style of
// the other demos' showcases: the clone, the oldest commits, the graph,
// commits per year, the authors, the files changed most and a git grep.
import type { TerminalApp } from "../types.ts";

const CLONE = String.raw`#!/bin/sh
# Clones linenoise into ./linenoise (the whole history), or pulls when it
# is there.
set -e
URL=https://github.com/antirez/linenoise
# Fail instead of asking for a user name if GitHub refuses the clone.
export GIT_TERMINAL_PROMPT=0
if [ -d linenoise/.git ]; then
	echo "linenoise/ is already cloned: pulling new commits"
	git -C linenoise pull --ff-only || echo "(could not pull; the tour uses the clone as it is)"
	exit 0
fi
start=$(date +%s)
git clone "$URL" linenoise || {
	rm -rf linenoise
	echo "clone.sh: could not clone $URL" >&2
	exit 1
}
echo "cloned and checked out in $(($(date +%s) - start)) s"
`;

const TOUR = String.raw`#!/bin/sh
# A few views of linenoise's history before tig opens.
set -e
cd linenoise
export GIT_PAGER=cat
section() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
show() { printf '\033[90m$ %s\033[0m\n' "$1"; sh -c "$1"; }

section "The clone: the whole history"
show "git count-objects -vH | grep size-pack"
echo "$(git rev-list --count HEAD) commits on $(git branch --show-current)."

section "Where it started: the oldest commits"
show "git log --reverse --format='%h %ad %<(18,trunc)%an %s' --date=short | head -4"

section "History: the newest commits"
show "git log --graph --oneline --decorate --color=always -10"

section "Commits per year, and who made them"
git log --format=%ad --date=format:%Y | sort | uniq -c | awk '
	{ n[NR] = $1; y[NR] = $2; if ($1 > max) max = $1 }
	END {
		for (i = 1; i <= NR; i++) {
			w = int(n[i] * 40 / max); if (w < 1) w = 1
			bar = ""; for (j = 0; j < w; j++) bar = bar "█"
			printf "  %s \033[32m%s\033[0m %d\n", y[i], bar, n[i]
		}
	}'
show "git shortlog -sn --no-merges HEAD | head -5"

section "The files changed most often"
show "git log --format= --name-only | sort | uniq -c | sort -rn | head -6"

section "git grep: the whole API, in one header"
show "git grep -n '^[a-z].*linenoise[A-Za-z]*(' -- linenoise.h | head -12"

printf '\n%s\n' "tig opens next, on the whole history. Keys:
  Enter         a commit's diff (q goes back)      j k, arrows   move
  t             the commit's file tree; Enter on a file shows it, b blames it
  /  n          search, next match                 q  quit tig
Then try: git log --stat -3, git blame linenoise.h, tig linenoise.c
./run.sh pulls new commits and starts the tour again."
`;

export default {
	id: "git",
	title: "Git",
	desc: "linenoise's repository, cloned with git, toured, then browsed in tig",
	// The Git logo, from Simple Icons (CC0 1.0), slug git.
	icon: { svg: '<path d="M23.546 10.93L13.067.452c-.604-.603-1.582-.603-2.188 0L8.708 2.627l2.76 2.76c.645-.215 1.379-.07 1.889.441.516.515.658 1.258.438 1.9l2.658 2.66c.645-.223 1.387-.078 1.9.435.721.72.721 1.884 0 2.604-.719.719-1.881.719-2.6 0-.539-.541-.674-1.337-.404-1.996L12.86 8.955v6.525c.176.086.342.203.488.348.713.721.713 1.883 0 2.6-.719.721-1.889.721-2.609 0-.719-.719-.719-1.879 0-2.598.182-.18.387-.316.605-.406V8.835c-.217-.091-.424-.222-.6-.401-.545-.545-.676-1.342-.396-2.009L7.636 3.7.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477c.604.604 1.582.604 2.186 0l10.43-10.43c.605-.603.605-1.582 0-2.187"/>' },
	colors: ["#f05032", "#3b1410"],
	needs: { net: true },
	files: {
		"clone.sh": { content: CLONE, mode: 0o755 },
		"tour.sh": { content: TOUR, mode: 0o755 },
	},
	packages: { alpine: ["git", "tig"], arch: ["git", "tig"], debian: ["git", "tig"] },
	commands: ["./clone.sh", "./tour.sh", "cd linenoise", "tig"],
} satisfies TerminalApp;
