// ---------------------------------------------------------------------------
// `_frontend/gate-expr.ts` — the currentUser-only UI gate renderer shared by
// React / Vue / Svelte / Angular (and used as a CLASSIFIER by Phoenix's sidebar
// and its action-button gating).
//
// Already pinned elsewhere, not repeated here:
//   * `test/generator/feliz/auth-gate.test.ts` and the per-frontend page-guard
//     tests — that a gated page renders a `<Forbidden/>` fallback and that a
//     membership / inequality gate reaches the emitted view.  Those go through
//     whole system generations and only ever exercise the SUPPORTED subset.
//
// What is not pinned, and is the subject here: THE FAILURE CONTRACT of
// `tryRenderGate`.  Four call sites treat it as a total classifier —
// `_walker/primitives/controls.ts` maps it over an operation's gates and drops
// the button's guard when any is `null`; `elixir/heex-walker-core.ts` uses
// `!== null` as the "is this client-evaluable" predicate; `elixir/sidebar-emit.ts`
// skips a nav entry on `null`.  Every one of them tests the RESULT for `null`,
// so a variant that returned a falsy-but-not-null value (`""`), or a partial
// string for a half-supported tree, would be read as "gate present" and spliced
// into an `{#if}` / `:if` condition that does not parse — or, worse, as a gate
// that evaluates to something other than what the backend enforces.
//
// So: enumerate EVERY `ExprIR.kind` and assert null-or-valid for each, plus the
// rendered spelling of the shapes that ARE supported.  The enumeration is
// pinned against `loom-ir.ts` ITSELF (the union's kinds, read out of the source
// at test time) rather than against a hand-kept list — `test/` is outside the
// `tsc -b` project (tsconfig `exclude`), so the `Record<ExprIR["kind"], …>`
// below is an editor-time aid, not a gate.  The source-derived check is what
// actually fails when `ExprIR` grows a kind nobody decided a gate disposition
// for.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderGateExpr, tryRenderGate } from "../../../src/generator/_frontend/gate-expr.js";
import type { ExprIR, TypeIR } from "../../../src/ir/types/loom-ir.js";

const STRING: TypeIR = { kind: "primitive", name: "string" };

const user = (): ExprIR => ({ kind: "ref", name: "currentUser", refKind: "current-user" });
const claim = (member: string): ExprIR => ({
  kind: "member",
  receiver: user(),
  member,
  receiverType: STRING,
  memberType: STRING,
});
const str = (value: string): ExprIR => ({ kind: "literal", lit: "string", value });
/** `ExprIR`'s ternary arm is spelled `then:`, which Biome's `noThenProperty`
 *  flags on every literal — built once here so the waiver is a single line
 *  rather than one per construction site. */
const tern = (cond: ExprIR, a: ExprIR, b: ExprIR): ExprIR => ({
  kind: "ternary",
  cond,
  // biome-ignore lint/suspicious/noThenProperty: ExprIR's ternary arm is named `then`
  then: a,
  otherwise: b,
});

// --- the probe table --------------------------------------------------------

/** Every `kind:` string literal in the `ExprIR` union, read off `loom-ir.ts`
 *  at test time (comments stripped — one of them SHOWS a `{ kind: "primitive" }`
 *  TypeIR).  This is the enumeration the probe table is measured against. */
function exprKindsFromSource(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.resolve(here, "../../../src/ir/types/loom-ir.ts"), "utf8");
  const start = src.indexOf("export type ExprIR =");
  const end = src.indexOf("\nexport ", start + 10);
  expect(start, "ExprIR union not found in loom-ir.ts").toBeGreaterThan(-1);
  const block = src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  return [...new Set([...block.matchAll(/\bkind: "([A-Za-z0-9-]+)"/g)].map((m) => m[1]!))].sort();
}

/** One minimal node per `ExprIR.kind`, with whether the gate renderer admits
 *  it.  A `Record` over the union so an editor / any future `test/` typecheck
 *  flags a missing arm; the runtime gate is `exprKindsFromSource()` above. */
const PROBES: Record<ExprIR["kind"], { expr: ExprIR; supported: boolean }> = {
  literal: { expr: str("admin"), supported: true },
  ref: { expr: user(), supported: true },
  member: { expr: claim("role"), supported: true },
  "method-call": {
    expr: {
      kind: "method-call",
      receiver: claim("permissions"),
      member: "contains",
      args: [str("orders.write")],
      receiverType: STRING,
      isCollectionOp: true,
    },
    supported: true,
  },
  binary: {
    expr: { kind: "binary", op: "==", left: claim("role"), right: str("admin") },
    supported: true,
  },
  unary: {
    expr: { kind: "unary", op: "!", operand: claim("banned") },
    supported: true,
  },
  paren: { expr: { kind: "paren", inner: claim("active") }, supported: true },
  ternary: {
    expr: tern(claim("active"), str("a"), str("b")),
    supported: true,
  },

  // --- outside the subset: every one must be NULL, never a partial string ---
  this: { expr: { kind: "this" }, supported: false },
  id: { expr: { kind: "id" }, supported: false },
  call: {
    expr: { kind: "call", callKind: "free", name: "isAdmin", args: [] },
    supported: false,
  },
  "action-ref": { expr: { kind: "action-ref", actionName: "approve" }, supported: false },
  lambda: { expr: { kind: "lambda", param: "x", body: claim("role") }, supported: false },
  new: { expr: { kind: "new", partName: "Line", fields: [] }, supported: false },
  object: {
    expr: { kind: "object", fields: [{ name: "role", value: str("admin") }] },
    supported: false,
  },
  list: { expr: { kind: "list", elements: [str("admin")] }, supported: false },
  "authz-filter": {
    expr: { kind: "authz-filter", filter: { kind: "deny" }, aggregate: "Order" },
    supported: false,
  },
  convert: {
    expr: { kind: "convert", target: "string", from: "int", value: claim("level") },
    supported: false,
  },
  duration: {
    expr: {
      kind: "duration",
      unit: "days",
      amount: { kind: "literal", lit: "int", value: "3" },
    },
    supported: false,
  },
  i18nFormat: {
    expr: { kind: "i18nFormat", inner: claim("role"), format: ", number" },
    supported: false,
  },
  match: {
    expr: { kind: "match", arms: [{ cond: claim("active"), value: str("a") }], variantArms: [] },
    supported: false,
  },
};

/** Does `src` parse as a JS expression evaluable against a `currentUser`?
 *  The point of the check is that a NON-null result is a WHOLE expression —
 *  the failure mode a `""` (or a half-rendered `currentUser.role === `) would
 *  slip past a plain truthiness assertion. */
function isCompleteJsExpression(src: string): boolean {
  try {
    new Function("currentUser", `return (${src});`);
    return true;
  } catch {
    return false;
  }
}

describe("tryRenderGate — the null contract, over every ExprIR kind", () => {
  it("probes every kind the ExprIR union declares — no more, no fewer", () => {
    // The real exhaustiveness gate: a new `ExprIR.kind` lands here as a failing
    // set difference, so its gate disposition is DECIDED rather than defaulted.
    expect(Object.keys(PROBES).sort()).toEqual(exprKindsFromSource());
  });

  it.each(Object.entries(PROBES))("%s", (kind, { expr, supported }) => {
    const out = tryRenderGate(expr, "currentUser");
    if (!supported) {
      // STRICTLY null.  Not "", not undefined, not a partial string: every
      // caller branches on `=== null` / `!== null`, so anything else is read as
      // a usable gate and spliced into a condition.
      expect(out, `${kind} is outside the gate subset and must render as null`).toBeNull();
      return;
    }
    expect(out, `${kind} is inside the gate subset`).not.toBeNull();
    expect(
      isCompleteJsExpression(out!),
      `${kind} rendered "${out}", which is not a complete JS expression`,
    ).toBe(true);
  });

  it("returns null for a SUPPORTED node whose subtree is not — never a half-render", () => {
    // The recursive arms are where a partial result would come from: the outer
    // kind is admissible, the inner one is not.  Each must propagate the throw
    // all the way out, so the caller sees `null` rather than a string missing
    // an operand.
    const bad: ExprIR = { kind: "this" };
    const wrappers: ExprIR[] = [
      { kind: "paren", inner: bad },
      { kind: "unary", op: "!", operand: bad },
      { kind: "binary", op: "==", left: claim("role"), right: bad },
      { kind: "binary", op: "==", left: bad, right: str("x") },
      tern(bad, str("a"), str("b")),
      tern(claim("active"), str("a"), bad),
      { kind: "member", receiver: bad, member: "role", receiverType: STRING, memberType: STRING },
      {
        kind: "method-call",
        receiver: claim("permissions"),
        member: "contains",
        args: [bad],
        receiverType: STRING,
        isCollectionOp: true,
      },
    ];
    for (const w of wrappers) expect(tryRenderGate(w, "currentUser"), w.kind).toBeNull();
  });

  it("returns null for a ref that is not the principal, and for the non-gate literals", () => {
    for (const refKind of ["param", "let", "this-prop", "store-field", "unknown"] as const) {
      expect(tryRenderGate({ kind: "ref", name: "x", refKind }, "currentUser")).toBeNull();
    }
    for (const lit of ["money", "now"] as const) {
      expect(tryRenderGate({ kind: "literal", lit, value: "1" }, "currentUser")).toBeNull();
    }
    // A non-membership method is out even though `method-call` is admissible.
    expect(
      tryRenderGate(
        {
          kind: "method-call",
          receiver: claim("role"),
          member: "startsWith",
          args: [str("a")],
          receiverType: STRING,
          isCollectionOp: false,
        },
        "currentUser",
      ),
    ).toBeNull();
    // …and so is `contains` that is NOT flagged a collection op.
    expect(
      tryRenderGate(
        {
          kind: "method-call",
          receiver: claim("role"),
          member: "contains",
          args: [str("a")],
          receiverType: STRING,
          isCollectionOp: false,
        },
        "currentUser",
      ),
    ).toBeNull();
  });
});

describe("renderGateExpr — the supported shapes render to the expected TS", () => {
  it("a claim equality becomes a STRICT comparison (== is not JS ==)", () => {
    expect(
      renderGateExpr(
        { kind: "binary", op: "==", left: claim("role"), right: str("admin") },
        "currentUser",
      ),
    ).toBe('currentUser.role === "admin"');
    expect(
      renderGateExpr(
        { kind: "binary", op: "!=", left: claim("role"), right: str("admin") },
        "currentUser",
      ),
    ).toBe('currentUser.role !== "admin"');
  });

  it("an enum-valued claim compares against the bare member name", () => {
    expect(
      renderGateExpr(
        {
          kind: "binary",
          op: "==",
          left: claim("role"),
          right: { kind: "ref", name: "Admin", refKind: "enum-value", enumName: "Role" },
        },
        "currentUser",
      ),
    ).toBe('currentUser.role === "Admin"');
  });

  it("&& / || / ! compose, and paren keeps the author's grouping", () => {
    const isAdmin: ExprIR = { kind: "binary", op: "==", left: claim("role"), right: str("admin") };
    const isOwner: ExprIR = { kind: "binary", op: "==", left: claim("role"), right: str("owner") };
    expect(renderGateExpr({ kind: "binary", op: "&&", left: isAdmin, right: isOwner }, "u")).toBe(
      'u.role === "admin" && u.role === "owner"',
    );
    expect(
      renderGateExpr(
        {
          kind: "unary",
          op: "!",
          operand: {
            kind: "paren",
            inner: { kind: "binary", op: "||", left: isAdmin, right: isOwner },
          },
        },
        "u",
      ),
    ).toBe('!(u.role === "admin" || u.role === "owner")');
  });

  it("`contains` becomes `.includes(…)` on the claim array", () => {
    expect(
      renderGateExpr(
        {
          kind: "method-call",
          receiver: claim("permissions"),
          member: "contains",
          args: [str("orders.write")],
          receiverType: STRING,
          isCollectionOp: true,
        },
        "currentUser",
      ),
    ).toBe('currentUser.permissions.includes("orders.write")');
  });

  it("a chained claim keeps the whole path, rooted at the caller's user var", () => {
    const nested: ExprIR = {
      kind: "member",
      receiver: claim("org"),
      member: "tier",
      receiverType: STRING,
      memberType: STRING,
    };
    expect(renderGateExpr(nested, "session.user")).toBe("session.user.org.tier");
  });

  it("throws (rather than degrading) on a node outside the subset", () => {
    // The strict entry point is a generation-time error by design — the
    // best-effort behaviour belongs to `tryRenderGate` alone.
    expect(() => renderGateExpr({ kind: "this" }, "currentUser")).toThrow(/UI gate/);
    expect(() =>
      renderGateExpr({ kind: "ref", name: "x", refKind: "param" }, "currentUser"),
    ).toThrow(/not evaluable client-side/);
  });
});
