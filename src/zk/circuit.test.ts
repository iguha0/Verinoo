import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  generateSetup,
  prove,
  verify,
  proveModel,
  verifyModel,
  deriveLayerWeights,
  buildTraceCommitment,
} from './circuit';

describe('ZK Circuit (hash-based prototype)', () => {
  const spec = {
    index: 1, name: 'attn_0', opType: 'attention' as const,
    inputShape: [1, 4], outputShape: [1, 4], tolerance: 0.001,
  };

  test('generateSetup is deterministic per architecture', () => {
    const s1 = generateSetup('Phi-2');
    const s2 = generateSetup('Phi-2');
    assert.strictEqual(s1.provingKeyHash, s2.provingKeyHash);
    assert.strictEqual(s1.verificationKeyHash, s2.verificationKeyHash);
    const s3 = generateSetup('Gemma-2B');
    assert.notStrictEqual(s1.provingKeyHash, s3.provingKeyHash);
  });

  test('deriveLayerWeights deterministic', () => {
    const w1 = deriveLayerWeights(spec, 'Phi-2', 'task1', 0);
    const w2 = deriveLayerWeights(spec, 'Phi-2', 'task1', 0);
    assert.deepStrictEqual(w1.weights, w2.weights);
    assert.deepStrictEqual(w1.bias, w2.bias);
    const w3 = deriveLayerWeights(spec, 'Phi-2', 'task2', 0);
    assert.notDeepStrictEqual(w1.weights, w3.weights);
  });

  test('buildTraceCommitment consistent', () => {
    const tc = buildTraceCommitment(
      spec,
      [0.1, 0.2, 0.3, 0.4],
      [0.5, 0.6, 0.7, 0.8],
      [0.0, 0.1],
      [0.01, 0.02]
    );
    assert.ok(tc.inputHash.length > 0);
    assert.ok(tc.outputHash.length > 0);
    assert.ok(tc.weightsHash.length > 0);
    assert.ok(tc.computationHash.length > 0);
    const tc2 = buildTraceCommitment(
      spec,
      [0.1, 0.2, 0.3, 0.4],
      [0.5, 0.6, 0.7, 0.8],
      [0.0, 0.1],
      [0.01, 0.02]
    );
    assert.strictEqual(tc.outputHash, tc2.outputHash);
  });

  test('prove generates ZKProof that verify passes', async () => {
    const weights = deriveLayerWeights(spec, 'Phi-2', 'task1', 0);
    const input = [0.1, -0.1, 0.2, 0.3];
    const proof = await prove(spec, 'Phi-2', 'task1', 1, input, weights.weights, weights.bias);

    assert.strictEqual(proof.publicInputs.architecture, 'Phi-2');
    assert.strictEqual(proof.publicInputs.taskId, 'task1');
    assert.strictEqual(proof.publicInputs.layerIndex, 1);
    assert.ok(proof.proofSignature.length > 0);

    const ok = await verify(proof);
    assert.strictEqual(ok, true, 'honest proof verifies');
  });

  test('verify detects tampered output', async () => {
    const weights = deriveLayerWeights(spec, 'Phi-2', 'task1', 0);
    const input = [0.1, -0.1, 0.2, 0.3];
    const proof = await prove(spec, 'Phi-2', 'task1', 1, input, weights.weights, weights.bias);
    proof.publicInputs.outputHash = 'deadbeef';
    const ok = await verify(proof);
    assert.strictEqual(ok, false, 'tampered output rejected');
  });

  test('verify detects tampered trace root', async () => {
    const weights = deriveLayerWeights(spec, 'Phi-2', 'task1', 0);
    const input = [0.1, -0.1, 0.2, 0.3];
    const proof = await prove(spec, 'Phi-2', 'task1', 1, input, weights.weights, weights.bias);
    proof.merkleProof.root = 'cccccc';
    const ok = await verify(proof);
    assert.strictEqual(ok, false, 'tampered root rejected');
  });

  test('full model prove + verify roundtrip', async () => {
    const layerSpecs = [
      { index: 0, name: 'attn0', opType: 'attention' as const, inputShape: [1, 4], outputShape: [1, 4], tolerance: 0 },
      { index: 1, name: 'ffn0', opType: 'ffn' as const, inputShape: [1, 4], outputShape: [1, 4], tolerance: 0.001 },
      { index: 2, name: 'head', opType: 'head' as const, inputShape: [1, 4], outputShape: [1, 4], tolerance: 0 },
    ];
    const allWeights = layerSpecs.map((s, i) => deriveLayerWeights(s, 'Gemma-2B', 'task-model-1', i).weights);
    const allBiases = layerSpecs.map((s, i) => deriveLayerWeights(s, 'Gemma-2B', 'task-model-1', i).bias);
    const initialInput = [0.5, -0.2, 0.1, 0.3];

    const modelProof = await proveModel('Gemma-2B', 'task-model-1', layerSpecs, allWeights, allBiases, initialInput);
    assert.strictEqual(modelProof.layerProofs.length, layerSpecs.length);
    assert.ok(modelProof.traceRoot.length > 0);

    const ok = await verifyModel(modelProof);
    assert.strictEqual(ok, true, 'honest model proof verifies');
  });
});
