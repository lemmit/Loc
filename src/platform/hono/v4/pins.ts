// ---------------------------------------------------------------------------
// hono@v4 — dependency pins (the version-owned "templating" slice of
// the backend package; see docs/backend-packages.md).
//
// These pins live here, rather than in
// `src/generator/typescript/index.ts`, so the *package version* owns
// its dep set.  The TypeScript/Hono emitter is the shared library
// the package drives; it imports these pins.  When `hono@v5` forks
// it ships its own `pins.ts` and the emitter is parameterised
// on the active version's pins instead of importing v4's directly.
//
// All values are within-major / within-0.x.  zod 3→4
// and TS 5→6 are majors deferred to the `hono@v5` package, not an
// in-place bump here.  The `LOOM_TS_BUILD` shard (`tsc --noEmit` +
// tsup against an emitted Hono project) is the gate that proves
// these resolve + typecheck together.
// ---------------------------------------------------------------------------
export const BACKEND_PINS = {
  dependencies: {
    hono: "^4.12.0",
    "@hono/node-server": "^1.14.0",
    "@hono/zod-openapi": "^0.19.0",
    zod: "^3.24.0",
    "drizzle-orm": "^0.45.0",
    pg: "^8.13.0",
    pino: "^9.5.0",
  },
  devDependencies: {
    typescript: "^5.7.0",
    tsx: "^4.19.0",
    tsup: "^8.3.0",
    vitest: "^2.1.0",
    "drizzle-kit": "^0.30.0",
    "@types/pg": "^8.11.0",
    "pino-pretty": "^11.3.0",
  },
} as const;
