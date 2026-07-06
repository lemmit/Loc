// -------------------------------------------------------------------------
// Shared check helpers — the generic ExprIR walker and the column /
// queryable-subset predicate helpers, used across several check modules.
// -------------------------------------------------------------------------

import { intrinsicFor } from "../../../util/intrinsics.js";
import type { AggregateIR, BoundedContextIR, ExprIR } from "../../types/loom-ir.js";
import { isDeepScopeFilter } from "../../util/tenant-stance.js";
import { walkExprDeep } from "../../util/walk.js";

/** True when `name` is a stored field, containment, or derived property
 *  of the aggregate — the set of members a `sort` / `loads` path may
 *  root at. */
export function aggregateHasMember(agg: AggregateIR, name: string): boolean {
  return (
    agg.fields.some((f) => f.name === name) ||
    agg.contains.some((c) => c.name === name) ||
    agg.derived.some((d) => d.name === name)
  );
}

/** Walk an already-queryable expression and return the first
 * `this.<X>` member access whose `<X>` doesn't correspond to a real
 * aggregate field.  Returns null if every column reference resolves
 * cleanly. */
export function firstUnknownColumnRef(
  e: ExprIR,
  // Structural column source — an aggregate (fields + containments + derived)
  // or a workflow's instance state (`stateFields` only; no containments /
  // derived).  AggregateIR satisfies this directly; a workflow source passes
  // `{ fields: wf.stateFields, contains: [], derived: [] }`
  // (workflow-instance-views.md).
  agg: Pick<AggregateIR, "fields" | "contains" | "derived">,
  ctx: BoundedContextIR,
  opts?: {
    /** Admit `this.id` (the aggregate's own key) as a known column.  Set by
     *  the capability-filter selectability loop only: a filter predicate is
     *  always AGGREGATE-rooted, where `id` is a real stored column on every
     *  backend — the derived tenancy registry self-scope (`this.id ==
     *  currentUser.<claim>`, Phase 1b) is the motivating shape.  Find /
     *  view / retrieval `where`s keep the strict field-list check (a
     *  workflow-instance view source has no `id` column, so admitting it
     *  there would emit SQL against a missing column). */
    allowSelfId?: boolean;
  },
): string | null {
  switch (e.kind) {
    case "literal":
    case "this":
    case "id":
    case "ref":
      return null;
    case "paren":
      return firstUnknownColumnRef(e.inner, agg, ctx, opts);
    case "unary":
      return firstUnknownColumnRef(e.operand, agg, ctx, opts);
    case "binary":
      return (
        firstUnknownColumnRef(e.left, agg, ctx, opts) ??
        firstUnknownColumnRef(e.right, agg, ctx, opts)
      );
    case "member": {
      // `this.X` — direct column.  Verify X is on the aggregate.
      if (e.receiver.kind === "this") {
        if (opts?.allowSelfId && e.member === "id" && e.memberType.kind === "id") return null;
        const fld = agg.fields.find((f) => f.name === e.member);
        if (fld) return null;
        const derived = agg.derived.find((d) => d.name === e.member);
        if (derived) {
          // Derived isn't a stored column — emitting SQL against it
          // would also fail.  Reject with a more specific message.
          return `'this.${e.member}' (derived properties are computed, not stored as columns)`;
        }
        const containment = agg.contains.find((c) => c.name === e.member);
        if (containment) {
          return `'this.${e.member}' (containments aren't queryable directly — see docs/language.md)`;
        }
        return `'this.${e.member}'`;
      }
      // `this.vo.sub` — value-object flattened column.  Verify vo
      // is a VO-typed field AND sub is a field on the VO.
      if (
        e.receiver.kind === "member" &&
        e.receiver.receiver.kind === "this" &&
        e.receiver.memberType.kind === "valueobject"
      ) {
        const voField = agg.fields.find(
          (f) => f.name === (e.receiver as { member: string }).member,
        );
        if (!voField) {
          return `'this.${(e.receiver as { member: string }).member}'`;
        }
        const voName =
          e.receiver.memberType.kind === "valueobject" ? e.receiver.memberType.name : "";
        const vo = ctx.valueObjects.find((v) => v.name === voName);
        if (vo?.fields.some((f) => f.name === e.member)) return null;
        return `'this.${(e.receiver as { member: string }).member}.${e.member}'`;
      }
      return null;
    }
    case "method-call":
      // Membership query (`this.<refColl>.contains(x)`) — verify the
      // collection field itself exists; the argument is a parameter,
      // not a column.
      return firstUnknownColumnRef(e.receiver, agg, ctx);
    default:
      return null;
  }
}

/** Returns a description of the first binary comparison whose two
 * sides are BOTH column references, or null if none exists. */
export function firstColumnVsColumn(e: ExprIR): string | null {
  if (e.kind === "binary") {
    if (
      ["==", "!=", "<", "<=", ">", ">="].includes(e.op) &&
      isColumnRef(e.left) &&
      isColumnRef(e.right)
    ) {
      return `${describeColumnRef(e.left)} vs ${describeColumnRef(e.right)}`;
    }
    return firstColumnVsColumn(e.left) ?? firstColumnVsColumn(e.right);
  }
  if (e.kind === "paren") return firstColumnVsColumn(e.inner);
  if (e.kind === "unary") return firstColumnVsColumn(e.operand);
  return null;
}

function isColumnRef(e: ExprIR): boolean {
  if (e.kind === "paren") return isColumnRef(e.inner);
  if (e.kind === "ref" && e.refKind === "this-prop") return true;
  if (e.kind === "member" && e.receiver.kind === "this") return true;
  if (e.kind === "member" && e.receiver.kind === "member" && e.receiver.receiver.kind === "this")
    return true;
  // A queryable scalar intrinsic over a column is still column-side —
  // `this.name.trim()` renders as SQL over the column, so a comparison
  // against another column must trip the column-vs-column gate too.
  if (
    e.kind === "method-call" &&
    e.receiverType.kind === "primitive" &&
    intrinsicFor(e.receiverType.name, e.member)?.queryable
  ) {
    return isColumnRef(e.receiver);
  }
  return false;
}

function describeColumnRef(e: ExprIR): string {
  if (e.kind === "paren") return describeColumnRef(e.inner);
  if (e.kind === "ref" && e.refKind === "this-prop") return `'this.${e.name}'`;
  if (e.kind === "member" && e.receiver.kind === "this") return `'this.${e.member}'`;
  if (e.kind === "member" && e.receiver.kind === "member" && e.receiver.receiver.kind === "this")
    return `'this.${e.receiver.member}.${e.member}'`;
  if (e.kind === "method-call") return `${describeColumnRef(e.receiver)}.${e.member}()`;
  return "<column>";
}

/** Returns null if the expression is fully queryable; otherwise a
 * short label describing the first non-queryable node encountered.
 * The label is human-readable (`"collection op .where"`,
 * `"lambda"`, `"call to function 'X'"`) so the diagnostic message
 * can be specific. */
// Exported for the queryable-subset parity test
// (`test/ir/queryable-subset-parity.test.ts`), which pins the invariant
// that everything this gate admits, `lowerToDrizzle` can lower.
export function firstNonQueryableNode(e: ExprIR): string | null {
  switch (e.kind) {
    case "literal":
    case "this":
    case "id":
      return null;
    case "ref":
      // Refs the lowering produces that translate cleanly to SQL —
      // `param`/`let`/`lambda` are bare identifiers, `this-prop`
      // becomes `tableName.col`, `enum-value` becomes a literal
      // string.  `current-user` is a closure-captured value; the
      // renderer threads a `currentUser` parameter through the repo
      // method and the ref / its member accesses become plain JS / C#
      // value references.
      //
      // NOTE: `this-vo-prop` is deliberately NOT admitted here.  A
      // value-object sub-property is queryable only in its
      // `this.<vo>.<sub>` MEMBER form (handled by the `member` case
      // below, which Drizzle flattens to a `<vo>_<sub>` column).  A
      // *bare* `this-vo-prop` ref carries only the sub-property name,
      // not its parent VO field, so it cannot form the flattened
      // column — `lowerToDrizzle` returns null for it.  (It is only
      // produced inside a value-object's own body, never in an
      // aggregate find/view/retrieval `where`, so this rejects an
      // unreachable shape rather than a real one — but admitting it
      // would let an internal-error throw replace a clean diagnostic
      // if it ever became reachable.)
      if (
        e.refKind === "param" ||
        e.refKind === "let" ||
        e.refKind === "lambda" ||
        e.refKind === "this-prop" ||
        e.refKind === "enum-value" ||
        e.refKind === "current-user"
      )
        return null;
      return `ref to '${e.name}' (${e.refKind})`;
    case "paren":
      return firstNonQueryableNode(e.inner);
    case "unary":
      if (e.op === "!") return firstNonQueryableNode(e.operand);
      return `unary '${e.op}'`;
    case "binary":
      switch (e.op) {
        case "==":
        case "!=":
        case "<":
        case "<=":
        case ">":
        case ">=":
        case "&&":
        case "||":
          return firstNonQueryableNode(e.left) ?? firstNonQueryableNode(e.right);
        default:
          return `arithmetic '${e.op}'`;
      }
    case "member":
      // Reject any member access whose receiver evaluates to a
      // collection — `.count`, `.first`, `.length`, etc. are
      // projections that need a SQL subquery to express, which
      // the queryable sublanguage doesn't support.
      if (e.receiverType.kind === "array") {
        return `collection projection '.${e.member}' on a list`;
      }
      // Allowed member-access shapes:
      //   - `this.col`               — direct column
      //   - `this.vo.sub`            — value-object's flattened column
      //   - `currentUser.<field>`    — row-level filter; the
      //                                renderer threads a `currentUser`
      //                                parameter so the access becomes
      //                                a plain JS / C# value reference.
      if (e.receiver.kind === "this") return null;
      if (
        e.receiver.kind === "member" &&
        e.receiver.receiver.kind === "this" &&
        e.receiver.memberType.kind === "valueobject"
      )
        return null;
      if (e.receiver.kind === "ref" && e.receiver.refKind === "current-user") return null;
      return "member access not rooted at 'this' or beyond a flattened value object";
    case "method-call":
      // The `deep` read-level sentinel (multi-tenancy Phase 2 P2.4) — a
      // synthetic capability-filter node enrichment installs for a
      // `policy { allow deep on <Agg> }` rule.  It is queryable by
      // construction: every domain-logic backend's query translator renders it
      // to its native materialized-path scope (see `DEEP_SCOPE_SEMANTICS`), so
      // admit it here rather than have the tenant-owned floor rewrite trip the
      // selectability gate.
      if (isDeepScopeFilter(e)) return null;
      // Membership over a reference collection — `this.<refColl>.contains(x)`
      // — is the one collection op we admit: it lowers to an EXISTS-style
      // subquery against the field's join table.  Everything else
      // (`.count`, `.any`, `.where`, …) still needs richer SQL we don't
      // emit, so stays rejected.
      if (
        e.member === "contains" &&
        e.receiverType.kind === "array" &&
        e.receiverType.element.kind === "id" &&
        isColumnRef(e.receiver) &&
        e.args.length === 1
      ) {
        return firstNonQueryableNode(e.args[0]!);
      }
      // Queryable scalar intrinsics (src/util/intrinsics.ts) — an op the
      // catalogue marks `queryable` is admitted when its receiver and every
      // argument are themselves queryable (every backend's predicate
      // renderer carries a matching SQL arm, pinned by the intrinsic
      // completeness test).  A non-queryable intrinsic reports itself by
      // name so `loom.find-where-not-queryable` stays actionable.
      if (e.receiverType.kind === "primitive") {
        const sig = intrinsicFor(e.receiverType.name, e.member);
        if (sig?.queryable) {
          const recv = firstNonQueryableNode(e.receiver);
          if (recv) return recv;
          for (const a of e.args) {
            const bad = firstNonQueryableNode(a);
            if (bad) return bad;
          }
          return null;
        }
        if (sig) return `non-queryable intrinsic '.${e.member}'`;
      }
      return `collection op '.${e.member}'`;
    case "lambda":
      return "lambda";
    case "call":
      return `call to '${e.name}' (${e.callKind})`;
    case "new":
      return `'new ${e.partName}' construction`;
    case "object":
      return "object literal";
    case "ternary":
      return "ternary";
    case "convert":
      // Primitive conversions don't lower to SQL — they're per-
      // host coercions (`String(x)`, `Decimal.to_string`, etc.).
      // Reject in queryable contexts; the user should restructure
      // the query to avoid the conversion (e.g. cast on the DB
      // side via a `derived` projection if needed).
      return `conversion to '${e.target}'`;
    case "match":
      // `match { ... }` is a value-producing expression but contains
      // arbitrary arm conditions / values; it doesn't translate to a
      // single SQL fragment.  Same posture as ternary in v22 — reject
      // from the queryable sublanguage; full match semantics live in
      // the application layer / generator.
      return "match expression";
    case "list":
      // Bracketed list literals are walker-config sugar (e.g. responsive
      // Grid cols) — never queryable.
      return "list literal";
    case "action-ref":
      // A named-action reference is a UI-handler-arg form — never queryable
      // (it only appears in a page/component body, not a find/view `where`).
      return "action reference";
  }
}

/** Visit `e` and every sub-expression.  Thin alias over the shared, exhaustive
 *  {@link walkExprDeep} (`src/ir/util/walk.ts`) — kept as a named re-export so
 *  the many `checks/*` call sites need no churn.  The old hand-rolled copy here
 *  missed `convert.value`, `list.elements`, and block-body lambda statements. */
export const walkExpr = walkExprDeep;
