pragma circom 2.0.0;
include "./ops.circom";

/**
 * LayernormN(n) — bit-exact Q16.16 layernorm, spec in src/zk/layernorm.ts.
 *
 * Proves y = layernorm(x) with floor-semantics integer arithmetic:
 *   mean   = sum >> 3            (offset trick keeps remainders unsigned)
 *   var_n  = sum(c_i^2) >> 3
 *   denom  = max(var_n, 1)
 *   t      = floor_sqrt(denom << 16)          via bounds t^2 <= A < (t+1)^2
 *   R      = floor(2^24 / max(t,1))           via two-sided product bounds
 *   y_i    = floor(c_i * R / 2^16)            via remainder range checks
 *
 * Public input: commitment = sum of squares of [x, y] mod BN254.
 */

template RangeBits(w) {
    // Proves 0 <= in < 2^w
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

// Split a non-negative value v into q = v >> s, remainder < 2^s.
// Constrains q to equal floor(v / 2^s).
template ShiftSplit(s) {
    signal input v;    // must be >= 0 (caller guarantees via offset)
    signal input q;    // witnessed quotient
    signal r;
    r <-- v - q * (2 ** s);
    component rb = RangeBits(s);
    rb.in <== r;
}

template LayernormN(n) {
    signal input commitment; // public
    signal input x[n];       // private, raw Q16.16
    signal input y[n];       // private, claimed output
    signal input denom;      // private, claimed max(var_n, 1)
    signal input t;          // private, claimed floor_sqrt(denom << 16)
    signal input R;          // private, claimed floor(2^24 / t)

    // ---- mean = sum >> 3 ----
    // Domain: |x_i| <= 8.0 float => raw <= 2^19 => |sum| <= 2^22
    var OFF_M = 33554432;                         // 2^25, multiple of 8, > 2^22
    signal sumAcc[n + 1];
    sumAcc[0] <== 0;
    for (var i = 0; i < n; i++) sumAcc[i + 1] <== sumAcc[i] + x[i];

    signal meanOff;
    meanOff <-- (sumAcc[n] + OFF_M) \ 8;
    component meanSplit = ShiftSplit(3);
    meanSplit.v <== sumAcc[n] + OFF_M;
    meanSplit.q <== meanOff;
    signal mean;
    mean <== meanOff - 4194304;                   // OFF_M / 8 = 2^22

    // ---- centered c_i (linear) ----
    signal c[n];
    for (var i = 0; i < n; i++) c[i] <== x[i] - mean;

    // ---- var_n = sum(c_i^2) >> 19 ----
    // c_i^2 is Q32.32: >>19 divides by n=8 AND rescales 2^16 -> Q16.16
    // |c_i| <= 2^22 => varnum <= 2^47
    signal varAcc[n + 1];
    varAcc[0] <== 0;
    for (var i = 0; i < n; i++) varAcc[i + 1] <== varAcc[i] + c[i] * c[i];

    var OFF_V = 1125899906842624;                 // 2^50, multiple of 2^19, > 2^47
    signal varOff;
    varOff <-- (varAcc[n] + OFF_V) \ 2 ** 19;
    component varSplit = ShiftSplit(19);
    varSplit.v <== varAcc[n] + OFF_V;
    varSplit.q <== varOff;
    signal var_n;
    var_n <== varOff - 2147483648;                // OFF_V / 2^19 = 2^31

    // ---- denom = max(var_n, 1): constrain the claimed input ----
    (denom - var_n) * (denom - 1) === 0;
    component dpos = RangeBits(30);
    dpos.in <== denom - 1;                        // proves denom >= 1

    // ---- t = floor_sqrt(denom << 16): constrain the claimed input ----
    // A <= 2^44 => t <= 2^22; denom >= 1 => A >= 2^16 => t >= 256
    signal A;
    A <== denom * 65536;
    signal tlo;                                   // A - t^2 >= 0
    signal thi;                                   // (t+1)^2 - 1 - A >= 0
    tlo <== A - t * t;
    thi <== (t + 1) * (t + 1) - 1 - A;
    component tloR = RangeBits(46);
    component thiR = RangeBits(46);
    tloR.in <== tlo;
    thiR.in <== thi;

    // ---- R = floor(2^32 / t): constrain the claimed input ----
    // t >= 256 so no max(t,1) needed; R <= 2^32/256 = 2^24
    signal p1;                                    // t * R        <= 2^32
    signal p2;                                    // t * (R + 1)  >= 2^32 + 1, <= ~2^32 + 2^30
    p1 <== t * R;
    p2 <== t * (R + 1);
    component loR = RangeBits(33);
    component hiR = RangeBits(34);
    loR.in <== 4294967296 - p1;                   // 2^32 - t*R >= 0
    hiR.in <== p2 - 4294967297;                   // t*(R+1) >= 2^32 + 1
                                                  // => 2^32 in [t*R, t*(R+1))

    // ---- y_i = floor(c_i * R / 2^16) ----
    // |c_i * R| <= 2^22 * 2^24 = 2^46 < OFF_Y
    var OFF_Y = 281474976710656;                  // 2^48, multiple of 2^16
    component scale[n];
    for (var i = 0; i < n; i++) {
        scale[i] = ShiftSplit(16);
        scale[i].v <== c[i] * R + OFF_Y;
        scale[i].q <== y[i] + 4294967296;         // OFF_Y / 2^16 = 2^32
    }

    // ---- commitment ----
    component sq = SumSquares(2 * n);
    signal allVals[2 * n];
    for (var i = 0; i < n; i++) allVals[i] <== x[i];
    for (var i = 0; i < n; i++) allVals[n + i] <== y[i];
    sq.in <== allVals;
    sq.sq === commitment;
}
