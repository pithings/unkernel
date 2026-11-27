// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's own apps (kind "page"): Terminal, Browser (hidden: it opens when
// an app or the guest asks for it), Settings, System and Docs.
// An inline group: the launcher shows them at its top level, ahead of the
// folders. One file per app in this folder, listed below in the order shown.
import { defineGroup } from "../types.ts";
import browser from "./browser.ts";
import docs from "./docs.ts";
import settings from "./settings.ts";
import system from "./system.ts";
import terminal from "./terminal.ts";

export default defineGroup({ id: "system", title: "System", desc: "The page's own apps", inline: true }, [terminal, browser, settings, system, docs]);
