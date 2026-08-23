/**
 * Groth16 wrapper for the layernorm8 circuit.
 *
 * Spec lives in src/zk/layernorm.ts (single source of truth); the circuit
 * constrains the claimed auxiliaries (denom, t, R) to their defining
 * relations, so an honestly generated witness is forced to the unique
 * correct output.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { honestLayernormRaw, f2i } from './layernorm';

const BN254_PRIME = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
const BUILD = resolve(__dirname, '../../circuits/build');

function sumSquares(vals: number[]): string {
  let sum = BigInt(0);
  for (const v of vals) sum = (sum + BigInt(v) * BigInt(v)) % BN254_PRIME;
  return sum.toString();
}

function artifacts() {
  const dir = resolve(BUILD, 'layernorm8');
  const a = {
    wasm: resolve(dir, 'layernorm8_js', 'layernorm8.wasm'),
    zkey: resolve(dir, 'layernorm8.zkey'),
    vkey: resolve(dir, 'vkey.json'),
  };
  for (const p of Object.values(a)) {
    if (!existsSync(p)) throw new Error('layernorm8 artifacts missing. Build them: npm run build:ops');
  }
  return a;
}

export interface LayernormProofOutput {
  proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol: string; curve: string };
  publicSignals: string[];
  outputFixed: number[];
}

export async function proveLayernorm(xFloats: number[]): Promise<LayernormProofOutput> {
  if (xFloats.length !== 8) throw new Error('layernorm8 circuit expects exactly 8 elements');
  const snarkjs = await import('snarkjs');
  const art = artifacts();

  const x = xFloats.map(f2i);
  const trace = honestLayernormRaw(x);
  const y = trace.y;
  const commitment = sumSquares([...x, ...y]);

  const input = { commitment, x, y, denom: trace.denom, t: trace.t, R: trace.R };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, art.wasm, art.zkey);
  return { proof, publicSignals, outputFixed: y };
}

export async function verifyLayernorm(
  proof: LayernormProofOutput['proof'],
  publicSignals: string[]
): Promise<boolean> {
  const snarkjs = await import('snarkjs');
  const art = artifacts();
  const vkey = JSON.parse(readFileSync(art.vkey, 'utf-8'));
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}
