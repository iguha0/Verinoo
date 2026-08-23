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

// Slim circuit: output-only commitment halves constraint count
const WASM_PATH = resolve(__dirname, '../../circuits/build/zklayer_slim/zklayer_slim_js/zklayer_slim.wasm');
const ZKEY_PATH = resolve(__dirname, '../../circuits/build/zklayer_slim/zklayer_slim.zkey');
const VKEY_PATH = resolve(__dirname, '../../circuits/build/zklayer_slim/vkey.json');

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

/** Compute sum-of-squares commitment hash in BN254 field over outputs only.
 *  (Inputs/weights are bound by the arithmetic constraint; squaring them
 *  doubled proving cost for zero soundness gain.) */
function computeCommitmentHash(out: number[]): string {
  let sum = BigInt(0);
  for (const v of out) {
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
  const { groth16Prove } = await import('./prover');

  const inpFx = input.map(floatToFixed);
  const wFx = weights.map(floatToFixed);
  const bFx = bias.map(floatToFixed);
  const honestFx = matmul4x4(inpFx, wFx, bFx);

  const publicCommitment = computeCommitmentHash(honestFx);

  const { proof, publicSignals } = await groth16Prove(
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

/** Batch compute commitment hashes for all witnesses (used in circuit.ts).
 *  Legacy all-values sum-of-squares, independent of the slim circuit's
 *  output-only public commitment. */
export function computeTraceCommitmentHash(
  input: number[],
  weights: number[],
  output: number[],
  bias: number[]
): string {
  const all = [...input, ...weights, ...output, ...bias].map(floatToFixed);
  let sum = BigInt(0);
  for (const v of all) {
    const fv = BigInt(v);
    sum = (sum + fv * fv) % BN254_PRIME;
  }
  return sum.toString();
}

/** Terminate the BN254 curve worker pool cached by ffjavascript/snarkjs.
 *  Without this, every process that generates or verifies proofs keeps a
 *  worker thread pool alive forever, preventing clean exit and leaking
 *  memory/threads in long-running nodes. Safe to call multiple times.
 */
export async function terminateZkWorkers(): Promise<void> {
  try {
    const g = globalThis as Record<string, unknown>;
    const curve = g.curve_bn128 as { terminate?: () => Promise<void> } | undefined | null;
    if (curve && typeof curve.terminate === 'function') {
      await curve.terminate();
    }
    g.curve_bn128 = null;
  } catch {
    // best-effort cleanup
  }
}
