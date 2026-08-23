import { test, describe } from 'node:test';
import assert from 'node:assert';
import { BlockStore } from './index';
import { rmSync, existsSync } from 'fs';

describe('BlockStore', () => {
  const TEST_DIR = './test_store_tmp';

  test('creates directories on init', () => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
    const store = new BlockStore(TEST_DIR);
    assert.ok(existsSync(`${TEST_DIR}/blocks`), 'blocks dir');
    assert.ok(existsSync(`${TEST_DIR}/accounts`), 'accounts dir');
    assert.ok(existsSync(`${TEST_DIR}/games`), 'games dir');
    store.close();
  });

  test('roundtrip block', () => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
    const store = new BlockStore(TEST_DIR);
    const block = {
      header: { hash: 'abc', version: 1, index: 5, timestamp: Date.now(), previousHash: '000', validator: 'val', validatorPubKey: 'pk', validatorSignature: 'sig', stateRoot: 's', txRoot: 't', inferenceTasksRoot: 'i', computeRoot: 'c' },
      transactions: [],
    };
    store.saveBlock(block);
    const fetched = store.getBlockByHeight(5);
    assert.deepStrictEqual(fetched?.header.hash, 'abc');
    assert.deepStrictEqual(store.getLatestBlock()?.header.index, 5);
    store.close();
  });

  test('roundtrip account', () => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
    const store = new BlockStore(TEST_DIR);
    const acc = { address: 'ai_test', publicKey: 'pk', nonce: 3, balance: 500, updatedAt: 1 };
    store.setAccount(acc);
    const fetched = store.getAccount('ai_test');
    assert.deepStrictEqual(fetched?.balance, 500);
    assert.deepStrictEqual(fetched?.nonce, 3);
    store.close();
  });

  test('game roundtrip', () => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
    const store = new BlockStore(TEST_DIR);
    const game = { gameId: 'g1', taskId: 't1', challenger: 'c1', defender: 'd1', status: 'open' };
    store.setGame(game);
    const fetched = store.getGame('g1');
    assert.strictEqual(fetched?.gameId, 'g1');
    assert.strictEqual(fetched?.status, 'open');
    store.close();
  });

  test('getGamesByTask filter', () => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
    const store = new BlockStore(TEST_DIR);
    store.setGame({ gameId: 'g1', taskId: 'taskA' });
    store.setGame({ gameId: 'g2', taskId: 'taskB' });
    const filtered = store.getGamesByTask('taskA');
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].gameId, 'g1');
    store.close();
  });
});
