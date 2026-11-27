// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A wasm32-wasi socket test program for kwwasi (test/wasi-binfmt.ts):
// preview 1's sock_accept, sock_recv, sock_send and sock_shutdown, and the
// file calls on sockets, against test/wasi/sockclient.c in the guest.
//   sock.wasm serve READY   descriptor 4 is a listening socket
//                           (KWWASI_TCPLISTEN): an accept while it is
//                           nonblocking, a poll that times out, then creates
//                           the file READY, polls until a client comes,
//                           accepts it as a nonblocking socket, peeks,
//                           receives with WAITALL and reads to its end, echoes
//                           with send() and write(), shuts down and closes
//   sock.wasm inherited     descriptors 0 and 1 are a connection (nc -l -e):
//                           a nonblocking recv (EAGAIN), "go", a poll, the
//                           client's "ping" with WAITALL, "pong" back
//   sock.wasm udp           descriptor 0 is a connected UDP socket (nc -u -l
//                           -e): a datagram too large for the buffer
//                           (RECV_DATA_TRUNCATED), "ok" back
//   sock.wasm types FD...   what each descriptor is
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#include <wasi/api.h>

static const char *type_name(int fd)
{
	__wasi_fdstat_t st;

	if (__wasi_fd_fdstat_get(fd, &st))
		return "error";
	switch (st.fs_filetype) {
	case __WASI_FILETYPE_SOCKET_STREAM:
		return st.fs_rights_base & __WASI_RIGHTS_SOCK_ACCEPT ? "socket_stream" : "socket_stream without sock_accept";
	case __WASI_FILETYPE_SOCKET_DGRAM:
		return "socket_dgram";
	default:
		return "not a socket";
	}
}

static void put(int fd, const char *s)
{
	if (write(fd, s, strlen(s)) != (ssize_t)strlen(s)) {
		perror("write");
		exit(1);
	}
}

static int serve(const char *ready)
{
	struct sockaddr_storage sa;
	socklen_t sl = sizeof(sa);
	struct pollfd p = { .fd = 4, .events = POLLIN };
	char buf[256], peek[8];
	ssize_t n, total = 0;
	int c;

	printf("listener: %s\n", type_name(4));
	fcntl(4, F_SETFL, fcntl(4, F_GETFL) | O_NONBLOCK);
	c = accept(4, (struct sockaddr *)&sa, &sl);
	printf("accept, nonblocking listener: %s\n", c < 0 && errno == EAGAIN ? "EAGAIN" : "something else");
	fcntl(4, F_SETFL, fcntl(4, F_GETFL) & ~O_NONBLOCK);
	printf("poll: %d\n", poll(&p, 1, 300));
	fflush(stdout);
	close(open(ready, O_CREAT | O_WRONLY, 0644));
	if (poll(&p, 1, -1) != 1 || !(p.revents & POLLIN))
		return 1;
	printf("poll: listener readable\n");
	sl = sizeof(sa);
	c = accept4(4, (struct sockaddr *)&sa, &sl, SOCK_NONBLOCK);
	if (c < 0) {
		perror("accept");
		return 1;
	}
	printf("accepted: %s, %s\n", type_name(c), fcntl(c, F_GETFL) & O_NONBLOCK ? "nonblocking" : "blocking");
	fcntl(c, F_SETFL, fcntl(c, F_GETFL) & ~O_NONBLOCK);
	n = recv(c, peek, 5, MSG_PEEK | MSG_WAITALL);
	printf("peeked %zd: %.*s\n", n, (int)(n > 0 ? n : 0), peek);
	n = recv(c, buf, 11, MSG_WAITALL);
	printf("received %zd: %.*s\n", n, (int)(n > 0 ? n : 0), buf);
	total = n;
	while ((n = read(c, buf + total, sizeof(buf) - total)) > 0)
		total += n;
	printf("read to the end: %zd bytes in all\n", total);
	strcpy(buf + total, "\n");
	if (send(c, "echo: ", 6, 0) != 6 || send(c, buf, total + 1, 0) != total + 1)
		return 1;
	put(c, "bye\n");
	if (shutdown(c, SHUT_WR))
		return 1;
	printf("recv after the client's end: %zd\n", recv(c, buf, sizeof(buf), 0));
	if (close(c))
		return 1;
	printf("done\n");
	return 0;
}

static int inherited(void)
{
	struct pollfd p = { .fd = 0, .events = POLLIN };
	char buf[64];
	ssize_t n;

	fprintf(stderr, "fd 0: %s, fd 1: %s\n", type_name(0), type_name(1));
	fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK);
	n = recv(0, buf, sizeof(buf), 0);
	fprintf(stderr, "nonblocking recv: %s\n", n < 0 && errno == EAGAIN ? "EAGAIN" : "something else");
	fcntl(0, F_SETFL, fcntl(0, F_GETFL) & ~O_NONBLOCK);
	if (send(1, "go\n", 3, 0) != 3)
		return 1;
	if (poll(&p, 1, 5000) != 1)
		return 1;
	n = recv(0, buf, 4, MSG_WAITALL);
	fprintf(stderr, "received %zd: %.*s\n", n, (int)(n > 0 ? n : 0), buf);
	if (n != 4 || read(0, buf, sizeof(buf)) != 0)
		return 1;
	put(1, "pong\n");
	if (shutdown(1, SHUT_RDWR))
		return 1;
	return 0;
}

static int udp(void)
{
	char buf[4];
	__wasi_iovec_t iov = { (uint8_t *)buf, sizeof(buf) };
	__wasi_ciovec_t out = { (const uint8_t *)"ok", 2 };
	__wasi_size_t n = 0;
	__wasi_roflags_t ro = 0;

	fprintf(stderr, "fd 0: %s\n", type_name(0));
	if (__wasi_sock_recv(0, &iov, 1, 0, &n, &ro))
		return 1;
	fprintf(stderr, "datagram: %u bytes, %s\n", (unsigned)n, ro & __WASI_ROFLAGS_RECV_DATA_TRUNCATED ? "truncated" : "whole");
	if (__wasi_sock_send(0, &out, 1, 0, &n) || n != 2)
		return 1;
	return 0;
}

int main(int argc, char **argv)
{
	if (argc == 3 && !strcmp(argv[1], "serve"))
		return serve(argv[2]);
	if (argc == 2 && !strcmp(argv[1], "inherited"))
		return inherited();
	if (argc == 2 && !strcmp(argv[1], "udp"))
		return udp();
	if (argc > 2 && !strcmp(argv[1], "types")) {
		for (int i = 2; i < argc; i++)
			printf("%s: %s\n", argv[i], type_name(atoi(argv[i])));
		return 0;
	}
	fprintf(stderr, "usage: sock.wasm serve READY | inherited | udp | types FD...\n");
	return 2;
}
