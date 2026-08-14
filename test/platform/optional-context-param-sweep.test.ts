// ---------------------------------------------------------------------------
// The optional-context-parameter silent-failure ratchet.
//
// THE CLASS.  A shared cross-backend core takes a context / resolver /
// override-map as an OPTIONAL parameter; a call site omits it, or a merge drops
// it; there is NO type error, because the parameter is optional and `undefined`
// reads exactly like "nothing declared"; and the output silently degrades to a
// plausible-but-wrong default — a literal where a resolved value belonged, an
// unqualified schema where a per-context one belonged, an unscoped read where a
// scoped one belonged.  Because every backend consumes the same core, ONE such
// omission is wrong on all five at once, and no cross-backend gate sees it (a
// differential compares backends to each other; a wire golden compares each to
// an oracle — neither compares a backend's own emitters to the value they
// *should* have resolved).
//
// Two confirmed instances motivated this sweep:
//   #2511  `findErrorStatuses` threaded the `httpStatus` override resolver into
//          the operation/create/destroy arms but OMITTED it on all three `find`
//          arms.  With no override declared the resolved value EQUALS the
//          literal, so every backend silently emitted hardcoded statuses and no
//          test could tell a resolved 403 from a hardcoded one.
//   M-T9.25 `mergeContexts` never carried `structuralErrorStatuses` /
//          `errorStatusOverrides`, so every emitter fed a merged context read
//          `undefined` and every override no-opped on that path.
//
// The MERGE half of the class (a field-by-field reconstruction dropping an
// optional field) is ratcheted by `test/ir/ir-merge-completeness.test.ts`.
// THIS gate ratchets the PARAMETER half: every context-shaped optional
// parameter in the shared cores must be on a reviewed allowlist with a reason,
// so a NEW one is a decision someone made on purpose — the same shape as
// `allowlist-ratchet` / `walker-stdlib-completeness` / the merge gate.
//
// Source-text (AST) scanning, not type reflection — TS types don't survive to
// runtime.  It fails CLOSED: a parameter it cannot classify shows up as a new
// unlisted entry, not as covered.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** The shared cross-backend cores.  A helper here is consumed by several
 *  backends at once, so a silent-degrading optional parameter is wrong on all
 *  of them simultaneously — which is the whole reason this class is worth a
 *  gate.  (Per-backend `src/generator/<backend>/` dirs are out of scope: an
 *  omission there is one backend's bug, caught by that backend's own tests.) */
const CORE_DIRS = [
  "src/generator/_expr",
  "src/generator/_walker",
  "src/generator/_workflow",
  "src/generator/_type",
  "src/generator/_payload",
  "src/generator/_persistence",
  "src/generator/_obs",
  "src/generator/_i18n",
  "src/generator/_trace",
  "src/generator/_adapters",
  "src/generator/_frontend",
  "src/ir/enrich",
  "src/ir/util",
  "src/system",
];

/** A parameter is "context-shaped" when omitting it would silently change
 *  EMITTED OUTPUT rather than merely turn a feature off — i.e. it carries
 *  cross-cutting resolution the core would otherwise fall back to a default
 *  for.  Two syntactic tells capture the class precisely:
 *   1. its type is a named resolver / override / context type — an identifier
 *      ending in one of these words; or
 *   2. its type is a bare function type (a resolver passed inline).
 *  This deliberately EXCLUDES the benign optional lookups (`ReadonlyMap<…>` /
 *  `ReadonlySet<…>` "is this name in scope here" params on `walkBody`, whose
 *  empty default correctly means "not present in this context"), which are not
 *  the silent-degradation shape. */
const CONTEXT_TYPE_NAME = /(Context|Ctx|Resolver|Overrides?|Statuses|Stance|Lookup)$/;

interface Candidate {
  /** `<relpath>::<fn>::<param>` — the allowlist key. */
  readonly key: string;
  readonly file: string;
  readonly fn: string;
  readonly param: string;
  readonly type: string;
}

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkTsFiles(p, acc);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

function fnNameOf(node: ts.Node, sf: ts.SourceFile): string {
  const named = node as ts.FunctionDeclaration;
  if (named.name && ts.isIdentifier(named.name)) return named.name.text;
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  return `<anon@${line}>`;
}

function isContextShaped(p: ts.ParameterDeclaration): boolean {
  const t = p.type;
  if (!t) return false;
  if (ts.isFunctionTypeNode(t)) return true;
  if (ts.isTypeReferenceNode(t)) return CONTEXT_TYPE_NAME.test(t.typeName.getText());
  return false;
}

/** Enumerate every context-shaped OPTIONAL parameter (a `?` token or a default
 *  initializer) across the shared cores. */
function census(): Candidate[] {
  const out: Candidate[] = [];
  for (const dir of CORE_DIRS) {
    for (const file of walkTsFiles(join(root, dir))) {
      const src = readFileSync(file, "utf8");
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
      const rel = file.slice(root.length);
      const visit = (node: ts.Node): void => {
        if (
          ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node)
        ) {
          for (const p of node.parameters) {
            const optional = !!p.questionToken || !!p.initializer;
            if (!optional || !isContextShaped(p)) continue;
            const fn = fnNameOf(node, sf);
            const param = p.name.getText(sf);
            out.push({
              key: `${rel}::${fn}::${param}`,
              file: rel,
              fn,
              param,
              type: p.type ? p.type.getText(sf).replace(/\s+/g, " ") : "(inferred)",
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The reviewed allowlist.  Each entry: why this optional context parameter is
// SAFE (omission is a legitimate mode, not a silent wrong-output), or — where
// it is a known gap — what tracks it.  A NEW unlisted context-shaped optional
// parameter fails the first test; a listed key that is no longer present (its
// risk was removed by making the parameter required, as the `voLookup` fix in
// this same PR did) fails the second.  Adding a key here is the reviewed
// decision the class demands.
// ---------------------------------------------------------------------------
const ALLOWLIST: Readonly<Record<string, string>> = {
  // --- BENIGN: `{}` legitimately means "no loaded record in scope" ---------
  // `ctx.recordVar` gates the `this.<field>` seed; the server-default probe
  // (`renderDefaultSeed(e) === null`) and the new-form seed WANT the
  // no-record evaluation, and the detail-edit caller passes the real ctx.
  "src/generator/_frontend/default-seed.ts::renderDefaultSeed::ctx":
    "benign: {} = no loaded record; probe/new-form callers rely on it, edit callers pass recordVar",
  "src/generator/_frontend/form-helpers.ts::initialValuesTs::seedCtx":
    "benign: forwards to renderDefaultSeed; {} = new-form seed (no record var)",

  // --- BENIGN: every real caller passes the framework escaper --------------
  // Every walker call site passes `ctx.target.escapeText`; the `escapeJsxText`
  // default is the framework-free fallback for the v0 primitives that predate
  // the WalkerTarget seam.  (Candidate for `required` once the last defaulting
  // caller is gone.)
  "src/generator/_walker/shared/args.ts::unwrapTextLiteral::escapeFn":
    "benign: all walker call sites pass ctx.target.escapeText; default is the JSX fallback",

  // --- BENIGN at the boundary: prod callers thread it, artifact omits it ----
  // The public api-surface entry.  Route builders pass `apiStatusContext(ctx)`;
  // the `.loom/wire-spec` artifact legitimately omits it (it records types, not
  // remapped statuses).  The #2511 bug was the INTERNAL thread (a find arm
  // dropping the resolver) — pinned separately by the call-site anchor below.
  "src/ir/util/api-surface.ts::deriveAggregateOperations::statuses":
    "benign-boundary: route builders pass apiStatusContext(ctx); the wire-spec artifact omits by design",

  // --- BENIGN at the boundary: the production caller passes the resolver ----
  // `buildMigrations` passes all four binding-aware resolvers; the defaults
  // (`() => undefined` / `() => []`) exist only so the ~40 schema-only unit
  // tests that have no system to resolve against keep the legacy unqualified
  // output.  A new PRODUCTION caller that omitted them would silently lose
  // schema qualification — which is exactly why they are named here.
  "src/system/migrations-builder.ts::schemaFromModule::shapeOf":
    "benign-boundary: buildMigrations passes a binding-aware resolver; default serves schema-only unit tests",
  "src/system/migrations-builder.ts::schemaFromModule::schemaOf":
    "benign-boundary: buildMigrations passes a binding-aware resolver; default serves schema-only unit tests",
  "src/system/migrations-builder.ts::schemaFromModule::manualIndexesOf":
    "benign-boundary: buildMigrations passes a binding-aware resolver; default serves schema-only unit tests",
  "src/system/migrations-builder.ts::schemaFromModule::contextSchemaOf":
    "benign-boundary: buildMigrations passes resolveContextSchema; default serves schema-only unit tests",
  "src/system/migrations-builder.ts::resolveTableRenames::contextSchemaOf":
    "benign-boundary: buildMigrations passes resolveContextSchema through; default serves schema-only unit tests",

  // --- BENIGN at the boundary: the wire-spec builder passes the resolver ----
  // `bareRef` (unqualified `$ref`) is the single-context form; the builder
  // passes `refIn(ctx)` and the recursion threads it.  Exported, but no
  // external caller omits it.
  "src/system/wire-spec.ts::objectSchemaFromWireShape::ref":
    "benign-boundary: the wire-spec builder passes refIn(ctx); bareRef is the single-context default",
  "src/system/wire-spec.ts::jsonPropertyForType::ref":
    "benign-boundary: called with refIn(ctx) and threaded through recursion; bareRef is the single-context default",

  // --- BENIGN: an opt-in traversal channel, not output context -------------
  // `nestedStmt` lets a visitor descend into `variant-match` arm bodies.
  // Callers that only need top-level expressions omit it by design; it changes
  // what the visitor SEES, and each caller chooses — it is not a resolver whose
  // omission silently degrades emitted output.
  "src/ir/util/walk.ts::walkStmtChildren::nestedStmt":
    "benign: opt-in nested-statement traversal channel; callers choose their depth",

  // --- REVIEW: a documented asymmetry, not a silent wrong-upgrade ----------
  // Without the resolver the classifier cannot see param-op mutation, so it can
  // only return "reading"/"pure", never "mutating".  The callers that omit it
  // (elixir domain-service emit, workflow-execution emit) test `=== "reading"`
  // / single-context; the `mutating` tier is resolved SEPARATELY, WITH the
  // resolver (`domain-service-emit.ts` :109).  Omission can only fail to
  // upgrade a read to a write, never the reverse — but the split is subtle, so
  // it is pinned here as a reviewed decision.
  "src/ir/util/domain-service-tier.ts::classifyDomainServiceTier::resolveAggOp":
    "review: mutating tier resolved separately with the resolver; omitting arms only test reading/single-context",

  // --- KNOWN GAP: workflow httpStatus overrides not yet lifted --------------
  // `getById` ignores `resolve` by design (the 404 rung is deliberately not
  // remappable).  The `workflow`-kind callers (java openapi-customizer, dotnet
  // workflow-emit) OMIT `resolve`, so a `httpStatus DomainError|Forbidden -> X`
  // override is not reflected in the workflow route's declared error set — a
  // consequence of workflow routes not being lifted into `api-surface` yet (see
  // that file's SCOPE note).  Tracked with the workflow-route lift, not benign.
  "src/ir/util/openapi-errors.ts::errorStatuses::resolve":
    "known-gap: workflow-kind callers omit resolve; override no-ops on the workflow decl until workflow routes are lifted",
};

describe("optional-context-parameter sweep", () => {
  it("every context-shaped optional parameter in the shared cores is reviewed", () => {
    const found = census();
    expect(found.length, "census parsed nothing — the AST scan has drifted").toBeGreaterThan(5);

    const unlisted = found.filter((c) => !(c.key in ALLOWLIST));
    expect(
      unlisted.map((c) => `${c.key}  (${c.type})`),
      "New context-shaped optional parameter(s) in a shared core. Omitting one silently " +
        "degrades EMITTED OUTPUT on every backend at once, with no type error. Either make it " +
        "REQUIRED at the call boundary (the fix), or add its `<file>::<fn>::<param>` key to " +
        "ALLOWLIST with a one-line reason it is safe.",
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const present = new Set(census().map((c) => c.key));
    const stale = Object.keys(ALLOWLIST).filter((k) => !present.has(k));
    expect(
      stale,
      "Allowlisted parameter(s) no longer present — the risk was removed (e.g. the parameter " +
        "was made required). Delete the stale key so the allowlist tracks reality.",
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The #2511 call-site anchor.  The census ratchets the SIGNATURE surface, but
  // #2511 was a CALL SITE dropping an argument, not a new signature.  Every
  // error-status derivation in `api-surface.ts` is override-aware, so EVERY
  // `resolveErrorStatus(...)` call there must pass the overrides map as its
  // second argument — a single-argument call is the #2511 shape (the resolved
  // value collapses to the stdlib literal).  Reverting the fix (dropping the
  // second arg from any find arm) turns this red.
  // -------------------------------------------------------------------------
  it("every resolveErrorStatus call in api-surface.ts threads the overrides argument", () => {
    const file = join(root, "src/ir/util/api-surface.ts");
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const offenders: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "resolveErrorStatus"
      ) {
        if (node.arguments.length < 2) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          offenders.push(`L${line}: ${node.getText(sf).replace(/\s+/g, " ")}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(
      offenders,
      "resolveErrorStatus called WITHOUT its overrides map — the #2511 silent-status bug: with no " +
        "override the resolved value equals the literal, so a dropped resolver is invisible until a " +
        "user declares `httpStatus`. Thread the overrides map (denialOverridesFor(statuses) / " +
        "statuses?.errorStatusOverrides / statuses?.structuralErrorStatuses).",
    ).toEqual([]);
    // Guard against the anchor going hollow — it must actually be reaching calls.
    let total = 0;
    const count = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "resolveErrorStatus"
      ) {
        total += 1;
      }
      ts.forEachChild(node, count);
    };
    count(sf);
    expect(
      total,
      "found no resolveErrorStatus calls — the anchor stopped reaching them",
    ).toBeGreaterThan(4);
  });
});
