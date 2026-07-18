import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// `loom.blank-message` — an empty or whitespace-only `message "..."` clause on
// an invariant / property `check` / precondition is rejected at validation: a
// blank message renders an empty user-facing error string (and degenerates the
// content-hashed wire `code` derived from it), so it's almost always a typo.

const wrap = (body: string) => `
system S {
  subdomain Sales {
    context Cat {
      aggregate Product {
        ${body}
      }
      repository Products for Product { }
    }
  }
}
`;

async function blankCodes(body: string): Promise<number> {
  const { diagnostics } = await parseString(wrap(body));
  return diagnostics.filter((d) => d.code === "loom.blank-message").length;
}

describe("loom.blank-message", () => {
  it("flags an empty message on a property check", async () => {
    expect(await blankCodes(`sku: string check sku.length > 0 message ""`)).toBe(1);
  });

  it("flags a whitespace-only message on an invariant", async () => {
    expect(await blankCodes(`name: string\n        invariant name.length >= 2 message "   "`)).toBe(
      1,
    );
  });

  it("flags an empty message on a precondition", async () => {
    expect(
      await blankCodes(
        `name: string\n        operation touch() { precondition name.length > 0 message "" }`,
      ),
    ).toBe(1);
  });

  it("stays silent on a non-blank message", async () => {
    expect(
      await blankCodes(`name: string\n        invariant name.length >= 2 message "Name too short"`),
    ).toBe(0);
  });

  it("stays silent on a message-less rule", async () => {
    expect(await blankCodes(`name: string\n        invariant name.length >= 2`)).toBe(0);
  });
});
