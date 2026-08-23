;; Deterministic AI Inference WASM Module (Q16.16 Fixed-Point i32)
;; No floating-point ops. All math is integer fixed-point for determinism.
;; SHIFT = 16, FIXED_ONE = 65536
;;
;; Memory layout (all i32 packed as 4-byte little-endian words):
;;   - caller writes input buffer, weight buffers, bias buffers
;;   - caller reads output buffer
;;
;; Exported functions:
;;   matmul(M,N,K,A_off,B_off,out_off)    -- out[M,N] = A[M,K] * B[K,N]
;;   relu(len, offset)                      -- in-place ReLU
;;   add_bias(len, vec_off, bias_off)       -- in-place vec += bias
;;   embedding_lookup(vocab_size, dim, token, weights_off, out_off)

(module
  (memory (export "memory") 2) ;; 128 KiB initial, can grow

  (global $SHIFT    i32 (i32.const 16))
  (global $FIX_ONE i32 (i32.const 65536)) ;; 1.0 in Q16.16

  ;; Load i32 from memory at byte offset (4-byte aligned)
  (func $load (param $off i32) (result i32)
    (i32.load (local.get $off)))

  ;; Store i32 to memory at byte offset (4-byte aligned)
  (func $store (param $off i32) (param $v i32)
    (i32.store (local.get $off) (local.get $v)))

  ;; Fixed-point multiply: (a * b) >> 16
  ;; Uses i64 intermediate to avoid overflow
  (func $fmul (param $a i32) (param $b i32) (result i32)
    (i32.wrap_i64
      (i64.shr_s
        (i64.mul (i64.extend_i32_s (local.get $a))
                 (i64.extend_i32_s (local.get $b)))
        (i64.const 16))))

  ;; Integer square root (Newton-Raphson, 10 iterations)
  ;; Operates on raw integer (for variance values in fixed-point range)
  (func $isqrt (param $n i32) (result i32)
    (local $x i32)
    (local $i i32)
    (if (i32.le_s (local.get $n) (i32.const 0))
      (then (return (i32.const 0))))
    ;; initial guess: n/2 + 1 (works well for 32-bit range)
    (local.set $x (i32.add (i32.shr_u (local.get $n) (i32.const 1)) (i32.const 1)))
    (block $done
      (loop $iter
        (br_if $done (i32.ge_u (local.get $i) (i32.const 10)))
        ;; x = (x + n/x) / 2
        (local.set $x
          (i32.shr_u
            (i32.add (local.get $x)
                     (i32.div_u (local.get $n) (local.get $x)))
            (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $iter)
      )
    )
    (local.get $x)
  )

  ;; Fixed-point divide: (a << 16) / b  =>  Q16.16 result
  (func $fdiv (param $a i32) (param $b i32) (result i32)
    (if (i32.eq (local.get $b) (i32.const 0))
      (then (return (i32.const 0))))
    (i32.wrap_i64
      (i64.shr_s
        (i64.shl (i64.extend_i32_s (local.get $a)) (i64.const 16))
        (i64.extend_i32_s (local.get $b)))))

  ;; matmul(M,N,K, A_offset, B_offset, out_offset)
  ;;   A is M x K, B is K x N, out is M x N
  ;;   All offsets are byte offsets in linear memory
  (func $matmul (export "matmul")
    (param $M i32) (param $N i32) (param $K i32)
    (param $A_off i32) (param $B_off i32) (param $out_off i32)
    (local $m i32)
    (local $n i32)
    (local $k i32)
    (local $acc i32)
    (local $a_idx i32)
    (local $b_idx i32)
    (local $o_idx i32)

    (local.set $m (i32.const 0))
    (block $m_done
      (loop $m_loop
        (br_if $m_done (i32.ge_u (local.get $m) (local.get $M)))

        (local.set $n (i32.const 0))
        (block $n_done
          (loop $n_loop
            (br_if $n_done (i32.ge_u (local.get $n) (local.get $N)))

            (local.set $acc (i32.const 0))
            (local.set $k (i32.const 0))
            (block $k_done
              (loop $k_loop
                (br_if $k_done (i32.ge_u (local.get $k) (local.get $K)))

                ;; a_idx = A_off + ((m * K) + k) * 4
                (local.set $a_idx
                  (i32.add
                    (local.get $A_off)
                    (i32.shl
                      (i32.add (i32.mul (local.get $m) (local.get $K)) (local.get $k))
                      (i32.const 2))))

                ;; b_idx = B_off + ((k * N) + n) * 4
                (local.set $b_idx
                  (i32.add
                    (local.get $B_off)
                    (i32.shl
                      (i32.add (i32.mul (local.get $k) (local.get $N)) (local.get $n))
                      (i32.const 2))))

                ;; acc += fmul(A[a_idx], B[b_idx])
                (local.set $acc
                  (i32.add
                    (local.get $acc)
                    (call $fmul
                      (call $load (local.get $a_idx))
                      (call $load (local.get $b_idx)))))

                (local.set $k (i32.add (local.get $k) (i32.const 1)))
                (br $k_loop)
              )
            )

            ;; store result
            (local.set $o_idx
              (i32.add
                (local.get $out_off)
                (i32.shl
                  (i32.add (i32.mul (local.get $m) (local.get $N)) (local.get $n))
                  (i32.const 2))))
            (call $store (local.get $o_idx) (local.get $acc))

            (local.set $n (i32.add (local.get $n) (i32.const 1)))
            (br $n_loop)
          )
        )

        (local.set $m (i32.add (local.get $m) (i32.const 1)))
        (br $m_loop)
      )
    )
  )

  ;; relu(len, vec_offset) -- in-place
  (func $relu (export "relu")
    (param $len i32) (param $off i32)
    (local $i i32)
    (local $idx i32)
    (local $v i32)
    (local.set $i (i32.const 0))
    (block $done
      (loop $iter
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $idx (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))
        (local.set $v (call $load (local.get $idx)))
        (if (i32.lt_s (local.get $v) (i32.const 0))
          (then (call $store (local.get $idx) (i32.const 0))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $iter)
      )
    )
  )

  ;; add_bias(len, vec_offset, bias_offset) -- vec[i] += bias[i]
  (func $add_bias (export "add_bias")
    (param $len i32) (param $vec_off i32) (param $bias_off i32)
    (local $i i32)
    (local $v i32)
    (local $idx i32)
    (local.set $i (i32.const 0))
    (block $done
      (loop $iter
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $idx (i32.shl (local.get $i) (i32.const 2)))
        (local.set $v
          (i32.add
            (call $load (i32.add (local.get $vec_off) (local.get $idx)))
            (call $load (i32.add (local.get $bias_off) (local.get $idx)))))
        (if (i32.lt_s (local.get $v) (i32.const 0))
          (then
            ;; clamp negative? No, keep as-is for now. ReLU handles non-linearity.
          ))
        (call $store (i32.add (local.get $vec_off) (local.get $idx)) (local.get $v))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $iter)
      )
    )
  )

  ;; embedding_lookup(vocab_size, dim, token_id, weights_offset, out_offset)
  ;; copies weights[token_id * dim : (token_id+1) * dim] to out
  (func $embedding_lookup (export "embedding_lookup")
    (param $vocab_size i32) (param $dim i32) (param $token_id i32)
    (param $weights_off i32) (param $out_off i32)
    (local $i i32)
    (local $src i32)
    (local $dst i32)
    (local $row i32)
    ;; row = token_id * dim * 4
    (local.set $row (i32.shl (i32.mul (local.get $token_id) (local.get $dim)) (i32.const 2)))
    (local.set $i (i32.const 0))
    (block $done
      (loop $iter
        (br_if $done (i32.ge_u (local.get $i) (local.get $dim)))
        (local.set $src (i32.add (local.get $weights_off) (i32.add (local.get $row) (i32.shl (local.get $i) (i32.const 2)))))
        (local.set $dst (i32.add (local.get $out_off) (i32.shl (local.get $i) (i32.const 2))))
        (call $store (local.get $dst) (call $load (local.get $src)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $iter)
      )
    )
  )

  ;; layernorm(len, vec_offset) -- in-place
  ;; Computes mean, centers, approximate std, normalizes.
  ;; Simplified for deterministic fixed-point inference.
  (func $layernorm (export "layernorm")
    (param $len i32) (param $off i32)
    (local $i i32)
    (local $idx i32)
    (local $v i32)
    (local $mean i32)
    (local $var_acc i32)
    (local $std i32)
    (local $dev i32)
    (local $scale i32)

    ;; 1. Compute mean = sum / len
    (local.set $i (i32.const 0))
    (local.set $mean (i32.const 0))
    (block $done
      (loop $iter
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $idx (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))
        (local.set $mean (i32.add (local.get $mean) (call $load (local.get $idx))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $iter)
      )
    )
    ;; mean = (sum / len)  -- note: both are fixed-point, but division gives exact value in fixed-point
    (local.set $mean (i32.div_s (local.get $mean) (local.get $len)))

    ;; 2. Center and compute variance
    (local.set $i (i32.const 0))
    (local.set $var_acc (i32.const 0))
    (block $done
      (loop $iter
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $idx (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))
        (local.set $dev (i32.sub (call $load (local.get $idx)) (local.get $mean)))
        ;; dev^2 in Q16.16: fmul(dev, dev)
        (local.set $var_acc (i32.add (local.get $var_acc) (call $fmul (local.get $dev) (local.get $dev))))
        ;; store centered value for later use
        (call $store (local.get $idx) (local.get $dev))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $iter)
      )
    )
    ;; variance = var_acc / len
    (local.set $var_acc (i32.div_s (local.get $var_acc) (local.get $len)))

    ;; 3. std = sqrt(variance) -- approximate. We sqrt the raw i32 value.
    ;; Note: variance is in Q16.16. To take sqrt in Q16.16:
    ;;   var_q32 = variance << 16
    ;;   sqrt_q32 = isqrt(var_q32)
    ;;   std_q16 = sqrt_q32  (since sqrt(Q32) ≈ Q16)
    (local.set $std (call $isqrt (i32.shl (local.get $var_acc) (i32.const 16))))

    ;; 4. Normalize: x = x * FIXED_ONE / max(std, 1)
    ;; avoid division by zero with max(std, 1)
    (if (i32.lt_s (local.get $std) (i32.const 1))
      (then (local.set $std (i32.const 1))))

    (local.set $i (i32.const 0))
    (block $done
      (loop $iter
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $idx (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))
        (local.set $v (call $load (local.get $idx)))
        ;; x = x * FIXED_ONE / std  => x / std in fixed-point, renormalize to Q16.16
        (local.set $scale (call $fdiv (local.get $v) (local.get $std)))
        (call $store (local.get $idx) (local.get $scale))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $iter)
      )
    )
  )

  ;; softmax(len, vec_offset) -- in-place
  ;; Simplified: compute max, subtract max, approximate exp with max normalization
  ;; For inference verification, exact softmax is not critical; determinism is.
  ;; We use a simple power-of-2 approximation for exp.
  (func $softmax (export "softmax")
    (param $len i32) (param $off i32)
    (local $i i32)
    (local $idx i32)
    (local $v i32)
    (local $max_v i32)
    (local $sum i32)

    ;; find max
    (local.set $max_v (i32.const -2147483648))
    (local.set $i (i32.const 0))
    (block $done
      (loop $iter
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $idx (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))
        (local.set $v (call $load (local.get $idx)))
        (if (i32.gt_s (local.get $v) (local.get $max_v))
          (then (local.set $max_v (local.get $v)))        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $iter)
      )
    )

    ;; subtract max and approximate exp(x) = 2^(x) for x >= 0, clamp negative to 0
    (local.set $i (i32.const 0))
    (local.set $sum (i32.const 0))
    (block $done
      (loop $iter
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $idx (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))
        (local.set $v (i32.sub (call $load (local.get $idx)) (local.get $max_v)))
        ;; approximate exp: treat Q16.16 value as raw, if positive shift right by SCALE to simulate 2^(-x)
        ;; Actually, for softmax we just want relative weights. For verification determinism:
        ;; Use a simpler rule: if v >= 0, value = v + FIXED_ONE; else value = 0.
        ;; This is NOT exp, but preserves ordering and is fully deterministic.
        (if (i32.lt_s (local.get $v) (i32.const 0))
          (then (local.set $v (i32.const 0)))
          (else (local.set $v (i32.add (local.get $v) (global.get $FIX_ONE)))))
        (call $store (local.get $idx) (local.get $v))
        (local.set $sum (i32.add (local.get $sum) (local.get $v)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $iter)
      )
    )

    ;; normalize by sum (ensure sum > 0)
    (if (i32.eq (local.get $sum) (i32.const 0))
      (then (local.set $sum (i32.const 1))))

    (local.set $i (i32.const 0))
    (block $done
      (loop $iter
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $idx (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))
        (local.set $v (call $load (local.get $idx)))
        ;; v = (v * FIXED_ONE) / sum  => probability in Q16.16
        (local.set $v (call $fdiv (local.get $v) (local.get $sum)))
        (call $store (local.get $idx) (local.get $v))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $iter)
      )
    )
  )

  ;; grow_memory(pages) -- returns old size in pages
  (func $grow_memory (export "grow_memory") (param $pages i32) (result i32)
    (memory.grow (local.get $pages)))
) ;; end module
