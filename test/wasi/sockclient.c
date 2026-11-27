// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The guest-side client of test/wasi/sock.c (aarch64, test/wasi-binfmt.ts).
// It retries its connect or datagram for 3 s, while the server starts.
//   sockclient PORT send TEXT   connect, send TEXT in two pieces, shut down
//                               writing, print what comes back
//   sockclient PORT go TEXT     the same, but wait for "go\n" before sending
//   sockclient PORT udp TEXT    send TEXT as a datagram, print the answer
#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static void nap(void)
{
	nanosleep(&(struct timespec){ .tv_nsec = 100000000 }, NULL);
}

int main(int argc, char **argv)
{
	struct sockaddr_in a = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
	char buf[512];
	ssize_t n;
	int s = -1;

	if (argc != 4)
		return 2;
	a.sin_port = htons(atoi(argv[1]));
	if (!strcmp(argv[2], "udp")) {
		struct pollfd p = { .events = POLLIN };

		s = socket(AF_INET, SOCK_DGRAM, 0);
		p.fd = s;
		for (int i = 0; i < 30; i++) {
			sendto(s, argv[3], strlen(argv[3]), 0, (struct sockaddr *)&a, sizeof(a));
			if (poll(&p, 1, 100) == 1 && (n = recv(s, buf, sizeof(buf), 0)) > 0) {
				printf("%.*s\n", (int)n, buf);
				return 0;
			}
		}
		return 1;
	}
	for (int i = 0; i < 30; i++) {
		s = socket(AF_INET, SOCK_STREAM, 0);
		if (!connect(s, (struct sockaddr *)&a, sizeof(a)))
			break;
		close(s);
		s = -1;
		nap();
	}
	if (s < 0)
		return 1;
	if (!strcmp(argv[2], "go")) {
		size_t got = 0;

		while (got < 3 && (n = recv(s, buf + got, 3 - got, 0)) > 0)
			got += n;
		if (got != 3 || memcmp(buf, "go\n", 3))
			return 1;
	}
	/* In two pieces, apart, so that WAITALL has something to wait for. */
	n = strlen(argv[3]) / 2;
	send(s, argv[3], n, 0);
	nap();
	send(s, argv[3] + n, strlen(argv[3]) - n, 0);
	shutdown(s, SHUT_WR);
	while ((n = read(s, buf, sizeof(buf))) > 0)
		fwrite(buf, 1, n, stdout);
	return 0;
}
