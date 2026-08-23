// P2P gossip layer for block/tx propagation
import WebSocket from 'ws';
import { createServer } from 'http';
import EventEmitter from 'events';
import { Block, Transaction, HeartbeatPayload } from '../core/types';

type Msg = { type: string; payload: any; from: string; timestamp: number; };

interface PeerInfo {
  ws: WebSocket;
  url: string;
  nodeId: string;
  address: string;
  outgoing: boolean;
  lastSeen: number;
}

export class P2PNetwork extends EventEmitter {
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wsServer: WebSocket.Server | null = null;
  private peers: Map<string, PeerInfo> = new Map();
  private nodeId: string;
  public config: { host: string; port: number; maxPeers: number };

  constructor(nodeId: string, _addr: string, config: { host: string; port: number; maxPeers?: number }) {
    super();
    this.nodeId = nodeId;
    this.config = { ...config, maxPeers: config.maxPeers ?? 50 };
  }

  async start(): Promise<void> {
    this.httpServer = createServer();
    this.wsServer = new WebSocket.Server({ server: this.httpServer });

    this.wsServer.on('connection', (ws, req) => {
      const url = req.socket.remoteAddress ? `ws://${req.socket.remoteAddress}:${req.socket.remotePort}` : `incoming-${Date.now()}`;
      this.addPeer(ws, url, false);
    });

    return new Promise((resolve) => {
      this.httpServer!.listen(this.config.port, this.config.host, () => {
        console.log(`[p2p] ws://${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
  }

  connect(peerUrl: string): void {
    if (this.peers.has(peerUrl)) return;
    if (this.peers.size >= this.config.maxPeers) return;
    try {
      const ws = new WebSocket(peerUrl);
      this.addPeer(ws, peerUrl, true);
    } catch (e) {}
  }

  private addPeer(ws: WebSocket, url: string, outgoing: boolean): void {
    if (this.peers.has(url)) {
      ws.close();
      return;
    }

    const info: PeerInfo = { ws, url, nodeId: '', address: '', outgoing, lastSeen: Date.now() };
    this.peers.set(url, info);

    ws.on('open', () => {
      this.send(ws, { type: 'HELLO', payload: { nodeId: this.nodeId, host: this.config.host, port: this.config.port }, from: this.nodeId, timestamp: Date.now() });
    });

    ws.on('message', (raw) => {
      try {
        const msg: Msg = JSON.parse(raw.toString());
        this.handleMessage(ws, msg, info);
      } catch (e) {
        ws.close();
      }
    });

    ws.on('close', () => {
      this.peers.delete(url);
      this.emit('peer:disconnect', url);
    });

    ws.on('error', () => ws.close());
  }

  private send(ws: WebSocket, msg: Msg) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcast(msg: Msg, exclude?: string): void {
    for (const [url, info] of this.peers) {
      if (exclude && url === exclude) continue;
      this.send(info.ws, msg);
    }
  }

  private handleMessage(ws: WebSocket, msg: Msg, info: PeerInfo): void {
    info.lastSeen = Date.now();

    switch (msg.type) {
      case 'HELLO': {
        const p = msg.payload;
        info.nodeId = p.nodeId;
        info.address = p.address || '';
        const theirUrl = `ws://${p.host}:${p.port}`;
        if (theirUrl !== `ws://${this.config.host}:${this.config.port}` && !this.peers.has(theirUrl) && this.peers.size < this.config.maxPeers) {
          // Connect back if we don't have them
          if (!info.outgoing) {
            this.connect(theirUrl);
          }
        }
        this.emit('peer:connect', { url: info.url, nodeId: p.nodeId, address: p.address });
        // Share our peers
        const peerUrls = Array.from(this.peers.values())
          .filter(pi => pi.url !== info.url && pi.url !== `ws://${this.config.host}:${this.config.port}`)
          .map(pi => pi.url)
          .slice(0, 20);
        this.send(ws, { type: 'PEER_LIST', payload: peerUrls, from: this.nodeId, timestamp: Date.now() });
        break;
      }

      case 'PEER_LIST': {
        for (const p of msg.payload || []) {
          if (!this.peers.has(p) && p !== `ws://${this.config.host}:${this.config.port}`) {
            this.connect(p);
          }
        }
        break;
      }

      case 'NEW_TX': {
        this.emit('tx', msg.payload as Transaction);
        break;
      }

      case 'NEW_BLOCK': {
        this.emit('block', msg.payload as Block, info.url);
        break;
      }

      case 'REQUEST_BLOCK': {
        this.emit('requestBlock', msg.payload, (block: Block | null) => {
          if (block) this.send(ws, { type: 'BLOCK_RESPONSE', payload: block, from: this.nodeId, timestamp: Date.now() });
        });
        break;
      }

      case 'BLOCK_RESPONSE': {
        this.emit('blockResponse', msg.payload as Block);
        break;
      }

      case 'HEARTBEAT': {
        this.emit('heartbeat', msg.payload as HeartbeatPayload);
        break;
      }
    }
  }

  sendTransaction(tx: Transaction): void {
    this.broadcast({ type: 'NEW_TX', payload: tx, from: this.nodeId, timestamp: Date.now() });
  }

  sendBlock(block: Block): void {
    this.broadcast({ type: 'NEW_BLOCK', payload: block, from: this.nodeId, timestamp: Date.now() });
  }

  sendHeartbeat(payload: HeartbeatPayload): void {
    this.broadcast({ type: 'HEARTBEAT', payload, from: this.nodeId, timestamp: Date.now() });
  }

  requestBlock(height: number, peerUrl: string): void {
    const info = this.peers.get(peerUrl);
    if (info) {
      this.send(info.ws, { type: 'REQUEST_BLOCK', payload: height, from: this.nodeId, timestamp: Date.now() });
    }
  }

  getConnectedPeers(): { url: string; nodeId: string; address: string }[] {
    return Array.from(this.peers.values()).map(p => ({ url: p.url, nodeId: p.nodeId, address: p.address }));
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  stop(): void {
    for (const info of this.peers.values()) info.ws.terminate();
    this.peers.clear();
    this.wsServer?.close(() => {
      this.httpServer?.closeAllConnections?.();
      this.httpServer?.close();
    });
  }
}
