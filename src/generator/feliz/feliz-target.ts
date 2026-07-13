// The Feliz WalkerTarget — F#/Feliz seam implementations consumed by the
// shared `walkBody` (fable-elmish-frontend.md).  The view is expression-valued
// F# code (`Html.div [ … ]`), so it rides the shared engine exactly like the
// JSX-family targets; only the seams below differ.
//
// State reads resolve to the MVU `model.<Field>`; effect handlers dispatch a
// `Msg` (the effect body lives in `update`, not the view).  Expression syntax
// leaves forward to the shared F# leaf table (`FS_LEAVES`).

import { lowerFirst, upperFirst } from "../../util/naming.js";
import type { RenderPosition, StateRef, WalkerTarget } from "../_walker/target.js";
import { FS_LEAVES, fsString } from "./fs-expr.js";
import { fsZeroValue } from "./type-fs.js";
import { byIdFieldName, felizCreateForm, readFieldName } from "./wire.js";

/** Msg case name for an action (`inc` → `Inc`). */
function msgCase(action: string): string {
  return upperFirst(action);
}

/** A route path → a `Router.navigate(<segments>)` call (Feliz.Router).  Each
 *  literal path segment becomes a quoted arg; a `:param` segment interpolates
 *  the matching named arg's value (or its bare name when no arg matches). */
function routerNavigate(
  routeTemplate: string,
  args: ReadonlyArray<{ name: string; value: string }>,
): string {
  const byName = new Map(args.map((a) => [a.name, a.value]));
  const segs = routeTemplate.split("/").filter((s) => s.length > 0);
  const rendered = segs.map((s) => {
    if (!s.startsWith(":")) return fsString(s);
    const name = s.slice(1);
    // `Router.navigate` args are `obj[]`; a param value renders as `string <v>`.
    return `(string ${byName.get(name) ?? name})`;
  });
  // `Router.navigate` needs ≥1 arg; the root path (`/`) navigates to `""`.
  if (rendered.length === 0) return `Router.navigate("")`;
  return `Router.navigate(${rendered.join(", ")})`;
}

/** Collapse a walked markup fragment to ONE line.  The walker joins children
 *  with `\n<indent>`, but only re-indents a child's FIRST line, so a multi-line
 *  `if`/`match` spliced into a Feliz `[ … ]` list is offside-broken (the
 *  continuation lines keep the walker's inconsistent columns).  A single-line
 *  expression sidesteps offside entirely.  Safe to flatten: Feliz emits BLOCK
 *  comments (`(* … *)`, never `//`), and F#-source newlines here are all
 *  structural (string-literal newlines are the escape `\n`, two chars). */
function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

/** A predicate-arm `match` → an F# `if/elif/else` chain on ONE line (both value
 *  and markup-child position — the arm values are already rendered).  With no
 *  `else` arm the terminal is `Html.none` (renders nothing). */
function renderFsMatch(
  arms: ReadonlyArray<{ predicate: string; value: string }>,
  elseArm: string | undefined,
): string {
  const terminal = oneLine(elseArm ?? "Html.none");
  if (arms.length === 0) return `(${terminal})`;
  const parts = arms.map(
    (a, i) => `${i === 0 ? "if" : "elif"} ${oneLine(a.predicate)} then ${oneLine(a.value)}`,
  );
  return `(${parts.join(" ")} else ${terminal})`;
}

export const felizTarget: WalkerTarget = {
  framework: "feliz",

  // --- State seam — MVU model reads --------------------------------------
  renderStateRead: (ref: StateRef, _pos: RenderPosition) => `model.${upperFirst(ref.name)}`,
  // The view never writes state directly (effects live in `update`); the
  // shell's emitStmt over action bodies still reaches this, but the Feliz
  // named-handler ignores the emitted body (it dispatches a Msg instead), so a
  // harmless placeholder is correct.
  renderStateWrite: () => "()",
  renderNestedStateWrite: () => "()",

  // --- API seam — MVU projection (fable-elmish-frontend.md §2.3/§7.2) -------
  // An Elmish read is NOT a per-component hook: the `<param>.<agg>.all` site
  // resolves to the Model field holding its `Remote<'T>`, the shell wires the
  // init `Cmd` + `Loaded` `Msg` + `update` arm (see index.ts's read wiring).
  // So `buildHookUse` names the Model field, `renderApiCall` returns it as the
  // value QueryView matches on, and `renderApiHoisting` emits nothing (there is
  // no page-top hoist to make).
  buildHookUse: (detected) => {
    // A `byId` read resolves to the `<Agg>ById` Model field (its `Remote<'T
    // option>` envelope); `all` (and any other read) to `All<Plural>`.  The
    // page-entry `Cmd` — not this call — issues the byId fetch, so the view
    // only names the field it matches on.
    const field =
      detected.operation === "byId"
        ? byIdFieldName(detected.aggregateName)
        : readFieldName(detected.aggregateName);
    return { varName: field, hookName: lowerFirst(field), importFrom: "", argsRendered: [] };
  },
  renderApiCall: (call) => call.varName ?? readFieldName(call.aggregateName),
  // The magic route `id` (`byId(id)`) resolves to the local `id` the page view
  // function binds from its `Page` case (`| ProductDetail id -> …View … id`).
  renderRouteId: () => "id",
  renderApiHoisting: () => [],
  // The `data:` lambda param binds to the match arm the QueryView pack emits
  // (`| Loaded <binding> -> …`), so a read handle's data dereferences to that
  // binding directly (no `.data` — the arm already unwrapped the `Remote`).
  renderQueryDataAccess: (handle) => lowerFirst(handle),

  // --- Control-flow seams — QueryView's loading/error/empty/data + Table's
  // per-row `For` exercise these in a parseable, Fable-verifiable position. --
  // `match { p => v, else => e }` in value position → an `if/elif/else` chain
  // (F# has no predicate-arm switch expression).
  renderMatch: (arms, elseArm) => renderFsMatch(arms, elseArm),
  // Same chain in child (markup) position — the arm values are Feliz elements.
  renderMatchChild: (arms, elseArm) => renderFsMatch(arms, elseArm),
  // `body: cond ? then : else` → `(if cond then <then> else <else>)`, on ONE
  // line so it stays offside-safe inside a Feliz `[ … ]` list.
  renderConditionalChild: (cond, thenS, elseS) =>
    `(if ${oneLine(cond)} then ${oneLine(thenS)} else ${oneLine(elseS)})`,
  // `For { each: coll, x => <markup> }` → `yield! coll |> List.map (fun x -> …)`
  // spliced into the enclosing Feliz children list (the `yield!` and its
  // bracket-delimited body are offside-safe there).  An `empty:` arm folds into
  // a single-line element guard — `React.fragment` re-wraps the mapped list so
  // the whole thing is ONE child expression, offside-safe like the ternary.
  renderForEach: (coll, itemVar, _indexVar, _keyExpr, body, _depth, emptyBody) => {
    if (emptyBody === undefined) {
      return `yield! ${coll} |> List.map (fun ${itemVar} ->\n  ${body})`;
    }
    const frag = `React.fragment (${coll} |> List.map (fun ${itemVar} -> ${oneLine(body)}))`;
    return `(if List.isEmpty ${coll} then ${oneLine(emptyBody)} else ${frag})`;
  },
  // Cross-page navigation → `Router.navigate(<segments>)` (Feliz.Router).  A
  // `then: navigate(<Page>)` / `Anchor(to:)` reaches here with the target
  // page's route template; `:param` segments interpolate the matching arg.
  renderNavigate: (routeTemplate, args) => routerNavigate(routeTemplate, args),

  // `Button(to: "/products")` → `Router.navigate("products")`.  A literal path
  // is split into segments; a non-literal (a ref) navigates to it as one.
  renderNavigateExpr: (toArg) => {
    const lit = toArg.match(/^"(.*)"$/);
    if (!lit) return `Router.navigate(${toArg})`;
    return routerNavigate(lit[1]!, []);
  },

  // `DestroyForm(of: <Agg>)` → a delete button that DISPATCHES `Delete<Agg> id`
  // (the route id is bound by the detail page's view fn).  The mutation `Cmd` +
  // navigate-on-success live in `update` (wired by index.ts's `collectPage
  // Mutations`); the view only dispatches.  Falls through to the shared comment
  // path when the `of:` arg isn't a plain aggregate ref.
  renderDestroyForm: (call, ctx) => {
    if (call.kind !== "call") return null;
    const names = call.argNames ?? [];
    const idx = names.indexOf("of");
    const ofArg = idx >= 0 ? call.args[idx] : undefined;
    const agg = ofArg?.kind === "ref" ? ofArg.name : undefined;
    if (!agg) return null;
    ctx.usesRouteId = true; // the delete dispatches with the route `id`
    return `Html.button [ prop.onClick (fun _ -> dispatch (Delete${upperFirst(agg)} id)); prop.text "Delete ${upperFirst(agg)}" ]`;
  },

  // `CreateForm(of: <Agg>)` → one `Html.input` per required create-input field
  // (bound to `model.<Agg>Form.<field>` + dispatching `Set<Agg>Form<Field>`) and
  // a submit button dispatching `Submit<Agg>Form`.  The form STATE + encoder +
  // POST `Cmd` live in `update`/`Api` (wired by index.ts's `collectPageForms`);
  // the view only reads/dispatches.  The field set is derived identically here
  // and in index.ts (both `felizCreateForm` off the same enriched aggregate).
  renderCreateForm: (call, ctx) => {
    if (call.kind !== "call") return null;
    const names = call.argNames ?? [];
    const idx = names.indexOf("of");
    const ofArg = idx >= 0 ? call.args[idx] : undefined;
    const aggName = ofArg?.kind === "ref" ? ofArg.name : undefined;
    const agg = aggName ? ctx.aggregatesByName.get(aggName) : undefined;
    if (!agg) return null;
    const form = felizCreateForm(agg);
    const inputs = form.fields.map(
      (fld) =>
        `Html.input [ prop.placeholder "${fld.wireName}"; prop.value model.${form.formField}.${fld.wireName}; prop.onChange (fun (v: string) -> dispatch (${fld.setMsg} v)) ]`,
    );
    const submit = `Html.button [ prop.onClick (fun _ -> dispatch ${form.submitMsg}); prop.text "Create ${upperFirst(form.aggregate)}" ]`;
    return `Html.div [ prop.children [ ${[...inputs, submit].join("; ")} ] ]`;
  },

  defaultInitFor: (type) => fsZeroValue(type),

  // --- Markup seams — F# flavoured ---------------------------------------
  renderComment: (text: string) => `(* ${text} *)`,
  // Child-position interpolation: any JS expression becomes a text node.
  renderInterpolation: (js: string) => `Html.text (string (${js}))`,
  renderAttrBinding: (name: string, js: string) => `prop.custom("${name}", ${js})`,
  renderStyleAttr: () => "",
  // Raw text for markup TEXT position — F# string-body escaping (the pack
  // wraps it in `Html.text "…"` or `prop.text "…"`).
  escapeText: (text: string) => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"'),

  // --- Handler seams — MVU dispatch --------------------------------------
  // A button's `onClick: inc` reaches this with statements `["inc();"]`; the
  // hoisted wrapper (`renderNamedHandler`) turns `inc` into `dispatch Inc`.
  renderEventHandler: (stmts, expr) =>
    `fun _ -> ${expr ?? (stmts ?? []).map((s) => s.replace(/;\s*$/, "")).join("; ")}`,
  // Declare a named action as a dispatch wrapper at the view top: the effect
  // body itself is projected into `update`, so the view handler only
  // dispatches the Msg.  Ignores `bodyStmts` (they belong to `update`).
  renderNamedHandler: (name, param) =>
    param
      ? `    let ${name} ${param} = dispatch (${msgCase(name)} ${param})`
      : `    let ${name} () = dispatch ${msgCase(name)}`,

  // --- Expression-syntax leaves (F#) — forwarded to the shared table ------
  exprLiteral: (lit, value) => FS_LEAVES.literal(lit, value),
  exprBinary: (left, right, op) => FS_LEAVES.binary(left, right, op as never),
  exprUnary: (op, operand) => FS_LEAVES.unary(op as "-" | "!", operand),
  exprTernary: (cond, then, otherwise) => FS_LEAVES.ternary(cond, then, otherwise),
  exprConvert: (value, target, from) => FS_LEAVES.convert(value, target as never, from as never),
  exprList: (elements) => FS_LEAVES.list(elements),
  exprObject: (fields) => FS_LEAVES.object([...fields]),
};

export { fsString };
