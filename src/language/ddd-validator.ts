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
    // Slice 21.C — validate every `string.matches(regex)` call's
    // argument is a string literal that compiles as a RegExp.
    // Walks the entire AST so the rule applies in invariants,
    // preconditions, derived bodies, function bodies, and guards
    // alike — anywhere the operator can appear.
    this.checkMatchesCalls(model, accept);
    // Slice 3 — match expressions: warn on a missing `else` arm.
    // Type-checking arm conditions is best-effort here (the lowering's
    // type system is the source of truth); structural checks run
    // unconditionally.
    this.checkMatchExpressions(model, accept);
    for (const m of model.members) {
      if (m.$type === "BoundedContext") {
        this.checkContext(m, accept);
      } else if (m.$type === "System") {
        const deployables = m.members.filter((sm) => sm.$type === "Deployable");
        const themeBlocks = m.members.filter(
          (sm) => sm.$type === "ThemeBlock",
        ) as import("./generated/ast.js").ThemeBlock[];
        if (themeBlocks.length > 1) {
          for (const tb of themeBlocks.slice(1)) {
            accept(
              "error",
              `system '${m.name}' declares more than one 'theme { ... }' block; keep just the first.`,
              { node: tb },
            );
          }
        }
        for (const tb of themeBlocks) this.checkTheme(tb, accept);
        // Slice 3 — page metamodel.  Collect ui blocks first so per-
        // ui checks can see siblings (name uniqueness across uis), and
        // so per-deployable checks can cross-reference the system's
        // ui inventory.
        const uis = m.members.filter(
          (sm) => sm.$type === "Ui",
        ) as import("./generated/ast.js").Ui[];
        const uiNamesSeen = new Map<string, import("./generated/ast.js").Ui>();
        for (const ui of uis) {
          const prior = uiNamesSeen.get(ui.name);
          if (prior) {
            // Rule 1: UI name uniqueness within a system.  Flag the
            // duplicates (not the first declaration).
            accept(
              "error",
              `Duplicate ui block '${ui.name}'; ui names must be unique within a system.`,
              { node: ui, property: "name" },
            );
          } else {
            uiNamesSeen.set(ui.name, ui);
          }
        }

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
          } else if (sm.$type === "Ui") {
            this.checkUi(
              sm as import("./generated/ast.js").Ui,
              m as import("./generated/ast.js").System,
              accept,
            );
          }
        }
      }
    }
  }

  private checkTheme(
    block: import("./generated/ast.js").ThemeBlock,
    accept: ValidationAcceptor,
  ): void {
    const knownNames = new Set([
      "primary",
      "neutral",
      "radius",
      "fontFamily",
    ]);
    const knownRadius = new Set(["none", "sm", "md", "lg", "xl"]);
    // Hex colors: #RGB, #RRGGBB, or #RRGGBBAA.  Everything else
    // ("blue" / "rgb(...)" / "var(--brand)") routes through a future
    // slice if a user asks; rejecting here keeps the surface tight
    // and the Mantine shade-ramp generator simple.
    const hexColor = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
    const seen = new Set<string>();
    for (const p of block.props) {
      // (1) Unknown property name.
      if (!knownNames.has(p.name)) {
        accept(
          "error",
          `unknown theme property '${p.name}'. Known properties: ${[...knownNames].join(", ")}.`,
          { node: p, property: "name" },
        );
        continue;
      }
      // (2) Duplicate property name.
      if (seen.has(p.name)) {
        accept(
          "error",
          `theme property '${p.name}' declared more than once.`,
          { node: p, property: "name" },
        );
        continue;
      }
      seen.add(p.name);
      // (3) Per-property value validation.
      if (p.name === "primary" || p.name === "neutral") {
        if (!hexColor.test(p.value)) {
          accept(
            "error",
            `theme '${p.name}' must be a CSS hex color (#RGB, #RRGGBB, or #RRGGBBAA); got '${p.value}'.`,
            { node: p, property: "value" },
          );
        }
      } else if (p.name === "radius") {
        if (!knownRadius.has(p.value)) {
          accept(
            "error",
            `theme 'radius' must be one of ${[...knownRadius].join(" | ")}; got '${p.value}'.`,
            { node: p, property: "value" },
          );
        }
      }
      // fontFamily is a free-form string — pass-through to the
      // Mantine theme.  No validation beyond "non-empty"; a typo'd
      // family name silently falls through to the OS fallback at
      // runtime, which is acceptable.
    }
  }

  private checkDeployable(
    d: import("./generated/ast.js").Deployable,
    siblings: import("./generated/ast.js").Deployable[],
    accept: ValidationAcceptor,
  ): void {
    // Slice 3 — page-metamodel UI binding rules (3, 4).
    // Rule 3: only `react` and `static` platforms admit `ui:`.
    // Rule 4: every `static` deployable must declare `ui:` (otherwise
    //         it has nothing to serve).
    const hasUiBinding = !!(d.uiSugar || d.uiBlock);
    if (hasUiBinding && d.platform !== "react" && d.platform !== "static") {
      accept(
        "error",
        `'ui:' binding is only valid on 'platform: react' or 'platform: static' deployables (got '${d.platform}').`,
        {
          node: d,
          property: d.uiSugar ? "uiSugar" : "uiBlock",
        },
      );
    }
    if (d.platform === "static" && !hasUiBinding) {
      accept(
        "error",
        `Static deployable '${d.name}' must declare a 'ui:' binding — there is nothing to serve without one.`,
        { node: d, property: "name" },
      );
    }
    // Rule 13: framework only `react` in v0.  The grammar enum
    // restricts to `'react'` so this is structurally enforced; an
    // explicit check here documents the intent and keeps a stable
    // diagnostic message when more frameworks land.
    const framework = d.uiBlock?.framework;
    if (framework && framework !== "react" && d.uiBlock) {
      accept(
        "error",
        `Framework '${framework}' is not yet supported (v0 ships only 'react'). Drop the framework override or pick 'react'.`,
        { node: d.uiBlock, property: "framework" },
      );
    }

    // Existing rules — react/static both behave like frontends.
    if (d.platform === "react" || d.platform === "static") {
      const target = d.targets?.ref;
      if (!target) {
        accept(
          "error",
          `Frontend deployable '${d.name}' must declare 'targets: <backend-deployable>'.`,
          { node: d, property: "name" },
        );
        return;
      }
      if (target.platform === "react" || target.platform === "static") {
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
          `'targets:' is only valid on a 'platform: react' or 'platform: static' deployable.`,
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
      if (isProperty(m) && m.check) this.checkPropertyCheck(m, this.envForAggregate(agg), accept);
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
      if (isProperty(m) && m.check) this.checkPropertyCheck(m, this.envForPart(agg, part), accept);
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
      if (isProperty(m) && m.check) this.checkPropertyCheck(m, this.envForValueObject(vo), accept);
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

  private checkMatchExpressions(
    model: import("./generated/ast.js").Model,
    accept: ValidationAcceptor,
  ): void {
    for (const node of AstUtils.streamAllContents(model)) {
      if (node.$type !== "MatchExpr") continue;
      const m = node as import("./generated/ast.js").MatchExpr;
      // Empty match (no arms, no else) is structurally meaningless —
      // grammar permits it, validator rejects.
      if (m.arms.length === 0 && !m.elseExpr) {
        accept(
          "error",
          `Empty 'match { }' — must declare at least one arm or an 'else' branch.`,
          { node: m },
        );
        continue;
      }
      // Warn on non-exhaustive matches (no `else`).  An expression
      // without `else` returns undefined when no arm matches, which
      // is rarely intentional — for state-machine page bodies it
      // means "render nothing" which is usually a bug.  Promoted
      // from error to warning to keep the surface friendly while
      // the user iterates.
      if (!m.elseExpr) {
        accept(
          "warning",
          `'match' expression has no 'else' arm — when no arm matches, the expression is undefined.  Add 'else => …' for exhaustive coverage.`,
          { node: m },
        );
      }
    }
  }

  private checkMatchesCalls(
    model: import("./generated/ast.js").Model,
    accept: ValidationAcceptor,
  ): void {
    for (const node of AstUtils.streamAllContents(model)) {
      if (node.$type !== "MemberAccess") continue;
      const ma = node as import("./generated/ast.js").MemberAccess;
      if (ma.member !== "matches" || !ma.call) continue;
      // `matches` always takes exactly one string-literal argument.
      if (ma.args.length !== 1) {
        accept(
          "error",
          `'matches' takes exactly one argument (a string-literal regex pattern).`,
          { node: ma, property: "args" },
        );
        continue;
      }
      // Slice 1.5: call args are CallArg wrappers carrying an
      // optional `name:` prefix; reach for `.value` to inspect the
      // expression itself.  `string.matches(<regex>)` is a single-
      // positional-arg method-call, so `name` should be absent.
      const argWrap = ma.args[0]!;
      const arg = argWrap.value;
      if (argWrap.name) {
        accept(
          "error",
          `'matches' takes a single positional argument; named arguments are not supported.`,
          { node: argWrap, property: "name" },
        );
        continue;
      }
      if (arg.$type !== "StringLit") {
        accept(
          "error",
          `'matches' argument must be a string literal — patterns must be known at codegen time.`,
          { node: ma, property: "args" },
        );
        continue;
      }
      const raw = (
        arg as import("./generated/ast.js").StringLit
      ).value as string;
      // The grammar's STRING terminal carries the surrounding quotes.
      const pattern = raw.startsWith('"') ? JSON.parse(raw) : raw;
      try {
        new RegExp(pattern);
      } catch (err) {
        accept(
          "error",
          `'matches' pattern is not a valid regular expression: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { node: ma, property: "args" },
        );
      }
    }
  }

  private checkPropertyCheck(p: Property, env: Env, accept: ValidationAcceptor) {
    if (!p.check) return;
    const t = typeOf(p.check, env);
    if (t.kind !== "primitive" || t.name !== "bool") {
      accept(
        "error",
        `Property check on '${p.name}' must be of type 'bool', got '${typeToString(t)}'.`,
        { node: p, property: "check" },
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

  // ---------------------------------------------------------------------------
  // Page metamodel — Slice 3 validator obligations.
  //
  // Per the plan at /root/.claude/plans/yes-make-full-plan-tingly-sunbeam.md.
  // Walks each `ui` SystemMember and emits diagnostics for malformed
  // pages, scaffold directives, menus, and the references between
  // them.  Cross-cutting rules (uniqueness across uis, deployable.ui
  // → ui resolution) are handled in `check()` and `checkDeployable()`
  // respectively.
  //
  // These checks are intentionally syntactic / cross-reference; deeper
  // type analysis on body expressions and component-stdlib parameter
  // shape lives in Slice 5 (page emitter + closed-stdlib spec table).
  // ---------------------------------------------------------------------------

  private checkUi(
    ui: import("./generated/ast.js").Ui,
    sys: import("./generated/ast.js").System,
    accept: ValidationAcceptor,
  ): void {
    // Page name uniqueness within the ui (Rule 7).  Override-by-name
    // is the SAME mechanism — the explicit page must displace exactly
    // one scaffolded page; multiple explicit pages with the same name
    // are still an error.
    const pageNamesSeen = new Map<
      string,
      import("./generated/ast.js").Page
    >();
    for (const m of ui.members) {
      if (m.$type !== "Page") continue;
      const prior = pageNamesSeen.get(m.name);
      if (prior) {
        accept(
          "error",
          `Duplicate page '${m.name}' in ui '${ui.name}'.  Pages within a ui must have unique names; an explicit override-by-name displaces a single scaffolded page, not another explicit one.`,
          { node: m, property: "name" },
        );
      } else {
        pageNamesSeen.set(m.name, m);
      }
    }

    // At most one ui-level menu block (Rule 8 part).
    const menuBlocks = ui.members.filter((m) => m.$type === "MenuBlock");
    if (menuBlocks.length > 1) {
      for (const extra of menuBlocks.slice(1)) {
        accept(
          "error",
          `ui '${ui.name}' declares more than one 'menu { ... }' block; keep just the first.`,
          { node: extra },
        );
      }
    }

    // Per-member walks.
    for (const m of ui.members) {
      if (m.$type === "Scaffold") this.checkScaffold(m, sys, accept);
      else if (m.$type === "Page") this.checkPage(m, ui, accept);
      else if (m.$type === "MenuBlock") this.checkMenuBlock(m, ui, accept);
    }
  }

  private checkScaffold(
    s: import("./generated/ast.js").Scaffold,
    sys: import("./generated/ast.js").System,
    accept: ValidationAcceptor,
  ): void {
    // Rule 5 — selector targets must resolve to declarations of the
    // matching kind anywhere in the system.  The deployable-targets-
    // chain reachability check is left to Slice 4's expander where
    // we already need to walk reachability for page generation.

    // Build per-kind name sets from the system's domain IR.
    const moduleNames = new Set<string>();
    const contextNames = new Set<string>();
    const aggregateNames = new Set<string>();
    const workflowNames = new Set<string>();
    const viewNames = new Set<string>();
    for (const sm of sys.members) {
      if (sm.$type === "Module") {
        moduleNames.add(sm.name);
        for (const ctx of sm.contexts) {
          contextNames.add(ctx.name);
          for (const cm of ctx.members) {
            if (cm.$type === "Aggregate") aggregateNames.add(cm.name);
            else if (cm.$type === "Workflow") workflowNames.add(cm.name);
            else if (cm.$type === "View") viewNames.add(cm.name);
          }
        }
      } else if (sm.$type === "BoundedContext") {
        contextNames.add(sm.name);
        for (const cm of sm.members) {
          if (cm.$type === "Aggregate") aggregateNames.add(cm.name);
          else if (cm.$type === "Workflow") workflowNames.add(cm.name);
          else if (cm.$type === "View") viewNames.add(cm.name);
        }
      }
    }

    const expected =
      s.selector === "modules"
        ? moduleNames
        : s.selector === "contexts"
        ? contextNames
        : s.selector === "aggregates"
        ? aggregateNames
        : s.selector === "workflows"
        ? workflowNames
        : viewNames;

    const seenWithinDirective = new Set<string>();
    for (const t of s.targets) {
      if (!expected.has(t)) {
        accept(
          "error",
          `'scaffold ${s.selector}: ${t}' — no ${singular(s.selector)} '${t}' is declared in this system.`,
          { node: s, property: "targets" },
        );
      }
      // Rule 6 (light) — same name listed twice in one directive.
      // Cross-directive double-scaffolding (same module, different
      // granularity) is detected by Slice 4's expander when it
      // collapses scaffold output to a page-name map.
      if (seenWithinDirective.has(t)) {
        accept(
          "error",
          `'scaffold ${s.selector}: ...' lists '${t}' more than once.`,
          { node: s, property: "targets" },
        );
      }
      seenWithinDirective.add(t);
    }
  }

  private checkPage(
    p: import("./generated/ast.js").Page,
    ui: import("./generated/ast.js").Ui,
    accept: ValidationAcceptor,
  ): void {
    void ui;
    // Property uniqueness (Rule 9 part) — at most one each of route,
    // title, requires, body, menu metadata.  Multiple `state {}`
    // blocks merge (per spec §6 — same posture as `permissions`).
    const seen = new Map<string, number>();
    for (const prop of p.props) {
      const key = prop.$type;
      if (key === "StateBlock") continue; // multiple allowed
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [key, count] of seen) {
      if (count > 1) {
        accept(
          "error",
          `Page '${p.name}' declares more than one '${pagePropDisplayName(key)}' property; keep just the first.`,
          { node: p, property: "name" },
        );
      }
    }

    // PageMenuMeta key names — only `section` / `label` / `order` /
    // `hidden` are recognised (parser accepts any LooseName via the
    // soft-keyword rule).
    const allowedMenuMetaKeys = new Set([
      "section",
      "label",
      "order",
      "hidden",
    ]);
    for (const prop of p.props) {
      if (prop.$type !== "PageMenuMeta") continue;
      for (const entry of prop.entries) {
        if (!allowedMenuMetaKeys.has(entry.name)) {
          accept(
            "error",
            `Unknown menu metadata key '${entry.name}' on page '${p.name}'.  Recognised keys: ${[
              ...allowedMenuMetaKeys,
            ].join(", ")}.`,
            { node: entry, property: "name" },
          );
        }
      }
    }
  }

  private checkMenuBlock(
    block: import("./generated/ast.js").MenuBlock,
    ui: import("./generated/ast.js").Ui,
    accept: ValidationAcceptor,
  ): void {
    // Rule 8 — every page-link in a menu block must reference a page
    // in the SAME ui.  The grammar's `[Page:ID]` cross-reference
    // resolves globally; we additionally check the resolved page's
    // container.
    const pagesInThisUi = new Set(
      ui.members
        .filter((m) => m.$type === "Page")
        .map((m) => (m as import("./generated/ast.js").Page).name),
    );
    for (const section of block.sections) {
      for (const link of section.links) {
        // Slice 6: page links carry a bare name (not a cross-
        // reference) because scaffold-synthesised pages don't
        // exist at AST link time.  We resolve against the ui's
        // explicit pages here; scaffold-synthesised page names
        // are validated post-IR by `validateLoomModel`.
        const targetName = link.pageName;
        if (targetName && !pagesInThisUi.has(targetName)) {
          // Could still be a scaffold-synthesised name — defer
          // the strict check to the IR-level validator which sees
          // the post-expansion page set.  We only flag here if
          // the ui has no scaffold directives at all (so a name
          // that isn't an explicit page can't possibly resolve).
          if (ui.members.every((m) => m.$type !== "Scaffold")) {
            accept(
              "error",
              `'link ${targetName}' references no page in ui '${ui.name}'.  Pages declared in other ui blocks aren't visible from this menu.`,
              { node: link, property: "pageName" },
            );
          }
        }
        // MenuLinkProp key names — only `label` / `order` recognised.
        const allowedLinkKeys = new Set(["label", "order"]);
        for (const prop of link.props ?? []) {
          if (!allowedLinkKeys.has(prop.name)) {
            accept(
              "error",
              `Unknown menu link property '${prop.name}'.  Recognised: ${[
                ...allowedLinkKeys,
              ].join(", ")}.`,
              { node: prop, property: "name" },
            );
          }
        }
      }
    }
  }
}

// Map of PageProp $type names back to the source-side property name
// for diagnostics.  Used by `checkPage`'s duplicate-property message.
function pagePropDisplayName(typeName: string): string {
  switch (typeName) {
    case "RouteProp":
      return "route";
    case "TitleProp":
      return "title";
    case "RequiresProp":
      return "requires";
    case "BodyProp":
      return "body";
    case "PageMenuMeta":
      return "menu";
    default:
      return typeName;
  }
}

function singular(selector: string): string {
  switch (selector) {
    case "modules":
      return "module";
    case "contexts":
      return "context";
    case "aggregates":
      return "aggregate";
    case "workflows":
      return "workflow";
    case "views":
      return "view";
    default:
      return selector;
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
