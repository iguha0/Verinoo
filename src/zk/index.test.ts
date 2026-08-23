import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  executeLayer,
  commitLayerOutput,
  buildTraceRoot,
  proveLayerOpening,
  verifyLayerOpening,
  generateProof,
  verifyProof,
  verifyLayerProof,
  getLayerSpec,
} from './index';
import { LayerSpec } from '../core/types';

describe('ZK/WASM Mock Layer', () => {
  const arch = 'Gemma-2B-IT';
  const specs = getLayerSpec(arch);

  test('getLayerSpec returns known architecture deterministically', () => {
    assert.ok(specs.length >= 3);
    assert.equal(specs[0].opType, 'embedding');
    assert.equal(specs[specs.length - 1].opType, 'head');
    const specs2 = getLayerSpec(arch);
    assert.deepStrictEqual(specs, specs2);
  });

  test('executeLayer is deterministic for same inputs', () => {
    const spec = specs[1]; // attention
    const weights = [0.5, -0.5, 1.0, 0.2];
    const input = [1, 2, 3, 4];
    const ctx = { taskId: 'abc123', layerIndex: 1, architecture: arch };
    const a = executeLayer(spec, weights, input, ctx);
    const b = executeLayer(spec, weights, input, ctx);
    assert.deepStrictEqual(a, b);
    assert.ok(a.length > 0);
  });

  test('executeLayer differs with different taskId or layer', () => {
    const spec = specs[2];
    const weights = [1];
    const input = [1];
    const a = executeLayer(spec, weights, input, { taskId: 't1', layerIndex: 0, architecture: arch });
    const b = executeLayer(spec, weights, input, { taskId: 't2', layerIndex: 0, architecture: arch });
    assert.notDeepStrictEqual(a, b);
  });

  test('commitLayerOutput produces consistent hashes', () => {
    const o1 = [1.2, -0.5, 3.0];
    assert.equal(commitLayerOutput(o1), commitLayerOutput([1.2, -0.5, 3.0]));
    assert.notEqual(commitLayerOutput(o1), commitLayerOutput([1.2, -0.5, 3.01]));
  });

  test('Merkle root builds and verifies', () => {
    const leaves = ['a', 'b', 'c', 'd'].map(s => commitLayerOutput([s as any]));
    const root = buildTraceRoot(leaves);
    assert.ok(root.length > 0);

    const proof = proveLayerOpening(leaves, 2);
    assert.equal(proof.leafIndex, 2);
    assert.ok(proof.siblings.length > 0);
    assert.ok(verifyLayerOpening(root, leaves[2], proof));
    assert.ok(!verifyLayerOpening(root, leaves[0], proof));
  });

  test('generateProof creates verifiable full model proof', () => {
    const architecture = 'Phi-2-Medical-v1';
    const taskId = 'demo-task-99';
    const layerSpecs = getLayerSpec(architecture);
    const allWeights = layerSpecs.map(() => [0.1, -0.1, 0.2, -0.2]);
    const initialInput = new Array(layerSpecs[0].inputShape.reduce((a, b) => a * b, 1)).fill(0);

    const proof = generateProof(architecture, taskId, layerSpecs, allWeights, initialInput);
    assert.equal(proof.architecture, architecture);
    assert.equal(proof.taskId, taskId);
    assert.equal(proof.layerProofs.length, layerSpecs.length);

    assert.ok(verifyProof(proof));
  });

  test('verifyProof fails when output is tampered', () => {
    const architecture = 'Phi-2-Medical-v1';
    const taskId = 'tamper-task';
    const layerSpecs = getLayerSpec(architecture);
    const allWeights = layerSpecs.map(() => [0.5]);
    const initialInput = new Array(layerSpecs[0].inputShape.reduce((a, b) => a * b, 1)).fill(0);

    const proof = generateProof(architecture, taskId, layerSpecs, allWeights, initialInput);
    assert.ok(verifyProof(proof));

    proof.layerProofs[1].output[0] += 1000;
    assert.ok(!verifyProof(proof));
  });

  test('verifyProof fails with wrong trace root', () => {
    const architecture = 'LiveNet-Model';
    const taskId = 'root-task';
    const layerSpecs = getLayerSpec(architecture);
    const allWeights = layerSpecs.map(() => [0.0]);
    const initialInput = new Array(layerSpecs[0].inputShape.reduce((a, b) => a * b, 1)).fill(0);

    const proof = generateProof(architecture, taskId, layerSpecs, allWeights, initialInput);
    assert.ok(verifyProof(proof));

    proof.traceRoot = 'dead';
    assert.ok(!verifyProof(proof));
  });

  test('verifyLayerProof for single step', () => {
    const spec = specs[1];
    const weights = [0.1, -0.1];
    const input = [0.5, -0.5];
    const ctx = { taskId: 'step-task', layerIndex: 1, architecture: arch };
    const output = executeLayer(spec, weights, input, ctx);
    const traceRoot = buildTraceRoot([commitLayerOutput(output), commitLayerOutput(output)]);

    const ok = verifyLayerProof(spec, weights, input, output, traceRoot, ctx);
    assert.equal(ok, true);

    const bad = verifyLayerProof(spec, weights, input, output.map(v => v + 1), traceRoot, ctx);
    assert.equal(bad, false);
  });

  test('getLayerSpec fallback for unknown architectures', () => {
    const s = getLayerSpec('NeverHeard-7B-v3');
    assert.ok(s.length >= 3);
    assert.equal(s[0].opType, 'embedding');
    assert.equal(s[s.length - 1].opType, 'head');
    const s2 = getLayerSpec('NeverHeard-7B-v3');
    assert.deepStrictEqual(s, s2);
  });
});
