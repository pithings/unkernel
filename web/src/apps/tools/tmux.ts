// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// tmux: a session laid out in three panes (a shell showing the README, htop,
// and a loop printing the system's state), styled like the page. Running it
// again attaches to the session if it still runs. tmux keeps its own prefix,
// Ctrl-B, since the page takes Ctrl-A (Ctrl-A twice sends one on; not on a Mac).
import type { TerminalApp } from "../types.ts";

const CONF = `# The unkernel tmux demo's settings (source-file'd into the server).
set -g mouse on
set -g base-index 1
setw -g pane-base-index 1
set -g status-style "bg=#0a0a0a,fg=#a1a1a1"
set -g status-left " #[fg=#52a8ff,bold]unkernel#[default] "
set -g status-left-length 20
set -g status-right " #(uname -m) · up #(cut -d. -f1 /proc/uptime)s · %H:%M "
set -g window-status-current-style "bg=#ededed,fg=#000000"
set -g pane-border-style "fg=#333333"
set -g pane-active-border-style "fg=#52a8ff"
set -g message-style "bg=#ededed,fg=#000000"
`;

const LAYOUT = `#!/bin/sh
# Builds the demo session: the shell left, htop top right, stats bottom right.
# Panes are addressed by id: the session's first window predates
# tmux.conf's base-index, so its index is 0. A failed layout leaves no
# half-built session behind for the next run to attach to.
set -e
cd "$(dirname "$0")"
trap 'tmux kill-session -t demo 2>/dev/null' EXIT
tmux new-session -d -s demo -n unkernel -c "$PWD"
tmux source-file "$PWD/tmux.conf"
shell=$(tmux display-message -p -t demo:unkernel '#{pane_id}')
top=$(tmux split-window -h -P -F '#{pane_id}' -t "$shell" -c "$PWD" htop)
tmux split-window -v -t "$top" -c "$PWD" "sh ./stats.sh"
tmux select-pane -t "$shell"
tmux send-keys -t "$shell" "cat README" Enter
trap - EXIT
`;

const STATS = `#!/bin/sh
# The bottom right pane: the system's state every 2 s.
while :; do
	printf '\\033[H\\033[J'
	printf '\\033[1m%s\\033[0m on %s\\n\\n' "$(uname -sr)" "$(uname -m)"
	uptime
	echo
	free -m
	echo
	df -h / /data 2>/dev/null
	sleep 2
done
`;

const README = `tmux in unkernel: a terminal multiplexer, the distro's aarch64 build,
running on Linux in this browser tab.

  Ctrl-B %   split left and right        Ctrl-B "   split top and bottom
  Ctrl-B o   next pane (or click one)    Ctrl-B z   zoom the pane
  Ctrl-B c   new window                  Ctrl-B n   next window
  Ctrl-B d   detach (./run.sh attaches again)

tmux's prefix is Ctrl-B here: the page itself uses Ctrl-A (not on a Mac).
q quits htop. The settings are in tmux.conf, the layout in layout.sh.
`;

export default {
	id: "tmux",
	title: "tmux",
	desc: "A terminal multiplexer with panes for a shell, htop and live system stats",
	// The tmux logo, from Simple Icons (CC0 1.0), slug tmux, in its green.
	icon: { svg: '<path fill="#1bb91f" d="M24 2.251V10.5H12.45V0h9.3A2.251 2.251 0 0 1 24 2.251zM12.45 11.4H24v10.5h-.008A2.25 2.25 0 0 1 21.75 24H2.25a2.247 2.247 0 0 1-2.242-2.1H0V2.251A2.251 2.251 0 0 1 2.25 0h9.3v21.6h.9V11.4zm11.242 10.5H.308a1.948 1.948 0 0 0 1.942 1.8h19.5a1.95 1.95 0 0 0 1.942-1.8z"/>', viewBox: "-1.5 -1.5 27 27" },
	colors: ["#3f3f46", "#0c0c0e"],
	files: {
		"tmux.conf": CONF,
		"layout.sh": { content: LAYOUT, mode: 0o755 },
		"stats.sh": { content: STATS, mode: 0o755 },
		"README": README,
	},
	packages: { alpine: ["tmux", "htop"], arch: ["tmux", "htop"], debian: ["tmux", "htop"] },
	terminal: "window",
	commands: [
		"tmux has-session -t demo 2>/dev/null || ./layout.sh",
		"tmux attach -t demo",
	],
} satisfies TerminalApp;
