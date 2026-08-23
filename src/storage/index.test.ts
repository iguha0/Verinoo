import { test, describe } from 'node:test';
import assert from 'node:assert';
import { BlockStore } from './index';
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'fs';

describe('BlockStore', () => {
  const TEST_DIR = './test_store_tmp';

  test('creates sqlite database on init', () => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
    const store = new BlockStore(TEST_DIR);
    assert.ok(existsSync(`${TEST_DIR}/chain.db`), 'chain.db exists');
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

  test('persists across reopen', () => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
    const block = {
      header: { hash: 'persist1', version: 1, index: 9, timestamp: Date.now(), previousHash: '000', validator: 'val', validatorPubKey: 'pk', validatorSignature: 'sig', stateRoot: 's', txRoot: 't', inferenceTasksRoot: 'i', computeRoot: 'c' },
      transactions: [],
    };
    {
      const store = new BlockStore(TEST_DIR);
      store.saveBlock(block);
      store.setAccount({ address: 'ai_persist', publicKey: 'pk', nonce: 1, balance: 42, updatedAt: 1 });
      store.close();
    }
    {
      const reopened = new BlockStore(TEST_DIR);
      assert.strictEqual(reopened.getChainHeight(), 9);
      assert.strictEqual(reopened.getBlockByHeight(9)?.header.hash, 'persist1');
      assert.strictEqual(reopened.getAccount('ai_persist')?.balance, 42);
      reopened.close();
    }
  });

  test('migrates legacy JSON layout once', () => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
    // Simulate the pre-SQLite directory-of-JSON-files layout
    mkdirSync(`${TEST_DIR}/blocks`, { recursive: true });
    mkdirSync(`${TEST_DIR}/accounts`, { recursive: true });
    writeFileSync(`${TEST_DIR}/blocks/0.json`, JSON.stringify({
      header: { hash: 'genesisX', version: 1, index: 0, timestamp: 0, previousHash: '', validator: 'v', validatorPubKey: 'pk', validatorSignature: 'sig', stateRoot: 's', txRoot: 't', inferenceTasksRoot: 'i', computeRoot: 'c' },
      transactions: [],
    }));
    writeFileSync(`${TEST_DIR}/accounts/ai_old.json`, JSON.stringify({ address: 'ai_old', publicKey: 'pk', nonce: 7, balance: 1000, updatedAt: 1 }));

    const store = new BlockStore(TEST_DIR);
    assert.strictEqual(store.getBlockByHeight(0)?.header.hash, 'genesisX');
    assert.strictEqual(store.getChainHeight(), 0);
    assert.strictEqual(store.getAccount('ai_old')?.balance, 1000);
    store.close();

    // Reopen must not duplicate or lose data (migration is one-shot)
    const again = new BlockStore(TEST_DIR);
    assert.strictEqual(again.getBlockByHeight(0)?.header.hash, 'genesisX');
    assert.ok(existsSync(`${TEST_DIR}/chain.db`));
    again.close();
  });
});
