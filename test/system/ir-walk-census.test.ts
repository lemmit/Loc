import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Wave 2 packet 2.3 — "no hand-rolled IR walks" (docs/new-plan/improvement-
// waves-2026-09.md §Wave 2 item 2.3).
//
// The defect class this closes (#2720, #2705, M-T6.50): a collector or
// emitter hand-rolls a `switch (e.kind)` / `switch (s.kind)` over
// `ExprIR`/`StmtIR`/`WorkflowStmtIR` (or the equivalent `if (x.kind ===
// "a") … else if (x.kind === "b") …` chain), the union grows a new member,
// and the switch silently falls through its `default` — a `currentUser`
// hidden in a `match` arm never threads the auth param, a `repo-read` nested
// in a for-each body never derives a read-port, an emitter drops a whole
// construct with no compiler signal.  `src/ir/util/walk.ts` is the shared,
// `never`-checked shallow walker every TRAVERSAL should ride instead of
// re-deriving its own child enumeration; but a KIND-SPECIFIC DISPATCH (an
// emitter choosing what to render per kind) is not itself wrong — it only
// needs to prove, at compile time, that it does not silently drop a kind it
// doesn't recognise.
//
// THE DETECTOR (documented, per the packet brief, since this is a judgment
// call). Two shapes, both over a receiver whose static type is exactly
// (or includes) `ExprIR` / `StmtIR` / `WorkflowStmtIR` — verified with the
// real TypeScript checker, not a variable-name guess, so a switch over an
// unrelated `.kind` field (`TypeIR.kind`, `AuthzFilterKind`, `PageLayoutIR`,
// …) reusing a common receiver name (`e`, `s`, `node`, …) is never counted:
//
//   1. `switch (<recv>.kind) { … }`
//   2. an `if (<recv>.kind === "a") { … } else if (<recv>.kind === "b") …`
//      chain (constant-string comparisons, `||`-joined conditions included)
//      that names >= 3 DISTINCT kind literals on the same receiver — three
//      is the line because two arms reads as an ordinary two-way branch, not
//      a hand-rolled dispatch that will silently miss a fourth kind.
//
// EXHAUSTIVE means the site provably cannot compile once a new union member
// appears without either handling it or being touched: a `default` clause
// (switch) or terminal, condition-less `else` (if-chain) that assigns the
// receiver to a `: never`-typed binding, or calls a function whose name
// contains "assertNever" or "unreachable" — the exact idiom `walk.ts`
// already uses (`const _exhaustive: never = e; void _exhaustive;`), or the
// literal `satisfies Record<Kind, …>` table shape (a switch REPLACED by a
// table dispatch is, by construction, no longer a switch this census can
// even see — so a migration to that shape drops out of the census on its
// own; nothing further to check here).
//
// A site that is not exhaustive is either FIXED (migrated onto
// `walk.ts`'s `walk*Deep` helpers when its intent is "visit every reachable
// sub-node", or given a `never`-checked default when its intent is a closed,
// kind-specific dispatch) or WAIVED below with a specific, honest reason.
// Waivers RATCHET (CLAUDE.md Conventions): a waiver whose site no longer
// exists, or whose site has since become exhaustive, fails the second test
// below — so a stale entry cannot silently outlive the code it excuses.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const TARGET_UNIONS = ["ExprIR", "StmtIR", "WorkflowStmtIR"] as const;
type TargetUnion = (typeof TARGET_UNIONS)[number];

/** The four sanctioned dispatchers (own the ONE 17/11/10-arm switch each, by
 *  design) plus the lowerers (`src/ir/lower/**`, which build IR — not walk
 *  it — and are exempted by the packet brief). */
const SANCTIONED_FILES = new Set<string>([
  "src/ir/util/walk.ts",
  "src/generator/_expr/target.ts",
  "src/generator/_stmt/target.ts",
  "src/generator/_workflow/stmt-target.ts",
]);

function isSanctioned(rel: string): boolean {
  if (SANCTIONED_FILES.has(rel)) return true;
  if (rel.startsWith("src/ir/lower/")) return true;
  return false;
}

interface Site {
  /** Stable-ish key: `<relFile>#<enclosingName>[$N]` — survives line churn
   *  elsewhere in the file, unlike a `file:line` waiver key. */
  id: string;
  file: string;
  line: number;
  union: TargetUnion;
  form: "switch" | "if-chain";
  exhaustive: boolean;
}

function typeNameMatches(checker: ts.TypeChecker, t: ts.Type): TargetUnion | null {
  const str = checker.typeToString(t, undefined, ts.TypeFormatFlags.None);
  for (const name of TARGET_UNIONS) {
    if (new RegExp(`\\b${name}\\b`).test(str)) return name;
  }
  return null;
}

/** Nearest enclosing named function-ish construct, walking up the parent
 *  chain — used only to build a readable, edit-stable waiver key. */
function enclosingName(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (
      ts.isVariableDeclaration(cur) &&
      ts.isIdentifier(cur.name) &&
      cur.initializer &&
      (ts.isArrowFunction(cur.initializer) || ts.isFunctionExpression(cur.initializer))
    ) {
      return cur.name.text;
    }
    cur = cur.parent;
  }
  return "<module>";
}

/** Does `stmts` (recursively) contain a `never`-typed exhaustiveness check —
 *  either `const _x: never = <recv>;` or a call to `assertNever(...)` /
 *  `unreachable(...)`? */
function hasNeverCheck(node: ts.Node): boolean {
  let found = false;
  function visit(n: ts.Node) {
    if (found) return;
    if (
      ts.isVariableDeclaration(n) &&
      n.type &&
      ((ts.isTypeReferenceNode(n.type) && n.type.typeName.getText() === "never") ||
        n.type.kind === ts.SyntaxKind.NeverKeyword)
    ) {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(n) &&
      /assertNever|unreachable/i.test(n.expression.getText())
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

let cachedSites: Site[] | null = null;

/** Scan `src/**\/*.ts` with the real TypeScript checker (so a `.kind` switch
 *  on an unrelated discriminated union never counts) and return every
 *  offending switch / if-chain site outside the sanctioned homes. Computed
 *  once — a full-program typecheck of `src/` — and cached for the whole
 *  test file. */
function computeSites(): Site[] {
  if (cachedSites) return cachedSites;

  const configPath = path.join(repoRoot, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();

  const sites: Site[] = [];
  const idCounts = new Map<string, number>();
  function nextId(base: string): string {
    const n = (idCounts.get(base) ?? 0) + 1;
    idCounts.set(base, n);
    return n === 1 ? base : `${base}$${n}`;
  }

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const rel = path.relative(repoRoot, sf.fileName).replaceAll(path.sep, "/");
    if (!rel.startsWith("src/")) continue;
    if (isSanctioned(rel)) continue;

    function lineOf(node: ts.Node): number {
      return sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    }

    function visit(node: ts.Node) {
      // --- Form 1: switch (<recv>.kind) { … } ---
      if (ts.isSwitchStatement(node)) {
        const expr = node.expression;
        if (ts.isPropertyAccessExpression(expr) && expr.name.text === "kind") {
          const union = typeNameMatches(checker, checker.getTypeAtLocation(expr.expression));
          if (union) {
            const defaultClause = node.caseBlock.clauses.find((c) => ts.isDefaultClause(c));
            const exhaustive = !!defaultClause && defaultClause.statements.some(hasNeverCheck);
            const base = `${rel}#${enclosingName(node)}`;
            sites.push({
              id: nextId(base),
              file: rel,
              line: lineOf(node),
              union,
              form: "switch",
              exhaustive,
            });
          }
        }
      }

      // --- Form 2: if (<recv>.kind === "a") … else if (<recv>.kind === "b") … ---
      // Only inspect chain HEADS (not an else-if link already covered by its
      // parent's walk) so a 4-armed chain reports once, not four times.
      if (ts.isIfStatement(node)) {
        const isElseIfContinuation =
          !!node.parent && ts.isIfStatement(node.parent) && node.parent.elseStatement === node;
        if (!isElseIfContinuation) {
          type Hit = { recv: string; lit: string; recvNode: ts.Node };
          function condHits(expr: ts.Expression, out: Hit[]) {
            if (ts.isBinaryExpression(expr)) {
              if (expr.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
                condHits(expr.left, out);
                condHits(expr.right, out);
                return;
              }
              if (
                (expr.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
                  expr.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) &&
                ts.isPropertyAccessExpression(expr.left) &&
                expr.left.name.text === "kind" &&
                ts.isStringLiteralLike(expr.right)
              ) {
                out.push({
                  recv: expr.left.expression.getText(),
                  lit: expr.right.text,
                  recvNode: expr.left.expression,
                });
              }
            }
          }

          // Walk the if/else-if chain, collecting every kind-literal
          // comparison and, separately, whether the chain ends in a bare
          // `else { … }` (no further condition) that carries a never-check.
          let cursor: ts.IfStatement = node;
          const hits: Hit[] = [];
          let terminalElseExhaustive = false;
          let sawTerminalElse = false;
          for (;;) {
            condHits(cursor.expression, hits);
            const nxt = cursor.elseStatement;
            if (!nxt) break;
            if (ts.isIfStatement(nxt)) {
              cursor = nxt;
              continue;
            }
            sawTerminalElse = true;
            terminalElseExhaustive = hasNeverCheck(nxt);
            break;
          }

          const byRecv = new Map<string, { lits: Set<string>; recvNode: ts.Node }>();
          for (const h of hits) {
            if (!byRecv.has(h.recv)) byRecv.set(h.recv, { lits: new Set(), recvNode: h.recvNode });
            byRecv.get(h.recv)?.lits.add(h.lit);
          }
          for (const [, info] of byRecv) {
            if (info.lits.size < 3) continue;
            const union = typeNameMatches(checker, checker.getTypeAtLocation(info.recvNode));
            if (!union) continue;
            const base = `${rel}#${enclosingName(node)}`;
            sites.push({
              id: nextId(base),
              file: rel,
              line: lineOf(node),
              union,
              form: "if-chain",
              exhaustive: sawTerminalElse && terminalElseExhaustive,
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    }
    visit(sf);
  }

  cachedSites = sites;
  return sites;
}

// ---------------------------------------------------------------------------
// Waivers — every entry names the exact site (file + enclosing function) and
// a reason. Ratcheted by the second test below.
// ---------------------------------------------------------------------------

const HOTSPOT_SPLIT_REASON =
  "packet 2.6 splits this file into per-theme leaves after 2.3 folds (docs/new-plan/waves/wave-2.md) — re-triage post-split";

const WAIVERS: Record<string, string> = {
  // Excluded from migration by the packet brief verbatim: 2.6 splits these
  // three hotspot files: split first, then census+fix each leaf on its own.
  "src/ir/validate/checks/system-checks.ts#collectRepoLetIds": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/system-checks.ts#collectRepoLetIds$2": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/system-checks.ts#<module>": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/system-checks.ts#<module>$2": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/ui-checks.ts#<module>": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/ui-checks.ts#<module>$2": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/ui-checks.ts#<module>$3": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/ui-checks.ts#<module>$4": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/ui-checks.ts#<module>$5": HOTSPOT_SPLIT_REASON,
  "src/generator/typescript/emit/mikroorm.ts#<module>": HOTSPOT_SPLIT_REASON,
};

describe("IR walk census — no hand-rolled switch/if-chain over ExprIR/StmtIR/WorkflowStmtIR", () => {
  const sites = computeSites();

  it("finds a substantial surface, not an empty one", () => {
    // The blind-analysis guard every census in this repo carries (see
    // `expr-site-census.test.ts`): a broken detector reports zero sites,
    // which reads as "every switch is exhaustive" to anyone who checks this
    // test's colour instead of its count.
    expect(sites.length).toBeGreaterThan(80);
    expect(sites.filter((s) => s.form === "switch").length).toBeGreaterThan(70);
  });

  it("every offending site is exhaustive or waived", () => {
    const failures: string[] = [];
    for (const s of sites) {
      if (s.exhaustive) continue;
      if (Object.hasOwn(WAIVERS, s.id)) continue;
      failures.push(
        `${s.id} (${s.file}:${s.line}) — hand-rolled ${s.form} over ${s.union}.kind with no ` +
          `default:never / assertNever arm and no waiver. Either migrate onto ` +
          `src/ir/util/walk.ts's walk*Deep helpers (if the intent is "visit every ` +
          `reachable node") or add a never-checked default/else arm (if it is a ` +
          `closed, kind-specific dispatch), or waive it here with a reason.`,
      );
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("waivers ratchet — every entry still names a real, still-non-exhaustive site", () => {
    const byId = new Map(sites.map((s) => [s.id, s]));
    const stale: string[] = [];
    for (const id of Object.keys(WAIVERS)) {
      const s = byId.get(id);
      if (!s) {
        stale.push(`${id} — no such site found any more (delete the waiver)`);
        continue;
      }
      if (s.exhaustive) {
        stale.push(`${id} — site is now exhaustive (delete the waiver)`);
      }
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });

  it("never counts a switch on an unrelated `.kind` field sharing a receiver name", () => {
    // `TypeIR.kind`, `AuthzFilterKind`, `PageLayoutIR.kind`, `LoadPlanIR.kind`
    // and friends all reuse the same common receiver names (`e`, `s`, `node`,
    // `t`) the naive `grep -E "switch \\((e|s|node)\\.kind\\)"` baseline this
    // packet started from cannot distinguish. The type-checked detector must
    // not attribute e.g. `switch (e.filter.kind)` (an `AuthzFilterKind`
    // discriminant nested inside an `authz-filter` ExprIR) to `ExprIR` itself.
    const falsePositive = sites.find(
      (s) => s.file === "src/generator/_expr/authz-filter-inapp.ts" && s.line === 1,
    );
    expect(falsePositive).toBeUndefined();
  });

  it("attributes a switch by its receiver's real type, not its variable name", () => {
    // `isDecimalOperand` switches on a param named `operand` — outside the
    // naive baseline's `(e|expr|s|stmt|node|st|ex)` name list, but a real
    // `ExprIR.kind` dispatch the census must still catch.
    const found = sites.find(
      (s) => s.file === "src/generator/elixir/render-expr.ts" && s.union === "ExprIR",
    );
    expect(found).toBeDefined();
  });
});
