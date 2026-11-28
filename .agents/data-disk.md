# Data disk and overlay root

The data disk, the overlay root on it, safe mode, image updates and
cut-off apk runs: what they do and what a change must preserve. The base
initramfs (`guest/base/`) implements them. The template is built by
`kernel/build.sh datadisk` (kernel/guest.md), the block device is kwblk
(kernel/devices.md), the host side `js/core/block.ts` (js.md, Disks).

The template, `vendor/build/disk/kwdata.kwsparse.gz` (`kernel/build.sh
datadisk`), is reproducible (fixed UUID, hash seed and timestamps) and is
bundled as section `unkernel.datadisk` (in `unkernel.wasm`). The page keeps
the disk in IndexedDB (`web/src/data.ts`, the SDK's `openDataDisk()`). The
CLI keeps it in a file (`--data FILE`, created sparse from the template if
missing).

## The overlay root

- The base's `/init` (`guest/base/initramfs/init`, its header has the
  sequence) mounts the data disk (ext4 labelled `kwdata`, found by its
  label, never by device name) at `/data` with `noatime,commit=1`,
  `discard` if the device has it, and 1 s dirty expiry; then the distro
  image (label `kwroot`) read-only at `/kw/distro`, named by its
  `/usr/lib/kw-distro`. The root is the overlay
  `lowerdir=/kw/layer:/kw/distro` (the kw layer on top) with the upper
  layer `/data/distros/NAME/{upper,work}`, or a tmpfs without a data disk,
  in safe mode or with `kw.root=initramfs`; `pivot_root` keeps the base at
  `/run/kw-lower`. Each distro has its own upper layer, so one data disk
  serves several.
- State in `/data/distros/NAME/`: `upper`, `work`, `lower` (the image id
  the upper was last used with), `history` (image changes),
  `discard` (a pending discard), `discarded-TIME/` (set-aside changes),
  and on Debian `docker` (Docker's data root, which the docker shim puts
  there; kernel/guest.md).
  Nothing else on `/data` is read (a disk written by an earlier guest, with
  `/data/overlay`, keeps it untouched and starts with no changes).
  `/run/kw-base` describes the boot (`name=`, `image=`,
  `upper=data|tmpfs|none`, `why=`, `state=`, `dev=`, `fstype=`) for
  `kw-overlay`, `data-stop` and the page.
- **Safe mode** is deterministic and for one boot: before the switch the
  merged root is checked (its `/bin/sh` runs under `chroot`, its init,
  `/usr/local/sbin/kw-init` or else `/sbin/init`, is executable and does
  not run `/usr/bin/kwtty`: an inittab or kw-init changed before kwbox,
  kernel/guest.md, Guest tools). If that fails, or the overlay does not mount, this boot
  runs the image on a tmpfs upper with `/data` mounted and the data upper
  untouched, and says `kw-overlay: SAFE MODE: <reason>`; the next boot
  checks again, so a repair in `/data/distros/NAME/upper` (from the safe
  boot) takes effect at once. There is no attempt counter, no boot watch
  and no sticky state. An image that cannot boot even on a tmpfs upper,
  or none at all, gives the base shell (kernel/guest.md).
- `kw.root=initramfs` (the name is kept; the page's `?root=initramfs`)
  boots the plain image on a tmpfs upper with `/data` mounted;
  `kw.root=base` the base shell.
- `kw-overlay status [NAME]` (root, image, this boot's messages, a pending
  discard, the last image, the history, set-aside directories, other
  distros); `kw-overlay discard [NAME]` moves `upper` and `lower` to
  `discarded-TIME/`: at once when the changes are not mounted (safe mode,
  `kw.root=initramfs`, the base shell, another distro), at the next boot
  (the `discard` marker) when this boot runs on them.
- **Image change**: when `lower` differs from the image's
  `/usr/lib/kw-image`, the boot prints one gray line, `NAME image updated:
  ID` (`/run/kw-overlay.note`), appends to `history` and records the new
  id. Nothing in the upper layer is
  rewritten: a package database copied up earlier hides the new image's,
  and the package manager's upgrade (or a discard) brings them together.
- **Cut-off apk runs need no cleanup**: an `apk add python3` killed at
  50% and at 90% of its progress (data disk, 2026-11-19) left 362 and 185
  `.apk.<hash>` temporaries and up to 17 MiB of unpacked but unregistered
  files; other apk commands worked meanwhile, and running the same `apk
  add` again installed the packages, removed every temporary, and left
  `apk audit` clean.
  What stays until then is unowned files, harmless to apk, which
  overwrites unowned files.
- At poweroff the distro's init runs `/usr/lib/kw/shutdown`: with `/data`
  mounted it stops every process, then `/usr/lib/kw/data-stop` remounts
  `/` and `/data` read-only on a data upper (else unmounts `/data`), so
  ext4 is clean (`e2fsck -fn`).
- Tested by `test/distro.test.ts` on every distro: changes (in the user's
  home) persist; a
  deleted `/bin/sh` falls back with the SAFE MODE line, its repair from
  the safe boot works at the next boot; `kw.root=initramfs`; discard at
  the next boot and at once; an image id change prints the line once and
  goes into `history`; Alpine's and Debian's changes stay apart on one
  disk.

## Using it

- Differences from a plain root: renaming a directory from the image
  fails with EXDEV and `mv` copies; hard links to image files work (copy-up
  first); a full data disk is a full root; the shell history persists.
- A test image by hand: `mke2fs -t ext4 -b 4096 -L kwdata -m 0 -J size=8
  -E lazy_itable_init=0,lazy_journal_init=0 data.ext4 4G`, then `node
  js/cli.ts --data data.ext4` (or `--data new.img`, created from the
  template). Under Node, `--append "console=hvc0 rdinit=/init
  kw.root=initramfs" --distro alpine` is the escape hatch.

## Invariants

The lower layers are the base's `/kw/layer` and the distro image, and the
base root is remounted read-only before the switch.

- **Never use busybox `switch_root`.** It empties rootfs, which is the lower
  layer. `pivot_root` from the initramfs works because Linux mounts
  rootfs on an immutable nullfs. Rootfs is remounted read-only before the
  switch, because a lower layer must not change while in use.
- **Keep redirect_dir, index, xino and metacopy off.** Only then does
  overlayfs define offline changes to the lower layer, which is what a new
  image under an old upper layer is. Side effect: renaming a directory that
  comes from the image fails with EXDEV, and `mv` falls back to copying.
- **Everything that decides whether to use the upper layer runs from the
  base or the read-only image** (the base's `/init`), so no change on
  `/data` can break the decision. Keep it that way.
- The console line `kw-overlay: SAFE MODE: <reason>` is what the page
  watches for (`web/src/boot.ts`). Keep that prefix.
- `kw.root=initramfs` on the command line boots the plain root once, with
  `/data` (page: `?root=initramfs` and the *Safe mode* button), and
  `kw.root=base` the base shell. Change an upper layer only from such a
  boot (or safe mode, or another distro), because changing an upper layer
  while it is mounted is undefined.

## Numbers

overlayfs adds 116 KiB (43 KiB gzip) to the kernel. Boot times are in
kernel/guest.md (Distro images).

## Persistence in the browser

- The store `kwdisk:kwdata-v1` is keyed by the format version, not by the
  template or an ETag. It is never cleared or reseeded implicitly, and a
  new template does not touch saved disks. A layout change needs a new version, plus a migration or the user's
  export/import. If the identity's format does not match, the page runs
  a fresh in-memory disk and says why.
- Its size is in the identity. The template is 4 GiB; Settings' Disk size
  (`?datasize=`, GiB) makes a new disk larger, or grows a saved one at the
  next boot without a suspended session that has the data disk to resume
  (its kernel knows the old size), clamped to the browser's quota for
  the page (a larger disk would fail its writes with EIO once the quota
  is used up): `openDataDisk({ size })` relabels the
  identity, the new space reads as zeros, and a disk never shrinks. The
  base's `/init` grows the file system to the device after mounting
  `/data` (`kwbox growfs`, `EXT4_IOC_RESIZE_FS`; 4 to 16 GiB in 40 ms,
  2026-11-22), so a CLI `--data` file made larger with `truncate` grows
  too. An import takes an image of any size.
- On first use the template's blocks are copied into the store in one
  transaction, which also marks the store initialized.
- The disk has a volatile write cache. Each guest flush saves every block
  written before it in one IndexedDB transaction (durability `strict`) and
  completes when that transaction commits. So the saved state is always the
  state at some completed flush, which ext4's journal handles like a power
  cut. A block leaves memory only after the save that holds it commits.
  Buffers handed to a save are frozen (copied before a later write). Keep
  every save one transaction.
- A failed save leaves its blocks dirty and returns EIO for that flush. The
  page reports it (a full quota as `QuotaExceededError`).
- One tab at a time: a Web Lock (`kwdisk:kwdata`), or a BroadcastChannel
  probe where Web Locks are missing. A tab without the lock gets an
  in-memory snapshot and a warning.
- Worker mode (`?worker=1`): the page still takes the lock,
  then sends the disk as a spec (`{ kind: "data", template: "bundled",
  mode }`, mode "snapshot" without the lock) and the kernel worker opens the
  store and is its only writer while it runs; the page's thread does not
  open `kwdisk:kwdata-v1`. Export asks the worker for the parts. Import and
  reset first ask the worker to detach the disk (stop its saves, wait for
  the one in flight, close its connection), and refuse while the kernel is
  still starting. The worker reports the kernel's exit only after the saves
  in flight have settled, because ending a worker aborts its transactions.
- Machine snapshots do not copy the disk (js.md, Disks in snapshots).
  The store's meta keeps a random `uid` (new when the store is created,
  seeded, imported or cleared) and `gen`, the disk's write generation,
  written in the same transaction as the blocks of the first save of each
  generation. A snapshot records them; a restore refuses the disk if
  either differs, because the restored kernel's ext4 caches (bitmaps,
  inodes, the journal position) would not match it and its next writes
  would corrupt the file system. Never let a restore through with a
  mismatch. A snapshot (the page's suspended session, a CLI `--restore`
  file) made by another guest architecture's kernel is refused anyway:
  its `linux_banner` (the fingerprint) differs, and in builds the page
  compares the hashed kernel URL first. The CLI's file data disk keeps the generation in
  `FILE.kwsnap`. The guest mounts `/data` with `commit=1` and 1 s dirty
  expiry, so a machine that keeps running after a snapshot usually makes
  it unrestorable within seconds; `snapshot({ stop: true })` (the CLI's
  `{suspend=FILE}`) or `snapshot({ commit })` (the page's Suspend, web.md:
  stopped only once the session is stored, else it runs on and the record
  never claims the disk) is the way to save a machine with its data disk.
- The page calls `sync()` when it is hidden (unless it suspends at once
  then, which seals the disks; web.md, Suspend and resume), on `pagehide`
  and before Reboot. Export, import and reset (`KW.exportData()`, `importData()`,
  `resetData()`) first stop the running disk's saves and refuse while
  another tab holds the lock.

## Known limits

- A root whose `/bin/sh` runs but whose init or profile hangs or exits is
  not caught (the check is deterministic); `kw.root=initramfs` or
  `kw.root=base` gets in, and a repair or `kw-overlay discard` from
  there.
- After an image change the upper layer's copy of a package database
  hides the new image's until the package manager upgrades (above).
- Set-aside directories (`discarded-*`) are never deleted automatically.
- There is no e2fsck in the base. After an unclean stop, the journal is
  replayed on the next mount.
- An export or import of the data disk is held in memory as a whole.
- Without a data disk the changes are in RAM (a tmpfs upper), so `apk
  add` must fit in it.
