// ---------------------------------------------------------------------------
// View-model preparer for a single form-input field.  Picks the
// right field-input-* template per type and assembles the VM data
// the template needs.  Recursive value-objects don't render here —
// the preparer returns nested children, the renderer walks them in
// TS so the per-pack templates stay flat.
//
// Mirrors the legacy formInput in form-helpers.ts.  Same testid
// shape, same option-label resolution (X id's display field),
// same placeholder fallback when an X id's target lacks a display.
// ---------------------------------------------------------------------------

import type { AggregateIR, BoundedContextIR, TypeIR } from "../../../../ir/loom-ir.js";
import { humanize } from "../../../../util/naming.js";
import { idTargetHookVar, unwrapOpt } from "../../form-helpers.js";
import type { FormFieldVM } from "../view-models.js";

export function prepareFormFieldVM(
  path: string,
  t: TypeIR,
  ctx: BoundedContextIR,
  testId: string,
  aggregatesByName: Map<string, AggregateIR>,
): FormFieldVM {
  const inner = unwrapOpt(t);
  // Label = humanised leaf segment so nested VO fields render as
  // "Amount" / "Currency" rather than "price.amount" / etc.
  const leaf = path.split(".").pop()!;
  const label = humanize(leaf);
  const errorExpr = errorAccess(path);

  if (inner.kind === "primitive") {
    if (inner.name === "int" || inner.name === "long") {
      return { template: "field-input-int", path, label, testId, errorExpr };
    }
    if (inner.name === "decimal") {
      return { template: "field-input-decimal", path, label, testId, errorExpr };
    }
    if (inner.name === "money") {
      return { template: "field-input-money", path, label, testId, errorExpr };
    }
    if (inner.name === "bool") {
      return { template: "field-input-bool", path, label, testId, errorExpr };
    }
    if (inner.name === "datetime") {
      return { template: "field-input-datetime", path, label, testId, errorExpr };
    }
    return { template: "field-input-string", path, label, testId, errorExpr };
  }

  if (inner.kind === "id") {
    const target = aggregatesByName.get(inner.targetName);
    const displayFieldName = target ? simpleDisplayFieldName(target) : undefined;
    if (!target || !displayFieldName) {
      const reason = !target
        ? `${inner.targetName} id: target aggregate not found`
        : `Aggregate '${inner.targetName}' has no 'derived display' or its display is not a single-field reference — declare 'derived display: string = <field>' to enable a Select picker for ${inner.targetName} id.`;
      return {
        template: "field-input-id-text",
        path,
        label,
        testId,
        errorExpr,
        placeholderJson: JSON.stringify(`<id> — ${reason}`),
      };
    }
    return {
      template: "field-input-id-select",
      path,
      label,
      testId,
      errorExpr,
      hookVar: idTargetHookVar(target),
      displayField: displayFieldName,
    };
  }

  if (inner.kind === "enum") {
    const en = ctx.enums.find((e) => e.name === inner.name);
    if (en) {
      return {
        template: "field-input-enum-select",
        path,
        label,
        testId,
        errorExpr,
        enumValuesJson: JSON.stringify(en.values),
      };
    }
    return { template: "field-input-string", path, label, testId, errorExpr };
  }

  if (inner.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === inner.name);
    if (vo) {
      const children = vo.fields.map((vf) =>
        prepareFormFieldVM(
          `${path}.${vf.name}`,
          vf.type,
          ctx,
          `${testId}-${vf.name}`,
          aggregatesByName,
        ),
      );
      return {
        template: "field-input-valueobject",
        path,
        label,
        testId,
        errorExpr,
        children,
      };
    }
    return { template: "field-input-string", path, label, testId, errorExpr };
  }

  if (inner.kind === "array") {
    return { template: "field-input-array", path, label, testId, errorExpr };
  }

  return { template: "field-input-string", path, label, testId, errorExpr };
}

/** RHF errors live at `errors.foo.bar.baz?.message` — translate a dot-
 *  path into the matching access expression. */
function errorAccess(path: string): string {
  const parts = path.split(".");
  return `errors.${parts.join("?.")}?.message`;
}

/** Resolve the underlying wire field name for a target aggregate's
 * `derived display: string` — but only when the display expression is a
 * single bare property reference (`derived display: string = name`).
 * Compound displays (`= firstName + " " + lastName`) need a function-
 * shape rendering on the React side; that's a follow-up.  Returns
 * `undefined` when no display is declared or it's compound. */
function simpleDisplayFieldName(agg: AggregateIR): string | undefined {
  const d = agg.displayDerived;
  if (!d) return undefined;
  const e = d.expr;
  if (e.kind === "ref" && e.refKind === "this-prop") return e.name;
  return undefined;
}
