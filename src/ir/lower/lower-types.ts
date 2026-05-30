import type { AstNode } from "langium";
import type {
  Aggregate,
  BoundedContext,
  EntityPart,
  EnumDecl,
  FunctionDecl,
  Operation,
  TypeRef,
  ValueObject,
} from "../../language/generated/ast.js";
import {
  isAggregate,
  isContainment,
  isDerivedProp,
  isEntityPart,
  isEnumDecl,
  isFunctionDecl,
  isIdType,
  isNamedType,
  isOperation,
  isPrimitiveType,
  isProperty,
  isSlotType,
  isValueObject,
} from "../../language/generated/ast.js";
import type {
  DataSourceKind,
  ExprIR,
  IdValueType,
  PermissionDeclIR,
  TypeIR,
  UserIR,
} from "../types/loom-ir.js";

/** Synthetic entity name used to type the `currentUser` magic
 *  identifier.  Member access on the user shape resolves through
 *  `env.user.fields` rather than the bounded-context namespace, so
 *  the name doesn't collide with any user-declared aggregate / part. */
export const USER_SHAPE_NAME = "__User__";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

export interface Env {
  /** The enclosing bounded context.  Undefined for `test e2e` blocks
   * that live at the system level, outside any context. */
  ctx?: BoundedContext;
  aggregate?: Aggregate;
  part?: EntityPart;
  valueObject?: ValueObject;
  locals: Map<string, { kind: "param" | "let" | "lambda"; type: TypeIR }>;
  /** System-wide user-claim shape — the lowered `user { ... }` block.
   *  Threaded down by the lowering structure layer so every
   *  expression context (operation / workflow / view / test) can
   *  resolve the magic `currentUser` identifier.  Undefined for
   *  systems / loose contexts that don't declare a user block. */
  user?: UserIR;
  /** Active criterion-parameter substitutions, set only while inlining
   *  a `criterion` body at a use site (see `inlineCriterion` in
   *  lower-expr.ts).  Maps each parameter name to the caller's already-
   *  lowered argument expression; a bare reference to the parameter in
   *  the body resolves directly to that expression.  Undefined outside a
   *  criterion inline. */
  criterionArgs?: Map<string, ExprIR>;
  /** Names of the criteria currently being inlined, outermost first.
   *  Guards against `criterion A = B` / `criterion B = A` cycles — a
   *  reference to a name already on the stack is left unresolved for the
   *  validator (`loom.criterion-cycle`) to report. */
  criterionStack?: string[];
  /** Module-scoped permission catalogue — populated when the
   *  enclosing context lives inside a module that declares one or
   *  more `permissions { ... }` blocks.  Drives resolution of the
   *  magic `permissions.<name>` identifier in expression bodies.
   *  Loose contexts (no enclosing module) leave it undefined; the
   *  validator surfaces a friendly diagnostic for any
   *  `permissions.X` reference there. */
  modulePermissions?: PermissionDeclIR[];
  /** Resources in scope for the enclosing context — `resource X { for:
   *  <thisCtx>, kind, … }` declarations, keyed by name to their infra
   *  kind.  Drives resolution of an ambient resource handle
   *  (`files.put(...)`) in workflow bodies (Phase 4).  Undefined / empty
   *  outside a context or when none are declared for it. */
  resources?: Map<string, DataSourceKind>;
}

export function newEnv(
  ctx: BoundedContext,
  user?: UserIR,
  modulePermissions?: PermissionDeclIR[],
  resources?: Map<string, DataSourceKind>,
): Env {
  return { ctx, locals: new Map(), user, modulePermissions, resources };
}

export function withLocal(
  env: Env,
  name: string,
  kind: "param" | "let" | "lambda",
  type: TypeIR,
): Env {
  const next = new Map(env.locals);
  next.set(name, { kind, type });
  return { ...env, locals: next };
}

export function inAggregate(env: Env, agg: Aggregate): Env {
  return { ...env, aggregate: agg, part: undefined, valueObject: undefined };
}

export function inPart(env: Env, agg: Aggregate, part: EntityPart): Env {
  return { ...env, aggregate: agg, part, valueObject: undefined };
}

export function inValueObject(env: Env, vo: ValueObject): Env {
  return { ...env, valueObject: vo, aggregate: undefined, part: undefined };
}

export interface ScopeCandidate {
  name: string;
  kind:
    | "current-user"
    | "param"
    | "let"
    | "lambda"
    | "property"
    | "derived"
    | "helper-fn"
    | "enum-value";
}

/** Enumerate the names resolvable as a bare `NameRef` in `env` — the
 *  enumeration counterpart to `resolveNameRef` below.  Drives scope-aware name
 *  suggestions in tooling (the web model builder's expression editor) so the
 *  in-scope rules live in one place.  Order follows resolution precedence
 *  (currentUser → locals → properties/containments/derived/helpers → enum
 *  values); the first occurrence of a name wins, mirroring shadowing. */
export function inScopeNames(env: Env): ScopeCandidate[] {
  const out: ScopeCandidate[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: ScopeCandidate["kind"]): void => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, kind });
  };
  if (env.user) add("currentUser", "current-user");
  for (const [name, info] of env.locals) add(name, info.kind);
  const owner = env.part ?? env.aggregate ?? env.valueObject;
  if (owner) {
    for (const m of owner.members) {
      if (isProperty(m) || isContainment(m)) add(m.name, "property");
      else if (isDerivedProp(m)) add(m.name, "derived");
      else if (isFunctionDecl(m)) add(m.name, "helper-fn");
    }
  }
  if (env.ctx) {
    for (const m of env.ctx.members) {
      if (isEnumDecl(m)) for (const v of m.values) add(v.name, "enum-value");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export function lowerType(t: TypeRef | undefined, env?: Env): TypeIR {
  if (!t) return { kind: "primitive", name: "string" };
  let inner = lowerBase(t, env);
  if (t.array) inner = { kind: "array", element: inner };
  if (t.optional) inner = { kind: "optional", inner };
  return inner;
}

function lowerBase(t: TypeRef, env?: Env): TypeIR {
  const base = t.base;
  if (isPrimitiveType(base)) return { kind: "primitive", name: base.name };
  if (isSlotType(base)) return { kind: "slot" };
  if (isIdType(base)) {
    const target = base.target?.ref;
    let valueType: IdValueType = "guid";
    if (target && isAggregate(target)) {
      valueType = (target.idKind ?? "guid") as IdValueType;
    } else if (target && isEntityPart(target)) {
      const owner = ancestorAggregate(target);
      valueType = (owner?.idKind ?? "guid") as IdValueType;
    }
    // Macro-emitted references can lack a `$refNode`, which causes
    // Langium's default Linker to skip resolution silently — `ref`
    // stays undefined even when the target exists in scope.  Fall
    // back to the reference text so the IR still names the target;
    // downstream generators pick up the right `<Name>Id` symbol.
    // Tracked separately from the "genuinely unresolved" case
    // because the text is authoritative for synthesised refs.
    const targetName = target?.name ?? base.target?.$refText ?? "Unknown";
    return {
      kind: "id",
      targetName,
      valueType,
    };
  }
  if (isNamedType(base)) {
    const target = base.target?.ref;
    if (target) {
      if (isEnumDecl(target)) return { kind: "enum", name: target.name };
      if (isValueObject(target)) return { kind: "valueobject", name: target.name };
      if (isAggregate(target)) return { kind: "entity", name: target.name };
      if (isEntityPart(target)) return { kind: "entity", name: target.name };
    }
    // Macro-emitted reference without a `$refNode` — Langium's default
    // Linker skips it silently (same hazard the IdType branch handles
    // above), so `ref` stays undefined even though the decl is in scope.
    // Resolve the reference text against the lowering env so a synthesised
    // param keeps its value-object / enum type instead of collapsing to
    // `string` (the bug that broke `crudish` update params on VO/enum
    // fields).
    const refText = base.target?.$refText;
    if (refText && env) {
      if (findValueObjectByName(env, refText)) return { kind: "valueobject", name: refText };
      if (findEnumByName(env, refText)) return { kind: "enum", name: refText };
      if (findEntityByName(env, refText)) return { kind: "entity", name: refText };
    }
    return { kind: "primitive", name: "string" };
  }
  return { kind: "primitive", name: "string" };
}

// ---------------------------------------------------------------------------
// Name lookups
// ---------------------------------------------------------------------------

export function findEntityByName(env: Env, name: string): Aggregate | EntityPart | undefined {
  if (!env.ctx) return undefined;
  for (const m of env.ctx.members) {
    if (isAggregate(m)) {
      if (m.name === name) return m;
      for (const inner of m.members) {
        if (isEntityPart(inner) && inner.name === name) return inner;
      }
    }
  }
  return undefined;
}

export function findValueObjectByName(env: Env, name: string): ValueObject | undefined {
  if (!env.ctx) return undefined;
  for (const m of env.ctx.members) {
    if (isValueObject(m) && m.name === name) return m;
  }
  return undefined;
}

export function findEnumByName(env: Env, name: string): EnumDecl | undefined {
  if (!env.ctx) return undefined;
  for (const m of env.ctx.members) {
    if (isEnumDecl(m) && m.name === name) return m;
  }
  return undefined;
}

export function findFunctionInEnv(env: Env, name: string): FunctionDecl | undefined {
  const owners: Array<Aggregate | EntityPart | ValueObject | undefined> = [
    env.part,
    env.aggregate,
    env.valueObject,
  ];
  for (const o of owners) {
    if (!o) continue;
    for (const m of o.members) {
      if (isFunctionDecl(m) && m.name === name) return m;
    }
  }
  return undefined;
}

export function findOperationInEnv(env: Env, name: string): Operation | undefined {
  if (!env.aggregate) return undefined;
  for (const m of env.aggregate.members) {
    if (isOperation(m) && m.name === name) return m;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Misc AST helpers
// ---------------------------------------------------------------------------

export function ancestorAggregate(node: AstNode): Aggregate | undefined {
  let cur: AstNode | undefined = node;
  while (cur) {
    if (isAggregate(cur)) return cur;
    cur = cur.$container;
  }
  return undefined;
}

export function cstText(node: AstNode | undefined): string {
  if (!node) return "";
  const cst = (node as { $cstNode?: { text?: string } }).$cstNode;
  return cst?.text ?? "<expr>";
}
