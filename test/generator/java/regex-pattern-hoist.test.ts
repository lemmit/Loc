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
          check email.matches("^[^@]+@[^@]+\\\\.[^@]+$") message "Invalid email address"
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

  it("hoists a wire-validator regex to a static final Pattern in the Spring Validator", async () => {
    // A regex check in the command's Spring Validator hoists to a reused
    // `private static final Pattern` (the `email.matches(...)` check lands here).
    const src = await fileEndingWith("/CreateEngineerValidator.java");
    expect(src).toMatch(/private static final Pattern MATCHES_PATTERN_0 = Pattern\.compile\(/);
    expect(src).toContain("MATCHES_PATTERN_0.matcher(email).find()");
    expect(src).not.toMatch(/Pattern\.compile\([^)]*\)\.matcher/);
  });

  it("hoists a message-less single-field regex too (rejectValue with the sentinel code)", async () => {
    const src = `
system Reg {
  subdomain S {
    context C {
      aggregate Account with crudish {
        slug: string
          check slug.matches("^[a-z0-9-]+$")
      }
      repository Accounts for Account { }
    }
  }
  api RegApi from S
  storage primary { type: postgres }
  deployable api { platform: java contexts: [C] serves: RegApi port: 8080 }
}
`;
    const files = await generateSystemFiles(src);
    const v = [...files.entries()].find(([k]) => /CreateAccountValidator\.java$/.test(k))![1];
    expect(v).toMatch(/private static final Pattern MATCHES_PATTERN_0 = Pattern\.compile\(/);
    expect(v).toContain(
      'if (!(MATCHES_PATTERN_0.matcher(slug).find())) errors.rejectValue("slug", "loom.invariant"',
    );
  });
});
