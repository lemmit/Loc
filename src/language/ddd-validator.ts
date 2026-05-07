import { AstUtils, type AstNode, type ValidationAcceptor, type ValidationChecks } from "langium";
import type { DddServices } from "./ddd-module.js";
import {
  isAggregate,
  isAssignOrCallStmt,
  isContainment,
  isDerivedProp,
  isEmitStmt,
  isEntityPart,
  isFunctionDecl,
  isInvariant,
  isLetStmt,
  isOperation,
  isPreconditionStmt,
  isRequiresStmt,
  isPrimitiveType,
  isProperty,
  isValueObject,
  type Aggregate,
  type AssignOrCallStmt,
  type Containment,
  type DddAstType,
  type DerivedProp,
  type EmitStmt,
  type EntityPart,
  type FunctionDecl,
  type Invariant,
  type Operation,
  type Property,
  type Statement,
  type ValueObject,
} from "./generated/ast.js";
import {
  findFunction,
  findOperation,
  isAssignable,
  lookupRootMember,
  makeEnv,
  paramType,
  resolveTypeRef,
  stepInto,
  T,
  typeOf,
  typeToString,
  type DddType,
  type Env,
} from "./type-system.js";

export class DddValidator {
  // Entry: full model walk
  check(model: import("./generated/ast.js").Model, accept: ValidationAcceptor): void {
    for (const m of model.members) {
      if (m.$type === "BoundedContext") {
        this.checkContext(m, accept);
      } else if (m.$type === "System") {
        const deployables = m.members.filter((sm) => sm.$type === "Deployable");
        for (const sm of m.members) {
          if (sm.$type === "Module") {
            for (const ctx of sm.contexts) this.checkContext(ctx, accept);
          } else if (sm.$type === "BoundedContext") {
            this.checkContext(sm, accept);
          } else if (sm.$type === "Deployable") {
            this.checkDeployable(
              sm as import("./generated/ast.js").Deployable,
              deployables as import("./generated/ast.js").Deployable[],
              accept,
            );
          }
        }
      }
    }
  }

  private checkDeployable(
    d: import("./generated/ast.js").Deployable,
    siblings: import("./generated/ast.js").Deployable[],
    accept: ValidationAcceptor,
  ): void {
    if (d.platform === "react") {
      const target = d.targets?.ref;
      if (!target) {
        accept(
          "error",
          `Frontend deployable '${d.name}' must declare 'targets: <backend-deployable>'.`,
          { node: d, property: "name" },
        );
        return;
      }
      if (target.platform === "react") {
        accept(
          "error",
          `Frontend deployable '${d.name}' cannot target another frontend ('${target.name}'). Pick a 'dotnet' or 'hono' deployable.`,
          { node: d, property: "targets" },
        );
      }
      if (d.modules.length > 0) {
        accept(
          "warning",
          `Frontend deployable '${d.name}' inherits modules from its target '${target.name}'; the explicit 'modules:' list is ignored.`,
          { node: d, property: "modules" },
        );
      }
      void siblings;
    } else {
      if (d.targets) {
        accept(
          "error",
          `'targets:' is only valid on a 'platform: react' deployable.`,
          { node: d, property: "targets" },
        );
      }
    }
  }

  private checkContext(
    ctx: import("./generated/ast.js").BoundedContext,
    accept: ValidationAcceptor,
  ): void {
    for (const member of ctx.members) {
      if (isAggregate(member)) this.checkAggregate(member, accept);
      else if (isValueObject(member)) this.checkValueObject(member, accept);
    }
  }

  private checkAggregate(agg: Aggregate, accept: ValidationAcceptor) {
    // Ensure unique part names within the aggregate
    const partNames = new Set<string>();
    let displayField: Property | undefined;
    for (const m of agg.members) {
      if (isEntityPart(m)) {
        if (partNames.has(m.name)) {
          accept("error", `Duplicate entity part '${m.name}' in aggregate '${agg.name}'.`, {
            node: m,
            property: "name",
          });
        }
        partNames.add(m.name);
        this.checkEntityPart(m, agg, accept);
      }
      if (isContainment(m)) this.checkContainment(m, agg, accept);
      if (isInvariant(m)) this.checkInvariant(m, this.envForAggregate(agg), accept);
      if (isDerivedProp(m)) this.checkDerived(m, this.envForAggregate(agg), accept);
      if (isFunctionDecl(m)) this.checkFunction(m, agg, undefined, accept);
      if (isOperation(m)) this.checkOperation(m, agg, accept);
      if (isProperty(m) && m.display) {
        // At most one display field per aggregate.  Type must be `string`
        // (the React generator uses it as a Mantine <Select> option label).
        if (displayField) {
          accept(
            "error",
            `Aggregate '${agg.name}' declares multiple 'display' fields ('${displayField.name}' and '${m.name}'); at most one is allowed.`,
            { node: m, property: "display" },
          );
        }
        displayField = m;
        const typeText = m.type?.base;
        const isString =
          typeText && isPrimitiveType(typeText) && typeText.name === "string";
        if (!isString) {
          accept(
            "error",
            `Display field '${m.name}' on aggregate '${agg.name}' must have type 'string'.`,
            { node: m, property: "display" },
          );
        }
      }
    }
  }

  private checkEntityPart(part: EntityPart, agg: Aggregate, accept: ValidationAcceptor) {
    for (const m of part.members) {
      if (isContainment(m)) this.checkContainment(m, agg, accept);
      if (isInvariant(m)) this.checkInvariant(m, this.envForPart(agg, part), accept);
      if (isDerivedProp(m)) this.checkDerived(m, this.envForPart(agg, part), accept);
      if (isFunctionDecl(m)) this.checkFunction(m, agg, part, accept);
    }
  }

  private checkValueObject(vo: ValueObject, accept: ValidationAcceptor) {
    for (const m of vo.members) {
      if (isContainment(m)) {
        accept("error", `Value objects cannot contain entities.`, { node: m, property: "name" });
      }
      if (isInvariant(m)) this.checkInvariant(m, this.envForValueObject(vo), accept);
      if (isDerivedProp(m)) this.checkDerived(m, this.envForValueObject(vo), accept);
    }
  }

  private checkContainment(c: Containment, agg: Aggregate, accept: ValidationAcceptor) {
    const part = c.partType?.ref;
    if (!part) return;
    // Scope provider already restricts to local parts; this is a friendly
    // double-check in case of cross-aggregate ID-link errors.
    const owner = AstUtils.getContainerOfType(part, isAggregate);
    if (owner !== agg) {
      accept(
        "error",
        `Cannot 'contain' part '${part.name}' — it belongs to aggregate '${owner?.name ?? "?"}'. Use Id<${part.name}> for cross-aggregate links.`,
        { node: c, property: "partType" },
      );
    }
  }

  private checkInvariant(inv: Invariant, env: Env, accept: ValidationAcceptor) {
    const t = typeOf(inv.expr, env);
    if (t.kind !== "primitive" || t.name !== "bool") {
      accept(
        "error",
        `Invariant must be of type 'bool', got '${typeToString(t)}'.`,
        { node: inv, property: "expr" },
      );
    }
    if (inv.guard) {
      const g = typeOf(inv.guard, env);
      if (g.kind !== "primitive" || g.name !== "bool") {
        accept(
          "error",
          `Invariant guard ('when ...') must be of type 'bool', got '${typeToString(g)}'.`,
          { node: inv, property: "guard" },
        );
      }
    }
  }

  private checkDerived(d: DerivedProp, env: Env, accept: ValidationAcceptor) {
    const declared = resolveTypeRef(d.type);
    const actual = typeOf(d.expr, env);
    if (declared.kind !== "unknown" && actual.kind !== "unknown" && !isAssignable(actual, declared)) {
      accept(
        "error",
        `Derived '${d.name}' has expression of type '${typeToString(actual)}' but declared type is '${typeToString(declared)}'.`,
        { node: d, property: "expr" },
      );
    }
  }

  private checkFunction(
    fn: FunctionDecl,
    agg: Aggregate,
    part: EntityPart | undefined,
    accept: ValidationAcceptor,
  ) {
    const env = part ? this.envForPart(agg, part, fn) : this.envForAggregate(agg, fn);
    const declared = resolveTypeRef(fn.returnType);
    const actual = typeOf(fn.body, env);
    if (declared.kind !== "unknown" && actual.kind !== "unknown" && !isAssignable(actual, declared)) {
      accept(
        "error",
        `Function '${fn.name}' returns '${typeToString(actual)}' but is declared to return '${typeToString(declared)}'.`,
        { node: fn, property: "body" },
      );
    }
  }

  private checkOperation(op: Operation, agg: Aggregate, accept: ValidationAcceptor) {
    // Build env with parameters and walk body
    const bindings = new Map<string, { type: DddType; origin: AstNode }>();
    for (const p of op.params) bindings.set(p.name, { type: paramType(p), origin: p });
    let env: Env = makeEnv(this.envForAggregate(agg), bindings, { aggregate: agg });

    for (const stmt of op.body) {
      env = this.checkStatement(stmt, agg, op, env, accept);
    }
  }

  private checkStatement(
    stmt: Statement,
    agg: Aggregate,
    op: Operation,
    env: Env,
    accept: ValidationAcceptor,
  ): Env {
    if (isPreconditionStmt(stmt)) {
      const t = typeOf(stmt.expr, env);
      if (t.kind !== "primitive" || t.name !== "bool") {
        accept(
          "error",
          `'precondition' must be of type 'bool', got '${typeToString(t)}'.`,
          { node: stmt, property: "expr" },
        );
      }
      return env;
    }
    if (isRequiresStmt(stmt)) {
      const t = typeOf(stmt.expr, env);
      if (t.kind !== "primitive" || t.name !== "bool") {
        accept(
          "error",
          `'requires' must be of type 'bool', got '${typeToString(t)}'.`,
          { node: stmt, property: "expr" },
        );
      }
      return env;
    }
    if (isLetStmt(stmt)) {
      const t = typeOf(stmt.expr, env);
      const next = new Map<string, { type: DddType; origin: AstNode }>();
      next.set(stmt.name, { type: t, origin: stmt });
      return makeEnv(env, next);
    }
    if (isEmitStmt(stmt)) {
      this.checkEmit(stmt, env, accept);
      return env;
    }
    if (isAssignOrCallStmt(stmt)) {
      this.checkAssignOrCall(stmt, agg, op, env, accept);
      return env;
    }
    return env;
  }

  private checkAssignOrCall(
    stmt: AssignOrCallStmt,
    agg: Aggregate,
    op: Operation,
    env: Env,
    accept: ValidationAcceptor,
  ) {
    if (!stmt.op) {
      // Bare call statement
      this.checkCallStmt(stmt, agg, op, accept);
      return;
    }
    const targetType = this.lvalueType(stmt.target, agg, env, accept);
    // Reject assignment to a derived property — derived members are
    // computed from other state and writing to them would silently no-op.
    if (this.lvalueIsDerived(stmt.target, agg)) {
      accept(
        "error",
        `Cannot assign to derived property '${pathString(stmt.target)}'.`,
        { node: stmt, property: "target" },
      );
      return;
    }
    if (stmt.op === ":=") {
      const valueType = typeOf(stmt.value, env);
      if (
        targetType.kind !== "unknown" &&
        valueType.kind !== "unknown" &&
        !isAssignable(valueType, targetType)
      ) {
        accept(
          "error",
          `Cannot assign '${typeToString(valueType)}' to '${typeToString(targetType)}'.`,
          { node: stmt, property: "value" },
        );
      }
    } else {
      // '+=' or '-='
      if (targetType.kind !== "array") {
        accept(
          "error",
          `'${stmt.op}' requires a collection on the left-hand side, got '${typeToString(targetType)}'.`,
          { node: stmt, property: "target" },
        );
        return;
      }
      const valueType = typeOf(stmt.value, env);
      if (
        targetType.element.kind !== "unknown" &&
        valueType.kind !== "unknown" &&
        !isAssignable(valueType, targetType.element)
      ) {
        accept(
          "error",
          `Cannot ${stmt.op === "+=" ? "add" : "remove"} element of type '${typeToString(valueType)}' to/from collection of '${typeToString(targetType.element)}'.`,
          { node: stmt, property: "value" },
        );
      }
    }
  }

  private checkEmit(stmt: EmitStmt, env: Env, accept: ValidationAcceptor) {
    const ev = stmt.event?.ref;
    if (!ev) return;
    const declared = new Map(ev.fields.map((f) => [f.name, resolveTypeRef(f.type)] as const));
    const seen = new Set<string>();
    for (const f of stmt.fields) {
      seen.add(f.name);
      const expected = declared.get(f.name);
      if (!expected) {
        accept("error", `Event '${ev.name}' has no field '${f.name}'.`, {
          node: f,
          property: "name",
        });
        continue;
      }
      const actual = typeOf(f.value, env);
      if (!isAssignable(actual, expected)) {
        accept(
          "error",
          `Field '${f.name}' expects '${typeToString(expected)}' but got '${typeToString(actual)}'.`,
          { node: f, property: "value" },
        );
      }
    }
    for (const [name] of declared) {
      if (!seen.has(name)) {
        accept("warning", `Event field '${name}' not provided.`, {
          node: stmt,
          property: "event",
        });
      }
    }
  }

  private checkCallStmt(stmt: AssignOrCallStmt, agg: Aggregate, op: Operation, accept: ValidationAcceptor) {
    const lv = stmt.target;
    if (lv.tail.length === 0 && lv.call) {
      const name = lv.head;
      const fn = findFunction(agg, name);
      if (fn) return;
      const target = findOperation(agg, name);
      if (target) {
        if (target === op) {
          accept("warning", `Operation '${name}' calls itself.`, { node: stmt });
        }
        return;
      }
      accept(
        "error",
        `Cannot resolve call to '${name}' from aggregate '${agg.name}'.`,
        { node: stmt },
      );
    } else if (!lv.call) {
      accept(
        "error",
        `Bare statement must be an assignment, collection mutation, or function/operation call.`,
        { node: stmt },
      );
    }
  }

  private lvalueType(
    lv: import("./generated/ast.js").LValue,
    agg: Aggregate,
    env: Env,
    accept: ValidationAcceptor,
  ): DddType {
    // Resolve the head: a parameter, let-binding, or an aggregate property.
    const headSym = env.resolve(lv.head);
    let cur: DddType;
    if (headSym) {
      cur = headSym.type;
    } else {
      // Check aggregate root members
      cur = lookupRootMember(agg, lv.head);
      if (cur.kind === "unknown") {
        accept("error", `Cannot resolve '${lv.head}'.`, { node: lv, property: "head" });
        return T.unknown;
      }
    }
    for (const seg of lv.tail) {
      cur = stepInto(cur, seg);
      if (cur.kind === "unknown") {
        accept("error", `Cannot resolve member '${seg}'.`, { node: lv });
        return T.unknown;
      }
    }
    return cur;
  }

  private envForAggregate(agg: Aggregate, fn?: FunctionDecl): Env {
    const bindings = new Map<string, { type: DddType; origin: AstNode }>();
    // Aggregate properties / derived / contains are in scope as bare
    // identifiers — same as if we accessed them via `this`.
    for (const m of agg.members) {
      if (isProperty(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
      else if (isDerivedProp(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
      else if (isContainment(m)) {
        const part = m.partType?.ref;
        if (part) {
          const t: DddType = { kind: "entity", ref: part };
          bindings.set(m.name, { type: m.collection ? T.array(t) : t, origin: m });
        }
      }
    }
    if (fn) for (const p of fn.params) bindings.set(p.name, { type: paramType(p), origin: p });
    return makeEnv(undefined, bindings, { aggregate: agg });
  }

  private envForPart(agg: Aggregate, part: EntityPart, fn?: FunctionDecl): Env {
    const bindings = new Map<string, { type: DddType; origin: AstNode }>();
    for (const m of part.members) {
      if (isProperty(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
      else if (isDerivedProp(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
      else if (isContainment(m)) {
        const partType = m.partType?.ref;
        if (partType) {
          const t: DddType = { kind: "entity", ref: partType };
          bindings.set(m.name, { type: m.collection ? T.array(t) : t, origin: m });
        }
      }
    }
    if (fn) for (const p of fn.params) bindings.set(p.name, { type: paramType(p), origin: p });
    return makeEnv(undefined, bindings, { aggregate: agg, part });
  }

  private envForValueObject(vo: ValueObject): Env {
    const bindings = new Map<string, { type: DddType; origin: AstNode }>();
    for (const m of vo.members) {
      if (isProperty(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
      else if (isDerivedProp(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
    }
    return makeEnv(undefined, bindings, { valueObject: vo });
  }

  /**
   * True if the lvalue's *final* segment names a derived member of the
   * type reachable via the path so far.  Derived members are computed
   * from state and cannot be assigned to.
   */
  private lvalueIsDerived(
    lv: import("./generated/ast.js").LValue,
    agg: Aggregate,
  ): boolean {
    if (lv.tail.length === 0) {
      // Direct head reference — check root members
      for (const m of agg.members) {
        if (isDerivedProp(m) && m.name === lv.head) return true;
      }
      return false;
    }
    // Walk the path, last segment matters
    let cur: DddType = lookupRootMember(agg, lv.head);
    for (let i = 0; i < lv.tail.length - 1; i++) {
      cur = stepInto(cur, lv.tail[i]!);
    }
    const lastSegment = lv.tail[lv.tail.length - 1]!;
    if (cur.kind === "entity" || cur.kind === "aggregate") {
      for (const m of cur.ref.members) {
        if (isDerivedProp(m) && m.name === lastSegment) return true;
      }
    }
    if (cur.kind === "valueobject") {
      for (const m of cur.ref.members) {
        if (isDerivedProp(m) && m.name === lastSegment) return true;
      }
    }
    return false;
  }
}

function pathString(lv: import("./generated/ast.js").LValue): string {
  return [lv.head, ...lv.tail].join(".");
}

export function registerValidationChecks(services: DddServices): void {
  const registry = services.validation.ValidationRegistry;
  const validator = services.validation.DddValidator;
  const checks: ValidationChecks<DddAstType> = {
    Model: validator.check.bind(validator),
  };
  registry.register(checks, validator);
}
