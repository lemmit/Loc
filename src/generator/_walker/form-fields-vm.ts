// ---------------------------------------------------------------------------
// View-model preparer for a single form-input field.  Picks the
// right field-input-* template per type and assembles the VM data
// the template needs.  Recursive value-objects don't render here —
// the preparer returns nested children, the renderer walks them in
// TS so the per-pack templates stay flat.
//
// Shares the testid shape and option-label resolution rules
// (`X id`'s display field; placeholder fallback when the target
// lacks a display) with `formInput` in form-helpers.ts.
// ---------------------------------------------------------------------------

import type { AggregateIR, BoundedContextIR, TypeIR } from "../../ir/types/loom-ir.js";
import { humanize } from "../../util/naming.js";
import { idTargetHookVar, unwrapOpt } from "../_frontend/form-helpers.js";
import type { FormFieldVM } from "../_frontend/view-models.js";

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
    if (inner.name === "File") {
      // A `File`-typed field renders a file-upload input: the pack's
      // `field-input-file` template wraps a `<Controller>` whose
      // `onChange` receives the uploaded `FileRef` (via `api.upload`).
      // Mirrors the `money` compound-value arm above.
      return { template: "field-input-file", path, label, testId, errorExpr };
    }
    return { template: "field-input-string", path, label, testId, errorExpr };
  }

  if (inner.kind === "id") {
    const target = aggregatesByName.get(inner.targetName);
    // The Select picker reads the option label off the wire `display`
    // field — backends emit the `derived display: string = ...`
    // expression as a JSON field on the response DTO, so the picker
    // doesn't need to know the underlying source expression shape.
    // Compound displays (`firstName + " " + lastName`), member-access
    // displays (`address.city`), and conditional displays all work
    // because the server evaluates them and ships the resolved string.
    // Text-input fallback only when there's truly no display to read
    // — target unresolved (cross-module ref to an aggregate the
    // context doesn't see) or target has no `derived display` at all.
    if (!target?.displayDerived) {
      const reason = !target
        ? `${inner.targetName} id: target aggregate not found`
        : `Aggregate '${inner.targetName}' has no 'derived display' — declare 'derived display: string = <expr>' to enable a Select picker for ${inner.targetName} id.`;
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
      displayField: "display",
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
    // An array of a value-object → a dynamic-row field-array: one repeatable
    // group per element, each carrying the value-object's sub-fields.  The row
    // sub-fields carry BARE sub-paths (`sku`) so a `useFieldArray`-style template
    // splices the runtime index (`items.${index}.sku`).  A scalar array (or an
    // element we can't resolve) leaves `rowFields` undefined → the pack's
    // disabled stub, byte-identical to before.
    const el = inner.element;
    if (el.kind === "valueobject") {
      const vo = ctx.valueObjects.find((v) => v.name === el.name);
      if (vo) {
        // Row sub-fields carry a BARE sub-path (`sku`, not `items.sku`) so a
        // dynamic-row template splices the runtime index; numeric sub-fields
        // flag `valueAsNumber` so their register coerces the string input.
        const NUMERIC = new Set(["field-input-int", "field-input-decimal", "field-input-money"]);
        const rowFields = vo.fields.map((vf) => {
          const vm = prepareFormFieldVM(
            vf.name,
            vf.type,
            ctx,
            `${testId}-${vf.name}`,
            aggregatesByName,
          );
          return NUMERIC.has(vm.template) ? { ...vm, valueAsNumber: true } : vm;
        });
        // A fresh-row default for `append(...)` — zero value per sub-field kind.
        const defaultRowJson = `{ ${rowFields
          .map(
            (f) =>
              `${f.path}: ${f.valueAsNumber ? "0" : f.template === "field-input-bool" ? "false" : '""'}`,
          )
          .join(", ")} }`;
        return {
          template: "field-input-array",
          path,
          label,
          testId,
          errorExpr,
          rowFields,
          elementLabel: humanize(el.name),
          arrayPascal: leaf.charAt(0).toUpperCase() + leaf.slice(1),
          defaultRowJson,
        };
      }
    }
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
