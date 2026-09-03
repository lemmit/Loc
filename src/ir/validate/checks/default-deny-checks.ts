// -------------------------------------------------------------------------
// Default-deny enforcement (auth.md / quickstart §4.3).  Split out of
// system-checks.ts by packet 2.6 (wave-2) — mechanical move, no logic
// change.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import { plural, snake } from "../../../util/naming.js";
import type { SystemIR, WorkflowIR, WorkflowStmtIR } from "../../types/loom-ir.js";
import { isMacroEmitted } from "../../types/origin.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// Page/component `derived name: T = expr` bindings are supported on every
// frontend now — React/Vue/Svelte/Angular hoist a reactive computed
// (`useMemo` / `computed` / `$derived` / `computed`); Phoenix/HEEx
// inline-recomputes the expr at each use.  No framework gate is needed.

// Default-deny enforcement (auth.md / quickstart §4.3).  When the system's
// `auth { enforcement: denyByDefault }` is set, every reachable *command* on
// an `auth: required` backend must declare a `requires` gate — otherwise it
// serves ungated.  `enforcement: opt` (the default) preserves the existing
// per-`requires` opt-in.  Escape hatch: `requires true` marks a command
// intentionally public.
//
// Scope: every client-reachable command (mutation) endpoint —
//   - public aggregate actions: operations, **creates**, destroys (each
//     carries `requires` in its body);
//   - **workflows**: every command-triggered starter (`create … {}`) and named
//     `handle …(){}` continuation command (POST endpoints; their bodies carry
//     `requires`).  Event-triggered creates / `on(...)` reactors are not
//     client-reachable, so they are excluded.
//
// Read endpoints — **views** and repository **finds** — are in scope too: each
// is a GET endpoint, and both carry an optional `requires <expr>` gate (the
// read-side twin of an operation's in-handler 403).  An ungated read under
// denyByDefault serves to any caller; `requires true` is the explicit
// intentionally-public escape.

export function validateDefaultDeny(sys: SystemIR, diags: LoomDiagnostic[]): void {
  if (sys.auth?.enforcement !== "denyByDefault") return;
  // Contexts hosted by any `auth: required` backend deployable.  A frontend
  // (auth: ui) has `auth.required === false`, so it's excluded here.
  const guarded = new Set<string>();
  for (const d of sys.deployables) {
    if (!d.auth?.required) continue;
    for (const cn of d.contextNames) guarded.add(cn);
  }
  if (guarded.size === 0) return;
  const isGated = (statements: { kind: string }[]): boolean =>
    statements.some((s) => s.kind === "requires");
  for (const sd of sys.subdomains) {
    for (const c of sd.contexts) {
      if (!guarded.has(c.name)) continue;
      // Aggregate command actions: operations + creates + destroys (all
      // OperationIR with a `requires`-bearing body).
      for (const a of c.aggregates) {
        for (const op of [...a.operations, ...(a.creates ?? []), ...(a.destroys ?? [])]) {
          if (op.visibility !== "public") continue;
          if (!isGated(op.statements)) {
            diags.push({
              severity: "error",
              code: "loom.default-deny-ungated",
              message: diagMessage("loom.default-deny-ungated#denybydefault-is-reachable", {
                name: a.name,
                opName: op.name,
              }),
              source: `${a.name}/${op.name}`,
            });
          }
        }
      }
      // Workflow command endpoints: command-triggered starters + named
      // handlers.  Each is a POST route a client can reach.
      for (const wf of c.workflows) {
        for (const entry of workflowCommandEntries(wf)) {
          if (!isGated(entry.statements)) {
            diags.push({
              severity: "error",
              code: "loom.default-deny-ungated",
              message: diagMessage("loom.default-deny-ungated#denybydefault-workflow", {
                label: entry.label,
              }),
              source: `${wf.name}/${entry.key}`,
            });
          }
        }
      }
      // Repository finds: each author-declared named find is its own GET route
      // and carries the same optional `requires <expr>` gate.  The aggregate
      // list-all endpoint (the auto-injected `find all`) is out of scope — it is
      // compiler-synthesized and has no author source line to attach a gate to;
      // gating it needs an aggregate-level default-read surface (follow-up).
      // Internal synthesized finds (paged-run helpers) are never their own route.
      for (const repo of c.repositories) {
        for (const find of repo.finds) {
          if (find.synthesized || find.name === "all") continue;
          if (!find.requires) {
            diags.push({
              severity: "error",
              code: "loom.default-deny-ungated",
              message: diagMessage("loom.default-deny-ungated#denybydefault-find-is-reachable", {
                name: repo.name,
                findName: find.name,
              }),
              source: `find/${repo.name}.${find.name}`,
            });
          }
        }
        // Entity history (docs/audit.md): `GET /<agg>/{id}/history` replays the
        // `before`/`after` snapshots of every successful command on a row.  It
        // is compiler-synthesized like `find all` — but unlike `find all` the
        // author HAS a surface to gate it from, because history copies the list
        // read's gate at enrichment.  So an ungated one is actionable, and
        // under denyByDefault an ungated CHANGE HISTORY is a worse default than
        // an ungated current-state read: it discloses who changed what and
        // when, over the row's whole lifetime, in one request.
        if (repo.historyFind && !repo.historyFind.requires) {
          diags.push({
            severity: "error",
            code: "loom.audit-history-ungated",
            message: diagMessage("loom.audit-history-ungated", {
              aggregateName: repo.aggregateName,
              aggregateName2: snake(plural(repo.aggregateName)),
              name: repo.name,
            }),
            source: `find/${repo.name}.history`,
          });
        }
      }
      // Projections.  Every projection — folded or query-time — is served as a
      // GET endpoint (`/projections/<name>`, plus `/{key}` for a keyed folded
      // one), so under denyByDefault an ungated one publishes its rows to any
      // caller exactly as an ungated find publishes an aggregate's.
      //
      // Folded projections are in scope like every other read surface: a
      // projection can SPELL a `requires` gate and the backends emit it, so
      // demanding one is satisfiable.
      for (const proj of c.projections) {
        if (proj.query?.requires) continue;
        // A MACRO-emitted projection has no declaration header, so the
        // diagnostic's "add a `requires` after its declaration header" names a
        // line the author cannot open — `scaffoldDashboard` emits one singleton
        // totals projection per aggregate, which made `scaffold` and
        // `denyByDefault` an uncompilable pair.  Exempt for the same stated
        // reason the enrichment-injected `find all` is exempt one loop up: it
        // is compiler-synthesized and has no author source line
        // (`src/ir/util/read-gates.ts`).  Derived from the origin chain the
        // lowering already records — nothing new is stamped.
        if (isMacroEmitted(proj.origin)) continue;
        diags.push({
          severity: "error",
          code: "loom.default-deny-ungated",
          message: diagMessage("loom.default-deny-ungated#denybydefault-projection", {
            name: proj.name,
          }),
          source: `projection/${proj.name}`,
        });
      }
      // Workflow INSTANCE reads (`/workflows/<wf>/instances[/{id}]`).  An
      // observable workflow — one with a correlation field, hence an
      // `instanceWireShape` — publishes every instance's correlation id and
      // state on two GET routes, so under denyByDefault it needs a gate for
      // the same reason an ungated find or projection does.
      //
      // It could not be required before: the routes are compiler-derived and a
      // workflow had no surface to declare a read gate on, so demanding one
      // would have demanded the impossible — the identical situation the folded
      // projection was in.  The header `requires` clause is that surface, so
      // the exemption has no reason left.
      //
      // Keyed on `instanceWireShape`: a stateless workflow (no correlation
      // field) serves no instance routes, so there is nothing to gate.
      for (const wf of c.workflows) {
        if (!wf.instanceWireShape || wf.instanceReadGate) continue;
        diags.push({
          severity: "error",
          code: "loom.default-deny-ungated",
          message: diagMessage("loom.default-deny-ungated#denybydefault-workflow-instances", {
            name: wf.name,
          }),
          source: `workflow/${wf.name}`,
        });
      }
    }
  }

  // Explicit handlers (`commandHandler` / `queryHandler`) reachable through an
  // `api { route <METHOD> "<path>" -> <Ctx>.<Handler> }` binding.  These are
  // real HTTP endpoints on all five backends, and default-deny walked right
  // past them: it enumerated aggregate actions, workflow command entries,
  // finds and history, but never `ctx.commandHandlers` / `ctx.queryHandlers`.
  //
  // Scoped to ROUTE-BOUND handlers deliberately — an unrouted handler has no
  // transport surface, so demanding a gate from it would be noise.  The route
  // is the reachability proof, exactly as `visibility === "public"` is for an
  // aggregate operation.
  const ctxByName = new Map<string, (typeof sys.subdomains)[number]["contexts"][number]>();
  for (const sd of sys.subdomains) for (const c of sd.contexts) ctxByName.set(c.name, c);
  for (const api of sys.apis) {
    for (const route of api.routes) {
      const c = ctxByName.get(route.target.context);
      if (!c || !guarded.has(c.name)) continue;
      const cmd = (c.commandHandlers ?? []).find((h) => h.name === route.target.handler);
      const qry = cmd
        ? undefined
        : (c.queryHandlers ?? []).find((h) => h.name === route.target.handler);
      const handler = cmd ?? qry;
      // A workflow `handle` can also be a route target; those are already
      // covered by `workflowCommandEntries` above, so skip rather than
      // double-report.
      if (!handler) continue;
      if (isGated(handler.statements)) continue;
      const params = {
        kind: cmd ? "commandHandler" : "queryHandler",
        ctx: c.name,
        handler: handler.name,
        method: route.method,
        path: route.path,
      };
      // An `extern` handler has NO body — there is nowhere to put a gate — so
      // "add a `requires`" would be an unsatisfiable instruction.  Say what is
      // actually actionable instead (drop `extern`, or drop the route).  The
      // two arms are separate `diags.push` calls, not a ternary on `message:`,
      // because the catalog scanner (`diagnostic-catalog.test.ts`) reads the key
      // off a DIRECT `diagMessage("literal", …)` call expression — a ternary or
      // a computed key reads to it as inline wording.
      const source = `${c.name}/handler/${handler.name}`;
      if (handler.extern) {
        diags.push({
          severity: "error",
          code: "loom.default-deny-ungated",
          message: diagMessage("loom.default-deny-ungated#denybydefault-handler-extern", params),
          source,
        });
      } else {
        diags.push({
          severity: "error",
          code: "loom.default-deny-ungated",
          message: diagMessage("loom.default-deny-ungated#denybydefault-handler", params),
          source,
        });
      }
    }
  }
}

/** The client-reachable command endpoints of a workflow: each command-triggered
 *  `create` starter and each named `handle` continuation.  Event-triggered
 *  creates and `on(...)` reactors fire on internal events, never a client POST,
 *  so they are excluded — the validate-layer analogue of the generator's
 *  `emitsCommandRoute`. */

function workflowCommandEntries(
  wf: WorkflowIR,
): { label: string; key: string; statements: WorkflowStmtIR[] }[] {
  const entries: { label: string; key: string; statements: WorkflowStmtIR[] }[] = [];
  for (const cr of wf.creates) {
    if (cr.triggerKind !== "command") continue;
    entries.push({
      label: cr.name ? `${wf.name}.${cr.name}` : wf.name,
      key: cr.name ?? "create",
      statements: cr.statements,
    });
  }
  for (const h of wf.handlers ?? []) {
    entries.push({ label: `${wf.name}.${h.name}`, key: h.name, statements: h.statements });
  }
  return entries;
}
