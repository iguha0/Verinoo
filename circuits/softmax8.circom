pragma circom 2.0.0;
include "./softmax.circom";

component main { public [commitment] } = SoftmaxN(8);
