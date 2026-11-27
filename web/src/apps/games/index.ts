// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The launcher's Games folder: games on the guest's display (its
// framebuffer, or X on its DRM device: xkms.ts) and as Wayland windows on
// the page (SDL with OpenGL, GTK).
// One file per app in this folder, listed below in the order it shows them.
import { defineGroup } from "../types.ts";
import doom from "./doom.ts";
import glimmer from "./glimmer.ts";
import puzzles from "./puzzles.ts";
import fourInARow from "./four-in-a-row.ts";
import tali from "./tali.ts";
import neverball from "./neverball.ts";
import armagetronad from "./armagetronad.ts";
import blobby from "./blobby.ts";
import openarena from "./openarena.ts";
import minecraft from "./minecraft.ts";
import steam from "./steam.ts";
import bzflag from "./bzflag.ts";
import teeworlds from "./teeworlds.ts";
import chromiumBsu from "./chromium-bsu.ts";
import extremetuxracer from "./extremetuxracer.ts";
import lugaru from "./lugaru.ts";
import supertuxkart from "./supertuxkart.ts";
import pinball from "./pinball.ts";
import foobillardplus from "./foobillardplus.ts";
import xmoto from "./xmoto.ts";
import triggerRally from "./trigger-rally.ts";

export default defineGroup({
	id: "games", title: "Games", desc: "Games on the guest's display and in windows",
	// A gamepad.
	icon: { svg: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7.5h10a4.5 4.5 0 0 1 4.3 5.8l-1 3.4a2.3 2.3 0 0 1-3.9.9l-1.9-2.1h-5l-1.9 2.1a2.3 2.3 0 0 1-3.9-.9l-1-3.4A4.5 4.5 0 0 1 7 7.5Z"/><path d="M8 10.5v3M6.5 12h3"/><path d="M15.5 11.2h.01M17.5 12.8h.01" stroke-width="2.6"/></g>' },
	colors: ["#f43f5e", "#4c0519"],
}, [
	doom, minecraft, steam, openarena, bzflag, teeworlds, chromiumBsu, glimmer, neverball, armagetronad, lugaru,
	supertuxkart, extremetuxracer, xmoto, triggerRally, pinball, foobillardplus, blobby, puzzles, fourInARow, tali,
]);
