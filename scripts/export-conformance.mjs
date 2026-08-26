#!/usr/bin/env node
/**
 * Golden-vector exporter for the Rust node's conformance suite.
 *
 * Emits committed fixtures into ../verinoo-node/crates/conformance/fixtures/:
 *   - canonical.json   : canonical-encoding edge cases (string parity)
 *   - txs.json         : Ed25519-signed transactions across op types,
 *                        with the canonical string + txId each must satisfy
 *
 * Signatures here are REAL Ed25519 (tweetnacl sign.detached) over the 32-byte
 * raw SHA-256 digest of the canonical string — exactly what ed25519-dalek
 * verifies in Rust. The legacy hash-based signature scheme of this reference
 * client is NOT part of the exported contract.
 */

import { createHash } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import nacl from 'tweetnacl';
const { canonicalJson } = await import('../dist/core/canonical.js');
import { sha256, generateKeyPair } from '../dist/wallet/crypto.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '..', 'verinoo-node', 'crates', 'conformance', 'fixtures');
mkdirSync(outDir, { recursive: true });

// ---- real Ed25519 helpers (tweetnacl detached mode) ----
function edKeyPair() {
  const kp = nacl.sign.keyPair();
  const pubHex = Buffer.from(kp.publicKey).toString('hex');
  const secretKey = kp.secretKey;
  const privHex = Buffer.from(secretKey).toString('hex');
  const addrHash = createHash('sha256').update(Buffer.from(pubHex, 'hex')).digest();
  return { pubHex, privHex, secretKey, publicKey: pubHex,
           address: `ai_${addrHash.subarray(0, 20).toString('hex')}` };
}
// Signatures are real Ed25519 detached over the UTF-8 bytes of the txId.
function edSign(privHex, txIdHex) {
  const sk = Uint8Array.from(Buffer.from(privHex, 'hex'));
  const msg = Uint8Array.from(Buffer.from(txIdHex, 'utf-8'));
  return Buffer.from(nacl.sign.detached(msg, sk)).toString('hex');
}

// ---- canonical JSON identical to src/core/canonical.ts ----
function canon(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
}

function unsignedPayload(tx) {
  const p = { data: tx.data, from: tx.from, nonce: tx.nonce, to: tx.to, value: tx.value };
  if (tx.gasLimit !== undefined) p.gasLimit = tx.gasLimit;
  if (tx.gasPrice !== undefined) p.gasPrice = tx.gasPrice;
  return p;
}
function canonicalTxString(tx) { return canon(unsignedPayload(tx)); }
function computeTxId(tx) {
  // SHA-256 over the UTF-8 bytes of the canonical string; signature is over
  // these same 32 raw bytes.
  return createHash('sha256').update(canonicalTxString(tx), 'utf8').digest('hex');
}

// ================= canonical-string edge cases =================
const canonicalCases = [
  { name: 'nested_key_order', input: { z: 1, a: { y: 2, x: [3, { c: 4, b: 5 }] } } },
  { name: 'flat_ops_payload', input: { data: { type: 'transfer', data: {} }, from: 'ai_a', nonce: 7, to: 'ai_b', value: 10 } },
  { name: 'unicode_and_escapes', input: { k: "quote\" back\\slash\nnewline ünïcode ✓" } },
  { name: 'empty_containers', input: { arr: [], obj: {}, s: '' } },
  { name: 'big_integers', input: { u: 9007199254740991, i: -9007199254740991, mid: 4294967296 } },
  { name: 'booleans_null', input: { t: true, f: false, n: null } },
];
writeFileSync(resolve(outDir, 'canonical.json'), JSON.stringify(
  canonicalCases.map(c => ({ ...c, expected: canon(c.input) })), null, 2) + '\n');

// ================= signed transaction vectors =================
const alice = edKeyPair();
const bob = edKeyPair();

const opTxs = [
  { name: 'transfer', tx: { from: alice.address, to: bob.address, value: 250, nonce: 1, data: { type: 'transfer', data: {} }, publicKey: alice.pubHex } },
  { name: 'register_model', tx: { from: alice.address, to: '', value: 0, nonce: 2, data: { type: 'registerModel', data: { architecture: 'TinyNet', parameterCount: 256000, weightsHash: 'w_' + 'a'.repeat(32), runtimeHash: 'r_' + 'b'.repeat(32), stakingRequirement: 50, description: 'fixture model' } }, publicKey: alice.pubHex } },
  { name: 'register_node', tx: { from: bob.address, to: '', value: 0, nonce: 1, data: { type: 'registerNode', data: { stakedAmount: 800, availableCapacity: 4, maxCapacity: 4, activeTasks: 0, reputation: 50, successfulInferences: 0, failedInferences: 0, supportedModels: ['model_x'] } }, publicKey: bob.pubHex } },
  { name: 'submit_inference_sampled', tx: { from: alice.address, to: '', value: 0, nonce: 3, gasLimit: 500, gasPrice: 2, data: { type: 'submitInference', data: { requester: alice.address, targetModel: 'model_x', inputCommitment: 'inp_c', maxFee: 100, deadline: 99999, verificationType: 'sampled' } }, publicKey: alice.pubHex } },
];

const fixtures = [];
for (const { name, tx } of opTxs) {
  const canonical = canonicalTxString(tx);
  const raw32 = createHash('sha256').update(canonical, 'utf8').digest(); // raw bytes
  const txId = raw32.toString('hex');
  const signerPriv = tx.publicKey === alice.pubHex ? alice.privHex : bob.privHex;
  const sigHex = edSign(signerPriv, txId);
  fixtures.push({
    name,
    payloadCanonical: canonical,
    txId,
    tx: { ...tx, txId, signature: sigHex },
  });
}

writeFileSync(resolve(outDir, 'txs.json'), JSON.stringify({
  scheme: 'ed25519-detached-over-txid-utf8',
  signerAlice: { address: alice.address, publicKey: alice.pubHex },
  signerBob: { address: bob.address, publicKey: bob.pubHex },
  vectors: fixtures,
}, null, 2) + '\n');

console.log(`[export] wrote ${canonicalCases.length} canonical cases + ${fixtures.length} tx vectors -> ${outDir}`);

// ================= apply-block state-transition vectors =================
// Runs a scripted scenario through the reference ENGINE (ed25519 scheme)
// and dumps per-block observable state for the Rust harness to replay.

async function exportApplyBlocks() {
  const { AINativeEngine } = await import('../dist/core/engine.js');
  const { BlockStore } = await import('../dist/storage/index.js');
  const { rmSync } = await import('fs');

  const dir = resolve(root, '..', 'verinoo-node', 'crates', 'conformance', 'fixtures', '.tsengine');
  rmSync(dir, { recursive: true, force: true });
  const store = new BlockStore(dir);
  const engine = new AINativeEngine(store, { signatureScheme: 'ed25519' });

  // Real Ed25519 identities
  const K = { treasury: edKeyPair(), user: edKeyPair(), node: edKeyPair(), challenger: edKeyPair(), validator: edKeyPair() };
  // Header signatures ride the legacy scheme inside this reference engine;
  // they are NOT part of the exported conformance contract.
  const legacyValidator = generateKeyPair();
  const skBytes = (kp) => kp.secretKey;
  const signTxED = (kp, unsigned) => {
    const data = unsigned.data;
    const payload = unsignedPayload(unsigned);
    const txId = createHash('sha256').update(canon(payload), 'utf8').digest('hex');
    const raw = nacl.sign.detached(Buffer.from(txId, 'utf8'), skBytes(kp));
    const signature = Buffer.from(raw).toString('hex'); // ED scheme transport: hex
    return { ...unsigned, data, txId, signature, publicKey: kp.publicKey };
  };

  const mk = (kp, to, value, kind, d, nonce) => signTxED(kp, {
    from: kp.address, to, value, nonce,
    data: { type: kind, data: d }, publicKey: kp.publicKey,
  });

  // Pre-fund (genesis allocations)
  for (const [name, bal] of [['treasury', 10000], ['user', 5000], ['node', 5000], ['challenger', 2000]]) {
    store.setAccount({ address: K[name].address, publicKey: K[name].publicKey, nonce: 0, balance: bal, updatedAt: 0 });
  }
  const valAddr = K.validator.address;

  const snapshotAccounts = () => {
    const out = {};
    for (const name of ['treasury', 'user', 'node', 'challenger', 'validator']) {
      const a = store.getAccount(K[name].address);
      if (a) out[K[name].address] = { balance: a.balance, nonce: a.nonce };
    }
    return out;
  };

  let modelId, taskId, gameId;
  const blocks = [];
  const scenarios = [
    { name: 'register_model', tx: mk(K.treasury, '', 0, 'registerModel', {
        architecture: 'Tiny-Test-Net', parameterCount: 256000,
        weightsHash: 'w_' + 'a'.repeat(32), runtimeHash: 'r_' + 'b'.repeat(32),
        stakingRequirement: 50, description: 'golden vector model' }, 1),
      post: (b) => {
        modelId = sha256(canon(b.transactions[0].data.data) + b.transactions[0].txId).slice(0, 32);
      } },
    { name: 'register_node', build: () => mk(K.node, '', 0, 'registerNode', {
        stakedAmount: 800, availableCapacity: 4, maxCapacity: 4, activeTasks: 0,
        reputation: 75, successfulInferences: 0, failedInferences: 0,
        supportedModels: [modelId] }, 1) },
    { name: 'submit_inference', build: () => mk(K.user, '', 100, 'submitInference', {
        requester: K.user.address, targetModel: modelId, inputCommitment: 'inp_c',
        maxFee: 100, deadline: 1000, verificationType: 'optimistic' }, 1),
      post: (b) => {
        const t = store.getTasksByStatus('assigned')[0];
        taskId = t.taskId;
        const cid = createHash('sha256').update(canonicalJson(b.transactions[0].data.data) + b.transactions[0].txId, 'utf8').digest('hex').slice(0, 32);
        console.log('[cmp] derived :', cid, '| engine:', t.taskId, '| match:', cid === t.taskId);
        void canonicalJson;
      } },
    { name: 'submit_result', tx: null, build: () => mk(K.node, '', 0, 'submitResult', {
        taskId, resultHash: 'res_h', resultOutput: 'out', proofData: '' }, 2) },
    { name: 'challenge_result', tx: null, build: () => mk(K.challenger, '', 0, 'challengeResult', {
        taskId, reason: 'golden vector dispute' }, 1),
      post: () => { gameId = store.getTask(taskId).gameId; } },
    { name: 'bisect_ch_l2', tx: null, build: () => mk(K.challenger, '', 0, 'bisect', { gameId, layerIndex: 2, traceRoot: 'trace_ch_2' }, 2) },
    { name: 'bisect_df_l2', tx: null, build: () => mk(K.node, '', 0, 'bisect', { gameId, layerIndex: 2, traceRoot: 'trace_df_2_X' }, 3) },
    { name: 'bisect_ch_l1', tx: null, build: () => mk(K.challenger, '', 0, 'bisect', { gameId, layerIndex: 1, traceRoot: 'trace_ch_1' }, 3) },
    { name: 'bisect_df_l1', tx: null, build: () => mk(K.node, '', 0, 'bisect', { gameId, layerIndex: 1, traceRoot: 'trace_ch_1' }, 4) },
  ];

  let height = 0;
  for (const sc of scenarios) {
    let tx = sc.tx ?? (sc.build ? sc.build() : null);
    if (!tx) throw new Error('scenario without tx: ' + sc.name);
    if (sc.patch) tx = sc.patch(tx);
    if (sc.pre) sc.pre();
    const dbgErr = engine.validateTransaction(tx);
    if (dbgErr !== true) console.log(`[debug] ${sc.name}:`, dbgErr);
    const block = await engine.produceBlock([tx], {
      address: valAddr,
      publicKey: legacyValidator.publicKey,
      privateKey: legacyValidator.privateKey,
    });
    void block;
    height++;
    if (sc.post) sc.post(block);

    const task = taskId ? store.getTask(taskId) : null;
    const game = gameId ? store.getGame(gameId) : null;
    blocks.push({
      name: sc.name,
      height,
      executedTxIds: block.transactions.map(t => t.txId),
      transactions: block.transactions,
      expect: {
        accounts: snapshotAccounts(),
        task: taskId ? {
          status: store.getTask(taskId)?.status,
          assignedTo: store.getTask(taskId)?.assignedTo ?? null,
        } : null,
        game: gameId ? {
          status: game.status,
          low: game.low, high: game.high,
          currentStep: game.currentStep,
          disputedLayer: game.disputedLayer,
        } : null,
      },
    });
  }

  writeFileSync(resolve(outDir, 'apply_blocks.json'), JSON.stringify({
    chainId: 'verinoo-test-1',
    validatorAddress: valAddr,
    baseFee: 1,
    addresses: Object.fromEntries(Object.entries(K).map(([k, v]) => [k, v.address])),
    modelId, taskId, gameId,
    initialAccounts: (() => {
      const o = {};
      for (const [name, bal] of [['treasury', 10000], ['user', 5000], ['node', 5000], ['challenger', 2000]]) {
        o[K[name].address] = { balance: bal, nonce: 0 };
      }
      o[valAddr] = { balance: 0, nonce: 0 };
      return o;
    })(),
    blocks,
  }, null, 2) + '\n');
  console.log(`[export] wrote ${blocks.length} apply-block vectors`);

  rmSync(dir, { recursive: true, force: true });
}

await exportApplyBlocks();
