# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# /etc/profile.d/kw-wayland.sh (the kw layer, every distro): tell programs
# they are in a Wayland session, so GUI apps started plainly show as
# windows in the page. A shell gets XDG_RUNTIME_DIR and WAYLAND_DISPLAY
# for this user's runtime directory /run/user/UID where its wland relay's
# socket wayland-0 is there (wland CMD started one), or, with kw.wayland=1
# on the kernel command line (the page's boot: the kw layer's rc starts
# the relay for the image's user, wland --boot), wherever that directory
# exists. Root's shells (sudo -s, su) there get the user's socket by its
# path, with root's own /run/user/0. And wherever WAYLAND_DISPLAY is set
# (wland sources this for CMD) the toolkits that would otherwise look for
# X or ask are told to use Wayland: XDG_SESSION_TYPE (Chromium's and
# Electron's automatic choice, Qt, session-aware apps), GTK, Qt, SDL,
# Firefox, Electron. Each only where unset; the X fallbacks stay for apps
# without a Wayland backend. The page's desktop is dark, so apps are asked
# for their dark variant: GTK by /etc/gtk-3.0 and gtk-4.0/settings.ini,
# libadwaita (which ignores that setting and would ask a settings portal,
# and none runs) by ADW_DEBUG_COLOR_SCHEME, Chromium by its flag. Debian's chromium wrapper takes its flag from
# /etc/chromium.d/kw-wayland instead (it clears CHROMIUM_FLAGS).
# X apps get DISPLAY where wland's relay holds an X display (it starts
# xwayland-satellite for the first X client, /usr/lib/kw/bin/wland, and
# writes the display to WAYLAND_DISPLAY's socket path plus .x11) and
# Xwayland is installed.
# Shell builtins only: every shell start reads this. [ -O / ] is root
# ($UID is bash's only).

if [ -z "${WAYLAND_DISPLAY:-}" ]; then
	_kw_on=
	if [ -r /proc/cmdline ]; then
		read -r _kw_c < /proc/cmdline || :
		case " $_kw_c " in *" kw.wayland=1 "*) _kw_on=1 ;; esac
	fi
	for _kw_d in /run/user/*; do
		[ -d "$_kw_d" ] && [ -O "$_kw_d" ] || continue
		if [ -S "$_kw_d/wayland-0" ] || { [ -n "$_kw_on" ] && ! [ -O / ]; }; then
			export XDG_RUNTIME_DIR="$_kw_d" WAYLAND_DISPLAY=wayland-0
		fi
	done
	if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -n "$_kw_on" ] && [ -O / ] && [ -d /run/user/0 ]; then
		for _kw_d in /run/user/*/wayland-0; do
			[ -S "$_kw_d" ] && export XDG_RUNTIME_DIR=/run/user/0 WAYLAND_DISPLAY="$_kw_d"
		done
	fi
	unset _kw_on _kw_c _kw_d
fi
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
	export XDG_SESSION_TYPE="${XDG_SESSION_TYPE:-wayland}"
	export GDK_BACKEND="${GDK_BACKEND:-wayland,x11}"
	export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-wayland;xcb}"
	export SDL_VIDEODRIVER="${SDL_VIDEODRIVER:-wayland,x11}"
	# SDL 2.32 hangs before its window's first buffer when the compositor answers
	# the decoration protocol with "client-side" (wland's default: it draws no
	# title bars): it moves the window to libdecor in the middle of its wait for
	# the first configure. Preferring libdecor from the start avoids that move;
	# with the plugin (libdecor-0-plugin-1-cairo) the window gets a title bar,
	# without it none, and it maps either way. The web page asks wland for
	# server-side decorations, which libdecor takes: there the window gets the
	# page's frame.
	export SDL_VIDEO_WAYLAND_PREFER_LIBDECOR="${SDL_VIDEO_WAYLAND_PREFER_LIBDECOR:-1}"
	export MOZ_ENABLE_WAYLAND="${MOZ_ENABLE_WAYLAND:-1}"
	export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-auto}"
	export ADW_DEBUG_COLOR_SCHEME="${ADW_DEBUG_COLOR_SCHEME:-prefer-dark}"
	if [ -z "${DISPLAY:-}" ] && [ -x /usr/bin/Xwayland ]; then
		case $WAYLAND_DISPLAY in /*) _kw_x=$WAYLAND_DISPLAY.x11 ;; *) _kw_x=${XDG_RUNTIME_DIR:-}/$WAYLAND_DISPLAY.x11 ;; esac
		if [ -r "$_kw_x" ] && read -r _kw_x < "$_kw_x"; then
			case $_kw_x in :[0-9]*) [ -S "/tmp/.X11-unix/X${_kw_x#:}" ] && export DISPLAY="$_kw_x" ;; esac
		fi
		unset _kw_x
	fi
fi
