import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Legacy single-context `generate` ratchet (M-T9.48 Hono, M-T9.49 .NET).
//
// The sibling ratchet (`direct-generate-systems-ratchet.test.ts`) pins the
// tests that import the SYSTEM orchestrator directly.  This one pins the other
// half of the same hole: the legacy single-context wrappers in
// `test/_helpers/generate.ts` (`ddd generate ts` / `ddd generate dotnet`).  At
// the 2026-09 census BOTH were unchecked —
//
//     export const generateHono = (model: Model) => generateTypeScript(model, PINS);
//     export { generateDotnet };            // ← a bare re-export from src/
//
// — so 62 + 150 call sites asserted on emitted output from an IR nothing had
// ever looked at: no phase ⑤/⑥ verifier, no phase ⑦ `validateLoomModel`, and —
// for the files that reached them through a bare `parseString` rather than
// `parseValid` — no phase ① syntax check and no phase ④ AST validation either.
//
// `generateDotnet` was the WORSE of the two, and not only by call count: the
// helper merely RE-EXPORTED it, so only 9 of its 39 caller files reached the
// helper at all — 14 of the 150 call sites.  The other 30 files imported the
// generator straight from `src/generator/dotnet/index.js` and sat outside every
// gate this helper module has, present or future.  M-T9.49 turned it into a
// real wrapper and routed those files back through the helper, which is why the
// .NET column below is the bigger one.  (`generateDotnetForContexts`, the
// system-mode entry one rung below, is deliberately NOT gated — same reason the
// Hono column gates `generateHono` and not `generateTypeScriptForContexts`.)
//
// Both wrappers now call `assertModelVerifies(model)` — the same shared body —
// so phases ⑤/⑥/⑦ are asserted for every call site with no call-site churn.
// Phases ① and ④ CANNOT be asserted there — the wrappers take a `Model`, not a
// source string — which is why they stay the caller's job and why the
// `parseString` column below is pinned separately.
//
// Three directions, all ratcheting, for EACH entry point:
//
//   NEW FILE  — a test file that imports the wrapper and is not pinned fails.
//               Prefer `generateSystemFiles(source)`: it is the path the
//               product actually ships (`ddd generate system`), it asserts ①/④
//               as well, and it is the only path on which a HOSTED capability
//               can be expressed at all (see below).
//   STALE     — a pinned file that no longer imports it fails, so a migration
//               deletes its pin in the same commit.
//   COUNT     — the total call-site count is pinned EXACTLY, not as a ceiling,
//               so adding a call to an already-pinned file fails too.
//
// WHY THE LEGACY PATH CANNOT HOST A CAPABILITY, which is what the phase-⑦
// assertion surfaced and is the reason files left these lists rather than being
// repaired in place: `generateTypeScript` / `generateDotnet` emit from
// `loom.contexts` — the LOOSE top-level contexts — and declaring a `system`
// re-parents every loose context into it, emptying that list.  So a fixture on
// this path has, by construction, no backend deployable, and every
// hosted-capability check refuses it: `loom.tph-backend-unsupported` ("no
// TPH-capable backend deployable hosts this context"),
// `loom.audited-backend-unsupported`, `loom.event-sourcing-backend-unsupported`
// and their siblings.  Those fixtures belong on the orchestrator.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const testRoot = path.join(repoRoot, "test");

/**
 * Files still on the legacy single-context Hono path, with their call-site
 * count.
 *
 * This is a BACKLOG, not an allowance.  `generateSystemFiles` is the
 * replacement for every entry: it emits through the same orchestrator the CLI
 * runs, and it asserts phases ①/④ on top of the ⑤/⑥/⑦ the wrapper now shares.
 *
 * `test/_helpers/generate.ts` is the one legitimate importer — it IS the gated
 * wrapper — and is exempted below rather than pinned.
 */
const PINNED_HONO: Readonly<Record<string, number>> = {
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
 * The same backlog for the legacy single-context .NET path (M-T9.49).
 *
 * Bigger than the Hono column because it went uncounted for longer: the helper
 * re-exported `generateDotnet` verbatim, so a caller could import it from `src/`
 * and never appear in any census.  The 39 files below are the whole surface
 * after those 30 direct importers were routed back through the helper.
 */
const PINNED_DOTNET: Readonly<Record<string, number>> = {
  "test/adapters/dotnet-orchestrator-rewire.test.ts": 1,
  "test/conformance/paged-wire-parity.test.ts": 1,
  "test/conformance/union-wire-parity.test.ts": 1,
  "test/generator/dotnet/capability.test.ts": 16,
  "test/generator/dotnet/criteria-emit.test.ts": 3,
  "test/generator/dotnet/crudish-document.test.ts": 1,
  "test/generator/dotnet/document-nested-parts.test.ts": 2,
  "test/generator/dotnet/domain-service-emit.test.ts": 1,
  "test/generator/dotnet/domain-service-mutating.test.ts": 1,
  "test/generator/dotnet/domain-service-reading.test.ts": 2,
  "test/generator/dotnet/dotnet-access-modifiers.test.ts": 1,
  "test/generator/dotnet/dotnet-destroy-route.test.ts": 1,
  "test/generator/dotnet/dotnet-dispatch-emission.test.ts": 1,
  "test/generator/dotnet/dotnet-document-emission.test.ts": 1,
  "test/generator/dotnet/dotnet-observability-namespace.test.ts": 1,
  "test/generator/dotnet/dotnet-projection-emission.test.ts": 1,
  "test/generator/dotnet/dotnet-seed.test.ts": 1,
  "test/generator/dotnet/dotnet-tracing.test.ts": 3,
  "test/generator/dotnet/dotnet-transitive-vo-nested.test.ts": 1,
  "test/generator/dotnet/dotnet-workflow-instances.test.ts": 1,
  "test/generator/dotnet/generator-dotnet.test.ts": 66,
  "test/generator/dotnet/intrinsic-math.test.ts": 5,
  "test/generator/dotnet/intrinsic-strings.test.ts": 3,
  "test/generator/dotnet/intrinsic-trim.test.ts": 3,
  "test/generator/dotnet/nested-parts.test.ts": 2,
  "test/generator/dotnet/operation-return-emit.test.ts": 2,
  "test/generator/dotnet/operation-scalar-return-emit.test.ts": 1,
  "test/generator/dotnet/optional-id-wire.test.ts": 2,
  "test/generator/dotnet/paged-emit.test.ts": 1,
  "test/generator/dotnet/part-valueobject-columns.test.ts": 1,
  "test/generator/dotnet/required-value-type-members.test.ts": 2,
  "test/generator/dotnet/retrieval-emit.test.ts": 2,
  "test/generator/dotnet/single-containment.test.ts": 1,
  "test/generator/dotnet/temporal.test.ts": 5,
  "test/generator/dotnet/union-emit.test.ts": 3,
  "test/generator/dotnet/validation-error-extension.test.ts": 6,
  "test/generator/dotnet/when-emit.test.ts": 1,
  "test/generator/typescript/outbox-emission.test.ts": 2,
  "test/ir/collection-op-lambda-element-type.test.ts": 1,
};

/**
 * The second column: a pinned file that ALSO calls `parseString`.
 *
 * `parseString` covers neither phase ① (it returns the error-recovered AST
 * without complaint) nor phase ④ unless the caller reads `errors` — so a
 * `parseString` → legacy-generate hop is the double bypass these missions
 * drained: 25 Hono files down to the nine below, and 17 .NET files down to five.
 * The reason is the point: an entry with no reason is a bypass nobody decided
 * on.
 *
 * A migration deletes its entry, and a NEW file appearing here fails — the
 * ratchet is on the map's keys, not on its size.
 */
const PARSE_STRING_ALONGSIDE_HONO: Readonly<Record<string, string>> = {
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
    "OWNED BY ANOTHER PACKET (test/ir/** fence) — a real `parseString` → legacy-generate hop, still to migrate",
  "test/ir/collection-op-let-type.test.ts":
    "OWNED BY ANOTHER PACKET (test/ir/** fence) — a real `parseString` → `generateHono` hop, still to migrate",
};

const PARSE_STRING_ALONGSIDE_DOTNET: Readonly<Record<string, string>> = {
  "test/generator/dotnet/intrinsic-math.test.ts":
    "a dedicated `parses + validates cleanly` case that asserts `errors` is empty itself; the five generate calls use `parseValid`",
  "test/generator/dotnet/intrinsic-strings.test.ts": "same — the phase-④ assertion IS the test",
  "test/generator/dotnet/intrinsic-trim.test.ts": "same — the phase-④ assertion IS the test",
  "test/generator/dotnet/temporal.test.ts": "same — the phase-④ assertion IS the test",
  "test/ir/collection-op-lambda-element-type.test.ts":
    "OWNED BY ANOTHER PACKET (test/ir/** fence) — a real `parseString` → `generateDotnet` hop, still to migrate",
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
 * Every test-tree file importing ONE legacy single-context generator from the
 * helper, its call count, and whether it also calls `parseString` — plus the
 * number of files scanned (the vacuous-pass guard).
 *
 * Per-gate rather than pooled: `paged-wire-parity` imports both, and a pooled
 * count would let a call migrate off one path onto the other without moving the
 * total.
 */
function census(gate: string): { rows: Row[]; scanned: number } {
  const rows: Row[] = [];
  let scanned = 0;

  for (const file of testFiles(testRoot)) {
    scanned++;
    const text = fs.readFileSync(file, "utf8");
    // Cheap prefilter — the AST parse below is the authority.
    if (!text.includes(gate)) continue;
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
            if ((el.propertyName ?? el.name).text === gate) imported.add(el.name.text);
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

/**
 * The two legacy single-context entry points, each with its own pinned columns.
 *
 * A third would be a third row here; the assertions below are written once.
 */
const GATES = [
  {
    gate: "generateHono",
    mission: "M-T9.48",
    pinned: PINNED_HONO,
    parseStringAlongside: PARSE_STRING_ALONGSIDE_HONO,
    minRows: 20,
  },
  {
    gate: "generateDotnet",
    mission: "M-T9.49",
    pinned: PINNED_DOTNET,
    parseStringAlongside: PARSE_STRING_ALONGSIDE_DOTNET,
    minRows: 25,
  },
] as const;

for (const { gate, mission, pinned, parseStringAlongside, minRows } of GATES) {
  describe(`legacy single-context \`${gate}\` callers under test/ (${mission})`, () => {
    const { rows, scanned } = census(gate);

    it("scans the whole test tree (guard against a vacuous pass)", () => {
      // If the walker silently stopped finding files, every assertion below
      // would pass on an empty set.
      expect(scanned).toBeGreaterThan(1_000);
      expect(rows.length).toBeGreaterThan(minRows);
    });

    it("no NEW file on the legacy single-context path", () => {
      const added = rows.map((r) => r.file).filter((f) => !(f in pinned));
      expect(
        added,
        `${added.length} test file(s) newly reach the legacy single-context generator. ` +
          `Use generateSystemFiles(source) instead — it emits through the orchestrator the ` +
          `CLI runs, asserts phases ①/④ as well as ⑤/⑥/⑦, and is the only path on which a ` +
          `hosted capability (TPH, audited, event-sourced, tenancy) can be expressed.`,
      ).toEqual([]);
    });

    it("no STALE pin (the file list ratchets down)", () => {
      const live = new Set(rows.map((r) => r.file));
      const gone = Object.keys(pinned).filter((f) => !live.has(f));
      expect(
        gone,
        `${gone.length} pinned file(s) no longer reach the legacy generator — delete their ` +
          `entries from the PINNED table in the same change that migrated them.`,
      ).toEqual([]);
    });

    it("the call-site count is pinned EXACTLY, so it can only shrink", () => {
      // Exact, not a ceiling: a ceiling lets a new call slip into an
      // already-pinned file, which is how 62 + 150 accumulated in the first
      // place.
      const live = Object.fromEntries(rows.map((r) => [r.file, r.calls]));
      expect(live).toEqual(pinned);
    });

    it("the total is pinned too (one number to watch shrink)", () => {
      const total = rows.reduce((n, r) => n + r.calls, 0);
      const expected = Object.values(pinned).reduce((n, c) => n + c, 0);
      expect(total, `legacy call sites: ${total} (pinned ${expected})`).toBe(expected);
    });

    it("every `parseString` → legacy-generate file carries a stated reason", () => {
      const live = rows.filter((r) => r.usesParseString).map((r) => r.file);
      const undocumented = live.filter((f) => !(f in parseStringAlongside));
      expect(
        undocumented,
        `${undocumented.length} file(s) call both parseString and the legacy generator with no ` +
          `reason recorded.  parseString asserts NEITHER phase ① nor phase ④, and the legacy ` +
          `wrapper cannot assert them for you (it takes a Model, not a source) — so reach for ` +
          `parseValid, or add an entry to the PARSE_STRING_ALONGSIDE table saying why this one ` +
          `is fine.`,
      ).toEqual([]);
      const stale = Object.keys(parseStringAlongside).filter((f) => !live.includes(f));
      expect(
        stale,
        `${stale.length} PARSE_STRING_ALONGSIDE entry/entries are stale — delete them in the ` +
          `same change that migrated the file to parseValid.`,
      ).toEqual([]);
    });
  });
}
