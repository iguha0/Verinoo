# ZK Scaling Benchmarks

Generated 2026-08-23T22:55:31.230Z — Groth16 prover (snarkjs, Node v25.9.0), BN254, pot12 setup.

## Measured (real compiled circuits)

| Layer N×N | Constraints | Witness | Prove | Verify | Proving key |
|---|---|---|---|---|---|
| 4×4 | 20 | 5.36ms | 35ms | 10.83ms | 19KB |
| 8×8 | 72 | 3.69ms | 31.6ms | 10.4ms | 63KB |
| 16×16 | 272 | 5.23ms | 62.46ms | 9.64ms | 232KB |
| 32×32 | 1056 | 11.91ms | 165.23ms | 10.97ms | 890KB |
| 48×48 | 2352 | 10.59ms | 275.8ms | 11.95ms | 1944KB |
| 64×64 | 4160 | 15.74ms | 735.18ms | 53.45ms | 3491KB |

Constraint model validated: measured = N² + N (products + output-only commitment).

## Extrapolated to real model layers

Groth16 prover cost modeled as t ≈ k·c·log₂(c), calibrated on the largest measured circuit.

| Layer | Est. constraints | Est. prove time |
|---|---|---|
| GPT-2 small attn proj (768x768) | 5.91e+5 | 2.8min |
| GPT-2 small FFN (3072x768) | 2.36e+6 | 12.3min |
| LLaMA-7B FFN (11008x4096) | 4.51e+7 | 4.7h |
| Phi-2 single layer (2560x2560) | 6.56e+6 | 36.4min |
| Phi-2 full model (~2.7B params) | 1.35e+9 | 7.0days |

## The wall, quantified

- A single Phi-2 full model proof would take **7.0days** with today's stack.
- Verifying one inference honestly means proving every layer — multiply accordingly.
- This is why the roadmap is hybrid verification (see docs/HYBRID_VERIFICATION.md):
  optimistic execution + sampled spot-proofs instead of prove-everything.

