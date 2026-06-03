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
        test "deactivating requires admin" {
          let i = Item.create({ name: "x", active: true })
          expectThrows i.deactivate()
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
  deployable api { platform: hono contexts: [C] serves: SApi port: 3000 auth: required }
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

  it("a workflow calling a currentUser-gated op threads currentUser", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const wf = findFile(files, /http\/workflows\.ts$/);
    // The binding is read via the context cast, then threaded into the call.
    expect(wf).toMatch(/const currentUser = \(httpCtx as unknown as \{ get\(k: "currentUser"\)/);
    expect(wf).toMatch(/item\.deactivate\(currentUser\)/);
  });

  it("a domain test calling a currentUser-gated op supplies a synthetic actor", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const test = findFile(files, /item\.test\.ts$/);
    // The op's signature gained a trailing `currentUser`; the test has no
    // auth context, so a full-access actor is passed (cast through unknown so
    // it stays valid regardless of the system's `user { ... }` shape).
    expect(test).toMatch(
      /i\.deactivate\(\{[^}]*role: "admin"[^}]*\} as unknown as import\("\.\.\/auth\/user-types"\)\.User\)/,
    );
  });
});
