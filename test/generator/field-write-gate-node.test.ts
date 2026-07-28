// Node/Hono write-side field gate enforcement (`write(...)` / `readonly when`,
// authorization.md §5, M-T3.2 item 6 — the write-side twin of `mask unless`).
// A field's `writeGate` is a `currentUser`-only ALLOWED-WHEN predicate that must
// hold whenever a client-supplied op param of the SAME NAME is present. The node
// backend emits a fail-closed 403 (ForbiddenError → the file's onError → RFC-7807)
// BEFORE the domain call. A `crudish` aggregate auto-generates `create` + `update`
// ops that take the field as a param, so both handlers must guard it.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

// `crudish` auto-generates create + update (full-replace) ops whose params
// include `salary` — the write-gated field — and `name` — an un-gated one.
const SYSTEM = `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { setSalary }
    context C {
      aggregate P with crudish {
        name: string
        salary: decimal write(currentUser.permissions.contains(permissions.setSalary))
      }
      repository Ps for P { }
    }
  }
  api CApi from M
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: CApi  port: 8080  auth: required }
}`;

async function routes(): Promise<string> {
  const files = await generateSystemFiles(SYSTEM);
  const r = [...files.entries()].find(([p]) => p.endsWith("http/p.routes.ts"))?.[1];
  expect(r, "http/p.routes.ts").toBeDefined();
  return r!;
}

const BIND =
  'const __writeUser = (c as unknown as { get(k: "currentUser"): import("../auth/user-types").User | undefined }).get("currentUser") ?? null;';
const GUARD =
  'if (!(__writeUser !== null && ((__writeUser.permissions).includes("m.setSalary")))) throw new ForbiddenError("Forbidden: write salary");';

describe("field write gate — node enforcement", () => {
  it("guards the create handler (write-gated create-input field)", async () => {
    const r = await routes();
    // Bind + fail-closed guard land right before the create factory call.
    expect(r).toContain(BIND);
    expect(r).toContain(GUARD);
    const createIdx = r.indexOf("const created = P.create(");
    const guardIdx = r.indexOf(GUARD);
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThan(createIdx);
    // The create route declares the 403 outcome in its contract.
    expect(r).toContain(
      '403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemDetails } } },',
    );
  });

  it("guards the update op handler before the domain call", async () => {
    const r = await routes();
    // The update handler's guard (the second in the file) fires before its own
    // `repo.getById` (the gate is principal-only → fail fast, no aggregate load).
    const guardIdx = r.lastIndexOf(GUARD);
    const getByIdIdx = r.indexOf("await repo.getById(Ids.PId(id))", guardIdx);
    const mutateIdx = r.indexOf("aggregate.update(", guardIdx);
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(getByIdIdx).toBeGreaterThan(guardIdx);
    expect(mutateIdx).toBeGreaterThan(guardIdx);
  });

  it("binds __writeUser once per handler", async () => {
    const r = await routes();
    // Exactly two binds: one in create, one in update — not one per gated param.
    const binds = r.split(BIND).length - 1;
    expect(binds).toBe(2);
  });

  it("emits no guard for a system with no write-gated field", async () => {
    const files = await generateSystemFiles(
      SYSTEM.replace(/ write\(currentUser\.permissions\.contains\(permissions\.setSalary\)\)/, ""),
    );
    const r = [...files.entries()].find(([p]) => p.endsWith("http/p.routes.ts"))?.[1];
    expect(r, "http/p.routes.ts").toBeDefined();
    // Byte-identical to a gate-free op: no bind, no Forbidden(write ...) guard.
    expect(r).not.toContain("__writeUser");
    expect(r).not.toContain("Forbidden: write");
  });
});
