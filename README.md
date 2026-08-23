# AI-Native Blockchain Network

A decentralized network where smartphones and edge GPUs serve as compute nodes for AI inference, with real Groth16 zkSNARK proofs verifying honest execution.

## Quick Start

```bash
# Install dependencies
npm install

# Compile TypeScript + WASM binary
npm run build

# Run full test suite
npm test

# Start a 3-node local network
npm run node1 &   # validator
npm run node2 &   # peer (connects to node1)
npm run node3 &   # peer (connects to node2, discovers node1)

# Open dashboards
open http://localhost:3001/dashboard
open http://localhost:3002/dashboard
open http://localhost:3003/dashboard
```

## What's This?

- **Multi-node blockchain** with P2P gossip, block sync, Ed25519 signatures, and deterministic genesis
- **Real WASM inference** — Q16.16 fixed-point matmul, ReLU, layer norm, softmax (zero floating-point)
- **Groth16 zkSNARKs** — Circom circuit proving knowledge of honest inference without revealing weights
- **Live dashboard** — auto-polling block explorer + peer health + model registry
- **Verification games** — on-chain bisection protocol resolving AI inference disputes

## Architecture Document

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full technical breakdown of every layer.

## Test Results

```
66 tests across 15 suites — all passing
```

| Layer | Tests | Status |
|---|---|---|
| Engine + Gas Market | 9 | ✅ |
| Fork Resolution | 11 | ✅ |
| Storage (SQLite) | 7 | ✅ |
| Crypto | 6 | ✅ |
| P2P | 4 | ✅ |
| WASM Runtime | 7 | ✅ |
| ZK Circuit | 7 | ✅ |
| ZK Index | 10 | ✅ |
| Groth16 SNARK | 3 | ✅ |
| API Security | 4 | ✅ |
| Node Sync | 1 | ✅ |
| Live Network | 1 | ✅ |

## Commands

```bash
# CLI
npx ts-node src/cli/index.ts start --name=node1 --port=3001 --p2p=5001 --validator
npx ts-node src/cli/index.ts start --name=node1 --api-token=secret   # require auth for mutating API calls (or AIN_API_TOKEN env)
npx ts-node src/cli/index.ts keygen --output=key.json

# Build WASM (if inference.wat changes)
node scripts/build-wasm.mjs

# Regenerate Groth16 trusted setup (if zklayer.circom changes)
node scripts/setup-groth16.mjs
```

## License

GPL-3.0
