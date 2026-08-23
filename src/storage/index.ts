import { resolve } from 'path';
import { mkdirSync, existsSync, readFileSync, readdirSync, renameSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { Block, ModelRegistryEntry, InferenceTask, ComputeNode, AgentAccount, AccountState } from '../core/types';

/**
 * BlockStore — SQLite-backed persistent state.
 *
 * Single database file at <baseDir>/chain.db. Nodes created before this
 * change used a directory-of-JSON-files layout; the constructor performs a
 * one-time import of that layout and moves it aside so upgrades are
 * seamless and idempotent.
 */

const LEGACY_SUBDIRS = ['blocks', 'accounts', 'models', 'tasks', 'nodes', 'agents', 'games', 'meta'] as const;

function loadJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

export class BlockStore {
  private dir: string;
  private db: DatabaseSync;

  constructor(baseDir: string) {
    this.dir = resolve(baseDir);
    mkdirSync(this.dir, { recursive: true });

    this.db = new DatabaseSync(resolve(this.dir, 'chain.db'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS blocks (
        height INTEGER NOT NULL,
        hash TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (height, hash)
      );
      CREATE TABLE IF NOT EXISTS accounts (
        address TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS models (
        model_id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS compute_nodes (
        node_id TEXT PRIMARY KEY,
        reputation REAL NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        address TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS games (
        game_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        json TEXT NOT NULL
      );
    `);

    this.migrateFromJsonIfNeeded();
  }

  // === Legacy JSON migration ===

  private migrateFromJsonIfNeeded(): void {
    const flag = this.getMetaRaw('migrated_from_json');
    if (flag) return;

    const hasLegacy = LEGACY_SUBDIRS.some(sub => existsSync(resolve(this.dir, sub)));
    if (!hasLegacy) return;

    const blocksDir = resolve(this.dir, 'blocks');
    let maxImportedHeight = -1;
    if (existsSync(blocksDir)) {
      const seen = new Set<string>();
      for (const f of readdirSync(blocksDir).filter(f => f.endsWith('.json'))) {
        const b = loadJson<Block>(resolve(blocksDir, f));
        if (!b?.header?.hash || seen.has(b.header.hash)) continue;
        seen.add(b.header.hash);
        this.insertBlock(b);
        if (b.header.index > maxImportedHeight) maxImportedHeight = b.header.index;
      }
    }

    const importEach = <T>(sub: string, fn: (item: T) => void) => {
      const d = resolve(this.dir, sub);
      if (!existsSync(d)) return;
      for (const f of readdirSync(d).filter(f => f.endsWith('.json'))) {
        const item = loadJson<T>(resolve(d, f));
        if (item) fn(item);
      }
    };

    importEach<AccountState>('accounts', a => this.setAccount(a));
    importEach<ModelRegistryEntry>('models', m => this.setModel(m));
    importEach<InferenceTask>('tasks', t => this.setTask(t));
    importEach<ComputeNode>('nodes', n => this.setNode(n));
    importEach<AgentAccount>('agents', a => this.setAgent(a));
    importEach<any>('games', g => this.setGame(g));

    const latest = loadJson<{ height: number; hash: string }>(resolve(this.dir, 'meta', 'latest.json'));
    if (latest?.height !== undefined && latest.hash) {
      this.setMetaJson('latest', latest);
    } else if (maxImportedHeight >= 0) {
      // No legacy pointer — derive chain height from imported blocks
      const top = this.getBlocksAtHeight(maxImportedHeight)[0];
      if (top) this.setMetaJson('latest', { height: maxImportedHeight, hash: top.header.hash });
    }
    const metaDir = resolve(this.dir, 'meta');
    if (existsSync(metaDir)) {
      for (const f of readdirSync(metaDir).filter(f => f.startsWith('val_') && f.endsWith('.json'))) {
        const key = f.slice(4, -5);
        const v = loadJson<{ value: string }>(resolve(metaDir, f));
        if (v?.value !== undefined) this.setMeta(key, v.value);
      }
    }

    this.setMetaRaw('migrated_from_json', new Date().toISOString());

    // Move legacy layout aside to keep the data dir clean and migration one-shot
    const stamp = Date.now();
    for (const sub of LEGACY_SUBDIRS) {
      const d = resolve(this.dir, sub);
      if (existsSync(d)) {
        try { renameSync(d, resolve(this.dir, `legacy_json_${stamp}`, sub)); } catch {}
      }
    }
    try { mkdirSync(resolve(this.dir, `legacy_json_${stamp}`), { recursive: true }); } catch {}
  }

  private setMetaRaw(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private getMetaRaw(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setMetaJson(key: string, value: unknown): void {
    this.setMetaRaw(key, JSON.stringify(value));
  }

  private getMetaJson<T>(key: string): T | undefined {
    const raw = this.getMetaRaw(key);
    return raw ? JSON.parse(raw) : undefined;
  }

  // === Blocks ===

  private insertBlock(b: Block): void {
    this.db.prepare('INSERT INTO blocks (height, hash, json) VALUES (?, ?, ?) ON CONFLICT(height, hash) DO UPDATE SET json = excluded.json')
      .run(b.header.index, b.header.hash, JSON.stringify(b));
  }

  saveBlock(b: Block) {
    this.insertBlock(b);
    this.setMetaJson('latest', { height: b.header.index, hash: b.header.hash });
  }

  getBlocksAtHeight(h: number): Block[] {
    const rows = this.db.prepare('SELECT json FROM blocks WHERE height = ?').all(h) as { json: string }[];
    return rows.map(r => JSON.parse(r.json)).filter(Boolean);
  }

  getBlockByHeight(h: number): Block | undefined {
    // Most recently saved block wins (matches legacy single-file semantics)
    const row = this.db.prepare('SELECT json FROM blocks WHERE height = ? ORDER BY rowid DESC LIMIT 1').get(h) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  getLatestBlock(): Block | undefined {
    const m = this.getMetaJson<{ height: number }>('latest');
    return m ? this.getBlockByHeight(m.height) : undefined;
  }

  getChainHeight(): number {
    return this.getMetaJson<{ height: number }>('latest')?.height ?? -1;
  }

  // === Accounts ===

  setAccount(a: AccountState) {
    this.db.prepare('INSERT INTO accounts (address, json) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET json = excluded.json')
      .run(a.address, JSON.stringify(a));
  }

  getAccount(addr: string): AccountState | undefined {
    const row = this.db.prepare('SELECT json FROM accounts WHERE address = ?').get(addr) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  // === Models ===

  setModel(m: ModelRegistryEntry) {
    this.db.prepare('INSERT INTO models (model_id, json) VALUES (?, ?) ON CONFLICT(model_id) DO UPDATE SET json = excluded.json')
      .run(m.modelId, JSON.stringify(m));
  }

  getModel(id: string): ModelRegistryEntry | undefined {
    const row = this.db.prepare('SELECT json FROM models WHERE model_id = ?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  getModels(): ModelRegistryEntry[] {
    const rows = this.db.prepare('SELECT json FROM models').all() as { json: string }[];
    return rows.map(r => JSON.parse(r.json)).filter(Boolean);
  }

  // === Tasks ===

  setTask(t: InferenceTask) {
    this.db.prepare('INSERT INTO tasks (task_id, status, json) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET status = excluded.status, json = excluded.json')
      .run(t.taskId, t.status, JSON.stringify(t));
  }

  getTask(id: string): InferenceTask | undefined {
    const row = this.db.prepare('SELECT json FROM tasks WHERE task_id = ?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  getTasksByStatus(status: string): InferenceTask[] {
    const rows = this.db.prepare('SELECT json FROM tasks WHERE status = ?').all(status) as { json: string }[];
    return rows.map(r => JSON.parse(r.json)).filter(Boolean);
  }

  // === Compute Nodes ===

  setNode(n: ComputeNode) {
    this.db.prepare('INSERT INTO compute_nodes (node_id, reputation, json) VALUES (?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET reputation = excluded.reputation, json = excluded.json')
      .run(n.nodeId, n.reputation, JSON.stringify(n));
  }

  getNode(id: string): ComputeNode | undefined {
    const row = this.db.prepare('SELECT json FROM compute_nodes WHERE node_id = ?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  getNodes(): ComputeNode[] {
    const rows = this.db.prepare('SELECT json FROM compute_nodes ORDER BY reputation DESC').all() as { json: string }[];
    return rows.map(r => JSON.parse(r.json)).filter(Boolean);
  }

  getNodesForModel(modelId: string): ComputeNode[] {
    return this.getNodes().filter(n => n.supportedModels.includes(modelId));
  }

  // === Agents ===

  setAgent(a: AgentAccount) {
    this.db.prepare('INSERT INTO agents (address, json) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET json = excluded.json')
      .run(a.address, JSON.stringify(a));
  }

  getAgent(addr: string): AgentAccount | undefined {
    const row = this.db.prepare('SELECT json FROM agents WHERE address = ?').get(addr) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  getAgents(): AgentAccount[] {
    const rows = this.db.prepare('SELECT json FROM agents').all() as { json: string }[];
    return rows.map(r => JSON.parse(r.json)).filter(Boolean);
  }

  // === Meta ===

  setMeta(key: string, value: string) {
    this.setMetaRaw(key, value);
  }

  getMeta(key: string): string | undefined {
    return this.getMetaRaw(key);
  }

  // === Verification Games ===

  setGame(g: any) {
    this.db.prepare('INSERT INTO games (game_id, task_id, json) VALUES (?, ?, ?) ON CONFLICT(game_id) DO UPDATE SET task_id = excluded.task_id, json = excluded.json')
      .run(g.gameId, g.taskId ?? '', JSON.stringify(g));
  }

  getGame(id: string): any | undefined {
    const row = this.db.prepare('SELECT json FROM games WHERE game_id = ?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  getGames(): any[] {
    const rows = this.db.prepare('SELECT json FROM games').all() as { json: string }[];
    return rows.map(r => JSON.parse(r.json)).filter(Boolean);
  }

  getGamesByTask(taskId: string): any[] {
    const rows = this.db.prepare('SELECT json FROM games WHERE task_id = ?').all(taskId) as { json: string }[];
    return rows.map(r => JSON.parse(r.json)).filter(Boolean);
  }

  close() {
    try { this.db.close(); } catch {}
  }
}
