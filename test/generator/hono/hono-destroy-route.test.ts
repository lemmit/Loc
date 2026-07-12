import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Hono canonical-destroy consumption.
//
// The Hono backend emits a `DELETE /{id}` route + a repo `delete(id)` method
// ONLY when the aggregate has a canonical (unnamed) destroy in the IR —
// declared, or contributed by the `crudish` macro.  Aggregates without one
// keep their existing route/repo files byte-for-byte (no DELETE), so this is
// purely additive.  See routes-builder.ts + repository-builder.ts.
// ---------------------------------------------------------------------------

const FIXTURE = `system AcmeDel {
  subdomain Ops {
    context Ops {
      // crudish injects a canonical create + destroy + update.
      aggregate Widget with crudish {
        label: string
        size: int
      }
      // Plain aggregate — no lifecycle actions, so no DELETE route.
      aggregate Gadget {
        name: string
      }
      repository Widgets for Widget { }
      repository Gadgets for Gadget { }
    }
  }
  api OpsApi from Ops
  deployable opsApi {
    platform: node
    contexts: [Ops]
    serves: OpsApi
    port: 3000
  }
}
`;

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function find(files: Map<string, string>, re: RegExp): string {
  for (const [k, v] of files) if (re.test(k)) return v;
  throw new Error(`no file matched ${re}`);
}

describe("Hono canonical-destroy → DELETE route", () => {
  it("emits a DELETE /{id} route for the crudish (lifecycle-bearing) aggregate", async () => {
    const files = await build();
    const routes = find(files, /widget\.routes\.ts$/);
    expect(routes).toContain('method: "delete"');
    expect(routes).toContain('path: "/{id}"');
    // Canonical operationId token → camelId(["destroy","Widget"]).
    expect(routes).toContain('operationId: "destroyWidget"');
    // 404 guard then hard delete.
    expect(routes).toContain("await repo.getById(Ids.WidgetId(id));");
    expect(routes).toContain("await repo.delete(Ids.WidgetId(id));");
    expect(routes).toContain("return c.body(null, 204);");
    // FK-violation (still-referenced) → 409 mapped locally.
    expect(routes).toContain('status: 409, detail: "Widget is still referenced');
    expect(routes).toContain(
      '(((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code) === "23503")',
    );
  });

  it("emits an `async delete(id)` method on the crudish aggregate's repository", async () => {
    const files = await build();
    const repo = find(files, /widget-repository\.ts$/i);
    expect(repo).toContain("async delete(id: Ids.WidgetId): Promise<void>");
    expect(repo).toContain("this.db.delete(schema.widgets).where(eq(schema.widgets.id, id))");
  });

  it("does NOT emit a DELETE route or delete() for a plain aggregate (gating)", async () => {
    const files = await build();
    const routes = find(files, /gadget\.routes\.ts$/);
    expect(routes).not.toContain('method: "delete"');
    expect(routes).not.toContain("repo.delete(");
    const repo = find(files, /gadget-repository\.ts$/i);
    expect(repo).not.toContain("async delete(");
  });
});
