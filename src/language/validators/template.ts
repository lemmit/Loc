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
import { isTemplateStr, type Model } from "../generated/ast.js";
import {
  type DddType,
  envForNode,
  isImplicitlyStringifiable,
  typeOf,
  typeToString,
} from "../type-system.js";

/** ICU format kinds slice 1 supports (i18n, M-T1.11).  `currency`/`percent`
 *  are NUMBER sub-skeletons (`, number, ::currency/USD`), so the ICU *type* is
 *  always one of these three; `plural`/`select` (brace-bodied) are deferred to
 *  slice 2. */
type FormatKind = "number" | "date" | "time" | "unsupported";

/** The ICU top-level type of a raw format suffix (`", number, ::currency/USD"`
 *  → `"number"`), or `undefined` when the hole carries no format. */
function formatKind(format: string | undefined): FormatKind | undefined {
  if (format === undefined) return undefined;
  // Strip the leading comma, take the first token (the ICU argType).
  const argType = format.replace(/^,/, "").trim().split(/[\s,]/)[0] ?? "";
  if (argType === "number" || argType === "date" || argType === "time") return argType;
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
            `Unsupported template format '${hole.format?.trim()}'. This release supports ` +
              `number formats (\`, number\`, \`, number, ::currency/USD\`, \`, number, ::percent\`) ` +
              `and date/time formats (\`, date, ::yMMMd\`, \`, time, short\`). ` +
              `Plural and select are not yet available.`,
            { node, property: "holes", index: i, code: "loom.interp-format-unsupported" },
          );
          continue;
        }
        if (kind === "date" || kind === "time") {
          // Date/time formatting LIFTS the datetime rejection below — a
          // `datetime` hole is exactly what these skeletons format.
          if (t.kind === "primitive" && t.name === "datetime") continue;
          accept(
            "error",
            `A '${kind}' format expects a 'datetime' value, but this hole is '${typeToString(t)}'.`,
            { node, property: "holes", index: i, code: "loom.interp-hole-type" },
          );
          continue;
        }
        // kind === "number" — a numeric value the locale formatter can render.
        if (isNumericType(t)) continue;
        accept(
          "error",
          `A 'number' format expects a numeric value (int, decimal, or money), but this hole ` +
            `is '${typeToString(t)}'.`,
          { node, property: "holes", index: i, code: "loom.interp-hole-type" },
        );
        continue;
      }

      // No format suffix — the original stringifiable-hole rule.
      const isString = t.kind === "primitive" && t.name === "string";
      if (isString || isImplicitlyStringifiable(t)) continue;
      accept(
        "error",
        `Cannot interpolate a '${typeToString(t)}' — a template hole must be a string or a ` +
          `stringifiable value (number, bool, enum, an 'X id', or an aggregate with a ` +
          `'derived display'). Convert it first (e.g. wrap in a 'derived' that formats it).`,
        { node, property: "holes", index: i, code: "loom.interp-hole-type" },
      );
    }
  }
}
