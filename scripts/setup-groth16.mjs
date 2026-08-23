#!/usr/bin/env node
// Groth16 trusted setup via snarkjs CLI (npx)
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const root = process.cwd();
const buildDir = resolve(root, 'circuits/build');

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: root });
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`exit ${code}: ${err}`));
      else resolve({ stdout: out, stderr: err });
    });
    child.on('error', err => reject(err));
  });
}

async function setup() {
  const r1cs = resolve(buildDir, 'zklayer.r1cs');
  const wasm = resolve(buildDir, 'zklayer_js/zklayer.wasm');
  const ptau = resolve(buildDir, 'pot12_final.ptau');
  const zkey = resolve(buildDir, 'zklayer.zkey');
  const vkey = resolve(buildDir, 'zklayer.vkey.json');

  if (!existsSync(r1cs) || !existsSync(wasm)) {
    console.error('[setup] Circuit files not found. Compile first:');
    console.error('  circom circuits/zklayer.circom --r1cs --wasm -o circuits/build');
    process.exit(1);
  }

  if (!existsSync(ptau)) {
    const t1 = resolve(buildDir, 'pot12_tmp1.ptau');
    const t2 = resolve(buildDir, 'pot12_tmp2.ptau');

    console.log('[setup] powers of tau new 12...');
    await run('npx', ['snarkjs', 'powersoftau', 'new', 'bn128', '12', t1]);

    console.log('[setup] powers of tau contribute (random)...');
    await run('npx', ['snarkjs', 'powersoftau', 'contribute', t1, t2, '--name="setup"', '-v'], {
      // snarkjs prompts for entropy; feed non-interactive fake
      CI: 'true',
    });

    console.log('[setup] powers of tau prepare phase2...');
    await run('npx', ['snarkjs', 'powersoftau', 'prepare', 'phase2', t2, ptau, '-v']);
  } else {
    console.log('[setup] reusing existing ptau');
  }

  console.log('[setup] groth16 setup (zkey new)...');
  await run('npx', ['snarkjs', 'groth16', 'setup', r1cs, ptau, zkey]);

  console.log('[setup] export verification key...');
  await run('npx', ['snarkjs', 'zkey', 'export', 'verificationkey', zkey, vkey]);

  console.log('[setup] DONE');
  console.log('  zkey:', zkey);
  console.log('  vkey:', vkey);
}

setup().catch(e => {
  console.error('[setup] FAILED:', e.message);
  process.exit(1);
});
