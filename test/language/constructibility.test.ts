// Constructibility check (staged warning).
//
// An aggregate is constructible when it declares a `create` (explicit or
// via `crudish`) or every required create-input field has a default.  Now
// that Stage 4 removed the implicit hard-coded create, a non-constructible
// aggregate emits no create surface — but that's a legitimate shape (an
// aggregate created only via events / seed data / as a child), so this is
// a WARNING that guides rather than an error that blocks.

import { describe, expect, it } from "vitest";
import { parseString } from "../_helpers/index.js";

const wrap = (body: string) =>
  `system S { subdomain M { context C {
    ${body}
  }}}`;

async function warnings(body: string): Promise<string[]> {
  const { errors, warnings } = await parseString(wrap(body));
  expect(errors).toEqual([]);
  return warnings;
}

const notConstructible = (ws: string[]) => ws.some((w) => /is not constructible/.test(w));

describe("constructibility warning", () => {
  it("warns when an aggregate has no create and a required field without a default", async () => {
    const ws = await warnings(`aggregate A { headline: string } repository As for A { }`);
    expect(notConstructible(ws)).toBe(true);
  });

  it("no warning when every required field has a default (synthesisable create)", async () => {
    const ws = await warnings(
      `aggregate A { headline: string = "untitled" rank: int = 0 } repository As for A { }`,
    );
    expect(notConstructible(ws)).toBe(false);
  });

  it("no warning when the aggregate uses crudish (explicit create)", async () => {
    const ws = await warnings(
      `aggregate A with crudish { headline: string } repository As for A { }`,
    );
    expect(notConstructible(ws)).toBe(false);
  });

  it("no warning when the aggregate declares an explicit create", async () => {
    const ws = await warnings(
      `aggregate A {
        headline: string
        create(headline: string) { headline := headline }
      }
      repository As for A { }`,
    );
    expect(notConstructible(ws)).toBe(false);
  });

  it("optional-only required fields don't trip the check", async () => {
    const ws = await warnings(`aggregate A { note: string? } repository As for A { }`);
    expect(notConstructible(ws)).toBe(false);
  });
});
