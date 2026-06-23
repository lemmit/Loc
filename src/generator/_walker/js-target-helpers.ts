// Shared leaf helpers for the JS-family `WalkerTarget` implementations
// (tsx / svelte / vue).  These targets speak the same surface JS — the
// TanStack Query hook-name family, the decimal.js money convention,
// JSX-style `{}`-significant text — so their private helper tails were
// three byte-identical copies before this module.  HEEx stays apart
// (Elixir spellings throughout).
//
// Behaviour contract: every function here must keep the exact output
// of the per-target copies it replaced — the per-frontend
// byte-identity gates pin this.

import type { TypeIR } from "../../ir/types/loom-ir.js";

/** Hook local-variable name: `customerAll`, `orderCreate`. */
export function hookVarName(aggregate: string, op: string): string {
  return `${lowerFirstName(aggregate)}${upperFirstName(op)}`;
}

/** TanStack-Query hook fn name — the `use<Op><Single>` family shared
 *  by react-query / svelte-query / vue-query (mirrors
 *  `walker/api-hooks.ts`). */
export function hookFnName(aggregate: string, op: string): string {
  const single = upperFirstName(aggregate);
  const pluralName = pluralName_(single);
  if (op === "all") return `useAll${pluralName}`;
  if (op === "byId") return `use${single}ById`;
  if (op === "create") return `useCreate${single}`;
  if (op === "update") return `useUpdate${single}`;
  if (op === "delete") return `useDelete${single}`;
  return `use${upperFirstName(op)}${single}`;
}

/** Zero value per type — JS literals; same table for every JS-family
 *  frontend (shared wire shape + decimal.js money convention). */
export function defaultInitForJs(type: TypeIR): string {
  if (type.kind === "primitive") {
    switch (type.name) {
      case "int":
      case "long":
      case "decimal":
        return "0";
      case "money":
        return 'new Decimal("0")';
      case "bool":
        return "false";
      case "string":
      case "datetime":
      case "guid":
        return '""';
    }
  }
  if (type.kind === "id" || type.kind === "enum") return '""';
  if (type.kind === "optional") return "undefined";
  return "undefined";
}

/** Chained parenthesised ternary — the `match { … }` lowering every
 *  JS-family target shares (depth-aware brace wrapping is the
 *  caller's job). */
export function renderJsMatch(
  arms: ReadonlyArray<{ predicate: string; value: string }>,
  elseArm: string | undefined,
): string {
  const terminal = elseArm ?? "null";
  let out = terminal;
  for (let i = arms.length - 1; i >= 0; i--) {
    const a = arms[i]!;
    out = `(${a.predicate}) ? (${a.value}) : ${out}`;
  }
  return out;
}

/** `navigate(route, { state })` call — shared by tsx (react-router)
 *  and svelte (the goto-aliased import); vue's router.push shape
 *  stays per-target. */
export function renderJsNavigate(
  routeTemplate: string,
  args: ReadonlyArray<{ name: string; value: string }>,
  stateExpr?: string,
): string {
  // Escape hatch: a non-object-literal second arg (the source's
  // `navigate(Page, someExpr)` shape) flows through pre-rendered.
  // Takes precedence over `args` — caller picks one path.
  if (stateExpr !== undefined) {
    return `navigate(${JSON.stringify(routeTemplate)}, { state: ${stateExpr} })`;
  }
  if (args.length === 0) {
    return `navigate(${JSON.stringify(routeTemplate)})`;
  }
  const state = args.map((a) => `${a.name}: ${a.value}`).join(", ");
  return `navigate(${JSON.stringify(routeTemplate)}, { state: { ${state} } })`;
}

/** Text escaping for the `{}`-significant JSX-family text position —
 *  identical for tsx / svelte / vue markup. */
export function escapeJsFamilyText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Local naming helpers — verbatim behaviour with `util/naming.ts` for
// the inputs the walker produces; kept here so the helper module's
// output can never drift behind a naming-rule change without the
// byte-identity gates noticing.
export function lowerFirstName(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
}

export function upperFirstName(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** The exported store-hook name for a `store <Name>` (Stage 5).  Shared by
 *  the JS-family targets' store seam + the React store-module emitter so
 *  the use-site selector (`useCart((s) => s.lines)`) and the module's
 *  `export const useCart` agree.  `Cart` → `useCart`. */
export function storeHookName(storeName: string): string {
  return `use${upperFirstName(storeName)}`;
}

/** Conservative plural rules matching `src/util/naming.ts:plural`. */
function pluralName_(s: string): string {
  if (s.endsWith("y") && !/[aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(s)) return `${s}es`;
  return `${s}s`;
}

/** True when `ident` appears as a whole-word token in `code`.  Used by
 *  the list-comprehension targets to decide whether to emit the
 *  synthesised index binding — an unused loop index trips
 *  `noUnusedFunctionParameters` (TSX) / framework lints.  `ident` is a
 *  generated identifier (`<item>Idx`), so the word-boundary test is
 *  safe without escaping. */
export function referencesIdent(code: string, ident: string): boolean {
  return new RegExp(`\\b${ident}\\b`).test(code);
}
