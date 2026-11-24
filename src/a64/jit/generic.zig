// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa
//! A64 JIT: the `generic` ops that compiled code runs inline instead of
//! calling the interpreter (emit.zig, `generic`). The tier keeps them
//! `generic` (the reference interpreter runs them there); these are the
//! frequent ones on the image, measured 2026-11-18 with a stats kernel:
//! musl's soft long double in printf (busybox `seq`: FMOV between general
//! and FP registers, MRS FPCR, MOVI, ORR (vector) as MOV, FCMPE) and its
//! memset (DUP, MOVI, MVNI, MRS DCZID_EL0), and UMOV/INS of 64-bit lanes;
//! and V8's scalar FP (SCVTF, FCVTZS, FADD, FMUL, FSQRT, ...), with a fast
//! path and the interpreter on the rest (see "scalar FP" below).
//!
//!   decode(raw) ?Fast   the word's fast form, only for encodings the
//!                       reference accepts with exactly that meaning
//!   usage(f) Use        what it reads and writes
//!   emit(e, f, at)      its code; FCMP hands back on a NaN operand or
//!                       FPCR.FZ (flags or flushing to compute), the FP
//!                       arithmetic calls the interpreter off its fast path
//!
//! Each is checked against the reference by emit.zig's generic kind test.

const std = @import("std");
const c = @import("../common.zig");
const ops = @import("../ops.zig");
const jc = @import("../../emu/jitcore.zig");
const simd_move = @import("../simd_move.zig");
const branch = @import("../branch.zig");
const jit = @import("emit.zig");
const cm = @import("common.zig");
const alu = @import("alu.zig");
const fa = @import("../fparith.zig");
const opexec = @import("../opexec.zig");
const Use = jit.Use;
const Emit = jit.Emit;
const At = jit.At;
const W = jc.W;

pub const Kind = enum(u8) {
    /// Xd = (Vn's 64-bit half h) & mask (FMOV Wd/Xd from Sn/Dn/Vn.D[1], UMOV)
    to_x,
    /// Vd: lo = Xn & mask, hi = 0 (FMOV Sd, Wn and Dd, Xn)
    from_x,
    /// Vd's half h = Xn (FMOV Vd.D[1], Xn; INS Vd.D[i], Xn)
    ins64,
    /// Vd = the constant k in lo and, if q, in hi (MOVI, MVNI)
    movi,
    /// Vd = n op m per half (AND, BIC, ORR, ORN, EOR; vector)
    logic,
    /// Vd = (Xn & mask) * pattern in lo and, if q, in hi (DUP general)
    dup,
    /// Xt = regs.fpcr / regs.fpsr (MRS)
    mrs_fp,
    /// Xt = NZCV (MRS)
    mrs_nzcv,
    /// Xt = the constant k (MRS DCZID_EL0, CTR_EL0, CNTFRQ_EL0, etc.)
    mrs_k,
    /// NZCV = compare of Sn/Dn with Sm/Dm or +0 (FCMP, FCMPE)
    fcmp,
    /// Sd/Dd = Sn/Dn op Sm/Dm (FMUL, FDIV, FADD, FSUB: op 0..3; h: double)
    farith,
    /// Sd/Dd = sqrt(Sn/Dn) (FSQRT)
    fsqrt,
    /// Sd/Dd = Sn/Dn with its sign kept, cleared or flipped (FMOV, FABS,
    /// FNEG (register): op 0..2)
    fmov1,
    /// Sd/Dd = the constant k (FMOV (immediate))
    fimm,
    /// Sd/Dd = the condition k holds ? Sn/Dn : Sm/Dm (FCSEL)
    fcsel,
    /// Sd/Dd = Wn/Xn (SCVTF, UCVTF (integer): op 1 unsigned; q: Xn)
    cvtf,
    /// Wd/Xd = Sn/Dn rounded towards zero (FCVTZS, FCVTZU (integer): op 1
    /// unsigned; q: Xd)
    cvtz,
    /// Dd = Sn (h 0) or Sd = Dn (h 1) (FCVT)
    fcvt,
    /// Sd/Dd = round(Sn/Dn) (FRINTN, FRINTP, FRINTM, FRINTZ: op 0..3; h: double)
    frint,
};

pub const Fast = struct {
    kind: Kind,
    /// Register numbers (V or X by kind; 31 is XZR for X).
    d: u8 = 0,
    n: u8 = 0,
    m: u8 = 0,
    /// to_x: which half (0 lo, 1 hi) and the shift in it; ins64: the half;
    /// mrs_fp: 0 FPCR, 1 FPSR; fcmp: 1 = double.
    h: u8 = 0,
    shift: u8 = 0,
    q: bool = false,
    /// fcmp: compare with +0.0
    zero: bool = false,
    /// logic: 0 AND, 1 BIC, 2 ORR, 3 ORN, 4 EOR
    op: u8 = 0,
    mask: u64 = 0,
    k: u64 = 0,
    /// The raw word (the FP kinds call the interpreter with it on their
    /// slow path).
    raw: u32 = 0,
};

fn bits(x: u32, comptime hi: u5, comptime lo: u5) u32 {
    return c.bits(x, hi, lo);
}

pub fn decode(raw: u32) ?Fast {
    const d: u8 = @intCast(raw & 31);
    const n: u8 = @intCast((raw >> 5) & 31);
    const m: u8 = @intCast((raw >> 16) & 31);
    // FMOV (general): sf 0 0 11110 ftype 1 rmode opcode 000000 Rn Rd
    switch (raw & 0xffff_fc00) {
        0x1e26_0000 => return .{ .kind = .to_x, .d = d, .n = n, .mask = 0xffff_ffff }, // fmov wd, sn
        0x9e66_0000 => return .{ .kind = .to_x, .d = d, .n = n, .mask = ~@as(u64, 0) }, // fmov xd, dn
        0x9eae_0000 => return .{ .kind = .to_x, .d = d, .n = n, .h = 1, .mask = ~@as(u64, 0) }, // fmov xd, vn.d[1]
        0x1e27_0000 => return .{ .kind = .from_x, .d = d, .n = n, .mask = 0xffff_ffff }, // fmov sd, wn
        0x9e67_0000 => return .{ .kind = .from_x, .d = d, .n = n, .mask = ~@as(u64, 0) }, // fmov dd, xn
        0x9eaf_0000 => return .{ .kind = .ins64, .d = d, .n = n, .h = 1 }, // fmov vd.d[1], xn
        else => {},
    }
    // MRS Xt, <reg> (L = 1, op0 = 3, op1 = 3 or 0)
    switch (raw & 0xffff_ffe0) {
        0xd53b_4400 => return .{ .kind = .mrs_fp, .d = d, .h = 0 }, // FPCR
        0xd53b_4420 => return .{ .kind = .mrs_fp, .d = d, .h = 1 }, // FPSR
        0xd53b_4200 => return .{ .kind = .mrs_nzcv, .d = d },
        0xd53b_00e0 => return .{ .kind = .mrs_k, .d = d, .k = branch.dczid },
        0xd53b_0020 => return .{ .kind = .mrs_k, .d = d, .k = branch.ctr },
        0xd53b_e000 => return .{ .kind = .mrs_k, .d = d, .k = branch.cntfrq },
        0xd53b_d060 => return .{ .kind = .mrs_k, .d = d, .k = 0 }, // TPIDRRO_EL0
        0xd538_0000 => return .{ .kind = .mrs_k, .d = d, .k = branch.midr },
        0xd538_00a0 => return .{ .kind = .mrs_k, .d = d, .k = branch.mpidr },
        0xd538_00c0 => return .{ .kind = .mrs_k, .d = d, .k = 0 }, // REVIDR_EL1
        0xd538_0400 => return .{ .kind = .mrs_k, .d = d, .k = branch.id_aa64pfr0 },
        0xd538_0500 => return .{ .kind = .mrs_k, .d = d, .k = branch.id_aa64dfr0 },
        0xd538_0700 => return .{ .kind = .mrs_k, .d = d, .k = branch.id_aa64mmfr0 },
        else => {},
    }
    // AdvSIMD modified immediate: MOVI, MVNI (not ORR/BIC, not FMOV half)
    if (raw & 0x9ff8_0c00 == 0x0f00_0400) {
        const q = raw & (1 << 30) != 0;
        const op = raw & (1 << 29) != 0;
        const cmode: u4 = @intCast(bits(raw, 15, 12));
        if (cmode & 1 == 1 and cmode < 12) return null; // ORR, BIC: read Vd
        const imm8: u8 = @intCast((bits(raw, 18, 16) << 5) | bits(raw, 9, 5));
        const imm = simd_move.expandImm(op, cmode, imm8, q) orelse return null;
        return .{ .kind = .movi, .d = d, .q = q, .k = if (op and cmode < 14) ~imm else imm };
    }
    // AdvSIMD three same, logical: AND, BIC, ORR, ORN, EOR (not BSL/BIT/BIF)
    if (raw & 0x9f20_fc00 == 0x0e20_1c00) {
        const op = (bits(raw, 29, 29) << 2) | bits(raw, 23, 22);
        if (op > 4) return null;
        return .{ .kind = .logic, .d = d, .n = n, .m = m, .q = raw & (1 << 30) != 0, .op = @intCast(op) };
    }
    // AdvSIMD copy: DUP (general), INS (general), UMOV
    if (raw & 0xbfe0_8400 == 0x0e00_0400) {
        const q = raw & (1 << 30) != 0;
        const imm5 = bits(raw, 20, 16);
        if (imm5 & 15 == 0) return null;
        const size: u6 = @intCast(@ctz(imm5));
        const index = imm5 >> @intCast(size + 1);
        const esize: u7 = @as(u7, 8) << @intCast(size);
        const mask: u64 = if (esize == 64) ~@as(u64, 0) else (@as(u64, 1) << @intCast(esize)) - 1;
        const bit = index * esize; // 0..127
        switch (bits(raw, 14, 11)) {
            0b0001 => { // DUP (general)
                if (size == 3 and !q) return null;
                return .{ .kind = .dup, .d = d, .n = n, .q = q, .mask = mask, .k = c.replicate(1, esize) };
            },
            0b0011 => { // INS (general): only whole 64-bit lanes
                if (!q or size != 3) return null;
                return .{ .kind = .ins64, .d = d, .n = n, .h = @intCast(bit >> 6) };
            },
            0b0111 => { // UMOV
                if ((q and size != 3) or (!q and size == 3)) return null;
                return .{ .kind = .to_x, .d = d, .n = n, .h = @intCast(bit >> 6), .shift = @intCast(bit & 63), .mask = mask };
            },
            else => return null,
        }
    }
    // FCMP, FCMPE (single, double; register or #0.0)
    if (raw & 0xffa0_fc07 == 0x1e20_2000) {
        return .{ .kind = .fcmp, .n = n, .m = m, .h = @intCast(bits(raw, 22, 22)), .zero = raw & 8 != 0 };
    }
    return decodeFp(raw, d, n, m);
}

/// Scalar FP data processing and conversions (fp.zig's encodings, single
/// and double only).
fn decodeFp(raw: u32, d: u8, n: u8, m: u8) ?Fast {
    const h: u8 = @intCast(bits(raw, 22, 22));
    // ftype 00 or 01 (bit 23 clear), M = S = 0, bit 21 set
    if (raw & 0x7fa0_0000 != 0x1e20_0000) return null;
    const sf = raw >> 31 != 0;
    // Conversion (integer): sf 0 0 11110 ftype 1 rmode opcode 000000 Rn Rd
    if (bits(raw, 15, 10) == 0) {
        return switch (bits(raw, 20, 16)) {
            0b00_010, 0b00_011 => .{ .kind = .cvtf, .d = d, .n = n, .h = h, .q = sf, .op = @intCast(bits(raw, 16, 16)), .raw = raw },
            0b11_000, 0b11_001 => .{ .kind = .cvtz, .d = d, .n = n, .h = h, .q = sf, .op = @intCast(bits(raw, 16, 16)), .raw = raw },
            else => null,
        };
    }
    if (sf) return null; // M
    // 1 source: opcode 10000 Rn Rd
    if (bits(raw, 14, 10) == 0b10000) {
        return switch (bits(raw, 20, 15)) {
            0, 1, 2 => .{ .kind = .fmov1, .d = d, .n = n, .h = h, .op = @intCast(bits(raw, 20, 15)), .raw = raw },
            3 => .{ .kind = .fsqrt, .d = d, .n = n, .h = h, .raw = raw },
            8, 9, 10, 11 => .{ .kind = .frint, .d = d, .n = n, .h = h, .op = @intCast(bits(raw, 17, 15) & 3), .raw = raw },
            0b000101 => if (h == 0) .{ .kind = .fcvt, .d = d, .n = n, .h = 0, .raw = raw } else null, // FCVT Dd, Sn
            0b000100 => if (h == 1) .{ .kind = .fcvt, .d = d, .n = n, .h = 1, .raw = raw } else null, // FCVT Sd, Dn
            else => null,
        };
    }
    // Immediate: imm8 100 00000 Rd
    if (bits(raw, 12, 10) == 0b100) {
        if (bits(raw, 9, 5) != 0) return null;
        const imm8: u8 = @intCast(bits(raw, 20, 13));
        return .{ .kind = .fimm, .d = d, .h = h, .k = if (h == 1) fa.expandImm(u64, imm8) else fa.expandImm(u32, imm8), .raw = raw };
    }
    if (bits(raw, 13, 10) == 0b1000) return null; // compare (above)
    return switch (bits(raw, 11, 10)) {
        // 2 source: Rm opcode 10 Rn Rd
        0b10 => if (bits(raw, 15, 12) <= 3) .{ .kind = .farith, .d = d, .n = n, .m = m, .h = h, .op = @intCast(bits(raw, 15, 12)), .raw = raw } else null,
        // FCSEL: Rm cond 11 Rn Rd
        0b11 => .{ .kind = .fcsel, .d = d, .n = n, .m = m, .h = h, .k = ops.condMask(@intCast(bits(raw, 15, 12))), .raw = raw },
        else => null,
    };
}

fn xs(r: u8) u8 {
    return if (r == 31) ops.zr else r;
}
fn vlo(r: u8) u8 {
    return ops.v0_slot + 2 * r;
}

pub fn usage(f: Fast) Use {
    return switch (f.kind) {
        .to_x => cm.rd(vlo(f.n)).with(cm.wr(xs(f.d))),
        .from_x => cm.rd(xs(f.n)).with(cm.wr(vlo(f.d))),
        .ins64 => cm.rd(xs(f.n)).with(cm.rd(vlo(f.d))).with(cm.wr(vlo(f.d))),
        .movi => cm.wr(vlo(f.d)),
        .logic => cm.rd(vlo(f.n)).with(cm.rd(vlo(f.m))).with(cm.wr(vlo(f.d))),
        .dup => cm.rd(xs(f.n)).with(cm.wr(vlo(f.d))),
        .mrs_fp, .mrs_k => cm.wr(xs(f.d)),
        .mrs_nzcv => cm.wr(xs(f.d)).with(.{ .flags_read = true }),
        .fcmp => cm.rd(vlo(f.n)).with(if (f.zero) .{} else cm.rd(vlo(f.m))).with(.{ .flags_write = true }),
        .farith => cm.rd(vlo(f.n)).with(cm.rd(vlo(f.m))).with(cm.wr(vlo(f.d))),
        .fsqrt, .fmov1, .fcvt, .frint => cm.rd(vlo(f.n)).with(cm.wr(vlo(f.d))),
        .fimm => cm.wr(vlo(f.d)),
        .fcsel => cm.rd(vlo(f.n)).with(cm.rd(vlo(f.m))).with(cm.wr(vlo(f.d))).with(.{ .flags_read = true }),
        .cvtf => cm.rd(xs(f.n)).with(cm.wr(vlo(f.d))),
        .cvtz => cm.rd(vlo(f.n)).with(cm.wr(xs(f.d))),
    };
}

fn andMask(e: *Emit, m: u64) void {
    if (m == ~@as(u64, 0)) return;
    e.k64(m);
    e.op(W.i64_and);
}

/// Push FP operand r (single: its low 32 bits as f32; double: lo as f64).
fn fp(e: *Emit, r: u8, double: bool) void {
    cm.get(e, vlo(r));
    if (double) e.op(0xbf) else { // f64.reinterpret_i64
        e.op(W.i32_wrap);
        e.op(0xbe); // f32.reinterpret_i32
    }
}
fn fzero(e: *Emit, double: bool) void {
    if (double) e.kf(0.0) else {
        e.op(0x43); // f32.const 0
        e.ops(&.{ 0, 0, 0, 0 });
    }
}
/// Push the i32 "operand is a NaN".
fn isNan(e: *Emit, r: u8, double: bool) void {
    fp(e, r, double);
    fp(e, r, double);
    e.op(if (double) W.f64_ne else 0x5c); // f32.ne
}

const fpcr_off = cm.off(ops.nzcv_slot) + 4;

pub fn emit(e: *Emit, f: Fast, at: At) void {
    switch (f.kind) {
        .to_x => {
            cm.get(e, vlo(f.n) + f.h);
            if (f.shift != 0) {
                e.k64(f.shift);
                e.op(W.i64_shr_u);
            }
            andMask(e, f.mask);
            cm.set(e, xs(f.d));
        },
        .from_x => {
            cm.get(e, xs(f.n));
            andMask(e, f.mask);
            cm.setScalar(e, vlo(f.d));
        },
        .ins64 => {
            cm.get(e, xs(f.n));
            cm.set(e, vlo(f.d) + f.h);
        },
        .movi => {
            e.k64(f.k);
            if (e.simd and f.q) {
                e.vop(cm.S.i64x2_splat);
                cm.setV(e, f.d);
            } else if (e.simd or !f.q) {
                cm.setScalar(e, vlo(f.d));
            } else {
                cm.set(e, vlo(f.d));
                e.k64(f.k);
                cm.set(e, vlo(f.d) + 1);
            }
        },
        .logic => if (e.simd) {
            cm.getV(e, f.n);
            cm.getV(e, f.m);
            switch (f.op) {
                0 => e.vop(cm.S.v128_and),
                1 => e.vop(cm.S.v128_andnot),
                2 => e.vop(cm.S.v128_or),
                3 => {
                    e.vop(cm.S.v128_not);
                    e.vop(cm.S.v128_or);
                },
                else => e.vop(cm.S.v128_xor),
            }
            cm.setVq(e, f.d, f.q);
        } else {
            // The halves of n and m go through l_t first: d may be n or m.
            for (0..2) |h| {
                if (h == 1 and !f.q) {
                    e.k64(0);
                } else {
                    cm.get(e, vlo(f.n) + @as(u8, @intCast(h)));
                    cm.get(e, vlo(f.m) + @as(u8, @intCast(h)));
                    if (f.op == 1 or f.op == 3) {
                        e.k64(~@as(u64, 0));
                        e.op(W.i64_xor);
                    }
                    e.op(switch (f.op) {
                        0, 1 => W.i64_and,
                        2, 3 => W.i64_or,
                        else => W.i64_xor,
                    });
                }
                e.set(cm.l_t + @as(u32, @intCast(h)));
            }
            e.get(cm.l_t);
            cm.set(e, vlo(f.d));
            e.get(cm.l_t + 1);
            cm.set(e, vlo(f.d) + 1);
        },
        .dup => {
            cm.get(e, xs(f.n));
            andMask(e, f.mask);
            if (f.k != 1) {
                e.k64(f.k);
                e.op(W.i64_mul);
            }
            if (e.simd) {
                e.vop(cm.S.i64x2_splat);
                cm.setVq(e, f.d, f.q);
                return;
            }
            e.set(cm.l_t);
            e.get(cm.l_t);
            cm.set(e, vlo(f.d));
            if (f.q) e.get(cm.l_t) else e.k64(0);
            cm.set(e, vlo(f.d) + 1);
        },
        .mrs_fp => {
            e.get(jc.l_x);
            e.addr();
            e.mem(W.i64_load32_u, 2, fpcr_off + 4 * @as(u64, f.h));
            cm.set(e, xs(f.d));
        },
        .mrs_nzcv => {
            alu.nzcv(e);
            cm.set(e, xs(f.d));
        },
        .mrs_k => {
            e.k64(f.k);
            cm.set(e, xs(f.d));
        },
        .fcmp => {
            const dbl = f.h == 1;
            // NaN operands (FPSR.IOC, unordered) and FPCR.FZ (denormal
            // operands flushed, FPSR.IDC): the interpreter.
            isNan(e, f.n, dbl);
            if (!f.zero) {
                isNan(e, f.m, dbl);
                e.op(W.i32_or);
            }
            e.get(jc.l_x);
            e.addr();
            e.mem(W.i32_load, 2, fpcr_off);
            e.k32(24);
            e.op(W.i32_shr_u);
            e.k32(1);
            e.op(W.i32_and);
            e.op(W.i32_or);
            e.open(W.@"if", W.void_t);
            e.handBack(at.k, at.pc);
            e.close();
            // less: N; equal: Z C; greater: C
            e.k64(c.N);
            e.k64(c.Z | c.C);
            e.k64(c.C);
            fp(e, f.n, dbl);
            if (f.zero) fzero(e, dbl) else fp(e, f.m, dbl);
            e.op(if (dbl) W.f64_eq else W.f32_eq);
            e.op(W.select);
            fp(e, f.n, dbl);
            if (f.zero) fzero(e, dbl) else fp(e, f.m, dbl);
            e.op(if (dbl) W.f64_lt else W.f32_lt);
            e.op(W.select);
            e.set(cm.l_nzcv);
            alu.exactNow(e);
        },
        .farith, .fsqrt, .cvtf, .cvtz, .fcvt, .frint => fpFast(e, f, at),
        .fmov1 => {
            const sign: u64 = if (f.h == 1) 1 << 63 else 1 << 31;
            cm.get(e, vlo(f.n));
            if (f.h == 0) andMask(e, 0xffff_ffff);
            switch (f.op) {
                1 => andMask(e, ~sign),
                2 => {
                    e.k64(sign);
                    e.op(W.i64_xor);
                },
                else => {},
            }
            cm.setScalar(e, vlo(f.d));
        },
        .fimm => {
            e.k64(f.k);
            cm.setScalar(e, vlo(f.d));
        },
        .fcsel => {
            const m: u64 = if (f.h == 1) ~@as(u64, 0) else 0xffff_ffff;
            cm.get(e, vlo(f.n));
            andMask(e, m);
            cm.get(e, vlo(f.m));
            andMask(e, m);
            alu.cond(e, @intCast(f.k));
            e.op(W.select);
            cm.setScalar(e, vlo(f.d));
        },
    }
}

// ---- scalar FP arithmetic and conversions -----------------------------------------
//
// Bit-exact with the interpreter (fparith.zig) on a fast path, and the
// interpreter itself (opexec.jitGeneric) on the rest. The fast path needs
// FPCR.RMode = round to nearest and FPCR.FZ = 0 (DN and AHP do not matter
// for it: it never produces or meets a NaN, nor a half), and a result that
// is a normal number away from both ends of the range (biased exponent 2 ..
// max - 1: no NaN, infinity, zero, denormal, overflow or underflow, so no
// flag but IXC can arise and wasm's result is the Arm one). IXC is ORed in
// when the result is inexact: exactly computed for FADD/FSUB (TwoSum in the
// same format), single FMUL/FDIV/FSQRT (the exact product in double), the
// conversions; for double FMUL, FDIV and FSQRT the fast path is taken only
// when FPSR.IXC is set already (an exact product would need an FMA, which
// MVP wasm lacks). Conversions to an integer take the path while the
// truncated value is in range (no IOC), and from an integer always (the
// result is a normal number or zero).

const fpsr_off = fpcr_off + 4;
const fpcr_fast_mask: i32 = @bitCast(c.FPCR_FZ | (3 << c.FPCR_RMODE_SHIFT));

const Fo = struct {
    const f32_ceil = 0x8d;
    const f32_floor = 0x8e;
    const f32_trunc = 0x8f;
    const f32_nearest = 0x90;
    const f32_sqrt = 0x91;
    const f32_add = 0x92;
    const f32_sub = 0x93;
    const f32_mul = 0x94;
    const f32_div = 0x95;
    const f64_ceil = 0x9b;
    const f64_floor = 0x9c;
    const f64_trunc = 0x9d;
    const f64_nearest = 0x9e;
    const f64_neg = 0x9a;
    const f64_sqrt = 0x9f;
    const f64_add = 0xa0;
    const f64_sub = 0xa1;
    const f64_mul = 0xa2;
    const f64_div = 0xa3;
    const f32_neg = 0x8c;
    const f64_ne = 0x62;
    const f64_lt = 0x63;
    const f64_gt = 0x64;
    const f32_ne = 0x5c;
    const i64_trunc_f64_s = 0xb0;
    const i64_trunc_f64_u = 0xb1;
    const f32_convert_i64_s = 0xb4;
    const f32_convert_i64_u = 0xb5;
    const f32_demote = 0xb6;
    const f64_convert_i64_s = 0xb9;
    const f64_convert_i64_u = 0xba;
    const f64_promote = 0xbb;
    const i32_reinterpret = 0xbc;
    const i64_reinterpret = 0xbd;
    const f32_reinterpret = 0xbe;
    const f64_reinterpret = 0xbf;
    const i64_clz = 0x79;
    const i64_ctz = 0x7a;
};

/// Push local l (raw bits) as an f64 or f32.
fn pushF(e: *Emit, l: u32, dbl: bool) void {
    e.get(l);
    if (dbl) e.op(Fo.f64_reinterpret) else {
        e.op(W.i32_wrap);
        e.op(Fo.f32_reinterpret);
    }
}
/// Pop an f64 or f32 into local l as its raw bits (zero-extended).
fn popF(e: *Emit, l: u32, dbl: bool) void {
    if (dbl) e.op(Fo.i64_reinterpret) else {
        e.op(Fo.i32_reinterpret);
        e.op(W.i64_ext_u);
    }
    e.set(l);
}
/// Push local l (single) as an exact f64.
fn pushSD(e: *Emit, l: u32) void {
    pushF(e, l, false);
    e.op(Fo.f64_promote);
}
fn fop(e: *Emit, dbl: bool, d: u8, s_: u8) void {
    e.op(if (dbl) d else s_);
}

/// The i64 local holding slot `slot` (a V half): its own local, or with
/// SIMD a copy in `scratch`.
fn srcLocal(e: *Emit, slot: u8, scratch: u32) u32 {
    if (!e.simd) return cm.local(slot);
    cm.get(e, slot);
    e.set(scratch);
    return scratch;
}

/// Push the i32 "the raw bits in local l are a normal number with a biased
/// exponent of 2 .. max - 1".
fn inRange(e: *Emit, l: u32, dbl: bool) void {
    e.get(l);
    e.k64(if (dbl) 52 else 23);
    e.op(W.i64_shr_u);
    e.k64(if (dbl) 0x7ff else 0xff);
    e.op(W.i64_and);
    e.k64(2);
    e.op(W.i64_sub);
    e.k64(if (dbl) 0x7ff - 3 else 0xff - 3);
    e.op(W.i64_lt_u);
}

/// Push the i32 "FPCR allows the fast path" (round to nearest, FZ = 0).
fn fpcrFast(e: *Emit) void {
    e.get(jc.l_x);
    e.addr();
    e.mem(W.i32_load, 2, fpcr_off);
    e.k32(fpcr_fast_mask);
    e.op(W.i32_and);
    e.op(W.i32_eqz);
}

/// Push the i32 "FPSR.IXC is set" (0 or 1).
fn ixcSet(e: *Emit) void {
    e.get(jc.l_x);
    e.addr();
    e.mem(W.i32_load, 2, fpsr_off);
    e.k32(@ctz(c.FPSR_IXC));
    e.op(W.i32_shr_u);
    e.k32(1);
    e.op(W.i32_and);
}

/// Push the i32 "FPCR.FZ is clear".
fn fzClear(e: *Emit) void {
    e.get(jc.l_x);
    e.addr();
    e.mem(W.i32_load, 2, fpcr_off);
    e.k32(@bitCast(c.FPCR_FZ));
    e.op(W.i32_and);
    e.op(W.i32_eqz);
}

/// Push the i32 "the i64 mag (an integer magnitude, as the u64 in local l)
/// has more than `p` significant bits" (a conversion to a format of
/// precision p is inexact).
fn wide(e: *Emit, l: u32, p: u64) void {
    e.k64(64);
    e.get(l);
    e.op(Fo.i64_clz);
    e.op(W.i64_sub);
    e.get(l);
    e.op(Fo.i64_ctz);
    e.op(W.i64_sub);
    e.k64(p);
    e.op(W.i64_gt_s);
}

/// The slow path: the interpreter runs the word (it cannot fault or trap,
/// and touches only Vn/Vm/Xn, Vd/Xd and FPSR): what it reads is written to
/// memory first, what it writes loaded after.
fn fpSlow(e: *Emit, f: Fast, at: At) void {
    if (!e.table) {
        e.handBack(at.k, at.pc);
        return;
    }
    const reads: [2]u8 = switch (f.kind) {
        .cvtf => .{ xs(f.n), ops.zr },
        .farith => .{ vlo(f.n), vlo(f.m) },
        else => .{ vlo(f.n), ops.zr },
    };
    for (reads) |r| {
        if (r == ops.zr) continue;
        e.get(jc.l_x);
        e.addr();
        cm.get(e, r);
        e.mem(W.i64_store, 3, cm.off(r));
    }
    e.get(jc.l_x);
    e.get(jc.l_cpu);
    e.k64(f.raw);
    e.k64(at.pc);
    e.callTable(@intFromPtr(&opexec.jitGeneric));
    e.op(W.drop);
    if (f.kind != .cvtz) return cm.loadV(e, f.d);
    if (xs(f.d) == ops.zr) return;
    e.get(jc.l_x);
    e.addr();
    e.mem(W.i64_load, 3, cm.off(xs(f.d)));
    cm.set(e, xs(f.d));
}

/// FADD, FSUB, FMUL, FDIV, FSQRT, SCVTF, UCVTF, FCVTZS, FCVTZU, FCVT (see
/// above). Locals: t0 the result (raw bits or the integer), t1 "inexact"
/// (0/1), t2 scratch (an f64 or the integer's magnitude), t3 scratch.
fn fpFast(e: *Emit, f: Fast, at: At) void {
    const dbl = f.h == 1;
    const t0 = cm.l_t;
    const t1 = cm.l_t + 1;
    const t2 = cm.l_t + 2;
    const t3 = cm.l_t + 3;
    const ln = if (f.kind == .cvtf) 0 else srcLocal(e, vlo(f.n), cm.l_t + 4);
    const lm = if (f.kind == .farith) srcLocal(e, vlo(f.m), cm.l_t + 5) else 0;
    // Pushes the i32 "fast path"; leaves the result in t0, inexact in t1.
    switch (f.kind) {
        .farith => {
            pushF(e, ln, dbl);
            pushF(e, lm, dbl);
            fop(e, dbl, switch (f.op) {
                0 => Fo.f64_mul,
                1 => Fo.f64_div,
                2 => Fo.f64_add,
                else => Fo.f64_sub,
            }, switch (f.op) {
                0 => Fo.f32_mul,
                1 => Fo.f32_div,
                2 => Fo.f32_add,
                else => Fo.f32_sub,
            });
            popF(e, t0, dbl);
            if (f.op >= 2) {
                // TwoSum (exact without overflow): bb = r - a, err = (a - (r - bb)) + (b' - bb), b' = b or -b
                pushF(e, t0, dbl);
                pushF(e, ln, dbl);
                fop(e, dbl, Fo.f64_sub, Fo.f32_sub);
                popF(e, t2, dbl); // bb
                pushF(e, ln, dbl);
                pushF(e, t0, dbl);
                pushF(e, t2, dbl);
                fop(e, dbl, Fo.f64_sub, Fo.f32_sub);
                fop(e, dbl, Fo.f64_sub, Fo.f32_sub);
                pushF(e, lm, dbl);
                if (f.op == 3) fop(e, dbl, Fo.f64_neg, Fo.f32_neg);
                pushF(e, t2, dbl);
                fop(e, dbl, Fo.f64_sub, Fo.f32_sub);
                fop(e, dbl, Fo.f64_add, Fo.f32_add);
                popF(e, t3, dbl); // err
                // inexact = err != 0
                pushF(e, t3, dbl);
                if (dbl) e.kf(0.0) else f32zero(e);
                fop(e, dbl, Fo.f64_ne, Fo.f32_ne);
                e.op(W.i64_ext_u);
                e.set(t1);
                // fast: in range, err finite (err - err == 0)
                inRange(e, t0, dbl);
                pushF(e, t3, dbl);
                pushF(e, t3, dbl);
                fop(e, dbl, Fo.f64_sub, Fo.f32_sub);
                if (dbl) e.kf(0.0) else f32zero(e);
                e.op(if (dbl) W.f64_eq else W.f32_eq);
                e.op(W.i32_and);
            } else if (dbl) {
                e.k64(0);
                e.set(t1);
                inRange(e, t0, dbl);
                ixcSet(e);
                e.op(W.i32_and);
            } else {
                // The exact product in double: a * b (FMUL) against r, or
                // r * b (FDIV) against a.
                if (f.op == 0) {
                    pushSD(e, ln);
                    pushSD(e, lm);
                    e.op(Fo.f64_mul);
                    pushSD(e, t0);
                } else {
                    pushSD(e, t0);
                    pushSD(e, lm);
                    e.op(Fo.f64_mul);
                    pushSD(e, ln);
                }
                e.op(Fo.f64_ne);
                e.op(W.i64_ext_u);
                e.set(t1);
                inRange(e, t0, dbl);
            }
        },
        .fsqrt => {
            pushF(e, ln, dbl);
            fop(e, dbl, Fo.f64_sqrt, Fo.f32_sqrt);
            popF(e, t0, dbl);
            if (dbl) {
                e.k64(0);
                e.set(t1);
                inRange(e, t0, dbl);
                ixcSet(e);
                e.op(W.i32_and);
            } else {
                pushSD(e, t0);
                pushSD(e, t0);
                e.op(Fo.f64_mul);
                pushSD(e, ln);
                e.op(Fo.f64_ne);
                e.op(W.i64_ext_u);
                e.set(t1);
                inRange(e, t0, dbl);
            }
        },
        .frint => {
            pushF(e, ln, dbl);
            fop(e, dbl, switch (f.op) {
                0 => Fo.f64_nearest,
                1 => Fo.f64_ceil,
                2 => Fo.f64_floor,
                else => Fo.f64_trunc,
            }, switch (f.op) {
                0 => Fo.f32_nearest,
                1 => Fo.f32_ceil,
                2 => Fo.f32_floor,
                else => Fo.f32_trunc,
            });
            popF(e, t0, dbl);
            e.k64(0);
            e.set(t1);
            inRange(e, ln, dbl);
        },
        .cvtf => {
            // The integer, sign- or zero-extended from W; its magnitude.
            cm.get(e, xs(f.n));
            if (!f.q) {
                e.k64(32);
                e.op(W.i64_shl);
                e.k64(32);
                e.op(if (f.op == 1) W.i64_shr_u else W.i64_shr_s);
            }
            e.set(t3);
            if (f.op == 1) {
                e.get(t3);
            } else {
                // |x| (2^63 stays 2^63 as a u64)
                e.k64(0);
                e.get(t3);
                e.op(W.i64_sub);
                e.get(t3);
                e.get(t3);
                e.k64(0);
                e.op(W.i64_lt_s);
                e.op(W.select);
            }
            e.set(t2);
            wide(e, t2, if (dbl) 53 else 24);
            e.op(W.i64_ext_u);
            e.set(t1);
            e.get(t3);
            e.op(if (dbl)
                (if (f.op == 1) Fo.f64_convert_i64_u else Fo.f64_convert_i64_s)
            else if (f.op == 1) Fo.f32_convert_i64_u else Fo.f32_convert_i64_s);
            popF(e, t0, dbl);
            // Rounding as FPCR.RMode says: the fast path only with RNE.
            e.k32(1);
        },
        .cvtz => return cvtz(e, f, at),
        .fcvt => {
            if (dbl) {
                // Sd = Dn: the rounded single must be in range.
                pushF(e, ln, true);
                e.op(Fo.f32_demote);
                popF(e, t0, false);
                pushSD(e, t0);
                pushF(e, ln, true);
                e.op(Fo.f64_ne);
                e.op(W.i64_ext_u);
                e.set(t1);
                inRange(e, t0, false);
            } else {
                // Dd = Sn: exact; not for a NaN (quieted, payload rules).
                pushSD(e, ln);
                popF(e, t0, true);
                e.k64(0);
                e.set(t1);
                e.get(ln);
                e.k64(0x7fff_ffff);
                e.op(W.i64_and);
                e.k64(0x7f80_0000);
                e.op(W.i64_le_u);
            }
        },
        else => unreachable,
    }
    fpcrFast(e);
    e.op(W.i32_and);
    e.open(W.@"if", W.void_t);
    e.get(t0);
    cm.setScalar(e, vlo(f.d));
    // FPSR.IXC |= inexact
    e.get(t1);
    e.k64(@ctz(c.FPSR_IXC));
    e.op(W.i64_shl);
    e.set(t1);
    orFpsr(e, t1);
    e.op(W.@"else");
    fpSlow(e, f, at);
    e.close();
}

/// FPSR |= the flags in local l (an i64).
fn orFpsr(e: *Emit, l: u32) void {
    e.get(jc.l_x);
    e.addr();
    e.get(jc.l_x);
    e.addr();
    e.mem(W.i32_load, 2, fpsr_off);
    e.get(l);
    e.op(W.i32_wrap);
    e.op(W.i32_or);
    e.mem(W.i32_store, 2, fpsr_off);
}

/// FCVTZS, FCVTZU (integer): fparith.toFixed rounding towards zero, all of
/// it inline (a NaN gives 0, a value out of range saturates, both with
/// IOC; a fraction sets IXC); only FPCR.FZ (a denormal operand flushed,
/// IDC) takes the interpreter. Locals: t0 the result, t1 the flags, t2 the
/// operand as an f64 (exact for a single).
fn cvtz(e: *Emit, f: Fast, at: At) void {
    const t0 = cm.l_t;
    const t1 = cm.l_t + 1;
    const t2 = cm.l_t + 2;
    const ln = srcLocal(e, vlo(f.n), cm.l_t + 4);
    if (f.h == 1) pushF(e, ln, true) else pushSD(e, ln);
    e.op(Fo.i64_reinterpret);
    e.set(t2);
    // The open interval whose values truncate into range (-2^63 - 2048 is
    // the double below -2^63; both bounds fail for a NaN).
    const lo: f64, const hi: f64 = if (f.op == 1)
        .{ -1.0, if (f.q) 18446744073709551616.0 else 4294967296.0 }
    else if (f.q)
        .{ -9223372036854775808.0 - 2048.0, 9223372036854775808.0 }
    else
        .{ -2147483649.0, 2147483648.0 };
    const width: u6 = if (f.q) 63 else 31;
    const umax: u64 = if (f.q) ~@as(u64, 0) else 0xffff_ffff;
    // saturated: NaN 0, negative min, positive max
    const smin: u64 = if (f.op == 1) 0 else @as(u64, 1) << width;
    const smax: u64 = if (f.op == 1) umax else (@as(u64, 1) << width) - 1;
    fzClear(e);
    e.open(W.@"if", W.void_t);
    pushF(e, t2, true);
    e.kf(lo);
    e.op(Fo.f64_gt);
    pushF(e, t2, true);
    e.kf(hi);
    e.op(Fo.f64_lt);
    e.op(W.i32_and);
    e.open(W.@"if", W.void_t);
    pushF(e, t2, true);
    e.op(if (f.op == 1) Fo.i64_trunc_f64_u else Fo.i64_trunc_f64_s);
    if (!f.q) andMask(e, 0xffff_ffff);
    e.set(t0);
    // IXC if a fraction was cut off
    pushF(e, t2, true);
    e.op(Fo.f64_trunc);
    pushF(e, t2, true);
    e.op(Fo.f64_ne);
    e.op(W.i64_ext_u);
    e.k64(@ctz(c.FPSR_IXC));
    e.op(W.i64_shl);
    e.set(t1);
    e.op(W.@"else");
    e.k64(0);
    e.k64(smin);
    e.k64(smax);
    e.get(t2);
    e.k64(0);
    e.op(W.i64_lt_s); // the sign bit
    e.op(W.select);
    pushF(e, t2, true);
    pushF(e, t2, true);
    e.op(Fo.f64_ne); // NaN
    e.op(W.select);
    e.set(t0);
    e.k64(c.FPSR_IOC);
    e.set(t1);
    e.close();
    e.get(t0);
    cm.set(e, xs(f.d));
    orFpsr(e, t1);
    e.op(W.@"else");
    fpSlow(e, f, at);
    e.close();
}

fn f32zero(e: *Emit) void {
    e.op(0x43); // f32.const 0
    e.ops(&.{ 0, 0, 0, 0 });
}
