// Moved to src/generator/zod-refine.ts — the refine-chain renderer is
// consumed by the TS backend, the .NET validator emitter (as the
// mirrored spec), the Hono v4 backend package, and the shared frontend
// zod-schema emitter, so it lives at the shared generator level (same
// reasoning as generator/sql-pg.ts).  Shim preserves the original
// import path.
export * from "../zod-refine.js";
