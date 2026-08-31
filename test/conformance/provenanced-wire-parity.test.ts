// Cross-backend wire parity for `Provenanced<T>` — the value+lineage carrier a
// `provenanced` field ships as (M-T6.12, docs/provenance.md § "The wire shape").
//
// WHY THIS TEST EXISTS.  Before the carrier, the lineage was a per-emitter
// BOLT-ON: each of the five backends appended its own trailing
// `<field>_provenance` key after the wire shape, and each of the six frontends
// appended a matching sibling to its own response type.  Eleven hand-written
// spellings of one convention, none of them derived from `wireShape` — so
// `.loom/wire-spec.json` could not see the lineage at all, and a backend that
// forgot the append (or spelled the key differently) shipped a silently
// different contract that no gate compared.
//
// Now the shape is declared once (`GENERIC_SHAPES.provenanced`) and stamped
// into `wireShape` once (`wireTypeForField`), and each emitter has ONE arm that
// builds the carrier from that declaration.  "Identical by construction" is
// exactly the invariant that drifts later without a test pinning it — so this
// generates the SAME provenanced aggregate for all five backends and asserts
// each names the carrier's two members, in the shape's own order, on the read
// path.  A backend that reverts to a sibling key, renames a member, or drops
// the lineage fails here rather than in a runtime differential a day later.
//
// Lives in the always-on `test` gate (no docker) — the static complement to the
// behavioral wire-golden differential, which proves the same thing at runtime
// but only on the legs that have a container.

import { describe, expect, it } from "vitest";
import { genericShape } from "../../src/ir/stdlib/generics.js";
import { generateSystemFiles } from "../_helpers/generate.js";

/** The canonical member order, straight from the single source of truth. */
const CANONICAL = genericShape("provenanced")
  .fields({ kind: "primitive", name: "int" })
  .map((f) => f.name);

const SYSTEM = (platform: string): string => `
system ProvShop {
  subdomain Sales {
    context Ordering {
      aggregate Order {
        quantity: int
        unitPrice: int
        total: int provenanced
        create(quantity: int, unitPrice: int) {
          quantity := quantity
          unitPrice := unitPrice
        }
        operation reprice(qty: int, price: int) {
          quantity := qty
          unitPrice := price
          total := qty * price
        }
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Ordering, kind: state, use: primary }
  deployable api {
    platform: ${platform}
    contexts: [Ordering]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;

/** Every generated file joined, so an assertion stays path-agnostic across five
 *  very differently-shaped project layouts. */
async function emit(platform: string): Promise<string> {
  const files = await generateSystemFiles(SYSTEM(platform));
  let all = "";
  for (const content of files.values()) all += `\n${content}`;
  return all;
}

/** The per-backend READ-PATH spellings of the carrier: the DTO/schema
 *  declaration and the projection that fills it.  Each entry names BOTH
 *  members, so a backend that folds only one half fails.  The member names
 *  themselves are interpolated from `CANONICAL`, so widening the carrier
 *  updates every expectation from one place. */
const [VALUE, LINEAGE] = CANONICAL as [string, string];

describe("Provenanced<T> — the value+lineage carrier is one shape on all five backends", () => {
  it("declares the carrier's two members in shape order", () => {
    // Guards the interpolation below: if the shape ever grows a third member or
    // reorders, the per-backend expectations are stale and must be revisited.
    expect(CANONICAL).toEqual(["value", "lineage"]);
  });

  it("node (Hono) — zod object on the response schema, folded in `toWire`", async () => {
    const out = await emit("node");
    expect(out).toContain(
      `total: z.object({ ${VALUE}: z.number().int(), ${LINEAGE}: ProvenanceLineage.nullable() }),`,
    );
    expect(out).toContain(
      `total: { ${VALUE}: root.total, ${LINEAGE}: root.total_provenance ?? null }`,
    );
    expect(out).not.toContain("total_provenance: ProvenanceLineage");
  });

  it("dotnet — the shared `Provenanced<T>` record on the response DTO", async () => {
    const out = await emit("dotnet");
    expect(out).toContain(
      `public sealed record Provenanced<T>(T ${upper(VALUE)}, ProvLineage? ${upper(LINEAGE)});`,
    );
    expect(out).toContain("Provenanced<int> Total");
    expect(out).toContain("new Provenanced<int>(");
    // The trailing `[JsonPropertyName("total_provenance")]` DTO param is gone.
    expect(out).not.toContain('JsonPropertyName("total_provenance")');
  });

  it("java — the shared generic record on the response DTO", async () => {
    const out = await emit("java");
    expect(out).toContain("public record Provenanced<T>(");
    expect(out).toContain(`    T ${VALUE},`);
    expect(out).toContain(`    ProvLineage ${LINEAGE}) {`);
    expect(out).toContain("Provenanced<Integer> total");
    expect(out).toContain("new Provenanced<>(value.total(), value.totalProvenance())");
    expect(out).not.toContain('@JsonProperty("total_provenance")');
  });

  it("python — the shared generic Pydantic model on the response", async () => {
    const out = await emit("python");
    expect(out).toContain("class Provenanced(BaseModel, Generic[_ProvT]):");
    expect(out).toContain(`    ${VALUE}: _ProvT`);
    expect(out).toContain(`    ${LINEAGE}: dict[str, object] | None = None`);
    expect(out).toContain("total: Provenanced[int]");
    expect(out).toContain(`"total": {"${VALUE}": root.total, "${LINEAGE}": (`);
  });

  it("elixir (vanilla Phoenix) — the carrier map in the controller serializer", async () => {
    const out = await emit("elixir");
    expect(out).toContain(
      `"total" => %{"${VALUE}" => record.total, "${LINEAGE}" => record.total_provenance}`,
    );
    // …and the published OpenAPI schema agrees (it named a bare `T` and never
    // mentioned the lineage before the carrier — the Phoenix document
    // disagreed with the JSON the controller actually served).
    expect(out).toContain(
      `total: %OpenApiSpex.Schema{type: :object, properties: %{${VALUE}: %OpenApiSpex.Schema{type: :integer}, ${LINEAGE}: %OpenApiSpex.Schema{type: :object}}, required: [:${VALUE}]}`,
    );
    expect(out).not.toContain('"total_provenance" => record');
  });

  it("the contract artifact (`.loom/wire-spec.json`) publishes the carrier", async () => {
    // §1.2 of the proposal: the one artifact meant to detect wire-contract
    // drift was BLIND to provenance while the lineage was a per-backend
    // bolt-on, because it is built purely from `wireShape`.
    const files = await generateSystemFiles(SYSTEM("node"));
    const spec = JSON.parse(files.get(".loom/wire-spec.json")!);
    expect(spec.aggregates.Order.properties.total).toEqual({
      type: "object",
      properties: {
        [VALUE]: { type: "integer" },
        // NULLABLE, not a bare object (F2-XB-7).  Every backend puts an
        // explicit `"lineage": null` on the wire for a field never written, and
        // JSON Schema applies a member's subschema whenever the key is PRESENT
        // — `required: [value]` does not save it — so a bare `{"type":"object"}`
        // published a contract the app's own response violates.  The
        // nullability is read off the carrier's one declaration
        // (`PROVENANCED_LINEAGE_NULLABLE`), the same way the member NAMES are.
        [LINEAGE]: { type: ["object", "null"] },
      },
      required: [VALUE],
      additionalProperties: false,
    });
  });
});

function upper(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
