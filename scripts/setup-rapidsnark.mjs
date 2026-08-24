#!/usr/bin/env node
/**
 * Download + vendor the rapidsnark native prover for this platform.
 * Idempotent: skips when vendor/rapidsnark/bin/prover already exists
 * (override with --force).
 *
 * After setup, proving automatically uses rapidsnark — no env vars needed:
 *   AIN_PROVER=snarkjs            forces the JS backend
 *   AIN_RAPIDSNARK_BIN=/path      overrides the vendored binary
 */

import { spawnSync } from 'child_process';
import { mkdirSync, existsSync, rmSync, renameSync, chmodSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { pipeline } from 'stream/promises';

const root = resolve(dirname(import.meta.filename), '..');
const vendorDir = resolve(root, 'vendor', 'rapidsnark');
const proverBin = resolve(vendorDir, 'bin', 'prover');

const PLATFORMS = {
  'darwin-arm64': 'rapidsnark-macOS-arm64',
  'darwin-x64': 'rapidsnark-macOS-x86_64',
  'linux-arm64': 'rapidsnark-linux-arm64',
  'linux-x64': 'rapidsnark-linux-x86_64',
};

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

function unzip(zipPath, destDir) {
  // use system unzip (macOS/linux); fall back to python zipfile
  const r = spawnSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { stdio: 'inherit' });
  if (r.status !== 0) {
    const p = spawnSync('python3', ['-c', `import zipfile,sys; zipfile.ZipFile(${JSON.stringify(zipPath)}).extractall(${JSON.stringify(destDir)})`], { stdio: 'inherit' });
    if (p.status !== 0) throw new Error('unzip failed');
  }
}

async function main() {
  const force = process.argv.includes('--force');
  if (existsSync(proverBin) && !force) {
    console.log('[rapidsnark] already vendored:', proverBin);
    return;
  }

  const key = `${process.platform}-${process.arch}`;
  const asset = PLATFORMS[key];
  if (!asset) {
    console.error(`[rapidsnark] no prebuilt binary for ${key}. Build from source: https://github.com/iden3/rapidsnark`);
    process.exit(1);
  }

  const url = `https://github.com/iden3/rapidsnark/releases/download/v0.0.8/${asset}-v0.0.8.zip`;
  console.log(`[rapidsnark] downloading ${asset}...`);
  const tmp = resolve(root, 'vendor');
  mkdirSync(tmp, { recursive: true });
  const zipPath = resolve(tmp, 'rs.zip');
  await download(url, zipPath);

  const extractDir = resolve(tmp, 'rs_extract');
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  unzip(zipPath, extractDir);
  rmSync(zipPath);

  rmSync(vendorDir, { recursive: true, force: true });
  const inner = resolve(extractDir, asset + '-v0.0.8');
  renameSync(inner, vendorDir);
  rmSync(extractDir, { recursive: true, force: true });

  chmodSync(proverBin, 0o755);
  console.log('[rapidsnark] vendored at', proverBin);
  console.log('[rapidsnark] proving will now use the native backend automatically.');
}

main().catch(e => { console.error('[rapidsnark] FAILED:', e.message); process.exit(1); });
