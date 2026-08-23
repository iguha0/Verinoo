/**
 * Groth16 wrappers for op-level circuits (ReLU, argmax) in Q16.16 fixed-point.
 *
 * Circuits live in circuits/ops.circom; build artifacts under
 * circuits/build/{relu8,argmax8}/ (regenerate with scripts/build-ops-circuits.mjs).
 *
 * Semantics mirror src/zk/groth16.ts:
 *   - values are raw Q16.16 integers inside the circuit
 *   - public commitment is the sum-of-squares hash over the witness values
 *     in the BN254 scalar field
 */

import { readFileSync } from 'fs';
import { existsSync } from 'fs';
import { resolve } from 'path';

const FIXED_ONE = 65536;
const BN254_PRIME = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

const BUILD = resolve(__dirname, '../../circuits/build');

function f2i(v: number): number {
  return Math.round(v * FIXED_ONE);
}

export function i2f(i: number): number {
  return i / FIXED_ONE;
}

function sumSquares(vals: number[]): string {
  let sum = BigInt(0);
  for (const v of vals) sum = (sum + BigInt(v) * BigInt(v)) % BN254_PRIME;
  return sum.toString();
}

interface OpArtifacts {
  wasm: string;
  zkey: string;
  vkey: string;
}

function artifacts(name: 'relu8' | 'argmax8'): OpArtifacts {
  const dir = resolve(BUILD, name);
  const a: OpArtifacts = {
    wasm: resolve(dir, `${name}_js`, `${name}.wasm`),
    zkey: resolve(dir, `${name}.zkey`),
    vkey: resolve(dir, 'vkey.json'),
  };
  for (const p of Object.values(a)) {
    if (!existsSync(p)) {
      throw new Error(`op circuit artifacts missing (${name}). Build them: npm run build:ops`);
    }
  }
  return a;
}

// === ReLU ===

/** Deterministic honest ReLU on Q16.16 raw ints. */
export function honestRelu(xFixed: number[]): number[] {
  return xFixed.map(v => (v > 0 ? v : 0));
}

export interface OpProofOutput {
  proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol: string; curve: string };
  publicSignals: string[];
  /** Fixed-point output committed by this proof */
  outputFixed: number[];
}

export async function proveRelu(xFloats: number[]): Promise<OpProofOutput> {
  if (xFloats.length !== 8) throw new Error('relu8 circuit expects exactly 8 elements');
  const snarkjs = await import('snarkjs');
  const art = artifacts('relu8');

  const x = xFloats.map(f2i);
  const out = honestRelu(x);
  const commitment = sumSquares([...x, ...out]);

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    { commitment, x, out },
    art.wasm,
    art.zkey
  );
  return { proof, publicSignals, outputFixed: out };
}

export async function verifyRelu(proof: OpProofOutput['proof'], publicSignals: string[]): Promise<boolean> {
  const snarkjs = await import('snarkjs');
  const art = artifacts('relu8');
  const vkey = JSON.parse(readFileSync(art.vkey, 'utf-8'));
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

// === ArgMax ===

/** Canonical honest argmax: smallest index holding the maximum (raw ints). */
export function honestArgmax(xFixed: number[]): number {
  let best = 0;
  for (let i = 1; i < xFixed.length; i++) {
    if (xFixed[i] > xFixed[best]) best = i;
  }
  return best;
}

export async function proveArgmax(xFloats: number[]): Promise<OpProofOutput & { index: number }> {
  if (xFloats.length !== 8) throw new Error('argmax8 circuit expects exactly 8 elements');
  const snarkjs = await import('snarkjs');
  const art = artifacts('argmax8');

  const x = xFloats.map(f2i);
  const idx = honestArgmax(x);
  const maxVal = x[idx];
  const commitment = sumSquares(x);

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    { commitment, idx, maxVal, x },
    art.wasm,
    art.zkey
  );
  return { proof, publicSignals, outputFixed: [maxVal], index: idx };
}

export async function verifyArgmax(proof: OpProofOutput['proof'], publicSignals: string[]): Promise<boolean> {
  const snarkjs = await import('snarkjs');
  const art = artifacts('argmax8');
  const vkey = JSON.parse(readFileSync(art.vkey, 'utf-8'));
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}
