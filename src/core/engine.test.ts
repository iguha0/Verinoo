import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { AINativeEngine } from './engine';
import { BlockStore } from '../storage';
import { rmSync } from 'fs';
import { signMessage, generateKeyPair } from '../wallet/crypto';
import { deriveLayerWeights } from '../zk/circuit';
import { loadWasmSync, WasmRuntime } from '../wasm/runtime';
import { proveRelu } from '../zk/groth16ops';
import { signTransaction } from '../core/canonical';
import { terminateZkWorkers } from '../zk/groth16';

function makeTx(from: any, to: string, value: number, type: string, data: any, nonce: number) {
  return signTransaction(
    { from: from.address, to, value, nonce, data: { type, data }, publicKey: from.publicKey },
    from.privateKey
  );
}

describe('AINativeEngine', () => {
  const TEST_DIR = './test_chain_tmp';

  after(async () => { await terminateZkWorkers(); });

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
    engine.store.setAccount({ address: kp.address, publicKey: kp.publicKey, nonce: 0, balance: 1000, updatedAt: 0 });
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

  test('full task lifecycle: submit -> match -> result -> challenge -> bisect -> resolve', async () => {
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
    await engine.produceBlock([makeTx(treasury, '', 0, 'registerModel', {
      architecture: 'Tiny-Test-Net', parameterCount: 256,
      weightsHash: 'w_' + 'a'.repeat(32), runtimeHash: 'r_' + 'b'.repeat(32),
      stakingRequirement: 50, description: 'WASM-compatible test model',
    }, 1)], treasury);
    const modelId = engine.store.getModels()[0].modelId;
    assert.ok(modelId, 'model registered');

    // Register node
    await engine.produceBlock([makeTx(node, '', 0, 'registerNode', {
      stakedAmount: 800, availableCapacity: 4, maxCapacity: 4,
      activeTasks: 0, reputation: 75, successfulInferences: 0, failedInferences: 0,
      supportedModels: [modelId],
    }, 1)], treasury);
    assert.strictEqual(engine.getNode(node.address)?.reputation, 75);

    // Submit inference (auto-matched in block production)
    await engine.produceBlock([makeTx(user, '', 100, 'submitInference', {
      requester: user.address, targetModel: modelId,
      inputCommitment: 'inp_test_commitment',
      maxFee: 100, deadline: 1000, verificationType: 'optimistic',
    }, 1)], treasury);
    
    const task = engine.store.getTasksByStatus('assigned')[0];
    assert.ok(task, 'task auto-matched');
    assert.strictEqual(task!.assignedTo, node.address);
    
    // Submit result
    await engine.produceBlock([makeTx(node, '', 0, 'submitResult', {
      taskId: task!.taskId,
      resultHash: 'res_correct_hash',
      resultOutput: 'The patient shows elevated troponin levels.',
      proofData: 'mock_proof',
    }, 2)], treasury);
    
    const completedTask = engine.getTask(task!.taskId);
    assert.strictEqual(completedTask?.status, 'completed');
    assert.ok(completedTask?.challengeWindowEnd! > 0, 'challenge window set');

    // Open challenge
    await engine.produceBlock([makeTx(challenger, '', 0, 'challengeResult', {
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
    await engine.produceBlock([makeTx(challenger, '', 0, 'bisect', {
      gameId, layerIndex: 2, traceRoot: 'trace_ch_2',
    }, 2)], treasury);
    
    // Bisection round 1 — defender (DIFFERENT)
    await engine.produceBlock([makeTx(node, '', 0, 'bisect', {
      gameId, layerIndex: 2, traceRoot: 'trace_df_2_DIFFERENT',
    }, 3)], treasury);

    const gameMid = engine.getGame(gameId!);
    assert.ok(gameMid!.status === 'bisecting' || gameMid!.status === 'proving', 'bisection advanced');
    assert.strictEqual(gameMid!.disputedLayer, 2, 'disputed layer set');

    // Bisection round 2 — challenger at layer 1
    await engine.produceBlock([makeTx(challenger, '', 0, 'bisect', {
      gameId, layerIndex: 1, traceRoot: 'trace_ch_1',
    }, 3)], treasury);

    // Defender AGREES at layer 1
    await engine.produceBlock([makeTx(node, '', 0, 'bisect', {
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
    await engine.produceBlock([makeTx(node, '', 0, 'proveStep', {
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

  test('timeout: challenger forfeit', async () => {
    const engine = freshEngine();
    const treasury = generateKeyPair();
    const user = generateKeyPair();
    const node = generateKeyPair();
    const challenger = generateKeyPair();

    engine.store.setAccount({ address: treasury.address, publicKey: treasury.publicKey, nonce: 0, balance: 10000, updatedAt: 0 });
    engine.store.setAccount({ address: user.address, publicKey: user.publicKey, nonce: 0, balance: 2000, updatedAt: 0 });
    engine.store.setAccount({ address: node.address, publicKey: node.publicKey, nonce: 0, balance: 1000, updatedAt: 0 });
    engine.store.setAccount({ address: challenger.address, publicKey: challenger.publicKey, nonce: 0, balance: 500, updatedAt: 0 });

    await engine.produceBlock([makeTx(treasury, '', 0, 'registerModel', {
      architecture: 'Tiny-Test-Net', parameterCount: 256,
      weightsHash: 'w_test', runtimeHash: 'r_test', stakingRequirement: 50, description: 'Test',
    }, 1)], treasury);
    const modelId = engine.store.getModels()[0].modelId;

    await engine.produceBlock([makeTx(node, '', 0, 'registerNode', {
      stakedAmount: 800, availableCapacity: 4, maxCapacity: 4,
      activeTasks: 0, reputation: 75, supportedModels: [modelId],
    }, 1)], treasury);

    await engine.produceBlock([makeTx(user, '', 100, 'submitInference', {
      requester: user.address, targetModel: modelId,
      inputCommitment: 'inp_test', maxFee: 100, deadline: 1000, verificationType: 'optimistic',
    }, 1)], treasury);
    const task = engine.store.getTasksByStatus('assigned')[0];

    await engine.produceBlock([makeTx(node, '', 0, 'submitResult', {
      taskId: task!.taskId, resultHash: 'res_hash', resultOutput: 'output',
    }, 2)], treasury);

    await engine.produceBlock([makeTx(challenger, '', 0, 'challengeResult', {
      taskId: task!.taskId, reason: 'Timeout test',
    }, 1)], treasury);
    
    const gameId = engine.getTask(task!.taskId)?.gameId;
    assert.ok(gameId);

    // Time out the game by fast-forwarding many blocks
    let currentHeight = 6;
    for (let i = 0; i < 10; i++) {
      await engine.produceBlock([], treasury);
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
      await engine.executeTransaction(timeoutTx, currentHeight);
    } catch (e) {
      threw = true;
    }
    assert.ok(threw, 'timed out bisection rejected');
  });

  test('mandatory gas: fee debited from sender, split validator/treasury', async () => {
    const engine = freshEngine();
    const kp = generateKeyPair();
    const val = generateKeyPair();
    engine.store.setAccount({ address: kp.address, publicKey: kp.publicKey, nonce: 0, balance: 1000, updatedAt: 0 });
    engine.store.setAccount({ address: val.address, publicKey: val.publicKey, nonce: 0, balance: 0, updatedAt: 0 });

    const tx = makeTx(kp, 'recipient', 10, 'transfer', {}, 1);
    await engine.produceBlock([tx], { address: val.address, publicKey: val.publicKey, privateKey: val.privateKey });

    // transfer costs gasCostFor=50 * baseFee=1
    assert.strictEqual(engine.getAccount(kp.address)?.balance, 1000 - 10 - 50);
    assert.strictEqual(engine.getAccount('recipient')?.balance, 10);
    assert.strictEqual(engine.getAccount(val.address)?.balance, Math.floor(50 * 0.75)); // 37
    const expectedTreasury = 50 - Math.floor(50 * 0.75); // 13 (25% burn)
    assert.strictEqual(engine.getAccount('treasury')?.balance, expectedTreasury);
  });

  test('insufficient balance for value + gas rejected', () => {
    const engine = freshEngine();
    const kp = generateKeyPair();
    engine.store.setAccount({ address: kp.address, publicKey: kp.publicKey, nonce: 0, balance: 40, updatedAt: 0 });
    // transfer value 5 + fee 50 > 40 balance
    const tx = makeTx(kp, 'r', 5, 'transfer', {}, 1);
    const res = engine.validateTransaction(tx);
    assert.ok(typeof res === 'string' && res.includes('gas'), 'value+gas check enforced');
  });

  test('baseFee deterministic across independent engines replaying same chain', async () => {
    const mkChain = async () => {
      const engine = freshEngine();
      const kp = generateKeyPair();
      const val = generateKeyPair();
      engine.store.setAccount({ address: kp.address, publicKey: kp.publicKey, nonce: 0, balance: 100000, updatedAt: 0 });
      for (let n = 1; n <= 3; n++) {
        await engine.produceBlock([makeTx(kp, '', 1, 'transfer', {}, n)], {
          address: val.address, publicKey: val.publicKey, privateKey: val.privateKey,
        });
      }
      return engine;
    };
    const a = await mkChain();
    const b = await mkChain();
    assert.strictEqual(a.nextBaseFee(), b.nextBaseFee(), 'same chain -> same next baseFee');
    // With tiny blocks (gasUsed < target) baseFee decays toward minimum but stays >= 1
    assert.ok(a.nextBaseFee() >= 1);
  });
});

describe('Verification policy + SNARK fast path', () => {
  const TEST_DIR = './test_chain_tmp';

  after(async () => { await terminateZkWorkers(); });

  function freshEngine() {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
    return new AINativeEngine(new BlockStore(TEST_DIR));
  }

  test('sampled policy doubles gas and is stored on the task', async () => {
    const engine = freshEngine();
    const user = generateKeyPair();
    engine.store.setAccount({ address: user.address, publicKey: user.publicKey, nonce: 0, balance: 10000, updatedAt: 0 });

    const tx = makeTx(user, '', 0, 'submitInference', {
      requester: user.address, targetModel: 'm1', inputCommitment: 'c',
      maxFee: 10, deadline: 100, verificationType: 'sampled',
    }, 1);
    const val = generateKeyPair();
    await engine.produceBlock([tx], { address: val.address, publicKey: val.publicKey, privateKey: val.privateKey });

    // submitInference costs 60 gas; sampled multiplier x2
    assert.strictEqual(engine.getAccount(user.address)?.balance, 10000 - 120);
    const task = engine.store.getTasksByStatus('pending')[0];
    assert.strictEqual(task?.verificationType, 'sampled');
  });

  test('unknown verificationType rejected', () => {
    const engine = freshEngine();
    const user = generateKeyPair();
    engine.store.setAccount({ address: user.address, publicKey: user.publicKey, nonce: 0, balance: 100000, updatedAt: 0 });
    const tx = makeTx(user, '', 0, 'submitInference', { verificationType: 'yolo' }, 1);
    const res = engine.validateTransaction(tx);
    assert.ok(typeof res === 'string' && res.includes('invalid verificationType'));
  });

  test('genuine relu8 SNARK resolves proveStep without WASM path', async () => {
    const engine = freshEngine();
    const treasury = generateKeyPair();
    const user = generateKeyPair();
    const node = generateKeyPair();
    const challenger = generateKeyPair();

    for (const [kp, bal] of [[treasury, 10000], [user, 5000], [node, 5000], [challenger, 2000]] as const) {
      engine.store.setAccount({ address: kp.address, publicKey: kp.publicKey, nonce: 0, balance: bal, updatedAt: 0 });
    }

    await engine.produceBlock([makeTx(treasury, '', 0, 'registerModel', {
      architecture: 'Relu-Test-Net', parameterCount: 64,
      weightsHash: 'w_' + 'r'.repeat(32), runtimeHash: 'r_' + 's'.repeat(32),
      stakingRequirement: 1, description: 'relu fast-path model',
    }, 1)], treasury);
    const modelId = engine.store.getModels()[0].modelId;

    await engine.produceBlock([makeTx(node, '', 0, 'registerNode', {
      stakedAmount: 100, availableCapacity: 2, maxCapacity: 2, activeTasks: 0,
      reputation: 50, successfulInferences: 0, failedInferences: 0, supportedModels: [modelId],
    }, 1)], treasury);

    await engine.produceBlock([makeTx(user, '', 0, 'submitInference', {
      requester: user.address, targetModel: modelId, inputCommitment: 'c',
      maxFee: 100, deadline: 1000, verificationType: 'optimistic',
    }, 1)], treasury);
    const task = engine.store.getTasksByStatus('assigned')[0];
    assert.ok(task, 'matched');

    await engine.produceBlock([makeTx(node, '', 0, 'submitResult', {
      taskId: task!.taskId, resultHash: 'h', resultOutput: 'ok', proofData: '',
    }, 2)], treasury);

    await engine.produceBlock([makeTx(challenger, '', 0, 'challengeResult', {
      taskId: task!.taskId, reason: 'dispute for fast-path test',
    }, 1)], treasury);
    const gameId = engine.getTask(task!.taskId)?.gameId;
    assert.ok(gameId);

    // narrow to proving (single-layer spec)
    await engine.produceBlock([makeTx(challenger, '', 0, 'bisect', { gameId, layerIndex: 0, traceRoot: 'tr0' }, 2)], treasury);
    await engine.produceBlock([makeTx(node, '', 0, 'bisect', { gameId, layerIndex: 0, traceRoot: 'tr0' }, 3)], treasury);
    assert.strictEqual(engine.getGame(gameId!)?.status, 'proving');

    const layerInput = [0.5, -0.25, 1.0, -1.5, 2.0, -0.75, 0.125, -2.0];
    const { proof, publicSignals, outputFixed } = await proveRelu(layerInput);
    const layerOutput = outputFixed.map(v => v / 65536);

    await engine.produceBlock([makeTx(node, '', 0, 'proveStep', {
      gameId,
      layerWeights: [], layerInput, layerBias: [],
      layerOutput, actualTraceRoot: 'tr0',
      snark: { proofType: 'relu8', proof, publicSignals },
    }, 4)], treasury);

    const resolved = engine.getGame(gameId!);
    assert.strictEqual(resolved?.status, 'resolved_valid', 'fast path must resolve honestly');
    assert.strictEqual(resolved?.winner, node.address);
  });

  test('forged/tampered SNARK cannot win — falls back and slashes', async () => {
    const engine = freshEngine();
    const treasury = generateKeyPair();
    const user = generateKeyPair();
    const node = generateKeyPair();
    const challenger = generateKeyPair();

    for (const [kp, bal] of [[treasury, 10000], [user, 5000], [node, 5000], [challenger, 2000]] as const) {
      engine.store.setAccount({ address: kp.address, publicKey: kp.publicKey, nonce: 0, balance: bal, updatedAt: 0 });
    }

    await engine.produceBlock([makeTx(treasury, '', 0, 'registerModel', {
      architecture: 'Relu-Test-Net', parameterCount: 64,
      weightsHash: 'w_' + 'r'.repeat(32), runtimeHash: 'r_' + 's'.repeat(32),
      stakingRequirement: 1, description: 'forge test',
    }, 1)], treasury);
    const modelId = engine.store.getModels()[0].modelId;

    await engine.produceBlock([makeTx(node, '', 0, 'registerNode', {
      stakedAmount: 100, availableCapacity: 2, maxCapacity: 2, activeTasks: 0,
      reputation: 50, successfulInferences: 0, failedInferences: 0, supportedModels: [modelId],
    }, 1)], treasury);

    await engine.produceBlock([makeTx(user, '', 0, 'submitInference', {
      requester: user.address, targetModel: modelId, inputCommitment: 'c',
      maxFee: 100, deadline: 1000, verificationType: 'optimistic',
    }, 1)], treasury);
    const task = engine.store.getTasksByStatus('assigned')[0];

    await engine.produceBlock([makeTx(node, '', 0, 'submitResult', {
      taskId: task!.taskId, resultHash: 'h', resultOutput: 'ok', proofData: '',
    }, 2)], treasury);

    await engine.produceBlock([makeTx(challenger, '', 0, 'challengeResult', {
      taskId: task!.taskId, reason: 'forge test challenge',
    }, 1)], treasury);
    const gameId = engine.getTask(task!.taskId)?.gameId!;

    await engine.produceBlock([makeTx(challenger, '', 0, 'bisect', { gameId, layerIndex: 0, traceRoot: 'trX' }, 2)], treasury);
    await engine.produceBlock([makeTx(node, '', 0, 'bisect', { gameId, layerIndex: 0, traceRoot: 'trX' }, 3)], treasury);

    // Honest proof for honest input, but claimed OUTPUT is falsified:
    const layerInput = [0.5, -0.25, 1.0, -1.5, 2.0, -0.75, 0.125, -2.0];
    const { proof, publicSignals } = await proveRelu(layerInput);
    const fakeOutput = new Array(8).fill(9.0); // does not match proof commitment nor WASM

    await engine.produceBlock([makeTx(node, '', 0, 'proveStep', {
      gameId,
      layerWeights: [], layerInput, layerBias: [],
      layerOutput: fakeOutput, actualTraceRoot: 'trX',
      snark: { proofType: 'relu8', proof, publicSignals },
    }, 4)], treasury);

    const resolved = engine.getGame(gameId!);
    assert.strictEqual(resolved?.status, 'resolved_slash', 'forged claim must be slashed');
    assert.strictEqual(resolved?.winner, challenger.address);
  });
});
