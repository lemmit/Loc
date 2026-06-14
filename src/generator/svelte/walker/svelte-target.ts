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
import {
  defaultInitForJs,
  escapeJsFamilyText,
  hookFnName,
  hookVarName,
  lowerFirstName,
  renderJsMatch,
  renderJsNavigate,
  upperFirstName,
} from "../../_walker/js-target-helpers.js";
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
      const viewPascal = upperFirstName(viewName);
      return {
        varName: `${lowerFirstName(viewName)}View`,
        hookName: `use${viewPascal}View`,
        importFrom: "$lib/api/views",
        argsRendered: [],
      };
    }
    if (detected.kind === "workflow-instance") {
      const wf = upperFirstName(detected.aggregateName);
      const isAll = detected.operation === "all";
      return {
        varName: isAll ? `all${wf}Instances` : `${lowerFirstName(detected.aggregateName)}Instance`,
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
      importFrom: `$lib/api/${lowerFirstName(upperFirstName(aggregate))}`,
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
    return renderJsMatch(arms, elseArm);
  },

  /** Child-position match — a structural `{#if}` / `{:else if}` /
   *  `{:else}` chain (Svelte template expressions cannot evaluate to
   *  markup; same divergence as renderConditionalChild). */
  renderMatchChild(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
    depth: number,
  ): string {
    const inner = "  ".repeat(depth + 1);
    const close = "  ".repeat(depth);
    const parts: string[] = [];
    arms.forEach((arm, i) => {
      parts.push(`{${i === 0 ? "#if" : ":else if"} ${arm.predicate}}\n${inner}${arm.value}`);
    });
    if (elseArm !== undefined) {
      parts.push(`{:else}\n${inner}${elseArm}`);
    }
    return `${parts.join(`\n${close}`)}\n${close}{/if}`;
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
    return renderJsNavigate(routeTemplate, args, stateExpr);
  },

  // --- Type-default seam --------------------------------------------------

  defaultInitFor(type: TypeIR): string {
    return defaultInitForJs(type);
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
   *  invoked without children stay valid.  (Snippets aren't
   *  interpolatable, so the JSX `{children}` fallback is wrong here.) */
  renderChildrenSlot(): string {
    return "{@render children?.()}";
  },

  /** None — the runes form runtime (`createForm` from
   *  `$lib/forms.svelte`) rides the svelte packs' form templates. */
  formRuntimeImports(): ReadonlyArray<{ from: string; named: readonly string[] }> {
    return [];
  },

  /** Svelte 5 shares JSX's `{expr}` interpolation syntax. */
  renderInterpolation(jsExpr: string): string {
    return `{${jsExpr}}`;
  },

  /** Svelte dynamic attribute — `name={expr}`, leading space
   *  included (same spelling as JSX). */
  renderAttrBinding(name: string, jsExpr: string): string {
    return ` ${name}={${jsExpr}}`;
  },

  /** Svelte text shares JSX's significant set — `{` opens an
   *  interpolation, `<` opens a tag, `&` opens an entity — so the
   *  entity escape carries over unchanged (`}` / `>` escaping is
   *  harmless and keeps the two outputs aligned). */
  escapeText(text: string): string {
    return escapeJsFamilyText(text);
  },
};
