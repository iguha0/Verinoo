import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { proveSoftmax, verifySoftmax } from './groth16softmax';
import { honestSoftmaxRaw, honestSoftmax } from './softmax';
import { WasmRuntime, loadWasmSync } from '../wasm/runtime';
import { terminateZkWorkers } from './groth16';

describe('Op Groth16 circuits (softmax8)', () => {
  after(async () => { await terminateZkWorkers(); });

  const cases = [
    [0.5, -0.25, 1.0, -1.5, 2.0, -0.75, 0.125, -2.0],
    [3, 3, 3, 3, 3, 3, 3, 3],                       // all tie
    [0, 0, 0, 0, 0, 0, 0, 0],
    [7.9, -7.9, 8.0, -8.0, 4.0, -4.0, 2.0, -2.0],   // domain edge
    [-1, -1, -2, -1, -5, -1, -9, -1],               // ties among negatives
    [0.001, -0.001, 0.002, -0.002, 0.001, -0.001, 0.002, -0.002],
  ];

  test('spec matches WASM softmax exactly on all cases', () => {
    const rt = new WasmRuntime(loadWasmSync());
    for (const c of cases) {
      const wasmFixed = rt.executeLayer('softmax', [], [...c]).map(v => Math.round(v * 65536));
      const ref = honestSoftmaxRaw(c.map(v => Math.round(v * 65536))).y;
      assert.deepStrictEqual(wasmFixed, ref, `WASM vs spec mismatch for ${JSON.stringify(c)}`);
    }
  });

  test('reference semantics: all-equal -> uniform 1/8', () => {
    const y = honestSoftmax([3, 3, 3, 3, 3, 3, 3, 3]);
    for (const v of y) assert.strictEqual(v, 0.125);
  });

  test('reference semantics: single max -> one-hot', () => {
    const raw = honestSoftmaxRaw([0, 0, 0, 0, 65536, 0, 0, 0]);
    assert.deepStrictEqual(raw.y, [0, 0, 0, 0, 65536, 0, 0, 0]);
  });

  for (const [idx, c] of cases.entries()) {
    test(`prove + verify roundtrip #${idx}`, async () => {
      const { proof, publicSignals, outputFixed } = await proveSoftmax(c);
      assert.strictEqual(outputFixed.length, 8);
      const ok = await verifySoftmax(proof, publicSignals);
      assert.strictEqual(ok, true, `honest softmax verifies for case ${idx}`);
      assert.deepStrictEqual(outputFixed, honestSoftmaxRaw(c.map(v => Math.round(v * 65536))).y);
    });
  }

  test('tampered public commitment rejected', async () => {
    const { proof, publicSignals } = await proveSoftmax(cases[0]);
    const tampered = [...publicSignals];
    tampered[0] = '777';
    assert.strictEqual(await verifySoftmax(proof, tampered), false);
  });

  test('proof bound to its input set', async () => {
    const a = await proveSoftmax(cases[0]);
    const b = await proveSoftmax(cases[3]);
    assert.strictEqual(await verifySoftmax(a.proof, b.publicSignals), false);
  });
});
