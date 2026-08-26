/**
 * Export op-level golden vectors from TS spec functions (source of truth).
 * Output: /Users/indrajitguha/verinoo-node/crates/zk/tests/op_vectors.json
 */
import { WasmRuntime, loadWasmSync } from '../dist/wasm/runtime.js';
import { honestSoftmaxRaw } from '../dist/zk/softmax.js';
import { honestLayernormRaw } from '../dist/zk/layernorm.js';
import { writeFileSync } from 'fs';

const rt = new WasmRuntime(loadWasmSync());
function f2i(v) { return Math.round(v * 65536); }

const cases = [];

// -- relu: from WASM (correct) --
{
  const inpF = [-0.5, 0.0, 0.00001, 1.0, -1.0, 2.0];
  const out = rt.executeLayer('relu', [], [...inpF]);
  cases.push({ op:'relu', inputFixed: inpF.map(f2i), weightsFixed:[], biasFixed:[],
               expectedFixed: out.map(v=>Math.round(v*65536)) });
}

// -- softmax: from TS SPEC (matches fixed WASM) --
for (const c of [
  [0.5,-0.25,1,-1.5,2,-0.75,0.125,-2],
  [3,3,3,3,3,3,3,3],
  [0,0,0,0,0,0,0,0],
]) {
  const xf = c.map(f2i);
  const spec = honestSoftmaxRaw(xf);
  cases.push({ op:'softmax', inputFixed:xf, weightsFixed:[], biasFixed:[],
               expectedFixed:spec.y });
}

// -- layernorm: from TS SPEC --
for (const c of [
  [0.5,-0.25,1,-1.5,2,-0.75,0.125,-2],
  [3,3,3,3,3,3,3,3],
  [7.9,-7.9,8,-8,4,-4,2,-2],
]) {
  const xf = c.map(f2i);
  const spec = honestLayernormRaw(xf);
  cases.push({ op:'layernorm', inputFixed:xf, weightsFixed:[], biasFixed:[],
               expectedFixed:spec.y });
}

// -- attention (matmul+bias+relu): from WASM --
{
  const inp=[0.5,-0.25,1,2];
  const w=[0.1,-0.2,0.3,0.4,-0.5,0.6,-0.7,0.8,0.9,1,-1.1,1.2,-1.3,1.4,-1.5,1.6];
  const b=[0.01,-0.02,0.03,-0.04];
  const out=rt.executeLayer('attention',[...w],[...inp]).map(v=>Math.round(v*65536));
  cases.push({op:'attention',inputFixed:inp.map(f2i),weightsFixed:w.map(f2i),
              biasFixed:b.map(f2i),expectedFixed:out});
}

const outPath = '/Users/indrajitguha/verinoo-node/crates/zk/tests/op_vectors.json';
writeFileSync(outPath, JSON.stringify(cases,null,2)+'\n');
console.log(`[export] ${cases.length} op vectors -> ${outPath}`);
