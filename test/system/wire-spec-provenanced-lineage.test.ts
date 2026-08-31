// ---------------------------------------------------------------------------
// F2-XB-7 — the `provenanced` carrier's `lineage` was declared NON-NULLABLE in
// `.loom/wire-spec.json` while every backend puts an explicit `null` there.
//
// `GENERIC_SHAPES.provenanced` declared the member `optional: true` and nothing
// else, so each consumer picked a half of a two-part claim and they diverged
// four ways for ONE member:
//
//   wire-spec.json      `lineage: {"type":"object"}`, `required: ["value"]`
//   elixir OpenApiSpex  `%Schema{type: :object}`
//   node zod            `lineage: ProvenanceLineage.nullable()`  (required!)
//   python / frontends  `dict | None = None` / `.nullish()`
//
// The value actually produced is an explicit null — node
// `lineage: root.total_provenance ?? null`, python `… if … else None`, elixir a
// nullable jsonb column read straight out. JSON Schema applies a member's
// subschema whenever the key is PRESENT, and `required` does not save it, so
// any row whose provenanced field has never been written ships a body that
// violates the contract this very artifact publishes.
//
// The fix is one declaration (`PROVENANCED_LINEAGE_NULLABLE`, beside the member
// NAMES that `src/util/provenance-carrier.ts` already centralised for the same
// reason) read by the artifact, not a nullability rule re-decided per emitter.
//
// SCOPE: this is about the CARRIER's declared nullability, not about optional
// fields in general. wire-spec still renders a `T?` field by omitting it from
// `required` and nothing more — that is a different claim, and a different row.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { PROVENANCED_LINEAGE_NULLABLE } from "../../src/generator/_payload/provenanced-wire.js";
import { buildWireSpec } from "../../src/system/wire-spec.js";
import { renderPropType } from "../../src/system/wire-spec-diff.js";
import { buildLoomModel } from "../_helpers/ir.js";

const SOURCE = `
system P {
  subdomain S {
    context C {
      aggregate Order with crudish {
        reference: string
        total: int provenanced
        note: string?
      }
      repository Orders for Order { }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable d { platform: node, contexts: [C], dataSources: [st], serves: A, port: 4000 }
}`;

async function orderSchema() {
  const loom = await buildLoomModel(SOURCE);
  return buildWireSpec(loom.systems[0]!).aggregates.Order!;
}

describe("wire-spec: the provenanced carrier's lineage is nullable (F2-XB-7)", () => {
  it("declares lineage as object-or-null, not a bare object", async () => {
    const total = (await orderSchema()).properties.total as {
      properties: Record<string, { type: unknown }>;
      required: string[];
    };
    expect(total.properties.lineage!.type).toEqual(["object", "null"]);
    // The value half is unchanged — only the lineage member's nullability moved.
    expect(total.properties.value!.type).toBe("integer");
    expect(total.required).toEqual(["value"]);
  });

  it("reads the nullability off the carrier's one declaration", () => {
    // If the carrier is ever re-declared non-nullable, the artifact follows it
    // rather than keeping a hard-coded `["object","null"]` that no longer
    // matches what the backends emit.
    expect(PROVENANCED_LINEAGE_NULLABLE).toBe(true);
  });

  it("a wire-spec DIFF reads the nullability, so gaining or losing it is a change", async () => {
    const total = (await orderSchema()).properties.total as {
      properties: Record<string, never>;
    };
    expect(renderPropType(total.properties.lineage!)).toBe("object|null");
    // The trap this guards: `renderPropType` used to return `p.type` verbatim,
    // which for an array type renders as the JS `String([...])` coercion
    // "object,null" — close enough to read past, and a nullability change would
    // have shown up as a formatting artifact rather than a typed one.
    expect(renderPropType(total.properties.lineage!)).not.toBe("object");
  });

  // The narrow-scope assertion: a plain optional field is untouched. Optionality
  // and nullability stay different claims, and only the carrier declares the
  // second one.
  it("leaves a plain `T?` field rendering exactly as before", async () => {
    const schema = await orderSchema();
    expect((schema.properties.note as { type: string }).type).toBe("string");
    expect(schema.required).not.toContain("note");
  });
});
