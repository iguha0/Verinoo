/**
 * Pluggable Groth16 proving backend.
 *
 *  - 'snarkjs'    (default): pure JS, always available. Slow but portable.
 *  - 'rapidsnark': iden3's C++ prover (~50-100x faster). Enabled when the
 *                  binary path is provided via AIN_RAPIDSNARK_BIN; witness
 *                  generation still uses snarkjs, then the native binary
 *                  proves. Falls back to snarkjs on any failure.
 *
 * gnark (Go) is intentionally NOT integrated here: it uses its own circuit
 * API rather than circom artifacts, so it belongs in a separate proving
 * sidecar if ever needed.
 *
 * Select via env: AIN_PROVER=rapidsnark AIN_RAPIDSNARK_BIN=/path/to/prover
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { spawn } from 'child_process';
import { tmpdir } from 'os';

export type ProverBackend = 'snarkjs' | 'rapidsnark';

/** Discovery order: explicit env var -> vendored binary -> null. */
export function rapidsnarkBinary(): string | null {
  const p = process.env.AIN_RAPIDSNARK_BIN;
  if (p && existsSync(p)) return p;
  const vendored = resolve(__dirname, '../../vendor/rapidsnark/bin/prover');
  return existsSync(vendored) ? vendored : null;
}

/** Native backend is the DEFAULT whenever a binary is discoverable
 *  (vendored or via AIN_RAPIDSNARK_BIN); snarkjs is the fallback.
 *  Force JS explicitly with AIN_PROVER=snarkjs. */
export function activeBackend(): ProverBackend {
  if (process.env.AIN_PROVER === 'snarkjs') return 'snarkjs';
  return rapidsnarkBinary() ? 'rapidsnark' : 'snarkjs';
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    let err = '';
    const child = spawn(cmd, args);
    child.stderr.on('data', d => (err += d));
    child.on('close', code => (code === 0 ? res() : rej(new Error(`rapidsnark exit ${code}: ${err.slice(-400)}`))));
    child.on('error', rej);
  });
}

/**
 * Prove with the active backend. Semantics identical to
 * snarkjs.groth16.fullProve(input, wasmPath, zkeyPath).
 */
export async function groth16Prove(
  input: Record<string, unknown>,
  wasmPath: string,
  zkeyPath: string
): Promise<{ proof: any; publicSignals: string[] }> {
  const backend = activeBackend();

  if (backend === 'rapidsnark') {
    try {
      const snarkjs = await import('snarkjs');
      const wtnsPath = resolve(tmpdir(), `ain_wtns_${Date.now()}_${Math.random().toString(36).slice(2)}.wtns`);
      const proofPath = wtnsPath.replace(/\.wtns$/, '.json');
      const publicPath = wtnsPath.replace(/\.wtns$/, '_public.json');
      try {
        await snarkjs.wtns.calculate(input as any, wasmPath, wtnsPath);
        // release snarkjs helpers; only witness gen runs on JS here
        try {
          const g = (globalThis as Record<string, unknown>).curve_bn128 as { terminate?: () => Promise<void> } | undefined;
          if (g?.terminate) await g.terminate();
          (globalThis as Record<string, unknown>).curve_bn128 = null;
        } catch {}
        await run(rapidsnarkBinary()!, [zkeyPath, wtnsPath, proofPath, publicPath]);
        const proof = JSON.parse(readFileSync(proofPath, 'utf-8'));
        const publicSignals = JSON.parse(readFileSync(publicPath, 'utf-8'));
        return { proof, publicSignals };
      } finally {
        for (const f of [wtnsPath, proofPath, publicPath]) {
          try { unlinkSync(f); } catch {}
        }
      }
    } catch (e: any) {
      console.log(`[prover] rapidsnark failed (${e.message}) — falling back to snarkjs`);
    }
  }

  const snarkjs = await import('snarkjs');
  return snarkjs.groth16.fullProve(input as any, wasmPath, zkeyPath);
}
