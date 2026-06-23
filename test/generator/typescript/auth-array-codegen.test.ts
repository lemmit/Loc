// Hono backend codegen regressions surfaced by compiling the showcase
// system (`examples/showcase.ddd`) — none of these had a compile gate, so
// the generated TypeScript did not type-check.  Each assertion locks the
// fixed emission shape:
//
//   • scalar `T[]` field → native Postgres array column (`.array()`), not a
//     scalar `text(...)` the repository then can't assign a `T[]` into;
//   • an AUTHZ-ONLY operation (currentUser used only in `requires`) called from
//     a workflow has its 403 gate relocated to the call site (rendered against
//     the loaded aggregate var, before the now-pure dispatch); the domain method
//     is param-less, so the workflow threads NO actor and a domain test calls it
//     with no actor either (the data-use case still threads the param);
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
          expect(i.deactivate()).toThrow()
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
  deployable api { platform: node contexts: [C] serves: SApi port: 3000 auth: required }
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

  it("a workflow calling an authz-only op emits the relocated 403 gate before a no-actor call", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const wf = findFile(files, /http\/workflows\.ts$/);
    // `deactivate` is authz-only: its method is now pure (param dropped), so the
    // workflow binds the request-scoped principal, emits the 403 gate against it
    // (the loaded aggregate var supplies any `this.<field>`), then dispatches
    // WITHOUT threading an actor.
    expect(wf).toMatch(/const currentUser = \(httpCtx as unknown as \{ get\(k: "currentUser"\)/);
    expect(wf).toMatch(
      /if \(!\(currentUser\.role === "admin"\)\) throw new ForbiddenError\("Forbidden: currentUser\.role == /,
    );
    expect(wf).toMatch(/item\.deactivate\(\);/);
    // The relocated gate runs BEFORE the dispatch.
    const gateIdx = wf.indexOf("throw new ForbiddenError");
    const callIdx = wf.indexOf("item.deactivate();");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(gateIdx);
  });

  it("a domain test calling an authz-only op passes NO actor (its method is pure)", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const test = findFile(files, /item\.test\.ts$/);
    // The authz-only op's 403 gate relocated to the handler, so its domain
    // method dropped the `currentUser` param — the test calls it bare, with no
    // synthetic actor.
    expect(test).toMatch(/i\.deactivate\(\)/);
    expect(test).not.toMatch(/as unknown as import\("\.\.\/auth\/user-types"\)\.User/);
  });
});
