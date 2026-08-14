// A NAMED `create` / `destroy` is dropped whole — not just its body.
//
// The sibling check (`lifecycle-body-dropped.test.ts`) reads `canonicalCreate`
// / `canonicalDestroy`, so it says nothing about a named action, while the loss
// is strictly larger.  Measured on `main` before this check existed, from a
// state-based aggregate declaring `create open(...)` + `destroy close(...)`:
// `ddd parse` reported `0 error(s), 0 warning(s)`, and the emitted Hono API
// carried two GET routes, NO POST and NO DELETE — the aggregate was not
// constructible over HTTP at all, and the factory came out synthesized from the
// field set with the `requires` nowhere in it.
//
// Which action each backend renders was read off the five emitters rather than
// assumed: an event-sourced create is `agg.creates[0]` (by INDEX — hono,
// python, java, dotnet and elixir all index [0]), every other create is the
// canonical one, and a destroy is the canonical one only.  The event-sourced
// arm is why the negative cases below matter as much as the positive ones:
// every named create in this repo's own `.ddd` corpus lives on an event stream,
// and each one must keep compiling.

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/index.js";

const CODE = "loom.named-lifecycle-dropped";

const wrap = (agg: string): string => `
system P {
  subdomain D {
    context Orders {
      event Opened { order: Order id  owner: string }
${agg}
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: node contexts: [Orders] dataSources: [st] port: 3000 }
}
`;

async function errorsFor(agg: string) {
  return validateLoomModel(await buildLoomModel(wrap(agg))).filter((d) => d.severity === "error");
}

async function codesFor(agg: string): Promise<string[]> {
  return (await errorsFor(agg)).map((d) => d.code);
}

describe("validator — the named lifecycle action no backend renders", () => {
  it("rejects a named create on a state-based aggregate", async () => {
    const codes = await codesFor(`
      aggregate Order {
        code: string
        create open(code: string) {
          requires currentUser.role == "admin"
          code := code
        }
      }`);
    expect(codes).toContain(CODE);
  });

  it("rejects a named destroy", async () => {
    const codes = await codesFor(`
      aggregate Order {
        code: string
        create(code: string) { code := code }
        destroy close(reason: string) { }
      }`);
    expect(codes).toContain(CODE);
  });

  // The point of the diagnostic is that the loss is bigger than a dropped body:
  // there is no route to keep.  If it only said "the body is not emitted" a
  // reader would reasonably assume the POST still exists.
  it("names what is lost — the route and the factory, not just the body", async () => {
    const [diag] = await errorsFor(`
      aggregate Order {
        code: string
        create open(code: string) { code := code }
      }`);
    expect(diag.code).toBe(CODE);
    expect(diag.message).toContain("no route");
    expect(diag.message).toContain("open");
    // The remedy, not just the complaint.
    expect(diag.message).toMatch(/canonical|operation/);
  });

  it("reports each named action separately, so a fix-one-at-a-time loop terminates", async () => {
    const codes = await codesFor(`
      aggregate Order {
        code: string
        create open(code: string) { code := code }
        create draft(code: string) { code := code }
        destroy close() { }
      }`);
    expect(codes.filter((c) => c === CODE)).toHaveLength(3);
  });

  // ---- the negative cases: where the action IS rendered -------------------

  it("allows a named create on an EVENT-SOURCED aggregate — that path is `creates[0]`", async () => {
    const codes = await codesFor(`
      aggregate Order persistedAs: eventLog {
        owner: string
        create open(owner: string) {
          emit Opened { order: id, owner: owner }
        }
        apply(e: Opened) {
          owner := e.owner
        }
      }`);
    expect(codes).not.toContain(CODE);
  });

  it("allows the canonical create and destroy", async () => {
    const codes = await codesFor(`
      aggregate Order {
        code: string
        create(code: string) { code := code }
        destroy { }
      }`);
    expect(codes).not.toContain(CODE);
  });

  it("says nothing about an aggregate that declares no lifecycle action at all", async () => {
    const codes = await codesFor(`
      aggregate Order {
        code: string
      }`);
    expect(codes).not.toContain(CODE);
  });
});
