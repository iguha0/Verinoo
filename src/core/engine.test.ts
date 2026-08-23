import { test, describe } from 'node:test';
import assert from 'node:assert';
import { AINativeEngine } from './engine';
import { BlockStore } from '../storage';
import { rmSync } from 'fs';
import { signMessage, generateKeyPair } from '../wallet/crypto';
import { deriveLayerWeights } from '../zk/circuit';
import { loadWasmSync, WasmRuntime } from '../wasm/runtime';

function makeTx(from: any, to: string, value: number, type: string, data: any, nonce: number) {
  const crypto = require('crypto');
  const txBase: any = { txId: '', from: from.address, to, value, nonce, data: { type, data }, publicKey: from.publicKey, signature: '' };
  txBase.txId = crypto.createHash('sha256').update(JSON.stringify({ type, data, from: from.address, nonce })).digest('hex').substring(0, 32);
  txBase.signature = signMessage(txBase.txId, from.privateKey);
  return txBase;
}

describe('AINativeEngine', () => {
  const TEST_DIR = './test_chain_tmp';

  function freshEngine() {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
    const store = new BlockStore(TEST_DIR);
    return new AINativeEngine(store);
  }

  test('genesis block created', () => {
    const engine = freshEngine();
    const g = engine.getLatestBlock();
    assert.ok(g);
    assert.strictEqual(g!.header.index, 0);
    assert.strictEqual(g!.header.validator, 'genesis');
    assert.strictEqual(g!.transactions.length, 0);
  });

  test('validateTransaction checks signature', () => {
    const engine = freshEngine();
    const kp = generateKeyPair();
    const tx = makeTx(kp, '', 0, 'registerNode', { stakedAmount: 100, supportedModels: [] }, 1);
    const val = engine.validateTransaction(tx);
    assert.strictEqual(val, true, 'tx is valid');
    
    const badTx = { ...tx, signature: 'bad_sig' };
    const val2 = engine.validateTransaction(badTx);
    assert.ok(val2 !== true, 'bad sig rejected');
  });

  test('validateTransaction detects wrong nonce', () => {
    const engine = freshEngine();
    const kp = generateKeyPair();
    engine.store.setAccount({ address: kp.address, publicKey: kp.publicKey, nonce: 5, balance: 1000, updatedAt: 0 });
    const tx = makeTx(kp, '', 0, 'registerNode', { stakedAmount: 100, supportedModels: [] }, 1);
    const val = engine.validateTransaction(tx);
    assert.ok(typeof val === 'string' && val.includes('nonce'), 'wrong nonce detected');
  });

  test('validateTransaction detects insufficient balance', () => {
    const engine = freshEngine();
    const kp = generateKeyPair();
    engine.store.setAccount({ address: kp.address, publicKey: kp.publicKey, nonce: 0, balance: 5, updatedAt: 0 });
    const tx = makeTx(kp, '', 100, 'registerNode', { stakedAmount: 100, supportedModels: [] }, 1);
    const val = engine.validateTransaction(tx);
    assert.ok(typeof val === 'string' && val.includes('balance'), 'insufficient balance detected');
  });

  test('full task lifecycle: submit -> match -> result -> challenge -> bisect -> resolve', () => {
    const engine = freshEngine();
    const treasury = generateKeyPair();
    const user = generateKeyPair();
    const node = generateKeyPair();
    const challenger = generateKeyPair();

    // Fund
    engine.store.setAccount({ address: treasury.address, publicKey: treasury.publicKey, nonce: 0, balance: 10000, updatedAt: 0 });
    engine.store.setAccount({ address: user.address, publicKey: user.publicKey, nonce: 0, balance: 2000, updatedAt: 0 });
    engine.store.setAccount({ address: node.address, publicKey: node.publicKey, nonce: 0, balance: 1000, updatedAt: 0 });
    engine.store.setAccount({ address: challenger.address, publicKey: challenger.publicKey, nonce: 0, balance: 500, updatedAt: 0 });

    // Register model — Tiny-Test-Net uses 4-element vectors for WASM compatibility
    engine.produceBlock([makeTx(treasury, '', 0, 'registerModel', {
      architecture: 'Tiny-Test-Net', parameterCount: 256,
      weightsHash: 'w_' + 'a'.repeat(32), runtimeHash: 'r_' + 'b'.repeat(32),
      stakingRequirement: 50, description: 'WASM-compatible test model',
    }, 1)], treasury);
    const modelId = engine.store.getModels()[0].modelId;
    assert.ok(modelId, 'model registered');

    // Register node
    engine.produceBlock([makeTx(node, '', 0, 'registerNode', {
      stakedAmount: 800, availableCapacity: 4, maxCapacity: 4,
      activeTasks: 0, reputation: 75, successfulInferences: 0, failedInferences: 0,
      supportedModels: [modelId],
    }, 1)], treasury);
    assert.strictEqual(engine.getNode(node.address)?.reputation, 75);

    // Submit inference (auto-matched in block production)
    engine.produceBlock([makeTx(user, '', 100, 'submitInference', {
      requester: user.address, targetModel: modelId,
      inputCommitment: 'inp_test_commitment',
      maxFee: 100, deadline: 1000, verificationType: 'optimistic',
    }, 1)], treasury);
    
    const task = engine.store.getTasksByStatus('assigned')[0];
    assert.ok(task, 'task auto-matched');
    assert.strictEqual(task!.assignedTo, node.address);
    
    // Submit result
    engine.produceBlock([makeTx(node, '', 0, 'submitResult', {
      taskId: task!.taskId,
      resultHash: 'res_correct_hash',
      resultOutput: 'The patient shows elevated troponin levels.',
      proofData: 'mock_proof',
    }, 2)], treasury);
    
    const completedTask = engine.getTask(task!.taskId);
    assert.strictEqual(completedTask?.status, 'completed');
    assert.ok(completedTask?.challengeWindowEnd! > 0, 'challenge window set');

    // Open challenge
    engine.produceBlock([makeTx(challenger, '', 0, 'challengeResult', {
      taskId: task!.taskId,
      reason: 'Fraud!',
    }, 1)], treasury);

    const challenged = engine.getTask(task!.taskId);
    assert.strictEqual(challenged?.status, 'challenged');
    const gameId = challenged?.gameId;
    assert.ok(gameId, 'game created');

    const game = engine.getGame(gameId!);
    assert.ok(game, 'game exists');
    assert.strictEqual(game!.status, 'open');
    assert.strictEqual(game!.challenger, challenger.address);
    assert.strictEqual(game!.defender, node.address);

    // Bisection round 1 — challenger
    engine.produceBlock([makeTx(challenger, '', 0, 'bisect', {
      gameId, layerIndex: 2, traceRoot: 'trace_ch_2',
    }, 2)], treasury);
    
    // Bisection round 1 — defender (DIFFERENT)
    engine.produceBlock([makeTx(node, '', 0, 'bisect', {
      gameId, layerIndex: 2, traceRoot: 'trace_df_2_DIFFERENT',
    }, 3)], treasury);

    const gameMid = engine.getGame(gameId!);
    assert.ok(gameMid!.status === 'bisecting' || gameMid!.status === 'proving', 'bisection advanced');
    assert.strictEqual(gameMid!.disputedLayer, 2, 'disputed layer set');

    // Bisection round 2 — challenger at layer 1
    engine.produceBlock([makeTx(challenger, '', 0, 'bisect', {
      gameId, layerIndex: 1, traceRoot: 'trace_ch_1',
    }, 3)], treasury);

    // Defender AGREES at layer 1
    engine.produceBlock([makeTx(node, '', 0, 'bisect', {
      gameId, layerIndex: 1, traceRoot: 'trace_ch_1', // same!
    }, 4)], treasury);

    const gameFinal = engine.getGame(gameId!);
    assert.strictEqual(gameFinal!.high - gameFinal!.low, 1, 'narrowed to single layer');

    // Compute the honest deterministic output for the disputed layer
    const spec = gameFinal!.layerSpec[gameFinal!.disputedLayer];
    const lw = deriveLayerWeights(spec, 'Tiny-Test-Net', task!.taskId, gameFinal!.disputedLayer);
    const layerInput = [0.1, -0.1, 0.2, 0.3];
    const honestOutput = new WasmRuntime(loadWasmSync()).executeLayer(
      spec.opType, lw.weights, layerInput, lw.bias
    );

    // Prove step — defender wins with WASM-verified honest output
    engine.produceBlock([makeTx(node, '', 0, 'proveStep', {
      gameId,
      layerWeights: lw.weights,
      layerInput,
      layerBias: lw.bias,
      layerOutput: honestOutput,
      actualTraceRoot: gameFinal!.challengerCommitments[gameFinal!.disputedLayer],
    }, 5)], treasury);

    const resolved = engine.getGame(gameId!);
    assert.strictEqual(resolved?.status, 'resolved_valid');
    assert.strictEqual(resolved?.winner, node.address);
    
    const finalNode = engine.getNode(node.address);
    assert.ok(finalNode!.reputation > 75, 'reputation recovered + bonus');
  });

  test('timeout: challenger forfeit', () => {
    const engine = freshEngine();
    const treasury = generateKeyPair();
    const user = generateKeyPair();
    const node = generateKeyPair();
    const challenger = generateKeyPair();

    engine.store.setAccount({ address: treasury.address, publicKey: treasury.publicKey, nonce: 0, balance: 10000, updatedAt: 0 });
    engine.store.setAccount({ address: user.address, publicKey: user.publicKey, nonce: 0, balance: 2000, updatedAt: 0 });
    engine.store.setAccount({ address: node.address, publicKey: node.publicKey, nonce: 0, balance: 1000, updatedAt: 0 });
    engine.store.setAccount({ address: challenger.address, publicKey: challenger.publicKey, nonce: 0, balance: 500, updatedAt: 0 });

    engine.produceBlock([makeTx(treasury, '', 0, 'registerModel', {
      architecture: 'Tiny-Test-Net', parameterCount: 256,
      weightsHash: 'w_test', runtimeHash: 'r_test', stakingRequirement: 50, description: 'Test',
    }, 1)], treasury);
    const modelId = engine.store.getModels()[0].modelId;

    engine.produceBlock([makeTx(node, '', 0, 'registerNode', {
      stakedAmount: 800, availableCapacity: 4, maxCapacity: 4,
      activeTasks: 0, reputation: 75, supportedModels: [modelId],
    }, 1)], treasury);

    engine.produceBlock([makeTx(user, '', 100, 'submitInference', {
      requester: user.address, targetModel: modelId,
      inputCommitment: 'inp_test', maxFee: 100, deadline: 1000, verificationType: 'optimistic',
    }, 1)], treasury);
    const task = engine.store.getTasksByStatus('assigned')[0];

    engine.produceBlock([makeTx(node, '', 0, 'submitResult', {
      taskId: task!.taskId, resultHash: 'res_hash', resultOutput: 'output',
    }, 2)], treasury);

    engine.produceBlock([makeTx(challenger, '', 0, 'challengeResult', {
      taskId: task!.taskId, reason: 'Timeout test',
    }, 1)], treasury);
    
    const gameId = engine.getTask(task!.taskId)?.gameId;
    assert.ok(gameId);

    // Time out the game by fast-forwarding many blocks
    let currentHeight = 6;
    for (let i = 0; i < 10; i++) {
      engine.produceBlock([], treasury);
      currentHeight++;
    }

    // Any bisect after timeout should fail
    const timeoutTx = makeTx(challenger, '', 0, 'bisect', {
      gameId, layerIndex: 2, traceRoot: 'late_trace',
    }, 2);
    const result = engine.validateTransaction(timeoutTx);
    assert.ok(result === true, 'tx valid format');
    
    // Execution will fail due to timeout check inside
    let threw = false;
    try {
      engine.executeTransaction(timeoutTx, currentHeight);
    } catch (e) {
      threw = true;
    }
    assert.ok(threw, 'timed out bisection rejected');
  });
});
