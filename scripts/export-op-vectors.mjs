/**
 * Export op-level golden vectors for Rust conformance testing.
 * Outputs to /Users/indrajitguha/verinoo-node/crates/zk/tests/op_vectors.json
 */
import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import { WasmRuntime, loadWasmSync } from '../dist/wasm/runtime.js';
import { honestSoftmaxRaw } from '../dist/zk/softmax.js';
import { honestLayernormRaw } from '../dist/zk/layernorm.js';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const rt = new WasmRuntime(loadWasmSync());
const f2i = v => Math.round(v * 65536);
const F = BigInt(65536);

// ---- helpers for n=64 BigInt math (mirrors TS specs exactly) ----
function softmax64(xFixed) {
  const xi = xFixed.map(BigInt);
  const maxV = xi.reduce((a, b) => (b > a ? b : a), xi[0]);
  const e = xi.map(v => {
    const d = v - maxV;
    return d < 0n ? 0n : d + F;
  });
  const sum = e.reduce((a, b) => a + b, 0n);
  const denom = sum > 0n ? sum : 1n;
  return e.map(ei => Number((ei * F) / denom));
}

function layernorm64(xFixed) {
  const xb = xFixed.map(BigInt);
  const sum = xb.reduce((a, b) => a + b, 0n);
  const mean = sum >> 3n;
  const c = xb.map(v => v - mean);
  const varnum = c.reduce((a, v) => a + v * v, 0n);
  const varN = varnum >> 19n;
  const denom = varN > 1n ? varN : 1n;
  const A = denom << 16n;
  let t = BigInt(Math.floor(Math.sqrt(Number(A))));
  while (t * t > A) t--;
  while ((t + 1n) * (t + 1n) <= A) t++;
  const R = (1n << 32n) / (t > 0n ? t : 1n);
  return c.map(ci => Number((ci * R) >> 16n));
}

// ================= collect vectors =================
const cases = [];

// -- relu: WASM oracle --
{
  const inpF = [-0.5, 0.0, 0.00001, 1.0, -1.0, 2.0];
  const inp = inpF.map(f2i);
  const out = rt.executeLayer('relu', [], [...inpF]);
  cases.push({ op:'relu8', inputFixed:inp, weightsFixed:[], biasFixed:[],
    expectedFixed: out.map(v => Math.round(v * 65536)) });
}

// -- softmax n=8: TS spec --
for (const c of [
  [0.5,-0.25,1,-1.5,2,-0.75,0.125,-2],
  [3,3,3,3,3,3,3,3],
  [0,0,0,0,0,0,0,0],
]) {
  const xf = c.map(f2i);
  const spec = honestSoftmaxRaw(xf);
  cases.push({ op:'softmax8', inputFixed:xf, weightsFixed:[], biasFixed:[],
    expectedFixed:spec.y });
}

// -- layernorm n=8: TS spec --
for (const c of [
  [0.5,-0.25,1,-1.5,2,-0.75,0.125,-2],
  [3,3,3,3,3,3,3,3],
  [7.9,-7.9,8,-8,4,-4,2,-2],
]) {
  const xf = c.map(f2i);
  const spec = honestLayernormRaw(xf);
  cases.push({ op:'layernorm8', inputFixed:xf, weightsFixed:[], biasFixed:[],
    expectedFixed:spec.y });
}

// -- attention 4x4: WASM oracle (column-major Q16.16 matmul) --
{
  const inpF=[0.5,-0.25,1,2];
  const wF=[0.1,-0.2,0.3,0.4,-0.5,0.6,-0.7,0.8,0.9,1,-1.1,1.2,-1.3,1.4,-1.5,1.6];
  const bF=[0.01,-0.02,0.03,-0.04];
  const out=rt.executeLayer('attention',[...wF],[...inpF]).map(v=>Math.round(v*65536));
  cases.push({op:'attention',inputFixed:inpF.map(f2i),weightsFixed:wF.map(f2i),
    biasFixed:bF.map(f2i),expectedFixed:out});
}

// ================= n=64 scaling vectors =================

// relu64: deterministic inputs via sin
{
  const sinF = Array.from({length:64}, (_, i) => Math.sin(i*0.7)*4);
  const inp = sinF.map(f2i);
  const out = inp.map(v => Math.max(0, v));
  cases.push({ op:'relu64', inputFixed:inp, weightsFixed:[], biasFixed:[], expectedFixed:out });
}

// softmax64: hard-max-with-margin using BigInt
{
  const sinF = Array.from({length:64}, (_, i) => Math.cos(i*0.3)*3);
  const sin = sinF.map(f2i).map(BigInt);
  const maxV = sin.reduce((a,b)=>b>a?b:a);
  const FB = BigInt(65536);
  const e = sin.map(v => { const d=v-maxV; return d<0n?0n:d+FB; });
  const total = e.reduce((a,b)=>a+b, 0n);
  const denom = total > 0n ? total : 1n;
  const out = e.map(ei => Number((ei*FB)/denom));
  cases.push({ op:'softmax64', inputFixed:sin.map(Number), weightsFixed:[], biasFixed:[], expectedFixed:out });
}

// layernorm64: integer sqrt + reciprocal using BigInt
{
  const linF = Array.from({length:64}, (_, i) => Math.sin(i*1.1)*5);
  const lin = linF.map(f2i).map(BigInt);
  const sum = lin.reduce((a,b)=>a+b, 0n);
  const mean = sum >> 3n;
  const c = lin.map(v => v - mean);
  const varnum = c.reduce((a,v)=>a+v*v, 0n);
  const varN = varnum >> 19n;
  const denom = varN > 1n ? varN : 1n;
  const A = denom << 16n;
  let t = BigInt(Math.floor(Math.sqrt(Number(A))));
  while (t*t > A) t--;
  while ((t+1n)*(t+1n) <= A) t++;
  const R = (1n << 32n) / (t > 0n ? t : 1n);
  const out = c.map(ci => Number(shrFloor(ci*R, 16n)));
  cases.push({ op:'layernorm64', inputFixed:lin.map(Number), weightsFixed:[], biasFixed:[], expectedFixed:out });

  function shrFloor(a, k) { return a >> k; }
}

const outPath = '/Users/indrajitguha/verinoo-node/crates/zk/tests/op_vectors.json';
writeFileSync(outPath, JSON.stringify(cases, null, 2) + '\n');
console.log(`[export] ${cases.length} op vectors -> ${outPath}`);
