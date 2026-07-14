// Feliz UI authorization gate (D-AUTH-OIDC, the read-side mirror of the backend
// 403).  A `page { requires <expr> }` carries a currentUser-only boolean
// `ExprIR` — the same gate the backend evaluates.  Under an `auth: ui` frontend
// whose target backend is `auth: required`, the Feliz app decodes the verified
// session claims (from `/api/auth/me`) into a typed `CurrentUser` record and a
// gated page view renders a `forbiddenView` fallback instead of its body when
// the predicate fails.
//
// This is the F# sibling of `src/generator/_frontend/gate-expr.ts` (the shared
// JS-family renderer the React/Vue/Svelte/Angular frontends reuse) — the same
// closed gate subset, re-rendered to F# boolean syntax (record-field access,
// `=`/`<>`, `List.contains`).  The gate validator restricts a `requires` to
// `currentUser` + constants + boolean/comparison operators + `.contains`
// membership, so only that subset is rendered here; anything outside it throws
// (a gate the UI can't evaluate is a generation-time error, not silent
// degradation) — again mirroring the JS renderer.

import type { BinOp, ExprIR, OperationIR, TypeIR, UiIR, UserIR } from "../../ir/types/loom-ir.js";
import { upperFirst } from "../../util/naming.js";
import { typeToFs } from "./type-fs.js";
import { decoderExprFor } from "./wire.js";

/** Binary operators that differ between Loom source and F# output; the rest
 *  (`&&` / `||` / `<` / `>` / `<=` / `>=`) pass through verbatim. */
const FS_BIN_OP: Partial<Record<BinOp, string>> = {
  "==": "=",
  "!=": "<>",
};

/** True when any page in the ui declares a `requires` UI gate — the trigger for
 *  emitting the claims-decode machinery (record + decoder + the gated views). */
export function uiHasPageGate(ui: UiIR): boolean {
  return ui.pages.some((p) => p.requires !== undefined);
}

/** F# type for a `user { }` claim field on the `CurrentUser` record.  An enum
 *  claim carries its member name as a wire string (decoded via `Decode.string`),
 *  so it maps to `string` here rather than the (unemitted) enum type. */
function claimFsType(t: TypeIR): string {
  if (t.kind === "enum") return "string";
  if (t.kind === "optional") return `${claimFsType(t.inner)} option`;
  if (t.kind === "array") return `${claimFsType(t.element)} list`;
  return typeToFs(t);
}

/** The `CurrentUser` claims record — one field per `user { }` claim, pascal-cased
 *  (F# record convention). */
export function renderCurrentUserType(user: UserIR): string {
  const fields = user.fields.map((f) => `    ${upperFirst(f.name)}: ${claimFsType(f.type)}`);
  return `type CurrentUser =\n  {\n${fields.join("\n")}\n  }`;
}

/** The Thoth decoder for `CurrentUser` — one field accessor per claim, keyed by
 *  the source-declared (lowercase) claim name so the JSON `/auth/me` body lands
 *  on the pascal-cased record field with no casing seam. */
export function renderCurrentUserDecoder(user: UserIR): string {
  const fields = user.fields.map((f) => {
    const dec = decoderExprFor(f.type);
    const accessor =
      f.type.kind === "optional"
        ? `get.Optional.Field "${f.name}" ${dec}`
        : `get.Required.Field "${f.name}" ${dec}`;
    return `        ${upperFirst(f.name)} = ${accessor}`;
  });
  return [
    "let currentUserDecoder : Decoder<CurrentUser> =",
    "    Decode.object (fun get ->",
    "      {",
    ...fields,
    "      })",
  ].join("\n");
}

/** The claims-decoding `Auth` module — the gate variant of the status-only probe.
 *  `checkSession` decodes the verified `/api/auth/me` body into `CurrentUser`
 *  (None on 401 / decode failure), so a page gate can evaluate against real
 *  claims. */
export const AUTH_MODULE_CLAIMS = `module Auth =
  let checkSession () : Async<CurrentUser option> =
    async {
      let! (status, body) = Http.get "/api/auth/me"
      if status = 200 then
        match Decode.fromString currentUserDecoder body with
        | Ok user -> return Some user
        | Error _ -> return None
      else
        return None
    }
  let signIn () : unit = window.location.href <- "/api/auth/login"
  let signOut () : unit = window.location.href <- "/api/auth/logout"`;

/** The `forbiddenView` fallback a gated page renders when the predicate fails —
 *  the client mirror of the backend's 403.  Pack-agnostic plain elements. */
export const FORBIDDEN_VIEW = `let forbiddenView =
  Html.div [ prop.className "alert alert-error"; prop.children [
    Html.div [ prop.children [
      Html.h2 [ prop.className "font-bold"; prop.text "Forbidden" ]
      Html.p [ Html.text "You do not have access to this page." ]
    ] ]
  ] ]`;

/** Render a currentUser-only gate `ExprIR` to an F# boolean expression, with
 *  `userVar` the bound session-user local (`currentUser`).  Throws on any node
 *  outside the gate subset — the F# sibling of `renderGateExpr`. */
export function renderFelizGate(e: ExprIR, userVar: string): string {
  switch (e.kind) {
    case "ref":
      if (e.refKind === "current-user") return userVar;
      // An enum-typed claim compares against the member's wire value — the bare
      // member name string (`role == Admin` → `currentUser.Role = "Admin"`).
      if (e.refKind === "enum-value") return JSON.stringify(e.name);
      throw new Error(
        `feliz UI gate: reference '${e.name}' (${e.refKind}) is not evaluable client-side — ` +
          `a gate may only touch currentUser and constants.`,
      );
    case "literal":
      return renderGateLiteral(e.lit, e.value);
    case "member":
      // Claim access — `currentUser.role` → `currentUser.Role` (pascal-cased
      // record field).  Chained access (`currentUser.org.tier`) pascals each hop.
      return `${renderFelizGate(e.receiver, userVar)}.${upperFirst(e.member)}`;
    case "method-call":
      // The only method the gate grammar admits is collection membership
      // (`currentUser.permissions.contains(x)` → `List.contains x currentUser.Permissions`).
      if (e.isCollectionOp && e.member === "contains" && e.args.length === 1) {
        return `(List.contains ${renderFelizGate(e.args[0]!, userVar)} ${renderFelizGate(
          e.receiver,
          userVar,
        )})`;
      }
      throw new Error(`feliz UI gate: method '.${e.member}' is not supported in a UI gate.`);
    case "binary":
      return `${renderFelizGate(e.left, userVar)} ${FS_BIN_OP[e.op] ?? e.op} ${renderFelizGate(
        e.right,
        userVar,
      )}`;
    case "unary":
      // Loom `!` → F# `not (...)`; arithmetic `-` passes through.
      return e.op === "!"
        ? `not (${renderFelizGate(e.operand, userVar)})`
        : `${e.op}${renderFelizGate(e.operand, userVar)}`;
    case "paren":
      return `(${renderFelizGate(e.inner, userVar)})`;
    case "ternary":
      return `(if ${renderFelizGate(e.cond, userVar)} then ${renderFelizGate(
        e.then,
        userVar,
      )} else ${renderFelizGate(e.otherwise, userVar)})`;
    default:
      throw new Error(`feliz UI gate: expression kind '${e.kind}' is not supported in a UI gate.`);
  }
}

/** The combined F# gate for an operation's currentUser-only `requires` guards, or
 *  null when the op has no `requires` OR any predicate isn't client-evaluable
 *  (touches `this.<field>` / params — `renderFelizGate` throws).  Drives
 *  action-button gating (the action-level mirror of the page `requires` guard):
 *  a non-null gate hides the button when the claims fail; null leaves it always
 *  shown (the backend 403 still enforces the guard — defence-in-depth). */
export function opActionGate(op: OperationIR): string | null {
  const gates = op.statements.filter((s) => s.kind === "requires").map((s) => s.expr);
  if (gates.length === 0) return null;
  try {
    return gates.map((g) => `(${renderFelizGate(g, "currentUser")})`).join(" && ");
  } catch {
    return null;
  }
}

function renderGateLiteral(lit: string, value: string): string {
  switch (lit) {
    case "string":
      return JSON.stringify(value);
    case "bool":
      // F# bool literals are lowercase `true`/`false` — same spelling as source.
      return value;
    case "int":
    case "long":
      return value;
    case "decimal":
      return `${value}m`;
    default:
      // money / now / null have no meaningful client-side gate form.
      throw new Error(`feliz UI gate: ${lit} literal is not supported in a UI gate.`);
  }
}
