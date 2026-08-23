# Hybrid Verification — Design Document

*Status: design. Grounded in measured numbers from [ZK_BENCHMARKS.md](./ZK_BENCHMARKS.md).*

## 1. Problem Statement

The chain must verify that off-chain AI inference was executed honestly.
Today there are two extreme options, and both fail at scale:

| Approach | Cost | Failure mode |
|---|---|---|
| **Re-execute** (current bisection games) | Full WASM recompute per dispute | Verifier does as much work as the compute node |
| **Prove everything** (Groth16 per layer) | Measured: 32×32 layer = 2144 constraints ≈ 187 ms; a Phi-2-scale model ≈ 2.7B constraints ≈ **7.7 days per proof** | Proving cost exceeds the value of the inference by orders of magnitude |

The honest conclusion from the benchmarks: *prove-everything is not viable
for billion-parameter models on today's stack*. But neither is trust.

## 2. Design Goal

Maximize the probability of detecting fraud subject to a verification budget
that is a small fraction of inference cost:

```
P(catch) = 1 - (1 - p_sample)^L_fraud
```

where `p_sample` is the per-layer spot-check probability and `L_fraud` is the
number of layers a cheating node must falsify consistently.

## 3. Architecture: Three Tiers of Defense

### Tier 1 — Optimistic execution + staked challenge window (exists today)

- Compute node posts result + collateral (20% of task fee) → `submitResult`
- Anyone can post a bond and open a verification game within
  `challengeWindowEnd` → `challengeResult`
- Dishonest results are only profitable if *no one challenges*, so the bond
  must exceed expected profit of fraud plus the challenger's cost.

**Gap:** full re-execution in games is expensive for big models.

### Tier 2 — Sampled ZK spot-proofs (new)

Instead of proving every layer, the defender proves a randomly-selected subset,
chosen *after* the result is committed (so it cannot pre-compute only those):

```
selection seed = H(resultHash || challengeSeed || blockHash)
layers_to_prove = K layers sampled without replacement
```

- With the current op circuits (~280 constraints, tens of ms), proving an
  entire small-model trace is already practical.
- For matmul layers, prove only the disputed layer identified by bisection —
  this is what `proveStep` should require once circuits scale past 4×4:
  the game narrows L layers to ONE, then pays one proof instead of L.
- Sampling math: to get 90% detection of fraud touching ≥10% of layers,
  sample K where (0.9)^K ≤ 0.1 → K = 22 spot-checks regardless of model size.

### Tier 3 — Statistical + economic backstops

- **Reputation-weighted sampling**: nodes with fewer successful challenges
  get sampled less (they've paid their dues); fresh/slashed nodes more.
- **Slashing asymmetry**: defender loses bond + reputation on proven fraud;
  challenger loses bond on failed challenge. This makes frivolous challenges
  unprofitable while keeping honest challengers whole.
- **Commit-reveal on inputs**: input commitment already exists
  (`inputCommitment`); proofs bind to committed inputs via the public
  sum-of-squares commitment.

## 4. Circuit Roadmap

Measured constraint model for the matmul circuit: `c(N) = 2N² + 3N`.

| Milestone | Target | Constraint budget |
|---|---|---|
| ✅ 4×4 matmul (shipped) | toy demo | 44 |
| ✅ relu8 / argmax8 (shipped) | non-linear ops | 280 each |
| ✅ layernorm8 (shipped) | integer sqrt + reciprocal, bounds-proven | 376 |
| ✅ slim matmul commitment (shipped) | c(N) = N² + N — 2× cheaper proofs | 20 @ 4×4 |
| ✅ sampled-policy gas pricing + proveStep SNARK fast path (shipped) | disputes resolve without recompute | — |
| ✅ 64×64 matmul measured (shipped) | real embedding blocks | 4160, 735 ms (pot14) |
| Then: layernorm via integer sqrt (Newton iter, fixed rounds) | normalization ops | ~40 per element |
| Then: softmax via exp LUT + range checks (lookup args / PSE) | attention | research-grade |

Softmax and layernorm need range checks and division/sqrt — the standard
zkML toolkit is lookup arguments and polynomial approximation with fixed
rounding that matches the WASM runtime bit-for-bit. Both circuits must be
specified against the exact integer semantics of `src/wasm/inference.wat`,
or determinism breaks between prover and verifier.

## 5. What This Changes in the Protocol

1. `proveStep` gains an optional `snarkProof` field: if present and valid,
   the game resolves immediately without WASM recompute (fast path).
2. Task registration carries a `verificationPolicy`:
   `{ type: 'optimistic' } | { type: 'sampled', k: number } | { type: 'full-zk' }`
   priced into gas accordingly (provers are paid for proofs).
3. Fee flow: proof generation is billable work like inference —
   `gasCostFor('proveStep')` already exists; add a proof subsidy from the
   task's `maxFee` when the fast path resolves a game.

## 6. Explicit Non-Goals

- No trusted-setup ceremony (single local party today) — fine for testnet,
  documented risk until MPC ceremony or a universal/setupless system (PLONK-ish).
- No proof aggregation/recursion yet; revisit if sampled proofs become
  the dominant gas consumer.
