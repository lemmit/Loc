// ---------------------------------------------------------------------------
// Svelte `WalkerTarget` — Svelte 5 (runes) implementation of the
// cross-framework walker contract.  See `src/generator/_walker/target.ts`
// for the contract definition and scope.
//
// Svelte 5 sits remarkably close to TSX for the shared markup walker:
// `{expr}` interpolation, `<Comp x={y}/>` invocation and
// `data-testid={expr}` are byte-compatible, and the runes state model
// reads like plain JS.  The deltas this target owns:
//
//   - state writes are plain assignments (`count = v`, no setter)
//   - api factories come from `$lib/api/*` (same use* names as the
//     react packs — @tanstack/svelte-query v6 returns reactive
//     objects with the same .data/.isPending/.mutate surface)
//   - navigation is SvelteKit's `goto()`
//   - conditional CHILDREN render as `{#if}` blocks (Svelte template
//     expressions cannot evaluate to markup)
//   - comments are HTML comments; the style attr is a CSS string
// ---------------------------------------------------------------------------

import type { ExprIR, StateFieldIR, TypeIR } from "../../../ir/types/loom-ir.js";
import type { DetectedApiCall } from "../../_walker/api-hook-detector.js";
import type {
  ApiCallSite,
  RenderPosition,
  StateRef,
  TargetHookUse,
  WalkerTarget,
} from "../../_walker/target.js";

export const svelteTarget: WalkerTarget = {
  framework: "svelte",

  // --- State seam ---------------------------------------------------------

  /** Runes state reads are bare identifiers in template and handler
   *  position alike — `let step = $state(0)` then `step`. */
  renderStateRead(ref: StateRef, _position: RenderPosition): string {
    return ref.name;
  },

  /** Plain reassignment — `$state` makes the assignment reactive;
   *  no setter convention exists. */
  renderStateWrite(ref: StateRef, value: string): string {
    return `${ref.name} = ${value}`;
  },

  /** Same JS zero values as TSX (the generated app shares the wire
   *  shape and the decimal.js money representation). */
  renderStateInit(field: StateFieldIR, init: ExprIR | undefined): string {
    if (init !== undefined) {
      // Caller pre-renders explicit initializers via its own walker
      // context (mirrors tsxTarget.renderStateInit's contract note).
      return defaultInitForSvelte(field.type);
    }
    return defaultInitForSvelte(field.type);
  },

  // --- API binding seam ---------------------------------------------------

  /** Identical naming to the TSX target — the svelte api modules
   *  export the same `useAll<Plural>` / `useCreate<Single>` /
   *  `use<X>View` factories (svelte-query v6's createQuery returns a
   *  reactive object with the React-Query property surface), so the
   *  page-level wiring is name-compatible.  Only the import root
   *  differs: SvelteKit's `$lib/api/*` alias instead of relative
   *  `../api/*`. */
  buildHookUse(detected: DetectedApiCall, renderArg: (e: ExprIR) => string): TargetHookUse {
    if (detected.kind === "view") {
      const viewName = detected.aggregateName;
      const viewPascal = upperFirstLocal(viewName);
      return {
        varName: `${lowerFirstLocal(viewName)}View`,
        hookName: `use${viewPascal}View`,
        importFrom: "$lib/api/views",
        argsRendered: [],
      };
    }
    if (detected.kind === "workflow-instance") {
      const wf = upperFirstLocal(detected.aggregateName);
      const isAll = detected.operation === "all";
      return {
        varName: isAll ? `all${wf}Instances` : `${lowerFirstLocal(detected.aggregateName)}Instance`,
        hookName: isAll ? `useAll${wf}Instances` : `use${wf}InstanceById`,
        importFrom: "$lib/api/workflows",
        argsRendered: detected.args.map(renderArg),
      };
    }
    const aggregate = detected.aggregateName;
    const op = detected.operation;
    return {
      varName: hookVarName(aggregate, op),
      hookName: hookFnName(aggregate, op),
      importFrom: `$lib/api/${lowerFirstLocal(upperFirstLocal(aggregate))}`,
      argsRendered: detected.args.map(renderArg),
    };
  },

  /** Like TSX: call sites reference the hoisted local; chained
   *  access (`.data`, `.mutate(args)`) comes from the surrounding IR
   *  walk. */
  renderApiCall(call: ApiCallSite, _renderedArgs: string): string {
    return call.varName ?? hookVarName(call.aggregateName, call.operation);
  },

  /** Hoist `const <var> = use<X>(args);` lines — svelte-query
   *  factories are invoked once in component-init position exactly
   *  like React hooks.  Parameterised reads wrap each rendered arg
   *  in an accessor (`() => arg`) because svelte-query v6 takes
   *  thunks for reactive arguments (route params change without a
   *  component re-mount). */
  renderApiHoisting(uses: ApiCallSite[]): string[] {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const u of uses) {
      const varName = u.varName ?? hookVarName(u.aggregateName, u.operation);
      if (seen.has(varName)) continue;
      seen.add(varName);
      const hookName = u.hookName ?? hookFnName(u.aggregateName, u.operation);
      const args = (u.argsRendered ?? []).map((a) => `() => ${a}`);
      lines.push(`const ${varName} = ${hookName}(${args.join(", ")});`);
    }
    return lines;
  },

  // --- Match expression seam ----------------------------------------------

  /** Chained ternaries — valid in Svelte EXPRESSION position (match
   *  arms are values; markup-bearing conditionals route through
   *  `renderConditionalChild` instead).  Same emission as TSX. */
  renderMatch(
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
  },

  // --- Navigation seam ----------------------------------------------------

  /** SvelteKit navigation through the `navigate` local.  The svelte
   *  page shell imports `{ goto as navigate }` from `$app/navigation`
   *  so every walker-emitted `navigate(...)` call — including the
   *  pack templates' default-submit redirect statements, which the
   *  shared form primitives compose with the literal name
   *  `navigate` — resolves without a walker-side seam.  Route state
   *  rides the shallow-routing `state` option (read back via
   *  `page.state`). */
  renderNavigate(
    routeTemplate: string,
    args: ReadonlyArray<{ name: string; value: string }>,
    stateExpr?: string,
  ): string {
    if (stateExpr !== undefined) {
      return `navigate(${JSON.stringify(routeTemplate)}, { state: ${stateExpr} })`;
    }
    if (args.length === 0) {
      return `navigate(${JSON.stringify(routeTemplate)})`;
    }
    const state = args.map((a) => `${a.name}: ${a.value}`).join(", ");
    return `navigate(${JSON.stringify(routeTemplate)}, { state: { ${state} } })`;
  },

  // --- Type-default seam --------------------------------------------------

  defaultInitFor(type: TypeIR): string {
    return defaultInitForSvelte(type);
  },

  // --- Markup seams ---------------------------------------------------------

  /** HTML comment — Svelte templates have no expression-comment
   *  form; `{/* *​/}` would parse as an interpolation. */
  renderComment(text: string): string {
    return `<!-- ${text} -->`;
  },

  /** `{#if}` block — Svelte template expressions cannot evaluate to
   *  markup, so a conditional CHILD must be a control-flow block.
   *  Indentation mirrors the TSX ternary's depth shape so nested
   *  output stays readable. */
  renderConditionalChild(cond: string, thenS: string, elseS: string, depth: number): string {
    const inner = "  ".repeat(depth + 1);
    const close = "  ".repeat(depth);
    return `{#if ${cond}}\n${inner}${thenS}\n${close}{:else}\n${inner}${elseS}\n${close}{/if}`;
  },

  /** CSS-string style attribute.  String-literal values inline
   *  verbatim; dynamic values interpolate with `{expr}` (valid
   *  inside a quoted Svelte attribute). */
  renderStyleAttr(
    entries: ReadonlyArray<{ key: string; rendered: string; literal?: string }>,
  ): string {
    if (entries.length === 0) return "";
    const css = entries
      .map(({ key, rendered, literal }) => `${key}: ${literal ?? `{${rendered}}`}`)
      .join("; ");
    return ` style="${css.replace(/"/g, "&quot;")}"`;
  },

  /** Svelte 5 children snippet — optional-render so components
   *  invoked without children stay valid. */
  renderChildrenSlot(): string {
    return "{@render children?.()}";
  },

  /** None — the runes form runtime (`createForm` from
   *  `$lib/forms.svelte`) rides the svelte packs'
   *  `imports["form-of-decls"]` / `imports["primitive-form-of"]`
   *  declarations. */
  formRuntimeImports(): ReadonlyArray<{ from: string; named: readonly string[] }> {
    return [];
  },

  /** Svelte text shares JSX's significant set — `{` opens an
   *  interpolation, `<` opens a tag, `&` opens an entity — so the
   *  entity escape carries over unchanged (`}` / `>` escaping is
   *  harmless and keeps the two outputs aligned). */
  escapeText(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/\{/g, "&#123;")
      .replace(/\}/g, "&#125;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  },
};

// ---------------------------------------------------------------------------
// Internals — mirror tsx-target.ts's self-contained naming helpers.
// ---------------------------------------------------------------------------

function hookVarName(aggregate: string, op: string): string {
  return `${lowerFirstLocal(aggregate)}${upperFirstLocal(op)}`;
}

function hookFnName(aggregate: string, op: string): string {
  const single = upperFirstLocal(aggregate);
  const pluralName = pluralLocal(single);
  if (op === "all") return `useAll${pluralName}`;
  if (op === "byId") return `use${single}ById`;
  if (op === "create") return `useCreate${single}`;
  if (op === "update") return `useUpdate${single}`;
  if (op === "delete") return `useDelete${single}`;
  return `use${upperFirstLocal(op)}${single}`;
}

function defaultInitForSvelte(type: TypeIR): string {
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

function lowerFirstLocal(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
}

function upperFirstLocal(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function pluralLocal(s: string): string {
  if (s.endsWith("y") && !/[aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(s)) return `${s}es`;
  return `${s}s`;
}
