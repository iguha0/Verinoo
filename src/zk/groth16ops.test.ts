import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import {
  proveRelu,
  verifyRelu,
  proveArgmax,
  verifyArgmax,
  honestRelu,
  honestArgmax,
  i2f,
} from './groth16ops';
import { terminateZkWorkers } from './groth16';

describe('Op Groth16 circuits (relu8 / argmax8)', () => {
  after(async () => { await terminateZkWorkers(); });

  const mixedInput = [0.5, -0.25, 0.0, -1.5, 2.0, -0.001, 0.125, -3.0];

  test('honest recompute helpers', () => {
    const xFixed = [65536, -16384, 0, -98304, 131072, -66, 8192, -196608];
    assert.deepStrictEqual(honestRelu(xFixed), [65536, 0, 0, 0, 131072, 0, 8192, 0]);
    assert.strictEqual(honestArgmax(xFixed), 4);
    assert.strictEqual(honestArgmax([5, 9, 9, 1]), 1, 'ties resolve to smallest index');
  });

  test('relu8 prove + verify roundtrip (mixed signs and zero)', async () => {
    const { proof, publicSignals, outputFixed } = await proveRelu(mixedInput);
    assert.deepStrictEqual(outputFixed, honestRelu(mixedInput.map(v => Math.round(v * 65536))));
    const ok = await verifyRelu(proof, publicSignals);
    assert.strictEqual(ok, true, 'honest relu proof verifies');
  });

  test('relu8 tampered public commitment rejected', async () => {
    const { proof, publicSignals } = await proveRelu(mixedInput);
    const tampered = [...publicSignals];
    tampered[0] = '12345';
    const ok = await verifyRelu(proof, tampered);
    assert.strictEqual(ok, false, 'tampered commitment rejected');
  });

  test('relu8 proof bound to its input set', async () => {
    // Proof for A must not verify against B's commitment signals
    const a = await proveRelu(mixedInput);
    const b = await proveRelu([0.5, -0.25, 0.0, -1.5, 2.0, -0.001, 0.125, 3.0]);
    const swapped = await verifyRelu(a.proof, b.publicSignals);
    assert.strictEqual(swapped, false, 'cross-input verification must fail');
  });

  test('argmax8 prove + verify roundtrip with tie to smallest index', async () => {
    const withTie = [0.1, 2.5, -1.0, 2.5, 0.0, 0.5, -2.0, 1.0];
    const { proof, publicSignals, index } = await proveArgmax(withTie);
    assert.strictEqual(index, 1, 'canonical argmax is smallest max index');
    const ok = await verifyArgmax(proof, publicSignals);
    assert.strictEqual(ok, true, 'honest argmax proof verifies');
    assert.ok(publicSignals.length >= 3, 'commitment, idx, maxVal are public');
    // idx is a public signal at position 1
    assert.strictEqual(BigInt(publicSignals[1]), 1n);
  });

  test('argmax8 wrong index rejected', async () => {
    const { proof, publicSignals } = await proveArgmax(mixedInput);
    const honestIdx = honestArgmax(mixedInput.map(v => Math.round(v * 65536)));
    const tampered = [...publicSignals];
    const wrongIdx = (honestIdx + 1) % 8;
    assert.notStrictEqual(wrongIdx, honestIdx);
    tampered[1] = String(wrongIdx);
    const ok = await verifyArgmax(proof, tampered);
    assert.strictEqual(ok, false, 'claiming a different maximizer index must fail');
  });

  test('fixed-point roundtrip helper', () => {
    assert.strictEqual(i2f(65536), 1.0);
  });
});
