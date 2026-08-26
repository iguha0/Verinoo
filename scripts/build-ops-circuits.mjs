#!/usr/bin/env node
/**
 * Build + Groth16 setup for the op-level circuits (relu8, argmax8).
 *
 * Requires:
 *  - circuits/build/pot12_final.ptau (node scripts/setup-groth16.mjs)
 *  - circom 2.x binary on PATH or via CIRCOM_BIN
 *
 * Outputs to circuits/build/<name>/ : .r1cs, zklayer-style wasm dir,
 * .zkey, vkey.json
 */

import { spawn } from 'child_process';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';

const root = resolve(dirname(import.meta.filename ?? import.meta.url.replace('file://', '')), '..');
const buildDir = resolve(root, 'circuits', 'build');
const ptau = resolve(buildDir, 'pot12_final.ptau');

const TARGETS = [
  { name: 'relu8', main: resolve(root, 'circuits', 'relu8.circom') },
  { name: 'argmax8', main: resolve(root, 'circuits', 'argmax8.circom') },
  { name: 'layernorm8', main: resolve(root, 'circuits', 'layernorm8.circom') },
  { name: 'zklayer_slim', main: resolve(root, 'circuits', 'zklayer_slim.circom') },
  { name: 'softmax8', main: resolve(root, 'circuits', 'softmax8.circom') },
  { name: 'relu32', main: resolve(root, 'circuits', 'relu32.circom') },
  { name: 'relu64', main: resolve(root, 'circuits', 'relu64.circom') },
  { name: 'argmax64', main: resolve(root, 'circuits', 'argmax64.circom') },
  { name: 'layernorm64', main: resolve(root, 'circuits', 'layernorm64.circom') },
  { name: 'softmax64', main: resolve(root, 'circuits', 'softmax64.circom') },
  { name: 'zklayer_slim_64', main: resolve(root, 'circuits', 'zklayer_slim_64.circom') },
];

function run(cmd, args) {
  return new Promise((res, rej) => {
    let out = '', err = '';
    const child = spawn(cmd, args, { cwd: root });
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('close', code => (code === 0 ? res({ out, err }) : rej(new Error(`exit ${code}: ${err.slice(-600)}`))));
    child.on('error', rej);
  });
}

async function findCircom() {
  if (process.env.CIRCOM_BIN && existsSync(process.env.CIRCOM_BIN)) return process.env.CIRCOM_BIN;
  try {
    const { out } = await run('which', ['circom']);
    const p = out.trim();
    if (p) {
      const v = await run(p, ['--version']);
      if (v.out.includes('compiler 2')) return p;
    }
  } catch {}
  return null;
}

async function main() {
  if (!existsSync(ptau)) {
    console.error('[ops] missing pot12_final.ptau — run node scripts/setup-groth16.mjs first');
    process.exit(1);
  }
  const circomBin = await findCircom();
  if (!circomBin) {
    console.error('[ops] circom 2.x not found. Install it or set CIRCOM_BIN.');
    console.error('      e.g. CIRCOM_BIN=/path/to/circom npm run build:ops');
    process.exit(1);
  }

  for (const t of TARGETS) {
    const outDir = resolve(buildDir, t.name);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    console.log(`[ops] compiling ${t.name}...`);
    await run(circomBin, [t.main, '--r1cs', '--wasm', '--O2', '-o', outDir]);

    const r1cs = resolve(outDir, `${t.name}.r1cs`);
    const info = await run('npx', ['snarkjs', 'r1cs', 'info', r1cs]);
    const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
    const constraints = (strip(info.out + info.err).match(/#\s*of Constraints:\s*(\d+)/) || [])[1];
    console.log(`[ops]   constraints: ${constraints}`);

    console.log(`[ops] groth16 setup ${t.name}...`);
    const zkey = resolve(outDir, `${t.name}.zkey`);
    await run('npx', ['snarkjs', 'groth16', 'setup', r1cs, ptau, zkey]);
    await run('npx', ['snarkjs', 'zkey', 'export', 'verificationkey', zkey, resolve(outDir, 'vkey.json')]);

    // Normalize wasm filename expectation used by the runtime wrapper
    const wasmSrc = resolve(outDir, `${t.name}_js`, `${t.name}.wasm`);
    if (!existsSync(wasmSrc)) throw new Error(`wasm missing for ${t.name}`);
    console.log(`[ops] ✓ ${t.name} (${constraints} constraints)`);
  }
  console.log('[ops] DONE');
}

main().catch(e => { console.error('[ops] FAILED:', e.message); process.exit(1); });
