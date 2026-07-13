// Validator dispatcher.  The previous monolith (~2541 LOC, 39
// check* methods) has been split into themed modules under
// `src/language/validators/`; this file is now a thin orchestrator
// that wires Langium's ValidationRegistry to those modules.
//
// See `src/language/validators/index.ts` for the barrel of
// per-theme entry points.

import {
  type AstNode,
  isOperationCancelled,
  type ValidationAcceptor,
  type ValidationChecks,
} from "langium";
import type { DddServices } from "./ddd-module.js";
import type {
  Api,
  AuthBlock,
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
  checkActionTypePosition,
  checkAmbiguousPartRefs,
  checkAuthBlock,
  checkAvgProjection,
  checkBinaryOperands,
  checkBindableInputArgs,
  checkBuilderCallType,
  checkChannels,
  checkComponent,
  checkContext,
  checkCriteria,
  checkDataSource,
  checkDeployable,
  checkDuplicateNames,
  checkDurationConstructors,
  checkExpectMatcher,
  checkGenericCarriers,
  checkHandlerBodies,
  checkImageAltText,
  checkInheritance,
  checkIntrinsicCalls,
  checkLayout,
  checkLegacyConstructorCalls,
  checkMacroExpansion,
  checkMatchExpressions,
  checkMatcherArity,
  checkMatchesCalls,
  checkOrgPathReferences,
  checkPayloads,
  checkPolicyFns,
  checkPrimitiveConversions,
  checkProjectSingletons,
  checkRetrievalLiteral,
  checkSeeds,
  checkSelfType,
  checkSlotMemberAccess,
  checkSlotTypePosition,
  checkTemplateHoles,
  checkTenancyDecls,
  checkTernaryExprs,
  checkTheme,
  checkThemeContrast,
  checkTopLevelDomainComposition,
  checkTopLevelFunctions,
  checkTraceability,
  checkTypeReferences,
  checkUi,
  checkUnions,
  checkUnknownMemberAccess,
  checkUnknownNameRefs,
} from "./validators/index.js";

/** Collapse whitespace/newlines so an error message stays one line
 *  inside a diagnostic. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Per-theme fault-isolation guard (remediation finding 21).
 *
 * Runs a single themed check family (`fn`).  On a thrown error it:
 *   1. converts the throw into ONE `error` diagnostic on `node` naming the
 *      failed family and noting that the remaining checks still ran, and
 *   2. logs the full stack via `console.error` for debugging.
 * Then it returns so the dispatcher proceeds with the next family — one
 * crash costs one check family, not every diagnostic for the document.
 *
 * `console.error` is used bare (no Node-only APIs) so the validator stays
 * browser-safe for `src/api/` and the playground (EmptyFileSystem path).
 *
 * Langium's own cancellation signal (`OperationCancelled`) is re-thrown
 * untouched so validation cancellation continues to propagate — the guard
 * only swallows genuine check faults, never control-flow exceptions.
 */
export function runChecked(
  name: string,
  node: AstNode,
  accept: ValidationAcceptor,
  fn: () => void,
): void {
  try {
    fn();
  } catch (err) {
    if (isOperationCancelled(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    accept(
      "error",
      `Validator check '${name}' crashed and was skipped; the remaining checks still ran. (${oneLine(message)})`,
      { node, code: "loom.validator-check-crashed" },
    );
    console.error(`[loom] validator check '${name}' threw:`, err);
  }
}

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
   *  walk per top-level member that delegates to the themed checks.
   *
   *  Every themed `check*` invocation runs inside `runChecked` so a
   *  throw in one family is isolated to a single diagnostic and the
   *  remaining families still run (finding 21). */
  check(model: Model, accept: ValidationAcceptor): void {
    const guard = (name: string, node: AstNode, fn: () => void): void =>
      runChecked(name, node, accept, fn);
    // Macro-expansion diagnostics — drained from the side channel
    // populated by `src/macros/expander.ts` during the pre-link
    // pass.  Surfaced here so unknown macros, bad args, and
    // composition collisions show up alongside other validator
    // diagnostics rather than in a separate diagnostic pipeline.
    guard("macro-expansion", model, () => checkMacroExpansion(model, accept, this.services));
    // Validate every `string.matches(regex)` call's
    // argument is a string literal that compiles as a RegExp.
    // Walks the entire AST so the rule applies in invariants,
    // preconditions, derived bodies, function bodies, and guards
    // alike — anywhere the operator can appear.
    guard("matches-calls", model, () => checkMatchesCalls(model, accept));
    // An anonymous retrieval literal's `where:` must be a criterion reference
    // (criterion.md, use site 3).
    guard("retrieval-literal", model, () => checkRetrievalLiteral(model, accept));
    // Test-assertion matchers (`toBe`/`toHaveText`/…) are a known builtin
    // surface — enforce their fixed argument arity.
    guard("matcher-arity", model, () => checkMatcherArity(model, accept));
    // Assertions are method-based: every `expect(...)` must end in a matcher
    // (no bare boolean), and `toThrow`'s optional status arg is e2e-only.
    guard("expect-matcher", model, () => checkExpectMatcher(model, accept));
    // Match expressions: warn on a missing `else` arm.
    // Type-checking arm conditions is best-effort here (the lowering's
    // type system is the source of truth); structural checks run
    // unconditionally.
    guard("match-expressions", model, () => checkMatchExpressions(model, accept));
    // v2 hard cut: reject pre-v2 surfaces that have a builder-call replacement.
    // `Money(10, "USD")` → `Money { amount: 10, currency: "USD" }`,
    // `OrderLine(...)` (entity part) → `OrderLine { ... }`.
    guard("legacy-constructor-calls", model, () => checkLegacyConstructorCalls(model, accept));
    // BuilderCall.type is a bare string (not a Langium cross-reference),
    // so typos like `Mony { ... }` pass parsing & linking silently.  The
    // validator resolves the type name against the available builder
    // targets (VO / EntityPart / user-component / walker primitive) and
    // errors on misses.
    guard("builder-call-type", model, () => checkBuilderCallType(model, accept, this.services));
    // A bindable input (`Field`/`Toggle`/…) wires to page state via `bind:`;
    // `value:` is silently ignored by the walker — warn and suggest `bind:`.
    guard("bindable-input-args", model, () => checkBindableInputArgs(model, accept));
    // Accessibility: an `Image`/`Avatar` rendering an image needs a text
    // alternative (`alt:` or `decorative: true`).  Alt text is human content
    // Loom can't derive — a missing alt fails WCAG 1.1.1 (accessibility.md).
    guard("a11y-missing-alt", model, () => checkImageAltText(model, accept));
    // Accessibility: a user `theme {}` colour whose fill shade leaves no
    // readable text colour can't produce a WCAG-AA app — warn at compile time
    // (accessibility.md, `loom.a11y-theme-contrast`).
    guard("a11y-theme-contrast", model, () => checkThemeContrast(model, accept));
    // Project composition: a top-level `subdomain` (declared outside any
    // `system { }`) folds into the project's single system — enforce that
    // exactly one system exists across the import graph.  See
    // docs/old/proposals/implicit-system-composition.md.
    guard("top-level-domain-composition", model, () =>
      checkTopLevelDomainComposition(model, accept, this.services),
    );
    // A composed project (single system) admits at most one `user` / `theme`
    // block, wherever in the import graph they're written.
    guard("project-singletons", model, () => checkProjectSingletons(model, accept, this.services));
    // `component` declarations: enforce the extern↔body exclusivity the
    // grammar admits but can't constrain (extern ⇒ no body; normal ⇒ body).
    guard("component", model, () => checkComponent(model, accept));
    // Traceability artifacts.  The grammar admits a
    // permissive requirement prop-bag and any code cross-reference;
    // semantic constraints (allowed keys / enum values / required
    // props / parent acyclicity) are enforced here.
    guard("traceability", model, () => checkTraceability(model, accept));
    // Type-position references: bare aggregate name (must be `X id`),
    // and cross-aggregate entity-part name (must go through the root).
    guard("type-references", model, () => checkTypeReferences(model, accept));
    // Duplicate-name family (finding 10): sibling aggregate / value-object /
    // event / enum names per context; property / derived / containment field
    // names per aggregate / value-object / event; operation / function /
    // create / destroy param names; enum values.  Without it a duplicate
    // silently replaces / retypes the first.
    guard("duplicate-names", model, () => checkDuplicateNames(model, accept));
    // Ambiguous entity-part `X id` link: two aggregates declaring an
    // `entity <Name>` make a bare `Name id` resolve to an arbitrary one via
    // the global scope — report the ambiguity at the reference site.
    guard("ambiguous-part-ref", model, () => checkAmbiguousPartRefs(model, accept));
    // Aggregate-inheritance surface (aggregate-inheritance.md, I1):
    // `extends` may only target an `abstract` base; abstract bases have no
    // repository and declare no lifecycle actions; `inheritanceUsing(…)` is
    // only valid on a participant; and an event-sourced / document concrete
    // of a `sharedTable` base is forced to `ownTable` (D-ES-TPH).
    guard("inheritance", model, () => checkInheritance(model, accept));
    // Payload declarations (payload-transport-layer.md, P1): name
    // uniqueness within a context (and vs. value objects / events) and
    // distinct non-empty field names.
    guard("payloads", model, () => checkPayloads(model, accept));
    // Generic-carrier instantiation (payload-transport-layer.md, P3):
    // the single type argument of `paged` / `envelope` must be a carrier,
    // v1 admits only single-level (non-nested) instantiation, and a carrier
    // may appear only in a transport position (find return / payload field).
    guard("generic-carriers", model, () => checkGenericCarriers(model, accept));
    // `Self id` (typed-capabilities.md) is only valid inside a `capability`.
    guard("self-type", model, () => checkSelfType(model, accept));
    // Discriminated unions (payload-transport-layer.md, P4): anonymous
    // `A or B` and named `payload Foo = A | B` variant sets must be distinct
    // (unambiguous wire discriminator) and carrier-typed (no `slot` variant).
    guard("unions", model, () => checkUnions(model, accept));
    // Seed datasets (database-seeding.md): a seed may only populate
    // aggregates of its own context, and a record may not repeat a field.
    guard("seeds", model, () => checkSeeds(model, accept));
    // `slot` is a UI-only param marker (PR #632) — reject anywhere
    // outside a component's parameter list with a clear error rather
    // than letting the backend emitter throw at generate time.
    guard("slot-type-position", model, () => checkSlotTypePosition(model, accept));
    // `action` is `slot`'s function-valued sibling (Tier 2) — same
    // position rule, plus no nested UI-marker as the callback arg.
    guard("action-type-position", model, () => checkActionTypePosition(model, accept));
    // Binary operand compatibility: every binary expression's
    // operands must agree with the operator's semantics.
    // Arithmetic uses `arithmeticResult` (numeric widening, closed
    // money rules, string concat); comparison uses `comparable`
    // (same type / numeric-chain / money / optional-unwrap);
    // logical requires bool.  Replaces the per-feature suppression
    // pattern in `checkDerived` etc. — see the function's header
    // for the full rationale.
    guard("binary-operands", model, () => checkBinaryOperands(model, accept));
    // Ternary expressions (`cond ? a : b`): the condition must be `bool` and
    // the two branches must join (one assignable to the other, or a shared
    // numeric / optional / null supertype).  Without this a `string`
    // condition or two incompatible branches typecheck silently — `typeOf`
    // returns the join with no way to reject the ill-formed shape.
    guard("ternary-exprs", model, () => checkTernaryExprs(model, accept));
    // `avg(λ)` desugars to `sum/count` during lowering, so the IR validator
    // never sees it — gate the numeric-projection + UI-position rules here at
    // the AST level (loom.avg-non-numeric / loom.collection-op-in-ui).
    guard("avg-projection", model, () => checkAvgProjection(model, accept));
    // Slot member access: `heading.foo` on a `(heading: slot)` param
    // is meaningless — slots are opaque JSX, no addressable fields.
    // Emits a precise diagnostic at the member position instead of
    // letting the access cascade silently to `T.unknown`.
    guard("slot-member-access", model, () => checkSlotMemberAccess(model, accept));
    // Unknown member access: `order.totl` on an aggregate / value object /
    // event / payload receiver where no such member exists.  Without it the
    // typo cascades to `T.unknown` and every operand check on it is
    // suppressed — so the mistake produces no diagnostic at all.
    guard("unknown-member-access", model, () => checkUnknownMemberAccess(model, accept));
    // Scalar-intrinsic call-shape gate (src/util/intrinsics.ts): call form,
    // arity, positional-only args, argument primitive types.
    guard("intrinsic-calls", model, () => checkIntrinsicCalls(model, accept));
    // A5 duration constructors (days/hours/minutes): arity + int amount.
    guard("duration-constructors", model, () => checkDurationConstructors(model, accept));
    // A6 string-interpolation hole types (loom.interp-hole-type).
    guard("template-holes", model, () => checkTemplateHoles(model, accept));
    // Phase B top-level functions: block-form rejection + recursion cycle
    // (loom.function-toplevel-block / loom.function-recursive).
    guard("toplevel-functions", model, () => checkTopLevelFunctions(model, accept));
    // The `extern` ↔ body pairing on commandHandler / queryHandler
    // (loom.extern-handler-has-body / loom.handler-missing-body).
    guard("handler-bodies", model, () => checkHandlerBodies(model, accept));
    // Unresolved bare-identifier heads (`total := amout`, `let x = amout`):
    // a `NameRef` is not a cross-reference, so an unresolvable head types as
    // `T.unknown` and every downstream gate suppresses on it — the finding-1
    // hole `checkUnknownMemberAccess` only closes for member *suffixes*.
    // Restores the "`unknown` implies already-reported" invariant its
    // siblings assume.  Needs `services` for cross-file / workspace names.
    guard("unknown-name-refs", model, () => checkUnknownNameRefs(model, accept, this.services));
    // `currentUser.orgPath` (the derived tenant materialized path, P2.1) is
    // only meaningful under a `tenancy by` declaration — fail-closed otherwise.
    guard("orgpath-tenancy", model, () => checkOrgPathReferences(model, accept));
    // Primitive conversion expressions (`string(x)`, `money(d)`):
    // restrict to the infallible (source, target) pairs.  Fallible
    // parses (`int("42")`) and narrowing (`int(longValue)`) are
    // deferred until we settle the failure model (`T?` vs throw);
    // an explicit error keeps the surface honest in the meantime.
    guard("primitive-conversions", model, () => checkPrimitiveConversions(model, accept));
    // Criterion declarations + use sites: candidate-type support,
    // body purity, reference cycles, and call arity.
    guard("criteria", model, () => checkCriteria(model, accept));
    // Named policy functions (auth P3.2): return-type = bool, use-site arity,
    // reference cycles.  See `src/language/validators/policy-fn.ts`.
    guard("policy-fns", model, () => checkPolicyFns(model, accept));
    // Channel + channelSource: key-field existence and the channel<->storage
    // transport compatibility matrix (channels.md, Slice 1).
    guard("channels", model, () => checkChannels(model, accept));
    // Implicit composition (finding 23): when the project has exactly one
    // `system { }`, the deployment-shape members written at file top level
    // fold into it (implicit-system-composition.md).  They must run through
    // the SAME per-System check family as their nested siblings — otherwise a
    // `platform: react` deployable with no `ui:` (say) errors nested and
    // passes top-level.  Bare top-level `context` keeps its legacy loose
    // meaning and is checked by the `BoundedContext` arm below, so it is
    // excluded from the fold (folding it would double-check it).
    const FOLDABLE_TOP_LEVEL: ReadonlySet<string> = new Set([
      "Deployable",
      "Ui",
      "ThemeBlock",
      "AuthBlock",
      "Api",
      "Storage",
      "Resource",
      "Layout",
      "Subdomain",
    ]);
    const systemNodes = model.members.filter((mm) => mm.$type === "System");
    const topLevelFoldable =
      systemNodes.length === 1
        ? model.members.filter((mm) => FOLDABLE_TOP_LEVEL.has(mm.$type))
        : [];
    for (const m of model.members) {
      if (m.$type === "BoundedContext") {
        guard("context", m, () => checkContext(m, accept));
      } else if (m.$type === "System") {
        // The system's own members plus the top-level members that compose
        // into it (empty unless this is the project's single system).
        const sysMembers = [...m.members, ...topLevelFoldable];
        const deployables = sysMembers.filter((sm) => sm.$type === "Deployable");
        const themeBlocks = sysMembers.filter((sm) => sm.$type === "ThemeBlock") as ThemeBlock[];
        if (themeBlocks.length > 1) {
          for (const tb of themeBlocks.slice(1)) {
            accept(
              "error",
              `system '${m.name}' declares more than one 'theme { ... }' block; keep just the first.`,
              { node: tb },
            );
          }
        }
        for (const tb of themeBlocks) guard("theme", tb, () => checkTheme(tb, accept));
        // Auth block (D-AUTH-OIDC).  At most one `auth { … }` per
        // system; flag the extras, semantic-check the first.
        const authBlocks = sysMembers.filter((sm) => sm.$type === "AuthBlock") as AuthBlock[];
        if (authBlocks.length > 1) {
          for (const ab of authBlocks.slice(1)) {
            accept(
              "error",
              `system '${m.name}' declares more than one 'auth { ... }' block; keep just the first.`,
              { node: ab, code: "loom.duplicate-auth-block" },
            );
          }
        }
        for (const ab of authBlocks) guard("auth-block", ab, () => checkAuthBlock(ab, m, accept));
        // Tenancy declaration (multi-tenancy Phase 1a).  Duplicate +
        // claim-exists checks; the registry/stance checks need the merged
        // multi-file IR and live in the phase-⑦ tenancy checks.
        guard("tenancy-decls", m, () => checkTenancyDecls(m, accept));
        // Page metamodel.  Collect ui blocks first so per-
        // ui checks can see siblings (name uniqueness across uis), and
        // so per-deployable checks can cross-reference the system's
        // ui inventory.
        const uis = sysMembers.filter((sm) => sm.$type === "Ui") as Ui[];
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
        const apis = sysMembers.filter((sm) => sm.$type === "Api") as Api[];
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
          // `from <Subdomain>` is optional — an api may instead derive its
          // surface from a `with scaffoldApi(...)` macro or carry explicit
          // `route` bindings.  Only flag a `from` that was written but doesn't
          // resolve (source present, ref unresolved).
          if (api.source && !api.source.ref) {
            accept(
              "error",
              `api '${api.name}' references undeclared subdomain '${api.source.$refText}'.  Declare a 'subdomain ${api.source.$refText} { … }' at system scope first.`,
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
        const storages = sysMembers.filter((sm) => sm.$type === "Storage") as Storage[];
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
        const dataSources = sysMembers.filter((sm) => sm.$type === "Resource") as Resource[];
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
          guard("datasource", ds, () => checkDataSource(ds, accept));
        }

        for (const sm of sysMembers) {
          if (sm.$type === "Subdomain") {
            for (const ctx of sm.contexts) guard("context", ctx, () => checkContext(ctx, accept));
          } else if (sm.$type === "BoundedContext") {
            guard("context", sm, () => checkContext(sm, accept));
          } else if (sm.$type === "Deployable") {
            guard("deployable", sm, () =>
              checkDeployable(sm as Deployable, deployables as Deployable[], accept),
            );
          } else if (sm.$type === "Ui") {
            guard("ui", sm, () => checkUi(sm as Ui, m as System, accept));
          } else if (sm.$type === "Layout") {
            guard("layout", sm, () => checkLayout(sm, accept));
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
