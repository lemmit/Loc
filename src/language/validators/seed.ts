// Seed-declaration checks (database-seeding.md, declarative form).
//
// Model-level so the foreign-aggregate rule can compare a row's resolved
// aggregate against the seed's enclosing context.  Scope is the
// false-positive-free subset: a row may only seed an aggregate of its own
// context, and a row's record may not repeat a field name.  Create-parameter
// shape-checking, `@handle` resolution, and the `raw`-bypasses-invariant
// warning are not checked.
//
// Rules 5-8 are the AST-tier home for four crossings every backend got WRONG
// in a different way (`F2-SEED-*`, targets-completeness-2026-08-30).  They sit
// here rather than in one backend's emitter for the reason the audit gave: the
// defect was five emitters disagreeing about the same `.ddd`, so the answer has
// to be ONE rule all five inherit, raised before any of them runs.

import { AstUtils, type ValidationAcceptor } from "langium";
import { diagMessage } from "../../diagnostics/messages.js";
import { CAPABILITIES_TAG } from "../../util/capability-tag.js";
import { snake, upperFirst } from "../../util/naming.js";
import type { Aggregate, BoundedContext, Model, Seed } from "../generated/ast.js";
import { isBoundedContext, isBuilderCall, isObjectLit, isSeed } from "../generated/ast.js";

/** The `tenantOwned` prelude capability (src/macros/prelude.ts).  Spelled here
 *  rather than imported from `src/ir/util/tenant-stance.ts`: `language/` knows
 *  nothing about `ir/` (the pipeline's layer rule). */
const TENANT_OWNED = "tenantOwned";

/** Typed capabilities applied to an aggregate, read from the transient
 *  annotation the macro expander (phase ②) stashes on the node — the same
 *  record `collectCapabilities` reads at lowering.  Phase ② runs BEFORE the AST
 *  validators (phase ④), so the tag is already populated here. */
function capabilitiesOf(agg: Aggregate): readonly string[] {
  return (agg as { [CAPABILITIES_TAG]?: string[] })[CAPABILITIES_TAG] ?? [];
}

export function checkSeeds(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (isSeed(node)) checkSeed(node, accept);
    if (isBoundedContext(node)) checkDatasetNameCollisions(node, accept);
  }
}

/** Rule 5 — two `seed` blocks in one context whose dataset names collide once
 *  a backend cases them into a FUNCTION IDENTIFIER.
 *
 *  `groupByDataset` keys datasets by their raw name, and each backend derives
 *  the seeder function's identifier by casing it — `snake(name)` on
 *  elixir/python, `upperFirst(name)` on node/java/.NET — with no uniquifier.
 *  So `seed default` + `seed Default` emitted two `seedDefault(...)` /
 *  `defp seed_default(...)` definitions from one clean parse: a hard compile
 *  error on node/java/.NET, and on elixir/python the second definition wins
 *  (or is unreachable) so ONE of the two datasets silently never applies while
 *  its marker bookkeeping still reads as present.
 *
 *  The check is the union of the transforms actually applied, not a blanket
 *  case-insensitive compare — `a_b` vs `ab` collide under neither, and
 *  rejecting them would be a false positive. */
function checkDatasetNameCollisions(ctx: BoundedContext, accept: ValidationAcceptor): void {
  const seeds = ctx.members.filter(isSeed);
  // Same-named blocks MERGE into one dataset (`groupByDataset`), so only
  // DISTINCT names that collide after casing are a defect.
  const firstByName = new Map<string, Seed>();
  for (const s of seeds) {
    const name = s.dataset ?? "default";
    if (!firstByName.has(name)) firstByName.set(name, s);
  }
  const byIdent = new Map<string, string>();
  for (const [name, seed] of firstByName) {
    for (const ident of [`snake:${snake(name)}`, `pascal:${upperFirst(name)}`]) {
      const prior = byIdent.get(ident);
      if (prior !== undefined && prior !== name) {
        accept("error", diagMessage("loom.seed-dataset-name-collision", { name, name2: prior }), {
          node: seed,
          property: "dataset",
          code: "loom.seed-dataset-name-collision",
        });
        break;
      }
      byIdent.set(ident, name);
    }
  }
}

function checkSeed(seed: Seed, accept: ValidationAcceptor): void {
  const ownCtx = AstUtils.getContainerOfType(seed, isBoundedContext);
  for (const row of seed.rows) {
    const rowAgg = row.aggregate.ref;
    if (rowAgg) {
      // Rule 6 — an event-sourced aggregate's truth is its event stream, and
      // no backend has a seed path that APPENDS one.  Three of five were wrong
      // in two different ways with zero diagnostics: elixir dropped the row and
      // still committed the dataset's ship-once marker (so a later boot could
      // never apply it), while java/.NET built the create call from the full
      // create-input set against a factory that takes only the declared
      // `create` parameters — `Account.create("seeded-alice", null)` against
      // `create(String owner)`, a javac/CS1501 break.  Gate all five
      // identically until an event-append seed path exists.
      if (rowAgg.persistedAs === "eventLog") {
        accept("error", diagMessage("loom.seed-event-sourced-unsupported", { name: rowAgg.name }), {
          node: row,
          property: "aggregate",
          code: "loom.seed-event-sourced-unsupported",
        });
      }

      // Rule 6b — the OTHER half of the same per-row filter.  Every backend
      // drops a row whose aggregate is an abstract inheritance base
      // (`!isAbstractBase` / `!a.isAbstract`) because a base has no create
      // factory and no repository — and elixir then still commits the dataset's
      // ship-once marker, so the dataset can never be re-applied.  Rules 6 and
      // 6b together are what makes that filter unable to shrink a dataset it
      // marks as applied; seed the concrete subtype instead.
      if (rowAgg.isAbstract) {
        accept("error", diagMessage("loom.seed-abstract-aggregate", { name: rowAgg.name }), {
          node: row,
          property: "aggregate",
          code: "loom.seed-abstract-aggregate",
        });
      }

      // Rule 7 — a `shape: document` aggregate's table is `(id, data, version)`;
      // it has no per-field columns.  The shared `renderSeedRowInsert` maps each
      // declared field to a COLUMN with no knowledge of the saving shape, so
      // every backend emitted `INSERT INTO "articles" ("id", "title", …)`
      // against that jsonb table — `42703 column "title" does not exist` on
      // first boot, and on elixir the seeder runs from a supervision-tree child
      // so the raise takes the whole application down.  The DOMAIN path is
      // correct for a document aggregate (verified on all five), so this rejects
      // only the `raw` crossing and names the working alternative.
      if (seed.raw && rowAgg.shape === "document") {
        accept("error", diagMessage("loom.seed-raw-document-shape", { name: rowAgg.name }), {
          node: row,
          property: "aggregate",
          code: "loom.seed-raw-document-shape",
        });
      }

      // Rule 8 — the domain seed path on a `tenantOwned` aggregate.  The
      // capability keeps `tenantId`/`dataKey` `internal` (out of every create
      // input) and stamps them FROM THE PRINCIPAL; a first-boot seeder has no
      // principal, so the row lands with a NULL/empty tenant against a
      // `NOT NULL` column and is invisible to the capability's own read filter
      // (`tenant_id = NULL` matches nothing).  Five backends, five spellings of
      // the same unreadable row.  The `raw` path CAN carry the tenant — it
      // writes columns directly — so that is what the message points at.
      if (!seed.raw && capabilitiesOf(rowAgg).includes(TENANT_OWNED)) {
        accept("error", diagMessage("loom.seed-tenant-owned-needs-raw", { name: rowAgg.name }), {
          node: row,
          property: "aggregate",
          code: "loom.seed-tenant-owned-needs-raw",
        });
      }
    }

    // Rule 1 — a seed may only populate aggregates of its own context.
    // (Same scoping a workflow body has; a cross-context seed would seed
    // through another context's create surface.)
    const agg = rowAgg;
    if (agg && ownCtx) {
      const aggCtx = AstUtils.getContainerOfType(agg, isBoundedContext);
      if (aggCtx && aggCtx !== ownCtx) {
        accept(
          "error",
          diagMessage("loom.seed-foreign-aggregate", {
            name: agg.name,
            aggCtxName: aggCtx.name,
            ownCtxName: ownCtx.name,
          }),
          { node: row, property: "aggregate", code: "loom.seed-foreign-aggregate" },
        );
      }
    }

    // Rule 2 — a record may not repeat a field name.  `row.value` can be
    // undefined on a partially-parsed AST (langium validates broken input);
    // guard so the validator reports the parse error rather than throwing.
    const seen = new Set<string>();
    for (const f of row.value?.fields ?? []) {
      if (seen.has(f.name)) {
        accept(
          "error",
          diagMessage("loom.seed-duplicate-field", { name: f.name, name2: agg?.name ?? "?" }),
          {
            node: f,
            property: "name",
            code: "loom.seed-duplicate-field",
          },
        );
      }
      seen.add(f.name);

      if (!seed.raw && f.name === "id") {
        // Rule 3 — an explicit `id` requires the `raw` path; the domain
        // `create` path mints ids (D-SEED-PATH / D-SEED-XREF).
        accept("error", diagMessage("loom.seed-id-needs-raw"), {
          node: f,
          property: "name",
          code: "loom.seed-id-needs-raw",
        });
      }

      if (seed.raw && (isObjectLit(f.value) || isBuilderCall(f.value))) {
        // Rule 4 — raw rows are direct column inserts: scalar / enum / id
        // literals only.  Value-object / containment columns route through
        // the domain path.
        accept("error", diagMessage("loom.seed-raw-column-invalid", { name: f.name }), {
          node: f,
          property: "value",
          code: "loom.seed-raw-column-invalid",
        });
      }
    }
  }
}
