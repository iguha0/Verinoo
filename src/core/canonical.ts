/**
 * Canonical transaction serialization + signing scheme. SPEC MODULE.
 *
 * A transaction is only valid if:
 *   1. txId === sha256(canonicalString(unsignedPayload))
 *   2. signature verifies over txId with tx.publicKey
 *
 * unsignedPayload fields (exactly these, nothing else):
 *   { data, from, gasLimit?, gasPrice?, nonce, to, value }
 *   - gasLimit/gasPrice included only when defined
 *   - `to` may be '' for protocol ops
 *
 * canonicalString: JSON.stringify with object keys recursively sorted
 * lexicographically and no whitespace. Two JS objects with identical
 * content always produce identical strings regardless of insertion order.
 */

import { sha256, signMessage } from '../wallet/crypto';
import { Transaction } from '../core/types';

/** Recursively sort object keys; returns a JSON string with no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export interface UnsignedPayload {
  data: unknown;
  from: string;
  nonce: number;
  to: string;
  value: number;
  gasLimit?: number;
  gasPrice?: number;
}

/** Extract the exact unsigned payload fields from a full transaction. */
export function unsignedPayloadOf(tx: Partial<Transaction>): UnsignedPayload {
  const payload: UnsignedPayload = {
    data: tx.data,
    from: tx.from as string,
    nonce: tx.nonce as number,
    to: tx.to as string,
    value: tx.value as number,
  };
  if (tx.gasLimit !== undefined) payload.gasLimit = tx.gasLimit;
  if (tx.gasPrice !== undefined) payload.gasPrice = tx.gasPrice;
  return payload;
}

/** The canonical string that MUST hash to tx.txId. */
export function canonicalTxString(tx: Partial<Transaction>): string {
  return canonicalJson(unsignedPayloadOf(tx));
}

/** The txId a transaction's contents are required to produce. */
export function canonicalTxIdOf(tx: Partial<Transaction>): string {
  return sha256(canonicalJson(unsignedPayloadOf(tx)));
}

/** Compute the correct txId for an unsigned payload. */
export function computeTxId(payload: UnsignedPayload): string {
  return sha256(canonicalJson(payload));
}

/**
 * Fill in txId + signature for a fully-populated unsigned transaction.
 * The single sanctioned way to build a signed transaction anywhere in the
 * codebase (tests included).
 */
export function signTransaction(
  tx: Omit<Transaction, 'txId' | 'signature'>,
  privateKey: string
): Transaction {
  const payload = unsignedPayloadOf(tx);
  const txId = computeTxId(payload);
  const signature = signMessage(txId, privateKey);
  return { ...tx, txId, signature } as Transaction;
}
