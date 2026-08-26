pragma circom 2.0.0;
include "./layernorm.circom";
component main { public [commitment] } = LayernormN(64);
