// Validator dispatcher.  The previous monolith (~2541 LOC, 39
// check* methods) has been split into themed modules under
// `src/language/validators/`; this file is now a thin orchestrator
// that wires Langium's ValidationRegistry to those modules.
//
// See `src/language/validators/index.ts` for the barrel of
// per-theme entry points.

import type { ValidationAcceptor, ValidationChecks } from "langium";
import type { DddServices } from "./ddd-module.js";
import type {
  Api,
  DddAstType,
  Deployable,
  Model,
  Resource,
  Storage,
  System,
  ThemeBlock,
  Ui,
} from "./generated/ast.js";
import {
  checkBinaryOperands,
  checkBuilderCallType,
  checkContext,
  checkDataSource,
  checkDeployable,
  checkLayout,
  checkLegacyConstructorCalls,
  checkMacroExpansion,
  checkMatchExpressions,
  checkMatcherArity,
  checkMatchesCalls,
  checkPayloads,
  checkPrimitiveConversions,
  checkSlotMemberAccess,
  checkSlotTypePosition,
  checkTheme,
  checkTraceability,
  checkTypeReferences,
  checkUi,
  checkUiHelperImports,
} from "./validators/index.js";

export class DddValidator {
  /** Langium services — held so per-theme checks can reach the
   *  workspace-wide index (cross-document name resolution for
   *  surfaces like top-level components whose names aren't
   *  cross-references). */
  private readonly services: DddServices;

  constructor(services: DddServices) {
    this.services = services;
  }

  /** Entry: full model walk.  Dispatch order matches the pre-split
   *  monolith — model-level passes first (macro diagnostics, then
   *  match / matcher / builder / traceability / type references /
   *  binary operands / primitive conversions), then a structural
   *  walk per top-level member that delegates to the themed checks. */
  check(model: Model, accept: ValidationAcceptor): void {
    // Macro-expansion diagnostics — drained from the side channel
    // populated by `src/macros/expander.ts` during the pre-link
    // pass.  Surfaced here so unknown macros, bad args, and
    // composition collisions show up alongside other validator
    // diagnostics rather than in a separate diagnostic pipeline.
    checkMacroExpansion(model, accept);
    // Validate every `string.matches(regex)` call's
    // argument is a string literal that compiles as a RegExp.
    // Walks the entire AST so the rule applies in invariants,
    // preconditions, derived bodies, function bodies, and guards
    // alike — anywhere the operator can appear.
    checkMatchesCalls(model, accept);
    // Test-assertion matchers (`toBe`/`toHaveText`/…) are a known builtin
    // surface — enforce their fixed argument arity.
    checkMatcherArity(model, accept);
    // Match expressions: warn on a missing `else` arm.
    // Type-checking arm conditions is best-effort here (the lowering's
    // type system is the source of truth); structural checks run
    // unconditionally.
    checkMatchExpressions(model, accept);
    // v2 hard cut: reject pre-v2 surfaces that have a builder-call replacement.
    // `Money(10, "USD")` → `Money { amount: 10, currency: "USD" }`,
    // `OrderLine(...)` (entity part) → `OrderLine { ... }`.
    checkLegacyConstructorCalls(model, accept);
    // BuilderCall.type is a bare string (not a Langium cross-reference),
    // so typos like `Mony { ... }` pass parsing & linking silently.  The
    // validator resolves the type name against the available builder
    // targets (VO / EntityPart / user-component / walker primitive) and
    // errors on misses.
    checkBuilderCallType(model, accept, this.services);
    // `import helper <name> from "..."` declarations.
    // Reject names that shadow walker stdlib primitives so a typo
    // never silently overrides Stack / Form / etc.  Also flag
    // duplicate helper names within the same UI.
    checkUiHelperImports(model, accept);
    // Traceability artifacts.  The grammar admits a
    // permissive requirement prop-bag and any code cross-reference;
    // semantic constraints (allowed keys / enum values / required
    // props / parent acyclicity) are enforced here.
    checkTraceability(model, accept);
    // Type-position references: bare aggregate name (must be `X id`),
    // and cross-aggregate entity-part name (must go through the root).
    checkTypeReferences(model, accept);
    // Payload declarations (payload-transport-layer.md, P1): name
    // uniqueness within a context (and vs. value objects / events) and
    // distinct non-empty field names.
    checkPayloads(model, accept);
    // `slot` is a UI-only param marker (PR #632) — reject anywhere
    // outside a component's parameter list with a clear error rather
    // than letting the backend emitter throw at generate time.
    checkSlotTypePosition(model, accept);
    // Binary operand compatibility: every binary expression's
    // operands must agree with the operator's semantics.
    // Arithmetic uses `arithmeticResult` (numeric widening, closed
    // money rules, string concat); comparison uses `comparable`
    // (same type / numeric-chain / money / optional-unwrap);
    // logical requires bool.  Replaces the per-feature suppression
    // pattern in `checkDerived` etc. — see the function's header
    // for the full rationale.
    checkBinaryOperands(model, accept);
    // Slot member access: `heading.foo` on a `(heading: slot)` param
    // is meaningless — slots are opaque JSX, no addressable fields.
    // Emits a precise diagnostic at the member position instead of
    // letting the access cascade silently to `T.unknown`.
    checkSlotMemberAccess(model, accept);
    // Primitive conversion expressions (`string(x)`, `money(d)`):
    // restrict to the infallible (source, target) pairs.  Fallible
    // parses (`int("42")`) and narrowing (`int(longValue)`) are
    // deferred until we settle the failure model (`T?` vs throw);
    // an explicit error keeps the surface honest in the meantime.
    checkPrimitiveConversions(model, accept);
    for (const m of model.members) {
      if (m.$type === "BoundedContext") {
        checkContext(m, accept);
      } else if (m.$type === "System") {
        const deployables = m.members.filter((sm) => sm.$type === "Deployable");
        const themeBlocks = m.members.filter((sm) => sm.$type === "ThemeBlock") as ThemeBlock[];
        if (themeBlocks.length > 1) {
          for (const tb of themeBlocks.slice(1)) {
            accept(
              "error",
              `system '${m.name}' declares more than one 'theme { ... }' block; keep just the first.`,
              { node: tb },
            );
          }
        }
        for (const tb of themeBlocks) checkTheme(tb, accept);
        // Page metamodel.  Collect ui blocks first so per-
        // ui checks can see siblings (name uniqueness across uis), and
        // so per-deployable checks can cross-reference the system's
        // ui inventory.
        const uis = m.members.filter((sm) => sm.$type === "Ui") as Ui[];
        const uiNamesSeen = new Map<string, Ui>();
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

        // Api declaration checks.
        //   - Names unique within the system (`api SalesApi from …` declared twice).
        //   - Source module cross-ref must resolve.
        const apis = m.members.filter((sm) => sm.$type === "Api") as Api[];
        const apiNamesSeen = new Map<string, Api>();
        for (const api of apis) {
          const prior = apiNamesSeen.get(api.name);
          if (prior) {
            accept(
              "error",
              `Duplicate api '${api.name}'; api names must be unique within a system.`,
              { node: api, property: "name" },
            );
          } else {
            apiNamesSeen.set(api.name, api);
          }
          if (!api.source?.ref) {
            accept(
              "error",
              `api '${api.name}' references undeclared subdomain '${api.source?.$refText ?? "<missing>"}'.  Declare a 'subdomain ${api.source?.$refText ?? "<Name>"} { … }' at system scope first.`,
              { node: api, property: "source" },
            );
          }
        }
        // urlStyle conflict: a subdomain surfaced by two apis with
        // different `urlStyle` makes its aggregates' route slugs
        // ambiguous.  Enrichment takes the first-declared style; warn on
        // the rest so the conflict is visible (D-URLSTYLE).
        const urlStyleBySubdomain = new Map<string, "literal" | "resource">();
        for (const api of apis) {
          const sub = api.source?.$refText;
          if (!sub) continue;
          const style: "literal" | "resource" =
            api.urlStyle === "resource" ? "resource" : "literal";
          const prior = urlStyleBySubdomain.get(sub);
          if (prior === undefined) {
            urlStyleBySubdomain.set(sub, style);
          } else if (prior !== style) {
            accept(
              "warning",
              `api '${api.name}' sets urlStyle '${style}' on subdomain '${sub}', which another api already surfaces as '${prior}'.  The first-declared style ('${prior}') wins; route slugs use it.`,
              { node: api, property: "urlStyle", code: "loom.subdomain-conflicting-urlstyle" },
            );
          }
        }

        // Storage declaration checks.
        //   - Names unique within the system.
        //   - Type is one of the v0 enum values (parser ensures shape;
        //     this is a structural sanity-check + future hook for
        //     cross-platform constraints).
        const storages = m.members.filter((sm) => sm.$type === "Storage") as Storage[];
        const storageNamesSeen = new Map<string, Storage>();
        for (const s of storages) {
          const prior = storageNamesSeen.get(s.name);
          if (prior) {
            accept(
              "error",
              `Duplicate storage '${s.name}'; storage names must be unique within a system.`,
              { node: s, property: "name" },
            );
          } else {
            storageNamesSeen.set(s.name, s);
          }
        }

        // DataSource declaration checks.
        //   - Names unique within the system.
        //   - kind ↔ storage.type compatibility (e.g. kind: cache
        //     requires redis or inMemory).
        //   - per-kind config knobs (ttl, every/retain, isolation-
        //     Level) match the declared kind.
        //   - storage-shaped knobs (schema, tablePrefix, keyPrefix)
        //     match the resolved storage's type.
        // See `src/language/validators/datasource.ts`.
        const dataSources = m.members.filter((sm) => sm.$type === "Resource") as Resource[];
        const dataSourceNamesSeen = new Map<string, Resource>();
        for (const ds of dataSources) {
          const prior = dataSourceNamesSeen.get(ds.name);
          if (prior) {
            accept(
              "error",
              `Duplicate resource '${ds.name}'; resource names must be unique within a system.`,
              { node: ds, property: "name" },
            );
          } else {
            dataSourceNamesSeen.set(ds.name, ds);
          }
          checkDataSource(ds, accept);
        }

        for (const sm of m.members) {
          if (sm.$type === "Subdomain") {
            for (const ctx of sm.contexts) checkContext(ctx, accept);
          } else if (sm.$type === "BoundedContext") {
            checkContext(sm, accept);
          } else if (sm.$type === "Deployable") {
            checkDeployable(sm as Deployable, deployables as Deployable[], accept);
          } else if (sm.$type === "Ui") {
            checkUi(sm as Ui, m as System, accept);
          } else if (sm.$type === "Layout") {
            checkLayout(sm, accept);
          }
        }
      }
    }
  }
}

export function registerValidationChecks(services: DddServices): void {
  const registry = services.validation.ValidationRegistry;
  const validator = services.validation.DddValidator;
  const checks: ValidationChecks<DddAstType> = {
    Model: validator.check.bind(validator),
  };
  registry.register(checks, validator);
}
