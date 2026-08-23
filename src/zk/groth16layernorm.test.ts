import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { proveLayernorm, verifyLayernorm } from './groth16layernorm';
import { honestLayernormRaw, honestLayernorm } from './layernorm';
import { terminateZkWorkers } from './groth16';

describe('Op Groth16 circuits (layernorm8)', () => {
  after(async () => { await terminateZkWorkers(); });

  const cases: { name: string; x: number[] }[] = [
    { name: 'typical activations', x: [0.5, -0.25, 1.0, -1.5, 2.0, -0.75, 0.125, -2.0] },
    { name: 'all equal (zero variance)', x: [3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0] },
    { name: 'near-zero variance', x: [0.001, -0.001, 0.002, -0.002, 0.001, -0.001, 0.002, -0.002] },
    { name: 'mixed with zeros', x: [0, 0, 0, 1.5, -1.5, 0, 2.25, -0.5] },
    { name: 'large magnitude', x: [7.9, -7.9, 8.0, -8.0, 4.0, -4.0, 2.0, -2.0] },
  ];

  test('reference spec: zero variance maps to zeros', () => {
    const t = honestLayernormRaw(new Array(8).fill(196608)); // 3.0
    assert.deepStrictEqual(t.y, new Array(8).fill(0));
  });

  test('reference spec matches float wrapper', () => {
    const y = honestLayernorm([0.5, -0.25, 1.0, -1.5, 2.0, -0.75, 0.125, -2.0]);
    assert.strictEqual(y.length, 8);
    // mean-centered: outputs must sum to ~0
    const s = y.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(s) < 0.01, `outputs centered, got sum ${s}`);
    // unit-ish scale: std of inputs ≈ 1.17 -> largest |y| should be < 2
    assert.ok(Math.max(...y.map(Math.abs)) < 2);
  });

  for (const c of cases) {
    test(`prove + verify roundtrip: ${c.name}`, async () => {
      const { proof, publicSignals, outputFixed } = await proveLayernorm(c.x);
      assert.strictEqual(outputFixed.length, 8);
      const ok = await verifyLayernorm(proof, publicSignals);
      assert.strictEqual(ok, true, `honest layernorm verifies for ${c.name}`);
      // Output must equal the reference implementation exactly
      const ref = honestLayernormRaw(c.x.map(v => Math.round(v * 65536)));
      assert.deepStrictEqual(outputFixed, ref.y);
    });
  }

  test('tampered public commitment rejected', async () => {
    const { proof, publicSignals } = await proveLayernorm([0.5, -0.25, 1.0, -1.5, 2.0, -0.75, 0.125, -2.0]);
    const tampered = [...publicSignals];
    tampered[0] = '42';
    const ok = await verifyLayernorm(proof, tampered);
    assert.strictEqual(ok, false);
  });

  test('proof bound to its input set', async () => {
    const a = await proveLayernorm([0.5, -0.25, 1.0, -1.5, 2.0, -0.75, 0.125, -2.0]);
    const b = await proveLayernorm([1.5, 0.25, -1.0, 1.5, -2.0, 0.75, -0.125, 2.0]);
    const swapped = await verifyLayernorm(a.proof, b.publicSignals);
    assert.strictEqual(swapped, false, 'cross-input verification must fail');
  });

  test('wrong output rejected (circuit binds y to x)', async () => {
    // Prove for A, then attempt to verify against a commitment computed from B's output values
    const xa = [0.5, -0.25, 1.0, -1.5, 2.0, -0.75, 0.125, -2.0];
    const { proof, publicSignals } = await proveLayernorm(xa);
    const wrong = await verifyLayernorm(proof, publicSignals); // sanity: honest passes
    assert.strictEqual(wrong, true);

    // Forge: recompute commitment over tampered y and check the original proof no longer matches
    const BN254 = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
    const xFixed = xa.map(v => Math.round(v * 65536));
    const badY = new Array(8).fill(12345);
    let sum = BigInt(0);
    for (const v of [...xFixed, ...badY]) sum = (sum + BigInt(v) * BigInt(v)) % BN254;
    const forged = [...publicSignals];
    forged[0] = sum.toString();
    const okForged = await verifyLayernorm(proof, forged);
    assert.strictEqual(okForged, false, 'commitment mismatch must fail');
  });
});
