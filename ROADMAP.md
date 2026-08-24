# Roadmap

Where this is, and where it's going. Items move to "done" only with tests +
benchmarks attached. Design detail for the verification tiers lives in
[docs/HYBRID_VERIFICATION.md](docs/HYBRID_VERIFICATION.md).

## Shipped

- [x] Multi-node chain: gossip, sync, fork resolution, reorg handling
- [x] Deterministic WASM inference (Q16.16 fixed-point)
- [x] Groth16 circuits: matmul (slim), relu8, argmax8, layernorm8, softmax8
- [x] Bit-exact op specs + differential testing discipline
- [x] Bisection dispute games with slashing + SNARK fast path
- [x] EIP-1559-style gas market with verification-policy pricing
- [x] SQLite storage + legacy migration; token-auth API + rate limits
- [x] Benchmark harness quantifying the scaling wall; native proving default

## Near term — make it usable by strangers

- [ ] **Public testnet kit**: one-command deploy for a 3-node network on a VPS
      behind nginx/TLS (deploy/ kit), hosted demo linked from the website
- [ ] **JS SDK**: thin client wrapping `POST /tx`, `GET /status`, task lifecycle
      (submit → match → result → challenge), typed models
- [ ] **Explorer UI**: block/task/game browser over the existing REST surface,
      served from the same node at `/explore`
- [ ] CI: GitHub Actions running build + full suite on every PR

## Mid term — deepen the ZK story

- [ ] Larger matmul tiles: pot16/pot18 ladder, N=128..256 measured
- [ ] Proof aggregation or folding-scheme spike (Nova-style layer chains) —
      the research bet that makes per-layer costs additive instead of multiplied
- [ ] rapidsnark witness-gen parity so proving is fully native end-to-end
- [ ] MPC-style distributed trusted setup ceremony (even a small one) for the
      production circuits
- [ ] Real model weights via content-addressed registry (IPFS or similar),
      replacing deterministic seeded weights

## Long term — protocol hardening

- [ ] BFT or PoS validator set replacing single-validator production
- [ ] Verification policy economics: fee market data → tune sampled-k defaults
- [ ] TEE attestation as Tier-1.5 evidence alongside sampled SNARKs
- [ ] Peer discovery hardening (NAT traversal, peer scoring)

## Non-goals (explicitly)

- Proving frontier-scale models end-to-end (measured infeasible; see
  docs/ZK_BENCHMARKS.md)
- Token launch / financial promises — none, until there is a chain worth a token
