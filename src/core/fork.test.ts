import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Block, BlockHeader, Transaction } from './types';
import { resolveFork, getCommonAncestor, planReorg, computeChainWeight } from './fork';
import { sha256 } from '../wallet/crypto';

function mkHeader(idx: number, prev: string, hashOverride?: string): BlockHeader {
  const h: BlockHeader = {
    hash: '', version: 1, index: idx, timestamp: idx,
    previousHash: prev, validator: 'val', validatorPubKey: '', validatorSignature: '',
    stateRoot: sha256(`state-${idx}`), txRoot: sha256(`tx-${idx}`),
    inferenceTasksRoot: sha256(`inf-${idx}`), computeRoot: sha256(`comp-${idx}`),
  };
  h.hash = hashOverride ?? sha256(JSON.stringify({ i: idx, p: prev, s: h.stateRoot }));
  return h;
}
function mkBlock(idx: number, prev: string, hashOverride?: string, txs?: Transaction[]): Block {
  return { header: mkHeader(idx, prev, hashOverride), transactions: txs ?? [] };
}

class MockStore {
  blocks = new Map<string, Block>();
  byHeight = new Map<number, Block[]>();

  save(b: Block) {
    this.blocks.set(b.header.hash, b);
    const arr = this.byHeight.get(b.header.index) ?? [];
    if (!arr.find(x => x.header.hash === b.header.hash)) arr.push(b);
    this.byHeight.set(b.header.index, arr);
  }
  getBlocksAtHeight(h: number): Block[] {
    return this.byHeight.get(h) ?? [];
  }
}

describe('resolveFork', () => {
  test('linear extension — no fork', () => {
    const store = new MockStore();
    const g = mkBlock(0, '0'.repeat(64), 'genesis');
    const a1 = mkBlock(1, g.header.hash, 'a1');
    store.save(g); store.save(a1);

    const r = resolveFork(g, a1, store);
    assert.strictEqual(r.reorged, false);
    assert.strictEqual(r.newHead.header.hash, 'a1');
  });

  test('competing forks of equal length — no reorg', () => {
    const store = new MockStore();
    const g = mkBlock(0, '0'.repeat(64), 'genesis');
    const a1 = mkBlock(1, g.header.hash, 'a1');
    const b1 = mkBlock(1, g.header.hash, 'b1');
    store.save(g); store.save(a1); store.save(b1);

    const r = resolveFork(a1, b1, store);
    // No reorg because a1 already the head; b1 equal weight
    assert.strictEqual(r.reorged, false);
    assert.strictEqual(r.newHead.header.hash, 'a1');
  });

  test('heavier chain triggers reorg', () => {
    const store = new MockStore();
    const g = mkBlock(0, '0'.repeat(64), 'genesis');
    const a1 = mkBlock(1, g.header.hash, 'a1');
    const a2 = mkBlock(2, a1.header.hash, 'a2');
    const b1 = mkBlock(1, g.header.hash, 'b1');
    const b2 = mkBlock(2, b1.header.hash, 'b2');
    const b3 = mkBlock(3, b2.header.hash, 'b3'); // heavier branch
    store.save(g); store.save(a1); store.save(a2); store.save(b1); store.save(b2); store.save(b3);

    const r = resolveFork(a2, b3, store);
    assert.strictEqual(r.reorged, true);
    assert.strictEqual(r.newHead.header.hash, 'b3');
  });

  test('shorter block does not replace longer head', () => {
    const store = new MockStore();
    const g = mkBlock(0, '0'.repeat(64), 'genesis');
    const a1 = mkBlock(1, g.header.hash, 'a1');
    const a2 = mkBlock(2, a1.header.hash, 'a2');
    const b1 = mkBlock(1, g.header.hash, 'b1');
    store.save(g); store.save(a1); store.save(a2); store.save(b1);

    const r = resolveFork(a2, b1, store);
    assert.strictEqual(r.reorged, false);
    assert.strictEqual(r.newHead.header.hash, 'a2');
  });
});

describe('getCommonAncestor', () => {
  test('same branch returns fork point', () => {
    const store = new MockStore();
    const g = mkBlock(0, '0'.repeat(64), 'genesis');
    const a1 = mkBlock(1, g.header.hash, 'a1');
    const a2 = mkBlock(2, a1.header.hash, 'a2');
    store.save(g); store.save(a1); store.save(a2);

    const ca = getCommonAncestor(a1, a2, store);
    assert.ok(ca);
    assert.strictEqual(ca.header.hash, 'a1');
  });

  test('diverged branches find genesis', () => {
    const store = new MockStore();
    const g = mkBlock(0, '0'.repeat(64), 'genesis');
    const a1 = mkBlock(1, g.header.hash, 'a1');
    const a2 = mkBlock(2, a1.header.hash, 'a2');
    const b1 = mkBlock(1, g.header.hash, 'b1');
    const b2 = mkBlock(2, b1.header.hash, 'b2');
    store.save(g); store.save(a1); store.save(a2); store.save(b1); store.save(b2);

    const ca = getCommonAncestor(a2, b2, store);
    assert.ok(ca);
    assert.strictEqual(ca.header.hash, 'genesis');
  });

  test('asymmetric heights find ancestor', () => {
    const store = new MockStore();
    const g = mkBlock(0, '0'.repeat(64), 'genesis');
    const a1 = mkBlock(1, g.header.hash, 'a1');
    const a2 = mkBlock(2, a1.header.hash, 'a2');
    const a3 = mkBlock(3, a2.header.hash, 'a3');
    const b1 = mkBlock(1, a1.header.hash, 'b1'); // forks at a1
    store.save(g); store.save(a1); store.save(a2); store.save(a3); store.save(b1);

    const ca = getCommonAncestor(a3, b1, store);
    assert.ok(ca);
    assert.strictEqual(ca.header.hash, 'a1');
  });
});

describe('planReorg', () => {
  test('undo 2, apply 2', () => {
    const store = new MockStore();
    const g = mkBlock(0, '0'.repeat(64), 'genesis');
    const a1 = mkBlock(1, g.header.hash, 'a1');
    const a2 = mkBlock(2, a1.header.hash, 'a2');
    const b1 = mkBlock(1, g.header.hash, 'b1');
    const b2 = mkBlock(2, b1.header.hash, 'b2');
    const b3 = mkBlock(3, b2.header.hash, 'b3');
    [g, a1, a2, b1, b2, b3].forEach(b => store.save(b));

    const plan = planReorg(a2, b3, store);
    assert.strictEqual(plan.forkPoint.header.hash, 'genesis');
    assert.deepStrictEqual(plan.blocksToUndo.map(b => b.header.hash), ['a2', 'a1']);
    assert.deepStrictEqual(plan.blocksToApply.map(b => b.header.hash), ['b1', 'b2', 'b3']);
  });

  test('same head yields empty plan', () => {
    const store = new MockStore();
    const g = mkBlock(0, '0'.repeat(64), 'genesis');
    const a1 = mkBlock(1, g.header.hash, 'a1');
    store.save(g); store.save(a1);

    const plan = planReorg(a1, a1, store);
    assert.strictEqual(plan.blocksToUndo.length, 0);
    assert.strictEqual(plan.blocksToApply.length, 0);
    assert.strictEqual(plan.forkPoint.header.hash, 'a1');
  });
});

describe('computeChainWeight', () => {
  test('genesis only = hashWeight(genesis.hash)', () => {
    const store = new MockStore();
    const g = mkBlock(0, '0'.repeat(64), 'genesis');
    store.save(g);
    const w = computeChainWeight(g, store);
    assert.strictEqual(typeof w, 'bigint');
    assert.ok(w > 0n);
  });

  test('longer chain > shorter chain', () => {
    const store = new MockStore();
    const g = mkBlock(0, '0'.repeat(64), 'genesis');
    const a1 = mkBlock(1, g.header.hash, 'a1');
    const a2 = mkBlock(2, a1.header.hash, 'a2');
    const b1 = mkBlock(1, g.header.hash, 'b1');
    [g, a1, a2, b1].forEach(b => store.save(b));

    const w2 = computeChainWeight(a2, store);
    const w1 = computeChainWeight(b1, store);
    assert.ok(w2 > w1);
  });
});
