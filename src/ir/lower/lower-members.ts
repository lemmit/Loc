// -------------------------------------------------------------------------
// Shared entity-member + action lowering — the building blocks every
// entity-like declaration (aggregate / value-object / part) and the workflow
// lowerer reuse: fields, derived, invariants, functions, containments,
// operations / create / destroy / apply action bodies.  Pure leaf consumed
// by ./lower.ts (structural walk) and the workflow lowerer.
// -------------------------------------------------------------------------

import type { AstNode } from "langium";
import { isInferredContainment } from "../../language/containment.js";
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
  Unique,
} from "../../language/generated/ast.js";
import {
  isContainment,
  isDerivedProp,
  isFunctionDecl,
  isInvariant,
  isNamedType,
  isProperty,
} from "../../language/generated/ast.js";
// Re-exported so this leaf and its `lower-workflow` sibling share the one
// conservative plural rule set (`y→ies`, `s/x/z/ch/sh→es`, else `+s`) from
// `util/naming` rather than a hand-copied twin.
import { plural } from "../../util/naming.js";
import type {
  ApplyIR,
  ContainmentIR,
  DerivedIR,
  EntityPartIR,
  FieldIR,
  FunctionBodyIR,
  FunctionIR,
  IdValueType,
  InvariantIR,
  OperationIR,
  OperationKind,
  ParamIR,
  StmtIR,
  TypeIR,
  UniqueKeyIR,
  WorkflowStmtIR,
} from "../types/loom-ir.js";
import { mutatedParamNames, type SaveResolver } from "../util/domain-service-tier.js";
import { lowerExpr, lowerExprInContext } from "./lower-expr.js";
import { lowerStatement } from "./lower-stmt.js";
import { cstText, type Env, inPart, lowerType, withLocal } from "./lower-types.js";
import { originFor } from "./origin.js";

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
  const props = valueProperties(part.members);
  return {
    name: part.name,
    parentName: agg.name,
    parentIdValueType: "guid" as IdValueType,
    fields: props.map((p) => lowerField(p, inner)),
    contains: lowerContainments(part.members),
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
  // Pass `env` so an unresolved id ref (a capability `Self id` rewritten to
  // `<Host> id`, whose plain ref the Linker skips) recovers the target's
  // idKind by name — otherwise it would default to `guid`.
  const baseType = lowerType(p.type, env);
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
    origin: originFor(p),
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

// A `contains`-less entity-typed field (`line: OrderLine[]`) lowers to the same
// `ContainmentIR` as its explicit `contains line: OrderLine[]` twin — the
// `[]`/`?` markers live on the field's `TypeRef`, not a `Containment` node.
export function containmentFromProperty(p: Property): ContainmentIR {
  const base = isNamedType(p.type?.base) ? p.type.base : undefined;
  const ir: ContainmentIR = {
    name: p.name,
    partName: base?.target?.ref?.name ?? "Unknown",
    collection: !!p.type?.array,
  };
  if (p.type?.optional) ir.optional = true;
  return ir;
}

// The declaration-ordered containments of an aggregate / entity part — explicit
// `contains` members and inferred (entity-typed) properties, interleaved in
// source order so `wireShape`'s containment slice stays stable regardless of
// which spelling the author used.
export function lowerContainments(members: readonly AstNode[]): ContainmentIR[] {
  const out: ContainmentIR[] = [];
  for (const m of members) {
    if (isContainment(m)) out.push(lowerContainment(m));
    else if (isProperty(m) && isInferredContainment(m)) out.push(containmentFromProperty(m));
  }
  return out;
}

// The genuine value properties — declared `Property` members minus the ones that
// are really inferred containments.  The twin of `lowerContainments`: together
// they partition an aggregate / entity part's members exactly as the explicit
// `Property`/`Containment` split did before `contains` became optional.
export function valueProperties(members: readonly AstNode[]): Property[] {
  return members.filter((m): m is Property => isProperty(m) && !isInferredContainment(m));
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
    // `message "..."` — the STRING terminal is delimiter-stripped, so `i.message`
    // is the raw text; re-quote on emission.
    message: i.message ? { text: i.message } : undefined,
  };
}

/** Lower a `unique (a, b)` declaration to its columns + source snippet.
 *  Pure structural copy — the enforcement (DB unique index + 23505 → 409
 *  mapping) is derived downstream (migrations builder + backends), never
 *  here (uniqueness-and-indexes.md, D-UNIQUE-DOMAIN). */
export function lowerUnique(u: Unique): UniqueKeyIR {
  return { columns: [...u.columns], source: `unique (${u.columns.join(", ")})` };
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
      message: p.message ? { text: p.message } : undefined,
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
  // Body variant — expression form (`= Expression`) stays exactly as it was
  // (inlinable); block form (`{ Statement* }`) lowers via lowerStatement,
  // threading the let-binding env exactly like an operation body.
  let body: FunctionBodyIR;
  if (f.body !== undefined) {
    body = { expr: lowerExpr(f.body, inner) };
  } else {
    const stmts: StmtIR[] = [];
    let bodyEnv = inner;
    for (const s of f.block) {
      const result = lowerStatement(s, bodyEnv);
      stmts.push(result.stmt);
      bodyEnv = result.envAfter;
    }
    body = { stmts };
  }
  return {
    name: f.name,
    params,
    returnType: lowerType(f.returnType),
    body,
  };
}

export function lowerOperation(op: Operation, env: Env): OperationIR {
  const ir = lowerActionBody(
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
  // `when Expr` lowers in the AGGREGATE env (not the body env) — operation
  // params are deliberately out of scope (criterion.md: arg-aware checks
  // belong to `from <Criterion>(args)`, not `when`); the validator reports
  // a param reference rather than letting it lower as a free name.
  if (op.when) ir.when = lowerExpr(op.when, env);
  ir.origin = originFor(op);
  return ir;
}

// `create` / `destroy` share `operation`'s param + body shape; the
// kind tag (not the body syntax) carries the lifecycle asymmetry.  An
// unnamed declaration is the aggregate's canonical creator / terminator
// — its synthesised IR `name` is the keyword itself, and `canonical` is
// set so the Phase-2 route enrichment can route it to the bare
// collection URL.  create / destroy are never `private` / `extern`, so
// those default off; `audited` is read from the postfix grammar slot
// (`create(...) audited { }` / `destroy audited { }`).
export function lowerCreate(c: Create, env: Env): OperationIR {
  const ir = lowerActionBody(
    {
      kind: "create",
      name: c.name ?? "create",
      canonical: c.name == null,
      params: c.params,
      body: c.body,
      visibility: "public",
      extern: false,
      audited: c.audited ?? false,
    },
    env,
  );
  ir.origin = originFor(c);
  return ir;
}

export function lowerDestroy(d: Destroy, env: Env): OperationIR {
  const ir = lowerActionBody(
    {
      kind: "destroy",
      name: d.name ?? "destroy",
      canonical: d.name == null,
      params: d.params,
      body: d.body,
      visibility: "public",
      extern: false,
      audited: d.audited ?? false,
    },
    env,
  );
  ir.origin = originFor(d);
  return ir;
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
    // A param default (`param: T = <expr>`) lowers in the surrounding env —
    // which for an operation/create/destroy carries `this` — so a default may
    // reference the target instance (`to: date = this.eta`).  Sibling params
    // are intentionally NOT in scope (defaults resolve against `env`, not the
    // param-accumulating `inner`), keeping the resolution order-independent.
    const def = p.default ? lowerExprInContext(p.default, t, env) : undefined;
    params.push({ name: p.name, type: t, ...(def ? { default: def } : {}) });
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

/** Recursively collect every op-call target + `mutating`-service-mutated
 *  binding name reachable from a statement list, DESCENDING into `for-each`
 *  and `if-let` bodies.  The descent is what makes an OUTER binding mutated
 *  inside a loop body (`for o in orders { acct.charge(o.total) }`) still land
 *  in the enclosing scope's saves — without it, `acct.charge` mutated a live
 *  object that was never persisted (audit finding 2: silent data loss).  A
 *  binding declared INSIDE the nested body is loop-local; it is saved by that
 *  body's own `savesPerIteration` / `savesIn{Then,Else}`, and the caller here
 *  only ever matches these targets against bindings declared at ITS level, so
 *  the extra nested targets are harmless. */
function collectMutationTargets(
  statements: WorkflowStmtIR[],
  saveResolver: SaveResolver | undefined,
  opCallTargets: Set<string>,
  serviceMutated: Set<string>,
): void {
  for (const st of statements) {
    if (st.kind === "op-call") {
      opCallTargets.add(st.target);
    } else if (st.kind === "domain-service-call" && saveResolver) {
      const op = saveResolver.resolveServiceOp(st.service, st.op);
      if (!op) continue;
      const mutated = mutatedParamNames(op, saveResolver.resolveAggOp);
      if (mutated.size === 0) continue;
      // Map the mutated PARAM positions to the call's ARG expressions; an arg
      // that is a bare ref to a workflow-local aggregate var (a `repo-let` /
      // `let` / loop binding) is the persistence target.
      const args = st.call.kind === "call" ? st.call.args : [];
      op.params.forEach((p, i) => {
        const arg = args[i];
        if (mutated.has(p.name) && arg?.kind === "ref") serviceMutated.add(arg.name);
      });
    } else if (st.kind === "for-each") {
      collectMutationTargets(st.body, saveResolver, opCallTargets, serviceMutated);
    } else if (st.kind === "if-let") {
      collectMutationTargets(st.thenBody, saveResolver, opCallTargets, serviceMutated);
      collectMutationTargets(st.elseBody ?? [], saveResolver, opCallTargets, serviceMutated);
    }
  }
}

/** Compute the bindings to save for a statement list (the dirtiness
 *  rule): every `factory-let` always, every `repo-let` only when an
 *  op-call (at this level OR nested in a `for-each`/`if-let` body) targets it.
 *  When `loopVar` is supplied (a `for-each` body), the loop variable itself is
 *  saved if it is the target of any op-call in that body — the per-iteration
 *  save.  Top-level callers pass no loopVar; the result is the flat
 *  `savesAtExit`.  Nested-body descent (via {@link collectMutationTargets}) is
 *  what persists an outer binding mutated inside a loop (audit finding 2). */
export function computeSaves(
  statements: WorkflowStmtIR[],
  repoForAgg: Map<string, string>,
  loopVar?: { name: string; aggName: string; repoName: string },
  saveResolver?: SaveResolver,
): SaveEntry[] {
  const opCallTargets = new Set<string>();
  // The aggregate-arg names a called `mutating` domain service writes
  // (domain-services.md rev. 4, Slice 2).  `Transfer.run(s, d, amount)` mutates
  // its `source`/`dest` params (their own ops) → the workflow-local vars bound
  // to those positions (`s`/`d`) must persist at exit, exactly as a repo-let an
  // `op-call` targets does.  Derived from the resolved service op + aggregate
  // ops; read-only args (`amount`) never land here.  Without a resolver (legacy
  // single-context generate paths) this stays empty — saves are unchanged.
  const serviceMutated = new Set<string>();
  collectMutationTargets(statements, saveResolver, opCallTargets, serviceMutated);
  const saves: SaveEntry[] = [];
  if (loopVar && (opCallTargets.has(loopVar.name) || serviceMutated.has(loopVar.name))) {
    saves.push({ name: loopVar.name, aggName: loopVar.aggName, repoName: loopVar.repoName });
  }
  for (const st of statements) {
    if (st.kind === "factory-let") {
      const repoName = repoForAgg.get(st.aggName) ?? plural(st.aggName);
      saves.push({ name: st.name, aggName: st.aggName, repoName });
    } else if (
      st.kind === "repo-let" &&
      (opCallTargets.has(st.name) || serviceMutated.has(st.name))
    ) {
      saves.push({ name: st.name, aggName: st.aggName, repoName: st.repoName });
    }
  }
  return saves;
}

// `lower-workflow` imports `plural` from here; keep the name on this leaf's
// public surface while the single implementation lives in `util/naming`.
export { plural };
