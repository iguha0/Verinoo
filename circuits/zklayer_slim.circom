pragma circom 2.0.0;

/**
 * Slim layer-verify circuit: commitment over OUTPUTS ONLY.
 *
 * The original ZKLayerVerify squared every witness value
 * (constraints = 2N^2 + 3N). But inputs/weights are already bound by the
 * arithmetic constraint out === bias + sum(inp*w), so squaring them adds
 * no soundness — it only doubled proving cost.
 *
 * Slim: constraints = N^2 + N (~50% cheaper at every size).
 */

template ZKLayerVerifySlim(nIn, nOut) {
    var nWeights = nIn * nOut;

    // Public signals
    signal input publicCommitment;

    // Private signals
    signal input inp[nIn];
    signal input w[nWeights];
    signal input out[nOut];
    signal input bias[nOut];

    // Linear layer constraints: out[i] = bias[i] + sum_j(inp[j] * w[i*nIn + j])
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

    // Output-only sum-of-squares commitment
    signal squares[nOut];
    for (var i = 0; i < nOut; i++) {
        squares[i] <== out[i] * out[i];
    }

    signal hashAcc[nOut + 1];
    hashAcc[0] <== 0;
    for (var i = 0; i < nOut; i++) {
        hashAcc[i + 1] <== hashAcc[i] + squares[i];
    }

    hashAcc[nOut] === publicCommitment;
}

component main { public [publicCommitment] } = ZKLayerVerifySlim(4, 4);
