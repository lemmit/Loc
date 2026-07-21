// ---------------------------------------------------------------------------
// hono@v4 — dependency pins (the version-owned "templating" slice of
// the backend package; see docs/backend-packages.md).
//
// These pins live here, rather than inside the shared
// `src/generator/typescript/` emitter library, so the *package
// version* owns its dep set.  The TypeScript/Hono emitter library
// is the shared code every Hono version drives; it imports these
// pins.  When `hono@v5` forks it ships its own `pins.ts` alongside
// `v4/`, and the emitter is parameterised on the active version's
// pins instead of importing v4's directly.
//
// All values are within-major / within-0.x.  zod 3→4, TS 5→6, and the
// cross-major dev tools (vitest 2→4, pino-pretty 11→13) are deferred to
// the `hono@v5` package, not an in-place bump here.  The `LOOM_TS_BUILD`
// shard (`tsc --noEmit` + tsup against an emitted Hono project) is the
// gate that proves these resolve + typecheck together.
// ---------------------------------------------------------------------------
export const BACKEND_PINS = {
  dependencies: {
    hono: "^4.12.26",
    "@hono/node-server": "^1.19.0",
    "@hono/zod-openapi": "^0.19.10",
    zod: "^3.25.0",
    "drizzle-orm": "^0.45.2",
    pg: "^8.22.0",
    pino: "^9.14.0",
    "prom-client": "^15.1.0",
    uuidv7: "^1.0.2",
  },
  devDependencies: {
    typescript: "^5.9.0",
    tsx: "^4.22.0",
    tsup: "^8.5.0",
    vitest: "^2.1.0",
    "drizzle-kit": "^0.31.0",
    "@types/pg": "^8.20.0",
    "pino-pretty": "^11.3.0",
  },
} as const;
