// ---------------------------------------------------------------------------
// `if` statement placement gates (M-FT.11).
//
// The `if <cond> { … } else { … }` STATEMENT renders on the four backends that
// share the `_stmt/target.ts` spine — node (Hono), dotnet, java, python.  Two
// places it can be WRITTEN do not render it, and both would be SILENT without a
// gate here (the repo's rule: a gap is either implemented or it carries a
// `loom.*` code — never a dropped statement):
//
//  1. A context hosted by an ELIXIR backend.  Every Phoenix body renderer
//     threads its result through a rebound `record` (Elixir is immutable, so an
//     assignment is a rebind), and a binding made inside an `if` block does NOT
//     escape that block.  A branch that assigns would compile and then do
//     nothing at runtime.  Rendering it correctly means making each branch
//     value-producing (`record = if … do … record else record end`) in every
//     vanilla body renderer — its own slice.
//
//  2. A UI page / component / store body, on ANY frontend.  A page body is an
//     expression tree: it expresses a condition as a VALUE (a ternary or
//     `match`), and the JS walker / Feliz update / Flutter notifier / HEEx
//     handler emitters each have no statement-position conditional.  They fail
//     fast on an unknown statement kind, so without this gate the author gets a
//     codegen crash instead of a diagnostic.
//
// Both gates are placement-only: the statement itself is already lowered and
// validated like any other.  When a target learns to render it, delete its arm
// here (and its defensive `throw`) in the same PR — the gate ratchets.
// ---------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import type { EnrichedLoomModel, StmtIR } from "../../types/loom-ir.js";
import { walkExprStmtsDeep, walkStmtDeep } from "../../util/walk.js";
import type { LoomDiagnostic } from "./diagnostic.js";

/** True when any statement in `stmts` (or nested in one of them, or in a
 *  block-body lambda one of them carries) is an `if`. */
function containsIf(stmts: readonly StmtIR[]): boolean {
  let found = false;
  for (const s of stmts) {
    walkStmtDeep(s, (n) => {
      if (n.kind === "if") found = true;
    });
  }
  return found;
}

export function validateIfStatementPlacement(
  loom: EnrichedLoomModel,
  diags: LoomDiagnostic[],
): void {
  validateElixirIfSupport(loom, diags);
  validatePageBodyIf(loom, diags);
}

/** Gate 1 — an `if` in a domain body whose context an elixir deployable emits. */
function validateElixirIfSupport(loom: EnrichedLoomModel, diags: LoomDiagnostic[]): void {
  for (const sys of loom.systems) {
    // context name → the elixir deployable that emits it (first one wins; the
    // message names a concrete deployable so the author can find it).
    const elixirHost = new Map<string, string>();
    for (const dep of sys.deployables) {
      if (dep.platform !== "elixir") continue;
      for (const cn of dep.contextNames) if (!elixirHost.has(cn)) elixirHost.set(cn, dep.name);
    }
    if (elixirHost.size === 0) continue;
    for (const mod of sys.subdomains) {
      for (const ctx of mod.contexts) {
        const depName = elixirHost.get(ctx.name);
        if (!depName) continue;
        const flag = (where: string, stmts: readonly StmtIR[]): void => {
          if (!containsIf(stmts)) return;
          diags.push({
            severity: "error",
            code: "loom.elixir-if-stmt-unsupported",
            message: diagMessage("loom.elixir-if-stmt-unsupported", { where, name: depName }),
            source: `${ctx.name}/${where}`,
          });
        };
        for (const agg of ctx.aggregates) {
          for (const op of agg.operations)
            flag(`operation '${agg.name}.${op.name}'`, op.statements);
          for (const fn of agg.functions) {
            if ("stmts" in fn.body) flag(`function '${agg.name}.${fn.name}'`, fn.body.stmts);
          }
        }
        for (const svc of ctx.domainServices) {
          for (const op of svc.operations) {
            flag(`domainService operation '${svc.name}.${op.name}'`, op.body);
          }
        }
        for (const proj of ctx.projections) {
          for (const h of proj.handlers) {
            flag(`projection '${proj.name}' on '${h.event}'`, h.statements);
          }
        }
      }
    }
  }
}

/** Gate 2 — an `if` anywhere in a ui body, on every frontend. */
function validatePageBodyIf(loom: EnrichedLoomModel, diags: LoomDiagnostic[]): void {
  for (const sys of loom.systems) {
    for (const ui of sys.uis) {
      const flag = (where: string, stmts: readonly StmtIR[]): void => {
        if (!containsIf(stmts)) return;
        diags.push({
          severity: "error",
          code: "loom.if-stmt-page-body-unsupported",
          message: diagMessage("loom.if-stmt-page-body-unsupported", { where, uiName: ui.name }),
          source: `${ui.name}/${where}`,
        });
      };
      // A page/component BODY is an expression, but its inline handler lambdas
      // (`onClick: e => { … }`) carry statement blocks — reached through
      // `walkExprStmtsDeep`, the same channel `walkStmtDeep` uses internally.
      const bodyStmts = (body: unknown): StmtIR[] => {
        const out: StmtIR[] = [];
        walkExprStmtsDeep(body as never, (s) => out.push(s));
        return out;
      };
      for (const p of ui.pages) {
        for (const a of p.actions) flag(`page '${p.name}' action '${a.name}'`, a.body);
        flag(`page '${p.name}' body`, bodyStmts(p.body));
      }
      for (const c of ui.components) {
        for (const a of c.actions) flag(`component '${c.name}' action '${a.name}'`, a.body);
        flag(`component '${c.name}' body`, bodyStmts(c.body));
      }
      for (const st of ui.stores) {
        for (const a of st.actions) flag(`store '${st.name}' action '${a.name}'`, a.body);
      }
    }
  }
}
