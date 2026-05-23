import { snake } from "../util/naming.js";
import type {
  AggregateIR,
  AssociationIR,
  BoundedContextIR,
  CodeRefKind,
  DeployableIR,
  EntityPartIR,
  EnumIR,
  FindIR,
  LoomModel,
  RepositoryIR,
  SystemIR,
  TraceabilityIR,
  TypeIR,
  ValueObjectIR,
  WireField,
} from "./loom-ir.js";

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
  // Root-level VOs / enums are visible from every context as an
  // implicit shared kernel (see docs/multi-file-source.md).  We fold
  // them into each context's effective VO / enum list so every
  // downstream consumer (backends, wire-spec, validators) sees them
  // uniformly through the existing per-context surface.  Output
  // duplicates root types across contexts inside a single deployable
  // — acceptable for Stage A; a future stage may centralise emission
  // into a shared module per deployable.
  const enrichedRootVOs = loom.rootValueObjects.map(enrichValueObject);
  const rootEnums = loom.rootEnums;
  return {
    systems: loom.systems.map((s) => enrichSystem(s, enrichedRootVOs, rootEnums)),
    contexts: loom.contexts.map((c) => enrichContext(c, enrichedRootVOs, rootEnums)),
    rootValueObjects: enrichedRootVOs,
    rootEnums,
    requirements: loom.requirements,
    solutions: loom.solutions,
    testCases: loom.testCases,
    traceability: computeTraceability(loom),
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
export function wireShapeFor(entity: AggregateIR | EntityPartIR | ValueObjectIR): WireField[] {
  if (!entity.wireShape) {
    throw new Error(
      `internal: wireShape not populated on '${entity.name}' — ` +
        "downstream layers must consume an IR that has been " +
        "enriched via `enrichLoomModel(lowerModel(model))`.",
    );
  }
  return entity.wireShape;
}

function enrichSystem(
  sys: SystemIR,
  rootValueObjects: ValueObjectIR[],
  rootEnums: EnumIR[],
): SystemIR {
  // First enrich each module's contexts (auto-findAll, wire-shape).
  const modules = sys.modules.map((m) => ({
    ...m,
    contexts: m.contexts.map((c) => enrichContext(c, rootValueObjects, rootEnums)),
  }));
  // Then propagate react deployables' module sets from their targets.
  // Done after module enrichment so frontends see the same enriched
  // contexts every other consumer sees.
  const deployables = enrichDeployables(sys.deployables);
  // Scaffold expansion now runs at the AST
  // level via `src/language/ddd-scaffold-ast-expander.ts` (a
  // `DocumentState.IndexedContent` hook on the shared
  // DocumentBuilder).  By the time lowering runs, every page is
  // already an explicit AST node, so `ui.pages` carries the full
  // canonical set straight from `lowerUi` — no IR-level pass
  // needed.  The IR-level expander remains as a no-op shim for
  // any caller that constructs a `LoomModel` outside the standard
  // `parseHelper` / `DocumentBuilder` pipeline (it just returns
  // the existing pages unchanged).
  return { ...sys, modules, deployables };
}

function enrichContext(
  ctx: BoundedContextIR,
  rootValueObjects: ValueObjectIR[],
  rootEnums: EnumIR[],
): BoundedContextIR {
  // Fold the ambient root-level VOs / enums into the context's
  // effective set so every per-context emitter sees them as if they
  // were declared locally.  A root-level VO / enum with the same
  // name as a context-local one would shadow; the validator should
  // reject collisions before we get here (Stage A check).
  const ownVoNames = new Set(ctx.valueObjects.map((v) => v.name));
  const ownEnumNames = new Set(ctx.enums.map((e) => e.name));
  const valueObjects = [
    ...ctx.valueObjects.map(enrichValueObject),
    ...rootValueObjects.filter((v) => !ownVoNames.has(v.name)),
  ];
  const enums = [...ctx.enums, ...rootEnums.filter((e) => !ownEnumNames.has(e.name))];
  const aggregates = ctx.aggregates.map(enrichAggregate);
  const repositories = ensureFindAll(aggregates, ctx.repositories);
  return { ...ctx, valueObjects, enums, aggregates, repositories };
}

function enrichAggregate(agg: AggregateIR): AggregateIR {
  const parts = agg.parts.map(enrichPart);
  return {
    ...agg,
    parts,
    wireShape: wireFieldsForAggregate(agg),
    associations: associationsForAggregate(agg),
  };
}

/** Derive a join-table association for every field whose type is a
 * collection of references to another aggregate (`field: T id[]`).
 * Containment collections never reach here — they are `ContainmentIR`,
 * not `FieldIR`. */
function associationsForAggregate(agg: AggregateIR): AssociationIR[] {
  const out: AssociationIR[] = [];
  for (const f of agg.fields) {
    if (f.type.kind !== "array" || f.type.element.kind !== "id") continue;
    const target = f.type.element;
    let ownerFk = `${snake(agg.name)}_id`;
    let targetFk = `${snake(target.targetName)}_id`;
    // Self-referential collection (`Self id[]`): both FKs would
    // collapse to the same column name.  Disambiguate generically.
    if (ownerFk === targetFk) {
      ownerFk = "owner_id";
      targetFk = "target_id";
    }
    out.push({
      fieldName: f.name,
      ownerAgg: agg.name,
      targetAgg: target.targetName,
      valueType: target.valueType,
      joinTable: `${snake(agg.name)}_${snake(f.name)}`,
      ownerFk,
      targetFk,
    });
  }
  return out;
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
function ensureFindAll(aggregates: AggregateIR[], existing: RepositoryIR[]): RepositoryIR[] {
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
    // `static` deployables share the legacy `react` module-
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
      optional: !!c.optional && !c.collection,
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
      optional: !!c.optional && !c.collection,
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

// ---------------------------------------------------------------------------
// Traceability index — derived in one pure pass, exactly
// like wireShape.  Every report generator reads these maps rather than
// recomputing coverage.
// ---------------------------------------------------------------------------

/** One executable test (aggregate `test` / system `test e2e`) flattened
 *  out of the model with its optional `verifies <TestCase>` back-link. */
interface ExecTest {
  name: string;
  /** Runner-reported suite: aggregate name (unit) or `"<System> e2e"`. */
  suite: string;
  kind: "unit" | "api" | "ui";
  verifiesTestCase?: string;
}

function collectExecTests(loom: LoomModel): ExecTest[] {
  const out: ExecTest[] = [];
  // Aggregate `test "..."` blocks → `describe("<agg>")` in the
  // generated `domain/<agg>.test.ts`, so the runner reports
  // `suite = agg.name`.
  const fromContext = (ctx: BoundedContextIR): void => {
    for (const agg of ctx.aggregates) {
      for (const t of agg.tests) {
        out.push({
          name: t.name,
          suite: agg.name,
          kind: "unit",
          verifiesTestCase: t.verifiesTestCase,
        });
      }
    }
  };
  for (const sys of loom.systems) {
    for (const mod of sys.modules) for (const ctx of mod.contexts) fromContext(ctx);
    // System `test e2e "..."` → `describe("<System> e2e")`, so the
    // runner reports `suite = "<sys.name> e2e"`.
    for (const t of sys.e2eTests) {
      out.push({
        name: t.name,
        suite: `${sys.name} e2e`,
        kind: t.kind,
        verifiesTestCase: t.verifiesTestCase,
      });
    }
  }
  for (const ctx of loom.contexts) fromContext(ctx);
  return out;
}

function computeTraceability(loom: LoomModel): TraceabilityIR {
  const childrenOf: Record<string, string[]> = {};
  for (const r of loom.requirements) childrenOf[r.id] ??= [];
  for (const r of loom.requirements) {
    if (r.parentId) (childrenOf[r.parentId] ??= []).push(r.id);
  }

  // Transitive descendants of every requirement (id included excluded).
  const descendantsOf = (id: string): string[] => {
    const acc: string[] = [];
    const stack = [...(childrenOf[id] ?? [])];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue; // guard against accidental cycles
      seen.add(cur);
      acc.push(cur);
      stack.push(...(childrenOf[cur] ?? []));
    }
    return acc;
  };

  // TestCases keyed by the requirement they directly verify.
  const directTests: Record<string, string[]> = {};
  for (const tc of loom.testCases) {
    (directTests[tc.verifies] ??= []).push(tc.id);
  }

  const testsByRequirement: Record<string, string[]> = {};
  for (const r of loom.requirements) {
    const ids = new Set<string>(directTests[r.id] ?? []);
    for (const d of descendantsOf(r.id)) {
      for (const t of directTests[d] ?? []) ids.add(t);
    }
    testsByRequirement[r.id] = [...ids];
  }

  const solutionByRequirement: Record<string, string | null> = {};
  for (const r of loom.requirements) solutionByRequirement[r.id] = null;
  for (const s of loom.solutions) {
    if (
      s.forRequirement in solutionByRequirement &&
      solutionByRequirement[s.forRequirement] === null
    ) {
      solutionByRequirement[s.forRequirement] = s.id;
    }
  }

  const codeElements: Record<string, CodeRefKind> = {};
  for (const s of loom.solutions)
    for (const c of s.entitles) codeElements[c.qualifiedName] = c.kind;
  for (const tc of loom.testCases)
    for (const c of tc.covers) codeElements[c.qualifiedName] = c.kind;

  const testsByCodeElement: Record<string, string[]> = {};
  for (const tc of loom.testCases) {
    for (const c of tc.covers) {
      (testsByCodeElement[c.qualifiedName] ??= []).push(tc.id);
    }
  }

  // Executable-test back-links: TestCase id → exec test names, plus a
  // flat provenance list (suite + kind) for the verification join.
  const allExecTests = collectExecTests(loom);
  const execTestsByTestCase: Record<string, string[]> = {};
  for (const tc of loom.testCases) execTestsByTestCase[tc.id] = [];
  for (const ex of allExecTests) {
    if (ex.verifiesTestCase && ex.verifiesTestCase in execTestsByTestCase) {
      execTestsByTestCase[ex.verifiesTestCase].push(ex.name);
    }
  }
  const execTests = allExecTests.map((ex) => ({
    name: ex.name,
    suite: ex.suite,
    kind: ex.kind,
    testCaseId: ex.verifiesTestCase ?? null,
  }));

  // Propagate exec tests to the code elements their TestCase covers.
  const execTestsByCodeElement: Record<string, string[]> = {};
  for (const tc of loom.testCases) {
    const execs = execTestsByTestCase[tc.id] ?? [];
    if (execs.length === 0) continue;
    for (const c of tc.covers) {
      const bucket = (execTestsByCodeElement[c.qualifiedName] ??= []);
      for (const e of execs) if (!bucket.includes(e)) bucket.push(e);
    }
  }

  return {
    childrenOf,
    testsByRequirement,
    solutionByRequirement,
    codeElements,
    testsByCodeElement,
    execTestsByCodeElement,
    execTestsByTestCase,
    execTests,
  };
}

function idTypeFor(targetName: string): TypeIR {
  return { kind: "id", targetName, valueType: "guid" };
}

function containmentTypeFor(partName: string, collection: boolean): TypeIR {
  return collection
    ? { kind: "array", element: { kind: "entity", name: partName } }
    : { kind: "entity", name: partName };
}
