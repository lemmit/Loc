// Which page-local binding does a form primitive claim on each JS frontend —
// and where do two forms on one page claim the SAME one.
//
// Every JS-family frontend emits a form as page-scope `const`s spliced above
// the body (the mutation hook plus the form handle: `const create =
// useCreateItem(); const { register, handleSubmit, … } = useForm(...)`), and
// those names come out of the design pack's `form-of-decls` / `form-op-decls`
// templates.  Two forms on one page therefore emit two declarations, and
// whether that is FINE depends entirely on how the frontend names them:
//
//   react  / svelte — bare `create`, `form`, `register`, `handleSubmit`.  Two
//                     CreateForms on one page redeclare all of them, whatever
//                     aggregates they are over: TS2300 / a Svelte compile
//                     error.  Two OperationForms collide when the OP NAMES
//                     match (`const rename = …` twice), across aggregates too.
//   vue             — the same bare names, but the shell DEDUPES the decl
//                     strings, so it COMPILES and the second form silently
//                     reuses the first form's mutation and schema: a
//                     `CreateForm { of: Note }` posts an `Item`, announces
//                     "Note created" and navigates to `/notes/…`.  The worst
//                     of the four, because nothing fails.
//   angular         — locals are already AGGREGATE-SCOPED (`itemCreate`,
//                     `itemForm`, `renameItem`), so different aggregates are
//                     fine; only two forms over the SAME aggregate+op collide.
//
// Angular is the existence proof that the fix is per-form-instance naming;
// generalising it means threading a per-form prefix through the ~68 pack
// templates that hardcode `create` / `register` / `handleSubmit` / `errors`.
// Until that lands, this module is the single place that knows the rule, so
// the gate (`loom.page-form-locals-unsupported`) and the eventual fix disagree
// in exactly one file.
//
// Shapes deliberately NOT flagged, because they were probed and are CLEAN on
// all four: `CreateForm` + `OperationForm` on one page, and two
// `OperationForm`s over DIFFERENT ops.  A gate that fired on those would be a
// false refusal.

import type { ExprIR, UiIR } from "../types/loom-ir.js";
import { walkExprDeep } from "./walk.js";

/** The frontends whose form locals are aggregate-scoped already.  Everything
 *  else in the JS family emits bare names — see the module comment. */
const AGGREGATE_SCOPED_FORM_LOCALS = new Set(["angular"]);

/** The frontends this rule applies to at all.  Feliz / Flutter / HEEx build
 *  their forms through different machinery (Elmish messages, Riverpod
 *  notifiers, `handle_event` clauses) and are NOT covered here — a gate that
 *  named them would be a refusal nobody verified. */
export const FORM_LOCAL_FRAMEWORKS = new Set(["react", "vue", "svelte", "angular"]);

/** One form primitive found in a body, reduced to the identity that decides
 *  collisions.  `kind` separates the two naming families (a create form and an
 *  operation form never claim the same names). */
interface FormSite {
  kind: "create" | "operation";
  /** The `of:` aggregate, when the call spells one. */
  agg: string | undefined;
  /** The operation name, for `kind === "operation"`. */
  op: string | undefined;
  /** Source spelling, for the diagnostic. */
  label: string;
}

/** The named argument `name` of a primitive call, if present. */
function namedArgOf(call: Extract<ExprIR, { kind: "call" }>, name: string): ExprIR | undefined {
  const names = call.argNames;
  if (!names) return undefined;
  const i = names.indexOf(name);
  return i >= 0 ? call.args[i] : undefined;
}

/** A bare `ref`'s name — how `of: Item` / `op: rename` lower (both are
 *  `refKind: "unknown"` refs at this point; the walker resolves them). */
function refName(e: ExprIR | undefined): string | undefined {
  return e?.kind === "ref" ? e.name : undefined;
}

/** Every form primitive in a body, in source order. */
function formSites(body: ExprIR | undefined): FormSite[] {
  const out: FormSite[] = [];
  walkExprDeep(body, (e) => {
    if (e.kind !== "call") return;
    if (e.name === "CreateForm") {
      const agg = refName(namedArgOf(e, "of") ?? e.args[0]);
      out.push({
        kind: "create",
        agg,
        op: undefined,
        label: `CreateForm${agg ? ` { of: ${agg} }` : ""}`,
      });
      return;
    }
    if (e.name === "OperationForm") {
      const ofArg = namedArgOf(e, "of");
      const opArg = namedArgOf(e, "op");
      if (ofArg || opArg) {
        const agg = refName(ofArg);
        const op = refName(opArg);
        out.push({
          kind: "operation",
          agg,
          op,
          label: `OperationForm { of: ${agg ?? "?"}, op: ${op ?? "?"} }`,
        });
        return;
      }
      // The `<instance>.<op>` spelling — the aggregate is not named, so the op
      // alone is the identity (which is exactly what react/svelte name it by).
      const first = e.args[0];
      if (first?.kind === "member") {
        out.push({
          kind: "operation",
          agg: undefined,
          op: first.member,
          label: `OperationForm { …${first.member} }`,
        });
      }
    }
  });
  return out;
}

/** The page-local binding family a form site claims on `framework`. */
function localKey(site: FormSite, framework: string): string {
  const scoped = AGGREGATE_SCOPED_FORM_LOCALS.has(framework);
  if (site.kind === "create") {
    // react/svelte/vue name it `create` flat out — no aggregate in the name —
    // so ALL create forms on a page share one key there.
    return scoped ? `create:${site.agg ?? "?"}` : "create";
  }
  return scoped ? `op:${site.agg ?? "?"}.${site.op ?? "?"}` : `op:${site.op ?? "?"}`;
}

/** The form sites in one body that would emit a COLLIDING page-local, grouped
 *  by the local they collide on.  Empty when the body is fine. */
export function collidingFormLocals(
  body: ExprIR | undefined,
  framework: string,
): { local: string; labels: string[] }[] {
  const byKey = new Map<string, string[]>();
  for (const site of formSites(body)) {
    const key = localKey(site, framework);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(site.label);
    else byKey.set(key, [site.label]);
  }
  return [...byKey]
    .filter(([, labels]) => labels.length > 1)
    .map(([local, labels]) => ({ local, labels }));
}

/** Every page/component of a ui whose forms would collide on `framework`,
 *  labelled for a diagnostic.  Components are scanned too — a form moved into
 *  a component collides inside THAT component's own shell for the same
 *  reason. */
export function formLocalCollisionHosts(
  ui: UiIR,
  framework: string,
): { what: string; local: string; labels: string[] }[] {
  const out: { what: string; local: string; labels: string[] }[] = [];
  for (const p of ui.pages) {
    for (const c of collidingFormLocals(p.body, framework)) {
      out.push({ what: `page '${p.name}'`, ...c });
    }
  }
  for (const c of ui.components) {
    for (const hit of collidingFormLocals(c.body, framework)) {
      out.push({ what: `component '${c.name}'`, ...hit });
    }
  }
  return out;
}
