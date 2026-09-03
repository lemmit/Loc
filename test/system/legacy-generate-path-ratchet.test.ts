import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Legacy single-context `generate` ratchet (M-T9.44).
//
// The sibling ratchet (`direct-generate-systems-ratchet.test.ts`) pins the
// tests that import the SYSTEM orchestrator directly.  This one pins the other
// half of the same hole: `generateHono` in `test/_helpers/generate.ts`, the
// legacy single-context path (`ddd generate ts`).  At the 2026-09 census that
// wrapper was ONE LINE with no checks at all —
//
//     export const generateHono = (model: Model) => generateTypeScript(model, PINS);
//
// so its 66 call sites across 37 files asserted on emitted output from an IR
// nothing had ever looked at: no phase ⑤/⑥ verifier, no phase ⑦
// `validateLoomModel`, and — for the 25 files that reached it through a bare
// `parseString` rather than `parseValid` — no phase ① syntax check and no phase
// ④ AST validation either.
//
// Route 1 of that mission put `assertModelVerifies(model)` inside the wrapper,
// so phases ⑤/⑥/⑦ are now asserted for every call site with no call-site churn.
// Phases ① and ④ CANNOT be asserted there — the wrapper takes a `Model`, not a
// source string — which is why they stay the caller's job and why the
// `parseString` column below is pinned separately.
//
// Three directions, all ratcheting:
//
//   NEW FILE  — a test file that imports `generateHono` and is not pinned
//               fails.  Prefer `generateSystemFiles(source)`: it is the path
//               the product actually ships (`ddd generate system`), it asserts
//               ①/④ as well, and it is the only path on which a HOSTED
//               capability can be expressed at all (see below).
//   STALE     — a pinned file that no longer imports it fails, so a migration
//               deletes its pin in the same commit.
//   COUNT     — the total call-site count is pinned EXACTLY, not as a ceiling,
//               so adding a call to an already-pinned file fails too.
//
// WHY THE LEGACY PATH CANNOT HOST A CAPABILITY, which is what the phase-⑦
// assertion surfaced and is the reason four files left this list rather than
// being repaired in place: `generateTypeScript` emits from `loom.contexts` —
// the LOOSE top-level contexts — and declaring a `system` re-parents every
// loose context into it, emptying that list.  So a fixture on this path has, by
// construction, no backend deployable, and every hosted-capability check
// refuses it: `loom.tph-backend-unsupported` ("no TPH-capable backend
// deployable hosts this context"), `loom.audited-backend-unsupported`, and
// their siblings.  Those fixtures belong on the orchestrator.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const testRoot = path.join(repoRoot, "test");

/**
 * The legacy single-context entry point this ratchet covers.
 *
 * `generateDotnet` is the same hole on the .NET side — the helper RE-EXPORTS it
 * straight from `src/generator/dotnet/index.js`, so it is not wrapped and
 * asserts nothing — but wrapping it is a separate change with its own blast
 * radius, and pinning it here before it is wrapped would pin a set nothing
 * enforces.  Handed off rather than half-done.
 */
const GATED = new Set(["generateHono"]);

/**
 * Files still on the legacy single-context path, with their call-site count.
 *
 * This is a BACKLOG, not an allowance.  `generateSystemFiles` is the
 * replacement for every entry: it emits through the same orchestrator the CLI
 * runs, and it asserts phases ①/④ on top of the ⑤/⑥/⑦ the wrapper now shares.
 *
 * `test/_helpers/generate.ts` is the one legitimate importer — it IS the gated
 * wrapper — and is exempted below rather than pinned.
 */
const PINNED: Readonly<Record<string, number>> = {
  "test/conformance/paged-wire-parity.test.ts": 1,
  "test/conformance/union-wire-parity.test.ts": 1,
  "test/generator/_packs/join-table.test.ts": 3,
  "test/generator/hono/operation-return-route.test.ts": 1,
  "test/generator/hono/projection-aggregation.test.ts": 1,
  "test/generator/hono/projection-groupby-datekey.test.ts": 1,
  "test/generator/hono/projection-groupby.test.ts": 1,
  "test/generator/hono/projection-routes.test.ts": 1,
  "test/generator/hono/union-route.test.ts": 1,
  "test/generator/hono/when-route.test.ts": 2,
  "test/generator/typescript/avg-desugar.test.ts": 2,
  "test/generator/typescript/context-filter-emit.test.ts": 4,
  "test/generator/typescript/criterion-emit.test.ts": 1,
  "test/generator/typescript/domain-service-emit.test.ts": 2,
  "test/generator/typescript/domain-service-mutating.test.ts": 1,
  "test/generator/typescript/domain-service-reading.test.ts": 4,
  "test/generator/typescript/find-criterion-reify.test.ts": 2,
  "test/generator/typescript/hono-erp-bundle-regressions.test.ts": 1,
  "test/generator/typescript/hono-workflow-nested-saves.test.ts": 1,
  "test/generator/typescript/interpolation.test.ts": 2,
  "test/generator/typescript/intrinsic-trim.test.ts": 7,
  "test/generator/typescript/nested-parts.test.ts": 3,
  "test/generator/typescript/paged-emit.test.ts": 3,
  "test/generator/typescript/retrieval-criterion-reify.test.ts": 1,
  "test/generator/typescript/retrieval-emit.test.ts": 3,
  "test/generator/typescript/retrieval-for-loop-emit.test.ts": 2,
  "test/generator/typescript/single-find-hydrate.test.ts": 1,
  "test/generator/typescript/stdlib.test.ts": 1,
  "test/generator/typescript/temporal.test.ts": 4,
  "test/generator/typescript/toplevel-function.test.ts": 1,
  "test/generator/typescript/typescript-access-modifiers.test.ts": 1,
  "test/ir/collection-op-lambda-element-type.test.ts": 1,
  "test/ir/collection-op-let-type.test.ts": 1,
};

/**
 * The second column: a pinned file that ALSO calls `parseString`.
 *
 * `parseString` covers neither phase ① (it returns the error-recovered AST
 * without complaint) nor phase ④ unless the caller reads `errors` — so a
 * `parseString` → `generateHono` hop is the double bypass this mission's slice
 * 2 drained: 25 files down to the nine below, each with a stated reason.  The
 * reason is the point: an entry with no reason is a bypass nobody decided on.
 *
 * A migration deletes its entry, and a NEW file appearing here fails — the
 * ratchet is on the map's keys, not on its size.
 */
const PARSE_STRING_ALONGSIDE: Readonly<Record<string, string>> = {
  "test/generator/_packs/join-table.test.ts":
    "the `parseString` pair feeds `toLoomModel` for a negative IR assertion, not `generateHono` — the three generate calls already go through `parseValid`",
  "test/generator/typescript/avg-desugar.test.ts":
    "a dedicated `parses + validates cleanly` case that asserts `errors` is empty itself; the generate calls use `parseValid`",
  "test/generator/typescript/interpolation.test.ts": "same — the phase-④ assertion IS the test",
  "test/generator/typescript/intrinsic-trim.test.ts": "same — the phase-④ assertion IS the test",
  "test/generator/typescript/stdlib.test.ts": "same — the phase-④ assertion IS the test",
  "test/generator/typescript/temporal.test.ts": "same — the phase-④ assertion IS the test",
  "test/generator/typescript/toplevel-function.test.ts": "same — the phase-④ assertion IS the test",
  "test/ir/collection-op-lambda-element-type.test.ts":
    "OWNED BY ANOTHER PACKET (test/ir/** fence) — a real `parseString` → `generateHono` hop, still to migrate",
  "test/ir/collection-op-let-type.test.ts":
    "OWNED BY ANOTHER PACKET (test/ir/** fence) — a real `parseString` → `generateHono` hop, still to migrate",
};

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "fixtures") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, out);
    else if (entry.isFile() && /\.[cm]?tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** `true` when the specifier resolves to the shared test helper barrel. */
const isHelperModule = (spec: string): boolean =>
  /(^|\/)_helpers\/(generate|index)\.js$/.test(spec);

type Row = { file: string; calls: number; usesParseString: boolean };

/**
 * Every test-tree file importing a legacy single-context generator from the
 * helper, its `generateHono(` / `generateDotnet(` call count, and whether it
 * also calls `parseString` — plus the number of files scanned (the
 * vacuous-pass guard).
 */
function census(): { rows: Row[]; scanned: number } {
  const rows: Row[] = [];
  let scanned = 0;

  for (const file of testFiles(testRoot)) {
    scanned++;
    const text = fs.readFileSync(file, "utf8");
    // Cheap prefilter — the AST parse below is the authority.
    if (!text.includes("generateHono")) continue;
    const rel = path.relative(repoRoot, file);
    if (rel === "test/_helpers/generate.ts") continue;

    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    // TWO passes, deliberately.  A single walk would have to see the import
    // before the call that uses the local name, and while an `import` is always
    // top-level, a re-exporting barrel or an aliased binding is not guaranteed
    // to be visited first — a miscount here reads as a shrinking ratchet, the
    // exact failure this file exists to prevent.
    const imported = new Set<string>();
    const collectImports = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        isHelperModule(node.moduleSpecifier.text)
      ) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            if (GATED.has((el.propertyName ?? el.name).text)) imported.add(el.name.text);
          }
        }
      }
      ts.forEachChild(node, collectImports);
    };
    collectImports(sf);
    if (imported.size === 0) continue;

    let calls = 0;
    let usesParseString = false;
    const countCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (imported.has(node.expression.text)) calls++;
        if (node.expression.text === "parseString") usesParseString = true;
      }
      ts.forEachChild(node, countCalls);
    };
    countCalls(sf);

    if (calls > 0) rows.push({ file: rel, calls, usesParseString });
  }
  return { rows: rows.sort((a, b) => a.file.localeCompare(b.file)), scanned };
}

describe("legacy single-context `generateHono` callers under test/ (M-T9.44)", () => {
  const { rows, scanned } = census();

  it("scans the whole test tree (guard against a vacuous pass)", () => {
    // If the walker silently stopped finding files, every assertion below
    // would pass on an empty set.
    expect(scanned).toBeGreaterThan(1_000);
    expect(rows.length).toBeGreaterThan(20);
  });

  it("no NEW file on the legacy single-context path", () => {
    const added = rows.map((r) => r.file).filter((f) => !(f in PINNED));
    expect(
      added,
      `${added.length} test file(s) newly reach the legacy single-context generator. ` +
        `Use generateSystemFiles(source) instead — it emits through the orchestrator the ` +
        `CLI runs, asserts phases ①/④ as well as ⑤/⑥/⑦, and is the only path on which a ` +
        `hosted capability (TPH, audited, tenancy) can be expressed.`,
    ).toEqual([]);
  });

  it("no STALE pin (the file list ratchets down)", () => {
    const live = new Set(rows.map((r) => r.file));
    const gone = Object.keys(PINNED).filter((f) => !live.has(f));
    expect(
      gone,
      `${gone.length} pinned file(s) no longer reach the legacy generator — delete their ` +
        `entries from PINNED in the same change that migrated them.`,
    ).toEqual([]);
  });

  it("the call-site count is pinned EXACTLY, so it can only shrink", () => {
    // Exact, not a ceiling: a ceiling lets a new call slip into an
    // already-pinned file, which is how the 66 accumulated in the first place.
    const live = Object.fromEntries(rows.map((r) => [r.file, r.calls]));
    expect(live).toEqual(PINNED);
  });

  it("the total is pinned too (one number to watch shrink)", () => {
    const total = rows.reduce((n, r) => n + r.calls, 0);
    const expected = Object.values(PINNED).reduce((n, c) => n + c, 0);
    expect(total, `legacy call sites: ${total} (pinned ${expected})`).toBe(expected);
  });

  it("every `parseString` → legacy-generate file carries a stated reason", () => {
    const live = rows.filter((r) => r.usesParseString).map((r) => r.file);
    const undocumented = live.filter((f) => !(f in PARSE_STRING_ALONGSIDE));
    expect(
      undocumented,
      `${undocumented.length} file(s) call both parseString and the legacy generator with no ` +
        `reason recorded.  parseString asserts NEITHER phase ① nor phase ④, and the legacy ` +
        `wrapper cannot assert them for you (it takes a Model, not a source) — so reach for ` +
        `parseValid, or add an entry to PARSE_STRING_ALONGSIDE saying why this one is fine.`,
    ).toEqual([]);
    const stale = Object.keys(PARSE_STRING_ALONGSIDE).filter((f) => !live.includes(f));
    expect(
      stale,
      `${stale.length} PARSE_STRING_ALONGSIDE entry/entries are stale — delete them in the ` +
        `same change that migrated the file to parseValid.`,
    ).toEqual([]);
  });
});
