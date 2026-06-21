// ---------------------------------------------------------------------------
// Hono (node) backend — lifecycle stamps (`stamp onCreate`/`onUpdate`, the
// audit / softDelete capability stamps).  Non-principal state stamps become
// `_stampOnCreate` / `_stampOnUpdate` methods on the aggregate
// (`this._<field> = <value>`) the route handler calls right before save —
// closing the prior silent-drop (the audit columns were emitted but never
// populated).  A `currentUser` value resolves to the principal id
// (`currentUser.<idField>`); the route threads the typed principal read from
// the request scope.  Principal-referencing stamps on a deployable WITHOUT
// auth and stamps on an event-sourced aggregate stay fail-fast gated
// (loom.node-stamp-unsupported), mirroring the java / dotnet gates.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";
import { buildLoomModel } from "../../_helpers/ir.js";

// now()-only stamps (no principal) — no auth needed.
const SRC = `system AcmeStamp {
  subdomain D {
    context Shop {
      stamp onCreate { createdAt := now() }
      stamp onUpdate { updatedAt := now() }
      aggregate Order with crudish {
        code: string
        createdAt: datetime
        updatedAt: datetime
      }
      repository Orders for Order { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 {
    platform: node
    contexts: [Shop]
    dataSources: [st]
    serves: A
    port: 8081
  }
}
`;

// A `currentUser` stamp — requires auth (a request-scoped principal).
const PRINCIPAL_SRC = `system PrincipalStamp {
  user { id: guid  name: string }
  subdomain D {
    context Shop {
      stamp onCreate { createdBy := currentUser }
      aggregate Order with crudish {
        code: string
        createdBy: guid
      }
      repository Orders for Order { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 {
    platform: node
    contexts: [Shop]
    dataSources: [st]
    serves: A
    port: 8081
    auth: required
  }
}
`;

async function build(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function find(files: Map<string, string>, re: RegExp): string {
  for (const [k, v] of files) if (re.test(k)) return v;
  throw new Error(`no file matched ${re}`);
}

describe("Hono (node) generator — lifecycle stamps", () => {
  it("emits _stampOnCreate / _stampOnUpdate methods over the stamp fields", async () => {
    const entity = find(await build(SRC), /domain\/order\.ts$/);
    expect(entity).toContain("  _stampOnCreate(): void {");
    expect(entity).toContain("    this._createdAt = new Date();");
    expect(entity).toContain("  _stampOnUpdate(): void {");
    expect(entity).toContain("    this._updatedAt = new Date();");
  });

  it("the create route calls _stampOnCreate immediately before save", async () => {
    const routes = find(await build(SRC), /order\.routes\.ts$/);
    expect(routes).toContain("created._stampOnCreate();");
    // The stamp runs immediately before the persist.
    expect(routes).toMatch(/created\._stampOnCreate\(\);\s*\n\s*await repo\.save\(created\);/);
  });

  it("the update operation route calls _stampOnUpdate before save", async () => {
    const routes = find(await build(SRC), /order\.routes\.ts$/);
    expect(routes).toContain("aggregate._stampOnUpdate();");
    expect(routes).toMatch(/aggregate\._stampOnUpdate\(\);\s*\n\s*await repo\.save\(aggregate\);/);
  });

  it("a currentUser stamp on an auth deployable resolves to the principal id", async () => {
    const files = await build(PRINCIPAL_SRC);
    const entity = find(files, /domain\/order\.ts$/);
    // The method takes the typed principal; the value renders to the id field.
    expect(entity).toContain("  _stampOnCreate(currentUser: User): void {");
    expect(entity).toContain("    this._createdBy = currentUser.id;");
    expect(entity).toContain('import type { User } from "../auth/user-types";');
    // The route reads the principal from the request scope and threads it in.
    const routes = find(files, /order\.routes\.ts$/);
    expect(routes).toContain('.get("currentUser")');
    expect(routes).toContain("created._stampOnCreate(currentUser);");
  });

  it("gates a currentUser stamp on a deployable WITHOUT auth fail-fast", async () => {
    // Drop `auth: required` — a currentUser stamp then has no request-scoped
    // principal to thread.
    const noAuth = PRINCIPAL_SRC.replace("\n    auth: required", "");
    const loom = await buildLoomModel(noAuth);
    const errors = validateLoomModel(loom).filter((d) => d.code === "loom.node-stamp-unsupported");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("no auth");
  });

  it("gates a lifecycle stamp on an event-sourced aggregate fail-fast", async () => {
    const es = `system EsStamp {
      subdomain D {
        context Shop {
          stamp onCreate { createdAt := now() }
          event OrderPlaced { code: string }
          aggregate Order persistedAs(eventLog) {
            code: string
            createdAt: datetime
            create place(code: string) {
              emit OrderPlaced { code: code }
            }
            apply(e: OrderPlaced) {
              code := e.code
            }
          }
          repository Orders for Order { }
        }
      }
      api A from D
      storage primary { type: postgres }
      resource el { for: Shop, kind: eventLog, use: primary }
      deployable api1 {
        platform: node
        contexts: [Shop]
        dataSources: [el]
        serves: A
        port: 8081
      }
    }`;
    const loom = await buildLoomModel(es);
    const errors = validateLoomModel(loom).filter((d) => d.code === "loom.node-stamp-unsupported");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("event-sourced");
  });
});
