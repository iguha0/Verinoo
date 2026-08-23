/**
 * Groth16 wrapper for the softmax8 circuit (mirrors inference.wat $softmax).
 * Spec: src/zk/softmax.ts.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { honestSoftmaxRaw } from './softmax';
import { groth16Prove } from './prover';

const BN254_PRIME = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
const BUILD = resolve(__dirname, '../../circuits/build');

function sumSquares(vals: number[]): string {
  let sum = BigInt(0);
  for (const v of vals) sum = (sum + BigInt(v) * BigInt(v)) % BN254_PRIME;
  return sum.toString();
}

function artifacts() {
  const dir = resolve(BUILD, 'softmax8');
  const a = {
    wasm: resolve(dir, 'softmax8_js', 'softmax8.wasm'),
    zkey: resolve(dir, 'softmax8.zkey'),
    vkey: resolve(dir, 'vkey.json'),
  };
  for (const p of Object.values(a)) {
    if (!existsSync(p)) throw new Error('softmax8 artifacts missing. Build them: npm run build:ops');
  }
  return a;
}

export interface SoftmaxProofOutput {
  proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol: string; curve: string };
  publicSignals: string[];
  outputFixed: number[];
}

export async function proveSoftmax(xFloats: number[]): Promise<SoftmaxProofOutput> {
  if (xFloats.length !== 8) throw new Error('softmax8 circuit expects exactly 8 elements');
  const art = artifacts();

  const x = xFloats.map(v => Math.round(v * 65536));
  const trace = honestSoftmaxRaw(x);
  const y = trace.y;

  // Honest one-hot over the FIRST maximizer; ties with later indices are
  // equally valid but this is the canonical witness.
  const maxIdx = x.indexOf(trace.maxV);
  const sel = new Array(8).fill(0);
  sel[maxIdx] = 1;

  const commitment = sumSquares([...x, ...y]);
  const input = { commitment, x, y, sel, m: trace.maxV, denom: trace.sum };

  const { proof, publicSignals } = await groth16Prove(input, art.wasm, art.zkey);
  return { proof, publicSignals, outputFixed: y };
}

export async function verifySoftmax(
  proof: SoftmaxProofOutput['proof'],
  publicSignals: string[]
): Promise<boolean> {
  const snarkjs = await import('snarkjs');
  const art = artifacts();
  const vkey = JSON.parse(readFileSync(art.vkey, 'utf-8'));
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}
