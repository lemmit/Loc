import { describe, expect, it } from "vitest";
import {
  isServerSourcedDefault,
  serverSourcedDefaultFields,
} from "../../../src/generator/_frontend/server-default.js";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";

// The classifier that splits a non-client-evaluable default into SERVER-sourced
// (now() / currentUser.*, fetched from the prepare endpoint) vs still-deferred
// (sequences / cross-aggregate reads, kept type-zero).

const now: ExprIR = { kind: "literal", lit: "now", value: "now" } as ExprIR;
const currentUser: ExprIR = { kind: "ref", refKind: "current-user", name: "currentUser" } as ExprIR;
const currentUserClaim: ExprIR = {
  kind: "member",
  receiver: currentUser,
  member: "tenantId",
} as ExprIR;
const stringLit: ExprIR = { kind: "literal", lit: "string", value: "draft" } as ExprIR;
const enumVal: ExprIR = {
  kind: "ref",
  refKind: "enum-value",
  name: "Draft",
  enumName: "Status",
} as ExprIR;
const thisRead: ExprIR = {
  kind: "member",
  receiver: { kind: "this" } as ExprIR,
  member: "eta",
} as ExprIR;

describe("server-sourced default classifier", () => {
  it("classifies now() and currentUser.* as server-sourced", () => {
    expect(isServerSourcedDefault(now)).toBe(true);
    expect(isServerSourcedDefault(currentUser)).toBe(true);
    expect(isServerSourcedDefault(currentUserClaim)).toBe(true);
  });

  it("does NOT classify client-evaluable defaults as server-sourced", () => {
    // Constants / enums seed client-side, so they're not server-sourced.
    expect(isServerSourcedDefault(stringLit)).toBe(false);
    expect(isServerSourcedDefault(enumVal)).toBe(false);
    // `this.<field>` is the record-threading path, not the server endpoint.
    expect(isServerSourcedDefault(thisRead)).toBe(false);
  });

  it("selects only the server-sourced fields", () => {
    const fields = [
      { name: "status", default: stringLit },
      { name: "createdAt", default: now },
      { name: "tenantId", default: currentUserClaim },
      { name: "note" }, // no default
    ];
    expect(serverSourcedDefaultFields(fields).map((f) => f.name)).toEqual([
      "createdAt",
      "tenantId",
    ]);
  });
});
