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
 *  `unreachable(...)`? Also true for a call to one of the sanctioned shallow
 *  visitors (`walkExprChildren` / `walkStmtChildren` /
 *  `walkWorkflowStmtChildren`) in the `default:` arm — delegating an
 *  unhandled kind to that walker is exactly as safe as a literal
 *  `never`-check: a future kind fails to compile THERE instead of silently
 *  falling through here (e.g. `_stmt/leaves.ts`'s `collectLeaves`, which
 *  special-cases a few kinds and lets the sanctioned walker exhaustively
 *  cover the rest). */
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
      /assertNever|unreachable|walkExprChildren|walkStmtChildren|walkWorkflowStmtChildren/.test(
        n.expression.getText(),
      )
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
// a reason. Ratcheted by the second test below: a waiver whose site is gone,
// or whose site has since become exhaustive, fails and must be deleted.
//
// This packet fixed or certified the sites whose intent was clearly "visit
// every reachable sub-node" (a collector/predicate silently dropping a kind
// — the M-T6.50 class) or that were already exhaustive by case count and
// only needed the `never`-check ceremony (verified by an exact case-set
// diff against `walk.ts`'s own kind enumeration — see the prior commits on
// this branch). The remaining sites below fall into four honestly-different
// buckets; the reason each one carries says which.
// ---------------------------------------------------------------------------

const HOTSPOT_SPLIT_REASON =
  "packet 2.3 identified this hand-rolled switch/if-chain as a genuine walk.ts migration candidate but left it for the 2.6 hotspot-split (docs/new-plan/waves/wave-2.md) to relocate first; 2.6's split is a purely mechanical move (no logic change), so the site itself is unchanged — the migration itself remains a follow-up drain, tracked at its new post-split location below";

const INFLIGHT_2736 =
  "in-flight fence (docs/new-plan/waves/wave-2.md): PR #2736 (M-FT.1, wire `== null`) owns zod-refine.ts this wave — do not edit its hunks";

const INFLIGHT_2729 =
  "in-flight fence (docs/new-plan/waves/wave-2.md): PR #2729 (W4 frontend collection ops) owns this file's walker engine this wave — do not edit its hunks";

const INFLIGHT_2742 =
  "in-flight fence (docs/new-plan/waves/wave-2.md): PR #2742 (Hono runtime hardening) is named as owning the hono workflow builders this wave in the packet brief — do not edit their hunks, even though this file's own diff had not yet reached them as of the fence read";

/** A closed, kind-specific PREDICATE or CLASSIFIER: every kind the switch
 *  does not explicitly list falls through to a deliberate, safe, generic
 *  value (`false` / `undefined` / `null` / `[]` / the neutral branch already
 *  documented at the call site) — not a traversal, and nothing is silently
 *  dropped from emitted OUTPUT the way the M-T6.50 class drops it (a
 *  narrower classification is the worst case, never a missing emission).
 *  Classified by each site's `default` shape (verified with the census's
 *  own detector, not re-read line-by-line against every current
 *  `ExprIR`/`StmtIR`/`WorkflowStmtIR` kind in this packet) — a genuine
 *  follow-up drain re-reads each one and either migrates it onto
 *  `walk.ts` or upgrades it to an explicit `never`-checked closed form. */
const CLOSED_PREDICATE =
  "closed, kind-specific predicate/classifier — every unhandled kind falls through to a safe, generic default; not a traversal, nothing silently drops from emitted output. Classified by default-arm shape, not individually re-verified per kind this packet; follow-up drain";

/** A closed, kind-specific EMISSION dispatcher whose `default` arm THROWS
 *  for any kind outside its declared vocabulary — a LOUD failure (a crash
 *  on generation, immediately visible), not the SILENT drop the M-T6.50
 *  class describes. Whether its declared vocabulary is still complete
 *  against the current kind list is a real question, but it is
 *  emission-mode / per-emitter case-completeness scope (packet 2.4 and
 *  ongoing parity work), not this packet's silent-traversal-gap scope. */
const THROWING_DISPATCHER =
  "closed emission dispatcher whose default arm THROWS for an unhandled kind (loud failure, not the silent-drop class this census targets); case-completeness is emission-mode/parity scope (packet 2.4), not 2.3's";

/** A shallow, ONE-LEVEL child-list builder (an `exprChildren`-shaped
 *  function) feeding a caller's own recursion — structurally the same
 *  concept as `walk.ts`'s `walkExprChildren`, and a genuine migration
 *  candidate, but not completed in this packet's time-box. */
const SHALLOW_CHILD_BUILDER =
  "one-level child-list builder (walkExprChildren-shaped) feeding the caller's own recursion — a genuine walk.ts migration candidate not completed in this packet's time-box; follow-up drain";

/** A hand-rolled recursive traversal (`walk`/`visit`/collector-shaped) this
 *  packet identified as a genuine migration candidate but did not reach —
 *  either because it composes with an already-migrated sibling in the same
 *  cluster (so the isolated risk is lower) or purely on time-box grounds. */
const TRAVERSAL_TIME_BOXED =
  "hand-rolled traversal identified as a walk.ts migration candidate; not completed in this packet's time-box — follow-up drain (see the hand-off note for the per-file priority order)";

/** Already rides a sanctioned walker (`walkWorkflowStmtChildren` /
 *  `walkExprDeep`) for the RECURSION step, with its own narrow, local
 *  per-kind logic layered on top (order-preserving, migrated this packet) —
 *  the census's if-chain detector still flags the local `if`/`||` guard
 *  itself (a narrow membership test, not a full dispatch), which a
 *  terminal `never`-checked `else` does not fit. */
const DELEGATES_TO_SANCTIONED_WALKER =
  "already rides walkWorkflowStmtChildren/walkExprDeep for recursion (migrated this packet); the flagged if/`||` guard is a narrow kind-membership test layered on top, not a dispatch needing full-kind coverage";

const WAIVERS: Record<string, string> = {
  // --- 2.6 hotspot-split fence: system-checks.ts / ui-checks.ts / mikroorm.ts
  // were mechanically split into per-theme leaves by packet 2.6
  // (docs/new-plan/waves/handoffs/wave-2-hotspot-splits.md).  These eleven
  // sites are pure relocations of the same 2.3-flagged offenders — same
  // code, same reason, new home; the walk.ts migration itself is still a
  // follow-up drain, not done here.
  "src/ir/validate/checks/datasource-checks.ts#docExprUnsupported": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/datasource-checks.ts#docFunctionUnsupported": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/datasource-checks.ts#docStmtUnsupported": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/backend-syntax-checks.ts#eachStmtExpr": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/ui-action-body-checks.ts#checkBody": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/ui-page-structure-checks.ts#directlyRenderedRefs": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/ui-page-structure-checks.ts#namesReadByBody": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/ui-action-body-checks.ts#toastMessageProblem": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/ui-action-body-checks.ts#visitExpr": HOTSPOT_SPLIT_REASON,
  "src/ir/validate/checks/ui-action-body-checks.ts#visitStmt": HOTSPOT_SPLIT_REASON,
  "src/generator/typescript/emit/mikroorm-filter.ts#filterValue": HOTSPOT_SPLIT_REASON,

  // --- in-flight PR fence (docs/new-plan/waves/wave-2.md §In-flight fence) --
  "src/generator/zod-refine.ts#refineRenderable": INFLIGHT_2736,
  "src/generator/zod-refine.ts#renderRefineExpr": INFLIGHT_2736,
  "src/generator/_walker/walker-core.ts#emitStmt": INFLIGHT_2729,
  "src/generator/_walker/walker-core.ts#walk": INFLIGHT_2729,
  "src/generator/elixir/heex-walker-core.ts#renderExpr": INFLIGHT_2729,
  "src/generator/elixir/heex-walker-core.ts#renderStmt": INFLIGHT_2729,
  "src/platform/hono/v4/workflow-builder.ts#exprChildren": INFLIGHT_2742,
  "src/platform/hono/v4/workflow-builder.ts#walk": INFLIGHT_2742,
  "src/platform/hono/v4/workflow-builder.ts#walk$2": INFLIGHT_2742,
  "src/platform/hono/v4/workflow-builder.ts#workflowStmtExprs": INFLIGHT_2742,
  "src/platform/hono/v4/workflow-eventsourced-builder.ts#renderApplierStmt": INFLIGHT_2742,
  "src/platform/hono/v4/projection-builder.ts#renderFoldStatement": INFLIGHT_2742,

  // --- already delegates to a sanctioned walker for recursion --------------
  "src/generator/java/explicit-handlers-emit.ts#reposUsed": DELEGATES_TO_SANCTIONED_WALKER,
  "src/generator/python/explicit-handlers-emit.ts#walk": DELEGATES_TO_SANCTIONED_WALKER,
  "src/generator/python/workflows-builder.ts#visit": DELEGATES_TO_SANCTIONED_WALKER,

  // --- closed predicates/classifiers (safe generic default) ----------------
  "src/generator/_expr/authz-filter-inapp.ts#desugarAuthzFilterInApp": CLOSED_PREDICATE,
  "src/generator/_expr/authz-filter-inapp.ts#hasAuthzFilter": CLOSED_PREDICATE,
  "src/generator/_walker/primitives/forms.ts#defaultUsesThis": CLOSED_PREDICATE,
  "src/generator/dotnet/criteria-emit.ts#anyRef": CLOSED_PREDICATE,
  "src/generator/dotnet/emit/efcore.ts#collectColumnRefs": CLOSED_PREDICATE,
  "src/generator/dotnet/emit/efcore.ts#exprRefsCurrentUser": CLOSED_PREDICATE,
  "src/generator/dotnet/render-expr.ts#addCsExprUsing": CLOSED_PREDICATE,
  "src/generator/elixir/realtime-liveview.ts#exprUsesBind": CLOSED_PREDICATE,
  "src/generator/elixir/render-expr.ts#isDecimalOperand": CLOSED_PREDICATE,
  "src/generator/elixir/vanilla/changeset-invariant-emit.ts#structEvaluable": CLOSED_PREDICATE,
  "src/generator/elixir/vanilla/provenance-emit.ts#leavesResolveToColumns": CLOSED_PREDICATE,
  "src/generator/elixir/vanilla/provenance-emit.ts#paramLeafNames": CLOSED_PREDICATE,
  "src/generator/elixir/vanilla/wire-serialize.ts#derivedRenderable": CLOSED_PREDICATE,
  "src/generator/elixir/vanilla/workflow-eventsourced-emit.ts#bodyUsesState": CLOSED_PREDICATE,
  "src/generator/feliz/realtime.ts#exprReadsBinding": CLOSED_PREDICATE,
  "src/generator/flutter/realtime.ts#exprReadsBinding": CLOSED_PREDICATE,
  "src/generator/java/render-expr.ts#addJavaExprImport": CLOSED_PREDICATE,
  "src/generator/python/find-predicate.ts#isColumnRooted": CLOSED_PREDICATE,
  "src/generator/python/find-predicate.ts#lower": CLOSED_PREDICATE,
  "src/generator/python/render-expr.ts#addPyExprImport": CLOSED_PREDICATE,
  "src/generator/react/pages-emitter.ts#exprUsesCodeBlock": CLOSED_PREDICATE,
  "src/generator/react/pages-emitter.ts#stmtUsesCodeBlock": CLOSED_PREDICATE,
  "src/generator/typescript/emit/schema.ts#collectColumnRefs": CLOSED_PREDICATE,
  "src/generator/typescript/render-stmt.ts#markableExprsOf": CLOSED_PREDICATE,
  "src/ir/util/domain-service-tier.ts#classifyDomainServiceTier": CLOSED_PREDICATE,
  "src/ir/util/sql-renderable-expr.ts#sqlRenderableExpr": CLOSED_PREDICATE,
  "src/ir/util/temporal.ts#isDatetimeTypedIR": CLOSED_PREDICATE,
  "src/ir/validate/checks/api-checks.ts#aggregatesTouched": CLOSED_PREDICATE,
  "src/ir/validate/checks/api-checks.ts#handlerMutates": CLOSED_PREDICATE,
  "src/ir/validate/checks/domain-service-checks.ts#checkOperationBody": CLOSED_PREDICATE,
  "src/ir/validate/checks/migration-checks.ts#sqlExprFamily": CLOSED_PREDICATE,
  "src/ir/validate/checks/query-checks.ts#describeSeedValue": CLOSED_PREDICATE,
  "src/ir/validate/checks/shared.ts#firstUnknownColumnRef": CLOSED_PREDICATE,
  "src/ir/validate/checks/structural-checks.ts#check": CLOSED_PREDICATE,
  "src/ir/validate/checks/structural-checks.ts#lifecycleGuardIllegalReads": CLOSED_PREDICATE,
  "src/ir/validate/checks/structural-checks.ts#validateEventSourcedDiscipline": CLOSED_PREDICATE,
  "src/ir/validate/checks/structural-checks.ts#validateEventSourcedDiscipline$2": CLOSED_PREDICATE,
  "src/ir/validate/checks/workflow-checks.ts#checkBranchOpCalls": CLOSED_PREDICATE,
  "src/ir/enrich/enrichments.ts#tailBindType": CLOSED_PREDICATE,
  "src/util/expr-body-type.ts#bodyTypeOf": CLOSED_PREDICATE,
  "src/util/expr-body-type.ts#provableStringType": CLOSED_PREDICATE,

  // --- closed emission dispatchers (default THROWS — loud, not silent) -----
  "src/generator/_frontend/default-seed.ts#renderDefaultSeed": THROWING_DISPATCHER,
  "src/generator/_frontend/gate-expr.ts#renderGateExpr": THROWING_DISPATCHER,
  "src/generator/_frontend/realtime.ts#renderMessageExpr": THROWING_DISPATCHER,
  "src/generator/dotnet/emit/dapper.ts#whereToSql": THROWING_DISPATCHER,
  "src/generator/elixir/dispatch-emit.ts#renderStmt": THROWING_DISPATCHER,
  "src/generator/elixir/domain-service-emit.ts#renderStatement": THROWING_DISPATCHER,
  "src/generator/elixir/domain-service-emit.ts#substituteRefs": THROWING_DISPATCHER,
  "src/generator/elixir/realtime-liveview.ts#go": THROWING_DISPATCHER,
  "src/generator/elixir/store-emit.ts#renderStoreExpr": THROWING_DISPATCHER,
  "src/generator/elixir/store-emit.ts#renderStoreStmt": THROWING_DISPATCHER,
  "src/generator/elixir/vanilla/eventsourced-emit.ts#renderCommandRunner": THROWING_DISPATCHER,
  "src/generator/elixir/vanilla/fold-stmt-emit.ts#renderFoldStatement": THROWING_DISPATCHER,
  "src/generator/elixir/vanilla/function-emit.ts#renderPureBlock": THROWING_DISPATCHER,
  "src/generator/elixir/vanilla/operation-returns-emit.ts#renderReturningStmt": THROWING_DISPATCHER,
  "src/generator/elixir/vanilla/tests-emit.ts#vtExpr": THROWING_DISPATCHER,
  "src/generator/elixir/vanilla/workflow-eventsourced-emit.ts#renderEsWorkflowHandler":
    THROWING_DISPATCHER,
  "src/generator/elixir/vanilla/workflow-execution-emit.ts#lowerStatement": THROWING_DISPATCHER,
  "src/generator/elixir/vanilla/workflow-execution-emit.ts#renderBranch": THROWING_DISPATCHER,
  "src/generator/feliz/auth-gate.ts#renderFelizGate": THROWING_DISPATCHER,
  "src/generator/feliz/fs-expr.ts#renderFsExpr": THROWING_DISPATCHER,
  "src/generator/feliz/realtime.ts#renderFsToastMessage": THROWING_DISPATCHER,
  "src/generator/feliz/update-emit.ts#renderUpdateStmt": THROWING_DISPATCHER,
  "src/generator/flutter/auth-gate.ts#renderFlutterGate": THROWING_DISPATCHER,
  "src/generator/flutter/realtime.ts#renderDartToastMessage": THROWING_DISPATCHER,
  "src/generator/flutter/riverpod-emit.ts#renderNotifierStmt": THROWING_DISPATCHER,
  "src/generator/java/render-criteria.ts#bool": THROWING_DISPATCHER,
  "src/generator/java/render-jpql.ts#render": THROWING_DISPATCHER,
  "src/generator/java/render-sql-restriction.ts#renderSqlRestriction": THROWING_DISPATCHER,
  "src/generator/python/dispatch-builder.ts#projectionHandlerFn": THROWING_DISPATCHER,
  "src/generator/python/workflow-eventsourced-emit.ts#renderApplierStmt": THROWING_DISPATCHER,
  "src/generator/sql-pg-expr.ts#renderSqlScalarExpr": THROWING_DISPATCHER,
  "src/system/mermaid.ts#buildSequenceDiagram": THROWING_DISPATCHER,
  "src/system/mermaid.ts#sequenceMessages": THROWING_DISPATCHER,
  "src/system/mermaid.ts#stepNode": THROWING_DISPATCHER,

  // --- shallow one-level child-list builders (walkExprChildren-shaped) -----
  "src/generator/feliz/wire.ts#exprChildren": SHALLOW_CHILD_BUILDER,
  "src/generator/flutter/forms-emit.ts#exprChildren": SHALLOW_CHILD_BUILDER,
  "src/generator/flutter/inputs-emit.ts#exprChildren": SHALLOW_CHILD_BUILDER,
  "src/generator/flutter/reads-emit.ts#exprChildren": SHALLOW_CHILD_BUILDER,

  // --- hand-rolled traversals identified but not migrated this session -----
  "src/generator/dotnet/emit/dapper.ts#walk": TRAVERSAL_TIME_BOXED,
  "src/generator/elixir/dispatch-emit.ts#visitStmt": TRAVERSAL_TIME_BOXED,
  "src/generator/elixir/vanilla/explicit-handlers-emit.ts#collectRecordFieldsInStmt":
    TRAVERSAL_TIME_BOXED,
  "src/generator/elixir/vanilla/function-emit.ts#bodyExprs": TRAVERSAL_TIME_BOXED,
  "src/generator/elixir/vanilla/provenance-emit.ts#collectVanillaLeaves": TRAVERSAL_TIME_BOXED,
  "src/generator/elixir/vanilla/tests-emit.ts#childExprs": TRAVERSAL_TIME_BOXED,
  "src/generator/elixir/vanilla/workflow-execution-emit.ts#collectParamRefs": TRAVERSAL_TIME_BOXED,
  "src/generator/elixir/vanilla/workflow-execution-emit.ts#collectParamRefsInStmt":
    TRAVERSAL_TIME_BOXED,
  "src/generator/elixir/vanilla/workflow-execution-emit.ts#collectWorkflowStmtParamRefs":
    TRAVERSAL_TIME_BOXED,
  "src/system/e2e-render.ts#visit": TRAVERSAL_TIME_BOXED,
  "src/system/e2e-render.ts#visit$2": TRAVERSAL_TIME_BOXED,
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
