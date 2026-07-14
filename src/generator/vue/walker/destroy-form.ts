// ---------------------------------------------------------------------------
// Vue `DestroyForm(of: <Agg>, then?: navigate(...))` renderer — the
// confirmation form for the aggregate's CANONICAL destroy (loom-forms.md),
// forked from the shared `emitDestroyForm` via the `renderDestroyForm` walker
// seam.
//
// Why Vue forks it: the shared handler is `() => { if (window.confirm(…)) … }`,
// which the shared path drops inline into a `@click` template expression. Vue
// templates can't reference `window` (it isn't on the SFC compiler's global
// allow-list) nor the route `id` unless it's a setup binding — so the whole
// handler is HOISTED into `<script setup>` (where `window`, the route `id`, the
// vue-query mutation handle and `navigate` all resolve as plain JS) and the
// button just references it by name.
// ---------------------------------------------------------------------------

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { humanize, lowerFirst, plural, snake } from "../../../util/naming.js";
import { emitActionThen } from "../../_walker/primitives/controls.js";
import { renderPrimitive } from "../../_walker/render-primitive.js";
import { namedArgValue, stringNamed } from "../../_walker/shared/args.js";
import type { WalkContext } from "../../_walker/walker-core.js";

export function renderVueDestroyForm(
  call: ExprIR,
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

  // The delete mutation handle (hoisted by the page shell as
  // `const delete<Agg> = reactive(useDelete<Agg>())`).
  const localVar = `delete${agg.name}`;
  const hookName = `useDelete${agg.name}`;
  if (!ctx.actionMutations.some((m) => m.localVar === localVar)) {
    ctx.actionMutations.push({ localVar, hookName, aggCamel: lowerFirst(agg.name), idExpr: "" });
  }
  // The handler reads the route `id`; flag it so the shell declares
  // `const id = route.params.id as string` (as the detail pages do, and as
  // React's `useParams<{id:string}>()` does — unconditionally on `usesRouteId`).
  ctx.usedParams.add("id");
  ctx.usesRouteId = true;

  // After a successful delete the record is gone, so the default `then:`
  // navigates to the aggregate's list route (loom-forms.md §submission).
  const thenArg = namedArgValue(call, "then");
  let thenJs: string;
  if (thenArg) {
    thenJs = emitActionThen(thenArg, ctx);
  } else {
    ctx.usesNavigate = true;
    thenJs = `navigate(${JSON.stringify(`/${snake(plural(agg.name))}`)})`;
  }
  const confirmMsg = JSON.stringify(`Delete this ${humanize(agg.name).toLowerCase()}?`);

  const handlerName = `onDelete${agg.name}`;
  ctx.hoistedHandlers ??= [];
  ctx.hoistedHandlers.push(
    `const ${handlerName} = () => { if (window.confirm(${confirmMsg})) void ${localVar}.mutateAsync(id ?? "").then(() => { ${thenJs}; }); };`,
  );

  const testidNamespace = stringNamed(call, "testid") ?? `${snake(plural(agg.name))}-destroy`;
  ctx.collectedTestids.add(testidNamespace);
  return renderPrimitive(ctx, "primitive-button", {
    label: `Delete ${humanize(agg.name)}`,
    onClick: handlerName,
    hasOnClick: true,
    disabled: undefined,
    hasDisabled: false,
    loading: `${localVar}.isPending`,
    hasLoading: true,
    testidAttr: ` data-testid="${testidNamespace}"`,
    styleAttr: "",
  });
}
