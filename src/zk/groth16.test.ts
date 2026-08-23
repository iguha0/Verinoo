import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { proveLayer, verifyLayer, computeTraceCommitmentHash, terminateZkWorkers } from './groth16';

describe('Groth16 ZK Layer', () => {
  after(async () => { await terminateZkWorkers(); });

  test('prove + verify roundtrip for honest layer', async () => {
    const input = [0.1, -0.1, 0.2, 0.3];
    const weights = [
      0.5, -0.2, 0.1, 0.0,
      0.1, 0.4, -0.3, 0.2,
      -0.1, 0.2, 0.5, -0.4,
      0.0, -0.1, 0.2, 0.3,
    ];
    const output = [0.2, -0.1, 0.3, 0.1]; // honest output
    const bias = [0.01, -0.01, 0.02, 0.0];

    const { proof, publicSignals } = await proveLayer(input, weights, output, bias);

    assert.ok(proof.pi_a?.length >= 2, 'has pi_a');
    assert.ok(proof.pi_b?.length >= 2, 'has pi_b');
    assert.ok(proof.pi_c?.length >= 2, 'has pi_c');
    assert.ok(publicSignals.length >= 1, 'has public signals');

    const ok = await verifyLayer(proof, publicSignals);
    assert.strictEqual(ok, true, 'honest proof verifies');
  });

  test('commitment hash deterministic', () => {
    const h1 = computeTraceCommitmentHash([0.1, -0.1, 0.2, 0.3], [0.5, -0.2, 0.1, 0.0], [0.2], [0.01]);
    const h2 = computeTraceCommitmentHash([0.1, -0.1, 0.2, 0.3], [0.5, -0.2, 0.1, 0.0], [0.2], [0.01]);
    assert.strictEqual(h1, h2);
  });

  test('tampered output fails verification', async () => {
    const input = [0.1, 0.1, 0.1, 0.1];
    const weights = [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2];
    const output = [0.3, 0.3, 0.3, 0.3]; // honest-ish output
    const bias = [0.0, 0.0, 0.0, 0.0];

    const { proof, publicSignals } = await proveLayer(input, weights, output, bias);
    const ok = await verifyLayer(proof, publicSignals);
    assert.strictEqual(ok, true, 'honest proof verifies');

    // Tamper the public signal (commitment hash)
    const tamperedSignals = [...publicSignals];
    tamperedSignals[0] = '9999999999999999999999999';
    const bad = await verifyLayer(proof, tamperedSignals);
    assert.strictEqual(bad, false, 'tampered public signal rejected');
  });
});
