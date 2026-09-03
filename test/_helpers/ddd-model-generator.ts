// A seeded generator of RANDOM VALID `.ddd` models (M-T9.22, slice 1).
//
// Every other gate in this repo drives the pipeline with a FIXED fixture set —
// the corpus, the examples, the behavioral systems.  Those prove the compiler
// handles the models someone wrote; they say nothing about the input SPACE
// around them.  This generator is the inverse: it emits valid models the
// pipeline has never seen and asserts the invariant that must hold for all of
// them — a crash on VALID input is always a bug, either a missing validator
// gate or an emitter hole.
//
// Deterministic by construction: a seeded PRNG (no `Math.random`), so a failure
// reproduces from its seed alone and CI never flakes.  The consumer prints the
// seed and the generated source on failure, which is the repro fixture.
//
// The generator is deliberately CONSERVATIVE about validity — it only emits
// type-correct assignments, references that resolve, and finds over filterable
// types.  That matters more than breadth: an INVALID model proves nothing about
// behaviour on valid input, and a generator that emits them turns the gate into
// noise.  Both times this generator produced an invalid model while it was being
// written (a string literal assigned to a `money` field; `literalFor` returning
// `undefined` for an `X id` type), the consumer reported it as loudly as a real
// defect — which is the property that keeps the harness honest as it grows.
//
// Growing it is the point: each new shape is a new region of the input space.
// Today it covers scalar + enum + `X id` fields, optional fields, `derived`,
// `invariant`, containments with their part entity, `crudish` vs a hand-written
// `create`, guarded operations, and declared finds.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const int = (r: () => number, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1));
const shuffled = <T>(r: () => number, xs: readonly T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
};

const SCALARS = ["string", "int", "bool", "decimal", "money", "datetime"];
const NAMES = ["Order", "Invoice", "Ticket", "Account", "Shipment", "Widget", "Parcel", "Claim"];
const FIELDS = ["code", "label", "amount", "quantity", "active", "note", "total", "openedAt"];

/** A literal of the given declared type — the generator only ever emits
 *  type-correct assignments, because an INVALID model proves nothing about the
 *  pipeline's behaviour on valid input. */
const literalFor = (t: string): string | undefined =>
  ({
    string: '"x"',
    int: "1",
    bool: "true",
    decimal: "1.5",
    money: 'money("1.00")',
    datetime: "now()",
    Status: "Status.Closed",
  })[t as keyof Record<string, string>];

/** Types whose `==` comparison is safe in a find's where-clause. */
const FILTERABLE = new Set(["string", "int", "bool", "Status"]);

/** The slice-1 shape: one context of aggregates + repositories, no UI, no
 *  value objects, no workflows.  Kept BYTE-IDENTICAL — `pipeline-fuzz.test.ts`
 *  runs 250 fixed seeds through it in the fast suite, so any drift here silently
 *  moves that gate's whole corpus.  Growth goes in the `deep` arm below. */
function genShallowModel(seed: number): string {
  const r = rng(seed);
  const aggNames = shuffled(r, NAMES).slice(0, int(r, 1, 3));
  const useEnum = r() < 0.5;
  const enumDecl = useEnum ? "      enum Status { Draft Open Closed }\n" : "";
  const parts = [];
  for (const agg of aggNames) {
    // (name, type) pairs — carried together so every downstream use (create
    // params, operation assignments, find filters) stays type-correct.
    const fields = shuffled(r, FIELDS)
      .slice(0, int(r, 1, 4))
      .map((name) => ({ name, type: pick(r, SCALARS) as string }));
    if (useEnum && r() < 0.6) fields.push({ name: "status", type: "Status" });
    // A CROSS-AGGREGATE reference — `X id`, the FK + join-planning path.  Only
    // ever points at an aggregate declared BEFORE this one, so the reference
    // always resolves.
    const earlier = aggNames.slice(0, aggNames.indexOf(agg));
    if (earlier.length > 0 && r() < 0.5) {
      const target = pick(r, earlier);
      fields.push({ name: `${target.toLowerCase()}Id`, type: `${target} id` });
    }

    const crudish = r() < 0.6 ? " with crudish" : "";
    const decls = fields.map((f) => `        ${f.name}: ${f.type}`).join("\n");

    // A hand-written create when `crudish` did not supply one.
    const first = fields[0] as { name: string; type: string };
    const create = crudish
      ? ""
      : `\n        create(${first.name}: ${first.type}) {\n          ${first.name} := ${first.name}\n        }`;

    // A named operation assigning one field, optionally guarded.
    let ops = "";
    const assignable = fields.filter((f) => literalFor(f.type) !== undefined);
    if (assignable.length > 0 && r() < 0.6) {
      const f = pick(r, assignable);
      const numeric = f.type === "int" || f.type === "decimal";
      const pre = numeric ? `\n          precondition this.${f.name} >= 0` : "";
      ops = `\n        operation touch() {${pre}\n          ${f.name} := ${literalFor(f.type)}\n        }`;
    }

    // A declared find over a filterable field.
    const filterable = fields.filter((f) => FILTERABLE.has(f.type));
    let finds = "";
    if (filterable.length > 0 && r() < 0.6) {
      const f = pick(r, filterable);
      finds = `\n        find by${f.name[0].toUpperCase()}${f.name.slice(1)}(v: ${f.type}): ${agg}[] where this.${f.name} == v`;
    }

    // An OPTIONAL field — the null-handling path through every wire mapper.
    const optional = r() < 0.4 ? `\n        memo: string?` : "";

    // A DERIVED field — a pure expression evaluated per read.
    const strField = fields.find((f) => f.type === "string");
    const derived =
      strField && r() < 0.4 ? `\n        derived display: string = ${strField.name}` : "";

    // An INVARIANT — a per-save assertion, and the wire-boundary refine.
    const numField = fields.find((f) => f.type === "int" || f.type === "decimal");
    const invariant = numField && r() < 0.35 ? `\n        invariant ${numField.name} >= 0` : "";

    // A CONTAINMENT — a child entity collection (its own table / jsonb blob,
    // depending on shape) plus the part declaration it needs.
    const contains =
      r() < 0.35
        ? `\n        contains lines: ${agg}Line[]\n        entity ${agg}Line {\n          sku: string\n          qty: int\n        }`
        : "";

    parts.push(
      `      aggregate ${agg}${crudish} {\n${decls}${optional}${derived}${invariant}${contains}${create}${ops}\n      }\n` +
        `      repository ${agg}s for ${agg} {${finds}\n      }`,
    );
  }
  return `system Fuzz${seed} {
  subdomain S {
    context C {
${enumDecl}${parts.join("\n")}
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable d { platform: __PLATFORM__ contexts: [C] dataSources: [st] serves: A port: 4000 }
}
`;
}

// ---------------------------------------------------------------------------
// The DEEP arm (M-T9.22, slice 2).
//
// Slice 1's shape stops at the backend: aggregates, repositories, one
// deployable.  Everything the FRONTEND half of the toolchain owns — pages, the
// body walker, the menu derivation, page objects — and everything the
// orchestration half owns — workflows, sagas, event dispatch — was outside the
// generated input space, so the 250-seed leg could never reach an emitter hole
// there.  Nor could a value object, whose wire shape is a different code path
// from an aggregate's on every backend.
//
// The deep arm adds those regions.  It differs from the shallow one in TWO
// ways, and the second is the one that matters:
//
//   1. Breadth — value objects (with invariants), UI pages carrying real
//      walker primitives (`Table`/`Column`/`QueryView`, `CreateForm`, `Stat`,
//      `Card`, `Heading`, `Text`) plus a `menu {}` block, workflows (a `create`
//      starter that emits, optionally an `on` reactor correlating on a state
//      field), and the three find shapes — collection / optional-single /
//      `paged` — over scalar, enum and OPTIONAL fields.
//
//   2. It generates a DECISION RECORD (`ModelSpec`), not a string.  The string
//      is a pure function of that record (`emitModel`).  That is what makes
//      shrinking possible: `ddd-model-shrink.ts` removes whole declarations
//      from the record and re-emits, so a failing model reduces to the two or
//      three declarations that actually carry the bug.  A generator that only
//      ever produced strings could shrink by deleting LINES, which produces
//      models that no longer parse — the shrink would then report "no longer
//      reproduces" at every step, for the wrong reason.
//
// `genModel(seed)` keeps the slice-1 output byte-for-byte; the deep arm is
// behind `genModel(seed, { deep: true })`.  The two share the PRNG and the name
// pools and nothing else, deliberately: the fast leg's corpus must not move
// when this arm grows.
// ---------------------------------------------------------------------------

/** One declared property. `optional` is a separate axis so the shrinker can
 *  un-optional a field without deleting it (`string?` → `string`). */
export type FieldSpec = { name: string; type: string; optional: boolean };

/** A value object — its own wire shape, its own validation surface, and on
 *  every backend a different emission path from an aggregate's. */
export type VoSpec = { name: string; fields: FieldSpec[]; invariants: string[] };

/** A repository find. `field === null` is the unfiltered form (`find recent():
 *  X paged`); `shape` picks collection / optional-single / paged. */
export type FindSpec = {
  name: string;
  field: string | null;
  fieldType: string | null;
  shape: "many" | "single" | "paged";
};

/** A containment — the child entity collection plus its `entity` declaration. */
export type PartSpec = { collection: string; entity: string };

/** A guarded operation assigning one field. */
export type OpSpec = { name: string; field: string; literal: string; precondition: string | null };

export type AggSpec = {
  name: string;
  crudish: boolean;
  fields: FieldSpec[];
  derived: { name: string; from: string } | null;
  invariant: { field: string } | null;
  part: PartSpec | null;
  op: OpSpec | null;
  /** Hand-written `create` over one field, emitted when `crudish` is false. */
  createField: string | null;
  finds: FindSpec[];
};

/** A context-level event. Always carries a reference to its aggregate, so a
 *  workflow can correlate on it. */
export type EventSpec = { name: string; agg: string };

/** A workflow: a `create` starter that builds its aggregate and emits, plus
 *  (when `reactor`) an `on(e: Event) by …` continuation correlating on the
 *  workflow's own `item` state field — the saga shape. */
export type WorkflowSpec = { name: string; agg: string; event: string; reactor: boolean };

export type PageSpec = {
  name: string;
  route: string;
  title: string;
  label: string;
  /** `board` = QueryView + Table over the api; `new` = Card + CreateForm;
   *  `overview` = Stat + Card + Text, needing no aggregate at all. */
  kind: "board" | "new" | "overview";
  agg: string | null;
};

export type UiSpec = { name: string; apiParam: string; section: string; pages: PageSpec[] };

/** The whole decision record. `emitModel` is a pure function of it, and the
 *  shrinker only ever removes from it — so every intermediate model a shrink
 *  tries is one this generator could itself have produced. */
export type ModelSpec = {
  seed: number;
  enumDecl: boolean;
  vos: VoSpec[];
  aggs: AggSpec[];
  events: EventSpec[];
  workflows: WorkflowSpec[];
  ui: UiSpec | null;
};

const VO_NAMES = ["Amount", "Ratio", "Extent"];
const VO_FIELDS: readonly FieldSpec[] = [
  { name: "value", type: "decimal", optional: false },
  { name: "currency", type: "string", optional: false },
  { name: "scale", type: "int", optional: false },
];

/** The invariant a VO field carries. Derived from the field, so a shrunk VO
 *  never keeps an invariant over a field it no longer has. */
const voInvariant = (f: FieldSpec): string =>
  f.type === "string" ? `${f.name}.length == 3` : `${f.name} >= 0`;

const lowerFirst = (s: string): string => `${s[0]?.toLowerCase() ?? ""}${s.slice(1)}`;

// ---------------------------------------------------------------------------
// Decision record → source.  Pure; the same spec always yields the same bytes.
// ---------------------------------------------------------------------------

function emitVo(vo: VoSpec): string {
  const fields = vo.fields.map((f) => `        ${f.name}: ${f.type}`).join("\n");
  const invs = vo.invariants.map((i) => `\n        invariant ${i}`).join("");
  return `      valueobject ${vo.name} {\n${fields}${invs}\n      }`;
}

function emitAgg(agg: AggSpec): string {
  const decls = agg.fields
    .map((f) => `        ${f.name}: ${f.type}${f.optional ? "?" : ""}`)
    .join("\n");
  const derived = agg.derived
    ? `\n        derived ${agg.derived.name}: string = ${agg.derived.from}`
    : "";
  const invariant = agg.invariant ? `\n        invariant ${agg.invariant.field} >= 0` : "";
  const part = agg.part
    ? `\n        contains ${agg.part.collection}: ${agg.part.entity}[]` +
      `\n        entity ${agg.part.entity} {\n          sku: string\n          qty: int\n        }`
    : "";
  const createField = agg.fields.find((f) => f.name === agg.createField);
  const create =
    createField === undefined
      ? ""
      : `\n        create(${createField.name}: ${createField.type}) {` +
        `\n          ${createField.name} := ${createField.name}\n        }`;
  const op = agg.op
    ? `\n        operation ${agg.op.name}() {` +
      (agg.op.precondition ? `\n          precondition ${agg.op.precondition}` : "") +
      `\n          ${agg.op.field} := ${agg.op.literal}\n        }`
    : "";
  const finds = agg.finds
    .map((f) => {
      const ret =
        f.shape === "many"
          ? `${agg.name}[]`
          : f.shape === "single"
            ? `${agg.name}?`
            : `${agg.name} paged`;
      const param = f.field === null ? "" : `v: ${f.fieldType}`;
      const where = f.field === null ? "" : ` where this.${f.field} == v`;
      return `\n        find ${f.name}(${param}): ${ret}${where}`;
    })
    .join("");
  return (
    `      aggregate ${agg.name}${agg.crudish ? " with crudish" : ""} {\n` +
    `${decls}${derived}${invariant}${part}${create}${op}\n      }\n` +
    `      repository ${agg.name}s for ${agg.name} {${finds}\n      }`
  );
}

const emitEvent = (ev: EventSpec): string =>
  `      event ${ev.name} { item: ${ev.agg} id, at: datetime }`;

/** A workflow's `create` takes one parameter per REQUIRED field of its
 *  aggregate and passes them straight through, so no literal ever has to be
 *  synthesised for a value-object or `X id` field.  Derived from the aggregate
 *  at emit time, so dropping a field in the shrinker fixes the workflow too. */
function emitWorkflow(wf: WorkflowSpec, aggs: readonly AggSpec[]): string {
  const agg = aggs.find((a) => a.name === wf.agg) as AggSpec;
  const required = agg.fields.filter((f) => !f.optional);
  const params = required.map((f) => `${f.name}: ${f.type}`).join(", ");
  const assigns = required.map((f) => `${f.name}: ${f.name}`).join(", ");
  const state = wf.reactor ? `\n        item: ${agg.name} id\n        attempts: int` : "";
  const correlate = wf.reactor ? "\n          item := built.id" : "";
  const reactor = wf.reactor
    ? `\n        on(e: ${wf.event}) by e.item {\n          attempts := 1\n        }`
    : "";
  return (
    `      workflow ${wf.name} {${state}\n` +
    `        create(${params}) {\n` +
    `          let built = ${agg.name}.create({ ${assigns} })${correlate}\n` +
    `          emit ${wf.event} { item: built.id, at: now() }\n` +
    `        }${reactor}\n      }`
  );
}

function emitPage(p: PageSpec, ui: UiSpec, order: number): string {
  const meta =
    `    page ${p.name} {\n` +
    `      route: "${p.route}"\n` +
    `      title: "${p.title}"\n` +
    `      menu { section: "${ui.section}", label: "${p.label}", order: ${order} }\n`;
  const body =
    p.kind === "board"
      ? `      body: Stack {\n` +
        `        Heading { "${p.title}", level: 2 },\n` +
        `        QueryView { of: ${ui.apiParam}.${p.agg}.all, data: rows => Table { rows: rows, Column { "Id", r => r.id } } }\n` +
        `      }\n`
      : p.kind === "new"
        ? `      body: Card { "${p.title}", CreateForm { of: ${p.agg} } }\n`
        : `      body: Stack {\n` +
          `        Stat { "Records", "0" },\n` +
          `        Card { "About", Text { "generated by seed" } }\n` +
          `      }\n`;
  return `${meta}${body}    }`;
}

function emitUi(ui: UiSpec): string {
  const pages = ui.pages.map((p, i) => emitPage(p, ui, i)).join("\n");
  const links = ui.pages.map((p) => `        link ${p.name}`).join(",\n");
  return (
    `  ui ${ui.name} {\n` +
    `    api ${ui.apiParam}: A\n` +
    `${pages}\n` +
    `    menu {\n      section "${ui.section}" {\n${links}\n      }\n    }\n` +
    `  }\n` +
    `  deployable web { platform: react targets: d ui: ${ui.name} { ${ui.apiParam}: d } port: 5000 }\n`
  );
}

/** Render a decision record as `.ddd` source. */
export function emitModel(spec: ModelSpec): string {
  const decls = [
    spec.enumDecl ? "      enum Status { Draft Open Closed }" : "",
    ...spec.vos.map(emitVo),
    ...spec.events.map(emitEvent),
    ...spec.aggs.map(emitAgg),
    ...spec.workflows.map((w) => emitWorkflow(w, spec.aggs)),
  ].filter((s) => s !== "");
  return `system Fuzz${spec.seed} {
  subdomain S {
    context C {
${decls.join("\n")}
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable d { platform: __PLATFORM__ contexts: [C] dataSources: [st] serves: A port: 4000 }
${spec.ui === null ? "" : emitUi(spec.ui)}}
`;
}

// ---------------------------------------------------------------------------
// Seed → decision record.
// ---------------------------------------------------------------------------

function genDeepSpec(seed: number): ModelSpec {
  const r = rng(seed);
  const aggNames = shuffled(r, NAMES).slice(0, int(r, 1, 3));
  const enumDecl = r() < 0.6;

  // Value objects first — an aggregate may then take one as a field type.
  const vos: VoSpec[] = [];
  for (const name of shuffled(r, VO_NAMES).slice(0, int(r, 0, 2))) {
    const fields = shuffled(r, VO_FIELDS).slice(0, int(r, 1, 3));
    const invariants = fields.filter(() => r() < 0.6).map(voInvariant);
    vos.push({ name, fields, invariants });
  }

  const aggs: AggSpec[] = [];
  for (const name of aggNames) {
    const fields: FieldSpec[] = shuffled(r, FIELDS)
      .slice(0, int(r, 1, 3))
      .map((f) => ({ name: f, type: pick(r, SCALARS) as string, optional: false }));
    if (enumDecl && r() < 0.6) fields.push({ name: "status", type: "Status", optional: false });
    if (vos.length > 0 && r() < 0.5)
      fields.push({ name: "price", type: pick(r, vos).name, optional: false });
    const earlier = aggNames.slice(0, aggNames.indexOf(name));
    if (earlier.length > 0 && r() < 0.5) {
      const target = pick(r, earlier);
      fields.push({ name: `${lowerFirst(target)}Id`, type: `${target} id`, optional: false });
    }
    if (r() < 0.5) fields.push({ name: "memo", type: "string", optional: true });

    const strField = fields.find((f) => f.type === "string" && !f.optional);
    const numField = fields.find((f) => f.type === "int" || f.type === "decimal");
    const assignable = fields.filter((f) => literalFor(f.type) !== undefined && !f.optional);

    // Finds — the three return shapes over a filterable field, plus the
    // unfiltered `paged` form.  Optional fields are filterable too: `where
    // this.memo == v` against a non-optional parameter is the null-comparison
    // path through every backend's query builder.
    const filterable = fields.filter((f) => FILTERABLE.has(f.type));
    const finds: FindSpec[] = [];
    for (const f of shuffled(r, filterable).slice(0, int(r, 0, 2))) {
      const shape = pick(r, ["many", "single", "paged"] as const);
      const cap = `${f.name[0]?.toUpperCase() ?? ""}${f.name.slice(1)}`;
      finds.push({
        name: `by${cap}${shape === "paged" ? "Paged" : ""}`,
        field: f.name,
        fieldType: f.type,
        shape,
      });
    }
    if (r() < 0.4) finds.push({ name: "recent", field: null, fieldType: null, shape: "paged" });

    const crudish = r() < 0.6;
    aggs.push({
      name,
      crudish,
      fields,
      derived:
        strField !== undefined && r() < 0.4 ? { name: "display", from: strField.name } : null,
      invariant: numField !== undefined && r() < 0.35 ? { field: numField.name } : null,
      part: r() < 0.35 ? { collection: "lines", entity: `${name}Line` } : null,
      op:
        assignable.length > 0 && r() < 0.5
          ? (() => {
              const f = pick(r, assignable);
              const numeric = f.type === "int" || f.type === "decimal";
              return {
                name: "touch",
                field: f.name,
                literal: literalFor(f.type) as string,
                precondition: numeric ? `this.${f.name} >= 0` : null,
              };
            })()
          : null,
      createField: crudish ? null : (fields[0] as FieldSpec).name,
      finds,
    });
  }

  // Workflows — a starter that builds its aggregate and emits, half of them
  // growing an `on` reactor into a two-step saga.
  const events: EventSpec[] = [];
  const workflows: WorkflowSpec[] = [];
  for (const agg of shuffled(r, aggs).slice(0, int(r, 0, 2))) {
    const evName = `${agg.name}Placed`;
    if (events.some((e) => e.name === evName)) continue;
    events.push({ name: evName, agg: agg.name });
    workflows.push({ name: `place${agg.name}`, agg: agg.name, event: evName, reactor: r() < 0.5 });
  }

  // A UI — always an overview page (which depends on no aggregate at all), plus
  // a board / create pair for the aggregates it picks up.
  let ui: UiSpec | null = null;
  if (r() < 0.7) {
    const pages: PageSpec[] = [
      {
        name: "Overview",
        route: "/",
        title: "Overview",
        label: "Overview",
        kind: "overview",
        agg: null,
      },
    ];
    for (const agg of shuffled(r, aggs).slice(0, int(r, 1, 2))) {
      if (r() < 0.8)
        pages.push({
          name: `${agg.name}Board`,
          route: `/${lowerFirst(agg.name)}`,
          title: `${agg.name} board`,
          label: `${agg.name}s`,
          kind: "board",
          agg: agg.name,
        });
      if (r() < 0.6)
        pages.push({
          name: `${agg.name}Compose`,
          route: `/${lowerFirst(agg.name)}/new`,
          title: `New ${agg.name}`,
          label: `New ${agg.name}`,
          kind: "new",
          agg: agg.name,
        });
    }
    ui = { name: "U", apiParam: "Api", section: "Main", pages };
  }

  // A mounted UI turns every `X id` field into a <Select> over X, so X must
  // carry a `derived display` (`loom.ui-id-ref-no-display`).  Satisfy the gate
  // where the target has a string field to display; `normalizeSpec` drops the
  // reference where it doesn't.  Without this, cross-aggregate references would
  // be reachable only in UI-less seeds — half the deep arm's shapes.
  if (ui !== null) {
    const targets = new Set(
      aggs.flatMap((a) =>
        a.fields.filter((f) => f.type.endsWith(" id")).map((f) => f.type.slice(0, -3)),
      ),
    );
    for (const a of aggs) {
      if (!targets.has(a.name) || a.derived !== null) continue;
      const s = a.fields.find((f) => f.type === "string" && !f.optional);
      if (s !== undefined) a.derived = { name: "display", from: s.name };
    }
  }

  return normalizeSpec({ seed, enumDecl, vos, aggs, events, workflows, ui });
}

/**
 * Prune every reference a removal could have dangled, and return a spec that
 * still emits valid `.ddd`.
 *
 * The shrinker's whole soundness rests on this: it removes ONE declaration and
 * hands the result here, and what comes back is a model the generator itself
 * could have produced.  Without it, "drop an aggregate" leaves a page bound to
 * a name that no longer resolves — the candidate stops parsing, the predicate
 * says "no longer reproduces", and the shrink stops short of the minimum for a
 * reason that has nothing to do with the bug under study.
 */
export function normalizeSpec(spec: ModelSpec): ModelSpec {
  // A fixpoint, because the prunings feed each other: dropping a field can
  // empty an aggregate, which dangles the `X id` fields pointing at it, which
  // can empty another.  Bounded — each pass only removes, so it converges.
  let current = normalizeOnce(spec);
  for (let i = 0; i < 6; i++) {
    const next = normalizeOnce(current);
    if (emitModel(next) === emitModel(current)) return current;
    current = next;
  }
  return current;
}

function normalizeOnce(spec: ModelSpec): ModelSpec {
  const voNames = new Set(spec.vos.map((v) => v.name));
  const declared = new Set(spec.aggs.map((a) => a.name));

  const pruned = spec.aggs.map((a) => {
    const fields = a.fields.filter((f) => {
      if (f.type === "Status") return spec.enumDecl;
      if (f.type.endsWith(" id")) return declared.has(f.type.slice(0, -3));
      if (voNames.has(f.type)) return true;
      return SCALARS.includes(f.type);
    });
    return { ...a, fields };
  });
  // An aggregate with no fields left has no create input and no wire shape
  // worth emitting; drop it rather than emit an empty one.
  const kept = pruned.filter((a) => a.fields.length > 0);
  const keptNames = new Set(kept.map((a) => a.name));

  const aggs = kept.map((a) => {
    // Re-prune `X id` fields whose target was just dropped for being empty.
    const fields = a.fields.filter(
      (f) => !f.type.endsWith(" id") || keptNames.has(f.type.slice(0, -3)),
    );
    const names = new Set(fields.map((f) => f.name));
    const has = (n: string | null): boolean => n !== null && names.has(n);
    return {
      ...a,
      fields,
      derived: a.derived !== null && has(a.derived.from) ? a.derived : null,
      invariant: a.invariant !== null && has(a.invariant.field) ? a.invariant : null,
      op: a.op !== null && has(a.op.field) ? a.op : null,
      createField: a.crudish
        ? null
        : has(a.createField)
          ? a.createField
          : ((fields[0]?.name ?? null) as string | null),
      finds: a.finds.filter((f) => f.field === null || names.has(f.field)),
    };
  });
  // `loom.ui-id-ref-no-display` — an HONEST validator gate, not an emitter
  // hole: a mounted UI renders an `X id` field as a <Select>, so the referenced
  // aggregate must carry a `derived display` for the option labels.  The
  // generator satisfies it by adding the display where it can (see
  // `genDeepSpec`); where it can't (the target has no string field) the
  // reference itself has to go, or every UI-bearing seed would report a
  // GENERATOR bug and drown the real signal.
  const withDisplay = new Set(aggs.filter((a) => a.derived !== null).map((a) => a.name));
  const displaySafe =
    spec.ui === null
      ? aggs
      : aggs.map((a) => ({
          ...a,
          fields: a.fields.filter(
            (f) => !f.type.endsWith(" id") || withDisplay.has(f.type.slice(0, -3)),
          ),
        }));
  const liveAggs = new Set(displaySafe.filter((a) => a.fields.length > 0).map((a) => a.name));
  const events = spec.events.filter((e) => liveAggs.has(e.agg));
  const evNames = new Set(events.map((e) => e.name));
  const workflows = spec.workflows.filter((w) => liveAggs.has(w.agg) && evNames.has(w.event));
  const usedEvents = new Set(workflows.map((w) => w.event));
  let ui: UiSpec | null = null;
  if (spec.ui !== null) {
    const pages = spec.ui.pages.filter((p) => p.agg === null || liveAggs.has(p.agg));
    ui = pages.length > 0 ? { ...spec.ui, pages } : null;
  }
  return {
    ...spec,
    // A value object no field references is dead weight in a shrunk repro.
    vos: spec.vos.filter((v) => displaySafe.some((a) => a.fields.some((f) => f.type === v.name))),
    aggs: displaySafe.filter((a) => a.fields.length > 0),
    // …and so is an event nothing emits.
    events: events.filter((e) => usedEvents.has(e.name)),
    workflows,
    ui,
  };
}

/** The decision record for `seed` — the shrinker's starting point. Pure. */
export const genSpec = (seed: number): ModelSpec => genDeepSpec(seed);

/**
 * A random VALID `.ddd` model for `seed`.
 *
 * `genModel(seed)` is the slice-1 shape and is byte-stable — 250 fixed seeds of
 * it are the fast suite's fuzz corpus, so it must not move.  `genModel(seed,
 * { deep: true })` selects the wider arm above (value objects, UI pages + menu,
 * workflows, the three find shapes), which the deep leg drives and the shrinker
 * reduces.
 */
export function genModel(seed: number, opts: { deep?: boolean } = {}): string {
  return opts.deep === true ? emitModel(genDeepSpec(seed)) : genShallowModel(seed);
}
