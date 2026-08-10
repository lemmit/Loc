// A6 string interpolation — hole-type check.  A backtick template
// (`TemplateStr`) lowers to `string + <hole>` concatenation, so every hole
// must be a value the implicit `string + X` rule already stringifies:
// `string` itself, the numeric primitives, `bool`, an enum, an `X id`, or an
// aggregate carrying a `derived display: string`.  A hole of any other type
// (`datetime`, `duration`, a raw aggregate without `display`, a collection)
// has no stringification and is rejected here — the same set the explicit
// `string(x)` conversion admits.
//
//   loom.interp-hole-type — the hole expression is not stringifiable

import { AstUtils, type ValidationAcceptor } from "langium";
import { diagMessage } from "../../diagnostics/messages.js";
import { isTemplateStr, type Model } from "../generated/ast.js";
import {
  type DddType,
  envForNode,
  isImplicitlyStringifiable,
  typeOf,
  typeToString,
} from "../type-system.js";

/** ICU format kinds Loom supports (i18n, M-T1.11).  `currency`/`percent` are
 *  NUMBER sub-skeletons (`, number, ::currency/USD`), so the number ICU *type*
 *  covers all three; `plural`/`selectordinal` are the count-driven branch forms
 *  (slice 2) and `select` the string-driven one — all rendered natively by the
 *  `intl-messageformat` runtime the shim ships. */
type FormatKind = "number" | "date" | "time" | "plural" | "select" | "unsupported";

/** The ICU top-level type of a raw format suffix (`", number, ::currency/USD"`
 *  → `"number"`, `", plural, one {…} other {…}"` → `"plural"`), or `undefined`
 *  when the hole carries no format. */
function formatKind(format: string | undefined): FormatKind | undefined {
  if (format === undefined) return undefined;
  // Strip the leading comma, take the first token (the ICU argType).
  const argType = format.replace(/^,/, "").trim().split(/[\s,]/)[0] ?? "";
  if (argType === "number" || argType === "date" || argType === "time") return argType;
  // `plural` and `selectordinal` are both count-driven (numeric arg); `select`
  // is string-driven.  Normalise `selectordinal` onto `plural`'s numeric rule.
  if (argType === "plural" || argType === "selectordinal") return "plural";
  if (argType === "select") return "select";
  return "unsupported";
}

function isNumericType(t: DddType): boolean {
  return (
    t.kind === "primitive" &&
    (t.name === "int" || t.name === "long" || t.name === "decimal" || t.name === "money")
  );
}

export function checkTemplateHoles(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isTemplateStr(node)) continue;
    const env = envForNode(node);
    for (let i = 0; i < node.holes.length; i++) {
      const hole = node.holes[i]!;
      const t: DddType = typeOf(hole.value, env);
      // `unknown` is already reported upstream (unresolved ref / bad expr) —
      // fail open so we don't double-report.
      if (t.kind === "unknown") continue;

      const kind = formatKind(hole.format);
      if (kind !== undefined) {
        // A `, format` suffix (i18n) narrows what the hole may hold.
        if (kind === "unsupported") {
          accept(
            "error",
            diagMessage("loom.interp-format-unsupported", { format: hole.format?.trim() }),
            { node, property: "holes", index: i, code: "loom.interp-format-unsupported" },
          );
          continue;
        }
        if (kind === "select") {
          // `select` matches the value (coerced to a string by ICU) against its
          // branch keys — any stringifiable hole works (string, enum, id, …).
          if (t.kind === "primitive" && t.name === "string") continue;
          if (isImplicitlyStringifiable(t)) continue;
          accept(
            "error",
            diagMessage("loom.interp-hole-type#select-format", { t: typeToString(t) }),
            { node, property: "holes", index: i, code: "loom.interp-hole-type" },
          );
          continue;
        }
        if (kind === "date" || kind === "time") {
          // Date/time formatting LIFTS the datetime rejection below — a
          // `datetime` hole is exactly what these skeletons format.
          if (t.kind === "primitive" && t.name === "datetime") continue;
          accept(
            "error",
            diagMessage("loom.interp-hole-type#date-format", { kind, t: typeToString(t) }),
            { node, property: "holes", index: i, code: "loom.interp-hole-type" },
          );
          continue;
        }
        // kind === "number" | "plural" — both operate on a numeric value (the
        // locale formatter renders it; plural selects a branch by its count).
        if (isNumericType(t)) continue;
        accept(
          "error",
          diagMessage("loom.interp-hole-type#number-format", { kind, t: typeToString(t) }),
          { node, property: "holes", index: i, code: "loom.interp-hole-type" },
        );
        continue;
      }

      // No format suffix — the original stringifiable-hole rule.
      const isString = t.kind === "primitive" && t.name === "string";
      if (isString || isImplicitlyStringifiable(t)) continue;
      accept(
        "error",
        diagMessage("loom.interp-hole-type#not-stringifiable", { t: typeToString(t) }),
        { node, property: "holes", index: i, code: "loom.interp-hole-type" },
      );
    }
  }
}
