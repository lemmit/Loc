// Page-body primitives that need HOST-LIVEVIEW state, used inside a `component`
// on a phoenixLiveView ui — one predicate, one consumer (the IR validator).
//
// A HEEx function component is a pure render function.  It owns no process, so
// anything it needs at render time must be supplied by the LiveView that renders
// it: an assign, an `allow_upload/3`, a `handle_event/3` clause.  #2646 built
// exactly that hoisting for a component's `state { … }` and its named `action`s
// (`ComponentActionInfo.state` / `.handlers`, `gatherComponentHandlers` and
// `hostStateAssign` in `liveview-emit.ts` / `heex-walker-core.ts`).
//
// It was never extended to the walker's OTHER accumulators — `formBindings`,
// `queryBindings`, `uploadBindings`, `tableControls` — so a primitive that fills
// one of those emits its markup inside the component while the host LiveView
// gets nothing.  The result compiles clean under `mix compile
// --warnings-as-errors` and then dies at request time on the assign that was
// never made.  Measured on generated output, one case per primitive:
//
//   CreateForm / OperationForm  `<.simple_form for={@form} phx-submit="save_customer">`
//                               against a host with an empty `mount/3` and no
//                               matching `handle_event` — no `@form` assign.
//   WorkflowForm                same, `phx-submit="run_signup"`.
//   DestroyForm                 `phx-value-id={@id}` — no `@id` assign.
//   QueryView / Table           `rows={@items}` — no `@items` assign.
//   FileUpload                  `upload={@uploads.<field>}` with no
//                               `allow_upload/3` in the host's mount.
//   Chart                       `@<projection>` — no projection assign.
//
// NOT in the set, and deliberately: `Modal` (a bare one is self-contained; a
// form INSIDE one is caught because the scan is a deep walk and sees the form),
// `Action` and `state { … }` (both hoisted by #2646), and every display
// primitive.
//
// This is a NAME scan rather than a walk of the real HEEx accumulators because
// the validator (`src/ir/`) sits below the generator and cannot import it.  The
// set is pinned by `test/generator/elixir/heex-component-host-state.test.ts`,
// which generates each member inside a component and asserts the gate fires,
// and asserts a non-member still generates.

import type { ExprIR, UiIR } from "../types/loom-ir.js";
import { walkExprDeep } from "./walk.js";

/** Page-body primitives whose HEEx rendering needs the host LiveView to supply
 *  an assign, an upload or a `handle_event` clause the component hoisting does
 *  not yet provide.  See the header for the per-primitive evidence. */
export const HEEX_HOST_STATE_PRIMITIVES: ReadonlySet<string> = new Set([
  "CreateForm",
  "OperationForm",
  "WorkflowForm",
  "DestroyForm",
  "QueryView",
  "Table",
  "FileUpload",
  "Chart",
]);

/** The host-state primitives a body uses, in source order, deduped. */
function hostStatePrimitives(body: ExprIR | undefined): string[] {
  const found = new Set<string>();
  walkExprDeep(body, (e) => {
    if (e.kind === "call" && HEEX_HOST_STATE_PRIMITIVES.has(e.name)) found.add(e.name);
  });
  return [...found];
}

/** Every `(component, primitive)` pair in a ui that a phoenixLiveView target
 *  cannot render — one diagnostic each, so the author sees which primitive in
 *  which component rather than one aggregate complaint per ui. */
export function heexComponentHostStateUses(ui: UiIR): { component: string; primitive: string }[] {
  const out: { component: string; primitive: string }[] = [];
  for (const c of ui.components) {
    for (const primitive of hostStatePrimitives(c.body)) {
      out.push({ component: c.name, primitive });
    }
  }
  return out;
}
