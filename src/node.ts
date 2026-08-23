import fs from 'fs';
import path from 'path';
import { BlockStore } from './storage';
import { AINativeEngine } from './core/engine';
import { P2PNetwork } from './p2p';
import { createApiServer } from './api';
import { Transaction, Block, HeartbeatPayload } from './core/types';
import { generateKeyPair, publicKeyToAddress, signMessage } from './wallet/crypto';
import { EventEmitter } from 'events';
import { resolveFork, planReorg } from './core/fork';
import { terminateZkWorkers } from './zk/groth16';

export class AINativeNode extends EventEmitter {
  public readonly keyPair: ReturnType<typeof generateKeyPair>;
  public store!: BlockStore;
  public engine!: AINativeEngine;
  public p2p!: P2PNetwork;

  private config: any;
  private mempool: Transaction[] = [];
  private timers: NodeJS.Timeout[] = [];
  private p2pTxs = new Set<string>();
  private apiServer: ReturnType<typeof createApiServer> | null = null;

  constructor(config: any) {
    super();
    this.config = config;
    const keyPath = path.join(config.dataDir, 'key.json');
    if (fs.existsSync(keyPath)) {
      const saved = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
      this.keyPair = { ...generateKeyPair(), ...saved };
    } else {
      this.keyPair = generateKeyPair();
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(keyPath, JSON.stringify(this.keyPair, null, 2));
      console.log(`[node] new key: ${this.keyPair.address}`);
    }
  }

  async start(): Promise<void> {
    this.store = new BlockStore(path.join(this.config.dataDir, 'chain'));
    this.engine = new AINativeEngine(this.store);
    this.p2p = new P2PNetwork(this.config.name, this.keyPair.address, {
      host: this.config.p2pHost, port: this.config.p2pPort,
    });

    this.p2p.on('tx', (tx: Transaction) => {
      if (this.p2pTxs.has(tx.txId)) return;
      this.p2pTxs.add(tx.txId);
      if (this.engine.validateTransaction(tx) === true) {
        this.mempool.push(tx);
        console.log(`[mempool] +1 (${this.mempool.length})`);
      }
    });

    this.p2p.on('block', (block: Block, source: string) => {
      const latest = this.engine.getLatestBlock();
      if (!latest) return;
      if (block.header.validator === this.keyPair.address) return;

      // Always save block — forks may need it later
      this.store.saveBlock(block);

      const { reorged, newHead } = resolveFork(latest, block, this.store);
      if (reorged) {
        console.log(`[sync] REORG detected! Heavier chain at #${newHead.header.index}`);
        const plan = planReorg(latest, newHead, this.store);
        console.log(`[sync] Reorg plan: undo ${plan.blocksToUndo.length}, apply ${plan.blocksToApply.length}`);
        console.log(`[sync] Fork point: #${plan.forkPoint.header.index}`);

        for (const b of plan.blocksToUndo) {
          console.log(`[sync] Undo #${b.header.index}`);
        }
        for (const b of plan.blocksToApply) {
          for (const tx of b.transactions) {
            try { this.engine.executeTransaction(tx, b.header.index); } catch (e) {}
          }
          console.log(`[sync] Apply #${b.header.index}`);
        }

        // Update meta latest
        const metaPath = path.join(this.config.dataDir, 'chain', 'meta', 'latest.json');
        fs.writeFileSync(metaPath, JSON.stringify({ height: newHead.header.index, hash: newHead.header.hash }));
        console.log(`[sync] Reorg complete. New head #${newHead.header.index}`);
      } else if (newHead.header.hash === block.header.hash) {
        // Normal forward block
        console.log(`[sync] block #${block.header.index} from ${source || 'peer'}`);
        for (const tx of block.transactions) {
          try { this.engine.executeTransaction(tx, block.header.index); } catch (e) {}
        }
      } else if (newHead.header.hash !== latest.header.hash && newHead.header.hash === block.header.hash) {
        console.log(`[sync] competing at #${block.header.index} — current chain heavier`);
      }
    });

    this.p2p.on('blockResponse', (block: Block) => {
      const latest = this.engine.getLatestBlock();
      if (latest && block.header.index === latest.header.index + 1 && block.header.previousHash === latest.header.hash) {
        for (const tx of block.transactions) {
          try { this.engine.executeTransaction(tx, block.header.index); } catch (e) {}
        }
        this.store.saveBlock(block);
        console.log(`[sync] fetched #${block.header.index}`);
      }
    });

    this.p2p.on('peer:connect', (info: any) => {
      console.log(`[p2p] connected to ${info.nodeId || info.url}`);
      const latest = this.engine.getLatestBlock();
      if (latest) {
        this.p2p.requestBlock(latest.header.index + 1, info.url);
      }
    });

    await this.p2p.start();
    this.apiServer = createApiServer(this.engine, this.p2p, this.config.name, this.config.apiPort);

    for (const peer of this.config.peers) this.p2p.connect(peer);

    const latest = this.engine.getLatestBlock();
    console.log(`\n=== ${this.config.name} ===`);
    console.log(`  Address:   ${this.keyPair.address}`);
    console.log(`  P2P:       ws://${this.config.p2pHost}:${this.config.p2pPort}`);
    console.log(`  API:       http://localhost:${this.config.apiPort}`);
    console.log(`  Synced:    #${latest?.header.index ?? 0}`);
    console.log('===================\n');

    if (this.config.validator) {
      this.timers.push(setInterval(() => {
        const txs = this.mempool.splice(0, Math.min(100, this.mempool.length));
        const block = this.engine.produceBlock(txs, { address: this.keyPair.address, publicKey: this.keyPair.publicKey, privateKey: this.keyPair.privateKey });
        this.p2p.sendBlock(block);
      }, 10000));
    }

    this.timers.push(setInterval(() => {
      const latest = this.engine.getLatestBlock();
      this.p2p.sendHeartbeat({
        nodeId: this.config.name, timestamp: Date.now(),
        blockHeight: latest?.header.index ?? 0, activeTasks: 0, availableCapacity: 0,
        headHash: latest?.header.hash ?? '0',
      });
    }, 30000));
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.p2p.stop();
    this.apiServer?.server?.close?.();
    this.store.close();
    await terminateZkWorkers();
  }
}
