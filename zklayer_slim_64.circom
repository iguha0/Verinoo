pragma circom 2.0.0;

template ZKLayerVerifySlim(nIn, nOut) {
    var nWeights = nIn * nOut;
    signal input publicCommitment;
    signal input inp[nIn];
    signal input w[nWeights];
    signal input out[nOut];
    signal input bias[nOut];

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

component main { public [publicCommitment] } = ZKLayerVerifySlim(64, 64);
