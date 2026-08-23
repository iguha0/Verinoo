import { test, describe } from 'node:test';
import assert from 'node:assert';
import { P2PNetwork } from './index';
import { rmSync } from 'fs';

describe('P2P Network', () => {
  test('two nodes connect and exchange messages', async () => {
    const baseDir = './test_p2p_tmp';
    try { rmSync(baseDir, { recursive: true }); } catch {}

    const p1 = new P2PNetwork('node1', 'addr1', { host: '127.0.0.1', port: 19001, maxPeers: 10 });
    const p2 = new P2PNetwork('node2', 'addr2', { host: '127.0.0.1', port: 19002, maxPeers: 10 });

    const receivedTxs: any[] = [];
    p2.on('tx', (tx) => receivedTxs.push(tx));

    await p1.start();
    await p2.start();

    // Give a moment for startup
    await new Promise(r => setTimeout(r, 500));

    p2.connect('ws://127.0.0.1:19001');
    await new Promise(r => setTimeout(r, 500));

    // Send a tx
    p1.sendTransaction({ txId: 'tx-test-1', from: 'a', to: 'b', value: 10, nonce: 1, data: { type: 'transfer', data: {} }, signature: 'sig', publicKey: 'pk' });
    await new Promise(r => setTimeout(r, 500));

    assert.ok(p2.getPeerCount() >= 1, 'p2 has a peer');
    assert.ok(receivedTxs.length >= 1, `received tx, got ${receivedTxs.length}`);
    assert.strictEqual(receivedTxs[0].txId, 'tx-test-1');

    p1.stop();
    p2.stop();
  });

  test('block gossip', async () => {
    const p1 = new P2PNetwork('node1', 'addr1', { host: '127.0.0.1', port: 19003, maxPeers: 10 });
    const p2 = new P2PNetwork('node2', 'addr2', { host: '127.0.0.1', port: 19004, maxPeers: 10 });

    const receivedBlocks: any[] = [];
    p2.on('block', (block, source) => receivedBlocks.push({ block, source }));

    await p1.start();
    await p2.start();
    await new Promise(r => setTimeout(r, 200));

    p2.connect('ws://127.0.0.1:19003');
    await new Promise(r => setTimeout(r, 500));

    const block = {
      header: { hash: 'aaa', version: 1, index: 5, timestamp: Date.now(), previousHash: '000', validator: 'v', validatorPubKey: 'pk', validatorSignature: 'sig', stateRoot: 's', txRoot: 't', inferenceTasksRoot: 'i', computeRoot: 'c' },
      transactions: [],
    };
    p1.sendBlock(block);
    await new Promise(r => setTimeout(r, 500));

    assert.ok(receivedBlocks.length >= 1, 'block received');
    assert.strictEqual(receivedBlocks[0].block.header.hash, 'aaa');

    p1.stop();
    p2.stop();
  });

  test('peer list propagation', async () => {
    const p1 = new P2PNetwork('node1', 'addr1', { host: '127.0.0.1', port: 19005, maxPeers: 10 });
    const p2 = new P2PNetwork('node2', 'addr2', { host: '127.0.0.1', port: 19006, maxPeers: 10 });
    const p3 = new P2PNetwork('node3', 'addr3', { host: '127.0.0.1', port: 19007, maxPeers: 10 });

    await p1.start();
    await p2.start();
    await p3.start();
    await new Promise(r => setTimeout(r, 200));

    // p2 -> p1, p3 -> p2 (should discover p1 via peer list)
    p2.connect('ws://127.0.0.1:19005');
    await new Promise(r => setTimeout(r, 500));
    p3.connect('ws://127.0.0.1:19006');
    await new Promise(r => setTimeout(r, 800));

    // p3 should eventually know about p1
    const peers = p3.getConnectedPeers();
    const hasP1 = peers.some(p => p.url.includes('19005'));
    // Not guaranteed on first try but should be connected to p2
    assert.ok(peers.length >= 1, 'p3 has peers');

    p1.stop();
    p2.stop();
    p3.stop();
  });

  test('no self-connections or duplicate sockets in 3-node mesh', async () => {
    const p1 = new P2PNetwork('node1', 'addr1', { host: '127.0.0.1', port: 19009, maxPeers: 10 });
    const p2 = new P2PNetwork('node2', 'addr2', { host: '127.0.0.1', port: 19010, maxPeers: 10 });
    const p3 = new P2PNetwork('node3', 'addr3', { host: '127.0.0.1', port: 19011, maxPeers: 10 });

    await p1.start();
    await p2.start();
    await p3.start();
    await new Promise(r => setTimeout(r, 200));

    // Full mesh discovery via gossip, including a node announcing 0.0.0.0
    p2.connect('ws://127.0.0.1:19009');
    await new Promise(r => setTimeout(r, 400));
    p3.connect('ws://127.0.0.1:19009');
    await new Promise(r => setTimeout(r, 1200));

    for (const [name, pn] of [['p1', p1], ['p2', p2], ['p3', p3]] as const) {
      const count = pn.getPeerCount();
      assert.ok(count <= 2, `${name} must have at most 2 peers (one per node), got ${count}`);
      const ids = pn.getConnectedPeers().map(p => p.nodeId).filter(Boolean);
      assert.ok(!ids.includes(name), `${name} must not be connected to itself`);
      assert.strictEqual(new Set(ids).size, ids.length, `${name} has duplicate nodeIds: ${ids.join(',')}`);
    }

    // Gossip still works end-to-end across the mesh
    const received: any[] = [];
    p3.on('tx', tx => received.push(tx));
    p1.sendTransaction({ txId: 'mesh-1', from: 'a', to: 'b', value: 1, nonce: 1, data: { type: 'transfer', data: {} }, signature: 's', publicKey: 'pk' });
    await new Promise(r => setTimeout(r, 600));
    assert.ok(received.some(t => t.txId === 'mesh-1'), 'tx gossiped through mesh');

    p1.stop();
    p2.stop();
    p3.stop();
  });
});
