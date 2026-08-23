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
//   loom.store-cross-store-on-liveview-invalid — a store action that calls
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

import { diagMessage } from "../../../diagnostics/messages.js";
import type { EnrichedLoomModel, StmtIR, StoreIR } from "../../types/loom-ir.js";
import { classifyFelizAsyncEffect } from "../../util/feliz-async-effect.js";
import { felizPersistCodec } from "../../util/feliz-persist-codec.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// View-scoped effect builtins — illegal inside a store action (§3.2).  Mirrors
// `VIEW_EFFECT_BUILTINS` in ui-checks.ts (a store has no router/socket).
const VIEW_EFFECT_BUILTINS = new Set<string>(["navigate", "toast"]);

/** Frontend PLATFORMS whose store emitter ignores the `persist:` lifetime
 *  ladder and builds an in-memory store regardless (`loom.store-lifetime-
 *  target-unsupported`).  A RATCHET: when a platform implements the ladder its
 *  entry is deleted here in the same PR, so a stale allowance can't survive —
 *  which is exactly what happened to `feliz` when `generator/feliz/
 *  store-persist.ts` landed. */
const LIFETIME_UNSUPPORTED_PLATFORMS: ReadonlySet<string> = new Set(["flutter"]);

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

        // loom.store-url-field-invalid — a `persist: url` store reflects its
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
                code: "loom.store-url-field-invalid",
                message: diagMessage("loom.store-url-field-invalid", {
                  where,
                  name: f.name,
                  k,
                }),
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
                message: diagMessage("loom.store-action-view-effect", {
                  where,
                  name: action.name,
                  sName: s.name,
                }),
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
              message: diagMessage("loom.store-action-cycle", {
                node,
                path: [...path, node].join(" → "),
              }),
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
                message: diagMessage("loom.store-state-inline-write", {
                  surfaceWhere,
                  name: action.name,
                  storeSeg,
                  fieldSeg,
                }),
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

    // loom.store-cross-store-on-liveview-invalid — a ui mounted by a
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
        // loom.store-lifetime-liveview-invalid — the persistence tiers of
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
              code: "loom.store-lifetime-liveview-invalid",
              message: diagMessage("loom.store-lifetime-liveview-invalid", {
                where,
                lifetime: lifetimeKeyword(store.lifetime),
              }),
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
                  code: "loom.store-cross-store-on-liveview-invalid",
                  message: diagMessage("loom.store-cross-store-on-liveview-invalid", {
                    where,
                    store: s.store,
                    name: s.name,
                    storeName: store.name,
                    actionName: action.name,
                  }),
                  source: where,
                });
              }
            });
          }
        }
      }
    }

    // loom.store-lifetime-target-unsupported — the SAME gap as the LiveView
    // lifetime gate above, on the one frontend left that doesn't ride the SPA
    // store runtime either.
    //
    //   flutter — `flutter/store-builder.ts` writes a `// TODO(flutter
    //     full-parity): \`persist: <lifetime>\` is not implemented` comment and
    //     then builds the store IN-MEMORY anyway.  A comment in emitted Dart is
    //     not a diagnostic: `ddd parse` is clean, `flutter analyze` is clean,
    //     and the author only discovers the cart didn't survive a restart at
    //     runtime.
    //
    // It is IMPLEMENTABLE (shared_preferences + a router rewrite) and planned —
    // this gate is the honest placeholder, and the task that implements it
    // DELETES its arm from `LIFETIME_UNSUPPORTED_PLATFORMS` rather than leaving
    // a stale allowance behind.  FELIZ did exactly that: the ladder now ships
    // there (`generator/feliz/store-persist.ts` — Web Storage hydration at
    // `init`, a write-back `update` wrapper, and a `popstate` subscription for
    // the `url` tier), so its arm is gone and only the narrower FIELD-scoped
    // half of this same code (the `#field` message variant) below remains.
    //
    // Detected off `dep.platform`, not `uiFramework`, for the reason the Feliz
    // block below spells out: `platform: feliz` / `platform: flutter` each host
    // only their own framework, and a bare declaration resolves `uiFramework`
    // to the frontend default rather than to the platform's own name.
    for (const dep of sys.deployables) {
      if (!LIFETIME_UNSUPPORTED_PLATFORMS.has(dep.platform)) continue;
      const mounted = [dep.uiName, ...(dep.hostedUiNames ?? [])].filter((n): n is string => !!n);
      for (const uiName of mounted) {
        for (const store of storesByUi.get(uiName) ?? []) {
          if (store.lifetime === "memory") continue;
          const where = `store '${store.name}'`;
          diags.push({
            severity: "error",
            code: "loom.store-lifetime-target-unsupported",
            message: diagMessage("loom.store-lifetime-target-unsupported", {
              where,
              lifetime: lifetimeKeyword(store.lifetime),
              platform: dep.platform,
            }),
            source: where,
          });
        }
      }
    }

    // loom.store-lifetime-target-unsupported (#field) — the residue of the Feliz
    // `persist:` implementation.  It crosses the JS boundary per FIELD (a
    // raw string out of Web Storage / the query string, converted in F#), so a
    // field type only persists when `felizPersistCodec` has a TOTAL conversion
    // for it.  `datetime`/`duration`/`guid` spell .NET types with no total parse
    // on this path, `enum` spells the enum's own F# name, and
    // `entity`/`valueobject` (and arrays of them) would need a record codec the
    // store path does not emit — so those fields would be silently dropped from
    // the blob.  Named loudly instead; the same ratchet applies (widen the codec
    // table, delete the case here).
    for (const dep of sys.deployables) {
      if (dep.platform !== "feliz") continue;
      const mounted = [dep.uiName, ...(dep.hostedUiNames ?? [])].filter((n): n is string => !!n);
      for (const uiName of mounted) {
        for (const store of storesByUi.get(uiName) ?? []) {
          if (store.lifetime === "memory") continue;
          for (const f of store.state) {
            if (felizPersistCodec(f.type)) continue;
            const where = `store '${store.name}'`;
            diags.push({
              severity: "error",
              code: "loom.store-lifetime-target-unsupported",
              message: diagMessage("loom.store-lifetime-target-unsupported#field", {
                where,
                name: f.name,
                lifetime: lifetimeKeyword(store.lifetime),
              }),
              source: where,
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
    // Every aggregate name reachable in this system — the shared async-effect
    // classifier resolves the awaited op's aggregate + success variant against it.
    const aggregateNames = new Set<string>();
    for (const sd of sys.subdomains ?? []) {
      for (const c of sd.contexts ?? [])
        for (const a of c.aggregates ?? []) aggregateNames.add(a.name);
    }
    for (const dep of sys.deployables) {
      if (dep.platform !== "feliz") continue;
      const mounted = [dep.uiName, ...(dep.hostedUiNames ?? [])].filter((n): n is string => !!n);
      for (const uiName of mounted) {
        // Stores now fold into the single-program Elmish Model/Msg/update (each
        // store field → a namespaced Model field, each store action → a Msg
        // case), so `loom.feliz-store-unsupported` was lifted once that
        // subsystem landed — the store reads/actions emit against `model`.

        // async-effect gate — loom.feliz-async-effect-unsupported.  A frontend
        // `match await <op>()` (async-actions-and-effects.md Stage 2) lowers to a
        // `variant-match` statement.  On a PAGE the Feliz MVU renderer handles the
        // full shape: an aggregate instance op with or without params, ONE OR MORE
        // named arms (success aggregate + named error variants, reified from the
        // RFC-7807 `type` URI), and an OPTIONAL `else` — projected to a
        // trigger→result MVU pair with a tagged-union decoder.
        //
        // Two FELIZ-SPECIFIC cases stay gated here: (1) a COMPONENT host — the
        // Feliz generator projects async effects only on pages (a component isn't
        // walked for them, so gating avoids a silent drop), and (2) a subject that
        // isn't an aggregate instance op (a collection op / workflow) — the Feliz
        // renderer only projects instance ops.  `classifyFelizAsyncEffect` is the
        // shared arbiter for (2) so the gate and generator can't drift.
        //
        // The route-id requirement is NOT here: a paramless-page instance-op
        // `match await` is invalid on EVERY frontend (no record in scope), so it is
        // rejected by the target-agnostic `loom.instance-effect-needs-route-id`
        // (ui-checks.ts, M-T6.17) — not double-gated as a Feliz quirk.
        const ui = sys.uis.find((u) => u.name === uiName);
        if (!ui) continue;
        const apiParamNames = new Set(ui.apiParams.map((p) => p.name));
        const hosts: {
          where: string;
          kind: "page" | "component";
          actions: readonly { name: string; body: readonly StmtIR[] }[];
        }[] = [
          ...ui.pages.map((p) => ({
            where: `page '${p.name}'`,
            kind: "page" as const,
            actions: p.actions,
          })),
          ...ui.components.map((c) => ({
            where: `component '${c.name}'`,
            kind: "component" as const,
            actions: c.actions,
          })),
        ];
        for (const host of hosts) {
          for (const action of host.actions) {
            forEachStmt(action.body, (s) => {
              if (s.kind !== "variant-match") return;
              const cls = classifyFelizAsyncEffect(s, apiParamNames, aggregateNames);
              // A page projects the effect — only an unsupported SUBJECT gates it.
              // A component is not projected by the Feliz generator, so it always
              // gates (avoids a silent drop).
              const gated = host.kind === "component" || !cls.supported;
              if (!gated) return;
              const where = `${host.where} action '${action.name}'`;
              const reason =
                host.kind === "component"
                  ? "it is hosted by a component — the Feliz generator projects async effects only on " +
                    "pages; move it to a page action"
                  : cls.supported
                    ? "" // unreachable: a page gates only when the subject is unsupported
                    : cls.reason;
              diags.push({
                severity: "error",
                code: "loom.feliz-async-effect-unsupported",
                message: diagMessage("loom.feliz-async-effect-unsupported", {
                  where,
                  uiName,
                  name: dep.name,
                  reason,
                }),
                source: where,
              });
            });
          }
        }
      }
    }
  }
}
