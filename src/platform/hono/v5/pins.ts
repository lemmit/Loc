// ---------------------------------------------------------------------------
// hono@v5 — dependency pins (the version-owned "templating" slice of
// the backend package; see the hono@v4 sibling for the pattern).
//
// v5 is the cross-major successor to v4: it takes the dep majors v4's
// within-major policy deferred — **zod 4** (and the `@hono/zod-openapi`
// 1.x that requires it), **TypeScript 6**, **vitest 4**, and
// **pino-pretty 13**.  Hono itself stays 4.x (there is no Hono 5 yet),
// so the package *version* bump here is driven by the zod/TS majors, not
// a Hono major — the `loomVersion` tracks the package's own evolution.
//
// Node-target dependency refresh (routine bump): **@hono/node-server
// 1→2** and **pino 9→10** are adopted here.  Both are boot-path runtime
// deps whose only breaking change is dropping Node 18 (v2 also removes
// the unused `@hono/node-server/vercel` adapter); the generated image
// runs `node:24`, and the `serve({ fetch, port })` + pino APIs are
// unchanged, so the shared emitter stays byte-identical.  Every other
// dep already floats to its current latest via its caret.  **TypeScript
// stays on `^6` — TS 7 (the native compiler port) is a separate major
// initiative, not folded into a routine bump** (same discipline that kept
// TS 6 its own step off v4).  `LOOM_TS_BUILD` + the behavioral boot gate
// prove these resolve, typecheck, and boot together.
//
// v5 reuses the shared TypeScript/Hono emitter unchanged (the one
// zod-3/4-divergent spot — the validation hook's issue-path typing — was
// widened to `PropertyKey`, valid under both majors), so this file +
// the thin `index.ts` surface ARE the whole package.  The previous v4
// package stays registered and loadable (`platform: node@v4`) for
// reproducibility.  The `LOOM_TS_BUILD` shard (`tsc --noEmit` + tsup
// against an emitted Hono project) is the gate that proves these
// resolve + typecheck together.
// ---------------------------------------------------------------------------
export const BACKEND_PINS = {
  dependencies: {
    hono: "^4.12.0",
    "@hono/node-server": "^2.0.0",
    "@hono/zod-openapi": "^1.0.0",
    zod: "^4.0.0",
    "drizzle-orm": "^0.45.0",
    pg: "^8.13.0",
    pino: "^10.3.0",
    "prom-client": "^15.1.0",
    uuidv7: "^1.0.2",
  },
  devDependencies: {
    typescript: "^6.0.0",
    tsx: "^4.19.0",
    tsup: "^8.3.0",
    vitest: "^4.0.0",
    "drizzle-kit": "^0.31.0",
    "@types/pg": "^8.11.0",
    "pino-pretty": "^13.0.0",
  },
} as const;
