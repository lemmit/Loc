// A structure-aware shrinker for the generated `.ddd` models (M-T9.22, slice 2).
//
// A random model that trips the pipeline is a bad bug report: 150 lines, three
// aggregates, a UI, a saga, and no way to tell which of them the emitter choked
// on.  The seed reproduces it, but a fixture nobody can read does not graduate
// into the corpus — which is the mission's actual deliverable ("every failure
// ships with its seed for a deterministic repro fixture that graduates into the
// corpus").  Shrinking is what turns the seed into that fixture.
//
// ── Why STRUCTURE-AWARE, and not line-deletion ──────────────────────────────
// The obvious shrinker deletes lines from the source and re-tests.  It does not
// work here, and the failure is silent rather than loud: almost every line
// deletion produces a model that no longer PARSES, the failure "stops
// reproducing" for a reason unrelated to the bug, and the shrink halts on the
// first candidate — reporting the original model as already minimal.  A shrink
// that always reports "minimal" is indistinguishable from one that works.
//
// So the shrinker operates on the generator's DECISION RECORD (`ModelSpec`) and
// re-emits: every candidate it tries is a model the generator itself could have
// produced.  `normalizeSpec` closes the record back up after each removal (a
// dropped aggregate takes its pages, workflows and inbound `X id` fields with
// it), so candidates stay valid by construction rather than by luck.
//
// ── The predicate ───────────────────────────────────────────────────────────
// `reproduces(source)` is supplied by the caller and must mean "fails the SAME
// way" — not merely "fails".  A predicate that accepts any failure will happily
// shrink a codegen crash into an unrelated validation error and report the
// wrong two-line repro.  `pipeline-fuzz-deep.test.ts` builds it from the
// verdict's tier + a normalised message key for exactly that reason.
//
// ── Determinism and bounds ──────────────────────────────────────────────────
// Candidates are enumerated in a fixed order (coarse removals first, so the
// big wins land in the fewest predicate calls), the first reproducing candidate
// is adopted, and the walk restarts.  No randomness: the same failing spec
// always shrinks to the same minimum.  Both the number of adopted steps and the
// number of predicate evaluations are capped, so a pathological model cannot
// turn one seed into the whole run's budget.

import {
  type AggSpec,
  emitModel,
  type ModelSpec,
  normalizeSpec,
  type PageSpec,
} from "./ddd-model-generator.js";

/** True when `source` still fails the way the original did. */
export type Reproduces = (source: string) => Promise<boolean>;

export interface ShrinkOptions {
  /** Adopted reductions before the walk stops. */
  maxSteps?: number;
  /** Predicate evaluations before the walk stops — the real cost bound, since
   *  each one is a full parse + codegen. */
  maxTries?: number;
}

export interface ShrinkResult {
  spec: ModelSpec;
  source: string;
  /** Reductions adopted. */
  steps: number;
  /** Candidates tested (each one a predicate evaluation). */
  tried: number;
  /** True when the walk stopped because it ran out of budget rather than out of
   *  candidates — the result is then a smaller model, not a minimal one. */
  exhausted: boolean;
}

const clone = (spec: ModelSpec): ModelSpec => structuredClone(spec);

const withAggs = (spec: ModelSpec, aggs: AggSpec[]): ModelSpec => ({ ...clone(spec), aggs });

/** Replace aggregate `i` with `f(agg)`. */
function mapAgg(spec: ModelSpec, i: number, f: (a: AggSpec) => AggSpec): ModelSpec {
  const aggs = clone(spec).aggs;
  aggs[i] = f(aggs[i] as AggSpec);
  return withAggs(spec, aggs);
}

/**
 * Every one-step reduction of `spec`, coarsest first.
 *
 * Order is the whole performance story: a model with a UI, two workflows and
 * three aggregates shrinks in a handful of predicate calls when "drop the UI"
 * is tried before "un-optional a field", and in dozens when it isn't.  Within
 * each family the order is positional, so the walk is deterministic.
 */
export function candidates(spec: ModelSpec): ModelSpec[] {
  const out: ModelSpec[] = [];
  const push = (s: ModelSpec): void => {
    out.push(normalizeSpec(s));
  };

  // ── Coarse: whole subsystems ──────────────────────────────────────────────
  if (spec.ui !== null) push({ ...clone(spec), ui: null });
  for (let i = spec.workflows.length - 1; i >= 0; i--) {
    const s = clone(spec);
    s.workflows.splice(i, 1);
    push(s);
  }
  for (let i = spec.aggs.length - 1; i >= 0; i--) {
    if (spec.aggs.length === 1) break; // never shrink to zero aggregates
    const s = clone(spec);
    s.aggs.splice(i, 1);
    push(s);
  }
  for (let i = spec.vos.length - 1; i >= 0; i--) {
    const s = clone(spec);
    s.vos.splice(i, 1);
    push(s);
  }
  // Dropping the enum takes every `Status` field with it (`normalizeSpec`), so
  // it belongs with the coarse removals rather than the per-field ones.
  if (spec.enumDecl) push({ ...clone(spec), enumDecl: false });

  // ── Medium: individual declarations ───────────────────────────────────────
  if (spec.ui !== null) {
    const ui = spec.ui;
    for (let p = ui.pages.length - 1; p >= 0; p--) {
      const s = clone(spec);
      const pages = (s.ui as NonNullable<ModelSpec["ui"]>).pages as PageSpec[];
      pages.splice(p, 1);
      push(s);
    }
  }
  for (let i = 0; i < spec.aggs.length; i++) {
    const a = spec.aggs[i] as AggSpec;
    for (let f = a.finds.length - 1; f >= 0; f--) {
      push(mapAgg(spec, i, (x) => ({ ...x, finds: x.finds.filter((_, k) => k !== f) })));
    }
    if (a.op !== null) push(mapAgg(spec, i, (x) => ({ ...x, op: null })));
    if (a.part !== null) push(mapAgg(spec, i, (x) => ({ ...x, part: null })));
    if (a.invariant !== null) push(mapAgg(spec, i, (x) => ({ ...x, invariant: null })));
    if (a.derived !== null) push(mapAgg(spec, i, (x) => ({ ...x, derived: null })));
    if (!a.crudish) push(mapAgg(spec, i, (x) => ({ ...x, crudish: true, createField: null })));
  }
  for (let v = 0; v < spec.vos.length; v++) {
    const vo = spec.vos[v] as ModelSpec["vos"][number];
    if (vo.invariants.length > 0) {
      const s = clone(spec);
      (s.vos[v] as ModelSpec["vos"][number]).invariants = [];
      push(s);
    }
    for (let f = vo.fields.length - 1; f >= 0 && vo.fields.length > 1; f--) {
      const s = clone(spec);
      const target = s.vos[v] as ModelSpec["vos"][number];
      const dropped = target.fields[f] as { name: string };
      target.fields = target.fields.filter((_, k) => k !== f);
      target.invariants = target.invariants.filter((inv) => !inv.startsWith(dropped.name));
      push(s);
    }
  }

  // ── Fine: fields, one at a time, then optionality ─────────────────────────
  for (let i = 0; i < spec.aggs.length; i++) {
    const a = spec.aggs[i] as AggSpec;
    for (let f = a.fields.length - 1; f >= 0 && a.fields.length > 1; f--) {
      push(mapAgg(spec, i, (x) => ({ ...x, fields: x.fields.filter((_, k) => k !== f) })));
    }
    for (let f = 0; f < a.fields.length; f++) {
      if (!(a.fields[f] as { optional: boolean }).optional) continue;
      push(
        mapAgg(spec, i, (x) => ({
          ...x,
          fields: x.fields.map((g, k) => (k === f ? { ...g, optional: false } : g)),
        })),
      );
    }
  }
  if (spec.workflows.some((w) => w.reactor)) {
    const s = clone(spec);
    s.workflows = s.workflows.map((w) => ({ ...w, reactor: false }));
    push(s);
  }
  return out;
}

/**
 * Reduce `spec` to the smallest model that still satisfies `reproduces`.
 *
 * Greedy, deterministic, and bounded: enumerate candidates in `candidates`'
 * order, adopt the first that still reproduces, restart; stop when a full pass
 * adopts nothing or the budget runs out.
 */
export async function shrinkModel(
  spec: ModelSpec,
  reproduces: Reproduces,
  { maxSteps = 60, maxTries = 400 }: ShrinkOptions = {},
): Promise<ShrinkResult> {
  let current = normalizeSpec(spec);
  let source = emitModel(current);
  let steps = 0;
  let tried = 0;
  let exhausted = false;

  for (let pass = 0; pass < maxSteps; pass++) {
    let adopted = false;
    for (const cand of candidates(current)) {
      if (tried >= maxTries || steps >= maxSteps) {
        exhausted = true;
        break;
      }
      const candSource = emitModel(cand);
      // `normalizeSpec` can map a removal onto the model it started from (drop
      // an already-dead event, say).  Re-testing it would burn budget and, if
      // it reproduced, spin the outer loop forever.
      if (candSource === source) continue;
      tried++;
      if (!(await reproduces(candSource))) continue;
      current = cand;
      source = candSource;
      steps++;
      adopted = true;
      break;
    }
    if (!adopted) break;
  }
  return { spec: current, source, steps, tried, exhausted };
}

/** A one-line size measure, so a shrink can report what it actually removed. */
export function specSize(spec: ModelSpec): string {
  const decls =
    spec.vos.length +
    spec.aggs.length +
    spec.events.length +
    spec.workflows.length +
    (spec.ui === null ? 0 : 1);
  const fields = spec.aggs.reduce((n, a) => n + a.fields.length, 0);
  const pages = spec.ui === null ? 0 : spec.ui.pages.length;
  return `${decls} decls (${spec.aggs.length} agg / ${spec.vos.length} vo / ${spec.workflows.length} wf / ${pages} pages), ${fields} fields, ${emitModel(spec).split("\n").length} lines`;
}
