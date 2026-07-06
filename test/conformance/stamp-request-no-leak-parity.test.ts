// Stamp targets never appear in Create/Update request DTOs — cross-backend, static.
//
// S1(b) of `docs/audits/generated-code-ddd-review-2026-07.md`: a field written
// by a `stamp onCreate`/`onUpdate` is server-owned at persist time.  Admitting
// it on the request wire is a mass-assignment surface — the client controls
// the very column a row-security `filter` typically reads (`createdByRole` in
// the audit's `ownerStamped` case).  Two layers enforce the exclusion and this
// gate pins BOTH per-PR:
//
//   - create: enrichment promotes stamp targets to `access: managed`
//     (`promoteStampTargets`) and every backend derives the create DTO from
//     the `forCreateInput` contract;
//   - update: the crudish `update` op derives its params from
//     `writableUpdateFields`, which excludes stamp targets at the AST layer
//     (the update DTO is `op.params`-shaped on every backend, so the IR
//     promotion alone cannot reach it — the historical leak).
//
// Anchored to each backend's REQUEST DTO sites.  The RESPONSE keeps the field
// (managed fields are readable) — that's asserted too, so a regression that
// nukes the field everywhere can't pass vacuously.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** A crudish aggregate with a hand-written principal stamp on a declared
 *  editable field — the audit's `ownerStamped` shape, context-level so the
 *  propagation path is covered too. */
function system(platform: string): string {
  return `
system PS {
  user { id: guid  role: string }
  subdomain D {
    context Shop {
      stamp onCreate { createdByRole := currentUser.role }
      aggregate Order with crudish {
        code: string
        createdByRole: string
      }
      repository Orders for Order { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable d { platform: ${platform}, contexts: [Shop], dataSources: [st], serves: A, port: 8080, auth: required }
}`;
}

const STAMPED = /createdByRole|created_by_role|CreatedByRole/;

type Backend = {
  platform: string;
  /** Request-DTO sites: file + an extractor pulling just the request-schema
   *  region (some backends inline requests next to the response schema). */
  requests: { file: string; extract?: RegExp }[];
  /** A read site that must still carry the field (managed = readable). */
  response: string;
};

const BACKENDS: Backend[] = [
  {
    platform: "node",
    requests: [
      {
        file: "d/http/order.routes.ts",
        extract: /const CreateOrderRequest = z\.object\(\{[^}]*\}\)/,
      },
      {
        file: "d/http/order.routes.ts",
        extract: /const UpdateOrderRequest = z\.object\(\{[^}]*\}\)/,
      },
    ],
    response: "d/http/order.routes.ts",
  },
  {
    platform: "python",
    requests: [
      {
        file: "d/app/http/order_routes.py",
        extract: /class CreateOrderRequest\(BaseModel\):[\s\S]*?(?=\n\S)/,
      },
      {
        file: "d/app/http/order_routes.py",
        extract: /class UpdateOrderRequest\(BaseModel\):[\s\S]*?(?=\n\S)/,
      },
    ],
    response: "d/app/http/order_routes.py",
  },
  {
    platform: "dotnet",
    requests: [
      { file: "d/Application/Orders/Commands/CreateOrderCommand.cs" },
      { file: "d/Application/Orders/Commands/UpdateCommand.cs" },
    ],
    response: "d/Application/Orders/Responses/OrderResponses.cs",
  },
  {
    platform: "java",
    requests: [
      { file: "d/src/main/java/com/loom/d/features/orders/CreateOrderRequest.java" },
      { file: "d/src/main/java/com/loom/d/features/orders/UpdateOrderRequest.java" },
    ],
    response: "d/src/main/java/com/loom/d/features/orders/OrderResponse.java",
  },
  {
    platform: "elixir",
    requests: [
      { file: "d/lib/d_web/api/schemas/create_order_request.ex" },
      { file: "d/lib/d_web/api/schemas/update_order_request.ex" },
    ],
    response: "d/lib/d_web/api/schemas/order_response.ex",
  },
];

describe("stamp targets stay out of Create/Update request DTOs (static, all backends)", () => {
  for (const b of BACKENDS) {
    const name = b.platform.split(" ")[0];
    it(`${name}: request DTOs carry declared fields only; response keeps the stamped field`, async () => {
      const files = await generateSystemFiles(system(b.platform));
      for (const site of b.requests) {
        const src = files.get(site.file);
        expect(src, `expected ${site.file} in the generated ${name} project`).toBeDefined();
        const region = site.extract ? (src!.match(site.extract)?.[0] ?? "") : src!;
        expect(
          region.length > 0,
          `${name}: request-schema extractor matched nothing in ${site.file} — site moved?`,
        ).toBe(true);
        // Non-vacuous: the legit client field is present in the request…
        expect(region, `${name}: ${site.file} lost the declared client field`).toMatch(/code/i);
        // …and the stamped one is not.
        expect(
          STAMPED.test(region),
          `${name}: stamp target leaked into a request DTO (${site.file}) — S1(b) regression`,
        ).toBe(false);
      }
      const resp = files.get(b.response);
      expect(resp, `expected ${b.response} in the generated ${name} project`).toBeDefined();
      expect(
        STAMPED.test(resp!),
        `${name}: managed stamp target should stay READABLE (${b.response})`,
      ).toBe(true);
    });
  }
});
