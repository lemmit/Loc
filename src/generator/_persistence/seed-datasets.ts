// ---------------------------------------------------------------------------
// Shared seed-dataset spine — the first `_persistence/` seam (M-T9.2).
//
// First-boot seeding (database-seeding.md) groups a context's `SeedIR`
// rows into datasets and derives which aggregates the domain path imports,
// identically across the SQL-relational backends (Hono/Drizzle, .NET/EF,
// FastAPI/SQLAlchemy).  `groupByDataset` and the `Entry`/`Dataset` model
// were byte-for-byte triplicated in each backend's `seed` emitter; this is
// their single home.  The per-backend `renderDatasetFn` framing (the
// `save`/`INSERT` call shape, imports, datetime coercion) stays in each
// emitter — the divergent leaf.
//
// Pure structural derivation over the shared IR (no target-backend IR, no
// upward import): lives at the generator layer, imported *down* by each
// `src/generator/<platform>/emit/seed.ts` — see docs/new-plan/missions/
// M-T9.2-persistence-seam-design.md §.
// ---------------------------------------------------------------------------

import {
  type CreateOmissionValue,
  createInputFields,
  type RequirableInput,
} from "../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  SeedRowIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";

/** A seed row plus its block's path (domain create vs raw insert). */
export interface Entry {
  row: SeedRowIR;
  raw: boolean;
}

/** One dataset's merged entries (across all `seed <dataset>` blocks). */
export interface Dataset {
  name: string;
  entries: Entry[];
}

/** Group every `SeedIR` row by dataset, preserving source order + path.
 *
 *  Datasets are keyed by their RAW name, and each backend derives the seeder
 *  function's identifier by casing that name (`snake` on elixir/python,
 *  `upperFirst` on node/java/.NET) with no uniquifier — so two datasets whose
 *  names collide under either transform would emit one duplicated function
 *  (`F2-SEED-DATASET-NAME-COLLISION`).  The uniqueness that makes this keying
 *  safe is enforced upstream by `loom.seed-dataset-name-collision`
 *  (src/language/validators/seed.ts), not here. */
export function groupByDataset(ctx: EnrichedBoundedContextIR): Dataset[] {
  const byName = new Map<string, Dataset>();
  const order: string[] = [];
  for (const seed of ctx.seeds) {
    let ds = byName.get(seed.dataset);
    if (!ds) {
      ds = { name: seed.dataset, entries: [] };
      byName.set(seed.dataset, ds);
      order.push(seed.dataset);
    }
    for (const row of seed.rows) ds.entries.push({ row, raw: seed.path === "raw" });
  }
  return order.map((n) => byName.get(n)!);
}

/** Aggregate names whose domain class/repository are imported — `raw` rows
 *  emit pure SQL and import nothing. */
export function usedAggregates(datasets: Dataset[], seedable: Set<string>): string[] {
  const used = new Set<string>();
  for (const ds of datasets) {
    for (const e of ds.entries) {
      if (!e.raw && seedable.has(e.row.aggregate)) used.add(e.row.aggregate);
    }
  }
  return [...used].sort();
}

// ---------------------------------------------------------------------------
// The seeder model (M-T6.52) — "what does the seeder know" about ONE
// aggregate, derived once here and consumed by all five backends' seed
// emitters instead of each re-deriving its own create-input / create-call
// shape.  This is what closes the class of defect the mission found:
// java/.NET built an event-sourced aggregate's `create` call from
// `forCreateInput(agg.fields)` — every declared FIELD — against a factory
// that takes only the event-sourced `create` action's own declared
// PARAMETERS (`create open(owner: string)` → `create(String owner)`), a
// param-count/name mismatch (CS1501 / javac "cannot be applied").  node and
// python were "accidentally correct": both build the call as a keyword-
// shaped literal from the seed row's OWN fields, which structurally matches
// either factory shape as long as the row only names params the factory
// declares — a coincidence of calling convention, not a derivation every
// backend shares.  This model makes the derivation shared instead.
// ---------------------------------------------------------------------------

/** The saving strategy that decides how a seed row reaches storage:
 *   - `event-sourced` — the aggregate's truth is its append-only event
 *     stream (`persistedAs: eventLog`); a seed row APPENDS the creation
 *     event through the same command seam an ordinary create request uses.
 *   - `relational` / `document` / `embedded` — the `SavingShape` axis
 *     (D-DOCUMENT-AXIS); a seed row goes through the aggregate's domain
 *     `create` factory + repository save, exactly as before. */
export type SeederPersistenceKind = "relational" | "document" | "embedded" | "event-sourced";

/** One ordered create-call parameter — the value to substitute when a seed
 *  row's record omits it mirrors {@link createOmissionValue}'s existing
 *  contract (`default` → its expression, a bare `bool` → `false`, else
 *  `null`), generalised to `RequirableInput` so the SAME rule covers an
 *  aggregate FIELD (relational/document/embedded) and a `create` action
 *  PARAMETER (event-sourced) without re-deriving it per shape. */
export interface SeederCreateParam {
  name: string;
  type: TypeIR;
  omission: CreateOmissionValue;
}

/** What a seed emitter needs to know about ONE seedable aggregate. */
export interface SeederAggregate {
  name: string;
  persistenceKind: SeederPersistenceKind;
  /** Ordered create-call parameters — the aggregate's full create-input set
   *  (`createInputFields`) for relational/document/embedded aggregates, or
   *  the event-sourced `create` action's OWN declared params for an
   *  event-sourced one.  The two are NOT the same set (M-T6.52) — this
   *  field is the ONE place that distinction is decided. */
  createParams: SeederCreateParam[];
}

/** {@link createOmissionValue}'s omission rule, generalised over
 *  `RequirableInput` (satisfied by both `FieldIR` and `ParamIR`) so an
 *  event-sourced `create` action's parameters can be given the same
 *  omission treatment as an aggregate's create-input fields without a
 *  second copy of the rule per shape. */
function omissionValueFor(f: RequirableInput): CreateOmissionValue {
  if (f.default !== undefined) return { kind: "default", expr: f.default };
  const base = f.type.kind === "optional" ? f.type.inner : f.type;
  if (base.kind === "primitive" && base.name === "bool") return { kind: "false" };
  return { kind: "null" };
}

/** Derive the seeder model for one aggregate, or `null` when it is not
 *  seedable at all:
 *   - an abstract inheritance base has no create factory and no
 *     repository (`loom.seed-abstract-aggregate` rejects a row at the AST
 *     tier; this is the codegen-side backstop, matching the pre-existing
 *     per-backend `!isAbstract` filters);
 *   - an event-sourced aggregate with no declared `create` action is not
 *     constructible at all (mirrors `emitsRestCreate`'s ES branch and the
 *     elixir command-runner's `:not_constructible` fallback). */
export function seederAggregate(agg: EnrichedAggregateIR): SeederAggregate | null {
  if (agg.isAbstract) return null;
  if (agg.persistedAs === "eventLog") {
    const create = agg.creates?.[0];
    if (!create) return null;
    return {
      name: agg.name,
      persistenceKind: "event-sourced",
      createParams: create.params.map((p) => ({
        name: p.name,
        type: p.type,
        omission: omissionValueFor(p),
      })),
    };
  }
  return {
    name: agg.name,
    persistenceKind: agg.savingShape ?? "relational",
    createParams: createInputFields(agg).map((f) => ({
      name: f.name,
      type: f.type,
      omission: omissionValueFor(f),
    })),
  };
}

/** Every seedable aggregate in a context, keyed by name — the ONE
 *  classifier every backend's seed emitter consults instead of re-deriving
 *  "is this aggregate seedable, and with what create-call shape".  A test
 *  or seed row naming an aggregate absent from this map is not seedable on
 *  any backend (`test/generator/_persistence/seed-model-census.test.ts`). */
export function seederAggregates(ctx: EnrichedBoundedContextIR): Map<string, SeederAggregate> {
  const out = new Map<string, SeederAggregate>();
  for (const a of ctx.aggregates) {
    const s = seederAggregate(a);
    if (s) out.set(a.name, s);
  }
  return out;
}
