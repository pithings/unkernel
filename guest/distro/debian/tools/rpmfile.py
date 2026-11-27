# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
"""Write one file of an RPM package to stdout: rpmfile.py RPM PATH.

The Debian image takes xwayland-satellite's binary out of Fedora's RPM
(build.sh) on hosts that may have neither rpm2cpio nor bsdtar. An RPM is a
96-byte lead, the signature header (padded to 8 bytes), the main header and
the payload: a cpio archive (newc) compressed with zstd (Fedora 31 and
later; the zstd command, which the build has anyway), xz or gzip. PATH is
as the archive names it, with or without the leading "./".
"""
import gzip
import lzma
import subprocess
import sys

HEADER_MAGIC = b"\x8e\xad\xe8\x01"


def header_end(data: bytes, off: int, pad: bool) -> int:
    if data[off:off + 4] != HEADER_MAGIC:
        sys.exit(f"rpmfile: no RPM header at {off}")
    count = int.from_bytes(data[off + 8:off + 12], "big")
    size = int.from_bytes(data[off + 12:off + 16], "big")
    end = off + 16 + 16 * count + size
    return (end + 7) & ~7 if pad else end


def payload(raw: bytes) -> bytes:
    if raw[:4] == b"\x28\xb5\x2f\xfd":
        return subprocess.run(["zstd", "-dcq"], input=raw, stdout=subprocess.PIPE, check=True).stdout
    if raw[:6] == b"\xfd7zXZ\x00":
        return lzma.decompress(raw)
    if raw[:2] == b"\x1f\x8b":
        return gzip.decompress(raw)
    sys.exit("rpmfile: unknown payload compression")


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("usage: rpmfile.py RPM PATH")
    data = open(sys.argv[1], "rb").read()
    if data[:4] != b"\xed\xab\xee\xdb":
        sys.exit(f"rpmfile: {sys.argv[1]}: not an RPM")
    off = header_end(data, 96, True)
    off = header_end(data, off, False)
    cpio = payload(data[off:])
    want = sys.argv[2].removeprefix("./")
    pos = 0
    while pos + 110 <= len(cpio):
        h = cpio[pos:pos + 110]
        if h[:6] not in (b"070701", b"070702"):
            sys.exit("rpmfile: not a newc cpio payload")
        size = int(h[54:62], 16)
        namesize = int(h[94:102], 16)
        name = cpio[pos + 110:pos + 110 + namesize - 1].decode()
        start = (pos + 110 + namesize + 3) & ~3
        if name == "TRAILER!!!":
            break
        if name.removeprefix("./") == want:
            sys.stdout.buffer.write(cpio[start:start + size])
            return
        pos = (start + size + 3) & ~3
    sys.exit(f"rpmfile: {want}: not in the package")


main()
