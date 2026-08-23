import { test, describe } from 'node:test';
import assert from 'node:assert';
import { signMessage, verifySignature, generateKeyPair } from './crypto';

describe('generateKeyPair + signMessage roundtrip in isolation', () => {
  test('basic roundtrip', () => {
    const kp = generateKeyPair();
    const msg = 'hello';
    const sig = signMessage(msg, kp.privateKey);
    const ok = verifySignature(msg, sig, kp.publicKey);
    assert.strictEqual(ok, true);
  });

  test('makeTx-like flow', () => {
    const crypto = require('crypto');
    const kp = generateKeyPair();
    const txBase: any = { 
      txId: '', from: kp.address, to: '', value: 0, nonce: 1,
      data: { type: 'test', data: {} }, publicKey: kp.publicKey, signature: ''
    };
    txBase.txId = crypto.createHash('sha256').update(JSON.stringify({ 
      type: 'test', data: {}, from: kp.address, nonce: 1 
    })).digest('hex').substring(0, 32);
    txBase.signature = signMessage(txBase.txId, kp.privateKey);
    const ok = verifySignature(txBase.txId, txBase.signature, kp.publicKey);
    assert.strictEqual(ok, true);
  });
});
