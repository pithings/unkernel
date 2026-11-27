// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// X11 apps on the page's Wayland desktop (wayland.ts; Debian), through
// xwl.sh. By default each X window is a Wayland window of its own: Xwayland
// rootless under xwayland-satellite, which is the X window manager and
// starts Xwayland itself (the kw layer's wrapper, by name); wland has the
// protocols it needs (xdg_shell, wp_viewporter). Neither Debian nor upstream
// ships satellite, so it is Fedora 43's aarch64 build, which needs nothing
// newer than trixie's glibc (Arch Linux ARM's needs 2.43): the page fetches
// the RPM from mirrors.kernel.org (Fedora's own servers are https only), or
// xwl.sh from Koji, and xwl.sh takes the binary out with bsdtar, once for
// all apps (SAT_DIR). XWL_ROOTFUL=1 is the other mode, for a client that is
// a desktop with its own window manager (Xfce): Xwayland rootful, a whole X
// screen in one Wayland window. -shm: its buffers go through wl_shm, which
// the page reads in place through kwshm like any other window (no glamor, so
// GL in it is software); -decorate: its window is decorated through libdecor,
// which takes the server-side decorations the page asks wland for (the
// page's window frame), else draws a title bar with the cairo plugin (a
// compositor that answers client-side, as wland does by default). Either
// takes the first free display from :1 (:0 is the X on the DRM device,
// xkms.ts), and stops when the client ends.
import type { AppDownload } from "./types.ts";

/** What an app that runs XWL_SH puts in its `packages`: Xwayland, xsetroot (the wrapper's), satellite's libraries and bsdtar. */
export const XWL_PACKAGES = ["xwayland", "x11-xserver-utils", "libxcb-cursor0", "libfontconfig1", "libarchive-tools"];

/** The same for an app that runs it with XWL_ROOTFUL. */
export const XWL_ROOTFUL_PACKAGES = ["xwayland", "x11-xserver-utils", "libdecor-0-plugin-1-cairo"];

const SAT_RPM = "xwayland-satellite-0.8.3-1.fc43.aarch64.rpm";
const SAT_SHA256 = "e721c1efd1dee42f25763c3a132fc8d063cc3ae41c9ad6208683b30a19efb986";
/** Koji keeps every build (the mirrors drop one when an update replaces it); https only. The signed copy (Fedora 43's key), the mirrors' file. */
const SAT_KOJI = `https://kojipkgs.fedoraproject.org/packages/xwayland-satellite/0.8.3/1.fc43/data/signed/31645531/aarch64/${SAT_RPM}`;
/** Where satellite lives in the guest, shared by the apps (relative to home). */
const SAT_DIR = ".local/lib/xwayland-satellite";
/** The Debian image's own copy (guest/distro/debian/pins.sh), taken first. */
const SAT_IMAGE = "/usr/lib/kw/xwayland-satellite";

/** What an app that runs XWL_SH (not XWL_ROOTFUL) puts in its `downloads`: satellite's RPM. */
export const XWL_DOWNLOAD: AppDownload = {
	url: `http://mirrors.kernel.org/fedora/updates/43/Everything/aarch64/Packages/x/${SAT_RPM}`,
	sha256: SAT_SHA256,
	size: 1599853,
	path: `~/${SAT_DIR}/${SAT_RPM}`,
	unless: `[ -x ${SAT_IMAGE} ] || [ -x ~/${SAT_DIR}/xwayland-satellite ]`,
};

/** Its first command: X's socket directory as X wants it (root's, 1777), where nothing made it yet. */
export const XWL_PREP = "[ -d /tmp/.X11-unix ] || $SUDO install -d -m 1777 /tmp/.X11-unix";

/** The script (as an app file, mode 0o755): `./xwl.sh [-g WxH] CLIENT [ARGS...]`. */
export const XWL_SH = `#!/bin/sh
# Start X, then CLIENT with DISPLAY set and the toolkits sent to X; stop X
# when CLIENT ends (Ctrl-C in this terminal, or the client's own quit). X is
# xwayland-satellite (the image's ${SAT_IMAGE}, else ~/${SAT_DIR},
# taken out of Fedora's RPM the first time): each X window a window on the page; -g is ignored. With
# XWL_ROOTFUL=1 it is Xwayland rootful instead: one window on the page (WxH:
# -g, default 1024x700), whose window manager CLIENT brings (a desktop).
set -e
size=1024x700
[ "\${1-}" = -g ] && { size=$2; shift 2; }
[ -n "\${WAYLAND_DISPLAY:-}" ] || { echo "no Wayland session: X shows as windows in the unkernel page (wland)"; exit 1; }
sat=$HOME/${SAT_DIR}
[ ! -x ${SAT_IMAGE} ] || sat=${SAT_IMAGE.slice(0, SAT_IMAGE.lastIndexOf("/"))}
if [ -z "\${XWL_ROOTFUL:-}" ] && [ ! -x "$sat/xwayland-satellite" ]; then
	mkdir -p "$sat"
	rpm=$sat/${SAT_RPM}
	echo "${SAT_SHA256}  $rpm" | sha256sum -c --quiet 2>/dev/null ||
		curl -fL# -o "$rpm" ${SAT_KOJI} ||
		{ echo "xwayland-satellite: download failed"; exit 1; }
	echo "${SAT_SHA256}  $rpm" | sha256sum -c --quiet || { rm -f "$rpm"; echo "xwayland-satellite: wrong SHA-256, deleted"; exit 1; }
	bsdtar -xOf "$rpm" ./usr/bin/xwayland-satellite >"$sat/xwayland-satellite.part"
	chmod 755 "$sat/xwayland-satellite.part"
	mv "$sat/xwayland-satellite.part" "$sat/xwayland-satellite"
	rm -f "$rpm"
fi
n=1
while [ -e /tmp/.X11-unix/X$n ] || [ -e /tmp/.X$n-lock ]; do n=$((n + 1)); done
if [ -n "\${XWL_ROOTFUL:-}" ]; then
	log=\${XDG_RUNTIME_DIR:-/tmp}/xwayland.$n.log
	Xwayland :$n -geometry "$size" -decorate -shm -noreset -nolisten tcp >"$log" 2>&1 &
	where="in a window on the page"
else
	log=\${XDG_RUNTIME_DIR:-/tmp}/xwayland-satellite.$n.log
	# wland's scale-1 socket where the relay has one (--lodpi): X sees
	# logical pixels and the page upscales its windows on HiDPI.
	case $WAYLAND_DISPLAY in /*) wl=$WAYLAND_DISPLAY ;; *) wl=\${XDG_RUNTIME_DIR:-/tmp}/$WAYLAND_DISPLAY ;; esac
	[ -S "$wl-lodpi" ] && wl=$wl-lodpi || wl=$WAYLAND_DISPLAY
	WAYLAND_DISPLAY=$wl "$sat/xwayland-satellite" :$n >"$log" 2>&1 &
	where="each X window a window on the page (xwayland-satellite, log: $log)"
fi
x=$!
trap 'kill $x 2>/dev/null || true' EXIT
trap 'exit 130' INT TERM
i=0
until [ -S /tmp/.X11-unix/X$n ]; do
	kill -0 $x 2>/dev/null || { tail -n 40 "$log"; echo "X exited ($log)"; exit 1; }
	i=$((i + 1))
	[ $i -gt 150 ] && { echo "X did not start ($log)"; exit 1; }
	sleep 0.2
done
export DISPLAY=:$n SDL_VIDEODRIVER=x11 GDK_BACKEND=x11 QT_QPA_PLATFORM=xcb XDG_SESSION_TYPE=x11
unset WAYLAND_DISPLAY
# The root window's pointer is the kw layer's (its Xwayland wrapper).
[ -z "\${XWL_ROOTFUL:-}" ] || xsetroot -solid '#1e293b' || true
# HiDPI: on wland's scale-1 socket (above) X has logical pixels and this
# finds scale 1. Elsewhere satellite gives X the page's device pixels and
# publishes the output scale as Xft.dpi (96 x scale; none at scale 1) and
# in XSETTINGS (GTK takes it there; Xft apps, xterm -fa and Xaw3dXft's
# XPaint, from Xft.dpi). XWL_SCALE (rounded, at least 1; set it to
# override) is for the rest: the cursor's size here, Qt 5's switch, a
# client script's geometry.
if [ -z "\${XWL_ROOTFUL:-}" ] && [ -z "\${XWL_SCALE:-}" ]; then
	dpi=
	i=0
	while [ $i -lt 5 ]; do
		dpi=$(xrdb -query 2>/dev/null | sed -n 's/^Xft\\.dpi:[[:space:]]*//p')
		[ -n "$dpi" ] && break
		i=$((i + 1))
		sleep 0.2
	done
	XWL_SCALE=$(( (\${dpi:-96} + 48) / 96 ))
fi
XWL_SCALE=\${XWL_SCALE:-1}
[ "$XWL_SCALE" -ge 1 ] 2>/dev/null || XWL_SCALE=1
export XWL_SCALE XCURSOR_SIZE=$((24 * XWL_SCALE)) QT_AUTO_SCREEN_SCALE_FACTOR=1
if [ "$XWL_SCALE" -gt 1 ]; then
	echo "Xcursor.size: $XCURSOR_SIZE" | xrdb -nocpp -merge 2>/dev/null || true
	xsetroot -cursor_name left_ptr 2>/dev/null || true
fi
echo "$1 on X :$n, $where: Ctrl-C here stops it and X"
"$@"
`;
