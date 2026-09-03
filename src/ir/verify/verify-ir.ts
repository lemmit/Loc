import { wireFieldsForAggregate } from "../enrich/wire-projection.js";
import type { LoomModel } from "../types/loom-ir.js";
import { allContexts } from "../types/loom-ir.js";
import { forEachModelExpr } from "../util/model-exprs.js";

// ---------------------------------------------------------------------------
// The IR VERIFIER — the compiler checking its own output (M-T9.40).
//
// WHAT IT IS NOT.  It is not a validator.  Every `loom.*` diagnostic answers
// "is this model wrong?"; every check here answers "is this IR wrong?", which
// a user cannot cause and cannot fix.  A violation is a bug in phases ⑤/⑥,
// and the right response is a stack trace at the point of construction, not a
// diagnostic pointing at innocent source.
//
// WHY IT EXISTS, STATED HONESTLY.  It found NOTHING when it was written: zero
// violations across eight examples and all 59 corpus fixtures.  That is the
// measurement, and it is the reason to describe this as a REGRESSION GUARD
// rather than a bug-finder.  `docs/technical.md` states the payoff of phase ⑤
// as a contract — "every name carries a `refKind`, every member access carries
// `receiverType` and `memberType`, every call carries a `callKind`; backends
// never re-resolve" — and most of that contract is held up by the IR's own
// types.  The parts that are NOT are the optional fields below, which the type
// system cannot require and which reach a backend as `undefined` that renders
// into emitted source as the literal text `undefined`.  Today they are all
// correct.  Nothing was checking that they stay correct, and the cost of
// finding out late is a per-backend compile gate on whichever cell happens to
// cover the shape.
//
// WHAT MAKES IT WORTH ITS LINES is where it runs, not what it knows: over
// `forEachModelExpr`, so it sees all 3,609 expressions of a model rather than
// the subset any one check walks — and cheaply enough to run on every fixture
// in the tree rather than the four examples `test/ir/properties.test.ts` could
// afford.
// ---------------------------------------------------------------------------

/** A violated IR invariant.  Plain strings: there is no code to look up and no
 *  source position to point at, because the audience is whoever is editing the
 *  lowering pass, not the author of a `.ddd`. */
export type IrViolation = string;

/**
 * Check the structural invariants of a lowered (and normally enriched) model.
 * Pure — returns violations, throws nothing, so a caller decides whether a
 * violation is fatal.  Empty means every invariant below held.
 */
export function verifyLoomModel(model: LoomModel): IrViolation[] {
  const out: IrViolation[] = [];
  const at = (source: string, site: string, what: string): void => {
    out.push(`${what} — ${source} (${site})`);
  };

  // (1) The resolution contract, over EVERY expression in the model.
  //
  // Each of these fields is optional in the IR types because only some arms of
  // its `refKind` / `callKind` populate it — so the type system cannot demand
  // it, and a lowering path that forgets it type-checks fine.  The renderers
  // read them unconditionally (`e.enumName` straight into the emitted
  // qualified name, `e.wfScope!` into the scoped helper), which is what turns
  // a missing one into `undefined` in generated source.
  forEachModelExpr(model, ({ expr: e, source, site }) => {
    if (e.kind === "ref") {
      if (e.refKind === "enum-value" && !e.enumName) {
        at(source, site, `enum-value ref '${e.name}' has no enumName`);
      }
      if (e.refKind === "resource" && (!e.resourceName || !e.resourceKind)) {
        at(source, site, `resource ref '${e.name}' has no resourceName/resourceKind`);
      }
      if (e.refKind === "workflow-fn" && !e.wfScope) {
        at(source, site, `workflow-fn ref '${e.name}' has no wfScope`);
      }
      if (e.refKind === "store-field" && !e.storeName) {
        at(source, site, `store-field ref '${e.name}' has no storeName`);
      }
    }
    // `receiverType` / `memberType` / `callKind` are non-optional in the IR
    // types, so these guard the `as never` / `!` escape hatches rather than an
    // ordinary code path — cheap, and the one place a cast that lies shows up.
    if (e.kind === "member" && (!e.receiverType || !e.memberType)) {
      at(source, site, `member access '.${e.member}' is missing its resolved types`);
    }
    if (e.kind === "method-call" && !e.receiverType) {
      at(source, site, `method call '.${e.member}' is missing its receiverType`);
    }
    if (e.kind === "call" && !e.callKind) {
      at(source, site, `call '${e.name}' has no callKind`);
    }
  });

  // (2) Structural invariants of the declaration graph.
  //
  // Deliberately only the ones NO validator owns.  Deployable/port/slug
  // uniqueness, context references and the rest already have `loom.*` codes
  // and belong there — a second copy here would drift, and would report a
  // user's mistake as a compiler bug.
  for (const c of allContexts(model)) {
    for (const a of c.aggregates) {
      // The wire shape is derived on demand (`docs` "derive, don't stamp"), so
      // this is a property of the derivation rather than of a stored field:
      // `id` leads, always, on every backend's DTO.
      const wire = wireFieldsForAggregate(a);
      if (wire[0]?.name !== "id") {
        at(`${c.name}/${a.name}`, "wireShape", `wire shape does not lead with 'id'`);
      }
      // An abstract aggregate has no table and no repository by design; a
      // concrete one always gets one, with the auto `findAll` enrichment
      // adds first.
      if (a.isAbstract) continue;
      const repo = c.repositories.find((r) => r.aggregateName === a.name);
      if (!repo) {
        at(`${c.name}/${a.name}`, "repository", `concrete aggregate has no repository`);
        continue;
      }
      const first = repo.finds[0];
      if (first?.name !== "all" || first.params.length > 0) {
        at(
          `${c.name}/${repo.name}`,
          "repository",
          `first find is '${first?.name ?? "(none)"}', not the auto-derived parameterless 'all'`,
        );
      }
    }
  }

  return out;
}

/** `verifyLoomModel`, but fatal — for a call site that treats a broken IR as
 *  unrecoverable (the CLI's `--verify-ir`, the test harness).  The message
 *  carries every violation, because they usually share one cause and a list is
 *  what makes that visible. */
export function assertLoomModelVerifies(model: LoomModel, context: string): void {
  const violations = verifyLoomModel(model);
  if (violations.length === 0) return;
  throw new Error(
    `IR verification failed for ${context} — ${violations.length} violation(s).\n` +
      `These are COMPILER invariants, not model errors: the lowering or enrichment\n` +
      `pass produced an IR the backends cannot consume.\n\n` +
      violations.map((v) => `  • ${v}`).join("\n"),
  );
}
