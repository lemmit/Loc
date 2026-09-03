import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_MESSAGES, type DiagnosticMessageKey } from "../../src/diagnostics/messages.js";

// ---------------------------------------------------------------------------
// DIAG-1 — diagnostic message HYGIENE (wave G3).
//
// `test/system/diagnostic-catalog.test.ts` is the ratchet over the catalog's
// STRUCTURE: no inline wording, key ⇒ code agreement, no orphans, key shape, no
// dynamic `code:`, no duplicated `where` lead, every entry renders non-blank.
// It says nothing about the PARAMS that flow into an entry, and nothing about
// two entries saying the same thing.  This file owns that half:
//
//   (a) PARAM AGREEMENT.  For every `diagMessage("key", { … })` call under
//       `src/`, the object literal's keys equal the params the template
//       actually READS (recorded through a Proxy).  `ParamsOf<K>` already makes
//       a MISSING property a tsc error, and excess-property checking rejects an
//       undeclared one — what neither catches is a param that is declared,
//       passed at every call site, and never interpolated.  That is a dead
//       param: it costs a value at every site and renders nothing.
//       The ~10 sites that pass a VARIABLE instead of a literal are invisible
//       to that check (the keys are not in the source text), so each is
//       enumerated with its reason below; a new one fails.
//
//   (b) NO `undefined` IN A RENDERED MESSAGE.  Under the canonical Proxy no
//       entry may render the literal `undefined` or `[object Object]` — that is
//       what a template reading one hop too far (`${p.opts.name}`) or
//       interpolating a whole object produces, and it reaches the user verbatim.
//       Prose that says the word "undefined" ON PURPOSE is waived by exact key.
//       For the variable-arg sites a runtime `undefined` is genuinely reachable
//       (a widened upstream object), so the keys that interpolate a param
//       DIRECTLY are pinned as a set — see the hand-off note on that test.
//
//   (c) NO TWO KEYS SAY THE SAME THING.  Two keys rendering identical text is
//       either a copy-paste that should have been one key, or a deliberate
//       split that must be justified.  Rendered with a UNIFORM Proxy (every
//       param renders as the same token), so two entries that differ only in
//       which param name supplies a value still collide.
//
// Every list here is an EQUALITY pin, so it ratchets in both directions: a new
// offender fails, and an entry that has since been fixed fails as stale and
// must be deleted in the same change.  This packet is test-only — the live
// findings below are handed off, never fixed here.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

type Entry = string | ((params: never) => string);
const entryOf = (key: string): Entry =>
  DIAGNOSTIC_MESSAGES[key as DiagnosticMessageKey] as unknown as Entry;
const render = (entry: Entry, params: unknown): string =>
  typeof entry === "string" ? entry : (entry as (p: unknown) => string)(params);

// ---------------------------------------------------------------------------
// The waivers.  Each is an exact set; the test asserts EQUALITY against it.
// ---------------------------------------------------------------------------

/** The `where` param survived the "no `where` lead" cleanup that
 *  `diagnostic-catalog.test.ts` pins (the CLI already prints the location as
 *  `source`, so the lead was stripped from the wording) — but only from the
 *  TEXT.  The param stayed in each builder's signature, so every call site
 *  still computes and passes a value nothing interpolates. */
const WHY_WHERE_LEAD =
  "`where` lead removed from the wording; param left declared and still passed";

/** Params a builder DECLARES (so every call site must pass one) and never
 *  reads.  Live finding, handed off — fixing one means deleting its property
 *  from the builder's param type AND from its call sites, which is a `src/`
 *  change this packet may not make. */
const DEAD_PARAM_DEBT: { why: string; params: string[] }[] = [
  {
    why: WHY_WHERE_LEAD,
    params: [
      "loom.action-op-has-params :: where",
      "loom.action-payload-mismatch#action-referenced-by-declares :: where",
      "loom.action-payload-mismatch#into-binding-arity :: where",
      "loom.action-payload-mismatch#supplies-a-payload-value :: where",
      "loom.chart-accessor-not-field#not-a-row-field :: where",
      "loom.chart-accessor-not-field#not-a-simple-accessor :: where",
      "loom.chart-kind-invalid :: where",
      "loom.chart-of-not-grouped :: where",
      "loom.datagrid-selection-not-array :: where",
      "loom.datagrid-selection-not-state :: where",
      "loom.effect-in-lambda#effect :: where",
      "loom.effect-in-lambda#remote-mutation :: where",
      "loom.feliz-async-effect-unsupported :: where",
      "loom.flutter-async-effect-unsupported :: where",
      "loom.flutter-primitive-unsupported :: where",
      "loom.frontend-collection-op-unsupported :: where",
      "loom.match-await-arg-mismatch :: where",
      "loom.match-await-arg-type :: where",
      "loom.method-call-unresolved-receiver :: where",
      "loom.missing-effect-marker :: where",
      "loom.modal-controlled-op-form-unsupported :: where",
      "loom.page-primitive-extra-children :: where",
      "loom.page-primitive-extra-children#modal-op-form :: where",
      "loom.page-primitive-unknown-arg :: where",
      "loom.page-primitive-unknown-arg#style-not-object :: where",
      "loom.scaffold-filter-param-unsupported :: where",
      "loom.slot-outside-component :: where",
      "loom.store-action-view-effect :: where",
      "loom.store-cross-store-on-liveview-invalid :: where",
      "loom.store-lifetime-liveview-invalid :: where",
      "loom.store-lifetime-target-unsupported#field :: where",
      "loom.store-lifetime-target-unsupported#flutter-field :: where",
      "loom.store-url-field-invalid :: where",
      "loom.sub-primitive-misplaced :: where",
      "loom.table-filter-server-paged :: where",
      "loom.table-filter-unsupported :: where",
      "loom.toast-message-unsupported :: where",
      "loom.ui-projection-read-unsupported#not-ui-consumable :: where",
      "loom.unknown-page-element :: where",
      "loom.unresolved-action-ref#call-references-no-sibling :: where",
      "loom.unresolved-action-ref#references-which-is-not :: where",
      "loom.unresolved-page-ref :: where",
    ],
  },
  {
    why: "the plural suffix folded into `reason` when the sentence was reworded; `plural` is now inert",
    params: ["loom.lifecycle-body-dropped :: plural"],
  },
  {
    why: "the page name is already carried by the diagnostic's `source`; the wording names the FORM (`of:`/`op:`) instead",
    params: ["loom.op-form-needs-route-id :: name"],
  },
];

const DEAD_PARAMS = new Set(DEAD_PARAM_DEBT.flatMap((d) => d.params));

/** A `diagMessage(key, params)` site whose second argument is a VARIABLE, not
 *  an object literal — the keys are not in the source text, so (a) cannot check
 *  it.  Every one of them today has the same shape: ONE params object hoisted
 *  above a two-arm `if`, because each arm must attach a STRING-LITERAL `code:`
 *  (the catalog ratchet in `diagnostic-catalog.test.ts` rejects a computed
 *  `code:`), so the two arms differ only in the code and the catalog key.
 *  Pinned by `file :: key` so the rows survive line drift. */
const VARIABLE_ARG_SITES: { site: string; why: string }[] = [
  {
    site: "src/ir/validate/checks/migration-checks.ts :: loom.dapper-unsupported#migrations",
    why: "self-provisioning adapter gate: one `params` hoisted above the dapper/mikroorm arms, which must attach literal codes",
  },
  {
    site: "src/ir/validate/checks/migration-checks.ts :: loom.mikroorm-unsupported#migrations",
    why: "the mikroorm arm of the same hoisted `params` object",
  },
  {
    site: "src/ir/validate/checks/migration-checks.ts :: loom.dapper-unsupported#schema-split",
    why: "schema split-brain gate: one `params` hoisted above the dapper/mikroorm arms",
  },
  {
    site: "src/ir/validate/checks/migration-checks.ts :: loom.mikroorm-unsupported#schema-split",
    why: "the mikroorm arm of the same hoisted `params` object",
  },
  {
    site: "src/ir/validate/checks/migration-checks.ts :: loom.dapper-unsupported#schema-ignored",
    why: "unhonourable-placement gate: one `params` hoisted above the dapper/mikroorm arms",
  },
  {
    site: "src/ir/validate/checks/migration-checks.ts :: loom.mikroorm-unsupported#schema-ignored",
    why: "the mikroorm arm of the same hoisted `params` object",
  },
  {
    site: "src/ir/validate/checks/system-checks.ts :: loom.projection-groupby-unsupported-backend#document",
    why: "document-shape projection gate: one `params` hoisted above the grouped/whole-table arms, each with its own literal code",
  },
  {
    site: "src/ir/validate/checks/system-checks.ts :: loom.projection-whole-table-aggregation-unsupported#document",
    why: "the whole-table arm of the same hoisted `params` object",
  },
  {
    site: "src/ir/validate/checks/system-checks.ts :: loom.default-deny-ungated#denybydefault-handler-extern",
    why: "denyByDefault handler gate: one `params` hoisted above the extern/normal arms, which share one code but two keys",
  },
  {
    site: "src/ir/validate/checks/system-checks.ts :: loom.default-deny-ungated#denybydefault-handler",
    why: "the non-extern arm of the same hoisted `params` object",
  },
];

/** Entries whose PROSE contains the word "undefined" deliberately — they
 *  describe an undefined value in the generated output or in the language
 *  semantics, they do not interpolate one. */
const PROSE_SAYS_UNDEFINED = [
  "loom.current-user-needs-auth-ui",
  "loom.e2e-unresolved-call",
  "loom.e2e-unresolved-ref",
  "loom.match-non-exhaustive",
];

/** HAND-OFF (b).  Every variable-arg key interpolates at least one param
 *  DIRECTLY, so a widened upstream object that carries `undefined` renders the
 *  literal string `undefined` into a user-facing message.  Nothing today makes
 *  that reachable — each `params` object above is built from non-optional IR
 *  fields — but nothing STOPS it either, which is why the set is pinned rather
 *  than asserted empty: a new variable-arg key joins the list consciously, and
 *  a key that grows a default drops off it. */
const INTERPOLATES_UNDEFINED_AT_VARIABLE_ARG_SITES = [
  "loom.dapper-unsupported#migrations",
  "loom.dapper-unsupported#schema-ignored",
  "loom.dapper-unsupported#schema-split",
  "loom.default-deny-ungated#denybydefault-handler",
  "loom.default-deny-ungated#denybydefault-handler-extern",
  "loom.mikroorm-unsupported#migrations",
  "loom.mikroorm-unsupported#schema-ignored",
  "loom.mikroorm-unsupported#schema-split",
  "loom.projection-groupby-unsupported-backend#document",
  "loom.projection-whole-table-aggregation-unsupported#document",
];

/** Key groups that render the SAME text on purpose.  A group is written as its
 *  sorted keys joined by `, ` — the exact signature the duplicate detector
 *  produces. */
const DUPLICATE_TEXT_WAIVERS: { keys: string; why: string }[] = [
  {
    keys: "loom.criterion-impure#free-call, loom.criterion-impure#member-call",
    why: "one message, two raise sites in criterion.ts (a member call vs a free call) that name the operation from different AST params; a catalog key is never computed at a call site, so the two sites cannot share one key",
  },
];

// ---------------------------------------------------------------------------
// The scanner: every `diagMessage(...)` call under `src/`.
// ---------------------------------------------------------------------------

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // `src/language/generated/` is `langium generate` output — it raises no
      // catalogued diagnostics.
      if (e.name !== "generated") sourceFiles(p, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

interface CallSite {
  file: string;
  line: number;
  key: string;
  /** The object literal's keys, or `undefined` when the site passes no params
   *  (a fixed-string entry) — `"variable"` when it passes an identifier or any
   *  other non-literal expression. */
  passed: Set<string> | "none" | "variable";
  /** True when the literal uses a spread or a computed key, which would make
   *  `passed` an undercount.  Guarded, never silently tolerated. */
  opaque: boolean;
}

function scanCallSites(): CallSite[] {
  const out: CallSite[] = [];
  for (const abs of sourceFiles(path.join(repoRoot, "src"))) {
    const src = fs.readFileSync(abs, "utf8");
    if (!src.includes("diagMessage(")) continue;
    const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
    const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.ESNext, true);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.expression.getText(sf) === "diagMessage") {
        const keyNode = n.arguments[0];
        const arg = n.arguments[1];
        if (keyNode && ts.isStringLiteral(keyNode)) {
          let passed: CallSite["passed"];
          let opaque = false;
          if (arg === undefined) passed = "none";
          else if (!ts.isObjectLiteralExpression(arg)) passed = "variable";
          else {
            const keys = new Set<string>();
            for (const p of arg.properties) {
              if (
                (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
                !ts.isComputedPropertyName(p.name)
              ) {
                keys.add(p.name.getText(sf).replace(/^["'`]|["'`]$/g, ""));
              } else opaque = true;
            }
            passed = keys;
          }
          out.push({
            file: rel,
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
            key: keyNode.text,
            passed,
            opaque,
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

const CALL_SITES = scanCallSites();

// ---------------------------------------------------------------------------
// What a template READS, and what it DECLARES.
// ---------------------------------------------------------------------------

/** The property names a catalog entry reads, recorded by a Proxy.
 *
 *  Rendered once per stand-in VALUE, and the reads are unioned: a template with
 *  a branch (`p.size ? … : …`) reads different params on each side, so a single
 *  truthy render would report the other side's params as dead.  Reads are
 *  recorded in the trap itself, so a stand-in that makes a template throw
 *  (`p.n.toFixed(…)` on a boolean) still contributes what it read first. */
function readsOf(entry: Entry): Set<string> {
  const acc = new Set<string>();
  if (typeof entry === "string") return acc;
  const fn = entry as unknown as (p: unknown) => string;
  for (const stand of ["<v>", "", 0, 2, true, false] as unknown[]) {
    const proxy = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (typeof prop === "string") acc.add(prop);
          return prop === "then" ? undefined : stand;
        },
        has: (_t, prop) => {
          if (typeof prop === "string") acc.add(prop);
          return true;
        },
      },
    );
    try {
      fn(proxy);
    } catch {
      /* this stand-in does not render; its reads still count */
    }
  }
  acc.delete("then");
  return acc;
}

const READS = new Map<string, Set<string>>(
  Object.keys(DIAGNOSTIC_MESSAGES).map((k) => [k, readsOf(entryOf(k))]),
);

/** The params each builder DECLARES, read off the catalog's own AST — the
 *  runtime entry is a closure, so optionality (`via?: unknown`) is only visible
 *  in the source. */
function declaredParams(): Map<string, { required: Set<string>; optional: Set<string> }> {
  const file = path.join(repoRoot, "src", "diagnostics", "messages.ts");
  const sf = ts.createSourceFile(
    "messages.ts",
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );
  const out = new Map<string, { required: Set<string>; optional: Set<string> }>();

  const split = (t: ts.TypeNode | undefined) => {
    const required = new Set<string>();
    const optional = new Set<string>();
    if (t && ts.isTypeLiteralNode(t)) {
      for (const m of t.members) {
        if (ts.isPropertySignature(m) && m.name) {
          (m.questionToken ? optional : required).add(m.name.getText(sf));
        }
      }
    }
    return { required, optional };
  };

  // A few entries are built by a shared CURRIED factory (`spaDeployableMissingUi`
  // — one wording, six per-platform codes).  The params live on the returned
  // arrow, so resolve the factory name to it.
  const factories = new Map<string, ts.TypeNode | undefined>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer || !ts.isArrowFunction(d.initializer))
        continue;
      const inner = d.initializer.body;
      if (ts.isArrowFunction(inner)) factories.set(d.name.text, inner.parameters[0]?.type);
    }
  }

  const visit = (n: ts.Node): void => {
    if (
      ts.isPropertyAssignment(n) &&
      (ts.isStringLiteral(n.name) || ts.isIdentifier(n.name)) &&
      n.name.text.startsWith("loom.")
    ) {
      const init = n.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        out.set(n.name.text, split(init.parameters[0]?.type));
      } else if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        factories.has(init.expression.text)
      ) {
        out.set(n.name.text, split(factories.get(init.expression.text)));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const DECLARED = declaredParams();

// ---------------------------------------------------------------------------

describe("diagnostic message hygiene (DIAG-1)", () => {
  it("scans the whole `diagMessage` surface", () => {
    // Guards the scanner: every assertion below passes vacuously if the AST
    // shapes stop matching, or if a param-carrying literal turns opaque.
    expect(CALL_SITES.length).toBeGreaterThan(500);
    expect(CALL_SITES.filter((s) => s.passed === "variable").length).toBe(
      VARIABLE_ARG_SITES.length,
    );
    expect(
      CALL_SITES.filter((s) => s.opaque).map((s) => `${s.file}:${s.line}`),
      "a spread or computed key in a `diagMessage` params literal hides its keys from (a)",
    ).toEqual([]);
    expect(
      CALL_SITES.filter((s) => !(s.key in DIAGNOSTIC_MESSAGES)).map((s) => `${s.file}:${s.line}`),
    ).toEqual([]);
    // Every builder's param list was parsed out of the catalog source.
    const missed = Object.keys(DIAGNOSTIC_MESSAGES).filter(
      (k) => typeof entryOf(k) === "function" && !DECLARED.has(k),
    );
    expect(missed, "builder whose declared params the AST pass did not see").toEqual([]);
  });

  // (a) --------------------------------------------------------------------

  it("declares no param a template never reads", () => {
    const dead: string[] = [];
    for (const [key, { required, optional }] of DECLARED) {
      const read = READS.get(key) ?? new Set<string>();
      for (const p of [...required, ...optional].sort()) {
        if (!read.has(p)) dead.push(`${key} :: ${p}`);
      }
    }
    // Equality, so a fixed entry's waiver goes stale and must be deleted.
    expect(
      dead.sort(),
      "a declared param no template reads: every call site computes and passes a value that renders nothing",
    ).toEqual([...DEAD_PARAMS].sort());
  });

  it("passes exactly the params the template reads at every object-literal site", () => {
    const offenders: string[] = [];
    for (const site of CALL_SITES) {
      if (site.passed === "variable") continue;
      const passed = site.passed === "none" ? new Set<string>() : site.passed;
      const read = READS.get(site.key) ?? new Set<string>();
      const optional = DECLARED.get(site.key)?.optional ?? new Set<string>();
      for (const p of [...passed].sort()) {
        // A param the template never reads is dead weight — unless it is a
        // known, pinned piece of debt (see DEAD_PARAM_DEBT).
        if (!read.has(p) && !DEAD_PARAMS.has(`${site.key} :: ${p}`)) {
          offenders.push(`${site.file}:${site.line} (${site.key}) → passes unread param '${p}'`);
        }
      }
      for (const p of [...read].sort()) {
        // The other direction renders `undefined`.  An OPTIONAL param may be
        // omitted: the template tests it (`p.via === "join" ? … : …`) rather
        // than interpolating it.
        if (!passed.has(p) && !optional.has(p)) {
          offenders.push(`${site.file}:${site.line} (${site.key}) → omits read param '${p}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("waives exactly the variable-arg sites that exist", () => {
    const live = CALL_SITES.filter((s) => s.passed === "variable")
      .map((s) => `${s.file} :: ${s.key}`)
      .sort();
    expect(
      live,
      "a `diagMessage(key, params)` site passing a VARIABLE is invisible to the param-agreement " +
        "check — add it to VARIABLE_ARG_SITES with a reason, or pass an object literal",
    ).toEqual(VARIABLE_ARG_SITES.map((w) => w.site).sort());
    expect(VARIABLE_ARG_SITES.every((w) => w.why.trim().length > 0)).toBe(true);
  });

  // (b) --------------------------------------------------------------------

  it("renders no `undefined` and no `[object Object]`", () => {
    // Every param is present and stringy here, so `undefined` can only come
    // from a template reaching one hop too far (`${p.opts.name}`), and
    // `[object Object]` from interpolating a structure instead of a field.
    const canonical = new Proxy({}, { get: (_t, prop) => `<${String(prop)}>` });
    const offenders: string[] = [];
    const prose: string[] = [];
    for (const key of Object.keys(DIAGNOSTIC_MESSAGES)) {
      const text = render(entryOf(key), canonical);
      if (!text.includes("undefined") && !text.includes("[object Object]")) continue;
      if (text.includes("[object Object]") || !PROSE_SAYS_UNDEFINED.includes(key)) {
        offenders.push(`${key} → ${text.slice(0, 120)}`);
      } else prose.push(key);
    }
    expect(offenders).toEqual([]);
    // Ratchet: a waived entry that no longer says "undefined" is stale.
    expect(prose.sort(), "stale PROSE_SAYS_UNDEFINED entry — delete it").toEqual(
      [...PROSE_SAYS_UNDEFINED].sort(),
    );
  });

  it("pins which variable-arg keys interpolate a param directly", () => {
    // HAND-OFF.  These are the only keys where a runtime `undefined` is
    // reachable at all: their params object is built once and passed by
    // reference, so widening it upstream cannot be caught by `ParamsOf<K>`.
    const allUndefined = new Proxy({}, { get: () => undefined });
    const bad: string[] = [];
    for (const { site } of VARIABLE_ARG_SITES) {
      const key = site.split(" :: ")[1]!;
      let text: string;
      try {
        text = render(entryOf(key), allUndefined);
      } catch {
        continue; // a template that throws on an absent param cannot print one
      }
      if (text.includes("undefined") || text.includes("[object Object]")) bad.push(key);
    }
    expect([...new Set(bad)].sort()).toEqual(
      [...INTERPOLATES_UNDEFINED_AT_VARIABLE_ARG_SITES].sort(),
    );
  });

  // (c) --------------------------------------------------------------------

  it("no two keys render the same message", () => {
    // A UNIFORM stand-in: every param renders as the same token, so two entries
    // that differ only in which param name supplies a value still collide.
    const uniform = new Proxy({}, { get: () => "<p>" });
    const byText = new Map<string, string[]>();
    for (const key of Object.keys(DIAGNOSTIC_MESSAGES)) {
      const text = render(entryOf(key), uniform);
      byText.set(text, [...(byText.get(text) ?? []), key]);
    }
    const groups = [...byText.values()]
      .filter((keys) => keys.length > 1)
      .map((keys) => keys.sort().join(", "))
      .sort();
    expect(
      groups,
      "two catalog keys render identical text — merge them, or add the group to " +
        "DUPLICATE_TEXT_WAIVERS with the reason the split is deliberate",
    ).toEqual(DUPLICATE_TEXT_WAIVERS.map((w) => w.keys).sort());
    expect(DUPLICATE_TEXT_WAIVERS.every((w) => w.why.trim().length > 0)).toBe(true);
  });
});
