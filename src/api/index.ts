import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { AINativeEngine } from '../core/engine';
import { P2PNetwork } from '../p2p';
import { Transaction } from '../core/types';

export function createApiServer(engine: AINativeEngine, p2p: P2PNetwork, nodeId: string, apiPort: number) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (_req, res) => {
    const latest = engine.getLatestBlock();
    res.json({ ok: true, nodeId, height: latest?.header.index ?? 0 });
  });

  app.get('/status', (_req, res) => {
    const latest = engine.getLatestBlock();
    res.json({
      chainId: 'ai-native-1',
      nodeId,
      height: latest?.header.index ?? 0,
      latestHash: latest?.header.hash ?? '0',
      validator: latest?.header.validator ?? 'none',
      models: engine.store.getModels().length,
      computeNodes: engine.store.getNodes().length,
      agents: engine.store.getAgents().length,
      peerCount: p2p.getPeerCount(),
    });
  });

  app.get('/blocks', (_req, res) => {
    const h = engine.store.getChainHeight();
    const blocks = [];
    for (let i = h; i >= Math.max(0, h - 9); i--) {
      const b = engine.getBlockByHeight(i);
      if (b) blocks.push(b);
    }
    res.json(blocks);
  });

  app.get('/accounts/:address', (req, res) => {
    const a = engine.getAccount(req.params.address);
    if (!a) return res.status(404).json({ error: 'not found' });
    res.json(a);
  });

  app.get('/models', (_req, res) => res.json(engine.store.getModels()));
  app.get('/models/:id', (req, res) => {
    const m = engine.getModel(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    res.json(m);
  });

  app.get('/tasks', (req, res) => {
    const status = req.query.status as string;
    res.json(status ? engine.store.getTasksByStatus(status) : engine.store.getTasksByStatus('pending'));
  });

  app.get('/nodes', (_req, res) => res.json(engine.store.getNodes()));
  app.get('/agents', (_req, res) => res.json(engine.store.getAgents()));
  app.get('/peers', (_req, res) => res.json(p2p.getConnectedPeers()));

  app.get('/dashboard', (_req, res) => {
    try {
      const htmlPath = resolve(__dirname, '../../public/dashboard.html');
      const html = readFileSync(htmlPath, 'utf-8');
      res.type('html').send(html);
    } catch (e) {
      res.status(500).send('Dashboard not available');
    }
  });

  app.post('/tx', (req, res) => {
    const tx = req.body as Transaction;
    if (!tx.signature || !tx.publicKey) return res.status(400).json({ error: 'missing sig' });
    const val = engine.validateTransaction(tx);
    if (val !== true) return res.status(400).json({ error: val });
    p2p.sendTransaction(tx);
    res.json({ accepted: true, txId: tx.txId });
  });

  const server = app.listen(apiPort, () => {
    console.log(`[api] http://localhost:${apiPort}`);
    console.log(`[api] dashboard http://localhost:${apiPort}/dashboard`);
  });

  return { app, server };
}
