// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A clock test program for kwwasi (test/wasi-binfmt.ts), built as
// wasm32-wasi and as a native aarch64 reference.
//   clock now        CLOCK_REALTIME and CLOCK_MONOTONIC (ns), one per line
//   clock pipe N     N CLOCK_MONOTONIC readings to stdout, 2 ms apart
//   clock recv       (native) for each reading on stdin, its own
//                    CLOCK_MONOTONIC minus the reading: prints the minimum
//                    and the median (us) and how many were negative
// wasm32-wasi only:
//   clock ids        each clock's resolution; clock_time_get, clock_res_get
//                    and poll_oneoff on unknown clocks
//   clock cpu        process and thread CPU time at the start, over 300 ms
//                    of computing and over a 300 ms sleep (ms)
//   clock abs MS     sleeps until MS from now on the monotonic and on the
//                    realtime clock (absolute subscriptions): the time each
//                    took (ms)
//   clock lag N      how far its monotonic clock is behind the guest's: N
//                    reads of /proc/timer_list's "now at" (the guest's
//                    CLOCK_MONOTONIC when kwwasi read it) between two of its
//                    own readings t1 and t2; the lag is between now - t2 and
//                    now - t1 (medians, us)
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#ifdef __wasi__
#include <wasi/api.h>
#endif

static uint64_t ns(clockid_t id)
{
	struct timespec t;

	clock_gettime(id, &t);
	return (uint64_t)t.tv_sec * 1000000000u + t.tv_nsec;
}

static int cmp(const void *a, const void *b)
{
	int64_t x = *(const int64_t *)a, y = *(const int64_t *)b;

	return x < y ? -1 : x > y;
}

#ifdef __wasi__
static const char *err(__wasi_errno_t e)
{
	return e == __WASI_ERRNO_SUCCESS ? "ok" : e == __WASI_ERRNO_INVAL ? "EINVAL" : "other";
}

static uint64_t wclock(__wasi_clockid_t id)
{
	__wasi_timestamp_t t = 0;

	if (__wasi_clock_time_get(id, 1, &t))
		return 0;
	return t;
}

/* One clock subscription; its event's error. */
static __wasi_errno_t wait_on(__wasi_clockid_t id, uint64_t t, int abs)
{
	__wasi_subscription_t s = { .userdata = 7, .u = { .tag = __WASI_EVENTTYPE_CLOCK } };
	__wasi_event_t ev = { 0 };
	__wasi_size_t n = 0;
	__wasi_errno_t e;

	s.u.u.clock.id = id;
	s.u.u.clock.timeout = t;
	s.u.u.clock.flags = abs ? __WASI_SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME : 0;
	e = __wasi_poll_oneoff(&s, &ev, 1, &n);
	if (e)
		return e;
	return n == 1 && ev.userdata == 7 ? ev.error : 0xffff;
}
#endif

int main(int argc, char **argv)
{
	const char *mode = argc > 1 ? argv[1] : "";

	if (!strcmp(mode, "now")) {
		uint64_t r = ns(CLOCK_REALTIME), m = ns(CLOCK_MONOTONIC);

		printf("%llu\n%llu\n", (unsigned long long)r, (unsigned long long)m);
		return 0;
	}
	if (!strcmp(mode, "pipe") && argc > 2) {
		for (int i = 0, n = atoi(argv[2]); i < n; i++) {
			uint64_t t = ns(CLOCK_MONOTONIC);

			printf("%llu\n", (unsigned long long)t);
			fflush(stdout);
			while (ns(CLOCK_MONOTONIC) - t < 2000000)
				;
		}
		return 0;
	}
	if (!strcmp(mode, "recv")) {
		static int64_t d[100000];
		char line[64];
		int n = 0, neg = 0;

		while (n < 100000 && fgets(line, sizeof(line), stdin)) {
			d[n] = (int64_t)(ns(CLOCK_MONOTONIC) - strtoull(line, NULL, 10));
			neg += d[n] < 0;
			n++;
		}
		if (!n)
			return 1;
		qsort(d, n, sizeof(*d), cmp);
		printf("min %lld us, median %lld us, %d negative of %d\n", (long long)(d[0] / 1000), (long long)(d[n / 2] / 1000), neg, n);
		return 0;
	}
#ifdef __wasi__
	if (!strcmp(mode, "ids")) {
		for (__wasi_clockid_t id = 0; id < 4; id++) {
			__wasi_timestamp_t res = 0, t;

			/* A CPU-time clock may read 0 this early. */
			if (__wasi_clock_res_get(id, &res) || !res || __wasi_clock_time_get(id, 1, &t))
				printf("clock %u: no\n", id);
			else
				printf("clock %u: res %s1 ms\n", id, res < 1000000 ? "under " : "at least ");
		}
		for (__wasi_clockid_t id = 4; id < 1000; id += 995) {
			__wasi_timestamp_t t = 0;

			printf("clock %u: time %s, res %s, poll %s\n", id, err(__wasi_clock_time_get(id, 1, &t)), err(__wasi_clock_res_get(id, &t)),
				err(wait_on(id, 1000000, 0)));
		}
		return 0;
	}
	if (!strcmp(mode, "cpu")) {
		uint64_t p0 = wclock(__WASI_CLOCKID_PROCESS_CPUTIME_ID), t0 = wclock(__WASI_CLOCKID_THREAD_CPUTIME_ID), m = ns(CLOCK_MONOTONIC);
		uint64_t p1, t1;
		volatile uint64_t x = 1;

		while (ns(CLOCK_MONOTONIC) - m < 300000000)
			for (int i = 0; i < 1000; i++)
				x = x * 6364136223846793005u + 1;
		p1 = wclock(__WASI_CLOCKID_PROCESS_CPUTIME_ID);
		t1 = wclock(__WASI_CLOCKID_THREAD_CPUTIME_ID);
		wait_on(__WASI_CLOCKID_MONOTONIC, 300000000, 0);
		printf("start %llu %llu\ncompute %llu %llu\nsleep %llu %llu\n", (unsigned long long)(p0 / 1000000), (unsigned long long)(t0 / 1000000),
			(unsigned long long)((p1 - p0) / 1000000), (unsigned long long)((t1 - t0) / 1000000),
			(unsigned long long)((wclock(__WASI_CLOCKID_PROCESS_CPUTIME_ID) - p1) / 1000000),
			(unsigned long long)((wclock(__WASI_CLOCKID_THREAD_CPUTIME_ID) - t1) / 1000000));
		return 0;
	}
	if (!strcmp(mode, "lag") && argc > 2) {
		static int64_t lo[10000], hi[10000];
		int n = atoi(argv[2]);

		if (n < 1 || n > 10000)
			return 2;
		for (int i = 0; i < n; i++) {
			char b[256];
			int fd = open("/proc/timer_list", O_RDONLY);
			uint64_t t1, t2;
			ssize_t got;
			char *at;

			if (fd < 0)
				return 1;
			t1 = ns(CLOCK_MONOTONIC);
			got = read(fd, b, sizeof(b) - 1);
			t2 = ns(CLOCK_MONOTONIC);
			close(fd);
			b[got > 0 ? got : 0] = 0;
			if (!(at = strstr(b, "now at ")))
				return 1;
			uint64_t g = strtoull(at + 7, NULL, 10);
			lo[i] = (int64_t)(g - t2);
			hi[i] = (int64_t)(g - t1);
		}
		qsort(lo, n, sizeof(*lo), cmp);
		qsort(hi, n, sizeof(*hi), cmp);
		printf("lag between %lld and %lld us (medians of %d)\n", (long long)(lo[n / 2] / 1000), (long long)(hi[n / 2] / 1000), n);
		return 0;
	}
	if (!strcmp(mode, "abs") && argc > 2) {
		uint64_t ms = strtoull(argv[2], NULL, 10) * 1000000, t, e;

		for (__wasi_clockid_t id = 0; id < 2; id++) {
			uint64_t m = ns(CLOCK_MONOTONIC);

			t = wclock(id);
			e = wait_on(id, t + ms, 1);
			printf("%s %s %llu\n", id ? "monotonic" : "realtime", err(e), (unsigned long long)((ns(CLOCK_MONOTONIC) - m) / 1000000));
		}
		return 0;
	}
#endif
	fprintf(stderr, "usage: clock now|pipe N|recv|ids|cpu|abs MS|lag N\n");
	return 2;
}
