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
import { sha256 } from '../dist/wallet/crypto.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '..', 'verinoo-node', 'crates', 'conformance', 'fixtures');
mkdirSync(outDir, { recursive: true });

// ---- real Ed25519 helpers (tweetnacl detached mode) ----
function edKeyPair() {
  const kp = nacl.sign.keyPair();
  const pubHex = Buffer.from(kp.publicKey).toString('hex');
  const privHex = Buffer.from(kp.secretKey).toString('hex');
  const addrHash = createHash('sha256').update(Buffer.from(pubHex, 'hex')).digest();
  return { pubHex, privHex, address: `ai_${addrHash.subarray(0, 20).toString('hex')}` };
}
function edSign(privHex, messageBytes) {
  const sk = Uint8Array.from(Buffer.from(privHex, 'hex'));
  return Buffer.from(nacl.sign.detached(Uint8Array.from(messageBytes), sk)).toString('hex');
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
  const sigHex = edSign(signerPriv, [...raw32]);
  fixtures.push({
    name,
    payloadCanonical: canonical,
    txId,
    signatureOverHex: raw32.toString('hex'),
    tx: { ...tx, txId, signature: sigHex },
  });
}

writeFileSync(resolve(outDir, 'txs.json'), JSON.stringify({
  scheme: 'ed25519-detached-over-sha256-canonical-string',
  signerAlice: { address: alice.address, publicKey: alice.pubHex },
  signerBob: { address: bob.address, publicKey: bob.pubHex },
  vectors: fixtures,
}, null, 2) + '\n');

console.log(`[export] wrote ${canonicalCases.length} canonical cases + ${fixtures.length} tx vectors -> ${outDir}`);
