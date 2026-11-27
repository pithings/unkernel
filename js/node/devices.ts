// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Node device kinds (core/devices.ts): "file" disks and "direct"
// networking over host sockets. Used by the Node platform on the caller's
// thread and by the kernel worker (worker-entry.ts).

import { coreDevices, extendDevices, type DeviceContext, type DeviceRegistry, type FileDiskSpec } from "../core/devices.ts";
import { CowDisk } from "../core/block.ts";
import { FileBase, FileDisk } from "./disk.ts";
import { directBackend } from "./net.ts";

export const nodeDevices: DeviceRegistry = extendDevices(coreDevices, {
	disks: {
		file: (spec: FileDiskSpec, ctx: DeviceContext) =>
			spec.snapshot && !spec.readOnly ? new CowDisk(new FileBase(spec.path), { log: ctx.log }) : new FileDisk(spec.path, { readOnly: spec.readOnly }),
	},
	backends: {
		direct: () => directBackend(),
	},
});
