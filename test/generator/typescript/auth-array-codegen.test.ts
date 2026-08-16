// Hono backend codegen regressions surfaced by compiling the showcase
// system (`examples/showcase.ddd`) — none of these had a compile gate, so
// the generated TypeScript did not type-check.  Each assertion locks the
// fixed emission shape:
//
//   • scalar `T[]` field → native Postgres array column (`.array()`), not a
//     scalar `text(...)` the repository then can't assign a `T[]` into;
//   • a currentUser-gated operation called from a workflow / domain test is
//     supplied the trailing `currentUser` argument its method signature now
//     takes (route handlers already did; workflows + tests did not);
//   • the request-scoped `currentUser` is read through a cast — the Hono
//     context Variables map has no `currentUser` key, so a bare
//     `c.get("currentUser")` does not type-check (overload resolves to
//     `get(key: never)`).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const FIXTURE = `
system AuthArray {
  user { id: string role: string permissions: string[] }
  subdomain S {
    context C {
      aggregate Item with crudish {
        name: string
        tags: string[]?
        active: bool
        operation deactivate() {
          requires currentUser.role == "admin"
          active := false
        }
        // A DOMAIN-tier test can no longer assert the authorization gate: the
        // gate is hoisted to the caller (op-gates.ts), so the entity method
        // just runs.  Authorization is asserted at the api tier, where the 403
        // actually happens.  This test asserts the state change instead.
        test "deactivating clears the active flag" {
          let i = Item.create({ name: "x", active: true })
          i.deactivate()
          expect(i.active).toBe(false)
        }
      }
      repository Items for Item { }
      workflow turnOff {
        create(name: string) {
          let item = Item.create({ name: name, active: true })
          item.deactivate()
        }
      }
    }
  }
  api SApi from S
  storage loomDb { type: postgres }
  resource cState { for: C, kind: state, use: loomDb }
  deployable api { platform: node contexts: [C] dataSources: [cState] serves: SApi port: 3000 auth: required }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  throw new Error(`no generated file matched ${pattern}`);
}

describe("hono backend codegen — showcase regressions", () => {
  it("a scalar T[] field maps to a native Postgres array column", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const schema = findFile(files, /db\/schema\.ts$/);
    // `.array()` types as `string[] | null`; a bare `text("tags")` would type
    // as `string | null`, which the repository's `T[]` assignment rejects.
    expect(schema).toMatch(/tags:\s*text\("tags"\)\.array\(\)/);
    expect(schema).not.toMatch(/arrays not supported as inline columns/);
  });

  it("a workflow calling a gated op evaluates the gate rather than threading a principal", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const wf = findFile(files, /http\/workflows\.ts$/);
    // The binding is still read via the context cast — the gate needs it — but
    // it is consumed HERE now (op-gates.ts) instead of being handed to the
    // entity, so the call itself is argument-free.
    expect(wf).toMatch(/const currentUser = \(httpCtx as unknown as \{ get\(k: "currentUser"\)/);
    expect(wf).toMatch(/if \(!\(currentUser\.role === "admin"\)\) throw new ForbiddenError\(/);
    expect(wf).toMatch(/item\.deactivate\(\);/);
    expect(wf).not.toMatch(/item\.deactivate\(currentUser\)/);
  });

  it("a domain test calls the gated op with no synthetic actor — there is no gate left to satisfy", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const test = findFile(files, /item\.test\.ts$/);
    // The op's signature no longer takes a principal, so the emitted unit test
    // stops fabricating one.  Passing the old actor would now be an excess
    // argument and fail `tsc --noEmit`.
    expect(test).toMatch(/i\.deactivate\(\)/);
    expect(test).not.toMatch(/as unknown as import\("\.\.\/auth\/user-types"\)\.User/);
  });
});
