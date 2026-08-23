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
  listenUrl: string; // stable advertised endpoint, e.g. ws://127.0.0.1:5001
  outgoing: boolean;
  lastSeen: number;
}

/** Canonicalize an announced host so 0.0.0.0/localhost match 127.0.0.1. */
function canonicalHost(host: string): string {
  if (!host) return '127.0.0.1';
  const h = host.trim().toLowerCase();
  if (h === '0.0.0.0' || h === 'localhost' || h === '::' || h === '[::]' || h === '') return '127.0.0.1';
  return h;
}

function listenUrlOf(host: string, port: number | string): string {
  return `ws://${canonicalHost(host)}:${port}`;
}

/** Destroy a socket that may still be handshaking; ensures an 'error'
 *  listener exists so terminate()'s abort error is never unhandled. */
function rejectSocket(ws: WebSocket): void {
  ws.on('error', () => {});
  try { ws.terminate(); } catch (e) {}
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

  /** Every URL that refers to this node's own listener (any host alias). */
  private ownUrls(): Set<string> {
    const urls = new Set<string>();
    for (const h of ['127.0.0.1', 'localhost', '0.0.0.0', this.config.host]) {
      urls.add(`ws://${canonicalHost(h)}:${this.config.port}`);
    }
    return urls;
  }

  /** True if we already have a live connection to the same node identity
   *  (same advertised listen URL or same nodeId), excluding `except`. */
  private hasDuplicate(listenUrl: string, nodeId: string, except?: PeerInfo): boolean {
    if (nodeId && nodeId === this.nodeId) return true;
    for (const info of this.peers.values()) {
      if (info === except) continue;
      if (info.nodeId && nodeId && info.nodeId === nodeId) return true;
      if (listenUrl && info.listenUrl === listenUrl) return true;
    }
    return false;
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
    if (this.ownUrls().has(`ws://${canonicalHost(this.hostOf(peerUrl))}:${this.portOf(peerUrl)}`)) return;
    if (this.hasDuplicate(listenUrlOf(this.hostOf(peerUrl), this.portOf(peerUrl)), '')) return;
    if (this.peers.size >= this.config.maxPeers) return;
    try {
      const ws = new WebSocket(peerUrl);
      this.addPeer(ws, peerUrl, true);
    } catch (e) {}
  }

  private hostOf(url: string): string {
    const m = url.match(/^wss?:\/\/([^:]+)/);
    return m ? m[1] : url;
  }

  private portOf(url: string): string | number {
    const m = url.match(/:(\d+)\/?$/);
    return m ? m[1] : '';
  }

  private addPeer(ws: WebSocket, url: string, outgoing: boolean): void {
    const candidateListenUrl = listenUrlOf(this.hostOf(url), this.portOf(url));
    if (this.ownUrls().has(candidateListenUrl)) { rejectSocket(ws); return; }
    if (this.peers.has(url)) { rejectSocket(ws); return; }

    const info: PeerInfo = { ws, url, nodeId: '', address: '', listenUrl: '', outgoing, lastSeen: Date.now() };
    this.peers.set(url, info);

    ws.on('open', () => {
      this.send(ws, { type: 'HELLO', payload: { nodeId: this.nodeId, host: this.config.host, port: this.config.port }, from: this.nodeId, timestamp: Date.now() });
    });

    ws.on('message', (raw) => {
      try {
        const msg: Msg = JSON.parse(raw.toString());
        if (msg.from && msg.from === this.nodeId) { this.drop(info); return; } // self-loop guard
        this.handleMessage(ws, msg, info);
      } catch (e) {
        ws.terminate();
      }
    });

    ws.on('close', () => {
      this.peers.delete(url);
      this.emit('peer:disconnect', url);
    });

    ws.on('error', () => ws.terminate());
  }

  /** Remove a peer entry and destroy its socket (used for duplicate/self drops). */
  private drop(info: PeerInfo): void {
    if (this.peers.get(info.url) === info) this.peers.delete(info.url);
    rejectSocket(info.ws);
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
        // A peer announcing our own nodeId is a self-loop — drop it.
        if (p.nodeId === this.nodeId) { this.drop(info); return; }
        info.nodeId = p.nodeId;
        info.address = p.address || '';
        const theirUrl = listenUrlOf(p.host, p.port);
        info.listenUrl = theirUrl;

        // Drop duplicate connections to the same node (keep the newest socket).
        if (this.hasDuplicate(theirUrl, p.nodeId, info)) {
          // If another live entry already represents this node, keep it and drop us.
          let kept: PeerInfo | null = null;
          for (const other of this.peers.values()) {
            if (other !== info && (other.nodeId === p.nodeId || (other.listenUrl && other.listenUrl === theirUrl))) { kept = other; break; }
          }
          this.drop(info);
          if (kept) this.send(kept.ws, { type: 'PEER_LIST', payload: this.advertisedUrls(kept), from: this.nodeId, timestamp: Date.now() });
          return;
        }

        // Connect back for incoming connections when we don't yet have them
        if (!info.outgoing && !this.hasDuplicate(theirUrl, '', info) && this.peers.size < this.config.maxPeers) {
          this.connect(theirUrl);
        }
        this.emit('peer:connect', { url: theirUrl, nodeId: p.nodeId, address: p.address });
        // Share our peers
        this.send(ws, { type: 'PEER_LIST', payload: this.advertisedUrls(info), from: this.nodeId, timestamp: Date.now() });
        break;
      }

      case 'PEER_LIST': {
        for (const p of msg.payload || []) {
          const u = listenUrlOf(this.hostOf(p), this.portOf(p));
          if (!this.ownUrls().has(u)) this.connect(u);
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

  /** Stable listen URLs of connected peers to advertise, excluding the
   *  recipient and ourselves; falls back to connection URL until HELLO. */
  private advertisedUrls(exclude: PeerInfo): string[] {
    const own = this.ownUrls();
    const urls = new Set<string>();
    for (const pi of this.peers.values()) {
      if (pi === exclude) continue;
      const u = pi.listenUrl || listenUrlOf(this.hostOf(pi.url), this.portOf(pi.url));
      if (own.has(u)) continue;
      if (u === exclude.listenUrl) continue;
      if (!u || u.endsWith(':')) continue;
      urls.add(u);
    }
    return Array.from(urls).slice(0, 20);
  }

  getConnectedPeers(): { url: string; nodeId: string; address: string }[] {
    return Array.from(this.peers.values()).map(p => ({ url: p.listenUrl || p.url, nodeId: p.nodeId, address: p.address }));
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
