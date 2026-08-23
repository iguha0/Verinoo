#!/usr/bin/env node
/**
 * Prover backend comparison: snarkjs (JS) vs rapidsnark (native C++).
 *
 * rapidsnark is enabled only when AIN_RAPIDSNARK_BIN points at the built
 * `prover` binary (https://github.com/iden3/rapidsnark). Without it this
 * script reports snarkjs baselines and a skip note.
 *
 * Measures end-to-end prove time for the slim matmul circuit at N=32.
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { spawn } from 'child_process';

const root = resolve(dirname(import.meta.filename), '..');
const N = 32;
const RUNS = 5;

function run(cmd, args) {
  return new Promise((res, rej) => {
    let err = '';
    const c = spawn(cmd, args);
    c.stderr.on('data', d => (err += d));
    c.on('close', code => (code === 0 ? res() : rej(new Error(`exit ${code}: ${err.slice(-300)}`))));
    c.on('error', rej);
  });
}

async function benchSnarkjs(snarkjs, wasm, zkey, input) {
  const times = [];
  let last;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    last = await snarkjs.groth16.fullProve(input, wasm, zkey);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(RUNS / 2)], result: last };
}

async function benchRapidsnark(bin, snarkjs, wasm, zkey, input) {
  const dir = resolve(root, 'circuits', 'bench', 'prover_cmp');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const wtns = resolve(dir, 'w.wtns');
  await snarkjs.wtns.calculate(input, wasm, wtns);

  const times = [];
  let lastFiles;
  for (let i = 0; i < RUNS; i++) {
    const proofP = resolve(dir, 'proof.json');
    const pubP = resolve(dir, 'public.json');
    const t0 = performance.now();
    await run(bin, [zkey, wtns, proofP, pubP]);
    times.push(performance.now() - t0);
    lastFiles = { proofP, pubP };
  }
  times.sort((a, b) => a - b);
  const proof = JSON.parse(readFileSync(lastFiles.proofP, 'utf-8'));
  const publicSignals = JSON.parse(readFileSync(lastFiles.pubP, 'utf-8'));
  return { median: times[Math.floor(RUNS / 2)], result: { proof, publicSignals } };
}

async function main() {
  const benchN = resolve(root, 'circuits', 'bench', `N${N}`, 'out');
  if (!existsSync(resolve(benchN, 'zklayer.zkey'))) {
    console.error(`[provers] missing benchmark artifacts — run: CIRCOM_BIN=... npm run bench:zk`);
    process.exit(1);
  }
  const wasm = resolve(benchN, 'zklayer_js', 'zklayer.wasm');
  const zkey = resolve(benchN, 'zklayer.zkey');

  // honest input matching the slim circuit convention
  const F = 65536;
  const f2i = v => Math.round(v * F);
  const inp = Array.from({ length: N }, (_, i) => f2i(((i * 37) % 11) / 10 - 0.5));
  const w = Array.from({ length: N * N }, (_, i) => f2i((((i * 53) % 17) / 17) - 0.5));
  const bias = Array.from({ length: N }, (_, i) => f2i(((i * 7) % 5) / 50));
  const out = [];
  for (let i = 0; i < N; i++) {
    let acc = bias[i];
    for (let j = 0; j < N; j++) acc += inp[j] * w[i * N + j];
    out.push(acc);
  }
  const P = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
  let s = 0n;
  for (const v of out) s = (s + BigInt(v) * BigInt(v)) % P;
  const input = { publicCommitment: s.toString(), inp, w, out, bias };

  const snarkjs = await import('snarkjs');
  console.log(`\n=== Prover comparison — slim matmul ${N}x${N} (${RUNS} runs, median) ===`);
  const sj = await benchSnarkjs(snarkjs, wasm, zkey, input);
  console.log(`snarkjs   : ${sj.median.toFixed(1)} ms`);

  const bin = process.env.AIN_RAPIDSNARK_BIN;
  if (bin && existsSync(bin)) {
    const rs = await benchRapidsnark(bin, snarkjs, wasm, zkey, input);
    console.log(`rapidsnark: ${rs.median.toFixed(1)} ms   speedup ${(sj.median / rs.median).toFixed(1)}x`);
    // cross-verify: rapidsnark proof must verify under snarkjs
    const vk = JSON.parse(readFileSync(resolve(benchN, 'vkey.json'), 'utf-8'));
    const ok = await snarkjs.groth16.verify(vk, rs.result.publicSignals, rs.result.proof);
    console.log(`cross-verify rapidsnark proof via snarkjs: ${ok === true ? 'OK' : 'FAILED'}`);
  } else {
    console.log('rapidsnark: SKIPPED (set AIN_RAPIDSNARK_BIN to the prover binary)');
  }

  try { const g = globalThis.curve_bn128; if (g?.terminate) await g.terminate(); globalThis.curve_bn128 = null; } catch {}
}

main().catch(e => { console.error('[provers] FAILED:', e.message); process.exit(1); });
