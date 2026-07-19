import * as path from "node:path";
import { AstUtils, type LangiumDocument, URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { STDLIB_LAYOUT_COMPONENTS } from "../../src/generator/react/body-walker.js";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import { type Model, reflection } from "../../src/language/generated/ast.js";
import { repoRoot } from "../_helpers/examples.js";
import { extractErrors } from "../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Conformance completeness guard for `examples/showcase.ddd`.
//
// `showcase.ddd` is the dedicated fixture meant to exercise EVERY language
// feature so the cross-generator harness has one system that touches the
// whole surface.  This guard measures coverage against two real registries:
//
//   1. Every concrete AST node kind  — `reflection.getAllTypes()` minus the
//      abstract union supertypes (which are never emitted as a `$type`).
//   2. Every React walker UI primitive — `STDLIB_LAYOUT_COMPONENTS`.
//
// HARD GATE (enabled).  The showcase now exercises every instantiable AST
// kind and every walker primitive, so missing coverage is a hard error — a
// new grammar rule / walker primitive must be added to showcase.ddd (or, if
// genuinely unreachable from `.ddd`, to ALLOWLIST with a reason).  The handful
// of unreachable kinds are allowlisted below.
// ---------------------------------------------------------------------------

const HARD_GATE = true;

const SHOWCASE = "examples/showcase.ddd";

/**
 * Abstract union supertypes in the grammar — declared as `X: A | B | ...`,
 * never instantiated, so they never appear as a concrete `node.$type`.
 * They must be excluded from the "every kind appears" check or it can never
 * pass.
 *
 * DERIVED, not hand-maintained: a type is an abstract supertype iff
 * `reflection.getAllSubTypes(t)` lists a member other than `t` itself (the
 * call always includes `t`).  The previous hand-list rotted — it was missing
 * 11 real unions (ConfigValue, ConnectionSource, AuthConfigValue,
 * MacroArgValue, StoreDecl, AreaMember, CapabilityMember, WorkflowMember,
 * LayoutSlot, ViewSource, PostfixSuffix), so those were "required" yet can
 * never appear as a concrete `$type`, making HARD_GATE permanently
 * unreachable (BUG-002).  Deriving it means new grammar unions are excluded
 * automatically.
 */
function abstractSupertypes(): Set<string> {
  const s = new Set<string>();
  for (const t of reflection.getAllTypes()) {
    if (reflection.getAllSubTypes(t).some((x) => x !== t)) s.add(t);
  }
  return s;
}

/**
 * Reference-only concrete interfaces that the parser never emits as a `$type`
 * (they exist solely as cross-reference / property types, and reflection
 * exposes no subtypes for them so the derivation above can't catch them).
 * Kept as a tiny explicit residual.
 */
const REFERENCE_ONLY = new Set<string>(["LValue", "NamedType"]);

const UNION_SUPERTYPES = new Set<string>([...abstractSupertypes(), ...REFERENCE_ONLY]);

/**
 * Concrete AST kinds intentionally excluded from the coverage requirement —
 * legacy/deprecated forms or kinds mutually exclusive with one already
 * present.  Each entry needs a justifying comment.  Seeded empty; populated
 * as the first guard runs reveal genuinely uncoverable kinds.
 */
const ALLOWLIST = new Set<string>([
  // No stdlib macro declares a `string` / `int` parameter, and macros cannot
  // be defined in `.ddd` source — so these two macro-argument kinds are
  // unreachable from ANY `.ddd` fixture (only `bool` / `ref` / `refList`
  // macro params exist: crudish(updateOnly:), scaffold(subdomains:),
  // scaffoldView(of:), all exercised in showcase.ddd). Unreachable by
  // construction, not a coverage gap.
  "MacroArgString",
  "MacroArgInt",
  // showcase.ddd is the single-file cross-generator conformance fixture; an
  // `import` would make it a multi-file project (a second partial file in
  // examples/ that standalone-generate matrices would choke on, plus the
  // isolated `build([showcase])` here wouldn't resolve it). Multi-file imports
  // are covered by web/src/examples/multifile-*.ddd instead.
  "ImportStmt",
  // `tenancy by` is whole-system: it imposes the explicit-stance rule on EVERY
  // aggregate (loom.tenancy-stance-unmarked is an error) and AND-s a per-tenant
  // filter into every generated read — wiring it into showcase.ddd would
  // change the semantics of every conformance dimension rather than add one.
  // Tenancy is covered by its dedicated corpus fixtures
  // (test/fixtures/corpus/tenancy-owned.ddd + tenancy-filter.ddd) instead.
  // Tenancy-izing the showcase is a deliberate follow-up, not a drive-by
  // (docs/old/plans/multi-tenancy-implementation.md).
  "TenancyDecl",
  // Projections are MID-FLIGHT (v1 slice 2 landed the Hono runtime only —
  // #1732); the other four backends don't consume them yet, and showcase.ddd
  // feeds every cross-backend matrix, so exercising `projection` here would
  // trip the unsupported-platform paths rather than add a conformance
  // dimension. The projection work owns removing these two entries when the
  // feature is showcase-ready (this allowlisting unbroke main after the
  // grammar kinds landed without showcase coverage — a cross-PR semantic
  // conflict this HARD_GATE is designed to surface).
  "Projection",
  "ProjectionOn",
  // The query-time projection comprehension (read-path-architecture.md rev.13,
  // § "projection generalises") — `join <Agg> as <c> on <idRef>` follows and
  // `select <field> = <expr>` projections.  Surface + IR + validation only:
  // a query-time / `join` projection is HONESTLY rejected
  // (`loom.projection-query-time-unsupported`) until a backend ports the emit,
  // so putting one in showcase.ddd (which feeds every cross-backend matrix)
  // would trip that gate rather than add a conformance dimension.  The
  // query-time emit slice owns removing these two entries when it lands (same
  // cross-PR pattern as `Projection` above).
  "ProjectionJoin",
  "ProjectionSelect",
  // `policy {}` (+ its `PolicyReadRule` rows) is the tenant read-reachability
  // ladder (multi-tenancy Phase 2 P2.4): it only validates on a `tenancy by`
  // system with `tenantOwned` aggregates (`deep`/`global` also need an
  // `implements tenantRegistry` hierarchy).  Adding it to showcase.ddd would
  // require tenancy-izing the whole fixture — the same reason `TenancyDecl` is
  // excluded above.  Covered by test/ir/policy-read-levels.test.ts +
  // test/generator/policy-deep-scope.test.ts instead.
  "PolicyDecl",
  "PolicyReadRule",
  // The explicit application/transport layer (unfoldable-api-derivation.md) —
  // `commandHandler`/`queryHandler` context members and `route <M> <P> ->
  // Context.Handler` api bindings. This is the GRAMMAR+IR slice only: the nodes
  // ride alongside `ApiIR`/`BoundedContextIR` and no backend reads them yet, so
  // exercising them in showcase.ddd would add zero conformance dimension while
  // the `scaffoldApi(...)` scaffold + per-backend route/handler emission are
  // still unbuilt. The codegen slice owns removing these four entries when the
  // feature is showcase-ready (same cross-PR pattern as `Projection` above).
  "CommandHandler",
  "QueryHandler",
  "Route",
  "HandlerRef",
]);

async function buildShowcase(): Promise<LangiumDocument<Model>> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, SHOWCASE)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc as LangiumDocument<Model>;
}

/** Names of every walker primitive / component invoked anywhere in the model.
 *  A UI element invocation (`Avatar { "P" }`, `Tabs { … }`) parses as a
 *  `BuilderCall` whose `type` IS the primitive name — that is what the walker
 *  dispatches on, so coverage must read `BuilderCall.type`.  (We also collect
 *  every `name` string for decls/components referenced by bare name.)  An
 *  earlier version collected only `node.name`, which `BuilderCall` does not
 *  carry — so it reported every primitive as uncovered even when used. */
function invokedNames(model: Model): Set<string> {
  const names = new Set<string>();
  for (const node of AstUtils.streamAst(model)) {
    const n = node as { $type: string; name?: unknown; type?: unknown };
    if (n.$type === "BuilderCall" && typeof n.type === "string") names.add(n.type);
    if (typeof n.name === "string") names.add(n.name);
  }
  return names;
}

/** Walker primitives that are React-only today, so they must NOT appear in
 *  `showcase.ddd` — which feeds the cross-frontend render matrix
 *  (`frontend-showcase-render.test.ts`) that drives the SAME source through
 *  Vue / Svelte / Angular. A React-only primitive there would fail-fast on a
 *  missing pack template. Excluded from the walker-primitive coverage gate
 *  until it's backfilled across the other frontends and can join the shared
 *  fixture.
 *    - FileUpload: no HEEx renderer yet (renders on all 4 JSX frontends after
 *      4b). Kept out of `showcase.ddd` because `frontend-showcase-render` drives
 *      showcase through HEEx too, which can't render it (KNOWN_HEEX_GAPS). */
const REACT_ONLY_PRIMITIVES: ReadonlySet<string> = new Set(["FileUpload"]);

describe("conformance: showcase.ddd completeness", () => {
  it(`parses and validates ${SHOWCASE} with no errors`, async () => {
    const doc = await buildShowcase();
    const errors = extractErrors(doc.diagnostics);
    expect(errors, `validation errors in ${SHOWCASE}:\n${errors.join("\n")}`).toEqual([]);
  });

  // Langium validation (above) does not catch IR-level rules that
  // `generate system` enforces (extern-body shape, required create fields,
  // nullable finds in workflows, e2e target resolution).  Run the same
  // lower → enrich → validate pipeline the CLI runs so an ungenerable
  // fixture can't pass the guard.
  it(`lowers and IR-validates ${SHOWCASE} with no errors (generation gate)`, async () => {
    const doc = await buildShowcase();
    const loom = enrichLoomModel(lowerModel(doc.parseResult.value));
    const errors = validateLoomModel(loom)
      .filter((d) => d.severity === "error")
      .map((d) => `${d.source}: ${d.message}`);
    expect(errors, `IR-level errors in ${SHOWCASE} (these block \`generate system\`)`).toEqual([]);
  });

  it("reports AST-node-kind coverage", async () => {
    const doc = await buildShowcase();
    const model = doc.parseResult.value;

    const seen = new Set<string>([model.$type]);
    for (const node of AstUtils.streamAst(model)) seen.add(node.$type);

    const required = reflection
      .getAllTypes()
      .filter((t) => !UNION_SUPERTYPES.has(t) && !ALLOWLIST.has(t));
    const missing = required.filter((t) => !seen.has(t)).sort();

    if (missing.length > 0) {
      console.warn(
        `[showcase coverage] ${missing.length}/${required.length} AST kinds uncovered:\n  ` +
          missing.join("\n  "),
      );
    } else {
      console.info(`[showcase coverage] all ${required.length} AST kinds covered.`);
    }

    if (HARD_GATE) {
      expect(missing, "AST node kinds not exercised by showcase.ddd").toEqual([]);
    }
  });

  it("reports walker-primitive coverage", async () => {
    const doc = await buildShowcase();
    const model = doc.parseResult.value;

    const used = invokedNames(model);
    const primitives = [...STDLIB_LAYOUT_COMPONENTS]
      .filter((p) => !REACT_ONLY_PRIMITIVES.has(p))
      .sort();
    const missing = primitives.filter((p) => !used.has(p));

    if (missing.length > 0) {
      console.warn(
        `[showcase coverage] ${missing.length}/${primitives.length} walker primitives uncovered:\n  ` +
          missing.join("\n  "),
      );
    } else {
      console.info(`[showcase coverage] all ${primitives.length} walker primitives covered.`);
    }

    if (HARD_GATE) {
      expect(missing, "walker primitives not exercised by showcase.ddd").toEqual([]);
    }
  });
});
