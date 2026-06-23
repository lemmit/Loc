// ---------------------------------------------------------------------------
// Phoenix LiveView store-module emitter — `store Cart { … }` → a dedicated
// `lib/<app>_web/stores/<store_snake>.ex` module (named-actions-and-stores.md
// §3, Stage 5).  The Elixir twin of the SPA's Zustand `stores/cart.ts`.
//
// v1 semantic = per-LiveView-process.  The store is its OWN module + struct:
//
//   defmodule StoreLiveViewWeb.Stores.Cart do
//     defstruct lines: [], count: 0
//
//     def add(%__MODULE__{} = state, sku) do
//       state = %{state | lines: state.lines ++ [sku]}
//       %{state | count: state.count + 1}
//     end
//
//     def clear(%__MODULE__{} = state) do
//       state = %{state | lines: []}
//       %{state | count: 0}
//     end
//   end
//
//   (A single-write action collapses to the `def … do: %{…}` one-liner form;
//   a multi-write body renders the `do…end` block shown above.)
//
//   - `defstruct` carries every state field with its declared default (or the
//     type's zero value: `[]` / `0` / `false` / `nil` / …).
//   - Each store `action` → one PUBLIC pure function
//     `def <action>(%__MODULE__{} = state, <params…>)` returning the updated
//     struct.  An own-state read of field `f` renders `state.f`; a write
//     `f := v` / `f += v` rebinds `state = %{state | f: <v>}` (sequential
//     writes chain via rebinding, so a later statement sees the earlier one),
//     and the last statement's struct is the return value.
//   - A same-store action calling another action → `state = <other>(state)` /
//     `<other>(state)` (a pure in-module call).  Cross-store calls are gated
//     on LiveView by `loom.store-cross-store-on-liveview-unsupported`.
//
// The page seam (assign(:cart, %Cart{}) in mount + the @cart.field reads +
// the `update(socket, :cart, …)` calls) lives in liveview-emit / heex-walker;
// this module owns only the per-store FILE.
// ---------------------------------------------------------------------------

import type { ActionIR, ExprIR, StateFieldIR, StmtIR } from "../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";
import { defaultInitFor } from "./heex-walker.js";

/** Render one `StoreIR` as its `lib/<app>_web/stores/<snake>.ex` content.
 *  `webModule` is the `<App>Web` prefix (e.g. "StoreLiveViewWeb"). */
export function renderStoreModule(
  store: { name: string; state: StateFieldIR[]; actions: ActionIR[] },
  webModule: string,
): string {
  const moduleName = `${webModule}.Stores.${upperFirst(store.name)}`;
  const fieldNames = new Set(store.state.map((f) => snake(f.name)));

  // `defstruct field: default, …` — declared `= init` else the type zero.
  const structFields = store.state
    .map((f) => `${snake(f.name)}: ${storeFieldDefault(f)}`)
    .join(", ");
  const defstruct = store.state.length > 0 ? `  defstruct ${structFields}` : `  defstruct []`;

  const actionDefs = store.actions.map((a) => renderStoreAction(a, fieldNames));

  return `# Auto-generated store module (per-LiveView-process, in-memory).
defmodule ${moduleName} do
${defstruct}

${actionDefs.join("\n\n")}
end
`;
}

/** A store field's struct default — its declared `= init` (lowered into the
 *  field's `init` ExprIR) or the type's zero value via `defaultInitFor`. */
function storeFieldDefault(f: StateFieldIR): string {
  if (f.init) return renderStoreExpr(f.init, new Set());
  return defaultInitFor(f.type);
}

/** Render one store action as a public pure function over the struct.  A body
 *  is a sequence of own-state writes (`:=` / `+=` / `-=`) and same-store
 *  action calls; each rebinds `state`, and the final statement's value is the
 *  function's return.  A single-write body collapses to a `def … do: %{…}`
 *  one-liner. */
function renderStoreAction(action: ActionIR, fieldNames: ReadonlySet<string>): string {
  const fn = snake(action.name);
  const params = action.params.map((p) => snake(p.name));
  const head = ["%__MODULE__{} = state", ...params].join(", ");

  const stmtForms = action.body.map((s) => renderStoreStmt(s, fieldNames));

  if (stmtForms.length === 0) {
    // Empty action body — return the struct unchanged.
    return `  def ${fn}(${head}), do: state`;
  }
  if (stmtForms.length === 1) {
    // Single transform — inline `do:` form, no rebinding needed.
    return `  def ${fn}(${head}), do: ${stmtForms[0]!.value}`;
  }
  // Multi-statement — rebind `state` for every step but the last, whose value
  // is the return.  Sequential rebinding lets a later step read an earlier
  // write (`state.f`) just like the SPA's chained `set` calls.
  const lines: string[] = [];
  for (let i = 0; i < stmtForms.length; i++) {
    const last = i === stmtForms.length - 1;
    lines.push(`    ${last ? "" : "state = "}${stmtForms[i]!.value}`);
  }
  return `  def ${fn}(${head}) do
${lines.join("\n")}
  end`;
}

/** A rendered store-action statement — its Elixir value expression (a new
 *  struct, or an in-module action call returning a struct). */
interface StoreStmtForm {
  value: string;
}

/** Render one store-action statement as a struct-producing value.  Writes
 *  (`:=` / `+=` / `-=`) become `%{state | field: <v>}`; a same-store action
 *  call becomes `<other>(state, …)`. */
function renderStoreStmt(stmt: StmtIR, fieldNames: ReadonlySet<string>): StoreStmtForm {
  switch (stmt.kind) {
    case "assign": {
      const field = snake(stmt.target.segments[0] ?? "");
      const v = renderStoreExpr(stmt.value, fieldNames);
      return { value: `%{state | ${field}: ${v}}` };
    }
    case "add":
    case "remove": {
      const field = snake(stmt.target.segments[0] ?? "");
      const rhs = renderStoreExpr(stmt.value, fieldNames);
      const read = `state.${field}`;
      // Collection mutation → list append / reject; scalar → compound arith.
      const next = stmt.collection
        ? stmt.kind === "add"
          ? `${read} ++ [${rhs}]`
          : `Enum.reject(${read}, &(&1 == ${rhs}))`
        : `${read} ${stmt.kind === "add" ? "+" : "-"} ${rhs}`;
      return { value: `%{state | ${field}: ${next}}` };
    }
    case "call": {
      // Same-store sibling action call (`reset()`) → an in-module pure call
      // threading the struct.  (Cross-store calls are gated upstream on
      // LiveView, so `target: "store-action"` never reaches here.)
      if (stmt.target === "action") {
        const args = [`state`, ...stmt.args.map((a) => renderStoreExpr(a, fieldNames))];
        return { value: `${snake(stmt.name)}(${args.join(", ")})` };
      }
      // A bare function call — evaluate for effect, struct flows through.
      const args = stmt.args.map((a) => renderStoreExpr(a, fieldNames)).join(", ");
      return { value: `(${snake(stmt.name)}(${args}); state)` };
    }
    case "let": {
      // A `let x = …` in a store action is rare; bind then thread the struct.
      const v = renderStoreExpr(stmt.expr, fieldNames);
      return { value: `(${snake(stmt.name)} = ${v}; state)` };
    }
    default:
      // No other statement kind is valid in a store action (the validator
      // gates view-effects / inline foreign writes).  Pass the struct through.
      return { value: "state" };
  }
}

/** Render a store-action RHS expression to Elixir.  The only divergence from
 *  the general HEEx expr renderer is the state seam: an own-store field read
 *  (a bare `let` ref whose name is a store field) reads `state.<field>` rather
 *  than a page assign.  The supported RHS surface in a store action is small
 *  (literals, params, own-field reads, arithmetic), so this is a focused
 *  renderer — not the full page-body walker. */
function renderStoreExpr(expr: ExprIR, fieldNames: ReadonlySet<string>): string {
  switch (expr.kind) {
    case "literal":
      return renderStoreLiteral(expr.lit, expr.value);
    case "ref": {
      const nm = snake(expr.name);
      // Own-store field read → `state.<field>` (the field bound as a `let`
      // local during lowering, so it arrives as a bare ref).
      if (fieldNames.has(nm)) return `state.${nm}`;
      if (expr.refKind === "enum-value") return `:${nm}`;
      return nm;
    }
    case "member":
      return `${renderStoreExpr(expr.receiver, fieldNames)}.${snake(expr.member)}`;
    case "paren":
      return `(${renderStoreExpr(expr.inner, fieldNames)})`;
    case "unary":
      return expr.op === "!"
        ? `not ${renderStoreExpr(expr.operand, fieldNames)}`
        : `-${renderStoreExpr(expr.operand, fieldNames)}`;
    case "binary": {
      const l = renderStoreExpr(expr.left, fieldNames);
      const r = renderStoreExpr(expr.right, fieldNames);
      if (expr.op === "+" && (isStringLit(expr.left) || isStringLit(expr.right))) {
        return `${l} <> ${r}`;
      }
      const op = expr.op === "&&" ? "and" : expr.op === "||" ? "or" : expr.op;
      return `${l} ${op} ${r}`;
    }
    case "list":
      return `[${expr.elements.map((el) => renderStoreExpr(el, fieldNames)).join(", ")}]`;
    case "ternary":
      return `if ${renderStoreExpr(expr.cond, fieldNames)}, do: ${renderStoreExpr(expr.then, fieldNames)}, else: ${renderStoreExpr(expr.otherwise, fieldNames)}`;
    default:
      // Anything else (calls, match, …) is out of the validated store-action
      // RHS surface; emit a safe nil so output stays valid Elixir.
      return "nil";
  }
}

function renderStoreLiteral(kind: string, value: string): string {
  switch (kind) {
    case "string":
      return JSON.stringify(value);
    case "int":
      return value;
    case "decimal":
    case "money":
      return `Decimal.new(${JSON.stringify(value)})`;
    case "bool":
      return value === "true" ? "true" : "false";
    case "null":
      return "nil";
    case "now":
      return "DateTime.utc_now()";
    default:
      return value;
  }
}

function isStringLit(e: ExprIR): boolean {
  return e.kind === "literal" && e.lit === "string";
}
