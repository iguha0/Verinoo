# ZK Scaling Benchmarks

Generated 2026-08-23T21:53:41.872Z — Groth16 prover (snarkjs, Node v25.9.0), BN254, pot12 setup.

## Measured (real compiled circuits)

| Layer N×N | Constraints | Witness | Prove | Verify | Proving key |
|---|---|---|---|---|---|
| 4×4 | 44 | 7.97ms | 152.35ms | 28.98ms | 30KB |
| 8×8 | 152 | 14.16ms | 126.36ms | 13.48ms | 103KB |
| 16×16 | 560 | 7.2ms | 85.7ms | 11.33ms | 378KB |
| 32×32 | 2144 | 8.35ms | 187.32ms | 13.63ms | 1451KB |

Constraint model validated: measured = 2N² + 3N (products + sum-of-squares commitment).

## Extrapolated to real model layers

Groth16 prover cost modeled as t ≈ k·c·log₂(c), calibrated on the largest measured circuit.

| Layer | Est. constraints | Est. prove time |
|---|---|---|
| GPT-2 small attn proj (768x768) | 1.18e+6 | 3.1min |
| GPT-2 small FFN (3072x768) | 4.73e+6 | 13.8min |
| LLaMA-7B FFN (11008x4096) | 9.02e+7 | 5.2h |
| Phi-2 single layer (2560x2560) | 1.31e+7 | 40.8min |
| Phi-2 full model (~2.7B params) | 2.70e+9 | 7.7days |

## The wall, quantified

- A single Phi-2 full model proof would take **7.7days** with today's stack.
- Verifying one inference honestly means proving every layer — multiply accordingly.
- This is why the roadmap is hybrid verification (see docs/HYBRID_VERIFICATION.md):
  optimistic execution + sampled spot-proofs instead of prove-everything.

