/**
 * Softmax — bit-exact integer specification + honest reference implementation.
 *
 * SINGLE SOURCE OF TRUTH. Mirrors src/wasm/inference.wat $softmax EXACTLY.
 * The WASM never computed a real exp — its own comment pins the design:
 * "exact softmax is not critical; determinism is." So the circuit needs no
 * exp approximation at all (no LUT, no polynomial): it mirrors this rule:
 *
 * Domain: n = 8 elements, Q16.16 raw integers, |x_i| <= 8.0 (raw 2^19).
 *
 *   max_v = max(x_i)                       // ties allowed
 *   v_i   = x_i - max_v                    // <= 0
 *   e_i   = 0            if v_i < 0
 *           v_i + 2^16   otherwise          // maximizers get exactly 1.0
 *   sum   = max(Σ e_i, 1)
 *   y_i   = floor( (e_i * 2^16) / sum )     // truncation == floor: both operands >= 0
 *
 * Circuit soundness obligations (enforced in softmax8.circom):
 *   - max:    m - x_j >= 0 (range-checked) && m === Σ onehot_j * x_j
 *   - select: e_i === bit31(u_i) * u_i where u_i = v_i + 2^31-shifted sign test
 *   - clamp:  (denom - sum) * (denom - 1) === 0 && denom >= 1
 *   - divide: e_i*2^16 === y_i*denom + r_i,  0 <= r_i < 2^16,  denom > r_i
 *   - commitment: sum-of-squares over [x, y] mod BN254
 */

const FIXED_ONE = 65536;
export const SOFTMAX_N = 8;

function shrFloorDiv(a: bigint, b: bigint): bigint {
  // floor division for b > 0
  const q = a / b;
  const r = a % b;
  return r !== 0n && ((r < 0n) !== (b < 0n)) ? q - 1n : q;
}

export interface SoftmaxTrace {
  y: number[];
  maxV: number;
  e: number[];
  sum: number;
}

export function honestSoftmaxRaw(x: number[]): SoftmaxTrace {
  if (x.length !== SOFTMAX_N) throw new Error(`softmax expects ${SOFTMAX_N} elements`);
  const xb = x.map(BigInt);
  const F = BigInt(FIXED_ONE);

  let maxV = xb[0];
  for (const v of xb) if (v > maxV) maxV = v;

  const e = xb.map(v => {
    const vi = v - maxV;
    return vi < 0n ? 0n : vi + F;
  });

  let sum = e.reduce((s, v) => s + v, 0n);
  if (sum === 0n) sum = 1n;

  const y = e.map(ei => Number(shrFloorDiv(ei * F, sum)));

  return { y, maxV: Number(maxV), e: e.map(Number), sum: Number(sum) };
}

/** Float convenience wrapper: floats in -> floats out (Q16.16 roundtrip). */
export function honestSoftmax(xFloats: number[]): number[] {
  return honestSoftmaxRaw(xFloats.map(v => Math.round(v * FIXED_ONE))).y.map(i => i / FIXED_ONE);
}
