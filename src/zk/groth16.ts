/**
 * Groth16 SNARK wrapper for ZK layer verification.
 *
 * Uses the Circom circuit (circuits/zklayer.circom) compiled via snarkjs.
 * The circuit proves:
 *   - Knowledge of private inputs (inp 4-vector, weights 16-vector, out 4-vector, bias 4-vector)
 *   - That output = matmul(input, weights) + bias (constrained inside the circuit)
 *   - That sum-of-squares of all values (in the BN254 finite field) equals the public commitment
 *
 * Files required:
 *   circuits/build/zklayer_js/zklayer.wasm
 *   circuits/build/zklayer.zkey
 *   circuits/build/zklayer.vkey.json
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const BN254_PRIME = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
const FIXED_ONE = 65536;

const WASM_PATH = resolve(__dirname, '../../circuits/build/zklayer_js/zklayer.wasm');
const ZKEY_PATH = resolve(__dirname, '../../circuits/build/zklayer.zkey');
const VKEY_PATH = resolve(__dirname, '../../circuits/build/zklayer.vkey.json');

function floatToFixed(v: number): number {
  return Math.round(v * FIXED_ONE);
}

/** Deterministic matmul matching the Circom circuit exactly.
 *  The circuit does raw integer multiplication (no Q16.16 rescaling).
 *  So out[i] = bias[i] + sum_j(inp[j] * w[i*4+j]) as raw integers.
 */
function matmul4x4(input: number[], weights: number[], bias: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    let acc = bias[i];
    for (let j = 0; j < 4; j++) {
      acc += input[j] * weights[i * 4 + j]; // raw integer × (same as circuit)
    }
    out.push(acc);
  }
  return out;
}

/** Compute sum-of-squares commitment hash in BN254 field. */
function computeCommitmentHash(
  inp: number[], w: number[], out: number[], bias: number[]
): string {
  let sum = BigInt(0);
  const all = [...inp, ...w, ...out, ...bias].map(floatToFixed);
  for (const v of all) {
    const fv = BigInt(v);
    sum = (sum + fv * fv) % BN254_PRIME;
  }
  return sum.toString();
}

export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

export interface ProofOutput {
  proof: Groth16Proof;
  publicSignals: string[];
}

/** Generate a Groth16 proof for a layer execution.
 *  Computes the honest output deterministically via fixed-point matmul4x4.
 */
export async function proveLayer(
  input: number[],
  weights: number[],
  _output: number[],
  bias: number[]
): Promise<ProofOutput> {
  const snarkjs = await import('snarkjs');

  const inpFx = input.map(floatToFixed);
  const wFx = weights.map(floatToFixed);
  const bFx = bias.map(floatToFixed);
  const honestFx = matmul4x4(inpFx, wFx, bFx);

  const publicCommitment = computeCommitmentHash(
    input, weights,
    honestFx.map((v: number) => parseFloat((v / FIXED_ONE).toFixed(6))),
    bias
  );

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      publicCommitment,
      inp: inpFx,
      w: wFx,
      out: honestFx,
      bias: bFx,
    },
    WASM_PATH,
    ZKEY_PATH
  );

  return { proof, publicSignals };
}

/** Verify a Groth16 proof against the exported verification key. */
export async function verifyLayer(
  proof: Groth16Proof,
  publicSignals: string[]
): Promise<boolean> {
  const snarkjs = await import('snarkjs');
  const vkey = JSON.parse(readFileSync(VKEY_PATH, 'utf-8'));
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

/** Batch compute commitment hashes for all witnesses (used in circuit.ts). */
export function computeTraceCommitmentHash(
  input: number[],
  weights: number[],
  output: number[],
  bias: number[]
): string {
  return computeCommitmentHash(input, weights, output, bias);
}
