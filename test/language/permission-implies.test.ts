// `permissions { X implies Y }` validation (authorization.md §6, M-T3.2 item 7).

import { describe, expect, it } from "vitest";
import { parseString } from "../_helpers/index.js";

const wrap = (perms: string) => `system S {
  user { id: string  permissions: string[] }
  subdomain M {
    permissions { ${perms} }
    context C { aggregate A with crudish { status: string } }
  }
}`;

const errs = async (perms: string): Promise<string[]> =>
  (await parseString(wrap(perms), { validate: true })).errors;

describe("permission implies — validation", () => {
  it("accepts a valid single + bracketed implies chain", async () => {
    const e = await errs("read, edit implies read, admin implies [read, edit]");
    expect(e.join("\n")).toBe("");
  });

  it("rejects an implies target that names no declared permission", async () => {
    const e = await errs("read, edit implies ghost");
    expect(e.some((s) => /implies 'ghost'.*not a permission declared/.test(s))).toBe(true);
  });

  it("rejects self-implication", async () => {
    const e = await errs("read, edit implies edit");
    expect(e.some((s) => /cannot 'implies' itself/.test(s))).toBe(true);
  });

  it("allows a mutual-implication cycle (grants each other)", async () => {
    const e = await errs("a implies b, b implies a");
    expect(e.join("\n")).toBe("");
  });
});
