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

export function checkTemplateHoles(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isTemplateStr(node)) continue;
    const env = envForNode(node);
    for (let i = 0; i < node.holes.length; i++) {
      const hole = node.holes[i]!;
      const t: DddType = typeOf(hole, env);
      // `unknown` is already reported upstream (unresolved ref / bad expr) —
      // fail open so we don't double-report.
      if (t.kind === "unknown") continue;
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
