/**
 * Fork Resolution: Longest-Chain Rule
 *
 * Maintains an in-memory fork tree. When a competing block is received:
 *   1. Store it (BlockStore now saves blocks indexed by both height and hash)
 *   2. Walk back from the new block to genesis, computing total "weight"
 *      – weight = sum of all block hashes as hex numbers (proxy for work)
 *   3. If new branch weight > current branch weight:
 *      - Reorg: rollback state to fork point, replay txs from new branch
 *   4. Update head to the heavier block
 *
 * This is a simplified Nakamoto-style fork rule. In production, use actual
 * total difficulty or proof-of-work / proof-of-stake weight.
 */

import { Block } from './types';

type StoreLike = {
  getBlocksAtHeight(h: number): Block[];
};

function hashWeight(hex: string): bigint {
  const safe = /^[0-9a-fA-F]+$/.test(hex) ? hex : Buffer.from(hex).toString('hex');
  return BigInt('0x' + safe.slice(0, 16));
}

export function computeChainWeight(startBlock: Block, store: StoreLike): bigint {
  let weight = hashWeight(startBlock.header.hash);
  let current: Block | undefined = startBlock;
  while (current && current.header.index > 0) {
    const all = store.getBlocksAtHeight(current.header.index - 1);
    const prev = all.find(b => b.header.hash === current!.header.previousHash);
    if (!prev) break;
    weight += hashWeight(prev.header.hash);
    current = prev;
  }
  return weight;
}

export function getCommonAncestor(a: Block, b: Block, store: StoreLike): Block | undefined {
  let ha = a.header.index;
  let hb = b.header.index;
  let blockA: Block | undefined = a;
  let blockB: Block | undefined = b;

  while (blockA && blockB && blockA.header.hash !== blockB.header.hash) {
    if (ha > hb) {
      const all = store.getBlocksAtHeight(blockA.header.index - 1);
      blockA = all.find(x => x.header.hash === blockA!.header.previousHash);
      ha--;
    } else {
      const all = store.getBlocksAtHeight(blockB.header.index - 1);
      blockB = all.find(x => x.header.hash === blockB!.header.previousHash);
      hb--;
    }
  }
  return blockA;
}

export interface ReorgPlan {
  forkPoint: Block;
  blocksToUndo: Block[];
  blocksToApply: Block[];
}

export function planReorg(currentHead: Block, newHead: Block, store: StoreLike): ReorgPlan {
  const forkPoint = getCommonAncestor(currentHead, newHead, store)!;
  const blocksToUndo: Block[] = [];
  let cursor: Block | undefined = currentHead;
  while (cursor && cursor.header.hash !== forkPoint.header.hash) {
    blocksToUndo.push(cursor);
    const all = store.getBlocksAtHeight(cursor.header.index - 1);
    cursor = all.find(b => b.header.hash === cursor!.header.previousHash);
  }
  const blocksToApply: Block[] = [];
  cursor = newHead;
  while (cursor && cursor.header.hash !== forkPoint.header.hash) {
    blocksToApply.unshift(cursor);
    const all = store.getBlocksAtHeight(cursor.header.index - 1);
    cursor = all.find(b => b.header.hash === cursor!.header.previousHash);
  }
  return { forkPoint, blocksToUndo, blocksToApply };
}

export function resolveFork(
  currentHead: Block | undefined,
  newBlock: Block,
  store: StoreLike
): { reorged: boolean; newHead: Block } {
  if (!currentHead) return { reorged: false, newHead: newBlock };
  if (newBlock.header.index === 0) return { reorged: false, newHead: currentHead };
  if (currentHead.header.hash === newBlock.header.previousHash) return { reorged: false, newHead: newBlock };
  if (currentHead.header.index >= newBlock.header.index) return { reorged: false, newHead: currentHead };

  const currentWeight = computeChainWeight(currentHead, store);
  const newWeight = computeChainWeight(newBlock, store);

  return newWeight > currentWeight
    ? { reorged: true, newHead: newBlock }
    : { reorged: false, newHead: currentHead };
}
