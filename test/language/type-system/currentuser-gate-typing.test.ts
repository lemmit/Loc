// `currentUser` principal typing in authorization gates.
//
// `currentUser` is backed by the system's `user { … }` claim block and types
// as `{ kind: "userclaim" }`, so `currentUser.<claim>` member access resolves
// the claim's real type (e.g. `permissions: string[]`).  Before this a bare
// gate `requires currentUser.permissions.contains(permissions.x)` typed as
// `unknown` and was *falsely rejected* — it only passed when a surrounding
// `==` / `&&` / `||` forced the result to bool (which is why every shipped
// example happened to OR it).  These tests pin that the bare gate now
// type-checks, that a genuinely-non-bool gate is still rejected, and that an
// unknown claim stays fail-open (no new error).

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const wrap = (agg: string, extra = "") => `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { approve, manage }
    context C {
      ${agg}
      ${extra}
    }
  }
}`;

const errs = async (agg: string, extra = ""): Promise<string[]> =>
  (await parseString(wrap(agg, extra), { validate: true })).errors;

describe("currentUser gate typing — bare boolean claim gates type-check", () => {
  it("accepts a bare `currentUser.permissions.contains(...)` operation gate", async () => {
    const e = await errs(
      `aggregate Order with crudish { status: string
        operation approveIt() requires currentUser.permissions.contains(permissions.approve) { status := "a" } }`,
    );
    expect(e.filter((s) => /requires/.test(s)).join("\n")).toBe("");
  });

  it('accepts a bare `currentUser.permissions.contains("literal")` gate', async () => {
    const e = await errs(
      `aggregate Order with crudish { status: string
        operation go() requires currentUser.permissions.contains("x") { status := "a" } }`,
    );
    expect(e.filter((s) => /requires/.test(s)).join("\n")).toBe("");
  });

  it("accepts a bare permission gate on a repository `find`", async () => {
    const e = await errs(
      `aggregate Ticket with crudish { status: string }`,
      `repository Tickets for Ticket {
        find secure(): Ticket[] requires currentUser.permissions.contains(permissions.manage) where status == "open"
      }`,
    );
    expect(e.filter((s) => /requires/.test(s)).join("\n")).toBe("");
  });

  it("still rejects a non-bool operation gate", async () => {
    const e = await errs(
      `aggregate Order with crudish { status: string
        operation go() requires currentUser.id { status := "a" } }`,
    );
    expect(e.some((s) => /'requires' must be of type 'bool'/.test(s))).toBe(true);
  });

  it("rejects a non-bool `find` gate (`requires 42`) that previously slipped through", async () => {
    const e = await errs(
      `aggregate Ticket with crudish { status: string }`,
      `repository Tickets for Ticket {
        find secure(): Ticket[] requires 42 where status == "open"
      }`,
    );
    expect(e.some((s) => /'requires' must be of type 'bool', got 'int'/.test(s))).toBe(true);
  });

  it("stays fail-open on an unknown claim (no new error)", async () => {
    // `role` IS declared; `nickname` is NOT — the reference must not error
    // (mirrors the IR layer's string fallback for unknown principal members).
    const e = await errs(
      `aggregate Order with crudish { status: string
        operation go() requires currentUser.nickname == "x" { status := "a" } }`,
    );
    expect(e.join("\n")).toBe("");
  });
});
