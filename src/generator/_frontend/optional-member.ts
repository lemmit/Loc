import type { AggregateIR, ExprIR, TypeIR } from "../../ir/types/loom-ir.js";
import { tryDetectApiHook } from "../_walker/api-hook-detector.js";
import type { MemberReadSpec } from "../_walker/target.js";
import type { WalkContext } from "../_walker/walker-core.js";

// ---------------------------------------------------------------------------
// Optional-receiver member reads for the type-checked frontends.
//
// `p.budget.amount` where the model declares `budget: Budget?` is a NULL
// DEREFERENCE: the wire ships `budget: null` for a project that has none, so
// the read throws at runtime and — on the two frontends whose templates are
// type-checked — fails the build outright (`ng build`'s TS2531 "Object is
// possibly 'null'", svelte-check's "'…' is possibly 'null' or 'undefined'").
// The JS `?.` short-circuit is the whole fix: `p.budget?.amount` is `undefined`
// rather than a throw, and the interpolation renders empty.
//
// Supplied to `WalkerTarget.renderMemberRead`, which the shared walker consults
// before its verbatim `<recv>.<member>` emit.  Only the JS-embedded targets opt
// in: Feliz spells options in F# and its own seam already owns that spelling,
// and a target that omits the seam keeps byte-identical output.
// ---------------------------------------------------------------------------

/** Spell one member read, null-safe when the RECEIVER is optional.  Returns
 *  `undefined` for a non-optional receiver so the caller falls through to the
 *  walker's verbatim emit and every non-optional read stays byte-identical. */
export function optionalChainedMemberRead(spec: MemberReadSpec): string | undefined {
  return receiverIsOptional(spec) ? `${spec.receiver}?.${spec.member}` : undefined;
}

function receiverIsOptional(spec: MemberReadSpec): boolean {
  if (spec.receiverType?.kind === "optional") return true;
  return apiReadFieldType(spec)?.kind === "optional";
}

/** The declared field type behind a member read off an API-READ record —
 *  `<record>.budget`, the shape every scaffolded detail page uses.
 *
 *  Needed because the IR does NOT type a page body's record chain: a QueryView
 *  data lambda's param and an aggregate-rooted read alike fall through
 *  `memberType`'s default, so `receiverType` on the `.amount` node reads
 *  `string` — indistinguishable from a genuine string field.  The walk context
 *  already carries what the IR lost: `paramTypes` names the aggregate a single
 *  record binding holds, `listRowAggregates` the one a row binding holds, and
 *  the api-hook detector recognises a direct `<Agg>.byId(id)` root.  Resolve
 *  the field off the aggregate registry instead of trusting the placeholder.
 *
 *  Returns undefined whenever anything in that chain doesn't resolve, which
 *  leaves the read exactly as it was. */
function apiReadFieldType(spec: MemberReadSpec): TypeIR | undefined {
  const recv = spec.receiverExpr;
  const ctx = spec.ctx;
  if (!recv || !ctx || recv.kind !== "member") return undefined;
  const agg = recordAggregate(recv.receiver, ctx);
  return agg?.fields.find((f) => f.name === recv.member)?.type;
}

/** The aggregate an expression evaluates to ONE RECORD of, or undefined. */
function recordAggregate(expr: ExprIR, ctx: WalkContext): AggregateIR | undefined {
  const named = (name: string | undefined): AggregateIR | undefined =>
    name === undefined ? undefined : ctx.aggregatesByName.get(name);
  if (expr.kind === "ref") {
    return named(ctx.paramTypes?.get(expr.name)) ?? named(ctx.listRowAggregates?.get(expr.name));
  }
  const detected = tryDetectApiHook(expr, ctx);
  return detected?.kind === "aggregate" ? named(detected.aggregateName) : undefined;
}
