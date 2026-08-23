// ---------------------------------------------------------------------------
// `loom.resource-op-outside-workflow` — a resource verb call is a PLACEMENT
// contract, not a per-backend gap.
//
// A resource handle is AMBIENT over the whole context (`lowerContext` seeds
// `resources` into the same `Env` an aggregate body resolves against, ahead of
// locals), so `salesFiles.put(k, v)` inside an aggregate `operation` lowered
// clean.  Only the workflow / handler / domain-service emitters thread the
// resource client into their render context, so the five backends failed five
// ways:
//
//   .NET / Java / Phoenix — `render-expr.ts` THROWS mid-generation, so
//       `ddd generate system` dies with a stack trace and writes nothing.
//       (Verified: a `create { requires salesFiles.list(…).count == 0 }` blows
//       up inside the .NET `lifecycleGate`.)
//   TS / Python — emit an awaited helper call into a module that never imports
//       it.  (Verified: the Hono guard emission lands `(await
//       salesFiles$list("orders/"))` in `http/order.routes.ts`, which imports
//       no resource client → TS2304.)
//
// `docs/resources.md` states the rule ("workflows only"); nothing enforced it.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.resource-op-outside-workflow";

/** One context with an objectStore resource (`salesFiles`) bound to it, plus
 *  whatever aggregate / workflow members the case needs. */
const wrap = (ctxBody: string) => `
system RC {
  subdomain D {
    context Sales {
      ${ctxBody}
    }
  }
  api A from D
  storage pg { type: postgres }
  storage files { type: s3, config: { bucket: "app-files" } }
  resource salesState { for: Sales, kind: state, use: pg }
  resource salesFiles { for: Sales, kind: objectStore, use: files }
  deployable d {
    platform: node
    contexts: [Sales]
    dataSources: [salesState, salesFiles]
    serves: A
    port: 4000
  }
}`;

async function diagnostics(ctxBody: string) {
  const { model, errors } = await parseString(wrap(ctxBody));
  if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

const codes = async (ctxBody: string): Promise<string[]> =>
  (await diagnostics(ctxBody)).map((d) => d.code);

describe("loom.resource-op-outside-workflow — the gate", () => {
  it("flags a BARE resource-op statement in an aggregate operation", async () => {
    expect(
      await codes(`
        aggregate Order {
          name: string
          operation archive() { salesFiles.put("orders/" + this.name, this.name) }
        }
        repository Orders for Order { }
      `),
    ).toContain(CODE);
  });

  it("flags a LET-BOUND resource-op in an aggregate operation", async () => {
    expect(
      await codes(`
        aggregate Order {
          name: string
          operation archive() {
            let prev = salesFiles.get("orders/" + this.name)
          }
        }
        repository Orders for Order { }
      `),
    ).toContain(CODE);
  });

  // The guard question `structural-checks.ts` explicitly deferred ("A guard
  // doing IO is a different objection, not this one.") — settled here, because
  // a guard renders in a route/authz position where no resource client exists.
  it("flags a resource-op in a lifecycle `create` GUARD", async () => {
    expect(
      await codes(`
        aggregate Order {
          name: string
          create(name: string) { requires salesFiles.list("orders/").count == 0 }
        }
        repository Orders for Order { }
      `),
    ).toContain(CODE);
  });

  it("flags a resource-op in an aggregate `derived`", async () => {
    expect(
      await codes(`
        aggregate Order {
          name: string
          derived backup: string = salesFiles.signedUrl(this.name)
        }
        repository Orders for Order { }
      `),
    ).toContain(CODE);
  });

  it("names the member and the resource verb, and is an error", async () => {
    const d = (
      await diagnostics(`
        aggregate Order {
          name: string
          operation archive() { salesFiles.put("k", this.name) }
        }
        repository Orders for Order { }
      `)
    ).find((x) => x.code === CODE);
    expect(d?.severity).toBe("error");
    expect(d?.message).toMatch(/salesFiles\.put/);
    expect(d?.message).toMatch(/Order\.archive/);
    expect(d?.message).toMatch(/workflow/);
  });

  // ---------------------------------------------------------------------
  // Domain services.  The first cut of this gate called a `domainService`
  // operation body a LEGAL site (matching the ambient-resource `Env` and the
  // three sites `deriveNeeds` scans).  Re-verified against a real generation,
  // it fails the same five ways the aggregate bodies did:
  //
  //   .NET / Java / Phoenix — `ddd generate system` THROWS out of each
  //       backend's `domain-service` emitter ("reached the … renderer without
  //       a resource class mapping"), writing nothing.
  //   TS     — `domain/services.ts:6` gets `(await salesFiles$list(…))` inside
  //       a non-async `export function`, in a file importing no resource
  //       client → TS1308 + TS2304.
  //   Python — `app/domain/services/archiver.py:9` gets the same `await` in a
  //       bare `def` → SyntaxError + F821.
  // ---------------------------------------------------------------------
  it("flags a LET-BOUND resource-op in a domainService operation body", async () => {
    expect(
      await codes(`
        aggregate Order with crudish { name: string }
        repository Orders for Order { }
        domainService Archiver {
          operation archived(name: string): bool {
            let existing = salesFiles.list("orders/" + name)
            return existing.count > 0
          }
        }
      `),
    ).toContain(CODE);
  });

  it("flags a BARE resource-op statement in a domainService operation body", async () => {
    expect(
      await codes(`
        aggregate Order with crudish { name: string }
        repository Orders for Order { }
        domainService Archiver {
          operation stash(name: string) { salesFiles.put("orders/" + name, name) }
        }
      `),
    ).toContain(CODE);
  });

  it("names the SERVICE and operation in the domainService diagnostic", async () => {
    const d = (
      await diagnostics(`
        aggregate Order with crudish { name: string }
        repository Orders for Order { }
        domainService Archiver {
          operation stash(name: string) { salesFiles.put("orders/" + name, name) }
        }
      `)
    ).find((x) => x.code === CODE);
    expect(d?.severity).toBe("error");
    expect(d?.message).toMatch(/salesFiles\.put/);
    expect(d?.message).toMatch(/domainService\[Archiver\]\.operation\[stash\]/);
  });

  it("reports ONE diagnostic for an operation calling the same verb twice", async () => {
    const hits = (
      await diagnostics(`
        aggregate Order {
          name: string
          operation archive() {
            salesFiles.put("a", this.name)
            salesFiles.put("b", this.name)
          }
        }
        repository Orders for Order { }
      `)
    ).filter((d) => d.code === CODE);
    expect(hits).toHaveLength(1);
  });
});

describe("loom.resource-op-outside-workflow — what it must NOT flag", () => {
  it("POSITIVE CONTROL: the same call inside a workflow is clean", async () => {
    expect(
      await codes(`
        aggregate Order with crudish { name: string }
        repository Orders for Order { }
        workflow archive {
          create(name: string) {
            let prev = salesFiles.get("orders/" + name)
            salesFiles.put("orders/" + name, name)
          }
        }
      `),
    ).not.toContain(CODE);
  });

  it("POSITIVE CONTROL: a domainService that touches no resource is clean", async () => {
    expect(
      await codes(`
        aggregate Order with crudish { name: string }
        repository Orders for Order { }
        domainService Naming {
          operation label(name: string): string { return "order-" + name }
        }
      `),
    ).not.toContain(CODE);
  });

  it("an aggregate operation with no resource-op at all raises nothing", async () => {
    expect(
      await codes(`
        aggregate Order {
          name: string
          operation rename(to: string) { name := to }
        }
        repository Orders for Order { }
      `),
    ).not.toContain(CODE);
  });
});
