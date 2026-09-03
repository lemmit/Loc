// Call sites that pass CHILDREN to a user component — the extra positional
// argument every JSX-family frontend renders between the open and close tags.
//
//   component Panel(label: string) { Card { Text { label }, Slot { } } }
//   page P { body: Panel("a", Text { "child" }) }
//
// React emits `<Panel label="a"><Text>child</Text></Panel>`, and the body's
// `Slot { }` is where the child lands.  Angular has no PascalCase component
// tag, so its call site is `<ng-container [ngComponentOutlet]="Panel"
// [ngComponentOutletInputs]='{ label: "a" }'></ng-container>` — and
// `ngComponentOutlet` cannot project content from a template at all
// (`ngComponentOutletContent` takes pre-built DOM nodes, which is TS-side
// only).  So the extra positional argument had nowhere to go and
// `renderUserComponent` dropped it on the floor: the child text appeared
// NOWHERE in the emitted project, with no comment, no error and no runtime
// symptom other than missing content.
//
// The remedy is known and Angular-local: a WALKED component already gets a
// real kebab selector (`app-panel`, `components-emit.ts:componentSelector`)
// and its body's `Slot { }` already renders `<ng-content></ng-content>`
// (`angular-target.renderChildrenSlot`), so switching the call site from the
// outlet to the selector tag — `<app-panel [label]='"a"'>…children…</app-panel>`,
// with the class in the page's standalone `imports: []` instead of
// `NgComponentOutlet` — projects them correctly.  An EXTERN component has no
// Loom-known selector, so it keeps the outlet and keeps this gate.
//
// Until that lands the drop is named rather than silent
// (`loom.component-children-unsupported`).

import type { ExprIR, UiIR } from "../types/loom-ir.js";
import { walkExprDeep } from "./walk.js";

/** True when `call` supplies more arguments than `paramCount` names can
 *  absorb — mirrors the arg→param cursor in
 *  `angular-target.renderUserComponent`, whose `paramName === undefined`
 *  branch is the drop this predicate detects.  Named arguments always land on
 *  a param, so only the positional overflow counts. */
function hasOverflowArgs(call: Extract<ExprIR, { kind: "call" }>, paramCount: number): boolean {
  const argNames = call.argNames ?? [];
  let positional = 0;
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] === undefined) positional += 1;
  }
  const named = call.args.length - positional;
  // Named args consume distinct params; the positional ones fill what is left.
  return positional > Math.max(0, paramCount - named);
}

/** Every user-component call site in a body that passes children (a positional
 *  argument with no param to land on), labelled for a diagnostic. */
export function componentChildrenCallSites(
  body: ExprIR | undefined,
  paramCountByComponent: ReadonlyMap<string, number>,
): string[] {
  const out: string[] = [];
  walkExprDeep(body, (e) => {
    if (e.kind !== "call") return;
    const paramCount = paramCountByComponent.get(e.name);
    if (paramCount === undefined) return;
    if (hasOverflowArgs(e, paramCount)) out.push(e.name);
  });
  return out;
}

/** Every page/component of a ui that invokes a user component WITH children,
 *  labelled `page 'X'` / `component 'Y'` alongside the invoked name. */
export function componentChildrenHosts(ui: UiIR): { what: string; component: string }[] {
  const paramCount = new Map<string, number>(ui.components.map((c) => [c.name, c.params.length]));
  const out: { what: string; component: string }[] = [];
  for (const p of ui.pages) {
    for (const name of componentChildrenCallSites(p.body, paramCount)) {
      out.push({ what: `page '${p.name}'`, component: name });
    }
  }
  for (const c of ui.components) {
    for (const name of componentChildrenCallSites(c.body, paramCount)) {
      out.push({ what: `component '${c.name}'`, component: name });
    }
  }
  return out;
}
