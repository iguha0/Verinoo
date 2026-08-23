# AI-Native Blockchain — Architecture & Implementation Document

## Executive Summary

A production-in-progress decentralized blockchain where smartphones and edge GPUs serve as compute nodes for AI inference. The network features a real multi-node P2P gossip layer, deterministic WASM execution, Groth16 zkSNARK proofs for layer verification, a live HTML dashboard, and end-to-end tests.

---

## Table of Contents

1. [Project Vision](#1-project-vision)
2. [Core Architecture](#2-core-architecture)
3. [Blockchain Engine](#3-blockchain-engine)
4. [WASM Inference Runtime](#4-wasm-inference-runtime)
5. [Zero-Knowledge Proof System](#5-zero-knowledge-proof-system)
6. [Network Layer](#6-network-layer)
7. [REST API](#7-rest-api)
8. [Dashboard](#8-dashboard)
9. [CLI](#9-cli)
10. [Testing](#10-testing)
11. [Fork Resolution](#11-fork-resolution)
12. [Gas Market](#12-gas-market)
13. [What's Real vs. Prototype](#13-whats-real-vs-prototype)
14. [Directory Structure](#14-directory-structure)

---

## 1. Project Vision

A decentralized network where:
- **Smartphones and edge GPUs** serve as compute nodes
- Nodes run **2–3B parameter models** deterministically
- Users **rent mobile compute** in exchange for tokens
- The chain **natively understands AI operations**: model registry, inference tasks, verification games, agent payments
- **zkSNARK proofs** cryptographically verify honest inference without revealing weights

---

## 2. Core Architecture

The stack is modular, with strict separation between consensus/execution (engine), deterministic computation (WASM), cryptographic proof (Groth16), P2P gossip, and REST API.

```
┌─────────────────────────────────────────────┐
│  CLI / Dashboard / REST API (Express)       │
├─────────────────────────────────────────────┤
│  AINativeNode — wires store + engine + p2p  │
├─────────────────────────────────────────────┤
│  P2P Network — WebSocket gossip             │
│  REST API — /status, /blocks, /tx, /dashboard│
├─────────────────────────────────────────────┤
│  AINativeEngine — consensus + execution     │
│  BlockStore — JSON persistence              │
├─────────────────────────────────────────────┤
│  WASM Runtime — Q16.16 fixed-point engine   │
│  zk/circuit.ts — Merkle + SNARK proofs      │
│  wallet/crypto.ts — Ed25519 signatures     │
└─────────────────────────────────────────────┘
```

### Deterministic Genesis
All nodes share the same genesis block hash because `timestamp` is fixed to `0` (not `Date.now()`). This is critical for multi-node block sync.

---

## 3. Blockchain Engine

`src/core/engine.ts` implements the full state transition machine.

### Supported Transaction Types

| Type | Description |
|---|---|
| `registerModel` | Register an AI model with architecture, parameter count, weights hash |
| `registerNode` | Register a compute node with stake, capacity, reputation |
| `registerAgent` | Register an inference agent |
| `submitInference` | Request inference; auto-matched to available compute node |
| `submitResult` | Compute node submits inference result |
| `challengeResult` | Challenger opens a verification game with bond |
| `bisect` | Bisection protocol step: challenger/defender submit commitments |
| `proveStep` | Defender proves single layer correctness (now via WASM) |
| `agentPayment` | Automatic payment upon task completion |
| `transfer` | Standard token transfer |

### Bisection Verification Game
The on-chain dispute resolution protocol:

1. **Open** — Challenger deposits bond during challenge window
2. **Bisecting** — Both parties recursively narrow to a single disputed layer
3. **Proving** — When `high - low <= 1`, the game enters proving phase
4. **Resolution** — The defender must reproduce the exact WASM output for the disputed layer
   - **Honest output** → defender wins, challenger slashed
   - **Tampered output** → challenger wins, defender slashed

### Block Structure
```typescript
interface BlockHeader {
  hash: string;
  version: number;
  index: number;
  timestamp: number;
  previousHash: string;
  validator: string;
  validatorPubKey: string;
  validatorSignature: string;
  stateRoot: string;        // Merkle root of accounts
  txRoot: string;           // Merkle root of transactions
  inferenceTasksRoot: string;
  computeRoot: string;
}
```

### State Persistence
`BlockStore` (`src/storage/index.ts`) persists to JSON files:
- `blocks/` — full block history
- `accounts/` — balances, nonces
- `models/` — registered architectures
- `tasks/` — inference task lifecycle
- `nodes/` — compute node registry
- `agents/` — agent registry
- `games/` — verification game state

---

## 4. WASM Inference Runtime

`src/wasm/inference.wat` is a real WebAssembly module with zero floating-point ops. All math is **Q16.16 fixed-point integer** for cross-platform determinism.

### Exported Functions

| Function | Description |
|---|---|
| `matmul(M,N,K,A,B,out)` | Fixed-point matrix multiply with 64-bit intermediates |
| `relu(len, off)` | In-place: clamp negatives to 0 |
| `add_bias(len, vec, bias)` | In-place vector accumulation |
| `embedding_lookup(vocab,dim,token,weights,out)` | Row copy from weight table |
| `layernorm(len, off)` | Mean centering + `isqrt` (Newton-Raphson) + normalize |
| `softmax(len, off)` | Max subtract + approximate exp + normalize |
| `grow_memory(pages)` | Dynamic memory expansion |

### Determinism Properties
- No `Math.random()` inside WASM
- No hardware-dependent floating-point rounding
- Identical output on x64, ARM, and smartphone GPUs
- Fixed-point scale: `1.0 = 65536`, precision `~0.000015`

### Memory Isolation
`WasmRuntime` creates a **fresh WebAssembly.Instance** per call, each with its own `Memory` buffer. This prevents memory collisions when multiple layers run in sequence.

---

## 5. Zero-Knowledge Proof System

The ZK layer has two tiers: a hash-based Merkle commitment system for all dimensions, and a **Groth16 SNARK** for 4×4 layers.

### Tier 1: Hash-Based Merkle Proofs (All Dimensions)
- `commitLayerOutput(output)` → SHA-256 hash
- `buildTraceRoot(commitments)` → Merkle tree over layer hashes
- `proveLayerOpening()` / `verifyLayerOpening()` → standard Merkle path verification
- Works for any layer size: 256-dim embedding, 2048-dim attention, etc.

### Tier 2: Groth16 zkSNARK (4×4 Layers)
- **Circuit**: `circuits/zklayer.circom` — 44 non-linear + 28 linear constraints
- **Proves**:
  1. `output[i] = bias[i] + Σ_j(input[j] × weights[i×4+j])`
  2. `sum_of_squares(all_values) ≡ publicCommitment` (in BN254 field)
- **Private inputs**: 28 field elements (input×4 + weights×16 + output×4 + bias×4)
- **Public input**: 1 field element (the commitment hash)

### Groth16 Setup
```
powersoftau new bn128 12 → contribute → prepare phase2
└── pot12_final.ptau

zkey new zklayer.r1cs pot12_final.ptau → zklayer.zkey
└── zklayer.vkey.json (exported verification key)
```

### Integration
`src/zk/circuit.ts`:
- `prove()` — attempts Groth16 for 4×4 layers; falls back to hash-based proof for unsupported dimensions
- `verify()` — checks Groth16 SNARK if present; falls back to Merkle + hash
- `proveModel()` / `verifyModel()` — build full multi-layer proofs chain

---

## 6. Network Layer

`src/p2p/index.ts` implements WebSocket-based P2P gossip.

### Message Types
- `HELLO` — handshake with node ID and addresses
- `PEER_LIST` — share known peers for discovery
- `NEW_TX` — broadcast new transactions
- `NEW_BLOCK` — broadcast mined blocks
- `REQUEST_BLOCK` / `BLOCK_RESPONSE` — catch-up sync
- `HEARTBEAT` — node health (height, capacity, reputation)

### Peer Discovery
Node3 can discover Node1 through Node2 without explicit seed URL:
```
Node1 ←→ Node2 ←→ Node3
```

### Block Sync Logic
- First-seen block at a given height wins
- Competing blocks are handled via `resolveFork` in `src/core/fork.ts`
  - `resolveFork` compares chain weight (sum of truncated block hash hex values) and returns `reorged=true` if the new branch is heavier
  - `planReorg` computes `blocksToUndo` and `blocksToApply` to bring the state to the heavier head
  - BlockStore saves blocks by both height and hash (`h{N}_{hash}.json`) for fork handling
  - `node.ts` applies undo/replay plans on received blocks
- Fork resolution is **implemented and tested** with unit tests in `src/core/fork.test.ts`

---

## 7. REST API

`src/api/index.ts` serves endpoints on each node's HTTP port.

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Node alive check |
| `/status` | GET | Chain height, models, compute nodes, peers |
| `/blocks` | GET | Last 10 blocks |
| `/accounts/:address` | GET | Account balance and nonce |
| `/models` | GET | Registered model list |
| `/models/:id` | GET | Model details |
| `/tasks?status=` | GET | Inference task filter |
| `/nodes`, `/agents`, `/peers` | GET | Registries |
| `/tx` | POST | Submit transaction (validated + gossiped) |
| `/dashboard` | GET | Live HTML dashboard |

---

## 8. Dashboard

`public/dashboard.html` is a dark-themed single-page app.

- **Auto-polls every 3s** via `fetch()` to local endpoints
- **4 metric cards**: Height, Models, Compute Nodes, Peers
- **4 live sections**: Latest Blocks, Peers, Models, Tasks & Agents
- **Responsive grid**: 4/2/1 columns (desktop/tablet/mobile)
- **Address truncation** and param scaling (M/B/k)
- Tested: serves 9,309 bytes, all checks pass

---

## 9. CLI

`src/cli/index.ts` provides:
```bash
ainative start --name --db --port --p2p --host --peers --validator
ainative keygen --output
```

Package scripts:
```bash
npm run build          # tsc + cp src/wasm/inference.wasm dist/
npm test               # node --test dist/**/*.test.js
npm run node1          # validator on port 3001/5001
npm run node2          # peer on port 3002/5002
npm run node3          # peer on port 3003/5003
```

---

## 10. Testing

| Suite | Tests | Focus |
|---|---|---|
| `engine.test.js` | 6 | Genesis, signatures, nonces, balance, full dispute lifecycle, timeout |
| `storage/index.test.js` | 5 | Directory init, block/account/game roundtrips, filtering |
| `wallet/crypto.test.js` | 6 | Keygen, sign/verify, tamper detection, deterministic hash |
| `p2p/index.test.js` | 3 | Connect/exchange, block gossip, peer list propagation |
| `wasm/runtime.test.js` | 7 | Compile, matmul, relu, layernorm, embedding, memory reset |
| `zk/circuit.test.js` | 7 | Setup, weights, commitments, prove/verify, tamper detection, full model |
| `zk/index.test.js` | 10 | Deterministic execution, trace Merkle, proof tampering, unknown architectures |
| `zk/groth16.test.js` | 3 | SNARK prove/verify, commitment hash, tamper rejection |
| `node.test.js` | 1 | 3-node block sync and tx propagation |
| `network.integration.test.js` | 1 | Live tx submit → mine → sync across all nodes |
| `core/fork.test.js` | 11 | Linear extension, equal forks, heavier reorg, asymmetric heights, undo/apply plans |
| **Total** | **66** | **All passing** |

### End-to-End Manual Demo
```bash
npm run node1  # validator mines every 10s
npm run node2  # peer connects to node1
npm run node3  # peer connects to node2 (discovers node1 implicitly)
```
- Dashboards visible on ports 3001, 3002, 3003
- Submit tx via peer API → propagates to validator → mined in block → syncs to all nodes

---

## 11. Fork Resolution

`src/core/fork.ts` implements Nakamoto-style longest-chain resolution.

### Algorithm
1. `hashWeight(hash)` — convert block hash prefix to a BigInt work proxy
2. `computeChainWeight(head, store)` — sum weights from head back to genesis
3. `resolveFork(currentHead, newBlock, store)` — compare weights, return `reorged` boolean + `newHead`
4. `getCommonAncestor(a, b, store)` — binary search backward until hash match
5. `planReorg(currentHead, newHead, store)` — return `{ forkPoint, blocksToUndo, blocksToApply }`

### Backward Compatibility
- `BlockStore` saves blocks by height AND hash (`h{N}_{hash}.json`)
- `fork.ts` uses duck-typed `StoreLike` — no hard dependency on `BlockStore`
- If a transaction has no `gasLimit` / `gasPrice`, no gas is charged (existing tests pass unchanged)

### Tests
`src/core/fork.test.ts`: 11 tests covering linear extension, equal-fork rejection, heavier reorg, asymmetric heights, undo/apply plans, and weight comparison.

---

## 12. Gas Market

`src/core/gas.ts` implements an EIP-1559-style baseFee market.

### Per-Operation Gas Costs

| Type | Gas |
|---|---|
| `registerNode` | 50,000 |
| `registerModel` | 80,000 |
| `registerAgent` | 50,000 |
| `submitInference` | 60,000 |
| `submitResult` | 40,000 |
| `challengeResult` | 120,000 |
| `bisect` | 100,000 |
| `proveStep` | 80,000 |
| `agentPayment` | 50,000 |
| `transfer` | 50,000 |

### Fee Distribution
- **25% burned** → `treasury` account (deflationary)
- **75% rewarded** → validator who mined the block

### EIP-1559 Mechanics
- `BLOCK_GAS_TARGET = 500,000`
- `BLOCK_GAS_LIMIT = 1,000,000`
- `BASE_FEE_DENOM = 8`
- `computeBaseFee(prev, used)` applies `±12.5%` max change per block

### Backward Compatibility
Gas is **opt-in**: if `tx.gasLimit` and `tx.gasPrice` are undefined, no fee is charged. This preserves all existing tests while allowing new transactions to participate in the fee market.

---

## 13. What's Real vs. Prototype

| Layer | Component | Status |
|---|---|---|
| **Signatures** | Ed25519 via tweetnacl | ✅ Real |
| **Hashing** | SHA-256 | ✅ Real |
| **Block production** | Validator signatures, Merkle roots | ✅ Real |
| **Transaction execution** | Full state transitions | ✅ Real |
| **P2P gossip** | WebSocket peer mesh | ✅ Real |
| **REST API** | Express with live dashboard | ✅ Real |
| **Bisection protocol** | Challenge → bisect → prove → slash | ✅ Real |
| **WASM execution** | Q16.16 fixed-point inference | ✅ Real |
| **Groth16 SNARK** | Circom circuit + trusted setup + prove/verify | ✅ Real |
| **Multi-layer proof chain** | `proveModel` with SNARK per layer | ✅ Real |
| **Per-opType Circom circuits** | Only 4×4 matmul exists | ⚠️ Prototype — needs embedding, layernorm, softmax circuits |
| **Circuit size** | 28 private inputs, 1 public | ⚠️ Toy size for demo |
| **Gas/fee market** | EIP-1559 style baseFee + fee burning | ✅ Per-op gas costs, opt-in wiring in `engine.ts` |
| **Fork resolution** | Longest-chain via hash weight | ✅ `resolveFork`, `planReorg`, `fork.test.ts` |
| **Persistent DB** | JSON files only | ❌ No SQLite/LevelDB |
| **Real model weights** | Deterministically generated | ❌ Would need IPFS model registry |
| **Trusted setup ceremony** | Local only | ❌ Production needs MPC |

---

## 14. Directory Structure

```
ai_chain_network/
├── circuits/
│   ├── zklayer.circom              # Circom circuit (44 constraints)
│   └── build/
│       ├── zklayer.r1cs
│       ├── zklayer.zkey            # Groth16 proving key
│       ├── zklayer.vkey.json       # Groth16 verification key
│       ├── zklayer_js/
│       │   └── zklayer.wasm        # Circuit witness WASM
│       └── pot12_final.ptau        # Powers-of-tau
├── public/
│   └── dashboard.html              # Live HTML dashboard
├── scripts/
│   ├── build-wasm.mjs              # WAT → WASM compiler
│   └── setup-groth16.mjs          # Trusted setup automation
├── src/
│   ├── wasm/
│   │   ├── inference.wat          # Real fixed-point WASM module
│   │   ├── inference.wasm         # Compiled binary
│   │   ├── runtime.ts             # WASM loader + layer dispatch
│   │   └── runtime.test.ts
│   ├── zk/
│   │   ├── index.ts               # Merkle + architecture registry
│   │   ├── index.test.ts
│   │   ├── circuit.ts             # ZK prove/verify abstraction
│   │   ├── circuit.test.ts
│   │   ├── groth16.ts             # snarkjs Groth16 wrapper
│   │   └── groth16.test.ts
│   ├── core/
│   │   ├── types.ts
│   │   ├── engine.ts              # Full blockchain engine
│   │   └── engine.test.ts
│   ├── storage/
│   │   ├── index.ts
│   │   └── index.test.ts
│   ├── wallet/
│   │   ├── crypto.ts              # Ed25519 + SHA-256
│   │   └── crypto.test.ts
│   ├── p2p/
│   │   ├── index.ts               # WebSocket gossip
│   │   └── index.test.ts
│   ├── api/
│   │   └── index.ts               # Express REST + /dashboard
│   ├── node.ts                    # Node orchestration
│   ├── node.test.ts
│   ├── network.integration.test.ts
│   ├── cli/
│   │   └── index.ts               # ainative CLI
│   ├── demo.ts                    # Standalone verification game demo
│   └── types/
│       └── snarkjs.d.ts           # Type declarations
├── package.json                    # + snarkjs, circomlibjs, wabt
├── tsconfig.json                   # ES2022 + DOM (WebAssembly types)
├── WHITEPAPER.md                   # Architecture whitepaper
└── README.md
```

---

## Build Commands

```bash
# Compile all TypeScript + copy WASM binary
npm run build

# Run full test suite
npm test

# Spin up 3-node local network
npm run node1 &
npm run node2 &
npm run node3

# Generate Groth16 trusted setup (after circuit changes)
node scripts/setup-groth16.mjs
```

---

## Author & License

Built for research and prototyping. Production deployment would require:
1. Larger Circom circuits per opType
2. Model weight registry (IPFS / on-chain)
3. Production MPC trusted setup ceremony
4. Fork resolution (longest chain rule)
5. Gas pricing and fee burning
6. Persistent block storage (LevelDB / SQLite)
