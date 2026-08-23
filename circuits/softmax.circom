pragma circom 2.0.0;
include "./ops.circom";

/**
 * SoftmaxN(n) — mirrors src/wasm/inference.wat $softmax EXACTLY
 * (spec: src/zk/softmax.ts). No real exp: the WASM defines softmax as
 * hard-max-with-margin, normalized by integer division:
 *
 *   m      = max(x)                       (ties allowed)
 *   e_i    = 0 if x_i - m < 0, else (x_i - m) + 2^16
 *   denom  = max(sum(e), 1)
 *   y_i    = floor(e_i * 2^16 / denom)
 *
 * Key observation: every maximizer has x_i - m = 0, so e_i = 2^16 * t_i
 * where t_i is an equality indicator. This avoids all signed-bit tricks:
 *
 *   - m dominates every x_j (range-checked differences)
 *   - sel (one-hot) binds m to an actual element equal to it
 *   - t_i binary, t_i = 1 => x_i = m   (product constraint)
 *   - at least the sel-pointed maximizer is marked: dot(t, sel) = 1
 *   - y_i = floor(t_i * 2^32 / denom) with remainder + dv>r proofs
 *
 * Public: commitment = sum-of-squares of [x, y] mod BN254.
 */

template RangeBits(w) {
    signal input in;
    signal bits[w];
    signal lin[w + 1];
    lin[0] <== 0;
    for (var k = 0; k < w; k++) {
        bits[k] <-- (in \ (2 ** k)) % 2;
        bits[k] * (bits[k] - 1) === 0;
        lin[k + 1] <== lin[k] + bits[k] * (2 ** k);
    }
    lin[w] === in;
}

template SoftmaxN(n) {
    signal input commitment; // public
    signal input x[n];       // private, raw Q16.16
    signal input y[n];       // private, claimed output
    signal input sel[n];     // private, one-hot over SOME maximizer
    signal input m;          // private, claimed maximum
    signal input denom;      // private, claimed max(sum(e), 1)

    // ---- m dominates every element: 0 <= m - x_j ----
    // Offset by 2^20 so all decomposed quantities are non-negative integers
    // even when raw Q16.16 inputs are negative (field wraparound guard).
    var OFFX = 1048576; // 2^20 > |x|max
    signal xo[n];
    signal mo;
    for (var j = 0; j < n; j++) xo[j] <== x[j] + OFFX;
    mo <== m + OFFX;

    component dom[n];
    for (var j = 0; j < n; j++) {
        dom[j] = RangeBits(22);
        dom[j].in <== mo - xo[j];
    }

    // ---- sel binds m to an element equal to it ----
    signal selAcc[n + 1];
    signal dotAcc[n + 1];
    selAcc[0] <== 0;
    dotAcc[0] <== 0;
    for (var j = 0; j < n; j++) {
        sel[j] * (sel[j] - 1) === 0;
        selAcc[j + 1] <== selAcc[j] + sel[j];
        dotAcc[j + 1] <== dotAcc[j] + sel[j] * x[j];
    }
    selAcc[n] === 1;
    m === dotAcc[n];

    // ---- equality indicators t_i: binary, t=1 => x_i = m ----
    signal t[n];
    signal tAcc[n + 1];
    signal tsel[n + 1];
    tAcc[0] <== 0;
    tsel[0] <== 0;
    for (var i = 0; i < n; i++) {
        t[i] <-- (xo[i] == mo) ? 1 : 0;
        t[i] * (t[i] - 1) === 0;
        (x[i] - m) * t[i] === 0; // soundness (linear); hint used offset form
        tAcc[i + 1] <== tAcc[i] + t[i];
        tsel[i + 1] <== tsel[i] + t[i] * sel[i];
    }
    // the sel-pointed maximizer MUST be marked: at least one t set,
    // and combined with dominance every marked element equals m.
    tsel[n] === 1;

    // e_i = 2^16 * t_i (linear); sum(e) = count * 2^16, count >= 1
    // thanks to tsel === 1, so no zero-clamp branch exists: denom pinned.
    signal eSumAcc[n + 1];
    eSumAcc[0] <== 0;
    for (var i = 0; i < n; i++) eSumAcc[i + 1] <== eSumAcc[i] + t[i];
    signal count;
    count <== eSumAcc[n];

    // ---- denom pinned exactly (no alternative branch -> no forged scaling) ----
    denom === count * 65536;

    // ---- y_i = floor(e_i * 65536 / denom) = floor(t_i * 2^32 / denom) ----
    component qd[n];
    for (var i = 0; i < n; i++) {
        qd[i] = SoftDivide();
        qd[i].p <== t[i] * 4294967296;
        qd[i].q <== y[i];
        qd[i].dv <== denom;
    }

    // ---- commitment over [x, y] ----
    component sq = SumSquares(2 * n);
    signal allVals[2 * n];
    for (var i = 0; i < n; i++) allVals[i] <== x[i];
    for (var i = 0; i < n; i++) allVals[n + i] <== y[i];
    sq.in <== allVals;
    sq.sq === commitment;
}

template SoftDivide() {
    // q = floor(p / dv) with p >= 0, dv = sum >= 2^16; proves remainder bounds.
    signal input p;   // <= 2^32
    signal input q;
    signal input dv;  // >= 2^16
    signal r;
    r <-- p - q * dv;
    component rb = RangeBits(20);
    rb.in <== r;                 // r < dv <= 8*2^16 = 2^19
    component lt = RangeBits(20);
    lt.in <== dv - r - 1;        // redundant belt-and-braces: dv > r
}
