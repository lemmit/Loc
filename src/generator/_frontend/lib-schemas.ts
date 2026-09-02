// ---------------------------------------------------------------------------
// Framework-neutral shared zod lib-schema fragments — emitted into a generated
// frontend project's `src/lib/schemas.ts`.  Homed in `_frontend/` (NOT a
// per-platform generator dir) so the React, Vue, and Svelte generators can all
// import them without a `generator/<platform> → generator/<sibling>` edge (see
// pipeline-layering.test.ts's "sibling platform directory" rule).
//
// The provenance-lineage schema mirrors the Hono route's `ProvenanceLineage`
// zod shape byte-for-byte (src/platform/hono/v4/routes-builder.ts) so the
// frontend parses the `lineage` half of the `Provenanced<T>` wire carrier into
// a typed `ProvLineage` a `ProvenanceInfo` disclosure reads (docs/provenance.md).
//
// Two forms so the money + provenance combinations stay minimal:
//   - `LIB_SCHEMAS_PROV_TS`      — standalone file (own header + z import) for a
//     provenance-but-no-money project.
//   - `PROV_LINEAGE_SCHEMA_BLOCK` — the bare export block, appended after the
//     money schema (which already imports `z`) when both are used.
// ---------------------------------------------------------------------------

export const PROV_LINEAGE_SCHEMA_BLOCK = `
/**
 * Provenance lineage for a \`provenanced\` field — the \`lineage\` half of the
 * \`Provenanced<T>\` wire carrier (\`{ value, lineage }\`).  Nullable: a field that
 * has never been written carries no lineage yet.
 */
export const provLineageSchema = z.object({
  snapshotId: z.string(),
  target: z.object({ type: z.string(), field: z.string() }),
  inputs: z.array(z.object({ path: z.string(), value: z.unknown() })),
  computedValue: z.unknown(),
});
export type ProvLineage = z.infer<typeof provLineageSchema>;
`;

export const LIB_SCHEMAS_PROV_TS = `// Auto-generated.  Do not edit by hand.
import { z } from "zod";
${PROV_LINEAGE_SCHEMA_BLOCK}`;
