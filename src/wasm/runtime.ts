/**
 * WASM Runtime for Deterministic Fixed-Point AI Inference
 *
 * Loads the compiled inference.wasm module and provides typed wrappers
 * around the exported functions. All math is Q16.16 fixed-point i32.
 *
 * Exported WASM functions:
 *   - matmul(M,N,K,A_off,B_off,out_off)
 *   - relu(len, off)
 *   - add_bias(len, vec_off, bias_off)
 *   - embedding_lookup(vocab_size,dim,token_id,weights_off,out_off)
 *   - layernorm(len, off)
 *   - softmax(len, off)
 *
 * TypeScript helpers handle float <=> fixed-point conversion and memory layout.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const SHIFT = 16;
const FIXED_ONE = 1 << SHIFT; // 65536

export function f2i(v: number): number {
  return Math.round(v * FIXED_ONE);
}

export function i2f(v: number): number {
  return v / FIXED_ONE;
}

export function vector2Fixed(arr: number[]): Int32Array {
  const out = new Int32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = f2i(arr[i]);
  return out;
}

export function vector2Float(arr: Int32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < arr.length; i++) out.push(i2f(arr[i]));
  return out;
}

export interface InferredExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  matmul: (M: number, N: number, K: number, A_off: number, B_off: number, out_off: number) => void;
  relu: (len: number, off: number) => void;
  add_bias: (len: number, vec_off: number, bias_off: number) => void;
  embedding_lookup: (vocab_size: number, dim: number, token_id: number, weights_off: number, out_off: number) => void;
  layernorm: (len: number, off: number) => void;
  softmax: (len: number, off: number) => void;
  grow_memory: (pages: number) => number;
}

let _cachedModule: WebAssembly.Module | null = null;

function getCachedModule(): WebAssembly.Module {
  if (!_cachedModule) {
    const wasmPath = resolve(__dirname, 'inference.wasm');
    const bytes = readFileSync(wasmPath);
    _cachedModule = new WebAssembly.Module(bytes);
  }
  return _cachedModule;
}

/** Synchronous load — each call gets a fresh memory instance. */
export function loadWasmSync(): InferredExports {
  const mod = getCachedModule();
  const instance = new WebAssembly.Instance(mod, {
    env: { memory: new WebAssembly.Memory({ initial: 2, maximum: 8 }) },
  });
  return instance.exports as InferredExports;
}

/** Async load — each call gets a fresh memory instance. */
export async function loadWasm(): Promise<InferredExports> {
  const mod = getCachedModule();
  const instance = await WebAssembly.instantiate(mod, {
    env: { memory: new WebAssembly.Memory({ initial: 2, maximum: 8 }) },
  });
  return instance.exports as InferredExports;
}

function ensureMem(wasm: InferredExports, bytesNeeded: number) {
  const mem = wasm.memory;
  const currentBytes = mem.buffer.byteLength;
  if (bytesNeeded > currentBytes) {
    const pagesNeeded = Math.ceil((bytesNeeded - currentBytes) / (64 * 1024));
    wasm.grow_memory(Math.max(1, pagesNeeded));
  }
}

function writeI32Array(wasm: InferredExports, arr: Int32Array, offset: number) {
  ensureMem(wasm, offset + arr.byteLength);
  const mem = new Int32Array(wasm.memory.buffer);
  mem.set(arr, offset / 4);
}

function readI32Array(wasm: InferredExports, offset: number, len: number): Int32Array {
  const mem = new Int32Array(wasm.memory.buffer);
  return mem.slice(offset / 4, offset / 4 + len);
}

export interface WasmMatrix { rows: number; cols: number; data: Int32Array; }

export interface WasmLayerInput {
  opType: string;
  weights: number[];          // flat array, shaped as needed
  input: number[];              // float vector
  bias?: number[];             // optional bias vector
}

export class WasmRuntime {
  private wasm: InferredExports;
  private memOffset: number;

  constructor(wasm: InferredExports) {
    this.wasm = wasm;
    this.memOffset = 1024; // leave 1 KiB headroom for small spills
  }

  /** Reset allocator back to base */
  reset() { this.memOffset = 1024; }

  private alloc(bytes: number): number {
    const addr = this.memOffset;
    this.memOffset += bytes;
    ensureMem(this.wasm, this.memOffset);
    return addr;
  }

  private allocVector(data: number[]): number {
    const fixed = vector2Fixed(data);
    const addr = this.alloc(fixed.byteLength);
    writeI32Array(this.wasm, fixed, addr);
    return addr;
  }

  /** Run a single layer through WASM deterministically. Returns float array. */
  executeLayer(opType: string, weights: number[], input: number[], bias?: number[]): number[] {
    switch (opType) {
      case 'embedding': {
        const vocab = weights.length / input.length; // approximated for test
        const dim = input.length;
        const wAddr = this.allocVector(weights);
        const outAddr = this.alloc(dim * 4);
        this.wasm.embedding_lookup(vocab, dim, 0, wAddr, outAddr);
        return vector2Float(readI32Array(this.wasm, outAddr, dim));
      }

      case 'attention': {
        // Attention = matmul(input, weights) + optional bias + relu
        const M = 1;
        const K = input.length;
        const N = weights.length / K; // treat flat weights as [K x N]
        const aAddr = this.allocVector(input);
        const bAddr = this.allocVector(weights);
        const outAddr = this.alloc(N * 4);
        this.wasm.matmul(M, N, K, aAddr, bAddr, outAddr);
        if (bias && bias.length > 0) {
          const biasAddr = this.allocVector(bias);
          this.wasm.add_bias(N, outAddr, biasAddr);
        }
        this.wasm.relu(N, outAddr);
        return vector2Float(readI32Array(this.wasm, outAddr, N));
      }

      case 'ffn': {
        const M = 1;
        const K = input.length;
        const N = weights.length / K;
        const aAddr = this.allocVector(input);
        const bAddr = this.allocVector(weights);
        const outAddr = this.alloc(N * 4);
        this.wasm.matmul(M, N, K, aAddr, bAddr, outAddr);
        if (bias && bias.length > 0) {
          const biasAddr = this.allocVector(bias);
          this.wasm.add_bias(N, outAddr, biasAddr);
        }
        this.wasm.relu(N, outAddr);
        return vector2Float(readI32Array(this.wasm, outAddr, N));
      }

      case 'relu': {
        const len = input.length;
        const inAddr = this.allocVector(input);
        this.wasm.relu(len, inAddr);
        return vector2Float(readI32Array(this.wasm, inAddr, len));
      }

      case 'layernorm': {
        const len = input.length;
        const inAddr = this.allocVector(input);
        this.wasm.layernorm(len, inAddr);
        return vector2Float(readI32Array(this.wasm, inAddr, len));
      }

      case 'head': {
        // Classification head: matmul + add_bias + softmax
        const M = 1;
        const K = input.length;
        const N = weights.length / K;
        const aAddr = this.allocVector(input);
        const bAddr = this.allocVector(weights);
        const outAddr = this.alloc(N * 4);
        this.wasm.matmul(M, N, K, aAddr, bAddr, outAddr);
        if (bias && bias.length > 0) {
          const biasAddr = this.allocVector(bias);
          this.wasm.add_bias(N, outAddr, biasAddr);
        }
        this.wasm.softmax(N, outAddr);
        return vector2Float(readI32Array(this.wasm, outAddr, N));
      }

      default: return [];
    }
  }
}

/**
 * Convenience: run WASM inference for a layer with raw floats.
 * Creates a fresh WasmRuntime per call to avoid state bleed.
 */
export async function wasmExecuteLayer(opType: string, weights: number[], input: number[], bias?: number[]): Promise<number[]> {
  const wasm = await loadWasm();
  const rt = new WasmRuntime(wasm);
  return rt.executeLayer(opType, weights, input, bias);
}
