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
//   (The former loom.store-lifetime-unsupported gate is retired — the
//        `persist: memory|local|session|url` ladder now ships on every
//        frontend; a bad value is caught at the AST tier as
//        loom.store-lifetime-invalid, validators/ui.ts.)
//   loom.store-cross-store-on-liveview-unsupported — a store action that calls
//        a DIFFERENT store's action, on a `phoenixLiveView` deployable.  The
//        LiveView projection seeds each used store as its OWN per-page assign
//        (`assign(:cart, %Cart{})`), so a pure store fn has no handle to a
//        sibling store's struct; same-store action→action composition is fine
//        (a pure in-module call), cross-store is not.  React/Zustand reaches
//        the sibling hook freely, so the gate is LiveView-scoped.
//
// (Stores on the Phoenix LiveView frontend ARE supported — the
// `loom.store-on-liveview-unsupported` gate was lifted once the HEEx target
// gained the store-module + per-page-assign projection.)
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

/** Render a `StoreIR.lifetime` enum back to its `persist:` source keyword for
 *  diagnostics (`persistLocal` → `local`). */
function lifetimeKeyword(lifetime: StoreIR["lifetime"]): string {
  switch (lifetime) {
    case "persistLocal":
      return "local";
    case "persistSession":
      return "session";
    default:
      return lifetime; // "url" | "memory"
  }
}

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

        // The lifetime ladder (`persist: memory|local|session|url`) now ships
        // on every frontend, so the former `loom.store-lifetime-unsupported`
        // gate is retired.  A malformed `persist:` value is rejected earlier at
        // the AST tier (`loom.store-lifetime-invalid`, validators/ui.ts).

        // loom.store-url-field-unsupported — a `persist: url` store reflects its
        // fields into query params, which carry only scalars.  Arrays and nested
        // entity/value-object fields have no faithful, round-trippable query
        // encoding in v1, so reject them loudly rather than silently drop them
        // from the sync (frontend-state-management.md §3.1).
        if (store.lifetime === "url") {
          for (const f of store.state) {
            const k = f.type.kind;
            if (k === "array" || k === "entity" || k === "valueobject") {
              diags.push({
                severity: "error",
                code: "loom.store-url-field-unsupported",
                message:
                  `${where}: field '${f.name}' (${k}) cannot be URL-synced — ` +
                  `\`persist: url\` fields must be scalar (string/number/bool/enum/id). ` +
                  `Use \`persist: local\` for structural state.`,
                source: where,
              });
            }
          }
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

    // loom.store-cross-store-on-liveview-unsupported — a ui mounted by a
    // `phoenixLiveView` deployable whose store has an action that calls a
    // DIFFERENT store's action.  The HEEx projection seeds each used store as
    // its own per-page assign (`assign(:cart, %Cart{})`) and renders a store
    // action as a pure `def <action>(%__MODULE__{} = state, …)` fn — which has
    // no handle to a sibling store's struct.  Same-store action→action calls
    // are fine (a pure in-module call); cross-store is gated here so the HEEx
    // store emitter never mis-emits an unbound reference.
    for (const dep of sys.deployables) {
      const mounted = [dep.uiName, ...(dep.hostedUiNames ?? [])].filter((n): n is string => !!n);
      for (const uiName of mounted) {
        const stores = storesByUi.get(uiName);
        if (!stores || stores.length === 0) continue;
        const ui = sys.uis.find((u) => u.name === uiName);
        const isLiveView =
          dep.uiFramework === "phoenixLiveView" || ui?.framework === "phoenixLiveView";
        if (!isLiveView) continue;
        // loom.store-lifetime-liveview-unsupported — the persistence tiers of
        // the lifetime ladder don't map onto a server-rendered LiveView store:
        // `local`/`session` are browser storage (no server-side equivalent),
        // and `url` needs page-level `handle_params`/`push_patch` wiring the
        // per-process struct module can't own.  v1 supports `memory` on
        // LiveView; the rest ship on the SPA frontends (React/Vue/Svelte/
        // Angular).  A LiveView store therefore stays in-memory.
        for (const store of stores) {
          if (store.lifetime !== "memory") {
            const where = `store '${store.name}'`;
            diags.push({
              severity: "error",
              code: "loom.store-lifetime-liveview-unsupported",
              message:
                `${where}: \`persist: ${lifetimeKeyword(store.lifetime)}\` is not supported on the ` +
                `phoenixLiveView frontend — a LiveView store is a server-side per-process struct ` +
                `with no browser storage, and URL state is owned by the page's \`handle_params\`. ` +
                `Use \`persist: memory\` here; the persistence tiers ship on the SPA frontends.`,
              source: where,
            });
          }
          for (const action of store.actions) {
            forEachStmt(action.body, (s) => {
              if (
                s.kind === "call" &&
                s.target === "store-action" &&
                s.store &&
                s.store !== store.name
              ) {
                const where = `store '${store.name}' action '${action.name}'`;
                diags.push({
                  severity: "error",
                  code: "loom.store-cross-store-on-liveview-unsupported",
                  message:
                    `${where}: calls \`${s.store}.${s.name}(…)\`, a DIFFERENT store's action, ` +
                    `on the phoenixLiveView frontend.  A LiveView store action is a pure struct ` +
                    `transform over its OWN store's per-page assign and can't reach store ` +
                    `'${s.store}'.  Move the cross-store coordination to the calling page's action ` +
                    `(call \`${store.name}.${action.name}()\` then \`${s.store}.${s.name}()\` from the page).`,
                  source: where,
                });
              }
            });
          }
        }
      }
    }

    // loom.feliz-store-unsupported — the Feliz (F#/Fable/Elmish) frontend has no
    // store subsystem yet.  A store composes SHARED reactive state across pages;
    // in the single-program Elmish model that means folding store state into the
    // one `Model` (with a store-scoped read seam so `Cart.count` resolves to the
    // right namespaced field) and store actions into `Msg`/`update` — a genuine
    // subsystem, not a single emit arm.  Rather than emit a non-reactive mutable
    // module (silently wrong), a store used by a Feliz-hosted ui is gated here
    // until that subsystem lands.  (`platform: feliz` hosts only `framework:
    // feliz` — `hostableFrameworks: {feliz}` — so the deployable platform is the
    // reliable detector; a bare `platform: feliz` resolves `uiFramework` to the
    // frontend default, not `"feliz"`.)  Tracked in T6-backend-parity.md M-T6.15.
    for (const dep of sys.deployables) {
      if (dep.platform !== "feliz") continue;
      const mounted = [dep.uiName, ...(dep.hostedUiNames ?? [])].filter((n): n is string => !!n);
      for (const uiName of mounted) {
        // (a) store gate
        const stores = storesByUi.get(uiName);
        if (stores && stores.length > 0) {
          for (const store of stores) {
            const where = `store '${store.name}'`;
            diags.push({
              severity: "error",
              code: "loom.feliz-store-unsupported",
              message:
                `${where} is used by ui '${uiName}', hosted by the Feliz (F#/Fable) deployable ` +
                `'${dep.name}', but the Feliz frontend has no store subsystem yet — a shared reactive ` +
                `store needs Elmish Model/Msg composition + a store-scoped read seam, not a single emit ` +
                `arm.  Host this ui on an SPA frontend (React/Vue/Svelte/Angular) that supports stores, ` +
                `or move the shared state into the page's own \`state { … }\`.  Tracked in M-T6.15.`,
              source: where,
            });
          }
        }

        // (b) async-effect gate — loom.feliz-async-effect-unsupported.  A
        // frontend `match await <op>()` (async-actions-and-effects.md Stage 2)
        // lowers to a `variant-match` statement whose async envelope (await the
        // remote mutation, reify the thrown error into the error variant, then a
        // discriminant switch) rides the SPA walker's `renderVariantMatch`
        // seam — which the Feliz walker does not implement (its `Cmd.OfAsync`
        // machinery today is form/read/mutation-shaped, not the user-authored
        // effect form).  Gate it at validation rather than crash the F# emit.
        const ui = sys.uis.find((u) => u.name === uiName);
        if (!ui) continue;
        const hosts: {
          where: string;
          actions: readonly { name: string; body: readonly StmtIR[] }[];
        }[] = [
          ...ui.pages.map((p) => ({ where: `page '${p.name}'`, actions: p.actions })),
          ...ui.components.map((c) => ({ where: `component '${c.name}'`, actions: c.actions })),
        ];
        for (const host of hosts) {
          for (const action of host.actions) {
            forEachStmt(action.body, (s) => {
              if (s.kind !== "variant-match") return;
              const where = `${host.where} action '${action.name}'`;
              diags.push({
                severity: "error",
                code: "loom.feliz-async-effect-unsupported",
                message:
                  `${where}: \`match await …\` (an async effect) is used on ui '${uiName}', hosted by ` +
                  `the Feliz (F#/Fable) deployable '${dep.name}', but the Feliz frontend has no async ` +
                  `effect renderer yet — the SPA walker's variant-match envelope (await → error-reify → ` +
                  `discriminant switch) has no Feliz equivalent.  Host this ui on an SPA frontend ` +
                  `(React/Vue/Svelte/Angular), or drive the remote op through a form primitive ` +
                  `(CreateForm/OperationForm) instead.  Tracked in M-T6.15.`,
                source: where,
              });
            });
          }
        }
      }
    }
  }
}
