/**
 * Dispute SNARK fast path.
 *
 * When a defender answers a proveStep with a genuine Groth16 proof whose
 * public commitment binds the CLAIMED output (and input, for op circuits),
 * the engine can resolve the dispute without a full WASM recompute —
 * the circuit semantics guarantee the relation.
 *
 * Trust note: this inherits exactly the same trust model as the WASM path —
 * layerInput/layerWeights are supplied by the defender and were already
 * accepted by the existing proveStep logic. What the SNARK adds is a proof
 * that out = f(in) holds for the committed values per the circuit spec.
 */

import { verifyRelu } from './groth16ops';
import { verifyLayernorm } from './groth16layernorm';
import { verifySoftmax } from './groth16softmax';
import { verifyLayer } from './groth16';

const BN254_PRIME = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

function sumSquares(vals: number[]): string {
  let sum = BigInt(0);
  for (const v of vals) sum = (sum + BigInt(v) * BigInt(v)) % BN254_PRIME;
  return sum.toString();
}

export type DisputeProofType = 'relu8' | 'layernorm8' | 'softmax8' | 'matmul4x4';

export interface DisputeSnark {
  proofType: DisputeProofType;
  proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol: string; curve: string };
  publicSignals: string[];
}

export async function verifyDisputeSnark(
  sn: DisputeSnark,
  claimedOutputFixed: number[],
  inputFixed?: number[]
): Promise<boolean> {
  try {
    switch (sn.proofType) {
      case 'relu8': {
        if (!inputFixed || inputFixed.length !== 8) return false;
        const expected = sumSquares([...inputFixed, ...claimedOutputFixed]);
        if (sn.publicSignals[0] !== expected) return false;
        return await verifyRelu(sn.proof, sn.publicSignals);
      }
      case 'layernorm8': {
        if (!inputFixed || inputFixed.length !== 8) return false;
        const expected = sumSquares([...inputFixed, ...claimedOutputFixed]);
        if (sn.publicSignals[0] !== expected) return false;
        return await verifyLayernorm(sn.proof, sn.publicSignals);
      }
      case 'softmax8': {
        if (!inputFixed || inputFixed.length !== 8) return false;
        const expected = sumSquares([...inputFixed, ...claimedOutputFixed]);
        if (sn.publicSignals[0] !== expected) return false;
        return await verifySoftmax(sn.proof, sn.publicSignals);
      }
      case 'matmul4x4': {
        // slim matmul circuit commits outputs only
        const expected = sumSquares(claimedOutputFixed);
        if (sn.publicSignals[0] !== expected) return false;
        return await verifyLayer(sn.proof, sn.publicSignals);
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}
