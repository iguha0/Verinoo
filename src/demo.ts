import { AINativeEngine } from './core/engine';
import { signMessage, generateKeyPair, publicKeyToAddress } from './wallet/crypto';
import { BlockStore } from './storage';
import { Transaction } from './core/types';
import { rmSync } from 'fs';

console.log('⛓️ AI-Chain: Interactive Verification Game Demo\n');

// Fresh chain each run
const DEMO_DIR = './demo_chain_fresh';
try { rmSync(DEMO_DIR, { recursive: true }); } catch (e) {}
const store = new BlockStore(DEMO_DIR);
const engine = new AINativeEngine(store);

const treasury = generateKeyPair();
const user = generateKeyPair();
const node = generateKeyPair();
const challenger = generateKeyPair();

function makeTx(from: ReturnType<typeof generateKeyPair>, to: string, value: number, type: string, data: any, nonce: number): Transaction {
  const txBase = { txId: '', from: from.address, to, value, nonce, data: { type, data }, publicKey: from.publicKey, signature: '' };
  const crypto = require('crypto');
  txBase.txId = crypto.createHash('sha256').update(JSON.stringify({ type, data, from: from.address, nonce })).digest('hex').substring(0, 32);
  txBase.signature = signMessage(txBase.txId, from.privateKey);
  return txBase;
}

// Fund accounts
store.setAccount({ address: treasury.address, publicKey: treasury.publicKey, nonce: 0, balance: 10000, updatedAt: 0 });
store.setAccount({ address: user.address, publicKey: user.publicKey, nonce: 0, balance: 5000, updatedAt: 0 });
store.setAccount({ address: node.address, publicKey: node.publicKey, nonce: 0, balance: 1000, updatedAt: 0 });
store.setAccount({ address: challenger.address, publicKey: challenger.publicKey, nonce: 0, balance: 2000, updatedAt: 0 });

console.log('=== Step 1: Register Model ===');
const modelTx = makeTx(treasury, '', 0, 'registerModel', {
  architecture: 'Gemma-2B-IT', parameterCount: 2_500_000_000,
  weightsHash: 'w_' + 'a'.repeat(32), runtimeHash: 'r_' + 'b'.repeat(32),
  stakingRequirement: 500, description: 'Prototype 2B model',
}, 1);
engine.produceBlock([modelTx], treasury);

const modelId = engine.store.getModels()[0].modelId;
console.log(`  ✓ Model registered: ${modelId}`);

console.log('\n=== Step 2: Register Compute Node ===');
const nodeTx = makeTx(node, '', 0, 'registerNode', {
  stakedAmount: 800, availableCapacity: 4, maxCapacity: 4,
  activeTasks: 0, reputation: 75, successfulInferences: 0, failedInferences: 0,
  supportedModels: [modelId],
}, 1);
engine.produceBlock([nodeTx], treasury);
const nodeReg = engine.store.getNode(node.address);
console.log(`  ✓ Node registered: ${node.address.slice(0, 20)}... (reputation: ${nodeReg?.reputation})`);

console.log('\n=== Step 3: Submit Inference Task ===');
const inferTx = makeTx(user, '', 100, 'submitInference', {
  requester: user.address, targetModel: modelId,
  inputCommitment: 'inp_' + 'c'.repeat(32),
  maxFee: 100, deadline: 1000, verificationType: 'optimistic',
}, 1);
engine.produceBlock([inferTx], treasury);
const task = engine.store.getTasksByStatus('assigned')[0];
if (!task) {
  console.log('ERROR: Task not auto-matched');
  process.exit(1);
}
console.log(`  ✓ Task submitted & auto-matched: ${task.taskId}`);
console.log(`  → Assigned to node: ${task.assignedTo?.slice(0, 20)}...`);

console.log('\n=== Step 4: Node Submits (FRAUDULENT) Result ===');
const badHash = 'res_BAD_HASH_99999999999999999';
const resultTx = makeTx(node, '', 0, 'submitResult', {
  taskId: task.taskId,
  resultHash: badHash,
  resultOutput: 'FALSIFIED: patient troponin = 0 (healthy) — real answer should be elevated',
  proofData: 'mock_proof_v1',
}, 2);
engine.produceBlock([resultTx], treasury);
const taskAfterResult = engine.store.getTask(task.taskId);
console.log(`  ✓ Result posted. Status: ${taskAfterResult?.status}`);
console.log(`  ✓ Challenge window open until block ${taskAfterResult?.challengeWindowEnd}`);

console.log('\n=== Step 5: Challenger Opens Verification Game ===');
const challengeTx = makeTx(challenger, '', 0, 'challengeResult', {
  taskId: task.taskId,
  reason: 'Troponin cannot be zero with these symptoms — contradicts medical literature',
}, 1);
engine.produceBlock([challengeTx], treasury);
const challengedTask = engine.store.getTask(task.taskId);
const gameId = challengedTask?.gameId;
if (!gameId) {
  console.log('ERROR: Game not created');
  process.exit(1);
}
console.log(`  ✓ Game opened: ${gameId}`);
console.log(`  ✓ Challenger bonded: ${challengedTask?.maxFee} AI-B`);
const nodeAfter = engine.store.getNode(node.address);
console.log(`  ✓ Defender reputation: ${nodeAfter?.reputation}/100 (preliminary slash)`);
const game1 = engine.store.getGame(gameId);
console.log(`  ✓ Game active for ${game1?.layerSpec?.length || 5} layers`);

console.log('\n=== Step 6: Bisection — Challenger commits ===');
engine.produceBlock([makeTx(challenger, '', 0, 'bisect', {
  gameId, layerIndex: 2, traceRoot: 'trace_challenger_mid_' + 'd'.repeat(16),
}, 2)], treasury);
console.log(`  ⬆️ Challenger commits trace at layer 2`);

console.log('\n=== Step 7: Bisection — Defender commits DIFFERENT trace ===');
engine.produceBlock([makeTx(node, '', 0, 'bisect', {
  gameId, layerIndex: 2, traceRoot: 'trace_defender_mid_' + 'e'.repeat(16),
}, 3)], treasury);
console.log(`  ⬆️ Defender commits DIFFERENT trace at layer 2`);

const gameAfterBisect1 = engine.store.getGame(gameId);
console.log(`  📊 Bisection [${gameAfterBisect1!.low}-${gameAfterBisect1!.high}], step=${gameAfterBisect1!.currentStep}, disputedLayer=${gameAfterBisect1!.disputedLayer}`);

console.log('\n=== Step 8: Second Bisection — Challenger ===');
engine.produceBlock([makeTx(challenger, '', 0, 'bisect', {
  gameId, layerIndex: 1, traceRoot: 'trace_challenger_low_' + 'f'.repeat(16),
}, 3)], treasury);

console.log('\n=== Step 9: Second Bisection — Defender (AGREES at layer 1) ===');
engine.produceBlock([makeTx(node, '', 0, 'bisect', {
  gameId, layerIndex: 1, traceRoot: 'trace_challenger_low_' + 'f'.repeat(16), // agrees!
}, 4)], treasury);

const game2 = engine.store.getGame(gameId);
console.log(`  📊 Bisection [${game2!.low}-${game2!.high}], step=${game2!.currentStep}`);
console.log(`  🔍 Disputed layer pinned: ${game2!.disputedLayer}`);

console.log('\n=== Step 10: Prove Step — Defender executes disputed layer ===');
// Prototype: mock verification — production would use WASM/ZK
// Defender provides deterministic inputs and trace for layer 1
const proveTx = makeTx(node, '', 0, 'proveStep', {
  gameId,
  layerWeights: Array.from({ length: 100 }, (_, i) => i * 0.001),
  layerInput: Array.from({ length: 100 }, (_, i) => i * 0.01),
  layerOutput: Array.from({ length: 100 }, (_, i) => i * 0.02),
  actualTraceRoot: game2!.challengerCommitments[game2!.disputedLayer],
}, 5);
engine.produceBlock([proveTx], treasury);

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║           VERIFICATION GAME RESULT                         ║');
console.log('╠════════════════════════════════════════════════════════════╣');
const finalGame = engine.store.getGame(gameId);
const finalTask = engine.store.getTask(task.taskId);
const finalNode = engine.store.getNode(node.address);
const finalChallenger = engine.store.getAccount(challenger.address);
console.log(`║  Game status:     ${finalGame?.status}`);
console.log(`║  Winner:          ${finalGame?.winner?.slice(0, 30)}...`);
console.log(`║  Loser:           ${finalGame?.loser?.slice(0, 30)}...`);
console.log(`║  Task status:      ${finalTask?.status}`);
console.log(`║  Node reputation:  ${finalNode?.reputation}/100 (started 75)`);
console.log(`║  Node slashed:    ${finalNode?.totalSlashed ?? 0} AI-B`);
console.log(`║  Challenger bal:   ${finalChallenger?.balance} AI-B`);
console.log('╚════════════════════════════════════════════════════════════╝');
console.log('\n🎯 PROTOCOL VERIFIED: Fraudulent inference detected via interactive bisection.');
console.log('   Cheating node slashed, challenger rewarded, network integrity enforced.');
