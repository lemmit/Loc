// M-T5.14 — a `commandHandler` / `queryHandler` that orchestrates a
// `reading`-tier domain service.
//
// A reading service op is emitted as `async isHolderFree(accounts:
// AccountRepositoryPort, holder: string)` — its repository read ports come
// AHEAD of the user args (domain-services.md rev. 4), and the orchestrating
// caller supplies them.  Workflows did.  Handlers did not, in three separate
// seams, and the emitted route named all three defects in one line:
//
//   return httpCtx.json(Registration.isHolderFree(holder) as unknown, 200);
//
//   1. arity-short  — no `accounts` handle          (TS2554)
//   2. un-awaited   — the op is async               (a Promise serialised `{}`)
//   3. unresolved   — `Registration` never imported (TS2304)
//
// …and no diagnostic for any of it.  The statement path was already right
// (`honoWorkflowStmtTarget` threads the resolver); only the handler's `return`
// render, its port-repo construction, and its service import were missing.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
system S {
  subdomain D {
    context C {
      aggregate Account with crudish { holder: string  balance: int }
      repository Accounts for Account {
        find byHolder(holder: string): Account? where this.holder == holder
      }

      // reading tier — takes a read port.
      domainService Registration {
        operation isHolderFree(holder: string): bool {
          return Accounts.byHolder(holder) == null
        }
      }
      // pure tier — takes none, so it must stay byte-identical (no await,
      // no prepended handle).
      domainService Fees {
        operation double(n: int): int { return n + n }
      }

      queryHandler HolderFree(holder: string): bool {
        return Registration.isHolderFree(holder)
      }
      queryHandler Doubled(n: int): int {
        return Fees.double(n)
      }
    }
  }
  api A from D {
    route GET "/holder-free/{holder}" -> C.HolderFree
    route GET "/doubled/{n}" -> C.Doubled
  }
  storage pg { type: postgres }
  resource s { for: C, kind: state, use: pg }
  deployable api { platform: node  contexts: [C]  dataSources: [s]  serves: A  port: 8080 }
}
`;

let cache: string | undefined;
async function routes(): Promise<string> {
  if (cache === undefined) {
    const files = (await generateSystems(await parseValid(SRC))).files;
    const k = [...files.keys()].find((key) => key.endsWith("http/a-routes.ts"));
    expect(k, "a-routes.ts not emitted").toBeDefined();
    cache = files.get(k!)!;
  }
  return cache;
}

function handlerBody(src: string, operationId: string): string {
  const start = src.indexOf(`operationId: "${operationId}"`);
  expect(start, `route ${operationId} not found`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("app.openapi(", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("node/Hono handler → reading domain service", () => {
  it("the reading call gets its read-port handle, ahead of the user args", async () => {
    const body = handlerBody(await routes(), "cHolderFree");
    expect(body).toContain("Registration.isHolderFree(accounts, holder)");
  });

  it("the reading call is awaited — the service op is async", async () => {
    const body = handlerBody(await routes(), "cHolderFree");
    expect(body).toContain("(await Registration.isHolderFree(accounts, holder))");
  });

  it("the handler CONSTRUCTS the port repository, even though its own body never reads it", async () => {
    const body = handlerBody(await routes(), "cHolderFree");
    expect(body).toContain("const accounts = new AccountRepository(db, events);");
  });

  it("the service namespace is imported — it was TS2304 before", async () => {
    const src = await routes();
    expect(src).toContain('import { Fees, Registration } from "../domain/services";');
  });

  it("a PURE service call stays byte-identical: no handle, no await", async () => {
    const body = handlerBody(await routes(), "cDoubled");
    expect(body).toContain("Fees.double(n)");
    expect(body).not.toContain("await Fees.double");
  });
});
