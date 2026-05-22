import type { ExprIR, PathIR, ProvSite, StmtIR } from "../../ir/loom-ir.js";
import { renderTsExpr } from "./render-expr.js";

const INDENT = "    ";

/** When `emitProvenance` is true, instrumented write-sites (statements
 *  carrying a `prov` snapshot) build a `ProvLineage` and route it to the
 *  co-located backing field + the `__provTraces` history buffer. */
export function renderTsStatements(stmts: StmtIR[], emitProvenance = false): string {
  return stmts.map((s, i) => renderTsStatement(s, emitProvenance, i)).join("\n");
}

function renderTsStatement(s: StmtIR, emitProvenance: boolean, index = 0): string {
  switch (s.kind) {
    case "precondition":
      return `${INDENT}if (!(${renderTsExpr(s.expr)})) throw new DomainError(${JSON.stringify(`Precondition failed: ${s.source}`)});`;
    case "requires":
      // Authorization gate — surfaces as 403 via the route-level
      // ForbiddenError catch in the per-aggregate routes file.
      return `${INDENT}if (!(${renderTsExpr(s.expr)})) throw new ForbiddenError(${JSON.stringify(`Forbidden: ${s.source}`)});`;
    case "let":
      return `${INDENT}const ${s.name} = ${renderTsExpr(s.expr)};`;
    case "assign": {
      const base = `${INDENT}${renderPath(s.target)} = ${renderTsExpr(s.value)};`;
      return withTrace(base, s.prov, s.target, s.value, emitProvenance, index);
    }
    case "add": {
      const base = `${INDENT}${renderPath(s.target)}.push(${renderTsExpr(s.value)});`;
      return withTrace(base, s.prov, s.target, s.value, emitProvenance, index);
    }
    case "remove": {
      const path = renderPath(s.target);
      const value = renderTsExpr(s.value);
      const base = `${INDENT}{ const __idx = ${path}.findIndex((__e) => __e === (${value})); if (__idx >= 0) ${path}.splice(__idx, 1); }`;
      return withTrace(base, s.prov, s.target, s.value, emitProvenance, index);
    }
    case "emit": {
      const fields = s.fields.map((f) => `${f.name}: ${renderTsExpr(f.value)}`).join(", ");
      return `${INDENT}this._events.push({ type: ${JSON.stringify(s.eventName)}, ${fields} });`;
    }
    case "call": {
      const args = s.args.map((a) => renderTsExpr(a)).join(", ");
      return `${INDENT}this.${camelize(s.name)}(${args});`;
    }
    case "expression":
      return `${INDENT}${renderTsExpr(s.expr)};`;
  }
}

/** Wrap a provenanced write with trace capture: snapshot the leaf inputs
 *  *before* the mutation (so self-referential writes like `x := x + n`
 *  record the pre-write value), perform the write, then build the lineage
 *  (rule snapshot + leaf inputs + post-write computed value) and route it
 *  to both sinks — the co-located `_<field>_provenance` backing field
 *  (current lineage, persisted on the row) and the per-instance
 *  `__provTraces` buffer (drained into the history table by the route
 *  handler inside the save transaction). */
function withTrace(
  base: string,
  prov: ProvSite | undefined,
  target: PathIR,
  value: ExprIR,
  emitProvenance: boolean,
  index: number,
): string {
  if (!emitProvenance || !prov) return base;
  const targetLit = JSON.stringify(prov.target);
  const inputs = collectLeaves(value)
    .map((l) => `{ path: ${JSON.stringify(l.path)}, value: ${l.value} }`)
    .join(", ");
  const tmp = `__prov_${index}`;
  const lin = `__lin_${index}`;
  const computed = renderPath(target);
  const field = prov.target.field;
  return [
    `${INDENT}const ${tmp} = [${inputs}];`,
    base,
    `${INDENT}const ${lin}: ProvLineage = { snapshotId: ${JSON.stringify(prov.snapshotId)}, target: ${targetLit}, inputs: ${tmp}, computedValue: ${computed} };`,
    `${INDENT}this._${field}_provenance = ${lin};`,
    `${INDENT}this.__provTraces.push(${lin});`,
  ].join("\n");
}

/** Bounded walk over the RHS expression collecting leaf inputs —
 *  `this`-props, params and let-bindings (and member-access chains
 *  rooted at them).  Compound nodes recurse; lambdas are skipped (their
 *  bodies reference lambda-local params, not stored leaves). */
function collectLeaves(
  e: ExprIR,
  out: { path: string; value: string }[] = [],
): { path: string; value: string }[] {
  switch (e.kind) {
    case "ref":
      if (e.refKind === "this-prop" || e.refKind === "param" || e.refKind === "let") {
        out.push({ path: e.name, value: renderTsExpr(e) });
      }
      break;
    case "member":
      out.push({ path: leafPath(e), value: renderTsExpr(e) });
      break;
    case "method-call":
      collectLeaves(e.receiver, out);
      e.args.forEach((a) => collectLeaves(a, out));
      break;
    case "call":
      e.args.forEach((a) => collectLeaves(a, out));
      break;
    case "paren":
      collectLeaves(e.inner, out);
      break;
    case "unary":
      collectLeaves(e.operand, out);
      break;
    case "binary":
      collectLeaves(e.left, out);
      collectLeaves(e.right, out);
      break;
    case "ternary":
      collectLeaves(e.cond, out);
      collectLeaves(e.then, out);
      collectLeaves(e.otherwise, out);
      break;
    case "match":
      e.arms.forEach((a) => {
        collectLeaves(a.cond, out);
        collectLeaves(a.value, out);
      });
      if (e.otherwise) collectLeaves(e.otherwise, out);
      break;
    case "new":
    case "object":
      e.fields.forEach((f) => collectLeaves(f.value, out));
      break;
  }
  return out;
}

/** Dotted source-side path for a member-access chain (e.g. `line.price`). */
function leafPath(e: ExprIR): string {
  if (e.kind === "ref") return e.name;
  if (e.kind === "this") return "this";
  if (e.kind === "member") return `${leafPath(e.receiver)}.${e.member}`;
  return "<expr>";
}

function renderPath(p: PathIR): string {
  if (p.segments.length === 0) return "this";
  const [head, ...tail] = p.segments;
  return `this._${head}${tail.map((t) => `.${t}`).join("")}`;
}

function camelize(name: string): string {
  return name[0]!.toLowerCase() + name.slice(1);
}
