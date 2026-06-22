import type { ValueObjectIR } from "../../ir/types/loom-ir.js";
import { singleFieldShape } from "../../ir/validate/invariant-classify.js";
import { ashBuiltinValidate, exprUsesThis } from "./domain/predicates.js";
import { type RenderCtx, renderExpr } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Ash `validations` block for a value object's invariants.
//
// Used by BOTH the embedded single-VO resource (`total: Money` → an embedded
// Ash resource, `context-emit.ts:renderValueObjectModule`) and the
// value-collection child resource (`charges: Money[]` → a postgres child
// resource, `value-collection-resource-emit.ts`).  Closing the long-standing
// gap where a VO declared an invariant (`invariant amount >= 0`) but no
// backend enforced it on the Ash path — a negative Money persisted silently.
//
// Single-field shapes (`amount >= 0`, `code.length == 3`, a regex …) render
// to the idiomatic Ash built-in validators (`compare` / `string_length` /
// `match`); anything the classifier doesn't reduce to a single field falls
// back to a `validate fn changeset, _ -> … end` over the changeset's applied
// attributes (mirroring `domain-emit.ts:renderValidations`).
// ---------------------------------------------------------------------------

/** The `validations do … end` block for a value object's invariants, or "" when
 *  it declares none.  Leading newline so the resource template stays readable
 *  when absent (byte-identical with the pre-validation emit). */
export function renderVoValidations(vo: ValueObjectIR, ctxModule: string): string {
  const invariants = vo.invariants ?? [];
  if (invariants.length === 0) return "";
  const fieldNames = new Set(vo.fields.map((f) => f.name));
  const ctx: RenderCtx = { thisName: "record", contextModule: ctxModule };

  const lines = invariants.map((inv) => {
    // Idiomatic single-field built-in (`compare`/`string_length`/`match`).
    const single = singleFieldShape(inv);
    if (single && fieldNames.has(single.field)) {
      const builtin = ashBuiltinValidate(single.field, single.pattern);
      if (builtin) {
        const msg = JSON.stringify(`Invariant violated: ${inv.source}`);
        return `    ${builtin}, message: ${msg}`;
      }
    }
    // Function-form fallback — bind `record` from the changeset's applied
    // attributes when the predicate references the VO's own fields.
    const condStr = renderExpr(inv.expr, ctx);
    const msg = JSON.stringify(`Invariant violated: ${inv.source}`);
    const needsRecord = exprUsesThis(inv.expr) || (inv.guard ? exprUsesThis(inv.guard) : false);
    const recordLine = needsRecord
      ? "      {:ok, record} = Ash.Changeset.apply_attributes(changeset, force?: true)\n"
      : "";
    if (inv.guard) {
      const guardStr = renderExpr(inv.guard, ctx);
      return `    validate fn changeset, _opts ->\n${recordLine}      if not (${guardStr}) or (${condStr}), do: :ok, else: {:error, ${msg}}\n    end`;
    }
    return `    validate fn changeset, _opts ->\n${recordLine}      if ${condStr}, do: :ok, else: {:error, ${msg}}\n    end`;
  });
  return `\n  validations do\n${lines.join("\n")}\n  end\n`;
}
