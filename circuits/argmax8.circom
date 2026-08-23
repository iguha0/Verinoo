pragma circom 2.0.0;
include "./ops.circom";

component main { public [commitment, idx, maxVal] } = ArgMaxN(8);
