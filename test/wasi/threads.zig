// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A wasi-threads test program for kwwasi (test/wasi-binfmt.ts): zig's
// std.Thread on wasm32-wasi with a shared memory imports env.memory and
// wasi.thread-spawn and exports wasi_thread_start. zig's wasi-libc has no
// pthreads (its thread stub), so this is Zig with its own WASI imports.
//   threads.wasm files N       N threads, each computing and writing,
//                              reading back and removing its own file in
//                              /tmp/w; prints each thread's sum and tid
//   threads.wasm stdin N       one thread reads a line of stdin while N
//                              others do file calls; says whether they all
//                              finished while the reader still waited
//   threads.wasm exit          a thread calls proc_exit(7) while main waits
//   threads.wasm trap          a thread traps (unreachable) while main waits
//   threads.wasm spin N        N threads and main compute forever
//   threads.wasm cpu N         N threads each compute for 200 ms of their own
//                              CPU time (clock 3), then as long again
//                              without a call, and wait (memory.atomic.wait32);
//                              prints how much of their time and main's the
//                              process CPU time (clock 2) grew by, read while
//                              they wait and right after the joins
//   threads.wasm cpulive N     N threads compute without calls while main
//                              sleeps 500 ms; prints the process CPU time's
//                              growth over the wall time (main's readings)
//   threads.wasm cpuidle       a thread waits in memory.atomic.wait32 and
//                              one sleeps in poll_oneoff while main sleeps
//                              400 ms; prints the process CPU time's growth
//   threads.wasm cpustart      prints the process and thread CPU times at
//                              the start, a thread's at its start, and the
//                              process's after the join
const std = @import("std");

// std's default panic handler does not build for threaded wasm32-wasi in zig 0.16 (std.Io.Threaded); a panic traps.
pub const panic = std.debug.no_panic;

const Iov = extern struct { buf: [*]const u8, len: usize };
const IovMut = extern struct { buf: [*]u8, len: usize };
extern "wasi_snapshot_preview1" fn fd_write(fd: i32, iovs: [*]const Iov, n: usize, nw: *usize) u16;
extern "wasi_snapshot_preview1" fn fd_read(fd: i32, iovs: [*]const IovMut, n: usize, nr: *usize) u16;
extern "wasi_snapshot_preview1" fn fd_close(fd: i32) u16;
extern "wasi_snapshot_preview1" fn path_open(dirfd: i32, lookup: u32, path: [*]const u8, plen: usize, oflags: u16, base: u64, inh: u64, fdflags: u16, fd: *i32) u16;
extern "wasi_snapshot_preview1" fn path_unlink_file(dirfd: i32, path: [*]const u8, plen: usize) u16;
extern "wasi_snapshot_preview1" fn args_sizes_get(argc: *usize, size: *usize) u16;
extern "wasi_snapshot_preview1" fn args_get(argv: [*][*:0]u8, buf: [*]u8) u16;
extern "wasi_snapshot_preview1" fn proc_exit(code: u32) noreturn;
extern "wasi_snapshot_preview1" fn sched_yield() u16;
extern "wasi_snapshot_preview1" fn poll_oneoff(in: *const [48]u8, out: *[32]u8, n: usize, nevents: *usize) u16;
extern "wasi_snapshot_preview1" fn clock_time_get(id: u32, precision: u64, out: *u64) u16;

fn clockNs(id: u32) u64 {
    var t: u64 = 0;
    if (clock_time_get(id, 1, &t) != 0) fail("clock_time_get({d})", .{id});
    return t;
}

/// Sleep `ms` (poll_oneoff with one relative clock subscription).
fn sleepMs(ms: u64) void {
    var sub: [48]u8 = @splat(0);
    var ev: [32]u8 = undefined;
    var n: usize = 0;
    std.mem.writeInt(u32, sub[16..20], 1, .little); // the monotonic clock
    std.mem.writeInt(u64, sub[24..32], ms * 1_000_000, .little);
    _ = poll_oneoff(&sub, &ev, 1, &n);
}

var out_lock: std.atomic.Mutex = .unlocked;

fn print(comptime fmt: []const u8, args: anytype) void {
    var buf: [256]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, fmt, args) catch return;
    while (!out_lock.tryLock()) _ = sched_yield();
    defer out_lock.unlock();
    var at: usize = 0;
    while (at < s.len) {
        var n: usize = 0;
        const iov = [_]Iov{.{ .buf = s.ptr + at, .len = s.len - at }};
        if (fd_write(1, &iov, 1, &n) != 0) return;
        at += n;
    }
}

fn fail(comptime fmt: []const u8, args: anytype) noreturn {
    print("FAIL " ++ fmt ++ "\n", args);
    proc_exit(1);
}

/// The program's "/" (kwwasi's preopen, descriptor 3).
const ROOT: i32 = 3;

fn openFile(path: []const u8, create: bool) i32 {
    var fd: i32 = -1;
    const rights: u64 = (1 << 1) | (1 << 6); // fd_read, fd_write
    const e = path_open(ROOT, 1, path.ptr, path.len, if (create) 1 | 8 else 0, rights, rights, 0, &fd);
    if (e != 0) fail("open {s}: errno {d}", .{ path, e });
    return fd;
}

var tids: [64]std.atomic.Value(u32) = @splat(.init(0));

fn fileWorker(i: usize) void {
    tids[i].store(@intCast(std.Thread.getCurrentId()), .seq_cst);
    var name_buf: [64]u8 = undefined;
    const name = std.fmt.bufPrint(&name_buf, "tmp/w/thr-{d}", .{i}) catch unreachable;
    var data: [4096]u8 = undefined;
    var sum: u64 = 0;
    for (0..20) |round| {
        // Compute something, write it, read it back.
        var x: u32 = @intCast(i * 7919 + round + 1);
        for (&data) |*b| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            b.* = @truncate(x);
        }
        const fd = openFile(name, true);
        var n: usize = 0;
        if (fd_write(fd, &[_]Iov{.{ .buf = &data, .len = data.len }}, 1, &n) != 0 or n != data.len) fail("write {s}", .{name});
        _ = fd_close(fd);
        var back: [4096]u8 = undefined;
        const rd = openFile(name, false);
        if (fd_read(rd, &[_]IovMut{.{ .buf = &back, .len = back.len }}, 1, &n) != 0 or n != back.len) fail("read {s}", .{name});
        _ = fd_close(rd);
        if (!std.mem.eql(u8, &data, &back)) fail("{s}: read back other data", .{name});
        for (back) |b| sum += b;
    }
    if (path_unlink_file(ROOT, name.ptr, name.len) != 0) fail("unlink {s}", .{name});
    sums[i] = sum;
}
var sums: [64]u64 = @splat(0);

var reader_reading = std.atomic.Value(bool).init(false);
var reader_done = std.atomic.Value(bool).init(false);
var line: [128]u8 = undefined;
var line_len: usize = 0;
fn stdinReader() void {
    var n: usize = 0;
    reader_reading.store(true, .seq_cst);
    if (fd_read(0, &[_]IovMut{.{ .buf = &line, .len = line.len }}, 1, &n) != 0) fail("read stdin", .{});
    line_len = n;
    reader_done.store(true, .seq_cst);
}

fn exiter() void {
    for (0..1000) |_| _ = sched_yield();
    proc_exit(7);
}

fn trapper() void {
    for (0..1000) |_| _ = sched_yield();
    @trap();
}

var spin_sink = std.atomic.Value(u32).init(0);
fn spinner() void {
    var x: u64 = 1;
    while (true) {
        x = x *% 6364136223846793005 +% 1442695040888963407;
        if (x == 0) spin_sink.store(@truncate(x), .monotonic);
    }
}

/// Some computation, no calls.
fn work(rounds: usize, seed: u64) u64 {
    var x: u64 = seed;
    for (0..rounds) |_| {
        for (0..100_000) |_| x = x *% 6364136223846793005 +% 1442695040888963407;
    }
    if (x == 0) spin_sink.store(@truncate(x), .monotonic);
    return x;
}

/// Compute until this thread's CPU time (clock 3) grew by 200 ms, then the
/// same work again without a call (as long again: `burned` gets the first
/// part's time), then wait for `ack`.
var burned: [64]std.atomic.Value(u32) = @splat(.init(0));
var finished = std.atomic.Value(u32).init(0);
var ack = std.atomic.Value(u32).init(0);
fn cpuBurner(i: usize) void {
    const t0 = clockNs(3);
    var rounds: usize = 0;
    var x: u64 = i + 1;
    while (clockNs(3) - t0 < 200_000_000) {
        x = work(1, x);
        rounds += 1;
    }
    burned[i].store(@intCast((clockNs(3) - t0) / 1000), .seq_cst);
    _ = work(rounds, x);
    _ = finished.fetchAdd(1, .seq_cst);
    while (ack.load(.seq_cst) == 0) _ = wait32(&ack, 0, -1);
}

var stop = std.atomic.Value(u32).init(0);
var started = std.atomic.Value(u32).init(0);
/// Compute without calls until `stop`.
fn liveBurner(i: usize) void {
    _ = started.fetchAdd(1, .seq_cst);
    var x: u64 = i + 1;
    while (stop.load(.monotonic) == 0) x = work(1, x);
}

fn wait32(ptr: *const std.atomic.Value(u32), expect: u32, timeout_ns: i64) u32 {
    return asm volatile (
        \\local.get %[ptr]
        \\local.get %[expected]
        \\local.get %[timeout]
        \\memory.atomic.wait32 0
        \\local.set %[ret]
        : [ret] "=r" (-> u32),
        : [ptr] "r" (&ptr.raw),
          [expected] "r" (@as(i32, @bitCast(expect))),
          [timeout] "r" (timeout_ns),
    );
}
fn notify(ptr: *const std.atomic.Value(u32), n: u32) u32 {
    return asm volatile (
        \\local.get %[ptr]
        \\local.get %[n]
        \\memory.atomic.notify 0
        \\local.set %[ret]
        : [ret] "=r" (-> u32),
        : [ptr] "r" (&ptr.raw),
          [n] "r" (n),
    );
}
var wake = std.atomic.Value(u32).init(0);
/// Wait in memory.atomic.wait32 until `wake` (an idle pool thread's wait, which the host does not see).
fn futexWaiter() void {
    _ = started.fetchAdd(1, .seq_cst);
    while (wake.load(.seq_cst) == 0) _ = wait32(&wake, 0, -1);
}
fn sleeper() void {
    _ = started.fetchAdd(1, .seq_cst);
    sleepMs(1000);
}
var thread_start_cpu = std.atomic.Value(u32).init(0);
fn startReader() void {
    thread_start_cpu.store(@intCast(clockNs(3) / 1000), .seq_cst);
    _ = work(10, 1);
}

// std.Thread.spawn() aligns its thread's stack, TLS and atomics relative to
// the start of a byte allocation, so that start must be aligned: each spawn
// takes whole pages, and the buffer starts on one.
var heap: [4 << 20]u8 align(std.wasm.page_size) = undefined;

pub fn main() void {
    var argc: usize = 0;
    var size: usize = 0;
    _ = args_sizes_get(&argc, &size);
    var argv: [16][*:0]u8 = undefined;
    var argbuf: [1024]u8 = undefined;
    if (argc > argv.len or size > argbuf.len) fail("too many arguments", .{});
    _ = args_get(&argv, &argbuf);
    const mode = if (argc > 1) std.mem.span(argv[1]) else "";
    const n: usize = if (argc > 2) std.fmt.parseInt(usize, std.mem.span(argv[2]), 10) catch 4 else 4;
    if (n > tids.len) fail("at most {d} threads", .{tids.len});

    var fba = std.heap.FixedBufferAllocator.init(&heap);
    // Only this thread spawns and joins, so the allocator is not shared.
    const cfg: std.Thread.SpawnConfig = .{ .allocator = fba.allocator(), .stack_size = 64 << 10 };
    var threads: [64]std.Thread = undefined;

    if (std.mem.eql(u8, mode, "files")) {
        for (0..n) |i| threads[i] = std.Thread.spawn(cfg, fileWorker, .{i}) catch fail("spawn", .{});
        for (0..n) |i| threads[i].join();
        for (0..n) |i| {
            const t = tids[i].load(.seq_cst);
            if (t == 0) fail("thread {d} has tid 0", .{i});
            for (0..i) |j| if (tids[j].load(.seq_cst) == t) fail("threads {d} and {d} share tid {d}", .{ j, i, t });
            print("thread {d}: sum {d}\n", .{ i, sums[i] });
        }
        print("tids positive and unique\n", .{});
    } else if (std.mem.eql(u8, mode, "stdin")) {
        const r = std.Thread.spawn(cfg, stdinReader, .{}) catch fail("spawn", .{});
        // Wait for the reader to be in its read (its worker may take a while to start).
        while (!reader_reading.load(.seq_cst)) _ = sched_yield();
        sleepMs(200);
        for (0..n) |i| threads[i] = std.Thread.spawn(cfg, fileWorker, .{i}) catch fail("spawn", .{});
        for (0..n) |i| threads[i].join();
        print("{d} threads did their file calls; the stdin reader {s}\n", .{ n, if (reader_done.load(.seq_cst)) "had finished" else "still waited" });
        r.join();
        print("stdin: {s}", .{line[0..line_len]});
    } else if (std.mem.eql(u8, mode, "exit") or std.mem.eql(u8, mode, "trap")) {
        const t = (if (mode[0] == 'e') std.Thread.spawn(cfg, exiter, .{}) else std.Thread.spawn(cfg, trapper, .{})) catch fail("spawn", .{});
        t.join();
        fail("the thread came back", .{});
    } else if (std.mem.eql(u8, mode, "spin")) {
        for (0..n) |i| threads[i] = std.Thread.spawn(cfg, spinner, .{}) catch fail("spawn", .{});
        print("spinning\n", .{});
        spinner();
    } else if (std.mem.eql(u8, mode, "cpu")) {
        const p0 = clockNs(2);
        const m0 = clockNs(3);
        for (0..n) |i| threads[i] = std.Thread.spawn(cfg, cpuBurner, .{i}) catch fail("spawn", .{});
        while (finished.load(.seq_cst) < n) sleepMs(1);
        const mid = clockNs(2) - p0;
        const own_mid = clockNs(3) - m0;
        ack.store(1, .seq_cst);
        _ = notify(&ack, @intCast(n));
        for (0..n) |i| threads[i].join();
        const grew = clockNs(2) - p0;
        // main's own: zig's join spins.
        const own = clockNs(3) - m0;
        var want: u64 = 0;
        for (0..n) |i| want += 2 * @as(u64, burned[i].load(.seq_cst)) * 1000;
        print("process cpu grew {d} ms while they waited, {d}% of the threads' (twice their first 200 ms) and main's own; {d} ms after the joins, {d}%\n", .{ mid / 1_000_000, mid * 100 / (want + own_mid), grew / 1_000_000, grew * 100 / (want + own) });
    } else if (std.mem.eql(u8, mode, "cpulive")) {
        for (0..n) |i| threads[i] = std.Thread.spawn(cfg, liveBurner, .{i}) catch fail("spawn", .{});
        while (started.load(.seq_cst) < n) sleepMs(1);
        sleepMs(50);
        const w0 = clockNs(1);
        const p0 = clockNs(2);
        var last = p0;
        var steps: usize = 0;
        for (0..10) |_| {
            sleepMs(50);
            const p = clockNs(2);
            if (p < last) fail("the process cpu time went back from {d} to {d}", .{ last, p });
            if (p > last) steps += 1;
            last = p;
        }
        const wall = clockNs(1) - w0;
        stop.store(1, .seq_cst);
        for (0..n) |i| threads[i].join();
        print("process cpu grew {d} ms in {d} ms of wall time, {d}.{d:0>2} x, {d} of 10 readings larger than the one before\n", .{ (last - p0) / 1_000_000, wall / 1_000_000, (last - p0) / wall, (last - p0) * 100 / wall % 100, steps });
    } else if (std.mem.eql(u8, mode, "cpuidle")) {
        threads[0] = std.Thread.spawn(cfg, futexWaiter, .{}) catch fail("spawn", .{});
        threads[1] = std.Thread.spawn(cfg, sleeper, .{}) catch fail("spawn", .{});
        while (started.load(.seq_cst) < 2) sleepMs(1);
        sleepMs(50);
        const p0 = clockNs(2);
        sleepMs(400);
        const grew = clockNs(2) - p0;
        wake.store(1, .seq_cst);
        _ = notify(&wake, 1);
        threads[0].join();
        threads[1].join();
        print("process cpu grew {d} ms in 400 ms with two threads waiting\n", .{grew / 1_000_000});
    } else if (std.mem.eql(u8, mode, "cpustart")) {
        const p0 = clockNs(2) / 1_000_000;
        const m0 = clockNs(3) / 1_000_000;
        const t = std.Thread.spawn(cfg, startReader, .{}) catch fail("spawn", .{});
        t.join();
        print("process {d} ms, main {d} ms at the start; the thread {d} ms at its start; process {d} ms after the join\n", .{ p0, m0, thread_start_cpu.load(.seq_cst) / 1000, clockNs(2) / 1_000_000 });
    } else {
        fail("usage: threads.wasm files|stdin|exit|trap|spin|cpu|cpulive|cpuidle|cpustart [N]", .{});
    }
}
