# Recursive SNARK Scaling Roadmap

> Path from 4×4 toy circuits to full transformer layers with constant verification.

## Current Baseline

| Component | Status | Constraints | Notes |
|---|---|---|---|
| `zklayer.circom` | ✅ Live | ~44 R1CS | 4-element input, 4×4 weight matrix, raw integer math |
| Groth16 setup | ✅ Live | Powers-of-tau 12 | Trusted ceremony via `snarkjs` |
| `proveLayer` + `verifyLayer` | ✅ Live | ~330ms prove | Per-layer, not recursive |

The current circuit proves:
```
output[i] = bias[i] + Σ_j(input[j] * weights[i*4+j])
sum_of_squares(output) = publicCommitment
```

This is a pedagogical toy. To prove inference on models like Gemma-2B or Phi-2 on-chain, the circuit must scale to **millions of constraints per layer** with **O(log n) verification**. This document outlines the concrete roadmap.

---

## Scaling Path Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1  │  LAYER 2  │  LAYER 3  │  LAYER 4  │   ...        │
│  tiny     │  small    │  medium   │  full     │               │
│  4×4      │  128-dim  │  2048-dim │  GQA 2048 │               │
│  Groth16  │  Groth16  │  Nova /   │  Nova /   │               │
│           │           │  Plonky2  │  Plonky2  │               │
└─────────────────────────────────────────────────────────────────┘
         ↑                    ↑               ↑
     Current            Parallel folding     Recursive proof
     (working)          (fold + batch)       (one proof ≈ 1 layer)
```

---

## Stage 1: Circuit Primitives (Immediate)

**Goal**: Replace raw integer math with quantized fixed-point operations that match WASM execution exactly.

### 1.1 Q16.16 Fixed-Point Arithmetic Circuit

The WASM runtime uses Q16.16 fixed-point (`int >> 16`). The circuit must replicate this *deterministically*:

```circom
template FixedMul() {
  signal input a;
  signal input b;
  signal output c;
  c <== (a * b) >> 16;   // floor((a*b)/2^16)
}
```

**Requirement**: Range proofs on intermediate values to prevent overflow. Q16.16 limits to ±32767. Values outside this must be checked with `Num2Bits` range proofs (expensive — use PLONK custom gates once we move to Plonky2).

### 1.2 Rescale (Requantization) Circuit

After each layer, outputs must be rescaled to Q16.16 to prevent bit growth:
```
output_q16 = floor((acc_q32 + round_const) >> 16)
```

This is needed because a 2048-dim accumulator in Q16.16 can exceed 32 bits during accumulation. We accumulate in Q32.32 and rescale.

### 1.3 Lookup Table Circuits

For embedding, circuits must prove that `embedding_table[token_id]` equals a claimed vector. This is a **selection circuit** over a public lookup matrix.

---

## Stage 2: Nova-Based Parallel Folding (2–4 months)

**Goal**: Fold multiple layer proofs into a single proof whose verification is constant-time.

Instead of proving each layer independently (N proofs, each ~330ms), we fold them incrementally:

```
Proof_0 = Groth16(layer_0)
Proof_1 = Nova_fold(Proof_0, layer_1)
Proof_2 = Nova_fold(Proof_1, layer_2)
...
Proof_N = Nova_fold(Proof_{N-1}, layer_N)   ← one final proof
```

### Why Nova?

- **Cycle of curves**: Uses `Pallas/Vesta` so each fold step is ~R1CS-accumulation, not full SNARK verification.
- **No trusted setup**: Unlike Groth16.
- **Parallelism**: Can fold layer proofs across `K` workers (one per GPU), then merge.

### Integration Plan

1. Export each layer's execution trace from WASM runtime as a sequence of (op, input_hash, output_hash, weight_commitment)
2. Build a Nova-compatible circuit that verifies:
   - `output = correct_op(input, weights)`
   - `hash(input)` matches previous step commitment
3. Batch-fold across all layers in the model
4. Final proof size: ~1KB (Nova recursive proof)
5. On-chain verifier: Pallas signature check (precompile)

### Benchmark Targets (Desktop-class GPU)

| Model | Layers | Total Constraints | Parallel Workers | Fold Time | Final Proof Size |
|-------|--------|-------------------|------------------|-----------|------------------|
| Tiny-Test-4x4 | 4 | 2,000 | 1 | <1s | 1KB |
| Gemma-2B (it) | 24 | ~5B | 8 | ~15min | 1KB |
| Phi-2 | 32 | ~8B | 8 | ~25min | 1KB |

> GPU workers run layer proofs locally; a coordinator merges them. This matches the smartphone cluster model.

---

## Stage 3: Plonky2 + STARK-to-SNARK Bridge (4–8 months)

**Goal**: Sub-second proving time per transformer layer via custom gates + FRI.

Plonky2 uses polynomial commitment (FRI) instead of pairings. This means:
- **No trusted setup**
- **Custom gates** for matrix multiplication, softmax lookup, layer norm
- **Aggregation**: Plonky2 has built-in recursion via "recursive aggregation" (CyclicRecursion)

### Architecture

```
┌────────────────────────────────────────────┐
│   Plonky2 Layer Circuit                    │
│   ├─ Custom gate: batched matmul           │
│   ├─ Custom gate: Q16.16 quant/dequant     │
│   ├─ Lookup table: embedding + softmax     │
│   └─ Range-check gate: overflow prevention │
└────────────────────────────────────────────┘
              ↓
   Recursive proof (CyclicRecursion)
              ↓
   Final STARK proof (FRI)
              ↓
   Optional: STARK → SNARK bridge for Ethereum L1 compatibility
```

### Why Plonky2 for the final layer?

- Proving time per layer: **~200ms on M1 Pro** (batched ops)
- Recursion overhead: **~5x** per fold, but with parallel aggregation it's manageable
- On-chain verification: **~200K gas** (if using SNARK bridge) or **~500K gas** (STARK verifier)

---

## Stage 4: On-Chain Precompiles

For the chain to natively verify Nova / Plonky2 proofs in the verification game, we need *deterministic* opcodes. In WASM we can call host functions.

| Precompile | Purpose | Gas Cost |
|---|---|---|
| `ecdsa_pallas_verify` | Nova accumulation step validation | 2,000 |
| `fri_verify` | STARK proof verification | 50,000 |
| `poseidon2_hash` | Native zk-friendly hashing | 100 |
| `zk_fold_step` | One layer of Nova recursive folding | 5,000 |

> These will be added to the WASM runtime as `host_call` imports. The chain's `opType registry` already supports extensible opcodes (`embedding`, `attention`, `ffn`, `layernorm`).

---

## Stage 5: Full Pipeline (End State)

```
User inference request
        ↓
[1] Edge GPU computes layer_i with WASM fixed-point
[2] Runtime generates execution trace + layer commitment
[3] Nova worker folds layer_i proof into running accumulation
[4] After final layer: one recursive proof (1KB)
[5] Proof submitted as tx to chain: `submitInference` with proof
[6] Challenger disputes → verification game opens
[7] Bisection converges to disputed layer
[8] Disputed layer proved on-chain (precompile) OR submitted as final proof
```

### Throughput Estimates

| Phase | Proving Time | Verifying Time | On-Chain Gas | Bottleneck |
|---|---|---|---|---|
| Current toy (Groth16, 4×4) | 330ms | 10ms | 250K | Circuit size |
| Stage 2 (Nova, 2B model) | ~15 min total | 50ms | 300K | Parallel GPU workers |
| Stage 3 (Plonky2, 2B model) | ~2 min total | 20ms | 500K | FRI commitment |
| Final (Plonky2 + precompiles) | ~1 min total | 10ms | 200K | Hardware availability |

The 1-minute target assumes 8 smartphone GPUs in parallel. This is aggressive but reachable with the described architecture.

---

## Recommended Next Steps

1. **Week 1–2**: Implement Q16.16 fixed-point gates in Circom; replace raw integer `zklayer.circom`
2. **Week 3–4**: Integrate `snarkjs` recursive aggregation (basic Groth16 recursion) as proof-of-concept
3. **Month 2**: Evaluate Nova vs Plonky2 for transformer folding; prototype one layer with each
4. **Month 3**: Build batched `matmul` custom gate; benchmark on target hardware (smartphone GPU + MacBook Pro)
5. **Month 4**: Write `host_call` precompile spec; add to WASM runtime
6. **Month 5–6**: Full end-to-end: Gemma-2B inference → trace → recursive proof → on-chain verification game resolution

---

## Appendix: Current `zklayer.circom` (for reference)

```circom
pragma circom 2.1.0;

template ZKLayer(nIn, nOut) {
  signal input in[nIn];
  signal input weights[nIn * nOut];
  signal input bias[nOut];
  signal output out[nOut];
  signal output publicCommitment;

  signal tmp[nOut];
  for (var i = 0; i < nOut; i++) {
    tmp[i] <== bias[i];
    for (var j = 0; j < nIn; j++) {
      tmp[i] <== tmp[i] + in[j] * weights[i*nIn + j];
    }
    out[i] <== tmp[i];
  }

  var sum = 0;
  for (var i = 0; i < nIn; i++) { sum += in[i] * in[i]; }
  for (var i = 0; i < nOut; i++) { sum += out[i] * out[i]; }
  publicCommitment <== sum;
}

component main = ZKLayer(4, 4);
```

This will be replaced incrementally: first with Q16.16 gates, then with a batched `matmul` template, then integrated into the Nova/Plonky2 pipeline.
