import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  EntityPartIR,
  FindIR,
  LoomModel,
  RepositoryIR,
  SystemIR,
  TypeIR,
  ValueObjectIR,
  WireField,
} from "./loom-ir.js";
import { expandScaffolds } from "./scaffold-expand.js";

// ---------------------------------------------------------------------------
// Loom IR enrichments — pure derivations layered on top of the IR
// produced by Layer ③ (lowering).  Lowering produces a faithful AST
// projection; this module computes the cross-cutting derivations
// every backend needs.
//
// Why not in lowering: lowering used to mutate the IR in two places
// (auto-`findAll` injection, react deployable's `moduleNames` copy
// from its target).  Hidden side-effects on a structure callers
// think is faithful.  Pulling the derivations out makes the IR
// read-only after lowering and gives downstream layers a single
// "fully computed" entry point: `enrichLoomModel(lowerModel(ast))`.
//
// Derivations applied (in order — each is independent):
//
//   1. Wire-shape on every aggregate / part / value object.
//   2. Auto-included `findAll` on every aggregate's repository.
//   3. React deployable `moduleNames` ← target deployable's modules.
//
// Idempotent: `enrich(enrich(m))` deep-equals `enrich(m)`.
// ---------------------------------------------------------------------------

export function enrichLoomModel(loom: LoomModel): LoomModel {
  return {
    systems: loom.systems.map(enrichSystem),
    contexts: loom.contexts.map(enrichContext),
  };
}

/** Read the populated wire shape for an aggregate / part / value-object.
 *
 * Every backend's response-DTO emitter walks this list to stay in
 * sync with peers — `wireShape` is populated by `enrichLoomModel`
 * during the enrichment pass.  Callers used to write
 * `entity.wireShape!` with a non-null assertion at the consumer
 * site, scattering the same precondition across four files.  This
 * helper centralises the assumption + throws a structured error if
 * an unenriched IR ever reaches a downstream layer (which would
 * indicate a missed `enrichLoomModel(lowerModel(model))` call). */
export function wireShapeFor(
  entity: AggregateIR | EntityPartIR | ValueObjectIR,
): WireField[] {
  if (!entity.wireShape) {
    throw new Error(
      `internal: wireShape not populated on '${entity.name}' — ` +
        "downstream layers must consume an IR that has been " +
        "enriched via `enrichLoomModel(lowerModel(model))`.",
    );
  }
  return entity.wireShape;
}

function enrichSystem(sys: SystemIR): SystemIR {
  // First enrich each module's contexts (auto-findAll, wire-shape).
  const modules = sys.modules.map((m) => ({
    ...m,
    contexts: m.contexts.map(enrichContext),
  }));
  // Then propagate react deployables' module sets from their targets.
  // Done after module enrichment so frontends see the same enriched
  // contexts every other consumer sees.
  const deployables = enrichDeployables(sys.deployables);
  // Slice 4 — expand each `ui` block's scaffold directives against
  // the post-enrichment domain IR.  The expander preserves explicit
  // pages (lowering populated `ui.pages` with them) and appends
  // scaffold-synthesised pages for any directive whose generated
  // page name doesn't collide with an explicit one.  Override-by-
  // name is the same mechanism: an explicit `page <Name>` displaces
  // the matching scaffold output without ceremony.
  const enrichedSys: SystemIR = { ...sys, modules, deployables };
  const uis = sys.uis.map((ui) => {
    const { pages } = expandScaffolds(ui, enrichedSys);
    return { ...ui, pages };
  });
  return { ...enrichedSys, uis };
}

function enrichContext(ctx: BoundedContextIR): BoundedContextIR {
  const valueObjects = ctx.valueObjects.map(enrichValueObject);
  const aggregates = ctx.aggregates.map(enrichAggregate);
  const repositories = ensureFindAll(aggregates, ctx.repositories);
  return { ...ctx, valueObjects, aggregates, repositories };
}

function enrichAggregate(agg: AggregateIR): AggregateIR {
  const parts = agg.parts.map(enrichPart);
  return {
    ...agg,
    parts,
    wireShape: wireFieldsForAggregate(agg),
  };
}

function enrichPart(part: EntityPartIR): EntityPartIR {
  return { ...part, wireShape: wireFieldsForPart(part) };
}

function enrichValueObject(vo: ValueObjectIR): ValueObjectIR {
  return { ...vo, wireShape: wireFieldsForValueObject(vo) };
}

/** Every aggregate gets a repository with an implicit `find all():
 * T[]` query, mirroring how `findById` is implicit.  If the user
 * already declared a `find all(...)` of any shape, theirs wins. */
function ensureFindAll(
  aggregates: AggregateIR[],
  existing: RepositoryIR[],
): RepositoryIR[] {
  const out = existing.map((r) => ({ ...r, finds: [...r.finds] }));
  for (const agg of aggregates) {
    let repo = out.find((r) => r.aggregateName === agg.name);
    if (!repo) {
      repo = { name: `${agg.name}s`, aggregateName: agg.name, finds: [] };
      out.push(repo);
    }
    if (!repo.finds.some((f) => f.name === "all")) {
      const all: FindIR = {
        name: "all",
        params: [],
        returnType: { kind: "array", element: { kind: "entity", name: agg.name } },
      };
      repo.finds = [all, ...repo.finds];
    }
  }
  return out;
}

/** React frontends inherit their module set from `targets:` so every
 * place that walks `moduleNames` sees the same surface the backend
 * exposes.  No-op if the target isn't found (validator already
 * rejects that case). */
function enrichDeployables(deployables: DeployableIR[]): DeployableIR[] {
  return deployables.map((d) => {
    // Slice 8: `static` deployables share the legacy `react` module-
    // inheritance behaviour — they're frontend deployables that
    // serve a built bundle and need to know about every context the
    // target backend exposes (so the page-IR emitter has every
    // aggregate's wire shape in scope).
    const isFrontend = d.platform === "react" || d.platform === "static";
    if (!isFrontend || !d.targetName) return d;
    const target = deployables.find((t) => t.name === d.targetName);
    if (!target) return d;
    return { ...d, moduleNames: [...target.moduleNames] };
  });
}

// ---------------------------------------------------------------------------
// Wire-shape derivation.
//
// The single source of truth for the canonical JSON shape an
// aggregate / part / value object takes on the network.  Every wire
// emitter (Hono routes, Hono `toWire`, .NET DTOs + projection,
// React Zod schemas) walks this list — order is the contract:
//
//   1. `id`              — always first (aggregates / parts only)
//   2. each `Property`   — declaration order
//   3. each `Containment` — declaration order, array vs single
//   4. each `Derived`    — declaration order
//
// Value objects skip steps 1 + 3 (no identity, no containment).
// ---------------------------------------------------------------------------

function wireFieldsForAggregate(agg: AggregateIR): WireField[] {
  const out: WireField[] = [
    { name: "id", type: idTypeFor(agg.name), optional: false, source: "id" },
  ];
  for (const f of agg.fields) {
    out.push({ name: f.name, type: f.type, optional: f.optional, source: "property" });
  }
  for (const c of agg.contains) {
    out.push({
      name: c.name,
      type: containmentTypeFor(c.partName, c.collection),
      optional: false,
      source: "containment",
    });
  }
  for (const d of agg.derived) {
    out.push({ name: d.name, type: d.type, optional: false, source: "derived" });
  }
  return out;
}

function wireFieldsForPart(part: EntityPartIR): WireField[] {
  const out: WireField[] = [
    { name: "id", type: idTypeFor(part.name), optional: false, source: "id" },
  ];
  for (const f of part.fields) {
    out.push({ name: f.name, type: f.type, optional: f.optional, source: "property" });
  }
  for (const c of part.contains) {
    out.push({
      name: c.name,
      type: containmentTypeFor(c.partName, c.collection),
      optional: false,
      source: "containment",
    });
  }
  for (const d of part.derived) {
    out.push({ name: d.name, type: d.type, optional: false, source: "derived" });
  }
  return out;
}

function wireFieldsForValueObject(vo: ValueObjectIR): WireField[] {
  const out: WireField[] = [];
  for (const f of vo.fields) {
    out.push({ name: f.name, type: f.type, optional: f.optional, source: "property" });
  }
  for (const d of vo.derived) {
    out.push({ name: d.name, type: d.type, optional: false, source: "derived" });
  }
  return out;
}

function idTypeFor(targetName: string): TypeIR {
  return { kind: "id", targetName, valueType: "guid" };
}

function containmentTypeFor(partName: string, collection: boolean): TypeIR {
  return collection
    ? { kind: "array", element: { kind: "entity", name: partName } }
    : { kind: "entity", name: partName };
}
