// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Xfce: the Xfce 4.20 desktop (xfwm4, the panel, xfdesktop, Thunar,
// xfce4-terminal) on an X screen in a window on the page's Wayland desktop
// (Xwayland rootful, xwl.ts; Debian), in a session bus of its own. Its core
// parts only, not the xfce4 metapackage (which brings the PulseAudio panel
// plugin): about 64 MiB to download, 262 MiB installed, GTK 3 included (the
// image's package lists, 2026-11-22). The first start gets presets where
// there are no settings yet (setup.sh): the default panel (no first-run
// dialog), xfwm4's compositor off (it would draw in software here: X has no
// GPU GL), Adwaita dark like the page. Log Out ends the session and X. Its
// window is Xwayland's, which stands for the X11 app (x11.ts) on the Dock.
import type { TerminalApp } from "../types.ts";
import { XWL_PREP, XWL_ROOTFUL_PACKAGES, XWL_SH } from "../xwl.ts";

const XFCONF = "~/.config/xfce4/xfconf/xfce-perchannel-xml";

export default {
	id: "xfce",
	title: "Xfce",
	desc: "The Xfce desktop in a window on the page, through Xwayland",
	// A screen with a panel along its bottom, on a stand (crafted).
	icon: { svg: '<path fill-rule="evenodd" d="M3 3h18a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm1 2v9h16V5Z"/><path d="M9 19.5h6V21H9Z"/>' },
	colors: ["#3b82f6", "#1e3a8a"],
	needs: { net: true, wayland: true },
	packages: {
		debian: [...XWL_ROOTFUL_PACKAGES, "xfce4-session", "xfwm4", "xfce4-panel", "xfdesktop4", "xfce4-settings",
			"xfce4-terminal", "thunar", "dbus-x11", "librsvg2-common", "fonts-dejavu-core"],
	},
	files: {
		"xwl.sh": { content: XWL_SH, mode: 0o755 },
		"setup.sh": {
			mode: 0o755,
			content: "#!/bin/sh\n" +
				"# Presets for Xfce's first start, each only where there is no such\n" +
				"# setting yet (Xfce keeps what you change there).\n" +
				`d=${XFCONF.replace("~", "$HOME")}\n` +
				"mkdir -p \"$d\"\n" +
				"[ -f \"$d/xfce4-panel.xml\" ] || cp /etc/xdg/xfce4/panel/default.xml \"$d/xfce4-panel.xml\"\n" +
				"[ -f \"$d/xfwm4.xml\" ] || cp xfwm4.xml \"$d/\"\n" +
				"[ -f \"$d/xsettings.xml\" ] || cp xsettings.xml \"$d/\"\n",
		},
		"xfwm4.xml": '<?xml version="1.0" encoding="UTF-8"?>\n' +
			'<channel name="xfwm4" version="1.0">\n' +
			'  <property name="general" type="empty">\n' +
			'    <property name="use_compositing" type="bool" value="false"/>\n' +
			'  </property>\n' +
			"</channel>\n",
		"xsettings.xml": '<?xml version="1.0" encoding="UTF-8"?>\n' +
			'<channel name="xsettings" version="1.0">\n' +
			'  <property name="Net" type="empty">\n' +
			'    <property name="ThemeName" type="string" value="Adwaita-dark"/>\n' +
			'    <property name="IconThemeName" type="string" value="Adwaita"/>\n' +
			'  </property>\n' +
			"</channel>\n",
	},
	commands: [XWL_PREP, "./setup.sh", "XWL_ROOTFUL=1 XDG_CURRENT_DESKTOP=XFCE ./xwl.sh -g 1280x800 dbus-run-session -- xfce4-session"],
} satisfies TerminalApp;
