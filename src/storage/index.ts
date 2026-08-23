import { resolve } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { Block, Transaction, ModelRegistryEntry, InferenceTask, ComputeNode, AgentAccount, AccountState } from '../core/types';

function loadJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function saveJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export class BlockStore {
  private dir: string;

  constructor(baseDir: string) {
    this.dir = resolve(baseDir);
    for (const sub of ['blocks','accounts','models','tasks','nodes','agents','games','meta']) {
      mkdirSync(resolve(this.dir, sub), { recursive: true });
    }
  }

  saveBlock(b: Block) {
    // Save by height for primary access, by hash for fork handling
    saveJson(resolve(this.dir, 'blocks', `${b.header.index}.json`), b);
    saveJson(resolve(this.dir, 'blocks', `h${b.header.index}_${b.header.hash.slice(0, 16)}.json`), b);
    saveJson(resolve(this.dir, 'meta', 'latest.json'), { height: b.header.index, hash: b.header.hash });
  }

  getBlocksAtHeight(h: number): Block[] {
    return readdirSync(resolve(this.dir, 'blocks'))
      .filter(f => f.startsWith(`h${h}_`))
      .map(f => loadJson<Block>(resolve(this.dir, 'blocks', f))!)
      .filter(Boolean);
  }

  getBlockByHeight(h: number): Block | undefined { return loadJson(resolve(this.dir, 'blocks', `${h}.json`)); }

  getLatestBlock(): Block | undefined {
    const m = loadJson<{height:number}>(resolve(this.dir, 'meta', 'latest.json'));
    return m ? this.getBlockByHeight(m.height) : undefined;
  }

  getChainHeight(): number {
    return loadJson<{height:number}>(resolve(this.dir, 'meta', 'latest.json'))?.height ?? -1;
  }

  setAccount(a: AccountState) {
    saveJson(resolve(this.dir, 'accounts', `${a.address}.json`), a);
  }

  getAccount(addr: string): AccountState | undefined {
    return loadJson<AccountState>(resolve(this.dir, 'accounts', `${addr}.json`));
  }

  setModel(m: ModelRegistryEntry) {
    saveJson(resolve(this.dir, 'models', `${m.modelId}.json`), m);
  }

  getModel(id: string): ModelRegistryEntry | undefined {
    return loadJson<ModelRegistryEntry>(resolve(this.dir, 'models', `${id}.json`));
  }

  getModels(): ModelRegistryEntry[] {
    return readdirSync(resolve(this.dir, 'models'))
      .filter(f => f.endsWith('.json'))
      .map(f => loadJson<ModelRegistryEntry>(resolve(this.dir, 'models', f))!)
      .filter(Boolean);
  }

  setTask(t: InferenceTask) {
    saveJson(resolve(this.dir, 'tasks', `${t.taskId}.json`), t);
  }

  getTask(id: string): InferenceTask | undefined {
    return loadJson<InferenceTask>(resolve(this.dir, 'tasks', `${id}.json`));
  }

  getTasksByStatus(status: string): InferenceTask[] {
    return readdirSync(resolve(this.dir, 'tasks'))
      .filter(f => f.endsWith('.json'))
      .map(f => loadJson<InferenceTask>(resolve(this.dir, 'tasks', f))!)
      .filter(t => t?.status === status);
  }

  setNode(n: ComputeNode) {
    saveJson(resolve(this.dir, 'nodes', `${n.nodeId}.json`), n);
  }

  getNode(id: string): ComputeNode | undefined {
    return loadJson<ComputeNode>(resolve(this.dir, 'nodes', `${id}.json`));
  }

  getNodes(): ComputeNode[] {
    return readdirSync(resolve(this.dir, 'nodes'))
      .filter(f => f.endsWith('.json'))
      .map(f => loadJson<ComputeNode>(resolve(this.dir, 'nodes', f))!)
      .filter(Boolean)
      .sort((a, b) => b.reputation - a.reputation);
  }

  getNodesForModel(modelId: string): ComputeNode[] {
    return this.getNodes().filter(n => n.supportedModels.includes(modelId));
  }

  setAgent(a: AgentAccount) {
    saveJson(resolve(this.dir, 'agents', `${a.address}.json`), a);
  }

  getAgent(addr: string): AgentAccount | undefined {
    return loadJson<AgentAccount>(resolve(this.dir, 'agents', `${addr}.json`));
  }

  getAgents(): AgentAccount[] {
    return readdirSync(resolve(this.dir, 'agents'))
      .filter(f => f.endsWith('.json'))
      .map(f => loadJson<AgentAccount>(resolve(this.dir, 'agents', f))!)
      .filter(Boolean);
  }

  setMeta(key: string, value: string) {
    saveJson(resolve(this.dir, 'meta', `val_${key}.json`), { value });
  }

  getMeta(key: string): string | undefined {
    return loadJson<{value:string}>(resolve(this.dir, 'meta', `val_${key}.json`))?.value;
  }

  // -- Verification Games --
  setGame(g: any) {
    saveJson(resolve(this.dir, 'games', `${g.gameId}.json`), g);
  }

  getGame(id: string): any | undefined {
    return loadJson<any>(resolve(this.dir, 'games', `${id}.json`));
  }

  getGames(): any[] {
    return readdirSync(resolve(this.dir, 'games'))
      .filter(f => f.endsWith('.json'))
      .map(f => loadJson<any>(resolve(this.dir, 'games', f))!)
      .filter(Boolean);
  }

  getGamesByTask(taskId: string): any[] {
    return this.getGames().filter(g => g.taskId === taskId);
  }

  close() {}
}
