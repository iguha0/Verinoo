/**
 * Gas Market for AI-Native Chain
 *
 * Implements EIP-1559-style baseFee targeting:
 *   - Per-op gas costs
 *   - baseFee adjusts +/-12.5% per block based on block fill ratio
 *   - 25% of fees burned to treasury, 75% to validator
 *   - Sustainable node economics: validators earn gas + block rewards
 */

import { Transaction } from './types';

const GAS_TABLE: Record<string, number> = {
  registerNode: 50_000,
  registerModel: 80_000,
  registerAgent: 50_000,
  submitInference: 60_000,
  submitResult: 40_000,
  challengeResult: 120_000,
  bisect: 100_000,
  proveStep: 80_000,
  agentPayment: 50_000,
  transfer: 50_000,
};

const BLOCK_GAS_TARGET = 500_000;
const BLOCK_GAS_LIMIT = 1_000_000;
const BASE_FEE_DENOM = 8; // EIP-1559 elasticity
const MAX_BASE_FEE_CHANGE = 12.5; // max +/- 12.5%

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export function gasCostFor(tx: Transaction): number {
  return GAS_TABLE[tx.data.type] || 50_000;
}

export function computeBaseFee(prevBaseFee: number, gasUsed: number): number {
  const change = (gasUsed - BLOCK_GAS_TARGET) / BLOCK_GAS_TARGET;
  const delta = prevBaseFee * change / BASE_FEE_DENOM;
  const rate = clamp(1 + delta / prevBaseFee, 1 - MAX_BASE_FEE_CHANGE / 100, 1 + MAX_BASE_FEE_CHANGE / 100);
  return Math.max(1, Math.round(prevBaseFee * rate));
}

export function distributeFees(validator: string, totalFee: number, store: any): void {
  const burned = Math.floor(totalFee * 0.25);
  const reward = totalFee - burned;

  // Burn to treasury
  const treasury = store.getAccount('treasury') || { address: 'treasury', publicKey: '', nonce: 0, balance: 0, updatedAt: 0 };
  treasury.balance += burned;
  store.setAccount(treasury);

  // Validator reward
  const valAcc = store.getAccount(validator) || { address: validator, publicKey: '', nonce: 0, balance: 0, updatedAt: 0 };
  valAcc.balance += reward;
  valAcc.updatedAt = store.getChainHeight ? store.getChainHeight() : 0;
  store.setAccount(valAcc);
}

export function isWithinGasLimit(txs: Transaction[]): boolean {
  const total = txs.reduce((s, t) => s + gasCostFor(t), 0);
  return total <= BLOCK_GAS_LIMIT;
}
