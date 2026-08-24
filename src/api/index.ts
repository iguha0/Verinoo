import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { AINativeEngine } from '../core/engine';
import { P2PNetwork } from '../p2p';
import { Transaction } from '../core/types';

export interface ApiOptions {
  /** When set, mutating requests (POST/PUT/DELETE) must present this token
   *  via `Authorization: Bearer <token>` or `x-api-token`. Read-only
   *  endpoints stay open. If unset the API is open (local dev mode). */
  apiToken?: string;
  /** Requests per minute per IP. Default 240. */
  rateLimitPerMinute?: number;
}

/** Fixed-window in-memory rate limiter, per IP. */
function rateLimiter(maxPerMinute: number) {
  const hits = new Map<string, { count: number; windowStart: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now - entry.windowStart >= 60_000) {
      entry = { count: 0, windowStart: now };
      hits.set(ip, entry);
    }
    entry.count++;
    // Opportunistic cleanup to bound memory
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (now - v.windowStart >= 60_000) hits.delete(k);
    }
    if (entry.count > maxPerMinute) {
      return res.status(429).json({ error: 'rate limit exceeded' });
    }
    next();
  };
}

export function createApiServer(engine: AINativeEngine, p2p: P2PNetwork, nodeId: string, apiPort: number, opts: ApiOptions = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(rateLimiter(opts.rateLimitPerMinute ?? 240));

  // Token auth for mutating requests only; reads stay open for the dashboard.
  const mutatingMethods = new Set(['POST', 'PUT', 'DELETE']);
  app.use((req, res, next) => {
    if (!opts.apiToken) return next();
    if (!mutatingMethods.has(req.method)) return next();
    const presented =
      req.headers['x-api-token'] ||
      (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : undefined);
    if (presented !== opts.apiToken) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

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

  // Landing site at the root — every node doubles as a web endpoint.
  app.get('/', (_req, res) => {
    try {
      const htmlPath = resolve(__dirname, '../../website/index.html');
      const html = readFileSync(htmlPath, 'utf-8');
      res.type('html').send(html);
    } catch (e) {
      res.redirect('/dashboard');
    }
  });

  function validateTxBody(tx: any): string | null {
    if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return 'body must be a transaction object';
    // Required non-empty strings
    for (const f of ['txId', 'from', 'signature', 'publicKey'] as const) {
      if (typeof tx[f] !== 'string' || !tx[f]) return `missing or invalid field: ${f}`;
    }
    // `to` may be empty (e.g. protocol ops like registerModel)
    if (typeof tx.to !== 'string') return 'missing or invalid field: to';
    if (typeof tx.value !== 'number' || !Number.isFinite(tx.value) || tx.value < 0) return 'invalid value';
    if (!Number.isInteger(tx.nonce) || tx.nonce < 0) return 'invalid nonce';
    if (tx.data !== undefined && (typeof tx.data !== 'object' || tx.data === null)) return 'invalid data';
    if (typeof tx.gasLimit !== 'undefined' && (typeof tx.gasLimit !== 'number' || tx.gasLimit < 0)) return 'invalid gasLimit';
    if (typeof tx.gasPrice !== 'undefined' && (typeof tx.gasPrice !== 'number' || tx.gasPrice < 0)) return 'invalid gasPrice';
    return null;
  }

  app.post('/tx', (req, res) => {
    const tx = req.body as Transaction;
    const bodyErr = validateTxBody(tx);
    if (bodyErr) return res.status(400).json({ error: bodyErr });
    const val = engine.validateTransaction(tx);
    if (val !== true) return res.status(400).json({ error: val });
    p2p.sendTransaction(tx);
    res.json({ accepted: true, txId: tx.txId });
  });

  const server = app.listen(apiPort, () => {
    const addr = server.address();
    const shown = typeof addr === 'object' && addr ? addr.port : apiPort;
    console.log(`[api] http://localhost:${shown}`);
    console.log(`[api] dashboard http://localhost:${shown}/dashboard`);
  });

  return { app, server };
}
