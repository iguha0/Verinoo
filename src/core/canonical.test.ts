import { test, describe } from 'node:test';
import assert from 'node:assert';
import { signTransaction, computeTxId, canonicalJson, canonicalTxIdOf } from './canonical';
import { generateKeyPair, verifySignature } from '../wallet/crypto';

describe('Canonical transaction signing', () => {
  test('key order never affects txId', () => {
    const kp = generateKeyPair();
    const a = signTransaction({ from: kp.address, to: 'x', value: 5, nonce: 1, data: { type: 'transfer', data: { b: 2, a: 1 } }, publicKey: kp.publicKey }, kp.privateKey);
    // same content, different insertion order in nested data
    const b = signTransaction({ nonce: 1, value: 5, to: 'x', from: kp.address, data: { data: { a: 1, b: 2 }, type: 'transfer' }, publicKey: kp.publicKey }, kp.privateKey);
    assert.strictEqual(a.txId, b.txId);
    assert.strictEqual(canonicalJson({ z: 1, a: { y: 2, x: [3, { c: 4, b: 5 }] } }), '{"a":{"x":[3,{"b":5,"c":4}],"y":2},"z":1}');
  });

  test('tampering with any content field invalidates the id', () => {
    const kp = generateKeyPair();
    const tx = signTransaction({ from: kp.address, to: 'bob', value: 10, nonce: 1, data: { type: 'transfer', data: {} }, publicKey: kp.publicKey }, kp.privateKey);
    for (const mutated of [
      { ...tx, to: 'eve' },
      { ...tx, value: 1000 },
      { ...tx, nonce: 2 },
      { ...tx, data: { type: 'transfer', data: { steal: true } } },
      { ...tx, gasLimit: 999999 },
    ]) {
      assert.notStrictEqual(computeTxId({
        data: mutated.data, from: mutated.from, nonce: mutated.nonce,
        to: mutated.to, value: mutated.value,
        ...(mutated.gasLimit !== undefined ? { gasLimit: mutated.gasLimit } : {}),
      } as any), tx.txId, `mutation must change required txId: ${JSON.stringify(mutated)}`);
      assert.strictEqual(canonicalTxIdOf(mutated) === tx.txId, false);
    }
  });

  test('signature covers contents: swapped recipient fails engine-style checks', () => {
    const kp = generateKeyPair();
    const tx = signTransaction({ from: kp.address, to: 'bob', value: 10, nonce: 1, data: { type: 'transfer', data: {} }, publicKey: kp.publicKey }, kp.privateKey);
    // signature is over original txId; redirecting payment keeps sig "valid" but breaks binding
    const redirected = { ...tx, to: 'attacker' };
    assert.ok(verifySignature(tx.txId, redirected.signature, redirected.publicKey), 'sig itself still verifies');
    assert.notStrictEqual(canonicalTxIdOf(redirected), redirected.txId, 'but canonical binding exposes malleation');
  });
});
