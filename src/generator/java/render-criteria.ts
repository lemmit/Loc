import type { AggregateIR, ExprIR, FieldIR, TypeIR } from "../../ir/types/loom-ir.js";
import {
  DATA_KEY_PATH_DELIMITER,
  isDeepScopeFilter,
  ORG_PATH_CLAIM_FIELD,
  TENANT_OWNED_DATA_KEY_FIELD,
  TENANT_OWNED_TENANT_ID_FIELD,
} from "../../ir/util/tenant-stance.js";
import { boxedJavaType, collectJavaExprImports, renderJavaExpr } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Criterion body → JPA Criteria predicate renderer, the engine behind the
// Spring Data `Specification<T>` factories (java-backend.md's headline
// differentiator: java is the first backend to consume the reified
// criterion directly).  Covers the validator's queryable subset; PATH
// positions (`this.<field>[...]`) render as typed `root.get(...)` chains
// (the final segment carries a type witness so CriteriaBuilder's
// Comparable bounds typecheck), VALUE positions (params, literals, enum
// values) render through the normal Java expression leaf table.
// ---------------------------------------------------------------------------

export interface CriteriaCtx {
  /** The candidate aggregate — resolves declared field types for the
   *  typed `root.get` witnesses. */
  agg: AggregateIR;
  /** VO name → fields, for sub-path typing. */
  voLookup: ReadonlyMap<string, readonly FieldIR[]>;
  /** Imports collected for the emitted file. */
  imports: Set<string>;
}

export function renderCriteriaPredicate(e: ExprIR, ctx: CriteriaCtx): string {
  return bool(e, ctx);
}

/** Render `e` as a `jakarta.persistence.criteria.Predicate` expression. */
function bool(e: ExprIR, ctx: CriteriaCtx): string {
  switch (e.kind) {
    case "paren":
      return bool(e.inner, ctx);
    case "unary":
      if (e.op === "!") return `cb.not(${bool(e.operand, ctx)})`;
      throw unsupported(`unary '${e.op}'`);
    case "binary":
      return binary(e, ctx);
    case "ref":
      // Bare boolean field (`this.active`) or param.
      if (e.refKind === "this-prop" || e.refKind === "this-vo-prop") {
        return `cb.isTrue(${path([e.name], ctx)})`;
      }
      if (e.refKind === "param") return `cb.isTrue(cb.literal(${e.name}))`;
      throw unsupported(`ref '${e.refKind}'`);
    case "member":
    case "this": {
      // Bare boolean field accessed as a `this`-path (`this.archived` inside a
      // criterion body lowers to a `member`; explicit `this` to a `this` expr).
      const segs = pathSegments(e);
      if (segs && segs.length > 0) return `cb.isTrue(${path(segs, ctx)})`;
      throw unsupported(`expression kind '${e.kind}'`);
    }
    case "literal":
      if (e.lit === "bool") return e.value === "true" ? "cb.conjunction()" : "cb.disjunction()";
      throw unsupported(`literal '${e.lit}'`);
    case "method-call":
      // `deep` read level (multi-tenancy Phase 2 P2.4) — descendant-or-self
      // materialized-path scope with the NULL-dataKey fallback to the tenant
      // floor (see `DEEP_SCOPE_SEMANTICS`), as a JPA Criteria predicate over the
      // `tenantScope(User currentUser)` Specification's null-safe principal.
      if (isDeepScopeFilter(e)) return deepScopeCriteria(e, ctx);
      // Reference-collection membership.
      if (e.member === "contains" && e.receiverType.kind === "array" && e.args.length === 1) {
        const segs = pathSegments(e.receiver);
        if (!segs) throw unsupported("contains over a non-path receiver");
        const elem = boxedJavaType(e.receiverType.element);
        ctx.imports.add("java.util.List");
        return `cb.isMember(${value(e.args[0]!, ctx)}, root.<List<${elem}>>get(${segs.map((s) => JSON.stringify(s)).join(").get(")}))`;
      }
      throw unsupported(`method call '${e.member}'`);
    default:
      throw unsupported(`expression kind '${e.kind}'`);
  }
}

function binary(e: Extract<ExprIR, { kind: "binary" }>, ctx: CriteriaCtx): string {
  if (e.op === "&&") return `cb.and(${bool(e.left, ctx)}, ${bool(e.right, ctx)})`;
  if (e.op === "||") return `cb.or(${bool(e.left, ctx)}, ${bool(e.right, ctx)})`;
  const isNull = (x: ExprIR): boolean => x.kind === "literal" && x.lit === "null";
  if ((e.op === "==" || e.op === "!=") && (isNull(e.left) || isNull(e.right))) {
    const operand = isNull(e.left) ? e.right : e.left;
    const segs = pathSegments(operand);
    if (!segs) throw unsupported("null check over a non-path operand");
    return e.op === "==" ? `cb.isNull(${path(segs, ctx)})` : `cb.isNotNull(${path(segs, ctx)})`;
  }
  // Comparison: one side is the candidate path, the other the value.
  const leftSegs = pathSegments(e.left);
  const rightSegs = pathSegments(e.right);
  const segs = leftSegs ?? rightSegs;
  if (!segs) throw unsupported("comparison without a candidate path side");
  const valueExpr = leftSegs ? e.right : e.left;
  const flip = !leftSegs;
  const p = path(segs, ctx);
  const v = value(valueExpr, ctx);
  const op = flip ? (FLIPPED[e.op] ?? e.op) : e.op;
  switch (op) {
    case "==":
      return `cb.equal(${p}, ${v})`;
    case "!=":
      return `cb.notEqual(${p}, ${v})`;
    case "<":
      return `cb.lessThan(${p}, ${v})`;
    case "<=":
      return `cb.lessThanOrEqualTo(${p}, ${v})`;
    case ">":
      return `cb.greaterThan(${p}, ${v})`;
    case ">=":
      return `cb.greaterThanOrEqualTo(${p}, ${v})`;
    default:
      throw unsupported(`binary '${e.op}'`);
  }
}

const FLIPPED: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };

/** Candidate-rooted path segments of `this.a.b`, or null. */
function pathSegments(e: ExprIR): string[] | null {
  if (e.kind === "paren") return pathSegments(e.inner);
  // Bare `this` (the receiver of an explicit `this.field` access, as a capability
  // filter spells it — criterion bodies use the implicit bare-field form).
  if (e.kind === "this") return [];
  if (e.kind === "ref" && (e.refKind === "this-prop" || e.refKind === "this-vo-prop")) {
    return [e.name];
  }
  if (e.kind === "member") {
    const head = pathSegments(e.receiver);
    return head ? [...head, e.member] : null;
  }
  if (e.kind === "id") return ["id"];
  return null;
}

/** Typed `root.get(...)` chain — the final segment carries a type
 *  witness resolved from the aggregate / VO declarations so Criteria's
 *  Comparable bounds typecheck. */
function path(segs: string[], ctx: CriteriaCtx): string {
  const witness = declaredType(segs, ctx);
  const quoted = segs.map((s) => JSON.stringify(s));
  if (segs.length === 1) {
    return `root.<${witness}>get(${quoted[0]})`;
  }
  const head = quoted.slice(0, -1);
  return `root.get(${head.join(").get(")}).<${witness}>get(${quoted[quoted.length - 1]})`;
}

function declaredType(segs: string[], ctx: CriteriaCtx): string {
  let fields: readonly FieldIR[] = ctx.agg.fields;
  let t: TypeIR | undefined;
  for (const [i, seg] of segs.entries()) {
    if (i === 0 && seg === "id") {
      t = { kind: "id", targetName: ctx.agg.name, valueType: ctx.agg.idValueType };
      break;
    }
    const f = fields.find((x) => x.name === seg);
    if (!f) return "Comparable";
    t = f.type.kind === "optional" ? f.type.inner : f.type;
    if (t.kind === "valueobject") fields = ctx.voLookup.get(t.name) ?? [];
  }
  if (!t) return "Comparable";
  const rendered = boxedJavaType(t);
  // Imports for the witness type.
  if (rendered === "BigDecimal") ctx.imports.add("java.math.BigDecimal");
  if (rendered === "Instant") ctx.imports.add("java.time.Instant");
  if (rendered === "UUID") ctx.imports.add("java.util.UUID");
  return rendered;
}

/** VALUE position — params / literals / enum values via the normal
 *  Java leaf table.  A principal (tenancy) `currentUser.<field>` access
 *  renders null-safe against the `currentUser` the factory is handed (no
 *  actor → null → the comparison matches no rows: fail-closed). */
function value(e: ExprIR, ctx: CriteriaCtx): string {
  if (e.kind === "member" && e.receiver.kind === "ref" && e.receiver.refKind === "current-user") {
    return `(currentUser == null ? null : currentUser.${e.member}())`;
  }
  collectJavaExprImports(e, ctx.imports);
  return renderJavaExpr(e, { thisName: "root" });
}

/** The `deep` read-level sentinel as a JPA Criteria predicate.  `dataKey` /
 *  `tenantId` are typed candidate paths; the principal claims render null-safe
 *  against the `currentUser` the `tenantScope` factory is handed (no actor →
 *  null → matches no rows, fail-closed).  The descendant LIKE pattern is built
 *  in plain Java (`orgPath() + ".%"`) so `cb.like(path, String)` binds it. */
function deepScopeCriteria(e: Extract<ExprIR, { kind: "method-call" }>, ctx: CriteriaCtx): string {
  const dataKeyPath = path([TENANT_OWNED_DATA_KEY_FIELD], ctx);
  const tenantIdPath = path([TENANT_OWNED_TENANT_ID_FIELD], ctx);
  const orgVal = value(e.args[0]!, ctx);
  const tenantVal = value(e.args[1]!, ctx);
  const orgMember =
    e.args[0]!.kind === "member" ? (e.args[0] as { member: string }).member : ORG_PATH_CLAIM_FIELD;
  const orgPattern = `(currentUser == null ? null : currentUser.${orgMember}() + "${DATA_KEY_PATH_DELIMITER}%")`;
  return (
    `cb.or(` +
    `cb.and(cb.isNotNull(${dataKeyPath}), ` +
    `cb.or(cb.equal(${dataKeyPath}, ${orgVal}), cb.like(${dataKeyPath}, ${orgPattern}))), ` +
    `cb.and(cb.isNull(${dataKeyPath}), cb.equal(${tenantIdPath}, ${tenantVal})))`
  );
}

function unsupported(what: string): Error {
  return new Error(
    `Criteria renderer: ${what} is outside the queryable subset — the IR validator should have rejected this criterion.`,
  );
}
