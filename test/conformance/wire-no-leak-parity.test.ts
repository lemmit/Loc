// RS-3 · No persistence-internal columns leak to the wire — cross-backend, static.
//
// The response body a backend serves must be exactly its `wireShape` — never
// framework/storage bookkeeping the ORM adds under the hood. The canonical
// offender is auto-stamped timestamps: the Elixir backend adds
// `timestamps(type: :utc_datetime)` to every Ecto schema, so `inserted_at` /
// `updated_at` are real DB columns that must NOT appear in the JSON.
//
// This is the exact §14 regression (#1628): the vanilla serializer used
// `Map.from_struct(record)`, which dragged the Ecto timestamps into the wire
// body. The fix routes serialization through a `wireShape`-driven map. The bug
// compiled green and passed the structural OpenAPI parity diff (the leaked keys
// simply weren't in the spec being compared) — a T0 static gate against the
// emitted wire-serialization site is what catches it per-PR.
//
// Anchored to each backend's RESPONSE site, NOT the DB schema — Elixir's schema
// legitimately declares `timestamps()`; the guarantee is that they don't reach
// the wire. The leak signature is deliberately the framework-timestamp tokens
// (`inserted_at`/`updated_at` + their camel wire forms) — NOT `createdAt`,
// which is a legal *declared* field and also collides with .NET's
// `CreatedAtAction` routing helper.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** A plain aggregate — no declared timestamp field. On Elixir this still gets
 *  auto `timestamps()` in the schema, so it's the leak trigger. */
function system(platform: string): string {
  return `
system S {
  subdomain Sales {
    context Orders {
      aggregate Order { code: string  region: string }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d {
    platform: ${platform}
    contexts: [Orders]
    dataSources: [s]
    serves: OrdersApi
    port: 4000
  }
}`;
}

type Backend = {
  platform: string;
  /** The emitted file that fixes the wire response body. */
  file: string;
  /** Must appear: a declared wire field, proving we're at the wire site (not a
   *  vacuous pass if the file/serializer moved). */
  present: RegExp;
};

const BACKENDS: Backend[] = [
  { platform: "node", file: "d/http/order.routes.ts", present: /code/ },
  { platform: "python", file: "d/app/http/order_routes.py", present: /code/ },
  {
    platform: "dotnet",
    file: "d/Application/Orders/Responses/OrderResponses.cs",
    present: /\bCode\b/,
  },
  {
    platform: "java",
    file: "d/src/main/java/com/loom/d/features/orders/OrderResponse.java",
    present: /code/i,
  },
  {
    // The §14 site: `defp serialize(record)` builds the wire map explicitly.
    platform: "elixir",
    file: "d/lib/d_web/controllers/order_controller.ex",
    present: /"code"/,
  },
];

/** The framework-timestamp leak signature (Ecto `timestamps()` + camel wire
 *  forms). Not `createdAt`/`created_at` — a declared temporal field is legal. */
const LEAK = /inserted_at|updated_at|insertedAt|updatedAt/;

describe("RS-3 · no persistence-internal columns leak to the wire (static, all backends)", () => {
  for (const b of BACKENDS) {
    it(`${b.platform}: wire response carries only declared fields`, async () => {
      const files = await generateSystemFiles(system(b.platform));
      const src = files.get(b.file);
      expect(src, `expected ${b.file} in the generated ${b.platform} project`).toBeDefined();
      expect(src, `${b.platform}: wire site ${b.file} missing declared field`).toMatch(b.present);
      expect(
        LEAK.test(src ?? ""),
        `${b.platform}: framework timestamp leaked into the wire response (${b.file}) — RS-3 regression, cf §14/#1628`,
      ).toBe(false);
    });
  }
});
