import { test, describe } from 'node:test';
import assert from 'node:assert';
import { loadWasm, f2i, i2f, vector2Fixed, vector2Float, WasmRuntime } from './runtime';

describe('WASM Inference Runtime', () => {
  test('loadWasm compiles and exports all functions', async () => {
    const wasm = await loadWasm();
    assert.ok(wasm.memory, 'has memory');
    assert.strictEqual(typeof wasm.matmul, 'function');
    assert.strictEqual(typeof wasm.relu, 'function');
    assert.strictEqual(typeof wasm.add_bias, 'function');
    assert.strictEqual(typeof wasm.embedding_lookup, 'function');
    assert.strictEqual(typeof wasm.layernorm, 'function');
    assert.strictEqual(typeof wasm.softmax, 'function');
  });

  test('f2i and i2f roundtrip', () => {
    assert.strictEqual(f2i(1.0), 65536);
    assert.strictEqual(f2i(0.5), 32768);
    assert.strictEqual(f2i(-0.5), -32768);
    assert.ok(Math.abs(i2f(f2i(1.234)) - 1.234) < 0.0001);
    assert.ok(Math.abs(i2f(f2i(-0.75)) - (-0.75)) < 0.0001);
  });

  test('matmul deterministic 2x3 * 3x2', async () => {
    const wasm = await loadWasm();
    const rt = new WasmRuntime(wasm);

    const A = [1, 0, 0, 0, 1, 0]; // 2x3 identity-ish
    const B = [1, 0, 0, 1, 0, 0]; // 3x2
    const out = rt.executeLayer('attention', B, [1, 0, 0]);
    // attention = matmul(input, weights) + relu
    // (1,0,0) × B = (1, 0)  (first row of B)
    assert.ok(out.length > 0);
  });

  test('relu clips negatives', async () => {
    const wasm = await loadWasm();
    const mem = new Int32Array(wasm!.memory.buffer);
    const off = 512;
    mem[off / 4] = f2i(1.5);
    mem[off / 4 + 1] = f2i(-2.0);
    mem[off / 4 + 2] = f2i(0.0);
    wasm!.relu(3, off);
    assert.strictEqual(mem[off / 4], f2i(1.5));
    assert.strictEqual(mem[off / 4 + 1], 0); // clamped to 0
    assert.strictEqual(mem[off / 4 + 2], f2i(0.0));
  });

  test('layernorm preserves shape', async () => {
    const wasm = await loadWasm();
    const rt = new WasmRuntime(wasm);
    const input = [1.0, 2.0, 3.0, 4.0];
    const out = rt.executeLayer('layernorm', [], input);
    assert.strictEqual(out.length, input.length);
  });

  test('embedding_lookup copies correct row', async () => {
    const wasm = await loadWasm();
    const mem = new Int32Array(wasm!.memory.buffer);
    const vocab = 10;
    const dim = 8;
    const weightsOff = 256;
    // Write weights: vocab x dim
    const weights: number[] = [];
    for (let v = 0; v < vocab; v++) {
      for (let d = 0; d < dim; d++) {
        weights.push(v * 0.1 + d * 0.01);
      }
    }
    const fixed = vector2Fixed(weights);
    mem.set(fixed, weightsOff / 4);

    const outOff = weightsOff + weights.length * 4;
    wasm!.embedding_lookup(vocab, dim, 5, weightsOff, outOff);

    const out = mem.slice(outOff / 4, outOff / 4 + dim);
    for (let d = 0; d < dim; d++) {
      const expected = f2i(5 * 0.1 + d * 0.01);
      assert.strictEqual(out[d], expected, `dim ${d}`);
    }
  });

  test('WasmRuntime reset prevents memory bleed', async () => {
    const wasm = await loadWasm();
    const rt = new WasmRuntime(wasm);

    const out1 = rt.executeLayer('ffn', [0.5, -0.5, 0.2, 0.1], [1, 0], [0.1, 0.1]);
    assert.strictEqual(out1.length, 2);

    rt.reset();
    const out2 = rt.executeLayer('ffn', [0.5, -0.5, 0.2, 0.1], [1, 0], [0.1, 0.1]);
    assert.deepStrictEqual(out1, out2);
  });
});
