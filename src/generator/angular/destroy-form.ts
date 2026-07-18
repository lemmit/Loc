import type { ExprIR } from "../../ir/types/loom-ir.js";
import { humanize, lowerFirst, plural, snake } from "../../util/naming.js";
import { emitActionThen } from "../_walker/primitives/controls.js";
import { namedArgValue, stringNamed } from "../_walker/shared/args.js";
import type { WalkContext } from "../_walker/walker-core.js";
import { addNg, formStyle } from "./form-fields.js";
import { angularSink } from "./walker/sink.js";

// ---------------------------------------------------------------------------
// Angular `DestroyForm(of: <Agg>, then?: navigate(...))` renderer — the
// confirmation form for the aggregate's CANONICAL destroy (loom-forms.md),
// forked from the shared `emitDestroyForm` via the `renderDestroyForm` walker
// seam.
//
// Confirmation-only (the canonical destroy takes no params): a destructive
// `mat-raised-button` whose `(click)` calls a "dumb template" method.  The
// method `window.confirm()`s, awaits `useDelete<Agg>` against the route id, then
// runs the optional `then:` effect — default: navigate to the aggregate's list
// route (`/<tag>`), since the record is gone after a successful delete.
// ---------------------------------------------------------------------------

/** What the page-shell needs to wire one DestroyForm's mutation + method. */
export interface AngularDestroyFormSpec {
  localVar: string;
  hookName: string;
  importFrom: string;
  /** The component method the `(click)` calls — confirms, mutates, redirects. */
  method: { name: string; confirmMsg: string; thenJs: string };
}

/** Prefix bare class-field identifiers with `this.` for a method-body context,
 *  skipping string-literal regions (so a route stays intact). */
function prefixThis(expr: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return expr;
  return expr
    .split(/("(?:[^"\\]|\\.)*")/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let out = part;
      for (const n of names) {
        out = out.replace(new RegExp(`(?<![.\\w])${n}\\b`, "g"), `this.${n}`);
      }
      return out;
    })
    .join("");
}

export function renderAngularDestroyForm(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  _depth: number,
): string | null {
  if (call.kind !== "call") return null;
  const ofArg = namedArgValue(call, "of");
  if (ofArg?.kind !== "ref") {
    return ctx.target.renderComment("DestroyForm: expected (of: <Agg>)");
  }
  const agg = ctx.aggregatesByName.get(ofArg.name);
  if (!agg) {
    return ctx.target.renderComment(`DestroyForm(of: ${ofArg.name}): aggregate not found`);
  }
  if (!agg.canonicalDestroy) {
    return ctx.target.renderComment(
      `DestroyForm(of: ${agg.name}): no canonical destroy — declare 'destroy { }' (or use 'with crudish')`,
    );
  }

  const localVar = `delete${agg.name}`;
  const hookName = `useDelete${agg.name}`;
  const importFrom = `../../api/${lowerFirst(agg.name)}`;
  const methodName = `onDelete${agg.name}`;
  // The confirm handler reads the route `id` — bind it via the shell's
  // ActivatedRoute snapshot (same param the detail pages bind).
  ctx.usedParams.add("id");

  // The `then:` effect renders in template scope, then `this.`-prefixed for the
  // method body.  Default: navigate to the aggregate's list route (the record is
  // gone post-delete).  `emitActionThen` / the default both set `usesNavigate`.
  const thenArg = namedArgValue(call, "then");
  const fieldNames = new Set<string>(["router", ...ctx.stateNames, ...ctx.paramNames]);
  let thenJs: string;
  if (thenArg) {
    thenJs = prefixThis(emitActionThen(thenArg, ctx), fieldNames);
  } else {
    ctx.usesNavigate = true;
    thenJs = `this.router.navigateByUrl(${JSON.stringify(`/${snake(plural(agg.name))}`)})`;
  }

  const confirmMsg = JSON.stringify(`Delete this ${humanize(agg.name).toLowerCase()}?`);
  const ns = stringNamed(call, "testid") ?? `${snake(plural(agg.name))}-destroy`;
  ctx.collectedTestids.add(ns);

  const style = formStyle(ctx);
  if (style === "material") addNg(ctx, "@angular/material/button", "MatButtonModule");
  else if (style === "primeng") addNg(ctx, "primeng/button", "ButtonModule");
  addNg(ctx, importFrom, hookName);

  const spec: AngularDestroyFormSpec = {
    localVar,
    hookName,
    importFrom,
    method: { name: methodName, confirmMsg, thenJs },
  };
  const specs = angularSink(ctx).destroyForms;
  if (!specs.some((s) => s.localVar === localVar)) specs.push(spec);

  const btnAttr =
    style === "material"
      ? 'mat-raised-button color="warn"'
      : style === "primeng"
        ? 'pButton severity="danger"'
        : 'class="loom-button loom-button-warn"';
  return `<button ${btnAttr} (click)="${methodName}()" [disabled]="${localVar}.isPending()" data-testid="${ns}">Delete ${humanize(agg.name)}</button>`;
}
