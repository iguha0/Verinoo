// Build script: compiles inference.wat to inference.wasm using the wabt npm package (ESM)
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function build() {
  const wabt = await import('wabt');
  const api = await wabt.default();

  const watPath = resolve(__dirname, '../src/wasm/inference.wat');
  const wasmPath = resolve(__dirname, '../src/wasm/inference.wasm');

  console.log('[build] reading', watPath);
  const watSource = readFileSync(watPath, 'utf-8');

  const result = api.parseWat('inference.wat', watSource);
  result.resolveNames();
  result.validate({});
  const binary = result.toBinary({});

  writeFileSync(wasmPath, Buffer.from(binary.buffer));
  console.log('[build] compiled', wasmPath, '-', binary.buffer.byteLength, 'bytes');
}

build().catch(err => {
  console.error('[build] FAILED:', err);
  process.exit(1);
});
