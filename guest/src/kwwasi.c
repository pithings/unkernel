// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * kwwasi: run a WebAssembly WASI program (wasm32-wasi, preview 1 or 0) on the
 * host's wasm engine (static aarch64 musl), /usr/lib/kw/kwwasi in the
 * base's kw layer (a link to kwbox, kwbox.c). /usr/lib/kw/rc registers it
 * with binfmt_misc for the magic "\0asm\1\0\0\0" with flag P, so the
 * kernel runs it as
 *
 *   kwwasi PATH ARGV0 [ARG...]
 *
 * for an executable .wasm file. PATH is the file name exec was given (for
 * a program found through $PATH, the shell's full path; a symlink's own
 * name, not its target). The program's argv[0] is ARGV0, except that an
 * ARGV0 without a slash (found through $PATH) becomes PATH, so a program
 * that finds its files from argv[0] (CPython's stdlib) works from $PATH,
 * and a multicall program still sees the name it was called by. The host
 * side is js/core/wasi-exec.ts. This process stays the program as far as
 * the guest can tell: it connects to the host (AF_VSOCK, CID 2, port
 * 1021), sends the module (unless the host has it already), its arguments,
 * its environment and its preopened directory, and then does every file
 * operation the program asks for itself, with its own descriptors, cwd and
 * credentials, until the host says the program exited. It exits with that
 * code. A signal that kills it (Ctrl-C, SIGKILL, SIGPIPE) closes the
 * connection, and the host terminates the program's worker at once, even
 * in the middle of a computation.
 *
 * WASI descriptors are this process's: 0, 1 and 2 are inherited, and the
 * one preopened directory, "/", is descriptor 3 (an inherited descriptor 3
 * is replaced; 4 and up stay). The connections and kwwasi's own
 * descriptors sit at 512 or above.
 *
 * Sockets are this process's too: one the program inherited (a listening
 * one, or a connection, as `nc -l -e` gives its program on 0 and 1) works
 * with preview 1's sock_accept, sock_recv, sock_send and sock_shutdown and
 * with fd_read, fd_write, fd_close, fd_fdstat_get (socket_stream or
 * socket_dgram), fd_fdstat_set_flags (O_NONBLOCK) and poll_oneoff. Preview 1
 * has no socket(), bind(), listen() or connect(), so for a program to have a
 * listening socket of its own, KWWASI_TCPLISTEN=ADDR:PORT[,ADDR:PORT...]
 * (as wasmtime's --tcplisten) opens each as a listening TCP socket at
 * descriptors 4, 5, ... in order (exit 126 when one of those is already
 * open, inherited); ADDR is a numeric IPv4 address, [IPv6] or empty (any IPv4 address). A
 * write to a socket whose peer has gone fails with EPIPE instead of raising
 * SIGPIPE (send() with MSG_NOSIGNAL): a WASI program cannot ignore a signal.
 * Writes to pipes still raise it, as for any process.
 *
 * Paths and the cwd: a WASI program has no cwd. wasi-libc (and so Rust's
 * std and CPython) keeps its own, which starts as "/", makes a relative
 * path absolute against it, strips the leading "/" and hands the rest to
 * the preopen with the longest matching name: "/etc/hostname" and
 * "etc/hostname" both reach path_open as (3, "etc/hostname"). Only where
 * chdir() is not linked does a "./x" arrive as "./x". So what the program
 * meant cannot be told, and in a cwd other than "/" (KWWASI_CWD unset or
 * "auto"), resolve() picks for each path on descriptor 3 by what exists
 * now: "/x" is absolute, ".", "./x", "../x" are the cwd's; otherwise the
 * first component goes where it exists (the cwd for a new name); where both
 * the cwd and "/" have it, where the whole path (else its parent) exists in
 * only one; still undecided, the cwd. Such a collision prints one warning
 * per run on stderr. Descriptor 3 itself (fd_readdir, fstat) is the cwd.
 * KWWASI_CWD: "auto" (as unset, no warning), "root" (undecided collisions
 * go to "/", no warning), "cwd" (no guessing: "/x" is absolute and every
 * other path is the cwd's, for a program that keeps the leading "/", as
 * Zig's std does; wasi-libc's absolute paths then miss), "off" (no cwd: descriptor 3 is "/" and every path
 * is from "/", as for a WASI runtime with only "/" preopened). A cwd this
 * process may not search gives EACCES for paths in it, as on Linux.
 *
 * Threads (wasi-threads: a module that imports wasi.thread-spawn and a
 * shared env.memory): each wasm thread has a connection of its own, served
 * by a pthread of this process, so that a thread blocked in a read of its
 * stdin holds up no other thread's calls, and they all share this process's
 * descriptors, cwd and credentials. A thread-spawn is a request on the
 * spawning thread's connection (R_SPAWN): kwwasi starts the pthread, which
 * connects anew and sends THREAD (the program's token, which MODULE gave,
 * its tid and the start argument) before R_SPAWN is answered with the tid;
 * the tid is that pthread's Linux tid (positive, unique among the program's
 * live threads, and what ps shows). EXIT comes on the program's connection
 * and ends the process, every thread with it; the host closes a thread's
 * connection when the wasm thread returned, which ends only its pthread
 * (lost()). The state of a connection (sock, rx, host_spoke) is
 * thread-local, so a program without threads pays nothing for them: no
 * locks and no other system calls.
 *
 * Protocol (version 3): frames both ways, u32 op, u32 payload length, then
 * the payload; integers little-endian. Strings are a u32 length and bytes.
 * Requests go one at a time on each connection.
 *
 *   guest -> host  1 START    u32 version (3), u32 argc, u32 envc, u32
 *                             preopens, the module's identity, u64
 *                             CLOCK_REALTIME, u64 CLOCK_MONOTONIC (ns, read
 *                             just before START is sent), then argc
 *                             strings, envc strings, preopens x (u32 fd,
 *                             string name)
 *                  7 THREAD   the first frame of a wasm thread's
 *                             connection: u32 version, the program's
 *                             token (TOKEN bytes), u32 tid, u32 start
 *                             argument
 *                  2 REPLY    i32 errno (Linux, 0 for success), then the
 *                             request's result
 *                  5 DATA     the next piece of the module (at most
 *                             CHUNK bytes), after MODULE asked for it
 *                  6 END      the module's identity once it was read (the
 *                             host remembers the identity only when it is
 *                             the one START gave)
 *   host -> guest  4 MODULE   u32 1: send the module (DATA until its size,
 *                             then END), 0: the host has it; then the
 *                             program's token (TOKEN bytes)
 *                  3 EXIT     u32 status, then a message for stderr
 *                             (may be empty); the guest exits with status
 *                  16.. requests, one at a time, each answered by REPLY;
 *                             the ops and their layouts are the R_ values
 *                             below (wasi-program.ts has the same table)
 *
 * The module's identity is u64 size, dev, ino, mtime (ns), ctime (ns) of
 * the opened file and u64 flags: 1 (UNSETTLED) when its ctime is less than
 * SETTLE_NS before kwwasi opened it. The host keeps compiled modules by the
 * SHA-256 of their bytes and maps the settled identities it was sent to
 * those, for this machine only; so a program run again is not sent again,
 * and the module is read in CHUNK pieces, never held whole here. A
 * replacement changes the inode, an in-place rewrite the ctime, but only
 * by the file system's timestamp granularity (the initramfs's is a clock
 * tick, and a rewrite within one keeps it): so, as git does for racily
 * clean files, an identity counts only once its ctime is older than any
 * granularity (FAT's 2 s; a 9p mount's host file system's too), which also
 * covers a rewrite while kwwasi reads it. A host-side change of a file on a
 * 9p mount shows once the mount's attribute cache expires (1 s), as for
 * reading it.
 *
 * The program's realtime and monotonic clocks are this machine's: the host
 * keeps START's readings as offsets from its own monotonic clock and
 * answers clock calls itself (no request each), so they lag this side's by
 * at most START's delivery (wasi-exec.ts, programClock()), and a later
 * change of the guest's time (date -s) is not seen by a running program.
 * Its threads use the same offsets.
 *
 * stat results are u64 dev, ino, nlink, size, atime, mtime, ctime (ns),
 * then u32 mode. READDIR answers WASI dirents (u64 d_next, u64 d_ino, u32
 * d_namlen, u8 d_type, 3 bytes padding, name), cut at the asked length as
 * fd_readdir expects. Exit 0, the program's status, or 126 with
 * "kwwasi: what: error" on stderr when there is no host to run it or the
 * connection to it is lost (lost()). The host sends nothing on a
 * connection while a request is in flight there except EXIT, so a read,
 * write, accept, recv or send that may block waits for the connection too
 * (wait_ready()): a lost host ends this process even while it waits for
 * its stdin. One that cannot block (a
 * directory, a regular file on a disk, tmpfs or 9p file system, /dev/null
 * and the like: may_block()) skips that wait, as pread and pwrite always
 * did.
 *
 * Each request costs as few system calls as it can, because each is slow
 * under emulation: a frame is sent with one send() (its header is kept in
 * front of the payload) and received with one recv() when it has arrived
 * whole, into buffers kept from one request to the next (rx, out), and the
 * program's data is read and written in place there, never copied.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <semaphore.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>
#include <linux/vm_sockets.h>

#define KWWASI_PORT 1021
#define KWWASI_VERSION 3
#define MAX_FRAME (64u << 20)
#define CHUNK (256u << 10)
#define SETTLE_NS 2000000000ull
#define UNSETTLED 1
/* A frame's header: u32 op, u32 payload length. */
#define HDR 8
/* The program's token (MODULE), which THREAD frames carry. */
#define TOKEN 16
/* rx's size to start with (it grows to the largest frame), and the most rx and out keep between requests. */
#define RX_MIN (4u << 10)
#define KEEP (4u << 20)

enum {
	OP_START = 1,
	OP_REPLY = 2,
	OP_EXIT = 3,
	OP_MODULE = 4,
	OP_DATA = 5,
	OP_END = 6,
	OP_THREAD = 7,
	R_READ = 16,      /* u32 fd, u32 len -> bytes */
	R_PREAD = 17,     /* u32 fd, u32 len, u64 off -> bytes */
	R_WRITE = 18,     /* u32 fd, bytes -> u32 n */
	R_PWRITE = 19,    /* u32 fd, u64 off, bytes -> u32 n */
	R_SEEK = 20,      /* u32 fd, u32 whence, i64 off -> u64 pos */
	R_CLOSE = 21,     /* u32 fd */
	R_FSTAT = 22,     /* u32 fd -> stat */
	R_FDSTAT = 23,    /* u32 fd -> u32 mode, u32 open flags, u32 isatty, u32 SO_TYPE (0: not a socket) */
	R_SETFL = 24,     /* u32 fd, u32 flags (O_APPEND, O_NONBLOCK; O_DSYNC, O_SYNC only as they are) */
	R_OPENAT = 25,    /* u32 dirfd, u32 flags, path -> u32 fd */
	R_STATAT = 26,    /* u32 dirfd, u32 at flags, path -> stat */
	R_READDIR = 27,   /* u32 fd, u32 len, u64 cookie -> WASI dirents */
	R_MKDIRAT = 28,   /* u32 dirfd, path */
	R_UNLINKAT = 29,  /* u32 dirfd, u32 at flags, path */
	R_RENAMEAT = 30,  /* u32 olddirfd, u32 newdirfd, string old, string new */
	R_READLINKAT = 31, /* u32 dirfd, path -> bytes */
	R_SYMLINKAT = 32, /* u32 dirfd, string target, string path */
	R_FTRUNCATE = 33, /* u32 fd, u64 size */
	R_FSYNC = 34,     /* u32 fd, u32 datasync */
	R_UTIMENS = 35,   /* u32 dirfd, u32 at flags, i64 atime, i64 mtime (ns; -1 now, -2 omit), path ("": the fd) */
	R_LINKAT = 36,    /* u32 olddirfd, u32 newdirfd, u32 at flags, string old, string new */
	R_POLL = 37,      /* i32 timeout ms, u32 n, n x (u32 fd, u32 events) -> n x u32 revents */
	R_RENUMBER = 38,  /* u32 from, u32 to */
	R_ACCEPT = 39,    /* u32 fd, u32 flags (O_NONBLOCK) -> u32 fd */
	R_RECV = 40,      /* u32 fd, u32 len, u32 WASI riflags (1 peek, 2 waitall) -> u32 WASI roflags (1 truncated), bytes */
	R_SEND = 41,      /* u32 fd, u32 WASI siflags (none), bytes -> u32 n */
	R_SHUTDOWN = 42,  /* u32 fd, u32 WASI sdflags (1 read, 2 write) */
	R_SPAWN = 43,     /* u32 start argument -> u32 tid (its THREAD came on a connection of its own) */
	R_ALLOCATE = 44,  /* u32 fd, u64 offset, u64 len (posix_fallocate: fallocate mode 0) */
};

/*
 * The connection this thread serves, one request at a time: the program's
 * (main()), or one wasm thread's (wasm_thread(), thread_conn). Per thread,
 * as is what came on it (rx) and host_spoke, so a single-threaded program
 * pays nothing for threads.
 */
static __thread int sock = -1, thread_conn;
/* The program's token, from MODULE. */
static uint8_t token[TOKEN];
/* The program's "/" while its paths are resolved (resolve()), else -1; and "/" for those that go there. */
static int virt_fd = -1, root_fd = -1;
/* KWWASI_CWD: undecided collisions go to "/" ("root"); warn about the first one (unset); no guessing ("cwd"). */
static int prefer_root, warn_collision, strict_cwd;

static void die(const char *what)
{
	fprintf(stderr, "kwwasi: %s: %s\n", what, strerror(errno));
	exit(126);
}

/* Growable output buffer. */
struct buf {
	uint8_t *p;
	size_t len, cap;
};

/* Room for `size` bytes in all. */
static void breserve(struct buf *b, size_t size)
{
	if (size > b->cap) {
		size_t cap = b->cap ? b->cap : 256;

		while (cap < size)
			cap *= 2;
		b->p = realloc(b->p, cap);
		if (!b->p) {
			errno = ENOMEM;
			die("realloc");
		}
		b->cap = cap;
	}
}

static void *bspace(struct buf *b, size_t n)
{
	breserve(b, b->len + n);
	b->len += n;
	return b->p + b->len - n;
}

/* Drop a buffer that grew beyond KEEP (an unusually large request), so it does not stay with this process. */
static void btrim(struct buf *b)
{
	if (b->cap > KEEP) {
		free(b->p);
		*b = (struct buf){ 0 };
	}
}

static void bput(struct buf *b, const void *p, size_t n)
{
	memcpy(bspace(b, n), p, n);
}

static void bu32(struct buf *b, uint32_t v)
{
	bput(b, &v, 4); /* the guest is little-endian */
}

static void bu64(struct buf *b, uint64_t v)
{
	bput(b, &v, 8);
}

static void bstr(struct buf *b, const char *s)
{
	bu32(b, strlen(s));
	bput(b, s, strlen(s));
}

/* What came from the host: rx.p[rx_at, rx.len) is not used yet (it came with the frame before it). */
static __thread struct buf rx;
static __thread size_t rx_at;

/*
 * The connection to the host is gone (err: why, 0 for an orderly close):
 * the host ended the program (its machine stopped, or it was killed
 * there), or this machine was restored from a snapshot, which keeps no
 * running WASI program (the kernel resets every vsock connection the host
 * does not keep).
 */
static void lost(int err)
{
	/* A wasm thread's connection ends this thread only: the host closes it when that thread returned, and the program's decides the rest. */
	if (thread_conn) {
		close(sock);
		free(rx.p);
		rx = (struct buf){ 0 };
		pthread_exit(NULL);
	}
	if (err)
		fprintf(stderr, "kwwasi: lost the connection to the host (%s): the host ended the program, "
			"or the machine was restored from a snapshot, which does not keep running WASI programs\n", strerror(err));
	else
		fprintf(stderr, "kwwasi: the host closed the connection\n");
	exit(126);
}

/* Has the host sent more than the frames taken so far? */
static int rx_pending(void)
{
	return rx_at < rx.len;
}

/* Read from the host until rx holds `want` bytes, taking whatever else has come too; -1 at the connection's end (errno, 0 for an orderly close). */
static int rx_fill(size_t want)
{
	breserve(&rx, want > RX_MIN ? want : RX_MIN);
	while (rx.len < want) {
		ssize_t r = recv(sock, rx.p + rx.len, rx.cap - rx.len, 0);

		if (r < 0 && errno == EINTR)
			continue;
		if (r == 0)
			errno = 0; /* an orderly close */
		if (r <= 0)
			return -1;
		rx.len += r;
	}
	return 0;
}

/* The program ended on the host (an EXIT frame's payload): its message to stderr, its status. */
static void host_exit(const uint8_t *payload, uint32_t len)
{
	uint32_t code = 1;

	if (len >= 4)
		memcpy(&code, payload, 4);
	if (len > 4)
		fprintf(stderr, "%.*s\n", (int)(len - 4), payload + 4);
	exit(code & 0xff);
}

/* The next frame from the host: op and payload length in h, and its payload (valid until the next call). */
static uint8_t *recv_frame(uint32_t h[2])
{
	if (rx_at == rx.len) {
		btrim(&rx);
		rx.len = rx_at = 0;
	} else if (rx_at) {
		memmove(rx.p, rx.p + rx_at, rx.len - rx_at);
		rx.len -= rx_at;
		rx_at = 0;
	}
	if (rx_fill(HDR))
		lost(errno);
	memcpy(h, rx.p, HDR);
	if (h[1] > MAX_FRAME) {
		fprintf(stderr, "kwwasi: oversized frame from the host\n");
		exit(126);
	}
	if (rx_fill(HDR + h[1]))
		lost(errno);
	rx_at = HDR + h[1];
	return rx.p + HDR;
}

/*
 * A send to the host failed (err). When the host ended the program while
 * a request was in flight (its worker failed), it sent EXIT and then shut
 * the connection: exit as it said. Else the connection is lost.
 */
static void send_failed(int err)
{
	for (;;) {
		ssize_t r;

		while (rx.len - rx_at >= HDR) {
			uint32_t h[2];

			memcpy(h, rx.p + rx_at, HDR);
			if (h[1] > MAX_FRAME)
				lost(err);
			if (h[1] > rx.len - rx_at - HDR)
				break;
			if (h[0] == OP_EXIT)
				host_exit(rx.p + rx_at + HDR, h[1]);
			rx_at += HDR + h[1];
		}
		breserve(&rx, rx.len + RX_MIN);
		r = recv(sock, rx.p + rx.len, rx.cap - rx.len, MSG_DONTWAIT);
		if (r < 0 && errno == EINTR)
			continue;
		if (r <= 0)
			break;
		rx.len += r;
	}
	lost(err);
}

/* Set when the host sent a frame while a request was in flight (wait_ready()): that request gets no reply. */
static __thread int host_spoke;

/*
 * Before an operation that may block for long (a read or write of a
 * blocking pipe, tty or socket), wait for fd and the connection together,
 * so that a program whose host went away does not keep this process
 * waiting on its stdin. The host sends nothing while a request is in
 * flight, except EXIT for a program that ended there. Returns 0 to go on
 * with the operation, -1 to drop the request (host_spoke).
 */
static int wait_ready(int fd, short events)
{
	struct pollfd p[2] = { { .fd = fd, .events = events }, { .fd = sock, .events = POLLIN } };
	int fl = fcntl(fd, F_GETFL);

	if (fl < 0 || (fl & O_NONBLOCK))
		return 0;
	/* It came with the request (recv_frame() takes what has arrived). */
	if (rx_pending()) {
		host_spoke = 1;
		return -1;
	}
	for (;;) {
		int n = poll(p, 2, -1);

		if (n < 0 && errno == EINTR)
			continue;
		if (n < 0)
			return 0;
		if (p[1].revents) {
			char c;
			ssize_t r = recv(sock, &c, 1, MSG_PEEK | MSG_DONTWAIT);

			if (r > 0) {
				host_spoke = 1;
				return -1;
			}
			if (r < 0 && (errno == EAGAIN || errno == EINTR))
				continue;
			lost(r < 0 ? errno : 0);
		}
		if (p[0].revents)
			return 0;
	}
}

/*
 * What a read or write of a program's descriptor can do, for may_block():
 * not known yet, it cannot block, it may, or it may and the descriptor is
 * a socket (written with send(), below). A descriptor's file never changes,
 * so this is kept until the program closes or replaces it.
 */
enum { KIND_UNKNOWN, KIND_NEVER, KIND_MAY, KIND_SOCK };
#define KINDS 512 /* kwwasi's own descriptors are at 512 and above */
static uint8_t kind[KINDS];

static void forget_kind(int fd)
{
	if (fd >= 0 && fd < KINDS)
		kind[fd] = KIND_UNKNOWN;
}

/*
 * Can a read or write of fd block for long, so that wait_ready() must
 * watch the connection meanwhile? Not for a directory, /dev/null, zero,
 * full or urandom, or a regular file on a file system whose files are
 * always ready (poll() reports them so at once, which is all wait_ready()
 * would see); a regular file elsewhere (procfs's kmsg, tracefs's
 * trace_pipe, FUSE) may, as may pipes, ttys, sockets and other devices.
 */
static int fd_kind(int fd)
{
	struct stat st;
	struct statfs fs;
	int k = KIND_MAY;

	if (fd >= 0 && fd < KINDS && kind[fd])
		return kind[fd];
	if (fstat(fd, &st) < 0)
		return KIND_MAY; /* wait_ready() and the operation report it */
	if (S_ISSOCK(st.st_mode)) {
		k = KIND_SOCK;
	} else if (S_ISDIR(st.st_mode)) {
		k = KIND_NEVER;
	} else if (S_ISCHR(st.st_mode)) {
		/* drivers/char/mem.c: 3 null, 5 zero, 7 full, 9 urandom (not 8 random, 11 kmsg) */
		unsigned int mi = minor(st.st_rdev);

		if (major(st.st_rdev) == 1 && (mi == 3 || mi == 5 || mi == 7 || mi == 9))
			k = KIND_NEVER;
	} else if (S_ISREG(st.st_mode) && fstatfs(fd, &fs) == 0) {
		switch ((unsigned long)fs.f_type) {
		case 0x01021994: /* tmpfs */
		case 0x858458f6: /* ramfs (the initramfs) */
		case 0x0000ef53: /* ext2, ext3, ext4 */
		case 0x794c7630: /* overlayfs */
		case 0x01021997: /* 9p */
		case 0x73717368: /* squashfs */
		case 0xe0f5e1e2: /* erofs */
		case 0x00004d44: /* vfat */
		case 0x9123683e: /* btrfs */
		case 0x58465342: /* xfs */
			k = KIND_NEVER;
			break;
		}
	}
	if (fd >= 0 && fd < KINDS)
		kind[fd] = k;
	return k;
}

static int may_block(int fd)
{
	return fd_kind(fd) != KIND_NEVER;
}

static void send_all(const void *p, size_t n)
{
	const uint8_t *c = p;

	while (n) {
		ssize_t w = send(sock, c, n, MSG_NOSIGNAL);

		if (w < 0 && errno == EINTR)
			continue;
		if (w <= 0)
			send_failed(w < 0 ? errno : 0);
		c += w;
		n -= w;
	}
}

/* Start a frame in b: room for its header, which send_frame() fills in. */
static void bframe(struct buf *b)
{
	b->len = 0;
	bspace(b, HDR);
}

/* Send the frame begun in b with bframe(), header and payload with one send(). */
static void send_frame(uint32_t op, struct buf *b)
{
	uint32_t h[2] = { op, b->len - HDR };

	memcpy(b->p, h, HDR);
	send_all(b->p, b->len);
}

/* A request's payload, read front to back. */
struct req {
	const uint8_t *p, *end;
	int bad;
};

static uint32_t ru32(struct req *r)
{
	uint32_t v = 0;

	if (r->end - r->p < 4) {
		r->bad = 1;
		return 0;
	}
	memcpy(&v, r->p, 4);
	r->p += 4;
	return v;
}

static uint64_t ru64(struct req *r)
{
	uint64_t v = 0;

	if (r->end - r->p < 8) {
		r->bad = 1;
		return 0;
	}
	memcpy(&v, r->p, 8);
	r->p += 8;
	return v;
}

/* A string as a NUL-terminated copy (freed with the request). */
static char *rstr(struct req *r, char **owned)
{
	uint32_t n = ru32(r);
	char *s;

	if (r->bad || (size_t)(r->end - r->p) < n) {
		r->bad = 1;
		return "";
	}
	s = malloc(n + 1);
	memcpy(s, r->p, n);
	s[n] = 0;
	r->p += n;
	for (int i = 0; i < 2; i++)
		if (!owned[i]) {
			owned[i] = s;
			break;
		}
	return s;
}

/* The rest of the payload as a NUL-terminated path. */
static char *rrest(struct req *r, char **owned)
{
	size_t n = r->end - r->p;
	char *s = malloc(n + 1);

	memcpy(s, r->p, n);
	s[n] = 0;
	r->p = r->end;
	for (int i = 0; i < 2; i++)
		if (!owned[i]) {
			owned[i] = s;
			break;
		}
	return s;
}

static void put_stat(struct buf *b, const struct stat *st)
{
	bu64(b, st->st_dev);
	bu64(b, st->st_ino);
	bu64(b, st->st_nlink);
	bu64(b, st->st_size);
	bu64(b, (uint64_t)st->st_atim.tv_sec * 1000000000u + st->st_atim.tv_nsec);
	bu64(b, (uint64_t)st->st_mtim.tv_sec * 1000000000u + st->st_mtim.tv_nsec);
	bu64(b, (uint64_t)st->st_ctim.tv_sec * 1000000000u + st->st_ctim.tv_nsec);
	bu32(b, st->st_mode);
}

/*
 * Open flags cross the connection with their asm-generic values, whatever
 * the guest's architecture uses (arm64 has its own O_DIRECTORY and
 * O_NOFOLLOW). The access mode is the low two bits everywhere.
 */
static const struct { int wire, flag; } open_flags[] = {
	{ 0x40, O_CREAT }, { 0x80, O_EXCL }, { 0x200, O_TRUNC }, { 0x400, O_APPEND },
	{ 0x800, O_NONBLOCK }, { 0x1000, O_DSYNC }, { 0x101000, O_SYNC },
	{ 0x10000, O_DIRECTORY }, { 0x20000, O_NOFOLLOW },
};

static int flags_from_wire(int wire)
{
	int fl = wire & O_ACCMODE;

	for (size_t i = 0; i < sizeof(open_flags) / sizeof(*open_flags); i++)
		if ((wire & open_flags[i].wire) == open_flags[i].wire)
			fl |= open_flags[i].flag;
	return fl;
}

static int flags_to_wire(int fl)
{
	int wire = fl & O_ACCMODE;

	for (size_t i = 0; i < sizeof(open_flags) / sizeof(*open_flags); i++)
		if ((fl & open_flags[i].flag) == open_flags[i].flag)
			wire |= open_flags[i].wire;
	return wire;
}

static uint8_t wasi_type(unsigned char d_type)
{
	switch (d_type) {
	case DT_BLK: return 1;
	case DT_CHR: return 2;
	case DT_DIR: return 3;
	case DT_REG: return 4;
	case DT_SOCK: return 6;
	case DT_LNK: return 7;
	default: return 0;
	}
}

struct linux_dirent64 {
	uint64_t d_ino;
	int64_t d_off;
	unsigned short d_reclen;
	unsigned char d_type;
	char d_name[];
};

/* fd_readdir: entries from `cookie` on, as WASI dirents, cut at `len`. */
#define RAW 32768
static int do_readdir(int fd, uint32_t len, uint64_t cookie, struct buf *out)
{
	static __thread char *raw;
	size_t start = out->len;

	if (!raw && !(raw = malloc(RAW)))
		return ENOMEM;

	if (lseek(fd, cookie, SEEK_SET) < 0)
		return errno;
	while (out->len - start < len) {
		long n = syscall(SYS_getdents64, fd, raw, RAW);

		if (n < 0)
			return errno;
		if (n == 0)
			break;
		for (long at = 0; at < n && out->len - start < len;) {
			struct linux_dirent64 *d = (void *)(raw + at);
			size_t nl = strlen(d->d_name), room = len - (out->len - start);
			uint8_t ent[24] = { 0 };
			uint64_t next = d->d_off;
			uint32_t nl32 = nl;

			memcpy(ent, &next, 8);
			memcpy(ent + 8, &d->d_ino, 8);
			memcpy(ent + 16, &nl32, 4);
			ent[20] = wasi_type(d->d_type);
			bput(out, ent, room < 24 ? room : 24);
			room = len - (out->len - start);
			bput(out, d->d_name, room < nl ? room : nl);
			at += d->d_reclen;
		}
	}
	return 0;
}

static struct timespec ts_of(int64_t ns)
{
	if (ns == -1)
		return (struct timespec){ .tv_nsec = UTIME_NOW };
	if (ns == -2)
		return (struct timespec){ .tv_nsec = UTIME_OMIT };
	return (struct timespec){ .tv_sec = ns / 1000000000, .tv_nsec = ns % 1000000000 };
}

/* The module's identity (see the top). */
static void put_identity(struct buf *b, const struct stat *st, uint64_t flags)
{
	bu64(b, st->st_size);
	bu64(b, st->st_dev);
	bu64(b, st->st_ino);
	bu64(b, (uint64_t)st->st_mtim.tv_sec * 1000000000u + st->st_mtim.tv_nsec);
	bu64(b, (uint64_t)st->st_ctim.tv_sec * 1000000000u + st->st_ctim.tv_nsec);
	bu64(b, flags);
}

/* MODULE asked for the module (fd, `size` bytes as START said): DATA pieces, then END. */
static void send_module(int fd, const char *path, uint64_t size)
{
	static uint8_t piece[HDR + CHUNK];
	struct buf end = { 0 };
	struct stat st;

	for (uint64_t at = 0; at < size;) {
		size_t want = size - at < CHUNK ? size - at : CHUNK;
		ssize_t n = pread(fd, piece + HDR, want, at);
		uint32_t h[2] = { OP_DATA, n };

		if (n < 0 && errno == EINTR)
			continue;
		if (n <= 0) {
			if (!n)
				errno = ESTALE; /* shorter than when it was opened */
			die(path);
		}
		memcpy(piece, h, HDR);
		send_all(piece, HDR + n);
		at += n;
	}
	if (fstat(fd, &st) < 0)
		die(path);
	bframe(&end);
	put_identity(&end, &st, 0);
	send_frame(OP_END, &end);
	free(end.p);
}

/* Does the first n bytes of path name something under dirfd (not following a last symlink)? */
static int exists(int dirfd, const char *path, size_t n)
{
	char p[4096];
	struct stat st;

	if (n >= sizeof(p))
		return 0;
	memcpy(p, path, n);
	p[n] = 0;
	return fstatat(dirfd, n ? p : ".", &st, AT_SYMLINK_NOFOLLOW) == 0;
}

/*
 * The directory a path on dirfd is resolved from (see the top): dirfd
 * itself, or for the program's "/" (virt_fd), AT_FDCWD or root_fd.
 * `creating`: the path names a new entry (O_CREAT, mkdir, a link's or
 * rename's new name).
 */
static int resolve(int dirfd, const char *path, int creating)
{
	size_t x, n, d;
	int c, r, use;

	if (dirfd != virt_fd || virt_fd < 0)
		return dirfd;
	if (path[0] == '/')
		return root_fd;
	if (strict_cwd || !path[0] || !strcmp(path, ".") || !strcmp(path, "..") || !strncmp(path, "./", 2) || !strncmp(path, "../", 3))
		return AT_FDCWD;
	x = strcspn(path, "/");
	c = exists(AT_FDCWD, path, x);
	r = exists(root_fd, path, x);
	if (!c && !r)
		return AT_FDCWD;
	n = strlen(path);
	while (n > x && path[n - 1] == '/')
		n--;
	if (c != r) {
		use = c ? AT_FDCWD : root_fd;
		/* Only a new entry named like one in "/" ("mkdir lib") may have meant the cwd. */
		if (!creating || c || n > x)
			return use;
	} else {
		/* Both have it: where the whole path, else its parent, exists in only one. */
		int fc = exists(AT_FDCWD, path, n), fr = exists(root_fd, path, n);

		if (fc == fr && !fc) {
			for (d = n; d > x && path[d - 1] != '/'; d--)
				;
			while (d > x && path[d - 1] == '/')
				d--;
			fc = exists(AT_FDCWD, path, d);
			fr = exists(root_fd, path, d);
		}
		use = fc != fr ? (fc ? AT_FDCWD : root_fd) : prefer_root ? root_fd : AT_FDCWD;
	}
	if (warn_collision) {
		warn_collision = 0;
		fprintf(stderr, "kwwasi: warning: \"%s\" may mean ./%s or /%s (a WASI program cannot say which); used %s%s. "
			"KWWASI_CWD=auto, root, cwd or off chooses and silences this\n", path, path, path, use == AT_FDCWD ? "./" : "/", path);
	}
	return use;
}

static int spawn_thread(uint32_t arg, int *tid);

/* One request; the result goes to `out` (after the errno word). */
static int serve(uint32_t op, struct req *r, struct buf *out)
{
	char *owned[2] = { 0 };
	int e = 0;

#define SYS(x) do { if ((x) < 0) e = errno; } while (0)
	switch (op) {
	case R_READ:
	case R_PREAD: {
		int fd = ru32(r);
		uint32_t len = ru32(r);
		uint64_t off = op == R_PREAD ? ru64(r) : 0;
		ssize_t n;

		if (r->bad)
			return EINVAL;
		if (len > MAX_FRAME / 2)
			len = MAX_FRAME / 2;
		if (op == R_READ && may_block(fd) && wait_ready(fd, POLLIN))
			return 0;
		void *p = bspace(out, len);
		do
			n = op == R_PREAD ? pread(fd, p, len, off) : read(fd, p, len);
		while (n < 0 && errno == EINTR);
		out->len -= len - (n > 0 ? n : 0);
		if (n < 0)
			e = errno;
		break;
	}
	case R_WRITE:
	case R_PWRITE: {
		int fd = ru32(r);
		uint64_t off = op == R_PWRITE ? ru64(r) : 0;
		int k = op == R_WRITE && !r->bad ? fd_kind(fd) : KIND_NEVER;
		ssize_t n;

		if (r->bad)
			return EINVAL;
		if (k != KIND_NEVER && wait_ready(fd, POLLOUT))
			return 0;
		/* A socket whose peer went away: EPIPE, not SIGPIPE (see the top). */
		do
			n = op == R_PWRITE ? pwrite(fd, r->p, r->end - r->p, off) :
				k == KIND_SOCK ? send(fd, r->p, r->end - r->p, MSG_NOSIGNAL) : write(fd, r->p, r->end - r->p);
		while (n < 0 && errno == EINTR);
		if (n < 0)
			e = errno;
		else
			bu32(out, n);
		break;
	}
	case R_SEEK: {
		int fd = ru32(r), whence = ru32(r);
		off_t pos = lseek(fd, (int64_t)ru64(r), whence);

		if (pos < 0)
			e = errno;
		else
			bu64(out, pos);
		break;
	}
	case R_CLOSE: {
		int fd = ru32(r);

		SYS(close(fd));
		forget_kind(fd);
		if (!e && fd == virt_fd)
			virt_fd = -1;
		break;
	}
	case R_FSTAT:
	case R_FDSTAT: {
		int fd = ru32(r), fl;
		struct stat st;

		if (fstat(fd, &st) < 0 || (fl = fcntl(fd, F_GETFL)) < 0) {
			e = errno;
			break;
		}
		if (op == R_FSTAT) {
			put_stat(out, &st);
		} else {
			int type = 0;
			socklen_t tl = sizeof(type);

			if (S_ISSOCK(st.st_mode) && getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &tl) < 0)
				type = 0;
			bu32(out, st.st_mode);
			bu32(out, flags_to_wire(fl));
			bu32(out, isatty(fd));
			bu32(out, type);
		}
		break;
	}
	case R_SETFL: {
		int fd = ru32(r), fl = flags_from_wire(ru32(r)), cur = fcntl(fd, F_GETFL);

		if (cur < 0)
			e = errno;
		/* Linux cannot change O_DSYNC or O_SYNC after open (F_SETFL ignores them): another state than the descriptor's fails rather than pretend. */
		else if ((fl & (O_DSYNC | O_SYNC)) != (cur & (O_DSYNC | O_SYNC)))
			e = EOPNOTSUPP;
		else
			SYS(fcntl(fd, F_SETFL, (cur & ~(O_APPEND | O_NONBLOCK)) | (fl & (O_APPEND | O_NONBLOCK))));
		break;
	}
	case R_OPENAT: {
		int dirfd = ru32(r), fl = flags_from_wire(ru32(r)), fd;
		char *path = rrest(r, owned);

		fd = openat(resolve(dirfd, path, fl & O_CREAT), path, fl, 0666);
		if (fd < 0) {
			e = errno;
		} else {
			forget_kind(fd);
			bu32(out, fd);
		}
		break;
	}
	case R_STATAT: {
		int dirfd = ru32(r), fl = ru32(r);
		char *path = rrest(r, owned);
		struct stat st;

		if (fstatat(resolve(dirfd, path, 0), path, &st, fl & AT_SYMLINK_NOFOLLOW) < 0)
			e = errno;
		else
			put_stat(out, &st);
		break;
	}
	case R_READDIR: {
		int fd = ru32(r);
		uint32_t len = ru32(r);
		uint64_t cookie = ru64(r);

		if (len > MAX_FRAME / 2)
			len = MAX_FRAME / 2;
		e = r->bad ? EINVAL : do_readdir(fd, len, cookie, out);
		break;
	}
	case R_MKDIRAT: {
		int dirfd = ru32(r);

		char *path = rrest(r, owned);

		SYS(mkdirat(resolve(dirfd, path, 1), path, 0777));
		break;
	}
	case R_UNLINKAT: {
		int dirfd = ru32(r), fl = ru32(r);

		char *path = rrest(r, owned);

		SYS(unlinkat(resolve(dirfd, path, 0), path, fl & AT_REMOVEDIR));
		break;
	}
	case R_RENAMEAT: {
		int a = ru32(r), b = ru32(r);
		char *from = rstr(r, owned), *to = rstr(r, owned);

		SYS(renameat(resolve(a, from, 0), from, resolve(b, to, 1), to));
		break;
	}
	case R_READLINKAT: {
		int dirfd = ru32(r);
		char *path = rrest(r, owned), tmp[4096];
		ssize_t n = readlinkat(resolve(dirfd, path, 0), path, tmp, sizeof(tmp));

		if (n < 0)
			e = errno;
		else
			bput(out, tmp, n);
		break;
	}
	case R_SYMLINKAT: {
		int dirfd = ru32(r);
		char *target = rstr(r, owned), *path = rstr(r, owned);

		SYS(symlinkat(target, resolve(dirfd, path, 1), path));
		break;
	}
	case R_FTRUNCATE: {
		int fd = ru32(r);

		SYS(ftruncate(fd, ru64(r)));
		break;
	}
	case R_FSYNC: {
		int fd = ru32(r);

		SYS(ru32(r) ? fdatasync(fd) : fsync(fd));
		break;
	}
	case R_UTIMENS: {
		int dirfd = ru32(r), fl = ru32(r);
		struct timespec ts[2];

		ts[0] = ts_of(ru64(r));
		ts[1] = ts_of(ru64(r));
		char *path = rrest(r, owned);

		if (*path)
			SYS(utimensat(resolve(dirfd, path, 0), path, ts, fl & AT_SYMLINK_NOFOLLOW));
		else
			SYS(futimens(dirfd, ts));
		break;
	}
	case R_LINKAT: {
		int a = ru32(r), b = ru32(r), fl = ru32(r);
		char *from = rstr(r, owned), *to = rstr(r, owned);

		SYS(linkat(resolve(a, from, 0), from, resolve(b, to, 1), to, fl & AT_SYMLINK_FOLLOW));
		break;
	}
	case R_POLL: {
		int timeout = ru32(r);
		uint32_t n = ru32(r);
		struct pollfd *p;

		if (r->bad || n > 4096)
			return EINVAL;
		/* The connection last: see wait_ready(). */
		p = calloc(n + 1, sizeof(*p));
		for (uint32_t i = 0; i < n; i++) {
			p[i].fd = ru32(r);
			p[i].events = ru32(r);
		}
		p[n].fd = sock;
		p[n].events = POLLIN;
		/* It came with the request (recv_frame() takes what has arrived). */
		if (rx_pending())
			host_spoke = 1;
		while (!host_spoke) {
			int k = poll(p, n + 1, timeout);

			if (k < 0) {
				e = errno;
				break;
			}
			if (p[n].revents) {
				char c;
				ssize_t got = recv(sock, &c, 1, MSG_PEEK | MSG_DONTWAIT);

				if (got > 0) {
					host_spoke = 1;
					break;
				}
				if (got < 0 && (errno == EAGAIN || errno == EINTR)) {
					p[n].revents = 0;
					if (k == 1)
						continue;
				} else {
					lost(got < 0 ? errno : 0);
				}
			}
			for (uint32_t i = 0; i < n; i++)
				bu32(out, p[i].revents);
			break;
		}
		free(p);
		break;
	}
	case R_RENUMBER: {
		int from = ru32(r), to = ru32(r);

		if (dup2(from, to) < 0) {
			e = errno;
		} else if (from != to) {
			forget_kind(from);
			forget_kind(to);
			close(from);
			virt_fd = from == virt_fd ? to : to == virt_fd ? -1 : virt_fd;
		}
		break;
	}
	case R_ACCEPT: {
		int fd = ru32(r), fl = flags_from_wire(ru32(r)), nfd;

		if (r->bad)
			return EINVAL;
		if (may_block(fd) && wait_ready(fd, POLLIN))
			return 0;
		do
			nfd = accept4(fd, NULL, NULL, fl & O_NONBLOCK ? SOCK_NONBLOCK : 0);
		while (nfd < 0 && errno == EINTR);
		if (nfd < 0) {
			e = errno;
		} else {
			forget_kind(nfd);
			bu32(out, nfd);
		}
		break;
	}
	case R_RECV: {
		int fd = ru32(r);
		uint32_t len = ru32(r), fl = ru32(r), ro = 0;
		size_t at = out->len, got = 0;

		if (r->bad)
			return EINVAL;
		if (len > MAX_FRAME / 2)
			len = MAX_FRAME / 2;
		bspace(out, 4 + len);
		/* WAITALL without PEEK goes on until len, the peer's end or an error, waiting as a read does each time. */
		for (;;) {
			struct iovec iov = { out->p + at + 4 + got, len - got };
			struct msghdr m = { .msg_iov = &iov, .msg_iovlen = 1 };
			ssize_t n;

			if (may_block(fd) && wait_ready(fd, POLLIN))
				return 0;
			n = recvmsg(fd, &m, fl & 1 ? MSG_PEEK | (fl & 2 ? MSG_WAITALL : 0) : 0);
			if (n < 0 && errno == EINTR)
				continue;
			if (n < 0) {
				if (!got)
					e = errno;
				break;
			}
			got += n;
			if (m.msg_flags & MSG_TRUNC)
				ro |= 1;
			if (!n || !(fl & 2) || (fl & 1) || got >= len)
				break;
		}
		out->len = at + 4 + got;
		memcpy(out->p + at, &ro, 4);
		break;
	}
	case R_SEND: {
		int fd = ru32(r);
		ssize_t n;

		ru32(r); /* siflags: none defined */
		if (r->bad)
			return EINVAL;
		if (may_block(fd) && wait_ready(fd, POLLOUT))
			return 0;
		do
			n = send(fd, r->p, r->end - r->p, MSG_NOSIGNAL);
		while (n < 0 && errno == EINTR);
		if (n < 0)
			e = errno;
		else
			bu32(out, n);
		break;
	}
	case R_SHUTDOWN: {
		int fd = ru32(r);
		uint32_t how = ru32(r);

		if (r->bad || !how || how > 3)
			return EINVAL;
		SYS(shutdown(fd, how == 1 ? SHUT_RD : how == 2 ? SHUT_WR : SHUT_RDWR));
		break;
	}
	case R_ALLOCATE: {
		int fd = ru32(r);
		int64_t off = ru64(r), len = ru64(r);

		if (r->bad)
			return EINVAL;
		/* posix_fallocate() is fallocate() mode 0 (musl's falls back to nothing; zig 0.16's returns -1, not the error). */
		SYS(fallocate(fd, 0, off, len));
		break;
	}
	case R_SPAWN: {
		uint32_t arg = ru32(r);
		int tid = 0;

		if (r->bad)
			return EINVAL;
		e = spawn_thread(arg, &tid);
		if (!e)
			bu32(out, tid);
		break;
	}
	default:
		e = ENOSYS;
	}
#undef SYS
	free(owned[0]);
	free(owned[1]);
	return r->bad ? EINVAL : e;
}

static int open_dir(const char *path)
{
	int fd = open(path, O_RDONLY | O_DIRECTORY);

	if (fd < 0)
		fd = open(path, O_PATH | O_DIRECTORY);
	return fd;
}

/* Move fd to `at` or above (close-on-exec); dies on failure. */
static int high(int fd, int at)
{
	int hi = fd < 0 ? -1 : fcntl(fd, F_DUPFD_CLOEXEC, at);

	if (hi < 0)
		die("fcntl");
	close(fd);
	return hi;
}

/* Descriptor 3, the program's "/", and how its paths are resolved (the top, resolve()). */
static void preopen(void)
{
	const char *mode = getenv("KWWASI_CWD");
	struct stat c, r;
	char cwd[4096];
	int fd;

	root_fd = high(open_dir("/"), 520);
	if (mode && !strcmp(mode, "root"))
		prefer_root = 1;
	if (mode && !strcmp(mode, "cwd"))
		strict_cwd = 1;
	warn_collision = !mode || !*mode;
	if ((mode && !strcmp(mode, "off")) || (stat(".", &c) == 0 && stat("/", &r) == 0 && c.st_dev == r.st_dev && c.st_ino == r.st_ino)) {
		fd = dup(root_fd);
	} else {
		/* The cwd; one this process may not search can still be had by its path, else a stand-in. */
		fd = open_dir(".");
		if (fd < 0 && getcwd(cwd, sizeof(cwd)))
			fd = open(cwd, O_PATH | O_DIRECTORY);
		if (fd < 0)
			fd = open("/dev/null", O_RDONLY);
		virt_fd = 3;
	}
	fd = high(fd, 600);
	if (dup2(fd, 3) < 0)
		die("dup2");
	close(fd);
}

/* A listening TCP socket for "ADDR:PORT" (KWWASI_TCPLISTEN, the top); -1 with errno (EINVAL: not ADDR:PORT). */
static int listen_on(char *spec)
{
	union {
		struct sockaddr sa;
		struct sockaddr_in in;
		struct sockaddr_in6 in6;
	} a = { 0 };
	char *port = strrchr(spec, ':'), *host = spec, *end;
	socklen_t alen = sizeof(a.in);
	long pn;
	int s, one = 1;

	if (!port || !port[1])
		goto bad;
	*port++ = 0;
	pn = strtol(port, &end, 10);
	if (*end || pn < 0 || pn > 65535)
		goto bad;
	if (host[0] == '[') {
		size_t n = strlen(host);

		if (n < 2 || host[n - 1] != ']')
			goto bad;
		host[n - 1] = 0;
		a.in6.sin6_family = AF_INET6;
		a.in6.sin6_port = htons(pn);
		if (inet_pton(AF_INET6, host + 1, &a.in6.sin6_addr) != 1)
			goto bad;
		alen = sizeof(a.in6);
	} else {
		a.in.sin_family = AF_INET;
		a.in.sin_port = htons(pn);
		if (*host && inet_pton(AF_INET, host, &a.in.sin_addr) != 1)
			goto bad;
	}
	s = socket(a.sa.sa_family, SOCK_STREAM, 0);
	if (s < 0)
		return -1;
	setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
	if (bind(s, &a.sa, alen) < 0 || listen(s, 128) < 0) {
		int e = errno;

		close(s);
		errno = e;
		return -1;
	}
	return s;
bad:
	errno = EINVAL;
	return -1;
}

/* KWWASI_TCPLISTEN's sockets, at descriptors 4, 5, ... (the top). */
static void tcp_listen(void)
{
	const char *spec = getenv("KWWASI_TCPLISTEN");
	int next = 4;

	for (const char *p = spec ? spec : ""; *p;) {
		size_t n = strcspn(p, ",");
		char item[128], what[128];
		int s;

		snprintf(item, sizeof(item), "%.*s", (int)n, p);
		memcpy(what, item, sizeof(what)); /* listen_on() cuts item up */
		p += n + (p[n] == ',');
		if (!n)
			continue;
		/* kwwasi's own descriptors are at 512 and above: an open one here is inherited. */
		if (fcntl(next, F_GETFD) >= 0) {
			fprintf(stderr, "kwwasi: KWWASI_TCPLISTEN %s: descriptor %d is already open (inherited)\n", what, next);
			exit(126);
		}
		s = n < sizeof(item) ? listen_on(item) : (errno = EINVAL, -1);
		if (s < 0) {
			fprintf(stderr, "kwwasi: KWWASI_TCPLISTEN %s: %s\n", what,
				errno == EINVAL ? "not ADDR:PORT (a numeric IPv4 address, [IPv6] or none, and a port)" : strerror(errno));
			exit(126);
		}
		s = high(s, 600);
		if (dup2(s, next++) < 0)
			die("dup2");
		close(s);
	}
}

/* A connection to the host (vsock port KWWASI_PORT), at 512 or above (close-on-exec); -1 with errno. */
static int connect_host(void)
{
	struct sockaddr_vm addr = { .svm_family = AF_VSOCK, .svm_cid = VMADDR_CID_HOST, .svm_port = KWWASI_PORT };
	int s = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0), hi;

	if (s < 0)
		return -1;
	if (connect(s, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		int e = errno;

		close(s);
		errno = e;
		return -1;
	}
	hi = fcntl(s, F_DUPFD_CLOEXEC, 512);
	if (hi < 0)
		return s;
	close(s);
	return hi;
}

/* The module, kept open (above the program's descriptors) until the host has it; its path and size. */
static int mod_fd = -1;
static const char *mod_path;
static uint64_t mod_size;

/* MODULE (the program's connection): send the module if asked, and keep the program's token. */
static void module_asked(const uint8_t *payload, uint32_t len)
{
	uint32_t want = 1;

	if (len >= 4)
		memcpy(&want, payload, 4);
	if (len >= 4 + TOKEN)
		memcpy(token, payload + 4, TOKEN);
	if (mod_fd < 0)
		return;
	if (want)
		send_module(mod_fd, mod_path, mod_size);
	close(mod_fd);
	mod_fd = -1;
}

/* Serve this thread's connection: requests until EXIT, or for a wasm thread's, until it ends (lost()). */
static _Noreturn void serve_requests(void)
{
	struct buf out = { 0 }; /* kept from one reply to the next, as rx (btrim()) */

	for (;;) {
		uint32_t h[2];
		uint8_t *payload = recv_frame(h);
		struct req r;
		int e;

		if (h[0] == OP_EXIT)
			host_exit(payload, h[1]);
		if (h[0] == OP_MODULE && !thread_conn) {
			module_asked(payload, h[1]);
			continue;
		}
		r = (struct req){ payload, payload + h[1], 0 };
		bframe(&out);
		bu32(&out, 0);
		e = serve(h[0], &r, &out);
		memcpy(out.p + HDR, &e, 4);
		if (!host_spoke)
			send_frame(OP_REPLY, &out);
		host_spoke = 0;
		btrim(&out);
	}
}

/* R_SPAWN's handover to the new thread: its start argument, then its tid or why it failed. */
struct spawn {
	uint32_t arg;
	int tid, err;
	sem_t done;
};

/* A wasm thread's pthread: its own connection (THREAD), then that thread's requests. */
static void *wasm_thread(void *p)
{
	struct spawn *sp = p;
	struct buf f = { 0 };
	int s = connect_host();

	thread_conn = 1;
	if (s < 0) {
		sp->err = errno;
		sem_post(&sp->done);
		return NULL;
	}
	sock = s;
	sp->tid = gettid();
	bframe(&f);
	bu32(&f, KWWASI_VERSION);
	bput(&f, token, TOKEN);
	bu32(&f, sp->tid);
	bu32(&f, sp->arg);
	memcpy(f.p, (uint32_t[2]){ OP_THREAD, f.len - HDR }, HDR);
	/* Not send_all(): a failure goes to the spawner as an error. */
	for (size_t at = 0; at < f.len;) {
		ssize_t w = send(sock, f.p + at, f.len - at, MSG_NOSIGNAL);

		if (w < 0 && errno == EINTR)
			continue;
		if (w <= 0) {
			sp->err = w < 0 ? errno : EPIPE;
			close(sock);
			free(f.p);
			sem_post(&sp->done);
			return NULL;
		}
		at += w;
	}
	free(f.p);
	sem_post(&sp->done); /* sp is the spawner's, gone after this */
	serve_requests();
}

/* thread-spawn (R_SPAWN): a pthread for the new wasm thread, once it has connected; its Linux tid is the wasm thread's id. */
static int spawn_thread(uint32_t arg, int *tid)
{
	struct spawn sp = { .arg = arg };
	pthread_attr_t a;
	pthread_t t;
	int e;

	if (sem_init(&sp.done, 0, 0))
		return errno;
	pthread_attr_init(&a);
	pthread_attr_setdetachstate(&a, PTHREAD_CREATE_DETACHED);
	pthread_attr_setstacksize(&a, 256 << 10);
	e = pthread_create(&t, &a, wasm_thread, &sp);
	pthread_attr_destroy(&a);
	if (!e) {
		while (sem_wait(&sp.done) && errno == EINTR)
			;
		e = sp.err;
		*tid = sp.tid;
	}
	sem_destroy(&sp.done);
	return e;
}

int main(int argc, char **argv)
{
	int fd;
	struct buf start = { 0 };
	extern char **environ;
	struct stat st;
	int envc = 0;
	size_t clocks;

	if (argc < 3) {
		fprintf(stderr, "usage: kwwasi PATH ARGV0 [ARG...] (run by binfmt_misc with flag P)\n");
		return 2;
	}
	fd = open(argv[1], O_RDONLY | O_CLOEXEC);
	if (fd < 0 || fstat(fd, &st) < 0)
		die(argv[1]);
	mod_fd = high(fd, 530);
	mod_path = argv[1];
	mod_size = st.st_size;

	tcp_listen();
	sock = connect_host();
	if (sock < 0)
		die("connect to the host (vsock port 1021)");

	preopen();

	while (environ && environ[envc])
		envc++;
	bframe(&start);
	bu32(&start, KWWASI_VERSION);
	bu32(&start, argc - 2);
	bu32(&start, envc);
	bu32(&start, 1); /* preopens */
	put_identity(&start, &st, 0);
	clocks = start.len;
	bspace(&start, 16); /* the clocks, read last (below) */
	bstr(&start, strchr(argv[2], '/') ? argv[2] : argv[1]);
	for (int i = 3; i < argc; i++)
		bstr(&start, argv[i]);
	for (int i = 0; i < envc; i++)
		bstr(&start, environ[i]);
	bu32(&start, 3);
	bstr(&start, "/");
	{
		/* As late as can be, so the host's offsets lag the guest's clocks only by the frame's delivery. */
		struct timespec rt, mt;
		uint64_t real, mono, ctime = (uint64_t)st.st_ctim.tv_sec * 1000000000u + st.st_ctim.tv_nsec, fl;

		clock_gettime(CLOCK_REALTIME, &rt);
		clock_gettime(CLOCK_MONOTONIC, &mt);
		real = (uint64_t)rt.tv_sec * 1000000000u + rt.tv_nsec;
		mono = (uint64_t)mt.tv_sec * 1000000000u + mt.tv_nsec;
		fl = ctime + SETTLE_NS <= real ? 0 : UNSETTLED;
		memcpy(start.p + clocks - 8, &fl, 8); /* the identity's flags */
		memcpy(start.p + clocks, &real, 8);
		memcpy(start.p + clocks + 8, &mono, 8);
	}
	send_frame(OP_START, &start);
	free(start.p);

	serve_requests();
}
