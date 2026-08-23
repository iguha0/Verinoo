import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createApiServer, ApiOptions } from './index';
import type { AINativeEngine } from '../core/engine';
import type { P2PNetwork } from '../p2p';

function makeStubs() {
  const engine = {
    getLatestBlock: () => ({ header: { index: 3, hash: 'h3', validator: 'v' } }),
    validateTransaction: (_tx: any) => {
      // pretend signature check passes only for well-formed sig
      return _tx.signature === 'sig-ok' ? true : 'bad signature';
    },
    getAccount: () => undefined,
    getModel: () => undefined,
    store: {
      getChainHeight: () => 3,
      getModels: () => [],
      getNodes: () => [],
      getAgents: () => [],
      getTasksByStatus: () => [],
      getBlocksAtHeight: () => [],
    },
  } as unknown as AINativeEngine;

  const p2p = {
    getPeerCount: () => 2,
    getConnectedPeers: () => [{ url: 'ws://127.0.0.1:1', nodeId: 'n', address: '' }],
    sendTransaction: (_tx: any) => {},
  } as unknown as P2PNetwork;

  return { engine, p2p };
}

async function listen(engine: any, p2p: any, opts: ApiOptions): Promise<{ url: string; close: () => Promise<void> }> {
  // createApiServer starts listening itself; wait for its 'listening' event
  const { server } = createApiServer(engine, p2p, 'test-node', 0, opts);
  await new Promise<void>((res, rej) => {
    if (server.address()) return res();
    server.once('listening', () => res());
    server.once('error', rej);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      // Drop keep-alive sockets so close() resolves promptly
      (server as any).closeAllConnections?.();
      await new Promise(r => server.close(r));
    },
  };
}

const goodTx = {
  txId: 'tx-1', from: 'a', to: 'b', value: 1, nonce: 0,
  data: { type: 'transfer', data: {} }, signature: 'sig-ok', publicKey: 'pk',
};

describe('API security', () => {
  test('reads stay open without auth', async () => {
    const { engine, p2p } = makeStubs();
    const api = await listen(engine, p2p, {});
    try {
      const res = await fetch(`${api.url}/status`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.height, 3);
    } finally { await api.close(); }
  });

  test('mutations require bearer token when configured', async () => {
    const { engine, p2p } = makeStubs();
    const api = await listen(engine, p2p, { apiToken: 'secret-token' });
    try {
      const noAuth = await fetch(`${api.url}/tx`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(goodTx) });
      assert.strictEqual(noAuth.status, 401);

      const wrongToken = await fetch(`${api.url}/tx`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer nope' },
        body: JSON.stringify(goodTx),
      });
      assert.strictEqual(wrongToken.status, 401);

      const ok = await fetch(`${api.url}/tx`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer secret-token' },
        body: JSON.stringify(goodTx),
      });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual((await ok.json()).accepted, true);

      // x-api-token header also accepted
      const viaHeader = await fetch(`${api.url}/tx`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-token': 'secret-token' },
        body: JSON.stringify({ ...goodTx, txId: 'tx-2' }),
      });
      assert.strictEqual(viaHeader.status, 200);
    } finally { await api.close(); }
  });

  test('rejects malformed tx bodies with 400', async () => {
    const { engine, p2p } = makeStubs();
    const api = await listen(engine, p2p, {});
    try {
      for (const bad of [
        null,
        'string',
        { ...goodTx, txId: '' },
        { ...goodTx, from: '' },
        { ...goodTx, value: -5 },
        { ...goodTx, nonce: 1.5 },
        { ...goodTx, data: 'nope' },
      ]) {
        const res = await fetch(`${api.url}/tx`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad) });
        assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      }
    } finally { await api.close(); }
  });

  test('rate limiting returns 429 after burst', async () => {
    const { engine, p2p } = makeStubs();
    const api = await listen(engine, p2p, { rateLimitPerMinute: 5 });
    try {
      let got429 = false;
      for (let i = 0; i < 8; i++) {
        const res = await fetch(`${api.url}/health`);
        if (res.status === 429) { got429 = true; break; }
      }
      assert.ok(got429, 'expected a 429 within burst of 8 requests at limit 5');
    } finally { await api.close(); }
  });
});
