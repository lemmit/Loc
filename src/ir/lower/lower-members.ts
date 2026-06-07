// -------------------------------------------------------------------------
// Shared entity-member + action lowering — the building blocks every
// entity-like declaration (aggregate / value-object / part) and the workflow
// lowerer reuse: fields, derived, invariants, functions, containments,
// operations / create / destroy / apply action bodies.  Pure leaf consumed
// by ./lower.ts (structural walk) and the workflow lowerer.
// -------------------------------------------------------------------------

import type {
  Aggregate,
  Apply,
  Containment,
  Create,
  DerivedProp,
  Destroy,
  EntityPart,
  FunctionDecl,
  Invariant,
  Operation,
  Parameter,
  Property,
  Statement,
} from "../../language/generated/ast.js";
import {
  isContainment,
  isDerivedProp,
  isFunctionDecl,
  isInvariant,
  isProperty,
} from "../../language/generated/ast.js";
import type {
  ApplyIR,
  ContainmentIR,
  DerivedIR,
  EntityPartIR,
  FieldIR,
  FunctionIR,
  IdValueType,
  InvariantIR,
  OperationIR,
  OperationKind,
  ParamIR,
  StmtIR,
  TypeIR,
  WorkflowStmtIR,
} from "../types/loom-ir.js";
import { lowerExpr, lowerExprInContext } from "./lower-expr.js";
import { lowerStatement } from "./lower-stmt.js";
import { cstText, type Env, inPart, lowerType, withLocal } from "./lower-types.js";

// Applier lowering — `apply(e: Event) { … }` folds one event type into
// aggregate state.  The event param binds as a `refKind: "param"` local
// over the aggregate env (so `this.x := e.y` resolves `this` against the
// aggregate and `e` against the bound param).  The param's type carries
// the event name as an entity-shaped marker; member access on it
// (`e.field`) type-resolves through `findEventByName` / `memberOnEvent`
// in lower-expr (events aren't a distinct TypeIR kind, so the entity
// marker + a field-only fallback is the contained representation).  The
// body's purity (assignments / derivations only; no `emit`, no
// side-effecting calls) is enforced by the phase-⑦ discipline validator,
// not here — lowering preserves source fidelity.
export function lowerApply(a: Apply, env: Env): ApplyIR {
  const eventName = a.event.ref?.name ?? a.event.$refText;
  const inner = withLocal(env, a.param, "param", { kind: "entity", name: eventName });
  const statements: StmtIR[] = [];
  let bodyEnv = inner;
  for (const s of a.body) {
    const result = lowerStatement(s, bodyEnv);
    statements.push(result.stmt);
    bodyEnv = result.envAfter;
  }
  return { event: eventName, param: a.param, statements };
}

export function lowerEntityPart(part: EntityPart, agg: Aggregate, outer: Env): EntityPartIR {
  const inner = inPart(outer, agg, part);
  const props = part.members.filter(isProperty) as Property[];
  return {
    name: part.name,
    parentName: agg.name,
    parentIdValueType: (agg.idKind ?? "guid") as IdValueType,
    fields: props.map((p) => lowerField(p, inner)),
    contains: part.members.filter(isContainment).map(lowerContainment),
    derived: part.members.filter(isDerivedProp).map((d) => lowerDerived(d, inner)),
    invariants: [
      ...part.members.filter(isInvariant).map((i) => lowerInvariant(i, inner)),
      ...lowerPropertyChecks(props, inner),
    ],
    functions: part.members.filter(isFunctionDecl).map((f) => lowerFunction(f, inner)),
  };
}

// ---------------------------------------------------------------------------
// Member lowerings
// ---------------------------------------------------------------------------

export function lowerField(p: Property, env?: Env): FieldIR {
  const sensitivity = fieldSensitivity(p);
  const baseType = lowerType(p.type);
  const declared = p.access as FieldIR["access"];
  // Default value — lowered in the declaring scope so enum values / money
  // literals resolve in the field's type context.  Only the constructible
  // declarations (aggregate / entity-part / value object) pass an `env`;
  // events / views never do, so a stray default there is dropped here (and
  // flagged by the validator).
  const defaultExpr = p.default && env ? lowerExprInContext(p.default, baseType, env) : undefined;
  return {
    name: p.name,
    // The field's `TypeIR` carries the same tag set as the field's
    // `sensitivity` — keeps a single source of truth so downstream
    // consumers (wire shape, future expression-typing in lower-expr,
    // generators) can read sensitivity off the type uniformly.
    type: sensitivity ? { ...baseType, sensitivity } : baseType,
    optional: !!p.type?.optional,
    provenanced: !!p.provenanced,
    ...(sensitivity ? { sensitivity } : {}),
    // `access` lives on the field, not the type — it's a field role
    // (input-shaping, view exposure) rather than a type property.
    // Enrichment fills in the default / inferred-from-type cases.
    ...(declared ? { access: declared, accessSource: "declared" as const } : {}),
    ...(defaultExpr ? { default: defaultExpr } : {}),
  };
}

/** Pull sensitivity tags from a Property AST node — sorted, deduped,
 * undefined when the property declared no `sensitive(...)` clause.
 * Mirror of `propertySensitivity` in `type-system.ts`, but produces an
 * `IR` `SensitivityTags` (plain `readonly string[]`). */
function fieldSensitivity(p: Property): readonly string[] | undefined {
  const tags = p.sensitivity?.tags;
  if (!tags || tags.length === 0) return undefined;
  return Object.freeze([...new Set(tags)].sort());
}

export function lowerContainment(c: Containment): ContainmentIR {
  const ir: ContainmentIR = {
    name: c.name,
    partName: c.partType?.ref?.name ?? "Unknown",
    collection: !!c.collection,
  };
  if (c.optional) ir.optional = true;
  return ir;
}

export function lowerDerived(d: DerivedProp, env: Env): DerivedIR {
  // Contextual lowering: a numeric literal RHS of a money-typed
  // derivation lowers as a money IR literal (so backends see
  // `new Decimal("373.34")`, not the raw decimal literal).  See
  // `lowerExprInContext`.
  const declared = lowerType(d.type);
  return {
    name: d.name,
    type: declared,
    expr: lowerExprInContext(d.expr, declared, env),
  };
}

export function lowerInvariant(i: Invariant, env: Env): InvariantIR {
  return {
    expr: lowerExpr(i.expr, env),
    guard: i.guard ? lowerExpr(i.guard, env) : undefined,
    source: cstText(i.expr),
    // `private invariant ...` opts out of the wire
    // layers (frontend Zod, Hono routes, FluentValidation).  The
    // domain-layer `AssertInvariants()` floor still enforces it.
    scope: i.serverOnly ? "server-only" : undefined,
  };
}

/** Synthesise an InvariantIR from an inline `field: T check <expr>`
 *  clause on a Property.  Inline-check sugar — the synthesised
 *  invariant appears in the parent's `invariants` list so the existing
 *  wire-validator + domain-floor pipelines pick it up uniformly. */
export function lowerPropertyChecks(props: Property[], env: Env): InvariantIR[] {
  const out: InvariantIR[] = [];
  for (const p of props) {
    if (!p.check) continue;
    out.push({
      expr: lowerExpr(p.check, env),
      // Normalise whitespace so multi-line `check` clauses don't
      // carry indentation into error messages.
      source: `${p.name} check ${cstText(p.check).replace(/\s+/g, " ").trim()}`,
    });
  }
  return out;
}

export function lowerFunction(f: FunctionDecl, env: Env): FunctionIR {
  let inner = env;
  const params: ParamIR[] = [];
  for (const p of f.params) {
    const t = lowerType(p.type, env);
    params.push({ name: p.name, type: t });
    inner = withLocal(inner, p.name, "param", t);
  }
  return {
    name: f.name,
    params,
    returnType: lowerType(f.returnType),
    body: lowerExpr(f.body, inner),
  };
}

export function lowerOperation(op: Operation, env: Env): OperationIR {
  return lowerActionBody(
    {
      kind: "mutate",
      name: op.name,
      canonical: false,
      params: op.params,
      body: op.body,
      visibility: op.private ? "private" : "public",
      extern: !!op.extern,
      audited: !!op.audited,
      returnType: op.returnType ? lowerType(op.returnType, env) : undefined,
    },
    env,
  );
}

// `create` / `destroy` share `operation`'s param + body shape; the
// kind tag (not the body syntax) carries the lifecycle asymmetry.  An
// unnamed declaration is the aggregate's canonical creator / terminator
// — its synthesised IR `name` is the keyword itself, and `canonical` is
// set so the Phase-2 route enrichment can route it to the bare
// collection URL.  create / destroy are never `private` / `extern` /
// `audited` (no grammar slot), so those default off.
export function lowerCreate(c: Create, env: Env): OperationIR {
  return lowerActionBody(
    {
      kind: "create",
      name: c.name ?? "create",
      canonical: c.name == null,
      params: c.params,
      body: c.body,
      visibility: "public",
      extern: false,
      audited: false,
    },
    env,
  );
}

export function lowerDestroy(d: Destroy, env: Env): OperationIR {
  return lowerActionBody(
    {
      kind: "destroy",
      name: d.name ?? "destroy",
      canonical: d.name == null,
      params: d.params,
      body: d.body,
      visibility: "public",
      extern: false,
      audited: false,
    },
    env,
  );
}

interface ActionSpec {
  kind: OperationKind;
  name: string;
  canonical: boolean;
  params: Parameter[];
  body: Statement[];
  visibility: "public" | "private";
  extern: boolean;
  audited: boolean;
  /** Declared `or`-union return type (exception-less.md, spike). */
  returnType?: TypeIR;
}

function lowerActionBody(spec: ActionSpec, env: Env): OperationIR {
  let inner = env;
  const params: ParamIR[] = [];
  for (const p of spec.params) {
    const t = lowerType(p.type, env);
    params.push({ name: p.name, type: t });
    inner = withLocal(inner, p.name, "param", t);
  }
  // A union-returning operation threads its variants into the env so each
  // `return <expr>` can tag its value with the matching variant (producer).
  if (spec.returnType?.kind === "union") {
    inner = { ...inner, returnVariants: spec.returnType.variants };
  }
  const stmts: StmtIR[] = [];
  for (const s of spec.body) {
    const result = lowerStatement(s, inner);
    stmts.push(result.stmt);
    inner = result.envAfter;
  }
  return {
    name: spec.name,
    kind: spec.kind,
    canonical: spec.canonical,
    visibility: spec.visibility,
    params,
    statements: stmts,
    extern: spec.extern,
    audited: spec.audited,
    returnType: spec.returnType,
  };
}

// ---------------------------------------------------------------------------
// Workflow lowering
//
// Body statements are parsed using the operation-body Statement rules
// (precondition, let, emit, AssignOrCallStmt) but the workflow surface
// is a strict subset:
//   - LetStmt RHS may be `Agg.create({...})` (factory-let),
//     `Repo.method(args)` (repo-let), or any other Expression
//     (expr-let).
//   - AssignOrCallStmt is allowed only in its bare-call form
//     `name.op(args)` — mutation forms (`:=`, `+=`, `-=`) belong to
//     aggregate operations and surface as validator errors.
//   - precondition / emit lower identically to operation bodies.
//
// `savesAtExit` is computed after the walk: every factory-let always
// saves; a repo-let saves only when a later `op-call` targets it.
// ---------------------------------------------------------------------------

type SaveEntry = { name: string; aggName: string; repoName: string };

/** Compute the bindings to save for a statement list (the dirtiness
 *  rule): every `factory-let` always, every `repo-let` only when a later
 *  op-call targets it.  When `loopVar` is supplied (a `for-each` body),
 *  the loop variable itself is saved if it is the target of any op-call
 *  in that body — the per-iteration save.  Top-level callers pass no
 *  loopVar; the result is the flat `savesAtExit` (byte-identical to the
 *  previous inline computation). */
export function computeSaves(
  statements: WorkflowStmtIR[],
  repoForAgg: Map<string, string>,
  loopVar?: { name: string; aggName: string; repoName: string },
): SaveEntry[] {
  const opCallTargets = new Set<string>();
  for (const st of statements) {
    if (st.kind === "op-call") opCallTargets.add(st.target);
  }
  const saves: SaveEntry[] = [];
  if (loopVar && opCallTargets.has(loopVar.name)) {
    saves.push({ name: loopVar.name, aggName: loopVar.aggName, repoName: loopVar.repoName });
  }
  for (const st of statements) {
    if (st.kind === "factory-let") {
      const repoName = repoForAgg.get(st.aggName) ?? plural(st.aggName);
      saves.push({ name: st.name, aggName: st.aggName, repoName });
    } else if (st.kind === "repo-let" && opCallTargets.has(st.name)) {
      saves.push({ name: st.name, aggName: st.aggName, repoName: st.repoName });
    }
  }
  return saves;
}

export function plural(s: string): string {
  if (s.endsWith("y") && !/[aeiou]y$/.test(s)) return s.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/.test(s)) return s + "es";
  return s + "s";
}
