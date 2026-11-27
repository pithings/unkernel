// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's guest network: the SDK's NetStack over Wisp servers, with the
// plain-HTTP hosts of the route table (config.ts DEFAULT_ROUTES) answered by
// fetch() (the SDK's fetchRoutes()).
import { NetStack, fetchRoutes, wispBackend, type NetSpec } from "./sdk.ts";

/**
 * The page's Wisp server, the project's own. It accepts only the page's
 * origins (unkernel.dev, and localhost for the dev server); a page served
 * elsewhere needs its own (?wisp=).
 */
export const DEFAULT_WISP_SERVERS: readonly string[] = Object.freeze(["wss://wisp.unkernel.dev:6680/"]);

/** Guest-visible host name to base URL; null or empty: none. */
type Routes = Record<string, string> | null;

/**
 * The page's network: a NetStack whose backend is the fastest of the Wisp
 * servers (default: DEFAULT_WISP_SERVERS), or none when `enabled` is
 * false (config.ts: `?net=0`, `?wisp=0`; `?wisp=URL[,URL...]` sets `servers`;
 * `routes` is config.ts DEFAULT_ROUTES unless `?routes=0`).
 */
export function browserNet(opts: { enabled: boolean; servers: string[] | null; routes: Routes; log?: (m: string) => void }): NetStack | undefined {
	if (!opts.enabled) return undefined;
	const wisp = wispBackend(opts.servers ?? [...DEFAULT_WISP_SERVERS], { log: opts.log });
	const backend = opts.routes && Object.keys(opts.routes).length ? fetchRoutes(wisp, opts.routes, { log: opts.log }) : wisp;
	return new NetStack({ backend, log: opts.log });
}

/** The same network as a spec, for worker mode (?worker=1): the worker builds the NetStack and opens the WebSocket. */
export function browserNetSpec(opts: { enabled: boolean; servers: string[] | null; routes: Routes }): NetSpec | undefined {
	if (!opts.enabled) return undefined;
	return { kind: "net", backend: { kind: "wisp", servers: opts.servers ?? [...DEFAULT_WISP_SERVERS], routes: opts.routes ?? undefined } };
}
