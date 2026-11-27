// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// nodeFs(): a host directory as an Fs (core/fs.ts), on node:fs/promises,
// for vm.mount() and the CLI's --mount.
//
//   await vm.mount("/work", nodeFs("./project"));
//   await vm.mount("/ref", nodeFs("/usr/share/doc"), { readOnly: true });
//
// Paths from the 9p server are absolute, normalised and walked one name at
// a time, and the server never walks through a symlink, so a path stays
// below `dir`. Symlinks are listed and read as symlinks (lstat, readlink)
// and never followed here: the guest resolves them itself, inside its own
// tree. Opens use O_NOFOLLOW, and O_NONBLOCK so that a FIFO in the tree
// cannot block a libuv thread (anything but a regular file refuses to
// open). Not covered: the host swapping a directory for a symlink between
// the guest's walk and its next request (that request could then reach
// outside `dir`; Node has no openat2 RESOLVE_BENEATH).
//
// Owners: every file shows uid and gid 1000 (FS_DEFAULT_OWNER: the distro
// images' user, the guest's default), and chown is accepted and ignored,
// since host and guest ids mean different users.
// Permission bits, sizes, times, hard link counts and inode numbers
// (st_dev, st_ino, in readdir too) are the host's. Names that are not
// UTF-8 are left out of listings (the guest could not name them).

import { constants } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { FsError, type Fs, type FsAttr, type FsDirEntry, type FsFile, type FsStatFs } from "../core/fs.ts";

const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC } = constants;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const utf8 = new TextDecoder("utf-8", { fatal: true });

type BigStats = Awaited<ReturnType<typeof fsp.lstat>> & { ino: bigint; dev: bigint; mtimeNs: bigint; atimeNs: bigint; ctimeNs: bigint; size: bigint; nlink: bigint; mode: bigint };

function attrOf(st: BigStats): FsAttr {
	return {
		type: st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : "file",
		mode: Number(st.mode) & 0o7777,
		size: Number(st.size),
		nlink: Number(st.nlink),
		atimeMs: Number(st.atimeNs) / 1e6,
		mtimeMs: Number(st.mtimeNs) / 1e6,
		ctimeMs: Number(st.ctimeNs) / 1e6,
		ino: st.ino,
		dev: st.dev,
	};
}

const lstat = (p: string) => fsp.lstat(p, { bigint: true }) as Promise<BigStats>;

/** An open host file for the guest: positional reads and writes on one FileHandle (it survives renames and unlink). */
function openFile(fh: fsp.FileHandle, writable: boolean): FsFile {
	return {
		async read(offset, length) {
			const buf = new Uint8Array(length);
			let n = 0;
			while (n < length) {
				const { bytesRead } = await fh.read(buf, n, length - n, offset + n);
				if (!bytesRead) break;
				n += bytesRead;
			}
			return n === length ? buf : buf.subarray(0, n);
		},
		write: writable ? async (offset, data) => {
			let n = 0;
			while (n < data.length) {
				const { bytesWritten } = await fh.write(data, n, data.length - n, offset + n);
				if (!bytesWritten) throw new FsError("EIO", "a write wrote nothing");
				n += bytesWritten;
			}
			return n;
		} : undefined,
		getattr: async () => attrOf((await fh.stat({ bigint: true })) as BigStats),
		async setattr(attr) {
			if (attr.size !== undefined) {
				if (!writable) throw new FsError("EBADF");
				await fh.truncate(attr.size);
			}
			if (attr.mode !== undefined) await fh.chmod(attr.mode);
			if (attr.atimeMs !== undefined || attr.mtimeMs !== undefined) {
				const st = await fh.stat();
				await fh.utimes((attr.atimeMs ?? st.atimeMs) / 1000, (attr.mtimeMs ?? st.mtimeMs) / 1000);
			}
		},
		fsync: () => fh.sync(),
		close: () => fh.close(),
	};
}

/** Open `p` for the guest: never through a final symlink, never block, only regular files. */
async function openRegular(p: string, flags: number, mode?: number): Promise<FsFile> {
	const fh = await fsp.open(p, flags | O_NOFOLLOW | O_NONBLOCK, mode);
	try {
		const st = await fh.stat();
		if (!st.isFile()) throw new FsError(st.isDirectory() ? "EISDIR" : "EPERM", `${p}: not a regular file`);
		return openFile(fh, (flags & 3) !== O_RDONLY);
	} catch (e) {
		await fh.close().catch(() => {});
		throw e;
	}
}

/** A host directory as an Fs (see the top of this file). Mount it with { readOnly: true } to refuse changes. */
export function nodeFs(dir: string): Fs {
	const root = path.resolve(dir);
	const real = (p: string): string => {
		if (!p.startsWith("/") || p.includes("\0") || p.split("/").some((c) => c === ".." || c === ".")) throw new FsError("EINVAL", `bad path ${JSON.stringify(p)}`);
		return p === "/" ? root : root + p;
	};
	return {
		async getattr(p) {
			return attrOf(await lstat(real(p)));
		},
		async readdir(p) {
			const dir = real(p);
			const list = await fsp.readdir(dir, { encoding: "buffer" });
			const out: Array<FsDirEntry | undefined> = [];
			// lstat each entry, so that the guest's d_ino (ls -i) is the inode number stat shows.
			for (let i = 0; i < list.length; i += 64) {
				out.push(...await Promise.all(list.slice(i, i + 64).map(async (raw) => {
					let name: string;
					try {
						name = utf8.decode(raw);
					} catch {
						return undefined; // not UTF-8: the guest could not name it
					}
					const a = await lstat(`${dir}/${name}`).then(attrOf, () => undefined);
					return a && { name, type: a.type, ino: a.ino, dev: a.dev };
				})));
			}
			return out.filter((e) => e !== undefined);
		},
		async readlink(p) {
			try {
				return utf8.decode(await fsp.readlink(real(p), { encoding: "buffer" }));
			} catch (e) {
				if (e instanceof TypeError) throw new FsError("EILSEQ", "a link target that is not UTF-8");
				throw e;
			}
		},
		open(p, flags) {
			const acc = flags.write ? (flags.read ? O_RDWR : O_WRONLY) : O_RDONLY;
			return openRegular(real(p), acc | (flags.truncate ? O_TRUNC : 0));
		},
		create(p, mode) {
			return openRegular(real(p), O_RDWR | O_CREAT | O_EXCL, mode);
		},
		async mkdir(p, mode) {
			await fsp.mkdir(real(p), { mode });
		},
		async symlink(p, target) {
			await fsp.symlink(target, real(p));
		},
		async remove(p, isDir) {
			if (isDir) await fsp.rmdir(real(p));
			else await fsp.unlink(real(p));
		},
		async rename(from, to) {
			await fsp.rename(real(from), real(to));
		},
		async link(target, p) {
			// link(2) follows a symlink in the source on some hosts (Darwin), which would make a second name,
			// inside this directory, for a file outside it. So the source must be a regular file, and the new
			// name must be that file: a symlink renamed into place between the two calls is undone.
			const from = real(target), to = real(p);
			const want = await fsp.lstat(from);
			if (!want.isFile()) throw new FsError("EPERM", `a hard link to something that is not a regular file: ${target}`);
			await fsp.link(from, to);
			const made = await fsp.lstat(to);
			if (made.ino !== want.ino || made.dev !== want.dev) {
				await fsp.unlink(to).catch(() => {});
				throw new FsError("EPERM", `${target} changed while it was linked`);
			}
		},
		async setattr(p, attr) {
			const rp = real(p);
			const st = await fsp.lstat(rp);
			if (st.isSymbolicLink()) {
				// Only times can change on a link itself (Linux has no lchmod); never touch its target.
				if (attr.size !== undefined) throw new FsError("EINVAL");
				if (attr.atimeMs !== undefined || attr.mtimeMs !== undefined)
					await fsp.lutimes(rp, (attr.atimeMs ?? st.atimeMs) / 1000, (attr.mtimeMs ?? st.mtimeMs) / 1000);
				return;
			}
			if (attr.size !== undefined) {
				const f = await openRegular(rp, O_WRONLY);
				try {
					await f.setattr!({ size: attr.size });
				} finally {
					await f.close!();
				}
			}
			if (attr.mode !== undefined) await fsp.chmod(rp, attr.mode);
			if (attr.atimeMs !== undefined || attr.mtimeMs !== undefined)
				await fsp.utimes(rp, (attr.atimeMs ?? st.atimeMs) / 1000, (attr.mtimeMs ?? st.mtimeMs) / 1000);
		},
		async statfs(): Promise<FsStatFs> {
			const s = await fsp.statfs(root);
			return { bsize: s.bsize, blocks: s.blocks, bfree: s.bfree, bavail: s.bavail, files: s.files, ffree: s.ffree };
		},
	};
}
