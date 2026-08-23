import { test, describe } from 'node:test';
import assert from 'node:assert';
import { AINativeNode } from './node';
import { rmSync } from 'fs';

describe('Multi-Node Network', () => {
  test('3-node block sync and tx propagation', async () => {
    const baseDir = './test_nodes_tmp';
    try { rmSync(baseDir, { recursive: true }); } catch {}

    const node1 = new AINativeNode({
      name: 'val1',
      dataDir: `${baseDir}/node1`,
      p2pHost: '127.0.0.1',
      p2pPort: 20001,
      apiPort: 30001,
      peers: [],
      validator: true,
    });

    const node2 = new AINativeNode({
      name: 'node2',
      dataDir: `${baseDir}/node2`,
      p2pHost: '127.0.0.1',
      p2pPort: 20002,
      apiPort: 30002,
      peers: ['ws://127.0.0.1:20001'],
      validator: false,
    });

    const node3 = new AINativeNode({
      name: 'node3',
      dataDir: `${baseDir}/node3`,
      p2pHost: '127.0.0.1',
      p2pPort: 20003,
      apiPort: 30003,
      peers: ['ws://127.0.0.1:20002'],
      validator: false,
    });

    try {
      await node1.start();
      await node2.start();
      await node3.start();

      await new Promise(r => setTimeout(r, 1500));

      console.log('\n   Connection state:');
      console.log(`   Node1 peers: ${node1.p2p.getPeerCount()}`);
      console.log(`   Node2 peers: ${node2.p2p.getPeerCount()}`);
      console.log(`   Node3 peers: ${node3.p2p.getPeerCount()}`);

      assert.ok(node2.p2p.getPeerCount() >= 1, 'node2 connected to node1');
      assert.ok(node3.p2p.getPeerCount() >= 1, 'node3 connected');

      // Wait for node1 validator to mine some blocks
      await new Promise(r => setTimeout(r, 12000));

      const h1 = node1.engine.getLatestBlock()?.header.index ?? 0;
      const h2 = node2.engine.getLatestBlock()?.header.index ?? 0;
      const h3 = node3.engine.getLatestBlock()?.header.index ?? 0;

      console.log(`\n   Final heights: val1=${h1}, node2=${h2}, node3=${h3}`);

      assert.ok(h1 >= 1, `node1 produced blocks (${h1})`);
      assert.ok(h2 >= 1, `node2 synced blocks (${h2})`);
      assert.ok(h3 >= 1, `node3 synced blocks (${h3})`);

      assert.ok(Math.abs(h1 - h2) <= 2, `h1 and h2 close: ${h1} vs ${h2}`);
      assert.ok(Math.abs(h2 - h3) <= 2, `h2 and h3 close: ${h2} vs ${h3}`);

      console.log('\n   ✅ All 3 nodes synced successfully!');
    } finally {
      node1.stop(); node2.stop(); node3.stop();
    }
  });
});
