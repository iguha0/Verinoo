# AINative Chain

**An experimental AI-native blockchain where compute nodes run model layers in deterministic WASM, back results with Groth16 zkSNARKs, and settle disputes with bisection games — so verification cost stays flat while models grow without bound.**

> Research prototype. Executable spec, not a product. Every number below is
> measured in this repo — see [docs/ZK_BENCHMARKS.md](docs/ZK_BENCHMARKS.md).

| | |
|---|---|
| Tests | **98 passing** (19 suites) |
| Circuits | 5 real Groth16 circuits (circom 2 + snarkjs/rapidsnark) |
| Prover | Native C++ by default ([rapidsnark](https://github.com/iden3/rapidsnark)), JS fallback |
| License | AGPL-3.0 |

---

## Why this exists

"AI on blockchain" usually means one of two broken ideas: prove *everything*
(infeasible) or verify *nothing* (trust me bro). This project measures the
first wall, then engineers around it:

| Approach | Cost for a 2.7B-param inference | Verdict |
|---|---|---|
| Groth16-prove every layer | **~7 days** per inference | measured & extrapolated — dead end |
| Trust the compute node | $0 | fraud is free |
| **Hybrid: stake → sample op-level proofs → full proof only on dispute** | **~constant**, independent of model size | this repo |

Sampling math: 22 random spot-checks catch ≥90% of fraud touching ≥10% of
layers (`1 − 0.9²² < 0.1`). Model size never enters the equation.

## The circuits

All five compile with circom 2, run trusted setup automatically, and resolve
on-chain disputes via a SNARK fast path. Each has a bit-exact integer spec
(`src/zk/*.ts`) differentially tested against the WASM runtime.

| Circuit | What it proves | Constraints |
|---|---|---|
| `zklayer_slim` | dense layer: `out = bias + Σ inp·w` | N²+N (20 @ 4×4, 4,160 @ 64×64) |
| `relu8` | `out = max(0, x)` via sign decomposition | 280 |
| `argmax8` | `(idx, max)` is a valid maximizer | 280 |
| `layernorm8` | integer mean/variance/sqrt/reciprocal | 376 |
| `softmax8` | hard-max-with-margin rule, proven division | 552 |

## The chain

- **Engine** — Ed25519 blocks, fork resolution by hash weight, reorg handling
- **WASM runtime** — Q16.16 fixed-point ops; zero floating point in execution
- **Dispute games** — challenge → bisect → proveStep, slashing both directions
- **Gas market** — EIP-1559-style baseFee; verification-policy pricing
  (`optimistic ×1 / sampled ×2 / full-zk ×4`)
- **P2P** — WebSocket gossip with identity-keyed peer dedup
- **API** — REST on every node (token-auth mutations, rate-limited), live
  dashboard at `/dashboard`, landing site at `/`

## Quick start

```bash
git clone https://github.com/iguha0/ai-chain-network
cd ai-chain-network
npm install && npm run build

# native proving (~5x faster); optional but recommended
npm run setup:rapidsnark

# three-node local network
npm run node1 &
npm run node2 &
npm run node3 &

open http://localhost:3001/dashboard   # live block explorer
```

```bash
npm test                               # 98 tests, 19 suites
npm run bench:zk                       # regenerate the scaling-wall report
npm run bench:provers                  # snarkjs vs rapidsnark on your machine
```

## Deployment

One VPS runs the whole public network: three systemd-managed nodes behind
nginx/TLS, static site at `/`, chain API proxied to the validator.
Step-by-step guide in [deploy/README.md](deploy/README.md), including a
two-box topology for WAN gossip testing.

## Repository map

```
src/core      engine, fork resolution, gas market
src/wasm      inference.wat + Q16.16 runtime        ← single execution truth
src/zk        op specs, circom wrappers, prover abstraction
circuits/     .circom sources (build: npm run build:ops)
src/p2p       WebSocket gossip layer
src/api       Express REST + dashboard + site
deploy/       VPS kit: systemd units, nginx, TLS, updates
docs/         benchmarks + hybrid-verification design
scripts/      circuit builds, setups, benchmark harnesses
website/      zero-build landing page
```

## Status: what's real, what isn't

**Real:** everything listed above, verified by tests you can run.
**Prototype-grade:** circuit sizes (n=8 / 4×4 tiles), local-only trusted
setup, deterministic seeded weights, single-validator production.
**Explicit non-goal:** proving frontier models end-to-end (~7 days/proof at
2.7B params — that measurement is why the hybrid design exists).

Full table: [ARCHITECTURE.md §13](ARCHITECTURE.md). Where this goes next:
[ROADMAP.md](ROADMAP.md). Contribution rules:
[CONTRIBUTING.md](CONTRIBUTING.md) — the short version: bit-exact specs get
differential tests, `npm test` gates every PR, honesty outranks marketing.

## License

[GNU AGPL-3.0](LICENSE) — network-copyleft: if you run a modified version as
a service, users are entitled to its source. Research use, forks, and
experiments: go wild.
