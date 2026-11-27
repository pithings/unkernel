// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A wasm32-wasi file-system test program for kwwasi (test/wasi-binfmt.ts).
//   fs.wasm readdir DIR N   makes N files in DIR (new or empty), then reads
//                           it with fd_readdir and small buffers: all of it,
//                           from a cookie in the middle, from cookie 0
//                           again, buffers shorter than an entry, and while
//                           entries are removed and added between calls
//   fs.wasm errno DIR       errors from DIR's prepared entries (the test
//                           makes them; RLIMIT_FSIZE below 64 MiB and
//                           SIGXFSZ ignored): one line each, "what: ENAME"
//   fs.wasm alloc PATH RO   posix_fallocate (fd_allocate) of a new file
//                           PATH and of RO, a file opened read-only
//   fs.wasm setfl PATH      fcntl(F_SETFL) (fd_fdstat_set_flags) on a file
//                           opened with O_SYNC and on PATH plain
// Exit 1 with "FAIL ..." on stdout when a check fails.
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <wasi/api.h>

#define FAIL(...) do { printf("FAIL " __VA_ARGS__); printf("\n"); exit(1); } while (0)

/* The entries of one fd_readdir call: names and the cookie after each. */
struct ents {
	int n;
	char name[64][64];
	__wasi_dircookie_t next[64];
	__wasi_size_t used;
};

/* fd_readdir(fd, len, cookie); only whole entries are kept. */
static void readdir_at(int fd, size_t len, __wasi_dircookie_t cookie, struct ents *e)
{
	static uint8_t buf[4096];
	__wasi_errno_t r = __wasi_fd_readdir(fd, buf, len, cookie, &e->used);
	size_t at = 0;

	if (r)
		FAIL("fd_readdir: errno %d", r);
	e->n = 0;
	while (at + sizeof(__wasi_dirent_t) <= e->used && e->n < 64) {
		__wasi_dirent_t d;

		memcpy(&d, buf + at, sizeof(d));
		if (at + sizeof(d) + d.d_namlen > e->used)
			break;
		if (d.d_namlen >= 64)
			FAIL("a name of %u bytes", d.d_namlen);
		memcpy(e->name[e->n], buf + at + sizeof(d), d.d_namlen);
		e->name[e->n][d.d_namlen] = 0;
		e->next[e->n++] = d.d_next;
		at += sizeof(d) + d.d_namlen;
	}
}

static int names_cmp(const void *a, const void *b)
{
	return strcmp(*(char *const *)a, *(char *const *)b);
}

/* Read the whole directory from `cookie` with `len`-byte calls; names go to all (malloc'd), the count is returned. */
static int read_all(int fd, size_t len, __wasi_dircookie_t cookie, char **all, int max, int *calls, int churn_dir, int n)
{
	struct ents e;
	int got = 0;

	for (*calls = 0;; ++*calls) {
		readdir_at(fd, len, cookie, &e);
		if (!e.n && e.used >= len)
			FAIL("an entry does not fit %zu bytes", len);
		for (int i = 0; i < e.n; i++) {
			if (got == max)
				FAIL("more than %d entries", max);
			all[got++] = strdup(e.name[i]);
		}
		if (e.n)
			cookie = e.next[e.n - 1];
		if (churn_dir >= 0 && *calls == 2) {
			/* Remove every third f file and add as many g ones, between two calls. */
			char p[32];

			for (int i = 0; i < n; i += 3) {
				snprintf(p, sizeof(p), "f%05d", i);
				if (unlinkat(churn_dir, p, 0))
					FAIL("unlink %s: %s", p, strerror(errno));
				snprintf(p, sizeof(p), "g%05d", i);
				int f = openat(churn_dir, p, O_CREAT | O_WRONLY, 0666);
				if (f < 0)
					FAIL("create %s: %s", p, strerror(errno));
				close(f);
			}
		}
		if (e.used < len)
			return got;
	}
}

static int do_readdir(const char *dir, int n)
{
	char **all = calloc(n * 2 + 2, sizeof(char *)), p[32];
	int fd = open(dir, O_RDONLY | O_DIRECTORY), got, calls, mid;
	struct ents e;

	if (fd < 0)
		FAIL("open %s: %s", dir, strerror(errno));
	for (int i = 0; i < n; i++) {
		snprintf(p, sizeof(p), "f%05d", i);
		int f = openat(fd, p, O_CREAT | O_WRONLY, 0666);
		if (f < 0)
			FAIL("create %s: %s", p, strerror(errno));
		close(f);
	}

	/* All of it, about four entries a call. */
	got = read_all(fd, 128, 0, all, n * 2 + 2, &calls, -1, n);
	if (got != n + 2)
		FAIL("%d entries, want %d", got, n + 2);
	{
		char **sorted = malloc(got * sizeof(char *));

		memcpy(sorted, all, got * sizeof(char *));
		qsort(sorted, got, sizeof(char *), names_cmp);
		if (strcmp(sorted[0], ".") || strcmp(sorted[1], ".."))
			FAIL("no . and .. (%s, %s)", sorted[0], sorted[1]);
		for (int i = 0; i < n; i++) {
			snprintf(p, sizeof(p), "f%05d", i);
			if (strcmp(sorted[i + 2], p))
				FAIL("entry %d is %s, want %s", i + 2, sorted[i + 2], p);
		}
		free(sorted);
	}
	printf("%d entries in %d calls of 128 bytes, each once\n", got, calls);

	/* From the middle: walk to entry mid with 1-entry reads, keep its cookie. */
	{
		__wasi_dircookie_t c = 0;

		mid = got / 2;
		for (int i = 0; i < mid; i++) {
			readdir_at(fd, 64, c, &e);
			if (!e.n || strcmp(e.name[0], all[i]))
				FAIL("entry %d by 64-byte reads: %s, want %s", i, e.n ? e.name[0] : "(none)", all[i]);
			c = e.next[0];
		}
		readdir_at(fd, 4096, c, &e);
		if (!e.n || strcmp(e.name[0], all[mid]))
			FAIL("from entry %d's cookie: %s, want %s", mid, e.n ? e.name[0] : "(none)", all[mid]);
		for (int i = 0; i < e.n; i++)
			if (strcmp(e.name[i], all[mid + i]))
				FAIL("from entry %d's cookie, entry %d: %s, want %s", mid, i, e.name[i], all[mid + i]);
		printf("resumed from entry %d's cookie: the same entries\n", mid);
	}
	/* Back to the start. */
	readdir_at(fd, 4096, 0, &e);
	if (e.n < 3 || strcmp(e.name[0], all[0]) || strcmp(e.name[2], all[2]))
		FAIL("cookie 0 again: %s, want %s", e.n ? e.name[0] : "(none)", all[0]);
	printf("cookie 0 again: from the first entry\n");
	/* Buffers shorter than one entry are filled (the caller grows its buffer); 0 bytes read nothing. */
	readdir_at(fd, 10, 0, &e);
	if (e.used != 10)
		FAIL("a 10-byte read used %u", (unsigned)e.used);
	readdir_at(fd, 0, 0, &e);
	if (e.used != 0)
		FAIL("a 0-byte read used %u", (unsigned)e.used);
	printf("short buffers filled\n");

	/* Entries removed and added between calls: no error, and the files never touched each once. */
	for (int i = 0; i < got; i++)
		free(all[i]);
	got = read_all(fd, 128, 0, all, n * 2 + 2, &calls, fd, n);
	{
		int *seen = calloc(n, sizeof(int));

		for (int i = 0; i < got; i++) {
			int k;

			if (sscanf(all[i], "f%d", &k) == 1 && k >= 0 && k < n)
				seen[k]++;
		}
		for (int k = 0; k < n; k++)
			if (k % 3 && seen[k] != 1)
				FAIL("f%05d seen %d times while others changed", k, seen[k]);
		free(seen);
	}
	printf("entries removed and added meanwhile: the others each once\n");
	close(fd);
	return 0;
}

static const char *ename(int e)
{
	switch (e) {
	case 0: return "no error";
	case ELOOP: return "ELOOP";
	case ENOTEMPTY: return "ENOTEMPTY";
	case EXDEV: return "EXDEV";
	case EISDIR: return "EISDIR";
	case ENOTDIR: return "ENOTDIR";
	case EMLINK: return "EMLINK";
	case ENOSPC: return "ENOSPC";
	case EROFS: return "EROFS";
	case EFBIG: return "EFBIG";
	case ETXTBSY: return "ETXTBSY";
	case ENAMETOOLONG: return "ENAMETOOLONG";
	case EBADF: return "EBADF";
	case ENOTSUP: return "ENOTSUP";
	case EIO: return "EIO";
	case ESPIPE: return "ESPIPE";
	case EINVAL: return "EINVAL";
	default: return "other";
	}
}

#define TRY(what, x) do { errno = 0; int r_ = (x); printf("%s: %s\n", what, ename(r_ < 0 ? errno : 0)); } while (0)

static int do_errno(const char *d)
{
	char p[512], q[512], name[300];
	int fd;

	snprintf(p, sizeof(p), "%s/loop", d);
	TRY("open a symlink loop", open(p, O_RDONLY));
	snprintf(p, sizeof(p), "%s/full", d);
	TRY("rmdir a directory with a file", rmdir(p));
	snprintf(p, sizeof(p), "%s/file", d);
	snprintf(q, sizeof(q), "%s/other/file", d);
	TRY("rename to another file system", rename(p, q));
	snprintf(p, sizeof(p), "%s/full", d);
	TRY("open a directory for writing", open(p, O_WRONLY));
	snprintf(p, sizeof(p), "%s/file/x", d);
	TRY("a file as a directory", open(p, O_RDONLY));
	snprintf(p, sizeof(p), "%s/small/f", d);
	fd = open(p, O_WRONLY | O_CREAT | O_TRUNC, 0666);
	if (fd < 0)
		FAIL("open %s: %s", p, strerror(errno));
	{
		static char block[65536];
		ssize_t w;

		errno = 0;
		for (int i = 0; i < 64 && (w = write(fd, block, sizeof(block))) > 0; i++)
			;
		printf("write a full file system: %s\n", ename(errno));
		close(fd);
	}
	snprintf(p, sizeof(p), "%s/ro/x", d);
	TRY("create on a read-only file system", mkdir(p, 0777));
	/* Run with RLIMIT_FSIZE at 1 MiB or so and SIGXFSZ ignored (the test does). */
	snprintf(p, sizeof(p), "%s/file", d);
	fd = open(p, O_WRONLY);
	TRY("write beyond the file size limit", (int)pwrite(fd, "x", 1, 64 << 20));
	close(fd);
	snprintf(p, sizeof(p), "%s/busy", d);
	TRY("open a running program for writing", open(p, O_WRONLY));
	memset(name, 'n', 299);
	name[299] = 0;
	snprintf(p, sizeof(p), "%s/%s", d, name);
	TRY("a 299-byte name", open(p, O_RDONLY));
	return 0;
}

static int do_alloc(const char *path, const char *ro)
{
	struct stat st;
	int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0666), e;

	if (fd < 0)
		FAIL("open %s: %s", path, strerror(errno));
	e = posix_fallocate(fd, 0, 1 << 20);
	fstat(fd, &st);
	printf("allocate 1 MiB: %s, size %lld\n", ename(e), (long long)st.st_size);
	e = posix_fallocate(fd, 4 << 20, 4096);
	fstat(fd, &st);
	printf("allocate 4 KiB at 4 MiB: %s, size %lld\n", ename(e), (long long)st.st_size);
	printf("allocate a negative length: %s\n", ename(posix_fallocate(fd, 0, -1)));
	close(fd);
	fd = open(ro, O_RDONLY);
	if (fd < 0)
		FAIL("open %s: %s", ro, strerror(errno));
	printf("allocate in a file opened read-only: %s\n", ename(posix_fallocate(fd, 0, 4096)));
	close(fd);
	return 0;
}

static int do_setfl(const char *path)
{
	int fd = open(path, O_RDWR | O_SYNC), fl;

	if (fd < 0)
		FAIL("open %s: %s", path, strerror(errno));
	fl = fcntl(fd, F_GETFL);
	printf("O_SYNC file: F_GETFL has O_SYNC %s, O_DSYNC %s\n", fl & O_SYNC ? "yes" : "no", fl & O_DSYNC ? "yes" : "no");
	TRY("O_SYNC file: F_SETFL F_GETFL's | O_NONBLOCK", fcntl(fd, F_SETFL, fl | O_NONBLOCK));
	printf("... O_NONBLOCK now %s\n", fcntl(fd, F_GETFL) & O_NONBLOCK ? "set" : "clear");
	TRY("O_SYNC file: F_SETFL O_NONBLOCK alone (O_SYNC cleared)", fcntl(fd, F_SETFL, O_NONBLOCK));
	close(fd);
	fd = open(path, O_RDWR);
	fl = fcntl(fd, F_GETFL);
	TRY("plain file: F_SETFL | O_APPEND", fcntl(fd, F_SETFL, fl | O_APPEND));
	printf("... O_APPEND now %s\n", fcntl(fd, F_GETFL) & O_APPEND ? "set" : "clear");
	TRY("plain file: F_SETFL | O_DSYNC", fcntl(fd, F_SETFL, fl | O_DSYNC));
	TRY("plain file: F_SETFL | O_SYNC", fcntl(fd, F_SETFL, fl | O_SYNC));
	close(fd);
	return 0;
}

int main(int argc, char **argv)
{
	if (argc == 4 && !strcmp(argv[1], "readdir"))
		return do_readdir(argv[2], atoi(argv[3]));
	if (argc == 3 && !strcmp(argv[1], "errno"))
		return do_errno(argv[2]);
	if (argc == 4 && !strcmp(argv[1], "alloc"))
		return do_alloc(argv[2], argv[3]);
	if (argc == 3 && !strcmp(argv[1], "setfl"))
		return do_setfl(argv[2]);
	fprintf(stderr, "usage: fs.wasm readdir DIR N | errno DIR | alloc PATH RO | setfl PATH\n");
	return 2;
}
