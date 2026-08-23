pragma circom 2.0.0;

/**
 * Op-level Groth16 circuits (Q16.16 fixed-point values as raw integers).
 *
 * ReLUN proves out[i] = max(0, x[i]) without revealing x:
 *   - sign test via 32-bit decomposition of y = x + 2^31 (bit31 == sign)
 *   - out === (1 - signBit) * x
 *
 * ArgMaxN proves that (idx, maxVal) is a valid maximizer of x[]:
 *   - one-hot selection ties idx and maxVal to the array
 *   - non-negativity of maxVal - x[j] proven by 32-bit decomposition
 *   Note: ties are allowed; the verifier recomputes the canonical
 *   smallest-index argmax outside the circuit and compares.
 *
 * Public commitment is the project's standard sum-of-squares hash
 * (BN254 field) so all op circuits share one commitment convention.
 */

template BitSum32() {
    // Decomposes `in` into 32 bits and returns nothing directly;
    // caller constrains weighted sum. Enforces bit binaryness.
    signal input in;
    signal output bits[32];

    signal lin[33];
    lin[0] <== 0;
    for (var k = 0; k < 32; k++) {
        bits[k] <-- (in \ (2 ** k)) % 2;
        bits[k] * (bits[k] - 1) === 0;
        lin[k + 1] <== lin[k] + bits[k] * (2 ** k);
    }
    lin[32] === in;
}

template SumSquares(n) {
    signal input in[n];
    signal output sq;

    signal s[n + 1];
    s[0] <== 0;
    for (var i = 0; i < n; i++) {
        s[i + 1] <== s[i] + in[i] * in[i];
    }
    sq <== s[n];
}

template ReluN(n) {
    signal input commitment; // public
    signal input x[n];       // private (Q16.16 raw ints)
    signal input out[n];     // private

    component sq = SumSquares(2 * n);
    signal allVals[2 * n];
    for (var i = 0; i < n; i++) allVals[i] <== x[i];
    for (var i = 0; i < n; i++) allVals[n + i] <== out[i];

    component dec[n];
    for (var i = 0; i < n; i++) {
        dec[i] = BitSum32();
        dec[i].in <== x[i] + 2147483648; // 2^31 shift into unsigned range
        // After the shift, bit31 == 1 exactly when x[i] >= 0
        out[i] === dec[i].bits[31] * x[i];
    }

    sq.in <== allVals;
    sq.sq === commitment;
}

template ArgMaxN(n) {
    signal input commitment; // public
    signal input idx;        // public
    signal input maxVal;     // public (Q16.16 raw int)
    signal input x[n];       // private

    component sq = SumSquares(n);

    // One-hot selector over indices
    signal e[n];
    signal esum[n + 1];
    signal idot[n + 1];
    signal msel[n + 1];
    esum[0] <== 0;
    idot[0] <== 0;
    msel[0] <== 0;
    for (var j = 0; j < n; j++) {
        e[j] <-- (j == idx) ? 1 : 0;
        e[j] * (e[j] - 1) === 0;
        esum[j + 1] <== esum[j] + e[j];
        idot[j + 1] <== idot[j] + e[j] * j;
        msel[j + 1] <== msel[j] + e[j] * x[j];
    }
    esum[n] === 1;
    idx === idot[n];
    maxVal === msel[n];

    // maxVal dominates every element: d_j = maxVal - x[j] >= 0
    component dec[n];
    for (var j = 0; j < n; j++) {
        dec[j] = BitSum32();
        dec[j].in <== maxVal - x[j];
    }

    sq.in <== x;
    sq.sq === commitment;
}
