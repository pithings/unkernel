# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# commands.py FILES... > MAP: the command -> package map of the Arch image
# (/usr/lib/kw-commands, read by kw-pacman-install), one "NAME PACKAGE" line
# per command, sorted. From the file lists of the repositories (core.files,
# extra.files, alarm.files: a tar.gz with a `files` list per package): every
# file directly in /usr/bin. Where several packages ship a command, the one
# picked is the shortest name, then the name (go: go, not gcc-go); ALIASES
# overrides it (vim has no vi: ex-vi-compat does).
import re, sys, tarfile

ALIASES = {"vi": "vim"}

line = re.compile(r"^usr/bin/([^/\s]+)$")
cmds = {}
for f in sys.argv[1:]:
    with tarfile.open(f) as t:
        for m in t:
            if not m.isfile() or not m.name.endswith("/files"):
                continue
            pkg = m.name.rsplit("/", 1)[0].rsplit("-", 2)[0]
            for l in t.extractfile(m).read().decode("utf-8", "replace").splitlines():
                c = line.match(l)
                if c:
                    key = (len(pkg), pkg)
                    if c.group(1) not in cmds or key < cmds[c.group(1)][0]:
                        cmds[c.group(1)] = (key, pkg)
for c in sorted(cmds):
    print(c, ALIASES.get(c, cmds[c][1]))
