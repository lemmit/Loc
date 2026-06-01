// Create-input contract — pins the reified `buildCreateInput` shape: the
// client-suppliable field set (`forCreateInput`) plus the canonical
// per-field required-ness rule.  This is the single source every create
// surface (wire DTO, domain factory, OpenAPI, parity) consumes, so any
// drift in the field set or the required-set must change this table first.
// See `buildCreateInput` / `CreateInputFieldIR` in
// `src/ir/enrich/wire-projection.ts`.

import { describe, expect, it } from "vitest";
import { buildCreateInput } from "../../../src/ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  ExprIR,
  FieldAccess,
  FieldIR,
  TypeIR,
} from "../../../src/ir/types/loom-ir.js";

const STRING: TypeIR = { kind: "primitive", name: "string" };
const INT: TypeIR = { kind: "primitive", name: "int" };
const BOOL: TypeIR = { kind: "primitive", name: "bool" };
const ONE: ExprIR = { kind: "literal", lit: "int", value: "1" };

function field(
  name: string,
  type: TypeIR,
  opts: { access?: FieldAccess; optional?: boolean; default?: ExprIR } = {},
): FieldIR {
  return {
    name,
    type,
    optional: opts.optional ?? false,
    access: opts.access ?? "editable",
    default: opts.default,
  };
}

// One field per relevant axis: each access role, plus the three "may
// omit" shapes (optional / explicit default / implicit-default bool).
const FIELDS: FieldIR[] = [
  field("name", STRING), // editable, required input
  field("description", STRING, { optional: true }), // optional → may omit
  field("qty", INT, { default: ONE }), // explicit default → may omit
  field("active", BOOL), // implicit `false` default → may omit
  field("sku", STRING, { access: "immutable" }), // immutable is settable on create
  field("password", STRING, { access: "secret" }), // secret stays in create input
  field("createdAt", STRING, { access: "managed" }), // server-owned → excluded
  field("version", STRING, { access: "token" }), // server-assigned → excluded
  field("notes", STRING, { access: "internal" }), // domain-only → excluded
];

const agg = { fields: FIELDS } as AggregateIR;

describe("create-input contract — buildCreateInput", () => {
  const contract = buildCreateInput(agg);
  const byName = new Map(contract.map((c) => [c.field.name, c]));

  it("includes exactly the client-suppliable fields (drops managed/token/internal)", () => {
    expect(contract.map((c) => c.field.name)).toEqual([
      "name",
      "description",
      "qty",
      "active",
      "sku",
      "password",
    ]);
  });

  it("marks a plain non-optional, non-defaulted field as required input", () => {
    expect(byName.get("name")?.requiredInput).toBe(true);
    expect(byName.get("sku")?.requiredInput).toBe(true); // immutable, still required
    expect(byName.get("password")?.requiredInput).toBe(true); // secret, still required
  });

  it("collapses optional / explicit-default / implicit-bool-default onto 'may omit'", () => {
    expect(byName.get("description")?.requiredInput).toBe(false); // nullable
    expect(byName.get("qty")?.requiredInput).toBe(false); // explicit default
    expect(byName.get("active")?.requiredInput).toBe(false); // bool ⇒ implicit false
  });

  it("a bool only carries an implicit default when non-optional and undefaulted", () => {
    // Sanity: the bool exemption is type-driven, not name-driven — an
    // optional bool is already 'may omit' for the optional reason.
    const optionalBool = buildCreateInput({
      fields: [field("flag", BOOL, { optional: true })],
    } as AggregateIR);
    expect(optionalBool[0]?.requiredInput).toBe(false);
  });
});
