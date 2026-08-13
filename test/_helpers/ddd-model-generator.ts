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

export function genModel(seed: number): string {
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
