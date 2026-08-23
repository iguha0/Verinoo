import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { rmSync } from 'fs';
import { generateKeyPair, signMessage } from './wallet/crypto';
import { AINativeNode } from './node';

function httpGet(port: number, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(port: number, path: string, data: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
    });
    req.on('error', reject);
    req.write(JSON.stringify(data));
    req.end();
  });
}

describe('Live 3-Node Network', () => {
  test('validator mines block with peer tx and all nodes sync', async () => {
    const baseDir = './test_live_net';
    try { rmSync(baseDir, { recursive: true }); } catch {}

    const n1 = new AINativeNode({ name: 'val1', dataDir: `${baseDir}/n1`, p2pHost: '127.0.0.1', p2pPort: 20101, apiPort: 30101, peers: [], validator: true });
    const n2 = new AINativeNode({ name: 'peer2', dataDir: `${baseDir}/n2`, p2pHost: '127.0.0.1', p2pPort: 20102, apiPort: 30102, peers: ['ws://127.0.0.1:20101'], validator: false });
    const n3 = new AINativeNode({ name: 'peer3', dataDir: `${baseDir}/n3`, p2pHost: '127.0.0.1', p2pPort: 20103, apiPort: 30103, peers: ['ws://127.0.0.1:20102'], validator: false });

    await n1.start();
    await n2.start();
    await n3.start();
    await new Promise(r => setTimeout(r, 2000));

    const p2 = n2.p2p.getPeerCount();
    const p3 = n3.p2p.getPeerCount();
    console.log(`\n   Connected: n2=${p2}, n3=${p3}`);
    assert.ok(p2 >= 1, 'n2 connected to n1');
    assert.ok(p3 >= 1, 'n3 connected');

    // Pre-fund a sender through n2's store directly
    const sender = generateKeyPair();
    n2.store.setAccount({ address: sender.address, publicKey: sender.publicKey, nonce: 0, balance: 2000, updatedAt: 0 });
    // Also ensure n1 validator has balance for block rewards to work
    n1.store.setAccount({ address: n1.keyPair.address, publicKey: n1.keyPair.publicKey, nonce: 0, balance: 500, updatedAt: 0 });

    // Now submit real signed tx from sender via n2's API
    const crypto = require('crypto');
    const txData = {
      type: 'registerModel',
      data: { architecture: 'LiveNet-Model', parameterCount: 750_000_000, weightsHash: 'w_live_' + 'c'.repeat(28), runtimeHash: 'r_live_' + 'd'.repeat(28), stakingRequirement: 50, description: 'Live multi-node test model' }
    };
    const realTxId = crypto.createHash('sha256').update(JSON.stringify({ type: txData.type, data: txData.data, from: sender.address, nonce: 1 })).digest('hex').substring(0, 32);
    const realTx = {
      txId: realTxId, from: sender.address, to: '', value: 0, nonce: 1,
      data: txData, signature: signMessage(realTxId, sender.privateKey), publicKey: sender.publicKey
    };

    console.log('\n   Submitting tx via n2 API...');
    const resp = await httpPost(30102, '/tx', realTx);
    console.log(`   Response: ${JSON.stringify(resp)}`);

    // Wait for mining (10s block time)
    console.log('   Waiting for mining (12s)...');
    await new Promise(r => setTimeout(r, 12000));

    // Check all 3 nodes
    const s1 = await httpGet(30101, '/status');
    const s2 = await httpGet(30102, '/status');
    const s3 = await httpGet(30103, '/status');

    console.log(`\n   Heights: n1=${s1.height}, n2=${s2.height}, n3=${s3.height}`);
    assert.ok(s1.height >= 1, `n1 produced (${s1.height})`);
    assert.ok(s2.height >= 1, `n2 synced (${s2.height})`);
    assert.ok(s3.height >= 1, `n3 synced (${s3.height})`);

    // Check models
    const models2 = await httpGet(30102, '/models');
    console.log(`   Models on n2: ${models2?.length}`);
    assert.ok(models2?.length >= 1, 'model propagated to n2');
    const foundModel = models2.some((m: any) => m.architecture === 'LiveNet-Model');
    assert.ok(foundModel, 'our specific model exists on n2');

    console.log('\n   ✅ LIVE NETWORK TEST PASSED');
    n1.stop(); n2.stop(); n3.stop();
  });
});
