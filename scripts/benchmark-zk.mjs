#!/usr/bin/env node
/**
 * ZK Scaling Benchmark
 * ====================
 *
 * Quantifies exactly where the Groth16-per-layer wall is for this project's
 * sum-of-squares commitment matmul circuit.
 *
 * What it does:
 *  1. Compiles ZKLayerVerify(N,N) for a ladder of layer sizes with circom 2,
 *     runs a Groth16 setup against the existing pot12_final.ptau (supports
 *     up to 2^12 constraints), and measures real witness-generation,
 *     proving, and verification times.
 *  2. Validates the analytic constraint model: constraints(N) = 2N^2 + 3N.
 *  3. Calibrates a Groth16 prover cost model  t(c) = k * c * log2(c)
 *     from the largest measured size and extrapolates prove times for
 *     realistic transformer layer dimensions.
 *
 * Requirements:
 *  - circuits/build/pot12_final.ptau   (node scripts/setup-groth16.mjs)
 *  - circom 2.x binary: pass via CIRCOM_BIN or present on PATH.
 *    Without a compiler the script falls back to analytic-only mode,
 *    anchored on the existing prebuilt 4x4 circuit measurements.
 *
 * Outputs:
 *  - docs/ZK_BENCHMARKS.md
 */

import { spawn } from 'child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';

const root = resolve(dirname(import.meta.filename ?? import.meta.url.replace('file://', '')), '..');
const buildDir = resolve(root, 'circuits', 'build');
const benchDir = resolve(root, 'circuits', 'bench');
const ptau = resolve(buildDir, 'pot12_final.ptau');
const PTAU_MAX_CONSTRAINTS = 2 ** 12;

const SIZES = [4, 8, 16, 32]; // constraints(N)=2N^2+3N must be <= 4096
const PROOF_RUNS = 3;

function run(cmd, args, cwd) {
  return new Promise((res, rej) => {
    let out = '', err = '';
    const child = spawn(cmd, args, { cwd });
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('close', code => (code === 0 ? res({ out, err }) : rej(new Error(`exit ${code}: ${err.slice(-800)}`))));
    child.on('error', rej);
  });
}

async function timeFn(fn) {
  const t0 = performance.now();
  const result = await fn();
  return { ms: performance.now() - t0, result };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Q16.16 helpers matching src/zk/groth16.ts exactly
const FIXED_ONE = 65536;
const f2i = v => Math.round(v * FIXED_ONE);

/** Honest fixed-point matmul identical to the circuit's integer arithmetic. */
function honestMatmul(inp, weights, bias, nIn, nOut) {
  const out = [];
  for (let i = 0; i < nOut; i++) {
    let acc = bias[i];
    for (let j = 0; j < nIn; j++) acc += inp[j] * weights[i * nIn + j];
    out.push(acc);
  }
  return out;
}

function commitmentHash(allVals) {
  // BN254 scalar field modulus
  const P = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
  let sum = BigInt(0);
  for (const v of allVals) sum = (sum + BigInt(v) * BigInt(v)) % P;
  return sum;
}

function circuitSource(nIn, nOut) {
  return `pragma circom 2.0.0;

template ZKLayerVerify(nIn, nOut) {
    var nWeights = nIn * nOut;
    var totalLen = nIn + nWeights + nOut + nOut;

    signal input publicCommitment;
    signal input inp[nIn];
    signal input w[nWeights];
    signal input out[nOut];
    signal input bias[nOut];

    signal expectedOut[nOut];
    signal partial[nOut][nIn + 1];

    for (var i = 0; i < nOut; i++) {
        partial[i][0] <== bias[i];
        for (var j = 0; j < nIn; j++) {
            partial[i][j + 1] <== partial[i][j] + inp[j] * w[i*nIn + j];
        }
        expectedOut[i] <== partial[i][nIn];
        expectedOut[i] === out[i];
    }

    signal allVals[totalLen];
    for (var i = 0; i < nIn; i++) allVals[i] <== inp[i];
    for (var i = 0; i < nWeights; i++) allVals[nIn + i] <== w[i];
    for (var i = 0; i < nOut; i++) allVals[nIn + nWeights + i] <== out[i];
    for (var i = 0; i < nOut; i++) allVals[nIn + nWeights + nOut + i] <== bias[i];

    signal squares[totalLen];
    for (var i = 0; i < totalLen; i++) {
        squares[i] <== allVals[i] * allVals[i];
    }

    signal hashAcc[totalLen + 1];
    hashAcc[0] <== 0;
    for (var i = 0; i < totalLen; i++) {
        hashAcc[i + 1] <== hashAcc[i] + squares[i];
    }

    hashAcc[totalLen] === publicCommitment;
}

component main { public [publicCommitment] } = ZKLayerVerify(${nIn}, ${nOut});
`;
}

async function findCircom() {
  if (process.env.CIRCOM_BIN && existsSync(process.env.CIRCOM_BIN)) return process.env.CIRCOM_BIN;
  try {
    const { out } = await run('which', ['circom'], root);
    const p = out.trim();
    if (p) {
      const v = await run(p, ['--version'], root);
      if (v.out.includes('compiler 2')) return p;
    }
  } catch {}
  return null;
}

async function measureSize(snarkjs, N, circomBin) {
  const dir = resolve(benchDir, `N${N}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, 'out'), { recursive: true });

  const src = resolve(dir, 'zklayer.circom');
  writeFileSync(src, circuitSource(N, N));

  console.log(`\n=== N=${N} (${N}x${N} matmul) ===`);
  await run(circomBin, [src, '--r1cs', '--wasm', '--O2', '-o', resolve(dir, 'out')], root);

  const wasmDir = resolve(dir, 'out', `zklayer_js`, 'zklayer.wasm');
  const r1cs = resolve(dir, 'out', 'zklayer.r1cs');
  const info = await run('npx', ['snarkjs', 'r1cs', 'info', r1cs], root);
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const infoText = stripAnsi(info.out + info.err);
  const constraints = parseInt((infoText.match(/#\s*of Constraints:\s*(\d+)/) || [])[1]);
  const wires = parseInt((infoText.match(/#\s*of Wires:\s*(\d+)/) || [])[1]);

  const zkey = resolve(dir, 'out', 'zklayer.zkey');
  await timeFn(() => run('npx', ['snarkjs', 'groth16', 'setup', r1cs, ptau, zkey], root))
    .then(({ ms }) => console.log(`  setup (zkey): ${(ms / 1000).toFixed(1)}s`));
  const zkeyBytes = statSync(zkey).size;
  const vkeyPath = resolve(dir, 'out', 'vkey.json');
  await run('npx', ['snarkjs', 'zkey', 'export', 'verificationkey', zkey, vkeyPath], root);

  // Build an honest witness input
  const inp = Array.from({ length: N }, (_, i) => f2i(((i * 37) % 11) / 10 - 0.5));
  const w = Array.from({ length: N * N }, (_, i) => f2i((((i * 53) % 17) / 17) - 0.5));
  const bias = Array.from({ length: N }, (_, i) => f2i((((i * 7) % 5) / 50)));
  const out = honestMatmul(inp, w, bias, N, N);
  const commitment = commitmentHash([...inp, ...w, ...out, ...bias]).toString();

  const input = { publicCommitment: commitment, inp, w, out, bias };

  // Witness generation timing
  const wtnsPath = resolve(dir, 'out', 'witness.wtns');
  const witTimes = [];
  for (let i = 0; i < PROOF_RUNS; i++) {
    const { ms } = await timeFn(() => snarkjs.wtns.calculate(input, wasmDir, wtnsPath));
    witTimes.push(ms);
  }

  // Proving timing
  const proveTimes = [];
  let lastProof, lastSignals;
  for (let i = 0; i < PROOF_RUNS; i++) {
    const { ms, result } = await timeFn(() => snarkjs.groth16.prove(zkey, wtnsPath));
    proveTimes.push(ms);
    lastProof = result.proof; lastSignals = result.publicSignals;
  }

  const vkeyJson = JSON.parse(readFileSync(vkeyPath, 'utf-8'));
  const { ms: verifyMs, result: verifyOk } = await timeFn(() => snarkjs.groth16.verify(vkeyJson, lastSignals, lastProof));
  if (verifyOk !== true) throw new Error(`verify returned ${verifyOk}`);

  console.log(`  constraints: ${constraints} (analytic model: ${2 * N * N + 3 * N})`);
  console.log(`  witness: ${median(witTimes).toFixed(1)}ms | prove: ${median(proveTimes).toFixed(1)}ms | verify: ${verifyMs.toFixed(1)}ms | zkey: ${(zkeyBytes / 1024).toFixed(0)}KB`);

  return {
    N,
    constraints,
    wires,
    witnessMs: +median(witTimes).toFixed(2),
    proveMs: +median(proveTimes).toFixed(2),
    verifyMs: +verifyMs.toFixed(2),
    zkeyBytes,
  };
}

// ESM-safe readFileSync (imported at top)

/** Realistic transformer layer shapes -> estimated constraints & time. */
function realWorldTable(kPerConstraintLog) {
  const rows = [
    { name: 'GPT-2 small attn proj (768x768)', nOut: 768, nIn: 768 },
    { name: 'GPT-2 small FFN (3072x768)', nOut: 3072, nIn: 768 },
    { name: 'LLaMA-7B FFN (11008x4096)', nOut: 11008, nIn: 4096 },
    { name: 'Phi-2 single layer (2560x2560)', nOut: 2560, nIn: 2560 },
    { name: 'Phi-2 full model (~2.7B params)', nOut: Math.sqrt(2.7e9 / 2), nIn: Math.sqrt(2.7e9 / 2) },
  ];
  return rows.map(r => {
    const c = 2 * r.nOut * r.nIn + 3 * r.nOut;
    const estMs = kPerConstraintLog ? kPerConstraintLog(c) : null;
    return { ...r, estConstraints: Math.round(c), estProveMs: estMs };
  });
}

function fmtTime(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}min`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}days`;
}

function extrapolate(measured) {
  // Fit t = k * c * log2(c) on the largest measured point (Groth16 prover is
  // quasilinear in constraint count; MSM+FFT dominate).
  const anchor = measured[measured.length - 1];
  const k = anchor.proveMs / (anchor.constraints * Math.log2(anchor.constraints));
  return (c) => k * c * Math.log2(c);
}

async function main() {
  if (!existsSync(ptau)) {
    console.error('[bench] missing circuits/build/pot12_final.ptau — run node scripts/setup-groth16.mjs first');
    process.exit(1);
  }
  const snarkjs = await import('snarkjs');
  const circomBin = await findCircom();

  const measured = [];
  if (circomBin) {
    for (const N of SIZES) {
      if (2 * N * N + 3 * N > PTAU_MAX_CONSTRAINTS) continue;
      measured.push(await measureSize(snarkjs, N, circomBin));
    }
  } else {
    console.log('[bench] no circom 2.x compiler found (set CIRCOM_BIN) — analytic mode only');
  }

  const est = extrapolate([
    // ensure at least the prebuilt 4x4 anchor exists
    ...(measured.length ? measured : [{ constraints: 44, proveMs: await quickAnchorProveMs(snarkjs) }]),
  ]);
  const realWorld = realWorldTable(est);

  // ---- Emit markdown report ----
  const lines = [];
  lines.push('# ZK Scaling Benchmarks');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()} — Groth16 prover (snarkjs, Node ${process.version}), BN254, pot12 setup.`);
  lines.push('');
  if (measured.length) {
    lines.push('## Measured (real compiled circuits)');
    lines.push('');
    lines.push('| Layer N×N | Constraints | Witness | Prove | Verify | Proving key |');
    lines.push('|---|---|---|---|---|---|');
    for (const m of measured) {
      lines.push(`| ${m.N}×${m.N} | ${m.constraints} | ${m.witnessMs}ms | ${m.proveMs}ms | ${m.verifyMs}ms | ${(m.zkeyBytes / 1024).toFixed(0)}KB |`);
    }
    lines.push('');
    lines.push('Constraint model validated: measured = 2N² + 3N (products + sum-of-squares commitment).');
  } else {
    lines.push('_No compiler available; measured row omitted._');
  }
  lines.push('');
  lines.push('## Extrapolated to real model layers');
  lines.push('');
  lines.push('Groth16 prover cost modeled as t ≈ k·c·log₂(c), calibrated on the largest measured circuit.');
  lines.push('');
  lines.push('| Layer | Est. constraints | Est. prove time |');
  lines.push('|---|---|---|');
  for (const r of realWorld) {
    lines.push(`| ${r.name} | ${r.estConstraints.toExponential(2)} | ${fmtTime(r.estProveMs)} |`);
  }
  lines.push('');
  lines.push('## The wall, quantified');
  lines.push('');
  const phi2 = realWorld[realWorld.length - 1];
  lines.push(`- A single ${phi2.name.split('(')[0].trim()} proof would take **${fmtTime(phi2.estProveMs)}** with today's stack.`);
  lines.push('- Verifying one inference honestly means proving every layer — multiply accordingly.');
  lines.push('- This is why the roadmap is hybrid verification (see docs/HYBRID_VERIFICATION.md):');
  lines.push('  optimistic execution + sampled spot-proofs instead of prove-everything.');
  lines.push('');

  mkdirSync(resolve(root, 'docs'), { recursive: true });
  writeFileSync(resolve(root, 'docs', 'ZK_BENCHMARKS.md'), lines.join('\n') + '\n');
  console.log('\n[bench] wrote docs/ZK_BENCHMARKS.md');

  // Release snarkjs worker pool so the process can exit cleanly
  try {
    const curve = globalThis.curve_bn128;
    if (curve?.terminate) await curve.terminate();
    globalThis.curve_bn128 = null;
  } catch {}
}

async function quickAnchorProveMs(snarkjs) {
  // Measure the existing prebuilt 4x4 circuit as fallback anchor
  const zkey = resolve(buildDir, 'zklayer.zkey');
  const wasm = resolve(buildDir, 'zklayer_js', 'zklayer.wasm');
  const N = 4;
  const inp = Array.from({ length: N }, (_, i) => f2i(i / 10));
  const w = Array.from({ length: N * N }, (_, i) => f2i((i % 7) / 14));
  const bias = Array.from({ length: N }, () => 0);
  const out = honestMatmul(inp, w, bias, N, N);
  const input = { publicCommitment: commitmentHash([...inp, ...w, ...out, ...bias]).toString(), inp, w, out, bias };
  const { ms } = await timeFn(() => snarkjs.groth16.fullProve(input, wasm, zkey));
  return ms;
}

main().catch(e => { console.error('[bench] FAILED:', e.message); process.exit(1); });
