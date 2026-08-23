pragma circom 2.0.0;

template ZKLayerVerify(nIn, nOut) {
    var nWeights = nIn * nOut;
    var totalLen = nIn + nWeights + nOut + nOut;

    // Public signals
    signal input publicCommitment;

    // Private signals (will be private by default since not declared public in main)
    signal input inp[nIn];
    signal input w[nWeights];
    signal input out[nOut];
    signal input bias[nOut];

    // 1. Linear layer constraints: out[i] = sum_j(inp[j] * w[i*nIn + j]) + bias[i]
    // Use intermediate signals for accumulation to stay within quadratic constraints.
    signal expectedOut[nOut];
    signal partial[nOut][nIn + 1];

    for (var i = 0; i < nOut; i++) {
        partial[i][0] <== bias[i];
        for (var j = 0; j < nIn; j++) {
            partial[i][j + 1] <== partial[i][j] + inp[j] * w[i*nIn + j];
        }
        expectedOut[i] <== partial[i][nIn];
        expectedOut[i] === out[i];
    }

    // 2. Quadratic commitment hash = sum(val_i^2) over all concatenated values
    signal allVals[totalLen];
    for (var i = 0; i < nIn; i++) allVals[i] <== inp[i];
    for (var i = 0; i < nWeights; i++) allVals[nIn + i] <== w[i];
    for (var i = 0; i < nOut; i++) allVals[nIn + nWeights + i] <== out[i];
    for (var i = 0; i < nOut; i++) allVals[nIn + nWeights + nOut + i] <== bias[i];

    // Sum-of-squares hash (quadratic — fully R1CS-compatible)
    signal squares[totalLen];
    for (var i = 0; i < totalLen; i++) {
        squares[i] <== allVals[i] * allVals[i];
    }

    signal hashAcc[totalLen + 1];
    hashAcc[0] <== 0;
    for (var i = 0; i < totalLen; i++) {
        hashAcc[i + 1] <== hashAcc[i] + squares[i];
    }

    hashAcc[totalLen] === publicCommitment;
}

// Public input: only publicCommitment
component main { public [publicCommitment] } = ZKLayerVerify(4, 4);
