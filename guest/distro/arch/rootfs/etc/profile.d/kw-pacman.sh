# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# A command that is not found is installed from pacman's repositories and
# run (KW_AUTO_PACMAN=0 turns that off); pacman runs through sudo for
# a user. Interactive shells only: a script's missing command is an error.

# unkernel: install a missing command with pacman.
case $- in *i*)
command_not_found_handle() {
	if [ "${KW_AUTO_PACMAN:-1}" = 0 ]; then
		echo "bash: $1: command not found" >&2
		return 127
	fi
	/usr/local/sbin/kw-pacman-install "$1" || return 127
	"$@"
}
if [ "${EUID:-$(id -u)}" != 0 ] && command -v sudo >/dev/null; then
	alias pacman='sudo pacman'
fi
;; esac
