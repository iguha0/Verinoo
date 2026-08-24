# Contributing

Thanks for looking under the hood. This is a research prototype — the best
contributions right now are the ones that make claims testable and honest.

## Setup

```bash
git clone https://github.com/indrajitguha/ai_chain_network
cd ai_chain_network
npm install
npm run build
npm test                 # 98 tests must pass before any PR
```

Optional but recommended:

```bash
npm run setup:rapidsnark # native proving (~5x faster)
npm run bench:zk         # regenerate docs/ZK_BENCHMARKS.md
```

## Ground rules

1. **Bit-exact discipline.** Anything that touches WASM ops or circuits needs a
   spec file (`src/zk/*.ts`) treated as the single source of truth, plus a
   differential test pinning circuit output to runtime output. The `$fdiv` bug
   lived for months because this rule didn't exist yet. It exists now.
2. **Tests green, always.** `npm test` gates every PR. New engine behavior
   needs a new test.
3. **Honesty over marketing.** If your change makes something slower or more
   prototype-grade, say so in the PR description. The "What's Real vs
   Prototype" table in ARCHITECTURE.md is part of the product.
4. **No new runtime dependencies** without an issue discussing alternatives —
   devDependencies are freer.
5. **Circuit changes** require re-running `npm run build:ops` (and
   `scripts/setup-groth16.mjs` for the layer circuit) and committing refreshed
   benchmark numbers if constraint counts change.

## Good first areas

See ROADMAP.md. Currently hottest:

- JS SDK wrapping the REST API (`POST /tx`, status streaming)
- Bigger matmul tiles + pot16 ladder in the benchmark harness
- Explorer UI on top of `/blocks` + `/games`
- Folding-scheme (Nova-style) spike for layer chains

## Reporting bugs

Open an issue with: commit hash, command run, expected vs actual, and the
relevant log lines. For consensus/state discrepancies include both nodes'
`GET /status` output.
