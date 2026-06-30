// Regex patterns used by `string.matches("…")` are hoisted into reusable
// `private static final Pattern` fields instead of being recompiled with a
// fresh `Pattern.compile(...)` on every evaluation.  Covers the three emitters
// that render domain regexes: the aggregate class (entity.ts), the value-object
// record (enums-vos.ts), and the wire validator (validator.ts).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Shop {
  subdomain Accounts {
    context People {
      valueobject Handle {
        value: string
        invariant value.matches("^[a-z][a-z0-9_]*$")
      }
      aggregate Engineer with crudish {
        handle: string
        email: string
          check email.matches("^[^@]+@[^@]+\\\\.[^@]+$")
        private invariant handle.matches("^[a-z][a-z0-9_]*$")
      }
      repository Engineers for Engineer { }
    }
  }
  api PeopleApi from Accounts
  storage primary { type: postgres }
  resource peopleState { for: People, kind: state, use: primary }
  deployable api {
    platform: java
    contexts: [People]
    dataSources: [peopleState]
    serves: PeopleApi
    port: 8081
  }
}
`;

async function fileEndingWith(suffix: string): Promise<string> {
  const files = await generateSystemFiles(SRC);
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  if (!key)
    throw new Error(
      `no generated file ending with ${suffix}; keys=${[...files.keys()].join(", ")}`,
    );
  return files.get(key)!;
}

describe("java — regex Pattern hoisting", () => {
  it("hoists an aggregate invariant regex to a static final Pattern", async () => {
    const src = await fileEndingWith("/Engineer.java");
    expect(src).toMatch(
      /private static final Pattern MATCHES_PATTERN_0 = Pattern\.compile\("\^\[a-z\]\[a-z0-9_\]\*\$"\);/,
    );
    expect(src).toContain("MATCHES_PATTERN_0.matcher(this.handle).find()");
    // No inline recompile in the invariant body.
    expect(src).not.toMatch(/Pattern\.compile\([^)]*\)\.matcher/);
  });

  it("hoists a value-object invariant regex inside the record", async () => {
    const src = await fileEndingWith("/Handle.java");
    expect(src).toMatch(/private static final Pattern MATCHES_PATTERN_0 = Pattern\.compile\(/);
    expect(src).toContain("MATCHES_PATTERN_0.matcher(value).find()");
    expect(src).not.toMatch(/Pattern\.compile\([^)]*\)\.matcher/);
  });

  it("hoists the wire-validator regex (compound check) to a static final Pattern", async () => {
    const src = await fileEndingWith("/EngineerValidators.java");
    expect(src).toMatch(/private static final Pattern MATCHES_PATTERN_0 = Pattern\.compile\(/);
    expect(src).toContain("MATCHES_PATTERN_0.matcher(email).find()");
    expect(src).not.toMatch(/Pattern\.compile\([^)]*\)\.matcher/);
  });
});
