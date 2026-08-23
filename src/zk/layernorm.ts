/**
 * LayerNorm — bit-exact integer specification + honest reference implementation.
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH. The circom circuit
 * (circuits/layernorm.circom), any future WAT port, and every verifier
 * must produce byte-identical output to `honestLayernorm` below.
 *
 * Domain: n = 8 elements, Q16.16 fixed point (raw integers).
 * Input bound: |x_i| <= 8.0 (raw |x_i| <= 2^19). Keeps intermediate
 * squares inside the circuit's range-check budget and JS safe integers.
 *
 * Specification (all divisions are floor-toward-negative-infinity,
 * matching arithmetic shifts):
 *
 *   sum    = Σ x_i
 *   mean   = sum >> 3                       // floor(sum / 8)
 *   c_i    = x_i - mean
 *   varnum = Σ c_i²                         // Q32.32 accumulator (extra 2^16 factor)
 *   var_n  = varnum >> 19                   // /8 elements AND 2^16 rescale -> Q16.16
 *   denom  = max(var_n, 1)                  // zero-variance safe
 *
 *   // sqrt in full Q16.16: t = sqrt(denom) * 2^16 since A = denom * 2^16
 *   A      = denom << 16
 *   t      = floor_sqrt(A)                  // largest s with s*s <= A
 *
 *   // reciprocal as Q16.16: R = floor(2^32 / t)
 *   R      = floor(2^32 / t)
 *
 *   y_i    = floor( (c_i * R) / 2^16 )
 *
 * Circuit soundness obligations (enforced in layernorm.circom):
 *   - mean:    sum === mean*8 + r,  0 <= r < 8        (offset trick for signs)
 *   - var:     varnum === var_q*2^19 + r2, 0 <= r2 < 2^19
 *   - denom:   (denom - var_n) * (denom - 1) === 0 && denom >= 1
 *   - sqrt:    t*t <= A && A < (t+1)*(t+1)            (range-check encodings)
 *   - recip:   t*R <= 2^32 && 2^32 < t*(R+1)
 *   - scale:   c_i*R === y_i*2^16 + r_i,  0 <= r_i < 2^16
 *   - commitment: sum-of-squares over [x, y] mod BN254
 */

const FIXED_ONE = 65536;
export const LAYERNORM_N = 8;

/** floor division by 2^k toward negative infinity (== arithmetic shift). */
function shrFloor(a: bigint, k: number): bigint {
  if (a >= 0n) return a >> BigInt(k);
  return -(((-a) + (1n << BigInt(k)) - 1n) >> BigInt(k));
}

/** Largest integer s with s*s <= a (a >= 0). */
export function floorSqrt(a: bigint): bigint {
  if (a < 0n) throw new Error('floorSqrt: negative input');
  if (a < 2n) return a;
  let lo = 1n, hi = a;
  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const sq = mid * mid;
    if (sq === a) return mid;
    if (sq < a) lo = mid + 1n;
    else hi = mid - 1n;
  }
  return hi;
}

export interface LayernormTrace {
  y: number[];
  mean: number;
  var_n: number;
  denom: number;
  t: number;
  R: number;
}

/**
 * Honest layernorm over raw Q16.16 integers. Returns outputs in the same
 * fixed-point representation plus intermediates (useful for debugging and
 * for tests asserting circuit/witness agreement).
 */
export function honestLayernormRaw(x: number[]): LayernormTrace {
  if (x.length !== LAYERNORM_N) throw new Error(`layernorm expects ${LAYERNORM_N} elements`);
  const xb = x.map(BigInt);

  const sum = xb.reduce((s, v) => s + v, 0n);
  const mean = shrFloor(sum, 3);

  const c = xb.map(v => v - mean);
  const varnum = c.reduce((s, v) => s + v * v, 0n);
  const var_n = shrFloor(varnum, 19);

  const denom = var_n > 1n ? var_n : 1n;

  const A = denom << 16n;
  const t = floorSqrt(A);

  const tSafe = t > 0n ? t : 1n;
  const R = (1n << 32n) / tSafe;

  const y = c.map(ci => {
    const p = ci * R;
    return Number(shrFloor(p, 16));
  });

  return { y: y.map(Number), mean: Number(mean), var_n: Number(var_n), denom: Number(denom), t: Number(t), R: Number(R) };
}

/** Float convenience wrapper: floats in -> floats out. */
export function honestLayernorm(xFloats: number[]): number[] {
  return honestLayernormRaw(xFloats.map(v => Math.round(v * FIXED_ONE))).y.map(i2f);
}

export function i2f(i: number): number {
  return i / FIXED_ONE;
}

export function f2i(v: number): number {
  return Math.round(v * FIXED_ONE);
}
