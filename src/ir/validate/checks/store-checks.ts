// -------------------------------------------------------------------------
// Store checks (named-actions-and-stores.md §3, Stage 5) — gates on the
// fully-resolved `StoreIR` + the page/component action bodies that reference
// stores.  Four codes:
//
//   loom.store-action-view-effect    — a store action calls a view-scoped
//        effect (`navigate`/`toast`); those need a router/socket only a
//        page/component has (§3.2).
//   loom.store-state-inline-write     — a page/component action writes a store
//        field inline (`Cart.lines := …`); store state changes only inside
//        store actions (§3.1, encapsulation).
//   loom.store-lifetime-unsupported   — a store with a non-memory lifetime;
//        v1 is in-memory only (the persist/sync ladder parses but is gated).
//   loom.store-on-liveview-unsupported — a ui with ≥1 store mounted by a
//        `phoenixLiveView` deployable; the store emitters are React-only in
//        v1 (LiveView is a fan-out follow-up), so fail loudly here rather
//        than crashing the HEEx generator.
//
// Plus a store→store action-composition acyclicity check so a store's
// `update` graph stays well-founded (a store→page call is impossible by
// scope — a store action can't see page state — so it needs no code).
// -------------------------------------------------------------------------

import type { EnrichedLoomModel, StmtIR, StoreIR } from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// View-scoped effect builtins — illegal inside a store action (§3.2).  Mirrors
// `VIEW_EFFECT_BUILTINS` in ui-checks.ts (a store has no router/socket).
const VIEW_EFFECT_BUILTINS = new Set<string>(["navigate", "toast"]);

/** Walk a statement block, invoking `visit` on every nested statement
 *  (descending into block-body lambdas inside call/assign args). */
function forEachStmt(stmts: readonly StmtIR[], visit: (s: StmtIR) => void): void {
  for (const s of stmts) {
    visit(s);
    // Block-body lambdas can appear as call/assign argument expressions; the
    // store-action body set in v1 is flat (no nested handler lambdas), so a
    // shallow walk over the top-level statements suffices.  Kept as a helper
    // so a future nesting addition has one place to deepen.
  }
}

export function validateStores(loom: EnrichedLoomModel, diags: LoomDiagnostic[]): void {
  for (const sys of loom.systems) {
    // ui-name → its stores, for the deployable-pairing (LiveView) check.
    const storesByUi = new Map<string, StoreIR[]>();
    for (const ui of sys.uis) {
      if (ui.stores.length > 0) storesByUi.set(ui.name, ui.stores);
      const storeNames = new Set(ui.stores.map((s) => s.name));

      for (const store of ui.stores) {
        const where = `store '${store.name}'`;

        // loom.store-lifetime-unsupported — v1 is in-memory only.
        if (store.lifetime !== "memory") {
          diags.push({
            severity: "error",
            code: "loom.store-lifetime-unsupported",
            message:
              `${where}: lifetime '${store.lifetime}' is not supported yet — Loom v1 stores are ` +
              `in-memory only (drop the \`persist:\`/\`sync:\` clause).`,
            source: where,
          });
        }

        // loom.store-action-view-effect — a store action may not call a
        // view-scoped effect; the calling page owns navigation (§3.2).
        for (const action of store.actions) {
          forEachStmt(action.body, (s) => {
            if (
              s.kind === "call" &&
              VIEW_EFFECT_BUILTINS.has(s.name) &&
              s.target !== "store-action"
            ) {
              diags.push({
                severity: "error",
                code: "loom.store-action-view-effect",
                message:
                  `${where} action '${action.name}': \`${s.name}(…)\` is a view-scoped effect — ` +
                  `a store has no router/socket to ${s.name} on.  Move it to the calling page's ` +
                  `action (the page owns navigation; the store action only mutates state).`,
                source: where,
              });
            }
          });
        }
      }

      // store→store action-composition acyclicity.  Build the call graph
      // (store-action → store-actions it calls) and reject any cycle so each
      // store's `update` reduction stays well-founded (§8.4).  Keyed by
      // `<store>.<action>` so two stores' same-named actions don't collide.
      const edges = new Map<string, Set<string>>();
      for (const store of ui.stores) {
        for (const action of store.actions) {
          const from = `${store.name}.${action.name}`;
          const outs = new Set<string>();
          forEachStmt(action.body, (s) => {
            if (s.kind === "call" && s.target === "store-action" && s.store) {
              outs.add(`${s.store}.${s.name}`);
            }
          });
          edges.set(from, outs);
        }
      }
      const reported = new Set<string>();
      const onStack = new Set<string>();
      const visited = new Set<string>();
      const walk = (node: string, path: string[]): void => {
        if (onStack.has(node)) {
          // Found a back-edge — report the cycle once (anchored at the
          // store whose action closes it).
          if (!reported.has(node)) {
            reported.add(node);
            diags.push({
              severity: "error",
              code: "loom.store-action-cycle",
              message:
                `store action '${node}' is part of a call cycle (${[...path, node].join(" → ")}) — ` +
                `store actions must compose acyclically so each store's update reduction terminates.`,
              source: node,
            });
          }
          return;
        }
        if (visited.has(node)) return;
        onStack.add(node);
        for (const next of edges.get(node) ?? []) walk(next, [...path, node]);
        onStack.delete(node);
        visited.add(node);
      };
      for (const node of edges.keys()) walk(node, []);

      // loom.store-state-inline-write — a page/component action that writes a
      // store field inline (`Cart.lines := …`).  After lowering, such a write
      // is an assign/add/remove whose root path segment is a store name (a
      // store action's own writes use the bare field name, never `Store.field`).
      const checkInlineWrites = (
        actions: readonly { name: string; body: readonly StmtIR[] }[],
        surfaceWhere: string,
      ): void => {
        for (const action of actions) {
          forEachStmt(action.body, (s) => {
            if (
              (s.kind === "assign" || s.kind === "add" || s.kind === "remove") &&
              s.target.segments.length >= 2 &&
              storeNames.has(s.target.segments[0]!)
            ) {
              const [storeSeg, fieldSeg] = s.target.segments;
              diags.push({
                severity: "error",
                code: "loom.store-state-inline-write",
                message:
                  `${surfaceWhere} action '${action.name}': cannot write store state inline ` +
                  `(\`${storeSeg}.${fieldSeg} := …\`).  Store state changes only inside a store ` +
                  `action — add an \`action\` to \`store ${storeSeg}\` and call it (\`${storeSeg}.<action>()\`).`,
                source: surfaceWhere,
              });
            }
          });
        }
      };
      for (const page of ui.pages) checkInlineWrites(page.actions, `page '${page.name}'`);
      for (const comp of ui.components) {
        checkInlineWrites(comp.actions, `component '${comp.name}'`);
      }
    }

    // loom.store-on-liveview-unsupported — a deployable mounting a ui with
    // ≥1 store whose resolved frontend framework is LiveView.  v1's store
    // emitters are React-only; a HEEx store-module emit throws loudly, so
    // gate it here with a precise diagnostic instead.
    for (const dep of sys.deployables) {
      const mounted = [dep.uiName, ...(dep.hostedUiNames ?? [])].filter((n): n is string => !!n);
      for (const uiName of mounted) {
        const stores = storesByUi.get(uiName);
        if (!stores || stores.length === 0) continue;
        const ui = sys.uis.find((u) => u.name === uiName);
        const isLiveView =
          dep.uiFramework === "phoenixLiveView" || ui?.framework === "phoenixLiveView";
        if (isLiveView) {
          const where = `deployable '${dep.name}'`;
          diags.push({
            severity: "error",
            code: "loom.store-on-liveview-unsupported",
            message:
              `${where}: ui '${uiName}' declares ${stores.length} store(s), but stores are not ` +
              `supported on the phoenixLiveView frontend yet (React only in v1).  Remove the ` +
              `store(s) or mount this ui on a React deployable.`,
            source: where,
          });
        }
      }
    }
  }
}
