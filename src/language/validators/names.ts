// Unresolved bare-identifier check (`loom.unknown-name`).
//
// Finding 1 of docs/audits/full-code-review-2026-07.md: a `NameRef` is
// NOT a Langium cross-reference, so `typeOf` returns `unknown` for a bare
// identifier that resolves to nothing in scope — and EVERY downstream gate
// (`checkAssignOrCall`, `checkSingleBinaryOperands`, `checkEmit`, …)
// suppresses on `unknown` on the premise that an upstream checker has
// already reported it.  Nothing had.  `checkUnknownMemberAccess` closes the
// same hole for member *suffixes* (`order.totl`); this closes it for bare
// *heads* (`total := amout` → previously 0 errors, emitted `this._total =
// amout;`).
//
// Design — conservative by construction (FALSE POSITIVES ARE WORSE THAN THE
// BUG):
//
//   • A name is "resolvable" iff it appears somewhere as a *declaration /
//     binding* — the union of every `name` / `var` / `binding` / `param`
//     naming property across every loaded document (aggregates, value
//     objects, entity parts, enum *values*, events, payloads, repositories,
//     domain services, workflows + their state, criteria, retrievals,
//     resources, channels, this-properties / derived / containments,
//     functions, operations, parameters, `let` bindings, `for` / `if let`
//     loop vars, `match` variant bindings, lambda params) — plus the two
//     magic identifiers with no declaration node (`currentUser`,
//     `permissions`).  This is the exact vocabulary `resolveNameRef`
//     (src/ir/lower/lower-expr.ts) can resolve, collected from the AST
//     rather than re-implemented.  A bare head absent from ALL of it is the
//     typo the audit describes.
//
//   • We check ONLY inside the executable *domain* expression zones
//     (operation / create / destroy / function / derived / invariant /
//     property-check-default / workflow create·handle·on·apply bodies).
//     `test e2e` bodies (which render bare names verbatim by design — see
//     `resolveNameRef`'s "no ctx" arm) and `ui` walker bodies (a broad
//     stdlib + state vocabulary this check does not model) are allowlisted.
//
// The universe is a superset of what any single scope can see, so a name
// valid in a *different* scope suppresses the report (a false negative we
// accept) — but a name declared/bound *nowhere* is unambiguously the bug.

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import { DURATION_UNITS } from "../../util/temporal.js";
import type { DddServices } from "../ddd-module.js";
import {
  type BoundedContext,
  isBoundedContext,
  isEnumDecl,
  isNameRef,
  type Model,
} from "../generated/ast.js";

// Magic identifiers resolvable in an expression with no declaration node.
// `currentUser` is backed by the system `user { … }` block; `permissions`
// is the module-permissions namespace head (`permissions.<name>`); the A5
// duration constructors (`days`/`hours`/`minutes`) are free-call
// builtins.  All admitted unconditionally — a superset is safe (only ever
// masks a report, never invents one; the temporal validator owns the
// duration arity checks).
const MAGIC_NAMES: ReadonlySet<string> = new Set(["currentUser", "permissions", ...DURATION_UNITS]);

// Executable domain expression containers we validate inside.  These only
// ever nest under a domain declaration (aggregate / value object / entity
// part / workflow), never under a `ui` or `test`, so requiring one as an
// ancestor already excludes the allowlisted zones — SKIP_CONTAINERS is
// belt-and-suspenders.
const CHECKED_CONTAINERS: ReadonlySet<string> = new Set([
  "Operation",
  "Create",
  "Destroy",
  "FunctionDecl",
  "DerivedProp",
  "Invariant",
  "Property", // field `check:` / `default:` expressions
  "WorkflowCreateDecl",
  "HandleDecl",
  "OnDecl",
  "Apply",
]);

// Zones where a bare identifier is intentionally unresolved (`test e2e`
// bodies render verbatim) or draws on a vocabulary this check does not
// model (`ui` walker primitives + page/store state) — allowlisted.
const SKIP_CONTAINERS: ReadonlySet<string> = new Set(["Ui", "TestE2E"]);

/** Collect the `name` / `var` / `binding` / `param` naming properties of a
 *  single node.  `.name` is a *declaration* on every node EXCEPT `NameRef`,
 *  where it is the reference under validation — collecting it there would
 *  add the very typo to the universe and mask the report. */
function collectDeclNames(node: AstNode, into: Set<string>): void {
  const n = node as unknown as Record<string, unknown>;
  if (node.$type !== "NameRef" && typeof n.name === "string") into.add(n.name);
  if (typeof n.var === "string") into.add(n.var); // ForStmt / IfLetStmt
  if (typeof n.binding === "string") into.add(n.binding); // VariantArm
  if (typeof n.param === "string") into.add(n.param); // OnDecl / Apply / Lambda
}

/** Build the resolvable-name universe: every declaration / binding name in
 *  every loaded document, plus the cross-file exported symbol names from the
 *  workspace index, plus the magic identifiers. */
function buildNameUniverse(model: Model, services?: DddServices): Set<string> {
  const names = new Set<string>(MAGIC_NAMES);
  const roots: AstNode[] = [model];
  const docs = services?.shared.workspace.LangiumDocuments.all;
  if (docs) {
    for (const d of docs) {
      const root = d.parseResult?.value;
      if (root && root !== model) roots.push(root);
    }
  }
  for (const root of roots) {
    collectDeclNames(root, names);
    for (const node of AstUtils.streamAllContents(root)) collectDeclNames(node, names);
  }
  // Cross-file exported declarations that may not be among the loaded
  // document roots (kernel / library symbols surfaced through the index).
  const index = services?.shared.workspace.IndexManager;
  if (index) {
    for (const desc of index.allElements()) names.add(desc.name);
  }
  return names;
}

/** True iff `node` sits inside an executable domain expression zone and NOT
 *  inside an allowlisted (`ui` / `test`) zone. */
function inCheckedZone(node: AstNode): boolean {
  let checked = false;
  for (let cur = node.$container; cur; cur = cur.$container) {
    if (SKIP_CONTAINERS.has(cur.$type)) return false;
    if (CHECKED_CONTAINERS.has(cur.$type)) checked = true;
  }
  return checked;
}

// ---------------------------------------------------------------------------
// Suggested-fix hint — nearest in-scope name by Levenshtein distance.
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n]!;
}

/** Candidate names *in the immediate scope* for the "did you mean" hint —
 *  every declaration / binding reachable within the enclosing bounded
 *  context (its type members, params, locals, enum values) plus the magic
 *  names.  Scoped tighter than the flag universe so the suggestion points at
 *  something genuinely nearby rather than an unrelated cross-context name. */
function scopedCandidates(node: AstNode): Set<string> {
  const cands = new Set<string>(MAGIC_NAMES);
  const ctx: BoundedContext | undefined = AstUtils.getContainerOfType(node, isBoundedContext);
  const root: AstNode | undefined = ctx ?? AstUtils.findRootNode(node);
  if (root) {
    collectDeclNames(root, cands);
    for (const n of AstUtils.streamAllContents(root)) collectDeclNames(n, cands);
    // Enum *values* declared context-locally (their `.name` is already
    // collected by the sweep above, but keep the intent explicit).
    for (const m of ctx?.members ?? []) {
      if (isEnumDecl(m)) for (const v of m.values) cands.add(v.name);
    }
  }
  return cands;
}

/** Nearest candidate within a small edit distance, or undefined. */
function suggest(name: string, node: AstNode): string | undefined {
  let best: string | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  const max = Math.min(2, Math.floor(name.length / 2));
  if (max < 1) return undefined;
  for (const cand of scopedCandidates(node)) {
    if (cand === name || cand.length < 3) continue;
    const d = levenshtein(name, cand);
    if (d < bestDist && d <= max) {
      bestDist = d;
      best = cand;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------

/** Report a bare `NameRef` head (in an executable domain expression) that
 *  resolves to nothing in scope — the finding-1 typo hole. */
export function checkUnknownNameRefs(
  model: Model,
  accept: ValidationAcceptor,
  services?: DddServices,
): void {
  // Scope-incomplete guard: if the document has ANY unresolved cross-
  // reference (a missing `import` target, an unresolvable enum / value-object
  // type, …), the name universe is provably incomplete — a bare name could
  // be a value of an enum we simply can't see (e.g. a multi-file project
  // parsed standalone, before its kernel loads).  Reporting an unknown name
  // there would false-positive, so stay silent; the unresolved references
  // are already reported.  A genuine typo is a `NameRef` (not a cross-
  // reference), so a clean file with a typo still trips the check below.
  const doc = AstUtils.getDocument(model);
  if ((doc.references ?? []).some((r) => r.error !== undefined)) return;

  const universe = buildNameUniverse(model, services);
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isNameRef(node)) continue;
    const name = node.name;
    if (universe.has(name)) continue;
    if (!inCheckedZone(node)) continue;
    const hint = suggest(name, node);
    accept(
      "error",
      hint
        ? `Unknown name '${name}' — did you mean '${hint}'?`
        : `Unknown name '${name}' — no parameter, local, field, enum value, or declaration with this name is in scope.`,
      { node, property: "name", code: "loom.unknown-name" },
    );
  }
}
