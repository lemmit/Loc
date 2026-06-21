// Shared key for the transient capability-membership annotation.
//
// The macro expander (phase ②) records which typed capabilities it applied to
// an aggregate by stashing their names under this hidden property on the
// aggregate AST node; lowering (phase ⑤) reads it to populate
// `AggregateIR.capabilities`.  It is deliberately NOT an `implements <Cap>` AST
// member — that would re-enter `expandHost`'s typed-implements scan and
// double-apply the capability.  A `$`-prefixed key keeps it out of
// `copyAstNode` clones and Langium's reflection.
//
// Lives in `src/util/` (the lowest layer) so both `src/macros/` (writer) and
// `src/ir/` (reader) can share it without crossing the pipeline's layer edges.
export const CAPABILITIES_TAG = "$loomCapabilities" as const;

// Per-member capability-origin annotation.  When the expander splices a
// capability's `filter` member into an aggregate, it stashes the source
// capability's name under this hidden property on the cloned `FilterDecl`
// node; lowering reads it to populate `AggregateIR.contextFilterOrigins`
// (index-aligned with `contextFilters`).  This is the provenance the
// `ignoring <Cap>` bypass surface resolves against — a filter knows which
// capability contributed it.  Same `$`-prefixed transient discipline as
// CAPABILITIES_TAG (kept out of `copyAstNode` clones / Langium reflection);
// set on the clone *after* copying, so the non-copy behaviour is irrelevant.
export const FILTER_ORIGIN_TAG = "$loomFilterOrigin" as const;
