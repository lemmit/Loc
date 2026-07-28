// Controlled-input support for the Flutter frontend.
//
// The standalone input primitives (`Field` / `MultilineField` / `PasswordField`
// / `Toggle` / `SelectField`) render through the flutter pack (`pack.ts`
// `RENDERERS`), reading `state.<bind>` and writing via a bare `set<Field>(v)`
// call.  That setter resolves to a page-shell TEAR-OFF in a `ConsumerWidget`
// page (`final set<Field> = notifier.set<Field>;`) or an in-class method in a
// stateful component — both generated per state field.
//
// A page shell must know WHICH state fields a body binds so it emits exactly the
// tear-offs used (an unused `final` local is a Dart `analyze` warning → CI red).
// `collectBoundInputFields` walks the page/component body for that set — the
// Flutter twin of Feliz's `collectPageBoundState`.  Homed here (not imported
// from `ir/util/walk`) so the generator keeps no backward edge into `ir/`;
// mirrors `forms-emit.ts`'s own local `exprChildren` walk.

import type { ExprIR } from "../../ir/types/loom-ir.js";

/** Walker-primitive names of the controlled inputs the flutter pack renders —
 *  each binds a `state` field via `bind:`.  (NumberField / FileUpload are still
 *  deferred; a `bind:` on them never reaches here because the validator gate
 *  rejects them on a flutter target.) */
export const FLUTTER_BOUND_INPUT_NAMES: ReadonlySet<string> = new Set([
  "Field",
  "MultilineField",
  "PasswordField",
  "Toggle",
  "SelectField",
]);

/** Immediate child expressions of `e` — a generator-local shallow walk (the
 *  same shape `forms-emit.ts` uses) so we don't import the `ir/util` walker
 *  against the pipeline layering. */
function exprChildren(e: ExprIR): ExprIR[] {
  switch (e.kind) {
    case "member":
      return [e.receiver];
    case "method-call":
      return [e.receiver, ...e.args];
    case "call":
      return e.args;
    case "lambda":
      return e.body ? [e.body] : [];
    case "object":
    case "new":
      return e.fields.map((f) => f.value);
    case "list":
      return e.elements;
    case "paren":
      return [e.inner];
    case "unary":
      return [e.operand];
    case "binary":
      return [e.left, e.right];
    case "ternary":
      return [e.cond, e.then, e.otherwise];
    case "convert":
      return [e.value];
    default:
      return [];
  }
}

/** The state-field name a controlled-input call binds via `bind:`, when it is a
 *  `ref` to a known state field; otherwise undefined. */
function boundFieldOf(
  call: Extract<ExprIR, { kind: "call" }>,
  stateNames: ReadonlySet<string>,
): string | undefined {
  const names = call.argNames ?? [];
  const idx = names.indexOf("bind");
  if (idx < 0) return undefined;
  const arg = call.args[idx];
  return arg && arg.kind === "ref" && stateNames.has(arg.name) ? arg.name : undefined;
}

/** State fields bound by a controlled input anywhere in `body` (deduped, in
 *  first-seen order).  Drives the page-shell setter tear-offs. */
export function collectBoundInputFields(
  body: ExprIR | undefined,
  stateNames: ReadonlySet<string>,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const visit = (e: ExprIR): void => {
    if (e.kind === "call" && FLUTTER_BOUND_INPUT_NAMES.has(e.name)) {
      const field = boundFieldOf(e, stateNames);
      if (field && !seen.has(field)) {
        seen.add(field);
        found.push(field);
      }
    }
    for (const c of exprChildren(e)) visit(c);
  };
  if (body) visit(body);
  return found;
}
