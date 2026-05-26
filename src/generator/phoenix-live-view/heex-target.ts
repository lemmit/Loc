// ---------------------------------------------------------------------------
// HEEx `WalkerTarget` — Phoenix LiveView implementation of the
// cross-framework walker contract.  See `src/generator/_walker/target.ts`
// for the contract definition and scope.
//
// This module is the *standalone* impl: it lifts the seams the
// existing inline Phoenix walker (`heex-walker.ts`) already
// implements into the `WalkerTarget` interface.  The walker itself
// is not yet refactored to delegate here; that's Phase 7's next
// step (a follow-up PR), gated on the `mix compile --warnings-as-errors`
// suite.
//
// Mapping (file:line at time of extraction):
//   renderStateRead   — heex-walker.ts:253-259 (this/id position branches)
//                       + line 366 (state-field ref-case path)
//   renderStateWrite  — heex-walker.ts:1565-1572 (case "assign")
//   renderStateInit   — heex-walker.ts:1565-1594 (default + initializer)
//   renderApiCall     — heex-walker.ts:647-683 (direct context-function call)
//   renderApiHoisting — empty array (LiveView reads inline; no hoisting)
//   renderHelperImports — heex-walker.ts:1660-1672 (elixirAliasForHelper)
//   renderMatch       — heex-walker.ts:543-552 (renderMatch — cond do...end)
//   renderNavigate    — heex-walker.ts:690-715 (push_navigate + ~p sigil)
//   defaultInitFor    — Elixir literals per type
//
// `framework: "phoenixLiveView"` matches the IR enum.
// ---------------------------------------------------------------------------

import type { ExprIR, StateFieldIR, TypeIR } from "../../ir/loom-ir.js";
import type { ApiCallSite, RenderPosition, StateRef, WalkerTarget } from "../_walker/target.js";

export const heexTarget: WalkerTarget = {
  framework: "phoenixLiveView",

  // --- State seam ---------------------------------------------------------

  /** HEEx differentiates template (`@field`) from handler
   *  (`socket.assigns.field`).  Mirrors heex-walker.ts:253-259 and
   *  the ref-case branch at :366. */
  renderStateRead(ref: StateRef, position: RenderPosition): string {
    const snakeName = snakeLocal(ref.name);
    return position === "template" ? `@${snakeName}` : `socket.assigns.${snakeName}`;
  },

  /** Pipe step: `|> assign(:field, value)`.  The caller pipes the
   *  socket through these as part of handler-body composition.
   *  Mirrors `case "assign"` at heex-walker.ts:1566-1572. */
  renderStateWrite(ref: StateRef, value: string): string {
    return `|> assign(:${snakeLocal(ref.name)}, ${value})`;
  },

  /** Elixir literal for a state field's `mount/3` `assign(socket,
   *  :field, <init>)` value.  When the field declares an explicit
   *  `= <init>`, the caller pre-renders via its WalkContext (HEEx
   *  walker has no `renderInitExpr` equivalent today — state inits
   *  in Phoenix flow through the mount template's initial-assigns
   *  list).  v0 returns the type default when no init is provided. */
  renderStateInit(field: StateFieldIR, init: ExprIR | undefined): string {
    if (init !== undefined) {
      // Caller is expected to pre-render via its own walker context.
      // Standalone target falls back to type default — see the
      // matching tsxTarget note.
      return defaultInitForHeex(field.type);
    }
    return defaultInitForHeex(field.type);
  },

  // --- API binding seam ---------------------------------------------------

  /** Phoenix calls the Ash domain code interface directly — no hook
   *  hoisting.  Shape: `<App>.<Context>.<op>_<aggregate_snake>(args)`.
   *  Naming convention matches `heex-walker.ts:647-683` (codeIntfFnName).
   *  The `<App>.<Context>` prefix is not visible to the contract —
   *  caller (the future delegating walker) prepends it from the
   *  `BoundedContextIR` in scope. */
  renderApiCall(call: ApiCallSite, renderedArgs: string): string {
    const fn = codeInterfaceFnName(call.aggregateName, call.operation);
    return renderedArgs.length === 0 ? `${fn}()` : `${fn}(${renderedArgs})`;
  },

  /** Empty — LiveView reads in `mount/3` and writes from
   *  `handle_event/3`; there's no per-page hoisted hook declaration. */
  renderApiHoisting(_uses: ApiCallSite[]): string[] {
    return [];
  },

  // --- Helper-import seam -------------------------------------------------

  /** `alias Path.To.Module, as: <Pascal>` per referenced user helper.
   *  Mirrors `elixirAliasForHelper` at heex-walker.ts:1660-1672. */
  renderHelperImports(
    used: ReadonlySet<string>,
    decls: ReadonlyArray<{ name: string; path: string }>,
  ): string[] {
    const lines: string[] = [];
    for (const d of decls) {
      if (!used.has(d.name)) continue;
      const moduleName = d.path
        .replace(/^\.\//, "")
        .replace(/^\.\.\//g, "")
        .split("/")
        .map((seg) => upperFirstLocal(seg.replace(/[^a-zA-Z0-9]/g, "_")))
        .join(".");
      lines.push(`alias ${moduleName}, as: ${upperFirstLocal(d.name)}`);
    }
    return lines;
  },

  // --- Match expression seam ----------------------------------------------

  /** Elixir `cond do … true -> fallback end`.  Caller wraps in
   *  `<%= … %>` when in template position — this method emits the
   *  bare cond.  Mirrors `renderMatch` at heex-walker.ts:543-552
   *  (without the position-dependent wrap). */
  renderMatch(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
  ): string {
    const armLines = arms.map((a) => `      ${a.predicate} -> ${a.value}`).join("\n");
    const fallback = elseArm !== undefined ? `\n      true -> ${elseArm}` : "";
    return `cond do\n${armLines}${fallback}\n    end`;
  },

  // --- Navigation seam ----------------------------------------------------

  /** `push_navigate(socket, to: ~p"/route?k=v")`.  Mirrors
   *  `renderNavigate` at heex-walker.ts:690-715.  Query-string
   *  composition is the contract's `args` set; the WalkerTarget
   *  expects them rendered already by the caller. */
  renderNavigate(
    routeTemplate: string,
    args: ReadonlyArray<{ name: string; value: string }>,
    _stateExpr?: string,
  ): string {
    // HEEx cannot embed an arbitrary expression into a `~p` sigil's
    // query string — the sigil is compile-time interpolated against
    // a known route template.  When the contract supplies
    // `stateExpr` (TSX escape hatch), Phoenix falls back to the
    // args-empty `push_navigate`; the source's pre-built state
    // object is opaque to the route.  Callers needing a richer
    // shape route through `handle_event` instead.
    if (args.length === 0) {
      return `push_navigate(socket, to: ~p"${routeTemplate}")`;
    }
    const queryPairs = args.map((a) => `${snakeLocal(a.name)}=#{${a.value}}`).join("&");
    return `push_navigate(socket, to: ~p"${routeTemplate}?${queryPairs}")`;
  },

  // --- Type-default seam --------------------------------------------------

  defaultInitFor(type: TypeIR): string {
    return defaultInitForHeex(type);
  },
};

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

/** Elixir literal-zero per type.  HEEx walker doesn't have a
 *  centralized version of this today (state inits in Phoenix are
 *  rare — `state {}` blocks lower into `mount/3` assigns).  Values
 *  match the spec §6 zero-value table in Elixir flavour. */
function defaultInitForHeex(type: TypeIR): string {
  if (type.kind === "primitive") {
    switch (type.name) {
      case "int":
      case "long":
      case "decimal":
        return "0";
      case "money":
        return 'Decimal.new("0")';
      case "bool":
        return "false";
      case "string":
      case "datetime":
      case "guid":
        return '""';
    }
  }
  if (type.kind === "id" || type.kind === "enum") return '""';
  if (type.kind === "optional") return "nil";
  if (type.kind === "array") return "[]";
  return "nil";
}

/** Ash code interface fn name: `<op>_<aggregate_snake>!` (plural for
 *  list ops, singular otherwise).  Matches `renderApiCall` at
 *  `heex-walker.ts:693-712` byte-for-byte — same crude `<single>s`
 *  pluralisation, same `delete`/`destroy` aliasing, same `!` suffix
 *  on every non-list op. */
function codeInterfaceFnName(aggregate: string, op: string): string {
  const single = snakeLocal(aggregate);
  if (op === "create") return `create_${single}!`;
  if (op === "update") return `update_${single}!`;
  if (op === "delete" || op === "destroy") return `destroy_${single}!`;
  if (op === "all") return `list_${single}s!`; // crude plural — matches walker
  if (op === "byId") return `get_${single}!`;
  return `${snakeLocal(op)}_${single}!`;
}

// Self-contained naming helpers — same behaviour as util/naming.ts
// for the inputs the walker produces; keeps the target file
// independent of the wider toolchain.
function snakeLocal(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function upperFirstLocal(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function pluralLocal(s: string): string {
  if (s.endsWith("y") && !/[aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(s)) return `${s}es`;
  return `${s}s`;
}
